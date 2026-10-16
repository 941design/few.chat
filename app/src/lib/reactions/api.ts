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

/**
 * Writes an optimistic Reaction row to the store. The row must be in-flight
 * (eventId === ''). Listeners are notified after the idb write resolves.
 *
 * AC-12.
 */
export function applyOptimistic(thread: ReactionThreadKey, row: Reaction): Promise<Reaction[] | null> {
  const key = idbKeyFor(thread);
  return enqueue(key, async (current) => {
    // Idempotent on row id
    if (current.some((r) => r.id === row.id)) return null;
    return [...current, row];
  });
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
  return enqueue(key, async (current) => {
    const idx = current.findIndex(
      (r) =>
        r.messageId === messageId &&
        r.reactorPubkey === reactorPubkey &&
        r.emoji === emoji &&
        !r.removed,
    );
    if (idx === -1) return null;
    const updated = [...current];
    updated[idx] = { ...updated[idx], removed: true };
    return updated;
  });
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
): Promise<Reaction[] | null> {
  const key = idbKeyFor(thread);
  return enqueue(key, async (current) => {
    const target = current.find((r) => r.id === optimisticId);
    // Only roll back if the row is still in-flight
    if (!target || target.eventId !== '') return null;
    return current.filter((r) => r.id !== optimisticId);
  });
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
  const senderPubkey = sender?.pubkey ?? rumor.pubkey;

  // Extract the e-tag value (first occurrence)
  // Guard against malformed tags where t[0] is absent or non-string.
  const eTag = rumor.tags.find((t) => typeof t[0] === 'string' && t[0] === 'e');
  if (!eTag || !eTag[1]) return null;
  const messageId = eTag[1];

  // Extract emoji from content (for the upsert key)
  const emoji = rumor.content;
  const isRemoval = emoji === '-';

  const key = idbKeyFor(thread);

  let result: { messageId: string } | null = null;

  await enqueue(key, async (current) => {
    // Pre-work fix (story-07): the leaf module always upserts — the "silent discard if
    // message unknown" rule (spec §2.4, AC-11) is enforced by the dispatcher, not here.
    // MarmotContext case 7: gates on loadMessages(groupId); ContactChat kind-7 dispatch
    // gates on the in-memory messages array. Removing the check here lets the first
    // reaction to any message land correctly (the prior check falsely discarded it when
    // no prior reaction row existed for that messageId).

    // Dedup by eventId (AC-09)
    if (current.some((r) => r.eventId === rumor.id && rumor.id !== '')) {
      // result stays null — no write
      return null;
    }

    if (isRemoval) {
      // AC-10, D2: tombstone the matching (messageId, reactorPubkey, emoji) row.
      //
      // Collect all ["emoji", glyph] tags (case-insensitive tag name; glyph is
      // case-sensitive Unicode). D2 multi-emoji policy requires we know *which*
      // emoji is being removed; an ambiguous rumor is silently discarded.
      const emojiTags = rumor.tags
        .filter((t) => typeof t[0] === 'string' && t[0].toLowerCase() === 'emoji' && typeof t[1] === 'string' && t[1].length > 0)
        .map((t) => t[1] as string);
      const distinctEmojis = [...new Set(emojiTags)];

      if (distinctEmojis.length > 1) {
        // Multiple distinct emoji tags — out-of-spec rumor, silent discard (§2.4).
        return null;
      }

      if (distinctEmojis.length === 1) {
        // Exactly one emoji tag: narrow tombstone to (messageId, reactorPubkey, emoji).
        const targetEmoji = distinctEmojis[0];
        const idx = current.findIndex(
          (r) =>
            r.messageId === messageId &&
            r.reactorPubkey === senderPubkey &&
            r.emoji === targetEmoji &&
            !r.removed,
        );
        if (idx === -1) {
          // No matching row — return null (no write), §2.4 silent discard.
          return null;
        }
        const updated = [...current];
        updated[idx] = { ...updated[idx], removed: true, eventId: rumor.id };
        result = { messageId };
        return updated;
      }

      // No emoji tag present: tombstone only if exactly one non-removed row
      // exists for (messageId, reactorPubkey) — unambiguous single-emoji case.
      // Zero or multiple rows → silent discard (§2.4, D2 safety).
      const candidates = current.filter(
        (r) => r.messageId === messageId && r.reactorPubkey === senderPubkey && !r.removed,
      );
      if (candidates.length !== 1) {
        return null;
      }
      const target = candidates[0];
      const idx = current.indexOf(target);
      const updated = [...current];
      updated[idx] = { ...updated[idx], removed: true, eventId: rumor.id };
      result = { messageId };
      return updated;
    }

    // Upsert: (messageId, reactorPubkey, emoji) triple
    const existingIdx = current.findIndex(
      (r) =>
        r.messageId === messageId &&
        r.reactorPubkey === senderPubkey &&
        r.emoji === emoji,
    );

    let updated: Reaction[];
    if (existingIdx !== -1) {
      // If the existing row is already removed, a later-arriving reaction event
      // (out-of-order on the live subscription) must not revive it. The removal
      // wins regardless of the order events arrive. This prevents the live-sub
      // re-delivery race where both the reaction and its removal are in the relay
      // and arrive in reverse order.
      if (current[existingIdx].removed) {
        // Removal wins — treat as already-processed, no write.
        return null;
      }
      // Update existing row (e.g. confirm optimistic row by assigning eventId)
      updated = [...current];
      updated[existingIdx] = {
        ...updated[existingIdx],
        eventId: rumor.id,
        removed: false,
      };
    } else {
      // New row
      const newRow: Reaction = {
        id: rumor.id,
        messageId,
        reactorPubkey: senderPubkey,
        emoji,
        eventId: rumor.id,
        createdAt: rumor.created_at * 1000, // rumor.created_at is unix seconds; Reaction.createdAt is ms
        removed: false,
      };
      updated = [...current, newRow];
    }

    result = { messageId };
    return updated;
  });

  return result;
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
    const inflight = Array.from(writeQueues.values());
    await Promise.allSettled(inflight);
    writeQueues.clear();
    cache.clear();
    const allKeys = await keys();
    const targets = allKeys.filter(
      (k): k is string =>
        typeof k === 'string' &&
        (k.startsWith('few:reactions:group:') || k.startsWith('few:reactions:dm:')),
    );
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
  const matchingKeys = allKeys.filter(
    (k): k is string =>
      typeof k === 'string' &&
      k.startsWith(dmReactionPrefix) &&
      k.slice(dmReactionPrefix.length).toLowerCase() === targetLower,
  );

  if (matchingKeys.length === 0) return;
  beginWipe(matchingKeys);
  try {
    await wipeDmReactionKeys(matchingKeys, delMany);
  } finally {
    endWipe(matchingKeys);
  }
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
