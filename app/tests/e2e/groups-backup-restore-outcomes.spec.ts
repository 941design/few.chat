/**
 * E2E: restore outcomes after identity recovery
 * (epic: backup-restore-reliability, AC-BRR-4 / AC-BRR-7).
 *
 * Identity recovery must say what happened to the app-state backup instead of
 * reporting a bare success:
 *   - an identity that never saved a backup shows the "no backup found" notice;
 *   - an identity with a backup opens the translated confirmation dialog, and
 *     restoring applies it (the user's profile comes back) and lifts the
 *     restore-decision pause.
 *
 * Backups are produced by the app itself (a fresh profile without an avatar is
 * backfilled on mount, which triggers an immediate scheduled backup); the relay
 * is only *read* to wait for that publish to land. Named `groups-*` so it runs
 * in the relay bucket. Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { randomBytes } from 'node:crypto';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { openAdvancedSettings } from './helpers/settings';
import { queryRelayForEvents } from './helpers/relay-query';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function freshPage(browser: import('@playwright/test').Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.reload();
  return { context, page };
}

async function recoverIdentity(page: Page, mnemonic: string): Promise<void> {
  await page.goto('/settings/');
  await openAdvancedSettings(page);
  await expect(page.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('restore-phrase-input').fill(mnemonic);
  await page.getByTestId('restore-identity-btn').click();
}

test.describe('Restore outcomes after identity recovery', () => {
  test('an identity without a backup is told no backup was found', async ({ browser }) => {
    // A brand-new phrase: this identity has never run the app, so no backup exists.
    const mnemonic = entropyToMnemonic(randomBytes(16), wordlist);
    const { context, page } = await freshPage(browser);
    try {
      await recoverIdentity(page, mnemonic);

      // Any outcome (or a restore error) — so a failure names what was shown instead.
      const notice = page.locator('[data-testid^="backup-notice-"], [data-testid="restore-error-alert"]');
      await expect(notice).toBeVisible({ timeout: 45_000 });
      await expect(notice).toHaveAttribute('data-testid', 'backup-notice-none');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a found backup is offered in a translated dialog and restored', async ({ browser }) => {
    const NICKNAME = 'BackupOutcomeHero';

    // Device A: a profile with no avatar is backfilled on mount, which saves a backup at once.
    const a = await browser.newContext({ baseURL: BASE_URL });
    await suppressErrorOverlay(a);
    const pageA = await a.newPage();
    const b = await freshPage(browser);
    try {
      await pageA.goto('/');
      await clearAppState(pageA);
      await pageA.evaluate((nickname) => {
        localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
      }, NICKNAME);
      await pageA.reload();

      // Wait for that backup to land BEFORE any full navigation — a page load
      // would abort the in-flight publish.
      await expect
        .poll(
          () =>
            pageA.evaluate(
              () => JSON.parse(localStorage.getItem('lp_nostrIdentity_v1') || '{}').pubkeyHex as string | undefined,
            ),
          { timeout: 30_000 },
        )
        .toBeTruthy();
      const pubkeyA = await pageA.evaluate(
        () => JSON.parse(localStorage.getItem('lp_nostrIdentity_v1') || '{}').pubkeyHex as string,
      );
      await expect
        .poll(async () => (await queryRelayForEvents(pageA, { kinds: [30078], authors: [pubkeyA] })).length, {
          timeout: 90_000,
        })
        .toBeGreaterThan(0);

      await pageA.goto('/settings/');
      await openAdvancedSettings(pageA);
      await expect(pageA.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });
      await pageA.getByTestId('generate-backup-phrase-btn').click();
      await expect(pageA.getByTestId('mnemonic-display')).toBeVisible({ timeout: 10_000 });
      const mnemonic = (await pageA.getByTestId('mnemonic-display').textContent())!.trim();

      // Device B recovers the identity.
      await recoverIdentity(b.page, mnemonic);

      const dialog = b.page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 45_000 });
      await expect(dialog.getByText('Restore from backup?')).toBeVisible();
      await expect(dialog.getByText('nothing on this device is deleted')).toBeVisible();

      await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

      await expect
        .poll(
          () =>
            b.page.evaluate(() => ({
              nickname: JSON.parse(localStorage.getItem('lp_userProfile_v1') || '{}').nickname,
              pending: localStorage.getItem('lp_backupRestorePending_v1'),
            })),
          { timeout: 30_000 },
        )
        .toEqual({ nickname: NICKNAME, pending: null });
    } finally {
      await a.close();
      await b.context.close();
    }
  });
});
