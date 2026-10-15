# Contacts & direct messages

*How the 1:1 relationship works: how a contact relationship begins (sharing a group, or
opening someone's contact link), confirming and blocking, keeping profiles in sync,
sending and receiving direct messages, and the "walled garden" that decides who may
message whom — with the reasoning and failure modes the product accepts.*

---

## 1. The model

A **contact** is a person you can exchange private, 1:1 messages with. Direct messages
are end-to-end encrypted and wrapped so that the relays carrying them cannot see the
**sender** or the **content**. Relays *can* see the **recipient** and the time a message
arrives — delivery depends on the message being addressed to the recipient — so a gift
wrap is best understood as *a sealed, addressed private message*, not anonymous traffic.

Who is allowed to reach you is deliberately narrow — a **walled garden** (§8): a stranger
cannot simply message you. This gate, and blocking (§5), are enforced by **your own app**,
not by the network — a stranger's or blocked person's events still arrive at your device
and are discarded there. They are filters on what your app accepts, not a barrier at the
relay.

One invariant does hold at the network level: **your profile is never broadcast.** Your
name and avatar are shared only over encrypted, recipient-addressed channels — never
posted publicly — throughout every flow below.

---

## 2. How a contact relationship begins

A contact relationship starts in one of two ways:

- **Sharing a group.** Anyone you are in a group with is automatically a contact, and the
  two of you can message directly.
- **Opening someone's contact link.** A person can share a link (often as a QR code) that
  carries their identity. Opening it adds them as a contact. The link may carry a **full
  signed contact card** or just a **bare identity key**; the two behave differently.

There is no "type in a stranger's key and message them" path independent of these — a
relationship always begins from a shared group or a link someone chose to share.

### 2.1 Opening a full contact card — the confirmation asymmetry

When a link carries a full card, the two sides are treated differently, and the asymmetry
is the whole point:

- **You, opening someone's card, add them immediately** as a contact. Opening the card is
  itself a deliberate act of consent, so nothing more is asked of you.
- **The card's owner**, on the other hand, learns you paired with them and admits you in a
  **pending** state (§3) — your messages do not surface to them until they **explicitly
  confirm** you.

**Why the owner must confirm.** A contact card is a **bearer credential**: anyone who
comes into possession of it — not only the intended recipient — can complete the handshake
and pair with its owner. If the owner admitted every pairing automatically, a leaked or
forwarded card would attach a stranger to them silently and permanently, with no way to
notice. Requiring the owner's explicit confirmation makes such a pairing visible and
declinable (**ADR-009**). It never requires a second scan — confirming is not scanning; a
single open still pairs both sides, once the owner confirms.

Two protections guard this exchange: the card presented back in the acknowledgement must
belong to the authenticated sender, or **neither** side is admitted (defeating attempts to
inject a third party); and the pairing is only valid for a limited window before it is
treated as expired. One precondition: the person opening the card must have set their own
**display name** first — pairing does not complete for a nameless newcomer until they have
named themselves.

### 2.2 Opening a bare identity link — a one-directional add

When a link carries only a bare identity (no full card), opening it simply adds that person
as a **confirmed** contact for you, with no reciprocal handshake and nothing for them to
confirm. This is also what a full card **degrades to** on the opener's side once its pairing
window has expired: you still add them as a contact; only the reciprocal pairing step is
skipped.

### 2.3 What adding grants, and the trust it rests on

However a relationship begins, the other person becomes an **ever-known peer** of yours
(§8.2) — which is what lets the two of you keep messaging even if you never share a group.

Adding someone by a link you opened is an act of **unilateral trust**: you are asserting
"I want to talk to this person," with no verification that their key is real, reachable, or
willing (**ADR-005**). That is accepted deliberately; the alternative — a contact whose
replies are then silently dropped — would be worse than the feature's absence.

---

## 3. Pending vs confirmed contacts

A contact is either **confirmed** (the normal state) or **pending confirmation**. Only the
owner side of a card pairing produces a pending contact; a contact you add yourself — by
opening a card or a bare-identity link — is confirmed at once.

While a contact is pending, they are **accepted but held at arm's length**: their
conversation is not opened, their messages are neither shown nor counted, they raise no
notification, and you cannot message them either — the relationship is inert until you act
on it. **Confirming** the contact makes the conversation active and the person messageable,
and settles the unread count (in practice there is nothing to catch up, because nothing was
surfaced while they waited). **Declining** an unwanted pending contact is the same action
as blocking them (§5) — there is no separate "reject". Confirming only clears the pending
state; it never un-blocks a contact who is also blocked — blocking always wins (§5, §8.3).

---

## 4. Keeping profiles in sync

Contacts keep each other's **display name and avatar** current without anyone posting them
publicly. Profile updates travel over the same encrypted, addressed channels — sent
directly to a contact when a profile changes or when a pairing completes, and otherwise
refreshed periodically. **Blocking** a contact revokes this exchange in both directions: a
blocked person is sent nothing, and their profile updates are not taken in.

---

## 5. Blocking a contact

Blocking is the one action that overrides reachability entirely.

### 5.1 What blocking does

A blocked contact is denied at the channels that carry a message, notification, or profile
signal to or from them — you cannot message them, their messages surface nothing and raise
no notification, and no profile update flows either way. **Deny always wins over allow**:
being blocked overrides sharing a group or being an ever-known peer. Blocking is a separate
veto layered on top of the reachability rules — it never changes who is an ever-known peer
or a group member; it only vetoes them (**ADR-008**). Like everything else, blocking
**publishes nothing** — the blocked person receives no signal that they have been blocked.

Blocking also **erases the existing conversation** with that person — its messages, unread
count, and reactions are deleted. The erase is sequenced so the person is already denied at
every channel *before* it runs, so a message arriving mid-block cannot resurrect the thread.

One honest exception at the edges: a blocked person who presents a still-valid pairing is
still *processed* — they are re-registered as a known-but-blocked contact (and count toward
"someone paired with me") — but the block holds: no profile is sent to them, their submitted
name is not stored, and they still cannot message you. What blocking guarantees is the
messaging and profile veto, not that every trace of an interaction attempt is suppressed.

### 5.2 Unblocking

Unblocking takes effect immediately and asks for no confirmation, since it only *removes* a
restriction. It clears the block, so the person can reach you again on the ordinary rules.
It does **not** restore the erased history — a fresh conversation starts from the next
message onward.

### 5.3 Re-adding a blocked contact

Opening the contact link of someone you have blocked does not quietly unblock them —
restoring a blocked contact is only ever the explicit unblock in §5.2.

---

## 6. Shared-group context

For any contact you can see the **groups you share** with them. An admin can also add a
contact into a group — but only into groups where the admin holds admin rights and the
contact is not already a member; a contact who is already a member, blocked, or still
pending confirmation cannot be added, in that precedence (already-a-member first, then
blocked, then pending).

---

## 7. Direct messages

A direct message is **end-to-end encrypted**: it is sealed to the recipient and wrapped so
that relays see neither the sender nor the content. Relays do see the **recipient** (the
message is addressed to them) and the **time it arrives**; the timestamp written *inside*
the wrapper is deliberately fuzzed, so the claimed send time carries no information, but the
relay's own view of arrival time is unavoidable. On receipt, the recipient's app
**authenticates** the sender cryptographically — a message cannot be forged to appear to
come from someone else.

- **Sending** is available to any reachable contact who is not blocked — but not to a
  *pending* contact, whose conversation stays inert until you confirm them (§3).
- **Receiving** is filtered: a message from someone outside the walled garden (§8) is
  dropped before it is stored or counted; a message from a pending contact surfaces nothing
  until they are confirmed; a message from a blocked peer is rejected.

For interoperability, the app also still **accepts inbound legacy plaintext DMs** (an older,
un-wrapped message format) from allowed senders. Those are not gift-wrapped, so for that
inbound path the sender, recipient, and content are not hidden from relays; outbound
messages always use the encrypted, wrapped format.

---

## 8. Who may message whom — the walled garden

### 8.1 The rule

Your app will accept a direct message from a person only when **both** hold:

1. they are **reachable** — either a current co-member of a group you are in, **or** an
   **ever-known peer** (§8.2); and
2. they are **not blocked** (§5).

If you are in no groups and have no ever-known peers, **no one** is allowed — the default is
closed, not open. You are never allowed to message yourself. All comparisons ignore letter-
casing, so key capitalisation never changes the outcome. This is a filter applied by your
own app on messages that have already reached your device — not a restriction enforced by
the relays.

**Why gate at all.** The threat is unsolicited contact from strangers. Gating reachability
on a real connection (a shared group) or an explicit act (opening someone's link) means an
arbitrary party cannot reach you just by knowing your key (**ADR-002**, which also underpins
the pull-only group invitations in the Groups document).

### 8.2 Ever-known peers

"Ever-known" is the memory that keeps a connection alive after the shared context ends. A
person becomes ever-known to you when you share a group with them, or when you add them by
opening their contact link. The set is **append-only**: no ordinary action removes anyone,
which is exactly why leaving a group does not cut off your ability to keep messaging the
people you knew there. A small number of built-in **maintainer/support identities** are also
treated as ever-known automatically, so the app's own support and feedback channel can reach
you without any explicit act on your part.

The cost of that permanence: there is **no in-app way to un-know a peer** short of blocking
them (which vetoes them without removing them) or resetting the account entirely. Adding a
contact therefore grants a durable reachability you cannot later narrow except by blocking
(ADR-002, ADR-005).

### 8.3 Block as an overriding veto

Blocking (§5) sits on top of §8.1 as a final veto: a blocked person is denied even if they
share a group with you or are ever-known. The block and the reachability rules are kept
separate on purpose — blocking never edits the ever-known set or group membership, it only
overrides them — so that unblocking cleanly restores the prior state.

---

## 9. History when a relationship changes

- **Leaving a shared group does not erase your DMs** with the people who were in it. They
  are already ever-known (recorded when membership last changed), so both the conversation
  history and the ability to keep messaging survive the group's end.
- **Membership changes trigger a cleanup of strangers.** Whenever your group membership
  changes (and once at startup), anyone who is neither a current co-member nor ever-known —
  a true stranger — has their DM thread, contact entry, unread count, and reactions purged.
  Because people you actually shared a group with are ever-known, this normally removes only
  people you never had a real connection with; it is not a mechanism for forgetting former
  group-mates.
- **Blocking erases that one person's history** (§5.1); **unblocking does not bring it back**
  (§5.2).

---

## 10. Edge cases and how they resolve

**A stranger messages you.** Their message reaches your device but is dropped before it is
stored or counted — no thread, no notification. They are not told.

**A pending contact messages you.** Accepted but surfaced nowhere — no conversation, no
notification, nothing to send back — until you confirm them.

**A blocked person tries to message or send a profile update.** Vetoed; they receive no
signal that they are blocked. A blocked person presenting a still-valid pairing is
re-registered as known-but-blocked (and counts toward your pairing tally), but the veto
holds — no profile is sent to them and they still cannot message you.

**A contact is both pending and blocked.** Treated as blocked — the veto wins over the
unconfirmed state, and confirming never lifts the block.

**A card paired by the wrong person / an injected card.** The card offered back in the
acknowledgement must belong to the authenticated sender; if it does not, **neither** side is
admitted.

**A full card opened after its pairing window expired.** On your side it simply degrades to a
one-directional add — you still add the person as a confirmed contact; only the reciprocal
step is skipped. On the *owner's* side, an acknowledgement arriving after the window has
closed admits no one.

**The same card opened twice.** Idempotent — the second acknowledgement admits no one new,
and re-pairing never un-confirms or un-blocks an existing contact.

**A nameless person opens a card.** Pairing does not complete until they have set their own
display name.

**Two contact keys that differ only in letter-casing.** Treated as the same person; casing
never creates a duplicate or a second relationship.

**A message arrives during the moment of blocking.** The person is denied at every channel
before the history erase runs, so a racing message cannot revive the wiped thread.

**Re-joining a group with someone you left before.** Their DM history is already there (never
purged), so the conversation simply continues.

**Adding someone by a link when their key is unreachable.** The contact is created and
trusted regardless — reachability rests on your assertion alone, so a dead or mistyped key
produces a contact whose messages will simply never arrive.

---

## 11. Deliberately out of scope

- **Un-knowing a peer** (removing someone from the ever-known set) — not possible without a
  full account reset; blocking is the only in-app way to cut someone off.
- **Notifying a declined or blocked person** — silence is deliberate; nothing is published.
- **Restoring history after unblocking** — the erase at block time is permanent.
- **Verifying that an added key is real, reachable, or consenting** — trust is the user's
  unilateral assertion.
- **Cross-device sync of contacts, ever-known peers, or block state** — these are per-device.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `specs/epic-add-contact-by-npub/`, `specs/epic-contact-pairing-code/` and
  `specs/contact-pairing-code-spec-request.md`, `specs/epic-contact-card-exchange/`,
  `specs/direct-contact-profile-exchange-spec-request.md` — how a relationship begins and
  profile exchange.
- `specs/epic-pending-contact-confirmation/` — the owner-side pending state and confirmation.
- `specs/epic-block-contact/` and `specs/block-contact-spec-request.md` — blocking.
- `specs/epic-contact-group-context/` — shared-group context.
- `specs/epic-dm-walled-garden/` and `specs/epic-walled-garden-v2/` — DM reachability, ever-
  known peers, and stranger purge.
- `docs/adr/ADR-002` (mutual-contact graph and pull-only invitations), `ADR-005` (ever-known
  trust extended to added contacts), `ADR-008` (block as a deny layer AND-ed at every peer
  channel), and `ADR-009` (owner confirmation before admitting a scanned pairing).
- Implementation under `app/src/lib/contacts.ts`, `processContactInput.ts`, `knownPeers.ts`,
  `walledGarden.ts`, `blockedPeers.ts`, `blockContactAction.ts`, `pairing/`,
  `directMessages.ts`, `directMessageNotifications.ts`, `marmot/chatPersistence.ts`, and the
  contact components and pages.
- The `dm-*` and contact/walled-garden end-to-end specs and the unit tests for the pure
  predicates (reachability, blocking, pending confirmation).

**Note on calls:** a blocked contact cannot ring you with a direct (one-to-one) call — the
call is dropped silently, with no busy or decline reply. A call from a blocked person who
shares a group with you is not yet block-gated (an open product question; latent while calls
are disabled) — see ADR-008. Calls are otherwise out of scope for this document.
