import React, { useMemo } from 'react';
import Head from 'next/head';
import NextLink from 'next/link';
import { Alert, AlertDescription, AlertIcon, Box, Button, Heading, Text } from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import ContactChat from '@/src/components/contacts/ContactChat';
import BlockContactButton from '@/src/components/contacts/BlockContactButton';
import { MAINTAINER_ACTIVE_PUBKEY_HEX, MAINTAINER_DISPLAY_NAME } from '@/src/config/maintainer';
import { isBlockedPeer, loadBlockedPeers } from '@/src/lib/blockedPeers';
import { buildDmProfileMap } from '@/src/lib/contacts';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';

/**
 * Gate-remediation finding 3 (epic: block-contact): whether `/feedback`
 * should render `ContactChat` (composer live) or the Blocked notice instead.
 * The maintainer is addable-by-npub like any other contact (`isMaintainerPubkey`,
 * `processContactInput.ts`) and therefore blockable — while blocked, every
 * send affordance (text/image/paste/drop/reactions) must be unreachable, the
 * same guarantee `ContactDetailView` (`pages/contacts.tsx`) already gives
 * every other blocked contact (AC-VIEW-1/7).
 *
 * Exported and pure so it is unit-testable directly, without mounting React
 * (this repo's hooks-via-pure-function-extraction convention — no jsdom).
 */
export function shouldShowMaintainerBlockedNotice(
  maintainerPubkeyHex: string | null,
  blockedPeers: ReadonlySet<string>,
): boolean {
  return maintainerPubkeyHex != null && isBlockedPeer(maintainerPubkeyHex, blockedPeers);
}

export default function FeedbackPage() {
  const copy = useCopy();
  const { pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { profile: ownProfile } = useProfile();
  // blockedPeersRevision (epic: block-contact, S1) makes this reactive within
  // the same mounted tree — mirrors ContactDetailView's own
  // blockedPeersRevision-keyed re-derive (pages/contacts.tsx) so a block (or
  // unblock) action taken elsewhere while this page is open swaps the
  // composer/notice on the very next render, no navigation required.
  const { blockedPeersRevision } = useMarmot();
  const maintainerBlocked = useMemo(
    () => shouldShowMaintainerBlockedNotice(MAINTAINER_ACTIVE_PUBKEY_HEX, loadBlockedPeers()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blockedPeersRevision is the re-derive trigger, loadBlockedPeers() reads fresh state each call.
    [blockedPeersRevision],
  );

  const signer = useMemo(
    () => (privateKeyHex ? createPrivateKeySigner(privateKeyHex) : null),
    [privateKeyHex],
  );

  if (!MAINTAINER_ACTIVE_PUBKEY_HEX) {
    return (
      <>
        <Head>
          <title>{`${copy.feedback.pageTitle} - ${copy.appName}`}</title>
        </Head>
        <Box data-testid="feedback-unavailable">
          <Text color="textMuted">{copy.feedback.unavailableState}</Text>
        </Box>
      </>
    );
  }

  if (!pubkeyHex || !privateKeyHex || !signer) {
    return null;
  }

  const profileMap = buildDmProfileMap({
    selfHex: pubkeyHex,
    selfProfile: ownProfile,
    peerHex: MAINTAINER_ACTIVE_PUBKEY_HEX,
    peerNickname: MAINTAINER_DISPLAY_NAME,
    peerAvatar: null,
  });

  return (
    <>
      <Head>
        <title>{`${copy.feedback.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="feedback-page">
        <NextLink href="/settings" passHref legacyBehavior>
          <Button as="a" variant="ghost" size="sm" mb={2}>
            ←
          </Button>
        </NextLink>
        <Heading as="h1" size="xl" mb={1}>
          {copy.feedback.pageTitle}
        </Heading>
        <Text color="textMuted" fontSize="sm" mb={4}>
          {copy.feedback.encryptedSubtitle}
        </Text>
        {maintainerBlocked ? (
          // Gate-remediation finding 3: renders INSTEAD OF ContactChat —
          // ContactChat is not mounted at all in this branch, so none of the
          // five send affordances (text, image, paste, drag-drop, reactions)
          // can ever reach the DOM while the maintainer is blocked. Mirrors
          // ContactDetailView's own Blocked banner (pages/contacts.tsx,
          // AC-VIEW-1/7) verbatim, including reusing its Unblock trigger.
          <>
            <Alert status="info" borderRadius="md" mt={4} data-testid="feedback-blocked-alert">
              <AlertIcon />
              <AlertDescription>{copy.contacts.archivedDetailNotice}</AlertDescription>
            </Alert>
            <Box mt={4}>
              <BlockContactButton
                peerPubkeyHex={MAINTAINER_ACTIVE_PUBKEY_HEX}
                isArchived
                onChanged={() => { /* blockedPeersRevision bump already drives the re-derive above */ }}
                testId="feedback-unblock"
              />
            </Box>
          </>
        ) : (
          <ContactChat
            peerPubkeyHex={MAINTAINER_ACTIVE_PUBKEY_HEX}
            pubkeyHex={pubkeyHex}
            privateKeyHex={privateKeyHex}
            signer={signer}
            profileMap={profileMap}
            source="feedback"
            composerPlaceholder={copy.feedback.composerPlaceholder}
          />
        )}
      </Box>
    </>
  );
}
