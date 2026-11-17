// @vitest-environment node
/**
 * S13 / AC-MEM-4 (event path, startup path, idempotence) and AC-MEM-5 (disband surfacing) for groupNotifications.
 *
 *  - `groupRemoved` is a client listener (a library frame): it only ENQUEUES the purge on the owned job queue, as its
 *    last action, and makes no account-scope call; the real client FIFO (createJobQueue) proves the purge starts only
 *    after the frame returned.
 *  - the startup check purges listed groups whose READABLE members() lack the own account; an unreadable roster is left
 *    alone (fail-closed) -- the opposite direction of the leave path.
 *  - a `group-disbanded` notification (through the handlers module's REAL router) and the persisted library marker
 *    (startup) mark the overlay row; idempotent; no overlay row -> nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { createJobQueue } from '@/src/lib/marmot/client';
import { createGroupNotificationRouter } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import {
  createDisbandMarker,
  createGroupRemovalHandlers,
  type GroupDataPurger,
  type ListedGroup,
  type OverlayRecord,
} from '@/src/lib/marmot/membership';

const OWN = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);
const G3 = 'ef'.repeat(32);

const listed = (id: string, members: () => readonly string[]): ListedGroup => ({ id, members });

function purgerSpy(fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const purger: GroupDataPurger = {
    purgeLocalGroup: async (id) => {
      calls.push(id);
      if (fail.has(id)) throw new Error(`purge ${id} failed`);
    },
  };
  return { purger, calls };
}

describe('AC-MEM-4(a): the groupRemoved event path', () => {
  it('is frame-safe: the listener returns BEFORE the purge starts (the purge runs on the owned FIFO after the frame)', async () => {
    const { purger, calls } = purgerSpy();
    const queue = createJobQueue();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: queue.enqueue });
    // the listener frame: nothing may have reached the purger when it returns
    handlers.onGroupRemoved({ groupId: G1, actor: BOB });
    expect(calls).toEqual([]);
    await queue.idle();
    expect(calls).toEqual([G1]);
    await queue.dispose();
  });

  it('enqueue is the LAST action: no account-scope work happens synchronously in the frame', () => {
    const order: string[] = [];
    const handlers = createGroupRemovalHandlers({
      ownPubkey: OWN,
      purger: { purgeLocalGroup: async () => void order.push('purge') },
      enqueue: () => void order.push('enqueue'),
    });
    handlers.onGroupRemoved({ groupId: G1 });
    expect(order).toEqual(['enqueue']);
  });

  it('a second event for a group already queued adds nothing; one after the job started schedules another idempotent pass', async () => {
    const { purger, calls } = purgerSpy();
    const jobs: Array<() => Promise<void>> = [];
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: (job) => void jobs.push(job) });
    handlers.onGroupRemoved({ groupId: G1 });
    handlers.onGroupRemoved({ groupId: G1 });
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(calls).toEqual([G1]);
    handlers.onGroupRemoved({ groupId: G1 });
    expect(jobs).toHaveLength(2);
  });

  it('a queue that does not accept the job (disposed) leaves nothing marked: a later event can retry', () => {
    const { purger } = purgerSpy();
    let accept = false;
    const jobs: unknown[] = [];
    const handlers = createGroupRemovalHandlers({
      ownPubkey: OWN,
      purger,
      enqueue: (job) => {
        if (!accept) return false;
        jobs.push(job);
      },
    });
    handlers.onGroupRemoved({ groupId: G1 });
    expect(jobs).toHaveLength(0);
    accept = true;
    handlers.onGroupRemoved({ groupId: G1 });
    expect(jobs).toHaveLength(1);
  });

  it('a failing purge is reported and never breaks the queue; a throwing enqueue never escapes the listener', async () => {
    const reported: Array<[string, unknown]> = [];
    const { purger } = purgerSpy(new Set([G1]));
    const jobs: Array<() => Promise<void>> = [];
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: (job) => void jobs.push(job), onError: (id, e) => void reported.push([id, e]) });
    handlers.onGroupRemoved({ groupId: G1 });
    await expect(jobs[0]()).resolves.toBeUndefined();
    expect(reported.map(([id]) => id)).toEqual([G1]);

    const throwing = createGroupRemovalHandlers({
      ownPubkey: OWN,
      purger,
      enqueue: () => {
        throw new Error('queue exploded');
      },
      onError: (id, e) => void reported.push([id, e]),
    });
    expect(() => throwing.onGroupRemoved({ groupId: G2 })).not.toThrow();
    expect(reported.map(([id]) => id)).toEqual([G1, G2]);
  });

  it('ignores a malformed payload', () => {
    const jobs: unknown[] = [];
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger: purgerSpy().purger, enqueue: (job) => void jobs.push(job) });
    handlers.onGroupRemoved({ groupId: '' });
    handlers.onGroupRemoved(undefined as never);
    expect(jobs).toEqual([]);
  });
});

describe('AC-MEM-4(b): the startup check (no event)', () => {
  it('purges exactly the listed groups whose readable members() lack the own account', async () => {
    const { purger, calls } = purgerSpy();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined });
    const purged = await handlers.checkListedGroups([
      listed(G1, () => [OWN, BOB]), // member: untouched
      listed(G2, () => [BOB]), // removed: purged
      listed(G3, () => []), // tombstone without anyone: purged
    ]);
    expect(purged).toEqual([G2, G3]);
    expect(calls).toEqual([G2, G3]);
  });

  it('compares accounts case-insensitively', async () => {
    const { purger, calls } = purgerSpy();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN.toUpperCase(), removalSettleMs: 0, purger, enqueue: () => undefined });
    expect(await handlers.checkListedGroups([listed(G1, () => [OWN])])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('TWIN READ, fail-closed: a throwing members() is NOT a purge (a corrupt-but-healthy group is left alone and reported)', async () => {
    const reported: string[] = [];
    const { purger, calls } = purgerSpy();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined, onError: (id) => void reported.push(id) });
    const purged = await handlers.checkListedGroups([
      listed(G1, () => {
        throw new Error('corrupt group state');
      }),
      listed(G2, () => [BOB]),
    ]);
    expect(purged).toEqual([G2]);
    expect(calls).toEqual([G2]);
    expect(reported).toEqual([G1]);
  });

  it('a handle that was abandoned by the purge (id and members() then throw, like the library\'s) is still reported with the id read BEFORE the purge', async () => {
    const calls: string[] = [];
    let live = true;
    const handle: ListedGroup = {
      get id(): string {
        if (!live) throw new Error('group was left or abandoned');
        return G2;
      },
      members: () => [BOB],
    };
    const purger: GroupDataPurger = {
      purgeLocalGroup: async (id) => {
        calls.push(id);
        live = false; // abandon() kills the handle
      },
    };
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined });
    expect(await handlers.checkListedGroups([handle])).toEqual([G2]);
    expect(calls).toEqual([G2]);
  });

  it('a handle whose id or members() throws up front (already abandoned) is skipped, not purged and not thrown', async () => {
    const { purger, calls } = purgerSpy();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined, onError: () => undefined });
    const dead = {
      get id(): string {
        throw new Error('group was left or abandoned');
      },
      members: () => [] as string[],
    };
    expect(await handlers.checkListedGroups([dead as ListedGroup])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a failing purge does not stop the others and is not reported as purged', async () => {
    const { purger, calls } = purgerSpy(new Set([G1]));
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined, onError: () => undefined });
    const purged = await handlers.checkListedGroups([listed(G1, () => [BOB]), listed(G2, () => [BOB])]);
    expect(calls).toEqual([G1, G2]);
    expect(purged).toEqual([G2]);
  });
});

describe('AC-MEM-4(c): idempotence through the handlers', () => {
  it('the event path and the startup check both end in the same purger; a repeat is the purger\'s idempotent no-op', async () => {
    const { purger, calls } = purgerSpy();
    const queue = createJobQueue();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: queue.enqueue });
    handlers.onGroupRemoved({ groupId: G1 });
    await queue.idle();
    await handlers.checkListedGroups([listed(G1, () => [BOB])]);
    expect(calls).toEqual([G1, G1]);
    await queue.dispose();
  });
});

describe('construction validates ports', () => {
  it('requires ownPubkey, enqueue and purger.purgeLocalGroup', () => {
    const base = { ownPubkey: OWN, purger: purgerSpy().purger, enqueue: () => undefined };
    expect(() => createGroupRemovalHandlers({ ...base, ownPubkey: '' })).toThrowError(/ownPubkey/);
    expect(() => createGroupRemovalHandlers({ ...base, enqueue: undefined as never })).toThrowError(/'enqueue'/);
    expect(() => createGroupRemovalHandlers({ ...base, purger: {} as never })).toThrowError(/purger\.purgeLocalGroup/);
    const marker = { overlay: { load: async () => undefined, save: async () => undefined }, now: () => 1, onMarked: () => undefined };
    expect(() => createDisbandMarker({ ...marker, now: undefined as never })).toThrowError(/'now'/);
    expect(() => createDisbandMarker({ ...marker, onMarked: undefined as never })).toThrowError(/'onMarked'/);
    expect(() => createDisbandMarker({ ...marker, overlay: { load: async () => undefined } as never })).toThrowError(/overlay\.save/);
    expect(() => createDisbandMarker({ ...marker, overlay: { save: async () => undefined } as never })).toThrowError(/overlay\.load/);
  });
});

function overlayFixture(rows: OverlayRecord[]) {
  const store = new Map(rows.map((r) => [r.id, structuredClone(r)]));
  const saves: OverlayRecord[] = [];
  const marked: string[] = [];
  const marker = createDisbandMarker({
    overlay: {
      load: async (id) => structuredClone(store.get(id)),
      save: async (record) => {
        saves.push(structuredClone(record));
        store.set(record.id, structuredClone(record));
      },
    },
    now: () => 1_800_000_000_000,
    onMarked: (id) => void marked.push(id),
    onError: () => undefined,
  });
  return { marker, store, saves, marked };
}

describe('AC-MEM-5: a disband notification marks the group disbanded in the overlay', () => {
  const overlayRow = (id: string): OverlayRecord => ({ id, name: 'Book club', createdAt: 1, memberPubkeys: [OWN, BOB], relays: ['wss://relay.example'] });

  it('through the handlers module\'s REAL router: `group-disbanded` marks the row (other fields kept) and tells the UI', async () => {
    const { marker, store, marked } = overlayFixture([overlayRow(G1), overlayRow(G2)]);
    const route = createGroupNotificationRouter({ members: vi.fn(), admins: vi.fn(), name: vi.fn(), disband: marker.disbandTarget });
    route(G1, { type: 'group-disbanded', actor: BOB, epoch: 3n, nodeTag: 'aa', commitDigest: 'bb' } as never);
    await vi.waitFor(() => expect(store.get(G1)?.disbanded).toEqual({ at: 1_800_000_000_000 }));
    expect(store.get(G1)).toMatchObject({ name: 'Book club', memberPubkeys: [OWN, BOB], relays: ['wss://relay.example'] });
    expect(store.get(G2)?.disbanded).toBeUndefined(); // only the disbanded group
    expect(marked).toEqual([G1]);
  });

  it('the other notification types do not mark (the router only forwards `group-disbanded`)', async () => {
    const { marker, store } = overlayFixture([overlayRow(G1)]);
    const route = createGroupNotificationRouter({ members: vi.fn(), admins: vi.fn(), name: vi.fn(), disband: marker.disbandTarget });
    route(G1, { type: 'applied', kind: 'memberRemoved' } as never);
    route(G1, { type: 'message-withdrawn', eventId: 'e' } as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get(G1)?.disbanded).toBeUndefined();
  });

  it('records the actor and the library timestamp when they are known; is idempotent (a second mark neither rewrites nor re-notifies)', async () => {
    const { marker, store, saves, marked } = overlayFixture([overlayRow(G1)]);
    expect(await marker.markDisbanded(G1, { actor: BOB, at: 1_700_000_123_000 })).toBe(true);
    expect(store.get(G1)?.disbanded).toEqual({ actor: BOB, at: 1_700_000_123_000 });
    expect(await marker.markDisbanded(G1, { actor: OWN, at: 5 })).toBe(false);
    expect(store.get(G1)?.disbanded).toEqual({ actor: BOB, at: 1_700_000_123_000 });
    expect(saves).toHaveLength(1);
    expect(marked).toEqual([G1]);
  });

  it('a group with no overlay row is left alone (nothing invented)', async () => {
    const { marker, saves, marked } = overlayFixture([]);
    expect(await marker.markDisbanded(G1)).toBe(false);
    expect(saves).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('concurrent marks of one group write once (the module serialises its own read-modify-write)', async () => {
    const { marker, saves } = overlayFixture([overlayRow(G1)]);
    const results = await Promise.all([marker.markDisbanded(G1), marker.markDisbanded(G1), marker.markDisbanded(G1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(saves).toHaveLength(1);
  });

  it('startup: the persisted library marker (`group.disbanded`) re-marks listed groups whose notification was missed', async () => {
    const { marker, store, marked } = overlayFixture([overlayRow(G1), overlayRow(G2), overlayRow(G3)]);
    const marked1 = await marker.syncListed([
      { id: G1, disbanded: { actor: BOB, at: 1_700_000_000_000 } },
      { id: G2, disbanded: undefined },
      { id: G3, disbanded: { actor: BOB, at: 1_700_000_000_001 } },
    ]);
    expect(marked1).toEqual([G1, G3]);
    expect(store.get(G1)?.disbanded).toEqual({ actor: BOB, at: 1_700_000_000_000 });
    expect(store.get(G2)?.disbanded).toBeUndefined();
    expect(marked).toEqual([G1, G3]);
    // a second startup marks nothing more
    expect(await marker.syncListed([{ id: G1, disbanded: { actor: BOB, at: 1_700_000_000_000 } }])).toEqual([]);
  });

  it('startup: a throwing `disbanded` getter or a failing save is reported and does not stop the others', async () => {
    const reported: string[] = [];
    const store = new Map<string, OverlayRecord>([[G2, overlayRow(G2)]]);
    const marker = createDisbandMarker({
      overlay: { load: async (id) => store.get(id), save: async (r) => void store.set(r.id, r) },
      now: () => 1,
      onMarked: () => undefined,
      onError: (id) => void reported.push(id),
    });
    const throwing = {
      id: G1,
      get disbanded(): never {
        throw new Error('corrupt');
      },
    };
    expect(await marker.syncListed([throwing, { id: G2, disbanded: { actor: BOB, at: 2 } }])).toEqual([G2]);
    expect(reported).toEqual([G1]);
  });

  it('a failing overlay write from the notification frame is reported, never thrown', async () => {
    const reported: string[] = [];
    const marker = createDisbandMarker({
      overlay: {
        load: async () => ({ id: G1 }),
        save: async () => Promise.reject(new Error('idb closed')),
      },
      now: () => 1,
      onMarked: () => undefined,
      onError: (id) => void reported.push(id),
    });
    expect(() => marker.disbandTarget(G1)).not.toThrow();
    await vi.waitFor(() => expect(reported).toEqual([G1]));
  });
});

describe('syncListed over handles that were purged meanwhile (id and every accessor throw)', () => {
  const overlayRow = (id: string): OverlayRecord => ({ id, name: 'Book club', createdAt: 1, memberPubkeys: [OWN, BOB], relays: [] });
  const abandonedHandle = (reads: { id: number; disbanded: number }) => ({
    get id(): string {
      reads.id++;
      throw new Error('group was left or abandoned');
    },
    get disbanded(): never {
      reads.disbanded++;
      throw new Error('group was left or abandoned');
    },
  });

  it('both getters throw: the group is skipped without a throw and the handle is touched exactly once (the id), never again', async () => {
    const { marker } = overlayFixture([overlayRow(G2)]);
    const reads = { id: 0, disbanded: 0 };
    const marked = await marker.syncListed([abandonedHandle(reads), { id: G2, disbanded: { actor: BOB, at: 2 } }]);
    expect(marked).toEqual([G2]);
    expect(reads).toEqual({ id: 1, disbanded: 0 });
  });

  it('a `disbanded` that throws after a readable id is reported under that id, and the handle is not touched again', async () => {
    const reported: string[] = [];
    const marker = createDisbandMarker({
      overlay: { load: async () => ({ id: G1 }), save: async () => undefined },
      now: () => 1,
      onMarked: () => undefined,
      onError: (id) => void reported.push(id),
    });
    let idReads = 0;
    const handle = {
      get id(): string {
        idReads++;
        return G1;
      },
      get disbanded(): never {
        throw new Error('gone');
      },
    };
    expect(await marker.syncListed([handle])).toEqual([]);
    expect(reported).toEqual([G1]);
    expect(idReads).toBe(1);
  });

  it('a malformed `disbanded` marker (not an object) is not marked', async () => {
    const { marker, saves } = overlayFixture([overlayRow(G1)]);
    expect(await marker.syncListed([{ id: G1, disbanded: 'yes' as never }])).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('checkListedGroups then syncListed over ONE list with a just-removed group resolves and still marks the other groups', async () => {
    const { marker, store } = overlayFixture([overlayRow(G2)]);
    let live = true;
    const removed = {
      get id(): string {
        if (!live) throw new Error('group was left or abandoned');
        return G1;
      },
      members: (): readonly string[] => {
        if (!live) throw new Error('group was left or abandoned');
        return [BOB]; // the own account is gone: purge candidate
      },
      get disbanded(): never {
        throw new Error('group was left or abandoned');
      },
    };
    const disbandedOther = { id: G2, members: () => [OWN, BOB], disbanded: { actor: BOB, at: 7 } };
    const list = [removed, disbandedOther];
    const purger: GroupDataPurger = {
      purgeLocalGroup: async () => {
        live = false; // abandon() kills the handle
      },
    };
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, removalSettleMs: 0, purger, enqueue: () => undefined });
    expect(await handlers.checkListedGroups(list as ListedGroup[])).toEqual([G1]);
    await expect(marker.syncListed(list)).resolves.toEqual([G2]);
    expect(store.get(G2)?.disbanded).toEqual({ actor: BOB, at: 7 });
  });
});

describe('startup check: the purge decision waits for the removal settle window', () => {
  it('a group lacking the own account is NOT purged before removalSettleMs has elapsed since bootstrap, and is purged right after', async () => {
    vi.useFakeTimers();
    try {
      const { purger, calls } = purgerSpy();
      const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, purger, enqueue: () => undefined, removalSettleMs: 5_000 });
      let result: string[] | undefined;
      const run = handlers.checkListedGroups([listed(G1, () => [BOB])]).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toEqual([]);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await run;
      expect(calls).toEqual([G1]);
      expect(result).toEqual([G1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the window counts from the handlers\' construction: a check that starts after it has elapsed purges at once', async () => {
    vi.useFakeTimers();
    try {
      const { purger, calls } = purgerSpy();
      const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, purger, enqueue: () => undefined, removalSettleMs: 5_000 });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await handlers.checkListedGroups([listed(G1, () => [BOB])])).toEqual([G1]);
      expect(calls).toEqual([G1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the roster is re-read after the window: a group that re-joined (or whose roster became unreadable) meanwhile is NOT purged', async () => {
    vi.useFakeTimers();
    try {
      const { purger, calls } = purgerSpy();
      const reported: string[] = [];
      const handlers = createGroupRemovalHandlers({
        ownPubkey: OWN,
        purger,
        enqueue: () => undefined,
        removalSettleMs: 5_000,
        onError: (id) => void reported.push(id),
      });
      let rejoined = false;
      let corrupt = false;
      const run = handlers.checkListedGroups([
        listed(G1, () => (rejoined ? [OWN, BOB] : [BOB])),
        listed(G2, () => {
          if (corrupt) throw new Error('corrupt');
          return [BOB];
        }),
        listed(G3, () => [BOB]),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      rejoined = true;
      corrupt = true;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await run).toEqual([G3]);
      expect(calls).toEqual([G3]);
      expect(reported).toEqual([G2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing to decide (no candidate) returns at once without waiting', async () => {
    const { purger } = purgerSpy();
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, purger, enqueue: () => undefined, removalSettleMs: 60_000 });
    expect(await handlers.checkListedGroups([listed(G1, () => [OWN, BOB])])).toEqual([]);
  });

  it('removalSettleMs is validated', () => {
    const { purger } = purgerSpy();
    expect(() => createGroupRemovalHandlers({ ownPubkey: OWN, purger, enqueue: () => undefined, removalSettleMs: -1 })).toThrowError(/removalSettleMs/);
  });
});
