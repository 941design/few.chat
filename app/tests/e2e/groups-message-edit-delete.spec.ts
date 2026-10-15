/**
 * E2E tests for story-07 (message edit & delete epic): group coverage.
 *
 * Drives the real UI (hover → action-edit-<id>/action-delete-<id> → confirm/save)
 * through the __fewGroupMessageEdits-backed handleDeleteMessage/handleEditMessage
 * paths in ChatStoreContext.tsx (consumed by GroupChat's ChatBox instance).
 *
 * Requires the strfry relay harness: make e2e-up.
 * Single-spec run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-message-edit-delete.spec.ts
 *
 * Covers (acceptance-criteria.md):
 *   AC-DEL-1 (text + image), AC-DEL-3, AC-DEL-6, AC-EDIT-1, AC-EDIT-2,
 *   AC-EDIT-3, AC-EDIT-5, AC-AUTH-1, AC-IMG-1, AC-IMG-2 — group transport.
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import path from 'node:path';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const FIXTURE_IMAGE = path.join(__dirname, '../fixtures/test-image.png');
const GROUP_NAME = 'S7 Group Edit Delete';

// ─── Boot helpers ───────────────────────────────────────────────────────────

/** Boot a user context with identity and nickname injected via localStorage. */
async function bootUserWithProfile(
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
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

/** Send a text group message via the real composer and return the new bubble's message id. */
async function sendGroupMessageAndGetId(page: Page, content: string): Promise<string> {
  const before = new Set(
    await page.locator('[data-testid^="msg-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
  );
  await page.getByTestId('chat-input').fill(content);
  await page.getByTestId('chat-send-btn').click();

  const bubble = page.locator('[data-testid^="msg-"]').filter({ hasText: content }).first();
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  const testId = await bubble.getAttribute('data-testid');
  const id = testId?.replace('msg-', '') ?? '';
  expect(id).toBeTruthy();
  expect(before.has(`msg-${id}`)).toBe(false);
  return id;
}

/** Attach + send the fixture image via the real composer; return the new bubble's message id. */
async function sendGroupImageAndGetId(page: Page, caption = ''): Promise<string> {
  const before = new Set(
    await page.locator('[data-testid^="msg-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
  );

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('image-attachment-button').click(),
  ]);
  await fileChooser.setFiles(FIXTURE_IMAGE);
  await expect(page.getByTestId('image-preview-thumbnail')).toBeVisible({ timeout: 10_000 });

  if (caption) await page.getByTestId('chat-input').fill(caption);
  await page.getByTestId('chat-send-btn').click();
  await expect(page.getByTestId('image-preview-thumbnail')).not.toBeVisible({ timeout: 30_000 });

  // Resolve the newly-sent bubble against the before-snapshot (not merely
  // "first image thumbnail in DOM order") so this stays correct if another
  // image test is ever added to this file — mirrors sendGroupMessageAndGetId.
  const bubble = page
    .getByTestId('image-thumbnail')
    .locator('xpath=ancestor::*[starts-with(@data-testid, "msg-")]')
    .first();
  await expect(bubble).toBeVisible({ timeout: 60_000 });
  const testId = await bubble.getAttribute('data-testid');
  const id = testId?.replace('msg-', '') ?? '';
  expect(id).toBeTruthy();
  expect(before.has(`msg-${id}`)).toBe(false);
  return id;
}

/** Hover a message row and click its delete icon (arms the two-click confirm). */
async function armDelete(page: Page, messageId: string): Promise<void> {
  const row = page.locator(`[data-testid="msg-${messageId}"]`);
  await row.hover();
  await page.getByTestId(`action-delete-${messageId}`).click();
  await expect(page.getByTestId(`action-delete-confirm-row-${messageId}`)).toBeVisible({ timeout: 5_000 });
}

/** Full two-click delete flow via the real UI (AC-DEL-6). */
async function deleteMessageViaUi(page: Page, messageId: string): Promise<void> {
  await armDelete(page, messageId);
  await page.getByTestId(`action-delete-confirm-${messageId}`).click();
}

/** Enter edit mode, replace content, and save (AC-EDIT-1/2). */
async function editMessageViaUi(page: Page, messageId: string, newContent: string): Promise<void> {
  const row = page.locator(`[data-testid="msg-${messageId}"]`);
  await row.hover();
  await page.getByTestId(`action-edit-${messageId}`).click();
  await expect(page.getByTestId('chat-edit-banner')).toBeVisible({ timeout: 5_000 });
  const input = page.getByTestId('chat-input');
  await input.fill(newContent);
  await page.getByTestId('chat-send-btn').click();
  await expect(page.getByTestId('chat-edit-banner')).not.toBeVisible({ timeout: 15_000 });
}

/** Assert a given message id has disappeared (tombstoned/silent removal, AC-DEL-3). */
async function expectMessageGone(page: Page, messageId: string): Promise<void> {
  await expect.poll(
    () => page.locator(`[data-testid="msg-${messageId}"]`).count(),
    { timeout: 30_000 },
  ).toBe(0);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe.serial('Group message edit & delete — S7', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page; // Alice
  let pageB: Page; // Bob

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: contextB, page: pageB } = await bootUserWithProfile(browser, USER_B, 'Bob'));

    // Bob needs time to publish a KeyPackage before Alice can invite him.
    await pageB.waitForTimeout(5_000);

    // Alice creates the group.
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill(GROUP_NAME);
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Alice opens the group detail.
    await pageA.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice invites Bob.
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.locator('[data-testid="invite-member-modal-content"] button[aria-label="Close"]').click().catch(() => {});

    // Bob accepts the pending invitation (Walled Garden v2 pull-only).
    await pageB.waitForTimeout(5_000);
    await pageB.goto('/groups/');
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(pageB.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageB, GROUP_NAME);
    await pageB.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageB);
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('AC-DEL-1/AC-DEL-3: Alice deletes an authored text group message; disappears for her and Bob', async () => {
    const content = `del-text-${Date.now()}`;
    const id = await sendGroupMessageAndGetId(pageA, content);

    await expect(pageB.locator(`[data-testid="msg-${id}"]`)).toBeVisible({ timeout: 30_000 });

    await deleteMessageViaUi(pageA, id);

    await expectMessageGone(pageA, id);
    await expectMessageGone(pageB, id);
  });

  // Attachments are deprecated (ATTACHMENTS_ENABLED, app/src/config/features.ts).
  // This asserts the toggle's product behavior on the GROUP surface in a real
  // browser: the composer mounts and sends text (proved by the tests around
  // this one), but offers no way to attach. Kept alongside the skipped image
  // tests below so the group composer is never left without attach coverage in
  // one direction or the other.
  test('ATTACHMENTS_ENABLED off: the group composer offers no attach button', async () => {
    await expect(pageA.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('image-attachment-button')).toHaveCount(0);
  });

  // Skipped while ATTACHMENTS_ENABLED is off: this test's fixture is an image
  // sent through the real composer, which no longer has an attach button. The
  // text-message delete path (AC-DEL-1) stays covered by the test above.
  test.skip('AC-DEL-1/AC-IMG-1: Alice deletes an authored image group message; disappears for her and Bob', async () => {
    const id = await sendGroupImageAndGetId(pageA, `del-image-${Date.now()}`);

    await expect(pageB.locator(`[data-testid="msg-${id}"]`)).toBeVisible({ timeout: 60_000 });

    await deleteMessageViaUi(pageA, id);

    await expectMessageGone(pageA, id);
    await expectMessageGone(pageB, id);
  });

  test('AC-EDIT-1/AC-EDIT-2/AC-EDIT-3: Alice edits an authored text group message in place; both sides show new content + edited marker', async () => {
    const original = `edit-orig-${Date.now()}`;
    const updated = `edit-updated-${Date.now()}`;
    const id = await sendGroupMessageAndGetId(pageA, original);

    const bobBubbleBeforeEdit = pageB.locator(`[data-testid="msg-${id}"]`);
    await expect(bobBubbleBeforeEdit).toBeVisible({ timeout: 30_000 });
    // Pre-edit baseline: both sides show the original content and no marker,
    // so the "old content there, then replaced, marker appears" narrative is
    // fully asserted within this test rather than assumed.
    await expect(pageA.locator(`[data-testid="msg-${id}"]`)).toContainText(original);
    await expect(bobBubbleBeforeEdit).toContainText(original);
    await expect(pageA.getByTestId(`edited-marker-${id}`)).not.toBeAttached();
    await expect(pageB.getByTestId(`edited-marker-${id}`)).not.toBeAttached();

    await editMessageViaUi(pageA, id, updated);

    // AC-EDIT-2: in-place update — same slot id, new content.
    const aliceBubble = pageA.locator(`[data-testid="msg-${id}"]`);
    await expect(aliceBubble).toContainText(updated, { timeout: 10_000 });
    await expect(pageA.locator('[data-testid^="msg-"]').filter({ hasText: original })).toHaveCount(0);
    // AC-EDIT-3
    await expect(pageA.getByTestId(`edited-marker-${id}`)).toBeVisible({ timeout: 10_000 });

    // Bob sees the same slot updated in place — same testid, new content, marker.
    const bobBubble = pageB.locator(`[data-testid="msg-${id}"]`);
    await expect(bobBubble).toContainText(updated, { timeout: 30_000 });
    await expect(pageB.getByTestId(`edited-marker-${id}`)).toBeVisible({ timeout: 15_000 });
  });

  test('AC-AUTH-1: edit/delete affordances appear only on the author\'s own message', async () => {
    const content = `auth-check-${Date.now()}`;
    const id = await sendGroupMessageAndGetId(pageA, content);
    await expect(pageB.locator(`[data-testid="msg-${id}"]`)).toBeVisible({ timeout: 30_000 });

    // Bob's page: Alice's message is not his own — action buttons must not
    // even be attached to the DOM (not just visually hidden).
    await pageB.locator(`[data-testid="msg-${id}"]`).hover();
    await expect(pageB.getByTestId(`action-edit-${id}`)).not.toBeAttached();
    await expect(pageB.getByTestId(`action-delete-${id}`)).not.toBeAttached();

    // Alice's page: her own message — action buttons attached after hover.
    await pageA.locator(`[data-testid="msg-${id}"]`).hover();
    await expect(pageA.getByTestId(`action-edit-${id}`)).toBeAttached();
    await expect(pageA.getByTestId(`action-delete-${id}`)).toBeAttached();
  });

  test('AC-DEL-6: a single click on delete does not remove the message; only the confirm click does', async () => {
    const content = `del6-${Date.now()}`;
    const id = await sendGroupMessageAndGetId(pageA, content);

    await armDelete(pageA, id);
    // First click armed the confirm row but must NOT have deleted yet.
    await expect(pageA.getByTestId(`msg-${id}`)).toBeAttached();
    await expect(pageA.getByTestId(`action-delete-confirm-row-${id}`)).toBeVisible();

    await pageA.getByTestId(`action-delete-confirm-${id}`).click();
    await expectMessageGone(pageA, id);
  });

  test('AC-EDIT-5: empty edit content is disallowed; cancel restores the original untouched', async () => {
    const original = `edit5-keep-${Date.now()}`;
    const id = await sendGroupMessageAndGetId(pageA, original);

    const row = pageA.locator(`[data-testid="msg-${id}"]`);
    await row.hover();
    await pageA.getByTestId(`action-edit-${id}`).click();
    await expect(pageA.getByTestId('chat-edit-banner')).toBeVisible({ timeout: 5_000 });

    const input = pageA.getByTestId('chat-input');
    await input.fill('   ');
    await expect(pageA.getByTestId('chat-edit-empty-hint')).toBeVisible({ timeout: 5_000 });
    await expect(pageA.getByTestId('chat-send-btn')).toBeDisabled();

    await pageA.getByTestId('chat-edit-cancel').click();
    await expect(pageA.getByTestId('chat-edit-banner')).not.toBeVisible({ timeout: 5_000 });

    // Original message untouched — still present, unedited.
    await expect(pageA.locator(`[data-testid="msg-${id}"]`)).toContainText(original);
    await expect(pageA.getByTestId(`edited-marker-${id}`)).not.toBeAttached();
  });

  // Skipped while ATTACHMENTS_ENABLED is off — see AC-DEL-1/AC-IMG-1 above.
  test.skip('AC-IMG-2: an image message offers delete but not edit', async () => {
    const id = await sendGroupImageAndGetId(pageA, `img2-${Date.now()}`);

    const row = pageA.locator(`[data-testid="msg-${id}"]`);
    await row.hover();
    await expect(pageA.getByTestId(`action-edit-${id}`)).not.toBeAttached();
    await expect(pageA.getByTestId(`action-delete-${id}`)).toBeAttached();
  });
});
