import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user context: inject identity via init script, navigate to /groups/. */
async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  opts?: { nickname?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (nickname) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname: opts?.nickname ?? '' });
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

/** Create a group from the given page. */
async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(name);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
  await page.waitForTimeout(3_000);
}

/** Navigate to a group's detail page. */
async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// E2E: Join request must refresh the OPEN group detail view live.
//
// Regression coverage for: admin stays on an already-open group detail page,
// a peer joins via invite link, and the pending-requests section must appear
// without any navigate-away/reload — mirroring the notification bell, which
// already updates live. See bug-reports/group-view-no-live-refresh-on-member-
// accept-report.md.
//
// The crux of this test is what it does NOT do: after generating the invite
// link, User A's page is never `goto`'d or `reload`'d again. Contrast with
// groups-invite-link.spec.ts, where User A navigates to /groups/ and back
// before checking for the inline join-request rows — that round trip masks
// this bug because the group-entry effect re-reads pending requests from IDB
// on the fresh mount. Here the member list must already be mounted and must
// update via live state, or the assertion below fails.
// ---------------------------------------------------------------------------
test.describe.serial('Join request live-refreshes an already-open group detail view', () => {
  const GROUP_NAME = 'Live Refresh Test Group';
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let inviteUrl = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, { nickname: 'Admin' }));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, { nickname: 'Invitee' }));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('User A creates a group and generates an invite link', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);

    await pageA.getByTestId('invite-link-btn').click();
    await expect(pageA.getByTestId('generate-invite-link-modal')).toBeVisible();

    const urlElement = pageA.getByTestId('invite-link-url');
    await expect(urlElement).toBeVisible();
    inviteUrl = (await urlElement.textContent()) ?? '';
    expect(inviteUrl).toContain('/groups/?join=');

    // Copy the link (persists the InviteLink to IDB — required for the nonce lookup).
    await pageA.getByTestId('invite-link-copy-btn').click();
    await pageA.waitForTimeout(1_000);

    // Close the modal (scope to modal so we don't hit a toast close button).
    await pageA.getByTestId('generate-invite-link-modal').locator('[aria-label="Close"]').click();
    await expect(pageA.getByTestId('generate-invite-link-modal')).not.toBeVisible({ timeout: 5_000 });

    // User A stays right here — on the open group detail page — for the rest
    // of the test. No further navigation/reload of pageA is permitted.
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible();
  });

  test('User B opens the invite link and sends a join request', async () => {
    const url = new URL(inviteUrl);
    const pathWithQuery = url.pathname + url.search;

    await pageB.goto(pathWithQuery);
    await dismissErrorOverlay(pageB);

    // epic: invite-link-awaiting-landing (S3) -- User B is a returning user
    // (identity seeded via bootUser's addInitScript before navigation), so
    // this now lands on InviteAwaitingBanner, not the full-screen
    // JoinRequestCard. B already has a name ('Invitee', set at boot).
    await expect(pageB.getByTestId('invite-awaiting-banner')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(GROUP_NAME)).toBeVisible();

    await pageB.getByTestId('invite-awaiting-request-btn').click();

    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    await expect(pageB.getByTestId(`outbound-request-card-${nonce!.slice(0, 6)}`)).toBeVisible({ timeout: 30_000 });
  });

  test('User A sees the live inline join-request row, and the Groups pill stays dark for the group on screen (INV-2)', async () => {
    // Arrival proof: the inline join-request row at the top of the member list
    // on the ALREADY-OPEN group detail page must update live — no goto/reload of
    // pageA above or below this line. Pre-fix, this timed out because the
    // join-request callback only updated the unread store, never the
    // `pendingRequests` React state the member list renders these rows from.
    // This positive assertion also proves the rumor was received and processed,
    // so the negative pill assertion below is not racing an unarrived event.
    await expect(pageA.locator('[data-testid^="pending-request-row-"]').first()).toBeVisible({ timeout: 60_000 });

    // notification-domain-invariants (INV-2): the join request is for the group
    // whose detail is currently OPEN, so the Groups count pill must NOT rise —
    // the request surfaces in the inline row above instead. A join request is a
    // Groups-domain event, so it would show on `groups-nav-badge`. The event has
    // already been processed (the row rendered), so the pill would be present by
    // now if it were (wrongly) rising. The pill is absent (count 0) at a domain
    // total of 0. Pre-invariant, this badge appeared.
    await dismissErrorOverlay(pageA);
    await expect(pageA.getByTestId('groups-nav-badge')).toHaveCount(0);
  });
});
