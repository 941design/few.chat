/**
 * E2E "blackout guard" for the marmot-ts 0.7.0 authenticated-sender migration
 * (epic: marmot-ts-authenticated-sender-migration, story S3).
 *
 * AC-DEP-1: the newly-installed marmot-ts fork must actually resolve
 * `senderCredential` for a real second-peer group message. Prior to the fork
 * fix, a message whose sender credential could not be resolved would enter a
 * "blackout" drop path — the library would either never deliver it to the
 * app (no `authenticatedApplicationMessage` event at all) or route it to the
 * diagnostic-only `unauthenticatedMessage` event instead
 * (applicationRumorDispatcher.ts's AC-OBS-1 listener) — and the message would
 * silently never render for the recipient. Unit tests mock
 * `deserializeApplicationData` and the fake-group event payload directly, so
 * they cannot prove the REAL library resolves a real MLS sender credential
 * end to end; only a genuine two-peer relay round-trip can. A green run of
 * this spec is the load-bearing proof that the fork's `senderCredential`
 * resolution works — not merely that the code compiles or that the unit
 * suite (which mocks the library) passes.
 *
 * Deliberately minimal: this is NOT a re-run of groups-dispatch-isolation.spec.ts's
 * IDB-write-counter machinery (AC-AR-21/AC-AR-22 concerns are out of scope
 * here) — just a real send from the second peer and a real render on the
 * first peer's screen.
 *
 * Requires the strfry relay harness: make e2e-up / make test-e2e-groups.
 * Single-spec run: node scripts/run-e2e.mjs tests/e2e/groups-blackout-guard.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/**
 * Boot a user context with identity and nickname injected via localStorage.
 * Mirrors the pattern from groups-dispatch-isolation.spec.ts.
 */
async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

// ─── Module-scoped state shared across serial tests ───────────────────────
let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe.serial('groups-blackout-guard', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();

    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: contextB, page: pageB } = await bootUserWithProfile(browser, USER_B, 'Bob'));

    // Bob is already on /groups/ from bootUserWithProfile — wait for the welcome
    // subscription to consume any stale gift wraps left in the relay by prior
    // runs. The production fix marks their event ids as seen so they cannot
    // re-enqueue.
    await pageB.waitForTimeout(10_000);

    // Clear only the pending-invitations queue (not the seen-set). When Alice's
    // fresh invite arrives below it will be the sole entry in Bob's queue.
    await pageB.evaluate(() => {
      localStorage.removeItem('lp_pendingInvitations_v1');
    });

    // Alice creates the shared test group.
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('Blackout Guard Test');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Blackout Guard Test')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Alice opens the group detail.
    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Blackout Guard Test' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice invites Bob.
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.locator('[data-testid="invite-member-modal-content"] button[aria-label="Close"]').click().catch(() => {});

    // Walled Garden v2: pull-only invitations. Bob must explicitly accept the
    // pending invitation before the group appears in his list.
    await pageB.waitForTimeout(5_000);
    await pageB.goto('/groups/');
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(pageB.locator('[data-testid^="pending-invitation-row-"]').first()).toBeVisible({ timeout: 30_000 });
    await pageB.locator('[data-testid^="accept-invitation-"]').first().click();
    await expect(pageB.getByText('Blackout Guard Test')).toBeVisible({ timeout: 90_000 });
    await pageB.locator('[data-testid^="group-card-"]', { hasText: 'Blackout Guard Test' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice invited Bob from the group detail page (the contact picker is a modal
    // over that view), so she never left it — confirm she is still on the detail
    // page to observe Bob's message, rather than re-navigating from the list.
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  /**
   * AC-DEP-1: Bob (the SECOND peer) sends a chat message through the app's
   * own send UI. Alice must see it render — proving the marmot-ts fork
   * resolved Bob's `senderCredential` for this message rather than dropping
   * it into the blackout path.
   */
  test('second-peer send survives end to end: Alice sees Bob\'s message (AC-DEP-1)', async () => {
    const uniqueText = `blackout-guard-${Date.now()}`;
    await pageB.getByTestId('chat-input').fill(uniqueText);
    await pageB.getByTestId('chat-send-btn').click();

    // Bob sees his own message locally (optimistic render).
    await expect(pageB.locator(`text=${uniqueText}`)).toBeVisible({ timeout: 15_000 });

    // Alice must see Bob's message arrive via the relay — the load-bearing
    // assertion. A generous polling window accommodates real relay latency.
    await expect(pageA.locator(`text=${uniqueText}`)).toBeVisible({ timeout: 30_000 });
  });
});
