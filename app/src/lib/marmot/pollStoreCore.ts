/**
 * pollStoreCore.ts — the pure core of the poll stores.
 *
 * Everything here is a pure function of its arguments (no IDB, no clock, no
 * queue): the vote total order and "as of a close" selection, the early-vote /
 * early-close queue rules and the row-merge rules. pollPersistence applies them
 * inside its readwrite transactions; the recompute fold (pollFold.ts) applies
 * the SAME functions to in-memory state, so a recomputed poll and a dispatched
 * poll cannot diverge by store rules.
 */

import type { Poll, PollVote, PendingPollVote, PendingPollClose, VoteSnapshot, VoteOrderKey } from './pollPersistence';

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

export function isPendingShaped(e: unknown): e is PendingPollVote {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.pollId === 'string' &&
    typeof o.voterPubkey === 'string' &&
    Array.isArray(o.responses) &&
    typeof o.receivedAt === 'number'
  );
}

/** The live (well-formed, unexpired) entries of a raw queue value. */
export function liveEntries<T extends { receivedAt: number }>(raw: unknown, isShaped: (e: unknown) => e is T, now: number): T[] {
  return (Array.isArray(raw) ? raw : []).filter((e): e is T => isShaped(e) && now - e.receivedAt <= PENDING_VOTE_TTL_MS);
}

/** Upper bound on distinct early polls one sender may hold in a group's close queue. */
export const MAX_PENDING_CLOSES_PER_SENDER = 10;
/** Upper bound on queued early closes per group (oldest-received evicted). */
export const MAX_PENDING_CLOSES_PER_GROUP = 50;

export function isPendingCloseShaped(e: unknown): e is PendingPollClose {
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
export function liveCloseCutoffs(raw: unknown, pollId: string, now: number): number[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((e): e is PendingPollClose => isPendingCloseShaped(e) && e.pollId === pollId && now - e.receivedAt <= PENDING_VOTE_TTL_MS)
    .map((e) => e.receivedAt);
}

// ---- Pure store rules (shared by the IDB transactions and the recompute fold) ----

/**
 * Merge one (already receipt-stamped) vote into the stored rows of a poll: a new
 * voter is appended; an existing voter's row keeps the newest vote by
 * isNewerVote plus the older snapshots that can still decide an "as of a close"
 * tally (keptVotes). `cutoffs` are the receipt times of the poll's held closes,
 * needed only when the per-voter cap bites: pass null first, and when 'need-cutoffs'
 * comes back read them and call again (a failed read: pass []).
 * Returns the next row list, or 'unchanged' when the vote changes nothing.
 */
export function mergeVoteRows(
  existing: readonly PollVote[],
  stamped: PollVote,
  cutoffs: readonly number[] | null,
): PollVote[] | 'unchanged' | 'need-cutoffs' {
  const rows = existing.slice();
  const idx = rows.findIndex((v) => v.id === stamped.id);
  if (idx < 0) return [...rows, stamped];
  const { superseded: _old, ...current } = rows[idx];
  // The stored set as is (it may exceed the cap by held-close votes).
  const before = undominated<VoteSnapshot>([current, ...(rows[idx].superseded ?? [])]);
  const candidates = undominated<VoteSnapshot>([...before, stamped]);
  const capped = candidates.length > MAX_VOTES_KEPT_PER_VOTER;
  if (capped && cutoffs === null) return 'need-cutoffs';
  const after = capKept(candidates, capped ? (cutoffs ?? []) : []);
  if (canonical(after) === canonical(before)) return 'unchanged';
  const newest = after[after.length - 1];
  const { superseded: _s, ...base } = stamped;
  const older = after.slice(0, -1).map(snapshotOf);
  rows[idx] = {
    ...base,
    responses: newest.responses,
    votedAt: newest.votedAt,
    seq: newest.seq,
    rumorId: newest.rumorId,
    receivedAt: newest.receivedAt,
    ...(older.length > 0 ? { superseded: older } : {}),
  };
  return rows;
}

/**
 * Queue a vote whose poll is unknown: `entries` are the LIVE entries of the
 * group's queue. A voter's votes for one poll are reduced with keptVotes; a
 * voter holds at most MAX_PENDING_VOTES_PER_VOTER distinct polls; the group's
 * queue keeps the MAX_PENDING_VOTES_PER_GROUP latest received. `held` is true
 * when the vote is stored or already represented by a kept entry. Same
 * 'need-cutoffs' protocol as mergeVoteRows.
 */
export function queueVoteEntries(
  entries: readonly PendingPollVote[],
  vote: Omit<PendingPollVote, 'receivedAt'>,
  at: number,
  cutoffs: readonly number[] | null,
): { stored: PendingPollVote[]; held: boolean } | 'need-cutoffs' {
  const entry: PendingPollVote = { ...vote, receivedAt: at };
  const mine = (e: PendingPollVote) => e.pollId === vote.pollId && e.voterPubkey === vote.voterPubkey;
  const own = entries.filter(mine);
  const otherPolls = new Set(entries.filter((e) => e.voterPubkey === vote.voterPubkey && !mine(e)).map((e) => e.pollId));
  if (own.length === 0 && otherPolls.size >= MAX_PENDING_VOTES_PER_VOTER) return { stored: entries.slice(), held: false };
  const sorted = undominated([...own, entry]);
  let kept = sorted;
  if (sorted.length > MAX_VOTES_KEPT_PER_VOTER) {
    // The cap bites: keep the vote each held close of the poll would count.
    if (cutoffs === null) return 'need-cutoffs';
    kept = capKept(sorted, cutoffs);
  }
  const next = [...entries.filter((e) => !mine(e)), ...kept];
  next.sort((a, b) => a.receivedAt - b.receivedAt);
  const stored = next.slice(-MAX_PENDING_VOTES_PER_GROUP);
  // Dominated: an equal-or-newer vote of the voter received no later is kept, so this one could never change a tally.
  const dominated = !sorted.includes(entry);
  return { stored, held: stored.includes(entry) || (dominated && stored.some(mine)) };
}

/**
 * One entry per (poll, sender) — the first is kept — at most
 * MAX_PENDING_CLOSES_PER_SENDER polls per sender (extras dropped), at most
 * MAX_PENDING_CLOSES_PER_GROUP per group (oldest-received evicted).
 */
export function addBoundedEntry<T extends { pollId: string; receivedAt: number }>(
  entries: readonly T[],
  entry: T,
  sender: (e: T) => string,
): T[] {
  const who = sender(entry);
  const own = entries.filter((e) => sender(e) === who);
  if (own.some((e) => e.pollId === entry.pollId) || own.length >= MAX_PENDING_CLOSES_PER_SENDER) return entries.slice();
  const next = [...entries, entry];
  next.sort((a, b) => a.receivedAt - b.receivedAt);
  return next.slice(-MAX_PENDING_CLOSES_PER_GROUP);
}

/** The open upsert: replaces the poll of the same id in place, else appends. */
export function upsertOpenPoll(list: readonly Poll[], poll: Poll): Poll[] {
  const next = list.slice();
  const idx = next.findIndex((p) => p.id === poll.id);
  if (idx >= 0) next[idx] = poll;
  else next.push(poll);
  return next;
}

/**
 * The closed write: monotonic and idempotent. An already-closed poll is never
 * overwritten (first close wins) and a poll that is not stored is not created.
 * `stored` is the poll as stored afterwards, null when there is none.
 */
export function writeClosedPoll(list: readonly Poll[], poll: Poll): { list: Poll[]; stored: Poll | null; wrote: boolean } {
  const next = list.slice();
  const idx = next.findIndex((p) => p.id === poll.id);
  if (idx < 0) return { list: next, stored: null, wrote: false };
  if (next[idx].closed) return { list: next, stored: next[idx], wrote: false };
  next[idx] = poll;
  return { list: next, stored: poll, wrote: true };
}

/** A closed poll's votes without their superseded snapshots (dead weight once closed). */
export const dropSuperseded = (rows: readonly PollVote[]): PollVote[] =>
  rows.map(({ superseded: _dropped, ...row }) => row);

/** Two queued votes are the same entry when poll, voter and receipt time match. */
export const samePendingVote = (a: PendingPollVote, b: PendingPollVote): boolean =>
  a.pollId === b.pollId && a.voterPubkey === b.voterPubkey && a.receivedAt === b.receivedAt;
