/**
 * Throwaway `HistoryBackend` for the library smoke proof (D15; deleted with the
 * smoke hook in the last story). It records every `append` / `withdraw` call
 * the library makes and can be told to throw on the next N appends, which is
 * how assumption A1 (a thrown `append` is retried) is observed.
 *
 * Idempotent by `eventId`, like the real sink must be. Not persisted.
 */
import type { HistoryBackend, HistoryEntry } from '@941design/marmot';

export interface AppendCall {
  groupId: string;
  eventId: string;
  rumorId: string;
  /** `orderingKey.account` of the entry (the authenticated sender). */
  account: string;
  at: number;
  /** True when this call threw (injected failure) and therefore did not apply. */
  threw: boolean;
}

export interface WithdrawCall {
  groupId: string;
  eventIds: string[];
  at: number;
}

export interface RecordingHistoryBackend extends HistoryBackend {
  readonly appendCalls: AppendCall[];
  readonly withdrawCalls: WithdrawCall[];
  readonly purgeCalls: string[];
  /** Makes the next `count` append calls throw (before applying anything). */
  failNextAppends(count: number): void;
  /** Entries currently retained for a group, in delivery order. */
  retained(groupId: string): HistoryEntry[];
}

export function createRecordingHistoryBackend(now: () => number = Date.now): RecordingHistoryBackend {
  const byGroup = new Map<string, Map<string, HistoryEntry>>();
  const appendCalls: AppendCall[] = [];
  const withdrawCalls: WithdrawCall[] = [];
  const purgeCalls: string[] = [];
  let failures = 0;

  return {
    appendCalls,
    withdrawCalls,
    purgeCalls,
    failNextAppends(count) {
      failures = Math.max(0, Math.floor(count));
    },
    retained(groupId) {
      return [...(byGroup.get(groupId)?.values() ?? [])];
    },
    append(entry) {
      const call: AppendCall = {
        groupId: entry.groupId,
        eventId: entry.eventId,
        rumorId: entry.rumor.id,
        account: entry.orderingKey.account,
        at: now(),
        threw: false,
      };
      appendCalls.push(call);
      if (failures > 0) {
        failures -= 1;
        call.threw = true;
        throw new Error('recording history backend: injected append failure');
      }
      const group = byGroup.get(entry.groupId) ?? new Map<string, HistoryEntry>();
      byGroup.set(entry.groupId, group);
      if (!group.has(entry.eventId)) group.set(entry.eventId, entry);
    },
    withdraw(groupId, eventIds) {
      withdrawCalls.push({ groupId, eventIds: [...eventIds], at: now() });
      const group = byGroup.get(groupId);
      if (!group) return;
      for (const id of eventIds) group.delete(id);
    },
    list(groupId) {
      return [...(byGroup.get(groupId)?.values() ?? [])];
    },
    purge(groupId) {
      purgeCalls.push(groupId);
      byGroup.delete(groupId);
    },
  };
}
