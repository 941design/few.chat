# Poll vote ordering + close-before-open — design (Fable consult, 2026-10-15)

Findings: `poll-vote-ordering-single-key`, `poll-vote-handler-ignore-older-vote`, `poll-close-before-open-dropped`.

## 1. Ordering key: per-(poll, voter) Lamport sequence
- Wire: `PollVotePayload.seq?: number` — optional non-negative safe integer; parsePollVote rejects
  fractional/negative/non-number; absent = legacy (old clients ignore the field).
- Sender rule (castVote): `seq = max(stored own vote.seq, own entries in the early-vote queue .seq, 0) + 1`;
  serialise casts per pollId (promise chain) so two rapid casts can't share a seq.
- Total order `isNewerVote(a, b)`: seq, then created_at, then rumorId (lexicographic). Store seq + rumorId on
  PollVote and PendingPollVote; legacy rows/wire = seq 0, rumorId ''. A vote with seq ≥ 1 beats any legacy
  vote from the same voter (document the transitional case); legacy-vs-legacy by created_at then id.
- Rejected: MLS epoch (not surfaced; orders nothing within an epoch or between devices), version vectors.
  A huge crafted seq only locks out the sender's own future votes (sender is authenticated) — safe-integer check.

## 2. Single serialisation point: persistence compare-and-set
- Replace saveVote upsert with `saveVoteIfNewer(vote)` — CAS inside pollPersistence's per-key enqueue.
  handleVote, replayPendingVotes, castVote and journal replay become order-insensitive ("max wins").
- queuePendingVote keeps the newer entry by the comparator (not latest arrival).
- replayPendingVotes drops its special votedAt>= skip in favour of the CAS; handleVote's recover-before-save stays.
- castVote: compute seq → send → save via CAS; apply the comparator in its optimistic setVotes. castVote stays
  outside the dispatcher (MLS never echoes own messages).
- Update the pollReplay.ts doc comment (the replay-only note no longer applies).

## 3. Close-before-open queue
- Key `few:poll-pending-closes:{groupId}`; entry {pollId, closerPubkey (authenticated), closedAt, receivedAt};
  one per (group, poll) (first kept), ≤10 polls per sender per group, ≤50 per group oldest-evicted, same TTL
  as the vote queue (7 days).
- Apply in handleOpen on the new-poll path only: savePoll → replayPendingVotes → if pending close and
  closerPubkey equals the open's authenticated creator (case-insensitive) → loadVotesWithPending →
  computeTally → save closed; else discard. handleVote keeps queueing votes for unknown polls.
- Check the chatHandler poll_close announcement gate: a poll_close chat message for an unknown poll must not
  be dropped irrecoverably (same bug one layer up) — queue/re-evaluate consistently.
- AC-9 amendment: "A close referencing an unknown poll ID is queued per group and poll, bound to its
  authenticated sender, and applied when the poll-open arrives only if the open's authenticated creator equals
  that sender; otherwise discarded. The queue is persisted across reloads, bounded (one entry per poll, at most
  10 per sender per group, at most 50 per group, oldest evicted) and expires 7 days after receipt. Applying it
  replays queued votes first and recomputes the tally from stored votes (AC-POLL-4)." Plus: "Each vote carries
  a per-voter sequence number; among a voter's votes for one poll the greatest (seq, created_at, rumor id) wins
  on every member regardless of delivery order; votes without seq rank as seq 0."
- docs/behavior/polls.md: replace the "resolves by arrival order" note.

## 4. Tests (unit, app/tests/unit/marmot/)
pollSync seq validation; comparator total-order table incl. legacy; two-device skew (A votes X seq1 t=100,
B clock −60 s saw A, votes Y seq2 t=40 → Y wins for orders A,B / B,A / both queued then open / replay after a
failed ack); concurrent same-seq from two devices → same winner on every peer in both orders; castVote seq
derivation (stored 3 + own queued 5 → 6; two rapid casts → 6, 7); legacy-after-new ignored; close-then-open
closed with queued votes counted; non-creator close discarded; close-vote-open counts the vote; bounds/TTL/
persistence. No new e2e (MLS reordering cannot be forced through the app).

## 5. Visible consequences (no blocking product question)
A poll whose close was queued appears closed with results on first sight; truly concurrent same-user votes from
two devices pick a deterministic but arbitrary winner.
