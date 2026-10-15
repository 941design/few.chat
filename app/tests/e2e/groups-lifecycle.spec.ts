import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { queryRelayForEvents } from './helpers/relay-query';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user context: inject identity via init script, navigate to /groups/. */
async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  // Inject identity via init script BEFORE any page JavaScript runs.
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex });
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

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe.serial('Group Lifecycle', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUser(browser, USER_A));
    ({ context: contextB, page: pageB } = await bootUser(browser, USER_B));
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('User A creates a group', async () => {
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('E2E Test Group');
    await pageA.getByTestId('create-group-submit-btn').click();

    // Group should appear in the list
    await expect(pageA.getByText('E2E Test Group')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Allow time for relay events to be published
    await pageA.waitForTimeout(3_000);
  });

  test('User B initializes and publishes KeyPackages', async () => {
    // Wait for KeyPackage publication (happens automatically during MarmotContext init)
    await pageB.waitForTimeout(5_000);

    const events = await queryRelayForEvents(pageB, {
      kinds: [30443],
      authors: [USER_B.pubkeyHex],
      limit: 10,
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test('User A invites User B by npub', async () => {
    await dismissErrorOverlay(pageA);
    // Click on the group to open detail
    await pageA.locator(`[data-testid^="group-card-"]`, { hasText: 'E2E Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Open invite modal, seed User B as a contact, and invite via the picker
    await inviteContactViaPicker(pageA, USER_B.npub);

    // Wait for success
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // Verify gift wrap was published to relay
    await pageA.waitForTimeout(3_000);
    const giftWrapEvents = await queryRelayForEvents(pageA, { kinds: [1059], limit: 10 });
    expect(giftWrapEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('User B receives Welcome and joins group', async () => {
    // User B should see the group appear in their groups list via Welcome subscription
    await pageB.goto('/groups/');

    // First verify MarmotContext initializes
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pageB, 'E2E Test Group');
  });

  test('User B leaves group (soft-leave, no MLS proposal)', async () => {
    await dismissErrorOverlay(pageB);
    // Click on the group
    await pageB.locator(`[data-testid^="group-card-"]`, { hasText: 'E2E Test Group' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Soft-leave: purges local state only — no MLS Remove proposal is sent,
    // so the group is never blocked by unapplied proposals.
    await pageB.getByTestId('leave-group-btn').click();
    await pageB.getByTestId('leave-group-confirm-btn').click();

    // Group should be removed from User B's local list
    await expect(pageB.getByText('E2E Test Group')).not.toBeVisible({ timeout: 30_000 });
  });

  // NOTE: A "Reset clears processedGiftWraps cache" test previously lived here. It
  // drove the Settings "Reset All Data" button, which was removed from the
  // frontend (accidental misuse would irreversibly wipe the identity). The
  // resetAllData() logic that clears lp_* keys is retained and unit-tested in
  // app/tests/unit/storage.test.ts.
});
