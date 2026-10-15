import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Flex,
  Heading,
  Text,
  VStack,
  HStack,
  Button,
  Input,
  Divider,
  Badge,
  Alert,
  AlertIcon,
  AlertDescription,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import NextLink from 'next/link';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import { readContactCache } from '@/src/lib/contactCache';
import GroupCard from '@/src/components/groups/GroupCard';
import CreateGroupModal from '@/src/components/groups/CreateGroupModal';
import BackupReminderBanner from '@/src/components/groups/BackupReminderBanner';
import OfflineBanner from '@/src/components/groups/OfflineBanner';
import MemberList from '@/src/components/groups/MemberList';
import InviteMemberModal from '@/src/components/groups/InviteMemberModal';
import GenerateInviteLinkModal from '@/src/components/groups/GenerateInviteLinkModal';
import ManageInviteLinksModal from '@/src/components/groups/ManageInviteLinksModal';
import JoinRequestCard from '@/src/components/groups/JoinRequestCard';
import InviteAwaitingBanner from '@/src/components/groups/InviteAwaitingBanner';
import OutboundJoinRequestCard from '@/src/components/groups/OutboundJoinRequestCard';
import { useOutboundJoinRequests } from '@/src/lib/marmot/outboundJoinRequests';
import InvitationCard from '@/src/components/groups/InvitationCard';
import {
  subscribe as subscribePendingInvitations,
  getSnapshot as getPendingInvitationsSnapshot,
} from '@/src/lib/pendingInvitations';
import type { PendingInvitation } from '@/src/lib/pendingInvitations';
import { resolveInviterLabel, truncatePubkey } from '@/src/lib/pubkeyDisplay';
import { BADGE_ACCENT } from '@/src/lib/badgeAccent';
import LeaveGroupButton from '@/src/components/groups/LeaveGroupButton';
import GroupChat from '@/src/components/groups/GroupChat';
// Voice/video calls are gated behind the CALLS_ENABLED feature toggle.
import { GroupCallToolbar } from '@/src/components/calls/CallToolbar';
import { CALLS_ENABLED } from '@/src/config/features';
import { ChatStoreProvider, useChatStore } from '@/src/context/ChatStoreContext';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { PollStoreProvider } from '@/src/context/PollStoreContext';
import PollPanel from '@/src/components/groups/PollPanel';
import CreatePollModal from '@/src/components/groups/CreatePollModal';
import { markAsRead, markInviteExpiriesRead } from '@/src/lib/unreadStore';
import { setActiveView, clearActiveView } from '@/src/lib/activeViewStore';
import { deleteMemberProfile } from '@/src/lib/marmot/groupStorage';
import { clearPendingDirectInvite } from '@/src/lib/marmot/pendingDirectInviteStorage';
import type { Group, MemberProfile } from '@/src/types';

/* ---------- Pending-invitations store (SSR-safe stub) ---------- */

function getPendingInvitationsServerSnapshot(): ReadonlyArray<PendingInvitation> {
  return [];
}

/* ---------- Detail view (shown when ?id=xxx is present) ---------- */

type MarmotGroupType = import('@internet-privacy/marmot-ts').MarmotGroup;

/**
 * Pure decision logic for the `manageLinks=1` deep-link (epic:
 * invite-link-lifecycle, story S4, Design Decision 10). Extracted from the
 * page's `useEffect`s so it is unit-testable without mounting React or
 * Next's router (this repo has no jsdom/@testing-library precedent —
 * mirrors `profile.tsx`'s `planProfileAnnounceFanout` extraction).
 *
 * AC-DEEPLINK-1: the overlay must open only once the detail view for `id`
 * has actually rendered — `groupResolved` is the caller's `group?.id === id`
 * check (the resolved group must MATCH the route; MLS init is async and, on
 * client-side nav, `group` briefly holds the previous route's group, so a
 * bare `group !== null` would fire against stale state per Design Decision 10).
 */
export function shouldOpenManageLinksOverlay(params: {
  manageLinksParam: string | undefined;
  groupResolved: boolean;
  alreadyHandled: boolean;
}): boolean {
  return params.manageLinksParam === '1' && params.groupResolved && !params.alreadyHandled;
}

/**
 * Guard-state transition for the `manageLinks=1` deep link. Returns whether to
 * open the overlay this cycle and the next value of the id-keyed "handled"
 * guard ref. Keyed to the group `id` so a deep link for a DIFFERENT group
 * re-opens (Finding 1), and RESET whenever the param is absent so a repeat
 * deep link for the SAME group re-opens (Finding 2, same-mount): the param is
 * stripped after opening, so its absence is the natural reset signal. `open`
 * still requires `manageLinksParam === '1'`, so clearing the guard on absence
 * never itself re-opens a stripped URL (AC-DEEPLINK-2 holds).
 */
export function nextManageLinksGuard(params: {
  manageLinksParam: string | undefined;
  groupResolved: boolean;
  handledForId: string | null;
  id: string;
}): { open: boolean; handledForId: string | null } {
  const { manageLinksParam, groupResolved, handledForId, id } = params;
  if (manageLinksParam !== '1') {
    return { open: false, handledForId: null };
  }
  const open = shouldOpenManageLinksOverlay({
    manageLinksParam,
    groupResolved,
    alreadyHandled: handledForId === id,
  });
  return { open, handledForId: open ? id : handledForId };
}

/**
 * AC-DEEPLINK-3: when `manageLinks=1` targets a `groupId` absent from the
 * admin's current group list, the page must render the groups list (not
 * the detail view) instead of falling through to `GroupDetailView`'s own
 * "not found" alert state. Gated on `ready` — before the group list has
 * loaded, "absent" cannot yet be distinguished from "not loaded yet", and
 * the caller must keep rendering the (loading) detail view until `ready`
 * flips true.
 */
export function shouldRedirectToGroupsList(params: {
  manageLinksParam: string | undefined;
  ready: boolean;
  id: string | undefined;
  groupIds: string[];
}): boolean {
  const { manageLinksParam, ready, id, groupIds } = params;
  return manageLinksParam === '1' && ready && id !== undefined && !groupIds.includes(id);
}

/* ---------- S9: Remove Member / post-removal purge+clear gate ----------
 * Epic: invite-rescind-and-member-removal. Pure helpers extracted so the
 * order-sensitive post-removal gate (architecture.md's Order-Sensitive
 * Composition guarantee #2: "Purge-on-removal is commit-independent") is
 * unit-testable without mounting React. */

/** Result shape of MarmotContext.cancelPendingInvitation (the shared removal helper). */
export type CancelPendingInvitationResult = {
  ok: boolean;
  error?: string;
  raceDetected?: boolean;
  announcementError?: string;
};

/**
 * Case-insensitive membership test against a freshly-read live member list.
 *
 * Fail-closed toward "still a member" (returns true) when `liveMembers` is
 * `undefined` (getLiveMemberPubkeys couldn't read live MLS state) — an
 * ambiguous read must never trigger a purge/marker-clear that could destroy
 * real data. This is the opposite polarity from LeaveGroupButton's
 * fail-closed direction (which blocks the "abandon" branch on unknown
 * state) — same "undefined means we don't know" input, different safe
 * default for a different decision.
 */
export function computeStillMember(
  liveMembers: string[] | undefined,
  pubkey: string,
): boolean {
  if (liveMembers === undefined) return true;
  return liveMembers.some((pk) => pk.toLowerCase() === pubkey.toLowerCase());
}

/**
 * AC-MARKER-7/8, AC-PURGE-2/3/4: the post-hoc purge/clear gate.
 *
 * Gated SOLELY on `stillMember` (tree membership), never on whether this
 * client's commit succeeded — architecture.md's guarantee #2 requires the
 * purge and marker-clear to run on every exit where the pubkey ends up no
 * longer in the tree, including both `raceDetected` short-circuits where
 * this client performed no MLS commit at all. A genuine removal failure
 * that leaves the pubkey still a member (AC-PURGE-4) is excluded purely
 * because `stillMember` is true in that case — no separate `result.ok`
 * check is needed or consulted here.
 *
 * Best-effort: a purge/clear failure is logged, not thrown, so it never
 * breaks the caller's toast flow.
 */
export async function runPostRemovalCleanup(params: {
  groupId: string;
  pubkey: string;
  stillMember: boolean;
  deleteMemberProfile: (groupId: string, pubkey: string) => Promise<void>;
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
}): Promise<void> {
  if (params.stillMember) return;
  try {
    await Promise.all([
      params.deleteMemberProfile(params.groupId, params.pubkey),
      params.clearPendingDirectInvite(params.groupId, params.pubkey),
    ]);
  } catch (err) {
    console.warn('[GroupsPage] post-removal purge/clear failed:', err);
  }
}

/**
 * AC-REMOVE-1: the shared removal helper both onCancelInvite and
 * onRemoveMember invoke — a single code path, never two divergent
 * MLS-remove implementations. Calls the shared `cancelPendingInvitation`
 * MLS-remove wrapper, then independently re-reads LIVE tree membership via
 * `getLiveMemberPubkeys` (never the pre-removal `group.memberPubkeys`
 * closure snapshot, which will not have re-rendered yet), and runs the
 * post-removal purge/clear gate. Returns the raw removal result so each
 * caller can render its own (differently-worded) toast.
 */
export async function performGroupMemberRemoval(params: {
  groupId: string;
  pubkey: string;
  sendAnnouncement?: (content: string) => Promise<void>;
  cancelPendingInvitation: (
    groupId: string,
    pubkey: string,
    sendAnnouncement?: (content: string) => Promise<void>,
  ) => Promise<CancelPendingInvitationResult>;
  getLiveMemberPubkeys: (groupId: string) => Promise<string[] | undefined>;
  deleteMemberProfile: (groupId: string, pubkey: string) => Promise<void>;
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
}): Promise<CancelPendingInvitationResult> {
  const result = await params.cancelPendingInvitation(
    params.groupId,
    params.pubkey,
    params.sendAnnouncement,
  );
  const liveMembers = await params.getLiveMemberPubkeys(params.groupId);
  const stillMember = computeStillMember(liveMembers, params.pubkey);
  await runPostRemovalCleanup({
    groupId: params.groupId,
    pubkey: params.pubkey,
    stillMember,
    deleteMemberProfile: params.deleteMemberProfile,
    clearPendingDirectInvite: params.clearPendingDirectInvite,
  });
  return result;
}

/** Toast-routing outcomes shared by onCancelInvite and onRemoveMember; only the
 * copy keys used for 'success'/'error' differ between the two callers. */
export type RemovalToastOutcome = 'raceNotice' | 'announcementWarning' | 'success' | 'error';

export function classifyRemovalResult(result: CancelPendingInvitationResult): RemovalToastOutcome {
  if (result.ok && result.raceDetected) return 'raceNotice';
  if (result.ok && result.announcementError) return 'announcementWarning';
  if (result.ok) return 'success';
  return 'error';
}

/** Captures sendMessage from ChatStore into a ref so GroupDetailView can use it. */
function ChatSendMessageCapture({ sendMessageRef }: { sendMessageRef: React.MutableRefObject<((c: string) => Promise<void>) | null> }) {
  const { sendMessage } = useChatStore();
  sendMessageRef.current = sendMessage;
  return null;
}

function GroupDetailView({ id }: { id: string }) {
  const copy = useCopy();
  const router = useRouter();
  const { groups, ready, getMemberProfiles, getGroup: getMarmotGroup, profileVersion, chatVersion, groupDataVersion, pollVersion, reactionsVersion, cancelPendingInvitation, requestProfilesIfStale, grantAdmin, renameGroup, getPendingRemovals, getPendingDirectInvites, getLiveMemberPubkeys, pendingRequests, loadPendingRequestsForGroup, approveJoinRequest, denyJoinRequest } = useMarmot();
  const { pubkeyHex, privateKeyHex } = useNostrIdentity();
  const signer = useMemo(
    () => (privateKeyHex ? createPrivateKeySigner(privateKeyHex) : null),
    [privateKeyHex],
  );
  const { profile: ownProfile } = useProfile();
  const toast = useToast();
  const inviteDisclosure = useDisclosure();
  const inviteLinkDisclosure = useDisclosure();
  const manageLinksDisclosure = useDisclosure();
  const pollDisclosure = useDisclosure();
  const [group, setGroup] = useState<Group | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [profileMap, setProfileMap] = useState<Record<string, MemberProfile>>({});
  const [confirmedPubkeys, setConfirmedPubkeys] = useState<Set<string>>(new Set());
  // AC-LABEL-1: pending-direct-invite marker Set, loaded exactly once per
  // member-list load (alongside confirmedPubkeys below) — never per-row.
  const [pendingInviteMarkers, setPendingInviteMarkers] = useState<Set<string>>(new Set());
  const [mlsGroup, setMlsGroup] = useState<MarmotGroupType | null>(null);
  // Join-request row UI state (formerly owned by the standalone
  // PendingRequestsSection): which request is mid-approve, and per-request
  // approve-failure flags. The request list itself lives in MarmotContext and
  // updates live as requests arrive/are approved/denied.
  const [approvingRequestId, setApprovingRequestId] = useState<string | null>(null);
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  // Ref to capture sendMessage from inside ChatStoreProvider without prop drilling
  const sendAnnouncementRef = useRef<((content: string) => Promise<void>) | null>(null);
  // Guards requestProfilesIfStale so it fires only once per group entry (on mount /
  // group-ID change), not on every profileVersion / groupDataVersion tick.
  const requestedOnEntryForRef = useRef<string | null>(null);

  // AC-REMOVE-1: both onCancelInvite and onRemoveMember call the SAME
  // performGroupMemberRemoval helper (which itself calls the same
  // cancelPendingInvitation MLS-remove wrapper) — they differ only in which
  // toast copy keys render the 'success'/'error' outcomes.
  const onCancelInvite = useCallback(async (pubkey: string) => {
    if (!group) return;
    const result = await performGroupMemberRemoval({
      groupId: group.id,
      pubkey,
      sendAnnouncement: sendAnnouncementRef.current ?? undefined,
      cancelPendingInvitation,
      getLiveMemberPubkeys,
      deleteMemberProfile,
      clearPendingDirectInvite,
    });
    switch (classifyRemovalResult(result)) {
      case 'raceNotice':
        toast({
          title: copy.groups.cancelInviteRaceNotice,
          status: 'info',
          duration: 4000,
          isClosable: true,
        });
        break;
      case 'announcementWarning':
        toast({
          title: copy.groups.cancelInviteAnnouncementWarning,
          status: 'warning',
          duration: 5000,
          isClosable: true,
        });
        break;
      case 'success':
        toast({
          title: copy.groups.cancelInviteSuccess,
          status: 'success',
          duration: 3000,
          isClosable: true,
        });
        break;
      case 'error':
        toast({
          title: copy.groups.cancelInviteError,
          status: 'error',
          duration: 4000,
          isClosable: true,
        });
        break;
    }
  }, [group, cancelPendingInvitation, getLiveMemberPubkeys, toast, copy.groups]);

  // AC-REMOVE-1: Remove Member reuses the identical shared removal helper —
  // same underlying MLS commit, only the success/error toast copy differs
  // (S6's removeMember* keys vs onCancelInvite's cancelInvite* keys).
  const onRemoveMember = useCallback(async (pubkey: string) => {
    if (!group) return;
    const result = await performGroupMemberRemoval({
      groupId: group.id,
      pubkey,
      sendAnnouncement: sendAnnouncementRef.current ?? undefined,
      cancelPendingInvitation,
      getLiveMemberPubkeys,
      deleteMemberProfile,
      clearPendingDirectInvite,
    });
    switch (classifyRemovalResult(result)) {
      case 'raceNotice':
        toast({
          title: copy.groups.cancelInviteRaceNotice,
          status: 'info',
          duration: 4000,
          isClosable: true,
        });
        break;
      case 'announcementWarning':
        toast({
          title: copy.groups.cancelInviteAnnouncementWarning,
          status: 'warning',
          duration: 5000,
          isClosable: true,
        });
        break;
      case 'success':
        toast({
          title: copy.groups.removeMemberSuccess,
          status: 'success',
          duration: 3000,
          isClosable: true,
        });
        break;
      case 'error':
        toast({
          title: copy.groups.removeMemberError,
          status: 'error',
          duration: 4000,
          isClosable: true,
        });
        break;
    }
  }, [group, cancelPendingInvitation, getLiveMemberPubkeys, toast, copy.groups]);

  // Join-request approve/deny — the merged inline affordance that replaced the
  // standalone admission section. MarmotContext owns the request list and
  // removes the row on success (approve) or discard (deny); this only tracks
  // the per-row spinner and error flag. Mirrors the former
  // PendingRequestsSection handlers verbatim.
  const handleApproveRequest = useCallback(async (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest) => {
    setApprovingRequestId(request.eventId);
    setRequestErrors((prev) => { const next = { ...prev }; delete next[request.eventId]; return next; });
    const result = await approveJoinRequest(request);
    if (result.ok) {
      // Fire-and-forget in-chat notice, mirroring the group_renamed announcement
      // (AC-SEND-1). Only on success — a failed approval posts nothing. The
      // admitter is attributed from the protocol MLS sender on render, never
      // from this payload (DD-2) — the payload carries only the admitted
      // member's pubkey.
      void sendAnnouncementRef.current?.(
        JSON.stringify({ type: 'member_admitted', pubkey: request.pubkeyHex }),
      );
    } else {
      setRequestErrors((prev) => ({ ...prev, [request.eventId]: result.error ?? 'unknown' }));
    }
    setApprovingRequestId(null);
  }, [approveJoinRequest]);

  const handleDenyRequest = useCallback(async (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest) => {
    await denyJoinRequest(request);
  }, [denyJoinRequest]);

  const handleMakeAdmin = useCallback(async (pubkey: string) => {
    if (!group) return;
    try {
      const result = await grantAdmin(group.id, pubkey);
      if (result.ok) {
        toast({
          title: copy.groups.makeAdminSuccess,
          status: 'success',
          duration: 3000,
          isClosable: true,
        });
      } else {
        // All non-ok results (closed codes + exhausted-retry raw messages) map to makeAdminError.
        toast({
          title: copy.groups.makeAdminError,
          status: 'error',
          duration: 4000,
          isClosable: true,
        });
      }
    } catch {
      toast({
        title: copy.groups.makeAdminError,
        status: 'error',
        duration: 4000,
        isClosable: true,
      });
    }
  }, [group, grantAdmin, toast, copy.groups]);

  // Inline group-rename (admin-only). The pencil swaps the heading for an input;
  // saving commits the new name to shared MLS metadata, then posts an in-chat
  // notice via the same sendMessage-backed closure used for other announcements.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const startRename = useCallback(() => {
    if (!group) return;
    setNameDraft(group.name);
    setEditingName(true);
  }, [group]);

  const cancelRename = useCallback(() => {
    setEditingName(false);
  }, []);

  const handleRename = useCallback(async () => {
    if (!group) return;
    const trimmed = nameDraft.trim();
    // No-op: empty or unchanged relative to the displayed name — just close.
    if (!trimmed || trimmed === group.name) {
      setEditingName(false);
      return;
    }
    setRenaming(true);
    try {
      const result = await renameGroup(group.id, trimmed);
      if (result.ok) {
        setEditingName(false);
        if (result.changed) {
          // Fire-and-forget in-chat notice (optimistically appended for the
          // actor by sendMessage; remote members render it on receipt).
          void sendAnnouncementRef.current?.(
            JSON.stringify({ type: 'group_renamed', name: trimmed }),
          );
        }
        toast({
          title: copy.groups.renameGroupSuccess,
          status: 'success',
          duration: 3000,
          isClosable: true,
        });
      } else {
        toast({
          title: copy.groups.renameGroupError,
          status: 'error',
          duration: 4000,
          isClosable: true,
        });
      }
    } catch {
      toast({
        title: copy.groups.renameGroupError,
        status: 'error',
        duration: 4000,
        isClosable: true,
      });
    } finally {
      setRenaming(false);
    }
  }, [group, nameDraft, renameGroup, toast, copy.groups]);

  useEffect(() => {
    if (!ready) return;
    const found = groups.find((g) => g.id === id);
    if (found) {
      setGroup(found);
      if (requestedOnEntryForRef.current !== id) {
        requestedOnEntryForRef.current = id;
        void requestProfilesIfStale(id);
      }
      markAsRead(id);
      void getMarmotGroup(id).then(setMlsGroup).catch(() => {});
      // Load open join requests for the inline approve/deny rows at the top of
      // the member list (admin-only render; harmless empty read for non-admins).
      void loadPendingRequestsForGroup(id);
      // AC-LABEL-1: load the pending-direct-invite marker Set exactly ONCE per
      // member-list load, alongside (not per-row inside) the profile fetch below.
      void getPendingDirectInvites(id).then(setPendingInviteMarkers).catch(() => {
        setPendingInviteMarkers(new Set());
      });
      void getMemberProfiles(id).then((profiles) => {
        const map: Record<string, MemberProfile> = {};
        // Track members who have sent a profile in this group (confirmed membership).
        // Members added to the MLS tree but not yet joined (no profile) show as pending.
        const confirmed = new Set<string>();
        for (const p of profiles) {
          map[p.pubkeyHex] = p;
          // Provisional entries (e.g. a name seeded from an approved join
          // request) fill the display name but do NOT confirm membership — the
          // member keeps the "Pending" badge until their real signed profile
          // arrives and supersedes the provisional entry.
          if (!p.provisional) confirmed.add(p.pubkeyHex);
        }

        // Fill gaps from the global contact cache (known from other groups)
        // Note: contact cache entries do NOT confirm membership in this group
        const contactCache = readContactCache();
        for (const pk of found.memberPubkeys) {
          if (!map[pk] && contactCache[pk]?.nickname) {
            map[pk] = {
              pubkeyHex: pk,
              nickname: contactCache[pk].nickname,
              avatar: contactCache[pk].avatar,
              updatedAt: contactCache[pk].updatedAt,
            };
          }
        }

        // Always overlay own profile from ProfileContext (never depends on MLS)
        if (pubkeyHex) {
          confirmed.add(pubkeyHex);
          if (ownProfile.nickname) {
            map[pubkeyHex] = {
              pubkeyHex,
              nickname: ownProfile.nickname,
              avatar: ownProfile.avatar,
              updatedAt: new Date().toISOString(),
            };
          }
        }

        setProfileMap(map);
        setConfirmedPubkeys(confirmed);
      }).catch(() => {});
    } else {
      setNotFound(true);
    }
  }, [ready, groups, id, getMemberProfiles, getPendingDirectInvites, loadPendingRequestsForGroup, pubkeyHex, ownProfile, profileVersion, groupDataVersion, requestProfilesIfStale]);

  // Register this group as the active view (epic: notification-domain-
  // invariants, INV-2): while its detail is open, a chat message, join request
  // or invite-link expiry for THIS group must not ring the bell — the increment
  // sites consult the registry (via getActiveGroupId / isActiveView('group',id))
  // and update the open view instead. Gated on the resolved group matching the
  // route id so we never register a stale previous-route group during client
  // nav. Cleared on unmount / navigation to the list so events for this group
  // ring the bell again once it is no longer on screen (INV-1).
  useEffect(() => {
    if (group?.id !== id) return;
    setActiveView({ domain: 'group', id });
    return () => clearActiveView();
  }, [group, id]);

  // Deep-link: `?manageLinks=1` opens the manage-invite-links overlay once
  // this detail view has actually rendered (AC-DEEPLINK-1) — `group?.id === id`
  // is that signal, set by the effect above only after `ready` AND a match
  // in `groups` are both true, never on initial mount before the group
  // resolves (and never against a stale previous-route group during nav).
  // Opens exactly once per deep-link arrival (the ref guard), then
  // strips the query param via router.replace (AC-DEEPLINK-2) so a reload of
  // the resulting URL does not re-open it.
  //
  // Gate-remediation fix (Finding 1, epic invite-link-lifecycle): the guard
  // is keyed to the group `id`, not a bare boolean. `GroupDetailView` is not
  // unmounted on client-side navigation between group detail URLs, so a bare
  // `useRef(false)` latches permanently after the first deep-link and blocks
  // every subsequent one — including a later expiry notification for a
  // DIFFERENT group. Mirrors the `requestedOnEntryForRef` /
  // `redirectHandledForRef` id-keyed-ref precedent elsewhere in this file.
  const manageLinksDeepLinkHandledRef = useRef<string | null>(null);
  const manageLinksParam = router.query.manageLinks as string | undefined;
  useEffect(() => {
    const { open, handledForId } = nextManageLinksGuard({
      manageLinksParam,
      // Require the RESOLVED group to match the current route id, not merely
      // `group !== null`: on client-side nav from group A to
      // `?id=B&manageLinks=1`, `group` still holds A during the first effect
      // pass after `id` changes. Gating on `group?.id === id` prevents opening
      // the overlay against A's links and consuming the param before B renders.
      groupResolved: group?.id === id,
      handledForId: manageLinksDeepLinkHandledRef.current,
      id,
    });
    manageLinksDeepLinkHandledRef.current = handledForId;
    if (!open) return;
    manageLinksDisclosure.onOpen();
    const nextQuery = { ...router.query };
    delete nextQuery.manageLinks;
    void router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
  }, [manageLinksParam, group, id, manageLinksDisclosure, router]);

  // AC-CLEAR-5 (epic: obsolete-notification-bell): opening the manage-invite-links
  // overlay for the current group acknowledges that group's expiry notifications.
  // This trigger previously lived in the deleted notification bell's expiry-row
  // onClick (which deep-linked to `?manageLinks=1` AND called markInviteExpiriesRead).
  // Without it, a current group whose only notification is an expired invite link
  // would keep a stuck card/nav pill — opening the group clears only chat messages
  // (markAsRead), and the redirect-branch clear at the bottom of this component
  // fires only for a stale groupId ABSENT from the list. Keyed on the disclosure
  // opening for the resolved current group; covers both the deep-link and the
  // in-view "Manage links" button. markInviteExpiriesRead persists
  // expiryAcknowledged so the badge stays cleared across sweep re-derives.
  const manageLinksOpen = manageLinksDisclosure.isOpen;
  useEffect(() => {
    if (!manageLinksOpen || !id || group?.id !== id) return;
    void markInviteExpiriesRead(id);
  }, [manageLinksOpen, id, group]);

  if (!ready) {
    return (
      <Box data-testid="group-detail-loading" py={8} textAlign="center">
        <Text color="textMuted">{copy.groups.loading}</Text>
      </Box>
    );
  }

  if (notFound && !group) {
    return (
      <Box data-testid="group-detail-not-found">
        <Alert status="warning" borderRadius="md">
          <AlertIcon />
          <AlertDescription>
            {copy.groups.groupNotFound}{' '}
            <NextLink href="/groups" passHref legacyBehavior>
              <Button as="a" variant="link" size="sm">
                {copy.groups.backToGroups}
              </Button>
            </NextLink>
          </AlertDescription>
        </Alert>
      </Box>
    );
  }

  if (!group) return null;

  const memberCount = group.memberPubkeys.length;
  // adminPubkeys is the single source of truth for both isAdmin and all child components.
  const adminPubkeys = mlsGroup?.groupData?.adminPubkeys ?? [];
  const isAdmin = !!(
    pubkeyHex &&
    adminPubkeys.some(
      (pk: string) => pk.toLowerCase() === pubkeyHex.toLowerCase(),
    )
  );
  // Pending removals: synchronous read; refreshes on each render (groupDataVersion drives re-renders via the effect above).
  const pendingRemovalPubkeys = getPendingRemovals(group.id);

  return (
    <>
      <Head>
        <title>{`${group.name} - ${copy.groups.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="group-detail-page">
        <HStack mb={4} justify="space-between" flexWrap="wrap" gap={3}>
          <Box>
            {/* Back-link is desktop-only: on mobile the always-present bottom
                tab bar carries the Groups destination, so this row is redundant. */}
            <NextLink href="/groups" passHref legacyBehavior>
              <Button as="a" variant="ghost" size="sm" mb={2} display={{ base: 'none', md: 'inline-flex' }}>
                ← {copy.groups.navLabel}
              </Button>
            </NextLink>
            {editingName ? (
              <HStack spacing={2} align="center">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename();
                    if (e.key === 'Escape') cancelRename();
                  }}
                  maxLength={64}
                  size="lg"
                  autoFocus
                  bg="surfaceBg"
                  maxW="360px"
                  aria-label={copy.groups.createGroupNameLabel}
                  data-testid="rename-group-input"
                />
                <Button
                  size="sm"
                  onClick={() => void handleRename()}
                  isLoading={renaming}
                  isDisabled={!nameDraft.trim() || nameDraft.trim() === group.name}
                  aria-label={copy.groups.renameGroupSave}
                  data-testid="rename-group-save"
                >
                  ✓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancelRename}
                  isDisabled={renaming}
                  aria-label={copy.groups.renameGroupCancel}
                  data-testid="rename-group-cancel"
                >
                  ✕
                </Button>
              </HStack>
            ) : (
              <HStack spacing={1} align="center">
                <Heading as="h1" size="xl">
                  {group.name}
                </Heading>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={startRename}
                    aria-label={copy.groups.renameGroupButton}
                    data-testid="rename-group-btn"
                  >
                    ✎
                  </Button>
                )}
              </HStack>
            )}
            <HStack mt={1} spacing={2}>
              <Badge colorScheme="brand" variant="subtle">
                {copy.groups.memberCount(memberCount)}
              </Badge>
              {memberCount >= 45 && (
                <Text fontSize="xs" color="textMuted">
                  {copy.groups.softLimitWarning}
                </Text>
              )}
            </HStack>
          </Box>
          <HStack spacing={2} flexWrap="wrap">
            <Button
              size="sm"
              onClick={inviteDisclosure.onOpen}
              isDisabled={!isAdmin}
              data-testid="invite-member-btn"
            >
              {copy.groups.inviteMember}
            </Button>
            <Button
              size="sm"
              onClick={inviteLinkDisclosure.onOpen}
              isDisabled={!isAdmin}
              data-testid="invite-link-btn"
            >
              {copy.groups.inviteLinkButton}
            </Button>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={manageLinksDisclosure.onOpen}
                data-testid="manage-links-btn"
              >
                {copy.groups.manageLinksButton}
              </Button>
            )}
            <LeaveGroupButton groupId={group.id} adminPubkeys={adminPubkeys} ownPubkeyHex={pubkeyHex} />
          </HStack>
        </HStack>

        <Divider mb={6} />

        <VStack spacing={6} align="stretch">
          {/* Members Section — a SINGLE list. Open join requests (admin-only)
              render as inline approve/deny rows at the top; in-tree members
              follow. The former standalone admission section is merged here. */}
          <Box>
            <Heading as="h2" size="md" mb={3}>
              {copy.groups.membersHeading}
            </Heading>
            {/* AC-GATE-3: onCancelInvite/onRemoveMember are admin-only actions */}
            <MemberList
              memberPubkeys={group.memberPubkeys}
              ownPubkeyHex={pubkeyHex}
              memberProfiles={profileMap}
              confirmedPubkeys={confirmedPubkeys}
              pendingInviteMarkers={pendingInviteMarkers}
              onCancelInvite={isAdmin ? onCancelInvite : undefined}
              onRemoveMember={isAdmin ? onRemoveMember : undefined}
              adminPubkeys={adminPubkeys}
              isCurrentUserAdmin={isAdmin}
              onMakeAdmin={isAdmin ? handleMakeAdmin : undefined}
              pendingRemovalPubkeys={pendingRemovalPubkeys}
              pendingRequests={isAdmin ? (pendingRequests[group.id] ?? []) : undefined}
              onApproveRequest={isAdmin ? handleApproveRequest : undefined}
              onDenyRequest={isAdmin ? handleDenyRequest : undefined}
              approvingRequestId={approvingRequestId}
              requestErrors={requestErrors}
            />
          </Box>

          {/* Chat + Polls Section */}
          <Box>
            <HStack mb={3} justify="space-between">
              <Heading as="h2" size="md">
                {copy.groups.chatHeading}
              </Heading>
              <HStack spacing={2}>
                {/* Voice/video call icons — rendered only while the call
                    feature is enabled (CALLS_ENABLED); code retained when off. */}
                {CALLS_ENABLED && pubkeyHex && (
                  <GroupCallToolbar
                    groupId={group.id}
                    memberPubkeys={group.memberPubkeys}
                    ownPubkeyHex={pubkeyHex}
                  />
                )}
                <Button
                  size="xs"
                  onClick={pollDisclosure.onOpen}
                  data-testid="create-poll-btn"
                >
                  {copy.polls.pollButton}
                </Button>
              </HStack>
            </HStack>
            <ChatStoreProvider
              groupId={group.id}
              group={mlsGroup}
              pubkey={pubkeyHex ?? ''}
              privateKeyHex={privateKeyHex}
              signer={signer}
              chatVersion={chatVersion}
              reactionsVersion={reactionsVersion}
              isCurrentUserAdmin={isAdmin}
            >
              <ChatSendMessageCapture sendMessageRef={sendAnnouncementRef} />
              <PollStoreProvider
                groupId={group.id}
                group={mlsGroup}
                pubkey={pubkeyHex ?? ''}
                pollVersion={pollVersion}
              >
                <Flex gap={4} direction={{ base: 'column', md: 'row' }}>
                  <Box flex="1" minW={0}>
                    <GroupChat threadId={group.id} pubkey={pubkeyHex ?? ''} profileMap={profileMap} isCurrentUserAdmin={isAdmin} />
                  </Box>
                  <Box w={{ base: '100%', md: '280px' }} flexShrink={0}>
                    <PollPanel pubkey={pubkeyHex ?? ''} profileMap={profileMap} />
                  </Box>
                </Flex>
                <CreatePollModal isOpen={pollDisclosure.isOpen} onClose={pollDisclosure.onClose} />
              </PollStoreProvider>
            </ChatStoreProvider>
          </Box>
        </VStack>
      </Box>

      <InviteMemberModal
        isOpen={inviteDisclosure.isOpen}
        onClose={inviteDisclosure.onClose}
        groupId={group.id}
        sendAnnouncement={(content: string) => sendAnnouncementRef.current?.(content) ?? Promise.resolve()}
      />

      <GenerateInviteLinkModal
        isOpen={inviteLinkDisclosure.isOpen}
        onClose={inviteLinkDisclosure.onClose}
        groupId={group.id}
        groupName={group.name}
      />

      <ManageInviteLinksModal
        isOpen={manageLinksDisclosure.isOpen}
        onClose={manageLinksDisclosure.onClose}
        groupId={group.id}
      />
    </>
  );
}

/* ---------- Invitation preview (read-only, pre-join) ---------- */

/**
 * Read-only preview of a pending invitation, reached via `/groups?invite=<id>`
 * (query param only — no dynamic path segment, per the static-export routing
 * rule). Shows the pre-join-decoded group name, description, "Invited by <X>"
 * attribution, and the group admin(s), plus Accept/Decline (epic:
 * inline-invitation-cards, S3). Group data is decoded locally from the stored
 * Welcome via `getInvitationGroupData` (S1) — no relay call; attribution reads
 * only local contacts. A member roster is NOT recoverable pre-join, so only
 * admins are shown.
 *
 * AC-PREVIEW-3: a stale/unknown invite id (already accepted/declined, or never
 * existed) does not crash — once client state has hydrated, it falls back to
 * the groups list. The `hydrated` gate avoids a redirect during the pre-
 * hydration render window where the store snapshot is still the SSR empty
 * array.
 */
function InvitationPreviewView({ id }: { id: string }) {
  const router = useRouter();
  const copy = useCopy();
  const { getInvitationGroupData, acceptPendingInvitation, declinePendingInvitation } = useMarmot();
  const { pubkeyHex, hydrated } = useNostrIdentity();
  const invitations = useSyncExternalStore(
    subscribePendingInvitations,
    getPendingInvitationsSnapshot,
    getPendingInvitationsServerSnapshot,
  );
  const invitation = invitations.find((inv) => inv.id === id);

  const [groupData, setGroupData] = useState<{ name: string; description: string; adminPubkeys: string[] } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // AC-PREVIEW-3: stale/unknown (or just accepted/declined) invite id → back to
  // the list. Gated on `hydrated` so we don't redirect during the pre-hydration
  // window (store snapshot is the SSR [] until the client settles). Accept and
  // Decline also remove the invitation from the store, so this same effect
  // performs the post-action navigation back to the list.
  useEffect(() => {
    if (hydrated && !invitation) {
      void router.replace('/groups');
    }
  }, [hydrated, invitation, router]);

  const welcomeJson = invitation?.welcomeEventJson;
  useEffect(() => {
    if (!welcomeJson) return;
    let cancelled = false;
    getInvitationGroupData(welcomeJson)
      .then((data) => {
        if (!cancelled) setGroupData(data);
      })
      .catch(() => {
        if (!cancelled) setGroupData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [welcomeJson, getInvitationGroupData]);

  if (!invitation) return null;

  const displayName = groupData?.name ? groupData.name : copy.groups.pendingInvitations.unknownGroupFallback;
  const description = groupData?.description?.trim();
  const admins = groupData?.adminPubkeys ?? [];
  const inviterLabel = resolveInviterLabel(invitation.inviterPubkeyHex, pubkeyHex);

  async function handleAccept() {
    setAccepting(true);
    setError(undefined);
    try {
      await acceptPendingInvitation(invitation!.id);
      await router.replace('/groups');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
      setAccepting(false);
    }
  }

  async function handleDecline() {
    await declinePendingInvitation(invitation!.id);
    await router.replace('/groups');
  }

  return (
    <>
      <Head>
        <title>{`${displayName} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="invitation-preview">
        <Button variant="ghost" size="sm" mb={4} onClick={() => void router.replace('/groups')}>
          ← {copy.groups.backToGroups}
        </Button>
        <VStack align="stretch" spacing={4} p={4} borderWidth="1px" borderRadius="lg" borderColor="borderSubtle" bg="surfaceBg">
          <HStack spacing={2} align="center" flexWrap="wrap">
            <Heading size="md" data-testid="invitation-preview-name">
              {displayName}
            </Heading>
            <Badge colorScheme={BADGE_ACCENT.invitation} variant="subtle">
              {copy.groups.pendingInvitations.badge}
            </Badge>
          </HStack>

          <Text fontSize="sm" color="textMuted" data-testid="invitation-preview-invited-by">
            {copy.groups.pendingInvitations.invitedBy(inviterLabel)}
          </Text>

          {description && (
            <Text fontSize="sm" data-testid="invitation-preview-description">
              {description}
            </Text>
          )}

          {admins.length > 0 && (
            <Box data-testid="invitation-preview-admins">
              <Text fontSize="xs" fontWeight="semibold" color="textMuted" mb={1}>
                {copy.groups.pendingInvitations.adminLabel}
              </Text>
              <VStack align="stretch" spacing={0}>
                {admins.map((admin) => (
                  <Text key={admin} fontSize="xs" color="textMuted" noOfLines={1}>
                    {resolveInviterLabel(admin, pubkeyHex) || truncatePubkey(admin)}
                  </Text>
                ))}
              </VStack>
            </Box>
          )}

          {error && (
            <Alert status="error" borderRadius="md" py={1} px={3}>
              <AlertIcon />
              <AlertDescription fontSize="xs">
                {copy.groups.pendingInvitations.acceptError}
              </AlertDescription>
            </Alert>
          )}

          <Divider />
          <HStack spacing={2}>
            <Button
              colorScheme="success"
              onClick={() => void handleAccept()}
              isLoading={accepting}
              data-testid="invitation-preview-accept"
            >
              {copy.groups.pendingInvitations.acceptBtn}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void handleDecline()}
              isDisabled={accepting}
              data-testid="invitation-preview-decline"
            >
              {copy.groups.pendingInvitations.declineBtn}
            </Button>
          </HStack>
        </VStack>
      </Box>
    </>
  );
}

/* ---------- List view (default) ---------- */

export default function GroupsPage() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const inviteId = router.query.invite as string | undefined;
  const joinNonce = router.query.join as string | undefined;
  const joinAdmin = router.query.admin as string | undefined;
  const joinName = router.query.name as string | undefined;
  const manageLinksParam = router.query.manageLinks as string | undefined;
  const copy = useCopy();
  const { groups, ready, unsupported } = useMarmot();
  const { backedUp, isFreshIdentity, hydrated } = useNostrIdentity();
  const { records: outboundRecords, loaded: outboundLoaded } = useOutboundJoinRequests();
  const invitations = useSyncExternalStore(
    subscribePendingInvitations,
    getPendingInvitationsSnapshot,
    getPendingInvitationsServerSnapshot,
  );
  const createDisclosure = useDisclosure();

  // AC-DEEPLINK-3: `?id=<id>&manageLinks=1` targeting a groupId absent from
  // the admin's current group list must render the groups list — not
  // GroupDetailView's own "not found" alert — and must clear that group's
  // inviteExpiries badge so a stale/foreign groupId can never wedge a
  // phantom, unreachable notification count. Use markInviteExpiriesRead (which
  // PERSISTS expiryAcknowledged on the stored links), not the in-memory-only
  // clearInviteExpiries: the badge is re-derived from persisted flags on every
  // cycle/reload, so an in-memory clear alone would be undone by the next
  // derive if this group still has expired+notified links on disk.
  const redirectToGroupsList = shouldRedirectToGroupsList({
    manageLinksParam,
    ready,
    id,
    groupIds: groups.map((g) => g.id),
  });
  const redirectHandledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!redirectToGroupsList || !id) return;
    if (redirectHandledForRef.current === id) return;
    redirectHandledForRef.current = id;
    void markInviteExpiriesRead(id);
    void router.replace('/groups');
  }, [redirectToGroupsList, id, router]);

  // When ?join=xxx is present AND this is a genuine first-time visitor
  // (DD-5, AC-LAND-2), show the full-screen join request card unchanged
  // from pre-S3 behavior — the isFreshIdentity branch that swaps in the
  // blended WelcomeInvite (group variant) lives INSIDE JoinRequestCard
  // itself (epic: first-visit-invite-welcome, story S4; it already owns the
  // name-draft/send-guard state that variant reuses), not here.
  //
  // Epic: invite-link-awaiting-landing, story S3 (AC-LAND-1) — a RETURNING
  // user (isFreshIdentity === false) with the same query params no longer
  // gets this full-screen replacement; it falls through to the normal list
  // view below, which renders InviteAwaitingBanner above the list instead.
  //
  // `!hydrated` is part of the gate so the pre-hydration window is byte-
  // equivalent to pre-S3: both `isFreshIdentity` and `hydrated` initialise to
  // false, so before identity resolves EVERY visitor would otherwise fall
  // through and a genuine first-timer would briefly flash the list/banner
  // before snapping to the full-screen card. Holding the full-screen path
  // until `hydrated` (JoinRequestCard renders its own loading state) preserves
  // the old first-visit experience; only a confirmed returning user
  // (hydrated && !isFreshIdentity) reaches the new banner landing.
  if (joinNonce && joinAdmin && joinName && (isFreshIdentity || !hydrated)) {
    // Gate-remediation (Finding A, epic mobile-qr-scanner): `key={joinNonce}`
    // forces a remount whenever the invite changes while this branch stays
    // mounted. The FAB (this epic) makes that reachable for the first time —
    // it can `router.push` a NEW `?join=` invite while the visitor is still
    // sitting on this full-screen card (the FAB is visible here: no `id`
    // query on the invite-landing route, so `hideBottomNav` doesn't hide
    // it). Without the key, JoinRequestCard's mount-persistent `sent`/
    // `error`/name-draft state would leak across invites — e.g. a visitor
    // who sent a request for invite A would see the terminal "request sent"
    // alert for invite B, though nothing was ever sent for B. A remount
    // correctly resets that state for the new invite.
    return <JoinRequestCard key={joinNonce} nonce={joinNonce} adminNpub={joinAdmin} groupName={joinName} />;
  }

  // When ?invite=<id> is present, show the read-only invitation preview
  // (epic: inline-invitation-cards, S3). Query-param only, no dynamic path
  // segment (static-export routing rule). A stale/unknown id falls back to the
  // list inside the view itself (AC-PREVIEW-3).
  if (inviteId) {
    return <InvitationPreviewView id={inviteId} />;
  }

  // When ?id=xxx is present, show the detail view — unless the S4 deep-link
  // redirect above determined the target group is absent (AC-DEEPLINK-3), in
  // which case fall through to the plain groups list below.
  if (id && !redirectToGroupsList) {
    return <GroupDetailView id={id} />;
  }

  return (
    <>
      <Head>
        <title>{`${copy.groups.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="groups-page">
        {/* Offline indicator */}
        <OfflineBanner />

        {/* Backup reminder: only when user is in groups and hasn't backed up */}
        {ready && groups.length > 0 && !backedUp && (
          <BackupReminderBanner />
        )}

        {/* AC-LAND-1/AC-BANNER-1..5: returning-user invite-link banner,
            rendered above the list — its own container, visually distinct
            from PendingInvitations below (AC-BANNER-5). Only mounted when
            join+admin+name are all present; the component itself resolves
            Invited/Awaiting/already-member/loading via S2's reactive store. */}
        {joinNonce && joinAdmin && joinName && (
          <InviteAwaitingBanner nonce={joinNonce} adminNpub={joinAdmin} groupName={joinName} />
        )}

        <Box mb={6}>
          <Heading as="h1" size="xl" mb={4}>
            {copy.groups.heading}
          </Heading>

          {!unsupported && (
            <Button onClick={createDisclosure.onOpen} isDisabled={!ready} data-testid="create-group-btn">
              {copy.groups.createGroup}
            </Button>
          )}
        </Box>

        {unsupported && (
          <Alert
            status="warning"
            borderRadius="md"
            flexDirection="column"
            alignItems="flex-start"
            gap={2}
            data-testid="groups-https-required"
          >
            <AlertIcon />
            <Box>
              <Text fontWeight="semibold">{copy.groups.httpsRequired}</Text>
              <AlertDescription>
                <Text>{copy.groups.httpsRequiredBody}</Text>
              </AlertDescription>
            </Box>
          </Alert>
        )}

        {!ready && !unsupported && (
          <Box py={8} textAlign="center" color="textMuted">
            <Text>{copy.groups.loading}</Text>
          </Box>
        )}

        {/* `outboundLoaded` gate (Codex pre-commit review, P2): the outbound
            store loads asynchronously, so `outboundRecords` is empty during
            its initial IDB read. Without this gate, a returning user with
            persisted awaiting requests but no joined groups would briefly see
            the "no groups" empty state before the awaiting cards render. Only
            treat an empty outbound set as authoritative once it has loaded. */}
        {ready && outboundLoaded && groups.length === 0 && outboundRecords.length === 0 && invitations.length === 0 && (
          <Alert
            status="info"
            borderRadius="md"
            flexDirection="column"
            alignItems="flex-start"
            gap={2}
            data-testid="groups-empty-state"
          >
            <AlertIcon />
            <Box>
              <Text fontWeight="semibold">{copy.groups.noGroups}</Text>
              <AlertDescription>
                <Text>{copy.groups.noGroupsBody}</Text>
              </AlertDescription>
            </Box>
          </Alert>
        )}

        {ready && (groups.length > 0 || outboundRecords.length > 0 || (!unsupported && invitations.length > 0)) && (
          <VStack spacing={3} align="stretch" data-testid="groups-list">
            {!unsupported && invitations.length > 0 && (
              <Box data-testid="pending-invitations-section">
                {/* This testid is a deliberately retained stable readiness gate, NOT
                    a visible section anymore (AC-REMOVE-1: no heading text, no
                    empty-state — this wrapper renders only when >=1 invitation
                    exists). ~19 peripheral e2e spec files plus
                    helpers/group-setup.ts's invite-accept helper poll this testid
                    before interacting with an invitation card — do not rename it. */}
                <VStack spacing={3} align="stretch">
                  {invitations.map((inv) => (
                    <InvitationCard key={inv.id} invitation={inv} />
                  ))}
                </VStack>
              </Box>
            )}
            {groups.map((group) => (
              <GroupCard key={group.id} group={group} />
            ))}
            {outboundRecords.map((record) => (
              <OutboundJoinRequestCard key={record.nonce} record={record} />
            ))}
          </VStack>
        )}
      </Box>

      <CreateGroupModal
        isOpen={createDisclosure.isOpen}
        onClose={createDisclosure.onClose}
      />
    </>
  );
}
