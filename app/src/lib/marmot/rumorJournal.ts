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
 * ingestion starts. The reverse cut (journal written, state not saved) is
 * harmless: relay redelivery re-decrypts, the put is idempotent, and the
 * dispatcher's LRU swallows the duplicate.
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

import { createStore, set, del, delMany, entries, keys, clear } from 'idb-keyval';

export const RUMOR_JOURNAL_DB_NAME = 'few-rumor-journal';
export const RUMOR_JOURNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Journal one decrypted rumor. Idempotent per (groupId, rumorId). */
export async function putRumor(entry: Omit<RumorJournalEntry, 'receivedAt'>): Promise<void> {
  const value: RumorJournalEntry = {
    groupId: entry.groupId,
    rumorId: entry.rumorId,
    senderPubkey: entry.senderPubkey,
    data: entry.data,
    receivedAt: nextStamp(),
  };
  await set(journalKey(entry.groupId, entry.rumorId), value, journalStore);
}

/** Acknowledge (delete) an entry once the dispatcher's handlers ran. */
export async function ackRumor(groupId: string, rumorId: string): Promise<void> {
  await del(journalKey(groupId, rumorId), journalStore);
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
 * drops, best-effort.
 */
export async function listPendingRumors(
  groupId: string,
  opts: { now?: number } = {},
): Promise<RumorJournalEntry[]> {
  const { keep, drop } = partition(await entries(journalStore), opts.now ?? Date.now());
  // Cleanup is best-effort: a failed delete of expired/malformed rows must not
  // withhold the pending entries from replay (they stay stored either way).
  await delMany(drop, journalStore).catch((err: unknown) => {
    console.warn('[rumorJournal] expiry cleanup failed:', err);
  });
  return keep.get(groupId) ?? [];
}

/** Apply the age bound across every group. Returns the number removed. */
export async function sweepRumorJournal(opts: { now?: number } = {}): Promise<number> {
  const { drop } = partition(await entries(journalStore), opts.now ?? Date.now());
  await delMany(drop, journalStore);
  return drop.length;
}

/** Drop every entry of one group (leave purge). */
export async function clearRumorJournalForGroup(groupId: string): Promise<void> {
  const prefix = `${groupId}:`;
  const all = await keys(journalStore);
  await delMany(all.filter((k) => String(k).startsWith(prefix)), journalStore);
}

/** Drop the whole journal (account-scoped data clear). */
export async function clearAllRumorJournal(): Promise<void> {
  await clear(journalStore);
}

/** Shape EpochResolver hands to `onApplicationMessage`. */
export interface JournalableApplicationMessage {
  rumor: { id: string };
  data: Uint8Array;
  senderPubkey: string;
}

/**
 * EpochResolver `onApplicationMessage` callback that journals each delivered
 * rumor for `groupId`. Rejects (the resolver warns and continues) when the
 * rumor carries no id — it could never be acked.
 */
export function createApplicationMessageJournaler(
  groupId: string,
): (msg: JournalableApplicationMessage) => Promise<void> {
  return async ({ rumor, data, senderPubkey }) => {
    if (typeof rumor?.id !== 'string' || rumor.id.length === 0) {
      throw new Error('rumorJournal: rumor without id cannot be journaled');
    }
    await putRumor({ groupId, rumorId: rumor.id, senderPubkey, data });
  };
}
