import type { CommitOpGroup, GroupOpQueue } from '../send';

interface AdminGroup extends CommitOpGroup<'setAdmins'> {
  activeAdmins(): readonly string[];
  setAdmins(accounts: readonly string[]): Promise<void>;
}

export async function grantAdmin(
  queue: Pick<GroupOpQueue, 'runCommit'>,
  group: AdminGroup,
  account: string,
  refresh: (groupId: string) => void,
): Promise<void> {
  await queue.runCommit(group, async () => {
    const admins = group.activeAdmins();
    if (!admins.includes(account)) await group.setAdmins([...admins, account]);
  });
  refresh(group.id);
}
