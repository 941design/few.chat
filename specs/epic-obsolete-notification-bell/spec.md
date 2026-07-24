# Obsolete the Notification Bell — Domain Pills on Nav + Cards

**Status**: In implementation (started 2026-07-24)

> All seven product decisions are locked (§2); the two open notes (OIN-1, OIN-2)
> were resolved 2026-07-24 in favour of a single merged number per domain.

## Non-Goals

- **Not** changing `unreadStore`'s slice model or the `notification-domain-invariants`
  active-view registry (ring-vs-suppress, INV-1/INV-2). This epic changes only
  *where* a count is shown, never *when* it increments or suppresses.
- **Not** touching push / OS-level notifications (`DirectMessageNotificationsWatcher`).
- **Not** redefining what counts as "unread" or "pending".
- **Not** splitting the per-card indicator into typed/coloured pills — the locked
  design is a single numeric pill per card and one merged number per nav domain.

## 1. Intent

Today a **notification bell** (`app/src/components/NotificationBell.tsx`, mounted
twice by `Layout.tsx` — desktop header + mobile menu) is the single roll-up
surface for everything that needs attention. It is a header icon with a red total
badge and a popover dropdown. It aggregates **five event types**, each backed by a
slice in `app/src/lib/unreadStore.ts`; those five partition cleanly into **two
domains**:

| Domain | Event type | Slice | Keyed by |
|---|---|---|---|
| **Contacts** | Unread direct messages | `directMessages` | peer pubkey |
| **Contacts** | Pending contact (awaiting your Confirm/Reject) | `pendingContacts` | peer pubkey |
| **Groups** | Unread group messages | `counts` | group id |
| **Groups** | Join requests (admin) | `joinRequests` | group id |
| **Groups** | Invite-link expiries (admin) | `inviteExpiries` | group id |

`totalUnread` today is a flat sum of all five slices (`unreadStore.ts:836–841`).

**This feature removes the bell entirely.** In its place, the count is split into
its two domains and shown as pills — on the **Contacts** and **Groups** nav icons
(the domain aggregate) and on each individual **contact/group card** (that
entity's own count). No new event types are introduced; nothing about *when* a
count increments changes. This is a **presentation move**: the same five counters,
surfaced on the entities they concern instead of in one global dropdown.

### 1.1 What is already true (do not re-build)

Two of the five event types are **already** rendered as pills on their cards via
the shared `UnreadCountBadge` component (solid red, capped `99+`):

- **Group unread messages** — `GroupCard.tsx:78`.
- **Direct-message unread** — contact row, `app/pages/contacts.tsx:196`.

So the per-card pill pattern already ships for unread *messages*. This feature
extends it to the other three event types, adds the nav-level domain aggregate,
and deletes the bell.

There is also a **nav-level** precedent: the **Groups** nav item already carries a
count badge for pending group *invitations you have received*
(`Layout.tsx:201`, `pendingInvitationCount`). That badge is the visual/structural
template for the two domain roll-up pills this feature adds. (Note: that
invitation badge is a *separate* signal from the five bell slices; §6 must decide
whether it merges into the new Groups domain pill or stays a distinct badge — see
Open Implementation Note OIN-1.)

### 1.2 Two traps in "just delete the component"

Removing the bell is not a pure deletion. Two behaviours are entangled with it:

- **TRAP 1 — the expiry sweep lives inside the bell.** `NotificationBell`'s mount
  effect runs `runInviteExpiryCycle` on load and every 60 s
  (`NotificationBell.tsx:115`). This is the *only* thing that detects newly
  expired invite links while the app is open. Deleting the component naïvely stops
  expiry detection — a silent regression with no UI symptom until an admin notices
  expiries never appear. The sweep MUST be rehomed to a mount-stable host (e.g.
  `Layout` or `MarmotContext`). **This is mandatory and independent of every
  product decision below.**
- **TRAP 2 — the bell is the only cross-route surface.** The bell's total is
  visible from any page; a per-card pill is visible only while you are on that
  list. The nav roll-up pills (Decision 2) exist specifically to replace this
  cross-route awareness. Without them, removing the bell would make a DM or join
  request invisible until you happened to open the right list.

## 2. Locked decisions

1. **Two domains, six types folded in.**
   - **Contacts** domain aggregate = `directMessages` + `pendingContacts`.
   - **Groups** domain aggregate = `counts` + `joinRequests` + `inviteExpiries`
     + `pendingInvitationCount` (received group invitations — **OIN-1 resolved:
     merge into one Groups number**). This sixth signal is *not* an `unreadStore`
     slice; it is the reactive count already computed in `Layout.tsx:90`
     (`AC-INVITE-8`). The Groups nav pill therefore sums an `unreadStore`-derived
     total (`counts`+`joinRequests`+`inviteExpiries`) **plus** `pendingInvitationCount`.
2. **Nav roll-up pills.** The **Contacts** and **Groups** nav icons each carry a
   pill showing that domain's aggregate count (reusing the existing
   `pendingInvitationCount` badge pattern). Rendered in both the desktop nav and
   the mobile nav (the nav list is mapped twice in `Layout.tsx`).
3. **Per-card pills.** Each contact card and group card shows one pill = that
   single entity's event count, summed across the entity's event types.
   - A group card's count = (unread messages for that group) + (join requests for
     that group) + (expired invite links for that group).
   - A contact card's count = (unread DMs for that peer) + (1 if that peer is a
     pending contact awaiting Confirm/Reject). **OIN-2 resolved: pending folds
     into the single number** — no distinct marker; a contact with 2 unread DMs
     while pending renders `3`.
   - **Received group invitations have no group card** (you are not a member yet;
     they render as their own `InvitationCard` in the groups list). Each pending
     invitation contributes 1 to the Groups **nav** aggregate; its "per-card"
     surface is the InvitationCard itself. INV-C's parity accounts for this
     (see §3).
4. **Header/nav count = sum of that domain's per-card pills.** The nav pill is the
   arithmetic total of every card pill in that domain. Count parity is an
   invariant (§3, INV-C).
5. **Clearing = act-to-clear.** Two distinct clear triggers, by event nature:
   - **Message-like events clear on view.** Opening a group's chat clears its
     unread-message count; opening a DM thread clears that peer's DM count
     (already today's behaviour).
   - **Action-item events clear on action, not on mere viewing.** A join request
     clears when the admin approves/denies it; a pending contact clears when you
     Confirm/Reject; an invite-link expiry clears when the admin opens the
     group's **manage-links** view (today's trigger, preserved); a received group
     invitation clears when you accept/decline it (its existing lifecycle,
     unchanged — it simply now feeds the Groups nav pill while it is pending).
   - **Consequence (state this in the spec, not a contradiction):** "viewing
     removes the pill" holds *fully* only when nothing actionable remains. Opening
     a group with 5 unread + 2 join requests drops its card pill from 7 → 2 and
     the Groups nav pill by 5; the pill disappears only once the requests are also
     handled.
6. **Invite-link expiries stay in the count.** Folded into the group's card pill
   and the Groups nav aggregate; cleared when the admin opens manage-links. No
   signal is lost relative to the bell.
7. **The bell and its on-bell pills are deleted; the expiry sweep is rehomed**
   (TRAP 1).

## 3. Invariants the spec must preserve

- **INV-A (no lost signal):** every increment the bell would have shown remains
  reachable — as a per-card pill and rolled into its domain nav pill. No event
  type becomes invisible. This is the acceptance bar for the whole feature.
- **INV-B (sweep survives):** invite-link expiries continue to be detected on load
  and every 60 s after the bell is gone (TRAP 1). A test MUST fail if the sweep
  stops firing.
- **INV-C (count parity, two levels):**
  - **Contacts nav pill** == sum of every contact card's pill.
  - **Groups nav pill** == (sum of every group card's pill) + (number of pending
    received invitations, each rendered as an InvitationCard). Invitations have no
    group card, so they are counted directly at the nav level; this is the one
    documented exception to "nav == sum of card pills".
  - Each per-card pill == the sum of that entity's slices in `useUnreadCounts`
    (`counts`/`joinRequests`/`inviteExpiries` for a group;
    `directMessages`/`pendingContacts` for a contact).
  - No double-counting; no stuck badge (the same parity
    `buildInviteExpiryRows`, `NotificationBell.tsx:76`, was written to guarantee
    for the bell — a groupId present in a slice but absent from the current list
    must still be reachable/clearable, not silently inflate the total).
- **INV-D (clear semantics, per Decision 5):** message-like counts clear on view;
  action-item counts clear only on their action. Opening an entity never silently
  discards an unhandled action item.

## 4. Scope

### In scope
- Delete `NotificationBell.tsx` and its two mounts in `Layout.tsx`.
- Rehome `runInviteExpiryCycle` (the 60 s sweep) to a mount-stable host (TRAP 1).
- Add the two domain nav pills (Decision 2), desktop + mobile.
- Extend per-card pills to carry the entity's full aggregate (Decision 3): group
  cards gain join-request + expiry contribution; contact cards gain the pending
  contribution. Unread-message pills already exist.
- Wire clear triggers per Decision 5 (most already exist as `mark…Read` /
  `clear…` calls the bell rows invoked; they move to the view/action sites).
- Prune bell-only i18n strings that nothing else references
  (`copy.layout.notificationsLabel`, `noNotifications`, the per-row notification
  strings). Add any new pill aria-labels.
- Rewrite e2e coverage against the new testids. The bell has dedicated coverage
  (`app/tests/e2e/dm-giftwrap-bell.spec.ts`, plus notification assertions inside
  group/DM specs) keyed on `data-testid="notification-bell"` / `notification-badge`
  / `notification-dropdown` / `notification-item-*`. These must be **rewritten**
  against the nav-pill and card-pill testids, not merely deleted — the underlying
  ring/clear behaviour still needs asserting.

### Out of scope
- The `unreadStore` slice model and the `notification-domain-invariants`
  active-view registry (INV-1/INV-2 — ring vs. suppress). This feature changes
  only **where the count is shown**, never **when it increments or suppresses**.
- Push / OS-level notifications (`DirectMessageNotificationsWatcher`).
- Any change to what counts as "unread" or "pending", or to the maintainer-DM /
  `/feedback` special-case (its unread must still surface via the Contacts domain
  — spec author: confirm its pill placement, low stakes).

## 5. Behaviour change (product summary)

**Before:** one bell in the header; a red number = total things needing attention
across the whole app; click opens a categorised dropdown; click a row navigates
and marks it read.

**After:** no bell. Two nav pills — one on **Contacts**, one on **Groups** — each
showing that domain's aggregate. Inside each list, every card shows its own count.
Reading a thread clears its message count and decrements the domain pill; handling
an action item (approve request, confirm contact, open manage-links) clears that
part. A card's pill vanishes only when both its messages are read and its action
items handled.

| Dimension | Bell (today) | Domain pills (this feature) |
|---|---|---|
| Global attention | One number, all five types | Two numbers, one per domain |
| Per-entity detail | Only inside the dropdown | On the card itself, in context |
| Cross-route awareness | Free (bell visible anywhere) | Nav pills (Decision 2) |
| Clear trigger | Per-row click | Read (messages) / act (action items) |

## 6. Affected files & open implementation notes

Orientation for the spec author — not a design.

- `app/src/components/NotificationBell.tsx` — delete.
- `app/src/components/Layout.tsx` — remove two mounts; add two domain nav pills
  (desktop + mobile map sites); host or delegate the rehomed sweep.
- `app/src/components/groups/GroupCard.tsx` — card pill becomes group aggregate
  (messages + requests + expiries).
- `app/pages/contacts.tsx` / `app/src/components/UserCard.tsx` — card pill becomes
  contact aggregate (DMs + pending).
- `app/src/components/UnreadCountBadge.tsx` — the shared pill; likely reused as-is
  for the aggregate number (it already renders a capped count and null-below-1).
- `app/src/lib/unreadStore.ts` — unchanged slices; the feature reads
  `useUnreadCounts` and computes domain/per-entity sums at the render sites. May
  add small derived selectors (e.g. `contactsDomainTotal`, `groupsDomainTotal`)
  for reuse between nav and tests.
- `app/src/lib/marmot/inviteExpirySweep.ts` — unchanged logic, new caller.
- `app/src/lib/i18n.ts` — prune dead bell strings; add pill aria-labels.
- E2E + unit as in §4.

**OIN-1 — RESOLVED (2026-07-24): merge into one Groups number.** The existing
`pendingInvitationCount` badge is folded into the new Groups domain pill; the
Groups nav shows a single number = invitations + messages + join requests +
expiries. Consequence for the implementer: the Groups aggregate combines an
`unreadStore`-derived sum with the `pendingInvitationCount` reactive value in
`Layout.tsx:90` — these two sources must be summed at the render site. See
Decision 1.

**OIN-2 — RESOLVED (2026-07-24): fold pending into the number.** No distinct
pending marker on the contact card; `pendingContacts` contributes 1 to the single
numeric contact-card pill (and to the Contacts nav aggregate). A contact with 2
unread DMs while pending renders `3`. See Decision 3.

## Amendments

- **2026-07-24 — MV-1 dropped (spec-time manual-validation adjudication).** The
  story-planner parked a Manual Validation row asserting that new relay-dependent
  e2e spec files be named `groups-*`/`dm-*`. Refuted and dropped: this epic adds no
  new e2e spec files — it deletes `notification-bell.spec.ts` (AC-E2E-1) and rewrites
  existing specs (AC-E2E-2/3) under their existing, already-correctly-bucketed names.
  The filename-bucketing convention is therefore satisfied by construction, leaving
  nothing to hand-verify. Should a future change introduce a new relay spec, the
  standing project memory `e2e_bucket_naming_relay_trap` covers it. No open manual
  gate remains for this epic.
