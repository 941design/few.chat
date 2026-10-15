# Polls integrity: cross-group vote store key, dropped early votes, no receive-side caps

Source: BACKLOG.json findings `poll-vote-store-key-not-group`, `poll-vote-not-yet-received-poll`,
and the remaining part of `poll-receive-side-handlers-not-validate`, promoted 2026-10-15
(triage-verified against current code).

## Description

1. Vote store key `few:poll-votes:{pollId}` (app/src/lib/marmot/pollPersistence.ts ~:53-55) is not
   group-scoped; first-open-wins is per group (pollHandler.ts ~:47), so a member sharing groups A and B
   with a victim can open a poll in B reusing A's pollId and inject votes counted into A's recomputed
   tally at close (pollHandler.ts ~:147 loadVotes(pollId)). Needs a migration of existing rows.
2. A vote for a not-yet-received poll is dropped (pollHandler.ts ~:87 `if (!existingPoll) return`),
   contradicting specs/epic-group-polls/acceptance-criteria.md AC-9 ("queued and applied when poll-open
   arrives"). Out-of-order MLS delivery loses legitimately cast votes. The queue must be group-scoped and
   bounded, and queued votes must pass the same validation (sender binding, option sanitisation,
   single-choice cap) when applied.
3. Already fixed by the author-auth epic (8c2b2ff): creator-only close, recomputed tally, single-choice
   cap, option-id sanitisation. Remaining: parsePollOpen (pollSync.ts ~:66-84) has no upper bound on
   option count or title/option length on receipt (creation-side caps only) — apply the creation caps on
   receipt too.

Also stale spec text: AC-9 "Close payload's results and totalVoters replace any local tally" contradicts the
shipped recompute (AC-POLL-4) — correct it.

## Constraints

- No user-visible behaviour change beyond the spec (early votes count; oversized polls from other clients
  rejected the same way local creation rejects them). Privacy unaffected.
- Migration must keep existing votes for the right poll/group (existing rows carry pollId; groupId must
  be recoverable from the poll store) and be idempotent.
