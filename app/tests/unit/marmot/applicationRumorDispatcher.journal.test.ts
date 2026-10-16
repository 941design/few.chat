/**
 * applicationRumorDispatcher — write-ahead rumor journal integration
 * (bug: mls-message-lost-on-unload-after-ingest, VQ-3).
 *
 *  - journal.ack(groupId, rumorId) runs at the END of the queued block, after
 *    every matching handler — and only when every one of them completed
 *    (bug: journal-ack-before-durable-side-effects): a handler that throws, or
 *    a fan-out cut short by disposal, leaves the entry journaled for replay.
 *  - replay(entries) feeds journaled rumors through the IDENTICAL listener
 *    (sender choke point, LRU dedup, handlers), ahead of later live rumors, and
 *    a replayed id suppresses its live duplicate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
}));

const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);

function rumorBytes(id: string, pubkey = A, kind = 9) {
  return new TextEncoder().encode(JSON.stringify({ id, pubkey, kind, created_at: 1, tags: [], content: id }));
}

function makeFakeGroup() {
  const listeners = new Map<string, (p: never) => unknown>();
  return {
    on: vi.fn((e: string, fn: (p: never) => unknown) => { listeners.set(e, fn); }),
    off: vi.fn((e: string) => { listeners.delete(e); }),
    emit: (id: string, pubkey = A, kind = 9) =>
      listeners.get('authenticatedApplicationMessage')?.({ message: rumorBytes(id, pubkey, kind), senderPubkey: pubkey, senderLeafIndex: 0 } as never),
  };
}

const ctx = { groupId: 'G1', selfPubkeyHex: B, getActiveGroupId: () => null };

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeJournal(log: string[]) {
  return { ack: vi.fn(async (g: string, id: string) => { log.push(`ack:${g}:${id}`); }) };
}

describe('dispatcher journal.ack', () => {
  it('acks after all matching handlers have finished', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const slow = { kind: 9, handle: vi.fn(async (r: { id: string }) => { await new Promise((res) => setTimeout(res, 5)); log.push(`h1:${r.id}`); }) };
    const second = { kind: 9, handle: vi.fn((r: { id: string }) => { log.push(`h2:${r.id}`); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([slow, second], { journal }).subscribe(group, ctx);

    group.emit('m1');
    await sub.drain();

    expect(log).toEqual(['h1:m1', 'h2:m1', 'ack:G1:m1']);
  });

  it('does NOT ack when a handler throws (its durable side effect failed); the other handlers still run and the queue keeps going', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const boom = { kind: 9, handle: vi.fn(async (r: { id: string }) => { if (r.id === 'm1') throw new Error('boom'); }) };
    const ok = { kind: 9, handle: vi.fn((r: { id: string }) => { log.push(`ok:${r.id}`); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom, ok], { journal }).subscribe(group, ctx);

    group.emit('m1');
    group.emit('m2');
    await sub.drain();

    expect(log).toEqual(['ok:m1', 'ok:m2', 'ack:G1:m2']);
    expect(warn).toHaveBeenCalledWith('[dispatcher.9]', expect.any(Error));
  });

  it('a synchronously throwing handler is a failure too (not acked)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const boom = { kind: 9, handle: vi.fn(() => { throw new Error('sync'); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom], { journal }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('a duplicate of a FAILED rumor is neither handled again nor acks the kept entry (outer and inner dedup paths)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const boom = { kind: 9, handle: vi.fn(async () => { throw new Error('boom'); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom], { journal }).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m1'); // queued before the original ran (inner isSeen path)
    await sub.drain();
    group.emit('m1'); // after it failed (outer isSeen path)
    await sub.drain();
    expect(boom.handle).toHaveBeenCalledTimes(1);
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('a failed rumor is replayed by the next subscription and acked once its handlers complete (idempotent retry)', async () => {
    const entries = new Map<string, { data: Uint8Array; senderPubkey: string }>();
    const journal = { ack: vi.fn(async (g: string, id: string) => { entries.delete(`${g}:${id}`); }) };
    let fail = true;
    const applied: string[] = [];
    const handler = { kind: 9, handle: vi.fn(async (r: { id: string }) => { if (fail) throw new Error('idb write failed'); applied.push(r.id); }) };

    const first = createDispatcher([handler], { journal }).subscribe(makeFakeGroup(), ctx);
    entries.set('G1:m1', { data: rumorBytes('m1'), senderPubkey: A });
    await first.replay([...entries.values()]);
    expect(entries.has('G1:m1')).toBe(true);
    first();

    fail = false;
    const next = createDispatcher([handler], { journal }).subscribe(makeFakeGroup(), ctx);
    await next.replay([...entries.values()]);
    expect(applied).toEqual(['m1']);
    expect(entries.size).toBe(0);
  });

  it('acks a rumor whose kind has no handler', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const group = makeFakeGroup();
    const sub = createDispatcher([], { journal }).subscribe(group, ctx);
    group.emit('m1', A, 4242);
    await sub.drain();
    expect(log).toEqual(['ack:G1:m1']);
  });

  it('a failing ack is warned about and never breaks the queue', async () => {
    const handled: string[] = [];
    const journal = { ack: vi.fn(async () => { throw new Error('idb gone'); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([{ kind: 9, handle: (r: { id: string }) => { handled.push(r.id); } }], { journal }).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m2');
    await sub.drain();
    expect(handled).toEqual(['m1', 'm2']);
    expect(journal.ack).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[dispatcher.journalAck]', expect.any(Error));
  });

  it('a synchronously throwing ack is also contained', async () => {
    const handled: string[] = [];
    const journal = { ack: vi.fn(() => { throw new Error('sync'); }) as unknown as (g: string, id: string) => Promise<void> };
    const group = makeFakeGroup();
    const sub = createDispatcher([{ kind: 9, handle: (r: { id: string }) => { handled.push(r.id); } }], { journal }).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m2');
    await sub.drain();
    expect(handled).toEqual(['m1', 'm2']);
  });

  it('a live duplicate of an in-flight rumor never acks before the original handlers finish', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const slow = { kind: 9, handle: vi.fn(async (r: { id: string }) => { await new Promise((res) => setTimeout(res, 5)); log.push(`h:${r.id}`); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([slow], { journal }).subscribe(group, ctx);

    group.emit('m1');
    await new Promise((r) => setTimeout(r, 0)); // original is now in its handler
    group.emit('m1'); // duplicate (outer isSeen path)
    await sub.drain();

    expect(slow.handle).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['h:m1', 'ack:G1:m1', 'ack:G1:m1']);
  });

  it('disposal mid-fan-out stops the remaining handlers and does NOT ack (the entry replays; handlers are idempotent)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    let sub: ReturnType<ReturnType<typeof createDispatcher>['subscribe']>;
    const first = { kind: 9, handle: vi.fn(() => { log.push('h1'); sub(); }) };
    const second = { kind: 9, handle: vi.fn(() => { log.push('h2'); }) };
    const group = makeFakeGroup();
    sub = createDispatcher([first, second], { journal }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(log).toEqual(['h1']);
  });

  it('disposal while the LAST handler runs: the fan-out completed, so it is acked', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    let sub: ReturnType<ReturnType<typeof createDispatcher>['subscribe']>;
    const only = { kind: 9, handle: vi.fn(() => { log.push('h1'); sub(); }) };
    const group = makeFakeGroup();
    sub = createDispatcher([only], { journal }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(log).toEqual(['h1', 'ack:G1:m1']);
  });

  it('a duplicate queued before the original ran (inner isSeen path) is acked, handlers run once', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const h = { kind: 9, handle: vi.fn((r: { id: string }) => { log.push(`h:${r.id}`); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([h], { journal }).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m1'); // both pass the outer check synchronously
    await sub.drain();
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['h:m1', 'ack:G1:m1', 'ack:G1:m1']);
  });

  it('work skipped because the subscription was disposed is NOT acked (it replays next session)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h], { journal }).subscribe(group, ctx);
    group.emit('m1');
    sub(); // dispose before the queued block runs
    await sub.drain();
    await settle();
    expect(h.handle).not.toHaveBeenCalled();
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('work of a kind WITHOUT handlers skipped because of disposal is not acked either (not started ≠ completed)', async () => {
    const journal = makeJournal([]);
    const group = makeFakeGroup();
    const sub = createDispatcher([], { journal }).subscribe(group, ctx);
    group.emit('m1', A, 4242);
    sub();
    await sub.drain();
    await settle();
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('a sender-mismatched rumor is never acked (cannot delete another sender\'s entry)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h], { journal }).subscribe(group, ctx);
    sub.replay([{ data: rumorBytes('m1', A), senderPubkey: B }]);
    await sub.drain();
    expect(h.handle).not.toHaveBeenCalled();
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('without a journal option nothing is acked and dispatch is unchanged', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m1');
    await sub.drain();
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('dispatcher replay', () => {
  it('feeds entries through the same listener: handlers get the MLS-authenticated sender', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    await sub.replay([{ data: rumorBytes('r1', A), senderPubkey: A }]);
    expect(h.handle).toHaveBeenCalledTimes(1);
    const [rumor, gotCtx, sender] = h.handle.mock.calls[0];
    expect(rumor).toMatchObject({ id: 'r1', pubkey: A });
    expect(gotCtx).toBe(ctx);
    expect(sender).toEqual({ pubkey: A, authenticity: 'mls' });
  });

  it('replayed rumors run before live rumors that arrive afterwards, in journal order', async () => {
    const order: string[] = [];
    const h = { kind: 9, handle: vi.fn(async (r: { id: string }) => { await new Promise((res) => setTimeout(res, 2)); order.push(r.id); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    void sub.replay([
      { data: rumorBytes('r1'), senderPubkey: A },
      { data: rumorBytes('r2'), senderPubkey: A },
    ]);
    group.emit('live1');
    await sub.drain();
    expect(order).toEqual(['r1', 'r2', 'live1']);
  });

  it('a replayed id suppresses its live duplicate (and both are acked)', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    const h = { kind: 9, handle: vi.fn((r: { id: string }) => { log.push(`h:${r.id}`); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([h], { journal }).subscribe(group, ctx);
    void sub.replay([{ data: rumorBytes('x'), senderPubkey: A }]);
    group.emit('x');
    await sub.drain();
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(log[0]).toBe('h:x');
    expect(log.slice(1)).toEqual(['ack:G1:x', 'ack:G1:x']);
  });

  it('a replay larger than the dedup LRU keeps every replayed id deduped: a live duplicate of the FIRST replayed rumor is not handled again (bug: rumor-journal-cap-evicts-unapplied)', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    const N = 1500;
    void sub.replay(Array.from({ length: N }, (_, i) => ({ data: rumorBytes(`r${i}`), senderPubkey: A })));
    group.emit('r0'); // live redelivery of the oldest replayed rumor
    group.emit('live1');
    await sub.drain();
    expect(h.handle).toHaveBeenCalledTimes(N + 1);
    expect(h.handle.mock.calls.filter(([r]) => (r as { id: string }).id === 'r0')).toHaveLength(1);
  });

  it('the widened dedup window stays bounded: after a large replay, ordinary live traffic still evicts the oldest ids', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    void sub.replay(Array.from({ length: 1200 }, (_, i) => ({ data: rumorBytes(`r${i}`), senderPubkey: A })));
    await sub.drain();
    // 1000 (base cap) + 1200 (replay) = 2200 retained ids; push 2200 more live ids.
    for (let i = 0; i < 2200; i++) group.emit(`l${i}`);
    await sub.drain();
    h.handle.mockClear();
    group.emit('r0'); // evicted long ago → handled again (bounded memory)
    group.emit('l2199'); // still in the window → deduped
    await sub.drain();
    expect(h.handle.mock.calls.map(([r]) => (r as { id: string }).id)).toEqual(['r0']);
  });

  it('replay is a no-op after disposal; malformed entries are skipped', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    await sub.replay([{ data: new TextEncoder().encode('{not json'), senderPubkey: A }, { data: rumorBytes('ok'), senderPubkey: A }]);
    expect(h.handle).toHaveBeenCalledTimes(1);
    sub();
    await sub.replay([{ data: rumorBytes('late'), senderPubkey: A }]);
    expect(h.handle).toHaveBeenCalledTimes(1);
  });

  it('drain() covers replayed work', async () => {
    let done = false;
    const h = { kind: 9, handle: vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); done = true; }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    void sub.replay([{ data: rumorBytes('r1'), senderPubkey: A }]);
    await sub.drain();
    expect(done).toBe(true);
  });
});

describe('re-subscribe after disposal (MarmotContext awaits the old drain before replay)', () => {
  it('a rumor whose handler was running at disposal is handled exactly once in total; a not-yet-started one is replayed once', async () => {
    // In-memory journal: entries keyed like rumorJournal, ack deletes.
    const entries = new Map<string, { data: Uint8Array; senderPubkey: string }>();
    const journal = { ack: vi.fn(async (g: string, id: string) => { entries.delete(`${g}:${id}`); }) };
    const handled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handler = {
      kind: 9,
      handle: vi.fn(async (r: { id: string }) => {
        handled.push(r.id);
        if (r.id === 'm1') await gate;
      }),
    };

    const group1 = makeFakeGroup();
    const old = createDispatcher([handler], { journal }).subscribe(group1, ctx);
    for (const id of ['m1', 'm2']) {
      entries.set(`G1:${id}`, { data: rumorBytes(id), senderPubkey: A });
      group1.emit(id);
    }
    await new Promise((r) => setTimeout(r, 0)); // m1 is inside its handler
    old(); // dispose mid-handler; m2 has not started

    // New session-equivalent subscription (same process).
    const group2 = makeFakeGroup();
    const next = createDispatcher([handler], { journal }).subscribe(group2, ctx);
    const drained = old.drain();
    release();
    await drained; // MarmotContext: await previous drain BEFORE listing the journal
    await next.replay([...entries.values()]);

    expect(handled.filter((id) => id === 'm1')).toHaveLength(1);
    expect(handled.filter((id) => id === 'm2')).toHaveLength(1);
    expect(entries.size).toBe(0);
  });
});

describe('poison rumors (remediation round 1)', () => {
  const boom = (kind = 9) => ({ kind, handle: vi.fn(async () => { throw new Error('boom'); }) });

  it('a failed attempt is counted ONCE per dispatcher attempt, not per handler; below the limit the entry is kept', async () => {
    const journal = { ack: vi.fn(async () => {}), recordFailure: vi.fn(async () => 4) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom(), boom()], { journal, maxFailedAttempts: 5 }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(journal.recordFailure).toHaveBeenCalledTimes(1);
    expect(journal.recordFailure).toHaveBeenCalledWith('G1', 'm1');
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('at the limit the rumor is acked (dropped) with a warning naming kind and id; a later duplicate acks too', async () => {
    const journal = { ack: vi.fn(async () => {}), recordFailure: vi.fn(async () => 5) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom(11)], { journal, maxFailedAttempts: 5 }).subscribe(group, ctx);
    group.emit('m1', A, 11);
    await sub.drain();
    expect(journal.ack).toHaveBeenCalledWith('G1', 'm1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('poisonRumor'), expect.objectContaining({ kind: 11, rumorId: 'm1', attempts: 5, groupId: 'G1' }));
    group.emit('m1', A, 11);
    await sub.drain();
    expect(journal.ack).toHaveBeenCalledTimes(2);
  });

  it('the default limit is 5', async () => {
    let n = 0;
    const journal = { ack: vi.fn(async () => {}), recordFailure: vi.fn(async () => ++n) };
    const h = boom();
    for (let i = 0; i < 5; i++) {
      const sub = createDispatcher([h], { journal }).subscribe(makeFakeGroup(), ctx);
      await sub.replay([{ data: rumorBytes('m1'), senderPubkey: A }]);
      expect(journal.ack).toHaveBeenCalledTimes(i === 4 ? 1 : 0);
    }
  });

  it('failure injection: a failed attempt-count write is warned, keeps the entry and never blocks the queue', async () => {
    const journal = { ack: vi.fn(async () => {}), recordFailure: vi.fn(async () => { throw new Error('idb'); }) };
    const ok = { kind: 7, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom(), ok], { journal }).subscribe(group, ctx);
    group.emit('m1');
    group.emit('m2', A, 7);
    await sub.drain();
    expect(warn).toHaveBeenCalledWith('[dispatcher.journalAttempt]', expect.any(Error));
    expect(journal.ack).toHaveBeenCalledTimes(1);
    expect(journal.ack).toHaveBeenCalledWith('G1', 'm2');
  });

  it('a fan-out cut short by disposal is not a failed attempt (not counted)', async () => {
    const journal = { ack: vi.fn(async () => {}), recordFailure: vi.fn(async () => 99) };
    let sub: ReturnType<ReturnType<typeof createDispatcher>['subscribe']>;
    const first = { kind: 9, handle: vi.fn(() => { sub(); }) };
    const second = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    sub = createDispatcher([first, second], { journal }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(journal.recordFailure).not.toHaveBeenCalled();
    expect(journal.ack).not.toHaveBeenCalled();
  });

  it('without recordFailure a failed rumor is simply kept', async () => {
    const journal = { ack: vi.fn(async () => {}) };
    const group = makeFakeGroup();
    const sub = createDispatcher([boom()], { journal }).subscribe(group, ctx);
    group.emit('m1');
    await sub.drain();
    expect(journal.ack).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith('[dispatcher.journalAttempt]', expect.anything());
  });
});

describe('replay marking (remediation round 2)', () => {
  it('handlers see replayed: true for replay() dispatches and replayed: false for live ones', async () => {
    const h = { kind: 9, handle: vi.fn() };
    const group = makeFakeGroup();
    const sub = createDispatcher([h]).subscribe(group, ctx);
    await sub.replay([{ data: rumorBytes('r1'), senderPubkey: A }]);
    group.emit('live1');
    await sub.drain();
    expect(h.handle.mock.calls.map(([r, , , meta]) => [(r as { id: string }).id, meta])).toEqual([
      ['r1', { replayed: true }],
      ['live1', { replayed: false }],
    ]);
  });

  it('a live redelivery of a replayed id is not re-handled and acks only when the replayed handling completed', async () => {
    const log: string[] = [];
    const journal = makeJournal(log);
    let fail = true;
    const h = { kind: 9, handle: vi.fn(async () => { if (fail) throw new Error('idb'); }) };
    const group = makeFakeGroup();
    const sub = createDispatcher([h], { journal }).subscribe(group, ctx);
    await sub.replay([{ data: rumorBytes('x'), senderPubkey: A }]);
    group.emit('x');
    await sub.drain();
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(journal.ack).not.toHaveBeenCalled();
    fail = false;
    const next = createDispatcher([h], { journal }).subscribe(makeFakeGroup(), ctx);
    await next.replay([{ data: rumorBytes('x'), senderPubkey: A }]);
    expect(journal.ack).toHaveBeenCalledTimes(1);
  });
});
