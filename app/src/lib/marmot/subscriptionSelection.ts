/**
 * Whether a subscription run still has to subscribe a group (bug
 * subscription-generation-resubscribes-all): after a stale-Welcome replace the
 * current run subscribes only what is missing instead of rebuilding every
 * group's subscription. Checked per group as the loop reaches it, since the
 * state changes while earlier groups are set up.
 */
export interface SubscriptionState {
  /** A live subscription exists. */
  subscribed: (groupId: string) => boolean;
  /** A stale-Welcome replace of the group is in progress. */
  replacing: (groupId: string) => boolean;
  /** This run is already setting the group's subscription up. */
  starting: (groupId: string) => boolean;
}

export function needsSubscription(groupId: string, state: SubscriptionState): boolean {
  return !state.subscribed(groupId) && !state.replacing(groupId) && !state.starting(groupId);
}
