import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';

// Bug: admin-and-invite-guards (1). The sole-admin leave block was only
// evaluated in the leave modal against last-known adminPubkeys. Two co-admins
// leaving at nearly the same moment could both pass it and strand the group
// with zero admins. leaveGroupImpl now re-reads adminPubkeys from the live MLS
// group at execution time and aborts, before any irreversible step, when the
// leaver has become the sole admin of a group that still has other members.

const { leaveGroupImpl } = await import('@/src/lib/marmot/leaveGroupImpl');

const SELF = 'alice';
const OTHER = 'bob';
const GROUP_ID = 'group-1';

type GroupData = { adminPubkeys?: string[] } | null | undefined;

function makeMlsGroup(groupData: GroupData | (() => GroupData)) {
  const g: Record<string, unknown> = {
    state: { opaque: 'live-mls-state' },
    sendApplicationRumor: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(g, 'groupData', {
    get: typeof groupData === 'function' ? groupData : () => groupData,
  });
  return g as { state: unknown; groupData: GroupData; sendApplicationRumor: ReturnType<typeof vi.fn> };
}

function makeDeps(opts: {
  mlsGroup: ReturnType<typeof makeMlsGroup> | null;
  members?: string[] | (() => string[]);
}) {
  const members = opts.members ?? [SELF, OTHER];
  return {
    getGroup: vi.fn().mockResolvedValue(opts.mlsGroup),
    getGroupMembers: vi.fn(typeof members === 'function' ? members : () => members),
    sendRumorSafe: vi.fn().mockResolvedValue(undefined),
    buildRumor: vi.fn((kind: number, content: string, pubkey: string) => ({ kind, content, pubkey, tags: [] })),
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
  };
}

function expectNothingIrreversibleHappened(deps: ReturnType<typeof makeDeps>, mls: { sendApplicationRumor: unknown }) {
  expect(deps.sendRumorSafe).not.toHaveBeenCalled();
  expect(mls.sendApplicationRumor).not.toHaveBeenCalled();
  expect(deps.putLeftGroupTombstone).not.toHaveBeenCalled();
  expect(deps.removeGroupFromStorage).not.toHaveBeenCalled();
  expect(deps.clearMessages).not.toHaveBeenCalled();
  expect(deps.destroyGroupState).not.toHaveBeenCalled();
  expect(deps.reloadGroups).not.toHaveBeenCalled();
  expect(deps.markBackupDirty).not.toHaveBeenCalled();
}

describe('leaveGroupImpl — execution-time sole-admin re-check (VQ-1, VQ-2)', () => {
  it('aborts with false and sends/purges nothing when the leaver is now the sole admin of a multi-member group', async () => {
    const mls = makeMlsGroup({ adminPubkeys: [SELF] });
    const deps = makeDeps({ mlsGroup: mls });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF, 'Alice');

    expect(result).toBe(false);
    expectNothingIrreversibleHappened(deps, mls);
  });

  it('compares the admin pubkey case-insensitively', async () => {
    const mls = makeMlsGroup({ adminPubkeys: ['ALICE'] });
    const deps = makeDeps({ mlsGroup: mls });
    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(false);
    expectNothingIrreversibleHappened(deps, mls);
  });

  it('reads adminPubkeys at execution time, not from any earlier snapshot (admins shrink between calls)', async () => {
    let admins = [SELF, OTHER];
    const liveAdmins = () => ({ adminPubkeys: admins });
    const first = makeDeps({ mlsGroup: makeMlsGroup(liveAdmins) });
    expect(await leaveGroupImpl(first, GROUP_ID, SELF)).toBe(true); // co-admin: allowed

    admins = [SELF]; // the other co-admin's departure commit landed meanwhile
    const mls = makeMlsGroup(liveAdmins);
    const second = makeDeps({ mlsGroup: mls });
    expect(await leaveGroupImpl(second, GROUP_ID, SELF)).toBe(false);
    expectNothingIrreversibleHappened(second, mls);
  });

  it.each([
    ['a co-admin', { adminPubkeys: [SELF, OTHER] }],
    ['a plain member (another member is the sole admin)', { adminPubkeys: [OTHER] }],
  ])('leaves as before for %s', async (_label, groupData) => {
    const mls = makeMlsGroup(groupData);
    const deps = makeDeps({ mlsGroup: mls });

    const result = await leaveGroupImpl(deps, GROUP_ID, SELF, 'Alice');

    expect(result).toBe(true);
    expect(deps.sendRumorSafe).toHaveBeenCalledTimes(1);
    expect(mls.sendApplicationRumor).toHaveBeenCalledTimes(1);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });

  it('the last member who is also the sole admin may still abandon the group (last-member wins over sole-admin)', async () => {
    const mls = makeMlsGroup({ adminPubkeys: [SELF] });
    const deps = makeDeps({ mlsGroup: mls, members: [SELF] });

    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });

  // Fail-closed direction (documented in leaveGroupImpl): an unreadable admin
  // set never blocks, because the local purge must never be skipped.
  it.each([
    ['groupData is null', null],
    ['groupData has no adminPubkeys', {}],
    ['adminPubkeys is empty', { adminPubkeys: [] }],
  ])('proceeds with the leave when %s', async (_label, groupData) => {
    const mls = makeMlsGroup(groupData as GroupData);
    const deps = makeDeps({ mlsGroup: mls });
    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });

  it('proceeds with the leave and the purge when reading groupData throws (corrupt state)', async () => {
    const mls = makeMlsGroup(() => {
      throw new Error('corrupt group context');
    });
    const deps = makeDeps({ mlsGroup: mls });

    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
    expect(deps.clearMessages).toHaveBeenCalledWith(GROUP_ID);
  });

  it('proceeds (never blocks the purge) when the member read throws, even if groupData names the leaver sole admin', async () => {
    const mls = makeMlsGroup({ adminPubkeys: [SELF] });
    const deps = makeDeps({
      mlsGroup: mls,
      members: () => {
        throw new Error('corrupt tree');
      },
    });

    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });

  it('with no resolvable MLS group the purge still runs (nothing to re-check)', async () => {
    const deps = makeDeps({ mlsGroup: null });
    expect(await leaveGroupImpl(deps, GROUP_ID, SELF)).toBe(true);
    expect(deps.removeGroupFromStorage).toHaveBeenCalledWith(GROUP_ID);
  });
});
