// @vitest-environment node
/**
 * One clock for dispatch and recompute: the history row's `receivedAt`.
 *
 *  - delete/edit slots: `applyDeleteEditSignal(..., {receivedAt})` classifies (rev cap) with the row's time, exactly
 *    as `recomputeSlot` folds the same row; a LATE (recovered) dispatch therefore equals the oracle
 *  - polls: a sink dispatch stamps its vote / held vote / held close from the row's time through the receipt clock
 *    port, the clock `recomputePoll` folds with, never from the wall clock of the late moment
 *
 * Real collaborators for the oracle case: chatPersistence, messageEdits/api, the sink and dispatcher (realApp.ts).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import * as edits from '@/src/lib/messageEdits/api';
import * as polls from '@/src/lib/marmot/pollPersistence';
import { createHistoryBackend, createIdbHistoryStore } from '@/src/lib/marmot/history';
import {
  createPollCloseGroupHandler,
  createPollVoteGroupHandler,
  type PollGroupHandlerDeps,
} from '@/src/lib/marmot/handlers/pollHandler';
import { POLL_CLOSE_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import { ALICE, BOB, buildRealApp, installLocalStorage, nextGroupId, type RealApp } from './realApp';
import { append, expectOracle } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  await edits.clearAllMessageEditsState();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps) await app.sink.dispose();
});

const T = 1_800_000_000; // seconds
const setNow = (sec: number) => vi.setSystemTime(new Date(sec * 1000));

describe('applyDeleteEditSignal: the row clock classifies the signal', () => {
  const baseRow = (groupId: string): chat.ChatMessage => ({ id: 'm1', content: 'orig', senderPubkey: ALICE, groupId, createdAt: (T - 100) * 1000 });
  const deleteRumor = (createdAt: number) => ({ id: 'del1', pubkey: ALICE, created_at: createdAt, kind: 5, tags: [['e', 'm1']], content: '' });

  it('caps a far-future rev against the ROW\'s time, not against the wall clock of a late dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const g = nextGroupId();
    await chat.appendMessage(g, baseRow(g));
    setNow(T + 20 * 3600); // the dispatch runs 20 h late ...
    const far = T + 10 * 3600; // ... for a signal stamped 10 h after the row was received
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: g }, deleteRumor(far), { pubkey: ALICE, authenticity: 'mls' }, { receivedAt: T * 1000 });
    const row = (await chat.loadMessages(g)).messages.find((m) => m.id === 'm1');
    expect(row?.rev).toBe(T + edits.MAX_REV_SKEW_SECONDS);
  });

  it('without a row clock the wall clock decides (a live own signal, the DM path)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const g = nextGroupId();
    await chat.appendMessage(g, baseRow(g));
    setNow(T + 20 * 3600);
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: g }, deleteRumor(T + 10 * 3600), { pubkey: ALICE, authenticity: 'mls' });
    expect((await chat.loadMessages(g)).messages.find((m) => m.id === 'm1')?.rev).toBe(T + 10 * 3600);
  });
});

describe('a late-dispatched (recovered) row equals the oracle', () => {
  it('an edit with a far-future rev, dispatched 10 h after it was received, is capped like the oracle and like a recompute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setNow(T);
    const app = make();
    const base = app.entry({ eventId: 'eb', account: ALICE, rumorId: 'm1', content: 'orig', at: T - 100 });
    const far = T + 8 * 3600; // 2 h inside the cap of a dispatch at T + 10 h, 2 h beyond the cap at T + 6 h
    const lateEdit = app.entry({
      eventId: 'e1',
      kind: 9,
      account: ALICE,
      rumorId: 'edit1',
      content: 'v1',
      tags: [['e', 'm1', '', 'edit'], ['rev', String(far)]],
      at: far,
    });
    await app.sink.append(base);

    // the edit row was received at T but its dispatch did not complete: it is recovered 10 h later by a new sink
    const dbName = `s5-${app.groupId}`;
    const store = createIdbHistoryStore(dbName);
    await store.putRow({ entry: lateEdit, seq: await store.nextSeq(app.groupId), dispatched: false, receivedAt: T * 1000 });
    setNow(T + 10 * 3600);
    const restarted = createHistoryBackend({ handlers: app.dispatcher, store: createIdbHistoryStore(dbName) });
    expect(await restarted.sweep()).toEqual({ redispatched: 1, failed: 0 });
    expect((await app.messages()).find((m) => m.id === 'm1')?.rev).toBe(T + edits.MAX_REV_SKEW_SECONDS);

    setNow(T); // the oracle receives its rows at the original time
    await expectOracle(app, [append(base), append(lateEdit)], make);
    await restarted.dispose();
  });
});

// ---- polls ---------------------------------------------------------------------------------------------------------

const POLL = 'poll-1';
const env = { selfPubkeyHex: ALICE, getActiveGroupId: () => null };
const pollInput = (kind: number, content: string, receivedAt?: number) => ({
  groupId: nextGroupId(),
  eventId: 'e1',
  sender: BOB,
  rumor: { id: 'r1', pubkey: BOB, created_at: 1_700_000_000, kind, tags: [], content },
  ...(receivedAt !== undefined ? { receivedAt } : {}),
});

function pollDeps(over: Partial<PollGroupHandlerDeps> = {}) {
  const deps = {
    savePoll: vi.fn(async (p) => p),
    saveVoteIfNewer: vi.fn(async () => true),
    getPoll: vi.fn(async () => null),
    loadVotes: vi.fn(async () => []),
    queuePendingVote: vi.fn(async () => true),
    loadPendingVotes: vi.fn(async () => []),
    removePendingVotes: vi.fn(async () => undefined),
    queuePendingClose: vi.fn(async () => undefined),
    loadPendingCloses: vi.fn(async () => []),
    removePendingCloses: vi.fn(async () => undefined),
    setPollVersion: vi.fn(),
    recomputePoll: vi.fn(async () => false),
    receiptNow: vi.fn(async (atLeast: number) => atLeast + 7),
    replayHeldCloseAnnouncements: vi.fn(async () => undefined),
    ...over,
  } satisfies PollGroupHandlerDeps;
  return deps;
}
const openPoll = { id: POLL, groupId: 'g', title: 't', description: '', options: [{ id: 'A', label: 'A' }], pollType: 'singlechoice', creatorPubkey: ALICE, createdAt: 1, closed: false };
const voteContent = JSON.stringify({ pollId: POLL, responses: ['A'], seq: 1 });
const closeContent = JSON.stringify({ pollId: POLL, results: [], totalVoters: 0 });

describe('a sink poll dispatch stamps from the row clock (receipt clock port)', () => {
  it('a stored vote gets receiptNow(row time) as its receipt time', async () => {
    const deps = pollDeps({ getPoll: vi.fn(async () => openPoll as never) });
    await createPollVoteGroupHandler(deps).dispatch(pollInput(POLL_VOTE_KIND, voteContent, 5_000), env);
    expect(deps.receiptNow).toHaveBeenCalledWith(5_000);
    expect(deps.saveVoteIfNewer).toHaveBeenCalledWith(expect.objectContaining({ receivedAt: 5_007 }), undefined);
  });

  it('a held vote (poll not stored yet) is queued with the row-clock stamp', async () => {
    const deps = pollDeps();
    await createPollVoteGroupHandler(deps).dispatch(pollInput(POLL_VOTE_KIND, voteContent, 5_000), env);
    expect(deps.queuePendingVote).toHaveBeenCalledWith(expect.objectContaining({ pollId: POLL }), 5_007);
  });

  it('a held close (poll not stored yet) is queued with the row-clock stamp', async () => {
    const deps = pollDeps();
    await createPollCloseGroupHandler(deps).dispatch(pollInput(POLL_CLOSE_KIND, closeContent, 5_000), env);
    expect(deps.queuePendingClose).toHaveBeenCalledWith(expect.objectContaining({ pollId: POLL }), 5_007);
  });

  it('an input without a row clock keeps the store\'s own stamping (no receipt clock call, no stamp)', async () => {
    const deps = pollDeps();
    await createPollVoteGroupHandler(deps).dispatch(pollInput(POLL_VOTE_KIND, voteContent), env);
    expect(deps.receiptNow).not.toHaveBeenCalled();
    expect(deps.queuePendingVote).toHaveBeenCalledWith(expect.objectContaining({ pollId: POLL }));
    expect(vi.mocked(deps.queuePendingVote).mock.calls[0]).toHaveLength(1);
  });
});

describe('pollPersistence.receiptNow(atLeast)', () => {
  it('stamps no lower than the floor, never repeats, and never goes below the previous stamp', async () => {
    const floor = Date.now() + 5_000;
    const a = await polls.receiptNow(floor);
    expect(a).toBeGreaterThanOrEqual(floor);
    expect(await polls.receiptNow(1)).toBe(a + 1); // an old row time does not pull the clock back
    expect(await polls.receiptNow(floor)).toBe(a + 2);
  });
});
