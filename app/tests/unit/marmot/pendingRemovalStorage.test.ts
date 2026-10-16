/**
 * pendingRemovalStorage.ts — durable debounced member-removal queue
 * (bug: pending-member-removals-not-persisted, VQ-2/VQ-4; remediation round 1:
 * stored removals are fail-safe toward NOT evicting — leaf identity, admin-only
 * resume, age bound, identity-less rows treated as malformed).
 *
 * Runs against a real IndexedDB surface (fake-indexeddb/auto) through the real
 * idb-keyval: the conditional delete is one readwrite transaction with an
 * in-transaction compare (bug: pending-removal-compare-delete-single-txn), so a
 * Map-backed mock could not show that another connection's write is never
 * deleted. idb-keyval's functions are wrapped pass-through spies, and the
 * module's store handle is a pass-through wrapper, so every storage step can
 * still be failure-injected. A second, independent connection (`tabB`) plays
 * another tab.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type UseStore = import('idb-keyval').UseStore;
const { created, handles, faults, txLog } = vi.hoisted(() => ({
  created: [] as string[][],
  handles: new Map<string, UseStore>(),
  // Mode of every transaction the module's own store handle opened.
  txLog: [] as IDBTransactionMode[],
  // One-shot fault for the module's next transaction of a given mode:
  // 'reject' fails it before it starts, 'abort' aborts it after the callback
  // issued its requests (an in-flight transaction failure).
  faults: { readwrite: null as null | 'reject' | 'abort' },
}));

vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    createStore: vi.fn((db: string, name: string) => {
      created.push([db, name]);
      const inner = real.createStore(db, name);
      const wrapped: UseStore = (mode, callback) => {
        txLog.push(mode);
        const fault = mode === 'readwrite' ? faults.readwrite : null;
        if (fault) faults.readwrite = null;
        if (fault === 'reject') return Promise.reject(new Error('idb down'));
        if (fault === 'abort') {
          return inner(mode, (os) => {
            const result = callback(os);
            os.transaction.abort();
            return result;
          });
        }
        return inner(mode, callback);
      };
      handles.set(db, wrapped);
      return wrapped;
    }),
    set: vi.fn(real.set),
    delMany: vi.fn(real.delMany),
    keys: vi.fn(real.keys),
    entries: vi.fn(real.entries),
    clear: vi.fn(real.clear),
  };
});

const idb = await import('idb-keyval');
const real = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
const {
  PENDING_REMOVALS_DB_NAME,
  putPendingRemoval,
  deleteMatchingPendingRemovals,
  listPendingRemovals,
  readPendingRemovalRows,
  clearPendingRemovalsForGroup,
  clearAllPendingRemovals,
  persistPendingRemoval,
  forgetPendingRemovals,
  resumePendingRemovals,
  addToRemovalQueue,
  recordPendingRemoval,
  settlePendingRemovals,
  leafIdentityOf,
  selfAdminStatus,
  recordLeaveIntent,
} = await import('@/src/lib/marmot/pendingRemovalStorage');
type Rec = import('@/src/lib/marmot/pendingRemovalStorage').PendingRemovalRecord;

// The store is created lazily on first use (module import must not touch IDB).
expect(handles.has(PENDING_REMOVALS_DB_NAME)).toBe(false);
await listPendingRemovals('init');

// Raw access through the module's own connection (unwrapped by faults only
// when a test arms one) and through an independent second connection.
const own = () => handles.get(PENDING_REMOVALS_DB_NAME)!;
const tabB = real.createStore(PENDING_REMOVALS_DB_NAME, 'removals');
const raw = {
  set: (k: string, v: unknown) => real.set(k, v, own()),
  keys: async () => (await real.keys<string>(own())).map(String).sort(),
  has: async (k: string) => (await real.get(k, own())) !== undefined,
  size: async () => (await real.keys(own())).length,
};

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const ID = 'leaf-id-1';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const NOW = 100 * DAY;
const rec = (groupId: string, pubkey: string, receivedAt: number, leafIdentity = ID): Rec => ({ groupId, pubkey, receivedAt, leafIdentity });
const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  faults.readwrite = null;
  await real.clear(own());
  txLog.length = 0;
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('leafIdentityOf', () => {
  const leaf = (sig: number[], hpke: number[]) => ({ signaturePublicKey: new Uint8Array(sig), hpkePublicKey: new Uint8Array(hpke) });

  it('is the hex signature:hpke key pair of every leaf, order-independent; undefined without leaves', () => {
    expect(leafIdentityOf([])).toBeUndefined();
    expect(leafIdentityOf([leaf([1, 255], [16])])).toBe('01ff:10');
    expect(leafIdentityOf([leaf([2], [3]), leaf([1], [4])])).toBe('01:04|02:03');
    expect(leafIdentityOf([leaf([1], [4]), leaf([2], [3])])).toBe('01:04|02:03');
  });

  it('a re-joined member (fresh key package → new keys) has a different identity; a new HPKE key alone also differs', () => {
    expect(leafIdentityOf([leaf([1], [2])])).not.toBe(leafIdentityOf([leaf([9], [2])]));
    expect(leafIdentityOf([leaf([1], [2])])).not.toBe(leafIdentityOf([leaf([1], [8])]));
  });
});

describe('pendingRemovalStorage store', () => {
  it('uses its own few-pending-removals database', () => {
    expect(created).toEqual([['few-pending-removals', 'removals']]);
  });

  it('put is idempotent per (groupId, pubkey), keyed groupId:pubkey; list is group-scoped (prefix collisions too) and oldest first', async () => {
    await putPendingRemoval(rec('g1', B, 20));
    await putPendingRemoval(rec('g1', A, 10));
    await putPendingRemoval(rec('g1', A, 10));
    await putPendingRemoval(rec('g10', C, 5));
    expect(await raw.keys()).toEqual([`g10:${C}`, `g1:${A}`, `g1:${B}`].sort());
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 10), rec('g1', B, 20)]);
  });

  it.each([
    ['null', null],
    ['no pubkey', { groupId: 'g1', receivedAt: 1, leafIdentity: ID }],
    ['empty pubkey', { groupId: 'g1', pubkey: '', receivedAt: 1, leafIdentity: ID }],
    ['bad receivedAt', { groupId: 'g1', pubkey: A, receivedAt: '1', leafIdentity: ID }],
    ['bad groupId', { groupId: 7, pubkey: A, receivedAt: 1, leafIdentity: ID }],
    ['no leaf identity (pre-remediation row)', { groupId: 'g1', pubkey: A, receivedAt: 1 }],
    ['empty leaf identity', { groupId: 'g1', pubkey: A, receivedAt: 1, leafIdentity: '' }],
    ['key/value mismatch', { groupId: 'g1', pubkey: C, receivedAt: 1, leafIdentity: ID }],
  ])('a malformed row (%s) is never listed and is reported for deletion', async (_l, row) => {
    await raw.set(`g1:${A}`, row);
    await putPendingRemoval(rec('g1', B, 2));
    expect((await listPendingRemovals('g1')).map((r) => r.pubkey)).toEqual([B]);
    const rows = await readPendingRemovalRows('g1');
    expect(rows.valid.map((r) => r.pubkey)).toEqual([B]);
    expect(rows.invalidKeys).toEqual([`g1:${A}`]);
  });

  it('an empty-pubkey row stored under the bare group prefix is malformed', async () => {
    await raw.set('g1:', { groupId: 'g1', pubkey: '', receivedAt: 1, leafIdentity: ID });
    expect(await readPendingRemovalRows('g1')).toEqual({ valid: [], invalidKeys: ['g1:'] });
  });

  it('a row of a group whose id extends this one past a colon is neither listed nor deleted for this group', async () => {
    await putPendingRemoval(rec('g1:x', A, 1));
    expect(await readPendingRemovalRows('g1')).toEqual({ valid: [], invalidKeys: [] });
    await resumePendingRemovals({ groupId: 'g1', isAdmin: false, now: NOW, maxAgeMs: MAX_AGE, queue: new Map(), arm: vi.fn() });
    expect(await raw.has(`g1:x:${A}`)).toBe(true);
  });

  it('readPendingRemovalRows ignores other groups, including prefix collisions', async () => {
    await raw.set('g10:x', null);
    await putPendingRemoval(rec('g10', A, 1));
    await putPendingRemoval(rec('g1', B, 2));
    const rows = await readPendingRemovalRows('g1');
    expect(rows).toEqual({ valid: [rec('g1', B, 2)], invalidKeys: [] });
  });

  it('deleteMatchingPendingRemovals removes only rows matching pubkey AND identity in that group; empty list touches nothing', async () => {
    await putPendingRemoval(rec('g1', A, 1));
    await putPendingRemoval(rec('g1', B, 2));
    await putPendingRemoval(rec('g2', A, 3));
    txLog.length = 0;
    await deleteMatchingPendingRemovals('g1', []);
    expect(txLog).toEqual([]);
    await deleteMatchingPendingRemovals('g1', [{ pubkey: B, leafIdentity: 'other' }]);
    expect(await raw.keys()).toEqual([`g1:${A}`, `g1:${B}`, `g2:${A}`].sort());
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: ID }]);
    expect(await raw.keys()).toEqual([`g1:${B}`, `g2:${A}`].sort());
  });

  it('serialisation survives a failed operation: the next one still runs', async () => {
    vi.mocked(idb.set).mockRejectedValueOnce(new Error('boom'));
    await expect(putPendingRemoval(rec('g1', A, 1))).rejects.toThrow('boom');
    await putPendingRemoval(rec('g1', B, 2));
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', B, 2)]);
  });

  it('clearPendingRemovalsForGroup removes only that group; clearAll removes everything', async () => {
    await putPendingRemoval(rec('g1', A, 1));
    await putPendingRemoval(rec('g10', B, 2));
    await clearPendingRemovalsForGroup('g1');
    expect(await raw.keys()).toEqual([`g10:${B}`]);
    await clearAllPendingRemovals();
    expect(await raw.size()).toBe(0);
  });
});

describe('queue glue', () => {
  it('addToRemovalQueue: same pubkey + same identity dedups; a different identity replaces in place (one entry per pubkey)', () => {
    const q = new Map<string, Rec[]>();
    expect(addToRemovalQueue(q, rec('g1', A, 1))).toBe(true);
    expect(addToRemovalQueue(q, rec('g1', B, 1))).toBe(true);
    expect(addToRemovalQueue(q, rec('g1', A, 2))).toBe(false);
    expect(q.get('g1')).toEqual([rec('g1', A, 1), rec('g1', B, 1)]);
    expect(addToRemovalQueue(q, rec('g1', A, 3, 'other'))).toBe(true);
    expect(q.get('g1')).toEqual([rec('g1', A, 3, 'other'), rec('g1', B, 1)]);
    expect(addToRemovalQueue(q, rec('g2', A, 3))).toBe(true);
    expect(q.get('g2')).toHaveLength(1);
  });

  it('addToRemovalQueue: an identity-less entry is replaced by one with identity; two identity-less ones dedup', () => {
    const q = new Map<string, Rec[]>();
    const bare = { groupId: 'g1', pubkey: A, receivedAt: 1 };
    expect(addToRemovalQueue(q, bare)).toBe(true);
    expect(addToRemovalQueue(q, { ...bare, receivedAt: 2 })).toBe(false);
    expect(addToRemovalQueue(q, rec('g1', A, 3))).toBe(true);
    expect(q.get('g1')).toEqual([rec('g1', A, 3)]);
  });

  it('recordPendingRemoval queues in memory and durably, with the captured leaf identity', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 42, ID);
    expect(q.get('g1')).toEqual([rec('g1', A, 42)]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 42)]);
  });

  it('(b) a same-identity re-receipt dedups the queue and re-puts the QUEUED entry unchanged (first receivedAt kept)', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, ID);
    await recordPendingRemoval(q, 'g1', A, 2, ID);
    expect(idb.set).toHaveBeenCalledTimes(2);
    expect(q.get('g1')).toEqual([rec('g1', A, 1)]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1)]);
  });

  it('remediation round 1: a duplicate after a FAILED first put writes the row (and rejects again if that put fails too)', async () => {
    const q = new Map<string, Rec[]>();
    vi.mocked(idb.set).mockRejectedValueOnce(new Error('QuotaExceeded'));
    await expect(recordPendingRemoval(q, 'g1', A, 1, ID)).rejects.toThrow('QuotaExceeded');
    vi.mocked(idb.set).mockRejectedValueOnce(new Error('still full'));
    await expect(recordPendingRemoval(q, 'g1', A, 2, ID)).rejects.toThrow('still full');
    expect(await raw.size()).toBe(0);
    await expect(recordPendingRemoval(q, 'g1', A, 3, ID)).resolves.toBeUndefined();
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1)]);
  });

  it('a duplicate of an identity-less (memory-only) entry stays memory-only', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, undefined);
    await recordPendingRemoval(q, 'g1', A, 2, undefined);
    expect(idb.set).not.toHaveBeenCalled();
  });

  it('a leave from the same pubkey with a NEW identity (re-joined member left again) replaces the queued entry and overwrites the stored row', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, 'idOld');
    await recordPendingRemoval(q, 'g1', A, 2, 'idNew');
    expect(q.get('g1')).toEqual([rec('g1', A, 2, 'idNew')]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 2, 'idNew')]);
  });

  it('(c) an identity-less memory-only entry replaced by one with identity gets persisted', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, undefined);
    expect(await raw.size()).toBe(0);
    await recordPendingRemoval(q, 'g1', A, 2, ID);
    expect(q.get('g1')).toEqual([rec('g1', A, 2)]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 2)]);
  });

  it('(a) settle is identity-scoped: settling the resumed stale A leaves the re-joined member\'s new removal B (queue entry and stored row) intact', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 10, 'idA'));
    const q = new Map<string, Rec[]>();
    await resumePendingRemovals({ groupId: 'g1', isAdmin: true, now: NOW, maxAgeMs: MAX_AGE, queue: q, arm: vi.fn() });
    expect(q.get('g1')).toEqual([rec('g1', A, NOW - 10, 'idA')]);
    await recordPendingRemoval(q, 'g1', A, NOW, 'idB');
    expect(q.get('g1')).toEqual([rec('g1', A, NOW, 'idB')]);
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: 'idA' }]);
    expect(q.get('g1')).toEqual([rec('g1', A, NOW, 'idB')]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, NOW, 'idB')]);
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: 'idB' }]);
    expect(q.has('g1')).toBe(false);
    expect(await raw.size()).toBe(0);
  });

  it('settling several records at once drops each matching entry and row', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, 'idA');
    await recordPendingRemoval(q, 'g1', B, 2, 'idB');
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: 'idA' }, { pubkey: B, leafIdentity: 'idB' }]);
    expect(q.has('g1')).toBe(false);
    expect(await raw.size()).toBe(0);
  });

  it('settling an identity-less (in-session) entry removes it from memory and never deletes a stored row', async () => {
    const q = new Map<string, Rec[]>([['g1', [{ groupId: 'g1', pubkey: A, receivedAt: 1 }]]]);
    await putPendingRemoval(rec('g1', A, 1, 'idX'));
    await settlePendingRemovals(q, 'g1', [{ pubkey: A }]);
    expect(q.has('g1')).toBe(false);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1, 'idX')]);
  });

  it('a stored row is deleted only when its identity matches; other members untouched', async () => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await putPendingRemoval(rec('g1', B, 1, 'idB'));
    await forgetPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'nope' }, { pubkey: B, leafIdentity: 'idB' }]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1, 'idA')]);
  });

  it('a delete racing a re-write of the same key never removes the replacement (operations are serialised)', async () => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    const forgetting = forgetPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }]);
    const writing = putPendingRemoval(rec('g1', A, 2, 'idB'));
    await Promise.all([forgetting, writing]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 2, 'idB')]);
  });

  it('without a captured leaf identity the removal is queued in memory only (never persisted unverifiable)', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 7, undefined);
    expect(q.get('g1')).toEqual([{ groupId: 'g1', pubkey: A, receivedAt: 7 }]);
    expect(idb.set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no leaf identity'));
  });

  it('failure injection: a failed durable write keeps the in-memory removal, warns, and REJECTS (the leave stays journaled — bug: journal-ack-before-durable-side-effects)', async () => {
    const q = new Map<string, Rec[]>();
    vi.mocked(idb.set).mockRejectedValueOnce(new Error('QuotaExceeded'));
    await expect(recordPendingRemoval(q, 'g1', A, 1, ID)).rejects.toThrow('QuotaExceeded');
    expect(q.get('g1')?.map((e) => e.pubkey)).toEqual([A]);
    expect(await raw.size()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('persist failed'), expect.any(Error));
  });

  it('failure injection: a write whose transaction fails before it starts rejects and stores nothing', async () => {
    faults.readwrite = 'reject';
    await expect(persistPendingRemoval(rec('g1', A, 1))).rejects.toThrow('idb down');
    expect(await raw.size()).toBe(0);
  });

  it('persistPendingRemoval uses the injected writer', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    await persistPendingRemoval(rec('g1', A, 1), put);
    expect(put).toHaveBeenCalledWith(rec('g1', A, 1));
    expect(warn).not.toHaveBeenCalled();
  });

  it('settlePendingRemovals drops settled members from memory (later arrivals survive) and from storage', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, ID);
    await recordPendingRemoval(q, 'g1', B, 2, ID);
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: ID }]);
    expect(q.get('g1')?.map((e) => e.pubkey)).toEqual([B]);
    expect((await listPendingRemovals('g1')).map((r) => r.pubkey)).toEqual([B]);
    await settlePendingRemovals(q, 'g1', [{ pubkey: B, leafIdentity: ID }]);
    expect(q.has('g1')).toBe(false);
    expect(await raw.size()).toBe(0);
  });

  it('settling a group with nothing queued leaves the queue untouched', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g2', B, 1, ID);
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: ID }]);
    expect([...q.keys()]).toEqual(['g2']);
  });

  it('failure injection: a failed durable delete still settles memory, warns, never rejects', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, ID);
    faults.readwrite = 'reject';
    await expect(settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: ID }])).resolves.toBeUndefined();
    expect(q.has('g1')).toBe(false);
    expect(await raw.size()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'), expect.any(Error));
  });

  it('forgetPendingRemovals uses the injected deleter', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await forgetPendingRemovals('g1', [{ pubkey: A, leafIdentity: ID }], del);
    expect(del).toHaveBeenCalledWith('g1', [{ pubkey: A, leafIdentity: ID }]);
  });
});

describe('resumePendingRemovals (fail-safe toward NOT evicting)', () => {
  const resume = (q: Map<string, Rec[]>, isAdmin: boolean | undefined, arm = vi.fn(), now = NOW) =>
    resumePendingRemovals({ groupId: 'g1', isAdmin, now, maxAgeMs: MAX_AGE, queue: q, arm });

  it('admin: re-arms stored records AS-IS (stored leaf identity and receivedAt, no re-write), oldest first, and arms the timer', async () => {
    await putPendingRemoval(rec('g1', B, NOW - 2, 'idB'));
    await putPendingRemoval(rec('g1', A, NOW - 5, 'idA'));
    vi.mocked(idb.set).mockClear();
    const q = new Map<string, Rec[]>();
    const arm = vi.fn();
    const resumed = await resume(q, true, arm);
    expect(resumed).toEqual([rec('g1', A, NOW - 5, 'idA'), rec('g1', B, NOW - 2, 'idB')]);
    expect(q.get('g1')).toEqual(resumed);
    expect(idb.set).not.toHaveBeenCalled();
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith('g1');
  });

  it('admin: an in-memory entry wins over its stored row even with a different identity (resume never replaces); in-memory-only entries are re-armed too', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1, 'stored'));
    const q = new Map<string, Rec[]>([['g1', [rec('g1', A, NOW, 'memory'), rec('g1', C, NOW, 'mc')]]]);
    const arm = vi.fn();
    expect(await resume(q, true, arm)).toEqual([]);
    expect(q.get('g1')?.map((e) => e.leafIdentity)).toEqual(['memory', 'mc']);
    expect(arm).toHaveBeenCalledWith('g1');
  });

  it('age bound: a row at/over the journal retention is dropped and forgotten, a younger one resumes', async () => {
    await putPendingRemoval(rec('g1', A, NOW - MAX_AGE));
    await putPendingRemoval(rec('g1', B, NOW - MAX_AGE + 1));
    const q = new Map<string, Rec[]>();
    expect((await resume(q, true)).map((r) => r.pubkey)).toEqual([B]);
    expect(await raw.keys()).toEqual([`g1:${B}`]);
  });

  it('non-admin device: stored rows are forgotten, never re-armed; in-memory entries are still re-armed (in-session path unchanged)', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1));
    await putPendingRemoval(rec('g2', B, NOW - 1));
    const q = new Map<string, Rec[]>([['g1', [rec('g1', C, NOW)]]]);
    const arm = vi.fn();
    expect(await resume(q, false, arm)).toEqual([]);
    expect(q.get('g1')?.map((e) => e.pubkey)).toEqual([C]);
    expect(await raw.keys()).toEqual([`g2:${B}`]);
    expect(arm).toHaveBeenCalledWith('g1');
  });

  it('admin status unknown: nothing re-armed and no valid row deleted (unconfirmed → no destructive write)', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1));
    const q = new Map<string, Rec[]>();
    const arm = vi.fn();
    expect(await resume(q, undefined, arm)).toEqual([]);
    expect(q.size).toBe(0);
    expect(await raw.has(`g1:${A}`)).toBe(true);
    expect(arm).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])('malformed / identity-less rows are deleted at resume (isAdmin=%s)', async (isAdmin) => {
    await raw.set(`g1:${A}`, { groupId: 'g1', pubkey: A, receivedAt: NOW - 1 });
    const q = new Map<string, Rec[]>();
    expect(await resume(q, isAdmin)).toEqual([]);
    expect(q.size).toBe(0);
    expect(await raw.size()).toBe(0);
  });

  it('nothing pending: no timer armed, no delete transaction', async () => {
    const arm = vi.fn();
    expect(await resume(new Map(), true, arm)).toEqual([]);
    expect(arm).not.toHaveBeenCalled();
    expect(txLog).toEqual(['readonly']);
  });

  it('failure injection: a failed resume read still re-arms the in-memory members, deletes nothing, warns, never rejects', async () => {
    const q = new Map<string, Rec[]>([['g1', [rec('g1', A, NOW)]]]);
    const arm = vi.fn();
    await raw.set(`g1:${B}`, { groupId: 'g1', pubkey: B, receivedAt: 1 }); // would be deleted after a good read
    vi.mocked(idb.entries).mockRejectedValueOnce(new Error('read failed'));
    await expect(resume(q, true, arm)).resolves.toEqual([]);
    expect(arm).toHaveBeenCalledWith('g1');
    expect(await raw.has(`g1:${B}`)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume read failed'), expect.any(Error));
  });

  it('failure injection: a failed resume delete is warned, never rejects, and still re-arms the valid rows', async () => {
    await putPendingRemoval(rec('g1', A, NOW - MAX_AGE));
    await putPendingRemoval(rec('g1', B, NOW - 1));
    faults.readwrite = 'reject';
    const q = new Map<string, Rec[]>();
    await expect(resume(q, true)).resolves.toEqual([rec('g1', B, NOW - 1)]);
    expect(await raw.size()).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume cleanup failed'), expect.any(Error));
  });
});

describe('selfAdminStatus', () => {
  it('true/false from the admin list (case-insensitive); undefined when unknown', () => {
    expect(selfAdminStatus([B, A.toUpperCase()], A)).toBe(true);
    expect(selfAdminStatus([B], A)).toBe(false);
    expect(selfAdminStatus([7, null], A)).toBe(false);
    expect(selfAdminStatus(undefined, A)).toBeUndefined();
    expect(selfAdminStatus('x', A)).toBeUndefined();
    expect(selfAdminStatus([A], null)).toBeUndefined();
    expect(selfAdminStatus([A], '')).toBeUndefined();
  });
});

// Remediation round 3: resume's read → classify → delete runs on the same
// serialised chain as puts and deletes only rows that still match exactly what
// was read (pubkey + leafIdentity + receivedAt; malformed rows only while
// still malformed). A leave B persisted under the same key in between (e.g. a
// journal replay racing the resume) is never deleted.
describe('resumePendingRemovals never deletes a row written after it read (round 3)', () => {
  const resumeWith = (isAdmin: boolean | undefined) =>
    resumePendingRemovals({ groupId: 'g1', isAdmin, now: NOW, maxAgeMs: MAX_AGE, queue: new Map(), arm: vi.fn() });
  const B_ROW = () => rec('g1', A, NOW, 'idB');

  it.each([
    ['expired A (admin)', true, rec('g1', A, NOW - MAX_AGE, 'idA')],
    ['A on a non-admin device', false, rec('g1', A, NOW - 1, 'idA')],
    ['malformed A', true, { groupId: 'g1', pubkey: A, receivedAt: NOW - 1 }],
  ] as const)('%s: a put of B to the same key issued right after resume starts survives (serialised)', async (_l, isAdmin, rowA) => {
    await raw.set(`g1:${A}`, rowA);
    const resuming = resumeWith(isAdmin);
    const writing = putPendingRemoval(B_ROW());
    await Promise.all([resuming, writing]);
    expect(await listPendingRemovals('g1')).toEqual([B_ROW()]);
  });

  it.each([
    ['expired A (admin)', true, rec('g1', A, NOW - MAX_AGE, 'idA')],
    ['A on a non-admin device', false, rec('g1', A, NOW - 1, 'idA')],
    ['malformed A', true, { groupId: 'g1', pubkey: A, receivedAt: NOW - 1 }],
    ['same identity, newer receivedAt (non-admin)', false, rec('g1', A, NOW - 5, 'idB')],
  ] as const)('%s: a row replaced by B from another connection (tab) right after ANY read, before the delete, survives', async (_l, isAdmin, rowA) => {
    await raw.set(`g1:${A}`, rowA);
    // Every read sees A and is followed by tab B's write (the pre-fix code
    // re-read in its own transaction, then deleted in a separate one).
    vi.mocked(idb.entries).mockImplementation(async (store) => {
      await real.set(`g1:${A}`, rowA, tabB);
      const snapshot = await real.entries(store);
      await real.set(`g1:${A}`, B_ROW(), tabB);
      return snapshot as never;
    });
    await resumeWith(isAdmin);
    vi.mocked(idb.entries).mockImplementation(real.entries);
    expect(await listPendingRemovals('g1')).toEqual([B_ROW()]);
  });

  it('a settle delete never touches an unrelated malformed row (only resume deletes those)', async () => {
    await raw.set(`g1:${B}`, { groupId: 'g1', pubkey: B, receivedAt: 1 });
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }]);
    expect(await raw.keys()).toEqual([`g1:${B}`]);
  });

  it('nothing to delete: resume reads once and opens no delete transaction', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1, 'idA'));
    vi.mocked(idb.entries).mockClear();
    txLog.length = 0;
    await resumeWith(true);
    expect(idb.entries).toHaveBeenCalledTimes(1);
    expect(txLog).toEqual(['readonly']);
  });

  it('rows that still match what was read are deleted (expired, non-admin, malformed) and an unrelated valid row stays', async () => {
    await raw.set(`g1:${A}`, rec('g1', A, NOW - MAX_AGE, 'idA'));
    await raw.set(`g1:${B}`, { groupId: 'g1', pubkey: B, receivedAt: 1 });
    await raw.set(`g1:${C}`, rec('g1', C, NOW - 1, 'idC'));
    await resumeWith(true);
    expect(await raw.keys()).toEqual([`g1:${C}`]);
  });

  it('a malformed key repaired (made valid) by another tab between the read and the delete survives', async () => {
    await raw.set(`g1:${A}`, { groupId: 'g1', pubkey: A, receivedAt: NOW - 1 });
    vi.mocked(idb.entries).mockImplementationOnce(async (store) => {
      const snapshot = await real.entries(store);
      await real.set(`g1:${A}`, B_ROW(), tabB);
      return snapshot as never;
    });
    await resumeWith(undefined);
    expect(await listPendingRemovals('g1')).toEqual([B_ROW()]);
  });
});

// Bug pending-removal-compare-delete-single-txn: compare and delete run in ONE
// readwrite transaction, so a put by an independent connection (another tab)
// lands either before the in-transaction compare (row kept, it no longer
// matches) or after the commit (row re-created) — never in between. Swept
// over every scheduling offset, so the window between a separate read and a
// separate delete (the pre-fix shape) is hit.
describe('conditional delete is one transaction: another tab\'s write is never deleted', () => {
  const OFFSETS = Array.from({ length: 12 }, (_, i) => i);

  it.each(OFFSETS)('settle path: tab B rewrites the row %i scheduling turns after the delete started → B survives', async (n) => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await putPendingRemoval(rec('g1', C, 1, 'idC'));
    const deleting = deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }, { pubkey: C, leafIdentity: 'idC' }]);
    await turns(n);
    await real.set(`g1:${A}`, rec('g1', A, 2, 'idB'), tabB);
    await deleting;
    // Whatever the interleaving, B's row is the final state and C is gone.
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 2, 'idB')]);
  });

  it.each(OFFSETS)('resume path (non-admin forgets): tab B rewrites the row %i turns after resume started → B survives', async (n) => {
    await putPendingRemoval(rec('g1', A, NOW - 1, 'idA'));
    const resuming = resumePendingRemovals({ groupId: 'g1', isAdmin: false, now: NOW, maxAgeMs: MAX_AGE, queue: new Map(), arm: vi.fn() });
    await turns(n);
    await real.set(`g1:${A}`, rec('g1', A, NOW, 'idB'), tabB);
    await resuming;
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, NOW, 'idB')]);
  });

  it('a row written by tab B BEFORE the delete is compared in-transaction and kept; rows still matching are deleted in the same transaction', async () => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await putPendingRemoval(rec('g1', B, 1, 'idB'));
    await real.set(`g1:${A}`, rec('g1', A, 5, 'idA2'), tabB);
    txLog.length = 0;
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }, { pubkey: B, leafIdentity: 'idB' }]);
    expect(txLog).toEqual(['readwrite']);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 5, 'idA2')]);
  });

  it('failure injection: a transaction aborted mid-flight deletes nothing and rejects; the settle still settles memory and warns', async () => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    faults.readwrite = 'abort';
    await expect(deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }])).rejects.toBeDefined();
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1, 'idA')]);
    const q = new Map<string, Rec[]>([['g1', [rec('g1', A, 1, 'idA')]]]);
    faults.readwrite = 'abort';
    await expect(settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: 'idA' }])).resolves.toBeUndefined();
    expect(q.has('g1')).toBe(false);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1, 'idA')]);
    // An explicitly aborted transaction carries no error object (null).
    expect(warn.mock.calls.map(([m]) => m)).toEqual([expect.stringContaining('cleanup failed')]);
  });

  it('failure injection: an aborted resume delete keeps every row and still re-arms the valid ones', async () => {
    await putPendingRemoval(rec('g1', A, NOW - MAX_AGE, 'idA'));
    await putPendingRemoval(rec('g1', B, NOW - 1, 'idB'));
    faults.readwrite = 'abort';
    const q = new Map<string, Rec[]>();
    await expect(resumePendingRemovals({ groupId: 'g1', isAdmin: true, now: NOW, maxAgeMs: MAX_AGE, queue: q, arm: vi.fn() }))
      .resolves.toEqual([rec('g1', B, NOW - 1, 'idB')]);
    expect(await raw.size()).toBe(2);
  });

  it('only the group\'s own key range is scanned: rows of other groups (including id-prefix collisions) are never deleted', async () => {
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await putPendingRemoval(rec('g10', A, 1, 'idA'));
    await putPendingRemoval(rec('g1:x', A, 1, 'idA'));
    await putPendingRemoval(rec('g0', A, 1, 'idA'));
    await raw.set('g1;', { groupId: 'g1', pubkey: A, receivedAt: 1, leafIdentity: 'idA' });
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }]);
    expect(await raw.keys()).toEqual([`g0:${A}`, `g10:${A}`, `g1:x:${A}`, 'g1;'].sort());
  });
});

describe('recordLeaveIntent: which identity a leave is checked against (remediation round 2)', () => {
  type Journal = { journaled: boolean; identity?: string };
  const run = (opts: { replayed: boolean; journal: () => Promise<Journal>; current?: () => Promise<string | undefined>; put?: (r: Rec) => Promise<void> }) => {
    const queue = new Map<string, Rec[]>();
    const arm = vi.fn();
    const captureCurrent = vi.fn(opts.current ?? (async () => 'now'));
    const done = recordLeaveIntent({ queue, groupId: 'g1', pubkey: A, replayed: opts.replayed, now: 7, readJournal: opts.journal, captureCurrent, arm, put: opts.put });
    return { queue, arm, captureCurrent, done };
  };
  const MODES = [false, true] as const;

  it.each(MODES)('replayed=%s: a journaled identity is used; the current leaf is never consulted', async (replayed) => {
    const r = run({ replayed, journal: async () => ({ journaled: true, identity: 'journaled' }) });
    await r.done;
    expect(r.captureCurrent).not.toHaveBeenCalled();
    expect(r.queue.get('g1')).toEqual([rec('g1', A, 7, 'journaled')]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 7, 'journaled')]);
    expect(r.arm).toHaveBeenCalledWith('g1');
  });

  it.each(MODES)('replayed=%s: a failed journal read rejects — nothing queued, nothing captured, nothing armed', async (replayed) => {
    const r = run({ replayed, journal: async () => { throw new Error('idb read'); } });
    await expect(r.done).rejects.toThrow('idb read');
    expect(r.captureCurrent).not.toHaveBeenCalled();
    expect(r.queue.size).toBe(0);
    expect(r.arm).not.toHaveBeenCalled();
    expect(await raw.size()).toBe(0);
  });

  it.each([
    ['no journal row', { journaled: false }],
    ['a row without an identity', { journaled: true }],
  ] as const)('LIVE, %s: the current leaf is captured and used', async (_l, journal) => {
    const r = run({ replayed: false, journal: async () => journal });
    await r.done;
    expect(r.captureCurrent).toHaveBeenCalledTimes(1);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 7, 'now')]);
    expect(r.arm).toHaveBeenCalledWith('g1');
  });

  it.each([
    ['no journal row', { journaled: false }],
    ['a row without an identity (incl. legacy rows)', { journaled: true }],
  ] as const)('REPLAYED, %s: skipped — no capture, nothing enqueued (not even in memory), nothing armed; warned with group and pubkey; resolves', async (_l, journal) => {
    const r = run({ replayed: true, journal: async () => journal });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.captureCurrent).not.toHaveBeenCalled();
    expect(r.queue.size).toBe(0);
    expect(r.arm).not.toHaveBeenCalled();
    expect(await raw.size()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`replayed leave of ${A} in group g1 .*skipped`)));
  });

  it.each([
    ['throws', async () => { throw new Error('no group'); }],
    ['finds no leaf', async () => undefined],
  ] as const)('LIVE, the current capture %s: a pubkey-only memory entry, armed, never persisted; resolves', async (_l, current) => {
    const r = run({ replayed: false, journal: async () => ({ journaled: false }), current });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.queue.get('g1')).toEqual([{ groupId: 'g1', pubkey: A, receivedAt: 7 }]);
    expect(r.arm).toHaveBeenCalledWith('g1');
    expect(await raw.size()).toBe(0);
  });

  it('failure injection: a failed capture is warned', async () => {
    const r = run({ replayed: false, journal: async () => ({ journaled: false }), current: async () => { throw new Error('no group'); } });
    await r.done;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaf identity capture'), expect.any(Error));
  });

  it.each(MODES)('replayed=%s, failure injection: a failed durable write rejects; the memory entry is queued and armed', async (replayed) => {
    const r = run({ replayed, journal: async () => ({ journaled: true, identity: 'journaled' }), put: async () => { throw new Error('QuotaExceeded'); } });
    await expect(r.done).rejects.toThrow('QuotaExceeded');
    expect(r.queue.get('g1')).toEqual([rec('g1', A, 7, 'journaled')]);
    expect(r.arm).toHaveBeenCalledWith('g1');
  });
});
