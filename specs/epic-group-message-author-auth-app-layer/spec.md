---
arch_debate: false
constrained_by_adrs: [ADR-012, ADR-006, ADR-003]
mutation_gate: skip
mutation_gate_reason: "Large multi-module security epic (~18-20 touched production modules); test quality evidenced by adversarial Opus+Fable per-story review to fixpoint, examiner verification (all AC questions YES), and 7 real-producer order-sensitivity property tests. Product-owner-authorized skip 2026-07-24."
---

# Group Message Author Authentication — App Layer

> **Status**: pre-implementation (authored 2026-07-23 from
> `specs/group-message-author-authentication-spec-request.md`; revised 2026-07-23
> after a Fable spec review — see `## Amendments`).
> **Scope decision (2026-07-23, product owner):** this epic implements the
> **application layer only**. The MLS sender-binding **backbone** (the
> marmot-ts / ts-mls fork) is **out of scope** and tracked separately. See
> `## Non-Goals`.

## Problem

Group application messages are attributed to a **self-declared, forgeable field**
(`rumor.pubkey`). Any current group member can set it to another member's key and
make a chat message, reaction, edit/delete, poll action, or system announcement
appear to come from — or act on behalf of — another member. The highest-severity
instance is **forced removal**: `leaveHandler.ts:27` actions
`enqueueLeave(ctx.groupId, payload.pubkey)` on a pubkey read from the message
*body*, so a member can announce *another member's* departure and the admin's
auto-commit evicts them.

ADR-006 accepted this as interim risk because the correct fix — the check the
Marmot spec already mandates (`group-messaging.md:43`) — was unimplementable: the
library dropped the MLS-authenticated sender. **ADR-012 supersedes ADR-006** and
decides the architecture: a sender-binding *backbone* in the fork, plus signed
enum meta-events for forwardable system messages.

**Why an app-layer-only epic, and what it does *not* deliver.** The backbone is
the part that surfaces the *true* sender and can therefore *detect* a forgery.
The application cannot compute the authenticated sender on its own — it receives
only decrypted bytes. **Consequently this epic does not, by itself, stop any
forgery, and does not close forced removal.** With the backbone out of scope the
seam is fed the *claimed* pubkey, so an attacker controls both the "who sent
this" value and the payload — every check reduces to comparing attacker-chosen
fields and passes. What this epic delivers is *readiness*: every attribution and
authorization decision reads from a single **authenticated-sender seam** instead
of raw `rumor.pubkey`, the enum meta-event actor rules and shared envelope
verifier land, and the forced-removal / edit-delete / poll-close / profile-request
rules are written against that seam. When the backbone later feeds the seam the
real sender (and drops mismatches at the library choke point), those rules become
load-bearing and impersonation closes with **no change to the handler layer**.
Until then, forgery still succeeds end-to-end — a known, accepted limitation of
scoping the backbone out (see `## Non-Goals` and `## Manual Validation`). **The
project's impersonation security finding stays OPEN until the backbone epic
ships; this epic must not be recorded as resolving it.**

## Solution

Introduce an **authenticated-sender seam** at the single dispatcher choke point
and route all trust decisions through it.

1. **Seam (per-message).** The dispatcher resolves, **for each rumor**, an
   authenticated-sender payload `{ senderPubkey, senderAuthenticity }` and passes
   it alongside the rumor to handlers. `senderPubkey` is resolved by an app-side
   function that today returns `rumor.pubkey` (identity/no-op) and is
   **overridable by a dev-only test hook** so tests can inject a divergent sender.
   `senderAuthenticity` is a `'claimed' | 'mls'` marker — **always `'claimed'`
   under the stub**, flipped to `'mls'` when the backbone feeds a real sender.
   The marker is the observable, self-documenting signal that prevents the
   stubbed value from silently reading as authenticated, and gives the diagnostic
   (and any future UI indicator) a hook.
   - **Per-message, not per-subscription.** `DispatcherContext` is created once
     per group at `subscribe()` time; the authenticated sender varies per message.
     The sender payload is therefore a **sibling argument to the rumor**, not a
     field mutated on the shared context.
2. **Choke-point drop.** Before fan-out, if `rumor.pubkey !== senderPubkey`, the
   message is **dropped** (no handler runs) and a diagnostic is emitted. Today
   this never fires (stub returns `rumor.pubkey`); the dev hook and the future
   backbone make it fire. This drop — not the handler refactor — is the only
   *enforcement* point; the handler refactor is **defense-in-depth** that ensures
   no handler *would* trust the wrong field once the two values can diverge.
3. **Attribution refactor.** Every handler attributes/authorizes on the seam's
   `senderPubkey`, never on raw `rumor.pubkey`. Non-attribution reads (e.g. the
   own-send guard) may remain but must be scoped and commented as such. The
   existing trust-model comments (e.g. `deleteEditHandler.ts`'s "do NOT overstate
   this as MLS-authenticated") **must survive** the refactor until the backbone.
4. **Per-type actor rules for system (enum) messages.** Enumerated per type — no
   blanket rule:

   | Type | Actor rule | Rendering / effect |
   |---|---|---|
   | `leave_intent` | `subject === sender` | enqueue leave only for self-departure |
   | `poll_close` | actor == **poll creator** (not admin) | display-only; **recompute the tally on receipt** — never trust the closer's claimed `results`/`totalVoters` |
   | `member_admitted` / `invite_lifecycle('accepted')` | actor holds admin/creator role | display-only; roster-gated **at ingest** (see below); MLS commit is authority |
   | `invite_lifecycle('invited'/'declined')`, `invite_cancelled` | actor holds admin/creator role | display-only; **not** roster-gated (subject is not a member by design); subject shown as an unverified claim |
   | `group_renamed` | actor holds admin/creator role | display-only; the metadata commit is authority |
   | `call_notice` | actor = sender | actor-only |

   - **Roster gating is at ingest, never retroactive.** For the two types that
     name a subject who *should* be a member (`member_admitted`, `accepted`),
     acceptance is decided when the announcement is first observed (subject in the
     current roster, allowing for the commit-race window) and **persisted as a
     flag**. It is never re-evaluated on later `groupDataVersion` bumps — doing so
     would make a legitimate "X was admitted" row vanish from history when X later
     leaves.
5. **Rejected announcements leave no trace.** Announcements are literal kind-9
   `ChatMessage` rows (`sendAnnouncement` → `appendMessage`), so a forged/rejected
   announcement must be dropped **at ingest** (before `appendMessage` and the
   unread increment), not merely suppressed at render — otherwise it persists
   forever and inflates the unread badge with a "ghost" unread that shows nothing.
6. **Shared envelope verifier for forwarded kinds.** Generalize
   `parseProfilePayload` into one verifier that runs once, before fan-out, for
   forwardable kinds. Today the only forwarded kind is **profile** (context-free,
   no group tag). The verifier applies the hardening set that is *applicable now*
   (valid inner signature; correct inner event kind; group-binding for
   group-scoped kinds; one-shot consumption keyed on the **inner event id**; all
   authorization-relevant fields taken from the signed inner event). Two explicit
   scoping calls:
   - **Profiles are exempt from the actor-∈-roster check.** They are context-free
     and identity-scoped; roster-gating them would reject a departed member's
     late-arriving profile and degrade their name in history to a raw key.
   - **Epoch / join-generation replay-after-rejoin binding is deferred** — no
     group-scoped forwarding *producer* exists today (profile is context-free and
     idempotent), so there is nothing to replay with a side effect. The verifier's
     interface must accept a **per-kind binding policy** so adding the epoch check
     later is additive.
7. **Edit/delete authorization** honours an edit/delete only when its
   authenticated sender equals the target message's authenticated sender.
8. **Profile-request bind.** A profile-request rumor whose `pubkey` diverges from
   the seam sender is dropped at the choke point before the auto-reply handler
   runs (the auto-reply is target-driven, so this is the seam drop applied to
   kind 30 — no separate handler logic).
9. **Meta-event send fails closed.** If a forwardable inner signature cannot be
   produced (locked/absent NIP-07), the meta-event is not emitted/actioned — never
   emit an unsigned forwardable envelope. Error surfacing is **per path**:
   interactive send → visible error; background/relay send → dev-log and rely on
   the existing profile-request retry machinery.

## Scope

### In Scope
- Per-message authenticated-sender seam (`{ senderPubkey, senderAuthenticity }`)
  in `applicationRumorDispatcher.ts`; app-side resolver defaulting to
  `rumor.pubkey` with `'claimed'`; dev-only override hook; pre-fan-out mismatch
  drop + diagnostic.
- Refactor all rumor handlers to attribute/authorize on the seam sender (AC-6),
  preserving scoped non-attribution reads and the existing trust-model comments.
- **Second-hop propagation.** Thread the authenticated sender into
  `reactions/api.ts` (`applyInboundRumor`) and `messageEdits/api.ts`
  (`applyDeleteEditSignal`) — the modules where reaction attribution/removal and
  the admin-gated-delete / own-author-edit *authorization* actually happen. A seam
  that stopped at the handler boundary would leave these on the forgeable field
  and make AC-6 cosmetic. The `chatPersistence.ts` tombstone re-check (third hop)
  inherits the authenticated value from `messageEdits/api.ts`.
- A static enforcement rule (a vitest source-scan, per the repo's
  `zodBoundary.test.ts` precedent — there is no ESLint) banning `rumor.pubkey`
  reads inside `handlers/` except an explicit allow-list; plus targeted assertions
  that the two second-hop modules authorize on the passed authenticated sender.
- Forced-removal *rule*: `leaveHandler` requires `subject === sender` (readiness).
- Edit/delete authorization keyed off authenticated sender.
- Per-type actor rules incl. **poll-close = creator + tally-recompute on
  receipt** (recompute always from stored votes; the closer's claimed
  `results`/`totalVoters` are ignored), **poll-open binds `creatorPubkey` to the
  authenticated opener**, **`call_notice` actor = sender** (stop rendering
  `initiator` from the payload), and ingest-time (non-retroactive) roster gating
  for admission-type announcements. Admin/roster facts come from the existing
  injected `GroupAdminsProvider` + live MLS roster read, reactive on
  `groupDataVersion`.
- Ingest-time drop of rejected announcements (no ghost unread / no persistence).
- Shared inner-envelope verifier generalizing `parseProfilePayload`, with a
  per-kind binding policy, one-shot on inner event id, profiles roster-exempt.
- Meta-event send fails-closed with per-path error surfacing.
- Full e2e suite (`make test-e2e-all`, 60 tests) stays green.

### Out of Scope
- **The MLS sender-binding backbone (the fork).** All ts-mls / marmot-ts changes:
  surfacing the authenticated sender leaf, epoch-correct tree resolution, the
  `rumor.pubkey === senderPubkey` enforcement *inside the library*, and the
  breaking `applicationMessage` payload change. Tracked as a separate backbone
  epic. Until it lands the seam is fed the claimed pubkey and no forgery is
  actually stopped.
- **Real forgery drop / real forced-removal closure** — requires the backbone.
- **AC-9 (epoch-correct fork attribution)** — fork unit/integration test.
- **Epoch/join-generation replay binding** — deferred (no producer needs it).
- **`joinRequestHandler` (kind 21059)** — rides a *different* pre-membership
  transport (gift-wrapped join requests, not the MLS application-message bus), so
  it is not reachable through the dispatcher/seam. Same trust question, different
  wiring — a separate follow-up, not silently assumed covered here.
- **Commit-time re-verification of the leave auto-commit** (`fireAutoCommit`) —
  the readiness rule is enforced at `enqueueLeave` (subject === sender); adding a
  second check at MLS-commit time is a belt-and-suspenders follow-up, not this
  epic.
- Deniability (ADR-012 §1). MLS membership semantics / MIP-03 encryption envelope.

## Design Decisions

- **Seam default = `rumor.pubkey` + `senderAuthenticity: 'claimed'`, dev-override
  for tests.** The only honest way to exercise drop/attribution logic app-layer
  without the backbone; it is the exact interface the fork will feed. The
  `'claimed' | 'mls'` marker keeps the stub from masquerading as authenticated.
- **The resolver and dev hook are deliberate throwaway scaffolding.** When the
  backbone lands it changes the `applicationMessage` payload to
  `{ rumor, senderPubkey, senderLeafIndex }` (fork-major). That migration deletes
  the app's `deserializeApplicationData` call, the malformed-drop branch, the
  resolver, and the dev hook — this is *dispatcher-entry* rework and is expected.
  The value that survives untouched is **the handler layer reading the seam**;
  "no further change" is scoped to the handlers, not the whole app.
- **Poll-close authorizes on the creator, not an admin.** Verified in code: any
  member may create and close their own poll (`pollHandler.handleClose` checks
  `creatorPubkey`; creation is not admin-gated). A blanket admin rule would reject
  legitimate closes — a regression *within existing wire shapes*. Every actor rule
  must pass a "does any current legitimate producer violate this?" check.
- **Tally-recompute on poll-close** closes a real app-layer forgery (a creator
  faking final counts); no fork dependency, so it is in scope.
- **Roster gating at ingest, never retroactive; enumerated per type** — see
  Solution §4. Prevents both the invitation-announcement regression and history
  mutation.
- **Diagnostic surfacing = dev-log, no visible production indicator** — for now
  the drop cannot fire in production (stub). Trap to inherit into the backbone
  epic: once the backbone lands, the app-layer drop *can* fire as double
  enforcement, so dev-log-only would then be silent message loss — revisit the
  indicator with the backbone.
- **Background NIP-07 signing = fail-closed**, per-path surfacing (Solution §9).
- **No new deployed-client-visible wire shapes.** The enum shapes already exist in
  `parseStructured`; this epic adds *actor rules*, not shapes. The mixed-fleet
  risk is therefore **not** parse-failure ugly-render — it is new receivers
  applying stricter authorization to messages current senders legitimately
  produce; each actor rule is checked against that (poll-close is the example).

## Technical Approach

Grounded in current code (verified 2026-07-23):

- **`applicationRumorDispatcher.ts`** — single `applicationMessage` listener;
  `DispatcherContext = { groupId, selfPubkeyHex, getActiveGroupId }`; handler
  signature `handle(rumor, ctx)`; flow deserialize → seen-LRU dedup → fan-out.
  Add the per-message sender payload as a sibling arg + the pre-fan-out equality
  drop + diagnostic. Handler signature becomes `handle(rumor, sender, ctx)` (or
  the sender folded into a per-call object) — **not** a field on the shared ctx.
- **`parseStructured.ts`** — already emits `StructuredContent` and already
  documents (`resolveCancellerDisplay`, AC-STRUCT-5 comment) that the *author*
  comes from `senderPubkey`. Wire the actual sender through; add per-type rules.
- **`handlers/leaveHandler.ts`** — `enqueueLeave(...)` only when
  `payload.pubkey === sender`.
- **`handlers/chatHandler.ts`** — where announcements become chat rows: enforce
  the announcement actor rules **before** `appendMessage`/unread increment; keep
  the own-send guard (`chatHandler.ts:108`) as a scoped non-attribution read.
- **`handlers/pollHandler.ts`** — on open, bind `creatorPubkey` to the
  authenticated sender (ignore the payload's self-asserted value); on close,
  authorize `sender === stored creatorPubkey` and **recompute the tally from
  stored `PollVote` rows** rather than trusting the close payload's counts. (There
  is no existing recompute path — this is a green-field addition.)
- **`handlers/reactionHandler.ts` → `reactions/api.ts` (`applyInboundRumor`)** —
  attribute the reaction (and reaction *removal*) to the authenticated sender, not
  `rumor.pubkey`; thread the sender into `applyInboundRumor`'s signature.
- **`handlers/deleteEditHandler.ts` + `messageEdits/api.ts`
  (`applyDeleteEditSignal`)** — authorize on the authenticated sender of the
  signal vs the target's authenticated sender; thread the sender into
  `applyDeleteEditSignal`. Preserve the existing trust-model comment block until
  the backbone. The `chatPersistence.ts` `TombstoneAuthorization` inherits the
  value from here.
- **Admin/roster provider** — reuse the existing `GroupAdminsProvider`
  (`registerGroupAdminsProvider`/`groupAdminsFor`/`isAdminPubkey`, already
  registered in `MarmotContext.tsx` from `mlsGroup.groupData.adminPubkeys`,
  fail-closed to `[]`) for admin actor rules; add a sibling live-roster accessor
  (`getGroupMembers(mlsGroup.state)`) for the ingest-time admission roster check.
  Both are injected via handler deps (boundary rule: no context imports) and are
  reactive on `groupDataVersion`.
- **`member_admitted`** — no active production producer was found (likely
  superseded by `invite_lifecycle('accepted')`). Keep a defensive ingest actor
  rule (an attacker could still forge one) but do not build a producer.
- **`handlers/profileHandler.ts` + `profileSync.ts` (`parseProfilePayload`)** —
  becomes one caller of the shared verifier; repoint the unsigned/legacy
  `payloadToMemberProfile(rumor.pubkey, …)` fallback to the authenticated sender.
  The inner-signed (`signedEvent`) path already authenticates independently and is
  the archetype the verifier generalizes.
- **`profileRequestHandler.ts`** — auto-reply is target-driven; the only guard is
  the choke-point drop for a mismatched kind-30 rumor.
- **Hidden coupling (biggest work item, request §11).** System messages live
  *inside* the kind-9 chat store; ingest-time enforcement touches chat
  persistence, unread counts, and notification-domain invariants, not just the
  parser. Scoped explicitly in Story 5.
- **Dev-only forge seam** on the send side (crafted rumor with an attacker pubkey)
  + the receive-side sender override — together they let a second signed-in
  context drive attribution/drop tests through the app.

## Stories (sketch — the planner formalizes)

1. **Per-message authenticated-sender seam + choke-point drop** — sender payload
   `{ senderPubkey, senderAuthenticity }` threaded as a sibling arg, resolver
   (stub = `rumor.pubkey`/`'claimed'`), dev override, pre-fan-out mismatch drop +
   diagnostic. Foundation.
2. **Attribution refactor across handlers + second-hop APIs + static ban** —
   every handler reads the seam sender; thread the sender into `reactions/api.ts`
   (`applyInboundRumor`) and `messageEdits/api.ts` (`applyDeleteEditSignal`);
   vitest source-scan bans `rumor.pubkey` in `handlers/` (allow-list for scoped
   non-attribution reads) + asserts the two second-hop modules authorize on the
   passed sender; trust-model comments preserved.
3. **Forced-removal rule** — `leaveHandler` `subject === sender`.
4. **Edit/delete authorization** on authenticated sender.
5. **Enum actor rules (per-type) + ingest-time announcement enforcement** —
   poll-open binds creator to sender; poll-close creator-authorize +
   tally-recompute; `call_notice` actor = sender; ingest-time non-retroactive
   roster gating for admissions (via injected admin/roster provider); rejected
   announcements produce no row/unread/notification (enforced in `chatHandler`
   before `appendMessage`).
6. **Shared envelope verifier** — generalize `parseProfilePayload`; per-kind
   binding policy; one-shot on inner event id; profiles roster-exempt.
7. **Profile-request drop + meta-event send fails-closed** with per-path surfacing.

## Non-Goals

- **The fork backbone** — deferred (product-owner scope decision). This epic
  cannot and does not close impersonation or forced removal on its own.
- **Deniability** (ADR-012 §1).
- **Epoch/join-generation replay binding** — deferred until a group-scoped
  forwarding producer exists.
- **`group-messaging.md:43` normative-strength confirmation** and **fork-major
  rollout** — fork concerns.
- No change to MLS membership semantics or the MIP-03 encryption envelope.

## Amendments

- **2026-07-23 (Fable review):** Replaced the blanket render-time roster rule with
  per-type enumeration decided at ingest (was regressing invitation announcements
  and mutating history). Corrected poll-close authority from admin → creator and
  restored tally-recompute to scope. Softened "closes forced removal" to
  readiness-only throughout; recorded that the impersonation finding stays open
  until the backbone. Made the sender payload per-message (not on the shared
  context) and added the `senderAuthenticity` marker. Specified ingest-time drop
  of rejected announcements. Scoped profiles out of the roster check. Defined the
  attribution-refactor verification (handler unit tests + static ban) and per-path
  send-error surfacing.
- **2026-07-23 (S5 Fable Stage-2 review):** (a) Fixed a creator-binding hole
  (F2): `poll_open` had no first-open-wins guard, so any member could re-open an
  existing `pollId` to rebind `creatorPubkey` to themselves and pass close-authz —
  handleOpen now rejects a re-open of an existing poll. (b) Added vote-response
  validation (F4): a vote's responses are filtered to the poll's known options so
  a stuffed/bogus vote cannot skew the recomputed tally. (c) Routed F1 to S6: the
  kind-9 poll_close CHAT ANNOUNCEMENT still renders the closer's self-reported
  counts verbatim (any member can post a fake closed-poll bubble) — the recompute
  landed on the poll-card surface only; S6 must creator-gate that announcement and
  render the recomputed tally. (d) Recorded F3 (cross-group vote-store
  contamination via a shared global pollId key — the proper fix group-scopes the
  vote key, a persistence change beyond this epic) and F5 (a client that observes
  a close before some votes shows a PERMANENTLY understated tally — an accepted
  consequence of recompute-on-close, surfaced to the product owner).
- **2026-07-23 (S3 Fable Stage-2 review):** (a) Hardened `parseLeaveIntent`
  (leaveSync.ts) to drop empty/non-canonical subjects as malformed per
  spec-request §7 — an empty subject was passing the `subject === sender` gate
  vacuously (`'' === ''`). (b) Identified that AC-FORCE-3's "not rendered as a
  departure" clause is only satisfied for the kind-13 leave (which renders
  nothing); the kind-9 leave_intent DEPARTURE ANNOUNCEMENT ("X left the group"
  chat row) still renders from a self-reported field, ungated — folded a
  `subject === sender` ingest rule for it into S6 (see S6 story description).
- **2026-07-23 (exploration):** Extended scope to the second-hop authorization
  modules (`reactions/api.ts`, `messageEdits/api.ts`) after exploration showed the
  real reaction-attribution and delete/edit-authorization decisions live there, not
  in the handlers. Folded the pre-existing self-asserted-actor gaps (poll-open
  `creatorPubkey`, `call_notice.initiator`) into the per-type rules. Chose
  recompute-always for poll tallies. Adopted the existing `GroupAdminsProvider` for
  admin/roster facts. Noted `member_admitted` as likely legacy (defensive rule
  only). Scoped out `joinRequestHandler` (different transport) and leave-auto-commit
  re-verification as separate follow-ups.
