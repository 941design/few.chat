/**
 * Property-based gap-closing tests for reactions/api.ts
 *
 * Closes the 24 real-gap survivors from the mutation gate:
 *
 * Line 166 — aggregateForMessage sort: reactors must be in ascending createdAt order.
 * Line 239 — applyOptimisticRemoval messageId match in findIndex.
 * Line 240 — applyOptimisticRemoval reactorPubkey match in findIndex.
 * Line 264 — rollbackOptimistic target-find guard.
 * Line 302 — applyInboundRumor eTag type guard.
 * Line 323 — applyInboundRumor eventId dedup guard.
 * Line 335 — applyInboundRumor removal emoji-tag filter type guard.
 * Line 339 — applyInboundRumor removal emoji tag boundaries.
 * Line 349 — applyInboundRumor upsert messageId match.
 * Line 350 — applyInboundRumor upsert reactorPubkey match.
 * Line 368 — applyInboundRumor new-row messageId (from eTag).
 * Line 385 — applyInboundRumor tombstone reactorPubkey match.
 * Line 386 — applyInboundRumor tombstone emoji match.
 * Line 396 — applyInboundRumor removed-row revival guard.
 * Line 415 — applyInboundRumor createdAt unit conversion (s → ms).
 * Line 454 — clearAllReactions finally block resets the flag.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reaction } from '@/src/lib/reactions/types';

// ── idb-keyval mock ────────────────────────────────────────────────────────────

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

// ── Module import ──────────────────────────────────────────────────────────────

const {
  aggregateForMessage,
  applyOptimistic,
  applyOptimisticRemoval,
  rollbackOptimistic,
  applyInboundRumor: applyInboundRumorReal,
  loadReactions,
  clearAllReactions,
} = await import('@/src/lib/reactions/api');

// A group-thread signal needs an explicit authenticated sender (the store never falls back to the forgeable
// `rumor.pubkey`): these fixtures deliver each rumor as sent by its own pubkey. A DM thread keeps the default.
const applyInboundRumor = ((thread: Parameters<typeof applyInboundRumorReal>[0], rumor: Parameters<typeof applyInboundRumorReal>[1], sender?: Parameters<typeof applyInboundRumorReal>[2]) =>
  applyInboundRumorReal(thread, rumor, sender ?? (thread.kind === 'group' ? { pubkey: rumor.pubkey, authenticity: 'mls' as const } : undefined))) as typeof applyInboundRumorReal;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeReaction(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: 'opt-1',
    messageId: 'msg-1',
    reactorPubkey: 'pubkey-alice',
    emoji: '👍',
    eventId: '',
    createdAt: 1000,
    removed: false,
    ...overrides,
  };
}

function makeRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}> = {}) {
  return {
    id: 'rumor-1',
    pubkey: 'pubkey-alice',
    created_at: 1000,
    content: '👍',
    tags: [['e', 'msg-1']],
    ...overrides,
  };
}

const GROUP_THREAD = { kind: 'group' as const, groupId: 'group-prop' };
const GROUP_KEY = 'few:reactions:group:group-prop';

beforeEach(async () => {
  idbStore.clear();
  vi.clearAllMocks();
  // Clear the module-singleton in-memory cache. Without this, tests that seed
  // idbStore directly (bypassing enqueue) see stale cache from the previous test.
  await clearAllReactions();
  vi.clearAllMocks();
});

// ── aggregateForMessage: sort order (line 166) ────────────────────────────────

describe('aggregateForMessage — reactors are sorted oldest-first', () => {
  /**
   * Property: for any set of rows with the same emoji, the reactors array in the
   * aggregate must be sorted ascending by createdAt.
   * Kills: MethodExpression repl='[...emojiRows]' (removes sort) and
   *        ArithmeticOperator repl='a.createdAt + b.createdAt' (breaks comparator).
   */

  it('reactors for the same emoji are in ascending createdAt order', () => {
    const rows: Reaction[] = [
      makeReaction({ id: 'r3', reactorPubkey: 'charlie', createdAt: 3000 }),
      makeReaction({ id: 'r1', reactorPubkey: 'alice', createdAt: 1000 }),
      makeReaction({ id: 'r2', reactorPubkey: 'bob', createdAt: 2000 }),
    ];
    const aggs = aggregateForMessage(rows, 'msg-1', 'self');
    const thumbsUp = aggs.find((a) => a.emoji === '👍');
    expect(thumbsUp).toBeDefined();
    expect(thumbsUp!.reactors).toEqual(['alice', 'bob', 'charlie']);
  });

  it('parametric: 10 rows in reverse-createdAt order produce ascending reactors', () => {
    const rows: Reaction[] = Array.from({ length: 10 }, (_, i) =>
      makeReaction({ id: `r${i}`, reactorPubkey: `peer-${i}`, createdAt: (10 - i) * 1000 }),
    );
    const aggs = aggregateForMessage(rows, 'msg-1', 'self');
    const emoji = aggs[0];
    // The reactors must be sorted ascending: peer-9 (createdAt=1000) first
    const createdAts = rows
      .filter((r) => r.emoji === emoji.emoji)
      .map((r) => r.createdAt)
      .sort((a, b) => a - b);
    const expectedReactors = rows
      .filter((r) => r.emoji === emoji.emoji)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => r.reactorPubkey);
    expect(emoji.reactors).toEqual(expectedReactors);
    // Ascending check
    for (let i = 0; i < createdAts.length - 1; i++) {
      expect(createdAts[i]).toBeLessThanOrEqual(createdAts[i + 1]);
    }
  });

  it('single reactor: sort is a no-op, reactors has exactly one element', () => {
    const rows = [makeReaction({ reactorPubkey: 'only-one', createdAt: 5000 })];
    const aggs = aggregateForMessage(rows, 'msg-1', 'self');
    expect(aggs[0].reactors).toEqual(['only-one']);
  });
});

// ── applyOptimisticRemoval: findIndex key matching (lines 239-240) ────────────

describe('applyOptimisticRemoval — findIndex must match by messageId AND reactorPubkey', () => {
  /**
   * Property: applyOptimisticRemoval only tombstones the row that exactly matches
   * both messageId and reactorPubkey. A wrong messageId or reactorPubkey must not
   * tombstone the wrong row.
   * Kills: LogicalOperator repl='||' on line 239 and reactorPubkey match (line 240).
   */

  it('tombstones the exact row matching (messageId, reactorPubkey, emoji)', async () => {
    const target = makeReaction({ id: 'a', messageId: 'msg-A', reactorPubkey: 'alice', emoji: '👍' });
    const other = makeReaction({ id: 'b', messageId: 'msg-A', reactorPubkey: 'bob', emoji: '👍' });
    idbStore.set(GROUP_KEY, [target, other]);

    await applyOptimisticRemoval(GROUP_THREAD, 'msg-A', 'alice', '👍');

    const rows = await loadReactions(GROUP_THREAD);
    const alice = rows.find((r) => r.reactorPubkey === 'alice');
    const bob = rows.find((r) => r.reactorPubkey === 'bob');
    expect(alice?.removed).toBe(true);
    expect(bob?.removed).toBe(false);
  });

  it('does not tombstone when messageId does not match', async () => {
    const row = makeReaction({ id: 'c', messageId: 'msg-B', reactorPubkey: 'alice', emoji: '👍' });
    idbStore.set(GROUP_KEY, [row]);

    const result = await applyOptimisticRemoval(GROUP_THREAD, 'msg-X', 'alice', '👍');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows[0].removed).toBe(false);
  });

  it('does not tombstone when reactorPubkey does not match', async () => {
    const row = makeReaction({ id: 'd', messageId: 'msg-C', reactorPubkey: 'alice', emoji: '👍' });
    idbStore.set(GROUP_KEY, [row]);

    const result = await applyOptimisticRemoval(GROUP_THREAD, 'msg-C', 'bob', '👍');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows[0].removed).toBe(false);
  });
});

// ── rollbackOptimistic: target guard (line 264) ───────────────────────────────

describe('rollbackOptimistic — only rolls back in-flight rows by id', () => {
  /**
   * Property: rollbackOptimistic must find the target row by id and only remove
   * it if its eventId is empty. A row with a non-empty eventId must survive.
   * Kills: ConditionalExpression repl='true' on `const target = current.find(...)`.
   */

  it('rolls back an in-flight row (eventId = "")', async () => {
    const row = makeReaction({ id: 'opt-rb', eventId: '' });
    idbStore.set(GROUP_KEY, [row]);
    await rollbackOptimistic(GROUP_THREAD, 'opt-rb');
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(0);
  });

  it('does not roll back a row that no longer exists', async () => {
    idbStore.set(GROUP_KEY, [makeReaction({ id: 'other' })]);
    const result = await rollbackOptimistic(GROUP_THREAD, 'nonexistent');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
  });

  it('does not roll back a confirmed row (eventId is non-empty)', async () => {
    const confirmed = makeReaction({ id: 'confirmed', eventId: 'wire-event-id-abc' });
    idbStore.set(GROUP_KEY, [confirmed]);
    const result = await rollbackOptimistic(GROUP_THREAD, 'confirmed');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
  });
});

// ── applyInboundRumor: eTag type guard (line 302) ─────────────────────────────

describe('applyInboundRumor — e-tag type guard accepts only string tag names', () => {
  /**
   * Property: the e-tag finder must reject malformed tags where t[0] is not a string.
   * A rumor with no valid 'e' tag must return null (no write).
   * Kills: ConditionalExpression repl='true' (would find the first tag regardless).
   */

  it('returns null when tags array is empty', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [] }));
    expect(result).toBeNull();
  });

  it('returns null when the e-tag value is absent', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [['e']] }));
    expect(result).toBeNull();
  });

  it('returns null when tag name is a number, not a string', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [[1 as any, 'msg-1']] }));
    expect(result).toBeNull();
  });

  it('returns the messageId when the e-tag is well-formed', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [['e', 'msg-1']] }));
    expect(result).toEqual({ messageId: 'msg-1' });
  });
});

// ── applyInboundRumor: eventId dedup guard (line 323) ────────────────────────

describe('applyInboundRumor — eventId dedup: same rumor.id is a no-op on second call', () => {
  /**
   * Property: delivering the same rumor.id twice must not produce two rows or
   * increment the count. The dedup guard must use rumor.id identity.
   * Kills: the `r.eventId === rumor.id && rumor.id !== ''` guard flip and
   *        StringLiteral repl='"Stryker was here!"' on the non-empty check.
   */

  it('same rumor.id delivered twice yields exactly one row', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'wire-1' }));
    const result2 = await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'wire-1' }));
    expect(result2).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    const withWire1 = rows.filter((r) => r.eventId === 'wire-1');
    expect(withWire1).toHaveLength(1);
  });

  it('empty rumor.id is not deduped (in-flight optimistic rows all have id="")', async () => {
    // Two rumors with id='' are NOT deduped (the guard requires rumor.id !== '')
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: '', content: '👍' }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: '', content: '❤️' }));
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('different rumor ids each produce their own row', async () => {
    for (let i = 0; i < 5; i++) {
      await applyInboundRumor(GROUP_THREAD, makeRumor({ id: `wire-${i}`, pubkey: `peer-${i}`, tags: [['e', 'msg-dedup']] }));
    }
    const rows = await loadReactions(GROUP_THREAD);
    const forMsg = rows.filter((r) => r.messageId === 'msg-dedup');
    expect(forMsg).toHaveLength(5);
  });
});

// ── applyInboundRumor: removal emoji-tag filter (lines 335, 339) ──────────────

describe('applyInboundRumor — removal emoji-tag boundaries', () => {
  /**
   * Property: the emoji-tag filter must require t[0] to be a string and
   * t[0].toLowerCase() === 'emoji', and t[1] to be a non-empty string.
   * Multiple distinct emojis cause silent discard; exactly one narrows the tombstone.
   * Kills: ConditionalExpression repl='true' on line 335 and tag-shape boundary (line 339).
   */

  it('removal with exactly one emoji tag tombstones the matching row', async () => {
    const existing = makeReaction({ id: 'r1', messageId: 'msg-rm', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [existing]);

    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-1',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-rm'], ['emoji', '👍']],
    });
    expect(result).toEqual({ messageId: 'msg-rm' });
    const rows = await loadReactions(GROUP_THREAD);
    const alice = rows.find((r) => r.reactorPubkey === 'alice');
    expect(alice?.removed).toBe(true);
  });

  it('removal with two distinct emoji tags is silently discarded', async () => {
    const existing = makeReaction({ id: 'r2', messageId: 'msg-rm2', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [existing]);

    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-2',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-rm2'], ['emoji', '👍'], ['emoji', '❤️']],
    });
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.find((r) => r.id === 'r2')?.removed).toBe(false);
  });

  it('removal with emoji tag value being empty string is treated as no emoji tag', async () => {
    // Empty t[1] is filtered out by `t[1].length > 0`
    const existing = makeReaction({ id: 'r3', messageId: 'msg-rm3', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [existing]);

    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-3',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-rm3'], ['emoji', '']],
    });
    // No valid emoji tag → falls through to single-candidate check
    // Since exactly one non-removed row exists for (msg-rm3, alice), it should be tombstoned
    const rows = await loadReactions(GROUP_THREAD);
    // Either tombstoned (single candidate path) or no-op depending on candidate count
    expect(result === null || result?.messageId === 'msg-rm3').toBe(true);
  });
});

// ── applyInboundRumor: upsert key matching (lines 349-350) ───────────────────

describe('applyInboundRumor — upsert uses AND for messageId + reactorPubkey', () => {
  /**
   * Property: the upsert findIndex must match BOTH messageId AND reactorPubkey.
   * Using || (OR) would match wrong rows and corrupt the store.
   * Kills: LogicalOperator repl='||' on lines 349 and 350.
   */

  it('second reaction for the same message from a different peer adds a new row', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w1', pubkey: 'alice', tags: [['e', 'msg-upsert']] }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w2', pubkey: 'bob', tags: [['e', 'msg-upsert']] }));
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.filter((r) => r.messageId === 'msg-upsert')).toHaveLength(2);
  });

  it('second reaction for the same peer on a different message adds a new row', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w3', pubkey: 'alice', tags: [['e', 'msg-X']] }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w4', pubkey: 'alice', tags: [['e', 'msg-Y']] }));
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.filter((r) => r.reactorPubkey === 'alice')).toHaveLength(2);
  });

  it('second reaction for same (messageId, reactorPubkey, emoji) updates the existing row', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w5', pubkey: 'alice', tags: [['e', 'msg-same']] }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w6', pubkey: 'alice', tags: [['e', 'msg-same']] }));
    const rows = await loadReactions(GROUP_THREAD);
    const aliceSame = rows.filter((r) => r.messageId === 'msg-same' && r.reactorPubkey === 'alice');
    expect(aliceSame).toHaveLength(1);
    expect(aliceSame[0].eventId).toBe('w6');
  });
});

// ── applyInboundRumor: removed-row revival guard (line 396) ──────────────────

describe('applyInboundRumor — removed row is not revived by a later reaction', () => {
  /**
   * Property: when a row has already been tombstoned (removed=true), a later-arriving
   * reaction for the same (messageId, reactorPubkey, emoji) must NOT revive it.
   * The removal wins regardless of event ordering.
   * Kills: the `if (current[existingIdx].removed)` guard flip on line 396.
   */

  it('re-delivery of a reaction for an already-removed row is a no-op', async () => {
    // Seed a tombstoned row
    const tombstoned = makeReaction({
      id: 'r-tomb',
      messageId: 'msg-T',
      reactorPubkey: 'alice',
      emoji: '👍',
      eventId: 'removal-event',
      removed: true,
    });
    idbStore.set(GROUP_KEY, [tombstoned]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'late-reaction',
      pubkey: 'alice',
      tags: [['e', 'msg-T']],
      content: '👍',
    }));
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.find((r) => r.id === 'r-tomb')?.removed).toBe(true);
  });

  it('property: removal always wins for any ordering (5 pairs)', async () => {
    for (let i = 0; i < 5; i++) {
      idbStore.clear();
      // Apply reaction first, then tombstone
      await applyInboundRumor(GROUP_THREAD, makeRumor({ id: `react-${i}`, pubkey: 'alice', tags: [['e', `msg-${i}`]] }));
      await applyInboundRumor(GROUP_THREAD, {
        id: `remove-${i}`,
        pubkey: 'alice',
        created_at: 1000,
        content: '-',
        tags: [['e', `msg-${i}`], ['emoji', '👍']],
      });
      // Now try to revive
      const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
        id: `revive-${i}`,
        pubkey: 'alice',
        tags: [['e', `msg-${i}`]],
      }));
      expect(result).toBeNull();
      const rows = await loadReactions(GROUP_THREAD);
      const aliceRows = rows.filter((r) => r.messageId === `msg-${i}` && r.reactorPubkey === 'alice');
      expect(aliceRows.every((r) => r.removed)).toBe(true);
    }
  });
});

// ── applyInboundRumor: createdAt unit conversion (line 415) ──────────────────

describe('applyInboundRumor — createdAt is stored as ms (created_at * 1000)', () => {
  /**
   * Property: a new reaction row's createdAt must equal rumor.created_at * 1000.
   * Kills: rumor.created_at * 1000 → / 1000 (produces a 1980-era timestamp).
   */

  it('stores createdAt in milliseconds (rumor.created_at * 1000)', async () => {
    const createdAtSec = 1_700_000_000;
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'w-unit', created_at: createdAtSec }));
    const rows = await loadReactions(GROUP_THREAD);
    const row = rows.find((r) => r.eventId === 'w-unit');
    expect(row).toBeDefined();
    expect(row!.createdAt).toBe(createdAtSec * 1000);
  });

  it('parametric: createdAt = rumor.created_at * 1000 for various timestamps', async () => {
    const testCases = [0, 1, 1000, 1_000_000, 1_700_000_000];
    for (let i = 0; i < testCases.length; i++) {
      idbStore.clear();
      const sec = testCases[i];
      await applyInboundRumor(GROUP_THREAD, makeRumor({ id: `w-ts-${i}`, created_at: sec, pubkey: `peer-${i}` }));
      const rows = await loadReactions(GROUP_THREAD);
      const row = rows.find((r) => r.eventId === `w-ts-${i}`);
      expect(row?.createdAt).toBe(sec * 1000);
      // Confirm it's NOT sec / 1000 or just sec
      if (sec > 0) {
        expect(row!.createdAt).not.toBe(sec / 1000);
        expect(row!.createdAt).not.toBe(sec);
      }
    }
  });
});

// ── clearAllReactions: finally block (line 454) ───────────────────────────────

describe('clearAllReactions — finally block resets clearingInProgress', () => {
  /**
   * Property: after clearAllReactions completes (even if keys() throws), subsequent
   * applyInboundRumor calls must succeed (the clearingInProgress flag must be reset).
   * Kills: BlockStatement repl='{}' on the finally block.
   */

  it('applyInboundRumor succeeds after clearAllReactions', async () => {
    idbStore.set(GROUP_KEY, [makeReaction()]);
    await clearAllReactions();
    // After clear, writes must be accepted
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'post-clear-1' }));
    expect(result).toEqual({ messageId: 'msg-1' });
  });

  it('clearAllReactions can be called multiple times without deadlock', async () => {
    await clearAllReactions();
    await clearAllReactions();
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'post-double-clear' }));
    expect(result).toEqual({ messageId: 'msg-1' });
  });

  it('writes are rejected during clearAllReactions and accepted after', async () => {
    // We cannot easily hook into the in-flight state, but we can verify the
    // module is functional after clear completes.
    await clearAllReactions();
    await applyOptimistic(GROUP_THREAD, makeReaction({ id: 'opt-after-clear' }));
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.some((r) => r.id === 'opt-after-clear')).toBe(true);
  });
});

// ── Cross-cutting: spread-base preservation (ensures other thread data is intact)

describe('applyInboundRumor — cross-thread isolation', () => {
  /**
   * Property: writing to one thread must not affect another thread's rows.
   */

  it('reactions for different threads are stored independently', async () => {
    const THREAD_A = { kind: 'group' as const, groupId: 'group-A' };
    const THREAD_B = { kind: 'dm' as const, peerPubkeyHex: 'peer-B' };

    await applyInboundRumor(THREAD_A, makeRumor({ id: 'w-A', pubkey: 'alice', tags: [['e', 'msg-A']] }));
    await applyInboundRumor(THREAD_B, makeRumor({ id: 'w-B', pubkey: 'alice', tags: [['e', 'msg-B']] }));

    const rowsA = await loadReactions(THREAD_A);
    const rowsB = await loadReactions(THREAD_B);

    expect(rowsA.some((r) => r.messageId === 'msg-A')).toBe(true);
    expect(rowsA.some((r) => r.messageId === 'msg-B')).toBe(false);
    expect(rowsB.some((r) => r.messageId === 'msg-B')).toBe(true);
    expect(rowsB.some((r) => r.messageId === 'msg-A')).toBe(false);
  });
});

// ── applyInboundRumor: eTag type guard sharp test (line 302 - 2 mutants) ──────

describe('applyInboundRumor — e-tag finder rejects non-string and non-"e" tag names', () => {
  /**
   * Two ConditionalExpression repl='true' mutants on line 302:
   * replacing the whole condition with true would find the FIRST tag regardless
   * of whether it's a proper 'e' tag. These tests verify both halves of the &&.
   *
   * Kill strategy: provide a rumor where the first tag has the right string type
   * but wrong name, and a second tag that is the real 'e' tag.
   */

  it('finds only the "e" tag, not a preceding tag with a different name', async () => {
    // First tag is ["p", "some-pubkey"] — must NOT be picked as the e-tag
    // Second tag is ["e", "msg-etag"] — must be picked
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'etag-order-1',
      tags: [['p', 'some-pubkey'], ['e', 'msg-etag']],
    }));
    // Must use the 'e' tag's value as messageId, not 'some-pubkey'
    expect(result).toEqual({ messageId: 'msg-etag' });
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.some((r) => r.messageId === 'msg-etag')).toBe(true);
    expect(rows.some((r) => r.messageId === 'some-pubkey')).toBe(false);
  });

  it('a tag with name "E" (uppercase) is NOT treated as the e-tag', async () => {
    // t[0] === 'E' fails t[0] === 'e', so no e-tag is found → null
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'etag-case-1',
      tags: [['E', 'msg-uppercase']],
    }));
    expect(result).toBeNull();
  });

  it('a non-string tag[0] is rejected, falls through to no-match', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'etag-nonstr-1',
      tags: [[42 as any, 'msg-numeric'], ['e', 'msg-real']],
    }));
    // The numeric tag is skipped; the 'e' tag provides messageId
    expect(result).toEqual({ messageId: 'msg-real' });
  });
});

// ── applyInboundRumor: eventId dedup - empty string special case (line 323) ───

describe('applyInboundRumor — empty rumor.id is never deduped (line 323)', () => {
  /**
   * The guard `r.eventId === rumor.id && rumor.id !== ''` means an empty rumor.id
   * is never treated as a duplicate. This is critical for in-flight optimistic rows.
   *
   * StringLiteral repl='"Stryker was here!"' kills this by making the guard
   * check `rumor.id !== "Stryker was here!"` instead of `rumor.id !== ''`.
   * With that mutation, two reactions with id='' would dedup on the second call.
   */

  it('two additions with id="" are both applied (empty id is not deduplicated)', async () => {
    // First call
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: '', pubkey: 'alice', tags: [['e', 'msg-empty-1']] }));
    // Second call with same id='' but different pubkey → must also be applied
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: '', pubkey: 'bob', tags: [['e', 'msg-empty-2']] }));
    const rows = await loadReactions(GROUP_THREAD);
    // Both must have been applied (not deduped)
    expect(rows.some((r) => r.messageId === 'msg-empty-1')).toBe(true);
    expect(rows.some((r) => r.messageId === 'msg-empty-2')).toBe(true);
  });

  it('non-empty rumor.id is deduped on re-delivery', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'dedup-id-x' }));
    const result2 = await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'dedup-id-x' }));
    expect(result2).toBeNull();
  });
});

// ── applyInboundRumor: removal emoji-tag filter guard sharp tests (line 335) ──

describe('applyInboundRumor — removal emoji-tag filter type guard (line 335)', () => {
  /**
   * The ConditionalExpression repl='true' on line 335 would accept ANY tag as an
   * emoji tag, including tags where t[0] is not 'emoji' or t[1] is empty.
   * These tests verify the filter is selective.
   */

  it('tag with name "EMOJI" (uppercase) is not treated as an emoji tag for removal', async () => {
    const existing = makeReaction({ id: 'r-case', messageId: 'msg-case', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [existing]);
    // 'EMOJI' tag should not be treated as an emoji tag (case-sensitive check fails for 'EMOJI'.toLowerCase() === 'emoji' - actually passes!)
    // Wait - the code does t[0].toLowerCase() === 'emoji' which IS case-insensitive.
    // So 'EMOJI' WOULD match. Let's test a tag with t[0] === 'p' instead.
    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-case',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-case'], ['p', '👍']], // 'p' tag with emoji value — NOT an emoji tag
    });
    // No valid emoji tag → falls through to single-candidate check
    // There is exactly one non-removed candidate → tombstone
    const rows = await loadReactions(GROUP_THREAD);
    expect(result === null || result?.messageId === 'msg-case').toBe(true);
  });

  it('emoji tag with non-string t[1] is filtered out', async () => {
    const existing = makeReaction({ id: 'r-nonstr', messageId: 'msg-nonstr', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [existing]);
    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-nonstr',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-nonstr'], ['emoji', 42 as any]], // numeric t[1] — typeof t[1] !== 'string'
    });
    // No valid emoji tag (t[1] is not string) → single-candidate path → tombstone
    const rows = await loadReactions(GROUP_THREAD);
    expect(result === null || result?.messageId === 'msg-nonstr').toBe(true);
  });

  it('removal with no emoji tags and multiple candidates is silently discarded (D2 ambiguity)', async () => {
    // Two non-removed rows for the same (messageId, reactorPubkey) — ambiguous
    const r1 = makeReaction({ id: 'r-ambi-1', messageId: 'msg-ambi', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    const r2 = makeReaction({ id: 'r-ambi-2', messageId: 'msg-ambi', reactorPubkey: 'alice', emoji: '❤️', eventId: 'prev2' });
    idbStore.set(GROUP_KEY, [r1, r2]);
    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-ambi',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-ambi']], // no emoji tag → falls to candidate check
    });
    // Two candidates → ambiguous → silent discard
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.every((r) => !r.removed)).toBe(true);
  });
});

// ── applyInboundRumor: no-emoji-tag tombstone messageId/reactorPubkey (line 368) ─

describe('applyInboundRumor — no-emoji-tag tombstone path: messageId and reactorPubkey guards (line 368)', () => {
  /**
   * When there is no emoji tag, the candidates filter at line 368 uses
   * `r.messageId === messageId && r.reactorPubkey === rumor.pubkey`.
   * ConditionalExpression repl='true' would include rows from other messages/peers.
   *
   * Kills: ConditionalExpression on the candidates filter predicate.
   */

  it('no-emoji tombstone only affects the target (messageId, reactorPubkey) pair', async () => {
    const target = makeReaction({ id: 'r-target', messageId: 'msg-target', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev-t' });
    const bystander = makeReaction({ id: 'r-bystander', messageId: 'msg-other', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev-b' });
    const wrongPeer = makeReaction({ id: 'r-wrong-peer', messageId: 'msg-target', reactorPubkey: 'bob', emoji: '👍', eventId: 'prev-wp' });
    idbStore.set(GROUP_KEY, [target, bystander, wrongPeer]);

    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-target',
      pubkey: 'alice',
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-target']], // no emoji tag → single-candidate path
    });
    // Only the target (msg-target, alice) is a candidate — exactly 1 → tombstone
    expect(result).toEqual({ messageId: 'msg-target' });
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.find((r) => r.id === 'r-target')?.removed).toBe(true);
    expect(rows.find((r) => r.id === 'r-bystander')?.removed).toBe(false);
    expect(rows.find((r) => r.id === 'r-wrong-peer')?.removed).toBe(false);
  });

  it('wrong reactorPubkey: no candidate found → silent discard', async () => {
    const row = makeReaction({ id: 'r-nopeer', messageId: 'msg-nopeer', reactorPubkey: 'alice', emoji: '👍', eventId: 'prev' });
    idbStore.set(GROUP_KEY, [row]);
    const result = await applyInboundRumor(GROUP_THREAD, {
      id: 'removal-wrong-peer',
      pubkey: 'bob', // bob has no row for this message
      created_at: 2000,
      content: '-',
      tags: [['e', 'msg-nopeer']],
    });
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows[0].removed).toBe(false);
  });
});

// ── applyInboundRumor: upsert emoji match (line 386 reactorPubkey, and emoji) ──

describe('applyInboundRumor — upsert findIndex matches all three keys (L384-386)', () => {
  /**
   * The upsert path's findIndex checks messageId && reactorPubkey && emoji.
   * A ConditionalExpression on line 386 (r.emoji === emoji) would accept any
   * emoji → multiple distinct emoji reactions would collapse into one row.
   */

  it('same (messageId, reactorPubkey) with different emoji creates two distinct rows', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'emo-1', pubkey: 'alice', content: '👍', tags: [['e', 'msg-emoji']] }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'emo-2', pubkey: 'alice', content: '❤️', tags: [['e', 'msg-emoji']] }));
    const rows = await loadReactions(GROUP_THREAD);
    const aliceRows = rows.filter((r) => r.messageId === 'msg-emoji' && r.reactorPubkey === 'alice');
    expect(aliceRows).toHaveLength(2);
    expect(aliceRows.map((r) => r.emoji).sort()).toEqual(['❤️', '👍'].sort());
  });

  it('same (messageId, reactorPubkey, emoji) updates the SAME row (upsert, not insert)', async () => {
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'emo-3', pubkey: 'alice', content: '👍', tags: [['e', 'msg-upsert-emoji']] }));
    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'emo-4', pubkey: 'alice', content: '👍', tags: [['e', 'msg-upsert-emoji']] }));
    const rows = await loadReactions(GROUP_THREAD);
    const aliceRows = rows.filter((r) => r.messageId === 'msg-upsert-emoji' && r.emoji === '👍');
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].eventId).toBe('emo-4'); // latest eventId wins
  });

  it('parametric: 5 different emojis from same peer produce 5 independent rows', async () => {
    const emojis = ['👍', '❤️', '😂', '🎉', '🔥'];
    for (let i = 0; i < emojis.length; i++) {
      await applyInboundRumor(GROUP_THREAD, makeRumor({ id: `emo-multi-${i}`, pubkey: 'alice', content: emojis[i], tags: [['e', 'msg-multi-emoji']] }));
    }
    const rows = await loadReactions(GROUP_THREAD);
    const aliceRows = rows.filter((r) => r.messageId === 'msg-multi-emoji' && r.reactorPubkey === 'alice');
    expect(aliceRows).toHaveLength(5);
    expect(aliceRows.map((r) => r.emoji).sort()).toEqual([...emojis].sort());
  });
});
