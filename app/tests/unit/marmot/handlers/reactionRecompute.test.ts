// @vitest-environment node
/**
 * Reactions: RECOMPUTE-ON-RETRACT against the oracle (AC-WDR-1..9, gate-remediation ruling).
 *
 * The claim: after any sequence of appends and withdraws, the reactions store (rows AND the held queue) equals the
 * store produced by dispatching ONLY the surviving history rows, in `seq` order, into EMPTY stores - whatever was
 * withdrawn, in whatever order, with duplicate carriers and forged copies in the mix.
 *
 * Ruling matrix items covered here: 1 (reactions, property), 5 (kind-7 duplicate carriers, both orders),
 * 6 (reaction forged byte-identical copy), 7 (add/remove/re-add, pairs both orders, two reactors on one emoji,
 * an own optimistic reaction survives another's retract), 9 (base message withdrawn / re-appended),
 * 10 (batch withdraw), 13 (reaction part: no effects, purged does no fold), 14 (twice / unseen).
 *
 * Real collaborators: the reactions store, chatPersistence, the history sink and dispatcher (realApp.ts) over
 * fake-indexeddb. The property uses a seeded PRNG (the repo has no fast-check); a failing seed is printed.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOptimistic, loadReactions, subscribeReactions } from '@/src/lib/reactions/api';
import { createReactionGroupHandler } from '@/src/lib/marmot/handlers/reactionHandler';
import type { RealApp } from './realApp';
import { ALICE, BOB, buildRealApp, installLocalStorage, MALLORY, SELF, unreadOf } from './realApp';
import { append, expectOracle, runSteps, snapshot, withdraw, type Step } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
let groups = 0;
// group ids that can never equal an account pubkey (the oracle snapshot normalises the group id away by text)
const make = () => {
  const app = buildRealApp({ groupId: (++groups).toString(16).padStart(8, '0').repeat(8) });
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

const T = 1_700_000_000;
const MSG = 'm1';

/** Entry builders over an app: a chat message (the reaction target) and kind-7 add / removal rumors. */
const message = (app: RealApp, label = 'em1', rumorId = MSG) => app.entry({ eventId: label, account: ALICE, rumorId, content: 'hello', at: T - 100 });
const add = (app: RealApp, label: string, account: string, emoji: string, at: number, o: { rumorId?: string; target?: string } = {}) =>
  app.entry({ eventId: label, kind: 7, account, rumorId: o.rumorId ?? `r-${label}`, content: emoji, tags: [['e', o.target ?? MSG]], at });
const remove = (app: RealApp, label: string, account: string, emoji: string, at: number, o: { rumorId?: string; target?: string } = {}) =>
  app.entry({ eventId: label, kind: 7, account, rumorId: o.rumorId ?? `r-${label}`, content: '-', tags: [['e', o.target ?? MSG], ['emoji', emoji]], at });

const liveOf = async (app: RealApp) =>
  (await app.reactionRows()).filter((r) => !r.removed).map((r) => [r.reactorPubkey, r.emoji]).sort();

/** Runs `steps` against a fresh app and asserts the oracle equivalence; returns the app for further checks. */
async function converges(build: (app: RealApp) => Step[]): Promise<RealApp> {
  const app = make();
  const steps = build(app);
  await runSteps(app, steps);
  await expectOracle(app, steps, make);
  return app;
}

/** All permutations of a small array. */
const permutations = <T,>(xs: T[]): T[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
/** All non-empty subsets. */
const subsets = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) out.push(xs.filter((_, i) => mask & (1 << i)));
  return out;
};

describe('(1) property: any appends and withdraws equal dispatching only the survivors', () => {
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed);
      const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
      const app = make();
      const senders = [BOB, MALLORY, ALICE, SELF];
      const emojis = ['👍', '🎉'];
      const pool = [] as ReturnType<typeof app.entry>[];
      // the base messages (m1 stored by default, m2 sometimes withdrawn)
      pool.push(message(app, 'em1', 'm1'), message(app, 'em2', 'm2'));
      // rumors by id: a later carrier / forged copy is BYTE-IDENTICAL (same content, tags, time), only the event id
      // and the sender differ (two different rumors never share an id)
      const rumors: { rumorId: string; emoji: string; at: number; target: string; isRemoval: boolean }[] = [];
      const n = 6 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        const label = `e${i}`;
        const sender = pick(senders);
        const copy = rumors.length > 0 && rnd() < 0.25 ? pick(rumors) : undefined;
        const r = copy ?? {
          rumorId: `r${i}`,
          emoji: pick(emojis),
          at: T + Math.floor(rnd() * 6) * 10,
          target: pick(['m1', 'm1', 'm2']),
          isRemoval: rnd() < 0.3,
        };
        if (!copy) rumors.push(r);
        const build = r.isRemoval ? remove : add;
        pool.push(build(app, label, sender, r.emoji, r.at, { rumorId: r.rumorId, target: r.target }));
      }
      const steps: Step[] = [];
      for (const e of pool.sort(() => rnd() - 0.5)) {
        if (rnd() < 0.85) steps.push(append(e));
        if (rnd() < 0.3 && steps.length > 0) {
          const k = 1 + Math.floor(rnd() * 3);
          const labels = Array.from({ length: k }, () => pick(pool));
          steps.push(withdraw(...labels.map((p) => Buffer.from(p.eventId, 'hex').toString())));
        }
        // sometimes re-append a withdrawn / present entry
        if (rnd() < 0.15) steps.push(append(pick(pool)));
      }
      await runSteps(app, steps);
      try {
        await expectOracle(app, steps, make);
      } catch (err) {
        throw new Error(`oracle mismatch for seed ${seed}: ${(err as Error).message}`);
      }
    });
  }
});

describe('(5) duplicate carriers of one reaction rumor, both withdraw orders', () => {
  it.each([['e1', 'e2'], ['e2', 'e1']])('withdrawing %s then %s: the reaction survives the first and goes with the last', async (first, second) => {
    const app = make();
    const steps: Step[] = [
      append(message(app)),
      append(add(app, 'e1', BOB, '👍', T, { rumorId: 'dup' })),
      append(add(app, 'e2', BOB, '👍', T, { rumorId: 'dup' })),
    ];
    await runSteps(app, steps);
    expect(await liveOf(app)).toEqual([[BOB, '👍']]);
    for (const label of [first, second]) {
      steps.push(withdraw(label));
      await runSteps(app, steps.slice(-1));
      await expectOracle(app, steps, make);
      expect(await liveOf(app)).toEqual(label === first ? [[BOB, '👍']] : []);
    }
  });

  it('a duplicate carrier of a REMOVAL: the reaction stays removed until both carriers are withdrawn', async () => {
    for (const order of permutations(['e2', 'e3'])) {
      const app = make();
      const steps: Step[] = [
        append(message(app)),
        append(add(app, 'e1', BOB, '👍', T)),
        append(remove(app, 'e2', BOB, '👍', T + 10, { rumorId: 'rm' })),
        append(remove(app, 'e3', BOB, '👍', T + 10, { rumorId: 'rm' })),
      ];
      await runSteps(app, steps);
      expect(await liveOf(app)).toEqual([]);
      for (const label of order) {
        steps.push(withdraw(label));
        await runSteps(app, steps.slice(-1));
        await expectOracle(app, steps, make);
      }
      expect(await liveOf(app)).toEqual([[BOB, '👍']]);
    }
  });
});

describe('(6) a forged byte-identical copy of a reaction', () => {
  it.each([
    ['victim first', ['ev', 'em']],
    ['forger first', ['em', 'ev']],
  ])('%s: each sender keeps its own reaction; withdrawing either copy leaves the other', async (_name, order) => {
    for (const withdrawn of ['em', 'ev']) {
      const app = make();
      const copies = { ev: add(app, 'ev', BOB, '👍', T, { rumorId: 'same' }), em: add(app, 'em', MALLORY, '👍', T, { rumorId: 'same' }) };
      const steps: Step[] = [append(message(app)), ...order.map((k) => append(copies[k as 'ev' | 'em']))];
      await runSteps(app, steps);
      expect(await liveOf(app)).toEqual([[BOB, '👍'], [MALLORY, '👍']]);
      steps.push(withdraw(withdrawn));
      await runSteps(app, steps.slice(-1));
      await expectOracle(app, steps, make);
      // withdrawing M's copy: V intact; withdrawing V's: nothing attributed to V, M's copy judged as M's own
      expect(await liveOf(app)).toEqual(withdrawn === 'em' ? [[BOB, '👍']] : [[MALLORY, '👍']]);
    }
  });

  it('a forged copy of a REMOVAL does not remove the victim reaction', async () => {
    const app = make();
    const steps: Step[] = [
      append(message(app)),
      append(add(app, 'e1', BOB, '👍', T)),
      append(remove(app, 'e2', MALLORY, '👍', T + 10, { rumorId: 'rm' })),
      append(remove(app, 'e3', BOB, '👍', T + 10, { rumorId: 'rm' })),
    ];
    await runSteps(app, steps);
    expect(await liveOf(app)).toEqual([]);
    steps.push(withdraw('e3'));
    await runSteps(app, steps.slice(-1));
    await expectOracle(app, steps, make);
    expect(await liveOf(app)).toEqual([[BOB, '👍']]);
  });
});

describe('(7) add / remove / re-add', () => {
  const lifecycle = (app: RealApp, account = BOB): Step[] => [
    append(message(app)),
    append(add(app, 'a1', account, '👍', T)),
    append(remove(app, 'rm', account, '👍', T + 10)),
    append(add(app, 'a2', account, '👍', T + 20)),
  ];

  it('every single withdraw and every ordered pair of withdraws equals the oracle', async () => {
    for (const labels of subsets(['a1', 'rm', 'a2'])) {
      for (const order of permutations(labels)) {
        const app = make();
        const steps = lifecycle(app);
        await runSteps(app, steps);
        for (const l of order) steps.push(withdraw(l));
        await runSteps(app, steps.slice(-order.length));
        await expectOracle(app, steps, make);
      }
    }
  }, 30_000);

  it('appends in every order give the same end state as the oracle (the arrival order is irrelevant)', async () => {
    for (const order of permutations(['a1', 'rm', 'a2'])) {
      const app = make();
      const entries = { a1: add(app, 'a1', BOB, '👍', T), rm: remove(app, 'rm', BOB, '👍', T + 10), a2: add(app, 'a2', BOB, '👍', T + 20) };
      const steps: Step[] = [append(message(app)), ...order.map((k) => append(entries[k as keyof typeof entries])), withdraw(order[order.length - 1])];
      await runSteps(app, steps);
      await expectOracle(app, steps, make);
    }
  });

  it('two reactors on one emoji: withdrawing one leaves the other, both orders', async () => {
    for (const order of permutations(['b', 'm'])) {
      const app = make();
      const steps: Step[] = [append(message(app)), append(add(app, 'b', BOB, '👍', T)), append(add(app, 'm', MALLORY, '👍', T + 5))];
      await runSteps(app, steps);
      for (const l of order) {
        steps.push(withdraw(l));
        await runSteps(app, steps.slice(-1));
        await expectOracle(app, steps, make);
      }
      expect(await liveOf(app)).toEqual([]);
    }
  });

  it("an own optimistic reaction (not yet confirmed) survives another member's withdrawn reaction", async () => {
    const app = make();
    const group = { kind: 'group' as const, groupId: app.groupId };
    await app.sink.append(message(app));
    await applyOptimistic(group, { id: 'own1', messageId: MSG, reactorPubkey: SELF, emoji: '🎉', eventId: '', createdAt: (T + 50) * 1000, removed: false });
    await app.sink.append(add(app, 'e1', BOB, '👍', T));
    const own = (await loadReactions(group)).find((r) => r.id === 'own1');
    await app.sink.withdraw(app.groupId, [Buffer.from('e1').toString('hex')]);
    expect(await liveOf(app)).toEqual([[SELF, '🎉']]);
    expect((await loadReactions(group)).find((r) => r.id === 'own1')).toEqual(own);
    // the echo of the own reaction then confirms it exactly once
    await app.sink.append(app.entry({ eventId: 'own', kind: 7, account: SELF, rumorId: 'own1', content: '🎉', tags: [['e', MSG]], at: T + 50 }));
    expect((await loadReactions(group)).filter((r) => r.reactorPubkey === SELF)).toHaveLength(1);
    expect((await loadReactions(group)).find((r) => r.id === 'own1')?.eventId).toBe('own1');
  });
});

describe('(9) the base message', () => {
  it('withdrawing the last carrier of the message leaves no visible reaction; re-appending it restores them', async () => {
    const app = make();
    const steps: Step[] = [
      append(message(app)),
      append(add(app, 'e1', BOB, '👍', T)),
      append(add(app, 'e2', MALLORY, '🎉', T)),
      withdraw('em1'),
    ];
    await runSteps(app, steps);
    await expectOracle(app, steps, make);
    expect(await liveOf(app)).toEqual([]);
    expect(await app.messages()).toEqual([]);
    steps.push(append(message(app)));
    await runSteps(app, steps.slice(-1));
    await expectOracle(app, steps, make);
    expect(await liveOf(app)).toEqual([[BOB, '👍'], [MALLORY, '🎉']]);
  });

  it('a withdrawn reaction is not revived when the message is later re-appended', async () => {
    const app = make();
    const steps: Step[] = [append(message(app)), append(add(app, 'e1', BOB, '👍', T)), withdraw('em1'), withdraw('e1'), append(message(app))];
    await runSteps(app, steps);
    await expectOracle(app, steps, make);
    expect(await liveOf(app)).toEqual([]);
  });
});

describe('(10) a batch withdraw folds no intermediate state', () => {
  it('no state a reader sees during withdraw([e1, e2]) contains either reaction', async () => {
    const app = make();
    await runSteps(app, [append(message(app)), append(add(app, 'e1', BOB, '👍', T)), append(add(app, 'e2', MALLORY, '🎉', T)), append(add(app, 'e3', ALICE, '👍', T))]);
    const group = { kind: 'group' as const, groupId: app.groupId };
    const seen: string[][] = [];
    const off = subscribeReactions(group, () => void loadReactions(group).then((rows) => seen.push(rows.filter((r) => !r.removed).map((r) => r.reactorPubkey))));
    await app.sink.withdraw(app.groupId, [Buffer.from('e1').toString('hex'), Buffer.from('e2').toString('hex')]);
    off();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThan(0);
    for (const snap of seen) {
      expect(snap).not.toContain(BOB);
      expect(snap).not.toContain(MALLORY);
    }
    expect(await liveOf(app)).toEqual([[ALICE, '👍']]);
    await expectOracle(app, [append(message(app)), append(add(app, 'e3', ALICE, '👍', T))], make);
  });
});

describe('(13) no effects, no fold when purged', () => {
  it('a withdraw of reactions calls no bell, unread bump, known-peer write, send or announcement', async () => {
    const app = make();
    await runSteps(app, [append(message(app)), append(add(app, 'e1', BOB, '👍', T)), append(add(app, 'e2', MALLORY, '🎉', T))]);
    const unread = unreadOf(app.groupId);
    const callsBefore = app.calls.length;
    await app.sink.withdraw(app.groupId, [Buffer.from('e1').toString('hex')]);
    expect(app.spies.onOwnEcho).not.toHaveBeenCalled();
    expect(app.spies.onOwnWithdrawn).not.toHaveBeenCalled();
    expect(app.spies.sendAnnouncement).not.toHaveBeenCalled();
    expect(app.spies.sendSelfProfile).not.toHaveBeenCalled();
    expect(app.spies.notifyProfileObserved).not.toHaveBeenCalled();
    expect(app.calls.length).toBe(callsBefore);
    expect(app.jobs).toHaveLength(0);
    expect(unreadOf(app.groupId)).toBe(unread);
  });

  it('a purged retract recomputes nothing', async () => {
    const recompute = vi.fn(async () => true);
    const bump = vi.fn();
    const handler = createReactionGroupHandler({
      loadMessages: vi.fn(),
      applyInboundRumor: vi.fn(),
      setReactionsVersion: bump,
      recomputeMessageReactions: recompute,
      holdReaction: vi.fn(),
      releaseHeldReactions: vi.fn(),
    } as never);
    const remaining = vi.fn(async () => []);
    const input = { groupId: 'g', eventId: 'e', sender: BOB, rumor: { id: 'r', kind: 7, pubkey: BOB, created_at: T, content: '👍', tags: [['e', MSG]] }, remaining };
    await handler.retract({ ...input, reason: 'purged' } as never, { selfPubkeyHex: SELF, getActiveGroupId: () => null });
    expect(recompute).not.toHaveBeenCalled();
    expect(remaining).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
    // a plain withdraw does recompute, from the target named by the withdrawn rumor, and bumps iff it changed
    await handler.retract(input as never, { selfPubkeyHex: SELF, getActiveGroupId: () => null });
    expect(recompute).toHaveBeenCalledWith({ kind: 'group', groupId: 'g' }, MSG, []);
    expect(bump).toHaveBeenCalledTimes(1);
    recompute.mockResolvedValueOnce(false);
    await handler.retract(input as never, { selfPubkeyHex: SELF, getActiveGroupId: () => null });
    expect(bump).toHaveBeenCalledTimes(1);
  });
});

describe('(14) retract twice / an unseen id', () => {
  it('withdrawing the same id twice, or an id that was never appended, changes nothing and bumps nothing', async () => {
    const app = make();
    await runSteps(app, [append(message(app)), append(add(app, 'e1', BOB, '👍', T)), append(add(app, 'e2', MALLORY, '🎉', T))]);
    await app.sink.withdraw(app.groupId, [Buffer.from('e1').toString('hex')]);
    const once = await snapshot(app);
    const version = app.versions.reactions;
    await app.sink.withdraw(app.groupId, [Buffer.from('e1').toString('hex')]);
    await app.sink.withdraw(app.groupId, [Buffer.from('never').toString('hex')]);
    expect(await snapshot(app)).toEqual(once);
    expect(app.versions.reactions).toBe(version);
  });
});
