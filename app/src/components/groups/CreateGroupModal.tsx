import React, { useState } from 'react';
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Button,
  FormControl,
  FormLabel,
  Input,
  VStack,
  Alert,
  AlertIcon,
  AlertDescription,
} from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';

type CreateGroupModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export default function CreateGroupModal({ isOpen, onClose }: CreateGroupModalProps) {
  const copy = useCopy();
  const { createGroup, ready } = useMarmot();
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    // Not before the MLS client is ready: createGroup would return null and
    // surface a generic error (BACKLOG create-group-enabled-before-client-ready).
    if (!name.trim() || !ready) return;
    setIsLoading(true);
    setError(null);

    try {
      const group = await createGroup(name.trim());
      if (group) {
        setName('');
        onClose();
      } else {
        setError(copy.groups.createGroupError);
      }
    } catch (err) {
      setError(copy.groups.createGroupError);
      console.error('[CreateGroupModal] createGroup failed:', err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleClose() {
    setName('');
    setError(null);
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} isCentered data-testid="create-group-modal">
      <ModalOverlay />
      <ModalContent data-testid="create-group-modal-content">
        <ModalHeader>{copy.groups.createGroupTitle}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack spacing={4} align="stretch">
            {error && (
              <Alert status="error" borderRadius="md" data-testid="create-group-error">
                <AlertIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FormControl isRequired>
              <FormLabel>{copy.groups.createGroupNameLabel}</FormLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSubmit();
                }}
                data-testid="create-group-name-input"
                maxLength={64}
                bg="surfaceBg"
              />
            </FormControl>
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="ghost"
            mr={3}
            onClick={handleClose}
            isDisabled={isLoading}
          >
            {copy.groups.cancel}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            isLoading={isLoading}
            isDisabled={!name.trim() || !ready}
            data-testid="create-group-submit-btn"
          >
            {copy.groups.createGroupSubmit}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
