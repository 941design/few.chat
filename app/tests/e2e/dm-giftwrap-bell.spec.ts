/**
 * E2E: DM gift-wrapped notification — AC-22
 *
 * Two-context scenario (Alice = recipient with closed chat, Bob = sender).
 *
 *   1. Alice and Bob boot on /groups/ and establish a shared MLS group
 *      (required by the DM walled-garden gate).
 *   2. Alice navigates to /contacts — the unread watcher is mounted.
 *   3. Bob calls window.__fewPublishDm to send a NIP-17 gift-wrapped DM to Alice.
 *   4. Assert Alice's Contacts-domain nav pill becomes ≥ 1 without Alice ever
 *      opening the chat (a DM is a Contacts-domain event).
 *   5. Alice navigates to the DM thread → message renders.
 *
 * This exercises the full relay → NDK subscription → unread watcher subscription
 * (kind-1059 branch) → Contacts nav pill pipeline end-to-end. (The old flat
 * notification bell was removed; a DM now surfaces on the `contacts-nav-badge`
 * count pill instead.)
 *
 * Uses deterministic alice/bob keypairs from helpers/auth-helpers.ts.
 * Requires the strfry relay harness: make e2e-up.
 * Run: node scripts/run-e2e.mjs tests/e2e/dm-giftwrap-bell.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';

// USER_B is configured as the maintainer in the e2e test environment
// (NEXT_PUBLIC_MAINTAINER_NPUBS in run-e2e.mjs). Navigating to
// /contacts?id=<maintainer> redirects to /feedback (spec §2.7), which breaks
// this test's DM chat assertions. Use USER_C as the DM peer instead.
const USER_B = USER_C;
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function waitForBridge(page: Page) {
  await page.waitForFunction(
    () => !!(window as any).__fewUnread,
    null,
    { timeout: 10_000 },
  );
}

/**
 * Boot a user in a fresh Playwright context, navigating to /groups/ so the
 * full app bundle (including unreadStore + __fewPublishDm bridge) is loaded.
 */
async function bootUserOnGroups(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

test.describe.serial('DM gift-wrapped notification — AC-22', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUserOnGroups(browser, USER_A, 'alice-test'));
    ({ context: bobCtx, page: bobPage } = await bootUserOnGroups(browser, USER_B, 'bob-test'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Alice and Bob establish a shared MLS group (walled-garden prerequisite)', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, 'AC-22 Bell Test Group');
  });

  test(
    'AC-22: alice receives a NIP-17 gift-wrapped DM from bob; Contacts nav pill increments; '
    + 'opening the chat renders the message',
    async () => {
      const RUMOR_CONTENT = `hello-from-bob-giftwrap-${Date.now()}`;

      // ── 1. Alice navigates to /contacts to mount the unread watcher ─────────
      await alicePage.goto('/contacts');
      await alicePage.waitForLoadState('networkidle');
      await waitForBridge(alicePage);
      await dismissErrorOverlay(alicePage);

      // Record baseline Contacts nav-pill count (may be > 0 from group setup).
      // A DM is a Contacts-domain event, so it surfaces on `contacts-nav-badge`.
      const initialBadgeCount = await alicePage.evaluate(() => {
        const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
        if (!badge) return 0;
        return parseInt((badge.textContent ?? '0').trim(), 10);
      });

      // ── 2. Bob sends a NIP-17 gift-wrapped DM via the __fewPublishDm bridge ─
      await bobPage.waitForFunction(
        () => typeof (window as any).__fewPublishDm === 'function',
        null,
        { timeout: 10_000 },
      );
      await bobPage.evaluate(
        async ({ alicePub, content }) => {
          await (window as any).__fewPublishDm(alicePub, content);
        },
        { alicePub: USER_A.pubkeyHex, content: RUMOR_CONTENT },
      );

      // ── 3. Wait for Alice's Contacts nav pill to increment above baseline ─────
      await alicePage.waitForFunction(
        (baseline) => {
          const badge = document.querySelector('[data-testid="contacts-nav-badge"]');
          if (!badge) return false;
          const count = parseInt((badge.textContent ?? '0').trim(), 10);
          return count > baseline;
        },
        initialBadgeCount,
        { timeout: 30_000 },
      );

      // ── 4. Alice navigates to the DM chat and the message renders ─────────────
      await alicePage.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await alicePage.waitForLoadState('networkidle');

      const bubble = alicePage.locator('[data-testid^="msg-"]').filter({ hasText: RUMOR_CONTENT }).first();
      await expect(bubble).toBeVisible({ timeout: 30_000 });
    },
  );
});
