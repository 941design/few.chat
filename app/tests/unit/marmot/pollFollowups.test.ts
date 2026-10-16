/**
 * Poll follow-ups (bug: poll-followups, 2026-10-16):
 *
 *   1  held poll-state sweep (createHeldPollStateSweeper + listHeldPollIds):
 *      a close / results summary held after a storage failure is applied at the
 *      next (re)subscription, with no further message of the poll.
 *   2  held-close-aware pruning of kept votes (keptVotes cut-offs).
 *   3  superseded snapshots dropped by the closed-poll write (savePoll).
 *   4  receipt-clock seed read retried with a bounded backoff.
 *   5  queuePendingVote reports whether it held the vote; handleVote's
 *      save-failure fallback warns when the cap dropped it.
 *
 * Runs the real handlers and the real idb-keyval over fake-indexeddb.
 * idb-keyval's get/set/del are pass-through spies so every storage step can be
 * failure-injected; assertions read stored state.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Faults and logs for the read-check-write transactions (pollPersistence
// pollTxn, through createStore): failGet(key) turns a read into a request
// error (the transaction aborts unless the reader handles it); failPut(key)
// aborts the transaction at that put. txnReads / txnPuts log the keys.
const tx = vi.hoisted(() => ({
  failGet: null as null | ((key: string) => boolean),
  failPut: null as null | ((key: string) => boolean),
  failDelete: null as null | ((key: string) => boolean),
  failAllKeys: false,
  /** Runs inside each transaction's callback, before its body (to start racing work). */
  onTxnStart: null as null | ((mode: IDBTransactionMode) => void),
  reads: [] as string[],
  puts: [] as string[],
  deletes: [] as string[],
  /** One entry per transaction: its mode and the keys it deleted. */
  txns: [] as { mode: IDBTransactionMode; deletes: string[] }[],
}));

// Cross-tab notices are observed (posted only after a write landed).
vi.mock('@/src/lib/crossTab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/crossTab')>()),
  postStoreChanged: vi.fn(),
}));

vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    get: vi.fn(real.get),
    set: vi.fn(real.set),
    del: vi.fn(real.del),
    createStore: vi.fn((db: string, name: string) => {
      const inner = real.createStore(db, name);
      const wrapped: import('idb-keyval').UseStore = (mode, callback) =>
        inner(mode, (os) => {
          const record = { mode, deletes: [] as string[] };
          tx.txns.push(record);
          tx.onTxnStart?.(mode);
          const proxy = {
            transaction: os.transaction,
            get(key: string) {
              tx.reads.push(key);
              const req = os.get(key);
              if (!tx.failGet?.(key)) return req;
              // Deliver the real success as a request error (txn still active).
              const fake = { result: undefined, onsuccess: null as null | (() => void), onerror: null as null | ((e: unknown) => void) };
              req.onsuccess = () => {
                let prevented = false;
                fake.onerror?.({ preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
                if (!prevented) os.transaction.abort();
              };
              return fake;
            },
            delete(key: string) {
              tx.deletes.push(key);
              record.deletes.push(key);
              if (tx.failDelete?.(key)) {
                os.transaction.abort();
                return {};
              }
              return os.delete(key);
            },
            getAllKeys() {
              const req = os.getAllKeys();
              if (!tx.failAllKeys) return req;
              const fake = { result: undefined, onsuccess: null as null | (() => void), onerror: null as null | ((e: unknown) => void) };
              req.onsuccess = () => os.transaction.abort();
              return fake;
            },
            put(value: unknown, key: string) {
              tx.puts.push(key);
              if (tx.failPut?.(key)) {
                os.transaction.abort();
                return {};
              }
              return os.put(value, key);
            },
          };
          return callback(proxy as unknown as IDBObjectStore);
        });
      return wrapped;
    }),
  };
});

const idb = await import('idb-keyval');
const real = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
const getFn = idb.get as unknown as ReturnType<typeof vi.fn>;
const setFn = idb.set as unknown as ReturnType<typeof vi.fn>;

const persistence = await import('@/src/lib/marmot/pollPersistence');
const {
  savePoll, getPoll, loadVotes, saveVoteIfNewer, clearAllPollData, clearPollData,
  queuePendingVote, loadPendingVotes, removePendingVotes,
  queuePendingClose, loadPendingCloses, removePendingCloses,
  queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
  listHeldPollIds, keptVotes, voteAsOf, MAX_VOTES_KEPT_PER_VOTER, MAX_PENDING_VOTES_PER_VOTER, PENDING_VOTE_TTL_MS,
} = persistence;
const { postStoreChanged } = await import('@/src/lib/crossTab');
const postFn = postStoreChanged as unknown as ReturnType<typeof vi.fn>;
const { guardDeps, MaintenanceCancelled } = await import('@/src/lib/marmot/handlers/pollHandler');
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler, createHeldCloseSettler, createHeldPollStateSweeper } =
  await import('@/src/lib/marmot/handlers/pollHandler');
const { createChatHandler, createPollCloseAnnouncementReplayer } = await import('@/src/lib/marmot/handlers/chatHandler');
const { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND } = await import('@/src/lib/marmot/pollSync');

type Poll = import('@/src/lib/marmot/pollPersistence').Poll;
type PollVote = import('@/src/lib/marmot/pollPersistence').PollVote;

const CREATOR = 'aa'.repeat(32);
const USER = '11'.repeat(32);
const OTHER = '22'.repeat(32);
const GROUP = 'a1'.repeat(16);
const POLL_ID = 'poll-f';
const POLL_2 = 'poll-g';

const VOTES_KEY = `few:poll-votes:${GROUP}:${POLL_ID}`;
const POLLS_KEY = `few:polls:${GROUP}`;
const CLOSES_KEY = `few:poll-pending-closes:${GROUP}`;

let rumorSeq = 0;
function rumor(kind: number, pubkey: string, content: unknown, createdAtSec = 1_700_000_000, id = `r-${String(rumorSeq++).padStart(4, '0')}`) {
  return { id, pubkey, created_at: createdAtSec, kind, content: JSON.stringify(content), tags: [] as string[][] };
}
const ctx = () => ({ groupId: GROUP, selfPubkeyHex: 'cc'.repeat(32), getActiveGroupId: () => null });
const sender = (pubkey: string) => ({ pubkey, authenticity: 'mls' as const });
const openPayload = (id = POLL_ID) => ({
  id, title: 'Best color?', options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }], pollType: 'singlechoice', creatorPubkey: CREATOR,
});

function realDeps() {
  return {
    savePoll, getPoll, loadVotes, saveVoteIfNewer,
    queuePendingVote, loadPendingVotes, removePendingVotes,
    queuePendingClose, loadPendingCloses, removePendingCloses,
    setPollVersion: vi.fn(),
  };
}
const voteRumor = (by: string, responses: string[], seq: number, pollId = POLL_ID, id?: string) =>
  rumor(POLL_VOTE_KIND, by, { pollId, responses, seq }, 1_700_000_000 + seq, id);
const closeRumor = (pollId = POLL_ID) => rumor(POLL_CLOSE_KIND, CREATOR, { pollId, results: [], totalVoters: 0 }, 1_700_000_500);
async function open(pollId = POLL_ID) {
  await createPollOpenHandler(realDeps() as never).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload(pollId)), ctx(), sender(CREATOR));
}
async function vote(by: string, responses: string[], seq: number, pollId = POLL_ID) {
  await createPollVoteHandler(realDeps() as never).handle(voteRumor(by, responses, seq, pollId), ctx(), sender(by));
}
const counts = (p: Poll | null) => Object.fromEntries((p?.results ?? []).map((r) => [r.optionId, r.count]));
const failClosedSave = () => ({ ...realDeps(), savePoll: vi.fn(async (p: Poll) => { if (p.closed) throw new Error('injected'); return savePoll(p); }) });

/** The creator's live close hits a storage failure at the closed write → held. */
async function closeHeldAfterFailure(pollId = POLL_ID) {
  await expect(createPollCloseHandler(failClosedSave() as never).handle(closeRumor(pollId), ctx(), sender(CREATOR))).rejects.toThrow('injected');
}

function chatDeps(rows: Map<string, { id: string; content: string }>) {
  const pollDeps = realDeps();
  return {
    appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => { if (rows.has(msg.id)) return false; rows.set(msg.id, msg); return true; }),
    incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
    resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
    isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
    getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
    queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    settleHeldCloses: createHeldCloseSettler(pollDeps as never),
  };
}

function sweeper(rows = new Map<string, { id: string; content: string }>(), extra: Record<string, unknown> = {}) {
  const deps = {
    ...realDeps(),
    replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chatDeps(rows) as never),
    listHeldPollIds: (g: string) => listHeldPollIds(g),
    ...extra,
  };
  return { sweep: createHeldPollStateSweeper(deps as never), deps, rows };
}

/** Fail idb get/set for keys matching `pred` until restored. */
function failKeys(fn: ReturnType<typeof vi.fn>, pred: (key: string) => boolean, impl: (...a: never[]) => unknown) {
  fn.mockImplementation(async (key: string, ...rest: unknown[]) => {
    if (pred(key)) throw new Error(`injected:${key}`);
    return (impl as (...a: unknown[]) => unknown)(key, ...rest);
  });
}

const delFn = idb.del as unknown as ReturnType<typeof vi.fn>;
const written = () => [...setFn.mock.calls.map(([k]) => k as string), ...delFn.mock.calls.map(([k]) => k as string), ...tx.puts];
const clearLogs = () => {
  setFn.mockClear(); getFn.mockClear(); delFn.mockClear(); postFn.mockClear();
  tx.reads.length = 0; tx.puts.length = 0; tx.deletes.length = 0; tx.txns.length = 0;
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  tx.failGet = null;
  tx.failPut = null;
  tx.failDelete = null;
  tx.failAllKeys = false;
  tx.onTxnStart = null;
  getFn.mockImplementation(real.get);
  setFn.mockImplementation(real.set);
  await real.clear();
  await clearAllPollData();
  rumorSeq = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  tx.failGet = null;
  tx.failPut = null;
  getFn.mockImplementation(real.get);
  setFn.mockImplementation(real.set);
});
const warned = (text: string) => warn.mock.calls.some((c: unknown[]) => c.map(String).join(' ').includes(text));

// ─── 1. held poll-state sweep ────────────────────────────────────────────────

describe('1: held poll-state sweep at (re)subscription', () => {
  it('a creator close held after a storage failure is applied by the sweep with no further poll message (success signal)', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    const { sweep, deps } = sweeper();
    await sweep(ctx());
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 1, B: 0 });
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
    expect(deps.setPollVersion).toHaveBeenCalled();
  });

  it('counts each vote as of the held close (a vote received after the close is excluded)', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    // Stored after the close while the held close could not be settled.
    await saveVoteIfNewer({ id: `${POLL_ID}:${OTHER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'late' });
    await sweeper().sweep(ctx());
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
  });

  it('replays a held results summary of a closed poll (the summary row appears, equal to the card)', async () => {
    await open();
    await vote(USER, ['B'], 1);
    await closeHeldAfterFailure();
    // The summary's own gate read fails → held.
    const rows = new Map<string, { id: string; content: string }>();
    const failing = { ...chatDeps(rows), getPoll: vi.fn(async () => { throw new Error('gate read'); }) };
    await expect(createChatHandler(failing as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann'), ctx(), sender(CREATOR),
    )).rejects.toThrow('gate read');
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
    await sweeper(rows).sweep(ctx());
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(rows.size).toBe(1);
    expect(JSON.parse(rows.get('ann')!.content)).toMatchObject({ results: poll?.results, totalVoters: poll?.totalVoters });
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('applies early votes held for an open stored poll', async () => {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'q' });
    await sweeper().sweep(ctx());
    expect((await loadVotes(GROUP, POLL_ID)).map((v) => v.responses)).toEqual([['A']]);
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
  });

  it('leaves the held state of a poll not stored yet untouched (it waits for the open)', async () => {
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 });
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'q' });
    const { sweep, deps } = sweeper();
    await sweep(ctx());
    noSweepWarnings();
    expect(await getPoll(GROUP, POLL_ID)).toBeNull();
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    expect(await loadPendingVotes(GROUP, POLL_ID)).toHaveLength(1);
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('a non-creator held close of a stored poll is discarded, the poll stays open', async () => {
    await open();
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: OTHER, closedAt: 1 });
    await sweeper().sweep(ctx());
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('with nothing held it reads nothing per poll and writes nothing', async () => {
    await open();
    const { sweep, deps } = sweeper(undefined, { getPoll: vi.fn(getPoll) });
    clearLogs();
    await sweep(ctx());
    expect(deps.getPoll).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
    noSweepWarnings();
  });

  it('failure injection: listing the held state fails → resolves, warns, nothing changes; the next sweep applies it', async () => {
    await open();
    await closeHeldAfterFailure();
    await expect(sweeper(undefined, { listHeldPollIds: vi.fn(async () => { throw new Error('list'); }) }).sweep(ctx())).resolves.toBeUndefined();
    expect(warned('listing held poll state failed')).toBe(true);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    await sweeper().sweep(ctx());
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
  });

  it('failure injection: a poll read fails → that poll stays held, the next poll is still swept', async () => {
    await open();
    await open(POLL_2);
    await closeHeldAfterFailure();
    await closeHeldAfterFailure(POLL_2);
    const getPollFlaky = vi.fn(async (g: string, p: string) => { if (p === POLL_ID) throw new Error('read'); return getPoll(g, p); });
    await sweeper(undefined, { getPoll: getPollFlaky }).sweep(ctx());
    expect(warned('reading a poll with held state failed')).toBe(true);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    expect((await getPoll(GROUP, POLL_2))?.closed).toBe(true);
  });

  it('failure injection: the closed write fails in the sweep → the poll stays open and the close held (stored state is truth); a later sweep closes it', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    tx.failPut = (k) => k === POLLS_KEY;
    await expect(sweeper().sweep(ctx())).resolves.toBeUndefined();
    tx.failPut = null;
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    await sweeper().sweep(ctx());
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
  });

  it('failure injection: the held-close read fails → nothing is written (indeterminate ≠ rejection), the close stays held', async () => {
    await open();
    await closeHeldAfterFailure();
    failKeys(getFn, (k) => k === CLOSES_KEY, real.get);
    const { sweep, deps } = sweeper(undefined, { listHeldPollIds: vi.fn(async () => [POLL_ID]) });
    clearLogs();
    await sweep(ctx());
    getFn.mockImplementation(real.get);
    expect(written().filter((k) => k === POLLS_KEY)).toEqual([]);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('failure injection: removing the applied held close fails → the poll is closed anyway; the stale entry is removed by the next sweep without re-closing', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    failKeys(setFn, (k) => k === CLOSES_KEY, real.set);
    failKeys(delFn, (k) => k === CLOSES_KEY, real.del);
    await sweeper().sweep(ctx());
    setFn.mockImplementation(real.set);
    delFn.mockImplementation(real.del);
    const closed = await getPoll(GROUP, POLL_ID);
    expect(closed?.closed).toBe(true);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    const { sweep, deps } = sweeper();
    await sweep(ctx());
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
    expect(await getPoll(GROUP, POLL_ID)).toEqual(closed);
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });

  it('is idempotent: a second sweep changes nothing', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    await sweeper().sweep(ctx());
    const after = await getPoll(GROUP, POLL_ID);
    clearLogs();
    await sweeper().sweep(ctx());
    expect(await getPoll(GROUP, POLL_ID)).toEqual(after);
    expect(written()).toEqual([]);
  });
});

describe('1: listHeldPollIds', () => {
  it('unions the three queues, each poll once, live entries only', async () => {
    const now = Date.now();
    await queuePendingClose({ groupId: GROUP, pollId: 'c', closerPubkey: CREATOR, closedAt: 1 }, now);
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: 'a', senderPubkey: CREATOR, rumorId: 'x', createdAt: 1 }, now);
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: 'c', senderPubkey: CREATOR, rumorId: 'y', createdAt: 1 }, now);
    await queuePendingVote({ groupId: GROUP, pollId: 'v', voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1 }, now);
    await queuePendingVote({ groupId: GROUP, pollId: 'old', voterPubkey: OTHER, responses: ['A'], votedAt: 1, seq: 1 }, now - PENDING_VOTE_TTL_MS - 1);
    await queuePendingClose({ groupId: 'ff'.repeat(16), pollId: 'other-group', closerPubkey: CREATOR, closedAt: 1 }, now);
    expect(await listHeldPollIds(GROUP, now)).toEqual(['c', 'a', 'v']);
    expect(await listHeldPollIds('ee'.repeat(16), now)).toEqual([]);
  });

  it.each([
    ['votes', `few:poll-pending-votes:${GROUP}`],
    ['closes', CLOSES_KEY],
    ['announcements', `few:poll-pending-close-announcements:${GROUP}`],
  ])('rejects when the %s queue cannot be read', async (_l, key) => {
    failKeys(getFn, (k) => k === key, real.get);
    await expect(listHeldPollIds(GROUP)).rejects.toThrow('injected');
  });
});

// ─── 2. held-close-aware pruning ─────────────────────────────────────────────

describe('2: keptVotes with held-close cut-offs', () => {
  const snap = (seq: number, receivedAt: number) => ({ seq, receivedAt, responses: ['A'], votedAt: 1, rumorId: `r${seq}` });
  const CAP = MAX_VOTES_KEPT_PER_VOTER;

  it('keeps the vote a cut-off selects even when it is the earliest received; still at most the cap', () => {
    const votes = Array.from({ length: CAP + 3 }, (_, i) => snap(i + 1, 100 + i));
    const kept = keptVotes(votes, [100]);
    expect(kept).toHaveLength(CAP);
    expect(kept[0].seq).toBe(1);
    expect(kept.slice(1).map((v) => v.seq)).toEqual(votes.slice(-(CAP - 1)).map((v) => v.seq));
  });

  it('a cut-off before every vote or at the newest needs no extra vote (plain cap)', () => {
    const votes = Array.from({ length: CAP + 2 }, (_, i) => snap(i + 1, 100 + i));
    const plain = keptVotes(votes).map((v) => v.seq);
    expect(keptVotes(votes, [50]).map((v) => v.seq)).toEqual(plain);
    expect(keptVotes(votes, [10_000]).map((v) => v.seq)).toEqual(plain);
    expect(keptVotes(votes, [100 + CAP + 1]).map((v) => v.seq)).toEqual(plain);
  });

  it('exceeds the cap only by the cut-off votes (one per distinct cut-off), never drops the newest', () => {
    const votes = Array.from({ length: 3 * CAP }, (_, i) => snap(i + 1, 100 + i));
    const cutoffs = Array.from({ length: CAP + 4 }, (_, i) => 100 + i); // each selects a different vote
    const kept = keptVotes(votes, [...cutoffs, ...cutoffs]);
    expect(kept.map((v) => v.seq)).toEqual([...cutoffs.map((c) => c - 99), 3 * CAP]);
  });

  it('property: for every given cut-off and for "after everything", the kept set selects the same vote as the full set', () => {
    const toRow = (vs: ReturnType<typeof snap>[]) => {
      const [newest, ...rest] = [...vs].reverse();
      return { id: 'x', groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, ...newest, superseded: rest } as PollVote;
    };
    // Seeded generator (the repo has no property-testing library): 400 random
    // vote sets of up to 3 × the cap with random seqs / receipt times / cut-offs.
    let seed = 0x5eed;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let run = 0; run < 400; run++) {
      const votes = Array.from({ length: 1 + rand(3 * CAP) }, (_, i) => ({ ...snap(rand(61), rand(201)), rumorId: `r${i}` }));
      const cutoffs = Array.from({ length: rand(9) }, () => rand(211) - 5);
      const kept = keptVotes(votes, cutoffs);
      expect(kept.length).toBeLessThanOrEqual(Math.max(CAP, new Set(cutoffs).size + 1));
      // Baseline: every receipt time as a cut-off keeps every undominated vote.
      const all = keptVotes(votes, [...cutoffs, ...votes.map((v) => v.receivedAt)]);
      for (const c of [...cutoffs, Infinity]) {
        expect(voteAsOf(toRow(kept), c)?.rumorId ?? null).toBe(voteAsOf(toRow(all), c)?.rumorId ?? null);
      }
    }
  });
});

describe('2: the vote writes read held closes only when the cap bites, and survive that read failing', () => {
  const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };

  it('up to exactly the cap the held-close queue is not read; one more vote reads it', async () => {
    clearLogs();
    for (let seq = 1; seq <= MAX_VOTES_KEPT_PER_VOTER; seq++) {
      await saveVoteIfNewer({ ...base, responses: ['A'], seq, rumorId: `s${seq}`, receivedAt: 10 * seq });
    }
    expect(tx.reads.filter((k) => k === CLOSES_KEY)).toEqual([]);
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row.superseded).toHaveLength(MAX_VOTES_KEPT_PER_VOTER - 1);
    await saveVoteIfNewer({ ...base, responses: ['A'], seq: 99, rumorId: 's99', receivedAt: 10_000 });
    expect(tx.reads.filter((k) => k === CLOSES_KEY)).toHaveLength(1);
  });

  it('a stored set above the cap (kept for held closes) is not re-pruned by a re-delivery while those closes are held', async () => {
    const t = Date.now();
    await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 's1', receivedAt: t });
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 }, t + 1);
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: OTHER, closedAt: 1 }, t + 3);
    await saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 's2', receivedAt: t + 2 });
    for (let seq = 3; seq <= MAX_VOTES_KEPT_PER_VOTER + 5; seq++) {
      await saveVoteIfNewer({ ...base, responses: ['B'], seq, rumorId: `s${seq}`, receivedAt: t + 10 + seq });
    }
    const [row] = await loadVotes(GROUP, POLL_ID);
    const seqs = [...(row.superseded ?? []), row].map((v) => v.seq);
    expect(seqs).toHaveLength(MAX_VOTES_KEPT_PER_VOTER);
    expect(seqs.slice(0, 2)).toEqual([1, 2]); // the vote as of each held close
    clearLogs();
    expect(await saveVoteIfNewer({ ...base, responses: ['B'], seq: MAX_VOTES_KEPT_PER_VOTER + 5, rumorId: `s${MAX_VOTES_KEPT_PER_VOTER + 5}`, receivedAt: t + 1000 })).toBe(false);
    expect(written().filter((k) => k === VOTES_KEY)).toEqual([]);
  });

  it('failure injection: the held-close read fails → the vote is still stored (plain cap), warned', async () => {
    const t = Date.now();
    await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 's1', receivedAt: t });
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 }, t + 1);
    tx.failGet = (k) => k === CLOSES_KEY;
    for (let seq = 2; seq <= MAX_VOTES_KEPT_PER_VOTER + 1; seq++) {
      await saveVoteIfNewer({ ...base, responses: ['B'], seq, rumorId: `s${seq}`, receivedAt: t + 10 + seq });
    }
    tx.failGet = null;
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row.seq).toBe(MAX_VOTES_KEPT_PER_VOTER + 1);
    expect([...(row.superseded ?? []), row].map((v) => v.seq)).not.toContain(1);
    expect(warned('reading held closes for vote pruning failed')).toBe(true);
  });

  it('failure injection: the vote write itself fails → rejects (not swallowed), nothing stored', async () => {
    tx.failPut = (k) => k === VOTES_KEY;
    await expect(saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 's1', receivedAt: 1 })).rejects.toThrow('poll storage transaction aborted');
    tx.failPut = null;
    expect(await loadVotes(GROUP, POLL_ID)).toEqual([]);
  });
});

// ─── 3. superseded snapshots dropped at close ────────────────────────────────

describe('3: the closed-poll write drops superseded snapshots', () => {
  async function openWithChangedVote() {
    await open();
    await vote(USER, ['A'], 1);
    await vote(USER, ['B'], 2);
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row.superseded).toHaveLength(1);
  }

  it('after a live close the stored vote rows carry no superseded snapshots (success signal); the tally is unchanged', async () => {
    await openWithChangedVote();
    await createPollCloseHandler(realDeps() as never).handle(closeRumor(), ctx(), sender(CREATOR));
    const rows = await loadVotes(GROUP, POLL_ID);
    expect(rows).toHaveLength(1);
    expect('superseded' in rows[0]).toBe(false);
    expect(rows[0]).toMatchObject({ responses: ['B'], seq: 2 });
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 1 });
  });

  it('after a held close is applied by the sweep, too', async () => {
    await openWithChangedVote();
    await closeHeldAfterFailure();
    await sweeper().sweep(ctx());
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect((await loadVotes(GROUP, POLL_ID)).some((v) => 'superseded' in v)).toBe(false);
  });

  it('drops them from every row, also when another row has none', async () => {
    await openWithChangedVote();
    await vote(OTHER, ['A'], 1);
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await savePoll({ ...poll, closed: true, results: [], totalVoters: 0 });
    const rows = await loadVotes(GROUP, POLL_ID);
    expect(rows).toHaveLength(2);
    expect(rows.some((v) => 'superseded' in v)).toBe(false);
  });

  it('an open-poll write keeps them; a closed write with nothing to drop does not rewrite the votes', async () => {
    await openWithChangedVote();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await savePoll({ ...poll, title: 'renamed' });
    expect((await loadVotes(GROUP, POLL_ID))[0].superseded).toHaveLength(1);
    await savePoll({ ...poll, closed: true, results: [], totalVoters: 0 });
    clearLogs();
    await savePoll({ ...poll, closed: true, results: [], totalVoters: 0 });
    expect(written().filter((k) => k === VOTES_KEY)).toEqual([]);
  });

  it.each([
    ['the votes read', () => { tx.failGet = (k) => k === VOTES_KEY; }],
    ['the votes write', () => { tx.failPut = (k) => k === VOTES_KEY; }],
  ])('failure injection: %s fails → savePoll still resolves, the poll is stored closed, snapshots left in place (warned)', async (_l, inject) => {
    await openWithChangedVote();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    inject();
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).resolves.toMatchObject({ closed: true });
    tx.failGet = null;
    tx.failPut = null;
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect((await loadVotes(GROUP, POLL_ID))[0].superseded).toHaveLength(1);
    expect(warned('dropping superseded votes of a closed poll failed')).toBe(true);
  });

  it('failure injection: the closed poll write fails → rejects and the votes are not touched', async () => {
    await openWithChangedVote();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    tx.failPut = (k) => k === POLLS_KEY;
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).rejects.toBeTruthy();
    tx.failPut = null;
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect((await loadVotes(GROUP, POLL_ID))[0].superseded).toHaveLength(1);
  });
});

// ─── 4. receipt-clock seed retry ─────────────────────────────────────────────

describe('4: the receipt-clock seed read is retried with a bounded backoff', () => {
  const KEY = 'few:poll-receipt-clock';
  async function freshInstance() {
    vi.resetModules();
    return import('@/src/lib/marmot/pollPersistence');
  }
  // Reads of the mark, minus the one the first receipt's lease write makes.
  const seedReads = () => getFn.mock.calls.filter(([k]) => k === KEY).length - 1;

  it('seed read fails once + clock set back after a reload → the next receipt is still above the pre-reload mark (success signal)', async () => {
    const a = await freshInstance();
    const t1 = await a.receiptNow();
    const mark = (await real.get<number>(KEY))!;
    expect(mark).toBeGreaterThan(t1);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t1 - 3_600_000);
    try {
      const b = await freshInstance();
      getFn.mockClear();
      getFn.mockImplementationOnce(async () => { throw new Error('seed'); });
      const t2 = await b.receiptNow();
      expect(t2).toBeGreaterThan(mark);
      expect(seedReads()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails on all but the last attempt, then succeeds → still seeded in the same receipt', async () => {
    const b = await freshInstance();
    await real.set(KEY, Date.now() + 10 * b.RECEIPT_LEASE_MS);
    getFn.mockClear();
    for (let i = 0; i < b.RECEIPT_SEED_ATTEMPTS - 1; i++) getFn.mockImplementationOnce(async () => { throw new Error('seed'); });
    const t = await b.receiptNow();
    expect(t).toBeGreaterThan(Date.now() + 9 * b.RECEIPT_LEASE_MS);
    expect(seedReads()).toBe(b.RECEIPT_SEED_ATTEMPTS);
  });

  it('every attempt fails → the receipt is still handed out after a bounded wait (never blocks), warned; the next receipt seeds again', async () => {
    const b = await freshInstance();
    expect(b.RECEIPT_SEED_ATTEMPTS).toBe(3);
    const mark = Date.now() + 10 * b.RECEIPT_LEASE_MS;
    await real.set(KEY, mark);
    getFn.mockClear();
    getFn.mockImplementation(async (k: string) => { if (k === KEY) throw new Error('seed'); return real.get(k); });
    const started = Date.now();
    const t1 = await b.receiptNow();
    const waited = Date.now() - started;
    expect(seedReads()).toBe(b.RECEIPT_SEED_ATTEMPTS);
    expect(waited).toBeGreaterThanOrEqual(b.RECEIPT_SEED_RETRY_MS * 3 - 5); // 25 + 50 backoff
    expect(waited).toBeLessThan(1_000);
    expect(t1).toBeLessThan(mark); // the residual: unseeded until a read succeeds
    expect(warned('reading the receipt clock failed')).toBe(true);
    getFn.mockImplementation(real.get);
    const t2 = await b.receiptNow();
    expect(t2).toBeGreaterThan(mark - 1);
  });

  it('a successful seed is read once per page (no retry, no re-read)', async () => {
    const b = await freshInstance();
    getFn.mockClear();
    await b.receiptNow();
    await b.receiptNow();
    expect(seedReads()).toBe(1);
  });
});

// ─── 5. queuePendingVote result + handleVote fallback warning ────────────────

describe('5: queuePendingVote reports whether it held the vote', () => {
  const early = (pollId: string, seq = 1, voter = USER) =>
    ({ groupId: GROUP, pollId, voterPubkey: voter, responses: ['A'], votedAt: 1, seq, rumorId: `${pollId}-${seq}` });

  it('true when stored; true for a re-delivery already represented; false when the per-voter cap drops it (nothing stored)', async () => {
    expect(await queuePendingVote(early('p0'))).toBe(true);
    expect(await queuePendingVote(early('p0'))).toBe(true); // identical → collapses onto the kept entry
    expect(await queuePendingVote(early('p0', 0))).toBe(true); // older, later received → dominated, represented
    for (let i = 1; i < MAX_PENDING_VOTES_PER_VOTER; i++) expect(await queuePendingVote(early(`p${i}`))).toBe(true);
    expect(await queuePendingVote(early('p-over'))).toBe(false);
    expect(await loadPendingVotes(GROUP, 'p-over')).toEqual([]);
    expect(await queuePendingVote(early('p0', 2))).toBe(true); // a changed vote for a queued poll is still accepted
    expect(await queuePendingVote(early('p-over', 1, OTHER))).toBe(true); // another voter is unaffected
  });

  it('an identical re-delivery is held while other voters\' entries are queued too', async () => {
    expect(await queuePendingVote(early('p0', 1, OTHER))).toBe(true);
    expect(await queuePendingVote(early('p0'))).toBe(true);
    expect(await queuePendingVote(early('p0'))).toBe(true);
    expect((await loadPendingVotes(GROUP, 'p0')).map((e) => e.voterPubkey).sort()).toEqual([USER, OTHER].sort());
  });

  it('false when the group cap evicts the new entry itself (an explicitly earlier receipt) even though the voter has another kept entry', async () => {
    const t = Date.now();
    // The voter's newer vote, received at t.
    expect(await queuePendingVote(early('p0', 2), t)).toBe(true);
    // Fill the group to its cap with later-received entries of other voters (10 polls each).
    const voters = Array.from({ length: 20 }, (_, i) => (i + 0x30).toString(16).padStart(2, '0').repeat(32));
    let n = 0;
    for (const v of voters) for (let p = 0; p < MAX_PENDING_VOTES_PER_VOTER && n < persistence.MAX_PENDING_VOTES_PER_GROUP - 1; p++, n++) {
      await queuePendingVote(early(`f${p}`, 1, v), t + 1 + n);
    }
    // An older vote of the voter received earlier than everything: not dominated, but the oldest → evicted.
    expect(await queuePendingVote(early('p0', 1), t - 10)).toBe(false);
    expect((await loadPendingVotes(GROUP, 'p0')).map((e) => e.seq)).toEqual([2]);
  });

  it('failure injection: a failed queue write rejects (never reported as dropped)', async () => {
    failKeys(setFn, (k) => k.startsWith('few:poll-pending-votes:'), real.set);
    await expect(queuePendingVote(early('p0'))).rejects.toThrow('injected');
    setFn.mockImplementation(real.set);
    expect(await loadPendingVotes(GROUP, 'p0')).toEqual([]);
  });

  it('handleVote: save fails and the cap drops the fallback → warns and rethrows the save error (journal keeps it); nothing stored (success signal)', async () => {
    await open();
    for (let i = 0; i < MAX_PENDING_VOTES_PER_VOTER; i++) await queuePendingVote(early(`other-${i}`));
    const deps = { ...realDeps(), saveVoteIfNewer: vi.fn(async () => { throw new Error('idb write'); }) };
    await expect(createPollVoteHandler(deps as never).handle(voteRumor(USER, ['A'], 1), ctx(), sender(USER))).rejects.toThrow('idb write');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be held (early-vote cap reached)'), {
      groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, rumorId: expect.any(String),
    });
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
    expect(await loadVotes(GROUP, POLL_ID)).toEqual([]);
  });

  it('handleVote: save fails and the fallback holds it → no cap warning, still rethrows', async () => {
    await open();
    const deps = { ...realDeps(), saveVoteIfNewer: vi.fn(async () => { throw new Error('idb write'); }) };
    await expect(createPollVoteHandler(deps as never).handle(voteRumor(USER, ['A'], 1), ctx(), sender(USER))).rejects.toThrow('idb write');
    expect(warned('could not be held')).toBe(false);
    expect(await loadPendingVotes(GROUP, POLL_ID)).toHaveLength(1);
  });
});

// ─── Remediation round 1 ─────────────────────────────────────────────────────

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const pollRows = () => real.get(POLLS_KEY);
const voteRows = () => real.get(VOTES_KEY);

/**
 * open + the creator's close held after a failure + a stranded early vote
 * received before that close (queued afterwards with an earlier receipt, so
 * the close's own recovery did not already consume it).
 */
async function heldState() {
  await open();
  await closeHeldAfterFailure();
  await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'early' }, Date.now() - 1000);
  expect(await loadPendingVotes(GROUP, POLL_ID)).toHaveLength(1);
}
const noSweepWarnings = () => {
  for (const m of ['listing held poll state failed', 'reading a poll with held state failed', 'recovering held poll state failed']) expect(warned(m)).toBe(false);
};

/**
 * Pause the first call of deps[name] until released; returns the gate.
 * `after`: the call runs first and its RESULT is held back (a read that
 * completed before a purge, whose caller resumes after it).
 */
function pauseFirst(deps: Record<string, unknown>, name: string, after = false) {
  const reached = deferred();
  const release = deferred();
  const fn = deps[name] as (...a: unknown[]) => Promise<unknown>;
  let first = true;
  deps[name] = async (...a: unknown[]) => {
    if (!first) return fn(...a);
    first = false;
    const out = after ? await fn(...a) : undefined;
    reached.resolve();
    await release.promise;
    return after ? out : fn(...a);
  };
  return { reached: reached.promise, release: () => release.resolve() };
}

describe('R1 HIGH: a disposed or purged sweep writes nothing — no poll or vote rows reappear', () => {
  it.each(['listHeldPollIds', 'getPoll', 'loadPendingVotes', 'loadVotes', 'loadPendingCloses'])(
    'disposed + purged while %s is pending → the sweep stops; nothing is re-created',
    async (step) => {
      await heldState();
      let disposed = false;
      const { deps } = sweeper();
      const gate = pauseFirst(deps as never, step);
      const sweep = createHeldPollStateSweeper(deps as never);
      const running = sweep(ctx(), () => disposed);
      await gate.reached;
      disposed = true;
      await clearPollData(GROUP);
      clearLogs();
      gate.release();
      await running;
      expect(written()).toEqual([]);
      expect(await pollRows()).toBeUndefined();
      expect(await voteRows()).toBeUndefined();
      expect(await real.get(CLOSES_KEY)).toBeUndefined();
      expect(deps.setPollVersion).not.toHaveBeenCalled();
      noSweepWarnings();
    },
  );

  it.each(['listHeldPollIds', 'getPoll', 'loadPendingVotes', 'loadVotes', 'loadPendingCloses'])(
    'disposed (no purge) while %s is pending → no further write at all; everything stays held for the next subscription',
    async (step) => {
      await heldState();
      let disposed = false;
      const { deps } = sweeper();
      const gate = pauseFirst(deps as never, step);
      const running = createHeldPollStateSweeper(deps as never)(ctx(), () => disposed);
      await gate.reached;
      disposed = true;
      clearLogs();
      gate.release();
      await running;
      expect(written()).toEqual([]);
      expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
      expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
      expect(deps.setPollVersion).not.toHaveBeenCalled();
      noSweepWarnings();
      // The replacement subscription's sweep completes it.
      await sweeper().sweep(ctx());
      expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
    },
  );

  it.each(['loadPendingVotes', 'loadVotes'])(
    'purged WITHOUT disposal while %s is pending (its read already done) → storage refuses to re-create the poll or its vote rows (in-transaction existence check)',
    async (step) => {
      await heldState();
      const { deps } = sweeper();
      const gate = pauseFirst(deps as never, step, true);
      const running = createHeldPollStateSweeper(deps as never)(ctx(), () => false);
      await gate.reached;
      await clearPollData(GROUP);
      gate.release();
      await running;
      expect(await pollRows()).toBeUndefined();
      expect(await voteRows()).toBeUndefined();
      // (paused at loadVotes, the stranded vote was already stored — and bumped — before the purge)
      if (step === 'loadPendingVotes') expect(deps.setPollVersion).not.toHaveBeenCalled();
      if (step === 'loadVotes') expect(warned('poll no longer stored; close not applied')).toBe(true);
    },
  );

  it('storage level: a closed write for a poll that is not stored resolves null and writes nothing', async () => {
    await open();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await clearPollData(GROUP);
    clearLogs();
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).resolves.toBeNull();
    expect(written()).toEqual([]);
    expect(await pollRows()).toBeUndefined();
    expect(postFn).not.toHaveBeenCalled();
  });

  it('storage level: a replayed vote (requirePoll) for a poll that is not stored writes nothing; without requirePoll it still writes (live paths unchanged)', async () => {
    const v = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'x', receivedAt: 5 };
    expect(await saveVoteIfNewer(v, { requirePoll: true })).toBe(false);
    expect(await voteRows()).toBeUndefined();
    await open();
    expect(await saveVoteIfNewer(v, { requirePoll: true })).toBe(true);
    await clearPollData(GROUP);
    expect(await saveVoteIfNewer({ ...v, seq: 2, rumorId: 'y' })).toBe(true);
  });

  it('failure injection: the poll read inside the vote transaction fails → rejects, nothing written', async () => {
    await open();
    tx.failGet = (k) => k === POLLS_KEY;
    const v = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'x', receivedAt: 5 };
    await expect(saveVoteIfNewer(v, { requirePoll: true })).rejects.toBeTruthy();
    tx.failGet = null;
    expect(await voteRows()).toBeUndefined();
  });

  it('a cancelled sweep stops before the next poll', async () => {
    await heldState();
    await open(POLL_2);
    await closeHeldAfterFailure(POLL_2);
    let cancelled = false;
    const { deps } = sweeper();
    const setPollVersion = deps.setPollVersion as ReturnType<typeof vi.fn>;
    setPollVersion.mockImplementation(() => { cancelled = true; });
    await createHeldPollStateSweeper(deps as never)(ctx(), () => cancelled);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect((await getPoll(GROUP, POLL_2))?.closed).toBe(false);
  });
});

describe('R1 MEDIUM: closing is monotonic and idempotent at the storage layer (first close wins)', () => {
  it('a second closed write never overwrites the first; it resolves the stored (first) close', async () => {
    await open();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    const first = { ...poll, closed: true, results: [{ optionId: 'A', label: 'Red', count: 1 }, { optionId: 'B', label: 'Blue', count: 0 }], totalVoters: 1 };
    await expect(savePoll(first)).resolves.toEqual(first);
    postFn.mockClear();
    clearLogs();
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).resolves.toEqual(first);
    expect(written()).toEqual([]);
    expect(postFn).not.toHaveBeenCalled();
    expect(await getPoll(GROUP, POLL_ID)).toEqual(first);
  });

  it('two interleaved sweeps (old subscription with a stale view, then its replacement): the closed tally stays the first correct one', async () => {
    await heldState(); // USER's early vote 'A', received before the held creator close
    // Old sweep: its reads resolve a stale, pre-replay view (no votes at all).
    const old = sweeper();
    (old.deps as Record<string, unknown>).loadPendingVotes = vi.fn(async () => []);
    const oldLoadVotes = old.deps.loadVotes;
    (old.deps as Record<string, unknown>).loadVotes = vi.fn(async (...a: unknown[]) => { await (oldLoadVotes as (...x: unknown[]) => Promise<unknown>)(...a); return []; });
    const pausedOld = pauseFirst(old.deps as never, 'loadVotes');
    const runningOld = createHeldPollStateSweeper(old.deps as never)(ctx(), () => false);
    await pausedOld.reached;
    // The replacement subscription sweeps fully and closes with the right tally.
    await sweeper().sweep(ctx());
    const correct = await getPoll(GROUP, POLL_ID);
    expect(counts(correct)).toEqual({ A: 1, B: 0 });
    // The old one resumes with its stale (empty) tally → refused by storage.
    pausedOld.release();
    await runningOld;
    expect(await getPoll(GROUP, POLL_ID)).toEqual(correct);
  });

  it('a live close racing a held close keeps the first stored result; the handler resolves without overwriting', async () => {
    await open();
    await vote(USER, ['A'], 1);
    const poll = (await getPoll(GROUP, POLL_ID))!;
    const first = { ...poll, closed: true, results: [{ optionId: 'A', label: 'Red', count: 7 }, { optionId: 'B', label: 'Blue', count: 0 }], totalVoters: 7 };
    // A close the live handler did not see yet (stale read) lands first.
    const staleGetPoll = vi.fn(async () => poll);
    await savePoll(first);
    await createPollCloseHandler({ ...realDeps(), getPoll: staleGetPoll } as never).handle(closeRumor(), ctx(), sender(CREATOR));
    expect(await getPoll(GROUP, POLL_ID)).toEqual(first);
  });

  it('the held-close settler returns the STORED close (so a summary announces what the card shows)', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await closeHeldAfterFailure();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    const first = { ...poll, closed: true, results: [{ optionId: 'A', label: 'Red', count: 9 }, { optionId: 'B', label: 'Blue', count: 0 }], totalVoters: 9 };
    await savePoll(first);
    const settled = await createHeldCloseSettler(realDeps() as never)(poll, ctx());
    expect(settled).toEqual(first);
  });

  it('failure injection: the close transaction fails → rejects, the poll stays open, no notice', async () => {
    await open();
    const poll = (await getPoll(GROUP, POLL_ID))!;
    postFn.mockClear();
    tx.failGet = (k) => k === POLLS_KEY;
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).rejects.toBeTruthy();
    tx.failGet = null;
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(postFn).not.toHaveBeenCalled();
  });
});

describe('R1 MEDIUM: recovery that stores votes notifies the poll store (UI bump + cross-tab notice)', () => {
  it('sweep: early votes applied to an open poll (no close) → setPollVersion bumped once; the vote write posted polls', async () => {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'q' });
    postFn.mockClear();
    const { sweep, deps } = sweeper();
    await sweep(ctx());
    expect(deps.setPollVersion).toHaveBeenCalledTimes(1);
    const updater = (deps.setPollVersion as ReturnType<typeof vi.fn>).mock.calls[0][0] as (v: number) => number;
    expect(updater(2)).toBe(3);
    expect(postFn).toHaveBeenCalledWith('polls', GROUP);
  });

  it('a repeated open that recovers early votes bumps the poll UI too', async () => {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'q' });
    const deps = realDeps();
    await createPollOpenHandler(deps as never).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(), sender(CREATOR));
    expect(deps.setPollVersion).toHaveBeenCalledTimes(1);
  });

  it('no bump when the replay stored nothing (an older queued vote than the stored one)', async () => {
    await open();
    await vote(USER, ['B'], 5);
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'q' });
    const { sweep, deps } = sweeper();
    postFn.mockClear();
    await sweep(ctx());
    expect(deps.setPollVersion).not.toHaveBeenCalled();
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
  });

  it('closing in a sweep posts polls (the closed write), the UI is bumped', async () => {
    await open();
    await closeHeldAfterFailure();
    postFn.mockClear();
    const { sweep, deps } = sweeper();
    await sweep(ctx());
    expect(deps.setPollVersion).toHaveBeenCalledTimes(1);
    expect(postFn).toHaveBeenCalledWith('polls', GROUP);
  });
});

describe('R1: guardDeps', () => {
  it('runs deps normally until cancelled; then throws before a call and after an awaited one', async () => {
    let cancelled = false;
    const gate = deferred<number>();
    const deps = { read: vi.fn(() => gate.promise), sync: vi.fn(() => 3), label: 'x' };
    const g = guardDeps(deps, () => cancelled);
    expect(g.label).toBe('x');
    expect(g.sync()).toBe(3);
    const pending = g.read();
    cancelled = true;
    gate.resolve(1);
    await expect(pending).rejects.toBeInstanceOf(MaintenanceCancelled);
    await expect(pending).rejects.toMatchObject({ name: 'MaintenanceCancelled' });
    expect(() => g.sync()).toThrow(MaintenanceCancelled);
    expect(() => g.read()).toThrow('maintenance cancelled');
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('resolves the dep value while not cancelled', async () => {
    const g = guardDeps({ read: async () => 7 }, () => false);
    await expect(g.read()).resolves.toBe(7);
  });
});

describe('R1: storage-step coverage of the read-check-write transactions', () => {
  const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };

  it('a step that throws inside the transaction (a corrupt row: non-iterable superseded) aborts it: rejects with that error, nothing written', async () => {
    const corrupt = [{ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 1, superseded: 5 }];
    await real.set(VOTES_KEY, corrupt);
    clearLogs();
    await expect(saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 2 })).rejects.toBeInstanceOf(TypeError);
    expect(await real.get(VOTES_KEY)).toEqual(corrupt);
    expect(postFn).not.toHaveBeenCalled();
  });

  it('a malformed (non-array) vote value is replaced by a list holding just the vote', async () => {
    await real.set(VOTES_KEY, 'junk');
    expect(await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 1 })).toBe(true);
    expect(await real.get(VOTES_KEY)).toEqual([{ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 1 }]);
  });

  it('requirePoll needs THIS poll: another stored poll of the group does not count', async () => {
    await open(POLL_2);
    expect(await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 1 }, { requirePoll: true })).toBe(false);
    expect(await voteRows()).toBeUndefined();
  });

  it('a closed write with no superseded snapshots to drop writes the votes key not at all', async () => {
    await open();
    await vote(USER, ['A'], 1);
    const poll = (await getPoll(GROUP, POLL_ID))!;
    clearLogs();
    await savePoll({ ...poll, closed: true, results: [], totalVoters: 0 });
    expect(written()).toEqual([POLLS_KEY]);
  });

  it('a sweep with a held close but no early votes writes no early-vote queue', async () => {
    await open();
    await closeHeldAfterFailure();
    clearLogs();
    await sweeper().sweep(ctx());
    expect(written().filter((k) => k.startsWith('few:poll-pending-votes:'))).toEqual([]);
  });

  describe('held-close cut-offs only count live, well-formed closes of THIS poll', () => {
    const CAP = MAX_VOTES_KEPT_PER_VOTER;
    async function keepSeq1With(closes: unknown[], seq1At: number) {
      await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 's1', receivedAt: seq1At });
      await real.set(CLOSES_KEY, closes);
      for (let seq = 2; seq <= CAP + 1; seq++) {
        await saveVoteIfNewer({ ...base, responses: ['B'], seq, rumorId: `s${seq}`, receivedAt: seq1At + 100 + seq });
      }
      const [row] = await loadVotes(GROUP, POLL_ID);
      return [...(row.superseded ?? []), row].map((v) => v.seq).includes(1);
    }
    const close = (over: Record<string, unknown>) => ({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1, ...over });

    it('a live close of this poll keeps seq1 (control)', async () => {
      const t = Date.now() - 10_000;
      expect(await keepSeq1With([close({ receivedAt: t + 1 })], t)).toBe(true);
    });
    it('a close of ANOTHER poll does not', async () => {
      const t = Date.now() - 10_000;
      expect(await keepSeq1With([close({ pollId: POLL_2, receivedAt: t + 1 })], t)).toBe(false);
    });
    it('TTL boundary: a close received exactly PENDING_VOTE_TTL_MS ago still counts', async () => {
      const now = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const t = now - PENDING_VOTE_TTL_MS - 1;
        expect(await keepSeq1With([close({ receivedAt: now - PENDING_VOTE_TTL_MS })], t)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
    it('an expired close does not', async () => {
      const t = Date.now() - PENDING_VOTE_TTL_MS - 10_000;
      expect(await keepSeq1With([close({ receivedAt: t + 1 })], t)).toBe(false);
    });
    it.each([
      ['no closer', { closerPubkey: undefined }],
      ['no closedAt', { closedAt: 'x' }],
      ['a string receipt', { receivedAt: 'x' }],
    ])('a malformed close (%s) does not', async (_l, over) => {
      const t = Date.now() - 10_000;
      expect(await keepSeq1With([close({ receivedAt: t + 1, ...over })], t)).toBe(false);
    });
    it('null / non-object entries are ignored (and do not break the close queue)', async () => {
      const t = Date.now() - 10_000;
      expect(await keepSeq1With([null, 7, close({ receivedAt: t + 1 })], t)).toBe(true);
      expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    });
    it('a non-array close value is ignored', async () => {
      const t = Date.now() - 10_000;
      expect(await keepSeq1With('junk' as never, t)).toBe(false);
    });
  });

  it('cancelled after a stranded vote was replayed but before the close settled → no bump, no warning, nothing more written', async () => {
    await heldState();
    let disposed = false;
    const { deps } = sweeper();
    const gate = pauseFirst(deps as never, 'loadPendingCloses');
    const running = createHeldPollStateSweeper(deps as never)(ctx(), () => disposed);
    await gate.reached;
    disposed = true;
    clearLogs();
    gate.release();
    await running;
    expect(written()).toEqual([]);
    expect(deps.setPollVersion).not.toHaveBeenCalled();
    noSweepWarnings();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
  });
});

// ─── Remediation round 2 ─────────────────────────────────────────────────────

describe('R2 HIGH: clearPollData is ONE readwrite transaction — a racing requirePoll replay never leaves an orphan vote row', () => {
  const v = (seq: number) => ({ id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq, rumorId: `v${seq}`, receivedAt: seq });
  const groupKeys = async () => (await real.keys()).filter((k) => typeof k === 'string' && k.includes(GROUP));

  async function seedGroup() {
    await open();
    await open(POLL_2);
    await vote(USER, ['A'], 1);
    await vote(OTHER, ['B'], 1, POLL_2);
    await queuePendingVote({ groupId: GROUP, pollId: 'unseen', voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1 });
    await queuePendingClose({ groupId: GROUP, pollId: 'unseen', closerPubkey: CREATOR, closedAt: 1 });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: 'unseen', senderPubkey: CREATOR, rumorId: 'a', createdAt: 1 });
    await persistence.allocateVoteSeq(GROUP, POLL_ID, USER, 1);
  }

  it('a requirePoll write started while the purge transaction runs → zero vote rows and no poll list afterwards (success signal)', async () => {
    await seedGroup();
    let racing: Promise<boolean> | null = null;
    tx.onTxnStart = () => {
      if (racing) return;
      tx.onTxnStart = null;
      racing = saveVoteIfNewer(v(9), { requirePoll: true });
    };
    await clearPollData(GROUP);
    expect(await racing).toBe(false);
    expect(await groupKeys()).toEqual([]);
  });

  it('a requirePoll write whose transaction was created just before the purge commits first — and its row is gone afterwards', async () => {
    await seedGroup();
    let purge: Promise<void> | null = null;
    tx.onTxnStart = () => {
      tx.onTxnStart = null;
      purge = clearPollData(GROUP); // created while the vote transaction is already open
    };
    expect(await saveVoteIfNewer(v(9), { requirePoll: true })).toBe(true); // it did write
    await purge;
    expect(await voteRows()).toBeUndefined();
    expect(await groupKeys()).toEqual([]);
  });

  it('property: requirePoll replays started at any point around the purge never leave an orphan', async () => {
    for (let offset = 0; offset < 12; offset++) {
      await clearAllPollData();
      await seedGroup();
      const writes: Promise<boolean>[] = [];
      const purge = clearPollData(GROUP);
      for (let i = 0; i < offset; i++) await Promise.resolve();
      writes.push(saveVoteIfNewer(v(10 + offset), { requirePoll: true }));
      await new Promise((r) => setTimeout(r, offset));
      writes.push(saveVoteIfNewer(v(30 + offset), { requirePoll: true }));
      await purge;
      await Promise.all(writes);
      expect(await groupKeys()).toEqual([]);
    }
  });

  it('atomicity pin: one readwrite transaction deletes polls first, then the group\'s vote keys, then queues and seq reservations; no other storage call', async () => {
    await seedGroup();
    clearLogs();
    await clearPollData(GROUP);
    expect(tx.txns).toHaveLength(1);
    expect(tx.txns[0].mode).toBe('readwrite');
    expect(tx.txns[0].deletes).toEqual([
      POLLS_KEY,
      ...[`few:poll-votes:${GROUP}:${POLL_ID}`, `few:poll-votes:${GROUP}:${POLL_2}`].sort(),
      `few:poll-pending-votes:${GROUP}`,
      CLOSES_KEY,
      `few:poll-pending-close-announcements:${GROUP}`,
      `few:poll-vote-seq:${GROUP}`,
    ]);
    expect(delFn).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it('non-string keys in the store are left alone (not mistaken for vote keys)', async () => {
    await seedGroup();
    await real.set(42, 'numeric key');
    await clearPollData(GROUP);
    expect(await groupKeys()).toEqual([]);
    expect(await real.get(42)).toBe('numeric key');
  });

  it('only this group\'s keys go (another group with a prefix-like id survives)', async () => {
    const OTHER_GROUP = 'a1'.repeat(15) + 'ff';
    await seedGroup();
    await savePoll({ ...(await getPoll(GROUP, POLL_ID))!, groupId: OTHER_GROUP });
    await saveVoteIfNewer({ ...v(1), groupId: OTHER_GROUP });
    await clearPollData(GROUP);
    expect(await groupKeys()).toEqual([]);
    expect(await getPoll(OTHER_GROUP, POLL_ID)).not.toBeNull();
    expect(await loadVotes(OTHER_GROUP, POLL_ID)).toHaveLength(1);
  });

  it.each([
    ['the key enumeration', () => { tx.failAllKeys = true; }],
    ['a vote-key delete', () => { tx.failDelete = (k: string) => k.startsWith(`few:poll-votes:${GROUP}:`); }],
    ['a queue delete', () => { tx.failDelete = (k: string) => k === CLOSES_KEY; }],
  ])('failure injection: %s fails → clearPollData rejects and NOTHING is deleted (one transaction)', async (_l, inject) => {
    await seedGroup();
    const before = (await groupKeys()).sort();
    inject();
    await expect(clearPollData(GROUP)).rejects.toBeTruthy();
    tx.failAllKeys = false;
    tx.failDelete = null;
    expect((await groupKeys()).sort()).toEqual(before);
  });
});

describe('R2 MED: a partial early-vote replay still refreshes the poll UI', () => {
  async function twoPending() {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'qa' });
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'qb' });
  }
  /** Fail the n-th (1-based) vote-row put onward. */
  function failVotePutsFrom(n: number) {
    let puts = 0;
    tx.failPut = (k) => k === VOTES_KEY && ++puts >= n;
  }

  it.each(['sweep', 'repeated open'] as const)('%s: A stored, B fails → A stored, pollVersion bumped once, B (and A) still queued, warned, one cross-tab notice', async (path) => {
    await twoPending();
    clearLogs();
    failVotePutsFrom(2);
    const deps = realDeps();
    if (path === 'sweep') {
      await sweeper(undefined, { setPollVersion: deps.setPollVersion }).sweep(ctx());
    } else {
      await createPollOpenHandler(deps as never).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(), sender(CREATOR));
    }
    tx.failPut = null;
    const rows = await loadVotes(GROUP, POLL_ID);
    expect(rows.map((r) => r.voterPubkey)).toEqual([USER]);
    expect(deps.setPollVersion).toHaveBeenCalledTimes(1);
    expect(((deps.setPollVersion as ReturnType<typeof vi.fn>).mock.calls[0][0] as (v: number) => number)(1)).toBe(2);
    expect((await loadPendingVotes(GROUP, POLL_ID)).map((e) => e.voterPubkey).sort()).toEqual([USER, OTHER].sort());
    expect(warned('early-vote replay failed after storing 1')).toBe(true);
    expect(postFn.mock.calls).toEqual([['polls', GROUP]]);
  });

  it('every write fails → no bump, entries stay queued', async () => {
    await twoPending();
    clearLogs();
    failVotePutsFrom(1);
    const deps = realDeps();
    await sweeper(undefined, { setPollVersion: deps.setPollVersion }).sweep(ctx());
    tx.failPut = null;
    expect(deps.setPollVersion).not.toHaveBeenCalled();
    expect(await loadPendingVotes(GROUP, POLL_ID)).toHaveLength(2);
    expect(postFn).not.toHaveBeenCalled();
  });

  it('loadVotesWithPending still rejects on a partial replay (a tally is never built on it)', async () => {
    const { loadVotesWithPending, replayPendingVotes } = await import('@/src/lib/marmot/pollReplay');
    await twoPending();
    failVotePutsFrom(2);
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await expect(loadVotesWithPending(poll, realDeps() as never)).rejects.toBeTruthy();
    // replayPendingVotes reports progress on the way to the rejection
    tx.failPut = null;
    await clearAllPollData();
    await twoPending();
    failVotePutsFrom(2);
    const progress = { stored: 0 };
    await expect(replayPendingVotes((await getPoll(GROUP, POLL_ID))!, realDeps() as never, progress)).rejects.toBeTruthy();
    expect(progress.stored).toBe(1);
    tx.failPut = null;
    // A full replay resolves the number stored.
    await clearAllPollData();
    await twoPending();
    await expect(replayPendingVotes((await getPoll(GROUP, POLL_ID))!, realDeps() as never)).resolves.toBe(2);
  });
});

describe('R2 LOW: a prune that failed at the first close is retried by a later closed write', () => {
  it('first close wins but its prune fails → superseded stays; a second closed write: no poll-list write, no notice, returns the stored poll, and the prune now runs; a duplicate with nothing to prune writes no vote key', async () => {
    await open();
    await vote(USER, ['A'], 1);
    await vote(USER, ['B'], 2);
    const poll = (await getPoll(GROUP, POLL_ID))!;
    const first = { ...poll, closed: true, results: [{ optionId: 'A', label: 'Red', count: 0 }, { optionId: 'B', label: 'Blue', count: 1 }], totalVoters: 1 };
    tx.failGet = (k) => k === VOTES_KEY;
    await expect(savePoll(first)).resolves.toEqual(first);
    tx.failGet = null;
    expect(warned('dropping superseded votes of a closed poll failed')).toBe(true);
    expect((await loadVotes(GROUP, POLL_ID))[0].superseded).toHaveLength(1);

    clearLogs();
    await expect(savePoll({ ...poll, closed: true, results: [], totalVoters: 0 })).resolves.toEqual(first);
    expect(tx.puts.filter((k) => k === POLLS_KEY)).toEqual([]);
    expect(postFn).not.toHaveBeenCalled();
    expect((await loadVotes(GROUP, POLL_ID)).some((r) => 'superseded' in r)).toBe(false);
    expect(await getPoll(GROUP, POLL_ID)).toEqual(first);

    clearLogs();
    await savePoll({ ...poll, closed: true, results: [], totalVoters: 0 });
    expect(written()).toEqual([]);
  });

  it('a closed write for a missing poll runs no prune', async () => {
    clearLogs();
    await expect(savePoll({ id: 'gone', groupId: GROUP, title: 't', options: [], pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: true })).resolves.toBeNull();
    expect(tx.reads).toEqual([POLLS_KEY]);
  });
});
