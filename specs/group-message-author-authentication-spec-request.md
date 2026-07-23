# Feature Specification Request: Group Message Author Authentication (no impersonation)

> **Status:** request / pre-spec. Hand to `/base:feature` to produce the
> implementation spec + acceptance criteria. Companion to
> `proposals/PROPOSAL-marmot-ts-authenticated-sender.md` (the fork-side
> spec-conformance PR) and governed by **ADR-012** (which supersedes ADR-006).
>
> **Goal, stated once:** it must be impossible for one group member to make a
> message — textual or system — appear to come from, or act on behalf of,
> another member without that member's cryptographic consent. Legacy and
> non-Few messages remain readable and correctly attributed.
>
> **Architecture is decided (ADR-012), not open.** This is a **hybrid**:
> a spec-mandated MLS **sender-binding backbone in the marmot-ts/ts-mls fork**,
> plus **signed enum meta-events in the app payload** for system messages that
> must be forwardable. Deniability is an explicit project **non-goal** (ADR-012 §1).
>
> **Assumption flagged for the requester.** "Read and display **unencrypted**
> messages" is read as **"unsigned / legacy messages"** (today's build and
> third-party Marmot clients that carry no inner signature). Under the backbone
> these are handled natively — see §7. If you meant the bare-plaintext kind-4 DM
> exception in `CLAUDE.md`, say so and §7 changes.

---

## 1. Intent

### 1.1 The defect (verified; already documented as accepted risk in ADR-006)

Group application messages are attributed to a **self-declared, forgeable
field**, and the receive path never learns who actually sent the message.

- Inner rumors are unsigned (`ChatStoreContext.tsx` `buildChatRumor`,
  `MarmotContext.tsx` `buildRumor`) — as the Marmot spec requires.
- The dispatcher's listener is handed **only bytes**; the MLS-authenticated
  sender is discarded by the library before the app sees it
  (`applicationRumorDispatcher.ts:44`; ts-mls `processMessages.d.ts:14-19`).
- Handlers attribute to the raw claimed field — chat:
  `senderPubkey: rumor.pubkey` (`chatHandler.ts:86`).
- **Worst case — forced removal:** `leaveHandler.ts:26` actions
  `enqueueLeave(groupId, payload.pubkey)` on a `pubkey` read from the message
  **body**, so a member can announce *another member's* departure and the admin
  auto-commit evicts them (`MarmotContext.tsx:712-773`).

The Marmot spec already requires the fix (`group-messaging.md:43`: *receivers
validate the inner app event pubkey matches the MLS-authenticated identity*);
ADR-006 accepted the gap only because the library dropped the sender. We now
control the fork, so we implement the check (ADR-012).

### 1.2 Outcome (behaviour)

- A message shown as authored by X was provably sent by X (backbone), and a
  system action attributed to X was provably consented to by X (meta-event
  signature).
- A forged textual message (claimed author ≠ real sender) is **dropped**, not
  displayed under the victim's name.
- A forged system action (leave/admission/etc. for someone who did not sign it)
  **has no effect** and is not shown as that person's action.
- Legacy/unsigned messages still render and are correctly attributed (§7) — no
  data disappears, no hard errors.
- System messages remain **forwardable** on behalf of an offline member.

### 1.3 Non-goals

- **Deniability** (ADR-012 §1).
- No change to MLS membership semantics or the MIP-03 **encryption** envelope.
- Not hiding *that a member is in the group* — this is authorship/authorization,
  not membership privacy.

---

## 2. Architecture (decided — ADR-012)

Two layers, each owning what only it can do correctly.

### 2.1 Backbone — MLS sender binding, in the fork

Implements `group-messaging.md:43`. Covers **all kinds, all clients, all legacy
history**, with **zero wire-format change** and no per-message signature.

- **ts-mls fork:** add the authenticated sender leaf to the `applicationMessage`
  result, resolved **inside the unprotect path against the epoch-correct ratchet
  tree**. The value is already computed for proposals
  (`processMessages.js:91`, `getSenderLeafNodeIndex(result.content.content.sender)`,
  already imported at `:14`); the two application-message returns (`:48`, `:67`)
  need the identical line. **Correctness requirement:** the historical-epoch
  branch (`:38`, `receiverData.ratchetTree`) must resolve against *that* tree —
  resolving against the current `state.ratchetTree` at the emit site
  misattributes late-arriving old-epoch messages after membership churn (leaf
  indices are reused after removals).
- **marmot-ts fork:** map leaf credential → Nostr pubkey
  (`getCredentialFromLeafIndex` + `getCredentialPubkey`, already used for commits
  at `marmot-group.js:45-53`); **enforce `rumor.pubkey === senderPubkey`
  immediately after decryption — before `history.saveMessage`, before the
  generator `yield`, and before the emit** (the current order at
  `marmot-group.js:828-841` saves and yields *before* emitting, so gating only the
  emit persists forged bytes to history and delivers them to `ingest()` consumers);
  on mismatch **drop** (no save/yield/emit) and emit a diagnostic event
  (e.g. `unauthenticatedMessage`); change the `applicationMessage` payload to
  `{ rumor bytes, senderPubkey, senderLeafIndex }` (fork-major — the Few app is
  the only consumer). Define behaviour for bytes that fail
  `deserializeApplicationData` (needed to read `pubkey`): drop as malformed.

The app dispatcher therefore receives an **already-authenticated** sender; a
future handler cannot forget to verify (the choke point is structural, in the
library, not by app convention).

### 2.1a Dependencies & sequencing (a blocker for completeness, not an external one)

The fork backbone (§2.1) is a **hard prerequisite for feature completeness**: it
closes impersonation for chat/reactions/edits/polls and all legacy traffic, and
the forced-removal fix stands on the authenticated sender it surfaces. The app
attribution changes and the enum meta-event layer (§2.2) are built **on top of**
it — they do not substitute for it.

Crucially, this is a **sequencing** blocker, not an external one: we own **both**
the marmot-ts/ts-mls fork and the app, so the entire critical path is in-house.
Nothing gates us from starting or finishing it. The upstream PR
(`proposals/PROPOSAL-marmot-ts-authenticated-sender.md`) is offered to the
maintainers but is **non-blocking** — we ship the change in our fork regardless;
an upstream merge only shrinks the fork delta later.

Recommended order: **(1)** land the fork backbone — that alone is mechanism B,
which closes the core impersonation hole and is ADR-006's own planned endgame;
**(2)** app attribution via the authenticated sender + `subject === sender` for
leave (completes the forced-removal fix); **(3)** the enum meta-event layer and
any per-kind forwarding producers.

### 2.2 System messages — enum authorization, with a forwarding layer where needed

System (non-textual) messages become **enum-typed structured payloads** (not
free-form content). Authorization rides the **backbone**; the forced-removal fix
needs no per-message signature.

- **Actor = the authenticated backbone sender.** Per-type rules:
  - **Self-claim** (leave): require `subject === sender`. This alone closes
    forced removal — you can only announce your own departure.
  - **Admin action** (member-admitted, invite-lifecycle, invite-cancelled,
    group-renamed, poll-close): require the actor hold the admin/creator role, and
    treat the announcement as **display-only** — the authoritative fact is the MLS
    commit / group-metadata change, never the announcement (see §3, §8.3 for the
    render-time roster rule that replaces the unimplementable "roster-delta
    cross-check").
  - **Actor-only** (call notice): actor = sender; no subject.

- **Forwarding layer (only for kinds that need it — profiles today).** A
  forwardable meta-event carries an **inner signed Nostr event**; a relayer
  authors a *fresh outer rumor as themselves* (passes the backbone) wrapping the
  original author's signed inner event, and receivers attribute to the inner
  signer. The enum format keeps every meta-event forwarding-*capable*; a
  forwarding *producer* + inner signature is added **per kind, as a real
  forwarding flow is built**, not speculatively. Kinds nothing forwards (leave,
  polls, call notice) stay on the backbone with **no signing burden and no replay
  surface**. **Profiles are the archetype** and stay context-free (identity-
  scoped, reused across groups and the gift-wrap DM channel).

- **Replay-hardening for forwardable inner envelopes** (verified at §5):
  - **Everything authorization-relevant is inside the signed inner event** — the
    enum type, subject, group tag, freshness — the outer wrapper is untrusted
    routing only (else a signed context-free event, e.g. a profile, can be
    re-wrapped under a different enum type).
  - **Distinct inner event kind per meta type**; the profile "context-free" (no
    group tag) exception keys on the **inner kind**, never on tag-absence.
  - **Group-bound** (group tag checked against the receiving group) for
    group-scoped kinds; **profiles are the deliberate exception**.
  - **Bounded against replay-after-rejoin:** for any group-scoped forwardable kind
    whose replay has a side effect, the inner event binds an **epoch /
    join-generation** (checked ≥ the actor's current join generation) or a tight
    signed `created_at` window — a plain group tag + nonce is insufficient because
    a bounded/expiring consumed-set re-admits the old envelope once its entry ages
    out (§8.2).
  - **One-shot consumption keys on the inner event id**, not the outer rumor id
    (a forwarded envelope arrives under a fresh outer id; the dispatcher's seen-id
    LRU dedupes outer ids only).
  - **Actor ∈ roster:** the inner signer must be a current member (or the
    epoch-relevant member for a late message); admin-rule kinds get this for free
    (non-members aren't admins), actor-only kinds do not.

---

## 3. Message coverage

**Selection criterion (state once, derive the table from it):** a kind gets an
**inner-signed forwarding envelope only if it has a real on-behalf forwarding
flow.** Everything else — textual *and* non-forwarded system messages — is
authorized by the **backbone** (sender binding) plus a per-type actor rule. Today
the only forwarded kind is **profile**.

| Kind | Class | Authorized by |
|---|---|---|
| Chat (9) | textual | Backbone (sender == claimed) |
| Reaction (7) | textual | Backbone |
| Edit / delete | textual | Backbone **and** target-sender match (§6) |
| Poll open / vote | textual | Backbone |
| Poll close | system, not forwarded | Backbone + creator/admin role; recompute tally on receipt |
| Leave (13) | system, not forwarded | Backbone; `subject === sender` (closes forced removal) |
| Member-admitted / invite-lifecycle | system, not forwarded | Backbone + admin role; **display-only**, MLS commit is authority (§8.3 render-time roster rule) |
| Invite-cancelled | system, not forwarded | Backbone + admin role; display-only |
| Call notice | system, not forwarded | Backbone; actor = sender |
| Group-renamed | system, not forwarded | Backbone + admin role; **display-only — the group-metadata commit is the authority, never the notice** |
| Profile (0) | system, **forwarded** | Inner signed kind-0 (existing envelope); context-free (no group tag) |
| Profile-request (30) | system, not forwarded | Backbone (a forged request triggers the target's auto-reply — `MarmotContext.tsx:823` `sendSelfProfile`; bind to sender). Any pubkey field *inside* the request payload is the same content-claim class — bind to sender, low harm (worst case: mis-recorded request bookkeeping). |

**Leave and admission are explicitly in scope.** Forced removal (forged leave)
and forged admission are the highest-severity cases and are closed by the
backbone + actor rule, not by textual attribution alone — and, since neither is
forwarded, **without** an inner signature (so neither carries the rejoin-replay
surface of §2.2).

---

## 4. Send path

1. **Textual and non-forwarded system kinds (chat, reactions, polls, leave,
   admission/lifecycle, invite-cancel, call notice, rename):** unchanged on the
   wire — 6-field unsigned MIP-03 rumors with `pubkey` = the sender's own key,
   with enum-typed structured content for the system kinds. The backbone
   authenticates them. **No new signer dependency, no per-message signature.**
2. **Forwarded kinds (profiles today):** the actor signs an inner Nostr event
   (via NIP-07/NDK) carrying the enum type, subject, group tag where applicable,
   and a freshness/epoch binding; the outer rumor wraps it and is sent by the
   actor, or — when forwarding — by a relayer authoring a fresh outer rumor as
   themselves. The relayer never re-signs the inner event.

> **Background-signing note:** the forwarded kinds include non-interactive sends
> (relay-on-behalf profile responses — `MarmotContext.tsx:1597`). Signing these
> needs the signer available in the background. Define behaviour when a signature
> cannot be produced (queue-and-retry, or fail the *forwarded meta-event* with a
> clear error — never emit an unsigned forwardable envelope that would then be
> attributed). The accepted/declined lifecycle announcements
> (`MarmotContext.tsx:1200/1555`) are **not** forwarded, so they ride the backbone
> and add no signing burden.

---

## 5. Receive path — verify once, at the choke point

1. **Dispatcher (`applicationRumorDispatcher.ts`)** consumes the authenticated
   `senderPubkey` from the backbone (the `applicationMessage` payload is now an
   object, not bytes). It threads `senderPubkey` into `DispatcherContext`.
   Mismatches are already dropped in the fork; for **forwardable** kinds the
   dispatcher additionally runs the **inner-envelope verifier once, before
   fan-out** (generalizing `parseProfilePayload`), applying the full §2.2
   hardening set: valid inner signature; correct **inner event kind** for the
   claimed enum type; group tag == `ctx.groupId` (except the context-free profile
   kind); epoch/join-generation + freshness bound; one-shot consumption keyed on
   the **inner event id**; **actor ∈ current (or epoch-relevant) roster**; and all
   authorization-relevant fields taken from the *signed inner* event, never the
   outer wrapper. Resolve the **actor** = verified inner signer.
2. **Handlers** attribute to the authenticated sender (textual) or the verified
   actor (meta-events); no handler reads raw `rumor.pubkey` **for attribution or
   authorization**. (Non-attribution reads may remain — e.g. the own-send guard
   at `chatHandler.ts:108` and any transport-vs-actor gate — but must be scoped
   as such.)
3. This is the convergence the requester asked for: the bespoke profile
   `signedEvent` check becomes one instance of the shared envelope verifier; all
   system kinds run the same path.

---

## 6. Edit / delete authorization

Edit/delete already key off the original author
(`resolvePendingSignalsForSlot(..., originalAuthorPubkeyHex)`,
`chatHandler.ts:48/99`; the authorization itself lives in
`messageEdits/api.ts#applyDeleteEditSignal`, and `deleteEditHandler.ts:41-55`
already documents this exact trust model and cites
`BACKLOG.json#marmot-ts-0-5-1-drops` + the AC-AUTH-2 amendment). Under the
backbone that reasoning becomes real: an edit/delete is honoured only when its
**authenticated sender** equals the **authenticated sender** of the target
message. This closes forged deletion/editing of another member's message. The
spec must state edit/delete authorization keys off the authenticated sender, not
the claimed field.

---

## 7. Backwards compatibility (unsigned / legacy / non-Few)

The backbone makes this clean — **no downgrade window**, because binding is on the
transport sender and needs no signature in the message:

- **Any rumor (signed or not) with `pubkey === authenticated sender`** →
  attributed to that sender. This covers **legacy-format messages ingested after
  the upgrade** — legacy Few messages (every legacy send sets `pubkey` to the
  sender's own key — verified across `buildChatRumor`, `buildRumor`, and all
  announcement/relay sites) and **other Marmot clients** (which likewise set their
  own pubkey). They render and attribute correctly, untouched. (Rows already
  persisted under forged attribution *before* the fork ships are not retroactively
  re-checked — MLS forward secrecy means persisted rows are never re-decrypted;
  acceptable, and stated so.)
- **Any rumor with `pubkey !== authenticated sender`** → **dropped** as a forgery.
  The only class that stops rendering, and exactly the attack.
- **Legacy system messages without an inner signature — split by claim class**
  (a single subject==sender rule is wrong: legacy admission announcements have
  subject ≠ sender *by design* — the admin announces the joiner):
  - **Self-claim types** (leave): require `subject === sender`. Matches every
    legitimate legacy case and keeps the eviction hole closed.
  - **Third-party-subject types** (member-admitted, invite-lifecycle, cancel):
    render with **actor = authenticated sender**, and display the subject as an
    **unverified claim**. Safe because these are display-only (nothing actions
    them); enforcing subject==sender here would instead make all legitimate legacy
    admission announcements disappear (violating §1.2).
- **The `pubkey: ''` case is a live-send edge, not a history edge.** Persisted
  rows are never re-processed (previous bullet), so `pubkey: ''` rumors cannot hit
  the equality check from history. The only live source is an in-flight send from
  a not-yet-hydrated client (`pubkeyHex ?? ''`, `MarmotContext.tsx:1205`); those
  should **drop as malformed** — do **not** add an empty-pubkey tolerance carve-out
  to the fork (an attacker-usable bypass).

**No flag day, no re-signing of history.** Old and new coexist; the backbone
authenticates both.

---

## 8. Open decisions for the spec author

1. **`group-messaging.md:43` normative strength.** Confirm MUST vs SHOULD against
   the upstream spec; it determines whether the fork's mismatch handling is
   unconditional drop or drop-by-default-configurable (ADR-012 Evolution Trigger).
2. **Forwardable-envelope freshness/replay mechanism.** The scenario any chosen
   mechanism **must defeat** is **replay-after-rejoin**: an actor's genuine signed
   envelope, re-forwarded after they leave and rejoin the group, must not
   re-execute. A bounded/expiring consumed-set alone fails this (the entry ages
   out), and the in-repo LRU precedent (`applicationRumorDispatcher.ts:49`, cap
   1000, in-memory) fails it too. Decide the binding: epoch / join-generation
   inside the signed inner event checked ≥ the actor's current join generation, or
   a tight signed `created_at` window that bounds the consumed-set lifetime — plus
   one-shot keyed on the inner event id. (Moot for leave/admission, which are not
   forwarded and carry no inner signature; relevant when a forwarding producer is
   built for a group-scoped kind.)
3. **Third-party-subject rendering rule (replaces "roster-delta cross-check").**
   Announcements and MLS commits arrive on independent, unordered paths, so an
   announcement cannot be checked against a per-event membership delta. Decide the
   implementable rule instead: e.g. an admission/lifecycle announcement renders
   only for a subject present in the **current roster at render time**,
   re-evaluated on `groupDataVersion` bumps — and never causes a membership change
   itself. Enumerate per type: which require admin actor, which are purely
   display-only.
4. **Background meta-event signing under NIP-07** (from §4): queue-and-retry vs
   fail-closed vs a documented degradation for locked/absent extensions.
5. **Diagnostic surfacing.** What (if anything) the app shows/logs when the fork
   drops an `unauthenticatedMessage` — silent, dev-log, or a visible indicator.
6. **Fork-major rollout.** The `applicationMessage` payload shape change is
   breaking; confirm the app is migrated atomically with the fork bump.
7. **Mixed-fleet forward compatibility (rollout).** While the fleet is
   half-upgraded, an old deployed Few client receiving a **new** enum meta-event
   shape falls through `parseStructured` (returns `null`) and renders the content
   as a plain-text chat row full of JSON (announcements are literal `ChatMessage`
   rows — `sendAnnouncement` → `appendMessage`, `MarmotContext.tsx:1557/1206`).
   Decide: choose new wire shapes that deployed builds still parse acceptably, or
   explicitly accept the transient ugly-render until clients reload. This is a
   product-visible rollout tradeoff, not an internal detail.

---

## 9. Library vs. application split (explicit, per the brief)

| Concern | Layer | Why |
|---|---|---|
| Surface the authenticated MLS sender (epoch-correct) | **ts-mls fork** | Only the unprotect path holds the sender and the correct tree; the app cannot resolve it correctly (§2.1). |
| Enforce `rumor.pubkey === senderPubkey`, drop on mismatch | **marmot-ts fork** | It is spec text (`group-messaging.md:43`), not app policy; enforcing at ingest makes the guarantee structural for every consumer. |
| Sign / verify meta-event inner envelopes | **App** | Signing needs the user's signer (custody stays app-side); enum types, actor rules, group-binding, and freshness are app-defined payload semantics. A pure `verifyAuthorEnvelope` helper *may* live in the fork for reuse, but ownership is the app. |
| Attribution, drop/flag UX, freshness policy | **App** | Trust and presentation are product decisions. |
| Standardising an optional inner-signature field across clients | **MIP amendment** (optional) | Ecosystem convergence, not a shipping dependency (proposal §6). |

**Net:** the sender-binding backbone is a **fork** responsibility (spec
conformance we implement in our controlled fork and upstream); the meta-event
signature envelope and all UX are **application**-bound. Hence two documents.

---

## 10. Acceptance criteria (seed set for `/base:feature`)

Drive everything through the app per the e2e rule (a second signed-in context as
the attacker; no raw WebSocket) **except AC-9, which is fork-level** (see below).
Forging requires a **dev-only app-internal seam** that drives the app's own MLS
send stack with a crafted rumor — precedent: the dev-only hook at
`MarmotContext.tsx:777-780`. Name that seam in the spec.

- **AC-1 (backbone, textual):** A member sending a chat/reaction/poll rumor with
  `pubkey` set to another member's key results in the message being **dropped**
  (a diagnostic emitted), never attributed to the claimed member, on every other
  client.
- **AC-2 (backbone, legacy pass-through):** An unsigned rumor with `pubkey` == the
  real sender renders and attributes correctly (legacy Few + other-client
  compatibility); nothing is dropped for lacking a signature.
- **AC-3 (forced-removal closed):** A member sending a leave meta-event whose
  subject is another member does **not** cause that member's removal and is not
  shown as their departure.
- **AC-4 (forwarding — scoped to kinds with a real forwarding producer):** A
  relayer forwarding another member's signed **profile** envelope (the only
  forwarded kind today) results in the profile attributed to the **original
  actor**, accepted idempotently, in the correct scope. (Leave/admission are not
  forwarded — no AC claims a forwarding flow for them; if a future kind gains a
  forwarding producer, extend this AC to it.)
- **AC-5 (cross-group replay closed):** A genuine signed forwardable envelope from
  group G1, replayed into group G2, is rejected (group-binding). Include the
  **replay-after-rejoin** variant for any group-scoped forwardable kind: the same
  envelope re-forwarded after the actor rejoins is rejected (epoch/join-generation
  bound), and one-shot consumption keys on the inner event id so a self-copy +
  forwarded-copy of the same envelope executes once.
- **AC-6 (uniform verification):** Chat, reaction, edit/delete, poll, leave,
  admission, profile all attribute/authorize via the backbone sender or the shared
  meta-event verifier; no handler reads raw `rumor.pubkey` **for attribution or
  authorization**.
- **AC-7 (edit/delete authorization):** An edit/delete whose authenticated sender
  ≠ the target message's authenticated sender is rejected.
- **AC-8 (profile-request bind):** A forged profile-request (`pubkey` = a member
  who did not send it) does not trigger that member's auto-reply.
- **AC-9 (epoch-correct attribution — FORK-LEVEL, exempt from the app-driving
  rule):** A late-arriving old-epoch application message, received after a
  membership removal that reused a leaf index, is attributed to the correct
  original sender, not the current holder of that leaf. Manufacturing this arrival
  inversion through the app is impractical (relays deliver in stored order); this
  is a **fork unit/integration test** crafting epochs directly against
  `processMessage`, not an app e2e.
- **AC-10 (meta-event send fails closed):** If a meta-event inner signature cannot
  be produced, the meta-event is not emitted/actioned; a clear error surfaces.
- **AC-11 (full e2e gate):** `make test-e2e-all` (60 tests) green — the definitive
  gate per `CLAUDE.md`; a green subset is not a pass.

---

## 11. Files likely in scope (orientation, not prescription)

- **Fork:** `ts-mls` unprotect/`processMessages` (surface sender leaf, both
  application-message returns incl. the historical-epoch branch); marmot-ts
  `marmot-group.js` (credential→pubkey, enforce equality, change emit payload).
- **App dispatcher:** `applicationRumorDispatcher.ts` (consume authenticated
  sender; run the shared meta-event verifier before fan-out). NB the dispatcher
  is now the **single** `applicationMessage` listener — the dual-listener
  consolidation has landed; `MarmotContext.tsx`'s other subscription is relay
  ingest, not a rumor-attribution path.
- **Handlers:** `handlers/chatHandler.ts`, `reactionHandler`, `deleteEditHandler`,
  `pollHandler`, `leaveHandler`, `profileHandler`, lifecycle/announcement
  handlers — attribute via authenticated sender / verified actor.
- **Payload / authorization:** `leaveSync.ts`, `parseStructured.ts` (enum
  meta-event shapes + actor rules — where forced-removal authorization lands),
  `messageEdits/api.ts` (edit/delete authorization), `profileSync.ts`
  (`parseProfilePayload` → one caller of the shared verifier).
- **Hidden coupling (biggest work item):** system messages today live *inside* the
  kind-9 chat store — announcements are literal `ChatMessage` rows
  (`sendAnnouncement` → `appendMessage`) and interact with unread counts,
  edit/delete routing (`hasEditMarkerTag`), and persistence. Introducing
  enum-typed system messages — whether as new kinds or new-shaped kind-9 carriers
  — touches chat persistence and the notification-domain invariants, not just the
  parser. Scope this explicitly; it is easy to under-estimate from the parser
  surface alone.
