/**
 * Unit tests for processContactInput.ts's blocked-re-add cut-off (epic:
 * block-contact, story S4, AC-VIEW-13 — a cross-vendor P1 finding).
 *
 * `addContactByNpub` (S1, frozen) deliberately does NOT clear `archivedAt`
 * when a blocked/archived contact is re-added: it returns
 * `{ ok: false, error: 'already_exists', blocked: true, pubkeyHex }` (DD-9,
 * no silent unblock on re-add). `processContactInput` forwards `blocked` but
 * not `addContactByNpub`'s `pubkeyHex` field — its own `ok: false` result
 * shape never carried a `pubkeyHex` (the caller already has it from the
 * parsed card / npub input). Before this story, `processContactInput`
 * treated that outcome exactly like any other `already_exists` — it still
 * imported the card's profile into the cache and still computed a
 * `pairingEcho` candidate for an unexpired v2 code. AC-VIEW-13 requires a
 * full cut-off in both directions (DD-2): re-adding a blocked contact by
 * npub OR re-scanning their pairing card must produce neither a cache
 * refresh nor a reciprocation candidate — no signal leaks back to a blocked
 * peer.
 *
 * Drives the REAL production seam end-to-end (parseContactCard ->
 * addContactByNpub -> processContactInput), mirroring
 * cards/processContactInput.test.ts's and contacts-add-by-npub.test.ts's
 * conventions: a hand-rolled localStorage mock (contacts.ts and
 * contactCache.ts kept real/unmocked), and real signed-card fixtures built
 * via encodeCard/encodeCardV2 rather than hand-rolled JSON.
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { encodeCard, encodeCardV2 } from '@/src/lib/contactCard';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { addContactByNpub, archiveContact, readStoredContacts, rememberContact } from '@/src/lib/contacts';
import { readContactEntry, writeContactEntry } from '@/src/lib/contactCache';
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

/** Build a real, signed v1 card (profile only, no pairing). */
async function buildSignedCardPayload(
  pubkeyHex: string,
  signer: ReturnType<typeof createPrivateKeySigner>,
  nickname: string,
  createdAt: number,
): Promise<string> {
  return encodeCard(pubkeyHex, { nickname, createdAt }, signer.signEvent);
}

/** Build a real, signed v2 pairing card (mirrors cards/processContactInput.test.ts's helper of the same shape). */
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

/** Seeds a blocked (archived) contact for `pubkeyHex` and returns the seeded timestamp. */
function seedBlockedContact(pubkeyHex: string): string {
  const seededAt = '2020-01-01T00:00:00.000Z';
  rememberContact(pubkeyHex, seededAt);
  archiveContact(pubkeyHex, seededAt);
  return seededAt;
}

describe('processContactInput — blocked re-add cut-off (AC-VIEW-13)', () => {
  it('re-adding a blocked contact via a v1 card carrying a profile does not import the profile into the cache', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    seedBlockedContact(pubkeyHex);
    // Pre-seed a cached nickname so a silent import would be observable.
    writeContactEntry(pubkeyHex, { nickname: 'OldCachedName', avatar: null, updatedAt: '2020-01-01T00:00:00.000Z' });

    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'NewName', 1735689600);
    const result = processContactInput(payload, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', blocked: true });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
    // No import happened — the cached nickname is unchanged, not refreshed to 'NewName'.
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('OldCachedName');
  });

  it('re-adding a blocked contact via a LIVE (unexpired) v2 pairing card yields no pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    seedBlockedContact(pubkeyHex);
    writeContactEntry(pubkeyHex, { nickname: 'OldCachedName', avatar: null, updatedAt: '2020-01-01T00:00:00.000Z' });

    const nonceHex = 'ab'.repeat(16);
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'NewName', 1735689600, nonceHex, expiresAt);

    // Called well before expiresAt, so the code is genuinely live — the
    // cut-off must hold even with a currently-usable pairing code.
    const result = processContactInput(payload, null, () => 1735689600 * 1000);

    expect(result).toEqual({ ok: false, error: 'already_exists', blocked: true });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('OldCachedName');
  });

  it('control: the SAME card re-added for a NON-blocked already-exists contact still computes a pairingEcho candidate', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    // A genuine (non-archived) already-exists: B already has A as a contact.
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);
    expect(readStoredContacts()[pubkeyHex].archivedAt).toBeNull();

    const nonceHex = 'cd'.repeat(16);
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Quinn', 1735689600, nonceHex, expiresAt);

    const result = processContactInput(payload, null, () => 1735689600 * 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('already_exists');
    expect(result.blocked).toBeUndefined();
    // Non-blocked already_exists carries the peer pubkey (so /add can open the
    // DM); the blocked cases above deliberately do NOT — a full cut-off.
    expect(result.pubkeyHex).toBe(pubkeyHex);
    expect(result.pairingEcho).toEqual({ issuerPubkeyHex: pubkeyHex, nonceHex, expiresAt });
    // The legitimate returning-scanner cache refresh (AC-UX-6) still fires.
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Quinn');
  });

  it('a blocked contact remains archived after the re-add attempt — no silent unblock', async () => {
    localStorageMock.clear();
    const { pubkeyHex, signer } = makeIdentity();
    const seededAt = seedBlockedContact(pubkeyHex);

    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'NewName', 1735689600);
    processContactInput(payload, null);

    const contacts = readStoredContacts();
    expect(contacts[pubkeyHex].archivedAt).toBe(seededAt);
  });

  it('re-adding a blocked contact via a BARE NPUB (no card at all) still cuts off — no crash, no import, blocked surfaced', () => {
    localStorageMock.clear();
    const { pubkeyHex } = makeIdentity();
    seedBlockedContact(pubkeyHex);
    const npub = pubkeyToNpub(pubkeyHex);

    const result = processContactInput(npub, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', blocked: true });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
  });
});
