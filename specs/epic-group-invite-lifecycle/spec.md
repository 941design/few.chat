# Group Invitation Lifecycle Chat Messages

**Status**: Specification — pre-implementation (2026-07-22)

## Problem

When user **A** invites user **B** to an MLS group and **B declines**, A is never
informed. A's UI keeps showing the invitation as "pending" indefinitely.

This is a *structural* gap, not an oversight. B declines **before joining the
group**: `declinePendingInvitation()` (`app/src/lib/marmot/welcomeSubscription.ts:949-952`)
only deletes the stored `PendingInvitation` from localStorage — **no network call
at all**. B has no MLS group channel to write back to A. The MLS Add was
committed at invite time, so B holds a leaf in the group tree, but B has not
processed the Welcome and has no synced group session to send into. A's "pending"
marker for B is cleared only by B's profile arriving *after* B joins, by A
cancelling, or by A leaving the group — a decline triggers none of these.

Beyond the missing decline signal, the group has no visible record of the
invitation lifecycle at all. There is no "A invited B" event in the chat, so when
a member does join, other members have no context for how they got there.

*Success signal: after B declines, A (and the whole group) sees a "B declined"
message in the group chat; after A invites B, the group sees an "invited" message;
these informative messages cannot be edited or deleted by anyone.*

## Constrained by ADRs

- **ADR-006** (group-member-attested authorization for MLS application-message
  mutations): the inner rumor `pubkey`/`senderPubkey` for group messages is
  self-asserted, not bound to an MLS leaf credential. The DD-5 admin carve-out
  (honour an admin-authored delete against an announcement) is authorized on that
  self-asserted value and inherits ADR-006's accepted residual — a modified client
  can assert an admin's pubkey. This spec does **not** add cryptographic per-message
  binding (DD-3, Non-Goals).
- **ADR-010** (universal admin-only eviction via the shared MLS Remove / cancel-invite
  path): the decline-triggered Remove (DD-4/DD-7) reuses `cancelPendingInvitationImpl`,
  which is ADR-010's admin-eviction path. A is an admin by virtue of having sent the
  direct invite (invite is admin-gated today). The shared function does not itself
  re-verify caller admin status at call time (UI-gated only); the decline path invokes
  it automatically, an inherited property of that function, consistent with ADR-010.
- **ADR-007** (gift-wrapped 1:1 direct-contact profile exchange): the decline DM
  channel reuses the same NIP-59 gift-wrap infrastructure — addressed, encrypted,
  ephemeral-sender — consistent with ADR-007's model.

## Relationship to Other Epics

- **`epic-cancel-pending-invitations` / `epic-invite-rescind-and-member-removal`** —
  the decline flow reuses `cancelPendingInvitationImpl` (the MLS Remove of a pending
  invitee) but emits a `declined` `invite_lifecycle` announcement instead of
  `invite_cancelled`. No change to those epics' behavior.
- **`epic-direct-contact-profile-exchange`** — the decline DM reuses that epic's
  gift-wrap subscription/send infrastructure in `welcomeSubscription.ts`.
- **`epic-feature-request-message-edit-and-delete`** — the immutability work (DD-5,
  DD-11) tightens the edit/delete apply sites introduced there, adding the
  announcement-family + admin-carve-out gate; it does not change edit/delete for
  ordinary (non-announcement) messages.

## Solution

Extend the existing group-chat **informative-announcement** mechanism (the
`StructuredContent` discriminated union rendered inline in the chat timeline) with
a single new **invitation-lifecycle** variant that carries a **status-code enum**
— `invited | accepted | declined` — rather than verbose text. The human-readable
sentence is resolved from i18n at render time, keyed on the enum.

Three lifecycle events are written into the group chat, as MLS-encrypted
informative messages visible to all current members:

**All three are authored by A** — the inviter narrates the entire lifecycle of
the invitation it sent. This is possible because, in the direct-invite flow, A's
invite call commits the MLS Add immediately (`inviteByKeyPackageEvent`,
`MarmotContext.tsx:1647`), so admission happens at invite time and every lifecycle
outcome is an event A can observe:

- **invited** — posted by A when A invites B (this same instant *is* the MLS
  admission commit).
- **accepted** — posted by A when it observes B actually joined. B can join on its
  own with no further handshake or approval; A learns of the join when B's profile
  rumor arrives in the group (the existing signal that flips A's "pending" badge to
  "confirmed"). A posts **accepted** at that marker-clear point.
- **declined** — B has no synced group session to post into. Instead B sends an
  **addressed, encrypted DM** (NIP-59 gift wrap) back to the inviter A carrying the
  decline status. A's client, on receiving and authenticating it, **evicts B from
  the group** (an MLS Remove, reusing the existing cancel-invite machinery), posts
  the group-visible **declined** informative message, and clears its pending marker
  for B. Removing B is required: because the Add was committed at invite time, a
  decline that only announced without removing would leave B able to still join
  later via the Welcome on the relay — contradicting the "declined" record — and
  leave a phantom member-list row. A decline is therefore *a cancellation triggered
  by B* rather than by A.

These informative messages are **immutable for ordinary members**: the UI never
offers edit or delete on them to a non-admin, and — critically — every member's
client **rejects any edit or delete signal targeting one unless the signal's sender
is a group admin**. Group admins retain a moderation delete so a forged or abusive
informative message can be removed; ordinary members can never rewrite or erase
them. The rendered author is always resolved from the rumor-dispatcher's attributed
sender (`senderPubkey`, self-asserted per ADR-006 — see `## Constrained by ADRs`),
so a forged announcement is visibly attributed to whoever posted it, not to the
subject it names.

### Design Decisions

- **DD-1 — One enum-carrying variant, not three type tags.** A single
  `StructuredContent` variant `{ type: 'invite_lifecycle'; event: 'invited' |
  'accepted' | 'declined'; pubkey: string }` carries the status code in `event`,
  directly satisfying "status codes or enum values instead of verbose messages."
  This mirrors the existing `call_notice` variant's `event: 'started' | 'ended'`
  field (`parseStructured.ts:23`). Verbose per-language text lives in `i18n.ts`,
  one key per enum value.

- **DD-2 — Decline is a DM to the inviter, never a group message.** B is not a
  group member at decline time and MUST NOT be added just to announce a decline.
  B sends a gift-wrapped rumor of a new dedicated inner kind to A, reusing the
  existing gift-wrap subscription infrastructure that already routes inner kinds
  (444 Welcome, 21059 join-request) in `welcomeSubscription.ts`. A relays the
  outcome into the group. (Explicitly confirmed by product owner.)

- **DD-3 — A authors all three; one uniform trust model.** Every lifecycle
  message is posted by A over the group's MLS channel, so in the normal flow
  `senderPubkey` is A (the rumor-dispatcher's attributed sender — self-asserted per
  ADR-006, not an MLS-bound leaf credential) and the *subject* (invitee B) is always
  carried in the payload `pubkey` field. This is the deliberate, product-owner-chosen model:
  the inviter narrates the lifecycle of the invitation it sent. It is possible
  because the direct-invite flow admits B at invite time (`inviteByKeyPackageEvent`
  commits the Add synchronously — verified at `MarmotContext.tsx:1647-1659`), so
  "accepted" (A observing B's join) and "declined" (A receiving B's decline DM)
  are both events A observes and records — there is no second admission handshake
  that would force acceptance to be self-announced by B. Because A is the sole
  *intended* author, there is no cross-author attribution asymmetry in the normal
  flow. Note this does NOT make the payload unforgeable: any current member with a
  modified client can emit an `invite_lifecycle` (or any announcement) payload —
  the inner rumor `pubkey` is not MLS-identity-bound. That residual is handled by
  (a) rendering the author from the protocol-verified `senderPubkey` so a forgery is
  visibly attributed to its poster, and (b) the admin moderation delete (DD-5). The
  decline DM's origin is separately gated by DD-4. The product owner explicitly chose
  **not** to add heavier cryptographic per-message binding of the decline to B's
  identity at the group-message layer.

- **DD-4 — The decline DM must originate from the actual invitee, validated
  against live tree membership (not a fragile IDB marker).** A accepts a decline
  only when the gift wrap's inner-seal author (the protocol-verified DM sender) is
  currently a *pending* member of the referenced group — in the MLS tree but not
  yet joined (the existing `isPendingMemberImpl` liveness check: in-tree AND no
  `MemberProfile`), lowercasing the seal pubkey before comparison. A third party
  cannot spoof "B declined." Validating against tree membership rather than the
  pending-direct-invite IDB marker is deliberate: the marker can be cleared out of
  band (see DD-10) and must not be the sole gate, or a genuine decline could be
  silently dropped.

- **DD-5 — Immutability enforced on both the UI and the receive path, with an
  admin-moderation carve-out.** Hiding the buttons is necessary but not sufficient
  ("rejected by other group members" requires receive-side enforcement). Both
  layers target the **informative-announcement family** — every `StructuredContent`
  variant *except* `image` (image messages are ordinary user content and remain
  deletable). For ordinary members, both Edit and Delete are suppressed in the UI
  and any edit/delete signal targeting an announcement is rejected on receipt. For
  **group admins**, a moderation Delete remains available and an admin-authored
  delete/tombstone targeting an announcement is honored on receipt (the sender's
  admin status is checked against group state). This closes a pre-existing latent
  gap: today the Delete affordance is ungated by content type (`ChatBox.tsx:816-826`),
  so a self-authored announcement still shows a Delete button. NOTE: this is a
  user-visible capability change for *existing* announcement types (polls,
  call-notices, etc.) — ordinary members lose the ability to delete their own
  announcements; only admins can.

- **DD-6 — Strict, fail-closed payload validation.** The new `parseStructured`
  branch requires `event` ∈ the enum AND a canonical 64-char lowercase-hex
  `pubkey` (following the `member_admitted` precedent, `parseStructured.ts:71`,
  not the looser legacy `typeof === 'string'` guards). Malformed/crafted payloads
  fall through to harmless plain-text rendering. The returned object is rebuilt
  from named fields only — never `parsed as StructuredContent`.

- **DD-7 — Idempotent, crash-safe relay ordering.** A posts the `declined` message
  at most once per invitee per group. On receiving a decline DM, A: (1) checks B is
  still a pending member (DD-4) — if not, the decline is a no-op; (2) performs the
  Remove + posts `declined`; (3) clears the pending marker; (4) only then records
  the gift wrap in the processed/seen set. This ordering ensures a crash between
  receipt and the group post does not permanently lose the decline (the gift wrap
  is reprocessed on next start; B is still a pending member, so it retries). Because
  step 1 gates on tree membership, a duplicate/replayed decline after B is already
  removed is a clean no-op.

- **DD-8 — The `invited` producer must not fire on the excluded join-request flow.**
  The join-request / invite-link approval path (`approveJoinRequestImpl`) reuses the
  same `inviteByNpub` and already emits a `member_admitted` announcement. Hooking
  the `invited` producer *inside* `inviteByNpub` would emit a lifecycle message on
  the out-of-scope flow and double-announce. The producer is therefore placed at the
  direct-invite call site (`submitInviteWithMarker` / `InviteMemberModal`), or
  `inviteByNpub` is given a caller-supplied flag distinguishing the two entry points.

- **DD-9 — `accepted` fires only on B's own genuine join, not a relayed profile.**
  A's pending marker clears on *any* arrival of B's signed profile — including when a
  third member relays B's cached profile (the profile-request relay path), where B
  never processed the Welcome. Emitting `accepted` there would post a false, permanent
  "B accepted." Therefore `accepted` is gated on the profile rumor's MLS
  `senderPubkey` being B itself (B published its own profile into *this* group),
  representing a real join — not a relay by another member. This also prevents the
  marker-clear-by-relay from suppressing a later genuine decline (DD-4 validates
  against tree membership, not the marker).

- **DD-10 — Epoch-safe, deferred A-side relay.** `sendApplicationRumor` is only
  epoch-safe after the group's historical sync completes. A decline DM can arrive at
  app start before the referenced group is synced, so A defers the Remove + `declined`
  post until that group is synced, then executes DD-7's ordering. The deferred work is
  bounded, not an unbounded new list: the gift wrap is left **unmarked in the
  processed/seen set** until DD-7 step 4, so a decline for a never-syncing group is
  simply re-evaluated on each app start (and remains a clean no-op once B is no longer
  a pending member per DD-4/DD-7). No separate TTL queue is introduced; the existing
  gift-wrap reprocessing loop is the retry mechanism, and the "A left / group never
  syncs" case is the accepted no-op already covered in Known Limitations.

- **DD-11 — Immutability must also block edit-into-announcement and buffered
  signals.** Receive-side rejection keys on the target being an announcement, but two
  bypasses exist: (a) an edit whose *replacement content* parses as a non-image
  announcement would fabricate an immutable row at an old position — so edits are also
  rejected when the replacement content parses as a non-image structured message;
  (b) edit/delete signals that arrive before their target are buffered and applied on
  target arrival (`resolvePendingSignalsForSlot`, TTL-expiry materialization) — the
  announcement check (and the admin carve-out) must live at every apply site,
  including the deferred/pending resolution paths, not only the direct known-row
  branch.

## Scope

### In Scope

- A new `invite_lifecycle` `StructuredContent` variant with strict parsing.
- Producing the `invited` message on the **direct contact-invite** path only,
  gated so it does not fire on the join-request/invite-link flow (DD-8).
- Producing the `accepted` message on B's genuine own-join, gated on B being the
  actual profile sender (DD-9).
- The decline DM channel: B → gift-wrapped decline → A; A **evicts B (MLS Remove)**,
  posts a group `declined` message, and clears its pending marker — deferred until
  the group is synced, with crash-safe ordering (DD-7, DD-10).
- Carrying/deriving the MLS group id so the decline DM can reference the exact group
  A's state is keyed on (`PendingInvitation` stores no group id today; the pre-join
  reader must surface it, or it is stored at enqueue).
- Persisting an **`authenticated` boolean on the stored invitation** so the B-side
  decline send can honour the "skip when unauthenticated" gate. `PendingInvitation`
  (`app/src/lib/pendingInvitations.ts`) today stores only `id, inviterPubkeyHex,
  receivedAt, welcomeEventJson` — the authenticated/unauthenticated distinction is
  known only transiently at enqueue (`welcomeSubscription.ts`) and is not recoverable
  later. This is **new stored state** to be added at enqueue (same status as the
  `groupId` gap above), not a pre-existing field.
- Rendering the three events as inline informative chat announcements, author
  resolved from `senderPubkey`, text from i18n (en + de) keyed on the enum.
- Immutability with admin carve-out: UI suppression of edit/delete for the
  announcement family for non-admins; an admin moderation delete; receive-side
  rejection of non-admin edit/delete signals targeting announcements (including
  edit-into-announcement and buffered-signal paths, DD-11).
- Unit tests for parsing, the immutability predicates (incl. admin carve-out and
  replacement-content), the decline-identity/tree-membership gate, and the
  accepted-sender gate; an e2e groups spec (see S5 scope note).

### Out of Scope

- The invite-link / join-request flow (where B requests to join and A approves).
  The lifecycle messages apply only to the direct contact-invite flow this
  feature targets.
- Heavier cryptographic binding of the decline to B's identity at the group-
  message layer (DD-3 records this as a deliberate non-goal).
- Retroactively hardening the legacy `leave_intent` / `invite_cancelled` parse
  guards to canonical-hex (a pre-existing, separately-tracked gap; the new variant
  uses the strict guard regardless).
- Changing how acceptance clears A's pending marker (profile-arrival mechanism is
  unchanged; the `accepted` message is additive and separately gated per DD-9).
- Any change to the join-request/invite-link approval flow, including its existing
  `member_admitted` announcement.

## Technical Approach

### Type + parser — `app/src/lib/marmot/parseStructured.ts`

Add to the `StructuredContent` union:
```ts
| { type: 'invite_lifecycle'; event: 'invited' | 'accepted' | 'declined'; pubkey: string }
```
Add a strict, fail-closed guard branch:
```ts
if (
  parsed?.type === 'invite_lifecycle' &&
  (parsed.event === 'invited' || parsed.event === 'accepted' || parsed.event === 'declined') &&
  /^[0-9a-f]{64}$/.test(parsed.pubkey)
) {
  return { type: 'invite_lifecycle', event: parsed.event, pubkey: parsed.pubkey };
}
```

### Producers

- **invited** — placed at the **direct-invite call site** (`submitInviteWithMarker`
  / `InviteMemberModal.tsx:116-141`), NOT inside `inviteByNpub` (which the
  out-of-scope join-request flow reuses — DD-8). After a successful invite, send a
  kind-9 (`CHAT_MESSAGE_KIND`) application rumor with content
  `JSON.stringify({type:'invite_lifecycle', event:'invited', pubkey: inviteeHex})`
  via `sendApplicationRumor`, fire-and-forget (`.catch(()=>{})`), never blocking the
  invite.
- **accepted** — authored by **A**, gated per DD-9. A detects B's join when B's
  profile rumor arrives via `profileHandler`. Emit `accepted` only when that profile
  rumor's MLS `senderPubkey` **is B itself** (a genuine own-join into this group),
  and only on the first such transition (in-tree-pending → joined) so it fires at
  most once — do NOT emit on a profile *relayed* by a third member, nor on the
  generic marker removal (cancel/leave fan-out). This requires the profile-handling
  seam to expose "did this profile represent B's first genuine join" (e.g. a
  get-then-clear that reports whether a pending marker existed AND the sender was B),
  and a send capability injected into the handler via `registerHandlers.ts` (the
  handler has no send dep today — thread it through rather than importing ad hoc, to
  respect the module-boundary rule). If A is offline when B joins, A posts `accepted`
  when it next processes B's profile (B appears in the member list in real time
  regardless).

### Decline DM channel

- **B side** — `declinePendingInvitation` resolves the inviter's pubkey
  (`PendingInvitation.inviterPubkeyHex`, the authenticated seal author) and the MLS
  **group id** (not stored on `PendingInvitation` today — surface it from the
  Welcome via the pre-join reader, or persist it at enqueue; it must equal the id A
  keys its group state on). It then sends a NIP-59 gift-wrapped rumor of a new
  dedicated app-level inner kind (`INVITE_DECLINE_KIND`, distinct from 444 / 21059 /
  the pairing-ack kind — planner picks the number) addressed to A, carrying
  `{ groupId, pubkey: selfHex }`. Ephemeral sender key + encrypted = no profile
  metadata leaked (privacy invariant honoured). **Skip the send when the stored
  invitation was unauthenticated** (`authenticated: false`) — do not DM a decline to
  an attacker-chosen seal pubkey. This requires persisting an `authenticated` boolean
  on `PendingInvitation` at enqueue (new stored state — see In Scope; the field does
  not exist today). Local removal of the pending invitation is unchanged and must not
  depend on the send succeeding.
- **A side** — the existing kind-1059 gift-wrap subscription in
  `welcomeSubscription.ts` gains a branch for `INVITE_DECLINE_KIND`. On receipt:
  authenticate the inner seal (existing NIP-59 checks); resolve the referenced group
  and **defer until it is synced** (DD-10); verify the DM sender is currently a
  *pending* member of that group (DD-4, `isPendingMemberImpl`); then, in DD-7 order:
  (1) perform the MLS **Remove** of B (reusing the cancel-invite machinery, e.g.
  `cancelPendingInvitationImpl`) but emitting a `declined` `invite_lifecycle`
  announcement rather than `invite_cancelled`; (2) clear the pending-direct-invite
  marker for that invitee/group; (3) mark the gift wrap seen. If B is no longer a
  pending member (already joined, already removed, or A left), the decline is a
  clean no-op.

### Rendering — `app/src/components/chat/ChatBox.tsx`

Add an `invite_lifecycle` branch to `renderStructuredMessage` (near the existing
`leave_intent` / `member_admitted` branches, ~`ChatBox.tsx:472-598`) that resolves
the invitee (subject) display name from the payload `pubkey` (profileMap →
truncated-npub fallback, following `member_admitted`) and selects the copy string by
`event`. The *author* of the announcement is resolved from the protocol-verified
`senderPubkey` (mirroring `invite_cancelled`'s `resolveCancellerDisplay`), so a
forged announcement is attributed to its real poster, never to the named subject.
Render via a small presentational component (e.g.
`app/src/components/groups/InviteLifecycleChatAnnouncement.tsx`) modelled on
`LeaveChatAnnouncement.tsx` — muted background, one line, no avatar/bubble/action
affordances, a stable `data-testid`.

### i18n — `app/src/lib/i18n.ts`

Add three `Copy` keys (one per enum value) with matching `en` and `de` entries,
function-valued where a name is interpolated (e.g. `(name: string) => string`),
following the `leftGroup` precedent.

### Immutability

- **UI suppression (with admin carve-out)** — introduce a predicate "is an
  informative announcement" = `parseStructured(content)` is non-null AND its
  `type !== 'image'`. At the `canShowMessageActions` chokepoint
  (`messageActionUi.ts:44-51`) / its call site (`ChatBox.tsx:628`): for a non-admin
  viewer, suppress both Edit and Delete on such messages; for an admin viewer, show a
  Delete (moderation) but never an Edit. `image` stays fully deletable for its author.
  Edit is never offered on any announcement (already true via `canEditMessage`).
- **Receive-side rejection (with admin carve-out and bypass coverage)** — at every
  edit/delete apply site — `deleteEditHandler` / `applyDeleteEditSignal`, the
  tombstone application in `chatPersistence.ts`, AND the deferred/buffered resolution
  paths (`resolvePendingSignalsForSlot`, TTL-expiry materialization; DD-11) — drop
  the signal when the **target** message is an informative announcement UNLESS the
  signal's MLS `senderPubkey` is a current group admin. Additionally reject an
  edit whose **replacement content** parses as a non-image structured message,
  regardless of the target (prevents fabricating an immutable announcement in place
  of a plain message; DD-11). This makes immutability hold against a UI-bypassing
  client while preserving admin moderation.

## Privacy Invariant Compliance

- The decline DM is a NIP-59 gift wrap: addressed to A, encrypted, ephemeral
  sender key, carrying only `{ groupId, pubkey }` — no nickname/avatar/profile
  metadata. This is an addressed private message, not a broadcast.
- The three group announcements travel only over the group's MLS-encrypted
  channel to current members. No public kind-0, no unaddressed audience.

## Stories (indicative — final split authored by the story planner)

- **S1** — `invite_lifecycle` type + strict `parseStructured` guard +
  `senderPubkey`-based author resolution + unit tests.
- **S2** — `invited` producer (direct-invite call site, DD-8) + `accepted` producer
  (B-sender-gated, DD-9) + render branch + i18n + component.
- **S3** — decline DM channel: group-id surfacing + B send (auth-gated) + A
  receive/relay with MLS **Remove** of B + DD-4 tree-membership gate + DD-7 crash-safe
  ordering + DD-10 epoch-safe deferral + unit tests.
- **S4** — immutability: UI suppression predicate with admin carve-out +
  receive-side rejection at all apply sites incl. replacement-content and buffered
  paths + admin-sender exception + unit tests.
- **S5** — e2e groups spec (`groups-*.spec.ts`, relay bucket): drive invite→invited,
  accept→accepted, and invite→decline→declined→B-removed through the app UI in two
  browser contexts; assert edit/delete affordance **absence** for a non-admin and
  **presence** of the admin moderation delete. Receive-side rejection and forgery
  handling are **unit-test territory** (the publish-through-the-app rule means the app
  cannot itself emit a UI-bypassing edit/delete against an announcement, and
  hand-signing MLS group messages in the test process is forbidden) — S5 asserts only
  what the app-driven UI can observe. Pass gate is the full 60-test suite.

## Known Limitations (accepted)

- **Inviter-device-bound.** Only the device that sent the invite holds the pending
  marker / group-admin capability to emit `accepted` and relay `declined`. If A
  reinstalls, clears state, or invited from a different device, that device won't
  emit the lifecycle outcome. Acceptable.
- **`accepted` suppressed by a relay that precedes B's own-join.** `accepted` is
  gated on B's pending-direct-invite marker still existing at the moment B's own
  profile rumor arrives (DD-9). If a *third* member relays B's cached profile into
  the group *before* B's genuine own-join, the pre-existing marker-clearing
  mechanism (which this epic must not change — Non-Goals) clears the marker, so
  B's subsequent real join finds no marker and A posts no `accepted`. B still
  appears in the member list in real time and no false state is recorded; only the
  additive "joined" announcement is absent in this rare ordering. Accepted — the
  `accepted` message is additive and separately gated; hardening it would require
  changing the marker mechanism, which is out of scope.
- **A permanently offline / A left first.** If A never processes the decline DM (or
  left the group before it arrived), the decline is not relayed and B is not removed
  by A. B's decline still removed B's *local* invitation; the group simply never
  shows `declined`. Acceptable.
- **Re-invite after decline** is a fresh invite: B was removed from the tree, so a
  new `inviteByKeyPackageEvent` against a fresh KeyPackage re-adds B and emits a new
  `invited`. No special handling.
- **Forged announcements are removable only by admins.** A malicious member can post
  a forged (but correctly self-attributed) lifecycle/announcement message; per DD-5
  it is immutable to ordinary members and removable only by a group admin.
- **`declined` group announcement is best-effort.** Like `invited` (S2) and
  `accepted` (S3), the `declined` post is fire-and-forget: if it throws (e.g. relay
  unreachable) after the Remove has already committed, the Remove and the pending-
  invite marker-clear still take effect, but the group may never see the `declined`
  announcement. Accepted — the Remove is the durable, load-bearing action; the
  announcement is additive.
- **Multi-device decline race can evict a genuinely-joined member.** The invitee's
  pending-invitation record is stored per-device (localStorage). If B accepts the
  invite from device 1 but device 2 (which never saw the acceptance) declines
  before device 1's MLS profile rumor reaches A, A's tree-gate — which reads B as
  "in-tree, no profile yet" and therefore still pending — Removes B and posts
  `declined`, even though B genuinely joined. Last-action-wins between B's devices;
  accepted as out-of-scope for this single-device-focused epic. Coordinating
  invitation state across a single invitee's multiple devices is a separate
  concern.
- **A distinct-event-id replay of a stale decline, delivered after a re-invite,
  can spuriously re-evict the newly-invited member.** Mark-seen dedup (DD-7 step
  4) only guards against redelivery of the exact same gift-wrap event id; the
  decline's inner content (`{ groupId, pubkey }`) carries no per-invite nonce. If
  A re-invites the same pubkey after an earlier decline (a fresh Add — B is
  genuinely pending again) and a second gift wrap carrying the *same* decline
  content under a *different* event id is (re-)delivered afterward — e.g. relay
  replay, or a duplicate in flight that only lands post-re-invite — DD-4's
  tree-membership gate finds B pending and honours it exactly as a real decline,
  Removing the newly (re-)invited member. This is a structural consequence of
  AC-CROSS-1 itself (it requires a Remove whenever *some* delivery finds the
  invitee pending, and the gate has no way to bind a decline to the specific
  invite it answers) — same root cause as the multi-device race above (gate on
  live tree state, not per-decline identity), not a defect in this epic's
  implementation. Pinned by a dedicated adversarial test
  (`app/tests/unit/marmot/crossCuttingDeclineConvergence.test.ts`, `'[documented
  out-of-scope] a DISTINCT-eventId decline arriving AFTER a re-invite CAN
  reactivate'`). Accepted — closing it would require a decline-specific
  anti-replay nonce, out of scope for this epic.

## Non-Goals

- Do not add the lifecycle messages to the invite-link / join-request approval
  flow, and do not alter its existing `member_admitted` announcement.
- Do not add cryptographic per-message binding of the decline to B at the group-
  message layer (DD-3 / product-owner decision).
- Do not change the profile-arrival marker-clearing mechanism itself (the
  `accepted` emission is gated separately per DD-9).
- Do not broadcast any profile metadata to inform A — the decline DM carries a
  status code and pubkeys only.

## Amendments

- **2026-07-23 — Storage-primitive placeholder-supersession rule (AC-IMMUT-8,
  new).** S9's cross-cutting enumeration
  (`app/tests/unit/messageEdits/crossCuttingImmutabilityInvariance.test.ts`,
  the TTL-expiry × late-arriving-announcement-target scenario, VQ-S9-010)
  surfaced a genuine AC-IMMUT-6 bypass in S8's implementation: `appendMessage`
  (`chatPersistence.ts`) originally treated a TTL-expiry `materializedFromEdit`
  placeholder like any other row under its insert-if-absent dedup, so a
  genuine group announcement arriving afterward at that same message id was
  silently dropped — permanently suppressing an immutable announcement DD-11
  was meant to protect. Fixed (`chatPersistence.ts:341-404`) with a narrow
  carve-out: a `materializedFromEdit` row is replaced in place only when the
  new arrival is itself a non-`image` informative announcement; an ordinary
  arrival at that id remains a no-op, preserving any edit/tombstone already
  applied to the placeholder. This is DD-11's "every apply site, including
  buffered/deferred paths" requirement extended one layer down, to the
  storage append primitive itself — not a new design decision, a closed
  implementation gap in an existing one. Recorded as **AC-IMMUT-8** in
  `acceptance-criteria.md`.

- **2026-07-23 — Known Limitations: distinct-eventId decline replay after
  re-invite (new bullet, no code change).** S9's adversarial decline-
  convergence enumeration
  (`app/tests/unit/marmot/crossCuttingDeclineConvergence.test.ts`, the
  "DISTINCT-eventId decline arriving AFTER a re-invite" test) pinned a real,
  accepted product-behavior edge case that was not previously written up
  anywhere in this spec: a stale decline gift wrap replayed under a fresh
  event id, delivered after A re-invites the same pubkey, spuriously
  re-evicts the newly (re-)invited member — a structural consequence of
  AC-CROSS-1's own convergence requirement (Remove *must* fire whenever some
  delivery finds the invitee pending) combined with DD-4's tree-state gate
  carrying no per-decline identity. No behavior changed; this amendment only
  makes an already-accepted, already-tested edge case discoverable from the
  spec's Known Limitations section rather than only from the test file's
  comments.
