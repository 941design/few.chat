/**
 * Owned FIFO for follow-up client work (seam `ClientJobQueue`).
 *
 * Why this exists: @941design/marmot runs `registerInboxHandler` handlers,
 * `HistoryBackend` calls and `client.on(...)` listeners inside a re-entrancy
 * frame. An account-scope client call made from inside that frame (or from a
 * continuation that inherits it) rejects with MarmotError `reentrant`. The
 * library marks a frame dead only when the surface's promise settles, and on
 * Node AsyncLocalStorage propagates the frame into timers started from it, so
 * a `setTimeout(0)` is NOT a guarantee that the frame is dead. What the queue
 * guarantees is ordering: follow-up work is queued here, never awaited inside
 * the frame. Hold jobs associated with the callback until it settles, including
 * sink writes that finish after the application handler returns.
 *
 *  - ready jobs run one at a time in FIFO order on a later macrotask;
 *  - each callback's jobs enter the ready queue in submission order when its scope settles;
 *  - a rejecting job is reported and does not stall the queue.
 *
 * Pure module: no browser API, no React.
 */

export const INBOX_CALLBACK = Symbol('Marmot inbox callback');
export type ClientCallbackScope = string | typeof INBOX_CALLBACK;
type Job = () => Promise<void>;

export interface ClientJobQueue {
  /** Queues a job on a later macrotask. Use the group ID or inbox scope from a library callback. */
  enqueue: (job: Job, scope?: ClientCallbackScope) => void;
}

export interface JobQueue extends ClientJobQueue {
  /** Holds jobs from this scope until its asynchronous library callbacks settle. */
  runInCallback: <T>(scope: ClientCallbackScope, callback: () => T | Promise<T>) => Promise<T>;
  /** Resolves once every job enqueued so far has settled (test / teardown aid). */
  idle: () => Promise<void>;
  /** Drops jobs that have not started; a running job is not interrupted. */
  dispose: () => void;
}

interface JobQueueOptions {
  /** Called with whatever a job threw / rejected with. Default: `console.error`. */
  onError?: (error: unknown) => void;
}

export function createJobQueue(options: JobQueueOptions = {}): JobQueue {
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error('[marmot/client] queued job failed', error);
    });
  const schedule = (run: () => void) => void setTimeout(run, 0);

  const pending: Job[] = [];
  const callbacks = new Map<ClientCallbackScope, { active: number; jobs: Job[] }>();
  let draining = false;
  let disposed = false;
  let idleWaiters: Array<() => void> = [];

  const isIdle = () => pending.length === 0 && !draining &&
    !Array.from(callbacks.values()).some(({ jobs }) => jobs.length > 0);

  const settleIdle = () => {
    if (isIdle()) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  const pump = () => {
    if (draining || disposed || pending.length === 0) {
      settleIdle();
      return;
    }
    draining = true;
    // Give the pinned library's promise continuation a turn to close its frame.
    schedule(() => {
      const job = pending.shift();
      if (!job || disposed) {
        draining = false;
        settleIdle();
        return;
      }
      let result: Promise<void>;
      try {
        result = Promise.resolve(job());
      } catch (error) {
        result = Promise.reject(error);
      }
      result
        .catch((error: unknown) => {
          try {
            onError(error);
          } catch {
            /* an error reporter must never stall the queue */
          }
        })
        .then(() => {
          draining = false;
          pump();
        });
    });
  };

  return {
    enqueue(job, scope) {
      if (typeof job !== 'function') {
        throw new TypeError('ClientJobQueue.enqueue expects a function');
      }
      if (disposed) return;
      const callback = scope === undefined ? undefined : callbacks.get(scope);
      if (callback) {
        callback.jobs.push(job);
        return;
      }
      pending.push(job);
      pump();
    },
    async runInCallback(scope, callback) {
      const state = callbacks.get(scope) ?? { active: 0, jobs: [] };
      callbacks.set(scope, state);
      state.active++;
      try {
        return await callback();
      } finally {
        state.active--;
        if (state.active === 0) {
          callbacks.delete(scope);
          if (!disposed) pending.push(...state.jobs);
          pump();
        }
      }
    },
    idle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      callbacks.clear();
      if (!draining) settleIdle();
    },
  };
}
