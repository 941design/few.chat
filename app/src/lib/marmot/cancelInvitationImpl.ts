/**
 * Pure implementation of the cancelPendingInvitation + isPendingMember logic.
 * Extracted from MarmotContext to enable unit testing without rendering React.
 */

import type { MemberProfile } from '@/src/types';

// Use `any` (not `unknown`) for marmot-ts opaque types so the impl can accept
// strongly-typed callables from the boundary without contravariance fights.
// The decoupling intent is preserved: the impl never reaches into these shapes.
export type MarmotGroupLike = {
  state: any;
  groupData?: { adminPubkeys?: string[] } | null;
  commit: (opts: { extraProposals: any[] }) => Promise<unknown>;
};

export type Deps = {
  getGroup: (groupId: string) => Promise<MarmotGroupLike | null>;
  loadMemberProfiles: (groupId: string) => Promise<MemberProfile[]>;
  getGroupMembers: (state: any) => string[];
  /** Returns leaf node indexes for the given pubkey in the current ratchet tree. */
  getPubkeyLeafNodeIndexes: (state: any, pubkey: string) => number[];
  Proposals: {
    proposeUpdateMetadata: (opts: { adminPubkeys: string[] }) => unknown;
  };
  persistGroup: (group: any) => Promise<void>;
  getStoredGroup: (groupId: string) => { id: string; memberPubkeys: string[]; name: string; createdAt: number; relays: string[] } | undefined;
  reloadGroups: () => Promise<void>;
  markBackupDirty: (dirty: boolean) => void;
  selfPubkeyHex: string;
};

// ts-mls proposalType constant for Remove (RFC 9420 §12.1.3)
const PROPOSAL_TYPE_REMOVE = 3;

export async function isPendingMemberImpl(
  deps: Pick<Deps, 'getGroup' | 'loadMemberProfiles' | 'getGroupMembers'>,
  groupId: string,
  pubkey: string,
): Promise<boolean> {
  const mlsGroup = await deps.getGroup(groupId);
  if (!mlsGroup) return false;
  const members = deps.getGroupMembers(mlsGroup.state);
  const isMember = members.some((pk) => pk.toLowerCase() === pubkey.toLowerCase());
  if (!isMember) return false;
  const profiles = await deps.loadMemberProfiles(groupId);
  return !profiles.some((p) => p.pubkeyHex.toLowerCase() === pubkey.toLowerCase());
}

export async function cancelPendingInvitationImpl(
  deps: Deps,
  groupId: string,
  pubkey: string,
  sendAnnouncement?: (content: string) => Promise<void>,
  // epic: group-invite-lifecycle S6 (AC-DECLINE-10) — reuses this SAME Remove
  // machinery for the receive-side decline flow, which must emit a `declined`
  // invite_lifecycle announcement instead of `invite_cancelled`. Defaulted so
  // every existing caller (the admin-initiated Cancel-Invite/Remove-Member UI
  // flow, epic invite-rescind-and-member-removal) is byte-for-byte unchanged.
  announcementKind: 'invite_cancelled' | 'declined' = 'invite_cancelled',
): Promise<{ ok: boolean; error?: string; raceDetected?: boolean; announcementError?: string }> {
  const mlsGroup = await deps.getGroup(groupId);
  if (!mlsGroup) return { ok: false, error: 'group_not_found' };

  // Gate on TREE-MEMBERSHIP ONLY (not pending-vs-confirmed). Remove Member
  // (epic invite-rescind-and-member-removal, S9) must evict CONFIRMED members —
  // in-tree WITH a profile; the prior isPendingMemberImpl pre-check (in-tree AND
  // no-profile) treated any confirmed member as raceDetected and silently
  // no-op'd, so Remove Member did nothing for its entire target population
  // (VQ-S9-P1). Not-in-tree ⇒ a co-admin already removed them ⇒ raceDetected
  // (the caller's post-removal cleanup still runs, gated on "no longer a
  // member"). Cancel Invite's population (pending/no-profile) is a strict subset
  // of in-tree, so its behavior is unchanged. isPendingMemberImpl is left intact
  // — it still backs MarmotContext.isPendingMember's label derivation.
  const isStillMember = deps
    .getGroupMembers(mlsGroup.state)
    .some((pk) => pk.toLowerCase() === pubkey.toLowerCase());
  if (!isStillMember) {
    return { ok: true, raceDetected: true };
  }

  const currentAdmins = mlsGroup.groupData?.adminPubkeys ?? [];
  const filteredAdmins = currentAdmins.filter(
    (pk) => pk.toLowerCase() !== pubkey.toLowerCase(),
  );

  // Resolve the leaf indexes before calling commit so we can build plain
  // Proposal objects directly. proposeRemoveUser() returns a ProposalAction
  // (async factory), and marmot-ts commit() pushes its resolved array value
  // as a single extraProposals element — ts-mls createCommit then receives
  // an array-as-proposal and silently drops it. Building Remove proposals
  // inline as plain objects sidesteps that nesting issue entirely.
  const leafIndexes = deps.getPubkeyLeafNodeIndexes(mlsGroup.state, pubkey);
  if (leafIndexes.length === 0) {
    // Pubkey is no longer in the ratchet tree — already removed concurrently.
    return { ok: true, raceDetected: true };
  }

  try {
    const removeProposals = leafIndexes.map((leafIndex) => ({
      proposalType: PROPOSAL_TYPE_REMOVE,
      remove: { removed: leafIndex },
    }));
    await mlsGroup.commit({
      extraProposals: [
        ...removeProposals,
        deps.Proposals.proposeUpdateMetadata({ adminPubkeys: filteredAdmins }),
      ],
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'commit_failed' };
  }

  // Re-fetch the group after commit to read the authoritative post-commit state.
  const freshGroup = await deps.getGroup(groupId);
  const storedGroup = deps.getStoredGroup(groupId);
  if (storedGroup && freshGroup) {
    const updated = {
      ...storedGroup,
      memberPubkeys: deps.getGroupMembers(freshGroup.state),
    };
    await deps.persistGroup(updated);
  } else if (!freshGroup) {
    console.warn('[Marmot] cancelPendingInvitation: freshGroup null after commit — memberPubkeys will be stale until reload');
  }
  // Always reload so the UI reflects the post-commit state even when freshGroup was null.
  await deps.reloadGroups();
  deps.markBackupDirty(true);

  if (sendAnnouncement) {
    // AC-DECLINE-10: the `declined` shape is EXACTLY {type, event, pubkey} —
    // no `by` field (unlike invite_cancelled), per the InviteLifecycleContent
    // seam contract (stories.json#seams[0]) S1 established.
    const content = announcementKind === 'declined'
      ? JSON.stringify({ type: 'invite_lifecycle', event: 'declined', pubkey })
      : JSON.stringify({ type: 'invite_cancelled', pubkey, by: deps.selfPubkeyHex });
    try {
      await sendAnnouncement(content);
    } catch (err) {
      return { ok: true, announcementError: err instanceof Error ? err.message : 'announcement_failed' };
    }
  }

  return { ok: true };
}
