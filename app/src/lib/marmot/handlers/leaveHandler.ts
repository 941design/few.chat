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
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';

export interface LeaveHandlerDeps {
  enqueueLeave: (groupId: string, pubkey: string) => void;
}

// ---- LEAVE_INTENT handler ---------------------------------------------------

function handleLeaveIntent(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: LeaveHandlerDeps): void {
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
  // Readiness-only (AC-MV-1): under the app-layer-only stub `sender.pubkey`
  // defaults to the claimed `rumor.pubkey` (or, via the dev-only test
  // override hook, whatever an attacker-controlled test injects) — so an
  // attacker who controls the rumor also controls `sender.pubkey` and can
  // still forge a matching pair today. This gate only becomes load-bearing
  // once the out-of-scope MLS sender-binding backbone (ADR-012) feeds a true
  // MLS-authenticated sender the attacker cannot set. Until then, forgery
  // still succeeds end-to-end (see spec.md `## Non-Goals`).
  if (payload.pubkey !== sender.pubkey.toLowerCase()) return;

  deps.enqueueLeave(ctx.groupId, payload.pubkey);
}

export function createLeaveIntentHandler(deps: LeaveHandlerDeps): RumorHandler {
  return {
    kind: LEAVE_INTENT_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handleLeaveIntent(rumor, ctx, sender, deps),
  };
}
