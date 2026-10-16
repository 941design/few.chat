/**
 * rumorJournal under real IndexedDB semantics (finding rumor-journal-real-idb-suite).
 *
 * rumorJournal.test.ts runs on a Map mock, which cannot run the store-callback
 * transactions (putRumor, recordRumorFailure) or show abort semantics. This
 * suite runs the real module on fake-indexeddb through the real idb-keyval.
 * The module's store handle is a pass-through wrapper, so every storage step
 * can be failure-injected:
 *   - faults.next = 'reject'      : the next transaction fails before it starts
 *   - faults.next = 'abort'       : it aborts after the callback issued its
 *                                   requests (a get that never succeeds)
 *   - faults.next = 'put-throws'  : os.put throws synchronously (DataCloneError)
 * and idb-keyval's get/del/delMany/entries/keys are pass-through spies for
 * one-shot rejections (incl. commit-then-reject: indeterminate, not rejection).
 * Stored state, read through an unwrapped connection, is the truth asserted.
 * putRumor's own failure paths are covered in rumorJournal.putRumor.test.ts.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type UseStore = import('idb-keyval').UseStore;
type Fault = null | 'reject' | 'abort' | 'put-throws';
const { faults, txLog, raw } = vi.hoisted(() => ({
  faults: { next: null as Fault },
  txLog: [] as IDBTransactionMode[],
  raw: { store: null as null | UseStore },
}));

vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    createStore: vi.fn((db: string, name: string) => {
      const inner = real.createStore(db, name);
      raw.store = inner;
      const wrapped: UseStore = (mode, callback) => {
        txLog.push(mode);
        const fault = faults.next;
        faults.next = null;
        if (fault === 'reject') return Promise.reject(new Error('idb down'));
        if (fault === 'abort') {
          return inner(mode, (os) => {
            const result = callback(os);
            os.transaction.abort();
            return result;
          });
        }
        if (fault === 'put-throws') {
          return inner(mode, (os) => {
            const proxy = new Proxy(os, {
              get(target, prop) {
                if (prop === 'put') {
                  return () => {
                    throw new DOMException('could not be cloned', 'DataCloneError');
                  };
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
              },
            });
            return callback(proxy);
          });
        }
        return inner(mode, callback);
      };
      return wrapped;
    }),
    get: vi.fn(real.get),
    del: vi.fn(real.del),
    delMany: vi.fn(real.delMany),
    entries: vi.fn(real.entries),
    keys: vi.fn(real.keys),
  };
});

const idb = await import('idb-keyval');
const real = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
const journal = await import('@/src/lib/marmot/rumorJournal');
const {
  putRumor,
  recordRumorFailure,
  getJournaledSenderLeafIdentity,
  ackRumor,
  listPendingRumors,
  sweepRumorJournal,
  clearRumorJournalForGroup,
  clearAllRumorJournal,
  RUMOR_JOURNAL_MAX_AGE_MS,
} = journal;

// Opening the store lazily happens at module import (createStore is eager).
const store = (): UseStore => raw.store!;
const SENDER = 'cd'.repeat(32);

async function rawRows(): Promise<Map<string, unknown>> {
  return new Map((await real.entries(store())) as Array<[string, unknown]>);
}
async function rawRow(key: string): Promise<unknown> {
  return real.get(key, store());
}
function put(groupId: string, rumorId: string, senderLeafIdentity?: string): Promise<void> {
  return putRumor({ groupId, rumorId, senderPubkey: SENDER, data: new Uint8Array([1, 2]), ...(senderLeafIdentity ? { senderLeafIdentity } : {}) });
}

/** Resolves to 'pending' unless `p` settled within a few macrotasks. */
async function settledWithin(p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    p.then(() => 'resolved' as const, () => 'rejected' as const),
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100)),
  ]);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  faults.next = null;
  await clearAllRumorJournal(); // also resets the session's remembered failed acks
  txLog.length = 0;
  vi.mocked(idb.get).mockClear();
  vi.mocked(idb.del).mockClear();
  vi.mocked(idb.delMany).mockClear();
  vi.mocked(idb.entries).mockClear();
  vi.mocked(idb.keys).mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('recordRumorFailure (one readwrite transaction)', () => {
  it('counts 1, 2, 3 on the stored row, keeping every other field', async () => {
    await put('g1', 'r1', 'leaf');
    const before = (await rawRow('g1:r1')) as Record<string, unknown>;
    expect(await recordRumorFailure('g1', 'r1')).toBe(1);
    expect(await recordRumorFailure('g1', 'r1')).toBe(2);
    expect(await recordRumorFailure('g1', 'r1')).toBe(3);
    expect(await rawRow('g1:r1')).toEqual({ ...before, attempts: 3 });
    expect(txLog.filter((m) => m === 'readwrite').length).toBe(4);
  });

  it.each([
    ['no row', undefined],
    ['a malformed row', { groupId: 'g1', rumorId: 'r1' }],
  ])('%s → 0 and nothing written', async (_label, row) => {
    if (row) await real.set('g1:r1', row, store());
    expect(await recordRumorFailure('g1', 'r1')).toBe(0);
    expect(await rawRows()).toEqual(row ? new Map([['g1:r1', row]]) : new Map());
  });

  it.each(['reject', 'abort', 'put-throws'] as const)('fault %s → settles, rejects, row unchanged', async (fault) => {
    await put('g1', 'r1');
    await recordRumorFailure('g1', 'r1');
    const before = await rawRow('g1:r1');
    faults.next = fault;
    const p = recordRumorFailure('g1', 'r1');
    expect(await settledWithin(p)).toBe('rejected');
    expect(await rawRow('g1:r1')).toEqual(before);
    // The next attempt counts from the stored value: a failed count is not counted.
    expect(await recordRumorFailure('g1', 'r1')).toBe(2);
  });

  it('a re-put keeps the attempt count; a concurrent put and count both land', async () => {
    await put('g1', 'r1');
    expect(await recordRumorFailure('g1', 'r1')).toBe(1);
    await put('g1', 'r1');
    expect(await rawRow('g1:r1')).toMatchObject({ attempts: 1 });
    // Same store, readwrite transactions on one key are serialized: neither is lost.
    const [, n] = await Promise.all([put('g1', 'r1', 'late-identity'), recordRumorFailure('g1', 'r1')]);
    expect(n).toBe(2);
    expect(await rawRow('g1:r1')).toMatchObject({ attempts: 2, senderLeafIdentity: 'late-identity' });
  });
});

describe('getJournaledSenderLeafIdentity', () => {
  it('a failed read rejects (never reported as "not journaled")', async () => {
    await put('g1', 'r1', 'leaf');
    vi.mocked(idb.get).mockRejectedValueOnce(new Error('read failed'));
    await expect(getJournaledSenderLeafIdentity('g1', 'r1')).rejects.toThrow('read failed');
    expect(await getJournaledSenderLeafIdentity('g1', 'r1')).toEqual({ journaled: true, identity: 'leaf' });
  });
});

describe('ackRumor', () => {
  it('deletes the row', async () => {
    await put('g1', 'r1');
    await ackRumor('g1', 'r1');
    expect(await rawRows()).toEqual(new Map());
  });

  it('a failed delete rejects, the row stays stored but is hidden from listing as applied; the next ack retries it', async () => {
    await put('g1', 'r1');
    await put('g1', 'r2');
    vi.mocked(idb.del).mockRejectedValueOnce(new Error('del failed'));
    await expect(ackRumor('g1', 'r1')).rejects.toThrow('del failed');
    expect((await rawRows()).has('g1:r1')).toBe(true);
    // listPendingRumors retries the remembered delete; make that retry fail too
    // so the stored row is visible and still not handed to replay.
    vi.mocked(idb.delMany).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('retry failed'));
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['r2']);
    expect((await rawRows()).has('g1:r1')).toBe(true);
    expect(warn).toHaveBeenCalledWith('[rumorJournal] ack retry failed:', expect.any(Error));
    // The next successful ack retries the remembered one.
    await ackRumor('g1', 'r2');
    expect(await rawRows()).toEqual(new Map());
  });

  it('indeterminate delete (committed, then rejected): the row is gone; the retry of a missing key is harmless', async () => {
    await put('g1', 'r1');
    await put('g1', 'r2');
    vi.mocked(idb.del).mockImplementationOnce(async (k, s) => {
      await real.del(k, s);
      throw new Error('reported failed');
    });
    await expect(ackRumor('g1', 'r1')).rejects.toThrow('reported failed');
    expect((await rawRows()).has('g1:r1')).toBe(false);
    await ackRumor('g1', 'r2');
    expect(await rawRows()).toEqual(new Map());
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed retry after a successful ack only warns (the ack still resolves)', async () => {
    await put('g1', 'r1');
    await put('g1', 'r2');
    vi.mocked(idb.del).mockRejectedValueOnce(new Error('del failed'));
    await expect(ackRumor('g1', 'r1')).rejects.toThrow();
    vi.mocked(idb.delMany).mockRejectedValueOnce(new Error('retry failed'));
    await expect(ackRumor('g1', 'r2')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[rumorJournal] ack retry failed:', expect.any(Error));
    expect([...(await rawRows()).keys()]).toEqual(['g1:r1']);
    // Still remembered: a later listing retries it.
    expect(await listPendingRumors('g1')).toEqual([]);
    expect(await rawRows()).toEqual(new Map());
  });
});

describe('listPendingRumors', () => {
  it('returns the group\'s rows oldest first (receipt order, not key order) and drops+deletes expired and malformed rows store-wide', async () => {
    await put('g1', 'zz');
    await put('g1', 'aa');
    await put('g2', 'b1');
    await real.set('g1:bad', { nope: true }, store());
    const t0 = ((await rawRow('g1:zz')) as { receivedAt: number }).receivedAt;
    await real.set('g2:old', { groupId: 'g2', rumorId: 'old', senderPubkey: SENDER, data: new Uint8Array([1]), receivedAt: t0 - RUMOR_JOURNAL_MAX_AGE_MS }, store());
    expect((await listPendingRumors('g1', { now: t0 })).map((e) => e.rumorId)).toEqual(['zz', 'aa']);
    expect([...(await rawRows()).keys()].sort()).toEqual(['g1:aa', 'g1:zz', 'g2:b1']);
  });

  it('a failed cleanup still returns the pending rows (warned); the dropped rows stay stored', async () => {
    await put('g1', 'r1');
    await real.set('g1:bad', 42, store());
    vi.mocked(idb.delMany).mockRejectedValueOnce(new Error('cleanup failed'));
    expect((await listPendingRumors('g1')).map((e) => e.rumorId)).toEqual(['r1']);
    expect(warn).toHaveBeenCalledWith('[rumorJournal] expiry cleanup failed:', expect.any(Error));
    expect((await rawRows()).has('g1:bad')).toBe(true);
  });

  it('a failed read rejects (never an empty replay)', async () => {
    await put('g1', 'r1');
    vi.mocked(idb.entries).mockRejectedValueOnce(new Error('read failed'));
    await expect(listPendingRumors('g1')).rejects.toThrow('read failed');
    expect((await rawRows()).has('g1:r1')).toBe(true);
  });
});

describe('sweepRumorJournal', () => {
  it('counts and deletes expired and malformed rows across groups, keeps the rest', async () => {
    await put('g1', 'live');
    const now = ((await rawRow('g1:live')) as { receivedAt: number }).receivedAt;
    await real.set('g2:old', { groupId: 'g2', rumorId: 'old', senderPubkey: SENDER, data: new Uint8Array([1]), receivedAt: now - RUMOR_JOURNAL_MAX_AGE_MS }, store());
    await real.set('g3:bad', 'x', store());
    expect(await sweepRumorJournal({ now })).toBe(2);
    expect([...(await rawRows()).keys()]).toEqual(['g1:live']);
  });

  it.each(['entries', 'delMany'] as const)('a failed %s rejects; the rows survive', async (step) => {
    await real.set('g3:bad', 'x', store());
    vi.mocked(idb[step]).mockRejectedValueOnce(new Error(`${step} failed`));
    await expect(sweepRumorJournal()).rejects.toThrow(`${step} failed`);
    expect((await rawRows()).has('g3:bad')).toBe(true);
  });
});

describe('clearRumorJournalForGroup', () => {
  it('deletes exactly that group\'s rows (prefix "G1:" never matches "G10:")', async () => {
    await put('G1', 'a');
    await put('G1', 'b');
    await put('G10', 'c');
    await put('G2', 'd');
    await clearRumorJournalForGroup('G1');
    expect([...(await rawRows()).keys()].sort()).toEqual(['G10:c', 'G2:d']);
  });

  it.each(['keys', 'delMany'] as const)('a failed %s rejects and the rows survive', async (step) => {
    await put('G1', 'a');
    vi.mocked(idb[step]).mockRejectedValueOnce(new Error(`${step} failed`));
    await expect(clearRumorJournalForGroup('G1')).rejects.toThrow(`${step} failed`);
    expect((await rawRows()).has('G1:a')).toBe(true);
  });

  it('forgets the group\'s remembered failed acks (no retry of a cleared group\'s keys)', async () => {
    await put('G1', 'a');
    await put('G2', 'b');
    vi.mocked(idb.del).mockRejectedValueOnce(new Error('del failed'));
    await expect(ackRumor('G1', 'a')).rejects.toThrow();
    await clearRumorJournalForGroup('G1');
    vi.mocked(idb.delMany).mockClear();
    await ackRumor('G2', 'b');
    expect(idb.delMany).not.toHaveBeenCalled();
  });
});
