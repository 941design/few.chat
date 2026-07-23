import React, { useEffect, useRef } from 'react';
import { useChatStore } from '@/src/context/ChatStoreContext';
import ChatBox from '@/src/components/chat/ChatBox';
import type { MemberProfile } from '@/src/types';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

type GroupChatProps = {
  threadId?: string;
  pubkey: string;
  profileMap: Record<string, MemberProfile>;
  /**
   * S7 (epic-group-invite-lifecycle): whether the current viewer is a group
   * admin. Passed straight through to `ChatBox` so it can grant a
   * moderation-only Delete on informative announcements. Optional —
   * defaults to `false` via ChatBox when omitted.
   */
  isCurrentUserAdmin?: boolean;
};

export default function GroupChat({ threadId, pubkey, profileMap, isCurrentUserAdmin }: GroupChatProps) {
  const { messages, sendMessage, sendImageMessage, sendReaction, loading, handleDeleteMessage, handleEditMessage } = useChatStore();

  // Stable ref so the bridge callback always calls the latest sendReaction
  const sendReactionRef = useRef(sendReaction);
  useEffect(() => {
    sendReactionRef.current = sendReaction;
  }, [sendReaction]);

  // E2E state-injection bridge — only in non-production builds (AC-40, story brief).
  // Exposes window.__fewReactions.send(groupId, messageId, emoji) for Playwright tests.
  // Story-08 will replace this with real picker UI; the bridge is removed then.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (process.env.NODE_ENV === 'production') return;

    (window as any).__fewReactions = {
      send: (targetGroupId: string, messageId: string, emoji: string, isRemoval?: boolean) => {
        // Find the target message in the current messages list
        const msg = messages.find((m) => m.id === messageId);
        if (!msg) {
          // Construct a minimal ChatMessage if not found (allows injection before load)
          const syntheticMsg: ChatMessage = {
            id: messageId,
            content: '',
            senderPubkey: '',
            groupId: targetGroupId,
            createdAt: Date.now(),
          };
          return sendReactionRef.current(emoji, syntheticMsg, isRemoval);
        }
        return sendReactionRef.current(emoji, msg, isRemoval);
      },
    };
  // Re-register when messages change so the closure always has latest messages list
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // onReact callback — translates op "add"/"remove" to isRemoval boolean for sendReaction (AC-55)
  const handleReact = React.useCallback(
    async (emoji: string, message: ChatMessage, op: 'add' | 'remove') => {
      await sendReaction(emoji, message, op === 'remove');
    },
    [sendReaction],
  );

  return (
    <ChatBox
      threadId={threadId ?? ''}
      pubkey={pubkey}
      profileMap={profileMap}
      messages={messages}
      loading={loading}
      sendMessage={sendMessage}
      sendImageMessage={sendImageMessage}
      onReact={handleReact}
      allowPollMessages
      // S6: group half of the MessageActionHandlers seam (built by S5 in ChatStoreContext).
      handleDeleteMessage={handleDeleteMessage}
      handleEditMessage={handleEditMessage}
      isCurrentUserAdmin={isCurrentUserAdmin}
      // Gate-remediation (S7, group-vs-DM scoping): GroupChat always renders a
      // group thread, regardless of whether this viewer happens to be an
      // admin — so this is unconditionally true, not derived from
      // isCurrentUserAdmin. Gates the announcement-family suppression in
      // canShowMessageActions to group threads only.
      isGroupContext
    />
  );
}
