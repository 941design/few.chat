/**
 * Leave a group (D9, AC-LEAVE-1/2/3). `group.leave()` of the library replaces the kind-13 leave intent, the admin
 * auto-commit, the pending-removal store, the tombstones and the left-group sweep.
 *
 *   leave(groupId)
 *     1. looks the group up (`getGroup`) and reads its roster through the guarded twin reads (`readRosterFacts`);
 *        a FAILED lookup is not "the library does not hold the group": it takes the `leave` path (roster unknown),
 *        never `abandon`;
 *     2. decides (`decideLeave`): `blocked` (sole admin: returned at once, nothing sent, no `leave()`),
 *        `abandon` (sole member, or the library does not hold the group: local purge only, no `leave()`, nothing sent)
 *        or `leave`;
 *     3. hides the group from the app list right after the group lookup (`hideGroup`; the lookup is the only await
 *        before it, the leave work itself starts after it) and returns; the work continues in the background and its
 *        outcome is `settled` (never rejects).
 *
 *   Background, `leave` mode: the kind-9 "left" announcement first, with a BOUNDED wait (`announceTimeoutMs`, 2 s) that
 *   soft-fails (a rejecting or hanging announcement never blocks the leave; the send itself continues in the
 *   background), then `group.leave()` through the GroupOpQueue (`runCommit(..., { skipSync: true })`: the leave never
 *   waits for `synced()`, so an offline group cannot block it; the library bounds `leave()` itself with
 *   `leaveTimeoutMs` + `removalSettleMs`, 10 s + 5 s in the app). ONE deadline, `leaveDeadlineMs` (20 s), covers the
 *   announcement wait AND `leave()` (a hung library call counts as a timeout), so click-to-settle is bounded by it
 *   (plus the post-failure `getGroup` lookup); a deadline that fires during the announcement wait means `leave()` is
 *   never started. When `leave()` resolves the library has purged its own state, and `purgeLocalGroup` removes the
 *   app-side data (idempotent) and the pending view is refreshed.
 *
 *   Failure (rejection or timeout, other than `last-admin`), with a readable OR an unreadable roster: the group is
 *   restored to the list (`restoreGroup`) and the leave-failed toast is raised (`notifyLeaveFailed`; i18n key
 *   `groups.leaveFailed`); nothing app-side is purged, the library still holds the group. Two refinements:
 *     - the library is asked again (`getGroup`): a group it no longer holds means the leave did commit (it purged
 *       itself), so the leave counts as done (hidden again, purged app-side) instead of failed;
 *     - the `leave()` promise keeps a continuation: a call that resolves AFTER the deadline (or after a failure
 *       was reported) hides the group again, runs the purge and refreshes the pending view, without a second toast.
 *   A `last-admin` rejection that the pre-check could not see (unreadable admin list) restores the group and raises
 *   the blocked notice (`notifyLastAdminBlocked`) instead. NO durable "leaving" marker is written anywhere: a reload
 *   mid-leave lists the group again (the library still holds it) and the user can leave again; a leave that did
 *   commit is finished by the startup check (own account absent from `members()` -> purge).
 *
 *   Lookup failure (the group handle is unknown, e.g. an unloadable group): the leave path asks once more. A handle
 *   -> the normal leave. The library does not hold the group -> the app side is finished. Still failing -> no
 *   `leave()` is possible: the plain purge (no `ownAccountIsMember`) decides; if it rejects (an unloadable group keeps
 *   its overlay row, see purgeLocalGroup) or the library turns out to hold the group (the purger's re-join guard left
 *   it alone), the group is restored with the toast.
 *
 *   `ownAccountIsMember` is passed to the purger ONLY for the sole-member `abandon` decided from a readable roster
 *   (it legitimately holds the own account); every other purge leaves a group alone whose readable roster holds the
 *   own account again. The opposite fail-closed direction lives on the live-member/startup reads (leaveEligibility).
 *
 * Never call from inside a library frame (listener, inbox handler, history sink): `getGroup`, `leave` and the purge
 * are account-scope client calls. The UI handler is the caller; `groupNotifications` enqueues its purges itself.
 *
 * Ports are validated at construction. Pure module: no React, no storage, no browser API.
 */
import { decideLeave, readRosterFacts, type RosterReadableGroup } from './leaveEligibility';
import { type GroupDataPurger } from './purgeLocalGroup';

/** The kind-9 chat announcement kind ("<name> left the group"). */
const LEFT_ANNOUNCEMENT_KIND = 9;
/** Bound of the announcement wait before `leave()` starts (the send itself continues in the background). */
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 2_000;
/**
 * ONE deadline for the whole background leave (announcement wait + `leave()`), measured from the click's background
 * start: library `leaveTimeoutMs` 10 s + `removalSettleMs` 5 s + slack. Click-to-settle never exceeds it (plus the
 * post-failure lookup).
 */
const DEFAULT_LEAVE_DEADLINE_MS = 20_000;

/** The slice of `MarmotGroup` the leaver uses (also what `GroupOpQueue.runCommit` needs of a group). */
export interface LeavableGroup extends RosterReadableGroup {
  readonly id: string;
  synced: () => Promise<void>;
  ingest?: (events: readonly never[]) => Promise<unknown>;
  leave: () => Promise<void>;
}

type LeaveMode = 'leave' | 'abandon';

type LeaveSettled =
  | { status: 'left'; mode: LeaveMode }
  /** `leave()` failed or timed out: the group is back in the list, the toast was raised. */
  | { status: 'failed'; error: unknown }
  /** The library refused with `last-admin` (the pre-check could not see it): the group is back, the notice was raised. */
  | { status: 'blocked'; reason: 'last-admin' }
  /** The leaver was disposed (account teardown): nothing is restored or announced. */
  | { status: 'aborted' };

type LeaveResult =
  | { status: 'blocked'; reason: 'last-admin' }
  | { status: 'started'; mode: LeaveMode; settled: Promise<LeaveSettled> };

export interface GroupLeaver {
  leave: (groupId: string) => Promise<LeaveResult>;
  /** Aborts background leaves that have not started `leave()` yet and stops reporting; idempotent. */
  dispose: () => void;
}

export interface GroupLeaverDeps {
  /** Lowercase hex account. */
  ownPubkey: string;
  /** `client.groups.get`. */
  getGroup: (groupId: string) => Promise<LeavableGroup | undefined>;
  /** The app's GroupOpQueue (`runCommit`). */
  queue: { runCommit: <T>(group: LeavableGroup, op: () => Promise<T>, options?: { signal?: AbortSignal; skipSync?: boolean }) => Promise<T> };
  /** The `GroupDataPurger` seam. */
  purger: GroupDataPurger;
  /** `sendGroupRumor` seam shape (kind, content, tags). The leaver passes kind 9. */
  sendAnnouncement: (group: LeavableGroup, kind: number, content: string, tags: string[][]) => Promise<unknown>;
  /** Removes the group from the app list now (synchronous UI state, no storage). */
  hideGroup: (groupId: string) => void;
  /** Puts the group back into the app list. */
  restoreGroup: (groupId: string) => void;
  /** Raises the leave-failed toast (`copy.groups.leaveFailed`). */
  notifyLeaveFailed: (groupId: string, error: unknown) => void;
  /** Raises the last-admin notice (`copy.groups.lastAdminLeaveBlocked`) for a refusal the pre-check missed. */
  notifyLastAdminBlocked: (groupId: string) => void;
  /** The pending-invitation view: refreshed after the group is gone (an invitation to it may now show). */
  pendingView: { scheduleRefresh: () => void };
  /** The leaver's display name for the announcement (own name over the encrypted group channel only). */
  ownName?: () => string | undefined;
  announceTimeoutMs?: number;
  leaveDeadlineMs?: number;
  /** Soft failures (announcement, post-leave purge, reporters). Default `console.warn`. */
  onError?: (stage: 'announce' | 'leave' | 'purge' | 'notify', groupId: string, error: unknown) => void;
}

/** The announcement body the chat renders as "<name> left the group" (`parseStructured` type `leave_intent`). */
export function buildLeftAnnouncementContent(ownPubkey: string, ownName?: string): string {
  const name = ownName?.trim();
  return JSON.stringify(name ? { type: 'leave_intent', pubkey: ownPubkey, name } : { type: 'leave_intent', pubkey: ownPubkey });
}

function isLastAdminRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'last-admin';
}

export class LeaveTimeoutError extends Error {
  constructor(groupId: string, ms: number) {
    super(`leave of group ${groupId} did not settle within ${String(ms)} ms`);
    this.name = 'LeaveTimeoutError';
  }
}

/** Resolves with `promise`, rejects with `onTimeout()` after `ms`; the timer never outlives the race. */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createGroupLeaver(deps: GroupLeaverDeps): GroupLeaver {
  const factory = 'createGroupLeaver';
  if (typeof deps?.ownPubkey !== 'string' || deps.ownPubkey === '') throw new TypeError(`${factory}: ownPubkey is required`);
  for (const name of ['getGroup', 'sendAnnouncement', 'hideGroup', 'restoreGroup', 'notifyLeaveFailed', 'notifyLastAdminBlocked'] as const) {
    if (typeof deps[name] !== 'function') throw new TypeError(`${factory}: port '${name}' is required`);
  }
  const members: Array<[string, unknown, string]> = [
    ['queue', deps.queue, 'runCommit'],
    ['purger', deps.purger, 'purgeLocalGroup'],
    ['pendingView', deps.pendingView, 'scheduleRefresh'],
  ];
  for (const [owner, value, member] of members) {
    if (typeof (value as Record<string, unknown> | undefined)?.[member] !== 'function') throw new TypeError(`${factory}: port '${owner}.${member}' is required`);
  }
  const announceTimeoutMs = deps.announceTimeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS;
  const leaveDeadlineMs = deps.leaveDeadlineMs ?? DEFAULT_LEAVE_DEADLINE_MS;
  for (const [name, ms] of [['announceTimeoutMs', announceTimeoutMs], ['leaveDeadlineMs', leaveDeadlineMs]] as const) {
    if (!Number.isFinite(ms) || ms <= 0) throw new TypeError(`${factory}: ${name} must be a positive number`);
  }
  const own = deps.ownPubkey.toLowerCase();
  const warn =
    deps.onError ?? ((stage: string, groupId: string, error: unknown) => console.warn(`[membership] leave(${groupId}): ${stage} failed`, error));
  const soft = (stage: 'announce' | 'leave' | 'purge' | 'notify', groupId: string, error: unknown) => {
    try {
      warn(stage, groupId, error);
    } catch {
      /* a throwing reporter never breaks the leave */
    }
  };

  const running = new Map<string, { mode: LeaveMode; settled: Promise<LeaveSettled> }>();
  const controller = new AbortController();
  let disposed = false;

  /** The kind-9 announcement: sent first, waited for at most `announceTimeoutMs`, a failure or a timeout never blocks. */
  async function announce(group: LeavableGroup, groupId: string): Promise<void> {
    const content = buildLeftAnnouncementContent(deps.ownPubkey, deps.ownName?.());
    const sent = Promise.resolve().then(() => deps.sendAnnouncement(group, LEFT_ANNOUNCEMENT_KIND, content, []));
    // A send that settles after the bound (or after the leave) must never surface as an unhandled rejection.
    const outcome = sent.then(
      () => undefined,
      (error: unknown) => {
        soft('announce', groupId, error);
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, announceTimeoutMs);
    });
    try {
      await Promise.race([outcome, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function notify(fn: () => void, groupId: string): void {
    try {
      fn();
    } catch (error) {
      soft('notify', groupId, error);
    }
  }

  const restoreWith = (groupId: string, raise: () => void): void => {
    notify(() => deps.restoreGroup(groupId), groupId);
    notify(raise, groupId);
  };

  async function runAbandon(groupId: string, soloGroup?: LeavableGroup): Promise<LeaveSettled> {
    try {
      if (soloGroup) {
        await deps.queue.runCommit(soloGroup, () =>
          deps.purger.purgeLocalGroup(groupId, { ownAccountIsMember: true }), { skipSync: true, signal: controller.signal });
      } else {
        await deps.purger.purgeLocalGroup(groupId);
      }
    } catch (error) {
      if (disposed) return { status: 'aborted' };
      restoreWith(groupId, () => deps.notifyLeaveFailed(groupId, error));
      return { status: 'failed', error };
    }
    notify(() => deps.pendingView.scheduleRefresh(), groupId);
    return { status: 'left', mode: 'abandon' };
  }

  /** The library's current handle: `{ group }` (`undefined` = it does not hold the group) or `{ error }` (lookup failed). */
  async function lookup(groupId: string): Promise<{ group: LeavableGroup | undefined } | { error: unknown }> {
    try {
      return { group: await deps.getGroup(groupId) };
    } catch (error) {
      return { error };
    }
  }

  /** True when the library no longer holds the group (a leave that did commit, purged by the library itself). */
  async function libraryGone(groupId: string): Promise<boolean> {
    const found = await lookup(groupId);
    return 'group' in found && found.group === undefined; // a failed lookup is unknown: not proof of anything
  }

  /** A leave() that resolves after the app already restored the group: the leave was real, finish it silently. */
  function continueLate(leaveCall: Promise<unknown>, groupId: string): void {
    leaveCall.then(
      () => {
        if (disposed) return;
        notify(() => deps.hideGroup(groupId), groupId);
        // No toast: the failure toast already went out; the group simply disappears again.
        deps.purger
          .purgeLocalGroup(groupId)
          .catch((error: unknown) => soft('purge', groupId, error))
          .then(() => notify(() => deps.pendingView.scheduleRefresh(), groupId));
      },
      () => undefined,
    );
  }

  /**
   * The lookup before the leave failed (the group handle is unknown): ask once more. A handle -> the normal leave
   * (roster unknown); the library does not hold the group -> finish the app side; still failing (undeletable group)
   * -> no `leave()` is possible, so the plain purge (never the abandon bypass) decides.
   */
  async function runLeaveWithoutHandle(groupId: string): Promise<LeaveSettled> {
    const again = await lookup(groupId);
    if (disposed) return { status: 'aborted' };
    if ('group' in again && again.group !== undefined) return runLeave(again.group, groupId);
    const lookupError = 'error' in again ? again.error : undefined;
    try {
      await deps.purger.purgeLocalGroup(groupId);
    } catch (error) {
      if (disposed) return { status: 'aborted' };
      // Nothing could be left or removed (an unloadable group keeps its overlay row): back to the list with the toast.
      restoreWith(groupId, () => deps.notifyLeaveFailed(groupId, lookupError ?? error));
      return { status: 'failed', error: lookupError ?? error };
    }
    if ('error' in again) {
      // The purger's own lookup may have found the group and rightly left a shared one untouched (re-join guard): the
      // leave never happened, so the group is not gone.
      const found = await lookup(groupId);
      if (disposed) return { status: 'aborted' };
      if ('group' in found && found.group !== undefined) {
        restoreWith(groupId, () => deps.notifyLeaveFailed(groupId, lookupError));
        return { status: 'failed', error: lookupError };
      }
    }
    notify(() => deps.pendingView.scheduleRefresh(), groupId);
    return { status: 'left', mode: 'leave' };
  }

  async function runLeave(group: LeavableGroup, groupId: string): Promise<LeaveSettled> {
    // One signal per leave: the deadline frees a still-queued op, the account teardown aborts every pending one.
    const attempt = new AbortController();
    const abortOnDispose = () => attempt.abort();
    controller.signal.addEventListener('abort', abortOnDispose, { once: true });
    let leaveCall: Promise<void> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      // ONE deadline for announcement wait + leave(): click-to-settle never exceeds `leaveDeadlineMs` (the announcement
      // wait is itself capped at `announceTimeoutMs`, so leave() keeps most of the budget).
      const sequence = (async () => {
        await announce(group, groupId);
        // A deadline or a teardown that fired meanwhile: leave() must never start after the outcome was decided.
        if (disposed || attempt.signal.aborted) return;
        leaveCall = deps.queue.runCommit(group, async () => {
          if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
            const { beforeGroupLeave } = await import('../../testHooks/marmotSession');
            await beforeGroupLeave(groupId);
            // A paused test hook must not start a leave after the deadline or teardown.
            if (disposed || attempt.signal.aborted) throw new Error('leave attempt aborted');
          }
          await group.leave();
        }, { skipSync: true, signal: attempt.signal });
        await leaveCall;
      })();
      await withDeadline(sequence, leaveDeadlineMs, () => new LeaveTimeoutError(groupId, leaveDeadlineMs));
      if (disposed) return { status: 'aborted' };
    } catch (error) {
      attempt.abort();
      if (disposed) return { status: 'aborted' };
      failure = { error };
    } finally {
      controller.signal.removeEventListener('abort', abortOnDispose);
    }

    if (failure !== undefined) {
      const { error } = failure;
      // After ANY failure: a library that already purged the group means the leave did commit (a late success, a
      // purge before the rejection surfaced): the leave is done, hide again and finish the app side.
      if (await libraryGone(groupId)) {
        if (disposed) return { status: 'aborted' };
        notify(() => deps.hideGroup(groupId), groupId);
      } else {
        if (disposed) return { status: 'aborted' };
        if (isLastAdminRejection(error)) {
          restoreWith(groupId, () => deps.notifyLastAdminBlocked(groupId));
          return { status: 'blocked', reason: 'last-admin' };
        }
        // The call may still succeed after the deadline (or a transport-level rejection): finish it silently then.
        if (leaveCall) continueLate(leaveCall, groupId);
        // A rejected or timed-out leave restores the group with the toast, whether or not the roster was readable:
        // the library still holds the group, so nothing app-side may be purged.
        restoreWith(groupId, () => deps.notifyLeaveFailed(groupId, error));
        return { status: 'failed', error };
      }
    }
    try {
      await deps.purger.purgeLocalGroup(groupId);
    } catch (error) {
      // The leave committed (the library state is gone): the leftovers keep their overlay row (the retry key) and the
      // startup reconciliation finishes them. The group is NOT restored: a ghost of a left group is worse.
      soft('purge', groupId, error);
    }
    notify(() => deps.pendingView.scheduleRefresh(), groupId);
    return { status: 'left', mode: 'leave' };
  }

  return {
    async leave(groupId) {
      if (typeof groupId !== 'string' || groupId === '') throw new TypeError('leave: groupId is required');
      const active = running.get(groupId);
      if (active) return { status: 'started', mode: active.mode, settled: active.settled };

      const found = await lookup(groupId);
      const group = 'group' in found ? found.group : undefined;
      // A FAILED lookup is not "the library does not hold the group": it takes the leave path (roster unknown), never
      // the abandon path (which would purge a shared group).
      const decision =
        'error' in found
          ? ({ action: 'leave', rosterKnown: false } as const)
          : group
            ? decideLeave(readRosterFacts(group), own)
            : ({ action: 'abandon', reason: 'not-a-member' } as const);
      if (decision.action === 'blocked') return { status: 'blocked', reason: 'last-admin' };

      const again = running.get(groupId);
      if (again) return { status: 'started', mode: again.mode, settled: again.settled };

      // Immediate UI removal: right after the group lookup (the only await before it), before any leave work runs.
      deps.hideGroup(groupId);
      const mode: LeaveMode = decision.action === 'leave' ? 'leave' : 'abandon';
      const work =
        decision.action === 'abandon'
          ? runAbandon(groupId, decision.reason === 'sole-member' ? group : undefined)
          : group
            ? runLeave(group, groupId)
            : runLeaveWithoutHandle(groupId);
      const settled: Promise<LeaveSettled> = work.finally(() => {
        if (running.get(groupId)?.settled === settled) running.delete(groupId);
      });
      running.set(groupId, { mode, settled });
      return { status: 'started', mode, settled };
    },
    dispose() {
      disposed = true;
      controller.abort();
    },
  };
}
