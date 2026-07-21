# Contacts live updates (reactive contacts store)

**Status**: Implemented 2026-07-21

## Problem

The contacts page, the notification bell, and a contact's profile image do **not** update
when the relevant events arrive over the network — the user must reload the page to see them.

Three concrete gaps, all rooted in one cause:

1. **New contact card does not appear on the contacts page.** When a contact card is opened
   against the user (they are admitted as a pending contact) or a peer's inbound DM remembers
   them, the contact record is written to `localStorage` but the contacts list does not
   re-render. The new/pending row only appears after a manual reload.
2. **The bell does not ring on every arriving contact card.** The bell badge is reactive, but
   only the paths that call `incrementPendingContact` ring it. The issuer-side pairing-ack
   admission (`pairingAck.ts`, `rememberPendingContact`) admits a pending contact **without**
   incrementing the bell slice, so that arrival is silent until the next reload (where
   `initPendingContactCounts` rebuilds the count from stored state).
3. **Profile image/name updates do not surface.** When a peer's profile announcement arrives
   (nickname/avatar), the new values are written to the contact cache but no signal is
   emitted. The contacts list, the open DM detail header, and the bell's dropdown rows all
   keep showing the stale avatar/name until reload.

*Success signal: with the contacts page (or the bell) already on screen and no reload, an
arriving contact card makes the row appear and the bell ring immediately; an arriving profile
announcement updates that contact's avatar and name in place wherever it is shown.*

**Root cause.** `contacts.ts` and `contactCache.ts` are a purely synchronous `localStorage`
read/write layer with **no subscribe/emit mechanism**. Reads (`listContacts`, `getContact`)
are always correct if re-invoked, but nothing tells a mounted component to re-invoke. The
contacts page relies on a page-local `contactsRevision` counter that is bumped only on
group-membership change and on manual confirm — never on an arriving event.

## Solution

Introduce one reactive change-signal for the contacts store and wire every arrival-time write
to it and every live read surface to consume it — mirroring the existing
`blockedPeersRevision` / `notifyBlockedPeersChanged` precedent in `MarmotContext`, which
already signals "something in `contacts.ts`'s underlying storage changed" for the block/unblock
case that reads from the identical `readStoredContacts()` source.

1. **Add a contacts change-signal to `MarmotContext`** — a `contactsRevision: number` plus a
   `notifyContactsChanged()` callback, exactly analogous to `blockedPeersRevision` /
   `notifyBlockedPeersChanged` (which stays a separate counter per that context's own
   documented convention).
2. **Emit on every arrival-time contact write.** The watchers that receive events
   (`DirectMessageNotificationsWatcher` for inbound DMs / `rememberContact`; `ProfileHealWatcher`
   for profile announcements; the pairing-ack admission) call `notifyContactsChanged()` after a
   write lands. Writes that already run inside a React component/effect context reach the
   callback through `MarmotContext`.
3. **Consume the signal on every live read surface.** The contacts page's list view and detail
   view re-derive `listContacts` / `getContact` on a `contactsRevision` bump; the bell's
   dropdown rows re-derive their `listContacts()` lookup on the same signal so a profile update
   refreshes the displayed name/avatar even when no unread count changed.
4. **Close the bell asymmetry.** The issuer-side pending-contact admission rings the bell on
   arrival (calls `incrementPendingContact`) so a newly arrived pending contact is signalled on
   every arrival path, not only the marmot-welcome path — consistent with the
   `pending-contact-notification` epic's intent (AC-LIFE-2 already handles the carried-over case
   at mount).

The page-local `contactsRevision` counter in `contacts.tsx` is unified behind the new
context-level signal (the existing group-change/confirm bumps continue to work).

## Constrained by ADRs

- **ADR-008 / block-contact.** The new `contactsRevision` signal is a sibling of
  `blockedPeersRevision`, kept as a separate counter following that context's documented
  "separate counters, do not conflate" convention. Block/unblock reactivity is unchanged.
- **ADR-009 / pending-contact confirmation.** The issuer-confirmation asymmetry is preserved:
  ringing the bell on arrival is a recipient-side signal only; the scanner side is untouched.
- **Privacy invariant (CLAUDE.md).** This epic only adds an in-memory "something changed"
  pulse and re-reads local state. It publishes nothing and changes no network/relay behavior.
  No profile data crosses any new channel.

## Scope

### In Scope
- A `contactsRevision` counter + `notifyContactsChanged()` in `MarmotContext`.
- Wiring the arrival-time writers (inbound-DM remember, profile-announce write, pairing-ack
  pending admission) to notify.
- Consuming the signal in `contacts.tsx` (list + detail) and `NotificationBell.tsx`.
- Ringing the bell (`incrementPendingContact`) on the issuer-side pending admission path.

### Out of Scope
- Any change to network/relay behavior, subscriptions, or what is published.
- Refactoring the contacts store into a full external store (Pattern A); the revision-counter
  pattern (Pattern B) is the idiomatic, minimal choice here.
- Group-membership or unread-count semantics beyond the bell-ring asymmetry noted above.
- New copy/translations (no new user-visible strings are introduced).

## Design Decisions

1. **Revision counter over a full external store.** `contacts.ts` reads are already correct
   if re-invoked; the only missing thing is a "re-invoke now" pulse. A revision counter on
   `MarmotContext` (Pattern B, as used for `blockedPeersRevision`) delivers that without
   duplicating contact data into a second in-memory store. `blockedPeers.ts` derives from the
   same `readStoredContacts()` source and already proves this shape.
2. **Notify from the watcher/effect layer, not from inside `contacts.ts`.** The store stays a
   pure localStorage layer (consistent with `blockedPeers.ts` holding no state); the reactive
   plumbing lives in `MarmotContext` and its consumers, so non-React callers of the store are
   unaffected and there is no import cycle from the store into React context.
3. **Bell rows re-derive names on the same signal.** The bell badge count is already reactive;
   only the row's `listContacts()` name/avatar lookup is stale on a profile update. Keying that
   `useMemo` on `contactsRevision` (in addition to its slice deps) fixes the stale-name case
   with no new store.

## Technical Approach

Key files (all under `app/`):
- `src/context/MarmotContext.tsx` — add `contactsRevision` state + `notifyContactsChanged`
  callback (mirror `blockedPeersRevision` at `:356`/`:362`/`:2027`/context value/default stub).
- `src/components/DirectMessageNotificationsWatcher.tsx` — notify after inbound-DM
  `rememberContact` writes land (the subscription's event handler in
  `directMessageNotifications.ts:127,191`).
- `src/components/ProfileHealWatcher.tsx` — notify after a profile announcement writes the
  contact cache (`dmProfile/receive.ts` → `contactCache.ts` `writeContactEntryNeutralized`).
- `src/lib/pairing/pairingAck.ts` (`:459`) — ring the bell (`incrementPendingContact`) on the
  issuer-side pending admission, and ensure the admission notifies the contacts signal.
- `pages/contacts.tsx` — list + detail views consume `contactsRevision` from `useMarmot()`.
- `src/components/NotificationBell.tsx` — key the DM-row and pending-contact-row `useMemo`s on
  `contactsRevision` so profile updates refresh displayed names/avatars.

Because several arrival writers run outside React (module-level subscription handlers), the
notify is bridged at the watcher component that owns the subscription (it already holds
`MarmotContext` via `useMarmot()` and can pass `notifyContactsChanged` into the subscription
callback via a live ref, exactly as `DirectMessageNotificationsWatcher` passes the block-set
ref today).

## Stories

Single story — the change is one cohesive reactive-signal wiring across a small set of files
with a shared seam (the `MarmotContext` counter). Splitting it would create an artificial seam
between "add the signal" and "consume the signal" that cannot be independently verified.

## Non-Goals

- No new network publishing or relay interaction.
- No migration of the contacts store to a `useSyncExternalStore` external store.
- No new user-facing copy.
- No change to blocking, unread-count, or group-membership semantics beyond the bell-ring fix.
