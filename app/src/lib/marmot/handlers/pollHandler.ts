/**
 * pollHandler.ts
 *
 * RumorHandlers for POLL_OPEN_KIND (kind 10), POLL_VOTE_KIND (kind 11),
 * and POLL_CLOSE_KIND (kind 12), plus the history-sink group handlers.
 *
 * The apply logic itself is the shared poll core (../pollCore) — the same code
 * the effect-free recompute-on-retract runs. All side-effect dependencies are
 * injected — zero imports from app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND, parsePollOpen, parsePollVote, parsePollClose } from '@/src/lib/marmot/pollSync';
import type { ApplicationRumor, DispatcherContext, RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import { assertPorts, remainingSignals, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { applyPollOpen, applyPollVote, applyPollClose, type PollHandlerDeps } from '../pollCore';
import type { Poll } from '../pollPersistence';

export {
  replayPendingVotes,
  createHeldPollStateSweeper,
  createHeldCloseSettler,
  guardDeps,
  MaintenanceCancelled,
  type PollHandlerDeps,
} from '../pollCore';

/**
 * Deps of the history-sink path. `recomputePoll` is REQUIRED (an unwired port must fail at construction): the
 * store's one withdrawal entry point (pollPersistence.recomputePoll), see the module doc of pollFold.ts.
 */
export interface PollGroupHandlerDeps extends PollHandlerDeps {
  /**
   * REQUIRED on the sink path (the legacy path may omit it): a missing port must not silently skip the replay of
   * poll_close announcements held before their poll was known. Checked at construction (assertPorts).
   */
  replayHeldCloseAnnouncements: (poll: Poll, ctx: DispatcherContext) => Promise<void>;
  /**
   * Rebuilds the poll aggregate from the remaining kind-10/11/12 signals naming it. True iff the visible state changed.
   * `selfPubkeyHex` is the local account (the fold's context, as in a live dispatch).
   */
  recomputePoll: (groupId: string, pollId: string, signals: readonly RecomputeSignal[], selfPubkeyHex?: string, cancelled?: () => boolean) => Promise<boolean>;
  /**
   * The strictly increasing local receipt clock (pollPersistence.receiptNow): resolves a stamp not below `atLeast`.
   * A sink dispatch stamps its votes / held votes / held closes from the ROW's `receivedAt` through it, the same
   * clock `recomputePoll` folds the row with, instead of the wall clock at dispatch time.
   */
  receiptNow: (atLeast: number) => Promise<number>;
}

const POLL_GROUP_PORTS = [
  'savePoll', 'saveVoteIfNewer', 'getPoll', 'loadVotes',
  'queuePendingVote', 'loadPendingVotes', 'removePendingVotes',
  'queuePendingClose', 'loadPendingCloses', 'removePendingCloses',
  'setPollVersion', 'recomputePoll', 'receiptNow', 'replayHeldCloseAnnouncements',
] as const;

/** The poll a kind-10/11/12 rumor names, or null (not a poll rumor / unparsable). */
function pollIdOfRumor(rumor: { kind: number; content: string }): string | null {
  if (rumor.kind === POLL_OPEN_KIND) return parsePollOpen(rumor.content)?.id ?? null;
  if (rumor.kind === POLL_VOTE_KIND) return parsePollVote(rumor.content)?.pollId ?? null;
  if (rumor.kind === POLL_CLOSE_KIND) return parsePollClose(rumor.content)?.pollId ?? null;
  return null;
}

/**
 * The deps of ONE sink dispatch: every receipt stamp (a vote's `receivedAt`, a held vote's, a held close's) comes
 * from the row's persisted first-append time through the strictly increasing receipt clock, never from the wall
 * clock at dispatch time, so a late (recovered) dispatch orders exactly as `recomputePoll` folds the same row. A
 * dispatch whose input carries no row clock (a hand-built input) keeps the store's own stamping.
 */
function stampedFromRow(deps: PollGroupHandlerDeps, receivedAt: number | undefined): PollHandlerDeps {
  if (receivedAt === undefined || !Number.isFinite(receivedAt)) return deps;
  const stamp = () => deps.receiptNow(receivedAt);
  return {
    ...deps,
    saveVoteIfNewer: async (vote, opts) => deps.saveVoteIfNewer(vote.receivedAt === undefined ? { ...vote, receivedAt: await stamp() } : vote, opts),
    queuePendingVote: async (vote) => deps.queuePendingVote(vote, await stamp()),
    queuePendingClose: async (close) => deps.queuePendingClose(close, await stamp()),
  };
}

/**
 * Dispatches the poll core for the sink with the
 * MLS-authenticated sender. retract derives the poll id from the withdrawn
 * rumor, selects the remaining kind-10/11/12 rows naming that poll and has the
 * store recompute the aggregate from them (recompute-on-retract, AC-WDR-7);
 * the poll UI is bumped only when the store reports a visible change. A
 * `purged` retract (the group's data is being removed outright) folds nothing.
 */
function pollGroupHandler(
  factory: string,
  kind: number,
  apply: typeof applyPollOpen,
  deps: PollGroupHandlerDeps,
): GroupKindHandler {
  assertPorts(factory, deps, POLL_GROUP_PORTS);
  return {
    kind,
    async dispatch(input, env) {
      const { ctx, sender } = toHandlerArgs(input, env);
      await apply(input.rumor as ApplicationRumor, ctx, sender, stampedFromRow(deps, input.receivedAt));
    },
    // The aggregate a retract recomputes: one poll (open, votes and close share it). One recompute per poll and batch.
    retractKey(input) {
      if (input.reason === 'purged') return undefined;
      const pollId = pollIdOfRumor(input.rumor);
      return pollId ? `poll:${input.groupId}:${pollId}` : undefined;
    },
    async retract(input, env) {
      if (input.reason === 'purged') return;
      const pollId = pollIdOfRumor(input.rumor);
      if (!pollId) return;
      const signals = await remainingSignals(input, (rumor) => pollIdOfRumor(rumor) === pollId);
      const { cancelled } = input;
      if (cancelled?.()) return;
      const changed = await deps.recomputePoll(input.groupId, pollId, signals, env.selfPubkeyHex, ...(cancelled ? [cancelled] : []));
      if (changed && !cancelled?.()) deps.setPollVersion((v) => v + 1);
    },
  };
}

export const createPollOpenGroupHandler = (deps: PollGroupHandlerDeps) => pollGroupHandler('createPollOpenGroupHandler', POLL_OPEN_KIND, applyPollOpen, deps);
export const createPollVoteGroupHandler = (deps: PollGroupHandlerDeps) => pollGroupHandler('createPollVoteGroupHandler', POLL_VOTE_KIND, applyPollVote, deps);
export const createPollCloseGroupHandler = (deps: PollGroupHandlerDeps) => pollGroupHandler('createPollCloseGroupHandler', POLL_CLOSE_KIND, applyPollClose, deps);
