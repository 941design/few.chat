/**
 * leaveHandler.ts
 *
 * RumorHandler for LEAVE_INTENT_KIND (kind 13).
 *
 * Mirrors pollHandler.ts. All side-effect dependencies are injected —
 * zero imports from app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All state-mutation deps received via injection
 */

import { LEAVE_INTENT_KIND, parseLeaveIntent } from '@/src/lib/marmot/leaveSync';
import type { ApplicationRumor, AuthenticatedSender, DispatchMeta, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';

export interface LeaveHandlerDeps {
  /**
   * May return a promise (MarmotContext: the durable write of the pending
   * removal). The handler returns it, so the dispatcher acks the leave rumor's
   * journal entry only after the write landed, and keeps the entry for replay
   * when it rejects (bugs: pending-member-removals-not-persisted,
   * journal-ack-before-durable-side-effects). `rumorId` lets the enqueue read
   * the sender's leaf identity journaled at first receipt; `replayed` (from
   * the dispatcher) makes a replayed leave without such an identity a skip,
   * never a check against the member's current leaf (bug:
   * journal-replayed-leave-evicts-rejoined-member; pendingRemovalStorage
   * recordLeaveIntent).
   */
  enqueueLeave: (groupId: string, pubkey: string, rumorId: string, meta: DispatchMeta) => void | Promise<void>;
}

// ---- LEAVE_INTENT handler ---------------------------------------------------

function handleLeaveIntent(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: LeaveHandlerDeps, meta: DispatchMeta | undefined): void | Promise<void> {
  const payload = parseLeaveIntent(rumor.content);
  if (!payload) return;

  // Forced-removal rule (AC-FORCE-3): payload.pubkey (the leave subject) is
  // read from the message BODY and is self-declared by whoever sent the
  // rumor — it must NEVER be trusted as-is. A leave_intent may only enqueue
  // a removal when its subject equals the message's AUTHENTICATED sender
  // (`sender`, the S1 seam), i.e. only a self-departure enqueues a removal.
  // A leave_intent naming a different member (subject !== sender) is
  // silently dropped here: no enqueueLeave call, no departure side effect.
  //
  // Load-bearing (ADR-012 backbone landed — epic
  // marmot-ts-authenticated-sender-migration): `sender.pubkey` is now the
  // MLS-authenticated transport sender that marmot-ts 0.7.0 resolves from the
  // group's ratchet-tree credential, not the claimed `rumor.pubkey`. The
  // library drops any message whose claimed pubkey != the authenticated sender
  // before the dispatcher sees it, so an attacker cannot set `sender.pubkey`
  // to a member they are not. A leave_intent naming a different member
  // (subject !== authenticated sender) therefore cannot be forged: it is
  // dropped here with no departure side effect.
  if (payload.pubkey !== sender.pubkey.toLowerCase()) return;

  return deps.enqueueLeave(ctx.groupId, payload.pubkey, rumor.id, { replayed: meta?.replayed === true });
}

export function createLeaveIntentHandler(deps: LeaveHandlerDeps): RumorHandler {
  return {
    kind: LEAVE_INTENT_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, meta?: DispatchMeta) => handleLeaveIntent(rumor, ctx, sender, deps, meta),
  };
}
