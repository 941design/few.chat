import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Poll, PollVote } from '@/src/lib/marmot/pollPersistence';

// Mock idb-keyval — in-memory store
const store = mapBacking;
const { mapTxnStore, mapBacking, realPromisifyRequest, txnFaults } = await vi.hoisted(async () => {
  const { callableMapStore } = await import('../helpers/callableMapStore');
  const { promisifyRequest } = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
  // Faults for the read-check-write transactions (pollPersistence pollTxn).
  const txnFaults = { failGet: null as null | ((key: string) => boolean), failCommit: null as null | (() => boolean) };
  const map = new Map<string, unknown>();
  return {
    txnFaults,
    realPromisifyRequest: promisifyRequest,
    mapBacking: map,
    mapTxnStore: callableMapStore(map, {
      clone: true,
      failGet: (k) => txnFaults.failGet?.(k) ?? false,
      failCommit: () => txnFaults.failCommit?.() ?? false,
    }),
  };
});
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => mapTxnStore),
  promisifyRequest: realPromisifyRequest,
  get: vi.fn(async (key: string) => store.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  del: vi.fn(async (key: string) => { store.delete(key); }),
  keys: vi.fn(async () => [...store.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => store.delete(k)); }),
}));

// Import after mock is set up
const {
  loadPolls,
  savePoll,
  getPoll,
  loadVotes,
  saveVoteIfNewer,
  clearPollData,
} = await import('@/src/lib/marmot/pollPersistence');

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 'poll-1',
    groupId: 'group-1',
    title: 'Test poll',
    options: [
      { id: 'A', label: 'Option A' },
      { id: 'B', label: 'Option B' },
    ],
    pollType: 'singlechoice',
    creatorPubkey: 'pk-creator',
    createdAt: 1000,
    closed: false,
    ...overrides,
  };
}

function makeVote(overrides: Partial<PollVote> = {}): PollVote {
  return {
    id: 'poll-1:pk-voter',
    groupId: 'group-1',
    pollId: 'poll-1',
    voterPubkey: 'pk-voter',
    responses: ['A'],
    votedAt: 2000,
    ...overrides,
  };
}

describe('pollPersistence', () => {
  beforeEach(() => {
    store.clear();
  });

  describe('loadPolls', () => {
    it('returns empty array when no polls exist', async () => {
      const polls = await loadPolls('group-1');
      expect(polls).toEqual([]);
    });

    it('returns polls sorted newest-first', async () => {
      await savePoll(makePoll({ id: 'p1', createdAt: 100 }));
      await savePoll(makePoll({ id: 'p2', createdAt: 300 }));
      await savePoll(makePoll({ id: 'p3', createdAt: 200 }));
      const polls = await loadPolls('group-1');
      expect(polls.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    });
  });

  describe('savePoll', () => {
    it('persists a new poll', async () => {
      await savePoll(makePoll());
      const polls = await loadPolls('group-1');
      expect(polls).toHaveLength(1);
      expect(polls[0].title).toBe('Test poll');
    });

    it('upserts existing poll by id', async () => {
      await savePoll(makePoll({ title: 'Original' }));
      await savePoll(makePoll({ title: 'Updated' }));
      const polls = await loadPolls('group-1');
      expect(polls).toHaveLength(1);
      expect(polls[0].title).toBe('Updated');
    });

    it('stores multiple polls for the same group', async () => {
      await savePoll(makePoll({ id: 'p1' }));
      await savePoll(makePoll({ id: 'p2' }));
      const polls = await loadPolls('group-1');
      expect(polls).toHaveLength(2);
    });
  });

  describe('getPoll', () => {
    it('returns null for non-existent poll', async () => {
      const poll = await getPoll('group-1', 'nonexistent');
      expect(poll).toBeNull();
    });

    it('returns the matching poll', async () => {
      await savePoll(makePoll({ id: 'target', title: 'Found it' }));
      const poll = await getPoll('group-1', 'target');
      expect(poll).not.toBeNull();
      expect(poll!.title).toBe('Found it');
    });
  });

  describe('loadVotes / saveVoteIfNewer', () => {
    it('returns empty array when no votes exist', async () => {
      const votes = await loadVotes('group-1', 'poll-1');
      expect(votes).toEqual([]);
    });

    it('persists a vote', async () => {
      await saveVoteIfNewer(makeVote());
      const votes = await loadVotes('group-1', 'poll-1');
      expect(votes).toHaveLength(1);
      expect(votes[0].responses).toEqual(['A']);
    });

    it('replaces existing vote by compound key', async () => {
      await saveVoteIfNewer(makeVote({ responses: ['A'] }));
      await saveVoteIfNewer(makeVote({ responses: ['B'], votedAt: 3000 }));
      const votes = await loadVotes('group-1', 'poll-1');
      expect(votes).toHaveLength(1);
      expect(votes[0].responses).toEqual(['B']);
    });

    it('stores votes from different voters', async () => {
      await saveVoteIfNewer(makeVote({ id: 'poll-1:voter1', voterPubkey: 'voter1' }));
      await saveVoteIfNewer(makeVote({ id: 'poll-1:voter2', voterPubkey: 'voter2' }));
      const votes = await loadVotes('group-1', 'poll-1');
      expect(votes).toHaveLength(2);
    });
  });

  describe('clearPollData', () => {
    it('removes all polls and votes for a group', async () => {
      await savePoll(makePoll({ id: 'p1' }));
      await savePoll(makePoll({ id: 'p2' }));
      await saveVoteIfNewer(makeVote({ id: 'p1:v', pollId: 'p1' }));
      await saveVoteIfNewer(makeVote({ id: 'p2:v', pollId: 'p2' }));

      await clearPollData('group-1');

      expect(await loadPolls('group-1')).toEqual([]);
      expect(await loadVotes('group-1', 'p1')).toEqual([]);
      expect(await loadVotes('group-1', 'p2')).toEqual([]);
    });

    it('is a no-op for non-existent group', async () => {
      await clearPollData('nonexistent');
      // No error thrown
    });
  });
});
