import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

// Mock idb-keyval — in-memory store
const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => store.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  del: vi.fn(async (key: string) => { store.delete(key); }),
  keys: vi.fn(async () => [...store.keys()]),
  entries: vi.fn(async () => [...store.entries()]),
}));

const {
  createJoinRequestStore,
  savePendingJoinRequest,
  loadPendingJoinRequests,
  deletePendingJoinRequest,
  clearPendingJoinRequestsForGroup,
} = await import('@/src/lib/marmot/joinRequestStorage');

function makeRequest(overrides: Partial<PendingJoinRequest> = {}): PendingJoinRequest {
  return {
    pubkeyHex: 'pk-requester-1',
    nonce: 'nonce-1',
    groupId: 'group-1',
    receivedAt: Date.now(),
    nickname: undefined,
    eventId: 'evt-1',
    ...overrides,
  };
}

describe('joinRequestStorage', () => {
  beforeEach(() => {
    store.clear();
  });

  describe('createJoinRequestStore', () => {
    it('returns a store reference', () => {
      const s = createJoinRequestStore();
      expect(s).toBe('mock-store');
    });
  });

  describe('savePendingJoinRequest', () => {
    it('persists a join request keyed by eventId', async () => {
      const req = makeRequest();
      await savePendingJoinRequest(req);
      expect(store.has(req.eventId)).toBe(true);
      expect(store.get(req.eventId)).toEqual(req);
    });
  });

  describe('savePendingJoinRequest deduplication', () => {
    it('is a no-op if same pubkeyHex + groupId already exists', async () => {
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-1', pubkeyHex: 'pk-1', groupId: 'g-1' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-2', pubkeyHex: 'pk-1', groupId: 'g-1' }));

      // Only the first one should be stored
      expect(store.has('evt-1')).toBe(true);
      expect(store.has('evt-2')).toBe(false);
    });

    it('allows same pubkey in different groups', async () => {
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-1', pubkeyHex: 'pk-1', groupId: 'g-1' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-2', pubkeyHex: 'pk-1', groupId: 'g-2' }));

      expect(store.has('evt-1')).toBe(true);
      expect(store.has('evt-2')).toBe(true);
    });

    it('allows different pubkeys in same group', async () => {
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-1', pubkeyHex: 'pk-1', groupId: 'g-1' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'evt-2', pubkeyHex: 'pk-2', groupId: 'g-1' }));

      expect(store.has('evt-1')).toBe(true);
      expect(store.has('evt-2')).toBe(true);
    });
  });

  describe('loadPendingJoinRequests', () => {
    it('returns empty array when no requests exist', async () => {
      const result = await loadPendingJoinRequests('group-1');
      expect(result).toEqual([]);
    });

    it('returns only requests for the specified group', async () => {
      await savePendingJoinRequest(makeRequest({ eventId: 'e1', pubkeyHex: 'pk-1', groupId: 'group-1' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'e2', pubkeyHex: 'pk-2', groupId: 'group-2' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'e3', pubkeyHex: 'pk-3', groupId: 'group-1' }));

      const result = await loadPendingJoinRequests('group-1');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.eventId).sort()).toEqual(['e1', 'e3']);
    });
  });

  describe('deletePendingJoinRequest', () => {
    it('removes an existing request by eventId', async () => {
      await savePendingJoinRequest(makeRequest());
      await deletePendingJoinRequest('evt-1');
      expect(store.has('evt-1')).toBe(false);
    });

    it('is a no-op for non-existent eventId', async () => {
      await deletePendingJoinRequest('nonexistent');
      // No error thrown
    });
  });

  describe('clearPendingJoinRequestsForGroup', () => {
    it('removes all requests for the specified group', async () => {
      await savePendingJoinRequest(makeRequest({ eventId: 'e1', pubkeyHex: 'pk-1', groupId: 'group-1' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'e2', pubkeyHex: 'pk-2', groupId: 'group-2' }));
      await savePendingJoinRequest(makeRequest({ eventId: 'e3', pubkeyHex: 'pk-3', groupId: 'group-1' }));

      await clearPendingJoinRequestsForGroup('group-1');

      expect(store.has('e1')).toBe(false);
      expect(store.has('e3')).toBe(false);
      expect(store.has('e2')).toBe(true); // group-2 untouched
    });

    it('is a no-op for group with no requests', async () => {
      await clearPendingJoinRequestsForGroup('nonexistent');
      // No error thrown
    });
  });
});
