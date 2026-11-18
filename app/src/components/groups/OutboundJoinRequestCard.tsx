/**
 * OutboundJoinRequestCard — dimmed, non-interactive card for an outbound
 * (already-sent, not-yet-approved) join request, rendered in the groups list
 * (epic: invite-link-awaiting-landing, story S4; AC-CARD-1..3, AC-REACT-2).
 *
 * Rendered once per record from `useOutboundJoinRequests()` (S2's reactive
 * store), AFTER the joined-group `GroupCard`s in `groups.tsx`'s list view —
 * never interleaved, never sorted together (DD-3).
 *
 * This is a plain, non-navigating `Box` — NOT a `LinkBox`/`LinkOverlay` and
 * with no `onClick`/`href` of its own (AC-CARD-2): unlike `GroupCard`, an
 * outbound request has no group detail view to navigate to yet, so the card
 * body does nothing when clicked. The ONLY interactive element is the Cancel
 * button.
 *
 * Cancel calls `cancelOutboundJoinRequest` (the sole sanctioned UI-facing
 * mutation entry point per outboundJoinRequests.ts's own doc comment,
 * AC-STORE-5) and nothing else — the already-sent join-request rumor is
 * never re-signaled to the admin in any way (AC-CARD-3, DD-4). On success, the
 * reactive store's emitter removes this record from the parent's list on its
 * own (AC-REACT-2); this component does not need to (and after a successful
 * cancel, typically can't — it may already be unmounted) reset local state.
 */

import { useState } from 'react';
import { Box, Badge, Button, HStack, VStack, Text } from '@chakra-ui/react';
import type { OutboundJoinRequestRecord } from '@/src/lib/marmot/outboundJoinRequests';
import { cancelOutboundJoinRequest } from '@/src/lib/marmot/outboundJoinRequests';
import { useCopy } from '@/src/context/LanguageContext';
import { BADGE_ACCENT } from '@/src/lib/badgeAccent';

type OutboundJoinRequestCardProps = {
  record: OutboundJoinRequestRecord;
};

export default function OutboundJoinRequestCard({ record }: OutboundJoinRequestCardProps) {
  const copy = useCopy();
  const nonce6 = record.nonce.slice(0, 6);
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelOutboundJoinRequest(record.nonce, record.accountPubkey);
    } finally {
      // On success the reactive store's emitter drops this record and the card
      // unmounts (AC-REACT-2), so this setState is a harmless no-op (React 19
      // tolerates setState on an unmounting component). But
      // cancelOutboundJoinRequest never throws — deleteOutboundJoinRequest
      // swallows storage errors — so if the IDB delete silently fails the
      // record REMAINS and the card stays mounted. Resetting here (rather than
      // only in a now-unreachable catch) prevents the Cancel button from being
      // stuck in a loading spinner forever (Codex pre-commit review, P3).
      setCancelling(false);
    }
  }

  return (
    <Box
      p={4}
      borderWidth="1px"
      borderRadius="lg"
      borderColor="borderSubtle"
      bg="surfaceBg"
      opacity={0.6}
      data-testid={`outbound-request-card-${nonce6}`}
    >
      <HStack justify="space-between" align="center" flexWrap="wrap" gap={2}>
        <VStack align="flex-start" spacing={1} flex={1} minW={0}>
          <HStack spacing={2} align="center">
            <Text fontWeight="semibold" fontSize="md" noOfLines={1}>
              {record.groupName}
            </Text>
            <Badge colorScheme={BADGE_ACCENT.awaiting} variant="subtle">
              {copy.groups.awaitingBadgeLabel}
            </Badge>
          </HStack>
        </VStack>
        <Button
          size="sm"
          variant="outline"
          colorScheme="danger"
          isLoading={cancelling}
          onClick={() => void handleCancel()}
          data-testid={`cancel-outbound-request-${nonce6}`}
        >
          {copy.groups.cancelOutboundRequestLabel}
        </Button>
      </HStack>
    </Box>
  );
}
