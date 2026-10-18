/**
 * Stale-local-group detection for the accept-a-Welcome path (bug:
 * stale-welcome-reinvite).
 *
 * An evicted member keeps their overlay + MLS state (no self-eviction
 * detection). When an admin re-invites them, the new Welcome must REPLACE that
 * dead state instead of being swallowed by the "already joined" short-circuit.
 *
 * Stale iff our own leaf is ABSENT from the local ratchet tree, OR the local
 * state cannot be read. Own leaf PRESENT => never stale, regardless of the
 * Welcome's epoch: an admin cannot add a member who is still in the tree, so
 * such a Welcome is forged or forked, and replacing would be a data-loss
 * vector.
 *
 * Fail direction is DELIBERATELY OPPOSITE to the leave guard
 * (leaveGroupImpl's member read and getLiveMemberPubkeys fail CLOSED toward
 * "never skip the purge / send anyway"; do not unify): here an unreadable
 * state is unusable state anyway, and keeping it would leave the user stuck
 * with a group they cannot chat in, so a throw means stale => replace.
 */
export function isLocalGroupStale(
  selfPubkey: string,
  readMembers: () => readonly string[],
): boolean {
  let members: readonly string[];
  try {
    members = readMembers();
  } catch {
    return true;
  }
  const self = selfPubkey.toLowerCase();
  return !members.some((m) => typeof m === 'string' && m.toLowerCase() === self);
}
