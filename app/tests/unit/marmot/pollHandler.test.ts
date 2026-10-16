/**
 * Unit tests for handlers/pollHandler.ts
 *
 * Covers AC-AR-15, AC-AR-20.
 *
 * Design: tests call createPoll*Handler with vi.fn() spies injected as deps,
 * then call handler.handle() directly. Duplicate-id test uses the dispatcher
 * LRU layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── idb-keyval mock (Map-backed) ───────────────────────────────────────────
const idbStore = mapBacking;
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
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

// ─── @internet-privacy/marmot-ts mock ────────────────────────────────────────
let mockRumor: ReturnType<typeof makePollOpenRumor> | null = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler } = await import('@/src/lib/marmot/handlers/pollHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND } = await import('@/src/lib/marmot/pollSync');
// Real storage layer (AC-XCUT-2 duplication test, epic: group-message-author-auth-app-layer
// S9) — exercises the actual upsert-by-id behavior of saveVoteIfNewer/loadVotes against the
// idb-keyval mock above, rather than a hand-fabricated votes array.
const { saveVoteIfNewer: realSaveVote, loadVotes: realLoadVotes } = await import('@/src/lib/marmot/pollPersistence');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CREATOR_PUBKEY = 'aa'.repeat(32);
const VOTER_PUBKEY = 'bb'.repeat(32);
const SELF_PUBKEY = 'cc'.repeat(32);
const FORGED_PAYLOAD_CREATOR = 'ff'.repeat(32);
const VOTER_A = '11'.repeat(32);
const VOTER_B = '22'.repeat(32);
const VOTER_C = '33'.repeat(32);
const GROUP_ID = 'group-poll-test';
const POLL_ID = 'poll-id-1';

function makePollOpenRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({
    id: POLL_ID,
    title: 'Best color?',
    options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }],
    pollType: 'singlechoice',
    creatorPubkey: CREATOR_PUBKEY,
  });
  return {
    id: 'poll-open-' + 'ff'.repeat(28),
    pubkey: CREATOR_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: POLL_OPEN_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makePollVoteRumor(pollId = POLL_ID, overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
}> = {}) {
  return {
    id: 'poll-vote-' + 'ee'.repeat(28),
    pubkey: VOTER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: POLL_VOTE_KIND,
    content: JSON.stringify({ pollId, responses: ['A'] }),
    tags: [] as string[][],
    ...overrides,
  };
}

function makePollCloseRumor(pubkey = CREATOR_PUBKEY, overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
}> = {}) {
  return {
    id: 'poll-close-' + 'dd'.repeat(27),
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: POLL_CLOSE_KIND,
    content: JSON.stringify({
      pollId: POLL_ID,
      results: [{ optionId: 'A', label: 'Red', count: 2 }],
      totalVoters: 2,
    }),
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx() {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex: SELF_PUBKEY,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
function makeSender(pubkey: string): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

/** Build a mock poll for getPoll to return. */
function makeStoredPoll(closed = false) {
  return {
    id: POLL_ID,
    groupId: GROUP_ID,
    title: 'Best color?',
    options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }],
    pollType: 'singlechoice' as const,
    creatorPubkey: CREATOR_PUBKEY,
    createdAt: Date.now(),
    closed,
  };
}

/** Build a PollVote row for injection via the `loadVotes` deps spy (AC-POLL-4). */
function makeStoredVote(voterPubkey: string, responses: string[]) {
  return {
    id: `${POLL_ID}:${voterPubkey}`,
    groupId: GROUP_ID,
    pollId: POLL_ID,
    voterPubkey,
    responses,
    votedAt: Date.now(),
  };
}

function makeDeps(
  storedPoll: ReturnType<typeof makeStoredPoll> | null = null,
  votes: ReturnType<typeof makeStoredVote>[] = [],
) {
  return {
    savePoll: vi.fn(async () => {}),
    saveVoteIfNewer: vi.fn(async () => {}),
    getPoll: vi.fn(async () => storedPoll),
    // AC-POLL-4: injected like getPoll/savePoll — the handler reads stored
    // votes exclusively through this deps bag, never a direct storage import.
    loadVotes: vi.fn(async () => votes),
    queuePendingVote: vi.fn(async () => {}),
    loadPendingVotes: vi.fn(async () => [] as import('@/src/lib/marmot/pollPersistence').PendingPollVote[]),
    removePendingVotes: vi.fn(async () => {}),
    queuePendingClose: vi.fn(async () => {}),
    loadPendingCloses: vi.fn(async () => [] as import('@/src/lib/marmot/pollPersistence').PendingPollClose[]),
    removePendingCloses: vi.fn(async () => {}),
    setPollVersion: vi.fn(),
  };
}

/** Deps-bag fragment for the AC-9 early-vote queue (no queued votes). */
const noQueue = () => ({
  queuePendingVote: vi.fn(async () => {}),
  loadPendingVotes: vi.fn(async () => []),
  removePendingVotes: vi.fn(async () => {}),
  queuePendingClose: vi.fn(async () => {}),
  loadPendingCloses: vi.fn(async () => []),
  removePendingCloses: vi.fn(async () => {}),
});

// S3 (marmot-ts 0.7.0 authenticated-sender migration): the dispatcher now
// registers TWO listeners — 'authenticatedApplicationMessage' (message-
// carrying) and 'unauthenticatedMessage' (diagnostic-only, AC-OBS-1). A
// single shared `listener` variable would be silently overwritten by the
// second .on() call; listeners are tracked per event name instead. emit()
// passes the payload shape the dispatcher now expects
// ({message, senderPubkey, senderLeafIndex}), with senderPubkey sourced from
// the currently-configured mockRumor so the dispatcher's sender-vs-rumor
// choke-point trivially matches (mirroring the old fallback sender).
function makeFakeGroup() {
  const listeners = new Map<string, (payload: never) => void | Promise<void>>();
  return {
    on: vi.fn((event: string, fn: (payload: never) => void | Promise<void>) => { listeners.set(event, fn); }),
    off: vi.fn((event: string, _fn: (payload: never) => void | Promise<void>) => { listeners.delete(event); }),
    async emit() {
      const fn = listeners.get('authenticatedApplicationMessage');
      if (fn) await fn({ message: new Uint8Array(), senderPubkey: mockRumor?.pubkey ?? '', senderLeafIndex: 0 } as never);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
  mockRumor = null;
});

// ---- POLL_OPEN ---------------------------------------------------------------

describe('pollHandler / POLL_OPEN', () => {
  it('happy-path: savePoll called with correct shape, setPollVersion bumped', async () => {
    const deps = makeDeps();
    const handler = createPollOpenHandler(deps);
    const rumor = makePollOpenRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.id).toBe(POLL_ID);
    expect(savedPoll.groupId).toBe(GROUP_ID);
    expect(savedPoll.title).toBe('Best color?');
    expect(savedPoll.creatorPubkey).toBe(CREATOR_PUBKEY);
    expect(savedPoll.closed).toBe(false);
    expect(savedPoll.createdAt).toBe(rumor.created_at * 1000);
    expect(deps.setPollVersion).toHaveBeenCalledOnce();
  });

  it('malformed payload: does not throw, no deps called', async () => {
    const deps = makeDeps();
    const handler = createPollOpenHandler(deps);
    const rumor = makePollOpenRumor({ content: '{ bad }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.savePoll).not.toHaveBeenCalled();
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('duplicate-id: dispatcher LRU prevents second savePoll call', async () => {
    const deps = makeDeps();
    const handler = createPollOpenHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makePollOpenRumor({ id: 'dup-open-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    expect(deps.savePoll).toHaveBeenCalledOnce();
  });

  // ─── AC-POLL-1 (epic: group-message-author-auth-app-layer S5) ──────────────

  it('AC-POLL-1: stored creatorPubkey is bound to sender.pubkey, ignoring payload.creatorPubkey entirely', async () => {
    const deps = makeDeps();
    const handler = createPollOpenHandler(deps);
    // payload.creatorPubkey (X) diverges from both rumor.pubkey and the
    // authenticated sender (Y) — the strongest possible forgery attempt.
    const rumor = makePollOpenRumor({
      pubkey: FORGED_PAYLOAD_CREATOR,
      content: JSON.stringify({
        id: POLL_ID,
        title: 'Best color?',
        options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }],
        pollType: 'singlechoice',
        creatorPubkey: FORGED_PAYLOAD_CREATOR, // X — self-asserted, must be ignored
      }),
    });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(SELF_PUBKEY)); // Y — the authenticated opener

    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.creatorPubkey).toBe(SELF_PUBKEY);
    expect(savedPoll.creatorPubkey).not.toBe(FORGED_PAYLOAD_CREATOR);
  });

  // ─── F2 (Fable Stage-2 review, epic: group-message-author-auth-app-layer
  // S5): first-open-wins — a re-open of an existing pollId is dropped ──────

  it('F2: a second poll_open reusing an existing pollId from a different sender is dropped — no rebinding, no reset, no field replacement', async () => {
    const savePoll = vi.fn(async () => {});
    const setPollVersion = vi.fn();
    let storedPollAfterFirstOpen: ReturnType<typeof makeStoredPoll> | null = null;
    const getPoll = vi.fn(async () => storedPollAfterFirstOpen);
    const deps = { savePoll, saveVoteIfNewer: vi.fn(async () => {}), getPoll, loadVotes: vi.fn(async () => []), ...noQueue(), setPollVersion };
    const handler = createPollOpenHandler(deps);
    const ctx = makeCtx();

    // First open: creator X, original title/options.
    const firstRumor = makePollOpenRumor({ pubkey: CREATOR_PUBKEY });
    await handler.handle(firstRumor, ctx, makeSender(CREATOR_PUBKEY));
    expect(savePoll).toHaveBeenCalledOnce();
    const [firstSavedPoll] = savePoll.mock.calls[0];
    expect(firstSavedPoll.creatorPubkey).toBe(CREATOR_PUBKEY);

    // Simulate persistence: getPoll now reflects what handleOpen just saved.
    storedPollAfterFirstOpen = firstSavedPoll;

    // Second poll_open for the SAME pollId (P), from a DIFFERENT sender Y —
    // attempting to rebind creatorPubkey, reset closed, and replace title/options.
    const secondRumor = makePollOpenRumor({
      pubkey: VOTER_PUBKEY,
      id: 'poll-open-hijack-attempt',
      content: JSON.stringify({
        id: POLL_ID, // same pollId as the first open
        title: 'Hijacked title',
        options: [{ id: 'X', label: 'Evil' }, { id: 'Y', label: 'Also evil' }],
        pollType: 'singlechoice',
        creatorPubkey: VOTER_PUBKEY,
      }),
    });
    await handler.handle(secondRumor, ctx, makeSender(VOTER_PUBKEY));

    // Rejected: no second savePoll call for the re-open.
    expect(savePoll).toHaveBeenCalledOnce();

    // getPoll still returns the ORIGINAL poll — unaffected by the re-open attempt.
    const stillStored = await getPoll(GROUP_ID, POLL_ID);
    expect(stillStored?.creatorPubkey).toBe(CREATOR_PUBKEY);
    expect(stillStored?.title).toBe('Best color?');
    expect(stillStored?.options).toEqual([{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }]);
    expect(stillStored?.closed).toBe(false);
  });
});

// ---- POLL_VOTE ---------------------------------------------------------------

describe('pollHandler / POLL_VOTE', () => {
  it('happy-path: saveVoteIfNewer called with correct shape, setPollVersion bumped', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollVoteHandler(deps);
    const rumor = makePollVoteRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.getPoll).toHaveBeenCalledOnce();
    expect(deps.saveVoteIfNewer).toHaveBeenCalledOnce();
    const [savedVote] = deps.saveVoteIfNewer.mock.calls[0];
    expect(savedVote.pollId).toBe(POLL_ID);
    expect(savedVote.voterPubkey).toBe(VOTER_PUBKEY);
    expect(savedVote.responses).toEqual(['A']);
    expect(savedVote.id).toBe(`${POLL_ID}:${VOTER_PUBKEY}`);
    expect(deps.setPollVersion).toHaveBeenCalledOnce();
  });

  it('AC-POLL-2 / AC-ATTR-6: a vote where sender.pubkey differs from rumor.pubkey is saved with voterPubkey and id keyed on sender.pubkey', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollVoteHandler(deps);
    const rumor = makePollVoteRumor(); // rumor.pubkey === VOTER_PUBKEY
    const ctx = makeCtx();
    const forgedSender = makeSender(SELF_PUBKEY); // deliberately different from rumor.pubkey

    await handler.handle(rumor, ctx, forgedSender);

    expect(deps.saveVoteIfNewer).toHaveBeenCalledOnce();
    const [savedVote] = deps.saveVoteIfNewer.mock.calls[0];
    expect(savedVote.voterPubkey).toBe(SELF_PUBKEY);
    expect(savedVote.voterPubkey).not.toBe(rumor.pubkey);
    expect(savedVote.id).toBe(`${POLL_ID}:${SELF_PUBKEY}`);
  });

  it('vote against closed poll: saveVoteIfNewer NOT called', async () => {
    const closedPoll = makeStoredPoll(true);
    const deps = makeDeps(closedPoll);
    const handler = createPollVoteHandler(deps);
    const rumor = makePollVoteRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.saveVoteIfNewer).not.toHaveBeenCalled();
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  // AC-9: a vote for a poll not (yet) known in this group is QUEUED — bound
  // to the authenticated sender, raw responses, scoped to ctx.groupId — and
  // not stored as a vote until its poll-open arrives (see pollIntegrity.test.ts
  // for the end-to-end replay through real storage).
  it('vote for unknown poll: queued for this group and sender, not stored as a vote, no UI bump', async () => {
    const deps = makeDeps(null); // poll not found
    const handler = createPollVoteHandler(deps);
    const rumor = makePollVoteRumor('nonexistent-poll', { content: JSON.stringify({ pollId: 'nonexistent-poll', responses: ['A', 'zz'] }) });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(SELF_PUBKEY));

    expect(deps.queuePendingVote).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      pollId: 'nonexistent-poll',
      voterPubkey: SELF_PUBKEY,
      responses: ['A', 'zz'],
      votedAt: rumor.created_at * 1000,
      seq: 0,
      rumorId: rumor.id,
    });
    expect(deps.saveVoteIfNewer).not.toHaveBeenCalled();
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('vote for a closed poll is dropped, not queued', async () => {
    const deps = makeDeps(makeStoredPoll(true));
    await createPollVoteHandler(deps).handle(makePollVoteRumor(), makeCtx(), makeSender(VOTER_PUBKEY));
    expect(deps.queuePendingVote).not.toHaveBeenCalled();
    expect(deps.saveVoteIfNewer).not.toHaveBeenCalled();
  });

  it('malformed payload: does not throw, no deps called', async () => {
    const deps = makeDeps();
    const handler = createPollVoteHandler(deps);
    const rumor = makePollVoteRumor(POLL_ID, { content: '{ bad }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.saveVoteIfNewer).not.toHaveBeenCalled();
  });

  it('duplicate-id: dispatcher LRU prevents second saveVoteIfNewer call', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollVoteHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makePollVoteRumor(POLL_ID, { id: 'dup-vote-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    expect(deps.saveVoteIfNewer).toHaveBeenCalledOnce();
  });
});

// ---- POLL_VOTE response sanitization (F4) -------------------------------------

/**
 * Runs a vote through createPollVoteHandler, captures whatever saveVoteIfNewer
 * actually received (the sanitized responses, or nothing if the vote was
 * dropped), then feeds that exact set into createPollCloseHandler's
 * loadVotes so the assertions read through the real computeTally recompute
 * (AC-POLL-4) — never a direct inspection of internal sanitization logic.
 */
async function voteThenClose(
  poll: ReturnType<typeof makeStoredPoll>,
  voteResponses: string[],
  voterPubkey: string,
) {
  const savePoll = vi.fn(async () => {});
  const saveVoteIfNewer = vi.fn(async () => {});
  const getPoll = vi.fn(async () => poll);
  const setPollVersion = vi.fn();
  const ctx = makeCtx();

  const voteHandler = createPollVoteHandler({ savePoll, saveVoteIfNewer, getPoll, loadVotes: vi.fn(async () => []), ...noQueue(), setPollVersion });
  const voteRumor = makePollVoteRumor(POLL_ID, {
    pubkey: voterPubkey,
    content: JSON.stringify({ pollId: POLL_ID, responses: voteResponses }),
  });
  await voteHandler.handle(voteRumor, ctx, makeSender(voterPubkey));

  const savedVotes = saveVoteIfNewer.mock.calls.map((call) => call[0]);

  const closeHandler = createPollCloseHandler({ savePoll, saveVoteIfNewer, getPoll, loadVotes: vi.fn(async () => savedVotes), ...noQueue(), setPollVersion });
  await closeHandler.handle(makePollCloseRumor(poll.creatorPubkey), ctx, makeSender(poll.creatorPubkey));

  const [savedPoll] = savePoll.mock.calls[0] ?? [undefined];
  return { savedVotes, savedPoll };
}

describe('pollHandler / POLL_VOTE response sanitization (F4, Fable Stage-2 review, epic: group-message-author-auth-app-layer S5)', () => {
  it('F4(a): a singlechoice vote with two valid responses is capped to ONE (the first) — counted as a single option in the recomputed tally', async () => {
    const poll = makeStoredPoll(false); // singlechoice, options A, B
    const { savedVotes, savedPoll } = await voteThenClose(poll, ['A', 'B'], VOTER_PUBKEY);

    expect(savedVotes).toHaveLength(1);
    expect(savedVotes[0].responses).toEqual(['A']);

    expect(savedPoll.totalVoters).toBe(1);
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(1);
    expect(byOption.B).toBe(0);
  });

  it('F4(b): a bogus option id in the responses is dropped, valid ids are kept', async () => {
    const poll = { ...makeStoredPoll(false), pollType: 'multiplechoice' as const };
    const { savedVotes, savedPoll } = await voteThenClose(poll, ['A', 'Z9'] /* bogus id within the 8-char option-id cap */, VOTER_PUBKEY);

    expect(savedVotes).toHaveLength(1);
    expect(savedVotes[0].responses).toEqual(['A']);

    expect(savedPoll.totalVoters).toBe(1);
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(1);
  });

  it('F4(b): a vote whose responses are ALL bogus option ids is dropped entirely — no totalVoters inflation', async () => {
    const poll = makeStoredPoll(false);
    const { savedVotes, savedPoll } = await voteThenClose(poll, ['bogus-1', 'bogus-2'], VOTER_PUBKEY);

    expect(savedVotes).toHaveLength(0);
    expect(savedPoll.totalVoters).toBe(0);
    expect(savedPoll.results.every((r: { count: number }) => r.count === 0)).toBe(true);
  });

  it('F4(c): a multiplechoice vote with two valid ids plus a bogus id keeps both valid ids and drops the bogus one', async () => {
    const poll = { ...makeStoredPoll(false), pollType: 'multiplechoice' as const };
    const { savedVotes, savedPoll } = await voteThenClose(poll, ['A', 'B', 'bogus'], VOTER_PUBKEY);

    expect(savedVotes).toHaveLength(1);
    expect(savedVotes[0].responses).toEqual(['A', 'B']);

    expect(savedPoll.totalVoters).toBe(1);
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(1);
    expect(byOption.B).toBe(1);
  });
});

// ---- POLL_CLOSE --------------------------------------------------------------

describe('pollHandler / POLL_CLOSE', () => {
  it('happy-path: creator closes poll — savePoll with closed=true, tally recomputed from stored votes, setPollVersion bumped', async () => {
    const storedPoll = makeStoredPoll(false);
    // AC-POLL-4: inject 3 stored votes (2×A, 1×B) via the loadVotes deps
    // spy — diverges from the close payload's claimed totalVoters: 2, so a
    // correct recompute is distinguishable from a pass-through of the
    // payload's numbers.
    const votes = [
      makeStoredVote(VOTER_A, ['A']),
      makeStoredVote(VOTER_B, ['A']),
      makeStoredVote(VOTER_C, ['B']),
    ];
    const deps = makeDeps(storedPoll, votes);
    const handler = createPollCloseHandler(deps);
    const rumor = makePollCloseRumor(CREATOR_PUBKEY); // payload claims totalVoters: 2 — deliberately stale/wrong below
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.loadVotes).toHaveBeenCalledWith(GROUP_ID, POLL_ID);
    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.closed).toBe(true);
    expect(savedPoll.totalVoters).toBe(3);
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(2);
    expect(byOption.B).toBe(1);
    expect(deps.setPollVersion).toHaveBeenCalledOnce();
  });

  it('non-creator attempt to close: savePoll NOT called', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollCloseHandler(deps);
    // rumor.pubkey is VOTER_PUBKEY, not CREATOR_PUBKEY
    const rumor = makePollCloseRumor(VOTER_PUBKEY);
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.savePoll).not.toHaveBeenCalled();
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  // ─── AC-POLL-3 / AC-ATTR-6 (epics: group-message-author-auth-app-layer
  // S2/S5): close authorization keys on sender.pubkey, not rumor.pubkey, in
  // both directions ────────────────────────────────────────────────────────

  it('AC-POLL-3 / AC-ATTR-6: rumor.pubkey matches the creator but sender.pubkey does NOT — close is REJECTED', async () => {
    const storedPoll = makeStoredPoll(false); // creatorPubkey === CREATOR_PUBKEY
    const deps = makeDeps(storedPoll);
    const handler = createPollCloseHandler(deps);
    const rumor = makePollCloseRumor(CREATOR_PUBKEY); // claimed author IS the creator
    const ctx = makeCtx();
    const forgedSender = makeSender(VOTER_PUBKEY); // authenticated sender is NOT the creator

    await handler.handle(rumor, ctx, forgedSender);

    expect(deps.savePoll).not.toHaveBeenCalled();
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('AC-POLL-3 / AC-ATTR-6: rumor.pubkey does NOT match the creator but sender.pubkey DOES — close IS applied', async () => {
    const storedPoll = makeStoredPoll(false); // creatorPubkey === CREATOR_PUBKEY
    const deps = makeDeps(storedPoll);
    const handler = createPollCloseHandler(deps);
    const rumor = makePollCloseRumor(VOTER_PUBKEY); // claimed author is NOT the creator
    const ctx = makeCtx();
    const legitSender = makeSender(CREATOR_PUBKEY); // authenticated sender IS the creator

    await handler.handle(rumor, ctx, legitSender);

    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.closed).toBe(true);
  });

  it('poll not found: savePoll NOT called', async () => {
    const deps = makeDeps(null);
    const handler = createPollCloseHandler(deps);
    const rumor = makePollCloseRumor(CREATOR_PUBKEY);
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.savePoll).not.toHaveBeenCalled();
    // AC-9: queued for the poll-open, bound to the authenticated sender.
    expect(deps.queuePendingClose).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      pollId: POLL_ID,
      closerPubkey: CREATOR_PUBKEY,
      closedAt: rumor.created_at * 1000,
    });
  });

  it('malformed payload: does not throw, no deps called', async () => {
    const deps = makeDeps();
    const handler = createPollCloseHandler(deps);
    const rumor = makePollCloseRumor(CREATOR_PUBKEY, { content: '{ bad }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.savePoll).not.toHaveBeenCalled();
  });

  it('duplicate-id: dispatcher LRU prevents second savePoll call', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollCloseHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makePollCloseRumor(CREATOR_PUBKEY, { id: 'dup-close-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    expect(deps.savePoll).toHaveBeenCalledOnce();
  });

  it('AC-POLL-3 fail-closed: a rejected close leaves no residual state — a subsequent legitimate close from the true creator still succeeds', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll);
    const handler = createPollCloseHandler(deps);
    const ctx = makeCtx();

    // First: a forged close attempt from a non-creator sender.
    const forgedRumor = makePollCloseRumor(VOTER_PUBKEY);
    await handler.handle(forgedRumor, ctx, makeSender(VOTER_PUBKEY));
    expect(deps.savePoll).not.toHaveBeenCalled();

    // Second: the true creator closes — must still succeed, unaffected by
    // the earlier rejected attempt (getPoll is re-mocked to still return the
    // poll as open, since the rejected attempt never persisted anything).
    const legitRumor = makePollCloseRumor(CREATOR_PUBKEY, { id: 'legit-close-after-forged-attempt' });
    await handler.handle(legitRumor, ctx, makeSender(CREATOR_PUBKEY));

    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.closed).toBe(true);
  });
});

// ---- POLL_CLOSE tally recompute (AC-POLL-4) -----------------------------------

describe('pollHandler / POLL_CLOSE tally recompute (AC-POLL-4, epic: group-message-author-auth-app-layer S5)', () => {
  it('a close carrying forged results/totalVoters — displayed tally is recomputed from stored votes, never the forged payload', async () => {
    const storedPoll = makeStoredPoll(false); // options A, B
    // True stored tally: A=2, B=1, totalVoters=3.
    const votes = [
      makeStoredVote(VOTER_A, ['A']),
      makeStoredVote(VOTER_B, ['A']),
      makeStoredVote(VOTER_C, ['B']),
    ];
    const deps = makeDeps(storedPoll, votes);
    const handler = createPollCloseHandler(deps);
    const ctx = makeCtx();

    // Close payload claims a wildly different, forged tally.
    const rumor = makePollCloseRumor(CREATOR_PUBKEY, {
      content: JSON.stringify({
        pollId: POLL_ID,
        results: [
          { optionId: 'A', label: 'Red', count: 999 },
          { optionId: 'B', label: 'Blue', count: 999 },
        ],
        totalVoters: 999,
      }),
    });

    await handler.handle(rumor, ctx, makeSender(CREATOR_PUBKEY));

    expect(deps.savePoll).toHaveBeenCalledOnce();
    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.totalVoters).toBe(3);
    expect(savedPoll.totalVoters).not.toBe(999);
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(2);
    expect(byOption.B).toBe(1);
  });

  it('AC-XCUT-2: tally is invariant across vote-arrival-order permutations AND the close payload\'s forged results/totalVoters — never the payload numbers, regardless of order or forgery', async () => {
    const storedPoll = makeStoredPoll(false); // options A, B
    const ctx = makeCtx();

    // Canonical vote set: true tally A=2, B=1, totalVoters=3.
    const canonicalVotes = [
      makeStoredVote(VOTER_A, ['A']),
      makeStoredVote(VOTER_B, ['A']),
      makeStoredVote(VOTER_C, ['B']),
    ];

    // >= 3 distinct arrival orders of the same 3 votes.
    const permutations = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
    ];

    // >= 3 distinct forged close-payload bodies — wildly wrong counts, all
    // zero, and option ids reordered with mismatched counts.
    const forgedPayloads = [
      { pollId: POLL_ID, results: [{ optionId: 'A', label: 'Red', count: 999 }, { optionId: 'B', label: 'Blue', count: 999 }], totalVoters: 999 },
      { pollId: POLL_ID, results: [{ optionId: 'A', label: 'Red', count: 0 }, { optionId: 'B', label: 'Blue', count: 0 }], totalVoters: 0 },
      { pollId: POLL_ID, results: [{ optionId: 'B', label: 'Blue', count: 7 }, { optionId: 'A', label: 'Red', count: 42 }], totalVoters: 1 },
    ];

    let n = 0;
    for (const order of permutations) {
      const votes = order.map((idx) => canonicalVotes[idx]);
      for (const forgedContent of forgedPayloads) {
        const deps = makeDeps(storedPoll, votes);
        const handler = createPollCloseHandler(deps);
        const rumor = makePollCloseRumor(CREATOR_PUBKEY, {
          id: `xcut2-${n++}`,
          content: JSON.stringify(forgedContent),
        });

        await handler.handle(rumor, ctx, makeSender(CREATOR_PUBKEY));

        expect(deps.savePoll).toHaveBeenCalledOnce();
        const [savedPoll] = deps.savePoll.mock.calls[0];
        expect(savedPoll.totalVoters).toBe(3);
        const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
        expect(byOption.A).toBe(2);
        expect(byOption.B).toBe(1);
      }
    }
  });

  it('a client missing some votes (redelivery/missed) shows its own partial, best-known count — documents accepted eventual consistency', async () => {
    const storedPoll = makeStoredPoll(false);
    // Only ONE vote has been observed/stored locally — the others were
    // never delivered to this client.
    const votes = [makeStoredVote(VOTER_A, ['A'])];
    const deps = makeDeps(storedPoll, votes);
    const handler = createPollCloseHandler(deps);
    const ctx = makeCtx();

    const rumor = makePollCloseRumor(CREATOR_PUBKEY, {
      content: JSON.stringify({
        pollId: POLL_ID,
        results: [{ optionId: 'A', label: 'Red', count: 50 }],
        totalVoters: 50,
      }),
    });

    await handler.handle(rumor, ctx, makeSender(CREATOR_PUBKEY));

    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.totalVoters).toBe(1);
    const aResult = savedPoll.results.find((r: { optionId: string; count: number }) => r.optionId === 'A');
    expect(aResult.count).toBe(1);
  });

  it('no stored votes at all: recompute yields zero counts, not an error and not the payload numbers', async () => {
    const storedPoll = makeStoredPoll(false);
    const deps = makeDeps(storedPoll); // votes defaults to []
    const handler = createPollCloseHandler(deps);
    const ctx = makeCtx();

    const rumor = makePollCloseRumor(CREATOR_PUBKEY); // payload claims totalVoters: 2

    await expect(handler.handle(rumor, ctx, makeSender(CREATOR_PUBKEY))).resolves.not.toThrow();

    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.totalVoters).toBe(0);
    expect(savedPoll.results.every((r: { count: number }) => r.count === 0)).toBe(true);
  });

  it('multiplechoice: a voter selecting two options is counted once per selected option, not double-counted as a voter', async () => {
    const multiPoll = { ...makeStoredPoll(false), pollType: 'multiplechoice' as const };
    // VOTER_A selects BOTH options; VOTER_B selects only B.
    const votes = [
      makeStoredVote(VOTER_A, ['A', 'B']),
      makeStoredVote(VOTER_B, ['B']),
    ];
    const deps = makeDeps(multiPoll, votes);
    const handler = createPollCloseHandler(deps);
    const ctx = makeCtx();

    await handler.handle(makePollCloseRumor(CREATOR_PUBKEY), ctx, makeSender(CREATOR_PUBKEY));

    const [savedPoll] = deps.savePoll.mock.calls[0];
    expect(savedPoll.totalVoters).toBe(2); // 2 voter rows, not 3
    const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
    expect(byOption.A).toBe(1);
    expect(byOption.B).toBe(2);
  });
});

// ---- POLL_VOTE + POLL_CLOSE duplication through real storage (AC-XCUT-2) -----

describe('pollHandler / vote redelivery through real storage (AC-XCUT-2, epic: group-message-author-auth-app-layer S9)', () => {
  it('a same-voter redelivery (different rumor id, same responses) upserts in real storage — never appends a second row — and the recomputed tally is identical regardless of where the redelivery lands relative to the other voter', async () => {
    // Three deliveries: (a) VOTER_A votes A, (b) VOTER_B votes B, (c) a
    // REDELIVERY of VOTER_A's vote — same voter, same responses, but a
    // different rumor id (simulating a resend of the same intent, not the
    // dispatcher's exact-rumor-id dedup tested elsewhere). c always follows
    // a in wall-clock order (it IS a redelivery of a); only its position
    // relative to b's single delivery varies.
    const interleavings: Array<Array<'a' | 'b' | 'c'>> = [
      ['a', 'b', 'c'],
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
    ];

    for (let i = 0; i < interleavings.length; i++) {
      idbStore.clear();
      const pollId = `dup-poll-${i}`;
      const storedPoll = { ...makeStoredPoll(false), id: pollId };
      const ctx = makeCtx();

      const voteHandler = createPollVoteHandler({
        savePoll: vi.fn(async () => {}),
        saveVoteIfNewer: realSaveVote,
        getPoll: vi.fn(async () => storedPoll),
        loadVotes: realLoadVotes,
        ...noQueue(),
        setPollVersion: vi.fn(),
      });

      const deliveries: Record<'a' | 'b' | 'c', () => Promise<void>> = {
        a: () => voteHandler.handle(makePollVoteRumor(pollId, { id: 'vote-a-1', pubkey: VOTER_A }), ctx, makeSender(VOTER_A)),
        b: () => voteHandler.handle(makePollVoteRumor(pollId, { id: 'vote-b-1', pubkey: VOTER_B, content: JSON.stringify({ pollId, responses: ['B'] }) }), ctx, makeSender(VOTER_B)),
        c: () => voteHandler.handle(makePollVoteRumor(pollId, { id: 'vote-a-2', pubkey: VOTER_A }), ctx, makeSender(VOTER_A)),
      };

      for (const step of interleavings[i]) {
        await deliveries[step]();
      }

      // Real storage: exactly one row per unique voter — the redelivery
      // upserted over the original (pollPersistence.saveVoteIfNewer keys by
      // `${pollId}:${voterPubkey}`), it never appended a second row.
      const storedVotes = await realLoadVotes(GROUP_ID, pollId);
      expect(storedVotes).toHaveLength(2);
      expect(new Set(storedVotes.map((v) => v.voterPubkey))).toEqual(new Set([VOTER_A, VOTER_B]));

      const savePoll = vi.fn(async () => {});
      const closeHandler = createPollCloseHandler({
        savePoll,
        saveVoteIfNewer: vi.fn(async () => {}),
        getPoll: vi.fn(async () => storedPoll),
        loadVotes: vi.fn(async () => realLoadVotes(GROUP_ID, pollId)),
        ...noQueue(),
        setPollVersion: vi.fn(),
      });
      await closeHandler.handle(makePollCloseRumor(CREATOR_PUBKEY, { id: `dup-close-${i}` }), ctx, makeSender(CREATOR_PUBKEY));

      expect(savePoll).toHaveBeenCalledOnce();
      const [savedPoll] = savePoll.mock.calls[0];
      expect(savedPoll.totalVoters).toBe(2);
      const byOption = Object.fromEntries(savedPoll.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
      expect(byOption.A).toBe(1);
      expect(byOption.B).toBe(1);
    }
  });
});
