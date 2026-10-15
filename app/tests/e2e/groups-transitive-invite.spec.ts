import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { queryRelayForEvents } from './helpers/relay-query';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user context: inject identity via init script, navigate to /groups/. */
async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  opts?: { nickname?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  // Inject identity via init script BEFORE any page JavaScript runs.
  // This prevents the race where the React app generates a random identity
  // before our injected identity is set.
  // Only inject identity — don't clear lp_* keys here. clearAppState handles
  // full cleanup during boot. Clearing here would wipe lp_processedGiftWraps
  // which prevents Welcome re-processing on page reload.
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (nickname) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname: opts?.nickname ?? '' });
  const page = await context.newPage();
  // First load: clear IndexedDB (async, but completes before meaningful app init)
  await page.goto('/');
  await clearAppState(page);
  // Reload so app starts fresh with the injected identity and clean IndexedDB
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

/** Wait for MarmotContext init and KeyPackage publication. */
async function waitForKeyPackages(page: Page, pubkeyHex: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const events = await queryRelayForEvents(page, {
          kinds: [30443],
          authors: [pubkeyHex],
          limit: 1,
        });
        return events.length;
      },
      { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
    )
    .toBeGreaterThanOrEqual(1);
}

/** Create a group from the given page. */
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

/** Navigate to a group's detail page. */
async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

/** Invite a user by npub from the group detail page. */
async function inviteMember(page: Page, npub: string): Promise<void> {
  await inviteContactViaPicker(page, npub);
  await expect(page.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3_000);
}

/** Assert that a member's pubkey appears in the member list. */
async function expectMemberVisible(page: Page, pubkeyHex: string): Promise<void> {
  const testId = `member-item-${pubkeyHex.slice(0, 8)}`;
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
}

/** Wait for a group to appear in the groups list, then open its detail page. */
async function waitForGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
  // and wait for the real joined group-card before continuing.
  await acceptInvitationAndWaitJoined(page, groupName);
  await openGroupDetail(page, groupName);
}

// ---------------------------------------------------------------------------
// Scenario 1: Hub invite — A invites B, A invites C
// ---------------------------------------------------------------------------
test.describe.serial('Group of 3 – hub invite (A invites B and C)', () => {
  const GROUP_NAME = 'Hub Invite Group';
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, { nickname: 'TestPlayerB' }));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('User A creates a group', async () => {
    await createGroup(pageA, GROUP_NAME);
  });

  test('Users B and C publish KeyPackages', async () => {
    await waitForKeyPackages(pageB, USER_B.pubkeyHex);
    await waitForKeyPackages(pageC, USER_C.pubkeyHex);
  });

  test('User A invites User B', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_B.npub);
  });

  test('User A invites User C', async () => {
    await dismissErrorOverlay(pageA);
    await inviteMember(pageA, USER_C.npub);
  });

  test('User B joins and sees all 3 members', async () => {
    await waitForGroupAndOpen(pageB, GROUP_NAME);
    await expectMemberVisible(pageB, USER_A.pubkeyHex);
    await expectMemberVisible(pageB, USER_B.pubkeyHex);
    await expectMemberVisible(pageB, USER_C.pubkeyHex);
  });

  test('User C joins and sees all 3 members', async () => {
    await waitForGroupAndOpen(pageC, GROUP_NAME);
    await expectMemberVisible(pageC, USER_A.pubkeyHex);
    await expectMemberVisible(pageC, USER_B.pubkeyHex);
    await expectMemberVisible(pageC, USER_C.pubkeyHex);
  });

  test('User A sees all 3 members', async () => {
    await pageA.goto('/groups/');
    await openGroupDetail(pageA, GROUP_NAME);
    await expectMemberVisible(pageA, USER_A.pubkeyHex);
    await expectMemberVisible(pageA, USER_B.pubkeyHex);
    await expectMemberVisible(pageA, USER_C.pubkeyHex);
  });

  test('User B nickname is visible to User A after join', async () => {
    await pageA.goto('/groups/');
    await expect(
      pageA.getByTestId('groups-empty-state').or(pageA.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await openGroupDetail(pageA, GROUP_NAME);

    const memberTestId = `member-item-${USER_B.pubkeyHex.slice(0, 8)}`;
    await expect(
      pageA.getByTestId(memberTestId).getByText('TestPlayerB'),
    ).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Sequential invite — A invites B, B joins, then A invites C
// All members eventually see the full group.
// (Admin-only commits per MIP-03 means only the creator can add members.)
// ---------------------------------------------------------------------------
test.describe.serial('Group of 3 – sequential invite (A→B, B joins, A→C)', () => {
  const GROUP_NAME = 'Sequential Invite Group';
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('User A creates a group', async () => {
    await createGroup(pageA, GROUP_NAME);
  });

  test('Users B and C publish KeyPackages', async () => {
    await waitForKeyPackages(pageB, USER_B.pubkeyHex);
    await waitForKeyPackages(pageC, USER_C.pubkeyHex);
  });

  test('User A invites User B', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_B.npub);
  });

  test('User B joins and sees A and B', async () => {
    await waitForGroupAndOpen(pageB, GROUP_NAME);
    await expectMemberVisible(pageB, USER_A.pubkeyHex);
    await expectMemberVisible(pageB, USER_B.pubkeyHex);
  });

  test('User A invites User C', async () => {
    // A is still on group detail
    await dismissErrorOverlay(pageA);
    await inviteMember(pageA, USER_C.npub);
  });

  test('User C joins and sees all 3 members', async () => {
    await waitForGroupAndOpen(pageC, GROUP_NAME);
    await expectMemberVisible(pageC, USER_A.pubkeyHex);
    await expectMemberVisible(pageC, USER_B.pubkeyHex);
    await expectMemberVisible(pageC, USER_C.pubkeyHex);
  });

  test('User A sees all 3 members', async () => {
    await pageA.goto('/groups/');
    await openGroupDetail(pageA, GROUP_NAME);
    await expectMemberVisible(pageA, USER_A.pubkeyHex);
    await expectMemberVisible(pageA, USER_B.pubkeyHex);
    await expectMemberVisible(pageA, USER_C.pubkeyHex);
  });
});
