// E2E: bug stale-welcome-reinvite.
//
// An evicted member keeps their overlay + MLS state (no self-eviction
// detection). When the admin re-invites them and they accept, the new Welcome
// must REPLACE that dead local state instead of being swallowed as "already
// joined" (which left the member stuck on a group they could not chat in).
//
// A creates a group and invites C; C joins; A removes C; A re-invites C;
// C accepts via the real UI; A and C then exchange group messages both ways.
// Every publish goes through the app (never a raw WebSocket to the relay).
//
// "No reload" discipline: cross-client assertions use plain retrying
// toBeVisible on the live-updating UI — never reload()+isVisible() polling.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Reinvite After Removal E2E Group';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(name);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
  await page.waitForTimeout(3_000);
}

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function inviteMember(page: Page, npub: string): Promise<void> {
  await inviteContactViaPicker(page, npub);
  await expect(page.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(3_000);
}

async function acceptInvitation(
  page: Page,
  groupName: string,
  opts: { replacesStaleGroup?: boolean } = {},
): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await acceptInvitationAndWaitJoined(page, groupName, opts);
}

async function removeMemberViaUI(adminPage: Page, targetPubkeyHex: string): Promise<void> {
  const shortPk = targetPubkeyHex.slice(0, 8);
  await adminPage.getByTestId(`remove-member-${shortPk}`).click();
  await expect(adminPage.getByTestId(`remove-member-confirm-${shortPk}`)).toBeVisible({ timeout: 10_000 });
  await adminPage.getByTestId(`remove-member-confirm-${shortPk}`).click();
  await expect(adminPage.getByTestId(`remove-member-confirm-${shortPk}`)).not.toBeVisible({ timeout: 30_000 });
}

/** Send a text message through the real composer; waits for the local bubble. */
async function sendMessage(page: Page, content: string): Promise<void> {
  await page.getByTestId('chat-input').fill(content);
  await page.getByTestId('chat-send-btn').click();
  await expect(page.locator('[data-testid^="msg-"]').filter({ hasText: content }).first())
    .toBeVisible({ timeout: 15_000 });
}

test.describe.serial('Re-invite after removal — the evicted member adopts the new Welcome', () => {
  let ctxA: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageC: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C, 'Carol'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxC?.close();
  });

  test('A creates the group, invites C; C joins as a confirmed member', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_C.npub);
    await acceptInvitation(pageC, GROUP_NAME);

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).not.toBeVisible({ timeout: 90_000 });
  });

  test('A removes C, then re-invites C', async () => {
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await openGroupDetail(pageA, GROUP_NAME);
    await removeMemberViaUI(pageA, USER_C.pubkeyHex);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 15_000 });

    await inviteMember(pageA, USER_C.npub);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
  });

  test('C accepts the re-invite and joins with a working group', async () => {
    // C still holds the group from before the removal: the new invitation is
    // listed next to the (stale) joined card, and accepting must replace the
    // dead local state with the fresh Welcome.
    await acceptInvitation(pageC, GROUP_NAME, { replacesStaleGroup: true });
    await openGroupDetail(pageC, GROUP_NAME);
    await expect(pageC.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).not.toBeVisible({ timeout: 90_000 });
  });

  test('A and C exchange messages in both directions', async () => {
    const fromA = `a-to-c-${Date.now()}`;
    const fromC = `c-to-a-${Date.now()}`;

    await openGroupDetail(pageA, GROUP_NAME);
    await sendMessage(pageA, fromA);
    await expect(pageC.locator('[data-testid^="msg-"]').filter({ hasText: fromA }).first())
      .toBeVisible({ timeout: 60_000 });

    await sendMessage(pageC, fromC);
    await expect(pageA.locator('[data-testid^="msg-"]').filter({ hasText: fromC }).first())
      .toBeVisible({ timeout: 60_000 });
  });
});
