# Acceptance Criteria — Contacts live updates

## Story S1 — Reactive contacts store signal + read-surface + bell wiring

### Contacts page reactivity

**AC-LIST-1** — With the contacts page already open and no reload, when a contact card is
opened against the user (they are admitted as a pending contact via the issuer-side pairing-ack
path), the new pending row appears in the list within the same mounted session.

**AC-LIST-2** — With the contacts page already open and no reload, when an inbound DM from a
newly-remembered peer arrives, the corresponding contact row appears (or updates) without a
reload.

**AC-DETAIL-1** — With a contact's DM detail view open and no reload, when that contact's
profile announcement arrives (new avatar and/or nickname), the detail header avatar and name
update in place.

### Profile image / name live update

**AC-PROFILE-1** — With the contacts list open and no reload, when a listed contact's profile
announcement arrives, that contact's row avatar and display name update to the new values.

**AC-PROFILE-2** — With the notification bell dropdown showing a row for a contact (a pending
contact or a DM row), when that contact's profile announcement arrives, the row's displayed
name/avatar updates without a reload — even though no unread count changed.

### Bell reactivity

**AC-BELL-1** — With the bell already mounted and no reload, when a pending contact is admitted
on the issuer-side pairing-ack path, the bell badge increments and a pending-contact row appears
immediately (previously required a reload for this path).

**AC-BELL-2** — The marmot-welcome pending-admission path continues to ring the bell exactly as
before (no regression to the already-working path).

### Signal mechanism

**AC-SIGNAL-1** — `MarmotContext` exposes a `contactsRevision: number` and a
`notifyContactsChanged()` callback, kept as a counter distinct from `blockedPeersRevision` /
`knownPeersRevision`. Calling `notifyContactsChanged()` bumps `contactsRevision`.

**AC-SIGNAL-2** — Every arrival-time contact write path (inbound-DM remember, profile-announce
cache write, issuer-side pending admission) results in `notifyContactsChanged()` being called
after the write lands.

**AC-SIGNAL-3** — The contacts store modules (`contacts.ts`, `contactCache.ts`,
`blockedPeers.ts`) remain free of any React/context import — the store stays a pure
localStorage layer and the reactive plumbing lives only in `MarmotContext` and its consumers.

### Non-regression / invariants

**AC-INV-1** — No profile data is published to any relay and no new network subscription or
publish is introduced; the change is limited to an in-memory change-signal and local re-reads.
(Upholds the CLAUDE.md privacy invariant.)

**AC-INV-2** — Existing contacts-list reactivity on group-membership change and manual confirm
continues to work (the page-local revision behavior is preserved or subsumed by the new signal).

**AC-INV-3** — Blocking/unblocking and unread-count behavior are unchanged; the new counter is
separate from `blockedPeersRevision` and does not alter block reactivity.

## Manual Validation

*(none — all ACs above are verifiable via unit tests over the extracted pure logic and via the
e2e suite driving the contacts/bell surfaces.)*
