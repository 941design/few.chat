/**
 * pendingRemovalStorage.ts — durable debounced member-removal queue
 * (bug: pending-member-removals-not-persisted, VQ-2/VQ-4; remediation round 1:
 * stored removals are fail-safe toward NOT evicting — leaf identity, admin-only
 * resume, age bound, identity-less rows treated as malformed).
 *
 * Per-store Map-backed idb-keyval mock (same pattern as rumorJournal.test.ts).
 * Every storage step is failure-injected: the in-memory queue stays the
 * session's truth, cleanup is best-effort, nothing is lost or duplicated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stores, created } = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), created: [] as string[][] }));

vi.mock('idb-keyval', () => ({
  createStore: vi.fn((db: string, name: string) => {
    created.push([db, name]);
    const m = new Map<string, unknown>();
    stores.set(db, m);
    return m;
  }),
  set: vi.fn(async (k: string, v: unknown, s: Map<string, unknown>) => { s.set(k, v); }),
  delMany: vi.fn(async (ks: string[], s: Map<string, unknown>) => { ks.forEach((k) => s.delete(k)); }),
  keys: vi.fn(async (s: Map<string, unknown>) => [...s.keys()]),
  entries: vi.fn(async (s: Map<string, unknown>) => [...s.entries()]),
  clear: vi.fn(async (s: Map<string, unknown>) => { s.clear(); }),
}));

const idb = await import('idb-keyval');
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
} = await import('@/src/lib/marmot/pendingRemovalStorage');
type Rec = import('@/src/lib/marmot/pendingRemovalStorage').PendingRemovalRecord;

// The store is created lazily on first use (module import must not touch IDB).
expect(stores.has(PENDING_REMOVALS_DB_NAME)).toBe(false);
await listPendingRemovals('init');

const store = () => stores.get(PENDING_REMOVALS_DB_NAME)!;
const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const ID = 'leaf-id-1';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const NOW = 100 * DAY;
const rec = (groupId: string, pubkey: string, receivedAt: number, leafIdentity = ID): Rec => ({ groupId, pubkey, receivedAt, leafIdentity });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  store().clear();
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
    expect([...store().keys()].sort()).toEqual([`g10:${C}`, `g1:${A}`, `g1:${B}`].sort());
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
    store().set(`g1:${A}`, row);
    await putPendingRemoval(rec('g1', B, 2));
    expect((await listPendingRemovals('g1')).map((r) => r.pubkey)).toEqual([B]);
    const rows = await readPendingRemovalRows('g1');
    expect(rows.valid.map((r) => r.pubkey)).toEqual([B]);
    expect(rows.invalidKeys).toEqual([`g1:${A}`]);
  });

  it('an empty-pubkey row stored under the bare group prefix is malformed', async () => {
    store().set('g1:', { groupId: 'g1', pubkey: '', receivedAt: 1, leafIdentity: ID });
    expect(await readPendingRemovalRows('g1')).toEqual({ valid: [], invalidKeys: ['g1:'] });
  });

  it('a row of a group whose id extends this one past a colon is neither listed nor deleted for this group', async () => {
    await putPendingRemoval(rec('g1:x', A, 1));
    expect(await readPendingRemovalRows('g1')).toEqual({ valid: [], invalidKeys: [] });
    await resumePendingRemovals({ groupId: 'g1', isAdmin: false, now: NOW, maxAgeMs: MAX_AGE, queue: new Map(), arm: vi.fn() });
    expect(store().has(`g1:x:${A}`)).toBe(true);
  });

  it('readPendingRemovalRows ignores other groups, including prefix collisions', async () => {
    store().set('g10:x', null);
    await putPendingRemoval(rec('g10', A, 1));
    await putPendingRemoval(rec('g1', B, 2));
    const rows = await readPendingRemovalRows('g1');
    expect(rows).toEqual({ valid: [rec('g1', B, 2)], invalidKeys: [] });
  });

  it('deleteMatchingPendingRemovals removes only rows matching pubkey AND identity in that group; empty list touches nothing', async () => {
    await putPendingRemoval(rec('g1', A, 1));
    await putPendingRemoval(rec('g1', B, 2));
    await putPendingRemoval(rec('g2', A, 3));
    await deleteMatchingPendingRemovals('g1', []);
    expect(idb.entries).not.toHaveBeenCalled();
    await deleteMatchingPendingRemovals('g1', [{ pubkey: B, leafIdentity: 'other' }]);
    expect(idb.delMany).not.toHaveBeenCalled();
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: ID }]);
    expect([...store().keys()].sort()).toEqual([`g1:${B}`, `g2:${A}`].sort());
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
    expect([...store().keys()]).toEqual([`g10:${B}`]);
    await clearAllPendingRemovals();
    expect(store().size).toBe(0);
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

  it('(b) a same-identity re-receipt dedups and does not re-persist', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, ID);
    await recordPendingRemoval(q, 'g1', A, 2, ID);
    expect(idb.set).toHaveBeenCalledTimes(1);
    expect(q.get('g1')).toEqual([rec('g1', A, 1)]);
    expect(await listPendingRemovals('g1')).toEqual([rec('g1', A, 1)]);
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
    expect(store().size).toBe(0);
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
    expect(store().size).toBe(0);
  });

  it('settling several records at once drops each matching entry and row', async () => {
    const q = new Map<string, Rec[]>();
    await recordPendingRemoval(q, 'g1', A, 1, 'idA');
    await recordPendingRemoval(q, 'g1', B, 2, 'idB');
    await settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: 'idA' }, { pubkey: B, leafIdentity: 'idB' }]);
    expect(q.has('g1')).toBe(false);
    expect(store().size).toBe(0);
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

  it('failure injection: a failed durable write keeps the in-memory removal, warns, and never rejects', async () => {
    const q = new Map<string, Rec[]>();
    vi.mocked(idb.set).mockRejectedValueOnce(new Error('QuotaExceeded'));
    await expect(recordPendingRemoval(q, 'g1', A, 1, ID)).resolves.toBeUndefined();
    expect(q.get('g1')?.map((e) => e.pubkey)).toEqual([A]);
    expect(store().size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('persist failed'), expect.any(Error));
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
    expect(store().size).toBe(0);
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
    vi.mocked(idb.delMany).mockRejectedValueOnce(new Error('idb down'));
    await expect(settlePendingRemovals(q, 'g1', [{ pubkey: A, leafIdentity: ID }])).resolves.toBeUndefined();
    expect(q.has('g1')).toBe(false);
    expect(store().size).toBe(1);
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
    expect([...store().keys()]).toEqual([`g1:${B}`]);
  });

  it('non-admin device: stored rows are forgotten, never re-armed; in-memory entries are still re-armed (in-session path unchanged)', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1));
    await putPendingRemoval(rec('g2', B, NOW - 1));
    const q = new Map<string, Rec[]>([['g1', [rec('g1', C, NOW)]]]);
    const arm = vi.fn();
    expect(await resume(q, false, arm)).toEqual([]);
    expect(q.get('g1')?.map((e) => e.pubkey)).toEqual([C]);
    expect([...store().keys()]).toEqual([`g2:${B}`]);
    expect(arm).toHaveBeenCalledWith('g1');
  });

  it('admin status unknown: nothing re-armed and no valid row deleted (unconfirmed → no destructive write)', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1));
    const q = new Map<string, Rec[]>();
    const arm = vi.fn();
    expect(await resume(q, undefined, arm)).toEqual([]);
    expect(q.size).toBe(0);
    expect(store().has(`g1:${A}`)).toBe(true);
    expect(arm).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])('malformed / identity-less rows are deleted at resume (isAdmin=%s)', async (isAdmin) => {
    store().set(`g1:${A}`, { groupId: 'g1', pubkey: A, receivedAt: NOW - 1 });
    const q = new Map<string, Rec[]>();
    expect(await resume(q, isAdmin)).toEqual([]);
    expect(q.size).toBe(0);
    expect(store().size).toBe(0);
  });

  it('nothing pending: no timer armed, nothing deleted', async () => {
    const arm = vi.fn();
    expect(await resume(new Map(), true, arm)).toEqual([]);
    expect(arm).not.toHaveBeenCalled();
    expect(idb.delMany).not.toHaveBeenCalled();
  });

  it('failure injection: a failed resume read still re-arms the in-memory members, deletes nothing, warns, never rejects', async () => {
    const q = new Map<string, Rec[]>([['g1', [rec('g1', A, NOW)]]]);
    const arm = vi.fn();
    vi.mocked(idb.entries).mockRejectedValueOnce(new Error('read failed'));
    await expect(resume(q, true, arm)).resolves.toEqual([]);
    expect(arm).toHaveBeenCalledWith('g1');
    expect(idb.delMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume read failed'), expect.any(Error));
  });

  it('failure injection: a failed resume delete is warned, never rejects, and still re-arms the valid rows', async () => {
    await putPendingRemoval(rec('g1', A, NOW - MAX_AGE));
    await putPendingRemoval(rec('g1', B, NOW - 1));
    vi.mocked(idb.delMany).mockRejectedValueOnce(new Error('idb down'));
    const q = new Map<string, Rec[]>();
    await expect(resume(q, true)).resolves.toEqual([rec('g1', B, NOW - 1)]);
    expect(store().size).toBe(2);
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
    store().set(`g1:${A}`, rowA);
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
  ] as const)('%s: a row replaced by B between the read and the delete (outside the chain, e.g. another tab) survives', async (_l, isAdmin, rowA) => {
    store().set(`g1:${A}`, rowA);
    vi.mocked(idb.entries).mockImplementationOnce(async (s: Map<string, unknown>) => {
      const snapshot = [...s.entries()];
      s.set(`g1:${A}`, B_ROW());
      return snapshot as never;
    });
    await resumeWith(isAdmin);
    expect(await listPendingRemovals('g1')).toEqual([B_ROW()]);
  });

  it('a settle delete never touches an unrelated malformed row (only resume deletes those)', async () => {
    store().set(`g1:${B}`, { groupId: 'g1', pubkey: B, receivedAt: 1 });
    await putPendingRemoval(rec('g1', A, 1, 'idA'));
    await deleteMatchingPendingRemovals('g1', [{ pubkey: A, leafIdentity: 'idA' }]);
    expect([...store().keys()]).toEqual([`g1:${B}`]);
  });

  it('nothing to delete: resume reads once and issues no delete', async () => {
    await putPendingRemoval(rec('g1', A, NOW - 1, 'idA'));
    vi.mocked(idb.entries).mockClear();
    await resumeWith(true);
    expect(idb.entries).toHaveBeenCalledTimes(1);
    expect(idb.delMany).not.toHaveBeenCalled();
  });

  it('rows that still match what was read are deleted (expired, non-admin, malformed) and an unrelated valid row stays', async () => {
    store().set(`g1:${A}`, rec('g1', A, NOW - MAX_AGE, 'idA'));
    store().set(`g1:${B}`, { groupId: 'g1', pubkey: B, receivedAt: 1 });
    store().set(`g1:${C}`, rec('g1', C, NOW - 1, 'idC'));
    await resumeWith(true);
    expect([...store().keys()]).toEqual([`g1:${C}`]);
  });
});

