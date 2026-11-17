// @vitest-environment node
/**
 * Delete / edit slots: RECOMPUTE-ON-RETRACT against the oracle (AC-WDR-1..9, gate-remediation ruling).
 *
 * The claim: after any sequence of appends and withdraws, the delete/edit state of a message slot (the chat row incl.
 * its write-once `original`, the pending / marker / slot-meta / pin aux state) equals the state produced by
 * dispatching ONLY the surviving history rows, in `seq` order, into EMPTY stores - whatever was withdrawn, in whatever
 * order, with duplicate carriers and forged byte-identical copies in the mix.
 *
 * Ruling matrix items covered here: 1 (slots, property), 2 (stacked edits), 3 (edit + delete both orders),
 * 4 (multi-e-tag delete), 5 (kind 5 and edit-9 duplicate carriers, both orders), 6 (edit / delete forged copies),
 * 9 (base message last carrier withdrawn / re-append; no visible dependents), 10 (batch), 13 (slot part: no effects,
 * purged does no fold), 14 (twice / unseen), 15 (clock determinism). Crash replay (11) lives in
 * deleteEditRetractReplay.test.ts, the one-read contract in slotRecomputeReads.test.ts.
 *
 * Real collaborators: chatPersistence, messageEdits/api, the history sink and dispatcher (realApp.ts) over
 * fake-indexeddb. The property uses a seeded PRNG (the repo has no fast-check); a failing seed is in the message.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as edits from '@/src/lib/messageEdits/api';
import { isKnownPeer } from '@/src/lib/knownPeers';
import type { RealApp } from './realApp';
import { ALICE, BOB, buildRealApp, ev, installLocalStorage, MALLORY, SELF, unreadOf } from './realApp';
import { append, expectOracle, runOracle, runSteps, snapshot, withdraw, type Step } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  // the aux stores are global and cap-bounded: a test must not inherit (or evict) another's entries
  await edits.clearAllMessageEditsState();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const app of apps) await app.sink.dispose();
});

const T = 1_700_000_000;

// ─── entry builders ───────────────────────────────────────────────────────────────────────────

type Opts = { account?: string; pubkey?: string; rumorId?: string };
/** A chat message (the slot's base) by `author`. */
const message = (app: RealApp, label = 'eb', id = 'm1', author = ALICE) =>
  app.entry({ eventId: label, account: author, rumorId: id, content: `orig ${id}`, at: T - 100 });
/** An edit-marked kind-9 replacement of `target`; `rev` is also its created_at. */
const edit = (app: RealApp, label: string, target: string, rev: number, content: string, o: Opts = {}) =>
  app.entry({
    eventId: label,
    kind: 9,
    account: o.account ?? ALICE,
    ...(o.pubkey ? { pubkey: o.pubkey } : {}),
    rumorId: o.rumorId ?? `r-${label}`,
    content,
    tags: [['e', target, '', 'edit'], ['rev', String(rev)]],
    at: rev,
  });
/** A kind-5 delete naming every target (bare e-tags); `rev` is its created_at. */
const del = (app: RealApp, label: string, targets: string | string[], rev: number, o: Opts = {}) =>
  app.entry({
    eventId: label,
    kind: 5,
    account: o.account ?? ALICE,
    ...(o.pubkey ? { pubkey: o.pubkey } : {}),
    rumorId: o.rumorId ?? `r-${label}`,
    content: '',
    tags: (Array.isArray(targets) ? targets : [targets]).map((t) => ['e', t]),
    at: rev,
  });
/** A byte-identical copy of `entry` delivered under another sender (a forgery: same rumor, same claimed pubkey). */
const forged = (app: RealApp, entry: ReturnType<RealApp['entry']>, label: string, account = MALLORY) =>
  app.entry({
    eventId: label,
    kind: entry.rumor.kind,
    account,
    pubkey: entry.rumor.pubkey,
    rumorId: entry.rumor.id,
    content: entry.rumor.content,
    tags: entry.rumor.tags,
    at: entry.rumor.created_at,
  });

const rowOf = async (app: RealApp, id = 'm1') => (await app.messages()).find((m) => m.id === id);
/** The user-visible state of a slot: what the UI shows (tombstoned rows are hidden). */
const shown = async (app: RealApp, id = 'm1') => {
  const row = await rowOf(app, id);
  return row && !row.tombstoned ? { content: row.content, edited: row.edited === true } : null;
};

/** Runs `steps` against a fresh app and asserts the oracle equivalence; returns the app for further checks. */
async function converges(build: (app: RealApp) => Step[]): Promise<RealApp> {
  const app = make();
  const steps = build(app);
  await runSteps(app, steps);
  await expectOracle(app, steps, make);
  return app;
}

/**
 * The oracle equivalence of `expectOracle`, modulo GHOST pending entries: a multi-e-tag delete buffers one entry per
 * named id, including the prior-replacement ids that are never message rows ("ghosts"). Whether such a sibling
 * survives depends on the collapse / resolve history (a live arrival order the oracle does not replay), never on the
 * surviving rows; it can never be applied to a row, so it is not part of the equivalence. Everything else is.
 */
async function expectOracleModuloGhosts(app: RealApp, steps: readonly Step[], ghosts: ReadonlySet<string>): Promise<void> {
  const oracle = await runOracle(steps, make);
  const strip = async (a: RealApp) => {
    const snap = (await snapshot(a)) as { edits: { pending: { targetId: string }[] } };
    snap.edits.pending = snap.edits.pending.filter((p) => !ghosts.has(p.targetId));
    return snap;
  };
  expect(await strip(app)).toEqual(await strip(oracle));
}

const permutations = <X,>(xs: X[]): X[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
const subsets = <X,>(xs: X[]): X[][] => {
  const out: X[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) out.push(xs.filter((_, i) => mask & (1 << i)));
  return out;
};

// ─── (1) the property ─────────────────────────────────────────────────────────────────────────

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

  // More seeds for a deeper local run: SLOT_SEED_FROM=1 SLOT_SEEDS=100 (keep a run under ~120 seeds: realApp's group ids wrap at 256 apps).
  const from = Number(process.env.SLOT_SEED_FROM ?? 1);
  for (let seed = from; seed < from + Number(process.env.SLOT_SEEDS ?? 40); seed++) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed);
      const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
      const app = make();
      const owners: Record<string, string> = { m1: ALICE, m2: BOB };
      const pool: ReturnType<typeof app.entry>[] = [message(app, 'eb1', 'm1', ALICE), message(app, 'eb2', 'm2', BOB)];
      const signals: ReturnType<typeof app.entry>[] = [];
      const n = 6 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        const label = `e${i}`;
        const target = pick(['m1', 'm1', 'm2']);
        const rev = T + Math.floor(rnd() * 6) * 10; // ties included
        // 70% the message's own author, else someone else (unauthorized)
        const account = rnd() < 0.7 ? owners[target] : pick([MALLORY, SELF, ALICE, BOB]);
        const copyOf = signals.length > 0 && rnd() < 0.25 ? pick(signals) : undefined;
        let entry: ReturnType<typeof app.entry>;
        if (copyOf) {
          // another carrier of the same rumor, or a forged copy under another sender
          entry = forged(app, copyOf, label, rnd() < 0.5 ? copyOf.orderingKey.account : pick([MALLORY, BOB, ALICE]));
        } else if (rnd() < 0.5) {
          entry = edit(app, label, target, rev, `edit ${i}`, { account });
        } else {
          // a delete names the original AND a prior replacement id (D14): an id that is never a stored row
          const targets = rnd() < 0.3 ? [target, pick(['p-never', ...signals.map((s) => s.rumor.id)])] : [target];
          entry = del(app, label, targets, rev, { account });
        }
        signals.push(entry);
        pool.push(entry);
      }
      const steps: Step[] = [];
      for (const e of pool.sort(() => rnd() - 0.5)) {
        if (rnd() < 0.85) steps.push(append(e));
        if (rnd() < 0.3 && steps.length > 0) {
          const labels = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(pool));
          steps.push(withdraw(...labels.map((p) => Buffer.from(p.eventId, 'hex').toString())));
        }
        if (rnd() < 0.15) steps.push(append(pick(pool))); // re-append a withdrawn / present entry
      }
      await runSteps(app, steps);
      try {
        await expectOracleModuloGhosts(app, steps, new Set(['p-never', ...signals.map((s) => s.rumor.id)]));
      } catch (err) {
        if (process.env.DEBUG_SLOT_SEED) {
          const oracle = await runOracle(steps, make);
          console.log(JSON.stringify(steps.map((st) => (st.op === 'append' ? ['+', Buffer.from(st.entry.eventId, 'hex').toString(), st.entry.rumor.id, st.entry.rumor.kind, st.entry.orderingKey.account.slice(0, 2), st.entry.rumor.pubkey.slice(0, 2), st.entry.rumor.tags.map((t) => t.join('|').slice(0, 22)), st.entry.rumor.created_at - T] : ['-', st.ids.map((i) => Buffer.from(i, 'hex').toString())]))));
          console.log('APP   ', JSON.stringify(await snapshot(app)));
          console.log('ORACLE', JSON.stringify(await snapshot(oracle)));
        }
        throw new Error(`oracle mismatch for seed ${seed}: ${(err as Error).message}`);
      }
    });
  }
});

// ─── (2) stacked edits ────────────────────────────────────────────────────────────────────────

describe('(2) stacked edits E1, E2', () => {
  const build = (app: RealApp): Step[] => [
    append(message(app)),
    append(edit(app, 'e1', 'm1', T, 'first')),
    append(edit(app, 'e2', 'm1', T + 10, 'second')),
  ];

  it.each([
    [['e2'], { content: 'first', edited: true }],
    [['e1'], { content: 'second', edited: true }],
    [['e2', 'e1'], { content: 'orig m1', edited: false }],
    [['e1', 'e2'], { content: 'orig m1', edited: false }],
  ] as const)('withdrawing %j ends at %j and equals the oracle', async (order, expected) => {
    const app = await converges(build);
    expect(await shown(app)).toEqual({ content: 'second', edited: true });
    const steps = [...build(app)];
    for (const label of order) {
      steps.push(withdraw(label));
      await app.sink.withdraw(app.groupId, ev(label));
      await expectOracle(app, steps, make);
    }
    expect(await shown(app)).toEqual(expected);
  });

  it('both withdrawn in ONE batch lands on the original too, and the slot carries no edit residue', async () => {
    const app = await converges(build);
    await app.sink.withdraw(app.groupId, ev('e1', 'e2'));
    const row = await rowOf(app);
    expect(row).toMatchObject({ content: 'orig m1' });
    expect(row?.edited).toBeUndefined();
    expect(row?.rev).toBeUndefined();
    expect(row?.original).toBeUndefined(); // cleared: the slot recomputed to no signals
    expect(await edits.snapshotMessageEditsState(app.groupId)).toEqual({ pending: [], markers: [], slotMeta: [], pins: [] });
  });

  it('the base is write-once: it is captured by the first signal and survives later ones', async () => {
    const app = await converges(build);
    expect((await rowOf(app))?.original).toEqual({ content: 'orig m1' });
  });
});

// ─── (3) edit + delete in both orders ─────────────────────────────────────────────────────────

describe('(3) edit and delete of one slot, both arrival orders, equal and higher rev', () => {
  const cases = [
    { name: 'edit then delete, equal rev', first: 'edit', second: 'del', delRev: T + 10 },
    { name: 'delete then edit, equal rev', first: 'del', second: 'edit', delRev: T + 10 },
    { name: 'edit then delete, delete higher', first: 'edit', second: 'del', delRev: T + 20 },
    { name: 'delete then edit, delete higher', first: 'del', second: 'edit', delRev: T + 20 },
  ];
  for (const c of cases) {
    const build = (app: RealApp): Step[] => {
      const e = edit(app, 'e1', 'm1', T + 10, 'changed');
      const d = del(app, 'd1', 'm1', c.delRev);
      return [append(message(app)), append(c.first === 'edit' ? e : d), append(c.second === 'edit' ? e : d)];
    };
    it(`${c.name}: the delete wins; withdrawn singly or in both orders, the oracle holds`, async () => {
      for (const order of [['e1'], ['d1'], ['e1', 'd1'], ['d1', 'e1']]) {
        const app = await converges(build);
        expect(await shown(app)).toBeNull(); // deleted
        const steps = [...build(app)];
        for (const label of order) {
          steps.push(withdraw(label));
          await app.sink.withdraw(app.groupId, ev(label));
          await expectOracle(app, steps, make);
        }
        if (order[0] === 'e1' && order.length === 1) expect(await shown(app)).toBeNull();
        if (order[0] === 'd1' && order.length === 1) expect(await shown(app)).toEqual({ content: 'changed', edited: true });
        if (order.length === 2) expect(await shown(app)).toEqual({ content: 'orig m1', edited: false });
      }
    });
  }

  it('an edit at a HIGHER rev than the delete revives the message; withdrawing the edit brings the delete back', async () => {
    const app = await converges((a) => [append(message(a)), append(del(a, 'd1', 'm1', T)), append(edit(a, 'e1', 'm1', T + 10, 'revived'))]);
    expect(await shown(app)).toEqual({ content: 'revived', edited: true });
    await app.sink.withdraw(app.groupId, ev('e1'));
    expect(await shown(app)).toBeNull();
    expect(await rowOf(app)).toMatchObject({ tombstoned: true, rev: T, content: 'orig m1' });
  });
});

// ─── (4) multi-e-tag delete ───────────────────────────────────────────────────────────────────

describe('(4) a multi-e-tag delete', () => {
  it('names the original and the prior replacement id: withdrawing it recomputes the original and leaves the rest', async () => {
    const app = await converges((a) => [
      append(message(a)),
      append(edit(a, 'e1', 'm1', T, 'first', { rumorId: 'rep-1' })),
      append(del(a, 'd1', ['m1', 'rep-1'], T + 10)),
    ]);
    expect(await shown(app)).toBeNull();
    await app.sink.withdraw(app.groupId, ev('d1'));
    expect(await shown(app)).toEqual({ content: 'first', edited: true });
    await expectOracle(app, [append(message(app)), append(edit(app, 'e1', 'm1', T, 'first', { rumorId: 'rep-1' })), append(del(app, 'd1', ['m1', 'rep-1'], T + 10)), withdraw('d1')], make);
  });

  it('recomputes EVERY named slot: the entries buffered for each named id go with the withdrawn delete', async () => {
    const app = await converges((a) => [append(del(a, 'd1', ['m1', 'rep-1'], T)), append(edit(a, 'e1', 'rep-1', T, 'on the replacement'))]);
    const aux = (await edits.snapshotMessageEditsState(app.groupId)) as { pending: { targetId: string; rumorId: string }[] };
    // one entry per (target, author): at the equal rev the delete beats the edit on the replacement id
    expect(aux.pending.map((p) => `${p.targetId}:${p.rumorId}`).sort()).toEqual(['m1:r-d1', 'rep-1:r-d1']);
    await app.sink.withdraw(app.groupId, ev('d1'));
    const after = (await edits.snapshotMessageEditsState(app.groupId)) as { pending: { targetId: string; rumorId: string }[] };
    expect(after.pending.map((p) => `${p.targetId}:${p.rumorId}`)).toEqual(['rep-1:r-e1']); // both delete entries are gone; the edit the delete had shadowed is held again
    await expectOracle(app, [append(del(app, 'd1', ['m1', 'rep-1'], T)), append(edit(app, 'e1', 'rep-1', T, 'on the replacement')), withdraw('d1')], make);
  });

  it('a delete naming a withdrawn slot AND a surviving one: only the named slots are touched', async () => {
    const app = await converges((a) => [
      append(message(a, 'eb1', 'm1')),
      append(message(a, 'eb2', 'm2')),
      append(del(a, 'd1', ['m1', 'rep-9'], T + 5)),
      append(del(a, 'd2', ['m2', 'rep-9'], T + 5)),
    ]);
    expect(await shown(app, 'm1')).toBeNull();
    expect(await shown(app, 'm2')).toBeNull();
    await app.sink.withdraw(app.groupId, ev('d1'));
    expect(await shown(app, 'm1')).toEqual({ content: 'orig m1', edited: false });
    expect(await shown(app, 'm2')).toBeNull(); // m2's delete survives untouched, though it shares an id with the withdrawn one
  });
});

// ─── (5) duplicate carriers ───────────────────────────────────────────────────────────────────

describe('(5) duplicate carriers of one rumor, both withdraw orders', () => {
  const sameRumor = (app: RealApp, kind: 'edit' | 'del', label: string) =>
    kind === 'edit' ? edit(app, label, 'm1', T, 'dup edit', { rumorId: 'dup' }) : del(app, label, 'm1', T, { rumorId: 'dup' });
  for (const kind of ['edit', 'del'] as const) {
    it.each([['c1', 'c2'], ['c2', 'c1']])(`${kind}: withdrawing %s then %s keeps the effect until the last carrier goes`, async (first, second) => {
      const app = make();
      const steps: Step[] = [append(message(app)), append(sameRumor(app, kind, 'c1')), append(sameRumor(app, kind, 'c2'))];
      await runSteps(app, steps);
      const applied = await shown(app);
      expect(applied).toEqual(kind === 'edit' ? { content: 'dup edit', edited: true } : null);
      steps.push(withdraw(first));
      await app.sink.withdraw(app.groupId, ev(first));
      await expectOracle(app, steps, make);
      expect(await shown(app)).toEqual(applied); // the other carrier still stands
      steps.push(withdraw(second));
      await app.sink.withdraw(app.groupId, ev(second));
      await expectOracle(app, steps, make);
      expect(await shown(app)).toEqual({ content: 'orig m1', edited: false });
    });
  }
});

// ─── (6) forged byte-identical copies ─────────────────────────────────────────────────────────

describe('(6) a forged byte-identical copy (victim V = ALICE owns the message, M = MALLORY forges)', () => {
  const real = (app: RealApp, kind: 'edit' | 'del') =>
    kind === 'edit' ? edit(app, 'v1', 'm1', T, 'victim edit') : del(app, 'v1', 'm1', T);
  for (const kind of ['edit', 'del'] as const) {
    for (const order of ['real first', 'forged first'] as const) {
      it(`${kind}, ${order}: withdrawing M's copy leaves V's effect; withdrawing V's leaves NOTHING attributed to V`, async () => {
        // M's copy is judged on its own: author gate fails on V's message (so it never applied), V's passes
        const build = (app: RealApp): Step[] => {
          const v = real(app, kind);
          const m = forged(app, v, 'f1');
          return [append(message(app)), ...(order === 'real first' ? [append(v), append(m)] : [append(m), append(v)])];
        };
        const expected = kind === 'edit' ? { content: 'victim edit', edited: true } : null;

        const a = await converges(build);
        expect(await shown(a)).toEqual(expected);
        await a.sink.withdraw(a.groupId, ev('f1'));
        await expectOracle(a, [...build(a), withdraw('f1')], make);
        expect(await shown(a)).toEqual(expected); // V intact

        const b = await converges(build);
        await b.sink.withdraw(b.groupId, ev('v1'));
        await expectOracle(b, [...build(b), withdraw('v1')], make);
        // M's copy now stands alone: it fails the author gate against V's message, so nothing is attributed to V
        expect(await shown(b)).toEqual({ content: 'orig m1', edited: false });
        expect((await rowOf(b))?.original).toBeUndefined();
        const state = (await edits.snapshotMessageEditsState(b.groupId)) as { slotMeta: unknown[] };
        expect(state.slotMeta).toEqual([]);
      });
    }
  }

  it('M owns the message: M\'s copy is judged as M\'s own and applies when V\'s copy is withdrawn', async () => {
    const build = (app: RealApp): Step[] => {
      const v = edit(app, 'v1', 'm1', T, 'claimed as victim');
      return [append(message(app, 'eb', 'm1', MALLORY)), append(v), append(forged(app, v, 'f1', MALLORY))];
    };
    const app = await converges(build);
    // V's copy fails the author gate against M's message; M's copy applies
    expect(await shown(app)).toEqual({ content: 'claimed as victim', edited: true });
    await app.sink.withdraw(app.groupId, ev('f1'));
    expect(await shown(app)).toEqual({ content: 'orig m1', edited: false });
    await expectOracle(app, [...build(app), withdraw('f1')], make);
  });

  it('a forged copy BEFORE its target arrives neither shadows nor is shadowed (pending entries are per author)', async () => {
    const build = (app: RealApp): Step[] => {
      const v = edit(app, 'v1', 'm1', T, 'victim edit');
      // forged copy at a HIGHER rev under another sender sits first in the pending buffer
      return [append(forged(app, edit(app, 'x', 'm1', T + 50, 'forger edit'), 'f1')), append(v), append(message(app))];
    };
    const app = await converges(build);
    expect(await shown(app)).toEqual({ content: 'victim edit', edited: true });
  });
});

// ─── (9) the base message ─────────────────────────────────────────────────────────────────────

describe('(9) the base message withdrawn', () => {
  const build = (app: RealApp): Step[] => [
    append(message(app)),
    append(edit(app, 'e1', 'm1', T, 'edited')),
    append(app.entry({ eventId: 'r1', kind: 7, account: BOB, rumorId: 'rx', content: '👍', tags: [['e', 'm1']], at: T })),
  ];

  it('last carrier withdrawn: no visible dependents (slot, reactions); the dependents stay held', async () => {
    const app = await converges(build);
    expect(await shown(app)).toEqual({ content: 'edited', edited: true });
    expect((await app.reactionRows()).filter((r) => !r.removed)).toHaveLength(1);
    await app.sink.withdraw(app.groupId, ev('eb'));
    await expectOracle(app, [...build(app), withdraw('eb')], make);
    expect(await rowOf(app)).toBeUndefined();
    expect((await app.reactionRows()).filter((r) => !r.removed)).toEqual([]);
    const aux = (await edits.snapshotMessageEditsState(app.groupId)) as { pending: { targetId: string }[] };
    expect(aux.pending.map((p) => p.targetId)).toEqual(['m1']); // the edit is held again
  });

  it('re-appending the base re-applies the surviving dependents', async () => {
    const app = await converges(build);
    await app.sink.withdraw(app.groupId, ev('eb'));
    await app.sink.append(message(app, 'eb2'));
    const steps = [...build(app), withdraw('eb'), append(message(app, 'eb2'))];
    await expectOracle(app, steps, make);
    expect(await shown(app)).toEqual({ content: 'edited', edited: true });
    expect((await app.reactionRows()).filter((r) => !r.removed)).toHaveLength(1);
  });

  it('a duplicate carrier keeps the base and its dependents; the last one takes them away', async () => {
    const app = make();
    const steps: Step[] = [...build(app), append(message(app, 'eb-dup'))];
    await runSteps(app, steps);
    await app.sink.withdraw(app.groupId, ev('eb'));
    expect(await shown(app)).toEqual({ content: 'edited', edited: true });
    await app.sink.withdraw(app.groupId, ev('eb-dup'));
    await expectOracle(app, [...steps, withdraw('eb'), withdraw('eb-dup')], make);
    expect(await rowOf(app)).toBeUndefined();
  });
});

// ─── (10) batch ───────────────────────────────────────────────────────────────────────────────

describe('(10) a batch withdraw folds no intermediate state', () => {
  it('[e1, e2] of one slot: every recompute of the batch sees neither signal', async () => {
    const spy = vi.spyOn(edits, 'recomputeSlot');
    const app = make();
    const steps: Step[] = [
      append(message(app)),
      append(edit(app, 'e1', 'm1', T, 'first')),
      append(edit(app, 'e2', 'm1', T + 10, 'second')),
      append(edit(app, 'e3', 'm1', T + 5, 'third')),
    ];
    await runSteps(app, steps);
    await app.sink.withdraw(app.groupId, ev('e1', 'e2'));
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [, , signals] of spy.mock.calls) {
      expect(signals.map((s) => s.rumor.id)).toEqual(['r-e3']);
    }
    await expectOracle(app, [...steps, withdraw('e1', 'e2')], make);
    expect(await shown(app)).toEqual({ content: 'third', edited: true });
  });
});

// ─── (13) no effects, no fold when purged ─────────────────────────────────────────────────────

describe('(13) the recompute emits no effects; purged does no fold', () => {
  it('a withdrawn peer edit / delete changes no unread, known peers, announcements or client jobs', async () => {
    const app = make();
    await runSteps(app, [
      append(message(app, 'eb', 'm1', SELF)),
      append(edit(app, 'e1', 'm1', T, 'mine', { account: SELF })),
      append(app.entry({ eventId: 'o1', account: BOB, rumorId: 'other', content: 'x', at: T })),
    ]);
    const unread = unreadOf(app.groupId);
    const known = isKnownPeer(MALLORY);
    const sends = [app.spies.sendAnnouncement.mock.calls.length, app.spies.sendSelfProfile.mock.calls.length, app.spies.notifyProfileObserved.mock.calls.length];
    const bumpedChat = app.versions.chat;
    await app.sink.append(del(app, 'd1', 'other', T + 5, { account: BOB }));
    await app.sink.append(edit(app, 'e2', 'other', T + 6, 'by mallory', { account: MALLORY, pubkey: BOB }));
    await app.sink.withdraw(app.groupId, ev('d1', 'e2', 'e1'));
    expect(unreadOf(app.groupId)).toBe(unread);
    expect(isKnownPeer(MALLORY)).toBe(known);
    expect([app.spies.sendAnnouncement.mock.calls.length, app.spies.sendSelfProfile.mock.calls.length, app.spies.notifyProfileObserved.mock.calls.length]).toEqual(sends);
    expect(app.jobs).toHaveLength(0);
    expect(app.versions.chat).toBeGreaterThan(bumpedChat); // the UI re-reads
  });

  it('a purged retract of a delete / edit recomputes nothing', async () => {
    const spy = vi.spyOn(edits, 'recomputeSlot');
    const app = make();
    const e = edit(app, 'e1', 'm1', T, 'x');
    const d = del(app, 'd1', 'm1', T);
    for (const entry of [e, d]) {
      await app.dispatcher.retract({
        groupId: app.groupId,
        eventId: entry.eventId,
        rumor: entry.rumor,
        sender: entry.orderingKey.account,
        reason: 'purged',
        remaining: async () => {
          throw new Error('a purged retract must not read history');
        },
      });
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── (14) twice / unseen ──────────────────────────────────────────────────────────────────────

describe('(14) retract twice / an unseen id', () => {
  it('changes nothing the second time, nor for an event id the sink never saw', async () => {
    const app = make();
    const steps: Step[] = [append(message(app)), append(edit(app, 'e1', 'm1', T, 'x')), append(edit(app, 'e2', 'm1', T + 1, 'y'))];
    await runSteps(app, steps);
    await app.sink.withdraw(app.groupId, ev('e2'));
    const once = await snapshot(app);
    await app.sink.withdraw(app.groupId, ev('e2'));
    await app.sink.withdraw(app.groupId, ev('never-seen'));
    expect(await snapshot(app)).toEqual(once);
    await expectOracle(app, [...steps, withdraw('e2')], make);
  });

  it('recomputeSlot itself is idempotent and ignores signals naming other slots', async () => {
    const app = make();
    await runSteps(app, [append(message(app)), append(edit(app, 'e1', 'm1', T, 'x'))]);
    const before = await snapshot(app);
    const signal = (await (app.sink.list(app.groupId))).filter((e) => e.eventId === ev('e1')[0]);
    const signals = signal.map((e, i) => ({ rumor: e.rumor as never, sender: e.orderingKey.account, eventId: e.eventId, seq: i, receivedAt: Date.now() }));
    const thread = { kind: 'group' as const, groupId: app.groupId };
    await edits.recomputeSlot(thread, ['m1'], signals);
    await edits.recomputeSlot(thread, ['m1'], signals);
    await edits.recomputeSlot(thread, ['unrelated'], signals);
    expect(await snapshot(app)).toEqual(before);
  });
});

// ─── (15) clock determinism ───────────────────────────────────────────────────────────────────

describe('(15) the fold runs on the rows\' own receipt clock, never the wall clock', () => {
  const HOUR = 3600;

  it('an edit that passed the skew gate at receipt still applies when the wall clock has gone BACK', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T * 1000 });
    const app = make();
    // rev = receipt + 5h: inside the 6h skew allowance at receipt
    await runSteps(app, [
      append(message(app)),
      append(edit(app, 'e1', 'm1', T + 5 * HOUR, 'late edit')),
      append(edit(app, 'e2', 'm1', T + HOUR, 'other')),
    ]);
    expect((await rowOf(app))?.rev).toBe(T + 5 * HOUR);
    vi.setSystemTime((T - 10 * HOUR) * 1000); // a wall clock whose cap would be T - 4h
    await app.sink.withdraw(app.groupId, ev('e2'));
    expect(await rowOf(app)).toMatchObject({ content: 'late edit', rev: T + 5 * HOUR });
  });

  it('an edit capped at receipt keeps that rev when the recompute runs under a later wall clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T * 1000 });
    const app = make();
    await runSteps(app, [
      append(message(app)),
      append(edit(app, 'e1', 'm1', T + 10 * HOUR, 'far future')), // capped to T + 6h at receipt
      append(edit(app, 'e2', 'm1', T + HOUR, 'other')),
    ]);
    expect((await rowOf(app))?.rev).toBe(T + 6 * HOUR);
    vi.setSystemTime((T + 24 * HOUR) * 1000); // a later clock would let the raw rev through
    await app.sink.withdraw(app.groupId, ev('e2'));
    expect(await rowOf(app)).toMatchObject({ content: 'far future', rev: T + 6 * HOUR });
    // its pin is the receipt-derived one (the withdrawn rumor's pin is gone, this one was re-derived)
    const state = (await edits.snapshotMessageEditsState(app.groupId)) as { pins: { rumorId: string; rev: number }[] };
    expect(state.pins).toEqual([expect.objectContaining({ rumorId: 'r-e1', rev: T + 6 * HOUR })]);
  });

  it('the pin of a withdrawn rumor does not survive it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T * 1000 });
    const app = make();
    await runSteps(app, [append(message(app)), append(edit(app, 'e1', 'm1', T + 10 * HOUR, 'far future'))]);
    expect(((await edits.snapshotMessageEditsState(app.groupId)) as { pins: unknown[] }).pins).toHaveLength(1);
    await app.sink.withdraw(app.groupId, ev('e1'));
    expect(((await edits.snapshotMessageEditsState(app.groupId)) as { pins: unknown[] }).pins).toEqual([]);
  });
});
