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

import { nip19 } from 'nostr-tools';
import { test, expect, type Browser, BrowserContext, Page } from '@playwright/test';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { randomBytes } from 'node:crypto';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { openAdvancedSettings } from './helpers/settings';
import { queryRelayForEvents } from './helpers/relay-query';
import { waitForProfileBackup } from './helpers/profile-backup';
import { createGroup, inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

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

  test('a found backup is offered and restores settings and profile, with rejoin by invitation', async ({ browser }) => {
    test.setTimeout(300_000);
    await recoveryRoundTrip(browser, 'Outcome');
  });
});

/** Exercise a real encrypted relay backup and a fresh invitation after recovery (D5). */
async function recoveryRoundTrip(browser: Browser, label: string): Promise<void> {
  const owner = await browser.newContext({ baseURL: BASE_URL });
  const sponsor = await browser.newContext({ baseURL: BASE_URL });
  const restored = await browser.newContext({ baseURL: BASE_URL });
  await Promise.all([owner, sponsor, restored].map(suppressErrorOverlay));
  const a = await owner.newPage();
  const b = await sponsor.newPage();
  const c = await restored.newPage();
  const name = `Recovery ${label} ${Date.now()}`;
  const nickname = `Backup ${label} after join`;
  try {
    await a.goto('/settings/');
    await a.getByTestId('theme-spring-btn').click();
    await expect(a.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');
    await openAdvancedSettings(a);
    await expect(a.getByTestId('identity-npub-display')).toBeVisible({ timeout: 30_000 });
    const displayedNpub = (await a.getByTestId('identity-npub-display').innerText()).trim();
    const pubkey = await a.evaluate(() => JSON.parse(localStorage.getItem('lp_nostrIdentity_v1')!).pubkeyHex as string);
    const npub = nip19.npubEncode(pubkey);
    await a.getByTestId('generate-backup-phrase-btn').click();
    const phrase = (await a.getByTestId('mnemonic-display').innerText()).trim();
    expect(phrase.split(/\s+/)).toHaveLength(12);
    await a.getByTestId('backup-confirm-checkbox').check();
    await a.getByTestId('backup-done-btn').click();
    await expect(a.getByTestId('mnemonic-display')).not.toBeVisible();

    await a.goto('/profile/');
    const profile = a.getByTestId('profile-nickname-input');
    await profile.fill(`Backup ${label} before join`);
    await profile.blur();
    await expect(profile).toHaveValue(`Backup ${label} before join`);
    // A reload restarts the scheduler with its persisted dirty mark. Only a
    // successful publish clears that mark; query the relay as independent proof.
    await a.reload();
    await expect.poll(() => a.evaluate(() => localStorage.getItem('few-backup-dirty')), { timeout: 90_000 }).toBeNull();
    await expect.poll(async () => (await queryRelayForEvents(a, { kinds: [30078], authors: [pubkey] })).length, { timeout: 30_000 }).toBeGreaterThan(0);

    await a.goto('/groups/');
    await b.goto('/groups/');
    await createGroup(b, name);
    await b.locator('[data-testid^="group-card-"]', { hasText: name }).first().click();
    await inviteContactViaPicker(b, npub);
    await expect(b.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(a, name);
    const member = pubkey.slice(0, 8);
    await expect(b.getByTestId(`member-item-${member}`)).toBeVisible({ timeout: 60_000 });
    await expect(b.getByTestId(`member-pending-${member}`)).not.toBeVisible({ timeout: 90_000 });
    // Force a distinguishable snapshot after joining. The relay stores kind 30078
    // as replaceable, so require a newer event rather than merely any backup.
    const previous = (await queryRelayForEvents(a, { kinds: [30078], authors: [pubkey] }))
      .find((event) => event.tags.some(([key, value]) => key === 'd' && value === 'few'));
    expect(previous).toBeTruthy();
    await expect.poll(() => Math.floor(Date.now() / 1000), { timeout: 10_000 }).toBeGreaterThan(previous!.created_at);
    await a.goto('/profile/');
    const joinedProfile = a.getByTestId('profile-nickname-input');
    await joinedProfile.fill(nickname);
    await joinedProfile.blur();
    await expect(joinedProfile).toHaveValue(nickname);
    // The dirty marker is durable. A reload starts a fresh scheduler without
    // waiting out the previous device session's five-minute debounce window.
    await a.reload();
    await waitForProfileBackup(a, pubkey, nickname, previous!.created_at);
    // Close the original device before restoring.
    await owner.close();

    await c.goto('/settings/');
    await openAdvancedSettings(c);
    await c.getByTestId('restore-phrase-input').fill(phrase);
    await c.getByTestId('restore-identity-btn').click();
    const dialog = c.getByRole('dialog');
    await expect(dialog.getByText('Restore from backup?')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText('A backup of your settings and profile was found.', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => c.evaluate(() => ({
      profile: JSON.parse(localStorage.getItem('lp_userProfile_v1') || '{}').nickname,
      theme: JSON.parse(localStorage.getItem('lp_settings_v1') || '{}').theme,
      pending: localStorage.getItem('lp_backupRestorePending_v1'),
      pubkey: JSON.parse(localStorage.getItem('lp_nostrIdentity_v1') || '{}').pubkeyHex,
    })), { timeout: 60_000 }).toEqual({ profile: nickname, theme: 'spring', pending: null, pubkey });
    await c.goto('/settings/');
    await expect(c.getByTestId('theme-spring-btn')).toHaveAttribute('aria-pressed', 'true');
    await openAdvancedSettings(c);
    await expect(c.getByTestId('identity-npub-display')).toHaveText(displayedNpub);
    await c.goto('/profile/');
    await expect(c.getByTestId('profile-nickname-input')).toHaveValue(nickname);
    await c.goto('/groups/');
    await expect(c.getByTestId('groups-empty-state')).toBeVisible({ timeout: 60_000 });
    await expect(c.locator('[data-testid^="group-card-"]')).toHaveCount(0);

    // The recovered key still occupies its old MLS seat. Remove that seat on
    // the sponsor before sending a new Welcome to the recovered account.
    await b.keyboard.press('Escape');
    await b.getByTestId(`remove-member-${member}`).click();
    await b.getByTestId(`remove-member-confirm-${member}`).click();
    await expect(b.getByTestId(`member-item-${member}`)).toHaveCount(0, { timeout: 60_000 });
    await inviteContactViaPicker(b, npub);
    await expect(b.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(c, name);
    await c.locator('[data-testid^="group-card-"]', { hasText: name }).first().click();
    await expect(c.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
  } finally {
    await Promise.all([owner.close(), sponsor.close(), restored.close()]);
  }
}
