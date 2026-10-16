/**
 * Cross-tab reaction refresh (bug: cross-tab-reactions-refresh).
 *
 * Two "tabs" = two independent module instances of reactions/api.ts (each
 * with its own crossTab channel and receiver), sharing ONE origin storage
 * (a Map-backed idb-keyval mock) and ONE simulated BroadcastChannel bus that,
 * like the real one, never delivers a message to the channel that posted it.
 *
 * Covers: a reaction write in tab A refreshes tab B's cached thread (group +
 * DM, add/remove/rollback, own + inbound); invalidation is scoped to the
 * announced thread; the badge-revival guard (the refresh is queued behind
 * in-flight writes, and a cold load never clobbers a newer cache); storage
 * failure injection on every storage step touched (set / delMany rejecting,
 * indeterminate commits, the refresh read failing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reaction, ReactionThreadKey } from '@/src/lib/reactions/types';

// ── shared origin storage (survives vi.resetModules) ─────────────────────────
const shared = vi.hoisted(() => ({
  idb: new Map<string, unknown>(),
  /** Awaited inside set() BEFORE the value lands (write in flight). */
  beforeSet: null as null | ((key: string) => Promise<void>),
  /** Awaited inside get() AFTER the value was read, before it is returned (stale read in flight). */
  afterGet: null as null | ((key: string) => Promise<void>),
  /** 'reject' = set fails, nothing lands; 'commit-then-reject' = lands, then rejects (indeterminate). */
  setFailure: null as null | 'reject' | 'commit-then-reject',
  getFails: false,
  /** Awaited inside keys() before listing (a clear in flight). */
  beforeKeys: null as null | (() => Promise<void>),
  delManyFails: false,
  /** Awaited inside delMany() before deleting; resolving to 'fail' rejects (nothing deleted). */
  delManyHook: null as null | ((keys: string[]) => Promise<'ok' | 'fail'>),
  getCalls: [] as string[],
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (k: string) => {
    shared.getCalls.push(k);
    if (shared.getFails) throw new Error('IDB read failed');
    const value = shared.idb.get(k);
    if (shared.afterGet) await shared.afterGet(k);
    return value;
  }),
  set: vi.fn(async (k: string, v: unknown) => {
    if (shared.beforeSet) await shared.beforeSet(k);
    if (shared.setFailure === 'reject') throw new Error('IDB write failed');
    shared.idb.set(k, v);
    if (shared.setFailure === 'commit-then-reject') throw new Error('IDB transaction aborted after commit');
  }),
  del: vi.fn(async (k: string) => {
    shared.idb.delete(k);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    if (shared.delManyHook && (await shared.delManyHook(ks)) === 'fail') throw new Error('IDB delete failed');
    if (shared.delManyFails) throw new Error('IDB delete failed');
    ks.forEach((k) => shared.idb.delete(k));
  }),
  keys: vi.fn(async () => {
    if (shared.beforeKeys) await shared.beforeKeys();
    return [...shared.idb.keys()];
  }),
}));

// ── simulated BroadcastChannel bus ───────────────────────────────────────────
type Listener = (event: { data: unknown }) => void;
type FakeChannel = {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', l: Listener): void;
  removeEventListener(t: 'message', l: Listener): void;
  close(): void;
};
const bus = new Set<{ channel: FakeChannel; listeners: Set<Listener> }>();
let allPosts: unknown[] = [];

function makeChannel(): FakeChannel {
  const entry = { listeners: new Set<Listener>() } as { channel: FakeChannel; listeners: Set<Listener> };
  entry.channel = {
    postMessage(m) {
      allPosts.push(m);
      const data = structuredClone(m);
      for (const other of bus) {
        if (other === entry) continue; // never echoes to the sender
        for (const l of other.listeners) queueMicrotask(() => l({ data }));
      }
    },
    addEventListener: (_t, l) => entry.listeners.add(l),
    removeEventListener: (_t, l) => entry.listeners.delete(l),
    close: () => bus.delete(entry),
  };
  bus.add(entry);
  return entry.channel;
}

type Api = typeof import('@/src/lib/reactions/api');
type Tab = { api: Api; posts: unknown[]; stop: () => void };

/** Boots one tab: fresh module instances + the real receiver mapping. */
async function bootTab(): Promise<Tab> {
  vi.resetModules();
  const crossTab = await import('@/src/lib/crossTab');
  const receiver = await import('@/src/lib/crossTabReceiver');
  const api = await import('@/src/lib/reactions/api');
  const posts: unknown[] = [];
  crossTab.setCrossTabChannelFactory(() => {
    const ch = makeChannel();
    const post = ch.postMessage.bind(ch);
    ch.postMessage = (m) => {
      posts.push(m);
      post(m);
    };
    return ch;
  });
  const noop = () => {};
  const stop = crossTab.subscribeStoreChanged((message) =>
    receiver.applyStoreChanged(message, {
      bumpBlockedPeers: noop,
      bumpKnownPeers: noop,
      bumpContacts: noop,
      reloadGroups: noop,
      bumpGroupData: noop,
      bumpChat: noop,
      bumpPolls: noop,
      refreshReactions: (key) => {
        void api.refreshReactionsFromStorage(key);
      },
    }),
  );
  return { api, posts, stop };
}

/** Lets queued bus deliveries and queued refreshes run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SELF = 'aa'.repeat(32);
const PEER = 'bb'.repeat(32);
const G1: ReactionThreadKey = { kind: 'group', groupId: 'g1' };
const G2: ReactionThreadKey = { kind: 'group', groupId: 'g2' };
const DM: ReactionThreadKey = { kind: 'dm', peerPubkeyHex: PEER };
const G1_KEY = 'few:reactions:group:g1';
const G2_KEY = 'few:reactions:group:g2';
const DM_KEY = `few:reactions:dm:${PEER}`;

function row(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: 'opt-1',
    messageId: 'm1',
    reactorPubkey: SELF,
    emoji: '👍',
    eventId: '',
    createdAt: 1000,
    removed: false,
    ...overrides,
  };
}

function rumor(overrides: Partial<{ id: string; pubkey: string; content: string; tags: string[][] }> = {}) {
  return { id: 'ev-1', pubkey: PEER, created_at: 1, content: '❤️', tags: [['e', 'm1']], ...overrides };
}

const CURATED = ['😀', '😂', '🤣', '😊', '😉', '😅', '😢', '😭', '😍', '🥰'];
const live = (rows: Reaction[]) => rows.filter((r) => !r.removed).map((r) => `${r.reactorPubkey.slice(0, 2)}:${r.emoji}`);
const sc = (id: string) => ({ type: 'store-changed', store: 'reactions', id });

/** A Web Locks fake shared by both tabs (one origin): FIFO per lock name. */
function fakeLocks(): { request: <T>(name: string, cb: () => Promise<T>) => Promise<T>; requested: string[] } {
  const held = new Map<string, Promise<unknown>>();
  const requested: string[] = [];
  return {
    requested,
    request<T>(name: string, cb: () => Promise<T>): Promise<T> {
      requested.push(name);
      const run = (held.get(name) ?? Promise.resolve()).then(cb, cb);
      held.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function setLocks(locks: unknown): void {
  const nav = (globalThis as { navigator?: object }).navigator;
  if (!nav) return;
  if (locks === undefined) {
    Reflect.deleteProperty(nav, 'locks');
  } else {
    Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true });
  }
}

let tabA: Tab;
let tabB: Tab;

beforeEach(async () => {
  shared.idb.clear();
  shared.beforeSet = null;
  shared.afterGet = null;
  shared.setFailure = null;
  shared.getFails = false;
  shared.beforeKeys = null;
  shared.delManyFails = false;
  shared.delManyHook = null;
  setLocks(undefined);
  shared.getCalls = [];
  allPosts = [];
  bus.clear();
  tabA = await bootTab();
  tabB = await bootTab();
});

afterEach(() => {
  setLocks(undefined);
  tabA.stop();
  tabB.stop();
  bus.clear();
});

describe('a reaction write in one tab shows in the other without reload', () => {
  it('inbound group reaction: tab B cache refreshes and its thread listener fires', async () => {
    expect(await tabB.api.loadReactions(G1)).toEqual([]); // B's cache is warm (and empty)
    const onB = vi.fn();
    tabB.api.subscribeReactions(G1, onB);

    await tabA.api.applyInboundRumor(G1, rumor());
    await settle();

    expect(onB).toHaveBeenCalledTimes(1);
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['bb:❤️']);
    expect(tabA.posts).toEqual([sc(G1_KEY)]);
  });

  it('own DM add, then remove, then rollback all propagate', async () => {
    await tabB.api.loadReactions(DM);

    await tabA.api.applyOptimistic(DM, row({ id: 'r1' }));
    await settle();
    expect(live(await tabB.api.loadReactions(DM))).toEqual(['aa:👍']);

    await tabA.api.applyOptimisticRemoval(DM, 'm1', SELF, '👍');
    await settle();
    expect(live(await tabB.api.loadReactions(DM))).toEqual([]);

    await tabA.api.applyOptimistic(DM, row({ id: 'r2', emoji: '🔥' }));
    await settle();
    expect(live(await tabB.api.loadReactions(DM))).toEqual(['aa:🔥']);
    await tabA.api.rollbackOptimistic(DM, 'r2');
    await settle();
    expect(live(await tabB.api.loadReactions(DM))).toEqual([]);
    expect(tabA.posts).toEqual([sc(DM_KEY), sc(DM_KEY), sc(DM_KEY), sc(DM_KEY)]);
  });

  it('inbound removal propagates (badge disappears in the other tab)', async () => {
    await tabA.api.applyInboundRumor(G1, rumor({ id: 'add' }));
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['bb:❤️']);

    await tabA.api.applyInboundRumor(G1, rumor({ id: 'rm', content: '-', tags: [['e', 'm1'], ['emoji', '❤️']] }));
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });

  it('a no-op write (dedup / idempotent) posts nothing', async () => {
    await tabA.api.applyInboundRumor(G1, rumor());
    tabA.posts.length = 0;
    await tabA.api.applyInboundRumor(G1, rumor()); // same event id → dedup, no write
    await tabA.api.applyOptimisticRemoval(G1, 'nope', SELF, '👍'); // nothing to remove
    expect(tabA.posts).toEqual([]);
  });

  it('the receiving tab never posts (no ping-pong)', async () => {
    await tabB.api.loadReactions(G1);
    await tabA.api.applyInboundRumor(G1, rumor());
    await settle();
    expect(tabB.posts).toEqual([]);
    expect(allPosts).toEqual([sc(G1_KEY)]);
  });
});

describe('invalidation is scoped to the announced thread', () => {
  it('only the written thread is re-read and only its listeners fire', async () => {
    await tabB.api.loadReactions(G1);
    await tabB.api.loadReactions(G2);
    const onG1 = vi.fn();
    const onG2 = vi.fn();
    tabB.api.subscribeReactions(G1, onG1);
    tabB.api.subscribeReactions(G2, onG2);
    shared.getCalls = [];

    await tabA.api.applyInboundRumor(G1, rumor());
    await settle();

    expect(onG1).toHaveBeenCalledTimes(1);
    expect(onG2).not.toHaveBeenCalled();
    // Tab A's write reads G1 once; tab B's refresh reads G1 once; nobody reads G2.
    expect(shared.getCalls.filter((k) => k === G2_KEY)).toEqual([]);
    expect(shared.getCalls.filter((k) => k === G1_KEY)).toHaveLength(2);
  });

  it('a thread this tab neither cached nor subscribed to is not read', async () => {
    shared.getCalls = [];
    await tabA.api.applyInboundRumor(G1, rumor());
    await settle();
    expect(shared.getCalls).toEqual([G1_KEY]); // tab A's own read-modify-write only
  });

  it('a subscribed but not-yet-cached thread is refreshed (listener fires)', async () => {
    const onB = vi.fn();
    tabB.api.subscribeReactions(G1, onB);
    await tabA.api.applyInboundRumor(G1, rumor());
    await settle();
    expect(onB).toHaveBeenCalledTimes(1);
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['bb:❤️']);
  });

  // Asserts observable state, not the get() call log: under vi.resetModules a
  // dynamic import('idb-keyval') racing clearAllReactions' own first import can
  // resolve to the REAL module (ReferenceError: indexedDB), which the refresh
  // swallows — a call-log assertion then passes even with the guard removed.
  it('is skipped while clearAllReactions runs, so a wiped account cannot be re-cached', async () => {
    shared.idb.set(G1_KEY, [row({ id: 'old-account' })]);
    await tabB.api.loadReactions(G1);
    tabB.api.subscribeReactions(G1, () => {});
    // Hold the clear after it dropped the cache but before it deleted storage.
    const gate = deferred();
    shared.beforeKeys = () => gate.promise;
    const clearing = tabB.api.clearAllReactions();
    await settle();
    await tabB.api.refreshReactionsFromStorage(G1_KEY); // must not re-read the doomed rows
    shared.beforeKeys = null;
    gate.resolve();
    await clearing;
    await settle();
    expect(await tabB.api.loadReactions(G1)).toEqual([]);
  });

  it('refreshing an uncached, unsubscribed thread is a resolved no-op', async () => {
    shared.getCalls = [];
    await expect(tabB.api.refreshReactionsFromStorage(G2_KEY)).resolves.toBeUndefined();
    expect(shared.getCalls).toEqual([]);
  });
});

describe('badge-revival guard', () => {
  it('a refresh arriving while this tab is mid-removal never revives the removed badge', async () => {
    // Tab B has its own reaction stored and cached.
    await tabB.api.applyOptimistic(G1, row({ id: 'mine' }));
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['aa:👍']);

    // Tab B starts removing it; the IDB write is held in flight.
    const gate = deferred();
    shared.beforeSet = () => gate.promise;
    const removal = tabB.api.applyOptimisticRemoval(G1, 'm1', SELF, '👍');
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]); // optimistic

    // A cross-tab notice for the same thread arrives mid-write.
    const refresh = tabB.api.refreshReactionsFromStorage(G1_KEY);
    await settle();
    // The refresh is queued behind the write: the badge stays gone.
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);

    shared.beforeSet = null;
    gate.resolve();
    await removal;
    await refresh;
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });

  it('a settled refresh never unchains a write queued behind it (serialisation survives)', async () => {
    await tabB.api.applyOptimistic(G1, row({ id: 'mine' }));
    // Refresh #1, then a removal queued behind it whose IDB write is held.
    const gate = deferred();
    const refresh1 = tabB.api.refreshReactionsFromStorage(G1_KEY);
    shared.beforeSet = () => gate.promise;
    const removal = tabB.api.applyOptimisticRemoval(G1, 'm1', SELF, '👍');
    await refresh1;
    await settle();
    // Refresh #2 arrives while the removal is still in flight: it must queue
    // behind the removal, not read the pre-removal row.
    const refresh2 = tabB.api.refreshReactionsFromStorage(G1_KEY);
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
    shared.beforeSet = null;
    gate.resolve();
    await removal;
    await refresh2;
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });

  it('a cold load that started before a refresh never overwrites the newer cache', async () => {
    shared.idb.set(G1_KEY, [row({ id: 'old', emoji: '👎' })]);
    const onB = vi.fn();
    tabB.api.subscribeReactions(G1, onB);

    // Tab B's cold load reads the OLD value, then stalls before caching it.
    const gate = deferred();
    let held = false;
    shared.afterGet = async () => {
      if (!held) {
        held = true;
        await gate.promise;
      }
    };
    const coldLoad = tabB.api.loadReactions(G1);
    await settle();

    // Meanwhile storage moves on and B refreshes from it.
    shared.idb.set(G1_KEY, [row({ id: 'new', emoji: '🎉' })]);
    await tabB.api.refreshReactionsFromStorage(G1_KEY);
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['aa:🎉']);

    // The stale cold load resolves late: it yields the newer cached rows.
    gate.resolve();
    expect(live(await coldLoad)).toEqual(['aa:🎉']);
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['aa:🎉']);
  });
});

describe('storage failure injection', () => {
  it('a rejected write still notifies (indeterminate); the other tab shows stored truth (nothing landed)', async () => {
    await tabB.api.loadReactions(G1);
    shared.setFailure = 'reject';
    await expect(tabA.api.applyInboundRumor(G1, rumor())).rejects.toThrow('IDB write failed');
    await settle();
    expect(tabA.posts).toEqual([sc(G1_KEY)]);
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });

  it('a write that committed but reported failure shows in the other tab', async () => {
    await tabB.api.loadReactions(G1);
    shared.setFailure = 'commit-then-reject';
    await expect(tabA.api.applyInboundRumor(G1, rumor())).rejects.toThrow();
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['bb:❤️']);
  });

  it('a failed refresh read keeps the cache, notifies nobody, never rejects, and does not wedge the queue', async () => {
    await tabB.api.applyOptimistic(G1, row({ id: 'kept' }));
    const onB = vi.fn();
    tabB.api.subscribeReactions(G1, onB);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    shared.getFails = true;
    await expect(tabB.api.refreshReactionsFromStorage(G1_KEY)).resolves.toBeUndefined();
    expect(onB).not.toHaveBeenCalled();
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['aa:👍']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    shared.getFails = false;
    shared.idb.set(G1_KEY, []);
    await tabB.api.refreshReactionsFromStorage(G1_KEY);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });

  it('a throwing postMessage never fails the reaction write', async () => {
    const crossTab = await import('@/src/lib/crossTab'); // tab B's instance (latest boot)
    crossTab.setCrossTabChannelFactory(() => ({
      postMessage: () => {
        throw new Error('DataCloneError');
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(tabB.api.applyOptimistic(G1, row())).resolves.not.toBeNull();
    expect(shared.idb.get(G1_KEY)).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('peer wipes propagate', () => {
  it('clearDmReactionsForPeer in tab A empties tab B\'s cached DM thread', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    expect(live(await tabB.api.loadReactions(DM))).toHaveLength(1);
    await tabA.api.clearDmReactionsForPeer(PEER);
    await settle();
    expect(tabA.posts).toEqual([sc(DM_KEY)]);
    expect(await tabB.api.loadReactions(DM)).toEqual([]);
  });

  it('a rejected delMany still notifies; tab B keeps showing stored truth', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    await tabB.api.loadReactions(DM);
    shared.delManyFails = true;
    await expect(tabA.api.clearDmReactionsForPeer(PEER)).rejects.toThrow('IDB delete failed');
    await settle();
    expect(tabA.posts).toEqual([sc(DM_KEY)]);
    expect(live(await tabB.api.loadReactions(DM))).toHaveLength(1);
  });

  it('purgeStrangerDmReactions announces each purged thread', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    shared.idb.set(G1_KEY, [row({ id: 'g' })]);
    await tabB.api.loadReactions(DM);
    await tabA.api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never);
    await settle();
    expect(tabA.posts).toEqual([sc(DM_KEY)]);
    expect(await tabB.api.loadReactions(DM)).toEqual([]);
  });

  it('a rejected purge delMany still notifies', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    shared.delManyFails = true;
    await expect(
      tabA.api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never),
    ).rejects.toThrow();
    expect(tabA.posts).toEqual([sc(DM_KEY)]);
  });
});

// ── Remediation round 1 ──────────────────────────────────────────────────────

describe('cross-tab lost update (Web Locks)', () => {
  /**
   * Reviewer scenario: both tabs start from [👍 (mine)]; tab A ingests ❤ (from
   * the peer) and holds its IDB write; meanwhile tab B removes 👍.
   */
  async function removalVersusIngest() {
    shared.idb.set(G1_KEY, [row({ id: 'mine' })]);
    await tabA.api.loadReactions(G1);
    await tabB.api.loadReactions(G1);
    const gate = deferred();
    let first = true;
    shared.beforeSet = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    const ingest = tabA.api.applyInboundRumor(G1, rumor({ id: 'heart' }));
    await settle(); // A has read [👍] and holds its write
    const removal = tabB.api.applyOptimisticRemoval(G1, 'm1', SELF, '👍');
    await settle();
    gate.resolve();
    await Promise.all([ingest, removal]);
    await settle();
    return {
      stored: live(shared.idb.get(G1_KEY) as Reaction[]),
      a: live(await tabA.api.loadReactions(G1)),
      b: live(await tabB.api.loadReactions(G1)),
    };
  }

  it('with Web Locks: storage and both tabs keep the removal AND the new reaction', async () => {
    const locks = fakeLocks();
    setLocks(locks);
    const got = await removalVersusIngest();
    expect(got).toEqual({ stored: ['bb:❤️'], a: ['bb:❤️'], b: ['bb:❤️'] });
    expect(new Set(locks.requested)).toEqual(new Set([`few:reactions:${G1_KEY}`]));
  });

  it('without Web Locks (known limitation, pinned): the stale add overwrites the removal in both tabs', async () => {
    const got = await removalVersusIngest();
    expect(got).toEqual({ stored: ['aa:👍', 'bb:❤️'], a: ['aa:👍', 'bb:❤️'], b: ['aa:👍', 'bb:❤️'] });
  });

  it('the lock is taken inside the in-tab queue: same-tab writes keep their order', async () => {
    setLocks(fakeLocks());
    await tabB.api.applyOptimistic(G1, row({ id: 'mine' }));
    const ops = [
      tabB.api.applyOptimisticRemoval(G1, 'm1', SELF, '👍'),
      tabB.api.applyOptimistic(G1, row({ id: 'fire', emoji: '🔥' })),
      tabB.api.rollbackOptimistic(G1, 'fire'),
    ];
    await Promise.all(ops);
    expect(live(shared.idb.get(G1_KEY) as Reaction[])).toEqual([]);
    expect(live(await tabB.api.loadReactions(G1))).toEqual([]);
  });
});

describe('refresh coalescing', () => {
  it('notices while a refresh is queued share it: one re-read, one listener call', async () => {
    await tabB.api.applyOptimistic(G1, row({ id: 'mine' }));
    const onB = vi.fn();
    tabB.api.subscribeReactions(G1, onB);
    // Hold a write of this tab so the refreshes queue behind it.
    const gate = deferred();
    shared.beforeSet = () => gate.promise;
    const write = tabB.api.applyOptimistic(G1, row({ id: 'fire', emoji: '🔥' }));
    await settle();
    shared.getCalls = [];
    const r1 = tabB.api.refreshReactionsFromStorage(G1_KEY);
    const r2 = tabB.api.refreshReactionsFromStorage(G1_KEY);
    const r3 = tabB.api.refreshReactionsFromStorage(G1_KEY);
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    shared.beforeSet = null;
    gate.resolve();
    await write;
    await r1;
    expect(shared.getCalls).toEqual([G1_KEY]);
    expect(onB).toHaveBeenCalledTimes(2); // the write's emit + ONE refresh
  });

  it('a notice while a refresh is RUNNING queues exactly one more (it reads the newer state)', async () => {
    await tabB.api.applyOptimistic(G1, row({ id: 'mine' }));
    const gate = deferred();
    let held = false;
    shared.afterGet = async () => {
      if (!held) {
        held = true;
        await gate.promise;
      }
    };
    const running = tabB.api.refreshReactionsFromStorage(G1_KEY);
    await settle(); // running: read done, held before caching
    const queued = tabB.api.refreshReactionsFromStorage(G1_KEY);
    expect(queued).not.toBe(running);
    expect(tabB.api.refreshReactionsFromStorage(G1_KEY)).toBe(queued);
    shared.idb.set(G1_KEY, [row({ id: 'newer', emoji: '🎉' })]);
    gate.resolve();
    await running;
    await queued;
    expect(live(await tabB.api.loadReactions(G1))).toEqual(['aa:🎉']);
    // After the queued one ran, a new notice starts a fresh refresh.
    expect(tabB.api.refreshReactionsFromStorage(G1_KEY)).not.toBe(queued);
  });

  it('a storm of notices from the other tab ends in the latest state with bounded re-reads', async () => {
    await tabB.api.loadReactions(G1);
    shared.getCalls = [];
    for (let i = 0; i < 10; i++) {
      await tabA.api.applyInboundRumor(G1, rumor({ id: `ev-${i}`, content: CURATED[i] }));
    }
    await settle();
    expect(live(await tabB.api.loadReactions(G1))).toHaveLength(10);
    const bReads = shared.getCalls.length - 10; // minus tab A's 10 read-modify-writes
    expect(bReads).toBeGreaterThanOrEqual(1);
    expect(bReads).toBeLessThanOrEqual(10);
  });
});

describe('refresh racing a peer wipe', () => {
  it('a refresh that reads while clearDmReactionsForPeer is deleting never re-caches the wiped rows', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    await tabB.api.loadReactions(DM);
    tabB.api.subscribeReactions(DM, () => {});
    const gate = deferred();
    shared.delManyHook = async () => {
      await gate.promise;
      return 'ok';
    };
    const wipe = tabB.api.clearDmReactionsForPeer(PEER);
    await settle(); // cache dropped, delete in flight; rows still stored
    await tabB.api.refreshReactionsFromStorage(DM_KEY); // reads the doomed rows
    gate.resolve();
    await wipe;
    expect(await tabB.api.loadReactions(DM)).toEqual([]);
  });

  it('same for purgeStrangerDmReactions', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    await tabB.api.loadReactions(DM);
    tabB.api.subscribeReactions(DM, () => {});
    const gate = deferred();
    shared.delManyHook = async () => {
      await gate.promise;
      return 'ok';
    };
    const purge = tabB.api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never);
    await settle();
    await tabB.api.refreshReactionsFromStorage(DM_KEY);
    gate.resolve();
    await purge;
    expect(await tabB.api.loadReactions(DM)).toEqual([]);
  });

  it('two overlapping wipes: the guard holds until the LAST one ends', async () => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    await tabB.api.loadReactions(DM);
    tabB.api.subscribeReactions(DM, () => {});
    const gate1 = deferred();
    const gate2 = deferred();
    let call = 0;
    shared.delManyHook = async () => {
      call += 1;
      if (call === 1) {
        await gate1.promise;
        return 'fail'; // wipe #1 fails: rows stay stored
      }
      await gate2.promise;
      return 'ok';
    };
    const wipe1 = tabB.api.clearDmReactionsForPeer(PEER);
    await settle();
    const wipe2 = tabB.api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never);
    await settle();
    gate1.resolve();
    await expect(wipe1).rejects.toThrow();
    // Wipe #2 still in progress: a refresh must not re-cache the doomed rows.
    await tabB.api.refreshReactionsFromStorage(DM_KEY);
    gate2.resolve();
    await wipe2;
    expect(await tabB.api.loadReactions(DM)).toEqual([]);
  });

  it.each([
    ['clearDmReactionsForPeer', (api: Api) => api.clearDmReactionsForPeer(PEER)],
    ['purgeStrangerDmReactions', (api: Api) =>
      api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never)],
  ])('after %s ends, refreshes cache and notify again', async (_name, wipe) => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    await tabB.api.loadReactions(DM);
    const onB = vi.fn();
    tabB.api.subscribeReactions(DM, onB);
    await wipe(tabB.api);
    onB.mockClear();
    shared.idb.set(DM_KEY, [row({ id: 'y', reactorPubkey: PEER, emoji: '🎉' })]);
    await tabB.api.refreshReactionsFromStorage(DM_KEY);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(live(await tabB.api.loadReactions(DM))).toEqual(['bb:🎉']);
  });

  it.each([
    ['clearDmReactionsForPeer', (api: Api) => api.clearDmReactionsForPeer(PEER)],
    ['purgeStrangerDmReactions', (api: Api) =>
      api.purgeStrangerDmReactions(() => ({ groups: [], knownPeers: new Set(), ownPubkeyHex: SELF }) as never)],
  ])('%s waits for an in-flight write before deleting (the key is not re-created)', async (_name, wipe) => {
    shared.idb.set(DM_KEY, [row({ id: 'x', reactorPubkey: PEER })]);
    const gate = deferred();
    shared.beforeSet = () => gate.promise;
    const write = tabB.api.applyInboundRumor(DM, rumor({ id: 'late' }));
    await settle(); // the write is in flight, held before its IDB set
    const wiping = wipe(tabB.api);
    await settle();
    shared.beforeSet = null;
    gate.resolve();
    await write;
    await wiping;
    expect(shared.idb.has(DM_KEY)).toBe(false);
  });
});

describe('Web Locks detection', () => {
  it('a navigator.locks without a request function falls back to the in-tab queue', async () => {
    setLocks({});
    await expect(tabB.api.applyOptimistic(G1, row())).resolves.not.toBeNull();
    expect(live(shared.idb.get(G1_KEY) as Reaction[])).toEqual(['aa:👍']);
  });

  it('no navigator at all (SSR / old runtimes) falls back to the in-tab queue', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
    try {
      await expect(tabB.api.applyOptimistic(G1, row())).resolves.not.toBeNull();
      expect(live(shared.idb.get(G1_KEY) as Reaction[])).toEqual(['aa:👍']);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    }
  });
});
