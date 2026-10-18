import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { encodeCard, encodeCardV2, parseContactCard } from '@/src/lib/contactCard';
import { importCard } from '@/src/lib/contactCardImport';
import { readContactEntry, writeContactEntry } from '@/src/lib/contactCache';
import { connectNdk, getNdk } from '@/src/lib/ndkClient';
import type { ProfileAvatar } from '@/src/types';

// AC-SEC-1 behavioral guard: the real write path is
// importCard -> writeContactEntry -> rememberContact -> rememberKnownPeers,
// which the static grep below never scans. Mocking ndkClient's entry points
// lets us assert — spoof-resistant, not string-matched — that the full
// encode -> parse -> import cycle never reaches an NDK-client call, however
// deep the call chain that would emit relay traffic actually is.
vi.mock('@/src/lib/ndkClient', () => ({
  PUBLISH_TIMEOUT_MS: 10_000,
  publishWithTimeout: vi.fn().mockResolvedValue(new Set()),
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

function makeIdentity() {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  return { skHex, pubkeyHex, signer };
}

// Build a real, signed card and run it through the whole S1->S2 seam
// (encodeCard -> parseContactCard -> importCard), returning both the
// parsed profile and the resulting pubkeyHex for assertions.
async function buildAndParseCard(pubkeyHex: string, signer: ReturnType<typeof createPrivateKeySigner>, nickname: string, createdAt: number) {
  const payload = await encodeCard(pubkeyHex, { nickname, createdAt }, signer.signEvent);
  const parsed = parseContactCard(payload);
  if ('error' in parsed || !('profile' in parsed)) {
    throw new Error('unreachable: expected a signed card with a profile');
  }
  return parsed as { pubkeyHex: string; profile: { nickname: string; updatedAt: string } };
}

/** v2 (pairing-card) analogue of buildAndParseCard (epic: contact-pairing-code, S4). */
async function buildAndParsePairingCard(
  pubkeyHex: string,
  signer: ReturnType<typeof createPrivateKeySigner>,
  nickname: string,
  createdAt: number,
  nonceHex: string,
  expiresAt: number,
) {
  const encoded = await encodeCardV2(pubkeyHex, { nickname, createdAt }, nonceHex, expiresAt, signer.signEvent);
  const parsed = parseContactCard(encoded.cardB64Url);
  if ('error' in parsed || !('profile' in parsed)) {
    throw new Error('unreachable: expected a signed v2 card with a profile');
  }
  return parsed as { pubkeyHex: string; profile: { nickname: string; updatedAt: string }; pairing?: { nonce: string; expiresAt: number } };
}

beforeEach(() => {
  localStorageMock.clear();
});

// ── AC-CACHE-1 — fresh import upserts the cache ─────────────────────────────

describe('AC-CACHE-1: importing a valid signed card upserts contactCache', () => {
  it('writes nickname and the exact ISO-8601 updatedAt derived from created_at, returning cached: true', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const createdAt = 1735689600; // 2025-01-01T00:00:00Z
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'Alice', createdAt);

    const result = importCard(parsed.pubkeyHex, parsed.profile);

    expect(result).toEqual({ pubkeyHex, cached: true });

    const entry = readContactEntry(pubkeyHex);
    expect(entry).toBeDefined();
    expect(entry!.nickname).toBe('Alice');
    expect(entry!.updatedAt).toBe(new Date(createdAt * 1000).toISOString());
  });
});

// ── AC-CACHE-2 — cross-source LWW: a newer non-card entry wins ─────────────

describe('AC-CACHE-2: cross-source last-write-wins favors a newer non-card entry', () => {
  it('does not overwrite a newer cache entry written by another source (e.g. MLS profile sync)', async () => {
    const { pubkeyHex, signer } = makeIdentity();

    // Simulate an MLS-profile-sync write that is NEWER than the card we are about to import.
    const newerUpdatedAt = '2025-06-01T00:00:00.000Z';
    writeContactEntry(pubkeyHex, {
      nickname: 'Synced Name',
      avatar: null,
      updatedAt: newerUpdatedAt,
    });

    // An older signed card for the same pubkey (created_at well before June 2025).
    const olderCreatedAt = 1704067200; // 2024-01-01T00:00:00Z
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'Older Card Name', olderCreatedAt);

    const result = importCard(parsed.pubkeyHex, parsed.profile);

    expect(result).toEqual({ pubkeyHex, cached: false });

    const entry = readContactEntry(pubkeyHex);
    expect(entry!.nickname).toBe('Synced Name');
    expect(entry!.updatedAt).toBe(newerUpdatedAt);
  });
});

// ── AC-CACHE-3 — idempotency ─────────────────────────────────────────────────

describe('AC-CACHE-3: importing the identical card payload twice is idempotent', () => {
  it('leaves the cache entry deep-equal after a second import, which reports cached: false', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const createdAt = 1735689600;
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'Alice', createdAt);

    const first = importCard(parsed.pubkeyHex, parsed.profile);
    const entryAfterFirst = readContactEntry(pubkeyHex);

    const second = importCard(parsed.pubkeyHex, parsed.profile);
    const entryAfterSecond = readContactEntry(pubkeyHex);

    expect(first).toEqual({ pubkeyHex, cached: true });
    expect(second).toEqual({ pubkeyHex, cached: false });
    expect(entryAfterSecond).toEqual(entryAfterFirst);
  });
});

// ── AC-CACHE-4 — avatar preservation across a name-only card import ────────

describe('AC-CACHE-4: importing a card never clobbers a previously-cached avatar', () => {
  it('keeps the seeded avatar unchanged while updating the nickname from a newer name-only card', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const avatar: ProfileAvatar = { imageUrl: 'https://example.com/avatar.png' };

    writeContactEntry(pubkeyHex, {
      nickname: 'Old Name',
      avatar,
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // A newer signed card, name-only (no avatar concept in the card format).
    const newerCreatedAt = 1735689600; // 2025-01-01T00:00:00Z
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'New Name', newerCreatedAt);

    const result = importCard(parsed.pubkeyHex, parsed.profile);
    expect(result).toEqual({ pubkeyHex, cached: true });

    const entry = readContactEntry(pubkeyHex);
    expect(entry!.nickname).toBe('New Name');
    expect(entry!.avatar).toEqual(avatar);
  });
});

// ── epic: contact-pairing-code, story S4 — importCard is pairing-agnostic ──

describe('importCard is unaffected by a v2 (pairing) card\'s extra `pairing` field', () => {
  it('imports the profile half of a parsed v2 card identically to a v1 card (nickname, ISO updatedAt, cached: true)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const createdAt = 1735689600;
    const parsed = await buildAndParsePairingCard(pubkeyHex, signer, 'Nora', createdAt, 'aa'.repeat(16), createdAt + 1800);

    // Sanity: the parse really did carry a pairing field (S1's ParsedPairingCard
    // seam) — this test would be vacuous otherwise.
    expect(parsed.pairing).toEqual({ nonce: 'aa'.repeat(16), expiresAt: createdAt + 1800 });

    // importCard's own signature only ever takes `profile` — the pairing
    // field is never passed to it and never influences the cache write.
    const result = importCard(parsed.pubkeyHex, parsed.profile);

    expect(result).toEqual({ pubkeyHex, cached: true });
    const entry = readContactEntry(pubkeyHex);
    expect(entry!.nickname).toBe('Nora');
    expect(entry!.updatedAt).toBe(new Date(createdAt * 1000).toISOString());
  });

  it('LWW still holds for a v2 card\'s profile import (a newer non-card entry is not clobbered)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const newerUpdatedAt = '2025-06-01T00:00:00.000Z';
    writeContactEntry(pubkeyHex, { nickname: 'Synced Name', avatar: null, updatedAt: newerUpdatedAt });

    const olderCreatedAt = 1704067200;
    const parsed = await buildAndParsePairingCard(pubkeyHex, signer, 'Older Pairing Name', olderCreatedAt, 'bb'.repeat(16), olderCreatedAt + 1800);

    const result = importCard(parsed.pubkeyHex, parsed.profile);

    expect(result).toEqual({ pubkeyHex, cached: false });
    expect(readContactEntry(pubkeyHex)!.nickname).toBe('Synced Name');
  });
});

// ── AC-SEC-1 — no relay events emitted by encode/parse/import ──────────────

describe('AC-SEC-1: encode -> parse -> import emits zero relay events', () => {
  it('contains no NDK reference, no .publish( call, and no relay-URL-shaped string in the source of contactCardImport.ts or contactCard.ts', () => {
    const importSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/lib/contactCardImport.ts'), 'utf8');
    const cardSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/lib/contactCard.ts'), 'utf8');

    for (const [label, src] of [['contactCardImport.ts', importSrc], ['contactCard.ts', cardSrc]] as const) {
      // Bare "NDK" is deliberately not checked here: contactCard.ts's own header
      // comment documents the absence ("no relay, no NDK, no MarmotContext"), so
      // a naive word-boundary match would false-positive on that very disclaimer.
      // An actual NDK dependency would show up as an import from the package.
      expect(src, `${label} should not import @nostr-dev-kit/ndk`).not.toMatch(/@nostr-dev-kit\/ndk/);
      expect(src, `${label} should not call .publish(`).not.toMatch(/\.publish\(/);
      expect(src, `${label} should not contain a relay-URL-shaped string`).not.toMatch(/wss?:\/\//);
    }
  });

  it('runs the full encode -> parse -> import cycle without throwing or hanging (no attempted network call)', async () => {
    const { pubkeyHex, signer } = makeIdentity();
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'Alice', 1735689600);
    expect(() => importCard(parsed.pubkeyHex, parsed.profile)).not.toThrow();
  });

  it('never calls into the NDK client (getNdk/connectNdk) across the full encode -> parse -> import cycle', async () => {
    vi.mocked(getNdk).mockClear();
    vi.mocked(connectNdk).mockClear();

    const { pubkeyHex, signer } = makeIdentity();
    const parsed = await buildAndParseCard(pubkeyHex, signer, 'Bob', 1735689600);
    importCard(parsed.pubkeyHex, parsed.profile);

    // Behavioral, not string-matched: even if the write path grows through
    // writeContactEntry -> rememberContact -> rememberKnownPeers (unscanned
    // by the leaf-file grep above), a relay-emitting regression would show
    // up here as a call to one of NDK's own entry points.
    expect(getNdk).not.toHaveBeenCalled();
    expect(connectNdk).not.toHaveBeenCalled();
  });
});

// ── AC-SEC-2 — repo-wide: no publishIdentityToRelays / kind:0-adjacent publish ──

describe('AC-SEC-2: NostrIdentityContext and the repo never auto-publish identity to relays', () => {
  it('NostrIdentityContext.tsx source contains no publishIdentityToRelays', () => {
    // The repo-wide publishIdentityToRelays walk below is the strong guard.
    // A `/kind:\s*0\b/` regex was deliberately dropped here: it false-positives
    // on any benign `kind: 0` read (e.g. a filter or a comment) and
    // false-negatives on `kind: KIND_METADATA` or `event.kind = 0`, so it
    // asserted nothing a determined regression couldn't dodge.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/context/NostrIdentityContext.tsx'),
      'utf8',
    );

    expect(src).not.toMatch(/publishIdentityToRelays/);
  });

  it('no file under app/src contains the literal string publishIdentityToRelays', () => {
    const srcRoot = path.resolve(__dirname, '../../../src');

    function walk(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(walk(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    }

    const files = walk(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const matches = files.filter((file) => fs.readFileSync(file, 'utf8').includes('publishIdentityToRelays'));
    expect(matches).toEqual([]);
  });
});
