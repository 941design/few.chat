/**
 * InviteAwaitingBanner — returning-user info banner for a group invite link
 * (epic: invite-link-awaiting-landing, story S3).
 *
 * Rendered by `groups.tsx`'s returning-user (non-`isFreshIdentity`) branch
 * when `?join=&admin=&name=` are all present, ABOVE the normal groups list
 * (AC-LAND-1). Visually and structurally distinct from `PendingInvitations`
 * (AC-BANNER-5) — its own container, never merged into that section's list
 * or heading.
 *
 * State is driven entirely by `resolveInviteBannerState` (app/src/lib/
 * inviteBannerState.ts), the shared pure decision function also covering the
 * groups.tsx first-visit branch, fed by:
 *   - S2's reactive `useOutboundJoinRequests()` (subscribe/getSnapshot
 *     surface) for the Invited-vs-Awaiting decision and its loaded flag
 *     (AC-LAND-4 flash-avoidance).
 *   - `MarmotContext`'s `groups` for the already-a-member check (AC-BANNER-4),
 *     mirroring `JoinRequestCard`'s own `alreadyMemberGroupId` derivation.
 *
 * The inline "Request to join" action reuses `sendJoinRequest`
 * (joinRequestSender.ts) directly — no re-implementation of the NIP-59
 * gift-wrap logic — and gates its visible name field with
 * `isWelcomeJoinRequestDisabled`, the SAME predicate `JoinRequestCard`
 * applies for its own always-visible-field (welcome) variant (AC-BANNER-3):
 * the visible field is the sole source of truth, independent of whether a
 * name was already saved (mirrors JoinRequestCard's Finding-A fix — see its
 * doc comment on `isWelcomeJoinRequestDisabled`).
 *
 * On a successful send, `router.replace` strips `join`/`admin`/`name` from
 * the URL (AC-LAND-3, via `computeGroupsPathAfterJoinSend`); the reactive
 * store then flips this banner from Invited to Awaiting with no manual
 * reload (AC-REACT-3) for as long as the component stays mounted with the
 * query params still present in this render pass.
 */

import React, { useEffect, useState } from 'react';
import {
  Box,
  Alert,
  AlertIcon,
  AlertDescription,
  Button,
  Input,
  Text,
  VStack,
  HStack,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import NextLink from 'next/link';
import { useCopy } from '@/src/context/LanguageContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useProfile } from '@/src/context/ProfileContext';
import { npubToPubkeyHex } from '@/src/lib/nostrKeys';
import { useOutboundJoinRequests } from '@/src/hooks/useOutboundJoinRequests';
import { isWelcomeJoinRequestDisabled } from '@/src/components/groups/JoinRequestCard';
import { resolveInviteBannerState, computeGroupsPathAfterJoinSend } from '@/src/lib/inviteBannerState';

type InviteAwaitingBannerProps = {
  nonce: string;
  adminNpub: string;
  groupName: string;
};

export default function InviteAwaitingBanner({ nonce, adminNpub, groupName }: InviteAwaitingBannerProps) {
  const copy = useCopy();
  const router = useRouter();
  const { hydrated, pubkeyHex } = useNostrIdentity();
  const { groups, sendJoinRequest, ready } = useMarmot();
  const { profile, saveProfile } = useProfile();
  const { records, loaded } = useOutboundJoinRequests();

  const [nameDraft, setNameDraft] = useState(profile.nickname);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(profile.nickname);
  }, [profile.nickname]);

  const adminPubkeyHex = npubToPubkeyHex(adminNpub);

  // Mirrors JoinRequestCard's alreadyMemberGroupId derivation exactly
  // (AC-BANNER-4): match on both admin membership AND group name so a
  // multi-group admin doesn't block a join to a DIFFERENT group of theirs.
  const alreadyMemberGroupId = adminPubkeyHex
    ? groups.find(
        (g) =>
          g.name === groupName &&
          g.memberPubkeys.includes(adminPubkeyHex) &&
          pubkeyHex &&
          g.memberPubkeys.includes(pubkeyHex),
      )?.id
    : null;

  const account = pubkeyHex?.toLowerCase();
  const nonceHasUnexpiredRecord = !!account && records.some((r) => r.accountPubkey === account && r.nonce === nonce);

  const state = resolveInviteBannerState({
    hasJoinParams: true,
    // This component is only ever mounted from groups.tsx's returning-user
    // (non-isFreshIdentity) branch — the first-visit case never reaches
    // here, so it is always passed as false.
    isFreshIdentity: false,
    isAlreadyMember: !!alreadyMemberGroupId,
    nonceHasUnexpiredRecord,
    loaded,
  });

  // Identity not yet hydrated, or an invalid admin npub on the link: render
  // nothing rather than a half-ready banner. Neither is a target state of
  // this story's ACs.
  if (!hydrated || !pubkeyHex || !ready || !adminPubkeyHex) return null;

  if (state === 'loading' || state === 'none' || state === 'first-visit') return null;

  if (state === 'already-member') {
    return (
      <Box data-testid="invite-awaiting-banner-already-member" mb={6}>
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <AlertDescription>
            {copy.groups.joinRequestAlreadyMember}{' '}
            <NextLink href={`/groups?id=${alreadyMemberGroupId}`} passHref legacyBehavior>
              <Button as="a" variant="link" size="sm">
                {copy.groups.joinRequestGoToGroup}
              </Button>
            </NextLink>
          </AlertDescription>
        </Alert>
      </Box>
    );
  }

  if (state === 'awaiting') {
    return (
      <Box data-testid="invite-awaiting-banner" mb={6}>
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <AlertDescription>{copy.groups.awaitingApprovalBanner(groupName)}</AlertDescription>
        </Alert>
      </Box>
    );
  }

  // state === 'invited'
  const requestDisabled = isWelcomeJoinRequestDisabled(nameDraft);

  async function handleSend() {
    if (!pubkeyHex || !ready || !adminPubkeyHex) return;
    if (isWelcomeJoinRequestDisabled(nameDraft)) return;

    if (nameDraft.trim() !== profile.nickname.trim()) {
      saveProfile({ ...profile, nickname: nameDraft });
    }

    setSending(true);
    setError(null);
    try {
      await sendJoinRequest({
        adminPubkeyHex,
        nonce,
        groupName,
        requesterName: nameDraft,
      });
      // AC-LAND-3: strip join/admin/name from the URL. AC-REACT-3: the
      // reactive useOutboundJoinRequests() subscription above (not this
      // call) is what flips this banner Invited -> Awaiting; this call
      // only cleans up the URL so a subsequent reload renders from
      // persistence rather than re-showing the pre-confirm banner.
      void router.replace(computeGroupsPathAfterJoinSend(router.asPath));
    } catch (err) {
      console.error('[InviteAwaitingBanner] Failed to send join request:', err);
      setError(copy.groups.joinRequestError);
    } finally {
      setSending(false);
    }
  }

  return (
    <Box data-testid="invite-awaiting-banner" mb={6}>
      <Alert status="info" borderRadius="md" flexDirection="column" alignItems="flex-start" gap={2}>
        <HStack width="100%">
          <AlertIcon />
          <AlertDescription>{copy.groups.inviteAwaitingBanner(groupName)}</AlertDescription>
        </HStack>
        <VStack spacing={2} align="stretch" width="100%" pl={6}>
          <Box>
            <Text fontSize="sm" fontWeight="semibold" mb={1}>
              {copy.groups.joinRequestNameLabel}
            </Text>
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              bg="surfaceBg"
              size="sm"
              maxW="sm"
              data-testid="invite-awaiting-name-input"
            />
          </Box>
          {error && (
            <Alert status="error" borderRadius="md" py={1}>
              <AlertDescription fontSize="sm">{error}</AlertDescription>
            </Alert>
          )}
          <Button
            onClick={() => void handleSend()}
            isLoading={sending}
            isDisabled={requestDisabled}
            size="sm"
            alignSelf="flex-start"
            data-testid="invite-awaiting-request-btn"
          >
            {copy.groups.joinRequestButton}
          </Button>
        </VStack>
      </Alert>
    </Box>
  );
}
