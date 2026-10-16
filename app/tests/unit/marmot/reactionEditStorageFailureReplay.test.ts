/**
 * Group reactions and delete/edit signals survive a storage failure
 * (bug: reaction-storage-failures).
 *
 * The dispatcher acks a write-ahead-journaled rumor only when every handler
 * completed. The reaction handler (kind 7), the delete handler (kind 5) and
 * the chat handler's edit path (edit-marked kind 9) used to swallow storage
 * failures, so the rumor was acked and the reaction/delete/edit silently
 * lost. They now throw, the entry stays journaled, and the next subscription
 * replays it.
 *
 * Exhaustive failure injection: a clean run records every idb-keyval
 * get/set the handling performs. Then, for EACH of those storage steps, a
 * fresh run fails exactly that step once — as a plain rejection (nothing
 * lands) and, for writes, also as an indeterminate commit-then-reject — and
 * the test asserts:
 *   1. the first subscription does NOT ack the rumor (it stays journaled);
 *   2. after the next subscription replays the journal, stored state equals
 *      the clean run's stored state, and the rumor is acked.
 * Stored state is the truth compared, never handler return values.
 *
 * Invalid input (no e-tag, unknown reaction target, an unauthorized delete)
 * is NOT a failure: it is acked on the first attempt, with nothing stored.
 *
 * Real modules end to end: createDispatcher, the three handlers,
 * reactions/api.ts, messageEdits/api.ts, chatPersistence.ts. Only idb-keyval
 * (Map-backed, with the failure injection) and the MLS deserialize boundary
 * are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
}

// ── idb-keyval mock with per-step failure injection ─────────────────────────

const io = vi.hoisted(() => ({
  idb: new Map<string, unknown>(),
  /** Counting is on only while a rumor is handled (not while seeding). */
  counting: false,
  ops: [] as string[],
  /** Index (into ops) of the single step to fail, or null. */
  failAt: null as number | null,
  mode: 'reject' as 'reject' | 'commit-then-reject',
  /** One-shot: the next set of this key lands, then rejects (indeterminate). */
  commitThenFailSetKey: null as string | null,
  /** Every get rejects (a storage outage for reads). */
  failAllGets: false,
  /** The pin transaction's read fails / its commit aborts. */
  pinTxnFailGet: false,
  pinTxnFailCommit: false,
}));

vi.mock('idb-keyval', async () => {
  const { callableMapStore } = await import('../helpers/callableMapStore');
  const { promisifyRequest } = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
  const step = (label: string): 'fail' | 'commit-then-fail' | 'ok' => {
    if (!io.counting) return 'ok';
    const index = io.ops.length;
    io.ops.push(label);
    if (io.failAt !== index) return 'ok';
    return label.startsWith('set') && io.mode === 'commit-then-reject' ? 'commit-then-fail' : 'fail';
  };
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  return {
    get: vi.fn(async (k: string) => {
      if (io.failAllGets) throw new Error(`injected read outage: ${k}`);
      if (step(`get ${k}`) === 'fail') throw new Error(`injected get failure: ${k}`);
      return clone(io.idb.get(k));
    }),
    set: vi.fn(async (k: string, v: unknown) => {
      const outcome = step(`set ${k}`);
      if (outcome === 'fail') throw new Error(`injected set failure: ${k}`);
      io.idb.set(k, clone(v));
      if (outcome === 'commit-then-fail') throw new Error(`injected set failure after commit: ${k}`);
      if (io.commitThenFailSetKey === k) {
        io.commitThenFailSetKey = null;
        throw new Error(`injected set failure after commit: ${k}`);
      }
    }),
    del: vi.fn(async (k: string) => {
      io.idb.delete(k);
    }),
    delMany: vi.fn(async (ks: string[]) => {
      ks.forEach((k) => io.idb.delete(k));
    }),
    keys: vi.fn(async () => [...io.idb.keys()]),
    // The pinned-rev store's readwrite transaction runs over the same Map.
    createStore: vi.fn(() =>
      callableMapStore(io.idb, { failGet: () => io.pinTxnFailGet, failCommit: () => io.pinTxnFailCommit }),
    ),
    promisifyRequest,
  };
});

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
}));

// ── fixtures ────────────────────────────────────────────────────────────────

const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const alicePriv = generateSecretKey();
const ALICE_PRIV = hex(alicePriv);
const ALICE = getPublicKey(alicePriv);
const malloryPriv = generateSecretKey();
const MALLORY_PRIV = hex(malloryPriv);
const SELF = 'ee'.repeat(32);
const GROUP = 'group-storage-failure';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const ORIG = 'orig-' + 'aa'.repeat(29);

type Rumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string };

type Modules = {
  createDispatcher: typeof import('@/src/lib/marmot/applicationRumorDispatcher').createDispatcher;
  createReactionHandler: typeof import('@/src/lib/marmot/handlers/reactionHandler').createReactionHandler;
  createDeleteEditHandler: typeof import('@/src/lib/marmot/handlers/deleteEditHandler').createDeleteEditHandler;
  createChatHandler: typeof import('@/src/lib/marmot/handlers/chatHandler').createChatHandler;
  reactions: typeof import('@/src/lib/reactions/api');
  edits: typeof import('@/src/lib/messageEdits/api');
  chat: typeof import('@/src/lib/marmot/chatPersistence');
  rumors: typeof import('@/src/lib/messageEdits/rumor');
};

/** Fresh module instances = a fresh app session (no in-memory caches or queues). */
async function boot(): Promise<Modules> {
  vi.resetModules();
  return {
    createDispatcher: (await import('@/src/lib/marmot/applicationRumorDispatcher')).createDispatcher,
    createReactionHandler: (await import('@/src/lib/marmot/handlers/reactionHandler')).createReactionHandler,
    createDeleteEditHandler: (await import('@/src/lib/marmot/handlers/deleteEditHandler')).createDeleteEditHandler,
    createChatHandler: (await import('@/src/lib/marmot/handlers/chatHandler')).createChatHandler,
    reactions: await import('@/src/lib/reactions/api'),
    edits: await import('@/src/lib/messageEdits/api'),
    chat: await import('@/src/lib/marmot/chatPersistence'),
    rumors: await import('@/src/lib/messageEdits/rumor'),
  };
}

function handlersFor(m: Modules) {
  const noop = vi.fn();
  return [
    m.createReactionHandler({
      loadMessages: m.chat.loadMessages,
      applyInboundRumor: m.reactions.applyInboundRumor,
      setReactionsVersion: noop,
    }),
    m.createDeleteEditHandler({ applyDeleteEditSignal: m.edits.applyDeleteEditSignal, setChatVersion: noop }),
    m.createChatHandler({
      appendMessage: vi.fn(async () => true),
      incrementUnread: noop,
      markAsRead: noop,
      setChatVersion: noop,
      applyDeleteEditSignal: m.edits.applyDeleteEditSignal,
      resolvePendingSignalsForSlot: m.edits.resolvePendingSignalsForSlot,
      isGroupAdmin: vi.fn(async () => false),
      isGroupMember: vi.fn(async () => false),
      getPoll: vi.fn(async () => null),
      loadVotes: vi.fn(async () => []),
      saveVoteIfNewer: vi.fn(async () => {}),
      loadPendingVotes: vi.fn(async () => []),
      removePendingVotes: vi.fn(async () => {}),
      queuePendingCloseAnnouncement: vi.fn(async () => {}),
      loadPendingCloseAnnouncements: vi.fn(async () => []),
      removePendingCloseAnnouncements: vi.fn(async () => {}),
    } as unknown as Parameters<Modules['createChatHandler']>[0]),
  ];
}

function makeGroup() {
  const listeners = new Map<string, (p: never) => unknown>();
  return {
    on: (e: string, fn: (p: never) => unknown) => void listeners.set(e, fn),
    off: (e: string) => void listeners.delete(e),
    deliver: (r: Rumor) =>
      listeners.get('authenticatedApplicationMessage')?.({
        message: new TextEncoder().encode(JSON.stringify(r)),
        senderPubkey: r.pubkey,
        senderLeafIndex: 0,
      } as never),
  };
}

/** Write-ahead journal fake: entry kept until acked. */
function makeJournal() {
  const entries = new Map<string, { data: Uint8Array; senderPubkey: string }>();
  const failures = new Map<string, number>();
  return {
    entries,
    put(r: Rumor) {
      entries.set(r.id, { data: new TextEncoder().encode(JSON.stringify(r)), senderPubkey: r.pubkey });
    },
    ack: vi.fn(async (_g: string, id: string) => void entries.delete(id)),
    recordFailure: vi.fn(async (_g: string, id: string) => {
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      return n;
    }),
  };
}

const ctx = { groupId: GROUP, selfPubkeyHex: SELF, getActiveGroupId: () => null };

/** Stored state, minus wall-clock bookkeeping (receivedAt / lastTouchedAt). */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of [...io.idb.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = Array.isArray(v)
      ? v.map((e) => {
          if (e && typeof e === 'object') {
            const { receivedAt: _r, lastTouchedAt: _t, ...rest } = e as Record<string, unknown>;
            return rest;
          }
          return e;
        })
      : v;
  }
  return out;
}

interface Scenario {
  name: string;
  seed: (m: Modules) => Promise<void>;
  rumor: (m: Modules) => Rumor;
}

const original = (overrides: Partial<import('@/src/lib/marmot/chatPersistence').ChatMessage> = {}) => ({
  id: ORIG,
  content: 'hello',
  senderPubkey: ALICE,
  groupId: GROUP,
  createdAt: (NOW_S - 600) * 1000,
  ...overrides,
});

const reaction = (overrides: Partial<Rumor> = {}): Rumor => ({
  id: 'reaction-' + 'cc'.repeat(28),
  pubkey: ALICE,
  created_at: NOW_S - 60,
  kind: 7,
  content: '👍',
  tags: [['e', ORIG], ['k', '9']],
  ...overrides,
});

const SCENARIOS: Scenario[] = [
  {
    name: 'reaction to a known message',
    seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
    rumor: () => reaction(),
  },
  {
    name: 'reaction removal',
    seed: async (m) => {
      await m.chat.appendMessage(GROUP, original());
      await m.reactions.applyInboundRumor({ kind: 'group', groupId: GROUP }, reaction({ id: 'earlier-' + 'dd'.repeat(28) }));
    },
    rumor: () => reaction({ content: '-', tags: [['e', ORIG], ['emoji', '👍']] }),
  },
  {
    name: 'delete of a known message',
    seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
    rumor: (m) => m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S - 30, ALICE_PRIV) as Rumor,
  },
  {
    name: 'delete of a not-yet-known message (buffered)',
    seed: async () => {},
    rumor: (m) => m.rumors.buildDeleteRumor(ORIG, ['prior-' + 'ef'.repeat(29)], 9, NOW_S - 30, ALICE_PRIV) as Rumor,
  },
  {
    name: 'edit of a known message',
    seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
    rumor: (m) => m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'edited', 9, NOW_S - 30, ALICE_PRIV) as Rumor,
  },
  {
    name: 'edit of a not-yet-known message (buffered)',
    seed: async () => {},
    rumor: (m) => m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'edited', 9, NOW_S - 30, ALICE_PRIV) as Rumor,
  },
  {
    name: 'delete whose sweep materializes another expired buffered delete',
    seed: async (m) => {
      await m.chat.appendMessage(GROUP, original());
      // A delete for a target that never arrived, buffered 2 days ago (past TTL).
      const day = 24 * 60 * 60;
      const old = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS - 2 * day * 1000);
      await m.edits.applyDeleteEditSignal(
        { kind: 'group', groupId: GROUP },
        m.rumors.buildDeleteRumor('gone-' + 'ab'.repeat(29), [], 9, NOW_S - 2 * day, ALICE_PRIV) as never,
        { pubkey: ALICE, authenticity: 'mls' },
      );
      old.mockReturnValue(NOW_MS);
    },
    rumor: (m) => m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S - 30, ALICE_PRIV) as Rumor,
  },
];

/** Seeds, then handles the rumor once in a fresh session; returns that session's journal. */
async function firstSession(s: Scenario, failAt: number | null, mode: 'reject' | 'commit-then-reject') {
  io.idb.clear();
  io.ops = [];
  io.failAt = null;
  const m = await boot();
  await s.seed(m);
  const rumor = s.rumor(m);
  const journal = makeJournal();
  journal.put(rumor);
  const group = makeGroup();
  const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(group, ctx);
  io.failAt = failAt;
  io.mode = mode;
  io.counting = true;
  try {
    group.deliver(rumor);
    await sub.drain();
  } finally {
    io.counting = false;
    io.failAt = null;
    sub();
  }
  return { journal, rumor, ops: [...io.ops] };
}

/** The next subscription (a fresh session) replays what the journal kept. */
async function nextSession(journal: ReturnType<typeof makeJournal>) {
  const m = await boot();
  const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(makeGroup(), ctx);
  await sub.replay([...journal.entries.values()]);
  sub();
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  io.counting = false;
  io.failAt = null;
  io.commitThenFailSetKey = null;
  io.failAllGets = false;
  io.pinTxnFailGet = false;
  io.pinTxnFailCommit = false;
});

describe.each(SCENARIOS)('$name', (s) => {
  it('a storage step failing once keeps the rumor journaled; the next subscription converges on the clean outcome', async () => {
    const clean = await firstSession(s, null, 'reject');
    expect(clean.journal.entries.size).toBe(0); // clean run acked
    const expected = snapshot();
    expect(clean.ops.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();

    const cases: Array<[number, 'reject' | 'commit-then-reject']> = [];
    clean.ops.forEach((op, i) => {
      cases.push([i, 'reject']);
      if (op.startsWith('set')) cases.push([i, 'commit-then-reject']);
    });

    for (const [i, mode] of cases) {
      const label = `step ${i} (${clean.ops[i]}) ${mode}`;
      const run = await firstSession(s, i, mode);
      expect(run.ops[i], label).toBe(clean.ops[i]); // the injected step was reached
      expect(run.journal.entries.has(run.rumor.id), `${label}: must stay journaled`).toBe(true);
      expect(run.journal.ack, label).not.toHaveBeenCalled();

      await nextSession(run.journal);
      expect(run.journal.entries.size, `${label}: acked after replay`).toBe(0);
      expect(snapshot(), `${label}: converged`).toEqual(expected);
    }
  });
});

describe('the failed write is visible as a rejection, not a silent drop', () => {
  it('a reaction whose write fails is applied by the next subscription (success signal of the finding)', async () => {
    const s = SCENARIOS[0];
    const clean = await firstSession(s, null, 'reject');
    const writeStep = clean.ops.findIndex((op) => op === `set few:reactions:group:${GROUP}`);
    expect(writeStep).toBeGreaterThanOrEqual(0);

    const run = await firstSession(s, writeStep, 'reject');
    expect(io.idb.get(`few:reactions:group:${GROUP}`)).toBeUndefined(); // lost for now
    expect(warn).toHaveBeenCalledWith('[dispatcher.7]', expect.any(Error));

    await nextSession(run.journal);
    const rows = io.idb.get(`few:reactions:group:${GROUP}`) as Array<{ eventId: string; emoji: string; removed: boolean }>;
    expect(rows).toEqual([expect.objectContaining({ eventId: run.rumor.id, emoji: '👍', removed: false })]);
  });
});

describe('invalid input is acked on the first attempt (never retried)', () => {
  const cases: Array<{ name: string; seed: (m: Modules) => Promise<void>; rumor: (m: Modules) => Rumor }> = [
    {
      name: 'reaction without an e-tag',
      seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
      rumor: () => reaction({ tags: [['k', '9']] }),
    },
    {
      name: 'reaction to an unknown message',
      seed: async () => {},
      rumor: () => reaction(),
    },
    {
      name: 'delete of another author\'s message',
      seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
      rumor: (m) => m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S - 30, MALLORY_PRIV) as Rumor,
    },
    {
      name: 'edit-marked kind 5 companion (discarded by classification)',
      seed: async (m) => void (await m.chat.appendMessage(GROUP, original())),
      rumor: (m) => m.rumors.buildEditMarkedCompanionKind5(ORIG, [], 9, NOW_S - 30, ALICE_PRIV) as Rumor,
    },
  ];

  it.each(cases)('$name', async (c) => {
    await firstSession({ name: c.name, seed: c.seed, rumor: c.rumor }, null, 'reject').then(async (run) => {
      expect(run.journal.entries.size).toBe(0);
      expect(run.journal.ack).toHaveBeenCalledWith(GROUP, run.rumor.id);
    });
    expect(io.idb.has(`few:reactions:group:${GROUP}`)).toBe(false);
    const messages = io.idb.get(`few:messages:${GROUP}`) as Array<{ tombstoned?: boolean }> | undefined;
    expect((messages ?? []).some((r) => r.tombstoned)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Remediation round 1 (Codex MEDIUM): a far-future signal's rev is capped
 * against the clock at processing time. Before the fix, a replay at a later
 * time recomputed a HIGHER rev and could overwrite an edit that had
 * legitimately beaten the first application. The capped rev is now pinned per
 * rumor, so the replay uses the first rev.
 */
describe('a replayed far-future delete/edit keeps its first rev', () => {
  const HOUR = 3600;
  const SLOT_META = 'few:messageEditsSlotMeta:v1';

  type Signal = { name: string; build: (m: Modules) => Rumor; check: (row: Record<string, unknown>) => void };
  const SIGNALS: Signal[] = [
    {
      name: 'delete (kind 5)',
      build: (m) => m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S + 10 * HOUR, ALICE_PRIV) as Rumor,
      check: (row) => expect(row.tombstoned).toBe(true),
    },
    {
      name: 'edit (edit-marked kind 9)',
      build: (m) => m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'far-future edit', 9, NOW_S + 10 * HOUR, ALICE_PRIV) as Rumor,
      check: (row) => expect(row.content).toBe('far-future edit'),
    },
  ];

  const storedRow = () => (io.idb.get(`few:messages:${GROUP}`) as Array<Record<string, unknown>>).find((r) => r.id === ORIG)!;

  /** Session 1 at NOW: the signal's message write lands, its slot-meta write fails. */
  async function applyWithFailedSlotMeta(signal: Signal) {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const rumor = signal.build(m);
    const journal = makeJournal();
    journal.put(rumor);
    const group = makeGroup();
    const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(group, ctx);
    io.commitThenFailSetKey = SLOT_META;
    group.deliver(rumor);
    await sub.drain();
    sub();
    expect(journal.entries.has(rumor.id)).toBe(true); // kept for replay
    signal.check(storedRow()); // the message write landed
    expect(storedRow().rev).toBe(NOW_S + 6 * HOUR); // capped at first processing
    return journal;
  }

  /** A fresh session at `nowMs` handles `rumor` live (own journal, acked). */
  async function deliverLive(nowMs: number, build: (m: Modules) => Rumor) {
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(nowMs);
    const m = await boot();
    const journal = makeJournal();
    const rumor = build(m);
    journal.put(rumor);
    const group = makeGroup();
    const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(group, ctx);
    group.deliver(rumor);
    await sub.drain();
    sub();
    expect(journal.entries.size).toBe(0);
  }

  it.each(SIGNALS)('$name: an edit that beat it in between is not overwritten by the replay; the rev is unchanged', async (signal) => {
    const journal = await applyWithFailedSlotMeta(signal);

    // 3 h later the author edits again (rev NOW+7h > the pinned NOW+6h).
    const between = NOW_S + 7 * HOUR;
    await deliverLive(NOW_MS + 3 * HOUR * 1000, (m) =>
      m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'later edit', 9, between, ALICE_PRIV) as Rumor,
    );
    expect(storedRow()).toMatchObject({ content: 'later edit', rev: between, tombstoned: false });

    // 5 h after the first processing the journal replays the signal. Its own
    // rev (NOW+10h) is no longer capped now — unpinned it would win.
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(NOW_MS + 5 * HOUR * 1000);
    await nextSession(journal);

    expect(journal.entries.size).toBe(0); // acked
    expect(storedRow()).toMatchObject({ content: 'later edit', rev: between, tombstoned: false });
  });

  it.each(SIGNALS)('$name: without an intervening edit the replay re-applies at the first rev (never raised)', async (signal) => {
    const journal = await applyWithFailedSlotMeta(signal);
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(NOW_MS + 5 * HOUR * 1000);
    await nextSession(journal);
    expect(journal.entries.size).toBe(0);
    signal.check(storedRow());
    expect(storedRow().rev).toBe(NOW_S + 6 * HOUR);
  });

  it('an uncapped signal is not pinned (no extra write); a capped one is pinned once', async () => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const thread = { kind: 'group' as const, groupId: GROUP };
    const sender = { pubkey: ALICE, authenticity: 'mls' as const };
    await m.edits.applyDeleteEditSignal(thread, m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'a', 9, NOW_S - 5, ALICE_PRIV) as never, sender);
    expect(io.idb.has('few:messageEditsPinnedRevs:v1')).toBe(false);
    const far = m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'b', 9, NOW_S + 10 * HOUR, ALICE_PRIV);
    await m.edits.applyDeleteEditSignal(thread, far as never, sender);
    await m.edits.applyDeleteEditSignal(thread, far as never, sender);
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual([
      { threadKey: GROUP, rumorId: far.id, rev: NOW_S + 6 * HOUR, receivedAt: NOW_MS },
    ]);
  });

  it('an uncapped delete (rev at or below the ceiling) is not pinned', async () => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const atCeiling = m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S + 6 * HOUR, ALICE_PRIV);
    await m.edits.applyDeleteEditSignal({ kind: 'group', groupId: GROUP }, atCeiling as never, { pubkey: ALICE, authenticity: 'mls' });
    expect(storedRow()).toMatchObject({ tombstoned: true, rev: NOW_S + 6 * HOUR });
    expect(io.idb.has('few:messageEditsPinnedRevs:v1')).toBe(false);
  });

  it('a pin is scoped to its thread: the same rumor id in another thread uses its own rev', async () => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const edit = m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'own rev', 9, NOW_S - 5, ALICE_PRIV);
    io.idb.set('few:messageEditsPinnedRevs:v1', [{ threadKey: 'other-group', rumorId: edit.id, rev: 3, receivedAt: 1 }]);
    await m.edits.applyDeleteEditSignal({ kind: 'group', groupId: GROUP }, edit as never, { pubkey: ALICE, authenticity: 'mls' });
    expect(storedRow()).toMatchObject({ content: 'own rev', rev: NOW_S - 5 });
  });

  it('clearing a thread without pins writes no pin store', async () => {
    io.idb.clear();
    const m = await boot();
    await m.edits.clearMessageEditsStateForThread(GROUP);
    expect(io.idb.has('few:messageEditsPinnedRevs:v1')).toBe(false);
  });

  it.each([
    ['its read fails', 'pinTxnFailGet'],
    ['its commit aborts', 'pinTxnFailCommit'],
  ] as const)('the pin transaction failing (%s) rejects before any effect; the replay pins and applies', async (_label, flag) => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const rumor = SIGNALS[1].build(m);
    const journal = makeJournal();
    journal.put(rumor);
    const group = makeGroup();
    const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(group, ctx);
    io[flag] = true;
    group.deliver(rumor);
    await sub.drain();
    sub();
    io[flag] = false;
    expect(journal.entries.has(rumor.id)).toBe(true);
    expect(storedRow()).toMatchObject({ content: 'hello' }); // nothing applied
    expect(io.idb.has('few:messageEditsPinnedRevs:v1')).toBe(false);

    await nextSession(journal);
    expect(journal.entries.size).toBe(0);
    expect(storedRow()).toMatchObject({ content: 'far-future edit', rev: NOW_S + 6 * HOUR });
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual([
      { threadKey: GROUP, rumorId: rumor.id, rev: NOW_S + 6 * HOUR, receivedAt: NOW_MS },
    ]);
  });

  it('clearing a thread that has no pins opens no pin transaction (other threads\' pins untouched)', async () => {
    io.idb.clear();
    const m = await boot();
    const others = [{ threadKey: 'other-group', rumorId: 'x', rev: 1, receivedAt: 1 }];
    io.idb.set('few:messageEditsPinnedRevs:v1', others);
    io.pinTxnFailCommit = true; // any pin transaction would reject
    await expect(m.edits.clearMessageEditsStateForThread(GROUP)).resolves.toBeUndefined();
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual(others);
  });

  it('one session opens the pin transaction store once', async () => {
    io.idb.clear();
    const m = await boot();
    const idb = await import('idb-keyval');
    await m.chat.appendMessage(GROUP, original());
    vi.mocked(idb.createStore).mockClear();
    const thread = { kind: 'group' as const, groupId: GROUP };
    for (const content of ['one', 'two']) {
      const far = m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, content, 9, NOW_S + 10 * HOUR, ALICE_PRIV);
      await m.edits.applyDeleteEditSignal(thread, far as never, { pubkey: ALICE, authenticity: 'mls' });
    }
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toHaveLength(2);
    expect(vi.mocked(idb.createStore)).toHaveBeenCalledTimes(1);
  });

  it('a failed pin cleanup transaction rejects the thread clear and keeps the pin', async () => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    await m.edits.applyDeleteEditSignal({ kind: 'group', groupId: GROUP }, SIGNALS[1].build(m) as never, { pubkey: ALICE, authenticity: 'mls' });
    io.pinTxnFailCommit = true;
    await expect(m.edits.clearMessageEditsStateForThread(GROUP)).rejects.toBeDefined();
    io.pinTxnFailCommit = false;
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toHaveLength(1);
    await m.edits.clearMessageEditsStateForThread(GROUP);
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual([]);
  });

  it('pins are cleared with the thread\'s other edit state', async () => {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const thread = { kind: 'group' as const, groupId: GROUP };
    const far = m.rumors.buildEditReplacementRumor(ORIG, NOW_S - 600, 'b', 9, NOW_S + 10 * HOUR, ALICE_PRIV);
    await m.edits.applyDeleteEditSignal(thread, far as never, { pubkey: ALICE, authenticity: 'mls' });
    io.idb.set('few:messageEditsPinnedRevs:v1', [
      ...(io.idb.get('few:messageEditsPinnedRevs:v1') as unknown[]),
      { threadKey: 'other-group', rumorId: 'x', rev: 1, receivedAt: 1 },
    ]);
    await m.edits.clearMessageEditsStateForThread(GROUP);
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual([{ threadKey: 'other-group', rumorId: 'x', rev: 1, receivedAt: 1 }]);
    await m.edits.clearAllMessageEditsState();
    expect(io.idb.get('few:messageEditsPinnedRevs:v1')).toEqual([]);
  });
});

/**
 * Remediation round 1 (Codex LOW): a permanently-invalid signal is acked on
 * its first attempt even while every storage read fails — its validity is
 * decided before the self-heal sweep, which is best-effort for it. An
 * otherwise well-formed signal whose AUTHORIZATION needs the target row
 * cannot be judged without storage: it is retried, never applied.
 */
describe('invalid delete/edit signals are acked during a storage read outage', () => {
  const invalid: Array<{ name: string; rumor: (m: Modules) => Rumor }> = [
    { name: 'edit-marked kind-5 companion', rumor: (m) => m.rumors.buildEditMarkedCompanionKind5(ORIG, [], 9, NOW_S - 30, ALICE_PRIV) as Rumor },
    { name: 'kind 5 without e-tags', rumor: () => ({ id: 'no-e-' + 'ab'.repeat(28), pubkey: ALICE, created_at: NOW_S - 30, kind: 5, tags: [['k', '9']], content: '' }) },
    { name: 'kind 5 with a malformed rev', rumor: () => ({ id: 'bad-rev-' + 'ab'.repeat(27), pubkey: ALICE, created_at: 0, kind: 5, tags: [['e', ORIG]], content: '' }) },
    { name: 'edit with empty content', rumor: () => ({ id: 'empty-' + 'ab'.repeat(28), pubkey: ALICE, created_at: NOW_S - 30, kind: 9, tags: [['e', ORIG, '', 'edit'], ['rev', String(NOW_S - 30)]], content: '' }) },
    { name: 'edit with a malformed rev', rumor: () => ({ id: 'edit-rev-' + 'ab'.repeat(27), pubkey: ALICE, created_at: NOW_S - 30, kind: 9, tags: [['e', ORIG, '', 'edit'], ['rev', 'soon']], content: 'x' }) },
  ];

  async function handleDuringOutage(build: (m: Modules) => Rumor) {
    io.idb.clear();
    const m = await boot();
    await m.chat.appendMessage(GROUP, original());
    const rumor = build(m);
    const journal = makeJournal();
    journal.put(rumor);
    const group = makeGroup();
    const sub = m.createDispatcher(handlersFor(m), { journal }).subscribe(group, ctx);
    io.failAllGets = true;
    group.deliver(rumor);
    await sub.drain();
    sub();
    io.failAllGets = false;
    return { journal, rumor };
  }

  it.each(invalid)('$name: acked on the first attempt; the failed sweep is only warned', async (c) => {
    const { journal, rumor } = await handleDuringOutage(c.rumor);
    expect(journal.ack).toHaveBeenCalledWith(GROUP, rumor.id);
    expect(journal.recordFailure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[messageEdits] self-heal sweep failed (discarded signal)', expect.any(Error));
    expect(storedOriginal()).toMatchObject({ content: 'hello' });
    expect(storedOriginal().tombstoned).toBeUndefined();
  });

  it('a well-formed delete by another member needs the target row to be judged: retried (never applied) during the outage, acked once storage reads', async () => {
    const { journal, rumor } = await handleDuringOutage((m) => m.rumors.buildDeleteRumor(ORIG, [], 9, NOW_S - 30, MALLORY_PRIV) as Rumor);
    expect(journal.entries.has(rumor.id)).toBe(true);
    expect(journal.recordFailure).toHaveBeenCalledTimes(1);
    await nextSession(journal);
    expect(journal.entries.size).toBe(0);
    expect(storedOriginal().tombstoned).toBeUndefined();
  });

  const storedOriginal = () => (io.idb.get(`few:messages:${GROUP}`) as Array<Record<string, unknown>>).find((r) => r.id === ORIG)!;
});
