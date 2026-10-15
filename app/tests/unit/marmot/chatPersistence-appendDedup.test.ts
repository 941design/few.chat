/**
 * appendMessage insert-if-absent invariants (chatPersistence.ts).
 *
 * `appendMessage`'s dedup-by-id is the last safety net against duplicate chat
 * rows if an own-send echo (or any re-delivered rumor) ever leaks past
 * marmot-ts — e2e cannot exercise that path, so it is pinned here at the
 * storage seam. Written to close mutation-audit gaps (2026-10-14).
 *
 * Invariants (model-based, hand-rolled seeded generator — project convention
 * is no fast-check / no jsdom):
 *   1. For any append sequence (with duplicate ids), the stored log holds
 *      exactly one row per id, in first-arrival order, and each row is the
 *      FIRST write for that id — a later duplicate never clobbers it.
 *   2. The one carve-out: a `materializedFromEdit` placeholder is replaced in
 *      place by an informative-announcement arrival; any other arrival is a
 *      no-op.
 *   3. Concurrent (un-awaited) appends on one thread are serialised — no
 *      lost writes, no duplicates — and threads are isolated.
 *   4. The dev-only `__fewTest.onChatIdbWrite` hook (consumed by the
 *      groups-dispatch-isolation e2e, AC-AR-22 "fires exactly once") fires
 *      exactly once per actual write (insert or placeholder replacement),
 *      never on a dedup no-op, and never in a production build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

// ── idb-keyval mock (Map-backed, async to expose interleavings) ─────────────

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => {
    await Promise.resolve();
    return idbStore.get(key) ?? undefined;
  }),
  set: vi.fn(async (key: string, value: unknown) => {
    await Promise.resolve();
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

const { appendMessage, loadMessages } = await import('@/src/lib/marmot/chatPersistence');

// ── Helpers ─────────────────────────────────────────────────────────────────

const ANNOUNCEMENT = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });
const IMAGE_STRUCTURED = JSON.stringify({ type: 'image', content: 'pic' });

function makeMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    content: `content-of-${id}`,
    senderPubkey: 'aa'.repeat(32),
    groupId: 'g',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random append sequence over a small id pool, so duplicates are frequent. */
function genSequence(seed: number): ChatMessage[] {
  const r = rng(seed);
  const len = 1 + Math.floor(r() * 25);
  const poolSize = 1 + Math.floor(r() * 6);
  return Array.from({ length: len }, (_, i) =>
    makeMsg(`id-${Math.floor(r() * poolSize)}`, { content: `write-${i}`, createdAt: i }),
  );
}

/** Reference model of insert-if-absent: first write per id, first-arrival order. */
function modelFirstWriteWins(seq: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of seq) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

let hook: ReturnType<typeof vi.fn>;

beforeEach(() => {
  idbStore.clear();
  hook = vi.fn();
  vi.stubGlobal('window', { __fewTest: { onChatIdbWrite: hook } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── 1. Insert-if-absent (sequential) ────────────────────────────────────────

describe('appendMessage — insert-if-absent: one row per id, first write wins', () => {
  it.each(SEEDS)('seed %i: sequential appends match the first-write-wins model', async (seed) => {
    const thread = `seq-${seed}`;
    const seq = genSequence(seed);
    for (const m of seq) await appendMessage(thread, m);

    const { messages } = await loadMessages(thread);
    expect(messages).toEqual(modelFirstWriteWins(seq));
  });

  it('an own-send echo (same id, same content) leaves exactly one row', async () => {
    const msg = makeMsg('echo');
    await appendMessage('echo-thread', msg);
    await appendMessage('echo-thread', { ...msg });
    const { messages } = await loadMessages('echo-thread');
    expect(messages).toEqual([msg]);
  });

  it('a duplicate carrying announcement content does NOT clobber a real (non-placeholder) row', async () => {
    await appendMessage('real-row', makeMsg('x', { content: 'original' }));
    await appendMessage('real-row', makeMsg('x', { content: ANNOUNCEMENT }));
    const { messages } = await loadMessages('real-row');
    expect(messages.map((m) => m.content)).toEqual(['original']);
  });
});

// ── 2. materializedFromEdit carve-out ────────────────────────────────────────

describe('appendMessage — materializedFromEdit placeholder carve-out', () => {
  it.each([
    ['ordinary text', 'plain arrival', false],
    ['structured image (not informative)', IMAGE_STRUCTURED, false],
    ['informative announcement', ANNOUNCEMENT, true],
  ])('arrival of %s at a placeholder id: replaced=%s', async (_label, content, replaced) => {
    const thread = `ph-${String(content).length}-${String(replaced)}`;
    await appendMessage(thread, makeMsg('a'));
    const placeholder = makeMsg('p', { content: 'fabricated', materializedFromEdit: true, edited: true, rev: 3 });
    await appendMessage(thread, placeholder);
    await appendMessage(thread, makeMsg('c'));
    hook.mockClear();

    const arrival = makeMsg('p', { content, senderPubkey: 'bb'.repeat(32) });
    await appendMessage(thread, arrival);

    const { messages } = await loadMessages(thread);
    expect(messages.map((m) => m.id)).toEqual(['a', 'p', 'c']);
    expect(messages[1]).toEqual(replaced ? arrival : placeholder);
    expect(hook).toHaveBeenCalledTimes(replaced ? 1 : 0);
    if (replaced) expect(hook).toHaveBeenCalledWith({ groupId: thread, messageId: 'p' });
  });
});

// ── 3. Concurrency: serialised per thread, isolated across threads ─────────

describe('appendMessage — concurrent appends are serialised (no lost writes, no duplicates)', () => {
  it.each(SEEDS)('seed %i: un-awaited appends on one thread match the sequential model', async (seed) => {
    const thread = `conc-${seed}`;
    const seq = genSequence(seed);
    await Promise.all(seq.map((m) => appendMessage(thread, m)));

    const { messages } = await loadMessages(thread);
    expect(messages).toEqual(modelFirstWriteWins(seq));
  });

  it('interleaved concurrent appends on two threads stay isolated', async () => {
    const a = genSequence(101);
    const b = genSequence(202);
    const ops: Promise<void>[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) ops.push(appendMessage('iso-a', a[i]));
      if (b[i]) ops.push(appendMessage('iso-b', b[i]));
    }
    await Promise.all(ops);
    expect((await loadMessages('iso-a')).messages).toEqual(modelFirstWriteWins(a));
    expect((await loadMessages('iso-b')).messages).toEqual(modelFirstWriteWins(b));
  });

  it('a failed write does not wedge the thread queue: later appends still land', async () => {
    const idb = await import('idb-keyval');
    vi.mocked(idb.set).mockImplementationOnce(async () => {
      throw new Error('quota');
    });
    const failed = appendMessage('wedge', makeMsg('first'));
    const later = appendMessage('wedge', makeMsg('second'));
    await expect(failed).rejects.toThrow('quota');
    await later;
    expect((await loadMessages('wedge')).messages.map((m) => m.id)).toEqual(['second']);
  });

  it('persists under the few:messages:<groupId> key', async () => {
    await appendMessage('keyed', makeMsg('k'));
    expect([...idbStore.keys()]).toEqual(['few:messages:keyed']);
  });
});

// ── 4. Dev-only onChatIdbWrite hook ─────────────────────────────────────────

describe('appendMessage — __fewTest.onChatIdbWrite fires exactly once per actual write', () => {
  it.each(SEEDS)('seed %i: hook calls equal the distinct inserted ids, in order', async (seed) => {
    const thread = `hook-${seed}`;
    const seq = genSequence(seed);
    for (const m of seq) await appendMessage(thread, m);

    expect(hook.mock.calls.map((c) => c[0])).toEqual(
      modelFirstWriteWins(seq).map((m) => ({ groupId: thread, messageId: m.id })),
    );
  });

  it('hook fires only after the row is persisted (observer can read it back)', async () => {
    const seenAtHook: number[] = [];
    hook.mockImplementation(({ groupId }: { groupId: string }) => {
      seenAtHook.push(((idbStore.get(`few:messages:${groupId}`) as ChatMessage[]) ?? []).length);
    });
    await appendMessage('order', makeMsg('1'));
    await appendMessage('order', makeMsg('2'));
    expect(seenAtHook).toEqual([1, 2]);
  });

  it('hook never fires in a production build (insert or placeholder replacement)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await appendMessage('prod', makeMsg('p', { materializedFromEdit: true }));
    await appendMessage('prod', makeMsg('p', { content: ANNOUNCEMENT }));
    expect(hook).not.toHaveBeenCalled();
    expect((await loadMessages('prod')).messages[0].content).toBe(ANNOUNCEMENT);
  });

  it('absent window / absent __fewTest is tolerated (writes still land)', async () => {
    vi.unstubAllGlobals();
    await appendMessage('nowin', makeMsg('n'));
    vi.stubGlobal('window', {});
    await appendMessage('nowin', makeMsg('m'));
    await appendMessage('nowin', makeMsg('m', { materializedFromEdit: true }));
    expect((await loadMessages('nowin')).messages.map((m) => m.id)).toEqual(['n', 'm']);
  });

  it.each([
    ['no __fewTest', {}],
    ['__fewTest without onChatIdbWrite', { __fewTest: {} }],
  ])('window with %s: insert and placeholder replacement both resolve', async (_l, win) => {
    vi.stubGlobal('window', win);
    await appendMessage('partial', makeMsg('p', { materializedFromEdit: true }));
    await appendMessage('partial', makeMsg('p', { content: ANNOUNCEMENT }));
    expect((await loadMessages('partial')).messages).toEqual([makeMsg('p', { content: ANNOUNCEMENT })]);
  });
});
