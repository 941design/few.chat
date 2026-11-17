/**
 * Per-account IndexedDB stores + lease (the library's `marmot:<pubkey>` DB).
 *
 * `openForWrite` takes an exclusive Web Lock per account, so only one tab per
 * account can run a client. A second tab gets `lease-held` after the lease
 * timeout; this module reports that as a value, not a throw. Waiting for the
 * lease and lease-loss handling belong to a later story.
 */
import { createIndexedDbStorage } from '@941design/marmot/storage/indexeddb';
import type { StorageBackend, WritableStores } from '@941design/marmot/storage';
import { isMarmotError } from '@941design/marmot';

export type OpenStoresResult =
  | { status: 'opened'; stores: WritableStores }
  | { status: 'lease-held' }
  /** The host lacks IndexedDB or Web Locks: nothing was opened. */
  | { status: 'unsupported'; reason: 'storage' };

/** Opens (and leases) the account's stores through `backend` (default: IndexedDB). */
export async function openAccountStores(
  pubkey: string,
  backend?: StorageBackend,
  options?: { leaseTimeoutMs?: number },
): Promise<OpenStoresResult> {
  if (!backend) {
    // Only construction maps `invalid-options` to unsupported: here it means IndexedDB / Web Locks are
    // absent. The same code from openForWrite is a caller error (bad pubkey, bad timeout) and must throw.
    try {
      backend = createIndexedDbStorage();
    } catch (error) {
      if (isMarmotError(error, 'invalid-options')) return { status: 'unsupported', reason: 'storage' };
      throw error;
    }
  }
  try {
    const stores = await backend.openForWrite(pubkey, options);
    return { status: 'opened', stores };
  } catch (error) {
    if (isMarmotError(error, 'lease-held')) return { status: 'lease-held' };
    throw error;
  }
}
