/**
 * MarmotContext — wraps marmot-ts MarmotClient behind a stable adapter interface.
 *
 * Provides group CRUD operations and member profile management.
 * All marmot-ts calls are wrapped in try/catch — it's alpha software.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Group, MemberProfile, UserProfile } from '@/src/types';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useCopy } from '@/src/context/LanguageContext';
import {
  loadAllGroups,
  saveGroup as persistGroup,
  deleteGroup as removeGroupFromStorage,
  loadMemberProfiles,
  mergeMemberProfile,
  clearMemberProfiles,
  IdbGroupStateBackend,
  IdbKeyPackageBackend,
  clearAllGroupData,
} from '@/src/lib/marmot/groupStorage';
import type { WelcomeReceivedCallback, UnwrappedRumor } from '@/src/lib/marmot/welcomeSubscription';
import { serialiseProfileUpdate, PROFILE_RUMOR_KIND } from '@/src/lib/marmot/profileSync';
import { LEAVE_INTENT_KIND, serialiseLeaveIntent } from '@/src/lib/marmot/leaveSync';
import { PROFILE_REQUEST_KIND } from '@/src/lib/marmot/profileRequestSync';
import { recordRequestEmitted, recordRequestAnswered, loadProfileRequestMemo, clearProfileRequestMemos } from '@/src/lib/marmot/profileRequestStorage';
import { handleIncomingProfileRequest, notifyProfileObserved, sweepStaleProfiles } from '@/src/lib/marmot/profileRequestRunner';
import { incrementUnread, markAsRead, initUnreadCounts, initJoinRequestCounts, clearUnreadGroup, incrementJoinRequest, decrementJoinRequest, purgeStrangerDmCounters, clearInviteExpiries } from '@/src/lib/unreadStore';
import { isActiveView, getActiveGroupId } from '@/src/lib/activeViewStore';
import { appendMessage, loadMessages, purgeStrangerDmThreads, CHAT_MESSAGE_KIND } from '@/src/lib/marmot/chatPersistence';
import { purgeStrangerContacts } from '@/src/lib/contacts';
import { purgeStrangerDmReactions } from '@/src/lib/reactions/api';
import { loadKnownPeers, rememberKnownPeers, knownPeersMigrationComplete, markKnownPeersMigrationComplete } from '@/src/lib/knownPeers';
import { MAINTAINER_PUBKEYS_HEX } from '@/src/config/maintainer';
import { buildDispatcher } from '@/src/lib/marmot/registerHandlers';
import { clearPendingDirectInvite } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { applyInboundRumor } from '@/src/lib/reactions/api';
import { applyDeleteEditSignal, resolvePendingSignalsForSlot, registerGroupAdminsProvider } from '@/src/lib/messageEdits/api';
import { savePoll, saveVote, getPoll, clearPollData } from '@/src/lib/marmot/pollPersistence';
import { clearGroupMedia } from '@/src/lib/marmot/mediaPersistence';
import { membersChanged } from '@/src/lib/marmot/memberGuard';
import type { Poll, PollVote } from '@/src/lib/marmot/pollPersistence';
import { useProfile } from '@/src/context/ProfileContext';
import { useBackup } from '@/src/context/BackupContext';

async function startWelcomeSubscription(
  pubkeyHex: string,
  marmotClient: MarmotClientType,
  ndk: import('@nostr-dev-kit/ndk').default,
  signer: import('applesauce-core').EventSigner,
  onGroupJoined: WelcomeReceivedCallback,
  onJoinRequestReceived?: import('@/src/lib/marmot/joinRequestHandler').JoinRequestReceivedCallback,
  groupMemberPubkeys?: (groupId: string) => string[],
  ownPrivateKeyHex?: string,
  onPairingAckReceived?: (result: { senderPubkeyHex: string }) => void,
  // S6 (decline-a, authorized external-port extension): the Remove/announce
  // capability the decline receive branch needs — see the call site below.
  declineDeps?: import('@/src/lib/marmot/welcomeSubscription').DeclineReceiveDeps,
): Promise<() => void> {
  const { subscribeToWelcomes } = await import('@/src/lib/marmot/welcomeSubscription');
  return subscribeToWelcomes(
    pubkeyHex,
    marmotClient,
    ndk,
    signer,
    onGroupJoined,
    onJoinRequestReceived,
    groupMemberPubkeys,
    ownPrivateKeyHex,
    onPairingAckReceived,
    declineDeps,
  );
}
import { DEFAULT_RELAYS } from '@/src/types';
import { getEffectiveRelays } from '@/src/lib/relay';
import { getEventHash } from 'applesauce-core/helpers/event';

/**
 * WORKAROUND: ts-mls forbids application messages when unappliedProposals
 * is non-empty. This catches the error, commits pending proposals, and
 * retries. Requires the sender to be an admin (commit() has an admin check).
 * For fire-and-forget callers, pass `softFail: true`.
 *
 * Root cause: admin promotion during invite can silently fail, leaving
 * members unable to commit. The real fix is to guarantee admin promotion
 * succeeds (retry / block invite until confirmed).
 */
const MAX_RETRIES = 3;
async function sendRumorSafe(
  group: MarmotGroupType,
  rumor: Parameters<MarmotGroupType['sendApplicationRumor']>[0],
  opts?: { softFail?: boolean },
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await group.sendApplicationRumor(rumor);
      return;
    } catch (err) {
      const isUnapplied = err instanceof Error && err.message.includes('unapplied proposals');
      if (!isUnapplied || attempt === MAX_RETRIES) {
        if (opts?.softFail) return;
        throw err;
      }
      console.warn(`[sendRumorSafe] unapplied proposals (attempt ${attempt + 1}/${MAX_RETRIES + 1}), committing…`);
      try {
        await group.commit();
      } catch (commitErr) {
        if (opts?.softFail) return;
        throw commitErr;
      }
    }
  }
}

/** Build a properly-hashed MIP-03 rumor for sendApplicationRumor. */
function buildRumor(kind: number, content: string, pubkey: string, tags: string[][] = []) {
  const rumor = {
    id: '',
    kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

// We import marmot types lazily to avoid SSR issues
type MarmotClientType = import('@internet-privacy/marmot-ts').MarmotClient;
type MarmotGroupType = import('@internet-privacy/marmot-ts').MarmotGroup;

// ts-mls proposalType constant for Remove (RFC 9420 §12.1.3).
// Mirrors the constant in cancelInvitationImpl.ts — defined locally so this
// module stays self-contained and never imports from a sibling lib/ file.
const PROPOSAL_TYPE_REMOVE = 3;

/** Shape accepted by fireAutoCommit so the function is testable without React. */
export interface FireAutoCommitDeps {
  /** Live MLS group re-fetched at timer-fire time (not a stale closure). */
  mlsGroup: {
    state: any;
    groupData?: { adminPubkeys?: string[] } | null;
    commit: (opts: { extraProposals: any[] }) => Promise<unknown>;
  };
  /** Returns leaf node indexes for the pubkey in the current ratchet tree. */
  getPubkeyLeafNodeIndexes: (state: any, pubkey: string) => number[];
  /** Builds a metadata-update proposal. Passed in to avoid repeating the dynamic import. */
  proposeUpdateMetadata: (args: { adminPubkeys: string[] }) => unknown;
  /** Snapshot of pending removals for this group at timer-fire time. */
  pendingQueue: Array<{ groupId: string; pubkey: string; receivedAt: number }>;
  /**
   * Called on successful commit with the list of pubkeys that were committed.
   * The callback must filter them out of the live queue without clearing entries
   * that arrived during the commit window.
   */
  onCommitted: (committedPubkeys: string[]) => void;
}

/**
 * S5 — auto-commit timer body.
 *
 * Exported (not just module-scope) so unit tests can call it directly without
 * rendering MarmotProvider or manipulating timers.
 *
 * Invariants:
 *   - Exactly ONE mlsGroup.commit() call per invocation (AC-COMMIT-4).
 *   - Remove proposals are plain objects { proposalType: 3, remove: { removed } }
 *     — never proposeRemoveUser() or Proposals.Remove() (AC-COMMIT-3).
 *   - remainingAdmins is derived from VALID entries (non-empty leaf indexes) and
 *     the live mlsGroup.groupData?.adminPubkeys at fire time (AC-COMMIT-5).
 *   - On commit failure onCommitted is NOT called — entries stay for next cycle (AC-COMMIT-7).
 */
export async function fireAutoCommit(deps: FireAutoCommitDeps): Promise<void> {
  const { mlsGroup, getPubkeyLeafNodeIndexes, proposeUpdateMetadata, pendingQueue, onCommitted } =
    deps;

  // Deduplicate: collect unique pubkeys from the snapshot.
  const uniquePubkeys = [...new Set(pendingQueue.map((e) => e.pubkey))];

  // Build Remove proposals — one per leaf index per pubkey.
  // Stale-leaf guard (AC-COMMIT-2 / AC-EDGE-1): if getPubkeyLeafNodeIndexes returns []
  // the pubkey was already removed (concurrent admin commit). Drop the entry silently.
  const validEntries: Array<{ pubkey: string; leafIndexes: number[] }> = [];
  const droppedPubkeys: string[] = [];

  for (const pubkey of uniquePubkeys) {
    const leafIndexes = getPubkeyLeafNodeIndexes(mlsGroup.state, pubkey);
    if (leafIndexes.length === 0) {
      // Race-detected or already removed — drop silently (AC-COMMIT-2, AC-EDGE-1, AC-EDGE-2).
      droppedPubkeys.push(pubkey);
      continue;
    }
    validEntries.push({ pubkey, leafIndexes });
  }

  // Drop stale entries from the live queue immediately even if nothing is left to commit.
  if (droppedPubkeys.length > 0) {
    onCommitted(droppedPubkeys);
  }

  // Nothing valid to commit — exit without calling mlsGroup.commit().
  if (validEntries.length === 0) {
    return;
  }

  // Build plain-object Remove proposals (AC-COMMIT-3).
  // One Remove per leaf index; a pubkey with multiple leaf entries (degenerate)
  // gets one Remove per index.
  const removeProposals = validEntries.flatMap(({ leafIndexes }) =>
    leafIndexes.map((leafIndex) => ({
      proposalType: PROPOSAL_TYPE_REMOVE,
      remove: { removed: leafIndex },
    })),
  );

  // Compute remainingAdmins from VALID entries at fire time (AC-COMMIT-5).
  const departingPubkeys = validEntries.map((e) => e.pubkey);
  const currentAdmins = mlsGroup.groupData?.adminPubkeys ?? [];
  const remainingAdmins = currentAdmins.filter((pk) => !departingPubkeys.includes(pk));

  // Single commit — both Remove proposals AND adminPubkeys update in one call (AC-COMMIT-4).
  try {
    await mlsGroup.commit({
      extraProposals: [...removeProposals, proposeUpdateMetadata({ adminPubkeys: remainingAdmins })],
    });
  } catch (err) {
    // AC-COMMIT-7 / AC-EDGE-4 / AC-EDGE-8: leave entries in queue for next timer cycle.
    // Do NOT call onCommitted — the next cycle will re-derive leaf indexes freshly.
    console.warn('[Marmot] fireAutoCommit: commit failed, entries retained for retry:', err);
    return;
  }

  // Success: remove committed pubkeys from the live queue (AC-COMMIT-6).
  // Entries enqueued during the commit window survive because onCommitted
  // filters by pubkey, not by clearing the whole array.
  onCommitted(departingPubkeys);
}

type MarmotContextValue = {
  /** Whether marmot client has been initialized */
  ready: boolean;
  /**
   * Resolves the first time `ready` becomes true (immediately if already ready).
   * Lets consumers await readiness instead of polling — e.g. ContactChat gating
   * historical DMs on group state being loaded.
   */
  whenReady: () => Promise<void>;
  /** True when groups are unavailable (e.g. non-HTTPS context) */
  unsupported: boolean;
  /** All groups the user belongs to */
  groups: Group[];
  /** Create a new group */
  createGroup: (name: string) => Promise<Group | null>;
  /** Invite a user by npub to a group */
  inviteByNpub: (groupId: string, npub: string) => Promise<{ ok: boolean; error?: string }>;
  /** Leave a group */
  leaveGroup: (groupId: string) => Promise<boolean>;
  /** Publish profile to all groups. Pass profileOverride to avoid stale-closure race. */
  publishProfileUpdate: (profileOverride?: UserProfile) => Promise<void>;
  /** Get member profiles for a given group */
  getMemberProfiles: (groupId: string) => Promise<MemberProfile[]>;
  /** Reload groups from storage */
  reloadGroups: () => Promise<void>;
  /** Clear all group data (for reset) */
  clearAll: () => Promise<void>;
  /** Get a MarmotGroup by ID (for chat, etc.) */
  getGroup: (groupId: string) => Promise<MarmotGroupType | null>;
  /** Live MLS member pubkeys for a group, read fresh on every call. undefined when unreadable (fail-closed). */
  getLiveMemberPubkeys: (groupId: string) => Promise<string[] | undefined>;
  /** Access to the underlying MarmotClient (for advanced use) */
  getClient: () => MarmotClientType | null;
  /** Monotonically increasing counter bumped on each received profile message */
  profileVersion: number;
  /** Monotonically increasing counter bumped on each received chat message */
  chatVersion: number;
  /** Monotonically increasing counter bumped when group metadata (e.g. adminPubkeys) may change */
  groupDataVersion: number;
  /** Monotonically increasing counter bumped on each received poll message */
  pollVersion: number;
  /** Monotonically increasing counter bumped on each successfully applied inbound kind-7 reaction */
  reactionsVersion: number;
  /** Pending join requests per group (loaded on demand) */
  pendingRequests: Record<string, import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest[]>;
  /** Load pending join requests for a group from IDB into state */
  loadPendingRequestsForGroup: (groupId: string) => Promise<void>;
  /** Approve a join request: invite by npub, remove request, decrement bell */
  approveJoinRequest: (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest) => Promise<{ ok: boolean; error?: string }>;
  /** Deny a join request: remove request, decrement bell */
  denyJoinRequest: (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest) => Promise<void>;
  /** Returns true if pubkey is in MLS member list but has no profile rumor recorded for this group */
  isPendingMember: (groupId: string, pubkey: string) => Promise<boolean>;
  /** Cancel a pending invitation: MLS Remove+UpdateMetadata commit + announcement + refresh. sendAnnouncement is optional and called after commit if provided. */
  cancelPendingInvitation: (groupId: string, pubkey: string, sendAnnouncement?: (content: string) => Promise<void>) => Promise<{ ok: boolean; error?: string; raceDetected?: boolean; announcementError?: string }>;
  /** Read every pubkey currently marked pending-direct-invite for a group, as a fresh Set<string> (no cache) — the PendingDirectInviteMarkerSet seam contract. */
  getPendingDirectInvites: (groupId: string) => Promise<Set<string>>;
  /** Proactive sweep: emit PROFILE_REQUEST_KIND for all stale members in a single group. Fire-and-forget. */
  requestProfilesIfStale: (groupId: string) => Promise<void>;
  /** Accept a pending invitation: calls joinGroupFromWelcome, removes from queue on success/failure. */
  acceptPendingInvitation: (id: string) => Promise<void>;
  /** Decline a pending invitation: removes from queue, no network call. */
  declinePendingInvitation: (id: string) => Promise<void>;
  /** Reads a stored invitation's pre-join group data (name/description/admins) without joining. Returns null on parse failure, client-not-ready, or undecodable Welcome. */
  getInvitationGroupData: (welcomeEventJson: string) => Promise<{ name: string; description: string; adminPubkeys: string[] } | null>;
  /** Grant admin status to a member. Idempotent; superset guard prevents demotion; retries once on epoch conflict. */
  grantAdmin: (groupId: string, pubkey: string) => Promise<{ ok: boolean; error?: string }>;
  /** Rename the group via an admin-only MLS metadata commit. Validates/​trims the name; no-op (changed:false) when unchanged. */
  renameGroup: (groupId: string, name: string) => Promise<{ ok: boolean; error?: string; changed?: boolean }>;
  /** Synchronously returns hex pubkeys of members with a pending out-of-band leave event queued in pendingRemovalsRef. */
  getPendingRemovals: (groupId: string) => string[];
  /**
   * Re-publish key-package discoverability and kind 30051 relay list to the given relay URLs.
   * Call after saving a new relay list so discovery uses the updated set immediately.
   */
  republishDiscoverability: (relayUrls: string[]) => Promise<void>;
  /**
   * Monotonically increasing counter bumped whenever lp_knownPeers_v1 is written
   * OUTSIDE the group-membership-driven seeding effects above (currently: the
   * manual add-contact-by-npub flow). The three always-mounted watchers
   * (DirectMessageNotificationsWatcher, IncomingCallWatcher, ContactChat) cache
   * loadKnownPeers() in a ref that previously refreshed only on `groups` changes;
   * before manual-add, every knownPeers write coincided with a groups change, so
   * that was sufficient. This counter gives those refresh effects a second,
   * independent trigger so a manually-added contact is immediately reachable via
   * DMs/calls without waiting for an unrelated group change or a full reload.
   */
  knownPeersRevision: number;
  /**
   * Bumps knownPeersRevision. Call after any successful out-of-band write to
   * lp_knownPeers_v1 that does not already correlate with a `groups` change —
   * e.g. after addContactByNpub succeeds in AddContactModal.
   */
  notifyKnownPeersChanged: () => void;
  /**
   * Monotonically increasing counter bumped whenever a contact's `archivedAt`
   * (block/unblock, `lp_contacts_v1`) is written outside this context's own
   * effects (epic: block-contact, S1). Mirrors `knownPeersRevision`'s
   * ref-refresh mechanism but is a SEPARATE counter — `knownPeersRevision`'s
   * contract is specifically "lp_knownPeers_v1 changed"; block/unblock never
   * touches that key, so overloading it here would let a future consumer
   * assume a knownPeersRevision bump always means `loadKnownPeers()` has
   * fresh data, which would no longer hold. Consumers that need to react to
   * block/unblock without unmount/remount (`DirectMessageNotificationsWatcher`
   * in S2, `ContactChat` in S4) list this alongside `groups` /
   * `knownPeersRevision` in their ref-refresh effect's dependency array. This
   * story exposes and bumps the counter; it does not yet call
   * `notifyBlockedPeersChanged` from any UI action — that wiring belongs to
   * S4's `handleArchiveToggle` (block branch: confirm -> archiveContact ->
   * history wipe -> revision bump; unblock branch: unarchiveContact -> bump).
   */
  blockedPeersRevision: number;
  /**
   * Bumps blockedPeersRevision. Call after any successful `archiveContact` /
   * `unarchiveContact` write so the always-mounted DM surfaces observe the
   * block/unblock immediately, without unmount/remount or a page reload.
   */
  notifyBlockedPeersChanged: () => void;
  /**
   * Monotonically increasing counter bumped whenever a contact record in
   * `lp_contacts_v1` / the contact cache changes as the result of an arriving
   * event — a newly-remembered or newly-pending contact, or a profile
   * announcement updating a contact's nickname/avatar (epic: contacts-live-
   * updates). Mirrors `blockedPeersRevision`'s ref/memo-refresh mechanism but
   * is a SEPARATE counter: `blockedPeersRevision` means specifically
   * "archivedAt changed", `knownPeersRevision` means "lp_knownPeers_v1
   * changed"; this one means "a contact's list membership or displayed
   * profile changed" and drives the live contacts list, the DM detail header,
   * and the notification bell's name/avatar row lookups to re-derive without a
   * reload. Consumers list it in their memo/effect dependency arrays; the
   * contacts store itself stays a pure localStorage layer (no React import) —
   * the notify is issued from the watcher/effect layer that owns the write.
   */
  contactsRevision: number;
  /**
   * Bumps contactsRevision. Call after any arrival-time contact write lands —
   * inbound-DM `rememberContact`, a profile-announce cache write, or the
   * issuer-side pending admission — so the always-mounted contacts surfaces
   * observe the change immediately, without unmount/remount or a page reload.
   */
  notifyContactsChanged: () => void;
};

const MarmotContext = createContext<MarmotContextValue | null>(null);

/*
 * NOTE — pairing-admission-digest decision core (below). The floating toast
 * that once surfaced this digest was removed (product decision: no toast for
 * a redemption of a code the user shared earlier; the new contact simply
 * appears in the list). These pure functions have NO production caller today;
 * they are retained, exported, and unit-tested as the reusable decision core
 * for a future notification-bell row ("N people paired with your code"), which
 * is the intended long-term home for this signal. If that bell is never built,
 * this block (and admissionDigest.test.ts + the pairingAdmissionDigest i18n
 * string) can be deleted wholesale.
 */

/**
 * S5 (epic: contact-pairing-code, AC-UI-2) — count the distinct senders in
 * `admissions` (S3's `getPairingAckAdmissions()` map: senderPubkeyHex ->
 * echoedNonceHex) whose echoed nonce equals `activeNonceHex`. Pure and
 * exported (mirrors `fireAutoCommit` above) so this can be unit-tested
 * directly without rendering `MarmotProvider` — no jsdom, no React needed.
 * Read-only over its inputs; never mutates the map it is given.
 */
export function countAdmissionsForActiveNonce(
  admissions: ReadonlyMap<string, string>,
  activeNonceHex: string,
): number {
  let count = 0;
  for (const echoedNonceHex of admissions.values()) {
    if (echoedNonceHex === activeNonceHex) count += 1;
  }
  return count;
}

/**
 * Minimal shape `applyPairingAdmissionDigest` needs from Chakra's `useToast()`
 * return value — dispatch-injected (no direct `@chakra-ui/react` import at
 * this function's call boundary) so the decision below is unit-testable with
 * a plain fake, mirroring `fireAutoCommit`'s dependency-injection pattern.
 */
export type PairingDigestDispatch = {
  isActive: (id: string) => boolean;
  update: (id: string, options: { title: string; status: 'success'; duration: number; isClosable: boolean }) => void;
  show: (options: { id: string; title: string; status: 'success'; duration: number; isClosable: boolean }) => void;
};

/**
 * S5 (epic: contact-pairing-code, AC-UI-2) — the digest-notification decision
 * core. Computes the distinct-sender count for `activeNonceHex` via
 * `countAdmissionsForActiveNonce` and, ONLY once that count reaches 2, shows
 * or updates a SINGLE toast identified by `toastId`: `dispatch.show` the
 * first time the threshold is crossed for this nonce, `dispatch.update` on
 * every subsequent admission for the SAME nonce — never a second, stacked
 * toast (the "one digest notification, not one toast per admission"
 * requirement). A count below 2 is a no-op: the single-admission case shows
 * no notification of its own, matching the pre-existing (silent) behavior
 * S3 left in place. Pure over its inputs plus the injected `dispatch` (no
 * hidden module-scope state), exported so this can be unit-tested without
 * rendering `MarmotProvider` or touching jsdom.
 */
export function applyPairingAdmissionDigest(
  admissions: ReadonlyMap<string, string>,
  activeNonceHex: string,
  toastId: string,
  formatTitle: (count: number) => string,
  dispatch: PairingDigestDispatch,
): void {
  const count = countAdmissionsForActiveNonce(admissions, activeNonceHex);
  if (count < 2) return;
  const title = formatTitle(count);
  if (dispatch.isActive(toastId)) {
    dispatch.update(toastId, { title, status: 'success', duration: 4000, isClosable: true });
  } else {
    dispatch.show({ id: toastId, title, status: 'success', duration: 4000, isClosable: true });
  }
}

/**
 * Review-remediation (epic: contact-pairing-code, story S5, sev 3
 * correctness finding) — the full "resolve the active nonce, then apply the
 * digest decision" wiring, extracted as a pure/injected-effects function so
 * this exact bug class is structurally prevented AND unit-testable: `peek`'s
 * type signature (`() => { nonce: string } | null`) offers no mint
 * capability at all, so there is no code path here that could accidentally
 * call a minting primitive instead of a read-only one. If `peek()` returns
 * `null` (no code shared this session, or the active nonce already expired
 * with no subsequent mint/reload), this is a no-op — no dispatch call, no
 * crash, and critically no attempt to mint a replacement just because an ack
 * arrived. In production, `peek` is `nonceStore.ts#peekActiveNonce`; tests
 * inject a plain fake with no persistence behind it at all.
 */
export function resolveAndApplyPairingAdmissionDigest(
  admissions: ReadonlyMap<string, string>,
  peek: () => { nonce: string } | null,
  toastId: string,
  formatTitle: (count: number) => string,
  dispatch: PairingDigestDispatch,
): void {
  const active = peek();
  if (!active) return;
  applyPairingAdmissionDigest(admissions, active.nonce, toastId, formatTitle, dispatch);
}

/** Shape of a queued out-of-band leave event pending the 5-second debounce commit (S4). */
interface PendingRemoval {
  groupId: string;
  pubkey: string;
  receivedAt: number;
}

/**
 * Epic invite-link-lifecycle, story S2 (AC-USAGE-1/2/3) — the full body of
 * `approveJoinRequest`, extracted as a pure/dependency-injected function so
 * it is unit-testable without rendering React: this repo has no jsdom/
 * @testing-library/renderHook precedent (see pendingRequestsSection.test.ts's
 * own comment that MarmotContext "is difficult to unit test" without an
 * extraction seam), and a useCallback-wrapped closure cannot be invoked
 * outside a live render. The `approveJoinRequest` callback below is now a
 * thin wrapper that resolves its real dynamic-import dependencies and
 * delegates here, so the unit tests exercise this exact production function,
 * not a hand-rolled stand-in.
 *
 * Design Decision 7 / AC-USAGE-2: approval is never gated on invite-link
 * liveness. `inviteByNpub` and the approval-completion steps (delete pending
 * request, decrement the join-request badge, prune local state) run
 * unconditionally except for the `inviteByNpub` result itself — no code path
 * here reads `getInviteLink`/`isExpired` as a precondition. Design Decision 6
 * / AC-USAGE-1: `incrementInviteLinkUsage(request.nonce)` is called strictly
 * after `inviteByNpub` resolves `{ok: true}`, never on `{ok: false}`.
 * `incrementInviteLinkUsage` is S1's silent no-op when the nonce no longer
 * resolves (AC-USAGE-3) — it is passed the nonce and otherwise trusted, not
 * re-guarded here.
 *
 * Gate-remediation fix (Finding 1, epic invite-link-lifecycle): Design
 * Decision 6 also requires the usage-count write to "never throw or block
 * the approval." A prior revision awaited `incrementInviteLinkUsage` BEFORE
 * deleting the pending request; if the IndexedDB write threw (quota,
 * transient failure), the request was never cleaned up despite the invitee
 * already having been invited by `inviteByNpub` — a double-invite hazard on
 * retry. Approval-completion cleanup now runs unconditionally once
 * `inviteByNpub` succeeds, and the usage-count increment is best-effort
 * (wrapped so a rejection is swallowed, never surfaced as an approval
 * failure and never able to skip cleanup).
 */
export async function approveJoinRequestImpl(
  deps: {
    inviteByNpub: (groupId: string, npub: string) => Promise<{ ok: boolean; error?: string }>;
    pubkeyToNpub: (pubkeyHex: string) => string;
    deletePendingJoinRequest: (eventId: string) => Promise<void>;
    incrementInviteLinkUsage: (nonce: string) => Promise<void>;
    decrementJoinRequest: (groupId: string) => void;
    filterPendingRequest: (groupId: string, eventId: string) => void;
    /**
     * Persists a MemberProfile into the group's local store using LWW-by-
     * updatedAt (the same merge the inbound profile-rumor path uses). Injected
     * so the seeding below is unit-testable without IndexedDB.
     */
    mergeMemberProfile: (
      groupId: string,
      profile: import('@/src/types').MemberProfile,
    ) => Promise<boolean>;
    /** Bumps the profile version so an open group detail view re-reads member profiles. */
    bumpProfileVersion: () => void;
  },
  request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest,
): Promise<{ ok: boolean; error?: string }> {
  const npub = deps.pubkeyToNpub(request.pubkeyHex);
  const result = await deps.inviteByNpub(request.groupId, npub);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  // Approved — remove the request from IDB and update local state FIRST, so
  // that cleanup always completes even if the best-effort usage-count write
  // below fails. The invitee has already been invited at this point; leaving
  // the pending request behind would make it re-approvable (double invite).
  await deps.deletePendingJoinRequest(request.eventId);
  deps.decrementJoinRequest(request.groupId);
  deps.filterPendingRequest(request.groupId, request.eventId);

  // Seed the requester's self-provided name (carried in the join request and
  // shown in the approval prompt) into this group's member-profile store, so
  // the new member row shows the name immediately instead of a raw npub —
  // mirroring how accepting a contact card shows the name first, avatar later.
  // The entry is PROVISIONAL (see MemberProfile.provisional): stamped epoch-0
  // so the member's real signed profile always wins LWW and the member is still
  // requested as stale, and it does NOT mark the member as "confirmed" (the
  // Pending badge stays until their real profile arrives). Best-effort: a seed
  // failure must never fail an approval whose invite already succeeded. No
  // avatar is carried in a join request, so the avatar still arrives later over
  // the encrypted group profile channel.
  if (request.nickname) {
    try {
      await deps.mergeMemberProfile(request.groupId, {
        pubkeyHex: request.pubkeyHex,
        nickname: request.nickname,
        avatar: null,
        updatedAt: new Date(0).toISOString(),
        provisional: true,
      });
      deps.bumpProfileVersion();
    } catch (err) {
      console.warn('[Marmot] seeding provisional member profile after approval failed (non-blocking):', err);
    }
  }
  // Count this as a usage of the invite link that referenced this request
  // (no-op if the link was since deleted/expired). Best-effort: a rejection
  // here (IndexedDB write/quota/transient failure) must never surface as an
  // approval failure — cleanup above has already run, so a failed increment
  // only means an undercounted `usageCount`, never a stuck/duplicate request.
  //
  // Gate-remediation fix (Finding 2, epic invite-link-lifecycle): fire-and-
  // forget instead of `await`ed. The increment is documented best-effort and
  // must not block the approval return — a slow or hanging IndexedDB write
  // must not delay the approval UI once the invite + cleanup have already
  // completed. The call is still initiated synchronously (before this
  // function returns), so a test asserting it was *called* is unaffected;
  // a test that then synchronously asserts the persisted `usageCount` must
  // flush the microtask queue first.
  void (async () => {
    try {
      await deps.incrementInviteLinkUsage(request.nonce);
    } catch (err) {
      console.warn('[Marmot] incrementInviteLinkUsage failed after approval (non-blocking):', err);
    }
  })();
  return { ok: true };
}

export function MarmotProvider({ children }: { children: React.ReactNode }) {
  const { privateKeyHex, pubkeyHex, hydrated: identityHydrated, signerMode } = useNostrIdentity();
  const { profile: localProfile } = useProfile();
  const { markDirty: markBackupDirty } = useBackup();
  const copy = useCopy();
  const [ready, setReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);

  // whenReady(): a promise resolved the first time `ready` flips true, so
  // consumers can await readiness instead of polling. Created exactly once (the
  // null guard prevents the useRef initializer from overwriting the captured
  // resolver on every render).
  const readyGateRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (readyGateRef.current === null) {
    let resolveReady!: () => void;
    const promise = new Promise<void>((r) => { resolveReady = r; });
    readyGateRef.current = { promise, resolve: resolveReady };
  }
  const whenReady = useCallback(() => readyGateRef.current!.promise, []);
  useEffect(() => {
    if (ready) readyGateRef.current?.resolve();
  }, [ready]);
  const clientRef = useRef<MarmotClientType | null>(null);
  // Track welcome subscription cleanup so it can be stopped on remount/identity change
  const welcomeSubRef = useRef<(() => void) | null>(null);
  // Track group message subscription cleanup functions keyed by groupId
  const groupSubsRef = useRef<Map<string, () => void>>(new Map());
  // S4: Pending out-of-band leave entries queued for debounced auto-commit (AC-QUEUE-1).
  // MUST be useRef — mutations must not trigger re-renders.
  const pendingRemovalsRef = useRef<Map<string, PendingRemoval[]>>(new Map());
  // S4: Per-group 5-second debounce timers for the pending-removal queue (AC-QUEUE-1).
  // MUST be useRef — timer handles must not trigger re-renders.
  const debounceTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track groups where profile has been published (to avoid re-publishing)
  const profilePublishedRef = useRef<Set<string>>(new Set());
  // Ref for the app-start stale-profile sweep guard (runs once after ready+groups+pubkeyHex)
  const appStartSweepRanRef = useRef(false);
  // Ref for localProfile to avoid stale closures in subscription callbacks
  const localProfileRef = useRef(localProfile);
  // Ref for groups to avoid stale closures in welcome subscription callbacks
  const groupsRef = useRef(groups);
  // Ref for the EventSigner so post-init call sites (createGroup, inviteByNpub,
  // publishProfileUpdate, onHistorySynced) can sign profile-rumor envelopes.
  // Populated inside init(), nulled on cleanup.
  const signerRef = useRef<import('applesauce-core').EventSigner | null>(null);
  // Bumped on every incoming profile message so UI can re-read from IDB
  const [profileVersion, setProfileVersion] = useState(0);
  // Bumped on every incoming chat message so ChatStoreContext can re-read from IDB
  const [chatVersion, setChatVersion] = useState(0);
  // Bumped when group metadata (e.g. adminPubkeys) may have changed via MLS commit
  const [groupDataVersion, setGroupDataVersion] = useState(0);
  // Pending join requests per group (loaded on demand from IDB)
  const [pendingRequests, setPendingRequests] = useState<Record<string, import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest[]>>({});
  // Bumped on every incoming poll message so PollStoreContext can re-read from IDB
  const [pollVersion, setPollVersion] = useState(0);
  // Bumped on every successfully applied inbound kind-7 reaction (S4, AC-38)
  const [reactionsVersion, setReactionsVersion] = useState(0);
  // Bumped whenever lp_knownPeers_v1 is written outside the group-seeding
  // effects (currently: manual add-contact-by-npub) — see notifyKnownPeersChanged.
  const [knownPeersRevision, setKnownPeersRevision] = useState(0);
  // Bumped whenever a contact's archivedAt (block/unblock) is written — see
  // notifyBlockedPeersChanged (epic: block-contact, S1). Deliberately a
  // separate counter from knownPeersRevision (see the field's JSDoc above).
  const [blockedPeersRevision, setBlockedPeersRevision] = useState(0);
  // Bumped whenever an arriving event changes a contact's list membership or
  // displayed profile (nickname/avatar) — see notifyContactsChanged (epic:
  // contacts-live-updates). Separate counter from blockedPeersRevision /
  // knownPeersRevision per those fields' documented convention.
  const [contactsRevision, setContactsRevision] = useState(0);
  // Track discoverability status
  const [discoverable, setDiscoverable] = useState(false);

  // Keep localProfileRef in sync so subscription callbacks always use the latest profile
  useEffect(() => {
    localProfileRef.current = localProfile;
  }, [localProfile]);

  // Keep groupsRef in sync so welcome subscription callbacks see current membership
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  /**
   * S4 (AC-QUEUE-2): Enqueue a pending-removal entry and arm/reset the per-group
   * 5-second debounce timer. The real closure is injected into buildDispatcher via
   * deps.enqueueLeave, replacing the MOCK-S2-001 stub from S2.
   *
   * Arms-or-extends semantics: if a timer already exists for the group it is cleared
   * before the new one is set, so rapid-fire leave events extend the window.
   *
   * S5: timer-fire handler replaces this no-op with auto-commit.
   */
  const enqueueLeave = useCallback((groupId: string, pubkey: string) => {
    // Append to the pending queue (create the array if absent).
    const existing = pendingRemovalsRef.current.get(groupId) ?? [];
    existing.push({ groupId, pubkey, receivedAt: Date.now() });
    pendingRemovalsRef.current.set(groupId, existing);

    // Arm or extend the debounce timer for this group.
    const prior = debounceTimersRef.current.get(groupId);
    if (prior !== undefined) {
      clearTimeout(prior);
    }
    const timer = setTimeout(() => {
      // S5: Delete the timer ref first so a subsequent enqueueLeave can arm a fresh timer
      // without trying to clear a stale handle (AC-COMMIT-1 preamble).
      debounceTimersRef.current.delete(groupId);

      // Snapshot the pending entries at fire time before any async work.
      const pendingQueue = pendingRemovalsRef.current.get(groupId) ?? [];
      if (pendingQueue.length === 0) return;

      // Fire-and-forget async IIFE: the timer callback cannot be async itself,
      // but we need await for the dynamic import and commit. Any unhandled
      // rejection is caught by the outer try/catch inside fireAutoCommit.
      void (async () => {
        // AC-COMMIT-1: re-fetch live mlsGroup at fire time (not a stale closure).
        const mlsGroup = await (async () => {
          try {
            return (await clientRef.current?.groups.get(groupId)) ?? null;
          } catch {
            return null;
          }
        })();
        if (!mlsGroup) {
          // Group no longer accessible — leave queue entries in place for next cycle.
          return;
        }

        try {
          const { getPubkeyLeafNodeIndexes, Proposals } = await import(
            '@internet-privacy/marmot-ts'
          );
          await fireAutoCommit({
            mlsGroup,
            getPubkeyLeafNodeIndexes,
            proposeUpdateMetadata: Proposals.proposeUpdateMetadata,
            pendingQueue,
            onCommitted: (committedPubkeys) => {
              const current = pendingRemovalsRef.current.get(groupId) ?? [];
              const filtered = current.filter((e) => !committedPubkeys.includes(e.pubkey));
              if (filtered.length === 0) {
                pendingRemovalsRef.current.delete(groupId);
              } else {
                pendingRemovalsRef.current.set(groupId, filtered);
              }
            },
          });
        } catch (err) {
          console.warn('[Marmot] auto-commit timer-fire failed (outer catch):', err);
          // AC-COMMIT-7: entries remain in queue for next timer cycle.
        }
      })();
    }, 5000);
    debounceTimersRef.current.set(groupId, timer);
  }, []); // Refs are stable — no reactive dependencies needed.

  // Dev-only: expose parseProfilePayload so E2E tests can verify forged-sig rejection (AC-045 scenario 6)
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
      void import('@/src/lib/marmot/profileSync').then(({ parseProfilePayload }) => {
        const hooks = ((window as unknown as Record<string, unknown>).__fewTest ??= {}) as Record<string, unknown>;
        hooks.parseProfilePayload = parseProfilePayload;
      });
    }
  }, []);

  // AC-023: App-start sweep — runs sweepStaleProfiles exactly once after
  // ready, groups, and pubkeyHex are all set. The ref guard prevents re-runs
  // if React re-renders when any of those dependencies change independently.
  useEffect(() => {
    if (!ready || groups.length === 0 || !pubkeyHex) return;
    if (appStartSweepRanRef.current) return;
    appStartSweepRanRef.current = true;

    void (async () => {
      try {
        const now = Date.now();
        const groupIds = groups.map((g) => g.id);

        await sweepStaleProfiles({
          groupIds,
          selfPubkeyHex: pubkeyHex,
          now,
          getGroupMembers: async (groupId) => {
            const client = clientRef.current;
            if (!client) return [];
            const mlsGroup = await client.groups.get(groupId).catch(() => null);
            if (!mlsGroup) return [];
            const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
            return getGroupMembers(mlsGroup.state);
          },
          loadProfile: async (groupId, targetPubkey) => {
            const profiles = await loadMemberProfiles(groupId);
            return profiles.find((p) => p.pubkeyHex === targetPubkey);
          },
          loadMemo: loadProfileRequestMemo,
          recordEmitted: recordRequestEmitted,
          sendRumor: async (groupId, content) => {
            const client = clientRef.current;
            if (!client || !pubkeyHex) return;
            const g = await client.groups.get(groupId).catch(() => null);
            if (!g) return;
            const rumor = buildRumor(PROFILE_REQUEST_KIND, content, pubkeyHex);
            await sendRumorSafe(g, rumor as any, { softFail: true });
            if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
              ((window as unknown as Record<string, unknown>).__fewTest as { onRumorSent?: (kind: number) => void } | undefined)
                ?.onRumorSent?.(PROFILE_REQUEST_KIND);
            }
          },
        });
      } catch (err) {
        console.warn('[Marmot] app-start sweepStaleProfiles failed:', err);
      }
    })();
  }, [ready, groups.length, pubkeyHex]);

  // S3 (AC-PURGE-1, AC-PURGE-2): Retroactive purge sweep.
  // Runs once after boot hydration completes (ready becomes true), and re-runs
  // on every group-membership change (groups / groupDataVersion deps).
  // Guard: skip until hydration is complete (ready is the hydration flag).
  // When groups.length === 0 AND ready === true, the user has no groups and all
  // DM peers are strangers — the purge MUST run to clean up stale threads/contacts.
  // Trigger is reactive (useEffect dependency), NOT a polling timer (AC-PURGE-2,
  // VQ-S3-011).
  //
  // ORDERING: AC-EVER-4 maintenance runs FIRST (below), purge runs SECOND (this
  // effect). On every membership change, knownPeers is seeded from current groups
  // before the purge consults it, so ever-known ex-members are never misclassified
  // as strangers even when knownPeers is cold (e.g. first boot of the S3 migration).

  // Feedback-channel S3: Seed maintainer pubkeys into knownPeers on mount so
  // the walled-garden purge never removes the maintainer as a stranger, even
  // before the user has exchanged any messages with them.
  // Runs once on mount (empty dep array) — maintainer list is a static module constant.
  useEffect(() => {
    if (MAINTAINER_PUBKEYS_HEX.length > 0) {
      rememberKnownPeers(MAINTAINER_PUBKEYS_HEX);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AC-MIGRATE-1: One-time migration backfill effect (S3).
  // Runs after boot hydration. If the migration flag is absent, seeds knownPeers
  // from all current group members (AC-MIGRATE-2) and immediately runs the purge
  // sweep with the freshly seeded set (AC-MIGRATE-3) before the normal purge fires.
  // The flag is written ONLY after a successful purge (AC-MIGRATE-4) so that a
  // mid-run tab-close causes a full retry on the next boot (idempotent).
  //
  // ORDERING: declared BEFORE the AC-EVER-4 maintenance effect and the normal purge
  // sweep effect so that on first boot the migration seed runs first, preventing
  // ever-known peers from being misclassified as strangers.
  useEffect(() => {
    if (!ready) return;
    if (!pubkeyHex) return;
    if (knownPeersMigrationComplete()) return; // AC-MIGRATE-1: already migrated

    // AC-MIGRATE-2: seed from current group members, excluding own pubkey.
    const ownLower = pubkeyHex.toLowerCase();
    const allMemberPubkeys: string[] = [];
    for (const group of groupsRef.current) {
      for (const member of group.memberPubkeys) {
        if (member.toLowerCase() === ownLower) continue;
        allMemberPubkeys.push(member);
      }
    }
    rememberKnownPeers(allMemberPubkeys);

    // AC-MIGRATE-3: run the purge sweep with the freshly seeded knownPeers.
    // getWhitelist reads loadKnownPeers() synchronously so it picks up the
    // just-seeded set written above.
    const getWhitelist = () => ({
      groups: groupsRef.current,
      knownPeers: loadKnownPeers(),
      ownPubkeyHex: pubkeyHex,
    });

    void (async () => {
      try {
        purgeStrangerDmCounters(getWhitelist);
        const contactsResult = purgeStrangerContacts(getWhitelist);
        const [threadsResult] = await Promise.all([
          purgeStrangerDmThreads(getWhitelist),
          purgeStrangerDmReactions(getWhitelist),
        ]);
        // AC-MIGRATE-4: mark migration complete AFTER successful purge.
        // If the async block throws before reaching this line, the flag is NOT
        // set and the next boot retries the full migration from scratch.
        markKnownPeersMigrationComplete();
        console.info('[Marmot] dm:walled-garden-migration-complete', {
          peersSeeded: allMemberPubkeys.length,
          contactsDeleted: contactsResult.deleted,
          threadsDeleted: threadsResult.deleted,
        });
      } catch (err) {
        // Don't set flag — next boot retries (AC-MIGRATE-4: idempotent).
        console.warn('[Marmot] migration purge failed, will retry on next boot', err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, groups.length, pubkeyHex]);

  // AC-EVER-4: Maintain the ever-known peers set.
  // Runs after boot hydration and on every group-membership change. Collects all
  // memberPubkeys across current groups, filters out own pubkey, and persists them
  // to lp_knownPeers_v1 so that ex-members remain reachable after they leave.
  // AC-EVER-5: rememberKnownPeers never removes entries — only adds.
  useEffect(() => {
    if (!ready) return;
    // AC-EVER-2: own pubkey must be known to filter it out. If pubkeyHex is not
    // resolved yet, skip — the effect re-fires when pubkeyHex becomes available.
    if (!pubkeyHex) return;
    const ownLower = pubkeyHex.toLowerCase();
    const allMemberPubkeys: string[] = [];
    for (const group of groupsRef.current) {
      for (const memberPubkey of group.memberPubkeys) {
        if (memberPubkey.toLowerCase() === ownLower) continue;
        allMemberPubkeys.push(memberPubkey);
      }
    }
    rememberKnownPeers(allMemberPubkeys);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, groups, pubkeyHex]);

  useEffect(() => {
    if (!ready) return;

    // Use groupsRef.current (not the stale closure var `groups`) so the whitelist
    // always reflects the current membership even when groups.length hasn't changed.
    // loadKnownPeers() is synchronous — reads localStorage at call time so the
    // purge always works with the latest ever-known set (seeded above by AC-EVER-4).
    const getWhitelist = () => ({
      groups: groupsRef.current,
      knownPeers: loadKnownPeers(),
      ownPubkeyHex: pubkeyHex,
    });

    void (async () => {
      try {
        // Synchronous purges first (counters + contacts) — no IDB needed.
        purgeStrangerDmCounters(getWhitelist);
        purgeStrangerContacts(getWhitelist);
        // Async IDB purges in parallel for speed.
        await Promise.all([
          purgeStrangerDmThreads(getWhitelist),
          purgeStrangerDmReactions(getWhitelist),
        ]);
      } catch (err) {
        console.warn('[Marmot] retroactive purge sweep failed:', err);
      }
    })();
  // Use groups.length (not the full array) to avoid firing on every setGroups()
  // reference change. The whitelist is group-membership-scoped: purge re-runs
  // when the member count changes (member joined / group created / group left).
  //
  // groupDataVersion is intentionally EXCLUDED: it bumps on every MLS protocol
  // event (including application messages), causing many concurrent idb-keyval
  // `keys()` readonly transactions that serialise against the appendMessage `set`
  // (readwrite) and can delay group chat message persistence by 500ms+, breaking
  // the cancel-invite announcement. The purge only needs membership-count
  // awareness, which groups.length already provides.
  //
  // The stale-closure problem (groups.length unchanged but memberPubkeys changed)
  // is avoided by reading groupsRef.current inside the effect body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, groups.length, pubkeyHex]);

  // Load groups from storage on mount
  const reloadGroups = useCallback(async () => {
    const loaded = await loadAllGroups();
    setGroups(loaded);
  }, []);

  // Check and update discoverability status based on available key packages
  const updateDiscoverability = useCallback(async (client: MarmotClientType) => {
    try {
      const packages = await client.keyPackages.list();
      const hasDiscoverable = packages.some(
        (p) => !p.used && p.published && p.published.length > 0
      );
      setDiscoverable(hasDiscoverable);
    } catch (err) {
      console.debug('[Marmot] updateDiscoverability failed:', err);
    }
  }, []);

  // Initialize MarmotClient once identity is ready.
  // Also re-runs when signerMode changes so that switching to/from NIP-46
  // reconstructs the MarmotClient with the correct EventSigner (AC-SIGNER-10).
  useEffect(() => {
    // In nip46 mode, privateKeyHex is still present (we keep the local key
    // in memory), so we gate on pubkeyHex rather than privateKeyHex here.
    if (!identityHydrated || !pubkeyHex) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;

    async function init() {
      try {
        // ts-mls / @hpke require crypto.subtle which is only available in
        // secure contexts (HTTPS or localhost). Bail early with a clear
        // message instead of letting the library throw a raw TypeError.
        if (!globalThis.isSecureContext) {
          console.warn(
            '[Marmot] Not a secure context (HTTPS required). ' +
            'Groups are unavailable. Skipping MLS init.',
          );
          setUnsupported(true);
          setReady(true);
          return;
        }

        const { MarmotClient, GroupMediaStore } =
          await import('@internet-privacy/marmot-ts');
        const { connectNdk } = await import('@/src/lib/ndkClient');
        const { NdkNetworkAdapter } = await import('@/src/lib/marmot/NdkNetworkAdapter');
        const { createPrivateKeySigner, activeEventSignerOverride } = await import('@/src/lib/marmot/signerAdapter');
        const { publishKeyPackages } = await import('@/src/lib/keyPackages');
        const { createStore: idbCreateStore } = await import('idb-keyval');
        const { IdbKeyValueStoreBackend } = await import('@/src/lib/marmot/idbKeyValueStoreBackend');

        // In NIP-46 mode we may not have a private key to sign with locally.
        // Use the global EventSigner override if set, otherwise fall back to
        // the local private key signer (AC-SIGNER-10).
        const ndk = await connectNdk(privateKeyHex ?? '');
        const signer = activeEventSignerOverride.current ?? createPrivateKeySigner(privateKeyHex!);
        signerRef.current = signer;

        const groupStateStore = new IdbGroupStateBackend();
        const keyPackageStore = new IdbKeyPackageBackend();
        const network = new NdkNetworkAdapter(ndk);

        const mediaBlobStore = idbCreateStore('few-media-blobs', 'blobs');
        const mediaFactory = () => new GroupMediaStore(new IdbKeyValueStoreBackend(mediaBlobStore));

        const client = new MarmotClient({
          signer,
          // marmot-ts 0.5.x: backends are passed directly (KeyValueGroupStateBackend
          // and KeyPackageStore wrappers were removed/inlined).
          groupStateStore,
          keyPackageStore,
          network,
          mediaFactory,
          // Default `d` slot for kind 30443 key package events. All key packages
          // from this client share a single addressable slot so relays replace
          // the previous one on rotation.
          clientId: 'few',
        });

        if (cancelled) return;
        clientRef.current = client;

        // Load existing groups from MLS state store
        try {
          await client.groups.loadAll();
        } catch (err) {
          console.warn('[Marmot] groups.loadAll failed:', err);
        }

        // Publish KeyPackages if none exist
        try {
          const count = await client.keyPackages.count();
          if (count === 0) {
            await publishKeyPackages(client.keyPackages, 5, getEffectiveRelays());
          }
        } catch (err) {
          console.warn('[Marmot] KeyPackage publish failed:', err);
        }

        // Load group metadata from our overlay store
        await reloadGroups();

        // Start Welcome subscription (listen for incoming invitations)
        // Stop any previous welcome subscription before starting a new one
        welcomeSubRef.current?.();
        welcomeSubRef.current = null;
        // S6 (decline-a): resolve the marmot-ts primitives the declineDeps
        // object below needs, mirroring cancelPendingInvitation's own
        // dynamic-import-at-the-boundary convention.
        const { getGroupMembers, getPubkeyLeafNodeIndexes, Proposals } =
          await import('@internet-privacy/marmot-ts');
        startWelcomeSubscription(
          pubkeyHex!,
          client,
          ndk,
          signer,
          (joinedGroup) => {
            // A new group was joined from a Welcome — reload groups.
            // NOTE: profile update is NOT done here because sendApplicationRumor
            // advances the MLS key schedule, which would make pending historical
            // commits (e.g. "add member C") undecryptable. Profile updates are
            // deferred to subscribeToGroupMessages's onHistorySynced callback.
            void reloadGroups();
            markBackupDirty(true);
            console.info('[Marmot] Joined group from Welcome:', joinedGroup.name);
          },
          (request) => {
            // A join request was received and persisted — increment the bell
            // counter AND update the live pendingRequests state so an
            // already-open group member list re-renders its inline join-request
            // rows without a navigate/reload. Both orderings converge with the mount-only
            // IDB read in loadPendingRequestsForGroup: if that effect runs
            // after this, it replaces from IDB (which already contains the
            // persisted request — no loss); if this runs after mount, the
            // append below shows it live. Dedup by eventId keeps either
            // ordering idempotent.
            // notification-domain-invariants (INV-2): if the admin has THIS
            // group's detail open, the join request appears live in the member
            // list's inline join-request rows — so it must NOT also ring the
            // bell. Any other view rings it (INV-1). The live setPendingRequests
            // append runs unconditionally either way.
            if (!isActiveView('group', request.groupId)) {
              incrementJoinRequest(request.groupId);
            }
            setPendingRequests((prev) => {
              const current = prev[request.groupId] ?? [];
              if (current.some((r) => r.eventId === request.eventId)) return prev;
              return { ...prev, [request.groupId]: [...current, request] };
            });
            console.info('[Marmot] Join request received from:', request.pubkeyHex, 'for group:', request.groupId);
          },
          (groupId) => {
            // Look up current group member pubkeys for dedup/membership check.
            // Uses groupsRef to always read the latest groups state.
            const group = groupsRef.current.find((g) => g.id === groupId);
            return group?.memberPubkeys ?? [];
          },
          privateKeyHex ?? undefined,
          (result) => {
            console.info('[Marmot] Pairing-ack admitted from:', result.senderPubkeyHex);
            // Issuer-side admission wrote the new peer to knownPeers (inside
            // handlePairingAck). Bump knownPeersRevision so the always-mounted
            // walled-garden watchers (DirectMessageNotificationsWatcher,
            // IncomingCallWatcher, ContactChat) — which cache loadKnownPeers()
            // in a ref refreshed only on [groups, knownPeersRevision] — pick up
            // the freshly-paired peer immediately, WITHOUT a reload. Mirrors
            // add.tsx's notifyKnownPeersChanged() on the scanner-side add.
            // setKnownPeersRevision is a stable setter, safe to call from this
            // long-lived subscription callback (no stale closure). Without this,
            // the paired peer's first DMs/calls are silently dropped by the
            // stale walled-garden cache for the rest of the session.
            setKnownPeersRevision((n) => n + 1);
            // Issuer-side admission also wrote a new pending contact to
            // lp_contacts_v1 (rememberPendingContact, inside handlePairingAck).
            // Bump contactsRevision so the always-mounted contacts list shows
            // the new pending row immediately, without a reload (epic:
            // contacts-live-updates). The bell is already rung separately at
            // welcomeSubscription.ts's dispatch site (incrementPendingContact).
            setContactsRevision((n) => n + 1);
          },
          // S6 (decline-a): the Remove/announce capability the receive-side
          // decline branch needs. Mirrors cancelPendingInvitation's own
          // dep-building (same underlying Deps shape, imported dynamically at
          // the boundary per this file's convention) plus the two extras that
          // machinery doesn't own: posting into an ARBITRARY group by id (this
          // is a background listener, not scoped to one open group's UI — the
          // sendAnnouncement below mirrors the accepted-producer dispatcher's
          // build+local-echo+sendRumorSafe shape near line ~1496), and the
          // marker-clear (pendingDirectInviteStorage.ts, consumed here only
          // via injection per architecture.md's boundary rule).
          {
            // clientRef.current (NOT the local `client` const above, whose
            // type carries this init() call's inferred mediaFactory generics)
            // — mirrors every other Deps-building callback in this file
            // (cancelPendingInvitation, isPendingMember, etc.), all of which
            // read clientRef.current specifically so `.groups.get()` returns
            // the generic-erased MarmotGroupType sendRumorSafe expects.
            getGroup: (id: string) => clientRef.current?.groups.get(id).catch(() => null) ?? Promise.resolve(null),
            loadMemberProfiles,
            getGroupMembers,
            getPubkeyLeafNodeIndexes,
            Proposals,
            persistGroup,
            // groupsRef.current (not the closure `groups`, which is captured
            // once at this init() run and would go stale) — same rationale as
            // every other long-lived callback installed inside this effect.
            getStoredGroup: (id: string) => groupsRef.current.find((g) => g.id === id),
            reloadGroups,
            markBackupDirty,
            selfPubkeyHex: pubkeyHex ?? '',
            sendAnnouncement: async (groupId: string, content: string) => {
              const groupClient = clientRef.current;
              if (!groupClient) return;
              const mlsGroupForAnnouncement = await groupClient.groups.get(groupId).catch(() => null);
              if (!mlsGroupForAnnouncement) return;
              const rumor = buildRumor(CHAT_MESSAGE_KIND, content, pubkeyHex ?? '');
              await appendMessage(groupId, {
                id: rumor.id,
                content,
                senderPubkey: pubkeyHex ?? '',
                groupId,
                createdAt: rumor.created_at * 1000,
              }).catch((err: unknown) => {
                console.warn(`[Marmot] decline-producer local echo appendMessage failed for ${groupId}:`, err);
              });
              setChatVersion((v) => v + 1);
              await sendRumorSafe(mlsGroupForAnnouncement, rumor as any, { softFail: true });
            },
            clearPendingDirectInvite,
          },
        ).then((unsub) => {
          if (cancelled) {
            unsub();
          } else {
            welcomeSubRef.current = unsub;
          }
        }).catch((err) => {
          console.warn('[Marmot] Welcome subscription failed:', err);
        });

        // Listen for group join events to rotate consumed key packages.
        // marmot-ts 0.5.x: events live on client.groups; 'groupJoined' → 'joined'.
        client.groups.on('joined', async () => {
          if (!cancelled) {
            try {
              const packages = await client.keyPackages.list();
              for (const pkg of packages.filter((p) => p.used)) {
                await client.keyPackages.rotate(pkg.keyPackageRef, { relays: getEffectiveRelays() });
              }
              // Re-evaluate discoverability after rotation
              await updateDiscoverability(client);
            } catch (err) {
              console.debug('[Marmot] Key package rotation failed:', err);
            }
          }
        });

        // --- Background: key package readiness, relay list publish & cleanup ---
        (async () => {
          try {
            const existingPackages = await client.keyPackages.list();
            const hasUsable = existingPackages.some(
              (p) => !p.used && p.published && p.published.length > 0,
            );

            const effectiveRelays = getEffectiveRelays();
            if (!hasUsable && effectiveRelays.length > 0) {
              await client.keyPackages.create({ relays: effectiveRelays });
            }

            // Delete stale key-package events from relays whose private keys
            // are no longer in local IndexedDB (e.g. after clearing browser
            // data). Covers both legacy kind 443 events and kind 30443
            // addressable events from previous sessions.
            if (effectiveRelays.length > 0 && ndk) {
              try {
                const remoteKPs = await network.request(effectiveRelays, [
                  { kinds: [443 as any, 30443 as any], authors: [pubkeyHex!] } as any,
                ]);
                const localList = await client.keyPackages.list();
                const localPublishedIds = new Set(
                  localList.flatMap((kp) => (kp.published ?? []).map((e) => e.id)),
                );
                const staleEvents = remoteKPs.filter(
                  (e) => !localPublishedIds.has(e.id as string),
                );

                if (staleEvents.length > 0) {
                  const staleKinds = Array.from(new Set(staleEvents.map((e) => e.kind))).map(String);
                  console.debug('[Marmot] deleting', staleEvents.length, 'stale KP events from relays (kinds:', staleKinds.join(','), ')');
                  const deleteEvent = {
                    kind: 5,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                      ...staleEvents.map((e) => ['e', e.id as string]),
                      ...staleKinds.map((k) => ['k', k]),
                    ],
                    content: '',
                    pubkey: pubkeyHex!,
                  };
                  const signed = await signer.signEvent(deleteEvent as any);
                  const { NDKEvent, NDKRelaySet } = await import('@nostr-dev-kit/ndk');
                  const ndkEvent = new NDKEvent(ndk, signed as any);
                  const relaySet = NDKRelaySet.fromRelayUrls(effectiveRelays, ndk);
                  await ndkEvent.publish(relaySet).catch(() => {});
                }
              } catch {
                // Non-fatal: stale KP cleanup is best-effort
              }
            }

            // Publish kind 30051 relay list for key package discovery (addressable with d tag)
            if (effectiveRelays.length > 0 && ndk) {
              try {
                const { NDKEvent, NDKRelaySet } = await import('@nostr-dev-kit/ndk');
                const existing30051 = await network.request(effectiveRelays, [
                  { kinds: [30051 as any], authors: [pubkeyHex!], limit: 1 } as any,
                ]);

                if (existing30051.length === 0) {
                  // Create kind 30051 event with d tag for addressable relay list
                  const unsigned = {
                    kind: 30051,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                      ['d', 'marmot'],
                      ...effectiveRelays.map((url) => ['relay', url]),
                    ],
                    content: '',
                    pubkey: pubkeyHex!,
                  };
                  const signed = await signer.signEvent(unsigned as any);
                  const ndkEvent = new NDKEvent(ndk, signed);
                  const relaySet = NDKRelaySet.fromRelayUrls(effectiveRelays, ndk);
                  await ndkEvent.publish(relaySet).catch(() => {
                    // Non-fatal: invite flow degrades gracefully
                  });
                }
              } catch {
                // Non-fatal: relay list publish is best-effort
              }
            }

            if (!cancelled) {
              // Re-evaluate after background work completes
              await updateDiscoverability(client);
            }
          } catch {
            // Non-fatal: discoverability degrades gracefully
          }
        })();

        setReady(true);
      } catch (err) {
        console.error('[Marmot] Initialization failed:', err);
        // Still mark ready so UI doesn't hang
        setReady(true);
      }
    }

    void init();
    return () => {
      cancelled = true;
      welcomeSubRef.current?.();
      welcomeSubRef.current = null;
      signerRef.current = null;
    };
  // signerMode triggers re-init so MarmotClient picks up the new EventSigner
  // (local → nip46 switch) after the identity context has set the override ref.
  }, [identityHydrated, privateKeyHex, pubkeyHex, signerMode, reloadGroups, updateDiscoverability]);

  // Stable key over the SET of group ids. The subscription effect below must
  // re-run only when a group is added or removed — NOT on every `groups`
  // array-reference churn. `reloadGroups()` calls `setGroups(freshIdbArray)`
  // (a new reference every time) and is invoked from `onMembersChanged`, which
  // EpochResolver fires after *every* ingested MLS event. Depending the effect
  // on the raw `groups` array therefore tore down and rebuilt every group's
  // kind-445 subscription — each a sequential, 8s-timeout historical refetch —
  // on every inbound message/reaction/poll/commit, stalling live propagation by
  // N×8s under load. Keying on the id set (mirroring the `groups.length`
  // dependency already used by the sweeps at the effects near lines 535/685)
  // keeps live subscriptions intact through routine activity; the set only
  // changes on a genuine join/leave. Group *data* changes (rename, membership)
  // are still delivered live over the existing subscription and re-read via
  // `groupsRef.current` in the callbacks below.
  const groupSubscriptionKey = groups.map((g) => g.id).sort().join(',');

  // Subscribe to group messages for each group (for incoming application rumors)
  useEffect(() => {
    if (!ready || groups.length === 0) return;
    const client = clientRef.current;
    if (!client || typeof window === 'undefined') return;

    const subsMap = groupSubsRef.current;

    async function subscribeNewGroups() {
      // Initialise unread counts from persisted messages on first run
      const gids = groups.map((g) => g.id);
      if (pubkeyHex) {
        void initUnreadCounts(gids, pubkeyHex);
      }
      void initJoinRequestCounts(gids);

      const { subscribeToGroupMessages } = await import('@/src/lib/marmot/welcomeSubscription');
      const { getNdk } = await import('@/src/lib/ndkClient');
      const ndk = getNdk();
      if (!ndk) return;

      for (const group of groups) {
        if (subsMap.has(group.id)) continue; // Already subscribed
        try {
          const mlsGroup = await client!.groups.get(group.id).catch(() => null);
          if (!mlsGroup) continue;

          // Immediately sync member list from MLS state (authoritative source).
          // The MLS ratchet tree tracks all members — even commits processed in
          // a previous session are reflected here. This ensures the overlay store
          // is up-to-date without needing to re-ingest historical events (which
          // is impossible after the MLS key schedule advances due to forward secrecy).
          const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
          const mlsMembers = getGroupMembers(mlsGroup.state);
          // groupsRef.current (kept in sync near line 398) rather than the
          // closure `groups`, for consistency with the onMembersChanged callback
          // below and to stay correct if this read ever moves off the subscribe path.
          const stored = groupsRef.current.find((g) => g.id === group.id);
          if (stored) {
            // Sync BOTH membership and the group name from authoritative MLS state.
            // The name may have changed while we were offline (an admin renamed the
            // group); the overlay is the only thing the UI renders, so pull it here.
            const mlsName = mlsGroup.groupData?.name;
            const nameChanged =
              typeof mlsName === 'string' && mlsName.length > 0 && mlsName !== stored.name;
            const memberChange = membersChanged(stored.memberPubkeys, mlsMembers);
            if (nameChanged || memberChange) {
              await persistGroup({
                ...stored,
                ...(memberChange ? { memberPubkeys: mlsMembers } : {}),
                ...(nameChanged ? { name: mlsName } : {}),
              });
              await reloadGroups();
            }
          }

          const unsub = await subscribeToGroupMessages(
            group.id,
            group.relays,
            mlsGroup,
            ndk,
            // Refresh memberPubkeys from MLS state after ingesting any event
            // (commits, proposals, etc. — not just application messages)
            async (currentMembers) => {
              // Always bump groupDataVersion so consumers (e.g. isAdmin) re-read
              // group metadata after any MLS commit, even when member count is unchanged.
              setGroupDataVersion((v) => v + 1);
              // Read via groupsRef (always current) rather than the effect's
              // closure `groups`: this callback outlives its effect run, and the
              // effect now re-runs only on id-set changes, so the closure would
              // otherwise go stale across renames/membership updates.
              const stored = groupsRef.current.find((g) => g.id === group.id);
              if (stored) {
                // Resync membership AND the group name from authoritative MLS
                // metadata after any processed commit. A rename lands here for
                // remote members: proposeUpdateMetadata({ name }) is silent on the
                // timeline, so this is the path that makes a rename visible to
                // everyone (the separate kind-9 notice is display-only).
                const mlsName = mlsGroup.groupData?.name;
                const nameChanged =
                  typeof mlsName === 'string' && mlsName.length > 0 && mlsName !== stored.name;
                const memberChange = membersChanged(stored.memberPubkeys, currentMembers);
                if (nameChanged || memberChange) {
                  await persistGroup({
                    ...stored,
                    ...(memberChange ? { memberPubkeys: currentMembers } : {}),
                    ...(nameChanged ? { name: mlsName } : {}),
                  });
                  await reloadGroups();
                }
              }
              // WORKAROUND: auto-commit unapplied proposals (e.g. leave
              // proposals) so all members can send application messages.
              // Only works when the local user is admin. Fails silently
              // if admin promotion was lost — see sendRumorSafe comment.
              if (Object.keys(mlsGroup.unappliedProposals).length > 0) {
                void mlsGroup.commit().catch((err: unknown) => {
                  console.debug('[Marmot] auto-commit unapplied proposals failed:', err);
                });
              }
            },
            // Publish profile after historical sync completes (epoch is up-to-date).
            // Uses localProfileRef to avoid stale-closure race.
            () => {
              if (profilePublishedRef.current.has(group.id)) return;
              if (!signerRef.current) return;
              profilePublishedRef.current.add(group.id);
              const currentProfile = localProfileRef.current;
              const signer = signerRef.current;
              void (async () => {
                try {
                  const payload = await serialiseProfileUpdate(currentProfile, signer);
                  console.info(`[Marmot] onHistorySynced: publishing profile for group ${group.id}, nickname="${currentProfile.nickname}"`);
                  const rumor = buildRumor(PROFILE_RUMOR_KIND, payload, pubkeyHex ?? '');
                  await sendRumorSafe(mlsGroup, rumor as any, { softFail: true });
                  console.info(`[Marmot] onHistorySynced: profile published successfully for group ${group.id}`);
                } catch (err) {
                  console.warn(`[Marmot] onHistorySynced profile publish for ${group.id} failed:`, err);
                }
              })();
            },
          );

          // Wire the unified dispatcher for all application rumor handlers (Stories 02–03).
          const dispatcherCtx = {
            groupId: group.id,
            selfPubkeyHex: pubkeyHex ?? '',
            // notification-domain-invariants: wired to the active-view registry
            // so chatHandler can suppress the bell for the group on screen.
            getActiveGroupId,
          };
          const unsubDispatcher = buildDispatcher({
            // Chat
            appendMessage,
            incrementUnread,
            markAsRead,
            setChatVersion,
            // Reactions
            loadMessages,
            applyInboundRumor,
            setReactionsVersion,
            // Delete/edit (S5) — reuses setChatVersion (already passed above)
            // per architecture.md seam #3's explicit reuse allowance.
            applyDeleteEditSignal,
            resolvePendingSignalsForSlot,
            // Profile
            mergeMemberProfile,
            clearPendingDirectInvite,
            // epic: group-invite-lifecycle S3 gate-remediation (severity-4 finding,
            // AC-PROD-3/4/5) — accept-producer's own-join path's atomic
            // compare-and-clear. Real (non-optional) dynamic import, mirroring
            // getPendingDirectInvites' pattern elsewhere in this file, so the
            // accept-producer gate is never silently un-wired in production. Replaces
            // the former hasPendingDirectInvite/clearPendingDirectInvite pair on this
            // path — see pendingDirectInviteStorage.ts's consumePendingDirectInviteMarker
            // doc comment for why the get-then-clear pair was TOCTOU-unsafe.
            consumePendingDirectInviteMarker: async (groupId: string, pubkey: string) => {
              const { consumePendingDirectInviteMarker } = await import('@/src/lib/marmot/pendingDirectInviteStorage');
              return consumePendingDirectInviteMarker(groupId, pubkey.toLowerCase());
            },
            // epic: group-invite-lifecycle S3 (DD-9, AC-PROD-3) — publishes the
            // 'accepted' announcement into the group this dispatcher instance is
            // bound to, mirroring sendSelfProfile's build+sendRumorSafe shape below.
            //
            // S3 gate-remediation (severity-3 finding): unlike `invited` (sent via
            // ChatSendMessageCapture's ref onto ChatStoreContext's sendMessage, which
            // does an optimistic local echo — see ChatStoreContext.tsx's sendMessage),
            // this background-dispatcher send bypasses that echo. marmot-ts's
            // ingest() skips self-sent application messages entirely via its
            // internal #sentEventIds self-echo guard (see marmot-group.js — "Track
            // this event ID so ingest() can skip the self-echo"; mirrored on our side
            // by chatHandler.ts's own-send-guard comment), so this group's
            // applicationMessage bus NEVER redelivers an own-authored rumor back to
            // its sender — there is no later point at which A would otherwise see
            // their own `accepted` announcement. appendMessage+setChatVersion here
            // mirrors chatHandler.ts's inbound-append shape exactly, using the same
            // canonical rumor.id chatHandler would key on, so a same-account other
            // device that DOES receive the real relay copy dedupes onto this same id.
            sendAnnouncement: async (content: string) => {
              const rumor = buildRumor(CHAT_MESSAGE_KIND, content, pubkeyHex ?? '');
              await appendMessage(group.id, {
                id: rumor.id,
                content,
                senderPubkey: pubkeyHex ?? '',
                groupId: group.id,
                createdAt: rumor.created_at * 1000,
              }).catch((err: unknown) => {
                console.warn(`[Marmot] accepted-producer local echo appendMessage failed for ${group.id}:`, err);
              });
              setChatVersion((v) => v + 1);
              await sendRumorSafe(mlsGroup, rumor as any, { softFail: true });
            },
            notifyProfileObserved,
            recordRequestAnswered,
            writeContactEntry: (pubkey: string, entry: { nickname: string; avatar: import('@/src/types').ProfileAvatar | null; updatedAt: string }) => {
              void import('@/src/lib/contactCache').then(({ writeContactEntry }) => {
                writeContactEntry(pubkey, { nickname: entry.nickname, avatar: entry.avatar, updatedAt: entry.updatedAt });
              });
            },
            setProfileVersion,
            // Profile request
            recordRequestEmitted,
            // AC-030: self-target reply — sign our current profile and send immediately.
            sendSelfProfile: async (_groupId: string) => {
              if (!signerRef.current) return;
              const payload = await serialiseProfileUpdate(localProfileRef.current, signerRef.current);
              const rumor2 = buildRumor(PROFILE_RUMOR_KIND, payload, pubkeyHex ?? '');
              await sendRumorSafe(mlsGroup, rumor2 as any);
            },
            // AC-031: relay path — pre-bind loadProfile and sendRumor.
            handleIncomingProfileRequest: async (args: { groupId: string; payload: import('@/src/lib/marmot/profileRequestSync').ProfileRequestPayload }) => {
              await handleIncomingProfileRequest({
                groupId: args.groupId,
                payload: args.payload,
                selfPubkeyHex: pubkeyHex ?? '',
                now: Date.now(),
                loadProfile: async (gid, targetPubkey) => {
                  const profiles = await loadMemberProfiles(gid);
                  return profiles.find((p) => p.pubkeyHex === targetPubkey);
                },
                sendRumor: async (groupId, content) => {
                  const g = await clientRef.current?.groups.get(groupId).catch(() => null);
                  if (!g) return;
                  const r = buildRumor(PROFILE_RUMOR_KIND, content, pubkeyHex ?? '');
                  await sendRumorSafe(g, r as any);
                },
              });
            },
            // Polls
            savePoll,
            saveVote,
            getPoll,
            setPollVersion,
            // S4 (AC-QUEUE-4): real enqueueLeave closure — replaces MOCK-S2-001 stub from S2.
            enqueueLeave,
          }).subscribe(mlsGroup, dispatcherCtx);

          // Combine both unsubscribe functions so cleanup tears down both listeners.
          subsMap.set(group.id, () => {
            unsub();
            unsubDispatcher();
          });
        } catch (err) {
          console.warn(`[Marmot] subscribeToGroupMessages for ${group.id} failed:`, err);
        }
      }
    }

    void subscribeNewGroups();

    // Cleanup: unsubscribe ALL tracked group subscriptions on unmount or
    // dependency change. The next effect run will re-subscribe as needed.
    // Previously only groups that disappeared were cleaned up, leaving
    // duplicate subscriptions alive across re-renders.
    return () => {
      for (const [groupId, unsub] of Array.from(subsMap.entries())) {
        unsub();
        subsMap.delete(groupId);
        // S4 (AC-QUEUE-3): cancel the pending debounce timer for this group so it
        // cannot fire after the subscription has torn down. The pending-removals
        // queue itself is NOT cleared — entries are retained so that historical
        // sync on re-subscribe can repopulate the queue cleanly. See architecture.json
        // design_decisions.queue_retention_on_teardown for rationale.
        const timer = debounceTimersRef.current.get(groupId);
        if (timer !== undefined) {
          clearTimeout(timer);
          debounceTimersRef.current.delete(groupId);
        }
      }
      profilePublishedRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed
    // on the id SET (groupSubscriptionKey), not the `groups` array reference; see
    // the comment above groupSubscriptionKey for why re-running on every churn
    // regressed live propagation.
  }, [ready, groupSubscriptionKey, pubkeyHex]);

  // Profile updates are published automatically via the onHistorySynced callback
  // (once per group, after historical events are ingested and the local epoch is
  // up-to-date). They can also be published explicitly via publishProfileUpdate.

  const createGroup = useCallback(async (name: string): Promise<Group | null> => {
    const client = clientRef.current;
    if (!client || !pubkeyHex) return null;

    try {
      const createRelays = getEffectiveRelays();
      const mlsGroup = await client.groups.create(name, { relays: createRelays });
      const groupId = mlsGroup.idStr;

      const group: Group = {
        id: groupId,
        name,
        createdAt: Date.now(),
        memberPubkeys: [pubkeyHex],
        relays: createRelays,
      };

      await persistGroup(group);
      await reloadGroups();
      markBackupDirty(true);

      // Publish profile to the new group
      try {
        if (!signerRef.current) throw new Error('signer not initialised');
        const payload = await serialiseProfileUpdate(localProfile, signerRef.current);
        const rumor = buildRumor(PROFILE_RUMOR_KIND, payload, pubkeyHex);
        await sendRumorSafe(mlsGroup, rumor as any);
      } catch (err) {
        console.warn('[Marmot] publishProfileUpdate on createGroup failed:', err);
      }

      return group;
    } catch (err) {
      console.error('[Marmot] createGroup failed:', err);
      return null;
    }
  }, [pubkeyHex, reloadGroups, localProfile, markBackupDirty]);

  const inviteByNpub = useCallback(
    async (groupId: string, npub: string): Promise<{ ok: boolean; error?: string }> => {
      const client = clientRef.current;
      if (!client) return { ok: false, error: 'Not initialized' };

      try {
        const { normaliseNpubPayload } = await import('@/src/lib/qr');
        const { npubToPubkeyHex } = await import('@/src/lib/nostrKeys');
        const normalisedNpub = normaliseNpubPayload(npub);
        const inviteePubkey = normalisedNpub ? npubToPubkeyHex(normalisedNpub) : null;
        if (!inviteePubkey || !normalisedNpub) {
          return { ok: false, error: 'invalid_npub' };
        }

        // Fetch the invitee's KeyPackage from relays
        const { getNdk } = await import('@/src/lib/ndkClient');
        const ndk = getNdk();
        if (!ndk) return { ok: false, error: 'offline' };

        const { fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
        const { events: kpEvents, timedOut } = await fetchEventsWithTimeout(
          ndk,
          // marmot-ts 0.5.x peers publish kind 30443 (addressable). Older
          // peers may still have kind 443 events on relays — accept both.
          {
            kinds: [
              443 as import('@nostr-dev-kit/ndk').NDKKind,
              30443 as import('@nostr-dev-kit/ndk').NDKKind,
            ],
            authors: [inviteePubkey],
            limit: 5,
          },
        );

        const kpArray = Array.from(kpEvents);
        if (kpArray.length === 0) {
          return { ok: false, error: timedOut ? 'timeout' : 'no_key_package' };
        }

        const mlsGroup = await client.groups.get(groupId).catch(() => null);
        if (!mlsGroup) return { ok: false, error: 'group_not_found' };

        // Use the most recent KeyPackage event
        const kpEvent = kpArray.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
        const nostrEvent = {
          id: kpEvent.id ?? '',
          pubkey: kpEvent.pubkey ?? '',
          created_at: kpEvent.created_at ?? 0,
          kind: kpEvent.kind ?? 0,
          tags: kpEvent.tags ?? [],
          content: kpEvent.content ?? '',
          sig: kpEvent.sig ?? '',
        };

        const inviteResult = await mlsGroup.inviteByKeyPackageEvent(nostrEvent);

        // Refresh member list from MLS group state (authoritative source)
        const stored = groups.find((g) => g.id === groupId);
        if (stored) {
          const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
          const updated: Group = {
            ...stored,
            memberPubkeys: getGroupMembers(mlsGroup.state),
          };
          await persistGroup(updated);
          await reloadGroups();
        }

        // Ensure the inviter also re-sends its current profile immediately
        // after the invite commit lands. Relying only on onMembersChanged is
        // insufficient here because the local overlay can refresh member count
        // before the subscription callback observes the join, which prevents
        // the inviter from sending its "welcome" profile to the new member.
        try {
          if (!signerRef.current) throw new Error('signer not initialised');
          const payload = await serialiseProfileUpdate(localProfileRef.current, signerRef.current);
          const rumor = buildRumor(PROFILE_RUMOR_KIND, payload, pubkeyHex ?? '');
          await sendRumorSafe(mlsGroup, rumor as any);
        } catch (profileErr) {
          console.warn('[Marmot] inviter profile publish after invite failed:', profileErr);
        }

        markBackupDirty(true);
        return { ok: true };
      } catch (err) {
        console.error('[Marmot] inviteByNpub failed:', err);
        return { ok: false, error: 'generic' };
      }
    },
    [groups, reloadGroups, markBackupDirty, pubkeyHex]
  );

  // Out-of-band leave: emit kind-13 leave intent + kind-9 announcement before
  // purging local state. mlsGroup.leave() is never called — the departing
  // member never emits an MLS Remove proposal. The remaining admin observes the
  // kind-13 rumor and issues the Remove commit on behalf of the group.
  // See specs/epic-out-of-band-leave/spec.md.
  //
  // Thin wrapper: send-skip decision, sends, and purge live in leaveGroupImpl
  // (AC-BOUND-1). Mirrors the grantAdmin/renameGroup wiring — dynamic import +
  // object-literal deps, with sendRumorSafe/buildRumor (module-private here,
  // not marmot-ts exports) injected as Deps fields.
  const leaveGroup = useCallback(async (groupId: string): Promise<boolean> => {
    const selfPubkeyHex = pubkeyHex ?? '';
    const { leaveGroupImpl } = await import('@/src/lib/marmot/leaveGroupImpl');
    const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
    const { clearMessages } = await import('@/src/lib/marmot/chatPersistence');
    const { clearPendingJoinRequestsForGroup } = await import('@/src/lib/marmot/joinRequestStorage');
    const { clearInviteLinksForGroup } = await import('@/src/lib/marmot/inviteLinkStorage');
    const { clearPendingDirectInvitesForGroup } = await import('@/src/lib/marmot/pendingDirectInviteStorage');

    return leaveGroupImpl(
      {
        // Fetch live mlsGroup reference via clientRef so we don't rely on a
        // stale closure (the subscription for this group may have torn down
        // already).
        getGroup: (id) => clientRef.current?.groups.get(id).catch(() => null) ?? Promise.resolve(null),
        getGroupMembers,
        sendRumorSafe: (group, rumor) => sendRumorSafe(group as any, rumor as any),
        buildRumor,
        removeGroupFromStorage,
        clearMemberProfiles,
        clearMessages,
        clearPollData,
        clearGroupMedia,
        clearProfileRequestMemos,
        clearUnreadGroup,
        clearPendingJoinRequestsForGroup,
        clearInviteLinksForGroup,
        clearInviteExpiries,
        clearPendingDirectInvitesForGroup,
        reloadGroups,
        markBackupDirty,
      },
      groupId,
      selfPubkeyHex,
      // Leaver's own display name — embedded in the kind-9 announcement so it
      // renders "<name> left the group" for every recipient. Read from the ref
      // to avoid a stale closure.
      localProfileRef.current?.nickname,
    );
  }, [reloadGroups, markBackupDirty, pubkeyHex]);

  const getMemberProfiles = useCallback(async (groupId: string): Promise<MemberProfile[]> => {
    return loadMemberProfiles(groupId);
  }, []);

  const publishProfileUpdate = useCallback(async (profileOverride?: UserProfile): Promise<void> => {
    const client = clientRef.current;
    if (!client || groups.length === 0 || !pubkeyHex) return;
    if (!signerRef.current) return;

    const payload = await serialiseProfileUpdate(profileOverride ?? localProfile, signerRef.current);

    for (const group of groups) {
      try {
        const mlsGroup = await client.groups.get(group.id).catch(() => null);
        if (!mlsGroup) continue;

        const rumor = buildRumor(PROFILE_RUMOR_KIND, payload, pubkeyHex);
        await sendRumorSafe(mlsGroup, rumor as any);
      } catch (err) {
        console.warn(`[Marmot] publishProfileUpdate to group ${group.id} failed:`, err);
      }
    }
    console.info('[Marmot] publishProfileUpdate sent to', groups.length, 'group(s)');
  }, [groups, pubkeyHex, localProfile]);

  const clearAll = useCallback(async () => {
    await clearAllGroupData();
    setGroups([]);
    clientRef.current = null;
    profilePublishedRef.current.clear();
    appStartSweepRanRef.current = false;
  }, []);

  const getGroup = useCallback(async (groupId: string): Promise<MarmotGroupType | null> => {
    const client = clientRef.current;
    if (!client) return null;
    try {
      return await client.groups.get(groupId) ?? null;
    } catch {
      return null;
    }
  }, []);

  const getLiveMemberPubkeys = useCallback(async (groupId: string): Promise<string[] | undefined> => {
    const client = clientRef.current;
    if (!client) return undefined;
    try {
      const mlsGroup = await client.groups.get(groupId).catch(() => null);
      if (!mlsGroup) return undefined;
      const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
      return getGroupMembers(mlsGroup.state);
    } catch {
      return undefined;
    }
  }, []);

  // S8 (epic-group-invite-lifecycle, DD-11 composition-root wiring):
  // registers the live admin-lookup provider messageEdits/api.ts's
  // receive-side gate consults at apply time (`groupAdminsFor`), for EVERY
  // groupId, not just the currently-open one — mirrors `getGroup`'s own
  // `client.groups.get(groupId)` shape. Registered once on mount and
  // cleared on unmount so a torn-down MarmotContext never leaves a stale
  // provider consulted by a later session. Fail-closed inside the provider
  // itself is api.ts's concern (`groupAdminsFor` swallows a throw/reject to
  // `[]`) — this closure only needs to surface the live adminPubkeys.
  useEffect(() => {
    registerGroupAdminsProvider(async (groupId: string): Promise<string[]> => {
      const client = clientRef.current;
      if (!client) return [];
      const mlsGroup = await client.groups.get(groupId).catch(() => null);
      return mlsGroup?.groupData?.adminPubkeys ?? [];
    });
    return () => registerGroupAdminsProvider(null);
  }, []);

  const getClient = useCallback((): MarmotClientType | null => {
    return clientRef.current;
  }, []);

  const loadPendingRequestsForGroup = useCallback(async (groupId: string): Promise<void> => {
    const { loadPendingJoinRequests } = await import('@/src/lib/marmot/joinRequestStorage');
    const requests = await loadPendingJoinRequests(groupId);
    setPendingRequests((prev) => ({ ...prev, [groupId]: requests }));
  }, []);

  const approveJoinRequest = useCallback(
    async (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest): Promise<{ ok: boolean; error?: string }> => {
      const { pubkeyToNpub } = await import('@/src/lib/nostrKeys');
      const { deletePendingJoinRequest } = await import('@/src/lib/marmot/joinRequestStorage');
      const { incrementInviteLinkUsage } = await import('@/src/lib/marmot/inviteLinkStorage');
      return approveJoinRequestImpl(
        {
          inviteByNpub,
          pubkeyToNpub,
          deletePendingJoinRequest,
          incrementInviteLinkUsage,
          decrementJoinRequest,
          filterPendingRequest: (groupId, eventId) => {
            setPendingRequests((prev) => {
              const current = prev[groupId] ?? [];
              return { ...prev, [groupId]: current.filter((r) => r.eventId !== eventId) };
            });
          },
          mergeMemberProfile,
          bumpProfileVersion: () => setProfileVersion((v) => v + 1),
        },
        request,
      );
    },
    [inviteByNpub],
  );

  const denyJoinRequest = useCallback(
    async (request: import('@/src/lib/marmot/joinRequestStorage').PendingJoinRequest): Promise<void> => {
      const { deletePendingJoinRequest } = await import('@/src/lib/marmot/joinRequestStorage');
      await deletePendingJoinRequest(request.eventId);
      decrementJoinRequest(request.groupId);
      // Update local pending requests state
      setPendingRequests((prev) => {
        const current = prev[request.groupId] ?? [];
        return { ...prev, [request.groupId]: current.filter((r) => r.eventId !== request.eventId) };
      });
    },
    [],
  );

  const isPendingMember = useCallback(async (groupId: string, pubkey: string): Promise<boolean> => {
    const client = clientRef.current;
    if (!client) return false;
    try {
      const { isPendingMemberImpl } = await import('@/src/lib/marmot/cancelInvitationImpl');
      const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
      return isPendingMemberImpl(
        {
          getGroup: (id) => client.groups.get(id).catch(() => null),
          loadMemberProfiles,
          getGroupMembers,
        },
        groupId,
        pubkey,
      );
    } catch {
      return false;
    }
  }, []);

  const cancelPendingInvitation = useCallback(
    async (
      groupId: string,
      pubkey: string,
      sendAnnouncement?: (content: string) => Promise<void>,
    ): Promise<{ ok: boolean; error?: string; raceDetected?: boolean }> => {
      const client = clientRef.current;
      if (!client) return { ok: false, error: 'Not initialized' };
      try {
        const { cancelPendingInvitationImpl } = await import('@/src/lib/marmot/cancelInvitationImpl');
        const { getGroupMembers, getPubkeyLeafNodeIndexes, Proposals } = await import('@internet-privacy/marmot-ts');
        return await cancelPendingInvitationImpl(
          {
            getGroup: (id) => client.groups.get(id).catch(() => null),
            loadMemberProfiles,
            getGroupMembers,
            getPubkeyLeafNodeIndexes,
            Proposals,
            persistGroup,
            getStoredGroup: (id) => groups.find((g) => g.id === id),
            reloadGroups,
            markBackupDirty,
            selfPubkeyHex: pubkeyHex ?? '',
          },
          groupId,
          pubkey,
          sendAnnouncement,
        );
      } catch (err) {
        console.error('[Marmot] cancelPendingInvitation failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : 'generic' };
      }
    },
    [groups, reloadGroups, markBackupDirty, pubkeyHex],
  );

  const getPendingDirectInvites = useCallback(async (groupId: string): Promise<Set<string>> => {
    const { loadPendingDirectInviteMarkers } = await import('@/src/lib/marmot/pendingDirectInviteStorage');
    return loadPendingDirectInviteMarkers(groupId);
  }, []);

  // S2: Accept a pending invitation — calls joinGroupFromWelcome via the stored
  // welcomeEventJson, removes from queue on success or MLS failure, fires onGroupJoined.
  const acceptPendingInvitation = useCallback(async (id: string): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error('Marmot client not initialized');
    const { acceptPendingInvitation: doAccept } = await import('@/src/lib/marmot/welcomeSubscription');
    await doAccept(id, client, async (joinedGroup) => {
      await reloadGroups();
      markBackupDirty(true);
      console.info('[Marmot] Accepted invitation and joined group:', joinedGroup.name);
    });
  }, [reloadGroups, markBackupDirty]);

  // S2/S5: Decline a pending invitation — removes from queue unconditionally;
  // additionally sends an auth-gated gift-wrapped decline DM to the inviter
  // (AC-DECLINE-3/4) when the local identity is available. sendKeys is
  // omitted (rather than throwing) when privateKeyHex/pubkeyHex aren't
  // hydrated yet — declinePendingInvitation degrades to local-removal-only
  // in that case, matching every other best-effort send path in this file.
  const declinePendingInvitation = useCallback(async (id: string): Promise<void> => {
    const { declinePendingInvitation: doDecline } = await import('@/src/lib/marmot/welcomeSubscription');
    const ndk = privateKeyHex && pubkeyHex ? (await import('@/src/lib/ndkClient')).getNdk() : null;
    if (ndk && privateKeyHex && pubkeyHex) {
      await doDecline(id, { ndk, selfPubkeyHex: pubkeyHex, selfPrivateKeyHex: privateKeyHex });
    } else {
      await doDecline(id);
    }
  }, [privateKeyHex, pubkeyHex]);

  // S1 (inline-invitation-cards): reads a stored invitation's pre-join group
  // data (name/description/admins) without joining, for card preview. Never
  // throws — parse failure, an uninitialized client, or an undecodable
  // Welcome all resolve to null (readPreJoinGroupData already returns null
  // on its own failures per its contract).
  const getInvitationGroupData = useCallback(
    async (welcomeEventJson: string): Promise<{ name: string; description: string; adminPubkeys: string[] } | null> => {
      const client = clientRef.current;
      if (!client) return null;
      let rumor: UnwrappedRumor;
      try {
        rumor = JSON.parse(welcomeEventJson);
      } catch {
        return null;
      }
      const { readPreJoinGroupData } = await import('@/src/lib/marmot/welcomeSubscription');
      return readPreJoinGroupData(rumor, client);
    },
    [],
  );

  // S3: Grant admin status to a member. Pure impl in grantAdminImpl.ts (AC-BOUND-1).
  // Mirrors the cancelPendingInvitation pattern: dynamic import at the boundary,
  // Proposals injected via Deps so the impl has zero marmot-ts top-level imports.
  const grantAdmin = useCallback(
    async (groupId: string, pubkey: string): Promise<{ ok: boolean; error?: string }> => {
      const client = clientRef.current;
      if (!client) return { ok: false, error: 'Not initialized' };
      try {
        const { grantAdminImpl } = await import('@/src/lib/marmot/grantAdminImpl');
        const { Proposals } = await import('@internet-privacy/marmot-ts');
        return await grantAdminImpl(
          {
            getGroup: (id) => client.groups.get(id).catch(() => null),
            Proposals,
            reloadGroups,
            markBackupDirty,
          },
          groupId,
          pubkey,
        );
      } catch (err) {
        console.error('[Marmot] grantAdmin failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : 'generic' };
      }
    },
    [reloadGroups, markBackupDirty],
  );

  // Rename a group. Pure impl in renameGroupImpl.ts; mirrors the grantAdmin
  // boundary (dynamic import, Proposals injected). Updates the shared MLS
  // metadata (admin-only commit) AND the local overlay for the acting admin.
  // Remote members pick up the new name from the metadata resync in the
  // commit-ingestion callback below.
  const renameGroup = useCallback(
    async (groupId: string, name: string): Promise<{ ok: boolean; error?: string; changed?: boolean }> => {
      const client = clientRef.current;
      if (!client) return { ok: false, error: 'Not initialized' };
      try {
        const { renameGroupImpl } = await import('@/src/lib/marmot/renameGroupImpl');
        const { Proposals } = await import('@internet-privacy/marmot-ts');
        return await renameGroupImpl(
          {
            getGroup: (id) => client.groups.get(id).catch(() => null),
            Proposals,
            getStoredGroup: (id) => groups.find((g) => g.id === id),
            persistGroup,
            reloadGroups,
            markBackupDirty,
          },
          groupId,
          name,
        );
      } catch (err) {
        console.error('[Marmot] renameGroup failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : 'generic' };
      }
    },
    [groups, reloadGroups, markBackupDirty],
  );

  // S3: Synchronous accessor for pending-removal pubkeys. Reads pendingRemovalsRef
  // without triggering a re-render or side-effect (AC-REMOVE-1, architecture.md §pendingRemovalsRef).
  const getPendingRemovals = useCallback(
    (groupId: string): string[] => {
      return (pendingRemovalsRef.current.get(groupId) ?? []).map((e) => e.pubkey);
    },
    [],
  );

  // AC-025: Single-group variant of the app-start sweep. Emits PROFILE_REQUEST_KIND
  // for every stale member in the given group, scoped to that group only.
  const requestProfilesIfStale = useCallback(async (groupId: string): Promise<void> => {
    if (!pubkeyHex) return;
    try {
      const now = Date.now();
      const client = clientRef.current;
      if (!client) return;

      await sweepStaleProfiles({
        groupIds: [groupId],
        selfPubkeyHex: pubkeyHex,
        now,
        getGroupMembers: async (gid) => {
          const mlsGroup = await client.groups.get(gid).catch(() => null);
          if (!mlsGroup) return [];
          const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
          return getGroupMembers(mlsGroup.state);
        },
        loadProfile: async (gid, targetPubkey) => {
          const profiles = await loadMemberProfiles(gid);
          return profiles.find((p) => p.pubkeyHex === targetPubkey);
        },
        loadMemo: loadProfileRequestMemo,
        recordEmitted: recordRequestEmitted,
        sendRumor: async (gid, content) => {
          const g = await client.groups.get(gid).catch(() => null);
          if (!g) return;
          const rumor = buildRumor(PROFILE_REQUEST_KIND, content, pubkeyHex);
          await sendRumorSafe(g, rumor as any, { softFail: true });
          if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
            ((window as unknown as Record<string, unknown>).__fewTest as { onRumorSent?: (kind: number) => void } | undefined)
              ?.onRumorSent?.(PROFILE_REQUEST_KIND);
          }
        },
      });
    } catch (err) {
      console.warn('[Marmot] requestProfilesIfStale failed:', err);
    }
  }, [pubkeyHex]);

  // Bumps knownPeersRevision so the always-mounted watchers (which cache
  // loadKnownPeers() in a ref refreshed only on `groups` changes) pick up an
  // out-of-band knownPeers write immediately. Functional update avoids a
  // dependency on the current value, keeping this callback stable.
  const notifyKnownPeersChanged = useCallback((): void => {
    setKnownPeersRevision((n) => n + 1);
  }, []);

  // Bumps blockedPeersRevision so the always-mounted DM surfaces (S2's
  // DirectMessageNotificationsWatcher, S4's ContactChat) pick up a block or
  // unblock immediately. Functional update avoids a dependency on the current
  // value, keeping this callback stable (epic: block-contact, S1).
  const notifyBlockedPeersChanged = useCallback((): void => {
    setBlockedPeersRevision((n) => n + 1);
  }, []);

  // Bumps contactsRevision so the always-mounted contacts surfaces (the
  // contacts list + DM detail header in contacts.tsx, the notification bell's
  // name/avatar row lookups) re-derive from localStorage the moment an
  // arriving event changes a contact's membership or profile. Functional
  // update keeps this callback stable (epic: contacts-live-updates).
  const notifyContactsChanged = useCallback((): void => {
    setContactsRevision((n) => n + 1);
  }, []);

  /**
   * Re-publish key-package discoverability and kind 30051 relay list to the given
   * relay URLs. Called from the relay settings save handler so discoverability
   * immediately reflects the new relay set.
   */
  const republishDiscoverability = useCallback(async (relayUrls: string[]): Promise<void> => {
    if (!pubkeyHex || !signerRef.current) return;
    const signer = signerRef.current;
    const client = clientRef.current;
    try {
      // Re-publish key packages to the new relay set
      if (client) {
        const packages = await client.keyPackages.list();
        const usable = packages.filter((p) => !p.used && p.published && p.published.length > 0);
        if (usable.length === 0) {
          const { publishKeyPackages } = await import('@/src/lib/keyPackages');
          await publishKeyPackages(client.keyPackages, 5, relayUrls);
        }
      }

      // Force re-publish kind 30051 relay list (unconditionally, so new relay set is announced)
      const { getNdk } = await import('@/src/lib/ndkClient');
      const ndk = getNdk();
      if (ndk && relayUrls.length > 0) {
        const { NDKEvent, NDKRelaySet } = await import('@nostr-dev-kit/ndk');
        const unsigned = {
          kind: 30051,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', 'marmot'],
            ...relayUrls.map((url) => ['relay', url]),
          ],
          content: '',
          pubkey: pubkeyHex,
        };
        const signed = await signer.signEvent(unsigned as any);
        const ndkEvent = new NDKEvent(ndk, signed);
        const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk);
        await ndkEvent.publish(relaySet).catch(() => {
          // Non-fatal: invite flow degrades gracefully
        });
      }
    } catch (err) {
      console.warn('[Marmot] republishDiscoverability failed:', err);
    }
  }, [pubkeyHex]);

  const value = useMemo<MarmotContextValue>(
    () => ({
      ready,
      whenReady,
      unsupported,
      groups,
      createGroup,
      inviteByNpub,
      leaveGroup,
      publishProfileUpdate,
      getMemberProfiles,
      reloadGroups,
      clearAll,
      getGroup,
      getLiveMemberPubkeys,
      getClient,
      profileVersion,
      chatVersion,
      groupDataVersion,
      pollVersion,
      reactionsVersion,
      pendingRequests,
      loadPendingRequestsForGroup,
      approveJoinRequest,
      denyJoinRequest,
      isPendingMember,
      cancelPendingInvitation,
      getPendingDirectInvites,
      requestProfilesIfStale,
      acceptPendingInvitation,
      declinePendingInvitation,
      getInvitationGroupData,
      grantAdmin,
      renameGroup,
      getPendingRemovals,
      republishDiscoverability,
      knownPeersRevision,
      notifyKnownPeersChanged,
      blockedPeersRevision,
      notifyBlockedPeersChanged,
      contactsRevision,
      notifyContactsChanged,
    }),
    [
      ready,
      whenReady,
      unsupported,
      groups,
      createGroup,
      inviteByNpub,
      leaveGroup,
      publishProfileUpdate,
      getMemberProfiles,
      reloadGroups,
      clearAll,
      getGroup,
      getLiveMemberPubkeys,
      getClient,
      profileVersion,
      chatVersion,
      groupDataVersion,
      pollVersion,
      reactionsVersion,
      pendingRequests,
      loadPendingRequestsForGroup,
      approveJoinRequest,
      denyJoinRequest,
      isPendingMember,
      cancelPendingInvitation,
      getPendingDirectInvites,
      requestProfilesIfStale,
      acceptPendingInvitation,
      declinePendingInvitation,
      getInvitationGroupData,
      grantAdmin,
      renameGroup,
      getPendingRemovals,
      republishDiscoverability,
      knownPeersRevision,
      notifyKnownPeersChanged,
      blockedPeersRevision,
      notifyBlockedPeersChanged,
      contactsRevision,
      notifyContactsChanged,
    ]
  );

  return <MarmotContext.Provider value={value}>{children}</MarmotContext.Provider>;
}

const NOOP_ASYNC = async () => {};
const NOOP_BOOL = async () => false;
const NOOP_NULL = async () => null;
const NOOP_ARRAY = async () => [];

const DEFAULT_MARMOT: MarmotContextValue = {
  ready: false,
  // Default (no provider): never resolves — consumers gate on the 5 s ceiling.
  whenReady: () => new Promise<void>(() => {}),
  unsupported: false,
  groups: [],
  createGroup: NOOP_NULL as () => Promise<null>,
  inviteByNpub: async () => ({ ok: false, error: 'not_ready' }),
  leaveGroup: NOOP_BOOL,
  publishProfileUpdate: NOOP_ASYNC,
  getMemberProfiles: NOOP_ARRAY as () => Promise<MemberProfile[]>,
  reloadGroups: NOOP_ASYNC,
  clearAll: NOOP_ASYNC,
  getGroup: NOOP_NULL as () => Promise<null>,
  getLiveMemberPubkeys: async () => undefined,
  getClient: () => null,
  profileVersion: 0,
  chatVersion: 0,
  groupDataVersion: 0,
  pollVersion: 0,
  reactionsVersion: 0,
  pendingRequests: {},
  loadPendingRequestsForGroup: NOOP_ASYNC,
  approveJoinRequest: async () => ({ ok: false, error: 'not_ready' }),
  denyJoinRequest: NOOP_ASYNC,
  isPendingMember: async () => false,
  cancelPendingInvitation: async () => ({ ok: false, error: 'not_ready' }),
  getPendingDirectInvites: async () => new Set(),
  requestProfilesIfStale: NOOP_ASYNC,
  acceptPendingInvitation: NOOP_ASYNC,
  declinePendingInvitation: NOOP_ASYNC,
  getInvitationGroupData: async () => null,
  grantAdmin: async () => ({ ok: false, error: 'not_ready' }),
  renameGroup: async () => ({ ok: false, error: 'not_ready' }),
  getPendingRemovals: () => [],
  republishDiscoverability: NOOP_ASYNC,
  knownPeersRevision: 0,
  notifyKnownPeersChanged: () => {},
  blockedPeersRevision: 0,
  notifyBlockedPeersChanged: () => {},
  contactsRevision: 0,
  notifyContactsChanged: () => {},
};

export function useMarmot(): MarmotContextValue {
  const context = useContext(MarmotContext);
  // Return safe defaults when called outside provider (e.g., during dynamic load)
  return context ?? DEFAULT_MARMOT;
}
