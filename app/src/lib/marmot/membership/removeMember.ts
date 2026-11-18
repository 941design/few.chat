import type { CommitOpGroup, GroupOpQueue } from '../send';

export async function removeMember(
  queue: Pick<GroupOpQueue, 'runCommit'>,
  group: { removeMember(account: string): Promise<void> } & CommitOpGroup<'removeMember'>,
  account: string,
  refresh: (groupId: string) => void,
): Promise<void> {
  await queue.runCommit(group, () => group.removeMember(account));
  refresh(group.id);
}
