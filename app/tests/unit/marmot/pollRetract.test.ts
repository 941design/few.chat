// @vitest-environment node
/**
 * Store contract of poll withdrawal: pollPersistence.recomputePoll rebuilds ONE poll aggregate from the
 * remaining kind-10/11/12 signals (recompute-on-retract, AC-WDR-7). The sink-level oracle matrix lives in
 * handlers/pollRecompute.test.ts; here the store's own contract is pinned over fake-indexeddb:
 *
 *  - the fold is by `seq`, each signal judged under its own (rumor id, authenticated sender) — never `rumor.pubkey`;
 *  - the aggregate is RESET first (poll row, votes, held votes / closes of THAT poll) and nothing else is touched;
 *  - resolves true iff the visible state (poll row or votes) changed;
 *  - the receipt clock is the row's persisted `receivedAt` (a vote before a close stays counted);
 *  - a purged group is never re-created.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '@/src/lib/marmot/pollPersistence';
import type { ApplicationRumor, RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';

const BOB = 'bb'.repeat(32);
const ALICE = 'dd'.repeat(32);
const MALLORY = 'cc'.repeat(32);
let G: string;
let n = 0;
beforeEach(() => {
  G = `${(++n).toString(16).padStart(2, '0')}`.repeat(32).slice(0, 64) + '-r';
});

const openC = (id = 'p1') => JSON.stringify({ id, title: 't', options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }], pollType: 'singlechoice', creatorPubkey: ALICE });
const voteC = (responses: string[], seq: number, pollId = 'p1') => JSON.stringify({ pollId, responses, seq });
const closeC = (pollId = 'p1') => JSON.stringify({ pollId, results: [], totalVoters: 0 });

let seqCounter = 0;
function sig(kind: number, content: string, sender: string, o: { id?: string; seq?: number; at?: number; pubkey?: string } = {}): RecomputeSignal {
  const seq = o.seq ?? ++seqCounter;
  const id = o.id ?? `r${seq}`;
  const rumor: ApplicationRumor = { id, pubkey: o.pubkey ?? sender, created_at: 1_700_000_000, kind, tags: [], content };
  return { rumor, sender, eventId: `ev${seq}-${sender.slice(0, 2)}`, seq, receivedAt: o.at ?? Date.now() + seq };
}
const poll = (id = 'p1') => store.getPoll(G, id);
const rows = (id = 'p1') => store.loadVotes(G, id).then((r) => r.map((v) => [v.voterPubkey, v.responses.join(','), v.rumorId]));

describe('recomputePoll: rebuilds the aggregate from the remaining signals', () => {
  it('builds a poll, votes and a close from nothing and reports the change; a repeat reports none', async () => {
    const signals = [sig(POLL_OPEN_KIND, openC(), BOB), sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE), sig(POLL_CLOSE_KIND, closeC(), BOB)];
    expect(await store.recomputePoll(G, 'p1', signals)).toBe(true);
    const p = await poll();
    expect([p?.creatorPubkey, p?.closed, p?.totalVoters]).toEqual([BOB, true, 1]);
    expect(await store.recomputePoll(G, 'p1', signals)).toBe(false);
    expect(await store.recomputePoll(G, 'p1', [])).toBe(true); // nothing remains: poll and votes go
    expect(await poll()).toBeNull();
    expect(await rows()).toEqual([]);
    expect(await store.recomputePoll(G, 'p1', [])).toBe(false); // unseen / already gone
  });

  it('folds in seq order whatever the array order', async () => {
    const open = sig(POLL_OPEN_KIND, openC(), BOB, { seq: 1 });
    const vote = sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { seq: 2 });
    const close = sig(POLL_CLOSE_KIND, closeC(), BOB, { seq: 3 });
    await store.recomputePoll(G, 'p1', [close, vote, open]);
    expect((await poll())?.totalVoters).toBe(1);
  });

  it('attributes by the authenticated sender: the rumor pubkey and the payload creator are never read', async () => {
    await store.recomputePoll(G, 'p1', [
      sig(POLL_OPEN_KIND, openC(), BOB, { pubkey: MALLORY }), // payload creatorPubkey = ALICE, rumor.pubkey = MALLORY
      sig(POLL_VOTE_KIND, voteC(['B'], 1), ALICE, { id: 'rv', pubkey: MALLORY }),
    ]);
    expect((await poll())?.creatorPubkey).toBe(BOB);
    expect(await rows()).toEqual([[ALICE, 'B', 'rv']]);
  });

  it('ignores signals of other kinds and other polls, and never touches another poll', async () => {
    await store.recomputePoll(G, 'p2', [sig(POLL_OPEN_KIND, openC('p2'), BOB), sig(POLL_VOTE_KIND, voteC(['A'], 1, 'p2'), ALICE)]);
    const before = await store.snapshotPollState(G);
    const p2Rows = await rows('p2');
    const other = [
      sig(9, 'hello', BOB),
      sig(POLL_OPEN_KIND, openC('p2'), MALLORY),
      sig(POLL_VOTE_KIND, voteC(['B'], 2, 'p2'), ALICE),
      sig(POLL_OPEN_KIND, openC('p1'), BOB),
    ];
    await store.recomputePoll(G, 'p1', other);
    const after = (await store.snapshotPollState(G)) as { polls: Array<{ id: string }>; votes: Record<string, unknown[]> };
    expect(after.polls.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(after.votes.p2).toEqual((before as typeof after).votes.p2); // p2's rows are exactly as they were
    expect(await rows('p2')).toEqual(p2Rows);
  });

  it("resets the poll's held votes and closes, and only those", async () => {
    await store.queuePendingVote({ groupId: G, pollId: 'p1', voterPubkey: ALICE, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'stale' });
    await store.queuePendingVote({ groupId: G, pollId: 'p2', voterPubkey: ALICE, responses: ['A'], votedAt: 1, seq: 1, rumorId: 'keep' });
    await store.queuePendingClose({ groupId: G, pollId: 'p1', closerPubkey: BOB, closedAt: 1 });
    await store.queuePendingClose({ groupId: G, pollId: 'p2', closerPubkey: BOB, closedAt: 1 });
    await store.recomputePoll(G, 'p1', []);
    expect(await store.loadPendingVotes(G, 'p1')).toEqual([]);
    expect(await store.loadPendingCloses(G, 'p1')).toEqual([]);
    expect((await store.loadPendingVotes(G, 'p2')).map((e) => e.rumorId)).toEqual(['keep']);
    expect(await store.loadPendingCloses(G, 'p2')).toHaveLength(1);
  });

  it('re-holds votes and closes of a poll whose open is gone, and they re-apply when the open is back', async () => {
    const open = sig(POLL_OPEN_KIND, openC(), BOB, { seq: 1 });
    const vote = sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { seq: 2 });
    const close = sig(POLL_CLOSE_KIND, closeC(), BOB, { seq: 3 });
    await store.recomputePoll(G, 'p1', [open, vote, close]);
    expect(await store.recomputePoll(G, 'p1', [vote, close])).toBe(true);
    expect(await poll()).toBeNull();
    expect(await rows()).toEqual([]);
    expect(await store.loadPendingVotes(G, 'p1')).toHaveLength(1);
    expect(await store.loadPendingCloses(G, 'p1')).toHaveLength(1);
    await store.recomputePoll(G, 'p1', [open, vote, close]);
    expect(await store.loadPendingVotes(G, 'p1')).toEqual([]);
    expect([(await poll())?.closed, (await poll())?.totalVoters]).toEqual([true, 1]);
  });

  it('a purged group is never re-created', async () => {
    await store.clearPollData(G);
    expect(await store.recomputePoll(G, 'p1', [sig(POLL_OPEN_KIND, openC(), BOB)])).toBe(false);
    expect(await poll()).toBeNull();
    store.releasePollPurgeMark(G);
  });
});

describe('recomputePoll: contribution identity is (rumor id, sender)', () => {
  const O = (sender: string, id = 'ro') => sig(POLL_OPEN_KIND, openC(), sender, { id, seq: sender === BOB ? 1 : 2 });
  it('a byte-identical vote by another sender is a separate vote of that sender', async () => {
    const base = [sig(POLL_OPEN_KIND, openC(), BOB, { seq: 1 })];
    const v = sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { id: 'rv', seq: 2 });
    const forged = sig(POLL_VOTE_KIND, voteC(['A'], 1), MALLORY, { id: 'rv', seq: 3, pubkey: ALICE });
    await store.recomputePoll(G, 'p1', [...base, v, forged]);
    expect((await rows()).map((r) => r[0]).sort()).toEqual([ALICE, MALLORY].sort());
    await store.recomputePoll(G, 'p1', [...base, v]); // forged copy withdrawn
    expect(await rows()).toEqual([[ALICE, 'A', 'rv']]);
    await store.recomputePoll(G, 'p1', [...base, forged]); // victim's withdrawn
    expect(await rows()).toEqual([[MALLORY, 'A', 'rv']]);
  });

  it('a byte-identical open by another sender: first wins; withdrawing the first hands the poll to the copy', async () => {
    await store.recomputePoll(G, 'p1', [O(BOB), O(MALLORY)]);
    expect((await poll())?.creatorPubkey).toBe(BOB);
    await store.recomputePoll(G, 'p1', [O(MALLORY)]);
    expect((await poll())?.creatorPubkey).toBe(MALLORY);
    await store.recomputePoll(G, 'p1', [O(BOB)]);
    expect((await poll())?.creatorPubkey).toBe(BOB);
  });

  it('a held close of the withdrawn creator does not close the poll a different creator re-opens', async () => {
    const vote = sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { seq: 2 });
    const closeByBob = sig(POLL_CLOSE_KIND, closeC(), BOB, { seq: 3 });
    await store.recomputePoll(G, 'p1', [O(MALLORY), vote, closeByBob]); // BOB's open already gone: MALLORY re-opened
    const p = await poll();
    expect([p?.creatorPubkey, p?.closed]).toEqual([MALLORY, false]);
    expect(await store.loadPendingCloses(G, 'p1')).toEqual([]); // discarded, not kept to close a later poll
  });
});

describe('recomputePoll: the receipt clock is the row receivedAt', () => {
  it('a vote received before a held close stays counted, one after it does not — whatever the wall clock', async () => {
    const early = sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { seq: 1, at: 1_000_000 });
    const close = sig(POLL_CLOSE_KIND, closeC(), BOB, { seq: 2, at: 1_000_100 });
    const late = sig(POLL_VOTE_KIND, voteC(['B'], 1), MALLORY, { seq: 3, at: 1_000_200 });
    const open = sig(POLL_OPEN_KIND, openC(), BOB, { seq: 4, at: 1_000_300 });
    // Receipt times are decades old: a fold on the wall clock would expire every held entry.
    await store.recomputePoll(G, 'p1', [early, close, late, open]);
    const p = await poll();
    expect([p?.closed, p?.totalVoters, p?.results?.map((r) => r.count)]).toEqual([true, 1, [1, 0]]);
  });

  it('rows without a receipt time fall back to seq order', async () => {
    const mk = (s: RecomputeSignal): RecomputeSignal => ({ ...s, receivedAt: Number.NaN });
    const early = mk(sig(POLL_VOTE_KIND, voteC(['A'], 1), ALICE, { seq: 1 }));
    const close = mk(sig(POLL_CLOSE_KIND, closeC(), BOB, { seq: 2 }));
    const late = mk(sig(POLL_VOTE_KIND, voteC(['B'], 1), MALLORY, { seq: 3 }));
    const open = mk(sig(POLL_OPEN_KIND, openC(), BOB, { seq: 4 }));
    await store.recomputePoll(G, 'p1', [early, close, late, open]);
    expect((await poll())?.totalVoters).toBe(1);
  });
});
