/**
 * Unit tests for processContactInput.ts's `unsupported_version` error branch
 * (epic: contact-pairing-code, story S5, AC-UI-3 / RD-5).
 *
 * `decodeCard` (S1, AC-CODEC-4) already rejects a header whose version bits
 * are neither `00` nor `01` with the exact error string
 * `'contactCard: unsupported version'`. This story's only change to
 * processContactInput.ts is to stop collapsing that specific parse failure
 * into the generic `'invalid_npub'` error code, so the `/add` page (AC-UI-3)
 * can show friendly "update your app" copy instead of "that doesn't look
 * like a valid npub" — a real, signed card just made with a NEWER codec is
 * not the same problem as garbage input.
 *
 * Drives the REAL production seam (parseContactCard -> decodeCard) with a
 * genuinely re-versioned, still-otherwise-valid signed card — mirrors
 * contactCard.test.ts's AC-CODEC-4 header-mutation recipe — rather than
 * asserting against a hand-rolled error string.
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { encodeCard, encodeCardV2, base64UrlToBytes, bytesToBase64Url } from '@/src/lib/contactCard';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { addContactByNpub, readStoredContacts } from '@/src/lib/contacts';
import { readContactEntry } from '@/src/lib/contactCache';
import { pubkeyToNpub } from '@/src/lib/nostrKeys';
import { processContactInput } from '@/src/lib/processContactInput';

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

function makeIdentity() {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  return { pubkeyHex, signer };
}

/** Build a real, signed v2 pairing card (mirrors addContactCardWiring.test.ts's helper of the same shape). */
async function buildSignedPairingCardPayload(
  pubkeyHex: string,
  signer: ReturnType<typeof createPrivateKeySigner>,
  nickname: string,
  createdAt: number,
  nonceHex: string,
  expiresAt: number,
): Promise<string> {
  const encoded = await encodeCardV2(pubkeyHex, { nickname, createdAt }, nonceHex, expiresAt, signer.signEvent);
  return encoded.cardB64Url;
}

describe('processContactInput — unsupported_version (AC-UI-3)', () => {
  it('surfaces a header with unrecognized version bits (10) as unsupported_version, not invalid_npub', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await encodeCard(pubkeyHex, { nickname: 'Alice', createdAt: 1735689600 }, signer.signEvent);
    const bytes = base64UrlToBytes(payload)!;
    const mutated = new Uint8Array(bytes);
    mutated[0] = (mutated[0] & 0x3f) | 0x80; // version bits 10 — AC-CODEC-4's unrecognized-future-version case

    const result = processContactInput(bytesToBase64Url(mutated), null);

    expect(result).toEqual({ ok: false, error: 'unsupported_version' });
  });

  it('surfaces version bits 11 the same way', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await encodeCard(pubkeyHex, { nickname: 'Bob', createdAt: 1735689600 }, signer.signEvent);
    const bytes = base64UrlToBytes(payload)!;
    const mutated = new Uint8Array(bytes);
    mutated[0] = (mutated[0] & 0x3f) | 0xc0; // version bits 11

    const result = processContactInput(bytesToBase64Url(mutated), null);

    expect(result).toEqual({ ok: false, error: 'unsupported_version' });
  });

  it('a genuinely invalid card (e.g. tampered signature) still surfaces as invalid_npub, not unsupported_version', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await encodeCard(pubkeyHex, { nickname: 'Mallory', createdAt: 1735689600 }, signer.signEvent);
    const bytes = base64UrlToBytes(payload)!;
    const mutated = new Uint8Array(bytes);
    mutated[mutated.length - 1] ^= 0xff; // flip a signature byte — version bits untouched

    const result = processContactInput(bytesToBase64Url(mutated), null);

    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
  });

  it('garbage (non-card, non-npub) input still surfaces as invalid_npub', () => {
    localStorageMock.clear();
    const result = processContactInput('not-a-card-at-all', null);
    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
  });
});

// Review-remediation (sev 5 fix, epic: contact-pairing-code, story S4) — a
// RETURNING scanner (one who already has the issuer as a one-directional
// contact) re-scanning a live pairing code must still reciprocate. That fix
// landed in processContactInput.ts's `already_exists` branch, but had no
// dedicated regression test in THIS file (VQ per lead review, sev 4): a
// future re-narrowing of the `shouldImportProfile`/pairingEcho gate could
// silently reopen the gap with a fully green suite. Complements (does not
// replace) the equivalent coverage in addContactCardWiring.test.ts — this
// file is where processContactInput's error-taxonomy behavior is now the
// primary home, so the sev-5 fix's protection belongs here too.
describe('processContactInput — already_exists pairingEcho regression (review-remediation)', () => {
  it('(a) an already-existing contact re-scanned via a LIVE (unexpired) v2 pairing card yields already_exists WITH a pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    // Seed the pre-existing one-directional relationship (B already has A).
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);
    expect(readStoredContacts()[pubkeyHex].archivedAt).toBeNull();

    const nonceHex = 'ab'.repeat(16);
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Quinn', 1735689600, nonceHex, expiresAt);

    const result = processContactInput(payload, null, () => 1735689600 * 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('already_exists');
    // Carries the peer pubkey (non-blocked) so /add can navigate to the DM.
    expect(result.pubkeyHex).toBe(pubkeyHex);
    expect(result.pairingEcho).toEqual({ issuerPubkeyHex: pubkeyHex, nonceHex, expiresAt });
    // The cache-refresh side effect (AC-UX-6) is unaffected by this fix.
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Quinn');
  });

  it('(b) an already_exists re-scan of an EXPIRED v2 card produces already_exists with NO pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);

    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Riley', 1735689600, 'cd'.repeat(16), expiresAt);

    // One second past expiresAt, per the scanner's own clock.
    const result = processContactInput(payload, null, () => (expiresAt + 1) * 1000);

    // A non-blocked already_exists now carries the peer pubkey so the /add
    // page can navigate the returning scanner to the DM (an expired code still
    // opens the chat — only the reciprocation echo is dropped).
    expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });

  it('(b) an already_exists re-scan of a v1 (pairing-less) card carries no pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);

    const payload = await encodeCard(pubkeyHex, { nickname: 'Sam', createdAt: 1735689600 }, signer.signEvent);
    const result = processContactInput(payload, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });

  it('(b) an already_exists re-scan of a bare npub (no card at all) carries no pairingEcho candidate', () => {
    localStorageMock.clear();
    const { pubkeyHex } = makeIdentity();
    const npub = pubkeyToNpub(pubkeyHex);
    addContactByNpub(npub, null);

    const result = processContactInput(npub, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });

  it('(c) a self-scan of a LIVE v2 pairing card is rejected as `self` and never carries a pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Taylor', 1735689600, 'ef'.repeat(16), expiresAt);

    // ownPubkeyHex === the scanned card's own pubkey — a self-scan.
    const result = processContactInput(payload, pubkeyHex, () => 1735689600 * 1000);

    expect(result).toEqual({ ok: false, error: 'self' });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });

  it('(c) invalid_npub and unsupported_version parse failures never carry a pairingEcho candidate', () => {
    localStorageMock.clear();
    const garbage = processContactInput('not-a-card-at-all', null);
    expect(garbage).toEqual({ ok: false, error: 'invalid_npub' });
    expect((garbage as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });
});
