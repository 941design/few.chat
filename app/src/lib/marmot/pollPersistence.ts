/**
 * Poll persistence layer — idb-keyval implementation.
 *
 * Polls are stored per-group under the key `few:polls:{groupId}`.
 * Votes are stored per (group, poll) under `few:poll-votes:{groupId}:{pollId}`.
 * Early votes (poll not yet received) are queued per group under
 * `few:poll-pending-votes:{groupId}`.
 */

import { get, set, del, keys, delMany } from 'idb-keyval';

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
  votedAt: number;
}

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
  /** Local receipt time (ms) — drives TTL expiry and oldest-first eviction. */
  receivedAt: number;
}

// ---- Storage keys ----

const POLLS_PREFIX = 'few:polls:';
const VOTES_PREFIX = 'few:poll-votes:';
const PENDING_PREFIX = 'few:poll-pending-votes:';

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

/** Save or update a poll (upsert by id). */
export function savePoll(poll: Poll): Promise<void> {
  const key = pollsKey(poll.groupId);
  return enqueue(key, async () => {
    const existing = (await get<Poll[]>(key)) ?? [];
    const idx = existing.findIndex((p) => p.id === poll.id);
    if (idx >= 0) {
      existing[idx] = poll;
    } else {
      existing.push(poll);
    }
    await set(key, existing);
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
  // the key inside the per-key write queue (the same one saveVote uses), so a
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

/** Save or replace a vote (keyed by pollId:voterPubkey within its group — latest wins). */
export async function saveVote(vote: PollVote): Promise<void> {
  // A write lands under the group-scoped key regardless of legacy rows, and
  // the legacy merge lets an existing group-scoped row win — safe to proceed.
  await settleVotesMigration();
  const key = votesKey(vote.groupId, vote.pollId);
  return enqueue(key, async () => {
    const existing = (await get<PollVote[]>(key)) ?? [];
    const idx = existing.findIndex((v) => v.id === vote.id);
    if (idx >= 0) {
      existing[idx] = vote;
    } else {
      existing.push(vote);
    }
    await set(key, existing);
  });
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

/** Queue a vote whose poll is not (yet) known in its group. */
export function queuePendingVote(
  vote: Omit<PendingPollVote, 'receivedAt'>,
  now: number = Date.now(),
): Promise<void> {
  const key = pendingKey(vote.groupId);
  return enqueue(key, async () => {
    const entries = await loadLivePending(key, now);
    const entry: PendingPollVote = { ...vote, receivedAt: now };
    const idx = entries.findIndex((e) => e.pollId === vote.pollId && e.voterPubkey === vote.voterPubkey);
    if (idx >= 0) {
      // Same voter, same poll: latest arrival replaces (matches live votes).
      entries.splice(idx, 1);
    } else if (entries.filter((e) => e.voterPubkey === vote.voterPubkey).length >= MAX_PENDING_VOTES_PER_VOTER) {
      await storePending(key, entries);
      return;
    }
    entries.push(entry);
    entries.sort((a, b) => a.receivedAt - b.receivedAt);
    await storePending(key, entries.slice(-MAX_PENDING_VOTES_PER_GROUP));
  });
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
 * queued (re-replay is idempotent: saveVote upserts by vote id) rather than
 * lost.
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

/** Clear all poll data for a group (polls, every vote list and queued early votes). */
export async function clearPollData(groupId: string): Promise<void> {
  // Leaving must not be blocked by a failed migration; legacy rows left
  // behind for this group's polls are dropped by a later run (poll unknown).
  await settleVotesMigration();
  const groupVotesPrefix = `${VOTES_PREFIX}${groupId}:`;
  const voteKeys = (await keys()).filter(
    (k): k is string => typeof k === 'string' && k.startsWith(groupVotesPrefix),
  );
  if (voteKeys.length > 0) {
    await delMany(voteKeys);
  }
  await del(pendingKey(groupId));
  await del(pollsKey(groupId));
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
      (k.startsWith(POLLS_PREFIX) || k.startsWith(VOTES_PREFIX) || k.startsWith(PENDING_PREFIX)),
  );
  if (targets.length > 0) {
    await delMany(targets);
  }
  // A later restore may bring legacy rows back; let the next read migrate them.
  migration = null;
}
