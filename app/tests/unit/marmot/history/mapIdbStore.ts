/**
 * Map-backed stand-in for an idb-keyval `UseStore` (test helper for the vi.mock('idb-keyval') factories).
 *
 * Returns a function `(mode, callback) => callback(objectStore)` like the real `createStore`, carrying the
 * backing Map as `.map`. The fake object store implements the two range reads the history store uses
 * (`getAll` / `getAllKeys` over an `IDBKeyRange.bound`), in KEY order like real IndexedDB; every other mock
 * function reads/writes `store.map` directly. `IDBKeyRange` is stubbed when the runtime has none.
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
  const use = (async (_mode: string, callback: (os: unknown) => unknown) => callback(objectStore)) as MapUseStore;
  use.map = map;
  return use;
}
