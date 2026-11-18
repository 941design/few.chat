// @vitest-environment node
/**
 * Library harness for S13: REAL @941design/marmot clients (Alice, Bob) over createMemoryStorage() and a FakeRelay,
 * bootstrapped by the app's own bootstrapAccountClient. The leaver, the purger, the removal handlers and the
 * disband marker run against the real client handle, the real GroupOpQueue and the real client job queue.
 *
 *  AC-LEAVE-2  Bob leaves: the group is hidden at once, leave() runs in the background through the queue, the library
 *              group is gone from groups.list() within 15 s with the app's REAL timing options (10 s + 5 s), the kind-9
 *              announcement reached Alice, Alice's roster no longer holds Bob, the data purge ran once.
 *  AC-LEAVE-2  OFFLINE leave (relay down): not blocked by synced(); the group disappears from the library (library
 *              options lowered so the test does not wait the real 10 s + 5 s), the announcement soft-failed.
 *  AC-MEM-4(a) Alice removes Bob; Bob's `groupRemoved` event enqueues the purge on the client FIFO; the group is gone
 *              from Bob's library and the data purge ran.
 *  AC-MEM-4(b) the same removal with the event LOST: the startup check over groups.list() finds the group whose
 *              members() lacks Bob and purges it.
 *  AC-MEM-5    a library disband marker (`group.disbanded`, persisted in the group store) is surfaced at startup:
 *              the overlay row is marked disbanded.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend, type ClientOptions, type MarmotGroup } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue, createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import { clearAllPendingDirectInvites } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { createKeyPackageInviter, createKeyPackageLookup, type KeyPackageInviter } from '@/src/lib/marmot/invitations';
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import {
  grantAdmin,
  removeMember,
  renameGroup,
  createDisbandMarker,
  createGroupLeaver,
  createGroupRemovalHandlers,
  createLocalGroupPurger,
  type GroupLeaver,
  type LeavableGroup,
  type OverlayRecord,
} from '@/src/lib/marmot/membership';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
type Backend = ReturnType<typeof createMemoryStorage>;

interface Peer {
  account: AccountClient;
  pubkey: string;
  backend: Backend;
  inviter: KeyPackageInviter;
  /** What the "UI" shows: the group ids currently listed in the app (hide/restore drive it). */
  ui: Set<string>;
  trace: string[];
  removedEvents: Array<{ groupId: string; actor?: string }>;
  leaver: GroupLeaver;
  purges: string[];
  overlay: Map<string, OverlayRecord>;
  removal: ReturnType<typeof createGroupRemovalHandlers>;
  disband: ReturnType<typeof createDisbandMarker>;
  toasts: string[];
  announcements: string[];
  errors: unknown[];
  history: ReturnType<typeof createMemoryHistoryBackend>;
}

const relays: FakeRelay[] = [];
const peers: Peer[] = [];

async function startRelay() {
  const relay = new FakeRelay();
  const url = await relay.start();
  relays.push(relay);
  return { relay, url };
}

interface PeerOptions {
  backend?: Backend;
  clientOptions?: ClientOptions;
  /** The `groupRemoved` event is lost (a crash between the settle and the emit): only the startup check can purge. */
  loseRemovedEvent?: boolean;
  announceTimeoutMs?: number;
  leaveDeadlineMs?: number;
  overlay?: Map<string, OverlayRecord>;
}

async function startPeer(secretHex: string, defaults: string[], opts: PeerOptions = {}): Promise<Peer> {
  const backend = opts.backend ?? createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  let transport: ReturnType<typeof createClientTransport> | undefined;
  const ui = new Set<string>();
  const trace: string[] = [];
  const removedEvents: Peer['removedEvents'] = [];
  const purges: string[] = [];
  const toasts: string[] = [];
  const announcements: string[] = [];
  const errors: unknown[] = [];
  const overlay = opts.overlay ?? new Map<string, OverlayRecord>();
  const history = createMemoryHistoryBackend();
  let removalRef: ReturnType<typeof createGroupRemovalHandlers> | undefined;
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(history, { sweep: async () => undefined, dispose: () => undefined }),
    clientEvents: {
      groupRemoved: (p) => {
        removedEvents.push(p);
        if (!opts.loseRemovedEvent) removalRef?.onGroupRemoved(p);
      },
      inboxDisposition: () => undefined,
      welcomeDeclined: () => undefined,
      intentFailed: () => undefined,
      storeIncompatible: () => undefined,
      groupBranchSwitched: () => undefined,
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => undefined },
    clientOptions: { historyTimeoutMs: 2000, ...opts.clientOptions },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (rs) => (transport = createClientTransport({ relays: rs })),
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const queue = createGroupOpQueue({ syncTimeoutMs: 20_000 });
  const lookup = createKeyPackageLookup({ transport: transport!.transport, defaultRelays: defaults, timeoutMs: 4000, allowLocalAdvertised: true });
  const inviter = createKeyPackageInviter({ lookup, queue });
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  const sender = createGroupRumorSender({ ownPubkey: pubkey, tracker });

  const step = (name: string) => async () => void trace.push(name);
  const purger = createLocalGroupPurger({
    ownPubkey: pubkey,
    getGroup: (id) => account.handle.client.groups.get(id),
    history: { purge: async (id) => void (await history.purge(id)) },
    tracker,
    clearMessages: step('messages'),
    clearMessageEdits: step('message-edits'),
    clearReactions: step('reactions'),
    purgeHeldReactions: step('held-reactions'),
    clearPollData: step('polls'),
    clearGroupMedia: step('media'),
    clearMemberProfiles: step('member-profiles'),
    clearProfileRequestMemos: step('memos'),
    clearUnread: () => void trace.push('unread'),
    clearPendingJoinRequests: step('join-requests'),
    clearInviteLinks: step('invite-links'),
    clearInviteExpiries: () => void trace.push('invite-expiries'),
    clearPendingDirectInvites: step('direct-invites'),
    clearInviteContexts: step('invite-contexts'),
    removeOverlay: async (id) => {
      trace.push('overlay');
      overlay.delete(id);
    },
    onPurged: (id) => {
      purges.push(id);
      ui.delete(id);
    },
    onError: (_id, f) => void errors.push(f),
  });
  removalRef = createGroupRemovalHandlers({ ownPubkey: pubkey, purger, removalSettleMs: 0, enqueue: account.handle.enqueue, onError: (_id, e) => void errors.push(e) });
  const leaver = createGroupLeaver({
    ownPubkey: pubkey,
    getGroup: async (id) => (await account.handle.client.groups.get(id)) as unknown as LeavableGroup | undefined,
    queue,
    purger,
    sendAnnouncement: async (group, kind, content, tags) => {
      announcements.push(content);
      return sender.sendGroupRumor(group as unknown as MarmotGroup, kind, content, tags);
    },
    hideGroup: (id) => {
      trace.push('hide');
      ui.delete(id);
    },
    restoreGroup: (id) => {
      trace.push('restore');
      ui.add(id);
    },
    notifyLeaveFailed: () => void toasts.push('leave-failed'),
    notifyLastAdminBlocked: () => void toasts.push('last-admin'),
    pendingView: { scheduleRefresh: () => void trace.push('pending-view-refresh') },
    ownName: () => 'Bea',
    ...(opts.announceTimeoutMs ? { announceTimeoutMs: opts.announceTimeoutMs } : {}),
    ...(opts.leaveDeadlineMs ? { leaveDeadlineMs: opts.leaveDeadlineMs } : {}),
    onError: (_stage, _id, e) => void errors.push(e),
  });
  const disband = createDisbandMarker({
    overlay: { load: async (id) => overlay.get(id), save: async (r) => void overlay.set(r.id, r) },
    now: () => Date.now(),
    onMarked: (id) => void trace.push(`disbanded:${id.slice(0, 4)}`),
    onError: (_id, e) => void errors.push(e),
  });
  const peer: Peer = { account, pubkey, backend, inviter, ui, trace, removedEvents, leaver, purges, overlay, removal: removalRef, disband, toasts, announcements, errors, history };
  peers.push(peer);
  return peer;
}

afterEach(async () => {
  for (const p of peers.splice(0)) {
    p.leaver.dispose();
    await p.account.teardown().catch(() => undefined);
  }
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined); // a test may have stopped its relay already
  await clearAllPendingDirectInvites();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alice creates a group and invites Bob; Bob accepts; both hold the 2-member group. Returns Alice's handle. */
async function groupOfTwo(alice: Peer, bob: Peer, name = 'Leave harness'): Promise<MarmotGroup> {
  const group = await alice.account.handle.client.groups.create(name);
  alice.account.attachGroup(group);
  const res = await alice.inviter.inviteByPubkey(group as unknown as Parameters<KeyPackageInviter['inviteByPubkey']>[0], bob.pubkey);
  if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
  const invitations = bob.account.handle.client.invitations;
  await expect.poll(async () => (await invitations.pending()).length, { timeout: 20_000 }).toBe(1);
  const [pending] = await invitations.pending();
  await invitations.accept(pending.id);
  await expect.poll(() => [...group.members()].sort(), { timeout: 20_000 }).toEqual([alice.pubkey, bob.pubkey].sort());
  const bobGroup = (await bob.account.handle.client.groups.get(group.id))!;
  await bobGroup.synced();
  bob.account.attachGroup(bobGroup);
  bob.ui.add(group.id);
  bob.overlay.set(group.id, { id: group.id, name, memberPubkeys: [alice.pubkey, bob.pubkey] });
  return group as MarmotGroup;
}

const listedIds = async (p: Peer) => (await p.account.handle.client.groups.list()).map((g) => g.id);

describe('AC-LEAVE-2: Bob leaves a two-member group (the app\'s REAL timing options: leaveTimeoutMs 10 s, removalSettleMs 5 s)', () => {
  it('hides at once, announces first, leave() runs in the background, the library group is gone within 15 s, Alice\'s roster drops Bob', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]); // CLIENT_TIMING_OPTIONS: the app's real 10 s + 5 s
    const group = await groupOfTwo(alice, bob);
    const groupId = group.id;

    const startedAt = Date.now();
    const result = await bob.leaver.leave(groupId);
    expect(result.status).toBe('started');
    if (result.status !== 'started') throw new Error('unreachable');
    // IMMEDIATE: hidden before leave() settled (the library still holds the group at this instant)
    expect(bob.ui.has(groupId)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(bob.trace[0]).toBe('hide');
    expect((await listedIds(bob)).includes(groupId)).toBe(true);

    const settled = await result.settled;
    const elapsed = Date.now() - startedAt;
    expect(settled).toEqual({ status: 'left', mode: 'leave' });
    expect(elapsed).toBeLessThan(15_000);
    // the library group is gone from groups.list()
    expect(await listedIds(bob)).not.toContain(groupId);
    // the data purge ran exactly once, the pending view was refreshed, nothing was restored or toasted
    expect(bob.trace.filter((t) => t === 'overlay')).toHaveLength(1);
    expect(bob.trace).toContain('pending-view-refresh');
    expect(bob.trace).not.toContain('restore');
    expect(bob.toasts).toEqual([]);
    expect(bob.overlay.has(groupId)).toBe(false);

    // Alice's group no longer holds Bob, and the kind-9 announcement reached her
    await expect.poll(() => [...group.members()], { timeout: 20_000 }).toEqual([alice.pubkey]);
    const received: string[] = [];
    for await (const rumor of group.history()) received.push(rumor.content);
    const left = received.map((c) => parseStructured(c)).filter((s) => s?.type === 'leave_intent');
    expect(left).toEqual([{ type: 'leave_intent', pubkey: bob.pubkey, name: 'Bea' }]);
    expect(bob.errors).toEqual([]);
  }, 60_000);

  it('a second leave() after the group is gone is a harmless local purge (abandon mode), never an error', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url], { clientOptions: { leaveTimeoutMs: 3_000, removalSettleMs: 500 } });
    const group = await groupOfTwo(alice, bob);
    const first = await bob.leaver.leave(group.id);
    if (first.status !== 'started') throw new Error('unreachable');
    expect((await first.settled).status).toBe('left');
    const second = await bob.leaver.leave(group.id);
    if (second.status !== 'started') throw new Error('unreachable');
    expect(second.mode).toBe('abandon');
    expect(await second.settled).toEqual({ status: 'left', mode: 'abandon' });
  }, 60_000);
});

describe('AC-LEAVE-2: an OFFLINE leave is not blocked', () => {
  it('relay down: the leave does not wait for synced(); the announcement soft-fails by its bound; the group disappears from the library', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url], {
      // the library bounds leave() itself: lowered here so the test does not wait the production 10 s + 5 s
      clientOptions: { leaveTimeoutMs: 1_500, removalSettleMs: 200 },
      announceTimeoutMs: 600,
      leaveDeadlineMs: 20_000,
    });
    const group = await groupOfTwo(alice, bob);
    const groupId = group.id;

    await relay.stop(); // everyone is offline from here on
    const startedAt = Date.now();
    const result = await bob.leaver.leave(groupId);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(bob.ui.has(groupId)).toBe(false); // immediate, though the network is gone

    const settled = await result.settled;
    // not blocked: well inside the deadline (announce bound 0.6 s + library leaveTimeoutMs 1.5 s + slack)
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(settled).toEqual({ status: 'left', mode: 'leave' });
    expect(await listedIds(bob)).not.toContain(groupId);
    expect(bob.toasts).toEqual([]);
    expect(bob.announcements).toHaveLength(1); // it was attempted (and bounded), not skipped
    expect(bob.trace).not.toContain('restore');
    expect(bob.trace.filter((t) => t === 'overlay')).toHaveLength(1);
  }, 60_000);
});

describe('AC-LEAVE-2: a leave from a group that was loaded while the relay is down', () => {
  it('Bob restarts with the relay DOWN: the leave proceeds through the queue (skipSync) and the group goes. (The never-settling synced() premise is the unit test\'s: a stopped FakeRelay lets the library\'s first sync end.)', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
    const bob1 = await startPeer(SECRET_B, [url], { backend });
    const group = await groupOfTwo(alice, bob1);
    const groupId = group.id;
    const overlay = bob1.overlay;
    bob1.leaver.dispose();
    await bob1.account.teardown();
    peers.splice(peers.indexOf(bob1), 1);

    await relay.stop();
    const bob2 = await startPeer(SECRET_B, [url], {
      backend,
      overlay,
      clientOptions: { leaveTimeoutMs: 1_500, removalSettleMs: 200 },
      announceTimeoutMs: 400,
    });
    expect(await bob2.account.handle.client.groups.get(groupId)).toBeDefined();

    const startedAt = Date.now();
    const result = await bob2.leaver.leave(groupId);
    if (result.status !== 'started') throw new Error('unreachable');
    const settled = await result.settled;
    expect(settled).toEqual({ status: 'left', mode: 'leave' });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await listedIds(bob2)).not.toContain(groupId);
    expect(bob2.trace).not.toContain('restore');
    expect(bob2.toasts).toEqual([]);
  }, 60_000);
});

describe('AC-MEM-4: removal by an admin', () => {
  async function aliceRemovesBob(opts: PeerOptions) {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url], { clientOptions: { removalSettleMs: 400 }, ...opts });
    const group = await groupOfTwo(alice, bob);
    await group.synced();
    await group.removeMember(bob.pubkey);
    return { alice, bob, group };
  }

  it('(a) event path: the groupRemoved event enqueues the purge on the client FIFO; the library group is abandoned and the data purged', async () => {
    const { bob, group } = await aliceRemovesBob({});
    await expect.poll(() => bob.removedEvents.length, { timeout: 30_000 }).toBe(1);
    expect(bob.removedEvents[0].groupId).toBe(group.id);
    await bob.account.queue.idle();
    await expect.poll(() => bob.trace.includes('overlay'), { timeout: 30_000 }).toBe(true);
    expect(await listedIds(bob)).not.toContain(group.id);
    expect(bob.purges).toContain(group.id);
    expect(bob.ui.has(group.id)).toBe(false);
    expect(bob.overlay.has(group.id)).toBe(false);
    expect(bob.errors).toEqual([]);
    // idempotent: the same purge again (e.g. the startup check) is a harmless no-op
    await bob.removal.checkListedGroups(await bob.account.handle.client.groups.list());
    await bob.account.queue.idle();
    expect(bob.errors).toEqual([]);
  }, 90_000);

  it('(b) startup path with NO event: the check over groups.list() finds the group whose members() lacks the own account and purges it', async () => {
    const { bob, group } = await aliceRemovesBob({ loseRemovedEvent: true });
    // the removal settles (the library emits the event, which this peer deliberately drops)
    await expect.poll(() => bob.removedEvents.length, { timeout: 30_000 }).toBe(1);
    await sleep(300);
    expect(bob.trace).not.toContain('overlay'); // nothing purged yet: the event was lost
    const listed = await bob.account.handle.client.groups.list();
    const held = listed.find((g) => g.id === group.id)!;
    expect([...held.members()]).not.toContain(bob.pubkey); // the tombstone: still listed, own account absent
    const purged = await bob.removal.checkListedGroups(listed);
    expect(purged).toEqual([group.id]);
    expect(await listedIds(bob)).not.toContain(group.id);
    expect(bob.trace.filter((t) => t === 'overlay')).toHaveLength(1);
    // (c) a second pass: nothing is listed any more, nothing to do
    expect(await bob.removal.checkListedGroups(await bob.account.handle.client.groups.list())).toEqual([]);
  }, 90_000);

  it('the startup check leaves a healthy group alone', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const group = await groupOfTwo(alice, bob);
    expect(await bob.removal.checkListedGroups(await bob.account.handle.client.groups.list())).toEqual([]);
    expect(await listedIds(bob)).toContain(group.id);
    expect(bob.trace).not.toContain('overlay');
  }, 60_000);
});

describe('AC-MEM-5: disband surfacing from the library marker', () => {
  it('a persisted disband marker on the group (the library\'s tombstone) is surfaced at startup: the overlay row is marked disbanded, the group stays', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
    const bob1 = await startPeer(SECRET_B, [url], { backend });
    const group = await groupOfTwo(alice, bob1);
    const groupId = group.id;
    const overlay = bob1.overlay;

    // the engine writes this marker when a peer's disband is selected (client/group-disband.ts, extension marmot.disband)
    const store = bob1.account.stores.groupFactory(groupId);
    await store.transaction((tx) =>
      tx.extension('marmot.disband').put('selected', { at: 1_800_000_000_000, epoch: '2', nodeTag: 'aa'.repeat(32), commitDigest: 'bb'.repeat(32), actor: alice.pubkey }),
    );
    bob1.leaver.dispose();
    await bob1.account.teardown();

    // restart over the same storage: the group is loaded with `disbanded` set
    peers.splice(peers.indexOf(bob1), 1);
    const bob2 = await startPeer(SECRET_B, [url], { backend, overlay });
    const listed = await bob2.account.handle.client.groups.list();
    const held = listed.find((g) => g.id === groupId);
    expect(held).toBeDefined();
    expect(held!.disbanded?.actor).toBe(alice.pubkey);

    expect(overlay.get(groupId)?.disbanded).toBeUndefined();
    const marked = await bob2.disband.syncListed(listed);
    expect(marked).toEqual([groupId]);
    expect(overlay.get(groupId)?.disbanded).toEqual({ actor: alice.pubkey, at: 1_800_000_000_000 });
    expect(overlay.get(groupId)).toMatchObject({ name: 'Leave harness' }); // the rest of the row is kept
    // the disbanded group is surfaced, not purged: it stays listed and nothing was deleted
    expect(await listedIds(bob2)).toContain(groupId);
    expect(bob2.trace).not.toContain('overlay');
    // a second startup marks nothing more
    expect(await bob2.disband.syncListed(await bob2.account.handle.client.groups.list())).toEqual([]);
  }, 90_000);
});

describe('group administration', () => {
  it('surfaces a non-admin removal error and propagates rename, promotion and removal', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const group = await groupOfTwo(alice, bob);
    const bobGroup = (await bob.account.handle.client.groups.get(group.id))!;
    const queue = createGroupOpQueue();
    const groupId = group.id;
    const refresh = (id: string) => alice.trace.push(id);

    await expect(removeMember(queue, bobGroup, alice.pubkey, refresh)).rejects.toMatchObject({
      details: { reason: 'not-admin' },
    });
    expect([...bobGroup.members()].sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    expect(alice.trace).toEqual([]);

    await renameGroup(queue, group, 'Renamed group', refresh);
    await expect.poll(() => bobGroup.name).toBe('Renamed group');
    await grantAdmin(queue, group, bob.pubkey, refresh);
    await expect.poll(() => [...bobGroup.activeAdmins()].sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    await removeMember(queue, bobGroup, alice.pubkey, refresh);
    await expect.poll(() => bobGroup.members()).toEqual([bob.pubkey]);
    expect(alice.trace.filter((entry) => entry === groupId)).toEqual([groupId, groupId, groupId]);
  }, 60_000);
});
