/**
 * sweep.ts — startup recovery pass of the history sink (AC-HIST-7 b).
 *
 * Rows the sink persisted but never saw handled (a crash or reload between
 * "row written" and "handlers done", or five library attempts that all failed)
 * are recovered per group, in `seq` order, by the backend's first-touch
 * recovery (historyBackend.ts). The sink recovers a group lazily the first time
 * a live `append`/`withdraw` touches it; this pass covers the groups that no
 * live call has touched yet. The bootstrap calls it after `groups.list()`
 * resolves (the library starts each group's history drain during that call)
 * and before `inbox.start()` (AC-BOOT-1).
 *
 * Contract:
 *   - only groups with a recoverable row (`dispatched:false`, not abandoned) that
 *     this backend instance has not recovered yet are processed; groups in
 *     ascending id order;
 *   - the per-group recovery runs inside the backend's per-group serialised
 *     job, so no newer entry of that group is dispatched ahead of it;
 *   - a failing row stays `dispatched:false` and is reported; recovery goes on
 *     with the group's later rows and with every other group;
 *   - the sweep rejects only when the store itself cannot be listed.
 */
import type { HistoryStore } from './historyStore';

export interface SweepDeps {
  store: HistoryStore;
  /** True once this backend instance has run (or started) the first-touch recovery of the group. */
  isTouched: (groupId: string) => boolean;
  /** Runs the group's first-touch recovery inside its serialised job; a no-op for a touched group. */
  recoverGroup: (groupId: string) => Promise<SweepResult>;
  onError: (error: unknown, ctx: { groupId: string; eventId: string }) => void;
}

export interface SweepResult {
  /** Rows whose handlers ran to completion during recovery. */
  redispatched: number;
  /** Rows that failed (still `dispatched:false`). */
  failed: number;
}

export async function sweepUndispatched(deps: SweepDeps): Promise<SweepResult> {
  const rows = await deps.store.listAllRows();
  const groupIds: string[] = [];
  for (const row of rows) {
    const groupId = row.entry.groupId;
    if (row.dispatched || row.abandoned || deps.isTouched(groupId) || groupIds.includes(groupId)) continue;
    groupIds.push(groupId);
  }
  const result: SweepResult = { redispatched: 0, failed: 0 };
  for (const groupId of groupIds) {
    try {
      const part = await deps.recoverGroup(groupId);
      result.redispatched += part.redispatched;
      result.failed += part.failed;
    } catch (error) {
      // The group's rows could not be read; the group stays untouched and is retried by its next live call.
      try {
        deps.onError(error, { groupId, eventId: '' });
      } catch {
        /* an error reporter must never abort the sweep */
      }
    }
  }
  return result;
}
