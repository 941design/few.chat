# ADR-012: Implement spec-mandated MLS sender binding in our marmot-ts fork, plus signed enum meta-events for forwardable system messages

**Status**: Proposed
**Date**: 2026-07-23
**Type**: Lightweight
**Affects**: the marmot-ts / ts-mls fork, `app/src/lib/marmot/**` (dispatcher + all
application-rumor handlers), specs/group-message-author-authentication-spec-request.md,
project-wide (all MLS group application messages)
**Supersedes**: ADR-006
**Superseded by**: none

## Context

Group application messages are attributed to the inner rumor's **self-declared
`pubkey`**, which any current member can set to any value. A member can make a
chat message, reaction, edit/delete, poll action, or system announcement appear
to come from another member. The worst instance is forced removal: a leave
message is actioned on a `pubkey` field taken from the message body
(`leaveHandler.ts:26`), so a member can announce **another member's** departure
and the admin's auto-commit evicts them (`MarmotContext.tsx:712-773`).

This is not a newly discovered hole. **ADR-006** (2026-07-07) documented it and
consciously *accepted* it as an interim risk, because the only correct fix — the
check the Marmot spec already requires — was unimplementable at the time:

- The Marmot spec mandates the check. `group-messaging.md:43`: *"receivers
  validate the inner app event pubkey matches the MLS-authenticated identity"*
  (as recorded in `BACKLOG.json#marmot-ts-0-5-1-drops` and ADR-006). The spec
  also requires the inner rumor to remain **unsigned**.
- ts-mls/marmot-ts 0.5.1 drops the data needed to perform it. The
  `applicationMessage` decrypt result returns only `{ message: Uint8Array }`
  (`ts-mls/dist/src/processMessages.d.ts:14-19`); the MLS-authenticated sender
  leaf is resolved internally and discarded. Proposals keep it; application
  messages do not.

Two facts have changed since ADR-006:

1. **We now control the marmot-ts (and ts-mls) fork.** "Needs a library change"
   is no longer a blocker. Implementing the spec-required check is a small,
   spec-*aligning* fork edit — not a divergence. ts-mls already computes the
   value for proposals (`processMessages.js:91`,
   `getSenderLeafNodeIndex(result.content.content.sender)`); the two
   application-message return sites (`:48`, `:67`) need the identical one-liner,
   and `getSenderLeafNodeIndex` is already imported (`:14`).
2. **The product owner has ruled deniability a non-goal** (see Decision §1) and
   has required that system messages (leave, admission, lifecycle) be
   authenticated to their actor **and remain forwardable on behalf of others**.

A prior design leaned toward signing every inner rumor at the application layer
("uniform outer-A"). A Fable architecture review (2026-07-23) rejected it on
mechanism: signing the outer rumor **diverges from the spec**, and its one
distinguishing capability — attributing a forwarded message to an author who is
not the transmitter — is exactly the case a spec-compliant receiver is *required
to reject* (`group-messaging.md:43`). Forwarding can only be carried **inside the
payload**, which is precisely how the existing profile envelope already works
(outer rumor authored by the relayer; inner signed event authored by the profile
owner — `profileSync.ts`).

## Decision

**1. Deniability is an explicit non-goal of this project.** We do not need, and
will not preserve at any cost, the property that a member cannot later prove to
an outsider who authored a message. Where a design choice trades deniability for
authenticity, integrity, or simplicity, we take the trade. This rationale is
recorded here as a general project stance, not scoped to this feature. (It does
**not** relax the separate, non-negotiable privacy invariant against broadcasting
profile metadata to public relays — that stands unchanged; see `CLAUDE.md`.)

**2. Adopt a hybrid, split by layer:**

- **Backbone — MLS sender binding, in the fork (implements `group-messaging.md:43`).**
  The ts-mls fork surfaces the authenticated sender leaf on the
  `applicationMessage` result, resolved **against the epoch-correct ratchet tree
  inside the unprotect path** (not against the current tree at the emit site —
  leaf indices are reused after removals, so late-arriving old-epoch messages
  would otherwise misattribute). The marmot-ts fork maps that leaf credential to
  a Nostr pubkey, enforces `rumor.pubkey === senderPubkey` **immediately after
  decryption — before the message is saved to history, yielded, or emitted** (not
  only at the emit site), drops on mismatch with a diagnostic event, and hands the
  app an already-authenticated `{ rumor, senderPubkey, senderLeafIndex }`. The
  drop is unconditional here; whether the spec's normative strength permits a
  configurable posture is deferred (see Evolution Triggers). This covers **every kind, every
  client, and all legacy history** with **zero wire-format change** and no
  per-message signature.

- **System-message authorization + forwarding — enum meta-events, in the app
  payload.** Non-textual system messages (leave, member-admitted, invite
  lifecycle, invite-cancelled, poll-close, call notice, group-renamed, profile)
  become **enum-typed structured payloads** (not free-form content). Their
  **actor** is the **authenticated backbone sender**, with per-type rules: a
  **self-claim** (leave) requires `subject === sender`, which is what makes "you
  can only announce your own leave" true and closes forced removal; an **admin
  action** (member-admitted, group-renamed, invite-cancelled, invite-lifecycle)
  requires the actor hold the admin role and is **display-only** — the
  authoritative fact is the MLS commit/metadata, never the announcement.
  **The forced-removal fix rides the backbone and needs no per-message
  signature.**

  **Forwarding** (on behalf of an offline member) is a layered capability for the
  kinds that need it — **profiles today** (identity-scoped, context-free, reused
  across groups and the gift-wrap DM channel). A forwardable meta-event carries an
  **inner signed Nostr event**; a relayer authors a fresh outer rumor as
  themselves (passing the backbone) that wraps the original author's signed inner
  event. Forwardable inner envelopes are **replay-hardened**: typed by a distinct
  inner event kind, group-bound (for group-scoped kinds), bounded by epoch /
  join-generation and freshness, and consumed one-shot keyed on the **inner event
  id**. The enum format keeps every meta-event forwarding-*capable*; a forwarding
  *producer* (and its inner signature) is built per kind as needed, not
  speculatively — so kinds nothing forwards (leave, polls, call notice) stay on
  the backbone and carry no signing burden or replay surface.

**3. This resolves ADR-006's accepted risk** by implementing the spec-required
check in our fork rather than continuing to wait for upstream. The upstream
finding `BACKLOG.json#marmot-ts-0-5-1-drops` is satisfied by this work; the
`PROPOSAL-marmot-ts-authenticated-sender.md` is repurposed from a feature request
into a spec-conformance PR ("ts-mls drops the sender leaf the Marmot spec's
receiver check requires — here is the fix").

## Alternatives Considered

| Alternative | Why rejected (mechanism) |
|---|---|
| **Uniform app-side outer-A** (sign every inner rumor, attribute to the signer) | Diverges from `group-messaging.md:43` in wire format; its headline capability — forwarding by attributing to a non-transmitter — is the exact case compliant receivers must drop, so forwarding does not survive interop; leaves an unsigned-downgrade window (an attacker omits the signature and sets `pubkey = victim`) that persists until every legacy message is gone; and adds a NIP-07 signing dependency to every send, including background sends. |
| **Pure B** (sender binding only, no new signatures) | Closes impersonation completely and spec-compliantly — it is ADR-006's own planned endgame — but cannot deliver the required product behavior of forwardable, author-attested system messages. It is the *backbone* of this decision, not the whole. |
| **Fork-side A** (fork signs at send, refuses to emit unverified) | Bakes spec-nonconformance into the library for all consumers; "refuse unverified" hard-breaks all existing unsigned history unless the library grows a legacy-trust policy — and trust policy is the wrong thing to own in the library; moves the user's signer into library call paths where NIP-07 prompting/latency is uncontrollable. |
| **Continue ADR-006's accept-the-risk posture** | The blocker (no fork control) is gone and the product now has requirements (authenticated, forwardable system messages) that the accepted-risk posture cannot satisfy — ADR-006's own Evolution Trigger fires. |

## Consequences

**Positive**
- Member-on-member impersonation is closed for **all** application messages,
  including chat/reactions/edit-delete/polls and all legacy history, at a single
  fork choke point — a handler can no longer forget to verify a new kind.
- Forced removal, forged reactions, forged edits/deletes, and forged system
  announcements are all closed by the same backbone plus the actor rule.
- Zero wire-format divergence: outer rumors stay 6-field unsigned MIP-03 rumors,
  so non-Few Marmot clients are unaffected and the fork delta is upstreamable and
  self-liquidating (it *implements* the spec's required receiver check).
- The NIP-07 signing burden is confined to the rare forwardable meta-events, not
  every chat keystroke.

**Negative / costs**
- Reinstates a maintained ts-mls + marmot-ts fork delta until upstream accepts
  the sender-surfacing change.
- Introduces a new payload discipline (enum meta-events with inner signatures,
  group-binding, one-shot consumption) that every current structured-content
  producer/consumer must migrate onto.

**Accepted risks**
- A forwarded meta-event's inner signature is transferable proof of the actor's
  authorship — acceptable under Decision §1 (deniability is a non-goal).
- Until the fork lands, the ADR-006 posture remains in force for existing kinds.

## Evolution Triggers

- Upstream ts-mls/marmot-ts accepts the sender-surfacing change → the fork delta
  for the backbone shrinks to zero; update the References here, not the decision.
- A future kind needs cross-context (not group-scoped) forwarding beyond profiles
  → revisit the group-binding rule for that kind specifically.
- The verbatim normative wording of `group-messaging.md:43` (MUST vs SHOULD on
  the receiver check) should be quoted into this ADR when confirmed against the
  upstream spec; it determines whether the fork's mismatch handling is
  unconditional "drop" or "drop by default, configurable."

## References

- **Supersedes** ADR-006 (accept group-member-attested authorization) — its
  Evolution Trigger #1 anticipated exactly this supersession.
- Related: ADR-003 (LWW for MLS metadata — sibling "marmot-ts gives less
  guarantee than we'd like" decision).
- Backlog: `BACKLOG.json#marmot-ts-0-5-1-drops` (the tracked upstream gap this
  work resolves) and the poll-close authorization finding that cites ADR-006.
- Spec: `specs/group-message-author-authentication-spec-request.md` (the
  implementation-facing feature request).
- Upstream PR: `proposals/PROPOSAL-marmot-ts-authenticated-sender.md`
  (repurposed as spec-conformance).
- Marmot spec: `group-messaging.md:43` (receiver sender-binding requirement).
