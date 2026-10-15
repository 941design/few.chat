import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import path from 'node:path';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const FIXTURE_IMAGE = path.join(__dirname, '../fixtures/test-image.png');

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    // Allow download events
    acceptDownloads: true,
  });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem(
        'lp_nostrIdentity_v1',
        JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }),
      );
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
  );
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

// Skipped: message attachments are disabled product-wide via the
// ATTACHMENTS_ENABLED toggle (app/src/config/features.ts) while the feature is
// deprecated — there is no attach button to drive. The feature code and this
// suite are retained; flip the toggle back on to restore both.
// Mirrors the groups-calls-video-bidirectional.spec.ts precedent (CALLS_ENABLED).
test.describe.skip('Image Sharing', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUser(browser, USER_A));
    ({ context: contextB, page: pageB } = await bootUser(browser, USER_B));
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  // ── Setup: create group and invite ────────────────────────────────────────

  test('User A creates a group', async () => {
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('Image Test Group');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Image Test Group')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageA);
    await pageA.waitForTimeout(3_000);
  });

  test('User B publishes KeyPackages', async () => {
    await pageB.waitForTimeout(5_000);
  });

  test('User A invites User B', async () => {
    await dismissErrorOverlay(pageA);
    await pageA.locator(`[data-testid^="group-card-"]`, { hasText: 'Image Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
  });

  test('User B joins group', async () => {
    await pageB.reload();
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // Pull-only invitations (Walled Garden v2): accept THIS group's invitation
    // and wait for the real joined group-card before continuing.
    await acceptInvitationAndWaitJoined(pageB, 'Image Test Group');
    await pageB.locator(`[data-testid^="group-card-"]`, { hasText: 'Image Test Group' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageB);
  });

  // ── AC-60: Two-tab send + receive ─────────────────────────────────────────

  test('AC-60: User A attaches image and sends; User B sees image-thumbnail', async () => {
    // User A: navigate to group and attach image
    await pageA.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

    // Attach file via hidden input
    const [fileChooser] = await Promise.all([
      pageA.waitForEvent('filechooser'),
      pageA.getByTestId('image-attachment-button').click(),
    ]);
    await fileChooser.setFiles(FIXTURE_IMAGE);

    // Preview should appear
    await expect(pageA.getByTestId('image-preview-thumbnail')).toBeVisible({ timeout: 10_000 });

    // Type optional caption and send
    await pageA.getByTestId('chat-input').fill('E2E test caption');
    await pageA.getByTestId('chat-send-btn').click();

    // Preview disappears after send
    await expect(pageA.getByTestId('image-preview-thumbnail')).not.toBeVisible({ timeout: 30_000 });

    // User B: should receive the image bubble
    await expect(pageB.getByTestId('image-thumbnail')).toBeVisible({ timeout: 90_000 });
  });

  // ── AC-61: Lightbox open ──────────────────────────────────────────────────

  test('AC-61: Clicking image-thumbnail on tab B opens lightbox-image', async () => {
    await pageB.getByTestId('image-thumbnail').click();
    await expect(pageB.getByTestId('lightbox-image')).toBeVisible({ timeout: 30_000 });
    // Close lightbox
    await pageB.getByTestId('lightbox-close').click();
    await expect(pageB.getByTestId('lightbox-image')).not.toBeVisible({ timeout: 10_000 });
  });

  // ── AC-62: Download button ────────────────────────────────────────────────

  test('AC-62: Clicking lightbox-download triggers a file download', async () => {
    await pageB.getByTestId('image-thumbnail').click();
    await expect(pageB.getByTestId('lightbox-image')).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([
      pageB.waitForEvent('download'),
      pageB.getByTestId('lightbox-download').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^[a-zA-Z0-9_-]+-\d{8}-\d{4}\.\w+$/);
    await pageB.getByTestId('lightbox-close').click();
  });

  // ── AC-64: Reload persistence ─────────────────────────────────────────────

  test('AC-64: After both tabs reload, tab B still shows image-thumbnail', async () => {
    await Promise.all([pageA.reload(), pageB.reload()]);

    // Navigate back to the group
    await pageA.goto('/groups/');
    await pageB.goto('/groups/');

    await pageA.locator(`[data-testid^="group-card-"]`, { hasText: 'Image Test Group' }).click();
    await pageB.locator(`[data-testid^="group-card-"]`, { hasText: 'Image Test Group' }).click();

    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Tab B should still show the cached thumbnail
    await expect(pageB.getByTestId('image-thumbnail')).toBeVisible({ timeout: 60_000 });
  });

  // ── AC-63: Retry flow (send failure recovery) ─────────────────────────────
  // Drives the full failure path: forces the Blossom mock to return 500 for
  // uploads, sends an image, asserts the failure UI appears and no thumbnail
  // reaches the receiver, then restores the mock, clicks image-retry-button,
  // and asserts the image is delivered.

  test('AC-63: send failure shows retry button; retry recovers and delivers image', async ({
    request,
  }) => {
    const MOCK_BASE = process.env.BLOSSOM_BASE_URL || 'http://localhost:3001';

    // Force the mock to fail uploads (5xx, so blossomClient retries+exhausts).
    const failResp = await request.post(`${MOCK_BASE}/admin/fail-uploads`);
    expect(failResp.ok()).toBe(true);

    try {
      const baselineThumbs = await pageB.getByTestId('image-thumbnail').count();

      // Attach + send (must fail because mock is in fail-uploads mode).
      const [fileChooser] = await Promise.all([
        pageA.waitForEvent('filechooser'),
        pageA.getByTestId('image-attachment-button').click(),
      ]);
      await fileChooser.setFiles(FIXTURE_IMAGE);
      await expect(pageA.getByTestId('image-preview-thumbnail')).toBeVisible({ timeout: 10_000 });
      await pageA.getByTestId('chat-input').fill('retry-flow caption');
      await pageA.getByTestId('chat-send-btn').click();

      // Failure UI appears. Three 5xx retries with [500,1500,5000]ms back-off
      // total ~7s before the client gives up — give it generous headroom.
      await expect(pageA.getByTestId('image-send-failed')).toBeVisible({ timeout: 30_000 });
      await expect(pageA.getByTestId('image-retry-button')).toBeVisible();

      // Preview must still be attached (so retry has the file to resend).
      await expect(pageA.getByTestId('image-preview-thumbnail')).toBeVisible();

      // Receiver must NOT see a new thumbnail while the send is in failed state.
      expect(await pageB.getByTestId('image-thumbnail').count()).toBe(baselineThumbs);

      // Restore the mock so the retry can succeed.
      const restoreResp = await request.post(`${MOCK_BASE}/admin/clear-failures`);
      expect(restoreResp.ok()).toBe(true);

      // Click retry. Failure UI should clear; preview disappears once sent.
      await pageA.getByTestId('image-retry-button').click();
      await expect(pageA.getByTestId('image-send-failed')).not.toBeVisible({ timeout: 60_000 });
      await expect(pageA.getByTestId('image-preview-thumbnail')).not.toBeVisible({ timeout: 60_000 });

      // Receiver picks up the new image after retry succeeds.
      await expect(pageB.getByTestId('image-thumbnail')).toHaveCount(baselineThumbs + 1, {
        timeout: 90_000,
      });
    } finally {
      // Always clear the failure flag so subsequent runs / tests are clean.
      await request.post(`${MOCK_BASE}/admin/clear-failures`).catch(() => {});
    }
  });
});
