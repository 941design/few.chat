/**
 * History sink: a withdraw makes INCREMENTAL progress (AC-HIST-5, AC-WDR-9).
 *
 * Mark-all-first stays; then each marked row is retracted and deleted in turn, each step under its own settle bound,
 * so a timeout or a failing retract mid-batch leaves the earlier rows deleted and the later ones marked, and the next
 * append / withdraw of the group (or a restart) finishes them. Handlers are fixtures; the aggregate dedupe is covered
 * in handlers/withdrawBatchDedupe.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';

const { dbs, failSet } = vi.hoisted(() => ({
  dbs: new Map<string, Map<string, unknown>>(),
  failSet: { when: undefined as undefined | ((k: string, v: unknown) => boolean) },
}));
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
    set: async (k: string, v: unknown, s: MapUseStore) => {
      if (failSet.when?.(k, v)) throw new Error('idb write failed');
      s.map.set(k, structuredClone(v));
    },
    del: async (k: string, s: MapUseStore) => void s.map.delete(k),
    delMany: async (ks: string[], s: MapUseStore) => void ks.forEach((k) => s.map.delete(k)),
    keys: async (s: MapUseStore) => [...s.map.keys()],
    entries: async (s: MapUseStore) => [...s.map.entries()].map(([k, v]) => [k, structuredClone(v)]),
  };
});

import type { MapUseStore } from './mapIdbStore';
import { createHistoryBackend, HISTORY_DB_NAME, HISTORY_SETTLE_TIMEOUT_MS, type GroupHistoryHandlers, type RetractInput } from '@/src/lib/marmot/history';

const G = 'a1'.repeat(32);
const ALICE = 'aa'.repeat(32);
const hex = (label: string) => Buffer.from(label).toString('hex');
const label = (eventId: string) => Buffer.from(eventId, 'hex').toString();
const db = () => mapOf(`${HISTORY_DB_NAME}:${ALICE}`);
const rowKey = (e: string) => `${G}:${hex(e)}`;
type RawRow = { entry: HistoryEntry; seq: number; dispatched: boolean; receivedAt?: number; withdrawing?: boolean };
const row = (e: string) => db().get(rowKey(e)) as RawRow | undefined;

const entry = (l: string, kind = 9): HistoryEntry => ({
  groupId: G,
  eventId: hex(l),
  rumor: { id: `rumor-${l}`, pubkey: ALICE, created_at: 1_700_000_000, kind, tags: [], content: l },
  orderingKey: { account: ALICE, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
});

function fixture() {
  const calls: string[] = [];
  const hooks = { onRetract: undefined as undefined | ((i: RetractInput) => Promise<void> | void) };
  const handlers: GroupHistoryHandlers = {
    async dispatch(input) {
      calls.push(`dispatch:${label(input.eventId)}`);
    },
    async retract(input) {
      calls.push(`retract:${label(input.eventId)}`);
      await hooks.onRetract?.(input);
    },
  };
  return { handlers, calls, hooks };
}

beforeEach(() => {
  for (const m of dbs.values()) m.clear();
  failSet.when = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a retract that fails mid-batch', () => {
  it('leaves the rows before it deleted and the rows from it on marked (and out of list())', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    fx.hooks.onRetract = (i) => {
      if (label(i.eventId) === 'e2') throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1'), hex('e2'), hex('e3')])).rejects.toThrow('boom');
    expect(row('e1')).toBeUndefined(); // finished before the failure: not repeated work for the retry
    expect(row('e2')?.withdrawing).toBe(true);
    expect(row('e3')?.withdrawing).toBe(true);
    expect((await sink.list(G)).map((e) => label(e.eventId))).toEqual([]);

    fx.calls.length = 0;
    fx.hooks.onRetract = undefined;
    await sink.withdraw(G, [hex('e1'), hex('e2'), hex('e3')]);
    expect(fx.calls).toEqual(['retract:e2', 'retract:e3']); // e1 is not retracted a second time
    expect(row('e2')).toBeUndefined();
    expect(row('e3')).toBeUndefined();
  });

  it('is finished at the start of the NEXT APPEND of the group, before the new row is dispatched', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    let fail = true;
    fx.hooks.onRetract = (i) => {
      if (fail && label(i.eventId) === 'e2') throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1'), hex('e2'), hex('e3')])).rejects.toThrow('boom');
    fail = false;
    fx.calls.length = 0;

    await sink.append(entry('e4'));
    expect(fx.calls).toEqual(['retract:e2', 'retract:e3', 'dispatch:e4']);
    expect(row('e2')).toBeUndefined();
    expect(row('e3')).toBeUndefined();
    expect(row('e4')?.dispatched).toBe(true);
  });

  it('is finished by the next withdraw of the group even when that one names an unrelated id', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    let fail = true;
    fx.hooks.onRetract = (i) => {
      if (fail && label(i.eventId) === 'e1') throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1'), hex('e2')])).rejects.toThrow('boom');
    fail = false;
    await sink.withdraw(G, [hex('e3')]);
    expect([row('e1'), row('e2'), row('e3')]).toEqual([undefined, undefined, undefined]);
  });

  it('is finished by a restart (a new backend instance recovers the marked rows on first touch)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2']) await sink.append(entry(l));
    fx.hooks.onRetract = (i) => {
      if (label(i.eventId) === 'e1') throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1'), hex('e2')])).rejects.toThrow('boom');
    fx.hooks.onRetract = undefined;
    fx.calls.length = 0;
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(fx.calls).toEqual(['retract:e1', 'retract:e2']);
    expect([row('e1'), row('e2')]).toEqual([undefined, undefined]);
  });
});

describe('the settle bound applies per step, not to the whole batch', () => {
  it('a hanging retract times out the call, leaves earlier rows deleted and later ones marked; the next append finishes them', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    let hang = true;
    fx.hooks.onRetract = (i) => (hang && label(i.eventId) === 'e2' ? new Promise<void>(() => undefined) : undefined);
    const withdrawn = sink.withdraw(G, [hex('e1'), hex('e2'), hex('e3')]).then(
      () => 'resolved',
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await withdrawn).toBe('HistorySettleTimeoutError');
    expect(row('e1')).toBeUndefined();
    expect(row('e2')?.withdrawing).toBe(true); // its retract never finished: not deleted
    expect(row('e3')?.withdrawing).toBe(true); // never reached

    hang = false;
    fx.calls.length = 0;
    await sink.append(entry('e4'));
    expect(fx.calls).toEqual(['retract:e2', 'retract:e3', 'dispatch:e4']);
    expect([row('e2'), row('e3')]).toEqual([undefined, undefined]);
  });

  it('a batch whose steps each take less than the bound but together more completes in one call', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    fx.hooks.onRetract = () => new Promise<void>((resolve) => setTimeout(resolve, 6_000));
    const withdrawn = sink.withdraw(G, [hex('e1'), hex('e2'), hex('e3')]);
    await vi.advanceTimersByTimeAsync(18_500); // 3 x 6 s > one bound of 10 s
    await expect(withdrawn).resolves.toBeUndefined();
    expect([row('e1'), row('e2'), row('e3')]).toEqual([undefined, undefined, undefined]);
  });
});

describe('RetractInput.batch', () => {
  it('names every row of the finish (seq order, this row included); all are absent from remaining()', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    const seen: Array<{ batch: string[]; remaining: string[] }> = [];
    fx.hooks.onRetract = async (i) => {
      seen.push({ batch: (i.batch ?? []).map((b) => label(b.eventId)), remaining: (await i.remaining()).map((r) => label(r.entry.eventId)) });
    };
    await sink.withdraw(G, [hex('e3'), hex('e1')]);
    expect(seen).toEqual([
      { batch: ['e1', 'e3'], remaining: ['e2'] },
      { batch: ['e1', 'e3'], remaining: ['e2'] },
    ]);
  });
});

describe('a withdraw whose mark step fails part-way', () => {
  it('is finished by the next append of the touched group (not only by a later withdraw or restart)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2']) await sink.append(entry(l));
    // Marking e1 succeeds, marking e2 fails: e1 is left marked (hidden from list()) with its effect still stored.
    failSet.when = (k, v) => k === rowKey('e2') && (v as RawRow).withdrawing === true;
    await expect(sink.withdraw(G, [hex('e1'), hex('e2')])).rejects.toThrow('idb write failed');
    expect(row('e1')?.withdrawing).toBe(true);
    expect(fx.calls).not.toContain('retract:e1');
    failSet.when = undefined;
    await sink.append(entry('e3'));
    expect(fx.calls).toContain('retract:e1');
    expect(row('e1')).toBeUndefined();
    expect(row('e2')?.withdrawing).toBeUndefined();
    expect(row('e3')?.dispatched).toBe(true);
  });
});
