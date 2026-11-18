import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { createJobQueue } from '@/src/lib/marmot/client/fifo';
import { createGroupSessionMembership } from '@/src/lib/marmot/groupSessionMembership';
import { createSponsorDeclineMarkerStore, pendingDirectInviteMarkerStore, recordPendingDirectInvite } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { loadGroup, saveGroup } from '@/src/lib/marmot/groupStorage';
import * as groupStorage from '@/src/lib/marmot/groupStorage';
import * as outbound from '@/src/lib/marmot/outboundJoinRequests';
import * as inviteLinks from '@/src/lib/marmot/inviteLinkStorage';
import { get, set } from 'idb-keyval';
import { joinRequestStorePorts, JOIN_REQUEST_KIND } from '@/src/lib/marmot/joinRequestHandler';
import { loadMessages } from '@/src/lib/marmot/chatPersistence';
import { loadPolls, savePoll, releasePollPurgeMark } from '@/src/lib/marmot/pollPersistence';
import { loadPendingDirectInviteMarkers } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { loadMemberProfiles, mergeMemberProfile } from '@/src/lib/marmot/groupStorage';
import { createIdbInviteContextPort } from '@/src/lib/marmot/inviteContextIdbPort';
import type { GroupSessionMembershipDeps } from '@/src/lib/marmot/groupSessionMembership';

function setup(own = 'ab'.repeat(32)) {
  const jobs = createJobQueue();
  let leased = true;
  const group = { id: 'group-1', name: 'First', members: () => [own], activeAdmins: () => [own], relays: ['wss://relay.example'], synced: async () => {}, rename: vi.fn(async (name: string) => { group.name = name; }), abandon: vi.fn(async () => {}), leave: vi.fn(async () => {}), leaves: () => [], invite: vi.fn(), removeMember: vi.fn(), setAdmins: vi.fn() };
  const pending = vi.fn(async () => []);
  const deps = {
    handle: { pubkey: own, leaseHeld: () => leased, enqueue: jobs.enqueue, client: { groups: { get: async (id: string) => id === group.id ? group : undefined, create: async () => group }, invitations: { pending, accept: async () => group, decline: async () => {} }, extensions: { sendInboxRumor: async () => ({ status: 'delivered' }) } } },
    transport: { requestWithDeadline: vi.fn() }, defaultRelays: ['wss://relay.example'], history: { purge: vi.fn(async () => {}) }, sender: { forgetGroup: vi.fn(), sendGroupRumor: vi.fn(async () => ({ id: 'x', result: undefined })) },
    attachGroup: vi.fn(), onJoined: vi.fn(), onGroupsChanged: vi.fn(), onInvitationsChanged: vi.fn(), onJoinRequestsChanged: vi.fn(), onLeaveFailed: vi.fn(), onLastAdminBlocked: vi.fn(), onError: vi.fn(),
  } as unknown as GroupSessionMembershipDeps;
  return { session: createGroupSessionMembership(deps), deps, group, pending, jobs, loseLease: () => { leased = false; } };
}

describe('group session membership composition', () => {
  it.each([
    { cause: 'stale', otherOwner: true },
    { cause: 'removal', otherOwner: true },
    { cause: 'absent without another owner', otherOwner: false },
  ])('purges account state for $cause while respecting other overlays', async ({ cause, otherOwner }) => {
    const { session, deps, group, jobs } = setup();
    group.id = `purge-${cause}`;
    const own = deps.handle.pubkey;
    const other = 'cd'.repeat(32);
    const row = { id: group.id, name: 'Group', memberPubkeys: [], relays: [], createdAt: 1 };
    await saveGroup({ ...row, accountPubkey: own });
    if (otherOwner) await saveGroup({ ...row, accountPubkey: other });
    await set(`few:messages:${group.id}`, [{ id: 'message', content: 'keep' }]);
    releasePollPurgeMark(group.id);
    await savePoll({ id: 'poll', groupId: group.id, title: 'Question', options: [], pollType: 'singlechoice', creatorPubkey: other, createdAt: 1, closed: false });
    await mergeMemberProfile(group.id, { pubkeyHex: other, nickname: 'Bob', avatar: null, updatedAt: '2026-01-01' });
    await inviteLinks.saveInviteLink({ nonce: group.id, groupId: group.id, createdAt: 1, expiresAt: Date.now() + 100000, usageCount: 0, expiryNotified: false, expiryAcknowledged: false, muted: false });
    await recordPendingDirectInvite(group.id, other, 'ref');
    const sponsor = createSponsorDeclineMarkerStore(own);
    const invitee = 'ef'.repeat(32);
    await sponsor.record(group.id, invitee, 'owed-ref');
    await sponsor.markDeclined(group.id, 'owed-ref');
    await sponsor.setPhase(group.id, invitee, 'owed-ref', 'announce-pending');
    await sponsor.record(group.id, invitee, 'next-ref');
    await session.contexts.add({ rumorId: `own-${group.id}`, sender: other, groupId: group.id, name: 'Own' });
    const otherContext = { rumorId: `other-${group.id}`, sender: own, groupId: group.id, name: 'Other', receivedAt: Date.now() };
    const otherPort = createIdbInviteContextPort(other);
    await otherPort.save([otherContext as never]);
    expect(session.contexts.snapshot().filter((c) => c.groupId === group.id)).toHaveLength(1);
    expect((await loadMessages(group.id)).messages).toHaveLength(1);
    expect(await loadPolls(group.id)).toHaveLength(1);
    expect(await loadMemberProfiles(group.id)).toHaveLength(1);
    expect(await inviteLinks.loadInviteLinks(group.id)).toHaveLength(1);
    expect(await loadPendingDirectInviteMarkers(group.id)).toHaveLength(2);
    if (cause === 'removal') {
      group.members = () => [other];
      deps.handle.client.groups.get = vi.fn().mockResolvedValueOnce(group).mockResolvedValue(undefined);
    } else {
      deps.handle.client.groups.get = vi.fn().mockResolvedValue(undefined);
    }
    await session.purger.purgeLocalGroup(group.id);
    expect(deps.history.purge).toHaveBeenCalledWith(group.id);
    expect(deps.sender.forgetGroup).toHaveBeenCalledWith(group.id);
    expect(group.abandon).toHaveBeenCalledTimes(cause === 'removal' ? 1 : 0);
    expect(await loadGroup(group.id, own)).toBeUndefined();
    expect(await loadGroup(group.id, other)).toEqual(otherOwner ? { ...row, accountPubkey: other } : undefined);
    expect((await loadMessages(group.id)).messages).toHaveLength(otherOwner ? 1 : 0);
    expect(await loadPolls(group.id)).toHaveLength(otherOwner ? 1 : 0);
    expect(await loadMemberProfiles(group.id)).toHaveLength(otherOwner ? 1 : 0);
    expect(await inviteLinks.loadInviteLinks(group.id)).toHaveLength(otherOwner ? 1 : 0);
    expect(await loadPendingDirectInviteMarkers(group.id)).toHaveLength(otherOwner ? 1 : 0);
    expect(await sponsor.listDeclined()).toEqual([]);
    expect(session.contexts.snapshot().filter((c) => c.groupId === group.id)).toEqual([]);
    expect(await otherPort.load()).toEqual([otherContext]);
    await session.dispose(); jobs.dispose();
  });

  it('retains shared data and the retry overlay if checking other owners fails', async () => {
    const { session, deps, group, jobs } = setup();
    group.id = 'ownership-check-failure';
    await saveGroup({ id: group.id, accountPubkey: deps.handle.pubkey, name: 'Retry', memberPubkeys: [], relays: [], createdAt: 1 });
    await set(`few:messages:${group.id}`, [{ id: 'keep' }]);
    deps.handle.client.groups.get = vi.fn().mockResolvedValue(undefined);
    const check = vi.spyOn(groupStorage, 'hasOtherGroupOwner').mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await expect(session.purger.purgeLocalGroup(group.id)).rejects.toMatchObject({ failures: [{ step: 'other-owner' }] });
      expect((await loadMessages(group.id)).messages).toHaveLength(1);
      expect(await loadGroup(group.id, deps.handle.pubkey)).toMatchObject({ name: 'Retry' });
      expect(deps.history.purge).toHaveBeenCalledWith(group.id);
    } finally {
      check.mockRestore(); await session.dispose(); jobs.dispose();
    }
  });

  it('seeds before routing pre-start dispositions and creates and renames an overlay', async () => {
    const { session, deps, group, pending, jobs } = setup();
    session.onInboxDisposition({ kind: 'pending' });
    expect(pending).not.toHaveBeenCalled();
    await session.start();
    await jobs.idle();
    expect(pending).toHaveBeenCalled();
    expect(deps.onInvitationsChanged).toHaveBeenCalledWith([]);
    await session.create('First');
    await jobs.idle();
    expect(deps.attachGroup).toHaveBeenCalledWith(group);
    expect(deps.onJoined).toHaveBeenCalledTimes(1);
    expect(deps.onJoined).toHaveBeenCalledWith(group.id);
    await session.create('First');
    await jobs.idle();
    expect(deps.onJoined).toHaveBeenCalledTimes(1);
    expect((await loadGroup(group.id, deps.handle.pubkey))?.name).toBe('First');
    await session.rename(group.id, 'Renamed');
    await jobs.idle();
    expect((await loadGroup(group.id, deps.handle.pubkey))?.name).toBe('Renamed');
    session.dispose(); jobs.dispose();
  });
  it('updates invitation cards for context changes and preserves cancellation result', async () => {
    const { session, deps, group, jobs } = setup();
    await session.start();
    const before = vi.mocked(deps.onInvitationsChanged).mock.calls.length;
    await session.contexts.add({ rumorId: 'context-1', sender: 'cd'.repeat(32), groupId: 'context-group', name: 'Name' });
    expect(vi.mocked(deps.onInvitationsChanged).mock.calls.length).toBeGreaterThan(before);
    const peer = 'ef'.repeat(32);
    const foreign = createSponsorDeclineMarkerStore('23'.repeat(32));
    await foreign.record(group.id, peer, 'foreign-ref');
    expect(await session.cancelInvitation(group.id, { account: peer, inviteeRef: 'foreign-ref' })).toBe(false);
    expect(await foreign.get(group.id, peer)).toMatchObject({ inviteeRef: 'foreign-ref' });
    await createSponsorDeclineMarkerStore(deps.handle.pubkey).record(group.id, peer, 'current-ref');
    expect(await session.cancelInvitation(group.id, { account: peer, inviteeRef: 'old-ref' })).toBe(false);
    expect(group.removeMember).not.toHaveBeenCalled();
    expect(await session.cancelInvitation(group.id, { account: peer, inviteeRef: 'current-ref' })).toBe(true);
    expect(group.removeMember).toHaveBeenCalledOnce();
    session.dispose(); jobs.dispose();
  });

  it('startup replays and acknowledges only the current sponsor’s notice in a shared group', async () => {
    const first = setup();
    const second = setup('23'.repeat(32));
    const id = 'decline-with-two-sponsors';
    first.group.id = second.group.id = id;
    const peer = '45'.repeat(32);
    const firstStore = createSponsorDeclineMarkerStore(first.deps.handle.pubkey);
    const secondStore = createSponsorDeclineMarkerStore(second.deps.handle.pubkey);
    for (const [store, ref] of [[firstStore, 'first-ref'], [secondStore, 'second-ref'], [pendingDirectInviteMarkerStore, 'ownerless-ref']] as const) {
      await store.record(id, peer, ref);
      await store.markDeclined(id, ref);
      await store.setPhase(id, peer, ref, 'announce-pending');
      await store.record(id, peer, `${ref}-replacement`);
    }
    const ownerlessLive = '89'.repeat(32);
    await recordPendingDirectInvite(id, ownerlessLive, 'ownerless-live');
    await pendingDirectInviteMarkerStore.markDeclined(id, 'ownerless-live');
    await pendingDirectInviteMarkerStore.setPhase(id, ownerlessLive, 'ownerless-live', 'announce-pending');

    const firstNotice = await firstStore.getDeclined(id, peer, 'first-ref');
    expect(firstNotice).toMatchObject({ archived: true });
    expect(await secondStore.getDeclined(id, peer, 'first-ref')).toBeUndefined();
    expect(await secondStore.clearAnnouncement(id, firstNotice!)).toBe(false);
    expect(await secondStore.getDeclined(id, peer, 'ownerless-ref')).toBeUndefined();
    expect(await secondStore.getDeclined(id, ownerlessLive, 'ownerless-live')).toBeUndefined();

    for (const [account, store, ref] of [[first, firstStore, 'first-ref'], [second, secondStore, 'second-ref']] as const) {
      await account.session.start();
      await account.jobs.idle();
      await expect.poll(() => store.listDeclined()).toEqual([]);
      expect(account.deps.sender.sendGroupRumor).toHaveBeenCalledExactlyOnceWith(account.group, 9,
        JSON.stringify({ type: 'invite_lifecycle', event: 'declined', pubkey: peer, id: `${id}:${ref}` }), []);
      expect(account.group.removeMember).not.toHaveBeenCalled();
      await account.session.dispose();
      account.jobs.dispose();
    }
    expect(await pendingDirectInviteMarkerStore.getDeclined(id, peer, 'ownerless-ref')).toBeDefined();
    expect(await pendingDirectInviteMarkerStore.getDeclined(id, ownerlessLive, 'ownerless-live')).toBeDefined();
    await pendingDirectInviteMarkerStore.clearIfRef(id, ownerlessLive, 'ownerless-live');
  });
  it('aborts a purge when the lease is lost during group lookup', async () => {
    const { session, deps, group, loseLease, jobs } = setup();
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    deps.handle.client.groups.get = vi.fn(async () => { started(); await wait; return undefined; });
    const purge = session.purger.purgeLocalGroup(group.id);
    await begun;
    loseLease();
    release();
    await expect(purge).rejects.toMatchObject({ unloadable: false, failures: [{ step: 'get-group', error: { code: 'disposed' } }] });
    expect(deps.history.purge).not.toHaveBeenCalled();
    expect(deps.sender.forgetGroup).not.toHaveBeenCalled();
    session.dispose(); jobs.dispose();
  });
  it('does not start app-store deletion when lease is lost during the rejoin check', async () => {
    const { session, deps, group, loseLease, jobs } = setup();
    await saveGroup({ id: group.id, accountPubkey: deps.handle.pubkey, name: 'Kept', memberPubkeys: [], relays: [], createdAt: 1 });
    group.name = 'Kept'; // any queued overlay refresh must preserve the fixture
    await set(`few:messages:${group.id}`, ['keep']);
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    deps.handle.client.groups.get = vi.fn(async () => { if (++calls === 2) { started(); await wait; } return undefined; });
    const purge = session.purger.purgeLocalGroup(group.id);
    await begun;
    loseLease(); release();
    await expect(purge).rejects.toMatchObject({ unloadable: false });
    expect(await get(`few:messages:${group.id}`)).toEqual(['keep']);
    expect(await loadGroup(group.id, deps.handle.pubkey)).toMatchObject({ name: 'Kept' });
    session.dispose(); jobs.dispose();
  });
  it('refuses writes and reconciliation without the lease', async () => {
    const { session, group, loseLease, jobs } = setup();
    loseLease();
    await expect(session.create('x')).rejects.toThrow('not writable');
    await expect(session.syncOverlay(group as never)).rejects.toThrow('not writable');
    await expect(session.purger.purgeLocalGroup(group.id)).rejects.toThrow('not writable');
    session.onGroupRemoved({ groupId: group.id });
    await jobs.idle();
    expect(group.abandon).not.toHaveBeenCalled();
    session.dispose(); jobs.dispose();
  });
  it('lists surviving ids without reading group handles again', async () => {
    const { session, group, jobs } = setup();
    await session.syncListed([group as never]);
    Object.defineProperty(group, 'id', { get: () => { throw new Error('not-a-member'); } });
    expect(session.listLiveGroupIds()).toEqual(['group-1']);
    await session.dispose(); jobs.dispose();
  });

  it('drains an inbox save and fences subsequent seen writes during disposal', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const get = vi.spyOn(joinRequestStorePorts.inviteLinks, 'get').mockResolvedValue({ groupId: 'group-1', muted: false, createdAt: Date.now(), expiresAt: Date.now() + 100000 } as never);
    const has = vi.spyOn(joinRequestStorePorts.seen, 'has').mockResolvedValue(false);
    const add = vi.spyOn(joinRequestStorePorts.seen, 'add').mockResolvedValue();
    const load = vi.spyOn(joinRequestStorePorts.requests, 'loadAll').mockResolvedValue([]);
    const save = vi.spyOn(joinRequestStorePorts.requests, 'save').mockImplementation(async () => { started(); await pending; });
    const { session, jobs } = setup();
    const handling = Promise.resolve(session.inboxHandlers.joinRequest({ kind: JOIN_REQUEST_KIND, id: 'rumor', pubkey: 'cd'.repeat(32), content: JSON.stringify({ type: 'join_request', nonce: 'n', name: 'name' }) } as never, {} as never));
    await begun;
    let done = false;
    const disposal = session.dispose().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await handling;
    await disposal;
    expect(add).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    jobs.dispose();
    get.mockRestore(); has.mockRestore(); add.mockRestore(); load.mockRestore(); save.mockRestore();
  });

  it('drains an outbound record write before releasing the session', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(outbound, 'saveOutboundJoinRequest').mockImplementation(async () => { started(); await pending; });
    const { session, jobs } = setup();
    const sending = session.sendJoinRequest({ adminPubkeyHex: 'cd'.repeat(32), nonce: 'drain', groupName: 'Group' });
    await begun;
    let done = false;
    const disposal = session.dispose().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await sending;
    await disposal;
    save.mockRestore(); jobs.dispose();
  });

  it('does not persist an outbound record when delivery finishes after disposal', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(outbound, 'saveOutboundJoinRequest');
    const { session, deps, jobs } = setup();
    deps.handle.client.extensions.sendInboxRumor = vi.fn(async () => { started(); await pending; return { status: 'delivered' as const }; });
    const sending = session.sendJoinRequest({ adminPubkeyHex: 'cd'.repeat(32), nonce: 'late', groupName: 'Group' });
    await begun;
    await session.dispose();
    release();
    await sending;
    expect(save).not.toHaveBeenCalled();
    save.mockRestore(); jobs.dispose();
  });

  it('drains an approval profile write during disposal', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const merge = vi.spyOn(groupStorage, 'mergeMemberProfile').mockImplementation(async () => { started(); await pending; return true; });
    const { session, group, jobs } = setup();
    group.leaves = () => [1] as never[];
    const approval = session.approveJoinRequest({ eventId: 'approval', groupId: group.id, pubkeyHex: 'cd'.repeat(32), nonce: 'approval', nickname: 'Alice', receivedAt: Date.now() });
    await begun;
    let done = false;
    const disposal = session.dispose().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await approval;
    await disposal;
    merge.mockRestore(); jobs.dispose();
  });

  it('finishes an overlay sync before a concurrent removal purges it', async () => {
    const { session, deps, group, jobs } = setup();
    const realLoad = groupStorage.loadGroup;
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const load = vi.spyOn(groupStorage, 'loadGroup').mockImplementation(async (id) => {
      if (first) { first = false; started(); await pending; }
      return realLoad(id);
    });
    let abandoned = false;
    const id = group.id;
    group.members = () => abandoned ? [] : [deps.handle.pubkey];
    group.abandon = vi.fn(async () => { abandoned = true; });
    deps.handle.client.groups.get = vi.fn(async () => abandoned ? undefined : group as never);
    const sync = session.syncListed([group as never]);
    await begun;
    group.members = () => [];
    let purgeStarted!: () => void;
    const purgeBegun = new Promise<void>((resolve) => { purgeStarted = resolve; });
    deps.handle.enqueue = (job) => jobs.enqueue(async () => { purgeStarted(); await job(); });
    session.onGroupRemoved({ groupId: id });
    await purgeBegun;
    release();
    await sync;
    await jobs.idle();
    expect(await realLoad(id)).toBeUndefined();
    expect(session.listLiveGroupIds()).not.toContain(id);
    load.mockRestore(); await session.dispose(); jobs.dispose();
  });

  it('skips a listed handle already abandoned before reconciliation', async () => {
    const { session, group, jobs } = setup();
    Object.defineProperty(group, 'id', { get: () => { throw new Error('not-a-member'); } });
    await expect(session.syncListed([group as never])).resolves.toBeUndefined();
    expect(session.listLiveGroupIds()).toEqual([]);
    await session.dispose(); jobs.dispose();
  });

  it('fences approval profile persistence after disposal during invite usage', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const usage = vi.spyOn(inviteLinks, 'incrementInviteLinkUsage').mockImplementation(async () => { started(); await pending; });
    const merge = vi.spyOn(groupStorage, 'mergeMemberProfile');
    const { session, group, jobs } = setup();
    group.leaves = () => [1] as never[];
    const approval = session.approveJoinRequest({ eventId: 'late-approval', groupId: group.id, pubkeyHex: 'cd'.repeat(32), nonce: 'late-approval', nickname: 'Alice', receivedAt: Date.now() });
    await begun;
    const disposal = session.dispose();
    release();
    await approval;
    await disposal;
    expect(merge).not.toHaveBeenCalled();
    usage.mockRestore(); merge.mockRestore(); jobs.dispose();
  });

});
