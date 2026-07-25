# Feature Specification Request: Forward-migrate to marmot-ts 0.7.0 (authenticated application-message sender)

> **Status:** request / pre-spec. Hand to `/base:feature` to produce the
> implementation spec + acceptance criteria. Governed by **ADR-012** (MLS
> sender-binding in the fork). This request is the app-side landing of the
> backbone that the *done* epic `group-message-author-auth-app-layer` was
> deliberately scaffolded against — it flips the `authenticatedSenderResolver`
> seam from inert to live.
>
> **Goal, stated once:** move few.chat off marmot-ts 0.5.1 and the registry
> `ts-mls` onto **marmot-ts 0.7.0 + the `941design/ts-mls` fork**, so the
> library authenticates the MLS sender of every group message and drops
> forgeries; then wire the library's authenticated sender through the app's
> existing dispatcher seam so the app records `authenticity: 'mls'` rather than
> the placeholder `'claimed'`. No user-facing feature is added; the user-visible
> outcome is that impersonated messages can no longer appear, and honest traffic
> is unchanged.
>
> **Direction is decided, not open.** Migrate forward. The "stay on 0.5.1" and
> "library-drop-only, leave the seam dead" alternatives are rejected in §6.
> This request records *what* must change and *how it is verified*, not *whether*.

---

## 1. Intent

### 1.1 Motivation

Two things are simultaneously true and pull in the same direction:

1. **The impersonation defect is real and on record.** Group messages are
   attributed to a self-declared, forgeable `rumor.pubkey`; the 0.5.1 receive
   path never learns the true MLS sender (`applicationRumorDispatcher.ts`,
   `authenticatedSenderResolver.ts` returns `authenticity: 'claimed'`). ADR-006
   accepted this only because the library discarded the sender. ADR-012
   supersedes that: we now control the fork, so the check gets implemented.

2. **The library fix lives on a feature branch, not yet merged or released.**
   marmot-ts **0.7.0** (the `authenticatedApplicationMessage` /
   `unauthenticatedMessage` events, the widened `ingest()` result, the
   drop-with-state-adoption path, and the upgrade guide) is on the
   `authenticated-sender` branch of `941design/marmot-ts` at
   `cb0025c0ae3ffd053bf4a6ec528869716148ffb2` — **not** on `master`, no tag, no
   npm release, `package.json` still `0.6.0`. A **branch-SHA pin is available
   today** (see §5). The library resolves the MLS-authenticated sender
   (`senderCredential`,
   available **only** in the `941design/ts-mls` fork) and enforces that
   `rumor.pubkey` matches it. A
   mismatched or undeserializable message is **dropped** — not stored, not
   yielded as `processed`, not emitted on `applicationMessage` — while the MLS
   state is still adopted (forward secrecy preserved) and the drop is surfaced
   (never silent).

The app was **designed** for this moment: the choke-point dispatcher, the
`AuthenticatedSender { pubkey, authenticity: 'claimed' | 'mls' }` type, and the
`authenticatedSenderResolver` stub all exist and are wired, waiting for the
backbone. This request lands the backbone.

### 1.2 The version gap

The app is on **0.5.1**. The jump to **0.7.0** crosses **0.6.0**, which carries
an *independent* breaking change (MIP-00 KeyPackage slot identifiers). Both must
be handled in one migration. **The spec author must read the complete
0.5.1→0.7.0 changeset/CHANGELOG history**, not just the two changes this request
names — the app also touches `client.groups.on('joined')`, welcome/invite APIs,
`deserializeApplicationData`, and KeyPackage `list`/`rotate`, any of which may
have drifted across three minor bumps.

### 1.3 Outcome (behaviour)

- A message shown as authored by X was verified by the library to have been
  sent by X; a forged textual message (claimed author ≠ real MLS sender) is
  **dropped by the library** before the app ever sees it, and never rendered
  under the victim's name.
- Honest traffic is **unaffected** — clients that stamp `rumor.pubkey` with the
  real sender's key (i.e. every current few.chat client) see no change.
- Drops are **observable**: a member-on-member impersonation campaign surfaces
  as diagnostics rather than vanishing without trace.
- The app records the sender as `authenticity: 'mls'` (authenticated) instead of
  the placeholder `'claimed'`, discharging VQ-S1-009 / ADR-012.
- No chat, profile, reaction, or announcement regresses for legitimate senders.

---

## 2. The critical invariant (must be stated in the spec, not discovered in prod)

> **Switching `ts-mls` to the `941design/ts-mls` fork is load-bearing. Without
> it, EVERY group application message is dropped and the app goes dark.**

The library reads the authenticated sender from a `senderCredential` field that
exists **only** in the fork. marmot-ts declares `ts-mls` as a peer dependency
with a plain range (`>=2.0.0-rc.10`); the **registry** `ts-mls 2.0.0-rc.10`
(what the app pins today) satisfies that range but returns `undefined` for
`senderCredential`, which the library treats as "cannot authenticate → drop."
The failure mode is a **silent, total blackout** of group messaging — chat,
profiles, reactions, invite/accept/admit announcements — that a green
type-check and a green unit build will NOT catch. It only shows up when a real
message crosses a real MLS group.

The acceptance criteria MUST include an e2e that proves a real message survives
end-to-end on the fork, precisely because this failure is invisible to static
checks.

---

## 3. The three required changes

### 3.1 Change 1 — Pin `ts-mls` to the fork (MANDATORY)

`app/package.json` (and the root, if it also carries the pin):

```jsonc
// BEFORE
"ts-mls": "2.0.0-rc.10"
// AFTER
"ts-mls": "github:941design/ts-mls#9f0c7bd251429f6e56bc7a41c86d7d3e74b27b13"
```

- **Ref provenance — settled (§5).** `9f0c7bd…` is the tip of the unmerged
  feature branch `feat/app-message-sender`; fork `main` does **not** carry
  `senderCredential`. Owner decision (§5): pin the branch SHA directly. The
  companion marmot-ts pin (`941design/marmot-ts#cb0025c…`, branch
  `authenticated-sender`) is likewise a feature-branch SHA — see §5 for both.
- The pin must resolve over **HTTPS + token, not `git+ssh`**. This host's
  environment rewrites `github:`/`git+https` locks back to `git+ssh`, which
  breaks `make` installs on hosts without SSH access (see the recorded
  `ink_dep_https_access.md` friction for the sibling `@rotheric/visuals` dep).
  The spec must verify `package-lock.json` resolves the fork over HTTPS and that
  `make node_modules` succeeds clean from a cold cache.
- **Single-instance check (acceptance criterion):** `npm ls ts-mls` must show
  exactly one resolved copy, and it must be the fork. marmot-ts and the app
  sharing one `ts-mls` copy is load-bearing — two copies produce incompatible
  branded types and group state cannot be shared. The peer-dependency
  restructure (`ts-mls` is a `peerDependency >=2.0.0-rc.10` at marmot-ts HEAD,
  vs a regular exact dep in 0.5.1) makes this likely-correct-by-construction,
  but it must be checked, not assumed.

> Footnote (npm-only project, no action): the fork builds its `dist/` at install
> via a `prepare` script; npm/yarn build git deps automatically. Only if the
> toolchain ever becomes pnpm would `ts-mls` need adding to
> `onlyBuiltDependencies`. There is no root `package.json`; the pin lives in
> `app/package.json`.

### 3.2 Change 2 — Persisted KeyPackage slot identifier (MANDATORY, from 0.6.0)

`clientId: 'few'` (`MarmotContext.tsx:1219`) is the slot value. Traced through
the library: `MarmotClient.clientId` → `KeyPackageManager` → used as
`createKeyPackageEvent`'s `identifier` fallback → validated against
`/^[0-9a-f]{64}$/` → **throws** on any free-form string. Effect on upgrade:
KeyPackage publication throws, **no KeyPackages are published, and the user can
never be invited to a group.** (The doc-comment claim that the throw fires
*before* local persistence so no orphan private material is left is a
library-internals assertion — the spec must **confirm** it against the installed
version, not inherit it from this request.)

**The `client` tag is NOT affected — resolved, not deferred.** `create({ client:
'few' })` (`app/src/lib/keyPackages.ts:28`) passes a free-form app label; the
library types it `client?: string` and appends it verbatim with no format
constraint. Only the **slot/identifier** is hex-validated. Leave the `client`
label alone; change only the slot.

Required:

- Mint the slot **once** with `generateKeyPackageSlot()` (64-char lowercase hex),
  **persist it** (alongside identity/signer state), and reuse it on every launch
  as `clientId`. It must be stable across launches — the current design
  deliberately reuses one addressable `d`-slot so relays *replace* the previous
  KeyPackage on rotation; a fresh-random-per-launch slot would break rotation
  and litter relays with orphan slots. Persistence location and whether
  regeneration needs any user-visible signal (expected: no) are for the spec.
- **Migration for existing installs — the `clientId` is not the only stored
  `'few'`.** Two surfaces carry it:
  1. `MarmotClient.clientId` — on startup, validate any stored slot against
     `/^[0-9a-f]{64}$/`; if missing or non-conformant (every current install has
     `'few'`), regenerate via `generateKeyPackageSlot()` and persist.
  2. **Per-package stored `identifier` on the rotate path (GAP the first draft
     missed).** `MarmotContext.tsx:1390` calls
     `keyPackages.rotate(pkg.keyPackageRef, { relays })` with **no `d`** on every
     `'joined'` event; `rotate()` resolves the slot as
     `options?.d ?? existing.identifier ?? random`, so every legacy package
     (stored `identifier: 'few'`) **throws inside `rotate()` → `create()`**,
     swallowed to `console.debug` at `MarmotContext.tsx:1394` — a permanent
     silent rotation-failure loop, masked by the replenish path
     (`countAvailableKeyPackages` filters `!p.used`). The spec must choose one:
     migrate/regenerate the stored per-package identifiers, pass an explicit
     conformant `d` on `rotate()`, or explicitly accept rotate-failure-plus-
     replenish and document it. Silent-failure-by-default is not acceptable.
- **Third publish call-site to keep consistent:** `MarmotContext.tsx:1410`
  `keyPackages.create({ relays })` resolves its slot purely from the manager
  `clientId` fallback — fixed transitively once `clientId` is the hex slot, but
  the spec should confirm all three sites (`:1219` constructor, `:1390` rotate,
  `:1410` create) resolve to a conformant slot post-migration.
- The old `d: 'few'` KeyPackages already on relays become stale/orphaned —
  acceptable; note it, no cleanup required.

### 3.3 Change 3 — Wire the authenticated sender through the seam (REQUIRED)

Today `createAuthenticatedSenderResolver()` returns
`{ pubkey: rumor.pubkey, authenticity: 'claimed' }` — inert. With 0.7.0 the
library already drops forgeries, but the app must additionally consume the
library's authenticated sender so it records `authenticity: 'mls'` and can feed
its own attribution checks (§4). Concretely:

- **There is exactly ONE `applicationMessage` listener in the app** —
  `applicationRumorDispatcher.ts:136`. The prior dual-listener architecture was
  already consolidated by the *done* unified-dispatch epic:
  `ChatStoreContext.tsx:503-505` states ingestion "is now handled exclusively by
  the unified applicationRumorDispatcher wired in MarmotContext" and only
  re-reads IDB on `chatVersion` bumps. The old
  `architecture_marmot_dual_listener.md` note is **stale** — do not migrate a
  second listener; there isn't one.
- Move that single subscription from the raw byte stream to the source that
  carries the authenticated sender — the new `authenticatedApplicationMessage`
  event (`{ message, senderPubkey, senderLeafIndex }`) or the `ingest()` result
  whose `processed` variant now carries `senderPubkey` / `senderLeafIndex`. The
  spec decides which.
- **`epochResolver.ts` is in scope regardless of that choice.**
  `app/src/lib/marmot/epochResolver.ts:59-65` hand-pins the 0.5.1 `ingest()`
  result union in a local `MlsGroupLike` interface
  (`{ kind: 'processed'; result: { kind: 'applicationMessage'; message: Uint8Array } | { kind: 'newState' } }`)
  and dispatches deserialized rumors via an `onApplicationMessage` callback. 0.7.0
  widens the processed variant and adds sender-rejection outcomes; this interface
  must be updated to compile against the new union, and the resolver-side dispatch
  sites must not bypass the sender check if ever wired to a live handler.
- Feed the library's `senderPubkey` into the resolver so the dispatcher stamps
  `authenticity: 'mls'`. The existing choke-point (`sender.pubkey !== rumor.pubkey
  → drop`, `applicationRumorDispatcher.ts:102-124`, including the AC-XCUT-1
  markSeen ordering) becomes belt-and-suspenders behind the library's own drop;
  keep it — it is cheap and it is the seam ADR-012 specified.
- Subscribe to the `unauthenticatedMessage` diagnostic event (payload
  `{ senderPubkey, claimedPubkey?, reason, event }`) for observability of drop
  campaigns (log-level; no UI surface required by this request). Log all four
  fields.
- Retire the dev-only `window.__fewTest.resolveAuthenticatedSender` override
  **only if** the e2e strategy no longer needs it; if the impersonation e2e now
  drives a genuinely divergent MLS sender through a second browser context (the
  project's publish-through-the-app rule), the override becomes dead scaffolding
  and should be removed. The spec decides.

---

## 4. App-layer attribution stays the app's responsibility

The library authenticates `rumor.pubkey` against the MLS sender — **necessary
but not sufficient** for few.chat. The app attributes some authorship on fields
*inside* the rumor content, not on `rumor.pubkey`:

- System announcements (`invited` / `accepted` / `admitted` / leave) carry actor
  identity in the message body; `leaveHandler` historically actioned a `pubkey`
  read from the **body** (the worst-case forced-removal vector in the
  author-auth spec-request).
- The *done* epic's **S6 announcement ingest-gate** (`isGroupAdmin` /
  `isGroupMember`, fail-closed) is exactly the app-layer check the library
  cannot do.

**This gate must survive the migration unchanged in intent.** The spec must
verify that after migration, the S6 handlers validate their content-carried
attribution field against the library's surfaced `senderPubkey` — not against
the claimed `rumor.pubkey` alone. Landing the backbone does not retire S6; it
gives S6 a trustworthy sender to check against.

---

## 5. The coordination blocker — RESOLVED (owner decision, 2026-07-25)

The 0.7.0 feature is unpublished and unmerged (on feature branches of two
941design forks, `package.json` still `0.6.0`). 941design owns marmot-ts, the
ts-mls fork, and few.chat, so obtaining it was coordination, not an external
wait. **Owner decision: pin the known feature-branch SHAs now** (swap to
`^0.7.0` once published). The two refs are pinned together — a mismatched pair
(new marmot-ts against a `ts-mls` without `senderCredential`) reproduces the §2
blackout, so both are load-bearing:

| Dependency | Pin (concrete, verified via `git ls-remote` 2026-07-25) | Branch |
|---|---|---|
| `ts-mls` | `github:941design/ts-mls#9f0c7bd251429f6e56bc7a41c86d7d3e74b27b13` | `feat/app-message-sender` |
| `@internet-privacy/marmot-ts` | `github:941design/marmot-ts#cb0025c0ae3ffd053bf4a6ec528869716148ffb2` | `authenticated-sender` |

- Both are **pinned by immutable commit SHA**, not branch name, so a later push
  to either branch does not silently move the app's dependency.
- npm's `github:owner/repo#sha` shorthand resolves over **HTTPS**, satisfying
  §3.1's HTTPS-not-`git+ssh` requirement even though the forks' own `origin` is
  SSH. The implementer must still verify the resulting `package-lock.json`
  entries are HTTPS and that `make node_modules` succeeds cold (§3.1, §7).
- **Publication follow-up (not this epic):** when 941design publishes
  `@internet-privacy/marmot-ts@0.7.0` to npm and merges the ts-mls fork, a
  follow-up swaps both `github:` pins for clean semver ranges. Tracked as a
  future backlog item, not a blocker here.

---

## 6. Rejected alternatives (recorded so they are not re-litigated)

| Option | Why rejected |
|---|---|
| **Stay on 0.5.1** | Leaves the impersonation defect open indefinitely against ADR-012's explicit decision to fix it once the fork exists — which it now does. The seam, the type, and the epic were all built for exactly this landing; not landing it strands that work as dead scaffolding. |
| **Bump the library but keep registry `ts-mls`** | `senderCredential` is `undefined` → **every message dropped** → total blackout (§2). Non-viable, not a trade-off. |
| **Library-drop-only; leave the seam `'claimed'` forever** | The library's drop covers `rumor.pubkey` forgery, but few.chat attributes some authorship on content fields the library does not police (§4). Leaving the seam inert means S6 still validates against an unauthenticated claim, and ADR-012 / VQ-S1-009 stay undischarged with live-but-dead scaffolding in the tree. |

None of these has a column that wins on any axis that matters; forward migration
with the seam wired is the only option that closes the defect *and* clears the
scaffolding.

---

## 7. Verification (the gate, stated up front)

- **The operational gate (ONE criterion, stated once):** the migration's own new
  specs (below) plus the **full groups/relay bucket** (`groups-*`, `dm-*`, 48
  tests — they exercise the real MLS path this migration changes) must pass
  green. The full `make test-e2e-all` (60 = 12 non-relay + 48 relay) is run, but
  it is chronically red on ~4 rotating VM-latency timeouts
  (`e2e_full_gate_preexisting_flaky.md`), so the *judgement* is "own specs +
  groups bucket green," not a zero raw-red count. (This supersedes any reading of
  the CLAUDE.md "full suite" line as a raw-count gate — the split exists for
  infrastructure, not importance, and the relay bucket is the load-bearing half
  here.) `test-e2e-fast` / filtered runs are dev aids only, never a pass.
- **New/updated e2e that must exist (§2 is invisible to static checks):**
  1. A legitimate group chat message sent from a second real browser context
     (publish-through-the-app, never raw WebSocket) arrives and renders on the
     first — proves the fork resolves `senderCredential` and honest traffic
     survives. This is the primary §2-blackout guard.
  2. **Impersonation drop — decide WHERE it is proven (spec must resolve, do not
     leave as the first draft did).** The app *cannot itself* publish a rumor
     whose `pubkey` diverges from its MLS sender — that is the very property
     being enforced — so an app-driven "genuinely divergent sender" is
     infeasible under the publish-through-the-app rule. Two honest options, pick
     one and state it: **(a)** prove the library-level drop with a **library test
     in marmot-ts / a crafted-MLS-ciphertext fixture** (the CLAUDE.md "events the
     app cannot itself produce" exception — requires valid MLS encryption from a
     member key), asserting the message is dropped and not rendered; **(b)** if
     only the *app choke-point* is exercised, use the `__fewTest` override and
     state plainly that this proves the app seam, **not** the library's MLS
     check. Do not claim (b) proves §2.
  3. KeyPackage publication succeeds after upgrade with the persisted hex slot;
     an existing `clientId: 'few'` install regenerates a conformant slot on
     startup; and a legacy stored per-package `identifier: 'few'` no longer
     throws on the `'joined'` rotate path (proves the full §3.2 migration,
     including the rotate gap — not just fresh-install).
  4. The S6 announcement gate still rejects a forged `invited`/`accepted`/leave
     actor after migration (proves §4 survived).
- **Observability assertion target (make it checkable):** e2e #2's "drop is
  observable" needs a concrete target — a `console.warn`/`unauthenticatedMessage`
  message pattern, or a `window.__fewTest` drop counter the test reads. A
  `debug`-gated log (invisible without a `DEBUG` env) is NOT an acceptable
  assertion target on its own.
- **Cold-install verification:** `make node_modules` from a clean cache resolves
  the `ts-mls` fork over HTTPS (not `git+ssh`) and builds its `dist/`, and
  `npm ls ts-mls` shows exactly one resolved copy (the fork) — run on this host,
  because the lockfile-rewrite friction is host-specific.
- **Pre-existing regressions are OUT OF SCOPE for this gate (owner call, not
  inherited here).** The two known author-auth-epic regressions — own-send echo
  suppression AC-AR-22, reaction-badge propagation AC-40
  (`regression_authauth_epic_ownsend_reactions.md`) — belong to the author-auth
  epic and carry an open owner decision (fix-product vs update-expectation). This
  migration must **not worsen** them; *resolving* them is tracked separately and
  is not a precondition for shipping this migration unless the owner folds it in
  explicitly.
- **Docs upkeep (CLAUDE.md mandate):** update `docs/behavior/groups.md` (group
  messaging / author attribution) in the same run via `/behavior-docs`, and add a
  `## 0.7.0` note wherever the app records its marmot-ts baseline. No new design
  rule is introduced, so `docs/design-rationales.md` is untouched unless the
  drop surfaces a UI affordance (it should not).

---

## 8. Non-goals

- No deniability (ADR-012 §1 — explicit project non-goal).
- No new UI for dropped/unauthenticated messages beyond diagnostic logging.
- No change to the bare-plaintext non-Few kind-4 DM exception in `CLAUDE.md`.
- No change to the `client` app-label tag — traced and confirmed free-form
  (`client?: string`, not hex-validated); only the slot identifier is (§3.2).
- No profile-broadcast surface changes — the privacy invariant is untouched by
  this migration and must remain so.

---

## 9. Open questions for the spec author

1. **Two pinned refs** (§5, §3.1): **RESOLVED 2026-07-25** — owner chose to pin
   the feature-branch SHAs now (`ts-mls#9f0c7bd…`, `marmot-ts#cb0025c…`); see the
   §5 table. No longer open.
2. **Consumption seam** (§3.3): `authenticatedApplicationMessage` event vs
   `ingest()` `senderPubkey` for the single dispatcher listener — which has least
   churn? (The dual-listener framing is retired; there is one listener plus the
   `epochResolver.ts` interface to update either way.)
3. **Impersonation-e2e layer** (§7 item 2 + §3.3): prove the drop with a
   library/fixture test (option a) or exercise only the app choke-point via
   `__fewTest` (option b, weaker)? This decides whether the `__fewTest` override
   is retired or kept.
4. **Slot persistence location** (§3.2): where does the 64-hex slot live
   (identity store / IndexedDB key), and does regeneration on a non-conformant
   stored value need any user-visible signal? (Expected: no.)
5. **Rotate-gap disposition** (§3.2): migrate stored per-package identifiers,
   pass an explicit `d` on `rotate()`, or accept-and-document rotate-failure-
   plus-replenish?

---

## Amendments

- **2026-07-25 — resolves `BACKLOG.json#marmot-ts-0-5-1-drops`.** That
  finding read: *"marmot-ts 0.5.1 drops the MLS sender-leaf credential for
  application messages — inner rumor pubkey is not identity-bound to the
  authenticated sender."* This epic's Change 1 (§3.1, fork pin) and Change 3
  (§3.3, seam wiring) close it: the `941design/ts-mls` fork (branch
  `feat/app-message-sender`) resolves `senderCredential` during unprotect and
  the `941design/marmot-ts` fork (branch `authenticated-sender`) enforces
  `rumor.pubkey === senderPubkey`, dropping mismatches before the app ever
  sees them (AC-DEP-1, AC-SEAM-1..4). `applicationRumorDispatcher.ts` now
  records `sender.authenticity: 'mls'` instead of the former `'claimed'`
  placeholder, and `deleteEditHandler.ts`'s header comment was updated in
  this run to record the closure. The finding's `success_signal`
  ("applicationRumorDispatcher rejects an application rumor whose inner
  pubkey != the MLS-authenticated sender leaf credential, proven by a
  forged-pubkey test") is satisfied library-side per ADR-012 and app-side by
  AC-SEAM-1/AC-SEAM-3. Resolved via `base:project-curator` as `done`,
  target this spec.
