import React from 'react';
import { Box, Text } from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import type { Copy } from '@/src/lib/i18n';

/**
 * The three invite_lifecycle enum values (mirrors the invite_lifecycle
 * StructuredContent union member frozen by S1 in parseStructured.ts).
 */
export type InviteLifecycleEvent = 'invited' | 'accepted' | 'declined';

type InviteLifecycleChatAnnouncementProps = {
  /** The event this announcement narrates. */
  event: InviteLifecycleEvent;
  /**
   * Display name of the invitee (subject). MUST be resolved by the caller
   * from the payload's `pubkey` field (never from the message's
   * `senderPubkey`) — see `resolveInviteLifecycleSubjectDisplay` below.
   */
  memberDisplay: string;
};

/**
 * Precondition: `event` is one of the 3 enum values (guaranteed by S1's
 * strict parse guard) and `memberDisplay` is a non-empty resolved display
 * string (nickname or truncated npub — never raw hex, never blank).
 *
 * Postcondition: renders a single muted, one-line announcement row with a
 * STABLE `data-testid` ("invite-lifecycle-announcement") and, by
 * construction, no avatar, no message bubble, and no edit/delete/reaction
 * affordances — modelled on LeaveChatAnnouncement.tsx /
 * InviteCancelledChatAnnouncement.tsx (AC-RENDER-3).
 */
export default function InviteLifecycleChatAnnouncement({
  event,
  memberDisplay,
}: InviteLifecycleChatAnnouncementProps) {
  const copy = useCopy();

  return (
    <Box
      px={3}
      py={2}
      borderRadius="md"
      bg="gray.50"
      _dark={{ bg: 'gray.800' }}
      borderLeftWidth="3px"
      borderLeftColor="gray.400"
      data-testid="invite-lifecycle-announcement"
    >
      <Text fontSize="sm" color="textMuted">
        {selectInviteLifecycleCopy(copy, event, memberDisplay)}
      </Text>
    </Box>
  );
}

/**
 * Pure helper: resolves the invitee's display name from `profileMap[pubkey]`,
 * falling back to a truncated npub when no profile is known (AC-RENDER-1).
 *
 * Callers MUST pass the payload's `pubkey` (the subject/invitee) here, never
 * the message's protocol-level `senderPubkey` — this variant's copy is
 * subject-centric and never displays an author, so there is no
 * subject/author conflation path (AC-STRUCT-5's render-time consequence is
 * satisfied by this function never accepting or reading senderPubkey at
 * all).
 *
 * Exported (not just used internally) so it is directly unit-testable
 * without jsdom, mirroring the JoinRequestCard.tsx precedent of exporting
 * pure helpers from a .tsx file for a DOM-free test.
 */
export function resolveInviteLifecycleSubjectDisplay(
  pubkey: string,
  profileMap: Record<string, { nickname?: string }>,
  truncate: (pubkey: string) => string,
): string {
  return profileMap[pubkey]?.nickname ?? truncate(pubkey);
}

/**
 * Pure helper: selects the event-keyed i18n copy string (AC-RENDER-2).
 *
 * The `default` branch is defensively unreachable given S1's strict enum
 * guard (an `event` value outside the 3-member enum never survives
 * parseStructured), but guards against ever rendering `undefined`/blank
 * text if that guard were ever weakened (VQ-S4-006).
 */
export function selectInviteLifecycleCopy(
  copy: Copy,
  event: InviteLifecycleEvent,
  memberDisplay: string,
): string {
  switch (event) {
    case 'invited':
      return copy.groups.inviteLifecycleInvited(memberDisplay);
    case 'accepted':
      return copy.groups.inviteLifecycleAccepted(memberDisplay);
    case 'declined':
      return copy.groups.inviteLifecycleDeclined(memberDisplay);
    default:
      return memberDisplay;
  }
}
