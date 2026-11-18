// @vitest-environment node
/**
 * S5: the poll handlers (kinds 10 / 11 / 12) on the history-sink path.
 *
 *  AC-HIST-9   each poll kind reaches its store through a sink append, attributed to the sink's
 *              authenticated sender (never the rumor's own pubkey / the payload's creatorPubkey).
 *  AC-WDR-1    withdrawing another member's open / vote / close removes the poll / the vote / re-opens.
 *  AC-WDR-2    own withdrawn vote and own dropped open; nothing is resent.
 *
 * Real collaborators: the app HistoryBackend (idb store) and pollPersistence over fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import {
  createPollCloseGroupHandler,
  createPollOpenGroupHandler,
  createPollVoteGroupHandler,
  type PollGroupHandlerDeps,
} from '@/src/lib/marmot/handlers/pollHandler';
import * as store from '@/src/lib/marmot/pollPersistence';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';

const SELF = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const MALLORY = 'cc'.repeat(32);
const ALICE = 'dd'.repeat(32);
const POLL = 'poll-1';
let G: string;
let counter = 0;

const openContent = (id = POLL, creatorPubkey = ALICE) =>
  JSON.stringify({
    id,
    title: 'Lunch?',
    options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }],
    pollType: 'singlechoice',
    creatorPubkey,
  });
const voteContent = (responses: string[], seq?: number, pollId = POLL) => JSON.stringify({ pollId, responses, ...(seq ? { seq } : {}) });
const closeContent = (pollId = POLL) => JSON.stringify({ pollId, results: [], totalVoters: 0 });

function entry(o: { eventId: string; kind: number; account: string; content: string; pubkey?: string; rumorId?: string; at?: number }): HistoryEntry {
  return {
    groupId: G,
    eventId: o.eventId,
    rumor: {
      id: o.rumorId ?? `rumor-${o.eventId}`,
      pubkey: o.pubkey ?? o.account,
      created_at: o.at ?? 1_700_000_000,
      kind: o.kind,
      tags: [],
      content: o.content,
    },
    orderingKey: { account: o.account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}

function build() {
  const versions = { poll: 0 };
  const deps: PollGroupHandlerDeps = {
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
  const handlers: GroupKindHandler[] = [createPollOpenGroupHandler(deps), createPollVoteGroupHandler(deps), createPollCloseGroupHandler(deps)];
  const dispatcher = createGroupRumorDispatch({ handlers, env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } });
  const sink = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`s5poll-${G}`) });
  sinks.push(sink);
  return { sink, deps, versions, handlers };
}

let sinks: AppHistoryBackend[] = [];
beforeEach(() => {
  G = `${(++counter).toString(16).padStart(2, '0')}`.repeat(32).slice(0, 64);
  sinks = [];
});
afterEach(async () => {
  for (const s of sinks) await s.dispose();
});

const poll = async () => store.getPoll(G, POLL);
const votes = async () => (await store.loadVotes(G, POLL)).map((v) => [v.voterPubkey, v.responses.join(','), v.rumorId]);

describe('AC-HIST-9: poll kinds reach their stores through the sink, attributed to the sender', () => {
  it('open, vote and close each land; creator and voter are the sink sender, not the rumor/payload pubkey', async () => {
    const app = build();
    // The rumor claims ALICE, the payload claims ALICE; the authenticated sender is BOB.
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, pubkey: ALICE, content: openContent(POLL, ALICE) }));
    expect((await poll())?.creatorPubkey).toBe(BOB);
    expect(app.versions.poll).toBe(1);

    await app.sink.append(entry({ eventId: 'e2', kind: POLL_VOTE_KIND, account: MALLORY, pubkey: ALICE, content: voteContent(['A']) }));
    expect(await votes()).toEqual([[MALLORY, 'A', 'rumor-e2']]);

    await app.sink.append(entry({ eventId: 'e3', kind: POLL_CLOSE_KIND, account: MALLORY, pubkey: BOB, content: closeContent() }));
    expect((await poll())?.closed).toBe(false); // a non-creator close is ignored
    await app.sink.append(entry({ eventId: 'e4', kind: POLL_CLOSE_KIND, account: BOB, content: closeContent() }));
    const closed = await poll();
    expect(closed?.closed).toBe(true);
    expect(closed?.totalVoters).toBe(1);
  });
});

describe("AC-WDR-1: withdrawing another member's poll rumors undoes their stored effect", () => {
  it('a withdrawn open removes the poll and bumps the poll version', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    expect(await poll()).not.toBeNull();
    const before = app.versions.poll;
    await app.sink.withdraw(G, ['e1']);
    expect(await poll()).toBeNull();
    expect(app.versions.poll).toBe(before + 1);
  });

  it('a withdrawn vote removes that voter\'s vote only', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_VOTE_KIND, account: MALLORY, content: voteContent(['A']) }));
    await app.sink.append(entry({ eventId: 'e3', kind: POLL_VOTE_KIND, account: ALICE, content: voteContent(['B']) }));
    const before = app.versions.poll;
    await app.sink.withdraw(G, ['e2']);
    expect(await votes()).toEqual([[ALICE, 'B', 'rumor-e3']]);
    expect(app.versions.poll).toBe(before + 1);
  });

  it('a withdrawn close re-opens the poll and clears its frozen tally', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_VOTE_KIND, account: ALICE, content: voteContent(['A']) }));
    await app.sink.append(entry({ eventId: 'e3', kind: POLL_CLOSE_KIND, account: BOB, content: closeContent() }));
    expect((await poll())?.closed).toBe(true);
    const before = app.versions.poll;
    await app.sink.withdraw(G, ['e3']);
    const reopened = await poll();
    expect(reopened?.closed).toBe(false);
    expect(reopened?.results).toBeUndefined();
    expect(reopened?.totalVoters).toBeUndefined();
    expect(app.versions.poll).toBe(before + 1);
  });

  it('a withdrawn newer vote promotes the voter\'s previous vote', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_VOTE_KIND, account: ALICE, content: voteContent(['A'], 1) }));
    await app.sink.append(entry({ eventId: 'e3', kind: POLL_VOTE_KIND, account: ALICE, content: voteContent(['B'], 2) }));
    expect(await votes()).toEqual([[ALICE, 'B', 'rumor-e3']]);
    await app.sink.withdraw(G, ['e3']);
    expect(await votes()).toEqual([[ALICE, 'A', 'rumor-e2']]);
  });

  it('a withdrawn duplicate open by another member leaves the real poll', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_OPEN_KIND, account: MALLORY, content: openContent(), at: 1_700_000_050 }));
    expect((await poll())?.creatorPubkey).toBe(BOB); // first-open-wins
    await app.sink.withdraw(G, ['e2']);
    expect((await poll())?.creatorPubkey).toBe(BOB);
  });

  it('a withdrawn early vote / early close is dropped from the hold queues', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_VOTE_KIND, account: MALLORY, content: voteContent(['A']) }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_CLOSE_KIND, account: BOB, content: closeContent() }));
    await app.sink.append(entry({ eventId: 'e3', kind: POLL_CLOSE_KIND, account: MALLORY, content: closeContent() }));
    expect(await store.loadPendingVotes(G, POLL)).toHaveLength(1);
    expect(await store.loadPendingCloses(G, POLL)).toHaveLength(2);
    await app.sink.withdraw(G, ['e1', 'e2']);
    expect(await store.loadPendingVotes(G, POLL)).toHaveLength(0);
    expect((await store.loadPendingCloses(G, POLL)).map((c) => c.closerPubkey)).toEqual([MALLORY]);
    // the surviving held entries do not leak into a later open
    await app.sink.append(entry({ eventId: 'e4', kind: POLL_OPEN_KIND, account: BOB, content: openContent() }));
    expect(await votes()).toEqual([]);
    expect((await poll())?.closed).toBe(false);
  });
});

describe('AC-WDR-2: own withdrawn poll rumors', () => {
  it('an own vote is removed and an own open dropped, without any outbound call', async () => {
    const app = build();
    await app.sink.append(entry({ eventId: 'e1', kind: POLL_OPEN_KIND, account: SELF, content: openContent() }));
    await app.sink.append(entry({ eventId: 'e2', kind: POLL_VOTE_KIND, account: SELF, content: voteContent(['A']) }));
    expect(await votes()).toEqual([[SELF, 'A', 'rumor-e2']]);
    await app.sink.withdraw(G, ['e2']);
    expect(await votes()).toEqual([]);
    await app.sink.withdraw(G, ['e1']);
    expect(await poll()).toBeNull();
  });
});

describe('retract edge cases', () => {
  type In = { eventId: string; sender: string; rumor: { kind: number; content: string } };
  const input = (kind: number, content: string, account = BOB, eventId = 'ex', remaining: In[] = []) => {
    const e = entry({ eventId, kind, account, content });
    return {
      groupId: G,
      eventId,
      rumor: e.rumor,
      sender: account,
      // what the sink hands a retract: the group's surviving rows in seq order
      remaining: async () => remaining.map((r, i) => ({ entry: entry({ eventId: r.eventId, kind: r.rumor.kind, account: r.sender, content: r.rumor.content }), seq: i + 1, receivedAt: 1000 + i })),
    };
  };
  const env = { selfPubkeyHex: SELF, getActiveGroupId: () => null };

  it('retract of an unknown target or an unparsable rumor is a no-op with no UI bump', async () => {
    const app = build();
    for (const [h, kind, content] of [
      [app.handlers[0], POLL_OPEN_KIND, openContent('nope')],
      [app.handlers[1], POLL_VOTE_KIND, voteContent(['A'], 1, 'nope')],
      [app.handlers[2], POLL_CLOSE_KIND, closeContent('nope')],
      [app.handlers[0], POLL_OPEN_KIND, 'not json'],
      [app.handlers[1], POLL_VOTE_KIND, 'not json'],
      [app.handlers[2], POLL_CLOSE_KIND, 'not json'],
    ] as const) {
      await expect(h.retract(input(kind, content), env)).resolves.toBeUndefined();
    }
    expect(app.versions.poll).toBe(0);
  });

  it('dispatch and retract are idempotent', async () => {
    const app = build();
    const [open, vote, close] = app.handlers;
    const o = input(POLL_OPEN_KIND, openContent(), BOB, 'e1');
    const v = input(POLL_VOTE_KIND, voteContent(['A']), ALICE, 'e2');
    const c = input(POLL_CLOSE_KIND, closeContent(), BOB, 'e3', [o, v]);
    for (const [h, i] of [[open, o], [vote, v], [close, c]] as const) {
      await h.dispatch(i, env);
      await h.dispatch(i, env);
    }
    expect(await votes()).toEqual([[ALICE, 'A', 'rumor-e2']]);
    expect((await poll())?.closed).toBe(true);
    await close.retract(c, env); // remaining: open + vote -> the poll is open again
    expect((await poll())?.closed).toBe(false);
    const bumped = app.versions.poll;
    await close.retract(c, env);
    expect(app.versions.poll).toBe(bumped); // second retract changes nothing
    await vote.retract(input(POLL_VOTE_KIND, voteContent(['A']), ALICE, 'e2', [o]), env);
    await vote.retract(input(POLL_VOTE_KIND, voteContent(['A']), ALICE, 'e2', [o]), env);
    expect(await votes()).toEqual([]);
    await open.retract(input(POLL_OPEN_KIND, openContent(), BOB, 'e1', []), env);
    await open.retract(input(POLL_OPEN_KIND, openContent(), BOB, 'e1', []), env);
    expect(await poll()).toBeNull();
  });
});

describe('construction', () => {
  const factories = {
    createPollOpenGroupHandler,
    createPollVoteGroupHandler,
    createPollCloseGroupHandler,
  };
  it('group factories expose their sink kinds without a legacy handle', () => {
    const { handlers } = build();
    expect(handlers.map((handler) => handler.kind)).toEqual([POLL_OPEN_KIND, POLL_VOTE_KIND, POLL_CLOSE_KIND]);
    for (const handler of handlers) expect(handler).not.toHaveProperty('handle');
  });
  const ports = [
    'savePoll', 'saveVoteIfNewer', 'getPoll', 'loadVotes', 'queuePendingVote', 'loadPendingVotes', 'removePendingVotes',
    'queuePendingClose', 'loadPendingCloses', 'removePendingCloses', 'setPollVersion', 'recomputePoll', 'receiptNow',
    'replayHeldCloseAnnouncements',
  ] as const;

  it.each(Object.entries(factories))('%s throws a TypeError naming any missing port', (name, factory) => {
    G = 'ff'.repeat(32);
    const { deps } = build();
    expect(() => factory(deps)).not.toThrow();
    for (const port of ports) {
      const broken = { ...deps, [port]: undefined } as unknown as PollGroupHandlerDeps;
      expect(() => factory(broken), `${name}/${port}`).toThrow(new RegExp(`TypeError|${port}`));
      try {
        factory(broken);
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
        expect((e as Error).message).toContain(`"${port}"`);
      }
    }
  });

  it('the held close-announcement replay is required on the sink path only: the legacy factory still constructs without it', () => {
    G = 'ee'.repeat(32);
    const { deps } = build();
    const { replayHeldCloseAnnouncements: _unused, ...legacyDeps } = deps;
    expect(() => createPollOpenGroupHandler(legacyDeps as unknown as PollGroupHandlerDeps)).toThrow(
      new TypeError('createPollOpenGroupHandler: required port "replayHeldCloseAnnouncements" is missing or not a function'),
    );
  });
});
