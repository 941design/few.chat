// E2E: epic group-invite-lifecycle, story S10
// (e2e-invite-lifecycle-scenarios) — the conformance oracle re-confirming, at
// the assembled-system/UI level, ACs already established at the unit/property
// level by S2, S3, S5, S6, S7 (and cross-cutting-checked by S9):
//
//   AC-PROD-1     — a direct contact-invite posts an `invited` announcement.
//   AC-PROD-3     — B's genuine own-join posts an `accepted` announcement.
//   AC-DECLINE-3  — B's real decline triggers the gift-wrapped decline send
//                   (observed indirectly via A's downstream effects).
//   AC-DECLINE-9  — the decline's subject (C) is a genuinely pending
//                   (invited, not-yet-joined) member at the moment of decline.
//   AC-DECLINE-10 — A's ordering effects (Remove + `declined` post) are both
//                   observable: C leaves the member list AND the `declined`
//                   announcement appears.
//   AC-IMMUT-1    — a non-admin viewer sees no Edit/Delete on an
//                   `invite_lifecycle` announcement.
//   AC-IMMUT-3    — an admin viewer sees a moderation Delete (never Edit) on
//                   the SAME announcement.
//
// Deliberately named `groups-invite-lifecycle-announcements.spec.ts` — NOT
// `groups-direct-invite-lifecycle.spec.ts`, which already exists for the
// unrelated epic-invite-rescind-and-member-removal's Cancel-Invite/Remove-
// Member marker lifecycle. Both filenames start with `groups-`, so both
// correctly route into the relay/Docker bucket (playwright.config.ts's
// filename-glob split) — a differently-prefixed name would silently run in
// the no-relay fast bucket, where a relay-dependent spec can never pass.
//
// Out of scope (per acceptance-criteria.md's Manual Validation section):
// receive-side forgery/UI-bypass cases (AC-IMMUT-4 through AC-IMMUT-7,
// AC-CROSS-2) are unit-test territory (S8) — the publish-through-the-app rule
// means the app itself cannot emit a UI-bypassing edit/delete signal, so
// there is no app-drivable way to exercise those here. The combinatorial
// ordering/interleaving property search over decline redelivery/crash/sync
// interleavings (AC-CROSS-1) is S9's territory — this spec drives exactly
// ONE representative interleaving per scenario.
//
// Conventions applied:
//   - Publish-through-the-app ONLY: every peer action (invite, accept,
//     decline) goes through the real UI in its own `browser.newContext()`,
//     never a hand-signed event WebSocket'd to strfry.
//   - The decline actor (C) keeps a LIVE context/signer through the decline
//     — closing a BrowserContext destroys its MLS KeyPackage secret material
//     (prior learning: closing-playwright-browsercontext-destroys). All three
//     contexts (A, B, C) stay open for the whole spec, closed only in
//     `afterAll`.
//   - Peer-observation assertions (accepted/declined arriving at A, B/C
//     joining/leaving the member list) use retrying `toBeVisible`/
//     `toHaveCount`/`expect.poll` against the LIVE-updating UI — never
//     `reload()`+`isVisible()` (races hydration) and never a fixed
//     `waitForTimeout` standing in for a peer-originated event. A fixed
//     `waitForTimeout(3s)` is used only as a settle-wait immediately after a
//     SELF-triggered MLS commit (A's own invite submission), matching the
//     sibling `groups-*.spec.ts` convention.
//   - Announcement identity is asserted by matching the actual i18n copy
//     substring ("was invited" / "joined the group" / "declined the
//     invitation" — `i18n.ts`'s `en` locale), not merely "a new element
//     appeared" — this distinguishes the three announcement types from each
//     other and from any other chat content.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';
import { queryRelayForEvents } from './helpers/relay-query';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Invite Lifecycle Announcements Group';

// The three invite_lifecycle i18n copy substrings (i18n.ts `en` locale) —
// stable, distinct, and sufficient to identify which announcement a row is
// without depending on whether the subject's nickname has round-tripped yet.
const INVITED_PHRASE = 'was invited';
const ACCEPTED_PHRASE = 'joined the group';
const DECLINED_PHRASE = 'declined the invitation';

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

test.describe.serial('Group invite lifecycle announcements — invited/accepted/declined + immutability (S10)', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, 'Bob'));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C, 'Carol'));
  });

  // All three contexts stay open for the ENTIRE spec — including C, the
  // decline actor, whose live signer is required to send the decline gift
  // wrap. None are closed early; only afterAll tears them down.
  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('A creates the group', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
  });

  // -------------------------------------------------------------------
  // AC-PROD-1: direct invite -> `invited` announcement, driven through the
  // real InviteMemberModal submit flow (inviteContactViaPicker), not a
  // fixture that bypasses the modal.
  // -------------------------------------------------------------------
  test('AC-PROD-1: A invites B via the real InviteMemberModal — an "invited" announcement appears in A\'s chat', async () => {
    await waitForKeyPackage(pageA, USER_B.pubkeyHex);
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
    // Settle-wait after A's OWN MLS commit (the invite) — allowed per
    // convention only for a self-triggered action, never peer-observation.
    await pageA.waitForTimeout(3_000);

    const invitedRow = pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: INVITED_PHRASE });
    await expect(invitedRow).toBeVisible({ timeout: 30_000 });
    // Exactly one invite_lifecycle announcement exists at this point (only
    // B's invite has happened so far) — pins the assertion to a genuine
    // text/DOM check, not "element count increased by one".
    await expect(pageA.getByTestId('invite-lifecycle-announcement')).toHaveCount(1);
  });

  // -------------------------------------------------------------------
  // AC-PROD-3: B's real join (own Welcome-processing + accept click, her own
  // browser context) -> `accepted` announcement, observed LIVE by A (no
  // reload) alongside B's arrival in the member list.
  // -------------------------------------------------------------------
  test('AC-PROD-3: B accepts via her own page — an "accepted" announcement appears live in A\'s chat, and B joins the member list', async () => {
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageB, GROUP_NAME);

    // A stays on the already-open group-detail page from the previous test —
    // no navigation, no reload — and observes the live updates.
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${bPrefix}`)).toBeVisible({ timeout: 90_000 });

    const acceptedRow = pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE });
    await expect(acceptedRow).toBeVisible({ timeout: 90_000 });

    // Both announcements now co-exist in the same chat — assert on the
    // correct one, and that the earlier `invited` row wasn't clobbered or
    // duplicated.
    await expect(pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: INVITED_PHRASE })).toHaveCount(1);
    await expect(pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: ACCEPTED_PHRASE })).toHaveCount(1);
  });

  // -------------------------------------------------------------------
  // AC-DECLINE-3/9/10: A invites C (a second, genuinely-pending invitee);
  // C — LIVE context/signer, never closed beforehand — declines via her own
  // page's real decline button. A observes (live poll, no reload) BOTH
  // effects: C's removal from the member list AND the `declined`
  // announcement.
  // -------------------------------------------------------------------
  test('A invites C — C is a genuinely pending (not-yet-joined) member', async () => {
    await waitForKeyPackage(pageA, USER_C.pubkeyHex);
    await inviteContactViaPicker(pageA, USER_C.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(3_000);

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    // AC-DECLINE-9 precondition: C is pending (in-tree, no MemberProfile yet)
    // — NOT accidentally already a full member — confirmed via the same
    // `member-pending-*` badge MemberList.tsx renders only for isPending rows.
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).toBeVisible({ timeout: 10_000 });
  });

  test('AC-DECLINE-3/9/10: C declines via her own live page — A observes the "declined" announcement AND C\'s removal from the member list', async () => {
    await pageC.goto('/groups/');
    await expect(
      pageC.getByTestId('groups-empty-state').or(pageC.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(pageC.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await expect(pageC.locator('[data-testid^="decline-invitation-"]').first()).toBeVisible({ timeout: 90_000 });
    // The decline send happens here, through the app's own gift-wrap dispatch
    // (declinePendingInvitation) — we never inspect the gift-wrap bytes
    // ourselves (that is S5's unit-test territory); we assert only the
    // observable downstream effect at A's client below.
    await pageC.locator('[data-testid^="decline-invitation-"]').first().click();

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    // Both DD-7/DD-10 effects, asserted independently, both via retrying
    // checks against the live-updating UI (never a stale reload snapshot).
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 90_000 });
    const declinedRow = pageA.getByTestId('invite-lifecycle-announcement').filter({ hasText: DECLINED_PHRASE });
    await expect(declinedRow).toBeVisible({ timeout: 90_000 });
  });

  // -------------------------------------------------------------------
  // AC-IMMUT-1 / AC-IMMUT-3: the SAME announcement (the `invited` row from
  // the first scenario) is checked from both a non-admin viewer (B, a
  // genuinely joined-but-non-admin member) and the admin viewer (A, the
  // group creator) — so the admin/non-admin contrast is exercised against
  // one shared message, not two messages that could differ for unrelated
  // reasons.
  // -------------------------------------------------------------------
  test('AC-IMMUT-1: non-admin viewer B sees NO Edit and NO Delete on the "invited" announcement', async () => {
    await openGroupDetail(pageB, GROUP_NAME);
    const row = pageB.locator('[data-testid^="msg-"]').filter({ hasText: INVITED_PHRASE }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();

    // Explicit absence queries — not merely "we didn't click a button": the
    // affordance Box is conditionally unrendered entirely for a non-admin
    // viewer of an announcement (ChatBox.tsx's `showActions &&` gate), so
    // these elements genuinely do not exist in the DOM.
    await expect(row.locator('[data-testid^="action-edit-"]')).toHaveCount(0);
    await expect(row.locator('[data-testid^="action-delete-"]')).toHaveCount(0);
  });

  test('AC-IMMUT-3: admin viewer A sees the moderation Delete (but NOT Edit) on the SAME "invited" announcement', async () => {
    const row = pageA.locator('[data-testid^="msg-"]').filter({ hasText: INVITED_PHRASE }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();

    // Delete-present AND Edit-absent are both required — a test only
    // checking Delete-present could pass even if Edit were erroneously also
    // shown (canEditMessage already returns false for any structured
    // message, so this also regression-guards that invariant).
    await expect(row.locator('[data-testid^="action-delete-"]')).toHaveCount(1);
    await expect(row.locator('[data-testid^="action-edit-"]')).toHaveCount(0);
  });

  // -------------------------------------------------------------------
  // Optional functional confirmation: the admin's moderation Delete
  // affordance actually works end-to-end (the S8 send-side carve-out makes
  // this functional now) — not required by AC-IMMUT-3 itself (which is an
  // affordance-presence assertion), but a cheap additional confirmation
  // given the row and admin context are already in hand.
  // -------------------------------------------------------------------
  test('bonus: A\'s moderation Delete actually removes the "invited" announcement', async () => {
    // Scope to B's specific "invited" row by its own msg-{id} testid, not to
    // "any row whose text contains INVITED_PHRASE" — by this point in the
    // spec, C's own (never-touched) "invited" announcement from the decline
    // scenario ALSO matches that phrase, so a broad post-delete recount would
    // never reach 0 and would falsely look like a stuck delete.
    const row = pageA.locator('[data-testid^="msg-"]').filter({ hasText: INVITED_PHRASE }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const msgTestId = await row.getAttribute('data-testid');
    const msgId = msgTestId?.replace('msg-', '') ?? '';
    expect(msgId).toBeTruthy();

    await row.hover();
    await pageA.getByTestId(`action-delete-${msgId}`).click();
    await expect(pageA.getByTestId(`action-delete-confirm-row-${msgId}`)).toBeVisible({ timeout: 5_000 });
    await pageA.getByTestId(`action-delete-confirm-${msgId}`).click();

    await expect(pageA.locator(`[data-testid="msg-${msgId}"]`)).toHaveCount(0, { timeout: 30_000 });
  });
});
