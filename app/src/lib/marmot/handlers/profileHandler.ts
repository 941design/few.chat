/**
 * Applies kind-0 group profiles using the history sink's authenticated sender.
 */

import { PROFILE_RUMOR_KIND, parseProfilePayload, payloadToMemberProfile } from '@/src/lib/marmot/profileSync';
import { type OneShotGate } from '@/src/lib/marmot/envelopeVerifier';
import type { MemberProfile, ProfileAvatar } from '@/src/types';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext } from '@/src/lib/marmot/handlers/types';
import { assertPorts, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import type { GroupRumorInput } from '@/src/lib/marmot/history';

interface ProfileHandlerDeps {
  mergeMemberProfile: (groupId: string, profile: MemberProfile) => Promise<boolean>;
  noteForwardedInviteProfile: (groupId: string, pubkey: string) => Promise<void>;
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
   * the former hasPendingDirectInvite()-then-noteForwardedInviteProfile() pair
   * on this path, which left a TOCTOU window open between two interleaved
   * own-join deliveries for the same invitee. noteForwardedInviteProfile below
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
   * that delivered the profile. This capability is required.
   */
  sendAnnouncement: (content: string, groupId: string) => Promise<void>;
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

/** Effects supplied by the history-sink wrapper. */
interface SinkHooks {
  /** Receives the 'accepted' announcement content instead of sending it; the sink wrapper enqueues the send (non-awaited) at once, so no later step can lose it. */
  announce: (content: string) => void;
  /** Un-consumes an inner id when the apply failed, so the sink's retry is not mistaken for a duplicate delivery. */
  release: (innerEventId: string) => void;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ProfileHandlerDeps, oneShot: OneShotGate, sink: SinkHooks): Promise<void> {
  const profilePayload = parseProfilePayload(rumor.content);
  if (!profilePayload) return;

  // A signed profile can arrive in distinct rumors through direct delivery
  // and forwarding. Gate its side effects by the embedded signed event ID.
  if (profilePayload.signedEvent && !oneShot.tryConsume(profilePayload.signedEvent.id)) {
    return;
  }

  // Release the consumed id on failure so a sink retry can apply it.
  try {
    await applyProfile(profilePayload, ctx, sender, deps, sink.announce);
  } catch (err) {
    // The sink retries a rejected row; without this the retry would find its
    // inner id consumed and finish as a silent no-op, losing the profile.
    if (profilePayload.signedEvent) sink.release(profilePayload.signedEvent.id);
    throw err;
  }
}

/** The effects of a verified, newly consumed profile payload. `announce`: sink path (see SinkHooks). */
async function applyProfile(
  profilePayload: NonNullable<ReturnType<typeof parseProfilePayload>>,
  ctx: DispatcherContext,
  sender: AuthenticatedSender,
  deps: ProfileHandlerDeps,
  announce: (content: string) => void,
): Promise<void> {
  // sig verified by parseProfilePayload. For relay-on-behalf the MLS sender is
  // the relayer, not the author — signedEvent.pubkey is authoritative.
  const authorPubkey = profilePayload.signedEvent?.pubkey ?? sender.pubkey;
  const memberProfile = payloadToMemberProfile(sender.pubkey, profilePayload);

  // Write to IDB first, THEN bump profileVersion so GroupDetailView re-reads
  // after the write has landed (avoids stale-read race).
  const merged = await deps.mergeMemberProfile(ctx.groupId, memberProfile);
  deps.setProfileVersion((v) => v + 1);

  // AC-PROD-3/4/5 (DD-9), S3 gate-remediation (severity-4 finding): gated on
  // this profile rumor being B's OWN transport publish (sender.pubkey ===
  // authorPubkey) — not a third-member relay, where authorPubkey (the signed
  // author) would still equal B but sender.pubkey (the authenticated transport
  // sender, S1 seam) would be the relayer instead (AC-PROD-4). NB sender.pubkey
  // is the MLS-authenticated transport sender (marmot-ts 0.7.0), never a raw
  // rumor.pubkey read. Only
  // evaluated when profilePayload.signedEvent is present — otherwise authorPubkey
  // trivially falls back to sender.pubkey and this check would be vacuously true
  // for every unsigned/legacy rumor, mirroring AC-MARKER-6's gate below.
  //
  // On the own-join branch, the check ("was B pending?") and the clear are
  // done as ONE atomic step via consumePendingDirectInviteMarker — closing the
  // TOCTOU window a separate hasPendingDirectInvite()-then-
  // noteForwardedInviteProfile() pair left open: two DISTINCT-id own-join
  const isOwnJoin = Boolean(profilePayload.signedEvent && sender.pubkey === authorPubkey);
  if (!isOwnJoin && profilePayload.signedEvent) {
    // Keep the invite reference for decline recovery when a group member
    // forwards an old signed profile for an invitee who has not joined.
    try {
      await deps.noteForwardedInviteProfile(ctx.groupId, authorPubkey);
    } catch (err) {
      console.warn(`[Marmot] noteForwardedInviteProfile failed for ${ctx.groupId}:${authorPubkey}:`, err);
    }
  }

  // Best-effort (remediation round 1): it only stops this device's own
  // profile-request runner from re-asking for a profile it already has. A
  // failure costs at most one redundant request, which a peer answers — not
  // worth keeping the rumor journaled, and a replay could not complete it
  // anyway (the merge then reports no change).
  if (merged) {
    try {
      await deps.recordRequestAnswered(ctx.groupId, authorPubkey, Date.now());
    } catch (err) {
      console.warn(`[Marmot] recordRequestAnswered failed for ${ctx.groupId}:${authorPubkey}; the profile may be re-requested:`, err);
    }
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

  // Last, so that nothing after the marker's consumption can fail or be lost: the own-join check and the
  // marker clear are ONE atomic step (consumePendingDirectInviteMarker), and the 'accepted' announcement
  // follows it synchronously. A crash or throw before this point leaves the marker in place, so the replay
  // (the sink re-runs the row; the merge above is idempotent) finds it and announces; once it is consumed
  // nothing but the announcement remains.
  // A throw propagates: the row stays undispatched, the sink retries it, the marker is still there (the consume is
  // atomic: it either cleared it or did not run) and the retry announces exactly once.
  const isFirstGenuineOwnJoin = isOwnJoin ? await deps.consumePendingDirectInviteMarker(ctx.groupId, authorPubkey) : false;

  // AC-PROD-3: post 'accepted' at most once — only on the first genuine
  // own-join transition (a pending marker existed AND this profile rumor was
  // published by B itself, not relayed). A duplicate/reconnect redelivery of
  // B's own profile finds no pending marker (already consumed by the first
  // delivery's consumePendingDirectInviteMarker call above) and is a silent
  // no-op (AC-PROD-5). Never fires on a third-member relay (AC-PROD-4,
  // captured by isFirstGenuineOwnJoin staying false) or on a generic marker
  // removal where no marker existed in the first place.
  if (isFirstGenuineOwnJoin) {
    announce(buildAcceptedAnnouncementContent(authorPubkey));
  }
}

/** Deps of the history-sink path. `enqueue` and the `retractProfile`-free contract are REQUIRED / documented below. */
interface ProfileGroupHandlerDeps extends ProfileHandlerDeps {
  /** The owned client FIFO (`ClientJobQueue['enqueue']`): the 'accepted' announcement send is queued on it. */
  enqueue: (job: () => Promise<void>, groupId: string) => void;
}

/** Capacity of the sink path's one-shot gate (oldest entries are evicted). */
const SINK_GATE_CAPACITY = 1024;

const PROFILE_GROUP_PORTS = [
  'mergeMemberProfile', 'noteForwardedInviteProfile', 'notifyProfileObserved', 'recordRequestAnswered',
  'writeContactEntry', 'setProfileVersion', 'consumePendingDirectInviteMarker', 'sendAnnouncement', 'enqueue',
] as const;

/**
 * Kind-0 handler on the history-sink path (sender = the MLS-authenticated
 * account). dispatch applies the profile: the merge is last-writer-wins, the
 * pending-invite marker is an atomic compare-and-clear, so a redelivery
 * converges; a failed apply un-consumes its inner id so the sink's retry
 * applies it. The one follow-up WRITE, the 'accepted' announcement, is
 * enqueued on the client FIFO as the call's last action (re-entrancy rule), after the pending-invite
 * marker was consumed as the handler's last step — so nothing can fail between consuming the marker and
 * enqueueing the announcement; a send failure is warned (the announcement is best-effort, as before).
 *
 * retract is a deliberate no-op: a stored member profile is the sender's
 * last-writer-wins self-description, so the withdrawn rumor's effect cannot be
 * told apart from earlier ones, and the contact cache / profile observer have
 * already been fed (effects already emitted are never undone, AC-WDR-6). The
 * sender's next profile supersedes it.
 */
export function createProfileGroupHandler(deps: ProfileGroupHandlerDeps): GroupKindHandler {
  assertPorts('createProfileGroupHandler', deps, PROFILE_GROUP_PORTS);
  // The sink path's gate: same one-shot semantics, plus release-on-failure.
  // The handler serves ALL groups, so the key is `${groupId}:${innerId}` (the
  // same signed profile legitimately arrives once per group). Bounded LRU.
  const consumed = new Set<string>();
  const gateKey = (groupId: string, id: string) => `${groupId}:${id}`;
  const makeGate = (groupId: string): OneShotGate => ({
    tryConsume(id) {
      const key = gateKey(groupId, id);
      if (consumed.has(key)) return false;
      consumed.add(key);
      while (consumed.size > SINK_GATE_CAPACITY) {
        const oldest = consumed.values().next().value as string;
        consumed.delete(oldest);
      }
      return true;
    },
  });
  return {
    kind: PROFILE_RUMOR_KIND,
    async dispatch(input: GroupRumorInput, env) {
      const { ctx, sender } = toHandlerArgs(input, env);
      // The 'accepted' announcement is a client write: it is captured here and enqueued as the LAST action of
      // this call (after every await of the handler, also when a step threw), never earlier: an account-scope
      // call from a job that starts inside the still-live library frame rejects with `reentrant`. The marker is
      // consumed as the handler's last step, so once it is gone nothing but this enqueue remains; a row that
      // failed earlier left the marker in place and its retry announces (a replay never adds a second one).
      let announcement: string | undefined;
      try {
        await handle(input.rumor as ApplicationRumor, ctx, sender, deps, makeGate(ctx.groupId), {
          announce: (content) => {
            announcement = content;
          },
          release: (id) => void consumed.delete(gateKey(ctx.groupId, id)),
        });
      } finally {
        if (announcement !== undefined) {
          const content = announcement;
          deps.enqueue(async () => {
            try {
              await deps.sendAnnouncement(content, ctx.groupId);
            } catch (err) {
              console.warn(`[Marmot] accepted-producer sendAnnouncement failed for ${ctx.groupId}:`, err);
            }
          }, ctx.groupId);
        }
      }
    },
    async retract() {
      // See the doc comment: nothing to undo.
    },
  };
}
