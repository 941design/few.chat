# Re-inviting an evicted member fails on their side: the new Welcome is never adopted

Source: BACKLOG.json finding `reinvite-after-eviction-fails-already-exists` (engineering half);
decided 2026-10-17 by Fable on the owner's delegation (bug-reports/product-decisions-fable-2026-10-17.md, item 8).

## Actual
An evicted member keeps overlay + MLS state (no self-eviction detection). When the admin re-invites
them, accepting the new Welcome is treated as "already joined" (since invite-accept-not-atomic fix):
the invitation is cleared silently and the new Welcome is not adopted — the user stays on stale,
dead group state and cannot chat.

## Expected (decided)
On accepting a valid Welcome for a group held locally whose local state is stale (own leaf absent
from the local ratchet tree, or the Welcome's epoch is newer than the local epoch), replace local
state: tear down the per-group subscription (MarmotContext ~:1522 only re-runs on id add/remove),
groups.destroy, re-join from the Welcome — as already specified in groups.md for re-inviting
someone who left. History starts fresh. The evicted-member view while removed is NOT in scope
(owner question).

## Test
e2e: A removes C → A re-invites C → C accepts → C and A can exchange messages
(groups-remove-member.spec.ts ~:189 currently re-invites but never accepts). Unit: stale-state
detection and the replace path.
