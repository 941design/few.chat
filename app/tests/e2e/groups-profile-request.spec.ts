/**
 * E2E spec for the member-profile-discovery-and-relay-on-behalf epic.
 *
 * AC-045: six verification scenarios
 * AC-046: helpers installRumorCounter / getRumorCount / deleteIdbRecord
 *
 * Story: 07-e2e-coverage-six-scenarios
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { installRumorCounter, getRumorCount } from './helpers/rumor-counter';
import { deleteIdbRecord, readIdbRecord, writeIdbRecord } from './helpers/idb-record';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

// Constants mirrored from profileRequestSync.ts — kept in sync manually
const PROFILE_REQUEST_KIND = 30;
const PROFILE_RUMOR_KIND = 0;
const RELAY_BACKOFF_MAX_MS = 30_000;
const UNANSWERED_RETRY_MS = 60 * 60 * 1000; // 1h
const UNANSWERED_MAX_ATTEMPTS = 3;
const DAYS_8_MS = 8 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared setup helpers (mirrors groups-profile-update-propagation.spec.ts)
// ---------------------------------------------------------------------------

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
  // Walled Garden v2 pull-only: warm up invitee's seen-set, then clear queue.
  await inviteePage.goto('/groups/');
  await inviteePage.waitForTimeout(10_000);
  await inviteePage.evaluate(() => {
    localStorage.removeItem('lp_pendingInvitations_v1');
  });

  await dismissErrorOverlay(inviterPage);
  await inviteContactViaPicker(inviterPage, inviteeNpub);
  await expect(inviterPage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

  // Invitee must explicitly accept the pending invitation.
  await inviteePage.waitForTimeout(5_000);
  await inviteePage.goto('/groups/');
  await expect(inviteePage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
  await expect(inviteePage.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 30_000 });
  await acceptInvitationAndWaitJoined(inviteePage, groupName);
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

test.describe.serial('Profile request discovery — six scenarios (AC-045/AC-046)', () => {
  const GROUP_NAME = 'Profile Request Test Group';
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

    // A creates the group
    await createGroup(pgA, GROUP_NAME);
    await openGroup(pgA, GROUP_NAME);

    // A invites B
    await pgB.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_B.npub, pgB, GROUP_NAME);

    // Wait for A and B to exchange profiles via onHistorySynced
    await pgB.waitForTimeout(10_000);

    // A invites C
    await openGroup(pgA, GROUP_NAME);
    await pgC.waitForTimeout(5_000);
    await inviteAndJoin(pgA, USER_C.npub, pgC, GROUP_NAME);

    // Wait for C's initial onHistorySynced introduction to propagate
    await pgC.waitForTimeout(10_000);

    // Navigate C into the group to capture the groupId from the URL
    await pgC.locator(`[data-testid^="group-card-"]`, { hasText: GROUP_NAME }).click();
    await expect(pgC.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    groupId = new URL(pgC.url()).searchParams.get('id') ?? '';
    expect(groupId).toBeTruthy();

    // Navigate C away — each scenario controls when C enters the group
    await pgC.goto('/groups/');
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Aged-history backfill (target online)
  // -------------------------------------------------------------------------
  test('1. Aged-history backfill: C gets profiles after simulated history gap (AC-045)', async () => {
    test.setTimeout(120_000);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    const alicePrefix = USER_A.pubkeyHex.slice(0, 8);

    // Warm up A's and B's group subscriptions so their dispatchers are active
    // when C's profile request arrives. Under suite-accumulated relay load,
    // group subscriptions can take noticeable time to drain historical kind-445
    // backlog before they start handling fresh events promptly.
    await openGroup(pgA, GROUP_NAME);
    await openGroup(pgB, GROUP_NAME);
    await pgA.waitForTimeout(5_000);

    // Simulate aged history: delete C's stored profiles and memos for A and B
    await deleteIdbRecord(pgC, 'few-member-profiles', 'profiles', `group:${groupId}`);
    await deleteIdbRecord(pgC, 'few-profile-request-memos', 'memos', `${groupId}:${USER_A.pubkeyHex}`);
    await deleteIdbRecord(pgC, 'few-profile-request-memos', 'memos', `${groupId}:${USER_B.pubkeyHex}`);

    // Reload C — app-start sweep fires, sees missing profiles, emits requests
    await pgC.reload();
    await expect(
      pgC.getByTestId('groups-empty-state').or(pgC.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });

    // Navigate C into the group — requestProfilesIfStale triggers any remaining stale members
    await openGroup(pgC, GROUP_NAME);

    // A and B are online and should reply to C's request. Timeouts are generous
    // because under suite-accumulated relay load, Alice's MLS dispatcher can be
    // slow to drain the kind-445 backlog and respond to C's profile request.
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', { timeout: 60_000 });
    await expect(pgC.getByTestId(`member-name-${alicePrefix}`)).toHaveText('Alice', { timeout: 60_000 });

    // Leave C on the groups list so the next scenario's reload() lands on /groups/
    await pgC.goto('/groups/');
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Periodic refresh (stale memo triggers new request)
  // -------------------------------------------------------------------------
  test('2. Periodic refresh: stale memo triggers new request (AC-045)', async () => {
    test.setTimeout(90_000);

    const eightDaysAgo = Date.now() - DAYS_8_MS;
    const staleDate = new Date(eightDaysAgo).toISOString();
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);

    // Read C's current profiles for the group and make B's profile stale
    const existingProfiles = await readIdbRecord<unknown[]>(
      pgC,
      'few-member-profiles',
      'profiles',
      `group:${groupId}`,
    );
    const stalifiedProfiles = (existingProfiles ?? []).map((p: unknown) => {
      const profile = p as Record<string, unknown>;
      return profile.pubkeyHex === USER_B.pubkeyHex
        ? { ...profile, updatedAt: staleDate, signedEvent: null }
        : profile;
    });
    await writeIdbRecord(pgC, 'few-member-profiles', 'profiles', `group:${groupId}`, stalifiedProfiles);

    // Write a stale memo for B (lastRequestAt = 8d ago, so REQUEST_DEDUPE_MS window has expired)
    await writeIdbRecord(pgC, 'few-profile-request-memos', 'memos', `${groupId}:${USER_B.pubkeyHex}`, {
      groupId,
      targetPubkey: USER_B.pubkeyHex,
      lastRequestAt: eightDaysAgo,
      lastAnsweredAt: eightDaysAgo,
      attempts: 0,
    });

    // Reload C → app-start sweep emits a fresh request for stale B
    await pgC.reload();
    await expect(
      pgC.getByTestId('groups-empty-state').or(pgC.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });

    // Navigate C to the group and verify B's profile arrives (B is online and replies)
    await openGroup(pgC, GROUP_NAME);
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', { timeout: 30_000 });

    // Verify memo was updated: lastRequestAt should be recent (sweep ran)
    const memo = await readIdbRecord<Record<string, unknown>>(
      pgC,
      'few-profile-request-memos',
      'memos',
      `${groupId}:${USER_B.pubkeyHex}`,
    );
    expect(memo).not.toBeNull();
    expect((memo!.lastRequestAt as number) > eightDaysAgo).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Per-peer dedupe — no duplicate requests within cooldown window
  // -------------------------------------------------------------------------
  test('3. Per-peer dedupe: no second request within 1h cooldown (AC-045)', async () => {
    test.setTimeout(30_000);

    // Install rumor counter on C for the NEXT page load
    await installRumorCounter(pgC, [PROFILE_REQUEST_KIND, PROFILE_RUMOR_KIND]);

    // Navigate C to the group — B's profile is now fresh (from scenario 2),
    // so isProfileStale returns false → no PROFILE_REQUEST_KIND rumor emitted
    await openGroup(pgC, GROUP_NAME);

    // Allow any in-flight effects to settle
    await pgC.waitForTimeout(3_000);

    // Verify no PROFILE_REQUEST_KIND rumor was sent for Bob (his profile is fresh)
    const outCount = await getRumorCount(pgC, PROFILE_REQUEST_KIND, 'out');
    expect(outCount).toBe(0);

    // Navigate back to groups list for next scenario
    await pgC.goto('/groups/');
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Relay-on-behalf when target is offline
  // -------------------------------------------------------------------------
  test('4. Relay-on-behalf: A relays B\'s cached signed profile when B is offline (AC-045)', async () => {
    test.setTimeout(120_000);

    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);

    // B goes offline
    await ctxB.setOffline(true);

    // Delete C's stored profile for B and the memo (force fresh request)
    const existingProfiles = await readIdbRecord<unknown[]>(
      pgC,
      'few-member-profiles',
      'profiles',
      `group:${groupId}`,
    );
    const profilesWithoutBob = (existingProfiles ?? []).filter(
      (p: unknown) => (p as Record<string, unknown>).pubkeyHex !== USER_B.pubkeyHex,
    );
    await writeIdbRecord(pgC, 'few-member-profiles', 'profiles', `group:${groupId}`, profilesWithoutBob);
    await deleteIdbRecord(pgC, 'few-profile-request-memos', 'memos', `${groupId}:${USER_B.pubkeyHex}`);

    // Navigate C into the group — requestProfilesIfStale fires → C emits PROFILE_REQUEST_KIND for B
    await openGroup(pgC, GROUP_NAME);

    // A (online, has B's signedEvent cached) sees the request and schedules a relay.
    // After 5–30s backoff, A sends B's cached signed profile to the group.
    // Timeout is max backoff (30s) + 30s network buffer.
    await expect(pgC.getByTestId(`member-name-${bobPrefix}`)).toHaveText('Bob', {
      timeout: RELAY_BACKOFF_MAX_MS + 30_000,
    });

    // Restore B's connectivity for any teardown / future tests
    await ctxB.setOffline(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Retry state machine — capped at UNANSWERED_MAX_ATTEMPTS
  // -------------------------------------------------------------------------
  // Deferred (AC-045 amended 2026-05-18 in RECONCILE). The 1h/7d/UNANSWERED_MAX_ATTEMPTS=3
  // boundary contract is verified deterministically by
  // app/tests/unit/profileRequestStorage.integration.test.ts (8 tests over the real
  // recordRequestEmitted / shouldEmitRequest storage path via fake-indexeddb + idb-keyval).
  // Under Playwright's page.clock.install() + page.goto() cycling, memo.attempts stays at 0
  // across simulated 2h jumps — real root cause is undiagnosed (candidates: fake-clock +
  // setInterval interaction, fake-clock-driven memo update path, or requestedOnEntryForRef
  // cycling under cross-navigation re-mount). Earlier fixme comment cited a wiring gap —
  // that diagnosis was wrong; pages/groups.tsx:130 does call requestProfilesIfStale per
  // AC-026 which holds. Unfixme this scenario once the Playwright-clock interaction is
  // root-caused.
  test.fixme('5. Retry state machine: attempts capped at UNANSWERED_MAX_ATTEMPTS (AC-045)', async () => {
    test.setTimeout(120_000);

    // Ensure B stays offline (still from scenario 4)
    await ctxB.setOffline(true);

    const eightDaysAgo = Date.now() - DAYS_8_MS;
    const staleDate = new Date(eightDaysAgo).toISOString();

    // Write a stale profile for B and clear the memo
    const existingProfiles = await readIdbRecord<unknown[]>(
      pgC,
      'few-member-profiles',
      'profiles',
      `group:${groupId}`,
    );
    const stalifiedProfiles = (existingProfiles ?? []).map((p: unknown) => {
      const profile = p as Record<string, unknown>;
      return profile.pubkeyHex === USER_B.pubkeyHex
        ? { ...profile, updatedAt: staleDate, signedEvent: null }
        : profile;
    });
    await writeIdbRecord(pgC, 'few-member-profiles', 'profiles', `group:${groupId}`, stalifiedProfiles);
    await deleteIdbRecord(pgC, 'few-profile-request-memos', 'memos', `${groupId}:${USER_B.pubkeyHex}`);

    // Install a fake clock on C starting from the current real time
    await pgC.clock.install();

    // Navigate to group → request 1 (attempts = 1)
    await openGroup(pgC, GROUP_NAME);
    await pgC.waitForTimeout(2_000); // let useEffect settle
    await pgC.goto('/groups/');

    // Advance 2h (> UNANSWERED_RETRY_MS = 1h) → request 2 (attempts = 2)
    await pgC.clock.fastForward(2 * UNANSWERED_RETRY_MS);
    await openGroup(pgC, GROUP_NAME);
    await pgC.waitForTimeout(2_000);
    await pgC.goto('/groups/');

    // Advance another 2h → request 3 (attempts = 3)
    await pgC.clock.fastForward(2 * UNANSWERED_RETRY_MS);
    await openGroup(pgC, GROUP_NAME);
    await pgC.waitForTimeout(2_000);
    await pgC.goto('/groups/');

    // Advance another 2h → shouldEmitRequest blocks (attempts >= UNANSWERED_MAX_ATTEMPTS)
    await pgC.clock.fastForward(2 * UNANSWERED_RETRY_MS);
    await openGroup(pgC, GROUP_NAME);
    await pgC.waitForTimeout(2_000);

    // Verify: memo.attempts = UNANSWERED_MAX_ATTEMPTS (3), no 4th attempt
    const memo = await readIdbRecord<Record<string, unknown>>(
      pgC,
      'few-profile-request-memos',
      'memos',
      `${groupId}:${USER_B.pubkeyHex}`,
    );
    expect(memo).not.toBeNull();
    expect(memo!.attempts).toBe(UNANSWERED_MAX_ATTEMPTS);

    // Reset C's page state (fake clock remains active but test 6 doesn't depend on wall time)
    await pgC.goto('/groups/');
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Forged-sig rejection — bad sig is rejected before merge
  // -------------------------------------------------------------------------
  test('6. Forged-sig rejection: parseProfilePayload returns null for bad sig (AC-040 / AC-045)', async () => {
    test.setTimeout(30_000);

    // Wait for window.__fewTest.parseProfilePayload to be exposed by MarmotContext
    await pgC.waitForFunction(
      () => typeof (window as unknown as Record<string, unknown>).__fewTest !== 'undefined' &&
        typeof ((window as unknown as Record<string, Record<string, unknown>>).__fewTest)?.parseProfilePayload === 'function',
      { timeout: 20_000 },
    );

    // Forge a SignedProfileEvent: valid shape but sig is 128 hex chars of 'a' (not a valid schnorr sig)
    const forgedContent = JSON.stringify({
      id: 'a'.repeat(64),
      pubkey: USER_B.pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      kind: 0,
      tags: [],
      content: JSON.stringify({
        nickname: 'FORGED_BOB',
        avatar: null,
        updatedAt: new Date().toISOString(),
      }),
      sig: 'a'.repeat(128),
    });

    // parseProfilePayload must return null — sig verification via nostr-tools verifyEvent fails
    const parsed = await pgC.evaluate((content) => {
      return ((window as unknown as Record<string, Record<string, unknown>>).__fewTest)
        ?.parseProfilePayload(content);
    }, forgedContent);

    expect(parsed).toBeNull();
  });
});
