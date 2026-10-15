# A cold-start relay backup attempt can stall forever: no backup, no logged failure, no retry

Source: exposed 2026-10-15 by bug run groups-e2e-suite-flaky-under-shared, remediation round 2
(groups-backup-restore-outcomes.spec.ts now kicks only after a LOGGED failed attempt).

## Description

In 1 of 3 isolated runs on a wiped relay (no CPU contention), the first backup after a fresh
profile load (avatar backfill → markBackupDirty → scheduler publish) neither landed on the relay
(kind 30078 by author, polled 90 s) nor logged any `[Backup … failed` line. The scheduler's retry
path (RETRY_DELAYS_MS = 30 s / 2 min / 10 m, relayBackup.ts ~:562) only runs when an attempt
settles as failed — a never-settling attempt blocks backups for the rest of the page session.
A Playwright `routeWebSocket` + close() block reproduced the same silent stall (0 logged attempts,
no backup), while a refused connection produced logged failures + retries.

## Suspects (unconfirmed)

- `ndkEvent.publish(relaySet)` (relayBackup.ts ~:229) awaiting relay OK with no effective timeout
  when the socket is half-open/closed (a diagnoser claimed NDK 3.0.3 defaults to 2.5 s/relay — verify).
- `connectNdk` / `ndk.connect(2500)` (BackupContext.tsx ~:52-61) or the kind-30051 relay-list fetch
  (getBackupRelays, 8 s) not settling.
- The scheduler's in-flight guard never clearing.

## Expected vs actual

Expected: every attempt settles (success or logged failure) within a bounded time; failures retry.
Actual: an attempt can hang indefinitely; no log, no retry, no backup.

## Reproduction

```
docker compose -f docker-compose.e2e.yml down -v && docker compose -f docker-compose.e2e.yml up -d --wait
cd app && PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-backup-restore-outcomes.spec.ts --reporter=line
```
(intermittent; the routeWebSocket-close scratch variant reproduces deterministically)

## Impact

Users on flaky networks can silently go without a relay backup for a whole session — the backup that
protects a fresh identity. Privacy invariant (kind 30078, NIP-44 to self) must stay untouched.

## Constraints

- Identify the hanging step with evidence (instrumentation) before fixing.
- Bound the attempt (timeout → logged failure → existing retry path). Do not change the retry
  schedule, backup contents, encryption, kind, or relay selection.
- Unit regression test (fake timers / never-resolving publish) + the e2e must pass ≥5 consecutive runs.
