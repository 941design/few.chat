import React, { useState } from 'react';
import { Box, Flex, Image, Text } from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useDecryptedImage } from '@/src/hooks/useDecryptedImage';
import { splitLinks } from '@/src/lib/linkify';
import type { ChatMediaAttachment, RoledAttachments } from '@/src/lib/media/imageMessage';
import { truncateNpub, pubkeyToNpub } from '@/src/lib/nostrKeys';
import ImageLightbox from './ImageLightbox';

type ImageMessageBubbleProps = {
  groupId: string;
  caption: string;
  attachments: RoledAttachments;
  senderPubkey?: string;
  createdAt?: number;
  decryptMedia?: (attachment: ChatMediaAttachment) => Promise<{ bytes: Uint8Array; type: string }>;
};

export default function ImageMessageBubble({ groupId, caption, attachments, senderPubkey, createdAt, decryptMedia }: ImageMessageBubbleProps) {
  const copy = useCopy();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const senderShortId = senderPubkey ? truncateNpub(pubkeyToNpub(senderPubkey)) : 'unknown';

  const thumbAttachment = attachments.thumb;
  const fullAttachment = attachments.full;
  // Prefer the thumbnail for inline display, but when only one attachment is
  // present (or the thumb role is missing) fall back to the full image so the
  // bubble still renders and the lightbox can open.
  const displayAttachment = thumbAttachment ?? fullAttachment;
  const lightboxAttachment = fullAttachment ?? thumbAttachment;

  const displayState = useDecryptedImage(groupId, displayAttachment, decryptMedia);

  const blurhash = displayAttachment && 'blurhash' in displayAttachment ? displayAttachment.blurhash : undefined;

  return (
    <Box maxW="260px">
      <Box
        borderRadius="lg"
        overflow="hidden"
        bg="surfaceMutedBg"
        cursor="pointer"
        onClick={() => displayState.status === 'ready' && setLightboxOpen(true)}
        position="relative"
        minH="80px"
        minW="120px"
      >
        {/* Always render blurhash placeholder (shown until image loads) */}
        {displayState.status === 'loading' && (
          <Flex
            data-testid="image-blurhash-placeholder"
            align="center"
            justify="center"
            minH="80px"
            bg={blurhash ? 'gray.200' : 'gray.100'}
            borderRadius="lg"
          >
            <Box w="100%" h="80px" bg="gray.200" borderRadius="lg" />
          </Flex>
        )}

        {displayState.status === 'ready' && (
          <Image
            data-testid="image-thumbnail"
            src={displayState.url}
            alt={caption || 'image'}
            maxW="260px"
            maxH="200px"
            objectFit="cover"
            borderRadius="lg"
            display="block"
          />
        )}

        {displayState.status === 'decrypt-failed' && (
          <Flex
            data-testid="image-decrypt-failed"
            align="center"
            justify="center"
            p={3}
            minH="60px"
            bg="red.50"
            borderRadius="lg"
          >
            <Text fontSize="xs" color="red.600" textAlign="center">
              {copy.groups.imageDecryptFailed}
            </Text>
          </Flex>
        )}

        {displayState.status === 'not-found' && (
          <Flex
            data-testid="image-unavailable"
            align="center"
            justify="center"
            p={3}
            minH="60px"
            bg="gray.100"
            borderRadius="lg"
          >
            <Text fontSize="xs" color="textMuted" textAlign="center">
              {copy.groups.imageUnavailable}
            </Text>
          </Flex>
        )}
      </Box>

      {caption.length > 0 && (
        <Text
          data-testid="image-caption"
          fontSize="sm"
          mt={1}
          whiteSpace="pre-wrap"
          wordBreak="break-word"
        >
          {splitLinks(caption).map((token, i) =>
            token.type === 'link' ? (
              <a key={i} href={token.value} target="_blank" rel="noopener noreferrer">
                {token.value}
              </a>
            ) : (
              token.value
            ),
          )}
        </Text>
      )}

      {lightboxOpen && lightboxAttachment && (
        <ImageLightbox
          groupId={groupId}
          attachment={lightboxAttachment}
          senderShortId={senderShortId}
          createdAt={createdAt ?? Date.now()}
          onClose={() => setLightboxOpen(false)}
          decryptMedia={decryptMedia}
        />
      )}
    </Box>
  );
}
