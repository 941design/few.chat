# A stale-group replace re-subscribes every group

Source: BACKLOG.json finding `subscription-generation-resubscribes-all` (code-reviewer, stale-welcome-reinvite
round 2; AGENT-DECIDES loop item 11).

## Actual
After every stale-Welcome replace attempt (success or failure), `onAfterReplace` bumps
`subscriptionGeneration`. That re-runs the group-subscription effect: its cleanup tears down the
subscription of EVERY group, and the new run re-subscribes all of them, each with a full historical
refetch (sequential, up to 8 s per group). A user in many groups loses live delivery in all of them for
that time.

Found while tracing: inside the per-group loop of `subscribeNewGroups`, `if (!isCurrentGroup()) return;`
leaves the WHOLE loop when only that group's lifecycle was aborted (a replace aborts just that group). Every
group after it stays unsubscribed for that run. Today the generation bump hides this, because it restarts
everything afterwards.

## Expected
A replace re-subscribes only what is missing (the replaced group, plus any group a cut-short loop
skipped); the other groups' live subscriptions stay intact. A group aborted alone does not stop the loop
for the others.

## Test
Unit: the selection of groups to subscribe (skip subscribed, replacing and in-progress groups; take the
current group list) as an extracted pure function; a source scan that `onAfterReplace` re-subscribes the
missing groups instead of bumping a generation, and that a per-group abort continues the loop. E2E: the
full gate (the re-invite specs cover the replace path).
