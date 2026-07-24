/**
 * Verifier-unit tests for envelopeVerifier.ts (the "Shared verifier" module).
 *
 * Epic: group-message-author-auth-app-layer | Story S7
 * Covers AC-FWD-5 (replay hardening — verifier-unit) and the pre-impl
 * commitment set (verification.json VQ-S7-004/006/008):
 *   - valid inner signature acceptance
 *   - invalid inner signature rejection
 *   - correct-vs-incorrect inner event kind
 *   - a DIRECTLY-CONSTRUCTED group-scoped envelope with a mismatched group
 *     tag rejected (profile itself is group-binding-exempt and cannot
 *     exercise this branch through the app — see architecture.md's
 *     Shared-verifier row and profile(0) actor-rule row)
 *   - one-shot consumption rejecting a second application of the same inner
 *     event id, and NOT rejecting a genuinely different inner event id
 *
 * Real signing (finalizeEvent/generateSecretKey) is used throughout, mirroring
 * the project convention in profileSync.test.ts — no mocking of nostr-tools.
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import {
  verifyForwardedEnvelope,
  createOneShotGate,
  GROUP_BINDING_TAG_NAME,
  type ForwardedKindSpec,
} from '@/src/lib/marmot/envelopeVerifier';

// A hypothetical group-scoped forwardable kind, distinct from profile (0),
// used ONLY to exercise the binding-policy branch that no real producer
// exists for yet (profile is group-binding EXEMPT).
const GROUP_SCOPED_INNER_KIND = 9999;
const GROUP_SCOPED_SPEC: ForwardedKindSpec = {
  innerKind: GROUP_SCOPED_INNER_KIND,
  binding: { groupScoped: true },
};

const CONTEXT_FREE_SPEC: ForwardedKindSpec = {
  innerKind: 0,
  binding: { groupScoped: false },
};

function signEvent(kind: number, content: string, tags: string[][] = []) {
  const sk = generateSecretKey();
  return finalizeEvent(
    {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    },
    sk,
  );
}

describe('envelopeVerifier — verifyForwardedEnvelope', () => {
  it('accepts a validly-signed envelope with the correct inner kind (context-free spec)', () => {
    const signed = signEvent(0, JSON.stringify({ hello: 'world' }));
    const result = verifyForwardedEnvelope(JSON.stringify(signed), CONTEXT_FREE_SPEC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe(signed.id);
      expect(result.event.pubkey).toBe(signed.pubkey);
    }
  });

  it('rejects an envelope with a tampered/invalid signature', () => {
    const signed = signEvent(0, JSON.stringify({ hello: 'world' }));
    const tampered = { ...signed, sig: signed.sig.slice(0, -1) + (signed.sig.endsWith('0') ? '1' : '0') };
    const result = verifyForwardedEnvelope(JSON.stringify(tampered), CONTEXT_FREE_SPEC);
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('rejects an envelope whose id has been replaced with a different valid-shaped hex id, despite an otherwise-valid signature (AC-FWD-5 one-shot binding depends on nostr-tools rejecting hash!==id)', () => {
    // AC-FWD-5's one-shot key is the inner event's `id`, cryptographically
    // bound to the signed content via nostr-tools' internal
    // `hash !== event.id` check inside verifyEvent. This test guards against
    // a future nostr-tools dependency bump silently dropping that check —
    // if it ever did, an attacker could re-tag a validly-signed event with a
    // different id and defeat the one-shot gate (createOneShotGate keys on
    // event.id, not the signature-derived hash).
    const signed = signEvent(0, JSON.stringify({ hello: 'world' }));
    const differentValidHexId = signed.id
      .split('')
      .map((c) => (c === '0' ? '1' : '0'))
      .join('');
    expect(differentValidHexId).toMatch(/^[0-9a-f]{64}$/i);
    expect(differentValidHexId).not.toBe(signed.id);
    const idTampered = { ...signed, id: differentValidHexId };
    const result = verifyForwardedEnvelope(JSON.stringify(idTampered), CONTEXT_FREE_SPEC);
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('rejects a validly-signed envelope whose inner kind does not match the spec', () => {
    const signed = signEvent(1, JSON.stringify({ hello: 'world' })); // kind 1, spec wants 0
    const result = verifyForwardedEnvelope(JSON.stringify(signed), CONTEXT_FREE_SPEC);
    expect(result).toEqual({ ok: false, reason: 'wrong-kind' });
  });

  it('returns reason "malformed" for invalid JSON', () => {
    const result = verifyForwardedEnvelope('not json at all', CONTEXT_FREE_SPEC);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns reason "malformed" for JSON that does not structurally look like a signed event (e.g. a legacy flat payload)', () => {
    const flat = JSON.stringify({ nickname: 'Alice', avatar: null, updatedAt: '2026-01-01T00:00:00Z' });
    const result = verifyForwardedEnvelope(flat, CONTEXT_FREE_SPEC);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  // ─── AC-FWD-5 / VQ-S7-006 / VQ-S7-008: group-binding mismatch ────────────
  // Profile (kind 0) is group-binding EXEMPT (architecture.md), so no in-app
  // producer can emit a group-scoped envelope — this branch is exercised by
  // constructing the envelope directly against a hypothetical group-scoped
  // spec, per architecture.md's explicit guidance.

  it('rejects a group-scoped envelope whose group tag does NOT match the receiving group id', () => {
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), [
      [GROUP_BINDING_TAG_NAME, 'group-alpha'],
    ]);
    const result = verifyForwardedEnvelope(JSON.stringify(signed), GROUP_SCOPED_SPEC, 'group-beta');
    expect(result).toEqual({ ok: false, reason: 'group-mismatch' });
  });

  it('rejects a group-scoped envelope carrying NO group tag at all', () => {
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), []);
    const result = verifyForwardedEnvelope(JSON.stringify(signed), GROUP_SCOPED_SPEC, 'group-beta');
    expect(result).toEqual({ ok: false, reason: 'group-mismatch' });
  });

  it('rejects a group-scoped envelope when the caller omits groupId entirely (fails closed)', () => {
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), [
      [GROUP_BINDING_TAG_NAME, 'group-alpha'],
    ]);
    const result = verifyForwardedEnvelope(JSON.stringify(signed), GROUP_SCOPED_SPEC);
    expect(result).toEqual({ ok: false, reason: 'group-mismatch' });
  });

  it('rejects (not throws) a group-scoped envelope whose tags array contains a malformed (null) entry', () => {
    // looksLikeSignedEvent only checks Array.isArray(o.tags), not that every
    // entry is itself an array-shaped tag. nostr-tools' OWN validateEvent
    // (invoked by both finalizeEvent and verifyEvent) already rejects
    // malformed tag entries at the hashing step, so a malformed entry can
    // only be introduced by tampering a genuinely-signed event's tags AFTER
    // signing (finalizeEvent itself throws synchronously for malformed
    // input tags — it cannot be used to sign one directly). The resulting
    // hash mismatch makes verifyEvent report an ordinary invalid signature
    // (a "suitable reason", not group-mismatch) — the point of this test is
    // that the group-binding lookup guards entry shape and never lets a
    // malformed entry escape as an unhandled TypeError, regardless of which
    // gate (signature or group-binding) ultimately rejects it. Unreachable
    // for profile today (groupScoped:false skips this block); this exists
    // as defense-in-depth for future group-scoped kinds.
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), []);
    const withMalformedTags = { ...signed, tags: [null] as unknown as string[][] };
    expect(() =>
      verifyForwardedEnvelope(JSON.stringify(withMalformedTags), GROUP_SCOPED_SPEC, 'group-beta'),
    ).not.toThrow();
    const result = verifyForwardedEnvelope(JSON.stringify(withMalformedTags), GROUP_SCOPED_SPEC, 'group-beta');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }
  });

  it('rejects (not throws) a group-scoped envelope whose tags array contains a non-array entry', () => {
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), []);
    const withMalformedTags = { ...signed, tags: ['not-an-array-entry'] as unknown as string[][] };
    expect(() =>
      verifyForwardedEnvelope(JSON.stringify(withMalformedTags), GROUP_SCOPED_SPEC, 'group-beta'),
    ).not.toThrow();
    const result = verifyForwardedEnvelope(JSON.stringify(withMalformedTags), GROUP_SCOPED_SPEC, 'group-beta');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }
  });


  it('accepts a group-scoped envelope whose group tag DOES match the receiving group id', () => {
    const signed = signEvent(GROUP_SCOPED_INNER_KIND, JSON.stringify({}), [
      [GROUP_BINDING_TAG_NAME, 'group-alpha'],
    ]);
    const result = verifyForwardedEnvelope(JSON.stringify(signed), GROUP_SCOPED_SPEC, 'group-alpha');
    expect(result.ok).toBe(true);
  });

  it('ignores groupId entirely for a group-binding-EXEMPT spec (profile-shaped kind)', () => {
    // Even a mismatched/absent groupId must not affect a context-free kind.
    const signed = signEvent(0, JSON.stringify({ hello: 'world' }));
    const result = verifyForwardedEnvelope(JSON.stringify(signed), CONTEXT_FREE_SPEC, 'irrelevant-group-id');
    expect(result.ok).toBe(true);
  });
});

describe('envelopeVerifier — createOneShotGate (AC-FWD-5)', () => {
  it('tryConsume returns true the first time an id is seen, false on every later call for the SAME id', () => {
    const gate = createOneShotGate();
    expect(gate.tryConsume('inner-id-1')).toBe(true);
    expect(gate.tryConsume('inner-id-1')).toBe(false);
    expect(gate.tryConsume('inner-id-1')).toBe(false);
  });

  it('is a REAL accumulating set, not a stub — state persists across many calls, not reset per call', () => {
    const gate = createOneShotGate();
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    for (const id of ids) {
      expect(gate.tryConsume(id)).toBe(true);
    }
    // Re-consuming ANY of the 50 previously-seen ids now fails — proves the
    // Set genuinely accumulated all 50 entries rather than only remembering
    // the most recent one (or none at all).
    for (const id of ids) {
      expect(gate.tryConsume(id)).toBe(false);
    }
  });

  it('does not conflate two DIFFERENT ids — a fresh id always succeeds regardless of prior consumption', () => {
    const gate = createOneShotGate();
    expect(gate.tryConsume('id-a')).toBe(true);
    expect(gate.tryConsume('id-b')).toBe(true);
    expect(gate.tryConsume('id-a')).toBe(false);
    expect(gate.tryConsume('id-c')).toBe(true);
  });

  it('two independent gate instances do not share state', () => {
    const gateA = createOneShotGate();
    const gateB = createOneShotGate();
    expect(gateA.tryConsume('shared-id')).toBe(true);
    // A different gate instance (e.g. a different handler construction /
    // subscription) has never seen this id — must independently accept it.
    expect(gateB.tryConsume('shared-id')).toBe(true);
  });
});
