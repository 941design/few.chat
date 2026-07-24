import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
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
// E2E: Full invite link flow — User A generates link, User B joins via link
// ---------------------------------------------------------------------------
test.describe.serial('Invite link flow — generate, join request, approve', () => {
  const GROUP_NAME = 'Invite Link Test Group';
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

  test('User A creates a group', async () => {
    await createGroup(pageA, GROUP_NAME);
  });

  test('User A generates an invite link', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await pageA.getByTestId('invite-link-btn').click();
    await expect(pageA.getByTestId('generate-invite-link-modal')).toBeVisible();

    // Read the generated URL from the modal
    const urlElement = pageA.getByTestId('invite-link-url');
    await expect(urlElement).toBeVisible();
    inviteUrl = (await urlElement.textContent()) ?? '';
    expect(inviteUrl).toContain('/groups/?join=');
    expect(inviteUrl).toContain('&admin=');
    expect(inviteUrl).toContain('&name=');

    // The same link is offered as a QR for in-person hand-over. Its alt text is
    // the encoded value, so this also asserts the QR encodes the link shown.
    const qrImage = pageA.getByTestId('invite-link-qr-image');
    await expect(qrImage).toBeVisible({ timeout: 10_000 });
    await expect(qrImage).toHaveAttribute('alt', inviteUrl);
    await expect(qrImage).toHaveAttribute('src', /^data:image\/png;base64,/);

    // Copy the link (persists the InviteLink to IDB)
    await pageA.getByTestId('invite-link-copy-btn').click();
    await pageA.waitForTimeout(1_000);

    // Close the modal (scope to the modal to avoid matching any other Close control)
    await pageA.getByTestId('generate-invite-link-modal').locator('[aria-label="Close"]').click();
    await expect(pageA.getByTestId('generate-invite-link-modal')).not.toBeVisible({ timeout: 5_000 });
  });

  test('User B opens the invite link and sends a join request', async () => {
    // Extract the path + query from the full URL
    const url = new URL(inviteUrl);
    const pathWithQuery = url.pathname + url.search;

    await pageB.goto(pathWithQuery);
    await dismissErrorOverlay(pageB);

    // epic: invite-link-awaiting-landing (S3) -- User B is booted via
    // bootUser's addInitScript, which seeds an identity BEFORE navigation, so
    // isFreshIdentity is false: a returning user now lands on the groups list
    // with InviteAwaitingBanner instead of the full-screen JoinRequestCard.
    await expect(pageB.getByTestId('invite-awaiting-banner')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(GROUP_NAME)).toBeVisible();

    // AC-ETE-2 / AC-GATE-4: User B already has a name ('Invitee', set at
    // boot), so the banner's inline name field is pre-filled from it and the
    // request button is enabled -- no separate gate to clear.
    await expect(pageB.getByTestId('invite-awaiting-name-input')).toHaveValue('Invitee');
    await expect(pageB.getByTestId('invite-awaiting-request-btn')).toBeEnabled();

    // Click "Request to Join"
    await pageB.getByTestId('invite-awaiting-request-btn').click();

    // Should see the Awaiting card appear (reactive banner state change).
    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    await expect(pageB.getByTestId(`outbound-request-card-${nonce!.slice(0, 6)}`)).toBeVisible({ timeout: 30_000 });
  });

  test('User A sees the pending join request', async () => {
    // Navigate to groups and reload to pick up the gift-wrapped join request
    await pageA.goto('/groups/');
    await expect(
      pageA.getByTestId('groups-empty-state').or(pageA.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // Wait for the Groups nav pill to show a count (a join request is a
    // Groups-domain event, so it surfaces on `groups-nav-badge`).
    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageA);
          const badge = pageA.getByTestId('groups-nav-badge').first();
          return badge.isVisible();
        },
        { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBe(true);

    // Open the group detail
    await openGroupDetail(pageA, GROUP_NAME);

    // Should see the inline join-request row at the top of the member list
    await expect(pageA.locator('[data-testid^="pending-request-row-"]').first()).toBeVisible({ timeout: 30_000 });
  });

  test('User A approves the join request', async () => {
    await dismissErrorOverlay(pageA);

    // Click Approve on the first pending request
    await pageA.locator('[data-testid^="approve-request-"]').first().click();

    // Wait for the join-request row to disappear (request was approved)
    await expect(pageA.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });
  });

  test('User B receives the Welcome and lands in the group with no second click (auto-accept)', async () => {
    // Navigate User B to the groups list
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // epic: group-invite-link-onboarding, S4 (AC-AUTO-1/2/4) -- an outbound
    // record is written for EVERY successful sendJoinRequest, independent of
    // whether the requester supplied a name, and auto-accept correlates on
    // it regardless. So the invite-link flow no longer goes through the
    // Walled Garden v2 pending-invitation queue at all (superseding the
    // previous manual-accept behavior this test asserted): the Welcome is
    // never enqueued, and User B must land in the group directly. Verified
    // directly against the app (2026-07-16): the unmodified pre-S4 version
    // of this assertion (poll for a pending-invitation row, then click
    // Accept) times out, because no such row is ever created.
    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageB);
          // Scope to the real joined-group card, not a bare text match: the
          // new returning-user landing (InviteAwaitingBanner + awaiting card)
          // renders GROUP_NAME in several places, so getByText(GROUP_NAME)
          // now hits a strict-mode multi-match. The group-card testid appears
          // only once the auto-accept join lands.
          return pageB
            .locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME })
            .isVisible();
        },
        { timeout: 90_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBe(true);

    // Payoff: no pending-invitation row/Accept click was ever needed.
    await expect(pageB.locator('[data-testid^="accept-invitation-"]')).toHaveCount(0);

    // Open the group detail and verify membership
    await openGroupDetail(pageB, GROUP_NAME);
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// E2E: Nameless-invitee full path (AC-ETE-1) -- gate blocks the request,
// entering a name enables it, the admin's pending row shows that name (S2
// nickname transport, AC-NAME-4), the admin approves, and the invitee lands
// in the group with NO second click (S4 auto-accept, AC-AUTO-2).
//
// A fresh admin browser context is used (same USER_A identity, but a brand
// new context => brand new local MLS/overlay state), so this group is
// entirely independent of the block above's "Invite Link Test Group" --
// per auth-helpers.ts, two describe blocks in the SAME spec file sharing
// identities is the documented, tolerated pattern (identities are salted
// per spec FILE, not per describe block).
// ---------------------------------------------------------------------------
test.describe.serial('Invite link flow — nameless invitee gate, nickname transport, auto-accept', () => {
  const GROUP_NAME = 'Invite Link Test Group (Nameless)';
  const INVITEE_NAME = 'Nameless Nadia';
  let ctxAdmin: BrowserContext;
  let ctxInvitee: BrowserContext;
  let pageAdmin: Page;
  let pageInvitee: Page;
  let inviteUrl = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxAdmin, page: pageAdmin } = await bootUser(browser, USER_A, { nickname: 'Admin' }));
    // No `nickname` option: boots User C with NO name, so the join card's S1
    // gate (AC-GATE-1..3) and S2 nickname transport (AC-NAME-*) are both
    // exercised for real, through the app's own UI and publish helpers --
    // never a raw WebSocket to strfry (AC-ETE-3).
    ({ context: ctxInvitee, page: pageInvitee } = await bootUser(browser, USER_C));
  });

  test.afterAll(async () => {
    await ctxAdmin?.close();
    await ctxInvitee?.close();
  });

  test('Admin creates a group and generates an invite link', async () => {
    await createGroup(pageAdmin, GROUP_NAME);
    await openGroupDetail(pageAdmin, GROUP_NAME);

    await pageAdmin.getByTestId('invite-link-btn').click();
    await expect(pageAdmin.getByTestId('generate-invite-link-modal')).toBeVisible();

    const urlElement = pageAdmin.getByTestId('invite-link-url');
    await expect(urlElement).toBeVisible();
    inviteUrl = (await urlElement.textContent()) ?? '';
    expect(inviteUrl).toContain('/groups/?join=');

    await pageAdmin.getByTestId('invite-link-copy-btn').click();
    await pageAdmin.waitForTimeout(1_000);
    await pageAdmin.getByTestId('generate-invite-link-modal').locator('[aria-label="Close"]').click();
    await expect(pageAdmin.getByTestId('generate-invite-link-modal')).not.toBeVisible({ timeout: 5_000 });
  });

  test('Nameless invitee is gated until a name is entered, then sends the request (AC-GATE-1..3)', async () => {
    const url = new URL(inviteUrl);
    const pathWithQuery = url.pathname + url.search;

    await pageInvitee.goto(pathWithQuery);
    await dismissErrorOverlay(pageInvitee);

    // epic: invite-link-awaiting-landing (S3) -- USER_C is a returning user
    // (identity seeded via bootUser's addInitScript before navigation), so
    // this now lands on InviteAwaitingBanner, not the full-screen
    // JoinRequestCard.
    await expect(pageInvitee.getByTestId('invite-awaiting-banner')).toBeVisible({ timeout: 30_000 });
    // AC-GATE-2: the group name stays visible while the gate is shown.
    await expect(pageInvitee.getByText(GROUP_NAME)).toBeVisible();

    // AC-GATE-1: a nameless user sees the banner's inline name field, empty,
    // and a disabled request button.
    const nameInput = pageInvitee.getByTestId('invite-awaiting-name-input');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('');
    const sendBtn = pageInvitee.getByTestId('invite-awaiting-request-btn');
    await expect(sendBtn).toBeDisabled();

    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    const noncePrefix = nonce!.slice(0, 6);

    // Clicking the disabled button must not call sendJoinRequest -- force
    // the click past Playwright's actionability check and confirm no
    // outbound record was created.
    await sendBtn.click({ force: true });
    await expect(pageInvitee.getByTestId(`outbound-request-card-${noncePrefix}`)).toHaveCount(0);

    // AC-GATE-3: the gate is reactive -- entering a name enables the button
    // live, and clearing it back out disables it again (not evaluated only
    // on mount).
    await nameInput.fill(INVITEE_NAME);
    await expect(sendBtn).toBeEnabled();
    await nameInput.fill('');
    await expect(sendBtn).toBeDisabled();
    await nameInput.fill(INVITEE_NAME);
    await expect(sendBtn).toBeEnabled();

    await sendBtn.click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${noncePrefix}`)).toBeVisible({ timeout: 30_000 });
  });

  test("Admin's pending row shows the requester's real name, not a truncated npub (AC-NAME-4)", async () => {
    await pageAdmin.goto('/groups/');
    await expect(
      pageAdmin.getByTestId('groups-empty-state').or(pageAdmin.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageAdmin);
          const badge = pageAdmin.getByTestId('groups-nav-badge').first();
          return badge.isVisible();
        },
        { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBe(true);

    await openGroupDetail(pageAdmin, GROUP_NAME);

    // The S2 payoff: the admin sees the requester's REAL name inside the inline
    // join-request row at the top of the member list, not merely a truncated npub.
    await expect(
      pageAdmin.locator('[data-testid^="pending-request-row-"]').filter({ hasText: INVITEE_NAME }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('Admin approves the join request', async () => {
    await dismissErrorOverlay(pageAdmin);
    await pageAdmin.locator('[data-testid^="approve-request-"]').first().click();
    await expect(pageAdmin.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });
  });

  test('Nameless invitee lands in the group with NO second click (AC-AUTO-2 / AC-ETE-1 payoff)', async () => {
    await pageInvitee.goto('/groups/');
    await expect(
      pageInvitee.getByTestId('groups-empty-state').or(pageInvitee.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // The final, state-discriminating assertion: the group card appears
    // WITHOUT any Accept interaction. This test never looks at
    // pending-invitations-section or clicks accept-invitation-* -- if
    // auto-accept were broken (or absent, as on a pre-S1..S4 checkout),
    // nothing here would drive the join, so this poll would simply time out
    // rather than passing vacuously.
    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageInvitee);
          // Scope to the real joined-group card (see the named-invitee case
          // above): the new returning-user landing renders GROUP_NAME in
          // several places, so a bare getByText would strict-mode multi-match.
          return pageInvitee
            .locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME })
            .isVisible();
        },
        { timeout: 90_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBe(true);

    // No Accept button was ever needed for this group to appear.
    await expect(pageInvitee.locator('[data-testid^="accept-invitation-"]')).toHaveCount(0);

    await openGroupDetail(pageInvitee, GROUP_NAME);
    await expect(pageInvitee.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  });
});
