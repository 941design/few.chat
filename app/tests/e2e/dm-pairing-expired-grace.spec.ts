/**
 * E2E: pairing — a nonce aged past the issuer's 2-hour post-expiry grace
 * window produces NO admission (AC-PAIR-5, AC-NONCE-5, AC-NONCE-6,
 * AC-ADMIT-2).
 *
 * Epic: contact-pairing-code, story S6. Proves the issuer-side grace
 * boundary (nonceStore.ts's `isNonceAdmissible`: `nowSec <= storedExpiresAt
 * + NONCE_GRACE_SEC`, NONCE_GRACE_SEC = 2h) is actually enforced, not just
 * documented: a scanner who genuinely, honestly attempts a real echo against
 * a code whose OWN copy still looks live to them nonetheless gets silently
 * declined by the issuer, because the issuer's own persisted record for that
 * nonce has aged out.
 *
 * WHY THIS MECHANISM (read before editing): the card's own signed
 * `expires_at` field cannot be tampered with without invalidating its
 * signature, and the scanner's client-side gate compares the REAL wall clock
 * against that signed field — so there is no way to make a scanner perceive
 * an expired code without waiting ~30 real minutes. This spec instead
 * targets the ISSUER-SIDE persisted nonce record directly via a
 * direct-IDB-write (helpers/pairing.ts#seedIssuerNonce), mirroring
 * dm-self-heal.spec.ts's `seedMalformedRow` precedent of tampering LOCAL
 * STATE only — never a forged or hand-signed relay event. A's card bytes and
 * in-memory active-nonce pointer are untouched; only what A's
 * `isNonceAdmissible` sees when validating an incoming echo for this one
 * nonce value is affected.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-expired-grace.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { extractV2PairingFields, readContactPubkeys, readKnownPeers, seedIssuerNonce } from './helpers/pairing';

/** Post-expiry grace window (nonceStore.ts's NONCE_GRACE_SEC), in seconds. */
const NONCE_GRACE_SEC = 2 * 60 * 60;

test.describe('Pairing: nonce past the 2h grace window admits nobody (AC-PAIR-5 / AC-NONCE-5)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'B echoes a real, still-future-dated card, but A\'s aged-out nonce record silently declines to admit B',
    async ({ browser }) => {
      // ── 1. A (issuer) shares a real v2 pairing code and we learn its real
      // nonce off the card's own bytes (no crypto, no forging). ────────────
      const a = await bootIdentity(browser, USER_A, 'Alice-ExpiredGrace');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);
      const fields = extractV2PairingFields(payload);
      expect(fields, 'A\'s real share card must decode as a v2 pairing card').not.toBeNull();
      const nonceHex = fields!.nonceHex;

      // ── 2. Directly tamper A's OWN persisted nonce-store record for that
      // exact nonce to simulate it having aged well past the 2h grace window
      // (~1h past even the full grace boundary). Does NOT touch the card A
      // already displayed. ──────────────────────────────────────────────────
      await seedIssuerNonce(a.page, {
        nonce: nonceHex,
        expiresAt: Math.floor(Date.now() / 1000) - NONCE_GRACE_SEC - 3600,
      });

      // ── 3. B (scanner), already named, opens the SAME real, unmodified
      // card link. From B's own client-side perspective the card's embedded
      // expires_at is still genuinely in the future, so B's app DOES attempt
      // a real echo — this is expected and correct. ────────────────────────
      const b = await bootIdentity(browser, USER_B, 'Bob-ExpiredGrace');
      await b.page.goto(`/add#c=${payload}`);

      // ── 4. B's own one-directional add of A completes regardless of
      // pairing outcome, with a graceful (non-error) UI — never a raw error. ──
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });
      expect(await readContactPubkeys(b.page)).toContain(USER_A.pubkeyHex);
      await expect(b.page.getByTestId('add-page-error')).toHaveCount(0);

      // ── 5. Wait a reasonable window for A to receive + reject B's echo,
      // then assert A NEVER admitted B — the crux assertion: despite a real,
      // successfully-delivered echo, the issuer's own aged-out nonce record
      // silently declines to admit. ─────────────────────────────────────────
      await a.page.waitForTimeout(15_000);
      const knownPeers = await readKnownPeers(a.page);
      expect(knownPeers, 'A must never admit B via a nonce past its grace window').not.toContain(
        USER_B.pubkeyHex.toLowerCase(),
      );
      const contacts = await readContactPubkeys(a.page);
      expect(
        contacts.map((h) => h.toLowerCase()),
        'B must never appear in A\'s contacts via a nonce past its grace window',
      ).not.toContain(USER_B.pubkeyHex.toLowerCase());
    },
  );
});
