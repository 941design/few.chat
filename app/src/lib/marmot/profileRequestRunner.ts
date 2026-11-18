/**
 * profileRequestRunner.ts — Relay-on-behalf logic + proactive stale-profile sweep.
 *
 * Epic: member-profile-discovery-and-relay-on-behalf | Story 03 / 05
 *
 * Story 06 fills in the actual relay-on-behalf implementation for
 * handleIncomingProfileRequest:
 *   - Cache the target's last-known SignedProfileEvent from group storage.
 *   - Start a randomised backoff timer (5–30 s) before emitting.
 *   - Cancel any pending timer when the target's profile arrives another way.
 *
 * This file is a no-op stub for handleIncomingProfileRequest so the dispatcher
 * arm compiles and the story boundary is clean. Story 06 replaces that body.
 */

import type { MemberProfile } from '@/src/types';
import type { ProfileRequestMemo, ProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import {
  isProfileStale,
  pickBackoffMs,
  serialiseProfileRequest,
  shouldEmitRequest,
} from '@/src/lib/marmot/profileRequestSync';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected from MarmotContext — the actual group+rumor send function. */
type SendRumorFn = (groupId: string, content: string) => Promise<void>;

// ---------------------------------------------------------------------------
// sweepStaleProfiles  (story 05)
// ---------------------------------------------------------------------------

interface SweepStaleProfilesArgs {
  /** Group IDs to sweep. Each group's MLS member list is walked independently. */
  groupIds: string[];
  /** Our own pubkey — skipped unconditionally. */
  selfPubkeyHex: string;
  /** Unix ms timestamp for staleness and dedupe evaluation. */
  now: number;
  /**
   * Returns the pubkeyHex array for a group's MLS members.
   * Must include self (filtering is done inside sweepStaleProfiles).
   */
  getGroupMembers: (groupId: string) => Promise<string[]>;
  /**
   * Loads the stored MemberProfile for (groupId, pubkeyHex), or undefined
   * if no profile has been received yet.
   */
  loadProfile: (groupId: string, pubkeyHex: string) => Promise<MemberProfile | undefined>;
  /** Loads the dedupe memo for (groupId, targetPubkey), or null if absent. */
  loadMemo: (groupId: string, targetPubkey: string) => Promise<ProfileRequestMemo | null>;
  /**
   * Records that a PROFILE_REQUEST_KIND rumor was emitted for the given member.
   * Implementations should persist to IndexedDB (e.g. profileRequestStorage).
   */
  recordEmitted: (groupId: string, targetPubkey: string, now: number) => Promise<void>;
  /**
   * Sends the PROFILE_REQUEST_KIND rumor content within the given group.
   * The content is the JSON string from serialiseProfileRequest.
   */
  sendRumor: (groupId: string, content: string) => Promise<void>;
}

/**
 * Walks every group's MLS member list, filters stale members, and emits
 * exactly one PROFILE_REQUEST_KIND rumor per eligible member.
 *
 * Design:
 * - Skips `selfPubkeyHex` (never request our own profile).
 * - Skips members with a stored profile that is NOT stale (isProfileStale gate).
 * - Skips members whose memo indicates we should not emit (shouldEmitRequest gate).
 * - For each passing member: calls recordEmitted, then sendRumor.
 *
 * The function is fully side-effect-injected so it remains unit-testable
 * and the runner module stays free of marmot-ts/React imports.
 */
export async function sweepStaleProfiles(args: SweepStaleProfilesArgs): Promise<void> {
  const { groupIds, selfPubkeyHex, now, getGroupMembers, loadProfile, loadMemo, recordEmitted, sendRumor } = args;

  for (const groupId of groupIds) {
    const members = await getGroupMembers(groupId);

    for (const targetPubkey of members) {
      // Never request our own profile
      if (targetPubkey === selfPubkeyHex) continue;

      const [stored, memo] = await Promise.all([loadProfile(groupId, targetPubkey), loadMemo(groupId, targetPubkey)]);

      // Staleness gate: request only if missing or older than PROFILE_STALENESS_MS
      if (!isProfileStale(stored, now)) continue;

      // Dedup gate: skip if shouldEmitRequest returns false
      if (!shouldEmitRequest(memo, now)) continue;

      // Record first so dedupe is updated even if sendRumor partially fails.
      // If sendRumor fails we still have a correct memo for next time.
      await recordEmitted(groupId, targetPubkey, now);

      const content = serialiseProfileRequest({
        targetPubkey,
        sinceUpdatedAt: stored?.updatedAt,
      });

      await sendRumor(groupId, content);
    }
  }
}

// ---------------------------------------------------------------------------
// Pending relay timer state (module-level, keyed by "groupId:targetPubkey")
// ---------------------------------------------------------------------------

type PendingRelay = {
  timerId: ReturnType<typeof setTimeout>;
  /** The cached profile's updatedAt at scheduling time — used for cancellation. */
  scheduledForUpdatedAt: string;
};

const pendingRelayTimers = new Map<string, PendingRelay>();

function relayKey(groupId: string, targetPubkey: string): string {
  return `${groupId}:${targetPubkey}`;
}

// ---------------------------------------------------------------------------
// handleIncomingProfileRequest
// ---------------------------------------------------------------------------

/**
 * Called by the PROFILE_REQUEST_KIND dispatcher arm when the targetPubkey
 * in the request is NOT our own pubkey (relay peer path).
 *
 * Loads the cached signedEvent for the target, schedules a backoff relay timer
 * (5–30 s), and fires the cached profile content via sendRumor when it fires.
 * notifyProfileObserved cancels the timer if a fresh answer arrives first.
 *
 * AC-033 / AC-034 / AC-037 / AC-038 (story 06)
 */
export async function handleIncomingProfileRequest(args: {
  groupId: string;
  payload: ProfileRequestPayload;
  selfPubkeyHex: string;
  now: number;
  loadProfile: (groupId: string, targetPubkey: string) => Promise<MemberProfile | undefined>;
  sendRumor: SendRumorFn;
}): Promise<void> {
  const { groupId, payload, loadProfile, sendRumor } = args;

  const cached = await loadProfile(groupId, payload.targetPubkey);

  // AC-037: no signedEvent cached — legacy profile, cannot relay
  if (!cached?.signedEvent) return;

  // AC-038: requester already has something at least as fresh — skip
  if (payload.sinceUpdatedAt && cached.updatedAt <= payload.sinceUpdatedAt) return;

  const key = relayKey(groupId, payload.targetPubkey);

  // Cancel any existing pending relay for this target before scheduling a new one
  const existing = pendingRelayTimers.get(key);
  if (existing) clearTimeout(existing.timerId);

  const scheduledForUpdatedAt = cached.updatedAt;
  // Capture the content string so the timer closure doesn't hold a live reference
  const relayContent = JSON.stringify(cached.signedEvent);

  const timerId = setTimeout(() => {
    pendingRelayTimers.delete(key);
    void sendRumor(groupId, relayContent);
  }, pickBackoffMs());

  pendingRelayTimers.set(key, { timerId, scheduledForUpdatedAt });
}

// ---------------------------------------------------------------------------
// notifyProfileObserved
// ---------------------------------------------------------------------------

/**
 * Called from the PROFILE_RUMOR_KIND dispatcher arm when a profile answer
 * arrives. Cancels any pending relay timer for (groupId, targetPubkey) when
 * the observed profile is at least as fresh as the one we planned to relay,
 * suppressing a redundant rebroadcast.
 *
 * AC-035 / AC-036 (story 06)
 */
export function notifyProfileObserved(args: {
  groupId: string;
  targetPubkey: string;
  observedUpdatedAt: string;
}): void {
  const key = relayKey(args.groupId, args.targetPubkey);
  const pending = pendingRelayTimers.get(key);
  if (!pending) return;
  if (args.observedUpdatedAt >= pending.scheduledForUpdatedAt) {
    clearTimeout(pending.timerId);
    pendingRelayTimers.delete(key);
  }
}
