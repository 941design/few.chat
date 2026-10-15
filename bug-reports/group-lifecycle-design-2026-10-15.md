# Group lifecycle design — leave purge + self-eviction (Fable consult, 2026-10-15)

Findings: `left-groups-keep-mls-state-forever`, `reinvite-after-eviction-fails-already-exists`.

## Verified facts (installed marmot-ts / ts-mls dist)
- `sendApplicationRumor` awaits relay acks and throws if none acked (marmot-group.js:532-540) → awaiting
  the leave kind-9 means a relay has it. `groups.destroy` is local-only: purges history/media/state/
  snapshots, emits `destroyed`, clears the manager cache (marmot-group.js:1687-1707, groups-manager.js:206-216).
- ts-mls detects self-eviction: a commit removing our leaf yields `newState.groupActiveState =
  {kind:"removedFromGroup"}` (ts-mls processMessages.js:175-186), serialized with the state
  (clientState.js:66,95), later sends throw (clientState.js:139-140). Nothing in the app inspects it.
- A Welcome's epoch is readable pre-join via readWelcomeGroupInfo → groupContext.epoch (core/welcome.js:105-121).

## Part 1 — destroy MLS state after leave/abandon (actionable, no product decision)
1. leaveGroupImpl: write tombstone {groupId, leftAt} (new IDB store few-left-groups, cleared by
   clearAllGroupData, never backed up) BEFORE removeGroupFromStorage; keep purge/navigation immediate.
   Chain on the kind-9 promise: then/catch → withTimeout(5s) → groups.destroy(id) → delete tombstone.
   Abandon path (no send): destroy inline.
2. Startup sweep (loadGroupsAndReconcileInvitations, after loadAll, before dropInvitationsForJoinedGroups):
   tombstone + groups.has(id) + no overlay → destroy under withGroupJoinLock(id), drop tombstone.
   Tombstone is the discriminator (interrupted create / in-flight accept never have one).
   joinIdempotent's orphan branch also deletes the tombstone after its destroy.
3. Backup: collectBackupPayload exports only state keys of overlay groups minus tombstoned ids.
   Restore stays add/update-only (per-device leave semantics; note in docs).
4. Docs: docs/behavior/groups.md §12 says no admin eviction of present members, but MemberList +
   AC-REMOVE-4 evict confirmed members — correct the doc (code wins).
Tests: leaveGroupImpl ordering (resolve/reject/timeout; abandon inline; tombstone before overlay delete);
relayBackup exclusion; sweep cases (no tombstone → untouched; tombstone+overlay → untouched;
tombstone+no overlay → destroyed); e2e: leave → peer sees "left" announcement, then few-groups-state
entry gone.

## Part 2 — self-eviction + re-invite after eviction (BLOCKED on product decisions)
Design: detect `groupActiveState.kind === 'removedFromGroup'` in EpochResolver next to onMembersChanged
(+ startup check over loadAll) → handleSelfRemovalImpl: mark overlay removedAt → groups.destroy →
clearRumorJournalForGroup → reloadGroups → markBackupDirty; groupSubscriptionKey built from
groups without removedAt. Re-invite: readPreJoinGroupData returns epoch; in joinIdempotent, if
overlay exists and welcomeEpoch > local epoch → destroy + fresh join (Welcome may arrive before the
Remove commit is ingested); else keep the replayed-Welcome short-circuit.
Product questions (owner):
- What does a removed member see — silent disappearance (like leave) or the group kept read-only with
  a "you were removed" notice + dismiss?
- After a re-invite, is the old local chat history kept and continued, or does the re-join start fresh
  (today a re-join after leave starts fresh)?
