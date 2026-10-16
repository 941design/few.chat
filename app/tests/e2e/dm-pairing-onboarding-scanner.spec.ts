/**
 * E2E: pairing — nameless onboarding scanner completes a deferred echo
 * automatically (AC-PAIR-10, AC-SCAN-5, AC-SCAN-6).
 *
 * Epic: contact-pairing-code, story S6. A scanner with NO prior identity or
 * profile opens a live pairing code cold: the app auto-generates a fresh
 * identity on mount, one-directionally adds the issuer immediately, then —
 * because the fresh identity has no name yet — redirects to
 * `/profile?pairing=1&issuer=…` instead of completing the echo right away
 * (AC-SCAN-5). The pending intent is durably persisted before that redirect,
 * so the moment the scanner sets a name the profile page's own edge-triggered
 * effect (profile.tsx's `hasShareableName` false->true transition) drains it
 * automatically (AC-SCAN-6) — no second scan, no manual retry action.
 *
 * Every step is driven through the real app: A's code via the real Profile
 * "Share contact card" action, B's identity via the app's own auto-generation
 * (a genuinely fresh, unseeded browser context), B's redirect via a real
 * `/add#c=…` navigation, and B's echo via genuinely filling the real
 * nickname input — never a hand-built event or a forced function call.
 *
 * Requires the strfry relay harness: make e2e-up (or make test-e2e-groups).
 * Run: E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/dm-pairing-onboarding-scanner.spec.ts
 *
 * UPDATED (epic: first-visit-invite-welcome, story S3) — B's scenario below
 * (a completely fresh visitor, no identity/profile seeded) is EXACTLY the
 * precondition S3's welcome screen now intercepts. Pre-S3, opening the live
 * code auto-completed the one-directional add and (being nameless)
 * redirected to `/profile?pairing=1` name setup, where the deferred echo
 * fired once a name was entered there. Since S3, B instead sees the blended
 * welcome screen first; entering a name there satisfies the
 * pending-pairing-echo requirement INLINE (AC-NAME-2) — the add and the
 * echo attempt both happen as part of completing the welcome screen, with
 * no separate `/profile?pairing=1` detour and no `profile-nickname-input`
 * step. The updated test below drives that new path; the end state it
 * verifies (A eventually admits B with no further scan on either side) is
 * unchanged.
 */
import { test, expect } from '@playwright/test';
import { USER_A, computeTestKeypairs } from './helpers/auth-helpers';
import { bootIdentity, newAnonymousContext, getShareCardLink, extractCardPayload } from './helpers/contact-card';
import { waitForAdmission, readContactPubkeys } from './helpers/pairing';

test.describe('Pairing: nameless onboarding scanner completes a deferred echo (AC-PAIR-10)', () => {
  // Fresh identities per test execution: no relay history from earlier tests,
  // repeats, retries or runs (BACKLOG: e2e-pending-confirmation-relay-pollution).
  test.beforeEach(async () => {
    await computeTestKeypairs({ perTest: true });
  });

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((c) => c.close()));
  });

  test(
    'a scanner with no prior identity sees the first-visit welcome screen, and the name captured there satisfies the pairing echo inline (epic: first-visit-invite-welcome, story S3)',
    async ({ browser }) => {
      // ── 1. A (issuer) shares a real v2 pairing code. ────────────────────
      const a = await bootIdentity(browser, USER_A, 'Alice-Pairing');
      const cardLink = await getShareCardLink(a.page);
      const payload = extractCardPayload(cardLink);

      // ── 2. B is a completely fresh visitor — no identity, no profile
      // seeded at all. Opening the code makes the app auto-generate an
      // identity on mount (NostrIdentityContext), then — since story S3 —
      // shows the blended welcome screen instead of auto-completing and
      // redirecting to name setup (see file header). ─────────────────────
      const b = await newAnonymousContext(browser);
      await b.page.goto(`/add#c=${payload}`);
      await expect(b.page.getByTestId('welcome-invite')).toBeVisible({ timeout: 20_000 });

      // ── 3. Read B's freshly auto-generated pubkey — it wasn't seeded, the
      // app generated it, so the test doesn't know it ahead of time. The
      // identity is already hydrated by the time the welcome screen renders
      // (that's a precondition of showing it at all). ─────────────────────
      const bPubkeyHex: string = await b.page.evaluate(() => {
        const raw = localStorage.getItem('lp_nostrIdentity_v1');
        return raw ? (JSON.parse(raw) as { pubkeyHex: string }).pubkeyHex : '';
      });
      expect(bPubkeyHex).toMatch(/^[0-9a-f]{64}$/);

      // ── 4. Complete the welcome screen — capturing the name up front
      // satisfies the pending-pairing-echo requirement inline (AC-NAME-2):
      // no `/profile?pairing=1` detour, no separate `profile-nickname-input`
      // step. ───────────────────────────────────────────────────────────
      await b.page.getByTestId('welcome-name-input').fill('Onboarded-Bob');
      await b.page.getByTestId('welcome-primary-action').click();
      await expect(b.page).not.toHaveURL(/pairing=1/);

      // B's one-directional add of A completes as part of the same flow.
      await expect.poll(() => readContactPubkeys(b.page), { timeout: 20_000 }).toContain(USER_A.pubkeyHex);

      // ── 5. A must admit the onboarded scanner — the echo fired inline as
      // part of completing the welcome screen, with no further scan on
      // either side. ──────────────────────────────────────────────────────
      const admitted = await waitForAdmission(a.page, bPubkeyHex, 60_000);
      expect(admitted, 'A must admit the onboarded scanner once they set a name, with no further scan').toBe(true);
    },
  );
});
