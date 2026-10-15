import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/**
 * Boot a user with identity AND profile nickname pre-set in localStorage.
 *
 * The init script only writes lp_userProfile_v1 if it does not already exist,
 * so profile changes made during the test (via the settings page) survive
 * subsequent navigations within the same browser context.
 */
async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    // Always set identity (never changes during test)
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    // Only set profile on first load — avoid overwriting updates made during the test
    if (!localStorage.getItem('lp_userProfile_v1')) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // Re-seed identity + profile AFTER clearAppState, before reload. The guarded
  // addInitScript above (write only `if (!lp_userProfile_v1)`, to preserve
  // mid-test profile edits) races with ProfileContext's hydrate-and-persist:
  // if the first page's ProfileContext effect runs after clearAppState wiped
  // the profile, it persists an empty-nickname default ({nickname:'',
  // avatar:<random>}) that then survives the reload guard. The user would then
  // broadcast a blank nickname to the group, so peers render its npub instead
  // of the seeded name. This boot-time write (before any settings-page edit)
  // is compatible with the guard's mid-test-edit intent.
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

/** Create a group, open its detail, and return. */
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

/** Invite a user by npub and wait for the invitee to see the group. */
async function inviteAndJoin(
  inviterPage: Page,
  inviteePubNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteePubNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

  // Invitee receives Welcome and joins
  await inviteePage.goto('/groups/');
  // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
  // and wait for the real joined group-card before continuing.
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
// Test Suite 1: Pending member indicator
//
// Strategy: boot B to publish KeyPackages, then navigate B to about:blank so
// the Welcome subscription is torn down. A invites B while B is offline, so
// B cannot process the Welcome or publish a profile. A's member list should
// show B as pending. Then B returns, joins, and the badge disappears.
// ---------------------------------------------------------------------------

test.describe.serial('Pending member indicator', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Pending Indicator Test';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('Invited member shows as pending before joining', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);

    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);

    // Take B offline by navigating away — tears down React app and
    // Welcome subscription while preserving IndexedDB/localStorage.
    await pgB.goto('about:blank');

    // Invite B (B is offline and cannot process the Welcome)
    await dismissErrorOverlay(pgA);
    await inviteContactViaPicker(pgA, USER_B.npub);
    await expect(pgA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // Navigate back to group detail to refresh member list
    await openGroupDetail(pgA, GROUP_NAME);

    // B should appear in member list with Pending badge
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-item-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-pending-${bobPrefix}`)).toBeVisible({ timeout: 10_000 });
  });

  test('Pending badge disappears after member joins and sends profile', async () => {
    // Bring B back online — app re-initialises, processes the pending Welcome
    await pgB.goto('/groups/');
    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pgB, GROUP_NAME);

    // Wait for profile exchange
    await pgB.waitForTimeout(10_000);

    // A navigates to group detail — B should no longer be pending
    await openGroupDetail(pgA, GROUP_NAME);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');
    // Pending badge should be gone
    await expect(pgA.getByTestId(`member-pending-${bobPrefix}`)).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Live nickname update (no navigation required)
// ---------------------------------------------------------------------------

test.describe.serial('Live nickname update without navigation', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Live Update Test';

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
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  test('B changes nickname — A sees update on current page without navigating', async () => {
    // A opens group detail and stays on the page
    await openGroupDetail(pgA, GROUP_NAME);

    // Verify B currently shows as "Bob"
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');

    // B changes nickname to "Bobby" via settings
    await updateProfileNickname(pgB, 'Bobby');

    // A should see the update WITHOUT navigating away from the group detail page.
    // The profileVersion counter in MarmotContext triggers a re-read from IDB
    // after the IDB write completes.
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bobby', { timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Stale closure fix — nickname change before new member join
// ---------------------------------------------------------------------------

test.describe.serial('Profile re-send uses current nickname after change', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let pgC: Page;
  const GROUP_NAME = 'Stale Closure Fix Test';

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

  test('A creates group and invites B', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  // FIXME: same delivery flake as groups-member-profiles "A invites C" (~33–60% failure rate).
  // C never receives A's PROFILE_RUMOR_KIND even after 30s — the stale-closure fix itself
  // (localProfileRef.current = "Alicia" in inviteByNpub) is correct; the delivery gap is the
  // same NDK subscription gap / strfry asymmetry documented in
  // bug-reports/profile-rumor-undeliverable-to-new-member.md. Failure rate climbed after
  // 4df6284 made the relay persist between runs (accumulated state → higher flake).
  test.fixme('A changes nickname, then invites C — C sees updated nickname', async () => {
    // A changes nickname from "Alice" to "Alicia"
    await updateProfileNickname(pgA, 'Alicia');

    // Wait for the profile update to propagate (to B and to relays)
    await pgA.waitForTimeout(5_000);

    // Wait for C to publish KeyPackages
    await pgC.waitForTimeout(5_000);

    // A invites C (A's onMembersChanged should use localProfileRef with "Alicia")
    await openGroupDetail(pgA, GROUP_NAME);
    await inviteAndJoin(pgA, USER_C.npub, pgC, GROUP_NAME);

    // C opens group detail
    await pgC.locator(`[data-testid^="group-card-"]`, { hasText: GROUP_NAME }).click();
    await expect(pgC.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // C should see "Alicia" (the current nickname), NOT "Alice" (the stale one)
    const alicePrefix = USER_A.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${alicePrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${alicePrefix}`)).toHaveText('Alicia');

    // C should also see Bob
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');

    // C sees own profile
    const carolPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${carolPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${carolPrefix}`)).toHaveText('Carol');
  });
});
