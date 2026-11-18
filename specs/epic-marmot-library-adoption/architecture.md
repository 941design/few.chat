# Architecture — epic-marmot-library-adoption

Living document. All agents read it; the planner adds seams; architects append implementation constraints they discover.

## Paradigm

The top level is a modular monolith (Next.js 14 static-export client app).

- **Module layout:** package-by-feature under `app/src/lib/marmot/`.
- **Seams to `@941design/marmot`:** hexagonal. The library is the only MLS engine, reached through a narrow set of app adapters.
- **Composition root:** the React context (`MarmotContext`) only wires modules and exposes `useMarmot()`. It holds no protocol logic.
- **No-context-import rule:** pure modules under `app/src/lib/marmot/**` take dependencies by injection and never import React contexts (existing rule AC-BOUND-1). New code follows it.

## Module Map

| Module | Purpose | Location | Owned data |
|---|---|---|---|
| `client` (bootstrap) | Builds and owns the one `MarmotClient` per account: signer adapter, SimplePool transport, IndexedDB stores, lease and multi-tab handling, listeners, `groups.list()`, `inbox.start()`, key-package presence, kind-10050 publish, `storeIncompatible` wipe, startup reconciliation, teardown | `app/src/lib/marmot/client/` | the library's account DB `marmot:<pubkey>` (opaque, library-owned) |
| `history` (inbound sink) | App `HistoryBackend`: persists entries `{entry, seq, dispatched}`, dispatches to handlers, withdraw/retract, startup re-dispatch sweep | `app/src/lib/marmot/history/` | idb store `few-group-history:<pubkey>` (per account) |
| `handlers` (app domain, inbound) | Chat, reaction, delete/edit, poll, profile, profile-request, announcement handlers over `{groupId, eventId, rumor, sender}`, with a retract path for withdraw | `app/src/lib/marmot/handlers/` (existing; re-pointed) | chat/poll/reaction/profile stores (existing) |
| `send` (outbound) | `sendGroupRumor` canonical rumor builder plus `group.send`; optimistic-row confirmation and failure detection (D6 triggers) | `app/src/lib/marmot/send/` | none (writes through chat/poll persistence) |
| `invitations` | Invite (key-package lookup D10, single-candidate invite), invite-context rumor (D3, holding store), pending-invitation view over `invitations.pending()`, accept/decline, deny layer and caps (D14), auto-accept correlation (D8), decline durability (D7) | `app/src/lib/marmot/invitations/` | invite-context holding store, pending-direct-invite markers (existing, extended with `inviteeRef` and `declined`) |
| `joinRequests` (app domain) | Join-request protocol on `registerInboxHandler(21059)` / `sendInboxRumor`, approval via `invitations` invite | existing `joinRequest*` files | `few-join-requests`, `few-invite-links`, `few-outbound-join-requests` |
| `membership` | Leave + eligibility (D9), remove member, cancel invitation, setAdmins, rename, removed-by-admin purge ("abandon") | `app/src/lib/marmot/membership/` | none beyond library |
| `kinds` | Kind registry plus import-time collision check (D12) | `app/src/lib/marmot/kinds.ts` | none |
| `media` | Image send/decrypt over `group.encryptMedia`/`decryptMedia`; Blossom upload; app imeta parsing; decrypted cache | existing media files | `few-media-blobs`, `few-media-meta` |
| `backup` | Kind-30078 backup without group sections (D5); configured relays (D17) | `app/src/lib/backup/` | backup payload |
| `MarmotContext` (composition root) | Wires the modules, exposes `useMarmot()` with the existing consumer surface (minus dead fields) | `app/src/context/MarmotContext.tsx` | React state only |
| `ChatStoreContext` / `PollStoreContext` | UI stores; send through `send` | `app/src/context/` | existing |

## Boundary Rules

- No direct imports across module boundaries. Cross-module access goes only through each module's `index.ts` exports. A single-file module (e.g. `kinds.ts`) has no `index.ts`; the file itself is its public surface.
- Only `client/` constructs or disposes the `MarmotClient` or opens stores. Other modules receive a `MarmotClient` / `MarmotGroup` handle by injection.
- Import MLS types only from `@941design/marmot/mls`. Never import `ts-mls` or `@internet-privacy/marmot-ts`.
- **Re-entrancy:** code running inside `HistoryBackend` calls, inbox handlers or client event listeners never awaits an account-scope client call. Exception: handlers may await `groupOf(groupId)` (`client.groups.get`) for live roster/admin gates — inside a history drain the group's runtime is already cached, so the call resolves without a load and without the re-entrancy rejection (verified in S3 against group-runtime.js:1171-1180, 1196-1217).
  - Follow-up client work enters the owned FIFO after the full callback settles. The queue tracks history writes by group and inbox work by its own scope, then starts ready jobs on a timer.
  - `HistoryBackend.append` must settle within 10 s.
- **Sender identity:** group handlers take it only from `orderingKey.account` (passed as `sender`), never from `rumor.pubkey`. Inbox handlers use the seal-bound `rumor.pubkey`.
- **Roster and admin gates in handlers** read live library accessors (`group.members()`, `group.admins`), never the overlay.
- **Privacy invariant:** no public event carries profile metadata. Kind 0 is never published. Profile data travels only in MLS application rumors or NIP-59 gift wraps.
- **Storage:** idb-keyval `update()` is banned repo-wide. New stores use `get`/`set`/`del`/`createStore`.
- **i18n:** all new user-visible text goes through `app/src/lib/i18n.ts` (en and de).

## Seams

Typed cross-story contracts (planner-populated; mirrored in `stories.json#seams`). Producer story defines the contract first; consumers depend on the type, never on the implementation.

### `AppKinds` — App/inbox/retired kind constants
- Producer: S2 `app/src/lib/marmot/kinds.ts` -> Consumer: S3 `app/src/lib/marmot/history/historyBackend.ts`
- Fields:
  - `APP_RUMOR_KINDS`: `readonly [0,5,7,9,10,11,12,30]`
  - `APP_INBOX_KINDS`: `{joinRequest:21059,pairingAck:21060,dmProfile:[21061,21062],inviteContext:21064}`
  - `RETIRED_KINDS`: `readonly [13,21063]`
  - `RESERVED_KINDS`: `values of RUMOR_KINDS`
- Invariants:
  - no two app kinds equal; none equals a RUMOR_KINDS value or retired kind (module throws at import)
  - inviteContext === 21064

### `GroupHistoryHandlers` — Accepted group rumor and its retraction from the history sink to app handlers
- Producer: S3 `app/src/lib/marmot/history/historyBackend.ts` -> Consumer: S4 `app/src/lib/marmot/handlers/groupRumorDispatch.ts` (via S5)
- Fields:
  - `dispatch`: `(input: GroupRumorInput) => Promise<void>`
  - `retract`: `(input: RetractInput) => Promise<void>`
  - `GroupRumorInput`: `{groupId: string; eventId: string; rumor: Rumor; sender: string; receivedAt?: number; reason?: 'withdrawn' | 'purged'}` (`receivedAt` = the row's persisted first-append time in ms, the clock of the dispatch AND of any later fold of the row)
  - `RetractInput`: `GroupRumorInput & {remaining: () => Promise<readonly RemainingRow[]>; batch?: readonly GroupRumorInput[]}` (`batch` = every row withdrawn together with this one, this row included, in `seq` order; absent on a late retract)
  - `GroupKindHandler.retractKey?(input): string | undefined` — the aggregate a retract recomputes (`slot:<sorted slot ids>`, `reactions:<group>:<target>`, `poll:<group>:<poll id>`), undefined for per-row retracts; `createGroupRumorDispatch` runs ONE retract per key and batch (a batch shares one `remaining` function) and the handler drops the state of every batch row naming the aggregate (e.g. all their pinned revs)
  - `RemainingRow`: `{entry: HistoryEntry; seq: number; receivedAt: number}` (ms, persisted at the row's first append; a legacy row without one reads as `rumor.created_at * 1000`)
  - store entry points the handlers call on retract (recompute-on-retract): `recomputeSlot(thread, slotIds, signals)` (`messageEdits/api.ts`), `recomputeMessageReactions(thread, targetMessageId, signals)` (`reactions/api.ts`), `recomputePoll(groupId, pollId, signals)` (`marmot/pollPersistence.ts`); `signals: RecomputeSignal[]` = `{rumor, sender, eventId, seq, receivedAt}` built from `remaining()` by `remainingSignals` (`handlers/groupRumorDispatch.ts`)
- Invariants:
  - retract of a DEPENDENT kind (5, edit-marked 9, 7, 10, 11, 12) recomputes its aggregate (one message slot / one message's reactions / one poll) from base state plus the remaining rows, folded in `seq` order through the same apply/authorisation core as dispatch and effect-free (no bell, unread, known-peers, announcement or send); after any sequence of withdraws the stores equal those produced by dispatching only the remaining rows in `seq` order into empty stores (AC-WDR-7). Plain kind-9 rows keep carrier accounting; losing the last carrier of a base message also recomputes its slot and reactions with the target absent (dependents are re-held and re-apply if the base is re-appended)
  - a kind-9 carrier is registered only for the stored row's own sender (`appendOrAddCarrier` compares the delivering sender to the row's `senderPubkey`): a byte-identical copy delivered by another member is reported duplicate without becoming a carrier, so it can neither keep the row alive after the real delivery is withdrawn nor leave a stale carrier
  - a live dispatch uses the row's `receivedAt` as its clock (delete/edit rev cap via `applyDeleteEditSignal(..., {receivedAt})`, poll receipt stamps via the `receiptNow(atLeast)` port), so a late (recovered) dispatch and a later fold decide alike; the slot base `ChatMessage.original` is captured for every group-thread signal write (sink-delivered and own optimistic, so an own withdrawn edit or delete is dropped, AC-WDR-2) — never for a DM thread (retention)
  - contribution identity is `(rumor.id, sender)`; an effect is attributed only to `orderingKey.account` of a remaining row (AC-WDR-8); the fold's clock is the row's persisted `receivedAt`, never the wall clock (AC-WDR-9)
  - `withdraw` durably marks every row of the batch `withdrawing` BEFORE any retract, then retracts and deletes each marked row IN TURN (incremental: a row is deleted right after its own retract, each step under its own settle bound; a timeout or failing retract leaves the earlier rows deleted and the rest marked, which the next `append`/`withdraw` of the group in the instance, or first-touch recovery after a restart, finishes); `remaining()` = rows that are `dispatched` and not `withdrawing`, in `seq` order, read once per batch (memoised; the late retract of an overrunning dispatch reads it at its own start); undispatched or abandoned rows are never in it (a row still `dispatched:false` is not in `remaining()`: a recompute before its (re-)dispatch resets that row's effects and the re-dispatch applies them again — accepted); a `withdrawing` row found by first-touch recovery or `sweep()` is retracted and deleted BEFORE any re-dispatch and is never re-dispatched itself; a `purged` retract removes outright and never folds
  - accepted residual: live-state gates evaluated by a fold (an admin's delete of an announcement, AC-HIST-11) use the live roster at recompute time and fail closed
  - sender === HistoryEntry.orderingKey.account, never rumor.pubkey
  - dispatch is idempotent per (groupId,eventId) and throws on durable failure
  - the sink is at-least-once (a crash between handler completion and the `dispatched:true` write re-runs the handler on recovery), so idempotency per (groupId,eventId) is the HANDLER's obligation, not the sink's
  - the sink's store is per account (`few-group-history:<pubkey>`); `dispose()` returns a promise (drain of the per-group jobs, bounded by one settle bound) that the client teardown awaits before `client.dispose()`; late retracts pending at dispose are dropped (a withdrawn message whose dispatch completes after dispose keeps its effects; accepted: the account's stores are closing)
  - a live library append of an `abandoned` row re-runs the handlers (a legitimate retry); only recovery skips abandoned rows
  - dispatch/retract never await account-scope client calls
  - retract of an unseen eventId is a no-op
  - the sink keeps one in-flight dispatch per (groupId,eventId): a re-append, recovery or sweep of an id still running (after a 10 s timeout) awaits it, so a handler is never running twice concurrently for one id. Residual overlap: after a timeout a LATER entry's dispatch of the same group may overlap a still-running earlier one, so handlers for dependent kinds (5/7/10-12) MUST tolerate a missing target
  - entries of kinds outside `APP_RUMOR_KINDS` are stored `dispatched:true` permanently and never reach the handlers; they are not replayed if the kind is registered later
  - handlers (S4/S5) obtain group handles through an injected `groupOf(groupId)` backed by `client.groups.get` (AC-HIST-11): `undefined` fails closed (gated effect not applied, no throw, row marked dispatched), a rejection rejects the handler (row stays `dispatched:false`); the sink itself needs no `groupOf`
  - recovery of `dispatched:false` rows is per-group first-touch inside the sink (plus `sweep()` for untouched groups); a row is abandoned after 5 failed recoveries (AC-HIST-7)

### `AccountClientHandle` — The per-account MarmotClient handle injected into feature modules
- Producer: S1 `app/src/lib/marmot/client/index.ts` -> Consumer: S13 `app/src/lib/marmot/membership/index.ts`
- Fields:
  - `client`: `MarmotClient`
  - `pubkey`: `string`
  - `leaseHeld`: `() => boolean`
  - `enqueue`: `ClientJobQueue['enqueue']`
- Invariants:
  - only client/ constructs or disposes the MarmotClient
  - modules receive the handle by injection and never import React contexts
  - no group write while leaseHeld() is false

### `ClientJobQueue` — Owned FIFO for follow-up client work scheduled from listener/handler frames
- Producer: S1 `app/src/lib/marmot/client/fifo.ts` -> Consumer: S5 `app/src/lib/marmot/handlers/*.ts`
- Fields:
  - `enqueue`: `(job: () => Promise<void>, scope?: ClientCallbackScope) => void`
- Invariants:
  - jobs associated with a pending library callback enter the FIFO when the callback settles
  - ready jobs run one at a time in FIFO order, with jobs from each callback retaining their enqueue order
  - a rejecting job does not stall the queue

### `InboxRelayListEnsure` — Port for ensuring the kind-10050 list during bootstrap
- Producer: S1 `app/src/lib/marmot/client/createClient.ts` -> Consumer: S16 `app/src/lib/marmot/client/inboxRelayList.ts`
- Fields:
  - `ensure`: `(ctx:{pubkey:string; relays:string[]}) => Promise<void>`
- Invariants:
  - called exactly once, after key-package ensure
  - publishes only when no 10050 exists or the existing one carries the app client tag

### `LeaseState` — Lease outcome of this tab
- Producer: S17 `app/src/lib/marmot/client/lease.ts` -> Consumer: S18 `app/src/lib/marmot/../../context/MarmotContext.tsx`
- Fields:
  - `state`: `'held'|'waiting'|'unsupported'`
  - `whenReady`: `() => Promise<void>`
- Invariants:
  - whenReady resolves as soon as the lease outcome is known
  - state is 'held' on at most one tab per account
  - membership-derived sweeps run only when state==='held'

### `SendGroupRumor` — Canonical outbound rumor helper
- Producer: S6 `app/src/lib/marmot/send/sendGroupRumor.ts` -> Consumer: S18 `app/src/lib/marmot/../../context/ChatStoreContext.tsx`
- Fields:
  - `sendGroupRumor`: `(group: MarmotGroup, kind: number, content: string, tags: string[][]) => Promise<{id: string; result: unknown}>`
- Invariants:
  - rumor id === getEventHash(rumor) and equals the id seen in the sink echo
  - pubkey is the own account
  - group.send called exactly once per call; no retry in the helper

### `GroupOpQueue` — Serialised commit-producing group operations
- Producer: S6 `app/src/lib/marmot/send/groupOpQueue.ts` -> Consumer: S8 `app/src/lib/marmot/invitations/invite.ts`
- Fields:
  - `run`: `<T>(groupId: string, op: () => Promise<T>) => Promise<T>`
- Invariants:
  - at most one invite in flight per group
  - group.synced() awaited before invite/removeMember/setAdmins/rename/leave; the wait is BOUNDED (`syncTimeoutMs`, default 30 s) and abortable (`signal`); a wait lost before the op starts rejects `GroupOpError` (`not-synced` / `aborted`, "no attempt is in flight") and the op never runs; leave may skip it (`skipSync`)
  - commit-pending is branched on `details.reason`: own pending commit / selfremove-election-wait / staged-adds-commit-unconfirmed are retried after an `ingest([])` barrier (bounded by `syncTimeoutMs`, abortable, a throwing ingest is logged) plus backoff; awaiting-sync after a bounded `synced()`; proposal-deferred and unknown reasons are surfaced at once

### `KeyPackageInvite` — Single-candidate invite via key-package lookup
- Producer: S8 `app/src/lib/marmot/invitations/invite.ts` -> Consumer: S12 `app/src/lib/marmot/joinRequestApproval.ts`
- Fields:
  - `inviteByPubkey`: `(group: MarmotGroup, pubkey: string, opts?) => Promise<InviteOutcome | {error:'no usable key package', reason, attempts} | {error:'already-member'}>` (`already-member`: the pubkey already holds a leaf of the group, checked inside the queued op after `synced()`; no commit is made)
- Invariants:
  - group.invite receives exactly one key-package event
  - candidates ordered created_at desc, tie lower event id
  - only a per-candidate invalid-options (details.reason verifier / invalid-keypackage / ineligible) falls through to the next candidate; any other error (reason-less invalid-options, not-admin, ...) is thrown unchanged; exhaustion yields 'no usable key package'
  - at most 6 candidates (newest first); advertised relays must be public wss hosts, app-configured defaults are used as given; abort is `GroupOpError('aborted')`

### `PendingInvitationView` — Pending invitations as the single pending store
- Producer: S9 `app/src/lib/marmot/invitations/pendingView.ts` -> Consumer: S10 `app/src/lib/marmot/invitations/invitationCardViewModel.ts`
- Fields:
  - `pending`: `() => PendingInvitation[] (groupId, sponsorAccount, sponsors, id)`
  - `onChange`: `(cb) => unsubscribe`
- Invariants:
  - invitations.pending() is the only source; lp_pendingInvitations_v1 never read
  - blocked-sender entries never appear
  - retention (AC-CAP-1, D14): stranger invitations expire after 14 days (trusted = own account or ever-known peer never expire); 8 per inviter; 256 total ranked trusted-first, then already-shown, then oldest; all declines silent ({declineRumor:false}); `seed()`/`refresh()`/`onInboxDisposition` entries, injected `isTrustedSponsor` and `now`

### `DenyLayer` — Block predicate for invitations, contexts and join requests
- Producer: S9 `app/src/lib/marmot/invitations/denyLayer.ts` -> Consumer: S10 `app/src/lib/marmot/invitations/inviteContextHandler.ts`
- Fields:
  - `isBlocked`: `(pubkey: string) => boolean`
- Invariants:
  - blocked sender: nothing stored, no bell
  - invitation from blocked sender is declined with {declineRumor:false}

### `PendingDirectInviteMarker` — Pending-direct-invite marker extended for decline durability
- Producer: S11 `app/src/lib/marmot/pendingDirectInviteStorage.ts` -> Consumer: S14 `app/src/lib/marmot/membership/cancelInvitation.ts`
- Fields:
  - `inviteeRef`: `string`
  - `pubkey`: `string`
  - `declined`: `boolean`
  - `leafKey?`: `string` — signature key of the leaf the invite added (recorded only when exactly one new leaf is derivable); the decline is bound to this leaf, not to the account
  - `phase?`: `'declined' | 'removing' | 'announce-pending'` — absent = `'declined'`; written `removing` before the Remove commit and `announce-pending` after it resolved
- Invariants:
  - inviteeRef (and leafKey when derivable) persisted at invite time
  - declined set durably before any removal work
  - the marker is re-read inside the queued op; a replaced (other inviteeRef) or cleared marker aborts the removal
  - only the declined leaf is removed: other leaves of the account are never evicted (`superseded`)
  - marker cleared only by compare-and-clear on inviteeRef, after the Remove resolved and the announcement was sent (at-least-once, stable dedup id `groupId:inviteeRef`)
  - an unknown inviteeRef is kept as an orphan decline (max 50, 7-day TTL) and adopted by a later record of that ref
  - legacy markers without inviteeRef are ignored without throwing

### `GroupDataPurger` — Local group purge (abandon) path
- Producer: S13 `app/src/lib/marmot/membership/purgeLocalGroup.ts` -> Consumer: S17 `app/src/lib/marmot/client/reconcile.ts`
- Fields:
  - `purgeLocalGroup`: `(groupId: string, options?: { ownAccountIsMember?: boolean }) => Promise<void>` (`options.ownAccountIsMember` bypasses the re-join guard for the readable sole-member abandon only)
  - `withGroupLock`: `<T>(groupId: string, fn: () => Promise<T>) => Promise<T>` (exported by the purger, `LocalGroupPurger`; per-group FIFO async lock, not re-entrant; the purge runs inside it and `createInvitationActions.accept` runs the library accept inside it, so purge and accept of one group id exclude each other; the `purge` port is required by `createInvitationActions` and `createAutoAccept`)
  - `isPurging` / `whenPurged`: in-flight (running or queued) purge view
- Invariants:
  - calls group.abandon() and removes overlay, member profiles, chat/poll rows, history rows, invite links, markers
  - idempotent on second call
  - an undeletable group (library state cannot be loaded) keeps its overlay row (retry key), is marked `unloadable` (optional `markUnloadable` port) and the purge rejects with `PurgeError.unloadable === true`

## Implementation Constraints

- **Dependency pins:**
  - `@941design/marmot@0.2.0-alpha.0`, `@941design/marmot-engine@0.2.0-alpha.0` and `@941design/nostr-events@0.2.0-alpha.0` are pinned exact.
  - `nostr-tools@2.23.3` is pinned exact.
  - Remove `@internet-privacy/marmot-ts` and the `ts-mls` git dep.
  - Remove `@hpke/*` and `@noble/post-quantum` only if nothing else imports them.
- **Install:**
  - Dependency changes go through `make deps` (platform stamp). Never use bare `npm install` without re-stamping.
  - npm on this host can drop random `.js` files. Verify the install with a resolve check of the new packages' subpath exports.
- **`next.config.mjs`:** the swc-loader include gains `@941design/*` and keeps `/node_modules\/ts-mls/`. `swcMinify:false` stays.
- **Client-only:** construct the library only in browser effects. No top-level browser API access in SSR paths.
- **Library timing options:**
  - `leaveTimeoutMs: 10000`, `removalSettleMs: 5000`.
  - Tests may set `historySilenceThreshold`/`historyTimeoutMs` low.
- **Unit tests:**
  - vitest, `tests/unit/**/*.test.ts`, no jsdom. Hooks are tested via extracted pure functions.
  - In-process library tests use `createMemoryStorage()` plus `FakeRelay` from `@941design/nostr-events/transport/contract/conformance` with `// @vitest-environment node`. That module imports `node:` modules: test-only, never bundled.
  - Seed idb mocks out of key order where order matters.
- **E2E:**
  - Publish through the app only, never raw WebSocket.
  - Relay-dependent specs must be named `groups-*` / `dm-*`.
  - Wipe the relay (`down -v`) before relay runs.
  - Never edit `app/` while e2e runs.
  - Full gate: `make test`.
- **Serialize invites:** at most one in-flight `group.invite` per group.
- **Sync before commits:** await `group.synced()` before invite, removeMember, setAdmins, rename or leave on a loaded group (or handle `commit-pending`).

## Order-Sensitive Composition

**Yes.** This epic composes order-sensitive subsystems.

1. **Inbound delivery flow** (library pipeline → `HistoryBackend.append`/`withdraw` → handlers → app stores → UI)
   - Modules: `history` (`app/src/lib/marmot/history/`), `handlers` (`app/src/lib/marmot/handlers/`), chat/poll persistence (`app/src/lib/marmot/chatPersistence.ts`, `pollPersistence.ts`).
   - Guarantees across orderings, interleavings and crash/redelivery:
     - (a) each kind-445 event's handler effects are applied exactly once in effect, whatever the redelivery count;
     - (b) a crash between persist and dispatch is re-dispatched (dispatched-flag recovery: per-group first touch in the sink, plus a startup sweep after `groups.list()` for untouched groups; recovered rows precede newer entries of the same group; a row is abandoned after 5 failed recoveries);
     - (c) `withdraw` after `append` leaves no trace of other members' content; `withdraw` before or without `append` is a no-op;
     - (d) `list` returns per-group delivery (`seq`) order;
     - (e) own-send echo and optimistic row converge to one row by `rumor.id`, whatever the arrival order versus the `send()` resolution.
2. **Own-send lifecycle** (optimistic row → `send()` → sink confirmation | `intentFailed` | `groupBranchSwitched` | 60 s timeout)
   - Modules: `send` (`app/src/lib/marmot/send/`), `history`.
   - Guarantee: the detection triggers (send reject, `intentFailed`, `groupBranchSwitched`, 60 s timer) never downgrade a row already confirmed through the sink, and an unconfirmed row reaches failed/retry under any trigger ordering. An explicit sink `withdraw` of an own entry (observed: confirmed own messages on a losing branch ARE withdrawn) moves the row to failed/retry, never deletes it (AC-WDR-2).
3. **Invitation flow** (Welcome → `inboxDisposition: pending` → deny/cap filter → invite-context arrival in either order → accept/decline; decline → durable marker → removal after `synced()` across restarts)
   - Modules: `invitations` (`app/src/lib/marmot/invitations/`), `joinRequests`.
   - Guarantees: correct result in either context/invitation order; a decline is never lost across an offline or unsynced sponsor; auto-accept happens at most once per outbound request.
4. **Lifecycle / lease** (lease acquire → client build → `groups.list()` → reconciliation purge → `inbox.start()`; `storeIncompatible` wipe at most once per load; tab hand-over)
   - Module: `client` (`app/src/lib/marmot/client/`).
   - Guarantee: no group write or membership-derived sweep happens without the lease, and a wipe never loops.
