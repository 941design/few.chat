import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (!localStorage.getItem('lp_userProfile_v1')) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // Re-seed identity + profile AFTER clearAppState, before reload. The guarded
  // addInitScript above (write only `if (!lp_userProfile_v1)`) races with
  // ProfileContext's hydrate-and-persist: if the first page's ProfileContext
  // effect runs after clearAppState wiped the profile, it persists an
  // empty-nickname default ({nickname:'', avatar:<random>}) that survives the
  // reload guard. The user would then broadcast a blank nickname, so peers
  // render its npub instead of the seeded name (the member-name assertion below
  // would see "npub1…" instead of "Bob").
  await page.evaluate(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function createGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(groupName);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function inviteAndJoin(
  inviterPage: Page,
  inviteeNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteeNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

  // Invitee receives Welcome and joins
  await inviteePage.goto('/groups/');
  // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
  // and wait for the real joined group-card before continuing.
  await acceptInvitationAndWaitJoined(inviteePage, groupName);

  // Wait for profile exchange to complete
  await inviteePage.waitForTimeout(10_000);
}

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Test Suite 1: Live member updates on group detail (no navigation)
// ---------------------------------------------------------------------------

test.describe.serial('Live group detail updates without navigation', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Lazy Member Update';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates group and sees 1 member', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await expect(pgA.getByText('1 member')).toBeVisible({ timeout: 10_000 });
    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);
  });

  test('A invites B — member count updates to 2 without navigation', async () => {
    // A is still on group detail from the previous test
    await dismissErrorOverlay(pgA);
    await inviteContactViaPicker(pgA, USER_B.npub);
    await expect(pgA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // Close the invite modal
    await pgA.keyboard.press('Escape');
    await expect(pgA.getByTestId('invite-member-modal-content')).not.toBeVisible({ timeout: 5_000 });

    // Without navigating, member count should update to 2
    await expect(pgA.getByText('2 members')).toBeVisible({ timeout: 30_000 });
  });

  test('B joins — Bob name appears on A detail without navigation', async () => {
    // B receives Welcome and joins
    await pgB.goto('/groups/');
    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pgB, GROUP_NAME);

    // Wait for B's profile to propagate
    await pgB.waitForTimeout(10_000);

    // A (still on group detail) should see Bob's name appear without navigation
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', { timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Live chat message delivery
// ---------------------------------------------------------------------------

test.describe.serial('Live chat message delivery', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Lazy Chat Test';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('Setup: A creates group, invites B', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  test('B sends message — A sees it live', async () => {
    // A opens group detail (chat visible)
    await openGroupDetail(pgA, GROUP_NAME);
    await expect(pgA.getByTestId('chat-scroll-container')).toBeVisible({ timeout: 10_000 });

    // B opens group detail and sends a message
    await openGroupDetail(pgB, GROUP_NAME);
    await expect(pgB.getByTestId('chat-input')).toBeVisible({ timeout: 10_000 });
    await pgB.getByTestId('chat-input').fill('Hello from Bob!');
    await pgB.getByTestId('chat-send-btn').click();

    // B sees own message (optimistic)
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: 'Hello from Bob!' }),
    ).toBeVisible({ timeout: 10_000 });

    // A sees Bob's message WITHOUT reload
    await expect(
      pgA.locator('[data-testid^="msg-"]').filter({ hasText: 'Hello from Bob!' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('A replies — B sees it live', async () => {
    await pgA.getByTestId('chat-input').fill('Hey Bob, from Alice!');
    await pgA.getByTestId('chat-send-btn').click();

    // A sees own message
    await expect(
      pgA.locator('[data-testid^="msg-"]').filter({ hasText: 'Hey Bob, from Alice!' }),
    ).toBeVisible({ timeout: 10_000 });

    // B sees Alice's reply WITHOUT reload
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: 'Hey Bob, from Alice!' }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
