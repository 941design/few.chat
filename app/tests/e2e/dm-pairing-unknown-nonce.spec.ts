/**
 * E2E: pairing — unknown-nonce echo is silently ignored (AC-PAIR-6, AC-ADMIT-2).
 *
 * Epic: contact-pairing-code, story S6. An echoed pairing-ack that references
 * a nonce the issuer never issued (or one outside its valid+grace set) must
 * produce NO admission on the issuer's side and no visible error — the
 * issuer's `isNonceAdmissible` check is the only gate standing between "any
 * gift-wrapped message claiming to be a pairing-ack" and "peer added to
 * contacts/knownPeers", so a bogus nonce must be a silent no-op, not a crash
 * or a false admission.
 *
 * B never scans A's real code in this test — that would only prove the
 * happy path (already covered by dm-pairing-single-scan-mutual.spec.ts).
 * Instead B's own pending-intent store is seeded directly with a nonce it
 * never legitimately received (the sanctioned direct-IDB-write technique,
 * mirrors dm-self-heal.spec.ts's `seedMalformedRow` precedent — this tampers
 * B's LOCAL state only), then B's real `drainPendingIntents` code signs and
 * gift-wrap-sends a genuine pairing-ack echoing that bogus nonce to A. A's
 * real app receives and evaluates it exactly as it would any inbound ack;
 * the assertion is on A's resulting state, never on a forged/hand-signed
 * event sent directly to the relay.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-unknown-nonce.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink } from './helpers/contact-card';
import { readKnownPeers, readContactPubkeys, seedPendingIntent, dispatchOnlineEvent } from './helpers/pairing';

/** A 32-hex-char (16-byte) nonce B never legitimately received from A. */
function randomNonceHex(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

test.describe('Pairing: unknown-nonce echo is silently ignored (AC-PAIR-6, AC-ADMIT-2)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'A never admits an echo for a nonce it never issued, and surfaces no error',
    async ({ browser }) => {
      // ── 1. A (issuer) has a real, live issued nonce — but not the one B
      // will echo. Driving the real Share action here (rather than skipping
      // it) makes the negative result meaningful: A genuinely has SOME
      // outstanding nonce in its store, just not the bogus one. ──────────
      const a = await bootIdentity(browser, USER_A, 'Alice-Pairing');
      await getShareCardLink(a.page);

      // ── 2. B (scanner), already named, hydrates for real so the app's
      // Layout/PendingPairingIntentWatcher mount and register their `online`
      // listener — required for the retry-drain below to have a live
      // listener. B never scans A's real code in this test. ───────────────
      const b = await bootIdentity(browser, USER_B, 'Bob-Pairing');
      await b.page.goto('/contacts');

      // ── 3. Seed a bogus pending intent directly into B's own store: a
      // nonce A never issued, well within B's own future window so B's app
      // has no reason to consider it expired on its own side. ─────────────
      await seedPendingIntent(b.page, {
        issuerPubkey: USER_A.pubkeyHex,
        nonce: randomNonceHex(),
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      // ── 4. Trigger B's real drain. B already has a name, so the app's
      // real drainPendingIntents (via the already-registered `online`
      // listener) picks up this intent and genuinely signs + gift-wrap-sends
      // a real pairing-ack echoing the bogus nonce to A. ──────────────────
      await dispatchOnlineEvent(b.page);

      // ── 5. Give A's app time to receive and evaluate the bogus ack, then
      // assert A never admitted B — isNonceAdmissible must reject silently. ──
      await a.page.waitForTimeout(15_000);
      const knownPeers = await readKnownPeers(a.page);
      expect(knownPeers).not.toContain(USER_B.pubkeyHex.toLowerCase());
      const contacts = await readContactPubkeys(a.page);
      expect(contacts.map((h) => h.toLowerCase())).not.toContain(USER_B.pubkeyHex.toLowerCase());

      // ── 6. Assert nothing crashed / no error surfaced on A's side.
      // `contacts-page` is the outer wrapper contacts.tsx always renders
      // (it CONTAINS contacts-empty-state/contacts-list depending on
      // content), so asserting it alone is a strict, unambiguous "the page
      // rendered normally" check — `.or()`-ing it with a nested testid
      // trips Playwright's strict-mode violation, since both resolve
      // simultaneously. ─────────────────────────────────────────────────
      await a.page.goto('/contacts');
      await expect(a.page.getByTestId('contacts-page')).toBeVisible({ timeout: 15_000 });
    },
  );
});
