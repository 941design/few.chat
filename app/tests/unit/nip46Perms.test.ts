/**
 * NIP-46 requested permissions and stored-session discard (AC-SIGN-3, AC-SIGN-4).
 */
import { describe, expect, it } from 'vitest';
import { permissions } from '@941design/marmot';
import {
  buildNip46Permissions,
  buildNip46PermsParam,
  shouldDiscardStoredNip46Session,
} from '@/src/lib/nip46Perms';

const libPerms = permissions.toNip46Perms().split(',');
const APP = ['sign_event:0', 'sign_event:20602', 'sign_event:30078', 'sign_event:10050'];

const OLD_SET = [
  'sign_event:0', 'sign_event:5', 'sign_event:443', 'sign_event:444', 'sign_event:445',
  'sign_event:1059', 'sign_event:10051', 'sign_event:20602', 'sign_event:30051',
  'sign_event:30078', 'sign_event:30443', 'nip44_encrypt', 'nip44_decrypt',
];

describe('AC-SIGN-3 requested permissions', () => {
  it('equals exactly the union of the library set and the four app kinds', () => {
    const got = buildNip46Permissions();
    expect([...got].sort()).toEqual([...new Set([...libPerms, ...APP])].sort());
    expect(new Set(got).size).toBe(got.length);
  });

  it('never requests the retired/ephemeral-signed kinds', () => {
    const got = buildNip46Permissions();
    for (const k of [443, 444, 445, 1059, 10051, 30051]) {
      expect(got).not.toContain(`sign_event:${k}`);
    }
  });

  it('param form is the comma join of the same list', () => {
    expect(buildNip46PermsParam().split(',')).toEqual(buildNip46Permissions());
  });
});

describe('NDK DM plane coverage (guard)', () => {
  // The app's NIP-17 DM seals (kind 13) and deletions (kind 5) are signed via NDK and are
  // covered only because the library's toNip46Perms() lists them; a library bump that drops
  // either must fail here instead of silently breaking DMs under permission-enforcing bunkers.
  it('requested set includes sign_event:13 and sign_event:5', () => {
    const perms = buildNip46Permissions();
    expect(perms).toContain('sign_event:13');
    expect(perms).toContain('sign_event:5');
  });
});

describe('AC-SIGN-4 stored-session discard', () => {
  it('discards corrupt persisted records instead of throwing', () => {
    expect(shouldDiscardStoredNip46Session({})).toBe(true);
    expect(shouldDiscardStoredNip46Session(42)).toBe(true);
    expect(shouldDiscardStoredNip46Session([42, null])).toBe(true);
    expect(shouldDiscardStoredNip46Session([...buildNip46Permissions(), 42])).toBe(true);
  });

  it('trims array entries like the string form', () => {
    expect(shouldDiscardStoredNip46Session(buildNip46Permissions().map((p) => ` ${p} `))).toBe(false);
  });

  it('discards a session whose grants equal the old set', () => {
    expect(shouldDiscardStoredNip46Session(OLD_SET)).toBe(true);
  });

  it('keeps a session whose grants cover the new set (extras allowed)', () => {
    expect(shouldDiscardStoredNip46Session(buildNip46Permissions())).toBe(false);
    expect(shouldDiscardStoredNip46Session([...buildNip46Permissions(), 'sign_event:443'])).toBe(false);
    expect(shouldDiscardStoredNip46Session(buildNip46PermsParam())).toBe(false);
  });

  it('discards when any single required permission is missing', () => {
    for (const missing of buildNip46Permissions()) {
      expect(shouldDiscardStoredNip46Session(buildNip46Permissions().filter((p) => p !== missing))).toBe(true);
    }
  });

  it('discards a session with no recorded grants (stored before this set)', () => {
    expect(shouldDiscardStoredNip46Session(null)).toBe(true);
    expect(shouldDiscardStoredNip46Session(undefined)).toBe(true);
    expect(shouldDiscardStoredNip46Session([])).toBe(true);
  });
});
