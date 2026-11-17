# @941design/marmot 0.2.0-alpha.0 — consumer API map

Sources (all read-only, under `.../scratchpad/pkgs/`):
- `M` = `941design-marmot-0.2.0-alpha.0/package/dist`
- `N` = `941design-nostr-events-0.2.0-alpha.0/package/dist`
- `E` = `engine/package/dist`

"create-client.d.ts" below means `M/client/create-client.d.ts`; line numbers are real file lines.
There is NO `docs/client-api.md` shipped in the tarball (source comments refer to it); the .d.ts JSDoc is the contract.

---------------------------------------------------------------------------
## 0. Shape of the library in one paragraph

`createMarmotClient(opts)` (create-client.d.ts:968) returns a `MarmotClient` (737-881) with sub-APIs
`groups`, `keyPackages`, `invitations`, `inbox`, `devices`, `extensions`, `transportEvents`, `on()`, `dispose()`.
It is an **account-scoped** object: one client per Nostr account (pubkey), over one `ClientStores` (per-account IndexedDB DB).
Groups are `MarmotGroup` handles (544-707). Group relay sync (kind 445) is owned by the client, per loaded group.
The kind-1059 inbox subscription is owned by the client and started with `client.inbox.start()`.
It is a convergence-aware (fork/rewind-aware) MLS implementation (vendored marmot-ts "dark-matter" branch + a forked ts-mls),
far heavier than marmot-ts: durable intent/confirm pipeline, rewind windows, device leaves, fencing, etc.

---------------------------------------------------------------------------
## 1. Constructing a client

### `MarmotClientOptions` (create-client.d.ts:167-206)
| field | required | notes |
|---|---|---|
| `signer: Signer` | YES | account-key signer. Client wraps with `withSignerBudget(signer, budget)` (L168). **There is no separate "identity" option** — identity = `await signer.getPublicKey()`. |
| `budget: BudgetPolicy` | YES (`missing-budget` error otherwise) | `{ policy: 'none' }` = explicit opt-out (L170). Else `{concurrency,minSpacingMs,timeoutMs,leaseMs,admit,onEvent}` (`N/signer/budget`). Use for NIP-07/NIP-46 rate limiting/timeouts. |
| `transport: TransportContract` | YES | narrowed 3-method contract (below) |
| `stores: ClientStores` | YES | `{ account: AccountStore, groupFactory(groupId): GroupStore }` — i.e. a `WritableStores` from `backend.openForWrite(pubkey)` (L39-42, storage/index.d.ts:157) |
| `relays: RelayOptions` | YES | `{ defaults: string[], mode: 'discover' \| 'fixed' }` (L44-47). `discover`: resolves inbox relays via kind 10050 then 10002-read then `defaults`; resolves KeyPackage write relays via kind 10002 write set then defaults. `fixed`: single-relay mode, never looks anything up. |
| `verifier?: EventVerifier` | no | `(event) => boolean\|Promise<boolean>` run on every relay event BEFORE it is trusted/decrypted (L34, 176). Mandatory in spirit when transport does not verify sigs (see §8). |
| `onProposal?: ProposalCallback` | no | app decision on staged proposals from other members (L184). Default: non-admin Add/Remove rejected, others accepted. |
| `onApplicationRumor?: InboxHandler` | no | receives gift-wrapped (inbox) rumors marmot doesn't handle itself — NOT group messages (L196). This is the channel for 1:1 / off-group payloads. |
| `history?: HistoryBackend` | no | where accepted group application messages are retained for `group.history()` (L202). **Only an in-memory impl ships** (`createMemoryHistoryBackend`, history/index.d.ts:66). No IndexedDB history backend. See gaps. |
| `mediaCache?: MediaCache` | no | `createMemoryMediaCache` only. |
| `options?: ClientOptions` | no | clock, timers, many timeouts (L61-166). Notables: `clock {now()}` (ms), `timers {set,clear}`, `historyTimeoutMs` 10s, `maxPublishAttempts` 20, `seenSetCap` 10000, `leaveTimeoutMs` 60s, `proposalDeferralTimeoutMs` 24h, `inviteRetentionMs` 30d, `graceWindowMs` 24h (KeyPackage init-key retention after consumption), `removalSettleMs` 10s, `ratchetSkipMargin` 64 [32..100]. |

Construction is synchronous, side-effect free (never calls signer/transport) (create-client.d.ts:3-8).
Hooks/extension points (post-construction): `client.extensions.onConfirm`, `onBeforePublish`, `beforeCreateGroup`,
`registerInboxHandler(kind, handler)`, `sendInboxRumor` (L829-866).

### Signer (nostr-events) — `N/signer/index.d.ts:12-29`
```ts
interface Signer {
  getPublicKey(): string | Promise<string>;
  signEvent(template: EventTemplate, opts?: {signal?}): NostrEvent | Promise<NostrEvent>;
  nip44: { encrypt(theirPubkey, plaintext, opts?), decrypt(theirPubkey, ciphertext, opts?) };  // REQUIRED
  nip04?: {...};
}
```
Provided signers:
- `createPrivateKeySigner(secretKey: Uint8Array)` — `@941design/nostr-events/signer/private-key` (+ `secretKeyFromNsec(nsec)`)  (N/signer/private-key/index.d.ts:9,16)
- `createExtensionSigner()` NIP-07 (lazy `window.nostr`; needs `window.nostr.nip44`, else `SignerError('unsupported-capability')` at use) — `/signer/extension` (index.d.ts:21)
- `createNostrConnectSigner({transport, remote(bunker://|hex), clientSecret, perms, relays?, timeoutMs?, onAuthUrl?})` NIP-46 bunker, plus `createNostrConnectUri` + `listenForNostrConnect` for client-initiated `nostrconnect://` — `/signer/nostr-connect` (index.d.ts:10-141). `transport` there is a `Pick<NostrNetworkInterface,'subscription'|'publish'>`.
- `fromForeignSigner({target, methods})` with presets `NIP07_SHAPE`, `APPLESAUCE_SHAPE`, `NIP46_RPC_SHAPE` (`/signer/adapters`). **NDK is explicitly NOT supported** (adapters/index.d.ts comment: "Not an NDK adapter… a faithful NDK adapter is not provided"). If the app holds an `NDKSigner` (sync `pubkey`, `sign()` returns only sig, `encrypt(NDKUser,…)`), we must hand-write a ~20-line `Signer` adapter. (Note: our memory file `ndk_signer_api_quirks.md` lists the quirks that adapter must absorb.)
- `permissions` export (`M/client/permissions.d.ts`): `PermissionDeclaration` with signEvent kinds `[30443, 13, 5, 22242, 450]` + NIP-44. Use `permissions.toNip46Perms()` for the bunker `perms`. Kinds 445 and 1059 are signed by ephemeral keys, so a NIP-07 extension is only prompted for KeyPackages (30443), seals (13), deletes (5), AUTH (22242) and identity-proof (450).
- Extras: `withSignerBudget`, `encryptToSelf/decryptFromSelf` (escrow), `checkSignerCapabilities`, `probeSigner`.

### Transport — `N/transport/contract/index.d.ts:62-71`
```ts
interface TransportContract {
  publish(relays: string[], event: NostrEvent, opts?:{signal?}): Promise<Record<string, PublishResponse>>;  // {from, ok, message?}
  requestWithDeadline(relays: string[], filters: Filter|Filter[], opts:{timeoutMs:number; signal?}): Promise<RequestWithDeadlineResult>;
       // {events, timedOut, eosedRelays, silentRelays, eventRelays?: Map<id,relays[]>}
  subscription(relays: string[], filters: Filter|Filter[]): Subscribable<NostrEvent>;   // {subscribe(observer)=>{unsubscribe()}}
}
```
Provided adapters (both return `NostrNetworkInterface & { asTransportContract(): TransportContract }`; pass `.asTransportContract()`):
- `createSimplePoolNetwork({ pool: SimplePool /* caller-owned, nostr-tools/pool */, defaultRelays?, verifyEvents=true, authSigner?(NIP-42), onAuthFailed?, autoReconnect?, reconnectBackoff?, publishTimeoutMs?(~10s), onPublishOutcome?, resolveInboxRelays? })` — `/transport/simple-pool` (index.d.ts:7-214). `autoReconnect` re-issues dropped subscriptions with same filter (no `since` bridge — marmot's own history-pass logic covers gaps).
- `createRawWebSocketNetwork({ defaultRelays?, webSocketImpl?, verifyEvents=true, publishTimeoutMs=30s, onNotice, onProtocolError, onAuthFailed, onSubscriptionLegClosed, onPublishOutcome })` — `/transport/raw-ws`. Does NO NIP-42 AUTH (only reports). No auto-reconnect (wrap with `withReconnect` from `/transport/reconnect`).
- Must wire: client `transportEvents.authFailed(relayUrl,err)` and `.connected(relayUrl)` sinks (create-client.d.ts:874-877) into adapter's `onAuthFailed` / reconnect callback if we want `authFailed` / `transportConnected` client events. Optional.
- **No NDK transport.** To keep NDK as the relay layer we would implement `TransportContract` ourselves (3 methods) — doable but `requestWithDeadline` semantics (per-relay EOSE, `silentRelays`, `timedOut`, `eventRelays`) are load-bearing (marmot discards a whole history pass on `timedOut`). Recommended: use the shipped SimplePool adapter. `requestWithDeadline` free function (`/transport/request`) can derive it from any `NostrNetworkInterface` (`toTransportContract`, contract/index.d.ts:88).
- Conformance suite exists: `@941design/nostr-events/transport/contract/conformance` (`runTransportConformance`; imports `node:` — test-only, never bundle).
- Inbox relay lookups use the transport itself (kinds 10050/10002 via `requestWithDeadline`) — `TransportContract` has no `getUserInboxRelays`.

### Storage wiring (see §6) — minimal construction sketch
```ts
import { createMarmotClient } from '@941design/marmot';
import { createIndexedDbStorage } from '@941design/marmot/storage/indexeddb';
import { createSimplePoolNetwork } from '@941design/nostr-events/transport/simple-pool';
const backend = createIndexedDbStorage();                    // dbPrefix 'marmot:' + pubkey
const stores  = await backend.openForWrite(await signer.getPublicKey());   // takes Web-Lock lease (5s default, else 'lease-held')
const client  = createMarmotClient({ signer, budget:{policy:'none'}, transport: net.asTransportContract(),
                  stores, relays:{ defaults:[...], mode:'discover' }, verifier, onApplicationRumor, history });
```

---------------------------------------------------------------------------
## 2. Key packages

Public surface `client.keyPackages` (create-client.d.ts:766-788):
- `create({relays?, lastResort?}): Promise<NostrEvent>` — mints MLS KeyPackage, signs with account signer, **kind 30443 (addressable, `d` = slot id)** (`ADDRESSABLE_KEY_PACKAGE_KIND`; publisher.js:625; publisher.d.ts:119 doc "kind-30443"). Publishes to `relays` or resolved write relays (`discover`: author's kind-10002 write set else `relays.defaults`). Durable: stored as pending intent, republished on retry (`resumePendingIntents` runs on list()/count()).
  Kind **443 is NOT used** by this client (only 30443). Kind 5 is used for deletion.
- `list(): Promise<NostrEvent[]>`, `count()`, `rotate(ref): Promise<NostrEvent>` (new generation in the same slot; old private key kept for `graceWindowMs`), `forget(ref)` (durable kind-5 delete).
- `observe(account, listener): () => void` — live subscription of **another account's** kind-30443 events (validated via the single KeyPackage validator + `verifier`; each event delivered once). Relays resolved from that account's 10002 write set (create-client.d.ts:775; observation-stream.js doc).
- `offer({groupId, to})` — mints a fresh KeyPackage and sends a gift-wrapped KEYPACKAGE_OFFER rumor (kind 4461) to sponsor `to` for `groupId` (join-request-like flow); sponsor sees `client.on('keyPackageOffered')` / `invitations.offers(groupId?)` and admits with `group.invite([offer.keyPackageEvent])`.
- Rotation after consumption is automatic: when a Welcome consumes a KeyPackage, inbox maintenance rotates that slot (`maintenanceFailed` event after 10 permanent failures).
- `keyPackageRefOf(event)` helper exported from package root.

**Fetching an invitee's KeyPackages**: there is NO public `fetchKeyPackages(pubkey)`. `fetchKeyPackageEvents` exists internally (`M/key-packages/publisher.d.ts:119`) but is not on `MarmotClient` nor exported from the package root. Options: (a) `keyPackages.observe(invitee, cb)` (live sub; first matching event is typically enough), or (b) our own `transport.requestWithDeadline(writeRelays, {kinds:[30443], authors:[pk]}, …)` and pass the events to `group.invite([...])` — `invite` re-validates everything (verifier, `selectKeyPackage` rule: kind, sig, credential↔author binding, lifetime, proof, capabilities, cipher suite) (invitations/invite.d.ts:44-55). Note `invite` takes **NostrEvent[] (the 30443 events), not pubkeys**.

**Relay advertisement**: marmot only READS kind 10050 (inbox/"DM relays", `relay` tags — E/core/relay-lists.d.ts:35-50) and kind 10002 (NIP-65). It never publishes either. `createInboxRelayListEvent` / `createNip65RelayListEvent` (unsigned builders) exist in `@941design/marmot-engine/core`; the app must sign+publish them itself. **Kind 10051 is not used anywhere** (grep: no hits). KeyPackage events additionally carry a `relays` tag (`KEY_PACKAGE_RELAYS_TAG`, E/core/protocol.d.ts:29).
Welcome delivery resolution order (invitations/relay-planes.d.ts): invitee's kind 10050 → kind 10002 read set → `relays.defaults`; timed-out lookup → delivery `retryable` (never falls through); all empty → `no-inbox-relays`. In `fixed` mode only `defaults`.

PRIVACY NOTE (project invariant): KeyPackage (30443) and relay lists (10050/10002) are public relay events by design; they contain no profile metadata. marmot never publishes kind-0.

---------------------------------------------------------------------------
## 3. Group lifecycle

Entry: `client.groups` (create-client.d.ts:742-765): `create(name, {relays?, admins?}) → MarmotGroup`, `get(id)`, `list()`, `restore(id, snapshot)` (account-sync feature; ignore).

| need | API | notes |
|---|---|---|
| create | `groups.create(name, {relays?, admins?})` | `relays` default = `relays.defaults`; `admins` are extra admin pubkeys (creator always admin) — group-runtime.js:894-917. **No `description` option at create** — set it afterwards with `group.rename(name,{description})`. No arbitrary extension injection. Emits `groupCreated {groupId}`. Resolves a handle with `id` (hex MLS group id), `nostrGroupId` (the `h` tag value), `name`, `description`, `admins`, `relays`, `epoch`, `disbanded`. |
| invite | `group.invite(keyPackageEvents: NostrEvent[]) → WelcomeOutcome[]` (606) | ONE commit adding all, then one Welcome per invitee, gift-wrapped (NIP-59: seal kind 13 signed by account key via signer, wrap kind 1059 ephemeral) as Welcome rumor kind 444 (RUMOR_KINDS.WELCOME), published to invitee's inbox relays. Rumor tags: group relays, `e` keypackage event id, `commit` digest. Outcome per invitee `{inviteeRef, pubkey, status: delivered\|retryable\|failed\|declined, relays, reason?, error?}`. Delivery is durable; retryable auto-retries; `failed` → `group.retryWelcome(inviteeRef)` (re-wrap/re-publish, no new commit). Event `welcomeFailed`, `welcomeDeclined`, `welcomeRestored`. Admin-only by default; non-admin Add is rejected (see `onProposal`). Queued app messages sent before the invite are released at the invite epoch so invitees can read them. |
| pending invitations | `invitations.pending() → PendingInvitation[]`: `{id, groupId, sponsorAccount, sponsors, keyPackageRef, receivedAt}` (welcome-processor.d.ts:143-159). Live signal: `client.on('inboxDisposition', d)` with `d.kind==='pending'` (create-client.d.ts:367). **No group name/members in a pending invitation** (invitee can't show "Invited to X" from this API alone; engine has `readWelcomeMarmotGroupView` in `@941design/marmot-engine/core` (welcome-join.d.ts:143) needing the MLS Welcome + KeyPackage private material, which marmot keeps internal — see our memory `marmot_prejoin_group_read.md`; the Welcome rumor is stored inside the `pendingInvitations` account-store artifact (InvitationRecord.rumor, welcome-processor.d.ts:75-130) but reading that is private-format). Gap. |
| accept | `invitations.accept(id) → MarmotGroup` (793) | joins in memory, verifies leaf proofs (ADR-012), persists, starts group sync. Events `groupJoined {groupId, invitationId}`. Then rotate-after-consume maintenance. |
| decline | `invitations.decline(id, {declineRumor?})` | sends a DECLINE rumor (kind 4462, gift-wrapped) to sponsor unless `declineRumor:false`; sponsor's client emits `welcomeDeclined`. |
| auto-accept | `invitations.expectWelcome({groupId, keyPackageRef, sponsorAccount, deadline})` | pre-authorises auto-join for a Welcome matching (used for enrolment/join-request flows). Without a manifest an unexpected Welcome lands in `pending()` (inbox disposition `pending`); this is the invite-approval model. |
| join request | `keyPackages.offer({groupId,to})` → sponsor `invitations.offers()` → `invite` | marmot's native "request to join" |
| list/members | `groups.list()`, `group.members()` (hex accounts), `memberCount()`, `leaves(account)`, `admins`/`activeAdmins()`, `isActiveAdmin`, `isLastActiveAdmin` | accessors are synchronous reads of in-memory state |
| leave | `group.leave()` | proposes SelfRemove, waits up to `leaveTimeoutMs` (60s) for a peer to commit it, then purges local group. Rejects `last-admin` if last active admin (must `setAdmins` first / `departAsAdmin()`). |
| remove member | `group.removeMember(account)` | admin-only single commit; removes ALL leaves (devices) of the account. Error details reasons: `malformed-account`, `self`, `not-admin`. Removed side keeps a tombstoned read-only group and gets `groupRemoved {groupId, actor?}` after ~10s settle window; app should then `abandon()`/`destroy()`. |
| admins | `group.setAdmins(accounts[])` (whole list, one commit), `group.departAsAdmin()` | no grant/revoke single-call; compute the list. Non-admin `setAdmins`/`rename` → `invalid-options` reason `not-admin`. |
| rename / metadata | `group.rename(name, {description?})` | ONE admin commit replacing `marmot.group.profile.v1` (name ≤256 UTF-8 bytes; description ≤4096). Non-admins propose via `group.send({type:'proposal', proposal: groupProfileProposal({name, description})})`, an admin then `send({type:'commit'})`. **No avatar/image option exposed**; relays list is not editable through the client API. |
| disband | **No `group.disband()` on `MarmotGroup`.** Only RECEIVING a peer's disband is supported: `group-disbanded` notification + `group.disbanded` marker (create-client.d.ts:469-481, 553-561). The engine has `disbandRequest()` (E/engine/group-engine.d.ts:487) but marmot does not wrap it. Gap. |
| local teardown | `group.abandon()` (purge local state, no commit), `group.destroy()` (similar, with extra), `group.leave()` | all purge group store, history, invites, KeyPackage refs. |
| generic intents | `group.send({type:'proposal'\|'commit'\|'self-update', …})` | raw MLS plumbing for advanced flows |
| wait for ready | `group.synced()` | resolves after first post-load sync; until then `invite/setAdmins/rename/removeMember/leave` reject `commit-pending` (`details.reason:'awaiting-sync'`) and `send()` queues `awaiting-sync` |

Admin semantics: Marmot admin list is in the group data extension; engine enforces "admin leaf coupling" and last-admin rules (CHANGELOG). Admin may remove another admin without demoting first.

Multi-device: the unit of MLS membership is a **leaf = device**, identified by a per-install device signing key stored in the account store (`ensureDeviceSigningKey`). A second browser/profile for the same nsec is a *new device* and must be enrolled (`client.devices.requestEnrolment` / `approveEnrolment`) or be invited as a new leaf; it does NOT inherit groups. Restoring state requires the stored data (or the `groups.restore(snapshot)` account-sync mechanism). `removeMember(account)` removes all that account's leaves.

---------------------------------------------------------------------------
## 4. Messaging

Send: `group.send({ type:'application', rumor })` (575, 434-444). `rumor: Rumor = {id, pubkey, kind, created_at, tags, content}` (no sig) — **app builds it, including `id = getEventHash(...)` and `pubkey` = own account pubkey** (N/event/index.d.ts). Arbitrary kinds accepted (kind 9 chat, 7 reactions, 5 deletes, custom). Engine strictly re-validates on RECEIVE: payload must be exactly 6 members and `id` recomputed must match, and **inner `pubkey` must equal the MLS-authenticated sender's account** (E/core/application-rumor.d.ts:19-45) → message authorship is cryptographically bound (this is the thing our hand-rolled flow lacks: no impersonation, cf. memory `security_group_message_impersonation.md`). Forged-pubkey messages are dropped (`invalid_encoding`).
- Reserved inbox kinds (not usable via `sendInboxRumor`): 444, 4460, 4461, 4462 (`RUMOR_KINDS`, shared/kinds.d.ts).
- `send()` resolves once the intent is **durably published** (pending-publish → pending-confirm); may take as long as the next admin commit if proposals are staged (queued, ordered; released after the next confirmed commit); rejects `send-rejected`/`publish-failed` on terminal failure; retried up to `maxPublishAttempts` (20). `awaiting-sync`: issued before first post-load sync → resolves after durable record, published later; failure reported via `intentFailed` event. `group.pendingIntents()` lists outbound intents.
- Group messages (kind 445) are signed with ephemeral keys → no signer prompts per message. Only Welcomes/commit-adjacent gift wraps/KeyPackages hit the account signer.

Receive:
- `group.onNotification(listener) → unsubscribe` (698). Notification union (`GroupNotification`, history/notifications.d.ts:161): `message {eventId(445 id), rumor, orderingKey}`, `message-withdrawn {eventId, acceptedDigest}` (branch rewound: message no longer in group history — **UI must be able to retract**), `applied`/`withdrawn` (commit state changes by digest, `kind` string like member added/removed/renamed), `leaf-removed`/`leaf-removal-withdrawn`, `leaf-key-rotated`…, `group-disbanded`, `leaf-equivocation`, `own-change-withdrawn|reapplied|lost`, `retired-key-readded`.
- `OrderingKey {account (MLS-authenticated sender), leafIndex, epoch, generation, acceptedDigest}` (notifications.d.ts:6-20) — sort by (epoch, account/leaf, generation) for deterministic ordering; Nostr `created_at` is NOT what marmot orders on. There is no total order across senders beyond relay arrival; app typically orders by arrival + rumor.created_at.
- **Own messages come back as `message` notifications after confirmation** (pipeline.d.ts:70-76 `ownMessage`: "an own application message, confirmed, as the `message` notification every other member derives"). `orderingKey.account === own pubkey`. There is no separate local-echo event; app should render optimistic UI from its own state then reconcile by `rumor.id`. Own-message echoes are not "suppressed": they ARE the confirmation signal. (This is relevant to our hand-rolled dispatcher's "own-send echo suppression" invariant AC-AR-22 — must be re-designed as "reconcile pending by rumor.id".) If an own send's branch is abandoned before confirmation you get a `message-withdrawn`-style announcement (pipeline: "own message whose send-time branch was abandoned… never announced as message") and must re-send yourself.
- Dedupe: engine terminal ledger + per-group cursor dedup kind-445 events by event id (transport-policy.d.ts cursor/ledger) — redelivered events yield `IngestDisposition 'duplicate'`. Inbox (gift wraps): persisted seen-set of wrap ids (cap 10 000, then **at-least-once** redelivery possible for inbox handlers — dedupe by `rumor.id`).
- Manual ingest: `group.ingest(events) → IngestDisposition[]` (`applied|application|duplicate|retryable|rejected`) for custom transports; normally unnecessary because the client syncs.
- History paging: **no pagination API.** `group.history(): AsyncIterable<Rumor>` just iterates the optional `HistoryBackend`'s `list(groupId)` (in delivery order). Backend contract (history/index.d.ts:55-64): `append(entry)`, `withdraw(groupId, eventIds)`, `list(groupId)`, `purge(groupId)`. Only `createMemoryHistoryBackend()` is provided. Because the group cursor + terminal ledger prevent re-delivering already-processed events after reload, **the app MUST provide a persistent HistoryBackend (IndexedDB) or persist messages itself from `message` notifications**, otherwise chat history vanishes on reload. A fresh joiner only gets messages from its join point (floor = Welcome time − 300 s; "pre-join history can never be opened" — CHANGELOG/ingest cursor docs).
- Inbox rumors (non-group, e.g. a profile exchange sent 1:1): `extensions.sendInboxRumor({to, rumor})` → `{status: delivered|retryable|failed, reason?, relays?}` (no persistence/no retry) and receive via `onApplicationRumor` or `extensions.registerInboxHandler(kind, handler)`. Handlers run on the serial inbox queue and **block all inbox dispatch (incl. Welcomes)**; do not await `group.send` inside; tolerate redelivery; 10-failure cap then dropped. Account-scope calls inside handlers throw `reentrant`.

Media: `group.encryptMedia(bytes, {mediaType, filename, dim, thumbhash, blossomServers})` → `{ciphertext, imeta, locator}`; app uploads ciphertext (Blossom) and puts `imeta` tag on the rumor; `group.decryptMedia(media)`. (encrypted-media-v1, ChaCha20-Poly1305 with MLS exporter-derived key.)

---------------------------------------------------------------------------
## 5. Subscriptions / lifecycle events

Owned by the client:
1. **Group (kind 445)**: per group handle. `groups.create`, `invitations.accept`, `groups.get`, `groups.list` (load) call `startGroupSync` (group-runtime.js ~945, 1107, 1308; ingest.d.ts:69 "Idempotent"). Sync = paginated per-relay history walk from the persisted cursor (`since`) then a live `transport.subscription(groupRelays, {kinds:[445], '#h':[nostrGroupId]})` over the full relay plane (`groupEventFilter`, transport-policy.d.ts). Re-synced on drop; restarted on relay-set change. **No explicit start/stop API per group**: it runs as long as the group is loaded and the client is alive. **The app MUST call `await client.groups.list()` at startup** to load stored groups and thereby start their sync (and `resumePending`, invite delivery resume). Stops on `abandon/destroy/leave` purge, fence, disband, `client.dispose()`.
2. **Inbox (kind 1059 gift wraps addressed to us)**: ONE subscription per client, `client.inbox.start()` / `.stop()` (create-client.d.ts:799-802). `start()` runs one backfill pass (since stored floor, NIP-59 2-day timestamp jitter overlap) then opens the live sub on the account's inbox relays; replaced after backoff on drop. **App must call `inbox.start()` after construction** (and attach `on(...)` listeners and `groups.list()` first, because `groupRemoved` for removals that settled while offline is emitted on first group load).
3. KeyPackage `observe()` subs are caller-owned (returned unsubscribe).

Client events (`client.on(name, listener) → unsubscribe`, create-client.d.ts:207-431): `groupCreated`, `groupJoined`, `groupRemoved`, `groupBranchSwitched`, `inboxDisposition` (joined|already-member|branch-switched|pending|no-matching-keypackage|rejected|deferred|delivered|recorded|unhandled + wrapId), `welcomeFailed|welcomeRestored|welcomeDeclined|welcomeReconcileFailed`, `keyPackageOffered`, `proposalExpired`, `intentFailed`, `confirmBlocked`, `beforePublishSkipped`, `relaySilent`, `historyGap`, `storeIncompatible`, `groupStateFailed`, `maintenanceFailed`, `handlerSlow`, `authFailed`, `transportConnected`, device events (`enrolmentRequested`, `enrolmentApproved`, `deviceForgotten`, `deviceKeyRotated`, `deviceKeyRotationSettled`).
**There is no `memberJoined` / `memberLeft` / `epochChanged` / `groupRenamed` client event.** Those are derived from per-group `onNotification` → `applied {kind}` / `leaf-removed` notifications, or by diffing `group.members()/name/admins/epoch` after each notification (accessors are live). Epoch = `group.epoch` (bigint).
`groupRemoved` (we were removed) only fires after the ~10 s settle window and not for our own `leave()`.

---------------------------------------------------------------------------
## 6. Storage

Contract: `@941design/marmot/storage` (storage/index.d.ts, ADR-007). Two scopes:
- `AccountStore` (per pubkey): artifacts `keyPackages, keyPackageGroupRefs, invites, pendingInvitations, enrolmentManifests, enrolmentSessions, deviceRegistry, inboxSeenSet, syncKeyVersions, wipeMarker` + `extension(id)` namespaces (`marmot.groups` index, `marmot.offers`, `marmot.teardown`, …) (ACCOUNT_ARTIFACTS L76).
- `GroupStore` (per groupId): `clientState, ingestCursor, terminalLedger, rewindTree, removalMarker, pendingIntents, queuedRumors, leafBackup, retainedHistory` + extensions (`marmot.disband`, `marmot.opaque`, …) (GROUP_ARTIFACTS L75).
- Each has `transaction(fn)` (buffered, flushed atomically; `fn` may await signer/relay). Re-entrancy: inside `fn` use the `tx` view, never the store (else `reentrant`). Values live in versioned envelopes stamped with `ENGINE_VERSION='state.1'` + `TS_MLS_PIN`; mismatch → `envelope-mismatch` + `storeIncompatible` event; recover by `account.wipe({reason:'incompatible'|'application'})` (which deletes EVERYTHING for the account incl. device key and leaves a marker).
- Alpha warning: the CHANGELOG records multiple stored-format bumps ("stores written by earlier builds are refused with `storeIncompatible`"). Expect wipes between alpha versions → pin the exact version.

Backends:
- `createIndexedDbStorage({ indexedDB?, IDBKeyRange?, locks? (navigator.locks), dbPrefix='marmot:', leaseTimeoutMs?, codecVersions?, clock? })` — `@941design/marmot/storage/indexeddb` (index.d.ts:234-244). **One IndexedDB database per account: name = `marmot:<pubkey>`** (DEFAULT_DB_PREFIX + account), DB_VERSION 1, one object store per bucket. Per-identity namespacing is therefore physical (separate DBs) plus key-prefixing. Writes are not tied to idb-keyval; no clash with our existing idb-keyval DBs.
- `createMemoryStorage({persistence?})` — `/storage/memory` (also exports `createDeterministicSigner` test helper).
- Custom: `createStorageBackend(StorageDriver)` (driver = `read/keys/commit/locks/lockName`).
Lease: `openForWrite(account, {leaseTimeoutMs=5000})` acquires an exclusive **Web Lock** `navigator.locks` named per (backend, account); second tab/context for same account rejects `lease-held` after 5 s. So **only one tab per account can run a client** (our app must handle multi-tab: elect a leader / show "open elsewhere"). A lost lease (steal) → writes reject `no-lease`, `lease.held=false`. Where Web Locks absent, supply `locks`.
Teardown/reset: `client.dispose()` (sync, releases listeners; subsequent calls throw `disposed`), then `await stores.close()` (waits in-flight commit, releases lease). Account reset: `stores.account.wipe({reason:'application'})` (one atomic backend txn; returns WipeMarker). Switching identity = dispose client + close stores + open new backend/account. Per-group: `group.abandon()/destroy()` purge group store.
Gotcha: the history backend and mediaCache are separate from these stores (memory only by default).

---------------------------------------------------------------------------
## 7. Errors, events, DON'Ts

- Single error class `MarmotError extends Error { code: MarmotErrorCode; details?; cause? }`; guard `isMarmotError(e, code?)` (shared/errors.d.ts:395-406). Codes (closed set): `missing-budget, invalid-options, not-implemented, disposed, envelope-mismatch, no-lease, lease-held, transaction-closed, store-failed, reentrant, publish-failed, send-rejected, confirm-blocked, commit-pending, fenced, handler-exists, reserved-kind, not-a-member, no-inbox-relays, last-admin, invalid-admin-policy, use-forget, already-member`. `details.reason` carries the sub-reason (e.g. `awaiting-sync`, `not-admin`, `abandoned-branch`, `staged-profile-update`, `disbanded`).
- nostr-events errors: `LibError` base, `SignerError` (codes incl. `timeout`, `cancelled`, `transport`, `auth-required`, `unsupported-capability`, `disposed`, `key-unavailable`, `crypto`), `NetworkError`, `GiftWrapError` (`nostr-events/error`). Transient signer errors during inbox processing defer (not drop) wraps.
- **Fenced groups**: a group can become `fenced` (unreadable competing own-leaf branch, e.g. cloned/restored stale device state) — terminal: sync stops; sends reject `fenced`; `intentFailed`. Surface in UI.
- **Don't**:
  1. Don't import `ts-mls` directly — use `@941design/marmot/mls` (a re-export of `@941design/marmot-engine/mls`) so one instance is shared (README; mls.d.ts). marmot-engine depends on an alias `ts-mls: npm:@941design/ts-mls@2.0.0-rc.16-941design.1` (a fork) — do NOT also install upstream `ts-mls` for marmot types.
  2. Don't use the store directly inside a transaction (use `tx`) — `reentrant`.
  3. Don't call account-scope client ops (`group.send`, `invite`, `groups.*`, `devices.approveEnrolment`) from within `onApplicationRumor` / `registerInboxHandler` / `onConfirm` / `onBeforePublish` / signer / store callbacks — `reentrant` (ADR-013). Persist and return / fire-and-forget.
  4. Don't run two clients (tabs) on one account; don't reuse stores across clients; don't edit stored artifacts out-of-band.
  5. Don't import marmot-engine/internal paths; `getClientContext`, `createMarmotClientWith`, `getGroupRegistry` are exported in the .d.ts as "internal, tests only" but not from the package root's JS barrel (`client/index.d.ts` lists the public surface).
  6. Don't rely on `group.members()` for display names — only account pubkeys (hex). Profiles are out of scope (see gaps).
  7. Pin the exact version (`0.x` may break every release; README says so).

---------------------------------------------------------------------------
## 8. Runtime / environment constraints

- **ESM-only** (`"type":"module"`, `exports` with only `types` + `import` conditions, no `default`/`require`) for marmot (package.json) and nostr-events; marmot-engine likewise `"type":"module"`. Subpath exports: marmot `.`, `./mls`, `./storage`, `./storage/memory`, `./storage/indexeddb`; nostr-events has **no root export** (bare import throws `ERR_PACKAGE_PATH_NOT_EXPORTED`) — 26 subpaths (`event, clock, signer, signer/{private-key,extension,nostr-connect,capability,permissions,budget,adapters,escrow}, gift-wrap, transport, transport/{raw-ws,simple-pool,request,inbox-relays,reconnect,contract,contract/conformance}, error, nip19, branded, parsers, factory, loaders`); engine: `core, engine, audit, mls, version`.
- **Next.js 14 / webpack 5**: webpack 5 resolves the `import` condition for ESM imports from TS/ESM sources, so ESM-only `exports` maps are fine (no `default`/`require` condition means a CJS `require('@941design/marmot')` would fail — don't `require`). Types resolve with `moduleResolution: "bundler"` (or node16/nodenext); legacy `"node"` resolution will NOT see subpath `exports` (our tsconfig must use `bundler`; check). Because the packages ship untranspiled ES2022+ ESM, `transpilePackages` is usually NOT required, but adding `['@941design/marmot','@941design/marmot-engine','@941design/nostr-events']` is a harmless safeguard. **Unverified here**: nothing in this tarball set was executed/bundled; Next 14 + these packages was NOT tested by me. Everything must be client-only (use dynamic import / `useEffect`; the IDB storage and WebSocket transport touch browser APIs lazily at call time, and README says no top-level browser API access, so SSR import won't throw, but `navigator.locks`/IndexedDB are only usable in the browser).
- **Node engine**: `@941design/nostr-events` declares `engines.node >=22`; marmot and marmot-engine declare **no `engines`**. This only affects installs under `engine-strict`/CI Node version, not the browser bundle.
- **No WASM, no workers** in marmot, engine, nostr-events (README: "no WASM in the hot path; pure-JS dependencies only"; grep of dist for `WebAssembly|new Worker|node:` found only test-only `transport/contract/conformance` using `node:`). Crypto: `@noble/*`, `@scure/base`, `debug`. The forked `@941design/ts-mls` is not in the tarballs; I did not inspect it (assumed pure JS/noble — **unverified**). MLS work (ratchet-tree ops, commit processing, Welcome join) runs on the main thread; large groups may cause jank (no worker offload provided).
- Peer/direct deps: marmot → dep `@941design/marmot-engine ^0.2.0-alpha.0`; peer `@941design/nostr-events ^0.2.0-alpha.0` (single shared copy required: signer/transport types are shared). nostr-events peers: `nostr-tools >=2.23.0` (+ optional `vitest`). marmot-engine **pins `nostr-tools` exactly `2.23.3`** as a dependency → our app's `nostr-tools` must resolve to a compatible single version (≥2.23.0; best exactly 2.23.3) or we get duplicate copies (types of `SimplePool` come from `nostr-tools/pool`; `verifiedSymbol` is per-copy). Check our current nostr-tools version.
- Browser: needs `crypto.getRandomValues`/WebCrypto (noble), `WebSocket`, `IndexedDB`, `navigator.locks` (Web Locks; override via `locks` option), `AbortSignal`, `BigInt` (epochs are `bigint`), `structuredClone` likely. Safari/Firefox support Web Locks in current versions.
- Version oddity: `E/version.d.ts` says `ENGINE_PACKAGE_VERSION = "0.1.0"` while package is 0.2.0-alpha.0 (stamp constants are hand-maintained; harmless but means the stored-state stamp is `state.1`/TS_MLS_PIN, not the package version).

---------------------------------------------------------------------------
## 9. Notable gaps for a chat app (things NOT provided)

1. **Persistent history backend / message store**: only in-memory `HistoryBackend`; no paging, no search, no unread counts, no read receipts. App needs an IDB `HistoryBackend` (4 methods) or its own message store fed by `onNotification`; must handle `message-withdrawn`.
2. **Profiles**: no nickname/avatar/kind-0 handling at all (good for our privacy invariant). Profile exchange must be app-defined rumors: in-group via `group.send({type:'application', rumor:{kind:<custom>}})`, 1:1 via `extensions.sendInboxRumor` (gift-wrapped; allowed channel per CLAUDE.md) + `registerInboxHandler(kind, h)`. No avatar upload (Blossom upload is ours; `encryptMedia` helps for group media).
3. **Group disband initiation** (receive-only); no group avatar; no relay-list editing; no group description at create (use `rename`).
4. **Pending-invitation preview**: no group name/members/inviter profile in `PendingInvitation`.
5. **Publishing 10050/10002** relay lists is the app's job (marmot only reads them; without a 10050 or 10002-read the invitee falls back to `relays.defaults`, so a private invite to a user with no inbox relays only works if they share our defaults). No kind 10051.
6. **Public fetch of KeyPackages by pubkey** is not a public API (only `observe` or DIY request).
7. **Contact/pairing, DMs**: no 1:1 DM layer (NIP-17 DMs are not provided; `sendInboxRumor` is a low-level gift-wrap send, no persistence/retry, no receive-side thread model). Our DM feature stays hand-rolled (or implemented as 2-member MLS groups).
8. **Typing/presence/notifications/ unread / mentions / reactions / edits / polls**: all app-level rumor kinds; library only transports them with sender authentication.
9. **Multi-tab**: exclusive Web-Lock lease → a second tab cannot open the account store (`lease-held`); app must coordinate (BroadcastChannel/leader election) — the lib offers none.
10. **Multi-device/restore**: new device = new leaf needing enrolment/invite; losing IndexedDB loses all group state (no relay-based recovery except the `account-sync` snapshot mechanism, which is a separate package/extension point: `ConfirmContext.snapshot`, `groups.restore`). Our existing relay backup (kind 30078) concept would map to that, not provided here.
11. **NDK integration**: no NDK adapter for signer or transport.
12. **Worker offload, SSR**, cursor/state export, structured logging (only `debug` namespace via engine dependency and `audit` module).
13. **Alpha storage churn**: stored-state format bumps refuse old stores (`envelope-mismatch`/`storeIncompatible`) → migration = wipe + rejoin. Pre-1.0 API churn; pin exact versions.

---------------------------------------------------------------------------
## 10. Mapping to a typical app flow (quick reference)

Startup: `signer` → `backend.openForWrite(pk)` → `createMarmotClient(...)` → attach `client.on(...)` listeners (esp. `groupRemoved`, `inboxDisposition`, `intentFailed`, `storeIncompatible`) → `await client.groups.list()` (starts per-group sync; attach `group.onNotification` to each) → `await client.inbox.start()` → ensure ≥1 published KeyPackage (`keyPackages.count()` then `create()`; consider `lastResort:true` one) → ensure own 10050/10002 published by app.
Create+invite: `groups.create(name,{relays})` → obtain invitee 30443 events (`keyPackages.observe`/DIY request) → `group.invite([ev])` → inspect `WelcomeOutcome`.
Receive invite: `inboxDisposition{pending}` → `invitations.pending()` → `accept(id)` / `decline(id)` → returned `MarmotGroup` is already syncing.
Chat: `group.send({type:'application', rumor})`; render from `onNotification` `message`.
Leave/remove: `leave()` / `removeMember(pk)`; on `groupRemoved` → `abandon()`.
Logout/switch: `client.dispose(); await stores.close();` (+ `stores.account.wipe({reason:'application'})` for full local reset).

## Uncertainties
- No end-to-end execution; all conclusions from .d.ts, JSDoc, CHANGELOG and targeted .js reads. Next 14 bundling not verified.
- `@941design/ts-mls` fork not inspected (assumed pure JS).
- Exact auto-start of sync in `groups.get()` (vs only `list()`): code shows `startGroupSync` in create, join, load paths (group-runtime.js ~945/1107/1308) — I assumed `get` and `list` share the "load" path.
- `group.destroy()` vs `abandon()` difference not fully read (teardown.d.ts: kinds 'leave'|'abandon'|'destroy').
- `MarmotGroup.history()` ordering/withdraw semantics with a custom backend inferred from interface docs only.


> Correction (2026-11-17, S9): `invitations.decline(id, opts)` sends the decline rumor ONLY when `opts.declineRumor === true` (welcome-processor.js ~1050–1078); the default is silent. Any statement above implying the opposite default is wrong.
