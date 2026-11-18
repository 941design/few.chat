import { bootstrapAccountClient, type AccountClient, type BootstrapInput, type BootstrapResult } from './createClient';
import { ensureKeyPackage } from './keyPackageEnsure';
import { pageStoreWipeGuard, resumeWipeCleanup, type StoreWipeGuard, type WipeCheckpoint } from './wipe';

type UnsupportedReason = Extract<BootstrapResult, { status: 'unsupported' }>['reason'];

export type LeaseState =
  | { state: 'waiting' }
  | { state: 'held'; account: AccountClient }
  | { state: 'unsupported'; reason: UnsupportedReason | 'store-incompatible' | 'signer-timeout' | 'startup' };

export interface AccountLifecycle {
  whenReady(): Promise<void>;
  stop(): Promise<void>;
}

export interface AccountLifecycleOptions {
  makeInput(signal: AbortSignal): BootstrapInput;
  onState(state: LeaseState): void;
  clearAllGroupData(pubkey: string): Promise<void>;
  wipeCheckpoint: WipeCheckpoint;
  onError(error: unknown): void;
  start?: (input: BootstrapInput) => Promise<BootstrapResult>;
  wipeGuard?: StoreWipeGuard;
  pollMs?: number;
  keyPackageRetryMs?: number;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Own the client's lease and handoff until the account effect is torn down. */
export function startAccountLifecycle(options: AccountLifecycleOptions): AccountLifecycle {
  const stopped = new AbortController();
  const start = options.start ?? bootstrapAccountClient;
  const wipeGuard = options.wipeGuard ?? pageStoreWipeGuard;
  const pollMs = options.pollMs ?? 500;
  const keyPackageRetryMs = options.keyPackageRetryMs ?? 5_000;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  function emit(state: LeaseState) {
    if (stopped.signal.aborted) return;
    options.onState(state);
    resolveReady();
  }

  async function monitor(account: AccountClient, signal: AbortSignal) {
    let needsKeyPackage = account.ensure.keyPackage === 'failed';
    let running = false;
    let retryAt = Date.now() + keyPackageRetryMs;
    try {
      if (!signal.aborted && account.handle.leaseHeld()) emit({ state: 'held', account });
      while (!signal.aborted && account.handle.leaseHeld()) {
        await wait(pollMs, signal);
        if (signal.aborted || !account.handle.leaseHeld()) break;
        if (needsKeyPackage && !running && Date.now() >= retryAt) {
          running = true;
          void ensureKeyPackage(account.handle.client)
            .then(() => { needsKeyPackage = false; })
            .catch((error) => {
              if (!signal.aborted) options.onError(error);
            })
            .finally(() => {
              retryAt = Date.now() + keyPackageRetryMs;
              running = false;
            });
        }
      }
    } finally {
      // A held snapshot should no longer permit group operations while teardown drains.
      emit({ state: 'waiting' });
      await account.teardown();
    }
  }

  async function run() {
    while (!stopped.signal.aborted) {
      const attempt = new AbortController();
      const stopAttempt = () => attempt.abort();
      stopped.signal.addEventListener('abort', stopAttempt, { once: true });
      let incompatible = false;
      let incompatibleError: unknown;
      let wiped = false;
      try {
        const input = options.makeInput(attempt.signal);
        const result = await start({
          ...input,
          signal: attempt.signal,
          clientEvents: {
            ...input.clientEvents,
            storeIncompatible(event) {
              incompatible = true;
              incompatibleError = event.error;
              attempt.abort();
              input.clientEvents.storeIncompatible(event);
            },
          },
          async beforeClientConstruction(stores) {
            await resumeWipeCleanup(stores, options.wipeCheckpoint, options.clearAllGroupData);
            await input.beforeClientConstruction?.(stores);
          },
          async beforeStoresClose(stores) {
            if (incompatible && !stopped.signal.aborted) {
              wiped = await wipeGuard.wipe(stores, options.clearAllGroupData, options.wipeCheckpoint) === 'wiped';
            }
            await input.beforeStoresClose?.(stores);
          },
        });
        if (result.status === 'ready') {
          await monitor(result.account, attempt.signal);
        } else if (result.status === 'lease-held') {
          emit({ state: 'waiting' });
        } else if (result.status !== 'aborted') {
          emit({ state: 'unsupported', reason: result.status === 'unsupported' ? result.reason : result.status });
          return;
        }
      } catch (error) {
        // A rejected read may have emitted storeIncompatible before bootstrap
        // closed the account. Retry only that read's error after a committed
        // wipe. Teardown errors must remain fatal even after the wipe.
        if (!wiped || error !== incompatibleError) {
          if (!stopped.signal.aborted) options.onError(error);
          emit({ state: 'unsupported', reason: incompatible ? 'store-incompatible' : 'startup' });
          return;
        }
      } finally {
        stopped.signal.removeEventListener('abort', stopAttempt);
      }
      if (incompatible && !wiped) {
        emit({ state: 'unsupported', reason: 'store-incompatible' });
        return;
      }
      await wait(pollMs, stopped.signal);
    }
  }

  const done = Promise.resolve().then(run).finally(resolveReady);
  return {
    whenReady: () => ready,
    stop() {
      stopped.abort();
      return done;
    },
  };
}
