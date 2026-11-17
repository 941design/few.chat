/**
 * Test fixture (not a test): the recompute ORACLE of AC-WDR-7.
 *
 * Claim under test: after any sequence of appends and withdraws, the stored state of delete/edit slots,
 * reactions and polls equals the state produced by dispatching ONLY the remaining history rows, in `seq`
 * order, into EMPTY stores.
 *
 *   const steps: Step[] = [append(e1), append(e2), withdraw('e1')];
 *   await runSteps(app, steps);                         // app under test (real stores + real sink)
 *   await expectOracle(app, steps, () => buildRealApp()); // compares against a fresh app fed only the survivors
 *
 * The oracle app uses a DIFFERENT group id (the stores are keyed by it); `retarget` rewrites the entries and
 * `snapshot` normalises the group id away, so both snapshots are comparable. Time fields (receivedAt,
 * lastTouchedAt, ...) are excluded by the stores' own snapshot functions; everything else a user can observe
 * (chat rows incl. the `original` snapshot and carriers, reaction rows, polls, votes, the held / pending /
 * marker / slot-meta aux state) is compared.
 *
 * Aux-state snapshot ports (each store exports one; the group id may appear inside, it is normalised):
 *   messageEdits/api   snapshotMessageEditsState(groupId): Promise<unknown>
 *   reactions/api      snapshotHeldReactions(groupId): Promise<unknown>
 *   marmot/pollPersistence snapshotPollState(groupId): Promise<unknown>   (polls, ALL votes, pending votes/closes/close announcements)
 *
 * Tests importing this MUST follow the realApp.ts preconditions (fake-indexeddb/auto first, `react` mock).
 */
import { expect } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { snapshotMessageEditsState } from '@/src/lib/messageEdits/api';
import { snapshotHeldReactions } from '@/src/lib/reactions/api';
import { snapshotPollState } from '@/src/lib/marmot/pollPersistence';
import { ev, type RealApp } from './realApp';

export type Step = { op: 'append'; entry: HistoryEntry } | { op: 'withdraw'; ids: string[] };

export const append = (entry: HistoryEntry): Step => ({ op: 'append', entry });
/** `labels` are the test's event labels (as given to `app.entry({eventId})`); mapped to hex like the sink needs. */
export const withdraw = (...labels: string[]): Step => ({ op: 'withdraw', ids: ev(...labels) });

/** Runs steps against the app's sink, one at a time, in order. */
export async function runSteps(app: RealApp, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    if (step.op === 'append') await app.sink.append(step.entry);
    else await app.sink.withdraw(app.groupId, step.ids);
  }
}

/**
 * The entries that survive the steps, in the `seq` order the sink would hold them: a repeated append of a present id
 * is a no-op (keeps its seq), a withdraw removes the row, a later append of a withdrawn id is a fresh row at the end.
 */
export function survivors(steps: readonly Step[]): HistoryEntry[] {
  const rows: HistoryEntry[] = [];
  for (const step of steps) {
    if (step.op === 'append') {
      if (!rows.some((r) => r.eventId === step.entry.eventId)) rows.push(step.entry);
    } else {
      for (const id of step.ids) {
        const at = rows.findIndex((r) => r.eventId === id);
        if (at !== -1) rows.splice(at, 1);
      }
    }
  }
  return rows;
}

export const retarget = (entry: HistoryEntry, groupId: string): HistoryEntry => ({ ...entry, groupId });

/** Dispatches only the surviving entries into a fresh app (empty stores) and returns it. */
export async function runOracle(steps: readonly Step[], make: () => RealApp): Promise<RealApp> {
  const fresh = make();
  for (const entry of survivors(steps)) await fresh.sink.append(retarget(entry, fresh.groupId));
  return fresh;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/** Every observable store of the app, normalised (group id -> `<G>`, keys sorted, arrays order-normalised where the store has no order). */
export async function snapshot(app: RealApp): Promise<unknown> {
  const g = app.groupId;
  const raw = {
    messages: await app.messages(),
    reactions: [...(await app.reactionRows())].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
    polls: await app.polls(),
    edits: await snapshotMessageEditsState(g),
    held: await snapshotHeldReactions(g),
    pollState: await snapshotPollState(g),
  };
  return stable(JSON.parse(JSON.stringify(raw).split(g).join('<G>')));
}

/** Asserts the app's stores equal the oracle's (the AC-WDR-7 equivalence). */
export async function expectOracle(app: RealApp, steps: readonly Step[], make: () => RealApp): Promise<void> {
  const oracle = await runOracle(steps, make);
  expect(await snapshot(app)).toEqual(await snapshot(oracle));
}
