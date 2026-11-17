import { describe, expect, it } from 'vitest';
import { buildGroupImetaTag } from '@/src/lib/media/imetaTag';
import { extractGroupAttachmentsByRole, groupAttachmentFingerprint } from '@/src/lib/media/imageMessage';
import { makeAttachment, makeTag } from './groupMediaFixtures';

describe('buildGroupImetaTag', () => {
  it('returns the library tag unchanged plus a trailing role field', () => {
    const lib = makeTag();
    const tag = buildGroupImetaTag([lib], 'full');
    expect(tag.slice(0, -1)).toEqual(lib);
    expect(tag[tag.length - 1]).toBe('role full');
    expect(buildGroupImetaTag([lib], 'thumb').at(-1)).toBe('role thumb');
  });

  it('does not mutate its input', () => {
    const lib = makeTag();
    const copy = [...lib];
    buildGroupImetaTag([lib], 'full');
    expect(lib).toEqual(copy);
  });

  it('carries the library metadata: version, locator, both hashes, nonce, type, filename, dim', () => {
    const a = makeAttachment({ thumbhash: 'abc' });
    const tag = buildGroupImetaTag([makeTag({ thumbhash: 'abc' })], 'full');
    expect(tag).toContain('v encrypted-media-v1');
    expect(tag).toContain(`locator blossom-v1 ${a.locators[0].value}`);
    expect(tag).toContain(`ciphertext_sha256 ${a.ciphertextSha256}`);
    expect(tag).toContain(`plaintext_sha256 ${a.plaintextSha256}`);
    expect(tag).toContain(`nonce ${a.nonce}`);
    expect(tag).toContain('m image/webp');
    expect(tag).toContain('filename photo.webp');
    expect(tag).toContain('dim 800x600');
    expect(tag).toContain('thumbhash abc');
  });

  it.each([
    ['no tag', []],
    ['two tags', [makeTag(), makeTag()]],
    ['a non-imeta tag', [['p', 'x']]],
    ['a legacy mip04 tag', [['imeta', 'url https://blossom.band/x', 'm image/webp', 'x ' + 'a'.repeat(64), 'v mip04-v2', 'n ' + 'b'.repeat(24)]]],
    ['a blurhash field (invalid in encrypted-media-v1)', [[...makeTag(), 'blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj']]],
  ])('rejects %s', (_name, input) => {
    expect(() => buildGroupImetaTag(input as string[][], 'full')).toThrow(TypeError);
  });

  it('rejects an http Blossom server: the library codec drops such a locator, so no receiver could render it', () => {
    const tag = makeTag({ locators: [{ kind: 'blossom-v1', value: 'http://blossom.band/' + 'c'.repeat(64) }] });
    expect(() => buildGroupImetaTag([tag], 'full')).toThrow(/https/);
  });

  it('rejects a loopback or private Blossom locator', () => {
    for (const host of ['https://localhost', 'https://127.0.0.1', 'https://192.168.1.5']) {
      const tag = makeTag({ locators: [{ kind: 'blossom-v1', value: `${host}/${'c'.repeat(64)}` }] });
      expect(() => buildGroupImetaTag([tag], 'full')).toThrow(TypeError);
    }
  });

  it('rejects a cache-only locator (nothing a receiver could fetch)', () => {
    const tag = makeTag({ locators: [{ kind: 'marmot-cache-v1', value: `https://cache.invalid/${'c'.repeat(64)}` }] });
    expect(() => buildGroupImetaTag([tag], 'full')).toThrow(/blossom-v1/);
  });

  it('rejects a tag that already has a role, and an unknown role', () => {
    expect(() => buildGroupImetaTag([makeTag({}, ['role thumb'])], 'full')).toThrow(/already/);
    expect(() => buildGroupImetaTag([makeTag()], 'other' as never)).toThrow(TypeError);
  });
});

describe('extractGroupAttachmentsByRole', () => {
  it('separates full from thumb and keeps the original tag for decryptMedia', () => {
    const full = buildGroupImetaTag([makeTag({ filename: 'a.webp', ciphertextSha256: '1'.repeat(64) })], 'full');
    const thumb = buildGroupImetaTag([makeTag({ filename: 'a.thumb.webp', ciphertextSha256: '2'.repeat(64) })], 'thumb');
    const out = extractGroupAttachmentsByRole([thumb, ['p', 'x'], full]);
    expect(out.full?.attachment.filename).toBe('a.webp');
    expect(out.full?.imeta).toEqual(full);
    expect(out.thumb?.attachment.filename).toBe('a.thumb.webp');
    expect(out.thumb?.imeta).toEqual(thumb);
  });

  it('treats a missing role as full', () => {
    const out = extractGroupAttachmentsByRole([makeTag()]);
    expect(out.full).not.toBeNull();
    expect(out.thumb).toBeNull();
  });

  it('skips tags the library codec rejects instead of partially trusting them', () => {
    const legacy = ['imeta', 'url https://blossom.band/x', 'm image/webp', 'x ' + 'a'.repeat(64), 'v mip04-v2', 'n ' + 'b'.repeat(24), 'role full'];
    const http = makeTag({ locators: [{ kind: 'blossom-v1', value: 'http://blossom.band/' + 'c'.repeat(64) }] });
    expect(extractGroupAttachmentsByRole([legacy, http])).toEqual({ full: null, thumb: null });
    expect(extractGroupAttachmentsByRole([])).toEqual({ full: null, thumb: null });
  });

  it('first valid tag of a role wins: a later duplicate cannot replace the attachment', () => {
    const first = makeTag({ filename: 'first.webp' }, ['role full']);
    const second = makeTag({ filename: 'second.webp' }, ['role full']);
    expect(extractGroupAttachmentsByRole([first, second]).full?.attachment.filename).toBe('first.webp');
  });

  it('ignores a malformed (non-array) entry', () => {
    expect(() => extractGroupAttachmentsByRole([null as never, makeTag()])).not.toThrow();
  });
});

describe('groupAttachmentFingerprint', () => {
  const base = { ciphertextSha256: 'a'.repeat(64), plaintextSha256: 'b'.repeat(64), nonce: 'c'.repeat(24), version: 'encrypted-media-v1' };

  it('is deterministic', () => {
    expect(groupAttachmentFingerprint(base)).toBe(groupAttachmentFingerprint({ ...base }));
  });

  it.each(['ciphertextSha256', 'plaintextSha256', 'nonce', 'version'] as const)('differs when only %s differs (a forged record cannot hit an honest slot)', (field) => {
    expect(groupAttachmentFingerprint({ ...base, [field]: 'z'.repeat(base[field].length) })).not.toBe(groupAttachmentFingerprint(base));
  });
});
