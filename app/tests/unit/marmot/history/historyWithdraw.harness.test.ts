// @vitest-environment node
/**
 * Library harness for the app history sink (S3): REAL @941design/marmot clients
 * over createMemoryStorage() and a FakeRelay, with the app's real HistoryBackend
 * (idb row store on fake-indexeddb) and fixture handlers writing a chat map.
 *
 *  AC-WDR-5  a fork rewind in the library abandons a message: the library calls
 *            the sink's `withdraw`, which retracts the message and removes its
 *            chat row from the app store. (Observed library behaviour, spec A3:
 *            with two members the abandoned message is the loser's own,
 *            already-confirmed one; the winner never appended it, so it never
 *            sees a withdraw.) Also: the sink delivered the winner's message and
 *            the row store ends up consistent with the chat map.
 *            Three members (A, B, C): the observer on the losing branch withdraws ANOTHER member's
 *            (C's) message, the AC-WDR-5 literal. The fork is staged deterministically: C follows the
 *            observer's commit, the winner's events are held back from both, and the winner is the
 *            lower-pubkey committer (equal witness scores).
 *  A1        a handler failure inside the sink makes the library retry `append`
 *            until it lands (throw-to-retry through the real backend).
 *  Re-entrancy  a handler that enqueues follow-up client work as its FIRST
 *            action (before its own awaits) runs that job inside the still-live
 *            library frame: the job's account-scope call rejects with
 *            `reentrant`, reported as step `queuedJob`. Enqueuing as the LAST
 *            action (after the handler's own awaits) works. This documents the
 *            ClientJobQueue invariant the concrete handlers (S4/S5) must honour.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import type { HistoryBackend, MarmotGroup } from '@941design/marmot';
import { bootstrapAccountClient, createClientTransport, type AccountClient, type BootstrapStep } from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import type { TransportContract } from '@941design/nostr-events/transport/contract';
import { createHistoryBackend, createIdbHistoryStore, type GroupHistoryHandlers, type GroupRumorInput } from '@/src/lib/marmot/history';

type NostrEvent = import('@941design/nostr-events/event').NostrEvent;

interface PartitionableTransport {
  transport: TransportContract;
  /** Holds ALL inbound live events (and times history requests out) while on; flushes in order on off. */
  setPartition(on: boolean): void;
  /**
   * Holds only the inbound live events `pred` matches (evaluated at delivery time and again on every change);
   * history requests drop them from their result instead of timing out. `null` releases everything, in order.
   */
  holdOnly(pred: ((event: NostrEvent) => boolean) | null): void;
  /** Every event this client published, in order. */
  published: NostrEvent[];
}

/**
 * Holds inbound live events back while partitioned (flushed in order on heal)
 * and makes history requests report a timeout; publishes still go out. Stages a
 * same-epoch fork between two clients. (Kept local: the dev smoke hook this
 * pattern came from is deleted with the smoke spec.)
 */
function partitionable(inner: TransportContract): PartitionableTransport {
  let mode: 'off' | 'all' | 'pred' = 'off';
  let pred: ((event: NostrEvent) => boolean) | null = null;
  const held: Array<{ event: NostrEvent; flush: () => void }> = [];
  const published: NostrEvent[] = [];
  const holds = (event: NostrEvent) => mode === 'all' || (mode === 'pred' && !!pred && pred(event));
  const release = () => {
    for (const item of [...held]) {
      if (holds(item.event)) continue;
      held.splice(held.indexOf(item), 1);
      item.flush();
    }
  };
  return {
    published,
    setPartition(on) {
      mode = on ? 'all' : 'off';
      pred = null;
      release();
    },
    holdOnly(next) {
      mode = next ? 'pred' : 'off';
      pred = next;
      release();
    },
    transport: {
      publish: (relays, event, opts) => {
        published.push(event);
        return inner.publish(relays, event, opts);
      },
      requestWithDeadline: async (relays, filters, opts) => {
        if (mode === 'all') return { events: [], timedOut: true, eosedRelays: [], silentRelays: [...relays] } as never;
        const result = await inner.requestWithDeadline(relays, filters, opts);
        if (mode === 'pred') return { ...result, events: result.events.filter((e: NostrEvent) => !holds(e)) } as never;
        return result;
      },
      subscription: (relays, filters) => {
        const source = inner.subscription(relays, filters);
        return {
          subscribe(observer) {
            return source.subscribe({
              next: (value, meta) => {
                if (holds(value)) held.push({ event: value, flush: () => observer.next?.(value, meta) });
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
const SECRET_C = 'c3'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let relay: FakeRelay;
let relayUrl: string;
let dbCounter = 0;
const peers: Peer[] = [];

interface ChatRow {
  sender: string;
  content: string;
  eventId: string;
}

interface Peer {
  account: AccountClient;
  chat: Map<string, ChatRow>;
  withdrawCalls: Array<{ groupId: string; eventIds: string[] }>;
  retractCalls: GroupRumorInput[];
  appendAttempts: Array<{ eventId: string; threw: boolean }>;
  errors: Array<{ step: BootstrapStep; error: unknown }>;
  partition: () => PartitionableTransport;
  failNextDispatches: (n: number) => void;
  group: (id: string) => Promise<MarmotGroup>;
  send: (groupId: string, content: string) => Promise<string>;
  pubkey: string;
}

async function startPeer(secretHex: string, label: string, handlerOverride?: (peer: () => Peer, base: GroupHistoryHandlers) => GroupHistoryHandlers): Promise<Peer> {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const chat = new Map<string, ChatRow>();
  const retractCalls: GroupRumorInput[] = [];
  const appendAttempts: Peer['appendAttempts'] = [];
  const withdrawCalls: Peer['withdrawCalls'] = [];
  const errors: Peer['errors'] = [];
  let failures = 0;
  let partition: PartitionableTransport | undefined;
  let self!: Peer;

  const base: GroupHistoryHandlers = {
    async dispatch({ rumor, sender, eventId }) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('fixture handler: injected failure');
      }
      if (rumor.kind === 9) chat.set(rumor.id, { sender, content: rumor.content, eventId });
    },
    async retract(input) {
      retractCalls.push(input);
      chat.delete(input.rumor.id);
    },
  };
  const handlers = handlerOverride ? handlerOverride(() => self, base) : base;
  const app = createHistoryBackend({ handlers, store: createIdbHistoryStore(`harness-${label}-${++dbCounter}`) });
  // record what the LIBRARY calls on the sink, delegating to the real backend
  const recording: HistoryBackend & { sweep: () => Promise<unknown>; dispose: () => void | Promise<void> } = {
    async append(entry) {
      const call = { eventId: entry.eventId, threw: false };
      appendAttempts.push(call);
      try {
        await app.append(entry);
      } catch (error) {
        call.threw = true;
        throw error;
      }
    },
    async withdraw(groupId, eventIds) {
      withdrawCalls.push({ groupId, eventIds: [...eventIds] });
      await app.withdraw(groupId, eventIds);
    },
    list: (groupId) => app.list(groupId),
    purge: (groupId) => app.purge(groupId),
    sweep: () => app.sweep(), // the bootstrap runs it after groups.list()
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
      intentFailed: () => undefined,
      storeIncompatible: () => undefined,
      groupBranchSwitched: () => undefined,
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => undefined },
    clientOptions: { historyTimeoutMs: 2000 },
    onError: (step, error) => void errors.push({ step, error }),
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
      createTransport: (relays) => {
        const base = createClientTransport({ relays });
        partition = partitionable(base.transport);
        return { ...base, transport: partition.transport };
      },
    },
  });
  if (result.status !== 'ready') throw new Error(`bootstrap ${JSON.stringify(result)}`);
  const account = result.account;
  const pubkey = account.handle.pubkey;
  const groups = new Map<string, MarmotGroup>();
  self = {
    account,
    chat,
    withdrawCalls,
    retractCalls,
    appendAttempts,
    errors,
    pubkey,
    partition: () => partition!,
    failNextDispatches: (n) => void (failures = n),
    async group(id) {
      const cached = groups.get(id);
      if (cached) return cached;
      const found = await account.handle.client.groups.get(id);
      if (!found) throw new Error(`unknown group ${id}`);
      groups.set(id, found);
      return found;
    },
    async send(groupId, content) {
      const g = await self.group(groupId);
      const unsigned = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: 9, tags: [] as string[][], content };
      const id = getEventHash(unsigned);
      await g.send({ type: 'application', rumor: { ...unsigned, id } });
      return id;
    },
  };
  // expose group registration for the pairing helpers
  (self as Peer & { track: (g: MarmotGroup) => void }).track = (g) => {
    groups.set(g.id, g);
    account.attachGroup(g);
  };
  peers.push(self);
  return self;
}

const track = (p: Peer, g: MarmotGroup) => (p as Peer & { track: (g: MarmotGroup) => void }).track(g);

/** `inviter` (a member holding `g`) invites `invitee`; resolves once the invitee has joined and both are synced. */
async function inviteInto(inviter: Peer, invitee: Peer, g: MarmotGroup) {
  const kp = await new Promise<import('@941design/nostr-events/event').NostrEvent>((resolve, reject) => {
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
  await expect
    .poll(async () => (await invitee.account.handle.client.invitations.pending()).length, { timeout: 15_000 })
    .toBe(1);
  const pending = await invitee.account.handle.client.invitations.pending();
  const joined = await invitee.account.handle.client.invitations.accept(pending[0].id);
  track(invitee, joined);
  await g.synced();
  await joined.synced();
}

async function pairedGroup(a: Peer, b: Peer) {
  const g = await a.account.handle.client.groups.create('History', { admins: [b.pubkey] });
  track(a, g);
  await inviteInto(a, b, g);
  return g.id;
}

/** `a` creates the group (B is an admin as well), then invites `b` and `c`; all three end on the same epoch. */
async function trioGroup(a: Peer, b: Peer, c: Peer) {
  const g = await a.account.handle.client.groups.create('History', { admins: [b.pubkey] });
  track(a, g);
  await inviteInto(a, b, g);
  await inviteInto(a, c, g);
  const gb = await b.group(g.id);
  const gc = await c.group(g.id);
  await expect.poll(() => gb.epoch === g.epoch && gc.epoch === g.epoch, { timeout: 20_000 }).toBe(true);
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

describe('AC-WDR-5: a library fork rewind withdraws the abandoned message from the app store', () => {
  it('stages a same-epoch fork; the loser withdraws its branch message through the real sink and its chat row is removed', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    const ga = await a.group(groupId);
    const gb = await b.group(groupId);
    expect(ga.epoch).toBe(gb.epoch);

    a.partition().setPartition(true);
    b.partition().setPartition(true);
    void ga.rename('A-branch').catch(() => undefined);
    void gb.rename('B-branch').catch(() => undefined);
    await expect.poll(() => relay.storedEvents.filter((e) => e.kind === 445).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const idA = await a.send(groupId, 'on branch A');
    const idB = await b.send(groupId, 'on branch B');
    // each side's own confirmed message reached its OWN app store through the sink
    await expect.poll(() => a.chat.has(idA) && b.chat.has(idB), { timeout: 15_000 }).toBe(true);
    expect(a.chat.get(idA)!.sender).toBe(a.pubkey);
    expect(b.chat.get(idB)!.sender).toBe(b.pubkey);
    const eventIdA = a.chat.get(idA)!.eventId;
    const eventIdB = b.chat.get(idB)!.eventId;

    a.partition().setPartition(false);
    b.partition().setPartition(false);

    // exactly one branch loses; the library tells that sink to withdraw the branch's kind-445 id
    await expect.poll(() => a.withdrawCalls.length + b.withdrawCalls.length, { timeout: 30_000 }).toBe(1);
    const aLost = a.withdrawCalls.length === 1;
    const loser = aLost ? a : b;
    const winner = aLost ? b : a;
    const lostId = aLost ? idA : idB;
    const lostEvent = aLost ? eventIdA : eventIdB;
    const wonId = aLost ? idB : idA;

    expect(loser.withdrawCalls[0]).toEqual({ groupId, eventIds: [lostEvent] });
    expect(winner.withdrawCalls).toEqual([]);

    // the sink retracted the withdrawn message: its chat row is gone, the retract saw the right sender
    await expect.poll(() => loser.chat.has(lostId), { timeout: 30_000 }).toBe(false);
    expect(loser.retractCalls.map((r) => [r.eventId, r.rumor.id, r.sender])).toEqual([[lostEvent, lostId, loser.pubkey]]);
    // the winning branch's message reaches the loser's app store; the winner never held the lost one
    await expect.poll(() => loser.chat.has(wonId), { timeout: 30_000 }).toBe(true);
    expect(winner.chat.has(lostId)).toBe(false);
    expect(winner.chat.has(wonId)).toBe(true);
    expect(winner.retractCalls).toEqual([]);

    // the durable row store agrees with the chat map: lost row deleted, winner row present
    const historyIds: string[] = [];
    for await (const rumor of (await loser.group(groupId)).history()) historyIds.push(rumor.id);
    expect(historyIds).not.toContain(lostId);
    expect(historyIds).toContain(wonId);
  }, 90_000);
});

describe('AC-WDR-5 with three members: a rewound branch withdraws ANOTHER member\'s message', () => {
  it('observer O on the losing branch appended C\'s message; the fork resolves against O\'s branch and O\'s sink removes C\'s chat row', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const c = await startPeer(SECRET_C, 'c');
    const groupId = await trioGroup(a, b, c);

    // Branch choice is deterministic: with equal witness scores (one distinct sender on each branch) the branch whose
    // tip committer has the LOWER account pubkey wins (convergence "Branch selection"). W wins, O loses.
    const [winner, observer] = a.pubkey < b.pubkey ? [a, b] : [b, a];
    const gw = await winner.group(groupId);
    const go = await observer.group(groupId);
    const gc = await c.group(groupId);
    const baseEpoch = gw.epoch;
    expect([go.epoch, gc.epoch]).toEqual([baseEpoch, baseEpoch]);

    // 1. everyone is cut off while the two competing same-epoch commits are made
    const storedBefore = relay.storedEvents.filter((e) => e.kind === 445).length;
    for (const p of [a, b, c]) p.partition().setPartition(true);
    void gw.rename('W-branch').catch(() => undefined);
    void go.rename('O-branch').catch(() => undefined);
    await expect.poll(() => relay.storedEvents.filter((e) => e.kind === 445).length - storedBefore, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // 2. O and C see everything EXCEPT what W publishes: C follows O's commit (branch X), W stays alone on branch Y
    const fromW = (event: NostrEvent) => winner.partition().published.some((p) => p.id === event.id);
    observer.partition().holdOnly(fromW);
    c.partition().holdOnly(fromW);
    await expect.poll(() => gc.epoch, { timeout: 20_000 }).toBe(baseEpoch + 1n);

    // 3. C writes on branch X; O (on X) appends C's message through its sink. W writes on branch Y.
    const idC = await c.send(groupId, 'from C on the losing branch');
    const idW = await winner.send(groupId, 'from W on the winning branch');
    await expect.poll(() => observer.chat.has(idC), { timeout: 20_000 }).toBe(true);
    expect(observer.chat.get(idC)!.sender).toBe(c.pubkey); // another member's message, not O's own
    expect(observer.chat.get(idC)!.sender).not.toBe(observer.pubkey);
    const eventIdC = observer.chat.get(idC)!.eventId;
    expect(observer.chat.has(idW)).toBe(false);
    expect(observer.withdrawCalls).toEqual([]);

    // 4. heal: the fork resolves against branch X
    for (const p of [a, b, c]) p.partition().holdOnly(null);

    await expect.poll(() => observer.withdrawCalls.flatMap((w) => w.eventIds), { timeout: 30_000 }).toContain(eventIdC);
    expect(observer.withdrawCalls).toEqual([{ groupId, eventIds: [eventIdC] }]);
    // O's sink retracted C's message: its chat row is gone and the retract saw C as the authenticated sender
    await expect.poll(() => observer.chat.has(idC), { timeout: 30_000 }).toBe(false);
    expect(observer.retractCalls.map((r) => [r.eventId, r.rumor.id, r.sender])).toEqual([[eventIdC, idC, c.pubkey]]);
    // O lands on the winning branch: W's message arrives, W never held C's
    await expect.poll(() => observer.chat.has(idW), { timeout: 30_000 }).toBe(true);
    expect(winner.chat.has(idC)).toBe(false);
    expect(winner.withdrawCalls).toEqual([]);
    // the durable row store agrees with the chat map
    const historyIds: string[] = [];
    for await (const rumor of (await observer.group(groupId)).history()) historyIds.push(rumor.id);
    expect(historyIds).not.toContain(idC);
    expect(historyIds).toContain(idW);
  }, 120_000);
});

describe('A1 through the real sink: a handler failure is retried by the library', () => {
  it('a failing dispatch rejects append; the library re-delivers and the chat row lands exactly once', async () => {
    const a = await startPeer(SECRET_A, 'a');
    const b = await startPeer(SECRET_B, 'b');
    const groupId = await pairedGroup(a, b);
    a.failNextDispatches(1);
    const id = await a.send(groupId, 'retry me');
    await expect.poll(() => a.chat.has(id), { timeout: 30_000 }).toBe(true);
    const attempts = a.appendAttempts.filter((x) => x.eventId === a.chat.get(id)!.eventId);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0].threw).toBe(true);
    expect(attempts[attempts.length - 1].threw).toBe(false);
    expect([...a.chat.values()].filter((r) => r.content === 'retry me')).toHaveLength(1);
  }, 60_000);
});

describe('handlers enqueue follow-up client work as their LAST action (ClientJobQueue invariant)', () => {
  const isReentrant = (e: unknown) => (e as { code?: string })?.code === 'reentrant';

  async function soloGroup(peer: Peer) {
    const g = await peer.account.handle.client.groups.create('Solo');
    track(peer, g);
    await g.synced();
    return g.id;
  }

  /**
   * The queued follow-up: an account-scope WRITE (a group send, like a
   * profile-request response). In the library, reads (groups.list/get, synced,
   * keyPackages.count) are not guarded; operations that go through the group's
   * own operation queue are, and reject `reentrant` inside a live frame.
   */
  async function followUp(peer: Peer, groupId: string, results: string[]) {
    const g = await peer.account.handle.client.groups.get(groupId);
    const unsigned = { pubkey: peer.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 30, tags: [] as string[][], content: 'follow-up' };
    await g!.send({ type: 'application', rumor: { ...unsigned, id: getEventHash(unsigned) } });
    results.push('job-ok');
  }

  it('enqueue BEFORE the handler awaits: the job runs inside the live frame and its client call is rejected as reentrant (step queuedJob)', async () => {
    const results: string[] = [];
    const a = await startPeer(SECRET_A, 'a', (self, base) => ({
      ...base,
      async dispatch(input) {
        if (input.rumor.kind === 9) {
          self().account.handle.enqueue(() => followUp(self(), input.groupId, results));
        }
        await sleep(80); // the handler's own await: the frame is still live when the job starts
        await base.dispatch(input);
      },
    }));
    const groupId = await soloGroup(a);
    const id = await a.send(groupId, 'violates the invariant');
    await expect.poll(() => a.chat.has(id), { timeout: 15_000 }).toBe(true);
    await a.account.queue.idle();
    const queued = a.errors.filter((e) => e.step === 'queuedJob');
    expect(queued).toHaveLength(1);
    expect(isReentrant(queued[0].error)).toBe(true);
    expect(results).toEqual([]);
  }, 40_000);

  it('enqueue AFTER the handler\'s own awaits: the job runs after the frame is dead and succeeds', async () => {
    const results: string[] = [];
    const a = await startPeer(SECRET_A, 'a', (self, base) => ({
      ...base,
      async dispatch(input) {
        await sleep(80);
        await base.dispatch(input);
        if (input.rumor.kind === 9) {
          self().account.handle.enqueue(() => followUp(self(), input.groupId, results));
        }
      },
    }));
    const groupId = await soloGroup(a);
    const id = await a.send(groupId, 'honours the invariant');
    await expect.poll(() => a.chat.has(id), { timeout: 15_000 }).toBe(true);
    await a.account.queue.idle();
    expect(results).toEqual(['job-ok']);
    expect(a.errors.filter((e) => e.step === 'queuedJob')).toEqual([]);
  }, 40_000);
});
