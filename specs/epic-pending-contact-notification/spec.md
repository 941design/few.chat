# Pending-contact notification (recipient-side bell, badge removal, deferred unread)

**Status**: Implemented 2026-07-21

## Problem

When B opens A's contact card, B is admitted to A's contacts in a **pending-confirmation**
state (epic `pending-contact-confirmation`, ADR-009): A must explicitly Confirm before the
new contact is treated as final. Three gaps make that pending state easy for A to miss and
awkward once resolved:

1. **No nudge.** A's notification **bell does not ring** when a new pending contact appears.
   A has an action to take (Confirm or Reject) but no signal that it is waiting — the only way
   to discover it is to visit the contacts page.
2. **Redundant "Pending" badge.** On A's contacts list the pending row shows an orange
   **"Pending" badge** *in addition to* the Confirm + Reject buttons. The buttons already make
   the state and the required action obvious; the badge is visual noise on the party who owns
   the decision.
3. **Deferred messages never surface on admit.** DMs a pending contact sends are (correctly)
   suppressed from A's unread pill and DM bell while pending — but after A Confirms, those
   messages' unread **pill only appears the next time A opens the chat**, not at the moment of
   admission. The reconcile-on-confirm currently finds nothing to count, because pending-period
   messages are never retained for counting (they are only persisted when the chat is first
   opened).

*Success signal: a new pending contact rings A's bell; A's row shows Confirm + Reject with no
"Pending" badge; a DM sent while pending shows no pill/bell until A confirms, then its unread
pill appears immediately on confirmation.*

## Solution

Three recipient-side (issuer/A) refinements to the existing pending-confirmation flow. **The
scanner (B) side is entirely unchanged** — B still adds A as a normal contact and can chat
immediately ("just chat"). This deliberately stays consistent with ADR-009 ("the scanner
continues to be admitted immediately and is unaffected"). No new protocol event, no handshake
back to B, no data-model direction discriminator.

1. **Bell category for pending contacts.** A new notification-bell entry rings when a pending
   contact appears on A's side, mirroring the existing join-request slice. It links to the
   contacts list (where Confirm/Reject live) and clears when A confirms or rejects.
2. **Remove the recipient "Pending" badge.** A's pending row shows Confirm + Reject only.
3. **Retain pending-period DMs and reveal the unread pill on admit.** DMs received while a
   contact is pending continue to be suppressed from the unread pill and DM bell, but are now
   retained so that the moment A Confirms, the unread pill appears immediately reflecting those
   messages (and opening the chat shows them).

## Constrained by ADRs

- **ADR-009 (Require issuer confirmation before admitting a scanned contact).** This epic
  operates entirely on the issuer/recipient side that ADR-009 governs and preserves its
  asymmetry: only the card issuer confirms; the scanner is unaffected. Nothing here gates or
  changes the scanner side, so ADR-009 holds unamended.
- **ADR-008 (Block is a deny layer, keyed on `archivedAt`).** Reject stays the existing
  block/archive action; block continues to win over pending (a contact that is both blocked
  and pending renders as blocked and contributes nothing to the pending bell).

## Scope

### In Scope
- A new **`pendingContacts` unread-store slice** (init-from-stored, increment, mark-read,
  clear) contributing to `totalUnread`, mirroring `joinRequests`.
- A **NotificationBell row** per pending contact, linking to `/contacts`, with en + de copy.
- Wiring the bell lifecycle: increment on a **fresh** pending admission, initialise from stored
  pending contacts on startup, clear on Confirm and on Reject/block.
- Removing the **"Pending" badge** from A's recipient row (buttons retained).
- **Retaining pending-period inbound DMs** (still suppressed from pill/bell) so the unread
  **pill appears immediately on Confirm**, via the existing reconcile-on-confirm seam.
- Unit tests for the slice, the wiring, and the deferred-unread behavior; e2e coverage.

### Out of Scope
- Any change to the **scanner (B) side** — B keeps today's normal-add + immediate-chat behavior.
- Any signal sent to B (no confirm handshake, no reject signal).
- The requester/outgoing pending role and any direction discriminator on `StoredContact`.
- The walled-garden / DM reachability gate (unchanged).
- Group join-request flows.

## Design Decisions

- **DD-1 (recipient-only; no data-model change to pending).** The pending state stays exactly
  what it is today: `StoredContact.pendingConfirmationSince` set on the issuer side by
  `rememberPendingContact` (in `handlePairingAck`), cleared by `confirmContact`. No new field;
  `isPendingConfirmation` remains the single predicate. This keeps the change additive and
  ADR-009-consistent.

- **DD-2 (bell derivable from stored state + live increment).** The `pendingContacts` slice is
  re-derivable from persisted contact state (count of pending contacts), mirroring the
  invite-expiry slice's "derive from persisted flags, live-increment on top" pattern. On
  startup it is initialised from `readStoredContacts()` (entries with
  `pendingConfirmationSince` set, excluding archived — block wins). Live, it increments on a
  **fresh** pairing-ack admission only (never on `already-admitted`, matching the existing
  admission idempotency), and clears on Confirm/Reject.

- **DD-3 (badge removal is recipient-only, buttons unchanged).** Only the orange "Pending"
  badge is removed from the recipient row. Confirm + Reject stay exactly as today, including
  reject-is-block semantics. The blocked branch (checked first) is untouched.

- **DD-4 (suppress-while-pending is preserved; retain for on-confirm reveal).** The existing
  suppression of the unread pill/DM-bell for pending contacts
  (`directMessageNotifications.ts` gates `incrementDirectMessage` on `!isPendingConfirmation`;
  `initDirectMessageCounts` filters pending peers) is preserved unchanged. The new behavior:
  inbound DMs from a pending contact are **retained** (persisted) at ingestion so that
  `reconcileConfirmedContactDirectMessageCount` — already called by `confirmContact`'s
  wrapper — finds them at Confirm time and the pill appears immediately. Persistence must
  dedupe with `ContactChat`'s own load/self-heal so a later chat-open does not double-count.

- **DD-5 (no bell for the scanner).** Only the recipient (A) gets the pending-contact bell.
  B has no pending state and no action, so nothing rings for B.

## Technical Approach

### `app/src/lib/unreadStore.ts` — new `pendingContacts` slice
Mirror the `joinRequests` slice end-to-end:
- Add `pendingContacts: Record<string, number>` to `UnreadState` (keyed by lowercase peer hex,
  value 1 per pending contact) and to `getSnapshot`/`getServerSnapshot`/initial state.
- `initPendingContactCounts()` — derive from `readStoredContacts()`: one entry per contact with
  `pendingConfirmationSince` set and not archived. Follow the `reconcileInit` pattern.
- `incrementPendingContact(peerHex)`, `markPendingContactRead(peerHex)`,
  `clearPendingContact(peerHex)` — mirror `incrementJoinRequest` / `markJoinRequestsRead` /
  `clearJoinRequestGroup` (including `noteLiveIncrement`).
- Fold the slice sum into `useUnreadCounts().totalUnread` and expose `pendingContacts` in the
  hook return.

### `app/src/components/NotificationBell.tsx` — pending-contact rows
- Build a `pendingContactRows` list from the `pendingContacts` slice, resolving display names
  via `listContacts(...)` (same fallback-to-truncated-npub pattern the DM rows use).
- Render one row per pending contact, deep-linking to `/contacts`; `onClick` calls
  `markPendingContactRead(peer)` and closes the popover. Include the rows in the
  `hasNotifications` check. Use a distinct accent (e.g. the orange used by join-request rows).

### Bell lifecycle wiring
- **Increment on admission.** On a **fresh** `handlePairingAck` admission (status `admitted`,
  not `already-admitted`), call `incrementPendingContact(senderHex)`. Wire at the dispatch site
  in `welcomeSubscription.ts` (which already reads the `HandlePairingAckResult`) so
  `pairingAck.ts` stays free of unread-store imports.
- **Init on startup.** Call `initPendingContactCounts()` wherever the other `init*Counts` are
  invoked at app load (alongside `initJoinRequestCounts` / `initDirectMessageCounts`).
- **Clear on Confirm.** In `contacts.tsx`'s `handleConfirmFromList` and in
  `PendingConfirmationPrompt.tsx`'s confirm path, call `clearPendingContact(peer)` after
  `confirmContact`.
- **Clear on Reject/block.** When a **pending** contact is blocked (reject-is-block), clear its
  pending-bell entry (`clearPendingContact`) so the badge total does not strand.

### `app/pages/contacts.tsx` — remove the recipient "Pending" badge
- In the `isPending` branch of the contacts-list row, remove the
  `<Badge>{copy.contacts.pendingBadge}</Badge>` element; keep the Confirm + Reject controls and
  the `data-testid` hooks. The blocked branch is unchanged.

### `app/src/lib/directMessageNotifications.ts` (+ chat persistence) — retain pending-period DMs
- Keep the existing `!isPendingConfirmation(peer)` gate on `incrementDirectMessage` (still no
  pill/bell while pending).
- Additionally **persist** the inbound decrypted DM to chat history even when the peer is
  pending, so it is retained. Reuse the existing chat-persistence seam
  (`chatPersistence.ts`), and ensure dedup with `ContactChat`'s mount-time
  `loadMessages`/self-heal so re-opening the chat does not double-store or double-count.
- On Confirm, `confirmContact`'s wrapper (`confirmPendingContact` →
  `reconcileConfirmedContactDirectMessageCount`, already wired) now finds the retained history
  and the pill appears immediately. Verify the list-row confirm path
  (`handleConfirmFromList`, which today deliberately skips the reconcile) also reveals the pill
  — either by reconciling there too or by an equivalent recompute.

### `app/src/lib/i18n.ts` — copy
- Add en + de entries for the pending-contact bell notification (heading/line). Reuse existing
  `pendingConfirm*` copy where it fits; do not hardcode any user-visible string.

### Worked example
1. B opens A's card → A added as normal on B's side, B chats immediately (unchanged).
2. A receives B's pairing-ack → B stored pending; **A's bell rings (+1)**; A's row shows
   **Confirm + Reject, no "Pending" badge**.
3. B sends A a DM while pending → **no unread pill, no DM bell** for A (pending-contact bell
   still shows the confirm action). The message is retained.
4. A clicks Confirm → pending cleared, pending-bell entry cleared, and the **DM unread pill
   appears immediately** for B; opening the chat shows the retained message.
5. (Reject) A clicks Reject → B blocked/archived, pending-bell entry cleared, nothing sent to B.

## Stories

- **S1 — `pendingContacts` unread slice** (`unreadStore.ts`): slice + init/increment/mark/clear
  + `totalUnread` + hook. Unit tests.
- **S2 — Bell row + copy** (`NotificationBell.tsx`, `i18n.ts`): render rows → `/contacts`,
  en + de copy.
- **S3 — Bell lifecycle wiring** (`welcomeSubscription.ts` increment-on-fresh-admission; startup
  `init`; `contacts.tsx` / `PendingConfirmationPrompt.tsx` / block-of-pending clear). Unit tests
  for the pure wiring where extractable.
- **S4 — Remove recipient "Pending" badge** (`contacts.tsx`).
- **S5 — Retain pending-period DMs + reveal pill on Confirm** (`directMessageNotifications.ts`
  + chat persistence + confirm reconcile). Unit tests: suppression preserved while pending;
  retained; pill count correct on confirm; no double-count on later chat open.
- **S6 — E2E** (`tests/e2e/dm-pairing-*.spec.ts` or a new pending-notification spec): bell rings
  on pending; no "Pending" badge; no DM pill/bell while pending; pill appears on confirm; reject
  is silent and clears the bell. Full suite (`make test-e2e-all`) green.

## Non-Goals

- **No scanner-side change.** B keeps normal-add + immediate chat. Gating B would contradict
  ADR-009 and was explicitly decided against.
- **No confirm/reject signal to B.** No handshake event, no reject notification.
- **No pending direction discriminator.** The pending state stays recipient-only; no
  `pendingDirection` field.
- **No message-persistence change beyond retention-while-pending.** The walled garden and DM
  reachability gate are untouched; retention only ensures the unread count is reconstructable
  on admit.

## Amendments

- **2026-07-21 (implementation).** Two prior-epic decisions were deliberately
  reversed to satisfy this epic, and one Codex-review hardening was added:
  1. **List-confirm now reconciles.** `handleConfirmFromList` (`contacts.tsx`)
     previously skipped `reconcileConfirmedContactDirectMessageCount` on purpose
     (a pending-contact-confirmation gate-remediation). It now reconciles so the
     retained pending-period DMs reveal the unread pill immediately (AC-DM-3).
     The narrower invariant it was protecting still holds: the reconcile reads
     via a raw idb-keyval lookup, never `chatPersistence#loadMessages`, so it
     never consumes ContactChat's one-time self-heal signal. The unit guard in
     `contacts.test.ts` was updated to encode the new behavior.
  2. **Recipient "Pending" badge removed.** The orange badge in the pending
     contacts-list row is gone (buttons retained). Existing `dm-pairing-*` e2e
     assertions that expected the badge visible / the total badge to be 0 while
     pending were updated: the pending state is now indicated by the Confirm +
     Reject controls, and the total badge legitimately reflects the new
     pending-contact bell (1 while pending) rather than 0.
  3. **Bell gated on genuine pending state (Codex review).** A fresh pairing-ack
     `admitted` result can re-fire for an already-confirmed or archived contact
     (`rememberPendingContact` preserves their existing state). `incrementPendingContact`
     therefore rings only when the stored contact is actually pending and
     non-archived (block wins), preventing a misleading, non-actionable bell row.
