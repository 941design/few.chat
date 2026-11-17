// @vitest-environment node
/**
 * Library harness for S9: REAL @941design/marmot clients over createMemoryStorage() and a FakeRelay, bootstrapped by
 * the app's own bootstrapAccountClient; the invite goes through the app's key-package inviter (S8). The pending view,
 * deny layer and accept/decline actions under test are wired exactly as the cut-over will: the view listens on
 * `clientEvents.inboxDisposition` and runs on `handle.enqueue`.
 *
 *  AC-INV-2  a Welcome from an unrelated sponsor lands in pending() and does NOT auto-join; the invitee's group list
 *            stays empty until accept; accept makes the invitee a member.
 *  AC-INV-3  decline(id) (native rumor requested) removes it from pending(), Alice's client emits welcomeDeclined with the inviteeRef, and no
 *            kind-21063 event reaches the relay; the native decline is exactly one more kind-1059 wrap.
 *  AC-BLK-1  a blocked sponsor: nothing shown, no arrival, decline(id,{declineRumor:false}), the library list is empty
 *            afterwards, NO wrap is published (the sender learns nothing, no welcomeDeclined); a non-blocked sponsor
 *            in the same run is processed normally.
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
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import {
  createDenyLayer,
  createInvitationActions,
  createKeyPackageInviter,
  createKeyPackageLookup,
  createPendingInvitationView,
  createTrustedSponsorPredicate,
  KEY_PACKAGE_KIND,
  type InvitationActions,
  type KeyPackageInviter,
  type PendingInvitationView,
} from '@/src/lib/marmot/invitations';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const SECRET_C = 'c3'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const WRAP_KIND = 1059;
const LEGACY_DECLINE_KIND = 21063;
/** What a blocked (silent) decline publishes: the key-package rotation only (one replacement key package). */
const EXPECTED_ROTATION_DELTA: number[] = [KEY_PACKAGE_KIND];

interface Peer {
  account: AccountClient;
  pubkey: string;
  inviter: KeyPackageInviter;
  /** welcomeDeclined payloads this peer's client emitted. */
  declined: Array<{ groupId: string; inviteeRef: string }>;
  blocked: Set<string>;
  view: PendingInvitationView;
  actions: InvitationActions;
  /** Every decline call the view/actions made on the real library. */
  declineCalls: Array<{ id: string; options?: { declineRumor?: boolean } }>;
  arrivals: string[];
  /** Everything the view / actions reported through onError (must stay empty). */
  errors: unknown[];
}

const relays: FakeRelay[] = [];
const peers: Peer[] = [];

async function startRelay() {
  const relay = new FakeRelay();
  const url = await relay.start();
  relays.push(relay);
  return { relay, url };
}

async function startPeer(secretHex: string, defaults: string[]): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  let transport: ReturnType<typeof createClientTransport> | undefined;
  const declined: Peer['declined'] = [];
  let forward: (d: { kind: string }) => void = () => undefined;
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined }),
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: (d) => forward(d),
      welcomeDeclined: (p) => void declined.push(p),
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
  const inviter = createKeyPackageInviter({ lookup, queue: createGroupOpQueue({ syncTimeoutMs: 20_000 }) });

  const real = account.handle.client.invitations;
  const declineCalls: Peer['declineCalls'] = [];
  const invitations = {
    pending: () => real.pending(),
    decline: (id: string, options?: { readonly declineRumor?: boolean }) => {
      declineCalls.push({ id, options: options as { declineRumor?: boolean } | undefined });
      return real.decline(id, options);
    },
    accept: (id: string) => real.accept(id),
  };
  const blocked = new Set<string>();
  const errors: unknown[] = [];
  const view = createPendingInvitationView({
    invitations,
    denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }),
    enqueue: account.handle.enqueue,
    isTrustedSponsor: createTrustedSponsorPredicate(pubkey, () => false),
    now: () => Date.now(),
    onError: (e) => void errors.push(e),
  });
  forward = (d) => view.onInboxDisposition(d);
  const arrivals: string[] = [];
  view.onArrival((i) => arrivals.push(i.id));
  await view.seed(); // the baseline load, as startup does
  const actions = createInvitationActions({ invitations, view, attachGroup: (g) => account.attachGroup(g), onError: (e) => void errors.push(e) });
  const peer: Peer = { account, pubkey, inviter, declined, blocked, view, actions, declineCalls, arrivals, errors };
  peers.push(peer);
  return peer;
}

beforeEach(() => {
  peers.length = 0;
});
afterEach(async () => {
  for (const p of peers.splice(0)) {
    p.view.dispose();
    await p.account.teardown().catch(() => undefined);
    expect(p.errors).toEqual([]);
  }
  for (const r of relays.splice(0)) await r.stop();
});

const wraps = (relay: FakeRelay) => relay.storedEvents.filter((e) => e.kind === WRAP_KIND).length;
/** Kinds stored on the relay, sorted, as a multiset: a delta between two calls shows exactly what was published. */
const kinds = (relay: FakeRelay) => relay.storedEvents.map((e) => e.kind).sort((a, b) => a - b);
const kindsAdded = (before: number[], after: number[]) => {
  const left = [...before];
  const added: number[] = [];
  for (const k of after) {
    const i = left.indexOf(k);
    if (i >= 0) left.splice(i, 1);
    else added.push(k);
  }
  return added;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invite(from: Peer, to: Peer, name: string) {
  const group = await from.account.handle.client.groups.create(name);
  from.account.attachGroup(group);
  const res = await from.inviter.inviteByPubkey(group as unknown as Parameters<KeyPackageInviter['inviteByPubkey']>[0], to.pubkey);
  if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
  return { group: group as MarmotGroup, res };
}

describe('AC-INV-2: pull-only (ADR-002)', () => {
  it('an unrelated sponsor\'s Welcome lands in pending(), the invitee joins nothing until accept, then both are members', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const { group } = await invite(alice, bob, 'Pull only');

    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    const [shown] = bob.view.pending();
    expect(shown.sponsorAccount).toBe(alice.pubkey);
    expect(shown.groupId).toBe(group.id);
    expect(bob.arrivals).toEqual([shown.id]);
    // pull-only: still a pending invitation, no group joined, even after a settle window
    await sleep(400);
    expect(await bob.account.handle.client.groups.list()).toHaveLength(0);
    expect((await bob.account.handle.client.invitations.pending()).map((i) => i.id)).toEqual([shown.id]);

    const joined = await bob.actions.accept(shown.id);
    expect(joined.id).toBe(group.id);
    expect(bob.view.pending()).toEqual([]);
    expect(await bob.account.handle.client.invitations.pending()).toHaveLength(0);
    expect((await bob.account.handle.client.groups.list()).map((g) => g.id)).toEqual([group.id]);
    await group.synced();
    await joined.synced();
    await expect.poll(() => [...group.members()].sort(), { timeout: 20_000 }).toEqual([alice.pubkey, bob.pubkey].sort());
  }, 90_000);
});

describe('AC-INV-3: native decline', () => {
  it('decline removes it from pending, Alice gets welcomeDeclined with the inviteeRef, no kind 21063, exactly one native decline wrap', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    const { res } = await invite(alice, bob, 'Decline me');
    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    const [shown] = bob.view.pending();
    const wrapsBefore = wraps(relay);

    await bob.actions.decline(shown.id);

    expect(bob.view.pending()).toEqual([]);
    expect(await bob.account.handle.client.invitations.pending()).toHaveLength(0);
    expect(bob.declineCalls).toEqual([{ id: shown.id, options: { declineRumor: true } }]);
    await expect.poll(() => alice.declined.length, { timeout: 20_000 }).toBe(1);
    expect(alice.declined[0].inviteeRef).toBe(res.outcome.inviteeRef);
    expect(wraps(relay)).toBe(wrapsBefore + 1); // the library's addressed decline rumor (4462) and nothing else
    // a second user decline of the same id is a quiet no-op: no library call, no further wrap
    await expect(bob.actions.decline(shown.id)).resolves.toBeUndefined();
    expect(bob.declineCalls).toHaveLength(1);
    await sleep(300);
    expect(wraps(relay)).toBe(wrapsBefore + 1);
    expect(relay.storedEvents.some((e) => e.kind === LEGACY_DECLINE_KIND)).toBe(false);
  }, 90_000);
});

describe('AC-BLK-1: blocked sponsor', () => {
  it('Alice (blocked) is dropped: not shown, no arrival, decline(id,{declineRumor:false}), library list empty, nothing sent back; Carol (not blocked) is processed normally', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRET_A, [url]);
    const carol = await startPeer(SECRET_C, [url]);
    const bob = await startPeer(SECRET_B, [url]);
    bob.blocked.add(alice.pubkey);

    await invite(alice, bob, 'From a blocked sponsor');
    const wrapsAfterInvite = wraps(relay);
    const kindsAfterInvite = kinds(relay);
    await expect.poll(() => bob.declineCalls.length, { timeout: 20_000 }).toBe(1);
    expect(bob.declineCalls[0].options).toEqual({ declineRumor: false });
    await expect.poll(async () => (await bob.account.handle.client.invitations.pending()).length, { timeout: 20_000 }).toBe(0);
    await sleep(600); // a decline wrap or welcomeDeclined, if any were to be sent, would show by now
    expect(bob.view.pending()).toEqual([]);
    expect(bob.arrivals).toEqual([]);
    expect(wraps(relay)).toBe(wrapsAfterInvite);
    expect(alice.declined).toEqual([]);
    // Residual signal, pinned: a silent decline sends no rumor and no wrap, but the library still rotates the
    // consumed key package, which is a public replacement publish (key-package kind, no profile data). Nothing else.
    const added = kindsAdded(kindsAfterInvite, kinds(relay));
    expect(added.filter((k) => k === LEGACY_DECLINE_KIND || k === WRAP_KIND)).toEqual([]);
    expect(added).toEqual(EXPECTED_ROTATION_DELTA);

    await invite(carol, bob, 'From a friend');
    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    expect(bob.view.pending()[0].sponsorAccount).toBe(carol.pubkey);
    expect(bob.arrivals).toHaveLength(1);
    expect(bob.declineCalls).toHaveLength(1); // still only the blocked one
  }, 120_000);
});
