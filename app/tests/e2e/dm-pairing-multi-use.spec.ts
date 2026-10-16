/**
 * E2E: pairing — multi-use within the active window (AC-PAIR-4; also
 * reprises AC-ADMIT-6's admission outcome for a second, independent
 * scanner).
 *
 * Epic: contact-pairing-code, story S6. Proves the issuer's active nonce is
 * NOT consumed by its first use: A shares ONE code, TWO different scanners
 * (B, then C) each independently scan the SAME still-live code, and A
 * auto-admits BOTH — no re-share, no second code, and B's earlier use has no
 * effect on C's outcome. Every action is driven through the real app:
 *   - A's code comes from the real Profile "Share contact card" action
 *     (getShareCardLink), exactly once.
 *   - B's and C's scans are each a real `/add#c=…` navigation against that
 *     SAME payload — the real deep-link entry point, not a re-derived or
 *     re-fetched code.
 *   - The functional-admission proof (not just a knownPeers entry) is a real
 *     chat-input send from A to C, observed as a `msg-*` bubble on C's page.
 *
 * Both scans happen well within the nonce's 30-minute active window (no
 * expiry simulation needed here — that is dm-pairing-expired-grace.spec.ts's
 * concern).
 *
 * SUPERSESSION (2026-07-15, spec.md `## Amendments` — epic:
 * pending-contact-confirmation): that epic deliberately supersedes this
 * spec's "A auto-admits both [immediately]" framing for A's own DM-sending
 * side. A contact card is a bearer credential — anyone who obtains a leaked
 * card can pair with the issuer, and under the old auto-admit behavior that
 * pairing succeeded silently and permanently, so a leak was undetectable.
 * Requiring the card ISSUER (A) to explicitly confirm each incoming pairing
 * converts an invisible, irreversible admission into a visible, declinable
 * prompt — so A now holds both B and C as PENDING contacts after their
 * respective pairing-acks, and must confirm each before its chat opens. A
 * pending contact has no openable detail page, so step 5 below (the DM sanity
 * check from A to C) drives that confirm as an INLINE action on the contacts-
 * list row (`contact-pending-confirm-<hex>`) before A can send. This spec's
 * actual point — the nonce is
 * multi-use and BOTH B and C get admitted from the SAME code, with no
 * re-share and no second code — is UNCHANGED and still fully proven by
 * `waitForAdmission` succeeding for both in step 4 (which reads
 * `knownPeers`, unaffected by pending-confirmation); only the DM-sending
 * sanity check needed the confirm step inserted ahead of it.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-multi-use.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { waitForAdmission } from './helpers/pairing';

test.describe('Pairing: multi-use within the active window (AC-PAIR-4)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'A shares one code; B and C each scan it independently; A auto-admits both',
    async ({ browser }) => {
      // ── 1. A (issuer) shares a single real v2 pairing code. ─────────────
      const a = await bootIdentity(browser, USER_A, 'Alice-MultiUse');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      // ── 2. B (first scanner), already named, opens the code via the real
      // /add deep-link entry point. ────────────────────────────────────────
      const b = await bootIdentity(browser, USER_B, 'Bob-MultiUse');
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      // ── 3. C (second scanner), already named, opens the SAME still-live
      // code — proving the nonce was not consumed by B's use. ──────────────
      const c = await bootIdentity(browser, USER_C, 'Carol-MultiUse');
      await c.page.goto(`/add#c=${payload}`);
      await expect(c.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      // ── 4. A auto-admits BOTH B and C from the same code, with no re-share
      // and no second code. ─────────────────────────────────────────────────
      const bAdmitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(bAdmitted, 'A must auto-admit B from the first use of the code').toBe(true);
      const cAdmitted = await waitForAdmission(a.page, USER_C.pubkeyHex, 90_000);
      expect(cAdmitted, 'A must ALSO auto-admit C from the SAME (not consumed) code').toBe(true);

      // ── 5. Light DM sanity check: confirm C's admission is functionally
      // real, not just a knownPeers list entry (full bidirectional DM proof
      // is already covered by dm-pairing-single-scan-mutual.spec.ts). ──────
      // Epic: pending-contact-confirmation (2026-07-15 supersession) +
      // detail-page-disabled update. A is the card ISSUER — C's pairing-ack
      // admitted C as a PENDING contact on A's side, so A must CONFIRM C before
      // the chat opens. A pending contact has no openable detail page, so the
      // confirm is an inline action on the contacts-list row. This is the new
      // required step; it is not a second scan.
      await a.page.goto('/contacts');
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_C.pubkeyHex}`)).toBeVisible({ timeout: 20_000 });
      await a.page.getByTestId(`contact-pending-confirm-${USER_C.pubkeyHex}`).click();
      // Confirmed: the inline Confirm control clears (the "Pending" badge was
      // removed by the pending-contact-notification epic — the buttons are the
      // pending-state indicator now).
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_C.pubkeyHex}`)).toHaveCount(0, { timeout: 15_000 });

      // Now C is a confirmed contact — the detail page opens with the chat.
      await a.page.goto(`/contacts?id=${USER_C.pubkeyHex}`);
      await expect(a.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });

      const fromA = `hello-from-A-to-C-${Date.now()}`;
      await a.page.getByTestId('chat-input').fill(fromA);
      await a.page.getByTestId('chat-send-btn').click();
      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: fromA })).toBeVisible({ timeout: 15_000 });

      await c.page.goto(`/contacts?id=${USER_A.pubkeyHex}`);
      await expect(c.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      await expect(c.page.locator('[data-testid^="msg-"]').filter({ hasText: fromA })).toBeVisible({ timeout: 20_000 });
    },
  );
});
