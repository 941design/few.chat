// @vitest-environment node
/**
 * Library harness for S10: REAL @941design/marmot clients over createMemoryStorage() and a FakeRelay, bootstrapped by
 * the app's own bootstrapAccountClient. Alice invites Bob through the context-sending inviter (S8 inviter + S10 sender);
 * Bob's inbox handler (registered by the bootstrap on the library inbox) stores the context; the pending view (S9) shows
 * the invitation; the card view model joins the two.
 *
 *  AC-CTX-1 / AC-PRIV-2  the context is ONE kind-1059 wrap more than the Welcome alone and no kind-21064 event is ever stored
 *                        at top level on the relay; a failed invite (no key package) publishes no wrap and sends no context.
 *  AC-CTX-2              Bob's card shows the group name from Alice's context (live: the generic label first when the
 *                        invitation lands before the context is held), and keeps the generic label for a context
 *                        from a non-sponsor (Carol) of the same group.
 *  AC-CTX-3              accept deletes the stored context.
 *  AC-BLK-1 (ctx leg)    a blocked sponsor's context is dropped: nothing stored.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import {
  INVITE_CONTEXT_KIND,
  bindInviteContextToPendingView,
  buildInvitationCardViewModels,
  createContextSendingInviter,
  createDenyLayer,
  createInvitationActions,
  createInviteContextHandler,
  createInviteContextSender,
  createInviteContextStore,
  createKeyPackageInviter,
  createKeyPackageLookup,
  createPendingInvitationView,
  createTrustedSponsorPredicate,
  withInviteContextCleanup,
  type InvitationActions,
  type InviteContextStore,
  type PendingInvitationView,
} from '@/src/lib/marmot/invitations';
import { memoryPort } from './inviteContext.fixtures';

const SECRETS = { a: 'a1'.repeat(32), b: 'b2'.repeat(32), c: 'c3'.repeat(32) };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const WRAP_KIND = 1059;
const LABEL = 'Group invitation';

interface Peer {
  account: AccountClient;
  pubkey: string;
  inviter: ReturnType<typeof createContextSendingInviter>;
  view: PendingInvitationView;
  store: InviteContextStore;
  actions: InvitationActions;
  blocked: Set<string>;
  /** sendInboxRumor calls this peer's sender made. */
  sends: Array<{ to: string; kind: number }>;
  errors: unknown[];
  /** discard() calls that reached the store through the accept/decline cleanup decorator. */
  discards: Array<{ groupId: string }>;
  cards: () => string[];
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
  let forward: (d: { kind: string }) => void = () => undefined;
  const blocked = new Set<string>();
  const errors: unknown[] = [];
  let view!: PendingInvitationView;
  const store = createInviteContextStore({ port: memoryPort().port, now: () => Date.now(), getPending: () => (view ? view.pending() : []), onError: (e) => void errors.push(e) });
  await store.load();
  const handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }), onError: (e) => void errors.push(e) });
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined }),
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: (d) => forward(d),
      welcomeDeclined: () => undefined,
      intentFailed: () => undefined,
      storeIncompatible: () => undefined,
      groupBranchSwitched: () => undefined,
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: handler },
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
  const sends: Peer['sends'] = [];
  const realInbox = account.handle.client.extensions;
  const sender = createInviteContextSender({
    inbox: {
      sendInboxRumor: (input) => {
        sends.push({ to: input.to, kind: input.rumor.kind });
        return realInbox.sendInboxRumor(input);
      },
    },
    ownPubkey: pubkey,
    now: () => Date.now(),
    onError: (e) => void errors.push(e),
  });
  const inviter = createContextSendingInviter({ inviter: createKeyPackageInviter({ lookup, queue: createGroupOpQueue({ syncTimeoutMs: 20_000 }) }), sender });

  const real = account.handle.client.invitations;
  const invitations = { pending: () => real.pending(), decline: (id: string, o?: { readonly declineRumor?: boolean }) => real.decline(id, o), accept: (id: string) => real.accept(id) };
  view = createPendingInvitationView({
    invitations,
    denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }),
    enqueue: account.handle.enqueue,
    isTrustedSponsor: createTrustedSponsorPredicate(pubkey, () => false),
    now: () => Date.now(),
    onError: (e) => void errors.push(e),
  });
  forward = (d) => view.onInboxDisposition(d);
  await view.seed();
  const binding = bindInviteContextToPendingView({ view, store, onError: (e) => void errors.push(e) });
  await binding.reconcileNow();
  const discards: Array<{ groupId: string }> = [];
  const recordingStore = { discard: (invitation: { groupId: string }) => (discards.push({ groupId: invitation.groupId }), store.discard(invitation)) };
  const actions = withInviteContextCleanup({
    actions: createInvitationActions({ invitations, view, attachGroup: (g) => account.attachGroup(g), onError: (e) => void errors.push(e) }),
    view,
    store: recordingStore,
  });
  const cards = () => buildInvitationCardViewModels(view.pending(), store.snapshot(), LABEL, Date.now()).map((m) => m.displayName);
  const peer: Peer = { account, pubkey, inviter, view, store, actions, blocked, sends, errors, discards, cards };
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

async function inviteWithContext(from: Peer, to: Peer, name: string) {
  const group = await from.account.handle.client.groups.create(name);
  from.account.attachGroup(group);
  const res = await from.inviter.inviteByPubkey(group as never, to.pubkey);
  if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
  return { group, res };
}

describe('invite context over real clients', () => {
  it('AC-CTX-1/2 + AC-PRIV-2: one addressed wrap carries the name; the card shows it; accept deletes it', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const { group } = await inviteWithContext(alice, bob, 'Chess club');

    expect(alice.sends).toEqual([{ to: bob.pubkey, kind: INVITE_CONTEXT_KIND }]);
    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => bob.store.snapshot().length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => bob.cards(), { timeout: 5_000 }).toEqual(['Chess club']);
    const [held] = bob.store.snapshot();
    expect(held).toMatchObject({ groupId: group.id, sender: alice.pubkey, name: 'Chess club', matched: true });

    // privacy: nothing of kind 21064 at top level; the context is gift-wrapped (kind 1059 only)
    expect(relay.storedEvents.filter((e) => e.kind === INVITE_CONTEXT_KIND)).toEqual([]);
    expect(wraps(relay)).toBe(2); // the Welcome wrap + the context wrap
    const [invitation] = bob.view.pending();
    expect(JSON.stringify(relay.storedEvents)).not.toContain('Chess club');

    // The pending-view reconcile would also delete it, so assert the cleanup decorator itself acted.
    await bob.actions.accept(invitation.id);
    expect(bob.discards).toEqual([{ groupId: group.id }]);
    expect(bob.store.snapshot()).toEqual([]);
  }, 90_000);

  it('AC-CTX-2: a non-sponsor\'s context for the same group never names the card; the sponsor\'s does', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const carol = await startPeer(SECRETS.c, [url]);
    // Carol (not the sponsor) sends Bob a context for the group Alice is about to invite him to
    const group = await alice.account.handle.client.groups.create('Real name');
    alice.account.attachGroup(group);
    const sentByCarol = createInviteContextSender({ inbox: carol.account.handle.client.extensions, ownPubkey: carol.pubkey, now: () => Date.now() });
    expect(await sentByCarol.sendAfterInvite({ outcome: { status: 'delivered' } } as never, { to: bob.pubkey, groupId: group.id, name: 'Phishing name' })).toBe('sent');
    await expect.poll(() => bob.store.snapshot().length, { timeout: 20_000 }).toBe(1); // held: no invitation yet

    const res = await alice.inviter.inviteByPubkey(group as never, bob.pubkey);
    expect('error' in res).toBe(false);
    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => bob.cards(), { timeout: 20_000 }).toEqual(['Real name']);
    // Carol's was dropped on validation, Alice's is the one held
    expect(bob.store.snapshot().map((r) => [r.sender, r.name])).toEqual([[alice.pubkey, 'Real name']]);
  }, 90_000);

  it('AC-CTX-1: no usable key package = no invite and NO context wrap', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const group = await alice.account.handle.client.groups.create('Nobody home');
    alice.account.attachGroup(group);
    const before = wraps(relay);
    const res = await alice.inviter.inviteByPubkey(group as never, pub('d4'.repeat(32)));
    expect(res).toMatchObject({ error: 'no usable key package' });
    expect(alice.sends).toEqual([]);
    expect(wraps(relay)).toBe(before);
  }, 60_000);

  it('AC-BLK-1 (context leg): a blocked sponsor\'s context is dropped, nothing stored', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    bob.blocked.add(alice.pubkey);
    const group = await alice.account.handle.client.groups.create('Blocked');
    alice.account.attachGroup(group);
    const sender = createInviteContextSender({ inbox: alice.account.handle.client.extensions, ownPubkey: alice.pubkey, now: () => Date.now() });
    await sender.sendAfterInvite({ outcome: { status: 'delivered' } } as never, { to: bob.pubkey, groupId: group.id, name: 'Blocked' });
    // Marker: an UNBLOCKED peer's context sent AFTER the blocked one. Once the marker is stored the blocked wrap
    // (sent earlier to the same inbox) has been delivered and handled too, so its absence is not a timing artefact.
    const carol = await startPeer(SECRETS.c, [url]);
    const carolGroup = await carol.account.handle.client.groups.create('Marker');
    carol.account.attachGroup(carolGroup);
    const markerSender = createInviteContextSender({ inbox: carol.account.handle.client.extensions, ownPubkey: carol.pubkey, now: () => Date.now() });
    expect(await markerSender.sendAfterInvite({ outcome: { status: 'delivered' } } as never, { to: bob.pubkey, groupId: carolGroup.id, name: 'Marker' })).toBe('sent');
    await expect.poll(() => bob.store.snapshot().map((r) => r.name), { timeout: 20_000 }).toEqual(['Marker']);
    expect(bob.store.snapshot().some((r) => r.sender === alice.pubkey)).toBe(false);
    // positive control: the same wrap is handled once the sender is no longer blocked
    bob.blocked.delete(alice.pubkey);
    await sender.sendAfterInvite({ outcome: { status: 'delivered' } } as never, { to: bob.pubkey, groupId: group.id, name: 'Unblocked' });
    await expect.poll(() => bob.store.snapshot().map((r) => r.name), { timeout: 20_000 }).toEqual(['Marker', 'Unblocked']);
  }, 60_000);
});
