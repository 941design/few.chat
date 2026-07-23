/**
 * pendingInvitations.ts — Pending invitation queue (Walled Garden v2, S2).
 *
 * Persists inbound MLS Welcome invitations that the user has not yet
 * accepted or declined. Welcomes are enqueued after NIP-59 validation and
 * only removed when the user explicitly accepts or declines.
 *
 * Design constraints (AC-STRUCT-3):
 *   - MUST be pure localStorage — no IDB, no NDK, no React, no context.
 *   - MUST be synchronous (reads) or best-effort synchronous (writes).
 *   - MUST NOT import from idb-keyval, any NDK package, React,
 *     app/src/context/, or app/src/components/.
 *
 * Storage key:
 *   lp_pendingInvitations_v1  — JSON array of PendingInvitation
 *
 * Caps (AC-INVITE-3):
 *   Global: 256 total entries (drop oldest on overflow, log dm:walled-garden-invite-drop-overflow)
 *   Per-inviter: 8 entries (drop oldest from that inviter, log dm:walled-garden-invite-drop-per-inviter)
 */

import { createLogger } from '@/src/lib/logger';

const logger = createLogger('pendingInvitations');

const PENDING_INVITES_KEY = 'lp_pendingInvitations_v1';
const GLOBAL_CAP = 256;
const PER_INVITER_CAP = 8;

// ─── Public types ─────────────────────────────────────────────────────────────

export type PendingInvitation = {
  /** unwrapped rumor eventId — unique per Welcome */
  id: string;
  /** hex pubkey of the inviter (from the seal layer) */
  inviterPubkeyHex: string;
  /** Date.now() at enqueue time */
  receivedAt: number;
  /** JSON.stringify of the kind-444 rumor — replayed into joinGroupFromWelcome on accept */
  welcomeEventJson: string;
  /**
   * MLS group id (hex), surfaced pre-join via `readWelcomeGroupInfo`'s
   * `groupContext.groupId` (AC-DECLINE-1) — the same hex encoding
   * `MarmotGroup.idStr` uses post-join, so a decline gift wrap's `groupId`
   * field lines up with what the receive side looks up by. Empty string when
   * unavailable (e.g. the pre-join read failed, or — for entries stored
   * before this field existed — a legacy record normalized by `readRaw`
   * below).
   */
  groupId: string;
  /**
   * Whether the Welcome's gift-wrap seal was authenticated at receipt
   * (AC-DECLINE-2) — the same `authenticated` result `unwrapGiftWrap`
   * already computes. Declining an invitation gates the gift-wrapped decline
   * send on this flag (AC-DECLINE-4): `false` (or missing, for a legacy
   * entry stored before this field existed) MUST NEVER trigger a send —
   * fail-closed, so an invitation whose inviter identity was never
   * cryptographically verified can't receive an addressed decline DM.
   */
  authenticated: boolean;
};

// ─── Module-level listener store (for useSyncExternalStore) ──────────────────

let _snapshot: ReadonlyArray<PendingInvitation> = [];
const _listeners = new Set<() => void>();

function _emit() {
  _listeners.forEach((l) => l());
}

/** Subscribe to invitation queue changes — for useSyncExternalStore. */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/** Snapshot accessor — for useSyncExternalStore. Initialised lazily. */
export function getSnapshot(): ReadonlyArray<PendingInvitation> {
  return _snapshot;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isLocalStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readRaw(): PendingInvitation[] {
  if (!isLocalStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(PENDING_INVITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is Record<string, unknown> =>
          v !== null &&
          typeof v === 'object' &&
          typeof (v as Record<string, unknown>).id === 'string' &&
          typeof (v as Record<string, unknown>).inviterPubkeyHex === 'string' &&
          typeof (v as Record<string, unknown>).receivedAt === 'number' &&
          typeof (v as Record<string, unknown>).welcomeEventJson === 'string',
      )
      .map(
        (v): PendingInvitation => ({
          id: v.id as string,
          inviterPubkeyHex: v.inviterPubkeyHex as string,
          receivedAt: v.receivedAt as number,
          welcomeEventJson: v.welcomeEventJson as string,
          // Backward-compat (AC-DECLINE-1/2): entries persisted before this
          // story landed lack these two fields entirely. `groupId` defaults
          // to '' (a decline send with an empty groupId is a no-op the
          // receive side can't act on, which is an acceptable degrade for a
          // pre-migration entry). `authenticated` defaults to `false` —
          // fail-closed, so a legacy entry can NEVER trigger a decline
          // gift-wrap send (AC-DECLINE-4), matching the same guarantee a
          // freshly-enqueued unauthenticated Welcome gets.
          groupId: typeof v.groupId === 'string' ? v.groupId : '',
          authenticated: typeof v.authenticated === 'boolean' ? v.authenticated : false,
        }),
      );
  } catch {
    return [];
  }
}

function writeRaw(invitations: PendingInvitation[]): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(invitations));
    _snapshot = invitations;
    _emit();
  } catch {
    // Non-fatal — storage may be full or unavailable
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all pending invitations from localStorage.
 *
 * @returns A ReadonlyArray of PendingInvitation. Empty when nothing stored or
 *   localStorage is unavailable.
 */
export function listPendingInvitations(): ReadonlyArray<PendingInvitation> {
  const list = readRaw();
  // Keep in-memory snapshot in sync when called (e.g. on initial render)
  _snapshot = list;
  return list;
}

/**
 * Adds a pending invitation to the queue. Enforces:
 *   - Per-inviter cap: max 8 entries per inviterPubkeyHex (AC-INVITE-3).
 *     Oldest per-inviter entry is dropped on overflow.
 *   - Global cap: max 256 total entries (AC-INVITE-3).
 *     Oldest global entry is dropped on overflow.
 * Idempotent: if an invitation with the same id is already queued, it is NOT
 *   duplicated (prevents re-enqueueing on page reload if the seen-set check
 *   fails or is bypassed in tests).
 * Never throws.
 */
export function enqueuePendingInvitation(invite: PendingInvitation): void {
  try {
    const current = readRaw();

    // Idempotency: skip if already enqueued
    if (current.some((inv) => inv.id === invite.id)) return;

    let updated = [...current];

    // Per-inviter cap: drop oldest per-inviter entry when at cap
    const fromInviter = updated.filter((inv) => inv.inviterPubkeyHex === invite.inviterPubkeyHex);
    if (fromInviter.length >= PER_INVITER_CAP) {
      logger.info('dm:walled-garden-invite-drop-per-inviter', {
        inviter: invite.inviterPubkeyHex.slice(0, 8),
        perInviterCount: fromInviter.length,
      });
      // Remove the oldest from that inviter (lowest receivedAt)
      const oldestFromInviter = fromInviter.reduce((a, b) =>
        a.receivedAt < b.receivedAt ? a : b,
      );
      updated = updated.filter((inv) => inv.id !== oldestFromInviter.id);
    }

    // Global cap: drop oldest global entry when at cap
    if (updated.length >= GLOBAL_CAP) {
      logger.info('dm:walled-garden-invite-drop-overflow', {
        inviter: invite.inviterPubkeyHex.slice(0, 8),
        queueSize: updated.length,
      });
      const oldest = updated.reduce((a, b) => (a.receivedAt < b.receivedAt ? a : b));
      updated = updated.filter((inv) => inv.id !== oldest.id);
    }

    updated.push(invite);
    writeRaw(updated);
  } catch {
    // Never throw
  }
}

/**
 * Removes a pending invitation by id.
 * Idempotent: no-op if the id is not in the queue.
 * Never throws.
 */
export function removePendingInvitation(id: string): void {
  try {
    const current = readRaw();
    const updated = current.filter((inv) => inv.id !== id);
    if (updated.length !== current.length) {
      writeRaw(updated);
    }
  } catch {
    // Never throw
  }
}

/**
 * Returns the total number of pending invitations.
 */
export function countPendingInvitations(): number {
  return readRaw().length;
}

/**
 * Returns the number of pending invitations from a specific inviter.
 */
export function pendingInvitationsForInviter(inviterPubkeyHex: string): number {
  return readRaw().filter((inv) => inv.inviterPubkeyHex === inviterPubkeyHex).length;
}

// ─── Initialise snapshot on module load ──────────────────────────────────────
// Populate the module-level snapshot so useSyncExternalStore callers get a
// non-empty initial state without an extra read on the first subscribe.
if (typeof window !== 'undefined') {
  try {
    _snapshot = readRaw();
  } catch {
    // SSR or unavailable storage — leave empty
  }
}
