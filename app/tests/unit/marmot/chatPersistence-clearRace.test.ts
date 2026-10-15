/**
 * chatPersistence.ts — clearMessages must release ONLY its own write-queue slot.
 *
 * Regression for bug clear-messages-releases-foreign-queue-slot: clearMessages'
 * settle handler unconditionally deleted the per-thread queue entry, so an
 * append queued behind the clear lost its slot; a later append then started
 * from an empty queue and raced it (read-modify-write), silently dropping a row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

const idbStore = new Map<unknown, unknown>();
const armedGates: Array<{ onReach: () => void; wait: Promise<void> }> = [];

/** Blocks the NEXT idb `set` until released. */
function armGate() {
  let onReach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { onReach = r; });
  const wait = new Promise<void>((r) => { release = r; });
  armedGates.push({ onReach, wait });
  return { reached, release };
}

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: unknown) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: unknown, value: unknown) => {
    const gate = armedGates.shift();
    if (gate) {
      gate.onReach();
      await gate.wait;
    }
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: unknown) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: unknown[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

const { appendMessage, clearMessages, loadMessages } = await import('@/src/lib/marmot/chatPersistence');

function makeMsg(id: string): ChatMessage {
  return {
    id,
    content: `content-of-${id}`,
    senderPubkey: 'aa'.repeat(32),
    groupId: 'g',
    createdAt: 1_700_000_000_000,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  idbStore.clear();
  armedGates.length = 0;
});

describe('clearMessages — queue slot ownership', () => {
  it('an append queued during a clear and another arriving after it both persist', async () => {
    idbStore.set('few:messages:g', [makeMsg('old')]);
    const gate = armGate(); // holds append(b)'s write in flight

    const clearP = clearMessages('g');
    const bP = appendMessage('g', makeMsg('b')); // queued behind the clear
    await gate.reached; // clear settled; b is mid-write
    await tick();
    const cP = appendMessage('g', makeMsg('c')); // must queue behind b
    await tick();
    gate.release();
    await Promise.all([clearP, bP, cP]);

    const ids = (await loadMessages('g')).messages.map((m) => m.id);
    expect(ids).toEqual(['b', 'c']);
  });
});
