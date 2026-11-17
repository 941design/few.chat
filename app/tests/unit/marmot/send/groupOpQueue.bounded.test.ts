// @vitest-environment node
/**
 * AC-SEND-5 hardening: the `synced()` wait is bounded (timeout / abort), a wait lost before the op started never
 * runs it and releases the chain; `commit-pending` is retried by `details.reason` behind a real barrier
 * (`group.ingest([])`) plus bounded backoff, and a deferred-proposal refusal is surfaced at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupOpQueue, GroupOpError } from '@/src/lib/marmot/send';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const neverSynced = () => new Promise<void>(() => undefined);
const commitPending = (details: Record<string, unknown>) => Object.assign(new Error('commit-pending'), { code: 'commit-pending', details });

describe('bounded synced() wait', () => {
  it('synced() never resolves: the first op rejects not-synced at the deadline WITHOUT running, a later op runs', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 1000 });
    let syncedCalls = 0;
    const group = { id: 'g', synced: () => (++syncedCalls === 1 ? neverSynced() : Promise.resolve()) };
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    const p1 = q.runCommit(group, first);
    const p2 = q.runCommit(group, second);
    const settled1 = p1.then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(first).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled1;
    expect(err).toBeInstanceOf(GroupOpError);
    expect((err as GroupOpError).code).toBe('not-synced');
    expect(first).not.toHaveBeenCalled();
    await expect(p2).resolves.toBe('second');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('an explicit syncTimeoutMs overrides the 30 s default', async () => {
    const q = createGroupOpQueue();
    const op = vi.fn(async () => 1);
    const p = q.runCommit({ id: 'g', synced: neverSynced }, op, { syncTimeoutMs: 50 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(((await p) as GroupOpError).code).toBe('not-synced');
    const d = q.runCommit({ id: 'h', synced: neverSynced }, op).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void d.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await d) as GroupOpError).code).toBe('not-synced');
    expect(op).not.toHaveBeenCalled();
  });

  it('an op aborted while waiting for synced() rejects aborted and never runs; a later op still runs', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 60_000 });
    let calls = 0;
    const group = { id: 'g', synced: () => (++calls === 1 ? neverSynced() : Promise.resolve()) };
    const ac = new AbortController();
    const aborted = vi.fn(async () => 'a');
    const later = vi.fn(async () => 'b');
    const p1 = q.runCommit(group, aborted, { signal: ac.signal }).catch((e: unknown) => e);
    const p2 = q.runCommit(group, later);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    expect(((await p1) as GroupOpError).code).toBe('aborted');
    expect(aborted).not.toHaveBeenCalled();
    await expect(p2).resolves.toBe('b');
  });

  it('an op aborted while still QUEUED behind a running op never runs, and does not let its successor overtake the running one', async () => {
    const q = createGroupOpQueue();
    const log: string[] = [];
    let finish!: () => void;
    const running = q.run('g', () => new Promise<void>((r) => (finish = () => { log.push('running:end'); r(); })));
    const ac = new AbortController();
    const queued = vi.fn(async () => log.push('queued'));
    const p = q.run('g', queued, { signal: ac.signal }).catch((e: unknown) => e);
    const successor = q.run('g', async () => void log.push('successor'));
    ac.abort();
    expect(((await p) as GroupOpError).code).toBe('aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([]); // the successor waits for the running op
    finish();
    await running;
    await successor;
    expect(log).toEqual(['running:end', 'successor']);
    expect(queued).not.toHaveBeenCalled();
  });

  it('an already aborted signal rejects at once without calling synced() or the op', async () => {
    const q = createGroupOpQueue();
    const ac = new AbortController();
    ac.abort();
    const synced = vi.fn(neverSynced);
    const op = vi.fn(async () => 1);
    await expect(q.runCommit({ id: 'g', synced }, op, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(op).not.toHaveBeenCalled();
  });

  it('once op() started it runs to completion even if the signal aborts or the deadline passes', async () => {
    const q = createGroupOpQueue({ syncTimeoutMs: 100 });
    const ac = new AbortController();
    let finish!: (v: string) => void;
    const p = q.runCommit({ id: 'g', synced: () => Promise.resolve() }, () => new Promise<string>((r) => (finish = r)), { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    finish('done');
    await expect(p).resolves.toBe('done');
  });

  it('skipSync: the op runs without awaiting synced() (S13 leave)', async () => {
    const q = createGroupOpQueue();
    const synced = vi.fn(neverSynced);
    await expect(q.runCommit({ id: 'g', synced }, async () => 'left', { skipSync: true })).resolves.toBe('left');
    expect(synced).not.toHaveBeenCalled();
  });

  it('skipSync: an awaiting-sync refusal is surfaced at once, not waited for', async () => {
    const q = createGroupOpQueue();
    const err = commitPending({ reason: 'awaiting-sync', retryable: true });
    const op = vi.fn(async () => {
      throw err;
    });
    await expect(q.runCommit({ id: 'g', synced: neverSynced }, op, { skipSync: true })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('commit-pending retry by details.reason', () => {
  /** An op failing `failures` times with `error`, then resolving. */
  const flaky = (error: Error, failures: number) => {
    let n = 0;
    return vi.fn(async () => {
      if (n++ < failures) throw error;
      return 'ok';
    });
  };
  const barrierGroup = () => {
    const log: string[] = [];
    return {
      log,
      group: {
        id: 'g',
        synced: () => Promise.resolve(),
        ingest: vi.fn(async () => void log.push('ingest')),
      },
    };
  };

  it.each([
    ['own commit pending publish (no reason, pendingIntentId)', { pendingIntentId: 'i1', retryable: true }],
    ['selfremove-election-wait', { reason: 'selfremove-election-wait', retryable: true }],
    ['staged-adds-commit-unconfirmed', { reason: 'staged-adds-commit-unconfirmed', retryable: true }],
  ])('%s: ingest([]) barrier, then backoff 250 ms / 1 s / 3 s, then the op runs again', async (_name, details) => {
    const q = createGroupOpQueue();
    const { group } = barrierGroup();
    const op = flaky(commitPending(details), 3);
    const result = q.runCommit(group, op);
    await vi.advanceTimersByTimeAsync(0);
    expect(op).toHaveBeenCalledTimes(1);
    expect(group.ingest).toHaveBeenCalledTimes(1);
    expect(group.ingest).toHaveBeenCalledWith([]);
    await vi.advanceTimersByTimeAsync(249);
    expect(op).toHaveBeenCalledTimes(1); // still backing off
    await vi.advanceTimersByTimeAsync(1);
    expect(op).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(op).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(op).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2999);
    expect(op).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(4);
    expect(group.ingest).toHaveBeenCalledTimes(3);
  });

  it('a retry waits for the ingest barrier, not only the backoff', async () => {
    const q = createGroupOpQueue({ commitPendingBackoffMs: [0] });
    let release!: () => void;
    const group = { id: 'g', synced: () => Promise.resolve(), ingest: () => new Promise<void>((r) => (release = r)) };
    const op = flaky(commitPending({ pendingIntentId: 'i1' }), 1);
    const result = q.runCommit(group, op);
    await vi.advanceTimersByTimeAsync(5000);
    expect(op).toHaveBeenCalledTimes(1); // barrier not released
    release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('ok');
  });

  it('proposal-deferred (onProposal deferred) is surfaced at once: no barrier, no retry', async () => {
    const q = createGroupOpQueue();
    const { group } = barrierGroup();
    const err = commitPending({ reason: 'proposal-deferred', deferred: 2, retryable: true });
    const op = flaky(err, 1);
    await expect(q.runCommit(group, op)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(group.ingest).not.toHaveBeenCalled();
  });

  it.each([['restore-in-flight'], ['something-new']])('an unknown / unrelated reason (%s) is surfaced at once', async (reason) => {
    const q = createGroupOpQueue();
    const err = commitPending({ reason });
    const op = flaky(err, 1);
    await expect(q.runCommit(barrierGroup().group, op)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('awaiting-sync waits for synced() (bounded) and retries; it does not use the backoff', async () => {
    const q = createGroupOpQueue();
    let calls = 0;
    const group = { id: 'g', synced: vi.fn(() => (++calls === 2 ? new Promise<void>((r) => setTimeout(r, 400)) : Promise.resolve())) };
    const op = flaky(commitPending({ reason: 'awaiting-sync', retryable: true }), 1);
    const result = q.runCommit(group, op);
    await vi.advanceTimersByTimeAsync(399);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(group.synced).toHaveBeenCalledTimes(2);
  });

  it('retries are bounded by maxCommitPendingRetries; the last error is thrown unchanged', async () => {
    const q = createGroupOpQueue({ maxCommitPendingRetries: 2 });
    const err = commitPending({ pendingIntentId: 'i1' });
    const op = flaky(err, 99);
    const result = q.runCommit(barrierGroup().group, op).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(err);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('an abort during the backoff rejects aborted; the op is not run again', async () => {
    const q = createGroupOpQueue();
    const ac = new AbortController();
    const op = flaky(commitPending({ pendingIntentId: 'i1' }), 99);
    const result = q.runCommit(barrierGroup().group, op, { signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    expect(((await result) as GroupOpError).code).toBe('aborted');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('a group without ingest still backs off (only the barrier is skipped)', async () => {
    const q = createGroupOpQueue();
    const op = flaky(commitPending({ pendingIntentId: 'i1' }), 1);
    const result = q.runCommit({ id: 'g', synced: () => Promise.resolve() }, op);
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBe('ok');
  });

  it('validates the new options', () => {
    expect(() => createGroupOpQueue({ syncTimeoutMs: 0 })).toThrow(TypeError);
    expect(() => createGroupOpQueue({ commitPendingBackoffMs: [] })).toThrow(TypeError);
    expect(() => createGroupOpQueue({ commitPendingBackoffMs: [-1] })).toThrow(TypeError);
  });
});
