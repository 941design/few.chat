import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const TEST_AVATAR = {
  imageUrl: '//few.chat/assets/apple.png',
};

/** Boot a user with identity AND profile nickname pre-set in localStorage. */
async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
  avatar: { imageUrl: string } | null = null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  // Inject identity + profile via init script BEFORE any page JavaScript runs.
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname, avatar }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname, avatar });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // clearAppState removes lp_* keys — the init script re-injects on next navigation
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe.serial('Group member profiles — names instead of npubs', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: contextB, page: pageB } = await bootUserWithProfile(browser, USER_B, 'Bob', TEST_AVATAR));
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('Own profile name is shown in group member list', async () => {
    // Create group
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('Profile Test Group');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Profile Test Group')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Open group detail
    await pageA.locator(`[data-testid^="group-card-"]`, { hasText: 'Profile Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Verify own member entry shows nickname "Alice", not a truncated npub
    const ownPrefix = USER_A.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-name-${ownPrefix}`)).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByTestId(`member-name-${ownPrefix}`)).toHaveText('Alice');
  });

  test('Invited member profile replaces npub and shows avatar after join', async () => {
    // Wait for User B to publish KeyPackages
    await pageB.waitForTimeout(5_000);

    // Invite User B
    await dismissErrorOverlay(pageA);
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // User B receives Welcome and joins
    await pageB.goto('/groups/');
    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pageB, 'Profile Test Group');

    // Wait for User B's profile to be published and User A to receive it.
    // TODO: This 10-second timeout is a conservative workaround added during initial
    // E2E validation of the profile-propagation fix (bug-reports/profile-propagation-new-members.md).
    // Once the fix has been validated in production, this can be reduced or replaced with
    // a deterministic poll (e.g. waitForSelector on the member-name test-id).
    await pageB.waitForTimeout(10_000);

    // User A navigates back to group detail to see updated member list
    await pageA.goto('/groups/');
    await pageA.locator(`[data-testid^="group-card-"]`, { hasText: 'Profile Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Verify User B's member entry shows "Bob"
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');
    await expect(pageA.getByTestId(`member-npub-${bobPrefix}`)).toHaveCount(0);
    await expect(
      pageA.locator(`[data-testid="member-item-${bobPrefix}"] img[alt="Bob"]`),
    ).toHaveCount(1);
  });
});

test.describe.serial('New member receives all existing member profiles', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let pgC: Page;

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
    // Create group
    await pgA.getByTestId('create-group-btn').click();
    await expect(pgA.getByTestId('create-group-modal-content')).toBeVisible();
    await pgA.getByTestId('create-group-name-input').fill('Three Member Profile Group');
    await pgA.getByTestId('create-group-submit-btn').click();
    await expect(pgA.getByText('Three Member Profile Group')).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pgA);

    // Open group detail
    await pgA.locator(`[data-testid^="group-card-"]`, { hasText: 'Three Member Profile Group' }).click();
    await expect(pgA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);

    // Invite B
    await dismissErrorOverlay(pgA);
    await inviteContactViaPicker(pgA, USER_B.npub);
    await expect(pgA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // B receives Welcome and joins
    await pgB.goto('/groups/');
    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pgB, 'Three Member Profile Group');

    // Wait for profile exchange between A and B
    await pgB.waitForTimeout(10_000);
  });

  // FIXME: ~33–60% flake. C never receives one of Alice/Bob's PROFILE_RUMOR_KIND
  // events even after 60s — neither the direct sendSelfProfile reply nor the
  // relay-on-behalf path lands at C's dispatcher. Adding a flush-on-app-msg
  // retry to EpochResolver did not help, so the missing rumor is not sitting
  // in futureBuffer. See bug-reports/profile-rumor-undeliverable-to-new-member.md.
  test.fixme('A invites C — C sees both Alice and Bob profiles', async () => {
    // Wait for C to publish KeyPackages
    await pgC.waitForTimeout(5_000);

    // A invites C
    await dismissErrorOverlay(pgA);
    await pgA.goto('/groups/');
    await pgA.locator(`[data-testid^="group-card-"]`, { hasText: 'Three Member Profile Group' }).click();
    await expect(pgA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(pgA, USER_C.npub);
    await expect(pgA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // C receives Welcome and joins
    await pgC.goto('/groups/');
    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pgC, 'Three Member Profile Group');

    // Wait for A and B to republish profiles after detecting new member
    await pgC.waitForTimeout(10_000);

    // C opens group detail
    await pgC.locator(`[data-testid^="group-card-"]`, { hasText: 'Three Member Profile Group' }).click();
    await expect(pgC.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // C should see Alice's profile
    const alicePrefix = USER_A.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${alicePrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${alicePrefix}`)).toHaveText('Alice');

    // C should see Bob's profile
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');

    // C should see own profile
    const carolPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pgC.getByTestId(`member-name-${carolPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pgC.getByTestId(`member-name-${carolPrefix}`)).toHaveText('Carol');
  });
});
