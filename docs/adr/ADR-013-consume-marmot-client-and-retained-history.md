# ADR-013 — Consume the Marmot client and its retained history

**Status** — Accepted for the Marmot library adoption

**Date** — 2026-11-18

**Supersedes** — The fork mechanism in [ADR-012](ADR-012-implement-spec-mandated-sender-binding-in-fork-plus-signed-enum-meta-events.md) and the marmot-ts protocol claims in [ADR-003](ADR-003-accept-last-writer-wins-for-mls-metadata-mutations-no-protocol-level-no-clobber-in-marmot-ts.md)

**Reaffirms** — ADR-003's application-level revision-clock rules for edits, deletes and other app-owned mutations

## Context

Few formerly owned its group transport, epoch replay and sender evidence around a patched MLS stack. The adopted Marmot client owns group commits, inbox subscription, authenticated group delivery, history withdrawal, and account storage. Few continues to own the app stores and their presentation.

## Decision

- Group application handlers attribute a message to the authenticated account in the retained history entry's `orderingKey.account`. The rumor's self-declared `pubkey` supplies no group authorization. Inbox handlers use the library's NIP-59 seal-bound `rumor.pubkey` after authentication.
- The history sink persists each accepted entry before applying its app effects. A withdrawal reverses or recomputes effects from surviving history. An own echo reconciles with the optimistic row by rumor ID. When the own echo is withdrawn, the row can be retried with the same rumor.
- Few uses the library's admin and membership APIs for roster and group metadata. When a rename or admin change reports `own-change-lost`, Few logs the outcome and refreshes the view from the current group state without a toast or a user-facing notice.
- Few applies the app-level revision clock to app messages, reactions and poll data. This decision leaves those convergence and authorization rules in the application.

The behavior and gate evidence are tracked in the [Marmot adoption epic](../../specs/epic-marmot-library-adoption/spec.md).
