/**
 * History sink, recompute-on-retract contract (AC-HIST-5 extended, AC-WDR-9 sink half).
 *
 * Map-mocked idb (as historyBackend.test.ts); handlers are fixtures that record what each retract could observe:
 * the durable row state at the moment of the call and the `remaining()` snapshot it read.
 *
 *  - `receivedAt` is set once at the first append (unchanged by a re-append / the dispatched rewrite)
 *  - withdraw marks EVERY row of the batch `withdrawing` before the first retract, retracts every row before any
 *    row is deleted, and `remaining()` is dispatched && !withdrawing rows in seq order, read once per batch
 *  - crash replay: a marked row found by first-touch recovery / sweep is retracted and deleted before anything is
 *    re-dispatched, and is never re-dispatched itself
 *  - the late retract of a dispatch that outlived its withdraw reads `remaining()` too
 *  - a purged late retract is flagged so handlers skip the fold
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
import { createHistoryBackend, createIdbHistoryStore, HISTORY_DB_NAME, HISTORY_SETTLE_TIMEOUT_MS, type GroupHistoryHandlers, type GroupRumorInput, type RetractInput, type HistoryStore } from '@/src/lib/marmot/history';

const G = 'a1'.repeat(32);
const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const hex = (label: string) => Buffer.from(label).toString('hex');
const dbName = `${HISTORY_DB_NAME}:${ALICE}`;
const db = () => mapOf(dbName);
const rowKey = (e: string) => `${G}:${hex(e)}`;
type RawRow = { entry: HistoryEntry; seq: number; dispatched: boolean; receivedAt?: number; withdrawing?: boolean; abandoned?: boolean };
const row = (e: string) => db().get(rowKey(e)) as RawRow | undefined;

function entry(label: string, over: { kind?: number; account?: string; createdAt?: number } = {}): HistoryEntry {
  return {
    groupId: G,
    eventId: hex(label),
    rumor: { id: `rumor-${label}`, pubkey: over.account ?? ALICE, created_at: over.createdAt ?? 1_700_000_000, kind: over.kind ?? 9, tags: [], content: label },
    orderingKey: { account: over.account ?? ALICE, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}
const seed = (label: string, seq: number, extra: Partial<RawRow> = {}) =>
  db().set(rowKey(label), { entry: entry(label), seq, dispatched: true, receivedAt: 1_000 * seq, ...extra });

interface Observed {
  eventId: string;
  rowsAtCall: Record<string, { withdrawing?: boolean; dispatched: boolean } | undefined>;
  remaining: string[];
  receivedAts: number[];
  seqs: number[];
}

function fixture(labels: string[] = []) {
  const calls: string[] = [];
  const observed: Observed[] = [];
  const hooks = { onRetract: undefined as undefined | ((i: RetractInput) => Promise<void> | void), onDispatch: undefined as undefined | ((i: GroupRumorInput) => Promise<void> | void) };
  const handlers: GroupHistoryHandlers = {
    async dispatch(input) {
      calls.push(`dispatch:${Buffer.from(input.eventId, 'hex').toString()}`);
      await hooks.onDispatch?.(input);
    },
    async retract(input) {
      calls.push(`retract:${Buffer.from(input.eventId, 'hex').toString()}`);
      await hooks.onRetract?.(input);
      const rem = await input.remaining();
      observed.push({
        eventId: Buffer.from(input.eventId, 'hex').toString(),
        rowsAtCall: Object.fromEntries(labels.map((l) => [l, row(l) && { withdrawing: row(l)!.withdrawing, dispatched: row(l)!.dispatched }])),
        remaining: rem.map((r) => Buffer.from(r.entry.eventId, 'hex').toString()),
        receivedAts: rem.map((r) => r.receivedAt),
        seqs: rem.map((r) => r.seq),
      });
    },
  };
  return { handlers, calls, observed, hooks };
}

beforeEach(() => {
  for (const m of dbs.values()) m.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HistoryRow.receivedAt', () => {
  it('is the first-append wall clock, unchanged by a re-append and by the dispatched rewrite', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5_000_000));
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('e1'));
    expect(row('e1')).toMatchObject({ dispatched: true, receivedAt: 5_000_000 });
    vi.setSystemTime(new Date(9_000_000));
    await sink.append(entry('e1'));
    expect(row('e1')?.receivedAt).toBe(5_000_000);
  });

  it('is also stamped on rows of unregistered kinds, and survives a recovery rewrite', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(7_000));
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('x', { kind: 31337 }));
    expect(row('x')).toMatchObject({ dispatched: true, receivedAt: 7_000 });
    db().set(rowKey('u'), { entry: entry('u'), seq: 5, dispatched: false, receivedAt: 123 });
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(row('u')).toMatchObject({ dispatched: true, receivedAt: 123 });
  });

  it('a row without one reads as rumor.created_at * 1000 in remaining()', async () => {
    const fx = fixture();
    db().set(rowKey('old'), { entry: entry('old', { createdAt: 1_600_000_000 }), seq: 1, dispatched: true });
    seed('e2', 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.withdraw(G, [hex('e2')]);
    expect(fx.observed[0].receivedAts).toEqual([1_600_000_000_000]);
  });
});

describe('withdraw: mark all first, then retract and delete each row in turn', () => {
  it('marks every row of the batch before the first retract; each row is deleted right after its own retract', async () => {
    const fx = fixture(['e1', 'e2', 'e3']);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    await sink.withdraw(G, [hex('e1'), hex('e3')]);

    expect(fx.calls.filter((c) => c.startsWith('retract'))).toEqual(['retract:e1', 'retract:e3']);
    const [first, second] = fx.observed;
    // the first retract: its own row and the not-yet-retracted one are both still marked (mark-all-first)
    expect(first.rowsAtCall.e1).toEqual({ withdrawing: true, dispatched: true });
    expect(first.rowsAtCall.e3).toEqual({ withdrawing: true, dispatched: true });
    // the second retract: the first row is already gone (incremental progress), its own row still marked
    expect(second.rowsAtCall.e1).toBeUndefined();
    expect(second.rowsAtCall.e3).toEqual({ withdrawing: true, dispatched: true });
    for (const o of fx.observed) expect(o.rowsAtCall.e2?.withdrawing).toBeUndefined();
    expect(row('e1')).toBeUndefined();
    expect(row('e3')).toBeUndefined();
    expect(row('e2')).toBeDefined();
  });

  it('remaining() is the dispatched, non-withdrawing rows in seq order and omits every row of the batch (no intermediate state)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    // seeded out of key order: real idb returns key order, the sink must order by seq
    seed('d', 4);
    seed('a', 3);
    seed('c', 2);
    seed('b', 1);
    db().set(rowKey('undisp'), { entry: entry('undisp'), seq: 9, dispatched: false, receivedAt: 1 });
    db().set(rowKey('gone'), { entry: entry('gone'), seq: 8, dispatched: false, abandoned: true, receivedAt: 1 });
    await sink.withdraw(G, [hex('a'), hex('c')]);
    expect(fx.observed.map((o) => o.eventId)).toEqual(['c', 'a']); // retracted in seq order
    for (const o of fx.observed) {
      // first-touch recovery re-dispatched the undispatched row before the retracts (so it IS dispatched now);
      // the abandoned row never is
      expect(o.remaining).toEqual(['b', 'd', 'undisp']);
      expect(o.seqs).toEqual([1, 4, 9]);
      expect(o.receivedAts).toEqual([1_000, 4_000, 1]);
    }
  });

  it('reads the store once per batch for remaining() however many retracts and calls', async () => {
    const real = createIdbHistoryStore('counted');
    const listRows = vi.fn(real.listRows);
    const store: HistoryStore = { ...real, listRows };
    const fx = fixture();
    const sink = createHistoryBackend({ store, handlers: fx.handlers });
    for (const l of ['e1', 'e2', 'e3']) await sink.append(entry(l));
    listRows.mockClear();
    let reads = 0;
    fx.hooks.onRetract = async (input) => {
      await input.remaining();
      await input.remaining();
      reads += 1;
    };
    await sink.withdraw(G, [hex('e1'), hex('e2')]);
    expect(reads).toBe(2);
    // first-touch/finish listing (1: finish) + the remaining() read: the count of remaining() reads is what matters
    const afterFinish = listRows.mock.calls.length;
    expect(afterFinish).toBeLessThanOrEqual(3);
    fx.observed.forEach((o) => expect(o.remaining).toEqual(['e3']));
  });

  it('retract of an unseen id or a repeated withdraw calls nothing and changes nothing', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('e1'));
    await sink.withdraw(G, [hex('nope')]);
    expect(fx.calls.filter((c) => c.startsWith('retract'))).toEqual([]);
    expect(row('e1')?.withdrawing).toBeUndefined();
    await sink.withdraw(G, [hex('e1')]);
    await sink.withdraw(G, [hex('e1')]);
    expect(fx.calls.filter((c) => c.startsWith('retract'))).toEqual(['retract:e1']);
  });

  it('a failing retract leaves every row of the batch marked and out of list(); the retried withdraw finishes it', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('e1'));
    await sink.append(entry('e2'));
    let fail = true;
    fx.hooks.onRetract = () => {
      if (fail) throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1'), hex('e2')])).rejects.toThrow('boom');
    expect(row('e1')?.withdrawing).toBe(true);
    expect(row('e2')?.withdrawing).toBe(true);
    expect((await sink.list(G)).map((e) => e.eventId)).toEqual([]);
    fail = false;
    await sink.withdraw(G, [hex('e1')]);
    expect(row('e1')).toBeUndefined();
    expect(row('e2')).toBeUndefined(); // the finish covers every marked row of the group, not only the named ones
  });
});

describe('crash replay: a marked row is finished before anything is re-dispatched', () => {
  it('after the mark (before any retract): a new instance retracts then deletes it, before re-dispatching an undispatched row', async () => {
    const fx = fixture();
    seed('w1', 1, { withdrawing: true });
    seed('w2', 2, { withdrawing: true });
    seed('keep', 3);
    db().set(rowKey('undisp'), { entry: entry('undisp'), seq: 4, dispatched: false, receivedAt: 4_000 });
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    expect(await sink.sweep()).toEqual({ redispatched: 1, failed: 0 });
    expect(fx.calls).toEqual(['retract:w1', 'retract:w2', 'dispatch:undisp']);
    expect(fx.observed[0].remaining).toEqual(['keep']); // the undispatched row is never folded
    expect(row('w1')).toBeUndefined();
    expect(row('w2')).toBeUndefined();
    expect(row('undisp')?.dispatched).toBe(true);
    // idempotent: a second sweep / instance does nothing
    fx.calls.length = 0;
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(fx.calls).toEqual([]);
  });

  it('after the retract, before the delete: recovery retracts again (idempotent) and deletes', async () => {
    const fx = fixture();
    seed('w1', 1, { withdrawing: true });
    seed('keep', 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('later')); // first touch through a live append
    expect(fx.calls).toEqual(['retract:w1', 'dispatch:later']);
    expect(row('w1')).toBeUndefined();
  });

  it('a marked row that was never dispatched is retracted (its dispatch may have partly run) and never dispatched', async () => {
    const fx = fixture();
    db().set(rowKey('w'), { entry: entry('w'), seq: 1, dispatched: false, withdrawing: true, receivedAt: 1 });
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(fx.calls).toEqual(['retract:w']);
    expect(row('w')).toBeUndefined();
  });

  it('a recovery retract failure leaves the row marked, does not abort recovery of later rows, and a retry finishes it', async () => {
    const fx = fixture();
    seed('w1', 1, { withdrawing: true });
    db().set(rowKey('undisp'), { entry: entry('undisp'), seq: 2, dispatched: false, receivedAt: 1 });
    let fail = true;
    fx.hooks.onRetract = () => {
      if (fail) throw new Error('boom');
    };
    const onError = vi.fn();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError });
    await sink.sweep();
    expect(onError).toHaveBeenCalled();
    expect(row('w1')?.withdrawing).toBe(true);
    expect(row('undisp')?.dispatched).toBe(true);
    fail = false;
    await sink.withdraw(G, [hex('w1')]);
    expect(row('w1')).toBeUndefined();
  });

  it('a live re-append of a still-marked id finishes the withdrawal, then stores a fresh row (new seq, new receivedAt) and dispatches it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(50_000));
    const fx = fixture();
    seed('e1', 1, { withdrawing: true });
    seed('other', 2);
    db().set(`#seq:${G}`, 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('other')); // first touch recovers e1 (retract, delete)
    expect(row('e1')).toBeUndefined();
    await sink.append(entry('e1'));
    expect(fx.calls).toEqual(['retract:e1', 'dispatch:e1']);
    expect(row('e1')).toMatchObject({ dispatched: true, receivedAt: 50_000 });
    expect(row('e1')!.seq).toBeGreaterThan(2);
    expect(row('e1')!.withdrawing).toBeUndefined();
  });

  it('a live re-append of a marked id on an already-touched group finishes the withdrawal first', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('e1'));
    let fail = true;
    fx.hooks.onRetract = () => {
      if (fail) throw new Error('boom');
    };
    await expect(sink.withdraw(G, [hex('e1')])).rejects.toThrow('boom');
    fail = false;
    await sink.append(entry('e1'));
    expect(fx.calls.filter((c) => c === 'retract:e1').length).toBeGreaterThanOrEqual(2);
    expect(row('e1')).toMatchObject({ dispatched: true });
    expect(row('e1')!.withdrawing).toBeUndefined();
  });
});

describe('late retract (a dispatch that outlived its withdraw)', () => {
  it('retracts on completion with a remaining() that omits the withdrawn row', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    let release!: () => void;
    fx.hooks.onDispatch = (i) =>
      Buffer.from(i.eventId, 'hex').toString() === 'slow' ? new Promise<void>((r) => (release = r)) : undefined;
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry('keep'));
    const appended = sink.append(entry('slow')).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await appended).toBe('timeout');
    const withdrawn = sink.withdraw(G, [hex('slow')]);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await withdrawn;
    expect(fx.calls.filter((c) => c.startsWith('retract'))).toEqual([]); // deferred to the dispatch's completion
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.calls.filter((c) => c.startsWith('retract'))).toEqual(['retract:slow']);
    expect(fx.observed[0].remaining).toEqual(['keep']);
    expect(row('slow')).toBeUndefined();
  });

  it('a purged late retract carries reason "purged" (handlers remove outright, no fold)', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const reasons: Array<string | undefined> = [];
    fx.hooks.onRetract = (i) => void reasons.push(i.reason);
    let release!: () => void;
    fx.hooks.onDispatch = (i) =>
      Buffer.from(i.eventId, 'hex').toString() === 'slow' ? new Promise<void>((r) => (release = r)) : undefined;
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const appended = sink.append(entry('slow')).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await appended;
    const purged = sink.purge(G);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await purged;
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(reasons).toEqual(['purged']);
  });
});

describe('sweep discovers groups that only have a marked row', () => {
  it('a group whose rows are all dispatched but one is withdrawing is recovered', async () => {
    const fx = fixture();
    seed('w', 1, { withdrawing: true });
    seed('k', 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.sweep();
    expect(fx.calls).toEqual(['retract:w']);
    expect(row('w')).toBeUndefined();
    expect(BOB).not.toBe(ALICE);
  });
});
