/**
 * S9 (epic-group-invite-lifecycle, integration story) — AC-CROSS-1.
 *
 * Whole-flow ORDER-SENSITIVITY property over the REAL, already-shipped
 * decline-receive code: decline-a (S6, `welcomeSubscription.ts`'s
 * `subscribeToWelcomes` INVITE_DECLINE_KIND branch + its private
 * `applyDecline`/`runSerializedDeclineProcessing` machinery) and decline-b's
 * Remove-reuse seam (S5, `cancelInvitationImpl.ts`, consumed transitively).
 *
 * This file adds NO new production code and re-implements NONE of the
 * decline logic — every verdict below comes from driving the real exported
 * `subscribeToWelcomes`/`subscribeToGroupMessages` dispatch with hand-built
 * genuine NIP-59 gift wraps, exactly like
 * `welcomeSubscription.test.ts`'s own "decline receive (S6)" suite. That
 * suite already proves each dimension below WORKS IN ISOLATION
 * (redelivery-after-completion, commit-throws, deferred-sync, concurrent
 * double-click, empty/unknown groupId, terminal-noop mark-seen, re-invite
 * reactivation). This file's job — the actual gap an integration story
 * exists to close — is the CROSS-PRODUCT: combining redelivery x crash
 * timing x sync timing x group-held state in the same run, and asserting
 * the AC-CROSS-1 convergence bound holds across the combination, not just
 * each axis alone.
 *
 * AC-CROSS-1 (acceptance-criteria.md): for any interleaving drawn from
 * {zero or more duplicate redeliveries of a single decline gift wrap} x
 * {zero or more crash/restart events, before or after the Remove commit} x
 * {the referenced group's historical-sync completing before/during/after
 * delivery}, the system MUST converge to AT MOST ONE `declined` post and AT
 * MOST ONE MLS Remove per invitee/group, and to EXACTLY ONE of each whenever
 * some delivery found the invitee still pending at some evaluation time.
 *
 * ── Crash/restart simulation technique (read before extending this file) ──
 *
 * `welcomeSubscription.ts` keeps three pieces of SESSION-LIFETIME,
 * module-level state a real app restart resets to empty:
 * `historySyncedGroupIds`/`historySyncWaiters` (the per-group sync gate) and
 * `declineProcessingChains` (the per-(groupId,pubkey) serialization chain).
 * A literal OS-level process kill cannot be injected mid-microtask-chain
 * from inside the same Node process, so "crash timing relative to the
 * Remove commit" is modeled at the two points that are ACTUALLY observable
 * and load-bearing:
 *
 *   - BEFORE the commit lands: the MLS `commit()` call itself throws
 *     (`retryable-failure` — the load-bearing path DD-7 names). The wrap is
 *     left unmarked, so a subsequent delivery (same-eventId or a fresh one)
 *     reprocesses and can still succeed.
 *   - AFTER the commit lands: by inspection of `applyDecline`
 *     (welcomeSubscription.ts, the `cancelPendingInvitationImpl` call and
 *     everything after it), every step following a successful commit —
 *     the best-effort `sendAnnouncement` post and the `clearPendingDirectInvite`
 *     marker-clear — is wrapped in its own try/catch and never rethrows, so
 *     'applied' and the subsequent mark-seen call are ALWAYS reached once
 *     commit resolves without throwing. There is no synchronous gap in this
 *     implementation where a Remove can land durably yet leave the
 *     dispatch handler suspended indefinitely. The faithful, deterministic
 *     way to test "the system survives a crash/restart occurring at this
 *     point" is therefore: redeliver (same-eventId or a fresh eventId)
 *     AFTER the first delivery's Remove has landed, and confirm the
 *     tree-membership gate (DD-4) — which is exactly what would greet a
 *     restarted app reprocessing an unmarked-but-already-applied wrap —
 *     converges to a clean terminal no-op, never a second Remove or post.
 *     This is the "no lost decline across crash" guarantee
 *     (architecture.md's decline-a/decline-b whole-flow guarantee #3),
 *     tested at its observable boundary rather than via an unrealistic
 *     `vi.resetModules()` mid-flight process-kill fiction.
 *
 * No `setTimeout` anywhere: every interleaving point below is a manually
 * resolved `Deferred` (mirrors `welcomeSubscription.test.ts`'s own
 * `createDeferred`/`commitGate`/`commitEntered` discipline) or an explicit
 * microtask-flush (`await Promise.resolve()` x N).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// ── Module mocks (mirrors welcomeSubscription.test.ts's top-of-file setup;
//    this file exercises the SAME production module, so it needs the SAME
//    mocks for the parts of that module it doesn't otherwise touch) ────────

const mockFetchEventsWithTimeout = vi.fn();

const mockEnqueuePendingInvitation = vi.fn();
const mockCountPendingInvitations = vi.fn().mockReturnValue(1);
const mockRemovePendingInvitation = vi.fn();
const mockListPendingInvitations = vi.fn().mockReturnValue([]);

vi.mock('@/src/lib/pendingInvitations', () => ({
  enqueuePendingInvitation: (...args: unknown[]) => mockEnqueuePendingInvitation(...args),
  countPendingInvitations: () => mockCountPendingInvitations(),
  removePendingInvitation: (...args: unknown[]) => mockRemovePendingInvitation(...args),
  listPendingInvitations: () => mockListPendingInvitations(),
}));

vi.mock('@/src/lib/ndkClient', () => ({
  fetchEventsWithTimeout: (...args: unknown[]) => mockFetchEventsWithTimeout(...args),
}));

vi.mock('@nostr-dev-kit/ndk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nostr-dev-kit/ndk')>();
  return {
    ...actual,
    NDKRelaySet: {
      fromRelayUrls: (_relays: string[], _ndk: unknown) => 'mock-relay-set',
    },
  };
});

const { mockIngestEvent } = vi.hoisted(() => ({ mockIngestEvent: vi.fn(async (_event: unknown) => {}) }));
vi.mock('@/src/lib/marmot/epochResolver', () => ({
  EpochResolver: class {
    constructor(_group: unknown, _opts: unknown) {}
    ingestEvent(event: unknown) { return mockIngestEvent(event); }
    dispose() {}
  },
}));

import {
  subscribeToGroupMessages,
  subscribeToWelcomes,
  INVITE_DECLINE_KIND,
  type DeclineReceiveDeps,
} from '@/src/lib/marmot/welcomeSubscription';
import { STORAGE_KEYS } from '@/src/types';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';

// ── Fixture builders (local copies — not shared with welcomeSubscription.test.ts) ──

function makeKeypair() {
  const priv = generateSecretKey();
  const privHex = bytesToHex(priv);
  const pubHex = getPublicKey(priv);
  return { priv, privHex, pubHex };
}

function buildGenuineWrap(params: {
  sender: { priv: Uint8Array; pubHex: string };
  recipientPubHex: string;
  kind: number;
  content: string;
  tags?: string[][];
}) {
  const rumor = createRumor(
    { kind: params.kind, content: params.content, tags: params.tags ?? [] },
    params.sender.priv,
  );
  const seal = createSeal(rumor, params.sender.priv, params.recipientPubHex);
  const wrap = createWrap(seal, params.recipientPubHex);
  return { wrap, seal, rumor };
}

function makeNdkWithEventCapture() {
  let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
  const mockSubInstance = {
    on: vi.fn((eventName: string, handler: (event: unknown) => Promise<void>) => {
      if (eventName === 'event') capturedHandler = handler;
    }),
    stop: vi.fn(),
  };
  const mockNdk = { subscribe: vi.fn(() => mockSubInstance) };
  const fireEvent = (ndkEvent: unknown): Promise<void> => {
    if (!capturedHandler) throw new Error('Event handler not yet installed');
    return capturedHandler(ndkEvent);
  };
  return { mockNdk, fireEvent };
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function markGroupSyncedForTest(groupId: string): Promise<void> {
  mockFetchEventsWithTimeout.mockReset();
  mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(), timedOut: false });
  const ndk = { subscribe: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })) };
  const unsub = await subscribeToGroupMessages(
    groupId,
    ['wss://r'],
    { groupData: { nostrGroupId: new Uint8Array(32).fill(0x01) } } as never,
    ndk as never,
  );
  unsub();
}

async function buildDeclineWrap(params: {
  invitee: { priv: Uint8Array; pubHex: string };
  inviterPubHex: string;
  groupId: string;
}) {
  await markGroupSyncedForTest(params.groupId);
  return buildGenuineWrap({
    sender: params.invitee,
    recipientPubHex: params.inviterPubHex,
    kind: INVITE_DECLINE_KIND,
    content: JSON.stringify({ groupId: params.groupId, pubkey: params.invitee.pubHex }),
  });
}

/**
 * Stateful DeclineReceiveDeps fixture. `members` is a real mutable array
 * mutated by `commit()`, so serialization/convergence bugs are genuinely
 * observable. `commitBehavior` generalizes welcomeSubscription.test.ts's
 * simple `commitShouldThrow` boolean into a per-call script (needed for the
 * "throws once then succeeds on retry" crash-then-recover scenarios below):
 * an array of `'throw' | 'succeed'` consumed one entry per `commit()` call,
 * repeating the last entry once exhausted.
 */
function makeDeclineTestDeps(params: {
  initialMembers: string[];
  profiledPubkeys?: string[];
  selfPubkeyHex: string;
  commitBehavior?: Array<'throw' | 'succeed'>;
  commitGate?: Promise<void>;
}) {
  let members = [...params.initialMembers];
  const callOrder: string[] = [];
  let lastQueriedPubkey: string | null = null;
  let commitCallIndex = 0;
  let successfulCommitCount = 0;

  const commitEnteredDeferred = createDeferred<void>();

  const getGroupMembers = vi.fn(() => members);
  const loadMemberProfiles = vi.fn(async () =>
    (params.profiledPubkeys ?? []).map((pubkeyHex) => ({
      pubkeyHex,
      groupId: 'g',
      nickname: 'x',
      updatedAt: 0,
    })),
  );
  const getPubkeyLeafNodeIndexes = vi.fn((_state: unknown, pubkey: string) => {
    lastQueriedPubkey = pubkey;
    return members.some((m) => m.toLowerCase() === pubkey.toLowerCase()) ? [0] : [];
  });
  const mockCommit = vi.fn(async (_opts: { extraProposals: Array<{ proposalType: number; remove?: { removed: number } }> }) => {
    callOrder.push('commit');
    commitEnteredDeferred.resolve();
    if (params.commitGate) {
      await params.commitGate;
    }
    const script = params.commitBehavior ?? ['succeed'];
    const behavior = script[Math.min(commitCallIndex, script.length - 1)];
    commitCallIndex += 1;
    if (behavior === 'throw') {
      throw new Error('commit failed');
    }
    successfulCommitCount += 1;
    if (lastQueriedPubkey) {
      const removed = lastQueriedPubkey;
      members = members.filter((m) => m.toLowerCase() !== removed.toLowerCase());
    }
  });
  const mockGroup = {
    state: {},
    groupData: { adminPubkeys: [params.selfPubkeyHex] },
    commit: mockCommit,
  };
  const getGroup = vi.fn(async () => mockGroup);
  const persistGroup = vi.fn().mockResolvedValue(undefined);
  const reloadGroups = vi.fn().mockResolvedValue(undefined);
  const markBackupDirty = vi.fn();
  const sendAnnouncement = vi.fn(async (_groupId: string, _content: string) => {
    callOrder.push('post');
  });
  const clearPendingDirectInvite = vi.fn(async (_groupId: string, _pubkey: string) => {
    callOrder.push('marker-clear');
  });

  const deps: DeclineReceiveDeps = {
    getGroup,
    loadMemberProfiles,
    getGroupMembers,
    getPubkeyLeafNodeIndexes,
    Proposals: { proposeUpdateMetadata: vi.fn((opts: object) => ({ type: 'meta', ...opts })) },
    persistGroup,
    getStoredGroup: () => ({ id: 'g', name: 'G', createdAt: 0, relays: [], memberPubkeys: members }),
    reloadGroups,
    markBackupDirty,
    selfPubkeyHex: params.selfPubkeyHex,
    sendAnnouncement,
    clearPendingDirectInvite,
  };

  return {
    deps,
    mockCommit,
    sendAnnouncement,
    clearPendingDirectInvite,
    getGroup,
    callOrder,
    getMembers: () => members,
    commitEntered: commitEnteredDeferred.promise,
    successfulCommitCount: () => successfulCommitCount,
    commitAttempts: () => mockCommit.mock.calls.length,
  };
}

let localStorageStore: Record<string, string> = {};

beforeEach(() => {
  localStorageStore = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localStorageStore[key] ?? null,
    setItem: (key: string, value: string) => { localStorageStore[key] = value; },
    removeItem: (key: string) => { delete localStorageStore[key]; },
  });
  mockEnqueuePendingInvitation.mockReset();
  mockCountPendingInvitations.mockReset().mockReturnValue(1);
});

const STORAGE_SEEN_KEY = STORAGE_KEYS.processedGiftWraps;

function seenIds(): string[] {
  try {
    return JSON.parse(localStorageStore[STORAGE_SEEN_KEY] ?? '[]');
  } catch {
    return [];
  }
}

async function startSubscription(admin: { pubHex: string; privHex: string }, deps: DeclineReceiveDeps) {
  const { mockNdk, fireEvent } = makeNdkWithEventCapture();
  const unsub = await subscribeToWelcomes(
    admin.pubHex,
    { joinGroupFromWelcome: vi.fn() } as never,
    mockNdk as never,
    createPrivateKeySigner(admin.privHex),
    vi.fn(),
    undefined,
    undefined,
    undefined,
    undefined,
    deps,
  );
  return { fireEvent, unsub };
}

// ─────────────────────────────────────────────────────────────────────────
// AC-CROSS-1 — enumerated combinations of {duplicate redelivery} x
// {crash/restart timing} x {sync timing} x {group-held state}
// ─────────────────────────────────────────────────────────────────────────

describe('AC-CROSS-1 — decline whole-flow convergence across redelivery x crash-timing x sync-timing x group-held combinations', () => {
  it('[baseline] single delivery, already synced, pending -> exactly one Remove, at most one post, marked seen', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-baseline';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, mockCommit, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    await fireEvent({ id: 'cc-baseline-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });

    expect(successfulCommitCount()).toBe(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1); // best-effort, but succeeds here
    expect(seenIds()).toContain('cc-baseline-1');
    unsub();
  });

  it('[redelivery x no-crash] the SAME eventId redelivered after full completion is a pure no-op — still exactly one Remove total', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-redelivery-clean';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-redelivery-clean-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content };
    await fireEvent(ndkEvent);
    await fireEvent(ndkEvent);
    await fireEvent(ndkEvent); // triple redelivery — still converges

    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('[crash-before-commit x redelivery] commit throws on first attempt (retryable), unmarked, SAME eventId redelivered succeeds -> exactly one successful Remove, at most one post', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-crash-before-commit';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, successfulCommitCount, commitAttempts } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
      commitBehavior: ['throw', 'succeed'],
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-crash-before-commit-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content };
    await fireEvent(ndkEvent); // crash: commit throws, retryable-failure, unmarked
    expect(seenIds()).not.toContain('cc-crash-before-commit-1');
    expect(deps.sendAnnouncement).not.toHaveBeenCalled();

    await fireEvent(ndkEvent); // redelivery (simulates reprocessing after restart): commit succeeds this time

    expect(commitAttempts()).toBe(2); // one failed attempt + one successful attempt
    expect(successfulCommitCount()).toBe(1); // but only ONE successful Remove
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1); // at most one post
    expect(seenIds()).toContain('cc-crash-before-commit-1');
    unsub();
  });

  it('[crash-after-commit x redelivery] Remove lands, THEN a fresh-eventId redelivery arrives (restart-analog): tree-gate converges to terminal no-op, no second Remove/post', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-crash-after-commit';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    await fireEvent({ id: 'cc-crash-after-commit-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);

    // A DISTINCT-eventId redelivery of the identical underlying decline,
    // as if a restarted app's relay redelivered a copy it hadn't marked
    // seen before a hypothetical crash — the tree-gate (B already removed)
    // must produce a clean terminal no-op, not a second Remove/post.
    await fireEvent({ id: 'cc-crash-after-commit-2', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });

    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(seenIds()).toContain('cc-crash-after-commit-2'); // terminal-noop still marks seen
    unsub();
  });

  it('[concurrent double-click x no-crash] two genuinely distinct wraps dispatched concurrently converge to exactly one Remove + at most one post', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-concurrent-clean';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const commitGate = createDeferred<void>();
    const { deps, mockCommit, commitEntered, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
      commitGate: commitGate.promise,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const first = fireEvent({ id: 'cc-concurrent-clean-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    const second = fireEvent({ id: 'cc-concurrent-clean-2', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    await commitEntered;
    commitGate.resolve();
    await Promise.all([first, second]);

    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('[concurrent double-click x crash-before-commit] first attempt hits a throwing commit; the serialized second attempt retries and succeeds -> exactly one successful Remove', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-concurrent-crash';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    // The FIRST commit() invocation (whichever call reaches it first, since
    // runSerializedDeclineProcessing strictly serializes by (groupId,pubkey))
    // throws; the second invocation (the serialized retry, whether it's the
    // sibling concurrent call or a later redelivery) succeeds.
    const { deps, successfulCommitCount, commitAttempts } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
      commitBehavior: ['throw', 'succeed'],
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    // Genuinely concurrent (neither awaited before the other starts) —
    // runSerializedDeclineProcessing's per-key chain means the SECOND call's
    // own tree-gate check only runs after the FIRST's full applyDecline
    // (including its failed commit) has resolved.
    const first = fireEvent({ id: 'cc-concurrent-crash-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    const second = fireEvent({ id: 'cc-concurrent-crash-2', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    await Promise.all([first, second]);

    expect(commitAttempts()).toBe(2); // first threw, second succeeded
    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    // Exactly one of the two wraps ends up marked seen (the one whose
    // attempt succeeded); the other — whichever attempt hit the throwing
    // commit — stays unmarked so it would reprocess (safely, as a
    // terminal-noop, since B is no longer pending) on a future redelivery.
    const marked = [seenIds().includes('cc-concurrent-crash-1'), seenIds().includes('cc-concurrent-crash-2')];
    expect(marked.filter(Boolean).length).toBe(1);
    unsub();
  });

  it('[sync-deferral x redelivery] a decline arrives before the group syncs; a SAME-eventId redelivery arrives WHILE still deferred; sync then completes -> exactly one Remove once resolved', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-defer-then-redeliver';
    // Built directly (not via buildDeclineWrap) so the group stays deliberately unsynced.
    const { wrap } = buildGenuineWrap({
      sender: invitee,
      recipientPubHex: admin.pubHex,
      kind: INVITE_DECLINE_KIND,
      content: JSON.stringify({ groupId, pubkey: invitee.pubHex }),
    });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-defer-then-redeliver-1', pubkey: wrap.pubkey, content: wrap.content };
    const firstPending = fireEvent(ndkEvent); // parked awaiting sync gate
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(successfulCommitCount()).toBe(0);

    // A SAME-eventId redelivery arrives while the first is still parked.
    // Neither has marked the wrap seen yet (top-level seen-guard reads
    // localStorage synchronously at dispatch time, before either has
    // resolved), so this genuinely re-enters the dispatch path — exactly
    // the concurrency shape runSerializedDeclineProcessing exists to
    // collapse.
    const secondPending = fireEvent(ndkEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(successfulCommitCount()).toBe(0); // still deferred — sync hasn't completed

    // Now the group's historical sync completes.
    mockFetchEventsWithTimeout.mockReset();
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(), timedOut: false });
    const groupMockNdk = { subscribe: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })) };
    const groupUnsub = await subscribeToGroupMessages(
      groupId,
      ['wss://r'],
      { groupData: { nostrGroupId: new Uint8Array(32).fill(0x77) } } as never,
      groupMockNdk as never,
    );

    await Promise.all([firstPending, secondPending]);

    expect(successfulCommitCount()).toBe(1); // exactly one Remove despite the duplicate deferred delivery
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(seenIds()).toContain('cc-defer-then-redeliver-1');

    groupUnsub();
    unsub();
  });

  it('[group-not-held x redelivery] A does not hold the group at all: terminal no-op immediately (no hang, no dangling waiter), redelivery after mark-seen never reaches the tree-gate', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-not-held';
    const { wrap } = buildGenuineWrap({
      sender: invitee,
      recipientPubHex: admin.pubHex,
      kind: INVITE_DECLINE_KIND,
      content: JSON.stringify({ groupId, pubkey: invitee.pubHex }),
    });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    deps.getGroup = vi.fn(async () => null); // A never joined / already left
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-not-held-1', pubkey: wrap.pubkey, content: wrap.content };
    // Resolves promptly (no dangling history-sync waiter) — this await
    // itself is the assertion that FIX C's existence guard fires before
    // ever deferring on sync.
    await fireEvent(ndkEvent);
    expect(successfulCommitCount()).toBe(0);
    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    expect(seenIds()).toContain('cc-not-held-1');

    // Redelivery: the top-level seen-guard now short-circuits before the
    // tree-gate is ever consulted again.
    await fireEvent(ndkEvent);
    expect(deps.getGroup).toHaveBeenCalledTimes(1); // not called a second time
    expect(successfulCommitCount()).toBe(0);

    unsub();
  });

  it('[empty-groupId x redelivery] a clean no-op regardless of how many times it is redelivered', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const { wrap } = buildGenuineWrap({
      sender: invitee,
      recipientPubHex: admin.pubHex,
      kind: INVITE_DECLINE_KIND,
      content: JSON.stringify({ groupId: '', pubkey: invitee.pubHex }),
    });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-empty-groupid-1', pubkey: wrap.pubkey, content: wrap.content };
    await expect(fireEvent(ndkEvent)).resolves.toBeUndefined();
    await expect(fireEvent(ndkEvent)).resolves.toBeUndefined();

    expect(deps.getGroup).not.toHaveBeenCalled();
    expect(successfulCommitCount()).toBe(0);
    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    expect(seenIds()).toContain('cc-empty-groupid-1');
    unsub();
  });

  it('[already-joined terminal-noop x re-invite x redelivery] a stale decline is a no-op, marked seen; re-invite makes B pending again; the SAME eventId redelivered must NOT reactivate', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-reinvite-redelivery';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      profiledPubkeys: [invitee.pubHex], // already joined -> confirmed, not pending
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-reinvite-redelivery-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content };
    await fireEvent(ndkEvent); // terminal no-op (already joined), marked seen
    expect(successfulCommitCount()).toBe(0);
    expect(seenIds()).toContain('cc-reinvite-redelivery-1');

    // A re-invites B to the SAME group: B goes back to pending.
    deps.loadMemberProfiles = vi.fn(async () => []);

    // Redeliver the IDENTICAL (already-seen) wrap TWICE more — per
    // AC-CROSS-1's documented bounded assumption, this SAME-eventId path
    // must stay closed no matter how many times it recurs. (The
    // DISTINCT-eventId variant of this same attack is the acknowledged
    // out-of-scope limitation — see the FIX B doc comment in
    // welcomeSubscription.ts and this file's dedicated test below.)
    await fireEvent(ndkEvent);
    await fireEvent(ndkEvent);

    expect(successfulCommitCount()).toBe(0);
    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    unsub();
  });

  it('[documented out-of-scope] a DISTINCT-eventId decline arriving AFTER a re-invite CAN reactivate — acknowledged bound, not a regression to chase here', async () => {
    // This test exists to pin the boundary of the accepted limitation, not
    // to celebrate it: it demonstrates that the SAME-eventId path (tested
    // above) is the one AC-CROSS-1 actually closes, and that a genuinely
    // distinct gift-wrap id carrying the identical decline content is
    // outside this property's guarantee, exactly as architecture.md /
    // the story brief describe it. If this ever needs to be closed, that
    // is a production-code change belonging to decline-a's own story, not
    // a property to weaken here.
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-reinvite-distinct-oos';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      profiledPubkeys: [invitee.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    await fireEvent({ id: 'cc-reinvite-distinct-oos-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });
    expect(successfulCommitCount()).toBe(0);

    deps.loadMemberProfiles = vi.fn(async () => []); // re-invite: B pending again

    // A DISTINCT outer eventId, same underlying decline content — bypasses
    // the top-level seen-guard entirely (it is a genuinely new wrap id).
    await fireEvent({ id: 'cc-reinvite-distinct-oos-2', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content });

    // Documented behavior, not asserted as a bug: this distinct-id
    // redelivery DOES reach the tree-gate and finds B genuinely pending
    // (because of the re-invite), so it fires. Recording this rather than
    // hiding it keeps the accepted limitation auditable.
    expect(successfulCommitCount()).toBe(1);
    unsub();
  });

  it('[Remove-succeeds-post-fails x redelivery] declined post is best-effort: zero posts permitted when it throws, and a later redelivery does not retry the post', async () => {
    const invitee = makeKeypair();
    const admin = makeKeypair();
    const groupId = 'cc-post-fails-redelivery';
    const wrap = await buildDeclineWrap({ invitee, inviterPubHex: admin.pubHex, groupId });
    const { deps, getMembers, successfulCommitCount } = makeDeclineTestDeps({
      initialMembers: [invitee.pubHex, admin.pubHex],
      selfPubkeyHex: admin.pubHex,
    });
    deps.sendAnnouncement = vi.fn(async () => {
      throw new Error('relay unreachable');
    });
    const { fireEvent, unsub } = await startSubscription(admin, deps);

    const ndkEvent = { id: 'cc-post-fails-redelivery-1', pubkey: wrap.wrap.pubkey, content: wrap.wrap.content };
    await fireEvent(ndkEvent);

    expect(successfulCommitCount()).toBe(1); // the Remove is the durable, load-bearing action
    expect(getMembers()).not.toContain(invitee.pubHex);
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledTimes(1);
    expect(seenIds()).toContain('cc-post-fails-redelivery-1'); // best-effort post failure still marks seen

    await fireEvent(ndkEvent); // redelivery — must not retry the post or re-Remove

    expect(successfulCommitCount()).toBe(1);
    expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1); // the one failed attempt, never retried
    unsub();
  });
});
