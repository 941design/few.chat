import { test, expect } from '@playwright/test';

/**
 * Epic: mobile-qr-scanner, story S2 — the FAB and its scanner entry point.
 * Non-relay bucket: filename deliberately avoids the `groups-*`/`dm-*`
 * globs `playwright.config.ts` routes to the strfry/Docker project, so this
 * spec runs on `next dev` alone (see CLAUDE.md's E2E gate section).
 *
 * The real camera decode -> resolveScanDestination -> navigate path (AC-
 * SCAN-2/AC-SCAN-3) is manual-only (MV-1, per stories.json) — Playwright
 * cannot feed a synthetic QR image through the fake camera device, so it is
 * not attempted here.
 *
 * AC-SCAN-1's negative branches (camera unavailable / permission denied)
 * are ALSO not exercised here, despite the story brief's expectation that
 * `canUseCameraQrScanner()` reads false headless: this repo's single
 * Playwright chromium project launches with `--use-fake-device-for-media-
 * stream --use-fake-ui-for-media-stream` (playwright.config.ts, required by
 * the calls e2e suite), which makes `isSecureContext` true, exposes a fake
 * `videoinput` device, and auto-grants the permission prompt. Verified by a
 * direct in-page probe during implementation: `canUseCameraQrScanner()`
 * evaluates true and `getUserMedia({video:true})` succeeds under this
 * config, so the camera actually starts rather than falling back to the
 * unavailable/permission-denied message. What IS asserted below is the
 * positive half of AC-SCAN-1 that's actually reachable here: tapping the
 * FAB opens the scanner surface with the real translated chrome and no
 * error alert — i.e. not a broken/blank view.
 */
test.describe('Mobile QR scanner FAB', () => {
  test('renders at a mobile viewport and is absent at a desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('qr-scan-fab')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('qr-scan-fab')).toBeHidden();
  });

  test('is hidden on an open-chat route the way the bottom tab bar is', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('qr-scan-fab')).toBeVisible();
    await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();

    // Route-visibility gating is keyed on route + presence of `id`, not on
    // whether the contact actually resolves — an arbitrary id is enough to
    // exercise the hidden branch without seeding a real contact.
    await page.goto('/contacts?id=nonexistent-probe');
    await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden();
    await expect(page.getByTestId('qr-scan-fab')).toBeHidden();
  });

  test('is not a member of the hamburger overlay', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByTestId('mobile-menu-btn').click();

    const overlay = page.getByTestId('mobile-nav');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId('qr-scan-fab')).toHaveCount(0);
    // navItems is unchanged by this epic — still exactly Contacts + Groups.
    await expect(overlay.getByRole('link', { name: 'Contacts' })).toBeVisible();
    await expect(overlay.getByRole('link', { name: 'Groups' })).toBeVisible();
  });

  test('tapping the FAB opens the scanner with real translated chrome and no broken view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByTestId('qr-scan-fab').click();

    const modal = page.getByTestId('qr-scan-fab-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Scan QR Code')).toBeVisible();
    await expect(modal.getByText('Point the camera at a few.chat contact card or group invite QR code.')).toBeVisible();

    // Wait for the camera pipeline (fake device under this project's launch
    // args) to actually settle. `npub-qr-video` is a NON-gate: the <video>
    // element renders unconditionally from first paint (NpubQrScanner.tsx),
    // so asserting it visible passes immediately and proves nothing about
    // whether the pipeline resolved (gate-remediation Finding C). The real
    // settle signal is `setStarting(false)`, which fires on BOTH the
    // success and error paths and removes the "Starting camera" overlay
    // from the DOM — wait for that overlay to disappear via an auto-
    // retrying assertion, THEN confirm no error alert surfaced. A real
    // camera-unavailable/permission-denied case would still render
    // `npub-qr-scan-error` at that point instead. No fixed wait
    // (gate-remediation Finding 3 / this Finding C, per CLAUDE.md's
    // documented e2e anti-pattern).
    await expect(page.getByTestId('npub-qr-starting-overlay')).toBeHidden();
    await expect(page.getByTestId('npub-qr-scan-error')).toHaveCount(0);
  });
});
