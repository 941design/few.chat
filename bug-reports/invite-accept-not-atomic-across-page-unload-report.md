# Group invite accept is not atomic across a page unload; re-invite after leave always fails

Source: BACKLOG.json finding `invite-accept-not-atomic-across-page-unload` promoted 2026-10-15.

## Description (verified: explorer + marmot-ts dist research + Fable design consult)

Accept path: app/src/lib/marmot/welcomeSubscription.ts acceptPendingInvitation (~:1334-1383) →
joinGroupFromWelcomeCore (~:511-532): marmotClient.joinGroupFromWelcome (marmot-ts: markUsed key package
→ groups.adoptClientState → group.save into IDB few-groups-state/state, key = group hex) → build Group
overlay → saveGroup (IDB few-groups-meta/groups) → removePendingInvitation (localStorage) → reloadGroups.
Auto-accept (~:958-1003) shares the core.

1. Unload after MLS save, before saveGroup: MLS state persisted, no overlay, invitation pending. Retry →
   adoptClientState throws "Group <hex> already exists" (groups-manager.js ~:170) → catch (~:1363-1370)
   removes the invitation + "This invitation is no longer valid" → user is MLS member of a group they
   never see.
2. Unload after saveGroup, before removePendingInvitation: joined card + stale invitation.
3. NEW (same root cause): leave purges only the overlay (leaveGroupImpl.ts ~:149 → groupStorage deleteGroup);
   MLS state stays. Re-inviting a user who left → accept → "already exists" → "no longer valid". Re-invite
   after leave is therefore always broken.

## Design (Fable consult, adopted)

- joinGroupFromWelcomeCore: resolve the Welcome's group id PRE-JOIN (pending entry groupId; else
  readWelcomeGroupInfo(...).groupContext.groupId as at ~:595-604; never from welcomeRumor.pubkey). If
  marmotClient.groups.has(id):
  - overlay record exists → already joined: return the existing Group without joining (callers then remove
    the invitation and fire onGroupJoined).
  - no overlay → orphan (interrupted accept or leave residue): await marmotClient.groups.destroy(id) (local
    only; purges state/history/media/cache — never raw store deletes), then normal joinGroupFromWelcome.
  Keep the existing catch as last resort.
- Startup (MarmotContext init after groups.loadAll()): drop pending invitations whose non-empty groupId
  already has an overlay record (skip legacy empty-groupId entries).
- NOT in scope: global startup purge of orphan MLS groups; destroy-on-leave; re-invite after eviction.

## Expected

Reload at any point during accept → exactly one joined group card, no invitation; re-invite after leave → accept works.

## Constraints

Both accept paths stay on the shared core; privacy untouched (destroy is local, no publishes added).
