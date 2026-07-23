# Group Invitation Lifecycle Chat Messages — Acceptance Criteria

## Terminology

- **direct-invite flow** — the contact-invite path (`InviteMemberModal` /
  `submitInviteWithMarker`) that commits an MLS Add synchronously via
  `inviteByKeyPackageEvent`. Distinct from the join-request/invite-link flow.
- **join-request/invite-link flow** — the out-of-scope path where B requests
  to join and A approves (`approveJoinRequestImpl`, reusing `inviteByNpub`);
  already emits its own `member_admitted` announcement, unaffected by this epic.
- **pending member** — a pubkey that is in the MLS tree (holds a leaf) but has
  no `MemberProfile` yet (`isPendingMemberImpl`); i.e., invited-but-not-joined.
- **tree membership** — the live MLS group tree state, as opposed to the
  `PendingInvitation` IDB marker (which can be cleared out of band).
- **informative-announcement family** — every `StructuredContent` variant
  *except* `image` (e.g. `invite_lifecycle`, `member_admitted`, `leave_intent`,
  `invite_cancelled`, `call_notice`, polls). `image` messages are ordinary
  user content and are excluded from the immutability rules below.
- **senderPubkey** — the protocol-verified MLS transport sender of a rumor
  (self-asserted per ADR-006, not identity-bound), as opposed to any
  application-payload `pubkey` field, which is merely a data field chosen by
  whoever authored the payload.
- **`INVITE_DECLINE_KIND`** — a new app-level inner rumor kind, distinct from
  kind-444 (Welcome), kind-21059 (join-request), and the pairing-ack kind,
  carrying a B→A gift-wrapped decline.
- **`PendingInvitation`** — the localStorage-backed record of an invitation B
  has received but not yet joined/declined (`app/src/lib/pendingInvitations.ts`).

## Known TAGs

- **STRUCT** — the `invite_lifecycle` `StructuredContent` variant, its parse
  guard, and author-resolution.
- **PROD** — the `invited`/`accepted` group-announcement producers.
- **RENDER** — inline rendering and i18n copy for the three lifecycle events.
- **DECLINE** — the B→A gift-wrapped decline DM channel and A's receive-side
  handling (authenticate, defer, Remove, post, mark-seen).
- **IMMUT** — immutability of informative announcements, both UI suppression
  and receive-side rejection, including the admin carve-out.

## Parsing, Guard & Author Resolution (S1)

**AC-STRUCT-1** — `parseStructured` MUST return
`{ type: 'invite_lifecycle', event, pubkey }` for a payload whose `type` is
`'invite_lifecycle'`, whose `event` is one of `'invited' | 'accepted' |
'declined'`, and whose `pubkey` matches `/^[0-9a-f]{64}$/`; the returned
object MUST contain exactly those three fields.

**AC-STRUCT-2** — `parseStructured` MUST NOT return an `invite_lifecycle`
result (falling through to plain-text rendering instead) when `type ===
'invite_lifecycle'` but `event` is any value outside the three-member enum
(e.g. `'pending'`, `''`, `undefined`).

**AC-STRUCT-3** — `parseStructured` MUST NOT return an `invite_lifecycle`
result when `type === 'invite_lifecycle'` and `event` is valid but `pubkey`
fails the canonical-hex guard (uppercase hex, non-hex characters, wrong
length, or a non-string value) — the malformed payload falls through to
plain-text rendering.

**AC-STRUCT-4** — When the raw JSON payload for an otherwise-valid
`invite_lifecycle` message carries extra properties beyond `type`, `event`,
`pubkey` (e.g. a spoofed `role` or `__proto__` field), the object
`parseStructured` returns MUST contain only the three named fields — the
object is rebuilt from named fields, never returned via a widened `as
StructuredContent` cast that would pass extra properties through.

**AC-STRUCT-5** — For any rendered `invite_lifecycle` announcement, the
displayed author MUST be resolved from the message's protocol-level
`senderPubkey`, never from the payload's `pubkey` field — so a message whose
payload `pubkey` names B but whose transport `senderPubkey` is C (a forged
or third-party-authored announcement) MUST render C, not B, as the author.

## Producers, Rendering & i18n (S2)

**AC-PROD-1** — When a direct contact-invite (`submitInviteWithMarker` /
`InviteMemberModal`) completes its MLS Add successfully, the app MUST send an
application rumor with content `{ type: 'invite_lifecycle', event: 'invited',
pubkey: <inviteeHex> }` into the group.

**AC-PROD-2** — Approving a join-request via the join-request/invite-link
flow (`approveJoinRequestImpl` reusing `inviteByNpub`) MUST NOT produce an
`invite_lifecycle` `invited` message — only the existing `member_admitted`
announcement is emitted for that flow.

**AC-PROD-3** — When a profile rumor for invitee B arrives in the group with
transport `senderPubkey === B`, and this is the first pending→joined
transition recorded for B in that group, A's client MUST post an
`invite_lifecycle` message with `event: 'accepted'`, `pubkey: B`.

**AC-PROD-4** — When a profile rumor naming B arrives with transport
`senderPubkey !== B` (a third member relaying B's cached profile, B having
never processed the Welcome), A's client MUST NOT post an `accepted` message
for B.

**AC-PROD-5** — A MUST NOT post more than one `accepted` message for the same
invitee in the same group, even when B's own-authored profile rumor
(`senderPubkey === B`) is received more than once (e.g. across a
reconnect/resubscribe).

**AC-RENDER-1** — Rendering an `invite_lifecycle` message MUST display the
invitee (subject) name resolved from `profileMap[payload.pubkey]`'s nickname,
falling back to a truncated npub when no profile is known — mirroring the
`member_admitted` name-resolution precedent.

**AC-RENDER-2** — Rendering an `invite_lifecycle` message MUST select its copy
string from `i18n.ts` keyed on `event` (`invited` / `accepted` / `declined`),
with a distinct, non-empty string present for each of the three enum values
in both the `en` and `de` locale objects.

**AC-RENDER-3** — The `invite_lifecycle` presentational component MUST render
with a stable `data-testid`, no avatar, no message bubble, and no
edit/delete/reaction affordances — consistent with the `LeaveChatAnnouncement`
precedent.

## Decline DM Channel (S3)

**AC-DECLINE-1** — The pre-join Welcome reader MUST surface the MLS
`groupId` (from `readWelcomeGroupInfo`'s `groupContext.groupId`) and persist
it on the stored `PendingInvitation` at enqueue time, so it is available to
the decline send without re-parsing the Welcome.

**AC-DECLINE-2** — The stored `PendingInvitation` MUST persist an
`authenticated` boolean at enqueue time, reflecting whether the Welcome's
gift-wrap seal was authenticated at receipt.

**AC-DECLINE-3** — Declining a `PendingInvitation` with `authenticated: true`
MUST send a NIP-59 gift-wrapped rumor of `INVITE_DECLINE_KIND`, addressed to
`inviterPubkeyHex`, with ephemeral sender key and inner rumor content
`{ groupId, pubkey: selfHex }` and no other fields.

**AC-DECLINE-4** — Declining a `PendingInvitation` with `authenticated: false`
MUST NOT send any decline gift wrap — no publish call for
`INVITE_DECLINE_KIND` occurs.

**AC-DECLINE-5** — Declining a `PendingInvitation` MUST remove it from local
storage regardless of whether the decline gift-wrap send succeeds or fails.

**AC-DECLINE-6** — Declining MUST NOT publish any message on the group's MLS
channel and MUST NOT add B to the group — the only network effect of a
decline is the addressed gift wrap to A.

**AC-DECLINE-7** — `INVITE_DECLINE_KIND` MUST be numerically distinct from
kind-444 (Welcome), kind-21059 (join-request), and the pairing-ack kind; the
gift-wrap dispatch MUST route a rumor of `INVITE_DECLINE_KIND` to the
decline-handling branch, never to the Welcome or join-request branches.

**AC-DECLINE-8** — A MUST authenticate a received decline gift wrap's inner
seal (existing NIP-59 unwrap checks) before evaluating it further; a gift
wrap that fails seal authentication MUST NOT trigger a Remove, a `declined`
post, or a marker clear.

**AC-DECLINE-9** — A MUST accept a decline only when the gift wrap's
inner-seal author, lowercased, is currently a *pending* member (in-tree, no
`MemberProfile`) of the referenced group; when the lowercased seal author is
NOT a pending member of that group (spoofed by a third party, or the invitee
has already joined/been removed), the decline MUST be a no-op — no Remove, no
`declined` post, no marker clear.

**AC-DECLINE-10** — On accepting a valid decline, A MUST perform, in order:
(1) the MLS Remove of the invitee, (2) posting the group `declined`
`invite_lifecycle` message, (3) clearing the pending-direct-invite marker for
that invitee/group, (4) marking the gift wrap seen/processed — and MUST NOT
mark the gift wrap seen before step (2) has completed.

**AC-DECLINE-11** — A duplicate or replayed decline gift wrap received after
the referenced invitee is no longer a pending member (already removed via a
prior decline) MUST be a no-op and MUST NOT produce a second `declined`
message for that invitee/group.

**AC-DECLINE-12** — A decline gift wrap referencing a group that has not yet
completed historical sync MUST be deferred — its Remove and `declined` post
withheld, and it MUST NOT be marked seen/processed — until that group's sync
completes (`onHistorySynced`), after which DD-7's ordering (AC-DECLINE-10)
executes.

**AC-DECLINE-13** — The decline gift wrap's plaintext inner rumor content
MUST contain only `groupId` and `pubkey` — no nickname, avatar, or other
profile metadata — verified by inspecting the rumor content before gift-wrap
encryption.

## Immutability — UI Suppression (S4)

**AC-IMMUT-1** — For a non-admin viewer, both Edit and Delete MUST be
suppressed for any message whose content parses (via `parseStructured`) to a
non-`image` `StructuredContent` — this applies to the whole informative-
announcement family (`invite_lifecycle`, `member_admitted`, `leave_intent`,
`invite_cancelled`, `call_notice`, polls), not only `invite_lifecycle`.

**AC-IMMUT-2** — For any viewer, an `image`-type structured message authored
by that viewer MUST remain deletable — the announcement-family suppression
in AC-IMMUT-1 does not extend to `image`.

**AC-IMMUT-3** — For a group-admin viewer, a Delete affordance (moderation
delete) MUST be shown on an informative-announcement-family message, but Edit
MUST NOT be shown — the admin carve-out grants delete only, never edit.

## Immutability — Receive-Side Rejection (S4)

**AC-IMMUT-4** — A delete or tombstone signal targeting a message whose
content parses as a non-`image` `StructuredContent`, whose signal sender is
NOT a current group admin, MUST be rejected at `applyDeleteEditSignal` and at
the tombstone-application path in `chatPersistence.ts` — the target
message's stored content and state MUST remain unchanged.

**AC-IMMUT-5** — A delete or tombstone signal targeting a non-`image`
`StructuredContent` message, whose signal sender IS a current group admin,
MUST be honored (applied) at `applyDeleteEditSignal` and at the
tombstone-application path.

**AC-IMMUT-6** — An edit signal targeting a message that parses as a
non-`image` `StructuredContent` MUST be rejected at every apply site
regardless of whether the signal's sender is a group admin — Edit is never
honored against any informative announcement, admin or not.

**AC-IMMUT-7** — An edit signal whose *replacement content* parses (via
`parseStructured`) as a non-`image` `StructuredContent`, MUST be rejected
regardless of the edit's target message type — this prevents fabricating an
immutable announcement row in place of an ordinary message via edit.

**AC-IMMUT-8** — At the message-append storage primitive (`appendMessage`,
`chatPersistence.ts`), a row previously fabricated as a TTL-expiry
materialize-on-expiry placeholder (flagged `materializedFromEdit`) MUST be
replaced in place ONLY when the newly arriving message sharing that same id
parses as a non-`image` informative announcement; an arriving *ordinary*
(non-announcement) message sharing that same id MUST leave the placeholder —
and any edit/tombstone already applied to it — unchanged (a no-op, not an
overwrite). This closes an AC-IMMUT-6 bypass discovered during S9 cross-
cutting enumeration (`crossCuttingImmutabilityInvariance.test.ts`, the
TTL-expiry × late-arriving-announcement-target scenario, VQ-S9-010): without
this rule, a genuine group announcement arriving after an earlier pre-emptive
edit signal had already materialized a placeholder at that message id would
be silently suppressed by ordinary insert-if-absent dedup, permanently
defeating that announcement's immutability.

## Cross-Cutting Invariants

**AC-CROSS-1** — For any interleaving drawn from the space of {zero or more
duplicate redeliveries of a single decline gift wrap} × {zero or more
app-restart/crash events, occurring before or after step (1) of AC-DECLINE-10}
× {the referenced group's historical-sync completion occurring before,
during, or after gift-wrap delivery}, the system MUST converge to *at most
one* `declined` `invite_lifecycle` post and *at most one* MLS Remove for that
invitee/group — and, whenever at least one delivered decline found the
invitee still a pending member at evaluation time, MUST converge to *exactly
one* Remove and one `declined` post (never zero, never more than one) — no
interleaving in this space may produce two `declined` posts, nor leave a
validly-declined invitee un-Removed after the group syncs.

Spans modules: decline-a, decline-b

**AC-CROSS-2** — For any apply site drawn from {the direct known-row
application in `applyDeleteEditSignal`, the buffered-signal application via
`resolvePendingSignalsForSlot`, TTL-expiry materialization, the tombstone
path in `chatPersistence.ts`} × any arrival order between an edit/delete
signal and its target message (signal-before-target or
target-before-signal): a delete/tombstone signal targeting a non-`image`
`StructuredContent` message MUST be honored if and only if the signal's
sender is a current group admin at evaluation time, and an edit signal whose
target message OR whose replacement content parses as a non-`image`
`StructuredContent` MUST be rejected — never applied — regardless of which
apply site resolves it or in which order signal and target arrived.

Spans modules: immutability-receive

## Manual Validation

None. Every AC above is unit- or e2e-testable: the decline flow, producer
gating, and rendering are exercised end-to-end through the app's own UI (S5,
`groups-*.spec.ts`, relay bucket); receive-side forgery/UI-bypass cases
(AC-IMMUT-4 through AC-IMMUT-7, AC-CROSS-2) are unit-test territory because
the publish-through-the-app rule means the app itself cannot emit a
UI-bypassing edit/delete signal — those are exercised by directly invoking
the apply-site functions with hand-constructed signal objects in
`tests/unit/**`, not by hand-signing events against a live relay. Per the
test-layer routing convention, S5's e2e coverage of AC-PROD-1/3,
AC-DECLINE-3/9/10, and AC-IMMUT-1/3 is a conformance oracle confirming the
assembled system agrees with what the lower-layer unit/property tests
(AC-CROSS-1, AC-CROSS-2) already established — it is not the primary search
over the ordering/interleaving space.
