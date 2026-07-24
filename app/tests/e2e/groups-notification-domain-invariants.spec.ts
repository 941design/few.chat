/**
 * E2E: notification domain invariants (epic: notification-domain-invariants).
 *
 *   INV-1 (off-domain rings): a change event whose target entity is NOT the one
 *     currently open in a detail view MUST raise the domain's count pill.
 *   INV-2 (on-domain updates): a change event whose target entity IS the one
 *     currently open MUST NOT raise the pill; the open view updates instead.
 *
 * The old flat notification bell was removed and replaced by per-domain nav
 * count pills: a group event surfaces on `groups-nav-badge`, a DM on
 * `contacts-nav-badge`. This spec therefore measures each invariant against the
 * pill for the domain of the event under test.
 *
 * Granularity is per-entity: viewing group X suppresses only X's events; viewing
 * the DM thread with a peer suppresses only that peer's DMs. This spec drives the
 * REAL publish paths through the app (group chat via the group detail composer,
 * DMs via the __fewPublishDm bridge) — never raw relay writes.
 *
 * Requires the strfry relay harness (make e2e-up). Run:
 *   E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-notification-domain-invariants.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

// USER_B is the maintainer in the e2e env (navigating to its DM redirects to
// /feedback), so use USER_C as the peer — mirrors the other DM specs.
const USER_B = USER_C;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Domain Invariants Group';

async function waitForBridge(page: Page) {
  await page.waitForFunction(() => !!(window as any).__fewUnread, null, { timeout: 10_000 });
}

/**
 * Current numeric value of a domain nav count pill (0 when absent). Pass the
 * pill for the domain of the event under test — `groups-nav-badge` for group
 * events, `contacts-nav-badge` for DMs.
 */
async function badgeCount(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const badge = document.querySelector(`[data-testid="${id}"]`);
    if (!badge) return 0;
    return parseInt((badge.textContent ?? '0').trim(), 10) || 0;
  }, testId);
}

async function bootUserOnGroups(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  const seed = { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname };
  await context.addInitScript((s) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex: s.privateKeyHex, pubkeyHex: s.pubkeyHex, seedHex: s.seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: s.nickname, avatar: null }));
  }, seed);
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate((s) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex: s.privateKeyHex, pubkeyHex: s.pubkeyHex, seedHex: s.seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: s.nickname, avatar: null }));
  }, seed);
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function openGroupDetail(page: Page): Promise<void> {
  // Normalize the entry point: after createGroupAndInvite the inviter is left
  // ON the group detail page (no group-card to click), while the invitee is on
  // the list. Go to the list first so the card click is deterministic for both.
  await page.goto('/groups/');
  await expect(page.getByTestId('groups-list')).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(page);
  await page.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

test.describe.serial('Notification pills — domain invariants', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUserOnGroups(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUserOnGroups(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Alice and Bob establish a shared MLS group', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, GROUP_NAME);
  });

  test('INV-2: a group message while that group is OPEN renders in the chat but does NOT raise the Groups pill', async () => {
    // Both view the group detail. Alice's entry marks the group read, so its
    // contribution to the Groups pill is 0; capture whatever baseline remains.
    await openGroupDetail(alicePage);
    await openGroupDetail(bobPage);
    await waitForBridge(alicePage);
    // Let ContactStore/live subscriptions settle before measuring baseline.
    await expect(alicePage.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
    const baseline = await badgeCount(alicePage, 'groups-nav-badge');

    const content = `group-inv2-${Date.now()}`;
    await bobPage.getByTestId('chat-input').fill(content);
    await bobPage.getByTestId('chat-input').press('Enter');

    // Arrival proof: Bob's message renders live in Alice's OPEN group chat.
    await expect(
      alicePage.locator('[data-testid^="msg-"]').filter({ hasText: content }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // INV-2: the group is on screen, so the Groups pill must not have moved.
    await dismissErrorOverlay(alicePage);
    expect(await badgeCount(alicePage, 'groups-nav-badge')).toBe(baseline);
  });

  test('INV-1: a group message while Alice is on the LIST raises the Groups pill', async () => {
    // Alice leaves the detail for the list — no group is the active view now.
    await alicePage.goto('/groups/');
    await expect(alicePage.getByTestId('groups-list')).toBeVisible({ timeout: 60_000 });
    await waitForBridge(alicePage);
    const baseline = await badgeCount(alicePage, 'groups-nav-badge');

    const content = `group-inv1-${Date.now()}`;
    await bobPage.getByTestId('chat-input').fill(content);
    await bobPage.getByTestId('chat-input').press('Enter');

    // INV-1: the Groups pill must climb above the baseline.
    await alicePage.waitForFunction(
      (base) => {
        const badge = document.querySelector('[data-testid="groups-nav-badge"]');
        const n = badge ? parseInt((badge.textContent ?? '0').trim(), 10) || 0 : 0;
        return n > base;
      },
      baseline,
      { timeout: 30_000 },
    );
  });

  test('INV-2: a DM while that thread is OPEN renders in the thread but does NOT raise the Contacts pill', async () => {
    // Alice opens the DM thread with Bob — this peer is now the active view.
    await alicePage.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await expect(alicePage.getByTestId('contact-detail-page')).toBeVisible({ timeout: 30_000 });
    await waitForBridge(alicePage);
    // Give ContactChat's init() time to register its live subscriptions.
    await expect(alicePage.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
    // Let ContactChat's mount cycle settle before publishing. Under `next dev`
    // React StrictMode double-invokes the setActiveView effect on mount
    // (set -> clear -> set, all in one tick); if the incoming DM's async
    // gift-wrap handler checks isActiveView('dm', peer) during that momentary
    // clear window it wrongly sees "no active view" and counts the DM. This is
    // a dev-only churn — in production ContactChat mounts once with no re-set —
    // so a short settle makes the active-view registration stable first.
    await alicePage.waitForTimeout(2_000);
    // A DM is a Contacts-domain event, so measure the Contacts nav pill.
    const baseline = await badgeCount(alicePage, 'contacts-nav-badge');

    const content = `dm-inv2-${Date.now()}`;
    await bobPage.waitForFunction(() => typeof (window as any).__fewPublishDm === 'function', null, { timeout: 10_000 });
    await bobPage.evaluate(
      async ({ peer, c }) => { await (window as any).__fewPublishDm(peer, c); },
      { peer: USER_A.pubkeyHex, c: content },
    );

    // Arrival proof: the DM renders live in Alice's OPEN thread.
    await expect(
      alicePage.locator('[data-testid^="msg-"]').filter({ hasText: content }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // INV-2: the thread is on screen, so the Contacts pill must not have moved.
    // The DM watcher runs on its own subscription, so give it a bounded window
    // to (wrongly) fire — the count must stay at baseline throughout.
    await expect
      .poll(async () => badgeCount(alicePage, 'contacts-nav-badge'), { timeout: 6_000, intervals: [1_000, 1_000, 1_000, 1_000, 1_000] })
      .toBe(baseline);
  });
});
