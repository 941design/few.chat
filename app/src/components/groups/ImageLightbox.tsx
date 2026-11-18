import React, { useCallback } from 'react';
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalBody,
  Flex,
  Image,
  IconButton,
  Spinner,
  Text,
  Box,
} from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useDecryptedImage } from '@/src/hooks/useDecryptedImage';
import type { ChatMediaAttachment } from '@/src/lib/media/imageMessage';

type ImageLightboxProps = {
  groupId: string;
  attachment: ChatMediaAttachment;
  senderShortId: string;
  createdAt: number;
  onClose: () => void;
  decryptMedia?: (attachment: ChatMediaAttachment) => Promise<{ bytes: Uint8Array; type: string }>;
};

function formatFilename(senderShortId: string, createdAt: number, mime: string): string {
  const d = new Date(createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const ext = mime === 'image/webp' ? 'webp' : mime.split('/')[1] ?? 'bin';
  const safeSender = senderShortId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeSender}-${datePart}.${ext}`;
}

export default function ImageLightbox({
  groupId,
  attachment,
  senderShortId,
  createdAt,
  onClose,
  decryptMedia,
}: ImageLightboxProps) {
  const copy = useCopy();
  const mediaType = 'imeta' in attachment ? attachment.attachment.mediaType : attachment.type;
  const imageState = useDecryptedImage(groupId, attachment, decryptMedia);

  const handleDownload = useCallback(() => {
    if (imageState.status !== 'ready') return;
    const filename = formatFilename(senderShortId, createdAt, mediaType ?? 'image/webp');
    const a = document.createElement('a');
    a.href = imageState.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [imageState, senderShortId, createdAt, mediaType]);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="full"
      closeOnOverlayClick
      closeOnEsc
    >
      <ModalOverlay />
      <ModalContent bg="blackAlpha.900" m={0} borderRadius={0}>
        <ModalBody p={0} display="flex" flexDirection="column">
          {/* Header bar */}
          <Flex
            justify="flex-end"
            align="center"
            px={4}
            py={2}
            gap={2}
          >
            <IconButton
              data-testid="lightbox-download"
              aria-label={copy.groups.imageDownload}
              icon={<DownloadIcon />}
              size="sm"
              variant="ghost"
              colorScheme="neutral"
              color="white"
              isDisabled={imageState.status !== 'ready'}
              onClick={handleDownload}
            />
            <IconButton
              data-testid="lightbox-close"
              aria-label="Close"
              icon={<CloseIcon />}
              size="sm"
              variant="ghost"
              colorScheme="neutral"
              color="white"
              onClick={onClose}
            />
          </Flex>

          {/* Image area */}
          <Flex flex="1" align="center" justify="center" overflow="auto" p={4}>
            {imageState.status === 'loading' && <Spinner color="white" size="xl" />}

            {imageState.status === 'ready' && (
              <Image
                data-testid="lightbox-image"
                src={imageState.url}
                alt="full resolution"
                maxW="100%"
                maxH="100%"
                objectFit="contain"
              />
            )}

            {(imageState.status === 'decrypt-failed' || imageState.status === 'not-found') && (
              <Box color="whiteAlpha.800" textAlign="center">
                <Text fontSize="sm">
                  {imageState.status === 'not-found'
                    ? copy.groups.imageUnavailable
                    : copy.groups.imageDecryptFailed}
                </Text>
              </Box>
            )}
          </Flex>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
