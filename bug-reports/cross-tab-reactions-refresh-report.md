# Reactions added in one tab do not appear in another open tab until reload

Source: BACKLOG.json finding `cross-tab-reactions-refresh` (filed 2026-10-15, left out of the cross-tab S0
change `69b71d0`; design context `bug-reports/multi-tab-design-2026-10-15.md` S0).

## Description

`app/src/lib/reactions/api.ts` answers `loadReactions` from a module-level in-memory cache once a thread
has been loaded (cache-first since `c64fe0f`). The S0 cross-tab channel (`app/src/lib/crossTab.ts`)
carried store-changed notices for blocked/known/contacts/groups/chat/polls only: reaction writes posted
nothing, and nothing in a receiving tab invalidated its reaction cache. So a reaction added or removed in
tab 1 (own or incoming, group or DM) stayed invisible in tab 2's open conversation until reload; bumping a
version counter would not help because the re-read is served from the stale cache.

Verified against HEAD `3166fdb` before fixing: the new two-tab unit test fails 18 of 21 cases on HEAD
sources (no post, no refresh, stale cache).

## Expected

A reaction write in one tab shows in the same thread open in another tab of the same browser without a
reload, and the cross-tab refresh never re-opens the badge-revival race (a removed badge reappearing).

## Badge-revival guard (what must not regress)

`c64fe0f` made `loadReactions` cache-first because a direct IDB read racing an in-flight
`applyOptimisticRemoval` returned the pre-removal row and put the removed badge back into the cache. A
naive cross-tab fix (drop the cache entry, or re-read IDB directly on receipt) re-opens exactly that race.

## Fix

- `reactions/api.ts`: every write through `enqueue` (applyOptimistic, applyOptimisticRemoval,
  rollbackOptimistic, applyInboundRumor — DM and group, own and incoming) and the peer wipes
  (`clearDmReactionsForPeer`, `purgeStrangerDmReactions`) post `store-changed {store:'reactions', id:<thread
  namespace key>}` after the IDB write settles. No-op writes (dedup, nothing to remove) post nothing.
- New `refreshReactionsFromStorage(key)`: queued on the thread's own write queue, so it runs only after
  every write this tab already started for that thread has persisted; then re-reads that one thread from
  IDB into the cache and notifies its listeners (ChatStoreContext / useDirectReactions already recompute
  on those). Skipped for a thread neither cached nor subscribed, and while `clearAllReactions` runs. Never
  rejects; a failed re-read keeps the cache and notifies nobody. Read-only: never writes or posts.
- `loadReactions` cold path no longer overwrites a cache entry that a write or refresh filled while its
  read was in flight.
- `crossTab.ts` gains the `reactions` store; `crossTabReceiver.ts` maps it to `refreshReactions(id)`
  (unscoped notices refresh nothing — no blanket cache drop); `MarmotContext` wires it to
  `refreshReactionsFromStorage`.

## Decision: post after a settled write, not only after a successful one

The S0 writers post only after a successful write. Reactions post after the IDB write settles, including a
rejected one: a rejected IndexedDB write is indeterminate (it may have committed), and the receiver only
re-reads stored state, so a spurious notice is harmless while a missing one would leave the other tab
stale. Documented at `reactions/api.ts#announce` and in the `crossTab.ts` contract comment.

## Remediation round 1 (lead: reviewer ACCEPTED with the docs condition; Codex 1 high + 2 medium)

1. **Codex high / reviewer F1: a cross-tab lost update brings a removed badge back.** `enqueue` now runs
   each read-modify-write under `navigator.locks.request('few:reactions:' + key, …)` when Web Locks exist
   (the `allocateVoteSeq` pattern); otherwise the in-tab queue only. The lock is taken INSIDE the per-key
   in-tab queue, so the c64fe0f ordering is unchanged. Two-instance test of the reviewer's scenario (both
   tabs from `[👍]`, A ingests ❤ with its write held, B removes 👍): with a shared fake Web Locks, storage
   and both caches end at "removed 👍 + ❤"; without Web Locks the lost update (👍 back) is pinned as known
   behaviour. `reactions-and-emoji.md` §8 now says the guarantee holds where the browser supports Web
   Locks and that without them a simultaneous write in two tabs can still bring a removal back.
2. **Codex medium: refresh storms.** `refreshReactionsFromStorage` is coalesced per key: at most one
   queued plus one running; a notice while one is queued returns the queued promise (it reads the latest
   state when it runs). Tests: three notices while queued → same promise, one re-read, one emit; a notice
   while one is running queues exactly one more; a 10-write storm from the other tab ends at the latest
   state with ≤ 10 re-reads.
3. **Reviewer F2: refresh racing a peer wipe.** Per-key in-progress counter set by
   `clearDmReactionsForPeer` / `purgeStrangerDmReactions` (begin after the keys are known, end in
   `finally`); the refresh checks it after its read and before `cache.set` and then leaves the cache
   alone. A refresh that started reading before the wipe cannot outlive it (the wipe drains the key's
   queue, which holds the refresh), so no epoch is needed. Tests: refresh during each wipe's delete never
   re-caches; two overlapping wipes keep the guard until the last ends; after a wipe a refresh caches and
   notifies again; each wipe waits for an in-flight write (key not re-created — pre-existing drain, now
   tested).

Filed as follow-ups by the lead (not done here): re-reading storage after a rejected write;
`clearAllReactions` / account switch across tabs.
