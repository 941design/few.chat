/**
 * recomputeUnread (S5, AC-WDR-1): after rows are removed from a group's stored messages the unread
 * count is recomputed over the REMAINING rows with the same predicate the startup scan uses (stored
 * rows newer than the last-read mark and not authored by the local account), authoritatively (0 clears).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  },
  writable: true,
});

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => void idbStore.set(key, value)),
  del: vi.fn(async (key: string) => void idbStore.delete(key)),
  delMany: vi.fn(async (ks: string[]) => ks.forEach((k) => idbStore.delete(k))),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
  entries: vi.fn(async () => []),
  clear: vi.fn(async () => undefined),
}));
vi.mock('react', () => ({ useSyncExternalStore: (_s: unknown, g: () => unknown) => g() }));

const { initUnreadCounts, recomputeUnread, incrementUnread, markAsRead, useUnreadCounts } = await import('@/src/lib/unreadStore');

const SELF = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const G = 'g'.repeat(8);
const H = 'h'.repeat(8);
type Row = { id: string; createdAt: number; senderPubkey: string };
const seed = (groupId: string, rows: Row[]) => idbStore.set(`few:messages:${groupId}`, rows);
const count = (groupId: string) => useUnreadCounts().counts[groupId];
// seeded OUT of createdAt order on purpose: the count must not depend on row order
const rows = (): Row[] => [
  { id: 'm3', createdAt: 3000, senderPubkey: BOB },
  { id: 'm1', createdAt: 1000, senderPubkey: BOB },
  { id: 'm4', createdAt: 4000, senderPubkey: SELF },
  { id: 'm2', createdAt: 2000, senderPubkey: BOB.toUpperCase() },
];

beforeEach(() => {
  localStorage.clear?.();
  idbStore.clear();
});

describe('recomputeUnread', () => {
  it('counts the non-own rows after last-read over the remaining rows: 3 before, 2 after a withdrawn row, 0 after all', async () => {
    seed(G, rows());
    await initUnreadCounts([G], SELF);
    expect(count(G)).toBe(3); // m1, m2, m3 (m4 is own)

    seed(G, rows().filter((r) => r.id !== 'm2'));
    await recomputeUnread(G, SELF);
    expect(count(G)).toBe(2);

    seed(G, rows().filter((r) => r.id === 'm4'));
    await recomputeUnread(G, SELF);
    expect(count(G)).toBeUndefined(); // the entry is gone, not left at its stale value
  });

  it('respects the last-read mark and compares the own key case-insensitively', async () => {
    localStorage.setItem('lp_unreadLastRead_v1', JSON.stringify({ [G]: 2000 }));
    seed(G, rows());
    await recomputeUnread(G, SELF.toUpperCase());
    expect(count(G)).toBe(1); // only m3 (m1/m2 are not newer than 2000; m4 is own)
  });

  it('agrees with the startup scan on the same stored rows', async () => {
    seed(G, rows());
    await recomputeUnread(G, SELF);
    const recomputed = count(G);
    await initUnreadCounts([G], SELF);
    expect(count(G)).toBe(recomputed);
  });

  it('leaves other groups untouched and is idempotent', async () => {
    seed(G, rows());
    seed(H, rows());
    await initUnreadCounts([G, H], SELF);
    seed(G, rows().filter((r) => r.id !== 'm1'));
    await recomputeUnread(G, SELF);
    await recomputeUnread(G, SELF);
    expect([count(G), count(H)]).toEqual([2, 3]);
  });

  it('a live increment landing during the recompute read is re-read, not lost (persist-then-increment contract)', async () => {
    seed(G, rows());
    await initUnreadCounts([G], SELF);
    const idb = await import('idb-keyval');
    // the recompute's first read returns the rows as they were; a new message is then persisted and
    // increments while that read is still in flight
    (idb.get as ReturnType<typeof vi.fn>).mockImplementationOnce(async (key: string) => {
      const before = idbStore.get(key);
      seed(G, [...rows(), { id: 'm5', createdAt: 5000, senderPubkey: BOB }]);
      incrementUnread(G);
      return before;
    });
    await recomputeUnread(G, SELF);
    expect(count(G)).toBe(4);
  });

  it('a storage read failure keeps the CURRENT count (a failed read must not clear the badge); startup scan stays 0', async () => {
    const idb = await import('idb-keyval');
    seed(G, rows());
    await initUnreadCounts([G], SELF);
    expect(count(G)).toBe(3);
    (idb.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('idb down'));
    await expect(recomputeUnread(G, SELF)).resolves.toBeUndefined();
    expect(count(G)).toBe(3);

    (idb.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('idb down'));
    await expect(initUnreadCounts(['fresh-group'], SELF)).resolves.toBeUndefined();
    expect(count('fresh-group')).toBeUndefined();
  });

  it('a mark-as-read racing the recompute is not overwritten by the stale count', async () => {
    seed(G, rows());
    await initUnreadCounts([G], SELF);
    expect(count(G)).toBe(3);
    const idb = await import('idb-keyval');
    (idb.get as ReturnType<typeof vi.fn>).mockImplementationOnce(async (key: string) => {
      const before = idbStore.get(key);
      markAsRead(G); // user opens the group while the read is in flight
      return before; // stale rows: would count 3
    });
    await recomputeUnread(G, SELF);
    expect(count(G)).toBeUndefined();
  });
});
