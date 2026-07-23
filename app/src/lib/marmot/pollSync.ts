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
}

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
      typeof d.id !== 'string' ||
      typeof d.title !== 'string' ||
      !Array.isArray(d.options) ||
      d.options.length < 2 ||
      !d.options.every((o: any) => typeof o.id === 'string' && typeof o.label === 'string') ||
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
      typeof d.pollId !== 'string' ||
      !Array.isArray(d.responses) ||
      d.responses.length === 0 ||
      !d.responses.every((r: any) => typeof r === 'string')
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
      typeof d.pollId !== 'string' ||
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
