# First relay backup after load can wait 30 s+ after a cold-start failure

Source: BACKLOG.json finding `first-relay-backup-fragile-at-cold-start` (filed 2026-10-14, observed
2026-10-15 in instrumented e2e runs). Optional hardening of the cold-start window, not a confirmed
user-facing failure (the e2e flake that prompted it was a test setup race).

## Description

`publishScheduledBackup` (`app/src/context/BackupContext.tsx`) connects (`ndk.connect(2500)`), then
`publishBackup` (`app/src/lib/backup/relayBackup.ts`) fetches the user's kind-30051 relay list
(`fetchEventsWithTimeout`, 8 s) and publishes with NDK's 2.5 s publish timeout. With the relays not yet
reachable at start-up, the first attempt takes ~13 s to fail and `BackupScheduler` then waits
`RETRY_DELAYS_MS[0]` = 30 s (then 2 min, 10 min …). A fresh session therefore went ~43 s+ (or minutes,
if the 30 s retry also hit a slow relay) without a backup.

Verified against HEAD before fixing (anchors had moved: `relayBackup.ts` lives under
`app/src/lib/backup/`; the scheduler schedule is at ~572). The new test file fails 14 of 21 cases
against the HEAD module.

## Fix

1. **Early cold-start retry** (`BackupScheduler`): the first failure before the scheduler's first
   success is retried after `COLD_START_RETRY_MS` = 5 s. Granted once per scheduler (one per identity
   activation), it does not consume the 5-retry budget, and the regular 30 s / 2 min / 10 min ×3
   schedule follows unchanged. After any success, failures use the regular schedule only.
2. **Relay-list timeout memo** (`getBackupRelays`, publish path only via
   `{ reuseAfterRecentTimeout: true }`): when this identity's relay-list fetch timed out less than
   `RELAY_LIST_TIMEOUT_REUSE_MS` = 60 s ago, it skips the fetch and uses the currently configured
   relays. In-memory, per pubkey, never persisted. `lookupBackup` (restore) always fetches, but records
   timeouts. (Round 0 also reused a remembered list; removed in remediation round 1.)

Worst case (relays unresponsive for the whole first attempt, healthy after): attempt 1 fails at ~13 s,
the early retry at ~18 s skips the 8 s list fetch and lands at ~18 s (was ~43 s, or ~51 s+ when the
30 s retry also waited out the fetch). A first attempt that fails faster (connect error) lands ~5 s after
the failure; a relay that is merely slow usually lets attempt 1 itself succeed. The literal "within
15 s" success signal is met except in that worst case — see open questions.

## Privacy invariant

Unchanged. The backup is still kind 30078, NIP-44 encrypted to self, built and signed exactly as
before. Inside the skip window the publish uses `getEffectiveRelays()` read at call time — precisely
what a timed-out fetch resolves to today, and always the user's current configuration.

## Indeterminate publish

A publish that times out (NDK: no relay acknowledged within 2.5 s — a relay may still have stored it)
remains treated exactly like a refusal: `publishBackup` returns `{ok:false}`, the scheduler retries.
Republishing is harmless (replaceable event replaces itself). This is current semantics, now documented
at the scheduler retry branch and pinned by a test.

## Not changed

Backup dirty-mark semantics (`markDirty`, pending hand-off, debounce from last success) — the separate
product-decision item `backup-dirty-mark-lost-on-early-reload` is untouched. NDK timeouts unchanged.

## Docs

- `docs/behavior/backup-and-recovery.md` §3 "When saving fails": early ~5 s retry at start-up and the
  relay-list reuse, with the "never goes anywhere it could not have gone before" guarantee.
- `specs/epic-backup-restore-reliability/acceptance-criteria.md` AC-BRR-10: dated amendment.

## Tests

- New `app/tests/unit/backup/coldStartRetry.test.ts` (21, fake timers, no jsdom): scheduler timing
  (5 s boundary, regular schedule after, rejection, success path unchanged, granted once, ride-along,
  dispose); memo (60 s boundary, last-known reuse + copy, forget on clean empty fetch, clear on complete
  fetch, partial timed-out list not memoised, per identity, publishBackup integration); composed
  scheduler + real `publishScheduledBackup` + `publishBackup` with failures injected at connect, relay-list
  fetch (timeout), publish (timeout and refusal), healthy path, long outage.
- `relayBackup.test.ts`: 4 schedule tests updated to the new AC-BRR-10 (5 s first); memo reset in
  `beforeEach`.

## Verification

- Unit: 250 files, 5588 passed, 1 skipped (baseline 249 / 5567 / 1). `tsc --noEmit` clean.
- Stryker (concurrency 1, scratch `/tmp/claude-501/mutation/cold-start-backup/`): 77/79 killed
  (97.47 %). 2 equivalent survivors (see result.json).
- e2e: not run (fixer brief).

## Remediation round 1

Trigger: reviewer ACCEPTED conditional on F1; Codex high on the same point.

- **F1 / Codex high:** the round-0 memo reused the list from an earlier complete fetch, so after the
  user removed a relay a retry inside the 60 s window could still publish there. `lastKnownRelayList`
  is deleted; inside the window `getBackupRelays` returns only `getEffectiveRelays()`, read live.
- **F2:** comment at `getBackupRelays`, `docs/behavior/backup-and-recovery.md` and the AC-BRR-10
  amendment now say: skips the fetch and uses the currently configured relays.
- **F3:** tests in `coldStartRetry.test.ts`: (a) Codex sequence — complete fetch A, user saves B,
  timed-out fetch, publish fails, retry → both attempts go to B, never A; (b) configured relays edited
  inside the window → the 5 s retry and the next publish (30 s retry) each use the newest set, with no
  second fetch; (c) unit: inside the window an earlier fetched list is never used; live read per call.
  (a) and the "never an earlier fetched list" test fail against the round-0 module.
- **Stale tests:** the two memo-reliant tests were replaced by the above; the per-identity and
  partial-list tests were reworded to no longer assert a remembered list.
- **F4:** `COLD_START_RETRY_MS` comment now says the retry fires on the first failure before any
  success, whenever that happens; start-up is the case it is for.

Verification: unit 250 files, 5589 passed, 1 skipped; `tsc` clean. Stryker r2 (concurrency 1) on
`relayBackup.ts:227, 391-465`: 55/57 killed (96.49 %); same 2 equivalent survivors as round 0.
