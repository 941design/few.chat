/**
 * contactCard.ts — Contact Card Format v1 + v2 (epic: contact-card-exchange
 * story S1; epic: contact-pairing-code story S1).
 *
 * A pure, side-effect-free codec: bytes in, bytes out, sign/verify via
 * nostr-tools. No React, no storage, no relay, no NDK, no MarmotContext.
 * This is the seam every other story in either epic consumes — see
 * specs/epic-contact-pairing-code/architecture.md "Seams".
 *
 * Wire format v1 (see spec.md "Contact Card Format v1"):
 *
 *   header (1 byte)     bits 7–6 = version (v1 = 00), bit 5 = SIGNED,
 *                        bit 4 = HAS_AVATAR (reserved, must be 0 in v1),
 *                        bits 3–0 reserved (must be 0).
 *   pubkey (32 bytes)    raw x-only secp256k1 public key.
 *   -- present iff SIGNED --
 *   created_at (4 bytes) uint32 big-endian, Unix seconds.
 *   name_len (1 byte)    UTF-8 byte length of name (1–32; a signed card with
 *                        name_len 0 is rejected as malformed).
 *   name (name_len bytes) UTF-8 display name.
 *   sig (64 bytes)       NIP-01 kind-0 event signature over
 *                        { pubkey, created_at, kind:0, tags:[], content: CARD_CONTENT(name) }.
 *
 * Wire format v2 (see specs/contact-pairing-code-spec-request.md §4; RD-4 in
 * specs/epic-contact-pairing-code/architecture.md). A v2 card is a v1 card
 * with an expiry + pairing nonce spliced in between created_at and name_len,
 * and a domain-separated (non-kind-0) signature preimage that binds every
 * field so none can be resected across versions:
 *
 *   header (1 byte)      bits 7–6 = version (v2 = 01), bit 5 = SIGNED
 *                         (always 1 — a v2 card is always signed, DD/RD-4),
 *                         bit 4 = HAS_AVATAR (reserved, must be 0),
 *                         bits 3–0 reserved (must be 0).
 *   pubkey (32 bytes)     raw x-only secp256k1 public key.
 *   created_at (4 bytes)  uint32 BE, Unix seconds (anchors the signature, as v1).
 *   expires_at (4 bytes)  uint32 BE, Unix seconds — hard pairing validity edge.
 *   nonce (16 bytes)      random pairing nonce (RD-2).
 *   name_len (1 byte)     UTF-8 byte length of name (1–32; 0 is rejected).
 *   name (name_len bytes) UTF-8 display name.
 *   sig (64 bytes)        signature over a SYNTHETIC, non-zero-kind event
 *                         (kind = CARD_SIG_KIND_V2, content =
 *                         JSON.stringify({v:2,h,exp,nonce,name})) — never a
 *                         publishable kind-0 profile event (RD-4, AC-CODEC-3).
 *
 * The whole buffer is base64url-encoded (RFC 4648 §5, no padding), for both
 * versions.
 *
 * Both versions share one STRICT parser: any header whose version bits are
 * neither 00 nor 01, or whose HAS_AVATAR/reserved bits are non-zero, is
 * rejected rather than tolerated, so a future format cannot be misparsed by
 * an older reader (AC-CARD-3 for v1; AC-CODEC-4 for v2).
 */

import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrToolsEvent, UnsignedEvent } from 'nostr-tools';
import type { EventSigner } from 'applesauce-core';
import { hexToBytes, bytesToHex, npubToPubkeyHex } from '@/src/lib/nostrKeys';

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum UTF-8 byte length of a card's display name (DD 11). */
export const MAX_NAME_BYTES = 32;

/** header(1) + pubkey(32) — the unsigned (pubkey-only) card length. */
const UNSIGNED_CARD_LEN = 1 + 32;

/**
 * Fixed byte overhead of a signed card excluding the name itself:
 * header(1) + pubkey(32) + created_at(4) + name_len(1) + sig(64) = 102.
 */
export const SIGNED_CARD_FIXED_OVERHEAD_BYTES = 1 + 32 + 4 + 1 + 64;

const HEADER_UNSIGNED = 0x00;
/** bit 5 set (0b00100000) — version bits 00, HAS_AVATAR 0, reserved 0000. */
const HEADER_SIGNED = 0x20;

/**
 * bit 5 set + version bits 01 (0b01100000) — a v2 card is always signed
 * (RD-4/DD: pairing requires a name, and hasShareableName already gates
 * every caller of encodeCardV2), HAS_AVATAR 0, reserved 0000.
 */
const HEADER_SIGNED_V2 = 0x60;

/** 4-byte big-endian expires_at field width, v2 only (RD-2). */
const PAIRING_EXPIRES_AT_LEN = 4;
/** 16-byte random pairing nonce field width, v2 only (RD-2). */
const PAIRING_NONCE_LEN = 16;

/**
 * Fixed byte overhead of a v2 signed card excluding the name itself:
 * v1's overhead (102) + expires_at(4) + nonce(16) = 122. The two new fields
 * sit between created_at and name_len per the wire-format doc above.
 * AC-CODEC-6 pins the resulting +20-byte delta at MAX_NAME_BYTES.
 */
export const SIGNED_CARD_FIXED_OVERHEAD_BYTES_V2 =
  SIGNED_CARD_FIXED_OVERHEAD_BYTES + PAIRING_EXPIRES_AT_LEN + PAIRING_NONCE_LEN;

/**
 * The fixed, non-zero synthetic-event kind the v2 card signature is computed
 * over (RD-4). MUST NOT be 0 (AC-CODEC-3), so the exact preimage can never be
 * republished as a well-formed kind-0 profile-metadata event — closing the
 * v1 laundering vector structurally rather than by convention.
 *
 * Confirmed no in-repo collision immediately before landing (2026-07-11):
 * `grep -rn "20602" app/src app/tests` returns zero hits. The nearest
 * neighboring in-repo kind sentinels are CALL_GIFT_WRAP_KIND=21059 and
 * JOIN_REQUEST_KIND=21059 (ephemeral range 20000–29999); 20602 sits well
 * clear of both, and this codec never publishes the synthetic event itself
 * (it exists only as a signature preimage, never sent to a relay).
 */
export const CARD_SIG_KIND_V2 = 20602 as const;

/** The onboarding deep-link page's origin + path (spec.md, DD 9 — fragment-only). */
const CARD_LINK_URL_PREFIX = 'https://few.chat/add#c=';
/** Marker used to locate an embedded card payload inside a card link. */
const CARD_LINK_FRAGMENT_MARKER = '#c=';

// ── base64url (RFC 4648 §5, no padding) — no existing helper, so pure/local ──

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    map[B64URL_ALPHABET[i]] = i;
  }
  return map;
})();

/** Encode raw bytes as a base64url string (RFC 4648 §5), no padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += B64URL_ALPHABET[(chunk >> 18) & 0x3f];
    result += B64URL_ALPHABET[(chunk >> 12) & 0x3f];
    result += B64URL_ALPHABET[(chunk >> 6) & 0x3f];
    result += B64URL_ALPHABET[chunk & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    result += B64URL_ALPHABET[(chunk >> 18) & 0x3f];
    result += B64URL_ALPHABET[(chunk >> 12) & 0x3f];
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += B64URL_ALPHABET[(chunk >> 18) & 0x3f];
    result += B64URL_ALPHABET[(chunk >> 12) & 0x3f];
    result += B64URL_ALPHABET[(chunk >> 6) & 0x3f];
  }
  return result;
}

/**
 * Decode a base64url string (RFC 4648 §5, no padding) to raw bytes.
 * Returns null for any input containing characters outside the base64url
 * alphabet, or a length that cannot represent a whole number of bytes
 * (never throws).
 */
export function base64UrlToBytes(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array(0);
  // A valid unpadded base64 encoding never leaves exactly 6 leftover bits
  // (a single trailing char) — that is not enough to reconstruct a byte.
  if (input.length % 4 === 1) return null;
  for (let i = 0; i < input.length; i++) {
    if (!(input[i] in B64URL_LOOKUP)) return null;
  }
  const byteLength = Math.floor((input.length * 6) / 8);
  const out = new Uint8Array(byteLength);
  let buffer = 0;
  let bitsInBuffer = 0;
  let outIdx = 0;
  for (let i = 0; i < input.length; i++) {
    buffer = (buffer << 6) | B64URL_LOOKUP[input[i]];
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      out[outIdx++] = (buffer >> bitsInBuffer) & 0xff;
    }
  }
  // Canonical-encoding check: any leftover bits after the last full byte must
  // be zero. A non-zero remainder means the input has a non-canonical
  // spelling — a different string that decodes to the same bytes plus
  // garbage padding bits — which would make the decoder non-injective and
  // could let two distinct base64url strings collide on the same payload.
  if (bitsInBuffer > 0 && (buffer & ((1 << bitsInBuffer) - 1)) !== 0) {
    return null;
  }
  return out;
}

// ── Canonical signed content ─────────────────────────────────────────────

/**
 * The ONE canonical signed-content builder, shared by encode and decode.
 * Determinism here is load-bearing (AC-SIG-5): any divergence between the
 * encoder's and decoder's content construction breaks every signature.
 */
export function CARD_CONTENT(name: string): string {
  return JSON.stringify({ name });
}

// ── Name normalization / truncation ──────────────────────────────────────

/**
 * Normalize a name by round-tripping it through UTF-8 encode→decode.
 * TextEncoder always produces well-formed UTF-8, substituting an unpaired
 * surrogate with U+FFFD's UTF-8 bytes; decoding those bytes back yields a
 * string with no unpaired surrogates. Signing over this normalized string
 * (rather than the raw input) keeps encode and decode byte-identical, so an
 * unpaired surrogate is normalized at sign time instead of silently
 * mismatching on import (AC-SIG-5).
 */
function normalizeUtf8RoundTrip(name: string): string {
  const bytes = new TextEncoder().encode(name);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * UTF-8 byte length of a string. Shared pure helper — exported so other
 * stories in the epic (e.g. S3's profile nickname 32-byte cap) can reuse the
 * exact byte-counting rule instead of re-implementing it (a multi-owner risk
 * on the "card-name-byte-cap" concept, per cross-story review).
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, cutting only on a
 * codepoint boundary (never mid-character, never producing a broken
 * multi-byte sequence). Iterating a JS string with `for...of` walks by
 * Unicode codepoint, keeping surrogate pairs (e.g. emoji) intact. Exported
 * for the same cross-story reuse reason as `utf8ByteLength`.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let byteCount = 0;
  let result = '';
  for (const ch of s) {
    const chByteLen = encoder.encode(ch).length;
    if (byteCount + chByteLen > maxBytes) break;
    byteCount += chByteLen;
    result += ch;
  }
  return result;
}

// ── Binary pack helpers ───────────────────────────────────────────────────

function assertPubkeyHex(pubkeyHex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    throw new Error('contactCard: pubkeyHex must be 64 hex characters');
  }
}

/** A pairing nonce is exactly 16 raw bytes, hex-encoded (RD-2). */
function assertNonceHex(nonceHex: string): void {
  if (!/^[0-9a-f]{32}$/i.test(nonceHex)) {
    throw new Error('contactCard: nonceHex must be 32 hex characters (16 bytes)');
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`contactCard: ${label} must be a uint32 Unix-seconds integer`);
  }
}

function packUnsigned(pubkeyHex: string): Uint8Array {
  const buf = new Uint8Array(UNSIGNED_CARD_LEN);
  buf[0] = HEADER_UNSIGNED;
  buf.set(hexToBytes(pubkeyHex), 1);
  return buf;
}

function packSigned(pubkeyHex: string, createdAt: number, name: string, sigHex: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const sigBytes = hexToBytes(sigHex);
  const buf = new Uint8Array(SIGNED_CARD_FIXED_OVERHEAD_BYTES + nameBytes.length);
  let offset = 0;
  buf[offset++] = HEADER_SIGNED;
  buf.set(hexToBytes(pubkeyHex), offset);
  offset += 32;
  buf[offset++] = (createdAt >>> 24) & 0xff;
  buf[offset++] = (createdAt >>> 16) & 0xff;
  buf[offset++] = (createdAt >>> 8) & 0xff;
  buf[offset++] = createdAt & 0xff;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf.set(sigBytes, offset);
  return buf;
}

/**
 * v2 signed-layout packer — identical to `packSigned` except two new fixed
 * fields (`expiresAt` BE uint32, `nonceHex` 16 raw bytes) are spliced in
 * between `createdAt` and `nameLen`, per the v2 wire format doc above.
 */
function packSignedV2(
  pubkeyHex: string,
  createdAt: number,
  expiresAt: number,
  nonceHex: string,
  name: string,
  sigHex: string,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const sigBytes = hexToBytes(sigHex);
  const nonceBytes = hexToBytes(nonceHex);
  const buf = new Uint8Array(SIGNED_CARD_FIXED_OVERHEAD_BYTES_V2 + nameBytes.length);
  let offset = 0;
  buf[offset++] = HEADER_SIGNED_V2;
  buf.set(hexToBytes(pubkeyHex), offset);
  offset += 32;
  buf[offset++] = (createdAt >>> 24) & 0xff;
  buf[offset++] = (createdAt >>> 16) & 0xff;
  buf[offset++] = (createdAt >>> 8) & 0xff;
  buf[offset++] = createdAt & 0xff;
  buf[offset++] = (expiresAt >>> 24) & 0xff;
  buf[offset++] = (expiresAt >>> 16) & 0xff;
  buf[offset++] = (expiresAt >>> 8) & 0xff;
  buf[offset++] = expiresAt & 0xff;
  buf.set(nonceBytes, offset);
  offset += PAIRING_NONCE_LEN;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf.set(sigBytes, offset);
  return buf;
}

/**
 * The ONE canonical v2 signature-preimage builder (RD-4), shared by encode
 * and decode — determinism here is exactly as load-bearing as CARD_CONTENT
 * is for v1 (AC-SIG-5's v2 analogue). `headerByte`/`expiresAt`/`nonceHex`
 * are folded into `content` (not just the event envelope) so mutating any
 * one of them after signing is detectable without needing a bespoke
 * per-field MAC — a single verifyEvent call covers all of them at once.
 */
function buildV2SigPreimageEvent(params: {
  pubkeyHex: string;
  createdAt: number;
  headerByte: number;
  expiresAt: number;
  nonceHex: string;
  name: string;
}): UnsignedEvent {
  return {
    pubkey: params.pubkeyHex,
    created_at: params.createdAt,
    kind: CARD_SIG_KIND_V2,
    tags: [],
    content: JSON.stringify({
      v: 2,
      h: params.headerByte,
      exp: params.expiresAt,
      nonce: params.nonceHex,
      name: params.name,
    }),
  };
}

// ── encodeCard ─────────────────────────────────────────────────────────────

/**
 * Build and sign a contact card for `pubkeyHex`, returning the base64url
 * payload.
 *
 * If `nickname` is empty, emits an UNSIGNED (pubkey-only) card — equivalent
 * to sharing a bare npub (AC-CARD-6, DD 10). Otherwise the name is
 * normalized (UTF-8 round trip, so an unpaired surrogate cannot silently
 * mismatch the signature) and truncated to `MAX_NAME_BYTES` on a codepoint
 * boundary (AC-CARD-5) before being signed as a NIP-01 kind-0 event via the
 * supplied `signEvent` — the same `EventSigner.signEvent` shape used by
 * `createPrivateKeySigner` / NIP-46 / NIP-07 adapters
 * (`app/src/lib/marmot/signerAdapter.ts`), so this works in every signer
 * mode.
 */
export async function encodeCard(
  pubkeyHex: string,
  profile: { nickname: string; createdAt: number },
  signEvent: EventSigner['signEvent'],
): Promise<string> {
  assertPubkeyHex(pubkeyHex);
  // Normalize to lowercase so the packed bytes and the post-sign equality
  // check below agree in case — nostr-tools always returns a lowercase
  // `pubkey`, but assertPubkeyHex accepts either case.
  pubkeyHex = pubkeyHex.toLowerCase();

  if (
    !Number.isInteger(profile.createdAt) ||
    profile.createdAt < 0 ||
    profile.createdAt > 0xffffffff
  ) {
    throw new Error('contactCard: createdAt must be a uint32 Unix-seconds integer');
  }

  const normalized = normalizeUtf8RoundTrip(profile.nickname);
  if (normalized.length === 0) {
    return bytesToBase64Url(packUnsigned(pubkeyHex));
  }

  const name = truncateUtf8(normalized, MAX_NAME_BYTES);
  const draft = {
    kind: 0,
    created_at: profile.createdAt,
    tags: [] as string[][],
    content: CARD_CONTENT(name),
  };
  const signed = await signEvent(draft);
  if (signed.pubkey !== pubkeyHex) {
    throw new Error('contactCard: signer pubkey does not match the supplied pubkeyHex');
  }
  // Pack the SIGNED created_at (what the signature actually covers), not the
  // input value — they are equal only by convention, and a signer that
  // overrides created_at would otherwise make the packed field diverge from
  // what verifyEvent checks, failing every fresh card's own decodeCard.
  return bytesToBase64Url(packSigned(pubkeyHex, signed.created_at, name, signed.sig));
}

/** Build the shareable onboarding URL for a card payload (DD 9 — hash fragment, never sent to the server). */
export function buildShareUrl(payload: string): string {
  return `${CARD_LINK_URL_PREFIX}${payload}`;
}

// ── encodeCardV2 — pairing card (nonce + expiry, RD-4 signature) ───────────

/**
 * The `EncodedCardV2` seam contract (specs/epic-contact-pairing-code/
 * stories.json) — consumed cross-story by S2's `shareCard.ts#getOwnShareCard`.
 */
export type EncodedCardV2 = {
  pubkeyHex: string;
  name: string;
  nonceHex: string;
  expiresAt: number;
  cardB64Url: string;
};

/**
 * Build and sign a v2 pairing card: identity (as `encodeCard`) plus an
 * issuer-minted `nonceHex`/`expiresAt` (RD-2 — minted and persisted by the
 * caller's nonce-lifecycle module, not this pure codec). Always produces a
 * SIGNED card — a v2 card without a name serves no pairing purpose, and
 * every real caller already gates on `hasShareableName` before reaching
 * here, so an empty nickname is treated as a caller bug, not a silent
 * unsigned fallback (unlike v1's `encodeCard`).
 *
 * The signature is computed over a synthetic, non-zero-kind event (RD-4,
 * `buildV2SigPreimageEvent`) rather than a publishable kind-0 profile event,
 * so the exact preimage can never be laundered onto a public relay
 * (AC-CODEC-3). It binds header byte + created_at + pubkey + expiresAt +
 * nonceHex + name — mutating any one of them after signing is detectable
 * (AC-CODEC-2).
 */
export async function encodeCardV2(
  pubkeyHex: string,
  profile: { nickname: string; createdAt: number },
  nonceHex: string,
  expiresAt: number,
  signEvent: EventSigner['signEvent'],
): Promise<EncodedCardV2> {
  assertPubkeyHex(pubkeyHex);
  // Normalize to lowercase so packed bytes, the preimage, and the post-sign
  // equality check below all agree in case (mirrors encodeCard).
  pubkeyHex = pubkeyHex.toLowerCase();
  assertNonceHex(nonceHex);
  nonceHex = nonceHex.toLowerCase();
  assertUint32(expiresAt, 'expiresAt');
  assertUint32(profile.createdAt, 'createdAt');

  const normalized = normalizeUtf8RoundTrip(profile.nickname);
  const name = truncateUtf8(normalized, MAX_NAME_BYTES);
  if (name.length === 0) {
    throw new Error('contactCard: encodeCardV2 requires a non-empty nickname (a pairing card is always signed)');
  }

  const draft = buildV2SigPreimageEvent({
    pubkeyHex,
    createdAt: profile.createdAt,
    headerByte: HEADER_SIGNED_V2,
    expiresAt,
    nonceHex,
    name,
  });
  const signed = await signEvent(draft);
  if (signed.pubkey !== pubkeyHex) {
    throw new Error('contactCard: signer pubkey does not match the supplied pubkeyHex');
  }
  // Pack the SIGNED created_at (what the signature actually covers), not the
  // input value, for the same reason encodeCard does (see its comment).
  const cardB64Url = bytesToBase64Url(
    packSignedV2(pubkeyHex, signed.created_at, expiresAt, nonceHex, name, signed.sig),
  );
  return { pubkeyHex, name, nonceHex, expiresAt, cardB64Url };
}

// ── decodeCard ─────────────────────────────────────────────────────────────

export type DecodedCard = {
  version: 0 | 1;
  pubkeyHex: string;
  profile?: { nickname: string; createdAt: number };
  /** Present iff `version === 1` (a v2 card) — AC-CODEC-1. */
  pairing?: { nonce: string; expiresAt: number };
};

export type DecodeCardResult = DecodedCard | { error: string };

/**
 * Review-remediation (epic: contact-pairing-code, story S5, sev 3 best-
 * practices finding): the single source of truth for the "unrecognized
 * header version" error string `decodeCard` returns below (AC-CODEC-4).
 * Exported so `processContactInput.ts`'s AC-UI-3 friendly-copy mapping can
 * import and compare against this constant instead of duplicating the
 * literal — a reworded message here can never silently desync the two.
 * Additive-only: the string value itself is unchanged from S1's original.
 */
export const UNSUPPORTED_VERSION_ERROR = 'contactCard: unsupported version';

/**
 * Strictly parse and (for signed cards) verify a base64url card payload.
 * Never throws — any malformed or adversarial input yields `{ error }`
 * (VQ-S1-006).
 */
export function decodeCard(b64url: string): DecodeCardResult {
  try {
    const bytes = base64UrlToBytes(b64url);
    if (!bytes) return { error: 'contactCard: not a valid base64url payload' };
    if (bytes.length < UNSIGNED_CARD_LEN) return { error: 'contactCard: payload too short' };

    const header = bytes[0];
    const version = (header >> 6) & 0x03;
    // AC-CODEC-4: only 00 (v1) and 01 (v2) are recognized; 10/11 are hard
    // parse failures, not a best-effort partial decode — this is the ONE
    // strict-parser gate both versions share (see file header doc).
    if (version !== 0 && version !== 1) return { error: UNSUPPORTED_VERSION_ERROR };
    const hasAvatar = (header >> 4) & 0x01;
    if (hasAvatar !== 0) return { error: 'contactCard: HAS_AVATAR is reserved and must be unset' };
    const reserved = header & 0x0f;
    if (reserved !== 0) return { error: 'contactCard: reserved header bits must be unset' };
    const signed = ((header >> 5) & 0x01) === 1;

    const pubkeyHex = bytesToHex(bytes.slice(1, UNSIGNED_CARD_LEN));

    if (!signed) {
      // A v2 card is ALWAYS signed (spec §"Card format v2": header bit 5 SIGNED
      // = 1 for v2). A version-01 header with the SIGNED bit clear is therefore
      // a malformed v2 card — reject it under the strict-parser discipline
      // (AC-CODEC-4) rather than silently accepting it as a bare-pubkey
      // one-directional add. Only the v1 (version 00) unsigned layout is valid.
      if (version === 1) {
        return { error: 'contactCard: v2 card must be signed (SIGNED bit unset)' };
      }
      // v1 unsigned layout: header + bare pubkey, no version-specific fields.
      if (bytes.length !== UNSIGNED_CARD_LEN) {
        return { error: 'contactCard: unsigned payload has unexpected trailing bytes' };
      }
      return { version: version as 0 | 1, pubkeyHex };
    }

    const HEADER_LEN = 1;
    const PUBKEY_LEN = 32;
    const CREATED_AT_LEN = 4;
    const NAME_LEN_LEN = 1;
    const SIG_LEN = 64;
    // v2 splices expires_at(4) + nonce(16) between created_at and name_len.
    const v2ExtraLen = version === 1 ? PAIRING_EXPIRES_AT_LEN + PAIRING_NONCE_LEN : 0;
    const minSignedLen = HEADER_LEN + PUBKEY_LEN + CREATED_AT_LEN + v2ExtraLen + NAME_LEN_LEN;
    if (bytes.length < minSignedLen) {
      return { error: 'contactCard: signed payload truncated before name_len' };
    }

    let offset = HEADER_LEN + PUBKEY_LEN;
    const createdAt =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    offset += CREATED_AT_LEN;

    let expiresAt = 0;
    let nonceHex = '';
    if (version === 1) {
      expiresAt =
        ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      offset += PAIRING_EXPIRES_AT_LEN;
      nonceHex = bytesToHex(bytes.slice(offset, offset + PAIRING_NONCE_LEN));
      offset += PAIRING_NONCE_LEN;
    }

    const nameLen = bytes[offset];
    offset += NAME_LEN_LEN;

    if (nameLen > MAX_NAME_BYTES) return { error: 'contactCard: name_len exceeds the 32-byte cap' };
    // Neither encoder emits a signed empty-name card (encodeCard takes the
    // unsigned path for an empty nickname; encodeCardV2 throws on one). Accepting
    // it would let a self-signed, newer-created_at card blank a cached nickname
    // via LWW — reject it as malformed to keep encoder and decoder symmetric.
    if (nameLen === 0) return { error: 'contactCard: signed card must carry a non-empty name' };

    const expectedLen = HEADER_LEN + PUBKEY_LEN + CREATED_AT_LEN + v2ExtraLen + NAME_LEN_LEN + nameLen + SIG_LEN;
    if (bytes.length !== expectedLen) {
      return { error: 'contactCard: payload length inconsistent with name_len' };
    }

    const nameBytes = bytes.slice(offset, offset + nameLen);
    offset += nameLen;
    const sigBytes = bytes.slice(offset, offset + SIG_LEN);
    const sigHex = bytesToHex(sigBytes);

    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      return { error: 'contactCard: name is not valid UTF-8' };
    }

    // AC-SIG-6 / VQ-S1-006: verifyEvent rejects any event without a matching
    // `id`, so the computed hash MUST be attached before calling it — an
    // id-less reconstruction would fail closed for every card, valid or not.
    const unsignedEvent: UnsignedEvent =
      version === 1
        ? buildV2SigPreimageEvent({ pubkeyHex, createdAt, headerByte: header, expiresAt, nonceHex, name })
        : { pubkey: pubkeyHex, created_at: createdAt, kind: 0, tags: [], content: CARD_CONTENT(name) };
    const id = getEventHash(unsignedEvent);
    const fullEvent = { ...unsignedEvent, id, sig: sigHex } as NostrToolsEvent;

    let verified = false;
    try {
      verified = verifyEvent(fullEvent);
    } catch {
      verified = false;
    }
    if (!verified) return { error: 'contactCard: signature verification failed' };

    if (version === 1) {
      return { version: 1, pubkeyHex, profile: { nickname: name, createdAt }, pairing: { nonce: nonceHex, expiresAt } };
    }
    return { version: 0, pubkeyHex, profile: { nickname: name, createdAt } };
  } catch {
    return { error: 'contactCard: malformed payload' };
  }
}

// ── parseContactCard — the single decode seam ────────────────────────────

export type ParseContactCardResult =
  | { pubkeyHex: string }
  | { pubkeyHex: string; profile: { nickname: string; updatedAt: string } }
  | {
      pubkeyHex: string;
      profile: { nickname: string; updatedAt: string };
      /**
       * The `ParsedPairingCard` seam's nonce-bearing shape (specs/epic-
       * contact-pairing-code/stories.json) — present iff the decoded card is
       * v2 (AC-CODEC-1). Consumed cross-story by S4's
       * `processContactInput.ts` to decide whether to echo a pairing-ack.
       */
      pairing: { nonce: string; expiresAt: number };
    }
  | { error: string };

/**
 * The single canonical decoder every npub entry point routes through
 * (architecture.md DD 1). Accepts a bare npub, a card link
 * (`https://few.chat/add#c=<b64url>`), or a raw base64url card payload.
 * Never throws (AC-PARSE-5).
 *
 * A v1 card or bare npub/`nostr:` URI never carries a `pairing` field
 * (AC-CODEC-5) — this routes to the pre-existing one-directional add, byte-
 * identical to today's behavior.
 */
export function parseContactCard(input: string): ParseContactCardResult {
  try {
    if (typeof input !== 'string') return { error: 'contactCard: input must be a string' };
    const rawTrimmed = input.trim();
    if (rawTrimmed.length === 0) return { error: 'contactCard: empty input' };

    // A NIP-21 `nostr:` URI is a legitimate way to express an npub — other
    // clients copy npubs in this form. Strip an optional scheme prefix so the
    // npub branch below recognises `nostr:npub1…`. normaliseScanPayload already
    // strips this for the scan path; doing it here at the single decode seam
    // also covers the paste path at every caller (AddContactModal, invite,
    // /add page) without each re-implementing the strip. A card link
    // (https://few.chat/add#c=…) or raw base64url payload never carries this
    // prefix, so the strip is a no-op for the card branch.
    const trimmed = rawTrimmed.toLowerCase().startsWith('nostr:')
      ? rawTrimmed.slice('nostr:'.length).trim()
      : rawTrimmed;
    if (trimmed.length === 0) return { error: 'contactCard: empty input' };

    // bech32 is case-insensitive (all-upper or all-lower, never mixed), and
    // QR alphanumeric mode commonly encodes an uppercase NPUB1…; detect the
    // npub branch case-insensitively so an uppercase npub is not misrouted
    // into the card decoder. npubToPubkeyHex/nip19.decode accept either case.
    if (trimmed.toLowerCase().startsWith('npub1')) {
      const pubkeyHex = npubToPubkeyHex(trimmed);
      if (!pubkeyHex) return { error: 'contactCard: invalid npub' };
      return { pubkeyHex };
    }

    let payload = trimmed;
    const markerIdx = trimmed.indexOf(CARD_LINK_FRAGMENT_MARKER);
    if (markerIdx !== -1) {
      payload = trimmed.slice(markerIdx + CARD_LINK_FRAGMENT_MARKER.length);
    }
    if (payload.length === 0) return { error: 'contactCard: empty card payload' };

    const decoded = decodeCard(payload);
    if ('error' in decoded) return { error: decoded.error };

    if (!decoded.profile) {
      return { pubkeyHex: decoded.pubkeyHex };
    }

    const profile = {
      nickname: decoded.profile.nickname,
      updatedAt: new Date(decoded.profile.createdAt * 1000).toISOString(),
    };

    if (decoded.pairing) {
      return { pubkeyHex: decoded.pubkeyHex, profile, pairing: decoded.pairing };
    }

    return { pubkeyHex: decoded.pubkeyHex, profile };
  } catch {
    return { error: 'contactCard: unparseable input' };
  }
}
