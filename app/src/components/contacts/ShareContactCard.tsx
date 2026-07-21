import React, { useCallback, useRef, useState } from 'react';
import NextLink from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Heading,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import NpubQrModal from '@/src/components/groups/NpubQrModal';
import { useCopy } from '@/src/context/LanguageContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import { getOwnShareCard, hasShareableName, type ShareCardCacheEntry } from '@/src/lib/shareCard';

/**
 * ShareContactCard — the "Share contact card" surface (epic:
 * contact-card-exchange, story S6), extracted from `pages/profile.tsx` so the
 * contacts page can offer the same affordance at the top of the list without a
 * second copy of the cache/signer/error logic.
 *
 * Each mounted instance owns its own in-memory cache ref, so the two pages do
 * not share a cached card — a card is signed at most once per page per
 * (nickname, signerMode, pubkeyHex, nonce), which is the same cost the profile
 * page already paid alone. Nothing is persisted and no key material is held:
 * the signer is re-derived on every cache MISS via the existing
 * `activeEventSignerOverride ?? createPrivateKeySigner` precedent.
 */
export default function ShareContactCard({
  headingAs = 'h2',
  context = 'profile',
}: {
  headingAs?: 'h2' | 'h3';
  // Where this card is mounted. The profile page carries the name field itself,
  // so its "needs a name" hint points "above"; the contacts page has no name
  // field, so it instead links the visitor to the profile page to set one.
  context?: 'profile' | 'contacts';
}) {
  const copy = useCopy();
  const { npub, pubkeyHex, privateKeyHex, signerMode } = useNostrIdentity();
  const { profile: savedProfile } = useProfile();
  const shareCardDisclosure = useDisclosure();

  // In-memory only (never persisted, never holds signer/key material). Keyed by
  // (nickname, signerMode, pubkeyHex, nonce) so a repeat open with an unchanged
  // key reuses the cached card instead of re-signing, while a nickname edit,
  // signer-mode switch, identity restore, or nonce rotation invalidates it.
  const shareCardCacheRef = useRef<ShareCardCacheEntry | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCardLoading, setShareCardLoading] = useState(false);
  const [shareCardError, setShareCardError] = useState<string | null>(null);

  // Sharing is only allowed once a name is set — a card must never go out as a
  // bare npub. Mirrors the disabled Share button below and getOwnShareCard's
  // own guard.
  const canShareCard = hasShareableName(savedProfile.nickname);

  const handleShareCard = useCallback(async () => {
    setShareCardError(null);
    if (!npub || !privateKeyHex || !pubkeyHex) return;
    if (!hasShareableName(savedProfile.nickname)) return;

    setShareCardLoading(true);
    try {
      const result = await getOwnShareCard({
        pubkeyHex,
        nickname: savedProfile.nickname,
        signerMode,
        cache: shareCardCacheRef.current,
        getSignEvent: async () => {
          const { activeEventSignerOverride, createPrivateKeySigner } = await import(
            '@/src/lib/marmot/signerAdapter'
          );
          const signer = activeEventSignerOverride.current ?? createPrivateKeySigner(privateKeyHex);
          return signer.signEvent;
        },
      });
      shareCardCacheRef.current = result.cache;
      setShareUrl(result.shareUrl);
      shareCardDisclosure.onOpen();
    } catch (err) {
      console.error('[ShareContactCard] Failed to build share card:', err);
      setShareCardError(copy.profile.shareCardError);
    } finally {
      setShareCardLoading(false);
    }
  }, [npub, privateKeyHex, pubkeyHex, savedProfile.nickname, signerMode, copy.profile.shareCardError, shareCardDisclosure]);

  return (
    <>
      <Box>
        <Heading as={headingAs} size="md" mb={1}>
          {copy.profile.shareCardHeading}
        </Heading>
        <Text fontSize="sm" color="textMuted" mb={4}>
          {copy.profile.shareCardDescription}
        </Text>
        <Button
          colorScheme="brand"
          onClick={() => void handleShareCard()}
          isLoading={shareCardLoading}
          isDisabled={!canShareCard}
          data-testid="profile-share-card-btn"
        >
          {copy.profile.shareCardButton}
        </Button>
        {!canShareCard && (
          <Alert status="warning" borderRadius="md" mt={3} data-testid="profile-share-card-needs-name">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              {context === 'contacts' ? (
                <>
                  {copy.profile.shareCardNeedsNameContacts}{' '}
                  <NextLink href="/profile" passHref legacyBehavior>
                    <Button as="a" variant="link" size="sm">
                      {copy.profile.shareCardNeedsNameContactsLink}
                    </Button>
                  </NextLink>
                </>
              ) : (
                copy.profile.shareCardNeedsName
              )}
            </AlertDescription>
          </Alert>
        )}
        {shareCardError && (
          <Alert status="error" borderRadius="md" mt={3} data-testid="profile-share-card-error">
            <AlertIcon />
            <AlertDescription fontSize="sm">{shareCardError}</AlertDescription>
          </Alert>
        )}
      </Box>

      <NpubQrModal
        isOpen={shareCardDisclosure.isOpen}
        onClose={shareCardDisclosure.onClose}
        title={copy.profile.shareCardTitle}
        mode="display"
        npub={npub ?? undefined}
        shareUrl={shareUrl ?? undefined}
        copyButtonLabel={copy.profile.copyCardLink}
        copiedButtonLabel={copy.profile.copiedCardLink}
        validityHint={copy.profile.shareCardValidityHint}
        qrErrorMessage={copy.identity.qrGenerationError}
      />
    </>
  );
}
