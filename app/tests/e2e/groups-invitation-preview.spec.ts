/**
 * E2E: Invitation preview flow (AC-TEST-3, epic: inline-invitation-cards S3)
 *
 * Alice (USER_A) creates a group and invites Bob (USER_B) by npub. Bob taps the
 * inline invitation card, which navigates to the read-only preview route
 * (/groups?invite=<id>). The preview shows the pre-join-decoded group name, the
 * "Invited by" attribution, and the group admin(s). Bob can Accept or Decline
 * from the preview.
 *
 * Note on description (AC-PREVIEW-1): the preview shows the group description
 * "when present", but the app's create-group flow takes a name only
 * (createGroup(name)), so an app-created test group has no description. Since
 * the publish-through-app rule forbids injecting a described group by hand, the
 * description branch is covered by the unit-level conditional render
 * (invitation-preview-description), not asserted here. Name, admin, and
 * "Invited by" — the always-present fields — are asserted below.
 *
 * No raw WebSocket relay writes — the invite goes through the app's picker.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_ACCEPT = 'Preview Accept Group';
const GROUP_DECLINE = 'Preview Decline Group';

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

async function aliceCreatesGroupAndInvites(alicePage: Page, groupName: string): Promise<void> {
  // Ensure Alice is on the groups LIST view — a prior invocation leaves her on
  // the group detail page (the invite flow navigates into the group), where
  // create-group-btn does not exist.
  await alicePage.goto('/groups/');
  await createGroup(alicePage, groupName);
  await alicePage.waitForTimeout(3_000);

  await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
  await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  await inviteContactViaPicker(alicePage, USER_B.npub);
  await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await alicePage.waitForTimeout(3_000);
}

test.describe.serial('Invitation preview (AC-TEST-3)', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
    // Warm up Bob's Walled-Garden seen-set, then clear the queue so only the
    // freshly-created invitations are present.
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => localStorage.removeItem('lp_pendingInvitations_v1'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Bob taps the invitation card, previews group details, and Accepts', async () => {
    await aliceCreatesGroupAndInvites(alicePage, GROUP_ACCEPT);

    // Bob waits for the Welcome to arrive over the relay, then opens the list.
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_ACCEPT }).last();
    await expect(invitationCard).toBeVisible({ timeout: 30_000 });

    // AC-CARD-4 / AC-PREVIEW-1: tapping the card body opens the read-only
    // preview route. Click the group name (card body, not the Accept/Decline
    // buttons which are elevated above the link overlay).
    await invitationCard.getByText(GROUP_ACCEPT).click();
    await expect(bobPage).toHaveURL(/invite=/, { timeout: 15_000 });

    // AC-PREVIEW-1: the preview shows the group name, "Invited by" attribution,
    // and the group admin(s). (Description omitted — app-created groups have
    // none; see file header.)
    const preview = bobPage.getByTestId('invitation-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId('invitation-preview-name')).toHaveText(GROUP_ACCEPT);
    await expect(bobPage.getByTestId('invitation-preview-invited-by')).toContainText('Invited by');
    await expect(bobPage.getByTestId('invitation-preview-admins')).toBeVisible();

    // AC-PREVIEW-2: Accept from the preview joins the group and returns Bob to
    // the list, where the group now appears as a joined group-card.
    await bobPage.getByTestId('invitation-preview-accept').click();
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_ACCEPT }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(bobPage.getByTestId('invitation-preview')).toHaveCount(0);
  });

  test('Bob previews another invitation and Declines from the preview', async () => {
    await aliceCreatesGroupAndInvites(alicePage, GROUP_DECLINE);

    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_DECLINE }).last();
    await expect(invitationCard).toBeVisible({ timeout: 90_000 });

    await invitationCard.getByText(GROUP_DECLINE).click();
    await expect(bobPage).toHaveURL(/invite=/, { timeout: 15_000 });
    await expect(bobPage.getByTestId('invitation-preview')).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId('invitation-preview-name')).toHaveText(GROUP_DECLINE);

    // AC-PREVIEW-2: Decline from the preview discards the invitation and returns
    // Bob to the list; the group is never joined.
    await bobPage.getByTestId('invitation-preview-decline').click();
    await expect(bobPage.getByTestId('invitation-preview')).toHaveCount(0, { timeout: 15_000 });
    await expect(
      bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_DECLINE }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_DECLINE }),
    ).toHaveCount(0);
  });
});
