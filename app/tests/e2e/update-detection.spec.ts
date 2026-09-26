/**
 * E2E tests for the update-detection feature (S2).
 *
 * These tests intercept /version.json via page.route() and use window focus
 * events to trigger an immediate check without waiting for the 5-minute interval.
 *
 * The dev server bakes NEXT_PUBLIC_BUILD_VERSION into the bundle. We read the
 * actual baked value from window.__BUILD_VERSION (exposed in _app.tsx) to
 * construct same-version intercepts that correctly suppress the banner.
 */
import { test, expect } from '@playwright/test';

test.describe('Update Detection', () => {
  test('shows banner when version.json returns a different version', async ({ page }) => {
    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 'new-version-xyz', builtAt: '2026-06-14T00:00:00Z' }),
      })
    );

    await page.goto('/');
    // Trigger an immediate check by dispatching a focus event.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 5000 });
  });

  test('does NOT show banner when version.json returns the same version', async ({ page }) => {
    await page.goto('/');

    // Read the baked-in version from the running app.
    const bakedVersion = await page.evaluate(() => window.__BUILD_VERSION);

    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: bakedVersion ?? 'dev',
          builtAt: '2026-06-14T00:00:00Z',
        }),
      })
    );

    // Wait past the 2-second startup window so the startup-timer check actually
    // fires and returns the same-version response before we assert absence.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('update-banner')).not.toBeVisible();
  });

  test('does NOT show banner on network error (fail-soft)', async ({ page }) => {
    await page.route('**/version.json**', (route) => route.abort('failed'));
    await page.goto('/');
    // Wait past the 2-second startup window so the startup-timer check actually
    // fires and exercises the fail-soft path before we assert absence.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('update-banner')).not.toBeVisible();
  });

  test('does NOT show banner on 404 (fail-soft)', async ({ page }) => {
    await page.route('**/version.json**', (route) => route.fulfill({ status: 404 }));
    await page.goto('/');
    // Wait past the 2-second startup window so the startup-timer check actually
    // fires and exercises the fail-soft path before we assert absence.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('update-banner')).not.toBeVisible();
  });

  test('banner is non-blocking — user can still interact with the app', async ({ page }) => {
    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 'new-version-xyz', builtAt: '2026-06-14T00:00:00Z' }),
      })
    );

    await page.goto('/');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 5000 });

    // Banner is visible — navigation should still work.
    const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    await expect(navigation).toBeVisible();
    await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/?(?:\?.*)?$/);
    await expect(page.getByTestId('update-banner')).toBeVisible();
  });

  test('dismiss hides banner for session', async ({ page }) => {
    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 'new-version-xyz', builtAt: '2026-06-14T00:00:00Z' }),
      })
    );

    await page.goto('/');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('update-banner-dismiss').click();
    await expect(page.getByTestId('update-banner')).not.toBeVisible();
  });

  test('reload action reloads the current page', async ({ page }) => {
    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 'new-version-xyz' }),
      })
    );
    await page.goto('/settings/');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('update-banner')).toBeVisible();
    const documentRequest = page.waitForRequest((request) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame()
    );
    await page.getByTestId('update-banner-reload').click();
    await documentRequest;
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/settings\/?$/);
    await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toBeVisible();
  });

  test('visibilitychange to visible triggers immediate check', async ({ page }) => {
    await page.route('**/version.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 'new-version-xyz', builtAt: '2026-06-14T00:00:00Z' }),
      })
    );

    await page.goto('/');
    // Simulate the tab becoming visible via visibilitychange.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 5000 });
  });
});
