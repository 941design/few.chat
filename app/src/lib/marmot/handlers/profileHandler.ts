/**
 * profileHandler.ts
 *
 * RumorHandler for PROFILE_RUMOR_KIND (kind 0).
 *
 * Mirrors the PROFILE_RUMOR_KIND branch of MarmotContext.onApplicationMessage
 * exactly. All side-effect dependencies are injected — zero imports from
 * app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { PROFILE_RUMOR_KIND, parseProfilePayload, payloadToMemberProfile } from '@/src/lib/marmot/profileSync';
import type { MemberProfile, ProfileAvatar } from '@/src/types';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';

export interface ProfileHandlerDeps {
  mergeMemberProfile: (groupId: string, profile: MemberProfile) => Promise<boolean>;
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
  notifyProfileObserved: (args: { groupId: string; targetPubkey: string; observedUpdatedAt: string }) => void;
  recordRequestAnswered: (groupId: string, authorPubkey: string, timestamp: number) => Promise<void>;
  writeContactEntry: (pubkey: string, entry: { nickname: string; avatar: ProfileAvatar | null; updatedAt: string }) => void;
  setProfileVersion: (updater: (v: number) => number) => void;
  /**
   * epic: group-invite-lifecycle S3 gate-remediation (severity-4 finding,
   * AC-PROD-3/4/5). Atomic compare-and-clear for the accept-producer's
   * own-join path ONLY: reports whether a pending-direct-invite marker
   * existed for (groupId, pubkey) AND removes it, as a single step no
   * concurrent call for the same key can observe mid-way through. Replaces
   * the former hasPendingDirectInvite()-then-clearPendingDirectInvite() pair
   * on this path, which left a TOCTOU window open between two interleaved
   * own-join deliveries for the same invitee. clearPendingDirectInvite below
   * is untouched and remains the relay-on-behalf path's sole clearing
   * mechanism — this op is additive, never used on that path.
   */
  consumePendingDirectInviteMarker: (groupId: string, pubkey: string) => Promise<boolean>;
  /**
   * epic: group-invite-lifecycle S3 (DD-9, AC-PROD-3). Send capability for
   * the `accepted` announcement, threaded through registerHandlers.ts's
   * registration seam rather than imported ad hoc (architecture.md boundary
   * rule: "thread it through the registration seam — do not import a sender
   * ad hoc"). Publishes `content` as an application rumor into the group
   * this handler instance is bound to. Required (non-optional) so the no-op
   * path is unreachable in production, not merely assumed-wired.
   */
  sendAnnouncement: (content: string) => Promise<void>;
}

/**
 * Pure `InviteLifecycleContent` 'accepted' payload builder (epic:
 * group-invite-lifecycle S3, DD-9, AC-PROD-3). Mirrors S2's
 * `buildInvitedAnnouncementContent` in InviteMemberModal.tsx — constructs the
 * shape directly from named fields rather than importing parseStructured.ts,
 * so accept-producer has no cross-module reach into the 'parse' module.
 * `pubkeyHex` is canonicalized to lowercase hex (AC-STRUCT-1's hex-guard
 * contract in parseStructured.ts).
 */
export function buildAcceptedAnnouncementContent(pubkeyHex: string): string {
  return JSON.stringify({
    type: 'invite_lifecycle',
    event: 'accepted',
    pubkey: pubkeyHex.toLowerCase(),
  });
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ProfileHandlerDeps): Promise<void> {
  const profilePayload = parseProfilePayload(rumor.content);
  if (!profilePayload) return;

  // sig verified by parseProfilePayload. For relay-on-behalf the MLS sender is
  // the relayer, not the author — signedEvent.pubkey is authoritative.
  const authorPubkey = profilePayload.signedEvent?.pubkey ?? sender.pubkey;
  const memberProfile = payloadToMemberProfile(sender.pubkey, profilePayload);

  // Write to IDB first, THEN bump profileVersion so GroupDetailView re-reads
  // after the write has landed (avoids stale-read race).
  const merged = await deps.mergeMemberProfile(ctx.groupId, memberProfile);
  deps.setProfileVersion((v) => v + 1);

  // AC-PROD-3/4/5 (DD-9), S3 gate-remediation (severity-4 finding): gated on
  // this profile rumor being B's OWN transport publish (rumor.pubkey ===
  // authorPubkey) — not a third-member relay, where authorPubkey (the signed
  // author) would still equal B but rumor.pubkey (the transport sender) would
  // be the relayer instead (AC-PROD-4). Only evaluated when
  // profilePayload.signedEvent is present — otherwise authorPubkey trivially
  // falls back to rumor.pubkey and this check would be vacuously true for
  // every unsigned/legacy rumor, mirroring AC-MARKER-6's gate below.
  //
  // On the own-join branch, the check ("was B pending?") and the clear are
  // done as ONE atomic step via consumePendingDirectInviteMarker — closing the
  // TOCTOU window a separate hasPendingDirectInvite()-then-
  // clearPendingDirectInvite() pair left open: two DISTINCT-id own-join
  // profile rumors for the same B, dispatched concurrently, could both read
  // "marker present" before either cleared it, double-posting the immutable
  // `accepted` announcement. The relay-on-behalf branch (and any other
  // signed-but-not-own-join delivery) is UNCHANGED: it still clears the
  // marker via the pre-existing clearPendingDirectInvite, it just never gates
  // a post on the marker's existence.
  const isOwnJoin = Boolean(profilePayload.signedEvent && sender.pubkey === authorPubkey);
  let isFirstGenuineOwnJoin = false;
  if (isOwnJoin) {
    try {
      isFirstGenuineOwnJoin = await deps.consumePendingDirectInviteMarker(ctx.groupId, authorPubkey);
    } catch (err) {
      console.warn(`[Marmot] consumePendingDirectInviteMarker failed for ${ctx.groupId}:${authorPubkey}:`, err);
    }
  } else if (profilePayload.signedEvent) {
    // AC-MARKER-5/6: clear the pending-direct-invite marker when a signed
    // profile arrives via relay-on-behalf. Merge-result-independent — a
    // stale/duplicate resend that loses the LWW race is still proof the
    // invitee is live (AC-MARKER-5). A relay-on-behalf peer forwarding an
    // unsigned/rumor-only payload must NOT be able to clear another pubkey's
    // marker (AC-MARKER-6) — that case never reaches this branch at all,
    // since profilePayload.signedEvent is falsy for it. Best-effort: a clear
    // failure must not break profile handling.
    try {
      await deps.clearPendingDirectInvite(ctx.groupId, authorPubkey);
    } catch (err) {
      console.warn(`[Marmot] clearPendingDirectInvite failed for ${ctx.groupId}:${authorPubkey}:`, err);
    }
  }

  // AC-PROD-3: post 'accepted' at most once — only on the first genuine
  // own-join transition (a pending marker existed AND this profile rumor was
  // published by B itself, not relayed). A duplicate/reconnect redelivery of
  // B's own profile finds no pending marker (already consumed by the first
  // delivery's consumePendingDirectInviteMarker call above) and is a silent
  // no-op (AC-PROD-5). Never fires on a third-member relay (AC-PROD-4,
  // captured by isFirstGenuineOwnJoin staying false) or on a generic marker
  // removal where no marker existed in the first place.
  if (isFirstGenuineOwnJoin) {
    try {
      await deps.sendAnnouncement(buildAcceptedAnnouncementContent(authorPubkey));
    } catch (err) {
      console.warn(`[Marmot] accepted-producer sendAnnouncement failed for ${ctx.groupId}:${authorPubkey}:`, err);
    }
  }

  if (merged) {
    await deps.recordRequestAnswered(ctx.groupId, authorPubkey, Date.now());
  }

  // AC-036: cancel any pending relay timer for this profile's author.
  if (profilePayload.signedEvent) {
    deps.notifyProfileObserved({
      groupId: ctx.groupId,
      targetPubkey: authorPubkey,
      observedUpdatedAt: memberProfile.updatedAt,
    });
  }

  // Cache in global contact cache for cross-group availability.
  deps.writeContactEntry(authorPubkey, {
    nickname: memberProfile.nickname,
    avatar: memberProfile.avatar ?? null,
    updatedAt: memberProfile.updatedAt,
  });
}

export function createProfileHandler(deps: ProfileHandlerDeps): RumorHandler {
  return {
    kind: PROFILE_RUMOR_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}
