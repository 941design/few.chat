/**
 * outboundJoinRequests.ts — Outbound join-request record store (S4,
 * epic: group-invite-link-onboarding).
 *
 * IndexedDB-backed record of join requests THIS device has sent, keyed by
 * nonce, using idb-keyval — mirrors joinRequestStorage.ts / inviteLinkStorage.ts
 * conventions.
 *
 * Written only on a SUCCESSFUL join-request send (joinRequestSender.ts) — a
 * failed send writes nothing (AC-AUTO-1). Consulted by the auto-accept
 * correlation (invitations/autoAccept.ts; until the cut-over also by
 * welcomeSubscription.ts) to match an invitation's sponsor against an admin
 * this device requested to join.
 *
 * Pure of React (AC-BOUND-1): the `useOutboundJoinRequests` hook lives in
 * `src/hooks/useOutboundJoinRequests.ts` and reads this module's
 * subscribe/snapshot surface.
 *
 * Correlation starts from `adminPubkeyHex` (the sponsor of the invitation) and is
 * narrowed by the group NAME the sponsor claims (invite context; see
 * invitations/autoAccept.ts). The `nonce` never reaches the Welcome (it lives solely
 * in the join-request rumor, a separate message — see DD-3 / AC-AUTO-4) and MUST NOT
 * be used as a Welcome-side correlation key; it remains the record's storage key
 * purely for identity/lookup purposes on the sender's own device.
 */

import { createStore, set, del, entries, clear } from 'idb-keyval';

export interface OutboundJoinRequestRecord {
  /** Hex nonce from the invite link — primary key (idb-keyval key), never
   *  read back from an inbound Welcome. */
  nonce: string;
  /** The admin's pubkey (hex) this device sent the join request to. The
   *  ONLY field correlation reads (against the Welcome's authenticated
   *  sender pubkey). */
  adminPubkeyHex: string;
  /** The group name from the invite link, used to disambiguate when this
   *  admin has more than one unexpired record (AC-AUTO-4a). */
  groupName: string;
  /** Date.now() at send time. */
  sentAt: number;
}

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const outboundJoinRequestStore = createStore('few-outbound-join-requests', 'requests');

export function createOutboundJoinRequestStore() {
  return outboundJoinRequestStore;
}

// ---------------------------------------------------------------------------
// Bounds (AC-AUTO-6)
// ---------------------------------------------------------------------------

/** Global cap on total stored records, consistent with the existing
 *  pending-invitation cap (epic-walled-garden-v2 AC-INVITE-3). */
export const OUTBOUND_JOIN_REQUEST_CAP = 256;

/** Minimum record lifetime: admin approval can legitimately lag by days, so
 *  the TTL floor is generous (>= 7 days, AC-AUTO-6). */
export const OUTBOUND_JOIN_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isExpired(record: OutboundJoinRequestRecord, now: number): boolean {
  return now - record.sentAt >= OUTBOUND_JOIN_REQUEST_TTL_MS;
}

// ---------------------------------------------------------------------------
// Reactive read layer (S2, epic: invite-link-awaiting-landing)
//
// Additive on top of the async CRUD above — no wire behavior, storage keys,
// TTL value, or auto-accept correlation semantics change here. Mirrors
// pendingInvitations.ts's _snapshot/_listeners/_emit()/subscribe()/
// getSnapshot() shape, with one addition pendingInvitations.ts does not need:
// a `_loaded` flag, since this store is IDB-backed (async) rather than
// localStorage-backed (always synchronously "loaded").
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: readonly OutboundJoinRequestRecord[] = [];

let _snapshot: readonly OutboundJoinRequestRecord[] = EMPTY_SNAPSHOT;
const _listeners = new Set<() => void>();
let _loaded = false;
let _loadStarted = false;

/**
 * Recomputes the cached snapshot from a full record set, filtering to
 * unexpired-only (AC-STORE-2: the TTL filter is evaluated at snapshot-compute
 * time — i.e. exactly here, at each mutation/load point — not lazily inside
 * `getSnapshot()` on every call, which would defeat the stable-reference
 * guarantee below since "now" changes constantly).
 *
 * Replaces `_snapshot` with a NEW array reference only when the filtered
 * content actually differs from the current snapshot (by nonce identity +
 * length) — repeated calls with no real change return the SAME reference.
 */
function _recomputeSnapshot(all: OutboundJoinRequestRecord[]): void {
  const now = Date.now();
  const unexpired = all.filter((record) => !isExpired(record, now));

  // NB: the unchanged-check compares by nonce identity + length only, which
  // is sound because every write is keyed by a unique nonce and records are
  // write-once (saved once on send, deleted on cancel/auto-accept — never
  // re-saved with mutated content). If a future caller ever re-saves an
  // existing nonce with a changed field (e.g. a different groupName), this
  // check would retain the stale snapshot reference; extend it to compare
  // record content if that invariant is ever relaxed.
  const unchanged =
    unexpired.length === _snapshot.length &&
    unexpired.every((record, i) => record.nonce === _snapshot[i].nonce);
  if (unchanged) return;

  _snapshot = unexpired;
}

function _emit(): void {
  _listeners.forEach((listener) => listener());
}

/**
 * Async one-shot initial load: reads every persisted record, recomputes the
 * cached snapshot, marks the store loaded, and notifies subscribers. Never
 * throws — on failure the store is still marked loaded (with a best-effort
 * snapshot) so a subscribed UI does not spin forever.
 */
async function _initialLoad(): Promise<void> {
  try {
    const all = await entries<string, OutboundJoinRequestRecord>(outboundJoinRequestStore);
    _recomputeSnapshot(all.map(([, record]) => record));
  } catch {
    // Never throw — best-effort snapshot, still mark loaded below.
  } finally {
    _loaded = true;
    _emit();
  }
}

function _ensureLoadStarted(): void {
  if (_loadStarted) return;
  _loadStarted = true;
  void _initialLoad();
}

/**
 * Subscribe to reactive-store changes — for useSyncExternalStore. Kicks off
 * the async initial load on the first-ever subscribe (idempotent alongside
 * the module-init-time trigger below via the `_loadStarted` guard).
 */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  _ensureLoadStarted();
  return () => _listeners.delete(listener);
}

/** Synchronous, cached snapshot accessor — for useSyncExternalStore. Never
 *  performs I/O; the underlying array is treated as immutable. */
export function getSnapshot(): OutboundJoinRequestRecord[] {
  return _snapshot as OutboundJoinRequestRecord[];
}

/** Stable empty snapshot for SSR/static export — mirrors pendingInvitations.ts
 *  / unreadStore.ts's getServerSnapshot() pattern. */
export function getServerSnapshot(): OutboundJoinRequestRecord[] {
  return EMPTY_SNAPSHOT as OutboundJoinRequestRecord[];
}

/** Whether the async initial load has resolved (success or failure). */
export function isOutboundJoinRequestsLoaded(): boolean {
  return _loaded;
}

/** Synchronous `loaded`-flag accessor for useSyncExternalStore. Returns a
 *  PRIMITIVE boolean so useSyncExternalStore's Object.is check detects the
 *  one-shot false→true transition even when the loaded record set is empty
 *  (see `useOutboundJoinRequests` for why that case is the bug this fixes). */
export function getLoadedSnapshot(): boolean {
  return _loaded;
}

/** SSR/static-export loaded snapshot — always false before hydration. */
export function getLoadedServerSnapshot(): boolean {
  return false;
}

// Kick off the initial load at module-init time in a browser environment, not
// only on first subscribe — mirrors pendingInvitations.ts's bottom-of-file
// `if (typeof window !== 'undefined')` guard, but fires the async load
// without awaiting (`void _initialLoad()`), so a component calling
// `getSnapshot()` before ever subscribing still eventually sees loaded data.
// The first-subscribe trigger in `subscribe()` above is a redundant guard for
// SSR/module-eval environments where `window` may not exist yet at import
// time but a subscribe happens later client-side; both paths are idempotent
// via `_loadStarted`.
if (typeof window !== 'undefined') {
  _ensureLoadStarted();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Persist an outbound join-request record, keyed by nonce.
 *
 * Enforces the global 256-record bound by dropping the single oldest record
 * (by `sentAt`) on overflow — mirroring pendingInvitations.ts's global-cap
 * eviction policy. Never throws: a storage failure here must not surface as
 * a user-visible error on a send that has ALREADY succeeded at the relay
 * layer (AC-AUTO-1 only governs whether a record is written, not whether
 * `sendJoinRequest` itself succeeds).
 */
export async function saveOutboundJoinRequest(record: OutboundJoinRequestRecord): Promise<void> {
  try {
    const all = await entries<string, OutboundJoinRequestRecord>(outboundJoinRequestStore);
    if (all.length >= OUTBOUND_JOIN_REQUEST_CAP) {
      const [oldestKey] = all.reduce((a, b) => (a[1].sentAt < b[1].sentAt ? a : b));
      await del(oldestKey, outboundJoinRequestStore);
    }
    await set(record.nonce, record, outboundJoinRequestStore);
  } catch {
    // Never throw — see doc comment above.
  }

  // Reactive-store funnel point (AC-STORE-4): every mutation of this IDB store
  // MUST recompute the cached snapshot and emit here — this is the ONLY place
  // saveOutboundJoinRequest notifies subscribers.
  try {
    const persisted = await entries<string, OutboundJoinRequestRecord>(outboundJoinRequestStore);
    _recomputeSnapshot(persisted.map(([, r]) => r));
  } catch {
    // Never throw
  } finally {
    _loaded = true;
    _emit();
  }
}

/**
 * Returns all UNEXPIRED outbound records whose `adminPubkeyHex` matches.
 *
 * Expired records are treated as absent for correlation purposes (AC-AUTO-6)
 * but are NOT deleted by this read path — eviction happens opportunistically
 * via the write-time cap in `saveOutboundJoinRequest`, or explicitly via
 * `deleteOutboundJoinRequest` after a correlated auto-accept consumes a
 * record.
 */
export async function loadUnexpiredOutboundJoinRequestsForAdmin(
  adminPubkeyHex: string,
): Promise<OutboundJoinRequestRecord[]> {
  const all = await entries<string, OutboundJoinRequestRecord>(outboundJoinRequestStore);
  const now = Date.now();
  return all
    .map(([, record]) => record)
    .filter((record) => record.adminPubkeyHex === adminPubkeyHex && !isExpired(record, now));
}

/**
 * Removes a single outbound record by nonce — the record consumed after a
 * correlated auto-accept (AC-AUTO-5). Other records (including siblings for
 * the same admin) are untouched. Idempotent; never throws.
 */
export async function deleteOutboundJoinRequest(nonce: string): Promise<void> {
  try {
    await del(nonce, outboundJoinRequestStore);
  } catch {
    // Never throw
  }

  // Reactive-store funnel point (AC-STORE-4): every mutation of this IDB store
  // MUST recompute the cached snapshot and emit here — this is the ONLY place
  // deleteOutboundJoinRequest notifies subscribers. Every caller (the auto-accept consume
  // port, the UI cancel) is therefore reactive without any edit of its own.
  try {
    const persisted = await entries<string, OutboundJoinRequestRecord>(outboundJoinRequestStore);
    _recomputeSnapshot(persisted.map(([, r]) => r));
  } catch {
    // Never throw
  } finally {
    _loaded = true;
    _emit();
  }
}

/**
 * The ONLY sanctioned UI-facing delete entry point (AC-STORE-5). Delegates
 * entirely to `deleteOutboundJoinRequest` — no reimplementation — so the
 * reactive-store funnel point above stays the single source of truth for
 * this mutation's recompute+emit.
 */
export async function cancelOutboundJoinRequest(nonce: string): Promise<void> {
  return deleteOutboundJoinRequest(nonce);
}

/**
 * Drop every outbound join-request record (account-wide reset).
 *
 * Nothing calls it yet; the recompute+emit below is for funnel consistency
 * only and is not load-bearing for any behavior beyond "it still clears the
 * store."
 */
export async function clearAllOutboundJoinRequests(): Promise<void> {
  await clear(outboundJoinRequestStore);

  _recomputeSnapshot([]);
  _loaded = true;
  _emit();
}
