/**
 * E2E: Pull-only invitation accept flow (AC-TEST-1, epic: inline-invitation-cards S2)
 *
 * Alice (USER_A) creates a group and invites Bob (USER_B) by npub.
 * Bob sees an INLINE invitation card on /groups/ (invitation-card-<id>, showing
 * the group name + invitation badge + "Invited by" attribution — NOT a bare
 * pending row, NOT a joined group-card) and clicks Accept.
 * After accepting:
 *   a. The invitation card is gone and the group appears as a normal joined
 *      group-card in Bob's list.
 *   b. Alice DMs Bob via publishDirectMessage.
 *   c. Bob's notification bell increments.
 *   d. The message renders in Bob's DM thread with Alice.
 *
 * No raw WebSocket relay writes — all publishes go through the app's bridges.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Pull-Only Accept Test Group';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

test.describe.serial('Pull-only invitation: Accept (AC-TEST-1)', () => {
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

  test('Alice creates a group and invites Bob', async () => {
    // Walled Garden v2: warm up Bob's seen-set with stale wraps from prior
    // tests, then clear the queue so the fresh invite is the entry to accept.
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => {
      localStorage.removeItem('lp_pendingInvitations_v1');
    });

    await alicePage.getByTestId('create-group-btn').click();
    await expect(alicePage.getByTestId('create-group-modal-content')).toBeVisible();
    await alicePage.getByTestId('create-group-name-input').fill(GROUP_NAME);
    await alicePage.getByTestId('create-group-submit-btn').click();
    await expect(alicePage.getByText(GROUP_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(alicePage);
    await alicePage.waitForTimeout(3_000);

    await alicePage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await alicePage.waitForTimeout(3_000);
  });

  test('Bob sees an inline invitation card (name + badge + Invited by), taps to preview, and clicks Accept', async () => {
    // Bob waits for the Welcome to arrive over the relay
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');

    // AC-TEST-1 / AC-CARD-1: Bob sees an inline invitation CARD (not a bare
    // pending row) pinned at the top of the list, before the group is accepted.
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]').last();
    await expect(invitationCard).toBeVisible({ timeout: 30_000 });

    // The card shows the real, pre-join-decoded group name, an invitation
    // badge, and "Invited by" attribution — not a bare pending row.
    await expect(invitationCard.getByText(GROUP_NAME)).toBeVisible();
    await expect(invitationCard.getByText('Invitation')).toBeVisible();
    await expect(invitationCard.getByText(/Invited by/)).toBeVisible();

    // Confirm the group is NOT yet a joined group-card (invitation not yet
    // accepted) — the group name shown above is the invitation card's own
    // text, distinct from a `group-card-*` element.
    await expect(bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME })).toHaveCount(0);

    // AC-CARD-4: tapping the card body (outside Accept/Decline) navigates to
    // the read-only preview route. S2 only wires the link — the preview VIEW
    // itself ships in a later story, so today this falls through to the
    // plain groups list without crashing. Assert the URL carries the invite
    // id (trailing-slash-safe, unanchored per the static-export URL idiom),
    // then return to /groups/ to continue the accept flow.
    await invitationCard.click();
    await expect(bobPage).toHaveURL(/invite=/, { timeout: 15_000 });
    await bobPage.goto('/groups/');
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 30_000 });

    // AC-TEST-1 / AC-CARD-5: Bob clicks Accept (pick the most recent so we
    // don't grab a stale invitation from earlier specs in the same suite run).
    await bobPage.locator('[data-testid^="accept-invitation-"]').last().click();

    // AC-TEST-1 / AC-CARD-5: after accepting, the invitation card is gone and
    // the group appears as a normal joined group-card in Bob's list.
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_NAME })).toHaveCount(0);
  });

  test('Alice DMs Bob; Bob Contacts pill increments and message renders', async () => {
    // Bob navigates to /contacts so the unread watcher mounts (a DM is a
    // Contacts-domain event, surfacing on `contacts-nav-badge`)
    await bobPage.goto('/contacts');
    await bobPage.waitForLoadState('networkidle');
    await bobPage.waitForFunction(
      () => !!(window as any).__fewUnread,
      null,
      { timeout: 15_000 },
    );

    const initialBadgeCount = await bobPage.evaluate(() => {
      const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
      if (!badge) return 0;
      return parseInt((badge.textContent ?? '0').trim(), 10);
    });

    // Regression coverage (kept from the pre-S2 spec): Alice DMs Bob via the app bridge (not raw WebSocket)
    const DM_CONTENT = `accept-test-dm-${Date.now()}`;
    await alicePage.waitForFunction(
      () => typeof (window as any).__fewPublishDm === 'function',
      null,
      { timeout: 15_000 },
    );
    await alicePage.evaluate(
      async ({ bobPub, content }) => {
        await (window as any).__fewPublishDm(bobPub, content);
      },
      { bobPub: USER_B.pubkeyHex, content: DM_CONTENT },
    );

    // Bob's Contacts pill increments above the baseline
    await bobPage.waitForFunction(
      (baseline) => {
        const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
        if (!badge) return false;
        return parseInt((badge.textContent ?? '0').trim(), 10) > baseline;
      },
      initialBadgeCount,
      { timeout: 60_000 },
    );

    // message renders in Bob's DM thread with Alice
    await bobPage.goto(`/contacts?id=${USER_A.pubkeyHex}`);
    await bobPage.waitForLoadState('networkidle');
    const bubble = bobPage.locator('[data-testid^="msg-"]').filter({ hasText: DM_CONTENT }).first();
    await expect(bubble).toBeVisible({ timeout: 30_000 });
  });
});
