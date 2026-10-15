# groups-dispatch-isolation own-send write count is 2, not 1 (AC-AR-21/22)

Source: BACKLOG.json finding `own-send-message-echo-no-longer` promoted 2026-10-14

## Description

Original finding: "Own-send message echo no longer suppressed at the dispatcher — appendMessage fires
twice (AC-AR-22 regressed by author-auth app-layer epic)". The finding asks for an owner decision:
unintended regression vs. intended new dispatcher semantic.

Reproduced 2026-10-14 (wiped relay, correct browsers):
`app/tests/e2e/groups-dispatch-isolation.spec.ts:208` → `expect(writeCount).toBe(1)` received 2 (spec :248).

## Lead pre-analysis (two read-only explorers, unconfirmed by run)

- The counter (`__fewTest` onChatIdbWrite, `chatPersistence.ts:403/:410`) only fires on a REAL insert
  (or edit-placeholder replace); same-id re-appends return early at :396. So an echo of Alice's
  message (same rumor.id, same groupId) cannot produce the second count — a second DIFFERENT row
  was inserted during the 5 s window. The counter is not filtered by messageId/groupId.
- Leading hypothesis: Alice's own `accepted` lifecycle announcement (feature 4912f9a, 2026-07-23):
  `profileHandler.ts:129-165` → `sendAnnouncement` → `MarmotContext.tsx:~1674 appendMessage` fires when
  Bob's join profile reaches Alice, which is background work that can land after the counter reset
  (spec :210) — beforeAll only waits for Bob's group page.
- Spec/AC wording: AC-AR-21 requires exactly ONE ROW for the sent id and ONE bubble; AC-AR-22 only
  requires the hook to exist; the "exactly 1 write" number lives only in the e2e, justified by
  architecture Q1 (library drops own echoes). Unit tests mock marmot-ts entirely.
- Secondary risk: `getFirstMessageId` (spec :75-81) picks the first `msg-*` bubble; if announcement
  bubbles share that testid prefix, `sharedMessageId` may be the `invited` announcement, not Alice's
  message (would make the row/bubble assertions vacuous).

## Expected vs actual

Expected: sending one message produces exactly one chat-row insert for THAT message and one bubble.
Actual: the unfiltered counter reports 2 inserts in the window.

## Reproduction

```
docker compose -f docker-compose.e2e.yml down -v && docker compose -f docker-compose.e2e.yml up -d --wait
cd app && PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-dispatch-isolation.spec.ts --reporter=line
```

## Impact

Red e2e gate; a structural regression sentinel that measures the wrong thing (either false alarm,
or — if the hypothesis is wrong — a genuine duplicate-row bug).

## Constraints

- Confirm the second write's messageId/content by instrumentation BEFORE changing anything.
- If it is the `accepted` announcement (intended product behaviour), fix the test's measurement so
  it tracks the sent message precisely; do not suppress announcements in product code.
- If it is a genuine duplicate row of the user's own message, the fix belongs in product code.
