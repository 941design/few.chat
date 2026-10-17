import { test, expect } from '@playwright/test';

test.describe('Story 08: Theme Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Clear all app data
    await page.goto('/');
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('lp_'))
        .forEach((k) => localStorage.removeItem(k));
    });
  });

  test('1. Settings page renders the spring theme button (the only shipped theme)', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    const settingsPage = page.getByTestId('settings-page');
    await expect(settingsPage).toBeVisible();

    // spring is the only shipped theme; its button is present and the
    // removed themes' buttons are gone.
    await expect(page.getByTestId('theme-spring-btn')).toBeVisible();
    for (const removed of ['calm', 'playful', 'lego', 'minecraft', 'flower', 'aquarelle']) {
      await expect(page.getByTestId(`theme-${removed}-btn`)).toHaveCount(0);
    }
  });

  test('2. Selecting the spring theme persists in localStorage', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('theme-spring-btn').click();

    // The picker card itself is now the only "this theme is active" marker —
    // the redundant preview box below the grid was removed.
    await expect(page.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('lp_settings_v1'));
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.theme).toBe('spring');
  });

  test('3. Theme setting persists after page reload', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('theme-spring-btn').click();
    await expect(page.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');

    // Reload
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still show spring
    await expect(page.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');
  });

  // NOTE: Wiping all local data lives in the Advanced settings' Danger Zone
  // (advanced-settings.spec.ts); resetAllData() itself is covered by
  // app/tests/unit/storage.test.ts and crossTab-accountChanged.test.ts.

  test('4. a deprecated/unknown stored theme name falls back to spring without error', async ({ page }) => {
    // A settings blob persisted before the old themes were removed must not
    // break the app — it normalizes to spring on read.
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.setItem('lp_settings_v1', JSON.stringify({ theme: 'minecraft', language: 'en' })),
    );
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('lp_settings_v1'));
    // Reading settings normalizes the deprecated name; once the picker writes,
    // the persisted value is the valid spring id.
    await page.getByTestId('theme-spring-btn').click();
    const afterClick = await page.evaluate(() => JSON.parse(localStorage.getItem('lp_settings_v1')!));
    expect(afterClick.theme).toBe('spring');
    expect(stored).toBeTruthy();
  });

  test('5. the light spring theme renders no content panel', async ({ page }) => {
    // Light themes paint content directly on a light appBg; the panel must not
    // appear, so the layout stays unchanged for them.
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.setItem('lp_settings_v1', JSON.stringify({ theme: 'spring', language: 'en' })),
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('content-panel')).toHaveCount(0);
  });
});
