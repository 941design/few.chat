---
arch_debate: false
---
# Adopt @941design/marmot — replace the hand-rolled Marmot group flow

**Status**: pre-implementation (2026-11-17) — design decisions ratified by Fable decider

## Problem

Few's MLS-on-Nostr group feature is built directly on a git fork of
`@internet-privacy/marmot-ts` plus a git fork of `ts-mls`. Around that thin
library the app hand-rolls nearly all of the protocol plumbing:

- relay transport (`NdkNetworkAdapter`, raw-WebSocket publish)
- the kind-445 group subscription (historical fetch, live subscription, seen-id LRU, `since` skew margin)
- epoch and fork resolution with a future-epoch buffer (`epochResolver`)
- a write-ahead rumor journal (`rumorJournal`) plus an ordered, deduplicating dispatcher (`applicationRumorDispatcher`) for at-most-once handler delivery
- Welcome intake, join locks, the processed-gift-wrap set and stale-Welcome replace (`welcomeSubscription.ts`, 1.9k lines)
- the key-package lifecycle (`keyPackages.ts`, startup relay cleanup) and the relay-list publish (kind 30051)
- three copies of a `sendRumorSafe` workaround for staged proposals
- a leave protocol (kind-13 leave_intent → admin auto-commits Remove, pending-removal store, tombstones)
- decline (kind-21063 DM → sponsor Remove commit)
- metadata commits (rename, grant admin, cancel invitation)
- MLS-state persistence (`groupStorage` backends)

`MarmotContext.tsx` (3.1k lines) is the composition root for all of this. The
total is roughly 14.6k lines in `app/src/lib/marmot` plus the context.

`@941design/marmot@0.2.0-alpha.0` is a full Marmot client that owns all of
the above. It has:

- the account-scoped `createMarmotClient`
- client-owned group (445) and inbox (1059) subscriptions
- a durable intent/confirm pipeline with fork rewind
- a native Welcome / pending-invitation / accept / decline model
- native `leave`, `removeMember`, `setAdmins`, `rename`
- automatic key-package rotation
- per-account IndexedDB storage
- cryptographic sender binding of application rumors (inner `pubkey` must equal the MLS-authenticated sender; forged authorship is dropped)
- a durable, ordered, at-least-once `HistoryBackend` seam idempotent by kind-445 event id

The hand-rolled flow duplicates the library, carries known defects (e.g. the
impersonation exposure in `security_group_message_impersonation`, the
unload-loses-consumed-rumor race), and pins us to two git forks.

Source: owner request 2026-11-17 ("conduct a large refactoring replacing the
hand-rolled marmot group flow"; pre-alpha, no backwards compatibility, no dead
code or alternate/migration paths left behind). Reference consumer manifest:
`package.json.copy` (notestr).

*Success signal: `app/` has zero imports of `@internet-privacy/marmot-ts` or
`ts-mls`. Every MLS protocol operation goes through `@941design/marmot`. `make build` passes on the final tree, the
full `make test` gate (unit + `make test-e2e-all`, whatever its post-run count) passes, and CLAUDE.md test counts match.*

## Solution

Rebuild the group feature as a thin **app-domain layer over one
`MarmotClient` per signed-in account**:

1. **Client bootstrap module** (`app/src/lib/marmot/client/`). It builds the
   client from the app's signer, a nostr-tools `SimplePool` transport, and the
   library's IndexedDB storage. Then it attaches listeners, loads groups
   (`groups.list()`, which starts per-group sync), starts the inbox, keeps a
   last-resort key package published, and publishes the app's kind-10050
   inbox-relay list. It disposes and closes stores on sign-out or signer change.
2. **Inbound = an app `HistoryBackend`**. Accepted group application messages
   reach the app only through a persistent IndexedDB-backed `HistoryBackend`.
   Its `append` routes each rumor to the existing app-domain handlers (chat,
   reactions, delete/edit, polls, profile, profile-request, announcements)
   idempotently by event id. Its `withdraw` retracts what a fork rewind
   abandoned. The library's durable, ordered, at-least-once delivery replaces
   `rumorJournal`, `applicationRumorDispatcher`, `epochResolver` and the
   hand-rolled 445 subscription. Sender identity is
   `HistoryEntry.orderingKey.account` (MLS-authenticated, already bound to
   `rumor.pubkey` by the library). Message stores update from the history sink; `group.onNotification` drives only member, admin, name and disband resync (D13).
3. **Outbound = one `sendGroupRumor(group, kind, content, tags)` helper**
   building canonical rumors and calling `group.send({type:'application', rumor})`.
   It replaces the three `sendRumorSafe` copies; the library queues sends
   behind staged proposals itself. Own messages return through the history
   sink and reconcile the optimistic row by `rumor.id`.
4. **Native group operations**:
   - create: `groups.create(name)`
   - invite: fetch the invitee's kind-30443 key packages, then `group.invite`
   - accept / decline: `invitations.*`; a decline makes the sponsor run `removeMember` on `welcomeDeclined`
   - leave: `group.leave`, with app eligibility kept (last member abandons, last admin blocked)
   - remove member and cancel invitation: `removeMember`
   - grant admin: `setAdmins`
   - rename: `rename`
   - removal notice: on `groupRemoved` (and a startup check for any listed group whose `members()` lacks the own account, since `groupRemoved` is at-most-once), run the app's local group purge ("abandon": library `group.abandon()` plus app-side group data removal) and update the UI
5. **Non-group gift wraps** the old Welcome listener also handled (join
   requests, pairing-ack) move to `extensions.registerInboxHandler(kind, …)`
   or the existing NDK DM listener (Decision D7). The library owns the
   kind-1059 inbox for Welcomes and declines.
6. **Delete** every superseded module, store, localStorage key, test and
   `__fewTest` hook. Pin exact versions and drop both git forks from
   `package.json`.

## Scope

### In Scope
- Dependencies, pinned exactly:
  - add `@941design/marmot@0.2.0-alpha.0`, `@941design/marmot-engine@0.2.0-alpha.0` (exact direct dep: it defines the stored format and provides `createInboxRelayListEvent`) and `@941design/nostr-events@0.2.0-alpha.0`
  - pin `nostr-tools@2.23.3` to match marmot-engine's exact pin, so one copy is shared by the app and `@941design/*` (applesauce-core keeps its own nested copy)
  - remove `@internet-privacy/marmot-ts`, `ts-mls` and any `@hpke/*` / `@noble/post-quantum` deps that only they needed
  - update the `next.config.mjs` swc-loader include list: add the `@941design/*` packages and keep `/node_modules\/ts-mls/` (the engine's aliased ts-mls fork still needs it)
- Client bootstrap, transport (SimplePool), signer adapter (app `EventSigner` → nostr-events `Signer`), storage (IndexedDB backend), lifecycle (sign-in, sign-out, signer-mode change), multi-tab lease handling.
- Key packages via `client.keyPackages` (kind 30443 only) and an app-published kind-10050 inbox-relay list replacing kind 30051.
- Inbound pipeline via app `HistoryBackend`; `HistoryBackend.withdraw` retraction; own-send reconciliation.
- Outbound helper used by chat, reactions, delete/edit, polls, image messages, call notices, profile exchange, announcements.
- Media encrypt/decrypt via `group.encryptMedia` / `group.decryptMedia`.
- Invitations: invite, pending list and UI, accept, decline, auto-accept correlation for outbound join requests / invite links (D8), pre-join preview (D3), deny layer and caps (D14).
- Membership/admin ops: leave + eligibility, remove member, cancel pending invitation, grant admin (setAdmins), rename, removed-by-admin handling, disbanded/fenced surfacing.
- Relay backup (kind 30078): drop group-scoped sections and seed-phrase/relay group recovery (Decision D5).
- `MarmotContext` rewritten as a thin provider over the bootstrap module, keeping the `useMarmot()` consumer surface. Fields with no consumer or no remaining meaning are removed.
- Rewrite or delete every unit test coupled to removed internals. Update e2e helpers and specs whose assumptions change (store names, `__fewTest` hooks, behaviours changed by a decision below), subject to the test-removal rule:
- **Test-removal rule.**
  - An e2e spec may be deleted only when a decision removes its behaviour: `groups-blackout-guard` (fork-specific) and the pending-removal assertions in `groups-admin`.
  - These specs are rewritten against the new behaviour, not deleted: `groups-leave-intent`, `groups-leave-purges-mls-state`, `groups-rumor-reload-atomic`, `groups-accept-reload-atomic`, `groups-invitation-preview`, `groups-dispatch-isolation`, `groups-seed-phrase`, `groups-seed-recovery`, `groups-backup-restore-outcomes`, `groups-reinvite-after-leave`, `groups-reinvite-after-removal`.
  - Every other e2e spec keeps its assertions; only helpers, store names and hooks change.
  - Behavioural unit suites (handlers, persistence, polls, profile, join-request, leave eligibility, unread) are re-pointed, never deleted.
  - `handlersRumorPubkeyBoundary` is re-expressed against the new handler signature.
  - The run report lists every deleted test file with the decision that justifies it.
- Docs: `docs/behavior/` topics touched (groups, profiles-and-identity, backup-and-recovery, notifications-and-unread, contacts-and-direct-messages where the inbox split shows); a new ADR superseding ADR-012's fork mechanism and ADR-003's marmot-ts-specific claims (D16); CLAUDE.md e2e test counts if they change.

### Out of Scope
- 1:1 direct messages (NIP-17 over NDK), calls signalling (kind 21059 over NDK), contact pairing protocol, walled-garden logic. These are kept as-is, except where they read group membership; that read moves to the new API.
- Multi-device enrolment UX (`client.devices.*`), beyond what Decision D5 requires.
- Group disband initiation (library is receive-only), group avatars, relay-list editing per group.
- Re-homing the DM/contacts reactivity counters (`knownPeersRevision`, etc.) out of `MarmotContext`. They stay where they are.

## Design Decisions

Ratified by a Fable decider 2026-11-17 (D1 ratified, D2–D12 amended, D13–D16 added). Items marked **[HR]** change user-visible behaviour or product policy and are listed for human review at the end of the run (see `## Deferred Human Review`).

- **D1 Transport.** Use the shipped `createSimplePoolNetwork({pool}).asTransportContract()` over an app-owned nostr-tools `SimplePool` scoped to the marmot client. No hand-written NDK `TransportContract`. NDK stays for DMs, calls and backups. `verifyEvents` defaults on, so pass no `verifier`.
- **D2 Signer [HR].** Adapt the existing applesauce `EventSigner` via `fromForeignSigner` (`APPLESAUCE_SHAPE`). Use `budget:{policy:'none'}` for nsec and a timeout budget for NIP-07/NIP-46.
  - NIP-46 sessions request the union of `permissions.toNip46Perms()` and the app's own kinds (`sign_event:0`, `20602`, `30078`, `10050`); 443, 444, 445, 1059, 10051 and 30051 are dropped. A stored session granted the old set is discarded and the user reconnects.
  - The mutation-gated logic (D11) is the app's budget/permission selection and nip44-unsupported detection, not `fromForeignSigner` itself.
  - A signer without `nip44` makes group features `unsupported` (existing state plus an i18n string), with no fallback path.
  - The secure-context gate stays.
- **D3 Pre-join preview [HR].** After a `delivered`/`retryable` invite outcome, the sponsor sends a gift-wrapped invite-context rumor (`extensions.sendInboxRumor`, new app kind, not 21063) with content `{groupId, name}` only.
  - The invitee accepts it only when its `pubkey` is the invitation's `sponsorAccount` or one of its `sponsors`.
  - The stored name is keyed by groupId+sponsor, length-capped, and rendered as untrusted text.
  - The invitation card updates live in either arrival order and shows a generic label when no context arrived. There is no retry or resend machinery.
  - The invite-context kind is **21064** (not 4460–4462 or 21059–21063).
  - Contexts with no matching invitation are held, at most 8 per sender and 64 in total (oldest evicted), for 7 days. A held context is validated against `sponsorAccount` when the invitation arrives and dropped on mismatch.
  - The stored context is deleted on accept, decline and expiry. 'Expiry' means the 7-day limit or the invitation leaving `invitations.pending()`.
- **D4 Multi-tab [HR].** The tab holding the account's Web-Lock lease runs the client. Other tabs wait on the lease (retrying `openForWrite` on `lease-held`) and show group features as "active in another tab" (i18n).
  - A tab without the lease reports `ready:false` and runs no membership-derived sweep (walled-garden purge, known-peers maintenance, invite-expiry or profile-request sweeps) and no group write.
  - A waiting tab acquires the lease automatically when the holder closes, without a reload.
  - Cross-tab store-changed sync for group data is removed; DM, contacts and block cross-tab sync are unchanged.
  - A waiting tab resolves `whenReady()` as soon as the lease outcome is known and exposes `groups` read-only from the overlay store, which the lease-holding tab keeps current. DM gating and known-peers reads work unchanged in every tab; only group writes and membership-derived sweeps are lease-bound.
- **D5 Backup / recovery [HR].** Drop `groupStates` and every group-scoped section (`groups`, `memberProfiles`, `chatMessages`, `inviteLinks`) from the kind-30078 backup payload, which then carries settings and own profile only.
  - A recovered or new device has no groups and rejoins by invitation or invite link.
  - The restore code for those sections is deleted. A backup still containing them is read, ignoring them.
  - No `groups.restore` snapshot seam is adopted.
  - Rewrite `groups-seed-phrase`, `groups-seed-recovery` and `groups-backup-restore-outcomes`; update `docs/behavior/backup-and-recovery.md`.
- **D6 Message withdrawal [HR].** `HistoryBackend.withdraw` (fork rewind) removes other members' withdrawn content (chat rows, reactions, poll events, delete/edit signals) and re-renders.
  - A withdrawn own chat message, or an own send whose branch was abandoned (incl. after `groupBranchSwitched`), returns to the optimistic row's existing failed/retry state. It is not deleted and not auto-resent.
  - Withdrawn own reactions, votes and edit/delete signals are dropped.
  - Unread counts are recomputed after a withdrawal.
  - Effects already emitted (bell, known-peers, follow-up sends) are not undone. There is no user-facing notice.
  - Detection: an optimistic own row goes to failed/retry when (a) `send()` rejects, (b) `intentFailed` names its group and the row is unconfirmed, (c) `groupBranchSwitched` fires for its group while it is unconfirmed, or (d) it is still unconfirmed 60 s after `send()` resolved. A later sink arrival with the same `rumor.id` still confirms it. Triggers (b)–(d) never downgrade a row already confirmed through the sink; only an explicit sink `withdraw` of an own entry moves a confirmed row to failed/retry (AC-WDR-2).
- **D7 Inbox split.**
  - Join requests and the D3 invite context are claimed with `extensions.registerInboxHandler` on the library inbox. Handlers persist and return; no account-scope calls.
  - Join requests are sent with `extensions.sendInboxRumor`.
  - Handlers take the sender only from the delivered `rumor.pubkey` (the library binds it to the seal pubkey) and dedupe by `rumor.id`.
  - Pairing-ack moves from the deleted `welcomeSubscription.ts` to the existing NDK DM listener, which silently skips kinds it does not own (444, 4460–4462, join request, invite context).
  - Decline DM kind 21063 is deleted in favour of the native decline (4462 → `welcomeDeclined` → sponsor `removeMember`).
  - Decline durability: at invite time the sponsor persists `inviteeRef → pubkey` in the pending-direct-invite marker. On `welcomeDeclined` (which carries `inviteeRef` and fires once) the marker is set `declined` durably. The removal runs outside the listener, after `await group.synced()`, and is retried for every `declined` marker at startup. The marker is cleared and the `declined` announcement sent only after `removeMember` resolves.
- **D8 Join requests.** Keep the app protocol (invite-link nonce, requester name/avatar inside the gift wrap, mute, dedup). Approve by key-package fetch (D10) plus `group.invite`.
  - No `keyPackages.offer` and no `expectWelcome`.
  - Auto-accept has one mechanism: on `inboxDisposition: pending`, correlate the `PendingInvitation` (`groupId`, `sponsorAccount`) against unexpired outbound join requests under the existing AC-AUTO rules. On a match, consume the request once and call `invitations.accept(id)` outside the listener frame. Everything else stays pending (ADR-002).
  - A requester whose account already holds a leaf in the group: approval is a no-op success. The request is marked approved and consumed, no `group.invite` is issued, and no error is shown.
  - `sendInboxRumor` persists and retries nothing, so a join request with outcome `retryable` or `failed` shows the existing send-failure state.
- **D9 Leave [HR].** `group.leave()` replaces leave_intent, admin auto-commit, the pending-removal store, tombstones and the left-group sweep.
  - The UI removes the group at once and runs `leave()` in the background, with no durable "leaving" marker; a reload mid-leave shows the group again and the user can leave again.
  - `leaveTimeoutMs` is 10 000 and `removalSettleMs` 5 000, so a leave finishes within 15 s. The rewritten leave specs wait for the library group to be gone (polling `groups.list()` through a `__fewTest` hook) before reloading or re-inviting.
  - If `leave()` rejects or times out (other than `last-admin`, which is pre-checked), the group is restored to the list with the existing leave-failed i18n toast.
  - The kind-9 "left" announcement is sent first with a bounded wait and soft-fails.
  - Eligibility stays app-side: the last member abandons, and the sole admin is blocked (matches the library's `last-admin`). The leave-guard twin-read discipline moves onto library accessors.
  - `getPendingRemovals` and its UI are removed.
- **D10 Invitee key-package fetch.** Use `transport.requestWithDeadline` on the union of the invitee's kind-10050 relays, kind-10002 write relays and our defaults, filter `{kinds:[30443], authors:[pk]}`. Order the results by `created_at` descending (tie: lower event id) and call `group.invite([candidate])` with exactly one event. On `invalid-options` try the next candidate; report 'no usable key package' when all are exhausted. Never pass more than one event per invitee (the library adds one leaf per event and rejects the whole call on any invalid one).
  - "No key package found" is decided on EOSE or deadline.
  - `keyPackages.observe` is not used.
  - This preserves the fix in commit aa39de3 (invitee-advertised relays).
- **D11 Mutation gate.** Concurrency 1, on the new pure modules only: history backend, send helper, signer adapter, key-package lookup, leave eligibility, kind registry, invite-context handler. Bootstrap wiring, React context and deleted modules are not audited.
- **D12 Kind registry.**
  - App rumor kinds stay: 0, 5, 7, 9, 10, 11, 12, 30.
  - App inbox kinds: 21059 join request, 21060 pairing ack, 21061/21062 DM profile, and the new invite-context kind.
  - Library-reserved kinds come from `RUMOR_KINDS`, not literals.
  - 13 and 21063 are listed as retired and not reusable.
  - The import-time collision check covers all of the above.
- **D13 Inbound seam and own echo.** Message-type store bumps are driven from handler completion inside `HistoryBackend.append`/`withdraw`. `onNotification` drives only members, admins, name and disband resync; the two are independent and may race.
  - An own message arriving through the sink is the confirmation: it reconciles the optimistic row by `rumor.id` and raises no unread or bell.
  - This replaces dispatcher-level own-send suppression (AC-AR-22) by design.
  - Roster and admin gates inside handlers read the live library accessors (`group.members()`, `group.admins`), never the overlay.
- **D14 Deny layer on the library inbox.** ADR-008 is re-applied on the new path.
  - A pending invitation, invite-context rumor or join request from a blocked peer is dropped; invitations use `decline(id,{declineRumor:false})`.
  - The existing total and per-inviter pending-invitation caps (256 total / 8 per inviter, from `lib/pendingInvitations.ts`) are kept by silently declining the excess.
  - `invitations.pending()` is the only pending store; `lp_pendingInvitations_v1` is deleted.
- **D15 Run sequencing.**
  - Story 1 ends with a bundling proof: `make build` green, plus a temporary relay-bucket spec `groups-library-smoke.spec.ts` that creates a group and observes its own message through the history sink, via a dev-only `__fewTest` hook. The spec also exercises the library assumptions (A1–A3) for `append`, including a thrown-failure retry, and for `withdraw`. Both are deleted in the last story. If the proof fails, the run aborts with the old flow intact.
  - Stories 2–5 build the new modules beside the old flow, unwired, gated by typecheck and unit tests.
  - One cut-over story switches `MarmotContext` to the new stack. It is followed by a checkpoint subset (`groups-lifecycle`, `groups-welcome`, `groups-pull-only-invitation-accept`, `groups-pull-only-invitation-decline`, `groups-leave-intent`, `groups-remove-member`, `groups-dispatch-isolation`, `dm-walled-garden-group-member-allowed`). The subset is a dev aid, not a pass.
  - Deletion, docs and ADR follow. The end gate is `make build` plus `make test`.
  - The run tags the pre-run commit `pre-marmot-library-adoption`. If the end gate is not green when the remediation budget is spent, the run stops, reverts nothing, and reports the failing specs.
  - The final tree has no old code; coexistence is allowed only between stories inside this run.
- **D16 ADR disposition [HR].** A new ADR supersedes ADR-012's fork mechanism but keeps its handler rule: the sender comes only from the authenticated account, never `rumor.pubkey`. It reaffirms ADR-003 for app-level rev-clock mutations and supersedes only ADR-003's marmot-ts-specific claims. The "never `rumor.pubkey`" rule covers group (history-sink) handlers; inbox handlers use the seal-bound `rumor.pubkey` (D7). `own-change-lost` for a rename or admin grant is logged and the view refreshed, with no user notice.
- **D17 Inbox relay list [HR].**
  - The app publishes kind 10050 listing exactly the user's configured relays, and only when the account has none or the existing one carries the app's `client` tag. A foreign 10050 is never overwritten; its relays are used.
  - On relay-settings save, the app republishes 10050 where permitted, disposes and rebuilds the client with the new defaults, and rotates each listed key package so one exists on the new relays. This replaces `republishDiscoverability`.
  - `getBackupRelays` stops reading kind 30051 and uses the configured relays.

## Deferred Human Review

Decisions the run makes on Fable's authority, for the owner to confirm or reverse after the run:

1. D5: seed-phrase/relay recovery no longer restores groups, group chat excerpts, member profiles or invite links.
   - Co-members known only through groups are not DM-reachable after recovery until the member rejoins a group with them.
   - A recovered member's old leaf can only be cleared by removing and re-inviting the member (`removeMember` removes every leaf of the account).
   - A recovered sole admin cannot administer the group.
2. D4: group features run in one tab per account; other tabs show "active in another tab".
3. D6: messages may disappear after a fork rewind without notice; own withdrawn messages return to failed/retry.
4. D3: new gift-wrapped invite-context kind. The invitation card shows a generic label until it arrives and never shows the description or admins pre-join.
5. D9: leave is immediate in the UI but the group can reappear after a reload mid-leave; the pending-removal indicator is gone.
6. D2: NIP-07 extensions without `nip44` lose group features; bunker sessions need the library's permission set.
7. D7: two kind-1059 subscribers each decrypt every gift wrap, doubling remote-signer decrypt calls.
8. D16: a rename or admin grant lost to a fork is not surfaced to the user.
9. Non-goals: existing local groups are wiped; old builds cannot interoperate. Orphaned legacy IDB stores and localStorage keys on existing devices are left inert; no cleanup code ships.
10. An incompatible library store (`storeIncompatible`) silently deletes all local groups and their history.
11. D17: Few publishes the account's global kind-10050 inbox list (only when absent or app-tagged); a foreign list is respected, never overwritten.
12. D3/D6/D9 fixed numbers (8/64/7-day context cap, 60 s own-send confirmation timeout, 10 s leave + 5 s settle) were chosen by the run.

## Technical Approach

### Bootstrap (`app/src/lib/marmot/client/`)
Startup sequence:

```
signer (adapter)
  → createIndexedDbStorage().openForWrite(pubkey)   [lease]
  → createMarmotClient({signer, budget, transport, stores,
       relays:{defaults: user relays, mode:'discover'}, history: appHistoryBackend})
  → client.on(groupRemoved | inboxDisposition | welcomeDeclined | intentFailed
              | storeIncompatible | groupBranchSwitched)
  → registerInboxHandler(joinRequestKind 21059, …), registerInboxHandler(inviteContextKind 21064, …)
  → await client.groups.list()
  → per group: group.onNotification(...)
  → await appHistoryBackend.sweep()   (non-fatal; untouched groups only)
  → await client.inbox.start()
  → ensure key package (count() === 0 → create({lastResort:true}))
  → ensure kind-10050 published
```

On `storeIncompatible`, run `stores.account.wipe({reason:'incompatible'})`, then the app's `clearAllGroupData` (overlay, member profiles, group chat and poll rows, `few-group-history`, join requests, invite links, pending-direct-invite markers), then reinitialise. This happens at most once per page load; a second occurrence sets `unsupported`.

At every startup, overlay groups absent from `groups.list()` are purged through the same path. This standing reconciliation is also what removes pre-adoption groups. After `groups.list()` and before `inbox.start()`, a sweep re-dispatches history rows still marked `dispatched:false` for groups not yet touched; the sink also recovers a group's undispatched rows on its first touch of that group, so recovered rows always precede newer entries (see Inbound, AC-HIST-7).

Teardown is `client.dispose()` followed by `stores.close()`.

### Inbound
The app `HistoryBackend` is backed by one idb store
(`few-group-history:<pubkey>`, one IndexedDB database per account, keyed `${groupId}:${eventId}`), honouring the repo's
`idb-keyval update()` ban.

- **`append`** writes `{entry, seq, dispatched:false}` (a no-op if the row exists), runs the handlers, then sets `dispatched:true`. A repeated `append` for a row with `dispatched:false` re-runs the handlers; with `dispatched:true` it returns. Handlers receive `{groupId, eventId, rumor, sender: orderingKey.account}`, must be idempotent, and throw on durable failure so the library retries. The whole call must settle within 10 s. After the library's 5 attempts, the row stays `dispatched:false` for the startup sweep.
- **`withdraw`** deletes the entries and invokes the handlers' retract path.
- **`list`** returns entries ordered by `seq`, a per-group monotonic counter assigned at first append. Tests seed rows out of key order, because idb Map mocks return insertion order.
- **`purge`** deletes the group's entries.

Handlers must not call account-scope client ops synchronously. Follow-up sends
(profile-request responses, announcements) are queued fire-and-forget outside
the backend call.

### Outbound
`sendGroupRumor` computes the rumor id with nostr-tools `getEventHash`, sets
`pubkey` to the own account, and calls `group.send`. Chat's precomputed
canonical id (AC-AR-21) is kept, so the optimistic row and the echoed row
share an id.

### Files to delete (non-exhaustive, the planner confirms)
- `NdkNetworkAdapter.ts`, `welcomeSubscription.ts`, `epochResolver.ts`
- `rumorJournal.ts`, `applicationRumorDispatcher.ts`
- `keyPackages.ts`, the state/key-package backends in `groupStorage.ts`
- `pendingRemovalStorage.ts`, `leftGroupTombstones.ts`, `staleLocalGroup.ts`, `staleReplaceMarker.ts`, `replaceTeardown.ts`
- `membersChangedSync.ts`, `inviteeKeyPackageLookup.ts`, `relayRequest.ts` (if only KP lookup)
- `grantAdminImpl` / `renameGroupImpl` / `cancelInvitationImpl` / `leaveGroupImpl`, collapsed into thin calls with app policy kept
- the pairing-digest block in `MarmotContext`, the `discoverable` state, unused key-package helpers
- localStorage `lp_processedGiftWraps`, `lp_keyPackageSlot_v1` and `lp_pendingInvitations_v1` (`invitations.pending()` becomes the only pending store, D14)
- group-scoped sections of the kind-30078 relay backup and their restore code (D5)
- the kind-30051 relay-list publish and the kind-21063 decline DM path
- the `few-groups-state`, `few-keypackages`, `few-rumor-journal`, `few-pending-removals` and `few-left-groups` stores

### Constrained by ADRs
- ADR-012 (sender binding in the fork): superseded. The library binds `rumor.pubkey` to the MLS-authenticated sender natively.
- ADR-003 (LWW metadata mutations): reaffirmed for app-level rev-clock mutations; only its marmot-ts-specific claims are superseded (D16).
- ADR-002 (pull-only invitations): preserved. Unexpected Welcomes land in `invitations.pending()`, not auto-joined.
- ADR-007 (gift-wrapped 1:1 profile exchange) and ADR-008 (block layer): preserved.
- ADR-010 (remove member admin-only): preserved; the library enforces admin-only removal.

## Constraints

- **Privacy invariant (CLAUDE.md, non-negotiable).** No event published by the new client path may carry nickname, avatar or other profile metadata outside MLS application rumors or NIP-59 gift wraps.
  - Kind 0 is never published.
  - Kinds 30443 and 10050 carry no profile data.
  - The invite-context rumor carries `{groupId,name}` only, via `sendInboxRumor`.
- The repo-wide `idb-keyval update()` ban applies to all new storage code.
- Next 14 static export: everything is client-only. Dynamic data stays in query parameters.
- All new user-visible text goes through `i18n.ts` (en and de).

## Assumptions (library behaviour, verified by the story-1 smoke spec)

- **A1.** `HistoryBackend.append` is retried on throw or timeout (10 s) up to 5 attempts, then given up silently. Delivery is at-least-once and per-group ordered. (Source: `history/index.d.ts`.)
- **A2.** `withdraw` is called with the kind-445 event ids of messages a rewind abandoned.
- **A3.** Own application messages are delivered through the sink after confirmation. An own send whose branch was abandoned before its publish was acknowledged (never confirmed) is never delivered and never withdrawn (S6 adds the deterministic test, using an outbound publish hold). Observed in S1 (A2 harness): an own message already confirmed by publish ack on a branch that later loses a fork IS withdrawn through the sink; D6/AC-WDR-2 apply (failed/retry, not deleted).

## Acceptance Criteria anchors

The planner expands these into `acceptance-criteria.md`. Every behavioral AC must name an output, state change, emitted event content or raised error; a stub or no-op must fail it.

- **AC-OWN-1 (D13).** After a member sends a chat message and the sink echo arrives, exactly one row with that `rumor.id` exists, and unread count and bell are unchanged.
- **AC-FORGE-1.** A group rumor whose inner `pubkey` differs from the MLS sender is never rendered. Tested with two clients against the real library.
- **AC-WDR-1 (D6).**
  - After `withdraw`, another member's chat row, reaction and poll event are gone and unread is recomputed.
  - An unconfirmed own row goes to failed/retry under each of the four detection triggers, and is never auto-resent.
- **AC-IDEM-1.**
  - Replaying `append` for a dispatched event id produces no duplicate row or side effect.
  - Re-appending an undispatched row re-runs the handlers.
  - `list` returns rows in `seq` order.
- **AC-BLK-1 (D14).** An invitation, invite context or join request from a blocked peer yields no pending entry and no bell. The invitation is declined with `declineRumor:false`.
- **AC-CAP-1 (D14).** When pending invitations exceed the total or per-inviter cap, the excess is declined and the retained set equals the cap.
- **AC-AUTO-1 (D8).** An invitation matching an unexpired outbound join request is auto-accepted exactly once; a non-matching one stays pending.
- **AC-LEAVE-1/2 (D9).**
  - The sole admin is blocked from leaving; the last member abandons.
  - Otherwise the group disappears at once and the library group is gone within 15 s.
  - A failed `leave()` restores the group with the leave-failed toast.
- **AC-MT-1 (D4).**
  - A second tab shows "active in another tab", performs no group write and no membership-derived sweep, and resolves `whenReady()` once the lease outcome is known.
  - The second tab takes over without reload after the holder closes.
- **AC-KP-1 (D10).** `invite` is called with exactly one key-package event per invitee. An invalid newest candidate falls through to the next; exhaustion reports "no usable key package".
- **AC-DECL-1 (D7).** A decline received while the sponsor's group is unsynced, or while the sponsor is offline, results in `removeMember` after sync or at the next startup. The marker is cleared only afterwards.
- **AC-CTX-1 (D3).**
  - The invitation card shows the group name from an invite context only when the context's sender matches the sponsor; otherwise it shows the generic label.
  - The holding store respects its 8/64/7-day caps.
- **AC-PRIV-1.** With a recording transport, across create, invite, accept, send and profile exchange, no published unwrapped event has kind 0, and no published event other than kind 1059/445 contains the profile nickname or avatar strings.
- **AC-KIND-1 (D12).** Importing the kind registry throws if any two app kinds collide, or if a `RUMOR_KINDS` value or retired kind (13, 21063) is reused.
- **AC-WIPE-1.** `storeIncompatible` clears app-side group data and reinitialises once per page load. At startup, an overlay group absent from `groups.list()` is purged.
- **AC-REL-1 (D17).**
  - 10050 is published only when absent or app-tagged.
  - A relay-settings save rebuilds the client with the new defaults.
  - `getBackupRelays` never reads kind 30051.
- **AC-DEL-1 (structural, legitimately so).**
  - Zero imports of `@internet-privacy/marmot-ts` or bare `ts-mls` in `app/`.
  - The deleted files, localStorage keys and stores named in this spec are absent.
  - `make build` passes.

## Stories

The planner splits these. Expected seams:
1. Dependencies and client bootstrap
2. Inbound history sink and handlers
3. Outbound send and media
4. Invitations, join requests and inbox split
5. Membership and admin operations
6. Backup/recovery and storage teardown
7. Context slim-down, dead-code sweep, docs and ADR

## Non-Goals
- No migration of existing local group state or stored data. Users re-create or re-join groups.
- No compatibility with the old marmot-ts wire formats (kind 443 key packages, kind 30051 relay lists, kind 13 / 21063 app kinds). Peers on old builds cannot interoperate.
- No adapter layer that lets the old and new implementations coexist, and no feature flag.
- No change to DM, calls, pairing or theming beyond reading membership through the new API.

## Manual Validation

| ID | Behaviour | Gap evidence | Adjudicated |
|---|---|---|---|

No manual-validation rows are claimed; all ACs are automated (unit, library-backed two-client harness, or e2e).

## Amendments

- 2026-11-17 (S5 reviews + Fable decider): retract of dependent kinds (5, edit-marked 9, 7, 10, 11, 12) recomputes the affected aggregate (message slot / a message's reactions / a poll) from base state plus the history sink's remaining dispatched rows, through the same apply/authorisation core as dispatch (effect-free). Sink adds durable `withdrawing` marks, `receivedAt`, and a `remaining()` port. Plain kind-9 rows keep carrier accounting. New AC-WDR-7/8/9; AC-HIST-5 extended.

- 2026-11-17 (S3 examiners): the history store is per account (`few-group-history:<pubkey>`), matching the per-account library store and lease; a device-wide store would let one account's dispatched rows suppress another's. AC-HIST-4 bounds the entry's own dispatch (first-touch recovery may precede it once per group); AC-HIST-5 retracts registered kinds only.

- 2026-11-17 (S3 review + Fable decider): history sweep moved after `groups.list()` (before `inbox.start()`); ordering of recovered rows enforced in the sink by per-group first-touch recovery, because the library starts history drain and sync for each group during `groups.list()` (group-runtime.js:1221,1302,1308). Poisoned rows abandoned after 5 failed recoveries. Handlers reach group handles via injected `groupOf` (fail closed when the group is no longer held). AC-HIST-7, AC-BOOT-1, AC-HIST-11, AC-WDR-4 amended.

- 2026-11-17 (S1 review): A3/D6 reconciled with observed library behaviour: confirmed own messages on a losing fork branch are withdrawn; detection triggers never downgrade a confirmed row, an explicit own withdraw moves it to failed/retry (AC-WDR-2).

- 2026-11-17: Step 2.6 spec-adversary (Fable) and spec-validator findings applied (D10 single-candidate invite, history-sink dispatched flag and seq order, test-removal rule, D15 cut-over sequencing, decline durability, D17 inbox relay list, constraints, assumptions, AC anchors).
