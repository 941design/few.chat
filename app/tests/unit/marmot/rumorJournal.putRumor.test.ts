/**
 * putRumor always settles (remediation round 2): the read-merge-put runs in
 * one readwrite transaction through idb-keyval's store callback and returns
 * promisifyRequest(transaction) — never idb-keyval update(), which wires only
 * the get's onsuccess and leaves its promise pending on a get error or an
 * abort, which would freeze the group's ingest loop (EpochResolver awaits the
 * journal put).
 *
 * An event-driven, hand-rolled fake object store drives every failure path
 * (get error + transaction abort, abort before the get succeeds, a throwing
 * put, a throwing merge); the merge semantics run under a real transaction
 * (fake-indexeddb) at the end.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Scenario = 'ok' | 'reject' | 'get-error' | 'abort-before-get' | 'put-throws';
const { ctl } = vi.hoisted(() => ({
  ctl: {
    fake: false,
    scenario: 'ok' as Scenario,
    stored: new Map<string, unknown>(),
    aborted: 0,
    puts: 0,
  },
}));

vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    createStore: vi.fn((db: string, name: string) => {
      const realStore = real.createStore(db, name);
      // The module's store handle: the real fake-indexeddb store, or (ctl.fake)
      // an event-driven fake transaction over ctl.stored.
      return ((mode: IDBTransactionMode, callback: (os: IDBObjectStore) => unknown) => {
        if (!ctl.fake) return realStore(mode, callback as never);
        if (ctl.scenario === 'reject') return Promise.reject(new Error('QuotaExceeded'));
        const writes: Array<[string, unknown]> = [];
        let finished = false;
        const fire = (fn: (() => void) | null | undefined) => setTimeout(() => fn?.(), 0);
        const txn = {
          error: null as unknown,
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          onerror: null as (() => void) | null,
          abort() {
            ctl.aborted++;
            if (finished) return;
            finished = true;
            txn.error = new DOMException('aborted', 'AbortError');
            fire(() => txn.onabort?.());
          },
        };
        const getReq = { result: undefined as unknown, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        const os = {
          transaction: txn,
          get: (key: string) => {
            setTimeout(() => {
              if (finished) return;
              if (ctl.scenario === 'get-error') {
                getReq.error = new DOMException('read failed', 'UnknownError');
                getReq.onerror?.();
                // An unhandled request error aborts the transaction.
                finished = true;
                txn.error = getReq.error;
                fire(() => txn.onerror?.());
                return;
              }
              if (ctl.scenario === 'abort-before-get') {
                txn.abort();
                return;
              }
              getReq.result = ctl.stored.get(key);
              getReq.onsuccess?.();
              if (!finished) {
                finished = true;
                for (const [k, v] of writes) ctl.stored.set(k, v);
                fire(() => txn.oncomplete?.());
              }
            }, 0);
            return getReq;
          },
          put: (value: unknown, key: string) => {
            ctl.puts++;
            if (ctl.scenario === 'put-throws') throw new DOMException('could not be cloned', 'DataCloneError');
            writes.push([key, value]);
            return {};
          },
        };
        return Promise.resolve(callback(os as unknown as IDBObjectStore));
      }) as never;
    }),
  };
});

const { putRumor, getJournaledSenderLeafIdentity, recordRumorFailure, clearAllRumorJournal } = await import('@/src/lib/marmot/rumorJournal');

const SENDER = 'cd'.repeat(32);
const entry = (id: string, senderLeafIdentity?: string) => ({
  groupId: 'g1', rumorId: id, senderPubkey: SENDER, data: new Uint8Array([1]), ...(senderLeafIdentity ? { senderLeafIdentity } : {}),
});

/** Resolves to 'pending' unless `p` settled within a few macrotasks. */
async function settledWithin(p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    p.then(() => 'resolved' as const, () => 'rejected' as const),
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
  ]);
}

beforeEach(async () => {
  ctl.fake = false;
  await clearAllRumorJournal();
  ctl.fake = true;
  ctl.scenario = 'ok';
  ctl.stored.clear();
  ctl.aborted = 0;
  ctl.puts = 0;
});

describe('putRumor always settles (hand-rolled event-driven store)', () => {
  it('baseline: a normal read-merge-put resolves and stores the row', async () => {
    expect(await settledWithin(putRumor(entry('r1', 'id')))).toBe('resolved');
    expect(ctl.stored.get('g1:r1')).toMatchObject({ rumorId: 'r1', senderLeafIdentity: 'id' });
  });

  it('(a) the get errors and the transaction aborts → it SETTLES and rejects', async () => {
    ctl.scenario = 'get-error';
    const p = putRumor(entry('r1'));
    expect(await settledWithin(p)).toBe('rejected');
    await expect(p).rejects.toBeDefined();
    expect(ctl.stored.size).toBe(0);
  });

  it('(b) the transaction aborts before the get succeeds → rejects', async () => {
    ctl.scenario = 'abort-before-get';
    const p = putRumor(entry('r1'));
    expect(await settledWithin(p)).toBe('rejected');
    expect(ctl.stored.size).toBe(0);
  });

  it('(c) os.put throws synchronously → rejects, the transaction was aborted, the store is unchanged', async () => {
    ctl.stored.set('g1:r1', { groupId: 'g1', rumorId: 'r1', senderLeafIdentity: 'keep', attempts: 2 });
    ctl.scenario = 'put-throws';
    const p = putRumor(entry('r1'));
    expect(await settledWithin(p)).toBe('rejected');
    expect(ctl.puts).toBe(1);
    expect(ctl.aborted).toBe(1);
    expect(ctl.stored.get('g1:r1')).toEqual({ groupId: 'g1', rumorId: 'r1', senderLeafIdentity: 'keep', attempts: 2 });
  });

  it('(d) the merge throws (an unreadable stored row) → rejects, aborted, nothing put, the store is unchanged', async () => {
    const hostile = { get senderLeafIdentity(): string { throw new Error('bad row'); } };
    ctl.stored.set('g1:r1', hostile);
    const p = putRumor(entry('r1'));
    expect(await settledWithin(p)).toBe('rejected');
    expect(ctl.puts).toBe(0);
    expect(ctl.aborted).toBe(1);
    expect(ctl.stored.get('g1:r1')).toBe(hostile);
  });

  it('failure injection (ported from the update() test): a transaction that fails before it starts rejects and stores nothing', async () => {
    ctl.scenario = 'reject';
    const p = putRumor(entry('q'));
    expect(await settledWithin(p)).toBe('rejected');
    await expect(p).rejects.toThrow('QuotaExceeded');
    expect(ctl.stored.has('g1:q')).toBe(false);
  });
});

describe('putRumor merge under a real transaction (fake-indexeddb)', () => {
  beforeEach(() => { ctl.fake = false; });

  it('an existing identity and attempt count survive a re-put without an identity; a put with an identity wins', async () => {
    await putRumor(entry('m1', 'first'));
    expect(await recordRumorFailure('g1', 'm1')).toBe(1);
    await putRumor(entry('m1'));
    expect(await getJournaledSenderLeafIdentity('g1', 'm1')).toEqual({ journaled: true, identity: 'first' });
    expect(await recordRumorFailure('g1', 'm1')).toBe(2);
    await putRumor(entry('m1', 'second'));
    expect(await getJournaledSenderLeafIdentity('g1', 'm1')).toEqual({ journaled: true, identity: 'second' });
    expect(await recordRumorFailure('g1', 'm1')).toBe(3);
  });
});
