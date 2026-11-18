import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WritableStores } from '@941design/marmot/storage';
import {
  createStoreWipeGuard,
  startAccountLifecycle,
  type AccountClient,
  type AccountLifecycleOptions,
  type BootstrapInput,
  type LeaseState,
} from '@/src/lib/marmot/client';

const pollMs = 10;
const abortSignal = () => new AbortController().signal;
const makeInput = (signal = abortSignal()) => ({
  signal,
  clientEvents: { storeIncompatible: () => {} },
}) as unknown as BootstrapInput;

function fakeStores(held: () => boolean, trace: string[]) {
  let marker: any;
  return {
    lease: { get held() { return held(); } },
    account: {
      account: 'account',
      wipeMarker: vi.fn(async () => marker),
      wipe: vi.fn(async (_opts: unknown) => { trace.push('wipe'); marker = { at: Date.now(), reason: 'incompatible', engine: 'e', tsMls: 't' }; return marker; }),
    },
  } as unknown as WritableStores;
}

type Start = NonNullable<AccountLifecycleOptions['start']>;
function rig(start: Start, clearAllGroupData = vi.fn(async (_pubkey: string) => {}), isCurrent?: () => boolean) {
  const states: LeaseState[] = [];
  const onError = vi.fn();
  const intents = new Map<string, any>();
  const wipeCheckpoint = { read: async (pk: string) => intents.get(pk), write: async (pk: string, previousMarker: any) => { intents.set(pk, { previousMarker }); }, clear: async (pk: string) => { intents.delete(pk); } };
  const lifecycle = startAccountLifecycle({
    makeInput,
    start,
    wipeGuard: createStoreWipeGuard(),
    onState: (state) => states.push(state),
    onError,
    isCurrent,
    clearAllGroupData,
    wipeCheckpoint,
    pollMs,
    startupRetryMs: 20,
    keyPackageRetryMs: 50,
  });
  return { states, lifecycle, clearAllGroupData, onError };
}

afterEach(() => vi.useRealTimers());

describe('Account lifecycle', () => {
  it('resolves whenReady in the waiting tab and takes over after the first lease is released', async () => {
    vi.useFakeTimers();
    let held = false;
    const actions: string[] = [];
    const start: Start = async () => {
      if (held) return { status: 'lease-held' };
      held = true;
      const account = {
        handle: { leaseHeld: () => held },
        ensure: { keyPackage: 'present' },
        async teardown() {
          actions.push('dispose', 'close');
          held = false;
        },
      } as AccountClient;
      return { status: 'ready', account };
    };

    const first = rig(start);
    await first.lifecycle.whenReady();
    const second = rig(start);
    await second.lifecycle.whenReady();
    expect(first.states.map(({ state }) => state)).toEqual(['held']);
    expect(second.states).toEqual([{ state: 'waiting' }]);
    await vi.advanceTimersByTimeAsync(4 * pollMs);
    expect(second.states).toEqual([{ state: 'waiting' }]);

    await first.lifecycle.stop();
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(second.states.map(({ state }) => state)).toEqual(['waiting', 'held']);
    await second.lifecycle.stop();
    expect(actions).toEqual(['dispose', 'close', 'dispose', 'close']);
  });

  it.each(['signer-timeout', 'startup'] as const)('recovers from a transient %s without a reload', async (reason) => {
    vi.useFakeTimers();
    const account = {
      handle: { leaseHeld: () => true },
      ensure: { keyPackage: 'present', inboxRelayList: 'ok' },
      teardown: vi.fn(async () => {}),
    } as unknown as AccountClient;
    const start = vi.fn<Start>().mockResolvedValue({ status: 'ready', account });
    if (reason === 'signer-timeout') start.mockResolvedValueOnce({ status: 'signer-timeout' });
    else start.mockRejectedValueOnce(new Error('temporary startup failure'));

    const { states, lifecycle } = rig(start);
    await lifecycle.whenReady();
    expect(states).toEqual([{ state: 'retrying', reason }]);
    await vi.advanceTimersByTimeAsync(19);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual([{ state: 'retrying', reason }, { state: 'held', account }]);
    await lifecycle.stop();
    expect(account.teardown).toHaveBeenCalledOnce();
  });

  it('retries a failed inbox relay list while leased and stops trying once it succeeds', async () => {
    vi.useFakeTimers();
    const failure = new Error('relay lookup timed out');
    const retryInboxRelayList = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const account = {
      handle: { leaseHeld: () => true },
      ensure: { keyPackage: 'present', inboxRelayList: 'failed' },
      retryInboxRelayList,
      teardown: vi.fn(async () => {}),
    } as unknown as AccountClient;
    const { lifecycle, onError } = rig(async () => ({ status: 'ready', account }));
    await lifecycle.whenReady();
    await vi.advanceTimersByTimeAsync(200);
    expect(retryInboxRelayList).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await lifecycle.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(retryInboxRelayList).toHaveBeenCalledTimes(2);
  });

  it('refuses to construct a client when a device reset completes during lease acquisition', async () => {
    vi.useFakeTimers();
    let current = true;
    let leaseAcquired = false;
    const createClient = vi.fn();
    const close = vi.fn();
    const stores = fakeStores(() => leaseAcquired, []);
    const start = vi.fn<Start>(async (input) => {
      if (!leaseAcquired) return { status: 'lease-held' };
      // A waiting tab may get the lease before its account-change event is delivered.
      current = false;
      try {
        await input.beforeClientConstruction!(stores);
        createClient();
        return { status: 'aborted' };
      } finally {
        close();
      }
    });
    const { lifecycle, states } = rig(start, undefined, () => current);
    await lifecycle.whenReady();
    leaseAcquired = true;
    await vi.advanceTimersByTimeAsync(4 * pollMs);
    expect(createClient).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(states).toEqual([{ state: 'waiting' }, { state: 'unsupported', reason: 'startup' }]);
    await lifecycle.stop();
  });

  it('wipes after disposal and before lease release, restarts once, then reports unsupported', async () => {
    vi.useFakeTimers();
    const trace: string[] = [];
    const stores = fakeStores(() => true, trace);
    const start: Start = async (input) => {
      trace.push('client');
      input.clientEvents.storeIncompatible({} as never);
      expect(input.signal?.aborted).toBe(true);
      trace.push('dispose');
      await input.beforeStoresClose!(stores);
      trace.push('close');
      return { status: 'aborted' };
    };
    const clear = vi.fn(async (_pubkey: string) => { trace.push('clear group data'); });
    const { states, lifecycle } = rig(start, clear);

    await vi.advanceTimersByTimeAsync(pollMs);
    await lifecycle.whenReady();
    expect(trace).toEqual(['client', 'dispose', 'wipe', 'clear group data', 'close', 'client', 'dispose', 'close']);
    expect(stores.account.wipe).toHaveBeenCalledExactlyOnceWith({ reason: 'incompatible' });
    expect(clear).toHaveBeenCalledExactlyOnceWith('account');
    expect(states).toEqual([{ state: 'unsupported', reason: 'store-incompatible' }]);
    await lifecycle.stop();
  });

  it('does not clear app stores or restart if the library wipe fails', async () => {
    vi.useFakeTimers();
    const stores = fakeStores(() => true, []);
    const failure = new Error('IDB unavailable');
    vi.mocked(stores.account.wipe).mockRejectedValue(failure);
    const start = vi.fn<Start>(async (input) => {
      input.clientEvents.storeIncompatible({} as never);
      await input.beforeStoresClose!(stores);
      return { status: 'aborted' };
    });
    const { states, lifecycle, clearAllGroupData, onError } = rig(start);
    await lifecycle.whenReady();
    await vi.advanceTimersByTimeAsync(3 * pollMs);
    expect(states).toEqual([{ state: 'unsupported', reason: 'store-incompatible' }]);
    expect(clearAllGroupData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(start).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
  });

  it('never restarts if close fails after a successful wipe', async () => {
    const stores = fakeStores(() => true, []);
    const failure = new Error('close failed');
    const start = vi.fn<Start>(async (input) => {
      input.clientEvents.storeIncompatible({} as never);
      await input.beforeStoresClose!(stores);
      throw failure;
    });
    const { states, lifecycle, onError } = rig(start);
    await lifecycle.whenReady();
    expect(start).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ state: 'unsupported', reason: 'store-incompatible' }]);
    expect(onError).toHaveBeenCalledWith(failure);
    await lifecycle.stop();
  });

  it('reacquires the lease after teardown rejects the read that reported incompatibility', async () => {
    vi.useFakeTimers();
    const trace: string[] = [];
    const stores = fakeStores(() => true, trace);
    const failure = new Error('incompatible envelope');
    const start = vi.fn<Start>(async (input) => {
      if (trace.includes('closed')) {
        return { status: 'ready', account: {
          handle: { leaseHeld: () => true },
          ensure: { keyPackage: 'present' },
          teardown: async () => {},
        } as unknown as AccountClient };
      }
      input.clientEvents.storeIncompatible({ error: failure } as never);
      trace.push('disposed');
      await input.beforeStoresClose!(stores);
      trace.push('closed');
      throw failure;
    });
    const { states, lifecycle, clearAllGroupData, onError } = rig(start);
    await vi.advanceTimersByTimeAsync(pollMs);
    await lifecycle.whenReady();
    expect(states.map(({ state }) => state)).toEqual(['held']);
    expect(trace).toEqual(['disposed', 'wipe', 'closed']);
    expect(start).toHaveBeenCalledTimes(2);
    expect(clearAllGroupData).toHaveBeenCalledExactlyOnceWith('account');
    expect(onError).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  it('aborts an in-flight bootstrap on stop and disposes an account that resolves late', async () => {
    const teardown = vi.fn(async () => {});
    let complete!: () => void;
    const start = vi.fn<Start>(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
      return {
        status: 'ready',
        account: { handle: { leaseHeld: () => true }, ensure: {}, teardown } as unknown as AccountClient,
      };
    });
    const { states, lifecycle } = rig(start);
    await Promise.resolve();
    const stopped = lifecycle.stop();
    expect(start.mock.calls[0][0].signal?.aborted).toBe(true);
    complete();
    await stopped;
    expect(states).toEqual([]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
