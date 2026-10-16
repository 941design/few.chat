/**
 * Polls integrity cluster (bug: polls-integrity-cluster).
 *
 *   VQ-1  vote store is group-scoped — a vote stored for (groupB, pollId) is
 *         never counted in (groupA, pollId)'s tally.
 *   VQ-2  legacy `few:poll-votes:{pollId}` rows migrate to the group-scoped
 *         key (groupId recovered from the poll store), idempotently; rows
 *         whose poll is unknown or present in several groups are dropped.
 *   VQ-3  a vote that arrives before its poll is queued per (groupId, pollId),
 *         bounded and expiring, and applied on poll-open with the SAME
 *         validation as a live vote (AC-9).
 *   VQ-4  oversized poll-opens are rejected on receipt with the creation caps.
 *
 * Runs the real handlers against the real persistence layer over a
 * Map-backed idb-keyval mock — assertions read stored state / recomputed
 * tallies, never internal call shapes.
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
  savePoll, getPoll, loadVotes, saveVoteIfNewer, clearPollData, clearAllPollData,
  queuePendingVote, loadPendingVotes, removePendingVotes, migrateLegacyVotes,
  PENDING_VOTE_TTL_MS, MAX_PENDING_VOTES_PER_GROUP, MAX_PENDING_VOTES_PER_VOTER,
} = persistence;
const { createPollOpenHandler, createPollVoteHandler, createPollCloseHandler, replayPendingVotes } = await import('@/src/lib/marmot/handlers/pollHandler');
const { POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND, POLL_LIMITS, POLL_ID_LIMITS, parsePollOpen, parsePollVote, parsePollClose } = await import('@/src/lib/marmot/pollSync');

type Poll = import('@/src/lib/marmot/pollPersistence').Poll;
type PollVoteRow = import('@/src/lib/marmot/pollPersistence').PollVote;

const CREATOR = 'aa'.repeat(32);
const ATTACKER = 'ee'.repeat(32);
const VOTER_A = '11'.repeat(32);
const VOTER_B = '22'.repeat(32);
const GROUP_A = 'a1'.repeat(16);
const GROUP_B = 'b2'.repeat(16);
const POLL_ID = 'poll-shared-id';

let rumorSeq = 0;
function rumor(kind: number, pubkey: string, content: unknown, createdAtSec = 1_700_000_000) {
  return { id: `r-${rumorSeq++}`, pubkey, created_at: createdAtSec, kind, content: JSON.stringify(content), tags: [] as string[][] };
}
const ctx = (groupId: string) => ({ groupId, selfPubkeyHex: 'cc'.repeat(32), getActiveGroupId: () => groupId });
const sender = (pubkey: string) => ({ pubkey, authenticity: 'mls' as const });

function openPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: POLL_ID,
    title: 'Best color?',
    options: [{ id: 'A', label: 'Red' }, { id: 'B', label: 'Blue' }],
    pollType: 'singlechoice',
    creatorPubkey: CREATOR,
    ...overrides,
  };
}

function realDeps() {
  return {
    savePoll,
    saveVoteIfNewer,
    getPoll,
    loadVotes,
    queuePendingVote,
    loadPendingVotes,
    removePendingVotes,
    queuePendingClose: persistence.queuePendingClose,
    loadPendingCloses: persistence.loadPendingCloses,
    removePendingCloses: persistence.removePendingCloses,
    setPollVersion: vi.fn(),
  };
}

async function open(groupId: string, by: string, payload = openPayload()) {
  const deps = realDeps();
  await createPollOpenHandler(deps).handle(rumor(POLL_OPEN_KIND, by, payload), ctx(groupId), sender(by));
  return deps;
}
async function vote(groupId: string, by: string, responses: string[], pollId = POLL_ID, createdAtSec?: number) {
  const deps = realDeps();
  await createPollVoteHandler(deps).handle(rumor(POLL_VOTE_KIND, by, { pollId, responses }, createdAtSec), ctx(groupId), sender(by));
  return deps;
}
async function close(groupId: string, by: string, pollId = POLL_ID) {
  const deps = realDeps();
  await createPollCloseHandler(deps).handle(
    rumor(POLL_CLOSE_KIND, by, { pollId, results: [], totalVoters: 0 }),
    ctx(groupId),
    sender(by),
  );
  return getPoll(groupId, pollId);
}
const counts = (p: Poll | null) => Object.fromEntries((p?.results ?? []).map((r) => [r.optionId, r.count]));

beforeEach(async () => {
  idbStore.clear();
  rumorSeq = 0;
  // Re-arm the once-per-session migration so each test sees a fresh store.
  await clearAllPollData();
});

// ─── VQ-1 ────────────────────────────────────────────────────────────────────

describe('VQ-1: vote store is group-scoped', () => {
  it('an attacker re-opening group A\'s pollId in group B cannot inject votes into group A\'s close tally', async () => {
    await open(GROUP_A, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A']);

    // Attacker shares group B with the victim and opens a poll there reusing
    // group A's pollId (first-open-wins is per group, so this is accepted).
    await open(GROUP_B, ATTACKER, openPayload({ creatorPubkey: ATTACKER }));
    await vote(GROUP_B, ATTACKER, ['B']);
    await vote(GROUP_B, VOTER_B, ['B']);

    const closedA = await close(GROUP_A, CREATOR);
    expect(closedA?.closed).toBe(true);
    expect(closedA?.totalVoters).toBe(1);
    expect(counts(closedA)).toEqual({ A: 1, B: 0 });

    expect(await loadVotes(GROUP_B, POLL_ID)).toHaveLength(2);
  });

  it('loadVotes(group, poll) never returns a row stored for another group with the same pollId (both directions)', async () => {
    const groups = [GROUP_A, GROUP_B];
    for (const g of groups) {
      await saveVoteIfNewer({ id: `${POLL_ID}:${VOTER_A}`, groupId: g, pollId: POLL_ID, voterPubkey: VOTER_A, responses: [g === GROUP_A ? 'A' : 'B'], votedAt: 1 });
    }
    for (const g of groups) {
      const rows = await loadVotes(g, POLL_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].groupId).toBe(g);
      expect(rows[0].responses).toEqual([g === GROUP_A ? 'A' : 'B']);
    }
  });

  it('clearPollData(groupA) removes group A\'s votes but leaves group B\'s votes for the same pollId intact', async () => {
    await open(GROUP_A, CREATOR);
    await open(GROUP_B, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_B, VOTER_A, ['B']);

    await clearPollData(GROUP_A);

    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);
    expect(await loadVotes(GROUP_B, POLL_ID)).toHaveLength(1);
    expect(await getPoll(GROUP_B, POLL_ID)).not.toBeNull();
  });
});

// ─── VQ-2 ────────────────────────────────────────────────────────────────────

function legacyVote(pollId: string, voter: string, responses: string[]) {
  return { id: `${pollId}:${voter}`, pollId, voterPubkey: voter, responses, votedAt: 5 };
}
function storedPoll(groupId: string, id: string): Poll {
  return { id, groupId, title: 't', options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }], pollType: 'singlechoice', creatorPubkey: CREATOR, createdAt: 1, closed: false };
}

describe('VQ-2: legacy vote-row migration', () => {
  beforeEach(() => {
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'p-only-a'), storedPoll(GROUP_A, 'p-both')]);
    idbStore.set(`few:polls:${GROUP_B}`, [storedPoll(GROUP_B, 'p-both')]);
    idbStore.set('few:poll-votes:p-only-a', [legacyVote('p-only-a', VOTER_A, ['A']), legacyVote('p-only-a', VOTER_B, ['B'])]);
    idbStore.set('few:poll-votes:p-both', [legacyVote('p-both', VOTER_A, ['A'])]);
    idbStore.set('few:poll-votes:p-unknown', [legacyVote('p-unknown', VOTER_A, ['A'])]);
  });

  it('moves rows of a poll known in exactly one group to that group\'s key, with groupId stamped, and removes the legacy key', async () => {
    await migrateLegacyVotes();
    const rows = await loadVotes(GROUP_A, 'p-only-a');
    expect(rows.map((r) => r.voterPubkey).sort()).toEqual([VOTER_A, VOTER_B].sort());
    expect(rows.every((r) => r.groupId === GROUP_A && r.pollId === 'p-only-a')).toBe(true);
    expect(idbStore.has('few:poll-votes:p-only-a')).toBe(false);
  });

  it('drops rows whose poll is unknown or present in more than one group (ambiguous)', async () => {
    await migrateLegacyVotes();
    expect(idbStore.has('few:poll-votes:p-unknown')).toBe(false);
    expect(idbStore.has('few:poll-votes:p-both')).toBe(false);
    expect(await loadVotes(GROUP_A, 'p-both')).toEqual([]);
    expect(await loadVotes(GROUP_B, 'p-both')).toEqual([]);
    expect(await loadVotes(GROUP_A, 'p-unknown')).toEqual([]);
  });

  it('is idempotent: a second run (and a crash-replay of a half-done run) neither loses nor duplicates rows', async () => {
    await migrateLegacyVotes();
    const snapshot = structuredClone([...idbStore.entries()]);
    await migrateLegacyVotes();
    expect([...idbStore.entries()]).toEqual(snapshot);

    // Crash replay: the target was written but the legacy key survived.
    idbStore.set('few:poll-votes:p-only-a', [legacyVote('p-only-a', VOTER_A, ['A'])]);
    await migrateLegacyVotes();
    const rows = await loadVotes(GROUP_A, 'p-only-a');
    expect(rows).toHaveLength(2);
    expect(idbStore.has('few:poll-votes:p-only-a')).toBe(false);
  });

  it('a group-scoped row already present wins over a legacy row with the same id', async () => {
    await saveVoteIfNewer({ ...legacyVote('p-only-a', VOTER_A, ['B']), groupId: GROUP_A, votedAt: 99 });
    // saveVoteIfNewer ran the migration first; re-seed a stale legacy duplicate.
    idbStore.set('few:poll-votes:p-only-a', [legacyVote('p-only-a', VOTER_A, ['A'])]);
    await migrateLegacyVotes();
    const rows = await loadVotes(GROUP_A, 'p-only-a');
    expect(rows.find((r) => r.voterPubkey === VOTER_A)?.responses).toEqual(['B']);
  });

  it('runs automatically before the first vote read — no caller has to invoke it', async () => {
    const rows = await loadVotes(GROUP_A, 'p-only-a');
    expect(rows).toHaveLength(2);
  });

  it('drops legacy entries whose own pollId disagrees with the key or that are not vote-shaped', async () => {
    idbStore.set('few:poll-votes:p-only-a', [legacyVote('p-only-a', VOTER_A, ['A']), legacyVote('p-other', VOTER_B, ['A']), { junk: true }, null]);
    await migrateLegacyVotes();
    const rows = await loadVotes(GROUP_A, 'p-only-a');
    expect(rows.map((r) => r.voterPubkey)).toEqual([VOTER_A]);
  });
});

// ─── VQ-3 ────────────────────────────────────────────────────────────────────

describe('VQ-3: early votes are queued and applied on poll-open (AC-9)', () => {
  it('a vote arriving before its poll counts once the poll-open arrives, bound to the authenticated sender', async () => {
    await vote(GROUP_A, VOTER_A, ['B']);
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);

    const deps = await open(GROUP_A, CREATOR);
    const rows = await loadVotes(GROUP_A, POLL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['B'], id: `${POLL_ID}:${VOTER_A}` });
    expect(deps.setPollVersion).toHaveBeenCalled();

    const closed = await close(GROUP_A, CREATOR);
    expect(counts(closed)).toEqual({ A: 0, B: 1 });
  });

  it('queued votes pass the live-vote sanitisation: bogus ids dropped, single-choice capped to one, all-bogus vote not counted', async () => {
    await vote(GROUP_A, VOTER_A, ['bogus', 'B', 'A']);
    await vote(GROUP_A, VOTER_B, ['x', 'y']);
    await open(GROUP_A, CREATOR); // singlechoice
    const rows = await loadVotes(GROUP_A, POLL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].responses).toEqual(['B']);
  });

  it('property: for every response list, a queued-then-applied vote stores exactly what a live vote stores', async () => {
    const pool = ['A', 'B', 'C', 'Z', 'bogus', ''];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 60; i++) {
      const responses = Array.from({ length: 1 + (rnd() % 5) }, () => pool[rnd() % pool.length]);
      const pollType = rnd() % 2 ? 'singlechoice' : 'multiplechoice';
      const payload = openPayload({ id: `prop-${i}`, pollType, options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'C', label: 'c' }] });

      await open(GROUP_A, CREATOR, payload);
      await vote(GROUP_A, VOTER_A, responses, `prop-${i}`);
      const live = await loadVotes(GROUP_A, `prop-${i}`);

      await vote(GROUP_B, VOTER_A, responses, `prop-${i}`);
      await open(GROUP_B, CREATOR, payload);
      const queued = await loadVotes(GROUP_B, `prop-${i}`);

      // rumorId identifies the (distinct) vote rumor of each run and receivedAt
      // its local arrival — neither is part of what is compared.
      const strip = ({ groupId: _g, rumorId: _r, receivedAt: _t, ...rest }: PollVoteRow) => rest;
      expect(queued.map(strip)).toEqual(live.map(strip));
    }
  });

  it('a queued vote is applied only in its own group — opening the same pollId elsewhere does not consume it', async () => {
    await vote(GROUP_B, VOTER_A, ['A']);
    await open(GROUP_A, CREATOR);
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);
    await open(GROUP_B, CREATOR);
    expect(await loadVotes(GROUP_B, POLL_ID)).toHaveLength(1);
  });

  it('two early votes of a voter (same created_at) collapse to one queue entry — the greater by (seq, created_at, rumor id) is applied', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_A, VOTER_A, ['B']);
    await open(GROUP_A, CREATOR);
    const rows = await loadVotes(GROUP_A, POLL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].responses).toEqual(['B']);
  });

  it('applied queue entries are consumed — the queue is empty afterwards', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await open(GROUP_A, CREATOR);
    expect(await loadPendingVotes(GROUP_A, POLL_ID)).toEqual([]);
  });

  it('a vote for a known closed poll is dropped, not queued', async () => {
    await open(GROUP_A, CREATOR);
    await close(GROUP_A, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A']);
    expect(await loadPendingVotes(GROUP_A, POLL_ID)).toEqual([]);
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);
  });

  it('a queued vote older than the TTL expires instead of being applied', async () => {
    const t0 = 1_000_000;
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t0);
    expect(await loadPendingVotes(GROUP_A, POLL_ID, t0 + PENDING_VOTE_TTL_MS + 1)).toEqual([]);

    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t0);
    expect(await loadPendingVotes(GROUP_A, POLL_ID, t0 + PENDING_VOTE_TTL_MS)).toHaveLength(1);
  });

  it('expired entries of OTHER polls are pruned when the queue is touched', async () => {
    const t0 = 1_000_000;
    await queuePendingVote({ groupId: GROUP_A, pollId: 'never-arrives', voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t0);
    await queuePendingVote({ groupId: GROUP_A, pollId: 'other', voterPubkey: VOTER_B, responses: ['A'], votedAt: 1 }, t0 + PENDING_VOTE_TTL_MS + 1);
    const stored = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as Array<{ pollId: string }>;
    expect(stored.map((e) => e.pollId)).toEqual(['other']);
  });

  it('per-voter bound: one member cannot hold more than MAX_PENDING_VOTES_PER_VOTER distinct early polls; extra ones are dropped, others unaffected', async () => {
    for (let i = 0; i < MAX_PENDING_VOTES_PER_VOTER + 5; i++) {
      await vote(GROUP_A, ATTACKER, ['A'], `spam-${i}`);
    }
    await vote(GROUP_A, VOTER_A, ['A'], 'legit');
    const stored = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as Array<{ voterPubkey: string; pollId: string }>;
    expect(stored.filter((e) => e.voterPubkey === ATTACKER)).toHaveLength(MAX_PENDING_VOTES_PER_VOTER);
    expect(stored.filter((e) => e.voterPubkey === ATTACKER).map((e) => e.pollId)).toEqual(
      Array.from({ length: MAX_PENDING_VOTES_PER_VOTER }, (_, i) => `spam-${i}`),
    );
    expect(stored.some((e) => e.voterPubkey === VOTER_A && e.pollId === 'legit')).toBe(true);
    // A changed vote for an already-queued poll is still accepted at the cap
    // (kept next to the earlier one, which arrived first), without a new poll.
    await vote(GROUP_A, ATTACKER, ['B'], 'spam-0', 1_700_000_100);
    const after = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as Array<{ voterPubkey: string; pollId: string; responses: string[] }>;
    expect(after.filter((e) => e.pollId === 'spam-0').map((e) => e.responses)).toEqual([['A'], ['B']]);
    expect(new Set(after.filter((e) => e.voterPubkey === ATTACKER).map((e) => e.pollId)).size).toBe(MAX_PENDING_VOTES_PER_VOTER);
  });

  it('per-group bound: the queue never exceeds MAX_PENDING_VOTES_PER_GROUP; the oldest-received entries are evicted', async () => {
    const voters = Math.ceil((MAX_PENDING_VOTES_PER_GROUP + 3) / MAX_PENDING_VOTES_PER_VOTER);
    let n = 0;
    for (let v = 0; v < voters; v++) {
      for (let p = 0; p < MAX_PENDING_VOTES_PER_VOTER; p++) {
        await queuePendingVote({ groupId: GROUP_A, pollId: `p-${n}`, voterPubkey: `v-${v}`, responses: ['A'], votedAt: 1 }, 1000 + n);
        n++;
      }
    }
    const stored = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as Array<{ pollId: string }>;
    expect(stored).toHaveLength(MAX_PENDING_VOTES_PER_GROUP);
    expect(stored.some((e) => e.pollId === 'p-0')).toBe(false);
    expect(stored.some((e) => e.pollId === `p-${n - 1}`)).toBe(true);
  });

  it('leaving the group (clearPollData) and a full reset (clearAllPollData) discard queued votes', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_B, VOTER_A, ['A']);
    await clearPollData(GROUP_A);
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_A}`)).toBe(false);
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_B}`)).toBe(true);
    await clearAllPollData();
    expect([...idbStore.keys()].filter((k) => k.startsWith('few:poll'))).toEqual([]);
  });

  it('queued votes survive a "reload" (module state discarded) because the queue is persisted', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    vi.resetModules();
    const fresh = await import('@/src/lib/marmot/pollPersistence');
    const handlers = await import('@/src/lib/marmot/handlers/pollHandler');
    await handlers.createPollOpenHandler({ ...fresh, setPollVersion: vi.fn() }).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(GROUP_A), sender(CREATOR));
    expect(await fresh.loadVotes(GROUP_A, POLL_ID)).toHaveLength(1);
  });
});

// ─── VQ-4 ────────────────────────────────────────────────────────────────────

describe('VQ-4: receive-side caps equal creation caps', () => {
  const opts = (n: number, labelLen = 3) => Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(65 + i), label: 'x'.repeat(labelLen) }));
  const parse = (o: Record<string, unknown>) => parsePollOpen(JSON.stringify(openPayload(o)));

  it('creation caps are 2–10 options, title 200, description 500, option label 100', () => {
    expect(POLL_LIMITS).toEqual({ MIN_OPTIONS: 2, MAX_OPTIONS: 10, MAX_TITLE_LEN: 200, MAX_DESC_LEN: 500, MAX_OPTION_LEN: 100 });
  });

  it.each([
    ['options at max', { options: opts(10) }, true],
    ['options over max', { options: opts(11) }, false],
    ['title at max', { title: 't'.repeat(200) }, true],
    ['title over max', { title: 't'.repeat(201) }, false],
    ['description at max', { description: 'd'.repeat(500) }, true],
    ['description over max', { description: 'd'.repeat(501) }, false],
    ['description not a string', { description: 42 }, false],
    ['option label at max', { options: opts(2, 100) }, true],
    ['option label over max', { options: opts(2, 101) }, false],
  ])('%s → accepted=%s', (_name, o, accepted) => {
    expect(parse(o) !== null).toBe(accepted);
  });

  it('an oversized poll-open is not stored by the receiving handler', async () => {
    await open(GROUP_A, CREATOR, openPayload({ options: opts(11) }));
    expect(await getPoll(GROUP_A, POLL_ID)).toBeNull();
  });

  it('id length caps: pollId ≤ MAX_POLL_ID_LEN everywhere, option id and response id ≤ MAX_OPTION_ID_LEN', () => {
    expect(POLL_ID_LIMITS).toEqual({ MAX_POLL_ID_LEN: 64, MAX_OPTION_ID_LEN: 8 });
    const pid = (n: number) => 'p'.repeat(n);
    expect(parse({ id: pid(64) })).not.toBeNull();
    expect(parse({ id: pid(65) })).toBeNull();
    expect(parse({ id: '' })).toBeNull();
    expect(parse({ options: [{ id: 'x'.repeat(8), label: 'a' }, { id: 'B', label: 'b' }] })).not.toBeNull();
    expect(parse({ options: [{ id: 'x'.repeat(9), label: 'a' }, { id: 'B', label: 'b' }] })).toBeNull();
    expect(parse({ options: [{ id: '', label: 'a' }, { id: 'B', label: 'b' }] })).toBeNull();
    expect(parsePollVote(JSON.stringify({ pollId: pid(64), responses: ['x'.repeat(8)] }))).not.toBeNull();
    expect(parsePollVote(JSON.stringify({ pollId: pid(65), responses: ['A'] }))).toBeNull();
    expect(parsePollVote(JSON.stringify({ pollId: '', responses: ['A'] }))).toBeNull();
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: ['x'.repeat(9)] }))).toBeNull();
    expect(parsePollClose(JSON.stringify({ pollId: pid(64), results: [], totalVoters: 0 }))).not.toBeNull();
    expect(parsePollClose(JSON.stringify({ pollId: pid(65), results: [], totalVoters: 0 }))).toBeNull();
  });

  it('the ids createPoll generates (UUID poll id, "A".."J" option ids) are within the caps', () => {
    const options = Array.from({ length: 10 }, (_, i) => ({ id: String.fromCharCode(65 + i), label: 'o' }));
    expect(parse({ id: crypto.randomUUID(), options })).not.toBeNull();
  });

  it('a vote with more responses than any poll can have options is rejected on receipt', () => {
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: opts(10).map((o) => o.id) }))).not.toBeNull();
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: opts(11).map((o) => o.id) }))).toBeNull();
  });
});

// ─── Mutation-audit gap closers (behaviour-level) ────────────────────────────

describe('early-vote queue: per-poll isolation and storage hygiene', () => {
  it('opening one poll applies only ITS queued votes — votes queued for another poll stay queued and never land on the opened poll', async () => {
    await vote(GROUP_A, VOTER_A, ['A'], 'p1');
    await vote(GROUP_A, VOTER_B, ['B'], 'p2');
    await open(GROUP_A, CREATOR, openPayload({ id: 'p1' }));

    const p1 = await loadVotes(GROUP_A, 'p1');
    expect(p1.map((v) => v.voterPubkey)).toEqual([VOTER_A]);

    await open(GROUP_A, CREATOR, openPayload({ id: 'p2' }));
    expect((await loadVotes(GROUP_A, 'p2')).map((v) => v.voterPubkey)).toEqual([VOTER_B]);
  });

  it('a drained queue leaves no stored key behind', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await open(GROUP_A, CREATOR);
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_A}`)).toBe(false);
  });

  it('eviction is by receipt time, not insertion order', async () => {
    // Fill the group to the cap with receipt times counting DOWN, so the
    // last-inserted entry is the oldest-received one.
    let n = 0;
    const voters = Math.ceil(MAX_PENDING_VOTES_PER_GROUP / MAX_PENDING_VOTES_PER_VOTER);
    for (let v = 0; v < voters; v++) {
      for (let p = 0; p < MAX_PENDING_VOTES_PER_VOTER && n < MAX_PENDING_VOTES_PER_GROUP; p++) {
        await queuePendingVote({ groupId: GROUP_A, pollId: `p-${n}`, voterPubkey: `v-${v}`, responses: ['A'], votedAt: 1 }, 10_000 - n);
        n++;
      }
    }
    await queuePendingVote({ groupId: GROUP_A, pollId: 'newest', voterPubkey: 'v-new', responses: ['A'], votedAt: 1 }, 20_000);
    const stored = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as Array<{ pollId: string }>;
    expect(stored).toHaveLength(MAX_PENDING_VOTES_PER_GROUP);
    expect(stored.some((e) => e.pollId === `p-${n - 1}`)).toBe(false); // oldest-received evicted
    expect(stored.some((e) => e.pollId === 'p-0')).toBe(true);
    expect(stored.some((e) => e.pollId === 'newest')).toBe(true);
  });

  it('the TTL is seven days (AC-9)', () => {
    expect(PENDING_VOTE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['null', null],
    ['missing pollId', { voterPubkey: VOTER_A, responses: ['A'] }],
    ['missing voter', { pollId: POLL_ID, responses: ['A'] }],
    ['voter not a string', { pollId: POLL_ID, voterPubkey: 7, responses: ['A'] }],
    ['responses not an array', { pollId: POLL_ID, voterPubkey: VOTER_A, responses: 'A' }],
    ['receivedAt not a number', { pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['A'], receivedAt: 'now' }],
  ])('a corrupt stored queue entry (%s) is ignored, never applied', async (_name, junk) => {
    // Fresh receipt time (unless the case overrides it) so the entry is
    // rejected for its shape, not merely for being expired.
    const entry = junk === null ? null : { votedAt: 1, receivedAt: Date.now(), ...junk };
    idbStore.set(`few:poll-pending-votes:${GROUP_A}`, [entry]);
    await open(GROUP_A, CREATOR);
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);
  });

  it('every poll message bumps the UI version by exactly one', async () => {
    const bumps: number[] = [];
    const record = (deps: { setPollVersion: ReturnType<typeof vi.fn> }) => {
      for (const [updater] of deps.setPollVersion.mock.calls) bumps.push((updater as (v: number) => number)(5));
    };
    record(await open(GROUP_A, CREATOR));
    record(await vote(GROUP_A, VOTER_A, ['A']));
    const closeDeps = realDeps();
    await createPollCloseHandler(closeDeps).handle(rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }), ctx(GROUP_A), sender(CREATOR));
    record(closeDeps);
    expect(bumps).toEqual([6, 6, 6]);
  });
});

describe('early-vote replay is crash-safe (read → save → remove)', () => {
  it('a save failure during replay leaves the queued votes in the queue (not lost)', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_A, VOTER_B, ['B']);
    const deps = { ...realDeps(), saveVoteIfNewer: vi.fn(async () => { throw new Error('unload'); }) };
    await expect(
      createPollOpenHandler(deps).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(GROUP_A), sender(CREATOR)),
    ).rejects.toThrow('unload');
    const stored = idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as unknown[];
    expect(stored).toHaveLength(2);
  });

  it('a failure between save and remove leaves votes saved AND queued; replaying again is idempotent (no double count)', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_A, VOTER_B, ['B']);
    const failing = { ...realDeps(), removePendingVotes: vi.fn(async () => { throw new Error('unload'); }) };
    // The removal is clean-up only (the votes are stored), so it no longer
    // fails the open (bug: poll-residual-ordering-and-close-retry).
    await expect(
      createPollOpenHandler(failing).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(GROUP_A), sender(CREATOR)),
    ).resolves.toBeUndefined();
    expect(failing.removePendingVotes).toHaveBeenCalledOnce();
    expect(await loadVotes(GROUP_A, POLL_ID)).toHaveLength(2);
    expect((idbStore.get(`few:poll-pending-votes:${GROUP_A}`) as unknown[])).toHaveLength(2);

    const poll = await getPoll(GROUP_A, POLL_ID);
    await replayPendingVotes(poll!, realDeps());
    await replayPendingVotes(poll!, realDeps());
    expect(await loadVotes(GROUP_A, POLL_ID)).toHaveLength(2);
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_A}`)).toBe(false);
    expect(counts(await close(GROUP_A, CREATOR))).toEqual({ A: 1, B: 1 });
  });

  it('removal only drops the entries that were applied — a newer early vote queued meanwhile survives', async () => {
    const t0 = Date.now();
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t0);
    const applied = await loadPendingVotes(GROUP_A, POLL_ID, t0);
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['B'], votedAt: 2 }, t0 + 1);
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_B, responses: ['B'], votedAt: 2 }, t0 + 1);
    await removePendingVotes(GROUP_A, applied, t0 + 2);
    const left = await loadPendingVotes(GROUP_A, POLL_ID, t0 + 2);
    expect(left.map((e) => [e.voterPubkey, e.responses])).toEqual([[VOTER_A, ['B']], [VOTER_B, ['B']]]);
  });
});

describe('removePendingVotes matches poll, voter AND receipt time', () => {
  it('applying one poll\'s entries never removes a same-voter/same-time entry of another poll, or another voter\'s same-time entry', async () => {
    const t = Date.now();
    await queuePendingVote({ groupId: GROUP_A, pollId: 'p1', voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t);
    await queuePendingVote({ groupId: GROUP_A, pollId: 'p2', voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 }, t);
    await queuePendingVote({ groupId: GROUP_A, pollId: 'p1', voterPubkey: VOTER_B, responses: ['A'], votedAt: 1 }, t);
    const applied = (await loadPendingVotes(GROUP_A, 'p1', t)).filter((e) => e.voterPubkey === VOTER_A);
    await removePendingVotes(GROUP_A, applied, t);
    expect((await loadPendingVotes(GROUP_A, 'p2', t)).map((e) => e.voterPubkey)).toEqual([VOTER_A]);
    expect((await loadPendingVotes(GROUP_A, 'p1', t)).map((e) => e.voterPubkey)).toEqual([VOTER_B]);
  });
});

describe('vote storage hygiene', () => {
  it('loadVotes ignores a row whose own groupId/pollId do not match the key it sits under', async () => {
    idbStore.set(`few:poll-votes:${GROUP_A}:${POLL_ID}`, [
      { id: `${POLL_ID}:${VOTER_A}`, groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 },
      { id: `${POLL_ID}:${VOTER_B}`, groupId: GROUP_B, pollId: POLL_ID, voterPubkey: VOTER_B, responses: ['A'], votedAt: 1 },
      { id: `other:${VOTER_B}`, groupId: GROUP_A, pollId: 'other', voterPubkey: VOTER_B, responses: ['A'], votedAt: 1 },
    ]);
    expect((await loadVotes(GROUP_A, POLL_ID)).map((v) => v.voterPubkey)).toEqual([VOTER_A]);
  });

  it('clearAllPollData removes only poll keys — unrelated app data survives', async () => {
    idbStore.set('few:chat:g', ['m']);
    idbStore.set('x-few:polls:g', 1);
    await open(GROUP_A, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A']);
    await vote(GROUP_A, VOTER_A, ['A'], 'early');
    await clearAllPollData();
    expect([...idbStore.keys()].sort()).toEqual(['few:chat:g', 'x-few:polls:g']);
  });

  it('clearPollData leaves unrelated keys and other groups\' queues alone', async () => {
    idbStore.set('few:chat:g', ['m']);
    await vote(GROUP_B, VOTER_A, ['A']);
    await clearPollData(GROUP_A);
    expect(idbStore.has('few:chat:g')).toBe(true);
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_B}`)).toBe(true);
  });
});

describe('legacy migration edge cases', () => {
  it('a legacy-shaped row inside a group-scoped key is stripped while that key\'s group-scoped rows are kept', async () => {
    idbStore.set(`few:polls:${GROUP_A}`, [null, { junk: true }, storedPoll(GROUP_A, POLL_ID)]);
    const scoped = { id: `${POLL_ID}:${VOTER_B}`, groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_B, responses: ['B'], votedAt: 1 };
    idbStore.set(`few:poll-votes:${GROUP_A}:${POLL_ID}`, [scoped, legacyVote(POLL_ID, VOTER_A, ['A'])]);
    await migrateLegacyVotes();
    expect(idbStore.get(`few:poll-votes:${GROUP_A}:${POLL_ID}`)).toEqual([scoped]);
  });

  it.each([
    ['id', { id: 1 }],
    ['pollId', { pollId: 1 }],
    ['voterPubkey', { voterPubkey: 1 }],
    ['responses', { responses: 'A' }],
    ['votedAt', { votedAt: '5' }],
  ])('a legacy row with a malformed %s is dropped, its valid siblings migrate', async (_f, bad) => {
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A']), { ...legacyVote('pp', VOTER_B, ['A']), ...bad }]);
    await migrateLegacyVotes();
    expect((await loadVotes(GROUP_A, 'pp')).map((v) => v.voterPubkey)).toEqual([VOTER_A]);
    expect(idbStore.has('few:poll-votes:pp')).toBe(false);
  });

  it('a non-array legacy value is removed', async () => {
    idbStore.set('few:poll-votes:weird', { not: 'an array' });
    await migrateLegacyVotes();
    expect(idbStore.has('few:poll-votes:weird')).toBe(false);
  });

  it('a failed migration makes vote READS fail (so a close fails closed instead of persisting a partial tally); the next use retries', async () => {
    const idb = await import('idb-keyval');
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A'])]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(idb.keys).mockRejectedValueOnce(new Error('idb down'));

    await expect(loadVotes(GROUP_A, 'pp')).rejects.toThrow('idb down');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('migration failed'), expect.any(Error));
    expect(await loadVotes(GROUP_A, 'pp')).toHaveLength(1);
    warn.mockRestore();
  });

  it('a close during a failed migration persists NO tally; a close after a successful retry persists the full one', async () => {
    const idb = await import('idb-keyval');
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A']), legacyVote('pp', VOTER_B, ['B'])]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(idb.keys).mockRejectedValueOnce(new Error('idb down'));

    await expect(
      createPollCloseHandler(realDeps()).handle(rumor(POLL_CLOSE_KIND, CREATOR, { pollId: 'pp', results: [], totalVoters: 0 }), ctx(GROUP_A), sender(CREATOR)),
    ).rejects.toThrow();
    expect((await getPoll(GROUP_A, 'pp'))?.closed).toBe(false);

    const closed = await close(GROUP_A, CREATOR, 'pp');
    expect(closed?.totalVoters).toBe(2);
    expect(counts(closed)).toEqual({ A: 1, B: 1 });
    warn.mockRestore();
  });

  it('a failed migration does not block vote WRITES', async () => {
    const idb = await import('idb-keyval');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(idb.keys).mockRejectedValueOnce(new Error('idb down'));
    await saveVoteIfNewer({ id: `p:${VOTER_A}`, groupId: GROUP_A, pollId: 'p', voterPubkey: VOTER_A, responses: ['A'], votedAt: 1 });
    expect(await loadVotes(GROUP_A, 'p')).toHaveLength(1);
    warn.mockRestore();
  });

  it('clearAllPollData waits for an in-flight migration, so the migration cannot re-create keys after the reset', async () => {
    const idb = await import('idb-keyval');
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A'])]);
    // Hold the migration mid-run: its 2nd read (the legacy vote key) resolves
    // only after the reset has had every chance to run.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realGet = vi.mocked(idb.get).getMockImplementation()!;
    vi.mocked(idb.get)
      .mockImplementationOnce(realGet)
      .mockImplementationOnce(async (k) => { const v = await realGet(k); await gate; return v; });
    const read = loadVotes(GROUP_A, 'pp'); // starts the migration
    await new Promise((r) => setTimeout(r, 0)); // migration is now parked on the legacy read
    const reset = clearAllPollData();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await reset;
    await read;
    expect([...idbStore.keys()].filter((k) => k.startsWith('few:poll'))).toEqual([]);
  });
});

describe('receive-side parsing: malformed shapes', () => {
  const base = openPayload();
  it.each([
    ['id not a string', { ...base, id: 1 }],
    ['title not a string', { ...base, title: 1 }],
    ['option is null', { ...base, options: [null, { id: 'B', label: 'b' }] }],
    ['option id not a string', { ...base, options: [{ id: 1, label: 'a' }, { id: 'B', label: 'b' }] }],
    ['creatorPubkey missing', { ...base, creatorPubkey: undefined }],
  ])('parsePollOpen rejects %s', (_n, payload) => {
    expect(parsePollOpen(JSON.stringify(payload))).toBeNull();
  });

  it.each([
    ['pollId missing', { results: [], totalVoters: 0 }],
    ['results not an array', { pollId: 'p', results: {}, totalVoters: 0 }],
    ['result optionId not a string', { pollId: 'p', results: [{ optionId: 1, label: 'a', count: 0 }], totalVoters: 0 }],
  ])('parsePollClose rejects %s', (_n, payload) => {
    expect(parsePollClose(JSON.stringify(payload))).toBeNull();
  });

  it('parsePollVote rejects a response list with any non-string entry', () => {
    expect(parsePollVote(JSON.stringify({ pollId: 'p', responses: ['A', 1] }))).toBeNull();
  });
});

// ─── Remediation round 2: re-entrant early-vote replay ──────────────────────

describe('stranded queued votes are recovered at the next poll message (re-entrant replay)', () => {
  const failOnce = <T extends (...a: any[]) => Promise<any>>(real: T) =>
    vi.fn(real).mockRejectedValueOnce(new Error('unload')) as unknown as T;

  async function openWith(deps: ReturnType<typeof realDeps>) {
    return createPollOpenHandler(deps).handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(GROUP_A), sender(CREATOR));
  }

  it('(i) replay failing at poll-open → the later close still tallies the queued vote', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await expect(openWith({ ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) })).rejects.toThrow('unload');
    expect(await getPoll(GROUP_A, POLL_ID)).not.toBeNull();
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);

    const closed = await close(GROUP_A, CREATOR);
    expect(closed?.totalVoters).toBe(1);
    expect(counts(closed)).toEqual({ A: 1, B: 0 });
  });

  it('(ii) a save failing during open-replay → the next live vote recovers the queued one', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await expect(openWith({ ...realDeps(), saveVoteIfNewer: failOnce(saveVoteIfNewer) })).rejects.toThrow('unload');
    expect(await loadVotes(GROUP_A, POLL_ID)).toEqual([]);

    await vote(GROUP_A, VOTER_B, ['B']);
    expect((await loadVotes(GROUP_A, POLL_ID)).map((v) => v.voterPubkey).sort()).toEqual([VOTER_A, VOTER_B].sort());
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_A}`)).toBe(false);
    expect(counts(await close(GROUP_A, CREATOR))).toEqual({ A: 1, B: 1 });
  });

  it('(iii) newer wins: a stranded OLDER queued vote never overrides the voter\'s newer live vote', async () => {
    await vote(GROUP_A, VOTER_A, ['A'], POLL_ID, 100);
    await expect(openWith({ ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) })).rejects.toThrow();
    // The live vote's own replay attempt fails too, so the queued entry is still stranded.
    const voteDeps = { ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createPollVoteHandler(voteDeps).handle(rumor(POLL_VOTE_KIND, VOTER_A, { pollId: POLL_ID, responses: ['B'] }, 200), ctx(GROUP_A), sender(VOTER_A));
    warn.mockRestore();
    expect((await loadVotes(GROUP_A, POLL_ID))[0].responses).toEqual(['B']);

    const closed = await close(GROUP_A, CREATOR);
    expect(counts(closed)).toEqual({ A: 0, B: 1 });
    expect(idbStore.has(`few:poll-pending-votes:${GROUP_A}`)).toBe(false); // skipped entry still removed
  });

  it('(iii-b) an OLDER live vote stored earlier is replaced by a NEWER queued vote on replay', async () => {
    await open(GROUP_A, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A'], POLL_ID, 100);
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['B'], votedAt: 200_000 });
    expect(counts(await close(GROUP_A, CREATOR))).toEqual({ A: 0, B: 1 });
  });

  it('(iv) a replay failure during close fails the close closed — nothing persisted as closed; a later close succeeds', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await expect(openWith({ ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) })).rejects.toThrow();
    const closeDeps = { ...realDeps(), savePoll: vi.fn(savePoll), loadPendingVotes: failOnce(loadPendingVotes) };
    await expect(
      createPollCloseHandler(closeDeps).handle(rumor(POLL_CLOSE_KIND, CREATOR, { pollId: POLL_ID, results: [], totalVoters: 0 }), ctx(GROUP_A), sender(CREATOR)),
    ).rejects.toThrow('unload');
    expect(closeDeps.savePoll).not.toHaveBeenCalled();
    expect((await getPoll(GROUP_A, POLL_ID))?.closed).toBe(false);
    expect(counts(await close(GROUP_A, CREATOR))).toEqual({ A: 1, B: 0 });
  });

  it('(v) the poll_close chat announcement includes the recovered vote, matching the persisted close', async () => {
    const { createChatHandler } = await import('@/src/lib/marmot/handlers/chatHandler');
    await vote(GROUP_A, VOTER_A, ['B']);
    await expect(openWith({ ...realDeps(), loadPendingVotes: failOnce(loadPendingVotes) })).rejects.toThrow();

    const appendMessage = vi.fn(async () => {});
    const chatDeps = {
      appendMessage,
      incrementUnread: vi.fn(),
      markAsRead: vi.fn(),
      setChatVersion: vi.fn(),
      applyDeleteEditSignal: vi.fn(),
      resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP_A }, slotId: null, kind: 'noop' as const })),
      isGroupAdmin: vi.fn(async () => false),
      isGroupMember: vi.fn(async () => true),
      getPoll,
      loadVotes,
      saveVoteIfNewer,
      loadPendingVotes,
      removePendingVotes,
    };
    const content = JSON.stringify({ type: 'poll_close', pollId: POLL_ID, title: 'Best color?', results: [], totalVoters: 0 });
    await createChatHandler(chatDeps as never).handle(
      { id: 'chat-close-1', pubkey: CREATOR, created_at: 1_700_000_000, kind: 9, content, tags: [] },
      ctx(GROUP_A),
      sender(CREATOR),
    );
    expect(appendMessage).toHaveBeenCalledOnce();
    const persisted = JSON.parse((appendMessage.mock.calls[0] as unknown as [string, { content: string }])[1].content);
    expect(persisted.totalVoters).toBe(1);
    expect(persisted.results.find((r: { optionId: string }) => r.optionId === 'B').count).toBe(1);

    const closed = await close(GROUP_A, CREATOR);
    expect(closed?.totalVoters).toBe(persisted.totalVoters);
  });

  it('(vi) a migration target write serialises with a concurrent saveVoteIfNewer — the live vote is not lost', async () => {
    const idb = await import('idb-keyval');
    await loadVotes(GROUP_A, 'warm-up'); // settle the session migration memo
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A'])]);
    const target = `few:poll-votes:${GROUP_A}:pp`;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realGet = vi.mocked(idb.get).getMockImplementation()!;
    let gated = false;
    vi.mocked(idb.get).mockImplementation(async (k) => {
      const v = await realGet(k);
      if (k === target && !gated) { gated = true; await gate; }
      return v;
    });
    try {
      const migrating = migrateLegacyVotes(); // parks on its first read of the target key
      await new Promise((r) => setTimeout(r, 0));
      const saving = saveVoteIfNewer({ id: `pp:${VOTER_B}`, groupId: GROUP_A, pollId: 'pp', voterPubkey: VOTER_B, responses: ['B'], votedAt: 9 });
      await new Promise((r) => setTimeout(r, 10)); // give the save every chance to overtake
      release();
      await Promise.all([migrating, saving]);
    } finally {
      vi.mocked(idb.get).mockImplementation(realGet);
    }
    expect((await loadVotes(GROUP_A, 'pp')).map((v) => v.voterPubkey).sort()).toEqual([VOTER_A, VOTER_B].sort());
  });
});

describe('round-2 mutation-gap closers', () => {
  it('a re-delivered/duplicate poll-open of an OPEN poll recovers stranded votes; of a CLOSED poll it applies nothing', async () => {
    await vote(GROUP_A, VOTER_A, ['A']);
    await expect(
      createPollOpenHandler({ ...realDeps(), loadPendingVotes: vi.fn(loadPendingVotes).mockRejectedValueOnce(new Error('x')) as never })
        .handle(rumor(POLL_OPEN_KIND, CREATOR, openPayload()), ctx(GROUP_A), sender(CREATOR)),
    ).rejects.toThrow();
    await open(GROUP_A, ATTACKER, openPayload()); // reused id → guard keeps the original poll
    expect((await loadVotes(GROUP_A, POLL_ID)).map((v) => v.voterPubkey)).toEqual([VOTER_A]);
    expect((await getPoll(GROUP_A, POLL_ID))?.creatorPubkey).toBe(CREATOR);

    await close(GROUP_A, CREATOR);
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_B, responses: ['B'], votedAt: 1 });
    await open(GROUP_A, CREATOR, openPayload());
    expect(await loadVotes(GROUP_A, POLL_ID)).toHaveLength(1);
  });

  it('equal seq and votedAt: the rumor id decides — a queued entry without one never overrides the stored vote', async () => {
    await open(GROUP_A, CREATOR);
    await vote(GROUP_A, VOTER_A, ['A'], POLL_ID, 100);
    await queuePendingVote({ groupId: GROUP_A, pollId: POLL_ID, voterPubkey: VOTER_A, responses: ['B'], votedAt: 100_000 });
    expect(counts(await close(GROUP_A, CREATOR))).toEqual({ A: 1, B: 0 });
  });

  it('migration merges legacy rows into a target that already holds OTHER voters\' group-scoped rows', async () => {
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set(`few:poll-votes:${GROUP_A}:pp`, [{ ...legacyVote('pp', VOTER_B, ['B']), groupId: GROUP_A }]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A'])]);
    await migrateLegacyVotes();
    expect((await loadVotes(GROUP_A, 'pp')).map((v) => v.voterPubkey).sort()).toEqual([VOTER_A, VOTER_B].sort());
  });

  it('duplicate legacy entries with the same id migrate as one row', async () => {
    idbStore.set(`few:polls:${GROUP_A}`, [storedPoll(GROUP_A, 'pp')]);
    idbStore.set('few:poll-votes:pp', [legacyVote('pp', VOTER_A, ['A']), legacyVote('pp', VOTER_A, ['B'])]);
    await migrateLegacyVotes();
    const rows = await loadVotes(GROUP_A, 'pp');
    expect(rows).toHaveLength(1);
    expect(rows[0].responses).toEqual(['A']);
  });
});
