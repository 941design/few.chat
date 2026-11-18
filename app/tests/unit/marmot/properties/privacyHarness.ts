// @vitest-environment node
/** Real clients over FakeRelay; record each outbound attempt before forwarding. */
import 'fake-indexeddb/auto';
import { expect } from 'vitest';
import { rebuildAccountForRelays } from '@/src/lib/marmot/client/relaySettingsRebuild';
import type { BootstrapInput } from '@/src/lib/marmot/client/createClient';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend } from '@941design/marmot';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, inboxRelayList, type AccountClient } from '@/src/lib/marmot/client';
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
import { memoryPort } from '../invitations/inviteContext.fixtures';
import { noPurge } from '../invitations/noPurge';

export const SECRETS = { a: 'a1'.repeat(32), b: 'b2'.repeat(32), c: 'c3'.repeat(32) };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const LABEL = 'Group invitation';

export interface Peer {
  input: BootstrapInput;
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
  disposeViews: () => void;
  bindAccount: (account: AccountClient, relays: string[]) => Promise<void>;
}

export const attempts: import('@941design/nostr-events/event').NostrEvent[] = [];
const relays: FakeRelay[] = [];
const peers: Peer[] = [];

export async function startRelay() {
  const relay = new FakeRelay();
  const url = await relay.start();
  relays.push(relay);
  return { relay, url };
}

export async function startPeer(secretHex: string, defaults: string[]): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  let forward: (d: { kind: string }) => void = () => undefined;
  const blocked = new Set<string>();
  const errors: unknown[] = [];
  let view!: PendingInvitationView;
  const store = createInviteContextStore({ port: memoryPort().port, now: () => Date.now(), getPending: () => (view ? view.pending() : []), onError: (e) => void errors.push(e) });
  await store.load();
  const handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }), onError: (e) => void errors.push(e) });
  const history = createMemoryHistoryBackend();
  const input: BootstrapInput = {
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
    inboxRelayList,
    clientOptions: { historyTimeoutMs: 2000 },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (rs) => {
        const transport = createClientTransport({ relays: rs });
        const real = transport.transport;
        return { ...transport, transport: { ...real, publish: (relays, event, opts) => { attempts.push(structuredClone(event)); return real.publish(relays, event, opts); } } };
      },
    },
  };
  const result = await bootstrapAccountClient(input);
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const sends: Peer['sends'] = [];
  const discards: Peer['discards'] = [];
  let disposeBinding = () => {};
  const peer: Peer = {
    input, account, history, pubkey, store, blocked, sends, errors, discards,
    view: undefined!, actions: undefined!, inviter: undefined!,
    cards: () => buildInvitationCardViewModels(view.pending(), store.snapshot(), LABEL, Date.now()).map((m) => m.displayName),
    disposeViews() {
      disposeBinding();
      view?.dispose();
    },
    async bindAccount(current, configuredRelays) {
      peer.account = current;
      const lookup = createKeyPackageLookup({ transport: current.transport, defaultRelays: configuredRelays, timeoutMs: 4000, allowLocalAdvertised: true });
      const realInbox = current.handle.client.extensions;
      const sender = createInviteContextSender({
        inbox: {
          sendInboxRumor: (payload) => {
            sends.push({ to: payload.to, kind: payload.rumor.kind });
            return realInbox.sendInboxRumor(payload);
          },
        },
        ownPubkey: pubkey,
        now: () => Date.now(),
        onError: (e) => void errors.push(e),
      });
      peer.inviter = createContextSendingInviter({ inviter: createKeyPackageInviter({ lookup, queue: createGroupOpQueue({ syncTimeoutMs: 20_000 }) }), sender });

      const invitations = current.handle.client.invitations;
      view = createPendingInvitationView({
        invitations,
        denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }),
        enqueue: current.handle.enqueue,
        isTrustedSponsor: createTrustedSponsorPredicate(pubkey, () => false),
        now: () => Date.now(),
        onError: (e) => void errors.push(e),
      });
      peer.view = view;
      forward = (disposition) => view.onInboxDisposition(disposition);
      await view.seed();
      const binding = bindInviteContextToPendingView({ view, store, onError: (e) => void errors.push(e) });
      disposeBinding = binding.dispose;
      await binding.reconcileNow();
      const recordingStore = { discard: (invitation: { groupId: string }) => (discards.push({ groupId: invitation.groupId }), store.discard(invitation)) };
      peer.actions = withInviteContextCleanup({
        actions: createInvitationActions({ invitations, view, attachGroup: (g) => current.attachGroup(g), purge: noPurge, onError: (e) => void errors.push(e) }),
        view,
        store: recordingStore,
      });
    },
  };
  await peer.bindAccount(account, defaults);
  peers.push(peer);
  return peer;
}

export async function cleanup() {
  for (const p of peers.splice(0)) {
    p.disposeViews();
    await p.account.teardown();
    expect(p.errors).toEqual([]);
  }
  for (const r of relays.splice(0)) await r.stop();
  attempts.length = 0;
}

export async function rebuild(peer: Peer, relays: string[], previousRelays: string[]) {
  peer.disposeViews();
  const history = Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined });
  const rebuilt = await rebuildAccountForRelays(peer.account, { ...peer.input, relays, history }, previousRelays);
  expect(rebuilt.rotationErrors).toEqual([]);
  if (rebuilt.bootstrap.status !== 'ready') throw new Error(`rebuild ${rebuilt.bootstrap.status}`);
  await peer.bindAccount(rebuilt.bootstrap.account, relays);
  peer.history = history;
  expect(peer.account.ensure.inboxRelayList).toBe('ok');
}

export async function inviteWithContext(from: Peer, to: Peer, name: string) {
  const group = await from.account.handle.client.groups.create(name);
  from.account.attachGroup(group);
  const res = await from.inviter.inviteByPubkey(group as never, to.pubkey);
  if ('error' in res) throw new Error(`invite failed: ${JSON.stringify(res)}`);
  return { group, res };
}
