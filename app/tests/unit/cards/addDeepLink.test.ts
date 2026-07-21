/**
 * Unit tests for S7 (epic: contact-card-exchange) — pages/add.tsx's pure
 * hash-parse-then-mode-branch core, addDeepLink.ts.
 *
 * Drives the REAL production seams end to end: extractCardPayloadFromHash /
 * readLocationHash (this story) -> resolveAddDeepLink (this story) ->
 * processContactInput (S4) -> parseContactCard (S1) -> addContactByNpub
 * (existing) + importCard (S2). No mock-spy proxies standing in for the hash
 * read or the parse: every assertion below reads real production output or
 * real resulting storage state (readContactEntry / readStoredContacts),
 * matching VQ-S7-004/007/008's "real parseContactCard output, not a
 * pre-parsed fixture" and "profile actually applied" requirements.
 *
 * Mocking: idb-keyval is Map-backed (not spied) because AddContactModal.tsx
 * (imported transitively via addDeepLink.ts) pulls in MarmotContext ->
 * groupStorage.ts, which calls createStore() at module load time — same
 * no-op-store pattern as addContactCardWiring.test.ts / dmMessageEdits.test.ts.
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

const { encodeCard, buildShareUrl } = await import('@/src/lib/contactCard');
const contactCardModule = await import('@/src/lib/contactCard');
const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
const { readStoredContacts, addContactByNpub } = await import('@/src/lib/contacts');
const { readContactEntry } = await import('@/src/lib/contactCache');
const { pubkeyToNpub } = await import('@/src/lib/nostrKeys');
const {
  readLocationHash,
  extractCardPayloadFromHash,
  resolveAddDeepLink,
} = await import('@/src/lib/addDeepLink');

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

beforeEach(() => {
  localStorageMock.clear();
  idbStore.clear();
  vi.restoreAllMocks();
});

// ── readLocationHash — SSR-safe hash reader (VQ-S7-001) ─────────────────────

describe('readLocationHash — SSR-safe window guard (VQ-S7-001)', () => {
  it('returns "" for the genuinely-reachable no-window (prerender) branch', () => {
    expect(readLocationHash(undefined)).toBe('');
  });

  it('returns "" when window.location.hash is not a string', () => {
    expect(readLocationHash({ location: {} })).toBe('');
    expect(readLocationHash({})).toBe('');
  });

  it('returns the real hash string when window is present', () => {
    expect(readLocationHash({ location: { hash: '#c=abc123' } })).toBe('#c=abc123');
  });

  it('never throws for either branch', () => {
    expect(() => readLocationHash(undefined)).not.toThrow();
    expect(() => readLocationHash({ location: { hash: '#c=x' } })).not.toThrow();
  });
});

// ── extractCardPayloadFromHash — pure fragment parsing ──────────────────────

describe('extractCardPayloadFromHash', () => {
  it('extracts the payload after the #c= marker', () => {
    expect(extractCardPayloadFromHash('#c=abc123')).toBe('abc123');
  });

  it('returns null for an empty hash', () => {
    expect(extractCardPayloadFromHash('')).toBeNull();
  });

  it('returns null when the hash has no #c= marker', () => {
    expect(extractCardPayloadFromHash('#something-else')).toBeNull();
  });

  it('returns null when the payload after the marker is empty', () => {
    expect(extractCardPayloadFromHash('#c=')).toBeNull();
  });

  it('handles a full onboarding-URL-shaped hash the same way', () => {
    expect(extractCardPayloadFromHash('#c=' + 'AB'.repeat(20))).toBe('AB'.repeat(20));
  });
});

// ── resolveAddDeepLink — no card in the hash ────────────────────────────────

describe('resolveAddDeepLink — no card present', () => {
  it('resolves to no_card immediately regardless of identity state, without touching contactCache', () => {
    const result = resolveAddDeepLink('', false, null);
    expect(result).toEqual({ state: 'no_card' });
  });

  it('resolves to no_card even once hydrated, and never calls parseContactCard', () => {
    const parseSpy = vi.spyOn(contactCardModule, 'parseContactCard');
    const result = resolveAddDeepLink('#no-card-marker', true, 'a'.repeat(64));
    expect(result).toEqual({ state: 'no_card' });
    expect(parseSpy).not.toHaveBeenCalled();
  });
});

// ── resolveAddDeepLink — AC-UX-3: direct load / reload with an existing identity ──

describe('resolveAddDeepLink — existing identity, valid card (AC-UX-3, VQ-S7-007)', () => {
  it('parses the REAL card via parseContactCard (through processContactInput) and completes the add on a fresh load', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Alice', 1735689600);
    const hash = `#c=${payload}`;

    const parseSpy = vi.spyOn(contactCardModule, 'parseContactCard');

    const result = resolveAddDeepLink(hash, true, null);

    expect(result).toEqual({ state: 'complete', ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    // The single decode seam is exercised exactly once for this load — no
    // second, separate parse of the raw hash elsewhere in the flow (VQ-S7-002).
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledWith(payload);
    // Real resulting storage state, not merely a returned outcome shape.
    expect(readStoredContacts()[pubkeyHex]).toBeDefined();
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Alice');
  });

  it('parses a full onboarding-URL-shaped hash (https://few.chat/add#c=<payload>) identically', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Bob', 1735689600);
    const link = buildShareUrl(payload);
    // window.location.hash on a URL like https://few.chat/add#c=XYZ is just "#c=XYZ".
    const hash = link.slice(link.indexOf('#'));

    const result = resolveAddDeepLink(hash, true, null);

    expect(result).toEqual({ state: 'complete', ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Bob');
  });

  it('resolves identically on a simulated reload (same hash re-read as a fresh page load)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Carol', 1735689600);
    const hash = `#c=${payload}`;

    // First load.
    const first = resolveAddDeepLink(hash, true, null);
    expect(first).toEqual({ state: 'complete', ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Carol');

    // Reload: a brand-new page load reads the SAME window.location.hash and
    // re-resolves from scratch (fresh call, no carried-over JS state) —
    // idempotent per AC-CACHE-3 / AC-UX-6 (already_exists, cache unchanged).
    const second = resolveAddDeepLink(hash, true, null);
    // A non-blocked already_exists now carries the peer pubkey so pages/add.tsx
    // navigates the returning scanner straight to that contact's DM page.
    expect(second).toEqual({ state: 'complete', ok: false, error: 'already_exists', pubkeyHex });
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Carol');
    expect(Object.keys(readStoredContacts())).toEqual([pubkeyHex]);
  });

  it('surfaces a signature-invalid card as an add-failure, never a silent bare-pubkey downgrade', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Mallory', 1735689600);
    const bytes = contactCardModule.base64UrlToBytes(payload)!;
    const mutated = new Uint8Array(bytes);
    mutated[mutated.length - 1] ^= 0xff;
    const tampered = contactCardModule.bytesToBase64Url(mutated);

    const result = resolveAddDeepLink(`#c=${tampered}`, true, null);

    expect(result).toEqual({ state: 'complete', ok: false, error: 'invalid_npub' });
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
    expect(readStoredContacts()[pubkeyHex]).toBeUndefined();
  });

  it('never throws for a garbage (non-card, non-npub) payload', () => {
    expect(() => resolveAddDeepLink('#c=not-a-card', true, null)).not.toThrow();
    const result = resolveAddDeepLink('#c=not-a-card', true, null);
    expect(result).toEqual({ state: 'complete', ok: false, error: 'invalid_npub' });
  });
});

// ── resolveAddDeepLink — AC-UX-7: no-identity-then-identity-created sequence ──

describe('resolveAddDeepLink — no local identity yet, then identity created (AC-UX-7, VQ-S7-008)', () => {
  it('waits for hydration without adding, then completes the add once hydrated — the profile actually lands in contactCache', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const payload = await buildSignedCardPayload(pubkeyHex, signer, 'Dana', 1735689600);
    const hash = `#c=${payload}`;

    // Visitor with no local identity yet: the app has not hydrated an
    // auto-generated identity (NostrIdentityContext.hydrated === false).
    const parseSpy = vi.spyOn(contactCardModule, 'parseContactCard');
    const awaiting = resolveAddDeepLink(hash, false, null);

    expect(awaiting).toEqual({ state: 'awaiting_identity' });
    // The card is NOT parsed or added while waiting — it only survives via
    // the retained hash string, never transmitted or consumed prematurely.
    expect(parseSpy).not.toHaveBeenCalled();
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
    expect(readStoredContacts()[pubkeyHex]).toBeUndefined();

    // The app's auto-generated identity becomes available (hydrated flips
    // true) — re-resolve with the SAME retained hash.
    const ownPubkeyHex = 'f'.repeat(64);
    const completed = resolveAddDeepLink(hash, true, ownPubkeyHex);

    expect(completed).toEqual({ state: 'complete', ok: true, pubkeyHex, reactivated: false, cachedNickname: true });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    // Assert the profile data is ACTUALLY applied post-hydration, not merely
    // that an "awaiting" state was returned at some point.
    expect(readContactEntry(pubkeyHex)?.nickname).toBe('Dana');
    expect(readStoredContacts()[pubkeyHex]).toBeDefined();
  });

  it('a bare-npub card (no profile) still completes the add once hydrated, with no cached nickname (AC-UX-5 fallback preserved)', () => {
    const pubkeyHex = 'c'.repeat(64);
    const npub = pubkeyToNpub(pubkeyHex);
    // A bare npub is not preceded by a #c= marker in real usage, but the page
    // only ever reaches this pure core with a #c= payload (a bare npub is not
    // routable via /add's hash contract) — exercised here via a raw payload
    // string carried in the marker to cover the "no profile" branch end-to-end.
    const hash = `#c=${npub}`;

    const awaiting = resolveAddDeepLink(hash, false, null);
    expect(awaiting).toEqual({ state: 'awaiting_identity' });

    const completed = resolveAddDeepLink(hash, true, null);
    expect(completed).toEqual({ state: 'complete', ok: true, pubkeyHex, reactivated: false, cachedNickname: false });
    expect(readContactEntry(pubkeyHex)).toBeUndefined();
    expect(readStoredContacts()[pubkeyHex]).toBeDefined();
  });
});
