/**
 * Integration test for clearAllGroupData's account-reset marker clear
 * (AC-MARKER-9 account-reset half, VQ-S2-008).
 *
 * Unlike groupStorage.test.ts, this file does NOT mock
 * pendingDirectInviteStorage.ts — it uses the real module so the assertion
 * proves clearAllGroupData genuinely clears markers across ALL groups via
 * the real store, not merely that a spy was invoked.
 *
 * The idb-keyval mock is PER-STORE (each createStore() call gets its own
 * backing Map, and every op routes by the store token passed as its last
 * argument). This is load-bearing: a shared-Map mock whose clear() ignored
 * the store arg would let clearAllGroupData's FIRST clear (clear(groupMetaStore))
 * wipe the marker keys too, making this test pass even if the marker-clear
 * wiring (groupStorage.ts `await clearAllPendingDirectInvites()`) were deleted.
 * With per-store isolation, only clearAllPendingDirectInvites() touches the
 * marker store — so removing that wiring correctly fails this test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── idb-keyval mock (PER-STORE fake backing maps) ───────────────────────────
const { createdStores, defaultStore } = vi.hoisted(() => ({
  createdStores: [] as Map<string, unknown>[],
  defaultStore: new Map<string, unknown>(),
}));

const backing = (store?: Map<string, unknown>) => store ?? defaultStore;

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => {
    const m = new Map<string, unknown>();
    createdStores.push(m);
    return m;
  }),
  get: vi.fn(async (key: string, store?: Map<string, unknown>) => backing(store).get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown, store?: Map<string, unknown>) => { backing(store).set(key, value); }),
  del: vi.fn(async (key: string, store?: Map<string, unknown>) => { backing(store).delete(key); }),
  keys: vi.fn(async (store?: Map<string, unknown>) => [...backing(store).keys()]),
  delMany: vi.fn(async (ks: string[], store?: Map<string, unknown>) => { ks.forEach((k) => backing(store).delete(k)); }),
  entries: vi.fn(async (store?: Map<string, unknown>) => [...backing(store).entries()]),
  clear: vi.fn(async (store?: Map<string, unknown>) => { backing(store).clear(); }),
}));

const { clearAllGroupData } = await import('@/src/lib/marmot/groupStorage');
const { putRumor, listPendingRumors } = await import('@/src/lib/marmot/rumorJournal');
const {
  markPendingDirectInvite,
  loadPendingDirectInviteMarkers,
} = await import('@/src/lib/marmot/pendingDirectInviteStorage');

const GROUP_A = 'group-clear-all-a';
const GROUP_B = 'group-clear-all-b';
const PUBKEY_1 = '11'.repeat(32);
const PUBKEY_2 = '22'.repeat(32);

beforeEach(() => {
  createdStores.forEach((m) => m.clear());
  defaultStore.clear();
});

describe('clearAllGroupData — real cross-group marker clear (AC-MARKER-9, VQ-S2-008)', () => {
  it('clears pending-direct-invite markers seeded across two distinct groups', async () => {
    await markPendingDirectInvite(GROUP_A, PUBKEY_1);
    await markPendingDirectInvite(GROUP_B, PUBKEY_2);

    // sanity: both markers present before the reset
    expect((await loadPendingDirectInviteMarkers(GROUP_A)).has(PUBKEY_1)).toBe(true);
    expect((await loadPendingDirectInviteMarkers(GROUP_B)).has(PUBKEY_2)).toBe(true);

    await clearAllGroupData();

    expect((await loadPendingDirectInviteMarkers(GROUP_A)).size).toBe(0);
    expect((await loadPendingDirectInviteMarkers(GROUP_B)).size).toBe(0);
  });
});

describe('clearAllGroupData — write-ahead rumor journal (bug: mls-message-lost-on-unload-after-ingest)', () => {
  it('drops every pending journal entry of every group', async () => {
    await putRumor({ groupId: GROUP_A, rumorId: 'r1', senderPubkey: PUBKEY_1, data: new Uint8Array([1]) });
    await putRumor({ groupId: GROUP_B, rumorId: 'r2', senderPubkey: PUBKEY_2, data: new Uint8Array([2]) });
    expect(await listPendingRumors(GROUP_A)).toHaveLength(1);

    await clearAllGroupData();

    expect(await listPendingRumors(GROUP_A)).toEqual([]);
    expect(await listPendingRumors(GROUP_B)).toEqual([]);
  });
});
