/**
 * A Map-backed idb-keyval store that is ALSO a working custom-store callback
 * (`UseStore`), for suites that mock idb-keyval with Maps but exercise code
 * running its own readwrite transaction through the store callback
 * (rumorJournal.putRumor / recordRumorFailure).
 *
 * The returned object behaves as the Map for the suite's mocked get/set/…
 * (method calls are bound to the Map; `instanceof Map` holds) and, when
 * called as `store(mode, callback)`, hands the callback an event-driven
 * IDBObjectStore-like object over the Map: get/put requests complete on a
 * later macrotask, writes are buffered and applied only when the transaction
 * commits (no pending request left), and `transaction.abort()` discards them.
 * `onCommit` runs before the buffered writes are applied (e.g. to log them).
 */
import type { UseStore } from 'idb-keyval';

type Req = { result: unknown; error: unknown; onsuccess: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null };

export function callableMapStore(
  map: Map<string, unknown>,
  opts: { onCommit?: (keys: string[]) => void | Promise<void> } = {},
): Map<string, unknown> & UseStore {
  const run = <T>(_mode: IDBTransactionMode, callback: (store: IDBObjectStore) => T | PromiseLike<T>): Promise<T> => {
    const pending = new Set<Req>();
    const writes: Array<[string, unknown]> = [];
    let done = false;
    const txn = {
      error: null as unknown,
      oncomplete: null as ((e: unknown) => void) | null,
      onabort: null as ((e: unknown) => void) | null,
      onerror: null as ((e: unknown) => void) | null,
      abort() {
        if (done) return;
        done = true;
        setTimeout(() => txn.onabort?.({}), 0);
      },
    };
    const commitIfIdle = async () => {
      if (done || pending.size > 0) return;
      done = true;
      await opts.onCommit?.(writes.map(([k]) => k));
      for (const [k, v] of writes) map.set(k, v);
      txn.oncomplete?.({});
    };
    const request = (compute: () => unknown): Req => {
      if (done) throw new Error('TransactionInactiveError');
      const req: Req = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending.add(req);
      setTimeout(() => {
        pending.delete(req);
        if (done) return;
        req.result = compute();
        try {
          req.onsuccess?.({ target: req });
        } catch (err) {
          txn.error = err;
          txn.abort();
          return;
        }
        void commitIfIdle();
      }, 0);
      return req;
    };
    const os = {
      transaction: txn,
      get: (key: string) => request(() => {
        const buffered = [...writes].reverse().find(([k]) => k === key);
        return buffered ? buffered[1] : map.get(key);
      }),
      put: (value: unknown, key: string) => {
        const req = request(() => key);
        writes.push([key, value]);
        return req;
      },
    };
    const result = callback(os as unknown as IDBObjectStore);
    setTimeout(() => void commitIfIdle(), 0);
    return Promise.resolve(result);
  };
  return new Proxy(run, {
    get: (_t, prop) => {
      const v = Reflect.get(map, prop, map);
      return typeof v === 'function' ? v.bind(map) : v;
    },
    getPrototypeOf: () => Map.prototype,
  }) as unknown as Map<string, unknown> & UseStore;
}
