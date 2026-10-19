# A DM-count scan replaces live DM bumps with the stored count

Source: BACKLOG.json finding `reconcileinit-re-read-overwrites-other-peers` (filed in review of
pending-contact-confirm-badge-reads-1, 2026-10-19; AGENT-DECIDES loop item 15).

## Actual
`reconcileInit` re-reads, from storage, every key a live increment touched during a scan, and lets
the stored count replace the live one. That is right for slices whose increments persist first (group
messages, join requests). It is wrong for direct messages: the DM watcher's `incrementDirectMessage`
never stores the message (only an open conversation does, and an open conversation is never bumped).
So:
- a DM arriving during the startup scan (`initDirectMessageCounts`) for a scanned peer is dropped from
  that peer's count;
- a confirm-time recount for one peer re-reads every other peer bumped meanwhile and drops their live
  bumps (the re-read is not limited to the call's own keys);
- the startup scan sets counts from storage without updating the confirm recount's counted-id set, so
  a later recount for that peer could count those stored messages again.

## Expected
A DM counted live is never lost to a scan, and no stored message is counted twice.

## Fix
- `reconcileInit` takes a mode. The DM slice uses an additive merge: for each scanned key, the stored
  count (or the pre-scan count, whichever is larger) plus the live bumps made during the scan; no
  re-read, and keys outside the scan are never touched. The other slices keep the re-read.
- `initDirectMessageCounts` drops the confirm recount's counted ids for the peers it scans, so the next
  recount for them starts afresh (`max`).
- The module comment claiming every increment source persists first is corrected.

- Review rounds 1–6: a late held write schedules a deduping recount instead of a live bump; a read or
  clear during a DM scan drops that peer's pre-scan and stored part (per-slice guard); the scan reads
  last-read per key, records the stored ids it counted (unchanged on a failed read), adds only stored ids
  not yet counted when a record exists, and re-bases in-flight confirm recounts; the confirm recount
  settles its count and record inside the serialized commit.

## Test
Unit (unreadStore.test.ts): a live DM during the startup scan is added to the stored count; a confirm
recount for one peer keeps another peer's stored + live count; a startup scan between two recounts does
not let the second count stored messages twice. E2E: the full gate.
