/**
 * Poll persistence layer — idb-keyval implementation.
 *
 * Polls are stored per-group under the key `few:polls:{groupId}`.
 * Votes are stored per (group, poll) under `few:poll-votes:{groupId}:{pollId}`.
 * Early votes (poll not yet received) are queued per group under
 * `few:poll-pending-votes:{groupId}`; early closes and early poll_close chat
 * announcements likewise under `few:poll-pending-closes:{groupId}` and
 * `few:poll-pending-close-announcements:{groupId}`. Our own last allocated vote
 * seq per poll lives under `few:poll-vote-seq:{groupId}` (allocated before the
 * vote is sent, pollCast); the receipt clock's high-water mark under
 * `few:poll-receipt-clock`.
 */

// Never idb-keyval update(): it is not transaction-bound and can hang on a
// read error/abort (see rumorJournal.ts). Read-check-write steps use the store
// callback + promisifyRequest(os.transaction) (pollTxn below).
import { get, set, del, keys, delMany, createStore, promisifyRequest } from 'idb-keyval';
import type { UseStore } from 'idb-keyval';
import { postStoreChanged } from '@/src/lib/crossTab';

// ---- Types ----

export interface PollOptionDef {
  /** Short alphanumeric identifier (e.g. "A", "B", "C") */
  id: string;
  /** Human-readable label */
  label: string;
}

export interface PollResult {
  optionId: string;
  label: string;
  count: number;
}

export interface Poll {
  id: string;
  groupId: string;
  title: string;
  description?: string;
  options: PollOptionDef[];
  pollType: 'singlechoice' | 'multiplechoice';
  creatorPubkey: string;
  createdAt: number;
  closed: boolean;
  results?: PollResult[];
  totalVoters?: number;
}

export interface PollVote {
  /** Compound key: `${pollId}:${voterPubkey}` (unique within the group-scoped vote list) */
  id: string;
  /**
   * Group the vote was received in. Poll ids are only unique per group
   * (first-open-wins is per group), so a vote is identified by
   * (groupId, pollId, voter) — never by pollId alone.
   */
  groupId: string;
  pollId: string;
  voterPubkey: string;
  responses: string[];
  /** Sender's rumor created_at, in ms. */
  votedAt: number;
  /**
   * Per-(poll, voter) Lamport sequence number from the wire (pollSync
   * PollVotePayload.seq). Absent on rows stored before it existed and on
   * votes from legacy clients — ranked as 0 (isNewerVote).
   */
  seq?: number;
  /** Id of the vote rumor — last tie-breaker of the order. Absent = ''. */
  rumorId?: string;
  /**
   * Local receipt time (ms) of the vote on THIS member — stamped by
   * saveVoteIfNewer when absent (an early vote keeps its queue receipt time).
   * Not part of the order: it only decides whether the vote arrived before a
   * close that was held because it came before the poll-open, so the closed
   * tally does not depend on where the open landed (bug:
   * poll-residual-ordering-and-close-retry). Absent on older rows = received
   * before anything else.
   */
  receivedAt?: number;
  /**
   * Older votes of the same voter that arrived on this member BEFORE the row's
   * own vote — kept only while they can still decide a tally "as of" a close
   * received between them (voteAsOf). The row itself is always the newest
   * vote by isNewerVote. Absent when empty.
   */
  superseded?: VoteSnapshot[];
}

/** The parts of a vote that a tally and the order need. */
export interface VoteSnapshot {
  responses: string[];
  votedAt: number;
  seq?: number;
  rumorId?: string;
  receivedAt?: number;
}

/** The fields that order two votes of the same voter for the same poll. */
export interface VoteOrderKey {
  seq?: number;
  votedAt: number;
  rumorId?: string;
}

/**
 * Total order on a voter's votes for one poll: seq, then created_at
 * (votedAt), then rumor id (lexicographic). Returns true when `a` is strictly
 * newer than `b`. Every member applies the same order, so all converge on the
 * same vote regardless of delivery order (bug:
 * poll-vote-ordering-and-early-close).
 *
 * Legacy votes (no seq) rank as seq 0 and with rumor id '' when absent, so a
 * vote carrying seq >= 1 always beats a legacy vote of the same voter — the
 * transitional case where one device still runs an old client: its later
 * vote cannot override a seq-carrying one. Legacy-vs-legacy falls back to
 * created_at, then id.
 */
export function isNewerVote(a: VoteOrderKey, b: VoteOrderKey): boolean {
  const seqA = a.seq ?? 0;
  const seqB = b.seq ?? 0;
  if (seqA !== seqB) return seqA > seqB;
  if (a.votedAt !== b.votedAt) return a.votedAt > b.votedAt;
  return (a.rumorId ?? '') > (b.rumorId ?? '');
}

/**
 * Upper bound on the votes of one voter for one poll kept for "as of a close"
 * tallies (stored row + superseded, and the early-vote queue). Pruning beyond
 * it is held-close aware (bug: poll-followups): the vote each held close of
 * the poll would count (voteAsOf at its receipt time) and the newest vote are
 * always kept, so the set can exceed the cap by at most one vote per held
 * close (one per poll and sender, MAX_PENDING_CLOSES_PER_GROUP per group);
 * the remaining room goes to the latest-received others. Only when the held
 * closes cannot be read at the write does it fall back to dropping the
 * earliest received — then a held close received before ALL kept votes of a
 * voter does not count that voter (residual, needs a read failure AND more
 * than this many vote changes after the close).
 */
export const MAX_VOTES_KEPT_PER_VOTER = 20;

const receivedRank = (v: { receivedAt?: number }) => v.receivedAt ?? -Infinity;

/**
 * The votes that can still decide a tally "as of" some receipt time: a vote
 * is dropped when another one is at least as new by isNewerVote AND arrived
 * no later (for any cut-off where the dropped one counts, the other counts
 * and wins). Identical votes (same order key) collapse to the earliest
 * received. Sorted by receipt, which is then also ascending by the order —
 * the last one is the newest vote. Bounded to MAX_VOTES_KEPT_PER_VOTER, except
 * that the vote each `cutoffs` receipt time selects (voteAsOf) and the newest
 * are never dropped.
 */
export function keptVotes<T extends VoteOrderKey & { receivedAt?: number }>(votes: T[], cutoffs: readonly number[] = []): T[] {
  return capKept(undominated(votes), cutoffs);
}

function undominated<T extends VoteOrderKey & { receivedAt?: number }>(votes: T[]): T[] {
  const kept = votes.filter((e, i) =>
    !votes.some((f, j) => {
      if (j === i || receivedRank(f) > receivedRank(e)) return false;
      if (isNewerVote(f, e)) return true;
      if (isNewerVote(e, f)) return false;
      return receivedRank(f) < receivedRank(e) || j < i;
    }),
  );
  kept.sort((a, b) => receivedRank(a) - receivedRank(b));
  return kept;
}

/** `sorted` is undominated(): ascending by receipt and by the order. */
function capKept<T extends { receivedAt?: number }>(sorted: T[], cutoffs: readonly number[]): T[] {
  const required = new Set<T>(sorted.slice(-1));
  for (const cutoff of cutoffs) {
    // The newest vote received no later than the cut-off = the last such one.
    const asOf = sorted.filter((v) => receivedRank(v) <= cutoff).pop();
    if (asOf) required.add(asOf);
  }
  const room = Math.max(MAX_VOTES_KEPT_PER_VOTER - required.size, 0);
  const others = sorted.filter((v) => !required.has(v));
  const extras = new Set(others.slice(Math.max(others.length - room, 0)));
  return sorted.filter((v) => required.has(v) || extras.has(v));
}

/**
 * Receipt times of the poll's held closes — the cut-offs pruning must keep a
 * vote for. Every sender's close counts (the creator may not be known yet;
 * extra cut-offs only keep more). A failed read falls back to no cut-offs
 * (the plain cap) and is logged: it must not fail the vote write.
 */
async function heldCloseCutoffs(groupId: string, pollId: string): Promise<number[]> {
  try {
    return (await closeQueue.load(groupId, pollId, Date.now())).map((c) => c.receivedAt);
  } catch (err) {
    console.warn('[pollPersistence] reading held closes for vote pruning failed; earliest-received votes may be dropped:', err);
    return [];
  }
}

/** keptVotes for a write: reads the held closes only when the cap bites. */
async function keepForWrite<T extends VoteOrderKey & { receivedAt?: number }>(votes: T[], groupId: string, pollId: string): Promise<T[]> {
  const sorted = undominated(votes);
  if (sorted.length <= MAX_VOTES_KEPT_PER_VOTER) return sorted;
  return capKept(sorted, await heldCloseCutoffs(groupId, pollId));
}

/**
 * The vote of a stored row that counts for a close this member received at
 * `cutoff`: the newest of the row and its superseded votes that arrived no
 * later than the cut-off, or null when none did. Without a cut-off the row
 * itself counts.
 */
export function voteAsOf(row: PollVote, cutoff: number): PollVote | null {
  let best: VoteSnapshot | null = null;
  for (const v of [row, ...(row.superseded ?? [])]) {
    if (receivedRank(v) > cutoff) continue;
    if (best === null || isNewerVote(v, best)) best = v;
  }
  if (best === null) return null;
  return best === row ? row : { ...row, ...snapshotOf(best) };
}

function snapshotOf(v: VoteSnapshot): VoteSnapshot {
  return {
    responses: v.responses,
    votedAt: v.votedAt,
    ...(v.seq === undefined ? {} : { seq: v.seq }),
    ...(v.rumorId === undefined ? {} : { rumorId: v.rumorId }),
    ...(v.receivedAt === undefined ? {} : { receivedAt: v.receivedAt }),
  };
}

const canonical = (vs: VoteSnapshot[]) => JSON.stringify(vs.map(snapshotOf));

/**
 * A vote received before its poll-open (AC-9). Responses are kept RAW: they
 * can only be validated against the poll's options once the poll exists, and
 * are then run through the same sanitisation as a live vote.
 */
export interface PendingPollVote {
  groupId: string;
  pollId: string;
  /** Authenticated sender of the vote rumor — never a payload field. */
  voterPubkey: string;
  responses: string[];
  votedAt: number;
  /** Wire seq (absent = legacy, ranks as 0). */
  seq?: number;
  /** Id of the vote rumor (order tie-breaker). */
  rumorId?: string;
  /** Local receipt time (ms) — drives TTL expiry and oldest-first eviction. */
  receivedAt: number;
}

/**
 * A poll-close received before its poll-open (AC-9). Bound to the
 * authenticated sender; applied at the open only if that sender is the
 * open's authenticated creator.
 */
export interface PendingPollClose {
  groupId: string;
  pollId: string;
  /** Authenticated sender of the close rumor — never a payload field. */
  closerPubkey: string;
  /** Sender's rumor created_at, in ms. */
  closedAt: number;
  /** Local receipt time (ms) — drives TTL expiry and oldest-first eviction. */
  receivedAt: number;
}

/**
 * A poll_close chat announcement received before its poll-open. Its content
 * is not kept: the chat gate re-derives title and tally from the stored poll
 * and votes, so only the identity of the rumor is needed to re-run it.
 */
export interface PendingCloseAnnouncement {
  groupId: string;
  pollId: string;
  /** Authenticated sender of the announcement rumor. */
  senderPubkey: string;
  rumorId: string;
  /** Rumor created_at, in SECONDS (as on the wire). */
  createdAt: number;
  /** Local receipt time (ms). */
  receivedAt: number;
}

// ---- Storage keys ----

const POLLS_PREFIX = 'few:polls:';
const VOTES_PREFIX = 'few:poll-votes:';
const PENDING_PREFIX = 'few:poll-pending-votes:';
const PENDING_CLOSES_PREFIX = 'few:poll-pending-closes:';
const PENDING_ANNOUNCEMENTS_PREFIX = 'few:poll-pending-close-announcements:';
const SEQ_RESERVATIONS_PREFIX = 'few:poll-vote-seq:';

function pollsKey(groupId: string): string {
  return `${POLLS_PREFIX}${groupId}`;
}

/**
 * Group-scoped vote key. groupId is an internal hex id (never contains ':'),
 * so the first ':' after the prefix unambiguously splits group from poll;
 * loadVotes additionally filters rows by their groupId/pollId fields.
 */
function votesKey(groupId: string, pollId: string): string {
  return `${VOTES_PREFIX}${groupId}:${pollId}`;
}

function pendingKey(groupId: string): string {
  return `${PENDING_PREFIX}${groupId}`;
}

// ---- Receipt clock ----

const RECEIPT_CLOCK_KEY = 'few:poll-receipt-clock';
/** How far ahead the persisted high-water mark is leased (one write per lease). */
export const RECEIPT_LEASE_MS = 60_000;

let lastReceipt = 0;
let leasedUntil = 0;
let clockSeed: Promise<void> | null = null;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Attempts of the seed read per seeding, and the linear backoff step between them. */
export const RECEIPT_SEED_ATTEMPTS = 3;
export const RECEIPT_SEED_RETRY_MS = 25;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Seed the clock from the persisted mark. A failed read is retried with a
 * short backoff (bounded: RECEIPT_SEED_ATTEMPTS tries, ~75 ms) before the
 * receipt is handed out, so a transient read error no longer lets a reload
 * after a backward wall-clock step stamp receipts below the previous
 * session's (bug: poll-followups). If every try fails the receipt is still
 * handed out — ingestion must never wait on an indeterminate read — and the
 * next receipt seeds again; until then the clock is only monotonic within
 * this page (residual, docs/behavior/polls.md §5).
 */
function seedReceiptClock(): Promise<void> {
  clockSeed ??= (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const stored = await get<unknown>(RECEIPT_CLOCK_KEY);
        if (isFiniteNumber(stored)) lastReceipt = Math.max(lastReceipt, stored);
        return;
      } catch (err) {
        if (attempt >= RECEIPT_SEED_ATTEMPTS) {
          clockSeed = null;
          console.warn('[pollPersistence] reading the receipt clock failed; retried at the next receipt:', err);
          return;
        }
        await pause(RECEIPT_SEED_RETRY_MS * attempt);
      }
    }
  })();
  return clockSeed;
}

/**
 * Local receipt time (ms) for a poll message, strictly increasing: within the
 * page (two messages in the same millisecond still get distinct, arrival-
 * ordered times) and across reloads and backward wall-clock steps — a
 * persisted high-water mark, leased RECEIPT_LEASE_MS ahead so it costs one
 * write per lease, seeds the clock above every receipt time handed out
 * before. "Did this vote arrive before that held close" therefore never
 * depends on clock resolution or clock changes (bug:
 * poll-residual-ordering-and-close-retry). A failed lease write is logged; the
 * clock stays monotonic in this page.
 */
export async function receiptNow(): Promise<number> {
  await seedReceiptClock();
  lastReceipt = Math.max(Date.now(), lastReceipt + 1);
  const t = lastReceipt;
  if (t >= leasedUntil) {
    leasedUntil = t + RECEIPT_LEASE_MS;
    const lease = leasedUntil;
    try {
      await enqueue(RECEIPT_CLOCK_KEY, async () => {
        const current = await get<unknown>(RECEIPT_CLOCK_KEY);
        await set(RECEIPT_CLOCK_KEY, Math.max(isFiniteNumber(current) ? current : 0, lease));
      });
    } catch (err) {
      leasedUntil = 0; // retry the lease at the next receipt
      console.warn('[pollPersistence] persisting the receipt clock failed:', err);
    }
  }
  return t;
}

// ---- Polls CRUD ----

/** Load all polls for a group, sorted newest-first by createdAt. */
export async function loadPolls(groupId: string): Promise<Poll[]> {
  const stored = await get<Poll[]>(pollsKey(groupId));
  return (stored ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

// Per-key write serialization to avoid race conditions (same pattern as chatPersistence.ts)
const writeQueues = new Map<string, Promise<void>>();

function enqueue(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  const settled = next.catch(() => {});
  writeQueues.set(key, settled);
  settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}

// ---- Read-check-write transactions ----

let keyvalStore: UseStore | null = null;
/**
 * A handle on idb-keyval's default database/store ('keyval-store'/'keyval' —
 * where every get/set above lands), for steps that must read and write in ONE
 * readwrite transaction. Created lazily (module load stays mock-friendly).
 */
const pollStore = (): UseStore => (keyvalStore ??= createStore('keyval-store', 'keyval'));

interface PollTxn {
  /** Read a key; `onValue` runs inside the transaction (it may read or put). */
  read(key: string, onValue: (value: unknown) => void, onError?: () => void): void;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  /** Every key of the store, read inside the transaction (os.getAllKeys). */
  allKeys(onKeys: (keys: IDBValidKey[]) => void): void;
}

/**
 * Run `body` in one readwrite transaction on the default store and resolve
 * with what it reports once the transaction COMMITTED. A throw in any step
 * aborts the transaction (nothing written) and rejects with that error; a
 * failed read aborts it too unless the step passed `onError` (then the
 * request error is swallowed and `onError` runs instead).
 */
function pollTxn<T>(body: (txn: PollTxn, done: (result: T) => void) => void, initial: T): Promise<T> {
  return pollStore()('readwrite', (os) => {
    let result = initial;
    let failure: unknown = null;
    const fail = (err: unknown) => {
      failure ??= err;
      try {
        os.transaction.abort();
      } catch {
        // already finished
      }
    };
    const step = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        fail(err);
      }
    };
    const txn: PollTxn = {
      read(key, onValue, onError) {
        const req = os.get(key);
        req.onsuccess = () => step(() => onValue(req.result));
        if (onError) {
          req.onerror = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            step(onError);
          };
        }
      },
      put(key, value) {
        os.put(value, key);
      },
      delete(key) {
        os.delete(key);
      },
      allKeys(onKeys) {
        const req = os.getAllKeys();
        req.onsuccess = () => step(() => onKeys(req.result));
      },
    };
    step(() => body(txn, (r) => { result = r; }));
    return promisifyRequest(os.transaction).then(
      () => result,
      (err: unknown) => {
        throw failure ?? err ?? new Error('poll storage transaction aborted');
      },
    );
  });
}

/**
 * Save or update a poll (upsert by id). Once a poll is stored closed its
 * votes' superseded snapshots are dead weight — only a held close of an OPEN
 * poll reads them (voteAsOf) — so they are dropped after the closed write
 * (bug: poll-followups). That clean-up is best-effort: the closed poll is
 * already stored; a failure is logged and leaves them (harmless) in place.
 */
export async function savePoll(poll: Poll): Promise<Poll | null> {
  const key = pollsKey(poll.groupId);
  if (!poll.closed) {
    await enqueue(key, async () => {
      const existing = (await get<Poll[]>(key)) ?? [];
      const idx = existing.findIndex((p) => p.id === poll.id);
      if (idx >= 0) {
        existing[idx] = poll;
      } else {
        existing.push(poll);
      }
      await set(key, existing);
      postStoreChanged('polls', poll.groupId);
    });
    return poll;
  }
  // The closed write (bug: poll-followups remediation 1): the poll is re-read
  // in the SAME readwrite transaction. Closing is monotonic and idempotent —
  // an already-closed poll is never overwritten (the first close wins, so a
  // stale sweep or handler cannot replace a correct closed tally), and a poll
  // that is no longer stored (left / wiped meanwhile) is not re-created.
  // Resolves the poll as stored afterwards (the earlier close when one won),
  // or null when there is no such poll.
  let stored: Poll | null = null;
  let wrote = false;
  await enqueue(key, async () => {
    stored = await pollTxn<Poll | null>((txn, done) => {
      txn.read(key, (value) => {
        const list = Array.isArray(value) ? (value as Poll[]) : [];
        const idx = list.findIndex((p) => p.id === poll.id);
        if (idx < 0) return done(null);
        if (list[idx].closed) return done(list[idx]);
        list[idx] = poll;
        txn.put(key, list);
        wrote = true;
        done(poll);
      });
    }, null);
  });
  if (stored === null) return null;
  if (wrote) postStoreChanged('polls', poll.groupId);
  // Also when an earlier close won (nothing written): a prune that failed at
  // that first close is retried by every later closed write of the poll.
  try {
    await dropSupersededVotes(poll.groupId, poll.id);
  } catch (err) {
    console.warn('[pollPersistence] dropping superseded votes of a closed poll failed; left in place:', err);
  }
  return stored;
}

/** One transaction: rows absent (purged) are never re-created. */
function dropSupersededVotes(groupId: string, pollId: string): Promise<void> {
  const key = votesKey(groupId, pollId);
  return enqueue(key, async () => {
    await pollTxn<void>((txn) => {
      txn.read(key, (existing) => {
        if (!Array.isArray(existing) || !existing.some((v: PollVote) => v.superseded !== undefined)) return;
        txn.put(key, (existing as PollVote[]).map(({ superseded: _dropped, ...row }) => row));
      });
    }, undefined);
  });
}

/** Get a single poll by id from a group. */
export async function getPoll(groupId: string, pollId: string): Promise<Poll | null> {
  const polls = await loadPolls(groupId);
  return polls.find((p) => p.id === pollId) ?? null;
}

// ---- Legacy vote-row migration ----

function isVoteShaped(v: unknown): v is Omit<PollVote, 'groupId'> & { groupId?: unknown } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pollId === 'string' &&
    typeof o.voterPubkey === 'string' &&
    Array.isArray(o.responses) &&
    typeof o.votedAt === 'number'
  );
}

/**
 * One-time migration of legacy `few:poll-votes:{pollId}` rows (no groupId) to
 * the group-scoped key. The owning group is recovered from the poll store: a
 * poll known in exactly one group moves there; a poll that is unknown, or
 * known in several groups (the cross-group injection case — the rows cannot be
 * attributed), is dropped. Legacy entries are recognised by content (no string
 * groupId), not key shape, so a key that happens to look group-scoped is still
 * handled. Idempotent: every write is a merge keyed by vote id where an
 * existing group-scoped row wins, and each key is rewritten in a single set,
 * so a re-run or crash-replay neither loses nor duplicates rows.
 */
export async function migrateLegacyVotes(): Promise<void> {
  const allKeys = (await keys()).filter((k): k is string => typeof k === 'string');

  const pollGroups = new Map<string, Set<string>>();
  for (const k of allKeys) {
    if (!k.startsWith(POLLS_PREFIX)) continue;
    const polls = (await get<Poll[]>(k)) ?? [];
    for (const p of polls) {
      if (!p || typeof p.id !== 'string' || typeof p.groupId !== 'string') continue;
      const set = pollGroups.get(p.id) ?? new Set<string>();
      set.add(p.groupId);
      pollGroups.set(p.id, set);
    }
  }

  // Per touched key: the legacy rows to merge in. Every write below re-reads
  // the key inside the per-key write queue (the same one saveVoteIfNewer uses), so a
  // vote saved concurrently — e.g. while a retried migration is in flight —
  // is merged, never clobbered by a stale snapshot.
  const additions = new Map<string, PollVote[]>();
  const touch = (k: string) => {
    const list = additions.get(k) ?? [];
    additions.set(k, list);
    return list;
  };

  for (const k of allKeys) {
    if (!k.startsWith(VOTES_PREFIX)) continue;
    const stored = await get<unknown[]>(k);
    const entries = Array.isArray(stored) ? stored : [];
    const hasLegacy = !Array.isArray(stored) || entries.some((v) => !isVoteShaped(v) || typeof v.groupId !== 'string');
    if (!hasLegacy) continue;
    touch(k); // its legacy/junk entries get stripped
    const legacyPollId = k.slice(VOTES_PREFIX.length);
    for (const v of entries) {
      if (!isVoteShaped(v) || typeof v.groupId === 'string') continue;
      if (v.pollId !== legacyPollId) continue;
      const groups = pollGroups.get(v.pollId);
      if (!groups || groups.size !== 1) continue;
      const [groupId] = groups;
      const target = touch(votesKey(groupId, v.pollId));
      if (target.some((t) => t.id === v.id)) continue;
      target.push({ ...v, groupId } as PollVote);
    }
  }

  // Keys gaining rows first, then pure sources: a crash part-way leaves the
  // legacy rows in place for the next run's merge, never a lost vote.
  const ordered = [...additions.entries()].sort(([, a], [, b]) => Number(b.length > 0) - Number(a.length > 0));
  for (const [k, added] of ordered) {
    await enqueue(k, async () => {
      const current = await get<unknown[]>(k);
      const scoped = (Array.isArray(current) ? current : []).filter(
        (v): v is PollVote => isVoteShaped(v) && typeof v.groupId === 'string',
      );
      // An existing group-scoped row (with the same id) wins over a legacy one.
      const merged = [...scoped, ...added.filter((a) => !scoped.some((v) => v.id === a.id))];
      if (merged.length > 0) {
        await set(k, merged);
      } else {
        await del(k);
      }
    });
  }
}

let migration: Promise<void> | null = null;

/**
 * Runs migrateLegacyVotes once per page session. A failure REJECTS (and is
 * retried on the next use): a vote read must never see a missing or
 * half-migrated row list, because a close persists the tally it computes from
 * that read forever. Readers therefore fail closed (handleClose and the
 * chatHandler poll_close gate both reject on a loadVotes throw); writers
 * tolerate the failure explicitly.
 */
function ensureVotesMigrated(): Promise<void> {
  if (!migration) {
    migration = migrateLegacyVotes().catch((err) => {
      migration = null;
      console.warn('[pollPersistence] legacy vote migration failed:', err);
      throw err;
    });
  }
  return migration;
}

/** For writers: wait for the migration but do not fail when it failed. */
function settleVotesMigration(): Promise<void> {
  return ensureVotesMigrated().catch(() => {});
}

// ---- Votes CRUD ----

/** Load all votes for a poll in a group. Never returns another group's rows. */
export async function loadVotes(groupId: string, pollId: string): Promise<PollVote[]> {
  await ensureVotesMigrated();
  const stored = await get<PollVote[]>(votesKey(groupId, pollId));
  return (stored ?? []).filter((v) => v.groupId === groupId && v.pollId === pollId);
}

/**
 * Merge a vote into the voter's stored row for the poll — inside the per-key
 * write queue, so it is the single serialisation point for every vote write
 * path (live handleVote, the early-vote replay, castVote, and rumor-journal
 * replay through handleVote). The row is always the newest vote seen by
 * isNewerVote ("max wins"), whatever order the writes arrive or interleave
 * in; older votes that arrived earlier are kept in `superseded` (keptVotes)
 * so a close held from before the open can still count the vote the voter
 * had at the close (voteAsOf). Resolves true when it wrote.
 *
 * One readwrite transaction reads the row list (and, only when the cap
 * bites, the poll's held closes — a failed read of those falls back to the
 * plain cap) and writes it. With `requirePoll` (the early-vote replay, also
 * run by the held poll-state sweep) the poll list is read in the same
 * transaction and nothing is written unless the poll is stored. With
 * clearPollData being ONE readwrite transaction over the same store, the two
 * serialise (IndexedDB runs overlapping readwrite transactions in creation
 * order, across connections): a requirePoll write created before the purge
 * commits first, and the purge's in-transaction key scan then sees and
 * deletes its vote key; one created after the purge reads no poll list and
 * writes nothing. So a sweep racing a leave or wipe cannot leave an orphan
 * vote row (bug: poll-followups remediations 1 and 2).
 */
export async function saveVoteIfNewer(vote: PollVote, opts: { requirePoll?: boolean } = {}): Promise<boolean> {
  // Receipt time is taken at the call, before any queue wait.
  const stamped: PollVote = vote.receivedAt === undefined ? { ...vote, receivedAt: await receiptNow() } : vote;
  // A write lands under the group-scoped key regardless of legacy rows, and
  // the legacy merge lets an existing group-scoped row win — safe to proceed.
  await settleVotesMigration();
  const key = votesKey(vote.groupId, vote.pollId);
  let wrote = false;
  await enqueue(key, async () => {
    wrote = await pollTxn<boolean>((txn, done) => {
      const merge = (stored: unknown) => {
        const existing = Array.isArray(stored) ? (stored as PollVote[]) : [];
        const idx = existing.findIndex((v) => v.id === vote.id);
        if (idx < 0) {
          existing.push(stamped);
          txn.put(key, existing);
          return done(true);
        }
        const { superseded: _old, ...current } = existing[idx];
        // The stored set as is (it may exceed the cap by held-close votes).
        const before = undominated<VoteSnapshot>([current, ...(existing[idx].superseded ?? [])]);
        const candidates = undominated<VoteSnapshot>([...before, stamped]);
        const finish = (cutoffs: number[]) => {
          const after = capKept(candidates, cutoffs);
          if (canonical(after) === canonical(before)) return;
          const newest = after[after.length - 1];
          const { superseded: _s, ...base } = stamped;
          const older = after.slice(0, -1).map(snapshotOf);
          existing[idx] = {
            ...base,
            responses: newest.responses,
            votedAt: newest.votedAt,
            seq: newest.seq,
            rumorId: newest.rumorId,
            receivedAt: newest.receivedAt,
            ...(older.length > 0 ? { superseded: older } : {}),
          };
          txn.put(key, existing);
          done(true);
        };
        if (candidates.length <= MAX_VOTES_KEPT_PER_VOTER) return finish([]);
        txn.read(
          `${PENDING_CLOSES_PREFIX}${vote.groupId}`,
          (closes) => finish(liveCloseCutoffs(closes, vote.pollId, Date.now())),
          () => {
            console.warn('[pollPersistence] reading held closes for vote pruning failed; earliest-received votes may be dropped');
            finish([]);
          },
        );
      };
      if (!opts.requirePoll) return txn.read(key, merge);
      txn.read(pollsKey(vote.groupId), (polls) => {
        if (!Array.isArray(polls) || !polls.some((p: Poll) => p.id === vote.pollId)) return; // purged: write nothing
        txn.read(key, merge);
      });
    }, false);
  });
  if (wrote) postStoreChanged('polls', vote.groupId);
  return wrote;
}

// ---- Own vote seq reservations ----

interface SeqReservation {
  pollId: string;
  /** Lower-cased: own-vote matching is case-insensitive (pollCast.nextVoteSeq). */
  voterPubkey: string;
  seq: number;
}

function isReservationShaped(e: unknown): e is SeqReservation {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.pollId === 'string' && typeof o.voterPubkey === 'string' && typeof o.seq === 'number';
}

/** The highest seq allocated for our own votes on a poll (0 if none). */
export async function loadVoteSeqReservation(groupId: string, pollId: string, voterPubkey: string): Promise<number> {
  const stored = await get<unknown[]>(`${SEQ_RESERVATIONS_PREFIX}${groupId}`);
  const me = voterPubkey.toLowerCase();
  const entry = (Array.isArray(stored) ? stored : []).find(
    (e): e is SeqReservation => isReservationShaped(e) && e.pollId === pollId && e.voterPubkey === me,
  );
  return entry?.seq ?? 0;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return typeof nav?.locks?.request === 'function' ? nav.locks : undefined;
}

/**
 * Allocate the seq of our next vote on a poll, durably, BEFORE it is sent
 * (bug: poll-residual-ordering-and-close-retry): one read–max–increment–write
 * step returning max(last allocated + 1, floor), where `floor` is what the
 * stored and queued votes demand (pollCast.nextVoteSeq). The step runs in this
 * page's per-key write queue and, where the Web Locks API exists, under a
 * lock shared by every tab of the origin — so two casts, in one tab or two,
 * never get the same seq, and a vote whose save failed after the send (or
 * whose send outcome is unknown) never has its seq reused. Rejects when the
 * allocation cannot be read or written; the caller must then not send.
 */
export async function allocateVoteSeq(groupId: string, pollId: string, voterPubkey: string, floor: number): Promise<number> {
  const key = `${SEQ_RESERVATIONS_PREFIX}${groupId}`;
  const me = voterPubkey.toLowerCase();
  let assigned = 0;
  const step = () =>
    enqueue(key, async () => {
      const stored = await get<unknown[]>(key);
      const entries = (Array.isArray(stored) ? stored : []).filter(isReservationShaped);
      const idx = entries.findIndex((e) => e.pollId === pollId && e.voterPubkey === me);
      const seq = Math.max((idx >= 0 ? entries[idx].seq : 0) + 1, floor);
      const entry = { pollId, voterPubkey: me, seq };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      await set(key, entries);
      assigned = seq;
    });
  const locks = webLocks();
  await (locks ? locks.request(key, step) : step());
  return assigned;
}

// ---- Pending (early) votes — AC-9 ----

/**
 * Persisted (IDB), not in-memory: an MLS application message is decrypted
 * once — after a reload it is not re-delivered to the dispatcher — so an
 * early vote held only in memory would be lost if the page reloads before
 * its poll-open arrives.
 */
export const PENDING_VOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound on queued early votes per group (oldest-received evicted). */
export const MAX_PENDING_VOTES_PER_GROUP = 200;
/**
 * Upper bound on distinct early polls one voter may hold in a group's queue.
 * New entries beyond it are dropped (not evicting others), so a single member
 * cannot flush other members' early votes out of the queue.
 */
export const MAX_PENDING_VOTES_PER_VOTER = 10;

function isPendingShaped(e: unknown): e is PendingPollVote {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.pollId === 'string' &&
    typeof o.voterPubkey === 'string' &&
    Array.isArray(o.responses) &&
    typeof o.receivedAt === 'number'
  );
}

async function loadLivePending(key: string, now: number): Promise<PendingPollVote[]> {
  const stored = await get<unknown[]>(key);
  return (Array.isArray(stored) ? stored : []).filter(
    (e): e is PendingPollVote => isPendingShaped(e) && now - e.receivedAt <= PENDING_VOTE_TTL_MS,
  );
}

async function storePending(key: string, entries: PendingPollVote[]): Promise<void> {
  if (entries.length > 0) {
    await set(key, entries);
  } else {
    await del(key);
  }
}

/**
 * Queue a vote whose poll is not (yet) known in its group. A voter's queued
 * votes for one poll are reduced with keptVotes — the newest by the shared
 * order is always kept (not the latest arrival, exactly as saveVoteIfNewer
 * decides), plus older ones that arrived earlier, so a close held between two
 * of them still counts the one the voter had at the close.
 *
 * Resolves true when the vote is held: stored, or already represented by a
 * kept entry (an equal or newer vote of the voter received no later — it can
 * never change a tally). Resolves false when the voter's per-voter poll cap
 * dropped it (bug: poll-followups — handleVote's save-failure fallback must
 * be able to tell).
 */
export async function queuePendingVote(
  vote: Omit<PendingPollVote, 'receivedAt'>,
  now?: number,
): Promise<boolean> {
  const at = now ?? (await receiptNow());
  const key = pendingKey(vote.groupId);
  let held = false;
  await enqueue(key, async () => {
    const entries = await loadLivePending(key, at);
    const entry: PendingPollVote = { ...vote, receivedAt: at };
    const mine = (e: PendingPollVote) => e.pollId === vote.pollId && e.voterPubkey === vote.voterPubkey;
    const own = entries.filter(mine);
    const otherPolls = new Set(entries.filter((e) => e.voterPubkey === vote.voterPubkey && !mine(e)).map((e) => e.pollId));
    if (own.length === 0 && otherPolls.size >= MAX_PENDING_VOTES_PER_VOTER) {
      await storePending(key, entries);
      return;
    }
    const kept = await keepForWrite([...own, entry], vote.groupId, vote.pollId);
    const next = [...entries.filter((e) => !mine(e)), ...kept];
    next.sort((a, b) => a.receivedAt - b.receivedAt);
    const stored = next.slice(-MAX_PENDING_VOTES_PER_GROUP);
    await storePending(key, stored);
    // Dominated: an equal-or-newer vote of the voter received no later is
    // kept, so this one could never change a tally.
    const dominated = !undominated([...own, entry]).includes(entry);
    held = stored.includes(entry) || (dominated && stored.some(mine));
  });
  return held;
}

/** Read (without removing) the live queued votes for one poll of one group. */
export async function loadPendingVotes(
  groupId: string,
  pollId: string,
  now: number = Date.now(),
): Promise<PendingPollVote[]> {
  const entries = await loadLivePending(pendingKey(groupId), now);
  return entries.filter((e) => e.pollId === pollId);
}

const samePending = (a: PendingPollVote, b: PendingPollVote) =>
  a.pollId === b.pollId && a.voterPubkey === b.voterPubkey && a.receivedAt === b.receivedAt;

/**
 * Remove exactly the given queue entries (matched by poll, voter and receipt
 * time), after they have been applied. A newer early vote queued in the
 * meantime by the same voter is a different entry and survives. Called only
 * AFTER the replayed votes are saved, so an interruption leaves the entries
 * queued (re-replay is idempotent: saveVoteIfNewer never stores a vote that
 * is not newer) rather than lost.
 */
export function removePendingVotes(
  groupId: string,
  applied: PendingPollVote[],
  now: number = Date.now(),
): Promise<void> {
  const key = pendingKey(groupId);
  return enqueue(key, async () => {
    const entries = await loadLivePending(key, now);
    await storePending(key, entries.filter((e) => !applied.some((a) => samePending(a, e))));
  });
}

// ---- Pending (early) closes and close announcements — AC-9 ----

/** Upper bound on distinct early polls one sender may hold in a group's close queue. */
export const MAX_PENDING_CLOSES_PER_SENDER = 10;
/** Upper bound on queued early closes per group (oldest-received evicted). */
export const MAX_PENDING_CLOSES_PER_GROUP = 50;

interface BoundedQueueSpec<T> {
  prefix: string;
  sender: (e: T) => string;
  isShaped: (e: unknown) => e is T;
}

/**
 * One entry per (poll, sender) — the first is kept — at most
 * MAX_PENDING_CLOSES_PER_SENDER polls per sender (extras dropped, so a single
 * member cannot flush others' entries), at most MAX_PENDING_CLOSES_PER_GROUP
 * per group (oldest-received evicted), expiring after PENDING_VOTE_TTL_MS.
 * Keyed by sender, not by poll alone: a member's forged early close must not
 * occupy the slot of the creator's genuine one.
 */
function boundedQueue<T extends { pollId: string; receivedAt: number }>(spec: BoundedQueueSpec<T>) {
  const keyOf = (groupId: string) => `${spec.prefix}${groupId}`;
  const loadLive = async (key: string, now: number): Promise<T[]> => {
    const stored = await get<unknown[]>(key);
    return (Array.isArray(stored) ? stored : []).filter(
      (e): e is T => spec.isShaped(e) && now - e.receivedAt <= PENDING_VOTE_TTL_MS,
    );
  };
  const store = async (key: string, entries: T[]): Promise<void> => {
    if (entries.length > 0) {
      await set(key, entries);
    } else {
      await del(key);
    }
  };
  return {
    queue(groupId: string, entry: T, now: number): Promise<void> {
      const key = keyOf(groupId);
      return enqueue(key, async () => {
        const entries = await loadLive(key, now);
        const who = spec.sender(entry);
        const own = entries.filter((e) => spec.sender(e) === who);
        if (own.some((e) => e.pollId === entry.pollId) || own.length >= MAX_PENDING_CLOSES_PER_SENDER) {
          await store(key, entries);
          return;
        }
        entries.push(entry);
        entries.sort((a, b) => a.receivedAt - b.receivedAt);
        await store(key, entries.slice(-MAX_PENDING_CLOSES_PER_GROUP));
      });
    },
    async load(groupId: string, pollId: string, now: number): Promise<T[]> {
      return (await loadLive(keyOf(groupId), now)).filter((e) => e.pollId === pollId);
    },
    loadAll(groupId: string, now: number): Promise<T[]> {
      return loadLive(keyOf(groupId), now);
    },
    remove(groupId: string, match: (e: T) => boolean, now: number): Promise<void> {
      const key = keyOf(groupId);
      return enqueue(key, async () => {
        const entries = await loadLive(key, now);
        await store(key, entries.filter((e) => !match(e)));
      });
    },
  };
}

function isPendingCloseShaped(e: unknown): e is PendingPollClose {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.pollId === 'string' &&
    typeof o.closerPubkey === 'string' &&
    typeof o.closedAt === 'number' &&
    typeof o.receivedAt === 'number'
  );
}

/** Receipt times of the live held closes of one poll in a raw close-queue value. */
function liveCloseCutoffs(raw: unknown, pollId: string, now: number): number[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((e): e is PendingPollClose => isPendingCloseShaped(e) && e.pollId === pollId && now - e.receivedAt <= PENDING_VOTE_TTL_MS)
    .map((e) => e.receivedAt);
}

const closeQueue = boundedQueue<PendingPollClose>({
  prefix: PENDING_CLOSES_PREFIX,
  sender: (e) => e.closerPubkey,
  isShaped: isPendingCloseShaped,
});

const announcementQueue = boundedQueue<PendingCloseAnnouncement>({
  prefix: PENDING_ANNOUNCEMENTS_PREFIX,
  sender: (e) => e.senderPubkey,
  isShaped: (e): e is PendingCloseAnnouncement => {
    if (!e || typeof e !== 'object') return false;
    const o = e as Record<string, unknown>;
    return (
      typeof o.pollId === 'string' &&
      typeof o.senderPubkey === 'string' &&
      typeof o.rumorId === 'string' &&
      typeof o.createdAt === 'number' &&
      typeof o.receivedAt === 'number'
    );
  },
});

/** Queue a close whose poll is not (yet) known in its group. */
export async function queuePendingClose(
  close: Omit<PendingPollClose, 'receivedAt'>,
  now?: number,
): Promise<void> {
  const at = now ?? (await receiptNow());
  return closeQueue.queue(close.groupId, { ...close, receivedAt: at }, at);
}

/** Read (without removing) the live queued closes for one poll of one group. */
export function loadPendingCloses(
  groupId: string,
  pollId: string,
  now: number = Date.now(),
): Promise<PendingPollClose[]> {
  return closeQueue.load(groupId, pollId, now);
}

/** Drop every queued close of one poll of one group (applied or discarded). */
export function removePendingCloses(groupId: string, pollId: string, now: number = Date.now()): Promise<void> {
  return closeQueue.remove(groupId, (e) => e.pollId === pollId, now);
}

/** Queue a poll_close chat announcement whose poll is not (yet) known. */
export async function queuePendingCloseAnnouncement(
  announcement: Omit<PendingCloseAnnouncement, 'receivedAt'>,
  now?: number,
): Promise<void> {
  const at = now ?? (await receiptNow());
  return announcementQueue.queue(announcement.groupId, { ...announcement, receivedAt: at }, at);
}

/** Read (without removing) the live queued announcements for one poll. */
export function loadPendingCloseAnnouncements(
  groupId: string,
  pollId: string,
  now: number = Date.now(),
): Promise<PendingCloseAnnouncement[]> {
  return announcementQueue.load(groupId, pollId, now);
}

/** Remove exactly the given announcements (matched by poll, sender and rumor id). */
export function removePendingCloseAnnouncements(
  groupId: string,
  applied: PendingCloseAnnouncement[],
  now: number = Date.now(),
): Promise<void> {
  return announcementQueue.remove(
    groupId,
    (e) => applied.some((a) => a.pollId === e.pollId && a.senderPubkey === e.senderPubkey && a.rumorId === e.rumorId),
    now,
  );
}

/**
 * Ids of the group's polls with anything held — early votes, closes or close
 * announcements (live entries only), each once, in first-seen order. For the
 * startup sweep (pollHandler createHeldPollStateSweeper). Rejects when any of
 * the three queues cannot be read.
 */
export async function listHeldPollIds(groupId: string, now: number = Date.now()): Promise<string[]> {
  const [votes, closes, announcements] = await Promise.all([
    loadLivePending(pendingKey(groupId), now),
    closeQueue.loadAll(groupId, now),
    announcementQueue.loadAll(groupId, now),
  ]);
  return [...new Set([...closes, ...announcements, ...votes].map((e) => e.pollId))];
}

/**
 * Clear all poll data for a group (polls, every vote list, every early-message
 * queue, seq reservations) in ONE readwrite transaction (bug: poll-followups
 * remediation 2): the poll list is deleted, the store's keys are enumerated
 * inside the transaction and every vote key of the group deleted, then the
 * queues and seq reservations. Because the purge and every requirePoll vote
 * write (saveVoteIfNewer) are readwrite transactions on the same store, they
 * serialise: a replay transaction created before the purge commits first and
 * its row is found by the scan and deleted; one created after finds no poll
 * list and writes nothing — no orphan vote row in either order (the
 * multi-step purge used to leave a window between deleting the vote keys and
 * the poll list). Rejects when the transaction fails (nothing deleted).
 */
export async function clearPollData(groupId: string): Promise<void> {
  // Leaving must not be blocked by a failed migration; legacy rows left
  // behind for this group's polls are dropped by a later run (poll unknown).
  await settleVotesMigration();
  const groupVotesPrefix = `${VOTES_PREFIX}${groupId}:`;
  await pollTxn<void>((txn) => {
    txn.delete(pollsKey(groupId));
    txn.allKeys((all) => {
      for (const k of all) {
        if (typeof k === 'string' && k.startsWith(groupVotesPrefix)) txn.delete(k);
      }
      txn.delete(pendingKey(groupId));
      txn.delete(`${PENDING_CLOSES_PREFIX}${groupId}`);
      txn.delete(`${PENDING_ANNOUNCEMENTS_PREFIX}${groupId}`);
      txn.delete(`${SEQ_RESERVATIONS_PREFIX}${groupId}`);
    });
  }, undefined);
}

/**
 * Clear every poll list and every vote list across all groups. Used by
 * resetAllData / backup-restore — scans the default idb-keyval store by key
 * prefix instead of iterating known groups, so orphaned poll/vote rows from
 * deleted groups are also removed.
 */
export async function clearAllPollData(): Promise<void> {
  // Let an in-flight migration finish first, so it cannot write keys back
  // after the reset deleted them.
  if (migration) await migration.catch(() => {});
  const allKeys = await keys();
  const targets = allKeys.filter(
    (k): k is string =>
      typeof k === 'string' &&
      (k.startsWith(POLLS_PREFIX) ||
        k.startsWith(VOTES_PREFIX) ||
        k.startsWith(PENDING_PREFIX) ||
        k.startsWith(PENDING_CLOSES_PREFIX) ||
        k.startsWith(PENDING_ANNOUNCEMENTS_PREFIX) ||
        k.startsWith(SEQ_RESERVATIONS_PREFIX)),
  );
  if (targets.length > 0) {
    await delMany(targets);
  }
  // The receipt clock's mark goes too; the next receipt writes a fresh lease.
  // lastReceipt is kept: receipts stay strictly increasing within this page.
  await del(RECEIPT_CLOCK_KEY);
  leasedUntil = 0;
  clockSeed = null;
  // A later restore may bring legacy rows back; let the next read migrate them.
  migration = null;
}
