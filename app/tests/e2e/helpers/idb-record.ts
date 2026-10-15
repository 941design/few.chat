import type { Page } from '@playwright/test';

/**
 * Delete a single keyed record from a named IndexedDB store.
 *
 * Works for any idb-keyval or raw IndexedDB store. Leaves all other records intact.
 *
 * FIXTURE-07-002 — permanent test infrastructure.
 */
export async function deleteIdbRecord(
  page: Page,
  dbName: string,
  storeName: string,
  key: string,
): Promise<void> {
  await page.evaluate(
    ({ dbName: db, storeName: store, key: k }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(db);
        // Every target DB is an idb-keyval createStore(db, store) store, created
        // only in the upgrade that creates the DB. If this helper opens first, the
        // open creates the DB here: create the store in that same upgrade so the
        // result is identical whoever opens first (otherwise an empty v1 DB breaks
        // the app's store too — "object store missing").
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => {
          const database = req.result;
          let tx: IDBTransaction;
          try {
            tx = database.transaction(store, 'readwrite');
          } catch {
            // Store may not exist if database was never written to
            database.close();
            resolve();
            return;
          }
          const objStore = tx.objectStore(store);
          const del = objStore.delete(k);
          del.onsuccess = () => { database.close(); resolve(); };
          del.onerror = () => { database.close(); reject(del.error); };
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // resolve if blocked to avoid hanging
      }),
    { dbName, storeName, key },
  );
}

/**
 * Read a single record from a named IndexedDB store.
 * Returns null if the record is absent.
 */
export async function readIdbRecord<T = unknown>(
  page: Page,
  dbName: string,
  storeName: string,
  key: string,
): Promise<T | null> {
  return page.evaluate(
    ({ dbName: db, storeName: store, key: k }) =>
      new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open(db);
        // Every target DB is an idb-keyval createStore(db, store) store, created
        // only in the upgrade that creates the DB. If this helper opens first, the
        // open creates the DB here: create the store in that same upgrade so the
        // result is identical whoever opens first (otherwise an empty v1 DB breaks
        // the app's store too — "object store missing").
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => {
          const database = req.result;
          let tx: IDBTransaction;
          try {
            tx = database.transaction(store, 'readonly');
          } catch {
            database.close();
            resolve(null);
            return;
          }
          const objStore = tx.objectStore(store);
          const get = objStore.get(k);
          get.onsuccess = () => { database.close(); resolve(get.result ?? null); };
          get.onerror = () => { database.close(); reject(get.error); };
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => { try { req.result?.close(); } catch {} resolve(null); };
      }),
    { dbName, storeName, key },
  ) as Promise<T | null>;
}

/**
 * Seed a DUE-NOW entry directly into the `few-dm-profile-schedule` idb-keyval
 * store (`app/src/lib/dmProfile/scheduler.ts`'s `few-dm-profile-schedule`/
 * `schedules` store) so a relay-bucket e2e spec can drive the direct-contact
 * profile self-heal loop (AC-PROF-7) without waiting out the real 1h+ backoff
 * floor.
 *
 * Mirrors `helpers/pairing.ts#seedPendingIntent`: this tampers LOCAL state
 * only (the app's own real `ProfileHealWatcher` mount-triggered due-sweep
 * then reads this record and, if due, genuinely constructs, signs, and
 * gift-wrap-publishes a real `profile-request` via `send.ts#sendProfileRequest`
 * — no event is ever forged or hand-published here).
 *
 * Epic: direct-contact-profile-exchange, story S08 (AC-E2E-1, FIXTURE-08-001).
 *
 * Deliberately test-only: this is a Playwright helper, not a
 * `NEXT_PUBLIC_*` build-time override — spec.md's "Resolved Decisions"
 * rejects a build-time backoff-floor constant as a test-only timing knob
 * that could leak into the production bundle. Accepts exactly the four
 * fields AC-E2E-1 specifies; the two additional `ProfileSchedule` fields
 * (`firstAttemptAt`, `lastResetAt`) are filled with schedule-store-shape-
 * compatible defaults recent enough to sit well inside the 30-day give-up
 * ceiling and to never trip the once-per-24h reset rate limit.
 */
export async function seedDueProfileSchedule(
  page: Page,
  schedule: {
    pubkeyHex: string;
    nextAttemptAt: number;
    attempts: number;
    state: 'active' | 'answered-incomplete' | 'given-up';
  },
): Promise<void> {
  const key = schedule.pubkeyHex.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  await writeIdbRecord(page, 'few-dm-profile-schedule', 'schedules', key, {
    pubkeyHex: key,
    attempts: schedule.attempts,
    nextAttemptAt: schedule.nextAttemptAt,
    state: schedule.state,
    firstAttemptAt: nowSec,
    lastResetAt: null,
  });
}

/**
 * Write a single record to a named IndexedDB store.
 */
export async function writeIdbRecord(
  page: Page,
  dbName: string,
  storeName: string,
  key: string,
  value: unknown,
): Promise<void> {
  await page.evaluate(
    ({ dbName: db, storeName: store, key: k, value: v }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(db);
        // Every target DB is an idb-keyval createStore(db, store) store, created
        // only in the upgrade that creates the DB. If this helper opens first, the
        // open creates the DB here: create the store in that same upgrade so the
        // result is identical whoever opens first (otherwise an empty v1 DB breaks
        // the app's store too — "object store missing").
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => {
          const database = req.result;
          let tx: IDBTransaction;
          try {
            tx = database.transaction(store, 'readwrite');
          } catch {
            database.close();
            reject(new Error('object store missing'));
            return;
          }
          const objStore = tx.objectStore(store);
          const put = objStore.put(v, k);
          put.onsuccess = () => { database.close(); resolve(); };
          put.onerror = () => { database.close(); reject(put.error); };
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      }),
    { dbName, storeName, key, value },
  );
}
