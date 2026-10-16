/**
 * pendingRemovalStorage.ts — durable copy of the debounced member-removal
 * queue (bug: pending-member-removals-not-persisted).
 *
 * Why: a member's leave_intent rumor enqueues their removal in MarmotContext's
 * in-memory `pendingRemovalsRef`, which an auto-commit flushes after a 5 s
 * debounce. The rumor itself is journaled (rumorJournal.ts) and acked once its
 * handler ran, so an unload inside the debounce window lost the removal for
 * good: the MLS state never re-decrypts that rumor, and the departed member
 * stayed on the roster.
 *
 * Contract:
 *   - The leave handler awaits `persistPendingRemoval` BEFORE the dispatcher
 *     acks the journal entry, so from then on either the journal (replay) or
 *     this store carries the removal across an unload.
 *   - Every subscription (startup and re-subscribe) resumes the group's stored
 *     removals through the same enqueue path (`resumePendingRemovals`).
 *   - Idempotent: keyed `${groupId}:${pubkey}`; a re-put is a no-op in effect,
 *     a resumed entry whose member is already gone is dropped by
 *     fireAutoCommit's stale-leaf guard and then deleted here.
 *   - The in-memory queue stays the session's truth. A failed persist is
 *     warned and never undoes the in-memory removal; a failed delete after a
 *     commit only leaves a stale row that the next resume drops (idempotent).
 *
 * Fail-safe toward NOT evicting (remediation round 1): a stored row outlives
 * the session that saw the leave, and a pubkey alone cannot tell a departed
 * member from the same person re-joined later. So:
 *   - Each record carries `leafIdentity`, captured at first receipt: the
 *     member's current leaf node(s) as hex `signaturePublicKey:hpkePublicKey`
 *     (marmot-ts `getPubkeyLeafNodes` → ts-mls `LeafNodeData`). Never the leaf
 *     index — MLS reuses freed indexes. A re-join uses a fresh key package
 *     (new keys), so its identity differs; fireAutoCommit settles (forgets) an
 *     entry whose identity no longer matches instead of proposing a Remove.
 *     Residual: a re-join from the SAME reusable last-resort key package with
 *     no intervening commit by that member reproduces the identical leaf.
 *   - Without a captured identity a removal is kept in memory only.
 *   - Resume re-arms stored records as-is (never re-captured), only on a device
 *     that is an admin of the group (only admins can commit the removal);
 *     a non-admin device forgets them; unknown admin status keeps them untouched.
 *   - Rows at/over the rumor journal's retention age, and rows that are
 *     malformed or lack an identity, are deleted at resume.
 *
 * Scope & privacy: local, per-device; holds only (groupId, member pubkey,
 * time). Never part of the relay backup (collectBackupPayload reads only its
 * own stores), never published. Cleared per group on leave and with all
 * account-scoped data (clearAllGroupData). No other tab renders it, so no
 * cross-tab store-changed event is posted.
 */

import { createStore, set, delMany, entries, keys, clear } from 'idb-keyval';

export const PENDING_REMOVALS_DB_NAME = 'few-pending-removals';

// Created on first use: MarmotContext imports this module statically, and
// several unit suites mock idb-keyval without createStore.
let store: ReturnType<typeof createStore> | undefined;
const removalStore = (): ReturnType<typeof createStore> => (store ??= createStore(PENDING_REMOVALS_DB_NAME, 'removals'));

// Writes and identity-checked deletes run one at a time (per tab): a
// conditional delete reads the row, then deletes its key — a re-write of the
// same key (a re-joined member's new removal) must never land in between and
// be deleted with it.
let opChain: Promise<unknown> = Promise.resolve();
function serialised<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

export interface PendingRemovalRecord {
  groupId: string;
  pubkey: string;
  receivedAt: number;
  /**
   * Identity of the member's leaf node(s) when the leave intent arrived (see
   * leafIdentityOf). Required on every STORED row; absent only on an
   * in-memory entry whose capture failed (never persisted).
   */
  leafIdentity?: string;
}

/** Minimal ts-mls LeafNode shape (LeafNodeData) the identity is derived from. */
export interface LeafKeys {
  signaturePublicKey: Uint8Array;
  hpkePublicKey: Uint8Array;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable identity of a member's current leaf node(s): sorted hex
 * `signaturePublicKey:hpkePublicKey` pairs joined by `|`; undefined when the
 * member has no leaf. Never the leaf index (MLS reuses freed indexes).
 */
export function leafIdentityOf(leaves: readonly LeafKeys[]): string | undefined {
  if (leaves.length === 0) return undefined;
  return leaves
    .map((l) => `${toHex(l.signaturePublicKey)}:${toHex(l.hpkePublicKey)}`)
    .sort()
    .join('|');
}

function removalKey(groupId: string, pubkey: string): string {
  return `${groupId}:${pubkey}`;
}

/** A well-formed stored row for `key`: identity present, key matches value. */
function isStoredRecord(key: IDBValidKey, value: unknown): value is Required<PendingRemovalRecord> {
  const v = value as Partial<PendingRemovalRecord> | null | undefined;
  return (
    !!v &&
    typeof v.pubkey === 'string' &&
    v.pubkey.length > 0 &&
    typeof v.receivedAt === 'number' &&
    typeof v.leafIdentity === 'string' &&
    v.leafIdentity.length > 0 &&
    key === removalKey(String(v.groupId), v.pubkey)
  );
}

/** Store one pending removal. Idempotent per (groupId, pubkey). Rejects on IDB failure. */
export function putPendingRemoval(record: PendingRemovalRecord): Promise<void> {
  return serialised(() => set(removalKey(record.groupId, record.pubkey), { ...record }, removalStore()));
}

/** A settled removal: the member AND the leaf identity that was checked. */
export interface SettledRemoval {
  pubkey: string;
  leafIdentity?: string;
  /** When given, the stored row must also carry exactly this receivedAt. */
  receivedAt?: number;
}

/**
 * Unserialised core (callers hold the chain): re-read the group's rows and
 * delete only those that still match — a valid row whose pubkey AND leaf
 * identity (AND receivedAt, when given) equal a matcher, or a key listed in
 * `stillInvalidKeys` that is still malformed. The chain serialises this tab
 * only: the re-read and the delete are separate IDB transactions, so another
 * tab re-writing a row between them can still lose it
 * (backlog: pending-removal-compare-delete-single-txn).
 */
async function deleteRowsStillMatching(
  groupId: string,
  matchers: readonly SettledRemoval[],
  stillInvalidKeys?: readonly IDBValidKey[],
): Promise<void> {
  const { valid, invalidKeys } = await readPendingRemovalRows(groupId);
  const doomed = [
    ...valid
      .filter((r) =>
        matchers.some(
          (x) =>
            x.pubkey === r.pubkey &&
            x.leafIdentity === r.leafIdentity &&
            (x.receivedAt === undefined || x.receivedAt === r.receivedAt),
        ),
      )
      .map((r) => removalKey(groupId, r.pubkey)),
    ...invalidKeys.filter((k) => stillInvalidKeys?.includes(k)),
  ];
  if (doomed.length > 0) await delMany(doomed, removalStore());
}

/**
 * Delete the stored rows of settled removals — only a row whose pubkey AND
 * leaf identity both match (an identity-less settled entry never matches a
 * stored row). An older entry can thus never delete its replacement.
 * Serialised with writes. Rejects on IDB failure.
 */
export function deleteMatchingPendingRemovals(groupId: string, settled: readonly SettledRemoval[]): Promise<void> {
  if (settled.length === 0) return Promise.resolve();
  return serialised(() => deleteRowsStillMatching(groupId, settled));
}

/**
 * One group's stored rows: the well-formed ones (oldest first) and the keys of
 * malformed / identity-less ones (for deletion at resume).
 */
export async function readPendingRemovalRows(
  groupId: string,
): Promise<{ valid: PendingRemovalRecord[]; invalidKeys: IDBValidKey[] }> {
  const prefix = `${groupId}:`;
  const valid: PendingRemovalRecord[] = [];
  const invalidKeys: IDBValidKey[] = [];
  for (const [key, value] of await entries<IDBValidKey, unknown>(removalStore())) {
    if (!String(key).startsWith(prefix)) continue;
    if (!isStoredRecord(key, value)) invalidKeys.push(key);
    // A well-formed row of another group whose id merely extends this prefix.
    else if (value.groupId === groupId) valid.push({ ...value });
  }
  valid.sort((a, b) => a.receivedAt - b.receivedAt);
  return { valid, invalidKeys };
}

/** Well-formed stored pending removals for one group, oldest first. */
export async function listPendingRemovals(groupId: string): Promise<PendingRemovalRecord[]> {
  return (await readPendingRemovalRows(groupId)).valid;
}

/** Drop every pending removal of one group (leave purge). */
export async function clearPendingRemovalsForGroup(groupId: string): Promise<void> {
  const prefix = `${groupId}:`;
  const all = await keys(removalStore());
  await delMany(all.filter((k) => String(k).startsWith(prefix)), removalStore());
}

/** Drop the whole store (account-scoped data clear). */
export async function clearAllPendingRemovals(): Promise<void> {
  await clear(removalStore());
}

// ── Queue glue used by MarmotContext (pure; injected storage) ───────────────

/**
 * Persist a just-enqueued removal, best-effort: a failed write is warned and
 * swallowed so the in-memory removal (the session's truth) still commits.
 * Never rejects.
 */
export async function persistPendingRemoval(
  record: PendingRemovalRecord,
  put: (r: PendingRemovalRecord) => Promise<void> = putPendingRemoval,
): Promise<void> {
  try {
    await put(record);
  } catch (err) {
    console.warn('[Marmot] pending removal persist failed (kept in memory only):', err);
  }
}

/**
 * Forget removals that are settled (committed, or dropped as already gone),
 * best-effort: a failed delete leaves a stale row that the next resume drops
 * idempotently. Never rejects.
 */
export async function forgetPendingRemovals(
  groupId: string,
  settled: readonly SettledRemoval[],
  del: (groupId: string, settled: readonly SettledRemoval[]) => Promise<void> = deleteMatchingPendingRemovals,
): Promise<void> {
  try {
    await del(groupId, settled);
  } catch (err) {
    console.warn('[Marmot] pending removal cleanup failed (dropped on next resume):', err);
  }
}

/**
 * Whether this device's identity is an admin of the group, for the resume
 * gate: true/false when the admin list and our pubkey are known (compared
 * case-insensitively), undefined otherwise (unknown → resume keeps rows).
 */
export function selfAdminStatus(adminPubkeys: unknown, selfPubkeyHex: string | null | undefined): boolean | undefined {
  if (!Array.isArray(adminPubkeys) || !selfPubkeyHex) return undefined;
  const self = selfPubkeyHex.toLowerCase();
  return adminPubkeys.some((pk) => typeof pk === 'string' && pk.toLowerCase() === self);
}

/**
 * Re-arm a group's pending removals when its subscription starts. Fail-safe
 * toward NOT evicting:
 *   - Stored rows are re-armed AS-IS (their captured leaf identity is kept —
 *     never re-captured, or the identity guard would be defeated), and only
 *     when `isAdmin` is true; an in-memory entry for the same member wins.
 *   - Rows at/over `maxAgeMs` (the rumor journal's retention) are dropped.
 *   - `isAdmin === false`: every stored row is forgotten (a non-admin cannot
 *     commit a removal); `undefined` (unknown): valid rows are left untouched.
 *   - Malformed / identity-less rows are always deleted.
 * In-memory entries are re-armed in every case (a re-subscribe cancels the
 * debounce timer but keeps the queue). Deletes are best-effort; a failed read
 * deletes nothing. Never rejects. Returns the stored records re-armed.
 */
export async function resumePendingRemovals(args: {
  groupId: string;
  isAdmin: boolean | undefined;
  now: number;
  maxAgeMs: number;
  queue: Map<string, PendingRemovalRecord[]>;
  arm: (groupId: string) => void;
}): Promise<PendingRemovalRecord[]> {
  const { groupId, isAdmin, now, maxAgeMs, queue, arm } = args;
  const resumed: PendingRemovalRecord[] = [];
  // Read → classify → delete runs on the same serialised chain as puts and
  // the identity-checked delete (remediation round 3): a leave persisted in
  // between (e.g. a journal replay racing this resume) is queued behind it,
  // and the delete only removes rows still exactly as read.
  await serialised(async () => {
    let rows: Awaited<ReturnType<typeof readPendingRemovalRows>>;
    try {
      rows = await readPendingRemovalRows(groupId);
    } catch (err) {
      console.warn('[Marmot] pending removal resume read failed:', err);
      return;
    }
    const expired: PendingRemovalRecord[] = [];
    for (const record of rows.valid) {
      if (isAdmin === false || now - record.receivedAt >= maxAgeMs) {
        expired.push(record);
      } else if (isAdmin === true && !queue.get(groupId)?.some((e) => e.pubkey === record.pubkey)) {
        // An in-memory entry is newer than any stored row: never replaced here.
        addToRemovalQueue(queue, record);
        resumed.push(record);
      }
    }
    if (expired.length === 0 && rows.invalidKeys.length === 0) return;
    await deleteRowsStillMatching(groupId, expired, rows.invalidKeys).catch((err: unknown) => {
      console.warn('[Marmot] pending removal resume cleanup failed:', err);
    });
  });
  if ((queue.get(groupId)?.length ?? 0) > 0) arm(groupId);
  return resumed;
}

/**
 * Add a removal to the in-memory queue, one entry per member and group:
 *   - same pubkey + same leaf identity → duplicate, nothing changes (false);
 *   - same pubkey + a different identity (or the queued entry has none) → the
 *     queued entry is REPLACED in place (true), so the caller overwrites the
 *     stored row: a re-joined member's new leave supersedes the stale one.
 * Returns true when the queue changed.
 */
export function addToRemovalQueue(
  queue: Map<string, PendingRemovalRecord[]>,
  record: PendingRemovalRecord,
): boolean {
  const existing = queue.get(record.groupId) ?? [];
  const idx = existing.findIndex((e) => e.pubkey === record.pubkey);
  if (idx === -1) existing.push(record);
  else if (existing[idx].leafIdentity === record.leafIdentity) return false;
  else existing[idx] = record;
  queue.set(record.groupId, existing);
  return true;
}

/**
 * The enqueue half of MarmotContext's `enqueueLeave` (the debounce timer is
 * armed by the caller): add to the in-memory queue, then mirror the entry
 * durably — only when it is new and its leaf identity was captured (an
 * unverifiable removal is never persisted). Resolves once the durable write
 * settled; never rejects.
 */
export function recordPendingRemoval(
  queue: Map<string, PendingRemovalRecord[]>,
  groupId: string,
  pubkey: string,
  now: number,
  leafIdentity: string | undefined,
  put?: (r: PendingRemovalRecord) => Promise<void>,
): Promise<void> {
  const record: PendingRemovalRecord = { groupId, pubkey, receivedAt: now, ...(leafIdentity ? { leafIdentity } : {}) };
  if (!addToRemovalQueue(queue, record)) return Promise.resolve();
  if (!leafIdentity) {
    console.warn('[Marmot] pending removal has no leaf identity; kept in memory only');
    return Promise.resolve();
  }
  return persistPendingRemoval(record, put);
}

/**
 * fireAutoCommit's `onCommitted` body: drop the settled records (committed, or
 * already gone / identity mismatch) from the in-memory queue synchronously,
 * then forget their durable copies, best-effort. Identity-scoped: an entry or
 * row is dropped only when pubkey AND leaf identity match the record that was
 * checked, so a replacement enqueued during the commit window (same pubkey,
 * new identity) survives. Never rejects.
 */
export function settlePendingRemovals(
  queue: Map<string, PendingRemovalRecord[]>,
  groupId: string,
  settled: readonly SettledRemoval[],
  del?: (groupId: string, settled: readonly SettledRemoval[]) => Promise<void>,
): Promise<void> {
  const filtered = (queue.get(groupId) ?? []).filter(
    (e) => !settled.some((x) => x.pubkey === e.pubkey && x.leafIdentity === e.leafIdentity),
  );
  if (filtered.length === 0) queue.delete(groupId);
  else queue.set(groupId, filtered);
  return forgetPendingRemovals(groupId, settled, del);
}
