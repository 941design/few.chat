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

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
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
} = persistence;
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler } = await import('@/src/lib/marmot/handlers/pollHandler');
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

  it('a newer entry replaces an older one and carries seq + rumorId', async () => {
    await deliverVote(voteRumor(USER, ['A'], 100, 1, 'id-old'));
    await deliverVote(voteRumor(USER, ['B'], 40, 2, 'id-new'));
    const queued = await loadPendingVotes(GROUP, POLL_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ responses: ['B'], seq: 2, rumorId: 'id-new', votedAt: 40_000 });
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
    const cast = createVoteCaster({ loadVotes, loadPendingVotes, saveVoteIfNewer });
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

  it('a failed send does not consume a seq or break the chain for the next cast', async () => {
    const cast = createVoteCaster({ loadVotes, loadPendingVotes, saveVoteIfNewer });
    const failing = vi.fn(async () => { throw new Error('offline'); });
    const ok = vi.fn(async (_p: { seq?: number }) => ({ id: 'ok', created_at: 5 }));
    await expect(cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send: failing })).rejects.toThrow('offline');
    const v = await cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send: ok });
    expect(v.seq).toBe(1);
    expect(ok.mock.calls[0][0]).toMatchObject({ pollId: POLL_ID, responses: ['A'], seq: 1 });
  });

  it('a cast whose own vote was meanwhile superseded by a higher-seq vote from another device stores nothing', async () => {
    const cast = createVoteCaster({ loadVotes, loadPendingVotes, saveVoteIfNewer });
    const send = async () => {
      // Another device's seq-9 vote lands while this cast is in flight.
      await saveVoteIfNewer({ ...own(9), responses: ['B'] } as PollVote);
      return { id: 'mine', created_at: 1 };
    };
    await cast({ groupId: GROUP, pollId: POLL_ID, voterPubkey: USER, responses: ['A'], send });
    expect(await storedChoice()).toEqual(['B']);
  });

  it('casts on different polls are not serialised behind each other', async () => {
    const cast = createVoteCaster({ loadVotes, loadPendingVotes, saveVoteIfNewer });
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

  it('close, vote, open: the vote that arrived between them is counted', async () => {
    await close();
    await deliverVote(voteRumor(OTHER, ['B'], 10, 1));
    await open();
    expect(counts(await getPoll(GROUP, POLL_ID))).toEqual({ A: 0, B: 1 });
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

  it('a failing poll lookup throws (indeterminate, not rejected) — no row, nothing queued', async () => {
    const cdeps = { ...chatDeps(), getPoll: vi.fn(async () => { throw new Error('idb'); }) };
    await expect(createChatHandler(cdeps as never).handle(announcement(CREATOR, 'ann-2'), ctx(), sender(CREATOR))).rejects.toThrow('idb');
    expect(cdeps.appendMessage).not.toHaveBeenCalled();
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toEqual([]);
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
    'loadPendingCloseAnnouncements', 'gate getPoll', 'gate loadVotes', 'appendMessage', 'removePendingCloseAnnouncements',
  ] as const;
  type Step = typeof STEPS[number];
  // Steps that run only AFTER the closed poll was saved.
  const AFTER_CLOSE: Step[] = ['removePendingCloses', 'loadPendingCloseAnnouncements', 'gate getPoll', 'gate loadVotes', 'appendMessage', 'removePendingCloseAnnouncements'];

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
      await assertConverged(m, !closed);
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
    await expect(userVote(m)).resolves.toBeUndefined();
    expect(m.saveVoteSpy).not.toHaveBeenCalled();
    expect(saves).not.toHaveBeenCalled();
    expect(m.deps.setPollVersion).not.toHaveBeenCalled();
    expect((await getPoll(GROUP, POLL_ID))?.closed).toBe(false);
    expect(await loadPendingCloses(GROUP, POLL_ID)).toHaveLength(1);
    expect(await loadPendingCloseAnnouncements(GROUP, POLL_ID)).toHaveLength(1);
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
        if (entry === 'vote') await userVote(m);
        else await createPollCloseHandler(m.deps as never).handle(
          rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }, 1_700_000_700), ctx(), sender(CREATOR),
        );
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
