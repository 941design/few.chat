import type { GroupNotification, MarmotGroup, PendingInvitation } from '@941design/marmot';
import type { Group } from '@/src/types';
import type { AccountClientHandle } from './client/createClient';
import type { ClientTransport } from './client/transport';
import { INBOX_CALLBACK, type ClientCallbackScope } from './client';
import { createGroupOpQueue, type GroupRumorSender } from './send';
import { createLocalGroupPurger, createGroupLeaver, createGroupRemovalHandlers, createDisbandMarker, removeMember, renameGroup, grantAdmin, cancelInvitation } from './membership';
import { createPendingInvitationView, createDenyLayer, createTrustedSponsorPredicate, createInviteContextStore, bindInviteContextToPendingView, createInviteContextHandler, createInvitationActions, withInviteContextCleanup, createKeyPackageLookup, createKeyPackageInviter, createMarkerRecordingInviter, createDeclineDurability, createInviteContextSender, createContextSendingInviter, createAutoAccept } from './invitations';
import { createGroupNotificationRouter } from './handlers/groupRumorDispatch';
import { createIdbInviteContextPort } from './inviteContextIdbPort';
import { loadBlockedPeers } from '../blockedPeers';
import { isActiveView } from '../activeViewStore';
import { isKnownPeer } from '../knownPeers';
import { loadGroup, saveGroup, deleteGroup, hasOtherGroupOwner, clearMemberProfiles, mergeMemberProfile, deleteMemberProfile } from './groupStorage';
import { clearMessages } from './chatPersistence';
import { clearMessageEditsStateForThread } from '../messageEdits/api';
import { clearReactionsForGroup, purgeHeldReactionsForGroup } from '../reactions/api';
import { clearPollData, releasePollPurgeMark } from './pollPersistence';
import { clearGroupMedia } from './mediaPersistence';
import { clearProfileRequestMemos } from './profileRequestStorage';
import { clearUnreadGroup, clearJoinRequestGroup, clearInviteExpiries, incrementJoinRequest, decrementJoinRequest } from '../unreadStore';
import { clearPendingJoinRequestsForGroup, deletePendingJoinRequest, type PendingJoinRequest } from './joinRequestStorage';
import { clearInviteLinksForGroup, incrementInviteLinkUsage } from './inviteLinkStorage';
import { clearPendingDirectInvitesForGroup, clearSponsorPendingDirectInvites, createSponsorDeclineMarkerStore } from './pendingDirectInviteStorage';
import { createJoinRequestInboxHandler, joinRequestStorePorts } from './joinRequestHandler';
import { createJoinRequestSender } from './joinRequestSender';
import { createJoinRequestApproval } from './joinRequestApproval';
import {
  saveOutboundJoinRequest,
  loadUnexpiredOutboundJoinRequestsForAdmin,
  claimOutboundJoinRequest,
  releaseOutboundJoinRequestClaim,
  consumeOutboundJoinRequestClaim,
  type OutboundJoinRequestRecord,
} from './outboundJoinRequests';

export interface GroupSessionMembershipDeps {
  handle: AccountClientHandle;
  transport: ClientTransport['transport'];
  defaultRelays: readonly string[];
  history: { purge(groupId: string): Promise<void> };
  sender: Pick<GroupRumorSender, 'sendGroupRumor' | 'forgetGroup'>;
  attachGroup(group: MarmotGroup): void;
  getOwnName?: () => string | undefined;
  onJoined?: (groupId: string) => void;
  onGroupsChanged(): void;
  onInvitationsChanged(invitations: PendingInvitation[]): void;
  onJoinRequestsChanged(groupId: string): void;
  onLeaveFailed(groupId: string, error: unknown): void;
  onLastAdminBlocked(groupId: string): void;
  onError?: (error: unknown) => void;
}

/** Compose once per account generation, before inbox handlers are registered. */
export function createGroupSessionMembership(deps: GroupSessionMembershipDeps) {
  const { handle, sender } = deps;
  const { client, pubkey } = handle;
  const baseQueue = createGroupOpQueue();
  const live = new Map<string, MarmotGroup>();
  const liveAdmins = new Map<string, string>();
  const hidden = new Set<string>();
  const joined = new Set<string>();
  let disposed = false;
  let started = false;
  let pendingDisposition = false;
  const report = deps.onError ?? ((error: unknown) => console.error('[groupSessionMembership]', error));
  const assertLease = () => {
    if (disposed || !handle.leaseHeld()) throw Object.assign(new Error('Group session is not writable'), { code: 'disposed' as const });
  };
  const writes = new Set<Promise<unknown>>();
  const guarded = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    assertLease();
    const result = fn(...args);
    const write = Promise.resolve(result);
    writes.add(write);
    const settled = () => { writes.delete(write); };
    void write.then(settled, settled);
    return result;
  };
  const saveOverlay = guarded(saveGroup);
  const contextPort = createIdbInviteContextPort(pubkey);
  const sponsorMarkers = createSponsorDeclineMarkerStore(pubkey);
  const markers = {
    ...sponsorMarkers,
    record: guarded(sponsorMarkers.record),
    markDeclined: guarded(sponsorMarkers.markDeclined),
    setPhase: guarded(sponsorMarkers.setPhase),
    clearIfRef: guarded(sponsorMarkers.clearIfRef),
    clearAnnouncement: guarded(sponsorMarkers.clearAnnouncement),
  };
  const queue: typeof baseQueue = { ...baseQueue, runCommit: (group, op, options) => { assertLease(); return baseQueue.runCommit(group, () => { assertLease(); return op(); }, options); } };
  const enqueue = (job: () => Promise<void>, scope?: ClientCallbackScope) => {
    if (disposed || !handle.leaseHeld()) return false;
    handle.enqueue(async () => { if (!disposed && handle.leaseHeld()) await job(); }, scope);
    return true;
  };
  const enqueueInbox = (job: () => Promise<void>) => enqueue(job, INBOX_CALLBACK);
  const getGroup = async (id: string) => {
    assertLease();
    try {
      const group = await client.groups.get(id);
      assertLease();
      return group ?? undefined;
    } catch (error) {
      assertLease();
      throw error;
    }
  };
  const trusted = createTrustedSponsorPredicate(pubkey, isKnownPeer);
  const denyLayer = createDenyLayer({ loadBlockedPeers });
  const pendingView = createPendingInvitationView({ invitations: client.invitations, denyLayer, enqueue: enqueueInbox, isTrustedSponsor: trusted, now: Date.now, onError: report });
  const contexts = createInviteContextStore({
    port: { ...contextPort, save: guarded(contextPort.save) },
    now: Date.now,
    getPending: pendingView.pending,
    isTrustedSponsor: trusted,
    onError: report,
    scheduleExpiry(delayMs, expire) {
      const timer = setTimeout(() => {
        if (!disposed && handle.leaseHeld()) void expire().catch(report);
      }, delayMs);
      return () => clearTimeout(timer);
    },
  });
  const contextBinding = bindInviteContextToPendingView({ view: pendingView, store: contexts, onError: report });

  const overlayWrites = new Map<string, Set<Promise<unknown>>>();
  const purging = new Map<string, number>();
  const purgeRace = () => Object.assign(new Error('Group is being purged'), { code: 'group-purging' as const });
  const rawPurger = createLocalGroupPurger({
    ownPubkey: pubkey, getGroup, hasOtherOwner: async (id) => { assertLease(); const result = await hasOtherGroupOwner(id, pubkey); assertLease(); return result; }, history: { purge: guarded((id: string) => deps.history.purge(id)) }, tracker: { forgetGroup: guarded((id: string) => sender.forgetGroup(id)) },
    clearMessages: guarded(clearMessages), clearMessageEdits: guarded(clearMessageEditsStateForThread),
    clearReactions: guarded(clearReactionsForGroup), purgeHeldReactions: guarded(purgeHeldReactionsForGroup),
    clearPollData: guarded(clearPollData), clearGroupMedia: guarded(clearGroupMedia), clearMemberProfiles: guarded(clearMemberProfiles), clearProfileRequestMemos: guarded(clearProfileRequestMemos),
    clearUnread: guarded((id: string) => { clearUnreadGroup(id); clearJoinRequestGroup(id); }),
    clearPendingJoinRequests: guarded(clearPendingJoinRequestsForGroup), clearInviteLinks: guarded(clearInviteLinksForGroup),
    clearInviteExpiries: guarded(clearInviteExpiries), clearPendingDirectInvites: guarded((id: string) => clearPendingDirectInvitesForGroup(id, pubkey)),
    clearSponsorDirectInvites: guarded((id: string) => clearSponsorPendingDirectInvites(pubkey, id)),
    clearInviteContexts: guarded((id: string) => contexts.discard({ groupId: id })),
    removeOverlay: guarded((id: string) => deleteGroup(id, pubkey)),
    markUnloadable: async (id) => {
      const group = await loadGroup(id, pubkey);
      if (group) await saveOverlay({ ...group, accountPubkey: pubkey, unloadable: true });
    },
    onPurged: (id) => { if (!disposed && handle.leaseHeld()) { live.delete(id); liveAdmins.delete(id); hidden.delete(id); joined.delete(id); deps.onJoinRequestsChanged(id); deps.onGroupsChanged(); } },
    onError: (_id, failure) => report(failure.error),
  });
  const purger = { ...rawPurger, purgeLocalGroup: async (...args: Parameters<typeof rawPurger.purgeLocalGroup>) => {
    assertLease();
    const id = args[0];
    purging.set(id, (purging.get(id) ?? 0) + 1);
    try {
      await Promise.allSettled([...overlayWrites.get(id) ?? []]);
      assertLease();
      return await rawPurger.purgeLocalGroup(...args);
    } finally {
      const remaining = (purging.get(id) ?? 1) - 1;
      if (remaining) purging.set(id, remaining); else purging.delete(id);
    }
  } };
  const attachGroup = (group: MarmotGroup, skipOverlay = false) => {
    const id = group.id;
    assertLease();
    releasePollPurgeMark(id);
    live.set(id, group);
    deps.attachGroup(group);
    if (joined.has(id)) return;
    joined.add(id);
    const accepted = enqueue(async () => {
      try {
        if (live.get(id) !== group || !joined.has(id)) return;
        if (!skipOverlay) await syncOverlay(group);
      } catch (error) {
        joined.delete(id);
        throw error;
      }
      if (live.get(id) === group && joined.has(id)) {
        try { deps.onJoined?.(id); } catch (error) { report(error); }
      }
    });
    if (!accepted) joined.delete(id);
  };
  const actions = withInviteContextCleanup({ actions: createInvitationActions({ invitations: client.invitations, view: pendingView, purge: purger, attachGroup, onError: report }), view: pendingView, store: contexts });
  const decline = createDeclineDurability({ store: markers, getGroup, queue, enqueue,
    announce: async (group, content) => { const full = await getGroup(group.id); if (!full) throw new Error('Group missing'); return sender.sendGroupRumor(full, 9, content, []); }, onError: report });
  const lookup = createKeyPackageLookup({ transport: deps.transport, defaultRelays: deps.defaultRelays });
  const baseInviter = createKeyPackageInviter({ lookup, queue });
  const markerInviter = createMarkerRecordingInviter({ inviter: baseInviter, store: markers, onRecordedDeclined: decline.replayMarker, onError: report });
  const inviter = createContextSendingInviter({ inviter: markerInviter, sender: createInviteContextSender({ inbox: client.extensions, ownPubkey: pubkey, now: Date.now, onError: report }), onError: report });
  const autoAccept = createAutoAccept({ accountPubkey: pubkey, assertLease, view: pendingView, actions, enqueue: enqueueInbox, purge: purger,
    outbound: {
      loadUnexpiredForAdmin: loadUnexpiredOutboundJoinRequestsForAdmin,
      claim: guarded(claimOutboundJoinRequest),
      releaseClaim: guarded(releaseOutboundJoinRequestClaim),
      consume: guarded(consumeOutboundJoinRequestClaim),
    },
    groupNameOf: (invitation) => contexts.snapshot().find((c) => c.groupId === invitation.groupId && c.sender === invitation.sponsorAccount.toLowerCase() && c.matched)?.name, onError: report });
  const offContexts = contexts.subscribe(() => { deps.onInvitationsChanged(pendingView.pending()); if (started) autoAccept.evaluate(); });
  const offPending = pendingView.onChange(() => deps.onInvitationsChanged(pendingView.pending()));
  const removal = createGroupRemovalHandlers({ ownPubkey: pubkey, purger, enqueue, onError: (_id, error) => report(error) });
  const disband = createDisbandMarker({ overlay: { load: async (id) => await loadGroup(id, pubkey) as (Group & { [key: string]: unknown }) | undefined, save: async (row) => saveOverlay({ ...row, accountPubkey: pubkey } as Group) }, now: Date.now, onMarked: deps.onGroupsChanged, onError: (_id, error) => report(error) });
  type OverlayRefresh = { force: boolean };
  const syncOverlayNow = async (group: MarmotGroup, refresh?: OverlayRefresh): Promise<Group> => {
    assertLease();
    const id = group.id;
    const previous = await loadGroup(id, pubkey);
    assertLease();
    if (purging.has(id)) throw purgeRace();
    const row: Group = {
      ...previous, id, accountPubkey: pubkey, name: group.name, memberPubkeys: [...group.members()],
      relays: [...group.relays], createdAt: previous?.createdAt ?? Date.now(), unloadable: undefined,
    };
    const admins = JSON.stringify([...group.activeAdmins()].sort());
    const rowChanged = JSON.stringify(row) !== JSON.stringify(previous);
    if (rowChanged) await saveOverlay(row);
    if (!disposed && handle.leaseHeld()) {
      // Admin roles are read from the live handle and are absent from the overlay.
      const previousAdmins = liveAdmins.get(id);
      liveAdmins.set(id, admins);
      live.set(id, group);
      if (rowChanged || (previousAdmins !== undefined && previousAdmins !== admins) || refresh?.force) {
        deps.onGroupsChanged();
      }
    }
    return row;
  };
  const syncOverlay = async (group: MarmotGroup, refresh?: OverlayRefresh): Promise<Group> => {
    assertLease();
    const id = group.id;
    if (purging.has(id)) return Promise.reject(purgeRace());
    const pending = overlayWrites.get(id) ?? new Set<Promise<unknown>>();
    overlayWrites.set(id, pending);
    const work = syncOverlayNow(group, refresh);
    pending.add(work);
    void work.then(() => { pending.delete(work); if (!pending.size) overlayWrites.delete(id); }, () => { pending.delete(work); if (!pending.size) overlayWrites.delete(id); });
    return work;
  };
  const scheduled = new Map<string, OverlayRefresh>();
  const scheduleOverlay = (id: string) => {
    if (scheduled.has(id)) return;
    const refresh = { force: false };
    scheduled.set(id, refresh);
    const accepted = enqueue(async () => {
      try {
        const group = await getGroup(id);
        if (group) await syncOverlay(group, refresh);
      } finally {
        scheduled.delete(id);
      }
    });
    if (!accepted) scheduled.delete(id);
  };
  const route = createGroupNotificationRouter({ members: scheduleOverlay, admins: scheduleOverlay, name: scheduleOverlay, disband: disband.disbandTarget });
  const leaver = createGroupLeaver({ ownPubkey: pubkey, getGroup, queue, purger,
    sendAnnouncement: async (group, kind, content, tags) => { const full = await getGroup(group.id); if (!full) throw new Error('Group missing'); return sender.sendGroupRumor(full, kind, content, tags); },
    hideGroup: (id) => { hidden.add(id); deps.onGroupsChanged(); }, restoreGroup: (id) => { hidden.delete(id); deps.onGroupsChanged(); },
    notifyLeaveFailed: deps.onLeaveFailed, notifyLastAdminBlocked: deps.onLastAdminBlocked, pendingView, ownName: deps.getOwnName });
  const joinSender = createJoinRequestSender({
    inbox: client.extensions,
    ownPubkey: pubkey,
    now: Date.now,
    saveOutbound: guarded(async (record: OutboundJoinRequestRecord) => {
      await saveOutboundJoinRequest({ ...record, accountPubkey: pubkey });
      // An approval and its context can arrive while the request record is saving.
      autoAccept.evaluate();
    }),
    onError: report,
  });
  const consumeRequest = async (request: PendingJoinRequest) => { await guarded(deletePendingJoinRequest)(request.eventId); assertLease(); decrementJoinRequest(request.groupId); deps.onJoinRequestsChanged(request.groupId); };
  const approval = createJoinRequestApproval({ inviter: { inviteByPubkey: async (group, account, options) => { const full = await getGroup(group.id); if (!full) throw new Error('Group missing'); return inviter.inviteByPubkey(full, account, { ...options, viaJoinRequest: true }); } }, getGroup, enqueue, consumeRequest, onApproved: async (request) => {
    await guarded(incrementInviteLinkUsage)(request.nonce);
    if (request.nickname) await guarded(mergeMemberProfile)(request.groupId, { pubkeyHex: request.pubkeyHex, nickname: request.nickname, avatar: null, updatedAt: new Date(0).toISOString(), provisional: true });
    assertLease();
    deps.onGroupsChanged();
  }, onError: report });
  const inboxHandlers = {
    joinRequest: createJoinRequestInboxHandler({
      denyLayer,
      ...joinRequestStorePorts,
      requests: { ...joinRequestStorePorts.requests, save: guarded(joinRequestStorePorts.requests.save), remove: guarded(joinRequestStorePorts.requests.remove) },
      seen: { ...joinRequestStorePorts.seen, add: guarded(joinRequestStorePorts.seen.add) },
      memberPubkeys: (id) => { try { return live.get(id)?.members() ?? []; } catch { return []; } },
      now: Date.now,
      onReceived: (request) => {
        if (disposed || !handle.leaseHeld()) return;
        if (!isActiveView('group', request.groupId)) incrementJoinRequest(request.groupId);
        deps.onJoinRequestsChanged(request.groupId);
      },
      onError: report,
    }),
    inviteContext: createInviteContextHandler({ store: contexts, denyLayer, onError: report }),
  };
  const purgeRemovedMember = async (group: MarmotGroup, account: string, inviteeRef?: string) => {
    try {
      if (group.members().includes(account.toLowerCase())) return;
      const cleanup = [guarded(deleteMemberProfile)(group.id, account)];
      if (inviteeRef) cleanup.push(markers.clearIfRef(group.id, account, inviteeRef).then(() => undefined));
      for (const result of await Promise.allSettled(cleanup)) {
        if (result.status === 'rejected') report(result.reason);
      }
      assertLease();
      deps.onGroupsChanged();
    } catch (error) {
      report(error);
    }
  };
  const requiredGroup = async (id: string) => { const group = await getGroup(id); if (!group) throw new Error(`Group ${id} not found`); return group; };
  return {
    purger, pendingView, contexts, inboxHandlers, hiddenGroups: hidden,
    onInboxDisposition: (event: { readonly kind: string }) => { if (!started) { pendingDisposition = true; return; } pendingView.onInboxDisposition(event); autoAccept.onInboxDisposition(event); },
    onWelcomeDeclined: decline.onWelcomeDeclined, onGroupRemoved: removal.onGroupRemoved,
    onGroupNotification(group: MarmotGroup, notification: GroupNotification) {
      if (disposed || !handle.leaseHeld()) return;
      const id = group.id;
      route(id, notification);
      const refresh = scheduled.get(id);
      if (refresh && notification.type === 'own-change-lost') refresh.force = true;
    },
    syncOverlay: (group: MarmotGroup) => syncOverlay(group),
    listLiveGroupIds: () => [...live.keys()].filter((id) => !hidden.has(id)),
    listLiveGroups: () => [...live.entries()].filter(([id]) => !hidden.has(id)).map(([, group]) => group),
    visibleGroups: (groups: readonly Group[]) => groups.filter((group) => !hidden.has(group.id)),
    async syncListed(groups: readonly MarmotGroup[]) {
      assertLease();
      const snapshot = groups.flatMap((group) => { try { return [{ id: group.id, group }]; } catch { return []; } });
      const removed = new Set(await removal.checkListedGroups(snapshot.map(({ group }) => group)));
      const kept: MarmotGroup[] = [];
      for (const { id, group } of snapshot) {
        if (!handle.leaseHeld() || disposed) return;
        if (removed.has(id) || purging.has(id)) continue;
        try { await syncOverlay(group); kept.push(group); }
        catch (error) {
          // Only suppress a concurrently abandoned handle or a purge in progress.
          if (purging.has(id) || (error as { code?: string })?.code === 'group-purging') continue;
          try { void group.id; } catch { continue; }
          throw error;
        }
      }
      assertLease();
      await disband.syncListed(kept);
    },
    async start() { assertLease(); await pendingView.seed(); assertLease(); await contextBinding.reconcileNow(); assertLease(); started = true; deps.onInvitationsChanged(pendingView.pending()); if (pendingDisposition) pendingView.scheduleRefresh(); decline.startupRetry(); autoAccept.evaluate(); },
    async create(name: string, options?: Parameters<typeof client.groups.create>[1]) { assertLease(); const group = await client.groups.create(name, options); await syncOverlay(group); attachGroup(group, true); return group; },
    async invite(id: string, account: string) {
      const group = await requiredGroup(id);
      const result = await inviter.inviteByPubkey(group, account);
      // The roster can arrive before the invite reference is persisted.
      if ('outcome' in result) await syncOverlay(group, { force: true }).catch(report);
      return result;
    },
    async accept(id: string) {
      assertLease();
      const group = await actions.accept(id, () => { assertLease(); return true; });
      await syncOverlay(group);
      return group;
    },
    async decline(id: string) { assertLease(); await actions.decline(id); },
    async leave(id: string) { assertLease(); return leaver.leave(id); },
    async removeMember(id: string, account: string) {
      const group = await requiredGroup(id);
      const marker = await markers.get(id, account).catch((error) => { report(error); return undefined; });
      await removeMember(queue, group, account, scheduleOverlay);
      await purgeRemovedMember(group, account, marker?.inviteeRef);
    },
    async rename(id: string, name: string) { await renameGroup(queue, await requiredGroup(id), name, scheduleOverlay); },
    async grantAdmin(id: string, account: string) { await grantAdmin(queue, await requiredGroup(id), account, scheduleOverlay); },
    async cancelInvitation(id: string, invitation: { account: string; inviteeRef: string }) {
      const group = await requiredGroup(id);
      const removed = await cancelInvitation(queue, group, invitation, markers, scheduleOverlay);
      if (removed) await purgeRemovedMember(group, invitation.account);
      return removed;
    },
    async sendJoinRequest(params: Parameters<typeof joinSender.send>[0]) { assertLease(); return joinSender.send(params); },
    async approveJoinRequest(request: PendingJoinRequest) { assertLease(); return approval.approve(request); },
    async denyJoinRequest(request: PendingJoinRequest) { assertLease(); await consumeRequest(request); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      contexts.stopExpiry();
      offContexts();
      offPending();
      contextBinding.dispose();
      autoAccept.dispose();
      decline.dispose();
      leaver.dispose();
      pendingView.dispose();
      live.clear();
      liveAdmins.clear();
      await Promise.allSettled(writes);
    },
  };
}
