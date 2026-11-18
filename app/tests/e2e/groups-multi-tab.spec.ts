import { test, expect } from '@playwright/test';
import { USER_A, computeTestKeypairs } from './helpers/auth-helpers';
import { clearAppState } from './helpers/clear-state';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { createGroup } from './helpers/group-setup';
import { waitForHistoryDispatch, waitForPersistedRumor } from './helpers/session-cutover';

test('a waiting tab lists groups and takes over the real lease without reload', async ({ browser }) => {
  test.setTimeout(180_000);
  await computeTestKeypairs();
  const context = await browser.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3100' });
  try {
    await suppressErrorOverlay(context);
    await context.addInitScript(({ privateKeyHex, pubkeyHex, seedHex }) => {
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify({ privateKeyHex, pubkeyHex, seedHex }));
    }, USER_A);
    const first = await context.newPage();
    await first.goto('/');
    await clearAppState(first);
    await first.reload();
    await first.goto('/groups/');
    const name = `Multi tab ${Date.now()}`;
    await createGroup(first, name);

    const second = await context.newPage();
    await second.goto('/groups/');
    await expect(second.getByTestId('groups-lease-held')).toBeVisible({ timeout: 60_000 });
    await expect(second.getByTestId('groups-lease-held')).toContainText('active in another tab');
    const card = second.locator('[data-testid^="group-card-"]', { has: second.getByText(name, { exact: true }) });
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    const groupId = (await card.getAttribute('data-testid'))?.replace('group-card-', '');
    expect(groupId).toBeTruthy();
    await expect.poll(() => second.evaluate(async () => await (window as any).__fewTest?.marmotSession?.listGroupIds() ?? null),
      { timeout: 30_000 }).toBeNull();
    await second.evaluate(() => { (window as any).__s25PageLifetime = 'same-document'; });
    await first.close();
    await expect(second.getByTestId('groups-lease-held')).toHaveCount(0, { timeout: 90_000 });
    await card.click();
    await expect(second.getByTestId('chat-input')).toBeEnabled({ timeout: 90_000 });
    expect(await second.evaluate(() => (window as any).__s25PageLifetime)).toBe('same-document');
    const message = `lease-handoff-${Date.now()}`;
    const marker = 'multi-tab-sink-rumor';
    await expect.poll(() => second.evaluate(() => !!(window as any).__fewTest?.marmotSession)).toBe(true);
    await second.evaluate(({ groupId, message, marker }) => {
      const hooks = (window as any).__fewTest;
      if (!hooks?.marmotSession) throw new Error('marmotSession test hook unavailable');
      sessionStorage.removeItem(marker);
      hooks.beforeGroupDispatch = (event: { groupId: string; kind: number; content: string; rumorId: string }) => {
        if (event.groupId === groupId && event.kind === 9 && event.content === message) {
          sessionStorage.setItem(marker, event.rumorId);
        }
      };
    }, { groupId, message, marker });
    await second.getByTestId('chat-input').fill(message);
    await second.getByTestId('chat-send-btn').click();
    const rumorId = await waitForPersistedRumor(second, marker);
    await waitForHistoryDispatch(second, USER_A.pubkeyHex, groupId!, rumorId);
    await expect(second.locator('[data-testid^="msg-"]', { hasText: message })).toHaveCount(1, { timeout: 60_000 });
  } finally {
    await context.close();
  }
});
