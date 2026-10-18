/**
 * Reaction re-add after removal (bug: reaction-readd-after-removal).
 *
 * A reaction that was removed can be added again: the add wins iff it is
 * STRICTLY newer than the removal (rumor.created_at * 1000 > removedAt).
 * An add older than or equal to its removal stays removed (out-of-order relay
 * delivery stays protected; same-second case is covered in stamp-floor.test.ts). A legacy tombstone without
 * removedAt keeps "removal wins".
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Reaction } from '@/src/lib/reactions/types';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

import { set as idbSet } from 'idb-keyval';

const {
  loadReactions,
  aggregateForMessage,
  applyInboundRumor,
  applyOptimistic,
  applyOptimisticRemoval,
  rollbackOptimistic,
  clearAllReactions,
} = await import('@/src/lib/reactions/api');

const GROUP = { kind: 'group' as const, groupId: 'g1' };
const DM = { kind: 'dm' as const, peerPubkeyHex: 'aabbccdd' };
const THREADS = [
  ['group', GROUP],
  ['dm', DM],
] as const;
const ALICE = 'alice';
const ME = 'me-pubkey';

function add(id: string, createdAt: number, pubkey = ALICE, emoji = '👍') {
  return { id, pubkey, created_at: createdAt, content: emoji, tags: [['e', 'msg-1']] };
}
function remove(id: string, createdAt: number, pubkey = ALICE, emoji = '👍') {
  return { id, pubkey, created_at: createdAt, content: '-', tags: [['e', 'msg-1'], ['emoji', emoji]] };
}
function row(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: 'opt', messageId: 'msg-1', reactorPubkey: ME, emoji: '👍',
    eventId: '', createdAt: 0, removed: false, ...overrides,
  };
}
async function live(thread: typeof GROUP | typeof DM, who = ALICE) {
  const rows = await loadReactions(thread);
  return rows.filter((r) => r.reactorPubkey === who && !r.removed);
}

beforeEach(async () => {
  idbStore.clear();
  await clearAllReactions();
});
afterEach(() => vi.restoreAllMocks());

describe.each(THREADS)('re-add after removal — %s thread (inbound)', (_name, thread) => {
  it('an add strictly newer than the removal revives the reaction as one live row', async () => {
    await applyInboundRumor(thread, add('a1', 1000));
    await applyInboundRumor(thread, remove('r1', 2000));
    expect(await live(thread)).toHaveLength(0);

    const result = await applyInboundRumor(thread, add('a2', 3000));
    expect(result).toEqual({ messageId: 'msg-1' });

    const rows = await loadReactions(thread);
    const liveRows = rows.filter((r) => !r.removed);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].eventId).toBe('a2');
    expect(aggregateForMessage(rows, 'msg-1', ME)).toEqual([
      { emoji: '👍', count: 1, reactors: [ALICE], selfReacted: false },
    ]);
  });

  it('a stale add delivered after its removal stays removed', async () => {
    await applyInboundRumor(thread, add('a1', 1000));
    await applyInboundRumor(thread, remove('r1', 2000));
    expect(await applyInboundRumor(thread, add('a-stale', 1500))).toBeNull();
    expect(await live(thread)).toHaveLength(0);
  });

  it('an add with the same timestamp as the removal stays removed', async () => {
    await applyInboundRumor(thread, add('a1', 1000));
    await applyInboundRumor(thread, remove('r1', 2000));
    expect(await applyInboundRumor(thread, add('a-same', 2000))).toBeNull();
    expect(await live(thread)).toHaveLength(0);
  });

  it('a removal newer than the revived add removes it again, and a later stale add stays out', async () => {
    await applyInboundRumor(thread, add('a1', 1000));
    await applyInboundRumor(thread, remove('r1', 2000));
    await applyInboundRumor(thread, add('a2', 3000));
    await applyInboundRumor(thread, remove('r2', 4000));
    expect(await live(thread)).toHaveLength(0);
    expect(await applyInboundRumor(thread, add('a3', 3500))).toBeNull();
    expect(await live(thread)).toHaveLength(0);
    // ...and it can be revived once more by a strictly newer add.
    await applyInboundRumor(thread, add('a4', 5000));
    expect(await live(thread)).toHaveLength(1);
  });

  it('a replayed older removal does not remove a revived add (any arrival order)', async () => {
    await applyInboundRumor(thread, add('a1', 1000));
    await applyInboundRumor(thread, remove('r1', 2000));
    await applyInboundRumor(thread, add('a2', 3000));
    expect(await applyInboundRumor(thread, remove('r1-replay', 2000))).toBeNull();
    expect(await live(thread)).toHaveLength(1);
  });

  it('property: after remove(tR) an add(tA) revives iff tA > tR (grid of timestamp pairs)', async () => {
    for (const tR of [1, 2, 5, 100]) {
      for (const tA of [1, 2, 4, 5, 6, 99, 100, 101, 1000]) {
        idbStore.clear();
        await clearAllReactions();
        await applyInboundRumor(thread, add('a0', 1));
        await applyInboundRumor(thread, remove('r', tR));
        await applyInboundRumor(thread, add('a', tA));
        expect((await live(thread)).length === 1, `tR=${tR} tA=${tA}`).toBe(tA > tR);
      }
    }
  });
});

describe('re-add after removal — rows other than the revived one', () => {
  it('reviving leaves every unrelated row (other message, other reactor, other emoji) untouched', async () => {
    const others = [
      row({ id: 'x1', reactorPubkey: 'bob', eventId: 'e-x1', createdAt: 1000 }),
      row({ id: 'x2', reactorPubkey: ALICE, emoji: '❤️', eventId: 'e-x2', createdAt: 1000 }),
      row({ id: 'x3', reactorPubkey: ALICE, messageId: 'msg-2', eventId: 'e-x3', createdAt: 1000 }),
    ];
    idbStore.set('few:reactions:group:g1', [
      ...others,
      row({ id: 't', reactorPubkey: ALICE, eventId: 'rm', createdAt: 1000, removed: true, removedAt: 2000_000 }),
    ]);
    await applyInboundRumor(GROUP, add('a2', 3000));
    const rows = await loadReactions(GROUP);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3)).toEqual(others);
    expect(rows[3]).toMatchObject({ id: 't', removed: false, eventId: 'a2', createdAt: 3_000_000 });
    expect(rows[3].removedAt).toBe(2000_000); // newest removal is remembered
  });
});

describe('removal without an emoji tag', () => {
  it('only considers the sender\'s live rows on the targeted message', async () => {
    const mine = row({ id: 'm', reactorPubkey: ALICE, eventId: 'e-m', createdAt: 1000 });
    const bobs = row({ id: 'b', reactorPubkey: 'bob', eventId: 'e-b', createdAt: 1000 });
    const otherMsg = row({ id: 'o', reactorPubkey: ALICE, messageId: 'msg-2', eventId: 'e-o', createdAt: 1000 });
    idbStore.set('few:reactions:group:g1', [bobs, otherMsg, mine]);
    const noTag = { id: 'rm', pubkey: ALICE, created_at: 2000, content: '-', tags: [['e', 'msg-1']] };
    expect(await applyInboundRumor(GROUP, noTag)).toEqual({ messageId: 'msg-1' });
    const rows = await loadReactions(GROUP);
    expect(rows.find((r) => r.id === 'm')).toMatchObject({ removed: true, removedAt: 2_000_000 });
    expect(rows.find((r) => r.id === 'b')?.removed).toBe(false);
    expect(rows.find((r) => r.id === 'o')?.removed).toBe(false);
  });
});

describe('removal with an emoji tag', () => {
  it('tombstones only the sender\'s live row of that emoji on the targeted message', async () => {
    const bobs = row({ id: 'b', reactorPubkey: 'bob', eventId: 'e-b', createdAt: 1000 });
    const otherMsg = row({ id: 'o', reactorPubkey: ALICE, messageId: 'msg-2', eventId: 'e-o', createdAt: 1000 });
    const mine = row({ id: 'm', reactorPubkey: ALICE, eventId: 'e-m', createdAt: 1000 });
    idbStore.set('few:reactions:group:g1', [bobs, otherMsg, mine]);
    await applyInboundRumor(GROUP, remove('rm', 2000));
    const rows = await loadReactions(GROUP);
    expect(rows.find((r) => r.id === 'm')).toMatchObject({ removed: true, removedAt: 2_000_000, eventId: 'rm' });
    expect(rows.find((r) => r.id === 'b')?.removed).toBe(false);
    expect(rows.find((r) => r.id === 'o')?.removed).toBe(false);
  });
});

describe('re-add after removal — several tombstones for one triple', () => {
  it('the most recent removal decides, wherever it sits in the stored order', async () => {
    const t = (id: string, removedAt?: number) =>
      row({ id, reactorPubkey: ALICE, eventId: id, createdAt: 1000, removed: true, removedAt });
    // newest removal first, older one last
    idbStore.set('few:reactions:group:g1', [t('new', 5000_000), t('old', 2000_000)]);
    expect(await applyInboundRumor(GROUP, add('a', 3000))).toBeNull();
    expect(await live(GROUP)).toHaveLength(0);
    // a strictly newer add revives (the newest tombstone)
    await applyInboundRumor(GROUP, add('b', 6000));
    const liveRows = await live(GROUP);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe('new');
  });

  it('a legacy tombstone (no removedAt) among dated ones keeps removal-wins', async () => {
    const t = (id: string, removedAt?: number) =>
      row({ id, reactorPubkey: ALICE, eventId: id, createdAt: 1000, removed: true, removedAt });
    idbStore.set('few:reactions:group:g1', [t('dated', 2000_000), t('legacy')]);
    expect(await applyInboundRumor(GROUP, add('a', 3000))).toBeNull();
    expect(await live(GROUP)).toHaveLength(0);
  });
});

describe('re-add after removal — legacy tombstone', () => {
  it('a tombstone without removedAt keeps removal-wins however new the add is', async () => {
    idbStore.set('few:reactions:group:g1', [
      row({ id: 't', reactorPubkey: ALICE, eventId: 'old-removal', createdAt: 1000, removed: true }),
    ]);
    expect(await applyInboundRumor(GROUP, add('a-new', 9_999_999))).toBeNull();
    expect(await live(GROUP)).toHaveLength(0);
  });
});

describe('re-add after removal — local (optimistic) path', () => {
  it('records the local send time on an optimistic removal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_500);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1000 }));
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    const [r] = await loadReactions(GROUP);
    expect(r.removed).toBe(true);
    expect(r.removedAt).toBe(5_000_500);
  });

  it('remove then re-add: the optimistic re-add shows, and its echo confirms it (no duplicate)', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1_000_000 }));
    now.mockReturnValue(2_000_000);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    now.mockReturnValue(3_000_000);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 3_000_000 }));
    expect(await live(GROUP, ME)).toHaveLength(1);

    // Echo of the re-add (strictly later second than the removal).
    await applyInboundRumor(GROUP, add('o2', 3000, ME));
    const liveRows = await live(GROUP, ME);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].eventId).toBe('o2');
  });

  it('remove, re-add, remove again: the first re-add\'s echo cannot revive the badge', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1_000_000 }));
    now.mockReturnValue(2_000_000);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    now.mockReturnValue(3_000_000);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 3_000_000 }));
    now.mockReturnValue(4_000_000);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    expect(await live(GROUP, ME)).toHaveLength(0);

    await applyInboundRumor(GROUP, add('o2', 3000, ME));
    expect(await live(GROUP, ME)).toHaveLength(0);
  });

  it('the echo of the removal itself is a no-op after the re-add', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1_000_000 }));
    now.mockReturnValue(2_000_000);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    now.mockReturnValue(3_000_000);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 3_000_000 }));
    await applyInboundRumor(GROUP, remove('r1', 2000, ME));
    expect(await live(GROUP, ME)).toHaveLength(1);
  });
});

// ─── Arrival order never matters (last-writer-wins per triple) ────────────────

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

type Ev = { kind: 'add' | 'rm'; at: number };

/** The LWW answer: live iff the newest add is strictly newer than the newest removal. */
function lwwLive(events: Ev[]): boolean {
  const adds = events.filter((e) => e.kind === 'add').map((e) => e.at);
  const rms = events.filter((e) => e.kind === 'rm').map((e) => e.at);
  if (adds.length === 0) return false;
  if (rms.length === 0) return true;
  return Math.max(...adds) > Math.max(...rms);
}

const EVENT_SETS: Array<[string, Ev[]]> = [
  ['a1@5 r1@10 a2@11 r2@12', [{ kind: 'add', at: 5 }, { kind: 'rm', at: 10 }, { kind: 'add', at: 11 }, { kind: 'rm', at: 12 }]],
  ['a1@5 r1@10 a2@11', [{ kind: 'add', at: 5 }, { kind: 'rm', at: 10 }, { kind: 'add', at: 11 }]],
  ['a1@5 r1@10 a2@10 (tie)', [{ kind: 'add', at: 5 }, { kind: 'rm', at: 10 }, { kind: 'add', at: 10 }]],
  ['a1@7 r1@7 a2@7 (all same second)', [{ kind: 'add', at: 7 }, { kind: 'rm', at: 7 }, { kind: 'add', at: 7 }]],
  ['a1@5 r1@5 r2@9 (two removals)', [{ kind: 'add', at: 5 }, { kind: 'rm', at: 5 }, { kind: 'rm', at: 9 }]],
  ['r1@4 a1@5 r2@5 a2@6', [{ kind: 'rm', at: 4 }, { kind: 'add', at: 5 }, { kind: 'rm', at: 5 }, { kind: 'add', at: 6 }]],
];

describe.each(THREADS)('arrival order never changes the outcome — %s thread', (_name, thread) => {
  for (const [label, events] of EVENT_SETS) {
    it(`${label}: every arrival order ends in the last-writer-wins state with one row`, async () => {
      const expected = lwwLive(events);
      for (const order of permutations(events.map((e, i) => ({ ...e, id: `${e.kind}${i}` })))) {
        idbStore.clear();
        await clearAllReactions();
        for (const e of order) {
          await applyInboundRumor(thread, e.kind === 'add' ? add(e.id, e.at) : remove(e.id, e.at));
        }
        const rows = (await loadReactions(thread)).filter((r) => r.reactorPubkey === ALICE);
        const desc = order.map((e) => e.id).join(',');
        expect(rows.length, `rows for order ${desc}`).toBeLessThanOrEqual(1);
        expect(rows.filter((r) => !r.removed).length === 1, `order ${desc}`).toBe(expected);
        const agg = aggregateForMessage(rows, 'msg-1', ME);
        expect(agg.length === 1, `aggregate for order ${desc}`).toBe(expected);
      }
    });
  }
});

describe('sender echoes', () => {
  async function setup() {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(5_000);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 5_000 }));
    now.mockReturnValue(10_000);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    now.mockReturnValue(11_000);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 11_000 }));
  }

  it('a late echo of the first add does not touch the re-add row', async () => {
    await setup();
    await applyInboundRumor(GROUP, add('o1', 5, ME));
    const rows = await loadReactions(GROUP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'o2', eventId: '', removed: false });
  });

  it('after that stale echo, a failed re-add publish still rolls back to removed', async () => {
    await setup();
    await applyInboundRumor(GROUP, add('o1', 5, ME));
    await rollbackOptimistic(GROUP, 'o2');
    expect(await live(GROUP, ME)).toHaveLength(0);
    // the remembered removal still guards against a stale add
    expect(await applyInboundRumor(GROUP, add('o1', 5, ME))).toBeNull();
    expect(await live(GROUP, ME)).toHaveLength(0);
    // and a genuinely newer add still revives
    await applyInboundRumor(GROUP, add('later', 20, ME));
    expect(await live(GROUP, ME)).toHaveLength(1);
  });

  it('the re-add\'s own echo then confirms it', async () => {
    await setup();
    await applyInboundRumor(GROUP, add('o1', 5, ME));
    await applyInboundRumor(GROUP, add('o2', 11, ME));
    const rows = await loadReactions(GROUP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'o2', eventId: 'o2', removed: false });
  });
});

// ─── Store mechanics pinned (mutation survivors) ──────────────────────────────

describe('single row per triple — store mechanics', () => {
  it('a removal prefers the triple\'s live row over an older tombstone beside it', async () => {
    idbStore.set('few:reactions:group:g1', [
      row({ id: 't', reactorPubkey: ALICE, eventId: 'rm0', createdAt: 0, removed: true, removedAt: 9_000 }),
      row({ id: 'l', reactorPubkey: ALICE, eventId: 'e-l', createdAt: 12_000, removedAt: 2_000 }),
    ]);
    await applyInboundRumor(GROUP, remove('rm1', 13));
    expect(await live(GROUP)).toHaveLength(0);
  });

  it('optimistic add is idempotent on the row id', async () => {
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1_000 }));
    expect(await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 9_000 }))).toBeNull();
    expect((await loadReactions(GROUP))[0].createdAt).toBe(1_000);
  });

  it('optimistic add merging into a tombstone keeps unrelated rows and lands in a later second than the removal', async () => {
    const other = row({ id: 'x', reactorPubkey: 'bob', eventId: 'e-x', createdAt: 1_000 });
    idbStore.set('few:reactions:group:g1', [
      other,
      row({ id: 't', eventId: 'rm', createdAt: 0, removed: true, removedAt: 10_500 }),
    ]);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 10_900 }));
    const rows = await loadReactions(GROUP);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(other);
    expect(rows[1]).toMatchObject({ id: 'o2', eventId: '', removed: false, createdAt: 11_000, removedAt: 10_500 });
  });

  it('optimistic add on an already live row leaves that row untouched', async () => {
    const live8 = row({ id: 'p', eventId: 'e-p', createdAt: 8_000, removed: false });
    idbStore.set('few:reactions:group:g1', [live8]);
    expect(await applyOptimistic(GROUP, row({ id: 'o', createdAt: 500 }))).toBeNull();
    expect(await loadReactions(GROUP)).toEqual([live8]);
  });

  it('rolling back a merged re-add leaves unrelated rows alone', async () => {
    const other = row({ id: 'x', reactorPubkey: 'bob', eventId: 'e-x', createdAt: 1_000 });
    idbStore.set('few:reactions:group:g1', [
      other,
      row({ id: 'o', eventId: '', createdAt: 11_000, removedAt: 10_000 }),
    ]);
    await rollbackOptimistic(GROUP, 'o');
    const rows = await loadReactions(GROUP);
    expect(rows[0]).toEqual(other);
    expect(rows[1]).toMatchObject({ id: 'o', removed: true, removedAt: 10_000 });
  });

  it('a removal on a legacy tombstone changes nothing', async () => {
    const legacy = row({ id: 't', reactorPubkey: ALICE, eventId: 'old', createdAt: 1000, removed: true });
    idbStore.set('few:reactions:group:g1', [legacy]);
    expect(await applyInboundRumor(GROUP, remove('rm', 50))).toBeNull();
    expect(await loadReactions(GROUP)).toEqual([legacy]);
  });

  it('replays and stale events cause no write and no visible-change result', async () => {
    await applyInboundRumor(GROUP, add('a1', 5));
    await applyInboundRumor(GROUP, remove('r2', 12));
    const before = JSON.stringify(await loadReactions(GROUP));
    const writes = vi.mocked(idbSet).mock.calls.length;
    expect(await applyInboundRumor(GROUP, remove('r1', 10))).toBeNull(); // older removal
    expect(await applyInboundRumor(GROUP, remove('r2-again', 12))).toBeNull(); // same-time removal
    expect(await applyInboundRumor(GROUP, add('x', 5))).toBeNull(); // older add on a removed row
    expect(vi.mocked(idbSet).mock.calls.length).toBe(writes);
    expect(JSON.stringify(await loadReactions(GROUP))).toBe(before);
  });

  it('an older add on a live row writes nothing', async () => {
    await applyInboundRumor(GROUP, add('a2', 11));
    const writes = vi.mocked(idbSet).mock.calls.length;
    expect(await applyInboundRumor(GROUP, add('a1-other-id', 5))).toBeNull();
    expect(vi.mocked(idbSet).mock.calls.length).toBe(writes);
  });

  it('a removal that raises the removal time of an already-removed row is not a visible change', async () => {
    await applyInboundRumor(GROUP, add('a1', 5));
    await applyInboundRumor(GROUP, remove('r1', 10));
    expect(await applyInboundRumor(GROUP, remove('r2', 12))).toBeNull();
    const [r] = await loadReactions(GROUP);
    expect(r).toMatchObject({ removed: true, removedAt: 12_000, eventId: 'r2' });
  });

  it('an add that only raises the add time of a removed row is not a visible change', async () => {
    await applyInboundRumor(GROUP, remove('r1', 10));
    expect(await applyInboundRumor(GROUP, add('a1', 5))).toBeNull();
    const [r] = await loadReactions(GROUP);
    expect(r).toMatchObject({ removed: true, createdAt: 5_000, eventId: 'r1' });
  });

  it('a newer add on a live peer row takes its event id and is reported', async () => {
    await applyInboundRumor(GROUP, add('a1', 5));
    expect(await applyInboundRumor(GROUP, add('a2', 6))).toEqual({ messageId: 'msg-1' });
    expect((await loadReactions(GROUP))[0]).toMatchObject({ eventId: 'a2', createdAt: 6_000 });
  });

  it('the echo of a re-add confirms it even when its second precedes the locally bumped add time', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 1_000 }));
    now.mockReturnValue(10_500);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    now.mockReturnValue(10_900);
    await applyOptimistic(GROUP, row({ id: 'o2', createdAt: 10_900 })); // bumped into the next second
    expect(await applyInboundRumor(GROUP, add('o2', 10, ME))).toEqual({ messageId: 'msg-1' });
    expect((await loadReactions(GROUP))[0]).toMatchObject({ id: 'o2', eventId: 'o2', removed: false });
  });
});

describe('optimistic rollback keeps the prior row (review round 1)', () => {
  beforeEach(() => { idbStore.clear(); });

  it('a failed re-add onto a legacy tombstone keeps the tombstone', async () => {
    const legacy = row({ id: 't', eventId: 'old', createdAt: 1000, removed: true });
    idbStore.set('few:reactions:group:g1', [legacy]);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 5_000 }));
    await rollbackOptimistic(GROUP, 'o1');
    expect(await loadReactions(GROUP)).toEqual([legacy]);
    // A redelivery of the original add still cannot revive it.
    await applyInboundRumor(GROUP, add('a-orig', 1, ME));
    expect(await live(GROUP, ME)).toEqual([]);
  });

  it('an optimistic add on an already live row changes nothing, so a failed send keeps the reaction', async () => {
    const confirmed = row({ id: 'a1', eventId: 'a1', createdAt: 5_000 });
    idbStore.set('few:reactions:group:g1', [confirmed]);
    expect(await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 9_000 }))).toBeNull();
    await rollbackOptimistic(GROUP, 'o1');
    expect(await loadReactions(GROUP)).toEqual([confirmed]);
  });

  it('a removal older than a pending re-add does not take its event id, so the rollback still works', async () => {
    idbStore.set('few:reactions:group:g1', [
      row({ id: 't', eventId: 't', createdAt: 5_000, removed: true, removedAt: 9_000 }),
    ]);
    await applyOptimistic(GROUP, row({ id: 'o1', createdAt: 12_000 }));
    await applyInboundRumor(GROUP, remove('r2', 10, ME)); // other device, older than the re-add
    const [pending] = await loadReactions(GROUP);
    expect(pending).toMatchObject({ removed: false, eventId: '', removedAt: 10_000 });
    await rollbackOptimistic(GROUP, 'o1');
    expect(await live(GROUP, ME)).toEqual([]);
  });

  it('a failed removal restores the badge and a later removal still takes effect', async () => {
    idbStore.set('few:reactions:group:g1', [row({ id: 'a1', eventId: 'a1', createdAt: 5_000 })]);
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    await applyOptimistic(GROUP, row({ id: 'restore', createdAt: Date.now() })); // caller's restore row
    expect(await live(GROUP, ME)).toHaveLength(1);
    expect(await loadReactions(GROUP)).toHaveLength(1);
    expect(aggregateForMessage(await loadReactions(GROUP), 'msg-1', ME)[0]).toMatchObject({ count: 1 });
    await applyOptimisticRemoval(GROUP, 'msg-1', ME, '👍');
    expect(await live(GROUP, ME)).toEqual([]);
  });
});
