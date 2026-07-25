# Forward-migrate to marmot-ts 0.7.0 (authenticated application-message sender) — Acceptance Criteria

## Terminology

- **the fork build** — `@internet-privacy/marmot-ts` pinned to
  `github:941design/marmot-ts#cb0025c0ae3ffd053bf4a6ec528869716148ffb2`
  (branch `authenticated-sender`) together with `ts-mls` pinned to
  `github:941design/ts-mls#9f0c7bd251429f6e56bc7a41c86d7d3e74b27b13`
  (branch `feat/app-message-sender`) — the two pins are load-bearing as a pair.
- **`senderCredential`** — the field the fork's `ts-mls` exposes on decrypted
  MLS application messages, absent on the registry `ts-mls`; its absence is
  what the library treats as "cannot authenticate → drop."
- **blackout** — the failure mode of §2 of `spec.md`: every group application
  message (chat, profile, reaction, invite/accept/admit announcement) is
  dropped because the registry `ts-mls` is resolved instead of the fork.
  Invisible to typecheck; only observable via a real message crossing a real
  MLS group.
- **`authenticity: 'mls'`** — the value the dispatcher's `AuthenticatedSender`
  type (`applicationRumorDispatcher.ts:31-34`) records for a sender the
  library has cryptographically authenticated, replacing the pre-migration
  placeholder `authenticity: 'claimed'`.
- **choke-point drop** — the existing `sender.pubkey !== rumor.pubkey → drop`
  branch at `applicationRumorDispatcher.ts:113-122`, preserved post-migration
  as defense-in-depth behind the library's own drop.
- **`markSeen`** — the per-group LRU seen-id write (`applicationRumorDispatcher.ts`)
  that must never record a dropped (sender-mismatched) rumor's id (AC-XCUT-1
  from `specs/epic-group-message-author-auth-app-layer/acceptance-criteria.md`).
- **hex slot** — a 64-char lowercase-hex string matching `/^[0-9a-f]{64}$/`,
  minted by `generateKeyPackageSlot()`, used as the KeyPackage `d`-tag
  identifier (`MarmotClient.clientId` and the per-package stored `identifier`).
  Distinct from the free-form `client: 'few'` app label
  (`keyPackages.ts:28`), which is NOT hex-validated and is unaffected by
  this epic.
- **publish-through-the-app** — the project's e2e rule (`CLAUDE.md`): a peer
  action is driven via a second real `browser.newContext()` signed-in user,
  never a hand-signed raw `WebSocket.send`.
- **S6 gate** — the announcement ingest-gate (`isGroupAdmin`/`isGroupMember`
  checks in `chatHandler.ts`, fail-closed) that validates the actor identity
  carried in an announcement's body content against the authenticated sender.

## Known TAGs

- **DEP** — dependency pin / fork-resolution assertions.
- **KEY** — KeyPackage hex-slot persistence and migration assertions.
- **SEAM** — authenticated-sender wiring behavior (Change 3).
- **GATE** — app-layer content-attribution gates (§4).
- **OBS** — observability of drops/diagnostics.
- **DOC** — documentation upkeep.
- **ORDER** — cross-cutting order-sensitivity properties (architecture.md §6).

## Dependency Pin & Fork Resolution (Change 1)

**AC-DEP-1** — A group chat message sent by a second real browser-context
peer (publish-through-the-app) MUST render in the first peer's chat view
within the e2e's polling window after the migration, proving the fork build
resolves `senderCredential` and the message does not enter the blackout drop
path. This is the primary, load-bearing guard for §2 — a green typecheck or
unit build MUST NOT be treated as a substitute for this assertion.

**AC-DEP-2** — Running `make node_modules` from a clean cache (no
pre-existing `app/node_modules`, and on a host without an SSH key configured
for `github.com`) MUST complete successfully and resolve both
`github:941design/ts-mls#9f0c7bd251429f6e56bc7a41c86d7d3e74b27b13` and
`github:941design/marmot-ts#cb0025c0ae3ffd053bf4a6ec528869716148ffb2` over
HTTPS. The `package-lock.json` `resolved` field alone MUST NOT be used as
evidence (npm normalizes it to `git+ssh` even on an HTTPS fetch) — the
observable is the cold-install exit code plus the checks in AC-DEP-3.

**AC-DEP-3** — After a cold `make node_modules`, `npm ls ts-mls` run from
`app/` MUST report exactly one resolved `ts-mls` entry, and a `grep` of
`app/node_modules/ts-mls/dist` for a symbol present only in the fork's
`senderCredential`-carrying build MUST find at least one match — two
independent, non-lockfile-string proofs that the fork (not the registry
package) is what actually installed.

## KeyPackage Slot Persistence & Migration (Change 2)

**AC-KEY-1** — On a fresh install (no persisted KeyPackage slot in storage),
the app MUST persist a `generateKeyPackageSlot()`-minted hex slot before
constructing `MarmotClient`, and KeyPackage publication MUST succeed without
throwing — observable as at least one published kind-30443 KeyPackage event
whose `d`-tag is that hex slot. This MUST hold across each of the three
slot-resolving call sites (`MarmotContext.tsx:1219` constructor, `:1390`
rotate, `:1410` create).

**AC-KEY-2** — On app startup with a persisted `clientId` of `'few'` (or any
value not matching `/^[0-9a-f]{64}$/`, the state of every pre-migration
install), the app MUST regenerate a conformant hex slot via
`generateKeyPackageSlot()`, persist it, and use it as `clientId` for that and
every subsequent launch — KeyPackage publication after this regeneration
MUST succeed without throwing.

**AC-KEY-3** — Once a conformant hex slot is persisted, it MUST be read
(never regenerated) on every subsequent launch: two consecutive app
initializations for the same install MUST use a byte-identical `clientId`,
so the addressable KeyPackage event published on launch 2 carries the same
`d`-tag as launch 1 and the relay replaces rather than duplicates it.

**AC-KEY-4** — On a `client.groups.on('joined')` rotation where the locally
stored KeyPackage's `identifier` is the legacy value `'few'`, the migration's
chosen resolution MUST cause `client.keyPackages.rotate()` to resolve to a
conformant hex slot and complete without throwing. The
`console.debug('[Marmot] Key package rotation failed:', ...)` swallow branch
(`MarmotContext.tsx`, the rotate `catch`) MUST NOT fire for this case —
resolving the silent rotation-failure loop, not merely masking it behind the
replenish path.

## Authenticated Sender Wiring (Change 3)

**AC-SEAM-1** — For a group chat message sent by a second real peer through
the app after migration, the dispatcher MUST construct
`sender.authenticity` as the literal `'mls'` (never `'claimed'`) before
handing the message to handlers — observable via the `AuthenticatedSender`
value each handler receives for that inbound rumor.

**AC-SEAM-2** — After migration there MUST be exactly one `group.on(...)`
listener registered for inbound application messages. The dispatcher
subscribes to `authenticatedApplicationMessage` only; it MUST NOT also
register a listener on the raw `applicationMessage` event for the same
group — verified by a unit test asserting `group.on` is invoked exactly once
for a message-carrying event across a `subscribe()` call.

**AC-SEAM-3** — Given a delivered event where the resolved
`senderPubkey` diverges from the deserialized rumor's `pubkey`, the
choke-point drop MUST still fire before `markSeen` is called, exactly as
today: a unit test asserting that after such a delivery, the rumor's id is
absent from the per-group seen-id set and no handler was invoked for it.

**AC-SEAM-4** — `epochResolver.ts`'s `MlsGroupLike` interface MUST compile
against the fork's widened `IngestResult` union (the `processed` variant
carrying `senderPubkey`; the new `rejected` variants for
`unauthenticated-sender` and `undeserializable`) — a `tsc` run against
`app/` with the fork installed MUST report zero type errors attributable to
this interface.

## App-Layer Attribution Gate (§4)

**AC-GATE-1** — After migration, an `invited`/`accepted`/`admitted`
announcement rumor whose body-carried actor pubkey diverges from that
rumor's authenticated `sender.pubkey` MUST still be rejected by the S6 gate
(`isGroupAdmin`/`isGroupMember` in `chatHandler.ts`) — observable as no
membership/roster change and no rendered announcement for the forged actor,
extending the existing `groups-announcement-roster-gate.spec.ts` coverage to
run against the fork build.

**AC-GATE-2** — A `leave_intent` rumor whose body-carried subject pubkey
(`payload.pubkey`) diverges from that rumor's authenticated `sender.pubkey`
MUST NOT cause `leaveHandler.ts` to call `enqueueLeave` for that subject —
the forced-removal guard at `leaveHandler.ts:43` continues to gate on
`sender.pubkey`, now backed by the library's authentication rather than the
app-side `'claimed'` stub.

## Observability

**AC-OBS-1** — When the library's `unauthenticatedMessage` diagnostic event
fires for a dropped rumor, the app MUST log all four payload fields
(`senderPubkey`, `claimedPubkey`, `reason`, `event`) via a `console.warn`
call that is visible with no `DEBUG` environment variable set — a
`debug`-gated-only log MUST NOT be the sole assertion target.

## Documentation

**AC-DOC-1** — `docs/behavior/groups.md` MUST state, in prose introduced by
this epic (not pre-existing text), that inbound group application messages
carry a library-authenticated sender (`authenticity: 'mls'`) after this
migration, MUST describe the drop-not-render behavior for a
sender-mismatched message, and MUST record a version note naming both
pinned fork SHAs (`ts-mls#9f0c7bd…`, `marmot-ts#cb0025c…`) as the app's
marmot-ts baseline. Verification MUST use a position-anchored grep against
prose that only exists post-fix (not a token — e.g. `mls` or `authenticity`
— that could already appear in the file's existing content).

## Cross-Cutting Invariants

<!-- Derived from architecture.md's "## Order-Sensitive Composition"
     signal (order_sensitive: true in exploration.json), named flow
     inbound-application-rumor-ingest-and-authenticate. -->

**AC-ORDER-1** — For any interleaving of {a sender-authenticated legitimate
rumor, a sender-mismatched rumor sharing the same rumor id, and a redelivery
of that same rumor id} across the dispatcher's per-group LRU dedup
(`applicationRumorDispatcher.ts`) and `welcomeSubscription`'s independent
raw-event-id dedup set, the sender-mismatched rumor MUST NOT be recorded in
either dedup structure, and the legitimate rumor sharing that id — whether
delivered before or after the mismatched one, in either dedup layer first —
MUST still be processed exactly once, never permanently swallowed. This
preserves the resolve-before-markSeen ordering established as AC-XCUT-1 in
`specs/epic-group-message-author-auth-app-layer/acceptance-criteria.md`
verbatim.
Spans modules: applicationRumorDispatcher, welcomeSubscription

**AC-ORDER-2** — For any sequence of `ingest()` outcomes fed to
`EpochResolver` and `welcomeSubscription` containing at least one
`rejected: 'unauthenticated-sender'` result interleaved at an arbitrary
position among `unreadable`, `skipped`, and successfully-`processed`
results, the `rejected: 'unauthenticated-sender'` result MUST NOT be added
to `EpochResolver`'s future/retry buffer (the treatment reserved for
`unreadable`), and `welcomeSubscription`'s dedup-un-mark-on-`buffered` logic
MUST NOT fire for it, regardless of where in the sequence it occurs.
Spans modules: EpochResolver, welcomeSubscription

**AC-ORDER-3** — For any ordering of competing-commit rollback and replay
within the 3-second grace window, every application message re-emitted
through `ingest()` after rollback MUST route its sender-authenticity
resolution exclusively through the dispatcher's
`authenticatedApplicationMessage` event — `EpochResolver`'s
`onApplicationMessage` callback MUST remain a no-op (zero
authenticity-affecting side effects) for every message in the replay, in
production configuration, independent of replay order or count.
Spans modules: EpochResolver, applicationRumorDispatcher

**AC-ORDER-4** — For any interleaving in which the same rumor id is observed
by both `welcomeSubscription`'s historical-sync path and
`applicationRumorDispatcher`'s live subscription (either arrival order,
including overlapping delivery), the two paths MUST agree on that rumor's
authenticity outcome (both authenticate it `'mls'`, or both reject it for
the same `reason`) and MUST deliver it to handlers at most once — divergent
outcomes across the two paths for the same rumor id MUST NOT occur for any
interleaving.
Spans modules: EpochResolver, welcomeSubscription, applicationRumorDispatcher

## Manual Validation

None. Every claim in this epic — including the §2 blackout guard, which is
invisible to static checks but not to a real two-peer e2e — is automatable
via unit, property, or e2e coverage; none met the Manual Validation gap-evidence
bar (probabilistic outcome or effort alone is not a gap). The library-level
MLS sender-authentication drop itself (spec §7 item 2, option (a)) is
out-of-epic-scope and cited from marmot-ts's own test suite rather than
tracked here as a gap of *this* epic's automation.
