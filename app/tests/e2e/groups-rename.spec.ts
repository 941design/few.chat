// E2E: Group rename (admin-only)
//
// Covers the "As a group admin, I want to rename groups" feature:
//   AC-RENAME-1  non-admin member does NOT see the rename affordance
//   AC-RENAME-2  admin renames via the inline pencil UI; A's header + list card update
//   AC-RENAME-3  the new name propagates to the other member (B's header + list card)
//   AC-RENAME-4  an in-chat "renamed the group to …" notice appears for the member
//
// Rule (project e2e gate): all actions are driven through the app UI across two
// browser contexts. The rename commit + notice are published by the app, never
// hand-signed to the relay. The only raw-relay access is KeyPackage polling.

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { queryRelayForEvents } from './helpers/relay-query';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

const ORIGINAL_NAME = 'Rename Test Original';
const RENAMED_NAME = 'Rename Test Renamed';

// ---------------------------------------------------------------------------
// Shared helpers (mirrored from groups-admin.spec.ts for stability)
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
      if (!localStorage.getItem('lp_userProfile_v1')) {
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

async function waitForKeyPackages(page: Page, pubkeyHex: string): Promise<void> {
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

async function inviteMember(page: Page, npub: string): Promise<void> {
  await inviteContactViaPicker(page, npub);
  await expect(page.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3_000);
}

async function waitForGroupAndOpen(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await acceptInvitationAndWaitJoined(page, groupName);
  await openGroupDetail(page, groupName);
}

// ---------------------------------------------------------------------------

test.describe.serial('Group rename – admin renames, member sees the new name + notice', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pageA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pageB } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A creates a group; B publishes KeyPackages; A invites B; B joins as non-admin', async () => {
    await createGroup(pageA, ORIGINAL_NAME);
    await waitForKeyPackages(pageB, USER_B.pubkeyHex);
    await openGroupDetail(pageA, ORIGINAL_NAME);
    await inviteMember(pageA, USER_B.npub);
    await waitForGroupAndOpen(pageB, ORIGINAL_NAME);
  });

  test('AC-RENAME-1: non-admin B does NOT see the rename affordance', async () => {
    // B is a plain member — the pencil is admin-gated and must be absent.
    await expect(pageB.getByTestId('rename-group-btn')).not.toBeVisible();
  });

  test('AC-RENAME-2: admin A renames the group via the inline pencil', async () => {
    await openGroupDetail(pageA, ORIGINAL_NAME);
    // A is the creator/admin → pencil visible.
    const pencil = pageA.getByTestId('rename-group-btn');
    await expect(pencil).toBeVisible({ timeout: 30_000 });
    await pencil.click();

    const input = pageA.getByTestId('rename-group-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(RENAMED_NAME);
    await pageA.getByTestId('rename-group-save').click();

    // The editor closes and A's header reflects the new name.
    await expect(pageA.getByTestId('rename-group-input')).not.toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.getByTestId('group-detail-page').getByRole('heading', { name: RENAMED_NAME }),
    ).toBeVisible({ timeout: 15_000 });
    // Allow the metadata commit + kind-9 notice to propagate through the relay.
    await pageA.waitForTimeout(5_000);
  });

  test('AC-RENAME-2: the new name appears on A’s group list card', async () => {
    await pageA.goto('/groups/');
    await expect(pageA.getByTestId('groups-list')).toBeVisible({ timeout: 60_000 });
    await expect(pageA.getByText(RENAMED_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText(ORIGINAL_NAME)).not.toBeVisible();
  });

  test('AC-RENAME-3: the rename propagates to B’s group list card', async () => {
    // B's background subscription (running app-wide in MarmotProvider) resyncs
    // Group.name from the authoritative MLS metadata on the received commit, then
    // reloadGroups() re-renders the list card in place — no reload needed. Wait on
    // the live-updating card with a generous timeout (mirrors the admin test's
    // wait for the invite button to enable after a metadata commit propagates).
    await pageB.goto('/groups/');
    await expect(pageB.getByTestId('groups-list')).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText(RENAMED_NAME)).toBeVisible({ timeout: 120_000 });
    await expect(pageB.getByText(ORIGINAL_NAME)).not.toBeVisible({ timeout: 15_000 });
  });

  test('AC-RENAME-3 & AC-RENAME-4: B’s header shows the new name and the chat shows the rename notice', async () => {
    await openGroupDetail(pageB, RENAMED_NAME);
    // Header updated for B.
    await expect(
      pageB.getByTestId('group-detail-page').getByRole('heading', { name: RENAMED_NAME }),
    ).toBeVisible({ timeout: 30_000 });
    // In-chat notice rendered; it carries the new name in its text.
    const notice = pageB.getByTestId('group-renamed-announcement');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText(RENAMED_NAME);
  });
});
