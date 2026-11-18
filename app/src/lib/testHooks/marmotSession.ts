import type { AccountClient } from '@/src/lib/marmot/client';
import type { GroupRumorInput } from '@/src/lib/marmot/history';
import { subscribeOwnRowStatus, type OwnRowStatusChanged } from '@/src/lib/pendingOwnSends';

type DispatchInfo = { groupId: string; kind: number; content: string; rumorId: string };

function testHooks() {
  const browser = window as Window & { __fewTest?: {
    marmotSession?: { listGroupIds(): Promise<string[] | null> };
    beforeGroupDispatch?: (info: DispatchInfo) => Promise<void> | void;
    beforeGroupLeave?: (groupId: string) => Promise<void> | void;
    beforeLiveGroupHistory?: (groupId: string) => Promise<void> | void;
    afterInvitationAccept?: (groupId: string) => Promise<void> | void;
  } };
  return browser.__fewTest ??= {};
}

export function beforeGroupLeave(groupId: string) {
  return testHooks().beforeGroupLeave?.(groupId);
}

export function beforeLiveGroupHistory(groupId: string) {
  return testHooks().beforeLiveGroupHistory?.(groupId);
}

export function afterInvitationAccept(groupId: string) {
  return testHooks().afterInvitationAccept?.(groupId);
}

export function installMarmotSessionTestHook(account: AccountClient): () => void {
  const hooks = testHooks();
  const session = {
    async listGroupIds() {
      if (!account.handle.leaseHeld()) return null;
      const groups = await account.handle.client.groups.list();
      return account.handle.leaseHeld() ? groups.map(({ id }) => id) : null;
    },
    observeOwnRowStatus(groupId: string, observe: (event: OwnRowStatusChanged) => void) {
      return subscribeOwnRowStatus(account.handle.pubkey, groupId, observe);
    },
    async setGroupDescription(groupId: string, description: string) {
      if (!account.handle.leaseHeld()) throw new Error('Group lease unavailable');
      const group = await account.handle.client.groups.get(groupId);
      if (!group || !account.handle.leaseHeld()) throw new Error('Group unavailable');
      await group.synced();
      if (!account.handle.leaseHeld()) throw new Error('Group lease unavailable');
      await group.rename(group.name, { description });
      return group.description;
    },
  };
  hooks.marmotSession = session;
  return () => {
    if (hooks.marmotSession === session) delete hooks.marmotSession;
  };
}

export function beforeGroupDispatch({ groupId, rumor }: GroupRumorInput) {
  return testHooks().beforeGroupDispatch?.({
    groupId, kind: rumor.kind, content: rumor.content, rumorId: rumor.id,
  });
}
