import React, { useState } from 'react';
import { Alert, AlertDescription, AlertIcon, Box, Button, HStack, Text } from '@chakra-ui/react';
import ProfileSummary from '@/src/components/ProfileSummary';
import BlockContactButton from '@/src/components/contacts/BlockContactButton';
import { useCopy } from '@/src/context/LanguageContext';
import { confirmContact } from '@/src/lib/contacts';
import { reconcileConfirmedContactDirectMessageCount, clearPendingContact } from '@/src/lib/unreadStore';
import type { ContactListItem } from '@/src/lib/contacts';
import type { UserProfile } from '@/src/types';

/**
 * Confirms a pending contact and reconciles the notification bell for any
 * messages held while pending — epic: pending-contact-confirmation, story S2
 * (AC-CONFIRM-1 via S1's `confirmContact`, AC-OBS-2 via S1's
 * `reconcileConfirmedContactDirectMessageCount`). Exported separately from
 * the component so the confirm+reconcile orchestration is a plain async
 * function, not tangled with component state — mirrors
 * `BlockContactButton.tsx`'s `performBlockContact`/`performUnblockContact`
 * orchestration-vs-UI split (though those live in a dedicated lib module;
 * this epic's S2 scope does not include a new `app/src/lib/*.ts` file, so
 * the split stays local to this component file).
 *
 * `confirmContact` clears `pendingConfirmationSince` first (S1's own
 * no-op/idempotency guards apply), then
 * `reconcileConfirmedContactDirectMessageCount` recomputes the peer's unread
 * count from persisted chat history — sourced from storage, never
 * re-derived from live relay events (spec.md Design Decision 8). Like
 * `initDirectMessageCounts` (the batch/startup function), it reads via a raw
 * idb-keyval lookup rather than `chatPersistence.ts#loadMessages` — a
 * reconciliation-only caller must never be the one to trigger (or discard
 * the `refetchIds` from) `loadMessages`' one-time-per-thread self-heal pass.
 * An earlier version of this call routed through `loadMessages` on the
 * theory that doing so was safe here because the user is about to view this
 * exact conversation anyway; that was wrong — this function runs on EVERY
 * confirm, so it could easily be the FIRST caller to touch `loadMessages`
 * for a thread, permanently consuming the repair signal before
 * `ContactChat`'s own mount-time call ever saw it. See
 * `reconcileConfirmedContactDirectMessageCount`'s doc comment in
 * unreadStore.ts for the full history.
 *
 * AC-OBS-2 was amended 2026-07-15 (spec.md `## Amendments`,
 * acceptance-criteria.md AC-OBS-2): for a contact whose conversation was
 * never opened while pending, this app has nothing persisted for
 * `reconcileConfirmedContactDirectMessageCount` to read yet — this repo's DM
 * pipeline only writes a contact's message content once their `ContactChat`
 * has mounted at least once (a pre-existing, out-of-epic-scope property) —
 * so this call resolves to a no-op here in the common case. The bell still
 * ends up correct: AC-OBS-1 already guarantees it was never incorrectly
 * bumped for messages received while pending, and the next time the user
 * opens the conversation, `ContactChat` loads the (now-fetchable) history
 * and marks it read via its own `markDirectMessagesRead` mount effect. This
 * call remains useful for any messages that happen to already be persisted
 * (e.g. a conversation opened before the contact went pending) and for the
 * `reconcileInit` live-increment race protection it gets "for free".
 */
export async function confirmPendingContact(peerPubkeyHex: string, ownPubkeyHex: string): Promise<void> {
  confirmContact(peerPubkeyHex);
  // Clear the pending-contact bell entry on confirm (epic:
  // pending-contact-notification, AC-LIFE-3).
  clearPendingContact(peerPubkeyHex);
  await reconcileConfirmedContactDirectMessageCount(peerPubkeyHex, ownPubkeyHex);
}

type PendingConfirmationPromptProps = {
  /** The pending contact — used for both the cached nickname/avatar and confirm target. */
  contact: ContactListItem;
  /** Hex pubkey of the local (signed-in) user, forwarded to the bell reconciliation call. */
  ownPubkeyHex: string;
  /** Display name shown in the prompt body (already resolved by the caller, e.g. nickname-or-truncated-npub). */
  displayName: string;
  /**
   * Called after `confirmPendingContact` resolves. The caller (contacts.tsx's
   * `ContactDetailView`) bumps its own reactive revision counter here, so the
   * three-way blocked/pending/normal branch re-derives within the same
   * mounted session (AC-UX-2) — no navigation away and back.
   */
  onConfirmed: () => void;
};

export default function PendingConfirmationPrompt({
  contact,
  ownPubkeyHex,
  displayName,
  onConfirmed,
}: PendingConfirmationPromptProps) {
  const copy = useCopy();
  const [isConfirming, setIsConfirming] = useState(false);

  const profile: UserProfile = { nickname: contact.nickname, avatar: contact.avatar };

  async function handleConfirm() {
    setIsConfirming(true);
    try {
      await confirmPendingContact(contact.pubkeyHex, ownPubkeyHex);
    } finally {
      setIsConfirming(false);
      onConfirmed();
    }
  }

  return (
    <Box mt={4} data-testid="pending-confirmation-prompt">
      <Box mb={4}>
        <ProfileSummary profile={profile} fallbackName={displayName} size="md" />
      </Box>
      <Alert status="info" borderRadius="md" flexDirection="column" alignItems="flex-start" gap={2}>
        <AlertIcon />
        <Box>
          <Text fontWeight="semibold">{copy.contacts.pendingConfirmHeading}</Text>
          <AlertDescription>
            <Text>{copy.contacts.pendingConfirmBody(displayName)}</Text>
          </AlertDescription>
        </Box>
      </Alert>
      <Box mt={4}>
        <HStack spacing={3} align="center" flexWrap="wrap">
          <Button
            colorScheme="success"
            onClick={() => void handleConfirm()}
            isLoading={isConfirming}
            data-testid="pending-confirmation-confirm-btn"
          >
            {copy.contacts.pendingConfirmButton}
          </Button>
          {/*
           * The prompt asks a yes/no question ("Confirm this contact?"), so it
           * offers a first-class "Reject" button next to Confirm — mirroring
           * the group join-request `[Approve] [Deny]` layout, which is the
           * symmetry this affordance was promoted to provide. Reject is NOT a
           * new mechanism: per spec.md Non-Goals, declining a pending contact
           * reuses the existing block/archive flow (there is no separate
           * "reject" action). So this renders the existing `BlockContactButton`
           * — relabelled to "Reject" via its `label` prop — exactly as the
           * isArchived branch in `contacts.tsx#ContactDetailView` already does,
           * with `isArchived={false}` (this contact is only pending, never yet
           * archived, on this branch — the isArchived branch there is checked
           * FIRST and would already have taken over otherwise, per DD-9).
           * Clicking Reject opens the same block confirm modal, which still
           * spells out the real consequences (history wipe, permanent
           * exclusion) before anything is actioned — the heavy semantics stay
           * honest. No local `onChanged` bump is needed: blocking calls
           * `notifyBlockedPeersChanged`, which bumps `blockedPeersRevision`
           * (`useMarmot`) that `ContactDetailView`'s own `contact` derivation
           * already depends on — the very next render swaps this whole
           * component out for the Blocked banner (DD-9's "blocked wins over
           * pending"), with no action needed here.
           */}
          <BlockContactButton
            peerPubkeyHex={contact.pubkeyHex}
            isArchived={false}
            label={copy.contacts.pendingRejectButton}
            onChanged={() => {
              // Reject-is-block: clear the pending-contact bell entry (epic:
              // pending-contact-notification, AC-LIFE-4). The blockedPeersRevision
              // bump already drives ContactDetailView's re-derive.
              clearPendingContact(contact.pubkeyHex);
            }}
            testId="pending-confirmation-block-btn"
            isDisabled={isConfirming}
          />
        </HStack>
      </Box>
    </Box>
  );
}
