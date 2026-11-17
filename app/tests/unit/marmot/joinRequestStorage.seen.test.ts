// @vitest-environment node
/**
 * The remembered join-request rumor ids (S12, AC-JOIN-1 / AC-JOIN-5 dedupe by rumor.id) over a REAL idb surface
 * (fake-indexeddb, no idb-keyval mock): membership, idempotent first-write-wins time, the 512 cap that evicts the OLDEST
 * id by its stored time (never by key order), the just-written id surviving a tie, and the account-wide clear.
 * Also the production wiring of the inbox handler over the real idb stores (joinRequestStorePorts).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore, entries, set } from 'idb-keyval';
import type { Rumor } from '@941design/nostr-events/event';
import {
  SEEN_JOIN_REQUEST_CAP,
  clearAllPendingJoinRequests,
  hasSeenJoinRequestRumor,
  loadPendingJoinRequests,
  markJoinRequestRumorSeen,
} from '@/src/lib/marmot/joinRequestStorage';
import { createJoinRequestInboxHandler, joinRequestStorePorts } from '@/src/lib/marmot/joinRequestHandler';
import { buildNewInviteLink, clearAllInviteLinks, saveInviteLink } from '@/src/lib/marmot/inviteLinkStorage';

const seenStore = () => createStore('few-join-request-seen', 'ids');

beforeEach(async () => {
  await clearAllPendingJoinRequests();
  await clearAllInviteLinks();
});

describe('seen rumor ids', () => {
  it('a rumor id is unseen until marked, then seen', async () => {
    expect(await hasSeenJoinRequestRumor('r1')).toBe(false);
    await markJoinRequestRumorSeen('r1', 10);
    expect(await hasSeenJoinRequestRumor('r1')).toBe(true);
    expect(await hasSeenJoinRequestRumor('r2')).toBe(false);
  });

  it('marking again keeps the first time (idempotent)', async () => {
    await markJoinRequestRumorSeen('r1', 10);
    await markJoinRequestRumorSeen('r1', 99);
    expect(await entries<string, number>(seenStore())).toEqual([['r1', 10]]);
  });

  it('evicts the OLDEST ids by stored time when over the cap, whatever the key order', async () => {
    // Seed out of key order and out of time order: key order is a..z, time order is reversed for the first block.
    for (let i = 0; i < SEEN_JOIN_REQUEST_CAP; i++) {
      await set(`k${String(SEEN_JOIN_REQUEST_CAP - i).padStart(4, '0')}`, 1000 + i, seenStore());
    }
    // 'k0512' has time 1000 (the oldest) although it sorts LAST by key.
    await markJoinRequestRumorSeen('newest', 5000);
    const left = await entries<string, number>(seenStore());
    expect(left).toHaveLength(SEEN_JOIN_REQUEST_CAP);
    expect(await hasSeenJoinRequestRumor('k0512')).toBe(false);
    expect(await hasSeenJoinRequestRumor('k0511')).toBe(true);
    expect(await hasSeenJoinRequestRumor('newest')).toBe(true);
  });

  it('never evicts the id just written, even when every time ties', async () => {
    for (let i = 0; i < SEEN_JOIN_REQUEST_CAP; i++) await set(`a${i}`, 7, seenStore());
    await markJoinRequestRumorSeen('zzz-latest', 7);
    expect(await hasSeenJoinRequestRumor('zzz-latest')).toBe(true);
    expect(await entries(seenStore())).toHaveLength(SEEN_JOIN_REQUEST_CAP);
  });

  it('the account-wide clear forgets the seen ids as well as the pending requests', async () => {
    await markJoinRequestRumorSeen('r1', 1);
    await clearAllPendingJoinRequests();
    expect(await hasSeenJoinRequestRumor('r1')).toBe(false);
  });
});

describe('production wiring of the inbox handler over the real idb stores', () => {
  const REQUESTER = 'ab'.repeat(32);
  const rumor = (id: string): Rumor => ({
    id,
    pubkey: REQUESTER,
    kind: 21059,
    created_at: 1,
    tags: [],
    content: JSON.stringify({ type: 'join_request', nonce: 'nonce-x', name: 'Club', requesterName: 'Alice' }),
  });

  it('stores one request, remembers the rumor id, and a replay after the request was deleted does not bring it back', async () => {
    await saveInviteLink(buildNewInviteLink({ groupId: 'group-x', nonce: 'nonce-x', createdAt: Date.now() }));
    const bells: string[] = [];
    const handler = createJoinRequestInboxHandler({
      denyLayer: { isBlocked: () => false },
      ...joinRequestStorePorts,
      memberPubkeys: () => [],
      now: () => Date.now(),
      onReceived: (r) => void bells.push(r.eventId),
    });
    await handler(rumor('rumor-a'), {} as never);
    expect((await loadPendingJoinRequests('group-x')).map((r) => [r.pubkeyHex, r.nickname, r.eventId])).toEqual([[REQUESTER, 'Alice', 'rumor-a']]);
    expect(await hasSeenJoinRequestRumor('rumor-a')).toBe(true);
    const { deletePendingJoinRequest } = await import('@/src/lib/marmot/joinRequestStorage');
    await deletePendingJoinRequest('rumor-a'); // approval consumed it
    await handler(rumor('rumor-a'), {} as never); // library redelivery
    expect(await loadPendingJoinRequests('group-x')).toEqual([]);
    expect(bells).toEqual(['rumor-a']);
  });

  it('600 duplicate requests from one requester do not evict another sender\'s remembered rumor id', async () => {
    await saveInviteLink(buildNewInviteLink({ groupId: 'group-x', nonce: 'nonce-x', createdAt: Date.now() }));
    const handler = createJoinRequestInboxHandler({
      denyLayer: { isBlocked: () => false },
      ...joinRequestStorePorts,
      memberPubkeys: () => [],
      now: () => Date.now(),
      onReceived: () => undefined,
    });
    const other = { ...rumor('rumor-other'), pubkey: 'cd'.repeat(32) };
    await handler(other, {} as never);
    expect(await hasSeenJoinRequestRumor('rumor-other')).toBe(true);
    await handler(rumor('rumor-first'), {} as never);
    for (let i = 0; i < 600; i++) await handler(rumor(`dup-${i}`), {} as never);
    expect(await hasSeenJoinRequestRumor('rumor-other')).toBe(true);
    expect((await entries<string, number>(seenStore())).length).toBe(2);
  });
});

describe('TTL on load (an expired request is pruned, never listed)', () => {
  it('loadPendingJoinRequests deletes expired requests of every group and returns only the live ones of the group', async () => {
    const { putPendingJoinRequest, loadAllPendingJoinRequests } = await import('@/src/lib/marmot/joinRequestStorage');
    const { PENDING_JOIN_REQUEST_TTL_MS } = await import('@/src/lib/marmot/joinRequestTtl');
    const NOW = 1_700_000_000_000;
    const mk = (eventId: string, groupId: string, receivedAt: number) => ({ pubkeyHex: eventId.padEnd(64, '0'), nonce: 'n', groupId, receivedAt, eventId });
    await putPendingJoinRequest(mk('old-a', 'g1', NOW - PENDING_JOIN_REQUEST_TTL_MS));
    await putPendingJoinRequest(mk('live-a', 'g1', NOW - PENDING_JOIN_REQUEST_TTL_MS + 1));
    await putPendingJoinRequest(mk('old-b', 'g2', NOW - PENDING_JOIN_REQUEST_TTL_MS - 5));
    expect((await loadPendingJoinRequests('g1', NOW)).map((r) => r.eventId)).toEqual(['live-a']);
    expect((await loadAllPendingJoinRequests()).map((r) => r.eventId)).toEqual(['live-a']);
  });
});
