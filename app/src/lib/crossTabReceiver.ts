/**
 * crossTabReceiver.ts — what a tab does when ANOTHER tab reports a store
 * change (multi-tab design S0). Pure dispatch over injected actions so the
 * mapping is unit-testable without React; MarmotContext wires the actions to
 * its existing revision counters and reload functions.
 *
 * Each action only re-reads storage (bump a counter whose consumers re-derive
 * from storage, or reload the group list); none writes, so a received change
 * cannot bounce back as a new post.
 */

import { suspendBackups } from '@/src/lib/backup/suspension';
import { subscribeAccountChanged, type StoreChangedMessage } from '@/src/lib/crossTab';

export type CrossTabReceiverActions = {
  bumpBlockedPeers: () => void;
  bumpKnownPeers: () => void;
  bumpContacts: () => void;
  reloadGroups: () => void;
  bumpGroupData: () => void;
  bumpChat: () => void;
  bumpPolls: () => void;
  /** Re-read one reaction thread (id = its namespace key) into the cache. */
  refreshReactions: (key: string) => void;
};

export function applyStoreChanged(message: StoreChangedMessage, actions: CrossTabReceiverActions): void {
  switch (message.store) {
    case 'blocked':
      actions.bumpBlockedPeers();
      return;
    case 'known':
      actions.bumpKnownPeers();
      return;
    case 'contacts':
      actions.bumpContacts();
      return;
    case 'groups':
      actions.reloadGroups();
      actions.bumpGroupData();
      return;
    case 'chat':
      actions.bumpChat();
      return;
    case 'polls':
      actions.bumpPolls();
      return;
    case 'reactions':
      // Unscoped reaction notices are never posted; without a thread there is
      // nothing to refresh (a blanket cache drop would reopen the
      // badge-revival race, see reactions/api.ts#refreshReactionsFromStorage).
      if (message.id !== undefined) actions.refreshReactions(message.id);
      return;
  }
}

/**
 * Sequence guard for overlapping reloads: a reload numbered `seq` may apply
 * its result only if no reload started after it (`latest` is the newest
 * started sequence number).
 */
export function isLatestReload(seq: number, latest: number): boolean {
  return seq === latest;
}

/**
 * Reloads this tab when ANOTHER tab wipes the local account data: everything
 * this tab holds in memory (reaction cache, group list, chat, identity)
 * belongs to an account that no longer exists, and the reload comes up on
 * whatever is stored now. The posting tab never receives its own notice
 * (BroadcastChannel does not echo to the posting object), so it does not
 * react to itself. A burst of notices reloads once. Returns the uninstall
 * function.
 */
export function installAccountChangedReload(reload: () => void): () => void {
  let reloading = false;
  return subscribeAccountChanged(() => {
    if (reloading) return;
    reloading = true;
    // The unload flush of the reloading page would back up the wiped storage
    // under this tab's old key.
    suspendBackups();
    reload();
  });
}
