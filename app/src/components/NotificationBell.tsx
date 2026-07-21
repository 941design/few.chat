import React, { useEffect, useMemo, useRef } from 'react';
import {
  Box,
  Text,
  VStack,
  HStack,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverBody,
  PopoverArrow,
  useDisclosure,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import {
  useUnreadCounts,
  markAsRead,
  markJoinRequestsRead,
  markDirectMessagesRead,
  markInviteExpiriesRead,
  markPendingContactRead,
} from '@/src/lib/unreadStore';
import { runInviteExpiryCycle } from '@/src/lib/marmot/inviteExpirySweep';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useCopy } from '@/src/context/LanguageContext';
import ThemeIcon from '@/src/components/ThemeIcon';
import { headerIconChipStyle } from '@/src/components/headerIconChip';
import { listContacts } from '@/src/lib/contacts';
import { pubkeyToNpub, truncateNpub } from '@/src/lib/nostrKeys';
import { isMaintainerPubkey, MAINTAINER_DISPLAY_NAME } from '@/src/config/maintainer';

/**
 * How often the expiry sweep re-checks for newly-expired invite links while
 * the app is open (spec.md's Technical Approach, Design Decision 11). This
 * effect is the epic's chosen "wherever group state initializes" wiring
 * point: `NotificationBell` is mounted unconditionally by `Layout.tsx` on
 * every page (twice — once for the desktop header, once for the mobile
 * menu — see the module doc comment in `inviteExpirySweep.ts` on why that
 * double-mount is safe), so its mount is as close to "app load" as this
 * story's scope (which excludes editing `MarmotContext.tsx` beyond the
 * `leaveGroup` wiring) allows.
 */
const INVITE_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export interface InviteExpiryRow {
  groupId: string;
  name: string;
  expiryCount: number;
}

/**
 * Gate-remediation fix (Finding 3, epic invite-link-lifecycle): builds the
 * invite-expiry bell rows from EVERY key in the `inviteExpiries` slice, not
 * merely the admin's current `groups` list. `totalUnread`
 * (`unreadStore.ts#useUnreadCounts`) sums every `inviteExpiries` key
 * unconditionally; the previous row-building logic filtered to `groups`
 * (mirroring `unreadGroups`/`joinRequestGroups`), so a stale/restored group
 * id with a nonzero persisted count inflated the badge total with no
 * visible row to clear it — a permanently stuck badge.
 *
 * A groupId present in `inviteExpiries` but absent from `groups` falls back
 * to `unknownGroupLabel` rather than being dropped. Clicking that row still
 * deep-links to `/groups?id=<id>&manageLinks=1`, which hits
 * `shouldRedirectToGroupsList`'s existing "group absent from the admin's
 * list" branch in `groups.tsx` — that branch already calls
 * `clearInviteExpiries(id)`, so a stale row self-heals the first time the
 * user clicks it, even though this function itself does nothing to remove
 * the entry up front.
 *
 * Invariant this restores: the invite-expiry contribution to the badge
 * total (`Object.values(inviteExpiries).reduce(...)`) always equals the sum
 * of `expiryCount` across the rows this function returns — every counted
 * expiry is clearable.
 */
export function buildInviteExpiryRows(
  inviteExpiries: Record<string, number>,
  groups: Array<{ id: string; name: string }>,
  unknownGroupLabel: string,
): InviteExpiryRow[] {
  const namesById = new Map(groups.map((g) => [g.id, g.name] as const));
  return Object.entries(inviteExpiries)
    .filter(([, count]) => count > 0)
    .map(([groupId, expiryCount]) => ({
      groupId,
      name: namesById.get(groupId) ?? unknownGroupLabel,
      expiryCount,
    }));
}

export default function NotificationBell() {
  const { counts, joinRequests, directMessages, inviteExpiries, pendingContacts, totalUnread } = useUnreadCounts();
  const { groups } = useMarmot();
  const { pubkeyHex } = useNostrIdentity();
  const copy = useCopy();
  const { isOpen, onToggle, onClose } = useDisclosure();
  const btnRef = useRef<HTMLButtonElement>(null);

  // Expiry notification cycle — on mount and every INVITE_EXPIRY_SWEEP_INTERVAL_MS
  // thereafter. Each cycle migrates legacy records, then (only if migration
  // succeeded) sweeps for newly-expired links, then re-derives the badge from
  // persisted flags. Migration runs on EVERY tick, not just the first, so that
  // (a) a startup migration failure does not let the sweep flood the bell with
  // retroactive-expiry notifications for un-migrated legacy links, and (b) legacy
  // links introduced after startup (e.g. an older backup restored while the app is
  // open) are migration-suppressed before the next sweep sees them (AC-INV-3,
  // Design Decision 3). The orchestration lives in `runInviteExpiryCycle` so its
  // migrate-before-sweep ordering is unit-testable without mounting this component.
  // The cycle only touches module-level external stores (never this component's
  // React state), so no unmount cancellation guard is needed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    void runInviteExpiryCycle(Date.now());
    const interval = setInterval(() => {
      void runInviteExpiryCycle(Date.now());
    }, INVITE_EXPIRY_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Build list of groups with unread messages
  const unreadGroups = groups
    .filter((g) => (counts[g.id] ?? 0) > 0)
    .map((g) => ({ ...g, unread: counts[g.id] }));

  // Build list of groups with pending join requests
  const joinRequestGroups = groups
    .filter((g) => (joinRequests[g.id] ?? 0) > 0)
    .map((g) => ({ ...g, requestCount: joinRequests[g.id] }));

  // Build list of rows for an unread invite-link expiry notification
  // (AC-NOTIFY-3). Sourced from EVERY key in `inviteExpiries`, not filtered
  // to `groups` — see `buildInviteExpiryRows`'s doc comment (Gate-
  // remediation Finding 3) for why filtering to `groups` left a stale
  // groupId's count in the badge total with no row to clear it.
  const inviteExpiryRows = buildInviteExpiryRows(inviteExpiries, groups, copy.groups.groupNotFound);

  // Build list of contacts with unread direct messages. The bell can render
  // before the user has any stored contacts (e.g. a DM arrives from a stranger),
  // so we fall back to a truncated npub label when no contact entry exists.
  const directMessageContacts = useMemo(() => {
    const peerKeys = Object.keys(directMessages).filter((k) => directMessages[k] > 0);
    if (peerKeys.length === 0) return [];
    const contacts = listContacts(pubkeyHex, { includeArchived: true });
    const byPubkey = new Map(contacts.map((c) => [c.pubkeyHex.toLowerCase(), c] as const));
    return peerKeys.map((peer) => {
      const contact = byPubkey.get(peer);
      const fallbackName = truncateNpub(pubkeyToNpub(peer));
      const isMaintainer = isMaintainerPubkey(peer);
      return {
        peerPubkeyHex: peer,
        displayName: isMaintainer ? MAINTAINER_DISPLAY_NAME : (contact?.nickname || fallbackName),
        unread: directMessages[peer],
        href: isMaintainer ? '/feedback' : `/contacts?id=${peer}`,
      };
    });
  }, [directMessages, pubkeyHex]);

  // Build list of pending contacts awaiting the recipient's Confirm/Reject
  // (epic: pending-contact-notification, S2). Sourced from the `pendingContacts`
  // slice; resolves the display name via the same fallback-to-truncated-npub
  // pattern the DM rows use. Each row deep-links to /contacts, where the
  // Confirm + Reject controls live (AC-UI-1).
  const pendingContactRows = useMemo(() => {
    const peerKeys = Object.keys(pendingContacts).filter((k) => pendingContacts[k] > 0);
    if (peerKeys.length === 0) return [];
    const contacts = listContacts(pubkeyHex, { includeArchived: true });
    const byPubkey = new Map(contacts.map((c) => [c.pubkeyHex.toLowerCase(), c] as const));
    return peerKeys.map((peer) => {
      const contact = byPubkey.get(peer);
      const fallbackName = truncateNpub(pubkeyToNpub(peer));
      return {
        peerPubkeyHex: peer,
        displayName: contact?.nickname || fallbackName,
      };
    });
  }, [pendingContacts, pubkeyHex]);

  const hasNotifications =
    unreadGroups.length > 0 ||
    joinRequestGroups.length > 0 ||
    directMessageContacts.length > 0 ||
    inviteExpiryRows.length > 0 ||
    pendingContactRows.length > 0;

  return (
    <Popover
      isOpen={isOpen}
      onClose={onClose}
      placement="bottom-end"
      initialFocusRef={btnRef}
    >
      <PopoverTrigger>
        <Box
          as="button"
          ref={btnRef}
          onClick={onToggle}
          {...headerIconChipStyle}
          color="textMuted"
          aria-label={copy.layout.notificationsLabel}
          data-testid="notification-bell"
        >
          <ThemeIcon name="bell" size={20} aria-hidden />
          {totalUnread > 0 && (
            <Box
              position="absolute"
              top="1"
              right="1"
              bg="red.500"
              color="white"
              fontSize="2xs"
              fontWeight="bold"
              lineHeight="1"
              minW="16px"
              h="16px"
              borderRadius="full"
              display="flex"
              alignItems="center"
              justifyContent="center"
              px="4px"
              data-testid="notification-badge"
            >
              {totalUnread > 99 ? '99+' : totalUnread}
            </Box>
          )}
        </Box>
      </PopoverTrigger>

      <PopoverContent
        w="280px"
        bg="surfaceBg"
        borderColor="borderSubtle"
        data-testid="notification-dropdown"
      >
        <PopoverArrow bg="surfaceBg" />
        <PopoverBody p={0}>
          {!hasNotifications ? (
            <Box p={4} textAlign="center">
              <Text fontSize="sm" color="textMuted">
                {copy.layout.noNotifications}
              </Text>
            </Box>
          ) : (
            <VStack spacing={0} align="stretch">
              {unreadGroups.map((g) => (
                <NextLink
                  key={g.id}
                  href={`/groups?id=${g.id}`}
                  passHref
                  legacyBehavior
                >
                  <HStack
                    as="a"
                    px={4}
                    py={3}
                    spacing={3}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    cursor="pointer"
                    onClick={() => {
                      markAsRead(g.id);
                      onClose();
                    }}
                    data-testid={`notification-item-${g.id}`}
                  >
                    <Box flex="1" minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        isTruncated
                      >
                        {g.name}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.layout.unreadMessages(g.unread)}
                      </Text>
                    </Box>
                    <Box
                      bg="brand.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="bold"
                      minW="20px"
                      h="20px"
                      borderRadius="full"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      px="6px"
                      flexShrink={0}
                    >
                      {g.unread > 99 ? '99+' : g.unread}
                    </Box>
                  </HStack>
                </NextLink>
              ))}
              {directMessageContacts.map((c) => (
                <NextLink
                  key={`dm-${c.peerPubkeyHex}`}
                  href={c.href}
                  passHref
                  legacyBehavior
                >
                  <HStack
                    as="a"
                    px={4}
                    py={3}
                    spacing={3}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    cursor="pointer"
                    onClick={() => {
                      markDirectMessagesRead(c.peerPubkeyHex);
                      onClose();
                    }}
                    data-testid={`notification-dm-${c.peerPubkeyHex}`}
                  >
                    <Box flex="1" minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        isTruncated
                      >
                        {c.displayName}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.layout.directMessageNotification(c.unread)}
                      </Text>
                    </Box>
                    <Box
                      bg="brand.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="bold"
                      minW="20px"
                      h="20px"
                      borderRadius="full"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      px="6px"
                      flexShrink={0}
                    >
                      {c.unread > 99 ? '99+' : c.unread}
                    </Box>
                  </HStack>
                </NextLink>
              ))}
              {joinRequestGroups.map((g) => (
                <NextLink
                  key={`jr-${g.id}`}
                  href={`/groups?id=${g.id}`}
                  passHref
                  legacyBehavior
                >
                  <HStack
                    as="a"
                    px={4}
                    py={3}
                    spacing={3}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    cursor="pointer"
                    onClick={() => {
                      markJoinRequestsRead(g.id);
                      onClose();
                    }}
                    data-testid={`notification-join-request-${g.id}`}
                  >
                    <Box flex="1" minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        isTruncated
                      >
                        {g.name}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.layout.joinRequestNotification(g.requestCount)}
                      </Text>
                    </Box>
                    <Box
                      bg="orange.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="bold"
                      minW="20px"
                      h="20px"
                      borderRadius="full"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      px="6px"
                      flexShrink={0}
                    >
                      {g.requestCount > 99 ? '99+' : g.requestCount}
                    </Box>
                  </HStack>
                </NextLink>
              ))}
              {pendingContactRows.map((c) => (
                <NextLink
                  key={`pending-contact-${c.peerPubkeyHex}`}
                  href="/contacts"
                  passHref
                  legacyBehavior
                >
                  <HStack
                    as="a"
                    px={4}
                    py={3}
                    spacing={3}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    cursor="pointer"
                    onClick={() => {
                      markPendingContactRead(c.peerPubkeyHex);
                      onClose();
                    }}
                    data-testid={`notification-pending-contact-${c.peerPubkeyHex}`}
                  >
                    <Box flex="1" minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        isTruncated
                      >
                        {c.displayName}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.layout.pendingContactNotification}
                      </Text>
                    </Box>
                    <Box
                      bg="orange.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="bold"
                      minW="20px"
                      h="20px"
                      borderRadius="full"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      px="6px"
                      flexShrink={0}
                      aria-hidden
                    >
                      !
                    </Box>
                  </HStack>
                </NextLink>
              ))}
              {inviteExpiryRows.map((row) => (
                <NextLink
                  key={`invite-expiry-${row.groupId}`}
                  href={`/groups?id=${row.groupId}&manageLinks=1`}
                  passHref
                  legacyBehavior
                >
                  <HStack
                    as="a"
                    px={4}
                    py={3}
                    spacing={3}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    cursor="pointer"
                    onClick={() => {
                      void markInviteExpiriesRead(row.groupId);
                      onClose();
                    }}
                    data-testid={`notification-invite-expiry-${row.groupId}`}
                  >
                    <Box flex="1" minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        isTruncated
                      >
                        {row.name}
                      </Text>
                      <Text fontSize="xs" color="textMuted">
                        {copy.layout.inviteExpiryNotification(row.expiryCount)}
                      </Text>
                    </Box>
                    <Box
                      bg="orange.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="bold"
                      minW="20px"
                      h="20px"
                      borderRadius="full"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      px="6px"
                      flexShrink={0}
                    >
                      {row.expiryCount > 99 ? '99+' : row.expiryCount}
                    </Box>
                  </HStack>
                </NextLink>
              ))}
            </VStack>
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
