import 'fake-indexeddb/auto';
import { EventEmitter } from 'node:events';
import { clear } from 'idb-keyval';
import { afterEach, expect, it, vi } from 'vitest';
import { createDispatcher, type DispatcherSubscription } from '@/src/lib/marmot/applicationRumorDispatcher';
import { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler } from '@/src/lib/marmot/handlers/pollHandler';
import { getPoll, loadVotes, savePoll, saveVoteIfNewer, queuePendingVote, loadPendingVotes, removePendingVotes } from '@/src/lib/marmot/pollPersistence';

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)),
}));

const subscriptions: DispatcherSubscription[] = [];
afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) {
    subscription();
    await subscription.drain();
  }
  await clear();
  vi.restoreAllMocks();
});

const pubkey = 'aa'.repeat(32);
const ctx = (groupId = 'group') => ({ groupId, selfPubkeyHex: pubkey, getActiveGroupId: () => null });
function emit(group: EventEmitter, kind: number, id: string, content: unknown = {}) {
  group.emit('authenticatedApplicationMessage', {
    message: new TextEncoder().encode(JSON.stringify({ id, kind, pubkey, created_at: 123, tags: [], content: JSON.stringify(content) })),
    senderPubkey: pubkey, senderLeafIndex: 0,
  });
}
function pollFixture() {
  const deps = { getPoll, loadVotes, savePoll, saveVoteIfNewer, queuePendingVote, loadPendingVotes, removePendingVotes, setPollVersion: vi.fn() };
  const group = new EventEmitter();
  const subscription = createDispatcher([
    createPollOpenHandler(deps), createPollVoteHandler(deps), createPollCloseHandler(deps),
  ]).subscribe(group, ctx());
  subscriptions.push(subscription);
  return { group, subscription };
}
const open = { id: 'poll', title: 'Question', options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], pollType: 'singlechoice', creatorPubkey: pubkey };
const vote = { pollId: 'poll', responses: ['A'] };

it('persists synchronous open → vote → close emissions in order, including duplicate overlap', async () => {
  const { group, subscription } = pollFixture();
  emit(group, 10, 'open', open);
  emit(group, 11, 'vote', vote);
  emit(group, 11, 'vote', vote);
  emit(group, 12, 'close', { pollId: 'poll', results: [], totalVoters: 0 });
  await subscription.drain();
  expect(await loadVotes('group', 'poll')).toHaveLength(1);
  expect(await getPoll('group', 'poll')).toMatchObject({ closed: true, totalVoters: 1, results: [{ optionId: 'A', count: 1 }, { optionId: 'B', count: 0 }] });
});

it('recovers a vote that arrived before its poll (AC-9 early-vote queue, real IndexedDB)', async () => {
  const { group, subscription } = pollFixture();
  emit(group, 11, 'vote', vote);
  emit(group, 10, 'open', open);
  emit(group, 12, 'close', { pollId: 'poll', results: [], totalVoters: 0 });
  await subscription.drain();
  expect(await loadVotes('group', 'poll')).toHaveLength(1);
  expect(await getPoll('group', 'poll')).toMatchObject({ closed: true, totalVoters: 1 });
});

it('isolates handler failure without retrying already attempted side effects or poisoning later messages', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const seen: string[] = [];
  const dispatcher = createDispatcher([
    { kind: 9, handle: () => { throw new Error('write failed'); } },
    { kind: 9, handle: (rumor) => { seen.push(rumor.id); } },
  ]);
  const group = new EventEmitter();
  const subscription = dispatcher.subscribe(group, ctx());
  subscriptions.push(subscription);
  emit(group, 9, 'one');
  emit(group, 9, 'one');
  emit(group, 9, 'two');
  await subscription.drain();
  expect(seen).toEqual(['one', 'two']);
});

it('keeps groups independent and drops queued work on disposal while drain awaits the running handler', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const dispatcher = createDispatcher([{ kind: 9, handle: async (rumor) => {
    if (rumor.id === 'slow') await blocked;
    seen.push(rumor.id);
  } }]);
  const groupA = new EventEmitter();
  const groupB = new EventEmitter();
  const a = dispatcher.subscribe(groupA, ctx('A'));
  const b = dispatcher.subscribe(groupB, ctx('B'));
  subscriptions.push(a, b);
  try {
    emit(groupA, 9, 'slow');
    emit(groupA, 9, 'queued');
    await Promise.resolve(); // slow handler has entered its wait
    emit(groupB, 9, 'independent');
    await b.drain();
    expect(seen).toEqual(['independent']);
    a();
    expect(groupA.listenerCount('authenticatedApplicationMessage')).toBe(0);
    let drained = false;
    const draining = a.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(seen).toEqual(['independent', 'slow']);
  } finally {
    release();
  }
});
