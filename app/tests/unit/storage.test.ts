import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readSettings,
  readStoredLanguage,
  writeSettings,
  readUserProfile,
  writeUserProfile,
  resetAllData,
  readOrCreateKeyPackageSlot,
} from '@/src/lib/storage';
import { generateKeyPackageSlot } from '@internet-privacy/marmot-ts';
import { STORAGE_KEYS } from '@/src/types';
import { NICKNAME_MAX_BYTES } from '@/src/config/profile';

// Mock localStorage for Node environment
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

beforeEach(() => {
  localStorageMock.clear();
});

describe('Settings', () => {
  it('returns default settings when nothing stored', () => {
    const settings = readSettings();
    expect(settings).toEqual({ theme: 'spring', language: 'en' });
  });

  it('writes and reads settings', () => {
    writeSettings({ theme: 'spring', language: 'de' });
    expect(readSettings()).toEqual({ theme: 'spring', language: 'de' });
  });

  it('normalizes a deprecated/unknown stored theme name to the default (spring)', () => {
    // The old themes (calm/playful/lego/minecraft/flower) were removed. A
    // settings blob persisted before that removal must not error and must
    // fall back to spring — the legacy `mood` field is preserved verbatim.
    store[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'playful', language: 'de' });
    expect(readSettings()).toEqual({ theme: 'spring', language: 'de' });

    store[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'not-a-real-theme', language: 'en' });
    expect(readSettings().theme).toBe('spring');
  });

  it('fills missing fields for legacy stored settings (deprecated mood normalizes to spring)', () => {
    store[STORAGE_KEYS.settings] = JSON.stringify({ mood: 'playful' });
    expect(readSettings()).toEqual({ theme: 'spring', language: 'en', mood: 'playful' });
  });

  it('uses correct storage key', () => {
    writeSettings({ theme: 'spring', language: 'de' });
    expect(store[STORAGE_KEYS.settings]).toBeDefined();
    const parsed = JSON.parse(store[STORAGE_KEYS.settings]);
    expect(parsed.theme).toBe('spring');
    expect(parsed.language).toBe('de');
  });
});

describe('readStoredLanguage', () => {
  it('returns undefined when no preference has been persisted', () => {
    // So the caller can fall back to browser-language detection on a first visit.
    expect(readStoredLanguage()).toBeUndefined();
  });

  it('returns undefined for legacy settings that predate the language field', () => {
    store[STORAGE_KEYS.settings] = JSON.stringify({ mood: 'playful' });
    expect(readStoredLanguage()).toBeUndefined();
  });

  it('returns the explicitly stored language', () => {
    writeSettings({ theme: 'spring', language: 'de' });
    expect(readStoredLanguage()).toBe('de');
  });
});

describe('UserProfile', () => {
  it('returns an empty profile when nothing stored', () => {
    expect(readUserProfile()).toEqual({ nickname: '', avatar: null });
  });

  it('writes and reads a profile', () => {
    const profile = {
      nickname: 'Rocket Reader',
      avatar: { imageUrl: 'http://example.test/berry.png' },
    };

    writeUserProfile(profile);
    expect(readUserProfile()).toEqual(profile);
  });

  it('normalizes oversized nickname', () => {
    const oversized = 'A'.repeat(NICKNAME_MAX_BYTES + 10);
    store[STORAGE_KEYS.userProfile] = JSON.stringify({
      nickname: oversized,
      avatar: { imageUrl: 'http://example.test/apple.png' },
    });

    expect(readUserProfile()).toEqual({
      nickname: 'A'.repeat(NICKNAME_MAX_BYTES),
      avatar: { imageUrl: 'http://example.test/apple.png' },
    });
  });

  it('byte-caps a multi-byte nickname on load (not a char-slice)', () => {
    // 20 umlauts = 40 UTF-8 bytes (2 bytes each), 20 UTF-16 code units. A
    // char-slice(0,32) would keep all 20; the byte cap keeps 16 (= 32 bytes).
    store[STORAGE_KEYS.userProfile] = JSON.stringify({
      nickname: 'ü'.repeat(20),
      avatar: null,
    });

    expect(readUserProfile().nickname).toBe('ü'.repeat(16));
    expect(new TextEncoder().encode(readUserProfile().nickname).length).toBe(32);
  });

  it('drops obsolete subject/accessories, keeping only imageUrl', () => {
    store[STORAGE_KEYS.userProfile] = JSON.stringify({
      nickname: 'Legacy',
      avatar: {
        id: 'berry-2',
        imageUrl: 'http://example.test/apple.png',
        subject: 'apple',
        accessories: ['hat'],
      },
    });

    expect(readUserProfile().avatar).toEqual({ imageUrl: 'http://example.test/apple.png' });
  });

  it('reconstructs imageUrl from a legacy id-only avatar', () => {
    store[STORAGE_KEYS.userProfile] = JSON.stringify({
      nickname: 'Legacy',
      avatar: { id: 'berry-9', subject: 'apple', accessories: [] },
    });

    expect(readUserProfile().avatar).toEqual({
      imageUrl: '//few.chat/assets/berry-9.png',
    });
  });
});

// resetAllData is currently unused by the frontend — the "Reset All Data" UI was
// removed from the Settings page to prevent accidental, irreversible identity
// wipes. These tests keep the retained logic covered for any future re-exposure.
describe('resetAllData', () => {
  it('clears all lp_* keys', () => {
    writeSettings({ theme: 'spring', language: 'de' });
    writeUserProfile({ nickname: 'Pineapple Pal', avatar: null });

    expect(store[STORAGE_KEYS.settings]).toBeDefined();
    expect(store[STORAGE_KEYS.userProfile]).toBeDefined();

    resetAllData();

    expect(store[STORAGE_KEYS.settings]).toBeUndefined();
    expect(store[STORAGE_KEYS.userProfile]).toBeUndefined();
  });

  it('handles already-empty storage gracefully', () => {
    expect(() => resetAllData()).not.toThrow();
  });
});

describe('corrupt data handling', () => {
  it('returns default when stored data is invalid JSON', () => {
    store[STORAGE_KEYS.settings] = 'not-json{{{';
    expect(readSettings()).toEqual({ theme: 'spring', language: 'en' });
  });
});

// AC-KEY-1, AC-KEY-2, AC-KEY-3: the load-or-generate helper backing
// MarmotContext.tsx's three KeyPackage slot-resolution call sites
// (marmot-ts 0.7.0 hex-validates the `d` tag / clientId and throws on the
// pre-migration free-form 'few' literal).
describe('readOrCreateKeyPackageSlot', () => {
  const HEX_64 = /^[0-9a-f]{64}$/;

  it('mints and persists a hex slot on a fresh install (AC-KEY-1) using the real generateKeyPackageSlot()', () => {
    expect(store[STORAGE_KEYS.keyPackageSlot]).toBeUndefined();

    const slot = readOrCreateKeyPackageSlot(generateKeyPackageSlot);

    expect(slot).toMatch(HEX_64);
    // Persisted synchronously, before this function returns — a caller
    // constructing a stateful client with `slot` immediately after is
    // guaranteed the write already landed.
    expect(store[STORAGE_KEYS.keyPackageSlot]).toBeDefined();
    expect(JSON.parse(store[STORAGE_KEYS.keyPackageSlot])).toBe(slot);
  });

  it('regenerates a conformant slot when the persisted value is the legacy free-form "few" literal (AC-KEY-2)', () => {
    store[STORAGE_KEYS.keyPackageSlot] = JSON.stringify('few');

    const slot = readOrCreateKeyPackageSlot(generateKeyPackageSlot);

    expect(slot).toMatch(HEX_64);
    expect(slot).not.toBe('few');
    expect(JSON.parse(store[STORAGE_KEYS.keyPackageSlot])).toBe(slot);
  });

  it('regenerates when the persisted value is any other non-conformant shape (too short, uppercase, non-hex)', () => {
    for (const bad of ['ab'.repeat(31), 'A'.repeat(64), 'g'.repeat(64), '']) {
      store[STORAGE_KEYS.keyPackageSlot] = JSON.stringify(bad);
      const slot = readOrCreateKeyPackageSlot(generateKeyPackageSlot);
      expect(slot).toMatch(HEX_64);
    }
  });

  it('reuses a byte-identical persisted slot on every subsequent call, never regenerating (AC-KEY-3)', () => {
    const first = readOrCreateKeyPackageSlot(generateKeyPackageSlot);

    // A mint function that would prove regeneration happened if called again.
    let mintCalls = 0;
    const mintSlot = () => {
      mintCalls += 1;
      return generateKeyPackageSlot();
    };

    const second = readOrCreateKeyPackageSlot(mintSlot);
    const third = readOrCreateKeyPackageSlot(mintSlot);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mintCalls).toBe(0);
  });

  it('calls mintSlot at most once even when regenerating', () => {
    store[STORAGE_KEYS.keyPackageSlot] = JSON.stringify('few');
    let mintCalls = 0;
    const mintSlot = () => {
      mintCalls += 1;
      return generateKeyPackageSlot();
    };

    readOrCreateKeyPackageSlot(mintSlot);

    expect(mintCalls).toBe(1);
  });
});

// When localStorage is unavailable (e.g. Safari private mode, storage disabled
// or quota-blocked), the app must degrade gracefully: isStorageAvailable()
// latches false, reads fall back to their defaults, and writes are silent
// no-ops that never even reach localStorage.setItem.
describe('storage unavailable (localStorage throws)', () => {
  it('latches isStorageAvailable() false, reads return defaults, and writes are silent no-ops', async () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
      removeItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      clear: vi.fn(),
      get length() {
        return 0;
      },
      key: () => null,
    };

    // Fresh module instance so the module-scoped _storageAvailable memo starts
    // unset and re-probes against the throwing localStorage.
    vi.resetModules();
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, writable: true });
    try {
      const storage = await import('@/src/lib/storage');

      // The availability probe calls setItem once, catches the throw, and latches false.
      expect(storage.isStorageAvailable()).toBe(false);
      const probeSetItemCalls = throwing.setItem.mock.calls.length;

      // Reads degrade to defaults without throwing.
      expect(storage.readSettings()).toEqual({ theme: 'spring', language: 'en' });
      expect(storage.readStoredLanguage()).toBeUndefined();
      expect(storage.readUserProfile()).toEqual({ nickname: '', avatar: null });

      // Writes are guarded no-ops — they must NOT attempt any further setItem
      // (which would throw) beyond the one-time availability probe.
      expect(() => storage.writeSettings({ theme: 'spring', language: 'de' })).not.toThrow();
      expect(() => storage.writeUserProfile({ nickname: 'X', avatar: null })).not.toThrow();
      expect(throwing.setItem.mock.calls.length).toBe(probeSetItemCalls);
    } finally {
      // Restore the working mock + a clean module registry for any later suites.
      vi.resetModules();
      Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
    }
  });
});
