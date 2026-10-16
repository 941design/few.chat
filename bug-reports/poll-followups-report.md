# Poll follow-ups: held-state sweep, held-close-aware vote keeping, close-time prune, seed retry, cap-drop signal

Source: five BACKLOG.json findings filed 2026-10-16 from bug runs
`poll-residual-ordering-and-close-retry` (commit 9e25d07) and `journal-and-removal-robustness`
(commit 730b976). Slugs: `poll-held-close-startup-sweep`, `poll-kept-votes-held-close-aware-pruning`,
`poll-superseded-prune-at-close`, `poll-receipt-clock-seed-failure-backward-step`,
`pending-vote-cap-drop-observable`.

## Verification against current code (before the fix)

1. **Held closes / announcements only retried by a later poll message — confirmed, narrower than filed.**
   A kind-12 close or a summary whose own handling failed throws and stays journaled, so the journal
   replay at the next subscription already re-runs it. What nothing retried: held state whose
   triggering rumor was *acked* — a held summary whose replay failed inside `settleHeldCloses`
   (logged, the triggering message acked), a `recoverHeldCloses` failure on the closed-poll vote path
   or the duplicate-open path (acked), a pre-open close/summary that was held successfully (acked by
   design) and whose open-time settle then failed, and any rumor dropped as poison after 5 attempts.
   Those waited for the next message of the poll, or for the 7-day expiry.
2. **Earliest-received dropped beyond the cap regardless of held closes — confirmed.** `keptVotes`
   sliced to the last 20 by receipt; the R2 cap+1 test pinned A as not counted.
3. **Superseded snapshots survive the closed write — confirmed.** `savePoll` touched only the poll list.
4. **Failed seed read + backward clock step — confirmed.** `seedReceiptClock` tried once, then the
   receipt was `Date.now()`-based and could fall below the persisted mark.
5. **queuePendingVote silent at the cap — confirmed.** It resolved `void` both when storing and when
   the per-voter poll cap dropped the vote; handleVote's fallback could not tell.

## Fix

1. **Sweep** (`pollHandler.createHeldPollStateSweeper`, `pollPersistence.listHeldPollIds`,
   `DispatcherSubscription.enqueueMaintenance`, `registerHandlers.BuiltDispatcher.sweepHeldPollState`,
   `MarmotContext`). At every (re)subscription, right after the journal replay is enqueued, the group's
   dispatcher FIFO gets a maintenance task. It lists poll ids with anything held (early votes, closes,
   announcements; live entries) and, for each **stored** poll, runs `recoverStoredPoll` — exactly what a
   re-delivered open did (now factored out of `handleOpen`): early-vote replay for an open poll, then
   `recoverHeldCloses` (creator-close settle with the as-of tally, held-announcement replay, clean-up).
   Polls not stored yet are skipped (their entries wait for the open). Running ON the FIFO is the point:
   settling is read-then-save, so it must not interleave with a handler of the same poll.
   `enqueueMaintenance` skips the task after disposal, warns on a throw and never rejects. Because it is
   wired per subscription, a re-subscribe sweeps too.
2. **Held-close-aware keeping** (`keptVotes(votes, cutoffs)`, `keepForWrite`). Domination filtering is
   unchanged. Only when the result exceeds `MAX_VOTES_KEPT_PER_VOTER`, the vote write (inside its queue
   slot — both `saveVoteIfNewer` and `queuePendingVote`) reads the poll's held closes (every sender: the
   creator may not be known yet; more cut-offs only keep more) and always keeps the vote each cut-off
   selects plus the newest; the remaining room goes to the latest-received others. The kept set can
   therefore exceed 20 by at most one vote per held close (bounded by the close queue: one per poll and
   sender, 50 per group). A failed read falls back to the plain cap with a warning; the write itself is
   never failed by it. `saveVoteIfNewer` now compares against the stored set as is (`undominated`), so a
   set above the cap is not re-pruned by a re-delivery. The R2 cap+1 tests flip to counted
   (CAP+1 and CAP+5); a new test pins the read-failure fallback (still not counted, documented).
3. **Close-time prune** (`savePoll`). After the poll list write of a closed poll, a best-effort step on
   the vote key's queue drops `superseded` from every row (no write when there is none). Failure → warned,
   snapshots left (harmless); the closed poll is already stored. A failed poll write rejects before it.
4. **Seed retry** (`seedReceiptClock`). Up to `RECEIPT_SEED_ATTEMPTS` = 3 reads with a 25 ms / 50 ms
   backoff (~75 ms worst case) before the receipt is handed out; on exhaustion the receipt is still
   handed out (never blocks ingestion on an indeterminate read) and the next receipt seeds again.
   The second floor source (max persisted `receivedAt` across votes, queues and held closes) was
   considered and not built: it reads the same IndexedDB database, so a failure that survives three
   retries of one key read would almost always fail the scan too, and it costs a full key scan at
   startup. The residual (all retries fail AND the clock was set back) is documented in polls.md §5.
5. **Cap-drop signal** (`queuePendingVote: Promise<boolean>`). True when the vote is stored or
   represented by a dominating kept entry of the same voter (an identical or older re-delivery — it can
   never change a tally); false when the per-voter poll cap dropped it. A failed write still rejects
   (never reported as a drop). `handleVote`'s save-failure fallback warns with group, poll, voter and
   rumor id on false and rethrows the save error as before, so the journal keeps the vote. The polls.md
   §5 residual sentence ("storage fails twice in a row") was widened to include the full early-vote
   holding area — it no longer held as written.

## Tests

New `app/tests/unit/marmot/pollFollowups.test.ts` (42 tests, real handlers + real idb-keyval over
fake-indexeddb, pass-through spies for failure injection; assertions read stored state):
sweep success signal, as-of tally, held summary replay, early votes, unstored poll untouched,
non-creator close discarded, nothing-held no-op, idempotence; failure injection at the listing, the
poll read (other polls still swept), the closed write (stays held, next sweep closes), the held-close
read (nothing written, no bump) and the clean-up (closed anyway, next sweep removes without re-closing);
`listHeldPollIds` union/TTL/group scoping and a failing read of each queue; `keptVotes` cut-off cases
plus a seeded 400-case property (for every cut-off and "after everything" the kept set selects the same
vote as the full set; size bound); write paths read held closes only above the cap, are not re-pruned by
a re-delivery, survive a failed held-close read, reject on a failed vote write; close-time prune on the
live close and the sweep, no write when nothing to drop, failure at the votes read / write / poll write;
seed retry (success signal: fail once + clock back → above the pre-reload mark; fail twice then succeed;
all fail → bounded wait, handed out, re-seeded next time; one read when healthy); `queuePendingVote`
results incl. a failed write rejecting; handleVote fallback warning on a capped drop and none when held.
Also: dispatcher `enqueueMaintenance` FIFO order, throw isolation, disposal skip and drain
(`applicationRumorDispatcher.test.ts`); `buildDispatcher` sweep wiring (`registerHandlers.test.ts`);
the R2 cap tests flipped and the seed test adapted to exhaust all attempts (`pollOrdering.test.ts`).

## Verification

- Unit: 255 files, 5752 passed, 1 skipped (before: 5701 passed; +51 tests). `tsc --noEmit` clean.
- Stryker 9.6.1, concurrency 1, scratch config and reports under the session scratchpad
  (`mutation/stryker.config.mjs`, `mutation-r2.json`), on the changed lines of pollPersistence.ts,
  pollHandler.ts, applicationRumorDispatcher.ts and registerHandlers.ts.
  Round 1: 91.29 % (218 killed, 2 timeout, 21 survived). Gaps closed: the cap-drop warning payload,
  a two-row close-time prune (`some` vs `every`), the exact-cap boundary of the held-close read,
  `queuePendingVote` evicting its own entry under the group cap while the voter has another kept entry,
  and a duplicate with other voters queued. `capKept` was made robust (no fast-path guard;
  `slice(max(..., 0))`) and the prune simplified, which removed fragile/equivalent mutants.
  Round 2: **96.14 %** (220 killed, 4 timeout, 9 survived — all equivalent or pre-existing):
  - pollHandler.ts:174 `settled === 'unknown'` → false / `""`: `'unknown'.closed` is undefined, so no
    bump either way (code moved verbatim from handleOpen).
  - pollPersistence.ts:152 default cut-offs and :194 the read-failure fallback `[]` → `["Stryker was
    here"]`: a non-numeric cut-off selects no vote (`n <= "…"` is false), same as no cut-off.
  - :159 `j === i` → false and :162 `j < i` → `<=` / `>=`: pre-existing domination logic moved into
    `undominated`; a self-comparison falls through to false, and the tie-break only picks which of two
    identical-key entries (same seq, created_at and rumor id = the same rumor) survives.
  - :431 `postStoreChanged('polls', …)` channel name: pre-existing savePoll line, re-indented; the
    cross-tab channel is covered by its own tests, not the poll suites.
  - :770 `own.length === 0 &&` → true: pre-existing and redundant — with an entry for this poll the
    voter holds at most nine other polls (the ten-poll cap counts this one).
- e2e: not run (fixer brief).

## Remediation round 1

Trigger: Codex review of the sweep, 1 HIGH + 2 MEDIUM, all fixed.

1. **HIGH: disposal could not stop a running sweep, and a purge could be undone.**
   - **Cancellation.** `enqueueMaintenance` now hands the task `isDisposed()`. MarmotContext passes it to
     `sweepHeldPollState(ctx, isDisposed)`. The sweeper wraps every dependency with `guardDeps`, which
     checks cancellation immediately before each call (so before every storage read and write) and again
     right after each awaited promise settles. A cancelled check throws `MaintenanceCancelled`. The
     recovery helpers turn that into "unknown, leave it held", and the sweeper returns without writing or
     warning. The held-summary replay goes through the chat gate, so `buildDispatcher` builds it, per
     run, from guarded chat deps plus a settler over guarded poll deps.
   - **Purge without disposal.** Leave and wipe purge storage while the subscription can still be live.
     I chose the in-transaction guard over draining: the poll store's writes now re-check existence in
     the same readwrite transaction, via one transaction on idb-keyval's default database through the
     store callback and `promisifyRequest(os.transaction)`; no `update()` (`pollTxn`).
     - `savePoll` of a closed poll re-reads the poll list in that transaction and writes nothing when the
       poll is gone (it resolves null).
     - The close-time prune reads and writes in one transaction.
     - `saveVoteIfNewer(vote, { requirePoll: true })` is now used by every early-vote replay, so also by
       the sweep. It reads the poll list, the vote rows and, when needed, the held closes in one
       transaction, and writes nothing unless the poll is stored. Live vote writes keep their old
       behaviour (no `requirePoll`).
     - A failed held-close read inside that transaction is handled with `preventDefault`, so the
       plain-cap fallback still holds; any other failed step aborts the transaction and rejects.
     - `storeClosed` turns a null result into "unknown", which stops all further writes.
2. **MEDIUM: overlapping sweeps from an old and a new subscription.** The old sweep is cancelled once
   disposed (item 1). In addition, closing is now monotonic and idempotent in storage: the closed write
   never overwrites an already-closed poll (first close wins) and resolves the stored poll. The held-close
   settler, and so the summary gate, uses that stored poll, so a summary always announces what the card
   shows. PollStoreContext's own close shows the stored result too.
3. **MEDIUM: vote-only recovery did not refresh the UI.** `replayPendingVotes` now returns how many votes
   it stored. `recoverStoredPoll` (sweep and repeated open) bumps `pollVersion` when it stored votes or
   closed the poll. The cross-tab notice is posted by the persistence writes themselves, after commit and
   only when something was written (`postStoreChanged('polls', groupId)`), the same as the live path.

**Tests:**
- Dispose while each sweep step is pending (list, poll read, early-vote read, vote read, held-close read):
  nothing is written, there are no warnings or bumps, and the next sweep completes the close.
- Dispose and purge while pending: no poll, vote or held-close rows come back.
- Purge without disposal after the read completed: storage refuses to re-create the poll or its votes.
- Storage-level checks:
  - a closed write for a missing poll;
  - `requirePoll` against a missing poll and against another stored poll of the group;
  - a failed poll read inside the vote transaction.
- First close wins:
  - a direct second write (no write, no notice);
  - two interleaved sweeps where the old one has a stale empty view: the first, correct tally stays;
  - a live close racing a stored close;
  - the settler returns the stored close;
  - a failed close transaction.
- UI bump on vote-only recovery, plus the cross-tab notice; a repeated open recovering votes; no bump when
  nothing was stored.
- `guardDeps` itself, and the dispatcher handing `isDisposed` to the task (false while subscribed, true
  once disposed mid-task).
- Other transaction steps:
  - a throwing step (a corrupt row) aborts and rejects with its error;
  - a non-array vote value;
  - a close with nothing to prune writes the votes key not at all;
  - cut-offs count only live, well-formed closes of this poll (TTL boundary with a fixed clock).
- Test infrastructure: the Map-mocked suites (`pollOrdering`, `pollIntegrity`, `pollHandler`,
  `pollPersistence`, `crossTab-writers`) now get a transactional store from
  `tests/unit/helpers/callableMapStore.ts`. That helper gained `clone`, `failGet` (an error with
  `preventDefault` semantics) and `failCommit`. `pollFollowups` injects faults at the real
  fake-indexeddb transaction (`failGet` / `failPut`) and logs reads and writes.

**Verification:**
- Unit: 255 files, 5795 passed, 1 skipped; `tsc` clean.
- Stryker 9.6.1 (concurrency 1, scratchpad `mutation/stryker.r1.mjs`) on the round-1 lines of
  pollPersistence.ts, pollReplay.ts, pollHandler.ts, applicationRumorDispatcher.ts and registerHandlers.ts:
  - first run 83.76 %;
  - after the gaps were closed **94.23 %** (292 killed, 2 timeouts, 17 survived, 1 no coverage).
- The survivors are equivalent, unreachable or pre-existing:
  - `['Stryker was here']` replacing an empty cut-off list or a non-array fallback: a string cut-off
    selects nothing, and a string entry fails the shape check.
  - `let wrote = true`: always assigned before it is read.
  - `if (onError)` → true: a read without a handler aborts either way.
  - `typeof e !== 'object'` → false: a number entry still fails the field checks.
  - pollHandler `settled !== 'unknown'` → true: `'unknown'.closed` is undefined.
  - The default `isCancelled` → `() => undefined`: still falsy.
  - The loop-head cancel check → false: the next guarded read throws and the catch returns.
  - The recovery catch in the sweep loop: only a cancelled, guarded UI bump can throw there, so the
    not-cancelled warning is unreachable.
  - Pre-existing log-only catches in `recoverPendingVotes` and `replayPendingVotes`.

**Residual:**
- A held summary's replay can still append its chat row in the window between the gate's poll read and
  the append, if a leave purges in exactly that window without disposing first. This is guarded by
  cancellation once disposed; chat rows are outside the poll store.
- The gate's "hold" of a summary for a poll that has just been purged re-creates a held entry. It expires
  after 7 days and is never applied.

## Remediation round 2

Trigger: Decider (Fable) RETRY on the Codex round-1 re-review (1 HIGH, 1 MED, 1 LOW).

1. **HIGH: `requirePoll` passed during `clearPollData`'s gap** between deleting the vote keys and the poll
   list, so a replay in that window re-created an orphan vote row. `clearPollData` is now ONE readwrite
   `pollTxn` (`PollTxn` gained `delete` and `allKeys` = `os.getAllKeys()`). It deletes the poll list,
   enumerates the keys inside the transaction, deletes every `few:poll-votes:{group}:` key, then the
   pending-vote, pending-close and pending-announcement queues and the seq reservations.
   `settleVotesMigration()` still runs first.
   - Why this is safe: readwrite transactions on the same store serialise in creation order, also
     across connections. A `requirePoll` vote transaction created before the purge commits first, and
     the purge's scan then sees and deletes its key. One created after the purge reads no poll list and
     writes nothing. The docblocks of `clearPollData` and `saveVoteIfNewer` state this.
   - A failed enumeration or delete aborts the transaction: nothing is deleted and the call rejects.
2. **MED: a partial replay returned 0, so the UI was never bumped.** `replayPendingVotes(poll, deps,
   progress?)` counts each stored vote into `progress.stored` as it lands. `recoverPendingVotes` reads
   that count after a throw, logs a warning with it ("failed after storing N") and returns it, so
   `recoverStoredPoll` (sweep and repeated open) bumps `pollVersion` once.
   - Unchanged: `loadVotesWithPending` still rejects; the entries stay queued, because the removal only
     runs after a complete replay; the `handleVote` call ignores the count, as before.
3. **LOW: a prune that failed at the first close was never retried.** `savePoll` now runs
   `dropSupersededVotes` whenever the transaction resolves a stored closed poll, also when an earlier
   close won and nothing was written. `postStoreChanged` stays gated on an actual write; a missing poll
   runs no prune.

**Tests** (all in `pollFollowups.test.ts`, on fake-indexeddb):
- A transaction-start hook starts a `requirePoll` write inside the running purge: no vote rows and no
  poll list afterwards.
- A vote whose transaction was created just before the purge does write, and is gone afterwards.
- A property-style loop over 12 offsets of racing replays around the purge leaves no orphans.
- Atomicity pin: exactly one readwrite transaction, with deletes in the order polls → vote keys →
  queues → seq; no other storage call.
- Another group whose id shares the prefix survives; a non-string key survives.
- A failed enumeration, vote-key delete or queue delete rejects and deletes nothing.
- Partial replay (B's write fails), via the sweep and via a repeated open: A is stored, one bump, both
  entries stay queued, a warning, exactly one cross-tab notice.
- All writes fail: no bump and no notice. `loadVotesWithPending` rejects on a partial replay; progress
  is reported; a full replay resolves 2.
- Prune retry: the first close's prune fails, so `superseded` stays. A second closed write does no
  poll-list write, posts no notice, returns the first close, and the prune now runs. A duplicate with
  nothing to prune writes nothing.
- Checked against the old multi-step purge: the race, property, atomicity and failure tests fail on it.

**Verification:**
- Unit: 255 files, 5809 passed, 1 skipped; `tsc` clean. One run hit a pre-existing 1 ms timing flake in
  `profileRequestSync.test.ts` (`isProfileStale` within the staleness window), unrelated to this change;
  it passed on 3 isolated reruns and the next full run was green.
- Stryker (concurrency 1, scratchpad `mutation/stryker.r2.mjs`) on the round-2 lines: 94.23 % at first,
  then **98.08 %** (51 killed, 1 survived) after tests for a non-string key and the replay's resolved
  count. The survivor is `progress` defaulting to `{}`: the default is only used when a caller ignores
  progress, and `undefined++` there is harmless.

**Pre-existing residuals (filed by the coordinator as follow-ups):**
- `queuePendingVote` (which takes no `requirePoll`) and the queue removals (`removePendingVotes`,
  `removePendingCloses`, `removePendingCloseAnnouncements`, all re-read-then-store) can re-create a
  `few:poll-pending-*` key after the purge when they race it. Such an entry is never applied (its poll
  is gone) and expires with the 7-day TTL.
- `leaveGroupImpl.ts:218` awaits `clearPollData` without try/catch. A now-atomic purge that rejects
  stops the remaining purge steps of the leave (the tombstone is already written, so the startup sweep
  finishes it).

## Constraints

Local storage only; no new publishes (privacy invariant untouched). e2e not run (fixer brief).
