import { createStore, del, get, set } from 'idb-keyval';
import type { WipeCheckpoint } from './client/wipe';

const store = createStore('few-group-wipe-checkpoints', 'intents');

/** Account-scoped app cleanup intent, separate from the library's wiped stores. */
export const groupSessionWipeCheckpoint: WipeCheckpoint = {
  read: (pubkey) => get(pubkey, store),
  write: (pubkey, previousMarker) => set(pubkey, { previousMarker }, store),
  clear: (pubkey) => del(pubkey, store),
};

// A settings wipe is an intent to finish the entire operation, even after a crash.
const applicationKey = (pubkey: string) => `application:${pubkey}`;

export async function resumeApplicationWipe(
  stores: import('@941design/marmot/storage').WritableStores,
  clear: (pubkey: string) => Promise<void>,
): Promise<void> {
  const pubkey = stores.account.account;
  if (!await get(applicationKey(pubkey), store)) return;
  if (!stores.lease.held) throw new Error('Cannot wipe without the account lease');
  await stores.account.wipe({ reason: 'application' });
  if (!stores.lease.held) throw new Error('Account lease lost during wipe');
  await clear(pubkey);
  if (!stores.lease.held) throw new Error('Account lease lost during wipe cleanup');
  await del(applicationKey(pubkey), store);
}

export async function wipeApplicationGroups(
  stores: import('@941design/marmot/storage').WritableStores,
  clear: (pubkey: string) => Promise<void>,
): Promise<void> {
  if (!stores.lease.held) throw new Error('Cannot wipe without the account lease');
  await set(applicationKey(stores.account.account), true, store);
  await resumeApplicationWipe(stores, clear);
}
