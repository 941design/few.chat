# Acceptance Criteria: Unified MLS Application-Rumor Dispatch

Epic: `epic-feature-spec-unified-mls-application-rumor-dispatch`
Produced by: story-planner (Mode 1)
Date: 2026-05-08

---

## AC-AR-1: Single applicationMessage subscriber

**Story**: Story 1
**Type**: structural
**Priority**: must

### Criterion
A grep for `group.on('applicationMessage'` across `app/src/` returns exactly one match, located in `app/src/lib/marmot/applicationRumorDispatcher.ts`. No other file in `app/src/context/` or `app/src/lib/` contains this pattern.

### Verification method
Grep assertion: `grep -r "group.on('applicationMessage'" app/src/ --include="*.ts" --include="*.tsx" -l`
Pass condition: exactly one file listed, and it is `app/src/lib/marmot/applicationRumorDispatcher.ts`.

---

## AC-AR-2: subscribeToGroupMessages called from one site with no onApplicationMessage

**Story**: Story 4
**Type**: structural
**Priority**: must

### Criterion
`subscribeToGroupMessages` is called from exactly one site (`app/src/context/MarmotContext.tsx`, inside `subscribeNewGroups`). The function's TypeScript signature (in `app/src/lib/marmot/welcomeSubscription.ts`) does not include an `onApplicationMessage` parameter. No import or usage of `onApplicationMessage` appears in the `welcomeSubscription.ts` module or any callers.

### Verification method
Grep assertion: `grep -r "subscribeToGroupMessages" app/src/ --include="*.ts" --include="*.tsx" -n`
Pass condition: only one call site found, in `MarmotContext.tsx`.

Grep assertion: `grep "onApplicationMessage" app/src/lib/marmot/welcomeSubscription.ts`
Pass condition: zero matches.

Code inspection of `subscribeToGroupMessages` signature in `app/src/lib/marmot/welcomeSubscription.ts`.
Pass condition: callback options object contains only `onHistorySynced` and `onMembersChanged`.

---

## AC-AR-3: Kind dispatch removed from context files

**Story**: Story 3
**Type**: structural
**Priority**: must

### Criterion
A grep for `rumor.kind ===` and `rumor.kind ==` across `app/src/context/` returns zero hits. All kind-based routing logic lives exclusively in `app/src/lib/marmot/applicationRumorDispatcher.ts` or handler modules under `app/src/lib/marmot/handlers/`.

### Verification method
Grep assertion: `grep -r "rumor\.kind" app/src/context/ --include="*.ts" --include="*.tsx"`
Pass condition: zero matches.

Grep assertion: `grep -r "rumor\.kind" app/src/lib/marmot/ --include="*.ts" -l`
Pass condition: matches found only in `applicationRumorDispatcher.ts` and/or files under `handlers/`.

---

## AC-AR-4: Each handler module exports exactly one RumorHandler per kind; registerHandlers.ts is the sole importer

**Story**: Story 2
**Type**: structural
**Priority**: must

### Criterion
Each of the six handler modules exports exactly one `RumorHandler` object per kind it handles:
- `chatHandler.ts` exports one handler for `CHAT_MESSAGE_KIND` (9)
- `reactionHandler.ts` exports one handler for `REACTION_RUMOR_KIND` (7); this file is also the only place in the codebase that defines `REACTION_RUMOR_KIND = 7`
- `profileHandler.ts` exports one handler for `PROFILE_RUMOR_KIND` (0)
- `profileRequestHandler.ts` exports one handler for `PROFILE_REQUEST_KIND` (30)
- `scoreHandler.ts` exports one handler for `SCORE_RUMOR_KIND` (1)
- `pollHandler.ts` exports three handlers for `POLL_OPEN_KIND` (10), `POLL_VOTE_KIND` (11), `POLL_CLOSE_KIND` (12) — or one handler that claims all three kinds

`app/src/lib/marmot/registerHandlers.ts` is the only module that imports from any file under `app/src/lib/marmot/handlers/`. No file in `app/src/context/` or elsewhere imports handler modules directly.

### Verification method
Code inspection of each handler file for exported `RumorHandler` objects.

Grep assertion: `grep -r "from.*handlers/" app/src/ --include="*.ts" --include="*.tsx" -l`
Pass condition: only `registerHandlers.ts` is listed.

Grep assertion: `grep "REACTION_RUMOR_KIND" app/src/ -r --include="*.ts" --include="*.tsx" -l`
Pass condition: only `reactionHandler.ts` defines it; any reference in other handler files must be an import from `reactionHandler.ts` (not a literal `7`).

---

## AC-AR-5: Seen-id LRU evicts entries at 1000 per group

**Story**: Story 1
**Type**: behavioural
**Priority**: must

### Criterion
The dispatcher's per-group seen-id set is capped at 1000 entries. When the set for a group exceeds 1000, the oldest entries are evicted until the set size is at or below 1000. Simulating 1100 ingests with distinct rumor IDs against a single group causes the first 100 IDs to be absent from the set after all 1100 are processed. The last 1000 IDs remain present.

### Verification method
Unit test: `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`
- Construct a dispatcher with a no-op handler for a test kind.
- Invoke dispatch for 1100 rumors with IDs `"id-0"` through `"id-1099"` against the same `groupId`.
- Assert `id-0` through `id-99` are no longer in the seen set (re-dispatching any of them would not short-circuit).
- Assert `id-100` through `id-1099` are still in the seen set (re-dispatching them would short-circuit and not call the handler again).
Pass condition: all 200 assertions pass. `make test-unit` green.

---

## AC-AR-6: Exactly one appendMessage IDB write per rumor ID (own-send + peer inbound)

**Story**: Story 2
**Type**: behavioural
**Priority**: must

### Criterion
Sending a text-only chat message from `ChatStoreContext.sendMessage` produces at most two `appendMessage(groupId, msg)` calls for the same `rumor.id` during the full lifecycle: the optimistic write in `sendMessage` (call 1), and the handler write when the peer-echo rumor arrives via the dispatcher (call 2). The IDB store contains exactly one row for the rumor ID after both writes — the `appendMessage` upsert is idempotent on `id`. The second call does not produce a second distinct row, and does not overwrite `attachments` with an empty value.

Note: per the Q1 finding (marmot-ts does NOT emit `'applicationMessage'` for own-send rumors — `#sentEventIds` causes own echoes to be skipped before `emit` fires), the dispatcher never receives the own-send rumor via the bus. The optimistic write in `sendMessage` is the only write for the local user's own messages. The IDB idempotence guarantee is therefore exercised on the peer-echo path, not the local-bus path.

The `window.__nostlingTest.onChatIdbWrite` hook must be added to `chatPersistence.appendMessage`, guarded by `process.env.NODE_ENV !== 'production' && typeof window !== 'undefined'`. This hook fires on every `appendMessage` invocation and receives `{ groupId, messageId }`. Alternatively the unit test counts `set()` calls on the Map-mock idb-keyval store.

### Verification method
Unit test: `app/tests/unit/marmot/chatHandler.test.ts`
- Mock idb-keyval with a Map and count `set` calls.
- Invoke the chat handler twice with the same `rumor.id`.
- Assert `set` is called exactly once (dispatcher LRU blocks the second invocation before the handler runs).
Pass condition: `set` call count = 1. `make test-unit` green.

E2E test: `app/tests/e2e/groups-dispatch-isolation.spec.ts` (see AC-AR-21).
Pass condition: `readIdbRecord` for the rumor ID returns exactly one row.

---

## AC-AR-7: Inbound chat message with imeta tags persists ChatMessage with attachments populated (regression AC-41)

**Story**: Story 2
**Type**: regression
**Priority**: must

### Criterion
An inbound chat rumor of kind 9 carrying `imeta` tags arrives via the dispatcher's `chatHandler.ts`. The `chatHandler` parses `imeta` tags into `attachments` on the `ChatMessage` struct before calling `appendMessage(groupId, msg)`. The `ChatMessage` row persisted to IDB contains a non-empty `attachments` array with the correct URL and MIME type extracted from the `imeta` tags.

This is the regression test for AC-41 from `epic-image-sharing`. The assertion must reference `app/src/lib/marmot/handlers/chatHandler.ts` as the artifact under test (not `MarmotContext.tsx`). The `epic-image-sharing` e2e test that originally covered AC-41 (`groups-image-sharing.spec.ts`) must continue to pass without modification to its assertions.

### Verification method
Unit test: `app/tests/unit/marmot/chatHandler.test.ts`
- Construct a rumor with `kind: 9` and `tags: [["imeta", "url https://example.com/img.jpg", "m image/jpeg"]]`.
- Invoke the handler and inspect the `appendMessage` call argument.
- Assert `msg.attachments[0].url === "https://example.com/img.jpg"` and `msg.attachments[0].type === "image/jpeg"`.
Pass condition: assertion holds. `make test-unit` green.

E2E regression test: `app/tests/e2e/groups-image-sharing.spec.ts`
Pass condition: `make test-e2e-groups` — all currently-passing tests in this file remain green.

---

## AC-AR-8: Inbound chat message increments only background group unread; active group unread unchanged

**Story**: Story 2
**Type**: behavioural
**Priority**: must

### Criterion
When an inbound chat rumor arrives for group G1 while group G2 is the active group (identified via `ctx.getActiveGroupId() !== rumor.groupId`), `incrementUnread(G1)` is called exactly once. `incrementUnread(G2)` is not called. If the rumor arrives for the active group G2, `incrementUnread` may still be called (the UI-layer unread-clear effect is responsible for decrement); this AC does not constrain the active-group increment direction — it constrains that a background group's counter increments and the active group's counter is not incremented by messages destined for the background group.

The chat handler detects own-send by `rumor.pubkey === ctx.selfPubkeyHex` and skips `incrementUnread` for own messages regardless of active group.

### Verification method
Unit test: `app/tests/unit/marmot/chatHandler.test.ts`
- Inject a mock `incrementUnread` spy.
- Dispatch a peer rumor with `groupId: "G1"` and `ctx.getActiveGroupId()` returning `"G2"`.
- Assert `incrementUnread` called with `"G1"`, not `"G2"`.

Separate case: dispatch a rumor where `rumor.pubkey === ctx.selfPubkeyHex`.
- Assert `incrementUnread` is not called.
Pass condition: both sub-cases pass. `make test-unit` green.

---

## AC-AR-9: Existing chat e2e suites remain green

**Story**: Story 2
**Type**: regression
**Priority**: must

### Criterion
All currently-passing tests in the following e2e files pass without modification to test assertions after Story 2 ships:
- `app/tests/e2e/groups-lifecycle.spec.ts`
- `app/tests/e2e/groups-image-sharing.spec.ts` (currently-passing tests only)
- `app/tests/e2e/groups-direct-chat-no-duplicates.spec.ts`

Note: `groups-direct-chat-no-duplicates.spec.ts` covers the DM `ContactChat` path (NIP-17/59 gift wraps), which is out of scope for this epic. It must continue to pass unchanged.

### Verification method
E2E test run: `make test-e2e-groups`
Pass condition: all tests in the listed files that were green before this epic remain green. No newly-failing tests introduced.

---

## AC-AR-10: Reaction own-send echo processed exactly once per rumor ID

**Story**: Story 2
**Type**: behavioural
**Priority**: must

### Criterion
When the local user sends a reaction via `ChatStoreContext.sendReaction`, the optimistic write executes via `applyOptimistic` / `applyOptimisticRemoval`. If marmot-ts subsequently delivers the own-send echo via the event bus (note: per Q1 finding, marmot-ts does NOT currently emit `'applicationMessage'` for own-send rumors — `#sentEventIds` skips them before emit fires; this AC remains valid as a guard against future marmot-ts version changes), the dispatcher's LRU deduplications ensure `applyInboundRumor` is invoked at most once for that `rumor.id` across the lifetime of the subscription.

In practice under the current marmot-ts version, the dispatcher does not receive the own-echo at all; the AC confirms that if it did (or when tested via a synthetic bus emit), the LRU would block a second invocation.

### Verification method
Unit test: `app/tests/unit/marmot/reactionHandler.test.ts`
- Invoke the reaction handler with the same `rumor.id` twice in sequence (simulating two bus emissions for the same reaction).
- Assert `applyInboundRumor` is called exactly once.
Pass condition: spy call count = 1. `make test-unit` green.

---

## AC-AR-11: Reaction inbound from peer processed exactly once per rumor ID

**Story**: Story 2
**Type**: behavioural
**Priority**: must

### Criterion
When a kind-7 rumor arrives from a peer, `applyInboundRumor` is called exactly once for that `rumor.id`. If the same rumor ID is delivered a second time (e.g. relay re-delivery), the dispatcher's LRU blocks the second invocation — `applyInboundRumor` is not called again.

The gate that previously used `messagesRef.current` (ChatStoreContext in-memory) or `loadMessages` (IDB read, MarmotContext) is replaced by the LRU in the dispatcher for the dedup concern; `reactionHandler.ts` retains its existence gate on the target message being known locally before applying the reaction.

### Verification method
Unit test: `app/tests/unit/marmot/reactionHandler.test.ts`
- Dispatch a kind-7 peer rumor once; assert `applyInboundRumor` called once.
- Dispatch the same `rumor.id` again; assert `applyInboundRumor` call count remains 1.
Pass condition: total `applyInboundRumor` calls = 1. `make test-unit` green.

---

## AC-AR-12: Reaction epic regression tests continue to pass (AC-38)

**Story**: Story 2
**Type**: regression
**Priority**: must

### Criterion
AC-38 (story-06 of `epic-emoji-feature`) passes without modification to its assertions. The test must exercise `reactionHandler.ts` as the code path under test. The assertion text and pass condition defined in `epic-emoji-feature` story-06 remain unchanged.

Note: AC-59 (DM-side reactions) is out of scope for this epic — the `ContactChat` NIP-17/59 path is not touched. AC-59 should remain in the DM test suite and must not be broken.

### Verification method
E2E test run: `make test-e2e-groups` — AC-38 test case in `groups-reactions.spec.ts` (or its source file) passes.
Pass condition: AC-38 test green. AC-59 test in DM suite unchanged and green.

---

## AC-AR-13: Bob reacts to Alice's message — Alice sees the badge (AC-40 regression, now expected to pass)

**Story**: Story 2
**Type**: behavioural
**Priority**: must

### Criterion
The test "Bob reacts to Alice's message — Alice sees the badge (AC-40)" in `app/tests/e2e/groups-reactions.spec.ts`, currently failing per the May-08 bug report (B2), passes after Story 2 ships. The structural cause — two competing kind-7 consumers using different gate mechanisms that disagree during the IDB-write / React-state-read window — is eliminated by routing all kind-7 inbound through the single dispatcher. Alice's browser shows the reaction badge for the correct message within the test's timeout.

### Verification method
E2E test run: `make test-e2e-groups` targeting `groups-reactions.spec.ts` "Bob reacts to Alice's message — Alice sees the badge (AC-40)".
Pass condition: test passes (no `test.fixme`, no skip). `make test-e2e-groups` green for this case.

---

## AC-AR-14: Profile discovery e2e scenarios 1-4 and 6 continue to pass

**Story**: Story 3
**Type**: regression
**Priority**: must

### Criterion
Scenarios 1, 2, 3, 4, and 6 of `app/tests/e2e/groups-profile-request.spec.ts` (from `epic-member-profile-discovery-and-relay-on-behalf`) pass without modification to their assertions. The `profileHandler.ts` and `profileRequestHandler.ts` handlers must implement the same side effects as the removed MarmotContext callback: `mergeMemberProfile`, `updateMemberScoreNickname`, `notifyProfileObserved`, `recordRequestAnswered`, `writeContactEntry`, `setProfileVersion`, `recordRequestEmitted`, `sendRumorSafe` (self-target), `handleIncomingProfileRequest`.

Scenario 5 remains `test.fixme` if the underlying B3 retry-attempts bug is not resolved before Story 3 ships. If B3 is fixed as part of this epic, scenario 5 must be converted to a passing test and noted in the story completion record.

### Verification method
E2E test run: `make test-e2e-groups` — scenarios 1, 2, 3, 4, 6 of `groups-profile-request.spec.ts` pass.
Pass condition: five scenarios green. Scenario 5 status unchanged from pre-epic baseline.

---

## AC-AR-15: Poll e2e tests continue to pass after pollHandler.ts wiring

**Story**: Story 3
**Type**: regression
**Priority**: must

### Criterion
All currently-passing tests in `app/tests/e2e/groups-polls.spec.ts` (and any related poll e2e files from `epic-group-polls`) pass without modification to their assertions. `pollHandler.ts` must dispatch `POLL_OPEN_KIND` (10), `POLL_VOTE_KIND` (11), and `POLL_CLOSE_KIND` (12) through the correct IDB writes (`savePoll`, `saveVote`, `getPoll`) and bump `setPollVersion` on each, matching the behaviour previously in MarmotContext lines 742-776.

The closed-poll guard (saveVote only when poll not closed) and the creator-only close guard (savePoll(closed:true) only when `creatorPubkey === rumor.pubkey`) must be preserved in `pollHandler.ts`.

### Verification method
Unit test: `app/tests/unit/marmot/pollHandler.test.ts`
- Happy path for each of the three kinds.
- Guard test: vote against a closed poll — assert `saveVote` not called.
- Guard test: close by non-creator — assert closed flag not set.
Pass condition: unit tests green. `make test-unit` green.

E2E test run: `make test-e2e-groups` — `groups-polls.spec.ts` tests pass.
Pass condition: all previously-green poll tests remain green.

---

## AC-AR-16: Score sync continues to pass; mergeMemberScore invoked once per inbound score rumor

**Story**: Story 3
**Type**: regression
**Priority**: must

### Criterion
`scoreHandler.ts` calls `mergeMemberScore(groupId, senderPubkey, nickname, scoreUpdate)` exactly once per inbound `SCORE_RUMOR_KIND` (1) rumor. The LRU dedup in the dispatcher ensures a replayed score rumor with the same `rumor.id` does not cause a second `mergeMemberScore` call. Score-sync e2e flows from `epic-group-learning-prototype` continue to pass.

### Verification method
Unit test: `app/tests/unit/marmot/scoreHandler.test.ts`
- Dispatch a score rumor; assert `mergeMemberScore` called once with correct args.
- Dispatch same `rumor.id` again; assert call count remains 1.
Pass condition: unit test green.

E2E test run: `make test-e2e-groups` — score-sync related tests from `epic-group-learning-prototype` pass.
Pass condition: no regressions in score-display tests.

---

## AC-AR-17: Unknown kind does not crash dispatcher; no error log above debug

**Story**: Story 1
**Type**: negative
**Priority**: must

### Criterion
A rumor with an unknown kind (e.g. `kind: 9999`) arriving at the dispatcher does not throw an unhandled exception, does not call `console.error`, and does not call `console.warn`. At most `console.debug` may be emitted for unrecognised kinds. The dispatcher returns cleanly and the subscription remains active for subsequent rumors.

### Verification method
Unit test: `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`
- Register a dispatcher with handlers only for kind 9.
- Dispatch a rumor with `kind: 9999`.
- Assert no exception thrown (test does not reject).
- Assert `console.error` and `console.warn` spies have zero calls.
Pass condition: all assertions pass. `make test-unit` green.

---

## AC-AR-18: Handler that throws does not block downstream handlers for the same kind

**Story**: Story 1
**Type**: negative
**Priority**: must

### Criterion
When two handlers are registered for the same kind and the first throws synchronously (or rejects asynchronously), the second handler is still called. The dispatcher catches the first handler's error, logs it with `console.warn('[dispatcher.<kind>]', err)`, and continues to the second handler. The second handler's result is the resolved outcome for that rumor dispatch.

### Verification method
Unit test: `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`
- Register two handlers for kind 9: handler-A always throws `new Error("boom")`, handler-B records a call.
- Spy on `console.warn`.
- Dispatch a kind-9 rumor.
- Assert handler-B was called.
- Assert `console.warn` was called with a first argument matching `'[dispatcher.9]'`.
Pass condition: handler-B call count = 1, console.warn called once with the tag. `make test-unit` green.

---

## AC-AR-19: Removing MarmotContext pubkey filter does not produce double-renders on own-send

**Story**: Story 2
**Type**: negative
**Priority**: must

### Criterion
After the inline kind-dispatch block is removed from `MarmotContext`'s `onApplicationMessage` callback (and the callback is removed entirely in Story 4), the own-send filter `if (senderPubkey === pubkeyHex) return;` at MarmotContext line 603 is also removed. This does not cause double-renders because marmot-ts does NOT emit `'applicationMessage'` on the bus for own-send rumors (Q1 confirmed: `#sentEventIds` causes own-echoes to be skipped with `{kind:'skipped', reason:'self-echo'}` before `emit` fires). The dispatcher therefore never receives own-send rumors via the bus.

The existing `groups-lifecycle.spec.ts` assertion that "User A sends a message, User A sees exactly one bubble" must remain green. This is observable as: the rendered message list for User A contains exactly one element with the sent message content after the optimistic write settles.

Note: the AC is valid as a guard against future marmot-ts version changes that might restore own-send bus emission. The LRU dedup in the dispatcher would handle it correctly if that happened.

### Verification method
E2E test: `app/tests/e2e/groups-lifecycle.spec.ts` — "User A sends, User A sees once" (or equivalent) test.
Pass condition: test passes. `make test-e2e-groups` green for this case.

Code inspection: confirm `if (senderPubkey === pubkeyHex) return;` does not appear in `applicationRumorDispatcher.ts` or any handler module. The dispatcher is source-agnostic; dedup is by `rumor.id`.

---

## AC-AR-20: Unit test coverage for dispatcher and all handlers

**Story**: Story 1 (dispatcher), Story 2 (chat + reaction handlers), Story 3 (profile, profileRequest, score, poll handlers)
**Type**: test-shape
**Priority**: must

### Criterion
Unit tests exist under `app/tests/unit/marmot/` for the following modules:

| Module | Required test cases |
|---|---|
| `applicationRumorDispatcher.ts` | happy-path dispatch, unknown-kind no-crash (AC-AR-17), handler-throws isolation (AC-AR-18), LRU eviction at 1000 (AC-AR-5), same-id dedup short-circuit |
| `handlers/chatHandler.ts` | happy-path kind-9 with text, happy-path with imeta attachments (AC-AR-7), malformed payload (missing `content`), duplicate-id short-circuit via dispatcher mock |
| `handlers/reactionHandler.ts` | happy-path kind-7, target message not found gate, duplicate-id short-circuit |
| `handlers/profileHandler.ts` | happy-path kind-0, malformed profile payload, duplicate-id |
| `handlers/profileRequestHandler.ts` | happy-path kind-30 peer request, self-target reply path, duplicate-id |
| `handlers/scoreHandler.ts` | happy-path kind-1, malformed score payload, duplicate-id |
| `handlers/pollHandler.ts` | happy-path for each of kinds 10/11/12, vote-against-closed guard, close-by-non-creator guard, duplicate-id |

All test files use the vitest import style: `import { describe, it, expect, vi, beforeEach } from 'vitest'`.
IDB is mocked with a module-level Map via `vi.mock('idb-keyval', ...)` following the pattern in `app/tests/unit/marmot/groupReactions.test.ts`.
Tests do NOT use pure mock-spy proxies as pass conditions — at least the happy-path case per handler must assert an observable state change (IDB write argument, version setter call arg, or similar).

### Verification method
`make test-unit`
Pass condition: all unit test files listed above exist and pass. Zero failing tests.

---

## AC-AR-21: Own-send produces exactly one IDB row and one rendered bubble across two tabs (dispatch isolation)

**Story**: Story 5
**Type**: behavioural
**Priority**: must

### Criterion
A new e2e test file `app/tests/e2e/groups-dispatch-isolation.spec.ts` is created. It uses two `BrowserContext` instances for the same user identity (or two separate users where one sends and one observes). The test:

1. User A (tab 1) sends a text-only chat message to a shared group.
2. After network settle, tab 1 reads the IDB `keyval-store/keyval` key `"quizzl:messages:{groupId}"` via `readIdbRecord` and asserts it contains exactly one entry with the sent message ID.
3. Tab 1's rendered message list (queried by `[data-testid="msg-{id}"]`) contains exactly one element matching the sent message.
4. User B (tab 2, if multi-user scenario) or tab 2 of the same user sees exactly one bubble with the message content.

The test uses `test.describe.serial` and `suppressErrorOverlay(context)` per the project e2e conventions.

This is the durable structural regression sentinel for the "two parallel consumers, one logical event" class of bug. It must remain green across all future epics that touch the MLS receive path.

### Verification method
E2E test run: `make test-e2e-groups` targeting `groups-dispatch-isolation.spec.ts`.
Pass condition: all scenarios in the file pass. `readIdbRecord` returns exactly one message row per sent message ID.

---

## AC-AR-22: window.__nostlingTest.onChatIdbWrite hook added to chatPersistence.appendMessage

**Story**: Story 2
**Type**: structural
**Priority**: should

### Criterion
`app/src/lib/marmot/chatPersistence.ts`'s `appendMessage` function contains a test-only hook:

```ts
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  (window as any).__nostlingTest?.onChatIdbWrite?.({ groupId, messageId: message.id });
}
```

The hook fires after the IDB write resolves. The declaration file `app/tests/e2e/helpers/rumor-counter.ts` (or an adjacent helper) declares `onChatIdbWrite?: (args: { groupId: string; messageId: string }) => void` on the `__nostlingTest` surface.

This hook is required by AC-AR-6 and AC-AR-21 for the e2e write-count verification approach. The unit test alternative (Map-mock idb-keyval `set` call count) does not require this hook, but the e2e variant does.

> **Note (2026-10-14, bug `own-send-message-echo-no-longer`):** the hook is page-global — it fires for
> every chat-row insert, including background writes the user's client authors itself (e.g. the
> invite-lifecycle `accepted` announcement, epic group-invite-lifecycle). E2E write counts must
> therefore be filtered by `messageId` (and `groupId`), never taken as a raw page total. (The hook now
> lives on `window.__fewTest` after the rebrand.)

### Verification method
Code inspection: `app/src/lib/marmot/chatPersistence.ts` contains the guarded hook call in `appendMessage`.
Code inspection: `app/tests/e2e/helpers/rumor-counter.ts` (or equivalent) declares `onChatIdbWrite` on `window.__nostlingTest`.
Pass condition: grep `onChatIdbWrite` in `app/src/lib/marmot/chatPersistence.ts` returns a match.

---

## AC-AR-23: Per-group LRU scope; rumor-id collision across groups is not suppressed

**Story**: Story 1
**Type**: behavioural
**Priority**: should

### Criterion
The seen-id LRU is keyed per `groupId` (a `Map<groupId, Set<rumorId>>`). A rumor with a given `id` processed in group G1 does not block the same `id` from being processed in group G2. This ensures that any future rumor kind that intentionally repeats an ID across groups (or a hash collision, however unlikely) does not silently drop the second delivery.

### Verification method
Unit test: `app/tests/unit/marmot/applicationRumorDispatcher.test.ts`
- Dispatch a rumor with `rumor.id = "X"` for group `"G1"` — handler called once.
- Dispatch a rumor with `rumor.id = "X"` for group `"G2"` — handler called a second time (different group scope).
- Dispatch `rumor.id = "X"` for `"G1"` again — handler NOT called (LRU hit for G1).
Pass condition: handler call count = 2 (once per group). `make test-unit` green.

---

## AC-AR-24: IDB priming on dispatcher subscribe (Q4 resolved behaviour)

**Story**: Story 1
**Type**: behavioural
**Priority**: should

### Criterion
On `dispatcher.subscribe(group, ctx)`, the dispatcher does NOT prime the seen-id LRU from IDB. Historical rumors that were already persisted before the subscription opened are re-processed by handlers only if they happen to arrive again via the bus (relay re-delivery). Handlers are responsible for their own idempotence on `rumor.id` (e.g. `appendMessage` IDB upsert, `applyInboundRumor` idempotency). The dispatcher does not perform an async IDB read at subscribe time.

This is the resolution of spec open question Q4: IDB priming is NOT performed; idempotent handler writes are the protection against re-processing historical rumors.

### Verification method
Code inspection: `applicationRumorDispatcher.ts` `subscribe()` function contains no `await` on any IDB or storage call.
Pass condition: grep for `appendMessage\|loadMessages\|savePoll\|mergeMember` inside `applicationRumorDispatcher.ts` returns zero matches (handlers, not the dispatcher itself, own IDB calls).

Unit test: after constructing a fresh dispatcher (empty LRU), dispatch a rumor with `kind: 9` — handler is called (no IDB pre-read gate blocking it).
Pass condition: handler called once.

---

## Regression reference: prior-epic ACs

The following ACs from prior epics must continue to pass after this epic ships. They are listed here for cross-reference; their authoritative text and assertions remain in their originating epic directories.

| Prior AC | Originating Epic | Covered by |
|---|---|---|
| AC-41 (image attachment rendering) | `epic-image-sharing` | AC-AR-7 |
| AC-38 (reaction from peer visible to sender's group member) | `epic-emoji-feature` story-06 | AC-AR-12 |
| AC-59 (DM-side reaction; out of scope, must not regress) | `epic-emoji-feature` | AC-AR-12 note |
| AC-40 (Bob reacts, Alice sees badge) | `epic-emoji-feature` | AC-AR-13 |
| Scenarios 1-4, 6 (profile discovery) | `epic-member-profile-discovery-and-relay-on-behalf` | AC-AR-14 |
| Poll open/vote/close flows | `epic-group-polls` | AC-AR-15 |
| Score-sync flows | `epic-group-learning-prototype` | AC-AR-16 |
