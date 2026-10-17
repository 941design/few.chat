/**
 * The "<name> left the group" row must never render with a blank name.
 * Chain: embedded name -> cached profile nickname -> truncated npub; an
 * empty / whitespace-only value at any link counts as absent
 * (bug: decided-small-fixes #1).
 */
import { describe, it, expect } from 'vitest';
import { resolveLeaveIntentDisplay } from '@/src/lib/marmot/parseStructured';

const PK = 'ab'.repeat(32);
const truncate = (pk: string) => `npub:${pk.slice(0, 6)}`;
const FALLBACK = truncate(PK);
// No fast-check in this repo: enumerate the blank shapes instead.
const BLANKS = [undefined, '', ' ', '\t', '\n', '  \u00a0 '];
const NAMES = ['Bob', ' Bob ', 'ß', '0'];

describe('resolveLeaveIntentDisplay', () => {
  it.each([
    ['no profile at all', {}],
    ['profile without nickname', { [PK]: {} }],
    ['empty nickname', { [PK]: { nickname: '' } }],
    ['whitespace nickname', { [PK]: { nickname: '   ' } }],
  ])('falls back to the truncated npub: %s', (_l, profileMap) => {
    expect(resolveLeaveIntentDisplay({ pubkey: PK }, profileMap, truncate)).toBe(FALLBACK);
  });

  it('never yields a blank display, whatever blank values are supplied', () => {
    for (const name of BLANKS) {
      for (const nickname of BLANKS) {
        const out = resolveLeaveIntentDisplay({ pubkey: PK, name }, { [PK]: { nickname } }, truncate);
        expect(out).toBe(FALLBACK);
      }
    }
  });

  it('prefers the embedded name, then the profile nickname', () => {
    for (const embedded of NAMES) {
      for (const nickname of NAMES) {
        expect(resolveLeaveIntentDisplay({ pubkey: PK, name: embedded }, { [PK]: { nickname } }, truncate)).toBe(embedded);
      }
    }
    for (const nickname of NAMES) {
      expect(resolveLeaveIntentDisplay({ pubkey: PK }, { [PK]: { nickname } }, truncate)).toBe(nickname);
    }
  });

  it('a blank embedded name defers to a real profile nickname', () => {
    expect(resolveLeaveIntentDisplay({ pubkey: PK, name: ' ' }, { [PK]: { nickname: 'Bob' } }, truncate)).toBe('Bob');
  });

  it('reads the profile of the announced pubkey only', () => {
    expect(resolveLeaveIntentDisplay({ pubkey: PK }, { other: { nickname: 'Eve' } }, truncate)).toBe(FALLBACK);
  });
});
