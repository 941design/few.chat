import React, { useEffect, useState } from 'react';
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
  HStack,
  VStack,
  Text,
  Button,
  IconButton,
} from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import type { Copy } from '@/src/lib/i18n';
import {
  loadInviteLinks,
  deleteInviteLink,
  isExpired,
  DAY_MS,
  type InviteLink,
} from '@/src/lib/marmot/inviteLinkStorage';
import { initInviteExpiries } from '@/src/lib/unreadStore';

type ManageInviteLinksModalProps = {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/**
 * How often the modal re-derives `now` while it is open (AC-UI-8). Local to
 * this component — deliberately NOT the notifications module's sweep tick;
 * this overlay owns no dependency on the separate expiry-notification
 * module per architecture.md's module map.
 */
const TICK_MS = 60_000;

export type ExpiryDescriptor = {
  expired: boolean;
  unit: 'minutes' | 'hours';
  amount: number;
};

/**
 * Display-only mirror of inviteLinkStorage's `isExpired` fallback
 * (`expiresAt ?? createdAt + DAY_MS`, Design Decision 2). Needed because
 * `isExpired` returns only a boolean and the relative-time display needs the
 * actual timestamp; importing the shared `DAY_MS` constant keeps the
 * interval length single-sourced. This does NOT reimplement the expiry
 * gating decision — that stays on the imported `isExpired` everywhere a
 * boolean is needed.
 */
export function resolveEffectiveExpiresAt(link: Pick<InviteLink, 'expiresAt' | 'createdAt'>): number {
  return link.expiresAt ?? link.createdAt + DAY_MS;
}

/**
 * Pure, DOM-free classification of an effective expiry timestamp into a
 * relative-time descriptor. `now >= effectiveExpiresAt` decides `expired`
 * (matching `isExpired`'s own boundary); the magnitude buckets into minutes
 * (< 1h) or hours, always with a minimum displayed amount of 1 so a
 * near-boundary link never reads "0 h" / "0 min".
 */
export function describeExpiry(now: number, effectiveExpiresAt: number): ExpiryDescriptor {
  const diff = Math.abs(effectiveExpiresAt - now);
  const expired = now >= effectiveExpiresAt;
  if (diff < HOUR_MS) {
    return { expired, unit: 'minutes', amount: Math.max(1, Math.round(diff / MINUTE_MS)) };
  }
  return { expired, unit: 'hours', amount: Math.max(1, Math.round(diff / HOUR_MS)) };
}

/** Maps a descriptor to the matching Copy function call. */
export function expiryDescriptorToCopy(copy: Copy['groups'], descriptor: ExpiryDescriptor): string {
  if (descriptor.expired) {
    return descriptor.unit === 'minutes'
      ? copy.manageLinksExpiredMinutesAgo(descriptor.amount)
      : copy.manageLinksExpiredHoursAgo(descriptor.amount);
  }
  return descriptor.unit === 'minutes'
    ? copy.manageLinksExpiresInMinutes(descriptor.amount)
    : copy.manageLinksExpiresInHours(descriptor.amount);
}

/** Locale date-time string for a row's creation timestamp (AC-UI-1). */
export function formatCreatedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleString();
}

/** Pure mapping from the expired boolean to the row's distinct style props (AC-UI-3). */
export function rowStyleFor(expired: boolean): { opacity?: number; textDecoration?: string } {
  return expired ? { opacity: 0.55, textDecoration: 'line-through' } : {};
}

/** Empty-state predicate (AC-UI-7). */
export function isEmptyLinksList(links: InviteLink[]): boolean {
  return links.length === 0;
}

export default function ManageInviteLinksModal({
  isOpen,
  onClose,
  groupId,
}: ManageInviteLinksModalProps) {
  const copy = useCopy();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [confirmingNonce, setConfirmingNonce] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      void loadInviteLinks(groupId).then(setLinks);
    } else {
      setConfirmingNonce(null);
    }
  }, [isOpen, groupId]);

  // AC-UI-8: while the modal is open, re-derive `now` on a local interval so
  // a row flips to the expired treatment in place, without remounting.
  useEffect(() => {
    if (!isOpen) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [isOpen]);

  async function handleConfirmDelete(nonce: string) {
    await deleteInviteLink(nonce);
    setLinks((prev) => prev.filter((l) => l.nonce !== nonce));
    setConfirmingNonce(null);
    // The deleted link may have contributed an unread expiry badge. Re-derive
    // the inviteExpiries slice from the now-current persisted flags so the bell
    // updates immediately, instead of showing a stale expiry until the next
    // periodic sweep/derive cycle.
    void initInviteExpiries(Date.now());
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent data-testid="manage-invite-links-modal">
        <ModalHeader>{copy.groups.manageLinksTitle}</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={6}>
          {isEmptyLinksList(links) ? (
            <Text fontSize="sm" color="textMuted" data-testid="manage-invite-links-empty">
              {copy.groups.manageLinksEmpty}
            </Text>
          ) : (
            <VStack spacing={3} align="stretch">
              {links.map((link) => {
                const expired = isExpired(link, now);
                const descriptor = describeExpiry(now, resolveEffectiveExpiresAt(link));
                const usageCount = link.usageCount ?? 0;
                return (
                  <HStack
                    key={link.nonce}
                    justify="space-between"
                    p={2}
                    bg="surfaceBg"
                    borderRadius="md"
                    data-testid={`invite-link-row-${link.nonce}`}
                    {...rowStyleFor(expired)}
                  >
                    <VStack align="start" spacing={0}>
                      <HStack spacing={2}>
                        <Text fontSize="sm" fontWeight="medium">
                          {link.label || copy.groups.manageLinksUntitled}
                        </Text>
                        {expired && (
                          <Text
                            fontSize="xs"
                            fontWeight="bold"
                            color="red.400"
                            data-testid={`invite-link-expired-marker-${link.nonce}`}
                          >
                            {copy.groups.manageLinksExpiredMarker}
                          </Text>
                        )}
                      </HStack>
                      <Text fontSize="xs" color="textMuted">
                        {copy.groups.manageLinksCreatedAt(formatCreatedAt(link.createdAt))}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {expiryDescriptorToCopy(copy.groups, descriptor)}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.groups.manageLinksUsageCount(usageCount)}
                      </Text>
                    </VStack>
                    {confirmingNonce === link.nonce ? (
                      <HStack spacing={2}>
                        <Text fontSize="xs">{copy.groups.manageLinksRemoveConfirm}</Text>
                        <Button
                          size="md"
                          variant="ghost"
                          onClick={() => setConfirmingNonce(null)}
                          data-testid={`invite-link-delete-cancel-${link.nonce}`}
                        >
                          {copy.groups.cancel}
                        </Button>
                        <Button
                          size="md"
                          colorScheme="danger"
                          onClick={() => void handleConfirmDelete(link.nonce)}
                          data-testid={`invite-link-delete-confirm-${link.nonce}`}
                        >
                          {copy.groups.manageLinksRemoveConfirmButton}
                        </Button>
                      </HStack>
                    ) : (
                      <IconButton
                        aria-label={copy.groups.manageLinksRemoveButtonLabel}
                        icon={<TrashIcon />}
                        size="sm"
                        variant="ghost"
                        colorScheme="danger"
                        onClick={() => setConfirmingNonce(link.nonce)}
                        data-testid={`invite-link-delete-${link.nonce}`}
                      />
                    )}
                  </HStack>
                );
              })}
            </VStack>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
