// @vitest-environment node
/**
 * S5 verification-examiner remediation, one describe per finding:
 *
 *  (1) a GROUP-thread reaction / delete-edit signal without an authenticated sender throws instead of falling back to
 *      the forgeable `rumor.pubkey` (a DM thread keeps reading it),
 *  (4) a recompute re-buffers pending entries with the history row's `receivedAt`, never the wall clock (AC-WDR-9),
 *  (5) a withdraw interrupted at any step of the reaction / poll recompute converges to the oracle in a NEW sink instance,
 *  (6) `holdReaction` rejecting on the sink path leaves the row undispatched and the retry applies it,
 *  (7) the own-withdraw branch of the chat handler acts only on a stored row of the SAME sender (AC-WDR-8).
 *
 * (2) and (3) live next to their handlers' suites (domainHandlers.test.ts, pollGroupHandler.test.ts).
 * Real collaborators over fake-indexeddb (realApp.ts); the crash is injected at the seams, as in deleteEditRetractReplay.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One-shot failure injection of an idb write: the (skip+1)th write of `key` after arming rejects.
const fault = vi.hoisted(() => ({ key: null as string | null, skip: 0 }));
vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    set: (key: IDBValidKey, value: unknown, store?: Parameters<typeof real.set>[2]) => {
      if (fault.key !== null && key === fault.key) {
        if (fault.skip > 0) fault.skip -= 1;
        else {
          fault.key = null;
          return Promise.reject(new Error('disk full'));
        }
      }
      return real.set(key, value, store);
    },
  };
});
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

import { get } from 'idb-keyval';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend, type GroupHistoryHandlers } from '@/src/lib/marmot/history';
import { applyInboundRumor, loadReactions } from '@/src/lib/reactions/api';
import { applyDeleteEditSignal, clearAllMessageEditsState, recomputeSlot } from '@/src/lib/messageEdits/api';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import type { RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import { ALICE, BOB, MALLORY, SELF, buildRealApp, ev, installLocalStorage, type RealApp } from './realApp';
import { append, expectOracle, runSteps, withdraw, type Step } from './oracle';

const T = 1_700_000_000;

let apps: RealApp[] = [];
let sinks: AppHistoryBackend[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  sinks = [];
  fault.key = null;
  fault.skip = 0;
  await clearAllMessageEditsState();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const sink of sinks) await sink.dispose();
  for (const app of apps) await app.sink.dispose();
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('(1) a group-thread signal needs an authenticated sender (no fallback to rumor.pubkey)', () => {
  const reaction = (pubkey: string) => ({ id: 'rx1', pubkey, created_at: T, content: '👍', tags: [['e', 'm1']] });
  const delSignal = (pubkey: string) => ({ id: 'd1', pubkey, created_at: T, kind: 5, tags: [['e', 'm1']], content: '' });

  it('applyInboundRumor on a group thread without a sender throws a TypeError and stores nothing', async () => {
    const thread = { kind: 'group' as const, groupId: 'g-rx-nosender' };
    await expect(applyInboundRumor(thread, reaction(BOB))).rejects.toBeInstanceOf(TypeError);
    expect(await loadReactions(thread)).toEqual([]);
  });

  it('applyInboundRumor on a group thread attributes to the given sender, not to rumor.pubkey', async () => {
    const thread = { kind: 'group' as const, groupId: 'g-rx-sender' };
    await applyInboundRumor(thread, reaction(BOB), { pubkey: ALICE, authenticity: 'mls' });
    expect((await loadReactions(thread)).map((r) => r.reactorPubkey)).toEqual([ALICE]);
  });

  it('applyInboundRumor on a DM thread keeps reading rumor.pubkey', async () => {
    const thread = { kind: 'dm' as const, peerPubkeyHex: BOB };
    await applyInboundRumor(thread, reaction(BOB));
    expect((await loadReactions(thread)).map((r) => r.reactorPubkey)).toEqual([BOB]);
  });

  it('applyDeleteEditSignal on a group thread without a sender throws a TypeError and buffers nothing', async () => {
    const thread = { kind: 'group' as const, groupId: 'g-de-nosender' };
    await expect(applyDeleteEditSignal(thread, delSignal(BOB))).rejects.toBeInstanceOf(TypeError);
    expect(((await get<unknown[]>('few:messageEditsPendingSignals:v1')) ?? []).length).toBe(0);
  });

  it('applyDeleteEditSignal on a DM thread without a sender keeps reading rumor.pubkey (buffered as that author)', async () => {
    const thread = { kind: 'dm' as const, peerPubkeyHex: BOB };
    expect((await applyDeleteEditSignal(thread, delSignal(BOB))).kind).toBe('pending');
    const pending = (await get<Array<{ authorPubkeyHex: string }>>('few:messageEditsPendingSignals:v1')) ?? [];
    expect(pending.map((p) => p.authorPubkeyHex)).toEqual([BOB]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('(4) a recompute re-buffers pending entries with the row clock, not the wall clock (AC-WDR-9)', () => {
  const G = 'g-pending-clock';
  const thread = { kind: 'group' as const, groupId: G };
  const editOfMissing = (id: string, target: string, rev: number) => ({
    id, pubkey: ALICE, created_at: rev, kind: 9, content: `edit of ${target}`, tags: [['e', target, '', 'edit'], ['rev', String(rev)]],
  });
  const signals = (): RecomputeSignal[] => [
    { seq: 1, eventId: 'ee1', sender: ALICE, receivedAt: 1_700_000_100_000, rumor: editOfMissing('r-edit', 'm1', T + 10) },
    { seq: 2, eventId: 'ee2', sender: ALICE, receivedAt: 1_700_000_200_000, rumor: { id: 'r-del', pubkey: ALICE, created_at: T + 20, kind: 5, tags: [['e', 'm2']], content: '' } },
  ];
  const pendingAfter = async (wallClockMs: number) => {
    vi.spyOn(Date, 'now').mockReturnValue(wallClockMs);
    await recomputeSlot(thread, ['m1', 'm2'], signals());
    vi.restoreAllMocks();
    return ((await get<Array<{ targetId: string; receivedAt: number }>>('few:messageEditsPendingSignals:v1')) ?? [])
      .slice()
      .sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
  };

  it('the same remaining rows recomputed under two wall clocks leave identical pending entries, stamped with the rows\' receivedAt', async () => {
    const early = await pendingAfter(1_800_000_000_000);
    const late = await pendingAfter(2_500_000_000_000);
    expect(early.map((p) => p.targetId)).toEqual(['m1', 'm2']);
    expect(late).toEqual(early);
    expect(early.map((p) => p.receivedAt)).toEqual([1_700_000_100_000, 1_700_000_200_000]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Crash = 'after-mark' | 'rows-write-fails' | 'held-write-fails' | 'after-retract';

/**
 * Appends `build(app)` through the app's sink, then withdraws `labels` through a sink whose withdraw is interrupted
 * at `crash`; returns the app after a SECOND sink instance recovered the group (startup sweep).
 */
async function interrupted(build: (app: RealApp) => Step[], labels: string[], crash: Crash, failKey?: (app: RealApp) => string) {
  const app = make();
  const steps = build(app);
  await runSteps(app, steps);

  let crashed = false;
  const faulty: GroupHistoryHandlers = {
    dispatch: (input) => app.dispatcher.dispatch(input),
    retract: async (input) => {
      if (crash === 'after-mark') throw new Error('crash after the mark');
      if (failKey) fault.key = failKey(app);
      try {
        await app.dispatcher.retract(input);
      } finally {
        fault.key = null;
      }
      if (crash === 'after-retract' && !crashed) {
        crashed = true;
        throw new Error('crash after the retract, before the rows were deleted');
      }
    },
  };
  const first = createHistoryBackend({ handlers: faulty, store: createIdbHistoryStore(`s5-${app.groupId}`), onError: () => undefined });
  sinks.push(first);
  await expect(first.withdraw(app.groupId, ev(...labels))).rejects.toThrow();
  // the interrupted withdraw left the rows marked: they are no longer part of the visible history
  expect((await first.list(app.groupId)).map((e) => Buffer.from(e.eventId, 'hex').toString())).not.toContain(labels[0]);

  const second = createHistoryBackend({ handlers: app.dispatcher, store: createIdbHistoryStore(`s5-${app.groupId}`), onError: () => undefined });
  sinks.push(second);
  await second.sweep();
  return { app, steps: [...steps, withdraw(...labels)] };
}

describe('(5a) reactions: a withdraw interrupted at any step converges to the oracle in a new instance', () => {
  const message = (app: RealApp) => app.entry({ eventId: 'em1', account: ALICE, rumorId: 'm1', content: 'hello', at: T - 100 });
  const react = (app: RealApp, label: string, account: string, emoji: string, at: number) =>
    app.entry({ eventId: label, kind: 7, account, rumorId: `r-${label}`, content: emoji, tags: [['e', 'm1']], at });
  const stacked = (app: RealApp): Step[] => [
    append(message(app)),
    append(react(app, 'rb', BOB, '👍', T)),
    append(react(app, 'rm', MALLORY, '🎉', T + 1)),
    append(react(app, 'rb2', BOB, '❤️', T + 2)),
  ];
  const liveOf = async (app: RealApp) =>
    (await app.reactionRows()).filter((r) => !r.removed).map((r) => `${r.reactorPubkey}:${r.emoji}`).sort();
  const rowsKey = (app: RealApp) => `few:reactions:group:${app.groupId}`;
  const heldKey = (app: RealApp) => `few:reactions:held:group:${app.groupId}`;

  const CRASHES: Array<[Crash, ((app: RealApp) => string) | undefined]> = [
    ['after-mark', undefined],
    ['rows-write-fails', rowsKey],
    ['after-retract', undefined],
  ];
  for (const [crash, key] of CRASHES) {
    it(`a reaction withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['rb'], crash, key);
      await expectOracle(app, steps, make);
      expect(await liveOf(app)).toEqual([`${BOB}:❤️`, `${MALLORY}:🎉`]);
    });

    it(`the whole reaction batch withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['rb', 'rm', 'rb2'], crash, key);
      await expectOracle(app, steps, make);
      expect(await liveOf(app)).toEqual([]);
    });
  }

  for (const [crash, key] of [['after-mark', undefined], ['held-write-fails', heldKey], ['rows-write-fails', rowsKey], ['after-retract', undefined]] as const) {
    it(`the base message withdrawn (reactions are held), crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['em1'], crash, key);
      await expectOracle(app, steps, make);
      expect(await liveOf(app)).toEqual([]); // held, not visible, until the base is stored again
      // the base returns: the held reactions apply, exactly the oracle's
      const back = message(app);
      await app.sink.append({ ...back, eventId: ev('em1-again')[0] });
      const oracle = make();
      for (const step of [...steps, append({ ...message(oracle), eventId: ev('em1-again')[0] })]) {
        if (step.op === 'append') await oracle.sink.append({ ...step.entry, groupId: oracle.groupId });
        else await oracle.sink.withdraw(oracle.groupId, step.ids);
      }
      expect(await liveOf(app)).toEqual(await liveOf(oracle));
      expect(await liveOf(app)).toHaveLength(3);
    });
  }
});

describe('(5b) polls: a withdraw interrupted at any step converges to the oracle in a new instance', () => {
  const POLL = 'poll-1';
  const openC = JSON.stringify({ id: POLL, title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: ALICE });
  const voteC = (r: string, seq = 1) => JSON.stringify({ pollId: POLL, responses: [r], seq });
  const closeC = JSON.stringify({ pollId: POLL, results: [], totalVoters: 0 });
  const entry = (app: RealApp, label: string, kind: number, account: string, content: string, at: number) =>
    app.entry({ eventId: label, kind, account, content, at });
  const full = (app: RealApp): Step[] => [
    append(entry(app, 'po', POLL_OPEN_KIND, ALICE, openC, T)),
    append(entry(app, 'pv1', POLL_VOTE_KIND, BOB, voteC('A'), T + 1)),
    append(entry(app, 'pv2', POLL_VOTE_KIND, MALLORY, voteC('B'), T + 2)),
    append(entry(app, 'pv3', POLL_VOTE_KIND, BOB, voteC('B', 2), T + 3)),
    append(entry(app, 'pc', POLL_CLOSE_KIND, ALICE, closeC, T + 4)),
  ];
  const poll = async (app: RealApp) => (await app.polls()).find((p) => p.id === POLL);

  for (const crash of ['after-mark', 'after-retract'] as const) {
    it(`a vote withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(full, ['pv3'], crash);
      await expectOracle(app, steps, make);
      expect((await poll(app))?.closed).toBe(true);
    });

    it(`the close withdrawn (the poll reopens), crash ${crash}`, async () => {
      const { app, steps } = await interrupted(full, ['pc'], crash);
      await expectOracle(app, steps, make);
      expect((await poll(app))?.closed).toBe(false);
    });

    it(`the open withdrawn (votes and close are held again), crash ${crash}`, async () => {
      const { app, steps } = await interrupted(full, ['po'], crash);
      await expectOracle(app, steps, make);
      expect(await poll(app)).toBeUndefined();
    });

    it(`votes and close withdrawn in one batch, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(full, ['pv1', 'pv2', 'pv3', 'pc'], crash);
      await expectOracle(app, steps, make);
      expect((await app.votes(POLL)).length).toBe(0);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('(6) holdReaction rejecting on the sink path', () => {
  it('leaves the row undispatched and a retry applies it (held, then released when the target lands)', async () => {
    const app = make();
    const orphan = app.entry({ eventId: 'rx', kind: 7, account: BOB, rumorId: 'r-rx', content: '👍', tags: [['e', 'm1']], at: T });
    fault.key = `few:reactions:held:group:${app.groupId}`; // the hold's write fails once
    await expect(app.sink.append(orphan)).rejects.toThrow('disk full');
    expect((await app.row('rx'))?.dispatched).toBe(false);
    expect(await app.reactionRows()).toEqual([]);

    await app.sink.append(orphan); // the sink retries the undispatched row: now held
    expect((await app.row('rx'))?.dispatched).toBe(true);
    expect(await app.reactionRows()).toEqual([]);

    await app.sink.append(app.entry({ eventId: 'em1', account: ALICE, rumorId: 'm1', content: 'hello', at: T - 100 }));
    expect((await app.reactionRows()).filter((r) => !r.removed).map((r) => [r.reactorPubkey, r.emoji])).toEqual([[BOB, '👍']]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('(7) own-withdraw acts only on a stored row of the same sender (AC-WDR-8)', () => {
  it('a withdrawn own delivery of a rumor id whose stored row is ANOTHER sender\'s hands nothing back and bumps nothing', async () => {
    const app = make();
    // BOB's row under rumor id m1 is stored first; SELF's byte-identical copy is a duplicate that never backed the row
    await app.sink.append(app.entry({ eventId: 'eb', account: BOB, rumorId: 'm1', content: 'bob says', at: T }));
    await app.sink.append(app.entry({ eventId: 'es', account: SELF, rumorId: 'm1', content: 'bob says', at: T }));
    const bumpsBefore = app.versions.chat;
    app.spies.onOwnWithdrawn.mockClear();

    await app.sink.withdraw(app.groupId, ev('es'));

    expect(app.spies.onOwnWithdrawn).not.toHaveBeenCalled();
    expect(app.versions.chat).toBe(bumpsBefore);
    expect((await app.messages()).map((m) => [m.id, m.senderPubkey])).toEqual([['m1', BOB]]);
  });

  it('control: a withdrawn own delivery of an own row is handed back', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'es', account: SELF, rumorId: 'm2', content: 'mine', at: T }));
    app.spies.onOwnWithdrawn.mockClear();
    await app.sink.withdraw(app.groupId, ev('es'));
    expect(app.spies.onOwnWithdrawn).toHaveBeenCalledTimes(1);
    expect(app.spies.onOwnWithdrawn).toHaveBeenCalledWith(app.groupId, 'm2');
  });
});
