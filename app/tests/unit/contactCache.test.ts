/**
 * contactCache.test.ts — unit tests for app/src/lib/contactCache.ts, covering
 * both the pre-existing `writeContactEntry` (regression only — this story
 * does not change its behavior or signature) and the new neutralized
 * `writeContactEntryNeutralized` primitive it adds (epic:
 * direct-contact-profile-exchange, story 04, AC-PROF-4/6/10, VQ-S04-002/013).
 *
 * localStorage mock mirrors `contacts-property.test.ts`'s hand-rolled
 * convention (no jsdom/@testing-library, no fast-check — this repo's
 * "property tests" are parametric sweeps in `it()` blocks per that file's
 * precedent).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readContactCache,
  readContactEntry,
  writeContactEntry,
  writeContactEntryNeutralized,
  type CachedContact,
} from '@/src/lib/contactCache';
import { STORAGE_KEYS } from '@/src/types';
import * as contactsModule from '@/src/lib/contacts';

// ── localStorage mock ────────────────────────────────────────────────────

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

function entry(overrides?: Partial<CachedContact>): CachedContact {
  return {
    nickname: 'Alice',
    avatar: { imageUrl: '//few.chat/assets/alice.png' },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  localStorageMock.clear();
  localStorageMock.setItem.mockClear();
  vi.restoreAllMocks();
});

// ── Regression: writeContactEntry is unchanged (VQ-S04-002) ────────────────

describe('writeContactEntry — regression (existing callers unaffected by this story)', () => {
  it('still calls rememberContact on a landing write (group sync / card import rely on this)', () => {
    const rememberSpy = vi.spyOn(contactsModule, 'rememberContact');
    writeContactEntry(PUBKEY, entry());
    expect(rememberSpy).toHaveBeenCalledWith(PUBKEY, entry().updatedAt);
    expect(readContactEntry(PUBKEY)).toEqual(entry());
  });

  it('still returns void, not a result object', () => {
    const result = writeContactEntry(OTHER_PUBKEY, entry());
    expect(result).toBeUndefined();
  });

  it('still rejects a stale write (existing.updatedAt >= incoming), same LWW predicate as before', () => {
    writeContactEntry(PUBKEY, entry({ updatedAt: '2026-06-01T00:00:00.000Z' }));
    writeContactEntry(PUBKEY, entry({ nickname: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' }));
    expect(readContactEntry(PUBKEY)?.nickname).toBe('Alice');
  });

  it('rejects an EQUAL-timestamp write (LWW is >=, not strict >): a second payload at the same updatedAt does not overwrite the first', () => {
    // The give-away between `>=` and `>` is only observable at equal
    // timestamps: `>=` keeps the incumbent (idempotent re-delivery), `>`
    // would let a same-instant payload clobber it.
    const T = '2026-04-01T00:00:00.000Z';
    writeContactEntry(PUBKEY, entry({ nickname: 'First', updatedAt: T }));
    writeContactEntry(PUBKEY, entry({ nickname: 'Second', updatedAt: T }));
    expect(readContactEntry(PUBKEY)?.nickname).toBe('First');
  });
});

// ── writeContactEntryNeutralized — no contact injection (AC-PROF-4) ────────

describe('writeContactEntryNeutralized — no rememberContact side effect (AC-PROF-4, VQ-S04-002)', () => {
  it('never calls rememberContact, on a landing write or otherwise', () => {
    const rememberSpy = vi.spyOn(contactsModule, 'rememberContact');
    writeContactEntryNeutralized(PUBKEY, entry());
    expect(rememberSpy).not.toHaveBeenCalled();
  });

  it('still persists the entry into the same contactCache the 1:1 list reads (AC-PROF-6)', () => {
    writeContactEntryNeutralized(PUBKEY, entry());
    expect(readContactEntry(PUBKEY)).toEqual(entry());
    expect(readContactCache()[PUBKEY]).toEqual(entry());
  });

  it('defensively lowercases the pubkeyHex key', () => {
    writeContactEntryNeutralized(PUBKEY.toUpperCase(), entry());
    expect(readContactEntry(PUBKEY)).toEqual(entry());
  });

  it('read/write case-fold symmetry (Stage-1 review, sev 3): a neutralized write under a mixed-case pubkey is found by readContactEntry called with that SAME mixed-case string', () => {
    const mixedCase = PUBKEY.slice(0, 32) + PUBKEY.slice(32).toUpperCase();
    writeContactEntryNeutralized(mixedCase, entry());
    expect(readContactEntry(mixedCase)).toEqual(entry());
  });
});

// ── landed / lwwWon / avatarNonNull semantics (VQ-S04-013) ─────────────────

describe('writeContactEntryNeutralized — WriteContactEntryResult semantics (VQ-S04-013)', () => {
  it('a first-ever write with a non-null avatar: landed=true, lwwWon=true, avatarNonNull=true', () => {
    const result = writeContactEntryNeutralized(PUBKEY, entry());
    expect(result).toEqual({ landed: true, lwwWon: true, avatarNonNull: true });
  });

  it('a newer announce overwrites and lands (AC-PROF-10 newer-updates)', () => {
    writeContactEntryNeutralized(PUBKEY, entry({ updatedAt: '2026-01-01T00:00:00.000Z' }));
    const result = writeContactEntryNeutralized(
      PUBKEY,
      entry({ nickname: 'Alice2', updatedAt: '2026-02-01T00:00:00.000Z' }),
    );
    expect(result).toEqual({ landed: true, lwwWon: true, avatarNonNull: true });
    expect(readContactEntry(PUBKEY)?.nickname).toBe('Alice2');
  });

  it('an older-or-equal announce does not overwrite (AC-PROF-10 older-does-not): landed=false, lwwWon=false', () => {
    writeContactEntryNeutralized(PUBKEY, entry({ updatedAt: '2026-02-01T00:00:00.000Z' }));
    const result = writeContactEntryNeutralized(
      PUBKEY,
      entry({ nickname: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(result).toEqual({ landed: false, lwwWon: false, avatarNonNull: true });
    expect(readContactEntry(PUBKEY)?.nickname).toBe('Alice'); // untouched
  });

  it('applying the identical announce twice is idempotent — second call landed=false, cache byte-for-byte unchanged (AC-PROF-10)', () => {
    const payload = entry({ updatedAt: '2026-03-01T00:00:00.000Z' });
    const first = writeContactEntryNeutralized(PUBKEY, payload);
    const beforeSecond = JSON.stringify(readContactCache());
    const second = writeContactEntryNeutralized(PUBKEY, payload);
    const afterSecond = JSON.stringify(readContactCache());

    expect(first).toEqual({ landed: true, lwwWon: true, avatarNonNull: true });
    expect(second).toEqual({ landed: false, lwwWon: false, avatarNonNull: true });
    expect(afterSecond).toBe(beforeSecond);
  });

  it('a write whose avatar is null: lwwWon=true (it is a real write) but landed=false, avatarNonNull=false (VQ-S04-013\'s "not merely a write happened")', () => {
    const result = writeContactEntryNeutralized(PUBKEY, entry({ avatar: null }));
    expect(result).toEqual({ landed: false, lwwWon: true, avatarNonNull: false });
    expect(readContactEntry(PUBKEY)?.avatar).toBeNull();
  });

  it('a losing write against an existing null-avatar entry reports avatarNonNull=false (existing entry has no avatar either)', () => {
    writeContactEntryNeutralized(PUBKEY, entry({ avatar: null, updatedAt: '2026-02-01T00:00:00.000Z' }));
    const result = writeContactEntryNeutralized(
      PUBKEY,
      entry({ avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(result).toEqual({ landed: false, lwwWon: false, avatarNonNull: false });
  });
});

// bug: stored-group-avatars-not-resanitized — cache entries written before the
// 2026-10-15 avatar-URL check are re-validated on read: unsafe avatar dropped,
// nickname/updatedAt kept.
describe('readContactCache — re-validates stored avatars', () => {
  beforeEach(() => localStorageMock.clear());

  it.each([
    ['http tracker', 'http://tracker.example/p.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
  ])('drops an unsafe avatar (%s), keeps the entry', (_l, imageUrl) => {
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify({
      abc: { nickname: 'Eve', avatar: { imageUrl }, updatedAt: '2026-01-01T00:00:00.000Z' },
      def: { nickname: 'Dan', avatar: { imageUrl: 'https://ok.example/d.png' }, updatedAt: '2026-01-02T00:00:00.000Z' },
    }));
    expect(readContactCache()).toEqual({
      abc: { nickname: 'Eve', avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' },
      def: { nickname: 'Dan', avatar: { imageUrl: 'https://ok.example/d.png' }, updatedAt: '2026-01-02T00:00:00.000Z' },
    });
    expect(readContactEntry('ABC')?.avatar).toBeNull();
  });

  it('tolerates a malformed entry and a non-object cache', () => {
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify({ abc: null, def: { nickname: 'Dan', avatar: null, updatedAt: 'x' } }));
    expect(readContactCache()).toEqual({ abc: null, def: { nickname: 'Dan', avatar: null, updatedAt: 'x' } });
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify([1, 2]));
    expect(readContactCache()).toEqual({});
    localStorage.setItem(STORAGE_KEYS.contactCache, 'null');
    expect(readContactCache()).toEqual({});
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify('abc'));
    expect(readContactCache()).toEqual({});
    localStorage.setItem(STORAGE_KEYS.contactCache, '{not json');
    expect(readContactCache()).toEqual({});
  });

  it('passes a non-object entry through untouched (never spreads it into an object)', () => {
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify({ abc: 'junk', def: 7 }));
    expect(readContactCache()).toEqual({ abc: 'junk', def: 7 });
  });
});
