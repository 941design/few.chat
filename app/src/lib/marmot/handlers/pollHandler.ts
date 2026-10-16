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
import type { Poll, PollVote, PendingPollVote, PendingPollClose } from '@/src/lib/marmot/pollPersistence';
import { voteAsOf } from '@/src/lib/marmot/pollPersistence';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';
import { computeTally } from '../pollTally';
import { buildSanitizedVote, replayPendingVotes, loadVotesWithPending } from '../pollReplay';

export { replayPendingVotes } from '../pollReplay';

export interface PollHandlerDeps {
  savePoll: (poll: Poll) => Promise<void>;
  // The single vote write: a compare-and-set on (seq, created_at, rumor id)
  // inside pollPersistence's per-key queue (bug: poll-vote-ordering-and-early-close).
  saveVoteIfNewer: (vote: PollVote) => Promise<boolean>;
  getPoll: (groupId: string, pollId: string) => Promise<Poll | null>;
  // AC-POLL-4 (epic: group-message-author-auth-app-layer S5). Injected like
  // savePoll/saveVoteIfNewer/getPoll for consistency — there is no principled
  // difference between getPoll and loadVotes as poll-store reads, so both
  // go through the deps bag rather than one being a direct import.
  // Group-scoped (bug: polls-integrity-cluster): poll ids are only unique
  // per group, so votes are always read for (groupId, pollId).
  loadVotes: (groupId: string, pollId: string) => Promise<PollVote[]>;
  // AC-9: votes for a poll not yet known in the group are queued and
  // applied when its poll-open arrives.
  queuePendingVote: (vote: Omit<PendingPollVote, 'receivedAt'>) => Promise<void>;
  loadPendingVotes: (groupId: string, pollId: string) => Promise<PendingPollVote[]>;
  removePendingVotes: (groupId: string, applied: PendingPollVote[]) => Promise<void>;
  // AC-9: closes for a poll not yet known in the group are queued (bound to
  // the authenticated closer) and applied when its poll-open arrives.
  queuePendingClose: (close: Omit<PendingPollClose, 'receivedAt'>) => Promise<void>;
  loadPendingCloses: (groupId: string, pollId: string) => Promise<PendingPollClose[]>;
  removePendingCloses: (groupId: string, pollId: string) => Promise<void>;
  /**
   * Re-evaluates poll_close chat announcements held because they arrived
   * before the poll was known (chatHandler createPollCloseAnnouncementReplayer).
   * Run by settleHeldCloses — after any held close is applied — at the open
   * and again at every later message of the poll, until it succeeds.
   */
  replayHeldCloseAnnouncements?: (poll: Poll, ctx: DispatcherContext) => Promise<void>;
  setPollVersion: (updater: (v: number) => number) => void;
}

// Vote sanitisation and the early-vote replay live in ../pollReplay so the
// chatHandler poll_close gate can share them without importing a handler.

// A held close counts each voter's vote "as of" the close's local receipt
// (pollPersistence.voteAsOf). The key is local receipt order — the same key a
// live close applies implicitly (a closed poll drops every vote that arrives
// after it) — not the senders' created_at: comparing two senders' clocks would
// let a back-dated vote into a closed tally.

/** Best-effort replay for paths that must not fail on it (see callers). */
async function recoverPendingVotes(poll: Poll, deps: PollHandlerDeps): Promise<void> {
  try {
    await replayPendingVotes(poll, deps);
  } catch (err) {
    console.warn('[pollHandler] early-vote replay failed; entries stay queued:', err);
  }
}

/**
 * AC-9: apply what arrived before the poll did, beyond votes — a held close and
 * held poll_close announcements. Idempotent and re-entrant: called at the open
 * and again at every later vote, duplicate open and close of the poll, because
 * the dispatcher acks a failed handler, so a step interrupted after the open's
 * savePoll is only ever retried by a LATER message of the poll.
 *
 * The stored poll is the truth; queue cleanup is best-effort.
 * - A held close is applied only if the poll is still open and the close's
 *   authenticated sender is the poll's authenticated creator (case-
 *   insensitive); the tally is recomputed from stored votes after replaying
 *   queued ones (AC-POLL-4). A failure reading the queue, the votes, or saving
 *   the closed poll throws BEFORE anything is saved closed (fail closed); the
 *   held entries stay and a later message retries.
 * - Once the poll is closed (or no held close is the creator's) the entries
 *   are removed. A failure of that removal is only logged: the closed poll is
 *   already stored, a later message removes the stale entries, and an
 *   already-closed poll is never re-closed.
 * - Held announcements are then re-run through the chat gate; a failure there
 *   is logged and leaves the affected entries held. Re-running one that was
 *   already appended is harmless: rows are insert-if-absent by rumor id, and
 *   unread is counted only for an inserted row.
 *
 * Returns the poll as now stored (closed if a held close was applied).
 */
async function settleHeldCloses(poll: Poll, ctx: DispatcherContext, deps: PollHandlerDeps, replayAnnouncements = true): Promise<Poll> {
  let current = poll;
  const pending = await deps.loadPendingCloses(ctx.groupId, poll.id);
  if (pending.length > 0) {
    const creatorCloses = pending.filter((c) => c.closerPubkey.toLowerCase() === poll.creatorPubkey.toLowerCase());
    if (creatorCloses.length > 0 && !poll.closed) {
      // Count exactly the votes this member received before the close — what
      // it would have counted had the open arrived first, where a vote after
      // the close is dropped. Without this, close→vote→open counted the late
      // vote and open→close→vote did not (bug:
      // poll-residual-ordering-and-close-retry).
      // A voter who changed their vote around the close counts with the vote
      // they had at the close (older votes are kept for this, see
      // pollPersistence keptVotes) — the same as had the open come first.
      const closeReceivedAt = Math.min(...creatorCloses.map((c) => c.receivedAt));
      const votes = (await loadVotesWithPending(poll, deps))
        .map((v) => voteAsOf(v, closeReceivedAt))
        .filter((v): v is PollVote => v !== null);
      const { results, totalVoters } = computeTally(poll.options, votes);
      current = { ...poll, closed: true, results, totalVoters };
      await deps.savePoll(current);
    }
    try {
      await deps.removePendingCloses(ctx.groupId, poll.id);
    } catch (err) {
      // Cleanup never gates correctness: the stored poll already reflects the
      // close (or its discard); the stale entries are removed by a later run.
      console.warn('[pollHandler] removing held closes failed; retried at the next poll message:', err);
    }
  }
  if (replayAnnouncements && deps.replayHeldCloseAnnouncements) {
    try {
      await deps.replayHeldCloseAnnouncements(current, ctx);
    } catch (err) {
      console.warn('[pollHandler] held close-announcement replay failed; entries stay held:', err);
    }
  }
  return current;
}

/**
 * Best-effort settleHeldCloses for paths that must not fail on it. On failure
 * it returns the STORED poll (re-read), never the caller's copy: a step may
 * have failed after the closed poll was already saved; without a confirmed
 * read we must not write. If the re-read fails (or finds no poll) it returns
 * 'unknown', and every caller then returns without any write or UI bump — a
 * live rumor dropped that way mirrors the dispatcher's per-handler catch (it
 * is already markSeen'd), and a journal replay re-delivers it.
 */
async function recoverHeldCloses(poll: Poll, ctx: DispatcherContext, deps: PollHandlerDeps): Promise<Poll | 'unknown'> {
  try {
    return await settleHeldCloses(poll, ctx, deps);
  } catch (err) {
    console.warn('[pollHandler] applying a held close failed; it stays held:', err);
    try {
      return (await deps.getPoll(ctx.groupId, poll.id)) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/**
 * For the chatHandler poll_close gate (bug: poll-residual-ordering-and-close-
 * retry): a results summary of a poll is one more message of that poll, so it
 * applies a held close of the poll first — e.g. the creator's close that was
 * held after a storage failure, followed (as usual) by its summary. Held
 * announcements are NOT replayed from here (the gate is itself evaluating
 * one; replaying would recurse); the next poll message does that. Returns the
 * poll as now stored, and bumps the poll UI when it closed the poll.
 *
 * Unlike recoverHeldCloses there is no re-read fallback: ANY failure returns
 * 'unknown'. The chat gate is the only consumer, and it appends the summary
 * with a tally that can never change afterwards. A failed settle means the
 * poll may be about to close (at the next poll message) with a different
 * tally — e.g. the held close's as-of tally excludes a vote the open poll's
 * recompute would count — so the gate must hold the summary
 * (holdAfterFailure) rather than judge it against the stored open poll.
 */
export function createHeldCloseSettler(deps: PollHandlerDeps) {
  return async (poll: Poll, ctx: DispatcherContext): Promise<Poll | 'unknown'> => {
    let settled: Poll;
    try {
      settled = await settleHeldCloses(poll, ctx, deps, false);
    } catch (err) {
      console.warn('[pollHandler] settling a held close for a results summary failed; the summary is held:', err);
      return 'unknown';
    }
    if (settled.closed && !poll.closed) deps.setPollVersion((v) => v + 1);
    return settled;
  };
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
  if (existing) {
    // Guard semantics unchanged (nothing from THIS message is persisted), but
    // a re-delivered open is a chance to recover early votes, a held close and
    // held announcements stranded by an interrupted earlier step (AC-9).
    // Best-effort.
    if (!existing.closed) await recoverPendingVotes(existing, deps);
    const settled = await recoverHeldCloses(existing, ctx, deps);
    if (settled === 'unknown') return; // unconfirmed state: no further writes
    if (settled.closed && !existing.closed) deps.setPollVersion((v) => v + 1);
    return;
  }

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

  try {
    // AC-9: apply what arrived before this open — queued votes first, then a
    // held close (only the creator's; its tally includes those votes) and held
    // announcements. A failure throws (as before) but strands nothing: every
    // step not completed stays queued, and the next message of this poll
    // retries it (recoverPendingVotes / recoverHeldCloses in the existing-poll
    // branch below, handleVote and handleClose).
    await replayPendingVotes(poll, deps);
    await settleHeldCloses(poll, ctx, deps);
  } finally {
    // The poll is stored: show it even when a later step failed.
    deps.setPollVersion((v) => v + 1);
  }
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

  if (!existingPoll) {
    // AC-9: out-of-order MLS delivery — the poll-open has not arrived (yet).
    // Queue the vote, bound to the authenticated sender, for replay when it
    // does. Bounded and expiring (pollPersistence); not shown until applied.
    await deps.queuePendingVote({
      groupId: ctx.groupId,
      pollId: payload.pollId,
      voterPubkey: sender.pubkey,
      responses: payload.responses,
      votedAt: rumor.created_at * 1000,
      seq: payload.seq ?? 0,
      rumorId: rumor.id,
    });
    return;
  }

  // Ignore votes for closed polls — but still give held announcements of the
  // poll a retry (a closed poll is never re-closed: settleHeldCloses only
  // closes an open one).
  if (existingPoll.closed) {
    await recoverHeldCloses(existingPoll, ctx, deps);
    return;
  }

  // Recover early votes stranded by an interrupted replay. Best-effort: a
  // replay failure must not cost the live vote (the entries stay queued and
  // the close replays again, fail-closed). Order no longer matters for
  // correctness — both writes go through the compare-and-set below.
  await recoverPendingVotes(existingPoll, deps);

  // A held close stranded by an interrupted earlier step closes the poll now —
  // and then this vote arrived after the close and is dropped like any other.
  const settled = await recoverHeldCloses(existingPoll, ctx, deps);
  // Unconfirmed state (the poll may already be stored closed): no write, no bump.
  if (settled === 'unknown') return;
  if (settled.closed) {
    deps.setPollVersion((v) => v + 1);
    return;
  }

  const vote = buildSanitizedVote(
    existingPoll,
    sender.pubkey,
    payload.responses,
    rumor.created_at * 1000,
    payload.seq ?? 0,
    rumor.id,
  );
  if (!vote) return;

  // Max wins: an older vote (by seq, created_at, rumor id) delivered after a
  // newer one — reordering, a journal replay after a failed ack — is ignored.
  await deps.saveVoteIfNewer(vote);
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

  // Held closes are bound to the authenticated sender; settleHeldCloses
  // applies one only if that sender is the poll's creator.
  const hold = () =>
    deps.queuePendingClose({
      groupId: ctx.groupId,
      pollId: payload.pollId,
      closerPubkey: sender.pubkey,
      closedAt: rumor.created_at * 1000,
    });
  // A live close is acked whether or not this handler throws
  // (applicationRumorDispatcher), so a close that fails on an indeterminate
  // read or write is held instead of lost: the next message of the poll
  // applies it (settleHeldCloses). The original error is still thrown.
  const holdAfterFailure = async (err: unknown): Promise<never> => {
    await hold().catch((holdErr: unknown) => {
      console.warn('[pollHandler] holding a failed close for retry failed; it is lost:', holdErr);
    });
    throw err;
  };

  let existingPoll: Poll | null;
  try {
    existingPoll = await deps.getPoll(ctx.groupId, payload.pollId);
  } catch (err) {
    return holdAfterFailure(err);
  }
  if (!existingPoll) {
    // AC-9: out-of-order MLS delivery — the close arrived before its
    // poll-open. Queue it; handleOpen applies it only if its sender turns out
    // to be the poll's creator.
    await hold();
    return;
  }

  // Recover a held close / held announcements stranded by an interrupted
  // earlier step (AC-9) — the creator binding lives in the held entries, so
  // this is safe whoever sent this close. An already-closed poll is final.
  const settled = await recoverHeldCloses(existingPoll, ctx, deps);
  // Unconfirmed state (the poll may already be stored closed): no close write
  // now — but held, so the next message of the poll applies it (a live close
  // is acked even when this throws).
  if (settled === 'unknown') return holdAfterFailure(new Error('poll state unknown after a failed held-close recovery'));
  if (settled.closed) {
    if (!existingPoll.closed) deps.setPollVersion((v) => v + 1);
    // Closing is final: a repeated close of a closed poll changes nothing.
    return;
  }

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
  // Replay stranded early votes first (AC-9). A failure throws, so the close
  // is NOT persisted with a tally that is missing them (fail closed).
  // A failure here holds the close for retry (above) — never a closed poll
  // built on partial data.
  try {
    const votes = await loadVotesWithPending(existingPoll, deps);
    const { results, totalVoters } = computeTally(existingPoll.options, votes);

    const updated: Poll = {
      ...existingPoll,
      closed: true,
      results,
      totalVoters,
    };

    await deps.savePoll(updated);
  } catch (err) {
    return holdAfterFailure(err);
  }
  deps.setPollVersion((v) => v + 1);
}

export function createPollCloseHandler(deps: PollHandlerDeps): RumorHandler {
  return {
    kind: POLL_CLOSE_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handleClose(rumor, ctx, sender, deps),
  };
}
