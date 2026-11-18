import type { CommitOpGroup, GroupOpQueue } from '../send';

export async function renameGroup(
  queue: Pick<GroupOpQueue, 'runCommit'>,
  group: { rename(name: string): Promise<void> } & CommitOpGroup<'rename'>,
  name: string,
  refresh: (groupId: string) => void,
): Promise<void> {
  await queue.runCommit(group, () => group.rename(name));
  refresh(group.id);
}
