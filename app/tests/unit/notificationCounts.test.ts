/**
 * Unit tests for `notificationCounts.ts` — the pure derivation that replaced
 * the notification bell's flat total with per-domain and per-entity pill
 * counts (epic: obsolete-notification-bell).
 *
 * These assert the actual computed sums and the two-level count parity
 * (AC-PARITY-1/2): each domain total equals the sum of its per-entity totals,
 * with the one documented exception that pending invitations are counted
 * directly at the Groups nav level (they have no group card).
 */
import { describe, it, expect } from 'vitest';
import {
  groupCardTotal,
  contactCardTotal,
  contactsDomainTotal,
  groupsDomainTotal,
  type NotificationSlices,
} from '@/src/lib/notificationCounts';

const empty: NotificationSlices = {
  counts: {},
  joinRequests: {},
  directMessages: {},
  inviteExpiries: {},
  pendingContacts: {},
};

function slices(partial: Partial<NotificationSlices>): NotificationSlices {
  return { ...empty, ...partial };
}

describe('groupCardTotal (AC-CARD-1)', () => {
  it('sums counts + joinRequests + inviteExpiries for the group', () => {
    const s = slices({
      counts: { g1: 5, g2: 1 },
      joinRequests: { g1: 2 },
      inviteExpiries: { g1: 1, g2: 3 },
    });
    expect(groupCardTotal(s, 'g1')).toBe(8);
    expect(groupCardTotal(s, 'g2')).toBe(4);
  });

  it('returns 0 for a group absent from every slice', () => {
    expect(groupCardTotal(empty, 'nope')).toBe(0);
  });
});

describe('contactCardTotal (AC-CARD-2, OIN-2 fold)', () => {
  it('folds DM unread + pending into one number (2 DMs + pending = 3)', () => {
    const s = slices({ directMessages: { peer: 2 }, pendingContacts: { peer: 1 } });
    expect(contactCardTotal(s, 'peer')).toBe(3);
  });

  it('counts DMs alone when not pending', () => {
    expect(contactCardTotal(slices({ directMessages: { peer: 5 } }), 'peer')).toBe(5);
  });

  it('counts a pending-only contact as its pending value', () => {
    expect(contactCardTotal(slices({ pendingContacts: { peer: 1 } }), 'peer')).toBe(1);
  });

  it('returns 0 for an unknown peer', () => {
    expect(contactCardTotal(empty, 'unknown')).toBe(0);
  });
});

describe('contactsDomainTotal (AC-NAV-1)', () => {
  it('sums every directMessages + pendingContacts entry', () => {
    const s = slices({
      directMessages: { a: 2, b: 3 },
      pendingContacts: { a: 1, c: 1 },
    });
    expect(contactsDomainTotal(s)).toBe(7);
  });

  it('is 0 for empty slices', () => {
    expect(contactsDomainTotal(empty)).toBe(0);
  });
});

describe('groupsDomainTotal (AC-NAV-2)', () => {
  it('sums counts + joinRequests + inviteExpiries + pendingInvitationCount', () => {
    const s = slices({
      counts: { g1: 5, g2: 1 },
      joinRequests: { g1: 2 },
      inviteExpiries: { g2: 3 },
    });
    expect(groupsDomainTotal(s, 4)).toBe(15);
  });

  it('folds in pendingInvitationCount even when all unread slices are empty', () => {
    expect(groupsDomainTotal(empty, 3)).toBe(3);
  });

  it('treats a zero invitation count as no contribution', () => {
    expect(groupsDomainTotal(slices({ counts: { g1: 2 } }), 0)).toBe(2);
  });
});

describe('count parity (INV-C)', () => {
  it('AC-PARITY-1: contactsDomainTotal == sum of every contact card total', () => {
    const s = slices({
      directMessages: { a: 2, b: 3, c: 0 },
      pendingContacts: { a: 1, d: 1 },
    });
    const peers = new Set([
      ...Object.keys(s.directMessages),
      ...Object.keys(s.pendingContacts),
    ]);
    const summedCards = [...peers].reduce((acc, p) => acc + contactCardTotal(s, p), 0);
    expect(summedCards).toBe(contactsDomainTotal(s));
  });

  it('AC-PARITY-2: groupsDomainTotal == sum of group card totals + pending invitations', () => {
    const s = slices({
      counts: { g1: 5 },
      joinRequests: { g1: 2, g2: 1 },
      inviteExpiries: { g3: 3 },
    });
    const pendingInvitationCount = 2; // no group card — counted at nav level
    const groupIds = new Set([
      ...Object.keys(s.counts),
      ...Object.keys(s.joinRequests),
      ...Object.keys(s.inviteExpiries),
    ]);
    const summedCards = [...groupIds].reduce((acc, g) => acc + groupCardTotal(s, g), 0);
    expect(summedCards + pendingInvitationCount).toBe(
      groupsDomainTotal(s, pendingInvitationCount),
    );
  });
});
