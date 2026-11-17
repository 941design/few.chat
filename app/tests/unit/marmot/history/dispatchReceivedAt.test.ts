/**
 * History sink: the row's clock reaches the handlers.
 *
 * `GroupRumorInput.receivedAt` is the row's persisted first-append time, the same value a recompute folds the row
 * with (`RemainingRow.receivedAt`): a dispatch that runs LATE (a recovered row) therefore decides like the fold does,
 * instead of reading the wall clock of the late moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';

const { dbs } = vi.hoisted(() => ({ dbs: new Map<string, Map<string, unknown>>() }));
const mapOf = (db: string): Map<string, unknown> => {
  let m = dbs.get(db);
  if (!m) dbs.set(db, (m = new Map()));
  return m;
};

vi.mock('idb-keyval', async () => {
  const { mapUseStore } = await import('./mapIdbStore');
  return {
    createStore: (db: string) => mapUseStore(mapOf(db)),
    get: async (k: string, s: MapUseStore) => (s.map.has(k) ? structuredClone(s.map.get(k)) : undefined),
    set: async (k: string, v: unknown, s: MapUseStore) => void s.map.set(k, structuredClone(v)),
    del: async (k: string, s: MapUseStore) => void s.map.delete(k),
    delMany: async (ks: string[], s: MapUseStore) => void ks.forEach((k) => s.map.delete(k)),
    keys: async (s: MapUseStore) => [...s.map.keys()],
    entries: async (s: MapUseStore) => [...s.map.entries()].map(([k, v]) => [k, structuredClone(v)]),
  };
});

import type { MapUseStore } from './mapIdbStore';
import { createHistoryBackend, HISTORY_DB_NAME, type GroupHistoryHandlers, type GroupRumorInput } from '@/src/lib/marmot/history';

const G = 'a1'.repeat(32);
const ALICE = 'aa'.repeat(32);
const hex = (label: string) => Buffer.from(label).toString('hex');
const db = () => mapOf(`${HISTORY_DB_NAME}:${ALICE}`);
const rowKey = (e: string) => `${G}:${hex(e)}`;

const entry = (l: string, createdAt = 1_700_000_000): HistoryEntry => ({
  groupId: G,
  eventId: hex(l),
  rumor: { id: `rumor-${l}`, pubkey: ALICE, created_at: createdAt, kind: 9, tags: [], content: l },
  orderingKey: { account: ALICE, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
});

function fixture() {
  const dispatched: GroupRumorInput[] = [];
  const retracted: GroupRumorInput[] = [];
  const handlers: GroupHistoryHandlers = {
    dispatch: async (input) => void dispatched.push(input),
    retract: async (input) => void retracted.push(input),
  };
  return { handlers, dispatched, retracted };
}

beforeEach(() => {
  for (const m of dbs.values()) m.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GroupRumorInput.receivedAt', () => {
  it('a live dispatch carries the first-append time that the row persists (and a withdraw retract carries it too)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5_000_000));
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('e1'));
    expect(fx.dispatched[0].receivedAt).toBe(5_000_000);
    expect((db().get(rowKey('e1')) as { receivedAt: number }).receivedAt).toBe(5_000_000);
    vi.setSystemTime(new Date(9_000_000));
    await sink.withdraw(G, [hex('e1')]);
    expect(fx.retracted[0].receivedAt).toBe(5_000_000);
  });

  it('a LATE dispatch (recovery after a restart) carries the row\'s original time, not the time of the recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(50_000_000));
    db().set(rowKey('late'), { entry: entry('late'), seq: 1, dispatched: false, receivedAt: 123_000 });
    db().set(rowKey('old'), { entry: entry('old', 1_600_000_000), seq: 2, dispatched: false }); // written before receivedAt existed
    const fx = fixture();
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(fx.dispatched.map((d) => [Buffer.from(d.eventId, 'hex').toString(), d.receivedAt])).toEqual([
      ['late', 123_000],
      ['old', 1_600_000_000_000],
    ]);
  });
});
