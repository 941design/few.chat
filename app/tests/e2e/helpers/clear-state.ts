import type { Page } from '@playwright/test';

/**
 * Clear all app state: remove lp_* localStorage keys and delete all IndexedDB databases.
 * IndexedDB deletions are properly awaited to prevent stale data on page reload.
 */
export async function clearAppState(page: Page): Promise<void> {
  // Skip if the page hasn't been navigated yet — about:blank denies access
  // to localStorage and indexedDB, which would otherwise throw a SecurityError
  // and mask the real test failure that prevented navigation.
  if (page.url() === 'about:blank') return;
  await page.evaluate(async () => {
    // Clear lp_* localStorage keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('lp_')) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    const databases = await indexedDB.databases();
    const dbNames = databases.flatMap(({ name }) => name ? [name] : []);
    // Delete each database on this isolated test origin.
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
  });
}
