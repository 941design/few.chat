# Groups

*The full lifecycle of a group: creating one, the admin and member roles, bringing
people in (by identity, by link, by join request), joining one, renaming, leaving,
and membership removal — with the reasoning and failure modes the product
deliberately accepts.*

---

## One active tab per account

In the same browser, one tab at a time sends and processes group activity for an
account. Other tabs report that groups are active in another tab and show the locally
saved group list for reference. Group changes do not live-sync into the waiting tab. It uses the saved list for
DM reachability.
When the active tab releases access, a waiting tab takes over automatically without a
reload. See [Contacts & direct messages](contacts-and-direct-messages.md#7-direct-messages)
for the separate DM behaviour.

## Receiving messages after reopening

The app keeps accepted group events on this device before applying them to chat, polls,
reactions, profiles, and edits or deletes. If processing is interrupted, reopening the
app retries unfinished work in each group's saved order. Repeat delivery of a processed
event does not add another message or unread count. An event that repeatedly fails
recovery stops retrying after five failed recovery attempts so it cannot stall every
reopening.

### Fork withdrawal and send retry

When members make competing changes to a group, one branch of its history can lose.
The app withdraws events that are no longer part of the accepted history. Another
member's withdrawn message disappears, unread is recalculated from the remaining
messages, and reactions, poll results, and edits or deletes reflect the history that
remains, including when your own contributions are withdrawn. A message can return if its branch later wins.

Your own withdrawn chat message stays visible as failed and can be retried. An
unconfirmed send can also fail when the app can no longer send it, its send operation
fails, the group switches branches, or it stays unconfirmed for a minute after the
send finishes and the group has caught up. A message still queued for sending stays
pending. Only a manual retry resends a failed chat message. It uses the same message
identity, so confirmation updates the existing row. A late confirmation can also recover a failed row. See
[Notifications & unread](notifications-and-unread.md#5-unread-counts-kept-honest) for
what changes in unread and what happens to alerts already raised.

## 1. What a group is

A group is a shared, end-to-end-encrypted conversation whose membership is enforced
cryptographically: a person can read a group only while they hold its keys, and the
relays that carry the traffic cannot see who is in it or what is said. Membership is
the source of truth for everything else — only members converse, and (as the DM rules
elsewhere describe) sharing a group is what lets two people message each other
directly.

Within a group there are two roles: **admins** and **regular members**. Admin is the
authority to **change the group** — its membership and its name. Regular members do
everything that is about *participating*: read, send, react, vote in polls, share
content, and leave. The guiding split is: **conversation is open to all members;
control over the group is held by a few.**

---

## 2. Creating a group

Anyone can create a group by giving it a name. The creator becomes its **sole member
and sole admin**; the group starts with exactly one person and exactly one admin, and
can never begin with zero admins. Creating becomes available once the app has finished
starting up its group machinery; until then the create action is disabled rather than
offered and then failing. From that point, growing the group is an admin
action (§4), and the roles behave as in §3.

---

## 3. Roles: admins and members

### 3.1 Who is an admin

- **The creator** starts as the only admin (§2).
- **Everyone who joins afterwards** — whether by a direct invitation or by an approved
  join request — joins as a **regular member**. Being admitted grants membership only;
  it never grants admin.
- **Older groups** predate admin roles and carry an arrangement in which every member
  is an admin. Admin is never removed, so those members keep it; but anyone invited
  into such a group *after* admin roles arrived joins as a regular member, so an old
  group that keeps growing becomes **mixed** rather than staying all-admin.

### 3.2 What admins can do that members cannot

These actions are **admin-only**; a regular member cannot perform them.

| Action | Admin | Regular member |
|---|---|---|
| Invite a member (by identity) | Yes | No |
| Create and delete invite links | Yes | No |
| Approve or decline a join request | Yes | No |
| Cancel a pending invitation | Yes | No |
| Remove another member | Yes | No |
| Rename the group | Yes | No |
| Grant admin to another member | Yes | No |
| Leave the group | Yes* | Yes |
| Read, send, react, poll, share | Yes | Yes |

*An admin can always leave **except** when they are the only admin *and other members
remain* — see §7. A sole admin who is also the last member can still leave, which
dissolves the group.

**Where "admin-only" is actually enforced.** For actions that change the group's
shared state — inviting, cancelling an invitation, removing a member, renaming,
and granting admin — the restriction is enforced in two independent places: the app
will not initiate the action for a non-admin, *and* the protocol itself rejects such a
change even from a modified client. Two actions are weaker: creating an invite link
and *declining* a join request are purely local decisions with no protocol
counterpart, so for those the app's own refusal is the only barrier (deleting an
invite link is likewise a purely local act on the issuing admin's own device).

### 3.3 Granting admin

An admin may grant admin status to a **confirmed** member (one the group has already
registered by receiving their profile — not someone still mid-join). The grant takes
effect only after the acting admin **explicitly confirms** it, having been told it
cannot be undone. Once it propagates, the promoted member holds every admin authority,
including granting admin to others. It is never available for the acting admin
themselves, for existing admins, or for not-yet-confirmed members.

**Granting is one-way and permanent.** There is no demote or remove-admin operation
anywhere in the product. An admin who is still a member is never dropped; the only way
the admin list ever shrinks is when an admin themselves stops being a member (§7, §8).

**Why one-way, rather than a demote.** The underlying protocol offers no safe way to
remove an admin: a change to the admin list is a wholesale replacement with no
protocol-level protection for the existing set, and concurrent changes are resolved
last-writer-wins, so a losing change is silently dropped with no error. A demote built
on that foundation would be both dangerous — any admin, or a hostile client, could
strip the creator or a co-admin with nothing at the protocol level to stop it — and
unreliable, since it could be silently lost to a concurrent change. Restricting every
change to *additions only* is what makes the operation safe: concurrent grants merge
without ever removing anyone. Permanence is a consequence of the protocol's limits,
not an arbitrary rule. (This posture is recorded in **ADR-003**.)

**An honest caveat.** This add-only rule is enforced by the app, not by the protocol,
which would allow a wholesale rewrite of the admin list. The guarantee holds only as
long as everyone uses a conforming client; the product does not claim a cryptographic
guarantee of non-revocability.

**Concurrent grants.** If two admins each grant a *different* member at nearly the same
time, one grant can be lost — and neither admin is told, since both see success. The
only sign is that the intended member never gains admin authority; the remedy is to
grant again. Granting the *same* member twice is harmless: the second grant is a no-op.

---

## 4. Bringing people in (the admin side)

There are two ways an admin adds someone: inviting a known identity directly, or
issuing an invite link that turns into a join request the admin approves. Both are
admin-only, and both end in a **Welcome** that the recipient must accept (§5).

### 4.1 Inviting by identity

An admin invites someone **from their contacts** — only an existing contact can be
invited into a group. A stranger cannot be invited directly; they must be added as a
contact first. A contact who is already a member, blocked, or still pending
confirmation as a contact cannot be selected. A contact who has been invited but has
not yet accepted already counts as a member of the group, so they too cannot be
selected again; they are marked as **invitation pending** — distinct from a confirmed
member, who is marked as already in the group. There is no resend path while an
invitation is outstanding.

For an invitation to succeed, the invitee must have **published the identity keys**
that let others add them (this happens automatically when someone sets up their
identity). If they have not, the invitation fails with an explanation that the person
hasn't set up their identity yet. If delivery cannot be confirmed, the invitation can remain retryable.

**Where the invitee's keys are looked for.** The inviter searches its configured relays
and safe public relay addresses advertised in the invitee's inbox and write relay
lists. It tries up to six matching key packages, newest first, skipping packages that
cannot be used. An invitation can fail if the inviter cannot discover the invitee's
lists or keys from the relays it can reach. The Welcome is delivered through the
invitee's inbox relay routing (see [Contacts & direct messages](contacts-and-direct-messages.md#7-direct-messages)).

A successful invitation adds the person to the roster and sends them a Welcome; it
does **not** make them an admin (§3.1). Inviting from the contact's own profile
confirms success there even when that was the last group they could be invited to —
the confirmation does not disappear just because no group is left to offer.

### 4.2 Invite links

An invite link lets an admin admit people who are not yet contacts. A link carries an
**opaque identifier**, not any group secret or key — it cannot by itself add anyone.
Opening a link produces a **join request** to the admin (§4.3); it is permission to
*ask*, not an open door.

- **Only an admin can create a link, and only from their own device.** A link and the
  join requests it produces are visible only to the admin who created it — other
  admins cannot see, receive requests for, or delete someone else's link. An admin can
  delete their own links at any time.
- A link records how many people have **joined through it** — an approval tally, not a
  count of who is currently a member (someone who joined and later left still counts).
- **A link cannot be recalled — only ignored.** Once shared, a link is out in the
  world — on a phone, in a chat history, on a printed page — and the app has no way to
  make the URL stop working. Everything that "stops" a link works the same way: by
  making the admin's app **silently ignore** any join request that presents it. There
  is no revocation of the link itself, only a standing decision to drop what it
  produces. A link stops admitting anyone in exactly two ways:
  - **An admin deletes it.** Deletion is immediate and **terminal** — a deleted link
    cannot be reactivated; to admit people again the admin creates a fresh one.
  - **It expires on its own.** Every link expires automatically **one day** after it
    is created, with no admin action, and an expired link admits no one. The one-day
    rule is enforced for every link, including ones already stored when it took effect.
- When one of an admin's links expires, the admin is **notified** — except for links
  that were already more than a day old when the one-day rule took effect, which are
  treated as long-expired and raise no notification. The person holding a link is never
  told it has died — their request simply never leads to admission.

### 4.3 Join requests

A join request is a private message to the admin — encrypted and addressed, never a public
post — and it carries the requester's chosen display name inside that encrypted
envelope (never broadcast). The request's sender is cryptographically authenticated,
so it cannot be forged to look like it came from someone else.

- **A join request reaches only the admin whose link it was** — not every admin. If
  that admin leaves the group or becomes unreachable, requests made against their link
  have no one who can approve them and simply go unanswered; other admins cannot see or
  act on them.
- **Every request requires an explicit admin decision** — approve or decline. There is
  no auto-approval.
- A request is **silently discarded** (the requester is never told) when: the link is
  unknown, deleted, or expired; the requester is already a member; or the same person
  already has a request pending for that group (duplicates collapse to one).
- **Approving** admits the requester (exactly as inviting by identity does) and clears
  the request. **Declining** just clears the request locally and sends nothing back —
  a declined requester is never notified, deliberately, so there is no signal an
  outsider can use to probe the group. The cost is that a legitimately declined person
  may keep waiting without knowing.
- Approving is always allowed regardless of the link's current state — the link's
  expiry/deletion only gates *incoming* requests, never an admin's decision on one
  already received.

### 4.4 Cancelling a pending invitation

An admin can cancel a pending direct invitation by removing the invitee from the
group and clearing the pending invitation. The action uses the same membership removal
as §4.5. Once the invitation is confirmed, removing the member is a separate admin action.

### 4.5 Removing a member

An admin can remove another member. As the membership change reaches each device,
the remaining members see the updated roster and use refreshed group keys. The removed
member's device clears its local copy when it learns of the removal (§8). An admin's
own exit is leaving (§7).

---

## 5. Joining a group (the invitee side)

However an admin adds someone, the person receives a **Welcome**, the cryptographic
grant of membership. Receiving a Welcome does not, by itself, put them in the group.

### 5.1 A Welcome must be accepted (pull-only)

A Welcome waits for the recipient to accept or decline it, except for the join request
case in §5.2. Consent matters because joining gives group co-members DM reachability
(ADR-002). A blocked sponsor's invitation is silently dropped.

The recipient sees a generic group label until a matching sponsor supplies the group
name through the private inbox. The label can update in place regardless of arrival
order. The name is the sponsor's claim and is shown as plain text. After seven days,
the app discards the stored name and returns to the generic label. The preview omits
descriptions and admin lists.

A sponsor is trusted if they are you or an ever-known peer, including someone you
added as a contact. A stranger invitation expires after 14 days. Trusted invitations
do not age out under this rule. The app keeps up to eight invitations per sponsor,
preferring already shown invitations, then older ones. Of those, it keeps up to 256
overall, preferring trusted sponsors first, then already shown invitations, then older
ones. A trusted arrival can displace a stranger invitation. Excess and expired invitations
are silently declined.

An explicit decline removes the invitation and sends a private decline. For a tracked
direct invitation, the sponsor's app removes that invitation's membership after syncing
the group, then announces the decline in the group. Once the sponsor records the
decline locally, cleanup can resume when the app reopens. Ignoring a Welcome leaves
it pending within the rules above.

### 5.2 Accepting your own request automatically

A Welcome received after an unexpired join request can complete that request when
the same account sent it, the authenticated sponsor matches the admin asked, and the
sponsor's group name matches the requested name. The app binds the request to one
invitation before joining and keeps that binding across reloads. Earlier requests
without account ownership remain available for manual handling.

If the context has yet to arrive, the Welcome waits with its generic label and is
checked again when the context arrives. A different sponsor, a name mismatch, or an
expired request leaves the invitation for an explicit decision.

### 5.3 First visit and onboarding

Someone opening an invite link **without an identity yet** is set up automatically (a
new identity is generated and its keys published), and the join resumes on its own. A
first-time visitor is introduced to the app before continuing. To **send a join
request a person must provide a display name** — the request is held until they do; a
name is required so the admin sees who is asking rather than a bare key. Someone who
already has an identity and a name goes straight to confirming the request.

### 5.4 What joining changes

Accepting a Welcome makes the person a **regular member** (never an admin, §3.1). It
also permanently marks everyone then in the group as an **"ever-known" peer** of theirs
— which is what keeps those people able to message them directly even after the group
later disbands (the DM-reachability rules cover this in full).

---

## 6. Renaming a group

Renaming changes the group's shared name. **Only an admin may rename**, enforced by the
protocol, not merely the app. The constraints on the name itself are app-level: it must
be non-empty after trimming surrounding spaces and at most 64 characters; an invalid
name is refused and nothing changes. Renaming to the current name is a no-op. On a real
change, the shared name updates for every member as it propagates.

---

## 7. Leaving a group

- **Last member.** Confirming abandonment deletes the local group and its history.
  There is nobody else to notify.
- **Last admin with other members.** Leaving is blocked. Grant admin to another
  member first (§3.3).
- **Other members and admins.** Confirming hides the group immediately while the
  departure runs in the background. The app first tries to send a departure
  announcement. It proceeds with leaving if the announcement fails or is slow.
  Other members see the roster change as they sync, without waiting for an admin to
  approve the departure.

A successful leave clears this device's group keys, history, messages, polls, member
profiles, and invitation data. Other groups and established DM reachability are
preserved. If the leave fails or times out, the app reports the failure and shows the
group again. If you reload mid-leave, the group can reappear if the departure did
not complete.
A former member can rejoin with a fresh invitation.

---

## 8. When your membership is removed

When your device learns that an admin has removed you, the group disappears and its
local data is cleared, just as after leaving (§7). An offline device checks its
membership when it reopens, so it can clean up even if it missed the original removal.
Messages you sent remain in other members' histories. A fresh Welcome can let you
rejoin without bringing back the deleted local history.

---

## 9. Message authenticity: who really sent a message

Group messages are attributed to the member authenticated by the group's
cryptographic state. The name or author claimed inside the message cannot confer
another member's identity or authority. Where a system announcement names an actor,
the app checks the claim against the authenticated sender and the group's current
membership or admin rules before applying it.

---

## 10. The central trade-off

- **What you gain:** membership and the group's name can only be changed by a small,
  trusted set of admins, not by anyone who happens to be a member.
- **What you pay:** if no admin is reachable, members cannot make changes that require
  admin authority. Existing members can still exchange messages or leave if eligible.

The one genuinely hard failure is narrow and is about **control, never conversation**:
if no admin is ever reachable again — the sole admin lost their key or abandoned the app
— the group can no longer change its membership, name, or admins, permanently, though
members can still talk indefinitely. The only defence is to grant admin to a few trusted
members early; there is no recovery after the fact.

---

## 11. Edge cases and how they resolve

**A group send is not confirmed.** The message stays in the conversation. If it fails,
you can retry the same message (see [Fork withdrawal and send retry](#fork-withdrawal-and-send-retry)).
Direct messages have their own send-failure behaviour in
[Contacts & direct messages](contacts-and-direct-messages.md#7-direct-messages).

**Inviting someone with no published identity keys.** The invitation is refused with an
explanation that the person hasn't set up their identity; it is not silently lost.

**Re-inviting a contact whose invitation is still outstanding.** Not possible: an
invited-but-not-accepted person already counts as a member, so they cannot be selected
again, and there is no resend path until they have actually been removed.

**A join request for an unknown, deleted, or expired link.** Silently discarded at the
admin's device; the requester sees no error and is never told.

**A join request from someone already a member, or a duplicate request.** Silently
discarded / collapsed to a single pending request.

**A forged or unsolicited Welcome.** Never auto-accepted. Authentication only proves a
Welcome came from whoever signed it — an attacker signing with their *own* key passes
that check — so what actually protects the recipient is that the Welcome matches no
outstanding request of theirs and therefore waits in the pending list for an explicit
decision. A Welcome forged to appear to come from *someone else* fails authentication
outright.

**A Welcome accepted too late.** If the group's cryptographic state has moved past the
Welcome, accepting fails with a "no longer valid" message and the entry is discarded.

**Re-inviting someone who left or was removed.** Once their previous membership is gone,
a fresh Welcome lets them rejoin with fresh history (§7–§8).

**An accept cut short by a reload or a closed tab.** After reopening, the app reads
the saved membership and the remaining pending invitations. If the join took effect,
the group appears. If the Welcome is still pending, it can be accepted again.

**The link's admin leaves or is unreachable.** Requests made against that link go
unanswered — no other admin receives them. This is the single-admin-per-link limitation.

**Two admins granting admin at the same moment.** Last-writer-wins (§3.3); neither sees
an error, and a lost grant is re-issued once the privilege is seen not to have taken.
Granting the same member twice is a harmless no-op.

**A departing admin.** The departure removes their admin authority as the membership
change syncs. Remaining admins keep their authority and no successor is auto-promoted.

**The departure announcement fails.** The app still attempts the leave. The roster
change comes from membership state when others sync.

**The join-through-link tally counts approvals, not completed joins.** The count rises
when an admin approves a request, even if that person never accepts the resulting
Welcome, so it can exceed the number who actually joined.

**An approved join can go stale.** The automatic acceptance of your own request only
holds for about a week after you asked; if an admin approves later than that, the
Welcome arrives as an ordinary pending invitation you must accept explicitly.

**A declined join-requester can simply ask again.** Duplicate suppression looks only at
*pending* requests, so after a decline a fresh request through a still-valid link
reappears to the admin.

**Identity comparisons** throughout (who is an admin, who may be cancelled, who is
blocked from leaving) are case-insensitive, so letter-casing never changes the outcome.

**A "left the group" notice for a member whose name is unknown or blank.** The notice names the
leaver by the name they included in their departure announcement, else by the name you have
for them, else by a shortened form of their identity key — an empty or whitespace-only name
counts as no name at all, so the notice never reads " left the group" with the name missing.

**A system announcement naming a member by a malformed identity.** A "left", "invitation
cancelled", "invited/joined/declined" or "admitted" notice whose named member is not a
well-formed identity is not treated as an announcement at all — it shows as an ordinary
text message, and the conversation keeps rendering for everyone.

---

## 12. Deliberately out of scope

- **Demoting or revoking an admin** — contradicts the add-only invariant (§3.3).
- **Retroactively demoting members of older all-admin groups** — forward-only; no
  migration.
- **Role tiers beyond admin / member** (e.g. moderators) — the model is binary.
- **An approval-gated exit ("request to leave")** — rejected; it would break the right
  to leave.
- **Recovering a group whose sole admin lost their key or walked away** — no mechanism
  exists; the only protection is proactive admin grants.
- **Reactivating a deleted or expired invite link** — deletion and expiry are terminal;
  the admin creates a fresh link.
- **Telling a declined or ignored requester** anything — silence is deliberate.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions,
the shipped implementation, and the automated test suite:

- `specs/groups-feature-spec-request.md` — group creation and the invite model.
- `specs/epic-feature-request-admin-role-management-for-groups/` — the admin role,
  granting, admin-gated actions, and last-admin protection.
- `specs/epic-group-invite-links/`, `specs/invite-links.md`, and
  `specs/epic-invite-link-lifecycle/` — invite links and join requests; the lifecycle
  epic supersedes the original mute mechanism with one-day auto-expiry and terminal
  deletion.
- `specs/epic-group-invite-link-onboarding/` and `specs/epic-first-visit-invite-welcome/`
  — authenticated Welcomes, auto-accept correlation, the name gate, and onboarding.
- `specs/invite-group-member-from-contacts-spec-request.md`,
  `specs/epic-invite-group-member-from-contacts/`, and
  `specs/epic-invite-contact-picker-redesign/` — inviting from contacts.
- `specs/epic-walled-garden-v2/` — pull-only invitations and ever-known peers.
- `specs/epic-marmot-library-adoption/acceptance-criteria.md` — AC-MT, AC-LEAVE,
  AC-MEM, AC-HIST, AC-WDR, AC-KP, AC-CAP, AC-CTX and AC-AUTO.
- ADR-002 and ADR-003 under `docs/adr/` — consent and the add-only admin policy.
- `app/src/context/MarmotContext.tsx` and `app/src/lib/marmot/client/` — active tab
  and group startup. `app/src/lib/marmot/membership/` and
  `app/src/lib/marmot/invitations/` — leaving, removal, and invitations.
- `app/src/lib/marmot/history/`, `app/src/lib/marmot/handlers/` and
  `app/src/lib/marmot/send/` — history, withdrawal and
  send confirmation. See the history, send, membership and invitation suites under
  `app/tests/unit/marmot/`.
