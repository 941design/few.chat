// E2E: epic invite-rescind-and-member-removal, story S11 — AC-SCEN-1, AC-SCEN-2.
//
// An approved join-requester's row must ALWAYS render "Remove Member" and
// NEVER "Cancel Invite" — regardless of whether the join request carried a
// nickname (AC-SCEN-1) or not (AC-SCEN-2, the provisional-inference
// regression guard). Architecture.md's boundary rule is the reason: admin
// approval calls `inviteByNpub` directly (MarmotContext.tsx:515) — a
// structurally DIFFERENT call site than the two direct-invite UI entry
// points that write the pending-direct-invite marker — so an approved
// requester's pubkey never carries a marker. `selectMemberRowAffordance`
// (MemberList.tsx) only ever renders "Cancel Invite" when `isPending &&
// hasMarker`; with `hasMarker` permanently false for this pubkey, every
// other in-tree admin-visible row (including a still-provisional one)
// falls through to "Remove Member" — independent of the provisional/
// confirmed transition. Both scenarios assert this at TWO points: (a)
// immediately after approval, while the member is still provisional
// (pending badge visible, name/nickname seeded only from the join request
// or absent entirely), and (b) after the invitee later comes back online
// for real and their own signed profile round-trips (pending badge gone).
//
// Masking-trap precaution (learning e2e_join_request_autoaccept_masks_approval,
// template groups-join-request-profile.spec.ts:132-137): the invitee's PAGE
// (not its BrowserContext) is closed BEFORE the admin approves. Closing the
// page tears down the live gift-wrap subscription (no in-page JS, no open
// WebSocket) just as thoroughly as closing the whole context would, so the
// masking-trap guarantee is unchanged: a still-live listener would silently
// auto-accept the resulting Welcome + publish a real profile immediately,
// making the row's label look correct even if the approval path itself
// never wired the marker exclusion right. With the page closed, point (a)'s
// assertion can ONLY be explained by the approval path's structural marker
// exclusion — exactly the invariant under test.
//
// The context itself is deliberately kept ALIVE (only the page closes) so
// that its storage partition — notably the invitee's own MLS KeyPackage
// private material (`few-keypackages`) — survives for point (b)'s later
// reopen. A brand-new BrowserContext gets a brand-new, empty storage
// partition; the private key-package half the original Welcome was addressed
// to would be gone forever, and NO future incarnation of "the same identity"
// could ever complete that MLS join — that is not a masking-trap risk, it is
// a structurally unjoinable Welcome. Reopening a new Page in the SAME
// context preserves that material while still fully severing the live
// connection in between.
//
// AC-SCEN-2's join request is built and published as one exceptional raw
// event (helpers/namelessJoinRequestFixture.ts) rather than through
// JoinRequestCard's UI: that UI hard-gates Send on a non-blank name
// (`hasShareableName`), making a genuinely nameless request structurally
// unproducible through a real click. See that file's header for the full
// rationale — it mirrors the one other documented raw-WebSocket exception
// in this suite (helpers/forgedPairingAck.ts).

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { sendNamelessJoinRequest } from './helpers/namelessJoinRequestFixture';
import { acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (nickname) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
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

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

/** Generate a fresh invite link from the group detail page; returns the raw URL string. */
async function generateInviteLink(page: Page): Promise<string> {
  await page.getByTestId('invite-link-btn').click();
  await expect(page.getByTestId('generate-invite-link-modal')).toBeVisible();
  const urlElement = page.getByTestId('invite-link-url');
  await expect(urlElement).toBeVisible();
  const inviteUrl = (await urlElement.textContent()) ?? '';
  expect(inviteUrl).toContain('/groups/?join=');
  // Copy the link (persists the InviteLink to IDB — required for the nonce lookup).
  await page.getByTestId('invite-link-copy-btn').click();
  await page.waitForTimeout(1_000);
  await page.getByTestId('generate-invite-link-modal').locator('[aria-label="Close"]').click();
  await expect(page.getByTestId('generate-invite-link-modal')).not.toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('group-detail-page')).toBeVisible();
  return inviteUrl;
}

/** Approve the first pending join request row visible on the admin's page. */
async function approveFirstRequest(adminPage: Page): Promise<void> {
  const requestRow = adminPage.locator('[data-testid^="pending-request-row-"]').first();
  await expect(requestRow).toBeVisible({ timeout: 60_000 });
  await adminPage.locator('[data-testid^="approve-request-"]').first().click();
  await expect(adminPage.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });
}

/** Assert the row for `prefix` shows "Remove Member" and never "Cancel Invite". */
async function assertRemoveMemberNeverCancelInvite(adminPage: Page, prefix: string): Promise<void> {
  await expect(adminPage.getByTestId(`member-item-${prefix}`)).toBeVisible({ timeout: 60_000 });
  await expect(adminPage.getByTestId(`remove-member-${prefix}`)).toBeVisible({ timeout: 30_000 });
  await expect(adminPage.getByTestId(`cancel-invite-${prefix}`)).not.toBeVisible();
}

// ---------------------------------------------------------------------------
// AC-SCEN-1: approved requester WITH a nickname
// ---------------------------------------------------------------------------

test.describe.serial('AC-SCEN-1 — approved join-requester (with nickname) always shows Remove Member', () => {
  const GROUP_NAME = 'Approved Requester Label Group 1';
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let inviteUrl = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'GroupAdmin'));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, 'Invitee'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates a group and generates an invite link', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    inviteUrl = await generateInviteLink(pageA);
  });

  test('B (nickname "Invitee") opens the invite link and sends a join request', async () => {
    const url = new URL(inviteUrl);
    await pageB.goto(url.pathname + url.search);
    await dismissErrorOverlay(pageB);
    // epic: invite-link-awaiting-landing (S3) -- User B is a returning user
    // (identity seeded via bootUser's addInitScript before navigation), so
    // this now lands on InviteAwaitingBanner, not the full-screen
    // JoinRequestCard.
    await expect(pageB.getByTestId('invite-awaiting-banner')).toBeVisible({ timeout: 30_000 });
    await pageB.getByTestId('invite-awaiting-request-btn').click();
    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    await expect(pageB.getByTestId(`outbound-request-card-${nonce!.slice(0, 6)}`)).toBeVisible({ timeout: 30_000 });
  });

  test('B goes offline BEFORE approval (masking-trap); A approves', async () => {
    await pageB.close();
    await approveFirstRequest(pageA);
  });

  test('(a) Immediately after approval, B\'s still-provisional row shows Remove Member, never Cancel Invite', async () => {
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-pending-${bPrefix}`)).toBeVisible({ timeout: 10_000 });
    await assertRemoveMemberNeverCancelInvite(pageA, bPrefix);
  });

  test('B comes back online for real (same context/identity — real KeyPackage + outbound-request record preserved), auto-accepts, and joins', async () => {
    // A NEW PAGE in the SAME (never-closed) context: B's identity, MLS
    // KeyPackage private material, AND its outbound-join-request record
    // (written by the real join-request-send-btn click above, via the app's
    // own sendJoinRequest — outboundJoinRequests.ts) all survive. Per
    // welcomeSubscription.ts's resolveAutoAcceptRecord, a correlated Welcome
    // (matching admin + matching group name) auto-accepts and joins as soon
    // as B's subscription sees it again — exactly like a real user simply
    // reopening the app. There is no manual accept-invitation click to make
    // here: the correlated path never enqueues a pending invitation at all
    // (AC-AUTO-2's "no second click" guarantee).
    pageB = await ctxB.newPage();
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await dismissErrorOverlay(pageB);
    await expect(pageB.getByText(GROUP_NAME)).toBeVisible({ timeout: 90_000 });
  });

  test('(b) After B\'s real signed profile round-trips, the row STILL shows Remove Member, never Cancel Invite', async () => {
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    // Readiness gate: wait for the real profile to supersede the provisional
    // entry (pending badge clears) before re-asserting the affordance — the
    // whole point of this second assertion point.
    await expect(pageA.getByTestId(`member-pending-${bPrefix}`)).not.toBeVisible({ timeout: 90_000 });
    await assertRemoveMemberNeverCancelInvite(pageA, bPrefix);
  });
});

// ---------------------------------------------------------------------------
// AC-SCEN-2: approved requester with NO nickname (provisional-inference guard)
// ---------------------------------------------------------------------------

test.describe.serial('AC-SCEN-2 — approved join-requester (no nickname) always shows Remove Member', () => {
  const GROUP_NAME = 'Approved Requester Label Group 2';
  let ctxA: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageC: Page;
  let inviteUrl = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'GroupAdmin2'));
    // C is booted with NO nickname — the request's `requesterName` is
    // omitted entirely by the fixture below, independent of C's own saved
    // profile (which also stays blank here for consistency).
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C, ''));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxC?.close();
  });

  test('A creates a second group and generates an invite link', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    inviteUrl = await generateInviteLink(pageA);
  });

  test('C publishes a nameless join request (exceptional raw-event fixture — see file header)', async () => {
    const url = new URL(inviteUrl);
    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    // C already visited /groups/ during bootUser, which is enough for the
    // app to have published C's KeyPackage — required for the later
    // inviteByNpub call inside approveJoinRequestImpl.
    await sendNamelessJoinRequest(pageC, {
      requesterPrivateKeyHex: USER_C.privateKeyHex,
      requesterPubkeyHex: USER_C.pubkeyHex,
      adminPubkeyHex: USER_A.pubkeyHex,
      nonce: nonce!,
      groupName: GROUP_NAME,
    });
  });

  test('C goes offline BEFORE approval (masking-trap); A approves', async () => {
    await pageC.close();
    await approveFirstRequest(pageA);
  });

  test('(a) Immediately after approval, the nameless provisional row shows Remove Member, never Cancel Invite', async () => {
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).toBeVisible({ timeout: 10_000 });
    await assertRemoveMemberNeverCancelInvite(pageA, cPrefix);
  });

  test('C comes back online for real (same context/identity — real KeyPackage preserved), accepts, and joins', async () => {
    // A NEW PAGE in the SAME (never-closed) context, so C's MLS KeyPackage
    // private material survives — the join below can actually complete.
    // Unlike B in AC-SCEN-1, C's join request was sent via the raw-event
    // fixture (sendNamelessJoinRequest), which bypasses the app's own
    // sendJoinRequest and therefore never writes an outbound-join-request
    // record (outboundJoinRequests.ts is written only on a successful
    // app-level send). With no record to correlate against, this Welcome
    // stays on the uncorrelated/pending path (AC-AUTO-3) and needs the
    // manual accept-invitation click, exactly as before.
    pageC = await ctxC.newPage();
    await pageC.goto('/groups/');
    await expect(
      pageC.getByTestId('groups-empty-state').or(pageC.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await dismissErrorOverlay(pageC);

    await expect(pageC.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageC, GROUP_NAME);
  });

  test('(b) After C\'s real signed profile round-trips, the row STILL shows Remove Member, never Cancel Invite', async () => {
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).not.toBeVisible({ timeout: 90_000 });
    await assertRemoveMemberNeverCancelInvite(pageA, cPrefix);
  });
});
