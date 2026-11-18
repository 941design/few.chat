# Marmot library adoption run report

The cutover checkpoint ran against strfry and the pinned Chromium browser. It passed 26 checks and stopped when an accepted member remained marked Pending. Ten checks did not run. The provider now invokes its group-join profile callback. A fresh integrated run is pending.

The next checkpoint returned 27 passed, 4 failed and 5 not run. The multi-tab case reached the waiting banner and group overlay, then expected null from a hook that is installed only after lease acquisition. Three nickname update cases kept the old value. The rerun uses waiting UI assertions before lease transfer and tests a dispatched sink row after transfer. The provider now waits for the leased session before publishing an interactive profile change and uses the live group list.

The first integrated `make test` invocation passed the Marmot TypeScript check, unused-export check and all 347 Vitest files. Vitest recorded 7,318 passing tests and one skip. The non-relay bucket passed all 72 tests. The relay bucket exposed five retained failures. It was stopped after 157 passes, 14 skips and one interrupted check, with 195 checks still unrun. The command exited 2 after Playwright was interrupted.

- Last-member abandon returned to the list while the library and application stores still held the group. Reloading at that point could bring it back. A Chromium probe read the nonempty stores immediately after navigation and confirmed that waiting for the purge before navigating made all three stores empty at that same point.
- Approved join requests acquired the Cancel Invite action because the approval used the same persisted marker as a direct invite. The marker now carries the invitation source so approvals remain eligible for decline recovery and use Remove Member before and after the profile arrives.
- Direct invite roster changes can arrive before the invite marker has been persisted. The member view needs a refresh after the recording step. The modal and profile page both had a second, obsolete marker writer that could overwrite a valid invite reference before a duplicate invite failed.
- Cancelling a pending invite removed the member and marker but omitted the existing in-chat announcement. The retained test checks for that announcement after navigating away and back.

Against a separate clean strfry relay, the unchanged abandon, direct invitation lifecycle, invitation announcements and remove-member specs passed 23 of 23 checks. Earlier focused runs also passed both approval-label scenarios, cancellation followed by another group message, and rejoining after removal with bidirectional messaging. The focused runs exercised the actual application with the pinned Chromium browser.

Decline replay now binds to the signature key of the KeyPackage accepted by the library. A persisted marker without that binding cannot evict a replacement leaf. Profiles leave already-declined markers available for replay. The store compares receipt time with the recorded invite time even when the first scan missed an invite and a second scan sees it.

The active provider at `5311488` wrote bare markers from direct invite UI and never called the reference-aware recorder. The new provider records source on join approvals and ignores legacy bare markers. Group notices now specify the mutation's group ID and validate the originating account session. Solo abandonment rechecks the roster under the app's group operation queue.

The later integrated rerun passed all 346 Vitest files with 7,311 passing tests and one skip. Both signer-import tests that timed out while the preceding run overlapped with the production build passed on the isolated rerun. The non-relay browser bucket passed all 72 tests.

An isolated browser command tried to bind the integrated runner's port. Its server failed to start, and the command connected to the wrong server. The integrated relay bucket was stopped after 70 passes and its relay data was cleared before the next run. The type checks, unit results and non-relay results preceded that collision.

A fresh focused run reproduced cancellation disappearing after navigation. The group-scoped sender now persists the local row under the same rumor ID used by the retained history sink before returning. A valid Chromium run against a fresh strfry relay then passed all 22 retained cancellation, invitation announcement and rename checks, including navigation and follow-up send.

A separate clean-relay Chromium run passed all 20 retained leave, leave-purge, re-invite, interrupted chat and profile ingest, seed phrase and seed recovery checks.

The sponsor's store now archives an owed decline notice by invite reference in the same IndexedDB transaction that records a subsequent successful invitation. Replay preserves the newer marker and leaf. Tests cover a failed notice, failed phase persistence, restart, rollback of both writes in one transaction, and sponsor-scoped wipe in a shared group.

The last focused review found that two consecutive failed phase writes could still lose the notice. Removal now waits for its initial durable phase before proceeding. All 109 focused decline checks passed after the fix. The production static build and real two-account round trip passed again with this source.

The subsequent integrated unit run stopped before Playwright. One admin-operations fixture passed Vitest's teardown context to the cleanup function as if it were a sponsor account. The fixture now calls the cleanup function explicitly. All five affected tests passed in isolation, and `make test` restarted with the same application source.

The next integrated run passed 7,322 unit tests and the 72 non-relay browser tests. Its relay bucket reproduced the cancellation failure after 108 prior successes. A roster update could remove the confirmation dialog while its notice was still saving, so the next navigation raced that work. The member list now retains an affected row until the action settles. A clean relay run passed all 20 relevant cancellation, direct invite and remove-member checks with the preserved assertions.

The integrated rerun passed the type and export checks, 7,322 unit tests and the 72 non-relay browser tests. Both cancellation cases passed in its relay bucket. The first relay failure was the active group join-request check. The inline row rendered, but there was one Groups badge when zero was expected. The run exited 2 after interrupting Playwright, with 210 passed, 14 skipped, one failed, one interrupted and 146 unrun relay checks. The app now applies the original active-view predicate before incrementing the badge and always refreshes the inline row.

Focused Chromium runs on clean relays passed the live inline request and notification checks with 10 passes and one baseline skip. A second run passed all 23 checks, including off-screen join-request badges, post-leave polling, removal and re-invitation, and same-document lease transfer. Together with the integrated abandon and ever-known results, these runs close the retained behavior checks for S24.

Independent review strengthened the two reload specs to isolate startup sweep from live history writes. The revised first run passed Accept reload and all three preview checks. It then reproduced a pending badge after a second invitation was accepted and the invitee opened the group. A follow-up diagnostic found the earlier profile in the sponsor's history and no new profile on either side after the immediate reload. Its server flagged a full refresh, so the run serves as diagnostic evidence. The app now checks for a missing own signed profile after the retained history sweep and sends it from the current lease holder. The invitee reload test cuts after the library's durable accept, checks that the app overlay is still absent, and verifies the sponsor confirms the reloaded invitee through one recovered history row.

Review found that the new recovery referenced bootstrap-local IDs from the lease-state callback. The failed initial readiness check reproduced that error. Both callbacks now use the same session-owned list. The app and Marmot test TypeScript projects pass, and Chromium passed the deterministic accept and sponsor-confirmation reload check. If the library already has the original profile queued during a reload, startup can send another signed profile through the encrypted group. The sponsor consumes the invitation marker atomically and emits one join notice for it.

The next focused run passed 18 of 19 checks, including both reload specs, all invitation previews, direct invitation lifecycle, and removal and re-invitation with sponsor confirmation and messages both ways. The only failure came from a new fixture assumption that a returning voluntary leaver would be marked Pending before accepting. The sponsor kept the earlier member profile and showed the returning member by name. The fixture now checks that the sponsor sees the roster entry and that the invitee accepts the fresh Welcome. A clean relay rerun passed all three voluntary-leave checks. A production build and the complete delivery gate were started on this revision.

The production build and Chromium round trip passed. The integrated test command stopped during Vitest with 7,321 passes, one skip and one failure. The failed real-library history test showed a follow-up send missing after queue idle. An isolated run with an explicitly delayed append tail reproduced the library's `reentrant` error inside `historyBackend`. The account queue now waits for full history and inbox callbacks to settle before scheduling its next job. A real-library test proves the queue waits for the slow append and then runs two jobs in order. Both TypeScript projects, the export guard and all 97 focused unit and harness checks passed after the fix.

Review found that a stalled history or inbox callback could delay unrelated jobs under the first fix. The queue now holds only jobs associated with the affected group or inbox scope. The timer-driven FIFO continues to run other jobs. The fake-timer test exercises overlapping callbacks, rejection and disposal. In Chromium, the preceding revision passed all 18 targeted checks, including the sender's confirmed status for the same rumor ID and the invitee's startup profile while its live history was held.

The final scoped queue passed 21 browser checks, the production build and the static two-account round trip. The following integrated test command was interrupted during the unit phase for additional acceptance fixes found in review. The latest combined unit checkpoint passed 193 checks covering atomic history marking, durable context ID retirement and owner-consent claims, plus lifecycle, NDK inbox dispatch and wipe evidence. Against clean strfry, Chromium passed 26 checks covering invitation preview, auto-accept, active-view and idle-page notification, Welcome and the resumed chat/profile history. The nine image-sharing checks were skipped by the pre-existing attachment feature flag.

A clean-relay Chromium checkpoint passed 35 tests with two baseline skips. It covered the retained invitation-link and preview flows, notification while the page is idle, chat and profile recovery, message edits and deletions, and reactions. Both atomic reload tests passed. A separate Chromium run temporarily enabled attachments and ran the retained image suite. All nine checks passed, including retry and reload. The feature flag and retained test file were restored and verified against HEAD.

The consent revision passed both TypeScript projects, the export guard and 108 focused unit and harness tests. Its clean-relay browser checkpoint passed all 27 checks, including automatic approval, the manual fallback after cancellation, simultaneous awaiting records, invitation preview and delivery while the page is idle. Independent review confirmed the account and invitation binding and identified two context durability gaps and a transient failure in deleting a successfully consumed request.

The context store now retires the IDs of capped entries and sponsor mismatches. On write failure the real inbox defers the wrap and acknowledges it only after the retry commits the dirty snapshot. All 163 targeted context tests passed, including the real Marmot harness. Auto-accept now retries a failed post-accept delete while it holds the lease. All 51 focused auto-accept tests passed, including transaction abort and persistent failure. Both TypeScript projects and the export guard passed with the combined changes. Production build, static browser proof and the canonical test command then started in order.

The final production static build exited zero. Its separate Chromium round trip passed in 6.1 seconds against strfry. Both accounts sent and received an encrypted group message exactly once, and the production export exposed no development hook. The canonical test command proceeded to Vitest.

Vitest passed 7,360 tests, skipped one and failed three structural assertions before Playwright started. The kind registry's mocked import seam had moved the retired literal outside its expected declaration and introduced a dependency-free data file that the boundary check did not recognize. The retired kinds now live in `kinds.ts` again. The boundary check explicitly recognizes the data-only sibling within the same registry seam and still rejects all other modules outside the client. A fresh build, static proof and canonical gate follow the focused registry checks.

The registry, client import-boundary and retired-kind checks passed all 36 focused tests. The fresh production build and static round trip passed, with the Chromium proof finishing in 9.2 seconds. The canonical run exited zero. All 346 Vitest files passed with 7,363 passing tests and one skip. The non-relay Chromium bucket passed all 72 cases in 5.7 minutes. The clean strfry relay bucket passed 353 cases and skipped 19, with no failures or invalid runs. The full browser gate therefore accounted for all 444 discovered cases. Independent story review accepted the ADR, counts, documentation coverage and static runtime proof after the exact gate exited zero.

## Retired unit suites

These suites targeted the retired app protocol or storage mechanisms. The listed decisions identify the replacement coverage.

D1 and D10. The client owns transport and key-package lifecycle, and the new client and lookup suites test the replacement.

- `app/tests/unit/keyPackages.test.ts`
- `app/tests/unit/keyPackagesRelayCheckWiring.test.ts`
- `app/tests/unit/inviteLookupWiring.test.ts`
- `app/tests/unit/marmot/NdkNetworkAdapter.test.ts`
- `app/tests/unit/marmot/inviteeKeyPackageLookup.test.ts`
- `app/tests/unit/marmot/relayRequest.test.ts`

D6 and D13. The accepted history sink and retained-row suites replace the dispatcher journal and epoch replay mechanism.

- `app/tests/unit/marmot/applicationDispatchPersistence.test.ts`
- `app/tests/unit/marmot/applicationRumorDispatcher.journal.test.ts`
- `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`
- `app/tests/unit/marmot/epochResolver.journalOrdering.test.ts`
- `app/tests/unit/marmot/epochResolver.test.ts`
- `app/tests/unit/marmot/order-sensitive-ingest.property.test.ts`
- `app/tests/unit/marmot/reactionEditStorageFailureReplay.test.ts`
- `app/tests/unit/marmot/replaceTeardown.test.ts`
- `app/tests/unit/marmot/replaceTrackedWiring.test.ts`
- `app/tests/unit/marmot/rumorJournal.integration.test.ts`
- `app/tests/unit/marmot/rumorJournal.putRumor.test.ts`
- `app/tests/unit/marmot/rumorJournal.realIdb.test.ts`
- `app/tests/unit/marmot/rumorJournal.test.ts`
- `app/tests/unit/marmot/senderLeafIdentity.test.ts`
- `app/tests/unit/marmot/staleReplaceMarker.test.ts`
- `app/tests/unit/marmot/subscriptionSelection.test.ts`
- `app/tests/unit/marmot/registerHandlers.test.ts`

D9 and D16. Real group membership operations, roster eligibility and group purge supersede the old helpers and pending-removal stores.

- `app/tests/unit/leaveEligibility.test.ts`
- `app/tests/unit/marmot/autoCommitLeave.test.ts`
- `app/tests/unit/marmot/cancelInvitationImpl.test.ts`
- `app/tests/unit/marmot/grantAdminImpl.test.ts`
- `app/tests/unit/marmot/groupStorage.clearAllGroupData.test.ts`
- `app/tests/unit/marmot/leaveGroupImpl.test.ts`
- `app/tests/unit/marmot/leaveGroupImplAdminRecheck.test.ts`
- `app/tests/unit/marmot/leaveHandler.test.ts`
- `app/tests/unit/marmot/leaveJournalReplay.test.ts`
- `app/tests/unit/marmot/leaveSync.test.ts`
- `app/tests/unit/marmot/leftGroupStatePurge.test.ts`
- `app/tests/unit/marmot/membersChangedSync.test.ts`
- `app/tests/unit/marmot/pendingRemovalStorage.test.ts`
- `app/tests/unit/marmot/renameGroupImpl.test.ts`

D3, D7, D8 and D14. Tests for manual Welcome decoding, local pending storage, raw inbox send or old stale-group replacement yield to the invitation, join-request and decline harnesses.

- `app/tests/unit/pendingInvitations.test.ts`
- `app/tests/unit/marmot/crossCuttingDeclineConvergence.test.ts`
- `app/tests/unit/marmot/inviteAcceptIdempotentJoin.test.ts`
- `app/tests/unit/marmot/joinRequestSender.test.ts`
- `app/tests/unit/marmot/readPreJoinGroupData.nullPath.test.ts`
- `app/tests/unit/marmot/readPreJoinGroupData.realMarmot.test.ts`
- `app/tests/unit/marmot/readPreJoinGroupName.realMarmot.test.ts`
- `app/tests/unit/marmot/welcomeSubscription.test.ts`
- `app/tests/unit/marmot/welcomeSubscriptionAutoAccept.test.ts`
- `app/tests/unit/pages/profile-add-to-group-marker.test.ts`

D7. The unshipped pairing digest has no production consumer. Pairing admission and DM notifications retain their behavioral suites.

- `app/tests/unit/marmot/admissionDigest.test.ts`

D1 and AC-MEDIA-1. The library encrypted-media codec replaces the retired imeta format. The group codec and image service suites cover the new wire format.

- `app/tests/unit/media/imetaTag.test.ts`

## Adapted unit coverage

D4 retires group chat, poll and reaction cross-tab notifications. DM cross-tab delivery remains covered. D6 and D13 move duplicate delivery assertions to the retained history sink and group handler suites. Media integration covers the library codec and retains the direct-message cache and decryption tests.

The retired stale-replace marker assertion in `storage.test.ts` followed D8. No legacy storage cleanup ships. The group-message and profile-request suites retain handler assertions, with delivery deduplication exercised through the real history sink instead of the removed dispatcher cache. The poll purge-mark source scan now follows the shared attachment path, and the inbox source scan no longer exempts the removed Welcome subscription.

D7 retires the modal and profile-page writes of bare markers. The shared inviter records the reference after the library commits. The retained direct-invite browser tests exercise both UI paths, and the decline store, unit and library-backed suites cover reference persistence, failed writes and stale declines. The invitation announcement tests continue to cover the modal's success and error paths.

## Retained browser coverage

Compared the literal Playwright test titles against `pre-marmot-library-adoption` using the TypeScript AST. All kept titles matched. All eleven designated rewrites changed. The sole removed baseline spec is `groups-blackout-guard.spec.ts`, and `groups-multi-tab.spec.ts` was added. The temporary smoke spec was removed separately. Playwright discovers 72 tests in 17 non-relay files and 372 tests in 79 relay files.

On an intermediate revision, `NEXT_PUBLIC_RELAYS=ws://localhost:7777 make build` passed and a one-off Playwright test served `app/out` with Python's static HTTP server. Two isolated browser contexts used freshly generated local identities, created a group, sent and explicitly accepted the invitation, and delivered one message in each direction. Each sender and recipient rendered exactly one copy, and the production page had no `__fewTest` object. The final run repeated the build and static check after the runtime fixes.

The later static build and two-account round trip also passed after the lease, profile and poll remediations. A focused browser checkpoint confirmed same-document lease handoff with a dispatched row, profile propagation, and the interrupted chat and profile deliveries recovering to one retained row. Its recovery test surfaced a truncated npub fixture. The rewritten recovery specs now derive the full npub from the actual stored pubkey and assert the restored pubkey separately from its display label.

An independent static browser fixture seeded an unowned pre-adoption overlay alongside a real library group. After reload, the stale IndexedDB row was absent and the live row and card remained intact. The kept group-member DM checks passed against strfry, including receipt by the real NDK listener and a Contacts unread increment.

The recovery checkpoint passed against the pinned Chromium browser and strfry. It decrypted a newer post-join backup and verified its settings/profile payload, restored into a fresh context, found an empty group list, removed the old seat and rejoined through a new invitation. This and the earlier targeted tests are development checkpoints. The full delivery gate runs both discovery buckets.

## Behaviour outside the current documentation index

- Group image attachment locators must use a public HTTPS Blossom host. The browser E2E runner uses an HTTPS proxy for its local Blossom mock. An HTTP-only local Blossom will fail for group image sends.
- A group store with an incompatible library envelope can be wiped once per page. Group-local app data is cleared after the library transaction, with unfinished cleanup completed before the next client starts. DM and profile data remain on the device for this targeted recovery.
- Existing NIP-46 sessions that lack the current permission set require reconnection. The set includes Blossom upload authorization and call signaling, in addition to the Marmot kinds.
- Fork withdrawal can restore an earlier poll, reaction, edit or deletion result. The topic-specific behaviour pages were outside this epic's documentation scope.

## Remaining acceptance questions

The original deferred decisions are recorded in `epic-state.json`. One acceptance wording conflict surfaced during the resumed work. If the process stops after a decline announcement reaches the relay and before the local marker clears, recovery can publish a second encrypted carrier for the same announcement. Receivers now store one logical decline row per authenticated sponsor and decline ID, with both carriers tracked for retraction. The implementation therefore provides one visible announcement, while AC-OBS-4 literally calls for one network send.

The independent adversarial review traced the later AC-DECL-1 amendment to `dd0a45d`. It explicitly permits resending with the same ID in that crash window. The property suite exercises one send during ordinary operation and a stable ID across post-send recovery. The separate retained-row tests exercise receiver deduplication.

The pinned client exposes `welcomeDeclined` after its durable transition, with one notification per delivery. Its public API lacks read-only access to those declined delivery records for startup recovery. An interruption before the observer records the decline can therefore lose the app-side removal. The public removal API also accepts an account, while device signing keys can recur across distinct admissions made with fresh KeyPackages. Binding a marker to the selected KeyPackage's signing key narrows what the app can remove, and the app refuses to remove an unbound or ambiguous leaf. The client still needs an admission-specific conditional removal to enforce the full guarantee at commit time.

- AC-MEM-5 requires the group UI to learn that a group is fenced. The pinned public notification union exposes disbanding but has no fence notification. Current send errors reach the affected message row.
- AC-CTX-3 calls for global oldest-first eviction of held contexts. The accepted S10 implementation uses trust rank, then age, to preserve trusted contexts under pressure. The application retains that policy.
- AC-WDR-7 and AC-WDR-9 still require production-state equality for arbitrary retractions that interact through shared pending edit and reaction limits. Atomic withdrawal markers and deterministic replay of the affected aggregate have separate passing coverage.
- The state ledger records the remaining lifecycle, producer and storage assertions individually. In particular, a legacy join request without owner metadata cannot be attributed during a wipe where another account shares the same group.

## Mutation audit

Stryker completed against all seven required modules at concurrency 1. The scratch Vitest config ran 216 directly related tests, and the scratch JSON reporter wrote outside the repository. `app/reports` stayed unchanged. The first broad dry run passed 4,772 tests before it was replaced with the focused run.

| Module | Killed | Timed out | Survived | No coverage |
| --- | ---: | ---: | ---: | ---: |
| `client/signerAdapter.ts` | 33 | 0 | 2 | 4 |
| `history/historyBackend.ts` | 290 | 1 | 114 | 51 |
| `invitations/inviteContextHandler.ts` | 42 | 0 | 9 | 2 |
| `invitations/keyPackageLookup.ts` | 157 | 0 | 22 | 6 |
| `kinds.ts` | 17 | 0 | 16 | 0 |
| `membership/leaveEligibility.ts` | 89 | 0 | 7 | 0 |
| `send/sendGroupRumor.ts` | 106 | 1 | 67 | 39 |
| Total | 734 | 2 | 237 | 102 |

The audit snapshot predates the later export-only changes to the audited modules. The untimed survivors are recorded below without claiming equivalence. Locations identify the audited snapshot.

### `client/signerAdapter.ts`

Survived

```text
15@65:21 ConditionalExpression
32@77:7 ConditionalExpression
```

NoCoverage

```text
33@77:37 BlockStatement
34@78:12 ObjectLiteral
35@78:22 StringLiteral
36@78:45 StringLiteral
```


### `history/historyBackend.ts`

Survived

```text
44@255:17 StringLiteral
47@266:30 ObjectLiteral
59@301:28 BlockStatement
60@302:13 ConditionalExpression
61@302:13 ConditionalExpression
62@302:13 EqualityOperator
72@314:20 ConditionalExpression
88@329:5 ConditionalExpression
89@329:5 LogicalOperator
90@329:5 ConditionalExpression
91@329:5 LogicalOperator
92@329:5 ConditionalExpression
93@329:5 LogicalOperator
94@329:5 ConditionalExpression
95@329:5 LogicalOperator
96@329:5 ConditionalExpression
97@329:5 LogicalOperator
98@329:5 ConditionalExpression
99@329:5 LogicalOperator
101@330:5 ConditionalExpression
104@331:5 ConditionalExpression
106@331:23 StringLiteral
107@332:5 ConditionalExpression
110@333:5 ConditionalExpression
112@333:23 StringLiteral
114@335:5 ConditionalExpression
116@335:12 OptionalChaining
132@349:51 LogicalOperator
133@349:69 ArithmeticOperator
138@359:9 ConditionalExpression
142@362:10 ConditionalExpression
143@362:10 ConditionalExpression
144@362:10 EqualityOperator
145@362:21 StringLiteral
148@366:36 OptionalChaining
149@367:7 ConditionalExpression
150@367:7 ConditionalExpression
151@367:7 LogicalOperator
152@367:7 ConditionalExpression
153@367:7 EqualityOperator
154@367:46 BooleanLiteral
161@393:25 ArrowFunction
177@410:11 ConditionalExpression
181@413:11 ConditionalExpression
190@425:18 BlockStatement
194@433:13 ConditionalExpression
199@435:13 LogicalOperator
200@435:13 ConditionalExpression
213@452:9 ConditionalExpression
215@454:26 BlockStatement
219@467:34 ConditionalExpression
222@474:12 ArrowFunction
232@494:20 MethodExpression
239@496:13 ArrowFunction
240@496:23 ArithmeticOperator
242@497:9 ConditionalExpression
244@497:30 BlockStatement
245@498:11 ConditionalExpression
246@498:11 ConditionalExpression
247@498:11 EqualityOperator
252@505:13 ConditionalExpression
253@505:13 LogicalOperator
256@509:23 StringLiteral
269@522:9 ConditionalExpression
270@522:9 ConditionalExpression
271@522:9 EqualityOperator
281@536:15 ConditionalExpression
283@538:27 StringLiteral
288@540:19 ConditionalExpression
290@544:27 BlockStatement
291@550:14 ArrowFunction
301@565:80 ConditionalExpression
330@604:9 ConditionalExpression
331@604:9 ConditionalExpression
332@604:9 MethodExpression
333@604:18 ArrowFunction
334@604:27 ConditionalExpression
335@604:27 ConditionalExpression
336@604:27 LogicalOperator
337@604:46 BooleanLiteral
338@604:47 OptionalChaining
361@617:23 StringLiteral
367@621:13 ConditionalExpression
370@630:9 ConditionalExpression
371@631:9 ConditionalExpression
372@631:9 ConditionalExpression
387@645:9 ConditionalExpression
390@646:9 ConditionalExpression
391@646:35 BlockStatement
401@659:11 ConditionalExpression
407@662:11 ConditionalExpression
414@668:11 ConditionalExpression
419@675:13 ConditionalExpression
420@680:13 ConditionalExpression
421@680:13 ConditionalExpression
422@680:13 LogicalOperator
429@688:24 StringLiteral
433@693:11 ConditionalExpression
436@695:13 ConditionalExpression
438@700:23 StringLiteral
441@704:87 StringLiteral
446@713:14 MethodExpression
452@717:11 ConditionalExpression
455@719:13 ConditionalExpression
456@720:24 StringLiteral
457@721:22 MethodExpression
461@722:13 ConditionalExpression
463@722:13 EqualityOperator
466@725:37 StringLiteral
467@728:24 StringLiteral
473@737:20 ArrowFunction
493@760:40 BlockStatement
494@763:15 ArrowFunction
134@351:21 ArrowFunction
```

NoCoverage

```text
52@274:21 BlockStatement
135@351:57 ObjectLiteral
158@372:69 BlockStatement
159@373:20 StringLiteral
182@416:27 BlockStatement
183@417:11 BooleanLiteral
184@417:11 ConditionalExpression
185@417:11 ConditionalExpression
223@474:19 AssignmentOperator
224@474:59 ArrowFunction
225@474:69 MethodExpression
226@474:81 ArrowFunction
227@474:88 ConditionalExpression
228@474:88 ConditionalExpression
229@474:88 LogicalOperator
230@474:104 BooleanLiteral
255@505:44 BlockStatement
320@580:26 BlockStatement
339@604:82 BlockStatement
340@605:11 BlockStatement
341@607:23 BlockStatement
342@608:9 AssignmentOperator
343@609:13 ConditionalExpression
344@609:13 ConditionalExpression
345@610:23 ObjectLiteral
346@610:43 StringLiteral
374@631:32 BlockStatement
375@635:11 ConditionalExpression
376@635:11 ConditionalExpression
377@637:11 ConditionalExpression
378@637:11 ConditionalExpression
379@637:11 OptionalChaining
380@637:50 StringLiteral
423@680:56 BlockStatement
424@681:15 BlockStatement
425@683:27 BlockStatement
426@684:17 ConditionalExpression
427@684:17 ConditionalExpression
428@685:27 ObjectLiteral
476@742:33 BlockStatement
477@743:11 ConditionalExpression
478@743:11 ConditionalExpression
479@744:46 BlockStatement
480@745:13 ConditionalExpression
481@745:13 ConditionalExpression
482@746:24 StringLiteral
483@746:57 ArrowFunction
484@746:72 ArrowFunction
485@746:78 ConditionalExpression
486@746:78 ConditionalExpression
487@746:78 LogicalOperator
```


### `invitations/inviteContextHandler.ts`

Survived

```text
502@35:7 ConditionalExpression
503@35:34 StringLiteral
513@37:14 OptionalChaining
517@39:36 ArrowFunction
523@43:20 ConditionalExpression
527@43:55 MethodExpression
540@47:21 ConditionalExpression
495@32:24 Regex
496@32:24 Regex
```

NoCoverage

```text
518@39:66 StringLiteral
528@43:84 StringLiteral
```


### `invitations/keyPackageLookup.ts`

Survived

```text
563@84:12 EqualityOperator
566@84:31 ConditionalExpression
567@84:31 ConditionalExpression
568@84:31 EqualityOperator
569@84:31 EqualityOperator
573@93:7 ConditionalExpression
574@93:7 LogicalOperator
576@93:16 ConditionalExpression
579@93:62 StringLiteral
638@110:5 ConditionalExpression
645@113:5 ConditionalExpression
648@115:5 ConditionalExpression
683@153:30 OptionalChaining
687@155:11 ConditionalExpression
703@170:66 ArrayDeclaration
704@170:122 ArrayDeclaration
710@175:11 ConditionalExpression
714@175:82 StringLiteral
721@183:55 OptionalChaining
728@184:64 OptionalChaining
549@55:15 Regex
550@55:15 Regex
```

NoCoverage

```text
570@88:72 BlockStatement
591@97:90 ArrayDeclaration
657@121:13 BlockStatement
658@122:14 BooleanLiteral
684@153:58 ArrayDeclaration
722@183:83 ArrayDeclaration
```


### `kinds.ts`

Survived

```text
745@58:82 StringLiteral
754@63:68 StringLiteral
763@68:69 StringLiteral
736@54:9 ConditionalExpression
738@57:7 ConditionalExpression
740@57:7 EqualityOperator
741@57:7 EqualityOperator
746@61:23 MethodExpression
748@62:7 ConditionalExpression
750@62:7 EqualityOperator
751@62:7 EqualityOperator
755@66:24 MethodExpression
757@67:7 ConditionalExpression
759@67:7 EqualityOperator
760@67:7 EqualityOperator
764@73:76 BlockStatement
```


### `membership/leaveEligibility.ts`

Survived

```text
767@56:40 MethodExpression
772@59:34 MethodExpression
781@68:9 ConditionalExpression
782@68:9 LogicalOperator
784@68:19 ConditionalExpression
788@72:13 BlockStatement
857@125:11 BlockStatement
```


### `send/sendGroupRumor.ts`

Survived

```text
868@102:10 ConditionalExpression
871@102:43 ConditionalExpression
872@102:43 LogicalOperator
873@102:43 ConditionalExpression
874@102:43 EqualityOperator
879@107:51 StringLiteral
887@108:34 EqualityOperator
890@108:46 EqualityOperator
892@108:80 StringLiteral
897@109:56 StringLiteral
915@111:25 StringLiteral
920@113:39 ConditionalExpression
921@113:39 EqualityOperator
923@113:74 StringLiteral
932@119:7 ConditionalExpression
933@119:7 LogicalOperator
935@119:19 ConditionalExpression
940@120:25 StringLiteral
951@127:45 ArrowFunction
961@140:32 BooleanLiteral
962@141:97 BlockStatement
963@142:9 ConditionalExpression
964@142:9 ConditionalExpression
965@142:9 EqualityOperator
966@142:41 StringLiteral
974@149:9 BlockStatement
975@150:14 MethodExpression
976@150:52 ArrowFunction
982@156:129 BlockStatement
983@157:42 ArrayDeclaration
984@158:9 ConditionalExpression
985@158:9 ConditionalExpression
986@158:9 LogicalOperator
987@158:9 BooleanLiteral
988@158:15 BooleanLiteral
989@159:33 ArrowFunction
990@161:19 MethodExpression
991@161:32 ArrowFunction
998@162:12 ConditionalExpression
999@162:12 ConditionalExpression
1000@162:12 EqualityOperator
1006@176:20 ConditionalExpression
1007@176:20 ConditionalExpression
1008@176:20 LogicalOperator
1009@176:20 ConditionalExpression
1010@176:20 EqualityOperator
1011@176:35 StringLiteral
1012@176:47 ConditionalExpression
1013@176:47 EqualityOperator
1014@179:22 ConditionalExpression
1015@179:22 ConditionalExpression
1016@179:22 EqualityOperator
1017@179:31 StringLiteral
1019@180:11 ConditionalExpression
1022@180:29 StringLiteral
1026@189:9 ConditionalExpression
1029@193:9 ConditionalExpression
1031@193:33 StringLiteral
1035@199:12 BlockStatement
1041@206:9 ConditionalExpression
1042@206:9 LogicalOperator
1044@206:19 ConditionalExpression
1050@206:105 StringLiteral
1057@218:11 ConditionalExpression
1060@218:11 OptionalChaining
862@91:15 Regex
863@91:15 Regex
```

NoCoverage

```text
952@127:62 ArithmeticOperator
953@132:56 BlockStatement
954@134:9 BooleanLiteral
955@134:9 ConditionalExpression
956@134:9 ConditionalExpression
957@136:9 ConditionalExpression
958@136:9 ConditionalExpression
959@136:9 EqualityOperator
960@136:9 EqualityOperator
967@142:53 BlockStatement
968@143:11 BooleanLiteral
969@143:11 ConditionalExpression
970@143:11 ConditionalExpression
971@143:36 BlockStatement
972@144:34 BooleanLiteral
973@145:22 StringLiteral
977@150:59 ConditionalExpression
978@150:59 ConditionalExpression
979@150:59 EqualityOperator
980@150:70 StringLiteral
981@151:13 BlockStatement
992@161:39 ConditionalExpression
993@161:39 ConditionalExpression
994@161:39 LogicalOperator
995@161:39 BooleanLiteral
996@161:65 BooleanLiteral
997@161:66 OptionalChaining
1023@180:39 BlockStatement
1027@189:17 BlockStatement
1032@193:45 BlockStatement
1033@196:9 ArrowFunction
1034@197:9 ArrowFunction
1062@219:63 UpdateOperator
1069@236:38 BlockStatement
1070@239:11 BooleanLiteral
1071@239:11 ConditionalExpression
1072@239:11 ConditionalExpression
1073@239:35 StringLiteral
1074@242:31 BlockStatement
```

### Supplemental withdrawal and registry mutation audit

A second scratch Stryker run with concurrency one covered the revised history withdrawal ranges and kind registry. The initial run passed 128 tests. Of 92 mutants, 58 were killed, one timed out, 32 survived and one had no coverage. The table records every surviving and uncovered mutant.

| Module | Mutant | Location | Mutation | Outcome |
| --- | --- | --- | --- | --- |
| `historyBackend.ts` | 1 | 508:13 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 2 | 508:13 | `LogicalOperator` | Survived |
| `historyBackend.ts` | 4 | 508:44 | `BlockStatement` | NoCoverage |
| `historyBackend.ts` | 5 | 512:23 | `StringLiteral` | Survived |
| `historyBackend.ts` | 29 | 540:15 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 31 | 542:27 | `StringLiteral` | Survived |
| `historyBackend.ts` | 35 | 544:33 | `ArrowFunction` | Survived |
| `historyBackend.ts` | 37 | 544:39 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 38 | 544:39 | `LogicalOperator` | Survived |
| `historyBackend.ts` | 40 | 545:19 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 43 | 688:11 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 46 | 690:13 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 48 | 692:38 | `StringLiteral` | Survived |
| `historyBackend.ts` | 50 | 693:47 | `ArrowFunction` | Survived |
| `historyBackend.ts` | 51 | 694:37 | `BlockStatement` | Survived |
| `historyBackend.ts` | 53 | 699:13 | `ConditionalExpression` | Survived |
| `historyBackend.ts` | 58 | 705:90 | `StringLiteral` | Survived |
| `kinds.ts` | 62 | 38:9 | `ConditionalExpression` | Survived |
| `kinds.ts` | 64 | 41:7 | `ConditionalExpression` | Survived |
| `kinds.ts` | 66 | 41:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 67 | 41:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 71 | 42:82 | `StringLiteral` | Survived |
| `kinds.ts` | 72 | 45:23 | `MethodExpression` | Survived |
| `kinds.ts` | 74 | 46:7 | `ConditionalExpression` | Survived |
| `kinds.ts` | 76 | 46:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 77 | 46:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 80 | 47:68 | `StringLiteral` | Survived |
| `kinds.ts` | 81 | 50:24 | `MethodExpression` | Survived |
| `kinds.ts` | 83 | 51:7 | `ConditionalExpression` | Survived |
| `kinds.ts` | 85 | 51:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 86 | 51:7 | `EqualityOperator` | Survived |
| `kinds.ts` | 89 | 52:69 | `StringLiteral` | Survived |
| `kinds.ts` | 90 | 57:76 | `BlockStatement` | Survived |
