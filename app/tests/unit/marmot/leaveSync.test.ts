import { describe, it, expect } from 'vitest';
import {
  LEAVE_INTENT_KIND,
  serialiseLeaveIntent,
  parseLeaveIntent,
} from '@/src/lib/marmot/leaveSync';
import type { LeaveIntentPayload } from '@/src/lib/marmot/leaveSync';

describe('leaveSync', () => {
  describe('kind constant', () => {
    it('exports LEAVE_INTENT_KIND = 13', () => {
      expect(LEAVE_INTENT_KIND).toBe(13);
    });
  });

  describe('serialiseLeaveIntent', () => {
    it('serialises a payload to JSON with only the pubkey field', () => {
      const payload: LeaveIntentPayload = { pubkey: 'abcd' };
      const json = serialiseLeaveIntent(payload);
      expect(JSON.parse(json)).toEqual({ pubkey: 'abcd' });
    });

    it('emits no extra fields beyond pubkey', () => {
      const json = serialiseLeaveIntent({ pubkey: 'xyz' });
      const parsed = JSON.parse(json);
      expect(Object.keys(parsed)).toEqual(['pubkey']);
    });
  });

  const HEX64 = 'ab'.repeat(32);

  describe('parseLeaveIntent', () => {
    it('round-trip: parseLeaveIntent(serialiseLeaveIntent({pubkey:<hex64>})) returns the canonical pubkey', () => {
      const result = parseLeaveIntent(serialiseLeaveIntent({ pubkey: HEX64 }));
      expect(result).toEqual({ pubkey: HEX64 });
    });

    it('canonicalizes an uppercase hex-64 pubkey to lowercase', () => {
      const result = parseLeaveIntent(JSON.stringify({ pubkey: HEX64.toUpperCase() }));
      expect(result).toEqual({ pubkey: HEX64 });
    });

    it('returns null for invalid JSON input', () => {
      expect(parseLeaveIntent('not-json')).toBeNull();
    });

    it('returns null when pubkey field is absent', () => {
      expect(parseLeaveIntent('{"foo":1}')).toBeNull();
    });

    it('returns null when pubkey is not a string', () => {
      expect(parseLeaveIntent('{"pubkey":42}')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseLeaveIntent('')).toBeNull();
    });

    it('returns null for a JSON null value', () => {
      expect(parseLeaveIntent('null')).toBeNull();
    });

    // Fable S3 Stage-2 finding 1 + spec-request §7: an empty or non-canonical
    // subject must drop as malformed, NOT pass the subject===sender gate
    // vacuously ('' === '' would otherwise arm a no-op removal).
    it('returns null for an empty pubkey (spec-request §7: pubkey:"" drops as malformed)', () => {
      expect(parseLeaveIntent(JSON.stringify({ pubkey: '' }))).toBeNull();
    });

    it('returns null for a non-hex pubkey', () => {
      expect(parseLeaveIntent(JSON.stringify({ pubkey: 'z'.repeat(64) }))).toBeNull();
    });

    it('returns null for a too-short pubkey', () => {
      expect(parseLeaveIntent(JSON.stringify({ pubkey: 'abcd' }))).toBeNull();
    });
  });
});
