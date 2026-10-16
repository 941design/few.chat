# Message editing & deletion

*Changing or removing a message you already sent — in group chats and 1:1 direct
messages — how everyone's copy stays consistent, how strongly authorship is enforced,
and what a deletion does and does not reach.*

---

## 1. What you can edit or delete

You can edit and delete **only your own** messages, in both group chats and 1:1 direct
messages. There is **no time limit** — an old message can be edited or deleted just like a
recent one.

- **Editing** applies to **text** messages only. An image cannot be edited.
- **Deleting** applies to **any** message, text or image.

---

## 2. Editing a message

Editing replaces a message's content **in place** — the message keeps its position and its
identity; it does not become a new message. An edit cannot blank a message: an edit that
would leave it empty is refused, and deletion is offered instead. Once edited, the message is
**marked as edited** so readers can tell it was changed — with one exception: a reader whose
device receives the edit but never saw the original shows the edited content as an ordinary
message, without the edited mark (there was no prior version for them to have seen).

Because the message keeps its identity, anything attached to it **survives** an edit — in
particular, its **reactions stay** (they are tied to the message's identity, which never
moves). An edit you make shows **immediately**; if it fails to send, it is **rolled back** to
the previous content. Editing again edits the *original* message again, not a chain of edits
— the message's identity never moves, however many times you revise it.

---

## 3. Deleting a message

Deleting a message **removes it entirely** from the conversation — there is no "this message
was deleted" placeholder left behind; it simply disappears for everyone. Its **reactions
disappear with it**. Because deleting is destructive, it requires an explicit
**confirmation** first. The deletion shows immediately; if it fails to send, the message is
**restored**.

A deletion is **remembered** so it sticks: even if the original message is re-delivered
later, it stays gone rather than reappearing.

**What a deletion does *not* reach.** Deleting removes the message from the apps of the
people in the conversation — it is **not** a public "delete from everywhere." Two limits
follow honestly from that:

- **A deleted image's underlying file is not erased.** Deleting hides the image from the
  conversation, but the file itself remains fetchable by anyone who already has its link.
- **A copy that already escaped cannot be recalled** — for example, a message shown by a
  non-cooperating client (§7). The delete reaches cooperating participants who receive it, not
  the world.

---

## 4. Who may edit or delete — and how trustworthy that is

Edit and delete actions are offered only on your **own** messages. As with reactions, how
strongly a received edit/delete is authenticated differs by channel:

- **In a 1:1 direct message**, an edit or delete is **cryptographically authenticated** —
  the sealed envelope proves it came from the message's author, so it cannot be forged.
- **In a group**, it is **member-attested only** — the acting identity is self-reported and
  is *not* cryptographically bound to the sender. A group member could, in principle, forge
  an edit or delete of another member's message. This is the **same trust model the app
  applies to group messages and reactions**: group membership is cryptographically enforced
  (a non-member can do nothing), but identity *within* the group is taken at its word
  (**ADR-006**). If an edit/delete signal names a different author than the message it
  targets, it is rejected — but within the member set, authorship is not cryptographically
  proven.

---

## 5. Keeping everyone consistent — the revision rule

Because participants can be offline, edits and deletes can arrive in any order on different
devices. To make everyone converge on the **same** final state regardless of that order,
each edit or delete carries a **revision stamp** (a wall-clock time), and the rule is simple:

- **The highest revision wins.** A message shows the state of its latest edit or delete, no
  matter what order the signals arrived — so (edit-then-delete), (delete-then-edit), and
  a late-arriving original all settle to the same result on every device. (This is the
  last-writer-wins model of **ADR-003**.)
- **At the same revision, a delete beats an edit** — the app never leaves visible a message
  its author tried to retract.
- **Two edits at the same revision** resolve by a fixed, content-independent rule, so every
  recipient picks the same winner rather than diverging.
- **The original never overrides a later edit or delete** — a re-delivered original cannot
  un-edit or un-delete a message.
- **A skewed clock is contained.** An edit/delete stamps its revision as at least one past
  the message's last known revision, so a device with a fast clock cannot pin a message
  beyond the author's own future reach; one action from a correctly-set device restores
  order. This contains an honest device's own drift; a deliberately broken device emitting
  wildly future revisions is only *bounded*, not fully ordered — in that rare case different
  recipients can settle slightly differently (an accepted residual).

---

## 6. Out-of-order and late signals

An edit or delete can arrive **before** the message it applies to. Unlike a reaction to an
unknown message (which is dropped), an edit or delete is **held** and applied once its target
arrives — dropping it would break the feature's promise.

If the target never arrives within the app's holding limits, the effect is normally still
preserved rather than silently lost:

- a held **delete** leaves a lasting suppression marker, so if the original ever shows up
  later it stays suppressed; and
- a held **edit** is applied as the message's content when it materialises (shown without the
  edited mark, since that reader never saw a prior version).

These held signals and markers are kept up to a **bounded capacity**; under a heavy backlog
the oldest can be dropped, so this preservation is best-effort rather than unlimited. For
well-formed, sanely-timed signals the outcome converges: whatever the arrival order of
original, edit, and delete, every participant ends at the same final state.

---

## 7. Privacy and reach

- **Nothing is published publicly.** Edit and delete signals travel only over the same
  encrypted channels as the messages themselves — inside the encrypted group, or as sealed
  1:1 messages — never to a public relay. There is no public deletion request.
- **Group edit/delete is a Few-only convention.** A group member using a different client
  will simply keep showing the original — edits and deletes have no effect there. For 1:1
  messages, a cooperating other client may honour a deletion and may render an edit as *the
  original hidden plus a new message* (not an in-place change); the edited marking and
  reaction preservation are specific to this app, and a message edited several times and then
  deleted can leave superseded copies visible on such a client.
- **Forward secrecy in groups.** Someone who joins a group *after* a message was sent cannot
  read that message at all — and never sees its edit or delete. Editing and deleting are
  meaningful only among the members who were present when the message was sent.

---

## 8. Edge cases and how they resolve

**An edit or delete arrives before its message.** Held, then applied when the message
arrives (§6) — not dropped.

**A held edit/delete whose message never arrives.** Its effect is still preserved: a delete
leaves a lasting suppression marker; an edit becomes the message's content (§6).

**An edit and a delete of the same message race.** The higher revision wins; if they tie,
the delete wins (§5).

**The original message is re-delivered after an edit or delete.** Ignored — it cannot revert
the message (§5).

**The same edit or delete is delivered twice.** Applied once; the repeat is a no-op.

**A group edit or delete that cannot be stored.** If the device fails to store a group edit
or delete it received, it is not dropped: the group keeps it and applies it again the next
time the group is opened, like any other group message whose processing failed (see the
Groups document, up to five attempts). Applying it again gives the same result as applying
it once — even for an edit or delete stamped far in the future, whose capped revision is
remembered from the first time it was processed, so a later retry can never let it override
an edit that had already superseded it. A malformed one is discarded at once and never
retried, whatever the state of storage. Whether the sender may edit or delete the message
needs the stored message, so while storage cannot be read that check is retried, and the
edit or delete is never applied unchecked. Direct-message edits and deletes are not retried
this way.

**Reactions on an edited message.** Survive, because the message keeps its identity (§2).

**Editing or deleting a conversation's most recent message.** The conversation's preview
updates to the edited text, or — on deletion — falls back to the previous surviving message
(or an empty preview if none remains).

**Reactions on a deleted message.** Disappear with the message (§3).

**Deleting an image.** The message is removed from the conversation, but the underlying file
is not erased and remains fetchable by anyone holding its link (§3).

**A notification already fired for a message that is then edited or deleted.** The
notification keeps the **original** text — it is not reconciled after the fact. (A known
limitation.)

**A group member forges another member's edit or delete.** Possible within the member set
(§4); membership still bars any non-member from acting at all.

---

## 9. Deliberately out of scope

- **Editing an image** — only text messages can be edited.
- **Erasing a deleted image's underlying file** — deletion hides the message, not the file.
- **Recalling a message from non-cooperating clients or the wider world** — a delete reaches
  cooperating participants only.
- **Reconciling notifications** already delivered before an edit/delete — they keep the old
  text.
- **Cryptographically authenticated group edit/delete authorship** — member-attested today
  (§4), pending an upstream library capability (ADR-006).

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `specs/epic-feature-request-message-edit-and-delete/` (spec, acceptance criteria,
  architecture, amendments) — the full edit/delete behaviour, ordering, and degradation
  rules.
- `docs/adr/ADR-003` (last-writer-wins via a revision clock for reference-based mutations —
  the ordering model) and `docs/adr/ADR-006` (group-member-attested authorization — DM
  authenticated, group edit/delete self-attested).
- Implementation under `app/src/lib/marmot/` and the DM message-edit logic (edit/delete rumor
  building, the revision-clock comparison and monotonic clamp, tombstoning and the
  pending-signal buffer), and the chat components.
- The `groups-message-edit-delete` and `dm-message-edit-delete` end-to-end specs and the
  unit tests for the ordering, clamp, delete-wins, and clobber-guard rules — including the
  assertion that edit/delete signals are never published to a public relay.
- Storage failures (bug `reaction-storage-failures`): the group delete and edit paths
  (`app/src/lib/marmot/handlers/deleteEditHandler.ts`, the edit branch of `chatHandler.ts`)
  let a storage failure propagate so the group keeps the signal for replay; tested in
  `app/tests/unit/marmot/reactionEditStorageFailureReplay.test.ts`.
