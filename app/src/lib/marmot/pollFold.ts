/**
 * pollFold.ts — the effect-free fold of recompute-on-retract.
 *
 * `foldPollSignals` rebuilds ONE poll aggregate (the poll row, its votes with
 * superseded snapshots, its held votes and held closes) by running the SAME
 * apply core as dispatch (pollCore: applyPollOpen / applyPollVote /
 * applyPollClose) over in-memory storage ports that apply the SAME pure store
 * rules as the IDB stores (pollStoreCore). There is no second implementation of
 * the open / vote / close authorisation or of the vote order.
 *
 * Effect-free by construction: the ports are memory-only, the poll-version
 * setter is a no-op and no held close-announcement replay is wired, so a fold
 * can neither announce a close nor bump a bell / unread / notification.
 *
 * Deterministic: the receipt clock of the fold is the persisted `receivedAt`
 * of the row being folded (kept strictly increasing, like receiptNow), so "this
 * vote arrived before that close" is decided by the history, not by the wall
 * clock at recompute time. A row whose receivedAt is not finite stamps one
 * tick (+1) after the previous stamp of the fold, so it still follows `seq`
 * order; only when no earlier stamp exists in the fold does it fall back to the
 * wall clock (Date.now()), the one non-deterministic case. Held entries expire
 * relative to that same clock.
 *
 * Contribution identity is (rumor id, sender): each signal carries its own
 * authenticated sender and is judged on its own — a byte-identical copy of a
 * rumor from another sender is a different contribution.
 */

import type { Poll, PollVote, PendingPollVote, PendingPollClose } from './pollPersistence';
import type { RecomputeSignal, ApplicationRumor } from '@/src/lib/marmot/handlers/types';
import { applyPollOpen, applyPollVote, applyPollClose, type PollHandlerDeps } from './pollCore';
import { parsePollOpen, parsePollVote, parsePollClose, POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND } from './pollSync';
import {
  addBoundedEntry,
  dropSuperseded,
  isPendingCloseShaped,
  isPendingShaped,
  liveCloseCutoffs,
  liveEntries,
  mergeVoteRows,
  queueVoteEntries,
  samePendingVote,
  upsertOpenPoll,
  writeClosedPoll,
} from './pollStoreCore';

/** The group-level state a fold starts from (the poll itself and its holds are reset by the fold). */
export interface PollFoldBase {
  /** All stored polls of the group (the folded poll is replaced in place, the others stay). */
  polls: readonly Poll[];
  /** The group's whole held-vote queue (other polls' entries stay and count against the caps). */
  pendingVotes: readonly PendingPollVote[];
  /** The group's whole held-close queue. */
  pendingCloses: readonly PendingPollClose[];
}

export interface PollFoldResult {
  polls: Poll[];
  /** The poll's vote rows. */
  votes: PollVote[];
  pendingVotes: PendingPollVote[];
  pendingCloses: PendingPollClose[];
}

/** The poll a kind-10/11/12 rumor names, or null. */
function pollIdOf(rumor: ApplicationRumor): string | null {
  if (rumor.kind === POLL_OPEN_KIND) return parsePollOpen(rumor.content)?.id ?? null;
  if (rumor.kind === POLL_VOTE_KIND) return parsePollVote(rumor.content)?.pollId ?? null;
  if (rumor.kind === POLL_CLOSE_KIND) return parsePollClose(rumor.content)?.pollId ?? null;
  return null;
}

export async function foldPollSignals(
  groupId: string,
  pollId: string,
  base: PollFoldBase,
  signals: readonly RecomputeSignal[],
  selfPubkeyHex = '',
): Promise<PollFoldResult> {
  // Reset the aggregate: the poll row (remembering its slot), its votes, its held votes and closes.
  const slot = base.polls.findIndex((p) => p.id === pollId);
  const state: PollFoldResult = {
    polls: base.polls.filter((p) => p.id !== pollId),
    votes: [],
    pendingVotes: base.pendingVotes.filter((e) => !(isPendingShaped(e) && e.pollId === pollId)),
    pendingCloses: base.pendingCloses.filter((e) => !(isPendingCloseShaped(e) && e.pollId === pollId)),
  };

  // Receipt clock: the row's persisted receivedAt, strictly increasing across stamps.
  let last = -Infinity;
  let rowAt = -Infinity;
  const stamp = (): number => {
    const t = Math.max(rowAt, last + 1);
    last = Number.isFinite(t) ? t : Date.now();
    return last;
  };
  const now = (): number => (Number.isFinite(last) ? last : Date.now());

  const deps: PollHandlerDeps = {
    savePoll: async (poll) => {
      if (!poll.closed) {
        state.polls = upsertOpenPoll(state.polls, poll);
        return poll;
      }
      const result = writeClosedPoll(state.polls, poll);
      state.polls = result.list;
      if (result.stored === null) return null;
      state.votes = dropSuperseded(state.votes); // a closed poll's superseded snapshots are dead weight
      return result.stored;
    },
    getPoll: async (_g, id) => state.polls.find((p) => p.id === id) ?? null,
    loadVotes: async (g, id) => state.votes.filter((v) => v.groupId === g && v.pollId === id),
    saveVoteIfNewer: async (vote, opts) => {
      const stamped: PollVote = vote.receivedAt === undefined ? { ...vote, receivedAt: stamp() } : vote;
      if (opts?.requirePoll && !state.polls.some((p) => p.id === vote.pollId)) return false;
      let next = mergeVoteRows(state.votes, stamped, null);
      if (next === 'need-cutoffs') next = mergeVoteRows(state.votes, stamped, liveCloseCutoffs(state.pendingCloses, vote.pollId, now()));
      if (next === 'unchanged' || next === 'need-cutoffs') return false;
      state.votes = next;
      return true;
    },
    queuePendingVote: async (vote) => {
      const at = stamp();
      const entries = liveEntries(state.pendingVotes, isPendingShaped, at);
      let result = queueVoteEntries(entries, vote, at, null);
      if (result === 'need-cutoffs') result = queueVoteEntries(entries, vote, at, liveCloseCutoffs(state.pendingCloses, vote.pollId, at));
      if (result === 'need-cutoffs') return false;
      state.pendingVotes = result.stored;
      return result.held;
    },
    loadPendingVotes: async (_g, id) => liveEntries(state.pendingVotes, isPendingShaped, now()).filter((e) => e.pollId === id),
    removePendingVotes: async (_g, applied) => {
      state.pendingVotes = liveEntries(state.pendingVotes, isPendingShaped, now()).filter((e) => !applied.some((a) => samePendingVote(a, e)));
    },
    queuePendingClose: async (close) => {
      const at = stamp();
      const entries = liveEntries(state.pendingCloses, isPendingCloseShaped, at);
      state.pendingCloses = addBoundedEntry(entries, { ...close, receivedAt: at }, (e) => e.closerPubkey);
    },
    loadPendingCloses: async (_g, id) => liveEntries(state.pendingCloses, isPendingCloseShaped, now()).filter((e) => e.pollId === id),
    removePendingCloses: async (_g, id) => {
      state.pendingCloses = liveEntries(state.pendingCloses, isPendingCloseShaped, now()).filter((e) => e.pollId !== id);
    },
    // Effect-free: no UI bump, and no replayHeldCloseAnnouncements (no close announcement is ever sent or queued).
    setPollVersion: () => undefined,
  };

  // The local account, as in a live dispatch (the apply core reads no group view, hence `getActiveGroupId: null`).
  const ctx = { groupId, selfPubkeyHex, getActiveGroupId: () => null };
  const ordered = signals
    .filter((s) => pollIdOf(s.rumor) === pollId)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  for (const signal of ordered) {
    rowAt = Number.isFinite(signal.receivedAt) ? signal.receivedAt : -Infinity;
    const sender = { pubkey: signal.sender, authenticity: 'mls' as const };
    if (signal.rumor.kind === POLL_OPEN_KIND) await applyPollOpen(signal.rumor, ctx, sender, deps);
    else if (signal.rumor.kind === POLL_VOTE_KIND) await applyPollVote(signal.rumor, ctx, sender, deps);
    else await applyPollClose(signal.rumor, ctx, sender, deps);
  }

  // A (re)built poll keeps its slot in the list, so list order is stable across recomputes.
  const built = state.polls.findIndex((p) => p.id === pollId);
  if (slot >= 0 && built >= 0) {
    const [poll] = state.polls.splice(built, 1);
    state.polls.splice(Math.min(slot, state.polls.length), 0, poll);
  }
  return state;
}
