// @vitest-environment node
/** Real boot, MLS groups, history dispatch and namespaced chat stores for sender-binding properties. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect } from 'vitest';
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

export const SECRET_ALICE = 'a1'.repeat(32);
export const SECRET_MALLORY = 'e5'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));

let relay: FakeRelay;
let relayUrl: string;
let dbCounter = 0;
const peers: Peer[] = [];

export interface Peer {
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

export async function startPeer(secretHex: string, label: string): Promise<Peer> {
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
export async function inviteInto(inviter: Peer, invitee: Peer, g: MarmotGroup) {
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

export async function pairedGroup(alice: Peer, mallory: Peer) {
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
