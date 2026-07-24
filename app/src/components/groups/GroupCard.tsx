import React, { useEffect, useState } from 'react';
import {
  Box,
  HStack,
  VStack,
  Text,
  Badge,
  LinkBox,
  LinkOverlay,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import type { Group } from '@/src/types';
import { useCopy } from '@/src/context/LanguageContext';
import { loadMessages } from '@/src/lib/marmot/chatPersistence';
import { formatThreadPreviewText } from '@/src/lib/messageEdits/messageActionUi';
import { useUnreadCounts } from '@/src/lib/unreadStore';
import UnreadCountBadge from '@/src/components/UnreadCountBadge';
import { groupCardTotal } from '@/src/lib/notificationCounts';
import { BADGE_ACCENT } from '@/src/lib/badgeAccent';

type GroupCardProps = {
  group: Group;
};

export default function GroupCard({ group }: GroupCardProps) {
  const copy = useCopy();
  // Group card pill = unread messages + pending join requests + invite-link
  // expiries for this group (epic: obsolete-notification-bell, AC-CARD-3). This
  // is a net-new aggregate — the card previously showed only the `counts`
  // (unread messages) slice. The clear semantics per slice are unchanged
  // (opening the chat clears only messages; approving a request / opening
  // manage-links clears those), so opening a group with unread messages AND
  // pending requests drops the pill by only the message count (AC-CLEAR-7).
  const slices = useUnreadCounts();
  const unreadCount = groupCardTotal(slices, group.id);
  const memberCount = group.memberPubkeys.length;
  const nearLimit = memberCount >= 45;

  // S6 (epic-feature-request-message-edit-and-delete): AC-LIST-1/AC-LIST-2 —
  // the group list preview reflects an edit to the thread's last message and
  // falls back past a deleted last message (or to the empty state). Loaded
  // once per mount (mirrors AC-LIST-1's DM-ingest-on-open relaxation: this
  // list has no live chatVersion subscription, so the preview refreshes on
  // next view of the groups list, not live while it's open).
  const [previewText, setPreviewText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMessages(group.id)
      .then(({ messages }) => {
        if (cancelled) return;
        setPreviewText(formatThreadPreviewText(messages, {
          emptyText: copy.groups.listPreviewEmpty,
          photoText: copy.groups.listPreviewPhoto,
          structuredText: copy.groups.listPreviewStructured,
        }));
      })
      .catch(() => {
        if (!cancelled) setPreviewText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [group.id, copy.groups.listPreviewEmpty, copy.groups.listPreviewPhoto, copy.groups.listPreviewStructured]);

  return (
    <LinkBox
      as="article"
      p={4}
      borderWidth="1px"
      borderRadius="lg"
      borderColor="borderSubtle"
      bg="surfaceBg"
      cursor="pointer"
      _hover={{ borderColor: 'brand.400', bg: 'surfaceMutedBg' }}
      transition="all 0.15s"
      data-testid={`group-card-${group.id}`}
    >
      <HStack justify="space-between" align="flex-start" flexWrap="wrap" gap={2}>
        <VStack align="flex-start" spacing={1} flex={1} minW={0}>
          <NextLink href={`/groups?id=${group.id}`} passHref legacyBehavior>
            <LinkOverlay>
              <HStack spacing={2} align="center">
                <Text fontWeight="semibold" fontSize="md" noOfLines={1}>
                  {group.name}
                </Text>
                <UnreadCountBadge
                  count={unreadCount}
                  testId={`group-unread-badge-${group.id}`}
                />
              </HStack>
            </LinkOverlay>
          </NextLink>
          <HStack spacing={2}>
            <Badge
              colorScheme={BADGE_ACCENT.memberCount}
              variant="subtle"
              data-testid={`group-member-count-${group.id}`}
            >
              {copy.groups.memberCount(memberCount)}
            </Badge>
            {nearLimit && (
              <Text fontSize="xs" color="textMuted">
                {copy.groups.softLimitWarning}
              </Text>
            )}
          </HStack>
          {previewText !== null && (
            <Text
              fontSize="xs"
              color="textMuted"
              noOfLines={1}
              data-testid={`group-card-preview-${group.id}`}
            >
              {previewText}
            </Text>
          )}
        </VStack>
      </HStack>
    </LinkBox>
  );
}
