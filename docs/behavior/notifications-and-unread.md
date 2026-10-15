# Notifications & unread

*What the app draws your attention to — new messages, join requests, expiring invite
links — and, just as importantly, what it deliberately stays quiet about. Plus how unread
counts are kept honest across reloads.*

---

## 1. What this covers

The app keeps an **in-app notification indicator** and **unread counts** so you can see, at
a glance, where there is something new. All of it is **derived locally** from activity your
device has already received over the encrypted channels — nothing about your notifications
or read state is ever published to anyone.

Notifications reuse the **same gates as messaging** (the walled garden, blocking, pending
contacts): the indicator can never surface something the app would not have let you receive
or see in the first place. That consistency is the point of the two rules below.

---

## 2. The two rules

Everything about the indicator follows from two invariants:

- **Activity you are not looking at raises a notification.** A new message, request, or
  expiry for something you do not currently have open increments the relevant unread count.
- **Activity in what you *are* looking at does not.** A change to the conversation you
  currently have open does **not** raise a notification — the open view simply updates in
  place, and being in it marks it read.

In short: the indicator is for things happening *away from your attention*, never a nag
about the thing already in front of you.

---

## 3. What raises a notification

There are four kinds of new activity the indicator reflects:

- **A new group message** — raises the unread count for that group, unless you currently have
  that group open. Your own messages never count.
- **A new direct message** — raises the unread count for that conversation, unless you have it
  open. This is subject to the full set of gates in §4 (a stranger's, a blocked person's, or
  a still-pending contact's message does not raise anything). Only actual chat messages count
  — a reaction or other background signal does not.
- **A group join request** — raises a count for the admin who received it, unless they have
  that group open. A duplicate of a request already pending does not count again.
- **One of your invite links expiring** — raises a count for the group the link belonged to,
  once per link, noticed by a periodic check.

The indicator combines all four into a single overall signal, and reads as "nothing new"
when all are clear.

---

## 4. What never raises a notification

The following are deliberately silent — several of them the same rules that govern messaging
itself:

- **Your own messages** — you are never notified about what you sent.
- **The conversation you have open** — an open group or DM updates in place and is marked
  read, never notified (rule two, §2).
- **A message from a stranger** — someone outside the walled garden (neither a current
  group co-member nor an ever-known peer) is dropped before it is stored or counted; they
  cannot get your attention at all. (See the Contacts document for the reachability model.)
- **A message from a blocked person** — vetoed at the same gate; blocking silences them
  everywhere, including the indicator.
- **A message from a still-pending contact** — a contact you have not yet confirmed is held
  quietly: their messages are received but raise nothing while they are pending. Nothing is
  lost — the messages that arrived while they waited appear when you next open the
  conversation — but they arrive **already read**, so the indicator never reflects them.
- **A join request that gets dropped** — a request through a muted or expired invite link,
  from someone already a member, or one that fails its authenticity check is silently
  discarded and never raises anything (see the Groups document).
- **Background signals and non-message activity** — profile updates, pairing
  acknowledgements, and — *inside a group* — reactions, message edits and deletes, new polls,
  and members joining or leaving do **not** raise the indicator. Only an actual new chat
  message in an unopened group raises its count. (So a new poll posted to a group you do not
  have open will not, by itself, get your attention — worth knowing.)

These gates are evaluated on **every** incoming message against the *current* state, so a
person you block mid-conversation stops raising notifications from their very next message.

---

## 5. Unread counts, kept honest

Unread counts are designed so they neither miss activity nor invent it:

- **Marking a conversation read** records how far you have read (a per-conversation "last
  read" point), so older messages are never re-counted and re-opening a conversation you have
  caught up on shows nothing new.
- **Counts are reconstructed on startup** from your stored history, so a reload does not lose
  or double-count unread activity — and this reconstruction never clobbers a live message
  that arrives while it is running, nor lets a count regress below what is genuinely unread.
  (One narrow exception: a direct message that raised a count for a conversation you never
  opened leaves no stored copy, so after a reload that particular unread is recovered only if
  the network re-delivers the message, not from local history.)
- **Some counts also go down as you act on the items** — approving or declining a group join
  request lowers that group's pending-request count, one at a time.
- **Some counts are cleared entirely** (rather than marked read) when the underlying
  relationship ends: blocking a contact removes their unread count along with the wiped
  conversation, and a departed stranger being cleaned up removes theirs.
- **A blocked contact never counts.** The startup reconstruction skips blocked contacts and
  drops any count one still holds — this covers contacts that were hidden before blocking
  existed and kept their history. Only the count goes; their stored conversation is untouched.

The net effect: the indicator reflects genuinely-unseen activity, and stays stable across
closing and reopening the app.

---

## 6. Edge cases and how they resolve

**You block someone mid-conversation.** Their **next** message — and every one after —
raises nothing; the gate is re-checked per message against the live block state.

**A contact is both pending and blocked.** Blocked wins — silent either way.

**A pending contact you then confirm.** Confirming does not itself resurface a count for what
arrived while they were pending; instead, the held messages become visible — and are marked
read — the next time you open the conversation. Nothing is lost; it simply appears as
already-read history rather than as a fresh notification.

**A message arrives for a conversation you have open.** No notification; the view updates and
the conversation stays marked read (rule two).

**A stranger becomes unreachable and is cleaned up.** Their unread count is removed along with
their conversation. (A *blocked* peer's count is instead removed at the moment you block them
— a different trigger, §5.)

**An invite link expires.** Noticed within a short interval by a periodic check and counted
once; it is not re-counted on later checks, and the count survives a reload because it is
derived from stored state.

**A link expires while you have its group open.** It is consumed silently at that moment —
and because each link is only ever counted once, it will not resurface as a notification
later either.

**An expiry for a group not in your groups list.** Leaving a group clears its expiry count.
Expired links of a group you are not in — for example restored from a backup — do not count:
once your groups list has loaded, expiry counts are kept only for groups in it, so the
indicator never shows an expiry with no group to clear it from. Nothing is pruned while the
list is still loading, and the links themselves are left as stored.

**A reload while counts are being rebuilt.** The rebuild re-reads to catch any message that
arrived mid-rebuild, and never lowers a count below what is actually unread.

---

## 7. Deliberately out of scope

- **Publishing anything about your notifications or read state** — all of it is local; nothing
  is sent to anyone.
- **Notifying for activity you could not receive anyway** — strangers and blocked peers are
  silenced by the same gates that stop their messages.
- **Per-message or per-conversation muting** — beyond blocking a contact and the
  open-conversation suppression, there is no selective mute.
- **System/OS-level push notifications** — this document describes the in-app indicator and
  unread counts; delivery of alerts outside the app is not part of this behaviour.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `specs/epic-notification-domain-invariants/` — the two core invariants (off-domain raises,
  on-domain updates in place) and the "must never notify" rules.
- `specs/epic-dm-walled-garden/`, `specs/epic-block-contact/`, and
  `specs/epic-pending-contact-confirmation/` — the reachability, block, and pending gates the
  notification path reuses; `specs/epic-group-invite-links/` and
  `specs/epic-invite-link-lifecycle/` — join-request and expiry notifications.
- `docs/adr/ADR-002` / `ADR-005` (reachability) and `ADR-008` (block as a deny layer AND-ed at
  every peer channel, the notification path included).
- Implementation under `app/src/lib/unreadStore.ts` (the four counter slices, last-read
  timestamps, startup reconstruction, purge), `app/src/lib/directMessageNotifications.ts` and
  `DirectMessageNotificationsWatcher.tsx` (DM gating), the group-message and join-request
  counters in the group context, and `inviteExpirySweep.ts` (expiry).
- The `groups-notification-domain-invariants` end-to-end spec and the unit tests for the
  counter increment/clear, last-read, active-view suppression, and pending/blocked/stranger
  gates.
