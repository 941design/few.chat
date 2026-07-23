/**
 * profileRequestHandler.ts
 *
 * RumorHandler for PROFILE_REQUEST_KIND (kind 30).
 *
 * Mirrors the PROFILE_REQUEST_KIND branch of MarmotContext.onApplicationMessage.
 * All side-effect dependencies are injected — zero imports from
 * app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { PROFILE_REQUEST_KIND, parseProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import type { ProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';

export interface ProfileRequestHandlerDeps {
  /** AC-032: record every observed request regardless of target. */
  recordRequestEmitted: (groupId: string, targetPubkey: string, timestamp: number) => Promise<void>;
  /**
   * AC-030: self-target reply — called when request.targetPubkey === ctx.selfPubkeyHex.
   * MarmotContext provides this as a closure that signs our current profile and
   * calls sendRumorSafe on the mlsGroup.
   */
  sendSelfProfile: (groupId: string) => Promise<void>;
  /**
   * AC-031: relay path — called when request.targetPubkey !== ctx.selfPubkeyHex.
   * MarmotContext provides this as a pre-bound closure (loadProfile + sendRumor
   * already captured from context scope).
   */
  handleIncomingProfileRequest: (args: {
    groupId: string;
    payload: ProfileRequestPayload;
  }) => Promise<void>;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ProfileRequestHandlerDeps): Promise<void> {
  const reqPayload = parseProfileRequestPayload(rumor.content);
  if (!reqPayload) return;

  // AC-032: record every observed request for deduplication across the group.
  await deps.recordRequestEmitted(ctx.groupId, reqPayload.targetPubkey, Date.now());

  if (reqPayload.targetPubkey === ctx.selfPubkeyHex) {
    // AC-030: we are the target — reply immediately with our current profile.
    await deps.sendSelfProfile(ctx.groupId);
  } else {
    // AC-031: not our target — delegate to relay handler (AC-033/034).
    await deps.handleIncomingProfileRequest({
      groupId: ctx.groupId,
      payload: reqPayload,
    });
  }
}

export function createProfileRequestHandler(deps: ProfileRequestHandlerDeps): RumorHandler {
  return {
    kind: PROFILE_REQUEST_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}
