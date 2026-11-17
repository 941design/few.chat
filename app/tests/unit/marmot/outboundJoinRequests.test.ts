import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OutboundJoinRequestRecord } from '@/src/lib/marmot/outboundJoinRequests';

// Mock idb-keyval — in-memory store (mirrors inviteLinkStorage.test.ts).
const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => store.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  del: vi.fn(async (key: string) => { store.delete(key); }),
  keys: vi.fn(async () => [...store.keys()]),
  entries: vi.fn(async () => [...store.entries()]),
  clear: vi.fn(async () => { store.clear(); }),
}));

const {
  createOutboundJoinRequestStore,
  saveOutboundJoinRequest,
  loadUnexpiredOutboundJoinRequestsForAdmin,
  deleteOutboundJoinRequest,
  clearAllOutboundJoinRequests,
  cancelOutboundJoinRequest,
  subscribe,
  getSnapshot,
  getServerSnapshot,
  isOutboundJoinRequestsLoaded,
  OUTBOUND_JOIN_REQUEST_CAP,
  OUTBOUND_JOIN_REQUEST_TTL_MS,
} = await import('@/src/lib/marmot/outboundJoinRequests');

function makeRecord(overrides: Partial<OutboundJoinRequestRecord> = {}): OutboundJoinRequestRecord {
  return {
    nonce: 'nonce-1',
    adminPubkeyHex: 'admin-pubkey-hex',
    groupName: 'Test Group',
    sentAt: Date.now(),
    ...overrides,
  };
}

describe('outboundJoinRequests', () => {
  beforeEach(() => {
    store.clear();
  });

  describe('createOutboundJoinRequestStore', () => {
    it('returns a store reference', () => {
      expect(createOutboundJoinRequestStore()).toBe('mock-store');
    });
  });

  describe('saveOutboundJoinRequest / loadUnexpiredOutboundJoinRequestsForAdmin', () => {
    it('persists a record keyed by nonce', async () => {
      const record = makeRecord();
      await saveOutboundJoinRequest(record);
      expect(store.has(record.nonce)).toBe(true);
      expect(store.get(record.nonce)).toEqual(record);
    });

    it('returns records for the matching admin only', async () => {
      await saveOutboundJoinRequest(makeRecord({ nonce: 'n1', adminPubkeyHex: 'admin-A' }));
      await saveOutboundJoinRequest(makeRecord({ nonce: 'n2', adminPubkeyHex: 'admin-B' }));
      await saveOutboundJoinRequest(makeRecord({ nonce: 'n3', adminPubkeyHex: 'admin-A' }));

      const result = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-A');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.nonce).sort()).toEqual(['n1', 'n3']);
    });

    it('returns an empty array when no record exists for the admin', async () => {
      const result = await loadUnexpiredOutboundJoinRequestsForAdmin('unknown-admin');
      expect(result).toEqual([]);
    });

    // ── AC-AUTO-6: TTL ──────────────────────────────────────────────────────

    it('excludes an expired record (older than the TTL) from correlation', async () => {
      const expired = makeRecord({
        nonce: 'expired-1',
        adminPubkeyHex: 'admin-ttl',
        sentAt: Date.now() - OUTBOUND_JOIN_REQUEST_TTL_MS - 1000,
      });
      await saveOutboundJoinRequest(expired);

      const result = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-ttl');
      expect(result).toEqual([]);
    });

    it('includes a record sent just under the TTL boundary', async () => {
      const fresh = makeRecord({
        nonce: 'fresh-1',
        adminPubkeyHex: 'admin-ttl-2',
        sentAt: Date.now() - (OUTBOUND_JOIN_REQUEST_TTL_MS - 1000),
      });
      await saveOutboundJoinRequest(fresh);

      const result = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-ttl-2');
      expect(result).toHaveLength(1);
      expect(result[0].nonce).toBe('fresh-1');
    });

    it('enforces a TTL floor of at least 7 days', () => {
      expect(OUTBOUND_JOIN_REQUEST_TTL_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    // AC-AUTO-6 boundary: expiry is inclusive at the TTL edge. A record whose
    // age is EXACTLY the TTL (to the millisecond) is expired, not fresh — the
    // surrounding "under" / "over" tests both leave the exact boundary
    // unexercised, so they cannot tell an inclusive (`>=`) cutoff from an
    // exclusive (`>`) one. Date.now() is pinned so the age is precisely the TTL.
    it('excludes a record whose age is EXACTLY the TTL (expiry is inclusive at the boundary)', async () => {
      const fixedNow = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      try {
        await saveOutboundJoinRequest(
          makeRecord({
            nonce: 'ttl-exact-boundary',
            adminPubkeyHex: 'admin-ttl-exact',
            sentAt: fixedNow - OUTBOUND_JOIN_REQUEST_TTL_MS, // age === TTL exactly
          }),
        );

        const result = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-ttl-exact');
        expect(result).toEqual([]); // an exclusive `>` boundary would wrongly keep it
      } finally {
        nowSpy.mockRestore();
      }
    });

    // ── AC-AUTO-6: 256-record global cap ────────────────────────────────────

    it('evicts the single oldest record once the store is at the 256-record cap', async () => {
      for (let i = 0; i < OUTBOUND_JOIN_REQUEST_CAP; i++) {
        await saveOutboundJoinRequest(
          makeRecord({ nonce: `n${i}`, adminPubkeyHex: `admin-${i}`, sentAt: 1000 + i }),
        );
      }
      expect(store.size).toBe(OUTBOUND_JOIN_REQUEST_CAP);

      // One more record over the cap must evict exactly the oldest (n0, sentAt: 1000).
      await saveOutboundJoinRequest(
        makeRecord({ nonce: 'n-overflow', adminPubkeyHex: 'admin-overflow', sentAt: 999_999 }),
      );

      expect(store.size).toBe(OUTBOUND_JOIN_REQUEST_CAP);
      expect(store.has('n0')).toBe(false);
      expect(store.has('n-overflow')).toBe(true);
      expect(store.has('n1')).toBe(true);
    });

    // AC-AUTO-6: eviction drops the record with the minimum `sentAt`, which is
    // NOT necessarily the first-inserted one. The test above fills in ascending
    // sentAt order, so "oldest" and "first-inserted" coincide and it cannot
    // catch an eviction that merely drops the first stored entry. Here the true
    // oldest is planted in the middle of the insertion order.
    it('evicts the record with the minimum sentAt even when it was not inserted first', async () => {
      for (let i = 0; i < OUTBOUND_JOIN_REQUEST_CAP; i++) {
        // Every record is recent (sentAt 5000+i) EXCEPT index 100, the global
        // minimum (sentAt 1) — deliberately not the first-inserted record.
        await saveOutboundJoinRequest(
          makeRecord({
            nonce: `evict-n${i}`,
            adminPubkeyHex: `admin-${i}`,
            sentAt: i === 100 ? 1 : 5000 + i,
          }),
        );
      }
      expect(store.size).toBe(OUTBOUND_JOIN_REQUEST_CAP);

      await saveOutboundJoinRequest(
        makeRecord({ nonce: 'evict-overflow', adminPubkeyHex: 'admin-overflow', sentAt: 999_999 }),
      );

      expect(store.size).toBe(OUTBOUND_JOIN_REQUEST_CAP);
      // The true oldest (evict-n100, sentAt 1) is gone; the first-inserted
      // record (evict-n0, a recent sentAt) survives — a "drop the first entry"
      // eviction would get both of these backwards.
      expect(store.has('evict-n100')).toBe(false);
      expect(store.has('evict-n0')).toBe(true);
      expect(store.has('evict-overflow')).toBe(true);
    });
  });

  describe('deleteOutboundJoinRequest', () => {
    it('removes only the specified record — sibling records survive (AC-AUTO-5)', async () => {
      await saveOutboundJoinRequest(makeRecord({ nonce: 'sibling-1', adminPubkeyHex: 'admin-X', groupName: 'Group A' }));
      await saveOutboundJoinRequest(makeRecord({ nonce: 'sibling-2', adminPubkeyHex: 'admin-X', groupName: 'Group B' }));

      await deleteOutboundJoinRequest('sibling-1');

      const remaining = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-X');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].nonce).toBe('sibling-2');
    });

    it('is a no-op for a non-existent nonce', async () => {
      await expect(deleteOutboundJoinRequest('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('clearAllOutboundJoinRequests', () => {
    it('drops every stored record', async () => {
      await saveOutboundJoinRequest(makeRecord({ nonce: 'a' }));
      await saveOutboundJoinRequest(makeRecord({ nonce: 'b' }));
      await clearAllOutboundJoinRequests();
      expect(store.size).toBe(0);
    });
  });

  // ── Reactive read layer (S2, epic: invite-link-awaiting-landing) ──────────
  //
  // These tests are the first in the file to call `subscribe()`. `subscribe()`
  // kicks off the module's async one-shot initial load exactly once (guarded
  // by a private `_loadStarted` flag that never resets, since this is one
  // module instance for the whole file). Without settling that load before
  // asserting exact listener call counts below, the FIRST subscribe() call in
  // this describe block would race the initial load's own async emit against
  // a test's manual-mutation emit and inflate `toHaveBeenCalledTimes`. This
  // `beforeAll` warms it up once, up front, for every test below.
  describe('reactive read layer', () => {
    beforeAll(async () => {
      const warmup = vi.fn();
      const unsub = subscribe(warmup);
      await new Promise((resolve) => setTimeout(resolve, 0));
      unsub();
    });

    describe('notify-on-mutation', () => {
      it('notifies a subscribed listener on save and on delete', async () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        await saveOutboundJoinRequest(makeRecord({ nonce: 'notify-save' }));
        expect(listener).toHaveBeenCalledTimes(1);

        await deleteOutboundJoinRequest('notify-save');
        expect(listener).toHaveBeenCalledTimes(2);

        unsub();
      });
    });

    describe('silent-after-unsub', () => {
      it('stops notifying a listener once unsubscribed', async () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        await saveOutboundJoinRequest(makeRecord({ nonce: 'pre-unsub' }));
        expect(listener).toHaveBeenCalledTimes(1);

        unsub();

        await saveOutboundJoinRequest(makeRecord({ nonce: 'post-unsub' }));
        expect(listener).toHaveBeenCalledTimes(1); // still 1, not 2
      });
    });

    describe('stable-reference (AC-STORE-1)', () => {
      it('returns the SAME reference across calls with no mutation, and a DIFFERENT one after a mutation', async () => {
        const first = getSnapshot();
        const second = getSnapshot();
        expect(second).toBe(first);

        await saveOutboundJoinRequest(makeRecord({ nonce: 'stable-ref-mutation' }));

        const third = getSnapshot();
        expect(third).not.toBe(first);
      });

      // AC-STORE-1 (identity-preserving side): the whole point of the
      // reference-stability optimisation is to NOT hand useSyncExternalStore a
      // fresh array when nothing actually changed — a new reference forces a
      // spurious re-render of every subscriber. A recompute over an UNCHANGED
      // record set must return the very same object. Deleting a nonce that is
      // not present still runs the delete funnel's recompute, but over a record
      // set identical to the one already cached.
      it('preserves the SAME snapshot reference when a recompute yields identical content', async () => {
        await saveOutboundJoinRequest(makeRecord({ nonce: 'identity-keep', adminPubkeyHex: 'admin-id' }));
        const ref = getSnapshot();

        await deleteOutboundJoinRequest('a-nonce-not-in-the-store');

        expect(getSnapshot()).toBe(ref); // unchanged content -> same reference, no re-render
      });

      // AC-STORE-1 (change-detecting side): when the record set changes to a
      // DIFFERENT set of the SAME length, the snapshot reference must change and
      // the content must be fresh. A same-length swap is the case a per-index
      // nonce comparison exists to catch — a length-only or "any match" check
      // would miss it and leak stale records to subscribers. The underlying
      // store is swapped directly (the file's established white-box idiom) so
      // the recompute's ONLY signal is the content difference, length held at 1.
      it('returns a NEW reference with fresh content when same-length records differ', async () => {
        await saveOutboundJoinRequest(makeRecord({ nonce: 'swap-A', adminPubkeyHex: 'admin-swap' }));
        const ref1 = getSnapshot();
        expect(ref1.map((r) => r.nonce)).toEqual(['swap-A']);

        store.delete('swap-A');
        store.set('swap-B', makeRecord({ nonce: 'swap-B', adminPubkeyHex: 'admin-swap' }));
        await deleteOutboundJoinRequest('a-nonce-not-in-the-store');

        const ref2 = getSnapshot();
        expect(ref2).not.toBe(ref1);
        expect(ref2.map((r) => r.nonce)).toEqual(['swap-B']);
      });

      // AC-STORE-1 (per-record, not any-record): with several records cached,
      // changing exactly ONE of them (length and the other positions held
      // constant) must still register as a change. This is the case that
      // distinguishes an all-positions-match check from an any-position-match
      // one — a sibling that still matches must not mask the record that no
      // longer does.
      it('detects a change when only one of several same-length records differs', async () => {
        await saveOutboundJoinRequest(makeRecord({ nonce: 'multi-A', adminPubkeyHex: 'admin-multi' }));
        await saveOutboundJoinRequest(makeRecord({ nonce: 'multi-B', adminPubkeyHex: 'admin-multi' }));
        const ref1 = getSnapshot();
        expect(ref1.map((r) => r.nonce)).toEqual(['multi-A', 'multi-B']);

        // Rebuild to [multi-A, multi-C] in the same iteration order: position 0
        // still matches, position 1 changed.
        store.clear();
        store.set('multi-A', makeRecord({ nonce: 'multi-A', adminPubkeyHex: 'admin-multi' }));
        store.set('multi-C', makeRecord({ nonce: 'multi-C', adminPubkeyHex: 'admin-multi' }));
        await deleteOutboundJoinRequest('a-nonce-not-in-the-store');

        const ref2 = getSnapshot();
        expect(ref2).not.toBe(ref1);
        expect(ref2.map((r) => r.nonce)).toEqual(['multi-A', 'multi-C']);
      });
    });

    describe('expiry-at-snapshot (AC-STORE-2)', () => {
      it('excludes an expired record from the snapshot at the compute point that persisted it', async () => {
        const expired = makeRecord({
          nonce: 'expired-snapshot',
          adminPubkeyHex: 'admin-snapshot-ttl',
          sentAt: Date.now() - OUTBOUND_JOIN_REQUEST_TTL_MS - 1000,
        });
        // saveOutboundJoinRequest recomputes the snapshot right after
        // persisting — the TTL filter applies at this compute point, so the
        // expired record never surfaces in getSnapshot() even though it is
        // (deliberately) still present in underlying storage.
        await saveOutboundJoinRequest(expired);

        expect(store.has('expired-snapshot')).toBe(true); // still persisted
        expect(getSnapshot().some((r) => r.nonce === 'expired-snapshot')).toBe(false);
      });
    });

    describe('loaded-flag', () => {
      // NOTE ON FEASIBILITY: asserting the false→true transition is not
      // possible from this describe block. `_loaded`/`_loadStarted` are
      // module-level singletons and this file imports the module exactly
      // once (top-of-file `await import(...)`) — by the time this test runs,
      // the `beforeAll` warm-up above (and every save/delete in the tests
      // above it) has already resolved the initial load and set `_loaded =
      // true`, with no exposed reset. The only deterministic assertion
      // available in this shared-module setup is the post-condition: once
      // any operation that guarantees the load has resolved has happened
      // (the warm-up `beforeAll`, or any awaited save/delete), the flag is
      // `true`.
      it('is true once the initial load has resolved', () => {
        expect(isOutboundJoinRequestsLoaded()).toBe(true);
      });
    });

    describe('AC-REACT-1 regression (auto-accept clears reactively)', () => {
      // Store-side proxy for AC-REACT-1 (the UI-level "auto-accept clears the
      // awaiting-landing card reactively" guarantee). This calls
      // deleteOutboundJoinRequest exactly the way welcomeSubscription.ts:553
      // does on a correlated auto-accept — `deleteOutboundJoinRequest(matchedRecord.nonce)`
      // — with zero edits to that file. If a subscribed listener fires from
      // that exact call shape, the auto-accept path is reactive purely via
      // this story's emitter.
      it('fires a subscribed listener when the exact welcomeSubscription.ts auto-accept delete call runs', async () => {
        await saveOutboundJoinRequest(makeRecord({ nonce: 'auto-accept-consumed', adminPubkeyHex: 'admin-auto' }));

        const listener = vi.fn();
        const unsub = subscribe(listener);

        await deleteOutboundJoinRequest('auto-accept-consumed');
        expect(listener).toHaveBeenCalled();

        unsub();
      });
    });

    describe('cancelOutboundJoinRequest (AC-STORE-5)', () => {
      it('delegates to deleteOutboundJoinRequest — removes the record and notifies subscribers', async () => {
        await saveOutboundJoinRequest(
          makeRecord({ nonce: 'cancel-me', adminPubkeyHex: 'admin-cancel' }),
        );

        const listener = vi.fn();
        const unsub = subscribe(listener);

        await cancelOutboundJoinRequest('cancel-me');

        expect(store.has('cancel-me')).toBe(false);
        const remaining = await loadUnexpiredOutboundJoinRequestsForAdmin('admin-cancel');
        expect(remaining).toEqual([]);
        expect(listener).toHaveBeenCalled();

        unsub();
      });
    });

    describe('getServerSnapshot', () => {
      it('returns a stable empty array across calls', () => {
        const a = getServerSnapshot();
        const b = getServerSnapshot();
        expect(a).toEqual([]);
        expect(a).toBe(b);
      });
    });

    // Regression guard (Codex pre-commit review P1): the `loaded` flag MUST be
    // routed through its own useSyncExternalStore in the hook, NOT read plainly
    // via `_loaded`/`isOutboundJoinRequestsLoaded()`. On an EMPTY initial load
    // getSnapshot's array reference is unchanged, so the records subscription
    // alone produces no re-render; only a primitive-boolean `loaded` snapshot
    // makes the false→true flip itself the re-render trigger. A plain read here
    // leaves the Invited banner stuck for a returning user with no prior
    // outbound records. This source-scan asserts the fix's shape survives.
    describe('loaded flag is reactive (P1 regression guard)', () => {
      const src = readFileSync(
        fileURLToPath(new URL('../../../src/hooks/useOutboundJoinRequests.ts', import.meta.url)),
        'utf8',
      );
      const hookBody = src.slice(src.indexOf('export function useOutboundJoinRequests'));
      const hookOnly = hookBody.slice(0, hookBody.indexOf('\n}'));

      it('pipes `loaded` through useSyncExternalStore, not a plain read', () => {
        // Two useSyncExternalStore calls in the hook: one for records, one for loaded.
        const calls = hookOnly.match(/useSyncExternalStore\(/g) ?? [];
        expect(calls.length).toBe(2);
        expect(hookOnly).toContain('getLoadedSnapshot');
        // The hook must NOT resolve `loaded` via the non-reactive accessor.
        expect(hookOnly).not.toContain('isOutboundJoinRequestsLoaded(');
      });
    });
  });
});
