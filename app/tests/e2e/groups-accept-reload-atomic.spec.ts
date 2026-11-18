/** Interrupt the invitee's accept and the sponsor's dispatch of the join confirmation. */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker } from './helpers/group-setup';
import { pauseAcceptedInvitation, pausePersistedRumor, waitForPersistedRumor, waitForHistoryDispatch, withHistorySweepOnly } from './helpers/session-cutover';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      if (localStorage.getItem('lp_nostrIdentity_v1')) return;
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  const page = await context.newPage();
  return { context, page };
}

test.describe.serial('Reload right after Accept', () => {
  test.setTimeout(240_000);
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('converges on exactly one joined group card and no invitation card', async () => {
    const groupName = `Accept Reload ${Date.now()}`;
    const exactName = bobPage.getByText(groupName, { exact: true });
    const joined = bobPage.locator('[data-testid^="group-card-"]', { has: exactName });
    const invitation = bobPage.locator('[data-testid^="invitation-card-"]', { has: exactName });

    // Bob's welcome subscription live first; drain stale relay gift wraps.
    await bobPage.goto('/groups/');
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    await alicePage.goto('/groups/');
    await createGroup(alicePage, groupName);
    await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 90_000 });
    await dismissErrorOverlay(alicePage);

    const groupId = new URL(alicePage.url()).searchParams.get('id');
    if (!groupId) throw new Error('Group detail route has no id');
    const member = USER_B.pubkeyHex.slice(0, 8);
    const pending = alicePage.getByTestId(`member-pending-${member}`);
    await alicePage.keyboard.press('Escape');
    await expect(pending).toBeVisible();
    await pausePersistedRumor(alicePage, groupId, 'Bob', 'accept-confirmation-persisted', 0);

    await expect(invitation).toBeVisible({ timeout: 90_000 });
    const invitationId = await invitation.getAttribute('data-testid');
    if (!invitationId) throw new Error('Invitation card has no id');
    await pauseAcceptedInvitation(bobPage, groupId, 'accepted-welcome');
    await invitation.locator('[data-testid^="accept-invitation-"]').click();
    expect(await waitForPersistedRumor(bobPage, 'accepted-welcome')).toBe(groupId);
    expect(await bobPage.evaluate(async (id) => {
      const hooks = (window as unknown as { __fewTest?: { marmotSession?: {
        listGroupIds(): Promise<string[] | null>;
      } } }).__fewTest;
      const library = (await hooks?.marmotSession?.listGroupIds())?.includes(id);
      if (!(await indexedDB.databases()).some(({ name }) => name === 'few-groups-meta')) {
        return { library, overlay: false };
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('few-groups-meta');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise<{ id: string }[]>((resolve, reject) => {
          const request = db.transaction('groups').objectStore('groups').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return { library, overlay: rows.some((row) => row.id === id) };
      } finally { db.close(); }
    }, groupId)).toEqual({ library: true, overlay: false });
    // Hold Bob's inbound history across reload so a peer profile request
    // cannot account for the profile that reaches Alice.
    const rumorId = await withHistorySweepOnly(bobPage, groupId, async () => {
      await expect(joined).toHaveCount(1, { timeout: 60_000 });
      await expect(bobPage.getByTestId(invitationId)).toHaveCount(0);
      return waitForPersistedRumor(alicePage, 'accept-confirmation-persisted');
    });
    await expect(pending).toBeVisible();
    await withHistorySweepOnly(alicePage, groupId, () => waitForHistoryDispatch(alicePage, USER_A.pubkeyHex, groupId, rumorId));

    await expect(alicePage.getByTestId(`member-name-${member}`)).toHaveText('Bob', { timeout: 90_000 });
    await expect(alicePage.getByTestId(`member-item-${member}`)).toHaveCount(1);
    await expect(pending).toHaveCount(0);
    // The joined library group remains usable after recovery.
    await joined.click();
    await expect(bobPage.getByTestId('chat-input')).toBeEnabled({ timeout: 60_000 });
    const message = `accept-reload-${Date.now()}`;
    await bobPage.getByTestId('chat-input').fill(message);
    await bobPage.getByTestId('chat-send-btn').click();
    await expect(bobPage.locator('[data-testid^="msg-"]', { hasText: message })).toHaveCount(1);
  });
});
