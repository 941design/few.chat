/**
 * profile-broadcast-marker.test.ts — unit tests for `nextBroadcastMarker`,
 * exported from `app/pages/profile.tsx` (epic:
 * group-message-author-auth-app-layer, story S8-remediation, AC-SEND-10).
 *
 * Regression coverage for the interactive-path fail-closed gap: the
 * verification examiner found that `broadcastProfile` (profile.tsx) set the
 * `lastBroadcastNickname` marker BEFORE the (fire-and-forget)
 * `publishProfileUpdate` call resolved. On a locked/absent NIP-07 signer the
 * send fails closed (no meta-event emitted — that half was already correct),
 * but the marker was advanced anyway, so once the signer recovered a
 * same-text blur was silently suppressed (`profile.nickname ===
 * lastBroadcastNickname.current`) and the profile was never proactively
 * re-broadcast until the text changed again.
 *
 * `profile.tsx` is a page component (Chakra/Next imports) — this repo has no
 * jsdom/@testing-library/renderHook precedent (see
 * profile-announce-fanout.test.ts / profile-add-to-group-marker.test.ts), so
 * the marker-advance decision is extracted into a pure, directly-testable
 * function (`nextBroadcastMarker`) and exercised here; `handleNicknameBlur`'s
 * own re-attempt condition (`profile.nickname !== lastBroadcastNickname.current`)
 * is reproduced locally as `shouldReAttemptBroadcast` (a direct, literal copy
 * of the one-line comparison in profile.tsx — not a re-implementation of any
 * decision logic) so the full retry sequence can be asserted end to end
 * without mounting React.
 */
import { describe, expect, it } from 'vitest';

import { nextBroadcastMarker } from '@/pages/profile';

/** Mirrors `handleNicknameBlur`'s literal re-attempt condition in profile.tsx. */
function shouldReAttemptBroadcast(nickname: string, marker: string | null): boolean {
  return nickname !== marker;
}

describe('nextBroadcastMarker — AC-SEND-10 (S8-remediation): marker only advances on a confirmed send', () => {
  it('advances to the attempted nickname when the send is confirmed', () => {
    expect(nextBroadcastMarker('Alice', 'Alice Renamed', true)).toBe('Alice Renamed');
  });

  it('regression: leaves the marker UNCHANGED when the send is not confirmed (locked/absent signer) — the marker must NOT jump to the attempted nickname', () => {
    expect(nextBroadcastMarker('Alice', 'Alice Locked', false)).toBe('Alice');
  });

  it('leaves a null baseline marker as null when the send is not confirmed', () => {
    expect(nextBroadcastMarker(null, 'Alice', false)).toBeNull();
  });

  it('advances a null baseline marker to the attempted nickname when confirmed', () => {
    expect(nextBroadcastMarker(null, 'Alice', true)).toBe('Alice');
  });
});

describe('regression: signer-locked send ⇒ marker not advanced ⇒ same-text blur re-attempts ⇒ recovery succeeds', () => {
  it('reproduces the full AC-SEND-10 interactive-path recovery sequence', () => {
    // Seeded baseline from hydration (profile.tsx's hydrate effect).
    let marker: string | null = 'Alice';

    // 1. User edits the nickname and blurs while the signer is locked/absent.
    const attemptedNickname = 'Alice Locked';
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(true);
    const firstSendConfirmed = false; // AC-SEND-10 fail-closed: no meta-event emitted.
    marker = nextBroadcastMarker(marker, attemptedNickname, firstSendConfirmed);

    // Bug this test guards against: the marker must NOT have advanced to
    // "Alice Locked" — if it had, the next same-text blur below would be
    // wrongly suppressed.
    expect(marker).toBe('Alice');

    // 2. A later blur with the SAME (still-unsent) text — e.g. the user tabs
    // away and back without further edits — must still be treated as a
    // pending re-attempt, because the previous attempt never confirmed.
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(true);

    // 3. The signer has now recovered; this re-attempt succeeds.
    const secondSendConfirmed = true;
    marker = nextBroadcastMarker(marker, attemptedNickname, secondSendConfirmed);
    expect(marker).toBe('Alice Locked');

    // 4. A further same-text blur is now correctly suppressed — the profile
    // is not endlessly re-broadcast once a send has actually confirmed.
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(false);
  });

  it('a send that signs successfully but fails for every group (network/relay failure, not a signer lock) also leaves the marker unchanged', () => {
    // Mirrors MarmotContext#publishProfileUpdate resolving `false` because
    // sentCount stayed 0 even though signing succeeded (every per-group
    // sendRumorSafe threw) — the same "not confirmed" outcome as a locked
    // signer, and must be handled identically by the marker.
    let marker: string | null = 'Alice';
    const attemptedNickname = 'Alice Renamed';
    marker = nextBroadcastMarker(marker, attemptedNickname, false);
    expect(marker).toBe('Alice');
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(true);
  });

  it('S8R-1 (VACUOUS, 0 groups, ready): publishProfileUpdate resolves `true` — the marker DOES advance, unlike a genuine failure', () => {
    // MarmotContext#publishProfileUpdate now distinguishes VACUOUS (client
    // ready, zero groups to send to — resolves `true`, this is not a
    // failure) from NOT-READY (client/identity not yet available — resolves
    // `false`, the send genuinely didn't happen). The decision itself
    // (`resolvePublishProfileUpdateShortCircuit`) is unit-tested directly in
    // tests/unit/marmot/profileRequestHandler.test.ts (S8R-1 describe
    // block); this test only asserts the marker's OWN reaction to each of
    // the two resolved booleans, which is the contract this file owns.
    let marker: string | null = 'Alice';
    const attemptedNickname = 'Alice Renamed';

    // VACUOUS: publishProfileUpdate resolves true (a user with 0 groups but
    // >=1 contact must not be stuck re-broadcasting on every same-text blur).
    marker = nextBroadcastMarker(marker, attemptedNickname, true);
    expect(marker).toBe('Alice Renamed');
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(false);
  });

  it('S8R-1 (NOT-READY): publishProfileUpdate resolves `false` — the marker does NOT advance', () => {
    let marker: string | null = 'Alice';
    const attemptedNickname = 'Alice Renamed';

    // NOT-READY: publishProfileUpdate resolves false — nothing was sent, so
    // the same-text retry must remain eligible once the client becomes ready.
    marker = nextBroadcastMarker(marker, attemptedNickname, false);
    expect(marker).toBe('Alice');
    expect(shouldReAttemptBroadcast(attemptedNickname, marker)).toBe(true);
  });
});
