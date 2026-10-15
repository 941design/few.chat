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
 * never subscribed again). Two bounds keep the store small:
 *   - RUMOR_JOURNAL_MAX_AGE_MS (30 days): an entry not replayed within a month
 *     belongs to a group this device no longer opens; dropping it is safe.
 *   - RUMOR_JOURNAL_MAX_PER_GROUP (1000): newest kept. Equal to the dispatcher's
 *     per-group dedup LRU cap, so one replay batch can never evict its own ids
 *     from the LRU and re-admit a live duplicate.
 */

import { createStore, set, del, delMany, entries, keys, clear } from 'idb-keyval';

export const RUMOR_JOURNAL_DB_NAME = 'few-rumor-journal';
export const RUMOR_JOURNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RUMOR_JOURNAL_MAX_PER_GROUP = 1000;

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
 * malformed rows, rows at/over max age, and per-group overflow (oldest beyond
 * the cap).
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
  for (const [groupId, list] of keep) {
    list.sort((a, b) => a.receivedAt - b.receivedAt);
    const overflow = list.splice(0, Math.max(0, list.length - RUMOR_JOURNAL_MAX_PER_GROUP));
    for (const e of overflow) drop.push(journalKey(groupId, e.rumorId));
  }
  return { keep, drop };
}

/**
 * Pending (un-acked) entries for one group, oldest first. Applies the age/cap
 * bounds (store-wide — the read covers every row anyway) and deletes what it
 * drops.
 */
export async function listPendingRumors(
  groupId: string,
  opts: { now?: number } = {},
): Promise<RumorJournalEntry[]> {
  const { keep, drop } = partition(await entries(journalStore), opts.now ?? Date.now());
  await delMany(drop, journalStore);
  return keep.get(groupId) ?? [];
}

/** Apply the age/cap bounds across every group. Returns the number removed. */
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
