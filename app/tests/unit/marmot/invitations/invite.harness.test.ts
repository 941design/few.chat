// @vitest-environment node
/**
 * Library harness for the invite flow (S8): REAL @941design/marmot clients over createMemoryStorage() and FakeRelays,
 * bootstrapped by the app's own bootstrapAccountClient, the real GroupOpQueue, the real key-package lookup over each
 * client's own SimplePool transport.
 *
 *  AC-INV-1  Alice creates a group, invites Bob through the key-package lookup; Bob's invitations.pending() holds one
 *            invitation with Alice as sponsorAccount; accept(id) makes Bob a member; both see each other in members().
 *  AC-KP-2   (harness half) a key package that lives only on a relay Bob advertises (kind 10002 on Alice's relay) outside
 *            Alice's defaults is found and the invite is delivered (commit aa39de3); without the advertisement it is not.
 *  No double add: after Bob accepted and published a rotated key package, inviting him again yields
 *            {error:'already-member'}, group.invite is not called again and the group still holds ONE leaf of Bob.
 *  AC-KP-1   the library receives exactly one key-package event per invite call, and invalid-options on the newest
 *            candidate falls through to the next (a real, undecodable-but-validly-signed newest candidate).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend, type MarmotGroup } from '@941design/marmot';
import type { NostrEvent } from '@941design/nostr-events/event';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import { createKeyPackageInviter, createKeyPackageLookup, KEY_PACKAGE_KIND, type KeyPackageInviter, type KeyPackageLookup } from '@/src/lib/marmot/invitations';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));

const relays: FakeRelay[] = [];
const peers: Peer[] = [];
const closers: Array<() => void> = [];

interface Peer {
  account: AccountClient;
  pubkey: string;
  /** Lookup + inviter over THIS peer's own SimplePool transport and relay defaults. */
  lookup: KeyPackageLookup;
  inviter: KeyPackageInviter;
  /** Every group.invite argument list this peer's groups received. */
  inviteCalls: NostrEvent[][];
}

async function startRelay(): Promise<{ relay: FakeRelay; url: string }> {
  const relay = new FakeRelay();
  const url = await relay.start();
  relays.push(relay);
  return { relay, url };
}

async function startPeer(secretHex: string, defaults: string[]): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  let transport: ReturnType<typeof createClientTransport> | undefined;
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined }),
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: () => undefined,
      welcomeDeclined: () => undefined,
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
  // FakeRelays live on 127.0.0.1: advertised local relays are allowed here (and only here).
  const lookup = createKeyPackageLookup({ transport: transport!.transport, defaultRelays: defaults, timeoutMs: 4000, allowLocalAdvertised: true });
  const inviter = createKeyPackageInviter({ lookup, queue: createGroupOpQueue({ syncTimeoutMs: 20_000 }) });
  const peer: Peer = { account: result.account, pubkey, lookup, inviter, inviteCalls: [] };
  peers.push(peer);
  return peer;
}

/** A group over the real one whose `invite` records its arguments (the real call still runs). */
function recording(peer: Peer, g: MarmotGroup) {
  return {
    id: g.id,
    synced: () => g.synced(),
    leaves: (pk: string) => g.leaves(pk),
    ingest: g.ingest.bind(g),
    invite: (events: NostrEvent[]) => {
      peer.inviteCalls.push([...events]);
      return g.invite(events);
    },
  } as unknown as Parameters<KeyPackageInviter['inviteByPubkey']>[0];
}

beforeEach(() => {
  peers.length = 0;
});
afterEach(async () => {
  for (const p of peers.splice(0)) await p.account.teardown().catch(() => undefined);
  for (const c of closers.splice(0)) c();
  for (const r of relays.splice(0)) await r.stop();
});

const poll = <T>(fn: () => Promise<T> | T, expected: T) => expect.poll(async () => fn(), { timeout: 20_000 }).toEqual(expected);

describe('AC-INV-1: invite by key-package lookup, pending, accept, both members', () => {
  it('Alice invites Bob; Bob has one pending invitation sponsored by Alice; accept makes him a member; both list each other', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const group = await alice.account.handle.client.groups.create('Harness group');
    alice.account.attachGroup(group);

    const res = await alice.inviter.inviteByPubkey(recording(alice, group), bob.pubkey);
    if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
    expect(res.outcome.status).toBe('delivered');
    expect(res.outcome.pubkey).toBe(bob.pubkey);
    expect(res.attempts).toBe(1);
    expect(alice.inviteCalls).toHaveLength(1);
    expect(alice.inviteCalls[0]).toHaveLength(1); // exactly one key-package event
    expect(alice.inviteCalls[0][0].kind).toBe(KEY_PACKAGE_KIND);
    expect(alice.inviteCalls[0][0].pubkey).toBe(bob.pubkey);
    expect(alice.inviteCalls[0][0].id).toBe(res.keyPackageEventId);

    const bobInvites = bob.account.handle.client.invitations;
    await expect.poll(async () => (await bobInvites.pending()).length, { timeout: 20_000 }).toBe(1);
    const pending = await bobInvites.pending();
    expect(pending[0].sponsorAccount).toBe(alice.pubkey);
    expect(pending[0].groupId).toBe(group.id);

    const joined = await bobInvites.accept(pending[0].id);
    bob.account.attachGroup(joined);
    expect(joined.id).toBe(group.id);
    expect(await bobInvites.pending()).toHaveLength(0);
    await group.synced();
    await joined.synced();
    await poll(() => [...group.members()].sort(), [alice.pubkey, bob.pubkey].sort());
    await poll(() => [...joined.members()].sort(), [alice.pubkey, bob.pubkey].sort());
  }, 90_000);

  it('an invitee with no published key package yields the error value, not a throw, and no commit', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const group = await alice.account.handle.client.groups.create('Lonely');
    alice.account.attachGroup(group);
    const stranger = pub('e5'.repeat(32));
    const res = await alice.inviter.inviteByPubkey(recording(alice, group), stranger);
    expect(res).toMatchObject({ error: 'no usable key package', reason: 'none-found', attempts: 0 });
    expect(alice.inviteCalls).toHaveLength(0);
    expect([...group.members()]).toEqual([alice.pubkey]);
  }, 60_000);
});

describe('no double add (harness)', () => {
  it('Bob accepted and published a rotated key package: inviting him again is already-member, no second commit, one leaf', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const group = await alice.account.handle.client.groups.create('No double add');
    alice.account.attachGroup(group);

    const first = await alice.inviter.inviteByPubkey(recording(alice, group), bob.pubkey);
    if ('error' in first) throw new Error(`invite failed: ${JSON.stringify(first)}`);
    const bobInvites = bob.account.handle.client.invitations;
    await expect.poll(async () => (await bobInvites.pending()).length, { timeout: 20_000 }).toBe(1);
    const joined = await bobInvites.accept((await bobInvites.pending())[0].id);
    bob.account.attachGroup(joined);
    await group.synced();
    await poll(() => group.leaves(bob.pubkey).length, 1);

    const fresh = await bob.account.handle.client.keyPackages.create(); // the rotated / new key package Alice's lookup will find
    const second = await alice.inviter.inviteByPubkey(recording(alice, group), bob.pubkey);
    expect(second).toEqual({ error: 'already-member' });
    expect(alice.inviteCalls).toHaveLength(1); // only the first invite reached the library
    expect(alice.inviteCalls.flat().some((e) => e.id === fresh.id)).toBe(false);
    expect(group.leaves(bob.pubkey)).toHaveLength(1);
    expect([...group.members()].sort()).toEqual([alice.pubkey, bob.pubkey].sort());
  }, 120_000);
});

describe('AC-KP-2 (harness): a key package on an advertised relay outside the defaults is found', () => {
  it('Bob keeps his key package only on relay 2 and advertises it with a kind-10002 on relay 1 (Alice\'s default): found and delivered; unadvertised: not found', async () => {
    const r1 = await startRelay();
    const r2 = await startRelay();
    const alice = await startPeer(SECRET_A, [r1.url]);
    const bob = await startPeer(SECRET_B, [r2.url]); // his bootstrap key package goes to relay 2 only
    expect(r1.relay.storedEvents.some((e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === bob.pubkey)).toBe(false);
    expect(r2.relay.storedEvents.some((e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === bob.pubkey)).toBe(true);

    const group = await alice.account.handle.client.groups.create('Two relays');
    alice.account.attachGroup(group);

    // Control: nothing advertised, Alice cannot see relay 2.
    expect(await alice.lookup.lookup(bob.pubkey)).toMatchObject({ ok: false, reason: 'none-found' });

    // Bob advertises relay 2 (read+write) on relay 1; his Welcome inbox then resolves to relay 2 as well.
    const advert = finalizeEvent({ kind: 10002, created_at: Math.floor(Date.now() / 1000), tags: [['r', r2.url]], content: '' }, bytes(SECRET_B)) as NostrEvent;
    const publisher = createClientTransport({ relays: [r1.url] });
    closers.push(() => publisher.closePool());
    await publisher.transport.publish([r1.url], advert);

    const found = await alice.lookup.lookup(bob.pubkey);
    expect(found.ok).toBe(true);
    expect(found.relays).toContain(r2.url);

    const res = await alice.inviter.inviteByPubkey(recording(alice, group), bob.pubkey);
    if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
    expect(res.outcome.status).toBe('delivered');
    await expect.poll(async () => (await bob.account.handle.client.invitations.pending()).length, { timeout: 30_000 }).toBe(1);
    expect((await bob.account.handle.client.invitations.pending())[0].sponsorAccount).toBe(alice.pubkey);
  }, 120_000);
});

describe('AC-KP-1 (harness): invalid-options on the newest candidate falls through to the next real one', () => {
  it('a newer, validly signed but invalid key package is rejected by the library; the older real one is invited, one event per call', async () => {
    const { url, relay } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const group = await alice.account.handle.client.groups.create('Fallthrough');
    alice.account.attachGroup(group);

    const real = relay.storedEvents.find((e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === bob.pubkey);
    expect(real).toBeDefined();
    const junk = finalizeEvent({ kind: KEY_PACKAGE_KIND, created_at: real!.created_at + 1000, tags: [['d', 'junk-slot']], content: 'not-a-key-package' }, bytes(SECRET_B)) as NostrEvent;
    const publisher = createClientTransport({ relays: [url] });
    closers.push(() => publisher.closePool());
    await publisher.transport.publish([url], junk);

    const res = await alice.inviter.inviteByPubkey(recording(alice, group), bob.pubkey);
    if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
    expect(alice.inviteCalls.map((c) => c.map((e) => e.id))).toEqual([[junk.id], [real!.id]]);
    expect(res).toMatchObject({ keyPackageEventId: real!.id, attempts: 2 });
    expect(res.outcome.status).toBe('delivered');
    // the rejected candidate left no commit behind: exactly one Welcome went out
    await expect.poll(async () => (await bob.account.handle.client.invitations.pending()).length, { timeout: 20_000 }).toBe(1);
  }, 90_000);
});
