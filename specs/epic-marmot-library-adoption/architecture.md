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
| `history` (inbound sink) | App `HistoryBackend`: persists entries `{entry, seq, dispatched}`, dispatches to handlers, withdraw/retract, startup re-dispatch sweep | `app/src/lib/marmot/history/` | idb store `few-group-history` |
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

- No direct imports across module boundaries. Cross-module access goes only through each module's `index.ts` exports.
- Only `client/` constructs or disposes the `MarmotClient` or opens stores. Other modules receive a `MarmotClient` / `MarmotGroup` handle by injection.
- Import MLS types only from `@941design/marmot/mls`. Never import `ts-mls` or `@internet-privacy/marmot-ts`.
- **Re-entrancy:** code running inside `HistoryBackend` calls, inbox handlers or client event listeners never awaits an account-scope client call.
  - Follow-up client work is enqueued onto an owned FIFO (jobs start in a later macrotask, after the enqueuing synchronous frame returns); enqueue as the last action of a handler/sink call, after its own awaits.
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
  - `retract`: `(input: GroupRumorInput) => Promise<void>`
  - `GroupRumorInput`: `{groupId: string; eventId: string; rumor: Rumor; sender: string}`
- Invariants:
  - sender === HistoryEntry.orderingKey.account, never rumor.pubkey
  - dispatch is idempotent per (groupId,eventId) and throws on durable failure
  - dispatch/retract never await account-scope client calls
  - retract of an unseen eventId is a no-op

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
  - `enqueue`: `(job: () => Promise<void>) => void`
- Invariants:
  - a job starts after the enqueuing synchronous frame returns; enqueue as the last action of a handler/sink call, after its own awaits
  - jobs run strictly one at a time in enqueue order
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
  - group.synced() awaited before invite/removeMember/setAdmins/rename/leave
  - commit-pending is retried after synced()

### `KeyPackageInvite` — Single-candidate invite via key-package lookup
- Producer: S8 `app/src/lib/marmot/invitations/invite.ts` -> Consumer: S12 `app/src/lib/marmot/joinRequestApproval.ts`
- Fields:
  - `inviteByPubkey`: `(group: MarmotGroup, pubkey: string) => Promise<InviteOutcome | {error:'no usable key package'}>`
- Invariants:
  - group.invite receives exactly one key-package event
  - candidates ordered created_at desc, tie lower event id
  - invalid-options falls through to next candidate; exhaustion yields 'no usable key package'

### `PendingInvitationView` — Pending invitations as the single pending store
- Producer: S9 `app/src/lib/marmot/invitations/pendingView.ts` -> Consumer: S10 `app/src/lib/marmot/invitations/invitationCardViewModel.ts`
- Fields:
  - `pending`: `() => PendingInvitation[] (groupId, sponsorAccount, sponsors, id)`
  - `onChange`: `(cb) => unsubscribe`
- Invariants:
  - invitations.pending() is the only source; lp_pendingInvitations_v1 never read
  - blocked-sender entries never appear
  - retained set respects 256 total / 8 per inviter

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
- Invariants:
  - inviteeRef persisted at invite time
  - declined set durably before any removal work
  - marker cleared only after removeMember resolves
  - legacy markers without inviteeRef are ignored without throwing

### `GroupDataPurger` — Local group purge (abandon) path
- Producer: S13 `app/src/lib/marmot/membership/purgeLocalGroup.ts` -> Consumer: S17 `app/src/lib/marmot/client/reconcile.ts`
- Fields:
  - `purgeLocalGroup`: `(groupId: string) => Promise<void>`
- Invariants:
  - calls group.abandon() and removes overlay, member profiles, chat/poll rows, history rows, invite links, markers
  - idempotent on second call

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
     - (b) a crash between persist and dispatch is re-dispatched (dispatched-flag sweep);
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
