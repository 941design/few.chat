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

A vote that arrives before its poll exists is **held** and counted once the poll
arrives (§7). Handler failures are logged and later messages continue, but already
attempted messages are not automatically retried: repeating partially completed side
effects could duplicate notifications or other actions. These limits differ from
storage writes overtaking each other.


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
person **replaces** their earlier one, so each voter counts once. Replacement is by **order
of arrival** — the last vote to reach a device wins — so in the uncommon case that an older
vote is delivered after a newer one, the app does not reconcile by time; it keeps whichever
arrived last. Once a poll is **closed** (§5), no further votes are accepted — a vote arriving
after the close is dropped.

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
accepted. Closing with **zero votes** is allowed; the result simply shows every option at
zero.

Each member's app **computes the final result itself** from the votes it has stored for that
poll. The creator's close message carries a tally too, but receiving apps ignore it: trusting
it would let a creator announce any result they liked. The trade-off is consistency: a member
who missed some votes (for example, one whose device never received them) sees a result built
from the votes it did receive, which can differ from what other members see.

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

- **Repeated votes** from one member collapse to a single vote — the last one a device
  receives (§3); a vote is counted once per voter.
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
  vote and close of that poll. So an interruption (a reload, a closed tab) while applying
  them only delays a held vote — it is counted at the latest when the poll closes, never
  lost and never counted twice. If applying held votes fails at the moment of closing, the
  close is not recorded on that device (the poll stays open there) rather than recorded with
  a result that misses them.
  A held vote never overrides a newer vote by the same member: when both exist, the one the
  member cast later counts.
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

**A poll that exceeds the size limits arrives from another app.** Rejected on receipt — it is
never shown as a poll, and votes for it stay held until they expire (§2, §7). The short
"new poll" announcement in the conversation is a separate message and may still appear; it
is cosmetic and leads to no poll.

**A poll reusing the identity of a poll in another group.** Treated as a separate poll; its
votes never mix with the other group's (§7).

**A member joins the group after a poll was created.** They never see that poll or its result
— earlier group messages are undecryptable to a later joiner and polls are not re-sent (§7).

**You leave a group.** Your local copy of that group's polls, votes and held early votes is
deleted along with the rest of the group.

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
  queue (AC-9). Note: the spec's intent to arbitrate votes by timestamp is **not** what
  shipped — the app resolves by arrival order.
- `specs/epic-group-message-author-auth-app-layer/` (AC-POLL-1..4 — creator and voter bound
  to the authenticated sender, creator-only close, recomputed tally) and *Groups* §9.
  (The vote-replacement model is a local last-arrival overwrite, not the timestamp
  arbitration ADR-003 describes for group metadata.)
- Implementation under `app/src/lib/marmot/` (`pollSync` limits and parsing,
  `handlers/pollHandler` open/vote/close and the early-vote replay, `pollPersistence`
  group-scoped vote storage and the bounded early-vote queue, `pollTally`) and the poll UI in
  the group view.
- The `groups-polls` and `groups-poll-after-leave` end-to-end specs and the unit tests for
  vote replacement, sanitisation, tally recompute, close authorization, group-scoped vote
  storage, the early-vote queue and the receive-side limits (`pollHandler`, `pollIntegrity`,
  `pollPersistence`, `pollSync`). Out-of-order delivery of a vote before its poll is covered
  by unit tests only, not end to end.
