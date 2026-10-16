/**
 * reactionHandler.ts
 *
 * RumorHandler for kind-7 reaction rumors.
 *
 * Receives all side-effect dependencies via the deps bag injected at
 * buildDispatcher(deps) time — no React context imports.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';
import type { ReactionThreadKey } from '@/src/lib/reactions/types';

/** Named constant for the reaction rumor kind. */
export const REACTION_RUMOR_KIND = 7;

export interface ReactionHandlerDeps {
  loadMessages: (groupId: string) => Promise<{ messages: ChatMessage[]; refetchIds: string[] }>;
  applyInboundRumor: (
    thread: ReactionThreadKey,
    rumor: ApplicationRumor,
    sender: AuthenticatedSender,
  ) => Promise<unknown>;
  setReactionsVersion: (updater: (v: number) => number) => void;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ReactionHandlerDeps): Promise<void> {
  // Extract the e-tag to find the target message ID.
  const targetETag = rumor.tags?.find((t: string[]) => t[0] === 'e');
  const targetMessageId = targetETag?.[1];
  if (!targetMessageId) return; // malformed rumor — no e-tag, discard silently

  // Gate: only apply the reaction if the target message is known locally.
  // This prevents reactions for unknown messages from polluting the store
  // (silent discard per spec §2.4 / AC-39).
  //
  // Storage failures propagate (bug: reaction-storage-failures): a failed
  // loadMessages or applyInboundRumor throws, so the dispatcher keeps the
  // rumor journaled and it is handled again at the next subscription. That
  // replay is idempotent — applyInboundRumor dedups by rumor id against
  // stored rows, so a write that landed before reporting failure is a no-op.
  // Invalid input (no e-tag above, an unknown target, a rumor the store
  // discards) is NOT a failure: it completes and is acked, as before.
  const { messages: existingMessages } = await deps.loadMessages(ctx.groupId);
  const messageIsKnown = existingMessages.some((m: ChatMessage) => m.id === targetMessageId);
  if (!messageIsKnown) return; // silent discard

  const result = await deps.applyInboundRumor(
    { kind: 'group', groupId: ctx.groupId },
    rumor,
    sender,
  );

  if (result !== null) {
    deps.setReactionsVersion((v) => v + 1);
  }
}

export function createReactionHandler(deps: ReactionHandlerDeps): RumorHandler {
  return {
    kind: REACTION_RUMOR_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}
