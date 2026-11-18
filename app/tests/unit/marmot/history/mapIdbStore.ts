/**
 * Map-backed stand-in for an idb-keyval `UseStore` (test helper for the vi.mock('idb-keyval') factories).
 *
 * Returns a function `(mode, callback) => callback(objectStore)` like the real `createStore`, carrying the
 * backing Map as `.map`. Supports key-ordered range reads and stages writes until the callback's
 * queued request handlers have run. `IDBKeyRange` is stubbed when the runtime has none.
 */
type Range = { lower: string; upper: string };

if (typeof (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = { bound: (lower: string, upper: string): Range => ({ lower, upper }) };
}

export interface MapUseStore {
  (mode: string, callback: (os: unknown) => unknown): Promise<unknown>;
  map: Map<string, unknown>;
}

function request<T>(compute: () => T) {
  const req: { result?: T; error: unknown; onsuccess: null | (() => void); onerror: null | (() => void) } = {
    error: null,
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    req.result = compute();
    req.onsuccess?.();
  });
  return req;
}

export function mapUseStore(map: Map<string, unknown>): MapUseStore {
  const inRange = (range: Range) =>
    [...map.keys()].filter((k) => k >= range.lower && k <= range.upper).sort();
  const objectStore = {
    getAll: (range: Range) => request(() => inRange(range).map((k) => structuredClone(map.get(k)))),
    getAllKeys: (range: Range) => request(() => inRange(range)),
  };
  const use = (async (mode: string, callback: (os: unknown) => unknown) => {
    if (mode !== 'readwrite') return callback(objectStore);
    const writes = new Map<string, unknown>();
    let aborted = false;
    const transaction = {
      oncomplete: () => {},
      onabort: () => {},
      abort() { aborted = true; },
    };
    const result = callback({
      transaction,
      get: (key: string) => request(() => aborted ? undefined : structuredClone(map.get(key))),
      put: (value: unknown, key: string) => writes.set(key, structuredClone(value)),
    });
    await Promise.resolve(); // the queued get callbacks stage the writes
    if (aborted) {
      transaction.onabort();
    } else {
      for (const [key, value] of writes) map.set(key, value);
      transaction.oncomplete();
    }
    return result;
  }) as MapUseStore;
  use.map = map;
  return use;
}
