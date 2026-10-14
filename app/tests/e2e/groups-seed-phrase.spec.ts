import { test, expect } from '@playwright/test';
import { clearAppState } from './helpers/clear-state';
import { openAdvancedSettings } from './helpers/settings';

test.describe('Seed Phrase Backup & Restore', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await page.reload();
  });

  test('Generate 12-word mnemonic', async ({ page }) => {
    await page.goto('/settings/');
    await openAdvancedSettings(page);
    await expect(page.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });

    // Click generate backup phrase
    await page.getByTestId('generate-backup-phrase-btn').click();
    const mnemonicDisplay = page.getByTestId('mnemonic-display');
    await expect(mnemonicDisplay).toBeVisible({ timeout: 10_000 });

    const mnemonicText = await mnemonicDisplay.textContent();
    expect(mnemonicText).toBeTruthy();
    const words = mnemonicText!.trim().split(/\s+/);
    expect(words.length).toBe(12);
  });

  test('Confirm backup flow', async ({ page }) => {
    await page.goto('/settings/');
    await openAdvancedSettings(page);
    await expect(page.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('generate-backup-phrase-btn').click();
    await expect(page.getByTestId('mnemonic-display')).toBeVisible({ timeout: 10_000 });

    // Check the confirmation checkbox and click done
    await page.getByTestId('backup-confirm-checkbox').check();
    await page.getByTestId('backup-done-btn').click();

    // Mnemonic should no longer be visible
    await expect(page.getByTestId('mnemonic-display')).not.toBeVisible({ timeout: 5_000 });
  });

  test('Restore identity on fresh context', async ({ page, browser }) => {
    // First: generate identity and get the mnemonic
    await page.goto('/settings/');
    await openAdvancedSettings(page);
    await expect(page.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });
    const originalNpub = await page.getByTestId('identity-npub-display').textContent();

    await page.getByTestId('generate-backup-phrase-btn').click();
    await expect(page.getByTestId('mnemonic-display')).toBeVisible({ timeout: 10_000 });
    const mnemonic = await page.getByTestId('mnemonic-display').textContent();
    expect(mnemonic).toBeTruthy();

    // Confirm backup
    await page.getByTestId('backup-confirm-checkbox').check();
    await page.getByTestId('backup-done-btn').click();

    // Second: open a fresh browser context and restore
    const newContext = await browser.newContext();
    const newPage = await newContext.newPage();
    await newPage.goto('/settings/');

    // The npub lives under Advanced Settings. Expand it BEFORE restoring: the
    // original identity has published a relay backup, so the restore opens the
    // "Restore from backup?" dialog, whose overlay would block the toggle.
    const restoreInput = newPage.getByTestId('restore-phrase-input');
    await expect(restoreInput).toBeVisible({ timeout: 30_000 });
    await openAdvancedSettings(newPage);

    // Enter mnemonic to restore
    await restoreInput.fill(mnemonic!.trim());
    await newPage.getByTestId('restore-identity-btn').click();

    // Verify same npub — wait for the display to update to the restored identity.
    await expect(newPage.getByTestId('identity-npub-display')).toHaveText(originalNpub!, { timeout: 30_000 });

    await newContext.close();
  });
});
