# Acceptance Criteria — Backup & restore reliability

## Story 1 — Honest restore outcomes

## AC-BRR-1 — Lookup distinguishes four outcomes
`fetchBackup` resolves (never rejects) to: `found` with the payload when a valid v1 backup exists;
`none` when the relay query completed without a backup; `unreachable` when the query timed out with
no events; `unusable` when the newest backup cannot be decrypted, parsed, or validated, or carries
`version > 1`. *Known limit:* "unreachable" is inferred from the relay query timing out with no
events; with several relays and a partial outage the result can be `none` even though a relay that
did not answer holds the backup.

## AC-BRR-2 — Full payload validation before any write
A payload whose shape violates v1 (wrong-typed groups, non-base64 group state, non-array chat, …)
yields `unusable` and nothing is written to localStorage or IDB. A v1 payload lacking
`inviteLinks` is accepted and treated as having none.

## AC-BRR-3 — localStorage written last
If an IDB write fails during `restoreFromBackup`, local settings and profile are unchanged.

## AC-BRR-4 — Outcome messages after identity recovery
After a successful identity recovery the restore section shows, alongside the identity success,
a distinct message for *no backup found*, *relays unreachable*, and *backup unusable*. A found
backup opens the confirmation dialog as before; skipping it shows only the identity success.

## AC-BRR-5 — Check again
The *relays unreachable* message carries a **Check again** button that re-runs only the backup
lookup for the recovered identity and replaces the message with the new outcome (or opens the
dialog when a backup is now found). It does not re-run identity recovery.

## AC-BRR-6 — Apply failure shows a backup-specific error
If applying a found backup throws, the user sees a backup-apply error, not the invalid-phrase
error.

## AC-BRR-7 — Truthful, translated dialog
The confirmation dialog's title, body, and buttons come from `i18n.ts` (en + de); the body states
that restoring adds the backup to this device and deletes nothing.

## Story 2 — Scheduled backup retries

## AC-BRR-8 — Failure is reported
The provider's publish attempt (`publishScheduledBackup`) reports failure whenever the backup was
not published (`publishBackup` returned `{ ok: false }`, or no relay client exists). The scheduler
treats a resolved `false` or a rejection as failure.

## AC-BRR-9 — Debounce from last success; changes during backoff wait
Only a successful publish starts the 5-minute debounce window. While a retry is pending after a
failure, further changes (immediate or not) do not publish early — they ride along with the pending
retry.

## AC-BRR-10 — Bounded backoff retry
After a failure the scheduler retries after 30 s, 2 min, 10 min, 10 min, 10 min, then stops; a
success stops retrying; a new change resets the budget.

## AC-BRR-11 — One publish at a time; no lost change; nothing after dispose
At most one publish is in flight. A change marked while a publish is in flight results in a further
publish after it settles (subject to the debounce). After `dispose()`, no timer fires and a publish
that settles later schedules nothing.

## AC-BRR-14 — Automatic backups actually run
`BackupProvider` is mounted for local-key identities. A backup change marked before the scheduler
exists (or from outside the provider tree) is applied once the scheduler starts, exactly once.

## Restore-decision guard (added after adversarial review)

## AC-BRR-12 — A backup awaiting the user's decision is never overwritten
From identity recovery until the user restores or skips a found backup, scheduled backups for that
identity do not publish while the backup may still be restored: each attempt first looks the backup
up; *found* or *newer-version* keeps the pause (attempt counts as done), *unreachable* counts as a
failure (retried), *none* or *unreadable* lifts the pause and publishes. The pause is persisted per
identity and survives a reload.

## AC-BRR-13 — Pending decision re-offered on Settings
Opening Settings while a restore decision is pending for the current identity re-runs the lookup and
shows the confirmation dialog (found) or the outcome notice. Restoring or skipping lifts the pause.

## Verification
AC-BRR-1..3, 8..12 and the outcome mapping of AC-BRR-4 are unit-tested. The UI wiring of
AC-BRR-4/6/7 is covered by the relay-bucket e2e `groups-backup-restore-outcomes.spec.ts` (*no
backup found* notice; found backup → translated dialog → restore). AC-BRR-5 and AC-BRR-13 are
**manual**: they need a relay outage, or leaving mid-decision, that the e2e harness cannot stage
reliably.
