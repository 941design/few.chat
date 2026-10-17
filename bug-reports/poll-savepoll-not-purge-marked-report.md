# Poll open and vote-seq writes ignore the purge mark: a left group's few:polls / seq rows can be re-created

Source: BACKLOG.json finding `poll-savepoll-not-purge-marked`, promoted 2026-10-17 (open question
from bug run journal-and-purge-followups, 2026-10-16).

## Description
`clearPollData(groupId)` (run by a leave) sets the in-memory purge mark `purgedGroups` and deletes
every poll row of the group in one readwrite transaction. The pending queues and
`saveVoteIfNewer` check the mark inside their own readwrite transactions and write nothing for a
purged group. Three writers do not:

- `savePoll` for an OPEN poll (`pollPersistence.ts` ~:501) — a get-then-set through `enqueue`,
  no mark check, no transaction. A poll-open handler (or a local createPoll) in flight for a left
  group recreates `few:polls:<group>` after the purge.
- `allocateVoteSeq` (~:827) — a get-then-set of `few:poll-vote-seq:<group>`; a cast in
  flight recreates the reservation row.
- The receipt clock (`few:poll-receipt-clock`) — named in the finding; it is a single global key,
  not group-scoped, so a purge never deletes it. To be confirmed as not applicable.

## Expected
After `clearPollData(g)` (until `releasePollPurgeMark(g)` on a re-join), no poll write of `g`
lands: no `few:polls:<g>`, no `few:poll-vote-seq:<g>` key is (re-)created.

## Actual
An open-poll save or a vote-seq allocation that runs after the purge writes the row back,
leaving orphan rows of a left group (not swept until clearAllPollData).

## Reproduction (starting reference)
Anchor: app/src/lib/marmot/pollPersistence.ts. Unit: clearPollData(g) → savePoll(open poll of g)
→ the key few:polls:<g> exists (should not). Same for allocateVoteSeq.

## Impact
Low: orphan storage rows of a left group; a re-join then sees a stale poll list. Data hygiene /
privacy-of-leave (left-group data should be gone).
