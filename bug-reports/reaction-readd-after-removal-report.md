# A reaction emoji you removed can never be added again: the re-add shows only locally and reaches no peer

Source: BACKLOG.json finding `you-cannot-re-add-reaction-emoji`; product decision made 2026-10-17 by
Fable on the owner's delegation (bug-reports/product-decisions-fable-2026-10-17.md, item 3).

## Actual
The reaction store enforces "removal wins regardless of arrival order" (app/src/lib/reactions/api.ts
~:401-417): once a (messageId, reactor, emoji) triple is tombstoned, every later add for the same
triple is discarded. Removing 👍 and later tapping 👍 again shows it on the sender's device only
(optimistic row, eventId empty forever); every peer and the sender's own echo discard it.

## Expected (decided)
Add wins when it is strictly newer than the removal. The tombstone stores `removedAt`
(rumor created_at × 1000 for inbound removals, the local send time for optimistic removals). An
inbound add on a tombstoned triple revives it iff `add.created_at*1000 > removedAt`; an add that is
older than or equal to its removal stays removed (out-of-order relay delivery stays protected —
both events come from the same reactor's device, so their clocks are consistent). Same-second
limit documented. Applies to group and DM reactions alike if they share the store.

## Tests
remove → later add revives (locally and on a peer); a stale add delivered after its removal stays
removed; equal timestamps stay removed; the sender's echo confirms the optimistic re-add; legacy
tombstones without removedAt keep today's behaviour (removal wins).
Docs: docs/behavior/reactions-and-emoji.md §3 + edge case.
