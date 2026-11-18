import { nip19 } from 'nostr-tools';
import { test, expect, type Browser } from '@playwright/test';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';
import { queryRelayForEvents } from './helpers/relay-query';
import { waitForProfileBackup } from './helpers/profile-backup';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
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

  test('seed phrase restores settings and profile without groups, then rejoins by invitation', async ({ browser }) => {
    test.setTimeout(300_000);
    await recoveryRoundTrip(browser, 'Phrase');
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
