import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import {
  CARD_CONTENT,
  encodeCard,
  encodeCardV2,
  decodeCard,
  bytesToBase64Url,
  base64UrlToBytes,
} from '@/src/lib/contactCard';

/** A deterministic, valid 16-byte pairing nonce (32 hex chars). */
function makeNonceHex(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytesToHex(bytes);
}

/**
 * Gap-closing tests derived from the contact-card-exchange pre-ship mutation
 * gate (base:mutation-testing). The existing suite asserts every *rejection*
 * boundary for `createdAt` (negative, fractional, > uint32, NaN via
 * `.rejects.toThrow(/createdAt/)`) but never asserts that the two *accepted*
 * endpoints of the valid uint32 range actually encode. That left two boundary
 * mutants alive:
 *
 *   - `createdAt < 0`  → `createdAt <= 0`      (rejects the valid value 0)
 *   - `createdAt > 0xffffffff` → `>= 0xffffffff` (rejects the valid max 0xffffffff)
 *
 * Both are real gaps: a mutant that wrongly rejects a *valid* card at the
 * boundary ships green. These lock the inclusive [0, 0xffffffff] accept range
 * by round-tripping each endpoint.
 */

function makeIdentity() {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  return { skHex, pubkeyHex, signer };
}

describe('encodeCard — createdAt accepts the inclusive uint32 boundary (mutation gate)', () => {
  it.each([
    ['the low endpoint (0, the Unix epoch)', 0],
    ['the high endpoint (0xffffffff, max uint32)', 0xffffffff],
  ])('accepts and round-trips createdAt at %s', async (_label, createdAt) => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await encodeCard(pubkeyHex, { nickname: 'Alice', createdAt }, signer.signEvent);
    const decoded = decodeCard(payload);
    expect('error' in decoded).toBe(false);
    if ('error' in decoded) throw new Error('unreachable');
    expect(decoded.profile).toBeDefined();
    expect(decoded.profile!.createdAt).toBe(createdAt);
  });
});

/**
 * base64url is the on-the-wire spelling of every card. The decoder is the
 * codec's trust boundary: it MUST be injective (no two distinct strings decode
 * to the same bytes) and MUST reject non-canonical spellings — otherwise a
 * card link could be minted in multiple equivalent forms, or a decoder could
 * accept trailing garbage. The existing suite round-trips real cards but never
 * pins the decoder's behaviour on adversarial raw strings, leaving the length
 * guard and the canonical-remainder guard alive.
 */
describe('base64url codec — round-trip + canonical/injective decoding (mutation gate)', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 33, 100])(
    'round-trips an arbitrary %i-byte buffer through encode → decode unchanged',
    (len) => {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 53 + 11) % 256;
      const decoded = base64UrlToBytes(bytesToBase64Url(bytes));
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded!)).toEqual(Array.from(bytes));
    },
  );

  it('decodes the empty string to an empty byte array (not null)', () => {
    const out = base64UrlToBytes('');
    expect(out).not.toBeNull();
    expect(out!.length).toBe(0);
  });

  it.each([
    ['a single trailing char', 'A'],
    ['5 chars (length % 4 === 1)', 'AAAAA'],
    ['9 chars (length % 4 === 1)', 'A'.repeat(9)],
  ])('rejects a string whose length %% 4 === 1 as un-decodable (%s)', (_label, s) => {
    // A base64 group never leaves exactly 6 leftover bits — a single trailing
    // char cannot reconstruct a byte, so such a string is not a valid encoding.
    expect(base64UrlToBytes(s)).toBeNull();
  });

  it('accepts a canonically-encoded value (zero trailing bits) as valid, not null', () => {
    // 'AA' encodes the single byte 0x00: two 6-bit groups, the low 4 bits of
    // the second group are zero — a canonical 1-byte encoding.
    const out = base64UrlToBytes('AA');
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([0]);
  });

  it('rejects a non-canonically-encoded string whose final char carries non-zero low bits', () => {
    // 'AB' would decode byte 0x00 but leaves non-zero leftover bits (B = 1):
    // a non-canonical spelling of the same 1-byte payload. Accepting it would
    // make the decoder non-injective (two strings → same bytes).
    expect(base64UrlToBytes('AB')).toBeNull();
  });
});

/**
 * encodeCardV2 mints the pairing card. Its input validators (pubkey shape,
 * nonce shape, uint32 range on expiresAt) and its post-sign pubkey-identity
 * check are the codec's guardrails. The v1 path (encodeCard) already asserts
 * most of these; v2 inherited the code but not the test coverage, leaving the
 * uint32 boundary math, the validator bodies, and the signer-identity check
 * alive under mutation.
 */
describe('encodeCardV2 — input validators + signer-identity guard (mutation gate)', () => {
  const validNonce = makeNonceHex();

  it.each([
    ['the low endpoint (0, the Unix epoch)', 0],
    ['the high endpoint (0xffffffff, max uint32)', 0xffffffff],
  ])('accepts and round-trips expiresAt at %s', async (_label, expiresAt) => {
    const { pubkeyHex, signer } = makeIdentity();
    const encoded = await encodeCardV2(
      pubkeyHex,
      { nickname: 'Alice', createdAt: 1000 },
      validNonce,
      expiresAt,
      signer.signEvent,
    );
    const decoded = decodeCard(encoded.cardB64Url);
    expect('error' in decoded).toBe(false);
    if ('error' in decoded) throw new Error('unreachable');
    expect(decoded.pairing).toBeDefined();
    expect(decoded.pairing!.expiresAt).toBe(expiresAt);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['greater than max uint32', 0x100000000],
  ])('rejects an out-of-range expiresAt (%s)', async (_label, expiresAt) => {
    const { pubkeyHex, signer } = makeIdentity();
    await expect(
      encodeCardV2(pubkeyHex, { nickname: 'Alice', createdAt: 1000 }, validNonce, expiresAt, signer.signEvent),
    ).rejects.toThrow(/expiresAt/);
  });

  it.each([
    ['too short (63 hex)', 'a'.repeat(63)],
    ['too long (65 hex)', 'a'.repeat(65)],
    ['non-hex', 'z'.repeat(64)],
  ])('rejects a malformed pubkeyHex (%s)', async (_label, pubkeyHex) => {
    const { signer } = makeIdentity();
    await expect(
      encodeCardV2(pubkeyHex, { nickname: 'Alice', createdAt: 1000 }, validNonce, 2000, signer.signEvent),
    ).rejects.toThrow(/pubkeyHex/);
  });

  it.each([
    ['too short (31 hex)', 'a'.repeat(31)],
    ['too long (33 hex)', 'a'.repeat(33)],
    ['non-hex', 'z'.repeat(32)],
  ])('rejects a malformed nonceHex (%s)', async (_label, nonceHex) => {
    const { pubkeyHex, signer } = makeIdentity();
    await expect(
      encodeCardV2(pubkeyHex, { nickname: 'Alice', createdAt: 1000 }, nonceHex, 2000, signer.signEvent),
    ).rejects.toThrow(/nonceHex/);
  });

  it('rejects a signer whose returned pubkey differs from the supplied pubkeyHex', async () => {
    // Claim identity A's pubkey but sign with identity B's key — the post-sign
    // identity check must reject rather than mint a card that fails its own
    // decodeCard. (encodeCard has this guard tested; encodeCardV2 did not.)
    const a = makeIdentity();
    const b = makeIdentity();
    await expect(
      encodeCardV2(a.pubkeyHex, { nickname: 'Alice', createdAt: 1000 }, validNonce, 2000, b.signer.signEvent),
    ).rejects.toThrow(/pubkey/);
  });
});

// ── decodeCard structural gates hit by a VALIDLY-signed card (mutation gate,
// small-ui-count-bugs run). Earlier rejection tests only used cards whose
// signature failed anyway, so removing the name-cap check or the strict UTF-8
// decode survived: the signature check rejected them for an unrelated reason.
// These cards carry a genuine signature over exactly what the decoder would
// reconstruct, so only the structural gate under test can reject them.

describe('decodeCard — structural gates on validly-signed cards (mutation gate)', () => {
  function signedV1Card(nameBytes: Uint8Array, signedName: string): string {
    const sk = generateSecretKey();
    const pubkeyHex = getPublicKey(sk);
    const createdAt = 1735689600;
    const ev = finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content: CARD_CONTENT(signedName) }, sk);
    const buf = new Uint8Array(1 + 32 + 4 + 1 + nameBytes.length + 64);
    buf[0] = 0x20;
    buf.set(hexToBytes(pubkeyHex), 1);
    buf.set([(createdAt >>> 24) & 0xff, (createdAt >>> 16) & 0xff, (createdAt >>> 8) & 0xff, createdAt & 0xff], 33);
    buf[37] = nameBytes.length;
    buf.set(nameBytes, 38);
    buf.set(hexToBytes(ev.sig), 38 + nameBytes.length);
    return bytesToBase64Url(buf);
  }

  it('rejects a signed 33-byte name (over the 32-byte cap) even though its signature verifies', () => {
    const name = 'n'.repeat(33);
    expect(decodeCard(signedV1Card(new TextEncoder().encode(name), name))).toEqual({
      error: 'contactCard: name_len exceeds the 32-byte cap',
    });
  });

  it('rejects invalid UTF-8 name bytes even when the signature covers their lossy decoding', () => {
    // 0xff is never valid UTF-8; a lossy decoder would read it as U+FFFD.
    expect(decodeCard(signedV1Card(Uint8Array.of(0xff), '�'))).toEqual({
      error: 'contactCard: name is not valid UTF-8',
    });
  });
});
