// E2E: epic group-message-author-auth-app-layer, story S6
// (announcement-actor-rules-and-ingest-gate) — the single integrated-e2e AC
// in this story:
//
//   AC-ANNOUNCE-3 — the `invite_lifecycle('accepted')` roster-gate is an
//   INGEST-TIME, non-retroactive decision. An announcement accepted once
//   (because its subject WAS in the roster at the moment the rumor arrived)
//   must remain visible in chat history forever after — even once the
//   subject later leaves the group and is no longer a roster member. The
//   gate is evaluated exactly once, at ingest; it must never be
//   re-evaluated against a group's CURRENT roster on a later re-render or
//   `groupDataVersion` bump.
//
// Conventions applied (mirrors groups-invite-lifecycle-announcements.spec.ts
// and groups-leave-intent.spec.ts):
//   - Publish-through-the-app ONLY: every peer action (invite, accept,
//     leave) goes through the real UI in its own `browser.newContext()`,
//     never a hand-signed event WebSocket'd to strfry.
//   - B (the invitee/leaver) keeps a LIVE context/signer through the whole
//     spec — closing a BrowserContext destroys its MLS KeyPackage secret
//     material (prior learning: closing-playwright-browsercontext-
//     destroys). Both contexts stay open for the entire spec, closed only
//     in `afterAll`.
//   - Peer-observation assertions (B joining/leaving A's member list, the
//     announcement row appearing/persisting) use retrying `toBeVisible`/
//     `toHaveCount` against the LIVE-updating UI — never `reload()` +
//     `isVisible()` (races hydration) and never a fixed `waitForTimeout`
//     standing in for a peer-originated event. A fixed `waitForTimeout(3s)`
//     is used only as a settle-wait immediately after a SELF-triggered MLS
//     commit (A's own invite submission), matching the sibling
//     `groups-*.spec.ts` convention.
//   - Filename starts with `groups-`, routing it into the relay/Docker e2e
//     bucket (playwright.config.ts's filename-glob split) — a differently-
//     prefixed name would silently run in the no-relay fast bucket, where a
//     relay-dependent spec can never pass.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker } from './helpers/group-setup';
import { queryRelayForEvents } from './helpers/relay-query';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Announcement Roster Gate Group';

// The `invite_lifecycle('accepted')` i18n copy substring (i18n.ts `en`
// locale) — stable and sufficient to identify the announcement row.
const ACCEPTED_PHRASE = 'joined the group';

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

/** Wait for the user's KeyPackage to appear on the relay (kind 443 or 30443). */
async function waitForKeyPackage(page: Page, pubkeyHex: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const events = await queryRelayForEvents(page, { kinds: [443, 30443], authors: [pubkeyHex], limit: 1 });
        return events.length;
      },
      { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
    )
    .toBeGreaterThanOrEqual(1);
}

test.describe.serial('Group announcement roster-gate is ingest-time, non-retroactive (S6, AC-ANNOUNCE-3)', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, 'Bob'));
  });

  // Both contexts stay open for the ENTIRE spec — B's live signer is needed
  // for both her accept AND her later leave. Neither is closed early; only
  // afterAll tears them down.
  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates the group', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
  });

  test('A invites B via the real InviteMemberModal', async () => {
    // Precondition, not the focus of this spec — produces an `invited`
    // announcement en route to the `accepted` one below.
    await waitForKeyPackage(pageA, USER_B.pubkeyHex);
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
    // Settle-wait after A's OWN MLS commit (the invite) — allowed per
    // convention only for a self-triggered action, never peer-observation.
    await pageA.waitForTimeout(3_000);
  });

  // -------------------------------------------------------------------
  // Roster-gate ACCEPT path: B's own-join (her own accept click, her own
  // browser context) lands the Add commit on A's roster BEFORE B's own-join
  // profile rumor triggers the `accepted` announcement.
  //
  // F3 (Stage-2 review) -- corrected: the row asserted on A's page below is
  // A's OWN LOCAL ECHO. A is the accepted-producer (she holds the pending
  // invite marker from having invited B, and fires on the first genuine
  // own-join profile rumor she observes for B) -- profileHandler.ts's
  // sendAnnouncement dep appends directly to A's own store AND publishes the
  // real application rumor, so A's row never passes through her own
  // dispatcher + gateAnnouncement ingest gate. That assertion alone does
  // NOT exercise the roster-accept decision through the app.
  //
  // The assertion on pageB below is the one that does: B receives the SAME
  // announcement rumor over the wire, through her own dispatcher, and
  // gateAnnouncement's roster check (isGroupMember(groupId, structured.pubkey),
  // structured.pubkey === B's own pubkey) must pass for it to render on her
  // page at all -- this is where the announcement is genuinely ingested
  // while B IS in the roster (AC-ANNOUNCE-3's ingest-time precondition).
  // -------------------------------------------------------------------
  test('B accepts via her own page — an "accepted" announcement appears live in A\'s chat, and B joins the member list', async () => {
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await expect(pageB.locator('[data-testid^="accept-invitation-"]').first()).toBeVisible({ timeout: 90_000 });
    await pageB.locator('[data-testid^="accept-invitation-"]').first().click();
    await expect(pageB.getByText(GROUP_NAME)).toBeVisible({ timeout: 90_000 });

    // A stays on the already-open group-detail page from the previous test —
    // no navigation, no reload — and observes the live updates. NOTE: this
    // row is A's own local echo of her sendAnnouncement call, not a rumor
    // that passed through the dispatcher/gate (see F3 comment above).
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${bPrefix}`)).toBeVisible({ timeout: 90_000 });

    const acceptedRowOnA = pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE });
    await expect(acceptedRowOnA).toBeVisible({ timeout: 90_000 });
    await expect(pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE })).toHaveCount(1);

    // B must actually be on the group-detail page (not just the groups list)
    // for her subsequent Leave Group action below.
    await pageB.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageB);

    // F3: this IS the assertion that genuinely exercises the roster-accept
    // gate through the app — B's own page received the `accepted`
    // announcement rumor over the wire (not a local echo), and it must have
    // passed gateAnnouncement's isGroupMember roster check to render here.
    const acceptedRowOnB = pageB.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE });
    await expect(acceptedRowOnB).toBeVisible({ timeout: 30_000 });
  });

  // -------------------------------------------------------------------
  // B — a genuine non-admin member, no admin promotion needed — leaves the
  // group via her own live page, exactly mirroring
  // groups-leave-intent.spec.ts's "USER_B clicks Leave Group and confirms"
  // flow. This is the roster-mutating event whose `groupDataVersion` bump
  // must NOT retroactively re-evaluate the earlier `accepted` announcement.
  // -------------------------------------------------------------------
  test('B leaves the group via her own live page', async () => {
    await pageB.getByTestId('leave-group-btn').click();
    await expect(pageB.getByTestId('leave-group-confirm-btn')).toBeVisible({ timeout: 10_000 });
    await pageB.getByTestId('leave-group-confirm-btn').click();
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('A observes B\'s removal from the member list', async () => {
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    // poll with a generous timeout: leave-intent debounce + relay
    // propagation + auto-remove commit round-trip (mirrors
    // groups-leave-intent.spec.ts's AC-MEMBERS-2 poll).
    await expect
      .poll(
        async () => pageA.getByTestId(`member-item-${bPrefix}`).count(),
        { timeout: 30_000, intervals: [3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000] },
      )
      .toBe(0);
  });

  // -------------------------------------------------------------------
  // THE crux assertion (AC-ANNOUNCE-3): the SAME `accepted` announcement
  // row, ingested while B genuinely was in the roster, is STILL visible —
  // not retracted, not duplicated — after B's later, roster-changing leave.
  // This proves the ingest-time accept decision was never re-evaluated
  // against B's now-changed (post-leave) roster status.
  // -------------------------------------------------------------------
  test('AC-ANNOUNCE-3: the earlier "accepted" announcement remains visible in A\'s chat after B leaves — the ingest-time decision is never retroactively re-evaluated', async () => {
    const acceptedRow = pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE });
    await expect(acceptedRow).toBeVisible({ timeout: 15_000 });
    await expect(pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE })).toHaveCount(1);
  });
});
