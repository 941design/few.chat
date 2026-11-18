// @vitest-environment node
/** Real clients over FakeRelay; record each outbound attempt before forwarding. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue, createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import { parseProfilePayload } from '@/src/lib/marmot/profileSync';
import { createGroupProfileActions } from '@/src/lib/marmot/groupSessionProfile';
import { createJoinRequestSender } from '@/src/lib/marmot/joinRequestSender';
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
import { memoryPort } from './invitations/inviteContext.fixtures';
import { noPurge } from './invitations/noPurge';

const SECRETS = { a: 'a1'.repeat(32), b: 'b2'.repeat(32), c: 'c3'.repeat(32) };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const WRAP_KIND = 1059;
const LABEL = 'Group invitation';

interface Peer {
  account: AccountClient;
  history: ReturnType<typeof createMemoryHistoryBackend>;
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

const attempts: import('@941design/nostr-events/event').NostrEvent[] = [];
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
  const history = createMemoryHistoryBackend();
  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: defaults,
    history: Object.assign(history, { sweep: async () => undefined, dispose: () => undefined }),
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
      createTransport: (rs) => {
        transport = createClientTransport({ relays: rs });
        const real = transport.transport;
        return { ...transport, transport: { ...real, publish: (relays, event, opts) => { attempts.push(structuredClone(event)); return real.publish(relays, event, opts); } } };
      },
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
    actions: createInvitationActions({ invitations, view, attachGroup: (g) => account.attachGroup(g), purge: noPurge, onError: (e) => void errors.push(e) }),
    view,
    store: recordingStore,
  });
  const cards = () => buildInvitationCardViewModels(view.pending(), store.snapshot(), LABEL, Date.now()).map((m) => m.displayName);
  const peer: Peer = { account, history, pubkey, inviter, view, store, actions, blocked, sends, errors, discards, cards };
  peers.push(peer);
  return peer;
}

beforeEach(() => {
  peers.length = 0;
  attempts.length = 0;
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


it('AC-PRIV-2: real context invite is wrapped on every publish attempt', async () => {
  const { url } = await startRelay();
  const alice = await startPeer(SECRETS.a, [url]);
  const bob = await startPeer(SECRETS.b, [url]);
  const name = 'private-context-unique-name';
  await inviteWithContext(alice, bob, name);
  await expect.poll(() => bob.cards(), { timeout: 20000 }).toEqual([name]);
  expect(alice.sends).toEqual([{ to: bob.pubkey, kind: INVITE_CONTEXT_KIND }]);
  expect(attempts.filter(e => e.kind === 1059).length).toBeGreaterThanOrEqual(2);
  expect(attempts.some(e => e.kind === INVITE_CONTEXT_KIND)).toBe(false);
  expect(JSON.stringify(attempts)).not.toContain(name);
}, 90000);

it('records attempted publishes through create, invite, accept, chat, profile and join request', async () => {
  const { url } = await startRelay();
  const alice = await startPeer(SECRETS.a, [url]);
  const bob = await startPeer(SECRETS.b, [url]);
  const nickname = 'unique-private-nickname-8493';
  const avatar = 'https://example.test/unique-private-avatar-8493.png';
  const { group } = await inviteWithContext(alice, bob, 'private group');
  await expect.poll(() => bob.view.pending().length, { timeout: 20000 }).toBe(1);
  await bob.actions.accept(bob.view.pending()[0].id);
  await group.synced();
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  try {
    const sender = createGroupRumorSender({ ownPubkey: alice.pubkey, tracker });
    const beforeChat = attempts.length;
    await sender.sendGroupRumor(group, 9, 'privacy chat control', []);
    await expect.poll(() => attempts.slice(beforeChat).some(e => e.kind === 445), { timeout: 15000 }).toBe(true);
    const profile = { nickname, avatar: { imageUrl: avatar } };
    const actions = createGroupProfileActions({ pubkey: alice.pubkey, signer: createPrivateKeySigner(SECRETS.a), sender, writable: () => alice.account.handle.leaseHeld(), groupOf: async id => id === group.id ? group : undefined, profile: () => profile });
    const beforeProfile = attempts.length;
    await actions.sendOwnProfile(group.id);
    await expect.poll(() => attempts.slice(beforeProfile).some(e => e.kind === 445), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => {
      const entries = await bob.history.list(group.id);
      return entries.filter(e => e.rumor.kind === 0).map(e => parseProfilePayload(e.rumor.content)).some(p => p?.nickname === nickname && p.avatar?.imageUrl === avatar);
    }, { timeout: 15000 }).toBe(true);
    const outbound: unknown[] = [];
    const join = createJoinRequestSender({ inbox: bob.account.handle.client.extensions, ownPubkey: bob.pubkey, now: Date.now, saveOutbound: async record => { outbound.push(record); } });
    const beforeJoin = attempts.length;
    await join.send({ adminPubkeyHex: alice.pubkey, nonce: 'privacy-nonce', groupName: 'private group', requesterName: nickname });
    expect(outbound).toHaveLength(1);
    expect(attempts.slice(beforeJoin).some(e => e.kind === 1059)).toBe(true);
    expect(attempts.length).toBeGreaterThan(0);
    for (const event of attempts) {
      expect(event.kind).not.toBe(0);
      if (event.kind !== 1059 && event.kind !== 445) {
        expect(JSON.stringify(event)).not.toContain(nickname);
        expect(JSON.stringify(event)).not.toContain(avatar);
      }
    }
  } finally { tracker.dispose(); }
}, 90000);
