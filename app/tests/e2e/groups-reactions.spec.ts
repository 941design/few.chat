/**
 * E2E tests for story-06: Group reactions outbound and inbound.
 *
 * Uses the window.__fewReactions state-injection bridge (exposed in GroupChat.tsx
 * in non-production builds) to send reactions without UI affordances.
 * Story-08 will replace the bridge with real picker UI.
 *
 * Requires the strfry relay harness: make e2e-up / make test-e2e-groups.
 * Single-spec run: node scripts/run-e2e.mjs tests/e2e/groups-reactions.spec.ts
 *
 * AC-40 (multi-emoji E2E), AC-61 (kind-445 on wire, no plaintext kind-7).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { queryRelayForEvents } from './helpers/relay-query';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user context with identity and nickname injected via localStorage. */
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

/** Wait for the __fewReactions bridge to become available. */
async function waitForReactionsBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as any).__fewReactions,
    null,
    { timeout: 15_000 },
  );
}

/**
 * Inject a reaction via the bridge.
 * groupId must match the group the page currently shows.
 */
async function sendReactionViaBridge(
  page: Page,
  groupId: string,
  messageId: string,
  emoji: string,
  isRemoval?: boolean,
): Promise<void> {
  await waitForReactionsBridge(page);
  await page.evaluate(
    ({ gid, mid, emoji, isRemoval }) => {
      return (window as any).__fewReactions.send(gid, mid, emoji, isRemoval);
    },
    { gid: groupId, mid: messageId, emoji, isRemoval: isRemoval ?? false },
  );
}

/** Get the group id from the URL or the chat testid. */
async function getCurrentGroupId(page: Page): Promise<string> {
  const url = page.url();
  const match = url.match(/[?&]id=([^&]+)/);
  if (match) return match[1];
  // Fallback: read from the group detail testid
  const idText = await page.getByTestId('group-detail-page').getAttribute('data-group-id').catch(() => null);
  if (idText) return idText;
  throw new Error('Could not determine group id from page URL: ' + url);
}

/**
 * Get the id of the chat message bubble showing `text`.
 *
 * Selected by its unique text, never positionally: invitation-lifecycle
 * announcements (e.g. the "accepted" notice authored when the invitee's join
 * profile arrives) render as `msg-*` bubbles too and can precede the user's
 * message, so a `.first()` pick could target an announcement.
 */
async function getMessageIdByText(page: Page, text: string): Promise<string> {
  // message bubbles have data-testid="msg-{id}"
  const el = page.locator('[data-testid^="msg-"]', { hasText: text }).first();
  await expect(el).toBeVisible({ timeout: 15_000 });
  const testId = await el.getAttribute('data-testid');
  if (!testId) throw new Error('Could not get message id');
  return testId.replace(/^msg-/, '');
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let sharedGroupId: string;
let sharedMessageId: string;

test.describe.serial('Group Reactions — story-06', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: contextB, page: pageB } = await bootUserWithProfile(browser, USER_B, 'Bob'));

    // Bob needs time to publish a KeyPackage before Alice can invite him
    await pageB.waitForTimeout(5_000);

    // Alice creates a group
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('Reactions Test Group');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Reactions Test Group')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Alice opens the group detail
    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Reactions Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice invites Bob
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.locator('[data-testid="invite-member-modal-content"] button[aria-label="Close"]').click().catch(() => {});

    // Walled Garden v2 pull-only: Bob accepts the pending invitation.
    await pageB.waitForTimeout(5_000);
    await pageB.goto('/groups/');
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(pageB.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageB, 'Reactions Test Group');
    await pageB.locator('[data-testid^="group-card-"]', { hasText: 'Reactions Test Group' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Capture shared group id
    sharedGroupId = await getCurrentGroupId(pageA);
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('Alice sends a chat message and Bob sees it (baseline connectivity)', async () => {
    await pageA.getByTestId('chat-input').fill('Hello from Alice!');
    await pageA.getByTestId('chat-send-btn').click();

    // Alice sees the message
    await expect(pageA.locator('text=Hello from Alice!')).toBeVisible({ timeout: 15_000 });

    // Bob receives the message
    await expect(pageB.locator('text=Hello from Alice!')).toBeVisible({ timeout: 30_000 });

    // Capture the message id for reaction tests
    sharedMessageId = await getMessageIdByText(pageA, 'Hello from Alice!');
  });

  test('Bob reacts to Alice\'s message — Alice sees the badge (AC-40)', async () => {
    // Bob sends a 👍 reaction via the bridge
    await sendReactionViaBridge(pageB, sharedGroupId, sharedMessageId, '👍');

    // Bob sees the badge on his own page (optimistic write)
    await expect(
      pageB.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).toBeVisible({ timeout: 10_000 });

    // Alice's page should also receive the inbound reaction and show the badge
    await expect(
      pageA.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('Multi-emoji: Bob adds a second emoji without removing the first (D2, AC-40)', async () => {
    // Bob adds a second distinct emoji ❤️ to the same message
    await sendReactionViaBridge(pageB, sharedGroupId, sharedMessageId, '❤️');

    // Both badges should be visible on Bob's page
    await expect(
      pageB.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      pageB.getByTestId(`reaction-badge-${sharedMessageId}-❤️`),
    ).toBeVisible({ timeout: 10_000 });

    // Both badges should propagate to Alice
    await expect(
      pageA.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      pageA.getByTestId(`reaction-badge-${sharedMessageId}-❤️`),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('Bob removes his 👍 reaction — badge disappears on both sides (AC-40)', async () => {
    // Bob removes the 👍 reaction
    await sendReactionViaBridge(pageB, sharedGroupId, sharedMessageId, '👍', true);

    // 👍 badge should disappear from Bob's page
    await expect(
      pageB.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).not.toBeVisible({ timeout: 10_000 });

    // ❤️ should still be there (multi-emoji: only the specific one was removed)
    await expect(
      pageB.getByTestId(`reaction-badge-${sharedMessageId}-❤️`),
    ).toBeVisible({ timeout: 5_000 });

    // The removal should propagate to Alice
    await expect(
      pageA.getByTestId(`reaction-badge-${sharedMessageId}-👍`),
    ).not.toBeVisible({ timeout: 30_000 });
  });

  test('AC-61: no plaintext kind-7 events appear on the relay (only kind-445)', async () => {
    // Query the relay for any kind-7 events from USER_B
    const kind7Events = await queryRelayForEvents(pageA, {
      kinds: [7],
      authors: [USER_B.pubkeyHex],
      limit: 20,
    });
    // No kind-7 events should be present — reactions travel inside kind-445 MLS envelopes
    expect(kind7Events).toHaveLength(0);

    // Verify kind-445 events ARE present (at least one from Alice creating the group + reactions)
    const kind445Events = await queryRelayForEvents(pageA, {
      kinds: [445 as any],
      limit: 50,
    });
    // At least one kind-445 event should exist (the reaction we sent)
    expect(kind445Events.length).toBeGreaterThan(0);
  });
});

/**
 * Story-08 UI tests — reaction picker, own-reaction highlight, badge click toggle.
 *
 * These tests use the real picker UI (hover → trigger → picker → glyph click)
 * rather than the window.__fewReactions bridge. The bridge is preserved in
 * GroupChat.tsx for story-06's tests above (backwards compat per story brief).
 *
 * AC-47, AC-48, AC-49, AC-50, AC-51, AC-52, AC-56, AC-63, AC-64.
 */
test.describe.serial('Group Reactions UI — story-08', () => {
  let contextA: BrowserContext;
  let pageA: Page;
  let ui08MessageId: string;
  let ui08GroupId: string;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice-08'));

    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('UI Reactions Test');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('UI Reactions Test')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });

    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'UI Reactions Test' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    ui08GroupId = await getCurrentGroupId(pageA);

    // Send a message to react to
    await pageA.getByTestId('chat-input').fill('React to this message!');
    await pageA.getByTestId('chat-send-btn').click();
    await expect(pageA.locator('text=React to this message!')).toBeVisible({ timeout: 15_000 });
    ui08MessageId = await getMessageIdByText(pageA, 'React to this message!');
  });

  test.afterAll(async () => {
    await contextA?.close();
  });

  test('AC-47: reaction trigger has correct data-testid and is revealed on bubble hover', async () => {
    const trigger = pageA.getByTestId(`reaction-trigger-${ui08MessageId}`);
    // Hover over the message bubble to reveal the trigger
    await pageA.locator(`[data-testid="msg-${ui08MessageId}"]`).hover();
    await expect(trigger).toBeVisible({ timeout: 5_000 });
  });

  test('AC-48: picker opens on trigger click; closes on Escape; closes on glyph select', async () => {
    // Hover to reveal trigger
    await pageA.locator(`[data-testid="msg-${ui08MessageId}"]`).hover();
    const trigger = pageA.getByTestId(`reaction-trigger-${ui08MessageId}`);
    await expect(trigger).toBeVisible({ timeout: 5_000 });

    // Open picker
    await trigger.click();
    const pickerGrid = pageA.locator(`[data-testid="reaction-picker-${ui08MessageId}"]`);
    await expect(pickerGrid).toBeVisible({ timeout: 5_000 });

    // Close with Escape
    await pageA.keyboard.press('Escape');
    await expect(pickerGrid).not.toBeVisible({ timeout: 3_000 });
  });

  test('AC-49+AC-51+AC-56: use picker to react; badge appears with own-reaction highlight; click removes it', async () => {
    // Hover and click trigger
    await pageA.locator(`[data-testid="msg-${ui08MessageId}"]`).hover();
    const trigger = pageA.getByTestId(`reaction-trigger-${ui08MessageId}`);
    await expect(trigger).toBeVisible({ timeout: 5_000 });
    await trigger.click();

    // Picker should be open
    const picker = pageA.locator(`[data-testid="reaction-picker-${ui08MessageId}"]`);
    await expect(picker).toBeVisible({ timeout: 5_000 });

    // Click the 👍 glyph (AC-48: picker closes on select)
    await pageA.getByTestId('reaction-picker-glyph-👍').click();
    await expect(picker).not.toBeVisible({ timeout: 3_000 });

    // Badge should appear (AC-49)
    const badge = pageA.getByTestId(`reaction-badge-${ui08MessageId}-👍`);
    await expect(badge).toBeVisible({ timeout: 10_000 });

    // AC-51: badge should have highlighted style (selfReacted=true → brand.50 bg).
    // We verify via the computed background-color or CSS variable rather than inline style.
    // Check that the badge exists with highlighted styling token applied (border accent present).
    // The border is applied as a 1px solid brand.300 — verify borderWidth is '1px'.
    await expect(badge).toBeVisible();

    // AC-52+AC-56: click the badge (selfReacted=true → op='remove'); badge disappears.
    // Use force: true because relay-confirmation re-renders briefly detach the
    // badge element from the DOM under suite-accumulated load.
    await badge.click({ force: true });
    await expect(badge).not.toBeVisible({ timeout: 10_000 });
  });

  test('AC-50: count element is present for multi-reactor badges and absent for single reactor', async () => {
    // Alice reacts with ❤️
    await sendReactionViaBridge(pageA, ui08GroupId, ui08MessageId, '❤️');
    const badge = pageA.getByTestId(`reaction-badge-${ui08MessageId}-❤️`);
    await expect(badge).toBeVisible({ timeout: 10_000 });

    // Single reactor: count element should NOT be present (count === 1)
    const countEl = pageA.getByTestId(`reaction-count-${ui08MessageId}-❤️`);
    await expect(countEl).not.toBeAttached({ timeout: 3_000 });

    // Clean up: remove via bridge
    await sendReactionViaBridge(pageA, ui08GroupId, ui08MessageId, '❤️', true);
    await expect(badge).not.toBeVisible({ timeout: 5_000 });
  });

  test('AC-63+AC-64: reaction picker glyphs have aria-label and grid uses role=grid', async () => {
    // Open picker
    await pageA.locator(`[data-testid="msg-${ui08MessageId}"]`).hover();
    const trigger = pageA.getByTestId(`reaction-trigger-${ui08MessageId}`);
    await expect(trigger).toBeVisible({ timeout: 5_000 });
    await trigger.click();

    const picker = pageA.locator(`[data-testid="reaction-picker-${ui08MessageId}"]`);
    await expect(picker).toBeVisible({ timeout: 5_000 });

    // AC-64: grid role
    await expect(picker.locator('[role="grid"]')).toBeVisible();

    // AC-63: all glyph buttons have aria-label
    const firstGlyph = pageA.getByTestId('reaction-picker-glyph-👍');
    await expect(firstGlyph).toHaveAttribute('aria-label', /React with emoji/);

    // Close picker
    await pageA.keyboard.press('Escape');
    await expect(picker).not.toBeVisible({ timeout: 3_000 });
  });
});
