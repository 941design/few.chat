/**
 * pollSync.ts — Utilities for building and processing poll messages.
 *
 * Mirrors profileSync.ts. Serialises/deserialises poll
 * payloads for MLS application messages (kinds 10, 11, 12).
 */

import type { PollOptionDef, PollResult } from './pollPersistence';

// ---- MLS application-message kind discriminators ----

export const POLL_OPEN_KIND = 10;
export const POLL_VOTE_KIND = 11;
export const POLL_CLOSE_KIND = 12;

// ---- Poll limits ----

/**
 * Single source of truth for poll size limits. The creating UI
 * (CreatePollModal) enforces them on input and the receiving side
 * (parsePollOpen / parsePollVote) rejects anything outside them, so a crafted
 * poll from another client is refused exactly like an oversized local one.
 * Lengths are JS string lengths (UTF-16 code units), matching the input
 * maxLength the creating UI applies.
 */
export const POLL_LIMITS = {
  MIN_OPTIONS: 2,
  MAX_OPTIONS: 10,
  MAX_TITLE_LEN: 200,
  MAX_DESC_LEN: 500,
  MAX_OPTION_LEN: 100,
} as const;

/**
 * Identifier caps. createPoll generates a crypto.randomUUID() poll id (36
 * chars) and option ids "A".."J" (1 char); the caps leave headroom but bound
 * what a crafted message can make this client store (poll ids are part of
 * IDB keys and queued early-vote entries).
 */
export const POLL_ID_LIMITS = {
  MAX_POLL_ID_LEN: 64,
  MAX_OPTION_ID_LEN: 8,
} as const;

const isPollId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= POLL_ID_LIMITS.MAX_POLL_ID_LEN;
const isOptionId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= POLL_ID_LIMITS.MAX_OPTION_ID_LEN;

// ---- Payload types ----

export interface PollOpenPayload {
  id: string;
  title: string;
  description?: string;
  options: PollOptionDef[];
  pollType: 'singlechoice' | 'multiplechoice';
  /**
   * Self-asserted, wire-format only (epic: group-message-author-auth-app-layer
   * S5, AC-POLL-1). Kept on the wire for back-compat parsing; the receiving
   * handler (pollHandler.ts handleOpen) MUST NOT read this field to attribute
   * ownership — it binds the stored Poll.creatorPubkey to the dispatcher's
   * authenticated sender instead.
   */
  creatorPubkey: string;
}

export interface PollVotePayload {
  pollId: string;
  responses: string[];
  /**
   * Per-(poll, voter) Lamport sequence number (bug:
   * poll-vote-ordering-and-early-close). The sender sets it to one more than
   * the highest seq it has seen for its own vote on this poll, so a later vote
   * outranks an earlier one regardless of clock skew between the voter's
   * devices or MLS delivery order. Optional on the wire: absent = a legacy
   * client, ranked as seq 0 (pollPersistence.isNewerVote).
   */
  seq?: number;
}

/** A present seq must be a non-negative safe integer. */
const isVoteSeq = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export interface PollClosePayload {
  pollId: string;
  /**
   * Self-asserted, wire-format only (epic: group-message-author-auth-app-layer
   * S5, AC-POLL-4). The receiving handler (pollHandler.ts handleClose) MUST
   * NOT trust these claimed counts — it recomputes the tally from stored
   * PollVote rows instead, so a poll creator cannot forge the final results.
   */
  results: PollResult[];
  totalVoters: number;
}

// ---- Serialisation ----

export function serialisePollOpen(payload: PollOpenPayload): string {
  return JSON.stringify(payload);
}

export function serialisePollVote(payload: PollVotePayload): string {
  return JSON.stringify(payload);
}

export function serialisePollClose(payload: PollClosePayload): string {
  return JSON.stringify(payload);
}

// ---- Parsing (with validation) ----

export function parsePollOpen(content: string): PollOpenPayload | null {
  try {
    const d = JSON.parse(content) as PollOpenPayload;
    if (
      !isPollId(d.id) ||
      typeof d.title !== 'string' ||
      d.title.length > POLL_LIMITS.MAX_TITLE_LEN ||
      (d.description !== undefined &&
        (typeof d.description !== 'string' || d.description.length > POLL_LIMITS.MAX_DESC_LEN)) ||
      !Array.isArray(d.options) ||
      d.options.length < POLL_LIMITS.MIN_OPTIONS ||
      d.options.length > POLL_LIMITS.MAX_OPTIONS ||
      !d.options.every(
        (o: any) =>
          isOptionId(o?.id) &&
          typeof o.label === 'string' &&
          o.label.length <= POLL_LIMITS.MAX_OPTION_LEN,
      ) ||
      (d.pollType !== 'singlechoice' && d.pollType !== 'multiplechoice') ||
      typeof d.creatorPubkey !== 'string'
    ) {
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function parsePollVote(content: string): PollVotePayload | null {
  try {
    const d = JSON.parse(content) as PollVotePayload;
    if (
      !isPollId(d.pollId) ||
      !Array.isArray(d.responses) ||
      d.responses.length === 0 ||
      // No poll can have more options than MAX_OPTIONS, so a longer response
      // list is never legitimate — also bounds what the early-vote queue
      // (pollPersistence.queuePendingVote) can be asked to hold.
      d.responses.length > POLL_LIMITS.MAX_OPTIONS ||
      !d.responses.every((r: any) => isOptionId(r)) ||
      // A crafted huge seq only locks the (authenticated) sender out of
      // changing their own vote; the safe-integer bound keeps `seq + 1` exact.
      (d.seq !== undefined && !isVoteSeq(d.seq))
    ) {
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function parsePollClose(content: string): PollClosePayload | null {
  try {
    const d = JSON.parse(content) as PollClosePayload;
    if (
      !isPollId(d.pollId) ||
      !Array.isArray(d.results) ||
      !d.results.every(
        (r: any) =>
          typeof r.optionId === 'string' &&
          typeof r.label === 'string' &&
          typeof r.count === 'number',
      ) ||
      typeof d.totalVoters !== 'number'
    ) {
      return null;
    }
    return d;
  } catch {
    return null;
  }
}
