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
 * the frame, and enqueue must be the LAST action of a handler/sink call, after
 * its own awaits.
 *
 *  - a job starts after the enqueuing synchronous frame returns (macrotask,
 *    never a microtask, never synchronously from `enqueue`);
 *  - jobs run strictly one at a time, in enqueue order;
 *  - a rejecting job is reported and does not stall the queue.
 *
 * Pure module: no browser API, no React.
 */

export interface ClientJobQueue {
  /** Schedules `job` to start after the calling synchronous frame returns (a later macrotask). Call it as the last action of a handler/sink call, after its own awaits. */
  enqueue: (job: () => Promise<void>) => void;
}

export interface JobQueue extends ClientJobQueue {
  /** Resolves once every job enqueued so far has settled (test / teardown aid). */
  idle: () => Promise<void>;
  /** Drops jobs that have not started; a running job is not interrupted. */
  dispose: () => void;
}

export interface JobQueueOptions {
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

  const pending: Array<() => Promise<void>> = [];
  let draining = false;
  let disposed = false;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (pending.length === 0 && !draining) {
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
    // Always hop through a macrotask before starting a job, so the job never
    // runs inside (or as a continuation of) the frame that enqueued it.
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
    enqueue(job) {
      if (typeof job !== 'function') {
        throw new TypeError('ClientJobQueue.enqueue expects a function');
      }
      if (disposed) return;
      pending.push(job);
      pump();
    },
    idle() {
      if (pending.length === 0 && !draining) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      if (!draining) settleIdle();
    },
  };
}
