// E2E: epic invite-rescind-and-member-removal, story S11 — AC-SCEN-5,
// AC-REMOVE-4, AC-SCEN-7, AC-UNIV-1, AC-SCEN-8, AC-PURGE-5.
//
// Three-identity fixture (A = creator/acting admin, B = co-admin, C = the
// removed/re-invited member) whose test sequence deliberately chains three
// ACs through ONE re-invite of the SAME pubkey, because the two proofs it
// establishes are the two halves of the same event:
//
//   1. A invites B, B joins, A grants B admin (co-admin with FULL normal
//      history — this is NOT the "no local marker" case yet).
//   2. A invites C, C joins as a CONFIRMED regular member.
//   3. AC-SCEN-5 / AC-REMOVE-4: A removes C via "Remove Member". Asserted on
//      BOTH A's page (acting admin) and B's page (second admin, live, no
//      reload — the co-admin's client picks up the MLS Remove commit via
//      the same live subscription that bumps groupDataVersion).
//   4. A directly re-invites the SAME C pubkey. On A's page, the row must
//      show "Cancel Invite" — NOT "Remove Member" — immediately: this is
//      the observable proxy for AC-SCEN-8 / AC-PURGE-5 (the per-member
//      profile purge that ran after step 3's removal; a failed purge would
//      leave C's OLD confirmed profile entry behind, making the re-invited
//      row look confirmed rather than pending).
//   5. That SAME re-invite is, from B's side, EXACTLY the AC-SCEN-7 /
//      AC-UNIV-1 fixture: B (co-admin) never wrote or received a
//      pending-direct-invite marker for THIS invite of C (only A's device
//      did, in step 4) — B's own IDB has no record of it. B's row for C
//      must still render "Remove Member" (a functioning control, not
//      disabled/absent), proving the marker governs only the *label*, never
//      the removal *capability*. B clicks it and confirms; C is evicted.
//
// "No reload" discipline: every cross-client assertion below (step 3's
// second-admin visibility, step 5's marker-less affordance) is observed on
// an already-open page via live groupDataVersion bumps from
// subscribeToGroupMessages — never page.reload().

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Remove Member E2E Group';

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

async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await dismissErrorOverlay(page);
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
}

/** Invite by npub via the contact picker; waits for invite-success. */
async function inviteMember(page: Page, npub: string): Promise<void> {
  await inviteContactViaPicker(page, npub);
  await expect(page.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(3_000);
}

/** Accept the (sole) pending invitation on `page` and wait for the group to appear. */
async function acceptInvitation(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await acceptInvitationAndWaitJoined(page, groupName);
}

/** Grant admin to `targetPubkeyHex` from `adminPage` (already on the group detail page). */
async function grantAdminViaUI(adminPage: Page, targetPubkeyHex: string): Promise<void> {
  const shortPk = targetPubkeyHex.slice(0, 8);
  await expect(adminPage.getByTestId(`member-item-${shortPk}`)).toBeVisible({ timeout: 60_000 });
  await expect(adminPage.getByTestId(`member-pending-${shortPk}`)).not.toBeVisible({ timeout: 90_000 });
  const makeAdminBtn = adminPage.getByTestId(`make-admin-${shortPk}`);
  await expect(makeAdminBtn).toBeVisible({ timeout: 30_000 });
  await makeAdminBtn.click();
  const confirmBtn = adminPage.getByTestId(`make-admin-confirm-${shortPk}`);
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
  await expect(confirmBtn).not.toBeVisible({ timeout: 15_000 });
  await adminPage.waitForTimeout(5_000);
}

/** Remove `targetPubkeyHex` via the "Remove Member" affordance on `adminPage`. */
async function removeMemberViaUI(adminPage: Page, targetPubkeyHex: string): Promise<void> {
  const shortPk = targetPubkeyHex.slice(0, 8);
  await adminPage.getByTestId(`remove-member-${shortPk}`).click();
  await expect(adminPage.getByTestId(`remove-member-confirm-${shortPk}`)).toBeVisible({ timeout: 10_000 });
  await adminPage.getByTestId(`remove-member-confirm-${shortPk}`).click();
  await expect(adminPage.getByTestId(`remove-member-confirm-${shortPk}`)).not.toBeVisible({ timeout: 30_000 });
}

test.describe.serial('Remove Member — cross-client eviction, universal removal, and post-removal purge', () => {
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

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('A creates the group and invites B; B joins and is granted admin', async () => {
    await createGroup(pageA, GROUP_NAME);
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_B.npub);
    await acceptInvitation(pageB, GROUP_NAME);
    await openGroupDetail(pageB, GROUP_NAME);

    await openGroupDetail(pageA, GROUP_NAME);
    await grantAdminViaUI(pageA, USER_B.pubkeyHex);

    // B stays on the group detail page from here on — its live subscription
    // (subscribeToGroupMessages) is what makes every later cross-client
    // assertion possible without ever reloading or re-navigating B's page.
    await expect(pageB.getByTestId(`admin-badge-${USER_B.pubkeyHex.slice(0, 8)}`)).toBeVisible({ timeout: 60_000 });
  });

  test('A invites C; C joins as a confirmed regular member', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_C.npub);
    await acceptInvitation(pageC, GROUP_NAME);

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`member-pending-${cPrefix}`)).not.toBeVisible({ timeout: 90_000 });
  });

  test('AC-SCEN-5 / AC-REMOVE-4: A removes confirmed C — absent on BOTH A\'s and B\'s client (no reload)', async () => {
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await removeMemberViaUI(pageA, USER_C.pubkeyHex);

    // Acting admin's own view.
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 15_000 });

    // Second admin's view — B's page was never reloaded/re-navigated; the
    // live MLS commit propagates to B's already-mounted subscription.
    await expect(pageB.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 60_000 });
  });

  test('AC-SCEN-8 / AC-PURGE-5: re-inviting C shows Cancel Invite, not Remove Member — the purge ran', async () => {
    await openGroupDetail(pageA, GROUP_NAME);
    await inviteMember(pageA, USER_C.npub);

    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`cancel-invite-${cPrefix}`)).toBeVisible({ timeout: 10_000 });
    // The load-bearing negative assertion: a failed purge would have left
    // C's OLD confirmed profile behind, making this row look confirmed
    // (Remove Member) immediately instead of pending (Cancel Invite).
    await expect(pageA.getByTestId(`remove-member-${cPrefix}`)).not.toBeVisible();
  });

  test('AC-SCEN-7 / AC-UNIV-1: co-admin B (no local marker for this invite) sees Remove Member on C\'s still-pending row and can evict', async () => {
    const cPrefix = USER_C.pubkeyHex.slice(0, 8);
    // B's own IDB never ran markPendingDirectInvite for THIS re-invite of C
    // (only A's device — the previous test — did). B's live view must still
    // show the row (isPending true, hasMarker false on B's device) and must
    // render "Remove Member", never "Cancel Invite", proving the marker
    // governs the label only, never the removal capability.
    await expect(pageB.getByTestId(`member-item-${cPrefix}`)).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByTestId(`remove-member-${cPrefix}`)).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByTestId(`cancel-invite-${cPrefix}`)).not.toBeVisible();

    await removeMemberViaUI(pageB, USER_C.pubkeyHex);

    await expect(pageB.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 15_000 });
    // Confirm the eviction reaches A's client too.
    await expect(pageA.getByTestId(`member-item-${cPrefix}`)).toHaveCount(0, { timeout: 60_000 });
  });
});
