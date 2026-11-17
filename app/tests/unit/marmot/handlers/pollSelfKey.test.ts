// @vitest-environment node
/**
 * The poll recompute runs with the local account's key, like a live dispatch.
 *
 *  - the sink handler hands `env.selfPubkeyHex` to the recompute port (the fold builds its dispatch context from it,
 *    not from an empty key)
 *  - an own-authored vote / own-created poll recomputes exactly as the live dispatch of the remaining rows would
 *    (oracle), incl. after the withdrawal of another member's row of the same poll
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollVoteGroupHandler, type PollGroupHandlerDeps } from '@/src/lib/marmot/handlers/pollHandler';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import { ALICE, BOB, buildRealApp, installLocalStorage, SELF, type RealApp } from './realApp';
import { append, expectOracle, runSteps, withdraw, type Step } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(() => {
  installLocalStorage();
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.sink.dispose();
});

const POLL = 'poll-1';
const openC = (creator: string) => JSON.stringify({ id: POLL, title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: creator });
const voteC = (r: string, seq = 1) => JSON.stringify({ pollId: POLL, responses: [r], seq });
const closeC = () => JSON.stringify({ pollId: POLL, results: [], totalVoters: 0 });

describe('recomputePoll receives the local account key', () => {
  it('the retract hands env.selfPubkeyHex to the port', async () => {
    const recomputePoll = vi.fn(async () => false);
    const deps = {
      savePoll: vi.fn(), saveVoteIfNewer: vi.fn(), getPoll: vi.fn(), loadVotes: vi.fn(), queuePendingVote: vi.fn(),
      loadPendingVotes: vi.fn(), removePendingVotes: vi.fn(), queuePendingClose: vi.fn(), loadPendingCloses: vi.fn(),
      removePendingCloses: vi.fn(), setPollVersion: vi.fn(), recomputePoll, receiptNow: vi.fn(),
      replayHeldCloseAnnouncements: vi.fn(),
    } as unknown as PollGroupHandlerDeps;
    const handler = createPollVoteGroupHandler(deps);
    await handler.retract(
      {
        groupId: 'g',
        eventId: 'e1',
        sender: SELF,
        rumor: { id: 'r1', pubkey: SELF, created_at: 1, kind: POLL_VOTE_KIND, tags: [], content: voteC('A') },
        remaining: async () => [],
      },
      { selfPubkeyHex: SELF, getActiveGroupId: () => null },
    );
    expect(recomputePoll).toHaveBeenCalledWith('g', POLL, [], SELF);
  });
});

describe('own-authored poll rows recompute like a live dispatch (oracle)', () => {
  it('an own vote survives the withdrawal of another member\'s vote with the state of a fresh dispatch', async () => {
    const app = make();
    const steps: Step[] = [
      append(app.entry({ eventId: 'po', kind: POLL_OPEN_KIND, account: BOB, rumorId: 'p-open', content: openC(BOB) })),
      append(app.entry({ eventId: 'v1', kind: POLL_VOTE_KIND, account: SELF, rumorId: 'pv1', content: voteC('A') })),
      append(app.entry({ eventId: 'v2', kind: POLL_VOTE_KIND, account: ALICE, rumorId: 'pv2', content: voteC('B') })),
      withdraw('v2'),
    ];
    await runSteps(app, steps);
    expect((await app.votes(POLL)).map((v) => v.voterPubkey)).toEqual([SELF]);
    await expectOracle(app, steps, make);
  });

  it('an own-created and own-closed poll recomputes to the same closed tally after another vote is withdrawn', async () => {
    const app = make();
    const steps: Step[] = [
      append(app.entry({ eventId: 'po', kind: POLL_OPEN_KIND, account: SELF, rumorId: 'p-open', content: openC(SELF) })),
      append(app.entry({ eventId: 'v1', kind: POLL_VOTE_KIND, account: BOB, rumorId: 'pv1', content: voteC('A') })),
      append(app.entry({ eventId: 'v2', kind: POLL_VOTE_KIND, account: ALICE, rumorId: 'pv2', content: voteC('B') })),
      append(app.entry({ eventId: 'pc', kind: POLL_CLOSE_KIND, account: SELF, rumorId: 'p-close', content: closeC() })),
      withdraw('v2'),
    ];
    await runSteps(app, steps);
    const [poll] = await app.polls();
    expect(poll).toMatchObject({ closed: true, totalVoters: 1 });
    await expectOracle(app, steps, make);
  });
});
