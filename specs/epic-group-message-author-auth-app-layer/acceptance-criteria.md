# Acceptance Criteria — Group Message Author Authentication (App Layer)

> Formalized from the seed set (`specs/group-message-author-authentication-spec-request.md`
> §10, re-scoped app-layer, revised after the 2026-07-23 Fable review) and
> reconciled against `exploration.json` and `architecture.md`. App-driven ACs use
> a second signed-in context as the attacker (no raw WebSocket, per project
> convention) plus the dev-only authenticated-sender override hook
> (`window.__fewTest`-precedent, gated `NODE_ENV !== 'production'`). Where an AC
> can only be verified below the app (handler-level unit test, verifier unit
> test, or a static source-scan), the AC names that level explicitly — none of
> those are e2e-observable substitutes, they are the correct level for what they
> assert.
>
> **Test levels used below:** `handler-unit` (calls `handle(rumor, ctx, sender)`
> or a second-hop API function directly with hand-built input + injected/mocked
> deps, per the `leaveHandler.test.ts` pattern), `verifier-unit` (calls the
> shared envelope verifier directly), `integrated-e2e` (drives the real app
> through Playwright with a second signed-in browser context and/or the dev
> override hook), `static-scan` (a vitest source-scan over file contents, per
> `zodBoundary.test.ts`).
>
> **Standing limitation (do not lose this framing):** this epic is app-layer
> only. The authenticated-sender seam is fed the *claimed* `rumor.pubkey`
> (`senderAuthenticity: 'claimed'`) until the MLS sender-binding backbone
> (ADR-012) lands. No automated AC in this document — however it is exercised —
> demonstrates a **real** forgery being stopped; app-driven "attacker" scenarios
> work by injecting a divergent sender through the dev override hook, not by
> defeating real MLS authentication. See `## Manual Validation`.

## Automated / behavioral

### Seam (SEAM)

- **AC-SEAM-1 (seam drop) — `integrated-e2e`:** With the authenticated-sender
  seam (via the dev override hook) reporting `sender.pubkey = X` and an inbound
  rumor carrying `rumor.pubkey = Y` (Y ≠ X; exercised across kinds: chat,
  reaction, poll, leave, profile-request/kind-30), the message is **dropped**
  before fan-out: a diagnostic (`unauthenticatedMessage`) is dev-logged, no
  handler runs, and the rumor id is **not** added to the dedup LRU (see
  AC-XCUT-1). *(App-layer stand-in for request AC-1, which cannot truly pass
  without the backbone.)*
- **AC-SEAM-2 (pass-through) — `integrated-e2e`:** A rumor with
  `rumor.pubkey === sender.pubkey` is handled and attributed to that sender;
  nothing is dropped for lacking a signature. Holds trivially under the stub and
  continues to hold unchanged after the backbone lands. *(Request AC-2.)*

### Attribution (ATTR)

- **AC-ATTR-6 (uniform attribution, verified below the dispatcher):**
  (a) `handler-unit` — for each rumor handler (chat, reaction, poll open/vote/close,
  leave, call_notice, group_renamed, member_admitted, invite_lifecycle,
  profile, profile-request), a handler-level unit test calls `handle()` directly
  with `sender.pubkey ≠ rumor.pubkey` and asserts the resulting
  attribution/authorization decision resolves to `sender.pubkey`, never
  `rumor.pubkey`.
  (b) `static-scan` — a vitest source-scan fails the build on any `rumor.pubkey`
  read inside `handlers/` outside an explicit, documented allow-list (scoped to
  `handlers/` only; `rumor.pubkey` reads in already-seal-authenticated paths
  such as `directMessages.ts`, `pairingAck.ts`, and gift-wrap code are out of
  scope for this scan).
  (c) `handler-unit` — targeted assertions on the two second-hop modules:
  `reactions/api.ts`'s `applyInboundRumor` attributes reaction add **and**
  remove to the passed `sender.pubkey`, never `rumor.pubkey`; `messageEdits/api.ts`'s
  `applyDeleteEditSignal` authorizes (own-author edit, admin-gated delete) on
  the passed `sender.pubkey`, never `rumor.pubkey`.
  *(Cannot be an e2e AC: the choke-point drop (AC-SEAM-1) removes every
  divergent rumor before any handler runs, so an integrated test can never
  observe a handler receiving `sender.pubkey ≠ rumor.pubkey`. Request AC-6.)*

### Forced removal (FORCE)

- **AC-FORCE-3 (forced-removal rule) — `handler-unit`:** A `leave_intent` whose
  `payload.pubkey` (the subject) ≠ `sender.pubkey` does **not** call
  `enqueueLeave` and is not rendered as a departure. *(Readiness only — under the
  stub the attacker controls both fields via the dev hook, so this rule does not
  yet stop a real forced removal; see AC-MV-1. Request AC-3.)*

### Edit / delete (EDIT)

- **AC-EDIT-7 (edit/delete authorization) — `handler-unit`:** An edit or delete
  signal whose authenticated sender (`sender.pubkey` of the signal rumor) ≠ the
  target message's stored authenticated sender is rejected by
  `applyDeleteEditSignal` — no tombstone is written and no edit is applied,
  regardless of admin status, unless the admin-delete path is separately
  satisfied via `GroupAdminsProvider`. *(Request AC-7.)*

### Poll (POLL)

- **AC-POLL-1 (open binds creator to sender) — `handler-unit`:** On `poll_open`,
  the stored `creatorPubkey` equals `sender.pubkey`; any `creatorPubkey` value
  present in the payload is ignored.
- **AC-POLL-2 (vote attribution) — `handler-unit`:** A `poll_vote` is recorded
  keyed to `sender.pubkey` as the voter (the `poll:voter` key), never to any
  voter-identifying field carried in the payload.
- **AC-POLL-3 (close authorization) — `handler-unit`:** A `poll_close` whose
  `sender.pubkey` ≠ the poll's stored `creatorPubkey` is rejected: the poll is
  not marked closed and no tally is displayed from that message.
- **AC-POLL-4 (tally recompute) — `handler-unit`:** On accepting a `poll_close`
  from the authenticated creator, the displayed tally is **recomputed from
  stored `PollVote` rows**, never taken from the close message's
  `results`/`totalVoters` fields — a close carrying forged counts still shows
  the true, recomputed tally. See AC-XCUT-2 for the order-independence property.

### Announcements (ANNOUNCE)

- **AC-ANNOUNCE-1 (rejected announcement leaves no trace) — `handler-unit`:** An
  enum announcement rejected by its actor rule (a non-admin actor for an
  admin-gated type, or a failed ingest-time roster check for an admission-type
  subject) produces **no chat row, no `setChatVersion` bump, no unread
  increment, and no notification** — the rejection happens in `chatHandler`
  before `deps.appendMessage` is called, not at render time.
- **AC-ANNOUNCE-2 (invited/declined/cancelled render unverified, not
  roster-gated) — `handler-unit`:** `invite_lifecycle('invited')`,
  `invite_lifecycle('declined')`, and `invite_cancelled` announcements from an
  admin/creator actor **render** (the subject is shown as an unverified claim)
  even when the subject is not present in the current roster — these types are
  never roster-gated, by design (the subject is not expected to be a member).
- **AC-ANNOUNCE-3 (admission roster-gate is ingest-time, non-retroactive) —
  `integrated-e2e`:** For `member_admitted` and `invite_lifecycle('accepted')`,
  roster membership of the subject is checked **once, at first ingest** of the
  announcement, and the accept/reject outcome is persisted as a flag. A
  legitimate, already-accepted announcement **remains visible in chat history**
  after the admitted member later leaves the group — a later `groupDataVersion`
  bump (triggered by the leave) does not re-evaluate and retract the row.
- **AC-ANNOUNCE-4 (call_notice actor = sender) — `handler-unit`:** A
  `call_notice` announcement's displayed actor is `sender.pubkey`; the
  structured payload's `initiator` field, if present and divergent from
  `sender.pubkey`, is not rendered as the actor.
- **AC-ANNOUNCE-5 (group_renamed admin-actor gate) — `handler-unit`:** A
  `group_renamed` announcement is accepted (rendered, display-only) only when
  its `sender.pubkey` is a current group admin per `GroupAdminsProvider`; the
  underlying group name shown elsewhere in the UI continues to come from the
  MLS metadata commit, not from this announcement.

### Forwarded profile (FWD)

- **AC-FWD-4 (forwarded profile attribution) — `integrated-e2e`:** A second
  signed-in peer (the relayer) forwarding a third member's signed profile
  envelope results in the profile being attributed to the **original signer**
  (not the relayer, not raw `rumor.pubkey`), applied idempotently, and scoped
  correctly, via the shared envelope verifier. A departed member's late or
  forwarded profile envelope is **not** rejected by the roster check (profiles
  are roster-exempt). *(Request AC-4.)*
- **AC-FWD-5 (replay hardening) — `verifier-unit`:** The shared verifier
  rejects a group-scoped envelope whose group tag ≠ the receiving group's id;
  one-shot consumption keyed on the **inner event id** means a self-authored
  copy and a forwarded copy of the same signed inner event are both accepted
  but the second application is a no-op (not double-applied). *(Verifier-level,
  not app-driven: profile — the only forwarded kind today — is
  group-binding-exempt, so no in-app producer can emit a group-bound envelope
  to exercise the group-tag-mismatch branch through the app; it is exercised by
  constructing the envelope directly in the verifier unit test. Replay-after-rejoin /
  epoch binding is out of scope — see `## Manual Validation`-adjacent Non-Goals
  in `architecture.md`. Request AC-5, partial.)*

### Send-side (SEND)

- **AC-SEND-10 (meta-event send fails closed) — `integrated-e2e` (interactive
  path) + `handler-unit` (background/relay path):** If a forwardable inner
  signature cannot be produced (locked/absent NIP-07 signer), the meta-event is
  not emitted and not actioned locally. Surfacing is per path: an interactive
  send (user-initiated) shows a visible error to the user; a background/relay
  send dev-logs the failure and relies on the existing profile-request retry
  machinery to eventually succeed — it does not show a UI error.

### Gate (GATE)

- **AC-GATE-11 (full e2e gate) — `integrated-e2e`:** `make test-e2e-all` (the
  full 60-test suite) is green, with no regression to existing group/DM
  behavior — explicitly including the invitation-lifecycle and poll features
  this epic's actor rules touch. *(Request AC-11.)*

## Cross-Cutting Invariants

> Derived from `architecture.md`'s `## Order-Sensitive Composition` section
> (FR-A1 signal: this epic composes order-sensitive subsystems — correctness
> depends on ordering, redelivery, and dedup across five named flows). Each AC
> below is a **property**: it quantifies over a space of orderings/interleavings
> (the generator) and asserts a condition that fails under violation — not a
> single hand-picked sequence.

- **AC-XCUT-1 (dedup leaves no trace on drop) — `handler-unit` (property test
  over interleavings):** For any interleaving of {a mismatched-sender rumor `R`
  with id `r` reaching the dispatcher} and {a legitimate, sender-matched
  redelivery of a rumor sharing id `r`}, the dispatcher's dedup LRU MUST NOT
  contain `r` as a result of processing the mismatched rumor, and the
  subsequent legitimate redelivery MUST still fan out to handlers exactly once
  — regardless of which of the two arrives first. A rumor id that was dropped
  for sender mismatch MUST NOT suppress a later legitimate delivery of that
  same id.
  Spans modules: Dispatcher
- **AC-XCUT-2 (poll tally is a pure function of stored votes) — `handler-unit`
  (property test over vote-arrival orderings):** For any arrival order, subset,
  or duplication of `PollVote` rows a client has stored before a `poll_close`
  from the authenticated creator is accepted (out-of-order delivery, missing
  votes, redelivered votes), the displayed tally MUST equal the recomputation
  from exactly the `PollVote` rows currently stored by that client, and MUST
  NOT vary with the close message's claimed `results`/`totalVoters` values for
  any values those fields carry.
  Spans modules: Poll
- **AC-XCUT-3 (leave enqueue is sender-gated across debounce interleavings) —
  `handler-unit` (property test over concurrent leave-intent interleavings):**
  For any interleaving of leave-intent messages arriving within the 5-second
  auto-commit debounce window (including a second, different subject's
  leave-intent arriving mid-debounce, or a duplicate leave-intent for the same
  subject), a removal MUST be enqueued for a given subject if and only if that
  subject's own leave-intent rumor had `payload.pubkey === sender.pubkey` —
  no concurrent or reordered leave-intent traffic may cause a removal to be
  enqueued for a subject whose own departure was never sender-matched.
  Spans modules: Leave
- **AC-XCUT-4 (edit/delete authorization is arrival-order-independent) —
  `handler-unit` (property test over signal/target and multi-signal arrival
  orderings):** For any arrival order of an edit/delete signal relative to its
  target message (signal-before-target or target-before-signal), and for any
  resolution order `resolvePendingSignalsForSlot` applies across multiple
  pending signals for the same slot, the final authorization outcome MUST be
  identical to the outcome computed from the authenticated sender of the signal
  vs. the authenticated sender of the target alone — never a function of which
  arrived first — and this MUST hold identically at both the edits module
  (`messageEdits/api.ts`) and the tombstone re-check it feeds
  (`chatPersistence.ts`).
  Spans modules: Edits (2nd hop), Tombstone (3rd hop)
- **AC-XCUT-5 (profile merge is order-independent; verifier consumption is
  one-shot) — `handler-unit` + `verifier-unit` (property test over delivery
  orderings):** For any delivery order of two profile envelopes for the same
  subject pubkey — including a self-authored copy and a forwarded copy of the
  identical signed inner event, and envelopes whose `updatedAt` values arrive
  out of chronological order — (a) the merged `MemberProfile` state after both
  are processed MUST be identical regardless of delivery order and MUST equal
  the profile carrying the greatest `updatedAt`, and (b) the shared verifier's
  one-shot consumption (keyed on the inner event id) MUST ensure a duplicate
  delivery of the same inner event id is applied at most once, regardless of
  which copy (self or forwarded) arrives first.
  Spans modules: Profiles (forwarded), Shared verifier

## Manual Validation

- **AC-MV-1 (backbone dependency — honest caveat, incl. forced removal):** This
  epic does **not** close impersonation or forced removal. A real member
  setting `pubkey` to a victim's key over the real MLS send stack still
  succeeds — including a **forged leave that evicts the victim** — because the
  seam is fed the claimed pubkey until the backbone lands. Confirm this is
  understood at ship time; the guarantees written above become real only when
  the fork backbone epic ships, at which point no handler-layer change is
  required. *(owner: product owner)*
- **AC-MV-2 (impersonation finding stays open):** The project's impersonation
  security finding must **not** be recorded as resolved by this epic; it
  remains open, pointing at the backbone epic. *(owner: product owner)*
- **AC-MV-3 (real forgery-drop) — deferred to backbone:** request AC-1 in its
  true form (a real forger dropped by the library, not the dev-override
  stand-in exercised by AC-SEAM-1) and AC-9 (epoch-correct fork attribution)
  are validated by the backbone epic. *(blocked_on: backbone epic)*
