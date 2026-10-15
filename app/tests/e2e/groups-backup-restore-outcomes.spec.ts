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

const BACKUP_KIND = 30078;
const BACKUP_BUDGET_MS = 90_000;
/** A kick needs headroom to reload and publish; don't start one closer to the deadline. */
const MIN_KICK_HEADROOM_MS = 10_000;

/**
 * A logged *failed* backup attempt: the app's `[Backup…]` warnings that contain
 * "failed" — `[Backup] relay connection failed`, `[Backup] publish failed`,
 * `[Backup] relay backup lookup failed`, `[BackupScheduler] publish failed`
 * (BackupContext.tsx, lib/backup/relayBackup.ts). `relay backup unusable` is
 * NOT a failed attempt.
 */
function isFailedBackupAttempt(line: string): boolean {
  const text = line.replace(/^\w+: /, ''); // strip the "<msg.type()>: " prefix
  return text.startsWith('[Backup') && text.includes('failed');
}

/**
 * Wait (up to BACKUP_BUDGET_MS) until the app's own backup of `pubkeyHex` is on
 * the relay. The relay is only ever read here; the backup is always published
 * by the app.
 *
 * Kick = restart the backup scheduler after an OBSERVED transient failure. The
 * first backup fires at cold start (avatar backfill on mount →
 * `markBackupDirty(true)`). Under full-suite load one attempt can fail on the
 * app's tight relay timeouts, and the scheduler then retries after 30 s, then
 * 2 min — two failures overrun the budget (bug: groups-e2e-suite-flaky-under-
 * shared). While a retry is pending the scheduler deliberately swallows new
 * marks (no backoff bypass), so an in-page trigger cannot help; only a fresh
 * page load gets a fresh scheduler. So as soon as a failed attempt has been
 * logged since the last kick (after a logged failure nothing is in flight), the
 * kick re-seeds the avatar-less profile (same nickname) and reloads, and the
 * app's real mount-time backfill marks the backup dirty again — queued until
 * the new scheduler starts, so it cannot race the provider mount.
 *
 * A publish the app never attempted (no failure logged) is NOT kicked: it must
 * fail the test, since that is a product regression, not relay flakiness.
 */
async function waitForOwnBackupOnRelay(
  page: Page,
  pubkeyHex: string,
  nickname: string,
  backupLogs: string[],
  // Index of the first log line written by the identity under test: lines
  // logged before its setup reload (throwaway pre-clearAppState identity) must
  // not count as its failed attempts, or they could trigger a kick that masks
  // a stall of the target's own first attempt.
  firstTargetLog: number,
): Promise<void> {
  const deadline = Date.now() + BACKUP_BUDGET_MS;
  let seenLogs = firstTargetLog;
  let failedAttempts = 0;
  let failuresSinceKick = 0;
  let kicks = 0;
  while (Date.now() < deadline) {
    const found = await queryRelayForEvents(page, { kinds: [BACKUP_KIND], authors: [pubkeyHex] })
      .then((events) => events.length)
      .catch(() => 0);
    if (found > 0) return;
    for (; seenLogs < backupLogs.length; seenLogs++) {
      if (isFailedBackupAttempt(backupLogs[seenLogs])) {
        failedAttempts++;
        failuresSinceKick++;
      }
    }
    if (failuresSinceKick > 0 && deadline - Date.now() > MIN_KICK_HEADROOM_MS) {
      await page.evaluate((nick) => {
        localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
      }, nickname);
      await page.reload();
      failuresSinceKick = 0;
      kicks++;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(
    `No kind-${BACKUP_KIND} backup for ${pubkeyHex} on the relay after ${BACKUP_BUDGET_MS / 1000}s ` +
      `(${failedAttempts} failed attempt(s) observed, ${kicks} kick(s) performed). ` +
      `App backup log:\n${backupLogs.join('\n') || '(none)'}`,
  );
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
    // Cheap evidence if the backup never lands: the app's own [Backup] warnings.
    const backupLogs: string[] = [];
    pageA.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Backup')) backupLogs.push(`${msg.type()}: ${text}`);
    });
    const b = await freshPage(browser);
    try {
      await pageA.goto('/');
      // Let the FIRST page finish its own init (profile avatar backfill + identity)
      // before seeding. Otherwise a seed landing before ProfileProvider mounts is
      // consumed by that page: it backfills + marks backup dirty with no scheduler
      // yet, and the reload below discards the mark -> no backup is ever attempted.
      // Once both keys exist the first page has nothing left to write, so the
      // RELOADED page is the one that backfills the seeded avatar-less profile.
      await expect
        .poll(
          () =>
            pageA.evaluate(() => {
              try {
                const p = JSON.parse(localStorage.getItem('lp_userProfile_v1') || '{}');
                const id = JSON.parse(localStorage.getItem('lp_nostrIdentity_v1') || '{}');
                return Boolean(p.avatar && id.pubkeyHex);
              } catch {
                return false;
              }
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      await clearAppState(pageA);
      await pageA.evaluate((nickname) => {
        localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
      }, NICKNAME);
      const firstTargetLog = backupLogs.length;
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
      await waitForOwnBackupOnRelay(pageA, pubkeyA, NICKNAME, backupLogs, firstTargetLog);

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
