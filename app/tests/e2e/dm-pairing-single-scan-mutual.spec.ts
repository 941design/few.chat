/**
 * E2E: pairing — single-scan mutual admission (AC-ADMIT-6; also exercises
 * AC-PAIR-2/3, AC-SCAN-1/8, AC-ACK-1, AC-ADMIT-1/5).
 *
 * Epic: contact-pairing-code, story S6. This is the anchor scenario the
 * whole epic exists to prove: A shows ONE code, B opens it ONCE, and BOTH
 * directions of DM work afterward — the "no second scan" outcome AC-ADMIT-6
 * requires. Every action is driven through the real app:
 *   - A's code comes from the real Profile "Share contact card" action
 *     (getShareCardLink — drives the actual Share button, never hand-built).
 *   - B's scan is a real `/add#c=…` navigation (the app's own deep-link
 *     entry point), which — because B already has a name — immediately
 *     drives the app's own real `sendPairingAck` call (no test-side send).
 *   - Both DM directions are asserted by actually typing into `chat-input`
 *     and clicking `chat-send-btn`, then observing the peer's `msg-*`
 *     bubble render — never a lower-level proxy like `isAllowedDmSender`.
 *
 * A never scans B, never displays a second code, and never manually adds B —
 * the only admission path exercised is the pairing-ack's automatic one.
 *
 * SUPERSESSION (2026-07-15, spec.md `## Amendments` — epic:
 * pending-contact-confirmation): that epic deliberately supersedes this
 * spec's "both directions work *immediately*" promise. A contact card is a
 * bearer credential — anyone who obtains a leaked card can pair with the
 * issuer, and under the old auto-admit behavior that pairing succeeded
 * silently and permanently, so a leak was undetectable. Requiring the card
 * ISSUER (A, here) to explicitly confirm an incoming pairing converts an
 * invisible, irreversible admission into a visible, declinable prompt. So A
 * now holds B as a PENDING contact after the pairing-ack, and must confirm B
 * before the chat opens. A pending contact has no openable detail page, so
 * step 4 below drives that confirm as an INLINE action on the contacts-list
 * row (`contact-pending-confirm-<hex>`) before A can send. The "no second
 * scan" guarantee AC-ADMIT-6
 * anchors on is UNCHANGED and still fully proven here — a confirm tap is not
 * a scan, B is never re-scanned, and B (the scanner) is still admitted
 * immediately, unaffected, since scanning is itself an intentional act.
 * Only the "immediately" qualifier on A's side of "both directions work" is
 * superseded, to "both directions work once A confirms".
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-single-scan-mutual.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { waitForAdmission, readKnownPeers } from './helpers/pairing';

test.describe('Pairing: single-scan mutual admission (AC-ADMIT-6)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'A shares one code; B scans it once; both directions of DM work with no second scan',
    async ({ browser }) => {
      // ── 1. A (issuer) shares a real v2 pairing code ─────────────────────
      const a = await bootIdentity(browser, USER_A, 'Alice-Pairing');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      // ── 2. B (scanner), already named, opens the code via the real /add
      // deep-link entry point — this is the ONE scan the whole test performs. ──
      const b = await bootIdentity(browser, USER_B, 'Bob-Pairing');
      await b.page.goto(`/add#c=${payload}`);

      // B's one-directional add completes immediately (existing behavior),
      // and — because B already has a name (AC-SCAN-8, no name-setup detour)
      // — the app immediately attempts the real pairing-ack echo (AC-SCAN-1).
      // The honesty copy (AC-SCAN-4) confirms an echo was attempted, not that
      // A has admitted yet (there is deliberately no ack-of-ack).
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });
      await expect(b.page).toHaveURL(new RegExp(`id=${USER_A.pubkeyHex}&added=1&pairing=`));

      // ── 3. Wait for A to receive + admit B via the pairing-ack, WITHOUT A
      // ever scanning B or performing any add action of its own. ──────────
      await a.page.goto('/contacts');
      const admitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 90_000);
      expect(admitted, 'A must auto-admit B from the pairing-ack alone, with no second scan').toBe(true);

      // ── 4. Direction 1 (pre-existing, sanity check the transport works):
      // A -> B. B added A in step 2, so this direction already worked before
      // this epic; confirming it here rules out a broken relay/pipe before
      // trusting the NEW direction's absence-of-message would be meaningful. ──
      // Epic: pending-contact-confirmation (2026-07-15 supersession) +
      // detail-page-disabled update. A is the card ISSUER — B's pairing-ack
      // admitted B as a PENDING contact on A's side, so A must CONFIRM B before
      // the chat opens. A pending contact has no openable detail page, so the
      // confirm is an inline action on the contacts-list row. This is the new
      // required step; it is not a second scan.
      await a.page.goto('/contacts');
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toBeVisible({ timeout: 20_000 });
      await a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`).click();
      // Confirmed: the inline Confirm control clears (the "Pending" badge was
      // removed by the pending-contact-notification epic — the buttons are the
      // pending-state indicator now).
      await expect(a.page.getByTestId(`contact-pending-confirm-${USER_B.pubkeyHex}`)).toHaveCount(0, { timeout: 15_000 });

      // Now B is a confirmed contact — the detail page opens with the chat.
      await a.page.goto(`/contacts?id=${USER_B.pubkeyHex}`);
      await expect(a.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });

      const fromA = `hello-from-A-${Date.now()}`;
      await a.page.getByTestId('chat-input').fill(fromA);
      await a.page.getByTestId('chat-send-btn').click();
      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: fromA })).toBeVisible({ timeout: 15_000 });

      await b.page.goto(`/contacts?id=${USER_A.pubkeyHex}`);
      await expect(b.page.getByTestId('contact-detail-page')).toBeVisible({ timeout: 15_000 });
      await expect(b.page.locator('[data-testid^="msg-"]').filter({ hasText: fromA })).toBeVisible({ timeout: 20_000 });

      // ── 5. Direction 2 (THE new capability this epic exists to add):
      // B -> A, previously impossible without A performing its own second
      // scan. This is the core AC-ADMIT-6 proof. ──────────────────────────
      //
      // COVERAGE NOTE (fast-follow): A navigated to the B conversation at step 4
      // (page.goto '/contacts?id=B'), which REMOUNTS A's walled-garden watchers
      // and re-reads knownPeers fresh — so this assertion does not exercise the
      // *live* (no-reload) admission-refresh path. That path depends on the
      // pairing-ack callback bumping knownPeersRevision (MarmotContext); a
      // no-navigation variant (A stays on /contacts, asserts the DM notification
      // updates live) would guard that regression directly. Left as a follow-up
      // because it needs a live-relay run to author safely.
      const fromB = `hello-from-B-${Date.now()}`;
      await b.page.getByTestId('chat-input').fill(fromB);
      await b.page.getByTestId('chat-send-btn').click();
      await expect(b.page.locator('[data-testid^="msg-"]').filter({ hasText: fromB })).toBeVisible({ timeout: 15_000 });

      await expect(a.page.locator('[data-testid^="msg-"]').filter({ hasText: fromB })).toBeVisible({ timeout: 20_000 });

      // ── 6. Confirm both sides are mutually admitted (belt-and-braces on
      // top of the DM-delivery proof above). ──────────────────────────────
      const aKnownPeers = await readKnownPeers(a.page);
      expect(aKnownPeers).toContain(USER_B.pubkeyHex.toLowerCase());
    },
  );
});
