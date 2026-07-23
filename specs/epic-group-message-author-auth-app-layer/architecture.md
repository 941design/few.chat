# Architecture — Group Message Author Authentication (App Layer)

Operational document for all agents on this epic. Architecture is **decided by
ADR-012** (no debate); this file makes it concrete against the current code.

## Paradigm

Package-by-feature modular monolith with hexagonal seams at external boundaries.
The MLS receive path is a **pipeline**: `relay → group.on('applicationMessage')
→ applicationRumorDispatcher → per-kind RumorHandler → injected deps →
{chat store, poll store, reactions, edits, leave queue, profiles}`. Handlers are
pure over injected deps (boundary rule: **zero imports from `app/src/context/`**;
all side effects via a `deps` bag). Trust decisions converge at one **choke
point** (the dispatcher) plus one **ingest gate** for announcements (chatHandler
before `appendMessage`).

## The seam (central device)

The dispatcher resolves, **per message**, an authenticated-sender value and passes
it to handlers as a **sibling argument** (NOT a field on the per-group
`DispatcherContext`, which is created once per subscription and would be stale):

```ts
interface AuthenticatedSender {
  pubkey: string;                       // Nostr hex of the authenticated sender
  authenticity: 'claimed' | 'mls';      // 'claimed' under the stub; 'mls' under the backbone
}
// handler contract becomes:
handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender): Promise<void> | void
```

- **Resolver (app-side, throwaway scaffolding).** A closure bound per group in
  `MarmotContext.tsx` where `dispatcherCtx` + `buildDispatcher(...).subscribe(...)`
  are wired (~lines 1501–1612). Today it returns
  `{ pubkey: rumor.pubkey, authenticity: 'claimed' }`. A **dev-only override hook**
  (gated `NODE_ENV !== 'production'`, `window.__fewTest` precedent at
  `MarmotContext.tsx:777–786`) lets e2e/tests inject a divergent
  `{ pubkey, authenticity:'mls' }`.
- **Choke-point drop.** In the dispatcher listener, resolve the sender **after
  deserialize, before `markSeen`** (so a dropped rumor does not poison the
  dedup LRU) and before fan-out: if `rumor.pubkey !== sender.pubkey` → drop, emit a
  dev-log diagnostic (`unauthenticatedMessage`), do not `markSeen`, do not fan out.
  Under the stub this never fires.
- **When the backbone lands** it replaces the resolver + hook (the
  `applicationMessage` payload becomes `{ rumor, senderPubkey, senderLeafIndex }`,
  authenticity `'mls'`). Only the *dispatcher entry* changes; the handler layer
  reading `sender` is untouched — that is the migration payoff.

## Module map

| Module | Location | Owns | This epic |
|---|---|---|---|
| Dispatcher | `app/src/lib/marmot/applicationRumorDispatcher.ts` | listener, dedup, fan-out | add sender resolution + drop + threaded arg |
| Handlers | `app/src/lib/marmot/handlers/*.ts` | per-kind ingest | read `sender` for all attribution/authz |
| Structured parse | `app/src/lib/marmot/parseStructured.ts` | enum shapes | per-type actor rules; author from `sender` |
| Leave | `handlers/leaveHandler.ts`, `leaveSync.ts` | leave intent | `subject === sender` gate |
| Poll | `handlers/pollHandler.ts`, `pollSync.ts`, poll store | poll open/vote/close | bind creator to sender; recompute tally |
| Reactions (2nd hop) | `app/src/lib/reactions/api.ts` | reaction add/remove attribution | thread + authorize on `sender` |
| Edits (2nd hop) | `app/src/lib/messageEdits/api.ts` | delete/edit authz (own-author + admin) | thread + authorize on `sender` |
| Tombstone (3rd hop) | `app/src/lib/marmot/chatPersistence.ts` | tombstone re-check | inherits sender from edits module |
| Chat store | `chatHandler.ts` + `chatPersistence.ts` + `ChatStoreContext` | kind-9 rows, unread, versions | ingest gate before `appendMessage` |
| Admin/roster provider | `GroupAdminsProvider` (`messageEdits/api.ts`) + `MarmotContext.tsx` | admin set, live roster | reuse for actor rules + roster gate |
| Profiles (forwarded) | `profileSync.ts`, `handlers/profileHandler.ts`, `profileRequestSync.ts` | signed kind-0 envelope | one caller of the shared verifier |
| Shared verifier | new, generalizing `parseProfilePayload` | inner-envelope verification | per-kind binding policy |

## Boundary rules

- No direct imports across module boundaries; cross-module access only via declared
  deps/seam contracts. Handlers keep **zero `app/src/context/` imports**.
- **The authenticated sender is the ONLY trusted actor value.** No attribution or
  authorization may read `rumor.pubkey` (or payload `by`/`creatorPubkey`/`initiator`
  subject fields) as the actor. Enforced by a vitest source-scan over `handlers/`
  (precedent: `app/tests/unit/themes/zodBoundary.test.ts`) with an explicit
  allow-list for scoped non-attribution reads (the `chatHandler.ts:108` own-send
  echo guard). The scan is scoped to `handlers/` — `rumor.pubkey` reads elsewhere
  (`directMessages.ts`, `pairingAck.ts`, gift-wrap paths) are already
  seal-authenticated and must NOT be swept in. The two second-hop modules get
  targeted assertions instead (they legitimately reference `rumor` for other fields).
- **Preserve trust-model comments** (esp. `deleteEditHandler.ts:29–56`) until the
  backbone; they correctly state the value is claimed, not MLS-bound. The
  `authenticity` marker is the machine-readable form of that caveat.
- New user-facing strings (AC-SEND-10 error) go in `i18n.ts` `Copy` + both `en`/`de`
  (TS build enforces completeness); consumed via `useCopy()`.

## Per-type actor rules (the authorization table)

| Kind / type | Rule | Effect |
|---|---|---|
| chat (9) | attribute to `sender` | `ChatMessage.senderPubkey = sender.pubkey` (repoint `chatHandler.ts:86`) — every render site inherits the fix |
| reaction (7) | attribute add/remove to `sender` | via `applyInboundRumor` |
| edit/delete (5 + edit-marked 9) | authorize signal `sender` == target `sender`; admin-delete via provider | via `applyDeleteEditSignal` |
| poll_open (10) | `creatorPubkey := sender.pubkey` (ignore payload) | authenticated ownership |
| poll_vote (11) | attribute vote to `sender` | key `poll:voter` on `sender` |
| poll_close (12) | authorize `sender == stored creatorPubkey`; **recompute tally from stored votes** | closer's claimed counts ignored |
| leave_intent (13/21) | `payload.pubkey == sender.pubkey` | enqueue only self-departure |
| call_notice (23) | actor = `sender` (stop reading `initiator`) | actor-only |
| group_renamed (22) | admin actor (provider); display-only | metadata commit is authority |
| member_admitted (24) | admin actor; ingest roster-gate subject; display-only | **likely legacy — defensive rule only, no producer** |
| invite_lifecycle 'accepted' (30) | admin actor; ingest roster-gate subject; display-only | subject is a member at this point |
| invite_lifecycle 'invited'/'declined', invite_cancelled | admin actor; **NOT roster-gated** (subject not a member by design) | subject shown as unverified claim |
| profile (0) | inner-signed envelope; roster-EXEMPT | shared verifier; keyed to inner signer |
| profile_request (30-req) | choke-point drop only (target-driven auto-reply) | no separate handler logic |

**Ingest gate (announcements).** All enum announcements are kind-9 rows funneling
through `chatHandler.ts handle()`. Enforce the rule **before `deps.appendMessage`**
so a rejected announcement yields no row, no `setChatVersion` bump, no
unread/notification. Roster/admin facts via injected provider (async lookup inside
the handler is acceptable — `handle` already returns `Promise`). Self-authored
announcements bypass the dispatcher (local echo appends directly), so no
self-revalidation is needed.

## Order-Sensitive Composition

**Yes — this epic composes order-sensitive subsystems.** Correctness depends on
ordering, redelivery, and dedup:

- **Dispatch dedup + drop ordering** (Dispatcher). The mismatch drop MUST precede
  `markSeen` — otherwise a dropped rumor's id poisons the per-group LRU and a later
  legitimate redelivery of the same id is silently swallowed. Whole-flow guarantee:
  *a dropped rumor leaves no trace in dedup state.*
- **Poll tally recompute** (Poll). Recompute reads stored `PollVote` rows whose
  arrival order/completeness is not guaranteed (redelivery, missed votes). Guarantee:
  *the displayed tally is a pure function of the votes this client has stored, never
  of the closer's claimed counts* — eventual-consistency is accepted, forgeability is not.
- **Leave auto-commit debounce** (Leave → `MarmotContext.fireAutoCommit`). A queued
  removal fires 5 s later; the `subject === sender` gate is at enqueue time.
  Guarantee: *only a self-authored leave can enqueue a removal.*
- **Edit/delete reconciliation** (Edits). `resolvePendingSignalsForSlot` matches
  signals to a slot's original-author across arrival orders; authorization must key on
  the authenticated sender of both signal and target regardless of which arrived first.
- **Profile LWW** (Profiles). Merge is last-writer-wins by `updatedAt`; one-shot
  consumption for the verifier keys on the **inner event id**, order-independent.

Downstream gates (mutation, review) should treat these five flows as whole-flow
invariants, not per-line checks.

## Implementation constraints

- Go through `make` for build/test (platform stamp). `make test-unit` = vitest;
  `make test-e2e-all` = 60-test gate. No `lint`/`typecheck` make target exists.
- Handler-level attribution tests (AC-ATTR-6) call `handle(rumor, ctx, sender)`
  directly with `sender.pubkey ≠ rumor.pubkey` and assert the side effect uses
  `sender.pubkey` (pattern: `leaveHandler.test.ts`).
- e2e drives through the app + the dev seam, never raw WebSocket (CLAUDE.md).
- The signature change touches every handler wrapper + inner fn + all
  `app/tests/unit/marmot/*` handler/dispatcher tests + the two second-hop API
  signatures (`applyInboundRumor`, `applyDeleteEditSignal`) and their callers.
