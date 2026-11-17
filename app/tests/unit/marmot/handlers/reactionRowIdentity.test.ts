// @vitest-environment node
/**
 * Reaction rows are identified by (rumor id, reactor), not by the rumor id alone.
 *
 * A row id is a rumor id, and a byte-identical copy of a rumor delivered by another member is a second row with the
 * same id under another reactor. Lookups by id (the optimistic re-add, `rollbackOptimistic`) must therefore never let
 * another reactor's row stand in for the local user's in-flight one.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyInboundRumor, applyOptimistic, loadReactions, rollbackOptimistic } from '@/src/lib/reactions/api';
import type { Reaction, ReactionThreadKey } from '@/src/lib/reactions/types';
import { ALICE, MALLORY, SELF } from './realApp';

let n = 0;
let thread: ReactionThreadKey;
beforeEach(() => {
  thread = { kind: 'group', groupId: (0x2000 + ++n).toString(16).padStart(64, '0') };
});

const X = 'shared-rumor-id';
const rumor = { id: X, pubkey: ALICE, created_at: 1_700_000_000, content: '👍', tags: [['e', 'm1']] };
const optimistic = (reactor: string): Reaction => ({ id: X, messageId: 'm1', reactorPubkey: reactor, emoji: '👍', eventId: '', createdAt: 1_700_000_100_000, removed: false });
const live = async () => (await loadReactions(thread)).filter((r) => !r.removed).map((r) => [r.reactorPubkey, r.eventId]);

describe('two reactors sharing a rumor id', () => {
  it('both rows are kept; the optimistic add of the local user is not swallowed by the other reactor\'s row of the same id', async () => {
    await applyInboundRumor(thread, rumor, { pubkey: MALLORY, authenticity: 'mls' }); // a forged copy, first in the thread
    expect(await applyOptimistic(thread, optimistic(SELF))).not.toBeNull();
    expect(await live()).toEqual([
      [MALLORY, X],
      [SELF, ''],
    ]);
  });

  it('rollbackOptimistic removes the local user\'s in-flight row and leaves the other reactor\'s confirmed row', async () => {
    await applyInboundRumor(thread, rumor, { pubkey: MALLORY, authenticity: 'mls' });
    await applyOptimistic(thread, optimistic(SELF));
    await rollbackOptimistic(thread, X);
    expect(await live()).toEqual([[MALLORY, X]]);
  });

  it('with a reactor given, rollback touches only that reactor\'s in-flight row', async () => {
    await applyOptimistic(thread, optimistic(SELF));
    expect(await rollbackOptimistic(thread, X, MALLORY)).toBeNull(); // not Mallory's row
    expect(await live()).toEqual([[SELF, '']]);
    await rollbackOptimistic(thread, X, SELF);
    expect(await live()).toEqual([]);
  });

  it('a confirmed row of the same id is never rolled back, whoever it belongs to', async () => {
    await applyInboundRumor(thread, rumor, { pubkey: MALLORY, authenticity: 'mls' });
    expect(await rollbackOptimistic(thread, X)).toBeNull();
    expect(await live()).toEqual([[MALLORY, X]]);
  });
});
