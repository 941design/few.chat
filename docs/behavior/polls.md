# Polls

*Lightweight group consensus checks: creating a poll, voting and changing a vote,
when results become visible, closing a poll, and the honest limits of vote secrecy
and attribution.*

---

## 1. What a poll is

A poll is a quick way to ask a **group** a question with a fixed set of answers. Polls
live entirely inside a group's encrypted conversation — **only members can see or take
part in a poll**, and nothing about it is ever exposed to a public relay.

Polls are intentionally lightweight and **not** admin-gated: any member can create one,
any member can vote.

---

## Delivery ordering and recovery limits

Within a group, received poll messages are processed in arrival order, including
completion of storage writes. An opening message followed by a vote and a closing
message therefore records the vote before computing the closing tally. Duplicate
copies of an attempted message are ignored within the active dispatcher's bounded
recent-message history. Different groups can process messages independently.

A vote — or a close, or the close's results summary in the conversation — that arrives
before its poll exists is **held** and applied once the poll arrives (§7). Which of a
member's votes counts does not depend on arrival order at all (§3). Handler failures are
logged and later messages continue. A poll message whose storage read or write fails is not
retried while the group stays open, but it is processed again the next time the group is
opened (see the groups specification, *Receiving messages after reopening*); repeating it
is harmless — a poll is created once, a vote is recorded only if it is newer, a close is
applied only to an open poll, and a results summary is shown once. A close and its results
summary are additionally held when they fail on a storage read or write, and applied by the
next message of that poll or, at the latest, the next time the group is opened (§7) — also
when no further message of that poll ever arrives. A vote whose storage write fails is likewise held as an early vote before the
failure is reported, so a close that arrives before the vote is processed again counts it —
it was received before the close (§3). These limits differ from storage writes overtaking each other.


## 2. Creating a poll

Any group member can create a poll by giving it a **question**, an optional description, and
between **two and ten** answer options — each option label, the question, and the description
have their own length limits. A poll is either **single-choice** (each voter picks one
option) or **multiple-choice** (each voter may pick several). Multiple polls can be open in a
group at once.

The same limits — two to ten options, at most 200 characters for the question, 500 for the
description and 100 per option — are enforced **on both sides**: the creating app will not
produce a larger poll, and a receiving app rejects a poll that exceeds any of them, so a
poll crafted by a non-conforming client is dropped (it never appears as a poll) rather than
displayed. A vote naming more answers than any poll can have is rejected the same way, as
is any poll, vote or close whose poll or answer identifiers are longer than the app itself
ever produces.

Creating a poll also posts a short announcement into the group's conversation, so members
notice it.

---

## 3. Voting

Any member can vote — by selecting one option (single-choice) or several (multiple-choice).

A vote counts only toward the poll's real options: answers that are not options of the poll
are ignored, a single-choice vote listing several options counts for the first valid one
only, and a vote with no valid answer is discarded rather than counted as a voter. This is
checked by every receiving app, so it holds even against a non-conforming sender.

A member can **change their vote freely while the poll is open**: a new vote from the same
person **replaces** their earlier one, so each voter counts once. Which vote is the newer one
is decided the same way on every member's device, **regardless of the order the votes
arrive in**: each vote carries a per-member sequence number for that poll, one higher than the
highest of that member's votes the sending device has seen. The higher number wins; between
equal numbers the later send time wins, and between equal times a fixed tie-break on the
message's identity. So a vote changed on a second device whose clock runs behind still beats
the earlier vote it replaced, and every member settles on the same choice. Two votes cast on
two devices at the same moment, neither having seen the other, both count as the "latest";
every member then picks the same one of them, though which one is arbitrary. Votes from an
older app version carry no sequence number and rank below any vote that has one — so, while a
member uses an old and a new app side by side, a later vote from the old app does not replace
one from the new app. Once a poll is **closed** (§5), no further votes are accepted — a vote
arriving after the close is dropped.

A member's own votes on a poll never reuse a sequence number. The number is allocated and
recorded on the device before the vote is sent, one step at a time across all of the
member's open tabs of the app, so two votes cast at once — in one tab or two — get different
numbers, and even a vote that was sent but could not be stored locally — or whose sending
failed in a way that leaves it unclear whether it went out — is followed by a higher number.
A failed attempt therefore skips a number; only the order of the numbers matters, so gaps are
harmless. If the number cannot be recorded, the vote is not sent. (Browsers without the
cross-tab locking facility serialise within a tab only.)

---

## 4. When results become visible

Results are revealed only when a poll **closes**. While a poll is **open**, any member viewing
the poll can see **how many people have voted** — the level of participation — but **not** the
per-option breakdown; the tally of which option is winning stays hidden until the poll is
closed. This is a deliberate choice, meant to keep early votes from anchoring later ones.

This secrecy is **presentational, not cryptographic**. Every vote is an ordinary encrypted
group message that all members receive — and each member's device already **stores** the
individual votes locally. A member willing to look at that stored data (or the raw group
messages) can see the running tally, and who voted for what, before the poll is closed. The
hiding discourages casual bandwagoning; it does not keep votes secret from a member who goes
looking.

When a poll closes, the full result — each option's count, the percentages, and the total
number of voters — becomes visible to everyone in the group.

---

## 5. Closing a poll

**Closing is the creator's action.** Closing tallies the votes as they stand, posts a results
summary into the group's conversation, and makes the poll **final** — no further votes are
accepted, and the stored result never changes afterwards: if the same close is applied twice
on a device (for example by a retry), the result recorded first stays. Closing with **zero
votes** is allowed; the result simply shows every option at zero.

Each member's app **computes the final result itself** from the votes it has stored for that
poll. The creator's close message carries a tally too, but receiving apps ignore it: trusting
it would let a creator announce any result they liked. The trade-off is consistency: a member
who missed some votes (for example, one whose device never received them) sees a result built
from the votes it did receive, which can differ from what other members see.

What counts is the order in which **this device received** the votes and the close: a vote
counts if it arrived before the close, whether or not the poll itself had arrived yet (§7).
The device keeps this arrival order reliably, also across reloads and when its clock is
set back. One narrow exception: if, after a reload, the device cannot read its stored
arrival mark even after a few quick retries, it goes on without waiting, and until a read
succeeds a message can be ordered before one received before the reload — only when the
clock was also set back.
To judge a close that arrived before the poll, the device keeps, for each member, the vote
they had when each such close arrived, besides their newest vote, and otherwise up to twenty
of their votes per poll. Only if the device cannot read its held closes while storing a
member's vote change does it drop that member's earliest vote instead; a member who changed
their vote more than twenty times after such a close, before the poll arrives, can then
count with **no** vote in that poll's result on that device. Had the poll arrived first,
their vote at the close would count.
If the device can neither store a vote when it arrives nor hold it for later (its storage
fails twice in a row, or the member already has early votes held for ten other polls, §7),
the vote is retried later; if the poll was closed in the meantime, it is not counted on this
device — closing stays final.
The alternative — comparing each vote's send time with the close's — would let members
agree on a vote that was still in flight at the close, but it trusts the senders' clocks, so
a member could back-date a vote into a closed poll, and it would require changing a closed
poll's result after the fact. Closing stays final instead; the price is that a vote still
in flight when the creator closes can count on some devices and not on others.

Only the creator's close is accepted. The creator is the member who actually sent the poll —
established from the group's authenticated sender, not from a name the poll message claims —
and a close is applied only when its authenticated sender is that creator (§6).

---

## 6. Who is attributed, and how private a vote is

- **Votes are attributed to the voter.** A vote carries the voter's identity, so within the
  group a vote is not anonymous (subject to the UI-only secrecy of §4 while the poll is
  open).
- **Attribution comes from the authenticated sender.** A poll's creator and each vote's
  voter are the member who actually sent that message, as proven by the group's
  cryptographic state (see *Groups*, §9) — never an identity the message claims for
  itself. A member therefore cannot cast a vote, open a poll, or close one in another
  member's name. Non-members cannot see or take part in a poll at all.
- **Nothing is public.** Polls, votes, and results travel only inside the group's encrypted
  channel; none of it reaches a public relay.

---

## 7. Consistency and propagation

Polls, votes, and closes all travel as encrypted group messages, and the app keeps every
member's view consistent:

- **Repeated votes** from one member collapse to a single vote — the newest by the order of
  §3, whatever order they arrive in, also when a message is processed again after an
  interruption; a vote is counted once per voter.
- **A vote that arrives before the poll it refers to is held, then counted.** Group messages
  can arrive out of order, so a vote for a poll this device has not seen yet is kept and
  applied — with exactly the checks of §3 and the voter of §6 — the moment the poll arrives.
  Held votes survive a reload. They are kept **per group**: a held vote is only ever applied
  to the poll with that identity in the group it was received in. The holding area is
  bounded so it cannot be used to fill a member's storage: each member can have early votes
  for at most 10 not-yet-seen polls per group (further ones are dropped), a group holds at
  most 200 early votes (the oldest are dropped first), and an early vote whose poll has not
  arrived within 7 days is discarded. A held vote leaves the holding area only after it has
  been recorded against its poll, and the app retries applying held votes at every later
  vote and close of that poll and, for a poll the device already has, every time the group
  is opened. So an interruption (a reload, a closed tab) while applying
  them only delays a held vote — it is counted at the latest when the poll closes, never
  lost and never counted twice. If applying held votes (or any other read or write the close
  needs) fails at the moment of closing, the close is not recorded with a result that misses
  them: the poll stays open on that device and the close is **held**, then applied — with
  the votes received before it — at the next message of that poll.
  A held vote never overrides a newer vote by the same member: when both exist, the newer one
  by the order of §3 is the member's vote. A close held from before the poll arrived is the
  one exception to "the newest counts": it counts the vote the member had **when the close
  arrived** (see the next point). To make that possible the device keeps, besides a member's
  newest vote, their earlier votes that arrived before it — always the vote they had at each
  held close, otherwise at most twenty per member and poll (see §5 for the exception).
- **A close that arrives before the poll it refers to is held, then applied.** When the poll
  arrives, the held close is applied only if it was sent by the member who sent the poll;
  any other held close is discarded. The result is computed from the stored votes (§5) —
  counting, for each member, their newest vote that this device received before the close
  (held ones included), and nothing that arrived after it, even when a member changed their
  vote after the close — so the poll appears **already closed, with its results**, the
  first time this device shows it, with the same result it would have had if the poll had
  arrived first. The close's results summary in the conversation is held the same way and
  appears, with the poll's stored result, when the poll arrives — counted as a new unread
  message at that moment. A summary for a poll already closed on this device always shows
  the result the poll was closed with. As with held votes, a held close or summary leaves the
  holding area only once applied (or discarded), and applying it is retried at every later
  vote, repeated poll delivery and close of that poll, and every time the group is opened —
  so an interruption while the poll arrives only delays it; the poll is never closed or
  announced twice. The stored poll is
  authoritative: once a device has recorded the poll as closed, it accepts no further vote
  for it even if tidying up the held entries failed — that clean-up is retried at the next
  poll message. A results summary is itself a message of its poll: on arrival it first
  applies a close of that poll still held after a failure, so the creator's summary that
  normally follows their close also completes a close that failed. A failure to *read* what
  is needed to judge a summary — held or just received — holds it for a retry at the next
  message of that poll; only a summary from
  someone other than the poll's creator is discarded. If even holding it fails, that
  summary is lost on that device (the poll's own close is unaffected). Held closes survive a reload, are kept per group, and
  are bounded: one per poll and sender, closes for at most 10 not-yet-seen polls per member
  per group, at most 50 per group (the oldest are dropped first), discarded 7 days after
  receipt.
- **Polls and votes are kept per group.** Two groups can contain polls with the same
  identity; votes received in one group are never counted toward a poll in another. This
  stops a member who shares two groups with someone from opening a look-alike poll in one
  group and having its votes counted in the other.
- **A member reconnecting after a gap** — one who already holds the poll — catches up on the
  votes cast while they were away, and on the final tally if the poll has since closed. A
  member who **joins the group only after a poll was created** does not see that poll at all:
  earlier group messages cannot be decrypted by a later joiner, and polls are not
  re-broadcast, so they see neither the poll nor its result.
- **A duplicate delivery** of the same poll, vote, or close is ignored.

---

## 8. Edge cases and how they resolve

**The creator leaves the group without closing the poll.** Because only the creator can
close it, the poll stays **open indefinitely** — there is no one else who can finalise it,
and no automatic closing.

**A vote cast after the poll closes.** Dropped; closing is final.

**A vote for a poll a member hasn't received yet.** Held and counted when the poll arrives
(§7). If the poll never arrives, the held vote is discarded after 7 days, or earlier when the
member leaves the group.

**A close for a poll a member hasn't received yet.** Held, and applied when the poll arrives
if the poll's creator sent it — the poll then shows as closed with its results on first
sight (§7). A held close from anyone else is discarded. Votes that arrived after the held
close are not counted, exactly as if the poll had arrived first.

**A close or results summary hits a storage failure on arrival.** It is held and applied at
the next message of that poll — a vote, a repeated delivery of the poll, another close, or
the close's results summary — or the next time the group is opened, whichever comes first
(§7). Until then the poll stays open on that device (or the summary stays missing); a held
entry not applied within 7 days is discarded.

**A member changes their vote, and the close arrives between the two votes before the poll
does.** The vote they had when the close arrived counts — the same result as if the poll
had arrived first (§7).

**Storing your own vote fails after it was sent.** Your next vote still gets a higher
sequence number (§3), so other members never have to break a tie between two of your votes.

**An older vote of a member is delivered after their newer one.** Ignored; the newer vote
keeps counting on every device (§3).

**A poll that exceeds the size limits arrives from another app.** Rejected on receipt — it is
never shown as a poll, and votes for it stay held until they expire (§2, §7). The short
"new poll" announcement in the conversation is a separate message and may still appear; it
is cosmetic and leads to no poll.

**A poll reusing the identity of a poll in another group.** Treated as a separate poll; its
votes never mix with the other group's (§7).

**A member joins the group after a poll was created.** They never see that poll or its result
— earlier group messages are undecryptable to a later joiner and polls are not re-sent (§7).

**You leave a group.** Your local copy of that group's polls, votes and held early votes,
closes and close announcements is deleted along with the rest of the group. Poll messages of
that group still being processed at that moment, including a retry of held ones, never bring
a deleted poll, its votes or a held early message back. This holds for the app tab you left
from; another tab still open on the same device is not covered. Re-joining the group makes
it an ordinary group again, whose early messages are held as usual. If deleting the poll
data fails, the leave still completes: the left group's poll data then stays on the device,
unused, until the account's local data is cleared.

**A crafted single-choice vote that lists several options.** Counts for the first valid
option only (§3).

**A crafted close carrying a made-up result.** The result is ignored; each member's app
computes the tally from its stored votes (§5).

**Closing a poll with no votes.** Allowed; the result shows all options at zero.

**A non-creator tries to close the poll.** Ignored — nothing changes.

**A member changes their vote several times.** Only the most recent choice counts.

**A member inspects group traffic to read the tally before close.** Possible — the secrecy
is UI-only (§4).

**A member tries to vote as another member.** Not possible: the vote is attributed to its
authenticated sender (§6).

---

## 9. Deliberately out of scope

- **Restricting who may create or vote** — polls are open to all members by design; there
  is no admin-only mode.
- **Cryptographically secret ballots** — vote secrecy while open is presentational only
  (§4).
- **Automatic closing** (a deadline or timer) — a poll closes only when its creator closes
  it.
- **Editing a poll after it is created** — the question, options, and type are fixed; to
  change them, close the poll and create a new one.
- **Re-opening or handing off a closed or orphaned poll** — closing is final, and a poll
  whose creator has left stays open with no other closer.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `specs/group-polls.md` and `specs/epic-group-polls/` (spec, acceptance criteria) —
  creation, voting, results, closing, the hidden-until-close decision, and the early-vote
  queue (AC-9, amended 2026-10-15 for the held close and the per-voter sequence number;
  bug report `bug-reports/poll-vote-ordering-and-early-close-report.md` and its design
  `bug-reports/poll-ordering-design-2026-10-15.md`; receipt-order cut-off of a held close,
  sequence reservation and close/summary retry:
  `bug-reports/poll-residual-ordering-and-close-retry-report.md`; retry when the group is
  opened, held-close-aware vote keeping and the arrival-mark retry:
  `bug-reports/poll-followups-report.md`). Votes are ordered by sequence number,
  then send time, then message identity — not by arrival and not by time alone.
- `specs/epic-group-message-author-auth-app-layer/` (AC-POLL-1..4 — creator and voter bound
  to the authenticated sender, creator-only close, recomputed tally) and *Groups* §9.
  (The vote order is the per-voter sequence of §3, not the timestamp arbitration ADR-003
  describes for group metadata.)
- Implementation under `app/src/lib/marmot/` (`pollSync` limits and parsing,
  `handlers/pollHandler` open/vote/close and the early-vote replay, `pollPersistence`
  group-scoped vote storage with its newer-wins write and the bounded early-vote and
  early-close queues, `pollCast` sequence numbering of own votes, `handlers/chatHandler` held
  results summaries, `pollTally`) and the poll UI in the group view.
- The `groups-polls` and `groups-poll-after-leave` end-to-end specs and the unit tests for
  vote replacement, sanitisation, tally recompute, close authorization, group-scoped vote
  storage, the early-vote queue, vote ordering, the early-close queue and the receive-side
  limits (`pollHandler`, `pollIntegrity`, `pollOrdering`, `pollPersistence`, `pollSync`).
  Out-of-order delivery (a vote or close before its poll, an older vote after a newer one)
  is covered by unit tests only, not end to end.
