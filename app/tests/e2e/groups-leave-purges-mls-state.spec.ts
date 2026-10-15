/**
 * E2E: leaving a group deletes its MLS state from the leaver's device
 * (bug left-groups-keep-mls-state-forever).
 *
 * Leaving used to purge only the overlay record (few-groups-meta); the group's
 * MLS state (keys, history) stayed in few-groups-state forever and rode along
 * in every relay backup. Now the overlay is purged at once and the MLS state
 * is destroyed (locally, nothing sent) once the kind-9 departure announcement
 * has been sent — the announcement is encrypted with those keys, so the peer
 * must still receive it.
 *
 * Asserts, in order: Bob holds MLS state for the group; Bob leaves; Alice sees
 * "Bob left the group"; Bob's few-groups-state entry and his few-left-groups
 * tombstone are gone.
 *
 * All publishes go through the app (create, invite, accept, leave) — no raw
 * WebSocket relay writes.
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay, dismissErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroupAndInvite } from './helpers/group-setup';
import { readIdbRecord } from './helpers/idb-record';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = `Leave Purges State ${Date.now()}`;

async function bootUser(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
  );
  const page = await context.newPage();
  await page.goto('/');
  await clearAppState(page);
  // Re-seed identity + profile AFTER clearAppState (see e2e profile-seed race).
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex, nick }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
      localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname: nick, avatar: null }));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nick: nickname },
  );
  await page.reload();
  return { context, page };
}

function joinedCards(page: Page, name: string) {
  return page.locator('[data-testid^="group-card-"]', { has: page.getByText(name, { exact: true }) });
}

test.describe.serial('Leaving deletes the group\'s MLS state after the departure is sent', () => {
  test.setTimeout(240_000);
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;
  let groupId = '';

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Alice invites Bob; Bob joins and holds the group\'s MLS state', async () => {
    await createGroupAndInvite(alicePage, USER_B.npub, bobPage, GROUP_NAME);
    const card = joinedCards(bobPage, GROUP_NAME);
    await expect(card).toHaveCount(1);
    const testId = await card.getAttribute('data-testid');
    groupId = (testId ?? '').replace('group-card-', '');
    expect(groupId).toMatch(/^[0-9a-f]{64}$/);

    await expect
      .poll(() => readIdbRecord(bobPage, 'few-groups-state', 'state', groupId), { timeout: 30_000 })
      .not.toBeNull();
  });

  test('Bob leaves; Alice sees the departure announcement; Bob\'s MLS state is gone', async () => {
    // Alice watches the group chat so the announcement renders live.
    await alicePage.goto('/groups/');
    await joinedCards(alicePage, GROUP_NAME).click();
    await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByTestId(`member-item-${USER_B.pubkeyHex.slice(0, 8)}`)).toBeVisible({
      timeout: 60_000,
    });

    await bobPage.goto('/groups/');
    await joinedCards(bobPage, GROUP_NAME).click();
    await expect(bobPage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(bobPage);
    await bobPage.getByTestId('leave-group-btn').click();
    await expect(bobPage.getByTestId('leave-group-confirm-btn')).toBeVisible({ timeout: 10_000 });
    await bobPage.getByTestId('leave-group-confirm-btn').click();
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
    await expect(joinedCards(bobPage, GROUP_NAME)).toHaveCount(0, { timeout: 30_000 });

    // The announcement was encrypted with the keys being deleted: the peer
    // still receives and renders it.
    const announcement = alicePage.getByTestId('leave-chat-announcement');
    await expect(announcement).toBeVisible({ timeout: 60_000 });
    await expect(announcement).toContainText('Bob left the group');

    // Bob's device no longer holds the group's MLS state, and the tombstone
    // that guarded the deferred destroy is cleared.
    await expect
      .poll(() => readIdbRecord(bobPage, 'few-groups-state', 'state', groupId), { timeout: 30_000 })
      .toBeNull();
    await expect
      .poll(() => readIdbRecord(bobPage, 'few-left-groups', 'tombstones', groupId), { timeout: 30_000 })
      .toBeNull();
    expect(await readIdbRecord(bobPage, 'few-groups-meta', 'groups', groupId)).toBeNull();

    // Still gone after a reload (the startup sweep has nothing to resurrect).
    await bobPage.reload();
    await expect(
      bobPage.getByTestId('groups-empty-state').or(bobPage.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
    expect(await readIdbRecord(bobPage, 'few-groups-state', 'state', groupId)).toBeNull();
    await expect(joinedCards(bobPage, GROUP_NAME)).toHaveCount(0);
  });
});
