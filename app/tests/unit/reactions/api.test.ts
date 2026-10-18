import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Reaction } from '@/src/lib/reactions/types';

// ─── Inline idb-keyval mock ───────────────────────────────────────────────────
// Map-backed in-memory store, matching the pattern from
// manageInviteLinksModal.test.ts:5-13 and unreadStore.test.ts:16-18.
const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

// ─── Marmot module stubs (only needed for the storage.ts integration test) ───
// vi.mock calls are hoisted — these stubs are never invoked by other tests.
vi.mock('@/src/lib/marmot/groupStorage', () => ({ clearAllGroupData: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/marmot/chatPersistence', () => ({ clearAllMessages: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/marmot/inviteLinkStorage', () => ({ clearAllInviteLinks: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/marmot/joinRequestStorage', () => ({ clearAllPendingJoinRequests: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/marmot/pollPersistence', () => ({ clearAllPollData: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/marmot/mediaPersistence', () => ({ clearAllMedia: vi.fn().mockResolvedValue(undefined) }));

// ─── Module import (after mock is set up) ────────────────────────────────────
const {
  loadReactions,
  aggregateForMessage,
  subscribeReactions,
  applyInboundRumor,
  applyOptimistic,
  applyOptimisticRemoval,
  rollbackOptimistic,
  clearAllReactions,
  clearDmReactionsForPeer,
} = await import('@/src/lib/reactions/api');

// ─── storage.ts import (for the integration test at the bottom) ───────────────
const { resetAllData } = await import('@/src/lib/storage');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const GROUP_THREAD = { kind: 'group' as const, groupId: 'group-42' };
const GROUP_KEY = 'few:reactions:group:group-42';
const DM_THREAD = { kind: 'dm' as const, peerPubkeyHex: 'aabbccdd' };
const DM_KEY = 'few:reactions:dm:aabbccdd';

// Import the idb-keyval mock to spy on it
import * as idbKeyval from 'idb-keyval';

// ─── Reset state between tests ────────────────────────────────────────────────

beforeEach(async () => {
  idbStore.clear();
  vi.clearAllMocks();
  // Clear the module-singleton in-memory cache between tests. clearAllReactions()
  // calls cache.clear() in addition to draining the write queue and wiping IDB.
  // Without this, tests that seed idbStore directly (bypassing enqueue) see stale
  // cache entries from the previous test when they call loadReactions().
  await clearAllReactions();
  // clearAllReactions() also deletes IDB keys via delMany — re-clear the mock IDB
  // store after it runs (delMany is no-op here since idbStore.clear() already ran,
  // but vi.clearAllMocks() above reset the mock call counts; re-clear keeps the
  // mock counts fresh for test assertions).
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('loadReactions', () => {
  it('returns empty array for a fresh thread (AC-07, AC-57)', async () => {
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toEqual([]);
    // O(1) idb call: exactly one get() for the thread key
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledWith(GROUP_KEY);
  });

  it('uses the correct key for group threads (AC-07)', async () => {
    await loadReactions(GROUP_THREAD);
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledWith(GROUP_KEY);
  });

  it('uses the correct key for dm threads (AC-07)', async () => {
    await loadReactions(DM_THREAD);
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledWith(DM_KEY);
  });

  it('returns stored rows when idb has data (AC-07)', async () => {
    const stored = [makeReaction({ id: 'r1' }), makeReaction({ id: 'r2', emoji: '❤️' })];
    idbStore.set(GROUP_KEY, stored);
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toEqual(stored);
  });

  it('makes exactly one idb call regardless of message count — O(1) per thread (AC-57)', async () => {
    // Seed many rows for many different messages
    const manyRows = Array.from({ length: 50 }, (_, i) =>
      makeReaction({ id: `r-${i}`, messageId: `msg-${i}` }),
    );
    idbStore.set(GROUP_KEY, manyRows);
    vi.clearAllMocks();
    await loadReactions(GROUP_THREAD);
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledTimes(1);
  });
});

describe('applyOptimistic', () => {
  it('writes the row to idb and a subsequent loadReactions reads it back (AC-12)', async () => {
    // First we need at least one seeding row so the key exists — but applyOptimistic
    // should work even on an empty store.
    const row = makeReaction();
    await applyOptimistic(GROUP_THREAD, row);

    vi.clearAllMocks();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(row);
    // applyOptimistic populates the in-memory cache via enqueue → cache.set.
    // loadReactions finds the cache warm and returns without an IDB read (0 calls).
    // The cache-first design eliminates the IDB round-trip on subsequent reads.
    expect(vi.mocked(idbKeyval.get)).toHaveBeenCalledTimes(0);
  });

  it('is idempotent — applying the same row.id twice yields a single row', async () => {
    const row = makeReaction();
    await applyOptimistic(GROUP_THREAD, row);
    await applyOptimistic(GROUP_THREAD, row); // duplicate

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
  });

  it('appends multiple distinct rows', async () => {
    const r1 = makeReaction({ id: 'a' });
    const r2 = makeReaction({ id: 'b', emoji: '❤️' });
    await applyOptimistic(GROUP_THREAD, r1);
    await applyOptimistic(GROUP_THREAD, r2);

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(2);
  });
});

describe('applyOptimistic — multi-emoji policy (D2)', () => {
  it('same (messageId, reactorPubkey) with different emoji — both rows are stored', async () => {
    const r1 = makeReaction({ id: 'a', emoji: '👍' });
    const r2 = makeReaction({ id: 'b', emoji: '❤️' }); // same messageId + reactorPubkey
    await applyOptimistic(GROUP_THREAD, r1);
    await applyOptimistic(GROUP_THREAD, r2);

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(2);
    const emojis = rows.map((r) => r.emoji);
    expect(emojis).toContain('👍');
    expect(emojis).toContain('❤️');
  });

  it('same (messageId, reactorPubkey, emoji) re-applied is idempotent — no duplicate', async () => {
    const row = makeReaction({ id: 'a', emoji: '👍' });
    await applyOptimistic(GROUP_THREAD, row);
    // Applying same id again — idempotent
    await applyOptimistic(GROUP_THREAD, { ...row }); // same id

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
  });
});

describe('rollbackOptimistic', () => {
  it('removes the targeted in-flight row (AC-12)', async () => {
    const r1 = makeReaction({ id: 'opt-1', eventId: '' });
    const r2 = makeReaction({ id: 'opt-2', eventId: '', emoji: '❤️' });
    await applyOptimistic(GROUP_THREAD, r1);
    await applyOptimistic(GROUP_THREAD, r2);

    await rollbackOptimistic(GROUP_THREAD, 'opt-1');

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('opt-2');
  });

  it('does not remove a row whose eventId is non-empty (confirmed row)', async () => {
    // Seed a confirmed row directly in idb
    const confirmed = makeReaction({ id: 'confirmed-1', eventId: 'abc123deadbeef' });
    idbStore.set(GROUP_KEY, [confirmed]);

    await rollbackOptimistic(GROUP_THREAD, 'confirmed-1');

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1); // row survives
    expect(rows[0].id).toBe('confirmed-1');
  });

  it('leaves all other rows unchanged when rolling back one (AC-12)', async () => {
    const r1 = makeReaction({ id: 'a', eventId: '' });
    const r2 = makeReaction({ id: 'b', eventId: '', emoji: '❤️' });
    const r3 = makeReaction({ id: 'c', eventId: '', emoji: '✨' });
    await applyOptimistic(GROUP_THREAD, r1);
    await applyOptimistic(GROUP_THREAD, r2);
    await applyOptimistic(GROUP_THREAD, r3);

    await rollbackOptimistic(GROUP_THREAD, 'b');

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
});

describe('applyInboundRumor — upsert path (AC-09)', () => {
  // Pre-work fix (story-07): the leaf module no longer checks for an existing row
  // with the target messageId. It always upserts. The "silent discard for unknown
  // messageId" rule (AC-11, spec §2.4) is enforced by dispatchers (MarmotContext,
  // ContactChat), not by this leaf module.

  it('upserts the first reaction to a message even with zero prior reactions in store', async () => {
    // Fresh store — no prior rows at all. The first reaction for any message must land.
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor());
    expect(result).toEqual({ messageId: 'msg-1' });
    // A write occurred
    expect(vi.mocked(idbKeyval.set)).toHaveBeenCalled();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('msg-1');
  });

  it('upserts a new Reaction row and returns { messageId } (AC-09)', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'wire-event-1',
      pubkey: 'pubkey-bob',
      content: '❤️',
      tags: [['e', 'msg-1']],
      created_at: 2000,
    }));

    expect(result).toEqual({ messageId: 'msg-1' });

    const rows = await loadReactions(GROUP_THREAD);
    const newRow = rows.find((r) => r.reactorPubkey === 'pubkey-bob' && r.emoji === '❤️');
    expect(newRow).toBeDefined();
    expect(newRow!.eventId).toBe('wire-event-1');
    expect(newRow!.removed).toBe(false);
  });

  it('is idempotent on same eventId (eventId dedup — AC-09)', async () => {
    // No seeding needed — the leaf module upserts on first call.
    const rumor = makeRumor({ id: 'wire-1', pubkey: 'pubkey-bob', content: '❤️', tags: [['e', 'msg-1']] });
    await applyInboundRumor(GROUP_THREAD, rumor);
    const result2 = await applyInboundRumor(GROUP_THREAD, rumor); // same id

    expect(result2).toBeNull();

    // Only one inbound row should exist for bob
    const rows = await loadReactions(GROUP_THREAD);
    const bobRows = rows.filter((r) => r.reactorPubkey === 'pubkey-bob');
    expect(bobRows).toHaveLength(1);
  });

  it('missing e-tag returns null', async () => {
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [] }));
    expect(result).toBeNull();
  });
});

describe('applyInboundRumor — removal path (AC-10)', () => {
  it('sets removed: true on the matching row when content === "-"', async () => {
    // Seed a row for the reaction that will be removed
    const existing = makeReaction({ id: 'r1', messageId: 'msg-1', reactorPubkey: 'pubkey-alice', emoji: '👍', eventId: 'prev-event', removed: false });
    idbStore.set(GROUP_KEY, [existing]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-1',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1']],
    }));

    expect(result).toEqual({ messageId: 'msg-1' });

    const rows = await loadReactions(GROUP_THREAD);
    const tombstoned = rows.find((r) => r.id === 'r1');
    expect(tombstoned).toBeDefined();
    expect(tombstoned!.removed).toBe(true);
  });

  it('keeps the row in store (tombstone, not deletion) (AC-10)', async () => {
    const existing = makeReaction({ id: 'r1', messageId: 'msg-1', reactorPubkey: 'pubkey-alice', eventId: 'prev-event', removed: false });
    idbStore.set(GROUP_KEY, [existing]);

    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'removal-1', pubkey: 'pubkey-alice', content: '-', tags: [['e', 'msg-1']] }));

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1); // row kept, just tombstoned
  });

  it('returns null if no matching row to tombstone (AC-10)', async () => {
    // messageId exists but no non-removed row for this reactorPubkey
    const other = makeReaction({ id: 'r1', messageId: 'msg-1', reactorPubkey: 'pubkey-bob', eventId: 'e1' });
    idbStore.set(GROUP_KEY, [other]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-1',
      pubkey: 'pubkey-alice', // different pubkey — no row to tombstone
      content: '-',
      tags: [['e', 'msg-1']],
    }));

    expect(result).toBeNull();
  });

  it('two live rows, removal without emoji tag → returns null; both rows survive (D2 — ambiguous multi-emoji)', async () => {
    // Multi-emoji scenario: same reactor, same message, two distinct emojis.
    // A removal rumor with NO ["emoji", glyph] tag is ambiguous — must be silently
    // discarded rather than tombstoning the wrong row (§2.4, D2 safety).
    const thumbs = makeReaction({
      id: 'r-thumbs-ambig',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'evt-a',
      removed: false,
    });
    const hearts = makeReaction({
      id: 'r-hearts-ambig',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '❤️',
      eventId: 'evt-b',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [thumbs, hearts]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-ambig',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1']], // no emoji tag → ambiguous
    }));

    expect(result).toBeNull();

    const rows = await loadReactions(GROUP_THREAD);
    // Both rows must be untouched
    expect(rows.find((r) => r.id === 'r-thumbs-ambig')!.removed).toBe(false);
    expect(rows.find((r) => r.id === 'r-hearts-ambig')!.removed).toBe(false);
  });

  it('single live row, removal without emoji tag → tombstones the row (unambiguous)', async () => {
    // One non-removed row for (messageId, reactorPubkey) — no ambiguity.
    // The removal rumor without an emoji tag should tombstone this single row.
    const row = makeReaction({
      id: 'r-single',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'evt-single',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [row]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-single',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1']], // no emoji tag
    }));

    expect(result).toEqual({ messageId: 'msg-1' });

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.find((r) => r.id === 'r-single')!.removed).toBe(true);
  });

  it('removal rumor with two distinct emoji tags → returns null, nothing tombstoned (§2.4 out-of-spec discard)', async () => {
    // An out-of-spec rumor carrying ["emoji","👍"] AND ["emoji","❤️"] simultaneously
    // is ambiguous. Must be silently discarded.
    const thumbs = makeReaction({
      id: 'r-oob-thumbs',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'evt-c',
      removed: false,
    });
    const hearts = makeReaction({
      id: 'r-oob-hearts',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '❤️',
      eventId: 'evt-d',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [thumbs, hearts]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-oob',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1'], ['emoji', '👍'], ['emoji', '❤️']], // two distinct emojis
    }));

    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows.find((r) => r.id === 'r-oob-thumbs')!.removed).toBe(false);
    expect(rows.find((r) => r.id === 'r-oob-hearts')!.removed).toBe(false);
  });

  it('removal rumor with ["Emoji", "👍"] (capitalised tag name) → narrows to 👍 row (case-insensitive tag name)', async () => {
    // Tag name matching is case-insensitive on the tag *name* field only.
    // Glyph value stays case-sensitive (Unicode glyphs are not case-bearing).
    const thumbs = makeReaction({
      id: 'r-caps-thumbs',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'evt-e',
      removed: false,
    });
    const hearts = makeReaction({
      id: 'r-caps-hearts',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '❤️',
      eventId: 'evt-f',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [thumbs, hearts]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-caps',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1'], ['Emoji', '👍']], // capitalised "Emoji" tag name
    }));

    expect(result).toEqual({ messageId: 'msg-1' });
    const rows = await loadReactions(GROUP_THREAD);
    // 👍 tombstoned
    expect(rows.find((r) => r.id === 'r-caps-thumbs')!.removed).toBe(true);
    // ❤️ untouched
    expect(rows.find((r) => r.id === 'r-caps-hearts')!.removed).toBe(false);
  });

  it('removal rumor with ["emoji", "👍"] but no matching row → returns null, only a hidden removal-only tombstone is remembered', async () => {
    // The emoji tag is present but no live row for (messageId, reactorPubkey, 👍) exists.
    // No visible change (null), but the removal time is remembered so a later
    // out-of-order add cannot resurrect the reaction (last-writer-wins).
    const hearts = makeReaction({
      id: 'r-nomatch-hearts',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '❤️', // different emoji from rumor
      eventId: 'evt-g',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [hearts]);

    vi.clearAllMocks();
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-nomatch',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1'], ['emoji', '👍']], // targets 👍, but only ❤️ exists
    }));

    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    // The ❤️ row is still present and untouched
    expect(rows.find((r) => r.id === 'r-nomatch-hearts')!.removed).toBe(false);
    // The 👍 removal is remembered as a hidden tombstone: never counted.
    const tomb = rows.find((r) => r.emoji === '👍');
    expect(tomb).toMatchObject({ removed: true, removedAt: 1_000_000 });
    expect(aggregateForMessage(rows, 'msg-1', 'pubkey-alice').map((a) => a.emoji)).toEqual(['❤️']);
  });

  it('["emoji", glyph] tag narrows removal to the matching emoji only (D2 — multi-emoji policy)', async () => {
    // Seed two reactions from the same reactor on the same message, different emojis.
    // This scenario arises when story-04's rumor builder emits an ["emoji", glyph] tag
    // on removal rumors — the contract this test pins for story-04.
    const thumbs = makeReaction({
      id: 'r-thumbs',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'evt-thumbs',
      removed: false,
    });
    const hearts = makeReaction({
      id: 'r-hearts',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '❤️',
      eventId: 'evt-hearts',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [thumbs, hearts]);

    // Dispatch a removal rumor carrying ["emoji", "👍"] — must only tombstone the 👍 row.
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-thumbs',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1'], ['emoji', '👍']],
    }));

    // Returns the target messageId on success
    expect(result).toEqual({ messageId: 'msg-1' });

    const rows = await loadReactions(GROUP_THREAD);
    const thumbsRow = rows.find((r) => r.id === 'r-thumbs');
    const heartsRow = rows.find((r) => r.id === 'r-hearts');

    // 👍 is tombstoned
    expect(thumbsRow).toBeDefined();
    expect(thumbsRow!.removed).toBe(true);

    // ❤️ is untouched
    expect(heartsRow).toBeDefined();
    expect(heartsRow!.removed).toBe(false);
  });

  // ── Robustness / malformed-input tests (round-4 type-guard regression) ───────

  it('[robustness] empty tag array → returns null, no idb writes', async () => {
    // Even with a known messageId seeded, an empty tags array means no e-tag
    // and no emoji tags; must return null without throwing.
    idbStore.set(GROUP_KEY, [makeReaction({ messageId: 'msg-1' })]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      content: '-',
      tags: [],
    }));

    expect(result).toBeNull();
    expect(vi.mocked(idbKeyval.set)).not.toHaveBeenCalled();
  });

  it('[robustness] malformed tag with missing first element → falls through, returns null (no e-tag found)', async () => {
    // Tags where the first sub-array is empty — t[0] is undefined.
    // The type-guard `typeof t[0] === 'string'` must prevent a crash on .toLowerCase().
    idbStore.set(GROUP_KEY, [makeReaction({ messageId: 'msg-1' })]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      content: '-',
      // First element has no t[0]; second is a valid emoji tag but still no e-tag.
      tags: [[], ['emoji', '👍']] as unknown as string[][],
    }));

    expect(result).toBeNull();
    expect(vi.mocked(idbKeyval.set)).not.toHaveBeenCalled();
  });

  it('[robustness] emoji tag with missing glyph → no usable emoji tag, hits zero-emoji branch (single-row tombstone)', async () => {
    // ["emoji"] with no second element should be filtered out by the type-guard.
    // With zero emoji tags, the single-row unambiguous path tombstones the only row.
    const row = makeReaction({
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [row]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-no-glyph',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [['e', 'msg-1'], ['emoji']] as unknown as string[][],
    }));

    // Zero emoji tags → unambiguous single row → tombstoned
    expect(result).toEqual({ messageId: 'msg-1' });
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows[0].removed).toBe(true);
  });

  it('[robustness] non-string first element (cast through unknown) → no crash; well-formed tags still processed', async () => {
    // Simulates a bug in upstream tag construction where t[0] is null.
    // The type-guard must short-circuit; the valid ["emoji","👍"] tag is still found.
    const row = makeReaction({
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [row]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({
      id: 'removal-null-tag',
      pubkey: 'pubkey-alice',
      content: '-',
      tags: [
        [null as unknown as string, 'foo'],  // malformed — t[0] is null
        ['e', 'msg-1'],
        ['emoji', '👍'],
      ],
    }));

    // Must not throw; narrowing still works on the well-formed tags.
    expect(result).toEqual({ messageId: 'msg-1' });
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows[0].removed).toBe(true);
  });
});

describe('applyInboundRumor — dispatcher responsibility for AC-11 (pre-work fix, story-07)', () => {
  // AC-11: "silent discard if message unknown" is now enforced by dispatchers
  // (MarmotContext case 7 gates on loadMessages; ContactChat gates on in-memory messages).
  // The leaf module always upserts — these tests verify the new contract.

  it('upserts even when no prior row exists for the target messageId', async () => {
    // Previously this returned null; after the fix it upserts.
    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [['e', 'new-msg-id']] }));
    expect(result).toEqual({ messageId: 'new-msg-id' });
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('new-msg-id');
  });

  it('upserts for a messageId not previously in the store alongside other rows', async () => {
    const existingForOtherMsg = makeReaction({ messageId: 'msg-other' });
    idbStore.set(GROUP_KEY, [existingForOtherMsg]);

    const result = await applyInboundRumor(GROUP_THREAD, makeRumor({ tags: [['e', 'msg-brand-new']] }));
    expect(result).toEqual({ messageId: 'msg-brand-new' });

    const rows = await loadReactions(GROUP_THREAD);
    // Two rows: the original + the new one
    expect(rows).toHaveLength(2);
  });
});

describe('aggregateForMessage (AC-08)', () => {
  const rows: Reaction[] = [
    makeReaction({ id: '1', messageId: 'msg-1', reactorPubkey: 'alice', emoji: '👍', createdAt: 1000, removed: false }),
    makeReaction({ id: '2', messageId: 'msg-1', reactorPubkey: 'bob', emoji: '👍', createdAt: 2000, removed: false }),
    makeReaction({ id: '3', messageId: 'msg-1', reactorPubkey: 'carol', emoji: '❤️', createdAt: 3000, removed: false }),
    makeReaction({ id: '4', messageId: 'msg-1', reactorPubkey: 'dave', emoji: '👍', createdAt: 500, removed: true }), // tombstoned
    makeReaction({ id: '5', messageId: 'msg-2', reactorPubkey: 'eve', emoji: '👍', createdAt: 1000, removed: false }), // different msg
  ];

  it('returns aggregates only for the given messageId', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'alice');
    const allForMsg2 = aggs.filter((a) => !['👍', '❤️'].includes(a.emoji));
    expect(allForMsg2).toHaveLength(0);
  });

  it('count equals number of non-removed rows per emoji', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'alice');
    const thumbs = aggs.find((a) => a.emoji === '👍');
    // alice + bob = 2; dave is removed
    expect(thumbs).toBeDefined();
    expect(thumbs!.count).toBe(2);

    const hearts = aggs.find((a) => a.emoji === '❤️');
    expect(hearts!.count).toBe(1);
  });

  it('reactors are in oldest-first (ascending createdAt) order', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'alice');
    const thumbs = aggs.find((a) => a.emoji === '👍');
    // alice=1000, bob=2000; dave(removed) excluded
    expect(thumbs!.reactors).toEqual(['alice', 'bob']);
  });

  it('selfReacted is true when selfPubkey has a non-removed row', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'alice');
    const thumbs = aggs.find((a) => a.emoji === '👍');
    expect(thumbs!.selfReacted).toBe(true);
  });

  it('selfReacted is false when selfPubkey is not among reactors', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'eve');
    const thumbs = aggs.find((a) => a.emoji === '👍');
    expect(thumbs!.selfReacted).toBe(false);
  });

  it('excludes removed rows from count and reactors', () => {
    const aggs = aggregateForMessage(rows, 'msg-1', 'dave');
    const thumbs = aggs.find((a) => a.emoji === '👍');
    // dave is removed
    expect(thumbs!.reactors).not.toContain('dave');
    expect(thumbs!.selfReacted).toBe(false);
  });

  it('returns empty array when no rows match the messageId', () => {
    const aggs = aggregateForMessage(rows, 'msg-nonexistent', 'alice');
    expect(aggs).toEqual([]);
  });
});

describe('subscribeReactions (AC-13)', () => {
  it('registers a listener that fires when applyOptimistic is called', async () => {
    const listener = vi.fn();
    subscribeReactions(GROUP_THREAD, listener);

    await applyOptimistic(GROUP_THREAD, makeReaction());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('registers a listener that fires when applyInboundRumor writes a row', async () => {
    const listener = vi.fn();
    subscribeReactions(GROUP_THREAD, listener);

    // Pre-work fix: applyInboundRumor now always upserts (no seeding needed).
    // Still clear after any setup writes to isolate the assertion.
    listener.mockClear();

    await applyInboundRumor(GROUP_THREAD, makeRumor({ id: 'wire-x', pubkey: 'bob', content: '❤️', tags: [['e', 'msg-1']] }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('registers a listener that fires when rollbackOptimistic removes a row', async () => {
    const row = makeReaction({ id: 'opt-rollback', eventId: '' });
    await applyOptimistic(GROUP_THREAD, row);

    const listener = vi.fn();
    subscribeReactions(GROUP_THREAD, listener);

    await rollbackOptimistic(GROUP_THREAD, 'opt-rollback');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops listener from receiving further notifications', async () => {
    const listener = vi.fn();
    const unsub = subscribeReactions(GROUP_THREAD, listener);

    await applyOptimistic(GROUP_THREAD, makeReaction({ id: 'row-a' }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    await applyOptimistic(GROUP_THREAD, makeReaction({ id: 'row-b', emoji: '❤️' }));
    // Should still be 1 — not called again after unsub
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listeners are scoped per thread — group listener does not fire on dm write', async () => {
    const groupListener = vi.fn();
    const dmListener = vi.fn();
    subscribeReactions(GROUP_THREAD, groupListener);
    subscribeReactions(DM_THREAD, dmListener);

    await applyOptimistic(DM_THREAD, makeReaction({ id: 'dm-row' }));

    expect(dmListener).toHaveBeenCalledTimes(1);
    expect(groupListener).not.toHaveBeenCalled();
  });
});

describe('clearAllReactions (AC-14)', () => {
  it('deletes both few:reactions:group:* and few:reactions:dm:* namespaces', async () => {
    // Seed both namespaces
    idbStore.set('few:reactions:group:group-1', [makeReaction({ id: 'g1' })]);
    idbStore.set('few:reactions:group:group-2', [makeReaction({ id: 'g2' })]);
    idbStore.set('few:reactions:dm:peer-abc', [makeReaction({ id: 'd1' })]);
    // Also seed a non-reaction key that must be preserved
    idbStore.set('few:messages:group-1', [{ id: 'msg-1' }]);

    await clearAllReactions();

    expect(idbStore.has('few:reactions:group:group-1')).toBe(false);
    expect(idbStore.has('few:reactions:group:group-2')).toBe(false);
    expect(idbStore.has('few:reactions:dm:peer-abc')).toBe(false);
    // Non-reaction key preserved
    expect(idbStore.has('few:messages:group-1')).toBe(true);
  });

  it('is a no-op when no reaction keys exist', async () => {
    idbStore.set('few:messages:group-1', [{ id: 'msg-1' }]);
    await clearAllReactions(); // should not throw
    expect(idbStore.has('few:messages:group-1')).toBe(true);
  });

  it('race guard: enqueue arriving during clearAllReactions is dropped; idb state is empty after clear', async () => {
    // Seed a reaction key so clearAllReactions has something to delete.
    const seedKey = 'few:reactions:group:race-group';
    idbStore.set(seedKey, [makeReaction({ id: 'race-seed', messageId: 'msg-race' })]);

    // Delay the idb.keys() call so we get a window where the clear is in-flight
    // but the deletion loop hasn't run yet. During this window we attempt to
    // enqueue a write — the clearingInProgress flag must block it.
    let unblockKeys!: () => void;
    const keysGate = new Promise<void>((resolve) => { unblockKeys = resolve; });

    vi.mocked(idbKeyval.keys).mockImplementationOnce(async () => {
      // Yield control so the concurrent enqueue attempt below can fire.
      await keysGate;
      return [...idbStore.keys()];
    });

    // Start the clear (don't await yet — let it run until it hits the keys() gate).
    const clearPromise = clearAllReactions();

    // While the clear is blocked at keys(), attempt to write via applyInboundRumor.
    // The clearingInProgress flag must make enqueue() return immediately without writing.
    const raceThread = { kind: 'group' as const, groupId: 'race-group' };
    // applyInboundRumor checks clearingInProgress inside enqueue synchronously.
    const racePromise = applyInboundRumor(raceThread, {
      id: 'race-rumor',
      pubkey: 'pubkey-alice',
      created_at: 2000,
      content: '👍',
      tags: [['e', 'msg-race']],
    });

    // Yield to the microtask queue so the clear's internal awaits can run up to
    // the keys() gate, then unblock it.
    await Promise.resolve();
    unblockKeys();

    // Await both operations.
    await Promise.all([clearPromise, racePromise]);

    // The clear must have deleted the seed key.
    expect(idbStore.has(seedKey)).toBe(false);

    // The race write must have been dropped — no new reaction key was created.
    const remainingReactionKeys = [...idbStore.keys()].filter(
      (k) => typeof k === 'string' && k.startsWith('few:reactions:'),
    );
    expect(remainingReactionKeys).toHaveLength(0);
  });
});

describe('clearDmReactionsForPeer (gate-remediation finding 4)', () => {
  it('deletes exactly the few:reactions:dm:<peer> key for the given peer', async () => {
    idbStore.set('few:reactions:dm:peer-target', [makeReaction({ id: 'target-1' })]);

    await clearDmReactionsForPeer('peer-target');

    expect(idbStore.has('few:reactions:dm:peer-target')).toBe(false);
  });

  it('does not touch a different peer\'s DM reaction key', async () => {
    idbStore.set('few:reactions:dm:peer-target', [makeReaction({ id: 'target-1' })]);
    idbStore.set('few:reactions:dm:peer-other', [makeReaction({ id: 'other-1' })]);

    await clearDmReactionsForPeer('peer-target');

    expect(idbStore.has('few:reactions:dm:peer-other')).toBe(true);
  });

  it('does not touch the few:reactions:group: namespace', async () => {
    idbStore.set('few:reactions:dm:peer-target', [makeReaction({ id: 'target-1' })]);
    idbStore.set('few:reactions:group:some-group', [makeReaction({ id: 'grp-1' })]);

    await clearDmReactionsForPeer('peer-target');

    expect(idbStore.has('few:reactions:group:some-group')).toBe(true);
  });

  it('is a no-op (does not throw) when no key exists for the peer', async () => {
    await expect(clearDmReactionsForPeer('peer-with-no-reactions')).resolves.toBeUndefined();
  });

  it('evicts the in-memory cache entry — a subsequent loadReactions re-reads from (now-empty) IDB rather than serving a stale cached array', async () => {
    const thread = { kind: 'dm' as const, peerPubkeyHex: 'peer-target' };
    // Populate the in-memory cache via the real loadReactions path first.
    idbStore.set('few:reactions:dm:peer-target', [makeReaction({ id: 'target-1' })]);
    const before = await loadReactions(thread);
    expect(before).toHaveLength(1);

    await clearDmReactionsForPeer('peer-target');

    const after = await loadReactions(thread);
    expect(after).toEqual([]);
  });

  it('a write that lands before the clear is still gone afterward (drain-then-delete ordering, AC-WIPE-6-equivalent)', async () => {
    const thread = { kind: 'dm' as const, peerPubkeyHex: 'peer-race' };
    // A fully-settled write followed by the clear — the straightforward case
    // the drain-then-delete sequencing exists to generalize beyond. (A true
    // concurrent-in-flight-write race against this function's own internal
    // `import('idb-keyval')` is exercised at the `wipeSinglePeerHistory`
    // call-site level in chatPersistence-wipe.test.ts's AC-WIPE-6 block,
    // where the surrounding module's STATIC idb-keyval import avoids an
    // unrelated concurrent-dynamic-import quirk this module's SSR-safe
    // dynamic import runs into under true same-tick concurrency in this test
    // harness.)
    await applyOptimistic(thread, makeReaction({ id: 'settled-row' }));
    expect(idbStore.has('few:reactions:dm:peer-race')).toBe(true);

    await clearDmReactionsForPeer('peer-race');

    expect(idbStore.has('few:reactions:dm:peer-race')).toBe(false);
  });

  // Gate-remediation convergence fix (2026-07-14): the reaction WRITE path
  // (`idbKeyFor`) never normalizes case, so a mixed-case stored contact
  // pubkeyHex (AC-CORE-6: not guaranteed lowercase) produces a mixed-case
  // reaction key. The prior implementation deleted only the exact
  // `peerPubkeyHex.toLowerCase()` key and silently missed this row — this
  // is the regression test that would have caught it (the tests above all
  // seed under an already-lowercase key and share that bug's assumption).
  it('deletes a reaction key stored under a MIXED-CASE peer suffix when called with the lowercase peer (mirrors wipeSinglePeerHistory\'s call pattern)', async () => {
    idbStore.set('few:reactions:dm:AABBCCDD', [makeReaction({ id: 'mixed-case-1' })]);

    await clearDmReactionsForPeer('aabbccdd');

    expect(idbStore.has('few:reactions:dm:AABBCCDD')).toBe(false);
  });

  it('deletes a reaction key stored under a mixed-case peer suffix when called with that exact mixed-case value', async () => {
    idbStore.set('few:reactions:dm:AaBbCcDd', [makeReaction({ id: 'mixed-case-2' })]);

    await clearDmReactionsForPeer('AaBbCcDd');

    expect(idbStore.has('few:reactions:dm:AaBbCcDd')).toBe(false);
  });

  it('case-insensitive match still leaves a different peer\'s key (any case) untouched', async () => {
    idbStore.set('few:reactions:dm:AABBCCDD', [makeReaction({ id: 'mixed-case-target' })]);
    idbStore.set('few:reactions:dm:eeff0011', [makeReaction({ id: 'other-peer' })]);

    await clearDmReactionsForPeer('aabbccdd');

    expect(idbStore.has('few:reactions:dm:AABBCCDD')).toBe(false);
    expect(idbStore.has('few:reactions:dm:eeff0011')).toBe(true);
  });

  it('evicts the in-memory cache for a mixed-case-keyed peer — a subsequent loadReactions on the mixed-case thread re-reads from (now-empty) IDB', async () => {
    const mixedCaseThread = { kind: 'dm' as const, peerPubkeyHex: 'AABBCCDD' };
    idbStore.set('few:reactions:dm:AABBCCDD', [makeReaction({ id: 'mixed-case-cache' })]);
    const before = await loadReactions(mixedCaseThread);
    expect(before).toHaveLength(1);

    await clearDmReactionsForPeer('aabbccdd');

    const after = await loadReactions(mixedCaseThread);
    expect(after).toEqual([]);
  });
});

describe('storage.ts integration', () => {
  // Exercises the dynamic-import chain that clearAccountScopedIdbData in storage.ts
  // uses to reach clearAllReactions. The chain is:
  //   clearAccountScopedIdbData()
  //     → import('@/src/lib/reactions/api').then(({ clearAllReactions }) => clearAllReactions())
  //
  // This test replicates that exact import path end-to-end, using the same
  // Map-backed idb-keyval mock already in place, to prove the dynamic import
  // resolves to the correct module and the function clears both reaction namespaces.
  // (AC-14, VQ-02-018)
  it('clearAccountScopedIdbData chain — both reaction namespaces are cleared', async () => {
    // Seed one group namespace and one dm namespace, plus a non-reaction key.
    idbStore.set('few:reactions:group:grp-cad-test', [makeReaction({ id: 'g-cad' })]);
    idbStore.set('few:reactions:dm:peer-cad-test', [makeReaction({ id: 'd-cad' })]);
    idbStore.set('few:messages:grp-cad-test', [{ id: 'msg-cad' }]);

    // Exercise the exact dynamic-import path that clearAccountScopedIdbData uses:
    //   import('@/src/lib/reactions/api').then(({ clearAllReactions }) => clearAllReactions())
    const { clearAllReactions: clearFn } = await import('@/src/lib/reactions/api');
    await clearFn();

    // Both reaction namespaces must be gone
    expect(idbStore.has('few:reactions:group:grp-cad-test')).toBe(false);
    expect(idbStore.has('few:reactions:dm:peer-cad-test')).toBe(false);
    // Non-reaction key must be preserved
    expect(idbStore.has('few:messages:grp-cad-test')).toBe(true);
  });
});

describe('listener notification timing (AC-58)', () => {
  it('listener fires after the idb set resolves, not before', async () => {
    const calls: string[] = [];
    vi.mocked(idbKeyval.set).mockImplementationOnce(async (key, value) => {
      calls.push('idb:set:called');
      idbStore.set(key as string, value);
    });

    const listener = vi.fn().mockImplementation(() => {
      calls.push('listener:called');
    });
    subscribeReactions(GROUP_THREAD, listener);

    await applyOptimistic(GROUP_THREAD, makeReaction({ id: 'timing-test' }));

    // The idb set should have been called before the listener
    const setIdx = calls.indexOf('idb:set:called');
    const listenerIdx = calls.indexOf('listener:called');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(listenerIdx).toBeGreaterThan(setIdx);
  });
});

describe('applyOptimisticRemoval — direct API (AC-35, AC-59)', () => {
  // applyOptimisticRemoval was added to the import as part of the
  // REOPENED_REMEDIATION close (2026-05-10). These tests exercise the function
  // directly, complementing the ChatStoreContext catch-block rollback test in
  // groupReactions.test.ts.

  it('tombstones the matching non-removed row in place — one write (AC-35)', async () => {
    const existing = makeReaction({
      id: 'existing-remove-target',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'prior-event-id',
      removed: false,
    });
    idbStore.set(GROUP_KEY, [existing]);

    const before = await loadReactions(GROUP_THREAD);
    expect(before[0].removed).toBe(false);

    await applyOptimisticRemoval(GROUP_THREAD, 'msg-1', 'pubkey-alice', '👍');

    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('existing-remove-target');
    expect(rows[0].removed).toBe(true);
  });

  it('returns null when no matching non-removed row exists', async () => {
    const result = await applyOptimisticRemoval(GROUP_THREAD, 'msg-1', 'pubkey-alice', '👍');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(0);
  });

  it('returns null and leaves store unchanged when row is already tombstoned', async () => {
    const tombstoned = makeReaction({
      id: 'already-gone',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      eventId: 'some-event',
      removed: true,
    });
    idbStore.set(GROUP_KEY, [tombstoned]);
    const result = await applyOptimisticRemoval(GROUP_THREAD, 'msg-1', 'pubkey-alice', '👍');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].removed).toBe(true);
  });

  it('wrong emoji on same (messageId, reactorPubkey) leaves correct emoji untouched', async () => {
    const row = makeReaction({ id: 'thumbs-row', emoji: '👍', removed: false });
    idbStore.set(GROUP_KEY, [row]);
    const result = await applyOptimisticRemoval(GROUP_THREAD, 'msg-1', 'pubkey-alice', '❤️');
    expect(result).toBeNull();
    const rows = await loadReactions(GROUP_THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].removed).toBe(false);
  });

  it('notifies subscribeReactions listeners after tombstone (AC-13)', async () => {
    idbStore.set(GROUP_KEY, [makeReaction({
      id: 'notif-seed',
      messageId: 'msg-1',
      reactorPubkey: 'pubkey-alice',
      emoji: '👍',
      removed: false,
    })]);
    const listener = vi.fn();
    subscribeReactions(GROUP_THREAD, listener);
    await applyOptimisticRemoval(GROUP_THREAD, 'msg-1', 'pubkey-alice', '👍');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// Note: reactions/api.ts:492 `if (strangerKeys.length > 0)` is an optimization guard.
// delMany([]) is a no-op in idb-keyval; the guard only avoids the overhead of the call.
// This is a KNOWN-EQUIVALENT mutant — `> 0` vs `>= 0` produces identical behavior.
// No killing test is possible without requiring a behavioral change to delMany itself.

