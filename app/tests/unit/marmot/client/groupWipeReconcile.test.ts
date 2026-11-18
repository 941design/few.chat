import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { createStore, get, set } from 'idb-keyval';
import { clearAllGroupData } from '@/src/lib/marmot/groupSessionStores';
import { reconcileOverlayGroups } from '@/src/lib/marmot/client/reconcile';
import { createAccountHistoryStore } from '@/src/lib/marmot/history';
import { loadGroup, saveGroup } from '@/src/lib/marmot/groupStorage';
import { createSponsorDeclineMarkerStore } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { createJoinRequestStore } from '@/src/lib/marmot/joinRequestStorage';
import { createInviteLinkStore } from '@/src/lib/marmot/inviteLinkStorage';

async function oweNotice(sponsor: string, groupId: string, ref: string) {
  const store = createSponsorDeclineMarkerStore(sponsor);
  const peer = '45'.repeat(32);
  await store.record(groupId, peer, ref);
  await store.markDeclined(groupId, ref);
  await store.setPhase(groupId, peer, ref, 'announce-pending');
  await store.record(groupId, peer, `${ref}-replacement`);
  return () => store.getDeclined(groupId, peer, ref);
}

describe('group storage wipe', () => {
  it('removes orphaned group data while preserving DM namespaces and other accounts', async () => {
    const dm = 'dm:peer';
    const account = 'ab'.repeat(32);
    const other = 'cd'.repeat(32);
    const pairs: [string, unknown][] = [
      ['few:messages:orphan', ['group']], [`few:messages:${dm}`, ['dm']],
      ['few:polls:orphan', ['group']], [`few:polls:${dm}`, ['dm']],
      ['few:reactions:group:orphan', ['group']], ['few:reactions:dm:peer', ['dm']],
      ['few:reactions:held:group:orphan', []], ['few:reactions:held:dm:peer', ['dm']],
      ['few:messageEditsSlotMeta:v1', [{ threadKey: 'orphan' }, { threadKey: dm }]],
      ['few:messageEditsPinnedRevs:v1', [{ threadKey: 'orphan' }, { threadKey: dm }]],
    ];
    await Promise.all(pairs.map(([key, value]) => set(key, value)));
    const groups = createStore('few-groups-meta', 'groups');
    const profiles = createStore('few-member-profiles', 'profiles');
    const contexts = createStore('few-invite-contexts', 'contexts');
    const blobs = createStore('few-media-blobs', 'blobs');
    const requests = createJoinRequestStore();
    const links = createInviteLinkStore();
    const outbound = createStore('few-outbound-join-requests', 'requests');
    const history = createAccountHistoryStore(account);
    const now = Date.now();
    await Promise.all([
      set('g', { id: 'g' }, groups), set('group:g', ['profile'], profiles),
      set(account, ['context'], contexts), set(other, ['other'], contexts),
      set('orphan:media', 'group', blobs), set('dm:peer:media', 'dm', blobs),
      set('request-event', { groupId: 'orphan', nonce: 'group-link', pubkeyHex: other, eventId: 'request-event', receivedAt: now }, requests),
      set('group-link', { groupId: 'orphan', nonce: 'group-link', createdAt: now, expiresAt: now + 60_000 }, links),
      set('outbound-nonce', { nonce: 'outbound-nonce', adminPubkeyHex: other, groupName: 'Invited group', sentAt: now }, outbound),
      history.nextSeq('g'), createAccountHistoryStore(other).nextSeq('g'),
      history.putRow({
        entry: {
          groupId: 'g', eventId: 'retained',
          rumor: { id: 'rumor', pubkey: account, created_at: 1, kind: 9, tags: [], content: 'group' },
          orderingKey: { account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'digest' },
        },
        seq: 1,
        dispatched: true,
      }),
    ]);
    const keptNotice = await oweNotice(other, 'no-overlay', 'other-ref');
    const wipedNotice = await oweNotice(account, 'no-overlay', 'own-ref');
    await clearAllGroupData(account.toUpperCase());
    expect(await keptNotice()).toMatchObject({ archived: true, marker: { sponsorPubkey: other } });
    expect(await wipedNotice()).toBeUndefined();
    for (const key of ['few:messages:orphan', 'few:polls:orphan', 'few:reactions:group:orphan']) expect(await get(key)).toBeUndefined();
    for (const key of [`few:messages:${dm}`, `few:polls:${dm}`, 'few:reactions:dm:peer', 'few:reactions:held:dm:peer']) expect(await get(key)).toEqual(['dm']);
    expect(await get('few:messageEditsSlotMeta:v1')).toEqual([{ threadKey: dm }]);
    expect(await get('few:messageEditsPinnedRevs:v1')).toEqual([{ threadKey: dm }]);
    expect(await get('g', groups)).toBeUndefined();
    expect(await get('group:g', profiles)).toBeUndefined();
    expect(await get(account, contexts)).toBeUndefined();
    expect(await get(other, contexts)).toEqual(['other']);
    expect(await get('orphan:media', blobs)).toBeUndefined();
    expect(await get('dm:peer:media', blobs)).toBe('dm');
    expect(await get('request-event', requests)).toBeUndefined();
    expect(await get('group-link', links)).toBeUndefined();
    expect(await get('outbound-nonce', outbound)).toBeUndefined();
    expect(await history.listRows('g')).toEqual([]);
    expect(await history.nextSeq('g')).toBe(1);
    expect(await createAccountHistoryStore(other).nextSeq('g')).toBe(2);
  });

  it('keeps separate overlays for two accounts in the same MLS group', async () => {
    const account = '12'.repeat(32);
    const other = '23'.repeat(32);
    const group = { id: 'shared-group', name: 'Shared', createdAt: 1, memberPubkeys: [account, other], relays: [] };
    await saveGroup({ ...group, accountPubkey: account, name: 'First overlay' });
    await saveGroup({ ...group, accountPubkey: other, name: 'Second overlay' });
    await set('few:messages:shared-group', ['still held']);
    const outbound = createStore('few-outbound-join-requests', 'requests');
    const request = { nonce: 'shared-link', adminPubkeyHex: '34'.repeat(32), groupName: 'Invited group', sentAt: Date.now() };
    await set([account, request.nonce], { ...request, accountPubkey: account }, outbound);
    await set([other, request.nonce], { ...request, accountPubkey: other }, outbound);
    expect(await loadGroup(group.id, account)).toMatchObject({ name: 'First overlay' });
    expect(await loadGroup(group.id, other)).toMatchObject({ name: 'Second overlay' });
    const wipedNotice = await oweNotice(account, group.id, 'own-shared-ref');
    const keptNotice = await oweNotice(other, group.id, 'other-shared-ref');
    expect(await wipedNotice()).toMatchObject({ archived: true });

    await clearAllGroupData(account);
    expect(await loadGroup(group.id, account)).toBeUndefined();
    expect(await loadGroup(group.id, other)).toMatchObject({ name: 'Second overlay' });
    expect(await get('few:messages:shared-group')).toEqual(['still held']);
    expect(await get([account, request.nonce], outbound)).toBeUndefined();
    expect(await get([other, request.nonce], outbound)).toMatchObject({ accountPubkey: other });
    expect(await wipedNotice()).toBeUndefined();
    expect(await keptNotice()).toMatchObject({ archived: true, marker: { sponsorPubkey: other } });
  });
});

describe('overlay reconciliation', () => {
  it('purges only absent groups and stops if the lease is lost', async () => {
    let held = true;
    const purgeLocalGroup = vi.fn(async (_groupId: string) => { held = false; });
    const options = { hasLease: () => held, overlayGroups: [{ id: 'live' }, { id: 'stale' }, { id: 'later' }], listedGroups: [{ id: 'live' }], purger: { purgeLocalGroup } };
    await reconcileOverlayGroups(options);
    expect(purgeLocalGroup).toHaveBeenCalledTimes(1);
    expect(purgeLocalGroup).toHaveBeenCalledWith('stale');
    await reconcileOverlayGroups(options);
    expect(purgeLocalGroup).toHaveBeenCalledTimes(1);
    held = true;
    purgeLocalGroup.mockImplementation(async () => {});
    await reconcileOverlayGroups(options);
    expect(purgeLocalGroup.mock.calls.map(([id]) => id)).toEqual(['stale', 'stale', 'later']);
  });
  it('propagates purge errors so startup cannot silently deliver into stale state', async () => {
    const error = new Error('storage');
    await expect(reconcileOverlayGroups({ hasLease: () => true, overlayGroups: [{ id: 'stale' }], listedGroups: [], purger: { purgeLocalGroup: async () => { throw error; } } })).rejects.toBe(error);
  });
});
