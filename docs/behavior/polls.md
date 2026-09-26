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

A vote that arrives before its poll exists is ignored; there is no pending-vote
replay queue. This also applies to a duplicate of that ignored vote delivered
later while it remains in recent-message history. Handler failures are logged and
later messages continue, but already attempted messages are not automatically
retried: repeating partially completed side effects could duplicate notifications
or other actions. These limits differ from storage writes overtaking each other.


## 2. Creating a poll

Any group member can create a poll by giving it a **question**, an optional description, and
between **two and ten** answer options — each option label, the question, and the description
have their own length limits. A poll is either **single-choice** (each voter picks one
option) or **multiple-choice** (each voter may pick several). Multiple polls can be open in a
group at once.

These limits (two-to-ten options, the length caps, single-versus-multiple) are enforced by
the *creating* app; a receiving app checks only that a poll has at least two options. Under
the member-attested trust model (§6), a crafted poll message could therefore carry values
outside the intended ranges.

Creating a poll also posts a short announcement into the group's conversation, so members
notice it.

---

## 3. Voting

Any member can vote — by selecting one option (single-choice) or several (multiple-choice).

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

The close carries the authoritative final tally with it, and that tally **replaces** what
each member computed locally — so a member who was offline during the voting sees the correct
result on catching up. That makes the close the highest-impact message in a poll, which is
why the honesty caveat of §6 matters *most* here: the app does check that a close came from
the creator, but that check is against the **self-reported** identity, so a member could
forge a close as the creator and thereby inject an arbitrary "authoritative" result. As with
everything in a group, a non-member cannot do this — the exposure is member-on-member.

---

## 6. Who is attributed, and how private a vote is

- **Votes are attributed to the voter.** A vote carries the voter's identity, so within the
  group a vote is not anonymous (subject to the UI-only secrecy of §4 while the poll is
  open).
- **That attribution is member-attested, not cryptographically bound.** As with group
  messages and reactions, the voting identity is self-reported; a group member could, in
  principle, forge a vote attributed to another member. Group membership is still
  cryptographically enforced — a non-member can neither see a poll nor vote in one — but
  identity *within* the group is taken at its word (this is the trust model of **ADR-006**).
- **Nothing is public.** Polls, votes, and results travel only inside the group's encrypted
  channel; none of it reaches a public relay.

---

## 7. Consistency and propagation

Polls, votes, and closes all travel as encrypted group messages, and the app keeps every
member's view consistent:

- **Repeated votes** from one member collapse to a single vote — the last one a device
  receives (§3); a vote is counted once per voter.
- **A vote that arrives before the poll it refers to is dropped.** There is no holding queue,
  so a vote counts only if it arrives after the poll it belongs to. (The written spec intended
  such early votes to be queued; the shipped app does not do this — see Sources.)
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

**A vote for a poll a member hasn't received yet.** Dropped — it counts only if it arrives
after the poll (§7).

**A member joins the group after a poll was created.** They never see that poll or its result
— earlier group messages are undecryptable to a later joiner and polls are not re-sent (§7).

**You leave a group.** Your local copy of that group's polls and votes is deleted along with
the rest of the group.

**A crafted single-choice vote that lists several options.** The receiving side does not
enforce the single-choice rule, so such a vote can count toward several options at once (§6);
ordinary voting through the app cannot produce this.

**Closing a poll with no votes.** Allowed; the result shows all options at zero.

**A non-creator tries to close the poll.** Ignored — nothing changes.

**A member changes their vote several times.** Only the most recent choice counts.

**A member inspects group traffic to read the tally before close.** Possible — the secrecy
is UI-only (§4).

**A member forges a vote as another member.** Possible within the group's membership (§6);
non-members still cannot participate at all.

---

## 9. Deliberately out of scope

- **Restricting who may create or vote** — polls are open to all members by design; there
  is no admin-only mode.
- **Cryptographically secret ballots** — vote secrecy while open is presentational only
  (§4).
- **Cryptographically verified vote authorship** — votes are member-attested (§6).
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
  creation, voting, results, closing, and the hidden-until-close decision. Note: the spec's
  intent to *queue* a vote that arrives before its poll, and to arbitrate votes by timestamp,
  is **not** what shipped — the app drops such votes and resolves by arrival order (tracked as
  backlog findings).
- `docs/adr/ADR-006` (group-member-attested authorization — votes and closes are
  self-attested, not cryptographically bound). (The vote-replacement model is a local
  last-arrival overwrite, not the timestamp arbitration ADR-003 describes for group metadata.)
- Implementation under `app/src/lib/marmot/` (poll open/vote/close application messages,
  tallying, close authorization) and the poll UI in the group view.
- The `groups-polls` and `groups-poll-after-leave` end-to-end specs and the unit tests for
  vote replacement, tally computation, and close authorization (the vote-for-unknown-poll
  unit test asserts the vote is **dropped**).
