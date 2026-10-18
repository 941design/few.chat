/**
 * InvitationCard — a single inline, fully-coloured invitation card rendered
 * at the top of the groups list (epic: inline-invitation-cards, S2).
 *
 * Replaces the separate `<PendingInvitations />` section: each pending
 * Welcome now renders as its own card, styled identically to `GroupCard`
 * (never dimmed — unlike `OutboundJoinRequestCard`, which is deliberately
 * dimmed/non-interactive). The list-mapping and store subscription live in
 * the parent (`app/pages/groups.tsx`) — this component is a pure per-item
 * card.
 *
 * Group-name resolution is local-only: `getInvitationGroupData` (S1) decodes
 * the stored Welcome without any relay call. Attribution goes through
 * `resolveInviterLabel` (S1), which reads the local contact list only. Per
 * the project privacy invariant, this component must never publish, sync,
 * or fetch profile/group data over any public channel.
 */

import { acceptErrorKind } from '@/src/lib/marmot/inviteAcceptError';
import React, { useEffect, useState } from 'react';
import {
  Box,
  HStack,
  VStack,
  Text,
  Badge,
  Button,
  Alert,
  AlertDescription,
  LinkBox,
  LinkOverlay,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { resolveInviterLabel } from '@/src/lib/pubkeyDisplay';
import { BADGE_ACCENT } from '@/src/lib/badgeAccent';
import type { PendingInvitation } from '@/src/lib/pendingInvitations';

type InvitationGroupData = { name: string; description: string; adminPubkeys: string[] } | null;

/**
 * Pure selection of the display name for an invitation card: the decoded
 * group name when present and non-empty, otherwise the fallback copy. Both
 * the "still pending" (groupData === null) and "resolved but undecodable"
 * (groupData.name === '') cases resolve to the same fallback — a blank name
 * must never render (AC-DATA-2).
 */
export function selectInvitationDisplayName(
  groupData: { name: string } | null,
  fallback: string,
): string {
  return groupData?.name ? groupData.name : fallback;
}

type InvitationCardProps = {
  invitation: PendingInvitation;
};

export default function InvitationCard({ invitation }: InvitationCardProps) {
  const copy = useCopy();
  const { acceptPendingInvitation, declinePendingInvitation, getInvitationGroupData } = useMarmot();
  const { pubkeyHex } = useNostrIdentity();

  const [groupData, setGroupData] = useState<InvitationGroupData>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getInvitationGroupData(invitation.welcomeEventJson)
      .then((data) => {
        if (!cancelled) setGroupData(data);
      })
      .catch(() => {
        if (!cancelled) setGroupData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [invitation.welcomeEventJson, getInvitationGroupData]);

  const displayName = selectInvitationDisplayName(
    groupData,
    copy.groups.pendingInvitations.unknownGroupFallback,
  );
  const inviterLabel = resolveInviterLabel(invitation.inviterPubkeyHex, pubkeyHex);

  async function handleAccept() {
    setAccepting(true);
    setError(undefined);
    try {
      await acceptPendingInvitation(invitation.id);
    } catch (err) {
      setError(acceptErrorKind(err));
    } finally {
      setAccepting(false);
    }
  }

  function handleDecline() {
    void declinePendingInvitation(invitation.id);
  }

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
      data-testid={`invitation-card-${invitation.id}`}
    >
      <HStack justify="space-between" align="flex-start" flexWrap="wrap" gap={2}>
        {/* Legacy compatibility hook: ~19 peripheral e2e spec files plus
            helpers/group-setup.ts's invite-accept helper poll
            `[data-testid^="pending-invitation-row-"]` as a readiness gate
            before interacting with an invitation card. Kept alongside the
            new `invitation-card-*` testid on the outer LinkBox above — do
            not remove. */}
        <VStack
          align="flex-start"
          spacing={1}
          flex={1}
          minW={0}
          data-testid={`pending-invitation-row-${invitation.id}`}
        >
          <NextLink href={`/groups?invite=${invitation.id}`} passHref legacyBehavior>
            <LinkOverlay>
              <HStack spacing={2} align="center">
                <Text fontWeight="semibold" fontSize="md" noOfLines={1}>
                  {displayName}
                </Text>
                <Badge colorScheme={BADGE_ACCENT.invitation} variant="subtle">
                  {copy.groups.pendingInvitations.badge}
                </Badge>
              </HStack>
            </LinkOverlay>
          </NextLink>
          <Text fontSize="xs" color="textMuted" noOfLines={1}>
            {copy.groups.pendingInvitations.invitedBy(inviterLabel)}
          </Text>
        </VStack>
        {/* position/zIndex keep these controls clickable above LinkOverlay's
            full-card ::before overlay when the card is a link. */}
        <HStack spacing={2} flexShrink={0} position="relative" zIndex={1}>
          <Button
            size="sm"
            colorScheme="success"
            onClick={() => void handleAccept()}
            isLoading={accepting}
            data-testid={`accept-invitation-${invitation.id}`}
          >
            {copy.groups.pendingInvitations.acceptBtn}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDecline}
            isDisabled={accepting}
            data-testid={`decline-invitation-${invitation.id}`}
          >
            {copy.groups.pendingInvitations.declineBtn}
          </Button>
        </HStack>
      </HStack>
      {error && (
        <Alert status="error" mt={1} borderRadius="md" py={1} px={3}>
          <AlertDescription fontSize="xs">
            {error === 'retry'
              ? copy.groups.pendingInvitations.acceptRetryError
              : copy.groups.pendingInvitations.acceptError}
          </AlertDescription>
        </Alert>
      )}
    </LinkBox>
  );
}
