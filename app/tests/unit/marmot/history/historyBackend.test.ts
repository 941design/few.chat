/**
 * App HistoryBackend (S3): AC-HIST-1..7, AC-IDEM-1/2, AC-WDR-4.
 *
 * idb-keyval is mocked with Maps (per-db, structured-cloned like the real
 * thing). The Maps return INSERTION order from keys()/entries() while real
 * IndexedDB returns key order, so every ordering assertion seeds rows out of
 * key order. Handlers are test fixtures writing into in-memory "app stores";
 * the SUT (backend + row store) is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmotError, type HistoryEntry } from '@941design/marmot';

const { dbs, writeLog, ioHooks } = vi.hoisted(() => ({
  dbs: new Map<string, Map<string, unknown>>(),
  writeLog: [] as Array<{ key: string; dispatched?: boolean }>,
  /** Lets a test make an idb write slower than the settle bound. */
  ioHooks: { beforeSet: undefined as undefined | ((key: string, value: unknown) => Promise<void>) },
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
  get: async (k: string, s: MapUseStore) => {
    const v = s.map.get(k);
    return v === undefined ? undefined : structuredClone(v);
  },
  set: async (k: string, v: unknown, s: MapUseStore) => {
    await ioHooks.beforeSet?.(k, v);
    writeLog.push({ key: k, dispatched: (v as { dispatched?: boolean } | null)?.dispatched });
    s.map.set(k, structuredClone(v));
  },
  del: async (k: string, s: MapUseStore) => {
    s.map.delete(k);
  },
  delMany: async (ks: string[], s: MapUseStore) => {
    for (const k of ks) s.map.delete(k);
  },
  keys: async (s: MapUseStore) => [...s.map.keys()],
  entries: async (s: MapUseStore) => [...s.map.entries()].map(([k, v]) => [k, structuredClone(v)]),
  };
});

import type { MapUseStore } from './mapIdbStore';
import { createHistoryBackend, HISTORY_DB_NAME, HISTORY_SETTLE_TIMEOUT_MS, type GroupHistoryHandlers, type GroupRumorInput } from '@/src/lib/marmot/history';
import { APP_RUMOR_KINDS } from '@/src/lib/marmot/kinds';

const G1 = 'a1'.repeat(32);
const G2 = 'b2'.repeat(32);
const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const db = () => mapOf(`${HISTORY_DB_NAME}:${ALICE}`);
const rowKey = (g: string, e: string) => `${g}:${e}`;
const row = (g: string, e: string) => db().get(rowKey(g, e)) as { entry: HistoryEntry; seq: number; dispatched: boolean } | undefined;

function entry(over: { groupId?: string; eventId: string; kind?: number; rumorId?: string; pubkey?: string; account?: string; content?: string }): HistoryEntry {
  const eventId = over.eventId;
  return {
    groupId: over.groupId ?? G1,
    eventId,
    rumor: {
      id: over.rumorId ?? `rumor-${eventId}`,
      pubkey: over.pubkey ?? ALICE,
      created_at: 1_700_000_000,
      kind: over.kind ?? 9,
      tags: [],
      content: over.content ?? `hello ${eventId}`,
    },
    orderingKey: { account: over.account ?? ALICE, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}

/** Fixture app stores (chat / reaction / poll rows keyed by rumor id) and spy handlers over them. */
function fixture() {
  const chat = new Map<string, string>();
  const reactions = new Map<string, string>();
  const polls = new Map<string, string>();
  const storeFor = (kind: number) => (kind === 9 ? chat : kind === 7 ? reactions : kind === 10 ? polls : undefined);
  const dispatchCalls: GroupRumorInput[] = [];
  const retractCalls: GroupRumorInput[] = [];
  const hooks = {
    onDispatch: undefined as undefined | ((i: GroupRumorInput) => Promise<void> | void),
    onRetract: undefined as undefined | ((i: GroupRumorInput) => Promise<void> | void),
  };
  const handlers: GroupHistoryHandlers = {
    async dispatch(input) {
      dispatchCalls.push(input);
      await hooks.onDispatch?.(input);
      storeFor(input.rumor.kind)?.set(input.rumor.id, input.sender);
    },
    async retract(input) {
      retractCalls.push(input);
      await hooks.onRetract?.(input);
      storeFor(input.rumor.kind)?.delete(input.rumor.id);
    },
  };
  return { chat, reactions, polls, handlers, dispatchCalls, retractCalls, hooks };
}

beforeEach(() => {
  // the default store is a module singleton bound to its Map: clear in place, never replace
  for (const m of dbs.values()) m.clear();
  writeLog.length = 0;
  ioHooks.beforeSet = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AC-HIST-1: append persists, dispatches once, marks dispatched', () => {
  it('writes the row undispatched BEFORE the handlers run, then rewrites it dispatched:true', async () => {
    const fx = fixture();
    const seenDuringDispatch: Array<{ seq: number; dispatched: boolean } | undefined> = [];
    fx.hooks.onDispatch = async () => {
      const r = row(G1, 'e1');
      seenDuringDispatch.push(r && { seq: r.seq, dispatched: r.dispatched });
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    await sink.append(e);

    expect(seenDuringDispatch).toEqual([{ seq: 1, dispatched: false }]);
    expect(row(G1, 'e1')).toEqual({ entry: e, seq: 1, dispatched: true });
    expect(fx.dispatchCalls).toEqual([{ groupId: G1, eventId: 'e1', rumor: e.rumor, sender: ALICE }]);
    expect(fx.chat.get('rumor-e1')).toBe(ALICE);
    // the order of writes: row (false) then rewrite (true); counter written first
    expect(writeLog.filter((w) => w.key === rowKey(G1, 'e1')).map((w) => w.dispatched)).toEqual([false, true]);
  });

  it('is a no-op for the stored row but dispatches nothing twice (second append of a dispatched row)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1' }));
    await sink.append(entry({ eventId: 'e1' }));
    expect(fx.dispatchCalls).toHaveLength(1);
  });
});

describe('AC-HIST-2: sender is orderingKey.account, never rumor.pubkey', () => {
  it('hands the handler the account even when rumor.pubkey differs (dispatch and retract)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1', pubkey: BOB, account: ALICE }));
    expect(fx.dispatchCalls[0].sender).toBe(ALICE);
    expect(fx.dispatchCalls[0].rumor.pubkey).toBe(BOB);
    await sink.withdraw(G1, ['e1']);
    expect(fx.retractCalls[0].sender).toBe(ALICE);
  });

  it('rejects an entry without an authenticated account instead of falling back to the rumor', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const bad = entry({ eventId: 'e1' });
    (bad.orderingKey as { account: string }).account = '';
    await expect(sink.append(bad)).rejects.toThrow(/orderingKey\.account/);
    expect(db().size).toBe(0);
    expect(fx.dispatchCalls).toHaveLength(0);
  });
});

describe('ids must be hex', () => {
  it.each([
    ['groupId with a colon', { groupId: 'a1:b2', eventId: 'e1' }],
    ['eventId with a colon', { eventId: 'e1:e2' }],
    ['non-hex eventId', { eventId: 'xyz' }],
    ['non-hex groupId', { groupId: 'not-hex', eventId: 'e1' }],
  ])('rejects %s and writes nothing', async (_name, over) => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await expect(sink.append(entry(over))).rejects.toThrow(/hex/);
    expect(db().size).toBe(0);
    expect(fx.dispatchCalls).toHaveLength(0);
  });

  it('accepts upper-case hex', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await expect(sink.append(entry({ groupId: 'A1B2', eventId: 'EF01' }))).resolves.toBeUndefined();
  });
});

describe('AC-HIST-3: a throwing handler rejects append and leaves the row for retry', () => {
  it('rejects, keeps dispatched:false, then a retry re-runs the handlers and marks it dispatched', async () => {
    const fx = fixture();
    let fail = true;
    fx.hooks.onDispatch = () => {
      if (fail) throw new Error('disk full');
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    await expect(sink.append(e)).rejects.toThrow('disk full');
    expect(row(G1, 'e1')).toEqual({ entry: e, seq: 1, dispatched: false });

    fail = false;
    await sink.append(e);
    expect(fx.dispatchCalls).toHaveLength(2);
    expect(row(G1, 'e1')).toEqual({ entry: e, seq: 1, dispatched: true });
  });

  it('a synchronous handler throw also rejects the call; other rows of the group are untouched', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1' }));
    fx.handlers.dispatch = () => {
      throw new Error('sync boom');
    };
    const failing = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await expect(failing.append(entry({ eventId: 'e2' }))).rejects.toThrow('sync boom');
    expect(row(G1, 'e1')!.dispatched).toBe(true);
    expect(row(G1, 'e2')!.dispatched).toBe(false);
  });

  it('a failure of the call marks no row of its own dispatched; an earlier undispatched row is recovered first (AC-HIST-7)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    fx.hooks.onDispatch = (i) => {
      if (i.eventId === 'e2') throw new Error('nope');
    };
    // e1 failed earlier (still false): the first touch of the group recovers it ahead of e2; e2 fails now
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false });
    await expect(sink.append(entry({ eventId: 'e2' }))).rejects.toThrow('nope');
    expect(row(G1, 'e1')!.dispatched).toBe(true);
    expect(row(G1, 'e2')!.dispatched).toBe(false);
  });
});

describe('AC-HIST-4: append settles within 10 s', () => {
  it('a handler that never resolves makes append reject at 10 s, row stays dispatched:false', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    fx.hooks.onDispatch = () => new Promise<void>(() => undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    let outcome: 'pending' | 'resolved' | { rejected: unknown } = 'pending';
    const call = sink.append(entry({ eventId: 'e1' }));
    call.then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = { rejected: e }),
    );
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ rejected: expect.objectContaining({ message: expect.stringMatching(/did not settle within 10000 ms/) }) });
    expect(row(G1, 'e1')!.dispatched).toBe(false);
    expect(HISTORY_SETTLE_TIMEOUT_MS).toBe(10_000);
  });

  it('a timed-out call is abandoned: its late completion does not mark the row dispatched', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    let release!: () => void;
    fx.hooks.onDispatch = () => new Promise<void>((r) => (release = r));
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const call = sink.append(entry({ eventId: 'e1' }));
    const settled = call.catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await settled).toBe('timeout');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(row(G1, 'e1')!.dispatched).toBe(false);
  });

  it('a timed-out call does not stall the group: the next append for it runs', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    fx.hooks.onDispatch = (i) => (i.eventId === 'a09' ? new Promise<void>(() => undefined) : undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const hung = sink.append(entry({ eventId: 'a09' })).catch(() => 'timeout');
    const next = sink.append(entry({ eventId: 'e2' }));
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await hung).toBe('timeout');
    await next;
    expect(row(G1, 'e2')!.dispatched).toBe(true);
    expect(row(G1, 'a09')!.dispatched).toBe(false);
  });

  it('settleTimeoutMs is honoured (a hung withdraw retract rejects too)', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, settleTimeoutMs: 50 });
    await sink.append(entry({ eventId: 'e1' }));
    fx.hooks.onRetract = () => new Promise<void>(() => undefined);
    const call = sink.withdraw(G1, ['e1']).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(50);
    expect(await call).toMatch(/did not settle within 50 ms/);
    expect(row(G1, 'e1')).toBeDefined();
  });
});

describe('AC-HIST-5: withdraw deletes rows and retracts once per withdrawn row', () => {
  it('retracts and deletes only the named rows; unknown ids are a silent no-op', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e1 = entry({ eventId: 'e1' });
    await sink.append(e1);
    await sink.append(entry({ eventId: 'e2' }));
    await sink.withdraw(G1, ['e1', 'never-seen']);

    expect(fx.retractCalls).toEqual([{ groupId: G1, eventId: 'e1', rumor: e1.rumor, sender: ALICE }]);
    expect(row(G1, 'e1')).toBeUndefined();
    expect(row(G1, 'e2')).toBeDefined();
    expect(fx.chat.has('rumor-e1')).toBe(false);
    expect(fx.chat.has('rumor-e2')).toBe(true);
  });

  it('a repeated id in one call retracts once; a repeated call (at-least-once) retracts nothing more', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1' }));
    await sink.withdraw(G1, ['e1', 'e1']);
    await sink.withdraw(G1, ['e1']);
    expect(fx.retractCalls).toHaveLength(1);
  });

  it('a failing retract rejects with the row still present; the retried withdraw retracts it', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1' }));
    let fail = true;
    fx.hooks.onRetract = () => {
      if (fail) throw new Error('retract failed');
    };
    await expect(sink.withdraw(G1, ['e1'])).rejects.toThrow('retract failed');
    expect(row(G1, 'e1')).toBeDefined();
    expect(fx.chat.has('rumor-e1')).toBe(true);
    fail = false;
    await sink.withdraw(G1, ['e1']);
    expect(row(G1, 'e1')).toBeUndefined();
    expect(fx.chat.has('rumor-e1')).toBe(false);
  });

  it('retracts an undispatched row too (a crash mid-handler may have left effects)', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false });
    await sink.withdraw(G1, ['e1']);
    expect(fx.retractCalls).toHaveLength(1);
    expect(row(G1, 'e1')).toBeUndefined();
  });

  it('does not touch the same event id in another group', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ groupId: G1, eventId: 'e1' }));
    await sink.append(entry({ groupId: G2, eventId: 'e1', rumorId: 'other' }));
    await sink.withdraw(G1, ['e1']);
    expect(row(G2, 'e1')).toBeDefined();
    expect(fx.chat.has('other')).toBe(true);
  });
});

describe('AC-HIST-6: purge deletes one group and nothing else', () => {
  it('removes every row of the group (and its counter), keeps other groups', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ groupId: G1, eventId: 'e1' }));
    await sink.append(entry({ groupId: G1, eventId: 'e2' }));
    await sink.append(entry({ groupId: G2, eventId: 'e1' }));
    await sink.purge(G1);
    expect([...db().keys()].filter((k) => k.includes(G1))).toEqual([]);
    expect(row(G2, 'e1')).toBeDefined();
    expect(await sink.list(G1)).toEqual([]);
    expect((await sink.list(G2)).map((x) => x.eventId)).toEqual(['e1']);
    // the other group's counter survived: its next row continues at 2
    await sink.append(entry({ groupId: G2, eventId: 'e2' }));
    expect(row(G2, 'e2')!.seq).toBe(2);
    expect(fx.retractCalls).toHaveLength(0); // purge is teardown, not a retraction
  });

  it('purge of an unknown group is a no-op', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await expect(sink.purge(G1)).resolves.toBeUndefined();
  });
});

describe('AC-HIST-7: startup sweep', () => {
  const seed = (g: string, e: string, seq: number, dispatched: boolean, account = ALICE) =>
    db().set(rowKey(g, e), { entry: entry({ groupId: g, eventId: e, account }), seq, dispatched });

  it('re-dispatches undispatched rows per group in seq order (seeded out of key and seq order), marks them, skips dispatched rows', async () => {
    const fx = fixture();
    // insertion order deliberately unrelated to seq and group order
    seed(G2, 'z', 2, false);
    seed(G1, 'c', 3, false);
    seed(G1, 'a', 1, false);
    seed(G1, 'done', 2, true);
    seed(G2, 'fe', 1, false);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const result = await sink.sweep();

    expect(result).toEqual({ redispatched: 4, failed: 0 });
    expect(fx.dispatchCalls.map((c) => `${c.groupId === G1 ? 'G1' : 'G2'}:${c.eventId}`)).toEqual(['G1:a', 'G1:c', 'G2:fe', 'G2:z']);
    for (const [g, e] of [[G1, 'a'], [G1, 'c'], [G1, 'done'], [G2, 'fe'], [G2, 'z']] as const) expect(row(g, e)!.dispatched).toBe(true);
    expect(fx.dispatchCalls.some((c) => c.eventId === 'done')).toBe(false);
  });

  it('a failing row stays undispatched and is reported; the sweep continues with the group and with other groups', async () => {
    const fx = fixture();
    seed(G1, 'a', 1, false);
    seed(G1, 'bad', 2, false);
    seed(G1, 'c', 3, false);
    seed(G2, 'fe', 1, false);
    fx.hooks.onDispatch = (i) => {
      if (i.eventId === 'bad') throw new Error('poisoned');
    };
    const errors: Array<{ error: unknown; ctx: unknown }> = [];
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: (error, ctx) => errors.push({ error, ctx }) });
    const result = await sink.sweep();

    expect(result).toEqual({ redispatched: 3, failed: 1 });
    expect(row(G1, 'bad')!.dispatched).toBe(false);
    expect(row(G1, 'a')!.dispatched).toBe(true);
    expect(row(G1, 'c')!.dispatched).toBe(true);
    expect(row(G2, 'fe')!.dispatched).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].ctx).toEqual({ groupId: G1, eventId: 'bad' });
    expect((errors[0].error as Error).message).toBe('poisoned');
  });

  it('a second sweep after success re-dispatches nothing', async () => {
    const fx = fixture();
    seed(G1, 'a', 1, false);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.sweep();
    fx.dispatchCalls.length = 0;
    expect(await sink.sweep()).toEqual({ redispatched: 0, failed: 0 });
    expect(fx.dispatchCalls).toHaveLength(0);
  });

  it('a hung handler costs the sweep at most the settle bound and the sweep goes on', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    seed(G1, 'a09', 1, false);
    seed(G2, 'fe', 1, false);
    fx.hooks.onDispatch = (i) => (i.eventId === 'a09' ? new Promise<void>(() => undefined) : undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const done = sink.sweep();
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await done).toEqual({ redispatched: 1, failed: 1 });
    expect(row(G1, 'a09')!.dispatched).toBe(false);
    expect(row(G2, 'fe')!.dispatched).toBe(true);
  });

  it('skips rows of unregistered kinds in effect: they are marked dispatched without a handler call', async () => {
    const fx = fixture();
    db().set(rowKey(G1, 'add'), { entry: entry({ eventId: 'add', kind: 14 }), seq: 1, dispatched: false });
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    expect(await sink.sweep()).toEqual({ redispatched: 1, failed: 0 });
    expect(fx.dispatchCalls).toHaveLength(0);
    expect(row(G1, 'add')!.dispatched).toBe(true);
  });
});

describe('AC-HIST-7: first-touch recovery, poison bound', () => {
  const seed = (g: string, e: string, seq: number, extra: Record<string, unknown> = {}) =>
    db().set(rowKey(g, e), { entry: entry({ groupId: g, eventId: e }), seq, dispatched: false, ...extra });

  it('a live append issued before sweep() runs after the recovered rows: handler order row1, row2, new; a following sweep dispatches nothing for the group', async () => {
    const fx = fixture();
    seed(G1, 'row2', 2);
    seed(G1, 'a0a1', 1);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: '0ee' }));
    expect(fx.dispatchCalls.map((c) => c.eventId)).toEqual(['a0a1', 'row2', '0ee']);
    expect(row(G1, 'a0a1')!.dispatched && row(G1, 'row2')!.dispatched && row(G1, '0ee')!.dispatched).toBe(true);
    fx.dispatchCalls.length = 0;
    expect(await sink.sweep()).toEqual({ redispatched: 0, failed: 0 });
    expect(fx.dispatchCalls).toHaveLength(0);
  });

  it('a live withdraw also triggers the group recovery first (of the rows it does not withdraw)', async () => {
    const fx = fixture();
    seed(G1, 'a0a1', 1);
    seed(G1, 'row2', 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.withdraw(G1, ['row2']);
    expect(fx.dispatchCalls.map((c) => c.eventId)).toEqual(['a0a1']);
    expect(fx.retractCalls.map((c) => c.eventId)).toEqual(['row2']);
    expect(row(G1, 'a0a1')!.dispatched).toBe(true);
    expect(row(G1, 'row2')).toBeUndefined();
  });

  it('a withdraw-triggered recovery skips the rows that withdraw names: their irreversible effects (AC-WDR-6) never fire', async () => {
    const fx = fixture();
    seed(G1, 'a0a1', 1);
    seed(G1, 'row2', 2);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.withdraw(G1, ['a0a1', 'row2']);
    expect(fx.dispatchCalls).toEqual([]);
    expect(fx.retractCalls.map((c) => c.eventId).sort()).toEqual(['a0a1', 'row2']);
    expect(await sink.list(G1)).toEqual([]);
    expect(fx.chat.size).toBe(0);
  });

  it('an append whose eventId equals a recovered row calls the handler once in total', async () => {
    const fx = fixture();
    seed(G1, 'a0a1', 1);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'a0a1' }));
    expect(fx.dispatchCalls.filter((c) => c.eventId === 'a0a1')).toHaveLength(1);
    expect(row(G1, 'a0a1')!.dispatched).toBe(true);
  });

  it('recovery runs once per group per instance and only for the touched group', async () => {
    const fx = fixture();
    seed(G1, 'a', 1);
    seed(G2, 'b', 1);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ groupId: G1, eventId: 'a9' }));
    expect(fx.dispatchCalls.map((c) => c.eventId)).toEqual(['a', 'a9']);
    expect(row(G2, 'b')!.dispatched).toBe(false);
    expect(await sink.sweep()).toEqual({ redispatched: 1, failed: 0 }); // only G2 was still untouched
    expect(row(G2, 'b')!.dispatched).toBe(true);
  });

  it('a recovery failure does not reject the triggering append, keeps the row undispatched and does not stop later rows or groups', async () => {
    const fx = fixture();
    seed(G1, 'a', 1);
    seed(G1, 'bad', 2);
    seed(G1, 'c', 3);
    fx.hooks.onDispatch = (i) => {
      if (i.eventId === 'bad') throw new Error('poisoned');
    };
    const errors: unknown[] = [];
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: (e) => errors.push(e) });
    await expect(sink.append(entry({ eventId: 'fade' }))).resolves.toBeUndefined();
    expect(fx.dispatchCalls.map((c) => c.eventId)).toEqual(['a', 'bad', 'c', 'fade']);
    expect(row(G1, 'bad')).toMatchObject({ dispatched: false, recoveryFailures: 1 });
    expect(row(G1, 'c')!.dispatched).toBe(true);
    expect(row(G1, 'fade')!.dispatched).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('a row failing recovery 5 times is abandoned (reported once) and never attempted a 6th time, also across new instances', async () => {
    const fx = fixture();
    seed(G1, 'bad', 1);
    fx.hooks.onDispatch = (i) => {
      if (i.eventId === 'bad') throw new Error('poisoned');
    };
    const errors: Array<Error> = [];
    const newInstance = () => createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: (e) => errors.push(e as Error) });
    for (let i = 1; i <= 5; i++) {
      expect(await newInstance().sweep()).toEqual({ redispatched: 0, failed: 1 });
      expect(row(G1, 'bad')!.recoveryFailures).toBe(i);
    }
    expect(row(G1, 'bad')).toMatchObject({ abandoned: true, dispatched: false, recoveryFailures: 5 });
    expect(errors.filter((e) => /abandoned/.test(e.message))).toHaveLength(1);
    const calls = fx.dispatchCalls.length;
    expect(calls).toBe(5);

    // a 6th and 7th instance: by sweep and by a live append of another entry
    expect(await newInstance().sweep()).toEqual({ redispatched: 0, failed: 0 });
    await newInstance().append(entry({ eventId: 'fade' }));
    expect(fx.dispatchCalls.filter((c) => c.eventId === 'bad')).toHaveLength(5);
    expect(errors.filter((e) => /abandoned/.test(e.message))).toHaveLength(1);
    expect((await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).list(G1)).map((e) => e.eventId)).toEqual(['bad', 'fade']);
  });

  it('the persisted failure counter survives instances: 4 earlier failures + 1 more abandons on the first recovery', async () => {
    const fx = fixture();
    seed(G1, 'bad', 1, { recoveryFailures: 4 });
    fx.hooks.onDispatch = () => {
      throw new Error('still poisoned');
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    await sink.sweep();
    expect(row(G1, 'bad')).toMatchObject({ abandoned: true, recoveryFailures: 5 });
  });

  it('a successful recovery clears the bookkeeping: the row is a plain dispatched row', async () => {
    const fx = fixture();
    seed(G1, 'a', 1, { recoveryFailures: 3 });
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).sweep();
    expect(row(G1, 'a')).toEqual({ entry: entry({ eventId: 'a' }), seq: 1, dispatched: true });
  });
});

describe('in-flight dispatch is never started twice for one event id', () => {
  it('after a timeout, a re-append of the same entry joins the running dispatch instead of starting a second one', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    fx.hooks.onDispatch = () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((r) => {
        release = () => {
          running -= 1;
          r();
        };
      });
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    const first = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await first).toBe('timeout');

    const second = sink.append(e);
    let state: 'pending' | 'ok' | 'rejected' = 'pending';
    second.then(() => (state = 'ok'), () => (state = 'rejected'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.dispatchCalls).toHaveLength(1);
    expect(maxRunning).toBe(1);
    expect(state).toBe('pending');

    release(); // the original dispatch finally completes: the second call is its beneficiary
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toBe('ok');
    expect(fx.dispatchCalls).toHaveLength(1);
    expect(row(G1, 'e1')!.dispatched).toBe(true);
  });

  it('a joined dispatch is bounded again: the re-append rejects at 10 s while the original still hangs, with no second handler run', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    fx.hooks.onDispatch = () => new Promise<void>(() => undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    const first = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await first;
    const second = sink.append(e).catch((x: Error) => x.message);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await second).toMatch(/did not settle within 10000 ms/);
    expect(fx.dispatchCalls).toHaveLength(1);
  });

  it('a recovery that timed out leaves its dispatch in flight: a later re-append of that id joins it', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false });
    let running = 0;
    let maxRunning = 0;
    fx.hooks.onDispatch = () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>(() => undefined);
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const swept = sink.sweep();
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await swept).toEqual({ redispatched: 0, failed: 1 });
    const again = sink.append(entry({ eventId: 'e1' })).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await again).toBe('timeout');
    expect(maxRunning).toBe(1);
    expect(fx.dispatchCalls).toHaveLength(1);
  });
});

describe('withdraw of an id whose dispatch is still running (late dispatch)', () => {
  /** A dispatch that outlives its bound; `release()` lets it finish (and write its effects). */
  function hangingDispatch(fx: ReturnType<typeof fixture>) {
    let release!: () => void;
    fx.hooks.onDispatch = () =>
      new Promise<void>((r) => {
        release = r;
      });
    return { release: () => release() };
  }

  it('a dispatch that finishes after its withdraw is retracted exactly once, leaving no row and no effects', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const hang = hangingDispatch(fx);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    const appended = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await appended).toBe('timeout');
    expect(row(G1, 'e1')!.dispatched).toBe(false);

    let withdrawn = false;
    const w = sink.withdraw(G1, ['e1']).then(() => (withdrawn = true));
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await w;
    expect(withdrawn).toBe(true);
    expect(row(G1, 'e1')).toBeUndefined();
    expect(await sink.list(G1)).toEqual([]);
    expect(fx.retractCalls).toHaveLength(0); // nothing to undo yet

    hang.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.retractCalls).toHaveLength(1);
    expect(fx.retractCalls[0]).toMatchObject({ groupId: G1, eventId: 'e1' });
    expect(fx.chat.size).toBe(0); // the late effects were undone
    expect(row(G1, 'e1')).toBeUndefined(); // the late completion marked nothing dispatched
    expect(await sink.list(G1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(fx.retractCalls).toHaveLength(1);
  });

  it('a withdraw that arrives while the dispatch finishes within the bound retracts normally, once', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const hang = hangingDispatch(fx);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const appended = sink.append(entry({ eventId: 'e1' })).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await appended;
    const w = sink.withdraw(G1, ['e1']);
    await vi.advanceTimersByTimeAsync(1_000);
    hang.release();
    await vi.advanceTimersByTimeAsync(0);
    await w;
    expect(fx.retractCalls).toHaveLength(1);
    expect(fx.chat.size).toBe(0);
    expect(row(G1, 'e1')).toBeUndefined();
  });
});

describe('AC-IDEM-1: replay is idempotent', () => {
  it('replaying a dispatched event leaves one row, one chat/reaction/poll row each, one handler call each', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const chat = entry({ eventId: 'c1', kind: 9 });
    const reaction = entry({ eventId: 'a0b1', kind: 7 });
    const poll = entry({ eventId: 'a0c1', kind: 10 });
    for (let i = 0; i < 3; i++) for (const e of [chat, reaction, poll]) await sink.append(e);

    expect([...db().keys()].filter((k) => !k.startsWith('#'))).toHaveLength(3);
    expect(fx.chat.size).toBe(1);
    expect(fx.reactions.size).toBe(1);
    expect(fx.polls.size).toBe(1);
    expect(fx.dispatchCalls).toHaveLength(3);
  });

  it('re-appending an undispatched row re-runs the handlers and keeps its seq', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 7, dispatched: false });
    await sink.append(entry({ eventId: 'e1' }));
    expect(fx.dispatchCalls).toHaveLength(1);
    expect(row(G1, 'e1')).toMatchObject({ seq: 7, dispatched: true });
  });

  it('two concurrent appends of the same event run the handlers once (per-group serialisation)', async () => {
    const fx = fixture();
    fx.hooks.onDispatch = () => new Promise((r) => setTimeout(r, 5));
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    await Promise.all([sink.append(e), sink.append(e)]);
    expect(fx.dispatchCalls).toHaveLength(1);
    expect(row(G1, 'e1')!.seq).toBe(1);
  });
});

describe('AC-IDEM-2: list is seq-ordered; seq is a per-group monotonic counter', () => {
  it('lists by seq ascending although the rows were inserted (and keyed) out of order', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    db().set(rowKey(G1, 'f0f'), { entry: entry({ eventId: 'f0f' }), seq: 1, dispatched: true });
    db().set(rowKey(G1, 'aaa'), { entry: entry({ eventId: 'aaa' }), seq: 3, dispatched: true });
    db().set(rowKey(G2, 'b1d'), { entry: entry({ groupId: G2, eventId: 'b1d' }), seq: 1, dispatched: true });
    db().set(rowKey(G1, 'e0e'), { entry: entry({ eventId: 'e0e' }), seq: 2, dispatched: true });
    expect((await sink.list(G1)).map((e) => e.eventId)).toEqual(['f0f', 'e0e', 'aaa']);
    expect((await sink.list(G2)).map((e) => e.eventId)).toEqual(['b1d']);
  });

  it('assigns 1,2,3 per group independently and never changes it on re-append', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await sink.append(entry({ groupId: G1, eventId: 'b' }));
    await sink.append(entry({ groupId: G2, eventId: 'ff' }));
    await sink.append(entry({ groupId: G1, eventId: 'a' }));
    await sink.append(entry({ groupId: G1, eventId: 'b' })); // re-append
    await sink.append(entry({ groupId: G2, eventId: 'fe' }));
    expect(row(G1, 'b')!.seq).toBe(1);
    expect(row(G1, 'a')!.seq).toBe(2);
    expect(row(G2, 'ff')!.seq).toBe(1);
    expect(row(G2, 'fe')!.seq).toBe(2);
    expect((await sink.list(G1)).map((e) => e.eventId)).toEqual(['b', 'a']);
  });

  it('never reuses a seq after a withdraw', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await sink.append(entry({ eventId: 'a' }));
    await sink.append(entry({ eventId: 'b' }));
    await sink.withdraw(G1, ['b']);
    await sink.append(entry({ eventId: 'c' }));
    expect(row(G1, 'c')!.seq).toBe(3);
  });

  it('concurrent appends of different events get distinct, gap-free seqs in call order', async () => {
    const fx = fixture();
    fx.hooks.onDispatch = () => new Promise((r) => setTimeout(r, 1));
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => sink.append(entry({ eventId: id }))));
    expect((await sink.list(G1)).map((e) => e.eventId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => row(G1, id)!.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('list skips a malformed stored value instead of failing the whole group', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await sink.append(entry({ eventId: 'a' }));
    db().set(rowKey(G1, 'junk'), { nope: true });
    expect((await sink.list(G1)).map((e) => e.eventId)).toEqual(['a']);
  });
});

describe('AC-WDR-4: withdraw without a prior append changes nothing', () => {
  it('withdraw of a never-appended id leaves rows and app stores unchanged', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: 'e1' }));
    const dbBefore = structuredClone([...db().entries()]);
    const chatBefore = [...fx.chat.entries()];
    await sink.withdraw(G1, ['ghost']);
    expect([...db().entries()]).toEqual(dbBefore);
    expect([...fx.chat.entries()]).toEqual(chatBefore);
    expect(fx.retractCalls).toHaveLength(0);
  });

  it('a withdraw that precedes the append of the same id changes nothing, and leaves no tombstone behind', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.withdraw(G1, ['e1']);
    expect(db().size).toBe(0);
    expect(fx.retractCalls).toHaveLength(0);
    expect(fx.chat.size).toBe(0);
    await sink.append(entry({ eventId: 'e1' }));
    expect(fx.chat.has('rumor-e1')).toBe(true);
  });
});

describe('registered kinds and the handler port', () => {
  it.each([...APP_RUMOR_KINDS])('kind %i reaches the handler port', async (kind) => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await sink.append(entry({ eventId: `c${kind}`, kind }));
    expect(fx.dispatchCalls.map((c) => c.rumor.kind)).toEqual([kind]);
    expect(row(G1, `c${kind}`)!.dispatched).toBe(true);
  });

  it('an unregistered kind is stored dispatched:true with no handler call, no throw; its withdraw does not retract', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await expect(sink.append(entry({ eventId: 'add', kind: 14 }))).resolves.toBeUndefined();
    expect(row(G1, 'add')).toMatchObject({ dispatched: true, seq: 1 });
    expect(fx.dispatchCalls).toHaveLength(0);
    await sink.withdraw(G1, ['add']);
    expect(fx.retractCalls).toHaveLength(0);
    expect(row(G1, 'add')).toBeUndefined();
  });

  it('fails loudly when the handlers port is missing or incomplete', () => {
    expect(() => createHistoryBackend({} as never)).toThrow(/"handlers"/);
    expect(() => createHistoryBackend({ accountPubkey: ALICE, handlers: { dispatch: async () => undefined } } as never)).toThrow(/"handlers"/);
    expect(() => createHistoryBackend(undefined as never)).toThrow(TypeError);
  });

  it('a no-op handler port would be caught: effects exist only because dispatch ran', async () => {
    const fx = fixture();
    const noop = createHistoryBackend({ accountPubkey: ALICE, handlers: { dispatch: async () => undefined, retract: async () => undefined } });
    await noop.append(entry({ eventId: 'e1' }));
    expect(fx.chat.size).toBe(0);
    const real = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    await real.append(entry({ eventId: 'e2' }));
    expect(fx.chat.size).toBe(1);
  });
});

/** A promise settled from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('purge with a dispatch still in flight', () => {
  /** First dispatch hangs until released; later ones complete at once. */
  function firstHangs(fx: ReturnType<typeof fixture>) {
    const gate = deferred();
    let calls = 0;
    fx.hooks.onDispatch = () => (++calls === 1 ? gate.promise : undefined);
    return gate;
  }

  it('hung dispatch -> append times out -> purge -> release: exactly one retract, no row, effects undone; a later append of the id dispatches fresh', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const gate = firstHangs(fx);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    const appended = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await appended).toBe('timeout');

    const purged = sink.purge(G1);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await purged;
    expect(row(G1, 'e1')).toBeUndefined();
    expect(fx.retractCalls).toHaveLength(0);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.retractCalls).toHaveLength(1);
    expect(fx.chat.size).toBe(0);
    expect(row(G1, 'e1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(fx.retractCalls).toHaveLength(1);

    await sink.append(e); // the group was re-joined: fresh dispatch, new row
    expect(fx.dispatchCalls).toHaveLength(2);
    expect(fx.chat.size).toBe(1);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: true });
  });

  it('no stale in-flight entry survives the purge: an append right after it dispatches fresh instead of joining the hung one', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    firstHangs(fx);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const e = entry({ eventId: 'e1' });
    const appended = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await appended;
    const purged = sink.purge(G1);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await purged;

    await sink.append(e);
    expect(fx.dispatchCalls).toHaveLength(2);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: true });
  });
});

describe('late (retract-on-settle) retract runs serialised, skips a returned row, retries', () => {
  /** Hangs the first dispatch past its bound, then withdraws the id: the late retract is armed. */
  async function armedLateRetract(fx: ReturnType<typeof fixture>, onError?: () => void) {
    vi.useFakeTimers();
    const gate = deferred();
    let calls = 0;
    fx.hooks.onDispatch = () => (++calls === 1 ? gate.promise : undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError });
    const e = entry({ eventId: 'e1' });
    const appended = sink.append(e).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await appended;
    const withdrawn = sink.withdraw(G1, ['e1']);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await withdrawn;
    return { sink, e, gate };
  }

  it('a re-append issued as the late dispatch settles loses nothing: the retract is skipped because the row exists again', async () => {
    const fx = fixture();
    const { sink, e, gate } = await armedLateRetract(fx);
    gate.resolve();
    const reAppended = sink.append(e);
    await vi.advanceTimersByTimeAsync(0);
    await reAppended;
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(fx.retractCalls).toHaveLength(0);
    expect(fx.chat.get('rumor-e1')).toBe(ALICE);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: true });
  });

  it('a retract that fails twice and then succeeds removes the effects, with no error report', async () => {
    const fx = fixture();
    const onError = vi.fn();
    const { gate } = await armedLateRetract(fx, onError);
    let attempts = 0;
    fx.hooks.onRetract = () => {
      if (++attempts <= 2) throw new Error(`retract boom ${attempts}`);
    };
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(3);
    expect(fx.chat.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a retract that keeps failing is attempted a bounded number of times, then reported once', async () => {
    const fx = fixture();
    const onError = vi.fn();
    const { gate } = await armedLateRetract(fx, onError);
    fx.hooks.onRetract = () => {
      throw new Error('always');
    };
    gate.resolve();
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS * 4);
    expect(fx.retractCalls).toHaveLength(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toEqual({ groupId: G1, eventId: 'e1' });
  });
});

describe('a call that timed out writes nothing afterwards', () => {
  it('append: an idb write slower than the bound does not go on to run the handlers', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const slow = deferred();
    ioHooks.beforeSet = (key, value) => (key === rowKey(G1, 'e1') && (value as { dispatched: boolean }).dispatched === false ? slow.promise : Promise.resolve());
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const appended = sink.append(entry({ eventId: 'e1' })).catch((x: Error) => x.message);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await appended).toMatch(/did not settle/);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.dispatchCalls).toHaveLength(0);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false }); // recoverable, never half-marked
  });

  it('withdraw: a retract slower than the bound does not go on to delete the row', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    await createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers }).append(entry({ eventId: 'e1' }));
    const slow = deferred();
    fx.hooks.onRetract = () => slow.promise;
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    const withdrawn = sink.withdraw(G1, ['e1']).catch((x: Error) => x.message);
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await withdrawn).toMatch(/did not settle/);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(row(G1, 'e1')).toBeDefined(); // still there: the library retries the withdraw
  });
});

describe('transient client errors during recovery do not poison rows', () => {
  it.each(['disposed', 'no-lease'] as const)('a %s rejection is reported and leaves recoveryFailures unchanged', async (code) => {
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false, recoveryFailures: 2 });
    fx.hooks.onDispatch = () => {
      throw new MarmotError(code, `client ${code}`);
    };
    const onError = vi.fn();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError });
    expect(await sink.sweep()).toEqual({ redispatched: 0, failed: 1 });
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false, recoveryFailures: 2 });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('a reentrant client error is a real recovery failure', () => {
  it('counts on the row (a deterministic reentrant is a handler bug) and abandons it at the cap', async () => {
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false, recoveryFailures: 2 });
    fx.hooks.onDispatch = () => {
      throw new MarmotError('reentrant', 'client reentrant');
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    await sink.sweep();
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false, recoveryFailures: 3 });
  });
});

describe('dispose()', () => {
  it('stops recovery between rows: no handler call after dispose, the remaining rows stay untouched', async () => {
    const fx = fixture();
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      db().set(rowKey(G1, id), { entry: entry({ eventId: id }), seq: i + 1, dispatched: false });
    }
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    fx.hooks.onDispatch = () => void sink.dispose();
    await sink.sweep().catch(() => undefined);
    expect(fx.dispatchCalls.map((d) => d.eventId)).toEqual(['a']);
    expect(row(G1, 'b')).toMatchObject({ dispatched: false });
    expect(row(G1, 'c')).toMatchObject({ dispatched: false });
    // the dispatch that was running at dispose() finished, but its `dispatched:true` write is a no-op
    expect(row(G1, 'a')).toMatchObject({ dispatched: false });
  });

  it('no store write lands after dispose: an append whose handler is still running leaves the row untouched', async () => {
    const fx = fixture();
    const gate = deferred();
    fx.hooks.onDispatch = () => gate.promise;
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const pending = sink.append(entry({ eventId: 'e1' })).catch(() => undefined);
    await vi.waitFor(() => expect(fx.dispatchCalls).toHaveLength(1));
    const before = structuredClone([...db().entries()]);
    const writesBefore = writeLog.length;
    sink.dispose();
    gate.resolve();
    await pending;
    expect([...db().entries()]).toEqual(before);
    expect(writeLog).toHaveLength(writesBefore);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false });
  });

  it('no row delete lands after dispose: a withdraw whose retract is still running keeps the row', async () => {
    const fx = fixture();
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    await sink.append(entry({ eventId: 'e1' }));
    const gate = deferred();
    fx.hooks.onRetract = () => gate.promise;
    const pending = sink.withdraw(G1, ['e1']).catch(() => undefined);
    await vi.waitFor(() => expect(fx.retractCalls).toHaveLength(1));
    sink.dispose();
    gate.resolve();
    await pending;
    expect(row(G1, 'e1')).toBeDefined();
  });

  it('no failure counter is written after dispose', async () => {
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), { entry: entry({ eventId: 'e1' }), seq: 1, dispatched: false });
    const gate = deferred();
    fx.hooks.onDispatch = async () => {
      await gate.promise;
      throw new Error('boom');
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const pending = sink.sweep().catch(() => undefined);
    await vi.waitFor(() => expect(fx.dispatchCalls).toHaveLength(1));
    sink.dispose();
    gate.resolve();
    await pending;
    expect(row(G1, 'e1')).toEqual({ entry: expect.anything(), seq: 1, dispatched: false });
  });

  it('rejects every later call with a clear error, and is idempotent', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await sink.append(entry({ eventId: 'e1' }));
    sink.dispose();
    sink.dispose();
    await expect(sink.append(entry({ eventId: 'e2' }))).rejects.toThrow(/disposed/);
    await expect(sink.withdraw(G1, ['e1'])).rejects.toThrow(/disposed/);
    await expect(sink.list(G1)).rejects.toThrow(/disposed/);
    await expect(sink.purge(G1)).rejects.toThrow(/disposed/);
    await expect(sink.sweep()).rejects.toThrow(/disposed/);
    expect(row(G1, 'e1')).toBeDefined(); // nothing was touched
  });
});

describe('dispose() drains in-flight jobs (bounded)', () => {
  it('resolves only after the running append job has settled; its dispatched:true write stays a no-op', async () => {
    const fx = fixture();
    const gate = deferred();
    fx.hooks.onDispatch = () => gate.promise;
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const pending = sink.append(entry({ eventId: 'e1' })).catch(() => undefined);
    await vi.waitFor(() => expect(fx.dispatchCalls).toHaveLength(1));
    let drained = false;
    const draining = sink.dispose().then(() => void (drained = true));
    await new Promise((r) => setTimeout(r, 25));
    expect(drained).toBe(false); // the job is still running: teardown must wait for it
    gate.resolve();
    await draining;
    await pending;
    expect(drained).toBe(true);
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false });
  });

  it('is bounded by one settle bound when a handler never settles', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    fx.hooks.onDispatch = () => new Promise<void>(() => undefined);
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    void sink.append(entry({ eventId: 'e1' })).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.dispatchCalls).toHaveLength(1);
    let drained = false;
    const draining = sink.dispose().then(() => void (drained = true));
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS - 1);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(drained).toBe(true);
  });

  it('resolves at once when nothing is running, and returns the same promise on every call', async () => {
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fixture().handlers });
    await sink.append(entry({ eventId: 'e1' }));
    const first = sink.dispose();
    expect(sink.dispose()).toBe(first);
    await first;
  });

  it('drops a late retract pending at dispose: a withdrawn message whose dispatch completes after dispose keeps its effects', async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const gate = deferred();
    fx.hooks.onDispatch = async (i) => {
      await gate.promise;
      fx.chat.set(i.rumor.id, i.sender);
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    const appended = sink.append(entry({ eventId: 'e1' })).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    expect(await appended).toBe('timeout');
    const withdrawn = sink.withdraw(G1, ['e1']); // the dispatch is still running: armed for a late retract
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await withdrawn;
    const draining = sink.dispose();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await draining;
    expect(fx.retractCalls).toEqual([]);
    expect(fx.chat.size).toBe(1);
  });
});

describe('the history store is per account (few-group-history:<pubkey>)', () => {
  it('writes rows only to the account database', async () => {
    const sink = createHistoryBackend({ accountPubkey: BOB, handlers: fixture().handlers });
    await sink.append(entry({ eventId: 'e1' }));
    expect(mapOf(`${HISTORY_DB_NAME}:${BOB}`).has(rowKey(G1, 'e1'))).toBe(true);
    expect(db().size).toBe(0);
    expect(dbs.has(HISTORY_DB_NAME)).toBe(false); // no device-global store
  });

  it.each([undefined, '', 'AA'.repeat(32), 'aa'.repeat(31), 'zz'.repeat(32), 'aa'.repeat(32) + 'a', '../x'])(
    'rejects the account pubkey %j (no store injected)',
    (pubkey) => {
      expect(() => createHistoryBackend({ accountPubkey: pubkey as never, handlers: fixture().handlers })).toThrow(/pubkey/);
    },
  );

  it('a row that no account owns cannot suppress another account: same ids dispatch independently', async () => {
    const fa = fixture();
    const fb = fixture();
    const a = createHistoryBackend({ accountPubkey: ALICE, handlers: fa.handlers });
    const b = createHistoryBackend({ accountPubkey: BOB, handlers: fb.handlers });
    await a.append(entry({ eventId: 'e1' }));
    await b.append(entry({ eventId: 'e1' }));
    expect(fa.dispatchCalls).toHaveLength(1);
    expect(fb.dispatchCalls).toHaveLength(1);
  });
});

describe('a LIVE re-append of an abandoned row is a legitimate retry', () => {
  const abandoned = () => ({ entry: entry({ eventId: 'e1' }), seq: 4, dispatched: false, recoveryFailures: 5, abandoned: true });

  it('re-runs the handlers; success marks the row dispatched and clears abandoned, keeping its seq', async () => {
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), abandoned());
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers });
    expect(await sink.sweep()).toEqual({ redispatched: 0, failed: 0 }); // recovery still skips it
    expect(fx.dispatchCalls).toHaveLength(0);
    await sink.append(entry({ eventId: 'e1' }));
    expect(fx.dispatchCalls.map((d) => d.eventId)).toEqual(['e1']);
    expect(row(G1, 'e1')).toEqual({ entry: expect.anything(), seq: 4, dispatched: true });
  });

  it('a failing live retry rejects and leaves the row abandoned', async () => {
    const fx = fixture();
    db().set(rowKey(G1, 'e1'), abandoned());
    fx.hooks.onDispatch = () => {
      throw new Error('still broken');
    };
    const sink = createHistoryBackend({ accountPubkey: ALICE, handlers: fx.handlers, onError: () => undefined });
    await expect(sink.append(entry({ eventId: 'e1' }))).rejects.toThrow('still broken');
    expect(row(G1, 'e1')).toMatchObject({ dispatched: false, abandoned: true, recoveryFailures: 5 });
  });
});
