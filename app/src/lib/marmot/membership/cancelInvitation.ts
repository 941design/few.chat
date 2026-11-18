import type { DeclineMarkerStore } from '../pendingDirectInviteStorage';
import type { CommitOpGroup, GroupOpQueue } from '../send';

export async function cancelInvitation(
  queue: Pick<GroupOpQueue, 'runCommit'>,
  group: { removeMember(account: string): Promise<void> } & CommitOpGroup<'removeMember'>,
  invitation: { account: string; inviteeRef: string },
  markers: Pick<DeclineMarkerStore, 'get' | 'clearIfRef'>,
  refresh: (groupId: string) => void,
): Promise<boolean> {
  const { account, inviteeRef } = invitation;
  const groupId = group.id;
  let removed = false;

  try {
    await queue.runCommit(group, async () => {
      const current = await markers.get(groupId, account);
      if (current?.inviteeRef !== inviteeRef || current.declined || current.viaJoinRequest) return;
      await group.removeMember(account);
      removed = true;
      await markers.clearIfRef(groupId, account, inviteeRef);
    });
  } catch (error) {
    if (removed) refresh(groupId);
    throw error;
  }
  refresh(groupId);
  return removed;
}
