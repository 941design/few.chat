# Blocks and other local changes made in one tab don't reach other open tabs

Source: BACKLOG.json finding `block-revision-sibling-revision-counters-have`, promoted 2026-10-15.
Design: bug-reports/multi-tab-design-2026-10-15.md — **S0 only** (S1, the single active MLS client, is
blocked on owner product decisions and is OUT OF SCOPE).

## Description
Revision counters in MarmotContext (blockedPeersRevision, knownPeersRevision, contactsRevision, group data
versions, …) are plain React state. A block made in tab A has no effect in tab B until reload: tab B keeps
showing/admitting the blocked contact, its badges and lists stay stale, and new groups/chat writes from the
other tab are not reflected.

## Adopted fix (S0)
- app/src/lib/crossTab.ts: one BroadcastChannel('few-tabs'), typed `store-changed {store, id?}` messages
  (stores: blocked, known, contacts, groups, chat, polls, journal as needed); the channel never echoes to the
  sender; SSR/Node-safe no-op shim; unit-testable with an injected channel.
- Writers post after a successful write: blockedPeers.ts / blockContactAction.ts → blocked; knownPeers.ts /
  contacts.ts → known/contacts; groupStorage.saveGroup/deleteGroup → groups; chatPersistence appends/updates
  → chat (with groupId); poll and reaction stores → polls/reactions where a reload hook exists.
- Receivers bump the existing revision counters / call the existing reload functions (reloadGroups,
  ChatStoreContext reload for the mounted group, poll version). No new UI, no new state stores.
- Only notifications; no cross-tab MLS coordination (that is S1).
