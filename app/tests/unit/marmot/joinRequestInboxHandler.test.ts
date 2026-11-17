// @vitest-environment node
/**
 * Unit tests for the join-request INBOX handler (S12): AC-JOIN-1 (requester only from `rumor.pubkey`, dedupe by
 * `rumor.id`, persist and return), AC-JOIN-5 (nonce, mute, expiry, dedup unchanged: a replay with the same `rumor.id` or
 * a muted requester produces no new entry), AC-BLK-1 join-request leg (a blocked sender: nothing stored, no bell, no seen
 * mark) and the inbox-handler re-entrancy rule (no client call).
 *
 * The handler runs over in-memory ports (the idb adapters are covered by joinRequestStorage.seen.test.ts and the
 * production-wiring test below), so every drop path is observed on the ports, not on a stub of the handler.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Rumor } from '@941design/nostr-events/event';
import {
  createJoinRequestInboxHandler,
  JOIN_REQUEST_KIND,
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
  PENDING_JOIN_REQUEST_TTL_MS,
} from '@/src/lib/marmot/joinRequestHandler';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';
import { createDenyLayer } from '@/src/lib/marmot/invitations';
import { MAX_NAME_BYTES } from '@/src/lib/contactCard';

const REQUESTER = 'ab'.repeat(32);
const SPOOF = 'cd'.repeat(32);
const GROUP = 'ef'.repeat(32);
const NOW = 1_700_000_000_000;

const link = (over: Record<string, unknown> = {}) => ({ nonce: 'n1', groupId: GROUP, createdAt: NOW - 1000, expiresAt: NOW + 86_400_000, usageCount: 0, expiryNotified: false, expiryAcknowledged: false, muted: false, ...over });

const rumor = (over: Partial<Rumor> & { nonce?: string; name?: string; requesterName?: unknown; content?: string } = {}): Rumor => ({
  id: over.id ?? 'rumor-1',
  pubkey: over.pubkey ?? REQUESTER,
  kind: over.kind ?? JOIN_REQUEST_KIND,
  created_at: 1,
  tags: [],
  content: over.content ?? JSON.stringify({ type: 'join_request', nonce: over.nonce ?? 'n1', name: over.name ?? 'Club', requesterName: over.requesterName }),
});

function setup(opts: { links?: Record<string, ReturnType<typeof link>>; members?: string[]; blocked?: string[]; saveFails?: boolean; seenAddFails?: boolean; preload?: PendingJoinRequest[]; order?: string[] } = {}) {
  const links = opts.links ?? { n1: link() };
  const store: PendingJoinRequest[] = [...(opts.preload ?? [])];
  const seen = new Set<string>();
  const bells: PendingJoinRequest[] = [];
  const errors: unknown[] = [];
  const blocked = new Set(opts.blocked ?? []);
  const calls: string[] = [];
  const handler = createJoinRequestInboxHandler({
    denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }),
    inviteLinks: { get: async (nonce) => { calls.push(`link:${nonce}`); return links[nonce] as never; } },
    memberPubkeys: () => opts.members ?? [],
    requests: {
      loadAll: async () => [...store],
      save: async (r) => { calls.push('save'); if (opts.saveFails) throw new Error('idb down'); store.push(r); },
      remove: async (id) => void store.splice(0, store.length, ...store.filter((r) => r.eventId !== id)),
    },
    seen: { has: async (id) => seen.has(id), add: async (id) => { opts.order?.push('seen'); if (opts.seenAddFails) throw new Error('seen down'); seen.add(id); } },
    now: () => NOW,
    onReceived: (r) => { opts.order?.push('bell'); bells.push(r); },
    onError: (e) => void errors.push(e),
  });
  return { handler, store, seen, bells, errors, blocked, calls };
}

const wrap = {} as never;

describe('AC-JOIN-1: take the requester from rumor.pubkey, dedupe by rumor.id, persist and return', () => {
  it('stores one pending request with the delivered rumor.pubkey, the link\'s group, the nonce and the rumor id; rings once', async () => {
    const t = setup();
    await t.handler(rumor({ requesterName: 'Alice' }), wrap);
    expect(t.store).toEqual([{ pubkeyHex: REQUESTER, nonce: 'n1', groupId: GROUP, receivedAt: NOW, nickname: 'Alice', eventId: 'rumor-1' }]);
    expect(t.bells).toHaveLength(1);
    expect(t.seen.has('rumor-1')).toBe(true);
    expect(t.errors).toEqual([]);
  });

  it('takes the requester ONLY from rumor.pubkey: no content field can name another requester', async () => {
    const t = setup();
    await t.handler(rumor({ content: JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Club', pubkey: SPOOF, pubkeyHex: SPOOF, requester: SPOOF, requesterPubkey: SPOOF }) }), wrap);
    expect(t.store.map((r) => r.pubkeyHex)).toEqual([REQUESTER]);
  });

  it('lowercases the sender (the store and the approval work on lowercase hex)', async () => {
    const t = setup();
    await t.handler(rumor({ pubkey: REQUESTER.toUpperCase() }), wrap);
    expect(t.store.map((r) => r.pubkeyHex)).toEqual([REQUESTER]);
  });

  it('replaying the same rumor.id produces no new entry and no second bell', async () => {
    const t = setup();
    await t.handler(rumor(), wrap);
    await t.handler(rumor(), wrap);
    expect(t.store).toHaveLength(1);
    expect(t.bells).toHaveLength(1);
  });

  it('a replay after the request was consumed (approved) does not bring it back: the rumor id is remembered', async () => {
    const t = setup();
    await t.handler(rumor(), wrap);
    t.store.length = 0; // approval consumed the request; the requester is not (yet) a visible member in the roster cache
    await t.handler(rumor(), wrap);
    expect(t.store).toEqual([]);
    expect(t.bells).toHaveLength(1);
  });

  it('a second rumor of the same requester and group is a duplicate (one pending entry), even with another rumor id', async () => {
    const t = setup();
    await t.handler(rumor({ id: 'r1' }), wrap);
    await t.handler(rumor({ id: 'r2' }), wrap);
    expect(t.store).toHaveLength(1);
    expect(t.bells).toHaveLength(1);
    expect(t.seen.has('r2')).toBe(false); // a duplicate is NOT remembered: a flood must not evict other senders' ids
  });

  it('caps an attacker-chosen requester name on receive', async () => {
    const t = setup();
    await t.handler(rumor({ requesterName: 'x'.repeat(10_000) }), wrap);
    expect(new TextEncoder().encode(t.store[0].nickname ?? '').length).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});

describe('AC-JOIN-5: nonce, mute, expiry and dedup are unchanged', () => {
  it.each([
    ['an unknown nonce', { links: {} }],
    ['a muted link', { links: { n1: link({ muted: true }) } }],
    ['an expired link', { links: { n1: link({ expiresAt: NOW - 1 }) } }],
    ['a legacy link without expiresAt older than a day', { links: { n1: link({ expiresAt: undefined, createdAt: NOW - 2 * 86_400_000 }) } }],
    ['a requester who is already a member', { members: [REQUESTER] }],
  ] as const)('%s: no entry, no bell', async (_name, opts) => {
    const t = setup(opts as never);
    await t.handler(rumor(), wrap);
    expect(t.store).toEqual([]);
    expect(t.bells).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a wrong type', JSON.stringify({ type: 'other', nonce: 'n1', name: 'Club' })],
    ['a missing nonce', JSON.stringify({ type: 'join_request', name: 'Club' })],
    ['a non-string nonce', JSON.stringify({ type: 'join_request', nonce: 7, name: 'Club' })],
    ['an array', '[]'],
  ])('malformed content (%s) is dropped silently', async (_n, content) => {
    const t = setup();
    await t.handler(rumor({ content }), wrap);
    expect(t.store).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it('a wrong kind or a malformed sender is dropped (defence in depth over the registry routing)', async () => {
    const t = setup();
    await t.handler(rumor({ kind: 1 }), wrap);
    await t.handler(rumor({ pubkey: 'not-hex' }), wrap);
    await t.handler(rumor({ pubkey: '' }), wrap);
    await t.handler(rumor({ id: '' }), wrap);
    expect(t.store).toEqual([]);
    expect(t.calls).toEqual([]); // nothing was even looked up
  });
});

describe('AC-BLK-1 (join-request leg): a blocked sender is dropped before anything is stored or rung', () => {
  it('stores nothing, rings no bell, does not even look the link up and does not mark the rumor seen', async () => {
    const t = setup({ blocked: [REQUESTER] });
    await t.handler(rumor(), wrap);
    expect(t.store).toEqual([]);
    expect(t.bells).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.seen.size).toBe(0);
  });

  it('the block set is read on every arrival: a block placed after construction applies to the next rumor', async () => {
    const t = setup();
    await t.handler(rumor({ id: 'r1', pubkey: SPOOF }), wrap);
    expect(t.store).toHaveLength(1);
    t.blocked.add(SPOOF);
    await t.handler(rumor({ id: 'r2', pubkey: SPOOF, nonce: 'n1' }), wrap);
    expect(t.bells).toHaveLength(1);
  });

  it('matches the block case-insensitively', async () => {
    const t = setup({ blocked: [REQUESTER] });
    await t.handler(rumor({ pubkey: REQUESTER.toUpperCase() }), wrap);
    expect(t.store).toEqual([]);
  });
});

describe('inbox-handler discipline', () => {
  it('a storage failure is reported AND rethrown so the library defers and redelivers the wrap; no bell', async () => {
    const t = setup({ saveFails: true });
    await expect(t.handler(rumor(), wrap)).rejects.toThrow('idb down');
    expect(t.bells).toEqual([]);
    expect(t.seen.size).toBe(0);
    expect(t.errors).toHaveLength(1);
  });

  it('a throwing bell never fails the handler (the request is already stored)', async () => {
    const t = setup();
    const errors: unknown[] = [];
    const handler = createJoinRequestInboxHandler({
      denyLayer: { isBlocked: () => false },
      inviteLinks: { get: async () => link() as never },
      memberPubkeys: () => [],
      requests: { loadAll: async () => [], save: async (r) => void t.store.push(r), remove: async () => undefined },
      seen: { has: async () => false, add: async () => undefined },
      now: () => NOW,
      onReceived: () => { throw new Error('bell'); },
      onError: (e) => void errors.push(e),
    });
    await expect(handler(rumor(), wrap)).resolves.toBeUndefined();
    expect(t.store).toHaveLength(1);
    expect(errors.map((e) => (e as Error).message)).toEqual(['bell']);
  });

  it('is exactly the registered kind: JOIN_REQUEST_KIND is APP_INBOX_KINDS.joinRequest', async () => {
    const { APP_INBOX_KINDS } = await import('@/src/lib/marmot/kinds');
    expect(JOIN_REQUEST_KIND).toBe(APP_INBOX_KINDS.joinRequest);
  });
});

describe('construction validates every required port (no silent degradation)', () => {
  const full = () => ({
    denyLayer: { isBlocked: () => false },
    inviteLinks: { get: async () => undefined },
    memberPubkeys: () => [] as string[],
    requests: { loadAll: async () => [], save: async () => undefined, remove: async () => undefined },
    seen: { has: async () => false, add: async () => undefined },
    now: () => 0,
    onReceived: () => undefined,
  });
  it.each(['denyLayer', 'inviteLinks', 'memberPubkeys', 'requests', 'seen', 'now', 'onReceived'] as const)('throws when %s is missing', (key) => {
    const deps = full() as Record<string, unknown>;
    delete deps[key];
    expect(() => createJoinRequestInboxHandler(deps as never)).toThrow(TypeError);
  });
  it('throws when a port is present but a method is missing', () => {
    const deps = full() as Record<string, unknown>;
    deps.requests = { loadAll: async () => [] };
    expect(() => createJoinRequestInboxHandler(deps as never)).toThrow(TypeError);
  });
  it('throws without dependencies', () => {
    expect(() => createJoinRequestInboxHandler(undefined as never)).toThrow(TypeError);
  });
});

describe('the handler is a pure function of its ports (vi spy sanity)', () => {
  it('does not call onReceived for a dropped rumor', async () => {
    const onReceived = vi.fn();
    const handler = createJoinRequestInboxHandler({
      denyLayer: { isBlocked: () => false },
      inviteLinks: { get: async () => undefined },
      memberPubkeys: () => [],
      requests: { loadAll: async () => [], save: async () => undefined, remove: async () => undefined },
      seen: { has: async () => false, add: async () => undefined },
      now: () => NOW,
      onReceived,
    });
    await handler(rumor(), wrap);
    expect(onReceived).not.toHaveBeenCalled();
  });
});

describe('bounded pending requests (flood of throwaway requesters)', () => {
  const key = (i: number) => i.toString(16).padStart(64, '0');
  const groupOf = (g: number) => g.toString(16).padStart(64, 'e');
  const stored = (i: number, groupId: string, receivedAt: number): PendingJoinRequest => ({ pubkeyHex: key(i), nonce: 'n1', groupId, receivedAt, eventId: `old-${groupId.slice(-2)}-${i}` });

  it('pins the limits', () => {
    expect(MAX_PENDING_JOIN_REQUESTS_PER_GROUP).toBe(50);
    expect(PENDING_JOIN_REQUEST_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('a flood of distinct requesters into one group stores only the per-group cap, silently (no bell, no error, no seen mark beyond)', async () => {
    const t = setup();
    for (let i = 1; i <= MAX_PENDING_JOIN_REQUESTS_PER_GROUP + 30; i++) await t.handler(rumor({ id: `r${i}`, pubkey: key(i) }), wrap);
    expect(t.store).toHaveLength(MAX_PENDING_JOIN_REQUESTS_PER_GROUP);
    expect(t.bells).toHaveLength(MAX_PENDING_JOIN_REQUESTS_PER_GROUP);
    expect(t.seen.size).toBe(MAX_PENDING_JOIN_REQUESTS_PER_GROUP);
    expect(t.errors).toEqual([]);
  });

  it('a group at its cap does not affect another group (no global cap): other groups keep accepting, however many are full', async () => {
    const fullGroups = 12; // 12 x 50 = 600 stored requests, more than any former global bound
    const preload: PendingJoinRequest[] = [];
    const links: Record<string, ReturnType<typeof link>> = {};
    for (let g = 0; g < fullGroups; g++) {
      links[`g${g}`] = link({ nonce: `g${g}`, groupId: groupOf(g) });
      for (let i = 0; i < MAX_PENDING_JOIN_REQUESTS_PER_GROUP; i++) preload.push(stored(g * 100 + i + 1, groupOf(g), NOW));
    }
    links.other = link({ nonce: 'other', groupId: groupOf(99) });
    const t = setup({ links, preload });
    await t.handler(rumor({ id: 'full', pubkey: key(88_888), nonce: 'g0' }), wrap); // group A: at its cap, refused
    expect(t.bells).toEqual([]);
    await t.handler(rumor({ id: 'late', pubkey: key(99_999), nonce: 'other' }), wrap); // group B: accepted
    expect(t.bells.map((r) => r.eventId)).toEqual(['late']);
    expect(t.store).toHaveLength(fullGroups * MAX_PENDING_JOIN_REQUESTS_PER_GROUP + 1);
  });

  it('requests older than the TTL no longer count and are pruned, so a full group accepts a fresh requester again', async () => {
    const preload = Array.from({ length: MAX_PENDING_JOIN_REQUESTS_PER_GROUP }, (_, i) => stored(i + 1, GROUP, NOW - PENDING_JOIN_REQUEST_TTL_MS));
    const t = setup({ preload });
    await t.handler(rumor({ id: 'fresh', pubkey: key(777) }), wrap);
    expect(t.store.map((r) => r.pubkeyHex)).toEqual([key(777)]);
    expect(t.bells).toHaveLength(1);
  });

  it('a request just inside the TTL still counts', async () => {
    const preload = Array.from({ length: MAX_PENDING_JOIN_REQUESTS_PER_GROUP }, (_, i) => stored(i + 1, GROUP, NOW - PENDING_JOIN_REQUEST_TTL_MS + 1));
    const t = setup({ preload });
    await t.handler(rumor({ id: 'fresh', pubkey: key(777) }), wrap);
    expect(t.store).toHaveLength(MAX_PENDING_JOIN_REQUESTS_PER_GROUP);
    expect(t.bells).toEqual([]);
  });

  it('scans the store once per arrival (the save port does not scan again)', async () => {
    const loadAll = vi.fn(async () => [] as PendingJoinRequest[]);
    const handler = createJoinRequestInboxHandler({
      denyLayer: { isBlocked: () => false },
      inviteLinks: { get: async () => link() as never },
      memberPubkeys: () => [],
      requests: { loadAll, save: async () => undefined, remove: async () => undefined },
      seen: { has: async () => false, add: async () => undefined },
      now: () => NOW,
      onReceived: () => undefined,
    });
    await handler(rumor(), wrap);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });
});

describe('bell and seen-mark ordering', () => {
  it('rings the bell right after the save, BEFORE the seen-mark', async () => {
    const order: string[] = [];
    const t = setup({ order });
    await t.handler(rumor(), wrap);
    expect(order).toEqual(['bell', 'seen']);
  });

  it('a failing seen-mark is reported, not rethrown, and the bell already rang once', async () => {
    const t = setup({ seenAddFails: true });
    await expect(t.handler(rumor(), wrap)).resolves.toBeUndefined();
    expect(t.bells).toHaveLength(1);
    expect(t.store).toHaveLength(1);
    expect(t.errors.map((e) => (e as Error).message)).toEqual(['seen down']);
  });
});
