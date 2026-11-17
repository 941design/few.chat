// @vitest-environment node
/**
 * A withdraw batch recomputes each AGGREGATE once (AC-WDR-7, AC-HIST-5).
 *
 * The sink retracts a batch row by row, but a recompute reads the batch's single `remaining()` snapshot, which
 * already omits every withdrawn row: the second and later rows naming the same aggregate (one message's reactions,
 * one delete/edit slot, one poll) would redo the first one's work. The dispatch layer therefore runs ONE retract per
 * (family, aggregate key) per batch, and the handler drops the state of EVERY withdrawn row of the aggregate (all the
 * pinned revs, not only the first row's).
 *
 *  - dispatch layer, with fixture handlers: once per key and batch, per-row for keyless retracts, a failure is not
 *    memoised, the next batch starts fresh
 *  - real stores / sink / handlers (realApp): 30 reactions on one message, a stack of edits with pinned revs, the
 *    votes of one poll: one recompute each, and the stores still equal the oracle
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as reactions from '@/src/lib/reactions/api';
import * as edits from '@/src/lib/messageEdits/api';
import * as polls from '@/src/lib/marmot/pollPersistence';
import { createGroupRumorDispatch, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import type { RetractInput } from '@/src/lib/marmot/history';
import { POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import { ALICE, BOB, buildRealApp, installLocalStorage, type RealApp } from './realApp';
import { append, expectOracle, runSteps, withdraw, type Step } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

// ---- dispatch layer ------------------------------------------------------------------------------------------------

const G = 'a1'.repeat(32);
const input = (eventId: string, remaining: RetractInput['remaining'], kind = 7): RetractInput => ({
  groupId: G,
  eventId,
  sender: ALICE,
  rumor: { id: `r-${eventId}`, pubkey: ALICE, created_at: 1, kind, tags: [['e', 'm1']], content: '+' },
  remaining,
});

function dispatcherOf(retractKey: GroupKindHandler['retractKey'], retract = vi.fn(async (_input: RetractInput): Promise<void> => undefined), kind = 7) {
  const handler: GroupKindHandler = { kind, dispatch: vi.fn(async () => undefined), retract, retractKey };
  return { retract, dispatch: createGroupRumorDispatch({ handlers: [handler], env: { selfPubkeyHex: ALICE, getActiveGroupId: () => null } }) };
}

describe('dispatch layer: one retract per aggregate key and batch', () => {
  it('runs the retract once for rows of one key sharing a batch, and once per distinct key', async () => {
    const { retract, dispatch } = dispatcherOf((i) => `reactions:${i.rumor.tags[0][1]}`);
    const batch = async () => [];
    await dispatch.retract(input('e1', batch));
    await dispatch.retract(input('e2', batch));
    await dispatch.retract({ ...input('e3', batch), rumor: { ...input('e3', batch).rumor, tags: [['e', 'm2']] } });
    expect(retract).toHaveBeenCalledTimes(2);
    expect(retract.mock.calls.map(([i]) => i.eventId)).toEqual(['e1', 'e3']);
  });

  it('a new batch (another remaining()) recomputes the same key again', async () => {
    const { retract, dispatch } = dispatcherOf(() => 'k');
    await dispatch.retract(input('e1', async () => []));
    await dispatch.retract(input('e2', async () => []));
    expect(retract).toHaveBeenCalledTimes(2);
  });

  it('retracts per row when the handler reports no key', async () => {
    const { retract, dispatch } = dispatcherOf(() => undefined);
    const batch = async () => [];
    await dispatch.retract(input('e1', batch));
    await dispatch.retract(input('e2', batch));
    expect(retract).toHaveBeenCalledTimes(2);
    const plain = dispatcherOf(undefined);
    await plain.dispatch.retract(input('e1', batch));
    await plain.dispatch.retract(input('e2', batch));
    expect(plain.retract).toHaveBeenCalledTimes(2);
  });

  it('does not memoise a failure: the same batch retries the key, and a joined row sees the failure of the shared run', async () => {
    let fail = true;
    const retract = vi.fn(async (_input: RetractInput): Promise<void> => {
      if (fail) throw new Error('boom');
    });
    const { dispatch } = dispatcherOf(() => 'k', retract);
    const batch = async () => [];
    await expect(dispatch.retract(input('e1', batch))).rejects.toThrow('boom');
    fail = false;
    await dispatch.retract(input('e1', batch));
    expect(retract).toHaveBeenCalledTimes(2);
  });

  it('kinds of one family share a key (a kind-5 and an edit-marked kind-9 naming one slot recompute once)', async () => {
    const slot = vi.fn(async (_input: RetractInput): Promise<void> => undefined);
    const key = () => 'slot:["m1"]';
    const a: GroupKindHandler = { kind: 5, dispatch: vi.fn(async () => undefined), retract: slot, retractKey: key };
    const b: GroupKindHandler = { kind: 9, dispatch: vi.fn(async () => undefined), retract: slot, retractKey: key };
    const dispatch = createGroupRumorDispatch({ handlers: [a, b], env: { selfPubkeyHex: ALICE, getActiveGroupId: () => null } });
    const batch = async () => [];
    await dispatch.retract(input('e1', batch, 5));
    await dispatch.retract(input('e2', batch, 9));
    expect(slot).toHaveBeenCalledTimes(1);
  });
});

// ---- real stores ---------------------------------------------------------------------------------------------------

let apps: RealApp[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  await edits.clearAllMessageEditsState();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const app of apps) await app.sink.dispose();
});

const account = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

describe('30 withdrawn reactions on one message', () => {
  it('run ONE recompute of that message, and the stores equal the oracle', async () => {
    const recompute = vi.spyOn(reactions, 'recomputeMessageReactions');
    const app = make();
    const message = app.entry({ eventId: 'eb', account: BOB, rumorId: 'm1', content: 'hi' });
    const reacts = Array.from({ length: 30 }, (_, i) =>
      app.entry({ eventId: `x${i}`, kind: 7, account: account(0x20 + i), rumorId: `rx${i}`, content: '👍', tags: [['e', 'm1']] }),
    );
    const steps: Step[] = [append(message), ...reacts.map(append)];
    await runSteps(app, steps);
    expect(await app.reactionRows()).toHaveLength(30);
    recompute.mockClear();

    const drop = withdraw(...reacts.map((_, i) => `x${i}`));
    await runSteps(app, [drop]);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect((await app.reactionRows()).filter((r) => !r.removed)).toEqual([]);
    await expectOracle(app, [...steps, drop], make);
  });

  it('reactions of different messages recompute once each', async () => {
    const recompute = vi.spyOn(reactions, 'recomputeMessageReactions');
    const app = make();
    const steps: Step[] = [
      append(app.entry({ eventId: 'a', account: BOB, rumorId: 'm1', content: 'hi' })),
      append(app.entry({ eventId: 'b', account: BOB, rumorId: 'm2', content: 'yo' })),
      ...[0, 1, 2].map((i) => append(app.entry({ eventId: `x${i}`, kind: 7, account: account(0x30 + i), rumorId: `rx${i}`, content: '👍', tags: [['e', i === 2 ? 'm2' : 'm1']] }))),
    ];
    await runSteps(app, steps);
    recompute.mockClear();
    const drop = withdraw('x0', 'x1', 'x2');
    await runSteps(app, [drop]);
    expect(recompute).toHaveBeenCalledTimes(2);
    await expectOracle(app, [...steps, drop], make);
  });
});

describe('a stack of withdrawn edits of one slot', () => {
  it('run ONE slot recompute and drop the pinned rev of EVERY withdrawn rumor (oracle)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_800_000_000_000));
    const recompute = vi.spyOn(edits, 'recomputeSlot');
    const app = make();
    const nowSec = 1_800_000_000;
    const far = nowSec + 10 * 3600; // beyond the rev cap: every one of these revs is capped, hence PINNED
    const base = app.entry({ eventId: 'eb', account: ALICE, rumorId: 'm1', content: 'orig', at: nowSec - 100 });
    const editOf = (i: number) =>
      app.entry({ eventId: `e${i}`, kind: 9, account: ALICE, rumorId: `edit${i}`, content: `v${i}`, tags: [['e', 'm1', '', 'edit'], ['rev', String(far + i)]], at: far + i });
    const steps: Step[] = [append(base), ...[1, 2, 3, 4].map((i) => append(editOf(i)))];
    await runSteps(app, steps);
    recompute.mockClear();

    const drop = withdraw('e1', 'e2', 'e3', 'e4');
    await runSteps(app, [drop]);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect((await app.messages()).find((m) => m.id === 'm1')?.content).toBe('orig');
    await expectOracle(app, [...steps, drop], make);
  });
});

describe('the votes of one poll', () => {
  it('run ONE poll recompute', async () => {
    const recompute = vi.spyOn(polls, 'recomputePoll');
    const app = make();
    const open = app.entry({
      eventId: 'po',
      kind: POLL_OPEN_KIND,
      account: BOB,
      rumorId: 'p-open',
      content: JSON.stringify({ id: 'poll-1', title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: BOB }),
    });
    const vote = (i: number) =>
      app.entry({ eventId: `v${i}`, kind: POLL_VOTE_KIND, account: account(0x40 + i), rumorId: `pv${i}`, content: JSON.stringify({ pollId: 'poll-1', responses: ['A'], seq: 1 }) });
    const steps: Step[] = [append(open), ...[0, 1, 2, 3, 4].map((i) => append(vote(i)))];
    await runSteps(app, steps);
    recompute.mockClear();
    const drop = withdraw('v0', 'v1', 'v2', 'v3', 'v4');
    await runSteps(app, [drop]);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(await app.votes('poll-1')).toEqual([]);
    await expectOracle(app, [...steps, drop], make);
  });
});

describe('a failing recompute mid-batch', () => {
  it('leaves the finished aggregates done and the rest marked; the retried withdraw converges on the oracle', async () => {
    const real = reactions.recomputeMessageReactions;
    let calls = 0;
    vi.spyOn(reactions, 'recomputeMessageReactions').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('storage down');
      return real(...args);
    });
    const app = make();
    const steps: Step[] = [
      ...['m1', 'm2', 'm3'].map((id, i) => append(app.entry({ eventId: `b${i}`, account: BOB, rumorId: id, content: id }))),
      ...['m1', 'm2', 'm3'].map((id, i) => append(app.entry({ eventId: `x${i}`, kind: 7, account: ALICE, rumorId: `rx${i}`, content: '👍', tags: [['e', id]] }))),
    ];
    await runSteps(app, steps);
    const drop = withdraw('x0', 'x1', 'x2');
    await expect(runSteps(app, [drop])).rejects.toThrow('storage down');
    expect(await app.row('x0')).toBeUndefined(); // its aggregate was finished before the failure
    expect((await app.row('x1'))?.withdrawing).toBe(true);
    expect((await app.row('x2'))?.withdrawing).toBe(true);

    await runSteps(app, [drop]); // the retry (the same ids: unknown ones are a no-op, the marked ones finish)
    expect(await app.row('x1')).toBeUndefined();
    expect(await app.row('x2')).toBeUndefined();
    await expectOracle(app, [...steps, drop], make);
  });
});
