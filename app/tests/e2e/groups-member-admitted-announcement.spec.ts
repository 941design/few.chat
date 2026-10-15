// E2E: epic group-admission-chat-announcement, story S1 — member-admitted
// chat announcement.
//
// Covers:
//   AC-RENDER-1 — approving a join request posts a "<admitter> admitted
//     <new member>" announcement (testid member-admitted-announcement),
//     visible in the approving admin's chat AND in an already-present second
//     member's chat.
//   AC-RENDER-2 — the admitted member's display name resolves from the
//     receiver's own profileMap, falling back to a truncated npub when the
//     real profile hasn't round-tripped yet.
//   AC-SEND-1 — the announcement fires only on a successful approval.
//   AC-SCOPE-1 — a DIRECT invite (picker-based, not a join request) posts NO
//     member-admitted announcement — regression guard.
//
// Rule (project e2e gate): every action is driven through the app UI across
// three browser contexts (admin, direct-invited member, join-requester). The
// approval + announcement are published by the app itself, never hand-signed
// to the relay. The only raw-relay access is KeyPackage polling.
//
// Prior-learning precautions applied here:
//   - closing-playwright-browsercontext-destroys: the requester's
//     BrowserContext is never closed around the approval — closing it would
//     destroy MLS KeyPackage material and could mask bugs. All contexts stay
//     open for the whole test.
//   - non-flaky-app-trigger-rawpublish-failure: propagation is asserted with
//     retrying `toBeVisible`/`expect.poll` on the live-updating chat UI, not
//     fixed waits or reload-based polling (beyond the same generous
//     `waitForTimeout` the sibling groups-rename.spec.ts/groups-approved-
//     requester-label.spec.ts use immediately after a relay-publishing
//     action, which this spec mirrors for consistency).

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

const GROUP_NAME = 'Member Admitted Announcement Group';
const ADMIN_NICKNAME = 'AdmitAdmin';
const REQUESTER_NICKNAME = 'AdmitRequester';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      if (nickname) {
        localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
      }
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
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
  await page.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

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

async function waitForGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await acceptInvitationAndWaitJoined(page, groupName);
  await openGroupDetail(page, groupName);
}

test.describe.serial('Member-admitted chat announcement (join-request approval only)', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let inviteUrl = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, ADMIN_NICKNAME));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, REQUESTER_NICKNAME));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C, 'AdmitWitness'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('A creates a group and direct-invites C (already-present second member)', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteContactViaPicker(pageA, USER_C.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.waitForTimeout(3_000);
    await waitForGroupAndOpen(pageC, GROUP_NAME);
  });

  test('AC-SCOPE-1 (regression): the direct invite of C posted NO member-admitted announcement', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await expect(pageA.getByTestId('member-admitted-announcement')).toHaveCount(0);
  });

  test('A generates an invite link; B sends a real join request through the app', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    inviteUrl = await generateInviteLink(pageA);

    const url = new URL(inviteUrl);
    await pageB.goto(url.pathname + url.search);
    await dismissErrorOverlay(pageB);
    // epic: invite-link-awaiting-landing (S3) -- User B is a returning user
    // (identity seeded via bootUser's addInitScript before navigation), so
    // this now lands on InviteAwaitingBanner, not the full-screen
    // JoinRequestCard.
    await expect(pageB.getByTestId('invite-awaiting-banner')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(GROUP_NAME)).toBeVisible();
    await pageB.getByTestId('invite-awaiting-request-btn').click();
    const nonce = url.searchParams.get('join');
    expect(nonce).toBeTruthy();
    await expect(pageB.getByTestId(`outbound-request-card-${nonce!.slice(0, 6)}`)).toBeVisible({ timeout: 30_000 });
  });

  test('AC-SEND-1: A approves the pending join request', async () => {
    // B's BrowserContext (and page) stay open throughout — never closed —
    // per the closing-playwright-browsercontext-destroys prior learning.
    const requestRow = pageA.locator('[data-testid^="pending-request-row-"]').first();
    await expect(requestRow).toBeVisible({ timeout: 60_000 });
    await pageA.locator('[data-testid^="approve-request-"]').first().click();
    await expect(pageA.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });
    // Allow the invite commit + fire-and-forget kind-9 announcement to propagate.
    await pageA.waitForTimeout(5_000);
  });

  test('AC-RENDER-1/AC-RENDER-2: the announcement renders in A\'s own chat with admitter + member names', async () => {
    const notice = pageA.getByTestId('member-admitted-announcement');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    // A is both the admitter and already knows B's provisional name (seeded
    // from the join request at approval time) — both names are asserted.
    await expect(notice).toContainText(ADMIN_NICKNAME);
    await expect(notice).toContainText(REQUESTER_NICKNAME);
  });

  test('AC-RENDER-1: the announcement also renders in C\'s chat (an already-present second member)', async () => {
    await openGroupDetail(pageC, GROUP_NAME);
    const notice = pageC.getByTestId('member-admitted-announcement');
    // C resolves the admitter (A) from C's own profileMap; C's copy of B's
    // display name may still be the truncated-npub fallback (AC-RENDER-2)
    // since B's real signed profile has not necessarily round-tripped to C
    // yet — the admitter assertion is the one this test pins precisely.
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice).toContainText(ADMIN_NICKNAME);
  });

  test('AC-SEND-1 (exactly one): only a single member-admitted announcement exists after the one approval', async () => {
    await expect(pageA.getByTestId('member-admitted-announcement')).toHaveCount(1);
  });
});
