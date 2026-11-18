// @vitest-environment node
/**
 * Library harness for S11: REAL @941design/marmot clients (Alice the sponsor, Bob the invitee) over
 * createMemoryStorage() and a FakeRelay, bootstrapped by the app's own bootstrapAccountClient; the invite goes through
 * the app's key-package inviter wrapped by the marker-recording inviter; the marker store is the real idb-keyval one
 * (fake-indexeddb); `welcomeDeclined` reaches the decline durability through the bootstrap's client-event listener and
 * the removal runs on the real client job queue (`handle.enqueue`), through the real GroupOpQueue, on the real group.
 *
 *  AC-DECL-1 (a/d)  Bob declines (native decline rumor) -> Alice's marker becomes declined durably, her group removes Bob
 *                   only after synced() resolved, then the marker is cleared and exactly one `declined` announcement
 *                   goes out through the real group sender; the library confirms Bob is no longer a member.
 *  AC-DECL-1 (b)    Alice's process dies between the listener and the removal job (the queued job is lost) with the
 *                   marker `declined` in idb; a restarted Alice (same storage) removes Bob at startup, announces once.
 *  AC-DECL-2        a welcomeDeclined for a ref no marker carries is ignored (Bob stays a member).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend, type MarmotGroup } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue, createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import {
  clearAllPendingDirectInvites,
  getPendingDirectInviteMarker,
  pendingDirectInviteMarkerStore,
} from '@/src/lib/marmot/pendingDirectInviteStorage';
import {
  createDeclineDurability,
  createKeyPackageInviter,
  createKeyPackageLookup,
  createMarkerRecordingInviter,
  type DeclineDurability,
  type DeclineGroup,
  type KeyPackageInviter,
} from '@/src/lib/marmot/invitations';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const CHAT_KIND = 9;

type Backend = ReturnType<typeof createMemoryStorage>;

interface Peer {
  account: AccountClient;
  pubkey: string;
  inviter: KeyPackageInviter;
  durability: DeclineDurability;
  /** welcomeDeclined payloads this client emitted. */
  declined: Array<{ groupId: string; inviteeRef: string }>;
  /** Ordered trace of the real group calls the removal made (`synced`, `removeMember`) and the announcements. */
  trace: string[];
  announcements: string[];
  sends: Array<Promise<unknown>>;
  errors: unknown[];
}

interface PeerOptions {
  backend?: Backend;
  /** Simulates a crash between the listener and the removal job: queued jobs are dropped. */
  dropJobs?: boolean;
}

const relays: FakeRelay[] = [];
const peers: Peer[] = [];

async function startRelay() {
  const relay = new FakeRelay();
  const url = await relay.start();
  relays.push(relay);
  return { relay, url };
}

async function startPeer(secretHex: string, defaults: string[], opts: PeerOptions = {}): Promise<Peer & { backend: Backend }> {
  const backend = opts.backend ?? createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  let transport: ReturnType<typeof createClientTransport> | undefined;
  const declined: Peer['declined'] = [];
  const trace: string[] = [];
  const announcements: string[] = [];
  const sends: Array<Promise<unknown>> = [];
  const errors: unknown[] = [];
  let forward: (p: { groupId: string; inviteeRef: string }) => void = () => undefined;
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined }),
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: () => undefined,
      welcomeDeclined: (p) => {
        declined.push(p);
        forward(p);
      },
      intentFailed: () => undefined,
      storeIncompatible: () => undefined,
      groupBranchSwitched: () => undefined,
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => undefined },
    clientOptions: { historyTimeoutMs: 2000 },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (rs) => (transport = createClientTransport({ relays: rs })),
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const lookup = createKeyPackageLookup({ transport: transport!.transport, defaultRelays: defaults, timeoutMs: 4000, allowLocalAdvertised: true });
  const queue = createGroupOpQueue({ syncTimeoutMs: 20_000 });
  const inviter = createMarkerRecordingInviter({ onRecordedDeclined: () => undefined,
    inviter: createKeyPackageInviter({ lookup, queue }),
    store: pendingDirectInviteMarkerStore,
    onError: (e) => void errors.push(e),
  }) as KeyPackageInviter;

  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  const sender = createGroupRumorSender({ ownPubkey: pubkey, tracker });
  const durability = createDeclineDurability({
    store: pendingDirectInviteMarkerStore,
    // the REAL group, observed (not replaced): the wrapper only records the order of the calls it delegates
    getGroup: async (id): Promise<DeclineGroup | undefined> => {
      const real = await account.handle.client.groups.get(id);
      if (!real) return undefined;
      return {
        id: real.id,
        leaves: (a) => real.leaves(a),
        ingest: (e) => real.ingest(e),
        synced: () => real.synced().then(() => void trace.push('synced')),
        removeMember: (a) => {
          trace.push('removeMember');
          return real.removeMember(a).then(() => void trace.push('removeMember:resolved'));
        },
      };
    },
    queue,
    announce: async (group, content) => {
      announcements.push(content);
      trace.push('announce');
      const real = (await account.handle.client.groups.get(group.id))!;
      const send = sender.sendGroupRumor(real, CHAT_KIND, content, []);
      sends.push(send);
      return send;
    },
    enqueue: opts.dropJobs ? () => undefined : account.handle.enqueue,
    onError: (e) => void errors.push(e),
  });
  forward = (p) => durability.onWelcomeDeclined(p);
  const peer = { account, pubkey, inviter, durability, declined, trace, announcements, sends, errors, backend };
  peers.push(peer);
  return peer;
}

beforeEach(async () => {
  peers.length = 0;
  await clearAllPendingDirectInvites();
});
afterEach(async () => {
  for (const p of peers.splice(0)) {
    p.durability.dispose();
    await p.account.teardown().catch(() => undefined);
  }
  for (const r of relays.splice(0)) await r.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invite(from: Peer, to: Peer, name: string) {
  const group = await from.account.handle.client.groups.create(name);
  from.account.attachGroup(group);
  const res = await from.inviter.inviteByPubkey(group as unknown as Parameters<KeyPackageInviter['inviteByPubkey']>[0], to.pubkey);
  if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
  return { group: group as MarmotGroup, res };
}

async function declineAsBob(bob: Peer): Promise<void> {
  const invitations = bob.account.handle.client.invitations;
  await expect.poll(async () => (await invitations.pending()).length, { timeout: 20_000 }).toBe(1);
  const [pending] = await invitations.pending();
  await invitations.decline(pending.id, { declineRumor: true });
}

describe('AC-DECL-1 (a, d): Bob declines, Alice removes him after synced and announces once', () => {
  it('records the marker at invite time, marks it declined, removes Bob after synced(), clears the marker, one announcement', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const { group, res } = await invite(alice, bob, 'Decline durability');

    // invite time: inviteeRef -> pubkey persisted
    // ... bound to the leaf the invite added (the real library's leaf signature key)
    const bobLeaf = group.leaves(bob.pubkey);
    expect(bobLeaf).toHaveLength(1);
    expect(await getPendingDirectInviteMarker(group.id, bob.pubkey)).toMatchObject({
      inviteeRef: res.outcome.inviteeRef,
      pubkey: bob.pubkey,
      declined: false,
      leafKey: bobLeaf[0].leafKey,
    });

    await declineAsBob(bob);
    await expect.poll(() => alice.declined.length, { timeout: 20_000 }).toBe(1);
    expect(alice.declined[0].inviteeRef).toBe(res.outcome.inviteeRef);

    await expect.poll(async () => (await getPendingDirectInviteMarker(group.id, bob.pubkey)) === undefined, { timeout: 30_000 }).toBe(true);
    await alice.durability.idle();
    await Promise.all(alice.sends);

    // the order the library saw: synced() settled before removeMember, the announcement came after it resolved
    expect(alice.trace.indexOf('synced')).toBeGreaterThanOrEqual(0);
    expect(alice.trace.indexOf('synced')).toBeLessThan(alice.trace.indexOf('removeMember'));
    expect(alice.trace.filter((t) => t === 'removeMember')).toHaveLength(1);
    expect(alice.trace.indexOf('removeMember:resolved')).toBeLessThan(alice.trace.indexOf('announce'));
    expect(alice.announcements).toHaveLength(1);
    expect(JSON.parse(alice.announcements[0])).toEqual({ type: 'invite_lifecycle', event: 'declined', pubkey: bob.pubkey, id: `${group.id}:${res.outcome.inviteeRef}` });
    // the library agrees: Bob is no longer a member of Alice's group
    expect(group.leaves(bob.pubkey)).toHaveLength(0);
    expect([...group.members()]).toEqual([alice.pubkey]);
    // a replay (a startup retry) finds nothing to do
    await alice.durability.retryDeclined();
    await sleep(200);
    expect(alice.announcements).toHaveLength(1);
    expect(alice.errors).toEqual([]);
  }, 120_000);
});

describe('AC-DECL-1 (b): the decline is not lost when the process dies before the removal runs', () => {
  it('the declined marker survives in idb; the restarted sponsor (same storage) removes Bob at startup and announces once', async () => {
    const { url } = await startRelay();
    const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
    const alice1 = await startPeer(SECRET_A, [url], { backend, dropJobs: true });
    const bob = await startPeer(SECRET_B, [url]);
    const { group, res } = await invite(alice1, bob, 'Offline decline');
    const groupId = group.id; // the handle is dead once alice1 is torn down
    await declineAsBob(bob);

    // listener fired: the marker is declined durably, but the queued removal job was lost with the process
    await expect.poll(() => alice1.declined.length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await getPendingDirectInviteMarker(groupId, bob.pubkey))?.declined, { timeout: 10_000 }).toBe(true);
    await sleep(300);
    expect(alice1.trace).toEqual([]);
    expect(alice1.announcements).toEqual([]);
    alice1.durability.dispose();
    await alice1.account.teardown();

    // restart: a fresh client over the same storage, the same idb
    const alice2 = await startPeer(SECRET_A, [url], { backend });
    expect((await getPendingDirectInviteMarker(groupId, bob.pubkey))?.inviteeRef).toBe(res.outcome.inviteeRef);
    alice2.durability.startupRetry();
    await expect.poll(async () => (await getPendingDirectInviteMarker(groupId, bob.pubkey)) === undefined, { timeout: 30_000 }).toBe(true);
    await alice2.durability.idle();
    await Promise.all(alice2.sends);

    expect(alice2.trace.filter((t) => t === 'removeMember')).toHaveLength(1);
    expect(alice2.trace.indexOf('synced')).toBeLessThan(alice2.trace.indexOf('removeMember'));
    expect(alice2.announcements).toHaveLength(1);
    const reloaded = (await alice2.account.handle.client.groups.get(groupId))!;
    expect(reloaded.leaves(bob.pubkey)).toHaveLength(0);
    // a second startup retry: nothing declined is left, nothing is removed or announced again
    alice2.durability.startupRetry();
    await sleep(300);
    await alice2.durability.idle();
    expect(alice2.trace.filter((t) => t === 'removeMember')).toHaveLength(1);
    expect(alice2.announcements).toHaveLength(1);
    expect(alice2.errors).toEqual([]);
  }, 150_000);
});

describe('AC-DECL-2: an unknown inviteeRef is ignored', () => {
  it('a welcomeDeclined for a ref no marker carries removes nobody; Bob stays a member', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const { group } = await invite(alice, bob, 'Unknown ref');
    const invitations = bob.account.handle.client.invitations;
    await expect.poll(async () => (await invitations.pending()).length, { timeout: 20_000 }).toBe(1);
    const [pending] = await invitations.pending();
    await invitations.accept(pending.id);
    await expect.poll(() => [...group.members()].sort(), { timeout: 20_000 }).toEqual([alice.pubkey, bob.pubkey].sort());

    alice.durability.onWelcomeDeclined({ groupId: group.id, inviteeRef: 'ref-nobody-holds' });
    await alice.account.queue.idle();
    await alice.durability.idle();
    await sleep(300);
    expect(alice.trace).toEqual([]);
    expect(alice.announcements).toEqual([]);
    expect(group.leaves(bob.pubkey).length).toBeGreaterThan(0);
    // reported, and kept as an orphan decline (nothing removed)
    expect(alice.errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining('kept as an orphan decline')]);
  }, 120_000);
});
