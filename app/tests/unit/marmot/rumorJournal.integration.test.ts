/**
 * Write-ahead rumor journal — integration
 * (bug: mls-message-lost-on-unload-after-ingest, VQ-2/VQ-3).
 *
 * Real EpochResolver + real rumorJournal + real dispatcher, over a stub
 * MarmotGroup whose ingest generator mirrors marmot-group.js: yield the
 * processed application message, THEN emit authenticatedApplicationMessage,
 * THEN persist the advanced state via store.setItem. idb-keyval is a Map mock
 * whose writes complete on a later macrotask, so an un-awaited journal put
 * would lose the race against the state put.
 *
 * The second test simulates the reported loss: the page "unloads" after the
 * state put but before the dispatcher's handlers ran. The next session's
 * replay must deliver the rumor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stores, writeLog } = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  writeLog: [] as string[],
}));
const later = () => new Promise((r) => setTimeout(r, 3));

vi.mock('idb-keyval', async (importOriginal) => {
  const { callableMapStore } = await import('../helpers/callableMapStore');
  return {
  promisifyRequest: (await importOriginal<typeof import('idb-keyval')>()).promisifyRequest,
  createStore: vi.fn((db: string) => {
    // Map for the mocked ops; as a store callback (putRumor's one-transaction
    // read-merge-put) its commit is logged like a slow set().
    const m = callableMapStore(new Map<string, unknown>(), {
      onCommit: async (keys) => {
        await later();
        for (const k of keys) writeLog.push(`${db}:${k}`);
      },
    });
    stores.set(db, m);
    return m;
  }),
  get: vi.fn(async (k: string, s: Map<string, unknown>) => s.get(k)),
  set: vi.fn(async (k: string, v: unknown, s: Map<string, unknown>) => {
    await later();
    const db = [...stores.entries()].find(([, m]) => m === s)?.[0];
    writeLog.push(`${db}:${k}`);
    s.set(k, v);
  }),
  del: vi.fn(async (k: string, s: Map<string, unknown>) => { s.delete(k); }),
  delMany: vi.fn(async (ks: string[], s: Map<string, unknown>) => { ks.forEach((k) => s.delete(k)); }),
  keys: vi.fn(async (s: Map<string, unknown>) => [...s.keys()]),
  entries: vi.fn(async (s: Map<string, unknown>) => [...s.entries()]),
  clear: vi.fn(async (s: Map<string, unknown>) => { s.clear(); }),
};
});

vi.mock('@internet-privacy/marmot-ts', () => ({
  serializeClientState: vi.fn(() => new Uint8Array(4)),
  deserializeClientState: vi.fn(() => ({ _epoch: 1 })),
  getEpoch: vi.fn(() => 1),
  getGroupMembers: vi.fn(() => []),
  deserializeApplicationData: vi.fn((d: Uint8Array) => JSON.parse(new TextDecoder().decode(d))),
  getPubkeyLeafNodes: vi.fn(() => []),
}));

const { createStore, set } = await import('idb-keyval');
const { EpochResolver } = await import('@/src/lib/marmot/epochResolver');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const journal = await import('@/src/lib/marmot/rumorJournal');

const SENDER = 'ef'.repeat(32);
const GROUP = 'group-int';
const stateStore = createStore('test-groups-state', 'state');

function rumorBytes(id: string) {
  return new TextEncoder().encode(JSON.stringify({ id, pubkey: SENDER, kind: 9, created_at: 1, tags: [], content: `hi ${id}` }));
}

/** Stub mirroring marmot-group.js: yield → emit → store.setItem (save). */
function makeStubGroup(rumorId: string) {
  const listeners = new Map<string, (p: unknown) => unknown>();
  const data = rumorBytes(rumorId);
  return {
    state: { _epoch: 1 } as never,
    on: (e: string, fn: (p: unknown) => unknown) => { listeners.set(e, fn); },
    off: (e: string) => { listeners.delete(e); },
    save: vi.fn(),
    ingest: async function* (events: Array<{ id: string }>) {
      yield {
        kind: 'processed',
        result: { kind: 'applicationMessage', message: data, senderLeafIndex: 0 },
        event: events[0],
        senderPubkey: SENDER,
      } as never;
      listeners.get('authenticatedApplicationMessage')?.({ message: data, senderPubkey: SENDER, senderLeafIndex: 0 });
      await set(GROUP, { epoch: 2 }, stateStore); // the MLS state save
    },
  };
}

const ev = (id: string) => ({ id, pubkey: 'p', created_at: 1, kind: 445, tags: [], content: '', sig: '' });
const ctx = { groupId: GROUP, selfPubkeyHex: 'aa'.repeat(32), getActiveGroupId: () => null };

beforeEach(async () => {
  writeLog.length = 0;
  for (const m of stores.values()) m.clear();
});

describe('journal put strictly precedes the MLS state put', () => {
  it('records few-rumor-journal before the group-state write', async () => {
    const group = makeStubGroup('r1');
    const resolver = new EpochResolver(group as never, {
      onApplicationMessage: journal.createApplicationMessageJournaler(GROUP),
    });
    await resolver.ingestEvent(ev('evt-1'));
    expect(writeLog).toEqual([`few-rumor-journal:${GROUP}:r1`, `test-groups-state:${GROUP}`]);
    resolver.dispose();
  });
});

describe('unload between state save and handlers → next session replays the rumor', () => {
  it('delivers the journaled rumor exactly once in the next session, then acks it', async () => {
    // Session 1: dispatcher handler never completes before "unload".
    const group1 = makeStubGroup('lost-1');
    const neverFinishes = { kind: 9, handle: vi.fn(() => new Promise<void>(() => {})) };
    createDispatcher([neverFinishes], { journal: { ack: journal.ackRumor } }).subscribe(group1 as never, ctx);
    const resolver1 = new EpochResolver(group1 as never, {
      onApplicationMessage: journal.createApplicationMessageJournaler(GROUP),
    });
    await resolver1.ingestEvent(ev('evt-lost'));
    expect(writeLog).toContain(`test-groups-state:${GROUP}`); // ratchet advanced & persisted
    resolver1.dispose();
    // --- unload: session 1's in-memory queue is gone ---

    // Session 2: subscribe, replay pending entries before any live ingest.
    const group2 = makeStubGroup('unused');
    const delivered: string[] = [];
    const handler = { kind: 9, handle: vi.fn((r: { id: string; content: string }) => { delivered.push(r.content); }) };
    const sub2 = createDispatcher([handler], { journal: { ack: journal.ackRumor } }).subscribe(group2 as never, ctx);
    const pending = await journal.listPendingRumors(GROUP);
    expect(pending.map((p) => p.rumorId)).toEqual(['lost-1']);
    await sub2.replay(pending);

    expect(delivered).toEqual(['hi lost-1']);
    expect(handler.handle.mock.calls[0][2]).toEqual({ pubkey: SENDER, authenticity: 'mls' });
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
  });
});
