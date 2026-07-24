/**
 * E2E: Ever-known peer survives group leave (AC-TEST-7)
 *
 * Alice (USER_A) and Bob (USER_B) complete a pull-only group join (Alice invites,
 * Bob accepts). Alice DMs Bob — message lands. Alice then leaves the group.
 * After membership change settles:
 *   a. Alice DMs Bob again.
 *   b. Bob's Contacts nav pill increments (a DM is a Contacts-domain event).
 *   c. The message renders in Bob's DM thread (Alice is in knownPeers, not just groups).
 *   d. Bob's contact list still contains Alice.
 *   e. Bob's IDB DM thread with Alice still exists.
 *
 * This verifies AC-SEC-15: once a peer enters lp_knownPeers_v1 via group membership
 * they remain allowed as DM senders even after every shared group is left.
 *
 * No raw WebSocket relay writes — all publishes go through the app's bridges.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { readIdbRecord } from './helpers/idb-record';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Ever-Known Survives Leave Group';

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

test.describe.serial('Ever-known peer survives group leave (AC-TEST-7)', () => {
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
    // Walled Garden v2 pull-only flow: let Bob's welcome subscription consume
    // any stale gift wraps left in the relay from prior runs (populates the
    // seen-set), then clear only the pending-invitations queue so Alice's
    // fresh invite below is the sole entry Bob has to accept.
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

  test('Bob accepts the invitation (pull-only flow)', async () => {
    // Wait for the Welcome to arrive
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');

    // See the pending invitation and Accept it
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(bobPage.locator('[data-testid^="pending-invitation-row-"]').first()).toBeVisible({ timeout: 30_000 });
    await bobPage.locator('[data-testid^="accept-invitation-"]').first().click();

    // Group card should appear after acceptance
    await expect(bobPage.getByText(GROUP_NAME)).toBeVisible({ timeout: 90_000 });
  });

  test('Alice DMs Bob; message lands (baseline — both in group)', async () => {
    // Bob navigates to /contacts to mount the unread watcher
    await bobPage.goto('/contacts');
    await bobPage.waitForLoadState('networkidle');
    await bobPage.waitForFunction(
      () => !!(window as any).__fewUnread,
      null,
      { timeout: 15_000 },
    );

    const baselineBadge = await bobPage.evaluate(() => {
      const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
      if (!badge) return 0;
      return parseInt((badge.textContent ?? '0').trim(), 10);
    });

    const DM_CONTENT_1 = `survive-leave-dm1-${Date.now()}`;
    await alicePage.waitForFunction(
      () => typeof (window as any).__fewPublishDm === 'function',
      null,
      { timeout: 15_000 },
    );
    await alicePage.evaluate(
      async ({ bobPub, content }) => {
        await (window as any).__fewPublishDm(bobPub, content);
      },
      { bobPub: USER_B.pubkeyHex, content: DM_CONTENT_1 },
    );

    await bobPage.waitForFunction(
      (baseline) => {
        const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
        if (!badge) return false;
        return parseInt((badge.textContent ?? '0').trim(), 10) > baseline;
      },
      baselineBadge,
      { timeout: 60_000 },
    );

    await bobPage.goto(`/contacts?id=${USER_A.pubkeyHex}`);
    await bobPage.waitForLoadState('networkidle');
    const bubble1 = bobPage.locator('[data-testid^="msg-"]').filter({ hasText: DM_CONTENT_1 }).first();
    await expect(bubble1).toBeVisible({ timeout: 30_000 });
  });

  test('Alice leaves the group', async () => {
    await alicePage.goto('/groups/');
    await alicePage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice is the sole admin — promote Bob to admin first so the leave guard
    // allows the departure (isSoleAdmin returns false once Bob has admin role).
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await alicePage.getByTestId(`make-admin-${bobPrefix}`).click();
    await alicePage.getByTestId(`make-admin-confirm-${bobPrefix}`).click();
    // Wait for the admin badge to appear on Bob's row before proceeding
    await expect(alicePage.getByTestId(`admin-badge-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });

    await alicePage.getByTestId('leave-group-btn').click();
    await alicePage.getByTestId('leave-group-confirm-btn').click();
    await expect(alicePage.getByTestId('groups-empty-state')).toBeVisible({ timeout: 30_000 });
    // Give membership change time to propagate on the relay
    await alicePage.waitForTimeout(5_000);
  });

  test('AC-TEST-7(a-d): Alice DMs Bob after leaving; Contacts pill increments; message renders; contact retained', async () => {
    // This test sends a DM and waits for relay propagation + pill update (up to 60s),
    // so it needs more than the default 2-minute timeout.
    test.setTimeout(180_000);
    // Bob back on /contacts so the unread watcher is active
    await bobPage.goto('/contacts');
    await bobPage.waitForLoadState('networkidle');
    await bobPage.waitForFunction(
      () => !!(window as any).__fewUnread,
      null,
      { timeout: 15_000 },
    );

    const preLeaveBadge = await bobPage.evaluate(() => {
      const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
      if (!badge) return 0;
      return parseInt((badge.textContent ?? '0').trim(), 10);
    });

    // AC-TEST-7(a): Alice DMs Bob again after leaving the group
    const DM_CONTENT_2 = `survive-leave-dm2-${Date.now()}`;
    await alicePage.evaluate(
      async ({ bobPub, content }) => {
        await (window as any).__fewPublishDm(bobPub, content);
      },
      { bobPub: USER_B.pubkeyHex, content: DM_CONTENT_2 },
    );

    // AC-TEST-7(b): Bob's Contacts pill increments (Alice is in knownPeers — still allowed)
    await bobPage.waitForFunction(
      (baseline) => {
        const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
        if (!badge) return false;
        return parseInt((badge.textContent ?? '0').trim(), 10) > baseline;
      },
      preLeaveBadge,
      { timeout: 60_000 },
    );

    // AC-TEST-7(c): Message renders in Bob's DM thread with Alice
    await bobPage.goto(`/contacts?id=${USER_A.pubkeyHex}`);
    await bobPage.waitForLoadState('networkidle');
    const bubble2 = bobPage.locator('[data-testid^="msg-"]').filter({ hasText: DM_CONTENT_2 }).first();
    await expect(bubble2).toBeVisible({ timeout: 30_000 });

    // AC-TEST-7(d): Bob's contact list still contains Alice
    await bobPage.goto('/contacts/');
    await expect(bobPage.getByTestId('contacts-list')).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId(`contact-card-${USER_A.pubkeyHex}`)).toBeVisible();
  });

  test('AC-TEST-7(e): Bob IDB DM thread with Alice still exists after leave', async () => {
    const aliceThreadKey = `few:messages:dm:${USER_A.pubkeyHex.toLowerCase()}`;
    const threadData = await readIdbRecord(bobPage, 'keyval-store', 'keyval', aliceThreadKey);
    // The thread should still exist (not purged — Alice is a known peer)
    expect(threadData).not.toBeNull();
  });
});
