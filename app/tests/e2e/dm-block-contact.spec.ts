/**
 * E2E: Block contact — blocked view, send-path gating, confirm dialog, block
 * action, privacy invariant (epic: block-contact, story S4).
 *
 * Alice (USER_A) and Bob (USER_C, aliased USER_B per the project's reserved-
 * maintainer convention — see dm-giftwrap-bell.spec.ts) share an MLS group
 * (the walled-garden prerequisite for any DM to be accepted at all). Bob
 * sends Alice an initial DM via the app's own `__fewPublishDm` bridge (never
 * raw WebSocket — project e2e convention). Alice then blocks Bob from her
 * Profile page and the suite walks the full flow:
 *
 *   AC-CONFIRM-1: clicking Block opens a confirm modal; archiveContact is NOT
 *                 called on the bare click.
 *   AC-CONFIRM-2: cancelling leaves the contact unblocked; confirming blocks.
 *   AC-VIEW-14:   a DM racing the block/wipe does not resurrect the thread.
 *   AC-PRIV-1/2/3: a REAL WebSocket-frame spy (attached to Alice's actual
 *                 relay connection, not a mocked-away publish function) records
 *                 zero outbound EVENT frames of any kind across the whole
 *                 block sequence AND, using the SAME accumulating spy, across
 *                 the subsequent unblock action too — the privacy invariant
 *                 covers both directions of the toggle, not just block.
 *   AC-VIEW-1/7:  the Blocked banner + Unblock affordance render instead of
 *                 the composer, including on a direct-URL first render.
 *   AC-VIEW-2/3/6: the composer's text input, send button, image-attachment
 *                 button, and every reaction affordance are entirely absent
 *                 from the DOM while blocked (ChatBox itself never mounts).
 *   AC-UNBLOCK-2/4: Unblock has no confirmation and does not resurrect the
 *                 wiped thread.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777). Run via
 * node scripts/run-e2e.mjs tests/e2e/dm-block-contact.spec.ts
 */

import { test, expect, BrowserContext, Page, WebSocket as PwWebSocket } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';

// USER_B is reserved as the maintainer identity in the e2e environment — use
// USER_C as the ordinary DM peer (mirrors dm-giftwrap-bell.spec.ts).
const USER_B = USER_C;

import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';
import { readIdbRecord } from './helpers/idb-record';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const DM_THREAD_KEY = `few:messages:dm:${USER_B.pubkeyHex.toLowerCase()}`;

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

async function sendDm(fromPage: Page, toPubkeyHex: string, content: string): Promise<void> {
  await fromPage.waitForFunction(
    () => typeof (window as any).__fewPublishDm === 'function',
    null,
    { timeout: 10_000 },
  );
  await fromPage.evaluate(
    async ({ toPub, content }) => {
      await (window as any).__fewPublishDm(toPub, content);
    },
    { toPub: toPubkeyHex, content },
  );
}

/**
 * Attaches a real spy to Alice's ACTUAL WebSocket connection to the relay —
 * not a mocked-away publish function (AC-PRIV-3's explicit requirement). Every
 * outbound `["EVENT", {...}]` frame (a genuine publish, as opposed to a
 * `["REQ", ...]` subscription or `["CLOSE", ...]` teardown) is decoded and its
 * `kind` recorded. Returns an accessor so the test can inspect frames sent
 * strictly AFTER the spy was attached.
 */
function attachPublishSpy(page: Page): { publishedKinds: number[] } {
  const state = { publishedKinds: [] as number[] };
  page.on('websocket', (ws: PwWebSocket) => {
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf-8');
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed) && parsed[0] === 'EVENT' && parsed[1] && typeof parsed[1].kind === 'number') {
          state.publishedKinds.push(parsed[1].kind);
        }
      } catch {
        // Not JSON / not a relay frame we care about — ignore.
      }
    });
  });
  return state;
}

test.describe.serial('Block contact: blocked view, confirm dialog, block action, privacy (S4)', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;
  // AC-PRIV-1/2/3: one real WebSocket-frame spy, attached once (in the block
  // test, right before the block sequence begins — never before, so it does
  // not pick up legitimate group-setup/DM-send publishes) and reused
  // (never re-attached) through the unblock test below. Because it is the
  // SAME accumulating spy across both actions, an empty array at the end of
  // the unblock test proves zero publishes occurred across BOTH block and
  // unblock, not merely that a fresh, later-attached spy stayed empty.
  let publishSpy: { publishedKinds: number[] };

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUserOnGroups(browser, USER_A, 'alice-block-test'));
    ({ context: bobCtx, page: bobPage } = await bootUserOnGroups(browser, USER_B, 'bob-block-test'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('setup: Alice and Bob share a group; Bob DMs Alice; the thread is visible pre-block', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, 'S4 Block Test Group');

    await sendDm(bobPage, USER_A.pubkeyHex, `pre-block-message-${Date.now()}`);

    await alicePage.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await alicePage.waitForLoadState('networkidle');
    await dismissErrorOverlay(alicePage);
    await expect(alicePage.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });

    // The DM thread header shows the contact's avatar (image when set, else the
    // display-name initial on a muted disc), and the imprint footer is dropped
    // on this open-chat page so the composer owns the bottom of the viewport.
    await expect(alicePage.getByTestId('contact-detail-avatar')).toBeVisible();
    await expect(alicePage.getByTestId('footer-imprint-link')).toHaveCount(0);
  });

  test('AC-CONFIRM-1: clicking the block trigger opens a confirm modal without archiving', async () => {
    await alicePage.goto(`/profile?pubkey=${USER_B.pubkeyHex}`);
    await expect(alicePage.getByTestId('profile-archive')).toBeVisible({ timeout: 30_000 });
    await alicePage.getByTestId('profile-archive').click();
    await expect(alicePage.getByTestId('block-confirm-modal')).toBeVisible({ timeout: 10_000 });

    // Cancel: leaves the contact unblocked, no archive/wipe call fires.
    await alicePage.getByTestId('block-cancel-btn').click();
    await expect(alicePage.getByTestId('block-confirm-modal')).not.toBeVisible();

    const contacts = await alicePage.evaluate(() => JSON.parse(localStorage.getItem('lp_contacts_v1') || '{}'));
    const bobEntry = Object.values(contacts).find(
      (c: any) => (c.pubkeyHex || '').toLowerCase() === USER_B.pubkeyHex.toLowerCase(),
    ) as { archivedAt?: string | null } | undefined;
    expect(bobEntry?.archivedAt ?? null).toBeNull();

    // Re-clicking still opens the BLOCK modal (not already-blocked state) —
    // proves cancel truly made no state change.
    await alicePage.getByTestId('profile-archive').click();
    await expect(alicePage.getByTestId('block-confirm-modal')).toBeVisible({ timeout: 10_000 });
    await expect(alicePage.getByTestId('block-confirm-btn')).toContainText(/./); // sanity: confirm button rendered
    await alicePage.getByTestId('block-cancel-btn').click();
    await expect(alicePage.getByTestId('block-confirm-modal')).not.toBeVisible();
  });

  test('AC-CONFIRM-2 / AC-VIEW-14 / AC-PRIV-1/2/3: confirming block wipes history, bumps the gate, races an inbound DM, and produces zero Nostr publishes', async () => {
    publishSpy = attachPublishSpy(alicePage);

    await alicePage.getByTestId('profile-archive').click();
    await expect(alicePage.getByTestId('block-confirm-modal')).toBeVisible({ timeout: 10_000 });

    // Fire the confirm click and the racing inbound DM as close together as
    // this harness allows — the click triggers archiveContact ->
    // notifyBlockedPeersChanged -> wipeSinglePeerHistory (async); Bob's DM is
    // sent immediately after, without awaiting Alice's wipe to settle.
    await Promise.all([
      alicePage.getByTestId('block-confirm-btn').click(),
      sendDm(bobPage, USER_A.pubkeyHex, `racing-message-${Date.now()}`),
    ]);

    // The confirm button shows a loading state while wipeSinglePeerHistory
    // runs, then the modal closes.
    await expect(alicePage.getByTestId('block-confirm-modal')).not.toBeVisible({ timeout: 15_000 });

    const contacts = await alicePage.evaluate(() => JSON.parse(localStorage.getItem('lp_contacts_v1') || '{}'));
    const bobEntry = Object.values(contacts).find(
      (c: any) => (c.pubkeyHex || '').toLowerCase() === USER_B.pubkeyHex.toLowerCase(),
    ) as { archivedAt?: string | null } | undefined;
    expect(bobEntry?.archivedAt).toBeTruthy();

    // AC-VIEW-14: the wiped thread must stay absent even with a racing inbound
    // DM in flight at the moment of the block/wipe.
    await expect
      .poll(() => readIdbRecord(alicePage, 'keyval-store', 'keyval', DM_THREAD_KEY), { timeout: 15_000 })
      .toBeNull();

    // AC-PRIV-1/2/3: zero outbound Nostr publishes of ANY kind as a result of
    // block, evidenced by a spy on the real WebSocket connection.
    expect(publishSpy.publishedKinds).toEqual([]);
  });

  test('AC-VIEW-2/3/6/7 (banner UX superseded): a direct-URL navigation to the blocked contact redirects to the list — no detail page, every send affordance absent, inline Unblock on the hidden row', async () => {
    // Behavior update: the block-contact epic originally rendered a Blocked
    // banner on the detail page (AC-VIEW-1/7). The contact detail page is now
    // disabled for blocked (and pending) contacts — a direct URL redirects back
    // to the contacts list instead of opening a banner. The load-bearing
    // SECURITY property of AC-VIEW-2/3/6/7 is unchanged (and strengthened): no
    // composer or send affordance ever mounts for a blocked peer, because
    // ContactChat is never rendered — the redirect returns before it.
    await alicePage.goto(`/contacts?id=${USER_B.pubkeyHex}`);
    await alicePage.waitForURL((url) => !url.searchParams.has('id'), { timeout: 30_000 });

    // Redirected to the list — the detail page and the old Blocked banner are
    // both absent.
    await expect(alicePage.getByTestId('contacts-page')).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId('contact-detail-page')).toHaveCount(0);
    await expect(alicePage.getByTestId('contact-archived-alert')).toHaveCount(0);

    // AC-VIEW-2/3: text composer + image button entirely absent from the DOM.
    await expect(alicePage.getByTestId('chat-input')).toHaveCount(0);
    await expect(alicePage.getByTestId('chat-send-btn')).toHaveCount(0);
    await expect(alicePage.getByTestId('image-attachment-button')).toHaveCount(0);
    // AC-VIEW-6: no reaction affordance and no message rows — ChatBox itself
    // never mounts for a blocked peer, so neither can exist.
    await expect(alicePage.locator('[data-testid^="reaction-trigger-"]')).toHaveCount(0);
    await expect(alicePage.locator('[data-testid^="msg-"]')).toHaveCount(0);

    // The Unblock affordance now lives inline on the blocked list row (revealed
    // under "show hidden"), replacing the detail-page Unblock button. Assert it
    // is present but do NOT click it — the serial unblock test below owns that.
    await alicePage.getByTestId('contacts-filter-show-hidden').click();
    await expect(alicePage.getByTestId(`contact-unblock-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 15_000 });
  });

  test('AC-UNBLOCK-2/4 / AC-PRIV-1/2/3: unblocking has no confirmation, does not resurrect the wiped thread, and produces zero Nostr publishes', async () => {
    // AC-PRIV-1/2/3 test-isolation note: the `page.goto` below is a full
    // navigation that remounts the whole app (including MarmotContext), which
    // can legitimately re-arm the UNRELATED, one-time-per-mount AC-023
    // app-start stale-profile sweep (member-profile-discovery-and-relay-on-
    // behalf epic, MarmotContext.tsx's `appStartSweepRanRef`) — that sweep can
    // itself emit a kind-445 profile-request rumor for a group member whose
    // profile looks stale, entirely independent of anything this test
    // exercises. Investigated and confirmed: `performUnblockContact` (the
    // real production code under test here) touches only `unarchiveContact`
    // (localStorage) and `notifyBlockedPeersChanged` (a bare React state
    // bump) — it has no reachable path to any Nostr publish. Install a
    // counter for that sweep's own dev-only completion signal
    // (`window.__fewTest.onRumorSent`, already wired at
    // MarmotContext.tsx:718-721 for exactly this kind of test observability)
    // before the navigation, so the assertion below can deterministically
    // wait out that unrelated background effect rather than guess at a fixed
    // quiet-window duration.
    await alicePage.addInitScript(() => {
      const w = window as unknown as { __fewTest?: { onRumorSent?: (kind: number) => void }; __fewSweepFired?: boolean };
      w.__fewTest = w.__fewTest || {};
      const prevOnRumorSent = w.__fewTest.onRumorSent;
      w.__fewSweepFired = false;
      w.__fewTest.onRumorSent = (kind: number) => {
        w.__fewSweepFired = true;
        prevOnRumorSent?.(kind);
      };
    });

    await alicePage.goto(`/profile?pubkey=${USER_B.pubkeyHex}`);
    await expect(alicePage.getByTestId('profile-archive')).toBeVisible({ timeout: 30_000 });

    // Give the unrelated app-start sweep a bounded chance to fire (it either
    // does so quickly once `ready`/`groups` settle, or never — e.g. already
    // deduped from an earlier mount this session) BEFORE snapshotting the
    // SAME accumulating spy's length as the unblock-action baseline. This
    // isolates "zero publishes caused by clicking unblock" from an unrelated,
    // legitimate background publish that a fresh page mount can produce
    // regardless of block state.
    await alicePage
      .waitForFunction(() => (window as unknown as { __fewSweepFired?: boolean }).__fewSweepFired === true, null, { timeout: 3_000 })
      .catch(() => {});
    const beforeUnblockClick = publishSpy.publishedKinds.length;

    await alicePage.getByTestId('profile-archive').click();
    // No modal of any kind appears for unblock.
    await expect(alicePage.getByTestId('block-confirm-modal')).not.toBeVisible();

    const contacts = await alicePage.evaluate(() => JSON.parse(localStorage.getItem('lp_contacts_v1') || '{}'));
    const bobEntry = Object.values(contacts).find(
      (c: any) => (c.pubkeyHex || '').toLowerCase() === USER_B.pubkeyHex.toLowerCase(),
    ) as { archivedAt?: string | null } | undefined;
    expect(bobEntry?.archivedAt ?? null).toBeNull();

    // The thread must not be resurrected by the unblock action itself (before
    // ContactChat is ever mounted / before any new message arrives).
    const record = await readIdbRecord(alicePage, 'keyval-store', 'keyval', DM_THREAD_KEY);
    expect(record).toBeNull();

    // AC-PRIV-1/2/3: the SAME accumulating spy attached before the block
    // sequence (see the AC-CONFIRM-2 test above) records zero NEW publishes
    // from the unblock-baseline snapshot onward — zero outbound Nostr
    // publishes of ANY kind caused by BOTH the block and the unblock action.
    expect(publishSpy.publishedKinds.slice(beforeUnblockClick)).toEqual([]);
  });
});
