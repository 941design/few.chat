// E2E: epic invite-rescind-and-member-removal, story S11 — AC-SCEN-3,
// AC-SCEN-4, AC-SCEN-6.
//
// Covers the pending-direct-invite marker's full lifecycle through BOTH UI
// entry points that write it (architecture.md: InviteMemberModal.submitInvite
// and profile.tsx's handleAddToGroup — S7/S8 respectively):
//   AC-SCEN-3: Cancel Invite -> Remove Member transition on accept, via BOTH
//              entry points, observed live (no page reload).
//   AC-SCEN-6: the marker (and its "Cancel Invite" label) survives an actual
//              page.reload() while the invite is still pending.
//   AC-SCEN-4: Cancel Invite + confirm evicts a still-pending invitee.
//
// Contact setup uses seedContact/inviteContactViaPicker (helpers/group-setup.ts)
// per architecture.md constraint 7 — never helpers/pairing.ts.
//
// "No reload" discipline (learning e2e_no_reload_poll_for_propagation):
// AC-SCEN-3's transition assertions never call page.reload() — the
// underlying mechanism is MarmotContext's live `subscribeToGroupMessages`
// callback, which bumps `groupDataVersion` on every inbound MLS event and
// re-runs the member-loading effect (pages/groups.tsx:537) without any
// navigation. AC-SCEN-6 is the deliberate exception: it explicitly performs
// a page.reload() to prove the marker is durable IDB state, not memory-only.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, seedContact, acceptInvitationAndWaitJoined } from './helpers/group-setup';
import { queryRelayForEvents } from './helpers/relay-query';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Direct Invite Lifecycle Group';

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    if (nickname) {
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
    }
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

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

test.describe.serial('Direct invite lifecycle — modal path, reload persistence, profile-page path, cancellation', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let ctxD: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let pageD: Page;
  let groupDetailUrl = '';
  // An ad hoc, freshly-generated throwaway identity for the Cancel Invite
  // scenario (AC-SCEN-4) — reusing USER_B/USER_C here would conflict with
  // their own accept-and-confirm progressions elsewhere in this file.
  let userD: { privateKeyHex: string; pubkeyHex: string; seedHex: string; npub: string };

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { nip19 } = await import('nostr-tools');
    const { bytesToHex } = await import('nostr-tools/utils');
    const skBytes = generateSecretKey();
    const privateKeyHex = bytesToHex(skBytes);
    const pubkeyHex = getPublicKey(skBytes);
    userD = { privateKeyHex, pubkeyHex, seedHex: privateKeyHex.slice(0, 32), npub: nip19.npubEncode(pubkeyHex) };

    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, 'Bob'));
    ({ context: ctxC, page: pageC } = await bootUser(browser, USER_C, 'Carol'));
    ({ context: ctxD, page: pageD } = await bootUser(browser, userD as typeof USER_A, 'Dave'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
    await ctxD?.close();
  });

  test('A creates the group', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    groupDetailUrl = pageA.url();
  });

  // -------------------------------------------------------------------
  // AC-SCEN-3 (modal path, part 1) + AC-SCEN-6
  // -------------------------------------------------------------------

  test('A invites B via InviteMemberModal — B\'s row shows Cancel Invite (marker set)', async () => {
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(3_000);

    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${bPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`cancel-invite-${bPrefix}`)).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByTestId(`remove-member-${bPrefix}`)).not.toBeVisible();
  });

  test('AC-SCEN-6: reloading the admin\'s page still renders Cancel Invite for the pending invitee', async () => {
    await pageA.reload();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageA);

    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`cancel-invite-${bPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`remove-member-${bPrefix}`)).not.toBeVisible();
  });

  test('AC-SCEN-3 (modal path, part 2): B accepts — A\'s row flips to Remove Member LIVE, no reload', async () => {
    await pageB.goto('/groups/');
    await expect(
      pageB.getByTestId('groups-empty-state').or(pageB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageB, GROUP_NAME);

    // A stays on the SAME already-loaded group-detail page (from the AC-SCEN-6
    // reload above) — no navigation, no reload — and observes the live flip.
    const bPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`remove-member-${bPrefix}`)).toBeVisible({ timeout: 90_000 });
    await expect(pageA.getByTestId(`cancel-invite-${bPrefix}`)).not.toBeVisible();
  });

  // -------------------------------------------------------------------
  // AC-SCEN-3 (profile-page path)
  // -------------------------------------------------------------------

  test('A adds C via the profile-page handleAddToGroup control — C\'s row shows Cancel Invite', async () => {
    await seedContact(pageA, USER_C.npub);
    // inviteByNpub (behind handleAddToGroup) needs C's KeyPackage on the relay,
    // exactly as the modal path and every other invite site gate for it. C booted
    // in beforeAll, but poll to eliminate the publish race before adding — omitting
    // this let the add resolve {ok:false} and the success Alert never rendered.
    await waitForKeyPackage(pageA, USER_C.pubkeyHex);
    await pageA.goto(`/profile?pubkey=${USER_C.pubkeyHex}`);
    await expect(pageA.getByTestId('profile-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageA);

    await expect(pageA.getByTestId('profile-add-to-group')).toBeVisible({ timeout: 30_000 });
    // Only one addable group exists (created above), so the select defaults to it.
    await pageA.getByTestId('profile-add-to-group-btn').click();
    // The success confirmation must be reachable in this single-addable-group
    // case (BACKLOG profile-page-add-group-success-confirmation): the invite
    // makes C a pending member, so the picker unmounts in the same render that
    // sets success — the confirmation renders outside the picker gate. Waiting
    // on it also awaits the in-flight invite before we navigate away.
    await expect(pageA.getByTestId('profile-add-to-group-success')).toBeVisible({ timeout: 60_000 });
    await expect(pageA.getByTestId('profile-add-to-group')).not.toBeVisible();

    await pageA.goto(groupDetailUrl);
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pageA);

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`cancel-invite-${cPrefix}`)).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByTestId(`remove-member-${cPrefix}`)).not.toBeVisible();
  });

  test('AC-SCEN-3 (profile-page path, part 2): C accepts — A\'s row flips to Remove Member LIVE, no reload', async () => {
    await pageC.goto('/groups/');
    await expect(
      pageC.getByTestId('groups-empty-state').or(pageC.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(pageC.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pageC, GROUP_NAME);

    // A stays on the group-detail page from the previous test — no reload.
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`remove-member-${cPrefix}`)).toBeVisible({ timeout: 90_000 });
    await expect(pageA.getByTestId(`cancel-invite-${cPrefix}`)).not.toBeVisible();
  });

  // -------------------------------------------------------------------
  // AC-SCEN-4
  // -------------------------------------------------------------------

  test('AC-SCEN-4: A invites D, then cancels the still-pending invite — D\'s row disappears', async () => {
    // D briefly online only to publish a KeyPackage — then closed, mirroring
    // groups-cancel-pending.spec.ts's phantom-invitee pattern (this file's
    // template for the cancellation flow).
    await waitForKeyPackage(pageD, userD.pubkeyHex);
    await ctxD.close();

    await inviteContactViaPicker(pageA, userD.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(3_000);

    const dPrefix = userD.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`cancel-invite-${dPrefix}`)).toBeVisible({ timeout: 30_000 });

    await pageA.getByTestId(`cancel-invite-${dPrefix}`).click();
    await expect(pageA.getByTestId(`cancel-invite-confirm-${dPrefix}`)).toBeVisible({ timeout: 10_000 });
    await pageA.getByTestId(`cancel-invite-confirm-${dPrefix}`).click();
    await expect(pageA.getByTestId(`cancel-invite-confirm-${dPrefix}`)).not.toBeVisible({ timeout: 30_000 });

    await expect(pageA.getByTestId(`member-item-${dPrefix}`)).toHaveCount(0, { timeout: 15_000 });
  });
});
