import type { Page } from '@playwright/test';

const INDEXEDDB_DATABASES = [
  'few-groups-meta',
  'few-groups-state',
  'few-keypackages',
  'few-member-scores',
  'few-member-profiles',
  'few-invite-links',
  'few-join-requests',
  // epic: group-invite-link-onboarding, S4 -- outbound join-request records
  // (outboundJoinRequests.ts). Omitted here previously; a mid-test
  // clearAppState() call on a context that had already sent a join request
  // would leave a stale record behind, able to auto-correlate a LATER,
  // unrelated Welcome.
  'few-outbound-join-requests',
  'few-media-blobs',
  'few-media-meta',
  // Left-group tombstones (leftGroupTombstones.ts) and the write-ahead rumor
  // journal (rumorJournal.ts): per-account local group state.
  'few-left-groups',
  'few-rumor-journal',
  'keyval-store', // DM message storage
];

/**
 * Clear all app state: remove lp_* localStorage keys and delete all IndexedDB databases.
 * IndexedDB deletions are properly awaited to prevent stale data on page reload.
 */
export async function clearAppState(page: Page): Promise<void> {
  // Skip if the page hasn't been navigated yet — about:blank denies access
  // to localStorage and indexedDB, which would otherwise throw a SecurityError
  // and mask the real test failure that prevented navigation.
  if (page.url() === 'about:blank') return;
  await page.evaluate(async (dbNames) => {
    // Clear lp_* localStorage keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('lp_')) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    // Delete IndexedDB databases — await each deletion
    await Promise.all(
      dbNames.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve(); // resolve even on error to not block
            req.onblocked = () => resolve(); // resolve even if blocked
          }),
      ),
    );
  }, INDEXEDDB_DATABASES);
}
