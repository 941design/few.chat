import React, { useState } from 'react';
import {
  Button,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { selectLeaveModalState } from '@/src/lib/marmot/membership';

type LeaveGroupButtonProps = {
  groupId: string;
  /** Current admin pubkeys for the group. Optional — omitting disables the guard. */
  adminPubkeys?: string[];
  /** Caller's own hex pubkey. Optional — omitting disables the guard. */
  ownPubkeyHex?: string | null;
};

export default function LeaveGroupButton({ groupId, adminPubkeys, ownPubkeyHex }: LeaveGroupButtonProps) {
  const copy = useCopy();
  const { leaveGroup, getLiveMemberPubkeys } = useMarmot();
  const router = useRouter();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [isLoading, setIsLoading] = useState(false);
  const [liveMembers, setLiveMembers] = useState<string[] | undefined>(undefined);
  // Set when leaveGroup reports the execution-time sole-admin re-check aborted
  // the leave (admins changed after the modal opened): shows the blocked notice.
  const [leaveAborted, setLeaveAborted] = useState(false);

  async function handleOpen() {
    // Fail-closed: a null/throwing read leaves liveMembers undefined, so
    // selectLeaveModalState can never resolve 'abandon' on unknown state.
    let members: string[] | undefined;
    try {
      members = await getLiveMemberPubkeys(groupId);
    } catch {
      members = undefined;
    }
    setLiveMembers(members);
    setLeaveAborted(false);
    onOpen();
  }

  const modalState = leaveAborted ? 'blocked' : selectLeaveModalState(
    { members: liveMembers, admins: adminPubkeys }, ownPubkeyHex ?? '',
  );

  async function handleLeave() {
    setIsLoading(true);
    try {
      const result = await leaveGroup(groupId);
      if (result === 'blocked') setLeaveAborted(true);
      if (result !== 'accepted') return;
      onClose();
      await router.push('/groups');
    } catch (err) {
      console.error('[LeaveGroupButton] leaveGroup failed:', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <Button
        colorScheme="danger"
        variant="outline"
        size="sm"
        onClick={() => void handleOpen()}
        data-testid="leave-group-btn"
      >
        {copy.groups.leaveGroup}
      </Button>

      {modalState === 'abandon' ? (
        /* Last-member state: leaving deletes the group permanently, no MLS send */
        <Modal isOpen={isOpen} onClose={onClose} isCentered>
          <ModalOverlay />
          <ModalContent>
            <ModalHeader>{copy.groups.abandonGroupTitle}</ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              <Text data-testid="abandon-group-notice">
                {copy.groups.abandonGroupBody}
              </Text>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="ghost"
                mr={3}
                onClick={onClose}
                isDisabled={isLoading}
              >
                {copy.groups.cancel}
              </Button>
              <Button
                colorScheme="danger"
                onClick={() => void handleLeave()}
                isLoading={isLoading}
                data-testid="abandon-group-confirm-btn"
              >
                {copy.groups.abandonGroupConfirm}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      ) : modalState === 'blocked' ? (
        /* Sole-admin blocked state: explain the constraint; no confirm-leave path */
        <Modal isOpen={isOpen} onClose={onClose} isCentered>
          <ModalOverlay />
          <ModalContent>
            <ModalHeader>{copy.groups.leaveGroupTitle}</ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              <Text data-testid="last-admin-blocked-notice">
                {copy.groups.lastAdminLeaveBlocked}
              </Text>
            </ModalBody>
            <ModalFooter>
              <Button onClick={onClose}>{copy.groups.cancel}</Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      ) : (
        /* Normal leave confirmation flow */
        <Modal isOpen={isOpen} onClose={onClose} isCentered>
          <ModalOverlay />
          <ModalContent data-testid="leave-group-modal">
            <ModalHeader>{copy.groups.leaveGroupTitle}</ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              <Text>{copy.groups.leaveGroupBody}</Text>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="ghost"
                mr={3}
                onClick={onClose}
                isDisabled={isLoading}
              >
                {copy.groups.cancel}
              </Button>
              <Button
                colorScheme="danger"
                onClick={() => void handleLeave()}
                isLoading={isLoading}
                data-testid="leave-group-confirm-btn"
              >
                {copy.groups.leaveGroupConfirm}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </>
  );
}
