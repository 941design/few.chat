// @vitest-environment node
/**
 * Library harness for the send module (S6): REAL @941design/marmot clients over createMemoryStorage() and a
 * FakeRelay, the app's real HistoryBackend (idb row store on fake-indexeddb) with fixture handlers that route the
 * own echo / own retract into the REAL send helper + ownRowTracker, and the client lifecycle events
 * (`intentFailed`, `groupBranchSwitched`) wired to the tracker exactly as the app will.
 *
 *  AC-SEND-1  a rumor sent through `sendGroupRumor` is delivered to the second member with the identical id, and
 *             the own sink echo carries that id (the optimistic row confirms by it).
 *  AC-SEND-2  a send issued while a proposal is staged delivers after the proposal commits, with NO app-side retry
 *             code (group.send called once); the second member receives the identical id.
 *  A3 (second half)  an own send abandoned before its publish was acknowledged is not delivered while the publish is refused: no sink append,
 *             no sink withdraw, the row ends failed/retry (outbound publish hold + a same-epoch fork).
 *
 * Fork rule (learning): with equal witness scores the branch whose tip committer has the LOWER account pubkey wins.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { groupProfileProposal, type HistoryBackend, type MarmotGroup } from '@941design/marmot';
import type { TransportContract } from '@941design/nostr-events/transport/contract';
import { getPublicKey } from 'nostr-tools/pure';
import { bootstrapAccountClient, createClientTransport, type AccountClient } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createHistoryBackend, createIdbHistoryStore, type GroupHistoryHandlers } from '@/src/lib/marmot/history';
import { createGroupOpQueue, createGroupRumorSender, createOwnRowTracker, type GroupRumorSender, type OwnRowStatus, type OwnRowTracker } from '@/src/lib/marmot/send';

type NostrEvent = import('@941design/nostr-events/event').NostrEvent;

interface HoldableTransport {
  transport: TransportContract;
  /** Holds ALL inbound live events (and times history requests out) while on; flushes in order on off. */
  setPartition(on: boolean): void;
  /** While on, every publish this client makes is held UNACKNOWLEDGED (the call neither resolves nor reaches the relay). */
  holdPublishes(on: boolean): void;
  /** Publishes currently held. */
  heldPublishes(): NostrEvent[];
  /** Forwards every held publish to the relay now. */
  releaseHeld(): void;
  /** Rejects every held publish and keeps rejecting new ones (the relay never takes them) until `holdPublishes(false)`. */
  failHeld(error: Error): void;
  published: NostrEvent[];
}

function holdable(inner: TransportContract): HoldableTransport {
  let partitioned = false;
  let holdOut = false;
  let failOut: Error | undefined;
  const heldIn: Array<() => void> = [];
  const heldOut: Array<{ event: NostrEvent; go: () => void; fail: (e: Error) => void }> = [];
  const published: NostrEvent[] = [];
  return {
    published,
    setPartition(on) {
      partitioned = on;
      if (!on) for (const flush of heldIn.splice(0)) flush();
    },
    holdPublishes(on) {
      holdOut = on;
      if (!on) failOut = undefined;
    },
    failHeld(error) {
      failOut = error;
      for (const h of heldOut.splice(0)) h.fail(error);
    },
    heldPublishes: () => heldOut.map((h) => h.event),
    releaseHeld() {
      for (const h of heldOut.splice(0)) h.go();
    },
    transport: {
      publish: (relays, event, opts) => {
        if (holdOut && failOut) return Promise.reject(failOut) as ReturnType<TransportContract['publish']>;
        if (holdOut) {
          return new Promise((resolve, reject) => {
            heldOut.push({ event, go: () => void inner.publish(relays, event, opts).then(resolve, reject), fail: reject });
          }) as ReturnType<TransportContract['publish']>;
        }
        published.push(event);
        return inner.publish(relays, event, opts);
      },
      requestWithDeadline: async (relays, filters, opts) => {
        if (partitioned) return { events: [], timedOut: true, eosedRelays: [], silentRelays: [...relays] } as never;
        return inner.requestWithDeadline(relays, filters, opts);
      },
      subscription: (relays, filters) => {
        const source = inner.subscription(relays, filters);
        return {
          subscribe(observer) {
            return source.subscribe({
              next: (value, meta) => {
                if (partitioned) heldIn.push(() => observer.next?.(value, meta));
                else observer.next?.(value, meta);
              },
              error: (e) => observer.error?.(e),
              complete: () => observer.complete?.(),
            });
          },
        };
      },
    },
  };
}

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let relay: FakeRelay;
let relayUrl: string;
let dbCounter = 0;
const peers: Peer[] = [];

interface Peer {
  account: AccountClient;
  pubkey: string;
  tracker: OwnRowTracker;
  sender: GroupRumorSender;
  /** Own rows by rumor id: the status the tracker reported last (the app's row state). */
  rowStatus: Map<string, 'sending' | 'confirmed' | 'failed'>;
  /** What the library called on this peer's sink. */
  appendCalls: Array<{ eventId: string; rumorId: string; account: string }>;
  withdrawCalls: Array<{ groupId: string; eventIds: string[] }>;
  /** Rumors the fixture handler received (chat 9 only), by rumor id. */
  received: Map<string, { sender: string; eventId: string }>;
  events: { intentFailed: Array<{ groupId: string; intentId: string }>; branchSwitched: Array<{ groupId: string }> };
  net: () => HoldableTransport;
  group: (id: string) => Promise<MarmotGroup>;
  track: (g: MarmotGroup) => void;
  sendChat: (groupId: string, content: string) => Promise<string>;
}

async function startPeer(secretHex: string, label: string, opts: { confirmTimeoutMs?: number } = {}): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const pubkey = pub(secretHex);
  const rowStatus = new Map<string, 'sending' | 'confirmed' | 'failed'>();
  const tracker = createOwnRowTracker({
    ports: { setStatus: (_g, id, s) => void rowStatus.set(id, s) },
    ...(opts.confirmTimeoutMs ? { timeoutMs: opts.confirmTimeoutMs } : {}),
  });
  const sender = createGroupRumorSender({ ownPubkey: pubkey, tracker });
  const received: Peer['received'] = new Map();
  const appendCalls: Peer['appendCalls'] = [];
  const withdrawCalls: Peer['withdrawCalls'] = [];
  const events: Peer['events'] = { intentFailed: [], branchSwitched: [] };
  let net: HoldableTransport | undefined;

  // The production sink handlers' own-echo contract, routed into the real tracker.
  const handlers: GroupHistoryHandlers = {
    async dispatch({ groupId, rumor, sender: from, eventId }) {
      if (rumor.kind !== 9) return;
      received.set(rumor.id, { sender: from, eventId });
      if (from === pubkey) tracker.onOwnEcho(groupId, rumor.id, eventId);
    },
    async retract({ groupId, rumor, sender: from, eventId }) {
      if (rumor.kind !== 9) return;
      received.delete(rumor.id);
      if (from === pubkey) tracker.onOwnWithdrawn(groupId, rumor.id, eventId);
    },
  };

  const app = createHistoryBackend({ handlers, store: createIdbHistoryStore(`send-harness-${label}-${++dbCounter}`) });
  const recording: HistoryBackend & { sweep: () => Promise<unknown>; dispose: () => void | Promise<void> } = {
    async append(entry) {
      appendCalls.push({ eventId: entry.eventId, rumorId: entry.rumor.id, account: entry.orderingKey.account });
      await app.append(entry);
    },
    async withdraw(groupId, eventIds) {
      withdrawCalls.push({ groupId, eventIds: [...eventIds] });
      await app.withdraw(groupId, eventIds);
    },
    list: (groupId) => app.list(groupId),
    purge: (groupId) => app.purge(groupId),
    sweep: () => app.sweep(),
    dispose: () => app.dispose(),
  };

  const result = await bootstrapAccountClient({
    eventSigner: createPrivateKeySigner(secretHex),
    signerKind: 'local',
    relays: [relayUrl],
    history: recording,
    clientEvents: {
      groupRemoved: () => undefined,
      inboxDisposition: () => undefined,
      welcomeDeclined: () => undefined,
      intentFailed: (p) => {
        events.intentFailed.push({ groupId: p.groupId, intentId: p.intentId });
        tracker.onIntentFailed({ groupId: p.groupId, intentId: p.intentId });
      },
      storeIncompatible: () => undefined,
      groupBranchSwitched: (p) => {
        events.branchSwitched.push({ groupId: p.groupId });
        tracker.onGroupBranchSwitched({ groupId: p.groupId });
      },
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => undefined },
    clientOptions: { historyTimeoutMs: 2000 },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (relays) => {
        const base = createClientTransport({ relays });
        net = holdable(base.transport);
        return { ...base, transport: net.transport };
      },
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const groups = new Map<string, MarmotGroup>();
  const self: Peer = {
    account,
    pubkey,
    tracker,
    sender,
    rowStatus,
    appendCalls,
    withdrawCalls,
    received,
    events,
    net: () => net!,
    async group(id) {
      const cached = groups.get(id);
      if (cached) return cached;
      const found = await account.handle.client.groups.get(id);
      if (!found) throw new Error(`unknown group ${id}`);
      groups.set(id, found);
      return found;
    },
    track(g) {
      groups.set(g.id, g);
      account.attachGroup(g);
    },
    async sendChat(groupId, content) {
      const g = await self.group(groupId);
      const prepared = sender.prepare(g, 9, content, []);
      await prepared.send();
      return prepared.id;
    },
  };
  peers.push(self);
  return self;
}

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

async function pairedGroup(a: Peer, b: Peer, bAdmin = true) {
  const g = await a.account.handle.client.groups.create('Send', bAdmin ? { admins: [b.pubkey] } : undefined);
  a.track(g);
  await inviteInto(a, b, g);
  return g.id;
}

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
});
afterEach(async () => {
  for (const p of peers.splice(0)) {
    p.tracker.dispose();
    await p.account.teardown().catch(() => undefined);
  }
  await relay.stop();
});

/** A SendableGroup over the real group that counts `send` calls (the no-auto-resend / no-app-retry spy). */
function counted(group: MarmotGroup) {
  const calls: unknown[] = [];
  return {
    calls,
    group: {
      id: group.id,
      send: (intent: Parameters<MarmotGroup['send']>[0]) => {
        calls.push(intent);
        return group.send(intent);
      },
      pendingIntents: () => group.pendingIntents(),
    },
  };
}

describe('AC-SEND-1: the helper-sent rumor reaches the member and the own sink echo with the identical id', () => {
  it('B receives the rumor under the canonical id from the MLS account A; A\'s own echo confirms the tracked row by that id', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const ga = counted(await a.group(groupId));

    const prepared = a.sender.prepare(ga.group, 9, 'hello from the helper', [['t', 'x']]);
    expect(a.tracker.statusOf(groupId, prepared.id)).toBe('sending');
    const out = await prepared.send();
    expect(out.id).toBe(prepared.id);
    expect(ga.calls).toHaveLength(1);
    expect(ga.calls[0]).toEqual({ type: 'application', rumor: prepared.rumor });

    await expect.poll(() => b.received.has(prepared.id), { timeout: 20_000 }).toBe(true);
    expect(b.received.get(prepared.id)!.sender).toBe(a.pubkey); // the MLS account, not a rumor field
    await expect.poll(() => a.rowStatus.get(prepared.id), { timeout: 20_000 }).toBe('confirmed');
    const echo = a.received.get(prepared.id)!;
    expect(echo.sender).toBe(a.pubkey);
    // the sink entry is keyed by the kind-445 event id, not the rumor id; both sinks saw the same carrier
    expect(echo.eventId).not.toBe(prepared.id);
    expect(echo.eventId).toBe(b.received.get(prepared.id)!.eventId);
    expect(relay.storedEvents.some((e) => e.kind === 445 && e.id === echo.eventId)).toBe(true);
    expect(a.appendCalls.filter((c) => c.rumorId === prepared.id)).toHaveLength(1);
    expect(ga.calls).toHaveLength(1);
  }, 60_000);
});

describe('AC-SEND-2: a send while a proposal is staged delivers after the proposal commits, with no app-side retry', () => {
  it('B\'s message queues behind B\'s staged proposal, send() resolves only after A commits, and A receives the identical id', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b, false); // B is a plain member: its proposal stays staged until an admin commits
    const ga = await a.group(groupId);
    const gb = counted(await b.group(groupId));
    await (await b.group(groupId)).send({ type: 'proposal', proposal: groupProfileProposal({ name: 'Renamed by B', description: '' }) });

    const prepared = b.sender.prepare(gb.group, 9, 'queued behind the proposal', []);
    let resolved = false;
    const sent = prepared.send().then((r) => {
      resolved = true;
      return r;
    });
    await expect.poll(async () => (await (await b.group(groupId)).pendingIntents()).length, { timeout: 15_000 }).toBe(1);
    await sleep(1500);
    expect(resolved).toBe(false); // held behind the staged proposal
    expect(a.received.has(prepared.id)).toBe(false);
    expect(b.tracker.statusOf(groupId, prepared.id)).toBe('sending');

    await ga.send({ type: 'commit' });
    const out = await sent;
    expect(out.id).toBe(prepared.id);
    await expect.poll(() => a.received.has(prepared.id), { timeout: 20_000 }).toBe(true);
    expect(a.received.get(prepared.id)!.sender).toBe(b.pubkey);
    await expect.poll(() => b.rowStatus.get(prepared.id), { timeout: 20_000 }).toBe('confirmed');
    expect(gb.calls).toHaveLength(1); // the library queued and released it: the app never retried
    expect((await b.group(groupId)).name).toBe('Renamed by B'); // the proposal committed first
  }, 60_000);
});

describe('A3 (second half): an own send abandoned before its publish was acknowledged', () => {
  it('is not delivered while the publish is refused, never withdrawn, still held by the library as a pending intent, and its row ends failed/retry', async () => {
    const x = await startPeer(SECRET_A, 'a');
    const y = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(x, y);
    // Equal witness scores: the branch whose tip committer has the LOWER account pubkey wins.
    const [winner, loser] = x.pubkey < y.pubkey ? [x, y] : [y, x];
    const gw = await winner.group(groupId);
    const gl = counted(await loser.group(groupId));
    const glReal = await loser.group(groupId);
    expect(gw.epoch).toBe(glReal.epoch);

    // 1. a same-epoch fork: both admins commit while neither can hear the other
    const storedBefore = relay.storedEvents.filter((e) => e.kind === 445).length;
    winner.net().setPartition(true);
    loser.net().setPartition(true);
    void gw.rename('Winner branch').catch(() => undefined);
    void glReal.rename('Loser branch').catch(() => undefined);
    await expect.poll(() => relay.storedEvents.filter((e) => e.kind === 445).length - storedBefore, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // 2. the loser sends on its branch; the outbound publish is HELD, so it is never acknowledged
    loser.net().holdPublishes(true);
    const prepared = loser.sender.prepare(gl.group, 9, 'sent on the branch that is abandoned', []);
    let sendError: unknown;
    const sent = prepared.send().catch((e: unknown) => void (sendError = e));
    await expect.poll(() => loser.net().heldPublishes().length, { timeout: 15_000 }).toBe(1);
    const heldEventId = loser.net().heldPublishes()[0].id;
    expect(loser.tracker.statusOf(groupId, prepared.id)).toBe('sending');

    // 3. the winner writes on its branch; heal
    const winnerMessage = await winner.sendChat(groupId, 'sent on the winning branch');
    winner.net().setPartition(false);
    loser.net().setPartition(false);

    // 4. the relay never takes the held publish: send() rejects, the fork resolves against the loser's branch
    loser.net().failHeld(new Error('relay unreachable'));
    await sent;
    expect((sendError as { code?: string } | undefined)?.code).toBe('publish-failed');
    await expect.poll(() => glReal.name, { timeout: 30_000 }).toBe('Winner branch');
    await expect.poll(() => loser.received.has(winnerMessage), { timeout: 30_000 }).toBe(true);
    expect(loser.received.get(winnerMessage)!.sender).toBe(winner.pubkey);

    // not delivered while the publish is refused: no sink append of the abandoned rumor, on either side, and the
    // relay never saw its event. The library still HOLDS the intent (pending-publish): it is not dropped, so the row's
    // failed state is the app's view of a send that may yet go out, which is why a retry re-sends the same rumor id.
    const held = (await glReal.pendingIntents()).filter((i) => i.kind === 'application');
    expect(held.map((i) => i.state)).toEqual(['pending-publish']);
    expect(loser.appendCalls.map((c) => c.rumorId)).not.toContain(prepared.id);
    expect(winner.appendCalls.map((c) => c.rumorId)).not.toContain(prepared.id);
    expect(relay.storedEvents.some((e) => e.id === heldEventId)).toBe(false);
    // never withdrawn: the abandoned message was never in the sink, so the library has nothing to withdraw
    expect(loser.withdrawCalls).toEqual([]);
    expect(winner.withdrawCalls).toEqual([]);
    // the row ends failed/retry and was sent exactly once (no auto-resend)
    expect(loser.tracker.statusOf(groupId, prepared.id)).toBe('failed');
    expect(loser.rowStatus.get(prepared.id)).toBe('failed');
    expect(gl.calls).toHaveLength(1);
    expect(loser.received.has(prepared.id)).toBe(false);
  }, 120_000);
});

describe('AC-WDR-2 end to end: an own CONFIRMED message on the losing branch is withdrawn and ends failed/retry', () => {
  it('the loser\'s sink withdraws its own confirmed message; the tracker reports failed; the winner\'s row stays confirmed', async () => {
    const x = await startPeer(SECRET_A, 'a');
    const y = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(x, y);
    const [winner, loser] = x.pubkey < y.pubkey ? [x, y] : [y, x];
    const gw = await winner.group(groupId);
    const gl = counted(await loser.group(groupId));
    const glReal = await loser.group(groupId);

    const storedBefore = relay.storedEvents.filter((e) => e.kind === 445).length;
    winner.net().setPartition(true);
    loser.net().setPartition(true);
    void gw.rename('Winner branch').catch(() => undefined);
    void glReal.rename('Loser branch').catch(() => undefined);
    await expect.poll(() => relay.storedEvents.filter((e) => e.kind === 445).length - storedBefore, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const lost = loser.sender.prepare(gl.group, 9, 'confirmed on the losing branch', []);
    const won = winner.sender.prepare(await winner.group(groupId), 9, 'confirmed on the winning branch', []);
    await Promise.all([lost.send(), won.send()]);
    await expect.poll(() => loser.rowStatus.get(lost.id) === 'confirmed' && winner.rowStatus.get(won.id) === 'confirmed', { timeout: 20_000 }).toBe(true);

    winner.net().setPartition(false);
    loser.net().setPartition(false);

    await expect.poll(() => loser.withdrawCalls.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => loser.rowStatus.get(lost.id), { timeout: 30_000 }).toBe('failed');
    expect(loser.tracker.statusOf(groupId, lost.id)).toBe('failed' satisfies OwnRowStatus);
    expect(gl.calls).toHaveLength(1); // not auto-resent
    expect(winner.rowStatus.get(won.id)).toBe('confirmed');
    expect(winner.withdrawCalls).toEqual([]);
    // the winner's message arrives on the loser's branch and the lost one never reaches the winner
    await expect.poll(() => loser.received.has(won.id), { timeout: 30_000 }).toBe(true);
    expect(winner.received.has(lost.id)).toBe(false);
  }, 120_000);
});

describe('S6 hardening against the real library', () => {
  // A real `commit-pending` behind an own pending commit is NOT reachable through the public API: after a refused
  // publish the commit stays a durable pending-publish intent, but the library resumes (publishes) it at the start
  // of the next group op, so a sequential op never sees it, and concurrent ops are serialised by the library's own
  // group queue (a held publish blocks them rather than refusing). The reason branches are therefore covered by the
  // unit tests (groupOpQueue.bounded) over the documented error shapes; this checks the real-group composition.
  it('runCommit over a real group after a refused commit publish: synced() first, then the op commits (the library resumes the pending commit)', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const ga = await a.group(groupId);
    a.net().holdPublishes(true);
    const first = ga.rename('first').catch((e: unknown) => e);
    await expect.poll(() => a.net().heldPublishes().length, { timeout: 15_000 }).toBe(1);
    a.net().failHeld(new Error('relay unreachable'));
    expect((await first) as { code?: string }).toMatchObject({ code: 'publish-failed' });
    expect((await ga.pendingIntents()).map((i) => i.state)).toEqual(['pending-publish']);
    a.net().holdPublishes(false);

    await createGroupOpQueue().rename(ga, 'second');
    expect(ga.name).toBe('second');
    expect(await ga.pendingIntents()).toEqual([]);
  }, 90_000);
});
