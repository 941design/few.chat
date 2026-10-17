/**
 * Share contact card on a signer/identity mismatch (bug: decided-small-fixes #4).
 *
 * With a NIP-46 / NIP-07 signer whose pubkey differs from the local identity,
 * the card builder's guard throws and the UI showed the generic, retry-implying
 * "Failed to build the share card. Please try again." forever. The mismatch is
 * now a TYPED error (no message sniffing) that the UI maps to a distinct,
 * actionable message; every other failure keeps the generic one.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import {
  encodeCard,
  encodeCardV2,
  SignerPubkeyMismatchError,
} from '@/src/lib/contactCard';
import { getOwnShareCard, resolveShareCardError } from '@/src/lib/shareCard';
import { getCopy } from '@/src/lib/i18n';

const T = 1735689600;
const NONCE = 'a'.repeat(32);

function identity() {
  const sk = generateSecretKey();
  return { skHex: bytesToHex(sk), pubkeyHex: getPublicKey(sk) };
}

const EN_MISMATCH =
  'Your signer holds a different identity than this profile. Reconnect a signer for this identity or switch back to the local key.';
const DE_MISMATCH =
  'Dein Signierer gehört zu einer anderen Identität als dieses Profil. Verbinde einen Signierer für diese Identität oder wechsle zurück zum lokalen Schlüssel.';

describe('the card builders raise a typed error on a signer/identity mismatch', () => {
  it('encodeCard', async () => {
    const own = identity();
    const foreign = createPrivateKeySigner(identity().skHex);
    const err = await encodeCard(own.pubkeyHex, { nickname: 'Alice', createdAt: T }, foreign.signEvent).catch((e) => e);
    expect(err).toBeInstanceOf(SignerPubkeyMismatchError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SignerPubkeyMismatchError');
    expect(err.message).toMatch(/signer pubkey does not match/);
  });

  it('encodeCardV2 (the pairing card Share actually produces)', async () => {
    const own = identity();
    const foreign = createPrivateKeySigner(identity().skHex);
    const err = await encodeCardV2(
      own.pubkeyHex, { nickname: 'Alice', createdAt: T }, NONCE, T + 600, foreign.signEvent,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SignerPubkeyMismatchError);
  });

  it('a matching signer raises nothing', async () => {
    const own = identity();
    const signer = createPrivateKeySigner(own.skHex);
    await expect(
      encodeCardV2(own.pubkeyHex, { nickname: 'Alice', createdAt: T }, NONCE, T + 600, signer.signEvent),
    ).resolves.toBeTruthy();
  });
});

describe('resolveShareCardError', () => {
  const messages = { generic: 'GENERIC', signerMismatch: 'MISMATCH' };

  it('maps the typed mismatch error to the mismatch message', () => {
    expect(resolveShareCardError(new SignerPubkeyMismatchError(), messages)).toBe('MISMATCH');
  });

  it.each([
    ['a plain Error', new Error('network down')],
    ['an Error that merely mentions the mismatch text', new Error('contactCard: signer pubkey does not match the supplied pubkeyHex')],
    ['a non-Error throw', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('keeps the generic message for %s (no message-string matching)', (_l, err) => {
    expect(resolveShareCardError(err, messages)).toBe('GENERIC');
  });

  it('end to end: getOwnShareCard with a foreign signer resolves to the mismatch message', async () => {
    const own = identity();
    const foreign = createPrivateKeySigner(identity().skHex);
    const err = await getOwnShareCard({
      pubkeyHex: own.pubkeyHex,
      nickname: 'Alice',
      signerMode: 'nip46',
      cache: null,
      getActiveNonce: async () => ({ nonce: NONCE, expiresAt: T + 600 }),
      getSignEvent: async () => foreign.signEvent,
      now: () => T,
    }).catch((e) => e);
    expect(resolveShareCardError(err, { generic: 'GENERIC', signerMismatch: 'MISMATCH' })).toBe('MISMATCH');
  });

  it('end to end: a signer that fails for another reason stays generic', async () => {
    const own = identity();
    const err = await getOwnShareCard({
      pubkeyHex: own.pubkeyHex,
      nickname: 'Alice',
      signerMode: 'nip46',
      cache: null,
      getActiveNonce: async () => ({ nonce: NONCE, expiresAt: T + 600 }),
      getSignEvent: async () => async () => { throw new Error('bunker unreachable'); },
      now: () => T,
    }).catch((e) => e);
    expect(resolveShareCardError(err, { generic: 'GENERIC', signerMismatch: 'MISMATCH' })).toBe('GENERIC');
  });
});

describe('copy', () => {
  it('has the exact en and de mismatch strings, distinct from the generic one', () => {
    const en = getCopy('en').profile;
    const de = getCopy('de').profile;
    expect(en.shareCardSignerMismatchError).toBe(EN_MISMATCH);
    expect(de.shareCardSignerMismatchError).toBe(DE_MISMATCH);
    expect(en.shareCardSignerMismatchError).not.toBe(en.shareCardError);
    expect(de.shareCardSignerMismatchError).not.toBe(de.shareCardError);
  });
});
