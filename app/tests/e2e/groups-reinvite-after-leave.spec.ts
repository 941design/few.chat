/**
 * E2E: re-invite after leave (bug invite-accept-not-atomic-across-page-unload).
 *
 * Leaving a group purges only the overlay record (few-groups-meta); the MLS
 * state for the group stays in few-groups-state. Before the fix, accepting a
 * later re-invite to the SAME group hit marmot-ts's "Group <hex> already
 * exists" and the invitation was dropped as "no longer valid" — so re-inviting
 * a member who left never worked. Now the accept core detects the orphan MLS
 * state (no overlay), destroys it locally and joins normally.
 *
 * All publishes go through the app (create, invite picker, accept, leave) —
 * no raw WebSocket relay writes.
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import {
  createGroupAndInvite,
  inviteContactViaPicker,
  acceptInvitationAndWaitJoined,
} from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = `Reinvite After Leave ${Date.now()}`;

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
  // Re-seed identity + profile AFTER clearAppState (see e2e profile-seed race).
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

function joinedCards(page: Page, name: string) {
  return page.locator('[data-testid^="group-card-"]', { has: page.getByText(name, { exact: true }) });
}

test.describe.serial('Re-invite after leave', () => {
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

  test('Alice invites Bob; Bob joins', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, GROUP_NAME);
    await expect(joinedCards(bobPage, GROUP_NAME)).toHaveCount(1);
  });

  test('Bob leaves; Alice sees him removed', async () => {
    // Alice watches the group detail while Bob leaves (as groups-leave-intent
    // does), so her client receives the kind-13 leave intent live and
    // auto-commits the removal.
    await alicePage.goto('/groups/');
    await joinedCards(alicePage, GROUP_NAME).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId(`member-item-${USER_B.pubkeyHex.slice(0, 8)}`)).toBeVisible({
      timeout: 60_000,
    });

    await bobPage.goto('/groups/');
    await joinedCards(bobPage, GROUP_NAME).click();
    await expect(bobPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(bobPage);
    await bobPage.getByTestId('leave-group-btn').click();
    await expect(bobPage.getByTestId('leave-group-confirm-btn')).toBeVisible({ timeout: 10_000 });
    await bobPage.getByTestId('leave-group-confirm-btn').click();
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
    await expect(joinedCards(bobPage, GROUP_NAME)).toHaveCount(0, { timeout: 30_000 });

    // Alice's client auto-removes Bob on his kind-13 leave intent.
    await expect(alicePage.getByTestId(`member-item-${USER_B.pubkeyHex.slice(0, 8)}`)).toHaveCount(0, {
      timeout: 90_000,
    });
  });

  test('Alice re-invites Bob; Bob accepts and rejoins the same group', async () => {
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 90_000 });
    await dismissErrorOverlay(alicePage);

    await bobPage.goto('/groups/');
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    // Before the fix this failed: the accept hit "Group <hex> already exists"
    // and the invitation vanished with "This invitation is no longer valid".
    await acceptInvitationAndWaitJoined(bobPage, GROUP_NAME);
    await expect(joinedCards(bobPage, GROUP_NAME)).toHaveCount(1);
    await expect(bobPage.locator('[data-testid^="invitation-card-"]')).toHaveCount(0);

    // Rejoined for real: the group opens and lists both members.
    await joinedCards(bobPage, GROUP_NAME).click();
    await expect(bobPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId(`member-item-${USER_A.pubkeyHex.slice(0, 8)}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});
