/**
 * Test fixture (not a test): the production sink-path handler set wired to the REAL stores over
 * fake-indexeddb / an in-memory localStorage, behind a real HistoryBackend.
 *
 * Real: chatPersistence, reactions (incl. the held queue), messageEdits, pollPersistence,
 * groupStorage member profiles, knownPeers, unreadStore, the history sink and dispatcher.
 * Fixtures: the live group handle (`live`, behind `groupOf`), the client FIFO (`jobs`, run by
 * `runJobs`), and spies for the account-scope sends / observers.
 *
 * Tests importing this MUST `import 'fake-indexeddb/auto'` first and mock `react`
 * (`useSyncExternalStore: (_s, g) => g()`) so `unreadOf` can read the store.
 */
import { vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createChatGroupHandler, createPollCloseAnnouncementReplayer, type ChatGroupHandlerDeps } from '@/src/lib/marmot/handlers/chatHandler';
import { createReactionGroupHandler } from '@/src/lib/marmot/handlers/reactionHandler';
import { createDeleteEditGroupHandler } from '@/src/lib/marmot/handlers/deleteEditHandler';
import { createPollCloseGroupHandler, createPollOpenGroupHandler, createPollVoteGroupHandler } from '@/src/lib/marmot/handlers/pollHandler';
import { createProfileGroupHandler } from '@/src/lib/marmot/handlers/profileHandler';
import { createProfileRequestGroupHandler } from '@/src/lib/marmot/handlers/profileRequestHandler';
import { createGroupGates, type GateGroup } from '@/src/lib/marmot/handlers/groupGates';
import * as chat from '@/src/lib/marmot/chatPersistence';
import * as reactions from '@/src/lib/reactions/api';
import * as edits from '@/src/lib/messageEdits/api';
import * as polls from '@/src/lib/marmot/pollPersistence';
import { mergeMemberProfile } from '@/src/lib/marmot/groupStorage';
import { rememberKnownPeer } from '@/src/lib/knownPeers';
import { incrementUnread, markAsRead, recomputeUnread, useUnreadCounts } from '@/src/lib/unreadStore';

export const SELF = 'aa'.repeat(32);
export const BOB = 'bb'.repeat(32);
export const MALLORY = 'cc'.repeat(32);
export const ALICE = 'dd'.repeat(32);

/** An in-memory localStorage (knownPeers and the unread last-read marks are pure localStorage). */
export function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

let counter = 0;
// Unique per run (no wrap) and never equal to a fixed account pubkey (aa.. bb.. cc.. dd..): snapshot() normalises
// the group id textually, and the stores are keyed by it.
export const nextGroupId = (): string => (0x1000 + ++counter).toString(16).padStart(4, '0').repeat(16);

/** Unread count of a group as the UI reads it (needs the `react` mock). */
export const unreadOf = (groupId: string): number => useUnreadCounts().counts[groupId] ?? 0;

/** The sink requires hex event ids; tests label events ('m1') and map them with `ev`. */
export const ev = (...labels: string[]): string[] => labels.map((l) => Buffer.from(l).toString('hex'));

export function historyEntry(groupId: string, o: { eventId: string; kind?: number; rumorId?: string; pubkey?: string; account: string; content?: string; tags?: string[][]; at?: number }): HistoryEntry {
  return {
    groupId,
    eventId: ev(o.eventId)[0],
    rumor: {
      id: o.rumorId ?? `rumor-${o.eventId}`,
      pubkey: o.pubkey ?? o.account,
      created_at: o.at ?? 1_700_000_000,
      kind: o.kind ?? 9,
      tags: o.tags ?? [],
      content: o.content ?? `hello ${o.eventId}`,
    },
    orderingKey: { account: o.account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}

export interface RealAppOptions {
  groupId?: string;
  settleTimeoutMs?: number;
  activeGroup?: string | null;
}

export function buildRealApp(options: RealAppOptions = {}) {
  const groupId = options.groupId ?? nextGroupId();
  const versions = { chat: 0, reactions: 0, polls: 0, profile: 0 };
  const jobs: Array<() => Promise<void>> = [];
  const calls: string[] = [];
  // the live library group handle; `held:false` = the group is no longer held, `failure` = groups.get rejects
  const live: { held: boolean; admins: string[]; members: string[]; failure: boolean } = { held: true, admins: [], members: [], failure: false };
  const groupOf = vi.fn(async (): Promise<GateGroup | undefined> => {
    if (live.failure) throw new Error('groups.get failed');
    return live.held ? { admins: live.admins, members: () => live.members } : undefined;
  });
  const spies = {
    onOwnEcho: vi.fn(),
    onOwnWithdrawn: vi.fn(),
    sendSelfProfile: vi.fn(async () => undefined),
    handleIncomingProfileRequest: vi.fn(async () => undefined),
    recordRequestEmitted: vi.fn(async () => undefined),
    recordRequestAnswered: vi.fn(async () => undefined),
    notifyProfileObserved: vi.fn(),
    writeContactEntry: vi.fn(),
    sendAnnouncement: vi.fn(async () => undefined),
  };
  const markers = new Set<string>(); // pending-direct-invite markers `${groupId}:${pubkey}`
  // one-shot fault / hold injection points of the production wiring
  const hooks: { beforeAppend?: Promise<void>; failMerge: boolean; failConsume: number } = { failMerge: false, failConsume: 0 };
  const bumpChat = (u: (v: number) => number) => void (versions.chat = u(versions.chat));
  const bumpReactions = (u: (v: number) => number) => void (versions.reactions = u(versions.reactions));
  const group = { kind: 'group' as const, groupId };
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
    calls.push(name);
    return fn(...a);
  };

  const chatDeps: ChatGroupHandlerDeps = {
  appendMessage: chat.appendMessage,
  incrementUnread,
  markAsRead,
  setChatVersion: bumpChat,
  applyDeleteEditSignal: edits.applyDeleteEditSignal,
  resolvePendingSignalsForSlot: edits.resolvePendingSignalsForSlot,
  groupOf,
  getPoll: polls.getPoll,
  loadVotes: polls.loadVotes,
  saveVoteIfNewer: polls.saveVoteIfNewer,
  loadPendingVotes: polls.loadPendingVotes,
  removePendingVotes: polls.removePendingVotes,
  queuePendingCloseAnnouncement: polls.queuePendingCloseAnnouncement,
  loadPendingCloseAnnouncements: polls.loadPendingCloseAnnouncements,
  removePendingCloseAnnouncements: polls.removePendingCloseAnnouncements,
  appendOrAddCarrier: async (g, m, e) => {
    await hooks.beforeAppend;
    return chat.appendOrAddCarrier(g, m, e);
  },
  retractMessageCarrier: chat.retractMessageCarrier,
  removeMessages: chat.removeMessages,
  hasMessage: chat.hasMessage,
  recomputeUnread: (g) => recomputeUnread(g, SELF),
  rememberKnownPeer,
  onOwnEcho: spies.onOwnEcho,
  onOwnWithdrawn: spies.onOwnWithdrawn,
  recomputeSlot: edits.recomputeSlot,
  recomputeMessageReactions: reactions.recomputeMessageReactions,
  releaseHeldReactions: (g, id) => reactions.releaseHeldReactions({ kind: 'group', groupId: g }, id),
  setReactionsVersion: bumpReactions,
  };
  // The held poll_close announcements replay through the same live-accessor gates as the chat handler's own.
  const gates = createGroupGates(groupOf);
  const replayHeldCloseAnnouncements = createPollCloseAnnouncementReplayer({ ...chatDeps, isGroupAdmin: gates.isGroupAdmin, isGroupMember: gates.isGroupMember });

  const handlers = [
    createChatGroupHandler(chatDeps),
    createReactionGroupHandler({
      loadMessages: chat.loadMessages,
      applyInboundRumor: reactions.applyInboundRumor,
      setReactionsVersion: bumpReactions,
      recomputeMessageReactions: reactions.recomputeMessageReactions,
      holdReaction: reactions.holdReaction,
      releaseHeldReactions: reactions.releaseHeldReactions,
    }),
    createDeleteEditGroupHandler({
      applyDeleteEditSignal: edits.applyDeleteEditSignal,
      setChatVersion: bumpChat,
      recomputeSlot: edits.recomputeSlot,
    }),
    ...[createPollOpenGroupHandler, createPollVoteGroupHandler, createPollCloseGroupHandler].map((factory) =>
      factory({
        savePoll: polls.savePoll,
        saveVoteIfNewer: polls.saveVoteIfNewer,
        getPoll: polls.getPoll,
        loadVotes: polls.loadVotes,
        queuePendingVote: polls.queuePendingVote,
        loadPendingVotes: polls.loadPendingVotes,
        removePendingVotes: polls.removePendingVotes,
        queuePendingClose: polls.queuePendingClose,
        loadPendingCloses: polls.loadPendingCloses,
        removePendingCloses: polls.removePendingCloses,
        setPollVersion: (u) => void (versions.polls = u(versions.polls)),
        recomputePoll: polls.recomputePoll,
        receiptNow: polls.receiptNow,
        replayHeldCloseAnnouncements,
      }),
    ),
    createProfileGroupHandler({
      mergeMemberProfile: track('mergeMemberProfile', async (g, p) => {
        if (hooks.failMerge) throw new Error('profile store down');
        return mergeMemberProfile(g, p);
      }),
      clearPendingDirectInvite: track('clearPendingDirectInvite', async () => undefined),
      notifyProfileObserved: track('notifyProfileObserved', spies.notifyProfileObserved),
      recordRequestAnswered: track('recordRequestAnswered', spies.recordRequestAnswered),
      writeContactEntry: track('writeContactEntry', spies.writeContactEntry),
      setProfileVersion: track('setProfileVersion', (u) => void (versions.profile = u(versions.profile))),
      consumePendingDirectInviteMarker: track('consumePendingDirectInviteMarker', async (g, pk) => {
        // the marker store failing BEFORE it consumed anything (the real consume is atomic: it clears or it throws)
        if (hooks.failConsume > 0) {
          hooks.failConsume -= 1;
          throw new Error('marker store down');
        }
        return markers.delete(`${g}:${pk}`);
      }),
      sendAnnouncement: spies.sendAnnouncement,
      enqueue: track('enqueue', (job) => void jobs.push(job)),
    }),
    createProfileRequestGroupHandler({
      recordRequestEmitted: track('recordRequestEmitted', spies.recordRequestEmitted),
      sendSelfProfile: spies.sendSelfProfile,
      handleIncomingProfileRequest: spies.handleIncomingProfileRequest,
      groupOf,
      enqueue: track('enqueue', (job) => void jobs.push(job)),
    }),
  ];

  const dispatcher = createGroupRumorDispatch({ handlers, env: { selfPubkeyHex: SELF, getActiveGroupId: () => options.activeGroup ?? null } });
  const dbName = `s5-${groupId}`;
  const sink: AppHistoryBackend = createHistoryBackend({
    handlers: dispatcher,
    store: createIdbHistoryStore(dbName),
    ...(options.settleTimeoutMs ? { settleTimeoutMs: options.settleTimeoutMs } : {}),
  });
  const rowStore = createIdbHistoryStore(dbName);

  return {
    groupId,
    sink,
    dispatcher,
    live,
    groupOf,
    versions,
    spies,
    markers,
    hooks,
    jobs,
    calls,
    entry: (o: Omit<Parameters<typeof historyEntry>[1], never>) => historyEntry(groupId, o),
    /** Runs the queued client-FIFO jobs in order (what the owned queue does after the frame returns). */
    runJobs: async () => {
      while (jobs.length > 0) await jobs.shift()!();
    },
    /** The sink row of an event (to read `dispatched`). */
    row: (label: string) => rowStore.getRow(groupId, ev(label)[0]),
    messages: async () => (await chat.loadMessages(groupId)).messages,
    reactionRows: () => reactions.loadReactions(group),
    polls: () => polls.loadPolls(groupId),
    votes: (pollId: string) => polls.loadVotes(groupId, pollId),
  };
}

export type RealApp = ReturnType<typeof buildRealApp>;
