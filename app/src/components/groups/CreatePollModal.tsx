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
  Textarea,
  VStack,
  HStack,
  IconButton,
  RadioGroup,
  Radio,
  Alert,
  AlertIcon,
  AlertDescription,
  Text,
} from '@chakra-ui/react';
import { usePollStore } from '@/src/context/PollStoreContext';
import { useCopy } from '@/src/context/LanguageContext';
import { POLL_LIMITS } from '@/src/lib/marmot/pollSync';

type CreatePollModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

// Shared with the receive side (parsePollOpen) so both enforce identical caps.
const { MIN_OPTIONS, MAX_OPTIONS, MAX_TITLE_LEN, MAX_DESC_LEN, MAX_OPTION_LEN } = POLL_LIMITS;

export default function CreatePollModal({ isOpen, onClose }: CreatePollModalProps) {
  const { createPoll } = usePollStore();
  const copy = useCopy();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [pollType, setPollType] = useState<'singlechoice' | 'multiplechoice'>('singlechoice');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nonEmptyOptions = options.filter((o) => o.trim());
  const canSubmit = title.trim() && nonEmptyOptions.length >= MIN_OPTIONS;

  function addOption() {
    if (options.length < MAX_OPTIONS) {
      setOptions((prev) => [...prev, '']);
    }
  }

  function removeOption(index: number) {
    if (options.length <= MIN_OPTIONS) return;
    setOptions((prev) => prev.filter((_, i) => i !== index));
  }

  function updateOption(index: number, value: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setIsLoading(true);
    setError(null);

    try {
      const pollId = await createPoll(
        title.trim(),
        description.trim() || undefined,
        nonEmptyOptions.map((label) => ({ label: label.trim() })),
        pollType,
      );
      if (pollId) {
        handleClose();
      } else {
        setError(copy.polls.createError);
      }
    } catch (err) {
      setError(copy.polls.createError);
      console.error('[CreatePollModal] createPoll failed:', err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleClose() {
    setTitle('');
    setDescription('');
    setOptions(['', '']);
    setPollType('singlechoice');
    setError(null);
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} isCentered size="lg">
      <ModalOverlay />
      <ModalContent data-testid="create-poll-modal">
        <ModalHeader>{copy.polls.createPoll}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack spacing={4} align="stretch">
            {error && (
              <Alert status="error" borderRadius="md" data-testid="create-poll-error">
                <AlertIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FormControl isRequired>
              <FormLabel>{copy.polls.questionLabel}</FormLabel>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={copy.polls.questionPlaceholder}
                maxLength={MAX_TITLE_LEN}
                data-testid="poll-title-input"
                bg="surfaceBg"
              />
            </FormControl>

            <FormControl>
              <FormLabel>{copy.polls.descriptionLabel}</FormLabel>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={copy.polls.descriptionPlaceholder}
                maxLength={MAX_DESC_LEN}
                rows={2}
                resize="none"
                bg="surfaceBg"
              />
            </FormControl>

            <FormControl isRequired>
              <FormLabel>{copy.polls.optionsLabel}</FormLabel>
              <VStack spacing={2} align="stretch">
                {options.map((opt, i) => (
                  <HStack key={i}>
                    <Input
                      value={opt}
                      onChange={(e) => updateOption(i, e.target.value)}
                      placeholder={copy.polls.optionPlaceholder(String.fromCharCode(65 + i))}
                      maxLength={MAX_OPTION_LEN}
                      data-testid={`poll-option-input-${i}`}
                      bg="surfaceBg"
                    />
                    {options.length > MIN_OPTIONS && (
                      <IconButton
                        aria-label="Remove option"
                        icon={<RemoveIcon />}
                        size="sm"
                        variant="ghost"
                        onClick={() => removeOption(i)}
                        data-testid={`poll-remove-option-${i}`}
                      />
                    )}
                  </HStack>
                ))}
                {options.length < MAX_OPTIONS && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={addOption}
                    data-testid="poll-add-option-btn"
                  >
                    {copy.polls.addOption}
                  </Button>
                )}
              </VStack>
            </FormControl>

            <FormControl>
              <FormLabel>{copy.polls.pollTypeLabel}</FormLabel>
              <RadioGroup
                value={pollType}
                onChange={(val) => setPollType(val as 'singlechoice' | 'multiplechoice')}
              >
                <HStack spacing={4}>
                  <Radio value="singlechoice" data-testid="poll-type-single">
                    {copy.polls.singleChoice}
                  </Radio>
                  <Radio value="multiplechoice" data-testid="poll-type-multi">
                    {copy.polls.multipleChoice}
                  </Radio>
                </HStack>
              </RadioGroup>
            </FormControl>
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={3} onClick={handleClose} isDisabled={isLoading}>
            {copy.polls.cancel}
          </Button>
          <Button
            colorScheme="brand"
            onClick={() => void handleSubmit()}
            isLoading={isLoading}
            isDisabled={!canSubmit}
            data-testid="create-poll-submit-btn"
          >
            {copy.polls.createPoll}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function RemoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
