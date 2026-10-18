/**
 * Discriminated union identifying the persistence namespace for a reaction thread.
 * - group: reactions stored under few:reactions:group:{groupId}
 * - dm:    reactions stored under few:reactions:dm:{peerPubkeyHex}
 *
 * Single-identity app (D11): no identity_id concept.
 */
export type ReactionThreadKey =
  | { kind: 'group'; groupId: string }
  | { kind: 'dm'; peerPubkeyHex: string };

/**
 * A single reaction row stored in idb-keyval.
 *
 * Seam S1 — consumed by reactions-store (S2), rumor-builder (S3),
 * group-reactions (story-06), dm-reactions (story-07), and reaction-ui (story-08).
 *
 * Invariants:
 * - identity_id is absent (D11 — single-identity app).
 * - emoji is a non-empty Unicode glyph; NIP-30 shortcodes are out of scope (D4).
 * - eventId is an empty string for in-flight optimistic rows; a 64-char hex string once confirmed.
 * - removed === true means the row is kept for dedup purposes but not rendered.
 * - At most one non-removed row per (messageId, reactorPubkey, emoji) triple (D2).
 */
export interface Reaction {
  /** Local UUID for optimistic rows; replaced by the wire id on confirm. */
  id: string;

  /** Local message id (== ChatMessage.id) the reaction attaches to. */
  messageId: string;

  /** Reactor identity (hex pubkey). */
  reactorPubkey: string;

  /** Unicode glyph. NIP-30 shortcodes are out of scope (D4). */
  emoji: string;

  /** Wire event id. Empty string for in-flight optimistic rows. */
  eventId: string;

  /** ms since epoch (matches ChatMessage.createdAt). */
  createdAt: number;

  /**
   * Tombstone marker: true if a content="-" removal rumor has been observed
   * for this (messageId, reactorPubkey, emoji) tuple.
   * Tombstoned rows are not rendered but are kept for dedup.
   */
  removed: boolean;

  /**
   * ms since epoch of the NEWEST removal seen for this triple (inbound removal:
   * created_at * 1000; optimistic: local send time). With `createdAt` (newest
   * add time) it decides the visible state, last writer wins: live iff
   * createdAt > removedAt, a tie goes to the removal. Absent on legacy
   * tombstones (written before this field existed): removal wins over any add.
   * A row with createdAt 0 and removed: true is a removal seen before any add.
   */
  removedAt?: number;
}

/**
 * Curated set of 36 Unicode emoji glyphs used by both the compose picker
 * and the reaction picker (D3).
 *
 * Count is a multiple of both grid widths (4-col compose, 6-col reaction) so
 * neither picker has a ragged final row: compose renders 4 × 9, reaction 6 × 6.
 * Categories: Faces (17), Gestures (6), Symbols (8), Objects (5).
 *
 * No NIP-30 shortcodes (D4).
 */
export const CURATED_EMOJI: readonly string[] = [
  // Faces (17)
  '😀', '😂', '🤣', '😊', '😉', '😅', '😢', '😭', '😍', '🥰', '🥺', '😎', '🤔', '😮', '🤯', '🥳', '😴',
  // Gestures (6)
  '👍', '👋', '🙏', '✌️', '👏', '💪',
  // Symbols (8)
  '❤️', '✨', '🔥', '💯', '✅', '❌', '⭐', '👀',
  // Objects (5)
  '🎉', '💡', '📌', '🔔', '🚀',
] as const;
