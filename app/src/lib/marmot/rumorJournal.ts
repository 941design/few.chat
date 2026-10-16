/**
 * rumorJournal.ts — write-ahead journal for decrypted MLS application rumors.
 *
 * Why (bug: mls-message-lost-on-unload-after-ingest): marmot-ts persists the
 * advanced MLS state (`save()` → one IDB put) right after it emits
 * `authenticatedApplicationMessage`, while the dispatcher runs its handlers
 * asynchronously on a queue (several IDB round-trips). A page unload in that
 * window advanced the ratchet on disk but never stored the message: the rumor
 * could never be decrypted again and was lost for good.
 *
 * The fix journals the decrypted bytes BEFORE the library resumes past its
 * `yield` (EpochResolver awaits `onApplicationMessage` inside its `for await`
 * body — see the guard comment there). By JS ordering: journal put resolves ⇒
 * generator resumes ⇒ emit ⇒ state save. The dispatcher acks (deletes) an
 * entry once its handlers ran; on the next session MarmotContext replays every
 * still-pending entry through the same dispatcher listener before live
 * ingestion starts. The dispatcher acks only a rumor whose handlers all
 * completed (bug: journal-ack-before-durable-side-effects); one whose durable
 * side effect failed stays here and is re-handled at the next subscription,
 * up to RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS failed attempts (a poison rumor is
 * then dropped with a warning). The reverse cut (journal written, state not
 * saved) is harmless: relay redelivery re-decrypts, the put is idempotent,
 * and the dispatcher's LRU swallows the duplicate.
 *
 * Scope & privacy: local, per-device and transient. Never exported in relay
 * backups (collectBackupPayload reads only its own stores), never published —
 * no new network traffic. Cleared with the other account-scoped IDB data
 * (clearAllGroupData) and per group on leave.
 *
 * Bounds: entries normally live for milliseconds. Pending entries accumulate
 * only when a session dies mid-dispatch (or for a group whose dispatcher is
 * never subscribed again). They are bounded by AGE ONLY:
 *   - RUMOR_JOURNAL_MAX_AGE_MS (30 days): an entry not replayed within a month
 *     belongs to a group this device no longer opens; dropping it is safe.
 * There is deliberately no count cap (bug: rumor-journal-cap-evicts-unapplied).
 * Every row in this store is by construction NOT yet applied (the dispatcher's
 * ack deletes it), so any count-based eviction younger than the age bound
 * destroys messages that can never be decrypted again — exactly what this
 * journal exists to prevent (an interrupted catch-up of >1000 rumors lost the
 * overflow under the former 1000-per-group cap). Storage stays bounded: the
 * journal can hold at most what the relays delivered to this device in 30
 * days, the same order of data the chat store keeps permanently. The former
 * reason for the cap — a replay batch must not evict its own ids from the
 * dispatcher's dedup LRU — is now handled by the dispatcher itself: replay()
 * widens that group's dedup window by the batch size.
 */

// idb-keyval update() is not transaction-bound and may never settle (it wires
// only the get's onsuccess: a get error or an abort leaves its promise
// pending); do not reintroduce it — putRumor uses the store callback.
import { createStore, get, del, delMany, entries, keys, clear, promisifyRequest } from 'idb-keyval';

export const RUMOR_JOURNAL_DB_NAME = 'few-rumor-journal';
export const RUMOR_JOURNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Failed dispatch attempts after which an entry is dropped as poison (the
 * dispatcher acks it with a warning naming kind and id). Each attempt is one
 * subscription's run of the rumor's handlers — so a deterministic failure
 * stops retrying after a few re-subscribes/startups instead of 30 days.
 */
export const RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS = 5;
/** Bound on the session's remembered failed acks (oldest forgotten first). */
export const APPLIED_UNACKED_CAP = 1000;

const journalStore = createStore(RUMOR_JOURNAL_DB_NAME, 'rumors');

export interface RumorJournalEntry {
  groupId: string;
  rumorId: string;
  /** MLS-authenticated sender (hex), exactly as the library delivered it. */
  senderPubkey: string;
  /** The serialized application data — the bytes the dispatcher receives. */
  data: Uint8Array;
  /** Strictly increasing per module instance; FIFO replay order. */
  receivedAt: number;
  /**
   * The sender's leaf identity (pendingRemovalStorage.leafIdentityOf) in the
   * ratchet tree of the epoch the message was encrypted in, captured at first
   * receipt. Lets a replayed leave intent be checked against the membership
   * that sent it (bug: journal-replayed-leave-evicts-rejoined-member). Absent
   * when it could not be determined, and on rows written before it existed.
   */
  senderLeafIdentity?: string;
  /** Failed dispatch attempts so far (recordRumorFailure); absent = none. */
  attempts?: number;
}

function journalKey(groupId: string, rumorId: string): string {
  return `${groupId}:${rumorId}`;
}

let lastStamp = 0;
function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

function isEntry(value: unknown): value is RumorJournalEntry {
  const v = value as Partial<RumorJournalEntry> | null | undefined;
  return (
    !!v &&
    typeof v.groupId === 'string' &&
    typeof v.rumorId === 'string' &&
    typeof v.senderPubkey === 'string' &&
    v.data instanceof Uint8Array &&
    typeof v.receivedAt === 'number'
  );
}

/**
 * Journal one decrypted rumor. Idempotent per (groupId, rumorId). Read, merge
 * and put run in ONE readwrite transaction through the store callback, which
 * always settles: a re-journal (a relay redelivery) keeps an existing row's
 * sender leaf identity when the new value has none, and keeps its
 * failed-attempt count, so neither is lost to a later put.
 */
export function putRumor(entry: Omit<RumorJournalEntry, 'receivedAt' | 'attempts'>): Promise<void> {
  const key = journalKey(entry.groupId, entry.rumorId);
  return journalStore('readwrite', (os) => {
    const read = os.get(key);
    read.onsuccess = () => {
      // Any throw here aborts the transaction, so promisifyRequest rejects —
      // the caller (the ingest loop) must never wait on a promise that does
      // not settle.
      try {
        const prior = read.result as Partial<RumorJournalEntry> | undefined;
        const identity = entry.senderLeafIdentity || prior?.senderLeafIdentity;
        const value: RumorJournalEntry = {
          groupId: entry.groupId,
          rumorId: entry.rumorId,
          senderPubkey: entry.senderPubkey,
          data: entry.data,
          receivedAt: nextStamp(),
          ...(typeof identity === 'string' && identity ? { senderLeafIdentity: identity } : {}),
          ...(typeof prior?.attempts === 'number' ? { attempts: prior.attempts } : {}),
        };
        os.put(value, key);
      } catch {
        os.transaction.abort();
      }
    };
    // Settles on complete, abort or error — including a failed get (whose
    // error event bubbles to the transaction and aborts it).
    return promisifyRequest(os.transaction);
  });
}

/**
 * Count one failed dispatch attempt on the rumor's row (read-increment-put in
 * one readwrite transaction) and return the new count; 0 when there is no
 * (well-formed) row. Rejects on IDB failure.
 */
export function recordRumorFailure(groupId: string, rumorId: string): Promise<number> {
  const key = journalKey(groupId, rumorId);
  let attempts = 0;
  return journalStore('readwrite', (os) => {
    const read = os.get(key);
    read.onsuccess = () => {
      const prior: unknown = read.result;
      if (!isEntry(prior)) return;
      attempts = (typeof prior.attempts === 'number' ? prior.attempts : 0) + 1;
      os.put({ ...prior, attempts }, key);
    };
    return promisifyRequest(os.transaction).then(() => attempts);
  });
}

/**
 * Whether a journal row exists for the rumor, and the sender leaf identity
 * journaled with it at first receipt (absent: none recorded, or malformed).
 * Rejects on IDB failure.
 */
export async function getJournaledSenderLeafIdentity(
  groupId: string,
  rumorId: string,
): Promise<{ journaled: boolean; identity?: string }> {
  const value = (await get(journalKey(groupId, rumorId), journalStore)) as Partial<RumorJournalEntry> | undefined;
  if (value === undefined) return { journaled: false };
  const identity = value.senderLeafIdentity;
  return typeof identity === 'string' && identity.length > 0 ? { journaled: true, identity } : { journaled: true };
}

// Session-level record of entries whose handlers completed but whose ack (the
// delete) failed (bug: journal-ack-failure-replays-applied-rows). They are
// already applied: never handed to replay again in this session, and their
// delete is retried after the next successful ack and at the next listing.
// Lost on reload — the row is then replayed once more (handlers are
// idempotent) and acked again.
// Bounded: pruned on age eviction and clears, capped at APPLIED_UNACKED_CAP
// (a forgotten key only costs one idempotent re-dispatch).
const appliedUnacked = new Set<string>();

function rememberUnacked(key: string): void {
  appliedUnacked.add(key);
  if (appliedUnacked.size > APPLIED_UNACKED_CAP) {
    appliedUnacked.delete(appliedUnacked.values().next().value as string);
  }
}

function forgetUnacked(keys: Iterable<IDBValidKey>): void {
  for (const key of keys) appliedUnacked.delete(String(key));
}

/**
 * Acknowledge (delete) an entry once the dispatcher's handlers completed. A
 * failed delete is remembered as applied for this session and rethrown; a
 * successful one also retries the remembered deletes, best-effort.
 */
export async function ackRumor(groupId: string, rumorId: string): Promise<void> {
  const key = journalKey(groupId, rumorId);
  try {
    await del(key, journalStore);
  } catch (err) {
    rememberUnacked(key);
    throw err;
  }
  appliedUnacked.delete(key);
  await retryFailedAcks();
}

/** Retry the remembered failed acks, best-effort. Never rejects. */
async function retryFailedAcks(): Promise<void> {
  if (appliedUnacked.size === 0) return;
  const retry = [...appliedUnacked];
  try {
    await delMany(retry, journalStore);
  } catch (err) {
    console.warn('[rumorJournal] ack retry failed:', err);
    return;
  }
  forgetUnacked(retry);
}

/**
 * Partition rows into the ones to keep (grouped by group, oldest first — IDB
 * returns rows in KEY order, not insertion order) and the keys to delete:
 * malformed rows and rows at/over max age. Never evicts by count (see Bounds).
 */
function partition(
  rows: Array<[IDBValidKey, unknown]>,
  now: number,
): { keep: Map<string, RumorJournalEntry[]>; drop: IDBValidKey[] } {
  const keep = new Map<string, RumorJournalEntry[]>();
  const drop: IDBValidKey[] = [];
  for (const [key, value] of rows) {
    if (!isEntry(value) || now - value.receivedAt >= RUMOR_JOURNAL_MAX_AGE_MS) {
      drop.push(key);
      continue;
    }
    const list = keep.get(value.groupId) ?? [];
    list.push(value);
    keep.set(value.groupId, list);
  }
  for (const list of keep.values()) list.sort((a, b) => a.receivedAt - b.receivedAt);
  return { keep, drop };
}

/**
 * Pending (un-acked) entries for one group, oldest first. Applies the age
 * bound (store-wide — the read covers every row anyway) and deletes what it
 * drops, best-effort. Entries already applied in this session whose ack
 * failed are neither returned nor re-dispatched; their delete is retried.
 */
export async function listPendingRumors(
  groupId: string,
  opts: { now?: number } = {},
): Promise<RumorJournalEntry[]> {
  const { keep, drop } = partition(await entries(journalStore), opts.now ?? Date.now());
  // Cleanup is best-effort: a failed delete of expired/malformed rows must not
  // withhold the pending entries from replay (they stay stored either way).
  // Expired/malformed rows are never returned again: forget them as acks too.
  forgetUnacked(drop);
  await delMany(drop, journalStore).catch((err: unknown) => {
    console.warn('[rumorJournal] expiry cleanup failed:', err);
  });
  // Filter BEFORE the retry: a retried row was read above but is applied.
  const pending = (keep.get(groupId) ?? []).filter((e) => !appliedUnacked.has(journalKey(e.groupId, e.rumorId)));
  await retryFailedAcks();
  return pending;
}

/** Apply the age bound across every group. Returns the number removed. */
export async function sweepRumorJournal(opts: { now?: number } = {}): Promise<number> {
  const { drop } = partition(await entries(journalStore), opts.now ?? Date.now());
  forgetUnacked(drop);
  await delMany(drop, journalStore);
  return drop.length;
}

/** Drop every entry of one group (leave purge). */
export async function clearRumorJournalForGroup(groupId: string): Promise<void> {
  const prefix = `${groupId}:`;
  forgetUnacked([...appliedUnacked].filter((k) => k.startsWith(prefix)));
  const all = await keys(journalStore);
  await delMany(all.filter((k) => String(k).startsWith(prefix)), journalStore);
}

/** Drop the whole journal (account-scoped data clear). */
export async function clearAllRumorJournal(): Promise<void> {
  appliedUnacked.clear();
  await clear(journalStore);
}

/** Shape EpochResolver hands to `onApplicationMessage`. */
export interface JournalableApplicationMessage {
  rumor: { id: string };
  data: Uint8Array;
  senderPubkey: string;
  /** See RumorJournalEntry.senderLeafIdentity. */
  senderLeafIdentity?: string;
}

/**
 * EpochResolver `onApplicationMessage` callback that journals each delivered
 * rumor for `groupId`. Rejects (the resolver warns and continues) when the
 * rumor carries no id — it could never be acked.
 */
export function createApplicationMessageJournaler(
  groupId: string,
): (msg: JournalableApplicationMessage) => Promise<void> {
  return async ({ rumor, data, senderPubkey, senderLeafIdentity }) => {
    if (typeof rumor?.id !== 'string' || rumor.id.length === 0) {
      throw new Error('rumorJournal: rumor without id cannot be journaled');
    }
    await putRumor({ groupId, rumorId: rumor.id, senderPubkey, data, senderLeafIdentity });
  };
}
