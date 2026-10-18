import { describe, it, expect, vi } from 'vitest';
import { teardownForReplace, trackPending } from '@/src/lib/marmot/replaceTeardown';

const G = 'g1';
const never = () => new Promise<void>(() => {});

describe('teardownForReplace — fails closed', () => {
  it('runs abort, setup wait, unsub, idle wait, timers, drain in order and resolves', async () => {
    const order: string[] = [];
    await teardownForReplace(G, {
      abort: () => order.push('abort'),
      setup: Promise.resolve().then(() => { order.push('setup'); }),
      unsub: () => order.push('unsub'),
      idle: async () => { order.push('idle'); },
      cancelTimers: () => order.push('timers'),
      drain: async () => { order.push('drain'); },
    }, new Map(), 50);
    expect(order).toEqual(['abort', 'setup', 'unsub', 'idle', 'timers', 'drain']);
  });

  it('an idle wait that never resolves => throws (no destroy can follow); the handle is kept', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    await expect(teardownForReplace(G, { idle: never }, pending, 20)).rejects.toThrow(/still running/);
    expect(pending.get(G)!.size).toBe(1);
  });

  it('setup and drain timeouts also throw', async () => {
    await expect(teardownForReplace(G, { setup: never() }, new Map(), 20)).rejects.toThrow();
    await expect(teardownForReplace(G, { drain: never }, new Map(), 20)).rejects.toThrow();
  });

  it('a retry awaits the earlier unfinished wait first: still stuck => throws again; once it resolved => proceeds', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    await expect(teardownForReplace(G, { idle: () => slow }, pending, 20)).rejects.toThrow();

    // retry with no new handles: the leftover wait still blocks
    await expect(teardownForReplace(G, {}, pending, 20)).rejects.toThrow();

    release();
    await slow;
    await expect(teardownForReplace(G, {}, pending, 20)).resolves.toBeUndefined();
    expect(pending.has(G)).toBe(false);
  });

  it('a rejecting wait counts as finished (errors of old work never block the replace)', async () => {
    await expect(
      teardownForReplace(G, { idle: async () => { throw new Error('boom'); } }, new Map(), 20),
    ).resolves.toBeUndefined();
  });

  it('cancelTimers and unsub still run when a wait times out', async () => {
    const unsub = vi.fn();
    const cancel = vi.fn();
    await expect(teardownForReplace(G, { setup: never(), unsub, cancelTimers: cancel }, new Map(), 20)).rejects.toThrow();
    expect(unsub).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('teardownForReplace — retries and retired ingests', () => {
  it('3+ retries with the same stuck promise keep exactly one pending entry; each attempt rejects after one waitMs (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Map<string, Set<Promise<unknown>>>();
      let release!: () => void;
      const stuck = new Promise<void>((r) => { release = r; });
      const attempt = async (handles: Parameters<typeof teardownForReplace>[1]) => {
        const p = teardownForReplace(G, handles, pending, 40).then(() => 'ok', () => 'rejected');
        // one waitMs is enough to reject: leftover wait is raced against a single timer
        await vi.advanceTimersByTimeAsync(40 * 3 + 1);
        return p;
      };
      expect(await attempt({ idle: () => stuck })).toBe('rejected');
      for (let i = 0; i < 4; i++) {
        expect(await attempt({})).toBe('rejected');
        expect(pending.get(G)!.size).toBe(1);
      }
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(pending.has(G)).toBe(false); // empty set removed
      expect(await attempt({})).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retired dispatcher drain still blocked beyond the timeout => throws (nothing may be destroyed); once released => proceeds', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    let release!: () => void;
    const retiredDrain = new Promise<void>((r) => { release = r; });
    trackPending(pending, G, retiredDrain); // what the dispatcher-replace / teardown path does
    const destroy = vi.fn();

    await expect(teardownForReplace(G, {}, pending, 30).then(destroy)).rejects.toThrow(/still running/);
    expect(destroy).not.toHaveBeenCalled();

    release();
    await retiredDrain;
    await Promise.resolve();
    await expect(teardownForReplace(G, {}, pending, 30).then(destroy)).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('a retired subscription ingest still blocked => throws (nothing may be destroyed); once released => proceeds', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    let release!: () => void;
    const retiredIngest = new Promise<void>((r) => { release = r; });
    trackPending(pending, G, retiredIngest); // what the effect cleanup does

    await expect(teardownForReplace(G, {}, pending, 30)).rejects.toThrow(/still running/);

    release();
    await retiredIngest;
    await Promise.resolve();
    await expect(teardownForReplace(G, {}, pending, 30)).resolves.toBeUndefined();
    expect(pending.has(G)).toBe(false);
  });
});

describe('trackPending bookkeeping', () => {
  it('several unsettled promises share one set: settling one keeps the others and the map entry', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    let rA!: () => void;
    let rB!: () => void;
    trackPending(pending, G, new Promise<void>((r) => { rA = r; }));
    trackPending(pending, G, new Promise<void>((r) => { rB = r; }));
    expect(pending.get(G)!.size).toBe(2);

    rB();
    await vi.waitFor(() => expect(pending.get(G)!.size).toBe(1)); // A still tracked
    rA();
    await vi.waitFor(() => expect(pending.has(G)).toBe(false));
  });

  it('a settle after the entry was removed elsewhere is harmless', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    let r!: () => void;
    trackPending(pending, G, new Promise<void>((res) => { r = res; }));
    pending.clear();
    r();
    await new Promise((res) => setTimeout(res, 5)); // an unhandled TypeError would fail the run
    expect(pending.size).toBe(0);
  });
});
