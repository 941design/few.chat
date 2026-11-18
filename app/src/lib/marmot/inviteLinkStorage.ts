/**
 * IndexedDB-backed invite link storage using idb-keyval.
 *
 * Each invite link is keyed by its nonce in the 'few-invite-links' database.
 */

import { createStore, get, set, del, entries, clear } from 'idb-keyval';

/** One day in milliseconds — the fixed (non-configurable) invite-link lifetime. */
export const DAY_MS = 86_400_000;

export interface InviteLink {
  /** Hex nonce — primary key */
  nonce: string;
  /** Group this link belongs to */
  groupId: string;
  /** Account that created the link; absent on records predating account scoping. */
  ownerPubkey?: string;
  /** When the link was created (Unix ms) */
  createdAt: number;
  /**
   * When the link stops admitting new join requests (Unix ms). Typed
   * required — every write this app performs from now on sets it at
   * creation (createdAt + DAY_MS) or via `migrateInviteLinks`. A record
   * already on disk from before this field existed will NOT actually carry
   * it at runtime despite the type; every read site MUST go through
   * `isExpired`'s `?? (createdAt + DAY_MS)` fallback rather than trusting
   * the type-level guarantee.
   */
  expiresAt: number;
  /**
   * Count of approved join requests that referenced this link's nonce. An
   * approval-event tally, not a live-membership figure — incremented only
   * on successful approval, never derived from group state.
   */
  usageCount: number;
  /** Whether the sweep has already stamped this link's expiry notification. */
  expiryNotified: boolean;
  /** Whether the admin has opened/acknowledged this link's expiry notification. */
  expiryAcknowledged: boolean;
  /** Human-readable label (optional, for admin's own tracking) */
  label?: string;
  /** Whether requests referencing this nonce are silently ignored */
  muted: boolean;
}

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const inviteLinkStore = createStore('few-invite-links', 'links');

export function createInviteLinkStore() {
  return inviteLinkStore;
}

// ---------------------------------------------------------------------------
// Expiry predicate
// ---------------------------------------------------------------------------

/**
 * The single expiry predicate every read site (join-request gate, manage
 * overlay, expiry sweep) must use instead of recomputing expiry inline.
 *
 * The `expiresAt ?? createdAt + DAY_MS` fallback is load-bearing: the
 * join-request gate resolves a link via a single `getInviteLink(nonce)` call
 * that never passes through `migrateInviteLinks`, so a legacy record with no
 * `expiresAt` must still evaluate correctly on its very first read.
 */
export function isExpired(link: Pick<InviteLink, 'expiresAt' | 'createdAt'>, now: number): boolean {
  const effectiveExpiry = link.expiresAt ?? link.createdAt + DAY_MS;
  return now >= effectiveExpiry;
}

/**
 * Builds a freshly-created link record with the fixed one-day expiry window
 * and default usage/notification fields (AC-MODEL-2). The sole construction
 * site for a new `InviteLink` — `GenerateInviteLinkModal` calls this instead
 * of inlining `createdAt + DAY_MS` itself, so the creation-time contract has
 * exactly one implementation to keep correct and unit-test.
 */
export function buildNewInviteLink(params: {
  nonce: string;
  groupId: string;
  createdAt: number;
  label?: string;
  ownerPubkey?: string;
}): InviteLink {
  return {
    nonce: params.nonce,
    groupId: params.groupId,
    ...(params.ownerPubkey ? { ownerPubkey: params.ownerPubkey } : {}),
    createdAt: params.createdAt,
    expiresAt: params.createdAt + DAY_MS,
    usageCount: 0,
    expiryNotified: false,
    expiryAcknowledged: false,
    label: params.label,
    muted: false,
  };
}

// ---------------------------------------------------------------------------
// Per-nonce serialization
// ---------------------------------------------------------------------------

/**
 * idb-keyval's get/set on a single key has an await gap between read and
 * write. Two concurrent mutators targeting the same nonce (e.g. two rapid
 * `approveJoinRequest` calls referencing the same invite link) would
 * otherwise both read the same stale record and one write would clobber the
 * other, losing an increment. Chaining each mutation onto a per-nonce
 * promise serializes the read-modify-write within this module/tab without
 * needing a cross-tab lock (out of scope — invite-link state is confined to
 * a single device by construction; see architecture.md).
 */
const nonceLocks = new Map<string, Promise<void>>();

/**
 * Gate-remediation fix (P2, epic invite-link-lifecycle): `clearAllInviteLinks`
 * bypassed every per-nonce lock above, calling the raw idb-keyval `clear()`
 * directly. If a per-nonce RMW (e.g. `markInviteLinkExpiryNotified` from the
 * expiry sweep) was between its `get` and `set` when a clear ran, the clear
 * would land first and the RMW's `set` would land AFTER it — resurrecting a
 * stale record onto what was supposed to become a fresh/empty store (e.g. on
 * account reset/wipe).
 *
 * `clearInFlight` is the barrier: non-null exactly while a clear is
 * in-progress (draining prior locks, then physically clearing). Every RMW
 * funnels through `withNonceLock`, so gating happens in exactly one place.
 *
 * Why there is no ordering hole: JS is single-threaded and neither
 * `withNonceLock`'s prelude (capturing `barrier`/`prior`, computing `run`,
 * registering it in `nonceLocks`) nor `clearAllInviteLinks`'s prelude
 * (snapshotting `drain`, assigning `clearInFlight`) contains an `await` —
 * each runs to completion as one atomic synchronous block with no
 * interleaving possible. That leaves exactly two cases for any given
 * `withNonceLock` call relative to a `clearAllInviteLinks` call:
 *
 *  1. It starts (registers into `nonceLocks`) BEFORE `clearAllInviteLinks`
 *     takes its `drain` snapshot: the drain snapshot captures this call's
 *     settled-wrapper promise, so the clear's `drain` wait — and therefore
 *     the actual `clear()` — cannot proceed until this call's `fn` (its full
 *     get+set) has completed. Its `set` is therefore always ordered BEFORE
 *     the clear.
 *  2. It starts AFTER `clearAllInviteLinks` has assigned `clearInFlight`:
 *     `barrier = clearInFlight` captures the non-null barrier synchronously
 *     at call time, so `gated` (and therefore `fn`, and therefore this
 *     call's own `get`) cannot run until the barrier — drain-then-clear —
 *     has fully resolved. Its `get` therefore always observes the
 *     post-clear (empty) state, and any existing-record branch naturally
 *     no-ops via the same "nonce does not resolve" guard every mutator
 *     already has.
 *
 * There is no third case (e.g. "registered before the drain snapshot but
 * whose `set` lands after the clear") because case 1 above guarantees the
 * clear cannot even begin running until every lock present at drain time —
 * including this one — has fully settled.
 */
let clearInFlight: Promise<void> | null = null;

function withNonceLock<T>(nonce: string, fn: () => Promise<T>): Promise<T> {
  const barrier = clearInFlight;
  const prior = nonceLocks.get(nonce) ?? Promise.resolve();
  const gated = barrier ? Promise.all([prior, barrier]).then(() => undefined) : prior;
  const run = gated.then(fn, fn);
  nonceLocks.set(
    nonce,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function saveInviteLink(link: InviteLink): Promise<void> {
  await set(link.nonce, link, inviteLinkStore);
}

export async function getInviteLink(nonce: string): Promise<InviteLink | undefined> {
  return get<InviteLink>(nonce, inviteLinkStore);
}

export async function loadInviteLinks(groupId: string): Promise<InviteLink[]> {
  const all = await entries<string, InviteLink>(inviteLinkStore);
  return all
    .map(([, link]) => link)
    .filter((link) => link.groupId === groupId);
}

export async function loadAllInviteLinks(): Promise<InviteLink[]> {
  const all = await entries<string, InviteLink>(inviteLinkStore);
  return all.map(([, link]) => link);
}

export async function updateInviteLinkMuted(nonce: string, muted: boolean): Promise<void> {
  await withNonceLock(nonce, async () => {
    const link = await get<InviteLink>(nonce, inviteLinkStore);
    if (!link) return;
    await set(nonce, { ...link, muted }, inviteLinkStore);
  });
}

/**
 * Gate-remediation fix (Finding 2, epic invite-link-lifecycle): routed
 * through the same per-nonce lock every other mutator (increment, the
 * mark-* helpers, migration) already uses. A prior revision called `del()`
 * raw, bypassing the lock entirely — if an in-flight
 * `incrementInviteLinkUsage` had already read the record before this delete
 * landed, its subsequent `set()` would write the stale (pre-delete)
 * snapshot back, resurrecting a link the admin had just removed. Under the
 * lock, whichever of delete/increment registers first for a nonce completes
 * fully before the other starts, so a losing increment's `get()` always
 * observes the delete and no-ops (it already no-ops on a missing nonce).
 */
export async function deleteInviteLink(nonce: string): Promise<void> {
  await withNonceLock(nonce, async () => {
    await del(nonce, inviteLinkStore);
  });
}

/**
 * Delete every invite link belonging to `groupId`. Mirrors
 * clearPendingJoinRequestsForGroup. Each per-nonce delete is routed through
 * `withNonceLock` for the same reason as `deleteInviteLink` above (Finding
 * 2) — a raw `del()` here could race a concurrent `incrementInviteLinkUsage`
 * for one of this group's links and let a stale write resurrect it after a
 * group leave/abandon clears the group's links.
 */
export async function clearInviteLinksForGroup(groupId: string): Promise<void> {
  const all = await entries<string, InviteLink>(inviteLinkStore);
  await Promise.all(
    all
      .filter(([, link]) => link.groupId === groupId)
      .map(([nonce]) =>
        withNonceLock(nonce, async () => {
          await del(nonce, inviteLinkStore);
        })
      )
  );
}

/**
 * Gate-remediation fix (P2, epic invite-link-lifecycle): see the
 * `clearInFlight` doc comment above `withNonceLock` for the full barrier
 * design and the ordering-hole walkthrough. Summary of this half:
 *
 *  1. `drain` synchronously snapshots every currently in-flight per-nonce
 *     lock promise (each already registered in `nonceLocks` by the time this
 *     line runs, per the atomicity argument above).
 *  2. `clearInFlight` is assigned synchronously, in the same tick as the
 *     `drain` snapshot — no `await` separates them, so no RMW can start
 *     "in the gap" between snapshotting and publishing the barrier.
 *  3. Only after every locked-at-snapshot-time RMW has settled does the
 *     actual `clear(inviteLinkStore)` run, and only after THAT does this
 *     function's own await resolve.
 *
 * `run` (not a fresh read of `clearInFlight`) is compared in the `finally`
 * so that overlapping `clearAllInviteLinks()` calls can't have an earlier
 * call's cleanup clobber a later call's still-active barrier.
 */
/**
 * Gate-remediation fix (P2, epic invite-link-lifecycle): see the
 * `clearInFlight` doc comment above `withNonceLock` for the full barrier
 * design and the ordering-hole walkthrough. Summary of this half:
 *
 *  1. `drain` synchronously snapshots every currently in-flight per-nonce
 *     lock promise (each already registered in `nonceLocks` by the time this
 *     line runs, per the atomicity argument above).
 *  2. `clearInFlight` is assigned synchronously, in the same tick as the
 *     `drain` snapshot — no `await` separates them, so no RMW can start
 *     "in the gap" between snapshotting and publishing the barrier.
 *  3. Only after every locked-at-snapshot-time RMW has settled does the
 *     actual `clear(inviteLinkStore)` run, and only after THAT does this
 *     function's own await resolve.
 *
 * `run` (not a fresh read of `clearInFlight`) is compared in the `finally`
 * so that overlapping `clearAllInviteLinks()` calls can't have an earlier
 * call's cleanup clobber a later call's still-active barrier.
 */
export async function clearAllInviteLinks(): Promise<void> {
  const drain = Promise.all([...nonceLocks.values()]);
  const run = drain.then(() => clear(inviteLinkStore));
  clearInFlight = run;
  try {
    await run;
  } finally {
    if (clearInFlight === run) {
      clearInFlight = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Usage + notification-flag mutators
// ---------------------------------------------------------------------------

/**
 * Increases the resolved record's `usageCount` by exactly 1 and persists it.
 * Silent no-op (never throws, never creates a record) when `nonce` does not
 * resolve to a stored record — the approve-join-request path must never be
 * blocked or crashed by a link that was deleted or already expired.
 */
export async function incrementInviteLinkUsage(nonce: string): Promise<void> {
  await withNonceLock(nonce, async () => {
    const link = await get<InviteLink>(nonce, inviteLinkStore);
    if (!link) return;
    await set(nonce, { ...link, usageCount: (link.usageCount ?? 0) + 1 }, inviteLinkStore);
  });
}

/**
 * Sets `expiryNotified` to true and persists it, leaving `expiryAcknowledged`,
 * `usageCount`, and `expiresAt` unchanged. Silent no-op when `nonce` does not
 * resolve.
 */
/**
 * Stamps `expiryNotified: true`. Returns `true` when a record was actually
 * persisted, `false` when the nonce no longer resolves (the link was deleted
 * or cleared between the caller's read and this write). The sweep uses the
 * return to avoid bumping the unread badge for a link that no longer exists.
 */
export async function markInviteLinkExpiryNotified(nonce: string, allowed: (link: InviteLink) => boolean = () => true): Promise<boolean> {
  return withNonceLock(nonce, async () => {
    const link = await get<InviteLink>(nonce, inviteLinkStore);
    if (!link || !allowed(link)) return false;
    await set(nonce, { ...link, expiryNotified: true }, inviteLinkStore);
    return true;
  });
}

/**
 * Sets `expiryAcknowledged` to true and persists it, leaving `expiryNotified`,
 * `usageCount`, and `expiresAt` unchanged. Silent no-op when `nonce` does not
 * resolve.
 */
export async function markInviteLinkExpiryAcknowledged(nonce: string, allowed: (link: InviteLink) => boolean = () => true): Promise<void> {
  await withNonceLock(nonce, async () => {
    const link = await get<InviteLink>(nonce, inviteLinkStore);
    if (!link || !allowed(link)) return;
    await set(nonce, { ...link, expiryAcknowledged: true }, inviteLinkStore);
  });
}

// ---------------------------------------------------------------------------
// One-shot migration
// ---------------------------------------------------------------------------

type LegacyInviteLink = Omit<InviteLink, 'expiresAt' | 'usageCount' | 'expiryNotified' | 'expiryAcknowledged'> &
  Partial<Pick<InviteLink, 'expiresAt' | 'usageCount' | 'expiryNotified' | 'expiryAcknowledged'>>;

/**
 * Computes the migrated field set for a single record, or `null` when the
 * record needs no write at all.
 *
 * A non-muted record that already carries all four new fields is a total
 * no-op (the fast path below) — this is what keeps `migrateInviteLinks` safe
 * to call again at every app startup without ever re-stamping
 * `expiryNotified` on a link the sweep is now responsible for (Design
 * Decision 3: the migration's notification suppression applies only to
 * genuinely legacy records, never to a link that already had its own
 * `expiresAt`).
 *
 * A muted record is always recomputed (never fast-pathed), but the clamp
 * `expiresAt = min(effectiveExpiry, now)` is a mathematical fixed point
 * under a non-decreasing `now` — once clamped, reprocessing an
 * already-fully-migrated muted record on a later call yields the identical
 * value, so the final equality check below still produces zero writes.
 */
function migrateRecord(link: LegacyInviteLink, now: number): InviteLink | null {
  const isLegacyExpiresAt = link.expiresAt === undefined;
  const fullyMigrated =
    link.expiresAt !== undefined &&
    link.usageCount !== undefined &&
    link.expiryNotified !== undefined &&
    link.expiryAcknowledged !== undefined;

  if (fullyMigrated && !link.muted) {
    return null;
  }

  const backfilledExpiresAt = link.expiresAt ?? link.createdAt + DAY_MS;
  const usageCount = link.usageCount ?? 0;
  let expiryNotified = link.expiryNotified ?? false;
  let expiryAcknowledged = link.expiryAcknowledged ?? false;
  let expiresAt = backfilledExpiresAt;

  if (link.muted) {
    // Legacy muted links are treated as already-expired (Design Decision 4):
    // clamp regardless of whether the un-clamped effectiveExpiry is future.
    //
    // Gate-remediation fix (Finding 1, epic invite-link-lifecycle): stamping
    // expiryNotified alone is NOT suppression. `initInviteExpiries` derives
    // the bell badge as `isExpired && expiryNotified && !expiryAcknowledged`
    // — leaving expiryAcknowledged=false on a suppressed link means it still
    // counts as an unread badge on the very next derivation, reproducing the
    // retroactive-expiry flood this branch exists to prevent. "Suppressed"
    // must mean "already notified AND already dismissed", so both flags are
    // stamped together here.
    expiresAt = Math.min(backfilledExpiresAt, now);
    expiryNotified = true;
    expiryAcknowledged = true;
  } else if (isLegacyExpiresAt && backfilledExpiresAt <= now) {
    // Only a record whose expiresAt was itself the missing field (a
    // genuinely legacy record) is stamped here — a record that already
    // carried its own expiresAt is never re-derived as "already expired" by
    // this path, so a later migrateInviteLinks call can never steal a
    // notification the sweep owns for a normally-created, since-expired link.
    //
    // Gate-remediation fix (Finding 1): same suppression-must-mean-dismissed
    // reasoning as the muted branch above — see that comment.
    expiryNotified = true;
    expiryAcknowledged = true;
  }

  const unchanged =
    expiresAt === link.expiresAt &&
    usageCount === link.usageCount &&
    expiryNotified === link.expiryNotified &&
    expiryAcknowledged === link.expiryAcknowledged;
  if (unchanged) {
    return null;
  }

  return { ...link, expiresAt, usageCount, expiryNotified, expiryAcknowledged } as InviteLink;
}

let migrationInFlight: Promise<void> | null = null;

/**
 * Gate-remediation fix (Finding 2, epic invite-link-lifecycle): a prior
 * revision bulk-read every record via `entries()` and wrote each migrated
 * snapshot with a raw `set()`, bypassing `withNonceLock` entirely. That left
 * a read-to-write race window: if `incrementInviteLinkUsage` (or a mark-*
 * helper) landed on a record between the bulk read and migration's write,
 * migration's stale snapshot — computed from the pre-increment read — would
 * overwrite the concurrent write, losing it (e.g. a fresh `usageCount: 1`
 * clobbered back to `0`).
 *
 * The fix closes the window by using the SAME per-nonce lock as every other
 * mutator and re-reading the current persisted value from inside the lock,
 * immediately before recomputing and writing. Because `incrementInviteLinkUsage`
 * and the mark-* helpers also serialize through `withNonceLock` for the same
 * nonce, this guarantees migration's write and a concurrent mutation can
 * never interleave for a single record — whichever acquires the lock first
 * completes fully before the other starts, so the later writer always
 * recomputes from the freshest state and no update is ever lost.
 * `migrateRecord` itself needs no change: it already derives every migrated
 * field from the record it is given (`link.usageCount ?? 0`, etc.), so
 * feeding it the freshly re-read record is sufficient to preserve any field
 * a concurrent writer already set.
 */
async function runMigration(now: number, belongsToSession: (groupId: string) => boolean, allowed: (link: LegacyInviteLink) => boolean): Promise<void> {
  const all = await entries<string, LegacyInviteLink>(inviteLinkStore);
  await Promise.all(
    all.map(([nonce]) =>
      withNonceLock(nonce, async () => {
        const fresh = await get<LegacyInviteLink>(nonce, inviteLinkStore);
        if (!fresh || !belongsToSession(fresh.groupId) || !allowed(fresh)) return;
        const migrated = migrateRecord(fresh, now);
        if (migrated) {
          await set(nonce, migrated, inviteLinkStore);
        }
      })
    )
  );
}

/**
 * One-shot, idempotent migration that backfills `expiresAt`/`usageCount`/
 * `expiryNotified`/`expiryAcknowledged` onto legacy records and resolves
 * pre-existing `muted: true` records (Design Decisions 2–4). Safe to call at
 * every app startup: a fully-migrated, non-muted record is never rewritten.
 *
 * Concurrent invocations (React StrictMode double-effects, overlapping
 * startup calls) are deduplicated onto a single in-flight promise so two
 * simultaneous callers never walk the store independently.
 */
export function migrateInviteLinks(now: number, belongsToSession: (groupId: string) => boolean = () => true, allowed: (link: LegacyInviteLink) => boolean = () => true): Promise<void> {
  if (migrationInFlight) return migrationInFlight;
  const run = runMigration(now, belongsToSession, allowed).finally(() => {
    migrationInFlight = null;
  });
  migrationInFlight = run;
  return run;
}
