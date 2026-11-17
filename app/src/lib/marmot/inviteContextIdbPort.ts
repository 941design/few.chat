/**
 * IndexedDB port of the invite-context holding store (D3): the whole snapshot of one account under key
 * `<accountPubkey>` in the `few-invite-contexts` database, plain idb-keyval `get` / `set` (never `update()`).
 * Opened lazily on first use, never at import. Lives beside the other idb storage modules, not in
 * `invitations/`, which stays free of storage imports; the bootstrap wiring passes it to
 * `createInviteContextStore`.
 */
import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { InviteContextRecord, InviteContextStorePort } from './invitations';

export function createIdbInviteContextPort(accountPubkey: string): InviteContextStorePort {
  if (typeof accountPubkey !== 'string' || accountPubkey.length === 0) throw new TypeError('createIdbInviteContextPort: "accountPubkey" is required');
  let store: UseStore | undefined;
  const key = accountPubkey.toLowerCase();
  const open = (): UseStore => (store ??= createStore('few-invite-contexts', 'contexts'));
  return {
    load: () => get<InviteContextRecord[]>(key, open()),
    save: (records) => set(key, [...records], open()),
  };
}
