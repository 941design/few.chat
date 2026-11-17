// @vitest-environment node
/**
 * The store-read contract of a slot recompute (ruling matrix item 10): one `recomputeSlot` call reads the thread's chat
 * rows ONCE (the reset, which returns the rows the fold then works on and keeps current in memory), however many
 * signals it folds, and the batch's history read (`remaining()`) is the sink's own memoised one.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ loadMessages: 0, resetSlotsToOriginal: 0 }));
vi.mock('@/src/lib/marmot/chatPersistence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/src/lib/marmot/chatPersistence')>();
  return {
    ...real,
    loadMessages: (...args: Parameters<typeof real.loadMessages>) => {
      reads.loadMessages += 1;
      return real.loadMessages(...args);
    },
    resetSlotsToOriginal: (...args: Parameters<typeof real.resetSlotsToOriginal>) => {
      reads.resetSlotsToOriginal += 1;
      return real.resetSlotsToOriginal(...args);
    },
  };
});

import { appendMessage, type ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { applyDeleteEditSignal, clearAllMessageEditsState, recomputeSlot } from '@/src/lib/messageEdits/api';
import type { RecomputeSignal } from '@/src/lib/marmot/handlers/types';

const BOB = 'bb'.repeat(32);
const G = 'ab'.repeat(32);
const thread = { kind: 'group' as const, groupId: G };
const T = Math.floor(Date.now() / 1000) - 10_000;

beforeEach(async () => {
  await clearAllMessageEditsState();
});

const edit = (n: number): RecomputeSignal => ({
  rumor: { id: `e${n}`, pubkey: BOB, created_at: T + n, kind: 9, tags: [['e', 'm1', '', 'edit'], ['rev', String(T + n)]], content: `edit ${n}` },
  sender: BOB,
  eventId: `ev${n}`,
  seq: n,
  receivedAt: Date.now(),
});

describe('recomputeSlot reads the thread rows once', () => {
  it('folding eight signals costs one reset read and no loadMessages (the fold keeps its rows current in memory)', async () => {
    const base: ChatMessage = { id: 'm1', content: 'orig', senderPubkey: BOB, groupId: G, createdAt: 1 };
    await appendMessage(G, base);
    const signals = Array.from({ length: 8 }, (_, i) => edit(i + 1));
    for (const s of signals) await applyDeleteEditSignal(thread, s.rumor, { pubkey: BOB, authenticity: 'mls' });

    reads.loadMessages = 0;
    reads.resetSlotsToOriginal = 0;
    await recomputeSlot(thread, ['m1'], signals.slice(0, 7));

    expect(reads).toEqual({ loadMessages: 0, resetSlotsToOriginal: 1 });
  });

  it('a call whose signals name no slot of it still reads once (the reset) and folds nothing', async () => {
    reads.loadMessages = 0;
    reads.resetSlotsToOriginal = 0;
    await recomputeSlot(thread, ['m1'], []);
    expect(reads).toEqual({ loadMessages: 0, resetSlotsToOriginal: 1 });
  });
});
