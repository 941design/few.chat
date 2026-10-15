/**
 * E2E: reload right as a peer's group rumor arrives (bug
 * mls-message-lost-on-unload-after-ingest).
 *
 * marmot-ts persists the advanced MLS state right after it emits a decrypted
 * application message, while the app's dispatcher stores it asynchronously. An
 * unload in between used to lose the rumor for good (the ratchet had moved on).
 * The write-ahead rumor journal (app/src/lib/marmot/rumorJournal.ts) persists
 * the decrypted rumor before the state save and replays it on the next load.
 *
 * Flow: Alice and Bob share a group. Bob sends (1) a chat message and then
 * (2) a nickname update (profile rumor). Each time, Alice reloads the moment
 * her relay socket receives the kind-445 event, i.e. while she is ingesting
 * it. After the reload Alice's live UI must show the message with Bob's name,
 * and Bob's new name in the member list (retrying toBeVisible/toHaveText —
 * no reload polling).
 *
 * Limits: the reload's cut point is not controllable from the browser, so a
 * given run cannot guarantee that the cut landed between the state save and
 * the handlers (the lossy window) rather than before decrypt (relay refetch
 * re-delivers) or after the handlers (already stored), even with
 * --repeat-each. Each branch is covered deterministically by the unit tests
 * (tests/unit/marmot/epochResolver.journalOrdering.test.ts,
 * rumorJournal*.test.ts, applicationRumorDispatcher.journal.test.ts); this
 * spec is the end-to-end smoke check that the real app never drops the rumor.
 *
 * All publishes go through the app — the test only OBSERVES Alice's websocket
 * frames to time the reload; it never writes to the relay.
 */

import { test, expect, BrowserContext, Page, WebSocket } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

type FrameWatch = { armNextGroupEvent: () => Promise<void> };

/**
 * Observe every relay websocket the page opens (including after reloads) and
 * resolve an armed waiter on the next incoming kind-445 EVENT frame.
 */
function watchGroupEventFrames(page: Page): FrameWatch {
  let waiter: (() => void) | null = null;
  page.on('websocket', (ws: WebSocket) => {
    ws.on('framereceived', ({ payload }) => {
      if (!waiter || typeof payload !== 'string') return;
      if (payload.startsWith('["EVENT"') && payload.includes('"kind":445')) {
        const w = waiter;
        waiter = null;
        w();
      }
    });
  });
  return {
    armNextGroupEvent: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page; frames: FrameWatch }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
  );
  const page = await context.newPage();
  const frames = watchGroupEventFrames(page);
  await page.goto('/');
  await clearAppState(page);
  // Re-seed the profile AFTER clearAppState (see e2e_profile_seed_clearstate_race).
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  return { context, page, frames };
}

test.describe.serial('Reload right as a peer rumor arrives', () => {
  test.setTimeout(300_000);
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;
  let aliceFrames: FrameWatch;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage, frames: aliceFrames } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('chat message and profile update survive a reload during ingest', async () => {
    const stamp = Date.now();
    const groupName = `Rumor Reload ${stamp}`;

    // Bob's welcome subscription live first; drain stale relay gift wraps.
    await bobPage.goto('/groups/');
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => localStorage.removeItem('lp_pendingInvitations_v1'));

    await alicePage.goto('/groups/');
    await createGroup(alicePage, groupName);
    await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 90_000 });
    await dismissErrorOverlay(alicePage);
    await alicePage.locator('[data-testid="invite-member-modal-content"] button[aria-label="Close"]').click().catch(() => {});

    await acceptInvitationAndWaitJoined(bobPage, groupName);
    await bobPage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
    await expect(bobPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Alice knows Bob (join profile) before the reload experiments start.
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(alicePage.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', { timeout: 90_000 });
    // Let the join-time traffic (profiles, announcements) settle so the armed
    // waiter catches Bob's chat event, not a straggler.
    await alicePage.waitForTimeout(5_000);

    // ── (1) chat message ────────────────────────────────────────────────
    const text = `reload-during-ingest ${stamp}`;
    const chatArrived = aliceFrames.armNextGroupEvent();
    await bobPage.getByTestId('chat-input').fill(text);
    await bobPage.getByTestId('chat-send-btn').click();
    await chatArrived;
    await alicePage.reload();

    const bubble = alicePage.locator('[data-testid^="msg-"]', { hasText: text });
    await expect(bubble).toBeVisible({ timeout: 90_000 });
    await expect(bubble).toContainText('Bob');
    await expect(bubble).toHaveCount(1);

    // ── (2) profile update ──────────────────────────────────────────────
    const newName = `Bobby${String(stamp).slice(-5)}`;
    const profileArrived = aliceFrames.armNextGroupEvent();
    await bobPage.goto('/profile');
    await bobPage.getByTestId('profile-nickname-input').clear();
    await bobPage.getByTestId('profile-nickname-input').fill(newName);
    await expect(bobPage.getByTestId('profile-nickname-input')).toHaveValue(newName);
    await bobPage.getByTestId('profile-nickname-input').blur();
    await profileArrived;
    await alicePage.reload();

    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 60_000 });
    await expect(alicePage.getByTestId(`member-name-${bobPrefix}`)).toHaveText(newName, { timeout: 90_000 });
  });
});
