/**
 * Row store + backend on REAL IndexedDB semantics (fake-indexeddb through the
 * real idb-keyval): the Map mocks used elsewhere return insertion order, real
 * IndexedDB returns KEY order, and only the real thing shows that `seq` -- not
 * key order -- drives `list` and the sweep (AC-IDEM-2, AC-HIST-7), and that the
 * data survives a "reload" (a new backend over the same database).
 */
import 'fake-indexeddb/auto';
import { createStore, keys } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { clearAllGroupHistory, createHistoryBackend, createIdbHistoryStore, historyDbName, type GroupHistoryHandlers, type GroupRumorInput, type HistoryRow } from '@/src/lib/marmot/history';

let n = 0;
const freshDb = () => `few-group-history-test-${++n}`;
const ACCOUNT = 'aa'.repeat(32);

function entry(groupId: string, eventId: string, kind = 9): HistoryEntry {
  return {
    groupId,
    eventId,
    rumor: { id: `r-${eventId}`, pubkey: ACCOUNT, created_at: 1, kind, tags: [], content: eventId },
    orderingKey: { account: ACCOUNT, leafIndex: 0, epoch: 3n, generation: 0, acceptedDigest: 'dd' },
  };
}

function recorder() {
  const dispatched: GroupRumorInput[] = [];
  const retracted: GroupRumorInput[] = [];
  const handlers: GroupHistoryHandlers = {
    dispatch: async (i) => void dispatched.push(i),
    retract: async (i) => void retracted.push(i),
  };
  return { handlers, dispatched, retracted };
}

describe('real IndexedDB', () => {
  it('list orders by seq even though the keys sort differently (bigint epoch survives the clone)', async () => {
    const dbName = freshDb();
    const store = createIdbHistoryStore(dbName);
    // key order is a < b < c; delivery (seq) order is c, a, b
    await store.putRow({ entry: entry('ab', 'c'), seq: 1, dispatched: true });
    await store.putRow({ entry: entry('ab', 'a'), seq: 2, dispatched: true });
    await store.putRow({ entry: entry('ab', 'b'), seq: 3, dispatched: true });
    const raw = await keys<string>(createStore(dbName, 'rows'));
    expect(raw).toEqual(['ab:a', 'ab:b', 'ab:c']); // the store itself is key-ordered
    const backend = createHistoryBackend({ handlers: recorder().handlers, store });
    const listed = await backend.list('ab');
    expect(listed.map((e) => e.eventId)).toEqual(['c', 'a', 'b']);
    expect(listed[0].orderingKey.epoch).toBe(3n);
  });

  it('appends keep per-group counters; purge removes one group and its counter only', async () => {
    const store = createIdbHistoryStore(freshDb());
    const backend = createHistoryBackend({ handlers: recorder().handlers, store });
    await backend.append(entry('a1', 'f'));
    await backend.append(entry('a1', 'a'));
    await backend.append(entry('a2', 'd'));
    expect((await backend.list('a1')).map((e) => e.eventId)).toEqual(['f', 'a']);
    await backend.purge('a1');
    expect(await backend.list('a1')).toEqual([]);
    expect((await backend.list('a2')).map((e) => e.eventId)).toEqual(['d']);
    await backend.append(entry('a1', 'c'));
    expect((await store.getRow('a1', 'c'))!.seq).toBe(1); // purged group starts over
    await backend.append(entry('a2', 'b'));
    expect((await store.getRow('a2', 'b'))!.seq).toBe(2);
  });

  it('a group id that is a prefix of another group id is not purged along with it', async () => {
    const store = createIdbHistoryStore(freshDb());
    const backend = createHistoryBackend({ handlers: recorder().handlers, store });
    await backend.append(entry('ab', 'e1'));
    await backend.append(entry('abc', 'e1'));
    await backend.purge('ab');
    expect((await backend.list('abc')).map((e) => e.eventId)).toEqual(['e1']);
  });

  it('survives a reload: rows seeded undispatched (crash between persist and dispatch) are re-dispatched in seq order by a new backend', async () => {
    const dbName = freshDb();
    const before = createIdbHistoryStore(dbName);
    // crash window: rows persisted, handlers never ran; key order differs from seq order
    await before.putRow({ entry: entry('ab', 'b'), seq: 1, dispatched: false });
    await before.putRow({ entry: entry('ab', 'a'), seq: 2, dispatched: false });
    await before.putRow({ entry: entry('ab', 'done'), seq: 3, dispatched: true });

    const rec = recorder();
    const after = createHistoryBackend({ handlers: rec.handlers, store: createIdbHistoryStore(dbName) });
    expect(await after.sweep()).toEqual({ redispatched: 2, failed: 0 });
    expect(rec.dispatched.map((d) => d.eventId)).toEqual(['b', 'a']);
    expect((await createIdbHistoryStore(dbName).listRows('ab')).every((r) => r.dispatched)).toBe(true);
    expect(await after.sweep()).toEqual({ redispatched: 0, failed: 0 });
  });

  it('a withdrawn row is gone after a reload and a late append of it is applied as new', async () => {
    const dbName = freshDb();
    const rec = recorder();
    const first = createHistoryBackend({ handlers: rec.handlers, store: createIdbHistoryStore(dbName) });
    await first.append(entry('ab', 'e1'));
    await first.withdraw('ab', ['e1']);
    const second = createHistoryBackend({ handlers: rec.handlers, store: createIdbHistoryStore(dbName) });
    expect(await second.list('ab')).toEqual([]);
    expect(rec.retracted.map((r) => r.eventId)).toEqual(['e1']);

    // the library re-appends the id once its branch is canonical again: applied as new, one row, one more dispatch
    await second.append(entry('ab', 'e1'));
    expect((await second.list('ab')).map((e) => e.eventId)).toEqual(['e1']);
    expect(rec.dispatched.filter((d) => d.eventId === 'e1')).toHaveLength(2);
    const row = await createIdbHistoryStore(dbName).getRow('ab', 'e1');
    expect(row).toMatchObject({ dispatched: true });
    expect(row!.seq).toBeGreaterThan(1); // seq is never reused after a withdraw
  });

  it('rolls back an interrupted mark batch and accepts the full outbox replay after restart', async () => {
    const dbName = freshDb();
    const groupId = 'ab';
    const ids = ['e2', 'e1', 'e0']; // e0 was never appended
    const rec = recorder();
    const first = createHistoryBackend({ handlers: rec.handlers, store: createIdbHistoryStore(dbName) });
    const entries = ['e1', 'e2', 'e3'].map((id) => entry(groupId, id));
    for (const item of entries) await first.append(item);

    const put = IDBObjectStore.prototype.put;
    let marks = 0;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: HistoryRow, key?: IDBValidKey) {
      const request = put.call(this, value, key);
      if (value.withdrawing && ++marks === 2) {
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });
    try {
      await expect(first.withdraw(groupId, ids)).rejects.toBeDefined();
      expect(marks).toBe(2);
    } finally {
      fault.mockRestore();
      await first.dispose();
    }

    const restarted = createHistoryBackend({ handlers: rec.handlers, store: createIdbHistoryStore(dbName) });
    await restarted.sweep();
    expect(await restarted.list(groupId)).toEqual(entries);
    expect(rec.retracted).toEqual([]);

    await restarted.withdraw(groupId, ids);
    expect(await restarted.list(groupId)).toEqual([entries[2]]);
    expect(rec.retracted.map((row) => row.eventId)).toEqual(['e1', 'e2']);
    expect(rec.dispatched).toHaveLength(3);
  });

  it('an unknown-only withdrawal does not recover unrelated rows on first touch', async () => {
    const dbName = freshDb();
    const store = createIdbHistoryStore(dbName);
    const undispatched = { entry: entry('ab', 'e1'), seq: await store.nextSeq('ab'), dispatched: false };
    const marked = { entry: entry('ab', 'e2'), seq: await store.nextSeq('ab'), dispatched: true, withdrawing: true };
    await store.putRow(undispatched);
    await store.putRow(marked);
    const rec = recorder();
    const backend = createHistoryBackend({ handlers: rec.handlers, store });

    await backend.withdraw('ab', ['e0']);
    expect(await store.listRows('ab')).toEqual([undispatched, marked]);
    expect(rec.dispatched).toEqual([]);
    expect(rec.retracted).toEqual([]);

    await backend.sweep();
    expect(rec.retracted.map((r) => r.eventId)).toEqual(['e2']);
    expect(rec.dispatched.map((r) => r.eventId)).toEqual(['e1']);
    await backend.append(entry('ab', 'e0'));
    expect(rec.dispatched.map((r) => r.eventId)).toEqual(['e1', 'e0']);
  });

  it('corrupt and counter values are never listed or swept; clearAll empties the store', async () => {
    const dbName = freshDb();
    const store = createIdbHistoryStore(dbName);
    const raw = createStore(dbName, 'rows');
    const { set } = await import('idb-keyval');
    await store.putRow({ entry: entry('ab', 'ok'), seq: 1, dispatched: false });
    await set('ab:junk', { nonsense: 1 }, raw);
    await set('ab:alsojunk', 'text', raw);
    expect((await store.listRows('ab')).map((r) => r.entry.eventId)).toEqual(['ok']);
    expect((await store.listAllRows()).map((r) => r.entry.eventId)).toEqual(['ok']);
    await store.clearAll();
    expect(await keys(raw)).toEqual([]);
  });

  it('stores for different database names are isolated', async () => {
    const a = createIdbHistoryStore(freshDb());
    const b = createIdbHistoryStore(freshDb());
    await a.putRow({ entry: entry('ab', 'e1'), seq: 1, dispatched: true });
    expect(await b.getRow('ab', 'e1')).toBeUndefined();
  });
});

describe('per-group key-range reads (real IndexedDB)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('listRows reads only the group key range: rows of other groups (incl. prefix-sharing ids) are never fetched', async () => {
    const store = createIdbHistoryStore(freshDb());
    // 'g', 'g2', 'g-1', 'gg' all sort around the 'g:' range; the layout must keep them out of it
    for (const g of ['g', 'g2', 'g-1', 'gg', 'h']) {
      await store.putRow({ entry: entry(g, 'e1'), seq: 1, dispatched: true });
      await store.putRow({ entry: entry(g, 'e2'), seq: 2, dispatched: false });
    }
    const fetched: number[] = [];
    const ranges: IDBKeyRange[] = [];
    const getAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, query?: IDBValidKey | IDBKeyRange | null) {
      ranges.push(query as IDBKeyRange);
      const request = getAll.call(this, query);
      request.addEventListener('success', () => fetched.push((request.result as unknown[]).length));
      return request;
    });
    const rows = await store.listRows('g');
    expect(rows.map((r) => `${r.entry.groupId}:${r.entry.eventId}`)).toEqual(['g:e1', 'g:e2']);
    expect(fetched).toEqual([2]); // the idb read itself returned only this group's two rows
    expect(ranges).toHaveLength(1);
    expect([ranges[0].lower, ranges[0].upper]).toEqual(['g:', 'g:\uffff']);
  });

  it('purgeGroup deletes exactly the group range and its counter: neighbours by key order survive', async () => {
    const dbName = freshDb();
    const store = createIdbHistoryStore(dbName);
    const groups = ['g', 'g2', 'g-1', 'gg', 'h'];
    for (const g of groups) {
      expect(await store.nextSeq(g)).toBe(1);
      await store.putRow({ entry: entry(g, 'e1'), seq: 1, dispatched: true });
      await store.putRow({ entry: entry(g, 'zz'), seq: 2, dispatched: true });
    }
    const getAllKeys = IDBObjectStore.prototype.getAllKeys;
    const seen: unknown[][] = [];
    vi.spyOn(IDBObjectStore.prototype, 'getAllKeys').mockImplementation(function (this: IDBObjectStore, query?: IDBValidKey | IDBKeyRange | null) {
      const request = getAllKeys.call(this, query);
      request.addEventListener('success', () => seen.push(request.result));
      return request;
    });
    await store.purgeGroup('g');
    expect(seen).toEqual([['g:e1', 'g:zz']]); // range read, not a whole-store key scan
    expect((await keys<string>(createStore(dbName, 'rows'))).sort()).toEqual(
      ['#seq:g-1', '#seq:g2', '#seq:gg', '#seq:h', 'g-1:e1', 'g-1:zz', 'g2:e1', 'g2:zz', 'gg:e1', 'gg:zz', 'h:e1', 'h:zz'].sort(),
    );
    expect(await store.nextSeq('g')).toBe(1); // the counter went with the group
  });
});

describe('per-account databases (few-group-history:<pubkey>)', () => {
  const ALICE_PK = 'aa'.repeat(32);
  const BOB_PK = 'bb'.repeat(32);

  it('two accounts with the same groupId/eventId dispatch independently; clearing one leaves the other', async () => {
    const ra = recorder();
    const rb = recorder();
    const a = createHistoryBackend({ handlers: ra.handlers, accountPubkey: ALICE_PK });
    const b = createHistoryBackend({ handlers: rb.handlers, accountPubkey: BOB_PK });
    await a.append(entry('ab', 'e1'));
    await b.append(entry('ab', 'e1'));
    expect(ra.dispatched.map((d) => d.eventId)).toEqual(['e1']);
    expect(rb.dispatched.map((d) => d.eventId)).toEqual(['e1']);
    expect((await a.list('ab')).map((e) => e.eventId)).toEqual(['e1']);
    expect((await b.list('ab')).map((e) => e.eventId)).toEqual(['e1']);

    await a.dispose();
    await clearAllGroupHistory(ALICE_PK);
    const afterClear = createHistoryBackend({ handlers: recorder().handlers, accountPubkey: ALICE_PK });
    expect(await afterClear.list('ab')).toEqual([]);
    expect((await b.list('ab')).map((e) => e.eventId)).toEqual(['e1']); // the other account is untouched
    expect(await createIdbHistoryStore(historyDbName(BOB_PK)).nextSeq('ab')).toBe(2);
  });

  it('the data lives in a database named few-group-history:<pubkey>', async () => {
    const pk = 'cc'.repeat(32);
    await createHistoryBackend({ handlers: recorder().handlers, accountPubkey: pk }).append(entry('ab', 'e1'));
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain(`few-group-history:${pk}`);
    expect(names).not.toContain('few-group-history');
  });

  it('clearAllGroupHistory validates the pubkey', () => {
    expect(() => clearAllGroupHistory('not-a-pubkey')).toThrow(/pubkey/);
  });
});
