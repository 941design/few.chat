/**
 * E2E regression sentinel for the unified MLS application-rumor dispatcher.
 *
 * Verifies that an own-send chat message produces exactly one IDB row and
 * exactly one rendered bubble — the structural outcome guaranteed by having a
 * single message-carrying subscriber (marmot-ts 0.7.0 onward:
 * `group.on('authenticatedApplicationMessage')`; pre-0.7.0 this was the raw
 * `group.on('applicationMessage')` event — see AC-SEAM-2, epic
 * marmot-ts-authenticated-sender-migration).
 *
 * AC-AR-21, AC-AR-22.
 *
 * Requires the strfry relay harness: make e2e-up / make test-e2e-groups.
 * Single-spec run: node scripts/run-e2e.mjs tests/e2e/groups-dispatch-isolation.spec.ts
 *
 * AC-AR-3 canary: if a future epic introduces a second message-carrying
 * subscriber, the double-write symptom this test catches will surface
 * immediately. Verify manually: grep -r "group.on('authenticatedApplicationMessage'" app/src/ -l
 * should return exactly one file: applicationRumorDispatcher.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { readIdbRecord } from './helpers/idb-record';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** IDB store details for chat messages. */
const CHAT_IDB_DB = 'keyval-store';
const CHAT_IDB_STORE = 'keyval';

/**
 * Boot a user context with identity and nickname injected via localStorage.
 * Mirrors the pattern from groups-reactions.spec.ts.
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

/** Extract the group id from the current page URL query param. */
async function getCurrentGroupId(page: Page): Promise<string> {
  const url = page.url();
  const match = url.match(/[?&]id=([^&]+)/);
  if (match) return match[1];
  const idText = await page.getByTestId('group-detail-page').getAttribute('data-group-id').catch(() => null);
  if (idText) return idText;
  throw new Error('Could not determine group id from page URL: ' + url);
}

/**
 * Resolve the id of the chat message bubble that renders `text`.
 *
 * Selects by the unique text, NOT "the first msg-* bubble": the group chat
 * also renders invite-lifecycle announcement bubbles (`invited`, `accepted`)
 * under the same `msg-{id}` testid, and the `invited` one is the first bubble
 * in the log, so a positional pick would silently track the wrong message.
 */
async function getMessageIdByText(page: Page, text: string): Promise<string> {
  const el = page.locator('[data-testid^="msg-"]', { hasText: text }).first();
  await expect(el).toBeVisible({ timeout: 15_000 });
  const testId = await el.getAttribute('data-testid');
  if (!testId) throw new Error('Could not read data-testid from message bubble');
  return testId.replace(/^msg-/, '');
}

type ChatIdbWrite = { groupId: string; messageId: string };

/**
 * Every chat-row insert reported by the dev-only `__fewTest.onChatIdbWrite`
 * hook since the page booted (installed inline in beforeAll), in order.
 * The counter is NOT scoped to one message: background lifecycle
 * announcements (e.g. the `accepted` announcement Alice authors when Bob's
 * join profile reaches her) also fire it, so assertions must filter by id.
 */
async function getChatIdbWrites(page: Page): Promise<ChatIdbWrite[]> {
  return page.evaluate(() => (window as any).__chatIdbWrites ?? []);
}

// ─── Module-scoped state shared across serial tests ───────────────────────
let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let sharedGroupId: string;
let sharedMessageId: string;

test.describe.serial('groups-dispatch-isolation', () => {
  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();

    // Install the IDB write counter before any page navigation so the init
    // script runs before the app loads.  We call newContext manually here so
    // we can call addInitScript before opening the first page.
    contextA = await browser.newContext({ baseURL: BASE_URL });
    await suppressErrorOverlay(contextA);
    // Seed identity so clearAppState does not wipe it.
    await contextA.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
      // IDB write recorder for AC-AR-22
      (window as any).__fewTest = (window as any).__fewTest ?? {};
      (window as any).__chatIdbWrites = [];
      (window as any).__fewTest.onChatIdbWrite = (args: { groupId: string; messageId: string }) => {
        (window as any).__chatIdbWrites.push({ groupId: args.groupId, messageId: args.messageId });
      };
    }, {
      privateKeyHex: USER_A.privateKeyHex,
      pubkeyHex: USER_A.pubkeyHex,
      seedHex: USER_A.seedHex,
      nickname: 'Alice',
    });
    pageA = await contextA.newPage();
    await pageA.goto('/');
    await clearAppState(pageA);
    await pageA.reload();
    await pageA.goto('/groups/');
    await expect(
      pageA.getByTestId('groups-empty-state').or(pageA.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });

    // Boot User B using the shared helper (no IDB counter needed for B in this story).
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
    await pageA.getByTestId('create-group-name-input').fill('Dispatch Isolation Test');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Dispatch Isolation Test')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pageA);

    // Alice opens the group detail.
    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Dispatch Isolation Test' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Capture the group id before inviting so we know it for IDB queries.
    sharedGroupId = await getCurrentGroupId(pageA);

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
    await acceptInvitationAndWaitJoined(pageB, 'Dispatch Isolation Test');
    await pageB.locator('[data-testid^="group-card-"]', { hasText: 'Dispatch Isolation Test' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  /**
   * Scenario 1 (AC-AR-21, AC-AR-22): own-send produces exactly one IDB row
   * and exactly one rendered bubble.
   *
   * The IDB write hook (onChatIdbWrite) must fire exactly once FOR THE SENT
   * MESSAGE: the optimistic write from sendMessage.  marmot-ts drops the
   * relay echo of an own-send (#sentEventIds), so it normally never reaches
   * the dispatcher; should one ever get through, appendMessage's
   * insert-if-absent check (same rumor id) skips it without firing the hook,
   * so the sent id is still reported once.  The hook is global to the page, so it is
   * filtered by message id: unrelated background writes (the `accepted`
   * lifecycle announcement Alice authors when Bob's join profile arrives)
   * legitimately fire it too and are not a double-write.
   */
  test('own-send: exactly one IDB row and one rendered bubble (AC-AR-21, AC-AR-22)', async () => {
    const uniqueText = `dispatch-isolation-${Date.now()}`;
    await pageA.getByTestId('chat-input').fill(uniqueText);
    await pageA.getByTestId('chat-send-btn').click();

    // Alice sees her own message.
    await expect(pageA.locator(`text=${uniqueText}`)).toBeVisible({ timeout: 15_000 });

    // Capture the message id from the rendered bubble.
    sharedMessageId = await getMessageIdByText(pageA, uniqueText);

    // Allow the relay round-trip time to settle — if a double-write were to
    // occur it would happen within this window.
    await pageA.waitForTimeout(5_000);

    // --- IDB row count assertion (AC-AR-21) ---
    // Read the raw array stored under "few:messages:{groupId}".
    const idbKey = `few:messages:${sharedGroupId}`;
    const storedMessages = await readIdbRecord<{ id: string; content: string }[]>(pageA, CHAT_IDB_DB, CHAT_IDB_STORE, idbKey);
    expect(storedMessages).not.toBeNull();
    // The id must belong to the user-sent chat message, not an announcement.
    const sentRows = (storedMessages ?? []).filter((m) => m.content === uniqueText);
    // Exactly one row carries the sent text — catches a duplicate written
    // under a second id/key, which the id filter below cannot see.
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].id).toBe(sharedMessageId);
    const matching = (storedMessages ?? []).filter((m) => m.id === sharedMessageId);
    // Exactly one row for the sent message id — a double-write would produce 2
    // rows (dedup would prevent it in practice, but this assertion verifies
    // the count at the IDB level after all writes have settled).
    expect(matching).toHaveLength(1);

    // --- Rendered bubble count (AC-AR-21) ---
    // Exactly one [data-testid="msg-{id}"] element must be in the DOM.
    await expect(pageA.locator(`[data-testid="msg-${sharedMessageId}"]`)).toHaveCount(1);

    // --- onChatIdbWrite hook (AC-AR-22) ---
    // Exactly one insert for the sent message: the optimistic write.  Writes
    // for other messages (lifecycle announcements) are out of scope here.
    const writes = await getChatIdbWrites(pageA);
    const sentWrites = writes.filter((w) => w.messageId === sharedMessageId);
    expect(sentWrites).toHaveLength(1);
    expect(sentWrites[0].groupId).toBe(sharedGroupId);
  });

  /**
   * Scenario 2 (AC-AR-21): peer sees exactly one bubble.
   *
   * User B must see exactly one rendered bubble for Alice's message —
   * confirming the dispatcher emits a single UI update even when
   * the relay delivers the event.
   */
  test('peer sees exactly one bubble (AC-AR-21)', async () => {
    // Bob is already on the group detail page from beforeAll.
    // Wait for Alice's message to propagate.
    await expect(pageB.locator(`[data-testid="msg-${sharedMessageId}"]`)).toBeVisible({ timeout: 30_000 });

    // Allow the relay round-trip to fully settle before counting.
    await pageB.waitForTimeout(3_000);

    // Exactly one bubble on Bob's side.
    await expect(pageB.locator(`[data-testid="msg-${sharedMessageId}"]`)).toHaveCount(1);

    // IDB on Bob's side must also have exactly one entry for the message id.
    const idbKey = `few:messages:${sharedGroupId}`;
    const storedMessages = await readIdbRecord<{ id: string }[]>(pageB, CHAT_IDB_DB, CHAT_IDB_STORE, idbKey);
    expect(storedMessages).not.toBeNull();
    const matching = (storedMessages ?? []).filter((m) => m.id === sharedMessageId);
    expect(matching).toHaveLength(1);
  });
});
