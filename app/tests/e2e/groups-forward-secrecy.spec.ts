// Forward-secrecy coverage: a member added at epoch N must never see
// application messages encrypted at epoch < N. ts-mls enforces this by
// reporting prior-epoch ciphertext as `skipped`, but the relay still
// delivers those events to the new member's NDK subscription. These tests
// verify the UI-level outcome — pre-join chat messages do not appear.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (!localStorage.getItem('lp_userProfile_v1')) {
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

async function createGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(groupName);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function inviteAndJoin(
  inviterPage: Page,
  inviteeNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  // Walled Garden v2 pull-only flow: stale gift wraps published by earlier
  // tests in the same suite stream into the invitee's pending-invitation queue
  // and would cause `.first().click()` to accept the wrong invitation. Let the
  // welcome subscription consume them into the seen-set, then clear the queue
  // so the fresh invite below is the sole entry.
  await inviteePage.goto('/groups/');
  await inviteePage.waitForTimeout(10_000);
  await inviteePage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteeNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await inviterPage.keyboard.press('Escape');

  // Walled Garden v2: pull-only invitations — invitee must explicitly accept.
  await inviteePage.waitForTimeout(5_000);
  await inviteePage.goto('/groups/');
  await expect(inviteePage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
  await expect(inviteePage.locator('[data-testid^="pending-invitation-row-"]').first()).toBeVisible({ timeout: 30_000 });
  await acceptInvitationAndWaitJoined(inviteePage, groupName);
  await inviteePage.waitForTimeout(10_000);
}

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send-btn').click();
  // Wait for optimistic render so the message has actually been sent locally
  await expect(
    page.locator('[data-testid^="msg-"]').filter({ hasText: text }),
  ).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Suite 1: Two-party — A sends messages alone, then invites B
//
// Boundary case: A is the only member when the messages are sent (epoch 0).
// B's Add commit creates epoch 1, and B's Welcome carries epoch-1 secrets only.
// ---------------------------------------------------------------------------

test.describe.serial('Forward secrecy: solo creator messages are invisible to first joiner', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  const GROUP_NAME = 'Forward Secrecy Solo';
  const PRE_JOIN_MSG_1 = 'pre-join-secret-alpha-001';
  const PRE_JOIN_MSG_2 = 'pre-join-secret-alpha-002';
  const POST_JOIN_MSG = 'post-join-public-alpha-003';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates group alone and sends two messages at epoch 0', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await sendChatMessage(pgA, PRE_JOIN_MSG_1);
    await sendChatMessage(pgA, PRE_JOIN_MSG_2);
    // Let kind 445 events propagate to relay before B joins
    await pgA.waitForTimeout(3_000);
    // Wait for B to publish KeyPackages
    await pgB.waitForTimeout(5_000);
  });

  test('A invites B; B joins at epoch 1', async () => {
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
    await openGroupDetail(pgB, GROUP_NAME);
    await expect(pgB.getByTestId('chat-scroll-container')).toBeVisible({ timeout: 10_000 });
    // Allow time for relay to deliver historical kind 445 events; ts-mls
    // should report them as `skipped` and they should NOT reach the chat UI.
    await pgB.waitForTimeout(15_000);
  });

  test('B does not see either pre-join message', async () => {
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: PRE_JOIN_MSG_1 }),
    ).toHaveCount(0);
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: PRE_JOIN_MSG_2 }),
    ).toHaveCount(0);
  });

  test('B sees A\'s post-join message (sanity: forward direction works)', async () => {
    await sendChatMessage(pgA, POST_JOIN_MSG);
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: POST_JOIN_MSG }),
    ).toBeVisible({ timeout: 30_000 });
    // Pre-join messages still must not appear after the post-join arrives
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: PRE_JOIN_MSG_1 }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Three-party — established A+B group, then invite C
//
// Realistic case: chat history exists at epoch 1 (sent by both A and B).
// C joins at epoch 2; none of epoch 1 should be visible.
// ---------------------------------------------------------------------------

test.describe.serial('Forward secrecy: established-group history is invisible to third joiner', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let pgC: Page;
  const GROUP_NAME = 'Forward Secrecy Trio';
  const ALICE_E1_MSG = 'alice-epoch1-message-beta-001';
  const BOB_E1_MSG = 'bob-epoch1-message-beta-002';
  const ALICE_E2_MSG = 'alice-epoch2-message-beta-003';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
    ({ context: ctxC, page: pgC } = await bootUserWithProfile(browser, USER_C, 'Carol'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('A creates group and invites B', async () => {
    await createGroupAndOpen(pgA, GROUP_NAME);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
  });

  test('A and B exchange messages at epoch 1', async () => {
    await openGroupDetail(pgA, GROUP_NAME);
    await openGroupDetail(pgB, GROUP_NAME);

    await sendChatMessage(pgA, ALICE_E1_MSG);
    // B must observe A's message before replying so both are at epoch 1
    await expect(
      pgB.locator('[data-testid^="msg-"]').filter({ hasText: ALICE_E1_MSG }),
    ).toBeVisible({ timeout: 30_000 });

    await sendChatMessage(pgB, BOB_E1_MSG);
    await expect(
      pgA.locator('[data-testid^="msg-"]').filter({ hasText: BOB_E1_MSG }),
    ).toBeVisible({ timeout: 30_000 });

    // Wait for kind 445 to settle on relays before next epoch transition
    await pgA.waitForTimeout(3_000);
    await pgC.waitForTimeout(5_000);
  });

  test('A invites C; C joins at epoch 2', async () => {
    await openGroupDetail(pgA, GROUP_NAME);
    await inviteAndJoin(pgA, USER_C.npub, pgC, GROUP_NAME);
    await openGroupDetail(pgC, GROUP_NAME);
    await expect(pgC.getByTestId('chat-scroll-container')).toBeVisible({ timeout: 10_000 });
    // Allow generous time for historical kind 445 events to be delivered;
    // they must remain hidden because their epoch is < C's join epoch.
    await pgC.waitForTimeout(15_000);
  });

  test('C does not see Alice\'s epoch-1 message', async () => {
    await expect(
      pgC.locator('[data-testid^="msg-"]').filter({ hasText: ALICE_E1_MSG }),
    ).toHaveCount(0);
  });

  test('C does not see Bob\'s epoch-1 message', async () => {
    await expect(
      pgC.locator('[data-testid^="msg-"]').filter({ hasText: BOB_E1_MSG }),
    ).toHaveCount(0);
  });

  test('C sees A\'s epoch-2 message (sanity)', async () => {
    await sendChatMessage(pgA, ALICE_E2_MSG);
    await expect(
      pgC.locator('[data-testid^="msg-"]').filter({ hasText: ALICE_E2_MSG }),
    ).toBeVisible({ timeout: 30_000 });
    // Epoch-1 messages still hidden after a fresh epoch-2 message arrives
    await expect(
      pgC.locator('[data-testid^="msg-"]').filter({ hasText: ALICE_E1_MSG }),
    ).toHaveCount(0);
    await expect(
      pgC.locator('[data-testid^="msg-"]').filter({ hasText: BOB_E1_MSG }),
    ).toHaveCount(0);
  });
});
