// @vitest-environment node
/**
 * Library harness for S12: REAL @941design/marmot clients over createMemoryStorage() and a FakeRelay, bootstrapped by the
 * app's own bootstrapAccountClient. Bob (requester) sends a join request through the app's inbox sender (real
 * `extensions.sendInboxRumor`); Alice's (admin) handler is registered on the library inbox exactly as the cut-over will
 * (`inboxHandlers.joinRequest`); approval runs through the key-package inviter on Alice's job queue; Bob's invitation lands
 * in his pending list and the auto-accept correlation joins him. Only storage is in memory (ports), nothing is mocked.
 *
 *  AC-JOIN-1   the request is ONE gift wrap (kind 1059) on the relay; no event of any other app kind and no cleartext name;
 *              Alice's handler gets the requester from the delivered rumor.pubkey.
 *  AC-JOIN-2   approval invites Bob with exactly one key package; the request is consumed; Bob's Welcome arrives.
 *  AC-AUTO-1   Bob's matching invitation is accepted exactly once with no second click and the outbound record is consumed;
 *              an invitation from an unrelated sponsor stays pending with zero accepts.
 *  AC-JOIN-3   approving a requester who already holds a leaf makes no commit and surfaces no error.
 *  AC-BLK-1    a join request from a blocked sender leaves nothing and rings nothing.
 *  AC-JOIN-5   a replay of the same rumor (re-sent by the library) produces no second entry.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMemoryHistoryBackend, type MarmotGroup } from '@941design/marmot';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import { createAutoAccept } from '@/src/lib/marmot/invitations/autoAccept';
import {
  createDenyLayer,
  createInvitationActions,
  createKeyPackageInviter,
  createKeyPackageLookup,
  createPendingInvitationView,
  createTrustedSponsorPredicate,
  type InviteGroup,
  type KeyPackageInviter,
  type PendingInvitationView,
} from '@/src/lib/marmot/invitations';
import { createJoinRequestInboxHandler } from '@/src/lib/marmot/joinRequestHandler';
import { createJoinRequestSender } from '@/src/lib/marmot/joinRequestSender';
import { createJoinRequestApproval } from '@/src/lib/marmot/joinRequestApproval';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';
import type { OutboundJoinRequestRecord } from '@/src/lib/marmot/outboundJoinRequests';
import { APP_INBOX_KINDS } from '@/src/lib/marmot/kinds';

const SECRETS = { a: 'a1'.repeat(32), b: 'b2'.repeat(32), c: 'c3'.repeat(32) };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const pub = (hex: string) => getPublicKey(bytes(hex));
const WRAP_KIND = 1059;
const NONCE = 'nonce-harness-1';
const NICKNAME = 'Bobby-Requester-Unique';

interface Peer {
  account: AccountClient;
  pubkey: string;
  blocked: Set<string>;
  errors: unknown[];
  // admin side
  inviter: KeyPackageInviter;
  pendingRequests: PendingJoinRequest[];
  bells: PendingJoinRequest[];
  consumed: PendingJoinRequest[];
  groupsById: Map<string, MarmotGroup>;
  approval: ReturnType<typeof createJoinRequestApproval>;
  inviteLinks: Map<string, { nonce: string; groupId: string; createdAt: number; expiresAt: number; muted: boolean; usageCount: number; expiryNotified: boolean; expiryAcknowledged: boolean }>;
  // requester side
  sender: ReturnType<typeof createJoinRequestSender>;
  outbound: OutboundJoinRequestRecord[];
  view: PendingInvitationView;
  actions: ReturnType<typeof createInvitationActions>;
  auto: ReturnType<typeof createAutoAccept>;
  acceptCalls: string[];
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
  const errors: unknown[] = [];
  const blocked = new Set<string>();
  const pendingRequests: PendingJoinRequest[] = [];
  const bells: PendingJoinRequest[] = [];
  const consumed: PendingJoinRequest[] = [];
  const groupsById = new Map<string, MarmotGroup>();
  const inviteLinks: Peer['inviteLinks'] = new Map();
  const seen = new Set<string>();
  const outbound: OutboundJoinRequestRecord[] = [];
  const acceptCalls: string[] = [];
  let forward: (d: { kind: string }) => void = () => undefined;

  const denyLayer = createDenyLayer({ loadBlockedPeers: () => blocked });
  const joinRequest = createJoinRequestInboxHandler({
    denyLayer,
    inviteLinks: { get: async (nonce) => inviteLinks.get(nonce) },
    memberPubkeys: (groupId) => [...(groupsById.get(groupId)?.members() ?? [])],
    requests: {
      loadAll: async () => [...pendingRequests],
      save: async (r) => void pendingRequests.push(r),
      remove: async (id) => void pendingRequests.splice(0, pendingRequests.length, ...pendingRequests.filter((r) => r.eventId !== id)),
    },
    seen: { has: async (id) => seen.has(id), add: async (id) => void seen.add(id) },
    now: () => Date.now(),
    onReceived: (r) => void bells.push(r),
    onError: (e) => void errors.push(e),
  });

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
    inboxHandlers: { joinRequest, inviteContext: () => undefined },
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
  const client = account.handle.client;
  const lookup = createKeyPackageLookup({ transport: transport!.transport, defaultRelays: defaults, timeoutMs: 4000, allowLocalAdvertised: true });
  const inviter = createKeyPackageInviter({ lookup, queue: createGroupOpQueue({ syncTimeoutMs: 20_000 }) });

  const approval = createJoinRequestApproval({
    inviter,
    getGroup: async (groupId) => ((await client.groups.get(groupId)) as unknown as InviteGroup | undefined) ?? undefined,
    enqueue: account.handle.enqueue,
    consumeRequest: async (r) => {
      const at = pendingRequests.findIndex((p) => p.eventId === r.eventId);
      if (at >= 0) pendingRequests.splice(at, 1);
      consumed.push(r);
    },
    onApproved: () => undefined,
    onError: (e) => void errors.push(e),
  });

  const sender = createJoinRequestSender({
    inbox: client.extensions,
    ownPubkey: pubkey,
    now: () => Date.now(),
    saveOutbound: async (record) => void outbound.push(record),
    onError: (e) => void errors.push(e),
  });

  const real = client.invitations;
  const invitations = {
    pending: () => real.pending(),
    decline: (id: string, o?: { readonly declineRumor?: boolean }) => real.decline(id, o),
    accept: (id: string) => (acceptCalls.push(id), real.accept(id)),
  };
  const view = createPendingInvitationView({
    invitations,
    denyLayer,
    enqueue: account.handle.enqueue,
    isTrustedSponsor: createTrustedSponsorPredicate(pubkey, () => false),
    now: () => Date.now(),
    onError: (e) => void errors.push(e),
  });
  const actions = createInvitationActions({ invitations, view, attachGroup: (g) => account.attachGroup(g), onError: (e) => void errors.push(e) });
  const auto = createAutoAccept({
    view,
    actions,
    enqueue: account.handle.enqueue,
    outbound: {
      loadUnexpiredForAdmin: async (admin) => outbound.filter((r) => r.adminPubkeyHex === admin),
      consume: async (nonce) => {
        const at = outbound.findIndex((r) => r.nonce === nonce);
        if (at >= 0) outbound.splice(at, 1);
      },
    },
    // The sponsor-claimed name (invite context) is simulated as the name the requester's own record carries for that
    // sponsor: the consent check needs a known name, and here it matches.
    groupNameOf: (invitation) => outbound.find((r) => r.adminPubkeyHex === invitation.sponsorAccount.toLowerCase())?.groupName,
    onError: (e) => void errors.push(e),
  });
  forward = (d) => {
    view.onInboxDisposition(d);
    auto.onInboxDisposition(d);
  };
  await view.seed();
  const peer: Peer = { account, pubkey, blocked, errors, inviter, pendingRequests, bells, consumed, groupsById, approval, inviteLinks, sender, outbound, view, actions, auto, acceptCalls };
  peers.push(peer);
  return peer;
}

beforeEach(() => {
  peers.length = 0;
});
afterEach(async () => {
  for (const p of peers.splice(0)) {
    p.view.dispose();
    p.auto.dispose();
    await p.account.teardown().catch(() => undefined);
    expect(p.errors).toEqual([]);
  }
  for (const r of relays.splice(0)) await r.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alice creates a group and a live invite link for it. */
async function adminWithGroup(alice: Peer, name: string, nonce = NONCE) {
  const group = await alice.account.handle.client.groups.create(name);
  alice.account.attachGroup(group);
  alice.groupsById.set(group.id, group);
  const now = Date.now();
  alice.inviteLinks.set(nonce, { nonce, groupId: group.id, createdAt: now, expiresAt: now + 86_400_000, muted: false, usageCount: 0, expiryNotified: false, expiryAcknowledged: false });
  return group;
}

const requestParams = (alice: Peer, name: string, nonce = NONCE) => ({ adminPubkeyHex: alice.pubkey, nonce, groupName: name, requesterName: NICKNAME });

describe('join request over the library inbox, approval, auto-accept', () => {
  it('AC-JOIN-1/2 + AC-AUTO-1: one gift wrap carries the request; approval invites Bob with one key package; Bob auto-joins once; records consumed', async () => {
    const { relay, url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const group = await adminWithGroup(alice, 'Join Club');

    const wrapsBefore = relay.storedEvents.filter((e) => e.kind === WRAP_KIND).length;
    await bob.sender.send(requestParams(alice, 'Join Club'));
    // AC-JOIN-1 write side: the outbound record exists only because the send was delivered
    expect(bob.outbound).toMatchObject([{ nonce: NONCE, adminPubkeyHex: alice.pubkey, groupName: 'Join Club' }]);

    await expect.poll(() => alice.pendingRequests.length, { timeout: 20_000 }).toBe(1);
    const [request] = alice.pendingRequests;
    // the requester is the delivered rumor.pubkey; the group comes from the invite link, not the payload
    expect(request).toMatchObject({ pubkeyHex: bob.pubkey, nonce: NONCE, groupId: group.id, nickname: NICKNAME });
    expect(alice.bells).toHaveLength(1);
    // privacy: exactly one more wrap, nothing of an app kind at top level, no cleartext name anywhere on the relay
    expect(relay.storedEvents.filter((e) => e.kind === WRAP_KIND).length).toBe(wrapsBefore + 1);
    expect(relay.storedEvents.filter((e) => e.kind === APP_INBOX_KINDS.joinRequest || e.kind === 0)).toEqual([]);
    expect(JSON.stringify(relay.storedEvents)).not.toContain(NICKNAME);
    expect(JSON.stringify(relay.storedEvents)).not.toContain(NONCE);

    // AC-JOIN-2: approve; the invite is made inside Alice's queued job with exactly one key-package event
    let inviteArgs: number | undefined;
    const realInvite = group.invite.bind(group);
    (group as unknown as { invite: typeof group.invite }).invite = ((events: Parameters<typeof group.invite>[0]) => {
      inviteArgs = events.length;
      return realInvite(events);
    }) as typeof group.invite;
    const approved = await alice.approval.approve(request);
    expect(approved).toMatchObject({ ok: true, kind: 'invited' });
    expect(inviteArgs).toBe(1);
    expect(alice.consumed.map((r) => r.eventId)).toEqual([request.eventId]);
    expect(alice.pendingRequests).toEqual([]);

    // AC-AUTO-1: Bob is joined without any accept click; the record is consumed; accept ran exactly once
    await expect.poll(async () => (await bob.account.handle.client.groups.list()).map((g) => g.id), { timeout: 30_000 }).toEqual([group.id]);
    await expect.poll(() => bob.outbound.length, { timeout: 10_000 }).toBe(0);
    expect(bob.acceptCalls).toHaveLength(1);
    expect(await bob.account.handle.client.invitations.pending()).toHaveLength(0);
    await expect.poll(() => [...group.members()].sort(), { timeout: 20_000 }).toEqual([alice.pubkey, bob.pubkey].sort());
  }, 120_000);

  it('AC-AUTO-1: an invitation from an unrelated sponsor stays pending with zero accept calls while the request to Alice is outstanding', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const carol = await startPeer(SECRETS.c, [url]);
    await bob.sender.send(requestParams(alice, 'Whatever'));
    expect(bob.outbound).toHaveLength(1);

    const group = await carol.account.handle.client.groups.create('Carol group');
    carol.account.attachGroup(group);
    const res = await carol.inviter.inviteByPubkey(group as unknown as InviteGroup, bob.pubkey);
    if ('error' in res) throw new Error(JSON.stringify(res));

    await expect.poll(() => bob.view.pending().length, { timeout: 20_000 }).toBe(1);
    await sleep(800); // an accept, if one were going to happen, has happened by now
    expect(bob.view.pending()[0].sponsorAccount).toBe(carol.pubkey);
    expect(bob.acceptCalls).toEqual([]);
    expect(await bob.account.handle.client.groups.list()).toHaveLength(0);
    expect(bob.outbound).toHaveLength(1); // the request to Alice is untouched
  }, 90_000);

  it('AC-JOIN-3: approving a requester who already holds a leaf makes no commit and surfaces no error', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const group = await adminWithGroup(alice, 'Already in');
    const res = await alice.inviter.inviteByPubkey(group as unknown as InviteGroup, bob.pubkey);
    if ('error' in res) throw new Error(JSON.stringify(res));
    await expect.poll(async () => (await bob.account.handle.client.invitations.pending()).length, { timeout: 20_000 }).toBe(1);
    const [invitation] = await bob.account.handle.client.invitations.pending();
    await bob.actions.accept(invitation.id);
    await expect.poll(() => [...group.members()].length, { timeout: 20_000 }).toBe(2);

    let invites = 0;
    const realInvite = group.invite.bind(group);
    (group as unknown as { invite: typeof group.invite }).invite = ((events: Parameters<typeof group.invite>[0]) => (invites++, realInvite(events))) as typeof group.invite;
    const stale: PendingJoinRequest = { pubkeyHex: bob.pubkey, nonce: NONCE, groupId: group.id, receivedAt: Date.now(), nickname: NICKNAME, eventId: 'stale-request' };
    alice.pendingRequests.push(stale);
    const approved = await alice.approval.approve(stale);
    expect(approved).toEqual({ ok: true, kind: 'already-member' });
    expect(invites).toBe(0);
    expect(alice.pendingRequests).toEqual([]);
    expect(alice.consumed.map((r) => r.eventId)).toEqual(['stale-request']);
    expect([...group.members()].sort()).toEqual([alice.pubkey, bob.pubkey].sort());
  }, 90_000);

  it('AC-BLK-1 + AC-JOIN-5: a blocked requester leaves nothing and rings nothing; a replayed rumor makes no second entry', async () => {
    const { url } = await startRelay();
    const alice = await startPeer(SECRETS.a, [url]);
    const bob = await startPeer(SECRETS.b, [url]);
    const carol = await startPeer(SECRETS.c, [url]);
    await adminWithGroup(alice, 'Blocklist');
    alice.blocked.add(bob.pubkey);

    await bob.sender.send(requestParams(alice, 'Blocklist'));
    // Carol (not blocked) is processed in the same run, so "nothing yet" below cannot be a slow delivery
    await carol.sender.send(requestParams(alice, 'Blocklist'));
    await expect.poll(() => alice.pendingRequests.length, { timeout: 20_000 }).toBe(1);
    expect(alice.pendingRequests[0].pubkeyHex).toBe(carol.pubkey);
    expect(alice.bells).toHaveLength(1);
    expect(alice.pendingRequests.some((r) => r.pubkeyHex === bob.pubkey)).toBe(false);

    // replay: the same rumor id sent again by the library (a second sendInboxRumor of the identical rumor)
    const first = alice.pendingRequests[0];
    const rumor = { pubkey: carol.pubkey, created_at: 1, kind: APP_INBOX_KINDS.joinRequest, tags: [['p', alice.pubkey]], content: JSON.stringify({ type: 'join_request', nonce: NONCE, name: 'Blocklist' }) };
    const withId = { ...rumor, id: getEventHash(rumor) };
    await carol.account.handle.client.extensions.sendInboxRumor({ to: alice.pubkey, rumor: withId });
    await carol.account.handle.client.extensions.sendInboxRumor({ to: alice.pubkey, rumor: withId });
    await sleep(1200);
    expect(alice.pendingRequests).toEqual([first]);
    expect(alice.bells).toHaveLength(1);
  }, 90_000);
});
