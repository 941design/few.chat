// @vitest-environment node
/**
 * AC-FORGE-1 / AC-FORGE-2 (harness half): two REAL @941design/marmot clients
 * (Alice, Mallory) in one group over a FakeRelay and createMemoryStorage(),
 * each with the app's real history sink, the real kind-9 handler on the
 * sink path and the real chat store.
 *
 *  - A rumor whose inner `pubkey` is Alice's but that Mallory's MLS leaf sent
 *    never reaches the observer's sink handlers and is never rendered (the chat
 *    store has no row for it). A control message sent right after it by Mallory
 *    proves the delivery path is live (a test that only asserts "nothing
 *    arrived" would pass against a dead subscription).
 *  - A genuine Alice message is rendered at Mallory, attributed to Alice
 *    (the sender comes from the MLS leaf: `orderingKey.account`).
 *
 * chatPersistence is process-global, so each peer's chat store is namespaced
 * by wrapping the handler deps (`<peer>:<groupId>`); the SUT (handler,
 * dispatch, sink, chatPersistence) is real.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import type { MarmotGroup } from '@941design/marmot';
import { bootstrapAccountClient, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createHistoryBackend, createIdbHistoryStore, type GroupRumorInput, type RetractInput } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createChatGroupHandler } from '@/src/lib/marmot/handlers/chatHandler';
import { appendMessage, appendOrAddCarrier, hasMessage, loadMessages, retractMessageCarrier } from '@/src/lib/marmot/chatPersistence';

type NostrEvent = import('@941design/nostr-events/event').NostrEvent;

const SECRET_ALICE = 'a1'.repeat(32);
const SECRET_MALLORY = 'e5'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));

let relay: FakeRelay;
let relayUrl: string;
let dbCounter = 0;
const peers: Peer[] = [];

interface Peer {
  label: string;
  pubkey: string;
  account: AccountClient;
  dispatched: GroupRumorInput[];
  group: (id: string) => Promise<MarmotGroup>;
  track: (g: MarmotGroup) => void;
  /** Rows of this peer's chat store for a group. */
  rows: (groupId: string) => Promise<Array<{ id: string; senderPubkey: string; content: string }>>;
  send: (groupId: string, content: string, claimedPubkey?: string) => Promise<string>;
}

const unexpected = (name: string) => () => {
  throw new Error(`unexpected dep call: ${name}`);
};

async function startPeer(secretHex: string, label: string): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const dispatched: GroupRumorInput[] = [];
  const pubkey = pub(secretHex);
  const ns = (g: string) => `${label}:${g}`;

  const chat = createChatGroupHandler({
    appendMessage: (g, m) => appendMessage(ns(g), { ...m, groupId: ns(g) }),
    incrementUnread: () => undefined,
    markAsRead: () => undefined,
    setChatVersion: () => undefined,
    applyDeleteEditSignal: unexpected('applyDeleteEditSignal') as never,
    resolvePendingSignalsForSlot: async () => ({ thread: { kind: 'group', groupId: '' }, slotId: null, kind: 'noop' }),
    groupOf: async () => undefined,
    getPoll: unexpected('getPoll') as never,
    loadVotes: unexpected('loadVotes') as never,
    saveVoteIfNewer: unexpected('saveVoteIfNewer') as never,
    loadPendingVotes: unexpected('loadPendingVotes') as never,
    removePendingVotes: unexpected('removePendingVotes') as never,
    queuePendingCloseAnnouncement: unexpected('queuePendingCloseAnnouncement') as never,
    loadPendingCloseAnnouncements: unexpected('loadPendingCloseAnnouncements') as never,
    removePendingCloseAnnouncements: unexpected('removePendingCloseAnnouncements') as never,
    appendOrAddCarrier: (g, m, e) => appendOrAddCarrier(ns(g), { ...m, groupId: ns(g) }, e),
    retractMessageCarrier: (g, r, e, snd) => retractMessageCarrier(ns(g), r, e, snd),
    removeMessages: async () => 0,
    releaseHeldReactions: async () => false,
    setReactionsVersion: () => undefined,
    hasMessage: (g, id) => hasMessage(ns(g), id),
    recomputeUnread: () => undefined,
    rememberKnownPeer: () => undefined,
    onOwnEcho: () => undefined,
    onOwnWithdrawn: () => undefined,
    recomputeSlot: async () => undefined,
    recomputeMessageReactions: async () => false,
  });
  const dispatcher = createGroupRumorDispatch({ handlers: [chat], env: { selfPubkeyHex: pubkey, getActiveGroupId: () => null } });
  const recording = {
    dispatch: async (input: GroupRumorInput) => {
      dispatched.push(input);
      await dispatcher.dispatch(input);
    },
    retract: (input: RetractInput) => dispatcher.retract(input),
  };
  const app = createHistoryBackend({ handlers: recording, store: createIdbHistoryStore(`forgery-${label}-${++dbCounter}`) });

  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: [relayUrl],
    history: app,
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
    onError: () => undefined,
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const groups = new Map<string, MarmotGroup>();
  const peer: Peer = {
    label,
    pubkey,
    account,
    dispatched,
    track: (g) => {
      groups.set(g.id, g);
      account.attachGroup(g);
    },
    async group(id) {
      const cached = groups.get(id);
      if (cached) return cached;
      const found = await account.handle.client.groups.get(id);
      if (!found) throw new Error(`unknown group ${id}`);
      groups.set(id, found);
      return found;
    },
    async rows(groupId) {
      const { messages } = await loadMessages(ns(groupId));
      return messages.map((m) => ({ id: m.id, senderPubkey: m.senderPubkey, content: m.content }));
    },
    async send(groupId, content, claimedPubkey) {
      const g = await peer.group(groupId);
      const unsigned = { pubkey: claimedPubkey ?? pubkey, created_at: Math.floor(Date.now() / 1000), kind: 9, tags: [] as string[][], content };
      const id = getEventHash(unsigned);
      await g.send({ type: 'application', rumor: { ...unsigned, id } });
      return id;
    },
  };
  peers.push(peer);
  return peer;
}

/** `inviter` invites `invitee` into `g`; resolves once the invitee joined and both are synced. */
async function inviteInto(inviter: Peer, invitee: Peer, g: MarmotGroup) {
  const kp = await new Promise<NostrEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no key package observed')), 20_000);
    const stop = inviter.account.handle.client.keyPackages.observe(invitee.pubkey, (event) => {
      clearTimeout(timer);
      queueMicrotask(stop);
      resolve(event);
    });
  });
  await g.synced();
  const outcomes = await g.invite([kp]);
  expect(outcomes[0].status).toBe('delivered');
  await expect.poll(async () => (await invitee.account.handle.client.invitations.pending()).length, { timeout: 15_000 }).toBe(1);
  const pending = await invitee.account.handle.client.invitations.pending();
  const joined = await invitee.account.handle.client.invitations.accept(pending[0].id);
  invitee.track(joined);
  await g.synced();
  await joined.synced();
}

async function pairedGroup(alice: Peer, mallory: Peer) {
  const g = await alice.account.handle.client.groups.create('Forgery', { admins: [] });
  alice.track(g);
  await inviteInto(alice, mallory, g);
  return g.id;
}

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
});
afterEach(async () => {
  for (const p of peers.splice(0)) await p.account.teardown().catch(() => undefined);
  await relay.stop();
});

describe('AC-FORGE-1: a rumor forged to carry another member\'s pubkey is never rendered', () => {
  it('Mallory sends a kind-9 rumor claiming Alice\'s pubkey: Alice\'s sink handlers never see it and no row exists; a control message and a genuine Alice message render with the right sender', async () => {
    const alice = await startPeer(SECRET_ALICE, 'alice');
    const mallory = await startPeer(SECRET_MALLORY, 'mallory');
    const groupId = await pairedGroup(alice, mallory);

    // the forgery: inner pubkey = Alice, sent by Mallory's MLS leaf (the library may refuse at send or drop at receive)
    // The receive-side drop is what is under test: the forged send must RESOLVE. If a future
    // library refuses at send, this fails loudly instead of silently testing something else.
    const forgedId = await mallory.send(groupId, 'FORGED: I am Alice', alice.pubkey);
    // control: a genuine Mallory message published after the forgery proves Alice's path is live
    const controlId = await mallory.send(groupId, 'control from Mallory');
    await expect.poll(async () => (await alice.rows(groupId)).map((r) => r.id), { timeout: 15_000 }).toContain(controlId);
    await new Promise((r) => setTimeout(r, 500));

    const aliceRows = await alice.rows(groupId);
    expect(aliceRows.find((r) => r.id === controlId)).toMatchObject({ senderPubkey: mallory.pubkey, content: 'control from Mallory' });
    expect(aliceRows.some((r) => r.id === forgedId || r.content.startsWith('FORGED'))).toBe(false);
    expect(aliceRows.some((r) => r.senderPubkey === alice.pubkey)).toBe(false);
    // never reached the sink's handlers either
    expect(alice.dispatched.some((i) => i.rumor.id === forgedId || i.rumor.content.startsWith('FORGED'))).toBe(false);
    expect(alice.dispatched.every((i) => i.sender === mallory.pubkey)).toBe(true);

    // genuine Alice message: rendered at Mallory, attributed to Alice
    const genuineId = await alice.send(groupId, 'genuine from Alice');
    await expect.poll(async () => (await mallory.rows(groupId)).map((r) => r.id), { timeout: 15_000 }).toContain(genuineId);
    const malloryRows = await mallory.rows(groupId);
    expect(malloryRows.find((r) => r.id === genuineId)).toMatchObject({ senderPubkey: alice.pubkey, content: 'genuine from Alice' });
    // Mallory's own device may keep its own forged send (the library does not re-validate a sender's own echo);
    // even there it is attributed to the MLS sender (Mallory), never to the pubkey the rumor claims.
    expect(malloryRows.filter((r) => r.content.startsWith('FORGED')).every((r) => r.senderPubkey === mallory.pubkey)).toBe(true);
    expect(malloryRows.some((r) => r.senderPubkey === alice.pubkey && r.id !== genuineId)).toBe(false);
    expect(mallory.dispatched.find((i) => i.rumor.id === genuineId)?.sender).toBe(alice.pubkey);
  });
});

describe('AC-FORGE-2: attribution of a group message comes from the MLS sender', () => {
  it('a message sent by a member renders at the other member attributed to that sender', async () => {
    const alice = await startPeer(SECRET_ALICE, 'alice');
    const mallory = await startPeer(SECRET_MALLORY, 'mallory');
    const groupId = await pairedGroup(alice, mallory);
    const id = await mallory.send(groupId, 'from the sender');
    await expect.poll(async () => (await alice.rows(groupId)).map((r) => r.id), { timeout: 15_000 }).toContain(id);
    expect((await alice.rows(groupId)).find((r) => r.id === id)?.senderPubkey).toBe(mallory.pubkey);
  });
});
