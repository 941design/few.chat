/**
 * ClientJobQueue invariants (AC-BOOT-5): macrotask start, strict FIFO, one at a
 * time, a rejecting job never stalls the queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobQueue } from '@/src/lib/marmot/client/fifo';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createJobQueue', () => {
  it('never runs a job before the enqueuing frame returns, not even in a microtask', async () => {
    const q = createJobQueue();
    const log: string[] = [];
    // The "handler frame": enqueue two jobs, then settle.
    const handler = async () => {
      q.enqueue(async () => { log.push('job1'); });
      q.enqueue(async () => { log.push('job2'); });
      log.push('handler-end');
    };
    await handler();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['handler-end']); // microtasks drained, still nothing ran
    await vi.advanceTimersByTimeAsync(0);
    expect(log[0]).toBe('handler-end');
    expect(log).toContain('job1');
  });

  it('starts the second job only after the first settled, in enqueue order', async () => {
    const q = createJobQueue();
    const log: string[] = [];
    let releaseFirst!: () => void;
    q.enqueue(() => new Promise<void>((resolve) => {
      log.push('start1');
      releaseFirst = () => { log.push('end1'); resolve(); };
    }));
    q.enqueue(async () => { log.push('start2'); });
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(['start1']); // job 2 is held back while job 1 is pending
    releaseFirst();
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(['start1', 'end1', 'start2']);
  });

  it('runs many jobs strictly one at a time in enqueue order, even when later jobs are faster', async () => {
    const q = createJobQueue();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const job = (name: string, delayMs: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`start:${name}`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      log.push(`end:${name}`);
      active -= 1;
    };
    q.enqueue(job('a', 30));
    q.enqueue(job('b', 5));
    q.enqueue(job('c', 0));
    q.enqueue(job('d', 10));
    await vi.advanceTimersByTimeAsync(500);
    await q.idle();
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c', 'start:d', 'end:d']);
    expect(maxActive).toBe(1);
  });

  it('a job enqueued by a running job runs after the already-queued ones', async () => {
    const q = createJobQueue();
    const log: string[] = [];
    q.enqueue(async () => { log.push('1'); q.enqueue(async () => { log.push('1.1'); }); });
    q.enqueue(async () => { log.push('2'); });
    q.enqueue(async () => { log.push('3'); });
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual(['1', '2', '3', '1.1']);
  });

  it('a rejecting job is reported and does not stall later jobs', async () => {
    const errors: unknown[] = [];
    const q = createJobQueue({ onError: (e) => errors.push(e) });
    const ran: number[] = [];
    q.enqueue(async () => { throw new Error('boom'); });
    q.enqueue(() => { throw new Error('sync boom'); });
    q.enqueue(async () => { ran.push(3); });
    await vi.advanceTimersByTimeAsync(50);
    expect(ran).toEqual([3]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['boom', 'sync boom']);
  });

  it('idle() resolves after the last job settles; dispose() drops unstarted jobs', async () => {
    const q = createJobQueue();
    const ran: number[] = [];
    q.enqueue(async () => { ran.push(1); });
    q.enqueue(async () => { ran.push(2); });
    const idle = q.idle();
    await vi.advanceTimersByTimeAsync(50);
    await idle;
    expect(ran).toEqual([1, 2]);

    q.enqueue(async () => { ran.push(3); });
    q.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(ran).toEqual([1, 2]);
    q.enqueue(async () => { ran.push(4); });
    await vi.advanceTimersByTimeAsync(50);
    expect(ran).toEqual([1, 2]);
  });

  it('rejects a non-function job loudly', () => {
    const q = createJobQueue();
    expect(() => q.enqueue(undefined as unknown as () => Promise<void>)).toThrow(TypeError);
  });
});
