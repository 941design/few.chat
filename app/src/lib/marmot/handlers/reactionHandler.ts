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
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RecomputeSignal, RumorHandler } from '@/src/lib/marmot/handlers/types';
import type { ReactionThreadKey } from '@/src/lib/reactions/types';
import { assertPorts, remainingSignals, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import type { GroupRumorInput, RetractInput } from '@/src/lib/marmot/history';

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

/**
 * Old-dispatcher-path handler. TEMPORARY: kept so the existing suites and the
 * old `buildDispatcher` stay green until the context cut-over (S18); removed by
 * S22. New code uses `createReactionGroupHandler`.
 */
export function createReactionHandler(deps: ReactionHandlerDeps): RumorHandler {
  return {
    kind: REACTION_RUMOR_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}

/** Deps of the history-sink path; the recompute and hold ports are REQUIRED (an unwired port must fail at construction). */
export interface ReactionGroupHandlerDeps extends ReactionHandlerDeps {
  /**
   * Recomputes every reaction of one message from the surviving kind-7 signals (the withdrawn rumor's own effect,
   * own or another member's, is simply absent from them). Resolves true iff a visible reaction changed.
   */
  recomputeMessageReactions: (thread: ReactionThreadKey, targetMessageId: string, signals: readonly RecomputeSignal[]) => Promise<boolean>;
  /** Keeps a reaction whose target message is not stored yet, until it lands. */
  holdReaction: (thread: ReactionThreadKey, rumor: ApplicationRumor, sender: AuthenticatedSender) => Promise<void>;
  /** Applies the held reactions of a message that is now stored; true iff one changed the visible state. */
  releaseHeldReactions: (thread: ReactionThreadKey, messageId: string) => Promise<boolean>;
}

async function targetIsStored(deps: ReactionHandlerDeps, groupId: string, messageId: string): Promise<boolean> {
  const { messages } = await deps.loadMessages(groupId);
  return messages.some((m: ChatMessage) => m.id === messageId);
}

/**
 * Sink-path dispatch. A reaction whose target is stored is applied at once; one
 * whose target has not landed is HELD (not dropped) and applied when the target
 * arrives. The target is re-checked after the hold: it may have landed between
 * the first check and the hold, in which case nothing else would release it.
 */
async function dispatchGroup(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ReactionGroupHandlerDeps): Promise<void> {
  const targetMessageId = rumor.tags?.find((t: string[]) => t[0] === 'e')?.[1];
  if (!targetMessageId) return; // malformed rumor — no e-tag
  const thread: ReactionThreadKey = { kind: 'group', groupId: ctx.groupId };

  if (await targetIsStored(deps, ctx.groupId, targetMessageId)) {
    if ((await deps.applyInboundRumor(thread, rumor, sender)) !== null) deps.setReactionsVersion((v) => v + 1);
    return;
  }

  await deps.holdReaction(thread, rumor, sender);
  if (await targetIsStored(deps, ctx.groupId, targetMessageId)) {
    if (await deps.releaseHeldReactions(thread, targetMessageId)) deps.setReactionsVersion((v) => v + 1);
  }
}

/**
 * Kind-7 handler on the history-sink path (sender = the MLS-authenticated
 * account). dispatch is idempotent (the store dedups by rumor id) and never
 * throws for a missing target (see `dispatchGroup`). retract RECOMPUTES the
 * target message's reactions from the surviving kind-7 rows and bumps the
 * reactions version only when a visible reaction changed.
 */
export function createReactionGroupHandler(deps: ReactionGroupHandlerDeps): GroupKindHandler & RumorHandler {
  assertPorts('createReactionGroupHandler', deps, [
    'loadMessages',
    'applyInboundRumor',
    'setReactionsVersion',
    'recomputeMessageReactions',
    'holdReaction',
    'releaseHeldReactions',
  ]);
  return {
    ...createReactionHandler(deps),
    async dispatch(input: GroupRumorInput, env) {
      const { ctx, sender } = toHandlerArgs(input, env);
      await dispatchGroup(input.rumor as ApplicationRumor, ctx, sender, deps);
    },
    // The aggregate a retract recomputes: every reaction of one target message. One recompute per target and batch.
    retractKey(input: RetractInput) {
      if (input.reason === 'purged') return undefined;
      const target = (input.rumor as ApplicationRumor).tags?.find((t: string[]) => t[0] === 'e')?.[1];
      return target ? `reactions:${input.groupId}:${target}` : undefined;
    },
    async retract(input: RetractInput, env) {
      // A purged group is going away whole: nothing to recompute (the group-leave purge removes the rest).
      if (input.reason === 'purged') return;
      const { ctx } = toHandlerArgs(input, env);
      const target = (input.rumor as ApplicationRumor).tags?.find((t: string[]) => t[0] === 'e')?.[1];
      if (!target) return; // malformed rumor: dispatch discarded it, nothing to undo
      const signals = await remainingSignals(input, (rumor) => rumor.kind === REACTION_RUMOR_KIND);
      const changed = await deps.recomputeMessageReactions({ kind: 'group', groupId: ctx.groupId }, target, signals);
      if (changed) deps.setReactionsVersion((v) => v + 1);
    },
  };
}
