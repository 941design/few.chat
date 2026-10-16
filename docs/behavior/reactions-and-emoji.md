# Reactions & emoji

*Reacting to a message with an emoji — in group chats and 1:1 direct messages — how
reactions aggregate, who a reaction is trustworthy as coming from, and when
they are cleared.*

---

## 1. The emoji set

The app offers a **fixed, curated set** of common emoji. They are used in two places:

- **Composing a message** — you can insert an emoji into the text you are writing.
- **Reacting to a message** — you can attach an emoji to someone else's (or your own)
  message without sending a reply.

The set is deliberately curated and finite; there is no support for arbitrary or custom
(image) emoji.

---

## 2. Reacting to a message

You can react to any message — in a **group chat** or a **1:1 direct message** — with an
emoji. Reactions are **additive per person**: you may attach **several different** emoji to
the same message, and each is tracked separately.

A reaction you add appears **immediately**, before it has finished being sent. If sending
fails (a direct-message reaction's sealed message reaches no relay, or the group send fails), the reaction
is **rolled back** and you are told it did not go through; it is **not** retried
automatically, so a failed *added* reaction simply disappears rather than lingering in a
half-sent state.

A reaction is delivered over the **same private channel as the conversation it belongs
to** — inside the encrypted group for a group message, and sealed and single-addressed for a direct
message (§6). It carries which message it reacts to, so it attaches to the right message on
every participant's device.

---

## 3. Removing a reaction

Reacting a second time with the **same** emoji **removes** it — reactions toggle. Removing
one of your reactions affects only **your** reaction with that emoji; everyone else's
reactions, and your *other* emoji on the same message, are untouched. Removal shows
immediately; if it fails to send it is rolled back by **restoring** the reaction, so it
reappears rather than silently vanishing.

A removal is **permanent for that emoji on that message**. Conflicts are resolved by letting
a removal always win over an add for the same message-and-emoji — so an out-of-order delivery
can never resurrect a reaction you took back. That rule has a sharp consequence: once you
remove an emoji from a message, **re-adding the same emoji does not take** — it shows on your
own device but reaches no one else. Reacting with a *different* emoji is unaffected.

---

## 4. How reactions appear

Reactions are shown **per message**, grouped **by emoji**: each distinct emoji on a message
carries a **count** of how many people used it and the list of **who** reacted (in the
order they reacted). Your own reactions are distinguished from other people's. A reaction only ever attaches to the specific message
it targets.

---

## 5. Who a reaction is attributed to — and how trustworthy that is

A reaction records **who** reacted, but how strongly that attribution can be trusted differs
by channel — and the difference is worth stating honestly:

- **In a 1:1 direct message**, a reaction's author is **cryptographically authenticated**:
  the sealed envelope proves who sent it, so a DM reaction cannot be forged to look like it
  came from someone else.
- **In a group**, a reaction's author is **member-attested only** — the reacting identity is
  self-reported and is *not* cryptographically bound to the sender. A group member could, in
  principle, forge a reaction attributed to another member. This is the **same trust model
  the app already applies to group chat messages**: group membership is cryptographically
  enforced (a non-member cannot inject anything), but identity *within* the member set is
  taken at its word. The limitation comes from the underlying group-messaging library, and
  is documented in **ADR-006**.

---

## 6. Privacy

Reactions are never posted publicly. A group reaction travels inside the group's encrypted
channel; a DM reaction is sealed and single-addressed, with the sender hidden from relays.
No reaction is ever readable on a public relay — consistent with the app's rule that who is
talking to whom is not exposed.

---

## 7. When reactions are cleared

Reactions are stored locally, per conversation, and are cleared together with the
conversation they belong to:

- **Blocking a contact** deletes the **whole** reaction store for that 1:1 conversation —
  both your reactions and theirs — along with the rest of the wiped conversation.
- **The stranger cleanup after a membership change** deletes the reaction stores of people
  who are no longer reachable at all (true strangers; ex-group-mates normally stay reachable
  and are kept — see the Contacts document). This cleanup touches **only 1:1** reactions — a
  departed member's reactions *inside a group you remain in* are kept.
- **Resetting or switching the account** clears all stored reactions.

---

## 8. Edge cases and how they resolve

**A reaction arrives for a message you don't have.** Silently discarded — the app does not
fetch the unknown message, and no stray reaction is stored.

**The same reaction is delivered more than once** (e.g. a relay re-broadcasts it). Ignored
as a duplicate; it is counted only once.

**A group reaction that cannot be stored.** If the device fails to store a group reaction
it received (or to look up the message it belongs to), the reaction is not dropped: the
group keeps it and applies it again the next time the group is opened, like any other
group message whose processing failed (see the Groups document, up to five attempts).
Applying it again never counts it twice. A reaction for a message you do not have, or a
malformed one, is not retried — it is discarded as described above. A direct-message
reaction that fails to store is not retried this way.

**Storing a reaction change fails on this device.** Whether the change was your own or
arrived from someone else, the conversation then shows what is actually stored — a
reaction that did not get stored is not shown as if it had been, and one that was stored
despite the error is shown. Other open tabs show the same.

**A malformed reaction.** Ignored rather than applied.

**Removing a reaction when you have several emoji on one message.** The removal names which
emoji it undoes, so only that one is removed; the others stay. A removal that does *not* name
an emoji is applied only when you have exactly one reaction on that message; if it is
ambiguous (none, or more than one), it is discarded rather than guessed.

**Re-adding an emoji you previously removed from a message.** Does not take (§3) — the
removal wins permanently; only a different emoji works.

**A member reacts and then leaves the group.** Their existing reactions stay stored and
visible to the members who remain — leaving does not retract them.

**A reaction to a message after you have left the group.** You can neither send nor receive
further reactions there — leaving cuts off the channel, so no later reaction reaches you.

**Your own reactions after a reload.** Persist — they are stored locally, so reopening a
conversation shows them again.

**A conversation open in several tabs.** A reaction added or removed in one tab — your own
or one that arrives from someone else, in a group or a direct conversation — shows in the
same conversation open in another tab of the same browser without a reload. Showing the
other tab's update never brings back a reaction you are removing at that moment. If both
tabs store a reaction change on the same conversation at the same moment, both changes are
kept where the browser supports Web Locks. Without Web Locks, one tab's change can overwrite
the other's, so a removed reaction can come back. Tabs exchange only a local "this changed"
signal on the device; nothing is published.

---

## 9. Deliberately out of scope

- **Custom or arbitrary emoji** (image emoji / the wider emoji universe) — the set is a
  fixed curated list.
- **Cryptographically authenticated group-reaction authorship** — not possible today; group
  reactions are member-attested (§5), pending an upstream library capability (ADR-006).
- **Reacting across the walled garden** — you can only react within conversations you are
  part of; a reaction from someone you cannot receive messages from is dropped.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `specs/emoji-feature-portable-spec.md` and `specs/epic-emoji-feature/` — the emoji set,
  the picker, adding/removing reactions, multi-emoji policy, and optimistic-send-with-
  rollback.
- `docs/adr/ADR-006` (group-member-attested authorization for MLS application messages) —
  the reaction trust model: DMs sealed-authenticated, group reactions self-attested.
- Implementation under `app/src/lib/reactions/` (rumor building, aggregation, storage,
  purge) and the reaction UI in the group and contact chat components.
- The `groups-reactions` and `groups-dm-reactions` end-to-end specs and the unit tests for
  reaction aggregation, toggling, and purge — including the assertion that no plaintext
  reaction is published to a public relay.
- Cross-tab refresh: `app/src/lib/reactions/api.ts` (`refreshReactionsFromStorage`) and the
  two-tab unit test `app/tests/unit/reactions/crossTab-reactions.test.ts`
  (bug `cross-tab-reactions-refresh`).
- Storage failures (bug `reaction-storage-failures`): the reaction handler
  (`app/src/lib/marmot/handlers/reactionHandler.ts`) lets a storage failure propagate so the
  group keeps the reaction for replay; a rejected write re-reads storage into the writing
  tab (`reconcileAfterRejectedWrite` in `api.ts`). Tests:
  `app/tests/unit/marmot/reactionEditStorageFailureReplay.test.ts` and the
  "writing tab reconciles" block of `crossTab-reactions.test.ts`.
