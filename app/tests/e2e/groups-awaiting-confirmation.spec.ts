// E2E: Returning-user invite-link "awaiting confirmation" experience.
//
// epic: invite-link-awaiting-landing (story S5 — integration/e2e story).
// Covers AC-E2E-1..4 and the cross-cutting AC-OBS-1..3 whole-flow ordering
// guarantees, driven entirely through the running app (no raw WebSocket
// publish) against the REAL S1-S4 implementations — nothing here is mocked.
//
// ── Returning-user identity (CRITICAL) ──────────────────────────────────────
// The feature only changes the RETURNING-user branch of groups.tsx:950
// (`if (joinNonce && joinAdmin && joinName && isFreshIdentity) return
// <JoinRequestCard>`); a genuine first-time visitor still gets the unchanged
// full-screen card. `isFreshIdentity` is derived by
// `deriveIsFreshIdentity(storedIdentityAtInit)` (app/src/lib/freshIdentity.ts)
// — true only when `loadStoredIdentity()` found NO identity in localStorage
// at THIS page load's mount, captured before any auto-generation
// (NostrIdentityContext.tsx's sole call site). This helper's `addInitScript`
// seeds `lp_nostrIdentity_v1` before every navigation in the context
// (including the `reload()` below, since Playwright re-runs registered init
// scripts on every subsequent load) — so `loadStoredIdentity()` always finds
// a non-null identity at mount, and `isFreshIdentity` is `false` for every
// user booted this way. That is exactly the "established identity"
// (returning-user) signal the S3 branch checks — confirmed by reading the
// real derivation code, not assumed. (Ground-truthed against the sibling
// prior-epic spec `groups-invite-link.spec.ts`, whose full-screen
// `join-request-card` assertions for its named User B now fail against this
// epic's landed S3 change for exactly this reason — see this story's
// result.json for that separately-flagged finding; it is not fixed here.)
//
// The invitee additionally creates its OWN group before ever touching an
// invite link, so AC-LAND-1 ("existing groups shown alongside the awaiting
// card") is exercised against a genuine pre-existing group, not merely a
// technically-non-fresh identity with nothing in its list.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

/** Boot a user context: inject identity via init script, navigate to /groups/. */
async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  opts?: { nickname?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (nickname) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname: opts?.nickname ?? '' });
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

/** Create a group from the given page. */
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

/** Navigate to a group's detail page. */
async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

/** Generate an invite link for an already-open group detail page and extract its nonce. */
async function generateInviteLink(page: Page, groupName: string): Promise<{ url: string; nonce: string }> {
  await openGroupDetail(page, groupName);
  await page.getByTestId('invite-link-btn').click();
  await expect(page.getByTestId('generate-invite-link-modal')).toBeVisible();

  const urlElement = page.getByTestId('invite-link-url');
  await expect(urlElement).toBeVisible();
  const url = (await urlElement.textContent()) ?? '';
  expect(url).toContain('/groups/?join=');

  // Persists the InviteLink to IDB (mirrors groups-invite-link.spec.ts).
  await page.getByTestId('invite-link-copy-btn').click();
  await page.waitForTimeout(1_000);

  await page.getByTestId('generate-invite-link-modal').locator('[aria-label="Close"]').click();
  await expect(page.getByTestId('generate-invite-link-modal')).not.toBeVisible({ timeout: 5_000 });

  const nonce = new URL(url).searchParams.get('join');
  expect(nonce).toBeTruthy();
  return { url, nonce: nonce! };
}

/** Path + query portion of a captured invite URL, for page.goto(). */
function pathWithQueryOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

/** Poll for the admin's Groups nav pill to pick up a join request. */
async function waitForJoinRequestNotification(page: Page): Promise<void> {
  // A join request is a Groups-domain event, so it surfaces on `groups-nav-badge`.
  await expect
    .poll(
      async () => {
        await dismissErrorOverlay(page);
        return page.getByTestId('groups-nav-badge').first().isVisible();
      },
      { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
    )
    .toBe(true);
}

/**
 * AC-OBS-2: poll tightly across an auto-accept transition asserting that at
 * NO observed frame are both the awaiting card and the real joined-group
 * card visible — this half stays fully enforced (strong, hard violation).
 * Fine-grained (250ms) polling is the e2e-level proxy for catching the gap
 * between `deleteOutboundJoinRequest` (S2's emitter fires synchronously)
 * and the fire-and-forget `reloadGroups()` triggered by welcomeSubscription's
 * `onGroupJoined` callback (MarmotContext.tsx), which is NOT awaited before
 * the Welcome-processing loop moves on.
 *
 * Amended (Decider RETRY, 2026-07-19 — see acceptance-criteria.md's AC-OBS-2
 * amendment note): the original "never NEITHER visible" per-frame assertion
 * is REMOVED. A brief transitional frame where neither the awaiting card nor
 * the real joined-group card is visible is permitted — inherent to the
 * async, network-backed join. What remains enforced is a BOUNDED version:
 * once the awaiting card is observed to disappear, the real joined-group
 * card MUST become visible within `NEITHER_WINDOW_MS` — i.e. no *lasting*
 * neither-state. The clock starts only once the card has actually been seen
 * disappearing (never at the very start of polling, before the card has
 * even appeared/before the Welcome has propagated at all — that phase is
 * ordinary propagation latency, not the AC-OBS-2 transition itself).
 */
async function pollAtomicAutoAcceptTransition(
  page: Page,
  cardTestId: string,
  realGroupName: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const NEITHER_WINDOW_MS = 15_000;
  const deadline = Date.now() + opts.timeoutMs;
  let settled = false;
  let cardEverVisible = false;
  let cardDisappearedAt: number | null = null;

  while (Date.now() < deadline) {
    await dismissErrorOverlay(page);
    const cardVisible = await page.getByTestId(cardTestId).isVisible().catch(() => false);
    const groupVisible = await page
      .locator('[data-testid^="group-card-"]', { hasText: realGroupName })
      .isVisible()
      .catch(() => false);

    // AC-OBS-2 (strong, enforced): both visible in the same observed frame
    // is a hard violation, never permitted.
    expect(
      cardVisible && groupVisible,
      'AC-OBS-2 violation: awaiting card and real joined-group card both visible in the same observed frame',
    ).toBe(false);

    if (cardVisible) cardEverVisible = true;
    if (cardEverVisible && !cardVisible && cardDisappearedAt === null) {
      cardDisappearedAt = Date.now();
    }

    if (groupVisible && !cardVisible) {
      settled = true;
      break;
    }

    if (cardDisappearedAt !== null && Date.now() - cardDisappearedAt > NEITHER_WINDOW_MS) {
      throw new Error(
        `AC-OBS-2 violation: neither the awaiting card nor the real joined-group card became visible within ${NEITHER_WINDOW_MS}ms of the awaiting card disappearing (no-LASTING-neither bound)`,
      );
    }

    await page.waitForTimeout(opts.intervalMs);
  }
  expect(settled, 'auto-accept transition never completed within the polling window').toBe(true);
}

test.describe.serial('Awaiting-confirmation invite-link flow (epic: invite-link-awaiting-landing)', () => {
  const G1_NAME = 'Awaiting Flow Group (Admin1)';
  const G2_NAME = 'Awaiting Flow Group (Admin2)';
  const G3_NAME = 'Awaiting Flow Group (Fresh Resend)';
  const INVITEE_OWN_GROUP = 'Invitee Pre-Existing Group';

  let ctxAdmin1: BrowserContext;
  let ctxAdmin2: BrowserContext;
  let ctxInvitee: BrowserContext;
  let pageAdmin1: Page;
  let pageAdmin2: Page;
  let pageInvitee: Page;

  let inviteUrl1 = '';
  let nonce1 = '';
  let nonce1Prefix = '';

  let inviteUrl2 = '';
  let nonce2 = '';
  let nonce2Prefix = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxAdmin1, page: pageAdmin1 } = await bootUser(browser, USER_A, { nickname: 'Admin One' }));
    ({ context: ctxAdmin2, page: pageAdmin2 } = await bootUser(browser, USER_C, { nickname: 'Admin Two' }));
    // Invitee is booted with a nickname (an established profile), matching
    // this file's returning-user precondition (see header comment).
    ({ context: ctxInvitee, page: pageInvitee } = await bootUser(browser, USER_B, { nickname: 'Returning Invitee' }));
  });

  test.afterAll(async () => {
    // The invitee's context is NEVER closed until the very end of the run —
    // closing it mid-test destroys its MLS KeyPackage secret material.
    await ctxAdmin1?.close();
    await ctxAdmin2?.close();
    await ctxInvitee?.close();
  });

  // ── Setup: both admins create a group + invite link ─────────────────────

  test('Admin1 creates a group and generates an invite link', async () => {
    await createGroup(pageAdmin1, G1_NAME);
    ({ url: inviteUrl1, nonce: nonce1 } = await generateInviteLink(pageAdmin1, G1_NAME));
    nonce1Prefix = nonce1.slice(0, 6);
  });

  test('Admin2 creates a group and generates an invite link (for multi-record coverage)', async () => {
    await createGroup(pageAdmin2, G2_NAME);
    ({ url: inviteUrl2, nonce: nonce2 } = await generateInviteLink(pageAdmin2, G2_NAME));
    nonce2Prefix = nonce2.slice(0, 6);
  });

  // ── Returning-user backdrop (AC-LAND-1) ─────────────────────────────────

  test('Invitee is a returning user with a pre-existing group', async () => {
    await createGroup(pageInvitee, INVITEE_OWN_GROUP);
  });

  // ── AC-E2E-1 (Invited banner) / AC-E2E-4 (testid presence) / AC-LAND-1 ──

  test('Invitee opens Admin1\'s invite link: sees existing groups AND the Invited banner (AC-E2E-1 start, AC-LAND-1, AC-E2E-4)', async () => {
    await pageInvitee.goto(pathWithQueryOf(inviteUrl1));
    await dismissErrorOverlay(pageInvitee);

    // AC-LAND-1: the returning user's pre-existing group is still shown —
    // this is the LIST view, not the full-screen JoinRequestCard replacement.
    await expect(
      pageInvitee.locator('[data-testid^="group-card-"]', { hasText: INVITEE_OWN_GROUP }),
    ).toBeVisible({ timeout: 30_000 });

    // AC-E2E-4: the awaiting/invited banner testid is present at the right
    // component, and (Invited state) exposes the Request-to-join action.
    await expect(pageInvitee.getByTestId('invite-awaiting-banner')).toBeVisible();
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible();
    await expect(pageInvitee.getByText(G1_NAME)).toBeVisible();

    // No outbound record exists yet for this nonce.
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toHaveCount(0);
  });

  // ── AC-E2E-1 (confirm -> Awaiting banner + card), AC-REACT-3, AC-LAND-3 ─

  test('Invitee taps Request to join: Awaiting banner + awaiting card appear, URL is cleaned up (AC-E2E-1, AC-REACT-3, AC-LAND-3)', async () => {
    await pageInvitee.getByTestId('invite-awaiting-request-btn').click();

    // AC-REACT-3 / AC-CARD-1: reactive switch to Awaiting, no reload.
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toBeVisible({ timeout: 30_000 });

    // AC-LAND-3: join/admin/name stripped from the URL (trailing-slash aware).
    await expect(pageInvitee).toHaveURL(/\/groups\/?(?:$|\?(?!.*\bjoin=))/, { timeout: 10_000 });

    // Re-visiting the SAME invite link now (join params re-added manually)
    // must render Awaiting immediately, with no Invited flash (AC-LAND-4) —
    // a deterministic way to observe the Awaiting-state banner (AC-E2E-4),
    // since the live post-send banner unmounts within the same tick the URL
    // is replaced.
    await pageInvitee.goto(pathWithQueryOf(inviteUrl1));
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId('invite-awaiting-banner')).toBeVisible();
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toHaveCount(0);
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toBeVisible();
  });

  // ── AC-E2E-1 payoff: persistence across reload ──────────────────────────

  test('Awaiting card persists across a page reload (AC-E2E-1 payoff)', async () => {
    // Still on the invite-link URL from the previous test, so both the
    // Awaiting banner and card are mounted; reload proves real IndexedDB
    // persistence, not in-memory-only state.
    await pageInvitee.reload();
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageInvitee.getByTestId('invite-awaiting-banner')).toBeVisible();
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toHaveCount(0);
  });

  // ── Multi-record coverage: two simultaneous outbound requests ──────────

  test('A second, simultaneous outbound join request to a different admin renders a second, distinct awaiting card', async () => {
    await pageInvitee.goto(pathWithQueryOf(inviteUrl2));
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId('invite-awaiting-banner')).toBeVisible();
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible();

    await pageInvitee.getByTestId('invite-awaiting-request-btn').click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce2Prefix}`)).toBeVisible({ timeout: 30_000 });

    // Both requests are simultaneously outstanding: both cards render, with
    // distinct nonce-prefixed testids, alongside the invitee's own group.
    await pageInvitee.goto('/groups/');
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.locator('[data-testid^="group-card-"]', { hasText: INVITEE_OWN_GROUP })).toBeVisible();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toBeVisible();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce2Prefix}`)).toBeVisible();
    expect(nonce1Prefix).not.toBe(nonce2Prefix);
  });

  // ── AC-E2E-2 / AC-REACT-2: Cancel, live, no reload ──────────────────────

  test('Cancel removes the awaiting card and reverts the banner live, with no reload (AC-E2E-2, AC-REACT-2)', async () => {
    await pageInvitee.goto(pathWithQueryOf(inviteUrl1));
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toBeVisible();
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toHaveCount(0);

    await pageInvitee.getByTestId(`cancel-outbound-request-${nonce1Prefix}`).click();

    // AC-CARD-3/AC-REACT-2: the card disappears live.
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toHaveCount(0, { timeout: 15_000 });
    // AC-OBS-1 (partial, live): the Awaiting-specific banner render is
    // removed — replaced by the Invited-state banner (Request-to-join button
    // reappears), never staying on "awaiting approval" after the record is
    // gone. No reload() anywhere in this test.
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible({ timeout: 15_000 });
  });

  // ── AC-OBS-1: delete survives a subsequent async load, no resurrection ──

  test('Cancelled request stays gone across a fresh async store load — no resurrection (AC-OBS-1)', async () => {
    // A reload here forces a brand-new async initial-load path in S2's
    // store (module re-init in a fresh page load), which must reflect the
    // already-applied delete rather than resurrecting a stale record.
    await pageInvitee.reload();
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce1Prefix}`)).toHaveCount(0);
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible();
  });

  // ── AC-E2E-3 / AC-OBS-2: admin approval, atomic transition, no reload ───

  test("Admin2 approves the join request; the awaiting card disappears and the real group appears atomically, with no reload (AC-E2E-3, AC-OBS-2)", async () => {
    await pageAdmin2.goto('/groups/');
    await expect(
      pageAdmin2.getByTestId('groups-empty-state').or(pageAdmin2.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await waitForJoinRequestNotification(pageAdmin2);
    await openGroupDetail(pageAdmin2, G2_NAME);
    await expect(pageAdmin2.locator('[data-testid^="pending-request-row-"]').first()).toBeVisible({ timeout: 30_000 });

    await dismissErrorOverlay(pageAdmin2);
    await pageAdmin2.locator('[data-testid^="approve-request-"]').first().click();
    await expect(pageAdmin2.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });

    // Invitee's session stays open, no reload/goto — pure live reactivity.
    await pollAtomicAutoAcceptTransition(
      pageInvitee,
      `outbound-request-card-${nonce2Prefix}`,
      G2_NAME,
      { timeoutMs: 90_000, intervalMs: 250 },
    );

    // Final state: card gone, real group present, no manual accept was needed.
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce2Prefix}`)).toHaveCount(0);
    await expect(
      pageInvitee.locator('[data-testid^="group-card-"]', { hasText: G2_NAME }),
    ).toBeVisible();
  });

  // ── AC-OBS-3: Cancel-then-later-approval falls through to manual accept ─

  test("A Cancel preceding a later admin approval is NOT dropped — it surfaces via the manual Accept/Decline path (AC-OBS-3)", async () => {
    // nonce1's ORIGINAL join-request rumor (sent in the "taps Request to
    // join" test above) was never retracted by the later Cancel — Cancel is
    // a purely local IDB delete (AC-CARD-3, DD-4) — so Admin1 still has it
    // pending, unapproved, entirely unaware the invitee cancelled locally.
    // Approving it now is exactly the "Cancel precedes a later-arriving
    // admin-approval Welcome for the same nonce" ordering AC-OBS-3 covers.
    await pageAdmin1.goto('/groups/');
    await expect(
      pageAdmin1.getByTestId('groups-empty-state').or(pageAdmin1.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await waitForJoinRequestNotification(pageAdmin1);
    await openGroupDetail(pageAdmin1, G1_NAME);
    await expect(pageAdmin1.locator('[data-testid^="pending-request-row-"]').first()).toBeVisible({ timeout: 30_000 });

    await dismissErrorOverlay(pageAdmin1);
    await pageAdmin1.locator('[data-testid^="approve-request-"]').first().click();
    await expect(pageAdmin1.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });

    // Invitee's session stays open, no reload. The Welcome must NOT be
    // silently dropped and must NOT auto-accept (no matching outbound
    // record survives the cancel) — it must surface as a manual
    // Accept/Decline row instead.
    await expect(pageInvitee.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageInvitee);
          const rows = pageInvitee.locator('[data-testid^="accept-invitation-"]');
          return rows.count();
        },
        { timeout: 90_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBeGreaterThanOrEqual(1);

    // Never auto-accepted: the fallen-through invitation must not have
    // silently joined G1 without the manual Accept below.
    await expect(
      pageInvitee.locator('[data-testid^="group-card-"]', { hasText: G1_NAME }),
    ).toHaveCount(0);
  });

  // ── Finding A (Decider RETRY, 2026-07-19): fresh-nonce cancel/resend/
  // cancel cycle still falls through to manual accept ────────────────────
  //
  // The AC-OBS-3 case above sends exactly ONE rumor total before its single
  // Cancel, then lets a later admin approval fall through. That leaves a
  // blind spot the Decider flagged: what if the invitee, after cancelling,
  // sends AGAIN on the SAME nonce? `saveOutboundJoinRequest`
  // (outboundJoinRequests.ts) is a plain upsert keyed by nonce, so a resend
  // RECREATES a live local outbound record — and `resolveAutoAcceptRecord`
  // (welcomeSubscription.ts) correlates solely off the invitee's OWN current
  // record store, with no visibility into how many join-request rumors the
  // admin actually received. Verified directly against both of those files:
  // a live record at approval time WOULD auto-accept. So proving "falls
  // through to manual" survives a genuine resend requires the invitee's
  // local record to be absent AGAIN at approval time — exactly what a
  // second Cancel produces here. This also exercises
  // joinRequestHandler.ts's admin-side pubkey+groupId dedup guard
  // (`existingRequests.some(...)`), which silently discards the resent
  // rumor server-admin-side since the original request is still pending
  // there (also verified directly against the code) — the admin only ever
  // sees ONE approvable request throughout, so this closes the blind spot
  // against any future rumor-dedup/already-processed guard: even with TWO
  // rumors in flight for the same nonce, the eventual manual-accept
  // fallback must not be corrupted by either the admin-side dedup or the
  // invitee-side cancel/resend/cancel local-storage churn.
  test('A fresh nonce: send, Cancel, re-send, Cancel again — a later admin approval still falls through to manual accept (Finding A)', async () => {
    // The preceding AC-OBS-3 test leaves pageAdmin1 sitting on G1's group-
    // detail page (it navigated there to approve, and never back). Return to
    // the groups list first — createGroup's create-group-btn only exists there.
    await pageAdmin1.goto('/groups/');
    await expect(
      pageAdmin1.getByTestId('groups-empty-state').or(pageAdmin1.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await createGroup(pageAdmin1, G3_NAME);
    const { url: inviteUrl3, nonce: nonce3 } = await generateInviteLink(pageAdmin1, G3_NAME);
    const nonce3Prefix = nonce3.slice(0, 6);

    // Snapshot the invitee's manual-accept queue depth BEFORE this cycle —
    // AC-OBS-3's case above already left one fallen-through invitation
    // (for G1) sitting there unaccepted, so a bare ">= 1" poll would not
    // distinguish "G3's Welcome arrived" from "the stale G1 row is still
    // there." A strict increase over this baseline is the real signal.
    const priorInvitationCount = await pageInvitee.locator('[data-testid^="accept-invitation-"]').count();

    // Send #1. AC-LAND-3: a successful send strips join/admin/name from the
    // URL via router.replace, which unmounts InviteAwaitingBanner (it only
    // renders while those params are present, per groups.tsx) — but the
    // awaiting CARD (AC-CARD-1) is part of the ordinary groups list, not
    // gated by those URL params, so it (and its Cancel action) stay visible
    // regardless of the banner's mount state.
    await pageInvitee.goto(pathWithQueryOf(inviteUrl3));
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible({ timeout: 30_000 });
    await pageInvitee.getByTestId('invite-awaiting-request-btn').click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce3Prefix}`)).toBeVisible({ timeout: 30_000 });

    // Cancel #1.
    await pageInvitee.getByTestId(`cancel-outbound-request-${nonce3Prefix}`).click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce3Prefix}`)).toHaveCount(0, { timeout: 15_000 });

    // Re-send: a fresh rumor on the SAME nonce, recreating a live local
    // outbound record. The banner unmounted after send #1's URL cleanup, so
    // re-visiting the invite link is what remounts it in the Invited state
    // (no live record survives the cancel above) — the same re-goto pattern
    // this file's earlier tests use to observe the banner deterministically.
    await pageInvitee.goto(pathWithQueryOf(inviteUrl3));
    await dismissErrorOverlay(pageInvitee);
    await expect(pageInvitee.getByTestId('invite-awaiting-request-btn')).toBeVisible({ timeout: 30_000 });
    await pageInvitee.getByTestId('invite-awaiting-request-btn').click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce3Prefix}`)).toBeVisible({ timeout: 30_000 });

    // Cancel #2 — the invitee's final local state ahead of approval has NO
    // live outbound record for this nonce, exactly like the AC-OBS-3 case.
    await pageInvitee.getByTestId(`cancel-outbound-request-${nonce3Prefix}`).click();
    await expect(pageInvitee.getByTestId(`outbound-request-card-${nonce3Prefix}`)).toHaveCount(0, { timeout: 15_000 });

    // Admin1 approves the (only ever recorded) pending request for G3 —
    // never retracted by either Cancel, per DD-4.
    await pageAdmin1.goto('/groups/');
    await expect(
      pageAdmin1.getByTestId('groups-empty-state').or(pageAdmin1.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await waitForJoinRequestNotification(pageAdmin1);
    await openGroupDetail(pageAdmin1, G3_NAME);
    await expect(pageAdmin1.locator('[data-testid^="pending-request-row-"]').first()).toBeVisible({ timeout: 30_000 });

    await dismissErrorOverlay(pageAdmin1);
    await pageAdmin1.locator('[data-testid^="approve-request-"]').first().click();
    await expect(pageAdmin1.locator('[data-testid^="pending-request-row-"]')).toHaveCount(0, { timeout: 60_000 });

    // The Welcome must fall through to the manual Accept/Decline path — no
    // live outbound record survives to correlate, so auto-accept cannot
    // fire. A strict increase over the pre-cycle baseline proves THIS
    // Welcome (G3's) actually arrived and fell through, not merely that the
    // stale G1 row from the AC-OBS-3 case is still sitting there.
    await expect(pageInvitee.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => {
          await dismissErrorOverlay(pageInvitee);
          return pageInvitee.locator('[data-testid^="accept-invitation-"]').count();
        },
        { timeout: 90_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
      )
      .toBeGreaterThan(priorInvitationCount);

    // Never auto-accepted: no live record survived to correlate.
    await expect(
      pageInvitee.locator('[data-testid^="group-card-"]', { hasText: G3_NAME }),
    ).toHaveCount(0);
  });
});
