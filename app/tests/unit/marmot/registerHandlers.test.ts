/**
 * Unit tests for registerHandlers.ts — the application-rumor composition root.
 *
 * The individual handlers (chat, reaction, profile, profileRequest, poll*,
 * leave) and the dispatcher routing are covered by their own test files. The
 * gap this file closes is the WIRING in `buildDispatcher`: that every handler
 * factory is invoked exactly once with the correct slice of the deps bag, and
 * that every returned handler is registered in the dispatcher so a rumor of its
 * kind actually reaches it. A regression that silently drops a registration —
 * or passes the wrong deps to a factory — is invisible to the per-handler tests
 * and is exactly what these tests catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the deserialization boundary so we can inject rumors by kind ───────
let mockRumor: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
} | null = null;

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Mock every handler factory so each returns a sentinel handler ───────────
// Each sentinel carries the real kind constant and a spy `handle`. buildDispatcher
// must register all of them; driving a rumor of each kind must reach the matching
// sentinel. The kinds are the production values (chat 9, reaction 7, profile 0,
// profileRequest 30, poll 10/11/12, leave 13) and are mutually distinct.
const KIND = {
  chat: 9,
  reaction: 7,
  profile: 0,
  profileRequest: 30,
  pollOpen: 10,
  pollVote: 11,
  pollClose: 12,
  leave: 13,
  deleteEdit: 5,
} as const;

const announcementReplayer = vi.fn(async () => {});
const heldCloseSettler = vi.fn(async (poll: unknown) => poll);
const heldPollStateSweeper = vi.fn(async (..._a: unknown[]) => {});
// guardDeps is pure: the real one (from the unmocked module) is used.
const { actualGuardDeps } = await vi.hoisted(async () => ({
  actualGuardDeps: (await vi.importActual<typeof import('@/src/lib/marmot/handlers/pollHandler')>('@/src/lib/marmot/handlers/pollHandler')).guardDeps,
}));
vi.mock('@/src/lib/marmot/handlers/chatHandler', () => ({
  createChatHandler: vi.fn((_deps) => ({ kind: KIND.chat, handle: vi.fn() })),
  createPollCloseAnnouncementReplayer: vi.fn((_deps) => announcementReplayer),
}));
vi.mock('@/src/lib/marmot/handlers/reactionHandler', () => ({
  createReactionHandler: vi.fn((_deps) => ({ kind: KIND.reaction, handle: vi.fn() })),
}));
vi.mock('@/src/lib/marmot/handlers/deleteEditHandler', () => ({
  createDeleteEditHandler: vi.fn((_deps) => ({ kind: KIND.deleteEdit, handle: vi.fn() })),
}));
vi.mock('@/src/lib/marmot/handlers/profileHandler', () => ({
  createProfileHandler: vi.fn((_deps) => ({ kind: KIND.profile, handle: vi.fn() })),
}));
vi.mock('@/src/lib/marmot/handlers/profileRequestHandler', () => ({
  createProfileRequestHandler: vi.fn((_deps) => ({ kind: KIND.profileRequest, handle: vi.fn() })),
}));
vi.mock('@/src/lib/marmot/handlers/pollHandler', () => ({
  createPollOpenHandler: vi.fn((_deps) => ({ kind: KIND.pollOpen, handle: vi.fn() })),
  createPollVoteHandler: vi.fn((_deps) => ({ kind: KIND.pollVote, handle: vi.fn() })),
  createPollCloseHandler: vi.fn((_deps) => ({ kind: KIND.pollClose, handle: vi.fn() })),
  createHeldCloseSettler: vi.fn((_deps) => heldCloseSettler),
  createHeldPollStateSweeper: vi.fn((_deps) => heldPollStateSweeper),
  guardDeps: actualGuardDeps,
}));
vi.mock('@/src/lib/marmot/handlers/leaveHandler', () => ({
  createLeaveIntentHandler: vi.fn((_deps) => ({ kind: KIND.leave, handle: vi.fn() })),
}));

// ─── Dynamic imports after vi.mock ───────────────────────────────────────────
const { buildDispatcher } = await import('@/src/lib/marmot/registerHandlers');
const { createChatHandler, createPollCloseAnnouncementReplayer } = await import('@/src/lib/marmot/handlers/chatHandler');
const { createReactionHandler } = await import('@/src/lib/marmot/handlers/reactionHandler');
const { createProfileHandler } = await import('@/src/lib/marmot/handlers/profileHandler');
const { createProfileRequestHandler } = await import('@/src/lib/marmot/handlers/profileRequestHandler');
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler } = await import(
  '@/src/lib/marmot/handlers/pollHandler'
);
const { createLeaveIntentHandler } = await import('@/src/lib/marmot/handlers/leaveHandler');
const { createDeleteEditHandler } = await import('@/src/lib/marmot/handlers/deleteEditHandler');
const persistence = await import('@/src/lib/marmot/pollPersistence');
const { queuePendingVote: realQueuePendingVote, loadPendingVotes: realLoadPendingVotes, removePendingVotes: realRemovePendingVotes } = persistence;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    // chat
    appendMessage: vi.fn(async () => {}),
    incrementUnread: vi.fn(),
    setChatVersion: vi.fn(),
    markAsRead: vi.fn(),
    // reaction
    loadMessages: vi.fn(async () => ({ messages: [], refetchIds: [] })),
    applyInboundRumor: vi.fn(async () => undefined),
    setReactionsVersion: vi.fn(),
    // delete/edit (S5)
    applyDeleteEditSignal: vi.fn(async () => ({ thread: { kind: 'group', groupId: 'g' }, slotId: null, kind: 'noop' })),
    resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group', groupId: 'g' }, slotId: null, kind: 'noop' })),
    // S6 (epic: group-message-author-auth-app-layer): announcement ingest-gate deps.
    isGroupAdmin: vi.fn(async () => false),
    isGroupMember: vi.fn(async () => false),
    // profile
    mergeMemberProfile: vi.fn(async () => true),
    clearPendingDirectInvite: vi.fn(async () => {}),
    notifyProfileObserved: vi.fn(),
    recordRequestAnswered: vi.fn(async () => {}),
    writeContactEntry: vi.fn(),
    setProfileVersion: vi.fn(),
    // profile request
    recordRequestEmitted: vi.fn(async () => {}),
    sendSelfProfile: vi.fn(async () => {}),
    handleIncomingProfileRequest: vi.fn(async () => {}),
    // poll
    savePoll: vi.fn(async () => {}),
    saveVoteIfNewer: vi.fn(async () => {}),
    getPoll: vi.fn(async () => null),
    loadVotes: vi.fn(async () => []),
    setPollVersion: vi.fn(),
    // leave
    enqueueLeave: vi.fn(),
    ...overrides,
  } as never;
}

// S3 (marmot-ts 0.7.0 authenticated-sender migration): the dispatcher now
// registers TWO listeners — 'authenticatedApplicationMessage' (message-
// carrying) and 'unauthenticatedMessage' (diagnostic-only, AC-OBS-1). A
// single shared `listener` variable would be silently overwritten by the
// second .on() call; listeners are tracked per event name instead.
// emitAsync now takes the payload shape the dispatcher expects
// ({message, senderPubkey, senderLeafIndex}) rather than a raw Uint8Array.
function makeFakeGroup() {
  const listeners = new Map<string, (payload: never) => void | Promise<void>>();
  return {
    on: vi.fn((event: string, fn: (payload: never) => void | Promise<void>) => {
      listeners.set(event, fn);
    }),
    off: vi.fn((event: string, _fn: (payload: never) => void | Promise<void>) => {
      listeners.delete(event);
    }),
    emitAsync: async (payload: { message: Uint8Array; senderPubkey: string; senderLeafIndex: number }) => {
      const fn = listeners.get('authenticatedApplicationMessage');
      if (fn) await fn(payload as never);
    },
  };
}

function makeCtx(groupId = 'G1') {
  return { groupId, selfPubkeyHex: 'bb'.repeat(32), getActiveGroupId: () => groupId };
}

async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

let idCounter = 0;
function rumorOfKind(kind: number) {
  idCounter += 1;
  return { id: `rumor-${idCounter}`, pubkey: 'aa'.repeat(32), created_at: 1_000, kind, tags: [], content: '{}' };
}

beforeEach(() => {
  mockRumor = null;
  vi.clearAllMocks();
});

describe('buildDispatcher — every handler factory is invoked with the correct deps slice', () => {
  it('calls each factory exactly once', () => {
    buildDispatcher(makeDeps());
    expect(createChatHandler).toHaveBeenCalledTimes(1);
    expect(createReactionHandler).toHaveBeenCalledTimes(1);
    expect(createProfileHandler).toHaveBeenCalledTimes(1);
    expect(createProfileRequestHandler).toHaveBeenCalledTimes(1);
    expect(createPollOpenHandler).toHaveBeenCalledTimes(1);
    expect(createPollVoteHandler).toHaveBeenCalledTimes(1);
    expect(createPollCloseHandler).toHaveBeenCalledTimes(1);
    expect(createLeaveIntentHandler).toHaveBeenCalledTimes(1);
    expect(createDeleteEditHandler).toHaveBeenCalledTimes(1);
  });

  it('routes the chat deps slice to createChatHandler', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createChatHandler).toHaveBeenCalledWith({
      appendMessage: deps.appendMessage,
      incrementUnread: deps.incrementUnread,
      setChatVersion: deps.setChatVersion,
      markAsRead: deps.markAsRead,
      applyDeleteEditSignal: deps.applyDeleteEditSignal,
      resolvePendingSignalsForSlot: deps.resolvePendingSignalsForSlot,
      isGroupAdmin: deps.isGroupAdmin,
      isGroupMember: deps.isGroupMember,
      getPoll: deps.getPoll,
      loadVotes: deps.loadVotes,
      saveVoteIfNewer: deps.saveVoteIfNewer,
      loadPendingVotes: realLoadPendingVotes,
      removePendingVotes: realRemovePendingVotes,
      // AC-9 early poll_close announcements (bug: poll-vote-ordering-and-early-close).
      queuePendingCloseAnnouncement: persistence.queuePendingCloseAnnouncement,
      loadPendingCloseAnnouncements: persistence.loadPendingCloseAnnouncements,
      removePendingCloseAnnouncements: persistence.removePendingCloseAnnouncements,
      settleHeldCloses: expect.any(Function),
    });
  });

  it('the chat gate\'s held-close settle is the settler built from the poll deps bag (bug: poll-residual-ordering-and-close-retry)', async () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    const { createHeldCloseSettler } = await import('@/src/lib/marmot/handlers/pollHandler');
    const pollArg = (createPollOpenHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(createHeldCloseSettler).toHaveBeenCalledWith(pollArg);
    const chatSlice = (createChatHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      settleHeldCloses: (poll: unknown, ctx: unknown) => Promise<unknown>;
    };
    const poll = { id: 'p' };
    const ctx = { groupId: 'g' };
    heldCloseSettler.mockClear();
    await expect(chatSlice.settleHeldCloses(poll, ctx)).resolves.toBe(poll);
    expect(heldCloseSettler).toHaveBeenCalledWith(poll, ctx);
  });

  it('sweepHeldPollState builds, per run, a sweeper over the SAME poll deps bag + listHeldPollIds, with the held-summary replay built from GUARDED chat deps, and passes isCancelled (bug: poll-followups)', async () => {
    const deps = makeDeps();
    const built = buildDispatcher(deps);
    const { createHeldPollStateSweeper, createHeldCloseSettler } = await import('@/src/lib/marmot/handlers/pollHandler');
    const sweeperMock = createHeldPollStateSweeper as unknown as ReturnType<typeof vi.fn>;
    const replayerMock = createPollCloseAnnouncementReplayer as unknown as ReturnType<typeof vi.fn>;
    const pollArg = (createPollOpenHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    const chatSlice = (createChatHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(sweeperMock).not.toHaveBeenCalled();
    const ctx = { groupId: 'g' };
    let cancelled = false;
    const isCancelled = () => cancelled;
    heldPollStateSweeper.mockClear();
    replayerMock.mockClear();
    (createHeldCloseSettler as unknown as ReturnType<typeof vi.fn>).mockClear();
    await built.sweepHeldPollState(ctx as never, isCancelled);
    expect(heldPollStateSweeper).toHaveBeenCalledWith(ctx, isCancelled);
    const sweepArg = sweeperMock.mock.calls[0][0] as Record<string, unknown>;
    for (const [k, v] of Object.entries(pollArg)) if (k !== 'replayHeldCloseAnnouncements') expect(sweepArg[k]).toBe(v);
    expect(sweepArg.listHeldPollIds).toBe(persistence.listHeldPollIds);
    expect(sweepArg.replayHeldCloseAnnouncements).toBe(announcementReplayer);
    // The replayer for the sweep is built from guarded chat deps: same keys,
    // each one refusing to run once cancelled.
    const guardedChat = replayerMock.mock.calls[0][0] as Record<string, (...a: unknown[]) => unknown>;
    expect(Object.keys(guardedChat).sort()).toEqual(Object.keys(chatSlice).sort());
    expect(guardedChat.settleHeldCloses).toBe(heldCloseSettler);
    const settlerArg = (createHeldCloseSettler as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, (...a: unknown[]) => unknown>;
    cancelled = true;
    expect(() => guardedChat.incrementUnread('g')).toThrow('maintenance cancelled');
    expect(() => settlerArg.setPollVersion((v: number) => v)).toThrow('maintenance cancelled');
    expect(deps.incrementUnread).not.toHaveBeenCalled();
    // Default isCancelled: never cancelled.
    heldPollStateSweeper.mockClear();
    await built.sweepHeldPollState(ctx as never);
    expect((heldPollStateSweeper.mock.calls[0] as unknown[])[1]).toEqual(expect.any(Function));
    expect(((heldPollStateSweeper.mock.calls[0] as unknown[])[1] as () => boolean)()).toBe(false);
    expect(typeof built.subscribe).toBe('function');
  });

  it('builds the early-announcement replayer from the SAME chat deps slice and hands it to the poll handlers', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    const chatSlice = (createChatHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(createPollCloseAnnouncementReplayer).toHaveBeenCalledWith(chatSlice);
    const pollArg = (createPollOpenHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(pollArg.replayHeldCloseAnnouncements).toBe(announcementReplayer);
  });

  it('routes the reaction deps slice to createReactionHandler', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createReactionHandler).toHaveBeenCalledWith({
      loadMessages: deps.loadMessages,
      applyInboundRumor: deps.applyInboundRumor,
      setReactionsVersion: deps.setReactionsVersion,
    });
  });

  it('routes the delete/edit deps slice to createDeleteEditHandler (S5)', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createDeleteEditHandler).toHaveBeenCalledWith({
      applyDeleteEditSignal: deps.applyDeleteEditSignal,
      setChatVersion: deps.setChatVersion,
    });
  });

  it('routes the profile deps slice to createProfileHandler', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createProfileHandler).toHaveBeenCalledWith({
      mergeMemberProfile: deps.mergeMemberProfile,
      clearPendingDirectInvite: deps.clearPendingDirectInvite,
      notifyProfileObserved: deps.notifyProfileObserved,
      recordRequestAnswered: deps.recordRequestAnswered,
      writeContactEntry: deps.writeContactEntry,
      setProfileVersion: deps.setProfileVersion,
    });
  });

  it('routes the profile-request deps slice to createProfileRequestHandler', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createProfileRequestHandler).toHaveBeenCalledWith({
      recordRequestEmitted: deps.recordRequestEmitted,
      sendSelfProfile: deps.sendSelfProfile,
      handleIncomingProfileRequest: deps.handleIncomingProfileRequest,
    });
  });

  it('shares one poll deps bag across all three poll factories', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    const pollBag = {
      savePoll: deps.savePoll,
      saveVoteIfNewer: deps.saveVoteIfNewer,
      getPoll: deps.getPoll,
      loadVotes: deps.loadVotes,
      // AC-9 early-vote queue: defaults to the IDB-backed persistence
      // implementations when the caller does not inject them.
      queuePendingVote: realQueuePendingVote,
      loadPendingVotes: realLoadPendingVotes,
      removePendingVotes: realRemovePendingVotes,
      // AC-9 early-close queue (bug: poll-vote-ordering-and-early-close).
      queuePendingClose: persistence.queuePendingClose,
      loadPendingCloses: persistence.loadPendingCloses,
      removePendingCloses: persistence.removePendingCloses,
      replayHeldCloseAnnouncements: announcementReplayer,
      setPollVersion: deps.setPollVersion,
    };
    expect(createPollOpenHandler).toHaveBeenCalledWith(pollBag);
    expect(createPollVoteHandler).toHaveBeenCalledWith(pollBag);
    expect(createPollCloseHandler).toHaveBeenCalledWith(pollBag);
  });

  it('passes injected early-vote queue deps through instead of the persistence defaults', () => {
    const queuePendingVote = vi.fn(async () => {});
    const loadPendingVotes = vi.fn(async () => []);
    const removePendingVotes = vi.fn(async () => {});
    buildDispatcher({ ...makeDeps(), queuePendingVote, loadPendingVotes, removePendingVotes });
    const arg = (createPollVoteHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(arg.queuePendingVote).toBe(queuePendingVote);
    expect(arg.loadPendingVotes).toBe(loadPendingVotes);
    expect(arg.removePendingVotes).toBe(removePendingVotes);
  });

  it('passes the real enqueueLeave to createLeaveIntentHandler when provided', () => {
    const deps = makeDeps();
    buildDispatcher(deps);
    expect(createLeaveIntentHandler).toHaveBeenCalledWith({ enqueueLeave: deps.enqueueLeave });
  });

  it('substitutes a no-op fallback when enqueueLeave is absent (MOCK-S2-001)', () => {
    const deps = makeDeps({ enqueueLeave: undefined });
    buildDispatcher(deps);
    const arg = (createLeaveIntentHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      enqueueLeave: unknown;
    };
    expect(typeof arg.enqueueLeave).toBe('function');
    // The fallback must be callable without throwing (it is a no-op).
    expect(() => (arg.enqueueLeave as (...a: unknown[]) => void)('g', 'p')).not.toThrow();
  });
});

describe('buildDispatcher — every registered handler is reachable through the dispatcher', () => {
  const cases: Array<{ name: string; kind: number; factory: () => { mock: { results: { value: unknown }[] } } }> = [
    { name: 'chat', kind: KIND.chat, factory: () => createChatHandler as never },
    { name: 'reaction', kind: KIND.reaction, factory: () => createReactionHandler as never },
    { name: 'profile', kind: KIND.profile, factory: () => createProfileHandler as never },
    { name: 'profileRequest', kind: KIND.profileRequest, factory: () => createProfileRequestHandler as never },
    { name: 'pollOpen', kind: KIND.pollOpen, factory: () => createPollOpenHandler as never },
    { name: 'pollVote', kind: KIND.pollVote, factory: () => createPollVoteHandler as never },
    { name: 'pollClose', kind: KIND.pollClose, factory: () => createPollCloseHandler as never },
    { name: 'leave', kind: KIND.leave, factory: () => createLeaveIntentHandler as never },
    { name: 'deleteEdit', kind: KIND.deleteEdit, factory: () => createDeleteEditHandler as never },
  ];

  for (const { name, kind } of cases) {
    it(`a kind-${kind} rumor reaches the ${name} handler`, async () => {
      const dispatcher = buildDispatcher(makeDeps());
      const group = makeFakeGroup();
      dispatcher.subscribe(group as never, makeCtx());

      // The sentinel handle spy for this kind, captured from the factory's result.
      const factory = cases.find((c) => c.name === name)!.factory();
      const sentinel = factory.mock.results[0].value as { handle: ReturnType<typeof vi.fn> };

      mockRumor = rumorOfKind(kind);
      await group.emitAsync({ message: new Uint8Array([1]), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
      await flush();

      expect(sentinel.handle).toHaveBeenCalledTimes(1);
    });
  }
});
