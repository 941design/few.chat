/**
 * buildReactionRumor — Seam S3 producer.
 *
 * Builds an unsigned NIP-25 kind-7 reaction rumor with a canonical NIP-01 id.
 * Transport-agnostic: callers (story-06 group, story-07 DM) pass the result to
 * their respective transports (sendRumorSafe / sealAndWrap).
 *
 * Decisions in scope:
 *   D2  — multi-emoji; caller supplies the specific emoji glyph.
 *   D4  — NIP-30 shortcodes are out of scope; emoji is treated as an opaque glyph.
 *   D10 — inner shape: kind 7, e/k/p tags, pubkey, created_at, id, no sig.
 *   D11 — single-identity; no identity_id anywhere.
 *
 * Module boundary: imports only from lib/reactions/, lib/directMessages.ts (type-only),
 * and nostr-tools/pure + nostr-tools/nip59. Never imports from components/, context/,
 * or pages/.
 */

import { getPublicKey, getEventHash } from 'nostr-tools/pure';
import type { UnsignedRumor } from '@/src/lib/directMessages';

/** Kind-7 NIP-25 reaction rumor kind constant. */
const REACTION_KIND = 7;

/**
 * Build an unsigned kind-7 reaction rumor per NIP-25 and D10.
 *
 * @param params.emoji             - Unicode glyph to react with. Must be non-empty.
 * @param params.targetMessageId   - Event id (hex) of the message being reacted to.
 * @param params.targetMessageKind - Kind of the target event (e.g. 14 for DM, 9 for group).
 * @param params.targetAuthorPubkey - Hex pubkey of the target message author.
 *                                   Include for DMs; omit (undefined) for groups (spec §3.3).
 * @param params.selfPrivKeyHex    - Sender private key hex, used only to derive pubkey and id.
 *                                   Not retained after the function returns.
 * @param params.isRemoval         - When true, content is "-" instead of the emoji glyph.
 *                                   Also adds an ["emoji", emoji] tag so receivers can
 *                                   identify which reaction is being removed (multi-emoji D2).
 * @param params.notBeforeSec      - Floor (unix seconds) for created_at, computed by stampFloorFor inside prepareOwnReaction.
 *                                   created_at = max(floor(now), notBeforeSec), so a rumor is never
 *                                   stamped older than the sender's own latest state for the triple
 *                                   (receivers compare at one-second resolution).
 *
 * @returns An unsigned rumor with no sig field. id is the canonical NIP-01 SHA-256 hash.
 * @throws  When emoji is an empty string.
 */
export function buildReactionRumor(params: {
  emoji: string;
  targetMessageId: string;
  targetMessageKind: number;
  targetAuthorPubkey?: string;
  selfPrivKeyHex: string;
  isRemoval?: boolean;
  notBeforeSec?: number;
}): UnsignedRumor {
  const { emoji, targetMessageId, targetMessageKind, targetAuthorPubkey, selfPrivKeyHex, isRemoval, notBeforeSec } = params;

  if (!emoji) {
    throw new Error('buildReactionRumor: emoji must be a non-empty string');
  }

  if (!isRemoval && emoji === '-') {
    throw new Error('buildReactionRumor: emoji must not be "-" on the add path');
  }

  const privKeyBytes = hexToBytes(selfPrivKeyHex);
  const pubkey = getPublicKey(privKeyBytes);

  const content = isRemoval ? '-' : emoji;

  const tags: string[][] = [
    ['e', targetMessageId],
    ['k', String(targetMessageKind)],
  ];

  // Include p tag only when the caller supplies a non-empty targetAuthorPubkey.
  // Groups omit this tag because the MLS envelope already addresses members (spec §3.3).
  if (targetAuthorPubkey !== undefined) {
    if (targetAuthorPubkey === '') {
      throw new Error('buildReactionRumor: targetAuthorPubkey must be undefined or a non-empty hex string');
    }
    tags.push(['p', targetAuthorPubkey]);
  }

  // For removal rumors with a known emoji, add an ["emoji", emoji] tag so receivers
  // can unambiguously identify which emoji is being removed under the multi-emoji
  // policy (D2). The add path omits this tag since the emoji is already in content.
  if (isRemoval && emoji) {
    tags.push(['emoji', emoji]);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const created_at =
    notBeforeSec !== undefined && Number.isFinite(notBeforeSec) ? Math.max(nowSec, notBeforeSec) : nowSec;

  // Construct a partial rumor to compute the canonical NIP-01 id.
  // getEventHash serialises [0, pubkey, created_at, kind, tags, content] and SHA-256s it.
  const partial = {
    kind: REACTION_KIND,
    content,
    tags,
    pubkey,
    created_at,
  };

  const id = getEventHash(partial);

  // Return as UnsignedRumor — no sig field by definition (rumors are unsigned).
  return {
    kind: REACTION_KIND,
    content,
    tags,
    pubkey,
    created_at,
    id,
  };
}

// ─── Local helper (not exported — keeps the module self-contained) ────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
