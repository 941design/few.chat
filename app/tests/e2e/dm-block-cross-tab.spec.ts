/**
 * E2E: a block made in one tab reaches the user's other open tabs without a
 * reload (multi-tab design S0 — cross-tab change notifications; bug
 * cross-tab-change-notifications, VQ-1).
 *
 * Alice opens TWO pages in the SAME browser context, so both share one
 * origin's localStorage + IndexedDB exactly like two tabs of one browser.
 * Tab 2 has Bob's direct-message thread open (ContactChat mounted). Alice
 * blocks Bob in tab 1; tab 2 must leave the thread (the blocked contact's
 * detail page redirects to the list, so nothing can be sent to or shown from
 * Bob there) and hide Bob from its list — without tab 2 ever reloading.
 * Unblocking in tab 1 must likewise bring Bob back in tab 2's list. A direct
 * message sent from tab 1 must also appear in another tab's open thread.
 *
 * Bob (USER_C, aliased USER_B per the reserved-maintainer convention) is
 * only needed to make Alice and Bob contacts via a shared group; every
 * publish goes through the app (createGroupAndInvite).
 *
 * Requires the relay bucket (groups/dm). Run via
 *   E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-block-cross-tab.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

const USER_B = USER_C;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUserOnGroups(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

test.describe.serial('Block reaches the other open tabs without a reload', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let aliceTab1: Page;
  let aliceTab2: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: aliceTab1 } = await bootUserOnGroups(browser, USER_A, 'alice-cross-tab'));
    ({ context: bobCtx, page: bobPage } = await bootUserOnGroups(browser, USER_B, 'bob-cross-tab'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('setup: Alice and Bob share a group; tab 2 has Bob\'s thread open', async () => {
    await createGroupAndInvite(aliceTab1, USER_B.npub, bobPage, 'Cross-tab Block Group');

    aliceTab2 = await aliceCtx.newPage();
    await aliceTab2.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await dismissErrorOverlay(aliceTab2);
    await expect(aliceTab2.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
  });

  test('a message sent in tab 1 appears in another tab\'s open thread without a reload', async () => {
    // Tab 3's relay connection is replaced by a silent mock, so the ONLY way
    // the message can reach it is the cross-tab change signal + its re-read of
    // shared storage — not its own relay subscription.
    const tab3 = await aliceCtx.newPage();
    await tab3.routeWebSocket(/:7777/, () => {});
    let tab3Loads = 0;
    await tab3.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await dismissErrorOverlay(tab3);
    await expect(tab3.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
    tab3.on('load', () => { tab3Loads++; });

    await aliceTab1.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await dismissErrorOverlay(aliceTab1);
    await expect(aliceTab1.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
    const text = `cross-tab-dm-${Date.now()}`;
    await aliceTab1.getByTestId('chat-input').fill(text);
    await aliceTab1.getByTestId('chat-send-btn').click();
    await expect(aliceTab1.locator('[data-testid^="msg-"]').filter({ hasText: text })).toBeVisible({ timeout: 15_000 });

    await expect(tab3.locator('[data-testid^="msg-"]').filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
    expect(tab3Loads).toBe(0);
    await tab3.close();
  });

  test('blocking in tab 1 closes the thread and hides the contact in tab 2, without reloading tab 2', async () => {
    // A reload or navigation by the test would mask the bug — record any.
    let tab2Loads = 0;
    aliceTab2.on('load', () => { tab2Loads++; });

    await aliceTab1.goto(`/profile?pubkey=${USER_B.pubkeyHex}`);
    await expect(aliceTab1.getByTestId('profile-archive')).toBeVisible({ timeout: 30_000 });
    await aliceTab1.getByTestId('profile-archive').click();
    await expect(aliceTab1.getByTestId('block-confirm-modal')).toBeVisible({ timeout: 10_000 });
    await aliceTab1.getByTestId('block-confirm-btn').click();
    await expect(aliceTab1.getByTestId('block-confirm-modal')).not.toBeVisible({ timeout: 15_000 });

    // Tab 2 leaves the blocked contact's thread on its own: the composer is
    // gone and it is back on the list, where Bob is hidden.
    await expect(aliceTab2.getByTestId('chat-input')).toHaveCount(0, { timeout: 15_000 });
    await aliceTab2.waitForURL((url) => !url.searchParams.has('id'), { timeout: 15_000 });
    await expect(aliceTab2.getByTestId('contacts-page')).toBeVisible();
    await expect(aliceTab2.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toHaveCount(0);

    expect(tab2Loads).toBe(0);
  });

  test('unblocking in tab 1 brings the contact back in tab 2, without reloading tab 2', async () => {
    let tab2Loads = 0;
    aliceTab2.on('load', () => { tab2Loads++; });

    await aliceTab1.getByTestId('profile-archive').click();
    await expect(aliceTab1.getByTestId('block-confirm-modal')).not.toBeVisible();

    await expect(aliceTab2.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });

    expect(tab2Loads).toBe(0);
  });
});
