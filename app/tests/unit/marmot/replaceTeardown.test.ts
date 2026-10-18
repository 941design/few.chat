import { describe, it, expect, vi } from 'vitest';
import { runTracked, teardownForReplace, trackPending, trackRetiredSetup } from '@/src/lib/marmot/replaceTeardown';

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

// Bug stale-replace-retired-setup-untracked: an effect restart retires a setup
// still blocked in its historical ingest. The retired setup hands over its
// ingest-idle / dispatcher drain only when it finishes — after a replace may
// already have snapshotted `pending`.
describe('trackRetiredSetup — a retired setup and the work it hands over', () => {
  function retiredSetup() {
    const handedOver: Promise<unknown>[] = [];
    let finish!: () => void;
    const setup = new Promise<void>((r) => { finish = r; });
    return { handedOver, setup, finish };
  }

  it('blocks a replace until the setup AND the idle it hands over later have settled', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const retired = retiredSetup();
    trackRetiredSetup(pending, G, retired.setup, () => retired.handedOver); // effect cleanup
    const destroy = vi.fn();

    // replace starts while the retired setup still runs
    const replace = teardownForReplace(G, {}, pending, 200).then(destroy);

    // the retired setup finishes and hands over an ingest that is still saving
    let releaseIdle!: () => void;
    retired.handedOver.push(new Promise<void>((r) => { releaseIdle = r; }));
    retired.finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(destroy).not.toHaveBeenCalled();

    releaseIdle();
    await replace;
    expect(destroy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(pending.has(G)).toBe(false));
  });

  it('a handed-over idle that never settles => the replace throws (fails closed)', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const retired = retiredSetup();
    trackRetiredSetup(pending, G, retired.setup, () => retired.handedOver);
    const replace = teardownForReplace(G, {}, pending, 30);
    retired.handedOver.push(never());
    retired.finish();
    await expect(replace).rejects.toThrow(/still running/);
    expect(pending.get(G)!.size).toBe(1); // still remembered for the next attempt
  });

  it('a setup that never finishes => the replace throws', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    trackRetiredSetup(pending, G, never(), () => []);
    await expect(teardownForReplace(G, {}, pending, 20)).rejects.toThrow(/still running/);
  });

  it('rejections of the setup or the handed-over work count as finished', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    trackRetiredSetup(pending, G, Promise.reject(new Error('setup failed')), () => [
      Promise.reject(new Error('drain failed')),
    ]);
    await expect(teardownForReplace(G, {}, pending, 50)).resolves.toBeUndefined();
  });

  it('nothing handed over: the entry is dropped once the setup settles', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const retired = retiredSetup();
    trackRetiredSetup(pending, G, retired.setup, () => retired.handedOver);
    expect(pending.get(G)!.size).toBe(1);
    retired.finish();
    await vi.waitFor(() => expect(pending.has(G)).toBe(false));
  });

  it('reads the handed-over work only after the setup settled', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const retired = retiredSetup();
    const handedOver = vi.fn(() => retired.handedOver);
    trackRetiredSetup(pending, G, retired.setup, handedOver);
    await Promise.resolve();
    expect(handedOver).not.toHaveBeenCalled();
    retired.finish();
    await vi.waitFor(() => expect(handedOver).toHaveBeenCalledTimes(1));
  });
});

// Bug replace-does-not-await-onmemberschanged: group work the subscription starts
// itself (the members-changed body + auto-commit, the history-synced profile send)
// is tracked from the moment it starts, so a replace waits for it.
describe('runTracked — subscription-started group work', () => {
  function gate<T = void>() {
    let release!: (v: T) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { release = res; fail = rej; });
    return { promise, release, fail };
  }

  it('tracks the work synchronously and returns its result', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const g = gate<number>();
    const result = runTracked(pending, G, () => g.promise);
    expect(pending.get(G)!.size).toBe(1);
    g.release(42);
    await expect(result).resolves.toBe(42);
    await vi.waitFor(() => expect(pending.has(G)).toBe(false));
  });

  it('a replace started while the work is suspended waits for it', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const g = gate();
    void runTracked(pending, G, async () => { await g.promise; });
    const destroy = vi.fn();
    const replace = teardownForReplace(G, {}, pending, 200).then(destroy);
    await new Promise((r) => setTimeout(r, 20));
    expect(destroy).not.toHaveBeenCalled();
    g.release();
    await replace;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('work that never settles => the replace throws (fails closed)', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    void runTracked(pending, G, never);
    await expect(teardownForReplace(G, {}, pending, 20)).rejects.toThrow(/still running/);
  });

  it('a rejection reaches the caller and still releases the replace', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const g = gate();
    const result = runTracked(pending, G, () => g.promise);
    g.fail(new Error('persist failed'));
    await expect(result).rejects.toThrow('persist failed');
    await expect(teardownForReplace(G, {}, pending, 50)).resolves.toBeUndefined();
  });

  it('a synchronous throw of the work is a rejection, not a throw at the call site', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const result = runTracked(pending, G, () => { throw new Error('boom'); });
    await expect(result).rejects.toThrow('boom');
    await expect(teardownForReplace(G, {}, pending, 50)).resolves.toBeUndefined();
  });

  it('work started while the replace waits for leftovers (before abort) is waited for too', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const leftover = gate();
    trackPending(pending, G, leftover.promise);
    const destroy = vi.fn();
    const replace = teardownForReplace(G, {}, pending, 200).then(destroy);

    // the still-current subscription fires a members-changed body now
    const late = gate();
    void runTracked(pending, G, async () => { await late.promise; });
    leftover.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(destroy).not.toHaveBeenCalled();

    late.release();
    await replace;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('late work that never settles => the replace throws', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const leftover = gate();
    trackPending(pending, G, leftover.promise);
    const replace = teardownForReplace(G, {}, pending, 30);
    void runTracked(pending, G, never);
    leftover.release();
    await expect(replace).rejects.toThrow(/still running/);
  });

  it('work started during the idle wait is waited for too', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const late = gate();
    const destroy = vi.fn();
    const replace = teardownForReplace(G, {
      // an ingest finishing now fires the (untracked by idle) callback
      idle: async () => { void runTracked(pending, G, async () => { await late.promise; }); },
    }, pending, 200).then(destroy);
    await new Promise((r) => setTimeout(r, 20));
    expect(destroy).not.toHaveBeenCalled();
    late.release();
    await replace;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('control: work of another group does not block the replace', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    void runTracked(pending, 'other', never);
    await expect(teardownForReplace(G, {}, pending, 20)).resolves.toBeUndefined();
  });
});

// The late wait must not wait a second time for work that already timed out:
// a stuck piece costs exactly one waitMs before the replace throws.
describe('teardownForReplace — one timeout per stuck piece (fake timers)', () => {
  async function settlesAfter(run: () => Promise<unknown>, waitMs: number): Promise<string[]> {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      void run().then(() => seen.push('ok'), () => seen.push('rejected'));
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      seen.push('|');
      await vi.advanceTimersByTimeAsync(2);
      return seen;
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    ['setup', { setup: never() }],
    ['idle', { idle: never }],
    ['drain', { drain: never }],
  ] as const)('a stuck %s rejects right after one waitMs', async (_name, handles) => {
    expect(await settlesAfter(() => teardownForReplace(G, handles, new Map(), 100), 100)).toEqual(['|', 'rejected']);
  });

  it('a stuck leftover rejects right after one waitMs', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    trackPending(pending, G, never());
    expect(await settlesAfter(() => teardownForReplace(G, {}, pending, 100), 100)).toEqual(['|', 'rejected']);
  });

  it('settled work only: no wait at all', async () => {
    expect(await settlesAfter(() => teardownForReplace(G, { idle: async () => {} }, new Map(), 100), 1)).toEqual(['ok', '|']);
  });
});

// Each step waits for the one before it: the late wait would still catch a skipped
// wait, but the steps would then run under the unfinished work.
describe('teardownForReplace — a pending step holds back the next', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('leftover work holds back abort', async () => {
    const pending = new Map<string, Set<Promise<unknown>>>();
    const g = gate();
    trackPending(pending, G, g.promise);
    const abort = vi.fn();
    const replace = teardownForReplace(G, { abort }, pending, 200);
    await tick();
    expect(abort).not.toHaveBeenCalled();
    g.release();
    await replace;
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('the setup holds back unsub', async () => {
    const g = gate();
    const unsub = vi.fn();
    const replace = teardownForReplace(G, { setup: g.promise, unsub }, new Map(), 200);
    await tick();
    expect(unsub).not.toHaveBeenCalled();
    g.release();
    await replace;
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('the idle wait holds back cancelTimers and drain', async () => {
    const g = gate();
    const cancelTimers = vi.fn();
    const drain = vi.fn(async () => {});
    const replace = teardownForReplace(G, { idle: () => g.promise, cancelTimers, drain }, new Map(), 200);
    await tick();
    expect(cancelTimers).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    g.release();
    await replace;
    expect(cancelTimers).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
