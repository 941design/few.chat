// @vitest-environment node
/**
 * Reactions on the history-sink path: a reaction whose target message has not
 * landed yet is HELD (never dropped) and applied when the target arrives; a
 * withdrawn reaction (own or another member's) is RECOMPUTED away.
 *
 *  AC-WDR-2  a withdrawn rumor's stored effect is dropped, own or another member's.
 *  AC-WDR-7  the recompute equals dispatching only the surviving rumors into empty stores (see the oracle in
 *            reactionRecompute.test.ts; the cases here pin the store contract and the held-queue bounds).
 *  Hold queue: bounded (TTL, a per-sender share, a thread cap), deduped by (rumor id, sender), removed with
 *  its thread (a group's by purgeHeldReactionsForGroup).
 *
 * Real collaborators: the reactions store, chatPersistence and the app
 * HistoryBackend over fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get as idbGet } from 'idb-keyval';

// One-shot failure injection for the reactions rows write (held-queue writes are never failed).
const inject = vi.hoisted(() => ({ failNextRowsWrite: false }));
vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    set: (key: IDBValidKey, value: unknown, store?: Parameters<typeof real.set>[2]) => {
      if (inject.failNextRowsWrite && typeof key === 'string' && key.startsWith('few:reactions:group:')) {
        inject.failNextRowsWrite = false;
        return Promise.reject(new Error('storage down'));
      }
      return real.set(key, value, store);
    },
  };
});
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createReactionGroupHandler } from '@/src/lib/marmot/handlers/reactionHandler';
import { appendMessage, loadMessages } from '@/src/lib/marmot/chatPersistence';
import {
  HELD_REACTION_CAP,
  HELD_REACTION_TTL_MS,
  applyInboundRumor,
  applyOptimistic,
  clearAllReactions,
  HELD_REACTION_SENDER_CAP,
  holdReaction,
  loadReactions,
  purgeHeldReactionsForGroup,
  recomputeMessageReactions,
  releaseHeldReactions,
} from '@/src/lib/reactions/api';
import type { ApplicationRumor, AuthenticatedSender, RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import type { ReactionThreadKey } from '@/src/lib/reactions/types';

const SELF = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const MALLORY = 'cc'.repeat(32);
const ALICE = 'dd'.repeat(32);
const sender = (pubkey: string): AuthenticatedSender => ({ pubkey, authenticity: 'mls' });

let counter = 0;
let G: string;
let thread: ReactionThreadKey;
let heldKey: string;

beforeEach(() => {
  G = (++counter).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
  thread = { kind: 'group', groupId: G };
  heldKey = `few:reactions:held:group:${G}`;
});
afterEach(() => {
  vi.useRealTimers();
});

const rx = (id: string, target: string, content = '+', createdAt = 1_700_000_000, tags: string[][] = []): ApplicationRumor => ({
  id,
  pubkey: 'ee'.repeat(32), // never trusted: attribution is the sender
  created_at: createdAt,
  kind: 7,
  tags: [['e', target], ...tags],
  content,
});
const removal = (id: string, target: string, emoji: string, createdAt: number) => rx(id, target, '-', createdAt, [['emoji', emoji]]);
const live = async () =>
  (await loadReactions(thread)).filter((r) => !r.removed).map((r) => [r.messageId, r.reactorPubkey, r.emoji]);
const sig = (rumor: ApplicationRumor, account: string, seq: number): RecomputeSignal => ({ rumor, sender: account, eventId: `ev-${rumor.id}-${seq}`, seq, receivedAt: 1_700_000_000_000 + seq });
const heldIds = async () => ((await idbGet<{ rumor: { id: string } }[]>(heldKey)) ?? []).map((e) => e.rumor.id);

describe('hold then release', () => {
  it('a held reaction is applied exactly once when its target lands, and the held queue empties', async () => {
    await holdReaction(thread, rx('r1', 'm1', '👍'), sender(BOB));
    expect(await live()).toEqual([]);
    expect(await heldIds()).toEqual(['r1']);

    expect(await releaseHeldReactions(thread, 'm1')).toBe(true);
    expect(await live()).toEqual([['m1', BOB, '👍']]);
    expect(await heldIds()).toEqual([]);

    expect(await releaseHeldReactions(thread, 'm1')).toBe(false);
    expect((await loadReactions(thread)).length).toBe(1);
  });

  it('releases only the reactions of the message that landed, attributed to the authenticated sender', async () => {
    await holdReaction(thread, rx('r1', 'm1', '👍'), sender(BOB));
    await holdReaction(thread, rx('r2', 'm2', '🎉'), sender(ALICE));
    await releaseHeldReactions(thread, 'm2');
    expect(await live()).toEqual([['m2', ALICE, '🎉']]);
    expect(await heldIds()).toEqual(['r1']);
  });

  it('resolves false when every held reaction was already applied (no visible change)', async () => {
    await applyInboundRumor(thread, rx('r1', 'm1', '👍'), sender(BOB));
    await holdReaction(thread, rx('r1', 'm1', '👍'), sender(BOB));
    expect(await releaseHeldReactions(thread, 'm1')).toBe(false);
    expect(await heldIds()).toEqual([]);
  });

  it('a failing apply rejects and leaves the unapplied reactions held for a retry', async () => {
    await holdReaction(thread, rx('r1', 'm1', '👍'), sender(BOB));
    inject.failNextRowsWrite = true;
    await expect(releaseHeldReactions(thread, 'm1')).rejects.toThrow('storage down');
    expect(await heldIds()).toEqual(['r1']);
    expect(await releaseHeldReactions(thread, 'm1')).toBe(true);
    expect(await heldIds()).toEqual([]);
  });
});

describe('hold queue bounds', () => {
  it('dedups by rumor id', async () => {
    await holdReaction(thread, rx('r1', 'm1'), sender(BOB));
    await holdReaction(thread, rx('r1', 'm1'), sender(BOB));
    expect(await heldIds()).toEqual(['r1']);
  });

  it('does not hold a rumor without a target', async () => {
    await holdReaction(thread, { ...rx('r1', 'm1'), tags: [] }, sender(BOB));
    expect(await heldIds()).toEqual([]);
  });

  it('dedups by (rumor id, sender): the same rumor id from another sender is its own entry', async () => {
    await holdReaction(thread, rx('r1', 'm1'), sender(BOB));
    await holdReaction(thread, rx('r1', 'm1'), sender(MALLORY));
    const held = (await idbGet<{ rumor: { id: string }; sender: { pubkey: string } }[]>(heldKey)) ?? [];
    expect(held.map((e) => [e.rumor.id, e.sender.pubkey])).toEqual([['r1', BOB], ['r1', MALLORY]]);
  });

  it("one sender's share is capped: past it that sender's own oldest is dropped, nobody else's", async () => {
    await holdReaction(thread, rx('a1', 'm1'), sender(ALICE));
    for (let i = 0; i < HELD_REACTION_SENDER_CAP + 3; i++) await holdReaction(thread, rx(`r${i}`, 'm1'), sender(BOB));
    const ids = await heldIds();
    expect(ids).toHaveLength(HELD_REACTION_SENDER_CAP + 1);
    expect(ids[0]).toBe('a1');
    expect(ids[1]).toBe('r3');
    expect(ids[ids.length - 1]).toBe(`r${HELD_REACTION_SENDER_CAP + 2}`);
  });

  it('the thread cap evicts from the sender holding the most, never from a quiet sender', async () => {
    const senders = ['01', '02', '03', '04', '05'].map((b) => b.repeat(32));
    // five senders fill the thread exactly (5 x 40 = 200 = cap); the quiet sender holds one entry
    const quiet = 'ee'.repeat(32);
    await holdReaction(thread, rx('quiet', 'm1'), sender(quiet));
    for (const s of senders) for (let i = 0; i < 40; i++) await holdReaction(thread, rx(`${s.slice(0, 2)}-${i}`, 'm1'), sender(s));
    expect(await heldIds()).toHaveLength(HELD_REACTION_CAP);
    expect(await heldIds()).toContain('quiet');
    // the first sender (most entries, oldest) paid for it
    expect((await heldIds()).filter((id) => id.startsWith('01-'))).toHaveLength(39);
  });

  it('drops an entry older than the TTL on the next access', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await holdReaction(thread, rx('old', 'm1'), sender(BOB));
    vi.setSystemTime(Date.now() + HELD_REACTION_TTL_MS - 1000);
    await holdReaction(thread, rx('fresh', 'm1'), sender(BOB));
    expect(await heldIds()).toEqual(['old', 'fresh']);
    vi.setSystemTime(Date.now() + 2000);
    expect(await releaseHeldReactions(thread, 'm1')).toBe(true);
    expect(await live()).toEqual([['m1', BOB, '+']]);
    expect((await loadReactions(thread)).length).toBe(1);
  });

  it('a wipe of all reactions removes the held queues with them', async () => {
    await holdReaction(thread, rx('r1', 'm1'), sender(BOB));
    await clearAllReactions();
    expect(await heldIds()).toEqual([]);
  });
});

describe('purgeHeldReactionsForGroup', () => {
  it('removes the group held queue and only that', async () => {
    const other: ReactionThreadKey = { kind: 'group', groupId: `${G.slice(2)}ff` };
    await holdReaction(thread, rx('r1', 'm1'), sender(BOB));
    await holdReaction(other, rx('r2', 'm1'), sender(BOB));
    await purgeHeldReactionsForGroup(G);
    expect(await heldIds()).toEqual([]);
    expect(await releaseHeldReactions(thread, 'm1')).toBe(false);
    expect(((await idbGet<unknown[]>(`few:reactions:held:group:${(other as { groupId: string }).groupId}`)) ?? []).length).toBe(1);
  });

  it('is idempotent on an empty or unknown group', async () => {
    await purgeHeldReactionsForGroup(G);
    await purgeHeldReactionsForGroup(G);
    expect(await heldIds()).toEqual([]);
  });
});

describe('recomputeMessageReactions (the store contract; the oracle equivalence is in reactionRecompute.test.ts)', () => {
  beforeEach(async () => {
    await appendMessage(G, { id: 'm1', content: 'hello', senderPubkey: BOB, groupId: G, createdAt: 1_700_000_000_000 });
  });

  it('with no surviving signal the aggregate is empty; a visible change resolves true, a repeat false', async () => {
    await applyInboundRumor(thread, rx('r1', 'm1', '👍'), sender(BOB));
    expect(await recomputeMessageReactions(thread, 'm1', [])).toBe(true);
    expect(await loadReactions(thread)).toEqual([]);
    expect(await recomputeMessageReactions(thread, 'm1', [])).toBe(false);
  });

  it('keeps a removal-only tombstone when only the removal survives: an older add stays suppressed', async () => {
    await applyInboundRumor(thread, removal('rm', 'm1', '👍', 1_700_000_100), sender(BOB));
    await applyInboundRumor(thread, rx('r1', 'm1', '👍', 1_700_000_200), sender(BOB));
    expect(await live()).toEqual([['m1', BOB, '👍']]);
    // the newer add is withdrawn
    expect(await recomputeMessageReactions(thread, 'm1', [sig(removal('rm', 'm1', '👍', 1_700_000_100), BOB, 1)])).toBe(true);
    expect(await live()).toEqual([]);
    const rows = await loadReactions(thread);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdAt: 0, removed: true });
    await applyInboundRumor(thread, rx('r0', 'm1', '👍', 1_700_000_050), sender(BOB));
    expect(await live()).toEqual([]);
  });

  it('a withdrawn removal revives the reaction it removed', async () => {
    const add = rx('r1', 'm1', '👍', 1_700_000_000);
    await applyInboundRumor(thread, add, sender(BOB));
    await applyInboundRumor(thread, removal('rm', 'm1', '👍', 1_700_000_100), sender(BOB));
    expect(await live()).toEqual([]);
    expect(await recomputeMessageReactions(thread, 'm1', [sig(add, BOB, 1)])).toBe(true);
    expect(await live()).toEqual([['m1', BOB, '👍']]);
    const [row] = await loadReactions(thread);
    expect(row.removedAt).toBeUndefined();
    expect(row.eventId).toBe(row.id);
  });

  it('a withdrawn removal-only tombstone is dropped without a visible change; the add it suppressed now lands live', async () => {
    await applyInboundRumor(thread, removal('rm', 'm1', '👍', 1_700_000_100), sender(BOB));
    expect(await recomputeMessageReactions(thread, 'm1', [])).toBe(false);
    expect(await loadReactions(thread)).toEqual([]);
    await applyInboundRumor(thread, rx('r0', 'm1', '👍', 1_700_000_050), sender(BOB));
    expect(await live()).toEqual([['m1', BOB, '👍']]);
  });

  it('attributes by the signal sender: the same rumor id from two senders is two reactions, each its own', async () => {
    const add = rx('r1', 'm1', '👍');
    expect(await recomputeMessageReactions(thread, 'm1', [sig(add, BOB, 1), sig(add, MALLORY, 2)])).toBe(true);
    expect(await live()).toEqual([['m1', BOB, '👍'], ['m1', MALLORY, '👍']]);
    expect(await recomputeMessageReactions(thread, 'm1', [sig(add, MALLORY, 2)])).toBe(true);
    expect(await live()).toEqual([['m1', MALLORY, '👍']]);
  });

  it('folds only the signals naming the target and leaves other messages alone', async () => {
    await applyInboundRumor(thread, rx('o1', 'm2', '🎉'), sender(ALICE));
    const add = rx('r1', 'm1', '👍');
    await recomputeMessageReactions(thread, 'm1', [sig(add, BOB, 1), sig(rx('o2', 'm2', '🔥'), BOB, 2), sig({ ...rx('x', 'm1', '❤️'), kind: 9 }, BOB, 3)]);
    expect(await live()).toEqual([['m2', ALICE, '🎉'], ['m1', BOB, '👍']]);
  });

  it('a target that is not stored HOLDS the signals instead of applying them; storing it and releasing applies them', async () => {
    const add = rx('r1', 'm9', '👍');
    expect(await recomputeMessageReactions(thread, 'm9', [sig(add, BOB, 1)])).toBe(false);
    expect(await live()).toEqual([]);
    expect(await heldIds()).toEqual(['r1']);
    await appendMessage(G, { id: 'm9', content: 'hello', senderPubkey: BOB, groupId: G, createdAt: 1_700_000_000_000 });
    expect(await releaseHeldReactions(thread, 'm9')).toBe(true);
    expect(await live()).toEqual([['m9', BOB, '👍']]);
  });

  it('keeps the local optimistic (in-flight) rows of the message unchanged', async () => {
    await applyOptimistic(thread, { id: 'own1', messageId: 'm1', reactorPubkey: SELF, emoji: '🎉', eventId: '', createdAt: 1_700_000_500_000, removed: false });
    await applyInboundRumor(thread, rx('r1', 'm1', '👍'), sender(BOB));
    expect(await recomputeMessageReactions(thread, 'm1', [])).toBe(true);
    expect(await live()).toEqual([['m1', SELF, '🎉']]);
    expect((await loadReactions(thread))[0]).toMatchObject({ id: 'own1', eventId: '', createdAt: 1_700_000_500_000 });
  });

  it('writes nothing and resolves false when the recompute changes nothing', async () => {
    const add = rx('r1', 'm1', '👍');
    await applyInboundRumor(thread, add, sender(BOB));
    const before = JSON.stringify(await idbGet(`few:reactions:group:${G}`));
    expect(await recomputeMessageReactions(thread, 'm1', [sig(add, BOB, 1)])).toBe(false);
    expect(JSON.stringify(await idbGet(`few:reactions:group:${G}`))).toBe(before);
  });
});

describe('reaction handler through a real history backend', () => {
  const versions = { reactions: 0 };
  let sink: AppHistoryBackend | undefined;
  const build = () => {
    versions.reactions = 0;
    const handler = createReactionGroupHandler({
      loadMessages: (g) => loadMessages(g),
      applyInboundRumor,
      setReactionsVersion: (u) => void (versions.reactions = u(versions.reactions)),
      recomputeMessageReactions,
      holdReaction,
      releaseHeldReactions,
    });
    const dispatcher = createGroupRumorDispatch({ handlers: [handler], env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } });
    sink = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`rh-${G}`) });
    return { sink, handler };
  };
  afterEach(async () => {
    await sink?.dispose();
    sink = undefined;
  });
  const entry = (eventId: string, account: string, rumor: ApplicationRumor): HistoryEntry => ({
    groupId: G,
    eventId,
    rumor: { ...rumor, pubkey: account },
    orderingKey: { account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  });
  const message = (id: string) => ({ id, content: 'hello', senderPubkey: BOB, groupId: G, createdAt: 1_700_000_000_000 });

  it('a reaction before its target is held: no throw, no version bump, nothing stored', async () => {
    const { sink } = build();
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    expect(versions.reactions).toBe(0);
    expect(await live()).toEqual([]);
    expect(await heldIds()).toEqual(['r1']);
  });

  it('the held reaction is applied when the target is stored and released', async () => {
    const { sink } = build();
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    await appendMessage(G, message('m1'));
    expect(await releaseHeldReactions(thread, 'm1')).toBe(true);
    expect(await live()).toEqual([['m1', ALICE, '👍']]);
    // re-delivery of the same rumor: dedup, no second row
    await sink.append(entry('e1b', ALICE, rx('r1', 'm1', '👍')));
    expect((await loadReactions(thread)).length).toBe(1);
  });

  it('a target that lands between the first check and the hold is re-checked and released', async () => {
    let calls = 0;
    versions.reactions = 0;
    const handler = createReactionGroupHandler({
      loadMessages: async (g) => {
        const r = await loadMessages(g);
        // the target lands right after the first (negative) check
        if (++calls === 1) await appendMessage(g, message('m1'));
        return r;
      },
      applyInboundRumor,
      setReactionsVersion: (u) => void (versions.reactions = u(versions.reactions)),
      recomputeMessageReactions,
      holdReaction,
      releaseHeldReactions,
    });
    const dispatcher = createGroupRumorDispatch({ handlers: [handler], env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } });
    sink = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`rh2-${G}`) });
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    expect(await live()).toEqual([['m1', ALICE, '👍']]);
    expect(await heldIds()).toEqual([]);
    expect(versions.reactions).toBe(1);
  });

  it('a reaction to a stored target applies at once and bumps the version', async () => {
    const { sink } = build();
    await appendMessage(G, message('m1'));
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    expect(await live()).toEqual([['m1', ALICE, '👍']]);
    expect(versions.reactions).toBe(1);
  });

  it("the withdrawal of another member's reaction drops it and bumps the version", async () => {
    const { sink } = build();
    await appendMessage(G, message('m1'));
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    await sink.withdraw(G, ['e1']);
    expect(await live()).toEqual([]);
    expect(versions.reactions).toBe(2);
  });

  it('AC-WDR-2: the withdrawal of the own reaction drops it too', async () => {
    const { sink } = build();
    await appendMessage(G, message('m1'));
    await sink.append(entry('e1', SELF, rx('r1', 'm1', '🎉')));
    expect(await live()).toEqual([['m1', SELF, '🎉']]);
    await sink.withdraw(G, ['e1']);
    expect(await live()).toEqual([]);
  });

  it('the withdrawal of a held reaction means a later release applies nothing', async () => {
    const { sink } = build();
    await sink.append(entry('e1', ALICE, rx('r1', 'm1', '👍')));
    await sink.withdraw(G, ['e1']);
    expect(await heldIds()).toEqual([]);
    expect(versions.reactions).toBe(0);
    expect(await releaseHeldReactions(thread, 'm1')).toBe(false);
  });
});
