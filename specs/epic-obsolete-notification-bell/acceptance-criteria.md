# Obsolete the Notification Bell — Acceptance Criteria

> Formalized from `spec.md` §2 (locked decisions 1–7) and §3 (invariants
> INV-A/B/C/D), reconciled against `exploration.json` (file:line references
> below are as of the pre-implementation baseline the explorer captured
> 2026-07-24) and `architecture.md` (module map, seams, Order-Sensitive
> Composition). Both Open Implementation Notes (OIN-1, OIN-2) are resolved;
> ACs below reflect the resolved behavior only, not the pre-resolution
> ambiguity.

## Terminology

- **domain aggregate** — the single rolled-up number for a domain (Contacts
  or Groups), shown on that domain's nav icon as a **nav pill**.
- **nav pill** — the count badge rendered on the Contacts or Groups nav item,
  reusing the `UnreadCountBadge` visual/structural pattern already used by
  the existing `pendingInvitationCount` badge (`Layout.tsx`, testid
  `groups-invitation-badge` / `groups-invitation-badge-mobile`).
- **card pill** — the count badge rendered on one contact card (`UserCard`
  via `app/pages/contacts.tsx`) or one group card (`GroupCard.tsx`), showing
  that single entity's own aggregate.
- **message-like event** — an event whose count clears on view (unread group
  messages: `counts`; unread direct messages: `directMessages`).
- **action-item event** — an event whose count clears only on an explicit
  user action, never on mere viewing (`joinRequests`, `pendingContacts`,
  `inviteExpiries`, pending received invitations).
- **`notificationCounts.ts` derivation seam** — the new pure module
  (`app/src/lib/notificationCounts.ts`, per `architecture.md`'s module map)
  exposing `groupCardTotal(slices, groupId)`, `contactCardTotal(slices,
  peer)`, `contactsDomainTotal(slices)`, `groupsDomainTotal(slices,
  pendingInvitationCount)`. This module does not exist yet — it is a
  deliverable of this epic (architecture-declared new file, not a claim
  about current repo state).
- **sweep host** — `app/src/components/DirectMessageNotificationsWatcher.tsx`,
  the mount-stable component (mounted once by `Layout.tsx`) that owns the
  rehomed `runInviteExpiryCycle` mount+interval effect after the bell is
  deleted.
- **`pendingInvitations` store** — `app/src/lib/pendingInvitations.ts`, the
  separate `localStorage`-backed store (distinct from `unreadStore.ts`) that
  is the source of the sixth Groups signal, `pendingInvitationCount`.
- **InvitationCard** — the existing card type rendered for a received,
  not-yet-joined group invitation (`app/pages/groups.tsx`); distinct from
  `GroupCard`, which only renders for joined groups.

## Known TAGs

- **NAV** — the two domain roll-up pills on the Contacts/Groups nav icons.
- **CARD** — per-entity pills on contact and group cards.
- **PARITY** — INV-C count-parity assertions between nav pills and card pills.
- **CLEAR** — INV-D act-to-clear semantics.
- **SWEEP** — INV-B expiry-sweep rehoming and continuity (TRAP 1), including
  the derived cross-cutting property ACs.
- **REMOVE** — deletion of the bell component, its mounts, and its i18n keys.
- **ETE** — survival/rewrite of existing e2e coverage against the new
  testids (the `notification-badge` oracle problem).

## Nav Pills (NAV)

**AC-NAV-1** — `contactsDomainTotal(slices)` MUST return
`sum(directMessages) + sum(pendingContacts)` for any `unreadStore` slice
snapshot passed to it (unit-level, `notificationCounts.ts`).

**AC-NAV-2** — `groupsDomainTotal(slices, pendingInvitationCount)` MUST
return `sum(counts) + sum(joinRequests) + sum(inviteExpiries) +
pendingInvitationCount` for any `unreadStore` slice snapshot and any
`pendingInvitationCount` value passed to it (unit-level,
`notificationCounts.ts`). The fourth addend MUST come from the
`pendingInvitations` store's reactive count (`Layout.tsx`'s existing
`pendingInvitationCount`, currently computed around `Layout.tsx:90–96`),
never from an `unreadStore` slice.

**AC-NAV-3** — The Contacts nav item in the desktop nav MUST render a pill
whose displayed text equals `contactsDomainTotal(slices)` for the current
store snapshot.

**AC-NAV-4** — The Contacts nav item in the mobile nav MUST render a pill
whose displayed text equals `contactsDomainTotal(slices)` for the current
store snapshot, independently of the desktop DOM instance (`Layout.tsx` maps
the nav list twice — desktop around `Layout.tsx:196–240`, mobile around
`Layout.tsx:379–425`).

**AC-NAV-5** — The Groups nav item in the desktop nav MUST render a pill
whose displayed text equals `groupsDomainTotal(slices,
pendingInvitationCount)` for the current store snapshot.

**AC-NAV-6** — The Groups nav item in the mobile nav MUST render a pill
whose displayed text equals `groupsDomainTotal(slices,
pendingInvitationCount)` for the current store snapshot, independently of
the desktop DOM instance.

**AC-NAV-7** — For both nav items, in both desktop and mobile nav, the pill
MUST NOT render (no pill element present) when that domain's aggregate is
`0`.

**AC-NAV-8** — For both nav items, in both desktop and mobile nav, the pill
MUST display `99+` (not the raw number) once that domain's aggregate exceeds
`99`, matching `UnreadCountBadge`'s existing cap behavior.

## Card Pills (CARD)

**AC-CARD-1** — `groupCardTotal(slices, groupId)` MUST return
`counts[groupId] + joinRequests[groupId] + inviteExpiries[groupId]` for any
`unreadStore` slice snapshot and any `groupId` (unit-level,
`notificationCounts.ts`). This is net-new composition: `GroupCard.tsx`
(around `GroupCard.tsx:78–81`) today only reads `counts`.

**AC-CARD-2** — `contactCardTotal(slices, peer)` MUST return
`directMessages[peer] + pendingContacts[peer]` folded into a single number
(OIN-2), for any `unreadStore` slice snapshot and any `peer` pubkey
(unit-level, `notificationCounts.ts`). A peer with `directMessages[peer] ===
2` and a nonzero `pendingContacts[peer]` MUST produce `3`, never a separate
pending marker.

**AC-CARD-3** — Each `GroupCard` MUST render a pill whose displayed text
equals `groupCardTotal(slices, groupId)` for that card's `groupId`.

**AC-CARD-4** — Each contact row in `app/pages/contacts.tsx` (via
`UserCard`'s actions slot) MUST render a pill whose displayed text equals
`contactCardTotal(slices, peer)` for that row's peer pubkey.

**AC-CARD-5** — A group card's or contact card's pill MUST NOT render (no
pill element present) when that entity's total is `0`.

**AC-CARD-6** — A group card's or contact card's pill MUST display `99+`
(not the raw number) once that entity's total exceeds `99`.

**AC-CARD-7** — A pending received group invitation MUST render as an
`InvitationCard`, and that InvitationCard MUST NOT carry a `groupCardTotal`
pill (it has no `groupId` to key one on) — its only contribution to any
pill is the `+1` it adds to `groupsDomainTotal` via `pendingInvitationCount`.

**AC-CARD-8** — The maintainer-DM (`/feedback`) special-case peer's unread
count MUST surface through the same `contactCardTotal` /
`contactsDomainTotal` mechanism as any other peer — no bespoke exemption or
separate counting path for it.

## Count Parity (PARITY)

**AC-PARITY-1** — For any `unreadStore` slice snapshot, the sum of
`contactCardTotal(slices, peer)` across every peer with a nonzero
`directMessages` or `pendingContacts` entry MUST equal
`contactsDomainTotal(slices)`. No peer's contribution may be counted twice
or dropped.

**AC-PARITY-2** — For any `unreadStore` slice snapshot and any
`pendingInvitations` snapshot, the sum of `groupCardTotal(slices, groupId)`
across every joined group PLUS the count of pending received invitations
MUST equal `groupsDomainTotal(slices, pendingInvitationCount)`. This is the
one documented exception to "nav == sum of card pills": pending invitations
have no group card, so they are counted directly at the nav level.

**AC-PARITY-3** — A `groupId` present in the `inviteExpiries` slice but
absent from the current groups list MUST remain reachable/clearable and
MUST NOT silently inflate `groupsDomainTotal` beyond what a subsequent
clear can zero out (the parity invariant the relocated `buildInviteExpiryRows`
pure function and its unit test — `sum(rows) === sum(inviteExpiries)` —
already guarantee for the bell; the relocated function and test MUST
continue to hold this invariant after relocation, see AC-REMOVE-4).

## Clear Semantics (CLEAR)

**AC-CLEAR-1** — Opening a group's chat MUST clear only that group's
`counts` entry (message-like), decrementing that group's card pill and the
Groups nav pill by exactly the cleared amount; that group's `joinRequests`
and `inviteExpiries` entries MUST be unaffected.

**AC-CLEAR-2** — Opening a DM thread MUST clear only that peer's
`directMessages` entry (message-like), decrementing that peer's card pill
and the Contacts nav pill by exactly the cleared amount; that peer's
`pendingContacts` entry MUST be unaffected.

**AC-CLEAR-3** — Approving or denying a join request MUST clear that
group's `joinRequests` entry (action-item), decrementing that group's card
pill and the Groups nav pill; merely opening the group's chat MUST NOT clear
it (see AC-CLEAR-1).

**AC-CLEAR-4** — Confirming or rejecting a pending contact MUST clear that
peer's `pendingContacts` entry (action-item), decrementing that peer's card
pill and the Contacts nav pill; merely opening the DM thread MUST NOT clear
it (see AC-CLEAR-2).

**AC-CLEAR-5** — Opening a group's manage-links view MUST clear that
group's `inviteExpiries` entry (action-item, today's existing trigger,
preserved), decrementing that group's card pill and the Groups nav pill.

**AC-CLEAR-6** — Accepting or declining a received group invitation MUST
remove it from the `pendingInvitations` store (its existing
accept/decline lifecycle, unchanged), decrementing the Groups nav pill by
exactly `1` for that invitation.

**AC-CLEAR-7** — Opening a group whose card pill combines unread messages
and pending join requests (e.g. 5 unread + 2 join requests = a card pill of
`7`) MUST clear only the message portion: the card pill and the Groups nav
pill MUST drop by exactly the message count (7 → 2 in the example), and the
card pill MUST NOT disappear while the join requests remain unhandled.

## Expiry Sweep Rehoming (SWEEP)

**AC-SWEEP-1** — On mount of the sweep host
(`DirectMessageNotificationsWatcher.tsx`), `runInviteExpiryCycle` MUST fire
at least once, independently of `NotificationBell.tsx` (which is deleted).

**AC-SWEEP-2** — After initial mount, `runInviteExpiryCycle` MUST continue
firing from the sweep host on a 60-second interval for as long as the host
remains mounted. A test using a controllable clock MUST fail if the
interval is removed or the host is unmounted without a replacement — this
is the load-bearing regression test for INV-B (TRAP 1): there is no UI
symptom if the sweep silently stops.

## Bell Removal (REMOVE)

**AC-REMOVE-1** — `app/src/components/NotificationBell.tsx` MUST NOT exist
in the repository.

**AC-REMOVE-2** — No element with `data-testid="notification-bell"`,
`data-testid="notification-dropdown"`, or `data-testid="notification-item-*"`
MUST render anywhere in the app, in either the desktop or mobile nav (the
two mounts being removed are `Layout.tsx`'s desktop mount, at
`Layout.tsx:275` in the pre-implementation baseline, and its mobile mount,
at `Layout.tsx:299`).

**AC-REMOVE-3** — The six bell-only i18n keys (`notificationsLabel`,
`noNotifications`, `directMessageNotification`, `joinRequestNotification`,
`pendingContactNotification`, `inviteExpiryNotification`) MUST NOT exist in
either the `en` or `de` objects in `app/src/lib/i18n.ts` after this epic.
The shared `unreadMessages` key MUST still exist in both `en` and `de`, and
`UnreadCountBadge.tsx`'s aria-label MUST still resolve through it.

**AC-REMOVE-4** — The pure function `buildInviteExpiryRows` MUST be
relocated to a module outside `NotificationBell.tsx` (not deleted), and
`app/tests/unit/notificationBellInviteExpiryRows.test.ts` MUST have its
import updated to the new location and MUST continue to pass, preserving
the `sum(rows) === sum(inviteExpiries)` invariant (see AC-PARITY-3).

## ETE Coverage (ETE)

**AC-ETE-1** — `app/tests/e2e/notification-bell.spec.ts` MUST NOT exist
after this epic (whole-file deletion; it asserts bell-only UI and literal
strings that no longer exist).

**AC-ETE-2** — `dm-giftwrap-bell.spec.ts`, `dm-feedback-channel.spec.ts`
(the maintainer-routing assertions around lines 118–165 in the
pre-implementation baseline), `dm-pairing-pending-confirmation.spec.ts`,
`groups-notification-domain-invariants.spec.ts`, and
`groups-join-request-live.spec.ts` (the INV-2 negative case around lines
134–150 in the pre-implementation baseline) MUST be rewritten to assert
against the new nav-pill and card-pill testids — none of these files may
retain a query against `notification-bell` / `notification-badge` /
`notification-dropdown` / `notification-item-*` — while continuing to
assert the same underlying ring/clear behavior each file exercised before
rewrite.

**AC-ETE-3** — Each of the nine oracle-only specs
(`groups-awaiting-confirmation`, `groups-ever-known-survives-leave`,
`groups-invite-link`, `groups-join-request-live`,
`groups-pull-only-invitation-accept`, `groups-pull-only-invitation-decline`,
`groups-welcome`, `dm-walled-garden-group-member-allowed`,
`dm-walled-garden-stranger-blocked`) MUST be repointed to poll a surviving
signal (a new nav pill or existing list state) instead of
`notification-badge`, and MUST continue to pass unchanged in intent (each
still confirms "the relay event landed").

**AC-ETE-4** — `app/tests/e2e/unread-badge.spec.ts` MUST continue to pass
(unmodified or extended) as the existing card-pill spec covering the
message-slice pills that predate this epic.

**AC-ETE-5** — The full 60-test `make test-e2e-all` suite MUST pass, with no
regression to existing group/DM behavior outside the scope of this epic.

## Cross-Cutting Invariants

> Derived from `architecture.md`'s `## Order-Sensitive Composition` section
> (FR-A1 signal: the epic composes one order-sensitive flow — the rehomed
> expiry sweep, INV-B/TRAP 1). Each AC below is a **property**: it
> quantifies over a space of orderings/interleavings (the generator) and
> asserts a condition that fails under violation, not a single hand-picked
> sequence.

**AC-SWEEP-3 (migrate-before-sweep ordering)** — For any sequence of sweep
host mount/unmount and interval-tick events — including simultaneous
double-mount of the host — every invocation of `runInviteExpiryCycle` MUST
complete its migrate step before its sweep step within that invocation; no
sweep step MUST observe un-migrated legacy expiry state, regardless of how
many prior cycles ran or how the host was (re)mounted.
Spans modules: inviteExpirySweep, sweep host

**AC-SWEEP-4 (at-most-once expiry notification)** — For any invite link
that becomes expired, across any number of sweep-host mounts, remounts, or
interval ticks occurring before that link is next migrated, the system MUST
produce at most one expiry notification/badge increment for that link —
repeated cycles, double-mount, or interval overlap MUST NOT duplicate the
increment.
Spans modules: inviteExpirySweep, sweep host

**AC-SWEEP-5 (60-second detection cadence survives remount)** — For any
interleaving of app lifecycle events (initial mount, remount after rehoming,
backgrounding/foregrounding) that does not remove the sweep host from the
component tree, at least one `runInviteExpiryCycle` invocation MUST occur
within every 60-second window after the host is mounted — the cadence MUST
NOT be interrupted for longer than one missed interval by any such
interleaving.
Spans modules: inviteExpirySweep, sweep host

## Manual Validation

_None._ (MV-1 was dropped at spec-time adjudication 2026-07-24 — see `spec.md`
`## Amendments`. This epic adds no new e2e spec files; it deletes one and rewrites
existing specs under their already-correctly-bucketed `dm-*`/`groups-*` names, so the
filename-bucketing convention is satisfied by construction with nothing to hand-verify.)
