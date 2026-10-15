# Leaving or abandoning a group keeps its MLS state (secrets, history) forever

Source: BACKLOG.json finding `left-groups-keep-mls-state-forever`, promoted 2026-10-15.
Design: bug-reports/group-lifecycle-design-2026-10-15.md — Part 1 (adopted; Part 2 / eviction is
blocked on owner product decisions and is OUT OF SCOPE here).

## Description
leaveGroupImpl → removeGroupFromStorage = groupStorage.deleteGroup deletes only the overlay record;
the MLS group state in IDB few-groups-state stays forever, is loaded into marmot's cache at every
startup, and is exported by relay backups (relayBackup collectBackupPayload iterates every state key)
and restored on every device. Key material outlives membership.

## Adopted fix (Part 1 of the design doc — implement exactly)
1. leaveGroupImpl: tombstone {groupId, leftAt} in a new IDB store few-left-groups (cleared by
   clearAllGroupData, never backed up), written BEFORE removeGroupFromStorage; purge/navigation stay
   immediate; chain on the kind-9 send promise: then/catch → withTimeout(5 s) → marmotClient.groups.destroy(id)
   → delete tombstone. Abandon path (no send): destroy inline.
2. Startup sweep in loadGroupsAndReconcileInvitations (after loadAll, before dropInvitationsForJoinedGroups):
   for each tombstone with groups.has(id) and no overlay → destroy under withGroupJoinLock(id), drop the
   tombstone. joinIdempotent's orphan branch also deletes the tombstone after its destroy.
3. collectBackupPayload exports only state keys of overlay groups minus tombstoned ids.
4. docs/behavior/groups.md: document that leaving removes the group's keys/history from the device
   after the departure is sent; correct §12's stale claim that admins cannot evict present members
   (MemberList + AC-REMOVE-4 do) — describe current behaviour only (code wins); do NOT describe what an
   evicted member sees (open product question).
Privacy invariant unaffected (destroy is local; no new publishes).
