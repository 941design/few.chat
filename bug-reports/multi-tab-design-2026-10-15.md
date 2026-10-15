# Multi-tab coherence — design (Fable consult, 2026-10-15)

Findings: `multi-tab-mls-cache-coherence`, `block-revision-sibling-revision-counters-have`.

Recommendation: single active MLS client per origin with "act-to-claim" (no BroadcastChannel RPC) plus a
storage-level write fence. Rejected: every tab active + invalidation (cannot fix the sender-ratchet hazard —
two tabs sending from the same leaf/generation → undecryptable — nor same-epoch commit forks without a lock +
reload-before-every-op, i.e. (a) with worse ergonomics). Verified: no service worker / manifest; only cross-tab
primitive today is withGroupJoinLock.

## S0 — cross-tab change notifications (no user-visible change; closes the block finding) ~1 day
- app/src/lib/crossTab.ts: one BroadcastChannel('few-tabs'), typed messages `store-changed
  {store:'blocked'|'known'|'contacts'|'groups'|'chat'|'polls'|'journal', id?}` (+ later leader messages);
  never echoes to the sender; SSR/Node-safe no-op shim.
- Writers post: blockedPeers.ts / blockContactAction.ts → blockedPeersRevision; knownPeers.ts / contacts.ts →
  knownPeersRevision / contactsRevision; groupStorage.saveGroup/deleteGroup → reloadGroups() + groupDataVersion;
  chatPersistence puts → ChatStoreContext reloads the mounted group; poll/reaction stores likewise.
- Tests: unit with a fake BroadcastChannel; e2e two pages in one context: block in tab 1 → tab 2's mounted
  ContactChat stops showing/persisting the blocked contact (reuse dm-block-contact fixtures).

## S1 — single active client (BLOCKED on product decisions) ~3–4 days
- clientLease.ts: navigator.locks 'few-mls-client' held for page life; leaseId in localStorage written inside
  the lock callback; heartbeat 5 s; a visible follower steals after 15 s without heartbeat; voluntary handover on
  'leader-claim' (dispose subscriptions/resolvers, groups.unload, return from the lock callback).
- Write fence in IdbGroupStateBackend.setItem/removeItem: lease mismatch → throw StaleLeaseError, log
  mls:stale-lease-write-refused, demote (also makes thawed zombie leaders and post-destroy write-backs harmless).
- MarmotContext constructs MarmotClient only as leader; followers render from IDB; actions in a follower call
  becomeLeader() then run locally. Backup scheduling leader-only. withGroupJoinLock stays.
- Tests: fake LockManager/BroadcastChannel unit tests (grant, steal only when visible, dispose-then-release);
  e2e groups-multi-tab-leader.spec.ts (accept in tab 1, send from tab 2 → Bob decrypts; roles flip; leader close
  → survivor receives; optional frozen-leader steal via CDP).
- Risks: pages holding Web Locks are excluded from bfcache; Safari ≥15.4 for navigator.locks (fallback = status
  quo); NIP-46 signer override must re-run in the new leader; cap handover with a timeout then steal.

Product questions (owner):
1. What does the non-active tab show — read-only mirror with a disabled composer + one-line notice and a
   "Use here" button (recommended), or a full takeover screen?
2. When does a tab become active — on the user's first action there (recommended), on focus, or only via the button?
3. en/de copy for the notice and button.
