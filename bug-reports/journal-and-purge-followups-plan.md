# Plan — journal-and-purge-followups (read-only analysis at HEAD cd81fb6, 2026-10-16)

All five findings verified real at HEAD (some narrower/different than worded). One bug run, order 1 → 2 → 5 → 3 → 4.

## 1. idb-keyval-update-lint-ban
No eslint installed/configured; `make test` never lints. Enforce via a vitest source-scan test
`app/tests/unit/idbKeyvalUpdateBan.test.ts`, modelled on `app/tests/unit/marmot/handlersRumorPubkeyBoundary.test.ts`
(readdirSync enumeration, comment stripping, scanner self-test). Scan app/src + app/pages *.ts/*.tsx; flag static
`import { …update… } from 'idb-keyval'` (incl. `update as x`), dynamic `{ update } = await import('idb-keyval')`,
namespace import + `N.update(`. Tests: zero violations in tree; fixtures for each form flagged; `updateX`/comment not flagged.

## 2. rumor-journal-real-idb-suite
Narrower than worded: putRumor already covered (rumorJournal.putRumor.test.ts); recordRumorFailure success path in
leaveJournalReplay.test.ts:170. Missing under real IDB: recordRumorFailure failure paths (rumorJournal.ts:154-167),
delete paths ackRumor (210), retryFailedAcks (223), listPendingRumors (265), sweepRumorJournal (284),
clearRumorJournalForGroup (292), attempts × re-put/ack. New `app/tests/unit/marmot/rumorJournal.realIdb.test.ts` with the
pendingRemovalStorage.test.ts:17-61 harness (fake-indexeddb/auto, wrapped createStore with one-shot reject/abort,
object-store Proxy for get error / put throw, pass-through spies on get/del/delMany/entries/keys).
Cases: recordRumorFailure counts 1,2,3; malformed/no row → 0 + no write; every fault settles+rejects, row unchanged;
re-put keeps attempts; concurrent putRumor+recordRumorFailure both land; ackRumor del failure → remembered-applied hidden
from listPendingRumors, retried on next ack/listing, failed retry warn-only; listPendingRumors drops+deletes
expired/malformed, groups by group ordered by receivedAt, failed cleanup still returns rows; sweep counts/deletes/rejects;
clearRumorJournalForGroup prefix-exact (G1: vs G10:), failed delMany rejects + rows survive. Reset via
clearAllRumorJournal() in beforeEach (module state appliedUnacked/lastStamp).
Risk: if fake-indexeddb doesn't abort on a throwing onsuccess, add putRumor's try/catch → os.transaction.abort() to
recordRumorFailure (one-line source fix).

## 5. leave-fallback-identity-writeback
Real: pendingRemovalStorage.ts:155-170 — live delivery, journal {journaled:true} without identity, capture succeeds,
persist fails → row unacked, replay hits skip at 158-161 → removal lost.
Change: rumorJournal.ts new `recordJournaledSenderLeafIdentity(groupId, rumorId, identity)` — single readwrite txn via
store callback (like putRumor), writes only if row exists, well-formed, and has no identity; never creates a row; abort on
throw. recordLeaveIntent gets optional `writeBackIdentity`; call only when live && recorded.journaled && no identity &&
capture returned non-empty; best-effort (warn, never reject); await BEFORE recordPendingRemoval. Wire in
MarmotContext.tsx ~972-986. Update header doc pendingRemovalStorage.ts:34-35.
Tests: pendingRemovalStorage.test.ts recordLeaveIntent block (~662): called exactly once only in that case; not for
replay / existing identity / journaled:false / capture throws or undefined; rejecting write-back warned, removal still
recorded+armed. leaveJournalReplay.test.ts end-to-end (update session() wiring): identity-less row, live, capture
CURRENT_ID, persist fails → next session replay queues+stores removal with CURRENT_ID and acks. Write-back fails + persist
fails → replay skipped (documented residual). Item-2 suite: new fn no-row / malformed / existing-identity / abort /
get-error.

## 3. leave-clearpolldata-unguarded
Real at leaveGroupImpl.ts:218. Correction: neighbours 215-231 are also unguarded; only tombstone write (208-212) and
clearPendingRemovalsForGroup (232-236) are guarded; leaveGroupImpl.test.ts:599-608 deliberately pins
"purge failure before destroy leaves tombstone" via clearMessages. Change: wrap only line 218 like 232-236 (warn and
proceed). Do NOT touch the getGroupMembers guard 157-164 (opposite fail-closed direction by design) and do not generalise
to other steps. Document residual (left-group poll rows may survive; clearAllPollData removes them).
Tests: clearPollData rejects → leave resolves true; every later step runs once with GROUP_ID (clearGroupMedia …
clearPendingRemovalsForGroup, destroyGroupState, deleteLeftGroupTombstone, reloadGroups, markBackupDirty); warning
/poll/. Same with non-last-member leave (deferred destroy still runs). Existing clearMessages test unchanged.

## 4. poll-pending-queues-recreated-after-purge
Empty-remove does NOT write [] (storePending 884-890 / boundedQueue.store 997-1003 del on empty). Still real via:
(a) removePendingVotes (956-966) / boundedQueue.remove (1026-1032) get-then-set race with clearPollData's purge txn
(1158-1175); (b) unchanged-list rewrite on cap reject (919, 1012); (c) queue adds from in-flight handlers after purge.
Orphan key is not TTL-bounded in practice (TTL only on read) — persists until clearAllPollData.
Fix: (1) route queuePendingVote, removePendingVotes, boundedQueue.queue, boundedQueue.remove through pollTxn inside their
existing enqueue (read in-txn → compute → put/delete). (2) no write when unchanged; delete only if a key was read.
(3) queuePendingVote restructure: cannot await keepForWrite→heldCloseCutoffs in txn; read closes key in-txn only when cap
bites, fall back to [] with warning on read failure (pattern: saveVoteIfNewer 761-769). Keep held/dominated return logic.
(4) module-level `purgedGroups: Set<string>`: clearPollData adds synchronously before creating its txn; every queue-writer
pollTxn body checks it and writes nothing (queuePendingVote resolves false); export `releasePollPurgeMark(groupId)`,
call from dropLeftGroupTombstoneAfterJoin (welcomeSubscription.ts:599); clearAllPollData clears the set. Also apply the
mark check to saveVoteIfNewer without requirePoll (771) — same bug class, one line. In-memory is sufficient (after reload
no handler for a left group runs); cross-tab not covered — document.
Tests (pollFollowups.test.ts, fake-indexeddb + txn hooks): pre-purge removal with remaining entries → no
few:poll-pending-votes:/-closes:/-close-announcements: key (each queue); post-purge add → no key, queuePendingVote false;
after releasePollPurgeMark early vote queued again; regression: early vote for live group with no polls still queued;
cap-reject / no-match remove → no write (put log); emptying remove deletes key; failure injection on each new txn step.
Risks: queuePendingVote restructure is the largest change; Map-mocked suites use callableMapStore (txn-capable).

## Gating
#5 touches MarmotContext.tsx and #4 welcomeSubscription.ts → full gate (make test-e2e-all) required.
