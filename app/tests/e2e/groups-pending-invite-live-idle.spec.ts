/**
 * E2E: Pending invitation live update while idle, off /groups
 * (bug: pending-invite-no-live-update).
 *
 * Reproduces the reported defect: a recipient who has the app open but is
 * NOT sitting on /groups (the common case — the app opens on the home page
 * `/`) never learns of an incoming invitation until a full reload. The
 * existing invite/accept specs all keep the invitee ON /groups with
 * MarmotContext actively churning (group create/invite/reload), which masks
 * this exact reactivity gap via incidental re-renders — see
 * app/bug-reports/pending-invite-no-live-update-report.md.
 *
 * This spec instead:
 *   - Boots Bob and parks him on `/` (home), fully idle — no other
 *     background churn (Bob does not create/join/query anything else).
 *   - Has Alice create a group and invite Bob via the real app picker
 *     (no raw WebSocket / hand-signed events).
 *   - Asserts the Groups nav badge on Bob's page increments LIVE, with
 *     NEITHER a `page.reload()` NOR a `page.goto()` in between arrival and
 *     assertion — only a client-side nav click is used to reach /groups
 *     afterward, which must show the invitation card without a reload.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Idle Live Update Group';

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
  return { context, page };
}

test.describe.serial('Pending invitation live update while idle (bug repro)', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));

    // No /groups warm-up: USER_B's keypair is salted per-spec-file (see
    // auth-helpers.ts), so this identity has never received any relay
    // traffic before — there is no stale-invite/seen-set contamination risk
    // to drain, unlike the shared helper's identities. This also matches the
    // bug report's literal scenario more closely: Bob opens the app for the
    // first time and lands directly on the home page `/`, never having
    // visited /groups at all before going idle. bootUser() already leaves
    // bobPage on `/` after its post-clearAppState reload.
    await expect(bobPage.getByTestId('home-groups-btn')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Groups nav badge increments live and the invitation card appears without a reload', async () => {
    // Baseline the badge BEFORE Alice invites — normally 0/hidden on a fresh
    // identity against a freshly-wiped relay (the real e2e gate always wipes
    // the relay first: Makefile's test-e2e target). Reading it as a count
    // rather than assuming a hardcoded '0' also makes this spec resilient to
    // a dev-iteration re-run against an already-dirty relay (an unwiped
    // no-`since` subscription replays undeclined stale invites for the same
    // salted identity) — the assertion below only requires a live +1
    // increment, which is the actual property under test either way.
    const badge = bobPage.getByTestId('groups-nav-badge');
    const baselineCount = (await badge.isVisible()) ? Number(await badge.textContent()) : 0;

    // Alice creates a group and invites Bob through the real contact-picker
    // flow (production path, no raw WebSocket).
    await alicePage.goto('/groups/');
    await expect(alicePage.getByTestId('create-group-btn')).toBeVisible({ timeout: 30_000 });
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

    // Bob is idle on `/` the whole time — this assertion is the crux of the
    // repro. It must NOT be preceded by any bobPage.reload() or
    // bobPage.goto() call: those would trigger the confounding
    // module-load-reads-localStorage path this bug hides behind. A plain
    // retrying `toBeVisible` polls the live DOM, matching this codebase's
    // e2e convention for asserting relay-propagated state without racing
    // hydration (learning: e2e_no_reload_poll_for_propagation).
    await expect(badge).toBeVisible({ timeout: 60_000 });
    await expect(badge).toHaveText(String(baselineCount + 1));

    // Client-side nav only (no reload/goto) — the invitation card must
    // already be there, proving the store update reached this route's
    // useSyncExternalStore subscriber too, not just Layout's.
    await bobPage.getByTestId('home-groups-btn').click();
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 15_000 });
    await expect(
      bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_NAME }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
