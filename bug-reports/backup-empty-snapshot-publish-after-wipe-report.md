# A wipe or account switch can overwrite the old account's relay backup with a wiped snapshot

Source: BACKLOG.json finding `backup-empty-snapshot-publish-after-wipe` (filed 2026-10-17,
AGENT-DECIDES loop item 5).

## Actual
The BackupScheduler bound to the old key keeps running while local data is wiped or the identity
is switched:
- Danger Zone wipe: `resetAllData()` clears storage, then the page reloads. The unload fires
  `visibilitychange: hidden` → `markBackupDirty(true)` → an immediate publish that snapshots the
  already-wiped storage under the old key.
- Peer tab: on the cross-tab `account-changed` notice it calls `window.location.reload()`. The same
  unload path publishes the wiped (or new-identity) storage under the tab's old key.
- Seed-phrase restore / identity switch: an attempt already in flight for the old key can snapshot
  storage after the new identity's data has been written.

The backup is self-encrypted (privacy-neutral), but it replaces the old account's only recovery
copy with an empty or foreign snapshot.

## Expected
Once this tab has begun wiping or switching away from an account, nothing more is published as
that account's backup in this page lifetime: no unload flush, no scheduler tick, no in-flight
attempt reaching the relay, and no persisted dirty mark that would replay later.

## Test
Unit: wipe then an unload flush or scheduler tick publishes nothing. An in-flight attempt that
started before the wipe or switch does not publish. The account-changed reload suspends backups
before reloading. The normal path, an identity change in the same tab, still backs up the new
identity.
