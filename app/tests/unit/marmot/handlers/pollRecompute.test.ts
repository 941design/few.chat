// @vitest-environment node
/**
 * Poll withdrawal on the history-sink path is RECOMPUTE-ON-RETRACT (AC-WDR-7): after any sequence of appends
 * and withdraws the poll stores equal what dispatching ONLY the remaining history rows, in seq order, into
 * EMPTY stores produces (the oracle, see oracle.ts). Matrix items covered here for polls (kinds 10 / 11 / 12):
 *
 *  (1) property: random appends / withdraw subsets in random order, duplicate carriers, mixed senders
 *  (5) duplicate carriers of an open / vote / close, both withdraw orders
 *  (6) a forged byte-identical open / vote / close copy: withdraw the forger's copy -> victim intact;
 *      withdraw the victim's -> nothing attributed to the victim, the copy judged as its sender's own
 *  (8) withdrawn newer vote reveals older (also beyond MAX_VOTES_KEPT_PER_VOTER), vote on a closed poll,
 *      close with another remaining, sole close, non-creator close, open withdrawn / re-appended, votes before a close
 *  (10) batch withdraw of one aggregate: no intermediate state, one UI bump
 *  (11) a failed recompute leaves the withdraw retryable and the retry converges
 *  (12) late retract (a dispatch that outlives the settle bound) recomputes
 *  (13) no effects during recompute; a purged retract folds nothing
 *  (14) retract twice / unseen id changes nothing
 *  (15) clock determinism: held entries and "vote before close" do not depend on the wall clock at recompute
 *
 * Real collaborators: the HistoryBackend, the dispatcher and every store over fake-indexeddb (realApp.ts).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createPollCloseGroupHandler, createPollOpenGroupHandler, createPollVoteGroupHandler, type PollGroupHandlerDeps } from '@/src/lib/marmot/handlers/pollHandler';
import * as store from '@/src/lib/marmot/pollPersistence';
import { MAX_VOTES_KEPT_PER_VOTER, snapshotPollState } from '@/src/lib/marmot/pollPersistence';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import { initUnreadCounts } from '@/src/lib/unreadStore';
import { ALICE, BOB, buildRealApp, ev, installLocalStorage, MALLORY, SELF, unreadOf, type RealApp } from './realApp';
import { append, runOracle, runSteps, withdraw, type Step } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

const POLL = 'poll-1';
const OTHER = 'poll-2';

const openC = (id = POLL) => JSON.stringify({ id, title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: ALICE });
const voteC = (responses: string[], seq = 1, pollId = POLL) => JSON.stringify({ pollId, responses, seq });
const closeC = (pollId = POLL) => JSON.stringify({ pollId, results: [], totalVoters: 0 });

let apps: RealApp[] = [];
let extraSinks: AppHistoryBackend[] = [];
// Group ids must never equal an account pubkey (the oracle normalises the group id textually): realApp's default
// counter repeats a byte 01, 02, .. aa .. and so collides with SELF at the 170th group of a run.
let groupCounter = 0;
const nextGroup = () => (0x1000 + ++groupCounter).toString(16).padStart(64, '0');
const make = () => {
  const app = buildRealApp({ groupId: nextGroup() });
  apps.push(app);
  return app;
};
beforeEach(() => {
  installLocalStorage();
  apps = [];
  extraSinks = [];
});
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps) await app.sink.dispose();
  for (const sink of extraSinks) await sink.dispose();
});

// ---- entry builders ---------------------------------------------------------------------------------------------

type EntryOpts = { rumorId?: string; at?: number; pubkey?: string };
const open = (app: RealApp, label: string, account: string, o: EntryOpts & { id?: string } = {}) =>
  app.entry({ eventId: label, kind: POLL_OPEN_KIND, account, content: openC(o.id), rumorId: o.rumorId, at: o.at, pubkey: o.pubkey });
const vote = (app: RealApp, label: string, account: string, responses: string[], o: EntryOpts & { seq?: number; pollId?: string } = {}) =>
  app.entry({ eventId: label, kind: POLL_VOTE_KIND, account, content: voteC(responses, o.seq ?? 1, o.pollId), rumorId: o.rumorId, at: o.at, pubkey: o.pubkey });
const close = (app: RealApp, label: string, account: string, o: EntryOpts & { pollId?: string } = {}) =>
  app.entry({ eventId: label, kind: POLL_CLOSE_KIND, account, content: closeC(o.pollId), rumorId: o.rumorId, at: o.at, pubkey: o.pubkey });

// ---- the oracle comparison, scoped to the poll stores ---------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}
/** Every poll store of a group, normalised (the group id is replaced, time fields are already stripped). */
async function pollSnapshot(groupId: string): Promise<unknown> {
  // loadPolls orders by createdAt only: among equal createdAt the list order is not part of the contract, so sort by id
  const polls = (await store.loadPolls(groupId)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const raw = { polls, state: await snapshotPollState(groupId) };
  return stable(JSON.parse(JSON.stringify(raw).split(groupId).join('<G>')));
}
async function expectPollOracle(groupId: string, steps: readonly Step[], msg?: string): Promise<void> {
  const oracle = await runOracle(steps, make);
  expect(await pollSnapshot(groupId), msg).toEqual(await pollSnapshot(oracle.groupId));
}

const poll = (app: RealApp) => store.getPoll(app.groupId, POLL);
const votesOf = async (app: RealApp, pollId = POLL) => (await store.loadVotes(app.groupId, pollId)).map((v) => [v.voterPubkey, v.responses.join(','), v.rumorId]);

/** Appends, then withdraws one by one, checking the oracle after every step. */
async function runChecked(app: RealApp, steps: readonly Step[]): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    await runSteps(app, [steps[i]]);
    await expectPollOracle(app.groupId, steps.slice(0, i + 1), `after step ${i}`);
  }
}

// ---- (8) polls -----------------------------------------------------------------------------------------------

describe('(8) a withdrawn vote reveals the voter\'s older votes (the aggregate is rebuilt from what remains)', () => {
  it('withdrawing the newest vote promotes the previous one', async () => {
    const app = make();
    const steps = [
      append(open(app, 'o', BOB)),
      append(vote(app, 'v1', ALICE, ['A'], { seq: 1 })),
      append(vote(app, 'v2', ALICE, ['B'], { seq: 2 })),
      withdraw('v2'),
    ];
    await runChecked(app, steps);
    expect(await votesOf(app)).toEqual([[ALICE, 'A', 'rumor-v1']]);
  });

  it(`reveals votes the live store had already dropped beyond MAX_VOTES_KEPT_PER_VOTER (${MAX_VOTES_KEPT_PER_VOTER})`, async () => {
    const app = make();
    const total = MAX_VOTES_KEPT_PER_VOTER + 5;
    const steps: Step[] = [append(open(app, 'o', BOB))];
    for (let s = 1; s <= total; s++) steps.push(append(vote(app, `v${s}`, ALICE, [s % 2 ? 'A' : 'B'], { seq: s })));
    await runSteps(app, steps);
    const kept = (await store.loadVotes(app.groupId, POLL))[0];
    expect([kept.seq, kept.superseded?.length]).toEqual([total, MAX_VOTES_KEPT_PER_VOTER - 1]);
    expect(kept.superseded?.some((v) => v.seq === 1)).toBe(false); // vote 1 fell out of the cap

    steps.push(withdraw(`v${total}`));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    const after = (await store.loadVotes(app.groupId, POLL))[0];
    expect([after.seq, after.superseded?.length]).toEqual([total - 1, MAX_VOTES_KEPT_PER_VOTER - 1]);
    // withdrawing five newest votes: the row is vote 20, and the oldest snapshot is vote 1 again
    for (let s = total - 1; s > total - 5; s--) steps.push(withdraw(`v${s}`));
    await runSteps(app, steps.slice(-4));
    await expectPollOracle(app.groupId, steps);
    const last = (await store.loadVotes(app.groupId, POLL))[0];
    expect([last.seq, last.superseded?.some((v) => v.seq === 1)]).toEqual([MAX_VOTES_KEPT_PER_VOTER, true]);
  });

  it('a withdrawn vote on a closed poll recomputes the frozen tally and totalVoters', async () => {
    const app = make();
    const steps: Step[] = [
      append(open(app, 'o', BOB)),
      append(vote(app, 'v1', ALICE, ['A'])),
      append(vote(app, 'v2', MALLORY, ['B'])),
      append(close(app, 'c', BOB)),
    ];
    await runSteps(app, steps);
    expect((await poll(app))?.totalVoters).toBe(2);
    steps.push(withdraw('v2'));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    const p = await poll(app);
    expect([p?.closed, p?.totalVoters, p?.results?.map((r) => r.count)]).toEqual([true, 1, [1, 0]]);
  });

  it('withdrawing one of two closes keeps the poll closed; withdrawing the sole close reopens it and clears the tally', async () => {
    const app = make();
    const steps: Step[] = [
      append(open(app, 'o', BOB)),
      append(vote(app, 'v1', ALICE, ['A'])),
      append(close(app, 'c1', BOB)),
      append(close(app, 'c2', BOB)),
    ];
    await runSteps(app, steps);
    steps.push(withdraw('c1'));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    expect((await poll(app))?.closed).toBe(true);
    steps.push(withdraw('c2'));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    const p = await poll(app);
    expect([p?.closed, p?.results, p?.totalVoters]).toEqual([false, undefined, undefined]);
  });

  it('withdrawing a non-creator close changes nothing (and no UI bump)', async () => {
    const app = make();
    const steps: Step[] = [append(open(app, 'o', BOB)), append(vote(app, 'v1', ALICE, ['A'])), append(close(app, 'c', MALLORY))];
    await runSteps(app, steps);
    expect((await poll(app))?.closed).toBe(false);
    const bumps = app.versions.polls;
    steps.push(withdraw('c'));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    expect(app.versions.polls).toBe(bumps);
  });

  it('a withdrawn open removes the poll and re-holds its votes and closes; re-appending the open restores everything', async () => {
    const app = make();
    const o = open(app, 'o', BOB);
    const steps: Step[] = [append(o), append(vote(app, 'v1', ALICE, ['A'])), append(close(app, 'c', BOB)), withdraw('o')];
    await runChecked(app, steps);
    expect(await poll(app)).toBeNull();
    expect(await votesOf(app)).toEqual([]);
    expect((await snapshotPollState(app.groupId) as { pendingVotes: unknown[]; pendingCloses: unknown[] })).toMatchObject({
      pendingVotes: [expect.objectContaining({ voterPubkey: ALICE })],
      pendingCloses: [expect.objectContaining({ closerPubkey: BOB })],
    });
    steps.push(append({ ...o, eventId: ev('o2')[0] }));
    await runSteps(app, steps.slice(-1));
    await expectPollOracle(app.groupId, steps);
    const p = await poll(app);
    expect([p?.closed, p?.totalVoters]).toEqual([true, 1]);
  });

  it('votes received before a held close stay counted, later ones do not — also after a recompute', async () => {
    const app = make();
    const steps: Step[] = [
      append(vote(app, 'before', MALLORY, ['A'])),
      append(close(app, 'c', BOB)),
      append(vote(app, 'after', ALICE, ['B'])),
      append(open(app, 'o', BOB)),
    ];
    await runSteps(app, steps);
    const closed = await poll(app);
    expect([closed?.closed, closed?.totalVoters, closed?.results?.map((r) => r.count)]).toEqual([true, 1, [1, 0]]);
    // an unrelated row of the poll is withdrawn: the recompute must reach the same result
    steps.push(append(vote(app, 'extra', SELF, ['B'])), withdraw('extra'));
    await runSteps(app, steps.slice(-2));
    await expectPollOracle(app.groupId, steps);
    const again = await poll(app);
    expect([again?.closed, again?.totalVoters, again?.results?.map((r) => r.count)]).toEqual([true, 1, [1, 0]]);
  });

  it("a withdrawn creator's open does not hand its held close to a poll another member re-opens", async () => {
    const app = make();
    const steps: Step[] = [
      append(open(app, 'o', BOB)),
      append(vote(app, 'v1', ALICE, ['A'])),
      append(close(app, 'c', BOB)),
      append(open(app, 'o2', MALLORY, { at: 1_700_000_100 })), // dropped at dispatch: first-open-wins
      withdraw('o'),
    ];
    await runChecked(app, steps);
    const p = await poll(app);
    // BOB's close must not close MALLORY's poll (creator binding)...
    expect([p?.creatorPubkey, p?.closed]).toEqual([MALLORY, false]);
    expect((await snapshotPollState(app.groupId) as { pendingCloses: unknown[] }).pendingCloses).toEqual([]);
  });
});

// ---- (5) duplicate carriers ---------------------------------------------------------------------------------------

describe('(5) a rumor carried by several events: the aggregate survives until its LAST carrier is withdrawn', () => {
  const carriers = (app: RealApp, kind: 'open' | 'vote' | 'close') => {
    const build = { open, vote: (a: RealApp, l: string, acc: string, o: EntryOpts) => vote(a, l, acc, ['A'], o), close }[kind];
    return [build(app, 'k1', kind === 'vote' ? ALICE : BOB, { rumorId: 'dup' }), build(app, 'k2', kind === 'vote' ? ALICE : BOB, { rumorId: 'dup' })];
  };

  for (const kind of ['open', 'vote', 'close'] as const) {
    for (const order of [['k1', 'k2'], ['k2', 'k1']]) {
      it(`${kind}: withdraw ${order.join(' then ')}`, async () => {
        const app = make();
        const [k1, k2] = carriers(app, kind);
        const base: Step[] = kind === 'open' ? [] : [append(open(app, 'o', BOB))];
        const steps: Step[] = [...base, append(k1), append(k2), withdraw(order[0])];
        await runChecked(app, steps);
        // one carrier left: the effect is still there
        if (kind === 'open') expect((await poll(app))?.creatorPubkey).toBe(BOB);
        if (kind === 'vote') expect(await votesOf(app)).toEqual([[ALICE, 'A', 'dup']]);
        if (kind === 'close') expect((await poll(app))?.closed).toBe(true);
        steps.push(withdraw(order[1]));
        await runSteps(app, steps.slice(-1));
        await expectPollOracle(app.groupId, steps);
        // none left: it is gone
        if (kind === 'open') expect(await poll(app)).toBeNull();
        if (kind === 'vote') expect(await votesOf(app)).toEqual([]);
        if (kind === 'close') expect((await poll(app))?.closed).toBe(false);
      });
    }
  }
});

// ---- (6) forged byte-identical copies -----------------------------------------------------------------------------

describe('(6) a forged byte-identical copy (same rumor id, other sender) is judged as its sender\'s own', () => {
  it('vote: withdrawing the forger\'s copy leaves the victim\'s vote; withdrawing the victim\'s leaves only the forger\'s own', async () => {
    for (const first of ['forged', 'victim'] as const) {
      const app = make();
      const victim = vote(app, 'victim', ALICE, ['A'], { rumorId: 'rv' });
      const forged = vote(app, 'forged', MALLORY, ['A'], { rumorId: 'rv', pubkey: ALICE });
      const steps: Step[] = [append(open(app, 'o', BOB)), append(victim), append(forged)];
      await runChecked(app, steps);
      expect((await votesOf(app)).map((r) => r[0]).sort()).toEqual([ALICE, MALLORY].sort());
      steps.push(withdraw(first));
      await runSteps(app, steps.slice(-1));
      await expectPollOracle(app.groupId, steps);
      expect((await votesOf(app)).map((r) => r[0])).toEqual([first === 'forged' ? ALICE : MALLORY]);
    }
  });

  it('close: the forger\'s copy never closes; withdrawing it leaves the creator\'s close; withdrawing the creator\'s reopens (the copy stays ignored)', async () => {
    for (const first of ['forged', 'victim'] as const) {
      const app = make();
      const victim = close(app, 'victim', BOB, { rumorId: 'rc' });
      const forged = close(app, 'forged', MALLORY, { rumorId: 'rc', pubkey: BOB });
      const steps: Step[] = [append(open(app, 'o', BOB)), append(vote(app, 'v', ALICE, ['A'])), append(forged), append(victim)];
      await runChecked(app, steps);
      expect((await poll(app))?.closed).toBe(true);
      steps.push(withdraw(first));
      await runSteps(app, steps.slice(-1));
      await expectPollOracle(app.groupId, steps);
      expect((await poll(app))?.closed).toBe(first === 'forged');
    }
  });

  it('open: first wins; withdrawing the forger\'s copy keeps the creator; withdrawing the creator\'s hands the poll to the copy\'s sender', async () => {
    for (const first of ['forged', 'victim'] as const) {
      const app = make();
      const victim = open(app, 'victim', BOB, { rumorId: 'ro' });
      const forged = open(app, 'forged', MALLORY, { rumorId: 'ro', pubkey: BOB });
      const steps: Step[] = [append(victim), append(forged), append(vote(app, 'v', ALICE, ['A']))];
      await runChecked(app, steps);
      expect((await poll(app))?.creatorPubkey).toBe(BOB);
      steps.push(withdraw(first));
      await runSteps(app, steps.slice(-1));
      await expectPollOracle(app.groupId, steps);
      expect((await poll(app))?.creatorPubkey).toBe(first === 'forged' ? BOB : MALLORY);
      expect(await votesOf(app)).toEqual([[ALICE, 'A', 'rumor-v']]);
    }
  });
});

// ---- (14) idempotence -----------------------------------------------------------------------------------------------

describe('(14) retract twice / unseen id changes nothing', () => {
  it('a repeated withdraw, an unseen event id and an unrelated chat row leave the poll stores and the UI version alone', async () => {
    const app = make();
    const steps: Step[] = [append(open(app, 'o', BOB)), append(vote(app, 'v1', ALICE, ['A'])), append(vote(app, 'v2', ALICE, ['B'], { seq: 2 })), withdraw('v2')];
    await runSteps(app, steps);
    const bumps = app.versions.polls;
    const snap = await pollSnapshot(app.groupId);
    await app.sink.withdraw(app.groupId, ev('v2')); // again
    await app.sink.withdraw(app.groupId, ev('never-seen'));
    await app.sink.append(app.entry({ eventId: 'chat', account: BOB, content: 'hi' }));
    await app.sink.withdraw(app.groupId, ev('chat'));
    expect(await pollSnapshot(app.groupId)).toEqual(snap);
    expect(app.versions.polls).toBe(bumps);
    await expectPollOracle(app.groupId, steps);
  });
});

// ---- (13) effects --------------------------------------------------------------------------------------------------

describe('(13) a recompute has no effects, and a purged retract folds nothing', () => {
  it('withdrawing a close / a vote / an open sends, announces, enqueues and bumps nothing but the poll version', async () => {
    const app = make();
    await initUnreadCounts([app.groupId], SELF);
    await runSteps(app, [append(open(app, 'o', BOB)), append(vote(app, 'v', ALICE, ['A'])), append(close(app, 'c', BOB))]);
    const unread = unreadOf(app.groupId);
    const messages = await app.messages();
    const before = { chat: app.versions.chat, reactions: app.versions.reactions, profile: app.versions.profile, jobs: app.jobs.length, calls: [...app.calls] };
    for (const label of ['c', 'v', 'o']) await app.sink.withdraw(app.groupId, ev(label));
    expect(app.versions.polls).toBeGreaterThan(0);
    expect({ chat: app.versions.chat, reactions: app.versions.reactions, profile: app.versions.profile, jobs: app.jobs.length, calls: app.calls }).toEqual(before);
    expect(unreadOf(app.groupId)).toBe(unread);
    expect(await app.messages()).toEqual(messages);
    for (const spy of Object.values(app.spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('the held close-announcement queue is not part of the poll aggregate and is left as it is', async () => {
    const app = make();
    // held AFTER the open (the open's own settle would replay it), then the open is withdrawn
    await runSteps(app, [append(open(app, 'o', BOB))]);
    await store.queuePendingCloseAnnouncement({ groupId: app.groupId, pollId: POLL, senderPubkey: BOB, rumorId: 'ann', createdAt: 1 });
    await runSteps(app, [withdraw('o')]);
    expect(await store.loadPendingCloseAnnouncements(app.groupId, POLL)).toHaveLength(1);
  });

  it('reason purged removes outright: no remaining() read, no recompute, no UI bump', async () => {
    const versions = { poll: 0 };
    const recomputePoll = vi.fn(async () => true);
    const deps = { ...(await baseDeps(versions)), recomputePoll };
    const handlers = [createPollOpenGroupHandler(deps), createPollVoteGroupHandler(deps), createPollCloseGroupHandler(deps)];
    const g = 'ab'.repeat(32);
    const remaining = vi.fn(async () => {
      throw new Error('a purged retract must not read the history');
    });
    for (const [h, kind, content] of [[handlers[0], POLL_OPEN_KIND, openC()], [handlers[1], POLL_VOTE_KIND, voteC(['A'])], [handlers[2], POLL_CLOSE_KIND, closeC()]] as const) {
      await h.retract(
        { groupId: g, eventId: 'x', sender: BOB, reason: 'purged', remaining, rumor: { id: 'r', pubkey: BOB, created_at: 1, kind, tags: [], content } },
        { selfPubkeyHex: SELF, getActiveGroupId: () => null },
      );
    }
    expect(remaining).not.toHaveBeenCalled();
    expect(recomputePoll).not.toHaveBeenCalled();
    expect(versions.poll).toBe(0);
  });
});

// ---- (10) batch ----------------------------------------------------------------------------------------------------

describe('(10) a batch withdraw of rows of one poll', () => {
  it('no intermediate state: every recompute sees neither withdrawn row, and the UI is bumped once', async () => {
    const versions = { poll: 0 };
    const recompute = vi.fn(store.recomputePoll);
    const { sink, groupId } = await sinkWith(versions, { recomputePoll: recompute });
    const g = groupId;
    const e = (label: string, kind: number, account: string, content: string) => rowEntry(g, label, kind, account, content);
    await sink.append(e('o', POLL_OPEN_KIND, BOB, openC()));
    await sink.append(e('v1', POLL_VOTE_KIND, ALICE, voteC(['A'], 1)));
    await sink.append(e('v2', POLL_VOTE_KIND, MALLORY, voteC(['B'], 1)));
    await sink.append(e('v3', POLL_VOTE_KIND, SELF, voteC(['A'], 1)));
    const bumped = versions.poll;
    await sink.withdraw(g, ev('v1', 'v2'));
    expect(recompute.mock.calls.length).toBe(1); // ONE recompute for the poll serves both withdrawn rows
    for (const [, , signals] of recompute.mock.calls) {
      expect(signals.map((s) => s.rumor.id).sort()).toEqual(['rumor-o', 'rumor-v3']); // neither v1 nor v2, ever
    }
    expect(versions.poll).toBe(bumped + 1);
    expect((await store.loadVotes(g, POLL)).map((v) => v.voterPubkey)).toEqual([SELF]);
  });
});

// ---- (11) failures -------------------------------------------------------------------------------------------------

describe('(11) a failed recompute is retried and the retry converges on the oracle', () => {
  it('the withdraw rejects, the old state stays whole, the retried withdraw rebuilds it; a later unrelated recompute changes nothing', async () => {
    const versions = { poll: 0 };
    let failures = 1;
    const { sink, groupId } = await sinkWith(versions, {
      recomputePoll: async (g, p, s) => {
        if (failures-- > 0) throw new Error('storage down');
        return store.recomputePoll(g, p, s);
      },
    });
    const e = (label: string, kind: number, account: string, content: string) => rowEntry(groupId, label, kind, account, content);
    const steps: Step[] = [append(e('o', POLL_OPEN_KIND, BOB, openC())), append(e('v1', POLL_VOTE_KIND, ALICE, voteC(['A'], 1))), append(e('v2', POLL_VOTE_KIND, ALICE, voteC(['B'], 2)))];
    for (const s of steps) if (s.op === 'append') await sink.append(s.entry);
    await expect(sink.withdraw(groupId, ev('v2'))).rejects.toThrow('storage down');
    expect((await store.loadVotes(groupId, POLL))[0].rumorId).toBe('rumor-v2'); // nothing half-undone
    await sink.withdraw(groupId, ev('v2')); // the retry
    steps.push(withdraw('v2'));
    await expectPollOracle(groupId, steps);
    const snap = await pollSnapshot(groupId);
    await store.recomputePoll(groupId, OTHER, []); // a later recompute of an unrelated poll id
    expect(await pollSnapshot(groupId)).toEqual(snap);
  });
});

// ---- (15) clock -----------------------------------------------------------------------------------------------------

describe('(15) the fold does not depend on the wall clock at recompute', () => {
  it('held votes / closes withdrawn-and-restored 40 days later keep their order and are not expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = make();
    const steps: Step[] = [
      append(vote(app, 'before', MALLORY, ['A'])),
      append(close(app, 'c', BOB)),
      append(vote(app, 'after', ALICE, ['B'])),
      append(open(app, 'o', BOB)),
    ];
    await runSteps(app, steps);
    vi.setSystemTime(new Date('2026-02-10T00:00:00Z'));
    steps.push(append(vote(app, 'extra', SELF, ['B'])), withdraw('extra'));
    await runSteps(app, steps.slice(-2));
    const p = await poll(app);
    expect([p?.closed, p?.totalVoters, p?.results?.map((r) => r.count)]).toEqual([true, 1, [1, 0]]);
    // and the open withdrawn at the later time re-holds the votes/close instead of dropping them as expired
    steps.push(withdraw('o'));
    await runSteps(app, steps.slice(-1));
    const state = (await snapshotPollState(app.groupId)) as { pendingVotes: unknown[]; pendingCloses: unknown[] };
    expect([state.pendingVotes.length, state.pendingCloses.length]).toEqual([2, 1]);
    await expectPollOracle(app.groupId, steps);
  });
});

// ---- (12) late retract ------------------------------------------------------------------------------------------------

describe('(12) a late retract (the dispatch outlived the settle bound) recomputes correctly', () => {
  it('open withdrawn while its dispatch hangs: when it finishes, the late retract rebuilds from the remaining rows', async () => {
    const versions = { poll: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => void (release = resolve));
    let hang = false;
    const recompute = vi.fn(store.recomputePoll);
    const { sink, groupId } = await sinkWith(
      versions,
      {
        recomputePoll: recompute,
        savePoll: async (p) => {
          if (hang) await gate;
          return store.savePoll(p);
        },
      },
      { settleTimeoutMs: 40 },
    );
    const entry = (label: string, kind: number, account: string, content: string) => rowEntry(groupId, label, kind, account, content);
    const held = entry('v1', POLL_VOTE_KIND, ALICE, voteC(['A'], 1));
    const o = entry('o', POLL_OPEN_KIND, BOB, openC());
    await sink.append(held); // no poll yet: held
    hang = true;
    const appended = sink.append(o).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5)); // the open's dispatch is running and hung
    await sink.withdraw(groupId, ev('o')); // waits one settle bound, returns; the retract is deferred to the end of the dispatch
    release();
    await appended;
    // the released dispatch stores the poll (and applies the held vote) THEN the late retract rebuilds without the open
    await vi.waitFor(() => expect(recompute).toHaveBeenCalled(), { timeout: 2000 });
    expect(recompute.mock.calls[0][2].map((s) => s.rumor.id)).toEqual(['rumor-v1']); // the remaining rows only
    await expectPollOracle(groupId, [append(held)]);
    expect((await snapshotPollState(groupId) as { pendingVotes: unknown[] }).pendingVotes).toHaveLength(1);
  });
});

// ---- (1) property --------------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG so a failing program replays from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('(1) property: any appends then any withdraws equal dispatching only the survivors', () => {
  const senders = [BOB, ALICE, MALLORY, SELF];
  const PROGRAMS = Number(process.env.POLL_PROPERTY_PROGRAMS ?? 40); // raise to soak

  it.each(Array.from({ length: PROGRAMS }, (_, i) => i + 1))('program %i', async (seed) => {
    const rnd = prng(seed * 7919);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const app = make();
    const steps: Step[] = [];
    const labels: string[] = [];
    // a pool of rumor ids shared across senders/carriers so forged copies and duplicate carriers occur
    const rumorIds = ['rA', 'rB', 'rC', 'rD', 'rE', 'rF'];
    const appends = 6 + Math.floor(rnd() * 10);
    for (let i = 0; i < appends; i++) {
      const label = `e${i}`;
      const account = pick(senders);
      const pollId = rnd() < 0.8 ? POLL : OTHER;
      const rumorId = rnd() < 0.45 ? pick(rumorIds) : undefined;
      const at = 1_700_000_000 + Math.floor(rnd() * 4);
      const roll = rnd();
      const e =
        roll < 0.2
          ? open(app, label, account, { id: pollId, rumorId, at })
          : roll < 0.75
            ? vote(app, label, account, [pick([['A'], ['B'], ['A', 'B'], ['Z']])].flat(), { seq: Math.floor(rnd() * 4), pollId, rumorId, at })
            : close(app, label, account, { pollId, rumorId, at });
      labels.push(label);
      steps.push(append(e));
      if (rnd() < 0.15) steps.push(append({ ...e, eventId: ev(`${label}-dup`)[0] })); // another carrier of the same rumor
    }
    const survivorsLeft = steps.flatMap((s) => (s.op === 'append' ? [s.entry.eventId] : []));
    const toWithdraw = survivorsLeft.filter(() => rnd() < 0.5).sort(() => rnd() - 0.5);
    const decode = (hex: string) => Buffer.from(hex, 'hex').toString();
    for (let i = 0; i < toWithdraw.length; ) {
      const size = rnd() < 0.3 ? Math.min(2 + Math.floor(rnd() * 2), toWithdraw.length - i) : 1;
      steps.push(withdraw(...toWithdraw.slice(i, i + size).map(decode)));
      i += size;
    }
    await runSteps(app, steps);
    await expectPollOracle(app.groupId, steps, `seed ${seed}`);
  });
});

// ---- helpers for the custom-wired sinks ----------------------------------------------------------------------------------

type Overrides = Partial<PollGroupHandlerDeps>;
let sinkCounter = 0;

/** The IDB-backed poll deps with the version counter. */
async function baseDeps(versions: { poll: number }): Promise<PollGroupHandlerDeps> {
  return {
    savePoll: store.savePoll,
    saveVoteIfNewer: store.saveVoteIfNewer,
    getPoll: store.getPoll,
    loadVotes: store.loadVotes,
    queuePendingVote: store.queuePendingVote,
    loadPendingVotes: store.loadPendingVotes,
    removePendingVotes: store.removePendingVotes,
    queuePendingClose: store.queuePendingClose,
    loadPendingCloses: store.loadPendingCloses,
    removePendingCloses: store.removePendingCloses,
    setPollVersion: (u) => void (versions.poll = u(versions.poll)),
    recomputePoll: store.recomputePoll,
    receiptNow: store.receiptNow,
    replayHeldCloseAnnouncements: async () => undefined,
  };
}

/** A real HistoryBackend over just the three poll group handlers, with port overrides. */
async function sinkWith(versions: { poll: number }, overrides: Overrides = {}, options: { settleTimeoutMs?: number } = {}) {
  const groupId = nextGroup();
  const deps = { ...(await baseDeps(versions)), ...overrides };
  const handlers: GroupKindHandler[] = [createPollOpenGroupHandler(deps), createPollVoteGroupHandler(deps), createPollCloseGroupHandler(deps)];
  const dispatcher = createGroupRumorDispatch({ handlers, env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } });
  const sink = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`s5poll-${groupId}-${++sinkCounter}`), ...options });
  extraSinks.push(sink);
  return { sink, groupId };
}

/** A history entry for the custom sinks (the app's helper needs a RealApp). */
function rowEntry(groupId: string, label: string, kind: number, account: string, content: string): HistoryEntry {
  return {
    groupId,
    eventId: ev(label)[0],
    rumor: { id: `rumor-${label}`, pubkey: account, created_at: 1_700_000_000, kind, tags: [], content },
    orderingKey: { account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}
