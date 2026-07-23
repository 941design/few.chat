# Architecture — Group Invitation Lifecycle Chat Messages

## Paradigm

Modular monolith, package-by-feature, with hexagonal seams at the Nostr/MLS
transport boundary. This epic adds one new `StructuredContent` variant and wires
producers/consumers across existing modules; it introduces **no new top-level
subsystem**. The load-bearing discipline is respecting the existing module seams:
domain logic (`app/src/lib/marmot/*`) never reaches into React components, and
announcement *production* is wired at the page level (`pages/groups.tsx`) via an
injected `sendAnnouncement` callback — never emitted from inside the domain module.

## Module Map

| Module | Purpose | Location | Owned data |
|---|---|---|---|
| parse | `StructuredContent` union + strict `parseStructured` guard | `app/src/lib/marmot/parseStructured.ts` | the discriminated union + parse guards |
| render | inline announcement rendering + presentational component | `app/src/components/chat/ChatBox.tsx`, `app/src/components/groups/InviteLifecycleChatAnnouncement.tsx` (new) | render branch, data-testid |
| i18n | en/de copy keyed on the enum | `app/src/lib/i18n.ts` | 3 new `Copy` keys |
| invite-producer | emit `invited` on the direct-invite path only (DD-8) | `app/src/components/groups/InviteMemberModal.tsx` + `pages/groups.tsx` call site | wiring only |
| accept-producer | emit `accepted` on B's genuine own-join (DD-9) | `app/src/lib/marmot/profileHandler.ts` + `registerHandlers.ts` (send injection) | the pending→joined transition detector |
| decline-b | B-side: send gift-wrapped decline DM (auth-gated) | `app/src/lib/marmot/welcomeSubscription.ts` (`declinePendingInvitation`), `app/src/lib/pendingInvitations.ts` | new stored `groupId`, `authenticated` |
| decline-a | A-side: receive decline DM, defer, tree-gate, Remove B, post `declined` | `app/src/lib/marmot/welcomeSubscription.ts` (gift-wrap dispatch), `app/src/lib/marmot/cancelInvitationImpl.ts` (reuse Remove) | INVITE_DECLINE_KIND branch, seen-set ordering |
| immutability-ui | suppress delete on announcements for non-admins; admin moderation delete | `app/src/lib/messageEdits/messageActionUi.ts` + `ChatBox.tsx` call site | the "is informative announcement" predicate |
| immutability-receive | reject non-admin edit/delete signals targeting announcements at every apply site | `app/src/lib/messageEdits/api.ts` (`applyDeleteEditSignal`, buffered/pending paths), `app/src/lib/marmot/chatPersistence.ts` (tombstone) | the receive-side gate + admin exception |

## Boundary Rules

- No direct imports across module boundaries except through declared seam
  contracts. Domain (`lib/marmot/*`, `lib/messageEdits/*`) must not import React
  components.
- Announcement **production** is wired at the page level via the injected
  `sendAnnouncement` callback (`pages/groups.tsx` `ChatSendMessageCapture` →
  `sendAnnouncementRef`). The `invited` producer follows the `member_admitted`
  fire-and-forget-on-success precedent — it is NOT added inside `inviteByNpub`
  (DD-8: that function is reused by the out-of-scope join-request flow).
- The `accepted` producer needs a **send capability injected into
  `profileHandler`** via `registerHandlers.ts` (the handler has no send dep
  today). Thread it through the registration seam — do not import a sender ad hoc.
- Author attribution in the render path always resolves from the protocol-level
  MLS `senderPubkey` (via the `resolveCancellerDisplay` convention), never from a
  payload field. The subject (invitee) resolves from the payload `pubkey`.

## Seams

- **transport → parse**: `parseStructured(content)` is the single entry; the new
  branch must be strict/fail-closed (canonical-hex `pubkey`, enum `event`), object
  rebuilt from named fields (DD-6).
- **gift-wrap dispatch → decline-a**: new `INVITE_DECLINE_KIND` branch in
  `welcomeSubscription.ts` (slots after the join-request 21059 branch, before the
  kind-444 guard), reusing `unwrapGiftWrap`'s seal authentication (seal pubkey,
  never self-claimed `rumor.pubkey`).
- **decline-a → Remove**: reuse `cancelPendingInvitationImpl` (ADR-010's admin
  eviction path) but emit a `declined` `invite_lifecycle` announcement instead of
  `invite_cancelled`.
- **profile arrival → accept-producer**: the profile-handling seam must expose
  "did this profile represent B's first genuine own-join" — transport
  `senderPubkey === B` (own-publish, not a third-member relay) AND a
  pending→joined transition. Signed author is B in both relay and own-join cases;
  the transport sender is the distinguishing signal.
- **pre-join Welcome reader → decline-b**: surface the MLS `groupId` from
  `readWelcomeGroupInfo`'s `groupContext.groupId` (currently discarded by
  `readPreJoinGroupData`) and persist it (plus `authenticated`) on
  `PendingInvitation` at enqueue.

## Implementation Constraints

- **Privacy invariant (project-wide, non-negotiable):** the decline DM is a NIP-59
  gift wrap carrying only `{ groupId, pubkey }` — no nickname/avatar/profile
  metadata. Ephemeral sender key. Group announcements travel only over the group's
  MLS-encrypted channel. No public kind-0, no unaddressed audience.
- **ADR-006:** group inner-rumor `senderPubkey` is member-attested, not
  MLS-identity-bound. The admin carve-out authorizes on that self-asserted value —
  do not claim cryptographic enforcement. No new per-message binding (Non-Goal).
- **ADR-010:** the decline-Remove reuses the universal admin-only eviction path; A
  is an admin by virtue of having invited.
- **Strict guard for the new variant** — must use `/^[0-9a-f]{64}$/`, following
  `member_admitted`, not the loose `typeof === 'string'` guards flagged as a
  pre-existing latent throw.
- `INVITE_DECLINE_KIND` must be a fresh app-level inner kind, distinct from
  444 / 21059 / the pairing-ack kind (planner assigns the number).
- New stored state (`groupId`, `authenticated` on `PendingInvitation`) must be
  written at enqueue; the decline send is skipped when `authenticated: false`;
  local removal of the invitation must not depend on the send succeeding.

## Order-Sensitive Composition

**This epic composes order-sensitive subsystems. The whole-flow guarantees below
must hold across orderings, interleavings, redelivery, and crash-recovery.**

- **Flow: decline receipt → deferred relay → Remove + `declined` post → marker
  clear → seen-set mark (DD-7, DD-10).**
  - Participating modules: **decline-a** (`app/src/lib/marmot/welcomeSubscription.ts`),
    **decline-b** (`app/src/lib/pendingInvitations.ts`),
    the Remove reuse (`app/src/lib/marmot/cancelInvitationImpl.ts`).
  - Whole-flow guarantees:
    1. **At-most-once `declined` post per invitee per group.** The gift wrap is
       marked seen only *after* the Remove + post (DD-7 step 4), so a crash before
       the post triggers reprocessing on next start; the tree-membership gate
       (DD-4) makes a replay after B is already removed a clean no-op.
    2. **Epoch-safe deferral.** A decline DM arriving before the referenced group
       is synced defers the Remove+post until `onHistorySynced`, never advancing
       the MLS key schedule before pending commits are ingested. Bounded by the
       existing gift-wrap reprocessing loop, not a new unbounded queue (DD-10).
    3. **No lost decline across crash.** The unmarked-until-committed ordering plus
       tree-membership gate guarantees a decline is either applied exactly once or
       is a deliberate no-op (B already joined/removed/A left).

- **Flow: edit/delete signal application across direct, buffered, deferred, and
  TTL-expiry apply sites (DD-11).**
  - Participating modules: **immutability-receive**
    (`app/src/lib/messageEdits/api.ts`), the tombstone path
    (`app/src/lib/marmot/chatPersistence.ts`).
  - Whole-flow guarantees:
    1. **The announcement-immutability gate (and its admin carve-out) holds at
       EVERY apply site** — the direct known-row branch, the buffered
       `insertOrCollapsePending` resolution (`resolvePendingSignalsForSlot`), and
       the TTL-expiry materialization. A signal that arrives before its target
       must not bypass the gate when the target later materializes.
    2. **Edit-into-announcement is blocked** regardless of target: an edit whose
       replacement content parses as a non-image structured message is rejected
       (prevents fabricating an immutable row at an old position).

**Consequence for downstream gates:** the mutation gate (Step 5.7) and the FR-B1
order-sensitivity posture apply to `welcomeSubscription.ts`, `pendingInvitations.ts`,
`cancelInvitationImpl.ts`, `messageEdits/api.ts`, and `chatPersistence.ts` — a
surviving mutant or tool-failure in any of these is order-sensitive and not
silently ACCEPT-able.
