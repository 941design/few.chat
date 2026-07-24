/**
 * E2E: Pull-only invitation decline flow (AC-TEST-2, epic: inline-invitation-cards S2)
 *
 * Alice (USER_A) creates a group and invites Bob (USER_B) by npub.
 * Bob sees an INLINE invitation card on /groups/ (invitation-card-<id>, showing
 * the group name + invitation badge + "Invited by" attribution) and clicks
 * Decline.
 * After declining:
 *   a. The invitation card is removed from the UI IMMEDIATELY — no confirmation
 *      dialog.
 *   b. Bob's groups list does NOT include the group; the group name is no
 *      longer visible anywhere on the page.
 *   c. After Alice publishes a DM via publishDirectMessage, Bob's bell stays at 0.
 *      (Alice is a stranger to Bob post-decline — she never became a known peer.)
 *
 * No raw WebSocket relay writes — all publishes go through the app's bridges.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Pull-Only Decline Test Group';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

test.describe.serial('Pull-only invitation: Decline (AC-TEST-2)', () => {
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

  test('Alice creates a group and invites Bob', async () => {
    // Walled Garden v2: warm up Bob's seen-set with stale wraps from prior
    // tests, then clear the queue so the fresh invite is the entry to handle.
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => {
      localStorage.removeItem('lp_pendingInvitations_v1');
    });

    await alicePage.getByTestId('create-group-btn').click();
    await expect(alicePage.getByTestId('create-group-modal-content')).toBeVisible();
    await alicePage.getByTestId('create-group-name-input').fill(GROUP_NAME);
    await alicePage.getByTestId('create-group-submit-btn').click();
    await expect(alicePage.getByText(GROUP_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(alicePage);
    await alicePage.waitForTimeout(3_000);

    await alicePage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await alicePage.waitForTimeout(3_000);
  });

  test('Bob sees the inline invitation card and clicks Decline', async () => {
    // Wait for the Welcome to arrive over the relay
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');

    // AC-TEST-2 / AC-CARD-1: Bob sees the inline invitation card showing the
    // real group name, an invitation badge, and "Invited by" attribution.
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]').last();
    await expect(invitationCard).toBeVisible({ timeout: 30_000 });
    await expect(invitationCard.getByText(GROUP_NAME)).toBeVisible();
    await expect(invitationCard.getByText('Invitation')).toBeVisible();
    await expect(invitationCard.getByText(/Invited by/)).toBeVisible();

    // AC-TEST-2 / AC-CARD-6: Bob clicks Decline on the most recent (fresh)
    // invitation — immediate, no confirmation dialog.
    await bobPage.locator('[data-testid^="decline-invitation-"]').last().click();

    // AC-TEST-2 / AC-CARD-6: the fresh invitation card must disappear
    // immediately (the warm-up at the start of the previous test cleared any
    // stale entries so only one remained).
    await expect(bobPage.locator('[data-testid^="invitation-card-"]')).toHaveCount(0, { timeout: 10_000 });

    // AC-TEST-2 / AC-CARD-6: the group is never joined — no group-card appears,
    // and the group name is no longer visible anywhere on the page.
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }),
    ).toHaveCount(0);
    await expect(bobPage.getByText(GROUP_NAME)).toHaveCount(0);
  });

  test('Alice DMs Bob after decline; Bob Contacts pill stays at 0', async () => {
    // Bob navigates to /contacts so the unread watcher and DM bridge mount
    // (a DM is a Contacts-domain event, surfacing on `contacts-nav-badge`)
    await bobPage.goto('/contacts');
    await bobPage.waitForLoadState('networkidle');
    await bobPage.waitForFunction(
      () => !!(window as any).__fewUnread,
      null,
      { timeout: 15_000 },
    );

    // Record baseline Contacts pill count (should be 0 after a fresh clearAppState boot)
    const baselineBadge = await bobPage.evaluate(() => {
      const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
      if (!badge) return 0;
      return parseInt((badge.textContent ?? '0').trim(), 10);
    });

    // Alice sends a DM to Bob via the app bridge
    const DM_CONTENT = `decline-test-dm-${Date.now()}`;
    await alicePage.waitForFunction(
      () => typeof (window as any).__fewPublishDm === 'function',
      null,
      { timeout: 15_000 },
    );
    await alicePage.evaluate(
      async ({ bobPub, content }) => {
        await (window as any).__fewPublishDm(bobPub, content);
      },
      { bobPub: USER_B.pubkeyHex, content: DM_CONTENT },
    );

    // Wait 15 s for any potential relay delivery and gate processing
    await bobPage.waitForTimeout(15_000);

    // Regression coverage (kept from the pre-S2 spec): Bob's Contacts pill count
    // must remain at the baseline (Alice is a stranger — she never became a known peer)
    const afterBadge = await bobPage.evaluate(() => {
      const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
      if (!badge) return 0;
      return parseInt((badge.textContent ?? '0').trim(), 10);
    });
    expect(afterBadge).toBe(baselineBadge);
  });
});
