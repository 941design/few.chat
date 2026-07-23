/**
 * leaveSync.ts — Utilities for building and processing leave-intent messages.
 *
 * Mirrors pollSync.ts. Serialises/deserialises leave-intent
 * payloads for MLS application messages (kind 13).
 */

// ---- MLS application-message kind discriminator ----

export const LEAVE_INTENT_KIND = 13;

// ---- Payload type ----

export interface LeaveIntentPayload {
  pubkey: string;
}

// ---- Serialisation ----

export function serialiseLeaveIntent(payload: LeaveIntentPayload): string {
  return JSON.stringify({ pubkey: payload.pubkey });
}

// ---- Parsing (with validation) ----

export function parseLeaveIntent(content: string): LeaveIntentPayload | null {
  try {
    const d = JSON.parse(content) as LeaveIntentPayload;
    if (typeof d.pubkey !== 'string') {
      return null;
    }
    // Canonicalize to lowercase hex so the forced-removal subject===sender
    // gate in leaveHandler.ts (AC-FORCE-3) compares like-for-like against
    // AuthenticatedSender.pubkey — the wire shape (JSON { pubkey }) is
    // unchanged, only the in-memory representation is normalized.
    const pubkey = d.pubkey.toLowerCase();
    // Drop empty / non-canonical subjects as malformed, per the spec-request
    // (§7 "pubkey:'' is a live-send edge ... drop as malformed — do not add an
    // empty-pubkey tolerance carve-out"). Without this, an empty subject from a
    // not-yet-hydrated client (pubkeyHex ?? '') would pass the subject===sender
    // gate VACUOUSLY ('' === '') and arm a no-op removal.
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return null;
    }
    return { pubkey };
  } catch {
    return null;
  }
}
