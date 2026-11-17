/**
 * IndexedDB-backed pending join request storage using idb-keyval.
 *
 * Each request is keyed by its eventId in the 'few-join-requests' database.
 * Deduplication: savePendingJoinRequest is a no-op if a request with the same
 * pubkeyHex + groupId already exists.
 */

import { createStore, get, set, del, entries, clear } from 'idb-keyval';
import { isPendingJoinRequestExpired } from './joinRequestTtl';

export interface PendingJoinRequest {
  /** Requester's pubkey (hex) */
  pubkeyHex: string;
  /** The nonce from the invite link */
  nonce: string;
  /** Group ID (resolved from nonce) */
  groupId: string;
  /** When the request was received (Unix ms) */
  receivedAt: number;
  /**
   * Requester's nickname, sourced exclusively from the `requesterName` field
   * of the requester's own gift-wrapped join-request rumor — never from a
   * kind-0 metadata lookup (this app's hard privacy invariant forbids
   * fetching or relying on public kind-0 for anything). May be `undefined`
   * when the requester is on an older client that doesn't send the field,
   * or when the field was malformed/empty and tolerantly dropped.
   */
  nickname?: string;
  /**
   * Identifier of the request and its storage key: the join-request RUMOR id (the inbox handler's `rumor.id`); the legacy
   * welcomeSubscription path stores the gift-wrap event id instead. Also what approval/dismiss address the request by.
   */
  eventId: string;
}

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const joinRequestStore = createStore('few-join-requests', 'requests');

export function createJoinRequestStore() {
  return joinRequestStore;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Save a pending join request. Deduplicates by pubkeyHex + groupId:
 * if a request with the same requester and group already exists, this is a no-op.
 */
export async function savePendingJoinRequest(request: PendingJoinRequest): Promise<void> {
  const all = await entries<string, PendingJoinRequest>(joinRequestStore);
  const duplicate = all.some(
    ([, existing]) =>
      existing.pubkeyHex === request.pubkeyHex && existing.groupId === request.groupId
  );
  if (duplicate) return;
  await set(request.eventId, request, joinRequestStore);
}

/**
 * Stores a pending join request under its id WITHOUT the duplicate scan of `savePendingJoinRequest`. For the inbox
 * handler, which already holds the loaded list and has applied the dedup and the caps itself (one scan per arrival).
 */
export async function putPendingJoinRequest(request: PendingJoinRequest): Promise<void> {
  await set(request.eventId, request, joinRequestStore);
}

/** Every pending join request across all groups. */
export async function loadAllPendingJoinRequests(): Promise<PendingJoinRequest[]> {
  const all = await entries<string, PendingJoinRequest>(joinRequestStore);
  return all.map(([, req]) => req);
}

/**
 * The live pending requests of one group. Requests past their TTL are deleted (all groups, best effort) and never
 * returned, so an expired request can no longer be shown or approved from a stale list.
 */
export async function loadPendingJoinRequests(groupId: string, now: number = Date.now()): Promise<PendingJoinRequest[]> {
  const all = await entries<string, PendingJoinRequest>(joinRequestStore);
  const expired = all.filter(([, req]) => isPendingJoinRequestExpired(req, now));
  await Promise.all(expired.map(([key]) => del(key, joinRequestStore).catch(() => undefined)));
  return all
    .filter(([, req]) => !isPendingJoinRequestExpired(req, now))
    .map(([, req]) => req)
    .filter((req) => req.groupId === groupId);
}

export async function deletePendingJoinRequest(eventId: string): Promise<void> {
  await del(eventId, joinRequestStore);
}

export async function clearPendingJoinRequestsForGroup(groupId: string): Promise<void> {
  const all = await entries<string, PendingJoinRequest>(joinRequestStore);
  const toDelete = all.filter(([, req]) => req.groupId === groupId);
  await Promise.all(toDelete.map(([key]) => del(key, joinRequestStore)));
}

/** Drop every pending join request across all groups (account-wide reset), and the seen-rumor memory with them. */
export async function clearAllPendingJoinRequests(): Promise<void> {
  await clear(joinRequestStore);
  await clear(seenRumorStore);
}

// ---------------------------------------------------------------------------
// Seen rumor ids (S12, AC-JOIN-1 / AC-JOIN-5: dedupe by rumor.id)
//
// The library delivers inbox rumors at least once (a crash, a reload or an evicted seen-set entry redelivers the same
// rumor), so the join-request inbox handler remembers every rumor id it has accepted. Without this memory a request that
// was consumed (approved) or pruned would come back on a replay. Bounded: when the cap is reached the OLDEST id (by its
// stored time, not by the storage's key order) is dropped. Only `get`/`set`/`del`/`entries` are used (no `update()`).
// ---------------------------------------------------------------------------

const seenRumorStore = createStore('few-join-request-seen', 'ids');

/** Most remembered rumor ids. */
export const SEEN_JOIN_REQUEST_CAP = 512;

/** Whether the rumor id was remembered by `markJoinRequestRumorSeen`. */
export async function hasSeenJoinRequestRumor(rumorId: string): Promise<boolean> {
  return (await get<number>(rumorId, seenRumorStore)) !== undefined;
}

/** Remembers a rumor id (idempotent: the first time is kept), evicting the oldest ids beyond the cap. */
export async function markJoinRequestRumorSeen(rumorId: string, now: number): Promise<void> {
  if ((await get<number>(rumorId, seenRumorStore)) !== undefined) return;
  await set(rumorId, now, seenRumorStore);
  const all = await entries<string, number>(seenRumorStore);
  if (all.length <= SEEN_JOIN_REQUEST_CAP) return;
  // The id just written is never the one evicted, whatever its time (equal times sort in storage order).
  const oldestFirst = all.filter(([key]) => key !== rumorId).sort((a, b) => a[1] - b[1]);
  await Promise.all(oldestFirst.slice(0, all.length - SEEN_JOIN_REQUEST_CAP).map(([key]) => del(key, seenRumorStore)));
}
