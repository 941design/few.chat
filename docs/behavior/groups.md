# Groups

*The full lifecycle of a group: creating one, the admin and member roles, bringing
people in (by identity, by link, by join request), joining one, renaming, leaving,
and removing a departed member — with the reasoning and failure modes the product
deliberately accepts.*

---

## Receiving messages after reopening

Application handlers are attached before historical group messages are ingested.
Historical readiness waits for queued application processing, including storage
writes, before history-dependent profile publication begins. This covers chat,
polls, profiles, reactions, and edit/delete messages through the same authenticated
message channel. Messages are processed in arrival order within each subscription.

Leaving a subscription cancels work that has not started and detaches its
listeners. A pending historical fetch that completes after cancellation cannot
start a live subscription. A handler already running must finish before its
storage can safely be reassigned to another account; full account-transition
isolation remains under review. Offline two-peer recovery and rapid React lifecycle
transitions still require integration verification.

**A reload or closed tab while a message is being received does not lose it.**
Decrypting a group message moves the group's keys forward, and the advanced keys are
saved before the message itself has been stored — once that happens the message can
never be decrypted again. So each decrypted message is first kept on the device, and
only then may the advanced keys be saved. A kept message is discarded only once its
processing **completed** — everything it had to store on the device was stored. One whose
processing was cut short, or failed to store what it needed (for example a storage error
while saving a chat message, a reaction, an edit or deletion, or a pending member
removal), stays kept and is processed
again the next time the group is opened, before any newly arriving message. Processing a
message again is safe by design: chat messages, profiles, poll votes and reactions are
stored at most once, an edit or deletion re-applied gives the same result, a departure is
queued once per membership, and nothing is counted or announced twice.
Within one opening of a group a message is processed once; a re-received copy is ignored
and does not discard a kept message whose processing failed.

- **What this guarantees:** a message that was decrypted and kept is processed again
  until its processing completes, even if the page goes away, or storage fails, before
  it is stored — up to five failed attempts. A message that fails on every one of them
  (for example one that can never be stored) is then discarded and the failure is
  logged, so it does not keep being retried for 30 days. If discarding a completed
  message itself fails, it is not processed again while the app stays open, and the
  discard is retried; after a reload it may be processed once more, without visible
  effect.
- **What it does not:** if keeping the message fails (for example, the device's storage
  is full) the message is processed as before, and a reload at that moment can still
  lose it. A failure the app treats as recoverable by other means is not retried this
  way: anything about a profile request (recording it, or answering it — the requester
  asks again), noting that a requested profile has arrived (at worst it is requested
  once more). A kept message that is not processed within 30 days is discarded; there is
  no limit on how many are kept for one group, so a long catch-up cut short is resumed
  in full.
- Kept messages stay on this device only: they are not part of the relay backup, are
  never sent anywhere, and are removed when you leave the group or the account's
  local data is cleared.


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
| Finalise a departed member's removal | Yes | No — deferred to an admin |
| Leave the group | Yes* | Yes |
| Read, send, react, poll, share | Yes | Yes |

*An admin can always leave **except** when they are the only admin *and other members
remain* — see §7. A sole admin who is also the last member can still leave, which
dissolves the group.

**Where "admin-only" is actually enforced.** For actions that change the group's
shared state — inviting, cancelling an invitation, removing a member, renaming,
granting admin, and finalising a removal — the restriction is enforced in two independent places: the app
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
selected again — there is no resend path while an invitation is outstanding.

For an invitation to succeed, the invitee must have **published the identity keys**
that let others add them (this happens automatically when someone sets up their
identity). If they have not, the invitation fails with an explanation that the person
hasn't set up their identity yet. Other failures — the invitee being unreachable, or
the lookup timing out — surface as distinct errors; the invite is not silently lost.

A successful invitation adds the person to the group and delivers them a Welcome; it
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

An admin can cancel a **pending member** — someone who is in the group's cryptographic
tree but whom the group has not yet **confirmed** (no profile has arrived from them
yet). This is how an admin withdraws an invitation sent to the wrong person before it
is accepted. Cancelling removes that person **immediately**; it does not wait on anyone
else, and any admin can do it once they have synced the group's state — the pending
status is computed from shared group state, not from anything the inviting admin holds
privately.

"Pending" means only *in the tree, no profile yet* — it does not record how the person
got there, so it also covers **someone who joined through an approved join request**
but whose profile has not yet propagated. Cancelling and removing are the same
operation (§4.5): both remove whoever is still in the group's tree, so cancelling a
person who has meanwhile become confirmed removes them too. Only when the person is no
longer in the tree at all (another admin removed them first) is the cancellation a
harmless no-op.

### 4.5 Removing a member

An admin can remove **any other member** — confirmed or pending, admin or not. The
removal is immediate and does not wait on anyone else: the member is dropped from the
roster on every remaining member's device and the group's keys are refreshed in the
same step. An admin
cannot remove themselves this way; their own exit is leaving (§7).

---

## 5. Joining a group (the invitee side)

However an admin adds someone, the person receives a **Welcome** — the cryptographic
grant of membership. Receiving a Welcome does not, by itself, put them in the group.

### 5.1 A Welcome must be accepted (pull-only)

Incoming Welcomes are **not** acted on automatically. Each is held in a **pending
list** until the recipient explicitly **accepts** or **declines** it. Accepting joins
the group; declining discards the Welcome silently, publishing nothing (the inviter is
never told it was declined).

**Why consent is required.** A Welcome anyone can craft would otherwise let an attacker
force their own key into your group roster — and, because sharing a group grants DM
reachability, make themselves able to message you — without your consent. Requiring you
to accept closes that pre-admission attack surface: a Welcome grants nothing until you
act on it. (This is **ADR-002**.) To blunt flooding, the pending list is capped
(overall, and per inviter); when it is full, the **oldest** waiting Welcome is
discarded to make room for a new one — so a flood displaces older pending invitations
rather than blocking new ones. If a queued Welcome is accepted too late — after its
cryptographic state has moved on — accepting fails and the entry is discarded.

### 5.2 Accepting your own request automatically

The one exception to §5.1 is a Welcome you actually asked for. When a Welcome arrives
from an **authenticated admin you have an outstanding join request to**, and (when the
group's name can be read from the Welcome) that name **matches** the request, the app
accepts it for you — so a link join completes without a second confirmation. If the
name can't be read and you have exactly one outstanding request to that admin, it still
auto-accepts; anything else — an unauthenticated or forged Welcome, a Welcome from an
admin you didn't ask, or a name mismatch — goes to the pending list for an explicit
decision.

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
change, the shared name updates for every member as it propagates, and a rename notice
is posted into the conversation so members can see what happened and who did it (that
notice is best-effort — a rename whose notice fails to send still takes effect).

---

## 7. Leaving a group

When a member chooses to leave, the group's current membership is read fresh (the admin
list it is checked against is the last one the leaver's app knows) and one of three
outcomes applies, evaluated strictly in this order:

1. **Abandon** — you are the only member left.
2. **Blocked** — you are the only admin, but other members remain.
3. **Confirm** — the normal case.

The order matters: a sole member is also, by definition, a sole admin, so checking
"last member" first prevents the sole-admin block from wrongly trapping the last person
in their own group.

- **Abandon.** If you are the only member, leaving **permanently deletes the group**;
  because that is irreversible it requires an explicit confirmation acknowledging the
  group cannot be recovered. There is no one to notify, and every trace of the group is
  erased from your device.
- **Blocked.** If you are the only admin and other members remain, the leave is
  **refused**; you are told you must first grant admin to another member. This prevents
  a group being stranded with no one able to change its membership (§10). It does not
  fix an admin who loses their key or abandons the app — the only defence there is to
  grant admin to trusted members early, and because grants are permanent, so are those.
- **Confirm.** Any other member confirms and leaves. Leaving is **always immediate and
  unilateral** — the moment you confirm you are gone from your own device, whether or
  not any admin is online; the right to leave is never conditional on anyone's approval.
  Behind the scenes, leaving is not a forcible protocol eviction (that would freeze the
  whole group's conversation until an admin acted, §8); instead it records a departure
  signal an admin's app later uses to finalise the removal, plus a departure
  announcement in the conversation, and then erases the group from your own device.

**What leaving erases, and when.** The group disappears from your view, with its
messages and member details, the moment you confirm. Its cryptographic keys and
encrypted history are deleted from the device once sending the departure announcement
has finished — whether it was sent or failed — or after about five seconds if it has not
finished by then, because the announcement is encrypted with those keys. When there is
nothing to announce (abandon), they are deleted at once. If the app is closed or
reloaded before that deletion completes, or the deletion fails, it completes the next
time the app starts. Nothing about this deletion is sent anywhere; it happens on your
device only.

- **What this guarantees:** a group you left does not keep its keys on this device
  beyond the next start, and they are never written into your relay backup (see
  [Backup & recovery](backup-and-recovery.md)).
- **Rejoining:** accepting a new invitation to a group you left makes it an ordinary
  group again, backed up like any other. Only if the device fails to record the rejoin
  as well can the group stay out of the backup — until the next start, which
  restores it.
- **What it does not:** leaving is per device. Another device of the same identity, and
  a relay backup made before the leave, still hold the group until it is left there.

---

## 8. Removing a departed member

Because a leave is not a forcible eviction, there is a gap between a member *announcing*
they have left and the roster actually *dropping* them.

- After a member leaves, a remaining admin's app **automatically finalises the removal**
  a few seconds later — dropping them from the roster and refreshing the group's keys in
  one step. Several departures close together are handled together.
- **A reload does not drop a pending removal.** A departure the app has received but
  not yet finalised is kept on the device together with an identity of the departing
  member's group membership as it was when the departure arrived. When the group is
  opened again, the kept removal is resumed — only on a device whose user is an admin
  of the group (any other device discards it) — and finalised only if that same
  membership is still present. If the person has since re-joined with a new
  membership, the kept removal is discarded instead: a stale removal never evicts a
  member. The membership recorded is the one that **sent** the departure, as it stood
  when the departure was written — so a departure that is only processed after a reload
  (see *Receiving messages after reopening*), after the person has already re-joined,
  is discarded too. Removals not finalised within 30 days are discarded. These pending
  removals stay on the device only and are discarded when you leave the group or the
  account's local data is cleared.
- **A storage error does not lose a removal.** If the pending removal cannot be stored,
  the app still finalises it while it stays open, and the departure itself stays kept on
  the device until a later attempt has stored it — a repeated departure of the same
  membership stores it too. If the recorded membership of a kept departure cannot be
  read, the departure is not acted on then; it stays kept and is processed again later,
  never against the current membership. Two admin tabs open on the same device never
  discard each other's pending removals.
- **What it does not guarantee:** a removal is lost when keeping the departure message
  and storing the pending removal both fail, followed by a reload before it is
  finalised, or when storing the removal fails on all five attempts (see *Receiving
  messages after reopening*). A kept departure that carries no recorded membership (it
  could not be determined when the departure arrived, or it was kept before the
  membership was recorded with it) is **not acted on** when it is processed after a
  reopening: it is discarded rather than checked against the current membership, so the
  person stays on the roster until they leave again or an admin removes them. (A
  departure processed as it arrives without a recorded membership uses the membership
  present at that moment.) A person who re-joins with exactly the same membership keys as
  before (possible only when re-using the same reusable invitation key without any
  change in between) cannot be told apart from the departed membership; a stale removal
  can then remove them.
- **Only an admin can finalise a removal.** If only regular members are online, it
  waits, and an admin completes it next time one is online — as long as the departure
  signal was published and a relay still carries it.
- **The conversation never freezes** during this gap. What is delayed is hygiene, not
  liveness: the roster count stays stale until cleanup lands, and the departed member's
  key remains valid until then (in practice they have already erased their copy).

While a departure is awaiting finalisation, the departed member is in a distinct,
observable state — **departed, cleanup pending** — visible only to remaining members. It
conveys that the member has departed and cleanup is pending; it does **not** claim
message delivery to them has stopped (at the protocol level it has not), and it does not
promise a timeline — if no admin ever comes online it can persist indefinitely.

The deferred finalisation here only ever completes a member's own departure. Removing a
member who has not chosen to leave is a separate, immediate admin action (§4.5).

---

## 9. Message authenticity: who really sent a message

Every group message now carries a **cryptographically authenticated sender**. Who a
message came from is read from the group's shared cryptographic state — the sender proven
by the group's key material — not from a name the message claims for itself. A message
whose claimed author does not match its authenticated sender is **dropped**: it is not
shown under anyone's name and not stored. Honest messages — the overwhelming normal case,
where the claimed author is the real sender — are unaffected and behave exactly as before.

This is what makes the authority described elsewhere in this document real rather than
advisory. An admin-only action, a "so-and-so has left" signal (§8), or an announcement
attributed to a member is now backed by proof that that member actually sent it. Where a
system message additionally names an actor *inside its body* — a leave naming its subject,
an announcement naming who invited or admitted whom — the app checks that named actor
against the authenticated sender and ignores the message if they disagree, so one member
cannot act, or appear to act, on another member's behalf.

- **What this guarantees:** a message shown as authored by someone was sent by them, or it
  was dropped. A member cannot forge a message to appear to come from another member.
- **What this does not add:** it is not deniability (a deliberate non-goal) and it does not
  broadcast anything — authentication is derived from the group's existing encrypted state,
  not from any new public signal. A dropped forgery is surfaced as a diagnostic, so a
  member-on-member impersonation attempt is observable rather than silent.

Legacy or non-authenticating messages remain readable and correctly attributed; nothing
that a peer legitimately sent disappears.

*This guarantee is provided by the marmot-ts library, which resolves the authenticated
sender from the group's cryptographic state and drops mismatches at the library boundary.
The app is pinned to the forks that carry it — `ts-mls` at
`941design/ts-mls#9f0c7bd251429f6e56bc7a41c86d7d3e74b27b13` (branch `feat/app-message-sender`)
and `@internet-privacy/marmot-ts` at
`941design/marmot-ts#cb0025c0ae3ffd053bf4a6ec528869716148ffb2` (branch
`authenticated-sender`).*

---

## 10. The central trade-off

- **What you gain:** membership and the group's name can only be changed by a small,
  trusted set of admins, not by anyone who happens to be a member.
- **What you pay:** because only admins can finalise departures, roster cleanup and the
  associated key-healing happen more slowly — whenever an admin is next online.
- **What you never pay:** conversation is never interrupted. No configuration of offline
  admins, departing members, or pending removals can freeze the chat.

The one genuinely hard failure is narrow and is about **control, never conversation**:
if no admin is ever reachable again — the sole admin lost their key or abandoned the app
— the group can no longer change its membership, name, or admins, permanently, though
members can still talk indefinitely. The only defence is to grant admin to a few trusted
members early; there is no recovery after the fact.

---

## 11. Edge cases and how they resolve

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

**Re-inviting someone who left.** Works like a first invitation and starts with no
earlier history. If they accept before their leave has finished deleting the group's
keys from the device (§7), that leftover state is deleted on accept (nothing is sent)
and they rejoin; the earlier leave's pending deletion then leaves the rejoined group
alone.

**An accept cut short by a reload or a closed tab.** After reopening, the person ends
up either in the group with the invitation gone, or still seeing the invitation and
able to accept it again. They never end up in a group that isn't shown to them. A
leftover invitation for a group they are already in is cleared as the app starts, so
group and invitation can show together only briefly. Accepting such an invitation
just clears it. Accepting the same invitation in two tabs at once joins only once.

**The app open in several tabs.** What one tab stores — a group joined, renamed or left, a
message received or edited, a reaction, a poll or vote — shows up in the other open tabs of the same
browser without a reload. This keeps what each tab *shows* current; it does not coordinate
the tabs' own group processing — each tab still receives and sends as its own client.

**The link's admin leaves or is unreachable.** Requests made against that link go
unanswered — no other admin receives them. This is the single-admin-per-link limitation.

**Two admins granting admin at the same moment.** Last-writer-wins (§3.3); neither sees
an error, and a lost grant is re-issued once the privilege is seen not to have taken.
Granting the same member twice is a harmless no-op.

**Cancelling an invitation during the accept window.** If the invitee's profile has
already arrived they are confirmed and the cancel is a no-op; in the brief window before
it arrives, cancelling still removes them.

**A departing admin.** They are dropped from the admin list as part of the same step
that removes them; remaining admins keep their authority. No successor is auto-promoted.

**The group's membership can't be read when leaving.** The decision fails safe: the
destructive "abandon" outcome is never offered on unknown membership.

**Two co-admins leaving at nearly the same moment.** The last-admin block is judged
against each leaver's most-recently-known admin list, with no re-check at execution, so
both can pass independently and leave the group with no admins — the read-only-for-
membership state of §10. Keeping more than two admins avoids exposure to this window.
(This follows from the leave logic rather than being a separately specified rule.)

**A leaver's departure signal never reaches the group.** If the signal fails to send
(e.g. the leaver was offline), they still purge locally but persist in every remaining
roster as an ordinary member, with no pending-cleanup state and nothing for an admin to
finalise — a ghost that never resolves.

**A second device holds a restored backup of an abandoned group.** Abandoning erases the
group from the device that abandons it, but since a solo group has no other member to
notify, no signal is sent — another device of the same identity that restored a backup
keeps the group until it is cleaned up there.

**A declined invitation leaves the person pending on the admin's side.** Declining a
Welcome (or simply ignoring an invite) publishes nothing, so on the admin's roster the
person stays pending indefinitely — nothing distinguishes "declined" from "hasn't
answered yet", and only an admin cancelling clears it.

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
- `specs/epic-cancel-pending-invitations/` — cancelling a pending invitation. (Note:
  `specs/scope-withdraw-invite-to-direct-invites-spec-request.md` is a *pre-spec*
  proposing a narrower, marker-based withdraw restricted to direct invites; it is **not
  shipped** — the current behaviour is the derived-pending mechanism described in §4.4.)
- `specs/epic-walled-garden-v2/` — pull-only invitations and ever-known peers.
- `specs/epic-out-of-band-leave/` and `specs/epic-abandon-last-member-group/` — leaving,
  removal finalisation, and abandon.
- `docs/adr/ADR-002` (mutual-contact graph and pull-only invitations) and
  `docs/adr/ADR-003` (last-writer-wins for MLS metadata; the basis for admin being
  add-only).
- `docs/adr/ADR-012` (MLS sender binding in the fork) and
  `specs/epic-marmot-ts-authenticated-sender-migration/` — the authenticated message
  sender of §9: the library resolves who really sent each group message and drops any
  message whose claimed author does not match, backing the roster and leave gates.
- Implementation under `app/src/context/MarmotContext.tsx`, `app/src/lib/marmot/`
  (invite links, join requests, cancel, leave, grant, welcome subscription), and the
  group components and page under `app/src/components/groups/` and `app/pages/`.
- `app/src/lib/marmot/leaveGroupImpl.ts`, `app/src/lib/marmot/leftGroupTombstones.ts`,
  `tests/unit/marmot/leftGroupStatePurge.test.ts` and the end-to-end
  `groups-leave-purges-mls-state.spec.ts` — deleting a left group's keys after the
  departure is sent (§7). `specs/epic-invite-rescind-and-member-removal/` and
  `groups-remove-member.spec.ts` — removing a member (§4.5).
- `app/src/lib/marmot/rumorJournal.ts`, `tests/unit/marmot/epochResolver.journalOrdering.test.ts`
  and the end-to-end `groups-rumor-reload-atomic.spec.ts` — the message kept on the
  device before the advanced group keys are saved (receiving after reopening).
- `app/src/lib/marmot/applicationRumorDispatcher.ts`, `tests/unit/marmot/applicationRumorDispatcher.journal.test.ts`
  — a kept message is discarded only after its processing completed (receiving after reopening).
- `app/src/lib/marmot/pendingRemovalStorage.ts`, `tests/unit/marmot/pendingRemovalStorage.test.ts`,
  `tests/unit/marmot/autoCommitLeave.test.ts`, `tests/unit/marmot/leaveJournalReplay.test.ts` and
  `tests/unit/marmot/senderLeafIdentity.test.ts` — a pending removal kept across a reload and
  checked against the membership that sent the departure (§8).
- The group-* end-to-end specs and the unit tests for the pure implementations. A few
  behaviours are verified by manual validation rather than automated tests.
