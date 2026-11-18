/**
 * Library-driven membership changes the app reacts to: removal by an admin (`groupRemoved`, AC-MEM-4) and disband
 * (`group-disbanded`, AC-MEM-5).
 *
 * REMOVAL. `client.on('groupRemoved')` fires at most once and only after the library's removal settle window: a crash
 * between the settle and the emit loses it, and a group already removed before the app started is announced only when
 * it is first loaded. So the event path is backed by a startup check:
 *   - `onGroupRemoved(payload)` is a CLIENT LISTENER (a library frame): it makes no account-scope call. It only
 *     enqueues the purge on the owned client job queue, as its last action (`handle.enqueue`; a job the queue does
 *     not accept is dropped, a second event for a group already queued adds nothing);
 *   - `checkListedGroups(groups)` runs after `groups.list()` at startup (under the lease, outside any frame): every
 *     listed group whose `members()` is READABLE and lacks the own account is a candidate. The library's removal
 *     settle window (`removalSettleMs`, 5 s) is still open right after the bootstrap: a removal that is not settled
 *     yet may still be superseded, so the purge decision is taken only once that window has elapsed since the
 *     handlers were created, and the roster is read AGAIN then (a re-joined or concurrently purged group is left
 *     alone). An unreadable roster is left alone (fail-closed on the live-member read: a throwing accessor must
 *     never turn a healthy group into a purge; the opposite direction of the leave path, see leaveEligibility).
 *   Both end in the same idempotent `purgeLocalGroup`, which itself leaves a group untouched whose readable roster
 *   holds the own account again.
 *
 * DISBAND. The library can only RECEIVE a peer's disband (no `group.disband()`): a `group-disbanded` notification and
 * the persisted `group.disbanded` marker. The group stays held and read-only. The app marks the overlay row
 * `disbanded: { actor?, at }` (idempotent) so the UI derives "disbanded" from stored state, and refreshes the list.
 * `disbandTarget` is the `disband` target of the handlers module's notification router (a frame: storage only, no client
 * call); `syncListed(groups)` re-marks at startup every listed group that carries the library marker (the notification
 * is announced once). A group missing from the overlay is left alone. A handle that was purged meanwhile throws from
 * `id` and every accessor: `id` is read once per iteration, a throw skips the group, and the handle is never touched
 * again after it.
 *
 * Pure module: ports are injected and validated at construction; no React, no storage, no client import.
 */
import { readRosterFacts } from './leaveEligibility';
import type { GroupDataPurger } from './purgeLocalGroup';

/** A group handle as the startup check sees it. */
export interface ListedGroup {
  readonly id: string;
  members: () => readonly string[];
}

/** A group handle as the disband sync sees it (`MarmotGroup.disbanded`). */
interface DisbandableGroup {
  readonly id: string;
  /** `MarmotGroup.disbanded` (`GroupDisbanded`: `actor`, `at` and the commit evidence). */
  readonly disbanded?: { readonly actor?: string; readonly at?: number } | undefined;
}

type EnqueueJob = (job: () => Promise<void>) => boolean | void;

interface GroupRemovalDeps {
  /** Lowercase hex account. */
  ownPubkey: string;
  purger: GroupDataPurger;
  /** `AccountClientHandle.enqueue`. */
  enqueue: EnqueueJob;
  /** Failed purges and unreadable rosters (default `console.warn`). */
  onError?: (groupId: string, error: unknown) => void;
  /** The library's `removalSettleMs` (ms): the startup check decides only after this long since construction. Default 5000. */
  removalSettleMs?: number;
  /** Clock, ms (default `Date.now`). */
  now?: () => number;
  /** Delay (default `setTimeout`). */
  wait?: (ms: number) => Promise<void>;
}

const DEFAULT_REMOVAL_SETTLE_MS = 5_000;

interface GroupRemovalHandlers {
  /** `clientEvents.groupRemoved`: frame-safe, only enqueues the purge. */
  onGroupRemoved: (payload: { readonly groupId: string; readonly actor?: string }) => void;
  /** Startup check over `groups.list()`. Outside frames. Resolves with the ids it purged. */
  checkListedGroups: (groups: Iterable<ListedGroup>) => Promise<string[]>;
}

function requireFn(factory: string, deps: object, name: string): void {
  if (typeof (deps as Record<string, unknown>)[name] !== 'function') throw new TypeError(`${factory}: port '${name}' is required`);
}

export function createGroupRemovalHandlers(deps: GroupRemovalDeps): GroupRemovalHandlers {
  const factory = 'createGroupRemovalHandlers';
  if (typeof deps?.ownPubkey !== 'string' || deps.ownPubkey === '') throw new TypeError(`${factory}: ownPubkey is required`);
  requireFn(factory, deps, 'enqueue');
  if (typeof deps.purger?.purgeLocalGroup !== 'function') throw new TypeError(`${factory}: port 'purger.purgeLocalGroup' is required`);
  const own = deps.ownPubkey.toLowerCase();
  const settleMs = deps.removalSettleMs ?? DEFAULT_REMOVAL_SETTLE_MS;
  if (!Number.isFinite(settleMs) || settleMs < 0) throw new TypeError(`${factory}: removalSettleMs must be a non-negative number`);
  const clock = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = clock();
  const report =
    deps.onError ?? ((groupId: string, error: unknown) => console.warn(`[membership] removal handling of group ${groupId} failed`, error));
  const soft = (groupId: string, error: unknown) => {
    try {
      report(groupId, error);
    } catch {
      /* a throwing reporter never breaks the handler */
    }
  };
  const queued = new Set<string>();

  return {
    onGroupRemoved(payload) {
      const groupId = payload?.groupId;
      if (typeof groupId !== 'string' || groupId === '') return;
      if (queued.has(groupId)) return;
      queued.add(groupId);
      // Last action of the frame: nothing after this line may touch the client.
      let accepted: boolean | void;
      try {
        accepted = deps.enqueue(async () => {
          // The marker is released first: an event arriving while the purge runs schedules one more (idempotent) pass.
          queued.delete(groupId);
          try {
            await deps.purger.purgeLocalGroup(groupId);
          } catch (error) {
            soft(groupId, error);
          }
        });
      } catch (error) {
        accepted = false;
        soft(groupId, error);
      }
      if (accepted === false) queued.delete(groupId);
    },

    async checkListedGroups(groups) {
      const purged: string[] = [];
      const candidates: Array<{ id: string; group: ListedGroup }> = [];
      for (const group of [...groups]) {
        // A handle that was abandoned (by an earlier step of this pass or concurrently) throws from `id` and every
        // accessor: the id is read once, up front, and never again from the handle except for the re-check below.
        let id: string;
        let members: readonly string[] | undefined;
        try {
          id = group.id;
          members = readRosterFacts(group).members; // on the handle itself: the accessors may rely on `this`
        } catch {
          continue;
        }
        if (typeof id !== 'string' || id === '') continue;
        if (members === undefined) {
          soft(id, new Error('members() unreadable: group left alone (fail-closed)'));
          continue;
        }
        if (!members.some((m) => m.toLowerCase() === own)) candidates.push({ id, group });
      }
      if (candidates.length === 0) return purged;

      // The library's removal settle window: decide only after it, on a fresh read.
      const remaining = settleMs - (clock() - startedAt);
      if (remaining > 0) await wait(remaining);

      for (const { id, group } of candidates) {
        let members: readonly string[] | undefined;
        try {
          members = readRosterFacts(group).members;
        } catch {
          continue;
        }
        if (members === undefined) {
          soft(id, new Error('members() unreadable after the settle window: group left alone (fail-closed)'));
          continue;
        }
        if (members.some((m) => m.toLowerCase() === own)) continue; // re-joined meanwhile
        try {
          await deps.purger.purgeLocalGroup(id);
          purged.push(id);
        } catch (error) {
          soft(id, error);
        }
      }
      return purged;
    },
  };
}

/** What the overlay row records about a disband. */
interface DisbandedMark {
  actor?: string;
  /** Client-clock milliseconds. */
  at: number;
}

/** The overlay row as this module sees it; the app's `Group` is assignable and keeps every other field. */
export interface OverlayRecord {
  id: string;
  disbanded?: DisbandedMark;
  [field: string]: unknown;
}

interface DisbandMarkerDeps {
  overlay: {
    load: (groupId: string) => Promise<OverlayRecord | undefined>;
    save: (record: OverlayRecord) => Promise<void>;
  };
  /** Clock, ms. */
  now: () => number;
  /** The UI reload after a group was newly marked. */
  onMarked: (groupId: string) => void;
  onError?: (groupId: string, error: unknown) => void;
}

interface DisbandMarker {
  /** Marks the overlay row of `groupId` disbanded. Resolves `true` when it newly marked, `false` for a no-op (already marked, no overlay row). */
  markDisbanded: (groupId: string, info?: { actor?: string; at?: number }) => Promise<boolean>;
  /** The router's `disband` target: fire-and-forget (a frame), failures reported. */
  disbandTarget: (groupId: string) => void;
  /** Startup: marks every listed group that carries the library's disband marker. Resolves with the ids newly marked. */
  syncListed: (groups: Iterable<DisbandableGroup>) => Promise<string[]>;
}

export function createDisbandMarker(deps: DisbandMarkerDeps): DisbandMarker {
  const factory = 'createDisbandMarker';
  for (const name of ['now', 'onMarked'] as const) requireFn(factory, deps, name);
  for (const name of ['load', 'save'] as const) {
    if (typeof deps.overlay?.[name] !== 'function') throw new TypeError(`${factory}: port 'overlay.${name}' is required`);
  }
  const report =
    deps.onError ?? ((groupId: string, error: unknown) => console.warn(`[membership] marking group ${groupId} disbanded failed`, error));
  const soft = (groupId: string, error: unknown) => {
    try {
      report(groupId, error);
    } catch {
      /* a throwing reporter never breaks the marker */
    }
  };
  /** Per-group serialisation of this module's own read-modify-write. */
  const tails = new Map<string, Promise<unknown>>();

  const markDisbanded: DisbandMarker['markDisbanded'] = (groupId, info) => {
    if (typeof groupId !== 'string' || groupId === '') return Promise.reject(new TypeError('markDisbanded: groupId is required'));
    const run = async (): Promise<boolean> => {
      const record = await deps.overlay.load(groupId);
      if (!record || record.disbanded !== undefined) return false;
      const mark: DisbandedMark = {
        ...(typeof info?.actor === 'string' ? { actor: info.actor } : {}),
        at: typeof info?.at === 'number' && Number.isFinite(info.at) ? info.at : deps.now(),
      };
      await deps.overlay.save({ ...record, disbanded: mark });
      try {
        deps.onMarked(groupId);
      } catch (error) {
        soft(groupId, error);
      }
      return true;
    };
    const next = (tails.get(groupId) ?? Promise.resolve()).then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(groupId, tail);
    void tail.then(() => {
      if (tails.get(groupId) === tail) tails.delete(groupId);
    });
    return next;
  };

  return {
    markDisbanded,
    disbandTarget(groupId) {
      markDisbanded(groupId).catch((error: unknown) => soft(groupId, error));
    },
    async syncListed(groups) {
      const marked: string[] = [];
      for (const group of [...groups]) {
        // `id` first and once: a handle purged meanwhile throws from it and from every accessor, and is never touched again.
        let id: string;
        let mark: { actor?: string; at?: number } | undefined;
        try {
          id = group.id;
        } catch {
          continue;
        }
        if (typeof id !== 'string' || id === '') continue;
        try {
          const disbanded = group.disbanded;
          if (disbanded === undefined || disbanded === null) continue;
          if (typeof disbanded !== 'object') continue; // malformed marker: not a disband we can name
          const { actor, at } = disbanded;
          mark = { actor: typeof actor === 'string' ? actor : undefined, at: typeof at === 'number' ? at : undefined };
        } catch (error) {
          soft(id, error);
          continue;
        }
        try {
          if (await markDisbanded(id, mark)) marked.push(id);
        } catch (error) {
          soft(id, error);
        }
      }
      return marked;
    },
  };
}
