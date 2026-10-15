/**
 * E2E: reload immediately after clicking Accept (bug
 * invite-accept-not-atomic-across-page-unload).
 *
 * The accept writes MLS state, then the overlay record, then dequeues the
 * invitation. This spec reloads right after the Accept click and asserts the
 * user converges on exactly one joined group card and no invitation card
 * (re-accepting if the invitation is still there, which must then succeed).
 *
 * Limits: a reload's cut point is not controllable from the browser, so this
 * spec cannot guarantee that any particular branch (cut before the overlay
 * write -> orphan MLS state destroyed on re-accept; cut after it -> startup
 * reconciliation drops the stale invitation) was hit in a given run, even
 * with --repeat-each. Each branch is covered deterministically by
 * tests/unit/marmot/inviteAcceptIdempotentJoin.test.ts; this spec is the
 * end-to-end smoke check that the real app converges.
 *
 * All publishes go through the app — no raw WebSocket relay writes.
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
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
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => localStorage.removeItem('lp_pendingInvitations_v1'));

    await alicePage.goto('/groups/');
    await createGroup(alicePage, groupName);
    await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 90_000 });
    await dismissErrorOverlay(alicePage);

    await expect(invitation).toBeVisible({ timeout: 90_000 });
    await invitation.locator('[data-testid^="accept-invitation-"]').click();
    // Cut the accept wherever it happens to be.
    await bobPage.reload();

    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(joined.or(invitation).first()).toBeVisible({ timeout: 60_000 });
    // Let startup reconciliation settle before deciding which cut we hit.
    await bobPage.waitForTimeout(3_000);

    if ((await joined.count()) === 0) {
      // Cut before the overlay write: the invitation must still be acceptable.
      await acceptInvitationAndWaitJoined(bobPage, groupName);
    }

    await expect(joined).toHaveCount(1, { timeout: 60_000 });
    await expect(invitation).toHaveCount(0, { timeout: 30_000 });
    // And it stays that way across another reload.
    await bobPage.reload();
    await expect(joined).toHaveCount(1, { timeout: 60_000 });
    await expect(invitation).toHaveCount(0);
  });
});
