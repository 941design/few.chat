/**
 * purgeLocalGroup (seam `GroupDataPurger`): the ONE local teardown of a group the
 * account no longer belongs to (removed by an admin, left, abandoned as the last member, absent from the library at
 * startup). Local only: it sends nothing and publishes nothing (privacy invariant).
 *
 * Order (every step idempotent, a second call is a no-op):
 *   0. the re-join guard, BEFORE anything is touched: if the library holds the group with the own account in a
 *      READABLE roster (a new Welcome was accepted since the removal / leave / startup finding that triggered this
 *      purge), nothing is deleted at all. Only the sole-member abandon (`options.ownAccountIsMember`) may purge a
 *      group whose roster holds the own account. An unreadable roster never counts as "re-joined".
 *   1. `tracker.forgetGroup` - the own-send tracker drops the group's rows and timers, so no `failed/retry` row of
 *      a group that is going away is left behind.
 *   2. the library step: `group.abandon()` (purges the library's group store; the library also calls the history
 *      sink's `purge` from it), then an explicit `history.purge(groupId)` (no dependence on the library calling it;
 *      covers a group that is not loaded). The sink waits (bounded) for dispatches still running and retracts them
 *      with reason `purged` when they finish, so a hung own-message dispatch released after the purge leaves no
 *      chat row. An `abandon()` failure ABORTS the purge before anything app-side is deleted: the group is then
 *      still intact and listed, and the caller can retry or restore it.
 *      UNDELETABLE GROUP: when `getGroup` keeps rejecting (twice in a row) with anything but the client-teardown
 *      code `disposed`, the library state cannot be loaded: the library step is skipped and the app-side data is
 *      purged, but the purge does NOT claim success and does NOT remove the overlay row. The overlay row is the retry
 *      key (the startup reconciliation and a user retry run the purge again once the library state loads or is
 *      repaired), so it stays, marked `unloadable` through the optional `markUnloadable` port, and the purge rejects
 *      with a `PurgeError` carrying `unloadable: true` and the `get-group` failure (also reported through `onError`).
 *      The UI can show the group as unloadable and offer a retry; the leaver restores it with the leave-failed toast.
 *      A `disposed` rejection (account teardown) aborts the purge untouched.
 *   3. a second re-join guard after the abandon (a Welcome accepted while the purge ran): the app-side deletion is
 *      skipped.
 *   4. the app-side data: chat rows, message-edit aux state (its own step: a failure keeps the retry key), reaction
 *      rows and the held-reaction queue, poll/vote rows and their pending queues, media, member profiles,
 *      profile-request memos, unread state, pending join requests, invite links and expiry badges, pending
 *      direct-invite markers, invite contexts. Best effort: every step runs, a failing one is collected.
 *   5. the overlay row LAST, and only when nothing before failed: the overlay is the retry key. A group the library no
 *      longer holds but whose overlay row survives is purged again by the startup reconciliation.
 *   6. `onPurged` (the UI reload), always.
 * A failure of 1-5 is reported by rejecting `PurgeError` after the remaining steps ran.
 *
 * PURGE / ACCEPT EXCLUSION: a per-group async lock (`withGroupLock(groupId, fn)`, FIFO, one holder at a time, a
 * rejecting holder releases it) serialises the purge with accepting an invitation to the same group id (the purge
 * would delete the new membership's first messages, the accept would race the library state the purge abandons).
 * The purge runs INSIDE the lock, so it waits for an in-flight accept; `createInvitationActions.accept` runs the
 * library `accept` inside the same lock (and `createAutoAccept` goes through those actions), so an accept waits for
 * an in-flight purge. The lock is NOT re-entrant: code holding it must not call `purgeLocalGroup` / `withGroupLock`
 * for the same group id. `isPurging(groupId)` / `whenPurged(groupId)` expose the in-flight (running or queued) run.
 *
 * Concurrent calls for one group share one run (the `groupRemoved` event, the startup check and a finishing leave
 * can overlap). The purge makes account-scope client calls (`getGroup`, `abandon`): it must never run inside a library
 * frame (listener, inbox handler, history sink); `groupNotifications` enqueues it on the client job queue.
 *
 * Ports are validated at construction (TypeError naming the port): a purger missing a clear never degrades to "purge
 * less" silently.
 *
 * Pure module: no React, no browser API, no client import; the stores arrive as ports.
 */

/** The slice of `MarmotGroup` the purge uses. `members` only feeds the re-join guard and may throw. */
export interface AbandonableGroup {
  abandon: () => Promise<void>;
  members?: () => readonly string[];
}

type PurgeStepName =
  | 'other-owner'
  | 'forget-tracker'
  | 'get-group'
  | 'abandon'
  | 'history'
  | 'messages'
  | 'message-edits'
  | 'reactions'
  | 'held-reactions'
  | 'polls'
  | 'media'
  | 'member-profiles'
  | 'profile-request-memos'
  | 'unread'
  | 'join-requests'
  | 'invite-links'
  | 'invite-expiries'
  | 'direct-invite-markers'
  | 'invite-contexts'
  | 'mark-unloadable'
  | 'overlay'
  | 'on-purged';

interface PurgeStepFailure {
  step: PurgeStepName;
  error: unknown;
}

/** One or more purge steps failed. The steps after the failing one still ran (except after `abandon`, see the module doc). */
export class PurgeError extends Error {
  readonly groupId: string;
  readonly failures: readonly PurgeStepFailure[];
  /** The library state of the group could not be loaded (undeletable group): the overlay row was kept, see the module doc. */
  readonly unloadable: boolean;
  constructor(groupId: string, failures: readonly PurgeStepFailure[], unloadable = false) {
    super(`purgeLocalGroup(${groupId}): ${failures.map((f) => `${f.step}: ${messageOf(f.error)}`).join('; ')}`);
    this.name = 'PurgeError';
    this.groupId = groupId;
    this.failures = failures;
    this.unloadable = unloadable;
  }
}

interface PurgeOptions {
  /**
   * A solo abandon requires the reloaded roster to hold only the own account.
   * Every other caller leaves a group untouched whose readable roster holds the own account.
   */
  ownAccountIsMember?: boolean;
}

/** The seam shape (`GroupDataPurger`). */
export interface GroupDataPurger {
  purgeLocalGroup: (groupId: string, options?: PurgeOptions) => Promise<void>;
}

/** What `createLocalGroupPurger` returns: the seam plus the in-flight view the accept paths use. */
export interface LocalGroupPurger extends GroupDataPurger {
  /** True while a purge of `groupId` runs. */
  isPurging: (groupId: string) => boolean;
  /** Resolves (never rejects) once no purge of `groupId` runs; immediately when none does. */
  whenPurged: (groupId: string) => Promise<void>;
  /**
   * Runs `fn` while holding the group's lock (the purge holds it too): FIFO per group id, other ids are unaffected,
   * the lock is released when `fn` settles (resolved or rejected). Not re-entrant.
   */
  withGroupLock: <T>(groupId: string, fn: () => Promise<T>) => Promise<T>;
}

export interface PurgeLocalGroupDeps {
  /** Lowercase hex account (re-join guard). */
  ownPubkey: string;
  /** `client.groups.get`: `undefined` = the library does not hold the group; a rejection fails the purge. */
  getGroup: (groupId: string) => Promise<AbandonableGroup | undefined>;
  /** Protect group-id keyed app data while another account has an overlay. Failures retain the retry overlay. */
  hasOtherOwner?: (groupId: string) => Promise<boolean>;
  /** The app history sink (`AppHistoryBackend.purge`). */
  history: { purge: (groupId: string) => Promise<void> };
  /** The own-send tracker (`OwnRowTracker.forgetGroup`). */
  tracker: { forgetGroup: (groupId: string) => void };
  clearMessages: (groupId: string) => Promise<void>;
  /**
   * The group's message-edit aux state (`messageEdits/api.clearMessageEditsStateForThread`). `clearMessages` runs it
   * too but swallows its failure; this step propagates it so a failure keeps the overlay retry key.
   */
  clearMessageEdits: (groupId: string) => Promise<void>;
  /** The group's reaction rows (`reactions/api.clearReactionsForGroup`). */
  clearReactions: (groupId: string) => Promise<void>;
  /** The group's held-reaction queue (`reactions/api.purgeHeldReactionsForGroup`). */
  purgeHeldReactions: (groupId: string) => Promise<void>;
  clearPollData: (groupId: string) => Promise<void>;
  clearGroupMedia: (groupId: string) => Promise<void>;
  clearMemberProfiles: (groupId: string) => Promise<void>;
  clearProfileRequestMemos: (groupId: string) => Promise<void>;
  clearUnread: (groupId: string) => void | Promise<void>;
  clearPendingJoinRequests: (groupId: string) => Promise<void>;
  clearInviteLinks: (groupId: string) => Promise<void>;
  clearInviteExpiries: (groupId: string) => void | Promise<void>;
  /** `pendingDirectInviteStorage.clearPendingDirectInvitesForGroup` (the per-group clear, never the account-wide one). */
  clearPendingDirectInvites: (groupId: string) => Promise<void>;
  /** Clears the current sponsor's invite state when the shared group stores are retained. */
  clearSponsorDirectInvites?: (groupId: string) => Promise<void>;
  /** The held invite contexts of the group (`InviteContextStore.discard({ groupId })`). */
  clearInviteContexts: (groupId: string) => Promise<void>;
  /** Removes the group's overlay row (`groupStorage.deleteGroup`). Runs last. */
  removeOverlay: (groupId: string) => Promise<void>;
  /**
   * Marks the KEPT overlay row of an undeletable group `unloadable` (the library state cannot be loaded), so the UI
   * can offer a retry. Optional: without it the kept row is simply retried by the startup reconciliation.
   */
  markUnloadable?: (groupId: string) => Promise<void>;
  /** The UI reload: the group is gone from the list (or stays, after a failed purge). Never throws into the purge. */
  onPurged: (groupId: string) => void;
  /** Failed steps, reported as they happen (default `console.warn`). */
  onError?: (groupId: string, failure: PurgeStepFailure) => void;
}

// The ownership check and markUnloadable are optional ports.
const REQUIRED_PORTS = [
  'getGroup',
  'history',
  'tracker',
  'clearMessages',
  'clearMessageEdits',
  'clearReactions',
  'purgeHeldReactions',
  'clearPollData',
  'clearGroupMedia',
  'clearMemberProfiles',
  'clearProfileRequestMemos',
  'clearUnread',
  'clearPendingJoinRequests',
  'clearInviteLinks',
  'clearInviteExpiries',
  'clearPendingDirectInvites',
  'clearInviteContexts',
  'removeOverlay',
  'onPurged',
] as const;

/** TypeError naming the first missing function port (and the missing members of the two object ports). */
function assertFunctionPorts(factory: string, deps: object, names: readonly string[]): void {
  for (const name of names) {
    const port = (deps as Record<string, unknown>)[name];
    if (port === undefined || port === null) throw new TypeError(`${factory}: port '${name}' is required`);
    if (typeof port !== 'function' && typeof port !== 'object') throw new TypeError(`${factory}: port '${name}' must be a function or object`);
  }
}

function requireMember(factory: string, owner: string, value: unknown, member: string): void {
  if (typeof (value as Record<string, unknown> | undefined)?.[member] !== 'function') {
    throw new TypeError(`${factory}: port '${owner}.${member}' is required`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `abandon()` on a group that is already gone: the library answers `not-a-member`; that is the goal state. */
function isAlreadyGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'not-a-member';
}

/** The client-teardown code: a rejection carrying it is the account going away, not an unloadable group. */
function isTeardown(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'disposed';
}

function holdsAccount(group: AbandonableGroup, own: string): boolean {
  try {
    const members = group.members?.();
    return Array.isArray(members) && members.some((m) => typeof m === 'string' && m.toLowerCase() === own);
  } catch {
    // An unreadable roster never counts as "re-joined": the purge is not skipped because a read threw.
    return false;
  }
}

export function createLocalGroupPurger(deps: PurgeLocalGroupDeps): LocalGroupPurger {
  const factory = 'createLocalGroupPurger';
  if (typeof deps?.ownPubkey !== 'string' || deps.ownPubkey === '') throw new TypeError(`${factory}: ownPubkey is required`);
  assertFunctionPorts(factory, deps, REQUIRED_PORTS);
  for (const name of REQUIRED_PORTS) {
    if (name === 'history') requireMember(factory, 'history', deps.history, 'purge');
    else if (name === 'tracker') requireMember(factory, 'tracker', deps.tracker, 'forgetGroup');
    else if (typeof deps[name] !== 'function') throw new TypeError(`${factory}: port '${name}' must be a function`);
  }
  const own = deps.ownPubkey.toLowerCase();
  const reporter =
    deps.onError ??
    ((groupId: string, failure: PurgeStepFailure) => console.warn(`[membership] purgeLocalGroup(${groupId}): step '${failure.step}' failed`, failure.error));
  /** A throwing reporter never breaks the purge nor replaces its outcome. */
  const report = (groupId: string, failure: PurgeStepFailure): void => {
    try {
      reporter(groupId, failure);
    } catch {
      /* ignored */
    }
  };
  const inFlight = new Map<string, Promise<void>>();
  /** Tail of each group's lock queue; removed when the queue drains. The tail promise never rejects. */
  const lockTails = new Map<string, Promise<void>>();

  function withGroupLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const previous = lockTails.get(groupId) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    lockTails.set(groupId, tail);
    void tail.then(() => {
      if (lockTails.get(groupId) === tail) lockTails.delete(groupId);
    });
    return result;
  }

  /** `getGroup`, retried once: a transient rejection is not "unloadable". */
  async function loadGroup(groupId: string): Promise<{ group: AbandonableGroup | undefined } | { error: unknown }> {
    let last: unknown;
    for (let tries = 0; tries < 2; tries++) {
      try {
        return { group: await deps.getGroup(groupId) };
      } catch (error) {
        last = error;
        if (isTeardown(error)) break;
      }
    }
    return { error: last };
  }

  async function run(groupId: string, options: PurgeOptions): Promise<void> {
    const failures: PurgeStepFailure[] = [];
    const attempt = async (step: PurgeStepName, fn: () => unknown): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (error) {
        const failure = { step, error };
        failures.push(failure);
        report(groupId, failure);
        return false;
      }
    };
    try {
      // Re-join guard first: nothing (not even the tracker) is touched for a group the account belongs to again.
      const loaded = await loadGroup(groupId);
      let group: AbandonableGroup | undefined;
      let unloadable = false;
      if ('error' in loaded) {
        const failure = { step: 'get-group' as const, error: loaded.error };
        if (isTeardown(loaded.error)) {
          failures.push(failure);
          report(groupId, failure);
          throw new PurgeError(groupId, failures);
        }
        // Undeletable group: the app-side data is purged, the overlay row is kept and marked, the purge rejects.
        failures.push(failure);
        report(groupId, failure);
        unloadable = true;
      } else {
        group = loaded.group;
        if (group !== undefined) {
          if (options.ownAccountIsMember) {
            const members = group.members?.();
            if (members?.length !== 1 || members[0].toLowerCase() !== own) {
              throw new PurgeError(groupId, [{ step: 'abandon', error: new Error('Group is no longer a solo group') }]);
            }
          } else if (holdsAccount(group, own)) return;
        }
      }

      await attempt('forget-tracker', () => deps.tracker.forgetGroup(groupId));

      // Library step. Its failure aborts before anything app-side is deleted.
      if (group !== undefined) {
        const held = group;
        const abandoned = await attempt('abandon', async () => {
          try {
            await held.abandon();
          } catch (error) {
            if (!isAlreadyGone(error)) throw error;
          }
        });
        if (!abandoned) throw new PurgeError(groupId, failures);
      }
      const sinkPurged = await attempt('history', () => deps.history.purge(groupId));

      // Second re-join guard: a new Welcome for this group was accepted while the purge ran; its data is not ours.
      if (!unloadable) {
        let rejoined: AbandonableGroup | undefined;
        if (await attempt('get-group', async () => void (rejoined = await deps.getGroup(groupId)))) {
          if (rejoined !== undefined && holdsAccount(rejoined, own)) return;
        }
      }

      // Owner-scoped history and contexts still need cleanup, but group-id keyed stores
      // belong to every account with an overlay. A failed lookup must fail closed.
      let otherOwner = false;
      const ownershipChecked = await attempt('other-owner', async () => {
        otherOwner = await deps.hasOtherOwner?.(groupId) ?? false;
      });
      const results = [sinkPurged, ownershipChecked];
      const { clearSponsorDirectInvites } = deps;
      if (ownershipChecked && !otherOwner) results.push(
        await attempt('messages', () => deps.clearMessages(groupId)),
        await attempt('message-edits', () => deps.clearMessageEdits(groupId)),
        await attempt('reactions', () => deps.clearReactions(groupId)),
        await attempt('held-reactions', () => deps.purgeHeldReactions(groupId)),
        await attempt('polls', () => deps.clearPollData(groupId)),
        await attempt('media', () => deps.clearGroupMedia(groupId)),
        await attempt('member-profiles', () => deps.clearMemberProfiles(groupId)),
        await attempt('profile-request-memos', () => deps.clearProfileRequestMemos(groupId)),
        await attempt('unread', () => deps.clearUnread(groupId)),
        await attempt('join-requests', () => deps.clearPendingJoinRequests(groupId)),
        await attempt('invite-links', () => deps.clearInviteLinks(groupId)),
        await attempt('invite-expiries', () => deps.clearInviteExpiries(groupId)),
        await attempt('direct-invite-markers', () => deps.clearPendingDirectInvites(groupId)),
      );
      else if (clearSponsorDirectInvites) {
        results.push(await attempt('direct-invite-markers', () => clearSponsorDirectInvites(groupId)));
      }
      results.push(await attempt('invite-contexts', () => deps.clearInviteContexts(groupId)));
      // An unloadable group keeps its overlay row (the retry key) and is marked so the UI can offer a retry.
      if (unloadable && deps.markUnloadable) await attempt('mark-unloadable', () => deps.markUnloadable!(groupId));
      // The overlay row is the retry key: it goes only when everything before it went.
      if (!unloadable && results.every(Boolean) && !failures.some((f) => f.step === 'get-group')) {
        await attempt('overlay', () => deps.removeOverlay(groupId));
      }
      if (failures.length > 0) throw new PurgeError(groupId, failures, unloadable);
    } finally {
      try {
        deps.onPurged(groupId);
      } catch (error) {
        report(groupId, { step: 'on-purged', error });
      }
    }
  }

  return {
    purgeLocalGroup(groupId, options = {}) {
      if (typeof groupId !== 'string' || groupId === '') return Promise.reject(new TypeError('purgeLocalGroup: groupId is required'));
      const existing = inFlight.get(groupId);
      if (existing) return existing;
      const promise = withGroupLock(groupId, () => run(groupId, options)).finally(() => {
        if (inFlight.get(groupId) === promise) inFlight.delete(groupId);
      });
      inFlight.set(groupId, promise);
      return promise;
    },
    withGroupLock,
    isPurging: (groupId) => inFlight.has(groupId),
    async whenPurged(groupId) {
      for (let running = inFlight.get(groupId); running !== undefined; running = inFlight.get(groupId)) {
        await running.then(
          () => undefined,
          () => undefined,
        );
      }
    },
  };
}
