import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Bug: left-groups-keep-mls-state-forever (design Part 1, items 1-2).
//
// Leaving purges the overlay at once and destroys the MLS state (keys,
// history) once the departure is sent; a tombstone in few-left-groups guards
// the gap. These tests cover the tombstone store, the startup sweep run by
// loadGroupsAndReconcileInvitations, the per-group-locked destroy the leave
// chain uses, and joinIdempotent dropping the tombstone after its orphan
// destroy. The marmot client is modelled as in inviteAcceptIdempotentJoin.
// ---------------------------------------------------------------------------

const { mockGetGroupMembers } = vi.hoisted(() => ({
  mockGetGroupMembers: vi.fn(() => ['bb'] as string[]),
}));

vi.mock('@internet-privacy/marmot-ts', () => ({
  getGroupMembers: (...args: unknown[]) => mockGetGroupMembers(...(args as [])),
  getWelcome: (r: unknown) => r,
  getWelcomeKeyPackageRefs: () => [] as Uint8Array[],
  readWelcomeMarmotGroupData: async () => null,
  readWelcomeGroupInfo: async () => {
    throw new Error('no group info');
  },
}));

const { deleteTombstoneOverride, listTombstonesOverride } = vi.hoisted(() => ({
  deleteTombstoneOverride: { fn: null as null | ((id: string) => Promise<void>) },
  listTombstonesOverride: { fn: null as null | (() => Promise<{ groupId: string; leftAt: number }[]>) },
}));
vi.mock('@/src/lib/marmot/leftGroupTombstones', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/marmot/leftGroupTombstones')>();
  return {
    ...actual,
    deleteLeftGroupTombstone: (id: string) =>
      deleteTombstoneOverride.fn ? deleteTombstoneOverride.fn(id) : actual.deleteLeftGroupTombstone(id),
    listLeftGroupTombstones: () =>
      listTombstonesOverride.fn ? listTombstonesOverride.fn() : actual.listLeftGroupTombstones(),
  };
});

import {
  acceptPendingInvitation,
  loadGroupsAndReconcileInvitations,
  sweepLeftGroups,
  destroyLeftGroupState,
} from '@/src/lib/marmot/welcomeSubscription';
import {
  putLeftGroupTombstone,
  deleteLeftGroupTombstone,
  listLeftGroupTombstones,
  listLeftGroupIds,
  clearAllLeftGroupTombstones,
} from '@/src/lib/marmot/leftGroupTombstones';
import { enqueuePendingInvitation, listPendingInvitations, type PendingInvitation } from '@/src/lib/pendingInvitations';
import { saveGroup, loadGroup, clearAllGroupMeta, IdbGroupStateBackend } from '@/src/lib/marmot/groupStorage';
import { collectBackupPayload } from '@/src/lib/backup/relayBackup';
import type { Group } from '@/src/types';
import { createStore, get, set } from 'idb-keyval';

const GROUP_HEX = 'ab'.repeat(32);
const OTHER_HEX = 'cd'.repeat(32);

function makeClient(mls: Set<string>, joinedId = GROUP_HEX) {
  const order: string[] = [];
  return {
    order,
    groups: {
      loadAll: vi.fn(async () => {
        order.push('loadAll');
        return [];
      }),
      has: vi.fn(async (id: string) => {
        order.push(`has:${id}`);
        return mls.has(id);
      }),
      destroy: vi.fn(async (id: string) => {
        order.push(`destroy:${id}`);
        mls.delete(id);
      }),
    },
    joinGroupFromWelcome: vi.fn(async () => {
      order.push('join');
      if (mls.has(joinedId)) throw new Error(`Group ${joinedId} already exists`);
      mls.add(joinedId);
      return { group: { idStr: joinedId, groupData: { name: 'Joined Name' }, relays: ['wss://r.example'], state: {} } };
    }),
    keyPackages: { get: vi.fn(async () => undefined as unknown) },
    cryptoProvider: { getCiphersuiteImpl: vi.fn(async () => 'cs') },
  };
}

function overlay(id = GROUP_HEX): Group {
  return { id, name: 'Existing', createdAt: 1, memberPubkeys: ['aa'], relays: ['wss://old.example'] };
}

function makeEntry(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: 'inv-1',
    inviterPubkeyHex: 'ee'.repeat(32),
    receivedAt: Date.now(),
    welcomeEventJson: JSON.stringify({ kind: 444, pubkey: OTHER_HEX, content: 'w', tags: [] }),
    groupId: GROUP_HEX,
    authenticated: true,
    ...overrides,
  };
}

let store: Record<string, string> = {};

beforeEach(async () => {
  store = {};
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  deleteTombstoneOverride.fn = null;
  listTombstonesOverride.fn = null;
  await clearAllGroupMeta();
  await clearAllLeftGroupTombstones();
});

// ---------------------------------------------------------------------------
// Tombstone store
// ---------------------------------------------------------------------------

describe('leftGroupTombstones store', () => {
  it('put / list / delete round-trip, keyed by group id with a leftAt stamp', async () => {
    await putLeftGroupTombstone(GROUP_HEX, 1234);
    await putLeftGroupTombstone(OTHER_HEX, 99);

    expect((await listLeftGroupTombstones()).sort((a, b) => a.leftAt - b.leftAt)).toEqual([
      { groupId: OTHER_HEX, leftAt: 99 },
      { groupId: GROUP_HEX, leftAt: 1234 },
    ]);
    expect(await listLeftGroupIds()).toEqual(new Set([GROUP_HEX, OTHER_HEX]));

    await deleteLeftGroupTombstone(GROUP_HEX);
    expect(await listLeftGroupTombstones()).toEqual([{ groupId: OTHER_HEX, leftAt: 99 }]);
  });

  it('lives in its own IDB database few-left-groups, object store tombstones, keyed by group id', async () => {
    await putLeftGroupTombstone(GROUP_HEX, 5);
    expect(await get(GROUP_HEX, createStore('few-left-groups', 'tombstones'))).toEqual({ groupId: GROUP_HEX, leftAt: 5 });
  });

  it('leftAt defaults to now', async () => {
    const before = Date.now();
    await putLeftGroupTombstone(GROUP_HEX);
    const [t] = await listLeftGroupTombstones();
    expect(t.groupId).toBe(GROUP_HEX);
    expect(t.leftAt).toBeGreaterThanOrEqual(before);
    expect(t.leftAt).toBeLessThanOrEqual(Date.now());
  });

  it('ignores malformed rows (and rows whose key does not match their groupId)', async () => {
    const raw = createStore('few-left-groups', 'tombstones');
    await set('x1', null, raw);
    await set('x2', { groupId: 'x2' }, raw);
    await set('x3', { groupId: 'x3', leftAt: 'yesterday' }, raw);
    await set('x4', { groupId: 'other', leftAt: 1 }, raw);
    await set('x5', 'x5', raw);
    await putLeftGroupTombstone(GROUP_HEX, 7);

    expect(await listLeftGroupTombstones()).toEqual([{ groupId: GROUP_HEX, leftAt: 7 }]);
  });

  it('clearAllLeftGroupTombstones empties the store', async () => {
    await putLeftGroupTombstone(GROUP_HEX);
    await clearAllLeftGroupTombstones();
    expect(await listLeftGroupTombstones()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// destroyLeftGroupState (the leave chain's destroy) and the startup sweep
// ---------------------------------------------------------------------------

describe('destroyLeftGroupState', () => {
  it('MLS state, no overlay → destroys it', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    expect(await destroyLeftGroupState(GROUP_HEX, client as never)).toBe('destroyed');
    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(mls.has(GROUP_HEX)).toBe(false);
  });

  it('overlay present (re-joined meanwhile) → never destroys', async () => {
    const client = makeClient(new Set([GROUP_HEX]));
    await saveGroup(overlay());
    expect(await destroyLeftGroupState(GROUP_HEX, client as never)).toBe('rejoined');
    expect(client.groups.destroy).not.toHaveBeenCalled();
  });

  it('no MLS state → nothing to destroy', async () => {
    const client = makeClient(new Set());
    expect(await destroyLeftGroupState(GROUP_HEX, client as never)).toBe('absent');
    expect(client.groups.destroy).not.toHaveBeenCalled();
  });
});

describe('startup sweep (loadGroupsAndReconcileInvitations)', () => {
  it('no tombstone → MLS-only state is left untouched (interrupted create / in-flight accept)', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);

    await loadGroupsAndReconcileInvitations(client as never);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(mls.has(GROUP_HEX)).toBe(true);
  });

  it('tombstone + overlay → MLS state untouched; the stale tombstone is dropped so the live group is backed up again', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    await saveGroup(overlay());
    await putLeftGroupTombstone(GROUP_HEX);

    await loadGroupsAndReconcileInvitations(client as never);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(mls.has(GROUP_HEX)).toBe(true);
    expect(await loadGroup(GROUP_HEX)).toEqual(overlay());
    expect(await listLeftGroupTombstones()).toEqual([]);
  });

  it('tombstone + MLS state + no overlay → destroyed after loadAll and before invitation reconciliation; tombstone dropped', async () => {
    const mls = new Set([GROUP_HEX, OTHER_HEX]);
    const client = makeClient(mls);
    await saveGroup(overlay(OTHER_HEX));
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry({ id: 'joined-other', groupId: OTHER_HEX }));

    await loadGroupsAndReconcileInvitations(client as never);

    expect(client.groups.destroy).toHaveBeenCalledTimes(1);
    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(mls).toEqual(new Set([OTHER_HEX]));
    expect(await listLeftGroupTombstones()).toEqual([]);
    const o = client.order;
    expect(o.indexOf('loadAll')).toBeLessThan(o.indexOf(`destroy:${GROUP_HEX}`));
    // Reconciliation (has(OTHER_HEX) for the pending invitation) runs after the sweep.
    expect(o.indexOf(`destroy:${GROUP_HEX}`)).toBeLessThan(o.lastIndexOf(`has:${OTHER_HEX}`));
    expect(listPendingInvitations()).toEqual([]);
  });

  it('tombstone without any MLS state → nothing destroyed, tombstone dropped', async () => {
    const client = makeClient(new Set());
    await putLeftGroupTombstone(GROUP_HEX);

    await loadGroupsAndReconcileInvitations(client as never);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(await listLeftGroupTombstones()).toEqual([]);
  });

  it('a failing destroy keeps that tombstone (retried next start), continues with the others, and startup still reconciles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mls = new Set([GROUP_HEX, OTHER_HEX]);
    const client = makeClient(mls);
    client.groups.destroy.mockImplementation(async (id: string) => {
      client.order.push(`destroy:${id}`);
      if (id === GROUP_HEX) throw new Error('idb failure');
      mls.delete(id);
    });
    await putLeftGroupTombstone(GROUP_HEX);
    await putLeftGroupTombstone(OTHER_HEX);

    await expect(loadGroupsAndReconcileInvitations(client as never)).resolves.toBeUndefined();

    expect(mls).toEqual(new Set([GROUP_HEX]));
    expect(await listLeftGroupTombstones()).toEqual([expect.objectContaining({ groupId: GROUP_HEX })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left-group sweep'), expect.any(Error));
    warn.mockRestore();
  });

  it('a failing MLS-state lookup for one tombstone never blocks startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient(new Set([GROUP_HEX]));
    client.groups.has.mockRejectedValueOnce(new Error('boom'));
    await putLeftGroupTombstone(GROUP_HEX);

    await expect(loadGroupsAndReconcileInvitations(client as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skipped entirely when groups.loadAll() fails (local state in doubt)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient(new Set([GROUP_HEX]));
    client.groups.loadAll.mockRejectedValue(new Error('corrupt'));
    await putLeftGroupTombstone(GROUP_HEX);

    await loadGroupsAndReconcileInvitations(client as never);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(await listLeftGroupTombstones()).toHaveLength(1);
    warn.mockRestore();
  });

  it('a failing tombstone listing never blocks startup: invitation reconciliation still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listTombstonesOverride.fn = async () => { throw new Error('idb read failed'); };
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'joined', groupId: GROUP_HEX }));
    const client = makeClient(new Set([GROUP_HEX]));

    await expect(loadGroupsAndReconcileInvitations(client as never)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left-group sweep failed'), expect.any(Error));
    expect(listPendingInvitations()).toEqual([]);
    warn.mockRestore();
  });

  it('runs under the per-group join lock: an accept paused between MLS save and saveGroup is NOT destroyed by a concurrent sweep', async () => {
    // A leave's tombstone is still present when a re-invite is accepted; the
    // join has persisted MLS state but not yet the overlay. Without the lock
    // the sweep would see "tombstone + MLS state + no overlay" and destroy the
    // live join.
    const mls = new Set<string>();
    const client = makeClient(mls);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const joinStarted = new Promise<void>((r) => { started = r; });
    client.joinGroupFromWelcome.mockImplementation(async () => {
      client.order.push('join');
      mls.add(GROUP_HEX);
      started();
      await gate;
      return { group: { idStr: GROUP_HEX, groupData: { name: 'Joined Name' }, relays: ['wss://r.example'], state: {} } };
    });
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());

    const accept = acceptPendingInvitation('inv-1', client as never, vi.fn());
    await joinStarted;
    const sweep = sweepLeftGroups(client as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.groups.destroy).not.toHaveBeenCalled();
    release();
    await accept;
    await sweep;

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(mls.has(GROUP_HEX)).toBe(true);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });
});

// ---------------------------------------------------------------------------
// joinIdempotent: orphan destroy drops the tombstone
// ---------------------------------------------------------------------------

describe('re-join after leave (joinIdempotent orphan branch)', () => {
  it('orphan MLS state + tombstone → destroy, tombstone dropped, then a normal join', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(client.order.indexOf(`destroy:${GROUP_HEX}`)).toBeLessThan(client.order.indexOf('join'));
    expect(await listLeftGroupTombstones()).toEqual([]);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });

  it('leave destroy succeeded but its tombstone delete failed → a later re-accept (no MLS state left) drops the tombstone, and the backup carries the rejoined group\'s state', async () => {
    // State after the leave chain: MLS state destroyed, tombstone still there.
    const mls = new Set<string>();
    const client = makeClient(mls);
    client.joinGroupFromWelcome.mockImplementation(async () => {
      client.order.push('join');
      mls.add(GROUP_HEX);
      await new IdbGroupStateBackend().setItem(GROUP_HEX, new Uint8Array([9, 9]) as never);
      return { group: { idStr: GROUP_HEX, groupData: { name: 'Joined Name' }, relays: ['wss://r.example'], state: {} } };
    });
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(await listLeftGroupTombstones()).toEqual([]);
    const payload = await collectBackupPayload();
    expect(Object.keys(payload.groupStates)).toContain(GROUP_HEX);
    await new IdbGroupStateBackend().removeItem(GROUP_HEX);
  });

  it('accepting a group that is already joined also drops a stale tombstone', async () => {
    const client = makeClient(new Set([GROUP_HEX]));
    await saveGroup(overlay());
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(await listLeftGroupTombstones()).toEqual([]);
  });

  it('a failed join keeps the tombstone (the sweep still owns it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient(new Set());
    client.joinGroupFromWelcome.mockRejectedValue(new Error('stale welcome'));
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).rejects.toThrow();
    expect(await listLeftGroupIds()).toEqual(new Set([GROUP_HEX]));
    warn.mockRestore();
  });

  it('a delayed leave-chain destroy arriving after the re-join leaves the new group alone', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    await putLeftGroupTombstone(GROUP_HEX);
    enqueuePendingInvitation(makeEntry());
    await acceptPendingInvitation('inv-1', client as never, vi.fn());
    client.groups.destroy.mockClear();

    expect(await destroyLeftGroupState(GROUP_HEX, client as never)).toBe('rejoined');
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(mls.has(GROUP_HEX)).toBe(true);
  });

  it('a tombstone delete failure after the orphan destroy does not fail the accept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deleteTombstoneOverride.fn = async () => { throw new Error('idb failure'); };
    const client = makeClient(new Set([GROUP_HEX]));
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).resolves.toBeUndefined();
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tombstone'), expect.any(Error));
    deleteTombstoneOverride.fn = null;
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Finding poll-pending-queues-recreated-after-purge: a leave's poll purge mark
// blocks the group's early poll queues until the group is joined again.
// ---------------------------------------------------------------------------

describe('re-join releases the poll purge mark', () => {
  const earlyVote = { groupId: GROUP_HEX, pollId: 'p', voterPubkey: OTHER_HEX, responses: ['A'], votedAt: 1, seq: 1 };

  it.each([
    ['a fresh join', () => new Set<string>()],
    ['the orphan-state re-join', () => new Set([GROUP_HEX])],
  ])('%s: early votes of the group are held again', async (_l, mls) => {
    const polls = await import('@/src/lib/marmot/pollPersistence');
    await polls.clearAllPollData();
    await polls.clearPollData(GROUP_HEX); // the leave purge
    expect(await polls.queuePendingVote(earlyVote)).toBe(false);
    enqueuePendingInvitation(makeEntry());
    await acceptPendingInvitation('inv-1', makeClient(mls()) as never, vi.fn());
    expect(await polls.queuePendingVote(earlyVote)).toBe(true);
    expect(await polls.loadPendingVotes(GROUP_HEX, 'p')).toHaveLength(1);
  });

  it('accepting an already-joined group releases it too; a failed join does not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const polls = await import('@/src/lib/marmot/pollPersistence');
    await polls.clearAllPollData();
    await polls.clearPollData(GROUP_HEX);
    const failing = makeClient(new Set());
    failing.joinGroupFromWelcome.mockRejectedValue(new Error('stale welcome'));
    enqueuePendingInvitation(makeEntry());
    await expect(acceptPendingInvitation('inv-1', failing as never, vi.fn())).rejects.toThrow();
    expect(await polls.queuePendingVote(earlyVote)).toBe(false);

    await saveGroup(overlay());
    enqueuePendingInvitation(makeEntry({ id: 'inv-2' }));
    await acceptPendingInvitation('inv-2', makeClient(new Set([GROUP_HEX])) as never, vi.fn());
    expect(await polls.queuePendingVote(earlyVote)).toBe(true);
    warn.mockRestore();
  });
});

describe('re-join releases the poll purge mark: one choke point for every join', () => {
  it('the Welcome without a resolvable pre-join group id (join-request auto-accept path) releases the mark by the joined group\'s id', async () => {
    const polls = await import('@/src/lib/marmot/pollPersistence');
    await polls.clearAllPollData();
    await polls.clearPollData(GROUP_HEX);
    const vote = { groupId: GROUP_HEX, pollId: 'p', voterPubkey: OTHER_HEX, responses: ['A'], votedAt: 1, seq: 1 };
    expect(await polls.queuePendingVote(vote)).toBe(false);
    // No groupId on the entry and no readable pre-join data → joinAndPersist directly.
    enqueuePendingInvitation(makeEntry({ groupId: '' as never }));
    await acceptPendingInvitation('inv-1', makeClient(new Set()) as never, vi.fn());
    expect(await polls.queuePendingVote(vote)).toBe(true);
  });
});
