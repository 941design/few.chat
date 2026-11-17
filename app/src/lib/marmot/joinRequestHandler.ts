/**
 * Join request handler — processes kind 21059 join request rumors.
 *
 * Validates nonce against invite link storage, checks mute status,
 * checks for existing membership, deduplicates by pubkey+groupId,
 * and persists PendingJoinRequest to IDB.
 *
 * Two entry points share the parsing:
 *  - `createJoinRequestInboxHandler` (D7/D8, S12): the handler registered with the library's
 *    `registerInboxHandler(21059)`. The requester is the seal-bound `rumor.pubkey` the library delivers.
 *  - `handleJoinRequest`: the legacy entry of the old Welcome subscription (`welcomeSubscription.ts`), kept only
 *    until S22 deletes that file.
 */

import type { InboxRumorHandler } from '@941design/marmot';
import { getInviteLink, isExpired } from './inviteLinkStorage';
import type { InviteLink } from './inviteLinkStorage';
import {
  savePendingJoinRequest,
  putPendingJoinRequest,
  loadPendingJoinRequests,
  loadAllPendingJoinRequests,
  deletePendingJoinRequest,
  hasSeenJoinRequestRumor,
  markJoinRequestRumorSeen,
} from './joinRequestStorage';
import type { PendingJoinRequest } from './joinRequestStorage';
import { PENDING_JOIN_REQUEST_TTL_MS, isPendingJoinRequestExpired } from './joinRequestTtl';
import { APP_INBOX_KINDS } from './kinds';
import type { DenyLayer } from './invitations';
import { truncateUtf8, MAX_NAME_BYTES } from '@/src/lib/contactCard';

export const JOIN_REQUEST_KIND: number = APP_INBOX_KINDS.joinRequest;

export type JoinRequestReceivedCallback = (request: PendingJoinRequest) => void;

export interface JoinRequestPayload {
  type: 'join_request';
  nonce: string;
  name: string;
  requesterName?: string;
}

/**
 * Parse the content of a kind 21059 rumor.
 * Returns null if the content is not a valid join request.
 */
export function parseJoinRequestContent(content: string): JoinRequestPayload | null {
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      parsed.type === 'join_request' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.name === 'string'
    ) {
      const trimmedRequesterName =
        typeof parsed.requesterName === 'string' ? parsed.requesterName.trim() : '';
      const requesterName = trimmedRequesterName.length > 0 ? trimmedRequesterName : undefined;
      return {
        type: 'join_request',
        nonce: parsed.nonce,
        name: parsed.name,
        requesterName,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Handle a received join request rumor.
 *
 * Discard conditions:
 * - Content is not a valid join request
 * - Nonce not found in invite link storage
 * - Invite link is muted
 * - Invite link is expired (isExpired(inviteLink, Date.now()))
 * - Requester is already a group member
 * - Duplicate request (same pubkey + groupId already pending)
 *
 * Returns the persisted PendingJoinRequest, or null if discarded.
 */
export async function handleJoinRequest(
  rumor: { pubkey: string; content: string },
  eventId: string,
  groupMemberPubkeys: (groupId: string) => string[],
): Promise<PendingJoinRequest | null> {
  // Parse content
  const payload = parseJoinRequestContent(rumor.content);
  if (!payload) return null;

  // Look up nonce
  const inviteLink = await getInviteLink(payload.nonce);
  if (!inviteLink) return null;

  // Check mute status
  if (inviteLink.muted) return null;

  // Check expiry status (AC-ENFORCE-1/2) — drops the request exactly as the
  // muted check above does. isExpired covers legacy records with no
  // expiresAt via its own createdAt + DAY_MS fallback (Design Decision 2),
  // so this call is correct even before migrateInviteLinks has run.
  if (isExpired(inviteLink, Date.now())) return null;

  const groupId = inviteLink.groupId;

  // Check if requester is already a group member
  const members = groupMemberPubkeys(groupId);
  if (members.includes(rumor.pubkey)) return null;

  // Check for existing pending request (dedup by pubkey + groupId)
  const existingRequests = await loadPendingJoinRequests(groupId);
  if (existingRequests.some((r) => r.pubkeyHex === rumor.pubkey)) return null;

  // Persist the request
  // Cap on receive, independent of any cap the sender may have applied —
  // the sender is untrusted, so this is the actual security control.
  const nickname =
    payload.requesterName !== undefined ? truncateUtf8(payload.requesterName, MAX_NAME_BYTES) : undefined;
  const request: PendingJoinRequest = {
    pubkeyHex: rumor.pubkey,
    nonce: payload.nonce,
    groupId,
    receivedAt: Date.now(),
    nickname,
    eventId,
  };

  await savePendingJoinRequest(request);
  return request;
}

// ---------------------------------------------------------------------------
// Library inbox handler (D7 / D8, AC-JOIN-1 / AC-JOIN-5 / AC-BLK-1 join-request leg)
// ---------------------------------------------------------------------------

/**
 * Bounds of the pending-request store. Any sender that holds a link nonce can mint unlimited throwaway requester keys,
 * so the inbox handler (the only receive path) refuses to store beyond these, silently and without a bell:
 * `MAX_PENDING_JOIN_REQUESTS_PER_GROUP` per group, and a request older than `PENDING_JOIN_REQUEST_TTL_MS` no longer
 * counts and is deleted when the next request arrives (and when the list is loaded or the request approved). There is
 * deliberately NO global cap: a flood through one group's invite nonce can only fill that group's own allowance, never
 * block requests for other groups.
 */
export const MAX_PENDING_JOIN_REQUESTS_PER_GROUP = 50;
export { PENDING_JOIN_REQUEST_TTL_MS };

/** The slice of an invite link the handler reads. */
export type InviteLinkSlice = Pick<InviteLink, 'groupId' | 'muted' | 'expiresAt' | 'createdAt'>;

export interface JoinRequestInboxHandlerDeps {
  /** Block predicate (S9). Called on EVERY arrival, before anything is looked up, stored or rung. */
  denyLayer: Pick<DenyLayer, 'isBlocked'>;
  /** Invite-link lookup by nonce (production: `getInviteLink`). */
  inviteLinks: { get: (nonce: string) => Promise<InviteLinkSlice | undefined> };
  /**
   * The CURRENT member pubkeys of a group, from the app's own synchronous roster snapshot (production: the attached
   * groups' `members()`). Sync and client-free: an inbox handler never awaits an account-scope client call. An unknown
   * group yields `[]` (the approval resolves an already-member requester as a no-op success).
   */
  memberPubkeys: (groupId: string) => readonly string[];
  /**
   * The pending-request store (production: `loadAllPendingJoinRequests` / `putPendingJoinRequest` /
   * `deletePendingJoinRequest`). `loadAll` is the ONE scan per arrival: dedup and both caps are decided on it, and
   * `save` stores without scanning again.
   */
  requests: {
    loadAll: () => Promise<readonly PendingJoinRequest[]>;
    save: (request: PendingJoinRequest) => Promise<void>;
    /** Deletes one stored request by id (TTL pruning). */
    remove: (eventId: string) => Promise<void>;
  };
  /** Remembered rumor ids (production: `hasSeenJoinRequestRumor` / `markJoinRequestRumorSeen`). */
  seen: { has: (rumorId: string) => Promise<boolean>; add: (rumorId: string) => Promise<void> };
  /** Clock, ms (the link expiry check and `receivedAt`). */
  now: () => number;
  /** A request was stored (the bell). Called once per new request; a throw is reported, never propagated. */
  onReceived: (request: PendingJoinRequest) => void;
  onError?: (error: unknown) => void;
}

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createJoinRequestInboxHandler: required dependency "${name}" is missing`);
}

/**
 * Handler for `extensions.registerInboxHandler(APP_INBOX_KINDS.joinRequest, ...)`.
 *
 * It runs INSIDE a library frame on the serial inbox queue (it blocks all inbox dispatch, Welcomes included), so it
 * follows the inbox-handler rules: it validates, persists and returns; it calls no account-scope client method and
 * enqueues nothing (approval is a separate UI-driven, queue-run step).
 *
 * Order of checks, each dropping silently (nothing stored, no bell):
 *   1. wrong kind, or a missing id / malformed sender (defence in depth; the registry already routes by kind);
 *   2. the sender is blocked (`DenyLayer.isBlocked`, BEFORE anything else, so a blocked sender leaves no trace: not even a
 *      remembered rumor id);
 *   3. the rumor id was already accepted (library redelivery, or a replay after the request was consumed);
 *   4. malformed content (`parseJoinRequestContent`);
 *   5. unknown nonce, muted link, expired link (AC-JOIN-5, unchanged);
 *   6. the requester already is a member;
 *   7. a pending request of the same requester and group exists (dedup by pubkey + group; the rumor id is NOT remembered:
 *      a flood of duplicates must not push other senders' remembered ids out of the bounded seen store);
 *   8. the group is full: it already holds `MAX_PENDING_JOIN_REQUESTS_PER_GROUP` live requests (older than
 *      `PENDING_JOIN_REQUEST_TTL_MS` is not live). Other groups are unaffected (no global cap).
 * The requester is `rumor.pubkey` (lowercased), never a field of the content. The requester name travels only inside the
 * rumor content (inside the gift wrap) and is capped on receive. A STORAGE failure is reported and RETHROWN: the library
 * defers the wrap and redelivers it (at-least-once), and the seen-mark is written only after the request was saved, so a
 * retry cannot be lost or doubled. The bell rings right after the save, BEFORE the seen-mark, and a failing seen-mark is
 * reported but never rethrown (a rethrow after the bell would redeliver and ring again; the pending duplicate check
 * already drops that replay).
 */
export function createJoinRequestInboxHandler(deps: JoinRequestInboxHandlerDeps): InboxRumorHandler {
  if (!deps) throw new TypeError('createJoinRequestInboxHandler: dependencies are required');
  requireFn(deps.denyLayer?.isBlocked, 'denyLayer.isBlocked');
  requireFn(deps.inviteLinks?.get, 'inviteLinks.get');
  requireFn(deps.memberPubkeys, 'memberPubkeys');
  requireFn(deps.requests?.loadAll, 'requests.loadAll');
  requireFn(deps.requests?.save, 'requests.save');
  requireFn(deps.requests?.remove, 'requests.remove');
  requireFn(deps.seen?.has, 'seen.has');
  requireFn(deps.seen?.add, 'seen.add');
  requireFn(deps.now, 'now');
  requireFn(deps.onReceived, 'onReceived');
  const { denyLayer, inviteLinks, memberPubkeys, requests, seen, now, onReceived } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/joinRequests] inbox handler', e));

  return async (rumor) => {
    if (rumor.kind !== JOIN_REQUEST_KIND) return;
    const sender = typeof rumor.pubkey === 'string' ? rumor.pubkey.toLowerCase() : '';
    if (!PUBKEY_PATTERN.test(sender)) return;
    if (typeof rumor.id !== 'string' || rumor.id.length === 0) return;
    if (denyLayer.isBlocked(sender)) return;
    try {
      if (await seen.has(rumor.id)) return;
      const payload = parseJoinRequestContent(rumor.content);
      if (!payload) return;
      const link = await inviteLinks.get(payload.nonce);
      if (!link || link.muted) return;
      const at = now();
      if (isExpired(link, at)) return;
      if (memberPubkeys(link.groupId).some((m) => m.toLowerCase() === sender)) return;
      const stored = await requests.loadAll();
      const live: PendingJoinRequest[] = [];
      for (const r of stored) {
        if (isPendingJoinRequestExpired(r, at)) {
          try {
            await requests.remove(r.eventId);
          } catch (e) {
            onError(e); // a failed prune never blocks the arrival
          }
        } else live.push(r);
      }
      const inGroup = live.filter((r) => r.groupId === link.groupId);
      if (inGroup.some((r) => r.pubkeyHex === sender)) return;
      if (inGroup.length >= MAX_PENDING_JOIN_REQUESTS_PER_GROUP) return;
      // Cap on receive: the sender is untrusted, so this is the actual security control.
      const nickname = payload.requesterName !== undefined ? truncateUtf8(payload.requesterName, MAX_NAME_BYTES) : undefined;
      const request: PendingJoinRequest = {
        pubkeyHex: sender,
        nonce: payload.nonce,
        groupId: link.groupId,
        receivedAt: at,
        nickname,
        eventId: rumor.id,
      };
      await requests.save(request);
      try {
        onReceived(request);
      } catch (e) {
        onError(e);
      }
      try {
        await seen.add(rumor.id);
      } catch (e) {
        onError(e);
      }
    } catch (e) {
      onError(e);
      throw e;
    }
  };
}

/**
 * The production ports of `createJoinRequestInboxHandler` (idb-backed stores). Each member is a thin wrapper resolved
 * at call time, so importing this module never reads a storage export eagerly.
 */
export const joinRequestStorePorts = {
  inviteLinks: { get: (nonce: string) => getInviteLink(nonce) },
  requests: {
    loadAll: () => loadAllPendingJoinRequests(),
    save: (request: PendingJoinRequest) => putPendingJoinRequest(request),
    remove: (eventId: string) => deletePendingJoinRequest(eventId),
  },
  seen: {
    has: (rumorId: string) => hasSeenJoinRequestRumor(rumorId),
    add: (rumorId: string) => markJoinRequestRumorSeen(rumorId, Date.now()),
  },
} as const;
