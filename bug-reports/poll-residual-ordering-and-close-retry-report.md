# Residual poll ordering edges; a live close / results summary lost on a storage failure

Source: BACKLOG.json findings `poll-cast-seq-and-close-vote-ordering` and
`poll-close-announcement-live-gate-retry` (filed 2026-10-15 from the non-blocking review notes of
bug run `poll-vote-ordering-and-early-close`; design context
`bug-reports/poll-ordering-design-2026-10-15.md`).

## Description

1. **Own vote seq reuse** (`app/src/lib/marmot/pollCast.ts`). `nextVoteSeq` derived the next seq only
   from stored and queued own votes. A cast whose send succeeded but whose local save failed (or whose
   send failed after the rumor went out) left no trace, so the next cast sent the same seq; peers then
   tie-break the two votes by created_at / rumor id, possibly differently from what the sender shows.
2. **Closed tally depends on where the open lands** (`handlers/pollHandler.ts settleHeldCloses`).
   close → vote → open counted the late vote (the held close was applied after the early-vote replay
   stored it); open → close → vote dropped it (a closed poll ignores later votes). Members with
   different delivery orders disagreed on the closed tally.
3. **Live poll_close announcement lost on a gate read failure** (`handlers/chatHandler.ts`).
   `gateAnnouncement` threw on a failing getPoll / loadVotesWithPending; the dispatcher acks a live
   rumor in `finally` regardless of handler outcome (`applicationRumorDispatcher.ts`), so the
   announcement was never retried. The unknown-poll branch swallowed a failed enqueue, which made the
   held-announcement replay treat such an entry as completed and delete it.
4. **Adjacent (same class, fixed in the same run):** a live kind-12 close whose tally read / replay /
   closed save failed was lost the same way (poll open forever on that member), and a failed
   `removePendingVotes` clean-up inside the replay failed the whole open / close / gate.

## Expected

- A sender never reuses a vote seq on a poll, whatever failed after the send.
- A closed poll's tally is the same for every position of the open in the arrival sequence.
- A live close / results summary that hits a storage failure is retried by the next message of that
  poll; a failed hold is never silently treated as "done".

## Ordering key chosen for 2 (decision record)

Current code has three candidate keys: `votedAt` (= the sender's rumor `created_at`, ms), `seq`
(per-voter Lamport counter — not comparable across senders, so unusable against a close) and the
member's local receipt order (`receivedAt` on queued votes / closes). The existing live close logic
orders votes against a close by **local arrival**: a closed poll drops every vote that arrives after
the close. This run uses the same key for a held close: a vote counts iff this member received it no
later than the creator's held close (`PollVote.receivedAt`, stamped at the vote write, queued votes
keep their queue receipt time; `receiptNow()` is strictly increasing per page so same-millisecond
ties cannot occur).

`votedAt <= closedAt` (the finding's suggested approach) was rejected: (a) it does not make
open → close → vote agree with close → vote → open for a vote created before but delivered after the
close, unless a closed poll's tally is amended afterwards (breaks "closing is final", and the chat
summary is frozen at append time); (b) it trusts sender clocks, so a member could back-date a vote
into a closed tally. Consequence (documented in docs/behavior/polls.md §5): a vote still in flight at
the close can count on some members and not others — unchanged from the open-first path.

## Remediation round 1 (Decider: lead; reviewer ACCEPTED, Codex 2 high + 2 medium)

1. **F1: live close lost when its held-state recovery is unconfirmed.** `handleClose` returned silently on
   `recoverHeldCloses → 'unknown'` (loadPendingCloses and the stored-poll re-read both failing). It now holds
   the close via `holdAfterFailure` (throws; the next poll message applies it).
2. **Codex high 1 / F5 / F4: vote changes across a held close.** Each voter's votes per poll are now
   reduced to the set that can still decide a tally "as of" some receipt time (`keptVotes`: a vote is
   dropped only when another one is at least as new by the order AND arrived no later; identical votes
   collapse; at most `MAX_VOTES_KEPT_PER_VOTER` = 5, earliest-received dropped first). This applies to
   both the early-vote queue (several entries per voter and poll, each with its receipt time; the 10
   distinct-polls-per-voter bound now counts polls) and the stored row (`PollVote.superseded`; the row
   itself stays the newest vote, so every other reader is unchanged). A held creator close tallies
   `voteAsOf(row, closeReceipt)` per voter — the newest vote received no later than the close. F4 (a
   post-close vote stored while the held close could not be settled) is covered by the same mechanism
   rather than by skipping the save: skipping would need a held-close read on every live vote and would
   lose the vote if that held close later turns out to be a non-creator's. A property-style test runs
   all 120 arrival orders of {open, close, A seq1, A seq2, B} against the open-first model; all converge.
   The documented residual and the §7 contradiction are removed from polls.md.
3. **Codex high 2 / F3: seq reuse across tabs.** `reserveVoteSeq` replaced by
   `allocateVoteSeq(group, poll, voter, floor)`: one read–max–increment–write step returning
   `max(last + 1, floor)` — it never writes an existing or lower seq — inside the per-key queue and,
   where available, `navigator.locks.request('few:poll-vote-seq:' + groupId)`. Tests: concurrent callers
   in one tab; two module instances over one IDB with Web Locks (distinct) and without (collide — shows
   the lock is what serialises); no navigator at all.
4. **Codex medium 3 / F6: receipt clock across reloads.** `receiptNow()` is async and seeded from a
   persisted high-water mark (`few:poll-receipt-clock`), leased 60 s ahead so it costs one write per
   lease; the write keeps the max of the stored mark. Non-finite stored marks are ignored. A failed seed
   or lease write is logged and retried; the clock stays monotonic in the page. Tests: reload with the
   wall clock set back 1 h stays above every earlier receipt; one lease write per window; max kept;
   failure/retry; malformed marks.
5. **F2 partial: summary applies a held close.** The chat gate's poll_close branch calls
   `settleHeldCloses` (pollHandler `createHeldCloseSettler`, wired late-bound in registerHandlers) for
   its poll before judging the summary — on the dispatcher FIFO, without replaying held summaries (no
   recursion). So the creator's summary that follows a close which hit a storage failure completes that
   close. 'unknown' holds the summary. No startup sweep (lead files that as a follow-up).

## Remediation round 2 (Decider Fable: ACCEPT round 1 with conditions)

Fixed:
1. **Kept-votes cap** raised 5 → 20 (`MAX_VOTES_KEPT_PER_VOTER`), with the residual stated honestly in
   its doc comment and in docs/behavior/polls.md §5 (and AC-9): beyond the cap the earliest-received vote
   is dropped, so a held close received before all kept votes does not count that voter. Tests for
   A seq1 → held creator close → A seq2..seq20 → close applied (A counted with seq1) on both the queue
   path and the stored-row path (live close held after a storage failure + `saveVoteIfNewer`), plus the
   cap + 1 case asserting A is NOT counted (to flip in the follow-up).
2. **Gate settle no longer falls back to the stored open poll.** `createHeldCloseSettler` calls
   `settleHeldCloses(poll, ctx, deps, false)` directly; any throw → logged → `'unknown'`, so the chat gate
   holds the summary (`holdAfterFailure`). Rationale in the code: the gate is the only consumer and
   appends an immutable tally; a failed settle means the poll may be about to close with a different
   (as-of) tally. The re-read fallback stays in `recoverHeldCloses` for open/close/vote. Test: savePoll
   fails with a creator close held and a post-close vote stored → summary held, error rethrown, no row;
   the next poll message closes with the voteAsOf tally and the replayed summary equals the card.
3. **Full reset wipes the receipt clock mark** (`clearAllPollData` deletes `few:poll-receipt-clock`, resets
   the lease and seed; `lastReceipt` kept for in-page monotonicity). Tested.

Waived (Decider):
- Cross-tab receipt clock and the no-Web-Locks seq fallback (in-tab only) → multi-tab epic.
- Seed-read failure after a backward clock step (the clock then only stays monotonic within the page):
  refusing receipts on an indeterminate read is forbidden by the run's rules.
- Held-close-aware pruning of kept votes (removes the cap residual) → follow-up.
