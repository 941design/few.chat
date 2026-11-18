/** Reload after the real sink has persisted, but before it dispatches, a chat and profile rumor. */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { pausePersistedRumor, waitForPersistedRumor, waitForHistoryDispatch, withHistorySweepOnly } from './helpers/session-cutover';
import { createGroup, inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // Re-seed the profile AFTER clearAppState (see e2e_profile_seed_clearstate_race).
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  return { context, page };
}

test.describe.serial('Reload right as a peer rumor arrives', () => {
  test.setTimeout(300_000);
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('chat message and profile update survive a reload during ingest', async () => {
    const stamp = Date.now();
    const groupName = `Rumor Reload ${stamp}`;

    // Bob's welcome subscription live first; drain stale relay gift wraps.
    await bobPage.goto('/groups/');
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => localStorage.removeItem('lp_pendingInvitations_v1'));

    await alicePage.goto('/groups/');
    await createGroup(alicePage, groupName);
    await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 90_000 });
    await dismissErrorOverlay(alicePage);
    await alicePage.locator('[data-testid="invite-member-modal-content"] button[aria-label="Close"]').click().catch(() => {});

    await acceptInvitationAndWaitJoined(bobPage, groupName);
    await bobPage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(bobPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice knows Bob (join profile) before the reload experiments start.
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(alicePage.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', { timeout: 90_000 });
    // Let the join-time traffic (profiles, announcements) settle so the armed
    // waiter catches Bob's chat event, not a straggler.
    await alicePage.waitForTimeout(5_000);

    // ── (1) chat message ────────────────────────────────────────────────
    const text = `reload-during-ingest ${stamp}`;
    const groupId = new URL(alicePage.url()).searchParams.get('id');
    expect(groupId).toBeTruthy();
    await pausePersistedRumor(alicePage, groupId!, text, 's25-chat-persisted');
    await bobPage.getByTestId('chat-input').fill(text);
    await bobPage.getByTestId('chat-send-btn').click();
    const chatRumorId = await waitForPersistedRumor(alicePage, 's25-chat-persisted');
    expect(chatRumorId).toBeTruthy();
    await expect(alicePage.getByText(text, { exact: true })).toHaveCount(0);
    await withHistorySweepOnly(alicePage, groupId!, () => waitForHistoryDispatch(alicePage, USER_A.pubkeyHex, groupId!, chatRumorId));

    const bubble = alicePage.locator('[data-testid^="msg-"]', { hasText: text });
    await expect(bubble).toBeVisible({ timeout: 90_000 });
    await expect(bubble).toContainText('Bob');
    await expect(bubble).toHaveCount(1);

    // ── (2) profile update ──────────────────────────────────────────────
    const newName = `Bobby${String(stamp).slice(-5)}`;
    await pausePersistedRumor(alicePage, groupId!, newName, 's25-profile-persisted');
    await bobPage.goto('/profile');
    await bobPage.getByTestId('profile-nickname-input').clear();
    await bobPage.getByTestId('profile-nickname-input').fill(newName);
    await expect(bobPage.getByTestId('profile-nickname-input')).toHaveValue(newName);
    await bobPage.getByTestId('profile-nickname-input').blur();
    const profileRumorId = await waitForPersistedRumor(alicePage, 's25-profile-persisted');
    expect(profileRumorId).toBeTruthy();
    await withHistorySweepOnly(alicePage, groupId!, () => waitForHistoryDispatch(alicePage, USER_A.pubkeyHex, groupId!, profileRumorId));

    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 60_000 });
    await expect(alicePage.getByTestId(`member-name-${bobPrefix}`)).toHaveText(newName, { timeout: 90_000 });
  });
});
