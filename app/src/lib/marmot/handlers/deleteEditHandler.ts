/**
 * deleteEditHandler.ts
 *
 * RumorHandler for kind-5 delete/edit signal rumors (group transport) — Seam
 * S5 consumer of S3's reconciliation core (applyDeleteEditSignal) and S2's
 * wire-builder constant (DELETE_EDIT_RUMOR_KIND).
 *
 * Receives all side-effect dependencies via the deps bag injected at
 * buildDispatcher(deps) time — no React context imports (architecture.md
 * boundary rule, ownership-ledger.json concept id 'handler-no-context-import').
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 *
 * ─── Deliberately NO pre-gate (unlike reactionHandler.ts's known-target gate) ─
 *
 * reactionHandler.ts silently discards a kind-7 reaction whose target message
 * is not yet known locally (a known-target gate BEFORE calling into the
 * reactions core). This handler does the OPPOSITE for kind-5: every inbound
 * rumor is routed to `applyDeleteEditSignal` UNCONDITIONALLY, with no
 * known-target check here at all. S3's `applyDeleteEditSignal` already
 * implements retain-and-apply for an unknown target (AC-ORDER-1: it buffers
 * the signal in its own pending store and applies it once the target
 * arrives) — architecture.md is explicit that this retain logic belongs
 * inside the shared reconciliation module, not reimplemented per-caller, so
 * adding a gate here would silently discard a signal S3 was built to retain.
 *
 * ─── The forwarded pubkey is the INNER rumor pubkey (NOT the kind-445 author) ─
 * ─── and it is now MLS-identity-bound: the authenticated sender (see below) ───
 *
 * This handler forwards the authenticated `sender` (AuthenticatedSender) to
 * `applyDeleteEditSignal`, which authorizes on `sender.pubkey`. That
 * `sender.pubkey` is the MLS-authenticated transport sender: marmot-ts 0.7.0
 * resolves it from the group's ratchet-tree credential and drops any
 * claimed-vs-authenticated mismatch before fan-out. That inner
 * pubkey is never the kind-445 wrapper's ephemeral author
 * (learning `kind-445-events-have-ephemeral-authors`).
 * `applicationRumorDispatcher.ts`'s listener calls `deserializeApplicationData`
 * on the MLS-decrypted application-message bytes and hands EVERY registered
 * handler that decoded rumor object directly — the kind-445 wrapper event
 * (with its ephemeral author) is never exposed past that point. `chatHandler.ts`
 * and `reactionHandler.ts` already rely on this identically.
 *
 * Trust model (marmot-ts 0.7.0 authenticated-sender forks — see the `ts-mls`
 * and `@internet-privacy/marmot-ts` git pins in app/package.json): this inner
 * `pubkey` IS cryptographically bound to the MLS sender. The library resolves
 * the authenticated sender leaf credential during unprotect and enforces that
 * the rumor's claimed `pubkey` matches it, dropping any mismatch (and
 * undeserializable bytes) before the message is delivered. So AC-AUTH-2's
 * group clause here is genuinely MLS-authenticated: a malicious current member
 * can no longer forge `pubkey` to impersonate another member — the
 * sender-leaf-drop gap (formerly `BACKLOG.json#marmot-ts-0-5-1-drops`) is
 * closed by the marmot-ts-authenticated-sender-migration epic (ADR-012).
 * DMs remain independently seal-signature bound.
 */

import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';
import type { ChangeResult, InboundDeleteEditRumor, MessageEditsThreadKey } from '@/src/lib/messageEdits/api';
import { DELETE_EDIT_RUMOR_KIND } from '@/src/lib/messageEdits/rumor';

/** Kind-5 rumor kind, narrowed to its literal type for `RumorHandler<5>`. */
const KIND: 5 = DELETE_EDIT_RUMOR_KIND as 5;

export interface DeleteEditHandlerDeps {
  applyDeleteEditSignal: (thread: MessageEditsThreadKey, rumor: InboundDeleteEditRumor, sender: AuthenticatedSender) => Promise<ChangeResult>;
  /**
   * Reused, not duplicated: the SAME setter chatHandler.ts already receives
   * via HandlerDeps (architecture.md seam #3's explicit 'reuse setChatVersion'
   * allowance). Bumping it triggers ChatStoreContext's existing chatVersion
   * re-read effect, which now also re-filters/reconciles storage truth
   * (`reconcileMessagesWithStorage`, ChatStoreContext.tsx).
   */
  setChatVersion: (updater: (v: number) => number) => void;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: DeleteEditHandlerDeps): Promise<void> {
  const thread: MessageEditsThreadKey = { kind: 'group', groupId: ctx.groupId };

  // Storage failures propagate (bug: reaction-storage-failures): the
  // dispatcher then keeps the rumor journaled and handles it again at the
  // next subscription. applyDeleteEditSignal is replay-safe — a re-buffered
  // signal dedups by rumor id, a re-applied one no-ops on the slot's
  // recorded rumor id or re-writes the same tombstone/content at the same
  // rev. Invalid input never throws: it resolves 'discarded' / 'pending'.
  try {
    await deps.applyDeleteEditSignal(thread, rumor as InboundDeleteEditRumor, sender);
  } finally {
    // S5 gate-remediation (finding 5): bump unconditionally for ANY
    // outcome, not only 'delete'/'edit'. applyDeleteEditSignal's sweep
    // (sweepExpiredForThreadKeyLocked, run at the top of every call) can
    // self-heal/materialize OTHER slots' storage as a side effect of
    // processing THIS rumor — mutations that are otherwise invisible to
    // ChatStoreContext until some later, unrelated chatVersion bump happens to
    // trigger its reconcile re-read. That includes a call that failed part
    // way, after some of those writes landed. A spurious bump is a cheap,
    // idempotent re-read (reconcileMessagesWithStorage is a no-op when
    // nothing actually changed).
    deps.setChatVersion((v) => v + 1);
  }
}

export function createDeleteEditHandler(deps: DeleteEditHandlerDeps): RumorHandler<5> {
  return {
    kind: KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}
