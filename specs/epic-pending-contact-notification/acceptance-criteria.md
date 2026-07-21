# Acceptance Criteria — Pending-contact notification

## Bell slice (unreadStore.ts)

- **AC-BELL-1** — A `pendingContacts: Record<string, number>` slice exists in the unread store,
  mirroring `joinRequests` (init-from-stored, increment, mark-read, clear), keyed by lowercase
  peer hex, and its sum is included in `useUnreadCounts().totalUnread`.
- **AC-BELL-2** — `initPendingContactCounts()` derives one entry per stored contact whose
  `pendingConfirmationSince` is set and which is **not** archived; an archived (blocked) pending
  contact contributes nothing (block wins).
- **AC-BELL-3** — `incrementPendingContact`, `markPendingContactRead`, and `clearPendingContact`
  behave like their join-request counterparts (idempotent set/clear; no negative counts).

## Bell UI (NotificationBell.tsx, i18n.ts)

- **AC-UI-1** — The NotificationBell renders one row per pending contact, labelled with the new
  copy and resolving the contact's display name (falling back to a truncated npub), and the row
  deep-links to `/contacts`.
- **AC-UI-2** — Clicking a pending-contact row marks it read (`markPendingContactRead`) and
  closes the popover; pending-contact rows are included in the `hasNotifications` /
  badge-total logic so the numeric badge reflects them.
- **AC-UI-3** — New copy exists in both `en` and `de` for the pending-contact notification; no
  user-visible hardcoded string is introduced.

## Bell lifecycle (welcomeSubscription.ts, startup, contacts.tsx, PendingConfirmationPrompt.tsx)

- **AC-LIFE-1** — A **fresh** pairing-ack admission (`handlePairingAck` result `admitted`)
  increments the pending-contact bell for that sender exactly once; an `already-admitted`
  result does not increment.
- **AC-LIFE-2** — On app startup, `initPendingContactCounts()` runs alongside the other
  `init*Counts`, so a pending contact carried over from a previous session appears in the bell
  without any new event.
- **AC-LIFE-3** — Confirming a pending contact (list row or prompt) clears its pending-contact
  bell entry.
- **AC-LIFE-4** — Rejecting (blocking) a pending contact clears its pending-contact bell entry,
  leaving no stranded contribution to the badge total.

## Recipient badge removal (contacts.tsx)

- **AC-BADGE-1** — A pending (non-blocked) contact's row on the contacts list shows Confirm +
  Reject and **no** "Pending" badge. The existing `data-testid` hooks for the confirm/reject
  controls are preserved.
- **AC-BADGE-2** — The blocked-contact row (Hidden badge + Unblock) is unchanged; block still
  wins over pending.

## Deferred unread (directMessageNotifications.ts, chat persistence, confirm reconcile)

- **AC-DM-1** — While a contact is pending, an inbound DM from them does **not** increment the
  unread pill or the DM bell (preserved from today), at both startup init and live ingestion.
- **AC-DM-2** — An inbound DM received while the contact is pending is **retained** (persisted),
  so its content is not lost.
- **AC-DM-3** — On Confirm, the contact's unread **pill appears immediately**, reflecting the
  number of DMs received while pending — without requiring A to open the chat first. This holds
  for **both** confirm entry points (the list-row confirm and the prompt confirm).
- **AC-DM-4** — Opening the chat after Confirm shows the retained messages and does not
  double-count them against `ContactChat`'s own load/self-heal (dedup holds).

## End-to-end (tests/e2e/dm-pairing-*.spec.ts or a new spec)

- **AC-E2E-1** — After B opens A's card, A's notification bell shows a pending-contact item and
  A's contacts row shows Confirm + Reject with no "Pending" badge.
- **AC-E2E-2** — A DM B sends while pending shows no unread pill and no DM bell entry for A.
- **AC-E2E-3** — When A confirms B, the DM unread pill appears immediately (before A opens the
  chat), and the pending-contact bell entry clears.
- **AC-E2E-4** — When A rejects B, no signal reaches B (B unaffected) and A's pending-contact
  bell entry clears.
- **AC-E2E-5** — The full suite (`make test-e2e-all`) passes.

## Manual Validation
(none)
