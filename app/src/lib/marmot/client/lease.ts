import { bootstrapAccountClient, type AccountClient, type BootstrapInput, type BootstrapResult } from './createClient';
import { ensureKeyPackage } from './keyPackageEnsure';
import { pageStoreWipeGuard, resumeWipeCleanup, type StoreWipeGuard, type WipeCheckpoint } from './wipe';

type UnsupportedReason = Extract<BootstrapResult, { status: 'unsupported' }>['reason'];
type StartupFailure = 'signer-timeout' | 'startup';

export type LeaseState =
  | { state: 'waiting' }
  | { state: 'held'; account: AccountClient }
  | { state: 'retrying'; reason: StartupFailure }
  | { state: 'unsupported'; reason: UnsupportedReason | 'store-incompatible' | 'startup' };

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
  isCurrent?(): boolean;
  start?: (input: BootstrapInput) => Promise<BootstrapResult>;
  wipeGuard?: StoreWipeGuard;
  pollMs?: number;
  keyPackageRetryMs?: number;
  startupRetryMs?: number;
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
  const startupRetryMs = options.startupRetryMs ?? 2_000;
  const isCurrent = options.isCurrent ?? (() => true);
  let lastState: LeaseState | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  function emit(state: LeaseState) {
    if (stopped.signal.aborted) return;
    if (lastState && state.state === lastState.state &&
        (state.state === 'waiting' ||
          ('reason' in state && 'reason' in lastState && state.reason === lastState.reason))) return;
    lastState = state;
    options.onState(state);
    resolveReady();
  }

  async function monitor(account: AccountClient, signal: AbortSignal) {
    let needsKeyPackage = account.ensure.keyPackage === 'failed';
    const retryInboxRelayList = account.retryInboxRelayList;
    let needsInboxRelayList = !!retryInboxRelayList && account.ensure.inboxRelayList === 'failed';
    const isLive = () => !signal.aborted && account.handle.leaseHeld() && isCurrent();
    let running = false;
    let retryAt = Date.now() + keyPackageRetryMs;
    const report = (error: unknown) => { if (isLive()) options.onError(error); };
    async function retryEnsures() {
      if (needsKeyPackage && isLive()) {
        try {
          await ensureKeyPackage(account.handle.client);
          needsKeyPackage = false;
        } catch (error) {
          report(error);
        }
      }
      if (retryInboxRelayList && needsInboxRelayList && isLive()) {
        try {
          await retryInboxRelayList();
          needsInboxRelayList = false;
        } catch (error) {
          report(error);
        }
      }
    }
    try {
      if (isLive()) emit({ state: 'held', account });
      while (isLive()) {
        await wait(pollMs, signal);
        if (!isLive()) break;
        if ((needsKeyPackage || needsInboxRelayList) && !running && Date.now() >= retryAt) {
          running = true;
          void retryEnsures()
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
    let nextRetryMs = startupRetryMs;
    while (!stopped.signal.aborted) {
      if (!isCurrent()) {
        emit({ state: 'unsupported', reason: 'startup' });
        return;
      }
      const attempt = new AbortController();
      const stopAttempt = () => attempt.abort();
      stopped.signal.addEventListener('abort', stopAttempt, { once: true });
      let incompatible = false;
      let incompatibleError: unknown;
      let wiped = false;
      let monitoring = false;
      let retryReason: StartupFailure | undefined;
      try {
        const input = options.makeInput(attempt.signal);
        const result = await start({
          ...input,
          isCurrent,
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
            if (!isCurrent()) throw new Error('The device was reset while waiting for the account lease');
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
          nextRetryMs = startupRetryMs;
          monitoring = true;
          await monitor(result.account, attempt.signal);
        } else if (result.status === 'lease-held') {
          nextRetryMs = startupRetryMs;
          emit({ state: 'waiting' });
        } else if (result.status === 'unsupported') {
          emit({ state: 'unsupported', reason: result.reason });
          return;
        } else if (result.status === 'signer-timeout') {
          retryReason = result.status;
        }
      } catch (error) {
        // A rejected read may have emitted storeIncompatible before bootstrap
        // closed the account. Retry only that read's error after a committed
        // wipe. Teardown errors must remain fatal even after the wipe.
        if (!wiped || error !== incompatibleError) {
          if (stopped.signal.aborted) return;
          if (!isCurrent()) {
            emit({ state: 'unsupported', reason: 'startup' });
            return;
          }
          options.onError(error);
          if (incompatible || monitoring || error instanceof AggregateError) {
            emit({ state: 'unsupported', reason: incompatible ? 'store-incompatible' : 'startup' });
            return;
          }
          retryReason = 'startup';
        }
      } finally {
        stopped.signal.removeEventListener('abort', stopAttempt);
      }
      if (incompatible && !wiped) {
        emit({ state: 'unsupported', reason: 'store-incompatible' });
        return;
      }
      if (retryReason) {
        emit({ state: 'retrying', reason: retryReason });
        await wait(nextRetryMs, stopped.signal);
        nextRetryMs = Math.min(nextRetryMs * 2, 30_000);
      } else {
        await wait(pollMs, stopped.signal);
      }
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
