/**
 * E2E: re-adding an already-existing contact via a contact-card link lands on
 * that contact's DM page — exactly like a fresh add, never a dead-end error.
 *
 * Before this change, opening a contact-card link for someone already in your
 * contacts dead-ended on the `/add` page's "This person is already in your
 * contacts" error alert. Now `/add` navigates a returning scanner straight to
 * that contact's DM page (`/contacts?id=<pubkey>&exists=1`), the same
 * destination a fresh add reaches. The one product difference: a re-add is
 * marked `&exists=1` (never `&added=1`, since nothing was newly added), which
 * surfaces the informative "already in your contacts" banner over the DM
 * instead of the green "Contact added" confirmation.
 *
 * Driven end to end through the real app: A's code via the real Profile "Share
 * contact card" action, B's add + re-add via real `/add#c=…` navigations, and
 * B's reciprocation echo through the real relay — never a hand-built event.
 *
 * NAMED scanner (B is booted WITH a nickname): a named scanner's pairing echo
 * does NOT short-circuit — it connects to the relay and publishes — so this
 * spec needs the strfry relay harness and therefore lives in the relay bucket
 * (its `dm-` filename places it there; see playwright.config.ts's testMatch).
 * That is the whole reason it is not a sibling of the non-relay
 * contact-card-deeplink.spec.ts: the fast bucket cannot exercise the
 * named-scanner path cleanly.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-readd-lands-on-dm.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { readContactPubkeys } from './helpers/pairing';

test.describe('Re-add of an existing contact lands on the DM page (not a dead-end error)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test('a NAMED scanner opening the same card twice lands on the contact DM both times — with the "Contact added" banner on the first add and the informative "already in your contacts" banner on the re-add', async ({ browser }) => {
    // ── 1. A (issuer) shares a real v2 pairing card. ──────────────────────
    const a = await bootIdentity(browser, USER_A, 'Alice-ReAdd');
    const cardLink = await getShareCardLink(a.page);
    const payload = extractCardPayload(cardLink);

    // ── 2. B is booted WITH a name, so the pairing echo is NOT deferred to
    // name setup (AC-SCAN-5's nameless detour) — a named scanner echoes
    // immediately and lands directly on the contact. ─────────────────────
    const b = await bootIdentity(browser, USER_B, 'Bob-ReAdd');

    // ── 3. First add: a fresh one-directional add of A. Lands on A's DM page
    // WITH the green "Contact added" confirmation (`added=1`). ────────────
    await b.page.goto(`/add#c=${payload}`);
    await expect(b.page).toHaveURL(new RegExp(`id=${USER_A.pubkeyHex}`), { timeout: 20_000 });
    await expect(b.page).toHaveURL(/added=1/);
    await expect(b.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByTestId('contact-added-success')).toBeVisible();
    await expect.poll(() => readContactPubkeys(b.page), { timeout: 20_000 }).toContain(USER_A.pubkeyHex);

    // ── 4. Re-add: open the SAME card link again for the now-existing
    // contact. It must NOT dead-end on the /add error alert — it navigates to
    // A's DM page just like the fresh add. ───────────────────────────────
    await b.page.goto(`/add#c=${payload}`);
    // Never surfaces the already-exists error alert on the /add page.
    await expect(b.page.getByTestId('add-page-error')).toHaveCount(0);
    // Lands on A's DM page, marked as a re-add (`exists=1`, not `added=1`)…
    await expect(b.page).toHaveURL(new RegExp(`id=${USER_A.pubkeyHex}`), { timeout: 20_000 });
    await expect(b.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
    await expect(b.page).not.toHaveURL(/added=1/);
    // …showing the informative "already in your contacts" banner (NOT the
    // green "Contact added" confirmation).
    await expect(b.page.getByTestId('contact-already-exists-info')).toBeVisible();
    await expect(b.page.getByTestId('contact-added-success')).toHaveCount(0);
  });
});
