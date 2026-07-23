# ADR-006: Accept group-member-attested authorization for MLS application-message mutations

**Status**: Superseded
**Date**: 2026-07-07
**Type**: Lightweight
**Affects**: specs/epic-feature-request-message-edit-and-delete/, specs/epic-emoji-feature/, specs/epic-learning-groups-nostr-mls/, project-wide
**Supersedes**: none
**Superseded by**: ADR-012

> **Superseded 2026-07-23 by ADR-012.** The blocker this ADR was built around —
> no control over marmot-ts/ts-mls, so the spec-required sender check
> (`group-messaging.md:43`) was unimplementable — no longer holds: the project
> now controls the fork. ADR-012 implements the sender-binding check in the fork
> (closing the member-on-member impersonation this ADR accepted as interim risk)
> and adds signed enum meta-events for forwardable system messages. This ADR is
> retained for history; its accepted-risk posture no longer governs.

## Context

Message edit/delete (this epic) authorizes a receive-time mutation by
checking that the signal's author pubkey matches the target message's
author pubkey (AC-AUTH-2). For DMs this check is cryptographically
sound: the pubkey is bound to the sender via the gift-wrap seal's real
signature. For groups it is not: verified against ts-mls/marmot-ts
0.5.1 source (marmot-researcher, 2026-07-07), the library's
`applicationMessage` decrypt path returns only `{message: Uint8Array}`
and **drops the MLS sender-leaf credential** — proposals retain it,
application messages do not, and `unprotectPrivateMessage` is not
exported. The inner rumor's self-reported `pubkey` therefore cannot be
compared against the MLS-authenticated sending leaf. The Marmot
protocol spec itself requires this check
(`group-messaging.md:43`) — it is an unmet upstream requirement, not a
design choice available to this app.

Consequence: any current member of an MLS group can forge the inner
rumor's `pubkey` to impersonate another member's delete/edit signal.
This is not a new hole introduced by this epic — it is the **same**
trust model Few already applies, silently, to group kind-9 messages
and kind-7 reactions (a member can already forge those authorship
fields today). MLS still bars non-members entirely; the exposure is
member-on-member impersonation, not outsider access. DMs are
unaffected — the seal signature makes DM authorization real, not
self-asserted.

## Decision

Accept **group-member-attested authorization**: a group application
message (kind-9, kind-7, and now message edit/delete) is authorized on
its self-asserted inner rumor pubkey, not on a cryptographic binding to
the MLS-authenticated sender leaf, until marmot-ts/ts-mls surfaces that
leaf credential for application messages. MLS membership remains the
only cryptographically enforced boundary for groups; identity *within*
the member set is not.

- DM authorization is unaffected by this decision and remains fully
  seal-authenticated — this ADR narrows only the group case.
- The upstream gap is tracked at `BACKLOG.json#marmot-ts-0-5-1-drops`:
  get ts-mls/marmot-ts to expose the authenticated sender leaf
  credential pubkey for application messages, then verify
  `rumor.pubkey === senderCredentialPubkey` in
  `applicationRumorDispatcher` for all kinds. That fix closes the gap
  for kind-9/kind-7 as well as edit/delete in one place, since all
  three go through the same dispatcher.
- A `getGroupMembers` membership check was considered and rejected as a
  stopgap: it would not stop a member impersonating another *member*
  (the actual threat here — MLS already excludes non-members) and would
  create a false sense of security in the interim.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Block group edit/delete until marmot-ts exposes the sender leaf | Blocks a shipped, reviewed feature on an external library timeline for a trust model Few already accepts elsewhere (group kind-9/kind-7); no user-facing regression from shipping — the exposure is not new. |
| Add a `getGroupMembers` membership check as an interim mitigation | Does not address the actual threat (member impersonating another member); MLS already bars non-members. Adds surface area and a false sense of security without closing the gap. |
| Fork or patch ts-mls locally to surface the sender leaf | Out of scope for this epic; upstream fix is the correct long-term owner and is tracked separately. |

## Consequences

**Positive**: Message edit/delete ships for groups on schedule, on the
same documented trust posture the app already carries for group
messages and reactions — no new inconsistency introduced. The upstream
fix, when it lands, closes the gap for all three kinds
(kind-9/kind-7/edit-delete) through the single `applicationRumorDispatcher`
choke point, rather than needing three separate patches.

**Negative**: A malicious current group member can forge another
member's delete/edit signal (as they already can forge a kind-9 or
kind-7 authorship claim). This is a known, accepted, and now
explicitly documented limitation rather than a silent one.

**Accepted Risks**: Full MLS-identity binding for group application
messages is out of scope until marmot-ts/ts-mls ships the upstream fix
tracked at `BACKLOG.json#marmot-ts-0-5-1-drops`. Non-member access is
still fully prevented by MLS group membership; this ADR only concerns
identity claims *within* an already-admitted member set.

## Evolution Triggers

Conditions under which this ADR should be reopened:

- When marmot-ts/ts-mls surfaces the MLS-authenticated sender leaf
  credential for application messages, closing
  `BACKLOG.json#marmot-ts-0-5-1-drops` — `applicationRumorDispatcher`
  should then verify `rumor.pubkey === senderCredentialPubkey` for all
  kinds, and this ADR's status should move to Superseded.
- If a concrete requirement appears that cannot tolerate member-on-member
  impersonation even for the interim (e.g. a compliance or safety
  requirement for a specific group type), making the accepted-risk
  posture insufficient for that surface.

## References

- Origin: curator-promoted, `base:project-curator` run for
  specs/epic-feature-request-message-edit-and-delete/ (2026-07-07),
  from the S5-review product decision recorded in
  specs/epic-feature-request-message-edit-and-delete/spec.md
  `## Amendments` (2026-07-07 AC-AUTH-2 entry) and
  acceptance-criteria.md AC-AUTH-2.
- Related ADRs: ADR-003 (last-writer-wins for MLS metadata mutations —
  a sibling decision on the same "marmot-ts provides less protocol
  guarantee than the app would like" axis; ADR-003 covers ordering,
  this ADR covers authorization; they are independent and both apply
  to the same edit/delete feature).
- Related specs: specs/epic-feature-request-message-edit-and-delete/,
  specs/epic-emoji-feature/ (kind-7 reactions carry the same unverified
  trust), specs/epic-learning-groups-nostr-mls/ (kind-9 group messages
  carry the same unverified trust).
