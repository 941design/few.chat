/**
 * E2E: Migration backfill — knownPeers seeded from current groups; strangers purged (AC-TEST-8)
 *
 * Setup:
 *   1. Alice (USER_A) and Bob (USER_B) join a group (full pull-only flow).
 *   2. Pre-seed Alice's lp_contacts_v1 with Mallory (USER_C) — a non-group member.
 *   3. Pre-seed IDB message threads for both Bob and Mallory.
 *   4. Ensure lp_knownPeersMigrated_v2 is absent (so migration runs on next boot).
 *
 * After boot with the group membership live:
 *   (a) lp_knownPeers_v1 contains Bob's lowercased pubkey.
 *   (b) lp_knownPeers_v1 does NOT contain Mallory's pubkey.
 *   (c) Bob's IDB DM thread still exists.
 *   (d) Mallory's IDB DM thread is gone.
 *   (e) Mallory is absent from lp_contacts_v1.
 *   (f) lp_knownPeersMigrated_v2 is set.
 *
 * Requires: make e2e-up (strfry relay at ws://localhost:7777).
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { writeIdbRecord, readIdbRecord } from './helpers/idb-record';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Migration Backfill Test Group';

const FAKE_MALLORY_MESSAGE = [
  { id: 'mallory-msg-mig-1', content: 'stranger dm', senderPubkey: '', groupId: '', createdAt: 1_700_000_000_000 },
];
const FAKE_BOB_MESSAGE = [
  { id: 'bob-msg-mig-1', content: 'member dm', senderPubkey: '', groupId: '', createdAt: 1_700_000_001_000 },
];

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

test.describe.serial('Migration backfill: knownPeers seeded from groups; strangers purged (AC-TEST-8)', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Alice creates a group and invites Bob', async () => {
    // Walled Garden v2 pull-only: warm up Bob's seen-set with stale wraps
    // from earlier specs, then clear the queue so Alice's invite is the only
    // entry Bob has to accept.
    await bobPage.waitForTimeout(10_000);
    await bobPage.evaluate(() => {
      localStorage.removeItem('lp_pendingInvitations_v1');
    });

    await alicePage.getByTestId('create-group-btn').click();
    await expect(alicePage.getByTestId('create-group-modal-content')).toBeVisible();
    await alicePage.getByTestId('create-group-name-input').fill(GROUP_NAME);
    await alicePage.getByTestId('create-group-submit-btn').click();
    await expect(alicePage.getByText(GROUP_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(alicePage);
    await alicePage.waitForTimeout(3_000);

    await alicePage.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME }).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(alicePage, USER_B.npub);
    await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await alicePage.waitForTimeout(3_000);
  });

  test('Bob accepts the invitation', async () => {
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(bobPage.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 30_000 });
    await acceptInvitationAndWaitJoined(bobPage, GROUP_NAME);
    // Wait for MLS group state to propagate on Alice's side
    await alicePage.waitForTimeout(10_000);
  });

  test('Prepare migration state: seed Mallory contact + IDB threads, clear migration flag', async () => {
    // ── Step 1: Navigate to trigger storage access, seed IDB threads ──────────
    await alicePage.goto('/');
    await alicePage.waitForLoadState('networkidle');

    const malloryThreadKey = `few:messages:dm:${USER_C.pubkeyHex.toLowerCase()}`;
    const bobThreadKey = `few:messages:dm:${USER_B.pubkeyHex.toLowerCase()}`;

    await writeIdbRecord(alicePage, 'keyval-store', 'keyval', malloryThreadKey, FAKE_MALLORY_MESSAGE);
    await writeIdbRecord(alicePage, 'keyval-store', 'keyval', bobThreadKey, FAKE_BOB_MESSAGE);

    // Verify seeds
    const malloryBefore = await readIdbRecord(alicePage, 'keyval-store', 'keyval', malloryThreadKey);
    expect(malloryBefore).not.toBeNull();
    const bobBefore = await readIdbRecord(alicePage, 'keyval-store', 'keyval', bobThreadKey);
    expect(bobBefore).not.toBeNull();

    // ── Step 2: Seed Mallory as a contact and clear migration flag ─────────────
    const now = new Date().toISOString();
    await alicePage.evaluate(
      ({ malloryPub, ts }) => {
        // Add Mallory to contacts (Bob is auto-added as a group contact — Mallory is not)
        const existing = JSON.parse(localStorage.getItem('lp_contacts_v1') ?? '{}') as Record<string, unknown>;
        existing[malloryPub] = { pubkeyHex: malloryPub, firstSeenAt: ts, lastSeenAt: ts, archivedAt: null };
        localStorage.setItem('lp_contacts_v1', JSON.stringify(existing));

        // Clear the migration flag so the migration runs on next boot
        localStorage.removeItem('lp_knownPeersMigrated_v2');
        // Also clear any prior knownPeers so we test from scratch
        localStorage.removeItem('lp_knownPeers_v1');
      },
      { malloryPub: USER_C.pubkeyHex, ts: now },
    );

    // Verify migration flag is absent
    const migFlag = await alicePage.evaluate(() => localStorage.getItem('lp_knownPeersMigrated_v2'));
    expect(migFlag).toBeNull();
  });

  test('AC-TEST-8(a-f): After reload migration runs — Bob retained, Mallory purged, flag set', async () => {
    // Reload Alice's page to trigger MarmotContext.init (which runs migration)
    await alicePage.reload();
    await alicePage.waitForLoadState('networkidle');

    // Wait for MarmotContext to initialize and migration to complete
    await alicePage.waitForFunction(
      () => !!(window as any).__fewUnread,
      null,
      { timeout: 30_000 },
    );
    // Give the async migration (purgeStrangerDmThreads, etc.) time to finish
    await alicePage.waitForTimeout(5_000);

    // AC-TEST-8(f): migration flag is now set
    const migFlag = await alicePage.evaluate(() => localStorage.getItem('lp_knownPeersMigrated_v2'));
    expect(migFlag).not.toBeNull();

    // AC-TEST-8(a): Bob's pubkey is in lp_knownPeers_v1
    const knownPeersRaw = await alicePage.evaluate(() => localStorage.getItem('lp_knownPeers_v1'));
    expect(knownPeersRaw).not.toBeNull();
    const knownPeers: string[] = JSON.parse(knownPeersRaw ?? '[]');
    expect(knownPeers).toContain(USER_B.pubkeyHex.toLowerCase());

    // AC-TEST-8(b): Mallory's pubkey is NOT in lp_knownPeers_v1
    expect(knownPeers).not.toContain(USER_C.pubkeyHex.toLowerCase());

    // AC-TEST-8(e): Mallory is absent from lp_contacts_v1
    const contactsRaw = await alicePage.evaluate(() => localStorage.getItem('lp_contacts_v1'));
    if (contactsRaw) {
      const contacts = JSON.parse(contactsRaw) as Record<string, unknown>;
      expect(contacts[USER_C.pubkeyHex]).toBeUndefined();
    }

    // AC-TEST-8(c): Bob's IDB DM thread still exists
    const bobThreadKey = `few:messages:dm:${USER_B.pubkeyHex.toLowerCase()}`;
    const bobAfter = await readIdbRecord(alicePage, 'keyval-store', 'keyval', bobThreadKey);
    expect(bobAfter).not.toBeNull();

    // AC-TEST-8(d): Mallory's IDB DM thread is gone
    const malloryThreadKey = `few:messages:dm:${USER_C.pubkeyHex.toLowerCase()}`;
    const malloryAfter = await readIdbRecord(alicePage, 'keyval-store', 'keyval', malloryThreadKey);
    expect(malloryAfter).toBeNull();
  });
});
