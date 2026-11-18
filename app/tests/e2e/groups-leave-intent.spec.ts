// E2E: Out-of-band group leave flow (kind-13 leave intent + admin auto-remove).
//
// AC-MEMBERS-1: When the auto-remove commit from S5 succeeds, the onMembersChanged
//   callback fires and the member list drops the departed member.
// AC-MEMBERS-2: Full two-client scenario:
//   1. USER_A creates a group and invites USER_B.
//   2. USER_B joins the group (accepts the MLS Welcome).
//   3. USER_B clicks "Leave Group" and confirms.
//   4. Within ~5 seconds, USER_A's client auto-commits the removal.
//   5. USER_B's name disappears from USER_A's member list.
//   6. USER_A can still send a chat message (group not blocked).
// AC-EDGE-7: Admin-only no-op — verified by code inspection (architecture.json).
//   This test covers the canonical case (USER_A is admin, USER_B is non-admin).

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { queryRelayForEvents } from './helpers/relay-query';
import { waitForLibraryGroupAbsent } from './helpers/session-cutover';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_NAME = 'Leave Intent E2E';

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
  // Re-seed identity + profile AFTER clearAppState, before reload. The
  // addInitScript above seeds the profile only `if (!lp_userProfile_v1)`, which
  // races with ProfileContext's hydrate-and-persist: if the first page's
  // ProfileContext effect runs after clearAppState wiped the profile, it
  // persists an empty-nickname default ({nickname:'', avatar:<random>}) that
  // then survives the reload guard. Bob then leaves as a nameless user and the
  // leave announcement reads " left the group" (measured: 2 of 4 runs booted
  // with nickname "" and exactly those failed AC-MEMBERS-2's name assertion).
  // Same fix as groups-poll-after-leave.spec.ts's bootUserWithProfile.
  await page.evaluate(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
  }, { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex, nickname });
  await page.reload();
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

/** Wait for a KeyPackage (kind 443 or 30443) to appear on the relay. */
async function waitForKeyPackage(page: Page, pubkeyHex: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const events = await queryRelayForEvents(page, {
          kinds: [443, 30443],
          authors: [pubkeyHex],
          limit: 1,
        });
        return events.length;
      },
      { timeout: 60_000, intervals: [3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] },
    )
    .toBeGreaterThanOrEqual(1);
}

/** Navigate to the group detail page. Handles both group-card and nav from /groups/. */
async function openGroupDetail(page: Page, groupName: string): Promise<void> {
  await page.goto('/groups/');
  await expect(
    page.getByTestId('groups-empty-state').or(page.getByTestId('groups-list')),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 60_000 });
  await page.locator(`[data-testid^="group-card-"]`, { hasText: groupName }).click();
  await expect(page.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  await dismissErrorOverlay(page);
}

test.describe.serial('Out-of-band group leave (kind-13 leave intent)', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pgA: Page;
  let pgB: Page;
  let groupId: string;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: ctxA, page: pgA } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: ctxB, page: pgB } = await bootUser(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  // Step 1: USER_A creates a group.
  test('USER_A creates a group', async () => {
    await pgA.getByTestId('create-group-btn').click();
    await expect(pgA.getByTestId('create-group-modal-content')).toBeVisible();
    await pgA.getByTestId('create-group-name-input').fill(GROUP_NAME);
    await pgA.getByTestId('create-group-submit-btn').click();
    await expect(pgA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(pgA.getByTestId('create-group-modal-content')).not.toBeVisible({ timeout: 10_000 });
    await dismissErrorOverlay(pgA);
    // Allow the MLS group to initialise and publish KeyPackages before continuing.
    await pgA.waitForTimeout(3_000);
  });

  // USER_B must publish a KeyPackage so USER_A can invite them.
  test('USER_B publishes a KeyPackage', async () => {
    await waitForKeyPackage(pgB, USER_B.pubkeyHex);
  });

  // Step 2: USER_A opens the group and invites USER_B by npub.
  test('USER_A opens the group and invites USER_B by npub', async () => {
    await openGroupDetail(pgA, GROUP_NAME);

    await inviteContactViaPicker(pgA, USER_B.npub);
    await expect(pgA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
    await pgA.keyboard.press('Escape');
    // Wait for the MLS commit to propagate to the relay.
    await pgA.waitForTimeout(3_000);
  });

  // USER_B joins by navigating to /groups/ and clicking the Welcome group card.
  // MarmotContext's Welcome subscription processes the MLS Welcome message and
  // calls reloadGroups(), making the group appear in USER_B's list.
  test('USER_B joins the group via Welcome', async () => {
    // Walled Garden v2 pull-only flow: the Welcome arrives as a pending
    // invitation; USER_B must explicitly accept before the group appears.
    await pgB.waitForTimeout(5_000);
    await pgB.goto('/groups/');
    await expect(pgB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    await expect(pgB.locator('[data-testid^="pending-invitation-row-"]').last()).toBeVisible({ timeout: 60_000 });
    await acceptInvitationAndWaitJoined(pgB, GROUP_NAME);

    // Open the group — this triggers the full MLS subscription and sync.
    await pgB.locator(`[data-testid^="group-card-"]`, { hasText: GROUP_NAME }).click();
    await expect(pgB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await dismissErrorOverlay(pgB);

    groupId = new URL(pgB.url()).searchParams.get('id')!;
    expect(groupId).toBeTruthy();
    // Confirm USER_B can see themselves in the member list (proves join succeeded).
    const bPkPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgB.getByTestId(`member-item-${bPkPrefix}`)).toBeVisible({ timeout: 30_000 });
  });

  // Confirm USER_A also sees USER_B in the member list before the leave.
  test('USER_A sees USER_B in the member list before the leave', async () => {
    await openGroupDetail(pgA, GROUP_NAME);
    const bPkPrefix = USER_B.pubkeyHex.slice(0, 8);
    await expect(pgA.getByTestId(`member-item-${bPkPrefix}`)).toBeVisible({ timeout: 30_000 });
    // Wait until Bob's profile has propagated to Alice (plain retrying assertion
    // on the live-updating member card, no reload polling). The leave-chat row
    // falls back to a truncated npub for a leaver whose name is unknown, so the
    // name assertion in AC-MEMBERS-2 below is only meaningful once Alice knows it.
    await expect(pgA.getByTestId(`member-item-${bPkPrefix}`)).toContainText('Bob', { timeout: 60_000 });
  });

  test('failed and interrupted leaves restore the group without a durable leaving marker (AC-LEAVE-3)', async () => {
    test.setTimeout(180_000);
    await pgB.evaluate((id) => {
      const hooks = (window as any).__fewTest;
      if (!hooks?.marmotSession) throw new Error('marmotSession test hook unavailable');
      hooks.beforeGroupLeave = (groupId: string) => {
        if (groupId === id) throw new Error('injected leave failure');
      };
    }, groupId);
    await pgB.getByTestId('leave-group-btn').click();
    await pgB.getByTestId('leave-group-confirm-btn').click();
    await expect(pgB.getByText('Leaving the group did not work. The group is back in your list; please try again.'))
      .toBeVisible({ timeout: 30_000 });
    const card = pgB.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME });
    await expect(card).toHaveCount(1, { timeout: 30_000 });

    await card.click();
    await expect(pgB.getByTestId('group-detail-page')).toBeVisible();
    await pgB.evaluate((id) => {
      const hooks = (window as any).__fewTest;
      sessionStorage.removeItem('s25-leave-paused');
      hooks.beforeGroupLeave = async (groupId: string) => {
        if (groupId !== id) return;
        sessionStorage.setItem('s25-leave-paused', groupId);
        await new Promise<void>(() => {});
      };
    }, groupId);
    await pgB.getByTestId('leave-group-btn').click();
    await pgB.getByTestId('leave-group-confirm-btn').click();
    await expect.poll(() => pgB.evaluate(() => sessionStorage.getItem('s25-leave-paused')),
      { timeout: 15_000 }).toBe(groupId);
    await expect(pgB.getByTestId('groups-empty-state').or(pgB.getByTestId('groups-list')))
      .toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveCount(0);
    await pgB.reload();
    await expect(pgB.getByTestId('groups-empty-state').or(pgB.getByTestId('groups-list')))
      .toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => pgB.evaluate(async (id) => {
      const ids = await (window as any).__fewTest?.marmotSession?.listGroupIds();
      return ids?.includes(id) === true;
    }, groupId), { timeout: 60_000 }).toBe(true);

    const markers = await pgB.evaluate(async () => {
      const found: string[] = [];
      const inspect = (value: unknown, path: string, seen = new WeakSet<object>()) => {
        if (typeof value === 'string') {
          if (/^leaving$/i.test(value)) found.push(path);
          return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (/leaving/i.test(key)) found.push(`${path}.${key}`);
          inspect(child, `${path}.${key}`, seen);
        }
      };
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (/leaving/i.test(key)) found.push(`localStorage:${key}`);
        const value = localStorage.getItem(key)!;
        try { inspect(JSON.parse(value), `localStorage:${key}`); } catch { inspect(value, `localStorage:${key}`); }
      }
      for (const { name } of await indexedDB.databases()) {
        if (!name) continue;
        if (/leaving/i.test(name)) found.push(`indexedDB:${name}`);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          for (const storeName of Array.from(db.objectStoreNames)) {
            if (/leaving/i.test(storeName)) found.push(`indexedDB:${name}/${storeName}`);
            await new Promise<void>((resolve, reject) => {
              const request = db.transaction(storeName).objectStore(storeName).openCursor();
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { resolve(); return; }
                const path = `indexedDB:${name}/${storeName}`;
                if (/leaving/i.test(JSON.stringify(cursor.key))) found.push(`${path}:key`);
                inspect(cursor.value, path);
                cursor.continue();
              };
            });
          }
        } finally { db.close(); }
      }
      return found;
    });
    expect(markers).toEqual([]);
    await card.click();
    await expect(pgB.getByTestId('group-detail-page')).toBeVisible();
  });

  // Step 3: USER_B clicks "Leave Group" and confirms.
  // This triggers MarmotContext.leaveGroup:
  //   1. Sends kind-13 leave-intent (encrypted application rumor)
  //   2. Sends kind-9 leave announcement (unencrypted, for chat history)
  //   3. Purges local MLS + IDB state
  //   4. Navigates to /groups/
  test('USER_B clicks Leave Group and confirms', async () => {
    await pgB.getByTestId('leave-group-btn').click();
    // Confirm modal appears.
    await expect(pgB.getByTestId('leave-group-confirm-btn')).toBeVisible({ timeout: 10_000 });
    await pgB.getByTestId('leave-group-confirm-btn').click();
    await waitForLibraryGroupAbsent(pgB, groupId);
    await expect(pgB.locator('[data-testid^="group-card-"]', { hasText: GROUP_NAME })).toHaveCount(0);
    // After confirmation, leaveGroup() runs and router.push('/groups') fires.
    // Wait for USER_B to land back on the groups list — proves leaveGroup() completed.
    await expect(
      pgB.getByTestId('groups-empty-state').or(pgB.getByTestId('groups-list')),
    ).toBeVisible({ timeout: 30_000 });
  });

  // Step 4 + 5: Within ~5 seconds (S5's debounce), USER_A's client receives
  // the kind-13 leave intent, enqueues the removal, and fires the auto-commit.
  // The onMembersChanged callback then calls reloadGroups() when the member
  // count drops, removing USER_B from USER_A's member list.
  //
  // AC-MEMBERS-2 assertion: USER_B's member-item disappears from USER_A's view.
  test('USER_B disappears from USER_A member list after auto-remove commit (AC-MEMBERS-2)', async () => {
    const bPkPrefix = USER_B.pubkeyHex.slice(0, 8);
    // USER_A must be on the group detail page (already navigated in prior test).
    // poll with a 15-second timeout: debounce is 5s + relay propagation + commit round-trip.
    await expect
      .poll(
        async () => {
          const count = await pgA.getByTestId(`member-item-${bPkPrefix}`).count();
          return count;
        },
        { timeout: 30_000, intervals: [3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000] },
      )
      .toBe(0);
  });

  // AC-MEMBERS-2 (final step): Leave-chat announcement appears in USER_A's chat.
  // The kind-9 rumor USER_B sent is displayed as a LeaveChatAnnouncement row.
  // It must name the departed member ("Bob left the group") — never an npub.
  test('Leave-chat announcement names the departed member in USER_A chat (AC-MEMBERS-2)', async () => {
    const announcement = pgA.getByTestId('leave-chat-announcement').first();
    await expect(announcement).toBeVisible({ timeout: 15_000 });
    await expect(announcement).toContainText('Bob left the group');
    // The leaver's name, not their identifier: no npub must leak into the row.
    await expect(announcement).not.toContainText('npub1');
  });

  // Step 6 / AC-MEMBERS-2: USER_A can still send a chat message after the removal.
  // This proves the auto-remove commit did not block or corrupt the MLS group state.
  test('USER_A can send a chat message after removal (group not blocked, AC-MEMBERS-2)', async () => {
    const msg = 'group-usable-after-leave';
    await expect(pgA.getByTestId('chat-input')).toBeVisible({ timeout: 10_000 });
    await pgA.getByTestId('chat-input').fill(msg);
    await pgA.getByTestId('chat-send-btn').click();
    await expect(
      pgA.locator('[data-testid^="msg-"]').filter({ hasText: msg }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
