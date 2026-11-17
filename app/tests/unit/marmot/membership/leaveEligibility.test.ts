// @vitest-environment node
/**
 * S13 / AC-LEAVE-1: the leave eligibility truth table and the twin-read discipline.
 *
 *  - Truth table over {members: 1 | 2+} x {own is admin} x {other admins: 0 | 1+}, asserted EXHAUSTIVELY and again
 *    against an independent oracle over a seeded pseudo-random space (no fast-check in this app).
 *  - Twin reads (kept from leaveGroupImpl / getLiveMemberPubkeys): a throwing `members()` MUST NOT skip the purge on the
 *    leave path (decideLeave -> `leave`, rosterKnown:false, never abandon/blocked) and MUST fail closed on the live-member
 *    path (selectLeaveModalState never `abandon`; readLiveMembers undefined). The two directions are OPPOSITE on purpose.
 */
import { describe, expect, it } from 'vitest';
import { decideLeave, readLiveMembers, readRosterFacts, selectLeaveModalState } from '@/src/lib/marmot/membership';

const OWN = 'a1'.repeat(32);
const P2 = 'b2'.repeat(32);
const P3 = 'c3'.repeat(32);
const P4 = 'd4'.repeat(32);

describe('decideLeave truth table (AC-LEAVE-1)', () => {
  const cases: Array<{ members: string[]; admins: string[]; expected: ReturnType<typeof decideLeave> }> = [
    // sole member: abandon whatever the admin facts say
    { members: [OWN], admins: [OWN], expected: { action: 'abandon', reason: 'sole-member' } },
    { members: [OWN], admins: [], expected: { action: 'abandon', reason: 'sole-member' } },
    { members: [OWN], admins: [P2], expected: { action: 'abandon', reason: 'sole-member' } },
    // 2+ members, own is admin, no other admin: blocked (last-admin)
    { members: [OWN, P2], admins: [OWN], expected: { action: 'blocked', reason: 'last-admin' } },
    { members: [OWN, P2, P3], admins: [OWN], expected: { action: 'blocked', reason: 'last-admin' } },
    // 2+ members, own is admin, another admin exists: leave
    { members: [OWN, P2], admins: [OWN, P2], expected: { action: 'leave', rosterKnown: true } },
    { members: [OWN, P2, P3], admins: [P3, OWN], expected: { action: 'leave', rosterKnown: true } },
    // 2+ members, own is not an admin: leave (with or without other admins)
    { members: [OWN, P2], admins: [P2], expected: { action: 'leave', rosterKnown: true } },
    { members: [OWN, P2, P3], admins: [P2, P3], expected: { action: 'leave', rosterKnown: true } },
    { members: [OWN, P2], admins: [], expected: { action: 'leave', rosterKnown: true } },
  ];
  it.each(cases)('members=$members.length admins=$admins.length -> $expected.action', ({ members, admins, expected }) => {
    expect(decideLeave({ members, admins }, OWN)).toEqual(expected);
  });

  it('a roster that no longer holds the account is already gone: abandon (nothing to announce, no leave() call)', () => {
    expect(decideLeave({ members: [P2, P3], admins: [P2] }, OWN)).toEqual({ action: 'abandon', reason: 'not-a-member' });
    expect(decideLeave({ members: [], admins: [] }, OWN)).toEqual({ action: 'abandon', reason: 'not-a-member' });
    // a single member that is somebody else is NOT "the sole member": it is a removed account
    expect(decideLeave({ members: [P2], admins: [P2] }, OWN)).toEqual({ action: 'abandon', reason: 'not-a-member' });
  });

  it('compares accounts case-insensitively', () => {
    const upper = OWN.toUpperCase();
    expect(decideLeave({ members: [upper], admins: [upper] }, OWN)).toEqual({ action: 'abandon', reason: 'sole-member' });
    expect(decideLeave({ members: [upper, P2], admins: [upper] }, OWN)).toEqual({ action: 'blocked', reason: 'last-admin' });
    expect(decideLeave({ members: [OWN, P2], admins: [P2.toUpperCase(), upper] }, OWN)).toEqual({ action: 'leave', rosterKnown: true });
  });

  it('matches an independent oracle over a seeded pseudo-random roster space (own present or absent, 0-4 others, any admin subset)', () => {
    let seed = 0x13579bdf;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const others = [P2, P3, P4];
    for (let i = 0; i < 4000; i++) {
      const ownIn = rnd() < 0.85;
      const members = [...(ownIn ? [OWN] : []), ...others.filter(() => rnd() < 0.5)];
      const pool = [...members, ...(rnd() < 0.2 ? ['e5'.repeat(32)] : [])];
      const admins = pool.filter(() => rnd() < 0.5);
      const adminsKnown = rnd() < 0.9;
      const facts = { members, admins: adminsKnown ? admins : undefined };

      const oracle = (() => {
        if (!members.includes(OWN)) return 'abandon:not-a-member';
        if (members.length === 1) return 'abandon:sole-member';
        const ownAdmin = adminsKnown && admins.includes(OWN);
        const otherAdmins = adminsKnown ? admins.filter((a) => a !== OWN).length : 1;
        return ownAdmin && otherAdmins === 0 ? 'blocked' : 'leave';
      })();
      const got = decideLeave(facts, OWN);
      const label = got.action === 'abandon' ? `abandon:${got.reason}` : got.action;
      expect(label, JSON.stringify(facts)).toBe(oracle);
    }
  });
});

describe('twin-read discipline: opposite fail-closed directions', () => {
  const throwing = (): never => {
    throw new Error('corrupt group state');
  };

  it('LEAVE path: an unreadable member list never skips the purge: it resolves to `leave` with rosterKnown:false (never abandon, never blocked)', () => {
    const facts = readRosterFacts({ members: throwing, activeAdmins: () => [OWN] });
    expect(facts).toEqual({ members: undefined, admins: [OWN] });
    // even a KNOWN sole-admin fact does not block when the roster is unknown: a corrupt group must stay deletable
    expect(decideLeave(facts, OWN)).toEqual({ action: 'leave', rosterKnown: false });
    expect(decideLeave({ members: undefined, admins: undefined }, OWN)).toEqual({ action: 'leave', rosterKnown: false });
  });

  it('LEAVE path: an unreadable admin list is "unknown", not "sole admin": the leave proceeds', () => {
    const facts = readRosterFacts({ members: () => [OWN, P2], activeAdmins: throwing });
    expect(facts).toEqual({ members: [OWN, P2], admins: undefined });
    expect(decideLeave(facts, OWN)).toEqual({ action: 'leave', rosterKnown: true });
  });

  it('LIVE-MEMBER path: an unreadable member list is fail-closed: never `abandon` (permanent deletion), only blocked/confirm', () => {
    const facts = readRosterFacts({ members: throwing, activeAdmins: () => [OWN] });
    expect(selectLeaveModalState(facts, OWN)).toBe('blocked');
    expect(selectLeaveModalState(readRosterFacts({ members: throwing, activeAdmins: () => [OWN, P2] }), OWN)).toBe('confirm');
    expect(selectLeaveModalState({ members: undefined, admins: undefined }, OWN)).toBe('confirm');
  });

  it('LIVE-MEMBER path: abandon is offered only for a READABLE sole-member roster', () => {
    expect(selectLeaveModalState({ members: [OWN], admins: [OWN] }, OWN)).toBe('abandon');
    expect(selectLeaveModalState({ members: [OWN, P2], admins: [OWN] }, OWN)).toBe('blocked');
    expect(selectLeaveModalState({ members: [OWN, P2], admins: [OWN, P2] }, OWN)).toBe('confirm');
    expect(selectLeaveModalState({ members: [P2], admins: [P2] }, OWN)).toBe('confirm');
  });

  it('the two directions differ on the SAME unreadable fact (they are not unified)', () => {
    const facts = readRosterFacts({ members: throwing, activeAdmins: () => [OWN] });
    expect(decideLeave(facts, OWN).action).toBe('leave');
    expect(selectLeaveModalState(facts, OWN)).toBe('blocked');
  });

  it('a malformed answer (not a string list) is unreadable, not a roster', () => {
    const facts = readRosterFacts({ members: (() => 'nope') as never, activeAdmins: (() => [1, 2]) as never });
    expect(facts).toEqual({ members: undefined, admins: undefined });
    expect(readRosterFacts(undefined)).toEqual({ members: undefined, admins: undefined });
  });

  it('readLiveMembers: the roster, or undefined when the group is unknown, the lookup rejects or members() throws', async () => {
    expect(await readLiveMembers(async () => ({ members: () => [OWN, P2] }), 'g')).toEqual([OWN, P2]);
    expect(await readLiveMembers(async () => undefined, 'g')).toBeUndefined();
    expect(await readLiveMembers(async () => null, 'g')).toBeUndefined();
    expect(await readLiveMembers(async () => Promise.reject(new Error('client disposed')), 'g')).toBeUndefined();
    expect(await readLiveMembers(async () => ({ members: throwing }), 'g')).toBeUndefined();
  });
});
