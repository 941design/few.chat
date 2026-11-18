/**
 * Leave eligibility (D9, AC-LEAVE-1): pure decisions over the roster the LIBRARY group reports, and the two guarded
 * reads of that roster.
 *
 * The truth table (execution path, `decideLeave`):
 *   - the own account is the group's only member           -> `abandon` (local purge, no `leave()`, nothing sent);
 *   - the roster is readable and does not hold the account -> `abandon` (already removed: nothing to leave);
 *   - the account is an admin and no OTHER admin exists, and others are members -> `blocked` (`last-admin`: the
 *     library would reject `leave()` with `last-admin`; the app pre-checks it, no `leave()` call);
 *   - anything else                                        -> `leave`.
 * Last-member is tested before the admin rule (a last member is also a sole admin: admin-first ordering would
 * swallow the abandon case).
 *
 * The roster accessors (`members()`, `activeAdmins()`) synchronously read
 * in-memory state and can throw when it is corrupt. Every read
 * is guarded on its own (one corrupt accessor never hides the other), and the two consumers fail in OPPOSITE
 * directions on purpose. Do NOT unify them:
 *   - EXECUTION path (`decideLeave`): an unreadable roster is "unknown", never "sole member" and never "sole admin":
 *     it resolves to `leave` (fail-open). A group with corrupt state must stay deletable: the caller still runs the
 *     leave and the local purge (the purge is never skipped because a read threw). A wrong `abandon` here would
 *     delete a group the user still shares with others without telling them; a wrong `blocked` would make a corrupt
 *     group undeletable.
 *   - LIVE-MEMBER / modal path (`selectLeaveModalState`, `readLiveMembers`): an unreadable member list is
 *     `undefined` and is never offered as `abandon` (permanent deletion), only `blocked` / `confirm` (fail-closed).
 *
 * ONE LEAF PER ACCOUNT. The roster is a list of ACCOUNTS while the library's own `last-admin` rule is about LEAVES
 * ("the local leaf is the last leaf of the last active admin"). The pre-check here (`blocked`, `abandon` on a sole
 * member) equals the library's rule only because an account holds exactly one leaf in a group: the invite path
 * refuses to invite an account that is already a member (the one-leaf-per-account invite guard). Should a second
 * leaf per account ever become possible (multi-device membership), this module must be revisited: a sole-admin
 * account with a second leaf could leave, and a sole-member account could still have another leaf to stay for.
 *
 * Pure module: no React, no storage, no client imports.
 */

/** The slice of `MarmotGroup` the roster reads use. Both accessors are synchronous and may throw. */
export interface RosterReadableGroup {
  members: () => readonly string[];
  activeAdmins: () => readonly string[];
}

/** What a guarded read of the roster produced; `undefined` = unreadable (the accessor threw or answered garbage). */
interface RosterFacts {
  members: readonly string[] | undefined;
  admins: readonly string[] | undefined;
}

type LeaveDecision =
  | { action: 'abandon'; reason: 'sole-member' | 'not-a-member' }
  | { action: 'blocked'; reason: 'last-admin' }
  /** `rosterKnown: false` = the member list was unreadable: the caller must not skip the local purge (twin-read rule). */
  | { action: 'leave'; rosterKnown: boolean };

type LeaveModalState = 'abandon' | 'blocked' | 'confirm';

const lower = (hex: string): string => hex.toLowerCase();

function isAccountList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Reads the roster of a library group, each accessor guarded on its own: a throw or a malformed answer becomes
 * `undefined` (unknown), never an exception.
 */
export function readRosterFacts(group: Partial<RosterReadableGroup> | undefined | null): RosterFacts {
  const guarded = (read: (() => unknown) | undefined): readonly string[] | undefined => {
    if (!group || typeof read !== 'function') return undefined;
    try {
      const value = read.call(group);
      return isAccountList(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return { members: guarded(group?.members), admins: guarded(group?.activeAdmins) };
}

/** True when `own` is the only entry of `list`. Case-insensitive. */
function isOnly(list: readonly string[] | undefined, own: string): boolean {
  return list !== undefined && list.length === 1 && lower(list[0]) === lower(own);
}

function includes(list: readonly string[], account: string): boolean {
  const wanted = lower(account);
  return list.some((entry) => lower(entry) === wanted);
}

/**
 * EXECUTION-path decision (fail-open on unknown state, see the module doc). `own` is the lowercase hex account.
 */
export function decideLeave(facts: RosterFacts, own: string): LeaveDecision {
  const { members, admins } = facts;
  if (members === undefined) return { action: 'leave', rosterKnown: false };
  if (isOnly(members, own)) return { action: 'abandon', reason: 'sole-member' };
  if (!includes(members, own)) return { action: 'abandon', reason: 'not-a-member' };
  if (admins !== undefined && includes(admins, own) && admins.every((a) => lower(a) === lower(own))) {
    // The sole admin of a group that still has other members: the library's `last-admin`, pre-checked here.
    return { action: 'blocked', reason: 'last-admin' };
  }
  return { action: 'leave', rosterKnown: true };
}

/**
 * LIVE-MEMBER / modal-path decision (fail-closed, see the module doc): `abandon` only for a READABLE sole-member
 * roster; an unreadable member list can end in `blocked` (known sole admin) or `confirm`, never `abandon`.
 */
export function selectLeaveModalState(facts: RosterFacts, own: string): LeaveModalState {
  if (isOnly(facts.members, own)) return 'abandon';
  if (isOnly(facts.admins, own)) return 'blocked';
  return 'confirm';
}

/**
 * The live roster of a group by id for the modal path: `undefined` when the group is unknown, the lookup rejects
 * or `members()` throws (fail-closed: the caller then never offers `abandon`).
 */
export async function readLiveMembers(
  getGroup: (groupId: string) => Promise<Pick<RosterReadableGroup, 'members'> | undefined | null>,
  groupId: string,
): Promise<string[] | undefined> {
  let group: Pick<RosterReadableGroup, 'members'> | undefined | null;
  try {
    group = await getGroup(groupId);
  } catch {
    return undefined;
  }
  const members = readRosterFacts(group as Partial<RosterReadableGroup> | undefined | null).members;
  return members === undefined ? undefined : [...members];
}
