import { createStore, del } from 'idb-keyval';
import { clearAllGroupData as clearGroupMetadata, clearMemberProfiles, deleteGroup, loadAllGroups } from './groupStorage';
import { clearUnreadGroup, clearJoinRequestGroup, clearInviteExpiries } from '../unreadStore';
import { clearProfileRequestMemos } from './profileRequestStorage';
import { clearPendingDirectInvitesForGroup, clearSponsorPendingDirectInvites } from './pendingDirectInviteStorage';
import { clearAllGroupMessages, clearMessages } from './chatPersistence';
import { clearAllGroupPollData, clearPollData } from './pollPersistence';
import { clearAllGroupMedia, clearGroupMedia } from './mediaPersistence';
import { clearAllGroupHistory } from './history';
import { clearAllPendingJoinRequests, clearPendingJoinRequestsForGroup } from './joinRequestStorage';
import { clearAllOutboundJoinRequests } from './outboundJoinRequests';
import { clearAllInviteLinks, clearInviteLinksForGroup } from './inviteLinkStorage';
import { clearAllGroupReactions, clearReactionsForGroup, purgeHeldReactionsForGroup } from '../reactions/api';
import { clearGroupMessageEditsState, clearMessageEditsStateForThread } from '../messageEdits/api';

/** Call only after the account's history backend and group writers are disposed. */
export async function clearAllGroupData(pubkey: string): Promise<void> {
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) throw new TypeError('clearAllGroupData: invalid pubkey');
  const account = pubkey.toLowerCase();
  const overlay = await loadAllGroups();
  const otherGroupIds = new Set(overlay.filter((group) => group.accountPubkey && group.accountPubkey !== account).map(({ id }) => id));
  if (otherGroupIds.size > 0) {
    await clearSponsorPendingDirectInvites(account);
    // Only groups with a known owner or pre-adoption rows belong to this cleanup.
    // Keep their overlay until all group stores clear so an interrupted wipe can retry.
    for (const { id } of overlay.filter((group) => !group.accountPubkey || group.accountPubkey === account)) {
      if (otherGroupIds.has(id)) {
        await deleteGroup(id, account);
        continue;
      }
      await settleClears([
        () => clearMemberProfiles(id),
        () => clearProfileRequestMemos(id),
        () => clearPendingDirectInvitesForGroup(id, account),
        () => clearMessages(id),
        () => clearPollData(id),
        () => clearGroupMedia(id),
        () => clearPendingJoinRequestsForGroup(id),
        () => clearInviteLinksForGroup(id),
        () => clearReactionsForGroup(id),
        () => purgeHeldReactionsForGroup(id),
        () => clearMessageEditsStateForThread(id),
        () => clearUnreadGroup(id),
        () => clearJoinRequestGroup(id),
        () => clearInviteExpiries(id),
      ]);
      await deleteGroup(id, account);
    }
    await settleClears([
      () => clearAllGroupHistory(account),
      () => clearAllOutboundJoinRequests(account),
      () => del(account, createStore('few-invite-contexts', 'contexts')),
    ]);
    return;
  }
  await settleClears([
    () => clearGroupMetadata(account),
    () => clearAllGroupMessages(),
    () => clearAllGroupPollData(),
    () => clearAllGroupMedia(),
    () => clearAllGroupHistory(account),
    () => clearAllPendingJoinRequests(),
    () => clearAllOutboundJoinRequests(account, true),
    () => clearAllInviteLinks(),
    () => clearAllGroupReactions(),
    () => clearGroupMessageEditsState(),
    () => del(account, createStore('few-invite-contexts', 'contexts')),
  ]);
}

async function settleClears(tasks: readonly (() => unknown)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Failed to clear group data');
}
