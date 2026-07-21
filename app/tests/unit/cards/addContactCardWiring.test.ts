/**
 * Unit tests for S4 (epic: contact-card-exchange) — AddContactModal's card wiring.
 *
 * Drives the REAL production seams end to end: encodeCard (S1) -> parseContactCard
 * (S1) -> processContactInput (S4, this story's exported pure core, extracted from
 * AddContactModal.tsx per this repo's hooks-via-pure-function-extraction convention
 * — no jsdom, no component mount) -> addContactByNpub (existing) + importCard (S2).
 * No mock-spy proxies over parseContactCard/importCard/addContactByNpub: every
 * assertion below reads the actual resulting state (readStoredContacts /
 * readContactEntry), matching VQ-S4-001/004's "not merely asserting X was called"
 * requirement.
 *
 * Mocking: idb-keyval is Map-backed (not spied) because AddContactModal.tsx pulls
 * in MarmotContext -> groupStorage.ts, which calls createStore() at module load
 * time — same no-op-store pattern as dmMessageEdits.test.ts / groupStorage.test.ts.
 * ndkClient is stubbed so nothing here can attempt a real relay connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    ks.forEach((k) => idbStore.delete(k));
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
}));

vi.mock('@/src/lib/ndkClient', () => ({
  getNdk: vi.fn(),
  connectNdk: vi.fn(),
}));

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Module imports (after mocks are set up) ────────────────────────────────

const { encodeCard, encodeCardV2, parseContactCard, base64UrlToBytes, bytesToBase64Url, buildShareUrl } =
  await import('@/src/lib/contactCard');
const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
const { readStoredContacts, addContactByNpub } = await import('@/src/lib/contacts');
const { readContactEntry, writeContactEntry } = await import('@/src/lib/contactCache');
const { pubkeyToNpub } = await import('@/src/lib/nostrKeys');
const { getCopy } = await import('@/src/lib/i18n');
const { normaliseScanPayload } = await import('@/src/lib/qr');
// S4: pure add-contact core, now a standalone React-free lib module
// (processContactInput.ts) after the manual "add by npub" modal was removed.
// The card-link add path (/add deep link) still routes through this function.
const { processContactInput } = await import('@/src/lib/processContactInput');

function makeIdentity() {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  return { skHex, pubkeyHex, signer };
}

async function buildSignedCardPayload(
  pubkeyHex: string,
  signer: ReturnType<typeof createPrivateKeySigner>,
  nickname: string,
  createdAt: number,
): Promise<string> {
  return encodeCard(pubkeyHex, { nickname, createdAt }, signer.signEvent);
}

/** Build a real, signed v2 pairing card (epic: contact-pairing-code, S4 tests). */
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

function tamperSignature(payload: string): string {
  const bytes = base64UrlToBytes(payload)!;
  const mutated = new Uint8Array(bytes);
  // Flip the last byte, inside the 64-byte trailing sig — same tamper pattern
  // as contactCard.test.ts's AC-SIG-2/3/4 suite.
  mutated[mutated.length - 1] = mutated[mutated.length - 1] ^ 0xff;
  return bytesToBase64Url(mutated);
}

beforeEach(() => {
  localStorageMock.clear();
  idbStore.clear();
});

// ── AC-UX-1 — paste-a-card add populates the nickname ───────────────────────

describe('processContactInput — paste-card add (AC-UX-1)', () => {
  it('adds the contact and populates the nickname from a raw card payload', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Alice', 1735689600);

    const result = processContactInput(payload, null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect(readStoredContacts()[pubkeyHex]).toBeDefined();
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Alice');
  });

  it('adds the contact and populates the nickname from a full onboarding card link', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Bob', 1735689600);
    const link = buildShareUrl(payload);

    const result = processContactInput(link, null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Bob');
  });
});

// ── AC-UX-2 — scan-card add behaves identically to paste ───────────────────

describe('processContactInput — scan-card add is identical to paste (AC-UX-2)', () => {
  it('produces the same add+nickname outcome via the scanner validation step (normaliseScanPayload) as a direct paste', async () => {
    const pasted = makeIdentity();
    const scanned = makeIdentity();
    const pastedPayload = await buildSignedCardPayload(pasted.pubkeyHex, pasted.signer, 'Carol', 1735689600);
    const scannedLink = buildShareUrl(
      await buildSignedCardPayload(scanned.pubkeyHex, scanned.signer, 'Carol', 1735689600),
    );

    // Paste path: the raw input goes straight to processContactInput.
    const pasteResult = processContactInput(pastedPayload, null);

    // Scan path: NpubQrScanner validates via normaliseScanPayload first (the
    // production scan entry point), THEN the same processContactInput core runs
    // once the user submits — this is the real scan-to-add path, not a re-derived
    // copy of the add logic.
    const normalised = normaliseScanPayload(scannedLink);
    expect(normalised).not.toBeNull();
    const scanResult = processContactInput(normalised!, null);

    expect(scanResult.ok).toBe(true);
    expect(pasteResult.ok).toBe(true);
    if (!scanResult.ok || !pasteResult.ok) throw new Error('unreachable');
    // Same shape of outcome for both entry points (nickname cached, contact added).
    expect(scanResult.cachedNickname).toBe(pasteResult.cachedNickname);
    expect(readContactEntry(pasted.pubkeyHex)?.nickname).toBe('Carol');
    expect(readContactEntry(scanned.pubkeyHex)?.nickname).toBe('Carol');
    expect(readStoredContacts()[scanned.pubkeyHex]).toBeDefined();
  });

  it('rejects a QR payload whose card signature does not verify at the scanner validation step, before it ever reaches processContactInput', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Mallory', 1735689600);
    const tampered = tamperSignature(payload);

    expect(normaliseScanPayload(tampered)).toBeNull();
  });
});

// ── AC-UX-5 — bare npub add still succeeds with no nickname ────────────────

describe('processContactInput — bare npub add preserves the no-profile fallback (AC-UX-5)', () => {
  it('adds the contact with no card and leaves contactCache untouched for that pubkey', async () => {
    const pubkeyHex = 'a'.repeat(64);
    const npub = pubkeyToNpub(pubkeyHex);

    const result = processContactInput(npub, null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: false });
    expect(readStoredContacts()[pubkeyHex]).toBeDefined();
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
  });

  it('also succeeds via the scanner validation path for a bare-npub QR', () => {
    const pubkeyHex = 'b'.repeat(64);
    const npub = pubkeyToNpub(pubkeyHex);

    const normalised = normaliseScanPayload(npub);
    expect(normalised).not.toBeNull();
    const result = processContactInput(normalised!, null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: false });
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
  });
});

// ── AC-UX-6 — already-existing contact + newer card refreshes the nickname ──

describe('processContactInput — cache refresh is independent of the add outcome (AC-UX-6)', () => {
  it('refreshes the cached nickname via importCard when addContactByNpub returns already_exists', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    // Seed an active, nickname-less contact via the real addContactByNpub (not a
    // hand-inserted fixture).
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);
    expect(readStoredContacts()[pubkeyHex].archivedAt).toBeNull();

    const newerPayload = await buildSignedCardPayload(pubkeyHex, signer, 'Dana', 1735689600);

    const result = processContactInput(newerPayload, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    // No duplicate contact entry was created.
    expect(Object.keys(readStoredContacts())).toEqual([pubkeyHex]);
    // But the nickname WAS refreshed despite the add failing.
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Dana');
  });

  it('does not clobber a newer non-card nickname (LWW still holds on the already_exists branch)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    addContactByNpub(pubkeyToNpub(pubkeyHex), null);
    writeContactEntry(pubkeyHex, {
      nickname: 'Synced Name',
      avatar: null,
      updatedAt: '2030-01-01T00:00:00.000Z',
    });

    const olderPayload = await buildSignedCardPayload(pubkeyHex, signer, 'Older Card Name', 1735689600);

    const result = processContactInput(olderPayload, null);

    expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Synced Name');
  });

  it('never calls importCard for a self-add rejection', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'MyOwnCard', 1735689600);

    const result = processContactInput(payload, pubkeyHex);

    expect(result).toEqual({ ok: false, error: 'self' });
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
    expect(readStoredContacts()[pubkeyHex]).toBeUndefined();
  });
});

// ── AC-PARSE-4 / VQ-S4-006 — signature-invalid card is a hard failure ──────

describe('processContactInput — a signature-invalid card is an add-failure, never a silent bare-pubkey downgrade (VQ-S4-006)', () => {
  it('rejects a tampered card without adding the contact or writing the cache', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Eve', 1735689600);
    const tampered = tamperSignature(payload);

    // Sanity: parseContactCard itself really does reject this (S1's own guarantee).
    expect('error' in parseContactCard(tampered)).toBe(true);

    const result = processContactInput(tampered, null);

    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
    expect(readStoredContacts()[pubkeyHex]).toBeUndefined();
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
  });
});

// ── AC-PARSE-5 — garbage input never throws ─────────────────────────────────

describe('processContactInput — unparseable input is rejected without throwing (AC-PARSE-5 defense)', () => {
  it('returns an invalid_npub failure for garbage input', () => {
    expect(() => processContactInput('not-an-npub-or-card', null)).not.toThrow();
    const result = processContactInput('not-an-npub-or-card', null);
    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
  });

  it('returns an invalid_npub failure for empty input', () => {
    const result = processContactInput('', null);
    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
  });
});

// ── pairingEcho — the ParsedPairingCard-derived echo candidate (epic: ───────
// contact-pairing-code, story S4; AC-SCAN-1, AC-SCAN-2, AC-SCAN-8)

describe('processContactInput — pairingEcho candidate computation', () => {
  it('AC-SCAN-1/8: an unexpired v2 code yields a pairingEcho candidate carrying the scanned nonce/expiresAt/issuer', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const nonceHex = 'aa'.repeat(16);
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Ivy', 1735689600, nonceHex, expiresAt);

    const result = processContactInput(payload, null, () => 1735689600 * 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pairingEcho).toEqual({ issuerPubkeyHex: pubkeyHex, nonceHex, expiresAt });
  });

  it('AC-SCAN-6 boundary: a candidate is still produced at the exact expiresAt instant (inclusive)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const nonceHex = 'bb'.repeat(16);
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Jack', 1735689600, nonceHex, expiresAt);

    const result = processContactInput(payload, null, () => expiresAt * 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pairingEcho).toEqual({ issuerPubkeyHex: pubkeyHex, nonceHex, expiresAt });
  });

  it('AC-SCAN-2: an EXPIRED v2 code (per the scanner\'s own clock) produces no pairingEcho candidate, yet the add still completes as a plain one-directional add', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const expiresAt = 1735689600 + 1800;
    const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Kara', 1735689600, 'cc'.repeat(16), expiresAt);

    // One second past expiresAt, per the scanner's clock.
    const result = processContactInput(payload, null, () => (expiresAt + 1) * 1000);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Kara');
  });

  it('AC-SCAN-2: a v1 card (no pairing field at all) never carries a pairingEcho candidate', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Liam', 1735689600);

    const result = processContactInput(payload, null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
  });

  it('AC-SCAN-2: a bare npub never carries a pairingEcho candidate', () => {
    const pubkeyHex = 'e'.repeat(64);
    const result = processContactInput(pubkeyToNpub(pubkeyHex), null);

    expect(result).toEqual({ ok: true, pubkeyHex, reactivated: false, cachedNickname: false });
  });

  it('a self-scan of one\'s own v2 code never carries a pairingEcho candidate (the add itself is rejected first)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedPairingCardPayload(
      pubkeyHex,
      signer,
      'Mona',
      1735689600,
      'dd'.repeat(16),
      1735689600 + 1800,
    );

    const result = processContactInput(payload, pubkeyHex);

    expect(result).toEqual({ ok: false, error: 'self' });
  });

  // ── Review-remediation (sev 5): a RETURNING scanner must still reciprocate ──

  describe('a RETURNING scanner (already_exists) still reciprocates when the re-scanned code carries an unexpired pairing field', () => {
    it('an unexpired v2 code re-scanned by an already-contact yields ok:false/already_exists WITH a pairingEcho candidate', async () => {
      const { pubkeyHex, signer } = makeIdentity();
      // Seed an active, already-known contact via the real addContactByNpub
      // (mirrors the pre-existing AC-UX-6 seeding pattern above) — this is
      // the "B added A one-directionally earlier" half of the scenario.
      addContactByNpub(pubkeyToNpub(pubkeyHex), null);
      expect(readStoredContacts()[pubkeyHex].archivedAt).toBeNull();

      const nonceHex = 'ee'.repeat(16);
      const expiresAt = 1735689600 + 1800;
      const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Nina', 1735689600, nonceHex, expiresAt);

      const result = processContactInput(payload, null, () => 1735689600 * 1000);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toBe('already_exists');
      expect(result.pairingEcho).toEqual({ issuerPubkeyHex: pubkeyHex, nonceHex, expiresAt });
      // AC-UX-6 is unaffected — the nickname refresh still happens on this branch.
      expect(readContactEntry(pubkeyHex)?.nickname).toBe('Nina');
    });

    it('an EXPIRED v2 code re-scanned by an already-contact yields already_exists with NO pairingEcho candidate', async () => {
      const { pubkeyHex, signer } = makeIdentity();
      addContactByNpub(pubkeyToNpub(pubkeyHex), null);

      const expiresAt = 1735689600 + 1800;
      const payload = await buildSignedPairingCardPayload(pubkeyHex, signer, 'Oscar', 1735689600, 'ff'.repeat(16), expiresAt);

      // One second past expiresAt, per the scanner's own clock.
      const result = processContactInput(payload, null, () => (expiresAt + 1) * 1000);

      expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
      expect((result as { pairingEcho?: unknown }).pairingEcho).toBeUndefined();
    });

    it('a v1 (pairing-less) re-scan of an already-contact carries no pairingEcho candidate (unchanged pre-remediation behavior)', async () => {
      const { pubkeyHex, signer } = makeIdentity();
      addContactByNpub(pubkeyToNpub(pubkeyHex), null);

      const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Priya', 1735689600);
      const result = processContactInput(payload, null);

      expect(result).toEqual({ ok: false, error: 'already_exists', pubkeyHex });
    });
  });
});

// ── normaliseScanPayload — the card-aware QR validation seam (VQ-S4-005) ───

describe('normaliseScanPayload — card-aware QR-scan validation, delegating to parseContactCard', () => {
  it('accepts a bare npub, unchanged', () => {
    const npub = pubkeyToNpub('c'.repeat(64));
    expect(normaliseScanPayload(npub)).toBe(npub);
  });

  it('accepts a nostr:-prefixed npub, stripping the prefix (matching normaliseNpubPayload behavior)', () => {
    const npub = pubkeyToNpub('d'.repeat(64));
    expect(normaliseScanPayload(`nostr:${npub}`)).toBe(npub);
  });

  it('accepts a full card onboarding link', async () => {
    const { signer, pubkeyHex } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Frank', 1735689600);
    const link = buildShareUrl(payload);
    expect(normaliseScanPayload(link)).toBe(link);
  });

  it('accepts a raw base64url card payload with no URL wrapper', async () => {
    const { signer, pubkeyHex } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Grace', 1735689600);
    expect(normaliseScanPayload(payload)).toBe(payload);
  });

  it('rejects garbage input', () => {
    expect(normaliseScanPayload('hello world')).toBeNull();
    expect(normaliseScanPayload('')).toBeNull();
  });

  it('rejects a card with an invalid signature (never downgrades to a bare-pubkey pass)', async () => {
    const { signer, pubkeyHex } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Heidi', 1735689600);
    expect(normaliseScanPayload(tamperSignature(payload))).toBeNull();
  });
});

// ── i18n — boy-scout fix for NpubQrScanner's hardcoded "Starting camera..." ─

describe('groups.qrStartingCamera copy (boy-scout i18n fix, NpubQrScanner.tsx)', () => {
  it('is translated in both en and de, distinctly, with non-empty text', () => {
    const en = getCopy('en').groups.qrStartingCamera;
    const de = getCopy('de').groups.qrStartingCamera;
    expect(typeof en).toBe('string');
    expect(typeof de).toBe('string');
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });
});
