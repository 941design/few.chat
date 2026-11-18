import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { useToast } from '@chakra-ui/react';
import type { MarmotGroup, PendingInvitation } from '@941design/marmot';
import type { WritableStores } from '@941design/marmot/storage';
import { groupSessionWipeCheckpoint, resumeApplicationWipe, wipeApplicationGroups } from '@/src/lib/marmot/groupSessionWipeCheckpoint';
import { startInviteExpirySweep } from '@/src/lib/marmot/inviteExpirySweep';
import { clearAllGroupData } from '@/src/lib/marmot/groupSessionStores';
import { selectDmMembership } from '@/src/lib/walledGarden';
import { useNostrIdentity } from './NostrIdentityContext';
import { useProfile } from './ProfileContext';
import { useCopy } from './LanguageContext';
import { STORAGE_KEYS, type Group, type UserProfile } from '@/src/types';
import {
  bootstrapAccountClient, inboxRelayList, reconcileOverlayGroups, openAccountStores,
  rebuildAccountForRelays, startAccountLifecycle, type AccountClient, type AccountClientHandle, type AccountLifecycle, type BootstrapInput, type LeaseState,
} from '@/src/lib/marmot/client';
import { readLiveMembers } from '@/src/lib/marmot/membership';
import { buildInvitationCardViewModels } from '@/src/lib/marmot/invitations';
import { createGroupSessionHistory } from '@/src/lib/marmot/groupSessionHistory';
import { createGroupSessionMembership } from '@/src/lib/marmot/groupSessionMembership';
import { createGroupProfileActions } from '@/src/lib/marmot/groupSessionProfile';
import { createGroupImageService, type GroupImageService } from '@/src/lib/media/imageMessage';
import { blossomMediaPorts } from '@/src/lib/media/blossomClient';
import { groupMediaCachePort } from '@/src/lib/marmot/mediaPersistence';
import { activeEventSignerOverride, createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { loadAllGroups, loadGroup, loadMemberProfiles } from '@/src/lib/marmot/groupStorage';
import { loadPendingJoinRequests, type PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';
import { type JoinRequestSender } from '@/src/lib/marmot/joinRequestSender';
import { getPendingDirectInviteMarker } from '@/src/lib/marmot/pendingDirectInviteStorage';
import type { GroupRumorSender } from '@/src/lib/marmot/send';
import { getActiveGroupId } from '@/src/lib/activeViewStore';
import { getEffectiveRelays } from '@/src/lib/relay';
import { getDeviceResetGeneration } from '@/src/lib/storage';
import { loadStoredIdentity, npubToPubkeyHex } from '@/src/lib/nostrKeys';
import { loadVerifiedNip46Account, parseSignerAccountPubkey } from '@/src/lib/nip46Perms';
import { loadKnownPeers, markKnownPeersMigrationComplete, rememberKnownPeers } from '@/src/lib/knownPeers';
import { MAINTAINER_PUBKEYS_HEX } from '@/src/config/maintainer';
import { purgeStrangerContacts } from '@/src/lib/contacts';
import { appendMessage, purgeStrangerDmThreads } from '@/src/lib/marmot/chatPersistence';
import { resolvePendingSignalsForSlot } from '@/src/lib/messageEdits/api';
import { purgeStrangerDmReactions, refreshReactionsFromStorage } from '@/src/lib/reactions/api';
import { initInviteExpiries, initJoinRequestCounts, initUnreadCounts, purgeStrangerDmCounters, scopeInviteExpiriesToOwner } from '@/src/lib/unreadStore';
import { subscribeStoreChanged } from '@/src/lib/crossTab';
import { applyStoreChanged } from '@/src/lib/crossTabReceiver';

export type InvitationView = PendingInvitation & { displayName?: string };
export type GroupActionResult = { ok: boolean; error?: string; changed?: boolean };

type Session = {
  handle: AccountClientHandle;
  listedGroupIds: string[];
  inbound: ReturnType<typeof createGroupSessionHistory>;
  membership: ReturnType<typeof createGroupSessionMembership>;
  profile: ReturnType<typeof createGroupProfileActions>;
  images: GroupImageService;
};

type RelayChange = {
  pubkey: string;
  previous: AccountClient | null;
  previousRelays: string[];
  targetRelays: string[];
  promise: Promise<void>;
  complete(error?: unknown): void;
};
type RelayChangeRetry = Pick<RelayChange, 'pubkey' | 'previousRelays' | 'targetRelays'> & { inboxOnly: boolean };
type ExplicitWipe = {
  owner: string;
  run(stores: WritableStores): Promise<void>;
  completed: boolean;
  failure?: { error: unknown };
};

type UnavailableReason = Extract<LeaseState, { reason: string }>['reason'];

function isStoredWipeAccount(mode: 'local' | 'nip07' | 'nip46', owner: string): boolean {
  const storedMode = localStorage.getItem(STORAGE_KEYS.signerMode) ?? 'local';
  if (storedMode !== mode) return false;
  const storedOwner = mode === 'local' ? loadStoredIdentity()?.pubkeyHex
    : mode === 'nip46' ? loadVerifiedNip46Account(localStorage)
    : parseSignerAccountPubkey(localStorage.getItem(STORAGE_KEYS.nip07Account));
  return storedOwner?.toLowerCase() === owner.toLowerCase();
}

interface MarmotContextValue {
  ready: boolean;
  waitingForLease: boolean;
  unsupported: boolean;
  unavailableReason: UnavailableReason | null;
  whenReady(): Promise<void>;
  whenDmGroupsReady(): Promise<void>;
  getDmGroups(): readonly Pick<Group, 'memberPubkeys'>[];
  groups: Group[];
  pendingInvitations: InvitationView[];
  createGroup(name: string): Promise<Group | null>;
  inviteByNpub(groupId: string, npub: string): Promise<GroupActionResult>;
  leaveGroup(groupId: string): Promise<'accepted' | 'blocked' | 'failed'>;
  publishProfileUpdate(profile?: UserProfile): Promise<boolean>;
  getMemberProfiles: typeof loadMemberProfiles;
  getGroup(groupId: string): Promise<MarmotGroup | null>;
  getLiveMemberPubkeys(groupId: string): Promise<string[] | undefined>;
  sendGroupNotice(groupId: string, content: string): Promise<void>;
  groupSender: GroupRumorSender | null;
  groupImages: GroupImageService | null;
  profileVersion: number;
  chatVersion: number;
  groupDataVersion: number;
  pollVersion: number;
  reactionsVersion: number;
  pendingRequests: Record<string, PendingJoinRequest[]>;
  loadPendingRequestsForGroup(groupId: string): Promise<void>;
  approveJoinRequest(request: PendingJoinRequest): Promise<GroupActionResult>;
  denyJoinRequest(request: PendingJoinRequest): Promise<void>;
  sendJoinRequest: JoinRequestSender['send'];
  getPendingDirectInvites(groupId: string, members: readonly string[]): Promise<Map<string, string>>;
  cancelPendingInvitation(groupId: string, pubkey: string, inviteeRef: string): Promise<GroupActionResult>;
  removeMember(groupId: string, pubkey: string): Promise<GroupActionResult>;
  requestProfilesIfStale(groupId: string): Promise<void>;
  acceptPendingInvitation(id: string): Promise<void>;
  declinePendingInvitation(id: string): Promise<void>;
  grantAdmin(groupId: string, pubkey: string): Promise<GroupActionResult>;
  renameGroup(groupId: string, name: string): Promise<GroupActionResult>;
  rebuildForRelays(relays: string[]): Promise<void>;
  wipeLocalGroups(resetAppData: () => Promise<void>): Promise<void>;
  knownPeersRevision: number;
  notifyKnownPeersChanged(): void;
  blockedPeersRevision: number;
  notifyBlockedPeersChanged(): void;
  contactsRevision: number;
  notifyContactsChanged(): void;
}

function readiness() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const MarmotContext = createContext<MarmotContextValue | null>(null);
const notReady = () => new Error('Groups are not ready');
const unavailable = async (): Promise<never> => { throw notReady(); };
const failed = async (): Promise<GroupActionResult> => ({ ok: false, error: 'not_ready' });
const ignore = () => {};
const ignoreAsync = async () => {};
const errorOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function useVersion() {
  const [version, setVersion] = useState(0);
  return [version, useCallback(() => setVersion((n) => n + 1), [])] as const;
}

export function MarmotProvider({ children }: { children: ReactNode }) {
  const { pubkeyHex, privateKeyHex, signerMode, signerAccountPubkey, signerAvailable, hydrated } = useNostrIdentity();
  const { profile } = useProfile();
  const toast = useToast();
  const copy = useCopy();
  const ui = useRef({ profile, copy, toast });
  ui.current = { profile, copy, toast };

  const [groups, setGroups] = useState<Group[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<InvitationView[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Record<string, PendingJoinRequest[]>>({});
  const [status, setStatus] = useState<LeaseState['state'] | 'loading'>('loading');
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profileVersion, bumpProfiles] = useVersion();
  const [chatVersion, bumpChat] = useVersion();
  const [groupDataVersion, bumpGroups] = useVersion();
  const [pollVersion, bumpPolls] = useVersion();
  const [reactionsVersion, bumpReactions] = useVersion();
  const [knownPeersRevision, notifyKnownPeersChanged] = useVersion();
  const [blockedPeersRevision, notifyBlockedPeersChanged] = useVersion();
  const [contactsRevision, notifyContactsChanged] = useVersion();

  const current = useRef<Session | null>(null);
  const dmOverlay = useRef<readonly Group[]>([]);
  const dmGate = useRef<ReturnType<typeof readiness> | null>(null);
  dmGate.current ??= readiness();
  const account = useRef<AccountClient | null>(null);
  const resolvedAccount = useRef<string | null>(null);
  const closing = useRef(Promise.resolve());
  const activeLifecycle = useRef<AccountLifecycle | null>(null);
  const wipeIdentityKey = `${signerMode}:${pubkeyHex ?? ''}:${signerAccountPubkey ?? ''}`;
  const wipeIdentity = useRef(wipeIdentityKey);
  wipeIdentity.current = wipeIdentityKey;
  const [deviceResetGeneration] = useState(getDeviceResetGeneration);
  const [lifecycleRevision, restartLifecycle] = useVersion();
  const explicitWipe = useRef<ExplicitWipe | null>(null);
  const gate = useRef<ReturnType<typeof readiness> | null>(null);
  gate.current ??= readiness();
  const [relays, setRelays] = useState<string[] | null>(null);
  const relayChange = useRef<RelayChange | null>(null);
  const retryRelayChange = useRef<RelayChangeRetry | null>(null);
  const effectiveRelays = useRef<string[]>([]);

  const whenReady = useCallback(() => gate.current!.promise, []);
  const whenDmGroupsReady = useCallback(() => dmGate.current!.promise, []);
  const getDmGroups = useCallback(() => {
    const session = current.current;
    if (session?.handle.leaseHeld()) return selectDmMembership([], session.membership.listLiveGroups(), true);
    return dmOverlay.current;
  }, []);

  useEffect(() => {
    let live = true;
    const prior = closing.current;
    const changes = relayChange.current;
    let resolvedPubkey = signerMode === 'local' ? pubkeyHex : null;
    resolvedAccount.current = resolvedPubkey;
    const ownGate = readiness();
    const ownDmGate = readiness();
    dmGate.current?.resolve();
    dmGate.current = ownDmGate;
    dmOverlay.current = [];
    scopeInviteExpiriesToOwner(null, []);
    let leaseSettled = false;
    gate.current?.resolve();
    gate.current = ownGate;
    setStatus('loading');
    setUnavailableReason(null);
    setSession(null);
    setGroups([]);
    setPendingInvitations([]);
    setPendingRequests({});
    if (!hydrated || !pubkeyHex || !signerAvailable) {
      if (hydrated) {
        if (signerMode === 'nip07' && !window.nostr?.nip44) {
          setStatus('unsupported');
          setUnavailableReason('nip44');
        } else if (pubkeyHex && !signerAvailable) {
          setStatus('unsupported');
          setUnavailableReason('startup');
        }
        ownGate.resolve();
        ownDmGate.resolve();
        changes?.complete(new Error('Group relay update requires a signer'));
      }
      return;
    }

    const eventSigner = signerMode === 'local'
      ? privateKeyHex && createPrivateKeySigner(privateKeyHex)
      : activeEventSignerOverride.current;
    if (!eventSigner) {
      ownGate.resolve();
      ownDmGate.resolve();
      changes?.complete(new Error('Group relay update requires a signer'));
      setStatus('unsupported');
      setUnavailableReason('startup');
      return;
    }

    const defaults = relays ?? getEffectiveRelays();
    effectiveRelays.current = defaults;
    let latestOverlayRead = 0;
    let publishedSession: Session | null = null;
    async function reloadOverlay(source?: Session) {
      const owner = source?.handle.pubkey ?? resolvedPubkey;
      if (!owner) return;
      const seq = ++latestOverlayRead;
      let overlay: Group[];
      try {
        overlay = (await loadAllGroups()).filter((group) => group.accountPubkey === owner);
      } catch (error) {
        if (source && live && seq === latestOverlayRead && current.current === source && !publishedSession) {
          setStatus('unsupported');
          setUnavailableReason('startup');
          ownGate.resolve();
          ownDmGate.resolve();
        }
        throw error;
      }
      if (!live || seq !== latestOverlayRead || (source && current.current !== source)) return;
      const shown = source ? source.membership.visibleGroups(overlay) : overlay;
      dmOverlay.current = shown;
      setGroups(shown);
      scopeInviteExpiriesToOwner(owner, shown.map(({ id }) => id));
      void initInviteExpiries().catch(console.warn);
      if (leaseSettled) ownDmGate.resolve();
      if (source?.handle.leaseHeld()) {
        stopExpiry ??= startInviteExpirySweep({
          belongsToSession: (id) => source.handle.leaseHeld() && current.current === source &&
            source.membership.listLiveGroupIds().includes(id),
        });
        publishedSession = source;
        setStatus('held');
        setSession(source);
        ownGate.resolve();
      }
      bumpGroups();
    }
    const refreshOverlay = () => {
      if (live) void reloadOverlay(current.current ?? undefined).catch(console.warn);
    };
    void reloadOverlay().catch(console.warn);
    window.addEventListener('focus', refreshOverlay);

    let assembling: Session | null = null;
    let removeTestHook: (() => void) | undefined;
    let stopExpiry: (() => Promise<void>) | undefined;
    let expiryDrain: Promise<void> | undefined;
    const drainExpiry = () => {
      if (stopExpiry) { expiryDrain = stopExpiry(); stopExpiry = undefined; }
      return expiryDrain ?? Promise.resolve();
    };
    const lifecycle = startAccountLifecycle({
      isCurrent: () => deviceResetGeneration === getDeviceResetGeneration(),
      async start(input) {
        await prior;
        if (input.signal?.aborted) return { status: 'aborted' };
        if (!changes || relayChange.current !== changes) return bootstrapAccountClient(input);
        const finishChange = (error?: unknown, inboxOnly = false) => {
          if (relayChange.current === changes) {
            relayChange.current = null;
            retryRelayChange.current = error === undefined ? null : {
              pubkey: changes.pubkey, previousRelays: changes.previousRelays, targetRelays: changes.targetRelays, inboxOnly,
            };
          }
          changes.complete(error);
        };
        let result: Awaited<ReturnType<typeof rebuildAccountForRelays>>;
        try {
          result = await rebuildAccountForRelays(changes.previous, input, changes.previousRelays, changes.pubkey);
        } catch (error) {
          if (!input.signal?.aborted) finishChange(error);
          throw error;
        }
        if (result.bootstrap.status === 'ready') {
          const errors = [...result.rotationErrors];
          if (result.inboxRelayListFailure) errors.push(result.inboxRelayListFailure.error);
          if (result.bootstrap.account.ensure.keyPackage === 'failed') errors.push(new Error('Key package ensure failed'));
          finishChange(
            errors.length ? new AggregateError(errors, 'Group relay update was incomplete') : undefined,
            errors.length === 1 && !!result.inboxRelayListFailure && result.rotationErrors.length === 0,
          );
        }
        return result.bootstrap;
      },
      makeInput(signal): BootstrapInput {
        let opened: Session | undefined;
        const available = () => {
          if (!opened) throw new Error('Group session has not opened');
          return opened;
        };
        const membership = () => available().membership;
        return {
          eventSigner,
          signerKind: signerMode,
          relays: defaults,
          signal,
          onAccountResolved(pubkey) {
            if (!live || signal.aborted) return;
            if (changes && relayChange.current === changes && changes.pubkey !== pubkey) {
              changes.complete(new Error('The group relay update belongs to another account'));
              relayChange.current = null;
            }
            if (resolvedPubkey === pubkey) return;
            resolvedPubkey = pubkey;
            resolvedAccount.current = pubkey;
            void reloadOverlay().catch(console.warn);
          },
          inboxRelayList,
          history: {
            async append(entry) {
              if (process.env.NODE_ENV === 'development') {
                const { beforeLiveGroupHistory } = await import('@/src/lib/testHooks/marmotSession');
                await beforeLiveGroupHistory(entry.groupId);
              }
              return available().inbound.history.append(entry);
            },
            list: (groupId) => available().inbound.history.list(groupId),
            async withdraw(groupId, ids) {
              if (process.env.NODE_ENV === 'development') {
                const { beforeLiveGroupHistory } = await import('@/src/lib/testHooks/marmotSession');
                await beforeLiveGroupHistory(groupId);
              }
              return available().inbound.history.withdraw(groupId, ids);
            },
            purge: (groupId) => available().inbound.history.purge(groupId),
            sweep: () => available().inbound.history.sweep(),
            async dispose() {
              if (!opened) return;
              if (current.current === opened) current.current = null;
              await drainExpiry();
              await opened.profile.dispose();
              await opened.membership.dispose();
              await opened.inbound.dispose();
            },
          },
          onAccountOpened(handle, transport, attachGroup) {
            const groupOf = (id: string) => {
              if (!handle.leaseHeld() || signal.aborted) return Promise.resolve(undefined);
              return handle.client.groups.get(id);
            };
            const inbound = createGroupSessionHistory({
              pubkey: handle.pubkey, groupOf, enqueue: handle.enqueue, getActiveGroupId,
              sendOwnProfile: (groupId) => available().profile.sendOwnProfile(groupId),
              onChatChanged: bumpChat, onProfilesChanged: bumpProfiles,
              onReactionsChanged: bumpReactions, onPollsChanged: bumpPolls,
              heldGroupIds: () => available().listedGroupIds,
            });
            const groupProfile = createGroupProfileActions({
              pubkey: handle.pubkey, signer: eventSigner, sender: inbound.sender, groupOf,
              profile: () => ui.current.profile, writable: () => handle.leaseHeld() && !signal.aborted,
            });
            const groupMembership = createGroupSessionMembership({
              handle, transport, defaultRelays: defaults, attachGroup,
              history: inbound.history, sender: inbound.sender,
              getOwnName: () => ui.current.profile.nickname,
              onJoined: (groupId) => { void groupProfile.sendOwnProfile(groupId).catch(console.warn); },
              onGroupsChanged: () => void reloadOverlay(opened).catch(console.warn),
              onInvitationsChanged: (invitations) => {
                if (!live || !opened || signal.aborted) return;
                const models = buildInvitationCardViewModels(
                  invitations, opened.membership.contexts.snapshot(), ui.current.copy.groups.pendingInvitations.unknownGroupFallback, Date.now(),
                );
                setPendingInvitations(invitations.map((invitation, index) => ({
                  ...invitation,
                  displayName: models[index].nameSource === 'context' ? models[index].displayName : undefined,
                })));
              },
              onJoinRequestsChanged: (groupId) => {
                void loadPendingJoinRequests(groupId).then((rows) => {
                  if (live && current.current === opened) setPendingRequests((prev) => ({ ...prev, [groupId]: rows }));
                }).catch(console.warn);
              },
              onLeaveFailed: () => ui.current.toast({ title: ui.current.copy.groups.leaveFailed, status: 'error' }),
              onLastAdminBlocked: () => ui.current.toast({ title: ui.current.copy.groups.lastAdminLeaveBlocked, status: 'warning' }),
            });
            const images = createGroupImageService({
              ...blossomMediaPorts(eventSigner), cache: groupMediaCachePort, sender: inbound.sender,
            });
            opened = { handle, listedGroupIds: [], inbound, membership: groupMembership, profile: groupProfile, images };
            assembling = opened;
          },
          async afterGroupsListed(listed) {
            // Handles can be abandoned by a removal event while startup is running.
            const listedSnapshot = listed.flatMap((group) => {
              try { return [{ id: group.id, group }]; } catch { return []; }
            });
            const value = available();
            value.listedGroupIds = listedSnapshot.map(({ id }) => id);
            await reconcileOverlayGroups({
              hasLease: () => value.handle.leaseHeld() && !signal.aborted,
              overlayGroups: (await loadAllGroups())
                .filter((group) => !group.accountPubkey || group.accountPubkey === value.handle.pubkey),
              listedGroups: listedSnapshot,
              purger: value.membership.purger,
            });
            await value.membership.syncListed(listedSnapshot.map(({ group }) => group));
            await value.membership.start();
          },
          async beforeClientConstruction(stores) {
            await resumeApplicationWipe(stores, clearAllGroupData);
          },
          async beforeStoresClose(stores) {
            const wipe = explicitWipe.current;
            if (!stores.lease.held || wipe?.owner !== stores.account.account) return;
            try {
              await wipe.run(stores);
              wipe.completed = true;
            } catch (error) {
              wipe.failure = { error };
              throw error;
            }
          },
          clientEvents: {
            groupRemoved: (event) => membership().onGroupRemoved(event),
            inboxDisposition: (event) => membership().onInboxDisposition(event),
            welcomeDeclined: (event) => membership().onWelcomeDeclined(event),
            intentFailed: (event) => available().inbound.tracker.onIntentFailed(event),
            groupBranchSwitched: (event) => available().inbound.tracker.onGroupBranchSwitched(event),
            storeIncompatible: () => {},
          },
          onGroupNotification: (group, notification) => membership().onGroupNotification(group, notification),
          inboxHandlers: {
            joinRequest: (event, meta) => membership().inboxHandlers.joinRequest(event, meta),
            inviteContext: (event, meta) => membership().inboxHandlers.inviteContext(event, meta),
          },
        };
      },
      clearAllGroupData,
      wipeCheckpoint: groupSessionWipeCheckpoint,
      onError: (error) => console.warn('[marmot] account lifecycle failed', error),
      onState(result) {
        if (!live) return;
        leaseSettled = true;
        if (changes && relayChange.current === changes && result.state !== 'held') {
          if (result.state === 'unsupported') {
            relayChange.current = null;
            retryRelayChange.current = {
              pubkey: changes.pubkey, previousRelays: changes.previousRelays, targetRelays: changes.targetRelays, inboxOnly: false,
            };
          }
          changes.complete(new Error(result.state === 'waiting'
            ? 'Group relay update is waiting for the account lease'
            : 'Group relay update could not start'));
        }
        setStatus(result.state);
        setUnavailableReason('reason' in result ? result.reason : null);
        if (result.state !== 'held' || !assembling) {
          void drainExpiry();
          removeTestHook?.();
          current.current = null;
          account.current = null;
          setSession(null);
          publishedSession = null;
          setPendingInvitations([]);
          ownGate.resolve();
          if (!resolvedPubkey) ownDmGate.resolve();
          void reloadOverlay().catch((error) => { console.warn(error); ownDmGate.resolve(); });
          return;
        }
        account.current = result.account;
        if (process.env.NODE_ENV !== 'production') {
          void import('@/src/lib/testHooks/marmotSession').then(({ installMarmotSessionTestHook }) => {
            if (!live || account.current !== result.account) return;
            removeTestHook?.();
            removeTestHook = installMarmotSessionTestHook(result.account);
          });
        }
        const opened = assembling;
        current.current = opened;
        ownDmGate.resolve();
        void reloadOverlay(opened).catch((error) => console.warn('[marmot] failed to load group overlay', error));
        const ids = opened.membership.listLiveGroupIds();
        void initUnreadCounts(ids, opened.handle.pubkey).catch(console.warn);
        void initJoinRequestCounts(ids).catch(console.warn);
        // Accept can be durable before a reload interrupts its first profile send.
        void opened.profile.recoverMissingOwnProfiles(opened.listedGroupIds.filter((id) => ids.includes(id))).catch(console.warn);
        void opened.profile.requestProfiles(ids).catch(console.warn);
      },
    });

    activeLifecycle.current = lifecycle;
    return () => {
      live = false;
      scopeInviteExpiriesToOwner(null, []);
      window.removeEventListener('focus', refreshOverlay);
      removeTestHook?.();
      changes?.complete(new Error('Group relay update was interrupted'));
      resolvedAccount.current = null;
      current.current = null;
      account.current = null;
      ownGate.resolve();
      ownDmGate.resolve();
      activeLifecycle.current = null;
      closing.current = lifecycle.stop().catch(console.warn);
    };
  }, [privateKeyHex, pubkeyHex, signerMode, signerAvailable, hydrated, relays, lifecycleRevision, deviceResetGeneration, bumpChat, bumpGroups, bumpPolls, bumpProfiles, bumpReactions]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    void import('@/src/lib/marmot/profileSync').then(({ parseProfilePayload }) => {
      const scope = window as Window & { __fewTest?: Record<string, unknown> };
      (scope.__fewTest ??= {}).parseProfilePayload = parseProfilePayload;
    });
  }, []);

  useEffect(() => {
    const active = session?.handle;
    if (!session || !active?.leaseHeld()) return;
    const membership = selectDmMembership(groups, session.membership.listLiveGroups(), active.leaseHeld());
    const peers = membership.flatMap(({ memberPubkeys }) => memberPubkeys.filter((peer) => peer !== active.pubkey));
    rememberKnownPeers([...MAINTAINER_PUBKEYS_HEX, ...peers]);
    notifyKnownPeersChanged();
    const whitelist = () => ({
      groups: selectDmMembership(groups, session.membership.listLiveGroups(), active.leaseHeld()),
      ownPubkeyHex: active.pubkey,
      knownPeers: loadKnownPeers(),
    });
    purgeStrangerDmCounters(whitelist);
    purgeStrangerContacts(whitelist);
    if (active.leaseHeld()) {
      void Promise.all([purgeStrangerDmThreads(whitelist), purgeStrangerDmReactions(whitelist)])
        .then(() => { if (active.leaseHeld()) markKnownPeersMigrationComplete(); })
        .catch(console.warn);
    }
  }, [session, groups, notifyKnownPeersChanged]);

  useEffect(() => subscribeStoreChanged((message) => applyStoreChanged(message, {
    bumpBlockedPeers: notifyBlockedPeersChanged,
    bumpKnownPeers: notifyKnownPeersChanged,
    bumpContacts: notifyContactsChanged,
    refreshReactions: (id) => { void refreshReactionsFromStorage(id); },
  })), [notifyBlockedPeersChanged, notifyContactsChanged, notifyKnownPeersChanged]);

  const liveSession = useCallback(() => {
    const value = current.current;
    return value?.handle.leaseHeld() ? value : null;
  }, []);
  const requireSession = useCallback(() => {
    const value = liveSession();
    if (!value) throw notReady();
    return value;
  }, [liveSession]);
  const getGroup = useCallback(async (groupId: string) =>
    (await liveSession()?.handle.client.groups.get(groupId)) ?? null, [liveSession]);
  const getLiveMemberPubkeys = useCallback((id: string) =>
    readLiveMembers(async (groupId) => (await getGroup(groupId)) ?? undefined, id), [getGroup]);
  const loadPendingRequestsForGroup = useCallback(async (groupId: string) => {
    const rows = await loadPendingJoinRequests(groupId);
    setPendingRequests((prev) => ({ ...prev, [groupId]: rows }));
  }, []);
  const requestProfilesIfStale = useCallback(async (groupId: string) => {
    await liveSession()?.profile.requestProfiles([groupId]).catch(console.warn);
  }, [liveSession]);
  const getPendingDirectInvites = useCallback(async (groupId: string, members: readonly string[]) => {
    const sponsor = liveSession()?.handle.pubkey;
    if (!sponsor) return new Map<string, string>();
    const markers = await Promise.all(members.map((member) => getPendingDirectInviteMarker(groupId, member, sponsor)));
    return new Map(markers.flatMap((marker) => marker && !marker.declined && !marker.viaJoinRequest ? [[marker.pubkey, marker.inviteeRef]] : []));
  }, [liveSession]);
  const rebuildForRelays = useCallback((next: string[]): Promise<void> => {
    const owner = resolvedAccount.current;
    const pending = relayChange.current;
    const sameAs = (relays: readonly string[]) => next.length === relays.length && next.every((relay, i) => relay === relays[i]);
    if (pending && (owner === null || pending.pubkey === owner) && sameAs(pending.targetRelays)) return pending.promise;
    pending?.complete(new Error('Relay update superseded'));
    if (!owner) {
      relayChange.current = null;
      if (!sameAs(effectiveRelays.current)) setRelays([...next]);
      return Promise.reject(new Error('Group account is still resolving'));
    }
    let retry = retryRelayChange.current?.pubkey === owner ? retryRelayChange.current : null;
    const active = account.current;
    const unchanged = sameAs(effectiveRelays.current);
    if (!pending && unchanged && (!retry || retry.inboxOnly) && active?.handle.leaseHeld() &&
        active.retryLegacyInboxDiscovery && (active.legacyInboxDiscoveryPending || active.ensure.inboxRelayList === 'failed')) {
      return active.retryLegacyInboxDiscovery().then(() => {
        if (retryRelayChange.current === retry) retryRelayChange.current = null;
      });
    }
    if (retry?.inboxOnly && sameAs(retry.targetRelays) && unchanged &&
        active?.handle.leaseHeld() && active.ensure.inboxRelayList === 'ok') {
      retryRelayChange.current = retry = null;
    }
    if (!pending && !retry && unchanged) return Promise.resolve();
    const carriedRelays = pending?.pubkey === owner ? pending.previousRelays : [];
    let complete!: RelayChange['complete'];
    const promise = new Promise<void>((resolve, reject) => {
      complete = (error) => error === undefined ? resolve() : reject(error);
    });
    relayChange.current = {
      pubkey: owner,
      previous: account.current,
      previousRelays: [...new Set([...effectiveRelays.current, ...carriedRelays, ...(retry?.previousRelays ?? [])])],
      targetRelays: [...next],
      promise,
      complete,
    };
    setRelays([...next]);
    return promise;
  }, []);
  const wipeLocalGroups = useCallback(async (resetAppData: () => Promise<void>) => {
    const sameDeviceGeneration = () => deviceResetGeneration === getDeviceResetGeneration();
    if (!sameDeviceGeneration()) throw new Error('The device was already reset in another tab');
    const owner = signerMode === 'local' ? pubkeyHex : signerAccountPubkey;
    if (!owner) {
      if (signerMode !== 'local') throw new Error('Reconnect the signer to verify which group account to wipe');
      await resetAppData();
      return;
    }
    if (explicitWipe.current !== null) throw new Error('A group wipe is already in progress');
    const lifecycle = activeLifecycle.current;
    const isCurrent = () => wipeIdentity.current === wipeIdentityKey &&
      (resolvedAccount.current === null || resolvedAccount.current === owner) && activeLifecycle.current === lifecycle;
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error('The group account changed while waiting to wipe it');
    };
    const assertBeforeReset = () => {
      assertCurrent();
      if (!sameDeviceGeneration()) throw new Error('The device was already reset in another tab');
      if (!isStoredWipeAccount(signerMode, owner)) throw new Error('The stored signer account changed while waiting to wipe it');
    };
    const wipe: ExplicitWipe = {
      owner,
      completed: false,
      async run(stores) {
        assertBeforeReset();
        if (!stores.lease.held || stores.account.account !== owner) throw new Error('Group account lease is unavailable');
        await wipeApplicationGroups(stores, clearAllGroupData);
        assertBeforeReset();
        if (!stores.lease.held) throw new Error('Group account lease was lost during the wipe');
        await resetAppData();
      },
    };
    // Acquire the lease before stopping a waiting lifecycle: a refused wipe
    // must leave its retry loop alive for the eventual handoff.
    assertBeforeReset();
    let stopping = false;
    try {
      const preopened = account.current?.handle.leaseHeld() ? undefined : await openAccountStores(owner);
      try {
        assertBeforeReset();
        if (explicitWipe.current !== null) throw new Error('A group wipe is already in progress');
        if (preopened?.status === 'lease-held') throw new Error('Groups are active in another tab');
        if (preopened?.status === 'unsupported') throw new Error('Group storage is unsupported');
        explicitWipe.current = wipe;
        current.current = null;
        setSession(null);
        try {
          stopping = lifecycle !== null;
          await lifecycle?.stop();
          assertCurrent();
          if (wipe.failure) throw wipe.failure.error;
          if (!wipe.completed) {
            assertBeforeReset();
            const opened = preopened ?? await openAccountStores(owner);
            try {
              assertCurrent();
              if (opened.status === 'lease-held') throw new Error('Groups are active in another tab');
              if (opened.status === 'unsupported') throw new Error('Group storage is unsupported');
              await wipe.run(opened.stores);
            } finally {
              if (!preopened && opened.status === 'opened') await opened.stores.close();
            }
          }
        } finally {
          explicitWipe.current = null;
        }
      } finally {
        if (preopened?.status === 'opened') await preopened.stores.close();
      }
      assertCurrent();
    } catch (error) {
      if (stopping && isCurrent()) {
        if (sameDeviceGeneration() && isStoredWipeAccount(signerMode, owner)) restartLifecycle();
        else {
          setStatus('unsupported');
          setUnavailableReason('startup');
        }
      }
      throw error;
    }
  }, [pubkeyHex, signerMode, signerAccountPubkey, wipeIdentityKey, deviceResetGeneration, restartLifecycle]);
  const sendGroupNotice = useCallback(async (groupId: string, content: string) => {
    const active = liveSession();
    if (!active || active.handle.pubkey !== pubkeyHex) throw new Error('Group session unavailable');
    const group = await active.handle.client.groups.get(groupId);
    if (!group || liveSession() !== active) throw new Error('Group sender unavailable');
    const { rumor, send } = active.inbound.sender.prepare(group, 9, content, []);
    await send();
    if (liveSession() !== active) return;
    // Keep the local row when the UI navigates before the library delivers its echo.
    if (await appendMessage(groupId, {
      id: rumor.id, content, groupId, senderPubkey: active.handle.pubkey,
      createdAt: rumor.created_at * 1000,
    })) bumpChat();
    await resolvePendingSignalsForSlot({ kind: 'group', groupId }, rumor.id, active.handle.pubkey).catch(console.warn);
  }, [liveSession, pubkeyHex]);

  const action = useCallback(async (op: (membership: Session['membership']) => Promise<unknown>): Promise<GroupActionResult> => {
    try {
      const result = await op(requireSession().membership);
      return typeof result === 'object' && result && 'ok' in result ? result as GroupActionResult : { ok: true };
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    }
  }, [requireSession]);

  const membershipActions = useMemo<Pick<MarmotContextValue,
    'createGroup' | 'inviteByNpub' | 'leaveGroup' | 'publishProfileUpdate' |
    'approveJoinRequest' | 'denyJoinRequest' | 'sendJoinRequest' | 'acceptPendingInvitation' |
    'declinePendingInvitation' | 'removeMember' | 'cancelPendingInvitation' | 'grantAdmin' | 'renameGroup'
  >>(() => ({
    createGroup: async (name) => {
      const active = liveSession();
      if (!active) return null;
      const group = await active.membership.create(name);
      return (await loadGroup(group.id, active.handle.pubkey)) ?? null;
    },
    inviteByNpub: (groupId, npub) => {
      const pubkey = npubToPubkeyHex(npub);
      return pubkey ? action(async (membership) => {
        const result = await membership.invite(groupId, pubkey);
        if ('error' in result) return { ok: false, error: result.error };
        return { ok: result.outcome.status !== 'failed' };
      }) : failed();
    },
    leaveGroup: async (groupId) => {
      const result = await liveSession()?.membership.leave(groupId);
      if (!result) return 'failed';
      if (result.status === 'blocked') return 'blocked';
      // The solo group's local purge must finish before the UI navigates away.
      if (result.mode === 'abandon' && (await result.settled).status !== 'left') return 'failed';
      return 'accepted';
    },
    publishProfileUpdate: async (override) => {
      const requested = gate.current;
      await requested?.promise;
      if (gate.current !== requested) return false;
      const active = liveSession();
      if (!active) return false;
      return active.profile.publishProfile(
        override ?? ui.current.profile,
        active.membership.listLiveGroupIds(),
        () => ui.current.toast({ title: ui.current.copy.groups.profileSendFailed, status: 'error' }),
      );
    },
    approveJoinRequest: (request) => action((membership) => membership.approveJoinRequest(request)),
    denyJoinRequest: (request) => requireSession().membership.denyJoinRequest(request),
    sendJoinRequest: (request) => requireSession().membership.sendJoinRequest(request),
    acceptPendingInvitation: async (id) => { await requireSession().membership.accept(id); },
    declinePendingInvitation: async (id) => { await requireSession().membership.decline(id); },
    removeMember: (groupId, pubkey) => action((membership) => membership.removeMember(groupId, pubkey)),
    cancelPendingInvitation: (groupId, pubkey, ref) => action(async (membership) => ({
      ok: true,
      changed: await membership.cancelInvitation(groupId, { account: pubkey, inviteeRef: ref }),
    })),
    grantAdmin: (groupId, pubkey) => action((membership) => membership.grantAdmin(groupId, pubkey)),
    renameGroup: (groupId, name) => action(async (membership) => { await membership.rename(groupId, name); return { ok: true, changed: true }; }),
  }), [action, liveSession, requireSession]);

  const value: MarmotContextValue = {
    ready: status === 'held' && !!session?.handle.leaseHeld(),
    waitingForLease: status === 'waiting',
    unsupported: status === 'unsupported',
    unavailableReason,
    whenReady, whenDmGroupsReady, getDmGroups, groups, pendingInvitations, getGroup, getLiveMemberPubkeys, sendGroupNotice,
    getMemberProfiles: loadMemberProfiles, getPendingDirectInvites,
    groupSender: session?.inbound.sender ?? null,
    groupImages: session?.images ?? null,
    profileVersion, chatVersion, groupDataVersion, pollVersion, reactionsVersion,
    pendingRequests, loadPendingRequestsForGroup, requestProfilesIfStale,
    ...membershipActions,
    rebuildForRelays, wipeLocalGroups,
    knownPeersRevision, notifyKnownPeersChanged, contactsRevision, notifyContactsChanged,
    blockedPeersRevision, notifyBlockedPeersChanged,
  };
  return <MarmotContext.Provider value={value}>{children}</MarmotContext.Provider>;
}

const DEFAULT_MARMOT: MarmotContextValue = {
  ready: false, unsupported: false, unavailableReason: null, waitingForLease: false, whenReady: ignoreAsync, whenDmGroupsReady: ignoreAsync, getDmGroups: () => [], groups: [],
  pendingInvitations: [], pendingRequests: {},
  groupSender: null, groupImages: null,
  profileVersion: 0, chatVersion: 0, groupDataVersion: 0, pollVersion: 0, reactionsVersion: 0,
  createGroup: async () => null, getGroup: async () => null, getLiveMemberPubkeys: async () => undefined,
  inviteByNpub: failed, leaveGroup: async () => 'failed', publishProfileUpdate: async () => false,
  getMemberProfiles: async () => [], loadPendingRequestsForGroup: ignoreAsync, requestProfilesIfStale: ignoreAsync,
  getPendingDirectInvites: async () => new Map(),
  approveJoinRequest: failed, denyJoinRequest: unavailable, sendJoinRequest: unavailable,
  acceptPendingInvitation: unavailable, declinePendingInvitation: unavailable,
  cancelPendingInvitation: failed, removeMember: failed, grantAdmin: failed, renameGroup: failed,
  sendGroupNotice: unavailable, rebuildForRelays: unavailable, wipeLocalGroups: unavailable,
  knownPeersRevision: 0, blockedPeersRevision: 0, contactsRevision: 0,
  notifyKnownPeersChanged: ignore, notifyBlockedPeersChanged: ignore, notifyContactsChanged: ignore,
};

export function useMarmot(): MarmotContextValue {
  return useContext(MarmotContext) ?? DEFAULT_MARMOT;
}
