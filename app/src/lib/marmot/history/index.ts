/**
 * history — the app's durable, ordered, at-least-once `HistoryBackend` sink
 * over the per-account `few-group-history:<pubkey>` idb store. Public surface of the module; other
 * modules import only from here.
 */
export {
  createHistoryBackend,
  HISTORY_SETTLE_TIMEOUT_MS,
  type AppHistoryBackend,
  type GroupHistoryHandlers,
  type GroupRumorInput,
  type RetractInput,
} from './historyBackend';
export { createAccountHistoryStore, createIdbHistoryStore, historyDbName, HISTORY_DB_NAME, type HistoryRow, type HistoryStore } from './historyStore';
export { type SweepResult } from './sweep';

import { createAccountHistoryStore } from './historyStore';

/**
 * Deletes every row of every group of ONE account's `few-group-history:<pubkey>` store (`clearAllGroupData`,
 * storeIncompatible wipe). Other accounts' stores are untouched.
 *
 * Bypasses the backend's per-group serialiser: call it ONLY after that account's backend is disposed (the client
 * teardown has settled), otherwise a live append/recovery can interleave with the wipe and re-create rows.
 * Safe after dispose because a disposed backend's store writes are no-ops: nothing can land after the wipe.
 */
export function clearAllGroupHistory(accountPubkey: string): Promise<void> {
  return createAccountHistoryStore(accountPubkey).clearAll();
}
