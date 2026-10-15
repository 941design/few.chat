/**
 * decodeCard rejects a SIGNED card whose name_len is 0 (BACKLOG:
 * decodecard-accepts-signed-name-len-0).
 *
 * Neither encoder ever emits that shape: `encodeCard` takes the unsigned
 * (pubkey-only) path for an empty nickname, and `encodeCardV2` throws on one.
 * Accepting it on decode opened an LWW empty-name clobber path (a validly
 * self-signed empty-name card with a newer created_at would blank a cached
 * nickname). The decoder now rejects it as malformed, restoring
 * encoder/decoder symmetry — and every card the encoders DO produce must still
 * round-trip (property below — a hand-rolled seeded sweep; this repo has no
 * fast-check).
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import {
  CARD_CONTENT,
  MAX_NAME_BYTES,
  bytesToBase64Url,
  decodeCard,
  encodeCard,
  encodeCardV2,
  truncateUtf8,
} from '@/src/lib/contactCard';

const CREATED_AT = 1735689600;
const EXPIRES_AT = CREATED_AT + 1800;
const NONCE_HEX = '0123456789abcdef0123456789abcdef';

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

describe('decodeCard: signed name_len=0 is malformed', () => {
  it('rejects a v1 signed empty-name card even though its signature verifies', () => {
    const sk = generateSecretKey();
    const pubkeyHex = getPublicKey(sk);
    // A genuinely valid signature over the v1 preimage for name "".
    const signed = finalizeEvent({ kind: 0, created_at: CREATED_AT, tags: [], content: CARD_CONTENT('') }, sk);
    expect(verifyEvent(signed)).toBe(true);

    const buf = new Uint8Array(1 + 32 + 4 + 1 + 64);
    buf[0] = 0x20; // v1, SIGNED
    buf.set(hexBytes(pubkeyHex), 1);
    buf[33] = (CREATED_AT >>> 24) & 0xff;
    buf[34] = (CREATED_AT >>> 16) & 0xff;
    buf[35] = (CREATED_AT >>> 8) & 0xff;
    buf[36] = CREATED_AT & 0xff;
    buf[37] = 0; // name_len = 0
    buf.set(hexBytes(signed.sig), 38);

    const decoded = decodeCard(bytesToBase64Url(buf));
    expect(decoded).toEqual({ error: 'contactCard: signed card must carry a non-empty name' });
  });

  it('rejects a v2 signed empty-name card with the same malformed-name error', () => {
    const pubkeyHex = getPublicKey(generateSecretKey());
    const buf = new Uint8Array(1 + 32 + 4 + 4 + 16 + 1 + 64);
    buf[0] = 0x60; // v2, SIGNED
    buf.set(hexBytes(pubkeyHex), 1);
    buf[57] = 0; // name_len = 0 (offset: 1+32+4+4+16)
    const decoded = decodeCard(bytesToBase64Url(buf));
    expect(decoded).toEqual({ error: 'contactCard: signed card must carry a non-empty name' });
  });
});

/** Deterministic PRNG (mulberry32) so a failing sweep case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random UTF-16 strings mixing ASCII, multi-byte BMP, astral (surrogate-pair)
 * and lone-surrogate code units, 0..40 units long — covers the empty,
 * normalize-to-U+FFFD and truncate-at-32-bytes boundaries.
 */
function randomNicknames(seed: number, count: number): string[] {
  const next = rng(seed);
  const pools: Array<() => string> = [
    () => String.fromCharCode(0x20 + Math.floor(next() * 0x5f)),
    () => String.fromCharCode(0xa0 + Math.floor(next() * 0x700)),
    () => String.fromCodePoint(0x1f300 + Math.floor(next() * 0x200)),
    () => String.fromCharCode(0xd800 + Math.floor(next() * 0x800)),
  ];
  const out: string[] = ['', ' ', 'a', '\uD800', 'x'.repeat(40), '\u00e9'.repeat(20)];
  while (out.length < count) {
    const len = Math.floor(next() * 41);
    let s = '';
    for (let i = 0; i < len; i++) s += pools[Math.floor(next() * pools.length)]();
    out.push(s);
  }
  return out;
}

describe('encoder/decoder symmetry (property)', () => {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  const normalize = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s));

  it('every v1 card encodeCard produces decodes without error, carrying the encoded name', async () => {
    for (const nickname of randomNicknames(0xc0ffee, 60)) {
      const payload = await encodeCard(pubkeyHex, { nickname, createdAt: CREATED_AT }, signer.signEvent);
      const decoded = decodeCard(payload);
      expect(decoded, JSON.stringify(nickname)).not.toHaveProperty('error');
      if ('error' in decoded) continue;
      const expected = truncateUtf8(normalize(nickname), MAX_NAME_BYTES);
      if (expected.length === 0) {
        expect(decoded.profile).toBeUndefined();
      } else {
        expect(decoded.profile?.nickname).toBe(expected);
      }
    }
  });

  it('every v2 card encodeCardV2 produces decodes without error, carrying the encoded name', async () => {
    const names = randomNicknames(0xbeef, 50).filter((s) => normalize(s).length > 0);
    for (const nickname of names) {
      const { cardB64Url } = await encodeCardV2(
        pubkeyHex,
        { nickname, createdAt: CREATED_AT },
        NONCE_HEX,
        EXPIRES_AT,
        signer.signEvent,
      );
      const decoded = decodeCard(cardB64Url);
      expect(decoded, JSON.stringify(nickname)).not.toHaveProperty('error');
      if ('error' in decoded) continue;
      expect(decoded.profile?.nickname).toBe(truncateUtf8(normalize(nickname), MAX_NAME_BYTES));
    }
  });
});
