import type { MarmotGroup } from '@941design/marmot';
import { writeContactEntry } from '@/src/lib/contactCache';
import { rememberKnownPeer } from '@/src/lib/knownPeers';
import { pendingOwnSendsStatusPort } from '@/src/lib/pendingOwnSends';
import { incrementUnread, markAsRead, recomputeUnread } from '@/src/lib/unreadStore';
import * as edits from '@/src/lib/messageEdits/api';
import * as reactions from '@/src/lib/reactions/api';
import * as chat from './chatPersistence';
import { loadMemberProfiles, mergeMemberProfile } from './groupStorage';
import { createChatGroupHandler, createPollCloseAnnouncementReplayer, type ChatGroupHandlerDeps } from './handlers/chatHandler';
import { createDeleteEditGroupHandler } from './handlers/deleteEditHandler';
import { createGroupGates } from './handlers/groupGates';
import { assertPorts, createGroupRumorDispatch } from './handlers/groupRumorDispatch';
import { createHeldCloseSettler, createHeldPollStateSweeper, createPollCloseGroupHandler, createPollOpenGroupHandler, createPollVoteGroupHandler } from './handlers/pollHandler';
import { createProfileGroupHandler } from './handlers/profileHandler';
import { createProfileRequestGroupHandler } from './handlers/profileRequestHandler';
import { createReactionGroupHandler } from './handlers/reactionHandler';
import type { RecomputeSignal } from './handlers/types';
import { createHistoryBackend, type AppHistoryBackend } from './history';
import { noteForwardedInviteProfile, consumePendingDirectInviteMarker } from './pendingDirectInviteStorage';
import * as polls from './pollPersistence';
import { handleIncomingProfileRequest, notifyProfileObserved } from './profileRequestRunner';
import { recordRequestAnswered, recordRequestEmitted } from './profileRequestStorage';
import { PROFILE_RUMOR_KIND } from './profileSync';
import { createGroupRumorSender, createOwnRowTracker, type GroupRumorSender, type OwnRowTracker } from './send';

interface GroupSessionHistoryDeps {
  pubkey: string;
  /** Cached library groups.get, safe inside a sink call as described by groupGates. */
  groupOf: (groupId: string) => Promise<MarmotGroup | undefined>;
  enqueue: (job: () => Promise<void>, groupId: string) => void;
  getActiveGroupId: () => string | null;
  sendOwnProfile: (groupId: string) => Promise<void>;
  onChatChanged: () => void;
  onReactionsChanged: () => void;
  onPollsChanged: () => void;
  onProfilesChanged: () => void;
  heldGroupIds: () => readonly string[];
}

export interface GroupSessionHistory {
  history: AppHistoryBackend;
  sender: GroupRumorSender;
  tracker: OwnRowTracker;
  dispose: () => Promise<void>;
}

// messageEdits uses an app-wide provider. An older teardown must leave a newer session's provider installed.
let sessionAdmins: edits.GroupAdminsProvider | undefined;

/** Composes the production history handlers and sender for one lease-holding account session. */
export function createGroupSessionHistory(deps: GroupSessionHistoryDeps): GroupSessionHistory {
  assertPorts('createGroupSessionHistory', deps, [
    'groupOf', 'enqueue', 'getActiveGroupId', 'sendOwnProfile',
    'onChatChanged', 'onReactionsChanged', 'onPollsChanged', 'onProfilesChanged', 'heldGroupIds',
  ]);
  const { pubkey, groupOf } = deps;
  const gates = createGroupGates(groupOf);
  const tracker = createOwnRowTracker({ ports: pendingOwnSendsStatusPort(pubkey) });
  const sender = createGroupRumorSender({ ownPubkey: pubkey, tracker });
  let disposed = false;
  const enqueue = (job: () => Promise<void>, groupId: string) => {
    if (!disposed) deps.enqueue(async () => {
      if (!disposed) await job();
    }, groupId);
  };

  const send = async (groupId: string, kind: number, content: string): Promise<void> => {
    const group = await groupOf(groupId);
    if (group && !disposed) await sender.sendGroupRumor(group, kind, content, []);
  };

  // Fold surviving durable rows first, then own signals still awaiting an echo. The stores
  // select the signals for their aggregate. The local rumor ID identifies a pending signal
  // until the sink provides a carrier, and its creation time keeps its fold clock stable.
  function withPendingSignals(groupId: string, signals: readonly RecomputeSignal[]): RecomputeSignal[] {
    const echoed = new Set(signals.filter((signal) => signal.sender.toLowerCase() === pubkey).map((signal) => signal.rumor.id));
    let seq = signals.reduce((max, signal) => Math.max(max, signal.seq), 0);
    return [
      ...signals,
      ...tracker.pendingSignals(groupId).filter((rumor) => !echoed.has(rumor.id)).map((rumor) => ({
        rumor,
        sender: pubkey,
        eventId: rumor.id,
        seq: ++seq,
        receivedAt: rumor.created_at * 1000,
      })),
    ];
  }

  const recomputeSlot: typeof edits.recomputeSlot = (thread, slots, signals, options) =>
    edits.recomputeSlot(thread, slots, thread.kind === 'group' ? withPendingSignals(thread.groupId, signals) : signals, options);
  const recomputeMessageReactions: typeof reactions.recomputeMessageReactions = (thread, id, signals, cancelled) =>
    reactions.recomputeMessageReactions(thread, id, thread.kind === 'group' ? withPendingSignals(thread.groupId, signals) : signals, cancelled);

  const pollDeps = {
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
    setPollVersion: deps.onPollsChanged,
    receiptNow: polls.receiptNow,
    recomputePoll: (groupId: string, pollId: string, signals: readonly RecomputeSignal[], _self?: string, cancelled?: () => boolean) =>
      polls.recomputePoll(groupId, pollId, withPendingSignals(groupId, signals), pubkey, cancelled),
  };
  const chatDeps: ChatGroupHandlerDeps = {
    appendMessage: chat.appendMessage,
    appendOrAddCarrier: chat.appendOrAddCarrier,
    retractMessageCarrier: chat.retractMessageCarrier,
    removeMessages: chat.removeMessages,
    hasMessage: chat.hasMessage,
    incrementUnread,
    markAsRead,
    recomputeUnread: (groupId) => recomputeUnread(groupId, pubkey),
    setChatVersion: deps.onChatChanged,
    applyDeleteEditSignal: edits.applyDeleteEditSignal,
    resolvePendingSignalsForSlot: edits.resolvePendingSignalsForSlot,
    recomputeSlot,
    groupOf,
    getPoll: polls.getPoll,
    loadVotes: polls.loadVotes,
    saveVoteIfNewer: polls.saveVoteIfNewer,
    loadPendingVotes: polls.loadPendingVotes,
    removePendingVotes: polls.removePendingVotes,
    queuePendingCloseAnnouncement: polls.queuePendingCloseAnnouncement,
    loadPendingCloseAnnouncements: polls.loadPendingCloseAnnouncements,
    removePendingCloseAnnouncements: polls.removePendingCloseAnnouncements,
    settleHeldCloses: createHeldCloseSettler(pollDeps),
    rememberKnownPeer,
    onOwnEcho: tracker.onOwnEcho,
    onOwnWithdrawn: tracker.onOwnWithdrawn,
    recomputeMessageReactions,
    releaseHeldReactions: (groupId, id) => reactions.releaseHeldReactions({ kind: 'group', groupId }, id),
    setReactionsVersion: deps.onReactionsChanged,
  };
  const pollHandlerDeps = {
    ...pollDeps,
    replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer({ ...chatDeps, ...gates }),
  };
  const sweepHeldPolls = createHeldPollStateSweeper({ ...pollHandlerDeps, listHeldPollIds: polls.listHeldPollIds });

  const dispatch = createGroupRumorDispatch({
    env: { selfPubkeyHex: pubkey, getActiveGroupId: deps.getActiveGroupId },
    handlers: [
      createChatGroupHandler(chatDeps),
      createReactionGroupHandler({
        loadMessages: chat.loadMessages,
        applyInboundRumor: reactions.applyInboundRumor,
        setReactionsVersion: deps.onReactionsChanged,
        recomputeMessageReactions,
        holdReaction: reactions.holdReaction,
        releaseHeldReactions: reactions.releaseHeldReactions,
      }),
      createDeleteEditGroupHandler({
        applyDeleteEditSignal: edits.applyDeleteEditSignal,
        setChatVersion: deps.onChatChanged,
        recomputeSlot,
      }),
      createPollOpenGroupHandler(pollHandlerDeps),
      createPollVoteGroupHandler(pollHandlerDeps),
      createPollCloseGroupHandler(pollHandlerDeps),
      createProfileGroupHandler({
        mergeMemberProfile,
        noteForwardedInviteProfile: (groupId, invitee) => noteForwardedInviteProfile(groupId, invitee, pubkey),
        consumePendingDirectInviteMarker: (groupId, invitee) => consumePendingDirectInviteMarker(groupId, invitee, pubkey),
        notifyProfileObserved,
        recordRequestAnswered,
        writeContactEntry,
        setProfileVersion: deps.onProfilesChanged,
        sendAnnouncement: (content, groupId) => send(groupId, chat.CHAT_MESSAGE_KIND, content),
        enqueue,
      }),
      createProfileRequestGroupHandler({
        recordRequestEmitted,
        sendSelfProfile: deps.sendOwnProfile,
        handleIncomingProfileRequest: ({ groupId, payload }) => handleIncomingProfileRequest({
          groupId,
          payload,
          selfPubkeyHex: pubkey,
          now: Date.now(),
          loadProfile: async (id, target) => (await loadMemberProfiles(id)).find((profile) => profile.pubkeyHex === target),
          // The runner invokes this from its backoff timer. Use the same owned queue for the relay write.
          sendRumor: async (id, content) => enqueue(() => send(id, PROFILE_RUMOR_KIND, content), id),
        }),
        groupOf,
        enqueue,
      }),
    ],
  });

  const backend = createHistoryBackend({
    accountPubkey: pubkey,
    handlers: {
      retract: dispatch.retract,
      async dispatch(input) {
        if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
          const { beforeGroupDispatch } = await import('../testHooks/marmotSession');
          await beforeGroupDispatch(input);
        }
        await dispatch.dispatch(input);
        // Kind 9 confirms through its handler after the chat write. Other kinds also need
        // confirmation so their pending signals stop participating in future folds.
        if (input.rumor.kind !== chat.CHAT_MESSAGE_KIND && input.sender.toLowerCase() === pubkey) {
          tracker.onOwnEcho(input.groupId, input.rumor.id, input.eventId);
        }
      },
    },
  });
  sessionAdmins = gates.adminsOf;
  edits.registerGroupAdminsProvider(gates.adminsOf);

  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposed = true;
    disposal ??= backend.dispose().finally(() => {
      tracker.dispose();
      if (sessionAdmins === gates.adminsOf) {
        edits.registerGroupAdminsProvider(null);
        sessionAdmins = undefined;
      }
    });
    return disposal;
  };
  // Bootstrap disposes the structural history port, which also owns the tracker and provider.
  const history = {
    ...backend,
    async sweep() {
      const result = await backend.sweep();
      for (const groupId of deps.heldGroupIds()) {
        if (disposed) break;
        await backend.maintainGroup(groupId, (cancelled) => sweepHeldPolls({
          groupId, selfPubkeyHex: pubkey, getActiveGroupId: deps.getActiveGroupId,
        }, cancelled)).catch((error) => {
          if (!disposed) console.warn('[marmot] held poll recovery failed', error);
        });
      }
      return result;
    },
    dispose,
  };
  return { history, sender, tracker, dispose };
}
