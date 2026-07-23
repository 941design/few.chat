import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EmojiComposerPicker, { type EmojiComposerPickerHandle } from '@/src/components/chat/EmojiComposerPicker';
import EmojiReactionPicker from '@/src/components/chat/EmojiReactionPicker';
import ReactionBadgeRow from '@/src/components/chat/ReactionBadgeRow';
import { insertAtCursor } from '@/src/lib/reactions/composeInsert';
import {
  Box,
  Flex,
  Image,
  Link,
  Text,
  Textarea,
  IconButton,
  VStack,
  CloseButton,
} from '@chakra-ui/react';
import { useCopy, useLanguage } from '@/src/context/LanguageContext';
import { useChatStore } from '@/src/context/ChatStoreContext';
import { truncateNpub, pubkeyToNpub } from '@/src/lib/nostrKeys';
import { splitLinks } from '@/src/lib/linkify';
import { filterVisibleMessages, type ChatMessage } from '@/src/lib/marmot/chatPersistence';
import {
  canEditMessage,
  canShowMessageActions,
  computeDeleteConfirmTransition,
  isEditSubmitBlocked,
  shouldShowEditedMarker,
} from '@/src/lib/messageEdits/messageActionUi';
import type { StructuredContent } from '@/src/lib/marmot/parseStructured';
import { parseStructured, resolveCancellerDisplay } from '@/src/lib/marmot/parseStructured';
import type { MemberProfile } from '@/src/types';
import type { ChatMediaAttachment } from '@/src/lib/media/imageMessage';
import PollChatAnnouncement from '@/src/components/groups/PollChatAnnouncement';
import PollChatResults from '@/src/components/groups/PollChatResults';
import InviteCancelledChatAnnouncement from '@/src/components/groups/InviteCancelledChatAnnouncement';
import LeaveChatAnnouncement from '@/src/components/groups/LeaveChatAnnouncement';
import GroupRenamedChatAnnouncement from '@/src/components/groups/GroupRenamedChatAnnouncement';
import MemberAdmittedChatAnnouncement from '@/src/components/groups/MemberAdmittedChatAnnouncement';
import InviteLifecycleChatAnnouncement, {
  resolveInviteLifecycleSubjectDisplay,
} from '@/src/components/groups/InviteLifecycleChatAnnouncement';
import ImageAttachmentButton from '@/src/components/groups/ImageAttachmentButton';
import ImageMessageBubble from '@/src/components/groups/ImageMessageBubble';
import { ATTACHMENTS_ENABLED } from '@/src/config/features';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const SCROLL_NEAR_BOTTOM_PX = 100;

const AVATAR_COLORS = [
  'purple.500',
  'blue.500',
  'teal.500',
  'green.500',
  'orange.500',
  'pink.500',
  'red.500',
  'cyan.500',
];

function getAvatarColor(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function formatTimestamp(ms: number, locale: string, justNow: string, minutesAgo: (m: number) => string): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return justNow;
  if (diff < 3_600_000) return minutesAgo(Math.floor(diff / 60_000));
  const d = new Date(ms);
  const today = new Date();
  const isToday =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  const timeStr = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (isToday) return timeStr;
  const dayStr = d.toLocaleDateString(locale, { weekday: 'short' });
  const timeStr24 = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${dayStr} ${timeStr24}`;
}

function isGrouped(prev: ChatMessage, curr: ChatMessage): boolean {
  const delta = curr.createdAt - prev.createdAt;
  return prev.senderPubkey === curr.senderPubkey && delta >= 0 && delta <= GROUP_WINDOW_MS;
}

type ChatBoxProps = {
  threadId: string;
  pubkey: string;
  messages: ChatMessage[];
  loading: boolean;
  profileMap: Record<string, MemberProfile>;
  sendMessage: (content: string) => Promise<void>;
  sendImageMessage: (file: File, caption: string) => Promise<void>;
  decryptMedia?: (attachment: ChatMediaAttachment) => Promise<{ bytes: Uint8Array; type: string }>;
  allowPollMessages?: boolean;
  /**
   * Story-08: reaction send callback. Supplied by GroupChat (sendReaction) and
   * by ContactChat (handleReact). Used by both EmojiReactionPicker and
   * ReactionBadgeRow. AC-55.
   */
  onReact?: (emoji: string, message: ChatMessage, op: 'add' | 'remove') => Promise<void>;
  /**
   * Story-08: optional pre-computed reactions map for DM surface.
   * ContactChat supplies this from useDirectReactions so that ChatBox
   * does not need to read from ChatStoreContext (which is group-only).
   * When absent, ChatBox falls back to useChatStore().reactionsByMessageId
   * (group surface). AC-55, arch §3 rule 3.
   */
  reactionsByMessageId?: Map<string, import('@/src/lib/reactions/api').ReactionAggregate[]>;
  /**
   * Optional override for the composer placeholder. Defaults to the generic
   * group chat placeholder. The feedback surface supplies a feedback-specific
   * string (AC-I18N-1).
   */
  composerPlaceholder?: string;
  /**
   * Whether the image-attachment button is shown. Defaults to true. The
   * feedback surface sets this false: v1 feedback is text-only (spec §7), and
   * an image send would bypass the sealed feedback marker tags.
   *
   * Subordinate to the ATTACHMENTS_ENABLED feature toggle: while attachments
   * are disabled product-wide, passing true here still yields no attach
   * surface. See `imageAttachmentsAllowed` below.
   */
  allowImageAttachments?: boolean;
  /**
   * S6 (epic-feature-request-message-edit-and-delete): the MessageActionHandlers
   * seam. ContactChat (DM) and GroupChat (group, sourced from useChatStore())
   * both supply these with an IDENTICAL signature, so ChatBox never needs to
   * know which transport it is rendering for. Consumed exclusively through
   * this seam — ChatBox never imports messageEdits/api.ts or
   * messageEdits/rumor.ts directly.
   */
  handleDeleteMessage: (id: string) => Promise<void>;
  handleEditMessage: (id: string, newContent: string) => Promise<void>;
  /**
   * Gate-remediation (S6, finding 1): whether the edit/delete action menu is
   * offered at all. Defaults to true. The sealed feedback surface
   * (ContactChat `source="feedback"`) passes false: its send paths carry no
   * feedback marker tags, so an edit/delete would publish an unmarked
   * kind-14/kind-5 into the maintainer's sealed channel. Mirrors the
   * `allowImageAttachments`/`onReact`-omission precedent for that same
   * surface — gate off, never thread markers through.
   */
  allowMessageActions?: boolean;
  /**
   * S7 (epic-group-invite-lifecycle): whether the current viewer is a group
   * admin. Threaded from the group page's `adminPubkeys` single source of
   * truth (`pages/groups.tsx`'s `isAdmin`) via `GroupChat`. Defaults to
   * `false` — the DM/ContactChat surface has no admin concept and never
   * passes this. Used to grant a moderation-only Delete on informative
   * announcements (AC-IMMUT-3); never grants Edit.
   */
  isCurrentUserAdmin?: boolean;
  /**
   * Gate-remediation (S7, group-vs-DM scoping): whether this ChatBox instance
   * is rendering a GROUP thread. Defaults to `false` — the DM/ContactChat
   * surface never passes this, so it safely falls back to DM behavior. Only
   * `GroupChat` passes `true`, unconditionally (a non-admin group viewer is
   * still inside a group). Gates the entire announcement-family suppression
   * in `canShowMessageActions`: without it, a DM's own `call_notice` (or any
   * other announcement-shaped message) stays author-deletable/editable
   * exactly as before S7 — groups have admins and a shared, tamper-evident
   * announcement history; 1:1 DMs have neither.
   */
  isGroupContext?: boolean;
};

export default function ChatBox({
  threadId,
  pubkey,
  messages,
  loading,
  profileMap,
  sendMessage,
  sendImageMessage,
  decryptMedia,
  allowPollMessages = true,
  onReact,
  reactionsByMessageId: reactionsByMessageIdProp,
  composerPlaceholder,
  allowImageAttachments = true,
  handleDeleteMessage,
  handleEditMessage,
  allowMessageActions = true,
  isCurrentUserAdmin = false,
  isGroupContext = false,
}: ChatBoxProps) {
  // Attachments are being deprecated: ATTACHMENTS_ENABLED turns off every
  // compose-an-attachment entry point (button, drop, paste) on every surface.
  // A caller's own opt-out (feedback's text-only channel) still applies on top,
  // so this can only ever remove the surface, never grant it.
  const imageAttachmentsAllowed = ATTACHMENTS_ENABLED && allowImageAttachments;
  const copy = useCopy();
  const { language } = useLanguage();
  // Story-08: read aggregated reactions from ChatStoreContext (group surface).
  // For DM surface, ContactChat passes reactionsByMessageId as a prop to avoid
  // ChatStoreContext (which is group-only — arch §3 rule 3).
  const { reactionsByMessageId: storeReactionsByMessageId } = useChatStore();
  // Prefer the prop (DM surface) over the store (group surface).
  const reactionsByMessageId = reactionsByMessageIdProp ?? storeReactionsByMessageId;
  const [inputValue, setInputValue] = useState('');
  const [showBadge, setShowBadge] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageSendFailed, setImageSendFailed] = useState(false);
  const [imageTooLarge, setImageTooLarge] = useState(false);
  // S6: edit-mode composer state — the message currently being edited (null when composing new).
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  // S6: AC-DEL-6 two-click confirm — the message id currently armed for delete confirmation.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // S6: belt-and-suspenders tombstone render-filter (closes the AC-DEL-3/AC-DEL-5 render
  // half). S4/S5 already filter at their storage-set points; this is the shared backstop
  // so NO surface can leak a tombstoned row into render, including on reload/remount.
  const visibleMessages = useMemo(() => filterVisibleMessages(messages), [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const prevMsgCountRef = useRef(visibleMessages.length);
  const initializedRef = useRef(false);
  const prevPreviewUrl = useRef<string | null>(null);
  // Handle for the emoji picker so the keyboard shortcut can toggle it.
  const emojiPickerRef = useRef<EmojiComposerPickerHandle>({ toggle: () => {} });

  // Story-08: track which message's reaction picker is open (if any).
  // We keep a single open picker per ChatBox (only one message bubble can have
  // the picker open at a time). This is independent of useDisclosure inside
  // EmojiReactionPicker because the picker manages its own open/close state;
  // this ref is only used for touch long-press to programmatically open it.
  // Touch long-press: per-message timer ref.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevPreviewUrl.current && prevPreviewUrl.current !== previewUrl) {
      URL.revokeObjectURL(prevPreviewUrl.current);
    }
    prevPreviewUrl.current = previewUrl;
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const attachFile = useCallback((file: File) => {
    setAttachedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setImageSendFailed(false);
    setImageTooLarge(false);
  }, []);

  const removeAttachment = useCallback(() => {
    setAttachedFile(null);
    setPreviewUrl(null);
    setImageSendFailed(false);
    setImageTooLarge(false);
  }, []);

  // Gate-remediation (S6, finding 4): reset per-thread composer state whenever
  // the active thread changes. ChatBox is not keyed by threadId, so without
  // this a switch to a different group/contact while editing or with a
  // delete confirmation armed would carry that state into the NEW thread — a
  // subsequent Save/Delete would then act on the wrong thread's handler,
  // silently no-op (the target id has no meaning there), while the composer
  // already cleared/looked like it succeeded.
  useEffect(() => {
    setEditingMessage(null);
    setPendingDeleteId(null);
    setInputValue('');
    removeAttachment();
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [threadId, removeAttachment]);

  useEffect(() => {
    if (!loading) {
      initializedRef.current = true;
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [loading]);

  useEffect(() => {
    const newCount = visibleMessages.length;
    const hasNew = newCount > prevMsgCountRef.current;
    prevMsgCountRef.current = newCount;
    if (!hasNew || !initializedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowBadge(false);
    } else {
      setShowBadge(true);
    }
  }, [visibleMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distFromBottom <= SCROLL_NEAR_BOTTOM_PX;
    if (isNearBottomRef.current) setShowBadge(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isNearBottomRef.current = true;
    setShowBadge(false);
  }, []);

  // S6: edit-mode submit. AC-EDIT-5: empty/whitespace content is blocked (the
  // Save button is disabled below AND a visible hint is shown — never a
  // silent no-op). On failure, restore the editing state + content so the
  // user doesn't lose their in-progress edit (handleEditMessage itself
  // already rolled back the optimistic storage/view state).
  const handleEditSubmit = useCallback(async () => {
    if (!editingMessage) return;
    if (isEditSubmitBlocked(inputValue)) return;
    const id = editingMessage.id;
    const content = inputValue;
    setInputValue('');
    setEditingMessage(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    try {
      await handleEditMessage(id, content);
    } catch {
      setEditingMessage(editingMessage);
      setInputValue(content);
    }
  }, [editingMessage, handleEditMessage, inputValue]);

  const handleSend = useCallback(async () => {
    if (editingMessage) {
      await handleEditSubmit();
      return;
    }
    if (attachedFile) {
      const caption = inputValue;
      setInputValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      setImageSendFailed(false);
      setImageTooLarge(false);
      try {
        const { ImageTooLargeError } = await import('@/src/lib/media/imageProcessing');
        await sendImageMessage(attachedFile, caption);
        removeAttachment();
      } catch (err) {
        const { ImageTooLargeError } = await import('@/src/lib/media/imageProcessing');
        if (err instanceof ImageTooLargeError) {
          setImageTooLarge(true);
        } else {
          setImageSendFailed(true);
        }
      }
      return;
    }
    if (!inputValue.trim()) return;
    const content = inputValue;
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    try {
      await sendMessage(content);
    } catch {
      setInputValue(content);
    }
  }, [attachedFile, editingMessage, handleEditSubmit, inputValue, removeAttachment, sendImageMessage, sendMessage]);

  // S6: enter edit mode for a message — pre-fills the composer with its
  // current content (AC-EDIT-5's composer half). Clears any armed delete
  // confirmation and any in-progress image attachment (edit is text-only).
  const handleEditClick = useCallback((msg: ChatMessage) => {
    setPendingDeleteId(null);
    setEditingMessage(msg);
    setInputValue(msg.content);
    removeAttachment();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [removeAttachment]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, []);

  // S6: AC-DEL-6 two-click confirm. First click arms the message; a second
  // click on the SAME armed message confirms and fires handleDeleteMessage.
  // handleDeleteMessage itself owns the optimistic-remove + rollback-on-
  // publish-failure behavior (AC-DEL-2) — this handler just gates the call.
  const handleDeleteClick = useCallback((messageId: string) => {
    const { nextPendingId, shouldDelete } = computeDeleteConfirmTransition(pendingDeleteId, messageId);
    setPendingDeleteId(nextPendingId);
    if (shouldDelete) {
      // Gate-remediation (S6, finding 5): deleting the message currently open
      // in the edit composer must clear edit mode first — otherwise the edit
      // banner stays up against a now-tombstoned slot and the next Save
      // silently no-ops.
      if (editingMessage?.id === messageId) {
        handleCancelEdit();
      }
      void handleDeleteMessage(messageId).catch(() => {
        // handleDeleteMessage already restores the optimistic view on failure;
        // nothing further to do here (mirrors the reaction picker's onReact
        // catch-and-swallow — the caller/store owns failure UX).
      });
    }
  }, [editingMessage, handleCancelEdit, handleDeleteMessage, pendingDeleteId]);

  const handleEmojiSelect = useCallback((emoji: string) => {
    const ta = textareaRef.current;
    // Read cursor position from the textarea DOM element (may be null if unfocused).
    const selStart = ta ? ta.selectionStart : null;
    const selEnd = ta ? ta.selectionEnd : null;
    const { value, nextCaret } = insertAtCursor(inputValue, selStart, selEnd, emoji);
    setInputValue(value);
    // Restore focus and set caret after React commits the new value.
    if (ta) {
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(nextCaret, nextCaret);
        // Keep auto-resize in sync.
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
      });
    }
  }, [inputValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Shift+E — toggle the emoji picker.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      emojiPickerRef.current.toggle();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Text-only surfaces (feedback) must not accept attachments via any entry
    // point — button, drag/drop, or paste — so image sends cannot bypass the
    // sealed feedback marker tags (spec §7).
    if (!imageAttachmentsAllowed) return;
    // Gate-remediation (S6, finding 6): edit mode is text-only (AC-IMG-2's
    // composer half) — a drop mid-edit must not attach an image the Save
    // path silently ignores, only for it to ride out on the NEXT ordinary
    // send.
    if (editingMessage) return;
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) attachFile(file);
  }, [attachFile, imageAttachmentsAllowed, editingMessage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!imageAttachmentsAllowed) return;
    // Gate-remediation (S6, finding 6): see handleDrop's matching comment.
    if (editingMessage) return;
    const item = Array.from(e.clipboardData.items).find(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (item) {
      const file = item.getAsFile();
      if (file) attachFile(file);
    }
  }, [attachFile, imageAttachmentsAllowed, editingMessage]);

  function getDisplayName(senderPubkey: string): string {
    const profile = profileMap[senderPubkey];
    if (profile?.nickname) return profile.nickname;
    return truncateNpub(pubkeyToNpub(senderPubkey));
  }

  function getAvatarInitial(senderPubkey: string): string {
    return truncateNpub(pubkeyToNpub(senderPubkey))[0]?.toUpperCase() ?? '?';
  }

  function renderStructuredMessage(
    structured: StructuredContent | null,
    msg: ChatMessage,
  ) {
    if (structured?.type === 'poll_open' && allowPollMessages) {
      const creatorDisplay = profileMap[structured.creatorPubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(structured.creatorPubkey));
      return <PollChatAnnouncement creatorName={creatorDisplay} title={structured.title} />;
    }
    if (structured?.type === 'poll_close' && allowPollMessages) {
      const creatorDisplay = profileMap[msg.senderPubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(msg.senderPubkey));
      return (
        <PollChatResults
          creatorName={creatorDisplay}
          title={structured.title}
          results={structured.results}
          totalVoters={structured.totalVoters}
        />
      );
    }
    if (structured?.type === 'invite_cancelled' && allowPollMessages) {
      const memberDisplay = profileMap[structured.pubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(structured.pubkey));
      const cancellerDisplay = resolveCancellerDisplay(
        msg.senderPubkey,
        profileMap,
        (pk) => truncateNpub(pubkeyToNpub(pk)),
      );
      return (
        <InviteCancelledChatAnnouncement
          memberDisplay={memberDisplay}
          cancellerDisplay={cancellerDisplay}
        />
      );
    }
    if (structured?.type === 'invite_lifecycle' && allowPollMessages) {
      // Subject (invitee) resolves strictly from the payload pubkey. This
      // variant's copy is subject-centric ("<name> was invited/joined/declined")
      // and displays no author, so the message's protocol-level sender is
      // never read here — there is no subject/author conflation path
      // (AC-STRUCT-5).
      const memberDisplay = resolveInviteLifecycleSubjectDisplay(
        structured.pubkey,
        profileMap,
        (pk) => truncateNpub(pubkeyToNpub(pk)),
      );
      return <InviteLifecycleChatAnnouncement event={structured.event} memberDisplay={memberDisplay} />;
    }
    if (structured?.type === 'leave_intent' && allowPollMessages) {
      // Prefer the name carried in the announcement itself (the leaver's own
      // display name), so the row reads "<name> left the group" even when we
      // never received the leaver's MemberProfile. Fall back to the cached
      // profile, then to a truncated npub only as a last resort.
      const memberDisplay = structured.name
        ?? profileMap[structured.pubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(structured.pubkey));
      return <LeaveChatAnnouncement memberDisplay={memberDisplay} />;
    }
    if (structured?.type === 'group_renamed' && allowPollMessages) {
      // Attribute the rename to the protocol-enforced sender, never a
      // self-reported field (mirrors resolveCancellerDisplay).
      const actorDisplay = profileMap[msg.senderPubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(msg.senderPubkey));
      return <GroupRenamedChatAnnouncement actorDisplay={actorDisplay} newName={structured.name} />;
    }
    if (structured?.type === 'member_admitted' && allowPollMessages) {
      // Attribute the admitter to the protocol-enforced sender, never a
      // self-reported field (mirrors resolveCancellerDisplay / group_renamed).
      // The payload carries only the admitted member's pubkey — there is no
      // admitter field to spoof.
      const admitterDisplay = profileMap[msg.senderPubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(msg.senderPubkey));
      const memberDisplay = profileMap[structured.pubkey]?.nickname
        ?? truncateNpub(pubkeyToNpub(structured.pubkey));
      return <MemberAdmittedChatAnnouncement admitterDisplay={admitterDisplay} memberDisplay={memberDisplay} />;
    }
    if (structured?.type === 'call_notice') {
      const initiatorDisplay = profileMap[structured.initiator]?.nickname
        ?? truncateNpub(pubkeyToNpub(structured.initiator));
      const text = structured.event === 'started'
        ? copy.calls.callStartedNotice(initiatorDisplay)
        : copy.calls.callEndedNotice;
      return (
        <Box
          px={3}
          py={1.5}
          borderRadius="lg"
          bg="surfaceMutedBg"
          color="textMuted"
          fontSize="sm"
          fontStyle="italic"
          textAlign="center"
        >
          <Text>📞 {text}</Text>
        </Box>
      );
    }
    if (structured?.type === 'image') {
      return (
        <ImageMessageBubble
          groupId={threadId}
          caption={structured.caption}
          attachments={msg.attachments ?? { full: null, thumb: null }}
          senderPubkey={msg.senderPubkey}
          createdAt={msg.createdAt}
          decryptMedia={decryptMedia}
        />
      );
    }
    return (
      <Box
        px={3}
        py={1.5}
        borderRadius="lg"
        bg={msg.senderPubkey.toLowerCase() === pubkey.toLowerCase() ? 'brand.500' : 'surfaceMutedBg'}
        color={msg.senderPubkey.toLowerCase() === pubkey.toLowerCase() ? 'white' : 'text'}
        fontSize="sm"
      >
        <Text whiteSpace="pre-wrap" wordBreak="break-word">
          {splitLinks(msg.content).map((token, i) =>
            token.type === 'link' ? (
              <Link
                key={i}
                href={token.value}
                isExternal
                color="inherit"
                textDecoration="underline"
                onClick={(e) => e.stopPropagation()}
              >
                {token.value}
              </Link>
            ) : (
              token.value
            ),
          )}
        </Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" h="400px" borderWidth="1px" borderColor="borderSubtle" borderRadius="md" overflow="hidden">
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        flex="1"
        overflowY="auto"
        px={4}
        py={3}
        data-testid="chat-scroll-container"
      >
        {loading && visibleMessages.length === 0 ? (
          <Flex align="center" justify="center" py={8}>
            <Text fontSize="sm" color="textMuted">{copy.groups.chatLoading}</Text>
          </Flex>
        ) : visibleMessages.length === 0 ? (
          <Flex align="center" justify="center" py={8} data-testid="chat-empty-state">
            <Text fontSize="sm" color="textMuted">{copy.groups.chatEmpty}</Text>
          </Flex>
        ) : (
          <VStack spacing={0} align="stretch">
            {visibleMessages.map((msg, i) => {
              const prev = visibleMessages[i - 1];
              const grouped = prev ? isGrouped(prev, msg) : false;
              // Gate-remediation (S6, finding 8): case-insensitive compare, matching
              // the epic's other seam guards (e.g. ContactChat's own-message auth
              // checks), which all `.toLowerCase()` both sides before comparing.
              const isSelf = msg.senderPubkey.toLowerCase() === pubkey.toLowerCase();
              const showActions = canShowMessageActions(msg, pubkey, allowMessageActions, isCurrentUserAdmin, isGroupContext);
              const displayName = getDisplayName(msg.senderPubkey);
              const avatarImage = profileMap[msg.senderPubkey]?.avatar?.imageUrl;
              const avatarInitial = getAvatarInitial(msg.senderPubkey);
              const avatarColor = getAvatarColor(msg.senderPubkey);
              const structured = parseStructured(msg.content);

              const aggregates = reactionsByMessageId.get(msg.id) ?? [];

              return (
                <Flex
                  key={msg.id}
                  data-testid={`msg-${msg.id}`}
                  gap={2}
                  mt={grouped ? '2px' : 3}
                  direction={isSelf ? 'row-reverse' : 'row'}
                  align="flex-start"
                  // role="group" enables _groupHover on the reaction trigger inside
                  role="group"
                >
                  {!grouped ? (
                    <Flex
                      w="28px"
                      h="28px"
                      flexShrink={0}
                      align="center"
                      justify="center"
                      borderRadius="full"
                      bg={avatarImage ? 'white' : avatarColor}
                      color="white"
                      fontSize="xs"
                      fontWeight="semibold"
                      borderWidth={avatarImage ? '1px' : 0}
                      borderColor="borderSubtle"
                      overflow="hidden"
                    >
                      {avatarImage ? (
                        <Image src={avatarImage} alt={displayName} boxSize="22px" objectFit="contain" />
                      ) : (
                        avatarInitial
                      )}
                    </Flex>
                  ) : (
                    <Box w="28px" flexShrink={0} />
                  )}

                  <Flex direction="column" maxW="75%" align={isSelf ? 'flex-end' : 'flex-start'}>
                    {/*
                      AC-EDIT-3: the "(edited)" marker renders near the timestamp on both
                      DM and group surfaces. Grouped (consecutive, same-sender) messages
                      normally hide the name/timestamp row entirely — force it to render
                      for an edited message so the marker always has a timestamp to sit
                      next to, rather than dropping it silently.
                    */}
                    {(!grouped || shouldShowEditedMarker(msg)) && (
                      <Flex
                        gap={2}
                        mb="2px"
                        fontSize="xs"
                        color="textMuted"
                        direction={isSelf ? 'row-reverse' : 'row'}
                        align="baseline"
                      >
                        {!grouped && <Text fontWeight="medium" color="text">{displayName}</Text>}
                        <Text title={new Date(msg.createdAt).toLocaleString()}>
                          {formatTimestamp(msg.createdAt, language, copy.groups.chatJustNow, copy.groups.chatMinutesAgo)}
                        </Text>
                        {shouldShowEditedMarker(msg) && (
                          <Text
                            data-testid={`edited-marker-${msg.id}`}
                            fontStyle="italic"
                            color="textMuted"
                          >
                            {copy.groups.msgEditedMarker}
                          </Text>
                        )}
                      </Flex>
                    )}

                    {/* Bubble + reaction trigger side-by-side so the trigger sits at bubble corner */}
                    <Flex
                      direction={isSelf ? 'row-reverse' : 'row'}
                      align="flex-start"
                      gap={1}
                      // Touch long-press: detect touch/pen to open reaction picker (spec §1.2).
                      // 500ms threshold per story brief. No new dependency.
                      onPointerDown={(e: React.PointerEvent) => {
                        if (!onReact) return;
                        if (e.pointerType === 'touch' || e.pointerType === 'pen') {
                          longPressMessageIdRef.current = msg.id;
                          longPressTimerRef.current = setTimeout(() => {
                            // Trigger is revealed visually by focus; programmatic open
                            // is handled by the EmojiReactionPicker's own disclosure.
                            // We imperatively click the trigger button for simplicity.
                            const trigger = document.querySelector<HTMLElement>(
                              `[data-testid="reaction-trigger-${msg.id}"]`,
                            );
                            trigger?.click();
                          }, 500);
                        }
                      }}
                      onPointerUp={() => {
                        if (longPressTimerRef.current) {
                          clearTimeout(longPressTimerRef.current);
                          longPressTimerRef.current = null;
                        }
                      }}
                      onPointerLeave={() => {
                        if (longPressTimerRef.current) {
                          clearTimeout(longPressTimerRef.current);
                          longPressTimerRef.current = null;
                        }
                      }}
                    >
                      <Box
                        {...(structured?.type !== 'image' && grouped
                          ? {
                              borderTopRightRadius: isSelf ? 'sm' : undefined,
                              borderTopLeftRadius: !isSelf ? 'sm' : undefined,
                            }
                          : {})}
                      >
                        {renderStructuredMessage(structured, msg)}
                      </Box>

                      {/* Reaction trigger — revealed on hover via _groupHover (AC-47) */}
                      {onReact && (
                        <Box alignSelf="center" flexShrink={0}>
                          <EmojiReactionPicker
                            messageId={msg.id}
                            message={msg}
                            aggregates={aggregates}
                            onReact={onReact}
                          />
                        </Box>
                      )}

                      {/*
                        S6: edit/delete action menu. AC-AUTH-1: own messages only —
                        `showActions` is gated on `canShowMessageActions`, which never
                        checks age/time (AC-TIME-1: no time-window gate anywhere here).
                        AC-DEL-6: delete requires a second confirming click before
                        handleDeleteMessage fires (computeDeleteConfirmTransition).
                      */}
                      {showActions && (
                        <Box alignSelf="center" flexShrink={0}>
                          {pendingDeleteId === msg.id ? (
                            <Flex gap={1} align="center" data-testid={`action-delete-confirm-row-${msg.id}`}>
                              <Text fontSize="xs" color="red.500" whiteSpace="nowrap">
                                {copy.groups.msgDeleteConfirmPrompt}
                              </Text>
                              <IconButton
                                data-testid={`action-delete-confirm-${msg.id}`}
                                aria-label={copy.groups.msgDeleteConfirmButton}
                                icon={<TrashIcon />}
                                size="xs"
                                variant="ghost"
                                colorScheme="danger"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteClick(msg.id);
                                }}
                              />
                              <CloseButton
                                data-testid={`action-delete-cancel-${msg.id}`}
                                size="sm"
                                aria-label={copy.groups.cancel}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDeleteId(null);
                                }}
                              />
                            </Flex>
                          ) : (
                            <Flex gap={0.5} opacity={0} _groupHover={{ opacity: 1 }} _focusWithin={{ opacity: 1 }}>
                              {canEditMessage(msg) && (
                                <IconButton
                                  data-testid={`action-edit-${msg.id}`}
                                  aria-label={copy.groups.msgEditAction}
                                  icon={<PencilIcon />}
                                  size="xs"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditClick(msg);
                                  }}
                                />
                              )}
                              <IconButton
                                data-testid={`action-delete-${msg.id}`}
                                aria-label={copy.groups.msgDeleteAction}
                                icon={<TrashIcon />}
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteClick(msg.id);
                                }}
                              />
                            </Flex>
                          )}
                        </Box>
                      )}
                    </Flex>

                    {/* Reaction badge row — real implementation (AC-49, story-08) */}
                    {aggregates.length > 0 && onReact && (
                      <ReactionBadgeRow
                        messageId={msg.id}
                        message={msg}
                        aggregates={aggregates}
                        onReact={onReact}
                        profileMap={profileMap}
                        selfPubkey={pubkey}
                      />
                    )}
                  </Flex>
                </Flex>
              );
            })}
          </VStack>
        )}

        {showBadge && (
          <Flex position="sticky" bottom={3} justify="center" mt={2}>
            <Box
              as="button"
              onClick={scrollToBottom}
              data-testid="new-messages-badge"
              px={4}
              py={1}
              borderRadius="full"
              bg="brand.500"
              color="white"
              fontSize="xs"
              fontWeight="medium"
              boxShadow="lg"
              _hover={{ opacity: 0.9 }}
            >
              {copy.groups.chatNewMessages}
            </Box>
          </Flex>
        )}
      </Box>

      <Box
        borderTopWidth="1px"
        borderColor="borderSubtle"
        bg="surfaceMutedBg"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {previewUrl && (
          <Flex px={2} pt={2} align="center" gap={2}>
            <Box position="relative" display="inline-block">
              <Image
                data-testid="image-preview-thumbnail"
                src={previewUrl}
                alt="preview"
                maxH="80px"
                maxW="120px"
                objectFit="cover"
                borderRadius="md"
              />
              <CloseButton
                data-testid="image-preview-remove"
                size="sm"
                position="absolute"
                top="-1"
                right="-1"
                bg="blackAlpha.600"
                color="white"
                borderRadius="full"
                aria-label={copy.groups.imageRemove}
                onClick={removeAttachment}
              />
            </Box>
          </Flex>
        )}

        {imageTooLarge && (
          <Text data-testid="image-too-large-error" px={2} pt={1} fontSize="xs" color="red.500">
            {copy.groups.imageTooLarge}
          </Text>
        )}
        {imageSendFailed && (
          <Flex px={2} pt={1} gap={2} align="center">
            <Text data-testid="image-send-failed" fontSize="xs" color="red.500">
              {copy.groups.imageSendFailed}
            </Text>
            <Box
              as="button"
              data-testid="image-retry-button"
              fontSize="xs"
              color="brand.500"
              onClick={() => void handleSend()}
              _hover={{ textDecoration: 'underline' }}
            >
              {copy.groups.imageRetry}
            </Box>
          </Flex>
        )}

        {/* S6: edit-mode banner (AC-EDIT-5) — visible whenever the composer is editing. */}
        {editingMessage && (
          <Flex px={2} pt={2} align="center" justify="space-between" gap={2} data-testid="chat-edit-banner">
            <Text fontSize="xs" color="textMuted" fontStyle="italic">
              {copy.groups.msgEditingBadge}
            </Text>
            <CloseButton
              data-testid="chat-edit-cancel"
              size="sm"
              aria-label={copy.groups.cancel}
              onClick={handleCancelEdit}
            />
          </Flex>
        )}
        {editingMessage && isEditSubmitBlocked(inputValue) && (
          <Text data-testid="chat-edit-empty-hint" px={2} pt={1} fontSize="xs" color="red.500">
            {copy.groups.msgEditEmptyHint}
          </Text>
        )}

        <Flex p={2} gap={2} align="flex-end">
          {imageAttachmentsAllowed && !editingMessage ? <ImageAttachmentButton onFileSelected={attachFile} /> : null}
          <EmojiComposerPicker onSelect={handleEmojiSelect} handleRef={emojiPickerRef} textareaRef={textareaRef} />
          <Textarea
            ref={textareaRef}
            data-testid="chat-input"
            placeholder={composerPlaceholder ?? copy.groups.chatPlaceholder}
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            minH="36px"
            maxH="128px"
            resize="none"
            overflowY="auto"
            fontSize="sm"
            bg="white"
            _dark={{ bg: 'gray.800' }}
            borderColor="borderSubtle"
          />
          <IconButton
            data-testid="chat-send-btn"
            aria-label={editingMessage ? copy.groups.msgEditSave : copy.groups.chatSend}
            icon={editingMessage ? <SaveIcon /> : <SendIcon />}
            size="sm"
            colorScheme="brand"
            isDisabled={editingMessage ? isEditSubmitBlocked(inputValue) : !inputValue.trim() && !attachedFile}
            onClick={() => void handleSend()}
          />
        </Flex>
      </Box>
    </Flex>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
