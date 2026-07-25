# Architecture — marmot-ts 0.7.0 authenticated-sender migration

> Synthesized from `exploration.json` (3 code-explorer runs, 2026-07-25) and the
> exact 0.7.0 type surface read from the pinned `941design/marmot-ts`
> `authenticated-sender` fork. Governed by **ADR-012** (Proposed). This epic
> lands the **backbone half** only (MLS sender binding + app consumption); the
> enum-meta-event forwarding layer (`envelopeVerifier.ts`) is out of scope.

## 1. Paradigm

Modular monolith, package-by-feature. The marmot subsystem
(`app/src/lib/marmot/**`) is a hexagonal seam over the `@internet-privacy/marmot-ts`
library: handlers and the dispatcher hold **zero React/context imports**
(enforced boundary, stated at `applicationRumorDispatcher.ts:7-11`). React
context (`MarmotContext.tsx`, `ChatStoreContext.tsx`) is the composition +
wiring layer. This migration changes **the data source of one value**
(`sender.pubkey`) and **the dependency pins** — it does not restructure modules.

## 2. Module map (touched or in-blast-radius)

| Module | Location | Role in this epic | Change |
|---|---|---|---|
| **package pins** | `app/package.json`, `app/package-lock.json` | Dependency baseline | `ts-mls`→fork SHA, `@internet-privacy/marmot-ts`→fork SHA (see §5 of spec) |
| **keyPackages** | `app/src/lib/keyPackages.ts` | KeyPackage publish helper (`create({client:'few'})` = free-form label, NOT the slot) | No slot change here; the `client` label is not hex-validated |
| **MarmotContext** | `app/src/context/MarmotContext.tsx` | Wiring layer: `new MarmotClient({clientId})` (:1219), 3 KeyPackage slot resolution sites (:1219 ctor, :1390 rotate, :1410 create), dispatcher wiring (:1699, :1824) | Persisted slot load-or-generate before :1208; pass explicit `d` on rotate; switch dispatcher event source |
| **STORAGE_KEYS / storage** | `app/src/types/index.ts` (`STORAGE_KEYS`), `app/src/lib/storage.ts` (`readItem`/`writeItem`) | Persistence pattern for `lp_*` localStorage scalars | New `keyPackageSlot: 'lp_keyPackageSlot_v1'` entry + load-or-generate helper |
| **applicationRumorDispatcher** | `app/src/lib/marmot/applicationRumorDispatcher.ts` | The single `group.on('applicationMessage')` listener (:136), choke-point drop (:98-124), `AuthenticatedSender`/`SenderResolver` types (:31-44) | Switch to `authenticatedApplicationMessage`; build `{pubkey: senderPubkey, authenticity:'mls'}`; keep choke-point as defense-in-depth; wire `unauthenticatedMessage` diagnostic |
| **authenticatedSenderResolver** | `app/src/lib/marmot/authenticatedSenderResolver.ts` | The inert `'claimed'` stub + `__fewTest.resolveAuthenticatedSender` override | Retire or repurpose — decided by the e2e-strategy (§ Seams below) |
| **epochResolver** | `app/src/lib/marmot/epochResolver.ts` | Historical-sync `ingest()` wrapper; `MlsGroupLike` union hand-pins 0.5.1 shape (:59-69). `onApplicationMessage` callback is a **documented no-op in production** (`welcomeSubscription.ts:1163-1168`) | Widen `MlsGroupLike` union for compilation against 0.7.0 `IngestResult`; classify `rejected:unauthenticated-sender` as terminal (NOT bufferable) |
| **handlers/** | `app/src/lib/marmot/handlers/*.ts` | Already authorize on `sender.pubkey` (chatHandler, `leaveHandler:43`, pollHandler, profileHandler, deleteEditHandler) | **No code change** — landing `authenticity:'mls'` makes existing checks trustworthy; verify only |
| **behavior docs** | `docs/behavior/groups.md` | Product spec of group messaging | Add the `'mls'` sender guarantee + drop-not-render behavior |

**Explicitly NOT changed** (verified already-wired to `sender.pubkey`): every
handler's attribution gate (§4 of spec), including the `leaveHandler:43`
forced-removal vector. The migration makes `sender.pubkey` authentic; it does
not re-wire the gates.

## 3. Boundary rules

- No direct imports across module boundaries; handlers stay React/context-free.
- The dispatcher remains the **single** inbound-message listener. Post-migration
  there must still be exactly one `group.on(...)` message listener (now on
  `authenticatedApplicationMessage`, not `applicationMessage`) — never both
  (both fire for the same authenticated message; listening to both double-processes).
- `epochResolver`'s `onApplicationMessage` callback must **remain a no-op in
  production** — it must not silently become a second consumption point.

## 4. Seams

**Seam A — the dispatcher's message-source event (the Change-3 decision).**
The single listener switches from `group.on('applicationMessage', (data: Uint8Array)=>…)`
to `group.on('authenticatedApplicationMessage', ({message, senderPubkey, senderLeafIndex})=>…)`.
Inside, deserialize `message` into the `ApplicationRumor` (for id/kind/content)
and construct `sender = { pubkey: senderPubkey, authenticity: 'mls' }` **directly**
— the library already guarantees `senderPubkey === rumor.pubkey`, so the
existing choke-point (`sender.pubkey !== rumor.pubkey → drop`, :113-122) becomes
**defense-in-depth** (keep it — cheap, and the AC-XCUT-1 resolve-before-markSeen
ordering at :102-124 must be preserved verbatim). The `SenderResolver` param
`(rumor)=>AuthenticatedSender` has no channel for a library sender, so the
authenticated case does not route through `authenticatedSenderResolver` at all.

**Seam B — the inert resolver + `__fewTest` override (coupled to e2e strategy).**
Two coherent end-states; the architect picks one and records the choice:
- **B1 (recommended): retire the resolver stub.** Delete `authenticatedSenderResolver.ts`,
  its unit test, and the `resolveSender` param; the listener builds `sender`
  from the event. Cleanest discharge of ADR-012 / VQ-S1-009 — no dead scaffolding.
  Requires the impersonation e2e to NOT depend on the app-side override (see
  Seam C).
- **B2: keep a minimal override hook** at the listener (inject a divergent
  `senderPubkey` vs claimed `rumor.pubkey`) if an app-choke-point e2e is wanted.

**Seam C — impersonation verification layer (§7 item 2; resolves §9 Q3).**
The app **cannot** publish a divergent-sender rumor by design (`buildRumor`
always stamps the local pubkey — verified). So an app-driven e2e cannot exercise
the *library's* MLS check. Honest split, to be stated in the AC:
- The **library's** drop is proven by marmot-ts's own tests (the fork carries
  `AC-OBSERVABLE-1` / `AC-SURFACE-1` coverage) — **out of this epic's scope**,
  cited not re-proven.
- The **app** e2e proves the *blackout guard* (§7 item 1: a legit peer message
  survives on the fork) as the primary, load-bearing test. An optional
  app-choke-point drop e2e (via a `__fewTest` divergent-sender hook, Seam B2)
  may assert the defense-in-depth drop + the `[dispatcher.unauthenticatedMessage]`
  `console.warn` — labeled explicitly as proving the app seam, NOT §2.

Recommendation: **B1 + Seam-C library-cited** — retire the stub, prove the app
side via the blackout guard, cite the library's own tests for the drop. Keep the
choke-point defense-in-depth. If the architect prefers a live app-drop e2e,
take B2 and keep the hook.

## 5. Implementation constraints

- **Fork install is load-bearing and silent-failure-prone.** Without the fork,
  `senderCredential` is `undefined` → every message dropped → total blackout,
  invisible to typecheck. Cold `make node_modules` + `npm ls ts-mls` (single
  copy) + a grep of `node_modules/ts-mls/dist` for a 0.7.0-unique symbol are the
  only real proofs the fork is actually present. npm normalizes the lockfile
  `resolved` field to `git+ssh` even on an HTTPS fetch (learning
  `verifying-private-npm-git-dependency-sandboxed`), so the lockfile string is
  not proof — a successful cold install on a no-SSH-key host is
  (`npm-ci-with-git-ssh-deps`: `GIT_CONFIG_COUNT` per-process rewrite via
  `gh auth token`).
- Exact 0.7.0 types (verbatim from the fork) the app must compile against:
  - `AuthenticatedApplicationMessage { message: Uint8Array; senderPubkey: string; senderLeafIndex: number }`
  - `UnauthenticatedMessageInfo { senderPubkey: string; claimedPubkey?: string; reason: 'unauthenticated-sender'|'undeserializable'; event: NostrEvent }`
  - `IngestResult` = `Processed(StateChange|ApplicationMessage w/ top-level senderPubkey + result.senderLeafIndex) | Rejected(admin-policy w/ result+message | unauthenticated-sender/undeserializable w/ senderPubkey+claimedPubkey?, NO result) | Skipped(past-epoch|wrong-wireformat|self-echo|self-echo-commit|lost-race) | Unreadable(errors[])`.
- KeyPackage slot: `generateKeyPackageSlot()` (64-hex) minted once, persisted,
  reused. Throw fires inside `createKeyPackageEvent` before `this.add()` local
  persistence — confirmed against the fork's regression-guard test, but the
  impl must re-confirm against the installed version.
- i18n: no new user-facing copy expected (§8 non-goal). If a UI affordance
  appears, both `en`+`de` are required.

## 6. Order-Sensitive Composition

**YES — this epic composes order-sensitive subsystems.** Named flow:
*inbound-application-rumor-ingest-and-authenticate* (raw kind-445 event → rendered
attributed UI).

Participating modules (name + Location):
- `EpochResolver` — `app/src/lib/marmot/epochResolver.ts` (future-epoch buffering, competing-commit rollback/replay, promise-chain serialization)
- `welcomeSubscription` — `app/src/lib/marmot/welcomeSubscription.ts` (dual-phase historical+live subscribe; a **second**, independently-capped dedup set on raw event-id, deliberately un-marked on `buffered:true`)
- `applicationRumorDispatcher` — `app/src/lib/marmot/applicationRumorDispatcher.ts` (per-group LRU dedup on **rumor-id**; sender-resolve-before-markSeen invariant AC-XCUT-1)
- `chatPersistence` / handlers — `app/src/lib/marmot/handlers/*`, `app/src/lib/chatPersistence.ts` (insert-if-absent storage primitives; `immutability-authz-gates-can-defeated-via` risk)

Candidate whole-flow guarantees (must hold across orderings/interleavings):
1. **No sender-mismatched rumor reaches `markSeen`** in *either* dedup layer
   (rumor-id LRU or raw-event-id set) — a drop is a true no-op on both id-spaces,
   or a legitimate later redelivery is silently swallowed.
2. **A `rejected:unauthenticated-sender` outcome is classified terminal, never
   bufferable** — `epochResolver` must not treat it like `unreadable`
   (retriable buffer), and `welcomeSubscription`'s un-mark-on-`buffered` logic
   must not misfire on it.
3. **The 3s grace-window commit-finalization + rollback/replay** re-emit through
   `ingest()`→event→dispatcher; no separate sender-resolution logic may appear
   inside `EpochResolver` — its `onApplicationMessage` no-op must stay a no-op.
4. **Historical/live overlap** must not evaluate the same rumor for authenticity
   twice with divergent outcomes — relies on `ingest()` per-event idempotency by
   MLS epoch ordering, which must extend to the new authenticated variants.

Risk concentration: `epochResolver.ts:59-69`'s `MlsGroupLike` union is the single
compile-time contract; getting its widening's classification right
(`processed`/`unreadable`/`skipped`/`rejected+reason`) gates all four behaviors.

## 7. Notes for planning

- **Stale learning to supersede:** `mls-resubscribe-can-permanently-drop-future`
  describes a bug already fixed at `welcomeSubscription.ts:1196-1206` — do not
  treat as current risk; supersede when touching that file.
- Confirm the possible 4th `keyPackages.list()` site at `MarmotContext.tsx:2496`
  is not a mutation/slot site.
- Known regressions `own-send-message-echo-no-longer` (AC-AR-22) and
  `group-reaction-badge-no-longer-propagates` (AC-40) are separate backlog
  findings — this epic must **not worsen** them; resolving them is out of scope.
- On completion, the open finding `marmot-ts-0-5-1-drops` is resolved by this epic.
