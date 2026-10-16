# Reaction and edit/delete storage failures: replay instead of ack; reconcile the writing tab's cache

Source: two BACKLOG.json findings filed 2026-10-16:
- `reaction-edit-handlers-ack-on-storage-failure` (follow-up from bug run journal-and-removal-robustness, commit 730b976)
- `reactions-rejected-write-cache-reconcile` (follow-up from bug run cross-tab-reactions-refresh)

## Verification against current code (before the fix)

1. **The handlers swallowed storage failures: confirmed, and broader than filed.**
   - `reactionHandler.ts:40` turned a failed `loadMessages` into `{ messages: [] }`, so the reaction was
     treated as "target unknown" and dropped. `applyInboundRumor` failures were `.catch`ed, logged and
     returned `null`.
   - `deleteEditHandler.ts:80` `.catch`ed `applyDeleteEditSignal` failures.
   - Not in the finding text: group **edits** do not go through the kind-5 handler. They are
     edit-marked kind-9 rumors, handled by `chatHandler.ts:253`, which swallowed the failure the same way.
     Fixed there too, since otherwise edits would still be lost.
   Since 730b976 the dispatcher acks only when every handler completes, so all of these rumors were
   acked and the reaction, delete or edit was lost for good.
2. **Rejected reaction write leaves stale rows in the writing tab: confirmed.** `enqueue` runs
   `cache.set(nextRows)` before `set()` (on purpose, the c64fe0f badge-revival guard). On rejection,
   only the cross-tab notice was posted. This tab's cache kept the rows that never landed, and its
   listeners were not notified.

## Replay safety (checked before letting failures propagate)

- **`applyInboundRumor`**: it reads current rows from storage (not the cache) inside the queue slot and
  dedups by `eventId === rumor.id`. Add, confirm and tombstone all stamp `eventId = rumor.id`, so
  replaying a write that committed before reporting an error is a no-op. A removal is never undone by a
  re-add, because the "removal wins" branch also gives `null`.
- **`applyDeleteEditSignal`**:
  - Buffering (`insertOrCollapsePending`) dedups by rumor id, so a multi-target delete that fails part
    way re-inserts only the targets that are missing.
  - A known-row delete re-tombstones; a known-row edit no-ops on the slot-meta `lastRumorId` or
    re-writes the same content. **Corrected in remediation round 1:** "at the same rev" held only
    for a signal whose rev was not lowered by the ingest cap (`MAX_REV_SKEW_SECONDS`). A far-future
    signal's capped rev depended on the processing time, so a replay got a higher rev. It is now
    pinned per rumor, see below.
  - The sweep is documented as persist-then-remove and crash-redo idempotent.
  - One accepted residual remains (documented in api.ts): the edit's content lands but its slot-meta write
    fails, and an older equal-rev edit had a higher rumor id. The replay then no-ops and slot-meta stays
    stale. The stored row is still correct.
  - Nothing non-idempotent was found that needed a fix. The exhaustive test below confirms this for
    every storage step.
- **Invalid input** (narrowed in remediation round 1). A malformed signal (classification
  `discard`) never throws: since round 1 it is classified before any storage access. An
  unauthorized signal gives `discarded`, but deciding that needs the target row, so a failed read
  there rejects and the signal is retried. An unknown target gives `pending`. The admin lookup
  fails closed to `[]`.

## Fix

1. **Handlers propagate storage failures** (`reactionHandler.ts`, `deleteEditHandler.ts`, the edit
   branch of `chatHandler.ts`).
   - `loadMessages`, `applyInboundRumor` and `applyDeleteEditSignal` are awaited without a catch. A
     failure rejects `handle()`, the journal keeps the entry, and the next subscription replays it (up to
     5 counted attempts).
   - These cases are still acked, as before: no e-tag, a target not known locally (AC-39), and a `null`
     result from the store.
   - The delete/edit paths now bump `setChatVersion` in a `finally`, so it also fires when the call
     failed part way: the sweep may have written other slots before the failure. A spurious bump is a
     cheap re-read.
2. **Cache reconcile after a rejected reaction write** (`reactions/api.ts`, `reconcileAfterRejectedWrite`).
   - In `enqueue`'s step, a rejected `set()` re-reads the key inside the same queue slot and Web Lock.
     What is stored goes into the cache, this tab's listeners are notified, the cross-tab notice is
     still posted, and the write's own error is rethrown.
   - Indeterminate (committed, then rejected): the re-read returns the committed rows, so the cache
     converges.
   - If the re-read also fails, the cache entry is dropped so the next `loadReactions` reads storage.
     A warning is logged, and the write's error, not the re-read's, propagates.
   - `cache.set` still runs before the write, so the badge-revival guard is unchanged.

## Tests (stored state is the truth compared everywhere)

- `tests/unit/marmot/reactionEditStorageFailureReplay.test.ts` (new) runs real modules end to end: the
  dispatcher, the three handlers, reactions/messageEdits/chatPersistence. Only idb-keyval (a Map with
  step-indexed failure injection) and the deserialize boundary are mocked.
  - Seven scenarios: reaction, reaction removal, delete of a known message, delete of an unknown message,
    edit of a known message, edit of an unknown message, and a delete whose sweep materializes an expired
    buffered delete.
  - A clean run records every get/set. Then each step is failed once: as a rejection, and as
    commit-then-reject for writes.
  - For every step the test asserts the rumor stays journaled and unacked, and that after the next
    session replays it, the stored snapshot equals the clean run's and the entry is acked.
  - Invalid-input cases are acked on the first attempt with nothing stored: no e-tag, unknown target,
    another author's delete, edit-marked kind-5 companion.
  - The test fails against the old handlers (8 of 12).
- `tests/unit/reactions/crossTab-reactions.test.ts` gets a new block, "writing tab reconciles its cache
  after a rejected write". It fails against the old api.ts (10 of 13).
  - All four writers (applyOptimistic, applyOptimisticRemoval, rollbackOptimistic, applyInboundRumor) are
    tested with a rejection that lands nothing and with commit-then-reject. In each case the cache equals
    storage, the listener fires once, and the error propagates.
  - A never-stored key.
  - A failing re-read: the cache is dropped and the next load is a cold read.
  - A write queued behind a failed write starts from stored state.
  - The badge-revival guard still holds.
  - With Web Locks, the re-read happens before the lock is released, ahead of another tab's write.
- `reactionHandler.test.ts` gets 6 new tests: loadMessages and apply failures reject; null, unknown
  target and tagless rumors complete; the version bump is an increment.
- `chatHandler.test.ts` and `groupMessageEdits.test.ts`: the two tests that pinned "failure is swallowed"
  now pin "rejects + bumps".
- Kept green: the c64fe0f badge-revival tests and every cross-tab reaction test (48 → 61 in that file).

## Results

- Unit: 5841 passed, 1 skipped (256 files). Baseline before this run: 5810 passed. 31 tests added;
  2 tests changed their expectation.
- tsc: clean.
- Stryker 9.6.1, concurrency 1, scratch config in the session scratchpad, on the changed lines:
  chatHandler.ts 252-266, deleteEditHandler.ts 77-101, reactionHandler.ts 31-62, api.ts 145-216.
  - Round 1: 83.05%, with 7 survived and 3 no coverage. These were version-bump updaters that were never
    invoked, two pre-existing lines inside the range (the tags optional chain and the known-target
    predicate), the `kind: 'group'` literal, and the `?? []` re-read default.
  - Tests were added for all of them. Round 2: **100%, 59/59 killed**.
- e2e: not run (fixer brief).

## Docs

- `docs/behavior/groups.md`:
  - Reactions and edits/deletions now appear in the "processed again" list and the idempotency sentence.
  - They were removed from the "not retried" list.
- `docs/behavior/reactions-and-emoji.md` §8 has two new edge cases: a group reaction that cannot be stored
  is retried, and a failed reaction change shows stored truth.
- `docs/behavior/message-editing-and-deletion.md` §8: a group edit or delete that cannot be stored is
  retried.

## Open questions / residuals

- (see also Remediation round 1 below)
- `chatHandler`'s post-append `resolvePendingSignalsForSlot` failure is still swallowed (out of scope).
  It self-heals via the thread's sweep on the next message or signal in that thread. If the thread goes
  quiet, a held delete/edit for that message waits.
- DM reactions and edits have no journal, so a storage failure there is still not retried. The docs say
  so.
- The edit-vs-edit slot-meta residual in messageEdits/api.ts was not changed (documented, accepted
  earlier).

## Remediation round 1 (Codex: 0 high, 1 medium, 2 low)

1. **MEDIUM: a replay could raise a far-future delete/edit's rev.**
   - **Problem.** `sanitizeIncomingRev` caps a rev at `now + 6 h`, so a signal whose own rev lies
     beyond that ceiling got a rev that depended on when it was processed. Suppose its message
     write landed, its slot-meta write failed, and the journal replayed it later. The replay then
     used a higher rev and could overwrite an edit that had legitimately beaten the first
     application. The same applies to a replay after a failed ack.
   - **Chosen fix: option (b), a stored ceiling.** `applyDeleteEditSignal` resolves the rev through
     `resolvePinnedRev` before any effect is persisted. A rev the cap lowered is pinned per (thread,
     rumor id) in a new store, `few:messageEditsPinnedRevs:v1`. Every later processing reads the
     pin. An uncapped rev needs no pin: it is the signal's own value and stays uncapped as the clock
     moves forward. The pin is written before any effect, so no effect exists without its pin. The
     store is bounded like its siblings (`PENDING_SIGNAL_CAP`, oldest evicted) and is cleared with
     the thread's or account's edit state.
   - **Why not option (a), slot-meta in the message write's transaction:**
     - It would not fix the bug. Slot-meta records only the LAST signal per slot. Once an intervening
       edit has won, a replay of the earlier signal is not recognised, whether or not meta was written
       atomically. A replay after a failed ack hits the same problem with fully atomic writes. The
       root cause is the time-dependent rev, not the two writes.
     - It would also move chatPersistence's queued get/set mutations into a raw transaction, which
       breaks every Map-mocked suite that exercises edits.
   - **Corrected claims.** The "same rev" wording in this report is fixed above. The SlotMeta residual
     in `messageEdits/api.ts` now says a replay recomputes the same rev and never raises it.
   - **Remaining residual.** Eviction of a pin needs more than 256 far-future signals. That falls under
     the spec's accepted poisoned-clock residual (AC-ORDER-3).
   - **Tests.** Both paths are covered: kind-5 delete and edit-marked kind-9 edit. In each, the message
     write lands and the slot-meta write commits then rejects; an edit at NOW+7 h arrives 3 h later;
     the replay runs 5 h after the first processing, when the signal's own NOW+10 h is no longer
     capped. The intervening edit is kept, with rev NOW+7 h. Without an intervening edit, the replay
     re-applies at the first rev, NOW+6 h. Further tests: uncapped edits and deletes are not pinned
     (including one exactly at the ceiling); a capped signal is pinned once; pins are scoped by
     thread; clearing a thread without pins writes nothing; per-thread and full clears remove pins.
     All fail without the pin.
2. **LOW: a throwing listener could replace the write error.** `emit` now isolates each listener: a
   throw is warned and the rest still run. So `reconcileAfterRejectedWrite` never throws and the
   write's own error always propagates. A listener throw also no longer fails a successful write or
   a refresh. Two tests cover this.
3. **LOW: a permanently-invalid signal could burn all 5 retries during a storage outage.**
   - `applyDeleteEditSignal` now classifies before any storage access. For a `discard` result, the
     self-heal sweep, which any call runs and which existing tests rely on, is best-effort: warned,
     never thrown. The signal is acked on the first attempt. Invalid cases tested under a total read
     outage: edit-marked kind-5 companion, kind 5 without e-tags, malformed rev on a delete and on an
     edit, empty edit content.
   - **Fail-closed on a storage read.** Authorization (does the sender own the target, or is the
     sender an admin for an announcement) needs the stored row. A failed read there rejects: the
     signal is retried and never applied unchecked. A test covers it: another member's delete is
     retried during the outage, then acked without effect once reads work.
   - For a valid signal the sweep stays fatal, as before.

### Round 1 results
- Unit: 5858 passed, 1 skipped (256 files), +17 tests. tsc clean.
- Stryker (concurrency 1) on the lines changed in round 1 (messageEdits/api.ts 527-544, 743, 756,
  1376-1412, 1583, 1607-1611, 1616, 1622; reactions/api.ts 130-145): **98.44% (63 killed, 1
  survived)**.
  - The survivor is equivalent: `type: 'edit'` → `type: ''` on api.ts:756. A pre-existing token on a
    changed line; the edit branch is the fall-through after the `discard` and `delete` checks, so the
    literal is never compared.
  - A first, wider range (classifySignal 740-760 and the clear functions) also showed survivors on
    PRE-EXISTING unchanged lines: classifier guards on 746-755, and the marker/slot-meta filters and
    write guards in `clearMessageEditsStateForThread`. These are existing test gaps outside this diff
    and were not addressed here; they are candidates for a follow-up mutation pass.
- Docs: `message-editing-and-deletion.md` §8 is updated (far-future signals keep their first rev;
  malformed signals are never retried; the authorization check is retried while storage cannot be
  read).

## Remediation round 2 (Codex re-review: both LOWs resolved; MEDIUM partly)

**New MEDIUM: pins were lost across tabs.**
- `resolvePinnedRev` read the shared pin array with `get` and wrote it back with `set`. Two tabs
  pinning at once each wrote their own addition, so one pin was lost. That rumor's replay then
  recomputed a higher rev.
- The per-thread clear had the same read-then-write race against an insert.

**Fix:** a single readwrite transaction (no lock fallback needed).
- `modifyPinsAtomically` in `messageEdits/api.ts` re-reads the pin array and writes the result in
  ONE readwrite IndexedDB transaction, through the store callback with
  `promisifyRequest(os.transaction)`. It never uses `update()`.
- The store is idb-keyval's default database and object store (`keyval-store`/`keyval`, the same
  key `get`/`set` use), created lazily. IndexedDB serializes overlapping readwrite transactions
  across every tab.
- **Insert:** the common case stays one plain read (pin found, or not capped). A capped, unpinned
  rumor re-checks inside the transaction, so a pin another tab added meanwhile, even for the same
  rumor, is kept and its rev used.
- **Per-thread clear:** `removePinsForThread` drops the thread's pins in the same kind of
  transaction. It is skipped when the thread has no pins.
- **Account clear:** still a single blind `set([])`, which is atomic by itself; either order against
  an insert is a valid serialization.
- **Failure:** a failed read or an aborted transaction rejects before any effect lands, so the
  journal replays the rumor.

**Tests**
- New `tests/unit/messageEdits/pinnedRevCrossTab.test.ts` runs two independent module instances,
  each with its own idb-keyval connection, over one fake-indexeddb origin:
  - 20 concurrent pin inserts in pairs: all 20 pins survive.
  - The same rumor pinned by both tabs at once: one pin, and the stored rev equals it.
  - Ten per-thread clears interleaved with ten inserts from the other tab: exactly the cleared
    threads' pins are gone, and every inserted pin is kept.
  - With the round-1 non-atomic read/write swapped back in, the first and third tests fail.
- `reactionEditStorageFailureReplay.test.ts` uses `callableMapStore` over the same Map, with
  failure injection at every storage step this round touched:
  - The pin transaction's read fails, or its commit aborts: the rumor is kept, nothing is applied
    and no pin is written. The replay then pins and applies.
  - A failed cleanup transaction rejects the clear and keeps the pin.
  - Clearing a thread without pins opens no transaction.
  - One session creates the transaction store once.
- `messageEdits/api.test.ts`: its idb-keyval mock now provides `createStore` (a `callableMapStore`
  over its Map) and the real `promisifyRequest`. It fakes only `Date` (`toFake: ['Date']`) so the
  transaction's macrotasks run. `advanceTimersByTime` still moves the clock.

**Remaining residual: pin eviction (AC-ORDER-3).** The pin store is capped at `PENDING_SIGNAL_CAP`
(256), and the oldest pin is evicted first. Only signals with a far-future rev (beyond now + 6 h) are
ever pinned, so evicting a pin whose rumor is still pending replay needs more than 256 such signals
in between, which means a broken or hostile clock. An evicted rumor's replay can then recompute a
higher rev. This falls under the spec's accepted poisoned-clock residual (AC-ORDER-3): processing
time can order far-future signals, and that order is bounded best-effort only.

### Round 2 results
- Unit: 5866 passed, 1 skipped (257 files), 8 tests added. tsc clean.
- Stryker (concurrency 1) on the lines changed in round 2 (messageEdits/api.ts 541-602, 1678):
  **96.55%, with 56 killed, 1 survived and 1 with no coverage.** Both are equivalent or unreachable:
  - api.ts:599, `next.length !== current.length ? next : null` mutated to `true ? next : null`. The
    transaction body is reached only when the pre-read saw a pin of the thread. Without a
    concurrent removal in between, the array always shrinks. Even then, the mutant only rewrites an
    identical array.
  - api.ts:563, the `catch` that aborts the transaction. It is unreachable: the `modify` callbacks
    never throw. It is kept as a guard so that any throw aborts rather than commits.
- Docs: no user-visible claim changed this round.
