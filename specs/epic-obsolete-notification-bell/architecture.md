# Architecture — Obsolete the Notification Bell

## Paradigm

React 18 / Next.js (static export) modular monolith, package-by-feature. State lives
in module-level `useSyncExternalStore` stores (`unreadStore.ts`, `pendingInvitations.ts`),
read by presentational components. This epic is **presentation-layer only**: it reads
existing stores and re-surfaces their counts. No store slice is added or mutated in shape.

## Module map

| Module | Location | Role in this epic | Owned data |
|---|---|---|---|
| unreadStore | `app/src/lib/unreadStore.ts` | **Read-only.** Source of 5 slices. Not modified (slice model out of scope). | 5 count slices |
| pendingInvitations | `app/src/lib/pendingInvitations.ts` | **Read-only.** Source of the 6th Groups signal. Self-clears via existing accept/decline. | invitation list |
| notificationCounts (NEW) | `app/src/lib/notificationCounts.ts` (new) | Pure derivation: domain totals + per-entity card totals. Extract-a-pure-function so it is unit-testable without mounting a component. | none (pure) |
| inviteExpirySweep | `app/src/lib/marmot/inviteExpirySweep.ts` | **Unchanged logic**, new caller (rehomed from the bell). | IDB expiry stamps |
| sweep host | `app/src/components/DirectMessageNotificationsWatcher.tsx` | New home for the 60s `runInviteExpiryCycle` mount+interval effect (mounted once by Layout). | none |
| Layout nav | `app/src/components/Layout.tsx` | Delete 2 bell mounts; add Contacts + Groups domain nav pills (desktop + mobile). | none |
| GroupCard | `app/src/components/groups/GroupCard.tsx` | Card pill becomes group aggregate (counts + joinRequests + inviteExpiries). | none |
| contacts list | `app/pages/contacts.tsx` (+ `UserCard.tsx` slot) | Card pill becomes contact aggregate (directMessages + pendingContacts). | none |
| i18n | `app/src/lib/i18n.ts` | Delete 6 bell-only keys (en+de); keep shared `unreadMessages`; add pill aria-labels. | none |
| expiry-rows home | wherever `buildInviteExpiryRows` relocates | Move the pure fn + its unit test out of the deleted bell. | none |

## Boundary rules

- No component reads a store's internal state directly; all reads go through the store's
  hook / snapshot exports (`useUnreadCounts`, `pendingInvitations` subscribe/getSnapshot).
- The new `notificationCounts.ts` derivation module is pure (no React, no store imports at
  module load beyond types) so it is unit-testable and reusable between nav pills, card
  pills, and tests. Components call it with store snapshots as inputs.
- `unreadStore.ts` and `pendingInvitations.ts` are **not** edited — reading only.

## Seams

- **notificationCounts ↔ render sites:** the derivation module exposes
  `groupCardTotal(slices, groupId)`, `contactCardTotal(slices, peer)`,
  `contactsDomainTotal(slices)`, `groupsDomainTotal(slices, pendingInvitationCount)`.
  Nav pills and card pills consume these; tests assert them directly.
- **sweep host ↔ inviteExpirySweep:** the host mounts the effect; the cycle is unchanged
  and idempotent. The seam is the single mount+interval call.

## Implementation constraints

- Full 60-test e2e gate (`make test-e2e-all`, Docker) is the pass bar. `notification-badge`
  is referenced by ~14 specs; 9 use it only as a "relay event landed" oracle and must be
  repointed to a surviving signal (the new nav pill or list state), not just deleted.
- New relay-dependent e2e specs MUST be named `groups-*`/`dm-*` (bucket-by-filename trap).
- Unit tests: vitest, `app/tests/unit/**/*.test.ts`, no jsdom/renderHook — test the pure
  `notificationCounts.ts` fns, not mounted components.
- All new user-facing strings go through i18n (en+de).

## Order-Sensitive Composition

This epic is **mostly not** order-sensitive: it re-surfaces existing counts and adds no
concurrency, redelivery, or merge logic. The one guarantee that crosses a timing boundary:

- **Flow:** invite-link expiry detection (INV-B). The 60s `runInviteExpiryCycle`
  (migrate → sweep → derive) must keep firing after the bell is deleted, from its new host.
- **Participating modules:** `inviteExpirySweep` (`app/src/lib/marmot/inviteExpirySweep.ts`),
  sweep host (`app/src/components/DirectMessageNotificationsWatcher.tsx`).
- **Whole-flow guarantee:** after rehoming, expiries are still detected on load and every
  60s; migrate-before-sweep ordering and at-most-once notification are preserved. The cycle
  is already idempotent/double-mount-safe, so relocation is low-risk — but a test MUST fail
  if the sweep stops firing (INV-B), because the failure is otherwise silent (no UI symptom
  until an admin notices expiries never appear).
