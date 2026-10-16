/**
 * rumorJournal.ts — write-ahead journal for decrypted MLS application rumors
 * (bug: mls-message-lost-on-unload-after-ingest, VQ-2/VQ-4).
 *
 * Per-store Map-backed idb-keyval mock (same pattern as
 * groupStorage.clearAllGroupData.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stores, defaultStore, setLog } = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  defaultStore: new Map<string, unknown>(),
  setLog: [] as string[],
}));
const backing = (s?: Map<string, unknown>) => s ?? defaultStore;

vi.mock('idb-keyval', () => ({
  createStore: vi.fn((db: string) => {
    const m = new Map<string, unknown>();
    stores.set(db, m);
    return m;
  }),
  get: vi.fn(async (k: string, s?: Map<string, unknown>) => backing(s).get(k)),
  set: vi.fn(async (k: string, v: unknown, s?: Map<string, unknown>) => { setLog.push(k); backing(s).set(k, v); }),
  del: vi.fn(async (k: string, s?: Map<string, unknown>) => { backing(s).delete(k); }),
  delMany: vi.fn(async (ks: string[], s?: Map<string, unknown>) => { ks.forEach((k) => backing(s).delete(k)); }),
  keys: vi.fn(async (s?: Map<string, unknown>) => [...backing(s).keys()]),
  entries: vi.fn(async (s?: Map<string, unknown>) => [...backing(s).entries()]),
  clear: vi.fn(async (s?: Map<string, unknown>) => { backing(s).clear(); }),
}));

const journal = await import('@/src/lib/marmot/rumorJournal');
const {
  putRumor,
  ackRumor,
  listPendingRumors,
  sweepRumorJournal,
  clearRumorJournalForGroup,
  clearAllRumorJournal,
  createApplicationMessageJournaler,
  RUMOR_JOURNAL_DB_NAME,
  RUMOR_JOURNAL_MAX_AGE_MS,
} = journal;

const store = () => stores.get(RUMOR_JOURNAL_DB_NAME)!;
const SENDER = 'cd'.repeat(32);
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  store().clear();
  defaultStore.clear();
  setLog.length = 0;
});

describe('rumorJournal store', () => {
  it('uses its own few-rumor-journal database (never the MLS state or backup stores)', async () => {
    expect(RUMOR_JOURNAL_DB_NAME).toBe('few-rumor-journal');
    expect(store()).toBeInstanceOf(Map);
    const { createStore } = await import('idb-keyval');
    expect(createStore).toHaveBeenCalledWith('few-rumor-journal', 'rumors');
  });

  it('put → listPending returns the entry with its exact bytes and sender; key is groupId:rumorId', async () => {
    const data = bytes('payload-1');
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data });
    expect([...store().keys()]).toEqual(['g1:r1']);
    const pending = await listPendingRumors('g1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER });
    expect(pending[0].data).toEqual(data);
    expect(typeof pending[0].receivedAt).toBe('number');
  });

  it('put is idempotent per (groupId, rumorId)', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('a') });
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('a') });
    expect(await listPendingRumors('g1')).toHaveLength(1);
  });

  it('ack deletes exactly the acknowledged entry; acking an unknown id is a no-op', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('a') });
    await putRumor({ groupId: 'g1', rumorId: 'r2', senderPubkey: SENDER, data: bytes('b') });
    await ackRumor('g1', 'r1');
    await ackRumor('g1', 'nope');
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['r2']);
  });

  it('listPending is scoped to one group (prefix collisions included) and FIFO by receivedAt', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'b', senderPubkey: SENDER, data: bytes('1') });
    await putRumor({ groupId: 'g10', rumorId: 'x', senderPubkey: SENDER, data: bytes('2') });
    await putRumor({ groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('3') });
    await putRumor({ groupId: 'g1', rumorId: 'c', senderPubkey: SENDER, data: bytes('4') });
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['b', 'a', 'c']);
    expect((await listPendingRumors('g10')).map((e) => e.rumorId)).toEqual(['x']);
  });

  it('receivedAt is strictly increasing even within the same millisecond', async () => {
    // Far ahead of any stamp an earlier test produced, so the first put takes
    // the clock value and the next two hit the same-millisecond branch.
    const frozen = Date.now() + 1_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    try {
      for (const id of ['p', 'q', 'r']) {
        await putRumor({ groupId: 'g1', rumorId: id, senderPubkey: SENDER, data: bytes(id) });
      }
      const ts = (await listPendingRumors('g1', { now: frozen })).map((e) => e.receivedAt);
      expect(ts).toEqual([frozen, frozen + 1, frozen + 2]);
    } finally {
      now.mockRestore();
    }
  });

  it('listPending drops (and deletes) entries older than the max age', async () => {
    store().set('g1:old', { groupId: 'g1', rumorId: 'old', senderPubkey: SENDER, data: bytes('o'), receivedAt: 1000 });
    store().set('g1:edge', { groupId: 'g1', rumorId: 'edge', senderPubkey: SENDER, data: bytes('e'), receivedAt: 1000 + 1 });
    const now = 1000 + RUMOR_JOURNAL_MAX_AGE_MS;
    const pending = await listPendingRumors('g1', { now });
    expect(pending.map((e) => e.rumorId)).toEqual(['edge']);
    expect(store().has('g1:old')).toBe(false);
  });

  it.each([
    ['null', null],
    ['groupId', { rumorId: 'x', senderPubkey: SENDER, data: bytes('d'), receivedAt: Date.now() }],
    ['rumorId', { groupId: 'g1', senderPubkey: SENDER, data: bytes('d'), receivedAt: Date.now() }],
    ['senderPubkey', { groupId: 'g1', rumorId: 'x', data: bytes('d'), receivedAt: Date.now() }],
    ['data', { groupId: 'g1', rumorId: 'x', senderPubkey: SENDER, data: [1, 2], receivedAt: Date.now() }],
    ['receivedAt', { groupId: 'g1', rumorId: 'x', senderPubkey: SENDER, data: bytes('d'), receivedAt: undefined }],
  ])('listPending ignores and deletes a malformed row (bad %s)', async (_field, row) => {
    store().set('g1:bad', row);
    expect(await listPendingRumors('g1')).toEqual([]);
    expect(store().size).toBe(0);
  });

  it('listPending orders by receivedAt, not by store (key) order', async () => {
    const now = Date.now();
    store().set('g1:a', { groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a'), receivedAt: now - 10 });
    store().set('g1:b', { groupId: 'g1', rumorId: 'b', senderPubkey: SENDER, data: bytes('b'), receivedAt: now - 30 });
    store().set('g1:c', { groupId: 'g1', rumorId: 'c', senderPubkey: SENDER, data: bytes('c'), receivedAt: now - 20 });
    expect((await listPendingRumors('g1', { now })).map((e) => e.rumorId)).toEqual(['b', 'c', 'a']);
  });

  it('sweep evicts by age only — 1500 never-applied entries of one group survive and all replay, oldest first (bug: rumor-journal-cap-evicts-unapplied)', async () => {
    const now = 10_000_000_000;
    const N = 1500;
    // Inserted newest-first so key/insertion order disagrees with age.
    for (let i = N - 1; i >= 0; i--) {
      store().set(`g1:r${i}`, { groupId: 'g1', rumorId: `r${i}`, senderPubkey: SENDER, data: bytes('x'), receivedAt: now - 10_000 + i });
    }
    store().set('g2:keep', { groupId: 'g2', rumorId: 'keep', senderPubkey: SENDER, data: bytes('k'), receivedAt: now - 5 });
    store().set('g2:stale', { groupId: 'g2', rumorId: 'stale', senderPubkey: SENDER, data: bytes('s'), receivedAt: now - RUMOR_JOURNAL_MAX_AGE_MS });
    store().set('g2:edge', { groupId: 'g2', rumorId: 'edge', senderPubkey: SENDER, data: bytes('e'), receivedAt: now - RUMOR_JOURNAL_MAX_AGE_MS + 1 });
    const removed = await sweepRumorJournal({ now });
    expect(removed).toBe(1);
    expect(store().has('g2:stale')).toBe(false);
    expect(store().has('g2:edge')).toBe(true);
    const g1 = await listPendingRumors('g1', { now });
    expect(g1).toHaveLength(N);
    expect(g1.map((e) => e.rumorId)).toEqual(Array.from({ length: N }, (_, i) => `r${i}`));
    expect(store().size).toBe(N + 2);
  });

  it('bounds are sane: age is days not minutes, and no count cap exists', () => {
    expect(RUMOR_JOURNAL_MAX_AGE_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(RUMOR_JOURNAL_MAX_AGE_MS).toBeLessThanOrEqual(90 * 24 * 60 * 60 * 1000);
    expect('RUMOR_JOURNAL_MAX_PER_GROUP' in journal).toBe(false);
  });

  it('failure injection: a failed expiry cleanup still returns every pending entry, and nothing is lost from the store', async () => {
    const now = 10_000_000_000;
    store().set('g1:old', { groupId: 'g1', rumorId: 'old', senderPubkey: SENDER, data: bytes('o'), receivedAt: now - RUMOR_JOURNAL_MAX_AGE_MS });
    store().set('g1:a', { groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a'), receivedAt: now - 1 });
    const idb = await import('idb-keyval');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(idb.delMany).mockRejectedValueOnce(new Error('QuotaExceeded'));
    const pending = await listPendingRumors('g1', { now });
    expect(pending.map((e) => e.rumorId)).toEqual(['a']);
    expect(store().has('g1:a')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expiry cleanup failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('failure injection: a failed journal read rejects (caller logs) and deletes nothing', async () => {
    store().set('g1:a', { groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a'), receivedAt: Date.now() });
    const idb = await import('idb-keyval');
    vi.mocked(idb.entries).mockRejectedValueOnce(new Error('read failed'));
    await expect(listPendingRumors('g1')).rejects.toThrow('read failed');
    expect(store().has('g1:a')).toBe(true);
  });

  it('clearRumorJournalForGroup removes only that group; clearAll removes everything', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a') });
    await putRumor({ groupId: 'g10', rumorId: 'b', senderPubkey: SENDER, data: bytes('b') });
    await putRumor({ groupId: 'g2', rumorId: 'c', senderPubkey: SENDER, data: bytes('c') });
    await clearRumorJournalForGroup('g1');
    expect([...store().keys()].sort()).toEqual(['g10:b', 'g2:c']);
    await clearAllRumorJournal();
    expect(store().size).toBe(0);
  });
});

describe('createApplicationMessageJournaler (EpochResolver.onApplicationMessage wiring)', () => {
  it('journals the delivered bytes under the group, keyed by the rumor id', async () => {
    const data = bytes('wire');
    const cb = createApplicationMessageJournaler('g7');
    await cb({ rumor: { id: 'rid', kind: 9, pubkey: SENDER, created_at: 1, content: '', tags: [] }, data, senderPubkey: SENDER });
    const [entry] = await listPendingRumors('g7');
    expect(entry).toMatchObject({ groupId: 'g7', rumorId: 'rid', senderPubkey: SENDER });
    expect(entry.data).toEqual(data);
  });

  it.each([
    ['empty id', { id: '' }],
    ['non-string id', { id: 42 }],
    ['missing id', {}],
    ['null rumor', null],
  ])('rejects (for the resolver to warn about) on %s', async (_l, rumor) => {
    const cb = createApplicationMessageJournaler('g7');
    await expect(cb({ rumor: rumor as never, data: bytes('x'), senderPubkey: SENDER })).rejects.toThrow(/rumor without id/);
    expect(store().size).toBe(0);
  });
});
