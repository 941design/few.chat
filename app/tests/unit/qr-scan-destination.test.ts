import { afterEach, describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { vi } from 'vitest';
import { resolveScanDestination } from '@/src/lib/qr';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { encodeCard, base64UrlToBytes, bytesToBase64Url, buildShareUrl } from '@/src/lib/contactCard';
import { pubkeyToNpub } from '@/src/lib/nostrKeys';
import { buildInviteUrl, generateNonce } from '@/src/lib/marmot/inviteLinkGeneration';

/**
 * S1 (epic: mobile-qr-scanner) — coverage for `resolveScanDestination`, the
 * `ScanDestination` seam `QrScanFab` (S2) consumes without further shape
 * verification. Kept as its own file (rather than extending qr.test.ts /
 * qr.mutation-gaps.test.ts) so the new routing seam's test surface is
 * separately auditable from the pre-existing card-decode tests it does not
 * modify (stories.json S1 notes).
 *
 * Card fixtures are built through the REAL signing pipeline
 * (`encodeCard` + `createPrivateKeySigner`), mirroring
 * `tests/unit/cards/contactCard.test.ts` — this is a round-trip-via-real-
 * producer test, not a shadow-init that re-implements the codec. Group
 * invite fixtures are built through the REAL `buildInviteUrl` /
 * `generateNonce` generator, mirroring the exact shape the app itself
 * produces (marmot/inviteLinkGeneration.ts).
 */

const FIXED_CREATED_AT = 1735689600; // 2025-01-01T00:00:00Z

function makeIdentity() {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const signer = createPrivateKeySigner(skHex);
  return { skHex, pubkeyHex, signer };
}

async function makeSignedCardPayload(nickname = 'Alice'): Promise<string> {
  const { pubkeyHex, signer } = makeIdentity();
  return encodeCard(pubkeyHex, { nickname, createdAt: FIXED_CREATED_AT }, signer.signEvent);
}

/** Flips a byte inside the signed card's name field — same tamper technique as AC-SIG-2 in contactCard.test.ts. */
function tamperSignature(payload: string): string {
  const bytes = base64UrlToBytes(payload)!;
  const nameOffset = 1 + 32 + 4 + 1; // header + pubkey + created_at + name_len
  const mutated = new Uint8Array(bytes);
  mutated[nameOffset] = mutated[nameOffset] ^ 0x02;
  return bytesToBase64Url(mutated);
}

function parseDestParams(dest: string): Record<string, string> {
  const query = dest.split('?')[1] ?? '';
  return Object.fromEntries(new URLSearchParams(query).entries());
}

// ── AC-ROUTE-1 — every card value form that parseContactCard accepts ──────

describe('AC-ROUTE-1: card branch — every accepted value form', () => {
  it('routes a bare npub to /add#c=<npub>', async () => {
    const { pubkeyHex } = makeIdentity();
    const npub = pubkeyToNpub(pubkeyHex);
    expect(resolveScanDestination(npub)).toBe(`/add#c=${npub}`);
  });

  it('routes a nostr:-prefixed npub to /add#c=<npub> (prefix stripped)', async () => {
    const { pubkeyHex } = makeIdentity();
    const npub = pubkeyToNpub(pubkeyHex);
    expect(resolveScanDestination(`nostr:${npub}`)).toBe(`/add#c=${npub}`);
  });

  it('routes a raw base64url card payload to /add#c=<payload>', async () => {
    const payload = await makeSignedCardPayload();
    expect(resolveScanDestination(payload)).toBe(`/add#c=${payload}`);
  });

  it('routes a full https://few.chat/add#c=<payload> link to /add#c=<payload> (marker-extracted, not double-wrapped)', async () => {
    const payload = await makeSignedCardPayload();
    const link = buildShareUrl(payload);
    expect(link).toBe(`https://few.chat/add#c=${payload}`);
    expect(resolveScanDestination(link)).toBe(`/add#c=${payload}`);
  });

  it('routes a valid card link on a non-few.chat origin to /add#c=<payload> (origin-agnostic)', async () => {
    const payload = await makeSignedCardPayload();
    const link = `https://few-chat.pages.dev/add#c=${payload}`;
    expect(resolveScanDestination(link)).toBe(`/add#c=${payload}`);
  });

  it('routes a valid card link at the trailing-slash /add/ variant to /add#c=<payload>', async () => {
    const payload = await makeSignedCardPayload();
    const link = `https://few.chat/add/#c=${payload}`;
    expect(resolveScanDestination(link)).toBe(`/add#c=${payload}`);
  });
});

// ── AC-ROUTE-5 — arbitrary-domain URL merely embedding a #c= fragment ─────

describe('AC-ROUTE-5: an absolute URL embedding a valid #c= fragment at the wrong path is rejected', () => {
  it('rejects an arbitrary-domain URL whose fragment embeds an otherwise-valid card payload', async () => {
    const payload = await makeSignedCardPayload();
    expect(resolveScanDestination(`https://example.com/anything#c=${payload}`)).toBeNull();
  });

  it('rejects a few.chat URL whose path is neither /add nor /groups/ but embeds a valid #c= fragment', async () => {
    const payload = await makeSignedCardPayload();
    expect(resolveScanDestination(`https://few.chat/somewhere-else#c=${payload}`)).toBeNull();
  });

  // gate-remediation Finding 2: the card gate must close on the `#c=`
  // marker, not on scheme — `parseWebUrl` alone returns null for any
  // non-http(s) scheme, which previously let a `nostr:`-prefixed or
  // otherwise non-http(s) URL slip an embedded `#c=` fragment past the
  // pathname check.
  it('rejects a nostr:-prefixed off-/add URL embedding a valid #c= payload', async () => {
    const payload = await makeSignedCardPayload();
    expect(resolveScanDestination(`nostr:https://evil.example/steal#c=${payload}`)).toBeNull();
  });

  it('rejects a non-http scheme (ftp://) embedding a valid #c= payload', async () => {
    const payload = await makeSignedCardPayload();
    expect(resolveScanDestination(`ftp://evil.example/x#c=${payload}`)).toBeNull();
  });

  it('still routes a legitimate nostr:-prefixed bare npub (no #c= marker)', async () => {
    const { pubkeyHex } = makeIdentity();
    const npub = pubkeyToNpub(pubkeyHex);
    expect(resolveScanDestination(`nostr:${npub}`)).toBe(`/add#c=${npub}`);
  });
});

// ── AC-ROUTE-3 — signature-failing card ────────────────────────────────────

describe('AC-ROUTE-3: a signature-failing card returns null, never a downgraded destination', () => {
  it('rejects a card whose signature was tampered with', async () => {
    const payload = await makeSignedCardPayload();
    const tampered = tamperSignature(payload);
    expect(resolveScanDestination(tampered)).toBeNull();
  });

  it('rejects the tampered card even wrapped in the full share-link form', async () => {
    const payload = await makeSignedCardPayload();
    const tampered = tamperSignature(payload);
    expect(resolveScanDestination(buildShareUrl(tampered))).toBeNull();
  });
});

// ── AC-ROUTE-2 / AC-ROUTE-6 — group-invite branch ──────────────────────────

describe('AC-ROUTE-2: group-invite branch — well-formed invite resolves, params preserved verbatim', () => {
  it('routes a well-formed few.chat invite to /groups?join=&admin=&name=', () => {
    const nonce = generateNonce();
    const { pubkeyHex } = makeIdentity();
    const adminNpub = pubkeyToNpub(pubkeyHex);
    const url = buildInviteUrl({ nonce, adminNpub, groupName: 'Book Club' });
    expect(url.startsWith('https://few.chat/groups/')).toBe(true);

    const dest = resolveScanDestination(url);
    expect(dest).not.toBeNull();
    expect(dest!.startsWith('/groups?')).toBe(true);
    expect(parseDestParams(dest!)).toEqual({ join: nonce, admin: adminNpub, name: 'Book Club' });
  });

  it('preserves a name containing spaces and unicode verbatim', () => {
    const nonce = generateNonce();
    const { pubkeyHex } = makeIdentity();
    const adminNpub = pubkeyToNpub(pubkeyHex);
    const groupName = 'Café Société 🎉';
    const url = buildInviteUrl({ nonce, adminNpub, groupName });
    const dest = resolveScanDestination(url);
    expect(parseDestParams(dest!)).toEqual({ join: nonce, admin: adminNpub, name: groupName });
  });
});

describe('AC-ROUTE-6: origin-agnostic — non-few.chat origins are accepted identically', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts an invite built from a few-chat.pages.dev origin', () => {
    vi.stubGlobal('window', { location: { origin: 'https://few-chat.pages.dev' } });
    const nonce = generateNonce();
    const { pubkeyHex } = makeIdentity();
    const adminNpub = pubkeyToNpub(pubkeyHex);
    const url = buildInviteUrl({ nonce, adminNpub, groupName: 'Team' });
    expect(url.startsWith('https://few-chat.pages.dev/groups/')).toBe(true);

    const dest = resolveScanDestination(url);
    expect(parseDestParams(dest!)).toEqual({ join: nonce, admin: adminNpub, name: 'Team' });
  });

  it('accepts an invite built from a localhost dev origin', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });
    const nonce = generateNonce();
    const { pubkeyHex } = makeIdentity();
    const adminNpub = pubkeyToNpub(pubkeyHex);
    const url = buildInviteUrl({ nonce, adminNpub, groupName: 'Team' });
    expect(url.startsWith('http://localhost:3000/groups/')).toBe(true);

    const dest = resolveScanDestination(url);
    expect(parseDestParams(dest!)).toEqual({ join: nonce, admin: adminNpub, name: 'Team' });
  });

  it('directly constructed URL literal proves origin is never read/compared', () => {
    const nonce = generateNonce();
    const { pubkeyHex } = makeIdentity();
    const adminNpub = pubkeyToNpub(pubkeyHex);
    const url = `https://totally-unrelated-domain.example/groups/?join=${nonce}&admin=${encodeURIComponent(adminNpub)}&name=Test`;
    const dest = resolveScanDestination(url);
    expect(parseDestParams(dest!)).toEqual({ join: nonce, admin: adminNpub, name: 'Test' });
  });
});

// ── AC-ROUTE-4 — group-invite-shaped URL rejected for each malformed reason ─

describe('AC-ROUTE-4: group-invite validator rejects malformed/incomplete invites', () => {
  function makeBaseUrl(overrides: Partial<{ join: string; admin: string; name: string }> = {}) {
    const nonce = generateNonce();
    const npub = pubkeyToNpub('f'.repeat(64));
    const url = new URL('https://few.chat/groups/');
    const join = overrides.join === undefined ? nonce : overrides.join;
    const admin = overrides.admin === undefined ? npub : overrides.admin;
    const name = overrides.name === undefined ? 'Team' : overrides.name;
    if (join !== null) url.searchParams.set('join', join);
    if (admin !== null) url.searchParams.set('admin', admin);
    if (name !== null) url.searchParams.set('name', name);
    return url.toString();
  }

  it('rejects when join is missing', () => {
    const url = makeBaseUrl({ join: null as unknown as string });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when admin is missing', () => {
    const url = makeBaseUrl({ admin: null as unknown as string });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when name is missing', () => {
    const url = makeBaseUrl({ name: null as unknown as string });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when admin is not a valid npub', () => {
    const url = makeBaseUrl({ admin: 'not-an-npub' });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when admin is a well-formed-looking but undecodable npub', () => {
    const url = makeBaseUrl({ admin: 'npub1invalidgarbage' });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when join is not well-formed hex (too short)', () => {
    const url = makeBaseUrl({ join: 'abc123' });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when join is not well-formed hex (non-hex characters)', () => {
    const url = makeBaseUrl({ join: 'z'.repeat(32) });
    expect(resolveScanDestination(url)).toBeNull();
  });

  it('rejects when join is too long', () => {
    const url = makeBaseUrl({ join: 'a'.repeat(40) });
    expect(resolveScanDestination(url)).toBeNull();
  });

  // gate-remediation Finding 4: generateNonce() only ever emits lowercase
  // hex, so an uppercase-hex join nonce must fail closed at the scanner
  // rather than pass here and (plausibly) fail a case-sensitive downstream
  // match silently.
  it('rejects when join is uppercase hex (generateNonce never emits uppercase)', () => {
    const url = makeBaseUrl({ join: 'A'.repeat(32) });
    expect(resolveScanDestination(url)).toBeNull();
  });
});

// ── AC-ROUTE-5 — arbitrary non-few.chat values ─────────────────────────────

describe('AC-ROUTE-5: arbitrary values fall through to null', () => {
  it('rejects plain text', () => {
    expect(resolveScanDestination('hello world')).toBeNull();
  });

  it('rejects a random unrelated https:// URL', () => {
    expect(resolveScanDestination('https://example.com/some/other/page')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(resolveScanDestination('')).toBeNull();
  });

  it('rejects a /groups/ URL with no invite params at all', () => {
    expect(resolveScanDestination('https://few.chat/groups/')).toBeNull();
  });

  it('rejects a /groups/ URL with unrelated params', () => {
    expect(resolveScanDestination('https://few.chat/groups/?id=abc123')).toBeNull();
  });

  it('rejects a well-formed invite missing only its trailing slash (/groups, not /groups/)', () => {
    const nonce = generateNonce();
    const npub = pubkeyToNpub('f'.repeat(64));
    expect(resolveScanDestination(`https://few.chat/groups?join=${nonce}&admin=${npub}&name=Team`)).toBeNull();
  });
});

// ── VQ-S1-006 — never throws for adversarial input ─────────────────────────

describe('resolveScanDestination never throws for any string input', () => {
  const adversarialInputs = [
    '',
    ' ',
    'javascript:alert(1)',
    'not a url at all ://///',
    'https://',
    'https://few.chat/groups/?join=&admin=&name=',
    '#c=',
    'nostr:',
    'npub1',
    'a'.repeat(10000),
    '🎉'.repeat(500),
    'https://[::1]:badport/groups/',
    'https://few.chat/groups/?join=' + 'g'.repeat(32) + '&admin=npub1x&name=%',
    '   \t\n  ',
  ];

  it.each(adversarialInputs)('does not throw for %j', (input) => {
    expect(() => resolveScanDestination(input)).not.toThrow();
  });

  it('returns null (not a throw) for every adversarial input above', () => {
    for (const input of adversarialInputs) {
      expect(resolveScanDestination(input)).toBeNull();
    }
  });
});
