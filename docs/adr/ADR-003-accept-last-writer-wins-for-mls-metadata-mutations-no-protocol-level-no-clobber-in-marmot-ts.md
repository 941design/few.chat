# ADR-003: Accept last-writer-wins for MLS metadata mutations (no protocol-level no-clobber in marmot-ts)

**Status**: Proposed
**Date**: 2026-06-12
**Type**: Lightweight
**Affects**: specs/epic-feature-request-admin-role-management-for-groups/, specs/epic-mls-fork-resolution/, specs/epic-feature-request-message-edit-and-delete/, project-wide
**Supersedes**: none
**Superseded in part by**: [ADR-013](ADR-013-consume-marmot-client-and-retained-history.md) for the marmot-ts-specific protocol claims. App-level revision clocks are reaffirmed.

## Context

MLS state in this app is mutated by reference from more than one member at
a time: an admin grant edits `adminPubkeys`, a rename edits the group name,
and (as of the message edit/delete work) a message author edits or tombstones
a conversation slot other members hold. These are metadata/application-layer
mutations layered on top of the MLS ratchet, not the ratchet commits
themselves.

marmot-ts provides **no protocol-level no-clobber mechanism** for these
mutations. Verified against marmot-ts master via source investigation
(marmot-researcher, 2026-06-11):

- `updateMetadata` does not enforce compare-and-set — it overwrites
  (admin-role spec §4.2 / `spec.md:75`).
- `commit()` has no relay awareness: two members who each read the same live
  epoch, mutate locally, and commit concurrently both observe `{ ok: true }`.
  The second commit to land silently drops the first mutation; the built-in
  epoch-conflict path never fires for the realistic same-epoch concurrent case
  (admin-role spec §4.2 amendment, `spec.md:395-402`).
- marmot-ts is alpha / pre-1.0 (MIPs at "Review"); a guardrail we build in the
  app is redundant-but-harmless if a future version adds one, and must be
  re-checked on upgrade (admin-role spec §4.6).

The only relay-visible object for gift-wrapped and MLS-enveloped content is
opaque to relays, so no relay-side arbitration is possible either. Ordering
therefore has to be resolved by the **application layer**, from data the
mutation itself carries.

## Decision

Accept **last-writer-wins** for MLS metadata and by-reference application
mutations. There is no protocol-level no-clobber; do not design as if there
were one.

- Conflicts are resolved at the application layer on an **explicit,
  self-reported revision value** carried by the mutation — a `rev` clock
  (real Unix-seconds wall time) for message edit/delete
  (edit-and-delete spec §4.7, D12), or the natural monotonic field for other
  metadata. Where a mutation reuses a wire field pinned for another purpose
  (e.g. an edit's `created_at` pinned to the original for in-place ordering),
  that field MUST NOT double as the revision clock — carry `rev` separately.
- Because the revision value is self-reported, the sender **clamps it
  monotonically per slot** (`rev = max(wallSeconds, last-known rev + 1)`,
  edit-and-delete spec D16) so a skewed device cannot pin state beyond the
  author's own later reach. Ties resolve by a **deterministic,
  content-independent key** (delete-wins over edit; else higher rumor id —
  edit-and-delete spec D15) so every recipient converges on the same result
  regardless of arrival order.
- A best-effort **read-live-then-merge-then-commit** guardrail is used where
  cheap (it prevents clobber whenever the live read already reflects the other
  mutation — admin-role spec `spec.md:410-416`), but it is a best-effort
  narrowing of the race window, **not** a correctness guarantee.
- Authorization is enforced separately and always: only the owning author may
  mutate their own reference (edit-and-delete AC-AUTH-2), independent of LWW
  ordering.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Protocol-level no-clobber / compare-and-set in marmot-ts | Does not exist in marmot-ts master; `commit()` has no relay awareness and `updateMetadata` overwrites. Not available to depend on. |
| "Losing commit retries and re-merges against the live set" (original AC-GRANT-7) | Requires relay-aware conflict detection marmot-ts does not provide; the epoch-conflict path never fires for the realistic same-epoch concurrent case, so the retry loop is unreachable (admin-role §4.2 amendment). |
| Relay-side arbitration | The relay-visible object is opaque ciphertext (MLS envelope / gift wrap); relays cannot order or arbitrate mutations. |

## Consequences

**Positive**: Ordering is deterministic and order-independent from data the
mutation carries — every recipient converges without coordination. The app
does not block on a protocol feature marmot-ts lacks. The edit/delete
`rev`-clock model, admin-grant resolution, and fork handling share one posture.

**Negative**: A losing concurrent mutation can be silently dropped (a losing
admin grant; an edit superseded by a same-second edit from another device).
Callers may see `{ ok: true }` for a mutation that was later clobbered. The
per-slot monotonic `rev` floor advances to the highest value any of the
author's own devices emitted (benign, self-healing).

**Accepted Risks**: True concurrent-mutation robustness (a real no-clobber
mechanism) is out of scope until marmot-ts provides one. Cross-user abuse is
prevented by author-pubkey authorization, not by the ordering model; self-device
clock skew is bounded only by the sender-side clamp, not eliminated.

## Evolution Triggers

Conditions under which this ADR should be reopened:

- If marmot-ts (or ts-mls) reaches a stable release that adds relay-aware
  conflict detection or a compare-and-set metadata primitive.
- If a concrete requirement appears that cannot tolerate a silently-dropped
  losing mutation (e.g. a security-relevant grant that must never be lost),
  making best-effort LWW insufficient.

## References

- Origin: curator-promoted from admin-role-management epic (S3 Codex review + marmot-researcher source investigation, 2026-06-11); direct via `/base:adr`. Decision content backfilled 2026-07-07 during the message edit/delete epic, which adds a third consumer.
- Related ADRs: none
- Related specs: specs/epic-feature-request-admin-role-management-for-groups/, specs/epic-mls-fork-resolution/, specs/epic-feature-request-message-edit-and-delete/
