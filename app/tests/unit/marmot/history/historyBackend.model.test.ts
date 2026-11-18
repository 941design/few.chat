/**
 * Model-based randomized test of the sink (Order-Sensitive Composition #1
 * guarantees a-d). A seeded PRNG drives random sequences of append / replay /
 * withdraw / purge / sweep / restart with injected handler failures, against a trivial
 * in-memory model of what the rows and the app store must look like. After
 * every operation the real backend (real row store over a Map-mocked idb) must
 * agree with the model, whatever the redelivery count or interleaving:
 *
 *   (a) handler effects are applied once in effect (the fixture app store holds
 *       exactly the effects of dispatched, non-withdrawn rows);
 *   (b) rows left undispatched by a failure are completed by a later re-append of the
 *       same id, or recovered (seq order, once per group per instance, first touch or
 *       sweep) after a restart; a row is abandoned after 5 failed recoveries;
 *   (c) withdraw leaves no trace; withdraw of an unknown id is a no-op;
 *   (d) list is per-group seq order, seq strictly increasing and never reused.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';

const { dbs } = vi.hoisted(() => ({ dbs: new Map<string, Map<string, unknown>>() }));
const mapOf = (db: string) => {
  let m = dbs.get(db);
  if (!m) dbs.set(db, (m = new Map()));
  return m;
};
vi.mock('idb-keyval', async () => {
  const { mapUseStore } = await import('./mapIdbStore');
  return {
  createStore: (db: string) => mapUseStore(mapOf(db)),
  get: async (k: string, s: MapUseStore) => (s.map.has(k) ? structuredClone(s.map.get(k)) : undefined),
  set: async (k: string, v: unknown, s: MapUseStore) => void s.map.set(k, structuredClone(v)),
  del: async (k: string, s: MapUseStore) => void s.map.delete(k),
  delMany: async (ks: string[], s: MapUseStore) => void ks.forEach((k) => s.map.delete(k)),
  keys: async (s: MapUseStore) => [...s.map.keys()],
  entries: async (s: MapUseStore) => [...s.map.entries()].map(([k, v]) => [k, structuredClone(v)]),
  };
});

import type { MapUseStore } from './mapIdbStore';
import { createHistoryBackend, createIdbHistoryStore } from '@/src/lib/marmot/history';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const GROUPS = ['a1', 'a2', 'a3'];
const IDS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
const ACCOUNT = 'aa'.repeat(32);

const mk = (groupId: string, eventId: string, kind: number): HistoryEntry => ({
  groupId,
  eventId,
  rumor: { id: `r-${groupId}-${eventId}`, pubkey: ACCOUNT, created_at: 1, kind, tags: [], content: eventId },
  orderingKey: { account: ACCOUNT, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
});

interface ModelRow {
  seq: number;
  dispatched: boolean;
  kind: number;
  fails: number;
  abandoned: boolean;
}

async function runScenario(seed: number): Promise<void> {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const dbName = `model-${seed}`;
  mapOf(dbName).clear();
  const store = createIdbHistoryStore(dbName);

  const applied = new Set<string>(); // `${g}:${e}` effects in the fixture app store
  let failing = new Set<string>(); // event keys whose dispatch throws during the current op
  const handlers = {
    async dispatch(i: { groupId: string; eventId: string }) {
      if (failing.has(`${i.groupId}:${i.eventId}`)) throw new Error('injected');
      applied.add(`${i.groupId}:${i.eventId}`);
    },
    async retract(i: { groupId: string; eventId: string }) {
      applied.delete(`${i.groupId}:${i.eventId}`);
    },
  };
  let sink = createHistoryBackend({ handlers, store, onError: () => undefined });
  const touched = new Set<string>(); // groups this sink instance already recovered

  const rows = new Map<string, Map<string, ModelRow>>(GROUPS.map((g) => [g, new Map()]));
  const counters = new Map<string, number>(GROUPS.map((g) => [g, 0]));
  const modelApplied = new Set<string>(); // what the app store must hold according to the model
  const registered = (k: number) => [0, 5, 7, 9, 10, 11, 12, 30].includes(k);
  const kindOf = new Map<string, number>(); // a given event always carries the same kind

  const complete = (g: string, e: string, r: ModelRow) => {
    if (registered(r.kind)) {
      if (failing.has(`${g}:${e}`)) return false;
      modelApplied.add(`${g}:${e}`);
    }
    r.dispatched = true;
    return true;
  };

  /** First-touch recovery of the group (once per instance), in seq order; failures are counted, 5 abandon. */
  const recover = (g: string) => {
    if (touched.has(g)) return;
    touched.add(g);
    const pending = [...rows.get(g)!.entries()]
      .filter(([, r]) => !r.dispatched && !r.abandoned)
      .sort((a, b) => a[1].seq - b[1].seq);
    for (const [id, r] of pending) {
      if (complete(g, id, r)) continue;
      r.fails += 1;
      if (r.fails >= 5) r.abandoned = true;
    }
  };

  for (let step = 0; step < 40; step++) {
    const g = pick(GROUPS);
    const e = pick(IDS);
    const op = pick(['append', 'append', 'append', 'withdraw', 'sweep', 'purge', 'restart'] as const);
    failing = new Set(rand() < 0.3 ? [`${g}:${e}`, `${pick(GROUPS)}:${pick(IDS)}`] : []);
    const key = `${g}:${e}`;
    if (!kindOf.has(key)) kindOf.set(key, pick([9, 7, 10, 14, 1059]));
    const kind = kindOf.get(key)!;

    if (op === 'append') {
      recover(g);
      let rejected = false;
      await sink.append(mk(g, e, kind)).catch(() => (rejected = true));
      const group = rows.get(g)!;
      let r = group.get(e);
      if (!r) {
        const seq = (counters.get(g) ?? 0) + 1;
        counters.set(g, seq);
        r = { seq, dispatched: false, kind, fails: 0, abandoned: false };
        group.set(e, r);
        if (!registered(kind)) r.dispatched = true;
        else complete(g, e, r);
      } else if (!r.dispatched) complete(g, e, r);
      expect(rejected, `seed ${seed} step ${step} append ${key}`).toBe(registered(kind) && !r.dispatched);
    } else if (op === 'withdraw') {
      const ids = [e, pick(IDS)];
      await sink.withdraw(g, ids);
      let matched = false;
      for (const id of new Set(ids)) {
        const r = rows.get(g)!.get(id);
        if (!r) continue;
        matched = true;
        if (registered(r.kind)) modelApplied.delete(`${g}:${id}`);
        rows.get(g)!.delete(id);
      }
      if (matched) recover(g);
    } else if (op === 'purge') {
      await sink.purge(g);
      rows.get(g)!.clear();
      counters.set(g, 0);
      // purge is teardown: effects stay (the app clears its own stores separately)
    } else if (op === 'restart') {
      // a reload: a new sink over the same persisted store; nothing is touched yet
      sink = createHistoryBackend({ handlers, store, onError: () => undefined });
      touched.clear();
    } else {
      await sink.sweep();
      for (const gg of [...GROUPS].sort()) {
        if (rows.get(gg)!.size && [...rows.get(gg)!.values()].some((r) => !r.dispatched && !r.abandoned)) recover(gg);
      }
    }

    // invariants after every op
    expect([...applied].sort(), `seed ${seed} step ${step} app store`).toEqual([...modelApplied].sort());
    for (const gg of GROUPS) {
      const expected = [...rows.get(gg)!.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([id]) => id);
      const listed = (await sink.list(gg)).map((x) => x.eventId);
      expect(listed, `seed ${seed} step ${step} list ${gg}`).toEqual(expected);
      const stored = await store.listRows(gg);
      expect(stored.map((r) => [r.entry.eventId, r.seq, r.dispatched]), `seed ${seed} step ${step} rows ${gg}`).toEqual(
        [...rows.get(gg)!.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([id, r]) => [id, r.seq, r.dispatched]),
      );
    }
    failing = new Set();
  }
}

describe('history sink model (seeded)', () => {
  it('agrees with the model over 150 random operation sequences', async () => {
    for (let seed = 1; seed <= 150; seed++) await runScenario(seed);
  }, 30_000);
});
