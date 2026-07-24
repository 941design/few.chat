import { test, expect, type Page } from '@playwright/test';
import { USER_A, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity } from './helpers/contact-card';

/**
 * E2E: per-contact unread-message badge on the Contacts list row.
 *
 * The read/unread pipeline (mark-as-read on open, count decrement) already
 * existed and is covered by the DM gift-wrap spec (dm-giftwrap-bell.spec.ts)
 * and the DM detail-view specs. The surface exercised here is presentational:
 * each Contacts list row shows a count badge reading the same live
 * `directMessages` map the nav count pills sum. These tests drive that map
 * through the app's own `__fewUnread` bridge (the same deterministic hook the
 * DM gift-wrap spec uses — no raw relay, no hand-signed events) and assert the
 * row badge reflects it.
 *
 * The group list row renders the identical shared `UnreadCountBadge` reading
 * `counts[group.id]`; that shared component is proven here and by the unit
 * suite + build. Fast (non-relay) bucket: contacts render from localStorage,
 * so no strfry relay is required.
 */

// USER_B is reserved as the maintainer identity in the e2e environment (the
// Contacts list filters maintainer pubkeys out), so use USER_C as the peer.
const PEER = USER_C;

/** Seed a single non-archived, non-pending contact into the Contacts store. */
async function seedContact(page: Page, pubkeyHex: string, nickname: string): Promise<void> {
  await page.evaluate(
    ({ hex, name }) => {
      const raw = localStorage.getItem('lp_contacts_v1');
      const contacts = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      contacts[hex] = { pubkeyHex: hex, nickname: name };
      localStorage.setItem('lp_contacts_v1', JSON.stringify(contacts));
    },
    { hex: pubkeyHex, name: nickname },
  );
}

/** Inject `count` unread direct messages for a peer via the unread-store bridge. */
async function injectDirectMessageCount(page: Page, peerPubkeyHex: string, count: number): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__fewUnread, null, { timeout: 10_000 });
  await page.evaluate(
    ({ peer, n }) => {
      const store = (window as any).__fewUnread;
      for (let i = 0; i < n; i++) store.incrementDirectMessage(peer);
    },
    { peer: peerPubkeyHex, n: count },
  );
}

function contactBadge(page: Page, pubkeyHex: string) {
  return page.getByTestId(`contact-unread-badge-${pubkeyHex}`);
}

test.describe('Contacts list unread badge', () => {
  test.beforeAll(async () => {
    await computeTestKeypairs();
  });

  test('shows the unread count on the contact row and hides it at zero', async ({ browser }) => {
    const { context, page } = await bootIdentity(browser, USER_A, 'Alice');
    await seedContact(page, PEER.pubkeyHex, 'Bob');

    await page.goto('/contacts');
    // Row is present, badge absent while there is nothing unread.
    await expect(page.getByTestId(`contact-card-${PEER.pubkeyHex}`)).toBeVisible();
    await expect(contactBadge(page, PEER.pubkeyHex)).toHaveCount(0);

    // Two unread DMs arrive → the row badge appears reactively with the count.
    await injectDirectMessageCount(page, PEER.pubkeyHex, 2);
    await expect(contactBadge(page, PEER.pubkeyHex)).toBeVisible();
    await expect(contactBadge(page, PEER.pubkeyHex)).toHaveText('2');

    await context.close();
  });

  test('caps the row badge at 99+ for large counts', async ({ browser }) => {
    const { context, page } = await bootIdentity(browser, USER_A, 'Alice');
    await seedContact(page, PEER.pubkeyHex, 'Bob');

    await page.goto('/contacts');
    await expect(page.getByTestId(`contact-card-${PEER.pubkeyHex}`)).toBeVisible();

    await injectDirectMessageCount(page, PEER.pubkeyHex, 150);
    await expect(contactBadge(page, PEER.pubkeyHex)).toHaveText('99+');

    await context.close();
  });
});
