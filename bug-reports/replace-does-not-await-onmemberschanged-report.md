# A stale-Welcome replace does not wait for onMembersChanged or the history-synced profile send

Source: BACKLOG.json finding `replace-does-not-await-onmemberschanged` (code-reviewer, sev6 inference, on
`stale-replace-retired-setup-untracked`; AGENT-DECIDES loop item 10).

## Actual
Two pieces of work started from inside `subscribeToGroupMessages` are tracked by neither the resolver's
`whenIdle` nor the dispatcher drain, so `teardownForReplace` does not wait for them:
1. `EpochResolver` calls `onMembersChanged` without awaiting it (`epochResolver.ts:292-295`). Its body in
   `MarmotContext` checks `isCurrentGroup()` once at the top, then awaits `persistGroup`/`reloadGroups` and
   runs `void mlsGroup.commit()` (auto-commit of unapplied proposals) with no re-check. After a replace has
   destroyed and rejoined the group, it can commit on the old `MarmotGroup` (MLS state save + publish).
2. The `onHistorySynced` profile send checks `isCurrentGroup()` before `sendRumorSafe` only; the in-flight
   send is untracked, so a replace can purge the group under it.

## Expected
A replace waits (fail-closed after REPLACE_WAIT_MS) for the members-changed body, its auto-commit and the
profile send of the replaced group, and the members-changed body never commits once the group's subscription
is no longer current.

## Test
Unit (real `trackPending`/`teardownForReplace`, via an extracted helper): a replace started while tracked
group work is suspended waits for it; a rejection still releases it; untracked work does not block (control).
