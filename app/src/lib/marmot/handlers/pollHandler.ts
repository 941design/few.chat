/**
 * pollHandler.ts
 *
 * RumorHandlers for POLL_OPEN_KIND (kind 10), POLL_VOTE_KIND (kind 11),
 * and POLL_CLOSE_KIND (kind 12).
 *
 * Mirrors lines 703-757 of MarmotContext.onApplicationMessage exactly.
 * All side-effect dependencies are injected — zero imports from
 * app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND, parsePollOpen, parsePollVote, parsePollClose } from '@/src/lib/marmot/pollSync';
import type { Poll, PollVote } from '@/src/lib/marmot/pollPersistence';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';
import { computeTally } from '../pollTally';

export interface PollHandlerDeps {
  savePoll: (poll: Poll) => Promise<void>;
  saveVote: (vote: PollVote) => Promise<void>;
  getPoll: (groupId: string, pollId: string) => Promise<Poll | null>;
  // AC-POLL-4 (epic: group-message-author-auth-app-layer S5). Injected like
  // savePoll/saveVote/getPoll for consistency — there is no principled
  // difference between getPoll and loadVotes as poll-store reads, so both
  // go through the deps bag rather than one being a direct import.
  loadVotes: (pollId: string) => Promise<PollVote[]>;
  setPollVersion: (updater: (v: number) => number) => void;
}

// ---- POLL_OPEN handler -------------------------------------------------------

async function handleOpen(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: PollHandlerDeps): Promise<void> {
  const payload = parsePollOpen(rumor.content);
  if (!payload) return;

  // F2 (Fable Stage-2 review, epic: group-message-author-auth-app-layer S5):
  // first-open-wins. savePoll upserts by id, so without this guard any
  // member could resend poll_open reusing an existing pollId to rebind
  // creatorPubkey to themselves, reset closed=false, and replace
  // title/options — then pass close-authz as "creator". Legit pollIds are
  // fresh crypto.randomUUID() per createPoll, and the dispatcher LRU already
  // dedups identical redelivery by rumor.id; only a malicious/distinct
  // re-open with a reused pollId reaches this guard, and it is dropped.
  const existing = await deps.getPoll(ctx.groupId, payload.id);
  if (existing) return;

  const poll: Poll = {
    id: payload.id,
    groupId: ctx.groupId,
    title: payload.title,
    description: payload.description,
    options: payload.options,
    pollType: payload.pollType,
    // AC-POLL-1: ownership is bound to the authenticated opener. The
    // payload's self-asserted creatorPubkey is parsed (pollSync.ts keeps it
    // on the wire for back-compat) but never read here — it must not be
    // used as a fallback, default, or merge input.
    creatorPubkey: sender.pubkey,
    createdAt: rumor.created_at * 1000,
    closed: false,
  };

  await deps.savePoll(poll);
  deps.setPollVersion((v) => v + 1);
}

export function createPollOpenHandler(deps: PollHandlerDeps): RumorHandler {
  return {
    kind: POLL_OPEN_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handleOpen(rumor, ctx, sender, deps),
  };
}

// ---- POLL_VOTE handler -------------------------------------------------------

async function handleVote(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: PollHandlerDeps): Promise<void> {
  const payload = parsePollVote(rumor.content);
  if (!payload) return;

  const existingPoll = await deps.getPoll(ctx.groupId, payload.pollId);
  // Ignore votes for closed polls.
  if (existingPoll?.closed) return;

  if (!existingPoll) return;

  // F4 (Fable Stage-2 review, epic: group-message-author-auth-app-layer S5):
  // sanitize responses against the poll's actual options before storing —
  // otherwise a crafted vote can contribute to option ids that don't exist
  // (bogus ids counted by computeTally, since it matches on option.id
  // membership) or, for a singlechoice poll, contribute to multiple options
  // at once. Filter to valid option ids first, then cap to one response for
  // singlechoice polls.
  const validOptionIds = new Set(existingPoll.options.map((option) => option.id));
  let sanitizedResponses = payload.responses.filter((response) => validOptionIds.has(response));
  if (existingPoll.pollType === 'singlechoice' && sanitizedResponses.length > 1) {
    sanitizedResponses = sanitizedResponses.slice(0, 1);
  }
  // No valid responses survive sanitization (e.g. all-bogus option ids) —
  // drop the vote entirely. Saving it with an empty responses array would
  // still count as a voter row and inflate totalVoters in computeTally.
  if (sanitizedResponses.length === 0) return;

  const vote: PollVote = {
    id: `${payload.pollId}:${sender.pubkey}`,
    pollId: payload.pollId,
    voterPubkey: sender.pubkey,
    responses: sanitizedResponses,
    votedAt: rumor.created_at * 1000,
  };

  await deps.saveVote(vote);
  deps.setPollVersion((v) => v + 1);
}

export function createPollVoteHandler(deps: PollHandlerDeps): RumorHandler {
  return {
    kind: POLL_VOTE_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handleVote(rumor, ctx, sender, deps),
  };
}

// ---- POLL_CLOSE handler -----------------------------------------------------
// Tally recompute (AC-POLL-4) is provided by computeTally, imported from
// ../pollTally (extracted in S6 so chatHandler.ts's poll_close ingest gate
// can reuse it without importing a handler module).

async function handleClose(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: PollHandlerDeps): Promise<void> {
  const payload = parsePollClose(rumor.content);
  if (!payload) return;

  const existingPoll = await deps.getPoll(ctx.groupId, payload.pollId);
  if (!existingPoll) return;
  // Only the poll creator can close. Case-insensitive (F4, Stage-2 review):
  // aligns with the S6 poll_close ingest gate in chatHandler.ts's
  // gateAnnouncement and messageEdits/api.ts's pubkeysMatch, which both
  // compare identity case-insensitively. No behavior change for canonical
  // hex; unifies the epic's identity-comparison discipline.
  if (existingPoll.creatorPubkey.toLowerCase() !== sender.pubkey.toLowerCase()) return;

  // AC-POLL-4: recompute the tally from stored PollVote rows. The close
  // payload's results/totalVoters are parsed (pollSync.ts validates the
  // wire shape) but deliberately never read below — a poll creator could
  // otherwise forge the final counts.
  const votes = await deps.loadVotes(payload.pollId);
  const { results, totalVoters } = computeTally(existingPoll.options, votes);

  const updated: Poll = {
    ...existingPoll,
    closed: true,
    results,
    totalVoters,
  };

  await deps.savePoll(updated);
  deps.setPollVersion((v) => v + 1);
}

export function createPollCloseHandler(deps: PollHandlerDeps): RumorHandler {
  return {
    kind: POLL_CLOSE_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handleClose(rumor, ctx, sender, deps),
  };
}
