/**
 * Unit tests for `buildInviteExpiryRows` — the pure row-building function
 * originally extracted for gate-remediation Finding 3 (epic
 * invite-link-lifecycle) and relocated to `@/src/lib/inviteExpiryRows`
 * when the notification bell was removed (epic: obsolete-notification-bell,
 * AC-REMOVE-4).
 *
 * This repo has no jsdom/@testing-library/renderHook precedent (see
 * `groupsManageLinksDeepLink.test.ts`'s identical extraction rationale for
 * `groups.tsx`), so the row-building logic worth testing directly lives in an
 * exported, dependency-free pure function. Neither React nor any component is
 * mounted here.
 *
 * Before the fix, the bell's row list was filtered to the admin's current
 * `groups` list — the same source `unreadGroups`/`joinRequestGroups` use.
 * But `useUnreadCounts().totalUnread` (unreadStore.ts) sums EVERY key in
 * the `inviteExpiries` slice unconditionally, with no such filter. A stale
 * or restored group id present only in `inviteExpiries` (not in `groups`)
 * therefore inflated the badge total with no row the user could click to
 * clear it — a permanently stuck badge. These tests assert the restored
 * invariant: the sum of `expiryCount` across the rows this function returns
 * always equals the sum of every positive count in `inviteExpiries`,
 * regardless of which groupIds are present in `groups`.
 */
import { describe, it, expect } from 'vitest';
import { buildInviteExpiryRows } from '@/src/lib/inviteExpiryRows';

const UNKNOWN_LABEL = 'Group not found.';

describe('buildInviteExpiryRows', () => {
  it('renders a row for a known group using its real name', () => {
    const rows = buildInviteExpiryRows(
      { 'group-1': 2 },
      [{ id: 'group-1', name: 'Book Club' }],
      UNKNOWN_LABEL,
    );
    expect(rows).toEqual([{ groupId: 'group-1', name: 'Book Club', expiryCount: 2 }]);
  });

  it('renders a row for a stale groupId absent from the current groups list, using the fallback label', () => {
    const rows = buildInviteExpiryRows(
      { 'stale-group': 3 },
      [{ id: 'group-1', name: 'Book Club' }], // groups list does not include 'stale-group'
      UNKNOWN_LABEL,
    );
    expect(rows).toEqual([{ groupId: 'stale-group', name: UNKNOWN_LABEL, expiryCount: 3 }]);
  });

  it('excludes zero-count entries', () => {
    const rows = buildInviteExpiryRows(
      { 'group-1': 0, 'group-2': 1 },
      [
        { id: 'group-1', name: 'Zero Count' },
        { id: 'group-2', name: 'Nonzero Count' },
      ],
      UNKNOWN_LABEL,
    );
    expect(rows).toEqual([{ groupId: 'group-2', name: 'Nonzero Count', expiryCount: 1 }]);
  });

  it('mixes known and stale groups in the same call', () => {
    const rows = buildInviteExpiryRows(
      { known: 1, stale: 4 },
      [{ id: 'known', name: 'Known Group' }],
      UNKNOWN_LABEL,
    );
    const byId = new Map(rows.map((r) => [r.groupId, r]));
    expect(byId.get('known')).toEqual({ groupId: 'known', name: 'Known Group', expiryCount: 1 });
    expect(byId.get('stale')).toEqual({ groupId: 'stale', name: UNKNOWN_LABEL, expiryCount: 4 });
  });

  it('returns an empty array for an empty inviteExpiries slice', () => {
    expect(buildInviteExpiryRows({}, [{ id: 'group-1', name: 'Book Club' }], UNKNOWN_LABEL)).toEqual([]);
  });

  // The core invariant Finding 3 restores: every counted expiry is
  // clearable — the badge total (sum of all positive inviteExpiries values)
  // must equal the sum of expiryCount across the rows a user can see and
  // click, for ANY mix of known/stale/absent groupIds.
  describe('invariant — row-count sum always equals the badge-total contribution', () => {
    it.each([
      { inviteExpiries: {}, groups: [] as Array<{ id: string; name: string }> },
      { inviteExpiries: { g1: 1 }, groups: [{ id: 'g1', name: 'G1' }] },
      { inviteExpiries: { g1: 1, g2: 2 }, groups: [{ id: 'g1', name: 'G1' }] }, // g2 stale
      { inviteExpiries: { g1: 5, g2: 3, g3: 1 }, groups: [] as Array<{ id: string; name: string }> }, // all stale
      { inviteExpiries: { g1: 0, g2: 2 }, groups: [{ id: 'g1', name: 'G1' }, { id: 'g2', name: 'G2' }] }, // one zeroed-out
    ])('inviteExpiries=%o groups=%o', ({ inviteExpiries, groups }) => {
      const rows = buildInviteExpiryRows(inviteExpiries, groups, UNKNOWN_LABEL);
      const rowSum = rows.reduce((sum, r) => sum + r.expiryCount, 0);
      const badgeContribution = Object.values(inviteExpiries).reduce((sum, n) => sum + n, 0);
      expect(rowSum).toBe(badgeContribution);
      // Every row is uniquely addressable and clickable (a stale row still
      // deep-links to /groups?id=<id>&manageLinks=1, which self-heals via
      // clearInviteExpiries in groups.tsx's redirect branch).
      expect(new Set(rows.map((r) => r.groupId)).size).toBe(rows.length);
    });
  });
});
