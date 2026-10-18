# A stale-group replace can destroy MLS state under a retired subscription's still-running ingest

Source: BACKLOG.json finding `stale-replace-retired-setup-untracked` (last Codex finding of
`stale-welcome-reinvite`, deferred at the round-5 cap; AGENT-DECIDES loop item 8).

## Actual
MarmotContext's group-subscription effect registers a per-group lifecycle `{abort, setup}` before the
async setup; a stale-Welcome replace awaits `setup`, and `pendingDrainRef` remembers retired
ingest/dispatcher work. When the effect restarts (group set / generation / client change) while a
group's setup is still blocked in `subscribeToGroupMessages` (historical ingest), the cleanup aborts
it, but the new run overwrites the lifecycle entry and nothing tracks the retired setup promise. The
retired run tracks its `whenIdle` only after `subscribeToGroupMessages` returns, i.e. after a replace
may already have snapshotted `pendingDrainRef`. A replace in that window waits only for the new run's
work; a slow MLS state save of the old ingest can land after destroy/rejoin.

## Expected
A retired setup, together with the ingest-idle and dispatcher drain it hands over when it finishes,
stays tracked for its group, so a later replace awaits it (bounded; fail closed on timeout as today).

## Test
Unit (replaceTeardown): a retired setup still running, whose idle work is only handed over when the
setup finishes, blocks teardownForReplace until that idle work settles, and times out (throws) when
it does not settle. The effect cleanup tracks every setup of its run.
