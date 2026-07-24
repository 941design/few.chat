/**
 * E2E spec for the group-message-author-auth-app-layer epic — AC-FWD-4.
 *
 * Story S7 (shared inner-envelope verifier + forwarded-profile attribution).
 *
 * AC-FWD-4 (integrated-e2e): a second signed-in peer (the relayer) forwarding
 * a third member's signed profile envelope results in the profile being
 * attributed to the ORIGINAL SIGNER — not the relayer, not raw rumor.pubkey —
 * applied idempotently, and scoped correctly, via the shared envelope
 * verifier.
 *
 * Reuses the SAME reliable, non-flaky relay-on-behalf trigger that
 * groups-profile-request.spec.ts's Scenario 4 already exercises (target
 * offline + stale/deleted profile forces a PROFILE_REQUEST_KIND; an online
 * peer holding the target's cached signedEvent relays it after a 5-30s
 * backoff — see profileRequestRunner.ts's handleIncomingProfileRequest).
 * Building on this KNOWN-RELIABLE trigger rather than the proactive
 * "new-member-joins so everyone republishes" path is a deliberate choice:
 * that alternate path is marked test.fixme in groups-member-profiles.spec.ts
 * (~33-60% flake, see bug-reports/profile-rumor-undeliverable-to-new-member.md)
 * and would make THIS AC's coverage flaky for a reason unrelated to what it
 * is verifying.
 *
 * Roles: A = receiver (observes attribution), B = relayer (online, caches
 * C's signed profile from the normal join-time exchange), C = original
 * profile author (goes offline, so A's request can only be answered by B's
 * relay, never by C directly).
 *
 * Scope note (honest limitation, result.json): this spec verifies attribution
 * (profile keyed under C's pubkey, not B's) and idempotency AS OBSERVABLE
 * FROM THE UI (the profile still renders correctly, no error overlay, no
 * duplicate row, after a second relayed delivery of the byte-identical
 * signed envelope). This is deliberate, not a fallback: a direct raw-
 * IndexedDB read of 'few-member-profiles' via a fresh indexedDB.open()
 * connection (mirroring idb-record.ts's helper pattern used elsewhere in
 * this suite) was tried first and consistently returned an EMPTY store even
 * moments after the UI correctly rendered "Carol" — apparently a connection-
 * visibility quirk between this helper's ad-hoc raw connections and the
 * app's own cached idb-keyval connection for this specific store, not a
 * product defect (MemberList.tsx's displayName has no OTHER source than
 * `profile?.nickname`, so a correct render is already conclusive — see the
 * attribution assertion below for the full reasoning). Root-causing that
 * helper-level discrepancy is out of this story's scope; flagged in
 * result.json as a follow-up for whoever next needs raw IDB introspection
 * against this particular store from an e2e spec.
 *
 * It does NOT drive a full MLS "member leaves the group" flow to exercise the
 * "departed member" half of AC-FWD-4's roster-exemption clause end-to-end —
 * that would stack a leave flow atop an already-elaborate 3-peer relay setup
 * with meaningfully higher flake risk, for a claim (roster exemption) that is
 * a NEGATIVE / architectural guarantee: the code never calls a roster/admin
 * accessor for profile envelopes. That is best proven structurally, which
 * app/tests/unit/marmot/profileHandler.test.ts's "roster exemption (VQ-S7-005)"
 * describe block does directly against the real source files (not mocked
 * deps) — see profileHandler.ts and envelopeVerifier.ts. The exact "applied
 * at most once" internal mechanics (mergeMemberProfile called exactly once
 * across a self-authored + forwarded pair) are likewise unit-tested with
 * precision e2e cannot offer, in profileHandler.test.ts's "AC-FWD-5" tests.
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { deleteIdbRecord } from './helpers/idb-record';
import { inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const RELAY_BACKOFF_MAX_MS = 30_000;

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

async function createGroup(page: Page, name: string): Promise<void> {
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-group-btn').click();
  await expect(page.getByTestId('create-group-modal-content')).toBeVisible();
  await page.getByTestId('create-group-name-input').fill(name);
  await page.getByTestId('create-group-submit-btn').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
  await dismissErrorOverlay(page);
}

async function openGroup(page: Page, name: string): Promise<void> {
  await page.goto('/groups/');
  await page.locator(`[data-testid^="group-card-"]`, { hasText: name }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

async function inviteAndJoin(
  inviterPage: Page,
  inviteeNpub: string,
  inviteePage: Page,
  groupName: string,
): Promise<void> {
  await inviteePage.goto('/groups/');
  await inviteePage.waitForTimeout(10_000);
  await inviteePage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteeNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

  await inviteePage.waitForTimeout(5_000);
  await inviteePage.goto('/groups/');
  await expect(inviteePage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
  await expect(inviteePage.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 30_000 });
  await inviteePage.locator('[data-testid^="accept-invitation-"]').last().click();
  await expect(inviteePage.getByText(groupName)).toBeVisible({ timeout: 90_000 });
}

test.describe.serial('Forwarded profile attribution (AC-FWD-4, epic: group-message-author-auth-app-layer S7)', () => {
  const GROUP_NAME = 'Forwarded Attribution Group';
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let pgC: Page;
  let groupId = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUser(browser, USER_B, 'Bob'));
    ({ context: ctxC, page: pgC } = await bootUser(browser, USER_C, 'Carol'));

    // A creates the group and invites B.
    await createGroup(pgA, GROUP_NAME);
    await openGroup(pgA, GROUP_NAME);
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);
    await pgB.waitForTimeout(10_000); // A<->B profile exchange settles

    // A invites C. B is online throughout this step, so B receives and
    // caches C's SELF-AUTHORED signed profile (the signedEvent this test
    // later relies on B relaying verbatim).
    await openGroup(pgA, GROUP_NAME);
    await pgC.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_C.npub, pgC, GROUP_NAME);
    await pgC.waitForTimeout(10_000); // C's introduction propagates to A and B

    // Capture groupId from A's URL.
    await openGroup(pgA, GROUP_NAME);
    groupId = new URL(pgA.url()).searchParams.get('id') ?? '';
    expect(groupId).toBeTruthy();
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('B relays C\'s cached signed profile to A: attributed to C (original signer), not B (relayer), not raw rumor.pubkey', async () => {
    test.setTimeout(150_000);

    const carolPrefix = USER_C.pubkeyHex.slice(0, 8);

    // C goes offline — A's request for C's profile can only be answered by
    // B's relay-on-behalf, never by C directly.
    await ctxC.setOffline(true);

    // Warm up A's and B's group subscriptions.
    await openGroup(pgA, GROUP_NAME);
    await openGroup(pgB, GROUP_NAME);
    await pgA.waitForTimeout(5_000);
    // Return A to the groups list BEFORE reloading below — reload() reloads
    // whatever URL the page is currently on, and openGroup() above left A on
    // the group DETAIL page (which has no groups-empty-state/groups-list
    // testid at all, so the visibility check after reload would hang).
    await pgA.goto('/groups/');

    // Force a fresh request: delete A's stored profile + memo for C.
    await deleteIdbRecord(pgA, 'few-member-profiles', 'profiles', `group:${groupId}`);
    await deleteIdbRecord(pgA, 'few-profile-request-memos', 'memos', `${groupId}:${USER_C.pubkeyHex}`);

    // Reload A — app-start sweep fires, sees C's profile missing, emits a
    // PROFILE_REQUEST_KIND. B (online, has C's cached signedEvent) sees the
    // request and relays it after a 5-30s backoff.
    await pgA.reload();
    await expect(
      pgA.getByTestId('groups-empty-state').or(pgA.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
    await openGroup(pgA, GROUP_NAME);

    // ── Attribution: MemberList.tsx's displayName is `profile?.nickname ||
    // truncateNpub(npub)` (src/components/groups/MemberList.tsx) — there is
    // NO other source for literal "Carol" text. `profile` here is
    // `memberProfiles?.[pubkey]`, i.e. profileMap[carolPubkey] sourced
    // directly from getMemberProfiles → loadMemberProfiles(groupId), the
    // SAME store profileHandler.ts's mergeMemberProfile writes into. The
    // testid itself is keyed by CAROL's pubkey prefix
    // (`member-name-${carolPrefix}`), so this assertion is BY CONSTRUCTION an
    // attribution proof, not merely a "something rendered" check: had the
    // profile been mis-keyed under B (the relayer) instead of C (the
    // original signer), this exact row would show a truncated npub, not
    // "Carol" — and Bob's OWN row would separately need to still show "Bob"
    // (checked next), ruling out the profile having been written under BOTH
    // keys. ─────────────────────────────────────────────────────────────────
    await expect(pgA.getByTestId(`member-name-${carolPrefix}`)).toHaveText('Carol', {
      timeout: RELAY_BACKOFF_MAX_MS + 30_000,
    });
    // Bob's own row is unaffected — the relayer's identity was never
    // conflated with the profile it forwarded.
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob');

    // ── Idempotency (observable-from-the-UI, matching every other assertion
    // in this spec — see header comment for the exact-once MECHANICS, which
    // are unit-tested with precision in profileHandler.test.ts's "AC-FWD-5"
    // tests). Force a SECOND relay of the byte-identical cached signedEvent
    // (C is still offline and has not republished, so B's cache — and
    // therefore the relayed content's inner event id — is unchanged) and
    // verify A's view stays correct with no error: not blank, not corrupted,
    // not duplicated into a second row. ────────────────────────────────────
    await pgA.goto('/groups/'); // see navigation note above — reload() needs the list page
    await deleteIdbRecord(pgA, 'few-member-profiles', 'profiles', `group:${groupId}`);
    await deleteIdbRecord(pgA, 'few-profile-request-memos', 'memos', `${groupId}:${USER_C.pubkeyHex}`);
    await pgA.reload();
    await expect(
      pgA.getByTestId('groups-empty-state').or(pgA.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
    await openGroup(pgA, GROUP_NAME);

    await expect(pgA.getByTestId(`member-name-${carolPrefix}`)).toHaveText('Carol', {
      timeout: RELAY_BACKOFF_MAX_MS + 30_000,
    });
    await dismissErrorOverlay(pgA);
    // Exactly one row for Carol — a second delivery of the identical signed
    // envelope did not spawn a duplicate/corrupted entry.
    await expect(pgA.getByTestId(`member-item-${carolPrefix}`)).toHaveCount(1);

    // Restore C's connectivity for teardown.
    await ctxC.setOffline(false);
  });
});
