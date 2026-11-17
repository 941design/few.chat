/**
 * historyStore.ts — durable row store behind the app `HistoryBackend`
 * (`few-group-history:<pubkey>`).
 *
 * One idb-keyval object store per account (database `few-group-history:<pubkey>`: a device-wide
 * store would let one account's dispatched rows suppress another's). Two kinds of keys live in it:
 *   - row key     `${groupId}:${eventId}`  -> HistoryRow
 *   - counter key `#seq:${groupId}`        -> number (last `seq` handed out)
 * A group id is hex, so a row key can never start with `#`; rows are told apart
 * from counters by key prefix AND by shape, and a malformed value is skipped,
 * never thrown on (one corrupt row must not poison a whole group's list).
 *
 * Per-group reads (`listRows`, `purgeGroup`) are key-range reads over
 * `${groupId}:` .. `${groupId}:\uffff` through the store's `UseStore` callback
 * (`IDBKeyRange.bound` + `getAll`/`getAllKeys`), never a whole-store scan. The
 * range is exact: the `:` separator makes it the set of keys with that prefix
 * (hex group ids contain no `:`, so group `g` never bleeds into `g2`, whose keys
 * sort before `g:`), and the counter keys start with `#`, outside every range.
 * The row-shape filter (and `entry.groupId` check) stays as a second line.
 *
 * Rules:
 *   - Only get/set/del/delMany/keys/entries/createStore and the UseStore
 *     callback (range reads) are used. idb-keyval
 *     `update()` is banned repo-wide (it is not transaction-bound and may never
 *     settle). Atomicity is not needed from the store: the backend serialises
 *     every operation per group and the account lease keeps one writer.
 *   - The store is created lazily so importing this module (SSR / static
 *     export / node tests) never touches `indexedDB`.
 *   - `seq` is a per-group counter that only ever grows: it is assigned at the
 *     first append, unchanged by re-append, and never reused after a withdraw.
 *     The counter is written before the row, so a crash between the two leaves
 *     a harmless gap, never a duplicate.
 *   - Reads sort by `seq` themselves: real IndexedDB returns key order, which
 *     is unrelated to delivery order.
 *
 * Privacy: local, per-device. Rows hold decrypted group rumors exactly like the
 * chat store does; nothing here is exported to a relay backup.
 */
import { createStore, get, set, del, delMany, entries, keys } from 'idb-keyval';
import type { UseStore } from 'idb-keyval';
import type { HistoryEntry } from '@941design/marmot';

/** Prefix of the per-account database name: `few-group-history:<pubkey>`. */
export const HISTORY_DB_NAME = 'few-group-history';
const OBJECT_STORE_NAME = 'rows';
const COUNTER_PREFIX = '#seq:';

/** One retained message plus the sink's bookkeeping. */
export interface HistoryRow {
  entry: HistoryEntry;
  /** Per-group delivery counter, assigned at first append. */
  seq: number;
  /** True once the app handlers completed for this row. */
  dispatched: boolean;
  /** Failed startup/first-touch recoveries of this row (persisted so a reload does not reset the bound). */
  recoveryFailures?: number;
  /** Set after `MAX_RECOVERY_FAILURES` failed recoveries: never recovered again (still listed, still withdrawable). */
  abandoned?: boolean;
}

export interface HistoryStore {
  getRow(groupId: string, eventId: string): Promise<HistoryRow | undefined>;
  /** Writes (or rewrites) the row under its `(groupId, eventId)` key. */
  putRow(row: HistoryRow): Promise<void>;
  /** Reserves the next `seq` of a group (1, 2, 3, ...). */
  nextSeq(groupId: string): Promise<number>;
  deleteRow(groupId: string, eventId: string): Promise<void>;
  /** The group's rows, `seq` ascending. */
  listRows(groupId: string): Promise<HistoryRow[]>;
  /** Every row of every group, grouped by group id (ascending) then `seq` ascending. */
  listAllRows(): Promise<HistoryRow[]>;
  /** Deletes every row (and the counter) of one group, and nothing of any other group. */
  purgeGroup(groupId: string): Promise<void>;
  /** Deletes every row and counter of every group. */
  clearAll(): Promise<void>;
}

export function rowKey(groupId: string, eventId: string): string {
  return `${groupId}:${eventId}`;
}

function counterKey(groupId: string): string {
  return `${COUNTER_PREFIX}${groupId}`;
}

function isRow(value: unknown): value is HistoryRow {
  const v = value as Partial<HistoryRow> | null | undefined;
  const entry = v?.entry as Partial<HistoryEntry> | undefined;
  return (
    !!v &&
    typeof v.seq === 'number' &&
    Number.isFinite(v.seq) &&
    typeof v.dispatched === 'boolean' &&
    (v.recoveryFailures === undefined || (typeof v.recoveryFailures === 'number' && Number.isFinite(v.recoveryFailures))) &&
    (v.abandoned === undefined || typeof v.abandoned === 'boolean') &&
    !!entry &&
    typeof entry.groupId === 'string' &&
    typeof entry.eventId === 'string' &&
    !!entry.rumor &&
    !!entry.orderingKey
  );
}

function bySeq(a: HistoryRow, b: HistoryRow): number {
  return a.seq - b.seq;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Every row key of one group: `${groupId}:` followed by anything (see the module header). */
function groupRange(groupId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${groupId}:`, `${groupId}:\uffff`);
}

export function createIdbHistoryStore(dbName: string): HistoryStore {
  let store: UseStore | undefined;
  const handle = (): UseStore => (store ??= createStore(dbName, OBJECT_STORE_NAME));

  const rowsOf = async (groupId?: string): Promise<HistoryRow[]> => {
    let values: unknown[];
    if (groupId === undefined) {
      const all = await entries<string, unknown>(handle());
      values = all.filter(([key]) => typeof key === 'string' && !key.startsWith(COUNTER_PREFIX)).map(([, value]) => value);
    } else {
      values = await handle()('readonly', (os) => requestResult<unknown[]>(os.getAll(groupRange(groupId))));
    }
    const rows: HistoryRow[] = [];
    for (const value of values) {
      if (!isRow(value)) continue;
      if (groupId !== undefined && value.entry.groupId !== groupId) continue;
      rows.push(value);
    }
    return rows;
  };

  return {
    async getRow(groupId, eventId) {
      const value = await get<unknown>(rowKey(groupId, eventId), handle());
      return isRow(value) ? value : undefined;
    },

    async putRow(row) {
      await set(rowKey(row.entry.groupId, row.entry.eventId), row, handle());
    },

    async nextSeq(groupId) {
      const current = await get<unknown>(counterKey(groupId), handle());
      const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1;
      await set(counterKey(groupId), next, handle());
      return next;
    },

    async deleteRow(groupId, eventId) {
      await del(rowKey(groupId, eventId), handle());
    },

    async listRows(groupId) {
      return (await rowsOf(groupId)).sort(bySeq);
    },

    async listAllRows() {
      const rows = await rowsOf();
      return rows.sort((a, b) => (a.entry.groupId < b.entry.groupId ? -1 : a.entry.groupId > b.entry.groupId ? 1 : bySeq(a, b)));
    },

    async purgeGroup(groupId) {
      const found = await handle()('readonly', (os) => requestResult<IDBValidKey[]>(os.getAllKeys(groupRange(groupId))));
      const doomed: IDBValidKey[] = found.filter((k) => typeof k === 'string');
      doomed.push(counterKey(groupId));
      await delMany(doomed, handle());
    },

    async clearAll() {
      const all = await keys<string>(handle());
      await delMany(all, handle());
    },
  };
}

const ACCOUNT_PUBKEY = /^[0-9a-f]{64}$/;

/** Throws unless `pubkey` is a 64-char lowercase hex account pubkey (it names the database, so it is validated). */
export function assertAccountPubkey(pubkey: unknown): asserts pubkey is string {
  if (typeof pubkey !== 'string' || !ACCOUNT_PUBKEY.test(pubkey)) {
    throw new TypeError('history: account pubkey must be 64 lowercase hex characters');
  }
}

/** The database of one account: `few-group-history:<pubkey>`. There is no device-global history store. */
export function historyDbName(pubkey: string): string {
  assertAccountPubkey(pubkey);
  return `${HISTORY_DB_NAME}:${pubkey}`;
}

/** The `few-group-history:<pubkey>` store of one account. */
export function createAccountHistoryStore(pubkey: string): HistoryStore {
  return createIdbHistoryStore(historyDbName(pubkey));
}
