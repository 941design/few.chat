# Poll votes lack a single ordering key; a close that arrives before its poll is dropped

Source: BACKLOG.json findings `poll-vote-ordering-single-key`, `poll-vote-handler-ignore-older-vote`,
`poll-close-before-open-dropped` (promoted 2026-10-15).
Adopted design (Fable): bug-reports/poll-ordering-design-2026-10-15.md — implement exactly.

## Description
- Replay orders votes by sender created_at (newer-wins, replay-only), live handleVote by arrival,
  PollStoreContext.castVote saves locally outside the dispatcher; journal replay can reorder a vote pair after a
  partial ack failure. Outcome depends on delivery order and failures; peers can diverge on a voter's choice.
- handleClose drops a close whose poll is unknown, so under reordering a member keeps a poll open forever.

## Expected
Every member converges on the same latest vote per voter regardless of delivery order, clock skew between a
user's devices, or interrupted replays; a close that arrives before its open is applied when the open arrives
(only if sent by the authenticated creator).
