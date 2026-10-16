/**
 * Pure implementation of the leaveGroup operation.
 * Extracted from MarmotContext to enable unit testing without rendering React.
 *
 * Mirrors grantAdminImpl.ts: uses the Deps-injection pattern; has zero
 * imports from app/src/context/ (AC-BOUND-1); never imports marmot-ts directly
 * (getGroupMembers is injected via Deps from the MarmotContext boundary).
 *
 * sendRumorSafe and buildRumor are module-private functions in MarmotContext
 * (not marmot-ts exports), so — per the same zero-context-imports boundary —
 * they arrive here as Deps fields rather than being exported and imported back.
 */

import { isLastMember } from '@/src/lib/marmot/leaveEligibility';
import { LEAVE_INTENT_KIND, serialiseLeaveIntent } from '@/src/lib/marmot/leaveSync';

// Use `any` (not `unknown`) for marmot-ts opaque types so the impl can accept
// strongly-typed callables from the boundary without contravariance fights.
// The decoupling intent is preserved: the impl never reaches into these shapes.
type MarmotGroupLike = {
  state: any;
  sendApplicationRumor: (rumor: any) => Promise<unknown>;
};

/**
 * Upper bound on how long the MLS-state destroy waits for the kind-9 departure
 * announcement to settle. The send awaits relay acks; destroying earlier
 * would discard the keys it is encrypting/publishing with.
 */
export const LEAVE_DESTROY_SEND_TIMEOUT_MS = 5_000;

/** Resolves when `promise` settles (either way) or after `ms`, whichever is first. */
function settledOrTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

type Deps = {
  getGroup: (groupId: string) => Promise<MarmotGroupLike | null>;
  getGroupMembers: (state: any) => string[];
  sendRumorSafe: (group: MarmotGroupLike, rumor: any) => Promise<void>;
  buildRumor: (kind: number, content: string, pubkey: string, tags?: string[][]) => any;
  removeGroupFromStorage: (groupId: string) => Promise<void>;
  clearMemberProfiles: (groupId: string) => Promise<void>;
  clearMessages: (groupId: string) => Promise<void>;
  clearPollData: (groupId: string) => Promise<void>;
  clearGroupMedia: (groupId: string) => Promise<void>;
  clearProfileRequestMemos: (groupId: string) => Promise<void>;
  clearUnreadGroup: (groupId: string) => void;
  clearPendingJoinRequestsForGroup: (groupId: string) => Promise<void>;
  clearInviteLinksForGroup: (groupId: string) => Promise<void>;
  /**
   * Clears every pending-direct-invite marker scoped to exactly this group
   * (epic: invite-rescind-and-member-removal, story S3, AC-MARKER-9's
   * leave-fan-out half). This is the PER-GROUP clear
   * (`clearPendingDirectInvitesForGroup` from `pendingDirectInviteStorage.ts`)
   * — never the account-wide `clearAllPendingDirectInvites()` sentinel, which
   * is exclusively `clearAllGroupData`'s (S2) call to make. Called
   * unconditionally alongside the other leak-fixing clears below, regardless
   * of whether this leave is the last-member (abandon) path — the group's
   * local data is being torn down either way.
   */
  clearPendingDirectInvitesForGroup: (groupId: string) => Promise<void>;
  /**
   * Clears the group's invite-expiry notification badge (epic:
   * invite-link-lifecycle, story S4, Design Decision 12, AC-DEEPLINK-4).
   * Called unconditionally alongside `clearInviteLinksForGroup` in the same
   * purge sequence below — never gated behind a separate, independently
   * skippable step — so a dangling badge can never deep-link to a group
   * the admin no longer belongs to.
   */
  clearInviteExpiries: (groupId: string) => void;
  /**
   * Drops the group's pending write-ahead rumor-journal entries
   * (rumorJournal.ts, bug: mls-message-lost-on-unload-after-ingest) so
   * decrypted plaintext of a left group is not kept — or replayed — locally.
   */
  clearRumorJournalForGroup: (groupId: string) => Promise<void>;
  /**
   * Drops the group's durable pending member removals
   * (pendingRemovalStorage.ts, bug: pending-member-removals-not-persisted).
   * Best-effort: a failure is warned and never skips the rest of the purge —
   * a left group is never resubscribed, so a stale row is never acted on.
   */
  clearPendingRemovalsForGroup: (groupId: string) => Promise<void>;
  /**
   * Left-group tombstone (leftGroupTombstones.ts, bug:
   * left-groups-keep-mls-state-forever). Written BEFORE the overlay delete and
   * deleted only after the MLS state is destroyed, so an interrupted leave is
   * finished by the startup sweep.
   */
  putLeftGroupTombstone: (groupId: string) => Promise<void>;
  deleteLeftGroupTombstone: (groupId: string) => Promise<void>;
  /**
   * Destroys the group's local MLS state (keys, history, snapshots; local-only,
   * nothing is sent). The boundary wires welcomeSubscription.destroyLeftGroupState,
   * which runs under the per-group join lock and skips a group that has an
   * overlay again (re-joined in the meantime).
   */
  destroyGroupState: (groupId: string) => Promise<unknown>;
  reloadGroups: () => Promise<void>;
  markBackupDirty: (dirty: boolean) => void;
};

/**
 * Leave the group identified by `groupId`, on behalf of `selfPubkeyHex`.
 *
 * Contracts:
 *  - Send-skip (AC-SEND-1/2): re-derives last-member from the LIVE MLS state it
 *    fetches itself (getGroupMembers(mlsGroup.state), never a caller-passed
 *    value — AC-STRUCT-3). When the caller is the group's last member, neither
 *    the kind-13 leave-intent nor the kind-9 announcement is sent. Otherwise
 *    both fire, unchanged from prior behavior.
 *  - Fail-closed in the OPPOSITE direction from the eligibility/modal decision:
 *    when mlsGroup can't be read, members is undefined, isLastMember is false,
 *    and the send branch is taken (send-anyway) — a redundant send into an
 *    already-empty group is the safe failure mode here, whereas silently
 *    skipping a real departure is not.
 *  - Purge hygiene (AC-PURGE-1/2): the two-clear leak fix
 *    (clearPendingJoinRequestsForGroup, clearInviteLinksForGroup) runs
 *    unconditionally, after the send block, on BOTH the abandon and the
 *    normal-leave path. `clearInviteExpiries` (epic: invite-link-lifecycle,
 *    S4) runs in the same unconditional block, immediately after
 *    clearInviteLinksForGroup (AC-DEEPLINK-4). `clearPendingDirectInvitesForGroup`
 *    (epic: invite-rescind-and-member-removal, S3, AC-MARKER-9) runs in the
 *    same unconditional block, scoped to exactly the group being left.
 *  - MLS-state destroy (bug: left-groups-keep-mls-state-forever): a tombstone
 *    is written before the overlay delete; the group's MLS state is destroyed
 *    (destroyGroupState) once the kind-9 announcement settles or
 *    LEAVE_DESTROY_SEND_TIMEOUT_MS passes — without awaiting it, so purge and
 *    navigation stay immediate — or inline when nothing was sent; then the
 *    tombstone is deleted. A failed destroy keeps the tombstone for the
 *    startup sweep.
 *  - Never throws to the caller: a failed kind-13 send is caught and logged;
 *    the purge always proceeds. Returns `true` unconditionally, matching the
 *    pre-extraction signature.
 *  - Zero imports from app/src/context/ (AC-BOUND-1).
 */
export async function leaveGroupImpl(
  deps: Deps,
  groupId: string,
  selfPubkeyHex: string,
  selfDisplayName?: string,
): Promise<boolean> {
  const mlsGroup = await deps.getGroup(groupId);

  // AC-STRUCT-3: members is derived from a fresh read of live MLS state made
  // within this call — never a value threaded through from a caller's earlier
  // (e.g. modal-open) read.
  let members: string[] | undefined;
  try {
    members = mlsGroup ? deps.getGroupMembers(mlsGroup.state) : undefined;
  } catch {
    // Fail-closed (DD-7): a corrupt/unreadable member read defaults lastMember
    // to false ⇒ send anyway (harmless into an empty group) AND the purge still
    // runs. Mirrors getLiveMemberPubkeys's guard on the modal path (DD-6).
    members = undefined;
  }
  const lastMember = isLastMember(members, selfPubkeyHex);
  // The kind-9 departure announcement, when one is sent; the MLS-state destroy
  // waits for it.
  let departureSent: Promise<unknown> | undefined;

  if (mlsGroup && selfPubkeyHex && !lastMember) {
    // AC-SEND-2: kind-13 leave-intent via sendRumorSafe (handles unapplied-
    // proposals retry loop internally). If it still throws, log and continue —
    // the purge must not be blocked.
    const kind13Rumor = deps.buildRumor(
      LEAVE_INTENT_KIND,
      serialiseLeaveIntent({ pubkey: selfPubkeyHex }),
      selfPubkeyHex,
    );
    try {
      await deps.sendRumorSafe(mlsGroup, kind13Rumor);
    } catch (err) {
      console.warn('[Marmot] leaveGroup: kind-13 send failed, proceeding with purge:', err);
    }

    // AC-SEND-2: kind-9 chat announcement — fire-and-forget. Failure must not
    // block the purge or navigation. The leaver's own display name rides along
    // so the announcement reads "<name> left the group" for every recipient,
    // regardless of whether they hold the leaver's MemberProfile. This is the
    // leaver's own name over the encrypted MLS group channel (never a public
    // broadcast), so it carries no privacy or cross-identity-spoofing risk.
    const trimmedName = selfDisplayName?.trim();
    const kind9Rumor = deps.buildRumor(
      9,
      JSON.stringify(
        trimmedName
          ? { type: 'leave_intent', pubkey: selfPubkeyHex, name: trimmedName }
          : { type: 'leave_intent', pubkey: selfPubkeyHex },
      ),
      selfPubkeyHex,
    );
    departureSent = mlsGroup.sendApplicationRumor(kind9Rumor);
    departureSent.catch(() => {});
  }
  // AC-SEND-1: solo group — lastMember is true, neither send fires.

  // Tombstone BEFORE the overlay delete: from here on an interruption is
  // finished by the startup sweep. A failed write must not skip the purge.
  try {
    await deps.putLeftGroupTombstone(groupId);
  } catch (err) {
    console.warn('[Marmot] leaveGroup: left-group tombstone write failed, proceeding with purge:', err);
  }

  // AC-PURGE-1: purge sequence — runs unconditionally on both paths.
  await deps.removeGroupFromStorage(groupId);
  await deps.clearMemberProfiles(groupId);
  await deps.clearMessages(groupId);
  // Best-effort (finding leave-clearpolldata-unguarded): a poll storage
  // failure must not abort the rest of the purge, the MLS-state destroy or the
  // reload. Residual: the left group's poll rows may survive (nothing reads
  // them for a group without an overlay; clearAllPollData removes them).
  try {
    await deps.clearPollData(groupId);
  } catch (err) {
    console.warn('[Marmot] leaveGroup: poll data cleanup failed, proceeding with purge:', err);
  }
  await deps.clearGroupMedia(groupId);
  await deps.clearProfileRequestMemos(groupId);
  deps.clearUnreadGroup(groupId);
  // AC-PURGE-1/2: leak-fixing clears, unconditional on both paths.
  await deps.clearPendingJoinRequestsForGroup(groupId);
  await deps.clearInviteLinksForGroup(groupId);
  // AC-MARKER-9: per-group leave fan-out clear — scoped to groupId only, the
  // account-wide sibling clear lives exclusively in clearAllGroupData (S2).
  await deps.clearPendingDirectInvitesForGroup(groupId);
  // AC-DEEPLINK-4: same unconditional purge call, not a separate step —
  // see the Deps field doc comment above.
  deps.clearInviteExpiries(groupId);
  await deps.clearRumorJournalForGroup(groupId);
  try {
    await deps.clearPendingRemovalsForGroup(groupId);
  } catch (err) {
    console.warn('[Marmot] leaveGroup: pending-removal cleanup failed, proceeding with purge:', err);
  }

  // Destroy the MLS state (keys, history) — local-only. With a departure
  // announcement in flight, only after it settles (or the timeout): the send
  // still needs the keys, and navigation must not wait on relay acks. Without
  // one (abandon, no group, no identity), inline.
  const destroyAndDropTombstone = async (): Promise<void> => {
    try {
      await deps.destroyGroupState(groupId);
      await deps.deleteLeftGroupTombstone(groupId);
    } catch (err) {
      // Tombstone kept: the startup sweep retries.
      console.warn('[Marmot] leaveGroup: MLS state destroy (or tombstone delete) failed, left for the startup sweep:', err);
    }
  };
  if (departureSent) {
    void settledOrTimeout(departureSent, LEAVE_DESTROY_SEND_TIMEOUT_MS).then(destroyAndDropTombstone);
  } else {
    await destroyAndDropTombstone();
  }

  await deps.reloadGroups();
  deps.markBackupDirty(true);
  return true;
}
