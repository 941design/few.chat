/**
 * S11 — decline durability behaviour (AC-DECL-1 a/b/c/d, AC-DECL-2, AC-DEL-2) with the REAL idb-keyval marker store
 * (fake-indexeddb), the real S6 GroupOpQueue and the real client job queue; only the library group is a hand-rolled
 * fake (its call order is what is asserted). The library-level run is declineDurability.harness.test.ts.
 */
import 'fake-indexeddb/auto';
import { createStore, set } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobQueue, type JobQueue } from '@/src/lib/marmot/client';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import {
  clearAllPendingDirectInvites,
  clearPendingDirectInvite,
  clearPendingDirectInviteIfRef,
  clearPendingDirectInvitesForGroup,
  createSponsorDeclineMarkerStore,
  getPendingDirectInviteMarker,
  loadOrphanDeclines,
  ORPHAN_MAX,
  ORPHAN_TTL_MS,
  recordOrphanDecline,
  setPendingDirectInvitePhase,
  markerKey,
  pendingDirectInviteMarkerStore,
  recordPendingDirectInvite,
} from '@/src/lib/marmot/pendingDirectInviteStorage';
import {
  buildDeclinedAnnouncementContent,
  createDeclineDurability,
  createKeyPackageInviter,
  declinedDedupId,
  DEFAULT_RETRY_DELAYS_MS,
  DECLINED_MARKER_MAX_AGE_MS,
  createMarkerRecordingInviter,
  type DeclineDurabilityDeps,
  type DeclineGroup,
  type InviteGroup,
} from '@/src/lib/marmot/invitations';
import { parseStructured } from '@/src/lib/marmot/parseStructured';

const G1 = 'aa'.repeat(32);
const G2 = 'bb'.repeat(32);
const BOB = 'cd'.repeat(32);
const CAROL = 'ef'.repeat(32);
const raw = createStore('few-pending-invite-markers', 'markers');

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeGroup extends DeclineGroup {
  members: Set<string>;
  /** account -> leaf signature keys it holds. */
  leafMap: Map<string, string[]>;
  removeCalls: string[];
  removeLeafCalls: string[];
  syncCalls: number;
  syncedGate?: Deferred;
  removeGate?: Deferred;
  removeError?: unknown;
  /** The removal lands (the leaves go) and then never resolves: a process that died mid-commit. */
  hangAfterRemoving?: boolean;
  addLeaf: (account: string, leafKey: string) => void;
}
/** Every member holds one leaf `leaf-<first byte>`; `removeLeaf` is only on the handle when `withRemoveLeaf`. */
function fakeGroup(id: string, members: string[], log: string[] = [], withRemoveLeaf = false): FakeGroup {
  const g: FakeGroup = {
    id,
    members: new Set(members),
    leafMap: new Map(members.map((m) => [m, [`leaf-${m.slice(0, 2)}`]])),
    removeCalls: [],
    removeLeafCalls: [],
    syncCalls: 0,
    synced: () => (g.syncCalls++, g.syncedGate ? g.syncedGate.promise : Promise.resolve()),
    leaves: (account: string) => (g.leafMap.get(account) ?? []).map((leafKey, leafIndex) => ({ leafIndex, leafKey })) as never,
    removeMember: async (account: string) => {
      g.removeCalls.push(account);
      log.push(`removeMember:${account.slice(0, 2)}`);
      if (g.removeGate) await g.removeGate.promise;
      if (g.removeError) throw g.removeError;
      g.members.delete(account);
      g.leafMap.delete(account);
      if (g.hangAfterRemoving) await new Promise(() => undefined);
      log.push('removeMember:resolved');
    },
    addLeaf: (account: string, leafKey: string) => {
      g.members.add(account);
      g.leafMap.set(account, [...(g.leafMap.get(account) ?? []), leafKey]);
    },
  } as FakeGroup;
  if (withRemoveLeaf) {
    g.removeLeaf = async (leafKey: string) => {
      g.removeLeafCalls.push(leafKey);
      log.push(`removeLeaf:${leafKey}`);
      for (const [account, keys] of g.leafMap) {
        const rest = keys.filter((k) => k !== leafKey);
        if (rest.length === 0) {
          g.leafMap.delete(account);
          g.members.delete(account);
        } else g.leafMap.set(account, rest);
      }
    };
  }
  return g;
}

let jobs: JobQueue;
let errors: unknown[];
let announced: Array<{ groupId: string; content: string }>;
let log: string[];
let groups: Map<string, FakeGroup>;

function build(overrides: Partial<DeclineDurabilityDeps> = {}) {
  return createDeclineDurability({
    store: pendingDirectInviteMarkerStore,
    getGroup: async (id) => groups.get(id),
    queue: createGroupOpQueue({ syncTimeoutMs: 5_000 }),
    announce: async (group, content) => {
      announced.push({ groupId: group.id, content });
      log.push('announce');
    },
    enqueue: jobs.enqueue,
    onError: (e) => void errors.push(e),
    ...overrides,
  });
}

beforeEach(async () => {
  await clearAllPendingDirectInvites();
  jobs = createJobQueue({ onError: (e) => void errors.push(e) });
  errors = [];
  announced = [];
  log = [];
  groups = new Map();
});

describe('construction validates every port (no silent degradation)', () => {
  const ok = (): DeclineDurabilityDeps => ({
    store: pendingDirectInviteMarkerStore,
    getGroup: async () => undefined,
    queue: createGroupOpQueue(),
    announce: async () => undefined,
    enqueue: () => undefined,
  });
  it.each(['getGroup', 'announce', 'enqueue', 'queue', 'store'] as const)('a missing %s throws at construction', (name) => {
    const deps = { ...ok() } as Record<string, unknown>;
    delete deps[name];
    expect(() => createDeclineDurability(deps as unknown as DeclineDurabilityDeps)).toThrow(TypeError);
  });
  it('a store without a method, a queue without runCommit and a bad timeout throw', () => {
    expect(() => createDeclineDurability({ ...ok(), store: { ...pendingDirectInviteMarkerStore, markDeclined: undefined } as never })).toThrow(/store\.markDeclined/);
    expect(() => createDeclineDurability({ ...ok(), queue: {} as never })).toThrow(/queue\.runCommit/);
    expect(() => createDeclineDurability({ ...ok(), syncTimeoutMs: 0 })).toThrow(TypeError);
    expect(() => createDeclineDurability(undefined as never)).toThrow(TypeError);
  });
  it('the marker-recording inviter validates its ports too', () => {
    expect(() => createMarkerRecordingInviter({ onRecordedDeclined: () => undefined, inviter: {} as never, store: { record: async () => ({}) as never } })).toThrow(/inviter\.inviteByPubkey/);
    expect(() => createMarkerRecordingInviter({ onRecordedDeclined: () => undefined, inviter: { inviteByPubkey: async () => ({ error: 'already-member' }) }, store: {} as never })).toThrow(/store\.record/);
  });
});

describe('AC-DECL-1 (a): a decline while the group is unsynced removes only after synced() resolves', () => {
  it('marks declined durably at once, removes only after synced, then clears and announces once', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();

    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    // listener frame: nothing was awaited, no client call was made
    expect(group.removeCalls).toEqual([]);
    // durable BEFORE any removal work: the marker is declined while the group has not synced
    await expect.poll(async () => (await getPendingDirectInviteMarker(G1, BOB))?.declined, { timeout: 2000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(group.removeCalls).toEqual([]); // still waiting for synced()
    expect(announced).toEqual([]);

    group.syncedGate.resolve();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(announced).toEqual([{ groupId: G1, content: buildDeclinedAnnouncementContent(BOB, declinedDedupId(G1, 'ref-bob')) }]);
    expect(log).toEqual(['removeMember:cd', 'removeMember:resolved', 'announce']);
    expect(errors).toEqual([]);
  });

  it('the removal is not in the listener frame: the listener returns synchronously and the job runs in a later macrotask', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    let enqueued = 0;
    let job: (() => Promise<void>) | undefined;
    const durability = build({ enqueue: (j) => void ((job = j), enqueued++) });
    const result: unknown = durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    expect(result).toBeUndefined();
    expect(enqueued).toBe(1); // the listener's last action
    expect(group.removeCalls).toEqual([]);
    await job!();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
  });

  it('a slow removal never holds the client job queue (the job returns while the removal waits for synced)', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle(); // resolves although synced() never did
    expect(group.removeCalls).toEqual([]);
    group.syncedGate.resolve();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
  });

  it('the announcement waits for removeMember to RESOLVE (a pending removeMember sends nothing, the marker stays declined)', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await expect.poll(() => group.removeCalls.length, { timeout: 2000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(announced).toEqual([]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    group.removeGate.resolve();
    await durability.idle();
    expect(announced).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });
});

describe('AC-DECL-1 (b): startup retry replays every declined marker', () => {
  it('a marker left declined in idb (process restarted) is removed by the startup retry; non-declined, legacy and other markers are left alone', async () => {
    const g1 = fakeGroup(G1, [CAROL, BOB], log);
    const g2 = fakeGroup(G2, [CAROL, BOB], log);
    groups.set(G1, g1);
    groups.set(G2, g2);
    // seeded out of key order; G2 first
    await recordPendingDirectInvite(G2, BOB, 'ref-bob-2', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G2, 'ref-bob-2');
    await recordPendingDirectInvite(G1, CAROL, 'ref-carol', `leaf-${CAROL.slice(0, 2)}`); // invited, not declined
    await recordPendingDirectInvite(G1, BOB, 'ref-bob-1', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob-1');
    await set(markerKey(G2, CAROL), true, raw); // legacy bare true
    await set(markerKey(G1, '77'.repeat(32)), { pubkey: '77'.repeat(32), declined: true }, raw); // legacy: no inviteeRef

    const restarted = build(); // a fresh instance: nothing in memory
    restarted.startupRetry();
    await jobs.idle();
    await restarted.idle();

    expect(g1.removeCalls).toEqual([BOB]);
    expect(g2.removeCalls).toEqual([BOB]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await getPendingDirectInviteMarker(G2, BOB)).toBeUndefined();
    expect((await getPendingDirectInviteMarker(G1, CAROL))?.declined).toBe(false); // untouched
    expect(announced.map((a) => a.groupId).sort()).toEqual([G1, G2].sort());
    expect(errors).toEqual([]);
  });

  it('is idempotent: a second retry (and a retry racing a live decline) removes and announces once', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' }); // a duplicate event
    durability.startupRetry();
    await jobs.idle();
    await durability.idle();
    expect(await durability.retryDeclined()).toEqual([]); // nothing declined is left
    durability.startupRetry();
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect(announced).toHaveLength(1);
  });

  it('a lost marker clear (crash after removeMember) is replayed as already-removed: no second Remove, no second announcement', async () => {
    const group = fakeGroup(G1, [CAROL], log); // Bob is already gone from the member list
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    const durability = build();
    expect(await durability.retryDeclined()).toEqual(['already-removed']);
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });

  it('a group that is not loaded keeps the marker declined for the next attempt', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    const durability = build();
    expect(await durability.retryDeclined()).toEqual(['group-missing']);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    expect(announced).toEqual([]);
  });
});

describe('AC-DECL-1 (c): removeMember rejects', () => {
  it('keeps the marker declined, sends no announcement, reports the error, and the next retry succeeds', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = new Error('commit failed');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    expect(announced).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('commit failed');

    group.removeError = undefined; // the next startup
    expect(await build().retryDeclined()).toEqual(['removed']);
    expect(group.removeCalls).toEqual([BOB, BOB]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(announced).toHaveLength(1);
  });

  it('a group that never syncs (bounded wait lost) keeps the marker declined and never calls removeMember', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build({ syncTimeoutMs: 40 });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: string }).code).toBe('not-synced');
    expect(announced).toEqual([]);
  });

  it('dispose aborts a removal still waiting for synced(): the marker stays declined', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    durability.dispose();
    await durability.idle();
    group.syncedGate.resolve();
    expect(group.removeCalls).toEqual([]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' }); // after dispose: ignored
    expect(await durability.retryDeclined()).toEqual([]);
  });
});

describe('AC-DECL-1 (d): success', () => {
  it('clears the marker and sends exactly one announcement, a parseable declined lifecycle post carrying only the pubkey and the dedup id', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(announced).toHaveLength(1);
    expect(JSON.parse(announced[0].content)).toEqual({ type: 'invite_lifecycle', event: 'declined', pubkey: BOB, id: `${G1}:ref-bob` });
    expect(parseStructured(announced[0].content)).toEqual({ type: 'invite_lifecycle', event: 'declined', pubkey: BOB, id: `${G1}:ref-bob` });
    expect(log).toEqual(['removeMember:cd', 'removeMember:resolved', 'announce']);
  });

  it('a failing announcement is reported and retried WITHOUT a second Remove: the marker stays announce-pending, the replay announces with the same dedup id', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    let failing = true;
    const sent: string[] = [];
    const durability = build({
      retryDelaysMs: [],
      announce: async (_g, content) => {
        if (failing) throw new Error('send failed');
        sent.push(content);
      },
    });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.phase).toBe('announce-pending');
    expect(errors.map((e) => (e as Error).message)).toEqual(['send failed']);
    failing = false;
    expect(await durability.retryDeclined()).toEqual(['removed']);
    expect(group.removeCalls).toEqual([BOB]); // no second Remove
    expect(sent).toEqual([buildDeclinedAnnouncementContent(BOB, declinedDedupId(G1, 'ref-bob'))]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await durability.retryDeclined()).toEqual([]);
  });

  it('replays a failed announcement after a re-invite and restart, leaving the new invite intact', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-old', 'leaf-cd');
    const failNotice = vi.fn(async () => { throw new Error('send failed'); });
    const first = build({ announce: failNotice, retryDelaysMs: [] });
    await decline(first, G1, 'ref-old');
    expect(group.removeCalls).toEqual([BOB]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.phase).toBe('announce-pending');
    expect(errors.map((e) => (e as Error).message)).toEqual(['send failed']);

    group.addLeaf(BOB, 'leaf-new');
    const newMarker = await recordPendingDirectInvite(G1, BOB, 'ref-new', 'leaf-new');
    first.dispose();
    const restarted = build();
    restarted.startupRetry();
    await jobs.idle();
    await restarted.idle();

    const content = buildDeclinedAnnouncementContent(BOB, declinedDedupId(G1, 'ref-old'));
    expect(failNotice).toHaveBeenCalledExactlyOnceWith(group, content);
    expect(announced).toEqual([{ groupId: G1, content }]);
    expect(group.removeCalls).toEqual([BOB]);
    expect(group.leaves(BOB).map((leaf) => leaf.leafKey)).toEqual(['leaf-new']);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual(newMarker);
    expect(await restarted.retryDeclined()).toEqual([]);
    restarted.dispose();
  });

  it('retries the removal only after it persists the removing phase', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref', 'leaf-cd');
    let failPhase = true;
    const durability = build({ store: {
      ...pendingDirectInviteMarkerStore,
      setPhase: async (...args) => {
        if (args[3] === 'removing' && failPhase) throw new Error('removing write failed');
        return pendingDirectInviteMarkerStore.setPhase(...args);
      },
    } });
    await decline(durability, G1, 'ref');
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);

    failPhase = false;
    expect(await durability.retryDeclined()).toEqual(['removed']);
    expect(group.removeCalls).toEqual([BOB]);
    expect(announced).toHaveLength(1);
  });

  it('recovers a removing marker after a failed phase write and a successful queued re-invite', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    const sponsor = createSponsorDeclineMarkerStore(CAROL);
    const queue = createGroupOpQueue();
    await sponsor.record(G1, BOB, 'ref-old', 'leaf-cd');
    const failNotice = vi.fn(async () => { throw new Error('send failed'); });
    const first = build({ queue, retryDelaysMs: [], announce: failNotice, store: {
      ...sponsor,
      setPhase: async (...args) => {
        if (args[3] === 'announce-pending') throw new Error('phase write failed');
        return sponsor.setPhase(...args);
      },
    } });
    await decline(first, G1, 'ref-old');
    expect(group.removeCalls).toEqual([BOB]);
    expect((await sponsor.get(G1, BOB))?.phase).toBe('removing');
    expect(errors.map((error) => (error as Error).message)).toEqual(['phase write failed', 'send failed']);

    const invite: InviteGroup['invite'] = async () => {
      expect(group.leaves(BOB)).toEqual([]);
      group.addLeaf(BOB, 'leaf-new');
      return [{ inviteeRef: 'ref-new', pubkey: BOB, status: 'delivered', relays: [] }];
    };
    const inviter = createMarkerRecordingInviter({
      inviter: createKeyPackageInviter({ queue, lookup: { lookup: async () => ({
        ok: true, candidates: [{ id: 'candidate', content: '' } as never], relays: [],
      }) } }),
      store: sponsor,
      onRecordedDeclined: first.replayMarker,
    });
    expect(await inviter.inviteByPubkey({ ...group, invite }, BOB)).toMatchObject({ outcome: { inviteeRef: 'ref-new' } });
    const newer = await sponsor.get(G1, BOB);
    expect(newer).toMatchObject({ inviteeRef: 'ref-new', sponsorPubkey: CAROL, declined: false });
    first.dispose();

    const restarted = build({ store: sponsor });
    expect(await restarted.retryDeclined()).toEqual(['removed']);
    const content = buildDeclinedAnnouncementContent(BOB, declinedDedupId(G1, 'ref-old'));
    expect(failNotice).toHaveBeenCalledExactlyOnceWith(group, content);
    expect(announced).toEqual([{ groupId: G1, content }]);
    expect(group.removeCalls).toEqual([BOB]);
    expect(group.leaves(BOB).map((leaf) => leaf.leafKey)).toEqual(['leaf-new']);
    expect(await sponsor.get(G1, BOB)).toEqual(newer);
    expect(await restarted.retryDeclined()).toEqual([]);
    restarted.dispose();
  });

  it('a failing marker clear after the announcement is reported; the replay re-sends the SAME announcement (at-least-once, receiver dedups on id), never a second Remove', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const store = { ...pendingDirectInviteMarkerStore, clearAnnouncement: async () => { throw new Error('idb down'); } };
    const durability = build({ store });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(announced).toHaveLength(1);
    expect(errors.map((e) => (e as Error).message)).toEqual(['idb down']);
    expect(await build().retryDeclined()).toEqual(['removed']);
    expect(announced).toHaveLength(2);
    expect(announced[1].content).toBe(announced[0].content); // identical: same dedup id
    expect(group.removeCalls).toEqual([BOB]);
  });
});

describe('AC-DECL-2: an unknown inviteeRef is ignored', () => {
  it('no removeMember, no announcement, no marker change (and nothing thrown) for an unknown ref, another group\'s ref, malformed payloads', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'nobody' });
    durability.onWelcomeDeclined({ groupId: G2, inviteeRef: 'ref-bob' }); // right ref, wrong group
    durability.onWelcomeDeclined({ groupId: '', inviteeRef: 'ref-bob' });
    durability.onWelcomeDeclined(null as never);
    durability.onWelcomeDeclined({ groupId: G1 } as never);
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-bob', pubkey: BOB, declined: false });
    expect((await loadOrphanDeclines()).map((o) => [o.groupId, o.inviteeRef]).sort()).toEqual([[G1, 'nobody'], [G2, 'ref-bob']]);
  });

  it('a hostile inviteeRef that merely resembles a pubkey or key cannot select a marker', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: BOB });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: `${G1}:${BOB}` });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(false);
  });
});

describe('AC-DEL-2: legacy markers are ignored without throwing', () => {
  it('a legacy bare-true marker survives welcomeDeclined and the startup retry untouched; no removeMember', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await set(markerKey(G1, BOB), true, raw);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'anything' });
    durability.startupRetry();
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('orphan')]); // reported, nothing thrown
    expect(await durability.retryDeclined()).toEqual([]);
    expect([...(await import('@/src/lib/marmot/pendingDirectInviteStorage').then((m) => m.loadPendingDirectInviteMarkers(G1)))]).toEqual([BOB]);
  });
});

describe('a failing durable write means no removal', () => {
  it('markDeclined rejecting is reported and removeMember is never called', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    const store = { ...pendingDirectInviteMarkerStore, markDeclined: async () => { throw new Error('quota'); } };
    const durability = build({ store });
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['quota']);
  });
});

describe('invite time: inviteeRef -> pubkey is persisted (AC-DECL-1, AC-DEL-2)', () => {
  const outcome = (inviteeRef: string) => ({ outcome: { inviteeRef, pubkey: BOB, status: 'delivered', relays: [] }, keyPackageEventId: 'k', attempts: 1 }) as never;
  const group = { id: G1 } as never;

  it('records the marker (declined:false, lowercase pubkey) before returning the invite result unchanged', async () => {
    const result = outcome('ref-bob');
    const inviter = createMarkerRecordingInviter({ onRecordedDeclined: () => undefined,
      inviter: { inviteByPubkey: async () => result },
      store: pendingDirectInviteMarkerStore,
    });
    expect(await inviter.inviteByPubkey(group, BOB.toUpperCase())).toBe(result);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-bob', pubkey: BOB, declined: false });
  });

  it('an error value (no usable key package / already-member) records nothing; a throwing invite propagates', async () => {
    const noPkg = { error: 'no usable key package', reason: 'none-found', attempts: 0 } as never;
    const inviter = createMarkerRecordingInviter({ onRecordedDeclined: () => undefined, inviter: { inviteByPubkey: async () => noPkg }, store: pendingDirectInviteMarkerStore });
    expect(await inviter.inviteByPubkey(group, BOB)).toBe(noPkg);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    const boom = createMarkerRecordingInviter({ onRecordedDeclined: () => undefined, inviter: { inviteByPubkey: async () => { throw new Error('not-admin'); } }, store: pendingDirectInviteMarkerStore });
    await expect(boom.inviteByPubkey(group, BOB)).rejects.toThrow('not-admin');
  });

  it('a failing marker write is reported and the committed invite is returned unchanged', async () => {
    const result = outcome('ref-bob');
    const reported: unknown[] = [];
    const inviter = createMarkerRecordingInviter({ onRecordedDeclined: () => undefined,
      inviter: { inviteByPubkey: async () => result },
      store: { record: async () => { throw new Error('quota'); } },
      onError: (e) => void reported.push(e),
    });
    expect(await inviter.inviteByPubkey(group, BOB)).toBe(result);
    expect(reported.map((e) => (e as Error).message)).toEqual(['quota']);
  });
});

// ---------------------------------------------------------------------------
// Remediation: decline bound to the invited LEAF, compare-and-clear, phased marker, backoff, orphans
// ---------------------------------------------------------------------------

/** A decline of `ref` through the listener, settled. */
async function decline(durability: ReturnType<typeof build>, groupId: string, ref: string): Promise<void> {
  durability.onWelcomeDeclined({ groupId, inviteeRef: ref });
  await jobs.idle();
  await durability.idle();
}

describe('the decline is bound to the invited LEAF, not to the account', () => {
  it('the account was re-added through another path after the decline (old leaf gone, new leaf present): nothing removed, no announcement, marker cleared', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    group.addLeaf(BOB, 'leaf-new'); // the re-added leaf; the invited leaf 'leaf-old' no longer exists
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-old');
    const durability = build();
    await decline(durability, G1, 'ref-bob');
    expect(group.removeCalls).toEqual([]);
    expect(group.removeLeafCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(group.leaves(BOB).map((l) => l.leafKey)).toEqual(['leaf-new']);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });

  it('the account holds a second leaf and the handle cannot remove one leaf: nothing removed, marker cleared as superseded and reported', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    group.addLeaf(BOB, 'leaf-old');
    group.addLeaf(BOB, 'leaf-device-2');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-old');
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(group.leaves(BOB)).toHaveLength(2);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('superseded')]);
  });

  it('the outcome of a superseded replay is "superseded"', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    group.addLeaf(BOB, 'leaf-old');
    group.addLeaf(BOB, 'leaf-device-2');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-old');
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    expect(await build().retryDeclined()).toEqual(['superseded']);
  });

  it('a handle that exposes removeLeaf removes ONLY the declined leaf; the other leaf stays; the announcement follows', async () => {
    const group = fakeGroup(G1, [CAROL], log, true);
    group.addLeaf(BOB, 'leaf-old');
    group.addLeaf(BOB, 'leaf-device-2');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-old');
    const durability = build();
    await decline(durability, G1, 'ref-bob');
    expect(group.removeLeafCalls).toEqual(['leaf-old']);
    expect(group.removeCalls).toEqual([]);
    expect(group.leaves(BOB).map((l) => l.leafKey)).toEqual(['leaf-device-2']);
    expect(announced).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });

  it('the declined leaf is the account\'s sole leaf: removeMember', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    group.addLeaf(BOB, 'leaf-old');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-old');
    await decline(build(), G1, 'ref-bob');
    expect(group.removeCalls).toEqual([BOB]);
    expect(group.leaves(BOB)).toEqual([]);
  });

  it('no leaf recorded (ambiguous at invite time): a sole leaf is removed, two leaves are never guessed at', async () => {
    const sole = fakeGroup(G1, [CAROL, BOB], log);
    const two = fakeGroup(G2, [CAROL, BOB], log);
    two.addLeaf(BOB, 'leaf-second');
    groups.set(G1, sole);
    groups.set(G2, two);
    await recordPendingDirectInvite(G1, BOB, 'ref-1', `leaf-${BOB.slice(0, 2)}`);
    await recordPendingDirectInvite(G2, BOB, 'ref-2', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    await decline(durability, G1, 'ref-1');
    await decline(durability, G2, 'ref-2');
    expect(sole.removeCalls).toEqual([BOB]);
    expect(two.removeCalls).toEqual([]);
    expect(two.leaves(BOB)).toHaveLength(2);
  });
});

describe('invite-time leaf binding', () => {
  it('records the selected KeyPackage leaf even when another leaf appears during the invite', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    const inviter = createMarkerRecordingInviter({
      onRecordedDeclined: () => undefined,
      inviter: { inviteByPubkey: async () => {
        group.addLeaf(BOB, 'leaf-welcome');
        group.addLeaf(BOB, 'leaf-other');
        return { outcome: { inviteeRef: 'ref-bob', pubkey: BOB, status: 'delivered', relays: [] }, keyPackageEventId: 'k', invitedLeafKey: 'leaf-welcome', attempts: 1 };
      } },
      store: pendingDirectInviteMarkerStore,
    });
    await inviter.inviteByPubkey(group as never, BOB.toUpperCase());
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-bob', pubkey: BOB, declined: false, leafKey: 'leaf-welcome' });
  });

  it('never removes the account when a persisted marker lacks a leaf binding', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-unbound');
    await decline(build(), G1, 'ref-unbound');
    expect(group.leaves(BOB)).toHaveLength(1);
    expect(group.removeCalls).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });
});

describe('the marker is re-read INSIDE the queued op; the clear is compare-and-clear on the inviteeRef', () => {
  it('replaced by a re-invite (new ref, not declined) while the removal waits for synced(): nothing removed, the new marker intact', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-old', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-old' });
    await expect.poll(() => group.syncCalls, { timeout: 2000 }).toBeGreaterThan(0); // parked on synced(), marker read already
    await recordPendingDirectInvite(G1, BOB, 'ref-new', 'leaf-new'); // a re-invite replaces the marker
    group.syncedGate.resolve();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual({ inviteeRef: 'ref-new', pubkey: BOB, declined: false, leafKey: 'leaf-new' });
  });

  it('overlapping replays join an owed notice moved to its reference during the sync wait', async () => {
    const group = fakeGroup(G1, [CAROL], log); // Bob's leaf is gone, the old marker owes the announcement
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-old', 'leaf-old');
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-old');
    await setPendingDirectInvitePhase(G1, BOB, 'ref-old', 'announce-pending');
    const durability = build();
    const replay = durability.retryDeclined();
    await expect.poll(() => group.syncCalls, { timeout: 2000 }).toBeGreaterThan(0);
    await recordPendingDirectInvite(G1, BOB, 'ref-new', 'leaf-new');
    const overlapping = durability.retryDeclined();
    await expect.poll(async () => (await pendingDirectInviteMarkerStore.listDeclined()).length).toBe(1);
    group.syncedGate.resolve();
    expect(await Promise.all([replay, overlapping])).toEqual([['removed'], ['removed']]);
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([{ groupId: G1, content: buildDeclinedAnnouncementContent(BOB, declinedDedupId(G1, 'ref-old')) }]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual({ inviteeRef: 'ref-new', pubkey: BOB, declined: false, leafKey: 'leaf-new' });
  });

  it.each(['group clear', 'account clear', 'dispose'] as const)('%s stops a queued notice from publishing', async (stop) => {
    const group = fakeGroup(G1, [CAROL], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-old', 'leaf-old');
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-old');
    await setPendingDirectInvitePhase(G1, BOB, 'ref-old', 'announce-pending');
    await recordPendingDirectInvite(G1, BOB, 'ref-new', 'leaf-new');
    const durability = build();
    const replay = durability.retryDeclined();
    await expect.poll(() => group.syncCalls, { timeout: 2000 }).toBeGreaterThan(0);
    if (stop === 'group clear') await clearPendingDirectInvitesForGroup(G1);
    if (stop === 'account clear') await clearAllPendingDirectInvites();
    if (stop === 'dispose') durability.dispose();
    group.syncedGate.resolve();
    await replay;
    expect(announced).toEqual([]);
    expect(group.removeCalls).toEqual([]);
    expect((await pendingDirectInviteMarkerStore.listDeclined()).map(({ marker }) => marker.inviteeRef))
      .toEqual(stop === 'dispose' ? ['ref-old'] : []);
    durability.dispose();
  });

  it('cleared meanwhile (cancel / reset) while the removal waits: nothing removed, nothing announced, nothing resurrected', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.syncedGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await expect.poll(() => group.syncCalls, { timeout: 2000 }).toBeGreaterThan(0);
    await clearPendingDirectInvite(G1, BOB);
    group.syncedGate.resolve();
    await durability.idle();
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });

  it('a re-invite recorded while removeMember is in flight survives the clear after the Remove', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeGate = deferred();
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-old', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-old' });
    await expect.poll(() => group.removeCalls.length, { timeout: 2000 }).toBe(1);
    await recordPendingDirectInvite(G1, BOB, 'ref-new', `leaf-${BOB.slice(0, 2)}`);
    group.removeGate.resolve();
    await durability.idle();
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-new', pubkey: BOB, declined: false });
  });

  it('clearPendingDirectInviteIfRef clears only a record carrying that ref (never a newer, a legacy or an absent marker)', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-1', `leaf-${BOB.slice(0, 2)}`);
    expect(await clearPendingDirectInviteIfRef(G1, BOB, 'ref-other')).toBe(false);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeDefined();
    expect(await clearPendingDirectInviteIfRef(G1, BOB, 'ref-1')).toBe(true);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await clearPendingDirectInviteIfRef(G1, BOB, 'ref-1')).toBe(false);
    await set(markerKey(G1, CAROL), true, raw);
    expect(await clearPendingDirectInviteIfRef(G1, CAROL, 'ref-1')).toBe(false);
  });

  it('setPendingDirectInvitePhase refuses a marker that is not declined or carries another ref', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-1', `leaf-${BOB.slice(0, 2)}`);
    expect(await setPendingDirectInvitePhase(G1, BOB, 'ref-1', 'removing')).toBe(false); // not declined
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-1');
    expect(await setPendingDirectInvitePhase(G1, BOB, 'ref-2', 'removing')).toBe(false);
    expect(await setPendingDirectInvitePhase(G1, BOB, 'ref-1', 'removing')).toBe(true);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.phase).toBe('removing');
  });
});

describe('phased marker: the announcement survives reload / dispose', () => {
  it('the marker is "removing" while removeMember runs and "announce-pending" when the announcement goes out', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    const phases: Array<string | undefined> = [];
    const removeMember = group.removeMember;
    group.removeMember = async (a: string) => {
      phases.push((await getPendingDirectInviteMarker(G1, BOB))?.phase);
      return removeMember(a);
    };
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build({
      announce: async () => void phases.push((await getPendingDirectInviteMarker(G1, BOB))?.phase),
    });
    await decline(durability, G1, 'ref-bob');
    expect(phases).toEqual(['removing', 'announce-pending']);
  });

  it('process dies while removeMember is in flight (the Remove landed): the restarted sponsor announces exactly once and sends no second Remove', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.hangAfterRemoving = true;
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', 'leaf-cd');
    const first = build();
    first.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await expect.poll(() => group.removeCalls.length, { timeout: 2000 }).toBe(1);
    first.dispose(); // reload: the removeMember promise never settles
    expect((await getPendingDirectInviteMarker(G1, BOB))?.phase).toBe('removing');
    expect(announced).toEqual([]);

    const second = build();
    expect(await second.retryDeclined()).toEqual(['removed']);
    expect(group.removeCalls).toEqual([BOB]); // only the first instance's
    expect(announced).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await build().retryDeclined()).toEqual([]);
    expect(announced).toHaveLength(1);
  });

  it('"removing" with the leaf still present (the commit never landed) removes again; "announce-pending" announces without a Remove', async () => {
    const pending = fakeGroup(G1, [CAROL, BOB], log);
    const done = fakeGroup(G2, [CAROL], log);
    groups.set(G1, pending);
    groups.set(G2, done);
    await recordPendingDirectInvite(G1, BOB, 'ref-1', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-1');
    await setPendingDirectInvitePhase(G1, BOB, 'ref-1', 'removing');
    await recordPendingDirectInvite(G2, BOB, 'ref-2', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G2, 'ref-2');
    await setPendingDirectInvitePhase(G2, BOB, 'ref-2', 'announce-pending');
    const outcomes = await build().retryDeclined();
    expect(outcomes.sort()).toEqual(['removed', 'removed']);
    expect(pending.removeCalls).toEqual([BOB]);
    expect(done.removeCalls).toEqual([]);
    expect(announced.map((a) => a.groupId).sort()).toEqual([G1, G2].sort());
    expect(announced.find((a) => a.groupId === G2)?.content).toBe(buildDeclinedAnnouncementContent(BOB, declinedDedupId(G2, 'ref-2')));
  });
});

describe('in-session bounded backoff replay', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => void vi.useRealTimers());
  /** idb (fake-indexeddb) settles on the REAL setImmediate: after a virtual advance, give it real turns to finish. */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 60; i++) await new Promise<void>((r) => setImmediate(r));
  }

  it('a retry-later outcome is replayed after 30 s, 2 min and 10 min without a restart, and stops after the bound', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = new Error('commit failed');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await advance(0); // the first attempt, at t=0
    expect(group.removeCalls).toHaveLength(1);
    // `pos`: virtual ms since the previous attempt settled. Each replay lands `delay` after it (plus the job queue's own setTimeout(0) hop).
    let pos = 0;
    let calls = 1;
    for (const delay of DEFAULT_RETRY_DELAYS_MS) {
      await advance(delay - 2_000 - pos);
      expect(group.removeCalls).toHaveLength(calls); // not yet
      await advance(3_000);
      calls++;
      expect(group.removeCalls).toHaveLength(calls);
      pos = 0; // the attempt settles (idb) after the advance returned: its backoff starts at the current virtual time
    }
    expect(calls).toBe(4);
    await advance(24 * 3_600_000);
    expect(group.removeCalls).toHaveLength(4); // bound reached: no further self-scheduled replay
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    durability.dispose();
  });

  it('the replay succeeds once the removal works again: removed and announced once, no more timers', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = new Error('commit failed');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await advance(0); // the first attempt, at t=0
    group.removeError = undefined;
    await advance(31_000);
    await durability.idle();
    expect(announced).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    await advance(24 * 3_600_000);
    expect(group.removeCalls).toEqual([BOB, BOB]);
    expect(announced).toHaveLength(1);
  });

  it('a group that is not loaded yet is replayed too', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await advance(0); // the first attempt, at t=0
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await advance(31_000);
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect(announced).toHaveLength(1);
  });

  it('dispose cancels the pending replay; retryDeclined is the external trigger (S18: reconnect / sync)', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = new Error('commit failed');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await advance(0); // the first attempt, at t=0
    expect(await durability.retryDeclined()).toEqual(['retry-later']);
    expect(group.removeCalls).toHaveLength(2);
    durability.dispose();
    await advance(24 * 3_600_000);
    expect(group.removeCalls).toHaveLength(2);
  });
});

describe('orphan declines', () => {
  it('a decline that arrives while the invite runs (before its record lands) is kept; when the record lands the removal happens exactly once', async () => {
    const group = fakeGroup(G1, [CAROL], log);
    groups.set(G1, group);
    const durability = build();
    const inviter = createMarkerRecordingInviter({
      inviter: {
        inviteByPubkey: async () => {
          group.addLeaf(BOB, 'leaf-bob');
          durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' }); // no marker yet: the invite has not returned
          await jobs.idle();
          await durability.idle();
          expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('orphan')]);
          expect((await loadOrphanDeclines()).map((o) => [o.groupId, o.inviteeRef])).toEqual([[G1, 'ref-bob']]);
          expect(group.removeCalls).toEqual([]);
          return { outcome: { inviteeRef: 'ref-bob', pubkey: BOB, status: 'delivered', relays: [] }, keyPackageEventId: 'k', invitedLeafKey: 'leaf-bob', attempts: 1 } as never;
        },
      },
      store: pendingDirectInviteMarkerStore,
      onRecordedDeclined: durability.replayMarker,
      onError: (e) => void errors.push(e),
    });
    await inviter.inviteByPubkey(group as never, BOB);
    await jobs.idle();
    await durability.idle();
    expect(group.removeCalls).toEqual([BOB]);
    expect(announced).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await loadOrphanDeclines()).toEqual([]); // consumed
  });

  it('a record of a different ref does not consume the orphan; the orphan expires after 7 days and is then not adopted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await recordOrphanDecline(G1, 'ref-bob');
      expect((await recordPendingDirectInvite(G1, BOB, 'ref-other', `leaf-${BOB.slice(0, 2)}`)).declined).toBe(false);
      expect(await loadOrphanDeclines()).toHaveLength(1);
      vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + ORPHAN_TTL_MS + 1000));
      expect(await loadOrphanDeclines()).toEqual([]);
      expect((await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`)).declined).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is bounded: only the newest ORPHAN_MAX orphans are kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < ORPHAN_MAX + 5; i++) {
        vi.setSystemTime(new Date(1_800_000_000_000 + i * 1000));
        await recordOrphanDecline(G1, `ref-${i}`);
      }
      const kept = (await loadOrphanDeclines()).map((o) => o.inviteeRef);
      expect(kept).toHaveLength(ORPHAN_MAX);
      expect(kept[0]).toBe('ref-5');
      expect(kept[kept.length - 1]).toBe(`ref-${ORPHAN_MAX + 4}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('a second record for the same account is serialized after the first', async () => {
  const first = recordPendingDirectInvite(G1, BOB, 'ref-first', `leaf-${BOB.slice(0, 2)}`);
  const second = recordPendingDirectInvite(G1, BOB, 'ref-second', `leaf-${BOB.slice(0, 2)}`);
  await Promise.all([first, second]);
  expect((await getPendingDirectInviteMarker(G1, BOB))?.inviteeRef).toBe('ref-second');
});

describe('the same pubkey invited to two groups: a decline in one leaves the other untouched (full path)', () => {
  it('removes Bob from G1 only; G2 keeps the member and the not-declined marker', async () => {
    const g1 = fakeGroup(G1, [CAROL, BOB], log);
    const g2 = fakeGroup(G2, [CAROL, BOB], log);
    groups.set(G1, g1);
    groups.set(G2, g2);
    // the very same ref in both groups: only the (group, ref) pair selects the marker
    await recordPendingDirectInvite(G1, BOB, 'shared-ref', 'leaf-cd');
    await recordPendingDirectInvite(G2, BOB, 'shared-ref', 'leaf-cd');
    const durability = build();
    await decline(durability, G1, 'shared-ref');
    expect(g1.removeCalls).toEqual([BOB]);
    expect(g2.removeCalls).toEqual([]);
    expect(g2.members.has(BOB)).toBe(true);
    expect(announced.map((a) => a.groupId)).toEqual([G1]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await getPendingDirectInviteMarker(G2, BOB)).toEqual({ inviteeRef: 'shared-ref', pubkey: BOB, declined: false, leafKey: 'leaf-cd' });
    expect(await durability.retryDeclined()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Remediation 2: stale orphans, terminal removal errors, marker max age, required handler, invalid phase
// ---------------------------------------------------------------------------

describe('stale orphan adoption: only a decline that arrived since THIS invite began is adopted', () => {
  const okResult = (ref: string) => ({ outcome: { inviteeRef: ref, pubkey: BOB, status: 'delivered', relays: [] }, keyPackageEventId: 'k', attempts: 1 }) as never;
  afterEach(() => void vi.useRealTimers());

  it('an orphan older than the invite is not adopted and is dropped: the fresh invite stays not-declined, no replay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await recordOrphanDecline(G1, 'ref-bob'); // a decline of an EARLIER invite that carried the same ref
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    const recorded: string[] = [];
    const inviter = createMarkerRecordingInviter({
      inviter: { inviteByPubkey: async () => okResult('ref-bob') },
      store: pendingDirectInviteMarkerStore,
      onRecordedDeclined: (g, p) => void recorded.push(`${g}:${p}`),
      onError: (e) => void errors.push(e),
    });
    await inviter.inviteByPubkey({ id: G1 } as never, BOB);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-bob', pubkey: BOB, declined: false });
    expect(recorded).toEqual([]);
    expect(await loadOrphanDeclines()).toEqual([]);
  });

  it('an orphan that arrived after invitedAt (injected clock) is adopted; the invite clock is read before the invite runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const t = Date.now();
    const recorded: string[] = [];
    const inviter = createMarkerRecordingInviter({
      inviter: { inviteByPubkey: async () => (await recordOrphanDecline(G1, 'ref-bob'), okResult('ref-bob')) },
      store: pendingDirectInviteMarkerStore,
      onRecordedDeclined: (g, p) => void recorded.push(`${g}:${p}`),
      now: () => t - 1_000, // invitedAt strictly before the orphan's arrival
    });
    await inviter.inviteByPubkey({ id: G1 } as never, BOB);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
    expect(recorded).toEqual([`${G1}:${BOB}`]);
  });

  it('the store: invitedAt after the orphan -> not adopted (orphan dropped); at or before it -> adopted; absent -> adopted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const t = Date.now();
    await recordOrphanDecline(G1, 'r1');
    expect((await recordPendingDirectInvite(G1, BOB, 'r1', undefined, t + 1)).declined).toBe(false);
    expect(await loadOrphanDeclines()).toEqual([]);
    await recordOrphanDecline(G1, 'r2');
    expect((await recordPendingDirectInvite(G1, BOB, 'r2', undefined, t)).declined).toBe(true);
    await recordOrphanDecline(G1, 'r3');
    expect((await recordPendingDirectInvite(G1, CAROL, 'r3', `leaf-${CAROL.slice(0, 2)}`)).declined).toBe(true);
  });
});

describe('terminal removal errors: cleared, reported once, never retried', () => {
  const coded = (code: string, details?: Record<string, unknown>) => Object.assign(new Error(`library ${code}`), { code, details });
  afterEach(() => void vi.useRealTimers());

  it.each([
    ['not-a-member', coded('not-a-member')],
    ['not-a-member (disbanded)', coded('not-a-member', { reason: 'disbanded' })],
    ['invalid-options / not-admin', coded('invalid-options', { reason: 'not-admin' })],
    ['plain not-admin code', coded('not-admin')],
    ['group-disbanded reason', coded('send-rejected', { reason: 'group-disbanded' })],
    ['abandoned reason', coded('commit-pending', { reason: 'abandoned' })],
  ])('%s -> terminal: marker cleared, one report, no announcement', async (_name, error) => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = error;
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    const durability = build();
    expect(await durability.retryDeclined()).toEqual(['terminal']);
    expect(errors).toEqual([error]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await durability.retryDeclined()).toEqual([]); // nothing owed any more
    expect(group.removeCalls).toEqual([BOB]);
  });

  it.each([
    ['commit-pending', coded('commit-pending', { reason: 'awaiting-sync' })],
    ['publish-failed', coded('publish-failed')],
    ['a plain error', new Error('boom')],
    ['a non-object', 'nope'],
  ])('%s stays retry-later with the marker kept', async (_name, error) => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = error;
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    expect(await build({ retryDelaysMs: [] }).retryDeclined()).toEqual(['retry-later']);
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(true);
  });

  it('a terminal outcome schedules no in-session backoff replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const group = fakeGroup(G1, [CAROL, BOB], log);
    group.removeError = coded('not-a-member');
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    const durability = build();
    durability.onWelcomeDeclined({ groupId: G1, inviteeRef: 'ref-bob' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 60; i++) await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(group.removeCalls).toEqual([BOB]);
    expect(errors).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    durability.dispose();
  });
});

describe('declined markers have a maximum age', () => {
  afterEach(() => void vi.useRealTimers());
  const DAY = 24 * 3_600_000;

  it.each(['marker', 'moved notice'] as const)('a %s declined more than 30 days ago expires on replay', async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    let replacement;
    if (kind === 'moved notice') {
      await setPendingDirectInvitePhase(G1, BOB, 'ref-bob', 'announce-pending');
      vi.setSystemTime(new Date('2026-01-11T00:00:00Z'));
      replacement = await recordPendingDirectInvite(G1, BOB, 'ref-new', 'leaf-new');
    }
    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + 30 * DAY + 1));
    const durability = build();
    expect(await durability.retryDeclined()).toEqual(['expired']);
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('maximum age')]);
    expect(group.removeCalls).toEqual([]);
    expect(announced).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual(replacement);
    expect(await durability.retryDeclined()).toEqual([]);
  });

  it('exactly at the maximum age (and any younger marker) is still replayed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + 30 * DAY));
    expect(await build().retryDeclined()).toEqual(['removed']);
    expect(group.removeCalls).toEqual([BOB]);
    expect(DECLINED_MARKER_MAX_AGE_MS).toBe(30 * DAY);
  });

  it('maxAgeMs and now are injectable and validated; an expired marker of a re-invite (newer ref) is left alone', async () => {
    expect(() => build({ maxAgeMs: 0 })).toThrow(TypeError);
    expect(() => build({ now: 'x' as never })).toThrow(TypeError);
    await recordPendingDirectInvite(G1, BOB, 'ref-bob', `leaf-${BOB.slice(0, 2)}`);
    await pendingDirectInviteMarkerStore.markDeclined(G1, 'ref-bob');
    const durability = build({ maxAgeMs: 10, now: () => Date.now() + 1_000 });
    await recordPendingDirectInvite(G1, BOB, 'ref-new', `leaf-${BOB.slice(0, 2)}`);
    expect(await durability.retryDeclined()).toEqual([]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toMatchObject({ inviteeRef: 'ref-new', declined: false });
  });
});

describe('onRecordedDeclined is required on the marker-recording inviter', () => {
  it('a missing handler throws at construction (an adopted decline would otherwise never be removed)', () => {
    const deps = { inviter: { inviteByPubkey: async () => ({ error: 'already-member' }) as never }, store: { record: async () => ({}) as never } };
    expect(() => createMarkerRecordingInviter(deps as never)).toThrow(/onRecordedDeclined/);
    expect(() => createMarkerRecordingInviter({ ...deps, onRecordedDeclined: 'x' } as never)).toThrow(/onRecordedDeclined/);
    expect(() => createMarkerRecordingInviter({ ...deps, onRecordedDeclined: () => undefined })).not.toThrow();
  });
});

describe('a marker with an unknown phase is invalid: ignored and reported, never coerced to declined', () => {
  it('replay ignores it (no removal) and reports the invalid phase', async () => {
    const group = fakeGroup(G1, [CAROL, BOB], log);
    groups.set(G1, group);
    await set(markerKey(G1, BOB), { inviteeRef: 'ref-bob', pubkey: BOB, declined: true, phase: 'removed' }, raw);
    const durability = build();
    expect(await durability.retryDeclined()).toEqual([]);
    expect(group.removeCalls).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('invalid phase')]);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
  });
});
