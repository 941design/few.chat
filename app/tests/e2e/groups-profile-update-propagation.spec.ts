import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user with identity AND profile nickname pre-set in localStorage. */
async function bootUserWithProfile(
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

/** Create a group, open its detail, and return the group name for later lookup. */
async function createGroupAndOpen(page: Page, groupName: string): Promise<void> {
  // Ensure groups page is loaded before interacting
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

/** Invite a user by npub and wait for the invitee to see the group. */
async function inviteAndJoin(
  inviterPage: Page,
  inviteePubNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  // Walled Garden v2 pull-only: warm up invitee's seen-set, then clear queue.
  await inviteePage.goto('/groups/');
  await inviteePage.waitForTimeout(10_000);
  await inviteePage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteePubNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

  // Invitee must explicitly accept the pending invitation.
  await inviteePage.waitForTimeout(5_000);
  await inviteePage.goto('/groups/');
  await expect(inviteePage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
  await expect(inviteePage.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 30_000 });
  await acceptInvitationAndWaitJoined(inviteePage, groupName);

  // Wait for profile exchange to complete
  await inviteePage.waitForTimeout(10_000);
}

/** Navigate to group detail page. */
async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

/** Update profile nickname on the profile page and save. */
async function updateProfileNickname(page: Page, newNickname: string): Promise<void> {
  await page.goto('/profile');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('profile-nickname-input').clear();
  await page.getByTestId('profile-nickname-input').fill(newNickname);
  await expect(page.getByTestId('profile-nickname-input')).toHaveValue(newNickname);
  // Leaving the field broadcasts the change (auto-save is silent — no toast).
  await page.getByTestId('profile-nickname-input').blur();
}

// ---------------------------------------------------------------------------
// Test Suite 1: Profile update propagation within a single group
// ---------------------------------------------------------------------------

test.describe.serial('Profile update propagation — single group', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Profile Update Test';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates group and invites B', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);

    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);

    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  test('B updates nickname — A sees updated name in member list', async () => {
    // B changes nickname from "Bob" to "Bobby"
    await updateProfileNickname(pgB, 'Bobby');

    // Wait for MLS profile message to propagate
    await pgB.waitForTimeout(10_000);

    // A navigates to the group detail to see updated member list
    await openGroupDetail(pgA, GROUP_NAME);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bobby');
  });

  test('A sees updated name in contact cache (localStorage)', async () => {
    // Verify B's updated profile is in A's contact cache
    const cachedNickname = await pgA.evaluate((pubkey: string) => {
      const raw = localStorage.getItem('lp_contactCache_v1');
      if (!raw) return null;
      const cache = JSON.parse(raw) as Record<string, { nickname: string }>;
      return cache[pubkey]?.nickname ?? null;
    }, USER_B.pubkeyHex);

    expect(cachedNickname).toBe('Bobby');
  });

  test('A updates nickname — B sees updated name in member list', async () => {
    // A changes nickname from "Alice" to "Alicia"
    await updateProfileNickname(pgA, 'Alicia');

    // Wait for MLS profile message to propagate
    await pgA.waitForTimeout(10_000);

    // B navigates to the group detail
    await openGroupDetail(pgB, GROUP_NAME);

    const alicePrefix = USER_A.pubkeyHex.slice(0, 8);
    await expect(pgB.getByTestId(`member-name-${alicePrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgB.getByTestId(`member-name-${alicePrefix}`)).toHaveText('Alicia');
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Profile update propagation across multiple groups
// ---------------------------------------------------------------------------

test.describe.serial('Profile update propagation — multi-group', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_1 = 'Multi-Group Profile 1';
  const GROUP_2 = 'Multi-Group Profile 2';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates two groups and invites B to both', async () => {
    // Create first group and invite B
    await createGroupAndOpen(pgA, GROUP_1);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_1);

    // Create second group and invite B
    await pgA.goto('/groups/');
    await createGroupAndOpen(pgA, GROUP_2);
    // B is already running so KeyPackages should be available
    await pgB.waitForTimeout(3_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_2);
  });

  test('B updates nickname — A sees updated name in both groups', async () => {
    // B changes nickname to "Robert"
    await updateProfileNickname(pgB, 'Robert');

    // Wait for propagation to all groups
    await pgB.waitForTimeout(12_000);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);

    // Check first group
    await openGroupDetail(pgA, GROUP_1);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Robert');

    // Check second group
    await openGroupDetail(pgA, GROUP_2);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Robert');
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Profile update with three members — C sees B's update
// ---------------------------------------------------------------------------

test.describe.serial('Profile update propagation — three members', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let pgC: Page;
  const GROUP_NAME = 'Three Member Update Group';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
    ({ context: ctxC, page: pgC } = await bootUserWithProfile(browser, USER_C, 'Carol'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('A creates group and invites B and C', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);

    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);

    // Invite C
    await openGroupDetail(pgA, GROUP_NAME);
    await pgC.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_C.npub, pgC, GROUP_NAME);
  });

  test('B updates nickname — both A and C see updated name', async () => {
    // B changes nickname to "Benjamin"
    await updateProfileNickname(pgB, 'Benjamin');

    // Wait for propagation
    await pgB.waitForTimeout(10_000);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);

    // A sees the update
    await openGroupDetail(pgA, GROUP_NAME);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Benjamin');

    // C sees the update
    await openGroupDetail(pgC, GROUP_NAME);
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Benjamin');
  });

  test('Contact cache updated on both receivers', async () => {
    // Verify B's updated profile is in both A's and C's contact cache
    for (const [label, page] of [['A', pgA], ['C', pgC]] as const) {
      const cachedNickname = await page.evaluate((pubkey: string) => {
        const raw = localStorage.getItem('lp_contactCache_v1');
        if (!raw) return null;
        const cache = JSON.parse(raw) as Record<string, { nickname: string }>;
        return cache[pubkey]?.nickname ?? null;
      }, USER_B.pubkeyHex);

      expect(cachedNickname, `${label}'s contact cache should have Benjamin`).toBe('Benjamin');
    }
  });
});
