/** Invitation previews use authenticated sponsor context and reveal no private group details. */
import { test, expect, BrowserContext, Page } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup, inviteContactViaPicker } from './helpers/group-setup';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const GROUP_ACCEPT = `Preview Accept ${Date.now()}`;
const GROUP_DECLINE = `Preview Decline ${Date.now()}`;
const PRIVATE_DESCRIPTION = `Members only ${Date.now()}`;

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

async function aliceCreatesGroupAndInvites(alicePage: Page, groupName: string, description?: string): Promise<void> {
  // Ensure Alice is on the groups LIST view — a prior invocation leaves her on
  // the group detail page (the invite flow navigates into the group), where
  // create-group-btn does not exist.
  await alicePage.goto('/groups/');
  await createGroup(alicePage, groupName);
  await alicePage.waitForTimeout(3_000);

  await alicePage.locator('[data-testid^="group-card-"]', { hasText: groupName }).click();
  await expect(alicePage.getByTestId('group-detail-page')).toBeVisible({ timeout: 30_000 });
  if (description !== undefined) {
    const groupId = new URL(alicePage.url()).searchParams.get('id');
    if (!groupId) throw new Error('Group detail route has no id');
    const applied = await alicePage.evaluate(async ({ groupId, description }) => {
      const hooks = (window as unknown as { __fewTest?: { marmotSession?: {
        setGroupDescription(groupId: string, description: string): Promise<string>;
      } } }).__fewTest;
      if (!hooks?.marmotSession) throw new Error('marmotSession test hook unavailable');
      return hooks.marmotSession.setGroupDescription(groupId, description);
    }, { groupId, description });
    expect(applied).toBe(description);
  }
  await inviteContactViaPicker(alicePage, USER_B.npub);
  await expect(alicePage.getByTestId('invite-success')).toBeVisible({ timeout: 60_000 });
  await alicePage.waitForTimeout(3_000);
}

test.describe.serial('Invitation preview (AC-CTX-2, AC-CTX-5)', () => {
  let carolCtx: BrowserContext;
  let carolPage: Page;
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alicePage: Page;
  let bobPage: Page;

  test.beforeAll(async ({ browser }) => {
    await computeTestKeypairs();
    ({ context: aliceCtx, page: alicePage } = await bootUser(browser, USER_A, 'Alice'));
    ({ context: bobCtx, page: bobPage } = await bootUser(browser, USER_B, 'Bob'));
    carolCtx = await browser.newContext({ baseURL: BASE_URL });
    await suppressErrorOverlay(carolCtx);
    carolPage = await carolCtx.newPage();
    await carolPage.goto('/groups/');
    await expect(carolPage.getByTestId('groups-empty-state')).toBeVisible({ timeout: 60_000 });
    await expect(carolPage.locator('[data-testid^="invitation-card-"]')).toHaveCount(0);
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
    await carolCtx?.close();
  });

  test('Bob taps the invitation card, previews group details, and Accepts', async () => {
    await aliceCreatesGroupAndInvites(alicePage, GROUP_ACCEPT, PRIVATE_DESCRIPTION);

    // Bob waits for the Welcome to arrive over the relay, then opens the list.
    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');
    await expect(bobPage.getByTestId('pending-invitations-section')).toBeVisible({ timeout: 90_000 });
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_ACCEPT }).last();
    await expect(invitationCard).toBeVisible({ timeout: 30_000 });

    // AC-CARD-4 / AC-PREVIEW-1: tapping the card body opens the read-only
    // preview route. Click the group name (card body, not the Accept/Decline
    // buttons which are elevated above the link overlay).
    await invitationCard.getByText(GROUP_ACCEPT).click();
    await expect(bobPage).toHaveURL(/invite=/, { timeout: 15_000 });

    // AC-PREVIEW-1: the preview shows the group name, "Invited by" attribution,
    // and no admin list or description before joining.
    const preview = bobPage.getByTestId('invitation-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId('invitation-preview-name')).toHaveText(GROUP_ACCEPT);
    const sponsor = `${USER_A.pubkeyHex.slice(0, 8)}…${USER_A.pubkeyHex.slice(-8)}`;
    await expect(bobPage.getByTestId('invitation-preview-invited-by')).toHaveText(`Invited by ${sponsor}`);
    await expect(bobPage.getByTestId('invitation-preview-admins')).toHaveCount(0);
    await expect(bobPage.getByTestId('invitation-preview-description')).toHaveCount(0);
    await expect(preview.getByText(/admins|description/i)).toHaveCount(0);
    await expect(bobPage.getByText(PRIVATE_DESCRIPTION, { exact: true })).toHaveCount(0);
    await expect(carolPage.locator('[data-testid^="invitation-card-"]')).toHaveCount(0);
    await expect(carolPage.getByText(GROUP_ACCEPT, { exact: true })).toHaveCount(0);

    // AC-PREVIEW-2: Accept from the preview joins the group and returns Bob to
    // the list, where the group now appears as a joined group-card.
    await bobPage.getByTestId('invitation-preview-accept').click();
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_ACCEPT }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(bobPage.getByTestId('invitation-preview')).toHaveCount(0);
  });

  test('Bob previews another invitation and Declines from the preview', async () => {
    await aliceCreatesGroupAndInvites(alicePage, GROUP_DECLINE);

    await bobPage.waitForTimeout(5_000);
    await bobPage.goto('/groups/');
    const invitationCard = bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_DECLINE }).last();
    await expect(invitationCard).toBeVisible({ timeout: 90_000 });

    await invitationCard.getByText(GROUP_DECLINE).click();
    await expect(bobPage).toHaveURL(/invite=/, { timeout: 15_000 });
    await expect(bobPage.getByTestId('invitation-preview')).toBeVisible({ timeout: 30_000 });
    await expect(bobPage.getByTestId('invitation-preview-name')).toHaveText(GROUP_DECLINE);

    // AC-PREVIEW-2: Decline from the preview discards the invitation and returns
    // Bob to the list; the group is never joined.
    await bobPage.getByTestId('invitation-preview-decline').click();
    await expect(bobPage.getByTestId('invitation-preview')).toHaveCount(0, { timeout: 15_000 });
    await expect(
      bobPage.locator('[data-testid^="invitation-card-"]', { hasText: GROUP_DECLINE }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(
      bobPage.locator('[data-testid^="group-card-"]', { hasText: GROUP_DECLINE }),
    ).toHaveCount(0);
  });

  test('without stored sponsor context the preview uses the generic invitation label', async () => {
    const name = `No context ${Date.now()}`;
    await aliceCreatesGroupAndInvites(alicePage, name);
    await bobPage.goto('/groups/');
    const card = bobPage.locator('[data-testid^="invitation-card-"]', { hasText: name }).last();
    await expect(card).toBeVisible({ timeout: 90_000 });
    const cardId = await card.getAttribute('data-testid');
    if (!cardId) throw new Error('invitation card has no id');
    // The real invitation has arrived; simulate a lost context by deleting only
    // its holding-store snapshot, leaving the library's pending invitation intact.
    await bobPage.evaluate(async (account) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('few-invite-contexts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('contexts', 'readwrite');
        tx.objectStore('contexts').delete(account);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, USER_B.pubkeyHex.toLowerCase());
    await bobPage.reload();
    const generic = bobPage.getByTestId(cardId);
    await expect(generic.getByText('Group invitation', { exact: true })).toBeVisible({ timeout: 60_000 });
    await generic.getByText('Group invitation', { exact: true }).click();
    await expect(bobPage.getByTestId('invitation-preview-name')).toHaveText('Group invitation');
    await expect(bobPage.getByTestId('invitation-preview-admins')).toHaveCount(0);
    await expect(bobPage.getByTestId('invitation-preview-description')).toHaveCount(0);
    await bobPage.getByTestId('invitation-preview-decline').click();
    await expect(bobPage.getByTestId('invitation-preview')).toHaveCount(0);
  });

});
