/**
 * Pure builder for invite-link expiry rows, keyed off the `unreadStore`
 * `inviteExpiries` slice.
 *
 * Relocated out of the deleted `NotificationBell.tsx` (epic:
 * obsolete-notification-bell, AC-REMOVE-4). It originally fed the bell's
 * dropdown; the pill UI renders no per-expiry rows, so this function no longer
 * has a rendering consumer. It is retained (relocated, not deleted) because its
 * invariant — the sum of `expiryCount` across the rows it returns equals the
 * sum of every positive count in `inviteExpiries` — is the parity guard against
 * a stuck expiry badge (AC-PARITY-3). At runtime that invariant is upheld by
 * the sweep's `initInviteExpiries` re-derivation (which reconciles the slice
 * from persisted `InviteLink` flags every cycle); this pure function plus its
 * unit test preserve the invariant as a regression guard.
 *
 * Gate-remediation note (originally Finding 3, epic invite-link-lifecycle):
 * rows are built from EVERY key in `inviteExpiries`, not filtered to the
 * admin's current `groups` list. `useUnreadCounts().totalUnread` sums every
 * `inviteExpiries` key unconditionally; filtering to `groups` left a
 * stale/restored groupId's count in the badge total with no row to clear it — a
 * permanently stuck badge. A groupId present in `inviteExpiries` but absent
 * from `groups` falls back to `unknownGroupLabel` rather than being dropped.
 */

export interface InviteExpiryRow {
  groupId: string;
  name: string;
  expiryCount: number;
}

export function buildInviteExpiryRows(
  inviteExpiries: Record<string, number>,
  groups: Array<{ id: string; name: string }>,
  unknownGroupLabel: string,
): InviteExpiryRow[] {
  const namesById = new Map(groups.map((g) => [g.id, g.name] as const));
  return Object.entries(inviteExpiries)
    .filter(([, count]) => count > 0)
    .map(([groupId, expiryCount]) => ({
      groupId,
      name: namesById.get(groupId) ?? unknownGroupLabel,
      expiryCount,
    }));
}
