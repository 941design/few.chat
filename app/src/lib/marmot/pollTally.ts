/**
 * pollTally.ts
 *
 * Extracted from handlers/pollHandler.ts (S6, epic:
 * group-message-author-auth-app-layer) so chatHandler.ts's poll_close
 * announcement ingest gate can recompute the tally from stored votes without
 * importing a handler module. Behavior is byte-identical to the function
 * this replaces.
 */

import type { PollOptionDef, PollResult, PollVote } from './pollPersistence';

/**
 * Recomputes the poll tally from the votes THIS client has stored — a pure,
 * order-independent function of the stored vote set (AC-XCUT-2: the
 * displayed tally never varies with arrival order, and never with the
 * closer's claimed counts). If this client hasn't observed every vote
 * (redelivery, missed messages), the result is this client's own
 * best-known count — that eventual-consistency gap is accepted;
 * forgeability of the final counts is what this closes.
 */
export function computeTally(options: PollOptionDef[], votes: PollVote[]): { results: PollResult[]; totalVoters: number } {
  const results: PollResult[] = options.map((option) => ({
    optionId: option.id,
    label: option.label,
    count: votes.reduce((count, vote) => count + (vote.responses.includes(option.id) ? 1 : 0), 0),
  }));
  return { results, totalVoters: votes.length };
}
