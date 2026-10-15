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

import type { StoreChangedMessage } from '@/src/lib/crossTab';

export type CrossTabReceiverActions = {
  bumpBlockedPeers: () => void;
  bumpKnownPeers: () => void;
  bumpContacts: () => void;
  reloadGroups: () => void;
  bumpGroupData: () => void;
  bumpChat: () => void;
  bumpPolls: () => void;
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
