/**
 * Unit tests for the fireAutoCommit helper (S5 — auto-commit-path).
 *
 * fireAutoCommit is exported from MarmotContext.tsx so it can be tested
 * without rendering a React component or manipulating real timers.
 *
 * Coverage:
 *   AC-COMMIT-8a — single pending pubkey → exactly one commit with correct extraProposals shape
 *   AC-COMMIT-8b — getPubkeyLeafNodeIndexes returns [] → commit not called, entry dropped
 *   AC-COMMIT-8c — two simultaneous pubkeys → one commit with two Remove proposals + correct remainingAdmins
 *   AC-COMMIT-7  — commit throws → onCommitted NOT called (queue preserved)
 *   AC-EDGE-3    — burst of N enqueues within window → single commit absorbs all pubkeys
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// MarmotContext.tsx has React imports. We mock the React module so the
// module-scope fireAutoCommit function can be imported in a non-DOM test.
vi.mock('react', () => ({
  createContext: vi.fn(() => ({})),
  useCallback: vi.fn((fn: unknown) => fn),
  useContext: vi.fn(),
  useEffect: vi.fn(),
  useMemo: vi.fn((fn: unknown) => (fn as () => unknown)()),
  useRef: vi.fn((initial: unknown) => ({ current: initial })),
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
}));

// Mock all IDB/storage dependencies that MarmotContext imports at module scope.
vi.mock('@/src/lib/marmot/groupStorage', () => ({
  loadAllGroups: vi.fn().mockResolvedValue([]),
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  loadMemberProfiles: vi.fn().mockResolvedValue([]),
  mergeMemberProfile: vi.fn(),
  clearMemberProfiles: vi.fn(),
  IdbGroupStateBackend: vi.fn(),
  IdbKeyPackageBackend: vi.fn(),
  clearAllGroupData: vi.fn(),
}));

vi.mock('@/src/lib/marmot/welcomeSubscription', () => ({
  subscribeToWelcomes: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileSync', () => ({
  serialiseProfileUpdate: vi.fn(),
  PROFILE_RUMOR_KIND: 8901,
  parseProfilePayload: vi.fn(),
}));

vi.mock('@/src/lib/marmot/leaveSync', () => ({
  LEAVE_INTENT_KIND: 13,
  serialiseLeaveIntent: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileRequestSync', () => ({
  PROFILE_REQUEST_KIND: 8903,
}));

vi.mock('@/src/lib/marmot/profileRequestStorage', () => ({
  recordRequestEmitted: vi.fn(),
  recordRequestAnswered: vi.fn(),
  loadProfileRequestMemo: vi.fn(),
  clearProfileRequestMemos: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileRequestRunner', () => ({
  handleIncomingProfileRequest: vi.fn(),
  notifyProfileObserved: vi.fn(),
  sweepStaleProfiles: vi.fn(),
}));

vi.mock('@/src/lib/unreadStore', () => ({
  incrementUnread: vi.fn(),
  initUnreadCounts: vi.fn(),
  initJoinRequestCounts: vi.fn(),
  clearUnreadGroup: vi.fn(),
  incrementJoinRequest: vi.fn(),
  decrementJoinRequest: vi.fn(),
}));

vi.mock('@/src/lib/marmot/chatPersistence', () => ({
  appendMessage: vi.fn(),
  loadMessages: vi.fn(),
}));

vi.mock('@/src/lib/marmot/registerHandlers', () => ({
  buildDispatcher: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
}));

vi.mock('@/src/lib/reactions/api', () => ({
  applyInboundRumor: vi.fn(),
}));

vi.mock('@/src/lib/marmot/pollPersistence', () => ({
  savePoll: vi.fn(),
  saveVoteIfNewer: vi.fn(),
  getPoll: vi.fn(),
  clearPollData: vi.fn(),
}));

vi.mock('@/src/lib/marmot/mediaPersistence', () => ({
  clearGroupMedia: vi.fn(),
}));

vi.mock('@/src/context/NostrIdentityContext', () => ({
  useNostrIdentity: vi.fn(() => ({ privateKeyHex: null, pubkeyHex: null, hydrated: false })),
}));

vi.mock('@/src/context/ProfileContext', () => ({
  useProfile: vi.fn(() => ({ profile: { nickname: '', avatar: null } })),
}));

vi.mock('@/src/context/BackupContext', () => ({
  useBackup: vi.fn(() => ({ markDirty: vi.fn() })),
}));

vi.mock('applesauce-core/helpers/event', () => ({
  getEventHash: vi.fn(() => 'fakehash'),
}));

// S5 (epic: contact-pairing-code, AC-UI-2) added two new module-scope imports
// to MarmotContext.tsx (useToast, useCopy) for the admission-digest toast.
// Neither is exercised by fireAutoCommit — bare stubs are enough to let the
// module load in this jsdom-free test.
vi.mock('@chakra-ui/react', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('@/src/context/LanguageContext', () => ({
  useCopy: vi.fn(() => ({ contacts: { pairingAdmissionDigest: (n: number) => `${n} people paired with your code` } })),
}));

// Per-store Map-backed idb-keyval (bug: pending-member-removals-not-persisted
// reload scenario below uses the REAL pendingRemovalStorage module).
const { idbStores } = vi.hoisted(() => ({ idbStores: new Map<string, Map<string, unknown>>() }));
vi.mock('idb-keyval', () => {
  const pick = (s?: Map<string, unknown>) => s ?? new Map<string, unknown>();
  return {
    createStore: vi.fn((db: string) => { const m = new Map<string, unknown>(); idbStores.set(db, m); return m; }),
    get: vi.fn(async (k: string, s?: Map<string, unknown>) => pick(s).get(k)),
    set: vi.fn(async (k: string, v: unknown, s?: Map<string, unknown>) => { pick(s).set(k, v); }),
    del: vi.fn(async (k: string, s?: Map<string, unknown>) => { pick(s).delete(k); }),
    delMany: vi.fn(async (ks: string[], s?: Map<string, unknown>) => { ks.forEach((k) => pick(s).delete(k)); }),
    keys: vi.fn(async (s?: Map<string, unknown>) => [...pick(s).keys()]),
    entries: vi.fn(async (s?: Map<string, unknown>) => [...pick(s).entries()]),
    clear: vi.fn(async (s?: Map<string, unknown>) => { pick(s).clear(); }),
  };
});

// Now import the exported fireAutoCommit function.
const { fireAutoCommit } = await import('@/src/context/MarmotContext');

// ─── helpers ────────────────────────────────────────────────────────────────

const PROPOSAL_TYPE_REMOVE = 3;

type MakeDepsOpts = {
  adminPubkeys?: string[];
  leafIndexMap?: Record<string, number[]>;
  commitFn?: ReturnType<typeof vi.fn>;
};

function makeDeps(pubkeys: string[], opts: MakeDepsOpts = {}) {
  const { adminPubkeys = pubkeys, leafIndexMap, commitFn = vi.fn().mockResolvedValue(undefined) } =
    opts;

  const mockState = {};
  const mockGroup = {
    state: mockState,
    groupData: { adminPubkeys },
    commit: commitFn,
  };

  const getPubkeyLeafNodeIndexes = vi.fn((state: unknown, pubkey: string) => {
    if (leafIndexMap) return leafIndexMap[pubkey] ?? [0];
    return [0];
  });

  const proposeUpdateMetadata = vi.fn((args: { adminPubkeys: string[] }) => ({
    type: 'updateMetadata',
    ...args,
  }));

  const onCommitted = vi.fn();

  const pendingQueue = pubkeys.map((pubkey, i) => ({
    groupId: 'g1',
    pubkey,
    receivedAt: Date.now() - i * 100,
  }));

  return {
    mlsGroup: mockGroup,
    getPubkeyLeafNodeIndexes,
    proposeUpdateMetadata,
    pendingQueue,
    onCommitted,
    // expose for assertions
    commitFn,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('fireAutoCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // AC-COMMIT-8a: single pending pubkey → exactly one commit with correct extraProposals shape
  it('(a) single pubkey → one commit call with Remove proposal + proposeUpdateMetadata', async () => {
    const PUBKEY = 'aaaa1111';
    const SELF = 'bbbb2222';
    const deps = makeDeps([PUBKEY], { adminPubkeys: [PUBKEY, SELF] });

    await fireAutoCommit(deps);

    // Exactly one commit call (AC-COMMIT-4 / AC-COMMIT-1).
    expect(deps.commitFn).toHaveBeenCalledTimes(1);

    const callArg = deps.commitFn.mock.calls[0][0] as { extraProposals: unknown[] };
    const { extraProposals } = callArg;

    // Must contain a Remove proposal with proposalType === 3 (AC-COMMIT-3).
    const removeProposal = extraProposals.find(
      (p: any) => p.proposalType === PROPOSAL_TYPE_REMOVE && p.remove?.removed === 0,
    );
    expect(removeProposal).toBeDefined();

    // Must contain an updateMetadata proposal (AC-COMMIT-4).
    expect(deps.proposeUpdateMetadata).toHaveBeenCalledTimes(1);
    const metadataArg = deps.proposeUpdateMetadata.mock.calls[0][0] as {
      adminPubkeys: string[];
    };
    // remainingAdmins should exclude the departing pubkey (AC-COMMIT-5).
    expect(metadataArg.adminPubkeys).not.toContain(PUBKEY);
    expect(metadataArg.adminPubkeys).toContain(SELF);

    // onCommitted called with the committed pubkey (AC-COMMIT-6).
    expect(deps.onCommitted).toHaveBeenCalledWith([PUBKEY], [{ pubkey: PUBKEY }]);
  });

  // AC-COMMIT-8b: getPubkeyLeafNodeIndexes returns [] → commit not called, entry dropped
  it('(b) empty leafIndexes → commit not called; onCommitted called to drop the stale entry', async () => {
    const PUBKEY = 'stale1111';
    const deps = makeDeps([PUBKEY], {
      leafIndexMap: { [PUBKEY]: [] },
    });

    await fireAutoCommit(deps);

    // No commit when every entry is stale (AC-COMMIT-2 / AC-EDGE-1 / AC-EDGE-2).
    expect(deps.commitFn).not.toHaveBeenCalled();

    // The stale entry must be dropped from the live queue (AC-COMMIT-2).
    expect(deps.onCommitted).toHaveBeenCalledWith([PUBKEY], [{ pubkey: PUBKEY }]);
  });

  // AC-COMMIT-8c: two simultaneous pubkeys → one commit with two Remove proposals + correct remainingAdmins
  it('(c) two pubkeys → exactly one commit with two Remove proposals and correct remainingAdmins', async () => {
    const PUBKEY_A = 'aaaa1111';
    const PUBKEY_B = 'bbbb2222';
    const SELF = 'cccc3333';
    // leafIndexMap: each pubkey maps to a distinct leaf index
    const deps = makeDeps([PUBKEY_A, PUBKEY_B], {
      adminPubkeys: [PUBKEY_A, PUBKEY_B, SELF],
      leafIndexMap: { [PUBKEY_A]: [1], [PUBKEY_B]: [3] },
    });

    await fireAutoCommit(deps);

    // Exactly one commit (AC-COMMIT-4).
    expect(deps.commitFn).toHaveBeenCalledTimes(1);

    const callArg = deps.commitFn.mock.calls[0][0] as { extraProposals: unknown[] };
    const { extraProposals } = callArg;

    // Two Remove proposals (AC-COMMIT-3).
    const removeProposals = extraProposals.filter(
      (p: any) => p.proposalType === PROPOSAL_TYPE_REMOVE,
    );
    expect(removeProposals).toHaveLength(2);
    expect(removeProposals.some((p: any) => p.remove?.removed === 1)).toBe(true);
    expect(removeProposals.some((p: any) => p.remove?.removed === 3)).toBe(true);

    // remainingAdmins excludes both departing pubkeys (AC-COMMIT-5).
    const metadataArg = deps.proposeUpdateMetadata.mock.calls[0][0] as {
      adminPubkeys: string[];
    };
    expect(metadataArg.adminPubkeys).toEqual([SELF]);

    // onCommitted called with both pubkeys (AC-COMMIT-6).
    const committed: string[] = deps.onCommitted.mock.calls[0][0];
    expect(committed).toContain(PUBKEY_A);
    expect(committed).toContain(PUBKEY_B);
  });

  // AC-COMMIT-7 / AC-EDGE-4 / AC-EDGE-8: commit throws → onCommitted NOT called (queue preserved)
  it('commit failure → onCommitted not called; entries preserved for next timer cycle', async () => {
    const PUBKEY = 'aaaa1111';
    const commitFn = vi.fn().mockRejectedValue(new Error('epoch conflict'));
    const deps = makeDeps([PUBKEY], { commitFn });

    await fireAutoCommit(deps);

    expect(deps.commitFn).toHaveBeenCalledTimes(1);
    // onCommitted must NOT be called at all — entries stay in the live queue (AC-COMMIT-7).
    // There are no stale-leaf drops in this scenario (getPubkeyLeafNodeIndexes returns a
    // non-empty index), so the drop-phase onCommitted at the top of fireAutoCommit never
    // fires either. The only way onCommitted could be invoked here is the success path
    // falling through after a commit failure — which is exactly the bug AC-COMMIT-7 forbids.
    expect(deps.onCommitted).not.toHaveBeenCalled();
    // Defence in depth: even across nested call shapes, the committing pubkey must never
    // reach onCommitted. flatMap(2) drains both the call-args level and the string[] arg
    // level so the membership check sees bare pubkeys, not nested arrays.
    const committedPubkeys: string[] = deps.onCommitted.mock.calls.flat(2);
    expect(committedPubkeys).not.toContain(PUBKEY);
  });

  // AC-EDGE-3: burst of N pubkeys within debounce window → single commit with N Remove proposals
  it('burst of N pubkeys (AC-EDGE-3) → single commit absorbs all; pendingQueue is the full snapshot', async () => {
    const PUBKEYS = ['pk1', 'pk2', 'pk3', 'pk4', 'pk5'];
    const SELF = 'self0000';
    const leafIndexMap = Object.fromEntries(PUBKEYS.map((pk, i) => [pk, [i]]));
    const deps = makeDeps(PUBKEYS, {
      adminPubkeys: [...PUBKEYS, SELF],
      leafIndexMap,
    });

    await fireAutoCommit(deps);

    // Exactly one commit (AC-COMMIT-4 / AC-EDGE-3).
    expect(deps.commitFn).toHaveBeenCalledTimes(1);

    const { extraProposals } = deps.commitFn.mock.calls[0][0] as { extraProposals: unknown[] };
    const removeProposals = extraProposals.filter(
      (p: any) => p.proposalType === PROPOSAL_TYPE_REMOVE,
    );
    expect(removeProposals).toHaveLength(PUBKEYS.length);

    // remainingAdmins should be just [SELF].
    const metadataArg = deps.proposeUpdateMetadata.mock.calls[0][0] as {
      adminPubkeys: string[];
    };
    expect(metadataArg.adminPubkeys).toEqual([SELF]);

    // All pubkeys committed.
    const committed: string[] = deps.onCommitted.mock.calls[0][0];
    expect(committed.sort()).toEqual([...PUBKEYS].sort());
  });

  // Additional: mixed stale + valid pubkeys → only valid ones committed; stale ones dropped
  it('mixed stale + valid → commit contains only valid Remove proposals; stale entries dropped', async () => {
    const VALID = 'valid111';
    const STALE = 'stale222';
    const SELF = 'self0000';
    const deps = makeDeps([VALID, STALE], {
      adminPubkeys: [VALID, STALE, SELF],
      leafIndexMap: { [VALID]: [2], [STALE]: [] },
    });

    await fireAutoCommit(deps);

    expect(deps.commitFn).toHaveBeenCalledTimes(1);

    const { extraProposals } = deps.commitFn.mock.calls[0][0] as { extraProposals: unknown[] };
    const removeProposals = extraProposals.filter(
      (p: any) => p.proposalType === PROPOSAL_TYPE_REMOVE,
    );
    // Only the valid pubkey gets a Remove proposal.
    expect(removeProposals).toHaveLength(1);
    expect((removeProposals[0] as any).remove?.removed).toBe(2);

    // remainingAdmins excludes only the valid (departing) pubkey; STALE was already gone
    // from the ratchet tree, so it may or may not be in adminPubkeys — the spec says
    // we only filter out the VALID entries we're actually committing (AC-COMMIT-5).
    const metadataArg = deps.proposeUpdateMetadata.mock.calls[0][0] as {
      adminPubkeys: string[];
    };
    expect(metadataArg.adminPubkeys).not.toContain(VALID);
    expect(metadataArg.adminPubkeys).toContain(SELF);

    // onCommitted called twice: once for the stale drop, once for the committed pubkey.
    expect(deps.onCommitted).toHaveBeenCalledTimes(2);
    // First call: stale drop.
    expect(deps.onCommitted.mock.calls[0][0]).toContain(STALE);
    // Second call: committed.
    expect(deps.onCommitted.mock.calls[1][0]).toContain(VALID);
  });
});

// ─── bug: pending-member-removals-not-persisted ─────────────────────────────
// A leave_intent enqueues a removal; the page unloads inside the 5 s debounce
// (the timer never fires). The next session must still remove the member —
// but only the leaf that announced the departure (remediation round 1: a
// stored removal is fail-safe toward NOT evicting a member who re-joined).
// Uses the real pendingRemovalStorage glue MarmotContext wires: enqueueLeave =
// recordPendingRemoval (+ captured leaf identity) + timer, onCommitted =
// settlePendingRemovals, subscription start = resumePendingRemovals.
describe('pending removal survives a reload inside the debounce (bug: pending-member-removals-not-persisted)', () => {
  const DEPARTED = 'dd'.repeat(32);
  const SELF = 'ee'.repeat(32);
  const DAY = 24 * 60 * 60 * 1000;
  const leaf = (sig: number, hpke: number) => ({ signaturePublicKey: new Uint8Array([sig]), hpkePublicKey: new Uint8Array([hpke]) });
  const ORIGINAL = [leaf(1, 2)];
  const REJOINED = [leaf(7, 8)];

  async function nextSession(isAdmin: boolean | undefined = true) {
    const storage = await import('@/src/lib/marmot/pendingRemovalStorage');
    const queue = new Map<string, import('@/src/lib/marmot/pendingRemovalStorage').PendingRemovalRecord[]>();
    const arm = vi.fn();
    await storage.resumePendingRemovals({ groupId: 'g1', isAdmin, now: Date.now(), maxAgeMs: 30 * DAY, queue, arm });
    return { storage, queue, arm };
  }

  async function fire(queue: Map<string, any[]>, currentLeaves: Array<ReturnType<typeof leaf>>, commit = vi.fn().mockResolvedValue(undefined)) {
    const storage = await import('@/src/lib/marmot/pendingRemovalStorage');
    const settled: Promise<void>[] = [];
    await fireAutoCommit({
      mlsGroup: { state: {}, groupData: { adminPubkeys: [SELF, DEPARTED] }, commit },
      getPubkeyLeafNodeIndexes: (_s: unknown, pk: string) => (pk === DEPARTED && currentLeaves.length ? [3] : []),
      getPubkeyLeafNodes: (_s: unknown, pk: string) => (pk === DEPARTED ? currentLeaves : []),
      proposeUpdateMetadata: (a: { adminPubkeys: string[] }) => ({ type: 'meta', ...a }),
      pendingQueue: queue.get('g1') ?? [],
      onCommitted: (_pks, recs) => { settled.push(storage.settlePendingRemovals(queue, 'g1', recs)); },
    });
    await Promise.all(settled);
    return commit;
  }

  async function session1() {
    const storage = await import('@/src/lib/marmot/pendingRemovalStorage');
    // Handler ran with the departing member's leaf captured; unload before the timer fires.
    await storage.recordPendingRemoval(new Map(), 'g1', DEPARTED, Date.now(), storage.leafIdentityOf(ORIGINAL));
    return storage;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    idbStores.get('few-pending-removals')?.clear();
  });

  it('a reload within the debounce still commits the departed member\'s removal (same leaf), then forgets it', async () => {
    await session1();
    const { queue, arm } = await nextSession();
    expect(queue.get('g1')?.map((e) => e.pubkey)).toEqual([DEPARTED]);
    expect(arm).toHaveBeenCalledWith('g1');
    const commit = await fire(queue, ORIGINAL);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].extraProposals[0]).toEqual({ proposalType: PROPOSAL_TYPE_REMOVE, remove: { removed: 3 } });
    expect(commit.mock.calls[0][0].extraProposals[1]).toEqual({ type: 'meta', adminPubkeys: [SELF] });
    const third = await nextSession();
    expect(third.queue.size).toBe(0);
  });

  it('identity mismatch: the member re-joined with a new leaf — the stored removal is settled (forgotten), never proposed', async () => {
    await session1();
    const { queue, storage } = await nextSession();
    const commit = await fire(queue, REJOINED);
    expect(commit).not.toHaveBeenCalled();
    expect(queue.has('g1')).toBe(false);
    expect(await storage.listPendingRemovals('g1')).toEqual([]);
  });

  it('non-admin device: the stored removal is forgotten at resume, nothing is armed or committed', async () => {
    await session1();
    const { queue, arm, storage } = await nextSession(false);
    expect(queue.size).toBe(0);
    expect(arm).not.toHaveBeenCalled();
    expect(await storage.listPendingRemovals('g1')).toEqual([]);
  });

  it('a failed commit keeps the durable entry for the next session (AC-COMMIT-7); a member already gone is dropped and forgotten', async () => {
    await session1();
    const s2 = await nextSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fire(s2.queue, ORIGINAL, vi.fn().mockRejectedValue(new Error('epoch conflict')));
    warn.mockRestore();
    expect((await s2.storage.listPendingRemovals('g1')).map((r) => r.pubkey)).toEqual([DEPARTED]);
    expect(s2.queue.get('g1')?.map((e) => e.pubkey)).toEqual([DEPARTED]);

    const s3 = await nextSession();
    const commit = await fire(s3.queue, []);
    expect(commit).not.toHaveBeenCalled();
    expect(await s3.storage.listPendingRemovals('g1')).toEqual([]);
  });
  it('(a) a re-joined member\'s new leave (new identity) arriving during the stale removal\'s commit window survives the stale settle and is removed next', async () => {
    const storage = await session1();
    const { queue } = await nextSession();
    const NEW_ID = storage.leafIdentityOf(REJOINED)!;
    // The stale entry A (ORIGINAL) is checked and committed; while the commit
    // is in flight the member (re-joined as REJOINED) leaves again.
    const commit = vi.fn(async () => {
      await storage.recordPendingRemoval(queue, 'g1', DEPARTED, Date.now(), NEW_ID);
    });
    await fire(queue, ORIGINAL, commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queue.get('g1')).toEqual([expect.objectContaining({ pubkey: DEPARTED, leafIdentity: NEW_ID })]);
    expect(await storage.listPendingRemovals('g1')).toEqual([expect.objectContaining({ pubkey: DEPARTED, leafIdentity: NEW_ID })]);

    // Next fire: the re-joined leaf is the current one → B is proposed for Remove, then forgotten.
    const commit2 = await fire(queue, REJOINED);
    expect(commit2).toHaveBeenCalledTimes(1);
    expect(commit2.mock.calls[0][0].extraProposals[0]).toEqual({ proposalType: PROPOSAL_TYPE_REMOVE, remove: { removed: 3 } });
    expect(queue.has('g1')).toBe(false);
    expect(await storage.listPendingRemovals('g1')).toEqual([]);
  });

  it('(a) an identity-mismatch drop of stale A never settles a replacement B enqueued before the fire settled', async () => {
    const storage = await session1();
    const { queue } = await nextSession();
    const NEW_ID = storage.leafIdentityOf(REJOINED)!;
    const pendingQueue = [...(queue.get('g1') ?? [])]; // fire-time snapshot: A only
    await storage.recordPendingRemoval(queue, 'g1', DEPARTED, Date.now(), NEW_ID);
    const settled: Promise<void>[] = [];
    const commit = vi.fn();
    await fireAutoCommit({
      mlsGroup: { state: {}, groupData: { adminPubkeys: [SELF] }, commit },
      getPubkeyLeafNodeIndexes: () => [3],
      getPubkeyLeafNodes: () => REJOINED,
      proposeUpdateMetadata: (a: { adminPubkeys: string[] }) => a,
      pendingQueue,
      onCommitted: (_pks, recs) => { settled.push(storage.settlePendingRemovals(queue, 'g1', recs)); },
    });
    await Promise.all(settled);
    expect(commit).not.toHaveBeenCalled();
    expect(queue.get('g1')).toEqual([expect.objectContaining({ leafIdentity: NEW_ID })]);
    expect(await storage.listPendingRemovals('g1')).toEqual([expect.objectContaining({ leafIdentity: NEW_ID })]);
  });
});

describe('fireAutoCommit — leaf identity guard (remediation round 1)', () => {
  const P = 'aa'.repeat(32);
  const Q = 'bb'.repeat(32);
  const leaf = (sig: number) => ({ signaturePublicKey: new Uint8Array([sig]), hpkePublicKey: new Uint8Array([sig]) });

  it('commits only entries whose captured identity matches the current leaf; mismatches are settled; identity-less in-session entries keep pubkey-only behaviour', async () => {
    const { leafIdentityOf } = await import('@/src/lib/marmot/pendingRemovalStorage');
    const R = 'cc'.repeat(32);
    const commit = vi.fn().mockResolvedValue(undefined);
    const onCommitted = vi.fn();
    await fireAutoCommit({
      mlsGroup: { state: {}, groupData: { adminPubkeys: [] }, commit },
      getPubkeyLeafNodeIndexes: (_s: unknown, pk: string) => ({ [P]: [1], [Q]: [2], [R]: [4] } as Record<string, number[]>)[pk] ?? [],
      getPubkeyLeafNodes: (_s: unknown, pk: string) => ({ [P]: [leaf(1)], [Q]: [leaf(9)], [R]: [leaf(4)] } as Record<string, ReturnType<typeof leaf>[]>)[pk] ?? [],
      proposeUpdateMetadata: (a: { adminPubkeys: string[] }) => a,
      pendingQueue: [
        { groupId: 'g1', pubkey: P, receivedAt: 1, leafIdentity: leafIdentityOf([leaf(1)]) },
        { groupId: 'g1', pubkey: Q, receivedAt: 2, leafIdentity: leafIdentityOf([leaf(2)]) },
        { groupId: 'g1', pubkey: R, receivedAt: 3 },
      ],
      onCommitted,
    });
    expect(onCommitted.mock.calls[0][0]).toEqual([Q]);
    expect(onCommitted.mock.calls[0][1]).toEqual([{ pubkey: Q, leafIdentity: leafIdentityOf([leaf(2)]) }]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].extraProposals.slice(0, 2)).toEqual([
      { proposalType: PROPOSAL_TYPE_REMOVE, remove: { removed: 1 } },
      { proposalType: PROPOSAL_TYPE_REMOVE, remove: { removed: 4 } },
    ]);
    expect(onCommitted.mock.calls[1][0]).toEqual([P, R]);
    expect(onCommitted.mock.calls[1][1]).toEqual([{ pubkey: P, leafIdentity: leafIdentityOf([leaf(1)]) }, { pubkey: R }]);
  });

  it('an entry with a captured identity but no leaf reader is settled, never proposed (fail-safe)', async () => {
    const commit = vi.fn();
    const onCommitted = vi.fn();
    await fireAutoCommit({
      mlsGroup: { state: {}, groupData: { adminPubkeys: [] }, commit },
      getPubkeyLeafNodeIndexes: () => [1],
      proposeUpdateMetadata: (a: { adminPubkeys: string[] }) => a,
      pendingQueue: [{ groupId: 'g1', pubkey: P, receivedAt: 1, leafIdentity: 'x' }],
      onCommitted,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledWith([P], [{ pubkey: P, leafIdentity: 'x' }]);
  });
});
