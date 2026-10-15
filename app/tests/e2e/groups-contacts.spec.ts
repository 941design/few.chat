import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { dismissErrorOverlay, suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { inviteContactViaPicker, acceptInvitationAndWaitJoined } from './helpers/group-setup';

// USER_B is configured as the maintainer in the e2e test environment
// (NEXT_PUBLIC_MAINTAINER_NPUBS in run-e2e.mjs). The contacts page filters out
// maintainer pubkeys, so using USER_B as a contact peer would hide them from the
// contacts list. This test uses USER_C as the peer ("Bob") instead.
const USER_B = USER_C;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function bootUserWithProfile(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  user: typeof USER_A,
  nickname: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex, nickname }) => {
    localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    localStorage.setItem('lp_userProfile_v1', JSON.stringify({ nickname, avatar: null }));
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

test.describe.serial('Contacts and direct chat', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: contextA, page: pageA } = await bootUserWithProfile(browser, USER_A, 'Alice'));
    ({ context: contextB, page: pageB } = await bootUserWithProfile(browser, USER_B, 'Bob'));
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('contacts are discovered from shared groups, survive leave, and support direct chat', async () => {
    await pageA.getByTestId('create-group-btn').click();
    await expect(pageA.getByTestId('create-group-modal-content')).toBeVisible();
    await pageA.getByTestId('create-group-name-input').fill('Contacts Test Group');
    await pageA.getByTestId('create-group-submit-btn').click();
    await expect(pageA.getByText('Contacts Test Group')).toBeVisible({ timeout: 30_000 });

    await pageB.waitForTimeout(5_000);

    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Contacts Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await inviteContactViaPicker(pageA, USER_B.npub);
    await expect(pageA.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });

    // AC-TEST-9: Bob sees pending invitation and explicitly Accepts it
    await pageB.goto('/groups/');
    // Wait for the pending invitations section to appear with an invitation row
    await expect(pageB.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 60_000 });
    // Accept the invitation for THIS group (scoped by name, not position) and
    // wait until the joined group-card appears.
    await acceptInvitationAndWaitJoined(pageB, 'Contacts Test Group');
    await pageB.locator('[data-testid^="group-card-"]', { hasText: 'Contacts Test Group' }).click();
    await expect(pageB.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });

    // Wait for Alice's group to show 2 members (confirms Bob's join propagated
    // back to Alice's MarmotContext, which is required before contacts populate).
    await pageA.goto('/groups/');
    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Contacts Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText('2 MEMBERS')).toBeVisible({ timeout: 30_000 });
    // Give Layout.tsx's useEffect time to flush rememberContactsFromGroups into
    // localStorage before we navigate away. The effect fires asynchronously after
    // the DOM paint that made "2 MEMBERS" visible.
    await pageA.waitForTimeout(1_000);
    await dismissErrorOverlay(pageA);
    await dismissErrorOverlay(pageB);

    await pageA.goto('/contacts/');
    await expect(pageA.getByTestId('contacts-list')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toContainText('Bob');

    // Alice is the sole admin — promote Bob to admin before leaving so the
    // sole-admin guard allows the departure.
    await pageA.goto('/groups/');
    await pageA.locator('[data-testid^="group-card-"]', { hasText: 'Contacts Test Group' }).click();
    await expect(pageA.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
    const bobPrefix = USER_B.pubkeyHex.slice(0, 8);
    await pageA.getByTestId(`make-admin-${bobPrefix}`).click();
    await pageA.getByTestId(`make-admin-confirm-${bobPrefix}`).click();
    await expect(pageA.getByTestId(`admin-badge-${bobPrefix}`)).toBeVisible({ timeout: 30_000 });

    await pageA.getByTestId('leave-group-btn').click();
    await pageA.getByTestId('leave-group-confirm-btn').click();
    await expect(pageA.getByTestId('groups-empty-state')).toBeVisible({ timeout: 30_000 });

    await pageA.goto('/contacts/');
    await expect(pageA.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toContainText('Bob');
    // Hiding a contact is driven from the Profile page (the direct-message page
    // no longer carries a hide button). Hide Bob there, then confirm he drops out
    // of the contacts list into the hidden filter.
    await pageA.goto(`/profile/?pubkey=${USER_B.pubkeyHex}`);
    // Epic: block-contact, story S4 (AC-CONFIRM-1/2) — hiding/blocking a
    // contact now requires confirming a destructive-action modal before
    // archiveContact fires.
    await pageA.getByTestId('profile-archive').click();
    await pageA.getByTestId('block-confirm-btn').click();
    await expect(pageA.getByTestId('block-confirm-modal')).not.toBeVisible({ timeout: 15_000 });
    await pageA.goto('/contacts/');
    await expect(pageA.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toHaveCount(0);
    await expect(pageA.getByTestId('contacts-hidden-state')).toContainText('1');
    await pageA.getByTestId('contacts-filter-show-hidden').click();
    await expect(pageA.getByTestId(`contact-card-${USER_B.pubkeyHex}`)).toContainText('Bob');
    // Unhide via the Profile page, then return to Bob's direct-message view.
    await pageA.goto(`/profile/?pubkey=${USER_B.pubkeyHex}`);
    await pageA.getByTestId('profile-archive').click();
    await pageA.goto('/contacts/');
    await pageA.getByTestId(`contact-card-${USER_B.pubkeyHex}`).click();
    await expect(pageA.getByTestId('contact-detail-page')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByRole('heading', { name: 'Bob' })).toBeVisible();

    await pageB.goto('/contacts/');
    await expect(pageB.getByTestId(`contact-card-${USER_A.pubkeyHex}`)).toContainText('Alice');
    await pageB.getByTestId(`contact-card-${USER_A.pubkeyHex}`).click();
    await expect(pageB.getByTestId('contact-detail-page')).toBeVisible({ timeout: 30_000 });

    await pageA.getByTestId('chat-input').fill('Hi Bob, from contacts');
    await pageA.getByTestId('chat-send-btn').click();
    // A single send MUST render exactly one bubble on the recipient. The prior
    // `.first()` masked a duplication bug (multiple distinct msg-<rumorId> ids per
    // send). Assert the real invariant so any regression to duplication fails here.
    const bobBubble = pageB.locator('[data-testid^="msg-"]', { hasText: 'Hi Bob, from contacts' });
    await expect(bobBubble.first()).toBeVisible({ timeout: 60_000 });
    await expect(bobBubble).toHaveCount(1);
  });
});
