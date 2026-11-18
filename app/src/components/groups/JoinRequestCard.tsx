import React, { useEffect, useState } from 'react';
import {
  Box,
  Heading,
  Text,
  VStack,
  Button,
  Input,
  Alert,
  AlertIcon,
  AlertDescription,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useCopy } from '@/src/context/LanguageContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useProfile } from '@/src/context/ProfileContext';
import { npubToPubkeyHex } from '@/src/lib/nostrKeys';
import { hasShareableName } from '@/src/lib/shareCard';
import WelcomeInvite from '@/src/components/WelcomeInvite';

type JoinRequestCardProps = {
  nonce: string;
  adminNpub: string;
  groupName: string;
};

// Pure predicates for the name gate (S1) — kept outside the component so they
// can be unit-tested without a DOM/render environment (this repo has no
// jsdom/@testing-library capability). `hasShareableName` is the single source
// of truth for "has a name"; these delegate rather than re-deriving it.
export function isNameGateActive(savedNickname: string): boolean {
  return !hasShareableName(savedNickname);
}

export function isJoinRequestDisabled(gateActive: boolean, draftName: string): boolean {
  return gateActive && !hasShareableName(draftName);
}

// Pre-commit review gate remediation (Finding A, epic first-visit-invite-
// welcome): the isFreshIdentity welcome branch ALWAYS renders an editable
// name field (unlike the returning-user inline card, which only renders one
// when `gateActive`). Gating the welcome action on `gateActive && ...` was
// wrong whenever a first-timer already had a saved, shareable nickname —
// e.g. from completing the /add contact welcome earlier in the same
// session: `gateActive` is false, so the old predicate ignored the visible
// field entirely and stayed enabled even after the field was cleared. The
// welcome variant's VISIBLE field is the sole source of truth, independent
// of whether a name was already saved.
export function isWelcomeJoinRequestDisabled(draftName: string): boolean {
  return !hasShareableName(draftName);
}

export default function JoinRequestCard({ nonce, adminNpub, groupName }: JoinRequestCardProps) {
  const copy = useCopy();
  const { pubkeyHex, hydrated, isFreshIdentity } = useNostrIdentity();
  const { groups, sendJoinRequest, ready } = useMarmot();
  const { profile, saveProfile } = useProfile();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(profile.nickname);

  useEffect(() => {
    setNameDraft(profile.nickname);
  }, [profile.nickname]);

  const gateActive = isNameGateActive(profile.nickname);
  const requestDisabled = isJoinRequestDisabled(gateActive, nameDraft);
  // Welcome branch (isFreshIdentity) uses this instead of `requestDisabled`
  // — see isWelcomeJoinRequestDisabled's comment (Finding A fix).
  const welcomeRequestDisabled = isWelcomeJoinRequestDisabled(nameDraft);

  const adminPubkeyHex = npubToPubkeyHex(adminNpub);

  // Check if the user is already a member of the specific group referenced by this invite link.
  // Match on both admin membership AND group name to avoid blocking joins to a different group
  // when the admin runs multiple groups.
  const alreadyMemberGroupId = adminPubkeyHex
    ? groups.find((g) => g.name === groupName && g.memberPubkeys.includes(adminPubkeyHex) && pubkeyHex && g.memberPubkeys.includes(pubkeyHex))?.id
    : null;

  if (!hydrated) {
    return (
      <Box py={8} textAlign="center">
        <Text color="textMuted">{copy.groups.loading}</Text>
      </Box>
    );
  }

  if (!pubkeyHex || !ready) {
    // Identity not ready — the standard identity setup should run first
    // (handled by NostrIdentityProvider auto-generating on first mount)
    return (
      <Box py={8} textAlign="center">
        <Text color="textMuted">{copy.identity.notReady}</Text>
      </Box>
    );
  }

  if (!adminPubkeyHex) {
    return (
      <Box py={8}>
        <Alert status="error" borderRadius="md">
          <AlertIcon />
          <AlertDescription>{copy.groups.inviteErrorInvalidNpub}</AlertDescription>
        </Alert>
      </Box>
    );
  }

  if (alreadyMemberGroupId) {
    return (
      <Box py={8} data-testid="join-request-already-member">
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

  async function handleSendRequest() {
    if (!pubkeyHex || !ready || !adminPubkeyHex) return;

    if (isFreshIdentity) {
      // Welcome branch (Finding A fix): the visible name field is the sole
      // source of truth for both the disable check and the save — never
      // `gateActive`, which can be false (name already saved earlier this
      // session) while the visible field was subsequently cleared.
      if (welcomeRequestDisabled) return;
      if (nameDraft.trim() !== profile.nickname.trim()) {
        saveProfile({ ...profile, nickname: nameDraft });
      }
    } else {
      if (requestDisabled) return;
      if (gateActive) {
        saveProfile({ ...profile, nickname: nameDraft });
      }
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
      setSent(true);
    } catch (err) {
      console.error('[JoinRequestCard] Failed to send join request:', err);
      setError(copy.groups.joinRequestError);
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Box py={8} data-testid="join-request-sent">
        <Alert status="success" borderRadius="md">
          <AlertIcon />
          <AlertDescription>{copy.groups.joinRequestSent}</AlertDescription>
        </Alert>
      </Box>
    );
  }

  // Epic: first-visit-invite-welcome, story S4 (AC-GROUP-1..4). A GENUINE
  // first-time visitor (`isFreshIdentity`, S1's seam) who opens a group
  // invite link is shown the blended `WelcomeInvite` (group variant)
  // INSTEAD of the inline card below — hosting the SAME nameDraft /
  // handleSendRequest state this component already computes. This is the
  // only render branch that differs between a first-timer and a returning
  // user: every guard above (loading, identity-not-ready, invalid admin
  // npub, already-a-member) and the `sent` confirmation above both fire
  // identically for both variants, and a returning user
  // (`isFreshIdentity === false`) renders the pre-existing card below,
  // byte-identical to pre-S4 behavior (AC-RETURN-2). There is exactly one
  // rendered tree at a time — never both — so "no separate join card shown
  // afterward" (AC-GROUP-1) holds by construction.
  //
  // Gate-remediation (Finding A): the disable predicate for THIS branch is
  // `welcomeRequestDisabled` (visible-field-only), not the shared
  // `requestDisabled` (which folds in `gateActive` and is used by the
  // returning-user inline card below, unchanged). See
  // isWelcomeJoinRequestDisabled's comment above for why.
  if (isFreshIdentity) {
    return (
      <Box py={8} data-testid="join-request-welcome-wrapper">
        {error && (
          <Alert status="error" borderRadius="md" maxW="md" mx="auto" mb={4}>
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <WelcomeInvite
          inviteLine={copy.welcome.groupInviteLine(groupName)}
          nameValue={nameDraft}
          onNameChange={setNameDraft}
          primaryActionLabel={copy.groups.joinRequestButton}
          primaryActionDisabled={welcomeRequestDisabled}
          onPrimaryAction={() => void handleSendRequest()}
          primaryActionLoading={sending}
        />
      </Box>
    );
  }

  return (
    <Box py={8} data-testid="join-request-card">
      <VStack spacing={4} align="stretch" maxW="md" mx="auto">
        <Heading as="h2" size="lg" textAlign="center">
          {copy.groups.joinRequestHeading}
        </Heading>
        <Text textAlign="center" fontSize="lg">
          <strong>{groupName}</strong>
        </Text>
        <Text textAlign="center" color="textMuted">
          {copy.groups.joinRequestDescription}
        </Text>

        {gateActive && (
          <Box data-testid="join-request-name-gate">
            <Text fontWeight="semibold" mb={1}>
              {copy.groups.joinRequestNameLabel}
            </Text>
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              bg="surfaceBg"
              data-testid="join-request-name-input"
            />
            <Text fontSize="sm" color="textMuted" mt={1}>
              {copy.groups.joinRequestNameHelper}
            </Text>
            {requestDisabled && (
              <Text fontSize="xs" color="textMuted" mt={1} data-testid="join-request-name-required-hint">
                {copy.groups.joinRequestNameRequiredHint}
              </Text>
            )}
          </Box>
        )}

        {error && (
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={() => void handleSendRequest()}
          isLoading={sending}
          isDisabled={requestDisabled}
          size="lg"
          data-testid="join-request-send-btn"
        >
          {copy.groups.joinRequestButton}
        </Button>
      </VStack>
    </Box>
  );
}
