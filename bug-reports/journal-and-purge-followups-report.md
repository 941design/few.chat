# Journal and purge follow-ups: update() ban, real-IDB journal suite, guarded poll purge, purge-safe poll queues (identity write-back rejected)

Source: five BACKLOG.json findings filed 2026-10-16 as Decider follow-ups from the bug runs
journal-and-removal-robustness and poll-followups:
- `idb-keyval-update-lint-ban`
- `rumor-journal-real-idb-suite`
- `leave-fallback-identity-writeback`
- `leave-clearpolldata-unguarded`
- `poll-pending-queues-recreated-after-purge`

Plan: `bug-reports/journal-and-purge-followups-plan.md` (written at cd81fb6). Re-verified at 68b8dea:
none of the five anchors was touched by the intervening commits (reactions/edits only), and every
cited line still matched. Order of work 1 → 2 → 5 → 3 → 4.

## Verification against current code (before the fix)

1. **update() ban: confirmed.** There is no eslint in the project and `make test` never lints. Only
   comments in rumorJournal.ts, pollPersistence.ts and messageEdits/api.ts warned against it. No
   current use of `update` from idb-keyval exists (checked: static, aliased, multi-line and dynamic
   imports across app/src and app/pages).
2. **Real-IDB journal coverage: confirmed, narrower than worded.** putRumor already had a
   fake-indexeddb suite (rumorJournal.putRumor.test.ts) and the recordRumorFailure success path was
   covered in leaveJournalReplay.test.ts. Uncovered under real IDB: recordRumorFailure's failure
   paths, ackRumor + the remembered failed acks, listPendingRumors, sweepRumorJournal,
   clearRumorJournalForGroup and getJournaledSenderLeafIdentity's failed read.
3. **Live fallback identity not written back: confirmed.** `recordLeaveIntent`: a LIVE leave whose
   journal row has no identity captures the current leaf and uses it only in memory and in the
   pending-removal row. If that row's write fails, the leave stays journaled; the replay finds no
   journaled identity and skips the removal (by design, a replay never captures). The removal is lost.
4. **clearPollData unguarded: confirmed.** `leaveGroupImpl.ts:218` awaited it bare; a rejection
   skipped the rest of the purge, the MLS-state destroy, `reloadGroups` and `markBackupDirty`.
   Correction to the finding: most neighbouring purge steps are unguarded too; only the tombstone
   write and the pending-removal clear are guarded, and leaveGroupImpl.test.ts pins "a purge failure
   before the destroy leaves the tombstone" via `clearMessages`. Checked: the startup sweep only
   destroys MLS state; it never re-runs the purge, so a rejecting `clearPollData` gained nothing from
   the abort.
5. **Pending poll queues re-created after a purge: confirmed, by a different mechanism than worded.**
   A removal that empties a queue does NOT write `[]` (both writers delete on empty). The orphan key
   comes from:
   - (a) the get-then-set read-modify-write of `removePendingVotes` / `boundedQueue.remove` (and the
     queue adds) racing clearPollData's purge transaction: read before the purge, write after it;
   - (b) a cap reject rewriting the unchanged list;
   - (c) a queue add from a handler still in flight for the left group after the purge.
   TTL applies only on read, so such a key stays until `clearAllPollData`.

## Fix

1. **update() ban as a unit test** (`app/tests/unit/idbKeyvalUpdateBan.test.ts`, new). A
   `readdirSync` scan of every `.ts/.tsx/.js/.mjs` under app/src and app/pages, comments stripped
   (string-literal aware, so `'wss://…'` is not a comment). It flags `import { update [as x] }`,
   `import d, { update }`, `export { update } from`, `const { update[: x] } = await import(...)`,
   `(await import(...)).update`, and `N.update` for `import * as N` / `const N = await import(...)`.
   Self-tests prove each form is flagged and that look-alikes (`updateGroup`, `get as update`, other
   modules, comments) are not. It fails `make test-unit`.
2. **Real-IDB journal suite** (`app/tests/unit/marmot/rumorJournal.realIdb.test.ts`, new). The real
   module on fake-indexeddb; the module's store is a pass-through wrapper with one-shot faults
   (`reject` before start, `abort` after the requests were issued, `put-throws` via an object-store
   proxy), plus pass-through spies on get/del/delMany/entries/keys. Stored rows, read through an
   unwrapped connection, are the truth. No source change was needed for recordRumorFailure:
   fake-indexeddb aborts a transaction whose success handler throws, and the test proves it settles.
3. **Live fallback identity write-back. REMOVED in remediation round 1 (unsound; finding closed as rejected, see below).**
   - `rumorJournal.recordJournaledSenderLeafIdentity(groupId, rumorId, identity)` (new): read-check-put
     in ONE readwrite transaction through the store callback. Writes only onto an existing,
     well-formed row without an identity; never creates a row (an acked rumor stays acked), never
     replaces an identity journaled at first receipt; an empty identity opens no transaction; a throw
     aborts. Resolves true when it wrote.
   - `recordLeaveIntent` gets an optional `writeBackIdentity`. It is awaited only for a LIVE delivery
     whose row exists without an identity and whose capture returned a non-empty identity, BEFORE the
     durable pending-removal write. Best-effort: a rejection is warned and never fails the leave.
   - Wired in `MarmotContext.enqueueLeave`. Header and inline docs updated.
4. **clearPollData guarded** in `leaveGroupImpl`: try/catch, warned, the purge proceeds. Only this
   step; the getGroupMembers guard (opposite fail-closed direction by design) and the other steps
   are untouched. Residual documented in code and polls.md: the left group's poll rows may stay
   until `clearAllPollData`.
5. **Purge-safe poll queues** (`pollPersistence.ts`).
   - `queuePendingVote`, `removePendingVotes`, `boundedQueue.queue` and `boundedQueue.remove` (closes,
     close announcements) now read, decide and write in ONE `pollTxn` readwrite transaction, still
     inside their per-key `enqueue`. IndexedDB serialises them with clearPollData's purge
     transaction: one created before the purge commits first and its key is deleted by the purge;
     one created after reads nothing and writes nothing.
   - `writeQueue`: no write when the list is unchanged (same entries, same order); an empty list
     deletes only a key that was read. A cap reject over a list holding expired entries still
     rewrites it pruned (a real change).
   - `queuePendingVote`'s held-close cut-offs (formerly `keepForWrite` → `heldCloseCutoffs`, a
     separate read) are read inside the same transaction, only when the kept-votes cap bites; a
     failed read falls back to the plain cap with the same warning (pattern of saveVoteIfNewer).
     Held/dominated return logic unchanged. `keepForWrite`/`heldCloseCutoffs` removed (no other user).
   - Purge mark: module-level `purgedGroups`. `clearPollData` adds the group synchronously, before
     anything else. Every queue writer and `saveVoteIfNewer` (also without `requirePoll`, the plan's
     extra) checks it inside its transaction and writes nothing; `queuePendingVote` then resolves
     false. Released by `releasePollPurgeMark(groupId)`, called from
     `welcomeSubscription.dropLeftGroupTombstoneAfterJoin` (every successful join/re-join), and by
     `clearAllPollData`. In-memory only: after a reload no handler of a left group runs. Another tab
     is not covered (documented).
   - Size: pollPersistence.ts +112 / −79 lines (the queuePendingVote restructure is most of it).

## Tests (stored state is the truth compared everywhere)

- `idbKeyvalUpdateBan.test.ts` (new, 23 tests): tree scan (non-vacuous: >50 files, >10 idb-keyval
  importers), 10 flagged forms, 9 non-flagged look-alikes, line reporting, string-aware stripping.
- `rumorJournal.realIdb.test.ts` (new, 30 tests):
  - recordRumorFailure counts 1, 2, 3 keeping every field; no row / malformed row → 0 and nothing
    written; reject / abort / put-throws each settle, reject, leave the row unchanged and do not
    count; a re-put keeps the count; a concurrent put and count both land.
  - recordJournaledSenderLeafIdentity: writes onto an identity-less row only; never creates a row;
    never replaces; leaves a malformed row alone; empty identity opens no transaction; reject / abort /
    put-throws settle, reject, row unchanged.
  - getJournaledSenderLeafIdentity: a failed read rejects (never "not journaled").
  - ackRumor: deletes; a failed delete rejects, the row is hidden from listing as applied and retried
    on the next ack; indeterminate delete (commit then reject) is harmless; a failed retry only warns.
  - listPendingRumors: receipt order (not key order), drops+deletes expired/malformed rows
    store-wide; a failed cleanup still returns the pending rows; a failed read rejects.
  - sweepRumorJournal counts/deletes; failed entries/delMany reject, rows survive.
  - clearRumorJournalForGroup is prefix-exact (G1: vs G10:); failed keys/delMany reject, rows
    survive; the group's remembered failed acks are forgotten.
- `pendingRemovalStorage.test.ts` (+10): write-back exactly once and before the durable write in the
  one qualifying case; not for replays, an existing identity, no row, a failed / empty / missing
  capture; a rejecting write-back is warned while the removal is still recorded, stored and armed; a
  write-back plus durable-write failure rejects with the durable error.
- `leaveJournalReplay.test.ts` (+3, end to end on fake-indexeddb, session wiring now passes the real
  write-back): identity-less row, live capture CURRENT_ID, persist fails → the next session's replay
  stores the removal with CURRENT_ID, never re-captures, and acks; write-back AND persist fail →
  replay skipped and acked (documented residual); success path unchanged.
- `leaveGroupImpl.test.ts` (+2): clearPollData rejects → leave resolves true; every later step runs
  once with the group id (inline destroy and deferred destroy); warned. The clearMessages test is
  unchanged.
- `pollFollowups.test.ts` (+43; 4 existing tests adapted):
  - Per queue (early votes, closes, announcements): a removal whose transaction opened before the
    purge → key deleted by the purge (success signal); a removal started during the purge writes
    nothing; property over 10 interleavings of removals and adds around the purge → no key; an add
    after the purge writes nothing, after `releasePollPurgeMark` it is queued; no-match removal
    writes nothing, an emptying one deletes, a missing key deletes nothing; failure injection on the
    queue read, write and delete of adds and removals → rejects, list unchanged.
  - queuePendingVote resolves false for a purged group; regression: an early vote for a live group
    without polls is queued; the mark is per group; clearAllPollData releases it; a failing purge
    still keeps the mark; cap rejects and a dominated vote write nothing; an expired entry is
    pruned on a cap reject; per-group eviction and a dominated-entry replacement (same length,
    different entries) write; an early-vote removal issued right after the purge started writes
    nothing; the held closes are read only past the kept-votes cap; end to end, a left group's
    in-flight vote and close handlers write nothing.
  - Adapted (intentional, not weakened): the two failure-injection tests that failed the queue's
    `set`/`del` now fail the in-transaction put/delete; "without requirePoll it still writes" now
    pins that it does NOT write for a purged group and does again after release; the R2 race test
    starts the purge in a microtask after the vote transaction's body (its intent: a transaction
    created before the purge commits first).
- `leftGroupStatePurge.test.ts` (+3): a fresh join, the orphan-state re-join and accepting an
  already-joined group release the mark (early votes held again); a failed join does not.
- `pollOrdering.test.ts`: comment only (the queue path's held-close read is now in-transaction; the
  existing failure injection already covers it).
- All new poll tests were run against the old pollPersistence.ts (with a no-op
  `releasePollPurgeMark` stub): 36 fail.

## Results

- Unit: 5980 passed, 1 skipped (259 files). Baseline 5866 passed, 1 skipped (257 files): +114 tests,
  4 existing tests adapted.
- tsc: clean.
- Stryker 9.6.1, concurrency 1, scratch config in the session scratchpad (`stryker-jp/`), on the
  changed code lines of rumorJournal.ts (178-198), pendingRemovalStorage.ts (157-162, 173-184),
  leaveGroupImpl.ts (222-226), pollPersistence.ts (409-414, 770, 877-883, 894-901, 923-963,
  995-1003, 1029-1049, 1059, 1189, 1240) and welcomeSubscription.ts (603, no mutants).
  - Round 1: 95.24% (160 killed, 8 survived).
  - Fixes: tests for per-group eviction and dominated-entry replacement (`every`→`some`), the
    kept-votes cap boundary (two mutants), a removal issued between the purge mark and the purge
    transaction (the removal's mark check); the dead `wrote = false` in
    recordJournaledSenderLeafIdentity's catch was removed (the promise rejects, so it was never
    observable).
  - Final: **98.20% (164 killed, 3 survived, all equivalent)**:
    - pollPersistence.ts:879 `Array.isArray(raw) ? raw : []` → `["Stryker was here"]`: the string
      entry is filtered out by the shape check; same result.
    - pollPersistence.ts:935 `own.length === 0` → `true`: a voter with an entry for this poll AND
      entries for MAX_PENDING_VOTES_PER_VOTER other polls is unreachable through the API (the cap
      admits at most that many distinct polls per voter); pre-existing condition, moved.
    - pollPersistence.ts:959 `capKept(sorted, [])` → `capKept(sorted, ["Stryker was here"])` in the
      held-close read fallback: a number compared with a string is always false, so no cut-off
      selects a vote; same as no cut-offs.
  - The welcomeSubscription source-scan suites were left out of the Stryker vitest config: they
    assert on the raw source text, which instrumentation changes (dry run fails otherwise). The
    release call is covered by leftGroupStatePurge.test.ts.
- e2e: not run (fixer brief). #5 touches MarmotContext.tsx and #4 welcomeSubscription.ts, so the
  full gate (`make test-e2e-all`) is required before shipping.

## Docs

- `docs/behavior/polls.md` (You leave a group): held closes and announcements included; in-flight
  poll messages of the left group never bring anything back (this tab only); re-joining restores
  normal holding; a failed poll-data deletion no longer blocks the leave and leaves unused data until
  the account's local data is cleared.
- (Reverted in remediation round 1) `docs/behavior/groups.md` §8 (What it does not guarantee): a live departure without a recorded
  membership records the membership it used with the kept departure first, so a reopen after a
  failed removal store acts on it; only if that recording fails too is it not acted on.

## Open questions / residuals

- Cross-tab: another open tab still processing the left group's poll messages can re-create a queue
  key (its in-memory mark is not set). `clearAllPollData` removes it.
- Same bug class, not in scope: `savePoll` (open poll), `allocateVoteSeq` and the receipt clock are
  not purge-marked; an in-flight poll-open of a left group can still write `few:polls:<group>` after
  the purge. Candidate follow-up finding.
- handleVote's save-failure fallback warns "early-vote cap reached" also when `queuePendingVote`
  returned false because the group was purged (cosmetic; the handler rethrows the save error either way).
- A failed `clearPollData` is not retried (left poll rows stay until `clearAllPollData`).

## Remediation round 1 (Codex: 1 HIGH, 1 MEDIUM; lead decisions)

1. **HIGH: the identity write-back was unsound. Removed; the finding
   `leave-fallback-identity-writeback` is closed as REJECTED.**
   - **Problem.** An identity-less leave can wait in the dispatcher while its sender leaves and
     re-joins. The live capture then reads the NEW membership's leaf and wrote it onto the OLD rumor's
     journal row. If the removal persist failed, the replay evicted the re-joined member.
   - **Decision (lead, following the Decider precedent from journal-and-removal-robustness round 2):**
     "never evict a re-joined member" outranks "never lose a removal". Only a capture bound to the
     epoch the leave was encrypted in could make a write-back sound, and live handling cannot obtain
     that (the epoch tree is what ingest failed to read in the first place).
   - **Change.** `rumorJournal.recordJournaledSenderLeafIdentity`, `recordLeaveIntent`'s
     `writeBackIdentity` and its MarmotContext wiring, their tests, and the groups.md §8 lines
     describing the write-back are gone. `rumorJournal.ts`, `pendingRemovalStorage.ts`,
     `MarmotContext.tsx`, `pendingRemovalStorage.test.ts` and `docs/behavior/groups.md` are back to
     HEAD. The behaviour is the prior one: a replayed leave without a journaled identity is skipped.
   - **Pin.** `leaveJournalReplay.test.ts`: identity-less row, live leave with a captured identity,
     persist fails → the journal row still has no identity; the replay never captures, removes
     nothing, and acks (warned).
2. **MEDIUM: the purge mark was not released on every re-join path.** When the pre-join inspection
   gives no group id (join-request auto-accept, or an invitation without a stored group id),
   `joinGroupFromWelcomeCore` calls `joinAndPersist` directly, which skipped
   `dropLeftGroupTombstoneAfterJoin` and with it the release.
   - **Audit.** Every join of a Welcome in app/src is the single `marmotClient.joinGroupFromWelcome`
     call in `welcomeSubscription.joinAndPersist`. It is reached from `joinGroupFromWelcomeCore`,
     whose two callers are the S4 auto-accept (join-request approval, no known id) and
     `acceptPendingInvitation` (invite accept, pull-only/stored invitations, with or without an id).
     The one join that does not call it is `joinIdempotent`'s already-joined branch (overlay exists).
     Group creation makes a new id (never marked). Backup restore re-adds groups but is followed by a
     page reload (settings.tsx), which drops all in-memory marks.
   - **Fix: choke point.** `joinAndPersist` releases the mark by the JOINED group's id
     (`mlsGroup.idStr`) right after `saveGroup`; the already-joined branch releases it too. The
     release was removed from `dropLeftGroupTombstoneAfterJoin`.
   - **Tests.** `leftGroupStatePurge.test.ts`: a Welcome with no resolvable pre-join id (the
     auto-accept path) releases the mark (new), next to the fresh join, orphan re-join,
     already-joined accept and failed-join cases. New `joinPollPurgeRelease.scan.test.ts`: app/src
     calls `.joinGroupFromWelcome(` exactly once, in `joinAndPersist`, followed by
     `await saveGroup(joinedGroup); releasePollPurgeMark(joinedGroup.id);`. Removing either release
     call fails the matching tests (checked).
3. **Unreviewed case, verified.**
   - The mark is set only inside `clearPollData`. leaveGroupImpl calls it after
     `removeGroupFromStorage`, `clearMemberProfiles` and `clearMessages`, which are awaited unguarded,
     so a leave that aborts before it never sets the mark, and whenever the mark is set the group's
     overlay is already deleted.
   - `clearPollData` fails: the leave completes (round-0 guard), the group is gone, the mark stays.
     That is harmless (no live group to block) and a re-join releases it.
   - No path leaves the mark set for a still-joined group, so no failure-time clear was added.
   - Tests (`pollFollowups.test.ts`, leaveGroupImpl with the real clearPollData): an abort at
     removeGroupFromStorage / clearMemberProfiles / clearMessages leaves the group's queue writable;
     a failing clearPollData → leave resolves true, the mark blocks, release unblocks; a successful
     leave keeps the mark.

### Round 1 results
- Unit: 5967 passed, 1 skipped (260 files). tsc clean.
- Stryker (concurrency 1) on this round's changed lines (welcomeSubscription.ts 578-582, 683-687):
  no mutants on the changed lines (bare call statements produce none); the 3 survivors are
  pre-existing logger-argument mutants on the unchanged line 579. The two release calls are pinned
  by tests instead (deleting either fails them).
- Docs: groups.md §8 reverted to HEAD; polls.md unchanged this round (its "re-joining" sentence holds
  on every join path now).
