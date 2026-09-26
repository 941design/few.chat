**few-chat / quizzl — implementation handover from the 2026-09-26 project review**

Review baseline: commit `9eef568`, plus the working tree that existed during the review. This is a continuation plan, not an implementation-completion report. The review changed no production code. The handover adds only this document and its evidence directory. No commit, deployment, backlog promotion, or feature implementation has been performed as part of this handover.

The first ten tasks preserve all findings from the review. Later tasks capture verification blockers, lower-priority observations, and investigation candidates. **An investigation candidate is not a confirmed production defect.** Priority measures implementation urgency; it is separate from evidence strength. P1 = high-priority correctness/privacy risk; P2 = normal-priority defect or required verification; P3 = maintenance or optional improvement. Escalate a candidate's priority if reproduction establishes a more serious impact.

**How to resume**

1. Read root `CLAUDE.md`, current applicable `AGENTS.md` files if present, and this document. Recheck `git status` and current code: line numbers below describe the review baseline and may drift.
2. Preserve existing work. At review start, `.clauded.yaml` and `.serena/project.yml` were modified. These were untracked: `app/bug-reports/`, `app/tests/e2e/groups-pending-invite-live-idle.spec.ts`, `few.png`, `fews.png`, and `specs/marmot-ts-0.7.0-forward-migration-spec-request.md`. Do not overwrite, delete, commit wholesale, or assume ownership of them.
3. Start with R10 and R11 to restore usable verification. While infrastructure is blocked, R01/R05 and identity design for R02/R03/R04 have useful independent work. Do not defer P1 fixes behind optional maintenance work.
4. Treat R01/R05/R15/R16 as one ingestion-lifecycle design area and R02/R03/R04 as one account/signer design area. Give each task its own acceptance evidence even when a shared change fixes several.
5. Port the relevant review probes into proper regression tests, then implement and validate. The archived probe file is a diagnostic starting point, not a finished test suite.
6. Update the task ledger and completion record after each task. Leave unresolved tasks visible. At session end, append a continuation entry with the exact branch/commit, changed files, verification, blockers, and next action.

**State and sign-off convention**

The ledger is the authoritative task state. Use `planned`, `in_progress`, `needs_investigation`, `blocked`, `done`, `deferred`, or `not_reproduced`. `done` requires checked acceptance items, a recorded implementation reference, applicable documentation updates, and verification evidence. A passing subset does not establish a full E2E pass. Use `blocked` only with the actual blocker and the next action recorded. Use `deferred` only with an explicit rationale and owner/decision source; do not silently drop tasks. For `not_reproduced`, record the scenario, environment, and evidence that contradicts the hypothesis. Reopen tasks if new evidence invalidates sign-off.

In the ledger's last column, replace `—` with `owner; date; commit/PR or working-tree reference; completion-record link`. A task can be implemented while still awaiting required verification; keep it `in_progress` or `blocked` rather than marking it done prematurely.

| ID | Priority | Task | State | Evidence at handover | Owner / sign-off |
|---|---|---|---|---|---|
| R00 | — | Preserve review baseline and evidence | done | Review artifacts archived; source unchanged | Codex; 2026-09-26; this handover |
| R01 | P1 | Attach group handlers before historical ingestion | planned | Production code and installed-library trace | — |
| R02 | P1 | Make external identity authoritative across activation/reload | planned | Production lifecycle trace | — |
| R03 | P1 | Isolate private state when changing accounts | planned | Storage/restore/backup trace | — |
| R04 | P1 | Preserve selected signer and remove local-key bypasses | planned | Rebinding probe plus call-path trace | — |
| R05 | P2 | Serialize application dispatch across messages | planned | Focused failing reproduction | — |
| R06 | P2 | Scope poll votes to their group | planned | Focused failing reproduction | — |
| R07 | P2 | Make vote replacement deterministic by revision | planned | Focused failing reproduction | — |
| R08 | P2 | Make profile mutations atomic | planned | Focused failing reproduction | — |
| R09 | P2 | Honor persisted relays when creating NDK | planned | Real-NDK initialization probe | — |
| R10 | P2 | Fix ambiguous update-banner browser assertion | planned | Existing E2E test failed | — |
| R11 | P2 | Unblock and complete the full browser gate | blocked | Host port 3001 occupied during review | — |
| R12 | P2 | Close integration-test blind spots | planned | Test helpers/mocks inspected | — |
| R13 | P2 | Investigate response-body timeout coverage | needs_investigation | Timeout ends before body consumption | — |
| R14 | P3 | Prevent install stamps after failed setup | done | Isolated failure/retry tests pass | Codex; 2026-09-26; Makefile + scripts/test-install-stamps.py; [record](#r14-completion) |
| R15 | P2 | Investigate late subscriptions after effect cleanup | needs_investigation | Async setup lacks cancellation generation | — |
| R16 | P2 | Investigate recovery after incomplete historical sync | needs_investigation | Timeout path and sync markers inspected | — |
| R17 | P2 | Investigate backup failure propagation and retries | needs_investigation | Publish result ignored by scheduler callback | — |
| R18 | P3 | Correct stale onboarding/test/protocol documentation | planned | README, Makefile, comments inspected | — |
| R19 | P3 | Measure and reduce initial JavaScript cost | needs_investigation | Build reports ~613 kB shared first-load JS | — |
| R20 | P3 | Evaluate automated verification for changes | needs_investigation | No CI workflow found in inspected tree | — |
| R21 | P2 | Revalidate the existing idle invitation-update report | needs_investigation | Pre-existing user report and untracked E2E | — |
| R22 | P2 | Complete final integration review and handoff | planned | Depends on required fixes and verification | — |

**Baseline and evidence inventory**

Evidence is durable under [2026-09-26-project-review-evidence](2026-09-26-project-review-evidence/README.md); the new context must not depend on `/tmp`.

| Run | Observed result | Evidence |
|---|---|---|
| `make test-unit` before probes | 224 files passed; 4,405 tests passed; one skipped | [unit.log](2026-09-26-project-review-evidence/unit.log) |
| `make build` | Passed type checking and static export; 12 pages; ~613 kB shared first-load JS | [build.log](2026-09-26-project-review-evidence/build.log) |
| Temporary review probes | Six assertions failed on the intended behaviors; existing 224 files still passed | [probes.log](2026-09-26-project-review-evidence/probes.log) |
| `make test-e2e-all` | Non-relay bucket: 70 passed, one failed; aggregate stopped there | [e2e.log](2026-09-26-project-review-evidence/e2e.log) |
| Separate `make test-e2e` | Browser tests never started: Docker could not bind host port 3001 | [relay-e2e.log](2026-09-26-project-review-evidence/relay-e2e.log) |

The initial sandbox denied local port binding and Docker access; the relevant commands were rerun with escalation. The final relay blocker was a real port conflict, not evidence of an application failure. Test fixtures started by the review were stopped. The existing listener on 3001 was not terminated or replaced. Reinspect ports/container state before resuming; do not assume the old blocker still exists.

The six [archived probes](2026-09-26-project-review-evidence/regression-probes.test.ts.txt) map to R06, R07, R08, R05, R09, and R04 in source order. They use fake IndexedDB with real persistence/handler code. The dispatcher probe substitutes byte deserialization but uses ordinary synchronous EventEmitter delivery. The NDK override probe uses two synthetic local signer objects to reproduce overriding an installed signer; it is not a live bunker test. An initial test-double error was corrected before the archived final run. The probes have convenience setup/order dependencies and incomplete cleanup on assertion failures: make fixtures independent and add `afterEach` cleanup when promoting them. Do not simply copy the diagnostic file into CI unchanged.

**Constraints the implementation must preserve**

- Profiles must never be publicly published as kind-0 metadata. Preserve the existing targeted encrypted profile channels and documented encrypted self-backup behavior. Sender-authentication fixes must not replace authenticated identities with claimed rumor keys.
- Read [ADR-012](../adr/ADR-012-implement-spec-mandated-sender-binding-in-fork-plus-signed-enum-meta-events.md) before changing the protocol boundary. `@internet-privacy/marmot-ts` and `ts-mls` are pinned forks; do not substitute registry packages or drop sender binding to make tests pass.
- This is a Next.js static export on Cloudflare Pages. Client-specific routes use query parameters; do not add unexportable dynamic path segments.
- Run development, build, and tests through `make` so the platform dependency check runs. Avoid concurrent build/dev/E2E runs that write the same `.next` directory.
- The definitive E2E gate is `make test-e2e-all` or `make test` (unit + full E2E). A filtered run or fast bucket is a development check only.
- Relay E2E events must be produced through app helpers/peer browser contexts, except the documented narrow exception for events the app cannot produce. Do not replace an app integration test with hand-signed raw WebSocket traffic.
- Translate new user-visible strings in both English and German. Update affected `docs/behavior/` topics when behavior changes, and keep its index current. Read `docs/design-rationales.md` before UI changes.
- Same-account recovery intentionally preserves local data absent from the backup. R03 must isolate accounts without turning ordinary recovery into a blanket destructive reset. Storage migrations must preserve existing data or explicitly quarantine ambiguous records.
- Pending user work and existing specs may overlap this plan. Reconcile using current code and evidence; the untracked migration request is not proof that the migration remains unimplemented.

**Suggested implementation sequence**

| Order | Work package | Dependencies / reason |
|---|---|---|
| 1 | R10, R11; preserve/port relevant R12 probes | Restore reliable verification without delaying independent P1 work |
| 2 | R01 + R05; investigate R15/R16 while designing lifecycle | Ensure handlers exist, ordered work drains, and cleanup owns late results |
| 3 | Design R02/R03/R04 together; implement as reviewable increments | Identity, signer authority, storage ownership, and backup must agree |
| 4 | R06 + R07 + R08, then R09 | Apply account namespace decisions; group scoping and atomicity remain separate requirements |
| 5 | R13/R17 investigations, R21 existing report, R14 setup fix | Convert reproduced candidates into bounded fixes; preserve evidence for non-reproductions |
| 6 | R18; measured/explicit decisions for R19/R20 | Maintenance should follow correctness work |
| 7 | R22 | Full integration gate and complete sign-off ledger |

R06/R07/R08 can be developed before account namespacing if their APIs anticipate it. R09 can be handled independently, but coordinate `ndkClient.ts` changes with R04. This sequence does not authorize parallel agents or require a single large PR.

**R01 — install application handlers before historical ingestion (P1)**

Source map: `app/src/context/MarmotContext.tsx`, `subscribeNewGroups()` around lines 1534–1868; historical subscription awaited at 1589; dispatcher attached at 1827. `app/src/lib/marmot/welcomeSubscription.ts`, historical ingestion loop around 1253. Installed marmot-ts `MarmotGroup` emits `authenticatedApplicationMessage` synchronously during ingestion. The configured resolver has no alternative application-message consumer, and no library history factory is configured here.

Failure: reopening after a peer sent messages offline can decrypt/consume those events before chat, poll, profile, reaction, and edit/delete handlers exist. The module-level processed-ID set suppresses their replay in the same session. The exact extent of durable historical loss across restarts needs a real MLS test; do not promise recovery of already-consumed events without evidence.

Implementation: construct and attach the dispatcher before any historical ingestion or live delivery; define joint ownership and cleanup of transport and dispatcher. Coordinate the history-completion barrier with R05. Handle setup failure without leaking the already-attached listener. Preserve MLS epoch ordering and authentication.

- [ ] Real two-peer flow: A is offline, B sends, A reopens, and the messages persist and display exactly once.
- [ ] Exercise at least one dependent non-chat flow (poll open/vote or edit/delete) across offline recovery; cover other handler registration with integration tests.
- [ ] Historical/live overlap deduplicates without dropping the first application delivery.
- [ ] Failure/teardown during setup leaves no orphaned handlers; history completion waits for application persistence where required.
- [ ] Update groups/message behavior documentation and record remaining limitations for previously lost data.

**R02 — make the selected external identity authoritative (P1)**

Source map: `app/src/context/NostrIdentityContext.tsx`, initialization at 195–219; `_activateNip46Signer()` around 313–353; `_activateNip07Signer()` at 364–392; context values around 639. Inspect `app/src/lib/marmot/signerAdapter.ts` and all `useNostrIdentity()` consumers.

Failure: activation installs the external signer but never adopts its public identity. An auto-generated local A remains the displayed/subscribed identity while signer B signs. For a same-key bunker, deleting the stored local identity at line 342 causes a fresh local identity to be generated before reconnect on reload, creating the mismatch even when the initial connection matched.

Implementation: define one active session model with public identity, signer mode/readiness, signer capabilities, and a stable account/session generation. Separate the optional local fallback account from the active external account. Persist the external public identity without persisting its secret. Resolve the selected identity before exposing readiness; an unavailable external signer must not silently become an unrelated local identity. Specify explicit disconnect/fallback behavior and coordinate storage switching with R03.

- [ ] Connecting external B updates npub, recipient filters, rumor authors, and active account consistently.
- [ ] Same-key NIP-46 activation followed by reload preserves the same public identity.
- [ ] Different-key NIP-07/NIP-46 activation and reload both behave correctly.
- [ ] Locked/unavailable signer does not publish as local A or advertise signing readiness prematurely.
- [ ] Disconnect and reconnect have explicit tested behavior; no unintended identity is minted during restoration.
- [ ] Local-only onboarding/recovery and bilingual status/error UI remain correct.

**R03 — isolate account state and backup ownership (P1)**

Source map: `NostrIdentityContext.tsx:408` (`replaceIdentity`); `app/pages/settings.tsx:453` (`handleRestore`); `app/src/lib/marmot/groupStorage.ts`; `app/src/lib/backup/relayBackup.ts:99` (`collectBackupPayload`); `app/src/context/BackupContext.tsx:29`.

Failure: restoring B on a browser previously used by A changes keys without changing the stores. Old group/MLS state, DMs, contacts, and trust records remain active. Backup collection enumerates all groups/MLS records and then encrypts to the current identity, allowing A's retained state into B's backup. This is a code-traced cross-account problem, not a claim that documented same-account non-destructive recovery is wrong.

Implementation: inventory all account-owned localStorage, IDB, in-memory caches, dedup sets, queues, subscriptions, and timers before changing keys. Decide which settings are device-wide. Scope data by verified account ownership; scope MLS KeyPackages/slots and pending encrypted work appropriately. Introduce a migration that binds legacy unscoped records only when ownership is established; quarantine ambiguity rather than deleting or silently assigning it. Account transition must cancel/quiesce old work and prevent late callbacks from writing into B's stores. Backup collection must capture a consistent account/session snapshot and reject stale completion after a switch.

- [ ] Seed A with groups/secrets/DMs/contacts/trust/pending work; switching to B exposes none as B's state.
- [ ] B's decrypted backup contains no A-owned records, including when a backup was in flight during switching.
- [ ] Switching back to A recovers its preserved state under the chosen product behavior.
- [ ] Same-account restore still merges histories and preserves categories absent from the backup.
- [ ] Inventory includes polls/votes, reactions, edits, unread state, media, pairing nonces/intents, invitations, join requests, profile request memos, and module-level seen sets.
- [ ] Legacy migration is idempotent, tested for interruption and unknown ownership, and documented.

**R04 — preserve signer authority across all private operations (P1)**

Source map: `app/src/lib/ndkClient.ts`, `applySigner`, `getNdk`, `connectNdk`, `applyNdkSigner`; `MarmotContext.tsx:1196`; `app/src/components/contacts/ContactChat.tsx:881–894`; `app/src/lib/directMessages.ts`; `signerAdapter.ts`. Audit backup, pairing/profile exchange, welcome/join/decline, media authorization, reactions/edits, and call signaling too.

Failure: `applyNdkSigner()` clears the remembered local key; a subsequent `connectNdk(privateKeyHex)` replaces the installed signer. That connection call occurs during mode-triggered Marmot initialization and contact-chat operations. DM construction/wrapping directly uses the local private key, independently of the NDK override.

Implementation: make connection/pool access independent of signer selection. Switch signer only in an explicit session transition. Give consumers an active signer/capability interface rather than an unrelated local private key. Preserve NIP-59's ephemeral outer signing key while routing sender-authenticated inner signing/encryption through the active account. Do not mistake ephemeral wrapper keys for unauthorized local-account fallback. Audit required remote-signer kind permissions for every newly routed operation, including media/calls.

- [ ] Connecting/reconnecting the transport leaves the active signer unchanged.
- [ ] Representative group, DM, profile, backup, media, and call paths use the selected account or explicitly report unsupported capabilities.
- [ ] Outbound/inbound external-signer DMs work without access to that identity's raw private key.
- [ ] A rejecting/locked external signer cannot be bypassed by a local key; no misleading success state.
- [ ] Test genuine signer-adapter signatures/unwrap results plus at least one browser integration for each external signer mode, documenting any unavailable live service.
- [ ] Coordinate permissions and session teardown with R02/R03; preserve encrypted sender/recipient privacy.

**R05 — serialize application messages, not merely handlers within one message (P2)**

Source map: `app/src/lib/marmot/applicationRumorDispatcher.ts:101–147`; `registerHandlers.ts`; poll handlers; `welcomeSubscription.ts`. The installed library uses EventEmitter, which does not await listener promises. Existing test helper `emitAsync` is not equivalent to that production behavior.

Reproduction: synchronous poll-open then poll-vote emission through the real handlers/fake IDB leaves zero votes because the vote reads before open persists. IDs are already marked seen, so normal redelivery is suppressed.

Implementation: per-group ordered work queue, explicit drain/barrier, error isolation, and cancellation semantics. Keep independent groups independent. Decide how a failed handler affects dedup/retry; do not reset authentication gates or turn rejected rumors into retryable work. A dispatch queue only fixes concurrent processing of ordered arrivals; it does not solve genuinely out-of-order delivery. Define bounded retention for dependent events if the product promises that recovery.

- [ ] A normal synchronous emitter delivering open→vote→close preserves the intended state.
- [ ] Slow writes do not let dependent messages overtake; separate groups do not block each other unnecessarily.
- [ ] One failing handler does not permanently poison the queue; retry/dedup behavior is explicitly tested.
- [ ] Teardown/drain semantics prevent writes into a replaced session (R03/R15).
- [ ] Test and document genuinely reversed arrival order separately from concurrency.

**R06 — group-scope poll votes (P2)**

Source map: `app/src/lib/marmot/pollPersistence.ts`, `votesKey`, `loadVotes`, `saveVote`, `clearPollData`; `handlers/pollHandler.ts`; `handlers/chatHandler.ts`; `app/src/context/PollStoreContext.tsx`; `registerHandlers.ts` dependency contracts.

Reproduction: create polls sharing an ID in groups G1/G2; a vote accepted for G2 appears in G1's tally. Sender-controlled poll IDs need not be generated UUIDs. Clearing either poll's group can also delete the shared vote collection.

Implementation: carry account (R03) and group ownership through vote storage/API/clearing/tally calls. Migrate existing rows using known poll ownership; if the same legacy poll ID belongs to several groups, record and handle that ambiguity rather than copying uncertain votes into every group.

- [ ] Same-ID polls in different groups have isolated reads, writes, results, and deletes.
- [ ] A crafted poll ID cannot contaminate another group's tally on the receiver.
- [ ] Closed-poll behavior and authenticated voter binding are preserved.
- [ ] Legacy migration handles unique, colliding, and orphaned IDs and is restart-safe.
- [ ] All injected interfaces/call sites are updated; no old unscoped read path remains.

**R07 — deterministic vote revisions (P2)**

Source map: `pollPersistence.ts:110–121`; `pollHandler.ts:106–114`; `PollStoreContext.tsx`, local vote creation. The handler carries signed `created_at` into `votedAt`, but persistence ignores it on replacement.

Reproduction: receive B at timestamp 200, then A at 100; stored vote becomes A. Use a revision comparison and deterministic tie-break shared by local and remote writes. Decide whether equal-second votes require storing event ID, and migrate older rows lacking that metadata. Do not assert that timestamps alone establish exact human intent when two votes share a second.

- [ ] Older events cannot replace newer votes; all delivery permutations converge.
- [ ] Equal-timestamp conflict resolution is deterministic and documented.
- [ ] Duplicates are idempotent; optimistic local votes and echoes use consistent revision data.
- [ ] Replay and reconnect preserve the latest choice across the R06 storage migration.

**R08 — atomic profile mutation (P2)**

Source map: `app/src/lib/marmot/groupStorage.ts:80–102`, plus `deleteMemberProfile`, `saveMemberProfiles`, and backup restore writers; `handlers/profileHandler.ts`.

Reproduction: concurrent merges of Alice and Bob into an empty group leave only Bob. Separate IDB reads and full-array writes lose updates. Serializing one dispatch queue is not sufficient for independent writers or tabs.

Implementation: an IDB transaction/atomic update covering the read-modify-write. Preserve timestamp comparison and signed-envelope semantics. Ensure delete/merge and backup interaction cannot resurrect a deliberately removed record unexpectedly. Avoid asynchronous network/crypto work inside a transaction that may auto-close.

- [ ] Concurrent distinct-member merges retain both records.
- [ ] Same-member competing updates retain the newest valid profile independent of order.
- [ ] Merge/delete races and cross-tab or equivalent separate-writer behavior are tested.
- [ ] Existing signature preservation, request tracking, profile versions, and invite markers retain their intended behavior.

**R09 — honor relay preferences at startup (P2)**

Source map: `app/src/lib/ndkClient.ts:28–31`; `app/src/lib/relay.ts`; settings relay editing and `applyRelayChangesToPool`.

Reproduction: a custom persisted list exists, but a fresh real NDK instance starts with `wss://relay.damus.io` and `wss://nos.lol`. Initialize from validated effective settings. Preserve group-specific relay routing; a group may legitimately have relays distinct from the account's default pool. Review NDK's own auto-discovery behavior before promising that a removed relay is never contacted for any purpose.

- [ ] Fresh startup and reload use the saved default pool.
- [ ] Invalid/missing settings have a defined fallback; validation does not accept arbitrary malformed entries.
- [ ] Interactive edits update the live pool consistently, without rebinding the signer (R04).
- [ ] Browser/network evidence distinguishes implicit default-pool traffic from explicit group or recipient relay choices.

**R10 — repair the update-banner browser assertion (P2)**

Source map: `app/tests/e2e/update-detection.spec.ts:84`. Actual failure: `page.locator('nav')` resolves to both `navigation "Main navigation"` and the mobile bottom nav. The captured snapshot shows main navigation and the banner; it does not establish a blocking UI bug.

Implementation: use the intended accessible navigation landmark, and test an actual navigation action while the banner remains present. Do not merely suppress strictness with `.first()` or remove the assertion.

- [ ] Banner-visible navigation test passes on intended viewport(s) and verifies the route changes.
- [ ] Dismiss/reload behaviors remain covered.
- [ ] Full non-relay bucket passes; R11 records the complete gate separately.

**R11 — restore full E2E execution (P2, environment blocker)**

Source map: `docker-compose.e2e.yml`; `app/scripts/run-e2e.mjs`; `Makefile`; `app/playwright.config.ts`. Review attempt could not expose Blossom mock on host port 3001. Do not kill the unknown listener. Inspect its owner and choose an authorized resolution. An isolated port configuration must update the runner, Docker mappings, browser-visible public configuration, and tests coherently; simply changing Docker's port is insufficient.

- [ ] Relay and Blossom fixtures start and pass health checks without disturbing unrelated services.
- [ ] Full `make test-e2e-all` completes after R10; record actual discovered counts rather than stale comments.
- [ ] All failures are classified as product, test, or infrastructure problems with evidence.
- [ ] Stop only fixtures started/owned by this run; record residual state.
- [ ] No filtered run is described as a full gate pass.

**R12 — strengthen integration tests at the observed gaps (P2)**

Source map: `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`, `pollHandler.test.ts`, `advanced-settings-story04.test.ts`, `advanced-settings-story05.test.ts`, persistence tests and archived probes. At least 28 unit files reference `readFileSync`; some check source shape. Such tests can be useful structural guards, but do not substitute for runtime behavior. Several Map mocks also omit IndexedDB structured cloning and transaction timing.

Implementation: improve the tests that would have caught R01–R09. Preserve useful existing coverage; do not rewrite every unit test or impose arbitrary counts. Add behavior-driven session transition tests and real-emitter/fake-IDB boundary tests. Retain end-to-end relay/crypto coverage for the actual app path.

- [ ] Each fixed production finding has a meaningful regression that fails against its original behavior.
- [ ] The dispatch test uses production-like unawaited event emission.
- [ ] Persistence concurrency tests use fake IndexedDB or a real browser, not shared mutable Map references.
- [ ] Signer tests exercise activation→reconnect→reload and actual provider consumers, not only adapter method presence.
- [ ] Tests are independent, clean global/module state on failures, and do not accidentally rely on execution order.

**R13 — investigate timeouts through response-body consumption (P2 candidate)**

Source map: `app/src/lib/media/blossomClient.ts`, `fetchWithTimeout()` around 125–145 and `get()` around 288–309. The timer is cleared as soon as `fetch()` resolves, before `arrayBuffer()`, `json()`, or error-body `text()` consumption. A server can send headers promptly and stall the body. This code-level concern was not reproduced in the review, so retain investigation status until a delayed-stream test establishes behavior.

Implementation if confirmed: own the deadline through the required body read, cancel the stream/request, classify timeout consistently, and release UI state. Inspect redirect handling too: the URL allowlist validates the initial origin while fetch follows redirects by default. Whether the actual deployment allows an untrusted redirect is unverified; record it as a separate subfinding if demonstrated, not as an established exploit.

- [ ] Test fast headers plus stalled download/upload-response body without a 30-second real wait.
- [ ] Timeout aborts body consumption and exits loading/uploading with the expected error/retry behavior.
- [ ] Successful reads clear timers; cancellation does not leak work.
- [ ] Record redirect/allowlist assessment and fix only a reproduced or clearly established policy gap.

**R14 — do not stamp failed dependency/browser installs (P3)**

Source map: `Makefile`, `ensure-deps` around 47–56 and `ensure-playwright` around 61–67. Inside these compound shell recipes, installation is followed by `touch` using `;`, without explicit fail-fast handling. A failed install can be followed by a successful stamp write, especially with partial install output; the browser-install stamp directory already exists. This was found by reading control flow, not by deliberately corrupting the working installation.

Implementation: propagate install failure and create a stamp only after success. Preserve platform detection and existing Make entry points. Do not exercise destructive failure tests against the real `node_modules` or shared browser cache.

- [x] An isolated fake installer returning nonzero causes Make to fail and leaves no success stamp.
- [x] The next attempt retries installation; success creates the correct platform/version stamp.
- [x] Existing Make entry points and OS/architecture/version stamp calculation are preserved; isolated checks pass on Linux ARM. Native macOS execution was not available.

**R15 — investigate asynchronous subscriptions surviving cleanup (P2 candidate)**

Source map: `MarmotContext.tsx`, group subscription effect at 1534–1868. `subscribeNewGroups()` awaits several operations and later writes a disposer into `subsMap`. Cleanup only visits disposers already present; there is no effect-local cancellation/generation guard around the awaited setup. A completed old setup could register after cleanup, overlap a new setup, or overwrite its disposer. This candidate was not exercised in a React lifecycle test.

Implementation if confirmed: give each effect/session generation ownership of subscriptions, cancel pending work, dispose late results immediately, and avoid sharing teardown ownership ambiguously. Verify mode-triggered Marmot client replacement as well: `ready`/group IDs/public key may remain unchanged even when the underlying client instance changes.

- [ ] Delay historical fetch, trigger group-set change/unmount/account or signer transition, then resolve the old setup.
- [ ] No old-generation subscription remains active or writes state; current generation keeps its own disposer.
- [ ] React StrictMode setup/cleanup and repeated rapid transitions do not multiply listeners.
- [ ] Document interaction with R01/R03/R05 before marking resolved.

**R16 — investigate historical-sync retry and readiness semantics (P2 candidate)**

Source map: `welcomeSubscription.ts:1235–1288`, `historySyncedGroupIds`, `historySyncWaiters`, `waitForGroupHistorySync`, and `seenIdsByGroup`; `epochResolver.ts` disposal/error paths.

Observations: a historical timeout suppresses `onHistorySynced` but switches to a live filter bounded by recent `since`; this function has no explicit full-history retry. Module-level history-complete markers persist across subscription instances. Also inspect whether `historySyncComplete` is set before ingestion has actually succeeded, and whether IDs marked seen before ingestion stay poisoned after errors/disposal. These are separate hypotheses; do not close them all because one happy-path retry passes.

- [ ] Timeout then relay recovery catches up missing older events without an unrelated page reload.
- [ ] No profile/decline/epoch-sensitive action proceeds on stale historical-readiness state.
- [ ] Ingestion errors and teardown do not permanently suppress genuinely unprocessed events.
- [ ] Waiters and seen/sync caches have explicit group/account/client-generation lifetimes.
- [ ] Each hypothesis is reproduced and fixed, or dispositioned with evidence; no weakening of epoch/authentication gates.

**R17 — investigate backup failure propagation, retry, and practical limits (P2 candidate)**

Source map: `app/src/context/BackupContext.tsx:35–43`; `app/src/lib/backup/relayBackup.ts`, `publishBackup`, `BackupScheduler`, `collectBackupPayload`, and `restoreFromBackup`; settings restore UI.

Observation: `publishBackup()` catches failures and returns `{ok:false,error}`, while the scheduled callback only awaits it and ignores the result. `BackupScheduler` observes rejected promises and records its attempt time before success. A failed publish therefore is not surfaced through that rejection path; retry currently depends on later triggers. This was not tested against relay failures during review. Existing behavior docs explicitly describe partial recovery, debouncing, and identity-only fallback; do not label those accepted limits as new regressions.

- [ ] Inject all-relays-reject, transient failure, and account-switch-during-publish cases; record actual behavior.
- [ ] Define whether failed backup remains dirty and how bounded retries/backoff work, with no public metadata leak or stale-account publish.
- [ ] Distinguish seed-phrase acknowledgment from evidence of a successful relay backup in any UI/status changes.
- [ ] Measure representative payload sizes (multiple MLS groups and recent messages) against the pinned encryption library and relay limits; do not assume a remembered NIP-44 size limit.
- [ ] Test partial restore failure and stale-state restoration; document intentional overwrite/merge policy and any recovery limitation.

**R18 — update misleading documentation and comments (P3)**

Source map: `app/README.md`, root `CLAUDE.md`, `Makefile`, `NostrIdentityContext.tsx` header, `next.config.mjs` comments, behavior docs, and pre-existing migration request.

Observed examples: README remains largely create-next-app/Vercel boilerplate despite Cloudflare static deployment and Make-based setup. Test-gate comments say “60 tests / 12 non-relay” while the actual non-relay run discovered 71 test cases; distinguish spec files from cases rather than replacing one hard-coded misleading count with another. The identity-context header still claims kind-0 metadata publishing even though the implementation intentionally forbids it. There are old package-version comments around migrated Marmot code. The untracked 0.7.0 request describes a pre-migration seam although current package pins and dispatcher show migrated behavior; verify completion evidence before dispositioning that request.

- [ ] README gives accurate setup, architecture, local test infrastructure, static routing, and deployment commands.
- [ ] Comments/spec status no longer contradict the actual privacy or protocol behavior.
- [ ] Test-suite descriptions identify authoritative commands without brittle counts.
- [ ] Behavior documentation reflects implemented changes R01–R09/R13/R17 where applicable; preserve intentional existing decisions.
- [ ] Do not rewrite or mark the user's untracked spec complete without reconciling its actual acceptance evidence.

**R19 — profile initial bundle cost before optimizing (P3 candidate)**

Evidence: production build's shared first-load JS is approximately 613 kB, with the `_app` chunk approximately 530 kB. This is a size observation, not a measured user-performance regression. Likely investigation points are global provider imports, NDK/MLS/crypto dependencies, UI libraries, and feature loading boundaries.

- [ ] Record reproducible baseline bundle composition and actual startup/loading behavior on a representative constrained device/network.
- [ ] Identify necessary eager code versus safely deferrable features without delaying required message subscriptions or changing privacy behavior.
- [ ] If optimizing, record before/after measurements and confirm no hydration, static-export, or offline-delivery regression.
- [ ] A documented decision to defer is acceptable if measurements do not justify the complexity; no arbitrary bundle target is imposed here.

**R20 — evaluate automated change verification (P3 candidate)**

No CI workflow was found in the inspected tree, and root instructions identify Make as the gate. This is an engineering-process gap to assess, not proof that no external CI exists. Establish current hosting/runner constraints before choosing a provider or adding workflow files.

- [ ] Determine whether verification already runs outside this repository; record the result.
- [ ] Propose/adopt an appropriate automation path for unit tests, production build, and the full relay/non-relay browser gate.
- [ ] Account for pinned fork availability, platform-specific dependencies, browser caching, Docker, isolated ports, and test fixtures.
- [ ] Avoid production credentials and do not describe a subset as full verification. Record explicit deferral if automation is out of scope.

**R21 — revalidate existing pending-invitation live-update work (P2 investigation)**

Source map: [existing report](../../app/bug-reports/pending-invite-no-live-update-report.md), [existing untracked test](../../app/tests/e2e/groups-pending-invite-live-idle.spec.ts), `app/src/lib/pendingInvitations.ts`, global welcome listener, `Layout.tsx`, and `pages/groups.tsx`.

This is pre-existing user work, not a newly confirmed review finding. Reported symptom: recipient idle on `/` is not notified of an invitation until reload. The report lists module-instance duplication, external-store notification behavior, and startup timing as competing hypotheses. Do not promote any one hypothesis to a fact without runtime evidence. The review could not run the relay reproduction.

- [ ] Run the existing reproduction after R11; keep the recipient idle away from `/groups` with no incidental navigation/reload.
- [ ] Observe arrival, storage write, subscription notification, and render separately to locate the failure.
- [ ] Confirm live badge/card updates, including client navigation afterward, without polling that changes app state.
- [ ] Preserve existing user report/test history and coordinate overlapping lifecycle fixes; record a non-reproduction honestly if current code already fixes it.

**R22 — final integration verification and continuation record (P2)**

- [ ] Recheck all P1 tasks and required P2 fixes; unresolved tasks retain a visible state and rationale.
- [ ] Run `make test-unit`, `make build`, and the full `make test-e2e-all` after integration, or `make test` plus `make build`. Do not run shared-output build/dev jobs concurrently.
- [ ] Verify real signed group/DM paths, offline catch-up, identity transition/reload, migration, and backup ownership with the evidence required by their tasks.
- [ ] Reconcile behavior docs, test docs, and relevant ADRs where an architectural decision changed.
- [ ] Inspect final diff/status; include only intended work and preserve unrelated user changes.
- [ ] Record commands, environment, counts, failures/skips, commit/PR links, and any limits; no claim of live-signing/relay validation when infrastructure prevented it.
- [ ] Leave a next-context entry even if work stops before all tasks are done. No deployment or publishing is implied by completing this plan.

**Completion record template — copy once for each task**

```text
Task: R__
State: planned | in_progress | needs_investigation | blocked | done | deferred | not_reproduced
Owner:
Updated (date/time/timezone):
Baseline and implementation commit/PR or working-tree files:
Original reproduction / evidence:
Root cause or investigation disposition:
Changes and migration/compatibility decisions:
Acceptance checklist results:
Verification commands, environment, counts, and artifact paths:
Behavior/architecture documentation updated:
Remaining limitations / blocker / next action:
Sign-off: name/agent, date, evidence reference
```

**Continuation journal**

| Date | Context | Completed | Remaining / next action |
|---|---|---|---|
| 2026-09-26 | Review + handover, baseline `9eef568` | R00: original findings, six diagnostic probes, logs, task ledger, acceptance criteria archived | No implementation fixes done. Start R10/R11 and the R01/R05 or R02/R03/R04 design area. |

The baseline review was a source review with focused execution, not a formal cryptographic audit or an exhaustive review of all assets/specifications. Live relay integration, real external signers, deployment behavior, and cross-browser behavior were not fully verified. Retain those distinctions in subsequent status reports.

<a id="r14-completion"></a>
**R14 completion — 2026-09-26, Codex**

State: done. Implementation: working-tree `Makefile`, `scripts/test-install-stamps.py`.
The original compound recipes continued to `touch` after installer failure.
Both setup recipes now fail fast and chain installation success to stamp creation.
`make test-install-stamps` runs the actual Make recipes in temporary directories,
with fake npm/npx installers, partial node_modules output, and a separate browser cache.
Both failure paths return nonzero without stamps; successful retries write the expected
platform/version stamps; subsequent calls do not reinstall. Evidence:
[isolated installer checks](2026-09-26-project-review-evidence/r14-install-stamps.log).
No production storage or behavior changes. Existing platform detection and install/build/test
entry points remain intact. Native macOS execution was not available in this Linux ARM environment.
Sign-off: Codex, 2026-09-26; isolated control-flow checks passed.
