/**
 * What MarmotContext does after each processed group event: resync the stored
 * members and name from MLS state, then auto-commit unapplied proposals.
 * Extracted so it can be tested without rendering the provider (bug
 * replace-does-not-await-onmemberschanged).
 */
import { membersChanged } from '@/src/lib/marmot/memberGuard';

export interface MembersChangedDeps<G extends { name: string; memberPubkeys: string[] }> {
  /** Whether the group's subscription is still the current one. */
  isCurrent: () => boolean;
  /** Makes consumers (e.g. isAdmin) re-read group metadata. */
  bumpVersion: () => void;
  /** The stored group, read fresh (the callback outlives its effect run). */
  stored: () => G | undefined;
  /** The group name in the MLS metadata. */
  mlsName: () => string | undefined;
  persist: (group: G) => Promise<void>;
  reload: () => Promise<void>;
  /**
   * Whether the auto-commit may still run once the store writes were awaited:
   * false while the group is being replaced or the account changed. Narrower
   * than isCurrent on purpose: an effect restart alone keeps the same group
   * instance, and dropping the commit then would leave members unable to send
   * until the next processed event.
   */
  mayCommit: () => boolean;
  hasUnappliedProposals: () => boolean;
  commit: () => Promise<unknown>;
}

/**
 * Resolves once everything it started has settled, the auto-commit included, so
 * a replace tracking it waits for the commit too. Never commits on a group
 * that is being replaced (see mayCommit): the replace may have started while
 * the store writes were awaited.
 */
export async function syncOnMembersChanged<G extends { name: string; memberPubkeys: string[] }>(
  currentMembers: string[],
  deps: MembersChangedDeps<G>,
): Promise<void> {
  if (!deps.isCurrent()) return;
  // Always bump so consumers re-read group metadata after any MLS commit, even
  // when the member count is unchanged.
  deps.bumpVersion();
  const stored = deps.stored();
  if (stored) {
    // Resync membership AND the group name from authoritative MLS metadata
    // after any processed commit. A rename lands here for remote members:
    // proposeUpdateMetadata({ name }) is silent on the timeline, so this is the
    // path that makes a rename visible to everyone (the separate kind-9 notice
    // is display-only).
    const mlsName = deps.mlsName();
    const nameChanged = typeof mlsName === 'string' && mlsName.length > 0 && mlsName !== stored.name;
    const memberChange = membersChanged(stored.memberPubkeys, currentMembers);
    if (nameChanged || memberChange) {
      await deps.persist({
        ...stored,
        ...(memberChange ? { memberPubkeys: currentMembers } : {}),
        ...(nameChanged ? { name: mlsName } : {}),
      });
      await deps.reload();
    }
  }
  if (!deps.mayCommit()) return;
  // WORKAROUND: auto-commit unapplied proposals (e.g. leave proposals) so all
  // members can send application messages. Only works when the local user is
  // admin. Fails silently if admin promotion was lost — see sendRumorSafe comment.
  if (deps.hasUnappliedProposals()) {
    await deps.commit().catch((err: unknown) => {
      console.debug('[Marmot] auto-commit unapplied proposals failed:', err);
    });
  }
}
