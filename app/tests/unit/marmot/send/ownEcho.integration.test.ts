// @vitest-environment node
/**
 * Own-send reconciliation over the REAL production sink path (see handlers/realApp.ts): real HistoryBackend,
 * dispatcher, chat handler, chat store, unread store and the real send helper + ownRowTracker wired to the handler's
 * `onOwnEcho` / `onOwnWithdrawn` ports.
 *
 *  AC-OWN-1  after the send helper's message echoes through the sink the chat store holds exactly ONE row with that
 *            rumor.id; the group's unread count and the bell total are unchanged from before the send.
 *  AC-OWN-2  both arrival orders (echo before send() resolves / after) give one row, status confirmed.
 *  AC-WDR-2  an own message the sink withdraws stays in the store and ends failed/retry (tracker), no resend; a
 *            later sink arrival of the same rumor id confirms it again.
 *  pendingOwnSends  the module-scope pending state is driven through pendingOwnSendsStatusPort.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import { useUnreadCounts } from '@/src/lib/unreadStore';
import { createGroupRumorSender, createOwnRowTracker, type OwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';
import {
  _resetPendingOwnSends,
  pendingOwnSendsFor,
  pendingOwnSendsStatusPort,
  ownRowStatusesFor,
  ownRowStatusOf,
  registerPendingOwnSend,
  subscribeOwnRowStatus,
  subscribePendingOwnSendSettled,
} from '@/src/lib/pendingOwnSends';
import { BOB, buildRealApp, ev, installLocalStorage, SELF, unreadOf, type RealApp } from '../handlers/realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let app: RealApp;
let tracker: OwnRowTracker;
let statuses: Array<[string, string]>;
beforeEach(() => {
  installLocalStorage();
  _resetPendingOwnSends();
  app = buildRealApp();
  statuses = [];
  tracker = createOwnRowTracker({ ports: { setStatus: (_g, id, s) => void statuses.push([id, s]) } });
  // the production wiring (S18): the handler ports ARE the tracker's methods
  app.spies.onOwnEcho.mockImplementation((g: string, id: string) => tracker.onOwnEcho(g, id));
  app.spies.onOwnWithdrawn.mockImplementation((g: string, id: string) => tracker.onOwnWithdrawn(g, id));
});
afterEach(async () => {
  tracker.dispose();
  await app.sink.dispose();
});

const bell = () => useUnreadCounts().totalUnread;

/** Sends a chat message the way the chat store will: prepare (final id), optimistic row, then send. */
function startSend(content: string) {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const send = vi.fn(() => new Promise<unknown>((res, rej) => { release = () => res(undefined); fail = rej; }));
  const group: SendableGroup = { id: app.groupId, send: send as unknown as SendableGroup['send'], pendingIntents: async () => [] };
  const prepared = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1_700_000_100 }).prepare(group, 9, content, []);
  return {
    prepared,
    send,
    release: () => release(),
    fail: (e: unknown) => fail(e),
    /** The optimistic row the chat store writes before the send. */
    async writeOptimisticRow() {
      await chat.appendMessage(app.groupId, { id: prepared.id, content, senderPubkey: SELF, groupId: app.groupId, createdAt: 1_700_000_100_000 });
    },
    /** The sink echo of that same rumor (kind-445 event label `eventId`). */
    echo: (eventId = 'own1') => app.sink.append(app.entry({ eventId, account: SELF, rumorId: prepared.id, pubkey: SELF, content, at: 1_700_000_100 })),
  };
}
const ids = async () => (await app.messages()).map((m) => m.id);

describe('AC-OWN-1: one row, unread and bell untouched', () => {
  it('the echo of a helper-sent message leaves exactly one row with that rumor.id and the unread count and bell unchanged', async () => {
    await app.sink.append(app.entry({ eventId: 'p1', account: BOB, content: 'peer 1', at: 1_700_000_001 }));
    await app.sink.append(app.entry({ eventId: 'p2', account: BOB, content: 'peer 2', at: 1_700_000_002 }));
    const unreadBefore = unreadOf(app.groupId);
    const bellBefore = bell();
    expect(unreadBefore).toBe(2);

    const s = startSend('my message');
    await s.writeOptimisticRow();
    const sent = s.prepared.send();
    s.release();
    await sent;
    await s.echo();

    const rows = await ids();
    expect(rows.filter((id) => id === s.prepared.id)).toHaveLength(1);
    expect(rows).toHaveLength(3); // 2 peer rows + the single own row
    expect(unreadOf(app.groupId)).toBe(unreadBefore);
    expect(bell()).toBe(bellBefore);
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');
    expect(statuses).toEqual([[s.prepared.id, 'confirmed']]);
  });

  it('control: without the optimistic row the echo itself inserts the single row (still no unread / bell)', async () => {
    const s = startSend('from another device');
    const bellBefore = bell(); // the unread store is module-global: compare, never assume zero
    await s.echo();
    expect(await ids()).toEqual([s.prepared.id]);
    expect(unreadOf(app.groupId)).toBe(0);
    expect(bell()).toBe(bellBefore);
  });

  it('the canonical id of the optimistic row is the id of the echoed sink entry (AC-SEND-1)', async () => {
    const s = startSend('canonical');
    await s.writeOptimisticRow();
    await s.echo();
    expect((await app.messages())[0].id).toBe(s.prepared.rumor.id);
    expect(app.spies.onOwnEcho).toHaveBeenCalledWith(app.groupId, s.prepared.id);
  });
});

describe('AC-OWN-2: either arrival order converges to one confirmed row', () => {
  it('echo BEFORE send() resolves', async () => {
    const s = startSend('early');
    await s.writeOptimisticRow();
    const sent = s.prepared.send();
    await s.echo();
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');
    s.release();
    await sent;
    expect(await ids()).toEqual([s.prepared.id]);
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');
  });

  it('echo AFTER send() resolves', async () => {
    const s = startSend('late');
    await s.writeOptimisticRow();
    const sent = s.prepared.send();
    s.release();
    await sent;
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('sending');
    await s.echo();
    expect(await ids()).toEqual([s.prepared.id]);
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');
  });

  it('a redelivery of the echo (same kind-445 event, then a second carrier) keeps one row and one transition', async () => {
    const s = startSend('twice');
    await s.writeOptimisticRow();
    await s.echo('own1');
    await s.echo('own1');
    await s.echo('own2');
    expect(await ids()).toEqual([s.prepared.id]);
    expect(statuses).toEqual([[s.prepared.id, 'confirmed']]);
  });
});

describe('AC-WDR-2: an own withdrawn message ends failed/retry through the real sink, never deleted or resent', () => {
  it('withdraw of the confirmed own row keeps it in the store, reports failed, and sends nothing', async () => {
    const s = startSend('to be withdrawn');
    await s.writeOptimisticRow();
    const sent = s.prepared.send();
    s.release();
    await sent;
    await s.echo('own1');
    await app.sink.withdraw(app.groupId, ev('own1'));
    expect(await ids()).toEqual([s.prepared.id]); // not deleted
    expect(app.spies.onOwnWithdrawn).toHaveBeenCalledWith(app.groupId, s.prepared.id);
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('failed');
    expect(s.send).toHaveBeenCalledTimes(1);
    // a re-canonicalised branch delivers it again: confirmed, still one row
    await s.echo('own1-again');
    expect(await ids()).toEqual([s.prepared.id]);
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');
  });

  it('a withdrawn peer message never touches the own-row tracker', async () => {
    await app.sink.append(app.entry({ eventId: 'p1', account: BOB, content: 'peer' }));
    await app.sink.withdraw(app.groupId, ev('p1'));
    expect(app.spies.onOwnWithdrawn).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});

describe('pendingOwnSends is the module-scope status for a row the tracker drives (multi-transition port)', () => {
  const row = (id: string) => ({ id, content: 'c', senderPubkey: SELF, groupId: 'thread', createdAt: 1 });

  /** What a subscriber of one thread sees through the port: status events and settle (persisted) events. */
  function watch(thread = 'thread') {
    const seen: string[] = [];
    subscribeOwnRowStatus(SELF, thread, (e) => void seen.push(`${e.id}:${e.status}`));
    subscribePendingOwnSendSettled(SELF, thread, (e) => void seen.push(`${e.id}:settled-${e.persisted ? 'persisted' : 'dropped'}`));
    return seen;
  }
  const pendingIds = () => pendingOwnSendsFor(SELF, 'thread').map((p) => p.id);

  it('register -> failed -> late echo: the subscriber sees failed (row KEPT, not dropped), then confirmed and persisted', () => {
    const seen = watch();
    const t = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(SELF) });
    registerPendingOwnSend(SELF, row('r1'));
    t.register('thread', 'r1');
    t.sendRejected('thread', 'r1');
    expect(seen).toEqual(['r1:failed']); // no settle event: the view must not drop the row
    expect(pendingIds()).toEqual(['r1']); // still restorable on a remount
    expect(ownRowStatusOf(SELF, 'r1')).toBe('failed');
    expect(ownRowStatusesFor(SELF, 'thread')).toEqual([{ id: 'r1', status: 'failed' }]);
    t.onOwnEcho('thread', 'r1');
    expect(seen).toEqual(['r1:failed', 'r1:confirmed', 'r1:settled-persisted']);
    expect(pendingIds()).toEqual([]);
    expect(ownRowStatusOf(SELF, 'r1')).toBeUndefined(); // confirmed and persisted: no status kept
    t.dispose();
  });

  it('register -> echo -> own withdraw: the subscriber sees confirmed, then failed (the row ends failed/retry, status kept)', () => {
    const seen = watch();
    const t = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(SELF) });
    registerPendingOwnSend(SELF, row('r2'));
    t.register('thread', 'r2');
    t.onOwnEcho('thread', 'r2');
    t.onOwnWithdrawn('thread', 'r2');
    expect(seen).toEqual(['r2:confirmed', 'r2:settled-persisted', 'r2:failed']);
    expect(ownRowStatusOf(SELF, 'r2')).toBe('failed');
    expect(ownRowStatusesFor(SELF, 'thread')).toEqual([{ id: 'r2', status: 'failed' }]);
    // a re-canonicalised branch delivers it again
    t.onOwnEcho('thread', 'r2');
    expect(seen.slice(3)).toEqual(['r2:confirmed']);
    expect(ownRowStatusOf(SELF, 'r2')).toBeUndefined();
    t.dispose();
  });

  it('failed -> retry -> sending is announced, a remounted view reads the current status, forget drops it', () => {
    const seen = watch();
    const port = pendingOwnSendsStatusPort(SELF);
    registerPendingOwnSend(SELF, row('r3'));
    port.setStatus('thread', 'r3', 'failed');
    port.setStatus('thread', 'r3', 'sending');
    expect(seen).toEqual(['r3:failed', 'r3:sending']);
    expect(ownRowStatusesFor(SELF, 'thread')).toEqual([{ id: 'r3', status: 'sending' }]);
    port.setStatus('thread', 'r3', 'failed');
    port.forget!('thread', 'r3');
    expect(seen.slice(-2)).toEqual(['r3:settled-dropped', 'r3:forgotten']); // a forgotten row is gone, not a stuck `sending`
    expect(ownRowStatusOf(SELF, 'r3')).toBeUndefined();
  });

  it('the status is per account and per thread', () => {
    const seen = watch('other-thread');
    const port = pendingOwnSendsStatusPort(SELF);
    port.setStatus('thread', 'x', 'failed');
    pendingOwnSendsStatusPort(BOB).setStatus('other-thread', 'x', 'failed');
    expect(seen).toEqual([]);
    expect(ownRowStatusOf(BOB, 'x')).toBe('failed');
  });

  it('an unknown row is a no-op (an earlier-session row, a signal)', () => {
    const port = pendingOwnSendsStatusPort(SELF);
    expect(() => port.setStatus('thread', 'ghost', 'confirmed')).not.toThrow();
  });

  it('end to end: the tracker drives the pending entry of an own send', async () => {
    const t = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(SELF) });
    registerPendingOwnSend(SELF, row('r1'));
    t.register('thread', 'r1');
    t.onOwnEcho('thread', 'r1');
    expect(pendingOwnSendsFor(SELF, 'thread')).toEqual([]);
    t.dispose();
  });
});

describe('carrier bookkeeping through the real handler (the adapter S18 wires: ports carry the kind-445 event id)', () => {
  it('two carriers of one own row, one withdrawn: the row stays confirmed and stored; withdrawing the last carrier ends it failed', async () => {
    // The handler ports do not pass `input.eventId` yet (S18 widens them): the adapter reads the carrier of
    // the sink call in flight, which is what S18's `input.eventId` is.
    let carrier: string | undefined;
    app.spies.onOwnEcho.mockImplementation((g: string, id: string) => tracker.onOwnEcho(g, id, carrier));
    app.spies.onOwnWithdrawn.mockImplementation((g: string, id: string) => tracker.onOwnWithdrawn(g, id, carrier));
    const s = startSend('two carriers');
    await s.writeOptimisticRow();
    const sent = s.prepared.send();
    s.release();
    await sent;
    carrier = ev('own1')[0];
    await s.echo('own1');
    carrier = ev('own2')[0];
    await s.echo('own2');
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed');

    carrier = ev('own1')[0];
    await app.sink.withdraw(app.groupId, ev('own1'));
    expect(app.spies.onOwnWithdrawn).toHaveBeenCalledTimes(1); // the handler does hand the first withdraw over: only the carrier rule keeps the row
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('confirmed'); // the other carrier still holds it
    expect(await ids()).toEqual([s.prepared.id]);
    expect(statuses).toEqual([[s.prepared.id, 'confirmed']]);

    carrier = ev('own2')[0];
    await app.sink.withdraw(app.groupId, ev('own2'));
    expect(tracker.statusOf(app.groupId, s.prepared.id)).toBe('failed');
    expect(await ids()).toEqual([s.prepared.id]); // failed/retry, never deleted
    expect(statuses).toEqual([[s.prepared.id, 'confirmed'], [s.prepared.id, 'failed']]);
  });
});
