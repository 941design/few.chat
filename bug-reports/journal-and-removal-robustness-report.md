# Robustness cluster: journal ack on success, ack retry, replayed-leave identity, single-transaction removal delete

Source: BACKLOG.json findings filed from run `robustness-journal-removals-avatars` (commit 1b9a934),
2026-10-15/16. Texts below verbatim.

## journal-ack-before-durable-side-effects
The dispatcher acks a journal entry even when the handler's durable side effects failed (e.g. a pending member removal whose IndexedDB write failed), so a reload in the commit window loses it

- motivation: Decider-waived Codex HIGH (not a regression) on run robustness-journal-removals-avatars, 2026-10-15: before the durable removal store every reload in the 5 s window lost the removal; now only a failed storage write plus a reload does.
- behavior: Dispatcher acks in a finally block (at-most-once); persistPendingRemoval swallows write failures so the leave handler resolves.
- approach: Ack-on-success: handlers report durable completion; the dispatcher only acks entries whose handlers succeeded (keep at-most-once semantics for handler logic by idempotency).
- success signal: Unit: a failing pending-removal write leaves the journal entry, and the removal is applied after reload

## journal-ack-failure-replays-applied-rows
If a journal ack fails, the already-applied rumor stays in the journal and is replayed every startup for up to 30 days (the removed count cap used to bound this)

- motivation: Decider-filed low follow-up from run robustness-journal-removals-avatars (2026-10-15). Handlers are idempotent, so the effect is repeated work, not corruption; the replay dedup-window widening is bounded per dispatcher lifetime.
- behavior: ack failures are warned and ignored; age-only eviction keeps the row for 30 days.
- approach: Retry the ack once after the next successful replay, or mark applied entries in memory for the session and delete them later.
- success signal: Unit: an ack failure is retried and the row is gone after the next startup

## journal-replayed-leave-evicts-rejoined-member
Journal replay of an unacked leave_intent after the member has re-joined can evict the re-joined member, because the handler captures the member's current leaf at replay time

- motivation: Decider-filed low (pre-existing from d74ea00), 2026-10-15: needs an unload in a millisecond window plus a long offline gap during which the member left and re-joined; rare, but destructive.
- behavior: Replayed leave_intent entries carry no epoch; the leaf-identity guard captures the current leaf at replay, so it cannot detect a re-join.
- approach: Store the MLS epoch of the message in the journal entry (if marmot-ts exposes it) and drop a leave_intent older than the member's current leaf's join epoch.
- success signal: Unit: replaying an old leave_intent after the member re-joined at a later epoch does not remove them

## pending-removal-compare-delete-single-txn
pendingRemovalStorage deleteRowsStillMatching compares via idb-keyval entries() (readonly txn) and deletes via delMany (separate readwrite txn); another tab's put to the same key can land in between and be deleted

- motivation: Decider-waived Codex HIGH (rated low, fail-safe) on run robustness-journal-removals-avatars round 3, 2026-10-16: per-tab serialised() does not cover cross-tab writes; reachable only with two concurrent admin tabs and a divergent rumor set inside a sub-ms–ms window; worst case a departed member stays until the next leave or a manual remove. Subsumed by multi-tab-mls-cache-coherence if S1 ships.
- behavior: Compare (readonly entries()) and delete (delMany) run in two IndexedDB transactions; the settle path (deleteMatchingPendingRemovals) has had the same gap since round 1.
- approach: Do compare+delete in ONE readwrite transaction via the store callback (removalStore()('readwrite', s => cursor over the group's keys, compare in-txn, s.delete only still-matching rows)) and add a unit test with two independent createStore connections where tab B's put between A's read and delete survives.
- success signal: Two-connection unit test passes: a row rewritten by another connection between compare and delete is never deleted

## Verification against current code (before the fix)

- Ack-before-durable: confirmed. `applicationRumorDispatcher.ts` acked in `finally` after the per-handler
  catch; `persistPendingRemoval` swallowed the put failure, so the leave handler resolved.
- Ack-failure replay: confirmed, but narrower than stated. A failed ack leaves the row; the next startup
  replays it through a fresh dispatcher, the idempotent handlers run again, and the ack is retried then.
  So the row replays once per startup only while the delete keeps failing (bounded by the 30-day age),
  not unconditionally for 30 days. Within the session, a re-subscribe re-listed and re-dispatched it.
- Replayed-leave eviction: confirmed. `enqueueLeave` captured `getPubkeyLeafNodes(group.state, pubkey)` at
  handler time; a replay after a re-join captured the new leaf, which then matched at fire time.
- Two-transaction delete: confirmed (`entries()` then `delMany`).

## marmot-ts evidence for the replayed-leave fix

The ingest result for an application message (installed `@internet-privacy/marmot-ts` 0.6.0 fork,
`ProcessedApplicationMessageIngestResult`) carries `message` (the MLS message; `privateMessage.epoch` is
the epoch it was encrypted in), `result.senderLeafIndex` and `result.newState` (ts-mls ClientState).
ts-mls `processPrivateMessage` decrypts a past-epoch message against `historicalReceiverData.get(epoch)`
(which retains that epoch's `ratchetTree`). Neither library records a per-leaf join epoch, so "drop a
leave older than the member's current leaf's join epoch" cannot be computed. The sound evidence that is
available is the sender's leaf keys in the tree of the message's epoch: a re-join uses a fresh key package,
so the departed membership's keys differ from the re-joined one. That identity is captured at journal
time (first receipt) and stored in the journal entry; the leave handler uses it instead of the current
leaf. Residual (unchanged, already documented): a re-join from the same reusable last-resort key package
with no intervening commit by that member reproduces identical keys.

## Constraints
No new user-visible behaviour choices beyond restoring intended behaviour (no lost removals, no lost
messages, no eviction of a re-joined member). Privacy invariant unaffected: all changes are local
storage only; no new publishes.

## Remediation round 1

Trigger: reviewer REJECTED on one sev-6 finding; Codex raised one high and two mediums. Items and fixes:

1. **Codex HIGH — journal lookup failure fell back to the current leaf.** `getJournaledSenderLeafIdentity`
   now returns `{ journaled, identity? }`; `resolveLeaveLeafIdentity` rejects when the read fails (the
   leave handler throws, the entry stays journaled, the next replay retries). The current leaf is used
   only with no journal row (a live first receipt whose journal write failed — a replay always comes from
   a row) or a legacy row without an identity (accepted ≤30-day transition).
2. **Reviewer sev-6 + Codex medium — a duplicate leave resolved without a write.** `recordPendingRemoval`
   now re-puts the queued entry (unchanged, original `receivedAt`) on a duplicate, so a failed earlier put
   is retried and the dispatcher acks only once the row landed.
3. **Codex medium — failed vote write, then close, then a replay dropped as late.** `handleVote` queues
   the vote as an early vote (receipt-stamped) before rethrowing; a close counts it via
   `loadVotesWithPending`. If queueing fails too, the rethrow keeps it journaled.
4. **Reviewer sev-4 — poison rumors.** The dispatcher counts a failed attempt once per attempt on the
   journal row (`recordRumorFailure`, read-increment-put in one transaction) and drops (acks) the rumor
   with a warning naming kind and id after `RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS` (5). A failed count write
   is warned and keeps the entry; a fan-out cut short by disposal is not counted.
5. **Reviewer sev-3 — profileRequestHandler.** Recording and answering the request are both best-effort
   (the requester retries); the handler never throws.
6. **Reviewer sev-3 — profileHandler `recordRequestAnswered`.** Chosen: catch + warn, best-effort. Its only
   effect is stopping this device's runner from re-asking for a profile it has; a failure costs at most one
   redundant request, and a replay could not complete it anyway (the merge reports no change).
7. **Reviewer sev-2 — `putRumor` dropped an existing identity.** It now read-merge-puts in one transaction
   (idb-keyval `update`), keeping an existing identity and the attempt count when the new value has none.
8. **Codex low — remembered failed acks.** Pruned on age eviction (list and sweep), on group and account
   clears, and capped at 1000 (oldest forgotten). The over-long header line was rewrapped.

The reaction / edit-delete storage-failure follow-up (incl. `reactionHandler.ts:40`) is filed by the lead.

## Remediation round 2

Trigger: Decider (Fable) RETRY with three required changes.

1. **`putRumor` could hang (confirmed).** idb-keyval 6.2.2 `update()` wires only the get's `onsuccess`; a
   get error or an abort left its promise pending and would freeze the group's ingest loop (EpochResolver
   awaits the journal put). `putRumor` now does read-merge-put through the store callback and returns
   `promisifyRequest(os.transaction)`; merge + `os.put` are wrapped in try/catch with
   `os.transaction.abort()` on a throw. The import carries the "do not reintroduce update()" comment. Merge
   semantics unchanged. Tested on an event-driven hand-rolled store (get error + abort settles and rejects;
   abort before the get; throwing put → aborted, store unchanged; throwing merge → same; a store handle
   rejecting before start, ported from the old update() test) and under a real fake-indexeddb transaction.
   The Map-mock suites now use a shared `tests/unit/helpers/callableMapStore.ts` (Map + working store
   callback) instead of an `update()` mock; relayBackup writes its journal marker row directly.
2. **Replay-aware leave identity.** The dispatcher passes `{ replayed }` (true only for `replay()`) to
   handlers; the leave handler forwards it to `enqueueLeave(groupId, pubkey, rumorId, { replayed })`, which
   is `recordLeaveIntent`: a failed journal read rejects; a journaled identity is used; with no identity a
   LIVE delivery captures the current leaf (failed capture → pubkey-only memory entry) and a REPLAYED one is
   skipped — nothing enqueued, warned with group and pubkey, resolved so it is acked. This removes the
   legacy-row current-leaf fallback. Prose fixed in pendingRemovalStorage.ts, MarmotContext.tsx,
   leaveHandler.ts, epochResolver.ts and groups.md §8.
3. **Poll closed-before-replay residual** documented in polls.md §5 and at the closed-poll branch of
   `handleVote`. No logic change.

### Waivers (Decider)
- **W1** — poll double-failure residual: a vote whose save AND fallback enqueue both fail stays journaled;
  if the poll closes before its replay it is not counted on this device (closing stays final).
- **W2** — pending-vote cap drop: the fallback enqueue is bounded by the early-vote caps; a vote dropped by
  a cap behaves as W1.
- **W3** — no write-back of the live fallback identity: a live leave whose identity was captured from the
  current leaf does not write it back into the journal row, so if its durable removal write fails and it
  replays, the replay has no identity and is skipped (the in-session in-memory removal still commits).
- **W4** — same-key re-join: a re-join from the same reusable last-resort key package with no commit in
  between reproduces identical leaf keys and cannot be told apart from the departed membership.
