/**
 * Teardown of one account client.
 *
 * Order is part of the contract: group/event listeners are released, then
 * `client.dispose()` (sync; later client calls throw `disposed`), then
 * `await stores.close()` (waits for an in-flight commit, releases the lease),
 * then the transport pool is closed. Every step runs even when an earlier one
 * throws; the first error is rethrown afterwards. Idempotent: a second call
 * returns the first call's promise.
 */
import type { MarmotClient } from '@941design/marmot';
import type { WritableStores } from '@941design/marmot/storage';
import type { JobQueue } from './fifo';

export interface TeardownParts {
  client: Pick<MarmotClient, 'dispose'>;
  stores: Pick<WritableStores, 'close'>;
  closePool: () => void;
  queue: Pick<JobQueue, 'dispose'>;
  /** Unsubscribe functions of every listener this module attached. */
  unsubscribers: Array<() => void>;
}

export function createTeardown(parts: TeardownParts): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => {
    done ??= (async () => {
      let firstError: unknown;
      let failed = false;
      const attempt = async (step: () => unknown) => {
        try {
          await step();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      };
      await attempt(() => parts.queue.dispose());
      for (const unsubscribe of parts.unsubscribers.splice(0)) {
        await attempt(unsubscribe);
      }
      await attempt(() => parts.client.dispose());
      await attempt(() => parts.stores.close());
      await attempt(() => parts.closePool());
      if (failed) throw firstError;
    })();
    return done;
  };
}
