/**
 * Reaction rumor stamping (bug: reaction-readd-same-second-not-propagated).
 *
 * A rumor for a reaction triple is never stamped older than the sender's own
 * latest state for that triple, so every receiver's last-writer-wins agrees with
 * the sender's local view even when remove/re-add happen within one second.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { Reaction } from '@/src/lib/reactions/types';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
}

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
const { buildReactionRumor } = await import('@/src/lib/reactions/rumor');
const api = await import('@/src/lib/reactions/api');
const { loadReactions, applyInboundRumor, applyOptimistic, clearAllReactions, prepareOwnReaction, stampFloorFor } = api;

const priv = Array.from(generateSecretKey(), (b) => b.toString(16).padStart(2, '0')).join('');
const ME = getPublicKey(Uint8Array.from(priv.match(/../g)!.map((h) => parseInt(h, 16))));
const THREAD = { kind: 'group' as const, groupId: 'g1' };
const PEER = { kind: 'group' as const, groupId: 'peer-view' };
const MSG = 'msg-1';
const EMOJI = '👍';
const T0 = 1_800_000_000; // seconds

function build(isRemoval: boolean, notBeforeSec?: number) {
  return buildReactionRumor({
    emoji: EMOJI, targetMessageId: MSG, targetMessageKind: 9,
    selfPrivKeyHex: priv, isRemoval, notBeforeSec,
  });
}
function row(createdAt: number): Reaction {
  return { id: `opt-${createdAt}`, messageId: MSG, reactorPubkey: ME, emoji: EMOJI, eventId: '', createdAt, removed: false };
}
async function liveOn(thread: typeof THREAD) {
  return (await loadReactions(thread)).filter((r) => r.reactorPubkey === ME && !r.removed).length;
}

beforeEach(async () => {
  idbStore.clear();
  await clearAllReactions();
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000 + 100);
});
afterEach(() => vi.useRealTimers());

describe('buildReactionRumor notBeforeSec', () => {
  it.each([
    ['absent', undefined, T0],
    ['in the past', T0 - 50, T0],
    ['equal to now', T0, T0],
    ['in the future', T0 + 5, T0 + 5],
  ])('created_at is max(now, floor): floor %s', (_n, floor, expected) => {
    expect(build(false, floor).created_at).toBe(expected);
  });

  it.each([['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]])(
    'a non-finite floor (%s) is ignored',
    (_n, floor) => {
      expect(build(false, floor).created_at).toBe(T0);
    },
  );

  it('the id covers the floored created_at (id stays canonical)', () => {
    expect(build(false, T0 + 5).id).not.toBe(build(false).id);
  });
});

function floorOf(rows: Reaction[], isRemoval: boolean) {
  return stampFloorFor(rows, MSG, ME, EMOJI, isRemoval);
}

describe('stampFloorFor', () => {
  it('no stored row: no floor', () => {
    expect(floorOf([], false)).toBeUndefined();
    expect(floorOf([], true)).toBeUndefined();
  });

  it('live row: add needs no floor, removal floors at the add second', () => {
    const rows = [row((T0 + 3) * 1000)];
    expect(floorOf(rows, false)).toBeUndefined();
    expect(floorOf(rows, true)).toBe(T0 + 3);
  });

  it('tombstone: re-add floors strictly after the removal second; removing again needs none', () => {
    const rows = [{ ...row((T0 - 10) * 1000), removed: true, removedAt: T0 * 1000 + 400 }];
    expect(floorOf(rows, false)).toBe(T0 + 1);
    expect(floorOf(rows, true)).toBeUndefined();
  });

  it('legacy tombstone (no removedAt): no floor needed', () => {
    expect(floorOf([{ ...row(1000), removed: true }], false)).toBeUndefined();
  });
});

/** The real helper, on THREAD, with the real rumor builder. */
function own(isRemoval: boolean, thread = THREAD) {
  return prepareOwnReaction(thread, {
    messageId: MSG, reactorPubkey: ME, emoji: EMOJI, isRemoval,
    build: (notBeforeSec) => build(isRemoval, notBeforeSec),
  });
}

describe('prepareOwnReaction', () => {
  it('builds once; the optimistic row id is the published id and carries the rumor stamp', async () => {
    const build_ = vi.fn((n?: number) => build(false, n));
    const { rumor } = await prepareOwnReaction(THREAD, {
      messageId: MSG, reactorPubkey: ME, emoji: EMOJI, isRemoval: false, build: build_,
    });
    expect(build_).toHaveBeenCalledTimes(1);
    const [stored] = await loadReactions(THREAD);
    expect(stored.id).toBe(rumor.id);
    expect(stored.createdAt).toBe(rumor.created_at * 1000);
  });

  it('removal tombstones the live row at the rumor stamp', async () => {
    await own(false);
    const { rumor } = await own(true);
    const [stored] = await loadReactions(THREAD);
    expect(stored.removed).toBe(true);
    expect(stored.removedAt).toBe(rumor.created_at * 1000);
  });

  it('a removal queued BEFORE the re-add raises its floor: rumor stamped after it, peer converges', async () => {
    await own(false);
    const farRemoval = {
      id: 'far2', pubkey: ME, created_at: T0 + 7, content: '-', tags: [['e', MSG], ['emoji', EMOJI]],
    };
    const intervening = applyInboundRumor(THREAD, farRemoval); // queued first
    const readd = own(false); // floor must see the removal
    const [, { rumor }] = await Promise.all([intervening, readd]);
    expect(rumor.created_at).toBe(T0 + 8);
    expect(await liveOn(THREAD)).toBe(1);
    await applyInboundRumor(PEER, farRemoval);
    await applyInboundRumor(PEER, rumor);
    expect(await liveOn(PEER)).toBe(1);
  });
});

describe('sender and receiver converge (same wall-clock second)', () => {
  it('add, remove, re-add within one second: peer shows it live, like the sender', async () => {
    const rumors = [(await own(false)).rumor, (await own(true)).rumor, (await own(false)).rumor];
    expect(await liveOn(THREAD)).toBe(1);
    for (const r of rumors) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(1);
  });

  it('add, remove, re-add, remove within one second: peer shows it removed, like the sender', async () => {
    const rumors = [];
    for (const rem of [false, true, false, true]) rumors.push((await own(rem)).rumor);
    expect(await liveOn(THREAD)).toBe(0);
    for (const r of rumors) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(0);
  });

  it('delivery order does not change the peer outcome', async () => {
    const rumors = [(await own(false)).rumor, (await own(true)).rumor, (await own(false)).rumor];
    for (const r of [...rumors].reverse()) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(1);
  });

  it("a long toggle burst ends in the sender's final state on the peer", async () => {
    const rumors = [];
    for (let i = 0; i < 9; i++) rumors.push((await own(i % 2 === 1)).rumor);
    const senderLive = await liveOn(THREAD);
    for (const r of rumors) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(senderLive);
    expect(senderLive).toBe(1);
  });
});

describe('retry after a failed send (frozen clock, identical rumor id)', () => {
  const { rollbackOptimistic } = api;
  const viewOf = async (thread: typeof THREAD) =>
    (await loadReactions(thread)).filter((r) => r.reactorPubkey === ME);

  it('failed re-add retried with the same id: sender revives, peer converges, no self-echo needed', async () => {
    const add1 = (await own(false)).rumor;
    const removal = (await own(true)).rumor;
    const failed = (await own(false)).rumor;
    expect(failed.created_at).toBe(removal.created_at + 1);
    await rollbackOptimistic(THREAD, failed.id);
    expect(await liveOn(THREAD)).toBe(0);

    const retry = (await own(false)).rumor; // clock has not passed S+1
    expect(retry.id).toBe(failed.id);
    expect(await liveOn(THREAD)).toBe(1);
    expect((await viewOf(THREAD))).toHaveLength(1);

    for (const r of [add1, removal, retry]) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(1);
  });

  it('a revived retry keeps the removal ordering: an older removal replay cannot undo it', async () => {
    await own(false);
    const removal = (await own(true)).rumor;
    const failed = (await own(false)).rumor;
    await rollbackOptimistic(THREAD, failed.id);
    await own(false);
    await applyInboundRumor(THREAD, removal as any);
    expect(await liveOn(THREAD)).toBe(1);
  });

  it('failed removal retried with the same id: sender removed again, peer converges', async () => {
    const add1 = (await own(false)).rumor;
    const failedRemoval = (await own(true)).rumor;
    // Failure path of the call sites: restore the badge under the removal's id.
    await api.applyOptimistic(THREAD, {
      id: failedRemoval.id, messageId: MSG, reactorPubkey: ME, emoji: EMOJI,
      eventId: '', createdAt: Date.now(), removed: false,
    });
    expect(await liveOn(THREAD)).toBe(1);

    const retry = (await own(true)).rumor;
    expect(await liveOn(THREAD)).toBe(0);
    for (const r of [add1, retry]) await applyInboundRumor(PEER, r);
    expect(await liveOn(PEER)).toBe(0);
  });
});

describe('applyOptimistic reusing the id of a removed row that is not a rolled-back pending add', () => {
  const removalRumor = { id: 'rm', pubkey: ME, created_at: T0, content: '-', tags: [['e', MSG], ['emoji', EMOJI]] };
  const addRumor = { id: 'ad', pubkey: ME, created_at: T0 - 10, content: EMOJI, tags: [['e', MSG]] };

  it('an inbound-confirmed removal-only tombstone (createdAt 0, eventId set) stays removed', async () => {
    await applyInboundRumor(THREAD, removalRumor);
    const before = await loadReactions(THREAD);
    expect(before[0]).toMatchObject({ id: 'rm', eventId: 'rm', createdAt: 0, removed: true });
    expect(await applyOptimistic(THREAD, { ...row((T0 + 1) * 1000), id: 'rm' })).toBeNull();
    expect(await loadReactions(THREAD)).toEqual(before);
    expect(await liveOn(THREAD)).toBe(0);
  });

  it('a confirmed removed row (eventId set, createdAt non-zero) stays removed', async () => {
    await applyInboundRumor(THREAD, addRumor);
    await applyInboundRumor(THREAD, removalRumor);
    const before = await loadReactions(THREAD);
    expect(before[0]).toMatchObject({ id: 'ad', removed: true });
    expect(before[0].eventId).not.toBe('');
    expect(before[0].createdAt).toBeGreaterThan(0);
    expect(await applyOptimistic(THREAD, { ...row((T0 + 1) * 1000), id: 'ad' })).toBeNull();
    expect(await loadReactions(THREAD)).toEqual(before);
    expect(await liveOn(THREAD)).toBe(0);
  });

  it('an unconfirmed locally removed row (eventId empty, createdAt non-zero) stays removed', async () => {
    const { rumor } = await own(false);
    await own(true);
    const before = await loadReactions(THREAD);
    expect(before[0]).toMatchObject({ id: rumor.id, eventId: '', removed: true });
    expect(await applyOptimistic(THREAD, { ...row((T0 + 1) * 1000), id: rumor.id })).toBeNull();
    expect(await loadReactions(THREAD)).toEqual(before);
  });
});

// ─── Exact stamps of the optimistic merge / revival, removal matching, clearing ─

const KEY = 'few:reactions:group:g1';
function seed(rows: Partial<Reaction>[]) {
  idbStore.set(KEY, rows.map((r, i) => ({
    id: `seed-${i}`, messageId: MSG, reactorPubkey: ME, emoji: EMOJI,
    eventId: `ev-${i}`, createdAt: 1000, removed: false, ...r,
  })));
}
const REMOVED_AT = T0 * 1000 + 400; // removal second T0 -> floor T0 + 1
const FLOOR_MS = (T0 + 1) * 1000;
const rolledBack = (over: Partial<Reaction> = {}): Partial<Reaction> => ({
  id: 'pending', eventId: '', createdAt: 0, removed: true, removedAt: REMOVED_AT, ...over,
});
const addRow = (over: Partial<Reaction>): Reaction => ({ ...row(0), id: 'pending', ...over });

describe('revival of a rolled-back pending add (exact createdAt)', () => {
  it('a lower row stamp is raised to the second after the removal', async () => {
    seed([rolledBack()]);
    const out = await applyOptimistic(THREAD, addRow({ createdAt: 5 }));
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ id: 'pending', removed: false, createdAt: FLOOR_MS, removedAt: REMOVED_AT });
  });

  it('reviving keeps the other stored rows, before and after, in place', async () => {
    seed([{ id: 'before', emoji: '🎉' }, rolledBack(), { id: 'after', messageId: 'other' }]);
    const before = idbStore.get(KEY) as Reaction[];
    const out = await applyOptimistic(THREAD, addRow({ createdAt: 5 }));
    expect(out!.map((r) => r.id)).toEqual(['before', 'pending', 'after']);
    expect(out![0]).toEqual(before[0]);
    expect(out![2]).toEqual(before[2]);
    expect(await loadReactions(THREAD)).toEqual(out);
  });

  it('a higher row stamp is kept', async () => {
    seed([rolledBack()]);
    const out = await applyOptimistic(THREAD, addRow({ createdAt: FLOOR_MS + 7000 }));
    expect(out![0].createdAt).toBe(FLOOR_MS + 7000);
  });

  it('the same id on a different triple is not revived and nothing changes', async () => {
    seed([rolledBack({ emoji: '🎉' })]);
    expect(await applyOptimistic(THREAD, addRow({ createdAt: 5 }))).toBeNull();
    expect((await loadReactions(THREAD))[0]).toMatchObject({ emoji: '🎉', removed: true, createdAt: 0 });
  });

  it.each([['messageId', { messageId: 'other' }], ['reactorPubkey', { reactorPubkey: 'someone' }]])(
    'the same id with a different %s is not revived',
    async (_n, over) => {
      seed([rolledBack(over)]);
      expect(await applyOptimistic(THREAD, addRow({ createdAt: 5 }))).toBeNull();
    },
  );
});

describe('tombstone merge of a new add (exact createdAt)', () => {
  const tomb = (over: Partial<Reaction> = {}): Partial<Reaction> => ({
    id: 'old', eventId: 'ev-old', createdAt: 1000, removed: true, removedAt: REMOVED_AT, ...over,
  });

  it('a lower row stamp is raised to the second after the removal; the removal time is kept', async () => {
    seed([tomb()]);
    const out = await applyOptimistic(THREAD, addRow({ id: 'new', createdAt: 5 }));
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ id: 'new', removed: false, eventId: '', createdAt: FLOOR_MS, removedAt: REMOVED_AT });
  });

  it('a higher row stamp is kept', async () => {
    seed([tomb()]);
    const out = await applyOptimistic(THREAD, addRow({ id: 'new', createdAt: FLOOR_MS + 5000 }));
    expect(out![0].createdAt).toBe(FLOOR_MS + 5000);
  });

  it('a stored add time beyond both other terms is kept (never moves backwards)', async () => {
    seed([tomb({ createdAt: FLOOR_MS + 90_000 })]);
    const out = await applyOptimistic(THREAD, addRow({ id: 'new', createdAt: 5 }));
    expect(out![0].createdAt).toBe(FLOOR_MS + 90_000);
  });
});

describe('optimistic removal only tombstones the exact live triple', () => {
  it('rows sharing two of three fields, and an already removed twin, stay untouched', async () => {
    seed([
      { id: 'other-emoji', emoji: '🎉' },
      { id: 'other-reactor', reactorPubkey: 'someone' },
      { id: 'other-message', messageId: 'other' },
      { id: 'old-removed', removed: true, removedAt: 1500, eventId: 'ev-r' },
      { id: 'target' },
    ]);
    const before = idbStore.get(KEY) as Reaction[];
    const out = await api.applyOptimisticRemoval(THREAD, MSG, ME, EMOJI);
    expect(out).not.toBeNull();
    const byId = Object.fromEntries(out!.map((r) => [r.id, r]));
    expect(byId['target'].removed).toBe(true);
    expect(byId['target'].removedAt).toBeGreaterThanOrEqual(1000);
    for (const id of ['other-emoji', 'other-reactor', 'other-message', 'old-removed']) {
      expect(byId[id]).toEqual(before.find((r) => r.id === id));
    }
  });

  it('with no live row for the triple nothing changes', async () => {
    seed([{ id: 'other-emoji', emoji: '🎉' }, { id: 'gone', removed: true, removedAt: 1500 }]);
    expect(await api.applyOptimisticRemoval(THREAD, MSG, ME, EMOJI)).toBeNull();
  });
});

describe('prepareOwnReaction while the store is being cleared', () => {
  it.each([false, true])('builds nothing and throws a couldntReact error (isRemoval %s)', async (isRemoval) => {
    const buildSpy = vi.fn((n?: number) => build(isRemoval, n));
    const clearing = clearAllReactions();
    const attempt = prepareOwnReaction(THREAD, {
      messageId: MSG, reactorPubkey: ME, emoji: EMOJI, isRemoval, build: buildSpy,
    });
    await expect(attempt).rejects.toMatchObject({ couldntReact: true, message: expect.stringMatching(/being cleared/) });
    await clearing;
    expect(buildSpy).not.toHaveBeenCalled();
    expect(await loadReactions(THREAD)).toEqual([]);
  });
});
