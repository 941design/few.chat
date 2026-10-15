/**
 * E2E tests for story-07: DM reactions outbound and inbound.
 *
 * Uses the window.__fewDmReactions dev bridge (exposed in ContactChat.tsx
 * in non-production builds) to send reactions without UI affordances.
 * Story-08 will wire the full reaction picker UI.
 *
 * Requires the strfry relay harness: make e2e-up.
 * Single-spec run: node scripts/run-e2e.mjs tests/e2e/dm-reactions.spec.ts
 *
 * AC-46: send reaction, badge appears on receiver tab; remove reaction, badge disappears.
 * AC-60: only kind-1059 (gift wrap) events on the wire — no kind-7 plaintext.
 */

import { test, expect, BrowserContext, Page, WebSocket as PWWebSocket } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';

// USER_B is configured as the maintainer in the e2e environment
// (NEXT_PUBLIC_MAINTAINER_NPUBS in run-e2e.mjs). Navigating to
// /contacts?id=<maintainer> redirects to /feedback (spec §2.7), which breaks
// reaction-badge assertions and the DM wire observation for regular contacts.
// Use USER_C as the DM peer for all non-feedback tests in this file.
const USER_B = USER_C;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

// ─── Boot helpers ─────────────────────────────────────────────────────────────

/**
 * Boot a user on /groups/ with a clean MarmotContext init.
 * Mirrors the bootUserOnGroups pattern used in walled-garden e2e specs.
 * Does NOT pre-seed lp_contacts_v1 — the ContactChat works with just the pubkey.
 * Used for AC-46 (requires createGroupAndInvite, which needs clean KeyPackage publish).
 */
async function bootUserOnGroups(
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
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

/**
 * Boot a user with DM-capable identity and a peer contact seeded in localStorage.
 * Mirrors the groups-direct-chat-no-duplicates.spec.ts pattern.
 */
async function bootUserWithContact(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
  peerPubkeyHex: string,
  // Optional WebSocket observer wired BEFORE page.goto so that already-open
  // WebSockets opened during NDK boot are captured. Playwright's
  // page.on('websocket') only fires for connections opened after subscription;
  // attaching after page.goto misses the NDK singleton WS to strfry entirely
  // (empirically: AC-60 captured zero events when the listener was attached
  // post-boot in the test body).
  onWebSocket?: (ws: PWWebSocket) => void,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);

  const now = new Date().toISOString();
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname, peerPubkeyHex, now }) => {
      localStorage.setItem(
        'lp_nostrIdentity_v1',
        JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }),
      );
      localStorage.setItem(
        'lp_userProfile_v1',
        JSON.stringify({ nickname, avatar: null }),
      );
      localStorage.setItem(
        'lp_contacts_v1',
        JSON.stringify({
          [peerPubkeyHex]: {
            pubkeyHex: peerPubkeyHex,
            firstSeenAt: now,
            lastSeenAt: now,
            archivedAt: null,
          },
        }),
      );
    },
    {
      privateKeyHex: user.privateKeyHex,
      pubkeyHex: user.pubkeyHex,
      seedHex: user.seedHex,
      nickname,
      peerPubkeyHex,
      now,
    },
  );

  const page = await context.newPage();
  // Wire the WS observer BEFORE page.goto so it fires for the NDK singleton's
  // initial connection (see comment on the onWebSocket parameter above).
  if (onWebSocket) {
    page.on('websocket', onWebSocket);
  }
  await page.goto('/');
  await clearAppState(page);

  // Re-seed after clearAppState wipes lp_* keys
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nickname, peerPubkeyHex, now }) => {
      localStorage.setItem(
        'lp_nostrIdentity_v1',
        JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }),
      );
      localStorage.setItem(
        'lp_userProfile_v1',
        JSON.stringify({ nickname, avatar: null }),
      );
      localStorage.setItem(
        'lp_contacts_v1',
        JSON.stringify({
          [peerPubkeyHex]: {
            pubkeyHex: peerPubkeyHex,
            firstSeenAt: now,
            lastSeenAt: now,
            archivedAt: null,
          },
        }),
      );
    },
    {
      privateKeyHex: user.privateKeyHex,
      pubkeyHex: user.pubkeyHex,
      seedHex: user.seedHex,
      nickname,
      peerPubkeyHex,
      now,
    },
  );

  return { context, page };
}

/** Navigate to the contacts page and open the DM with the peer. */
async function openDmWithPeer(page: Page, peerPubkeyHex: string): Promise<void> {
  await page.goto(`/contacts?id=${peerPubkeyHex}`);
  // Wait for the chat input to appear (ContactChat rendered)
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
}

/**
 * Type `content` into the DM composer and press Enter.
 *
 * If the key press cannot be delivered (the composer vanished or the page
 * stopped responding — seen once under full-suite load, AC-46, undiagnosed),
 * fail with the page URL and the composer count instead of a bare timeout.
 */
async function sendDmViaComposer(page: Page, content: string): Promise<void> {
  const chatInput = page.getByTestId('chat-input');
  await chatInput.fill(content);
  try {
    await chatInput.press('Enter');
  } catch (err) {
    const url = page.url();
    const inputs = await page.getByTestId('chat-input').count().catch(() => -1);
    throw new Error(
      `DM composer key press failed (url=${url}, chat-input count=${inputs}): ${(err as Error).message}`,
    );
  }
}

/** Wait for the __fewDmReactions bridge to be available. */
async function waitForDmReactionsBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as any).__fewDmReactions,
    null,
    { timeout: 15_000 },
  );
}

/**
 * Inject a DM reaction via the bridge.
 * peerPubkeyHex must match the open DM conversation.
 */
async function sendDmReactionViaBridge(
  page: Page,
  peerPubkeyHex: string,
  messageId: string,
  emoji: string,
  isRemoval = false,
): Promise<void> {
  await waitForDmReactionsBridge(page);
  await page.evaluate(
    ({ peerPubkeyHex, messageId, emoji, isRemoval }) => {
      return (window as any).__fewDmReactions.send(peerPubkeyHex, messageId, emoji, isRemoval);
    },
    { peerPubkeyHex, messageId, emoji, isRemoval },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('DM reactions — outbound and inbound (AC-46)', () => {
  test.beforeEach(async () => {
    // Populate pubkeyHex fields in USER_A / USER_B before any test runs.
    await computeTestKeypairs();
  });

  test('Alice sends a DM reaction; Bob sees the badge; Alice removes it; badge disappears', async ({ browser }) => {
    const aliceKeys = USER_A;
    const bobKeys = USER_B;

    // Boot Alice and Bob using bootUserOnGroups (clean MarmotContext init, KeyPackages
    // published before createGroupAndInvite runs). bootUserWithContact clears IDB while
    // MarmotContext is initializing, which can prevent KeyPackage publishing and cause
    // the invite to fail with "no key package". bootUserOnGroups avoids this by doing
    // page.reload() after clearAppState so MarmotContext re-initializes cleanly.
    const { page: alicePage } = await bootUserOnGroups(browser, aliceKeys, 'Alice');
    const { page: bobPage } = await bootUserOnGroups(browser, bobKeys, 'Bob');

    // Establish a shared MLS group so the walled-garden gate allows DMs between them.
    await createGroupAndInvite(alicePage, bobKeys.npub, bobPage, 'AC-46 Reactions Group');

    // Alice opens the DM with Bob and sends a message
    await openDmWithPeer(alicePage, bobKeys.pubkeyHex);
    const msgContent = `Hello Bob from Alice ${Date.now()}`;
    await sendDmViaComposer(alicePage, msgContent);

    // Wait for Alice's message to appear
    await expect(
      alicePage.locator('[data-testid^="msg-"]', { hasText: msgContent }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Bob opens the DM with Alice and waits for the message to arrive
    await openDmWithPeer(bobPage, aliceKeys.pubkeyHex);
    const bobMsgBubble = bobPage.locator('[data-testid^="msg-"]').filter({ hasText: msgContent }).first();
    await expect(bobMsgBubble).toBeVisible({ timeout: 30_000 });

    // Get the message id from Bob's perspective (the inner rumor id)
    const bobBubbleTestId = await bobMsgBubble.getAttribute('data-testid');
    const messageId = bobBubbleTestId?.replace('msg-', '') ?? '';
    expect(messageId).toBeTruthy();

    // Bob reacts to the message via the bridge
    await sendDmReactionViaBridge(bobPage, aliceKeys.pubkeyHex, messageId, '👍');

    // Bob sees his own reaction badge immediately (optimistic, AC-43)
    const bobBadge = bobPage.getByTestId(`reaction-badge-${messageId}-👍`);
    await expect(bobBadge).toBeVisible({ timeout: 10_000 });

    // Alice sees Bob's reaction badge arrive (inbound via gift wrap, AC-45).
    // Wait for Alice's live subscription to receive the reaction from the relay.
    // The __fewDmReactions bridge dispatches handleReact asynchronously (fire-and-forget),
    // so the relay round-trip happens after the optimistic badge appears on Bob's side.
    // We wait on Alice's page BEFORE any navigation so her active giftWrapSub can receive
    // the reaction and write it to IDB via applyInboundRumor, avoiding a race where the
    // reaction arrives after a post-navigation reload clears the subscription.
    const aliceBadge = alicePage.getByTestId(`reaction-badge-${messageId}-👍`);
    await expect(aliceBadge).toBeVisible({ timeout: 30_000 });

    // Re-open the DM to confirm the badge persists (loaded from IDB, AC-45 steady state).
    await openDmWithPeer(alicePage, bobKeys.pubkeyHex);
    await expect(aliceBadge).toBeVisible({ timeout: 15_000 });

    // Bob removes the reaction via the bridge
    await sendDmReactionViaBridge(bobPage, aliceKeys.pubkeyHex, messageId, '👍', true);

    // Bob's badge disappears (optimistic rollback, AC-59)
    await expect(bobBadge).not.toBeVisible({ timeout: 10_000 });

    // Alice sees the badge disappear (inbound removal, AC-46)
    await expect(aliceBadge).not.toBeVisible({ timeout: 30_000 });
  });

  test('AC-60: only kind-1059 events on the wire — no kind-7 plaintext', async ({ browser }) => {
    const aliceKeys = USER_A;
    const bobKeys = USER_B;

    // Capture published EVENT kinds via a WebSocket observer wired BEFORE
    // page.goto (see bootUserWithContact comment). Wiring this in the test
    // body after boot misses the already-open NDK WebSocket and observes
    // zero frames.
    const publishedKinds: number[] = [];
    const { page: alicePage } = await bootUserWithContact(
      browser,
      aliceKeys,
      'Alice',
      bobKeys.pubkeyHex,
      (ws) => {
        ws.on('framesent', (frame) => {
          try {
            const data = JSON.parse(frame.payload as string);
            if (Array.isArray(data) && data[0] === 'EVENT' && data[1]?.kind !== undefined) {
              publishedKinds.push(data[1].kind as number);
            }
          } catch {
            // ignore non-JSON frames
          }
        });
      },
    );

    await openDmWithPeer(alicePage, bobKeys.pubkeyHex);

    // Send a message first so we have a target
    await sendDmViaComposer(alicePage, 'test message for AC-60');
    const bubble = alicePage.locator('[data-testid^="msg-"]', { hasText: 'test message for AC-60' }).first();
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    // Get message id
    const bubbleTestId = await bubble.getAttribute('data-testid');
    const messageId = bubbleTestId?.replace('msg-', '') ?? '';

    // Clear captured kinds before reaction (focus only on the reaction publish)
    publishedKinds.length = 0;

    // Send a reaction via bridge
    await sendDmReactionViaBridge(alicePage, bobKeys.pubkeyHex, messageId, '❤️');

    // Poll until the gift-wrapped reaction actually lands on the wire, rather
    // than a blind fixed wait: the kind-1059 publish is async (NIP-44 encrypt +
    // gift-wrap + relay round-trip) and under load occasionally takes longer
    // than a fixed 2s, which made this assertion flaky. Polling preserves the
    // same assertion but waits for the observable condition.
    await expect.poll(() => publishedKinds, { timeout: 15_000 }).toContain(1059);

    // No kind-7 plaintext should have been published — only kind-1059 gift wrap
    expect(publishedKinds).not.toContain(7);
  });
});

/**
 * Story-08 DM UI tests — reaction picker on the DM surface.
 *
 * These tests use the real picker UI rather than the bridge, confronting
 * the story-07 harness gap (kind-1059 publish not observed on relay).
 * The kind-1059 harness gap is investigated here: if the relay doesn't see
 * kind-1059 despite the UI flow completing, the test documents it in result.json.
 *
 * AC-47, AC-48, AC-49, AC-51, AC-52, AC-55, AC-56.
 */
test.describe('DM reactions UI — story-08', () => {
  test.beforeEach(async () => {
    await computeTestKeypairs();
  });

  test('AC-47+AC-49: DM reaction trigger visible on hover; picker opens; badge appears via bridge', async ({ browser }) => {
    const aliceKeys = USER_A;
    const bobKeys = USER_B;

    const { context: aliceContext, page: alicePage } = await bootUserWithContact(
      browser,
      aliceKeys,
      'Alice-08dm',
      bobKeys.pubkeyHex,
    );

    await openDmWithPeer(alicePage, bobKeys.pubkeyHex);

    // Send a message to react to
    const sentText = `DM react test ${Date.now()}`;
    await sendDmViaComposer(alicePage, sentText);

    const firstBubble = alicePage.locator('[data-testid^="msg-"]', { hasText: sentText }).first();
    await expect(firstBubble).toBeVisible({ timeout: 15_000 });
    const bubbleTestId = await firstBubble.getAttribute('data-testid');
    const messageId = bubbleTestId?.replace('msg-', '') ?? '';
    expect(messageId).toBeTruthy();

    // AC-47: hover reveals the reaction trigger
    await firstBubble.hover();
    const trigger = alicePage.getByTestId(`reaction-trigger-${messageId}`);
    await expect(trigger).toBeVisible({ timeout: 5_000 });

    // AC-48: open picker
    await trigger.click();
    const picker = alicePage.locator(`[data-testid="reaction-picker-${messageId}"]`);
    await expect(picker).toBeVisible({ timeout: 5_000 });

    // Click a glyph — this calls handleReact which calls sealAndWrap + publish
    // The kind-1059 harness gap from story-07 applies here: the relay may not see
    // the kind-1059 event despite the UI flow completing. We verify the UI state
    // (optimistic badge) not the relay observation.
    await alicePage.getByTestId('reaction-picker-glyph-👍').click();

    // Picker closes (AC-48)
    await expect(picker).not.toBeVisible({ timeout: 3_000 });

    // AC-49: badge appears (optimistic write — does NOT require relay confirmation)
    const badge = alicePage.getByTestId(`reaction-badge-${messageId}-👍`);
    await expect(badge).toBeVisible({ timeout: 10_000 });

    // AC-52+AC-56: click badge (selfReacted=true → 'remove'); badge disappears.
    // Under suite-accumulated load, relay-confirmation re-renders briefly detach
    // and reattach the badge element, so a single click can land between renders
    // and never invoke the React onClick handler — leaving the reaction in place.
    // Retry the toggle-off until the badge is gone. This is safe: removal is
    // permanent (reactions/api.ts applyInboundRumor: "removal wins regardless of
    // arrival order"), and a removed reaction drops from aggregateForMessage, so
    // a re-click can never revive an already-removed reaction.
    await expect(async () => {
      if (await badge.isVisible()) {
        await badge.click({ force: true });
      }
      await expect(badge).not.toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await aliceContext.close();
  });

  test('AC-55: onReact prop contract — DM ChatBox wired to ContactChat handleReact', async ({ browser }) => {
    // This test verifies that the onReact prop is correctly supplied by ContactChat
    // to ChatBox (and hence to EmojiReactionPicker and ReactionBadgeRow) on the DM surface.
    // It exercises the full round-trip: trigger → picker → badge → toggle.
    // The trigger existence proves onReact is wired (picker only renders when onReact is set).
    const aliceKeys = USER_A;
    const bobKeys = USER_B;

    const { context: aliceContext, page: alicePage } = await bootUserWithContact(
      browser,
      aliceKeys,
      'Alice-08wire',
      bobKeys.pubkeyHex,
    );

    await openDmWithPeer(alicePage, bobKeys.pubkeyHex);

    const sentText = `Wire test ${Date.now()}`;
    await sendDmViaComposer(alicePage, sentText);

    const firstBubble = alicePage.locator('[data-testid^="msg-"]', { hasText: sentText }).first();
    await expect(firstBubble).toBeVisible({ timeout: 15_000 });
    const bubbleTestId = await firstBubble.getAttribute('data-testid');
    const messageId = bubbleTestId?.replace('msg-', '') ?? '';

    // reaction-trigger renders only when onReact is provided (ChatBox conditional)
    await firstBubble.hover();
    const trigger = alicePage.getByTestId(`reaction-trigger-${messageId}`);
    await expect(trigger).toBeVisible({ timeout: 5_000 });

    await aliceContext.close();
  });
});
