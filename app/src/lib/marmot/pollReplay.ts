/**
 * pollReplay.ts — vote sanitisation and the AC-9 early-vote replay.
 *
 * Shared by handlers/pollHandler.ts (open / vote / close) and the
 * handlers/chatHandler.ts poll_close announcement gate, which must not import
 * a handler module (same reason pollTally.ts was extracted). Storage access is
 * injected — no direct pollPersistence imports here.
 */

import type { Poll, PollVote, PendingPollVote } from './pollPersistence';

export interface PollReplayDeps {
  loadPendingVotes: (groupId: string, pollId: string) => Promise<PendingPollVote[]>;
  removePendingVotes: (groupId: string, applied: PendingPollVote[]) => Promise<void>;
  saveVote: (vote: PollVote) => Promise<void>;
  loadVotes: (groupId: string, pollId: string) => Promise<PollVote[]>;
}

/**
 * F4 (Fable Stage-2 review, epic: group-message-author-auth-app-layer S5):
 * sanitize responses against the poll's actual options before storing —
 * otherwise a crafted vote can contribute to option ids that don't exist
 * (bogus ids counted by computeTally, since it matches on option.id
 * membership) or, for a singlechoice poll, contribute to multiple options at
 * once. Filter to valid option ids first, then cap to one response for
 * singlechoice polls. Returns null when no valid response survives — saving an
 * empty responses array would still count as a voter row and inflate
 * totalVoters in computeTally.
 *
 * Both the live path and the early-vote replay go through this one function so
 * a queued vote can never be validated more leniently than a live one.
 */
export function buildSanitizedVote(
  poll: Poll,
  voterPubkey: string,
  responses: string[],
  votedAt: number,
): PollVote | null {
  const validOptionIds = new Set(poll.options.map((option) => option.id));
  let sanitizedResponses = responses.filter((response) => validOptionIds.has(response));
  if (poll.pollType === 'singlechoice' && sanitizedResponses.length > 1) {
    sanitizedResponses = sanitizedResponses.slice(0, 1);
  }
  if (sanitizedResponses.length === 0) return null;
  return {
    id: `${poll.id}:${voterPubkey}`,
    groupId: poll.groupId,
    pollId: poll.id,
    voterPubkey,
    responses: sanitizedResponses,
    votedAt,
  };
}

/**
 * Apply votes that arrived before `poll`'s poll-open — in its group only (the
 * queue is group-scoped), with the live-vote validation (queued responses are
 * raw; they are sanitized here against the now-known options).
 *
 * Re-entrant: called at poll-open and again at every later vote and close of
 * the poll, so entries stranded by an interrupted earlier replay are recovered
 * by the next poll message (and always before a close computes its tally).
 *
 * Newer wins: a queued vote is skipped when the voter already has a stored
 * vote at least as new (votedAt), so a stranded older early vote can never
 * override a later live vote. Skipped entries are still removed.
 * Deliberately replay-only: the live path (handleVote, castVote) stays
 * arrival-ordered, because a newer-wins check there would silently drop a
 * genuine vote change made on a second device whose clock runs behind. The
 * resulting replay/live ordering mismatch is a known, bounded gap (BACKLOG
 * poll-vote-ordering-single-key) whose fix is a wire-level ordering key.
 *
 * Order is read → save → remove: an interruption before the removal leaves
 * the entries queued, and replaying them again is idempotent (saveVote upserts
 * by `${pollId}:${voter}`; the newer-wins check skips what is already stored).
 */
export async function replayPendingVotes(poll: Poll, deps: PollReplayDeps): Promise<void> {
  const pending = await deps.loadPendingVotes(poll.groupId, poll.id);
  if (pending.length === 0) return;
  const stored = new Map((await deps.loadVotes(poll.groupId, poll.id)).map((v) => [v.id, v]));
  for (const early of pending) {
    const vote = buildSanitizedVote(poll, early.voterPubkey, early.responses, early.votedAt);
    if (!vote) continue;
    const existing = stored.get(vote.id);
    if (existing && existing.votedAt >= vote.votedAt) continue;
    await deps.saveVote(vote);
    stored.set(vote.id, vote);
  }
  await deps.removePendingVotes(poll.groupId, pending);
}

/**
 * Replay any queued votes, then load the poll's votes — the read every tally
 * must use. Throws if either step fails, so a close built on it fails closed.
 */
export async function loadVotesWithPending(poll: Poll, deps: PollReplayDeps): Promise<PollVote[]> {
  await replayPendingVotes(poll, deps);
  return deps.loadVotes(poll.groupId, poll.id);
}
