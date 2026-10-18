import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hasRecoveryMarker, setRecoveryMarker, clearRecoveryMarker, clearAllRecoveryMarkers, RECOVERY_MARKER_PREFIX,
} from '@/src/lib/marmot/staleReplaceMarker';

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('stale replace recovery marker', () => {
  it('set / has / clear round-trip, scoped per group', () => {
    setRecoveryMarker('a');
    expect(hasRecoveryMarker('a')).toBe(true);
    expect(hasRecoveryMarker('b')).toBe(false);
    expect(store[RECOVERY_MARKER_PREFIX + 'a']).toBeDefined();
    clearRecoveryMarker('a');
    expect(hasRecoveryMarker('a')).toBe(false);
  });

  it('clearAll removes only marker keys', () => {
    setRecoveryMarker('a');
    setRecoveryMarker('b');
    store.other = 'x';
    clearAllRecoveryMarkers();
    expect(Object.keys(store)).toEqual(['other']);
  });

  it('with localStorage throwing: has => false, nothing throws', () => {
    const boom = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { throw new Error('denied'); } });
    expect(hasRecoveryMarker('a')).toBe(false);
    expect(() => setRecoveryMarker('a')).not.toThrow();
    expect(() => clearRecoveryMarker('a')).not.toThrow();
    expect(() => clearAllRecoveryMarkers()).not.toThrow();
  });
});
