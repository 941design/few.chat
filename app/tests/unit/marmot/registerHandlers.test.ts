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

vi.mock('@/src/lib/marmot/handlers/chatHandler', () => ({
  createChatHandler: vi.fn((_deps) => ({ kind: KIND.chat, handle: vi.fn() })),
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
}));
vi.mock('@/src/lib/marmot/handlers/leaveHandler', () => ({
  createLeaveIntentHandler: vi.fn((_deps) => ({ kind: KIND.leave, handle: vi.fn() })),
}));

// ─── Dynamic imports after vi.mock ───────────────────────────────────────────
const { buildDispatcher } = await import('@/src/lib/marmot/registerHandlers');
const { createChatHandler } = await import('@/src/lib/marmot/handlers/chatHandler');
const { createReactionHandler } = await import('@/src/lib/marmot/handlers/reactionHandler');
const { createProfileHandler } = await import('@/src/lib/marmot/handlers/profileHandler');
const { createProfileRequestHandler } = await import('@/src/lib/marmot/handlers/profileRequestHandler');
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler } = await import(
  '@/src/lib/marmot/handlers/pollHandler'
);
const { createLeaveIntentHandler } = await import('@/src/lib/marmot/handlers/leaveHandler');
const { createDeleteEditHandler } = await import('@/src/lib/marmot/handlers/deleteEditHandler');

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
    saveVote: vi.fn(async () => {}),
    getPoll: vi.fn(async () => null),
    loadVotes: vi.fn(async () => []),
    setPollVersion: vi.fn(),
    // leave
    enqueueLeave: vi.fn(),
    ...overrides,
  } as never;
}

function makeFakeGroup() {
  let listener: ((data: Uint8Array) => void | Promise<void>) | null = null;
  return {
    on: vi.fn((_e: string, fn: (data: Uint8Array) => void | Promise<void>) => {
      listener = fn;
    }),
    off: vi.fn(() => {
      listener = null;
    }),
    emitAsync: async (data: Uint8Array) => {
      if (listener) await listener(data);
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
    });
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
      saveVote: deps.saveVote,
      getPoll: deps.getPoll,
      loadVotes: deps.loadVotes,
      setPollVersion: deps.setPollVersion,
    };
    expect(createPollOpenHandler).toHaveBeenCalledWith(pollBag);
    expect(createPollVoteHandler).toHaveBeenCalledWith(pollBag);
    expect(createPollCloseHandler).toHaveBeenCalledWith(pollBag);
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
      await group.emitAsync(new Uint8Array([1]));
      await flush();

      expect(sentinel.handle).toHaveBeenCalledTimes(1);
    });
  }
});
