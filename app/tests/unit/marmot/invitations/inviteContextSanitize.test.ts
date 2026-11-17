/**
 * AC-CTX-2: `sanitizeContextName` on hostile and on legitimate international names. Characters are built from code
 * points (never typed literally) so the cases stay readable and cannot be altered by an editor.
 */
import { describe, expect, it } from 'vitest';
import { MAX_COMBINING_MARKS_PER_BASE, MAX_CONTEXT_NAME_LENGTH, sanitizeContextName } from '@/src/lib/marmot/invitations';

const c = (...cps: number[]) => String.fromCodePoint(...cps);
const ZWJ = c(0x200d);

describe('legitimate emoji names survive unchanged (ZWJ kept between pictographs)', () => {
  it.each([
    ['family', c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)],
    ['rainbow flag', c(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)],
    ['profession with skin tone', c(0x1f469, 0x1f3fd, 0x200d, 0x2695, 0xfe0f)],
    ['inside a word', `Team ${c(0x1f468, 0x200d, 0x1f4bb)} dev`],
  ])('%s', (_label, name) => {
    expect(sanitizeContextName(name)).toBe(name);
  });
  it('a ZWJ that does not join two pictographs is removed', () => {
    expect(sanitizeContextName(`a${ZWJ}b`)).toBe('ab');
    expect(sanitizeContextName(`${c(0x1f468)}${ZWJ}x`)).toBe(`${c(0x1f468)}x`);
    expect(sanitizeContextName(`x${ZWJ}${c(0x1f468)}`)).toBe(`x${c(0x1f468)}`);
    expect(sanitizeContextName(`${c(0x1f468)}${ZWJ}`)).toBe(c(0x1f468));
  });
});

describe('invisible characters are removed, not replaced by a space', () => {
  it('a zero-width space inside a word does not split it', () => {
    expect(sanitizeContextName(`a${c(0x200b)}b`)).toBe('ab');
  });
  it.each([
    ['zero-width space/joiner marks', [0x200b, 0x200c, 0x200e, 0x200f]],
    ['bidi embeddings and overrides', [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]],
    ['bidi isolates', [0x2066, 0x2067, 0x2068, 0x2069]],
    ['word joiner and invisible operators', [0x2060, 0x2061, 0x2062, 0x2063, 0x2064]],
    ['byte order mark', [0xfeff]],
    ['soft hyphen', [0x00ad]],
    ['arabic letter mark', [0x061c]],
    ['interlinear annotation', [0xfff9, 0xfffa, 0xfffb]],
    ['mongolian vowel separator', [0x180e]],
    ['tag characters', [0xe0001, 0xe0020, 0xe0041, 0xe007f]],
    ['hangul fillers', [0x115f, 0x1160, 0x3164, 0xffa0]],
    ['braille blank', [0x2800]],
  ])('%s are removed', (_label, cps) => {
    expect(sanitizeContextName(`x${c(...cps)}y`)).toBe('xy');
  });
  it('C0/C1 controls and line separators still become a space', () => {
    expect(sanitizeContextName(`a${c(0)}b`)).toBe('a b');
    expect(sanitizeContextName(`a${c(0x85)}b`)).toBe('a b');
    expect(sanitizeContextName(`a${c(0x2028)}b${c(0x2029)}c`)).toBe('a b c');
    expect(sanitizeContextName('a\r\nb\tc')).toBe('a b c');
  });
  it('a name with no visible character is empty (generic label)', () => {
    expect(sanitizeContextName(c(0x3164, 0x2800, 0x200b, 0xffa0))).toBe('');
    expect(sanitizeContextName(` ${c(0x3164)} ${c(0x115f)} `)).toBe('');
    expect(sanitizeContextName(c(0x301, 0x302))).toBe(''); // only combining marks
    expect(sanitizeContextName(c(0x200d))).toBe('');
  });
});

describe('ZWNJ is kept between two letters only (Persian / Indic orthography)', () => {
  const ZWNJ = c(0x200c);
  const persian = (...cps: number[]) => c(...cps);
  const MIKHAHAM = persian(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645); // "mi-khaham": internal ZWNJ
  it('a Persian word with an internal ZWNJ round-trips unchanged', () => {
    expect(sanitizeContextName(MIKHAHAM)).toBe(MIKHAHAM);
    expect(sanitizeContextName(`${MIKHAHAM} ${MIKHAHAM}`)).toBe(`${MIKHAHAM} ${MIKHAHAM}`);
  });
  it('a combining mark attached to the first letter does not block it', () => {
    const name = `${c(0x628, 0x64e)}${ZWNJ}${c(0x62a)}`;
    expect(sanitizeContextName(name)).toBe(name);
  });
  it('an Indic ZWNJ between letters is kept (Devanagari)', () => {
    const name = c(0x915, 0x94d, 0x200c, 0x937);
    expect(sanitizeContextName(name)).toBe(name);
  });
  it.each([
    ['trailing', `a${ZWNJ}`, 'a'],
    ['leading', `${ZWNJ}a`, 'a'],
    ['next to a space (before)', `a${ZWNJ} b`, 'a b'],
    ['next to a space (after)', `a ${ZWNJ}b`, 'a b'],
    ['after a control turned into a space', `a\t${ZWNJ}b`, 'a b'],
    ['next to a digit', `a${ZWNJ}1`, 'a1'],
    ['next to punctuation', `a${ZWNJ}!`, 'a!'],
    ['between two digits', `1${ZWNJ}2`, '12'],
    ['between non-letters', `!${ZWNJ}?`, '!?'],
  ])('%s: removed', (_label, input, expected) => {
    expect(sanitizeContextName(input)).toBe(expected);
  });
  it('a doubled ZWNJ between letters is removed entirely (no joiner remains)', () => {
    expect(sanitizeContextName(`a${ZWNJ}${ZWNJ}b`)).toBe('ab');
    expect(sanitizeContextName(ZWNJ + ZWNJ)).toBe('');
  });
  it('a single ZWNJ between two Latin letters is kept like any letter pair (a letter-joiner rule, not a script rule)', () => {
    expect(sanitizeContextName(`a${ZWNJ}b`)).toBe(`a${ZWNJ}b`);
  });
});

describe('Unicode normalisation and combining marks', () => {
  it('NFC is applied (a decomposed name equals its composed form)', () => {
    expect(sanitizeContextName(`e${c(0x301)}`)).toBe(c(0xe9));
    expect(sanitizeContextName(`A${c(0x30a)}`)).toBe(c(0xc5));
  });
  it('NFC runs before the cap: 64 decomposed letters keep all 64 (composed, none cut)', () => {
    const name = `e${c(0x301)}`.repeat(MAX_CONTEXT_NAME_LENGTH);
    expect(sanitizeContextName(name)).toBe(c(0xe9).repeat(MAX_CONTEXT_NAME_LENGTH));
  });
  it('at most 4 combining marks are kept per base', () => {
    const zalgo = `x${c(0x300, 0x301, 0x302, 0x303, 0x304, 0x305, 0x306, 0x307)}`;
    expect(MAX_COMBINING_MARKS_PER_BASE).toBe(4);
    const out = sanitizeContextName(zalgo);
    expect(Array.from(out)).toHaveLength(1 + MAX_COMBINING_MARKS_PER_BASE);
    expect(out.startsWith('x')).toBe(true);
  });
  it('the mark budget restarts at every base', () => {
    const one = `x${c(0x300, 0x301, 0x302, 0x303, 0x304)}`;
    expect(Array.from(sanitizeContextName(one + one))).toHaveLength(2 * (1 + MAX_COMBINING_MARKS_PER_BASE));
  });
});

describe('cap on grapheme boundaries', () => {
  it('never splits a ZWJ sequence: the whole family emoji goes, not half of it', () => {
    const family = c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466); // 7 code points
    const name = 'a'.repeat(MAX_CONTEXT_NAME_LENGTH - 3) + family; // 61 + 7 = 68 > 64
    const out = sanitizeContextName(name);
    expect(out).toBe('a'.repeat(MAX_CONTEXT_NAME_LENGTH - 3));
  });
  it('never separates a base from its combining marks', () => {
    const name = 'a'.repeat(MAX_CONTEXT_NAME_LENGTH - 1) + `b${c(0x300, 0x301)}`; // base b + 2 marks would overflow
    const out = sanitizeContextName(name);
    expect(out).toBe('a'.repeat(MAX_CONTEXT_NAME_LENGTH - 1));
  });
  it('never separates a flag (two regional indicators)', () => {
    const flag = c(0x1f1e9, 0x1f1ea);
    const out = sanitizeContextName('a'.repeat(MAX_CONTEXT_NAME_LENGTH - 1) + flag);
    expect(out).toBe('a'.repeat(MAX_CONTEXT_NAME_LENGTH - 1));
  });
  it('a single over-long grapheme is cut by code point without a dangling joiner and stays non-empty', () => {
    const chain = Array.from({ length: 100 }, () => c(0x1f468)).join(ZWJ);
    const out = sanitizeContextName(chain);
    expect(out.length).toBeGreaterThan(0);
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_CONTEXT_NAME_LENGTH);
    expect(out.endsWith(ZWJ)).toBe(false);
  });
  it('an ordinary long name is cut to exactly the cap', () => {
    expect(Array.from(sanitizeContextName('x'.repeat(300)))).toHaveLength(MAX_CONTEXT_NAME_LENGTH);
  });
});
