# Architecture — Pending-contact notification

## Paradigm
Package-by-feature within the existing Next.js static-export PWA. This epic is
**additive and recipient-side only** — it introduces one new unread-store slice and
threads it through existing seams. No new module boundary, no protocol event, no
data-model field (DD-1). The scanner (B) side is untouched.

## Module map (touched surfaces)

| Module | Location | Role in this epic |
|---|---|---|
| unread-store | `app/src/lib/unreadStore.ts` | NEW `pendingContacts` slice mirroring `joinRequests` (CountSlice + reconcileInit). Owns `totalUnread`. |
| notification-bell | `app/src/components/NotificationBell.tsx` | Renders one row per pending contact → `/contacts`. |
| i18n | `app/src/lib/i18n.ts` | en + de copy for the pending-contact bell line. |
| dm-watcher | `app/src/lib/directMessageNotifications.ts` | Live inbound-DM ingestion; adds retain-while-pending persistence. |
| contacts-page | `app/pages/contacts.tsx` | Removes recipient "Pending" badge; list-confirm now reveals the pill; reject clears the bell. |
| pending-prompt | `app/src/components/contacts/PendingConfirmationPrompt.tsx` | Confirm/reject paths clear the bell. |
| welcome-subscription | `app/src/lib/marmot/welcomeSubscription.ts` | Increments the bell on a **fresh** pairing-ack admission. |
| startup wiring | `app/src/components/DirectMessageNotificationsWatcher.tsx` (or MarmotContext) | Calls `initPendingContactCounts()` at load. |

## Boundary rules
- No new cross-module imports beyond the existing unread-store consumer graph.
  `pairingAck.ts` stays free of unread-store imports (increment wired at the
  `welcomeSubscription.ts` dispatch site — spec Technical Approach).
- The pending predicate stays single-sourced: `isPendingConfirmation` /
  `pendingConfirmationSince` (DD-1). The slice's init combines it with
  `!archivedAt` explicitly (block wins — AC-BELL-2), because `isPendingConfirmation`
  itself ignores `archivedAt`.

## Seams
- **Bell increment seam:** `welcomeSubscription.ts` pairing-ack dispatch, gated on
  `pairingResult.status === 'admitted'` (never `already-admitted` — AC-LIFE-1).
- **Retain-and-reveal seam:** the dm-watcher persists pending-period inbound DMs via
  `chatPersistence.appendMessage(directConversationId(peer), msg)` (id-deduped);
  `reconcileConfirmedContactDirectMessageCount` (already called by
  `confirmPendingContact`) counts them on Confirm. The list-confirm path is switched
  to also reconcile (today it deliberately skips — DD-4 / AC-DM-3).

## Implementation constraints
- Count-only readers must never route through `chatPersistence.loadMessages` (it
  consumes the one-time self-heal `refetchIds` signal). The slice init and the
  reconcile use raw `idb-keyval` reads — matching the existing `initDirectMessageCounts`
  and `reconcileConfirmedContactDirectMessageCount` discipline.
- Persisted `ChatMessage.id` = rumor id (kind-1059) / event id (kind-4), matching
  `ContactChat`'s dedup so a later chat-open re-append is a no-op (AC-DM-4).
- Static export: no new dynamic path segments; the bell row deep-links to `/contacts`
  (query-string / static route).

## Order-Sensitive Composition
This epic **does** compose order-sensitive behavior: the deferred-unread flow depends
on ingestion order, redelivery, and dedup across two independent persistence producers.

- **Composed flow:** retain-while-pending → confirm-reconcile → later chat-open.
- **Participating modules:** dm-watcher (`app/src/lib/directMessageNotifications.ts`),
  unread-store (`app/src/lib/unreadStore.ts`,
  `reconcileConfirmedContactDirectMessageCount` + `reconcileInit`/`reconcileFloor`),
  chat-persistence (`app/src/lib/marmot/chatPersistence.ts`, `appendMessage` dedup),
  ContactChat (`app/src/components/contacts/ContactChat.tsx`, mount-time load/self-heal).
- **Whole-flow guarantees that must hold across orderings/interleavings:**
  1. A pending-period inbound DM is persisted exactly once regardless of relay
     redelivery (id-dedup in `appendMessage`).
  2. On Confirm the pill count equals the number of retained, unread, peer-sent
     messages — and never double-counts if `ContactChat` later re-appends the same
     ids (AC-DM-4).
  3. A DM landing mid-reconcile is not lost (existing `reconcileFloor` protection).
  4. While pending, the count/bell stay suppressed at both startup init and live
     ingestion (AC-DM-1).
