/**
 * pollCast.ts — the local "cast a vote" flow behind PollStoreContext.castVote
 * (bug: poll-vote-ordering-and-early-close).
 *
 * Kept out of the React context so it is unit-testable (no renderHook in this
 * repo). castVote stays outside the dispatcher — MLS never echoes our own
 * messages back — so it stores its vote through the same compare-and-set
 * (pollPersistence.saveVoteIfNewer) as every received vote.
 */

import type { PollVote, PendingPollVote } from './pollPersistence';
import type { PollVotePayload } from './pollSync';

/**
 * Lamport rule for our own next vote on a poll: one more than the highest seq
 * seen for any vote of ours on it — the stored vote (possibly cast on another
 * device) and early votes of ours still queued for the poll. Legacy rows rank
 * as 0.
 */
export function nextVoteSeq(voterPubkey: string, stored: PollVote[], pending: PendingPollVote[]): number {
  const me = voterPubkey.toLowerCase();
  let max = 0;
  for (const v of [...stored, ...pending]) {
    if (v.voterPubkey.toLowerCase() !== me) continue;
    max = Math.max(max, v.seq ?? 0);
  }
  return max + 1;
}

export interface VoteCasterDeps {
  loadVotes: (groupId: string, pollId: string) => Promise<PollVote[]>;
  loadPendingVotes: (groupId: string, pollId: string) => Promise<PendingPollVote[]>;
  saveVoteIfNewer: (vote: PollVote) => Promise<boolean>;
}

export interface CastVoteArgs {
  groupId: string;
  pollId: string;
  voterPubkey: string;
  responses: string[];
  /** Sends the vote rumor; resolves with the sent rumor's id and created_at (seconds). */
  send: (payload: PollVotePayload) => Promise<{ id: string; created_at: number }>;
}

/**
 * Returns a cast function that serialises casts per (group, poll): two rapid
 * casts on the same poll cannot read the same stored seq and send the same
 * number. A failed cast does not block the next one.
 */
export function createVoteCaster(deps: VoteCasterDeps) {
  const chains = new Map<string, Promise<unknown>>();

  async function run(args: CastVoteArgs): Promise<PollVote> {
    const { groupId, pollId, voterPubkey, responses } = args;
    const [stored, pending] = await Promise.all([
      deps.loadVotes(groupId, pollId),
      deps.loadPendingVotes(groupId, pollId),
    ]);
    const seq = nextVoteSeq(voterPubkey, stored, pending);
    const sent = await args.send({ pollId, responses, seq });
    // Stored exactly as every peer stores it on receipt (created_at in ms,
    // rumor id), so the local and remote orders agree.
    const vote: PollVote = {
      id: `${pollId}:${voterPubkey}`,
      groupId,
      pollId,
      voterPubkey,
      responses,
      votedAt: sent.created_at * 1000,
      seq,
      rumorId: sent.id,
    };
    await deps.saveVoteIfNewer(vote);
    return vote;
  }

  return function cast(args: CastVoteArgs): Promise<PollVote> {
    const key = `${args.groupId}:${args.pollId}`;
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => run(args));
    const settled = next.catch(() => {});
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };
}
