# clearMessages releases another write's queue slot, letting a later append race and drop a row

Source: found 2026-10-14 by the mutation audit of app/src/lib/marmot/chatPersistence.ts (Stryker, concurrency 1),
during the e2e-trust cluster work. Reproduced by a throwaway unit test (expected rows [b, c], got [b]).

## Description

`clearMessages` (chatPersistence.ts ~:728-736) chains onto the per-thread write queue but its settle
handler unconditionally does `appendQueues.delete(key)`. Every other writer (appendMessage etc., ~:720-725)
only deletes the slot if it is still its own (`if (appendQueues.get(key) === settled)`).

## Expected vs actual

- Expected: writes to one thread are strictly serialized; an append queued during a clear and another
  arriving after it both persist.
- Actual: when append B queues behind the clear, the clear's settle handler deletes B's slot; append C
  then starts from an empty queue and runs concurrently with B (read-modify-write race) → one row lost.

## Reproduction

Unit test: clear(groupId) → append(b) queued during the clear → after the clear settles, append(c) →
await both → load rows: expect [b, c].

## Impact

Low: needs appends racing a group-leave clear. Silent message loss when it happens.

## Constraints

Minimal fix mirroring the other writers' own-slot check; regression unit test; no behaviour change otherwise.
