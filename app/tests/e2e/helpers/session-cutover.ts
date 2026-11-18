import { expect, type Page } from '@playwright/test';

type TestHooks = {
  marmotSession?: { listGroupIds(): Promise<string[] | null> };
  beforeGroupDispatch?: (event: { groupId: string; kind: number; content: string; rumorId: string }) => Promise<void>;
  beforeLiveGroupHistory?: (groupId: string) => Promise<void>;
  releaseLiveGroupHistory?: () => void;
  afterInvitationAccept?: (groupId: string) => Promise<void>;
};

/** Fail loudly if the dev hook is unavailable; do not mistake it for an empty group list. */
export async function waitForLibraryGroupAbsent(page: Page, groupId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (id) => {
    const hooks = (window as unknown as { __fewTest?: TestHooks }).__fewTest;
    if (!hooks?.marmotSession) return 'hook unavailable';
    const ids = await hooks.marmotSession.listGroupIds();
    return ids === null ? 'lease unavailable' : ids.includes(id) ? 'present' : 'absent';
  }, groupId), { timeout: 90_000 }).toBe('absent');
}

/** Pause the real sink after persistence, only for the intended rumor. */
export async function pausePersistedRumor(page: Page, groupId: string, content: string, marker: string, kind?: number): Promise<void> {
  await page.evaluate(({ groupId, content, marker, kind }) => {
    const hooks = (window as unknown as { __fewTest?: TestHooks }).__fewTest;
    if (!hooks?.marmotSession) throw new Error('marmotSession test hook unavailable');
    sessionStorage.removeItem(marker);
    hooks.beforeGroupDispatch = async (event) => {
      if (event.groupId !== groupId || !event.content.includes(content) || (kind !== undefined && event.kind !== kind)) return;
      sessionStorage.setItem(marker, event.rumorId);
      await new Promise<void>(() => {});
    };
  }, { groupId, content, marker, kind });
}

export async function waitForPersistedRumor(page: Page, marker: string): Promise<string> {
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), marker), { timeout: 90_000 }).toBeTruthy();
  const id = await page.evaluate((key) => sessionStorage.getItem(key), marker);
  if (!id) throw new Error('persisted rumor marker disappeared');
  return id;
}

/** Leave startup sweep as the only recovery path for the interrupted row. */
export async function withHistorySweepOnly<T>(page: Page, groupId: string, verify: () => Promise<T>): Promise<T> {
  const hold = 'few:test:hold-live-history';
  await page.addInitScript(({ hold, groupId }) => {
    if (sessionStorage.getItem(hold) !== groupId) return;
    const browser = window as unknown as { __fewTest?: TestHooks };
    const hooks = browser.__fewTest ??= {};
    const released = new Promise<void>((resolve) => { hooks.releaseLiveGroupHistory = resolve; });
    hooks.beforeLiveGroupHistory = async (id) => { if (id === groupId) await released; };
  }, { hold, groupId });
  await page.evaluate(({ hold, groupId }) => sessionStorage.setItem(hold, groupId), { hold, groupId });
  try {
    await page.reload();
    return await verify();
  } finally {
    if (!page.isClosed()) await page.evaluate((hold) => {
      sessionStorage.removeItem(hold);
      (window as unknown as { __fewTest?: TestHooks }).__fewTest?.releaseLiveGroupHistory?.();
    }, hold);
  }
}

export async function pauseAcceptedInvitation(page: Page, groupId: string, marker: string): Promise<void> {
  await page.evaluate(({ groupId, marker }) => {
    const hooks = (window as unknown as { __fewTest?: TestHooks }).__fewTest;
    if (!hooks?.marmotSession) throw new Error('marmotSession test hook unavailable');
    sessionStorage.removeItem(marker);
    const pausedUntilReload = new Promise<void>(() => {});
    hooks.beforeLiveGroupHistory = async (id) => { if (id === groupId) await pausedUntilReload; };
    hooks.afterInvitationAccept = async (id) => {
      if (id !== groupId) return;
      sessionStorage.setItem(marker, id);
      await pausedUntilReload;
    };
  }, { groupId, marker });
}

/** Require exactly one retained, dispatched row for the rumor after reload. */
export async function waitForHistoryDispatch(page: Page, account: string, groupId: string, rumorId: string): Promise<void> {
  await expect.poll(() => page.evaluate(async ({ account, groupId, rumorId }) => {
    const dbName = `few-group-history:${account}`;
    if (!(await indexedDB.databases()).some(({ name }) => name === dbName)) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean[]>((resolve, reject) => {
        const store = db.transaction('rows').objectStore('rows');
        const request = store.getAll(IDBKeyRange.bound(`${groupId}:`, `${groupId}:￿`));
        request.onsuccess = () => resolve(request.result
          .filter((row) => row.entry.rumor?.id === rumorId)
          .map((row) => row.dispatched === true));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, { account, groupId, rumorId }), { timeout: 60_000 }).toEqual([true]);
}
