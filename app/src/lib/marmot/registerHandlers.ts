import { createDispatcher, type Dispatcher, type DispatcherOptions, type RumorHandler } from './applicationRumorDispatcher';
import type { ChatMessage } from './chatPersistence';
import type { ReactionThreadKey } from '@/src/lib/reactions/types';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext } from './applicationRumorDispatcher';
import type { MemberProfile, ProfileAvatar } from '@/src/types';
import type { Poll, PollVote, PendingPollVote } from '@/src/lib/marmot/pollPersistence';
import {
  queuePendingVote,
  loadPendingVotes,
  removePendingVotes,
  queuePendingClose,
  loadPendingCloses,
  removePendingCloses,
  queuePendingCloseAnnouncement,
  loadPendingCloseAnnouncements,
  removePendingCloseAnnouncements,
  listHeldPollIds,
} from '@/src/lib/marmot/pollPersistence';
import type { ProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import type { ChangeResult, InboundDeleteEditRumor, MessageEditsThreadKey } from '@/src/lib/messageEdits/api';
import { createChatHandler, createPollCloseAnnouncementReplayer } from './handlers/chatHandler';
import { createReactionHandler } from './handlers/reactionHandler';
import { createProfileHandler } from './handlers/profileHandler';
import { createProfileRequestHandler } from './handlers/profileRequestHandler';
import { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler, createHeldCloseSettler, createHeldPollStateSweeper, guardDeps } from './handlers/pollHandler';
import { createLeaveIntentHandler } from './handlers/leaveHandler';
import { createDeleteEditHandler } from './handlers/deleteEditHandler';

// Composition root — all application rumor handlers registered here.
export interface HandlerDeps {
  // Chat handler deps
  /** Resolves true iff a row was inserted (chatPersistence.appendMessage). */
  appendMessage: (groupId: string, message: ChatMessage) => Promise<boolean>;
  incrementUnread: (groupId: string) => void;
  // notification-domain-invariants (INV-2): mark-read the active group instead
  // of ringing the bell for its own messages.
  markAsRead: (groupId: string) => void;
  setChatVersion: (updater: (v: number) => number) => void;
  // Reaction handler deps (loadMessages shared with reaction gate)
  loadMessages: (groupId: string) => Promise<{ messages: ChatMessage[]; refetchIds: string[] }>;
  applyInboundRumor: (thread: ReactionThreadKey, rumor: ApplicationRumor, sender: AuthenticatedSender) => Promise<unknown>;
  setReactionsVersion: (updater: (v: number) => number) => void;
  // Delete/edit handler deps (S5). resolvePendingSignalsForSlot is consumed by
  // chatHandler.ts's resolve-after-append wiring (S3's required calling
  // convention); applyDeleteEditSignal is consumed by deleteEditHandler.ts
  // (kind-5) and chatHandler.ts's edit-marked-kind-9 dispatch-routing branch.
  applyDeleteEditSignal: (thread: MessageEditsThreadKey, rumor: InboundDeleteEditRumor, sender: AuthenticatedSender) => Promise<ChangeResult>;
  resolvePendingSignalsForSlot: (thread: MessageEditsThreadKey, slotId: string, originalAuthorPubkeyHex: string) => Promise<ChangeResult>;
  // S6 (epic: group-message-author-auth-app-layer): announcement ingest-gate deps.
  isGroupAdmin: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  isGroupMember: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  // Profile handler deps
  mergeMemberProfile: (groupId: string, profile: MemberProfile) => Promise<boolean>;
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
  notifyProfileObserved: (args: { groupId: string; targetPubkey: string; observedUpdatedAt: string }) => void;
  recordRequestAnswered: (groupId: string, authorPubkey: string, timestamp: number) => Promise<void>;
  writeContactEntry: (pubkey: string, entry: { nickname: string; avatar: ProfileAvatar | null; updatedAt: string }) => void;
  setProfileVersion: (updater: (v: number) => number) => void;
  /**
   * epic: group-invite-lifecycle S3 gate-remediation (severity-4 finding,
   * AC-PROD-3/4/5) — accept-producer's atomic compare-and-clear. See
   * ProfileHandlerDeps.consumePendingDirectInviteMarker /
   * ProfileHandlerDeps.sendAnnouncement (handlers/profileHandler.ts) for the
   * full contract. Threaded through this registration seam rather than
   * imported ad hoc into profileHandler.ts (architecture.md boundary rule).
   */
  consumePendingDirectInviteMarker: (groupId: string, pubkey: string) => Promise<boolean>;
  sendAnnouncement: (content: string) => Promise<void>;
  // Profile request handler deps
  recordRequestEmitted: (groupId: string, targetPubkey: string, timestamp: number) => Promise<void>;
  /**
   * AC-030: called when the incoming request targets the local user.
   * Provided as a closure from MarmotContext that signs and sends the local
   * profile via sendRumorSafe.
   */
  sendSelfProfile: (groupId: string) => Promise<void>;
  /**
   * AC-031: called for peer requests (relay path).
   * Pre-bound closure from MarmotContext that provides loadProfile and sendRumor.
   */
  handleIncomingProfileRequest: (args: {
    groupId: string;
    payload: ProfileRequestPayload;
  }) => Promise<void>;
  // Poll handler deps
  /** Resolves the poll as stored (a closed write never overwrites a closed poll, null when absent). */
  savePoll: (poll: Poll) => Promise<Poll | null | void>;
  saveVoteIfNewer: (vote: PollVote, opts?: { requirePoll?: boolean }) => Promise<boolean>;
  getPoll: (groupId: string, pollId: string) => Promise<Poll | null>;
  loadVotes: (groupId: string, pollId: string) => Promise<PollVote[]>;
  // AC-9 early-vote queue (and, always IDB-backed, the early-close and
  // early-close-announcement queues). Optional so existing wiring keeps
  // compiling; when omitted, the IDB-backed pollPersistence implementations
  // are used.
  queuePendingVote?: (vote: Omit<PendingPollVote, 'receivedAt'>) => Promise<boolean>;
  loadPendingVotes?: (groupId: string, pollId: string) => Promise<PendingPollVote[]>;
  removePendingVotes?: (groupId: string, applied: PendingPollVote[]) => Promise<void>;
  setPollVersion: (updater: (v: number) => number) => void;
  // Leave handler deps
  enqueueLeave: (groupId: string, pubkey: string, rumorId: string, meta: import('./applicationRumorDispatcher').DispatchMeta) => void | Promise<void>;
}

export interface BuiltDispatcher extends Dispatcher {
  /**
   * The held poll-state sweep for one group (pollHandler
   * createHeldPollStateSweeper). Run it ONLY through the group's
   * DispatcherSubscription.enqueueMaintenance — it must not interleave with
   * that group's handlers — and pass that task's isDisposed: every storage
   * dependency of the sweep, including the held-summary replay through the
   * chat gate, stops once it holds.
   */
  sweepHeldPollState(ctx: DispatcherContext, isCancelled?: () => boolean): Promise<void>;
}

export function buildDispatcher(deps: HandlerDeps, options: DispatcherOptions = {}): BuiltDispatcher {
  const chatDeps = {
    appendMessage: deps.appendMessage,
    incrementUnread: deps.incrementUnread,
    markAsRead: deps.markAsRead,
    setChatVersion: deps.setChatVersion,
    applyDeleteEditSignal: deps.applyDeleteEditSignal,
    resolvePendingSignalsForSlot: deps.resolvePendingSignalsForSlot,
    isGroupAdmin: deps.isGroupAdmin,
    isGroupMember: deps.isGroupMember,
    getPoll: deps.getPoll,
    loadVotes: deps.loadVotes,
    saveVoteIfNewer: deps.saveVoteIfNewer,
    loadPendingVotes: deps.loadPendingVotes ?? loadPendingVotes,
    removePendingVotes: deps.removePendingVotes ?? removePendingVotes,
    queuePendingCloseAnnouncement,
    loadPendingCloseAnnouncements,
    removePendingCloseAnnouncements,
    // A poll_close summary first applies a held close of its poll
    // (late-bound: the settler is built from the poll deps below).
    settleHeldCloses: (poll: Poll, ctx: DispatcherContext) => settleHeldClosesForGate(poll, ctx),
  };

  const pollDeps = {
    savePoll: deps.savePoll,
    saveVoteIfNewer: deps.saveVoteIfNewer,
    getPoll: deps.getPoll,
    loadVotes: deps.loadVotes,
    queuePendingVote: deps.queuePendingVote ?? queuePendingVote,
    loadPendingVotes: chatDeps.loadPendingVotes,
    removePendingVotes: chatDeps.removePendingVotes,
    queuePendingClose,
    loadPendingCloses,
    removePendingCloses,
    // A poll_close announcement that arrived before its open is re-run
    // through the chat gate once the open (and any queued close) is stored.
    replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chatDeps),
    setPollVersion: deps.setPollVersion,
  };
  const settleHeldClosesForGate = createHeldCloseSettler(pollDeps);

  const handlers: RumorHandler[] = [
    createChatHandler(chatDeps),
    createReactionHandler({
      loadMessages: deps.loadMessages,
      applyInboundRumor: deps.applyInboundRumor,
      setReactionsVersion: deps.setReactionsVersion,
    }),
    createDeleteEditHandler({
      applyDeleteEditSignal: deps.applyDeleteEditSignal,
      setChatVersion: deps.setChatVersion,
    }),
    createProfileHandler({
      mergeMemberProfile: deps.mergeMemberProfile,
      clearPendingDirectInvite: deps.clearPendingDirectInvite,
      notifyProfileObserved: deps.notifyProfileObserved,
      recordRequestAnswered: deps.recordRequestAnswered,
      writeContactEntry: deps.writeContactEntry,
      setProfileVersion: deps.setProfileVersion,
      consumePendingDirectInviteMarker: deps.consumePendingDirectInviteMarker,
      sendAnnouncement: deps.sendAnnouncement,
    }),
    createProfileRequestHandler({
      recordRequestEmitted: deps.recordRequestEmitted,
      sendSelfProfile: deps.sendSelfProfile,
      handleIncomingProfileRequest: deps.handleIncomingProfileRequest,
    }),
    createPollOpenHandler(pollDeps),
    createPollVoteHandler(pollDeps),
    createPollCloseHandler(pollDeps),
    createLeaveIntentHandler({
      // MOCK-S2-001 — resolved by S4; fallback retained for tests that build the
      // dispatcher without MarmotContext (production path always supplies the real closure).
      enqueueLeave: deps.enqueueLeave ?? (() => {}),
    }),
  ];
  return {
    ...createDispatcher(handlers, options),
    sweepHeldPollState: (ctx: DispatcherContext, isCancelled: () => boolean = () => false) => {
      // The held-summary replay runs chat-gate reads/writes and a held-close
      // settle: build it from guarded deps so a cancelled sweep stops there too.
      const guardedPoll = guardDeps(pollDeps, isCancelled);
      const guardedChat = { ...guardDeps(chatDeps, isCancelled), settleHeldCloses: createHeldCloseSettler(guardedPoll) };
      return createHeldPollStateSweeper({
        ...pollDeps,
        replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(guardedChat),
        listHeldPollIds,
      })(ctx, isCancelled);
    },
  };
}
