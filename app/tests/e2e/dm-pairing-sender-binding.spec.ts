/**
 * E2E: pairing — sender binding rejects a harvested third-party card
 * (AC-SEC-1, AC-PAIR-6b; security-critical).
 *
 * Epic: contact-pairing-code, story S6. Proves: a pairing-ack gift wrap
 * whose enclosed `card` names a DIFFERENT pubkey than the gift wrap's own
 * authenticated (real, validly-signed) sender admits NOBODY — not the named
 * card's pubkey, and not the authenticated sender's pubkey either.
 *
 * EXCEPTION NOTICE (read before editing): step 4 below uses
 * helpers/forgedPairingAck.ts#sendForgedPairingAck — the ONE place in this
 * story's specs that constructs a signed event outside the app's own UI.
 * This is the narrow, CLAUDE.md-sanctioned exception ("events the app
 * cannot itself produce"): pairingAck.ts#sendPairingAck's real send path
 * ALWAYS encloses the caller's OWN card, so there is no UI action that can
 * make a real user's app send someone else's card — the exact input AC-SEC-1
 * defends against is structurally unreachable through normal use. See that
 * helper's file header for the full justification, including why the gift
 * wrap's AUTHENTICATED sender (the attacker's real key/signature) is never
 * spoofed — only the enclosed card's claimed identity is. Every OTHER action
 * in this spec (A's and B's real cards, B's real legitimate scan in the
 * positive-control step) is driven through the app exactly like every other
 * spec in this story.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-sender-binding.spec.ts
 */
import { test, expect } from '@playwright/test';
import { USER_A, USER_B, USER_C, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { extractV2PairingFields, readKnownPeers, readContactPubkeys, waitForAdmission } from './helpers/pairing';
import { sendForgedPairingAck } from './helpers/forgedPairingAck';

test.describe('Pairing: sender binding rejects a harvested third-party card (AC-SEC-1 / AC-PAIR-6b)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'an ack authenticated as C but enclosing B\'s genuine card admits NEITHER B NOR C; a subsequent real scan by B still works',
    async ({ browser }) => {
      // ── 1. A (victim/issuer) shares a real, live v2 pairing code. ────────
      const a = await bootIdentity(browser, USER_A, 'Alice-SenderBinding');
      const aCardLink = await getShareCardLink(a.page);
      const aPayload = extractCardPayload(aCardLink);
      const aFields = extractV2PairingFields(aPayload);
      expect(aFields, 'A\'s real share card must decode as a v2 pairing card').not.toBeNull();
      const issuedNonceHex = aFields!.nonceHex;

      // ── 2. B (an unrelated real user) produces their OWN genuine, validly
      // -signed card via the app's real Share action. This is the
      // "harvested" material — obtained honestly, not fabricated. ─────────
      const b = await bootIdentity(browser, USER_B, 'Bob-Harvested');
      const bCardLink = await getShareCardLink(b.page);
      const bPayload = extractCardPayload(bCardLink);

      // ── 3. C (attacker) is a REAL, separate identity with its own real
      // private key — the gift wrap will be genuinely, validly signed as C. ──
      const c = await bootIdentity(browser, USER_C, 'Carol-Attacker');

      // ── 4. THE EXCEPTION: forge a pairing-ack authenticated as C's real
      // identity but enclosing B's genuine card, addressed to A, echoing
      // A's real live nonce (isolating sender-binding as the ONLY possible
      // rejection reason — the nonce is genuinely admissible). ─────────────
      await sendForgedPairingAck(c.page, {
        attackerPrivateKeyHex: USER_C.privateKeyHex,
        attackerPubkeyHex: USER_C.pubkeyHex,
        issuerPubkeyHex: USER_A.pubkeyHex,
        echoedNonceHex: issuedNonceHex,
        harvestedCardB64Url: bPayload,
      });

      // ── 5. Give the relay/subscription time to deliver + process, then
      // assert NEITHER B NOR C was ever admitted by A. ─────────────────────
      await a.page.waitForTimeout(15_000);
      const knownPeersAfterForgery = await readKnownPeers(a.page);
      const contactsAfterForgery = await readContactPubkeys(a.page);
      expect(
        knownPeersAfterForgery,
        'B\'s pubkey (the harvested card\'s named identity) must never be admitted',
      ).not.toContain(USER_B.pubkeyHex.toLowerCase());
      expect(
        contactsAfterForgery.map((h) => h.toLowerCase()),
        'B\'s pubkey must never appear in A\'s contacts',
      ).not.toContain(USER_B.pubkeyHex.toLowerCase());
      expect(
        knownPeersAfterForgery,
        'C\'s pubkey (the authenticated sender, but with a mismatched card) must also never be admitted',
      ).not.toContain(USER_C.pubkeyHex.toLowerCase());
      expect(
        contactsAfterForgery.map((h) => h.toLowerCase()),
        'C\'s pubkey must never appear in A\'s contacts',
      ).not.toContain(USER_C.pubkeyHex.toLowerCase());

      // ── 6. POSITIVE CONTROL: B now does a REAL, legitimate scan of A's
      // same code. This proves the earlier non-admission was specifically
      // the sender-binding rejection at work — not a broken relay, a dead
      // subscription, or a nonce that silently expired in the meantime. ────
      await b.page.goto(`/add#c=${aPayload}`);
      await expect(b.page.getByTestId('contact-added-success')).toBeVisible({ timeout: 20_000 });

      const bAdmitted = await waitForAdmission(a.page, USER_B.pubkeyHex, 60_000);
      expect(bAdmitted, 'B\'s OWN legitimate echo (authenticated as B, card names B) must admit B').toBe(true);

      // ── 7. C is STILL never admitted, even after the pipe is proven live. ──
      const knownPeersFinal = await readKnownPeers(a.page);
      expect(knownPeersFinal, 'C must remain permanently un-admitted').not.toContain(USER_C.pubkeyHex.toLowerCase());
    },
  );
});
