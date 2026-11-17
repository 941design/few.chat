/**
 * Reactions persistence and read API — idb-keyval implementation.
 *
 * Seam S2 producer: loadReactions, aggregateForMessage, subscribeReactions,
 * applyInboundRumor, applyOptimistic, rollbackOptimistic.
 *
 * Seam S4 entry point: applyInboundRumor is the single convergence point for
 * both DM (ContactChat gift-wrap path) and group (MarmotContext case 7:) ingest.
 *
 * Persistence namespaces (D11):
 *   few:reactions:group:{groupId}
 *   few:reactions:dm:{peerPubkeyHex}
 *
 * Design notes:
 * - Module-singleton in-memory map + listener registry (mirrors unreadStore.ts).
 * - Serialised per-thread write queue (mirrors chatPersistence.ts appendQueues).
 * - idb-keyval is accessed only at runtime (never at module-init) — SSR safe.
 * - Listeners fire after the idb write resolves, never before.
 */

import type { Reaction, ReactionThreadKey } from '@/src/lib/reactions/types';
import type { AuthenticatedSender } from '@/src/lib/marmot/applicationRumorDispatcher';
import type { ApplicationRumor, RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import * as walledGarden from '@/src/lib/walledGarden';
import { postStoreChanged } from '@/src/lib/crossTab';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ReactionAggregate {
  emoji: string;
  /** Count of non-removed rows for this (messageId, emoji). */
  count: number;
  /** Hex pubkeys in oldest-first (ascending createdAt) order. */
  reactors: string[];
  /** True iff selfPubkey has a non-removed row for (messageId, emoji). */
  selfReacted: boolean;
}

// ─── Internal module state ────────────────────────────────────────────────────

/**
 * In-memory cache: namespace key → Reaction[].
 * Populated on first loadReactions call per thread.
 */
const cache = new Map<string, Reaction[]>();

/**
 * Per-thread write queues — ensures serialised idb access to prevent
 * concurrent read-modify-write races (same pattern as chatPersistence.ts).
 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Set to true for the duration of clearAllReactions. Any enqueue call that
 * arrives while this flag is set is silently dropped (returns a resolved
 * promise). This closes the race window between writeQueues.clear() and the
 * idb deletion loop — a still-live NDK subscription cannot sneak a write in
 * between those two steps. The flag is reset in a finally block so a thrown
 * error does not permanently lock writes. (D7: don't auto-retry)
 */
let clearingInProgress = false;

/**
 * Per-thread listener sets. Thread namespace key → Set of listeners.
 * subscribeReactions scopes listeners to a single thread.
 */
const listeners = new Map<string, Set<() => void>>();

/**
 * Cross-tab refresh coalescing: the not-yet-started refresh per thread key.
 * A further notice while one is queued is a no-op — the queued one reads the
 * latest stored state when it runs.
 */
const queuedRefreshes = new Map<string, Promise<void>>();

/**
 * Peer-wipe guard: number of wipes (clearDmReactionsForPeer /
 * purgeStrangerDmReactions) in progress per thread key. A refresh that reads
 * while a wipe of its thread is in progress may read the doomed rows, so it
 * must not put them back into the cache. (A refresh that started reading
 * BEFORE the wipe cannot outlive it: the wipe drains the key's queue, which
 * holds the refresh, before it deletes.)
 */
const wipesInProgress = new Map<string, number>();

function beginWipe(keys: string[]): void {
  for (const k of keys) wipesInProgress.set(k, (wipesInProgress.get(k) ?? 0) + 1);
}

function endWipe(keys: string[]): void {
  for (const k of keys) {
    const n = (wipesInProgress.get(k) ?? 1) - 1;
    if (n > 0) wipesInProgress.set(k, n);
    else wipesInProgress.delete(k);
  }
}

// ─── Add / removal ordering (last-writer-wins per triple) ─────────────────────
//
// For one (messageId, reactor, emoji) triple the store keeps ONE row whose
//   createdAt = newest add time seen (ms), removedAt = newest removal time (ms).
// The reaction is live iff createdAt > removedAt (a tie goes to the removal).
// Both are folded in with max(), so the visible state depends only on WHICH
// events arrived, never on their arrival order. A row with removed === true and
// no removedAt is a legacy tombstone: removal wins over any add.

function sameTriple(r: Reaction, messageId: string, reactor: string, emoji: string): boolean {
  return r.messageId === messageId && r.reactorPubkey === reactor && r.emoji === emoji;
}

/** Index of the triple's row (a live one first, for pre-existing duplicates). */
function findTripleIdx(rows: Reaction[], messageId: string, reactor: string, emoji: string): number {
  const live = rows.findIndex((r) => sameTriple(r, messageId, reactor, emoji) && !r.removed);
  if (live !== -1) return live;
  // Only tombstones: the one with the newest removal decides (legacy = newest).
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!sameTriple(rows[i], messageId, reactor, emoji)) continue;
    if (best === -1 || (rows[i].removedAt ?? Infinity) > (rows[best].removedAt ?? Infinity)) best = i;
  }
  return best;
}

function isLegacyTombstone(r: Reaction): boolean {
  return r.removed && r.removedAt === undefined;
}

/**
 * Removal vs add, at the one-second resolution of rumor timestamps: an add that
 * is not in a strictly later second than the removal loses. (Optimistic adds
 * carry ms; flooring keeps a peer's removal in the same second authoritative.)
 */
function isRemovedAt(createdAt: number, removedAt: number | undefined): boolean {
  return removedAt !== undefined && removedAt >= Math.floor(createdAt / 1000) * 1000;
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/** Derives the idb-keyval namespace key for a thread. */
function idbKeyFor(thread: ReactionThreadKey): string {
  if (thread.kind === 'group') {
    return `few:reactions:group:${thread.groupId}`;
  }
  return `few:reactions:dm:${thread.peerPubkeyHex}`;
}

/**
 * Tells the other open tabs that this thread's stored rows changed (cross-tab
 * S0). The id is the namespace key, so the receiving tab refreshes exactly
 * that thread. Posted after the IDB write SETTLED — also after a rejected
 * one: a rejected IndexedDB write is indeterminate (it may have committed),
 * and the receiver only re-reads stored state, so a spurious notice is
 * harmless while a missing one would leave the other tab stale.
 */
function announce(key: string): void {
  postStoreChanged('reactions', key);
}

// ─── Listener helpers ─────────────────────────────────────────────────────────

function getListeners(key: string): Set<() => void> {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  return set;
}

/**
 * Notifies the thread's listeners. Each listener is isolated: one that throws
 * is warned and the rest still run, so a broken UI listener can neither skip
 * the others nor turn into (or replace) a storage write's outcome.
 */
function emit(key: string): void {
  getListeners(key).forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.warn('[reactions] listener threw', err);
    }
  });
}

// ─── Write queue helper ───────────────────────────────────────────────────────

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return typeof nav?.locks?.request === 'function' ? nav.locks : undefined;
}

/**
 * After a rejected write (bug: reaction-storage-failures). The cache already
 * holds the rows that write tried to store (set first on purpose: the
 * badge-revival guard, c64fe0f), but a rejected IndexedDB write is
 * indeterminate — it may or may not have landed. Re-read what is actually
 * stored and cache that, then notify this tab's listeners, so the writing tab
 * shows the same rows as every other tab.
 *
 * Runs inside the failed write's own queue slot (and its cross-tab lock), so
 * no later write of this tab can interleave and no stale read can revive a
 * badge. If the re-read fails too, the stored state is unknown: the cache
 * entry is dropped so the next loadReactions reads storage. Never throws (a
 * failed re-read is warned; listeners are isolated by emit), so the caller
 * always rethrows the write's own error.
 */
async function reconcileAfterRejectedWrite(
  key: string,
  get: <T>(key: string) => Promise<T | undefined>,
): Promise<void> {
  try {
    cache.set(key, (await get<Reaction[]>(key)) ?? []);
  } catch (err) {
    cache.delete(key);
    console.warn('[reactions] re-read after a rejected write failed', err);
  }
  emit(key);
}

/**
 * Enqueues a write operation onto the per-thread serialised queue.
 * The task receives the current rows array and must return the next rows
 * array (or null to skip the idb write). After the idb write resolves,
 * listeners are notified. When it rejects, the cache is reconciled with what
 * is stored (reconcileAfterRejectedWrite), listeners are notified, and the
 * returned promise rejects with the write's error.
 *
 * Cross-tab: where the Web Locks API exists, each read-modify-write runs
 * under a per-thread lock shared by every tab of the origin, so two tabs
 * writing one thread at once cannot overwrite each other (a removal in one
 * tab undone by a stale add in another). Without Web Locks the queue
 * serialises within this tab only and such a simultaneous cross-tab write
 * can still be lost (pinned by crossTab-reactions.test.ts).
 */
function enqueue(
  key: string,
  task: (current: Reaction[]) => Promise<Reaction[] | null>,
): Promise<Reaction[] | null> {
  // Synchronous guard — checked before any writeQueues.set() call so the race
  // window in clearAllReactions cannot be re-opened by a concurrent enqueue.
  if (clearingInProgress) return Promise.resolve(null);

  const prev = writeQueues.get(key) ?? Promise.resolve();
  const step = async (): Promise<Reaction[] | null> => {
    const { get, set } = await import('idb-keyval');
    const current = (await get<Reaction[]>(key)) ?? [];
    const nextRows = await task(current);
    if (nextRows !== null) {
      cache.set(key, nextRows);
      try {
        await set(key, nextRows);
      } catch (err) {
        await reconcileAfterRejectedWrite(key, get);
        throw err;
      } finally {
        announce(key);
      }
      emit(key);
    }
    return nextRows;
  };
  // The cross-tab lock sits INSIDE this tab's per-key queue, so the in-tab
  // ordering (the cache-first badge-revival guard, c64fe0f) is unchanged.
  const next = prev.then(() => {
    const locks = webLocks();
    return locks ? locks.request(`few:reactions:${key}`, step) : step();
  });
  const settled = next.catch(() => {});
  writeQueues.set(key, settled);
  settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Loads all reaction rows for a thread.
 *
 * Returns the in-memory cache when it has been populated — this is the
 * authoritative source after the first load because all writes go through
 * `enqueue`, which updates both cache and IDB atomically before notifying
 * listeners. Reading from IDB on every call (the prior behaviour) raced with
 * concurrent enqueue operations: a `recompute` triggered by a messages-change
 * effect could read the stale IDB value while an `applyOptimisticRemoval` was
 * mid-write, overwriting the cache and temporarily reviving a removed badge.
 *
 * Falls back to an IDB read only on the first call (cache cold) or after
 * clearAllReactions wipes the cache.
 *
 * AC-07, AC-57.
 */
export async function loadReactions(thread: ReactionThreadKey): Promise<Reaction[]> {
  const key = idbKeyFor(thread);
  if (cache.has(key)) return cache.get(key)!;
  const { get } = await import('idb-keyval');
  const stored = (await get<Reaction[]>(key)) ?? [];
  // A write or a cross-tab refresh that completed while this cold read was in
  // flight already put NEWER rows in the cache — never overwrite them with
  // this (possibly older) read.
  if (cache.has(key)) return cache.get(key)!;
  cache.set(key, stored);
  return stored;
}

/**
 * Cross-tab receiver (multi-tab design S0): another open tab wrote reaction
 * rows for the thread stored under `key`. Re-reads that thread's stored rows
 * into the in-memory cache and notifies its listeners, so a mounted chat shows
 * the other tab's reaction without a reload. Other threads' cache entries are
 * untouched.
 *
 * Badge-revival guard: the re-read is queued on the thread's write queue, so
 * it runs only AFTER every write this tab already started for the thread has
 * persisted. A direct read could return the pre-write IDB value while, say,
 * an applyOptimisticRemoval is mid-write, and put the removed badge back in
 * the cache (the race that made loadReactions cache-first).
 *
 * Coalesced: at most one refresh per thread is queued (plus one running); a
 * notice arriving while one is queued returns that one. A refresh whose read
 * overlapped a peer wipe (clearDmReactionsForPeer / purgeStrangerDmReactions)
 * leaves the cache alone, so the wiped rows are never re-cached.
 *
 * Read-only: never writes and never posts, so nothing bounces back. A thread
 * this tab has neither cached nor subscribed to (which includes any key that
 * is not a reaction-thread key) is skipped (its first load reads storage
 * anyway). Never rejects: a failed re-read keeps the current
 * cache (stored state unknown) and notifies nobody.
 */
export function refreshReactionsFromStorage(key: string): Promise<void> {
  if (!cache.has(key) && !(listeners.get(key)?.size)) return Promise.resolve();
  if (clearingInProgress) return Promise.resolve();
  const queued = queuedRefreshes.get(key);
  if (queued) return queued;

  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Running now: a later notice queues a fresh refresh behind this one.
    queuedRefreshes.delete(key);
    const { get } = await import('idb-keyval');
    const stored = (await get<Reaction[]>(key)) ?? [];
    // A peer wipe of this thread is in progress: the rows may be the wiped ones.
    if (wipesInProgress.has(key)) return;
    cache.set(key, stored);
    emit(key);
  });
  const settled = next.catch((err) => {
    console.warn('[reactions] cross-tab refresh failed', err);
  });
  queuedRefreshes.set(key, settled);
  writeQueues.set(key, settled);
  settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return settled;
}

/**
 * Pure synchronous aggregation. Groups non-removed rows by emoji, counts them,
 * sorts reactors oldest-first by createdAt, and sets selfReacted.
 *
 * AC-08.
 */
export function aggregateForMessage(
  rows: Reaction[],
  messageId: string,
  selfPubkey: string,
): ReactionAggregate[] {
  const relevant = rows.filter((r) => r.messageId === messageId && !r.removed);

  // Group by emoji
  const byEmoji = new Map<string, Reaction[]>();
  for (const r of relevant) {
    const existing = byEmoji.get(r.emoji) ?? [];
    byEmoji.set(r.emoji, [...existing, r]);
  }

  const result: ReactionAggregate[] = [];
  for (const [emoji, emojiRows] of byEmoji) {
    // Sort oldest-first
    const sorted = [...emojiRows].sort((a, b) => a.createdAt - b.createdAt);
    const reactors = sorted.map((r) => r.reactorPubkey);
    result.push({
      emoji,
      count: reactors.length,
      reactors,
      selfReacted: reactors.includes(selfPubkey),
    });
  }

  return result;
}

/**
 * Registers a listener for write events on the given thread's namespace.
 * Returns an unsubscribe function.
 *
 * Mirrors the subscribe/emit pattern from unreadStore.ts.
 *
 * AC-13.
 */
export function subscribeReactions(
  thread: ReactionThreadKey,
  listener: () => void,
): () => void {
  const key = idbKeyFor(thread);
  getListeners(key).add(listener);
  return () => getListeners(key).delete(listener);
}

function optimisticAddRows(current: Reaction[], row: Reaction): Reaction[] | null {
  // Idempotent on row id, except a rolled-back pending add (the tombstone that a
  // failed re-add was merged into: removed, eventId '', createdAt 0, dated
  // removal). A retry reuses the same rumor id when the clock has not moved, so
  // it revives that tombstone instead of leaving the local view removed while
  // the published rumor makes peers show the reaction live.
  // Scoped to the reactor: a row id is a RUMOR id, and byte-identical copies of one rumor under two reactors are two
  // rows (contribution identity is (rumor id, reactor)); another reactor's row must never stand in for this one.
  const sameId = current.findIndex((r) => r.id === row.id && r.reactorPubkey === row.reactorPubkey);
  if (sameId !== -1) {
    const prev = current[sameId];
    const rolledBackPending =
      prev.removed && prev.eventId === '' && prev.createdAt === 0 && prev.removedAt !== undefined;
    if (!rolledBackPending || !sameTriple(prev, row.messageId, row.reactorPubkey, row.emoji)) return null;
    const updated = [...current];
    updated[sameId] = {
      ...prev,
      removed: false,
      createdAt: Math.max(row.createdAt, Math.floor(prev.removedAt! / 1000) * 1000 + 1000),
    };
    return updated;
  }
  // One row per triple: a dated tombstone of an earlier removal becomes this
  // optimistic row, keeping its removal time so a stale event still cannot
  // override it. The local add is always newer than the removal it follows.
  // An already live row stays as it is (the triple is reacted already; the
  // echo confirms or the failed send's rollback finds nothing to undo). A
  // legacy tombstone is kept beside the new row, so a rollback cannot drop it.
  const idx = findTripleIdx(current, row.messageId, row.reactorPubkey, row.emoji);
  if (idx === -1 || isLegacyTombstone(current[idx])) return [...current, row];
  const prev = current[idx];
  if (!prev.removed) return null;
  const updated = [...current];
  updated[idx] = {
    ...row,
    removed: false,
    createdAt: Math.max(
      row.createdAt,
      prev.createdAt,
      prev.removedAt !== undefined ? Math.floor(prev.removedAt / 1000) * 1000 + 1000 : 0,
    ),
    ...(prev.removedAt !== undefined ? { removedAt: prev.removedAt } : {}),
  };
  return updated;
}

/**
 * Writes an optimistic Reaction row to the store. The row must be in-flight
 * (eventId === ''). Listeners are notified after the idb write resolves.
 *
 * AC-12.
 */
export function applyOptimistic(thread: ReactionThreadKey, row: Reaction): Promise<Reaction[] | null> {
  const key = idbKeyFor(thread);
  return enqueue(key, async (current) => optimisticAddRows(current, row));
}

/**
 * Floor (unix seconds) for the created_at of a rumor the local user is about to
 * send for a triple, so receivers' last-writer-wins agrees with the local view:
 *  - re-add of a removed triple: strictly after the removal second;
 *  - removal of a live triple: the add's second (a tie goes to the removal);
 *  - no row, a legacy tombstone, or an add of an already live triple: no floor.
 * Pure over the rows it is given; prepareOwnReaction calls it on fresh storage
 * inside the thread's write queue.
 */
export function stampFloorFor(
  rows: Reaction[],
  messageId: string,
  reactorPubkey: string,
  emoji: string,
  isRemoval: boolean,
): number | undefined {
  const idx = findTripleIdx(rows, messageId, reactorPubkey, emoji);
  if (idx === -1) return undefined;
  const r = rows[idx];
  if (isRemoval) return r.removed ? undefined : Math.floor(r.createdAt / 1000);
  if (!r.removed || r.removedAt === undefined) return undefined;
  return Math.floor(r.removedAt / 1000) + 1;
}

function optimisticRemovalRows(
  current: Reaction[],
  messageId: string,
  reactorPubkey: string,
  emoji: string,
  removedAtMs?: number,
): Reaction[] | null {
  const idx = current.findIndex(
    (r) =>
      r.messageId === messageId &&
      r.reactorPubkey === reactorPubkey &&
      r.emoji === emoji &&
      !r.removed,
  );
  if (idx === -1) return null;
  const updated = [...current];
  updated[idx] = {
    ...updated[idx],
    removed: true,
    removedAt: Math.max(removedAtMs ?? Date.now(), updated[idx].createdAt),
  };
  return updated;
}

/**
 * Optimistic tombstone for a self-issued reaction removal.
 *
 * Unlike applyOptimistic (which inserts a new row by id), this finds an
 * existing non-removed row matching (messageId, reactorPubkey, emoji) and
 * flips its `removed` flag in-place. This is the correct shape for AC-59
 * optimistic rollback of *the user's own* reaction: the inbound echo will
 * later confirm the tombstone via applyInboundRumor.
 *
 * If no matching non-removed row exists, this is a no-op (silent discard).
 *
 * Note: applyOptimistic could not be reused here because it inserts a fresh
 * row keyed on the new rumor id, leaving the original add row intact and
 * the badge visible. Splitting into a dedicated function keeps each path's
 * data shape narrow and the contract explicit.
 *
 * AC-59.
 */
export async function applyOptimisticRemoval(
  thread: ReactionThreadKey,
  messageId: string,
  reactorPubkey: string,
  emoji: string,
): Promise<Reaction[] | null> {
  const key = idbKeyFor(thread);
  return enqueue(key, async (current) =>
    optimisticRemovalRows(current, messageId, reactorPubkey, emoji),
  );
}

/**
 * Atomic prepare of a local user's own reaction add/removal.
 *
 * Inside ONE write-queue step (same queue and cross-tab lock as applyOptimistic),
 * on freshly read storage: computes the stamp floor, calls `build` exactly once
 * with it, and persists the matching optimistic add row or tombstone stamped
 * rumor.created_at * 1000. Reading the floor and writing the optimistic state in
 * the same step means no queued or cross-tab write can slip between them, so the
 * published stamp and the local view always agree and receivers converge on it.
 * The optimistic row id is the built rumor's id (optimistic id == published id).
 */
export async function prepareOwnReaction<R extends { id: string; created_at: number }>(
  thread: ReactionThreadKey,
  params: {
    messageId: string;
    reactorPubkey: string;
    emoji: string;
    isRemoval: boolean;
    build: (notBeforeSec: number | undefined) => R;
  },
): Promise<{ rumor: R }> {
  const { messageId, reactorPubkey, emoji, isRemoval, build } = params;
  const key = idbKeyFor(thread);
  let rumor: R | undefined;
  await enqueue(key, async (current) => {
    rumor = build(stampFloorFor(current, messageId, reactorPubkey, emoji, isRemoval));
    const stampMs = rumor.created_at * 1000;
    if (isRemoval) return optimisticRemovalRows(current, messageId, reactorPubkey, emoji, stampMs);
    return optimisticAddRows(current, {
      id: rumor.id,
      messageId,
      reactorPubkey,
      emoji,
      eventId: '',
      createdAt: stampMs,
      removed: false,
    });
  });
  if (!rumor) {
    // enqueue skipped the step because the store is being cleared; nothing was
    // built or persisted. couldntReact matches the callers' send-failure sentinel.
    throw Object.assign(new Error('prepareOwnReaction: store is being cleared'), { couldntReact: true });
  }
  return { rumor };
}

/**
 * Removes an optimistic row by id. Only rows whose eventId is empty string
 * (still in-flight) are eligible. Rows with a confirmed eventId are left
 * untouched. Listeners are notified after the idb write resolves.
 *
 * AC-12.
 */
export function rollbackOptimistic(
  thread: ReactionThreadKey,
  optimisticId: string,
  reactorPubkey?: string,
): Promise<Reaction[] | null> {
  const key = idbKeyFor(thread);
  return enqueue(key, async (current) => {
    // A row id is a rumor id, so two reactors may hold a row with the same id (a forged copy another member
    // delivered): only the IN-FLIGHT row (eventId '') is an optimistic row, and `reactorPubkey` (when given) pins
    // it to its reactor. Another reactor's confirmed row of the same id must never shadow it.
    const target = current.find((r) => r.id === optimisticId && r.eventId === '' && (reactorPubkey === undefined || r.reactorPubkey === reactorPubkey));
    // Only roll back if the row is still in-flight
    if (!target) return null;
    // A pending add that merged into an earlier tombstone goes back to being
    // that tombstone; a plain pending insert is dropped.
    if (target.removedAt !== undefined) {
      return current.map((r) => (r === target ? { ...r, removed: true, createdAt: 0 } : r));
    }
    return current.filter((r) => r !== target);
  });
}

/**
 * THE reaction-application core: folds one inbound kind-7 rumor of `senderPubkey` into `current` (the thread's
 * rows). Pure and effect-free (no I/O, no clock, no listener): the live dispatch (`applyInboundRumor`) and the
 * recompute (`recomputeMessageReactions`) both run it, so a recompute can never disagree with a dispatch.
 * `rows` is the next rows array (null = no write); `visible` is true iff the visible state changed.
 */
function foldInboundRumor(
  current: Reaction[],
  rumor: { id: string; created_at: number; content: string; tags: string[][] },
  senderPubkey: string,
  messageId: string,
): { rows: Reaction[] | null; visible: boolean } {
  // Extract emoji from content (for the upsert key)
  const emoji = rumor.content;
  const isRemoval = emoji === '-';
  /** ms timestamp of this rumor (created_at is unix seconds). */
  const rumorMs = rumor.created_at * 1000;
  const removalMs = rumorMs;
  let visible = false;
  const rows = ((): Reaction[] | null => {
      // Pre-work fix (story-07): the leaf module always upserts — the "silent discard if
      // message unknown" rule (spec §2.4, AC-11) is enforced by the dispatcher, not here.
      // MarmotContext case 7: gates on loadMessages(groupId); ContactChat kind-7 dispatch
      // gates on the in-memory messages array. Removing the check here lets the first
      // reaction to any message land correctly (the prior check falsely discarded it when
      // no prior reaction row existed for that messageId).

      // Dedup by eventId (AC-09)
      // Scoped to the sender: a contribution is identified by (rumor id, sender), so a
      // byte-identical copy another member forges neither shadows nor is shadowed by the real one.
      if (current.some((r) => r.eventId === rumor.id && r.reactorPubkey === senderPubkey && rumor.id !== '')) {
        // no visible change, no write
        return null;
      }

      if (isRemoval) {
        // AC-10, D2: the removal names (messageId, reactorPubkey, emoji) via an
        // ["emoji", glyph] tag (case-insensitive tag name; glyph case-sensitive).
        // An ambiguous rumor is silently discarded.
        const emojiTags = rumor.tags
          .filter((t) => typeof t[0] === 'string' && t[0].toLowerCase() === 'emoji' && typeof t[1] === 'string' && t[1].length > 0)
          .map((t) => t[1] as string);
        const distinctEmojis = [...new Set(emojiTags)];

        if (distinctEmojis.length > 1) {
          // Multiple distinct emoji tags — out-of-spec rumor, silent discard (§2.4).
          return null;
        }

        if (distinctEmojis.length === 1) {
          // Always remembered, even with no row yet: an add that arrives later
          // (out of order) must see this removal.
          const targetEmoji = distinctEmojis[0];
          const idx = findTripleIdx(current, messageId, senderPubkey, targetEmoji);
          if (idx === -1) {
            // Removal-only tombstone: never rendered or counted (removed: true,
            // createdAt 0 = no add seen). No visible change.
            return [
              ...current,
              {
                id: rumor.id,
                messageId,
                reactorPubkey: senderPubkey,
                emoji: targetEmoji,
                eventId: rumor.id,
                createdAt: 0,
                removed: true,
                removedAt: removalMs,
              },
            ];
          }
          const prev = current[idx];
          if (isLegacyTombstone(prev)) return null; // removal already wins
          const removedAt = Math.max(prev.removedAt ?? -1, removalMs);
          const removed = isRemovedAt(prev.createdAt, removedAt);
          if (removedAt === prev.removedAt && removed === prev.removed) return null;
          const updated = [...current];
          updated[idx] = {
            ...prev,
            removed,
            removedAt,
            // A removal that leaves the row live (an even newer add) must not take
            // its event id: a pending re-add keeps '' so its rollback still works.
            eventId: removed ? rumor.id : prev.eventId,
          };
          if (removed !== prev.removed) visible = true;
          return updated;
        }

        // No emoji tag present: the triple cannot be named. Tombstone only if
        // exactly one live row exists for (messageId, reactorPubkey) — the
        // unambiguous single-emoji case — and the removal is not older than that
        // row's add. Otherwise silent discard (§2.4, D2 safety); such a removal
        // is not remembered, so it cannot guard against a later out-of-order add.
        const candidates = current.filter(
          (r) =>
            r.messageId === messageId &&
            r.reactorPubkey === senderPubkey &&
            !r.removed &&
            isRemovedAt(r.createdAt, removalMs),
        );
        if (candidates.length !== 1) {
          return null;
        }
        const idx = current.indexOf(candidates[0]);
        const updated = [...current];
        updated[idx] = {
          ...updated[idx],
          removed: true,
          removedAt: Math.max(updated[idx].removedAt ?? -1, removalMs),
          eventId: rumor.id,
        };
        visible = true;
        return updated;
      }

      // Add: fold into the triple's single row.
      const idx = findTripleIdx(current, messageId, senderPubkey, emoji);
      if (idx === -1) {
        visible = true;
        return [
          ...current,
          {
            id: rumor.id,
            messageId,
            reactorPubkey: senderPubkey,
            emoji,
            eventId: rumor.id,
            createdAt: rumorMs, // Reaction.createdAt is ms
            removed: false,
          },
        ];
      }
      const prev = current[idx];
      if (isLegacyTombstone(prev)) return null; // removal wins over any add
      const createdAt = Math.max(prev.createdAt, rumorMs);
      const removed = isRemovedAt(createdAt, prev.removedAt);
      // The add's event id is recorded only when it confirms the optimistic row
      // it created (id match), or when it is not older than the newest add (it
      // then legitimately owns the live row). A late echo of an OLDER add never
      // takes over the row, so a pending re-add keeps its '' eventId (rollback
      // works). A removed row keeps the removal's event id.
      let eventId = prev.eventId;
      if (removed) eventId = prev.eventId;
      else if (prev.id === rumor.id) eventId = rumor.id;
      else if (rumorMs >= Math.floor(prev.createdAt / 1000) * 1000) eventId = rumor.id;
      if (createdAt === prev.createdAt && removed === prev.removed && eventId === prev.eventId) return null;
      const updated = [...current];
      updated[idx] = { ...prev, createdAt, removed, eventId };
      // Visible change = the add took the row (revival, confirmation, newest add).
      if (eventId !== prev.eventId) visible = true;
      return updated;
  })();
  return { rows, visible };
}

/**
 * Processes an inbound kind-7 rumor.
 *
 * - Extracts messageId from the first `e` tag.
 * - Silent discard (returns null) if rumor.id already exists in the store
 *   (eventId dedup — AC-09).
 * - content === '-': tombstones the matching (messageId, reactorPubkey, emoji)
 *   row by setting removed: true. Returns null if no matching row exists
 *   (AC-10).
 * - Otherwise: upserts a Reaction row keyed on (messageId, reactorPubkey,
 *   emoji). Returns { messageId } (AC-09).
 *
 * Listeners are notified after the idb write resolves.
 *
 * Note: AC-11 "silent discard for unknown messageId" is enforced by the dispatcher
 * (MarmotContext case 7 / ContactChat kind-7 dispatch), not by this leaf module.
 *
 * `sender` (optional, epic: group-message-author-auth-app-layer S2): the
 * dispatcher-resolved authenticated sender for the group path. When
 * supplied, every attribution decision in this function sources the
 * reactor pubkey from `sender.pubkey` instead of the forgeable
 * `rumor.pubkey`. Callers that don't supply one (the DM path, seal-
 * signature-authenticated independently) keep reading `rumor.pubkey`
 * unchanged.
 *
 * AC-09, AC-10, AC-58.
 */
export async function applyInboundRumor(
  thread: ReactionThreadKey,
  rumor: {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  },
  sender?: AuthenticatedSender,
): Promise<{ messageId: string } | null> {
  // A GROUP thread's reactor is the MLS-authenticated sender only: a missing sender throws instead of falling back
  // to the forgeable `rumor.pubkey` (a DM thread is seal-signature-authenticated and reads it).
  if (!sender?.pubkey && thread.kind === 'group') {
    throw new TypeError('applyInboundRumor: a group-thread reaction requires an authenticated sender');
  }
  const senderPubkey = sender?.pubkey ?? rumor.pubkey;

  // Extract the e-tag value (first occurrence)
  // Guard against malformed tags where t[0] is absent or non-string.
  const eTag = rumor.tags.find((t) => typeof t[0] === 'string' && t[0] === 'e');
  if (!eTag || !eTag[1]) return null;
  const messageId = eTag[1];

  const key = idbKeyFor(thread);

  let result: { messageId: string } | null = null;

  await enqueue(key, async (current) => {
    const folded = foldInboundRumor(current, rumor, senderPubkey, messageId);
    if (folded.visible) result = { messageId };
    return folded.rows;
  });

  return result;
}

// ─── Held reactions (target message not stored yet) ──────────────────────────
//
// A reaction whose target message has not landed yet is held per thread under
// its own key and applied when the target arrives (releaseHeldReactions). The
// queue is bounded (TTL, a per-sender share and a per-thread cap) and deduped
// by (rumor id, sender). The account-wide wipes (clearAllReactions) and the
// DM wipes (clearDmReactionsForPeer / purgeStrangerDmReactions) remove it with
// its thread; a GROUP's queue is removed by nothing above, only by
// purgeHeldReactionsForGroup (the group-leave purge).

const HELD_PREFIX = 'few:reactions:held:';

/** How long an unapplied held reaction is kept. */
export const HELD_REACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-thread bound on held reactions; past it the sender holding the most loses its oldest. */
export const HELD_REACTION_CAP = 200;
/** One sender's share of the held queue: past it that sender's own oldest is dropped, nobody else's. */
export const HELD_REACTION_SENDER_CAP = 50;

interface HeldReaction {
  rumor: ApplicationRumor;
  sender: AuthenticatedSender;
  heldAt: number;
}

/** Per-held-key promise queue: serialises the read-modify-write of one held queue. */
const heldQueues = new Map<string, Promise<unknown>>();

function heldKeyFor(thread: ReactionThreadKey): string {
  return `${HELD_PREFIX}${idbKeyFor(thread).slice('few:reactions:'.length)}`;
}

function firstETag(rumor: { tags: string[][] }): string | undefined {
  const tag = rumor.tags?.find((t) => Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0);
  return tag?.[1];
}

/**
 * Adds an entry to a held queue (the next array; the input is not mutated). Idempotent by contribution
 * identity (rumor id, sender): a copy of the same rumor id from ANOTHER sender is a separate entry. Bounds:
 * the sender's share first (it loses its own oldest), then the thread cap (the sender holding the most loses its
 * oldest; a tie goes to the sender whose oldest entry is oldest), so one member can never evict another's.
 */
function addHeldEntry(entries: HeldReaction[], entry: HeldReaction): HeldReaction[] {
  if (entries.some((e) => e.rumor.id === entry.rumor.id && e.sender.pubkey === entry.sender.pubkey)) return entries;
  let next = [...entries, entry];
  const own = next.filter((e) => e.sender.pubkey === entry.sender.pubkey);
  if (own.length > HELD_REACTION_SENDER_CAP) next = next.filter((e) => e !== own[0]);
  while (next.length > HELD_REACTION_CAP) {
    const counts = new Map<string, number>();
    for (const e of next) counts.set(e.sender.pubkey, (counts.get(e.sender.pubkey) ?? 0) + 1);
    const most = Math.max(...counts.values());
    const victim = next.find((e) => counts.get(e.sender.pubkey) === most)!;
    next = next.filter((e) => e !== victim);
  }
  return next;
}

/**
 * Runs `task` on the thread's live (unexpired) held entries inside the held
 * queue. `task` returns the next entries (null = unchanged). Expired entries
 * are dropped whenever the queue is accessed.
 */
function modifyHeld<R>(
  hkey: string,
  task: (entries: HeldReaction[]) => Promise<{ next: HeldReaction[] | null; result: R }>,
  idle: R,
): Promise<R> {
  if (clearingInProgress) return Promise.resolve(idle);
  const prev = heldQueues.get(hkey) ?? Promise.resolve();
  const next = prev.then(async (): Promise<R> => {
    if (clearingInProgress) return idle;
    const { get, set, del } = await import('idb-keyval');
    const stored = (await get<HeldReaction[]>(hkey)) ?? [];
    const cutoff = Date.now() - HELD_REACTION_TTL_MS;
    const live = stored.filter((e) => e.heldAt > cutoff);
    const { next: written, result } = await task(live);
    const finalEntries = written ?? (live.length !== stored.length ? live : null);
    if (finalEntries !== null) {
      if (finalEntries.length === 0) await del(hkey);
      else await set(hkey, finalEntries);
    }
    return result;
  });
  const settled = next.then(() => {}, () => {});
  heldQueues.set(hkey, settled);
  settled.then(() => {
    if (heldQueues.get(hkey) === settled) heldQueues.delete(hkey);
  });
  return next;
}

/**
 * Keeps an inbound reaction whose target message is not stored yet, with its
 * authenticated sender, until `releaseHeldReactions` applies it. Idempotent by
 * (rumor id, sender); a rumor without an e-tag is not held.
 */
export function holdReaction(
  thread: ReactionThreadKey,
  rumor: ApplicationRumor,
  sender: AuthenticatedSender,
): Promise<void> {
  if (!firstETag(rumor)) return Promise.resolve();
  return modifyHeld<void>(
    heldKeyFor(thread),
    async (entries) => {
      const next = addHeldEntry(entries, { rumor, sender, heldAt: Date.now() });
      return { next: next === entries ? null : next, result: undefined };
    },
    undefined,
  );
}

/**
 * Applies every held reaction that targets `messageId` (the message just
 * stored), in held order, through `applyInboundRumor` (dedups by (rumor id, sender), so a
 * retry after a failure is safe). An entry leaves the held queue only after it
 * was applied; a failure rejects and leaves the unapplied ones held. Resolves
 * true iff at least one produced a visible change.
 */
export function releaseHeldReactions(thread: ReactionThreadKey, messageId: string): Promise<boolean> {
  const sameEntry = (a: HeldReaction, b: HeldReaction) => a.rumor.id === b.rumor.id && a.sender.pubkey === b.sender.pubkey;
  return modifyHeld<boolean>(
    heldKeyFor(thread),
    async (entries) => {
      const mine = entries.filter((e) => firstETag(e.rumor) === messageId);
      if (mine.length === 0) return { next: null, result: false };
      let visible = false;
      const applied: HeldReaction[] = [];
      try {
        for (const e of mine) {
          const r = await applyInboundRumor(thread, e.rumor, e.sender);
          applied.push(e);
          if (r !== null) visible = true;
        }
      } catch (err) {
        // Persist the progress made before the failure, then reject.
        const { set, del } = await import('idb-keyval');
        const rest = entries.filter((e) => !applied.some((a) => sameEntry(a, e)));
        if (rest.length === 0) await del(heldKeyFor(thread));
        else await set(heldKeyFor(thread), rest);
        throw err;
      }
      return { next: entries.filter((e) => !applied.some((a) => sameEntry(a, e))), result: visible };
    },
    false,
  );
}

/** Sorted signature of the LIVE reactions of one message: what a reader can see (emoji, reactor, order key). */
function visibleSignature(rows: Reaction[], messageId: string): string {
  return rows
    .filter((r) => r.messageId === messageId && !r.removed)
    .map((r) => `${r.emoji}\u0000${r.reactorPubkey}\u0000${r.createdAt}`)
    .sort()
    .join('\u0001');
}

/** Whether the target message is stored. DM threads have no stored-message gate on this path (always true). */
async function targetMessageStored(thread: ReactionThreadKey, messageId: string): Promise<boolean> {
  if (thread.kind !== 'group') return true;
  const { loadMessages } = await import('@/src/lib/marmot/chatPersistence');
  return (await loadMessages(thread.groupId)).messages.some((m) => m.id === messageId);
}

/**
 * RECOMPUTES every reaction of one message from the group's surviving history (AC-WDR-1..9, replacing the
 * per-rumor undo a withdraw used to apply). The result equals dispatching only `signals` (the surviving kind-7
 * rumors, `seq` order) into an empty store, whatever was withdrawn, in whatever order.
 *
 * Inside the thread's serialisation (held queue, then the rows queue; rows read ONCE):
 *   1. RESET the aggregate to its base: no reaction row for `targetMessageId` and none of its held entries,
 *      except the local user's own optimistic rows that no sink delivery confirmed yet (eventId ''), which are
 *      carried over unchanged. Known residual: an optimistic REMOVAL of an already confirmed row is not
 *      distinguishable from a confirmed one and reverts to the add until the removal's echo is folded.
 *   2. FOLD the signals naming the target (kind 7, first e-tag) in `seq` order through `foldInboundRumor`, the
 *      same core as dispatch; the sender is the signal's (the history row's account), never the rumor's pubkey.
 *      A contribution is (rumor id, sender): duplicate carriers of one rumor fold once, and a forged copy of
 *      another member's reaction neither shadows nor is shadowed by the real one.
 *   3. If the target message is NOT stored (its base was withdrawn, or never arrived) nothing is folded: the
 *      reactions are HELD instead, and `releaseHeldReactions` applies them when the base is stored again.
 *
 * The fold reads no clock: it orders by the rumors' own created_at and the history order. The wall clock is read
 * only for the held queue's own bookkeeping (`heldAt`, TTL expiry), never to decide a fold. Nothing but the
 * two stores is touched: no listener beyond the store's own, no bell, no unread, no send (AC-WDR-6).
 * Resolves true iff the visible reactions of the message changed. Live-state gates do not apply to reactions.
 */
export async function recomputeMessageReactions(
  thread: ReactionThreadKey,
  targetMessageId: string,
  signals: readonly RecomputeSignal[],
): Promise<boolean> {
  const mine = signals
    .filter((s) => s.rumor.kind === 7 && firstETag(s.rumor) === targetMessageId)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const stored = await targetMessageStored(thread, targetMessageId);
  return modifyHeld<boolean>(
    heldKeyFor(thread),
    async (entries) => {
      let held = entries.filter((e) => firstETag(e.rumor) !== targetMessageId);
      let visible = false;
      await enqueue(idbKeyFor(thread), async (current) => {
        const before = visibleSignature(current, targetMessageId);
        let rows = current.filter((r) => r.messageId !== targetMessageId || r.eventId === '');
        if (stored) {
          for (const s of mine) {
            const folded = foldInboundRumor(rows, s.rumor, s.sender, targetMessageId);
            if (folded.rows) rows = folded.rows;
          }
        } else {
          for (const s of mine) {
            held = addHeldEntry(held, { rumor: s.rumor, sender: { pubkey: s.sender, authenticity: 'mls' }, heldAt: Date.now() });
          }
        }
        visible = visibleSignature(rows, targetMessageId) !== before;
        return JSON.stringify(rows) === JSON.stringify(current) ? null : rows;
      });
      return { next: JSON.stringify(held) === JSON.stringify(entries) ? null : held, result: visible };
    },
    false,
  );
}

/**
 * Removes the held-reaction queue of one group (reactions whose target message never arrived). The group-leave
 * purge (S13) calls it: no account-wide wipe covers a single group, and without it a left group's reactions
 * (reactor pubkeys, emoji, message ids) would outlive the group until their TTL. Serialised with the queue's
 * other turns; resolves once the key is gone. Idempotent.
 */
export async function purgeHeldReactionsForGroup(groupId: string): Promise<void> {
  await modifyHeld<void>(heldKeyFor({ kind: 'group', groupId }), async () => ({ next: [], result: undefined }), undefined);
}

/**
 * Test/oracle port: the held queue of one group without its time fields (`heldAt`), as `{ rumor, sender }`,
 * grouped by target message (targets in name order) and in held order within a target. The order ACROSS targets
 * is not part of the queue's meaning (a release applies one target's entries, in their held order, and nothing
 * else) and differs between a live hold and a recompute, so the port does not expose it. Waits for the queue's
 * in-flight turns first.
 */
export async function snapshotHeldReactions(groupId: string): Promise<unknown> {
  const hkey = heldKeyFor({ kind: 'group', groupId });
  await heldQueues.get(hkey);
  const { get } = await import('idb-keyval');
  const entries = ((await get<HeldReaction[]>(hkey)) ?? []).map(({ rumor, sender }) => ({ target: firstETag(rumor) ?? '', rumor, sender }));
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.target < b.e.target ? -1 : a.e.target > b.e.target ? 1 : a.i - b.i))
    .map(({ e: { rumor, sender } }) => ({ rumor, sender }));
}

/**
 * Clears all reaction data for both namespaces. Used by clearAccountScopedIdbData
 * in storage.ts to wipe reactions on account switch.
 *
 * AC-14.
 */
export async function clearAllReactions(): Promise<void> {
  // Set the flag synchronously before any await so enqueue() sees it
  // immediately. Any write that arrives after this point is silently dropped.
  clearingInProgress = true;
  try {
    const { keys, delMany } = await import('idb-keyval');
    // Drain in-flight queues that were already enqueued before the flag was set.
    const inflight = [...writeQueues.values(), ...heldQueues.values()];
    await Promise.allSettled(inflight);
    writeQueues.clear();
    cache.clear();
    const allKeys = await keys();
    const targets = allKeys.filter(
      (k): k is string =>
        typeof k === 'string' &&
        (k.startsWith('few:reactions:group:') ||
          k.startsWith('few:reactions:dm:') ||
          k.startsWith(HELD_PREFIX)),
    );
    heldQueues.clear();
    if (targets.length > 0) {
      await delMany(targets);
    }
  } finally {
    clearingInProgress = false;
  }
}

/**
 * Deletes the DM reaction aggregate for exactly one peer (epic: block-contact,
 * gate-remediation finding 4). Consumed by `chatPersistence.ts#wipeSinglePeerHistory`
 * as the wipe's third step, so a blocked peer's DM history wipe also removes
 * the reaction rows (emoji, message ids, reactor pubkeys) that would
 * otherwise survive the block — DD-3 "permanently deletes the locally stored
 * DM history" covers reactions, not just message/thread/unread state.
 *
 * Case-insensitive by enumeration (gate-remediation convergence fix): the
 * reaction WRITE path (`idbKeyFor` above) does NOT normalize
 * `thread.peerPubkeyHex` — every write site (e.g. ContactChat) passes the
 * RAW `contact.pubkeyHex`, and this epic's own AC-CORE-6 exists precisely
 * because a stored contact pubkeyHex is not guaranteed to be lowercase. A
 * delete that targets only the single lowercase key
 * (`few:reactions:dm:<lower>`) would miss a row persisted under a
 * mixed-case key, silently leaking a blocked peer's reaction data. This
 * function instead enumerates every `few:reactions:dm:` key and deletes
 * each whose suffix matches `peerPubkeyHex` case-insensitively — mirroring
 * `purgeStrangerDmReactions`'s enumerate-then-delMany pattern (in-flight
 * write drain + cache eviction) rather than going through `idbKeyFor` for a
 * single exact key.
 *
 * Never throws: the caller (`wipeSinglePeerHistory`) independently try/catches
 * each of its three steps, mirroring how `clearMessages`/`clearDirectMessageContact`
 * are already wrapped there.
 */
export async function clearDmReactionsForPeer(peerPubkeyHex: string): Promise<void> {
  const dmReactionPrefix = 'few:reactions:dm:';
  const targetLower = peerPubkeyHex.toLowerCase();
  const { keys, delMany } = await import('idb-keyval');

  const allKeys = await keys();
  const heldDmPrefix = `${HELD_PREFIX}dm:`;
  const matchingKeys = allKeys.filter(
    (k): k is string =>
      typeof k === 'string' &&
      k.startsWith(dmReactionPrefix) &&
      k.slice(dmReactionPrefix.length).toLowerCase() === targetLower,
  );
  const heldKeys = allKeys.filter(
    (k): k is string =>
      typeof k === 'string' &&
      k.startsWith(heldDmPrefix) &&
      k.slice(heldDmPrefix.length).toLowerCase() === targetLower,
  );

  if (matchingKeys.length === 0 && heldKeys.length === 0) return;
  beginWipe(matchingKeys);
  try {
    await wipeHeldKeys(heldKeys, delMany);
    if (matchingKeys.length > 0) await wipeDmReactionKeys(matchingKeys, delMany);
  } finally {
    endWipe(matchingKeys);
  }
}

/** Deletes held-reaction keys after draining their in-flight queue turns. */
async function wipeHeldKeys(
  heldKeys: string[],
  delMany: (keys: string[]) => Promise<void>,
): Promise<void> {
  if (heldKeys.length === 0) return;
  const inflight = heldKeys.map((k) => heldQueues.get(k)).filter((p): p is Promise<unknown> => p !== undefined);
  if (inflight.length > 0) await Promise.allSettled(inflight);
  for (const k of heldKeys) heldQueues.delete(k);
  await delMany(heldKeys);
}

async function wipeDmReactionKeys(
  matchingKeys: string[],
  delMany: (keys: string[]) => Promise<void>,
): Promise<void> {
  // Drain any in-flight write for these keys BEFORE deleting — mirrors
  // clearAllReactions/purgeStrangerDmReactions: without this, a write that is
  // mid-flight when delMany() fires may resolve AFTER the delete, re-creating
  // a key.
  const inflight = matchingKeys
    .map((k) => writeQueues.get(k))
    .filter((p): p is Promise<unknown> => p !== undefined);
  if (inflight.length > 0) {
    await Promise.allSettled(inflight);
  }

  for (const key of matchingKeys) {
    cache.delete(key);
    writeQueues.delete(key);
  }
  try {
    await delMany(matchingKeys);
  } finally {
    for (const key of matchingKeys) announce(key);
  }
  for (const key of matchingKeys) emit(key);
}

/**
 * Purges reaction-aggregate IDB keys for stranger DM peers (AC-PURGE-6).
 *
 * Follows the `clearAllReactions` pattern: enumerates keys matching
 * `few:reactions:dm:<peerHex>`, calls `isAllowedDmSender` on the
 * `<peerHex>` suffix, and `del()`s the key when the peer is a stranger.
 * Keys in the `few:reactions:group:` namespace are NEVER touched.
 *
 * In-memory cache entries for purged keys are evicted so the next
 * `loadReactions` call re-reads from IDB (which will return undefined/[]).
 */
export async function purgeStrangerDmReactions(
  getWhitelist: () => walledGarden.WhitelistArgs,
): Promise<void> {
  const { isAllowedDmSender } = walledGarden;
  const { keys, delMany } = await import('idb-keyval');

  const { groups, knownPeers, ownPubkeyHex } = getWhitelist();
  const dmReactionPrefix = 'few:reactions:dm:';

  const allKeys = await keys();
  const dmReactionKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(dmReactionPrefix),
  );

  const strangerKeys: string[] = [];
  for (const key of dmReactionKeys) {
    const peerHex = key.slice(dmReactionPrefix.length);
    if (!isAllowedDmSender(peerHex, groups, knownPeers, ownPubkeyHex)) {
      strangerKeys.push(key);
    }
  }

  // Held reactions of a stranger peer never outlive the peer's thread.
  const heldDmPrefix = `${HELD_PREFIX}dm:`;
  const strangerHeldKeys = allKeys.filter(
    (k): k is string =>
      typeof k === 'string' &&
      k.startsWith(heldDmPrefix) &&
      !isAllowedDmSender(k.slice(heldDmPrefix.length), groups, knownPeers, ownPubkeyHex),
  );
  await wipeHeldKeys(strangerHeldKeys, delMany);

  // Optimization guard: delMany([]) is a no-op; this guard avoids the call.
  if (strangerKeys.length > 0) {
    beginWipe(strangerKeys);
    try {
      // Drain in-flight write queue entries for the stranger keys BEFORE delMany.
      // Without this, an enqueue that is mid-flight when delMany fires may
      // resolve AFTER the delete, re-creating the key (in-flight write race).
      // Mirror the clearAllReactions() pattern: await Promise.allSettled(inflight)
      // first, then clear cache + queue handles, then delete from IDB.
      const inflightForKeys = strangerKeys
        .map((k) => writeQueues.get(k))
        .filter((p): p is Promise<unknown> => p !== undefined);
      if (inflightForKeys.length > 0) {
        await Promise.allSettled(inflightForKeys);
      }
      // Evict in-memory cache and write-queue handles for purged keys.
      for (const key of strangerKeys) {
        cache.delete(key);
        writeQueues.delete(key);
      }
      try {
        await delMany(strangerKeys);
      } finally {
        for (const key of strangerKeys) announce(key);
      }
    } finally {
      endWipe(strangerKeys);
    }
  }
}
