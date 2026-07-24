/**
 * E2E: Feedback channel — reply path under the walled garden + UI wiring.
 *
 * The maintainer-side reception of feedback (a maintainer admitting DMs from
 * arbitrary strangers) is explicitly out of scope (spec §7). What this test
 * exercises is the in-scope assembled-epic behavior:
 *
 *   1. The Settings page surfaces a feedback row that navigates to /feedback,
 *      and the page renders the distinct feedback chrome (AC-UI-1, AC-UI-2).
 *   2. With the user having joined a group (walled garden active), a reply from
 *      the configured maintainer key is ADMITTED — not dropped — because the
 *      maintainer key is seeded into knownPeers at startup (AC-REPLY-2). The
 *      reply lands in the Feedback thread (AC-REPLY-1).
 *   3. (Removed with the notification bell) The maintainer's bell entry used to
 *      deep-link to /feedback rather than a generic contact chat (AC-NOTIFY-2).
 *      The bell + its dropdown rows no longer exist — a maintainer reply now
 *      only bumps the Contacts-domain nav pill (`contacts-nav-badge`), with no
 *      per-row routing affordance. That AC-NOTIFY-2 assertion is dropped; the
 *      still-valid part (the reply increments the Contacts total and lands in
 *      the Feedback thread) is preserved below.
 *   4. The maintainer key never appears in the contacts list, even after a
 *      reply created a contact record (AC-CONTACT-1).
 *
 * The maintainer is configured to USER_B via NEXT_PUBLIC_MAINTAINER_NPUBS so the
 * test controls the maintainer's private key. The maintainer reply is published
 * THROUGH THE APP (USER_B's own __fewPublishDm bridge), per the
 * publish-via-app rule (CLAUDE.md, feedback_e2e_no_direct_relay) — never a raw
 * WebSocket to the relay.
 *
 * Requires the strfry relay harness (make e2e-up) AND the dev server started
 * with NEXT_PUBLIC_MAINTAINER_NPUBS set to USER_B's npub. Run via:
 *   E2E_GROUPS=1 NEXT_PUBLIC_MAINTAINER_NPUBS=<USER_B npub> \
 *     node scripts/run-e2e.mjs tests/e2e/feedback-channel.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function waitForBridge(page: Page) {
  await page.waitForFunction(() => !!(window as any).__fewUnread, null, { timeout: 10_000 });
}

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

test.describe.serial('Feedback channel — reply path + UI wiring', () => {
  let aliceCtx: BrowserContext;
  let maintainerCtx: BrowserContext;
  let helperCtx: BrowserContext;
  let alicePage: Page;
  let maintainerPage: Page;
  let helperPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    // Sanity: the dev server must be configured with USER_B as the maintainer.
    // If not, the feature treats USER_B as an ordinary peer and the assertions
    // below (routing to /feedback, contacts exclusion) would not hold.
    ({ context: aliceCtx, page: alicePage } = await bootUserOnGroups(browser, USER_A, 'alice-fb'));
    ({ context: maintainerCtx, page: maintainerPage } = await bootUserOnGroups(browser, USER_B, 'maintainer-fb'));
    ({ context: helperCtx, page: helperPage } = await bootUserOnGroups(browser, USER_C, 'carol-fb'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await maintainerCtx?.close();
    await helperCtx?.close();
  });

  test('Settings exposes a feedback row that navigates to the distinct /feedback surface (AC-UI-1, AC-UI-2)', async () => {
    await alicePage.goto('/settings');
    await alicePage.waitForLoadState('networkidle');
    const row = alicePage.getByTestId('settings-feedback-row');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await alicePage.waitForURL(/\/feedback\/?(\?|$)/, { timeout: 15_000 });
    // Distinct feedback chrome renders (page testid), not a generic contact page.
    await expect(alicePage.getByTestId('feedback-page')).toBeVisible({ timeout: 30_000 });
  });

  test('Alice joins a group so the walled garden is active (seeding prerequisite)', async () => {
    // Alice invites Carol; the act of being in a group flips Alice's walled
    // garden from "cold" to "active", so admitting the maintainer reply later
    // genuinely depends on the knownPeers seeding rather than the empty-set
    // fast-path.
    await createGroupAndInvite(alicePage, USER_C.npub, helperPage, 'Feedback WG Group');
  });

  test('A maintainer reply is admitted, routes to /feedback, and the maintainer stays out of contacts (AC-REPLY-1/2, AC-CONTACT-1)', async () => {
    const REPLY = `maintainer-reply-${Date.now()}`;

    // Alice mounts the unread watcher.
    await alicePage.goto('/contacts');
    await alicePage.waitForLoadState('networkidle');
    await waitForBridge(alicePage);
    await dismissErrorOverlay(alicePage);

    // Baseline of the Contacts-domain nav pill (a DM is a Contacts-domain event).
    const baseline = await alicePage.evaluate(() => {
      const b = document.querySelector('[data-testid="contacts-nav-badge"]');
      return b ? parseInt((b.textContent ?? '0').trim(), 10) : 0;
    });

    // The maintainer (USER_B) replies to Alice THROUGH THE APP (its own bridge).
    await maintainerPage.waitForFunction(
      () => typeof (window as any).__fewPublishDm === 'function',
      null,
      { timeout: 10_000 },
    );
    await maintainerPage.evaluate(
      async ({ alicePub, content }) => {
        await (window as any).__fewPublishDm(alicePub, content);
      },
      { alicePub: USER_A.pubkeyHex, content: REPLY },
    );

    // AC-REPLY-2: the reply is ADMITTED (not dropped) — the Contacts-domain
    // nav pill increments.
    await alicePage.waitForFunction(
      (base) => {
        const b = document.querySelector('[data-testid="contacts-nav-badge"]');
        if (!b) return false;
        return parseInt((b.textContent ?? '0').trim(), 10) > base;
      },
      baseline,
      { timeout: 30_000 },
    );

    // AC-NOTIFY-2 (DROPPED): the maintainer's bell entry used to deep-link to
    // /feedback rather than a generic /contacts?id= chat. The notification bell
    // and its per-DM dropdown rows were removed and replaced by count pills, so
    // there is no longer a per-row routing affordance to assert. The app
    // provides no equivalent non-bell affordance for this, so no replacement
    // routing assertion is added here — see this file's header note.

    // AC-REPLY-1: the reply renders in the Feedback thread.
    await alicePage.goto('/feedback');
    await alicePage.waitForLoadState('networkidle');
    const bubble = alicePage.locator('[data-testid^="msg-"]').filter({ hasText: REPLY }).first();
    await expect(bubble).toBeVisible({ timeout: 30_000 });

    // AC-CONTACT-1: despite a contact record now existing (reply called
    // rememberContact), the maintainer never appears in the contacts list.
    await alicePage.goto('/contacts');
    await alicePage.waitForLoadState('networkidle');
    await expect(
      alicePage.getByTestId('contacts-list').or(alicePage.getByTestId('contacts-empty-state')),
    ).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toHaveCount(0);
  });
});
