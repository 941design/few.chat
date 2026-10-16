/**
 * Unit tests for sealAndWrap and unwrapAndOpen — the NIP-59 gift-wrap helpers.
 * These tests run the real nostr-tools/nip59 crypto (no mocking of the crypto
 * primitives) to verify: round-trip fidelity, outer event shape, wrong-key
 * rejection, and created_at timing bounds.
 *
 * Round-3 additions (forgery rejection):
 *   - Forged-rumor-pubkey rejection: Mallory wraps a rumor claiming Alice's pubkey.
 *   - Tampered seal signature rejection: mutated sig causes verifyEvent failure.
 *   - Non-1059 input rejection: kind-4 or kind-13 fed directly.
 *
 * crypto.subtle polyfill: nostr-tools/nip59 uses @noble/curves (pure JS
 * Schnorr / elliptic) and @noble/hashes which do NOT require crypto.subtle.
 * The polyfill below is included to cover any nip44 path that might reach it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// We must import via dynamic import AFTER the polyfill is in place.
import type { UnsignedRumor } from '@/src/lib/directMessages';
const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');
const { nip44 } = await import('nostr-tools');
const { createRumor, createSeal, createWrap } = await import('nostr-tools/nip59');
const {
  sealAndWrap,
  unwrapAndOpen,
  GIFT_WRAP_KIND,
  CHAT_MESSAGE_KIND,
} = await import('@/src/lib/directMessages');

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Deterministic test keypairs
const senderPrivBytes = generateSecretKey();
const recipientPrivBytes = generateSecretKey();
const senderPub = getPublicKey(senderPrivBytes);
const recipientPub = getPublicKey(recipientPrivBytes);
const senderPrivHex = bytesToHex(senderPrivBytes);
const recipientPrivHex = bytesToHex(recipientPrivBytes);

const twodays = 2 * 24 * 60 * 60;

function makeRumor(overrides?: Partial<UnsignedRumor>): UnsignedRumor {
  return {
    kind: CHAT_MESSAGE_KIND,
    content: '{"type":"text","text":"Hello NIP-17!"}',
    tags: [['p', recipientPub]],
    pubkey: senderPub,
    created_at: Math.floor(Date.now() / 1000),
    id: 'a'.repeat(64), // placeholder; sealAndWrap re-derives the id via wrapEvent→createRumor
    ...overrides,
  };
}

describe('sealAndWrap', () => {
  it('produces a kind-1059 gift wrap', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    expect(wrap.kind).toBe(GIFT_WRAP_KIND);
    expect(wrap.kind).toBe(1059);
  });

  it('outer event has a ["p", recipientPubkey] tag', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    const pTag = (wrap.tags as string[][]).find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(recipientPub);
  });

  it('outer event has a valid id and sig (fully signed)', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    expect(typeof wrap.id).toBe('string');
    expect(wrap.id).toHaveLength(64);
    expect(typeof wrap.sig).toBe('string');
    expect((wrap as any).sig).toHaveLength(128);
  });

  it('created_at on the outer wrap is within [now-2days-buffer, now+buffer]', async () => {
    const before = Math.floor(Date.now() / 1000);
    const results: number[] = [];

    // Sample several wraps to test the randomisation window
    for (let i = 0; i < 5; i++) {
      const wrap = await sealAndWrap(makeRumor(), recipientPub, senderPrivHex);
      results.push(wrap.created_at as number);
    }

    for (const ts of results) {
      // Lower bound: now-2days minus a small buffer for test overhead
      expect(ts).toBeGreaterThanOrEqual(before - twodays - 60);
      // Upper bound: now plus a small buffer
      expect(ts).toBeLessThanOrEqual(before + 60);
    }
  });

  it('each wrap uses a different outer pubkey (ephemeral key per wrap)', async () => {
    const rumor = makeRumor();
    const wrap1 = await sealAndWrap(rumor, recipientPub, senderPrivHex);
    const wrap2 = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    // The outer wraps use fresh ephemeral keys, so their pubkeys should differ
    // (unless cryptographically improbable collision).
    expect(wrap1.pubkey).not.toBe(wrap2.pubkey);
  });
});

describe('unwrapAndOpen', () => {
  it('round-trip: recovered rumor has same kind, content, and tags as input', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);
    const recovered = await unwrapAndOpen(wrap, recipientPrivHex);

    expect(recovered.kind).toBe(rumor.kind);
    expect(recovered.content).toBe(rumor.content);
    // tags may have been reconstructed by wrapEvent — check the ['p', recipientPub] tag
    const pTag = recovered.tags.find((t: string[]) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(recipientPub);
  });

  it('recovered rumor has a valid 64-char hex id', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);
    const recovered = await unwrapAndOpen(wrap, recipientPrivHex);

    expect(recovered.id).toHaveLength(64);
    expect(recovered.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recovered rumor has the sender pubkey (not the ephemeral outer pubkey)', async () => {
    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);
    const recovered = await unwrapAndOpen(wrap, recipientPrivHex);

    expect(recovered.pubkey).toBe(senderPub);
    // Must NOT be the outer wrap's ephemeral pubkey
    expect(recovered.pubkey).not.toBe(wrap.pubkey);
  });

  it('throws when the wrong recipient private key is used', async () => {
    const wrongPrivBytes = generateSecretKey();
    const wrongPrivHex = bytesToHex(wrongPrivBytes);

    const rumor = makeRumor();
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    await expect(unwrapAndOpen(wrap, wrongPrivHex)).rejects.toThrow('gift wrap decryption failed');
  });

  it('error message does not leak plaintext content', async () => {
    const wrongPrivBytes = generateSecretKey();
    const wrongPrivHex = bytesToHex(wrongPrivBytes);
    const rumor = makeRumor({ content: 'SECRET_PAYLOAD_DO_NOT_LEAK' });
    const wrap = await sealAndWrap(rumor, recipientPub, senderPrivHex);

    try {
      await unwrapAndOpen(wrap, wrongPrivHex);
      throw new Error('Expected rejection');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('SECRET_PAYLOAD_DO_NOT_LEAK');
      expect(msg).toBe('gift wrap decryption failed');
    }
  });
});

// ---------------------------------------------------------------------------
// Round-3: Forgery rejection tests
// These tests confirm that the manual unwrap path enforces the missing
// authentication steps omitted by the nostr-tools unwrapEvent helper.
// ---------------------------------------------------------------------------

describe('unwrapAndOpen — forgery rejection (round-3 security)', () => {
  // Mallory's keypair — separate from Alice (sender) and Bob (recipient).
  const alicePrivBytes = generateSecretKey();
  const malloryPrivBytes = generateSecretKey();
  const bobPrivBytes = generateSecretKey();
  const alicePub = getPublicKey(alicePrivBytes);
  const bobPub = getPublicKey(bobPrivBytes);
  const bobPrivHex = bytesToHex(bobPrivBytes);

  it('rejects a forged rumor: Mallory wraps a rumor claiming Alice pubkey to Bob', async () => {
    // Mallory builds a rumor whose pubkey field claims to be Alice.
    // createRumor overwrites pubkey from the private key, so we manually
    // craft the tampered rumor object after createRumor computes it for Mallory,
    // then replace pubkey with Alice's to simulate the attacker's goal.
    const malloryRumor = createRumor(
      {
        kind: CHAT_MESSAGE_KIND,
        content: '{"type":"text","text":"I am Alice!"}',
        tags: [['p', bobPub]],
      },
      malloryPrivBytes,
    );
    // Overwrite pubkey with Alice's — this is the forgery attempt.
    const forgedRumor = { ...malloryRumor, pubkey: alicePub };

    // Mallory signs the seal with their own key (so verifyEvent passes on the seal
    // itself), but the rumor inside claims Alice's pubkey.
    const seal = createSeal(forgedRumor as any, malloryPrivBytes, bobPub);
    const wrap = createWrap(seal, bobPub);

    // Bob unwraps: seal.pubkey (Mallory) !== rumor.pubkey (Alice) → must throw.
    await expect(unwrapAndOpen(wrap as any, bobPrivHex)).rejects.toThrow(
      'gift wrap decryption failed',
    );
  });

  it('rejects a tampered seal signature (verifyEvent check)', async () => {
    // Build a legitimate wrap from Alice to Bob.
    const alicePrivHex = bytesToHex(alicePrivBytes);
    const legitimateRumor = makeRumor({ pubkey: alicePub });
    const legitimateWrap = await sealAndWrap(legitimateRumor, bobPub, alicePrivHex);

    // Decrypt the outer wrap to access the seal, then mutate the sig.
    const sealJson = nip44.v2.decrypt(
      legitimateWrap.content,
      nip44.v2.utils.getConversationKey(
        hexToBytes(bobPrivHex),
        legitimateWrap.pubkey,
      ),
    );
    const seal = JSON.parse(sealJson) as import('nostr-tools').NostrEvent;
    // Corrupt the seal signature (replace the first byte with a DIFFERENT one —
    // a fixed 'ff' left ~1/256 signatures untouched and flaked the test).
    const tamperedSig = (seal.sig.startsWith('ff') ? '00' : 'ff') + seal.sig.slice(2);
    const tamperedSeal = { ...seal, sig: tamperedSig };

    // Re-encrypt the tampered seal into a new gift wrap using an ephemeral key.
    const { nip44: nip44tools } = await import('nostr-tools');
    const { generateSecretKey: genKey, getPublicKey: getPub } = await import('nostr-tools/pure');
    const ephemPrivBytes = genKey();
    const ephemPub = getPub(ephemPrivBytes);
    const resealedContent = nip44tools.v2.encrypt(
      JSON.stringify(tamperedSeal),
      nip44tools.v2.utils.getConversationKey(ephemPrivBytes, bobPub),
    );
    const { finalizeEvent } = await import('nostr-tools/pure');
    const tamperedWrap = finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        content: resealedContent,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', bobPub]],
      },
      ephemPrivBytes,
    );

    // verifyEvent on the tampered seal must fail → generic error thrown.
    await expect(unwrapAndOpen(tamperedWrap as any, bobPrivHex)).rejects.toThrow(
      'gift wrap decryption failed',
    );
  });

  it('rejects a forged rumor id (non-canonical id in inner rumor)', async () => {
    // Build a legitimate wrap from Alice to Bob, then tamper the inner rumor id.
    const alicePrivHex = bytesToHex(alicePrivBytes);
    const legitimateRumor = makeRumor({ pubkey: alicePub });
    const legitimateWrap = await sealAndWrap(legitimateRumor, bobPub, alicePrivHex);

    // Decrypt the outer wrap to get the seal.
    const sealJson = nip44.v2.decrypt(
      legitimateWrap.content,
      nip44.v2.utils.getConversationKey(
        hexToBytes(bobPrivHex),
        legitimateWrap.pubkey,
      ),
    );
    const seal = JSON.parse(sealJson) as import('nostr-tools').NostrEvent;

    // Decrypt the seal to get the rumor, then replace its id with a non-canonical value.
    const rumorJson = nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(hexToBytes(bobPrivHex), seal.pubkey),
    );
    const rumor = JSON.parse(rumorJson);
    const tamperedRumor = { ...rumor, id: '00'.repeat(32) };

    // Re-encrypt the tampered rumor back into the seal using Alice's key.
    const { nip44: nip44tools } = await import('nostr-tools');
    const { getPublicKey: getPub, generateSecretKey: genKey, finalizeEvent } = await import('nostr-tools/pure');
    const { createSeal: mkSeal } = await import('nostr-tools/nip59');
    const resealedContent = nip44tools.v2.encrypt(
      JSON.stringify(tamperedRumor),
      nip44tools.v2.utils.getConversationKey(hexToBytes(alicePrivHex), bobPub),
    );
    // Re-sign the seal with Alice's key so verifyEvent still passes.
    const resealedSeal = finalizeEvent(
      {
        kind: 13,
        content: resealedContent,
        created_at: seal.created_at,
        tags: [],
      },
      hexToBytes(alicePrivHex),
    );

    // Re-wrap with a fresh ephemeral key.
    const ephemPrivBytes = genKey();
    const ephemPub = getPub(ephemPrivBytes);
    const rewrappedContent = nip44tools.v2.encrypt(
      JSON.stringify(resealedSeal),
      nip44tools.v2.utils.getConversationKey(ephemPrivBytes, bobPub),
    );
    const tamperedWrap = finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        content: rewrappedContent,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', bobPub]],
      },
      ephemPrivBytes,
    );

    // The non-canonical id must be detected → generic error thrown.
    await expect(unwrapAndOpen(tamperedWrap as any, bobPrivHex)).rejects.toThrow(
      'gift wrap decryption failed',
    );
  });

  it('rejects a non-1059 kind (kind-4 fed directly)', async () => {
    const fakeKind4 = {
      kind: 4,
      content: 'not a gift wrap',
      pubkey: alicePub,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      id: 'a'.repeat(64),
      sig: 'b'.repeat(128),
    };
    await expect(unwrapAndOpen(fakeKind4 as any, bobPrivHex)).rejects.toThrow(
      'gift wrap decryption failed',
    );
  });

  it('rejects a non-1059 kind (kind-13 seal fed directly)', async () => {
    const fakeKind13 = {
      kind: 13,
      content: 'not a gift wrap',
      pubkey: alicePub,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      id: 'c'.repeat(64),
      sig: 'd'.repeat(128),
    };
    await expect(unwrapAndOpen(fakeKind13 as any, bobPrivHex)).rejects.toThrow(
      'gift wrap decryption failed',
    );
  });
});
