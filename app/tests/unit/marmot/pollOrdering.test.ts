/**
 * Poll vote ordering + close-before-open (bug: poll-vote-ordering-and-early-close,
 * design bug-reports/poll-ordering-design-2026-10-15.md).
 *
 *   §1  every vote carries a per-(poll, voter) Lamport `seq`; the total order
 *       is (seq, created_at, rumor id); legacy votes (no seq) rank as seq 0.
 *   §2  every write path stores through ONE compare-and-set
 *       (saveVoteIfNewer) inside pollPersistence's per-key queue, so the
 *       stored vote is the greatest regardless of delivery order.
 *   §3  a close (and its chat announcement) that arrives before its poll-open
 *       is queued per group and applied on the open — only when its
 *       authenticated sender is the open's authenticated creator.
 *
 * Runs the real handlers against the real persistence layer over a
 * Map-backed idb-keyval mock — assertions read stored state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = mapBacking;
const { mapTxnStore, mapBacking, realPromisifyRequest, txnFaults } = await vi.hoisted(async () => {
  const { callableMapStore } = await import('../helpers/callableMapStore');
  const { promisifyRequest } = await vi.importActual<typeof import('idb-keyval')>('idb-keyval');
  // Faults for the read-check-write transactions (pollPersistence pollTxn).
  const txnFaults = { failGet: null as null | ((key: string) => boolean), failCommit: null as null | (() => boolean) };
  const map = new Map<string, unknown>();
  return {
    txnFaults,
    realPromisifyRequest: promisifyRequest,
    mapBacking: map,
    mapTxnStore: callableMapStore(map, {
      clone: true,
      failGet: (k) => txnFaults.failGet?.(k) ?? false,
      failCommit: () => txnFaults.failCommit?.() ?? false,
    }),
  };
});
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => mapTxnStore),
  promisifyRequest: realPromisifyRequest,
  get: vi.fn(async (key: string) => structuredClone(idbStore.get(key))),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, structuredClone(value)); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

const persistence = await import('@/src/lib/marmot/pollPersistence');
const {
  savePoll, getPoll, loadVotes, saveVoteIfNewer, isNewerVote, clearPollData, clearAllPollData,
  queuePendingVote, loadPendingVotes, removePendingVotes,
  queuePendingClose, loadPendingCloses, removePendingCloses,
  queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
  PENDING_VOTE_TTL_MS, MAX_PENDING_CLOSES_PER_SENDER, MAX_PENDING_CLOSES_PER_GROUP,
  loadVoteSeqReservation, allocateVoteSeq,
} = persistence;
const casterDeps = () => ({ loadVotes, loadPendingVotes, saveVoteIfNewer, allocateVoteSeq });
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler, createHeldCloseSettler } = await import('@/src/lib/marmot/handlers/pollHandler');
const { createChatHandler, createPollCloseAnnouncementReplayer } = await import('@/src/lib/marmot/handlers/chatHandler');
const { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND, parsePollVote, serialisePollVote } = await import('@/src/lib/marmot/pollSync');
const { nextVoteSeq, createVoteCaster } = await import('@/src/lib/marmot/pollCast');
const { replayPendingVotes } = await import('@/src/lib/marmot/pollReplay');

type Poll = import('@/src/lib/marmot/pollPersistence').Poll;
type PollVote = import('@/src/lib/marmot/pollPersistence').PollVote;

const CREATOR = 'aa'.repeat(32);
const ATTACKER = 'ee'.repeat(32);
const USER = '11'.repeat(32); // one user, two devices
const OTHER = '22'.repeat(32);
const HEX_USER = 'ab'.repeat(32); // a pubkey whose case is observable
const GROUP = 'a1'.repeat(16);
const GROUP_B = 'b2'.repeat(16);
const POLL_ID = 'poll-order';

let rumorSeq = 0;
function rumor(kind: number, pubkey: string, content: unknown, createdAtSec = 1_700_000_000, id = `r-${String(rumorSeq++).padStart(4, '0')}`) {
  return { id, pubkey, created_at: createdAtSec, kind, content: JSON.stringify(content), tags: [] as string[][] };
}
const ctx = (groupId = GROUP) => ({ groupId, selfPubkeyHex: 'cc'.repeat(32), getActiveGroupId: () => null });
const sender = (pubkey: string) => ({ pubkey, authenticity: 'mls' as const });

const openPayload = (id = POLL_ID) => ({
  id,
  title: 'Best color?',
  options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }],
  pollType: 'singlechoice',
  creatorPubkey: CREATOR,
});

function realDeps() {
  return {
    savePoll, getPoll, loadVotes, saveVoteIfNewer,
    queuePendingVote, loadPendingVotes, removePendingVotes,
    queuePendingClose, loadPendingCloses, removePendingCloses,
    setPollVersion: vi.fn(),
  };
}

type VoteRumor = ReturnType<typeof rumor>;
const voteRumor = (by: string, responses: string[], createdAtSec: number, seq?: number, id?: string, pollId = POLL_ID) =>
  rumor(POLL_VOTE_KIND, by, seq === undefined ? { pollId, responses } : { pollId, responses, seq }, createdAtSec, id);
async function deliverVote(r: VoteRumor, groupId = GROUP) {
  await createPollVoteHandler(realDeps()).handle(r, ctx(groupId), sender(r.pubkey));
}
async function open(by = CREATOR, groupId = GROUP, deps: Record<string, unknown> = realDeps()) {
  await createPollOpenHandler(deps as never).handle(rumor(POLL_OPEN_KIND, by, openPayload()), ctx(groupId), sender(by));
}
async function close(by = CREATOR, groupId = GROUP, createdAtSec = 1_700_000_500) {
  await createPollCloseHandler(realDeps()).handle(
    rumor(POLL_CLOSE_KIND, by, { pollId: POLL_ID, results: [], totalVoters: 0 }, createdAtSec),
    ctx(groupId),
    sender(by),
  );
}
const storedChoice = async (voter = USER, groupId = GROUP) =>
  (await loadVotes(groupId, POLL_ID)).find((v) => v.voterPubkey === voter)?.responses;
const counts = (p: Poll | null) => Object.fromEntries((p?.results ?? []).map((r) => [r.optionId, r.count]));

beforeEach(async () => {
  idbStore.clear();
  rumorSeq = 0;
  await clearAllPollData();
});

// ─── §1 wire field ───────────────────────────────────────────────────────────

describe('pollSync: vote seq', () => {
  it('accepts an absent seq (legacy) and any non-negative safe integer, and round-trips it', () => {
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: ['A'] }))?.seq).toBeUndefined();
    for (const seq of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(parsePollVote(serialisePollVote({ pollId: 'p', responses: ['A'], seq }))?.seq).toBe(seq);
    }
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '3'],
    ['null', null],
    ['boolean', true],
    ['beyond safe integer', 2 ** 53],
    ['object', { n: 1 }],
  ])('rejects a %s seq', (_label, seq) => {
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: ['A'], seq }))).toBeNull();
  });
});

// ─── §1 comparator ───────────────────────────────────────────────────────────

describe('isNewerVote: total order (seq, created_at, rumorId)', () => {
  const v = (seq: number | undefined, votedAt: number, rumorId: string | undefined) => ({ seq, votedAt, rumorId });

  it.each([
    ['higher seq wins over a later created_at', v(2, 40, 'a'), v(1, 100, 'z'), true],
    ['lower seq loses despite a later created_at', v(1, 100, 'z'), v(2, 40, 'a'), false],
    ['equal seq: later created_at wins', v(3, 200, 'a'), v(3, 100, 'z'), true],
    ['equal seq and created_at: greater rumor id wins', v(3, 100, 'b'), v(3, 100, 'a'), true],
    ['equal seq and created_at: smaller rumor id loses', v(3, 100, 'a'), v(3, 100, 'b'), false],
    ['identical keys are not newer (irreflexive)', v(3, 100, 'a'), v(3, 100, 'a'), false],
    ['seq >= 1 beats a legacy vote with a later created_at', v(1, 10, 'a'), v(undefined, 999, undefined), true],
    ['a legacy vote never beats a seq >= 1 vote', v(undefined, 999, 'z'), v(1, 10, 'a'), false],
    ['legacy vs legacy: later created_at wins', v(undefined, 200, undefined), v(undefined, 100, 'z'), true],
    ['legacy vs legacy, same time: rumor id decides (absent = "")', v(undefined, 100, 'a'), v(undefined, 100, undefined), true],
    ['explicit seq 0 ranks equal to a legacy vote', v(0, 100, 'a'), v(undefined, 100, 'a'), false],
    ['an absent rumor id ranks below any present one (a side)', v(1, 100, undefined), v(1, 100, 'A'), false],
    ['an absent rumor id ranks below any present one (b side)', v(1, 100, 'A'), v(1, 100, undefined), true],
  ])('%s', (_label, a, b, expected) => {
    expect(isNewerVote(a, b)).toBe(expected);
  });

  it('property: a strict total order — exactly one of a>b, b>a, a≡b; transitive', () => {
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const gen = () => v(rnd(4) === 0 ? undefined : rnd(3), rnd(3) * 1000, rnd(4) === 0 ? undefined : ['a', 'b', 'c'][rnd(3)]);
    const same = (a: ReturnType<typeof gen>, b: ReturnType<typeof gen>) =>
      (a.seq ?? 0) === (b.seq ?? 0) && a.votedAt === b.votedAt && (a.rumorId ?? '') === (b.rumorId ?? '');
    for (let i = 0; i < 400; i++) {
      const a = gen(); const b = gen(); const c = gen();
      const ab = isNewerVote(a, b); const ba = isNewerVote(b, a);
      expect(Number(ab) + Number(ba) + Number(same(a, b))).toBe(1);
      if (ab && isNewerVote(b, c)) expect(isNewerVote(a, c)).toBe(true);
    }
  });
});

// ─── §2 compare-and-set ──────────────────────────────────────────────────────

describe('saveVoteIfNewer: one compare-and-set for every write', () => {
  const row = (seq: number, votedAt: number, rumorId: string, responses: string[]): PollVote => ({
    id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses, votedAt, seq, rumorId,
  });

  it('keeps the greatest vote for every call order, also when the calls race', async () => {
    const votes = [row(1, 100_000, 'x', ['A']), row(2, 40_000, 'y', ['B']), row(2, 40_000, 'w', ['A'])];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of orders) {
      idbStore.clear();
      // Concurrent (not awaited one by one): the CAS must sit inside the per-key queue.
      await Promise.all(order.map((i) => saveVoteIfNewer(votes[i])));
      const stored = await loadVotes(GROUP, POLL_ID);
      expect(stored).toHaveLength(1);
      expect(stored[0].rumorId).toBe('y');
    }
  });

  it('reports whether it wrote, and an identical re-save is a no-op', async () => {
    expect(await saveVoteIfNewer(row(1, 1000, 'a', ['A']))).toBe(true);
    expect(await saveVoteIfNewer(row(1, 1000, 'a', ['A']))).toBe(false);
    expect(await saveVoteIfNewer(row(0, 5000, 'b', ['B']))).toBe(false);
    expect(await saveVoteIfNewer(row(2, 1, 'c', ['B']))).toBe(true);
    expect((await loadVotes(GROUP, POLL_ID))[0].responses).toEqual(['B']);
  });

  it('only compares within the same voter — other voters\' rows are untouched', async () => {
    await saveVoteIfNewer(row(5, 1000, 'a', ['A']));
    await saveVoteIfNewer({ ...row(1, 1, 'b', ['B']), id: `${POLL_ID}:${OTHER}`, voterPubkey: OTHER });
    const stored = await loadVotes(GROUP, POLL_ID);
    expect(stored.map((s) => s.voterPubkey).sort()).toEqual([USER, OTHER].sort());
  });
});

// ─── VQ-2: two-device clock skew ─────────────────────────────────────────────

describe('two devices of one user with clock skew converge on the later vote (seq)', () => {
  // Device A votes X (A) with seq 1 at t=100 s. Device B — clock 60 s behind —
  // has seen A's vote, so it votes Y (B) with seq 2 at t=40 s. Y is the later
  // vote and must win on every member, whatever the delivery order.
  const a = () => voteRumor(USER, ['A'], 100, 1, 'id-a');
  const b = () => voteRumor(USER, ['B'], 40, 2, 'id-b');

  it('order A, B', async () => {
    await open();
    await deliverVote(a());
    await deliverVote(b());
    expect(await storedChoice()).toEqual(['B']);
  });

  it('order B, A', async () => {
    await open();
    await deliverVote(b());
    await deliverVote(a());
    expect(await storedChoice()).toEqual(['B']);
  });

  it('both queued before the open (either order)', async () => {
    for (const order of [[a, b], [b, a]]) {
      idbStore.clear();
      for (const r of order) await deliverVote(r());
      await open();
      expect(await storedChoice()).toEqual(['B']);
    }
  });

  it('one queued, the other live, in both orders', async () => {
    for (const [early, late] of [[a, b], [b, a]]) {
      idbStore.clear();
      await deliverVote(early());
      await open();
      await deliverVote(late());
      expect(await storedChoice()).toEqual(['B']);
    }
  });

  it('a journal replay after a failed ack re-delivers A after B — B still wins', async () => {
    await open();
    await deliverVote(a());
    await deliverVote(b());
    await deliverVote(a()); // replayed from the rumor journal
    expect(await storedChoice()).toEqual(['B']);
  });

  it('a stranded queued A replayed at a later message does not override a stored B', async () => {
    await deliverVote(a()); // queued
    await savePoll({ id: POLL_ID, groupId: GROUP, title: 't', options: openPayload().options, pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: false });
    await deliverVote(b()); // live; recovers the stranded A first
    await replayPendingVotes((await getPoll(GROUP, POLL_ID))!, realDeps());
    expect(await storedChoice()).toEqual(['B']);
  });

  it('the closed tally counts B for every delivery order', async () => {
    for (const order of [[a, b], [b, a]]) {
      idbStore.clear();
      await open();
      for (const r of order) await deliverVote(r());
      await close();
      expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 1 });
    }
  });
});

describe('truly concurrent same-seq votes from two devices pick the same winner everywhere', () => {
  it('equal seq: the later created_at wins on every peer, in both orders', async () => {
    const x = () => voteRumor(USER, ['A'], 100, 1, 'id-x');
    const y = () => voteRumor(USER, ['B'], 101, 1, 'id-y');
    for (const order of [[x, y], [y, x]]) {
      idbStore.clear();
      await open();
      for (const r of order) await deliverVote(r());
      expect(await storedChoice()).toEqual(['B']);
    }
  });

  it('equal seq and created_at: the greater rumor id wins on every peer, in both orders', async () => {
    const x = () => voteRumor(USER, ['A'], 100, 1, 'id-9');
    const y = () => voteRumor(USER, ['B'], 100, 1, 'id-1');
    for (const order of [[x, y], [y, x]]) {
      idbStore.clear();
      await open();
      for (const r of order) await deliverVote(r());
      expect(await storedChoice()).toEqual(['A']);
    }
  });
});

describe('legacy votes (no seq)', () => {
  it('a legacy vote arriving after a seq vote is ignored even with a later created_at', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['A'], 100, 1));
    await deliverVote(voteRumor(USER, ['B'], 900));
    expect(await storedChoice()).toEqual(['A']);
  });

  it('legacy-vs-legacy resolves by created_at, not arrival', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['B'], 200));
    await deliverVote(voteRumor(USER, ['A'], 100));
    expect(await storedChoice()).toEqual(['B']);
  });

  it('a stored legacy row (no seq/rumorId fields) is replaced by any seq >= 1 vote', async () => {
    await open();
    const legacy = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 9_999_999_000 };
    idbStore.set(`few:poll-votes:${GROUP}:${POLL_ID}`, [legacy]);
    await deliverVote(voteRumor(USER, ['B'], 1, 1));
    expect(await storedChoice()).toEqual(['B']);
  });
});

describe('early-vote replay uses the full order, including the rumor id', () => {
  const stored = (rumorId: string): PollVote => ({ id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 100_000, seq: 1, rumorId });

  it('a queued vote with equal seq and time but a greater rumor id replaces the stored one', async () => {
    await open();
    await saveVoteIfNewer(stored('a'));
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], votedAt: 100_000, seq: 1, rumorId: 'b' });
    await replayPendingVotes((await getPoll(GROUP, POLL_ID))!, realDeps());
    expect(await storedChoice()).toEqual(['B']);
  });

  it('a queued legacy entry without a rumor id never beats a stored vote with one (absent = "")', async () => {
    await open();
    await saveVoteIfNewer(stored('A'));
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], votedAt: 100_000, seq: 1 });
    await replayPendingVotes((await getPoll(GROUP, POLL_ID))!, realDeps());
    expect(await storedChoice()).toEqual(['A']);
  });
});

describe('early-vote queue keeps the newer entry, not the latest arrival', () => {
  it('seq 2 queued before seq 1 survives', async () => {
    await deliverVote(voteRumor(USER, ['B'], 40, 2));
    await deliverVote(voteRumor(USER, ['A'], 100, 1));
    const queued = await loadPendingVotes(GROUP, POLL_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ responses: ['B'], seq: 2 });
  });

  it('a newer entry is kept with seq + rumorId; the older one that arrived first is kept too (a close may fall between)', async () => {
    await deliverVote(voteRumor(USER, ['A'], 100, 1, 'id-old'));
    await deliverVote(voteRumor(USER, ['B'], 40, 2, 'id-new'));
    const queued = await loadPendingVotes(GROUP, POLL_ID);
    expect(queued.map((q) => q.rumorId)).toEqual(['id-old', 'id-new']);
    expect(queued[1]).toMatchObject({ responses: ['B'], seq: 2, rumorId: 'id-new', votedAt: 40_000 });
  });
});

// ─── castVote: seq derivation + per-poll serialisation ───────────────────────

describe('castVote seq derivation (pollCast)', () => {
  const own = (seq: number | undefined, voter = USER) =>
    ({ id: `${POLL_ID}:${voter}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: voter, responses: ['A'], votedAt: 1, seq, rumorId: 'r' });
  const pend = (seq: number | undefined, voter = USER) =>
    ({ groupId: GROUP, pollId: POLL_ID, voterPubkey: voter, responses: ['A'], votedAt: 1, receivedAt: 1, seq, rumorId: 'q' });

  it.each([
    ['nothing stored', [], [], 1],
    ['legacy own row counts as 0', [own(undefined)], [], 1],
    ['stored 3 + own queued 5 → 6', [own(3)], [pend(5)], 6],
    ['stored 7 + own queued 2 → 8', [own(7)], [pend(2)], 8],
    ['other voters\' seqs are ignored', [own(2), own(50, OTHER)], [pend(60, OTHER)], 3],
  ])('%s', (_label, stored, pending, expected) => {
    expect(nextVoteSeq(USER, stored as PollVote[], pending as never)).toBe(expected);
  });

  it('own pubkey is matched case-insensitively on both sides', () => {
    expect(nextVoteSeq(HEX_USER, [own(4, HEX_USER.toUpperCase())] as PollVote[], [])).toBe(5);
    expect(nextVoteSeq(HEX_USER.toUpperCase(), [], [pend(7, HEX_USER)] as never)).toBe(8);
  });

  it('end to end: stored 3 + own queued 5 → sends 6; two rapid casts send 6 then 7', async () => {
    await saveVoteIfNewer(own(3) as PollVote);
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 5, rumorId: 'q' });
    const sent: number[] = [];
    let n = 0;
    const cast = createVoteCaster(casterDeps());
    const send = async (payload: { seq?: number }) => {
      // Yield so a non-serialised second cast would read the same stored seq.
      await new Promise((r) => setTimeout(r, 5));
      sent.push(payload.seq!);
      return { id: `cast-${n++}`, created_at: 1_700_000_000 };
    };
    const [first, second] = await Promise.all([
      cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send }),
      cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], send }),
    ]);
    expect(sent).toEqual([6, 7]);
    expect(first.seq).toBe(6);
    expect(second).toMatchObject({ seq: 7, responses: ['B'], rumorId: 'cast-1', votedAt: 1_700_000_000_000 });
    expect(await storedChoice()).toEqual(['B']);
  });

  it('a failed send does not break the chain; its reserved seq is not reused (the send may have landed)', async () => {
    const cast = createVoteCaster(casterDeps());
    const failing = vi.fn(async () => { throw new Error('offline'); });
    const ok = vi.fn(async (_p: { seq?: number }) => ({ id: 'ok', created_at: 5 }));
    await expect(cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send: failing })).rejects.toThrow('offline');
    const v = await cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send: ok });
    // An indeterminate send is not treated as "not sent": seq 1 stays used.
    expect(v.seq).toBe(2);
    expect(ok.mock.calls[0][0]).toMatchObject({ pollId: POLL_ID, responses: ['A'], seq: 2 });
  });

  it('a cast whose own vote was meanwhile superseded by a higher-seq vote from another device stores nothing', async () => {
    const cast = createVoteCaster(casterDeps());
    const send = async () => {
      // Another device's seq-9 vote lands while this cast is in flight.
      await saveVoteIfNewer({ ...own(9), responses: ['B'] } as PollVote);
      return { id: 'mine', created_at: 1 };
    };
    await cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send });
    expect(await storedChoice()).toEqual(['B']);
  });

  it('casts on different polls are not serialised behind each other', async () => {
    const cast = createVoteCaster(casterDeps());
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const slow = async () => { await blocked; return { id: 's', created_at: 1 }; };
    const fast = async () => ({ id: 'f', created_at: 1 });
    const p1 = cast({ groupId: GROUP, pollId: 'p-1', voterPubkey: USER, responses: ['A'], send: slow });
    const v2 = await cast({ groupId: GROUP, pollId: 'p-2', voterPubkey: USER, responses: ['A'], send: fast });
    expect(v2.seq).toBe(1);
    release();
    await p1;
  });
});

// ─── §3 close-before-open ────────────────────────────────────────────────────

describe('a close that arrives before its poll-open', () => {
  it('close then open: the poll is closed on first sight, with the queued votes counted', async () => {
    await deliverVote(voteRumor(OTHER, ['A'], 10, 1));
    await close();
    expect(await getPoll(GROUP, POLL_ID)).toBeNull();
    await open();
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 1, B: 0 });
    expect(poll?.totalVoters).toBe(1);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('close, vote, open: a vote that arrived after the close is not counted — as for open, close, vote', async () => {
    // bug: poll-residual-ordering-and-close-retry (before: counted here, dropped there).
    await close();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await open();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 0 });
  });

  it('a close from someone other than the open\'s creator is discarded; the poll opens normally', async () => {
    await close(ATTACKER);
    await open();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('creator match is case-insensitive', async () => {
    await close(CREATOR.toUpperCase());
    await open();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
  });

  it('an attacker\'s earlier queued close cannot crowd out the creator\'s', async () => {
    await close(ATTACKER);
    await close(CREATOR);
    await open();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
  });

  it('is applied only in its own group', async () => {
    await close(CREATOR, GROUP_B);
    await open(CREATOR, GROUP);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP_B, POLL_ID)).toHaveLength(1);
  });

  it('a later vote for the closed-on-open poll is ignored', async () => {
    await close();
    await open();
    await deliverVote(voteRumor(OTHER, ['A'], 10, 1));
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 0 });
    expect(await loadVotes(GROUP, POLL_ID)).toEqual([]);
  });

  it('a close of an already-known poll is applied live and queues nothing', async () => {
    await open();
    await close(); // live close of a known poll — no queue entry
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('bumps the poll UI version once per open, also when a close is applied', async () => {
    await close();
    const deps = realDeps();
    await open(CREATOR, GROUP, deps);
    expect(deps.setPollVersion).toHaveBeenCalledTimes(1);
  });
});

describe('pending-close queue: bounds, TTL, persistence', () => {
  const entry = (pollId: string, closerPubkey = CREATOR, closedAt = 1) => ({ groupId: GROUP, pollId, closerPubkey, closedAt });

  it('one entry per (poll, sender); the first is kept', async () => {
    await queuePendingClose(entry('p', CREATOR, 1), 1000);
    await queuePendingClose(entry('p', CREATOR, 2), 2000);
    expect(await loadPendingCloses(GROUP, 'p', 2000)).toEqual([{ ...entry('p', CREATOR, 1), receivedAt: 1000 }]);
  });

  it(`at most MAX_PENDING_CLOSES_PER_SENDER (${10}) polls per sender per group — extras are dropped`, async () => {
    expect(MAX_PENDING_CLOSES_PER_SENDER).toBe(10);
    for (let i = 0; i < 12; i++) await queuePendingClose(entry(`p${i}`, ATTACKER), 1000 + i);
    await queuePendingClose(entry('legit', CREATOR), 5000);
    const stored = idbStore.get(`few:poll-pending-closes:${GROUP}`) as Array<{ pollId: string; closerPubkey: string }>;
    expect(stored.filter((e) => e.closerPubkey === ATTACKER).map((e) => e.pollId)).toEqual(Array.from({ length: 10 }, (_, i) => `p${i}`));
    expect(stored.some((e) => e.pollId === 'legit')).toBe(true);
  });

  it(`at most MAX_PENDING_CLOSES_PER_GROUP (${50}) per group — the oldest-received are evicted`, async () => {
    expect(MAX_PENDING_CLOSES_PER_GROUP).toBe(50);
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 10; i++) {
        await queuePendingClose(entry(`p${s}-${i}`, String(s).repeat(64)), 1000 + s * 10 + i);
      }
    }
    const stored = idbStore.get(`few:poll-pending-closes:${GROUP}`) as Array<{ pollId: string; receivedAt: number }>;
    expect(stored).toHaveLength(50);
    expect(stored.some((e) => e.pollId === 'p0-0')).toBe(false);
    expect(stored.some((e) => e.pollId === 'p5-9')).toBe(true);
  });

  it('expires seven days after receipt (same TTL as early votes); expired entries are not applied', async () => {
    const now = Date.now();
    await queuePendingClose(entry(POLL_ID), now - PENDING_VOTE_TTL_MS - 1);
    expect(await loadPendingCloses(GROUP, POLL_ID, now)).toEqual([]);
    await open();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
  });

  it('an entry exactly at the TTL is still live', async () => {
    await queuePendingClose(entry('p'), 1000);
    expect(await loadPendingCloses(GROUP, 'p', 1000 + PENDING_VOTE_TTL_MS)).toHaveLength(1);
  });

  it('survives a reload (module state discarded)', async () => {
    await close();
    vi.resetModules();
    const fresh = await import('@/src/lib/marmot/pollPersistence');
    const handlers = await import('@/src/lib/marmot/handlers/pollHandler');
    await handlers.createPollOpenHandler({ ...fresh, setPollVersion: vi.fn() }).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(), sender(CREATOR));
    expect((await fresh.getPoll(GROUP, POLL_ID))?.closed).toBe(true);
  });

  it('removePendingCloses drops only that poll\'s entries', async () => {
    await queuePendingClose(entry('p1'), 1000);
    await queuePendingClose(entry('p2'), 1000);
    await removePendingCloses(GROUP, 'p1', 1000);
    expect(await loadPendingCloses(GROUP, 'p1', 1000)).toEqual([]);
    expect(await loadPendingCloses(GROUP, 'p2', 1000)).toHaveLength(1);
    await removePendingCloses(GROUP, 'p2', 1000);
    expect(idbStore.has(`few:poll-pending-closes:${GROUP}`)).toBe(false);
  });

  it('leaving the group and a full reset discard queued closes and announcements', async () => {
    await queuePendingClose(entry('p'), 1000);
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: 'p', senderPubkey: CREATOR, rumorId: 'x', createdAt: 1 }, 1000);
    await queuePendingClose({ ...entry('p'), groupId: GROUP_B }, 1000);
    await clearPollData(GROUP);
    expect(idbStore.has(`few:poll-pending-closes:${GROUP}`)).toBe(false);
    expect(idbStore.has(`few:poll-pending-close-announcements:${GROUP}`)).toBe(false);
    expect(idbStore.has(`few:poll-pending-closes:${GROUP_B}`)).toBe(true);
    await clearAllPollData();
    expect([...idbStore.keys()].filter((k) => k.startsWith('few:poll'))).toEqual([]);
  });

  it('ignores malformed stored entries', async () => {
    idbStore.set(`few:poll-pending-closes:${GROUP}`, [null, { pollId: 'p' }, 'junk', { ...entry('p'), receivedAt: 1000 }]);
    expect(await loadPendingCloses(GROUP, 'p', 1000)).toHaveLength(1);
  });

  const good = { groupId: GROUP, pollId: 'p', closerPubkey: CREATOR, closedAt: 1, receivedAt: 1000 };
  it.each([
    ['pollId not a string', { ...good, pollId: 7 }],
    ['closer not a string', { ...good, closerPubkey: null }],
    ['closedAt not a number', { ...good, closedAt: '1' }],
    ['receivedAt not a number', { ...good, receivedAt: '1000' }],
  ])('a stored close entry with %s is ignored, never applied', async (_label, bad) => {
    idbStore.set(`few:poll-pending-closes:${GROUP}`, [bad]);
    expect(await loadPendingCloses(GROUP, 'p', 1000)).toEqual([]);
  });

  const goodAnn = { groupId: GROUP, pollId: 'p', senderPubkey: CREATOR, rumorId: 'x', createdAt: 1, receivedAt: 1000 };
  it.each([
    ['null', null],
    ['a string', 'junk'],
    ['pollId not a string', { ...goodAnn, pollId: 7 }],
    ['sender not a string', { ...goodAnn, senderPubkey: 1 }],
    ['rumorId not a string', { ...goodAnn, rumorId: 3 }],
    ['createdAt not a number', { ...goodAnn, createdAt: '1' }],
    ['receivedAt not a number', { ...goodAnn, receivedAt: null }],
  ])('a stored announcement entry that is %s is ignored', async (_label, bad) => {
    idbStore.set(`few:poll-pending-close-announcements:${GROUP}`, [bad, goodAnn]);
    expect(await loadPendingCloseAnnouncements(GROUP, 'p', 1000)).toEqual([goodAnn]);
  });

  it('eviction is by receipt time, not insertion order', async () => {
    // The oldest-received entry is queued LAST; it is the one evicted.
    for (let i = 0; i < 49; i++) await queuePendingClose(entry(`n${i}`, String(i % 5).repeat(64)), 5000 + i);
    await queuePendingClose(entry('oldest', 'f'.repeat(64)), 1000);
    await queuePendingClose(entry('newest', 'e'.repeat(64)), 9000);
    const stored = idbStore.get(`few:poll-pending-closes:${GROUP}`) as Array<{ pollId: string }>;
    expect(stored).toHaveLength(50);
    expect(stored.some((e) => e.pollId === 'oldest')).toBe(false);
    expect(stored.some((e) => e.pollId === 'newest')).toBe(true);
  });

  it('removing applied announcements drops exactly those (poll, sender AND rumor id must all match)', async () => {
    const e = (pollId: string, senderPubkey: string, rumorId: string) => ({ groupId: GROUP, pollId, senderPubkey, rumorId, createdAt: 1 });
    await queuePendingCloseAnnouncement(e('p', CREATOR, 'r1'), 1000);
    await queuePendingCloseAnnouncement(e('p', ATTACKER, 'r1'), 1000);
    await queuePendingCloseAnnouncement(e('q', CREATOR, 'r1'), 1000);
    await queuePendingCloseAnnouncement(e('p', OTHER, 'r2'), 1000);
    await removePendingCloseAnnouncements(GROUP, [{ ...e('p', CREATOR, 'r1'), receivedAt: 1000 }, { ...e('p', OTHER, 'r9'), receivedAt: 1000 }], 1000);
    const left = idbStore.get(`few:poll-pending-close-announcements:${GROUP}`) as Array<{ pollId: string; senderPubkey: string; rumorId: string }>;
    expect(left.map((x) => `${x.pollId}/${x.senderPubkey.slice(0, 2)}/${x.rumorId}`).sort()).toEqual(['p/22/r2', 'p/ee/r1', 'q/aa/r1']);
  });

  it('a full reset also clears queued announcements of a group that was never cleared individually', async () => {
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: 'p', senderPubkey: CREATOR, rumorId: 'x', createdAt: 1 }, 1000);
    idbStore.set('unrelated', 1);
    await clearAllPollData();
    expect([...idbStore.keys()]).toEqual(['unrelated']);
  });
});

// ─── §3 the poll_close chat announcement one layer up ────────────────────────

describe('poll_close chat announcement before its poll-open', () => {
  function chatDeps() {
    return {
      appendMessage: vi.fn(async () => true),
      incrementUnread: vi.fn(),
      markAsRead: vi.fn(),
      setChatVersion: vi.fn(),
      applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false),
      isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
  }
  const announcement = (by: string, id: string) =>
    rumor(9, by, { type: 'poll_close', pollId: POLL_ID, title: 'forged', results: [{ optionId: 'A', label: 'x', count: 99 }], totalVoters: 99 }, 1_700_000_600, id);

  async function openWithReplay(cdeps: ReturnType<typeof chatDeps>) {
    const replay = createPollCloseAnnouncementReplayer(cdeps as never);
    await open(CREATOR, GROUP, { ...realDeps(), replayHeldCloseAnnouncements: replay });
  }

  it('is queued (no row yet) and appended with the recomputed tally once the open arrives', async () => {
    const cdeps = chatDeps();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await close();
    await createChatHandler(cdeps as never).handle(announcement(CREATOR, 'ann-1'), ctx(), sender(CREATOR));
    expect(cdeps.appendMessage).not.toHaveBeenCalled();

    await openWithReplay(cdeps);

    expect(cdeps.appendMessage).toHaveBeenCalledOnce();
    const [, msg] = cdeps.appendMessage.mock.calls[0] as unknown as [string, { id: string; content: string; createdAt: number; senderPubkey: string }];
    expect(msg.id).toBe('ann-1');
    expect(msg.senderPubkey).toBe(CREATOR);
    expect(msg.createdAt).toBe(1_700_000_600_000);
    const content = JSON.parse(msg.content);
    expect(content).toMatchObject({ type: 'poll_close', pollId: POLL_ID, title: 'Best color?', totalVoters: 1 });
    expect(Object.fromEntries(content.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]))).toEqual({ A: 0, B: 1 });
    expect(cdeps.setChatVersion).toHaveBeenCalled();
    expect(cdeps.incrementUnread).toHaveBeenCalledWith(GROUP);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('a non-creator announcement is never appended and is discarded at the open', async () => {
    const cdeps = chatDeps();
    await createChatHandler(cdeps as never).handle(announcement(ATTACKER, 'ann-x'), ctx(), sender(ATTACKER));
    await openWithReplay(cdeps);
    expect(cdeps.appendMessage).not.toHaveBeenCalled();
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('a failing poll lookup throws (indeterminate, not rejected) — no row now, but the announcement is held', async () => {
    const cdeps = { ...chatDeps(), getPoll: vi.fn(async () => { throw new Error('idb'); }) };
    await expect(createChatHandler(cdeps as never).handle(announcement(CREATOR, 'ann-2'), ctx(), sender(CREATOR))).rejects.toThrow('idb');
    expect(cdeps.appendMessage).not.toHaveBeenCalled();
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toMatchObject([{ rumorId: 'ann-2', senderPubkey: CREATOR }]);
  });

  it('a failing announcement replay does not fail the open (entries stay queued)', async () => {
    const cdeps = chatDeps();
    await createChatHandler(cdeps as never).handle(announcement(CREATOR, 'ann-3'), ctx(), sender(CREATOR));
    cdeps.appendMessage.mockRejectedValueOnce(new Error('disk'));
    await openWithReplay(cdeps);
    expect(await getPoll(GROUP, POLL_ID)).not.toBeNull();
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
  });

  it('announcement queue: one per (poll, sender), first kept, sender-bounded', async () => {
    const e = (pollId: string, senderPubkey: string, rumorId: string) => ({ groupId: GROUP, pollId, senderPubkey, rumorId, createdAt: 1 });
    await queuePendingCloseAnnouncement(e('p', CREATOR, 'first'), 1000);
    await queuePendingCloseAnnouncement(e('p', CREATOR, 'second'), 1001);
    expect((await loadPendingCloseAnnouncements(GROUP, 'p', 1001)).map((x) => x.rumorId)).toEqual(['first']);
    for (let i = 0; i < 12; i++) await queuePendingCloseAnnouncement(e(`q${i}`, ATTACKER, `a${i}`), 2000 + i);
    const stored = idbStore.get(`few:poll-pending-close-announcements:${GROUP}`) as unknown[];
    expect(stored).toHaveLength(11);
  });
});

// ─── Remediation 1: a held close / announcement stranded by a failure after the
// open's savePoll is recovered by the next message of that poll ──────────────

describe('held close and announcement are recovered by the next poll message', () => {
  type Step = 'vote replay' | 'tally read' | 'closed save' | 'announcement replay';
  type Trigger = 'vote' | 'duplicate open' | 'live close' | 'non-creator close';
  const STEPS: Step[] = ['vote replay', 'tally read', 'closed save', 'announcement replay'];
  const TRIGGERS: Trigger[] = ['vote', 'duplicate open', 'live close', 'non-creator close'];

  /** A whole member: real persistence, chat deps whose append dedups by id, and failure switches. */
  function member() {
    const appended = new Map<string, { id: string; content: string }>();
    const failing = new Set<Step>();
    const boom = (step: Step) => { if (failing.has(step)) throw new Error(`injected: ${step}`); };
    const pollDeps = {
      ...realDeps(),
      loadPendingVotes: async (g: string, p: string) => { boom('vote replay'); return loadPendingVotes(g, p); },
      loadVotes: async (g: string, p: string) => { boom('tally read'); return loadVotes(g, p); },
      savePoll: async (poll: Poll) => { if (poll.closed) boom('closed save'); return savePoll(poll); },
    };
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => {
        boom('announcement replay');
        if (!appended.has(msg.id)) appended.set(msg.id, msg); // insert-if-absent, like chatPersistence
      }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(),
      applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
    const deps = { ...pollDeps, replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chat as never) };
    return { deps, chat, appended, failing };
  }
  const announce = (m: ReturnType<typeof member>, by = CREATOR) =>
    createChatHandler(m.chat as never).handle(
      rumor(9, by, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, `ann-${by.slice(0, 2)}`),
      ctx(), sender(by),
    );
  const openWith = (m: ReturnType<typeof member>) =>
    createPollOpenHandler(m.deps as never).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(), sender(CREATOR));

  async function trigger(m: ReturnType<typeof member>, t: Trigger) {
    if (t === 'vote') await createPollVoteHandler(m.deps as never).handle(voteRumor(USER, ['A'], 20, 1), ctx(), sender(USER));
    if (t === 'duplicate open') await openWith(m);
    if (t === 'live close' || t === 'non-creator close') {
      const by = t === 'live close' ? CREATOR : ATTACKER;
      await createPollCloseHandler(m.deps as never).handle(
        rumor(POLL_CLOSE_KIND, by, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_700), ctx(), sender(by),
      );
    }
  }

  for (const step of STEPS) {
    for (const t of TRIGGERS) {
      it(`${step} fails during the open → the next ${t} closes the poll with the right tally and exactly one announcement`, async () => {
        const m = member();
        await deliverVote(voteRumor(OTHER, ['B'], 10, 1)); // queued early vote
        await close(); // held creator close
        await announce(m); // held announcement
        expect(m.appended.size).toBe(0);

        m.failing.add(step);
        await openWith(m).catch(() => {}); // the dispatcher acks a failed handler either way
        m.failing.clear();
        expect(await getPoll(GROUP, POLL_ID)).not.toBeNull(); // the open itself is stored
        const closedAtOpen = (await getPoll(GROUP, POLL_ID))?.closed;
        m.deps.setPollVersion.mockClear();

        await trigger(m, t);

        // The UI is refreshed exactly once when the recovery closes the poll.
        expect(m.deps.setPollVersion).toHaveBeenCalledTimes(closedAtOpen ? 0 : 1);
        for (const [updater] of m.deps.setPollVersion.mock.calls as unknown as [(v: number) => number][]) expect(updater(5)).toBe(6);
        expect((await loadVotes(GROUP, POLL_ID)).map((v) => v.voterPubkey)).toEqual([OTHER]);

        const poll = await getPoll(GROUP, POLL_ID);
        expect(poll?.closed).toBe(true);
        expect(counts(poll)).toEqual({ A: 0, B: 1 }); // queued vote counted; a vote after the close is not
        expect(poll?.totalVoters).toBe(1);
        expect(m.appended.size).toBe(1);
        const content = JSON.parse([...m.appended.values()][0].content);
        expect(content).toMatchObject({ type: 'poll_close', totalVoters: 1 });
        expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
        expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
        expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
      });
    }
  }

  it('a step failing after the open\'s savePoll leaves the held close held (not consumed) and nothing closed', async () => {
    const m = member();
    await close();
    m.failing.add('tally read');
    await expect(openWith(m)).rejects.toThrow('injected: tally read');
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
  });

  it('recovery is creator-bound: a held non-creator close is discarded by the recovery path too', async () => {
    const m = member();
    await close(ATTACKER);
    m.failing.add('vote replay');
    m.failing.add('tally read');
    await openWith(m).catch(() => {});
    m.failing.clear();
    await trigger(m, 'vote');
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await storedChoice()).toEqual(['A']);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('a non-creator\'s held announcement is discarded by the recovery path, never shown', async () => {
    const m = member();
    await announce(m, ATTACKER);
    m.failing.add('announcement replay');
    await openWith(m);
    m.failing.clear();
    await trigger(m, 'vote');
    expect(m.appended.size).toBe(0);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('an already-closed poll is not re-closed or re-announced by later messages', async () => {
    const m = member();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await close();
    await announce(m);
    await openWith(m);
    const closedOnce = await getPoll(GROUP, POLL_ID);
    expect(closedOnce?.closed).toBe(true);
    const saves = vi.spyOn(m.deps, 'savePoll');
    m.deps.setPollVersion.mockClear();
    await openWith(m);
    await trigger(m, 'vote');
    await trigger(m, 'non-creator close');
    expect(saves).not.toHaveBeenCalled();
    expect(m.deps.setPollVersion).not.toHaveBeenCalled();
    expect(m.chat.appendMessage).toHaveBeenCalledTimes(1);
    expect(await getPoll(GROUP, POLL_ID)).toEqual(closedOnce);
  });

  it('recovery is fail-closed: while the tally read keeps failing, the poll stays open and the close stays held', async () => {
    const m = member();
    await close();
    m.failing.add('tally read');
    await openWith(m).catch(() => {});
    await trigger(m, 'duplicate open');
    await trigger(m, 'vote');
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    m.failing.clear();
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
  });
});

// ─── Remediation 2: fault injection at every storage step of the held-close /
// held-announcement recovery. Stored state is truth; cleanup is best-effort;
// an indeterminate read is not a rejection. ─────────────────────────────────

describe('held close / announcement recovery under a rejection at every storage step', () => {
  const STEPS = [
    'loadPendingCloses', 'loadVotes', 'loadPendingVotes', 'savePoll(closed)', 'removePendingCloses',
    'loadPendingCloseAnnouncements', 'gate getPoll', 'appendMessage', 'removePendingCloseAnnouncements',
  ] as const;
  // 'gate loadVotes' is not a step here: a held announcement is replayed only
  // after the poll is stored closed, and the gate then announces the stored
  // tally without reading votes (see 'a closed poll announces its stored tally').
  type Step = typeof STEPS[number] | 'gate loadVotes';
  // Steps that run only AFTER the closed poll was saved.
  const AFTER_CLOSE: Step[] = ['removePendingCloses', 'loadPendingCloseAnnouncements', 'gate getPoll', 'appendMessage', 'removePendingCloseAnnouncements'];

  function member() {
    const rows = new Map<string, { id: string; content: string }>();
    const failing = new Set<Step>();
    const boom = (s: Step) => { if (failing.has(s)) throw new Error(`injected: ${s}`); };
    const saveVoteSpy = vi.fn(saveVoteIfNewer);
    const pollDeps = {
      ...realDeps(),
      saveVoteIfNewer: saveVoteSpy,
      loadPendingCloses: async (g: string, p: string) => { boom('loadPendingCloses'); return loadPendingCloses(g, p); },
      removePendingCloses: async (g: string, p: string) => { boom('removePendingCloses'); return removePendingCloses(g, p); },
      loadVotes: async (g: string, p: string) => { boom('loadVotes'); return loadVotes(g, p); },
      loadPendingVotes: async (g: string, p: string) => { boom('loadPendingVotes'); return loadPendingVotes(g, p); },
      savePoll: async (poll: Poll) => { if (poll.closed) boom('savePoll(closed)'); return savePoll(poll); },
    };
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => {
        boom('appendMessage');
        if (rows.has(msg.id)) return false;
        rows.set(msg.id, msg);
        return true;
      }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(),
      applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll: async (g: string, p: string) => { boom('gate getPoll'); return getPoll(g, p); },
      loadVotes: async (g: string, p: string) => { boom('gate loadVotes'); return loadVotes(g, p); },
      saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement,
      loadPendingCloseAnnouncements: async (g: string, p: string) => { boom('loadPendingCloseAnnouncements'); return loadPendingCloseAnnouncements(g, p); },
      removePendingCloseAnnouncements: async (g: string, a: never[]) => { boom('removePendingCloseAnnouncements'); return removePendingCloseAnnouncements(g, a); },
    };
    const deps = { ...pollDeps, replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chat as never) };
    return { deps, chat, rows, failing, saveVoteSpy };
  }
  const openWith = (m: ReturnType<typeof member>) =>
    createPollOpenHandler(m.deps as never).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(), sender(CREATOR));
  const userVote = (m: ReturnType<typeof member>) =>
    createPollVoteHandler(m.deps as never).handle(voteRumor(USER, ['A'], 20, 1), ctx(), sender(USER));

  async function setup(m: ReturnType<typeof member>) {
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await close();
    await createChatHandler(m.chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann-1'),
      ctx(), sender(CREATOR),
    );
  }

  async function assertAfterFailure(m: ReturnType<typeof member>, step: Step) {
    const closed = AFTER_CLOSE.includes(step);
    const poll = await getPoll(GROUP, POLL_ID);
    // Stored poll state = the last successful write.
    expect(poll?.closed).toBe(closed);
    // Held close kept iff its effect did not land (or only its cleanup failed).
    expect((await loadPendingCloses(GROUP, POLL_ID)).length).toBe(!closed || step === 'removePendingCloses' ? 1 : 0);
    // Held announcement kept iff its row did not land (or only its cleanup failed).
    const appended = step === 'removePendingCloseAnnouncements' || (closed && step === 'removePendingCloses');
    expect(m.rows.size).toBe(appended ? 1 : 0);
    expect((await loadPendingCloseAnnouncements(GROUP, POLL_ID)).length).toBe(appended && step !== 'removePendingCloseAnnouncements' ? 0 : 1);
    return closed;
  }

  async function assertConverged(m: ReturnType<typeof member>, userCounted: boolean) {
    m.failing.clear();
    await openWith(m); // any later message of the poll finishes the job
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual(userCounted ? { A: 1, B: 1 } : { A: 0, B: 1 });
    expect(m.rows.size).toBe(1);
    expect(JSON.parse(m.rows.get('ann-1')!.content)).toMatchObject({ totalVoters: userCounted ? 2 : 1 });
    expect(m.chat.incrementUnread).toHaveBeenCalledTimes(1); // once per inserted row, across all replays
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  }

  for (const step of STEPS) {
    it(`fails at ${step} while the poll ARRIVES → state matches the last successful write; the next message converges`, async () => {
      const m = member();
      await setup(m);
      m.failing.add(step);
      await openWith(m).catch(() => {});
      m.failing.clear();
      await assertAfterFailure(m, step);
      await assertConverged(m, false);
    });

    it(`fails at ${step} while RECOVERING at a later vote → no vote lands in a poll saved closed; the next message converges`, async () => {
      const m = member();
      await setup(m);
      m.failing.add('loadVotes'); // the arrival cannot apply the held close
      await openWith(m).catch(() => {});
      m.failing.clear();
      expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
      m.saveVoteSpy.mockClear();

      m.failing.add(step);
      await userVote(m).catch(() => {});
      m.failing.clear();
      const closed = await assertAfterFailure(m, step);
      // H1: the vote of a poll already saved closed is never stored.
      if (closed) expect(m.saveVoteSpy.mock.calls.filter(([v]) => (v as PollVote).voterPubkey === USER)).toEqual([]);
      // The user's vote arrived after the held close on this member, so it is
      // never in the closed tally — also when a fault let it be stored before
      // the close was applied (bug: poll-residual-ordering-and-close-retry;
      // before, it was counted exactly when the recovery step failed).
      await assertConverged(m, false);
    });
  }

  it('H1 repro: removePendingCloses rejects after the closed save → the triggering vote is not saved', async () => {
    const m = member();
    await setup(m);
    m.failing.add('loadVotes');
    await openWith(m).catch(() => {});
    m.failing.clear();
    m.saveVoteSpy.mockClear();
    m.failing.add('removePendingCloses');
    await userVote(m);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect(m.saveVoteSpy).not.toHaveBeenCalled();
  });

  it('an indeterminate closed save (the write lands, then the call rejects) is treated by its stored truth — the vote is dropped', async () => {
    const m = member();
    await setup(m);
    m.failing.add('loadVotes');
    await openWith(m).catch(() => {});
    m.failing.clear();
    m.saveVoteSpy.mockClear();
    m.deps.savePoll = async (poll: Poll) => { await savePoll(poll); if (poll.closed) throw new Error('ack lost'); };
    await userVote(m);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect(m.saveVoteSpy).not.toHaveBeenCalled();
  });

  it('if even the re-read of the stored poll fails, nothing is written: no vote, no close, no UI bump; held entries kept', async () => {
    const m = member();
    await setup(m);
    m.failing.add('loadVotes');
    await openWith(m).catch(() => {});
    m.failing.clear();
    let reads = 0;
    const realGet = m.deps.getPoll;
    m.deps.getPoll = async (g: string, p: string) => { if (++reads > 1) throw new Error('idb'); return realGet(g, p); };
    m.failing.add('loadVotes');
    m.saveVoteSpy.mockClear();
    m.deps.setPollVersion.mockClear();
    const saves = vi.spyOn(m.deps, 'savePoll');
    // The vote is not applied: the handler rejects so the dispatcher keeps the
    // rumor journaled for replay (bug: journal-ack-before-durable-side-effects).
    await expect(userVote(m)).rejects.toThrow('poll state unknown');
    expect(m.saveVoteSpy).not.toHaveBeenCalled();
    expect(saves).not.toHaveBeenCalled();
    expect(m.deps.setPollVersion).not.toHaveBeenCalled();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);

    // Journal replay of the same vote once storage reads work again: the held
    // close is applied first, so the vote (received after it) is dropped like
    // any late vote — the replay converges, nothing is applied twice.
    m.failing.clear();
    m.deps.getPoll = realGet;
    await expect(userVote(m)).resolves.toBeUndefined();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(true);
    expect(m.saveVoteSpy).not.toHaveBeenCalled();
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(0);
  });

  for (const reread of ['rejects', 'finds no poll'] as const) {
    for (const entry of ['vote', 'creator close'] as const) {
      it(`the re-read ${reread} at ${entry} (after one failed tally read) → unknown state: nothing written`, async () => {
        const m = member();
        await setup(m);
        m.failing.add('loadVotes');
        await openWith(m).catch(() => {});
        m.failing.clear();
        // Exactly one more tally read fails (the recovery's); later ones would succeed.
        const realLoad = m.deps.loadVotes;
        let failedOnce = false;
        m.deps.loadVotes = async (g: string, p: string) => { if (!failedOnce) { failedOnce = true; throw new Error('once'); } return realLoad(g, p); };
        const realGet = m.deps.getPoll;
        let reads = 0;
        m.deps.getPoll = async (g: string, p: string) => {
          if (++reads > 1) { if (reread === 'rejects') throw new Error('re-read'); return null; }
          return realGet(g, p);
        };
        m.saveVoteSpy.mockClear();
        m.deps.setPollVersion.mockClear();
        const saves = vi.spyOn(m.deps, 'savePoll');
        if (entry === 'vote') await expect(userVote(m)).rejects.toThrow('poll state unknown');
        else {
          // The live close is held for the next poll message, and the handler
          // throws (Remediation 1, F1) — never silently dropped.
          await expect(createPollCloseHandler(m.deps as never).handle(
            rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_700), ctx(), sender(CREATOR),
          )).rejects.toThrow('poll state unknown');
          expect((await loadPendingCloses(GROUP, POLL_ID)).length).toBeGreaterThan(0);
        }
        expect(m.saveVoteSpy).not.toHaveBeenCalled();
        expect(saves).not.toHaveBeenCalled();
        expect(m.deps.setPollVersion).not.toHaveBeenCalled();
        expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
      });
    }
  }

  const FAULTS = ['closed savePoll lands then rejects', 'removePendingCloses rejects', 'announcement replay rejects'] as const;
  const ENTRIES = ['vote', 'creator close', 'non-creator close', 'duplicate open'] as const;
  for (const fault of FAULTS) {
    for (const entry of ENTRIES) {
      it(`double fault: ${fault} + the stored-poll re-read rejects, at ${entry} → the poll stays closed with frozen results, no vote row; the next message converges`, async () => {
        const m = member();
        await setup(m);
        m.failing.add('loadVotes'); // the arrival cannot apply the held close
        await openWith(m).catch(() => {});
        m.failing.clear();
        expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);

        // Fault 1.
        const realSave = m.deps.savePoll;
        const realReplay = m.deps.replayHeldCloseAnnouncements;
        let saveFailed = false;
        if (fault === 'closed savePoll lands then rejects') {
          m.deps.savePoll = async (poll: Poll) => {
            await realSave(poll);
            if (poll.closed && !saveFailed) { saveFailed = true; throw new Error('ack lost'); }
          };
        }
        if (fault === 'removePendingCloses rejects') m.failing.add('removePendingCloses');
        if (fault === 'announcement replay rejects') m.deps.replayHeldCloseAnnouncements = async () => { throw new Error('replay'); };
        // Fault 2: every read after the entry lookup rejects.
        const realGet = m.deps.getPoll;
        let reads = 0;
        m.deps.getPoll = async (g: string, p: string) => { if (++reads > 1) throw new Error('re-read'); return realGet(g, p); };

        if (entry === 'vote') await userVote(m).catch(() => {});
        if (entry === 'creator close' || entry === 'non-creator close') {
          const by = entry === 'creator close' ? CREATOR : ATTACKER;
          await createPollCloseHandler(m.deps as never).handle(
            rumor(POLL_CLOSE_KIND, by, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_700), ctx(), sender(by),
          ).catch(() => {});
        }
        if (entry === 'duplicate open') await openWith(m).catch(() => {});

        const stored = await getPoll(GROUP, POLL_ID);
        expect(stored?.closed).toBe(true);
        expect(counts(stored)).toEqual({ A: 0, B: 1 });
        expect((await loadVotes(GROUP, POLL_ID)).map((v) => v.voterPubkey)).toEqual([OTHER]);

        // Faults cleared: the next message converges — closed once, announced once.
        m.failing.clear();
        m.deps.savePoll = realSave;
        m.deps.getPoll = realGet;
        m.deps.replayHeldCloseAnnouncements = realReplay;
        await openWith(m);
        expect(await getPoll(GROUP, POLL_ID)).toEqual(stored);
        expect(m.rows.size).toBe(1);
        expect(m.chat.incrementUnread).toHaveBeenCalledTimes(1);
        expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
        expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
      });
    }
  }

  it('the replayer resolves when every entry completed', async () => {
    const m = member();
    await savePoll({ id: POLL_ID, groupId: GROUP, title: 't', options: openPayload().options, pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: false });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: CREATOR, rumorId: 'good', createdAt: 1 });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: ATTACKER, rumorId: 'rejected', createdAt: 1 });
    await expect(createPollCloseAnnouncementReplayer(m.chat as never)((await getPoll(GROUP, POLL_ID))!, ctx())).resolves.toBeUndefined();
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('the arrival bumps the poll UI even when a step after its savePoll fails', async () => {
    const m = member();
    await close();
    m.failing.add('loadVotes');
    await openWith(m).catch(() => {});
    expect(m.deps.setPollVersion).toHaveBeenCalledTimes(1);
  });

  it('the replayer removes only the entries whose run completed and rethrows when one threw', async () => {
    const m = member();
    await savePoll({ id: POLL_ID, groupId: GROUP, title: 't', options: openPayload().options, pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: false });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: CREATOR, rumorId: 'good', createdAt: 1 });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: ATTACKER, rumorId: 'rejected', createdAt: 1 });
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: OTHER, rumorId: 'bad', createdAt: 1 });
    m.chat.isGroupAdmin.mockImplementation(async () => false);
    // OTHER's run throws (indeterminate gate read) — it must stay held.
    const realGetPoll = m.chat.getPoll;
    let calls = 0;
    m.chat.getPoll = async (g: string, p: string) => { calls++; if (calls === 3) throw new Error('idb'); return realGetPoll(g, p); };
    const replay = createPollCloseAnnouncementReplayer(m.chat as never);
    await expect(replay((await getPoll(GROUP, POLL_ID))!, ctx())).rejects.toThrow('idb');
    expect((await loadPendingCloseAnnouncements(GROUP, POLL_ID)).map((e) => e.rumorId)).toEqual(['bad']);
    expect([...m.rows.keys()]).toEqual(['good']);
  });
});

// ─── bug: poll-residual-ordering-and-close-retry ─────────────────────────────

describe('own vote seq is allocated durably and atomically before the send', () => {
  const castArgs = (send: (p: { seq?: number }) => Promise<{ id: string; created_at: number }>, voterPubkey = USER, pollId = POLL_ID, groupId = GROUP) =>
    ({ groupId, pollId, voterPubkey, responses: ['A'], send });
  const okSend = () => vi.fn(async (_p: { seq?: number }) => ({ id: `s-${rumorSeq++}`, created_at: 5 }));

  it('send succeeds but the local save fails → the next cast uses seq + 1, not the same seq', async () => {
    const deps = { ...casterDeps(), saveVoteIfNewer: vi.fn(saveVoteIfNewer) };
    deps.saveVoteIfNewer.mockRejectedValueOnce(new Error('quota'));
    const cast = createVoteCaster(deps);
    const send = okSend();
    await expect(cast(castArgs(send))).rejects.toThrow('quota');
    expect(await loadVotes(GROUP, POLL_ID)).toEqual([]); // the save really failed
    const second = await cast(castArgs(send));
    expect(send.mock.calls.map(([p]) => p.seq)).toEqual([1, 2]);
    expect(second.seq).toBe(2);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, USER)).toBe(2);
  });

  it('the allocation is written before the send', async () => {
    const cast = createVoteCaster(casterDeps());
    let allocatedAtSend = -1;
    await cast(castArgs(async () => {
      allocatedAtSend = await loadVoteSeqReservation(GROUP, POLL_ID, USER);
      return { id: 'x', created_at: 1 };
    }));
    expect(allocatedAtSend).toBe(1);
  });

  it('a failed allocation sends nothing (fail closed) and does not block the next cast', async () => {
    const deps = { ...casterDeps(), allocateVoteSeq: vi.fn(allocateVoteSeq) };
    deps.allocateVoteSeq.mockRejectedValueOnce(new Error('quota'));
    const cast = createVoteCaster(deps);
    const send = okSend();
    await expect(cast(castArgs(send))).rejects.toThrow('quota');
    expect(send).not.toHaveBeenCalled();
    await cast(castArgs(send));
    expect(send.mock.calls.map(([p]) => p.seq)).toEqual([1]);
  });

  it.each([['read', 'get'], ['write', 'set']] as const)('an allocation whose %s fails rejects and records nothing', async (_l, op) => {
    const idb = await import('idb-keyval');
    const fn = idb[op] as unknown as ReturnType<typeof vi.fn>;
    fn.mockImplementationOnce(async () => { throw new Error('idb'); });
    await expect(allocateVoteSeq(GROUP, POLL_ID, USER, 1)).rejects.toThrow('idb');
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, USER)).toBe(0);
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 1)).toBe(1);
  });

  it('an allocation that lands and then rejects sends nothing, and its seq is skipped (indeterminate ≠ not written)', async () => {
    const deps = {
      ...casterDeps(),
      allocateVoteSeq: vi.fn(async (g: string, p: string, v: string, floor: number) => { await allocateVoteSeq(g, p, v, floor); throw new Error('ack lost'); }),
    };
    const send = okSend();
    await expect(createVoteCaster(deps)(castArgs(send))).rejects.toThrow('ack lost');
    expect(send).not.toHaveBeenCalled();
    const v = await createVoteCaster(casterDeps())(castArgs(send));
    expect(v.seq).toBe(2);
  });

  it('allocates max(last + 1, floor) and always moves up — never re-hands an existing or lower seq', async () => {
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 1)).toBe(1);
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 1)).toBe(2);
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 7)).toBe(7); // stored/queued votes demand more
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 3)).toBe(8);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, USER)).toBe(8);
  });

  it('concurrent callers in one tab get distinct, consecutive seqs', async () => {
    const got = await Promise.all(Array.from({ length: 6 }, () => allocateVoteSeq(GROUP, POLL_ID, USER, 1)));
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /** Tab A = this module instance; tab B = a fresh instance over the same IDB map. Every IDB read yields after reading, so unsynchronised tabs interleave. */
  async function twoTabs(nav: unknown) {
    vi.stubGlobal('navigator', nav);
    const slow = (fn: ReturnType<typeof vi.fn>) => {
      const real = fn.getMockImplementation()!;
      // Read, THEN yield: a concurrent unsynchronised writer can slip in between.
      fn.mockImplementation(async (k: string) => { const v = await real(k); await new Promise((r) => setTimeout(r, 1)); return v; });
      return () => fn.mockImplementation(real);
    };
    const restoreA = slow((await import('idb-keyval')).get as unknown as ReturnType<typeof vi.fn>);
    vi.resetModules();
    // A fresh pollPersistence (own in-page write queues) over the same mocked IDB.
    const tabB = await import('@/src/lib/marmot/pollPersistence');
    return { tabB, restore: () => { restoreA(); vi.unstubAllGlobals(); } };
  }

  it('two tabs (separate module instances, one IDB) get distinct seqs through the Web Locks API', async () => {
    const held = new Map<string, Promise<unknown>>();
    const requested: string[] = [];
    const locks = {
      request: vi.fn(<T,>(name: string, cb: () => Promise<T>): Promise<T> => {
        requested.push(name);
        const run = (held.get(name) ?? Promise.resolve()).then(cb, cb);
        held.set(name, run.catch(() => {}));
        return run;
      }),
    };
    const { tabB, restore } = await twoTabs({ locks });
    try {
      const got = await Promise.all([
        allocateVoteSeq(GROUP, POLL_ID, USER, 1), tabB.allocateVoteSeq(GROUP, POLL_ID, USER, 1),
        allocateVoteSeq(GROUP, POLL_ID, USER, 1), tabB.allocateVoteSeq(GROUP, POLL_ID, USER, 1),
      ]);
      expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(requested).toEqual(Array(4).fill(`few:poll-vote-seq:${GROUP}`));
    } finally {
      restore();
    }
  });

  it('without the Web Locks API, two tabs can collide — the lock is what serialises across tabs', async () => {
    const { tabB, restore } = await twoTabs({});
    try {
      const got = await Promise.all([allocateVoteSeq(GROUP, POLL_ID, USER, 1), tabB.allocateVoteSeq(GROUP, POLL_ID, USER, 1)]);
      expect(got).toEqual([1, 1]);
    } finally {
      restore();
    }
  });

  it('works where there is no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined);
    try {
      expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 1)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allocations are per (group, poll, voter) and match the voter case-insensitively', async () => {
    expect(await allocateVoteSeq(GROUP, POLL_ID, HEX_USER, 5)).toBe(5);
    expect(await allocateVoteSeq(GROUP, POLL_ID, HEX_USER.toUpperCase(), 1)).toBe(6);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, HEX_USER.toUpperCase())).toBe(6);
    expect(await allocateVoteSeq(GROUP, 'other-poll', HEX_USER, 1)).toBe(1);
    expect(await allocateVoteSeq(GROUP_B, POLL_ID, HEX_USER, 1)).toBe(1);
    expect(await allocateVoteSeq(GROUP, POLL_ID, OTHER, 1)).toBe(1);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, HEX_USER)).toBe(6);
    expect(await loadVoteSeqReservation(GROUP, 'other-poll', HEX_USER)).toBe(1);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, OTHER)).toBe(1);
  });

  it('malformed stored allocation entries are ignored and dropped on the next write', async () => {
    idbStore.set(`few:poll-vote-seq:${GROUP}`, [null, { pollId: POLL_ID, voterPubkey: USER, seq: '9' }, { pollId: POLL_ID, seq: 9 }]);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, USER)).toBe(0);
    expect(await allocateVoteSeq(GROUP, POLL_ID, USER, 1)).toBe(1);
    expect(idbStore.get(`few:poll-vote-seq:${GROUP}`)).toEqual([{ pollId: POLL_ID, voterPubkey: USER, seq: 1 }]);
    idbStore.set(`few:poll-vote-seq:${GROUP_B}`, 'junk');
    expect(await loadVoteSeqReservation(GROUP_B, POLL_ID, USER)).toBe(0);
    expect(await allocateVoteSeq(GROUP_B, POLL_ID, USER, 2)).toBe(2);
  });

  it('are cleared with the group and by a full reset', async () => {
    await allocateVoteSeq(GROUP, POLL_ID, USER, 4);
    await allocateVoteSeq(GROUP_B, POLL_ID, USER, 4);
    await clearPollData(GROUP);
    expect(await loadVoteSeqReservation(GROUP, POLL_ID, USER)).toBe(0);
    expect(await loadVoteSeqReservation(GROUP_B, POLL_ID, USER)).toBe(4);
    await clearAllPollData();
    expect(await loadVoteSeqReservation(GROUP_B, POLL_ID, USER)).toBe(0);
  });
});

describe('a held close counts the same votes whatever position the open arrives in', () => {
  // Events of one member, in arrival order: USER votes A, the creator closes,
  // OTHER votes B (after the close). Inserting the open at any position must
  // give the tally of the open-first order: USER counted, OTHER not.
  const events = {
    open: () => open(),
    voteBefore: () => deliverVote(voteRumor(USER, ['A'], 10, 1)),
    close: () => close(),
    voteAfter: () => deliverVote(voteRumor(OTHER, ['B'], 20, 1)),
  };
  const ORDERS: (keyof typeof events)[][] = [
    ['open', 'voteBefore', 'close', 'voteAfter'],
    ['voteBefore', 'open', 'close', 'voteAfter'],
    ['voteBefore', 'close', 'open', 'voteAfter'],
    ['voteBefore', 'close', 'voteAfter', 'open'],
  ];
  for (const order of ORDERS) {
    it(order.join(' → '), async () => {
      for (const e of order) await events[e]();
      const poll = await getPoll(GROUP, POLL_ID);
      expect(poll?.closed).toBe(true);
      expect(counts(poll)).toEqual({ A: 1, B: 0 });
      expect(poll?.totalVoters).toBe(1);
    });
  }

  it('success signal: close → vote → open and open → close → vote give the same tally', async () => {
    await close();
    await deliverVote(voteRumor(OTHER, ['B'], 20, 1));
    await open();
    const heldFirst = await getPoll(GROUP, POLL_ID);
    idbStore.clear();
    await clearAllPollData();
    await open();
    await close();
    await deliverVote(voteRumor(OTHER, ['B'], 20, 1));
    const openFirst = await getPoll(GROUP, POLL_ID);
    expect(counts(heldFirst)).toEqual(counts(openFirst));
    expect(heldFirst?.totalVoters).toBe(openFirst?.totalVoters);
  });

  it('a vote changed across the held close, all before the open, counts with the vote the voter had at the close', async () => {
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    await close();
    await deliverVote(voteRumor(USER, ['B'], 20, 2));
    await open();
    const poll = await getPoll(GROUP, POLL_ID);
    expect(counts(poll)).toEqual({ A: 1, B: 0 });
    expect(poll?.totalVoters).toBe(1);
  });

  it('the cut-off is the creator\'s close — an attacker\'s earlier held close does not cut votes off', async () => {
    await close(ATTACKER);
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    await close(CREATOR);
    await deliverVote(voteRumor(OTHER, ['B'], 20, 1));
    await open();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
  });

  it('with two creator closes held (case variants), the earlier one is the cut-off', async () => {
    await close(CREATOR);
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    await close(CREATOR.toUpperCase());
    await open();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 0 });
  });

  it('a stored vote row without a receipt time (older data) is counted', async () => {
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 }, Date.now());
    await savePoll({ id: POLL_ID, groupId: GROUP, title: 't', options: openPayload().options, pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: false });
    idbStore.set(`few:poll-votes:${GROUP}:${POLL_ID}`, [{ id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], votedAt: 1 }]);
    await deliverVote(voteRumor(OTHER, ['A'], 20, 1)); // any later poll message settles the held close
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 1 });
  });

  it('a vote received at exactly the close\'s receipt time is counted (no later)', async () => {
    const t = Date.now();
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 }, t);
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'a' }, t);
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'b' }, t + 1);
    await open();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
  });

  it('every vote write is stamped with a strictly increasing receipt time; a given one is kept', async () => {
    const base = { groupId: GROUP, pollId: POLL_ID, responses: ['A'], votedAt: 1, seq: 1 };
    await saveVoteIfNewer({ ...base, id: `${POLL_ID}:${USER}`, voterPubkey: USER });
    await saveVoteIfNewer({ ...base, id: `${POLL_ID}:${OTHER}`, voterPubkey: OTHER });
    await saveVoteIfNewer({ ...base, id: `${POLL_ID}:${ATTACKER}`, voterPubkey: ATTACKER, receivedAt: 42 });
    const [a, b, c] = await loadVotes(GROUP, POLL_ID);
    expect(b.receivedAt!).toBeGreaterThan(a.receivedAt!);
    expect(c.receivedAt).toBe(42);
    const t1 = await persistence.receiptNow();
    const t2 = await persistence.receiptNow();
    expect(t2).toBeGreaterThan(t1);
  });

  it('the held announcement shows the stored closed tally, never one including a vote after the close', async () => {
    const rows: { id: string; content: string }[] = [];
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => { rows.push(msg); return true; }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes: vi.fn(loadVotes), saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    await close();
    await createChatHandler(chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann'), ctx(), sender(CREATOR),
    );
    await deliverVote(voteRumor(OTHER, ['B'], 20, 1));
    await open(CREATOR, GROUP, { ...realDeps(), replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chat as never) });
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    const poll = await getPoll(GROUP, POLL_ID);
    expect(content.results).toEqual(poll?.results);
    expect(content.totalVoters).toBe(1);
    expect(chat.loadVotes).not.toHaveBeenCalled(); // closed poll: stored tally, no vote read
  });
});

describe('a live poll_close announcement whose gate read fails is retried by the next poll message', () => {
  function chatMember() {
    const rows = new Map<string, { id: string; content: string }>();
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => {
        if (rows.has(msg.id)) return false;
        rows.set(msg.id, msg);
        return true;
      }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll: vi.fn(getPoll), loadVotes: vi.fn(loadVotes), saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement: vi.fn(queuePendingCloseAnnouncement), loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
    const pollDeps = { ...realDeps(), replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chat as never) };
    return { chat, rows, pollDeps };
  }
  const liveAnnouncement = (m: ReturnType<typeof chatMember>) =>
    createChatHandler(m.chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'forged', results: [], totalVoters: 99 }, 1_700_000_600, 'ann-live'), ctx(), sender(CREATOR),
    );
  const nextVote = (m: ReturnType<typeof chatMember>) =>
    createPollVoteHandler(m.pollDeps as never).handle(voteRumor(ATTACKER, ['A'], 30, 1), ctx(), sender(ATTACKER));

  it('success signal: a failing first getPoll → no row; the next poll message shows it with the correct tally, once', async () => {
    const m = chatMember();
    await open();
    await deliverVote(voteRumor(USER, ['B'], 10, 1));
    await close();
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb'));
    await expect(liveAnnouncement(m)).rejects.toThrow('idb');
    expect(m.rows.size).toBe(0);

    await nextVote(m); // a late vote of the (closed) poll — dropped, but retries held entries
    expect(m.rows.size).toBe(1);
    const content = JSON.parse(m.rows.get('ann-live')!.content);
    expect(content).toMatchObject({ type: 'poll_close', title: 'Best color?', totalVoters: 1 });
    expect(content.results).toEqual((await getPoll(GROUP, POLL_ID))?.results);
    expect(m.chat.incrementUnread).toHaveBeenCalledTimes(1);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);

    await nextVote(m); // nothing left to retry, nothing appended twice
    expect(m.rows.size).toBe(1);
    expect(m.chat.incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('a failing tally read on a still-open poll → held; the creator\'s close then shows it with the closed tally', async () => {
    const m = chatMember();
    await open();
    await deliverVote(voteRumor(USER, ['B'], 10, 1));
    m.chat.loadVotes.mockRejectedValueOnce(new Error('idb'));
    await expect(liveAnnouncement(m)).rejects.toThrow('idb');
    expect(m.rows.size).toBe(0);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);

    await createPollCloseHandler(m.pollDeps as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    );
    expect(m.rows.size).toBe(1);
    expect(JSON.parse(m.rows.get('ann-live')!.content)).toMatchObject({ totalVoters: 1 });
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('a non-creator announcement held after a read failure is discarded at the retry, never shown', async () => {
    const m = chatMember();
    await open();
    await close();
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb'));
    await expect(createChatHandler(m.chat as never).handle(
      rumor(9, ATTACKER, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann-x'), ctx(), sender(ATTACKER),
    )).rejects.toThrow('idb');
    await nextVote(m);
    expect(m.rows.size).toBe(0);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('a read failure whose hold also fails throws the read error and holds nothing (lost; logged)', async () => {
    const m = chatMember();
    await open();
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb'));
    m.chat.queuePendingCloseAnnouncement.mockRejectedValueOnce(new Error('quota'));
    await expect(liveAnnouncement(m)).rejects.toThrow('idb');
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('a hold that lands and then rejects is still retried (stored state is the truth)', async () => {
    const m = chatMember();
    await open();
    await close();
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb'));
    m.chat.queuePendingCloseAnnouncement.mockImplementationOnce(async (a) => { await queuePendingCloseAnnouncement(a); throw new Error('ack lost'); });
    await expect(liveAnnouncement(m)).rejects.toThrow('idb');
    await nextVote(m);
    expect(m.rows.size).toBe(1);
  });

  it('in the held-announcement replay, a failing re-read keeps the entry held (not discarded, not duplicated)', async () => {
    const m = chatMember();
    await open();
    await close();
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb'));
    await expect(liveAnnouncement(m)).rejects.toThrow('idb');
    m.chat.getPoll.mockRejectedValueOnce(new Error('idb again'));
    await nextVote(m);
    expect(m.rows.size).toBe(0);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
    await nextVote(m);
    expect(m.rows.size).toBe(1);
  });
});

describe('poll_close gate on a closed poll stored without results (older data)', () => {
  it('recomputes the tally from stored votes instead of announcing nothing', async () => {
    // A closed write never creates a poll: store it open first, then closed.
    const old = { id: POLL_ID, groupId: GROUP, title: 't', options: openPayload().options, pollType: 'singlechoice' as const, creatorPubkey: CREATOR, createdAt: 1, closed: false };
    await savePoll(old);
    await savePoll({ ...old, closed: true });
    await saveVoteIfNewer({ id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], votedAt: 1, seq: 1 });
    const rows: { content: string }[] = [];
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { content: string }) => { rows.push(msg); return true; }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
    await createChatHandler(chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann'), ctx(), sender(CREATOR),
    );
    const content = JSON.parse(rows[0].content);
    expect(content.totalVoters).toBe(1);
    expect(Object.fromEntries(content.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]))).toEqual({ A: 0, B: 1 });
  });
});

describe('a live poll close whose read or write fails is held and applied by the next poll message', () => {
  const liveClose = (deps: Record<string, unknown>, by = CREATOR) =>
    createPollCloseHandler(deps as never).handle(
      rumor(POLL_CLOSE_KIND, by, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(by),
    );
  const failOnce = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, when: (...a: A) => boolean = () => true) => {
    let failed = false;
    return vi.fn(async (...a: A) => {
      if (!failed && when(...a)) { failed = true; throw new Error('injected'); }
      return fn(...a);
    });
  };

  const CASES: [string, () => Record<string, unknown>][] = [
    ['getPoll', () => ({ ...realDeps(), getPoll: failOnce(getPoll) })],
    ['loadPendingVotes (replay read)', () => ({ ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) })],
    ['saveVoteIfNewer (replay write)', () => ({ ...realDeps(), saveVoteIfNewer: failOnce(saveVoteIfNewer) })],
    ['loadVotes (tally read)', () => ({ ...realDeps(), loadVotes: failOnce(loadVotes) })],
    ['savePoll (closed save)', () => ({ ...realDeps(), savePoll: failOnce(savePoll, (p: Poll) => p.closed) })],
  ];
  for (const [step, deps] of CASES) {
    it(`fails at ${step} → the poll stays as stored, the close is held; the next message closes it with the right tally`, async () => {
      await open();
      await deliverVote(voteRumor(USER, ['A'], 10, 1));
      // An early vote stranded in the queue, so the close's replay has work to do.
      await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'q' });
      const d = deps();
      await expect(liveClose(d)).rejects.toThrow('injected');
      expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
      expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);

      await deliverVote(voteRumor(ATTACKER, ['A'], 30, 1)); // arrives after the close: not counted
      const poll = await getPoll(GROUP, POLL_ID);
      expect(poll?.closed).toBe(true);
      expect(counts(poll)).toEqual({ A: 1, B: 1 });
      expect(poll?.totalVoters).toBe(2);
      expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
    });
  }

  it('a closed save that lands and then rejects: stored closed; the held copy is removed later without re-closing', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    const deps = { ...realDeps(), savePoll: vi.fn(async (p: Poll) => { await savePoll(p); if (p.closed) throw new Error('ack lost'); }) };
    await expect(liveClose(deps)).rejects.toThrow('ack lost');
    const stored = await getPoll(GROUP, POLL_ID);
    expect(stored?.closed).toBe(true);
    const saves = vi.fn(savePoll);
    await createPollVoteHandler({ ...realDeps(), savePoll: saves } as never).handle(voteRumor(OTHER, ['B'], 30, 1), ctx(), sender(OTHER));
    expect(saves).not.toHaveBeenCalled();
    expect(await getPoll(GROUP, POLL_ID)).toEqual(stored);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('a non-creator close held after a read failure is discarded at the retry', async () => {
    await open();
    await expect(liveClose({ ...realDeps(), getPoll: failOnce(getPoll) }, ATTACKER)).rejects.toThrow('injected');
    await deliverVote(voteRumor(USER, ['A'], 30, 1));
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('when the hold itself fails, the original error is thrown and nothing is held', async () => {
    await open();
    const deps = { ...realDeps(), getPoll: failOnce(getPoll), queuePendingClose: vi.fn(async () => { throw new Error('quota'); }) };
    await expect(liveClose(deps)).rejects.toThrow('injected');
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('an unknown-poll close whose hold fails throws (as before)', async () => {
    const deps = { ...realDeps(), queuePendingClose: vi.fn(async () => { throw new Error('quota'); }) };
    await expect(liveClose(deps)).rejects.toThrow('quota');
  });
});

describe('early-vote replay: a failure at each internal storage step', () => {
  const queueTwo = async () => {
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
  };
  const pendingCount = async () => (await loadPendingVotes(GROUP, POLL_ID)).length;

  it('saveVoteIfNewer fails at the open → the open is stored, entries stay queued; the next message applies them', async () => {
    await queueTwo();
    let n = 0;
    const deps = { ...realDeps(), saveVoteIfNewer: vi.fn(async (v: PollVote) => { if (++n === 2) throw new Error('injected'); return saveVoteIfNewer(v); }) };
    await expect(open(CREATOR, GROUP, deps)).rejects.toThrow('injected');
    expect(await getPoll(GROUP, POLL_ID)).not.toBeNull();
    expect(await pendingCount()).toBe(2); // nothing removed: the second save did not land
    expect(await loadVotes(GROUP, POLL_ID)).toHaveLength(1);
    await close();
    const poll = await getPoll(GROUP, POLL_ID);
    expect(counts(poll)).toEqual({ A: 1, B: 1 });
    expect(await pendingCount()).toBe(0);
  });

  it('removePendingVotes fails at the open → the open succeeds, votes stored once, entries stay; a later replay removes them without double counting', async () => {
    await queueTwo();
    const deps = { ...realDeps(), removePendingVotes: vi.fn(async () => { throw new Error('injected'); }) };
    await expect(open(CREATOR, GROUP, deps)).resolves.toBeUndefined();
    expect(await loadVotes(GROUP, POLL_ID)).toHaveLength(2);
    expect(await pendingCount()).toBe(2);
    await close();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 1 });
    expect(await pendingCount()).toBe(0);
  });

  it('removePendingVotes fails during a live close → the close is still applied (cleanup never gates it)', async () => {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'q' });
    const deps = { ...realDeps(), removePendingVotes: vi.fn(async () => { throw new Error('injected'); }) };
    await createPollCloseHandler(deps as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    );
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 0, B: 1 });
    expect(deps.removePendingVotes).toHaveBeenCalledOnce();
  });

  it('saveVoteIfNewer fails inside the chat gate replay → the announcement is held, then shown once the vote is stored', async () => {
    await open();
    await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'q' });
    const rows: { id: string; content: string }[] = [];
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => { rows.push(msg); return true; }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer: vi.fn(saveVoteIfNewer), loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
    };
    chat.saveVoteIfNewer.mockRejectedValueOnce(new Error('injected'));
    await expect(createChatHandler(chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann'), ctx(), sender(CREATOR),
    )).rejects.toThrow('injected');
    expect(rows).toHaveLength(0);
    expect(await pendingCount()).toBe(1);
    await createPollCloseHandler({ ...realDeps(), replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(chat as never) } as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toMatchObject({ totalVoters: 1 });
  });
});

// ─── Remediation 1 (bug: poll-residual-ordering-and-close-retry) ─────────────

describe('R1: every arrival order of open, close and (changed) votes gives the open-first tally', () => {
  type Ev = 'open' | 'close' | 'u1' | 'u2' | 'o1';
  const VOTES: Record<'u1' | 'u2' | 'o1', { by: string; resp: string; seq: number }> = {
    u1: { by: USER, resp: 'A', seq: 1 },
    u2: { by: USER, resp: 'B', seq: 2 }, // USER changes A → B
    o1: { by: OTHER, resp: 'A', seq: 1 },
  };
  const perms = (xs: Ev[]): Ev[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  /** Model: a vote counts iff it arrived before the close; per voter the highest seq among those. */
  function expected(order: Ev[]) {
    const before = order.slice(0, order.indexOf('close')).filter((e): e is 'u1' | 'u2' | 'o1' => e in VOTES);
    const best = new Map<string, { resp: string; seq: number }>();
    for (const e of before) {
      const v = VOTES[e];
      if ((best.get(v.by)?.seq ?? 0) < v.seq) best.set(v.by, v);
    }
    const c = { A: 0, B: 0 } as Record<string, number>;
    for (const v of best.values()) c[v.resp]++;
    return { counts: c, voters: best.size };
  }
  const all = perms(['open', 'close', 'u1', 'u2', 'o1']);

  it(`all ${all.length} orders converge`, async () => {
    for (const order of all) {
      idbStore.clear();
      await clearAllPollData();
      for (const e of order) {
        if (e === 'open') await open();
        else if (e === 'close') await close();
        else await deliverVote(voteRumor(VOTES[e].by, [VOTES[e].resp], 10 + VOTES[e].seq, VOTES[e].seq));
      }
      const poll = await getPoll(GROUP, POLL_ID);
      const want = expected(order);
      expect({ order: order.join(','), counts: counts(poll), voters: poll?.totalVoters })
        .toEqual({ order: order.join(','), counts: want.counts, voters: want.voters });
    }
  });

  it('a held close whose settle failed: a post-close vote stored in that window does not replace the pre-close vote in the tally (F4)', async () => {
    await deliverVote(voteRumor(USER, ['A'], 10, 1)); // queued, before the close
    await close();
    let failTally = true;
    const deps = { ...realDeps(), loadVotes: async (g: string, p: string) => { if (failTally) throw new Error('injected'); return loadVotes(g, p); } };
    await open(CREATOR, GROUP, deps).catch(() => {});
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    // The changed vote arrives while the held close still cannot be applied: it is stored.
    await createPollVoteHandler(deps as never).handle(voteRumor(USER, ['B'], 20, 2), ctx(), sender(USER));
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row.responses).toEqual(['B']);
    expect(row.superseded?.map((v) => v.responses)).toEqual([['A']]);
    failTally = false;
    await deliverVote(voteRumor(OTHER, ['B'], 30, 1)); // next message applies the close
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 1, B: 0 });
  });
});

describe('R1: kept votes and "as of" selection', () => {
  const snap = (seq: number, receivedAt: number | undefined, responses = ['A'], votedAt = 1, rumorId = `r${seq}`) =>
    ({ seq, receivedAt, responses, votedAt, rumorId });

  it.each([
    ['newer and later: both kept', [snap(1, 10), snap(2, 20)], [1, 2]],
    ['newer arrived first: the older one is dropped', [snap(2, 10), snap(1, 20)], [2]],
    ['identical votes collapse to the earliest received', [snap(1, 20), snap(1, 10)], [1]],
    ['received together: the newer one wins whatever the list order', [snap(1, 10), snap(2, 10)], [2]],
    ['received together, newer first in the list', [snap(2, 10), snap(1, 10)], [2]],
    ['identical votes received together keep one', [snap(1, 10), snap(1, 10)], [1]],
    ['a row without receipt time counts as received first', [snap(2, undefined), snap(1, 5)], [2]],
  ])('%s', (_l, votes, seqs) => {
    expect(persistence.keptVotes(votes).map((v) => v.seq)).toEqual(seqs);
  });

  it(`keeps at most MAX_VOTES_KEPT_PER_VOTER, dropping the earliest received, sorted by receipt`, () => {
    const votes = Array.from({ length: persistence.MAX_VOTES_KEPT_PER_VOTER + 3 }, (_, i) => snap(i + 1, 100 + i));
    const kept = persistence.keptVotes([...votes].reverse());
    expect(kept.map((v) => v.seq)).toEqual(votes.slice(-persistence.MAX_VOTES_KEPT_PER_VOTER).map((v) => v.seq));
  });

  it('voteAsOf picks the newest vote received no later than the cut-off, or null', () => {
    const row = { id: 'x', groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, ...snap(3, 30, ['C']), superseded: [snap(1, 10, ['A']), snap(2, 20, ['B'])] } as PollVote;
    expect(persistence.voteAsOf(row, 5)).toBeNull();
    expect(persistence.voteAsOf(row, 10)?.responses).toEqual(['A']);
    expect(persistence.voteAsOf(row, 25)).toMatchObject({ responses: ['B'], seq: 2, id: 'x', voterPubkey: USER });
    expect(persistence.voteAsOf(row, 30)).toBe(row);
    expect(persistence.voteAsOf({ ...row, superseded: undefined, receivedAt: undefined }, 0)?.responses).toEqual(['C']);
  });

  it('saveVoteIfNewer: a newer vote keeps the older one as superseded; an older vote arriving later changes nothing', async () => {
    const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };
    expect(await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 10 })).toBe(true);
    expect(await saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 20 })).toBe(true);
    expect(await saveVoteIfNewer({ ...base, responses: ['C'], seq: 1, rumorId: 'c', receivedAt: 30 })).toBe(false);
    expect(await saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 40 })).toBe(false); // re-delivery
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row).toMatchObject({ responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 20 });
    expect(row.superseded).toEqual([{ responses: ['A'], votedAt: 1, seq: 1, rumorId: 'a', receivedAt: 10 }]);
  });

  it('saveVoteIfNewer keeps every earlier vote that can still decide a cut-off (three changes)', async () => {
    const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };
    for (const [seq, r] of [[1, 'A'], [2, 'B'], [3, 'A']] as const) {
      await saveVoteIfNewer({ ...base, responses: [r], seq, rumorId: `r${seq}`, receivedAt: seq * 10 });
    }
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row.seq).toBe(3);
    expect(row.superseded?.map((v) => v.seq)).toEqual([1, 2]);
  });

  it('saveVoteIfNewer: a newer vote that arrived earlier replaces the row outright (nothing left to keep)', async () => {
    const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };
    await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 20 });
    expect(await saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 10 })).toBe(true);
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row).toMatchObject({ responses: ['B'], seq: 2, receivedAt: 10 });
    expect('superseded' in row).toBe(false);
  });

  it('saveVoteIfNewer: an older vote that arrived EARLIER (a late replay) is added below the row, which stays the newest', async () => {
    const base = { id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, votedAt: 1 };
    await saveVoteIfNewer({ ...base, responses: ['B'], seq: 2, rumorId: 'b', receivedAt: 20 });
    expect(await saveVoteIfNewer({ ...base, responses: ['A'], seq: 1, rumorId: 'a', receivedAt: 10 })).toBe(true);
    const [row] = await loadVotes(GROUP, POLL_ID);
    expect(row).toMatchObject({ responses: ['B'], seq: 2 });
    expect(row.superseded?.map((v) => v.seq)).toEqual([1]);
  });

  it('the early-vote queue keeps at most MAX_VOTES_KEPT_PER_VOTER changed votes per voter and poll', async () => {
    const t = Date.now();
    for (let i = 1; i <= persistence.MAX_VOTES_KEPT_PER_VOTER + 2; i++) {
      await queuePendingVote({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], votedAt: 1, seq: i, rumorId: `q${i}` }, t + i);
    }
    const q = await loadPendingVotes(GROUP, POLL_ID);
    expect(q.map((e) => e.seq)).toEqual(Array.from({ length: persistence.MAX_VOTES_KEPT_PER_VOTER }, (_, i) => i + 3));
  });
});

describe('R1: receipt clock survives reloads and backward clock steps', () => {
  const KEY = 'few:poll-receipt-clock';
  async function freshInstance() {
    vi.resetModules();
    return import('@/src/lib/marmot/pollPersistence');
  }

  it('persists a lease ahead of every receipt it hands out; a reloaded page with an earlier wall clock stays above it', async () => {
    const a = await freshInstance();
    const t1 = await a.receiptNow();
    expect(idbStore.get(KEY)).toBe(t1 + a.RECEIPT_LEASE_MS);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t1 - 3_600_000); // clock stepped back 1 h
    try {
      const b = await freshInstance(); // "reload"
      const t2 = await b.receiptNow();
      expect(t2).toBeGreaterThan(t1);
      expect(t2).toBeGreaterThan(t1 + a.RECEIPT_LEASE_MS - 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('writes the lease once per lease window, and never lowers a higher stored mark', async () => {
    const idb = await import('idb-keyval');
    const setFn = idb.set as unknown as ReturnType<typeof vi.fn>;
    const a = await freshInstance();
    setFn.mockClear();
    for (let i = 0; i < 5; i++) await a.receiptNow();
    expect(setFn.mock.calls.filter(([k]) => k === KEY)).toHaveLength(1);
    idbStore.set(KEY, Number.MAX_SAFE_INTEGER - 10);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * a.RECEIPT_LEASE_MS);
    try {
      await a.receiptNow(); // lease expired → renewed, but max() keeps the higher mark
      expect(idbStore.get(KEY)).toBe(Number.MAX_SAFE_INTEGER - 10);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed seed read or lease write is tolerated (still strictly increasing) and retried', async () => {
    const idb = await import('idb-keyval');
    const getFn = idb.get as unknown as ReturnType<typeof vi.fn>;
    const setFn = idb.set as unknown as ReturnType<typeof vi.fn>;
    const a = await freshInstance();
    for (let i = 0; i < a.RECEIPT_SEED_ATTEMPTS; i++) getFn.mockImplementationOnce(async () => { throw new Error('seed'); });
    const t1 = await a.receiptNow(); // every seed attempt failed; lease written anyway
    idbStore.set(KEY, t1 + 10 * a.RECEIPT_LEASE_MS); // what the seed would have found
    const t2 = await a.receiptNow(); // seed retried → jumps above the stored mark
    expect(t2).toBeGreaterThan(t1 + 10 * a.RECEIPT_LEASE_MS - 1);
    setFn.mockImplementationOnce(async () => { throw new Error('lease'); });
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t2 + 100 * a.RECEIPT_LEASE_MS);
    try {
      const t3 = await a.receiptNow(); // lease write fails → still returned
      expect(t3).toBeGreaterThan(t2);
      const t4 = await a.receiptNow(); // retried
      expect(t4).toBeGreaterThan(t3);
      expect(idbStore.get(KEY)).toBe(t4 + a.RECEIPT_LEASE_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([['a string', 'junk'], ['Infinity', Infinity], ['NaN', NaN]])('ignores a malformed stored mark (%s)', async (_l, junk) => {
    idbStore.set(KEY, junk);
    const a = await freshInstance();
    const t = await a.receiptNow();
    expect(t).toBeGreaterThanOrEqual(Date.now() - 5);
    expect(idbStore.get(KEY)).toBe(t + a.RECEIPT_LEASE_MS);
  });
});

describe('R1: a live close that cannot settle its held state is held, not dropped (F1)', () => {
  it('loadPendingCloses AND the stored-poll re-read fail → held + throws; the next message closes with the right tally', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    let reads = 0;
    const deps = {
      ...realDeps(),
      loadPendingCloses: vi.fn(async () => { throw new Error('injected'); }),
      getPoll: vi.fn(async (g: string, p: string) => { if (++reads > 1) throw new Error('re-read'); return getPoll(g, p); }),
    };
    await expect(createPollCloseHandler(deps as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    )).rejects.toThrow('poll state unknown');
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    await deliverVote(voteRumor(OTHER, ['B'], 30, 1));
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 1, B: 0 });
  });
});

describe('R1: the poll_close summary applies a held close of its poll first (F2 partial)', () => {
  function chat(extra: Record<string, unknown> = {}) {
    const rows = new Map<string, { id: string; content: string }>();
    const pollDeps = realDeps();
    const deps = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => { rows.set(msg.id, msg); return true; }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement, loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
      settleHeldCloses: createHeldCloseSettler(pollDeps as never),
      ...extra,
    };
    return { deps, rows, pollDeps };
  }
  const summary = (deps: unknown, by = CREATOR, id = 'ann') =>
    createChatHandler(deps as never).handle(
      rumor(9, by, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, id), ctx(), sender(by),
    );

  it('a close held after a storage failure is applied by its summary; the summary shows the closed tally', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['B'], 10, 1));
    await expect(createPollCloseHandler({ ...realDeps(), savePoll: vi.fn(async () => { throw new Error('injected'); }) } as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    )).rejects.toThrow('injected');
    const c = chat();
    await summary(c.deps);
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 0, B: 1 });
    expect(JSON.parse(c.rows.get('ann')!.content)).toMatchObject({ totalVoters: 1, results: poll?.results });
    expect(c.pollDeps.setPollVersion).toHaveBeenCalledTimes(1);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toEqual([]);
  });

  it('bumps the poll UI by one when it closes the poll', async () => {
    await open();
    await queuePendingClose({ groupId: GROUP, pollId: POLL_ID, closerPubkey: CREATOR, closedAt: 1 });
    const c = chat();
    await summary(c.deps);
    expect(c.pollDeps.setPollVersion).toHaveBeenCalledTimes(1);
    const updater = c.pollDeps.setPollVersion.mock.calls[0][0] as (v: number) => number;
    expect(updater(4)).toBe(5);
  });

  it('with nothing held it changes nothing and does not bump the poll UI', async () => {
    await open();
    const c = chat();
    await summary(c.deps);
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(c.pollDeps.setPollVersion).not.toHaveBeenCalled();
  });

  it('an unconfirmed settle holds the summary and throws (no row)', async () => {
    await open();
    const c = chat({ settleHeldCloses: vi.fn(async () => 'unknown') });
    await expect(summary(c.deps)).rejects.toThrow('poll state unknown');
    expect(c.rows.size).toBe(0);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
  });

  it('the settler returns unknown (no bump) when the held state and the re-read both fail', async () => {
    await open();
    let reads = 0;
    const pollDeps = {
      ...realDeps(),
      loadPendingCloses: vi.fn(async () => { throw new Error('x'); }),
      getPoll: vi.fn(async (g: string, p: string) => { if (++reads > 0) throw new Error('y'); return getPoll(g, p); }),
    };
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await expect(createHeldCloseSettler(pollDeps as never)(poll, ctx())).resolves.toBe('unknown');
    expect(pollDeps.setPollVersion).not.toHaveBeenCalled();
  });

  it('does not replay held summaries itself (no recursion); a held one is shown by the next poll message', async () => {
    await open();
    await close();
    await queuePendingCloseAnnouncement({ groupId: GROUP, pollId: POLL_ID, senderPubkey: CREATOR, rumorId: 'held', createdAt: 1 });
    const replay = vi.fn(async () => {});
    const c = chat();
    c.deps.settleHeldCloses = createHeldCloseSettler({ ...c.pollDeps, replayHeldCloseAnnouncements: replay } as never);
    await summary(c.deps, CREATOR, 'live');
    expect(replay).not.toHaveBeenCalled();
    expect([...c.rows.keys()]).toEqual(['live']);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
  });
});

// ─── Remediation 2 ───────────────────────────────────────────────────────────

describe('R2 + poll-followups: the kept-votes cap is held-close aware — a held close counts A\'s seq1 beyond the cap; only a failed held-close read falls back to dropping it', () => {
  const CAP = persistence.MAX_VOTES_KEPT_PER_VOTER;
  it('the cap is 20', () => expect(CAP).toBe(20));

  /**
   * A seq1 ('A') → creator close held → A seq2..seqN ('B') → the close is applied.
   * failCutoffRead: every read of the held-close queue during the vote changes fails.
   */
  async function run(path: 'queue' | 'stored', lastSeq: number, failCutoffRead = false) {
    const idb = await import('idb-keyval');
    const getFn = idb.get as unknown as ReturnType<typeof vi.fn>;
    const failClosesRead = () => {
      if (!failCutoffRead) return;
      // Both paths read the held closes inside their transaction (the queue
      // path since finding poll-pending-queues-recreated-after-purge); the
      // plain get stays failed for any other reader.
      txnFaults.failGet = (key) => key.startsWith('few:poll-pending-closes:');
      getFn.mockImplementation(async (key: string) => {
        if (key.startsWith('few:poll-pending-closes:')) throw new Error('closes read');
        return structuredClone(idbStore.get(key));
      });
    };
    const restore = () => {
      txnFaults.failGet = null;
      getFn.mockImplementation(async (key: string) => structuredClone(idbStore.get(key)));
    };
    try {
      return await runInner(path, lastSeq, failClosesRead, restore);
    } finally {
      restore();
    }
  }
  async function runInner(path: 'queue' | 'stored', lastSeq: number, failClosesRead: () => void, restore: () => void) {
    if (path === 'queue') {
      await deliverVote(voteRumor(USER, ['A'], 10, 1)); // poll unknown → queued
      await close(); // held, pre-open
      failClosesRead();
      for (let seq = 2; seq <= lastSeq; seq++) await deliverVote(voteRumor(USER, ['B'], 10 + seq, seq));
      restore();
      await open();
    } else {
      await open();
      await deliverVote(voteRumor(USER, ['A'], 10, 1)); // stored row
      // The creator's live close hits a storage failure → held.
      await expect(createPollCloseHandler({ ...realDeps(), savePoll: vi.fn(async (p: Poll) => { if (p.closed) throw new Error('injected'); return savePoll(p); }) } as never).handle(
        rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
      )).rejects.toThrow('injected');
      // Later changes land in the stored row (e.g. while settling kept failing).
      failClosesRead();
      for (let seq = 2; seq <= lastSeq; seq++) {
        await saveVoteIfNewer({ id: `${POLL_ID}:${USER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['B'], votedAt: (10 + seq) * 1000, seq, rumorId: `s${seq}` });
      }
      restore();
      await deliverVote(voteRumor(OTHER, ['B'], 99, 1)); // next poll message applies the held close
    }
    return getPoll(GROUP, POLL_ID);
  }

  for (const path of ['queue', 'stored'] as const) {
    it(`${path}: seq2..seq${CAP} after the close → A counted with seq1`, async () => {
      const poll = await run(path, CAP);
      expect(poll?.closed).toBe(true);
      expect(counts(poll)).toEqual({ A: 1, B: 0 });
      expect(poll?.totalVoters).toBe(1);
    });

    it.each([CAP + 1, CAP + 5])(`${path}: seq2..seq%i (beyond the cap) → seq1 kept for the held close, A counted (flipped by poll-followups)`, async (last) => {
      const poll = await run(path, last);
      expect(poll?.closed).toBe(true);
      expect(counts(poll)).toEqual({ A: 1, B: 0 });
      expect(poll?.totalVoters).toBe(1);
    });

    it(`${path}: beyond the cap with the held-close read failing → falls back to the plain cap: seq1 dropped, A NOT counted (residual), the vote writes still land`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const poll = await run(path, CAP + 1, true);
        expect(poll?.closed).toBe(true);
        expect(counts(poll)).toEqual({ A: 0, B: 0 });
        expect(poll?.totalVoters).toBe(0);
        expect(warn.mock.calls.some(([m]) => String(m).includes('reading held closes for vote pruning failed'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  }
});

describe('R2: a failed held-close settle in the summary gate holds the summary (no wrong, immutable tally)', () => {
  it('savePoll fails while a creator close is held and a post-close vote is stored → summary held + rethrown, no row; the next poll message closes with the as-of tally and announces it', async () => {
    await open();
    await deliverVote(voteRumor(USER, ['A'], 10, 1));
    // Creator's live close fails at the closed save → held.
    const failingSave = { ...realDeps(), savePoll: vi.fn(async (p: Poll) => { if (p.closed) throw new Error('injected'); return savePoll(p); }) };
    await expect(createPollCloseHandler(failingSave as never).handle(
      rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_500), ctx(), sender(CREATOR),
    )).rejects.toThrow('injected');
    // A post-close vote is stored (it would count in an open-poll recompute, not in the held close's tally).
    await saveVoteIfNewer({ id: `${POLL_ID}:${OTHER}`, groupId: GROUP, pollId: POLL_ID, voterPubkey: OTHER, responses: ['B'], votedAt: 1, seq: 1, rumorId: 'late' });

    const rows = new Map<string, { id: string; content: string }>();
    const chat = {
      appendMessage: vi.fn(async (_g: string, msg: { id: string; content: string }) => { if (rows.has(msg.id)) return false; rows.set(msg.id, msg); return true; }),
      incrementUnread: vi.fn(), markAsRead: vi.fn(), setChatVersion: vi.fn(), applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false), isGroupMember: vi.fn(async () => false),
      getPoll, loadVotes, saveVoteIfNewer, loadPendingVotes, removePendingVotes,
      queuePendingCloseAnnouncement: vi.fn(queuePendingCloseAnnouncement), loadPendingCloseAnnouncements, removePendingCloseAnnouncements,
      settleHeldCloses: createHeldCloseSettler(failingSave as never),
    };
    await expect(createChatHandler(chat as never).handle(
      rumor(9, CREATOR, { type: 'poll_close', pollId: POLL_ID, title: 'x', results: [], totalVoters: 0 }, 1_700_000_600, 'ann'), ctx(), sender(CREATOR),
    )).rejects.toThrow('poll state unknown');
    expect(rows.size).toBe(0);
    expect(chat.queuePendingCloseAnnouncement).toHaveBeenCalledOnce();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);

    // The next poll message (storage healthy) applies the close and replays the summary.
    const replayChat = { ...chat, settleHeldCloses: createHeldCloseSettler(realDeps() as never) };
    await createPollVoteHandler({ ...realDeps(), replayHeldCloseAnnouncements: createPollCloseAnnouncementReplayer(replayChat as never) } as never)
      .handle(voteRumor(ATTACKER, ['B'], 50, 1), ctx(), sender(ATTACKER));
    const poll = await getPoll(GROUP, POLL_ID);
    expect(poll?.closed).toBe(true);
    expect(counts(poll)).toEqual({ A: 1, B: 0 }); // as-of tally: OTHER's post-close vote excluded
    expect(rows.size).toBe(1);
    const content = JSON.parse(rows.get('ann')!.content);
    expect(content.results).toEqual(poll?.results);
    expect(content.totalVoters).toBe(poll?.totalVoters);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
  });

  it('the settler itself returns unknown on any settle failure — no fallback to the stored open poll', async () => {
    await open();
    const deps = { ...realDeps(), loadPendingCloses: vi.fn(async () => { throw new Error('x'); }) };
    const poll = (await getPoll(GROUP, POLL_ID))!;
    await expect(createHeldCloseSettler(deps as never)(poll, ctx())).resolves.toBe('unknown');
    expect(deps.setPollVersion).not.toHaveBeenCalled();
  });
});

describe('R2: a full reset also wipes the receipt clock mark', () => {
  it('after clearAllPollData the key is gone, and the next receipt writes a fresh lease (still increasing)', async () => {
    const t1 = await persistence.receiptNow();
    idbStore.set('few:poll-receipt-clock', t1 + persistence.RECEIPT_LEASE_MS);
    await clearAllPollData();
    expect(idbStore.has('few:poll-receipt-clock')).toBe(false);
    const t2 = await persistence.receiptNow();
    expect(t2).toBeGreaterThan(t1);
    expect(idbStore.get('few:poll-receipt-clock')).toBe(t2 + persistence.RECEIPT_LEASE_MS);
  });
});

describe('remediation round 1: a vote whose save fails is queued by receipt before the rethrow', () => {
  const failingSave = () => ({ ...realDeps(), saveVoteIfNewer: vi.fn(async () => { throw new Error('idb write'); }) });

  it('vote save fails → close → the closed tally counts it (received before the close); its journal replay then changes nothing', async () => {
    await open();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    const userVote = voteRumor(USER, ['A'], 20, 1, 'user-vote');
    await expect(createPollVoteHandler(failingSave() as never).handle(userVote, ctx(), sender(USER))).rejects.toThrow('idb write');
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([
      expect.objectContaining({ voterPubkey: USER, responses: ['A'], votedAt: 20_000, seq: 1, rumorId: 'user-vote', receivedAt: expect.any(Number) }),
    ]);
    await close();
    const closed = await getPoll(GROUP, POLL_ID);
    expect(counts(closed)).toEqual({ A: 1, B: 1 });
    // The replay finds the poll closed and returns (acked) — nothing was lost.
    await deliverVote(userVote);
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 1 });
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
  });

  it('a vote received AFTER the close is not counted (the iff)', async () => {
    await open();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await close();
    await deliverVote(voteRumor(USER, ['A'], 20, 1));
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 1 });
  });

  it('vote save fails while the poll is still open → the journal replay applies it once (queue + live save converge)', async () => {
    await open();
    const userVote = voteRumor(USER, ['A'], 20, 1, 'user-vote');
    await expect(createPollVoteHandler(failingSave() as never).handle(userVote, ctx(), sender(USER))).rejects.toThrow();
    await deliverVote(userVote);
    expect(await storedChoice()).toEqual(['A']);
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
    await close();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 1, B: 0 });
  });

  it('failure injection: when queueing fails too, the handler rejects (the journal keeps the vote) and nothing is stored', async () => {
    await open();
    const deps = { ...failingSave(), queuePendingVote: vi.fn(async () => { throw new Error('queue full'); }) };
    await expect(createPollVoteHandler(deps as never).handle(voteRumor(USER, ['A'], 20, 1), ctx(), sender(USER))).rejects.toThrow('queue full');
    expect(await loadPendingVotes(GROUP, POLL_ID)).toEqual([]);
    expect(await storedChoice()).toBeUndefined();
  });
});
