import React, { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Heading,
  HStack,
  IconButton,
  Text,
  VStack,
} from '@chakra-ui/react';
import ThemeIcon from '@/src/components/ThemeIcon';
import UserCard, { ConfirmButton } from '@/src/components/UserCard';
import UnreadCountBadge from '@/src/components/UnreadCountBadge';
import ContactChat from '@/src/components/contacts/ContactChat';
import ShareContactCard from '@/src/components/contacts/ShareContactCard';
import BlockContactButton from '@/src/components/contacts/BlockContactButton';
// Voice/video calls are gated behind the CALLS_ENABLED feature toggle.
import { ContactCallToolbar } from '@/src/components/calls/CallToolbar';
import { CALLS_ENABLED } from '@/src/config/features';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import { commonGroups, confirmContact, getContact, listContacts, rememberContactsFromGroups } from '@/src/lib/contacts';
import { useUnreadCounts } from '@/src/lib/unreadStore';
import { isMaintainerPubkey } from '@/src/config/maintainer';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { pubkeyToNpub, truncateNpub } from '@/src/lib/nostrKeys';
import type { MemberProfile, UserProfile } from '@/src/types';

function ContactListView() {
  const copy = useCopy();
  const router = useRouter();
  const { pubkeyHex } = useNostrIdentity();
  const { groups, ready } = useMarmot();
  const { directMessages } = useUnreadCounts();
  const [showHidden, setShowHidden] = useState(false);
  // Revision counter forces a re-read of localStorage after rememberContactsFromGroups runs.
  const [contactsRevision, setContactsRevision] = useState(0);

  // Keep the contacts list in sync with current group membership.
  // Layout.tsx also calls rememberContactsFromGroups, but its useEffect may not
  // have fired yet when this component first renders (e.g. immediately after a
  // group join). Calling it here ensures the contacts store is up-to-date before
  // we derive the list, and the revision bump causes the memos to re-read.
  useEffect(() => {
    if (!ready) return;
    rememberContactsFromGroups(groups, pubkeyHex);
    setContactsRevision((r) => r + 1);
  }, [groups, pubkeyHex, ready]);

  const contacts = useMemo(
    () => listContacts(pubkeyHex, { includeArchived: showHidden }).filter(
      (contact) => !isMaintainerPubkey(contact.pubkeyHex),
    ),
    // contactsRevision ensures a re-read after rememberContactsFromGroups writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pubkeyHex, showHidden, contactsRevision],
  );
  const hiddenCount = useMemo(
    () => listContacts(pubkeyHex, { includeArchived: true })
      .filter((contact) => !isMaintainerPubkey(contact.pubkeyHex))
      .filter((contact) => contact.isArchived).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pubkeyHex, contactsRevision],
  );
  const hasAnyContacts = contacts.length > 0 || hiddenCount > 0;

  // Epic: pending-contact-confirmation, S2 (AC-UX-1). Confirms a pending
  // contact directly from the list row, then bumps the existing
  // `contactsRevision` counter (already used to re-derive `listContacts`
  // after `rememberContactsFromGroups`) so the badge/row re-renders in the
  // same session — no new revision counter needed here, unlike the detail
  // view's `ContactDetailView` below.
  //
  // Gate-remediation (Codex P2, 2026-07-15): deliberately calls
  // `confirmContact` directly instead of `PendingConfirmationPrompt`'s
  // `confirmPendingContact` (which also runs
  // `reconcileConfirmedContactDirectMessageCount`) — this list row never
  // mounts `ContactChat` afterward, so there is no reason to reconcile the
  // bell here at all; AC-OBS-1/AC-OBS-2 already guarantee it was never
  // incorrectly bumped while pending, and it simply catches up the next
  // time the user actually opens the conversation (ContactChat's own
  // mount-time `loadMessages` + `markDirectMessagesRead`).
  //
  // (Historical note: at the time this list-path fix landed,
  // `reconcileConfirmedContactDirectMessageCount` itself routed through
  // `chatPersistence.ts#loadMessages`, whose one-time-per-thread self-heal
  // side effect this list row could never consume — that was a second,
  // independent bug, since fixed directly in
  // `reconcileConfirmedContactDirectMessageCount` by switching it to a raw
  // idb-keyval read. See that function's doc comment in unreadStore.ts.
  // Skipping the call here remains correct regardless, since this row has
  // no use for reconciliation in the first place.)
  //
  // Gate-remediation (2026-07-15, finding G): this handler is a plain
  // synchronous function, not `async` — both `confirmContact` and
  // `setContactsRevision` are synchronous, so there was never anything to
  // await. A prior version was declared `async` with a dead
  // `if (!pubkeyHex) return;` guard (a residue of an earlier call shape that
  // once needed the signed-in user's own pubkey); that guard silently
  // no-op'd the whole confirm action whenever identity state had not yet
  // hydrated. Dropped both — the guard was never load-bearing since
  // `peerPubkeyHex` (the confirm target) is unrelated to `pubkeyHex` (the
  // local user).
  function handleConfirmFromList(peerPubkeyHex: string) {
    confirmContact(peerPubkeyHex);
    setContactsRevision((r) => r + 1);
  }

  return (
    <>
      <Head>
        <title>{`${copy.contacts.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="contacts-page">
        <Box mb={6}>
          <Heading as="h1" size="xl" mb={2}>
            {copy.contacts.heading}
          </Heading>
        </Box>

        {/* The same "Share contact card" surface the profile page offers,
            duplicated here because handing out your own card is what a user
            comes to this page to do when the list is still short or empty. */}
        <Box mb={6}>
          <ShareContactCard context="contacts" />
          <Divider mt={6} />
        </Box>

        {!hasAnyContacts ? (
          <Alert
            status="info"
            borderRadius="md"
            flexDirection="column"
            alignItems="flex-start"
            gap={2}
            data-testid="contacts-empty-state"
          >
            <AlertIcon />
            <Box>
              <Text fontWeight="semibold">{copy.contacts.emptyTitle}</Text>
              <AlertDescription>
                <Text>{copy.contacts.emptyBody}</Text>
              </AlertDescription>
            </Box>
          </Alert>
        ) : contacts.length === 0 ? (
          <Alert status="info" borderRadius="md" data-testid="contacts-hidden-state">
            <AlertIcon />
            <AlertDescription>{copy.contacts.hiddenOnlyBody(hiddenCount)}</AlertDescription>
          </Alert>
        ) : (
          <VStack spacing={3} align="stretch" data-testid="contacts-list">
            {contacts.map((contact) => {
              const fallbackName = truncateNpub(pubkeyToNpub(contact.pubkeyHex));
              const profile: UserProfile = {
                nickname: contact.nickname,
                avatar: contact.avatar,
              };
              const sharedGroupNames = commonGroups(groups, contact.pubkeyHex).map((group) => group.name);
              // A blocked or pending contact has no openable detail page: the
              // row is NOT a link, and every action for that state is inline
              // below (unblock; confirm + reject). Blocked wins over pending
              // (spec.md Design Decision 9), so it is checked first. A direct
              // /contacts?id=<hex> URL for such a contact is separately guarded
              // by ContactDetailView's redirect, so the two entry points agree.
              const isBlocked = contact.isArchived;
              const isPending = !isBlocked && contact.isPendingConfirmation;
              const restricted = isBlocked || isPending;
              return (
                <UserCard
                  key={contact.pubkeyHex}
                  profile={profile}
                  fallbackName={fallbackName}
                  href={restricted ? undefined : `/contacts?id=${contact.pubkeyHex}`}
                  cardTestId={`contact-card-${contact.pubkeyHex}`}
                  subline={sharedGroupNames.length > 0 ? (
                    <Text
                      mt={1}
                      fontSize="xs"
                      color="textMuted"
                      noOfLines={1}
                      data-testid={`contact-common-groups-${contact.pubkeyHex}`}
                    >
                      {copy.contacts.commonGroups(sharedGroupNames)}
                    </Text>
                  ) : null}
                  actions={
                    <>
                      <UnreadCountBadge
                        count={directMessages[contact.pubkeyHex.toLowerCase()] ?? 0}
                        testId={`contact-unread-badge-${contact.pubkeyHex}`}
                      />
                      {/* Blocked wins over pending (spec.md Design Decision 9):
                          the blocked row shows the Hidden badge + an inline
                          Unblock button — the sole unblock affordance now that
                          the detail-page Blocked banner is gone. A contact can
                          be both pending and blocked at once (blocking IS this
                          epic's decline mechanism), and DD-9 names that as the
                          expected post-decline state, so the blocked branch is
                          checked first and the pending branch never shows a
                          live Confirm for an already-blocked contact. */}
                      {isBlocked ? (
                        <>
                          <Badge colorScheme="neutral">{copy.contacts.hiddenBadge}</Badge>
                          <BlockContactButton
                            peerPubkeyHex={contact.pubkeyHex}
                            isArchived
                            onChanged={() => setContactsRevision((r) => r + 1)}
                            testId={`contact-unblock-${contact.pubkeyHex}`}
                          />
                        </>
                      ) : isPending ? (
                        <>
                          <Badge colorScheme="warning" data-testid={`contact-pending-badge-${contact.pubkeyHex}`}>
                            {copy.contacts.pendingBadge}
                          </Badge>
                          <ConfirmButton
                            data-testid={`contact-pending-confirm-${contact.pubkeyHex}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleConfirmFromList(contact.pubkeyHex);
                            }}
                          >
                            {copy.contacts.pendingConfirmButton}
                          </ConfirmButton>
                          {/* Reject IS block (reject-is-block; spec.md
                              Non-Goals — no separate mechanism): clicking opens
                              the block confirm modal that spells out the
                              consequences before anything is actioned. */}
                          <BlockContactButton
                            peerPubkeyHex={contact.pubkeyHex}
                            isArchived={false}
                            label={copy.contacts.pendingRejectButton}
                            onChanged={() => setContactsRevision((r) => r + 1)}
                            testId={`contact-pending-reject-${contact.pubkeyHex}`}
                          />
                        </>
                      ) : null}
                      <IconButton
                        aria-label={copy.profile.viewProfile}
                        icon={<ThemeIcon name="person" size={18} />}
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          router.push(`/profile?pubkey=${contact.pubkeyHex}`);
                        }}
                      />
                    </>
                  }
                />
              );
            })}
          </VStack>
        )}

        {hasAnyContacts ? (
          <Box mt={6} pt={4} borderTopWidth="1px" borderColor="borderSubtle">
            <HStack spacing={4} flexWrap="wrap" data-testid="contacts-hidden-filter">
              {showHidden ? (
                <Button
                  variant="solid"
                  onClick={() => setShowHidden(false)}
                  data-testid="contacts-filter-hide-hidden"
                  size="lg"
                >
                  {copy.contacts.hideHiddenOption}
                </Button>
              ) : (
                <Button
                  variant="solid"
                  colorScheme="danger"
                  onClick={() => setShowHidden(true)}
                  data-testid="contacts-filter-show-hidden"
                  size="lg"
                >
                  {copy.contacts.showHiddenOption(hiddenCount)}
                </Button>
              )}
            </HStack>
          </Box>
        ) : null}
      </Box>
    </>
  );
}

function ContactDetailView({ contactPubkeyHex }: { contactPubkeyHex: string }) {
  const copy = useCopy();
  const router = useRouter();
  // `?added=1` is set by the /add deep-link page after a successful card add
  // (it redirects here instead of showing its own success screen). Surface the
  // green "Contact added" confirmation on this, the selected-contact view.
  const justAdded = router.query.added === '1';
  // Epic: contact-pairing-code, story S4 (AC-SCAN-4). `?pairing=sent|pending`
  // is set by /add.tsx exactly when a pairing-ack echo was attempted for this
  // add (v2 code, unexpired). Neither value implies A has admitted yet — no
  // ack-of-ack exists — so this MUST show honesty copy ("reciprocation in
  // flight"), never a "connected"/"paired" claim. Copy TEXT is S5's; this
  // story only wires the key and the trigger condition.
  const pairingEchoInFlight = router.query.pairing === 'sent' || router.query.pairing === 'pending';
  const { pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { profile: ownProfile } = useProfile();
  // blockedPeersRevision (epic: block-contact, S1) in the dependency array:
  // any block/unblock action bumps this revision (notifyBlockedPeersChanged),
  // so `contact.isArchived` re-derives reactively within the SAME mounted
  // tree, without requiring a route change. This is what makes AC-VIEW-14's
  // "transition an open ContactChat to the Blocked state, tearing down its
  // live subscriptions" hold generically: if this contact somehow gets
  // blocked while its (non-archived) ContactChat is still mounted here, the
  // very next render swaps ContactChat out for the Blocked banner below,
  // and React's own unmount lifecycle stops ContactChat's live subs (its
  // effect cleanup already does this on any unmount) — no manual teardown
  // hook into ContactChat is needed. Symmetrically, an Unblock action taken
  // from the Blocked banner's own button (below) re-derives `contact` the
  // same way, swapping back to ContactChat without a page navigation.
  const { blockedPeersRevision } = useMarmot();
  const contact = useMemo(
    () => getContact(contactPubkeyHex, pubkeyHex, { includeArchived: true }),
    [contactPubkeyHex, pubkeyHex, blockedPeersRevision],
  );
  const signer = useMemo(
    () => (privateKeyHex ? createPrivateKeySigner(privateKeyHex) : null),
    [privateKeyHex],
  );
  // Blocked or pending contacts have no openable detail page — redirect back
  // to the contacts list, where the inline actions for those states live
  // (unblock for blocked; confirm + reject for pending). Derived from
  // `contact` (which includes archived + pending state) and re-derived
  // reactively via `blockedPeersRevision`, so a contact that becomes blocked
  // while this view is open is redirected too. Because `restricted` short-
  // circuits to `return null` BEFORE ContactChat is ever rendered, this also
  // upholds the block-contact epic's invariant that no composer/send
  // affordance mounts for a blocked peer — that epic's Blocked-banner detail
  // UX (AC-VIEW-7) is superseded by this redirect, but the security property
  // is unchanged: there is never anything to send from on screen.
  const restricted = !!contact && (contact.isArchived || contact.isPendingConfirmation);
  useEffect(() => {
    if (restricted) {
      router.replace('/contacts');
    }
  }, [restricted, router]);

  if (!contact) {
    return (
      <Box data-testid="contact-detail-not-found">
        <Alert status="warning" borderRadius="md">
          <AlertIcon />
          <AlertDescription>
            {copy.contacts.contactNotFound}{' '}
            <NextLink href="/contacts" passHref legacyBehavior>
              <Button as="a" variant="link" size="sm">
                {copy.contacts.backToContacts}
              </Button>
            </NextLink>
          </AlertDescription>
        </Alert>
      </Box>
    );
  }

  // Redirecting (see the `restricted` effect above) — render nothing rather
  // than flash a blocked/pending contact's detail chrome. Because this returns
  // before ContactChat below, the composer never mounts for such a contact.
  if (restricted) {
    return null;
  }

  if (!pubkeyHex || !privateKeyHex || !signer) {
    return null;
  }

  const fallbackName = truncateNpub(pubkeyToNpub(contact.pubkeyHex));
  const displayName = contact.nickname || fallbackName || copy.contacts.profileNameFallback;
  const profileMap: Record<string, MemberProfile> = {
    [pubkeyHex]: {
      pubkeyHex,
      nickname: ownProfile.nickname || truncateNpub(pubkeyToNpub(pubkeyHex)),
      avatar: ownProfile.avatar,
      updatedAt: new Date().toISOString(),
    },
    [contact.pubkeyHex]: {
      pubkeyHex: contact.pubkeyHex,
      nickname: contact.nickname || fallbackName,
      avatar: contact.avatar,
      updatedAt: contact.updatedAt ?? contact.lastSeenAt,
    },
  };

  return (
    <>
      <Head>
        <title>{`${displayName} - ${copy.contacts.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="contact-detail-page">
        <NextLink href="/contacts" passHref legacyBehavior>
          <Button as="a" variant="ghost" size="sm" mb={2}>
            ← {copy.contacts.backToContacts}
          </Button>
        </NextLink>
        <Flex align={{ base: 'start', md: 'center' }} justify="space-between" gap={3} wrap="wrap">
          <Box>
            <Heading as="h1" size="xl">
              {displayName}
            </Heading>
          </Box>
          <HStack spacing={2}>
            {/* Voice/video call icons — rendered only while the call feature
                is enabled (CALLS_ENABLED); feature code retained when off. */}
            {CALLS_ENABLED && <ContactCallToolbar peerPubkeyHex={contact.pubkeyHex} />}
            {/* Link to the contact's profile — same affordance as the
                contacts-list row's view-profile icon. */}
            <IconButton
              aria-label={copy.profile.viewProfile}
              icon={<ThemeIcon name="person" size={18} />}
              variant="ghost"
              size="sm"
              flexShrink={0}
              data-testid="contact-detail-view-profile"
              onClick={() => router.push(`/profile?pubkey=${contact.pubkeyHex}`)}
            />
          </HStack>
        </Flex>
        {justAdded ? (
          <Alert status="success" borderRadius="md" mt={4} data-testid="contact-added-success">
            <AlertIcon />
            <AlertDescription>
              {pairingEchoInFlight ? copy.contacts.addContactPairingInFlight : copy.contacts.addContactSuccess}
            </AlertDescription>
          </Alert>
        ) : null}
        {/* Only a normal (non-blocked, non-pending) contact ever reaches here:
            the `restricted` guard above redirects blocked/pending contacts to
            the list, where their inline actions live. So this view renders the
            chat thread unconditionally. */}
        <Divider my={6} />
        <Box>
          <ContactChat
            peerPubkeyHex={contact.pubkeyHex}
            pubkeyHex={pubkeyHex}
            privateKeyHex={privateKeyHex}
            signer={signer}
            profileMap={profileMap}
          />
        </Box>
      </Box>
    </>
  );
}

export default function ContactsPage() {
  const router = useRouter();
  // router.query.id is string | string[] | undefined — for a repeated query
  // param (?id=a&id=b) it is an array. Normalize to the first value so the
  // maintainer check below never calls hex.toLowerCase() on an array.
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  // Maintainer keys are reserved for the feedback channel and must not be
  // reachable as an ordinary contact chat (spec §2.7). A contact record can
  // exist (a reply called rememberContact), so a direct /contacts?id=<maintainer>
  // URL would otherwise render ContactDetailView and send DMs WITHOUT the sealed
  // feedback marker tags. Redirect such IDs to the feedback surface.
  useEffect(() => {
    if (id && isMaintainerPubkey(id)) {
      router.replace('/feedback');
    }
  }, [id, router]);

  if (id) {
    if (isMaintainerPubkey(id)) {
      // Render nothing while the redirect effect runs — never the ordinary chat.
      return null;
    }
    return <ContactDetailView contactPubkeyHex={id} />;
  }

  return <ContactListView />;
}
