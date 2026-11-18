import 'fake-indexeddb/auto';
import type { MarmotGroup } from '@941design/marmot';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGroupSessionHistory, type GroupSessionHistory } from '@/src/lib/marmot/groupSessionHistory';
import { loadMessages } from '@/src/lib/marmot/chatPersistence';
import { loadMemberProfiles } from '@/src/lib/marmot/groupStorage';
import { createSponsorDeclineMarkerStore } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { getPoll, loadVotes, loadPendingCloseAnnouncements, queuePendingCloseAnnouncement } from '@/src/lib/marmot/pollPersistence';
import { buildImageMessageContent } from '@/src/lib/media/imageMessage';
import { loadReactions } from '@/src/lib/reactions/api';
import * as edits from '@/src/lib/messageEdits/api';
import * as dispatcher from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { HISTORY_SETTLE_TIMEOUT_MS } from '@/src/lib/marmot/history';
import { _resetPendingOwnSends, ownRowStatusOf, registerPendingOwnSend } from '@/src/lib/pendingOwnSends';
import { makeTag } from '../../media/groupMediaFixtures';
import { BOB, ev, historyEntry, installLocalStorage, nextGroupId, SELF, unreadOf } from './realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));

let sessions: GroupSessionHistory[];
beforeEach(() => {
  installLocalStorage();
  _resetPendingOwnSends();
  sessions = [];
});
afterEach(async () => {
  for (const session of sessions) await session.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function make() {
  const groupId = nextGroupId();
  const jobs: (() => Promise<void>)[] = [];
  const send = vi.fn<MarmotGroup['send']>();
  const group = {
    id: groupId,
    members: () => [SELF, BOB],
    admins: [SELF],
    pendingIntents: async () => [],
    send,
  } as unknown as MarmotGroup;
  const sendOwnProfile = vi.fn(async (_groupId: string) => {});
  const onChatChanged = vi.fn();
  const onProfilesChanged = vi.fn();
  const session = createGroupSessionHistory({
    pubkey: SELF,
    groupOf: async (id) => id === groupId ? group : undefined,
    enqueue: (job) => { jobs.push(job); },
    getActiveGroupId: () => null,
    sendOwnProfile,
    onChatChanged,
    onReactionsChanged: vi.fn(),
    onPollsChanged: vi.fn(),
    onProfilesChanged,
    heldGroupIds: () => [groupId],
  });
  sessions.push(session);
  return { ...session, group, groupId, jobs, send, sendOwnProfile, onChatChanged, onProfilesChanged };
}

it('connects the persisted own echo and carrier withdrawals to the same sender tracker and row status port', async () => {
  const session = make();
  const { group, groupId, history, sender, tracker } = session;
  const prepared = sender.prepare(group, 9, 'my message', []);
  registerPendingOwnSend(SELF, {
    id: prepared.id, content: 'my message', senderPubkey: SELF, groupId, createdAt: prepared.rumor.created_at * 1000,
  });
  const echo = (eventId: string) => history.append({
    ...historyEntry(groupId, { eventId, account: SELF }),
    rumor: prepared.rumor,
  });

  await echo('first');
  await echo('second');
  expect(session.onChatChanged).toHaveBeenCalled();
  expect(unreadOf(groupId)).toBe(0);
  await history.withdraw(groupId, ev('second'));
  expect(tracker.statusOf(groupId, prepared.id)).toBe('confirmed');
  await history.withdraw(groupId, ev('first'));
  expect(ownRowStatusOf(SELF, prepared.id)).toBe('failed');
  expect((await loadMessages(groupId)).messages.map((row) => row.id)).toEqual([prepared.id]);
  expect(session.send).not.toHaveBeenCalled();

  const disposing = history.dispose();
  expect(session.dispose()).toBe(disposing);
  await disposing;
  expect(tracker.statusOf(groupId, prepared.id)).toBeUndefined();
});

it('renders one decline when the authenticated sponsor republishes after an interrupted cleanup', async () => {
  const { groupId, history } = make();
  const content = JSON.stringify({
    type: 'invite_lifecycle', event: 'declined', pubkey: BOB, id: `${groupId}:invitee-ref`,
  });
  await history.append(historyEntry(groupId, { eventId: 'decline-one', account: SELF, content }));
  await history.append(historyEntry(groupId, { eventId: 'decline-two', account: SELF, content, at: 1_700_000_001 }));
  const messages = () => loadMessages(groupId).then((result) => result.messages);
  expect(await messages()).toEqual([expect.objectContaining({ content, carrierEventIds: ev('decline-one', 'decline-two') })]);
  await history.withdraw(groupId, ev('decline-one'));
  expect(await messages()).toEqual([expect.objectContaining({ content, carrierEventIds: ev('decline-two') })]);
  await history.withdraw(groupId, ev('decline-two'));
  expect(await messages()).toEqual([]);
});

it('reapplies only sending own reactions during a fold and drops a withdrawn own echo', async () => {
  const { group, groupId, history, sender, tracker } = make();
  const thread = { kind: 'group' as const, groupId };
  const target = 'rumor-target';
  const tags = [['e', target]];
  await history.append(historyEntry(groupId, { eventId: 'target', account: BOB }));
  await history.append(historyEntry(groupId, { eventId: 'peer-reaction', kind: 7, account: BOB, content: '+', tags }));
  const pending = sender.prepare(group, 7, '+', tags);

  await history.withdraw(groupId, ev('peer-reaction'));
  expect((await loadReactions(thread)).map((reaction) => reaction.reactorPubkey)).toEqual([SELF]);
  await history.append({
    ...historyEntry(groupId, { eventId: 'own-reaction', account: SELF }),
    rumor: pending.rumor,
  });
  expect(tracker.pendingSignals(groupId)).toEqual([]);
  await history.withdraw(groupId, ev('own-reaction'));
  expect(await loadReactions(thread)).toEqual([]);
});

it('does not restore withdrawn reactions when a timed-out chat retract resumes with an old snapshot', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let enter!: () => void;
  let resume!: () => void;
  let complete!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pausedWork = new Promise<void>((resolve) => { resume = resolve; });
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  const recomputeSlot = edits.recomputeSlot;
  let paused = false;
  vi.spyOn(edits, 'recomputeSlot').mockImplementation(async (...args) => {
    if (!paused) {
      paused = true;
      enter();
      await pausedWork;
    }
    return recomputeSlot(...args);
  });
  const createDispatch = dispatcher.createGroupRumorDispatch;
  let first = true;
  vi.spyOn(dispatcher, 'createGroupRumorDispatch').mockImplementation((options) => {
    const handlers = createDispatch(options);
    return {
      ...handlers,
      async retract(input) {
        if (!first) return handlers.retract(input);
        first = false;
        try {
          await handlers.retract(input);
        } finally {
          complete();
        }
      },
    };
  });

  const { groupId, history } = make();
  const thread = { kind: 'group' as const, groupId };
  const target = historyEntry(groupId, { eventId: 'target', account: BOB });
  const reaction = (eventId: string, content: string) => historyEntry(groupId, {
    eventId, kind: 7, account: BOB, content, tags: [['e', target.rumor.id]],
  });
  await history.append(target);
  await history.append(reaction('old', '👍'));
  const timedOut = expect(history.withdraw(groupId, [target.eventId])).rejects.toMatchObject({ name: 'HistorySettleTimeoutError' });
  try {
    await entered;
    await vi.advanceTimersByTimeAsync(HISTORY_SETTLE_TIMEOUT_MS);
    await timedOut;

    await history.withdraw(groupId, ev('old'));
    await history.append(target);
    await history.append(reaction('new', '🎉'));
    expect((await loadReactions(thread)).map((row) => row.emoji)).toEqual(['🎉']);
  } finally {
    resume();
  }
  await completed;
  expect((await loadReactions(thread)).map((row) => row.emoji)).toEqual(['🎉']);
});

it('stores the original imeta alongside the parsed group image attachment for decryption', async () => {
  const { groupId, history } = make();
  const full = makeTag({}, ['role full']);
  const thumb = makeTag({ filename: 'thumb.webp' }, ['role thumb']);
  await history.append(historyEntry(groupId, {
    eventId: 'image', account: BOB, content: buildImageMessageContent('image'), tags: [full, thumb],
  }));

  const [row] = (await loadMessages(groupId)).messages;
  expect(row.attachments).toMatchObject({ full: { imeta: full }, thumb: { imeta: thumb } });
});

it('persists delete and poll signals and preserves a pending vote when the poll is recomputed', async () => {
  const { group, groupId, history, sender } = make();
  const append = (input: Omit<Parameters<typeof historyEntry>[1], 'account'>) =>
    history.append(historyEntry(groupId, { ...input, account: BOB }));
  await append({ eventId: 'message' });
  await append({ eventId: 'delete', kind: 5, content: '', tags: [['e', 'rumor-message']] });
  expect((await loadMessages(groupId)).messages[0].tombstoned).toBe(true);
  await history.withdraw(groupId, ev('delete'));
  expect((await loadMessages(groupId)).messages[0].tombstoned).toBeFalsy();

  const pollId = 'poll';
  const vote = JSON.stringify({ pollId, responses: ['a'], seq: 1 });
  await append({
    eventId: 'open', kind: 10,
    content: JSON.stringify({
      id: pollId, title: 'Choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      pollType: 'singlechoice', creatorPubkey: BOB,
    }),
  });
  await append({ eventId: 'peer-vote', kind: 11, content: vote });
  await append({ eventId: 'close', kind: 12, content: JSON.stringify({ pollId, results: [], totalVoters: 0 }) });
  expect(await getPoll(groupId, pollId)).toMatchObject({ closed: true });

  sender.prepare(group, 11, vote, []);
  await history.withdraw(groupId, ev('close', 'peer-vote'));
  expect(await getPoll(groupId, pollId)).toMatchObject({ closed: false });
  expect(await loadVotes(groupId, pollId)).toEqual([expect.objectContaining({ voterPubkey: SELF, responses: ['a'] })]);
});

it.each([SELF, BOB])('announces a join only for its sponsor and still replies to profile requests', async (sponsor) => {
  const session = make();
  const { groupId, history, jobs } = session;
  const signed = finalizeEvent({
    kind: 0, created_at: 1_700_000_000, tags: [],
    content: JSON.stringify({ nickname: 'Invitee', avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' }),
  }, new Uint8Array(32).fill(7));
  const markers = createSponsorDeclineMarkerStore(sponsor);
  await markers.record(groupId, signed.pubkey, 'invite-ref');
  await history.append(historyEntry(groupId, { eventId: 'profile', kind: 0, account: signed.pubkey, content: JSON.stringify(signed) }));
  await history.append(historyEntry(groupId, {
    eventId: 'request', kind: 30, account: BOB,
    content: JSON.stringify({ type: 'profile_request', targetPubkey: SELF, nonce: 'nonce' }),
  }));

  expect(await loadMemberProfiles(groupId)).toEqual([expect.objectContaining({ pubkeyHex: signed.pubkey, nickname: 'Invitee' })]);
  expect(session.onProfilesChanged).toHaveBeenCalled();
  expect(session.send).not.toHaveBeenCalled();
  expect(session.sendOwnProfile).not.toHaveBeenCalled();
  for (const job of jobs) await job();
  if (sponsor === SELF) {
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'application',
      rumor: expect.objectContaining({
        kind: 9,
        content: JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: signed.pubkey }),
      }),
    }));
    expect(await markers.get(groupId, signed.pubkey)).toBeUndefined();
  } else {
    expect(session.send).not.toHaveBeenCalled();
    expect(await markers.get(groupId, signed.pubkey)).toMatchObject({ inviteeRef: 'invite-ref' });
  }
  expect(session.sendOwnProfile).toHaveBeenCalledExactlyOnceWith(groupId);
});


it.each([true, false])('keeps surviving held poll-close carriers across replay (withdraw before open: %s)', async (withdrawBeforeOpen) => {
  const { groupId, history } = make();
  const pollId = 'held-poll';
  const rumorId = 'shared-close';
  const content = JSON.stringify({ type: 'poll_close', pollId, title: 'ignored', results: [], totalVoters: 0 });
  for (const eventId of ['E1', 'E2']) {
    await history.append(historyEntry(groupId, { eventId, rumorId, account: BOB, content }));
  }
  const pending = () => loadPendingCloseAnnouncements(groupId, pollId);
  expect((await pending()).map((row) => row.carrierEventId)).toEqual(ev('E1', 'E2'));
  if (withdrawBeforeOpen) {
    await history.withdraw(groupId, ev('E1'));
    expect((await pending()).map((row) => row.carrierEventId)).toEqual(ev('E2'));
  }
  await history.append(historyEntry(groupId, {
    eventId: 'open', kind: 10, account: BOB,
    content: JSON.stringify({ id: pollId, title: 'Choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], pollType: 'singlechoice', creatorPubkey: BOB }),
  }));
  const messages = async () => (await loadMessages(groupId)).messages.filter((row) => row.id === rumorId);
  expect(await pending()).toEqual([]);
  expect(await messages()).toEqual([expect.objectContaining({ carrierEventIds: ev(...(withdrawBeforeOpen ? ['E2'] : ['E1', 'E2'])) })]);
  if (!withdrawBeforeOpen) {
    await history.withdraw(groupId, ev('E1'));
    expect(await messages()).toEqual([expect.objectContaining({ carrierEventIds: ev('E2') })]);
  }
  await history.withdraw(groupId, ev('E2'));
  expect(await messages()).toEqual([]);
});

it('replays legacy held poll-close announcements without a carrier', async () => {
  const { groupId, history } = make();
  const pollId = 'legacy-held-poll';
  await queuePendingCloseAnnouncement({ groupId, pollId, senderPubkey: BOB, rumorId: 'legacy-close', createdAt: 1_700_000_000 });
  await history.append(historyEntry(groupId, {
    eventId: 'open', kind: 10, account: BOB,
    content: JSON.stringify({ id: pollId, title: 'Choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], pollType: 'singlechoice', creatorPubkey: BOB }),
  }));
  expect((await loadMessages(groupId)).messages).toEqual([expect.objectContaining({ id: 'legacy-close' })]);
  expect(await loadPendingCloseAnnouncements(groupId, pollId)).toEqual([]);
});


it('upgrades a legacy held announcement when the same rumor is redelivered with carriers', async () => {
  const { groupId, history } = make();
  const pollId = 'upgrade-held-poll';
  const rumorId = 'upgrade-close';
  await queuePendingCloseAnnouncement({ groupId, pollId, senderPubkey: BOB, rumorId, createdAt: 1_700_000_000 });
  const content = JSON.stringify({ type: 'poll_close', pollId, title: 'ignored', results: [], totalVoters: 0 });
  for (const eventId of ['E1', 'E2']) await history.append(historyEntry(groupId, { eventId, rumorId, account: BOB, content }));
  expect((await loadPendingCloseAnnouncements(groupId, pollId)).map((row) => row.carrierEventId)).toEqual(ev('E1', 'E2'));
  await history.append(historyEntry(groupId, {
    eventId: 'open', kind: 10, account: BOB,
    content: JSON.stringify({ id: pollId, title: 'Choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], pollType: 'singlechoice', creatorPubkey: BOB }),
  }));
  await history.withdraw(groupId, ev('E1'));
  expect((await loadMessages(groupId)).messages).toEqual([expect.objectContaining({ id: rumorId, carrierEventIds: ev('E2') })]);
});
