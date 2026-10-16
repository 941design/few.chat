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

vi.mock('idb-keyval', async (importOriginal) => {
  const { callableMapStore } = await import('../helpers/callableMapStore');
  return {
  promisifyRequest: (await importOriginal<typeof import('idb-keyval')>()).promisifyRequest,
  createStore: vi.fn((db: string) => {
    // A Map for the mocked ops below, and a working store callback for
    // putRumor / recordRumorFailure (one readwrite transaction each).
    const m = callableMapStore(new Map<string, unknown>());
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
};
});

const journal = await import('@/src/lib/marmot/rumorJournal');
const {
  putRumor,
  ackRumor,
  listPendingRumors,
  sweepRumorJournal,
  clearRumorJournalForGroup,
  clearAllRumorJournal,
  createApplicationMessageJournaler,
  getJournaledSenderLeafIdentity,
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
    expect('senderLeafIdentity' in entry).toBe(false);
  });

  it('journals the sender leaf identity it is handed (bug: journal-replayed-leave-evicts-rejoined-member)', async () => {
    const cb = createApplicationMessageJournaler('g7');
    await cb({ rumor: { id: 'rid2' } as never, data: bytes('w'), senderPubkey: SENDER, senderLeafIdentity: '01:02' });
    expect(await getJournaledSenderLeafIdentity('g7', 'rid2')).toEqual({ journaled: true, identity: '01:02' });
    expect((await listPendingRumors('g7'))[0].senderLeafIdentity).toBe('01:02');
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

describe('sender leaf identity (bug: journal-replayed-leave-evicts-rejoined-member)', () => {
  it('getJournaledSenderLeafIdentity: whether a row exists, and its identity; no identity without the field or when malformed', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a'), senderLeafIdentity: 'id-a' });
    await putRumor({ groupId: 'g1', rumorId: 'b', senderPubkey: SENDER, data: bytes('b') });
    await putRumor({ groupId: 'g1', rumorId: 'c', senderPubkey: SENDER, data: bytes('c'), senderLeafIdentity: '' });
    store().set('g1:d', { groupId: 'g1', rumorId: 'd', senderPubkey: SENDER, data: bytes('d'), receivedAt: 1, senderLeafIdentity: 7 });
    store().set('g1:e', { groupId: 'g1', rumorId: 'e', senderPubkey: SENDER, data: bytes('e'), receivedAt: 1, senderLeafIdentity: '' });
    expect(await getJournaledSenderLeafIdentity('g1', 'a')).toEqual({ journaled: true, identity: 'id-a' });
    for (const id of ['b', 'c', 'd', 'e']) expect(await getJournaledSenderLeafIdentity('g1', id)).toEqual({ journaled: true });
    expect(await getJournaledSenderLeafIdentity('g1', 'zz')).toEqual({ journaled: false });
    expect('senderLeafIdentity' in (store().get('g1:b') as object)).toBe(false);
    expect('senderLeafIdentity' in (store().get('g1:c') as object)).toBe(false);
  });

  it('a re-journal (relay redelivery) without an identity keeps the stored identity and attempt count; a new identity wins', async () => {
    await putRumor({ groupId: 'g1', rumorId: 'r', senderPubkey: SENDER, data: bytes('r'), senderLeafIdentity: 'first' });
    store().set('g1:r', { ...(store().get('g1:r') as object), attempts: 2 });
    await putRumor({ groupId: 'g1', rumorId: 'r', senderPubkey: SENDER, data: bytes('r') });
    expect(store().get('g1:r')).toMatchObject({ senderLeafIdentity: 'first', attempts: 2 });
    await putRumor({ groupId: 'g1', rumorId: 'r', senderPubkey: SENDER, data: bytes('r'), senderLeafIdentity: 'second' });
    expect(store().get('g1:r')).toMatchObject({ senderLeafIdentity: 'second', attempts: 2 });
    // A malformed stored identity / count is not carried over.
    store().set('g1:m', { senderLeafIdentity: 9, attempts: 'x' });
    await putRumor({ groupId: 'g1', rumorId: 'm', senderPubkey: SENDER, data: bytes('m') });
    expect('senderLeafIdentity' in (store().get('g1:m') as object)).toBe(false);
    expect('attempts' in (store().get('g1:m') as object)).toBe(false);
  });

  it('failure injection: an unreadable entry rejects (the leave handler then throws and the entry is retried)', async () => {
    const { get } = await import('idb-keyval');
    vi.mocked(get).mockRejectedValueOnce(new Error('idb'));
    await expect(getJournaledSenderLeafIdentity('g1', 'a')).rejects.toThrow('idb');
  });
});

// Bug journal-ack-failure-replays-applied-rows: a failed ack (delete) of an
// entry whose handlers completed is remembered for the session: the entry is
// never handed to replay again, and its delete is retried. The set is module
// state, so every test here ends with the retried delete succeeding.
describe('failed acks are retried and never re-dispatched in the session', () => {
  it('failure injection: a failed ack rejects; the next listing does not return the applied entry and deletes it', async () => {
    const { del } = await import('idb-keyval');
    await putRumor({ groupId: 'g1', rumorId: 'applied', senderPubkey: SENDER, data: bytes('x') });
    await putRumor({ groupId: 'g1', rumorId: 'pending', senderPubkey: SENDER, data: bytes('y') });
    vi.mocked(del).mockRejectedValueOnce(new Error('idb busy'));
    await expect(ackRumor('g1', 'applied')).rejects.toThrow('idb busy');
    expect(store().has('g1:applied')).toBe(true);
    // Filtered BEFORE the retry deletes it (the read already held the row).
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['pending']);
    expect(store().has('g1:applied')).toBe(false);
    // Retried once only: later listings see the plain store.
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['pending']);
  });

  it('a later successful ack retries the failed one', async () => {
    const { del } = await import('idb-keyval');
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('1') });
    await putRumor({ groupId: 'g2', rumorId: 'r2', senderPubkey: SENDER, data: bytes('2') });
    vi.mocked(del).mockRejectedValueOnce(new Error('idb busy'));
    await expect(ackRumor('g1', 'r1')).rejects.toThrow();
    await ackRumor('g2', 'r2');
    expect(store().size).toBe(0);
  });

  it('failure injection: a failed retry is warned, the entry stays withheld from replay, and a later retry deletes it', async () => {
    const { del, delMany } = await import('idb-keyval');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('1') });
    vi.mocked(del).mockRejectedValueOnce(new Error('idb busy'));
    await expect(ackRumor('g1', 'r1')).rejects.toThrow();
    // listPending: expiry cleanup (nothing to drop) succeeds, the retry fails.
    vi.mocked(delMany).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('still busy'));
    expect(await listPendingRumors('g1')).toEqual([]);
    expect(store().has('g1:r1')).toBe(true);
    expect(warn).toHaveBeenCalledWith('[rumorJournal] ack retry failed:', expect.any(Error));
    expect(await listPendingRumors('g1')).toEqual([]);
    expect(store().has('g1:r1')).toBe(false);
    warn.mockRestore();
  });

  it('a re-delivered applied rumor acked again clears it from the retry set (no double delete needed)', async () => {
    const { del, delMany } = await import('idb-keyval');
    await putRumor({ groupId: 'g1', rumorId: 'r1', senderPubkey: SENDER, data: bytes('1') });
    vi.mocked(del).mockRejectedValueOnce(new Error('idb busy'));
    await expect(ackRumor('g1', 'r1')).rejects.toThrow();
    await ackRumor('g1', 'r1');
    vi.mocked(delMany).mockClear();
    await putRumor({ groupId: 'g1', rumorId: 'r2', senderPubkey: SENDER, data: bytes('2') });
    await ackRumor('g1', 'r2');
    expect(delMany).not.toHaveBeenCalled();
    expect(store().size).toBe(0);
  });
});

describe('remembered failed acks stay bounded (remediation round 1)', () => {
  const failAck = async (g: string, id: string) => {
    const { del } = await import('idb-keyval');
    await putRumor({ groupId: g, rumorId: id, senderPubkey: SENDER, data: bytes(id) });
    vi.mocked(del).mockRejectedValueOnce(new Error('idb busy'));
    await expect(ackRumor(g, id)).rejects.toThrow();
  };

  it('a remembered key whose row expired is forgotten (a later re-journal of it is listed again)', async () => {
    const { delMany } = await import('idb-keyval');
    await failAck('g1', 'old');
    store().set('g1:old', { ...(store().get('g1:old') as object), receivedAt: 0 });
    // Expiry delete succeeds, nothing left to retry.
    await listPendingRumors('g1', { now: RUMOR_JOURNAL_MAX_AGE_MS + 1 });
    expect(store().has('g1:old')).toBe(false);
    vi.mocked(delMany).mockClear();
    await putRumor({ groupId: 'g1', rumorId: 'old', senderPubkey: SENDER, data: bytes('x') });
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['old']);
    await clearAllRumorJournal();
  });

  it('sweep forgets expired remembered keys too', async () => {
    await failAck('g1', 's');
    store().set('g1:s', { ...(store().get('g1:s') as object), receivedAt: 0 });
    await sweepRumorJournal({ now: RUMOR_JOURNAL_MAX_AGE_MS + 1 });
    await putRumor({ groupId: 'g1', rumorId: 's', senderPubkey: SENDER, data: bytes('x') });
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['s']);
    await clearAllRumorJournal();
  });

  it('clearing a group forgets only its remembered keys; clearing all forgets every one', async () => {
    await failAck('g1', 'a');
    await failAck('g2', 'b');
    await clearRumorJournalForGroup('g1');
    await putRumor({ groupId: 'g1', rumorId: 'a', senderPubkey: SENDER, data: bytes('a') });
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['a']);
    // g2:b is still remembered: its retry (in the listing above) deleted it.
    expect(store().has('g2:b')).toBe(false);
    await failAck('g2', 'c');
    await clearAllRumorJournal();
    await putRumor({ groupId: 'g2', rumorId: 'c', senderPubkey: SENDER, data: bytes('c') });
    expect((await listPendingRumors('g2')).map((e) => e.rumorId)).toEqual(['c']);
    await clearAllRumorJournal();
  });

  it('the set is capped: past APPLIED_UNACKED_CAP the oldest remembered key is forgotten', async () => {
    const { delMany } = await import('idb-keyval');
    const { APPLIED_UNACKED_CAP } = journal;
    for (let i = 0; i <= APPLIED_UNACKED_CAP; i++) await failAck('g1', `k${i}`);
    // Make every retry fail so membership is observable through listing.
    vi.mocked(delMany).mockImplementation(async (ks: IDBValidKey[], s?: unknown) => {
      if (ks.length > 0 && String(ks[0]).startsWith('g1:k')) throw new Error('busy');
      ks.forEach((k) => backing(s as Map<string, unknown>).delete(String(k)));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listed = (await listPendingRumors('g1')).map((e) => e.rumorId);
    warn.mockRestore();
    expect(listed).toEqual(['k0']);
    vi.mocked(delMany).mockImplementation(async (ks: IDBValidKey[], s?: unknown) => { ks.forEach((k) => backing(s as Map<string, unknown>).delete(String(k))); });
    await clearAllRumorJournal();
  });
});
