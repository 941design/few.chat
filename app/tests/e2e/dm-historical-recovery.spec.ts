/**
 * E2E: DM historical recovery — AC-13
 *
 * Bob sends 5 gift-wrapped DMs to Alice while Alice is OFFLINE (her page is
 * closed), then verifies that opening the DM chat recovers all 5 from the relay
 * in created_at order with no duplicates.
 *
 * This exercises the §3.5 order-of-operations:
 *   Step 1: loadMessages (0 pre-existing messages)
 *   Step 2: render immediately (empty)
 *   Step 3: fire kind-4 historical fetch
 *   Step 4: fire kind-1059 historical fetch in parallel with #3
 *   Step 5: wait for both → upsertMessages → rendered list is in createdAt order
 *
 * Setup order (walled-garden compatible):
 *   1. Boot Alice and Bob on /groups/.
 *   2. Alice creates a group and invites Bob (walled-garden prerequisite).
 *   3. Alice goes offline (page closed); Bob sends 5 DMs THROUGH THE APP — his
 *      own `__fewPublishDm` bridge (publishDirectMessage with his real signer and
 *      NDK) — at least 1 s apart so each rumor has its own created_at second.
 *   4. Alice comes back, opens Bob's DM chat and waits for all 5 to render.
 *
 * No event is hand-signed or sent via raw WebSocket from the test process
 * (project CLAUDE.md "E2E tests"; this spec used to seed back-dated wraps that
 * way — "historical" only needs the messages to be on the relay before the chat
 * mounts, which an offline recipient gives us through the real publish path).
 *
 * Keypairs: alice (USER_A), bob (USER_C) from helpers/auth-helpers.ts.
 * Requires the strfry relay harness: make e2e-up.
 * Run: node scripts/run-e2e.mjs tests/e2e/dm-historical-recovery.spec.ts
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';

// USER_B is configured as the maintainer in the e2e test environment
// (NEXT_PUBLIC_MAINTAINER_NPUBS in run-e2e.mjs). Navigating to
// /contacts?id=<maintainer> redirects to /feedback (spec §2.7), which breaks
// this test's DM chat assertions. Use USER_C as the DM peer instead.
const USER_B = USER_C;
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/**
 * Bob sends 5 DMs to Alice through the app's own publish path (his page's
 * `__fewPublishDm` bridge → publishDirectMessage → NIP-17 gift wrap via NDK).
 * Sends are spaced > 1 s apart so the rumors' created_at (whole seconds) are
 * strictly increasing — the order the recipient's chat must reproduce.
 * Returns a run-unique tag used to filter these messages out of relay history.
 */
async function sendDMsViaApp(bobPage: Page, alicePubHex: string): Promise<{ runTag: string }> {
  const runTag = `hist-test-${Date.now()}`;
  const labels = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
  const messages = labels.map((label, i) =>
    `${label} msg [${runTag}]${i === 0 ? ' — oldest' : i === 4 ? ' — newest' : ''}`,
  );

  await bobPage.waitForFunction(
    () => typeof (window as any).__fewPublishDm === 'function',
    null,
    { timeout: 10_000 },
  );
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await bobPage.waitForTimeout(1_100);
    await bobPage.evaluate(
      async ({ peer, content }) => {
        await (window as any).__fewPublishDm(peer, content);
      },
      { peer: alicePubHex, content: messages[i] },
    );
  }

  return { runTag };
}

/**
 * Wait for the contact chat to render N message bubbles.
 */
async function waitForMessagesRendered(page: Page, minCount: number, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    (min) => document.querySelectorAll('[data-testid^="msg-"]').length >= min,
    minCount,
    { timeout: timeoutMs },
  );
  // Extra buffer: let the upsert settle
  await page.waitForTimeout(1000);
}

/**
 * Boot a user in a fresh context and navigate to /groups/ (needed for MLS setup).
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

test.describe.serial('DM historical recovery — AC-13', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUserOnGroups(browser, USER_A, 'alice-hist'));
    ({ context: bobCtx, page: bobPage } = await bootUserOnGroups(browser, USER_B, 'bob-hist'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Alice and Bob establish a shared MLS group (walled-garden prerequisite)', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, 'AC-13 History Test Group');
  });

  test('alice recovers 5 historical gift-wrapped DMs in created_at order with no duplicates (AC-13)', async () => {
    const alicePub = USER_A.pubkeyHex;
    const bobPub = USER_B.pubkeyHex;

    // 1. Alice goes offline: close her page (the context — her identity and
    //    stored state — survives). Nothing of Alice's runs while Bob sends.
    await alicePage.close();

    // 2. Bob sends 5 DMs through the app while Alice is offline.
    //    Returns a unique runTag to isolate THIS run's messages from relay history.
    const { runTag } = await sendDMsViaApp(bobPage, alicePub);

    // 3. Alice comes back and opens Bob's chat. She was offline for every send,
    //    so all 5 messages can only come from the relay. (Do not assert an empty
    //    local thread here: the app's boot-time DM catch-up may already have
    //    stored some of them by then — still recovered from the relay, and the
    //    dedup check below covers both ingestion paths meeting.)
    alicePage = await aliceCtx.newPage();
    await alicePage.goto(`/contacts?id=${bobPub}`);

    // 4. Wait for all 5 run-tagged messages to render (historical fetch resolves after mount).
    await alicePage.waitForFunction(
      (tag) => {
        const bubbles = document.querySelectorAll('[data-testid^="msg-"]');
        let taggedCount = 0;
        bubbles.forEach((b) => {
          if (b.textContent?.includes(tag)) taggedCount++;
        });
        return taggedCount >= 5;
      },
      runTag,
      { timeout: 30_000 },
    );
    await alicePage.waitForTimeout(1000); // let upsert settle

    // 5. Assert exactly 5 run-tagged messages rendered (no duplicates).
    const allTexts = await alicePage.locator('[data-testid^="msg-"]').allTextContents();
    const seededTexts = allTexts.filter((t) => t.includes(runTag));
    expect(seededTexts.length).toBe(5);

    // 6. Assert messages are in created_at order (oldest → newest, top → bottom).
    //    Labels: 'First msg [runTag]', 'Second msg [runTag]', etc.
    const orderedIndices = seededTexts.map((t) => {
      if (t.includes('First')) return 0;
      if (t.includes('Second')) return 1;
      if (t.includes('Third')) return 2;
      if (t.includes('Fourth')) return 3;
      if (t.includes('Fifth')) return 4;
      return -1;
    });
    // DOM order matches created_at (= send) order exactly.
    expect(orderedIndices).toEqual([0, 1, 2, 3, 4]);

    // 7. Re-open the chat to verify dedup — run-tagged message count must not double.
    const seededCountBefore = seededTexts.length;
    await alicePage.goto('/contacts');
    await alicePage.waitForTimeout(500);
    await alicePage.goto(`/contacts?id=${bobPub}`);
    // Wait for the run-tagged messages to re-appear
    await alicePage.waitForFunction(
      (tag) => {
        const bubbles = document.querySelectorAll('[data-testid^="msg-"]');
        let taggedCount = 0;
        bubbles.forEach((b) => { if (b.textContent?.includes(tag)) taggedCount++; });
        return taggedCount >= 5;
      },
      runTag,
      { timeout: 15_000 },
    );
    await alicePage.waitForTimeout(1000);
    const afterTexts = await alicePage.locator('[data-testid^="msg-"]').allTextContents();
    const seededAfter = afterTexts.filter((t) => t.includes(runTag));
    expect(seededAfter.length).toBe(seededCountBefore);
  });
});
