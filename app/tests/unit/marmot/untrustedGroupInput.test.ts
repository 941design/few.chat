/**
 * Bug: untrusted-group-input-hardening.
 *
 * 1. A subject-carrying structured announcement (leave_intent,
 *    invite_cancelled, member_admitted, invite_lifecycle) whose subject pubkey
 *    is not canonical 64-char lowercase hex must be rejected by
 *    parseStructured — otherwise ChatBox feeds it to pubkeyToNpub, which
 *    throws and breaks the timeline render for every receiver.
 * 2. Group profile sync must apply the 1:1 avatar URL rules (shared
 *    predicate from dmProfile/kinds.ts): a rejected avatar is dropped, the
 *    rest of the profile (nickname, …) is kept.
 */
import { describe, it, expect } from 'vitest';
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import { pubkeyToNpub } from '@/src/lib/nostrKeys';
import { payloadToMemberProfile, type ProfilePayload } from '@/src/lib/marmot/profileSync';
import { isAllowedAvatarImageUrl, AVATAR_IMAGE_URL_MAX_LENGTH } from '@/src/lib/dmProfile/kinds';

const HEX = 'a'.repeat(64);
const HEX2 = '0123456789abcdef'.repeat(4);

/** Every subject-carrying announcement, built around a given subject pubkey. */
const SUBJECT_BUILDERS: Record<string, (pk: unknown) => Record<string, unknown>> = {
  leave_intent: (pk) => ({ type: 'leave_intent', pubkey: pk, name: 'Leaver' }),
  invite_cancelled: (pk) => ({ type: 'invite_cancelled', pubkey: pk, by: HEX2 }),
  member_admitted: (pk) => ({ type: 'member_admitted', pubkey: pk }),
  invite_lifecycle_invited: (pk) => ({ type: 'invite_lifecycle', event: 'invited', pubkey: pk }),
  invite_lifecycle_accepted: (pk) => ({ type: 'invite_lifecycle', event: 'accepted', pubkey: pk }),
  invite_lifecycle_declined: (pk) => ({ type: 'invite_lifecycle', event: 'declined', pubkey: pk }),
};

const MALFORMED_PUBKEYS: unknown[] = [
  'x',
  '',
  'aabb',
  'a'.repeat(63),
  'a'.repeat(65),
  'g'.repeat(64),
  'A'.repeat(64),
  ` ${'a'.repeat(63)}`,
  `${'a'.repeat(64)}\n`,
  `npub1${'a'.repeat(59)}`,
  42,
  null,
  ['a'.repeat(64)],
  { hex: 'a'.repeat(64) },
];

/** Deterministic PRNG (mulberry32) — no fast-check in this repo. */
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

const ALPHABET = '0123456789abcdefABCDEFghxyz -_:/\né';

function randomString(next: () => number): string {
  // Bias lengths around 64 so near-miss cases are well represented.
  const len = next() < 0.6 ? 60 + Math.floor(next() * 9) : Math.floor(next() * 130);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

describe('parseStructured — subject pubkeys must be canonical 64-char lowercase hex', () => {
  for (const [name, build] of Object.entries(SUBJECT_BUILDERS)) {
    it(`${name}: accepts a canonical subject pubkey`, () => {
      const parsed = parseStructured(JSON.stringify(build(HEX)));
      expect(parsed).not.toBeNull();
      expect((parsed as { pubkey: string }).pubkey).toBe(HEX);
    });

    it.each(MALFORMED_PUBKEYS.map((pk) => [JSON.stringify(pk), pk]))(
      `${name}: rejects malformed subject pubkey %s`,
      (_label, pk) => {
        expect(parseStructured(JSON.stringify(build(pk)))).toBeNull();
      },
    );

    it(`${name}: PROPERTY — parses iff the subject is /^[0-9a-f]{64}$/, and a parsed subject always npub-encodes`, () => {
      const next = rng(0xf00d + name.length);
      for (let i = 0; i < 400; i++) {
        const pk = randomString(next);
        const parsed = parseStructured(JSON.stringify(build(pk)));
        expect(parsed !== null).toBe(/^[0-9a-f]{64}$/.test(pk));
        if (parsed) {
          // The render path's npub encoding never throws for a parsed subject.
          expect(() => pubkeyToNpub((parsed as { pubkey: string }).pubkey)).not.toThrow();
        }
      }
    });
  }

  // Non-object JSON (null, numbers, strings) is plain text. NB the
  // `parsed?.type` → `parsed.type` mutants survive equivalently: the
  // resulting TypeError on `null` is swallowed by the same catch.
  it.each(['null', '42', '"leave_intent"', 'true', '[]'])('non-object JSON %s parses to null', (c) => {
    expect(parseStructured(c)).toBeNull();
  });

  it('the render-path encoder really does throw on the payload that motivated the fix', () => {
    expect(() => pubkeyToNpub('x')).toThrow();
  });

  it('leave_intent keeps its trimmed self-reported name on a canonical subject', () => {
    expect(parseStructured(JSON.stringify({ type: 'leave_intent', pubkey: HEX, name: '  Bob  ' })))
      .toEqual({ type: 'leave_intent', pubkey: HEX, name: 'Bob' });
  });

  it('invite_cancelled still requires a string `by`', () => {
    expect(parseStructured(JSON.stringify({ type: 'invite_cancelled', pubkey: HEX }))).toBeNull();
    expect(parseStructured(JSON.stringify({ type: 'invite_cancelled', pubkey: HEX, by: 7 }))).toBeNull();
    expect(parseStructured(JSON.stringify({ type: 'invite_cancelled', pubkey: HEX, by: HEX2 })))
      .toEqual({ type: 'invite_cancelled', pubkey: HEX, by: HEX2 });
  });
});

describe('group profile sync — avatar obeys the shared 1:1 avatar URL rules', () => {
  const base = (avatar: ProfilePayload['avatar']): ProfilePayload => ({
    nickname: 'Alice',
    avatar,
    updatedAt: '2026-10-15T00:00:00.000Z',
  });

  const REJECTED_URLS = [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'http://tracker.example/pixel.png',
    'ftp://example.test/a.png',
    'relative/path.png',
    '/abs/path.png',
    'https://',
    '//',
    'https://example.test/a b.png',
    `https://example.test/${'a'.repeat(AVATAR_IMAGE_URL_MAX_LENGTH)}`,
  ];

  it.each(REJECTED_URLS.map((u) => [u.slice(0, 40), u]))(
    'drops avatar %s but keeps the nickname',
    (_label, imageUrl) => {
      const member = payloadToMemberProfile(HEX, base({ imageUrl }));
      expect(member.avatar).toBeNull();
      expect(member.nickname).toBe('Alice');
      expect(member.pubkeyHex).toBe(HEX);
      expect(member.updatedAt).toBe('2026-10-15T00:00:00.000Z');
    },
  );

  it.each([
    'https://example.test/fox.png',
    '//few.chat/assets/fox.png',
    `https://e.t/${'a'.repeat(AVATAR_IMAGE_URL_MAX_LENGTH - 'https://e.t/'.length)}`,
  ])('keeps allowed avatar %s', (imageUrl) => {
    expect(payloadToMemberProfile(HEX, base({ imageUrl })).avatar).toEqual({ imageUrl });
  });

  it('a legacy avatar id is reconstructed and kept when the result is valid', () => {
    expect(payloadToMemberProfile(HEX, base({ id: 'fox' })).avatar)
      .toEqual({ imageUrl: '//few.chat/assets/fox.png' });
  });

  it('a legacy avatar id whose reconstruction is invalid (whitespace / oversize) is dropped', () => {
    expect(payloadToMemberProfile(HEX, base({ id: 'a b' })).avatar).toBeNull();
    expect(payloadToMemberProfile(HEX, base({ id: 'a'.repeat(600) })).avatar).toBeNull();
  });

  it('a non-string imageUrl from the wire is dropped', () => {
    const avatar = { imageUrl: 42 } as unknown as ProfilePayload['avatar'];
    expect(payloadToMemberProfile(HEX, base(avatar)).avatar).toBeNull();
  });

  it('PROPERTY — group sync keeps the avatar iff the shared 1:1 predicate accepts the URL', () => {
    const next = rng(0xa11ce);
    const prefixes = ['https://', '//', 'http://', 'javascript:', 'data:', '', 'HTTPS://', ' https://'];
    for (let i = 0; i < 400; i++) {
      const prefix = prefixes[Math.floor(next() * prefixes.length)];
      const bodyLen = next() < 0.2 ? 500 + Math.floor(next() * 30) : Math.floor(next() * 40);
      let body = '';
      for (let j = 0; j < bodyLen; j++) body += next() < 0.05 ? ' ' : 'abc/.-'[Math.floor(next() * 6)];
      const imageUrl = prefix + body;
      const member = payloadToMemberProfile(HEX, base({ imageUrl }));
      expect(member.avatar).toEqual(isAllowedAvatarImageUrl(imageUrl) ? { imageUrl } : null);
      expect(member.nickname).toBe('Alice');
    }
  });
});

describe('isAllowedAvatarImageUrl — the shared predicate', () => {
  it('rejects non-strings and the empty string', () => {
    for (const v of [undefined, null, 42, {}, '']) expect(isAllowedAvatarImageUrl(v)).toBe(false);
  });

  it('length cap is inclusive at AVATAR_IMAGE_URL_MAX_LENGTH', () => {
    const at = `https://${'a'.repeat(AVATAR_IMAGE_URL_MAX_LENGTH - 8)}`;
    expect(at.length).toBe(AVATAR_IMAGE_URL_MAX_LENGTH);
    expect(isAllowedAvatarImageUrl(at)).toBe(true);
    expect(isAllowedAvatarImageUrl(`${at}a`)).toBe(false);
  });
});
