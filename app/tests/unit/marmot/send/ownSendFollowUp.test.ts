// @vitest-environment node
/**
 * S6 review follow-ups (AC-SEND-5, AC-WDR-3):
 *  - a row the tracker forgets (evicted beyond maxFailedRetained, forgetGroup) is gone from pendingOwnSends too
 *    and views are told ('forgotten'); it never reads `sending` forever;
 *  - a confirmed row keeps reporting `confirmed` while an own edit/delete is in flight on its pending entry;
 *  - the commit-pending barrier is bounded/abortable/logged; sleep() leaves no timer behind;
 *  - an older send attempt never changes a retried row;
 *  - pendingIntents absent -> warned once; `signal` defaults to false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupOpQueue, createGroupRumorSender, createOwnRowTracker, GroupOpError, type SendableGroup } from '@/src/lib/marmot/send';
import {
  _resetPendingOwnSends,
  beginPendingOwnSendAction,
  endPendingOwnSendAction,
  ownRowStatusesFor,
  ownRowStatusOf,
  pendingOwnSendsFor,
  pendingOwnSendsStatusPort,
  registerPendingOwnSend,
  subscribeOwnRowStatus,
  subscribePendingOwnSendSettled,
} from '@/src/lib/pendingOwnSends';

const SELF = 'a1'.repeat(32);
const G = 'ab'.repeat(32);
const row = (id: string, groupId = G) => ({ id, content: 'c', senderPubkey: SELF, groupId, createdAt: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  _resetPendingOwnSends();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a row the tracker forgets is gone from the pending state (no stuck `sending`)', () => {
  function watch() {
    const seen: string[] = [];
    subscribeOwnRowStatus(SELF, G, (e) => void seen.push(`${e.id}:${e.status}`));
    subscribePendingOwnSendSettled(SELF, G, (e) => void seen.push(`${e.id}:settled-${e.persisted ? 'persisted' : 'dropped'}`));
    return seen;
  }

  it('eviction beyond maxFailedRetained drops the evicted failed row\'s pending entry and announces it; the newest failed row is kept', () => {
    const t = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(SELF), maxFailedRetained: 1 });
    for (const id of ['r1', 'r2']) {
      registerPendingOwnSend(SELF, row(id));
      t.register(G, id);
    }
    const seen = watch();
    t.sendRejected(G, 'r1');
    t.sendRejected(G, 'r2'); // r1 is the oldest failed row beyond the cap
    expect(seen).toEqual(['r1:failed', 'r2:failed', 'r1:settled-dropped', 'r1:forgotten']);
    expect(ownRowStatusOf(SELF, 'r1')).toBeUndefined();
    expect(pendingOwnSendsFor(SELF, G).map((p) => p.id)).toEqual(['r2']);
    expect(ownRowStatusOf(SELF, 'r2')).toBe('failed');
    t.dispose();
  });

  it('forgetGroup drops the pending entries and statuses of the group and announces each', () => {
    const t = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(SELF) });
    registerPendingOwnSend(SELF, row('s1'));
    t.register(G, 's1'); // still sending
    registerPendingOwnSend(SELF, row('f1'));
    t.register(G, 'f1');
    t.sendRejected(G, 'f1'); // failed
    const seen = watch();
    t.forgetGroup(G);
    expect(seen).toContain('s1:forgotten');
    expect(seen).toContain('f1:forgotten');
    expect(pendingOwnSendsFor(SELF, G)).toEqual([]);
    expect(ownRowStatusOf(SELF, 's1')).toBeUndefined();
    expect(ownRowStatusOf(SELF, 'f1')).toBeUndefined();
    expect(ownRowStatusesFor(SELF, G)).toEqual([]);
    t.dispose();
  });
});

describe('a confirmed row stays confirmed while an own edit/delete is in flight on its pending entry', () => {
  it('reports confirmed (status and thread list) during the action, and is forgotten when the deferred settle applies', () => {
    const port = pendingOwnSendsStatusPort(SELF);
    const settled: string[] = [];
    subscribePendingOwnSendSettled(SELF, G, (e) => void settled.push(`${e.id}:${String(e.persisted)}`));
    registerPendingOwnSend(SELF, row('c1'));
    expect(beginPendingOwnSendAction(SELF, 'c1')).toBe(true);
    port.setStatus(G, 'c1', 'confirmed');
    expect(ownRowStatusOf(SELF, 'c1')).toBe('confirmed');
    expect(ownRowStatusesFor(SELF, G)).toEqual([{ id: 'c1', status: 'confirmed' }]);
    expect(settled).toEqual([]); // the settle is still held back
    endPendingOwnSendAction(SELF, 'c1');
    expect(settled).toEqual(['c1:true']);
    expect(ownRowStatusOf(SELF, 'c1')).toBeUndefined();
    expect(ownRowStatusesFor(SELF, G)).toEqual([]);
  });
});

describe('the commit-pending barrier is bounded, abortable and not swallowed silently', () => {
  const selfClearing = () => Object.assign(new Error('commit-pending'), { code: 'commit-pending', details: { reason: 'selfremove-election-wait' } });
  const failOnce = () => {
    let n = 0;
    return vi.fn(async () => {
      if (++n === 1) throw selfClearing();
      return 'ok';
    });
  };

  it('a never-settling ingest([]) falls through after syncTimeoutMs to the backoff, then the retry runs', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 1000, commitPendingBackoffMs: [10] });
    const op = failOnce();
    const p = q.runCommit({ id: 'g', synced: async () => undefined, ingest: () => new Promise(() => undefined) }, op);
    await vi.advanceTimersByTimeAsync(999);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 10);
    await expect(p).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('leave with skipSync does not wait unbounded on a never-settling barrier', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 500, commitPendingBackoffMs: [0] });
    const op = failOnce();
    const p = q.runCommit({ id: 'g', synced: () => new Promise<void>(() => undefined), ingest: () => new Promise(() => undefined) }, op, { skipSync: true });
    await vi.advanceTimersByTimeAsync(501);
    await expect(p).resolves.toBe('ok');
  });

  it('a throwing ingest([]) is logged, not swallowed silently, and the retry still runs after the backoff', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const q = createGroupOpQueue({ commitPendingBackoffMs: [5] });
    const op = failOnce();
    const p = q.runCommit({ id: 'g', synced: async () => undefined, ingest: async () => { throw new Error('ingest broke'); } }, op);
    await vi.advanceTimersByTimeAsync(5);
    await expect(p).resolves.toBe('ok');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ingest');
  });

  it('abort during the backoff rejects aborted and clears the sleep timer', async () => {
    const q = createGroupOpQueue({ commitPendingBackoffMs: [60_000] });
    const ac = new AbortController();
    const p = q.runCommit({ id: 'g', synced: async () => undefined }, failOnce(), { signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ac.abort();
    const err = await p;
    expect(err).toBeInstanceOf(GroupOpError);
    expect((err as GroupOpError).code).toBe('aborted');
    expect((err as GroupOpError).message).toContain('no attempt is in flight');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort during a never-settling barrier rejects aborted', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 60_000, commitPendingBackoffMs: [0] });
    const ac = new AbortController();
    const p = q.runCommit({ id: 'g', synced: async () => undefined, ingest: () => new Promise(() => undefined) }, failOnce(), { signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    expect(((await p) as GroupOpError).code).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('an older send attempt never changes a retried row', () => {
  it('first send pending, branch switch fails the row, retry, then the FIRST send rejects: the row stays sending', async () => {
    const statuses: string[] = [];
    const tracker = createOwnRowTracker({ ports: { setStatus: (_g, _id, s) => void statuses.push(s) } });
    const rejects: Array<(e: unknown) => void> = [];
    const group: SendableGroup = {
      id: G,
      send: vi.fn(() => new Promise<unknown>((_res, rej) => void rejects.push(rej))) as unknown as SendableGroup['send'],
      pendingIntents: async () => [],
    };
    const sender = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1_700_000_000 });
    const prepared = sender.prepare(group, 9, 'x', []);
    const first = prepared.send().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    tracker.onGroupBranchSwitched({ groupId: G });
    expect(tracker.statusOf(G, prepared.id)).toBe('failed');
    const second = sender.retry(group, prepared.id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.statusOf(G, prepared.id)).toBe('sending');
    rejects[0](Object.assign(new Error('late'), { code: 'publish-failed' })); // the OLD attempt
    await first;
    expect(tracker.statusOf(G, prepared.id)).toBe('sending');
    expect(statuses).toEqual(['failed', 'sending']);
    rejects[1](Object.assign(new Error('now'), { code: 'publish-failed' })); // the current attempt still fails it
    await second;
    expect(tracker.statusOf(G, prepared.id)).toBe('failed');
    tracker.dispose();
  });

  it('a detached synced() waiter of an older attempt does not start the retried row\'s clock or fail it', async () => {
    const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined }, timeoutMs: 1000 });
    const syncedRejects: Array<(e: unknown) => void> = [];
    const group: SendableGroup = {
      id: G,
      send: (async () => undefined) as unknown as SendableGroup['send'],
      synced: () => new Promise<void>((_res, rej) => void syncedRejects.push(rej)),
      pendingIntents: async () => [],
    };
    const sender = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1_700_000_000 });
    const prepared = sender.prepare(group, 9, 'y', []);
    await prepared.send();
    tracker.onGroupBranchSwitched({ groupId: G });
    await sender.retry(group, prepared.id);
    syncedRejects[0](new Error('fenced')); // the OLD attempt's waiter
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.statusOf(G, prepared.id)).toBe('sending');
    tracker.dispose();
  });
});

describe('degraded optional inputs are loud / safe by default', () => {
  it('a group without pendingIntents warns once (trigger b inert) across sends', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
    const group = { id: G, send: async () => undefined } as unknown as SendableGroup;
    const sender = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1_700_000_000 });
    await sender.sendGroupRumor(group, 9, 'a', []);
    await sender.sendGroupRumor(group, 9, 'b', []);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('pendingIntents'))).toHaveLength(1);
    tracker.dispose();
  });

  it('register() with a rumor but no `signal` is not carried over a recompute (signal defaults to false)', () => {
    const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
    const rumor = { id: 'u', pubkey: SELF, created_at: 1, kind: 9, tags: [], content: 'x' };
    tracker.register(G, 'u', { rumor });
    expect(tracker.pendingSignals(G)).toEqual([]);
    tracker.dispose();
  });
});
