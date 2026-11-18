import React, { useState } from 'react';
import {
  VStack,
  Text,
  Badge,
  Button,
  IconButton,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Alert,
  AlertDescription,
  useDisclosure,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import { useCopy } from '@/src/context/LanguageContext';
import { BADGE_ACCENT } from '@/src/lib/badgeAccent';
import { pubkeyToNpub, truncateNpub } from '@/src/lib/nostrKeys';
import ThemeIcon from '@/src/components/ThemeIcon';
import UserCard, { ConfirmButton, RejectButton } from '@/src/components/UserCard';
import type { MemberProfile, UserProfile } from '@/src/types';
// Type-only import (erased at compile time) — does NOT pull MarmotContext into
// this presentational component (AC-BOUND-2 stays intact). All join-request
// data and handlers arrive via props from groups.tsx.
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

type MemberListProps = {
  memberPubkeys: string[];
  ownPubkeyHex: string | null;
  memberProfiles?: Record<string, MemberProfile>;
  /** Pubkeys that have confirmed membership (sent a profile in this group) */
  confirmedPubkeys?: Set<string>;
  /**
   * Pubkeys currently marked pending-direct-invite (epic:
   * invite-rescind-and-member-removal, S9's PendingDirectInviteMarkerSet
   * seam), loaded once per member-list load in groups.tsx. Combined with
   * `isPending` via `selectMemberRowAffordance` to choose between "Cancel
   * Invite" and "Remove Member" per row (S10).
   */
  pendingInviteMarkers?: Set<string>;
  /** Called when the user confirms cancellation of a pending invite for the given pubkey */
  onCancelInvite?: (pubkey: string) => Promise<void>;
  /**
   * Called when the user confirms Remove Member for the given (in-tree,
   * not-self) pubkey. Invokes the same shared removal helper as
   * onCancelInvite — see groups.tsx's performGroupMemberRemoval.
   */
  onRemoveMember?: (pubkey: string) => Promise<void>;
  /** Pubkeys that hold admin role in this group; drives Admin badge and Make-admin eligibility */
  adminPubkeys?: string[];
  /** Whether the current user is an admin; gates all "Make admin" button visibility */
  isCurrentUserAdmin?: boolean;
  /** Called when the user confirms granting admin to a member; only invoked on confirm */
  onMakeAdmin?: (pubkey: string) => Promise<void>;
  /** Hex pubkeys with a pending eviction commit; drives the leave/removal-pending badge */
  /**
   * Open join requests for this group — people who applied to join but are
   * NOT yet in the MLS tree (distinct from an in-tree "Pending" member awaiting
   * their profile). Rendered as approve/deny rows at the TOP of this single
   * member list; admin-only, wired from groups.tsx. Undefined/empty for a
   * non-admin viewer or when there are no open requests.
   */
  pendingRequests?: PendingJoinRequest[];
  /** Approve a join request (admits the requester to the group). Admin-only. */
  onApproveRequest?: (request: PendingJoinRequest) => void | Promise<void>;
  /** Deny (discard) a join request. Admin-only. */
  onDenyRequest?: (request: PendingJoinRequest) => void | Promise<void>;
  /** eventId of the request currently being approved; drives that row's spinner. */
  approvingRequestId?: string | null;
  /** Per-request approve-failure flags keyed by request eventId. */
  requestErrors?: Record<string, string>;
};

/** True when `pubkey` is in `adminPubkeys` (case-insensitive). */
export function isRowAdmin(pubkey: string, adminPubkeys?: string[]): boolean {
  return adminPubkeys?.some((pk) => pk.toLowerCase() === pubkey.toLowerCase()) ?? false;
}

/** Which removal affordance (if any) a member row renders. */
export type MemberRowAffordance = 'cancel-invite' | 'remove-member' | 'none';

/**
 * The single source of truth for per-row removal-affordance selection
 * (epic: invite-rescind-and-member-removal, AC-LABEL-2/3/4/5/6, AC-UNIV-2).
 *
 * `isYou` and `!isAdmin` short-circuit to `'none'` BEFORE the marker/isPending
 * conjunction is even consulted — AC-LABEL-6 requires the viewer's own row to
 * render neither affordance regardless of its marker or confirmed state, and
 * AC-LABEL-5 requires the same for a non-admin viewer. Otherwise the row
 * renders `'cancel-invite'` iff BOTH `isPending` and `hasMarker` hold
 * (AC-LABEL-2's conjunction — never the marker alone, since a marker can
 * outlive its clear on a transient/failed clear, S4/AC-MARKER-5/6); every
 * other in-tree, not-self, admin-visible row falls through to
 * `'remove-member'` (AC-LABEL-3 — "every other case", not just the common
 * one). Because this is a single if/else with no independent booleans, the
 * two affordances are structurally mutually exclusive (AC-LABEL-4), and
 * every branch reachable from an admin-non-self viewer yields a non-`'none'`
 * result (AC-UNIV-2 — the marker governs only the *label*, never whether a
 * removal control renders at all).
 *
 * Exported so the component and its tests bind to the SAME predicate (no
 * shadow copy) — mirrors `computeShowMakeAdmin` below.
 */
export function selectMemberRowAffordance(opts: {
  isYou: boolean;
  isAdmin: boolean;
  isPending: boolean;
  hasMarker: boolean;
}): MemberRowAffordance {
  if (opts.isYou || !opts.isAdmin) return 'none';
  return opts.isPending && opts.hasMarker ? 'cancel-invite' : 'remove-member';
}

/**
 * The single source of truth for "Make admin" button visibility (AC-GRANT-1/3/4).
 * The button renders ONLY when ALL hold:
 *  - the current user is an admin (AC-GRANT-1 — non-admins see no button),
 *  - the row is not already an admin (AC-GRANT-3),
 *  - the row is not the current user (AC-GRANT-3),
 *  - the row is a confirmed member, not pending/unconfirmed (AC-GRANT-4),
 *  - a handler is wired.
 * Exported so the component and its tests bind to the SAME predicate (no shadow copy).
 */
export function computeShowMakeAdmin(opts: {
  isCurrentUserAdmin?: boolean;
  isRowAdmin: boolean;
  isYou: boolean;
  isPending: boolean;
  hasHandler: boolean;
}): boolean {
  return (
    (opts.isCurrentUserAdmin ?? false) &&
    !opts.isRowAdmin &&
    !opts.isYou &&
    !opts.isPending &&
    opts.hasHandler
  );
}

/**
 * A single open join-request row, rendered at the top of the member list.
 * The requester is NOT yet in the group; a distinct "Requested to join" badge
 * separates them from an in-tree member awaiting their profile. Approve admits
 * them; Deny discards the request. Presentational — all actions arrive as props.
 *
 * data-testids (`pending-request-row-`, `approve-request-`, `deny-request-`)
 * are preserved from the former standalone admission section so existing e2e
 * locators keep resolving after the merge.
 */
function PendingRequestRow({
  request,
  onApprove,
  onDeny,
  approving,
  error,
}: {
  request: PendingJoinRequest;
  onApprove?: (request: PendingJoinRequest) => void | Promise<void>;
  onDeny?: (request: PendingJoinRequest) => void | Promise<void>;
  approving: boolean;
  error?: string;
}) {
  const copy = useCopy();
  const npub = pubkeyToNpub(request.pubkeyHex);
  const fallbackName = truncateNpub(npub);
  const prefix = request.pubkeyHex.slice(0, 8);
  const cardProfile: UserProfile = {
    nickname: request.nickname ?? '',
    avatar: null,
  };

  return (
    <UserCard
      profile={cardProfile}
      fallbackName={fallbackName}
      cardTestId={`pending-request-row-${request.eventId}`}
      subline={request.nickname ? (
        <Text mt={1} fontSize="xs" color="textMuted" isTruncated>
          {fallbackName}
        </Text>
      ) : null}
      actions={
        <>
          <Badge
            colorScheme={BADGE_ACCENT.memberRequested}
            variant="subtle"
            fontSize="2xs"
            data-testid={`member-requested-${prefix}`}
          >
            {copy.groups.memberRequestedBadge}
          </Badge>
          <ConfirmButton
            onClick={() => onApprove?.(request)}
            isLoading={approving}
            data-testid={`approve-request-${request.eventId}`}
          >
            {copy.groups.pendingRequestsApprove}
          </ConfirmButton>
          <RejectButton
            onClick={() => onDeny?.(request)}
            isDisabled={approving}
            data-testid={`deny-request-${request.eventId}`}
          >
            {copy.groups.pendingRequestsDeny}
          </RejectButton>
        </>
      }
      footer={error ? (
        <Alert status="error" mt={2} borderRadius="md" py={1} px={3}>
          <AlertDescription fontSize="xs">{copy.groups.pendingRequestsApproveError}</AlertDescription>
        </Alert>
      ) : null}
    />
  );
}

export default function MemberList({
  memberPubkeys,
  ownPubkeyHex,
  memberProfiles,
  confirmedPubkeys,
  pendingInviteMarkers,
  onCancelInvite,
  onRemoveMember,
  adminPubkeys,
  isCurrentUserAdmin,
  onMakeAdmin,
  pendingRequests,
  onApproveRequest,
  onDenyRequest,
  approvingRequestId,
  requestErrors,
}: MemberListProps) {
  const copy = useCopy();
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const visibleMembers = [...new Set([...memberPubkeys, ...removing])];

  // A roster update can remove the row while the confirmation is still saving its notice.
  function keepRowUntilSettled(action: (pubkey: string) => Promise<void>) {
    return async (pubkey: string) => {
      setRemoving((current) => new Set(current).add(pubkey));
      try {
        await action(pubkey);
      } finally {
        setRemoving((current) => {
          const remaining = new Set(current);
          remaining.delete(pubkey);
          return remaining;
        });
      }
    };
  }


  // Open join requests render as approve/deny rows at the TOP of the single
  // list; they precede the in-tree members below (people who applied but have
  // not yet been admitted). Admin-only — non-admins receive an empty list.
  const requests = pendingRequests ?? [];
  const hasMembers = visibleMembers.length > 0;

  return (
    <VStack align="stretch" spacing={2}>
      {requests.map((req) => (
        <PendingRequestRow
          key={req.eventId}
          request={req}
          onApprove={onApproveRequest}
          onDeny={onDenyRequest}
          approving={approvingRequestId === req.eventId}
          error={requestErrors?.[req.eventId]}
        />
      ))}

      {!hasMembers && requests.length === 0 && (
        <Text color="textMuted" fontSize="sm">
          {copy.groups.noMembersYet}
        </Text>
      )}

      {hasMembers && visibleMembers.map((pubkey) => {
        const npub = pubkeyToNpub(pubkey);
        // Canonicalize the row's pubkey once and use it for EVERY identity /
        // membership check below (isYou, confirmedPubkeys, pendingInviteMarkers).
        // These three feed selectMemberRowAffordance and must agree on the same
        // identity: the confirmed Set and the marker Set are both lowercase, so
        // a mixed-case row must be lowercased before any of them, or the
        // isPending/hasMarker legs of the mutex could disagree.
        const rowKey = pubkey.toLowerCase();
        const isYou = rowKey === ownPubkeyHex?.toLowerCase();
        const profile = memberProfiles?.[pubkey];
        const isPending = confirmedPubkeys ? !confirmedPubkeys.has(rowKey) && !isYou : false;
        const hasMarker = pendingInviteMarkers?.has(rowKey) ?? false;
        const affordance = selectMemberRowAffordance({
          isYou,
          isAdmin: !!isCurrentUserAdmin,
          isPending,
          hasMarker,
        });
        const rowIsAdmin = isRowAdmin(pubkey, adminPubkeys);
        const showMakeAdmin = computeShowMakeAdmin({
          isCurrentUserAdmin,
          isRowAdmin: rowIsAdmin,
          isYou,
          isPending,
          hasHandler: !!onMakeAdmin,
        });

        return (
          <MemberListItem
            key={pubkey}
            pubkey={pubkey}
            npub={npub}
            isYou={isYou}
            isPending={isPending}
            affordance={affordance}
            profile={profile}
            viewProfileLabel={copy.profile.viewProfile}
            pendingLabel={copy.groups.memberPending}
            youLabel={copy.groups.memberYou}
            cancelInviteLabel={copy.groups.cancelInviteButton}
            cancelInviteTitle={copy.groups.cancelInviteTitle}
            cancelInviteBody={copy.groups.cancelInviteBody}
            cancelInviteConfirm={copy.groups.cancelInviteConfirm}
            removeMemberLabel={copy.groups.removeMemberButton}
            removeMemberTitle={copy.groups.removeMemberTitle}
            removeMemberBody={copy.groups.removeMemberBody}
            removeMemberConfirm={copy.groups.removeMemberConfirm}
            cancelLabel={copy.groups.cancel}
            onCancelInvite={affordance === 'cancel-invite' && onCancelInvite ? keepRowUntilSettled(onCancelInvite) : undefined}
            onRemoveMember={affordance === 'remove-member' && onRemoveMember ? keepRowUntilSettled(onRemoveMember) : undefined}
            isRowAdmin={rowIsAdmin}
            adminBadgeLabel={copy.groups.adminBadge}
            showMakeAdmin={showMakeAdmin}
            makeAdminLabel={copy.groups.makeAdminButton}
            makeAdminTitle={copy.groups.makeAdminTitle}
            makeAdminBody={copy.groups.makeAdminBody}
            makeAdminConfirm={copy.groups.makeAdminConfirm}
            onMakeAdmin={showMakeAdmin ? onMakeAdmin : undefined}
          />
        );
      })}
    </VStack>
  );
}

type MemberListItemProps = {
  pubkey: string;
  npub: string;
  isYou: boolean;
  isPending: boolean;
  /**
   * The single resolved removal-affordance decision for this row (from
   * selectMemberRowAffordance). Drives which of the two buttons — if any —
   * renders; the affordance value already encodes AC-LABEL-2/3/4/5/6.
   */
  affordance: MemberRowAffordance;
  profile?: MemberProfile;
  viewProfileLabel: string;
  pendingLabel: string;
  youLabel: string;
  cancelInviteLabel: string;
  cancelInviteTitle: string;
  cancelInviteBody: string;
  cancelInviteConfirm: string;
  removeMemberLabel: string;
  removeMemberTitle: string;
  removeMemberBody: string;
  removeMemberConfirm: string;
  cancelLabel: string;
  onCancelInvite?: (pubkey: string) => Promise<void>;
  /** Called only when the user confirms the Remove Member dialog. */
  onRemoveMember?: (pubkey: string) => Promise<void>;
  /** Whether this row's member holds the admin role */
  isRowAdmin?: boolean;
  /** Resolved i18n string for the admin badge */
  adminBadgeLabel?: string;
  /** Whether to show the Make admin trigger button on this row */
  showMakeAdmin?: boolean;
  /** Resolved i18n string for the Make admin trigger button */
  makeAdminLabel?: string;
  /** Resolved i18n string for the Make admin dialog title */
  makeAdminTitle?: string;
  /** Resolved i18n string for the Make admin dialog body */
  makeAdminBody?: string;
  /** Resolved i18n string for the Make admin dialog confirm button */
  makeAdminConfirm?: string;
  /** Called only when the user clicks Confirm in the Make admin dialog */
  onMakeAdmin?: (pubkey: string) => Promise<void>;
};

function MemberListItem({
  pubkey,
  npub,
  isYou,
  isPending,
  affordance,
  profile,
  viewProfileLabel,
  pendingLabel,
  youLabel,
  cancelInviteLabel,
  cancelInviteTitle,
  cancelInviteBody,
  cancelInviteConfirm,
  removeMemberLabel,
  removeMemberTitle,
  removeMemberBody,
  removeMemberConfirm,
  cancelLabel,
  onCancelInvite,
  onRemoveMember,
  isRowAdmin,
  adminBadgeLabel,
  showMakeAdmin,
  makeAdminLabel,
  makeAdminTitle,
  makeAdminBody,
  makeAdminConfirm,
  onMakeAdmin,
}: MemberListItemProps) {
  const router = useRouter();
  const cancelDisclosure = useDisclosure();
  const removeDisclosure = useDisclosure();
  const makeAdminDisclosure = useDisclosure();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isMakingAdmin, setIsMakingAdmin] = useState(false);

  async function handleConfirmCancel() {
    if (!onCancelInvite) return;
    setIsCancelling(true);
    try {
      await onCancelInvite(pubkey);
    } finally {
      setIsCancelling(false);
      cancelDisclosure.onClose();
    }
  }

  async function handleConfirmRemove() {
    if (!onRemoveMember) return;
    setIsRemoving(true);
    try {
      await onRemoveMember(pubkey);
    } finally {
      setIsRemoving(false);
      removeDisclosure.onClose();
    }
  }

  async function handleConfirmMakeAdmin() {
    if (!onMakeAdmin) return;
    setIsMakingAdmin(true);
    try {
      await onMakeAdmin(pubkey);
    } finally {
      setIsMakingAdmin(false);
      makeAdminDisclosure.onClose();
    }
  }

  const fallbackName = truncateNpub(npub);
  const displayName = profile?.nickname || fallbackName;
  const prefix = pubkey.slice(0, 8);
  const cardProfile: UserProfile = {
    nickname: profile?.nickname ?? '',
    avatar: profile?.avatar ?? null,
  };

  return (
    <>
      <UserCard
        profile={cardProfile}
        fallbackName={fallbackName}
        cardTestId={`member-item-${prefix}`}
        nameTestId={`member-name-${prefix}`}
        avatarTestId={`member-avatar-${prefix}`}
        actions={
          <>
            {isPending && (
              <Badge
                colorScheme={BADGE_ACCENT.memberPending}
                variant="subtle"
                fontSize="2xs"
                data-testid={`member-pending-${prefix}`}
              >
                {pendingLabel}
              </Badge>
            )}
            {isRowAdmin && adminBadgeLabel && (
              <Badge
                colorScheme={BADGE_ACCENT.admin}
                variant="subtle"
                fontSize="2xs"
                data-testid={`admin-badge-${prefix}`}
              >
                {adminBadgeLabel}
              </Badge>
            )}
            {isYou && (
              <Text
                fontSize="xs"
                fontWeight="semibold"
                color="brand.500"
                data-testid="member-you-badge"
              >
                {youLabel}
              </Text>
            )}
            {showMakeAdmin && makeAdminLabel && (
              <ConfirmButton
                onClick={makeAdminDisclosure.onOpen}
                data-testid={`make-admin-${prefix}`}
              >
                {makeAdminLabel}
              </ConfirmButton>
            )}
            {affordance === 'cancel-invite' && onCancelInvite && (
              <RejectButton
                onClick={cancelDisclosure.onOpen}
                data-testid={`cancel-invite-${prefix}`}
              >
                {cancelInviteLabel}
              </RejectButton>
            )}
            {affordance === 'remove-member' && onRemoveMember && (
              <RejectButton
                onClick={removeDisclosure.onOpen}
                data-testid={`remove-member-${prefix}`}
              >
                {removeMemberLabel}
              </RejectButton>
            )}
            <IconButton
              aria-label={viewProfileLabel}
              icon={<ThemeIcon name="person" size={18} />}
              variant="ghost"
              size="sm"
              onClick={() => isYou ? router.push('/settings') : router.push(`/profile?pubkey=${pubkey}`)}
              data-testid={`member-view-profile-${prefix}`}
            />
          </>
        }
      />

      <Modal isOpen={cancelDisclosure.isOpen} onClose={cancelDisclosure.onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{cancelInviteTitle}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text fontWeight="medium" mb={2}>{displayName}</Text>
            <Text fontSize="sm" color="textMuted">{cancelInviteBody}</Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={cancelDisclosure.onClose} isDisabled={isCancelling}>
              {cancelLabel}
            </Button>
            <Button
              colorScheme="danger"
              onClick={handleConfirmCancel}
              isLoading={isCancelling}
              data-testid={`cancel-invite-confirm-${pubkey.slice(0, 8)}`}
            >
              {cancelInviteConfirm}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={removeDisclosure.isOpen} onClose={removeDisclosure.onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{removeMemberTitle}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text fontWeight="medium" mb={2}>{displayName}</Text>
            <Text fontSize="sm" color="textMuted">{removeMemberBody}</Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={removeDisclosure.onClose} isDisabled={isRemoving}>
              {cancelLabel}
            </Button>
            <Button
              colorScheme="danger"
              onClick={handleConfirmRemove}
              isLoading={isRemoving}
              data-testid={`remove-member-confirm-${prefix}`}
            >
              {removeMemberConfirm}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={makeAdminDisclosure.isOpen} onClose={makeAdminDisclosure.onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{makeAdminTitle}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text fontWeight="medium" mb={2}>{displayName}</Text>
            <Text fontSize="sm" color="textMuted">{makeAdminBody}</Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={makeAdminDisclosure.onClose} isDisabled={isMakingAdmin}>
              {cancelLabel}
            </Button>
            <Button
              colorScheme="success"
              onClick={handleConfirmMakeAdmin}
              isLoading={isMakingAdmin}
              data-testid={`make-admin-confirm-${pubkey.slice(0, 8)}`}
            >
              {makeAdminConfirm}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
