/**
 * Pure derivation of the notification-pill counts that replaced the removed
 * notification bell (epic: obsolete-notification-bell).
 *
 * The bell aggregated five `unreadStore` slices into one flat total. The pills
 * instead split that total into two domains — Contacts and Groups — and also
 * expose a per-entity total for each card. This module owns that arithmetic as
 * pure functions so it is unit-testable without mounting a component and reused
 * identically by the nav pills, the card pills, and their tests.
 *
 * Nothing here reads a store; callers pass store snapshots in. The Groups domain
 * total additionally folds in `pendingInvitationCount`, which is NOT an
 * `unreadStore` slice — it comes from the separate `pendingInvitations` store
 * (see `Layout.tsx`). That is why `groupsDomainTotal` takes it as an explicit
 * second argument rather than reading it from `slices`.
 */

/**
 * The five `unreadStore` count slices, each `Record<entityId, count>`. Mirrors
 * the shape `useUnreadCounts()` returns (minus its derived `totalUnread`). Kept
 * as a local structural type so this module has no runtime dependency on
 * `unreadStore` — it is pure arithmetic over plain records.
 */
export type NotificationSlices = {
  counts: Record<string, number>;
  joinRequests: Record<string, number>;
  directMessages: Record<string, number>;
  inviteExpiries: Record<string, number>;
  pendingContacts: Record<string, number>;
};

function sumValues(slice: Record<string, number>): number {
  let total = 0;
  for (const key in slice) {
    total += slice[key] || 0;
  }
  return total;
}

/**
 * Per-group card total: unread messages + pending join requests + expired
 * invite links for one group. Net-new composition — `GroupCard` previously
 * showed only the `counts` slice.
 */
export function groupCardTotal(slices: NotificationSlices, groupId: string): number {
  return (
    (slices.counts[groupId] || 0) +
    (slices.joinRequests[groupId] || 0) +
    (slices.inviteExpiries[groupId] || 0)
  );
}

/**
 * Per-contact card total: unread DMs + pending-contact flag for one peer,
 * folded into a single number (OIN-2). A peer with 2 unread DMs who is also a
 * pending contact totals 3 — there is deliberately no separate pending marker.
 */
export function contactCardTotal(slices: NotificationSlices, peer: string): number {
  return (slices.directMessages[peer] || 0) + (slices.pendingContacts[peer] || 0);
}

/**
 * Contacts nav domain total: every peer's DM unread plus every pending-contact
 * flag. Equals the sum of every contact card's pill (INV-C parity).
 */
export function contactsDomainTotal(slices: NotificationSlices): number {
  return sumValues(slices.directMessages) + sumValues(slices.pendingContacts);
}

/**
 * Groups nav domain total: every group's unread messages + join requests +
 * invite-link expiries, PLUS the count of pending received group invitations.
 *
 * `pendingInvitationCount` is the sixth signal, sourced from the separate
 * `pendingInvitations` store (not an `unreadStore` slice) — invitations have no
 * `GroupCard` (you are not a member yet), so they are counted directly here at
 * the nav level. This is the one documented exception to "nav == sum of card
 * pills" (INV-C / AC-PARITY-2).
 */
export function groupsDomainTotal(
  slices: NotificationSlices,
  pendingInvitationCount: number,
): number {
  return (
    sumValues(slices.counts) +
    sumValues(slices.joinRequests) +
    sumValues(slices.inviteExpiries) +
    (pendingInvitationCount || 0)
  );
}
