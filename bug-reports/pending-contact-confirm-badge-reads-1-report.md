# A held DM whose write is in flight at Confirm is never counted

Source: BACKLOG.json finding `pending-contact-confirm-badge-reads-1` (e2e, 1 of 5 isolated runs of
dm-pairing-pending-confirmation.spec.ts:110, 2026-10-18; AGENT-DECIDES loop item 14).

## Actual
The inbound-DM watcher (`subscribeDirectMessageNotifications`) checks `isPendingConfirmation(peer)`; for
a pending peer it retains the DM with an awaited IndexedDB `appendMessage` and raises no count. Confirm
(`confirmPendingContact`) confirms, then recounts the peer's unread DMs from storage
(`reconcileConfirmedContactDirectMessageCount`). When Confirm lands while a held DM's write is still in
flight, the recount reads storage before the write lands and misses it; the DM, having taken the pending
branch, never bumps the count either. The count stays one short until the conversation is opened — the
e2e saw 1 instead of 2 for 15 s after confirming right after the first of two held DMs was processed.

## Expected
Every DM held while pending is counted as unread once the contact is confirmed, however the confirm and
the DM's write interleave.

## Fix
Revised after review round 1 (Codex): a post-write recount alone still lost a message, because the
recount took `max(stored, live)` although stored (held while pending) and live (counted after Confirm)
messages are disjoint.

- The watcher registers each held DM's write (`trackHeldDirectMessageWrite`, unreadStore.ts) in the
  same tick as its `isPendingConfirmation` check.
- `reconcileConfirmedContactDirectMessageCount` (both confirm entry points use it) starts a per-call
  tracker before its first await, waits for the peer's registered writes, then reads storage (and the
  last-read mark) and sets `max(pre-call count, stored) + live bumps during the call`. Marking the
  thread read during the call drops the stored part. Per-call trackers keep overlapping recounts for one
  peer from clearing each other's live bumps.
- Review rounds 2–3: the stored count is scoped to the confirmed peer (the shared re-read loop recomputes
  other peers too); recounts are serialised per peer; the wait for held writes is capped at 5 s, and a
  held write still running then is counted when it lands, unless storage already counted its id or the
  thread was read, cleared or recounted since.
- Review rounds 4–7: every captured held write gets a late handler (deduped by message id); the recount's
  epoch is captured at its start. Each peer keeps the stored ids its recounts counted, so a later
  recount adds only new stored ids to its pre-call count instead of taking a max (a live-only pre-call
  count is never mistaken for stored messages); a read or clear resets it.

## Test
Unit: directMessageNotifications-pending-retain.test.ts — the write is registered before it lands (and,
kind-4, before the decrypt resolves), a failed write still settles, a confirmed peer registers none.
unreadStore.test.ts, against the real store — Confirm then a live DM then the held write → 2; waits for
a held write; a failed held write does not block; overlapping recounts keep a live DM; a read during the
recount; no entry when there is nothing. E2E: the full gate (the pairing pending-confirmation spec).
