import { describe, it, expect } from 'vitest';
import { isSoleAdmin, isLastMember, selectLeaveModalState, shouldAbortLeaveAsSoleAdmin, resolveLeaveModalState } from '@/src/lib/marmot/leaveEligibility';

describe('isSoleAdmin', () => {
  it('returns true when the single admin matches the current user (exact case)', () => {
    expect(isSoleAdmin(['alice'], 'alice')).toBe(true);
  });

  it('returns false when two admins exist and current user is one of them', () => {
    expect(isSoleAdmin(['alice', 'bob'], 'alice')).toBe(false);
  });

  it('returns false when one admin exists but is NOT the current user', () => {
    expect(isSoleAdmin(['bob'], 'alice')).toBe(false);
  });

  it('returns false when adminPubkeys is undefined', () => {
    expect(isSoleAdmin(undefined, 'alice')).toBe(false);
  });

  it('returns false when adminPubkeys is empty', () => {
    expect(isSoleAdmin([], 'alice')).toBe(false);
  });

  it('returns false when ownPubkeyHex is null', () => {
    expect(isSoleAdmin(['alice'], null)).toBe(false);
  });

  it('returns false when ownPubkeyHex is undefined', () => {
    expect(isSoleAdmin(['alice'], undefined)).toBe(false);
  });

  it('returns true with case-insensitive match: UPPER admin vs lower own', () => {
    expect(isSoleAdmin(['ALICE'], 'alice')).toBe(true);
  });

  it('returns true with case-insensitive match: lower admin vs UPPER own', () => {
    expect(isSoleAdmin(['alice'], 'ALICE')).toBe(true);
  });
});

describe('isLastMember', () => {
  it('returns true when the single member matches the current user (exact case)', () => {
    expect(isLastMember(['alice'], 'alice')).toBe(true);
  });

  it('returns false when two members exist, even when current user is one of them', () => {
    expect(isLastMember(['alice', 'bob'], 'alice')).toBe(false);
  });

  it('returns false when one member exists but is NOT the current user', () => {
    expect(isLastMember(['bob'], 'alice')).toBe(false);
  });

  it('returns true with case-insensitive match: UPPER member vs lower own', () => {
    expect(isLastMember(['ALICE'], 'alice')).toBe(true);
  });

  it('returns true with case-insensitive match: lower member vs UPPER own', () => {
    expect(isLastMember(['alice'], 'ALICE')).toBe(true);
  });

  it('returns false when memberPubkeys is undefined', () => {
    expect(isLastMember(undefined, 'alice')).toBe(false);
  });

  it('returns false when memberPubkeys is empty', () => {
    expect(isLastMember([], 'alice')).toBe(false);
  });

  it('returns false when ownPubkeyHex is null', () => {
    expect(isLastMember(['alice'], null)).toBe(false);
  });

  it('returns false when ownPubkeyHex is undefined', () => {
    expect(isLastMember(['alice'], undefined)).toBe(false);
  });
});

describe('selectLeaveModalState', () => {
  it("returns 'abandon' when the caller is the group's only member and also its sole admin (load-bearing ordering case)", () => {
    // Satisfies both isLastMember AND isSoleAdmin — an admin-first ordering
    // would wrongly return 'blocked' here. Last-member must win (DD-2).
    expect(selectLeaveModalState(['alice'], ['alice'], 'alice')).toBe('abandon');
  });

  it("returns 'blocked' when two members exist and the caller is sole admin", () => {
    expect(selectLeaveModalState(['alice', 'bob'], ['alice'], 'alice')).toBe('blocked');
  });

  it("returns 'confirm' when two members exist and the caller is not the sole admin", () => {
    expect(selectLeaveModalState(['alice', 'bob'], ['bob'], 'alice')).toBe('confirm');
  });

  it("never returns 'abandon' when memberPubkeys is undefined, across several admin/own combinations", () => {
    expect(selectLeaveModalState(undefined, ['alice'], 'alice')).not.toBe('abandon');
    expect(selectLeaveModalState(undefined, ['bob'], 'alice')).not.toBe('abandon');
    expect(selectLeaveModalState(undefined, undefined, 'alice')).not.toBe('abandon');
  });
});

describe('shouldAbortLeaveAsSoleAdmin (execution-time guard)', () => {
  it('aborts only for a known multi-member group where the leaver is the sole admin', () => {
    expect(shouldAbortLeaveAsSoleAdmin(['alice', 'bob'], ['alice'], 'alice')).toBe(true);
  });

  it('does not abort for the last member (abandon wins)', () => {
    expect(shouldAbortLeaveAsSoleAdmin(['alice'], ['alice'], 'alice')).toBe(false);
  });

  it('does not abort for a co-admin or a non-admin', () => {
    expect(shouldAbortLeaveAsSoleAdmin(['alice', 'bob'], ['alice', 'bob'], 'alice')).toBe(false);
    expect(shouldAbortLeaveAsSoleAdmin(['alice', 'bob'], ['bob'], 'alice')).toBe(false);
  });

  it('does not abort when the member list is unknown (purge must not be skipped)', () => {
    expect(shouldAbortLeaveAsSoleAdmin(undefined, ['alice'], 'alice')).toBe(false);
  });

  it('does not abort when the admin list is unknown', () => {
    expect(shouldAbortLeaveAsSoleAdmin(['alice', 'bob'], undefined, 'alice')).toBe(false);
  });
});

describe('resolveLeaveModalState (aborted execution surfaces the blocked notice)', () => {
  it("shows 'blocked' once the execution-time check aborted, whatever the stale modal state said", () => {
    expect(resolveLeaveModalState('confirm', true)).toBe('blocked');
    expect(resolveLeaveModalState('abandon', true)).toBe('blocked');
  });

  it('passes the computed modal state through when nothing aborted', () => {
    expect(resolveLeaveModalState('confirm', false)).toBe('confirm');
    expect(resolveLeaveModalState('abandon', false)).toBe('abandon');
    expect(resolveLeaveModalState('blocked', false)).toBe('blocked');
  });
});
