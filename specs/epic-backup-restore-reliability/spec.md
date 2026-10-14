# Backup & restore reliability

**Status**: Implemented (2026-10-14)

## Problem

The encrypted relay backup (`app/src/lib/backup/relayBackup.ts`, `docs/behavior/backup-and-recovery.md`)
fails silently at both ends:

1. **Restore reports success when nothing was restored** (backlog
   `state-restore-reports-success-even-when`). After an identity recovery, an unreachable relay, a
   missing backup, and a backup written by a newer app version all fall through to the same
   "Identity restored" success with no state restored. `fetchBackup` discards the relay-timeout
   signal, so the library cannot even tell "unreachable" from "no backup".
2. **A malformed backup is partially applied.** `fetchBackup` validates only `version`;
   `restoreFromBackup` writes localStorage and IDB sequentially, so a structurally broken payload
   throws midway after earlier categories were already overwritten.
3. **Applying a backup that fails shows "Invalid recovery phrase"** — the wrong error, after the
   phrase was already accepted.
4. **The restore confirmation dialog is wrong and untranslated.** It is hardcoded English and
   claims restore "will replace all local data … cannot be undone", but restore is a
   non-destructive merge.
5. **Failed scheduled backups are dropped** (review task R17). `publishBackup` reports failure as
   `{ ok: false }`; the scheduler callback ignores it, and a missing NDK instance silently skips.
   The debounce clock is stamped before success, so nothing retries until the next change.

6. **Automatic backups never ran.** `BackupProvider` was added with the feature (2026-03-25) but
   never mounted in `_app.tsx`, so every `markDirty` hit the no-op fallback and no backup was ever
   published. Even mounted, a context-only hand-off would miss profile changes (`ProfileProvider`
   sits above the identity provider) and drop marks made before the scheduler exists. Found by
   this epic's e2e spec.

Surfaced by the 2026-10-14 mutation audit of `relayBackup.ts` and the 2026-09-26 project review.

## Product decisions (owner, 2026-10-14)

- Distinct restore outcomes — **four**: *restored*, *no backup found*, *relays unreachable*,
  *backup unusable* (newer version and unreadable/corrupt share one message that suggests
  updating the app).
- *Relays unreachable* offers a **Check again** action that re-runs only the backup lookup (the
  identity is already restored at that point).
- **No backup-status UI** in this epic: failed scheduled backups retry silently in the background.
- **Switch automatic backups on** (problem 6) — the documented, self-encrypted relay backup
  including MLS group state (owner confirmed 2026-10-14, after being told it had never run).
- A recovery whose found backup is still **undecided** (user left, or relays were unreachable) is
  **re-offered on the next Settings visit**; until then scheduled backups stay paused.
- **External-signer users** (NIP-07 / NIP-46) get no scheduled backup today (the provider requires
  a local private key). Out of scope here — documented as a limit and filed as a backlog finding
  (belongs with signer-authority work, review task R04).

## Solution

### Story 1 — Honest restore outcomes (problems 1–4)

- `fetchBackup` returns a discriminated lookup result instead of `null`/throw:
  `found` (with a validated payload) · `none` · `unreachable` · `unusable` (reason
  `newer-version` | `unreadable`, for logging only). It never throws. *Unreachable* means the relay
  query timed out with no events; decryption, JSON, and shape failures are *unreadable*; a
  `version` greater than 1 is *newer-version*.
- A hand-rolled validator (`parseBackupPayload`) checks the full v1 shape before anything is
  written, including that every MLS group-state entry is decodable base64. Missing optional
  collections are normalised to empty (older v1 payloads lack `inviteLinks`).
- `restoreFromBackup` performs all fallible IDB writes first and the localStorage writes
  (settings, profile, backed-up flag) last, so a mid-restore IDB failure does not leave a
  half-switched settings/profile.
- Settings restore flow: on *none* / *unusable* / *unreachable* the identity-success alert is
  accompanied by an outcome message; *unreachable* carries a **Check again** button. A failure
  while applying a found backup shows a backup-specific error.
- The confirmation dialog is translated (en/de) and describes the merge truthfully.

- **Restore-decision guard** (found in adversarial review — pre-existing data-loss risk): after
  `replaceIdentity` the provider immediately schedules backups for the recovered identity, and
  any trigger (tab hidden, a Welcome being processed, a profile save) could publish the device's
  near-empty state as the replaceable kind 30078 event — overwriting the real backup before the
  user restores it. Recovery now persists a per-identity "restore pending" marker; while it is set,
  a scheduled attempt looks the backup up first and publishes only once there is nothing to protect
  (no backup, or an unreadable one). A backup from a newer app version stays protected.

### Story 2 — Scheduled backup retries (problems 5 and 6)

- `BackupProvider` is mounted (client-only) inside the identity provider. `markDirty` is routed
  through a module-level hand-off that forwards to the active scheduler or remembers the mark
  until one starts, so marks from providers outside it, or from before identity hydration, are
  not lost.

- The scheduler's publish callback reports success; a resolved `false` or a rejection is a
  failure. The provider maps `{ ok: false }` and a missing NDK instance to failure.
- The debounce window is measured from the last **successful** publish.
- After a failure the scheduler retries with backoff 30 s → 2 min → 10 min (then 10 min), at most
  5 retries; any new change resets the retry budget but does not bypass a pending retry. No UI is
  shown.
- A change during an in-flight publish is not lost: it triggers a follow-up publish afterwards.

## Scope

### In scope
`app/src/lib/backup/relayBackup.ts`, `app/src/context/BackupContext.tsx`, the restore section and
backup dialog of `app/pages/settings.tsx`, `app/src/lib/i18n.ts`, unit tests, the
backup-and-recovery behaviour doc, `specs/relay-backup.md` cross-reference.

### Out of scope
Cross-account isolation of backups (review R03), external-signer backups (R04), a backup-status
indicator, changing the payload schema or version.

## Non-functional

- Privacy invariant unchanged: backups remain NIP-44 self-encrypted kind 30078; no profile data
  is published unencrypted.
- All new UI strings in en and de.
