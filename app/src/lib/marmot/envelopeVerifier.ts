/**
 * envelopeVerifier.ts — Shared inner-envelope verifier for forwardable kinds.
 *
 * Epic: group-message-author-auth-app-layer | Story S7
 *
 * Generalizes the crypto/shape verification profileSync.ts's parseProfilePayload
 * used to perform inline for the profile (kind 0) envelope, so a future
 * forwardable kind reuses the SAME hardening set instead of re-implementing it
 * (spec.md Solution §6):
 *   - valid JSON / signed-inner-event shape
 *   - correct inner event kind
 *   - valid Schnorr signature over the inner event (nostr-tools verifyEvent)
 *   - group-binding for group-scoped kinds — a PER-KIND policy (profile is
 *     EXEMPT; see architecture.md's profile(0) actor-rule row)
 *
 * Two concerns this module deliberately does NOT own:
 *
 *   1. Roster/admin authorization. This module authenticates the INNER
 *      SIGNER — it never checks whether that signer is a current group
 *      member or admin. Verification and authorization are different
 *      questions; profiles are roster-EXEMPT by product decision (a
 *      departed member's late/forwarded profile must still be accepted), so
 *      no roster dependency exists here at all — not a bypassable flag.
 *
 *   2. One-shot consumption is intentionally DECOUPLED from verify() itself
 *      (see createOneShotGate below) so verify() stays pure/stateless: a
 *      self-authored delivery and a forwarded copy of the byte-identical
 *      signed inner event both legitimately verify (both ARE validly
 *      signed) — it is the APPLICATION of a side effect that must happen at
 *      most once, gated separately by the caller.
 */

import { verifyEvent } from 'nostr-tools/pure';

/** Structural shape every forwarded envelope's inner content must carry. */
export interface SignedInnerEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Tag name (tag[0]) carrying the RECEIVING group's id on a group-scoped
 * forwarded kind's inner event, e.g. ['g', groupId]. No forwardable kind
 * declares group-binding today (profile is exempt), so no in-app producer
 * emits this tag yet — exercised by directly-constructed envelopes in
 * verifier-unit tests, and by future group-scoped kinds.
 */
export const GROUP_BINDING_TAG_NAME = 'g';

export interface GroupBindingPolicy {
  /**
   * false: context-free / identity-scoped kind (e.g. profile, kind 0) — no
   * group-tag check is performed; the `groupId` argument to verify() is
   * ignored entirely for this kind.
   * true: group-scoped kind — the inner event MUST carry a
   * [GROUP_BINDING_TAG_NAME, groupId] tag matching the RECEIVING group's id,
   * checked BEFORE the caller may apply any side effect (no partial merge,
   * no premature one-shot consumption on a rejected envelope).
   */
  groupScoped: boolean;
}

/** Per-kind spec — declared once by the owning module (e.g. profileSync.ts). */
export interface ForwardedKindSpec {
  /** The Nostr kind the embedded signed inner event must carry. */
  innerKind: number;
  binding: GroupBindingPolicy;
}

export type VerifyFailureReason = 'malformed' | 'invalid-signature' | 'wrong-kind' | 'group-mismatch';

export type VerifyResult =
  | { ok: true; event: SignedInnerEvent }
  | { ok: false; reason: VerifyFailureReason };

function looksLikeSignedEvent(parsed: unknown): parsed is SignedInnerEvent {
  if (!parsed || typeof parsed !== 'object') return false;
  const o = parsed as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    typeof o.sig === 'string' &&
    typeof o.created_at === 'number' &&
    typeof o.content === 'string' &&
    Array.isArray(o.tags) &&
    typeof o.kind === 'number'
  );
}

/**
 * Verify a forwarded inner-signed envelope string (as carried in an MLS
 * application rumor's `content`) against a per-kind spec. Pure / stateless —
 * safe to call directly with no setup, and safe to share as a bare function
 * across every caller (no accumulated state to leak between them).
 *
 * Does NOT check roster membership. Does NOT perform one-shot consumption —
 * see createOneShotGate() for that, applied by the caller at the point a
 * side effect is actually committed.
 *
 * `reason: 'malformed'` is the ONLY result a caller may treat as "not this
 * shape, try a different wire format instead" (e.g. profileSync.ts's legacy
 * unsigned-flat-payload fallback). Every other reason is a hard reject: a
 * structurally-signed-looking envelope that fails signature/kind/binding
 * must never be silently reinterpreted as an unsigned legacy payload — that
 * would let an attacker strip or forge the envelope and resubmit the same
 * bytes as "legacy".
 */
export function verifyForwardedEnvelope(
  content: string,
  spec: ForwardedKindSpec,
  groupId?: string,
): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!looksLikeSignedEvent(parsed)) {
    return { ok: false, reason: 'malformed' };
  }

  if (parsed.kind !== spec.innerKind) {
    return { ok: false, reason: 'wrong-kind' };
  }

  let verified = false;
  try {
    verified = verifyEvent(parsed as never);
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, reason: 'invalid-signature' };
  }

  if (spec.binding.groupScoped) {
    // Guard entry shape (Array.isArray(t)) before indexing — looksLikeSignedEvent
    // only checks Array.isArray(o.tags), not that every entry is itself an
    // array, so a malformed entry (e.g. `tags: [null]`) must be skipped
    // rather than throwing a TypeError out of a pure verify() call.
    const taggedGroupId = parsed.tags.find(
      (t) => Array.isArray(t) && t[0] === GROUP_BINDING_TAG_NAME,
    )?.[1];
    if (!groupId || taggedGroupId !== groupId) {
      return { ok: false, reason: 'group-mismatch' };
    }
  }

  return { ok: true, event: parsed };
}

export interface OneShotGate {
  /**
   * Returns true the FIRST time a given inner event id is passed (and marks
   * it consumed for every subsequent call); returns false on every later
   * call for the same id. Real, accumulating state for the gate's lifetime —
   * NOT a stub that always reports "not yet consumed", and NOT reset on
   * every call.
   */
  tryConsume(innerEventId: string): boolean;
}

/**
 * Fresh one-shot consumption gate. A plain Set that only grows for the
 * lifetime of the returned instance — callers own that lifetime. Production
 * wiring (profileHandler.ts) creates ONE instance per handler construction,
 * mirroring applicationRumorDispatcher.ts's per-subscribe lifecycle (one
 * instance per subscribe), so state genuinely accumulates across deliveries
 * within a subscription rather than resetting per call.
 *
 * Deliberately UNBOUNDED — unlike the dispatcher's own seen-rumor-id LRU
 * (applicationRumorDispatcher.ts, capacity-evicting), this Set never evicts.
 * An LRU here could drop an old inner-event id and let a late duplicate
 * re-apply, breaking exact one-shot semantics. Growth is bounded in practice
 * by the count of distinct signed-profile inner-event ids seen during a
 * subscription — small, since profile events are infrequent.
 */
export function createOneShotGate(): OneShotGate {
  const consumed = new Set<string>();
  return {
    tryConsume(innerEventId: string): boolean {
      if (consumed.has(innerEventId)) return false;
      consumed.add(innerEventId);
      return true;
    },
  };
}
