import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// NOTE: leaveGroupImpl has zero top-level imports from marmot-ts or context —
// getGroup/getGroupMembers/sendRumorSafe/buildRumor are all injected via the
// Deps interface. We therefore do NOT need a vi.mock('@internet-privacy/marmot-ts')
// at the top of this file, mirroring grantAdminImpl.test.ts.
//
// fake-indexeddb/auto is imported here (rather than mocked) solely to back the
// real-storage AC-MARKER-9 scoping test below (VQ-S3-007) — every other test
// in this file continues to exercise leaveGroupImpl against fully-mocked Deps.

const { leaveGroupImpl } = await import('@/src/lib/marmot/leaveGroupImpl');

const SELF = 'alice';
const OTHER = 'bob';
const GROUP_ID = 'group-1';

function makeMlsGroup(overrides: { sendApplicationRumor?: ReturnType<typeof vi.fn> } = {}) {
  return {
    state: { opaque: 'live-mls-state' },
    sendApplicationRumor: overrides.sendApplicationRumor ?? vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(
  overrides: {
    mlsGroup?: ReturnType<typeof makeMlsGroup> | null;
    members?: string[];
    sendRumorSafeImpl?: (...args: unknown[]) => Promise<void>;
  } = {},
) {
  const mlsGroup = overrides.mlsGroup === undefined ? makeMlsGroup() : overrides.mlsGroup;
  const members = overrides.members ?? [SELF];

  const sendRumorSafe = vi.fn(overrides.sendRumorSafeImpl ?? (async () => {}));
  const buildRumor = vi.fn((kind: number, content: string, pubkey: string, tags: string[][] = []) => ({
    id: 'stub-id',
    kind,
    content,
    pubkey,
    tags,
  }));

  return {
    getGroup: vi.fn().mockResolvedValue(mlsGroup),
    getGroupMembers: vi.fn().mockReturnValue(members),
    sendRumorSafe,
    buildRumor,
    removeGroupFromStorage: vi.fn().mockResolvedValue(undefined),
    clearMemberProfiles: vi.fn().mockResolvedValue(undefined),
    clearMessages: vi.fn().mockResolvedValue(undefined),
    clearPollData: vi.fn().mockResolvedValue(undefined),
    clearGroupMedia: vi.fn().mockResolvedValue(undefined),
    clearProfileRequestMemos: vi.fn().mockResolvedValue(undefined),
    clearUnreadGroup: vi.fn(),
    clearPendingJoinRequestsForGroup: vi.fn().mockResolvedValue(undefined),
    clearInviteLinksForGroup: vi.fn().mockResolvedValue(undefined),
    clearInviteExpiries: vi.fn(),
    clearPendingDirectInvitesForGroup: vi.fn().mockResolvedValue(undefined),
    clearRumorJournalForGroup: vi.fn().mockResolvedValue(undefined),
    clearPendingRemovalsForGroup: vi.fn().mockResolvedValue(undefined),
    putLeftGroupTombstone: vi.fn().mockResolvedValue(undefined),
    deleteLeftGroupTombstone: vi.fn().mockResolvedValue(undefined),
    destroyGroupState: vi.fn().mockResolvedValue(undefined),
    reloadGroups: vi.fn().mockResolvedValue(undefined),
    markBackupDirty: vi.fn(),
    // Exposed for assertions against the mock passed to getGroup.
    mlsGroup,
  };
}

describe('leaveGroupImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // AC-SEND-1: solo group — neither the kind-13 nor the kind-9 send fires.
  it('AC-SEND-1: solo group (last member) — neither kind-13 nor kind-9 is sent', async () => {
    const deps = makeDeps({ members: [SELF] });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(result).toBe(true);
    expect(deps.sendRumorSafe).not.toHaveBeenCalled();
    expect(deps.mlsGroup!.sendApplicationRumor).not.toHaveBeenCalled();
  });

  // AC-SEND-2: multi-member group — both sends still fire, unchanged. A
  // genuinely distinct fixture from AC-SEND-1's (different members array),
  // so the send-skip and send-proceed branches are independently exercised.
  it('AC-SEND-2: two-member group — both kind-13 and kind-9 are sent exactly once', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF, 'Alice');

    expect(result).toBe(true);
    expect(deps.sendRumorSafe).toHaveBeenCalledTimes(1);
    expect(deps.mlsGroup!.sendApplicationRumor).toHaveBeenCalledTimes(1);

    // kind-13 leave-intent rumor, naming the leaver
    const [, kind13Rumor] = deps.sendRumorSafe.mock.calls[0];
    expect(kind13Rumor.kind).toBe(13);
    expect(kind13Rumor.content).toContain(SELF);

    // kind-9 announcement rumor
    const kind9Rumor = (deps.mlsGroup!.sendApplicationRumor as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(kind9Rumor.kind).toBe(9);
  });

  // The kind-9 announcement must carry the leaver's own display name so every
  // recipient renders "<name> left the group" (never an npub), even when they
  // never received the leaver's MemberProfile.
  it('kind-9 leave announcement embeds the leaver display name', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    await leaveGroupImpl(deps, GROUP_ID, SELF, 'Alice');

    const kind9Rumor = (deps.mlsGroup!.sendApplicationRumor as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = JSON.parse(kind9Rumor.content);
    expect(payload).toMatchObject({ type: 'leave_intent', pubkey: SELF, name: 'Alice' });
  });

  // When no display name is available, the payload omits `name` entirely (no
  // empty/whitespace field) so the renderer falls back to profile/npub.
  it('kind-9 leave announcement omits name when the leaver has no display name', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    await leaveGroupImpl(deps, GROUP_ID, SELF, '   ');

    const kind9Rumor = (deps.mlsGroup!.sendApplicationRumor as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = JSON.parse(kind9Rumor.content);
    expect(payload).toEqual({ type: 'leave_intent', pubkey: SELF });
    expect(payload).not.toHaveProperty('name');
  });

  // AC-PURGE-1: both new leak-fixing clears fire on the abandon (solo) path.
  it('AC-PURGE-1: solo/abandon path clears pending join requests and invite links', async () => {
    const deps = makeDeps({ members: [SELF] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  // AC-PURGE-1: both new leak-fixing clears fire on the normal (multi-member) path too —
  // neither purge call is conditioned on which send branch was taken.
  it('AC-PURGE-1: multi-member/normal path clears pending join requests and invite links', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  // AC-DEEPLINK-4: clearInviteExpiries runs in the SAME unconditional purge
  // call as clearInviteLinksForGroup, on both the abandon (solo) and the
  // normal (multi-member) path — not a separate, independently-skippable step.
  it('AC-DEEPLINK-4: solo/abandon path clears the invite-expiry badge alongside invite links', async () => {
    const deps = makeDeps({ members: [SELF] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteExpiries).toHaveBeenCalledWith(GROUP_ID);
  });

  it('AC-DEEPLINK-4: multi-member/normal path clears the invite-expiry badge alongside invite links', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteExpiries).toHaveBeenCalledWith(GROUP_ID);
  });

  // AC-DEEPLINK-4: even when getGroup fails to resolve an mlsGroup (the
  // early-fail-closed path — R2 above), the unconditional purge still
  // reaches clearInviteExpiries — there is no early return between
  // clearInviteLinksForGroup and clearInviteExpiries that a corrupt/missing
  // mlsGroup could exploit to skip the badge clear.
  it('AC-DEEPLINK-4: no mlsGroup — invite-expiry badge is still cleared', async () => {
    const deps = makeDeps({ mlsGroup: null });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteExpiries).toHaveBeenCalledWith(GROUP_ID);
  });

  // AC-PURGE-1: the full pre-existing purge sequence still runs unconditionally.
  it('AC-PURGE-1: runs the full purge sequence including reloadGroups then markBackupDirty', async () => {
    const deps = makeDeps({ members: [SELF] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearMemberProfiles).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearMessages).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPollData).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearGroupMedia).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearProfileRequestMemos).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearUnreadGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(deps.markBackupDirty).toHaveBeenCalledWith(true);

    // reloadGroups before markBackupDirty, per the grantAdmin/renameGroup convention.
    const reloadOrder = deps.reloadGroups.mock.invocationCallOrder[0];
    const markDirtyOrder = deps.markBackupDirty.mock.invocationCallOrder[0];
    expect(reloadOrder).toBeLessThan(markDirtyOrder);
  });

  // AC-STRUCT-3: last-member determination reads live state fetched WITHIN
  // this call (getGroupMembers(mlsGroup.state)) — never a caller-passed value.
  // leaveGroupImpl's signature takes no memberPubkeys/isLastMember parameter,
  // so the only way to prove this is to assert getGroupMembers was invoked
  // with the exact state object belonging to the mlsGroup this call fetched.
  it('AC-STRUCT-3: derives membership from a fresh getGroupMembers(mlsGroup.state) read', async () => {
    const deps = makeDeps({ members: [SELF] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.getGroupMembers).toHaveBeenCalledTimes(1);
    expect(deps.getGroupMembers).toHaveBeenCalledWith(deps.mlsGroup!.state);
  });

  // R2 (fail-closed, opposite direction from the modal decision): when the
  // group can't be read at all, there is nothing to send with — no sends are
  // attempted (send is physically impossible without an mlsGroup reference)
  // — but the purge still proceeds unconditionally.
  it('no mlsGroup: getGroup resolves null — no sends attempted, purge still runs', async () => {
    const deps = makeDeps({ mlsGroup: null });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(result).toBe(true);
    expect(deps.getGroupMembers).not.toHaveBeenCalled();
    expect(deps.sendRumorSafe).not.toHaveBeenCalled();
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
  });

  // A failed kind-13 send must not block the purge — caught and logged.
  it('kind-13 send failure is caught: purge still completes, function still returns true', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      members: [SELF, OTHER],
      sendRumorSafeImpl: async () => {
        throw new Error('unapplied proposals');
      },
    });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kind-13 send failed'), expect.any(Error));
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(deps.markBackupDirty).toHaveBeenCalledWith(true);

    warnSpy.mockRestore();
  });

  // The kind-9 send is fire-and-forget: a rejection must not surface as an
  // unhandled rejection or block the purge.
  it('kind-9 send failure does not block the purge', async () => {
    const deps = makeDeps({
      members: [SELF, OTHER],
      mlsGroup: makeMlsGroup({ sendApplicationRumor: vi.fn().mockRejectedValue(new Error('network')) }),
    });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(result).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });

  // S3/F1 gate fix: getGroupMembers reads live MLS ratchet state synchronously
  // and can throw on corrupt/unparseable state. That must not abort the purge —
  // the same fail-closed contract as an unreadable mlsGroup (R2 above): members
  // becomes undefined, isLastMember is false, send-anyway is attempted, and the
  // purge — including the two leak-fixing clears — still runs unconditionally.
  it('corrupt MLS state: getGroupMembers throws — purge still completes, function still returns true', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });
    deps.getGroupMembers.mockImplementation(() => {
      throw new Error('corrupt state');
    });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(result).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
  });

  // AC-MARKER-9 (leave-fan-out half, S3): the new clearPendingDirectInvitesForGroup
  // dep must actually be INVOKED — not merely declared in Deps (VQ-S3-001) —
  // with exactly the groupId being left, on both the abandon and normal-leave
  // paths (VQ-S3-006: unconditional, not gated behind the last-member branch).
  // The pre-existing sibling clear-dep calls are re-asserted alongside it to
  // prove this story's diff did not reorder or drop them (VQ-S3-004).
  it('AC-MARKER-9: solo/abandon path clears the pending-direct-invite marker for the group being left', async () => {
    const deps = makeDeps({ members: [SELF] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearMemberProfiles).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it('AC-MARKER-9: multi-member/normal path clears the pending-direct-invite marker for the group being left', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearMemberProfiles).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPendingJoinRequestsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearInviteLinksForGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it('AC-MARKER-9: no mlsGroup — the marker clear still runs unconditionally (mirrors R2 fail-closed purge)', async () => {
    const deps = makeDeps({ mlsGroup: null });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it('AC-MARKER-9: corrupt MLS state (getGroupMembers throws) — the marker clear still runs', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });
    deps.getGroupMembers.mockImplementation(() => {
      throw new Error('corrupt state');
    });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.clearPendingDirectInvitesForGroup).toHaveBeenCalledWith(GROUP_ID);
  });
});

// AC-MARKER-9 (VQ-S3-007): wires the REAL pendingDirectInviteStorage clear
// (not a mock) into leaveGroupImpl's Deps to prove the leave-fan-out clear is
// correctly scoped to exactly the group being left — a second, unrelated
// group's markers must survive. This is the one test in this file that
// intentionally imports the real storage module: every other test proves
// leaveGroupImpl calls its injected Deps correctly; this one additionally
// proves that call, wired to the real store, has the intended real-world effect.
describe('leaveGroupImpl — AC-MARKER-9 real-storage scoping (VQ-S3-007)', () => {
  const LEFT_GROUP = 'left-group';
  const OTHER_GROUP = 'other-group';

  it('clears markers for the group being left, leaving an unrelated group untouched', async () => {
    const {
      markPendingDirectInvite,
      loadPendingDirectInviteMarkers,
      clearPendingDirectInvitesForGroup,
      clearAllPendingDirectInvites,
    } = await import('@/src/lib/marmot/pendingDirectInviteStorage');

    await clearAllPendingDirectInvites();
    await markPendingDirectInvite(LEFT_GROUP, SELF);
    await markPendingDirectInvite(OTHER_GROUP, OTHER);

    const deps = makeDeps({ members: [SELF] });
    // Override the mock with the real, un-mocked storage function.
    (deps as { clearPendingDirectInvitesForGroup: typeof clearPendingDirectInvitesForGroup }).clearPendingDirectInvitesForGroup =
      clearPendingDirectInvitesForGroup;

    await leaveGroupImpl(deps, LEFT_GROUP, SELF);

    expect(await loadPendingDirectInviteMarkers(LEFT_GROUP)).toEqual(new Set());
    expect(await loadPendingDirectInviteMarkers(OTHER_GROUP)).toEqual(new Set([OTHER]));

    await clearAllPendingDirectInvites();
  });

  // bug: mls-message-lost-on-unload-after-ingest — the write-ahead rumor
  // journal holds decrypted plaintext; leaving must drop the group's entries
  // on every path, before the groups reload.
  it.each([
    ['solo/abandon', { members: [SELF] }],
    ['multi-member', { members: [SELF, OTHER] }],
    ['no mlsGroup', { mlsGroup: null }],
  ] as const)('%s path clears the group\'s rumor journal before reloading groups', async (_l, opts) => {
    const deps = makeDeps(opts as never);
    await leaveGroupImpl(deps, GROUP_ID, SELF);
    expect(deps.clearRumorJournalForGroup).toHaveBeenCalledTimes(1);
    expect(deps.clearRumorJournalForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearRumorJournalForGroup.mock.invocationCallOrder[0]).toBeLessThan(
      deps.reloadGroups.mock.invocationCallOrder[0],
    );
  });
});

// bug: pending-member-removals-not-persisted — the group's durable pending
// removals go with the leave purge; a failing clear never skips the rest.
describe('leaveGroupImpl — durable pending removals', () => {
  it.each([
    ['solo/abandon', { members: [SELF] }],
    ['multi-member', { members: [SELF, OTHER] }],
    ['no mlsGroup', { mlsGroup: null }],
  ] as const)('%s path clears the group\'s pending removals before reloading groups', async (_l, opts) => {
    const deps = makeDeps(opts as never);
    await leaveGroupImpl(deps, GROUP_ID, SELF);
    expect(deps.clearPendingRemovalsForGroup).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingRemovalsForGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearPendingRemovalsForGroup.mock.invocationCallOrder[0]).toBeLessThan(
      deps.reloadGroups.mock.invocationCallOrder[0],
    );
  });

  it('failure injection: a rejecting pending-removal clear is warned and the purge, destroy and reload still run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ members: [SELF] } as never);
    deps.clearPendingRemovalsForGroup.mockRejectedValueOnce(new Error('idb down'));
    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).resolves.toBe(true);
    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pending-removal cleanup failed'), expect.any(Error));
    warn.mockRestore();
  });
});

// finding leave-clearpolldata-unguarded — a poll storage failure is
// best-effort: the rest of the purge, the destroy and the reload still run.
describe('leaveGroupImpl — clearPollData failure does not abort the leave', () => {
  const LATER_STEPS = [
    'clearGroupMedia',
    'clearProfileRequestMemos',
    'clearUnreadGroup',
    'clearPendingJoinRequestsForGroup',
    'clearInviteLinksForGroup',
    'clearPendingDirectInvitesForGroup',
    'clearInviteExpiries',
    'clearRumorJournalForGroup',
    'clearPendingRemovalsForGroup',
    'destroyGroupState',
    'deleteLeftGroupTombstone',
  ] as const;

  it.each([
    ['solo/abandon (inline destroy)', { members: [SELF] }],
    ['multi-member (deferred destroy)', { members: [SELF, OTHER] }],
  ] as const)('%s: rejecting clearPollData → resolves true, every later step runs once with the group id, warned', async (_l, opts) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps(opts as never);
    deps.clearPollData.mockRejectedValueOnce(new Error('poll idb down'));
    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).resolves.toBe(true);
    await vi.waitFor(() => expect(deps.deleteLeftGroupTombstone).toHaveBeenCalled());
    for (const step of LATER_STEPS) {
      expect(deps[step], step).toHaveBeenCalledTimes(1);
      expect(deps[step], step).toHaveBeenCalledWith(GROUP_ID);
    }
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(deps.markBackupDirty).toHaveBeenCalledWith(true);
    expect(deps.clearPollData.mock.invocationCallOrder[0]).toBeLessThan(deps.clearGroupMedia.mock.invocationCallOrder[0]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('poll data cleanup failed'), expect.any(Error));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// bug: left-groups-keep-mls-state-forever — the group's MLS state (keys,
// history) is destroyed after the departure is sent, guarded by a tombstone.
// ---------------------------------------------------------------------------

describe('leaveGroupImpl — MLS state destroyed after leave (tombstone-guarded)', () => {
  /** Records the relative order of every tombstone/purge/destroy call. */
  function withOrderLog(deps: ReturnType<typeof makeDeps>) {
    const order: string[] = [];
    const log = (name: string, fn: ReturnType<typeof vi.fn>) => {
      const impl = fn.getMockImplementation();
      fn.mockImplementation(async (...args: unknown[]) => {
        order.push(name);
        return impl ? impl(...args) : undefined;
      });
    };
    log('put', deps.putLeftGroupTombstone);
    log('removeOverlay', deps.removeGroupFromStorage);
    log('destroy', deps.destroyGroupState);
    log('deleteTombstone', deps.deleteLeftGroupTombstone);
    log('reload', deps.reloadGroups);
    return order;
  }

  /** A kind-9 send the test settles by hand. */
  function deferredSend() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { fn: vi.fn(() => promise), resolve, reject };
  }

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('writes the tombstone {groupId} BEFORE deleting the overlay record', async () => {
    const deps = makeDeps({ members: [SELF, OTHER] });
    const order = withOrderLog(deps);

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.putLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
    expect(order.indexOf('put')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('put')).toBeLessThan(order.indexOf('removeOverlay'));
  });

  it('normal leave: resolves (purge + navigation) while the kind-9 send is still pending, and does NOT destroy before the send settles', async () => {
    const send = deferredSend();
    const deps = makeDeps({ members: [SELF, OTHER], mlsGroup: makeMlsGroup({ sendApplicationRumor: send.fn }) });

    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).resolves.toBe(true);
    await flush();

    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(deps.destroyGroupState).not.toHaveBeenCalled();
    expect(deps.deleteLeftGroupTombstone).not.toHaveBeenCalled();
    send.resolve();
  });

  it('normal leave: once the kind-9 send RESOLVES, destroys the MLS state, then deletes the tombstone', async () => {
    const send = deferredSend();
    const deps = makeDeps({ members: [SELF, OTHER], mlsGroup: makeMlsGroup({ sendApplicationRumor: send.fn }) });
    const order = withOrderLog(deps);

    await leaveGroupImpl(deps, GROUP_ID, SELF);
    send.resolve();
    await vi.waitFor(() => expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID));

    expect(deps.destroyGroupState).toHaveBeenCalledTimes(1);
    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
    expect(order).toEqual(['put', 'removeOverlay', 'reload', 'destroy', 'deleteTombstone']);
  });

  it('normal leave: a REJECTED kind-9 send still destroys the MLS state (no unhandled rejection)', async () => {
    const send = deferredSend();
    const deps = makeDeps({ members: [SELF, OTHER], mlsGroup: makeMlsGroup({ sendApplicationRumor: send.fn }) });

    await leaveGroupImpl(deps, GROUP_ID, SELF);
    send.reject(new Error('no relay acknowledged'));
    await vi.waitFor(() => expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID));

    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
  });

  it('normal leave: a kind-9 send that never settles destroys only after the 5 s timeout', async () => {
    vi.useFakeTimers();
    try {
      const send = deferredSend(); // never settled
      const deps = makeDeps({ members: [SELF, OTHER], mlsGroup: makeMlsGroup({ sendApplicationRumor: send.fn }) });

      await leaveGroupImpl(deps, GROUP_ID, SELF);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(deps.destroyGroupState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
      expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandon (last member, no send): destroys INLINE — after the overlay delete, before leaveGroupImpl resolves — then deletes the tombstone', async () => {
    const deps = makeDeps({ members: [SELF] });
    const order = withOrderLog(deps);

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.mlsGroup!.sendApplicationRumor).not.toHaveBeenCalled();
    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
    expect(order).toEqual(['put', 'removeOverlay', 'destroy', 'deleteTombstone', 'reload']);
  });

  it('no mlsGroup (nothing to send): destroys inline, like the abandon path', async () => {
    const deps = makeDeps({ mlsGroup: null });

    await leaveGroupImpl(deps, GROUP_ID, SELF);

    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.deleteLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
  });

  it('a failing destroy keeps the tombstone (the startup sweep retries) and never throws to the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ members: [SELF] });
    deps.destroyGroupState.mockRejectedValue(new Error('idb failure'));

    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).resolves.toBe(true);

    expect(deps.deleteLeftGroupTombstone).not.toHaveBeenCalled();
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('destroy'), expect.any(Error));
    warn.mockRestore();
  });

  it('a failing deferred destroy (normal leave) keeps the tombstone and causes no unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ members: [SELF, OTHER] });
    deps.destroyGroupState.mockRejectedValue(new Error('idb failure'));

    await leaveGroupImpl(deps, GROUP_ID, SELF);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('destroy'), expect.any(Error)));

    expect(deps.deleteLeftGroupTombstone).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failing tombstone write never skips the purge or the destroy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ members: [SELF] });
    deps.putLeftGroupTombstone.mockRejectedValue(new Error('quota'));

    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).resolves.toBe(true);

    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.reloadGroups).toHaveBeenCalledTimes(1);
    expect(deps.destroyGroupState).toHaveBeenCalledWith(GROUP_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tombstone'), expect.any(Error));
    warn.mockRestore();
  });

  it('a purge failure before the destroy leaves the tombstone in place for the startup sweep', async () => {
    const deps = makeDeps({ members: [SELF] });
    deps.clearMessages.mockRejectedValue(new Error('idb failure'));

    await expect(leaveGroupImpl(deps, GROUP_ID, SELF)).rejects.toThrow('idb failure');

    expect(deps.putLeftGroupTombstone).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.destroyGroupState).not.toHaveBeenCalled();
    expect(deps.deleteLeftGroupTombstone).not.toHaveBeenCalled();
  });
});
