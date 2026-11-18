/**
 * outboundJoinRequests.ts — Outbound join-request record store (S4,
 * epic: group-invite-link-onboarding).
 *
 * IndexedDB-backed record of join requests THIS device has sent, keyed by
 * requester account and nonce. Legacy nonce-only rows remain available to the UI.
 *
 * Written only on a SUCCESSFUL join-request send (joinRequestSender.ts) — a
 * failed send writes nothing (AC-AUTO-1). Consulted by the auto-accept
 * correlation (invitations/autoAccept.ts) to match an invitation's sponsor
 * against an admin this device requested to join.
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

import { createStore, set, del, entries, clear, promisifyRequest } from 'idb-keyval';

export interface OutboundJoinRequestRecord {
  /** Hex nonce from the invite link, never read back from an inbound Welcome. */
  nonce: string;
  /** Authenticated requester account. Missing on legacy rows, which confer no automatic consent. */
  accountPubkey?: string;
  /** The admin's pubkey (hex), matched against the Welcome's authenticated sponsor. */
  adminPubkeyHex: string;
  /** The group name from the invite link, used to disambiguate when this
   *  admin has more than one unexpired record (AC-AUTO-4a). */
  groupName: string;
  /** Date.now() at send time. */
  sentAt: number;
}

export interface OutboundJoinRequestConsent extends OutboundJoinRequestRecord {
  accountPubkey: string;
  /** Missing on fresh sends. A claim survives failed accepts and deletes. */
  claimedInvitationId?: string;
}

type StoredOutboundJoinRequestConsent = OutboundJoinRequestConsent & { claimToken?: string };

export type OutboundJoinRequestClaimResult =
  | { kind: 'unavailable' }
  | { kind: 'existing' }
  | { kind: 'acquired'; token: string };

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const outboundJoinRequestStore = createStore('few-outbound-join-requests', 'requests');
const ownedKey = (accountPubkey: string, nonce: string): [string, string] => [accountPubkey, nonce];

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

export function isOutboundJoinRequestExpired(record: Pick<OutboundJoinRequestRecord, 'sentAt'>, now: number): boolean {
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
 * visible fields differ from the current snapshot.
 */
function _recomputeSnapshot(all: OutboundJoinRequestRecord[]): void {
  const now = Date.now();
  const unexpired = all.filter((record) => !isOutboundJoinRequestExpired(record, now));

  // A claim changes correlation eligibility, while the awaiting card stays visible.
  const unchanged =
    unexpired.length === _snapshot.length &&
    unexpired.every((record, i) => {
      const previous = _snapshot[i];
      return record.nonce === previous.nonce &&
        record.accountPubkey === previous.accountPubkey &&
        record.adminPubkeyHex === previous.adminPubkeyHex &&
        record.groupName === previous.groupName &&
        record.sentAt === previous.sentAt;
    });
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
 * Persist a send under its account and nonce, or its nonce for legacy callers.
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
    const key = record.accountPubkey === undefined ? record.nonce : ownedKey(record.accountPubkey, record.nonce);
    const all = await entries<IDBValidKey, OutboundJoinRequestRecord>(outboundJoinRequestStore);
    const replacing = all.some(([existing]) => {
      return Array.isArray(key) && Array.isArray(existing)
        ? key[0] === existing[0] && key[1] === existing[1] && existing.length === 2
        : key === existing;
    });
    if (!replacing && all.length >= OUTBOUND_JOIN_REQUEST_CAP) {
      const [oldestKey] = all.reduce((a, b) => (a[1].sentAt < b[1].sentAt ? a : b));
      await del(oldestKey, outboundJoinRequestStore);
    }
    await set(key, record, outboundJoinRequestStore);
  } catch {
    // Never throw — see doc comment above.
  }

  await refreshSnapshotAfterMutation();
}

async function refreshSnapshotAfterMutation(): Promise<void> {
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
 * Scoped reads require the account to match both the key and the row.
 * The one-argument form reads legacy records for manual use.
 */
export async function loadUnexpiredOutboundJoinRequestsForAdmin(
  adminPubkeyHex: string,
): Promise<OutboundJoinRequestRecord[]>;
export async function loadUnexpiredOutboundJoinRequestsForAdmin(
  accountPubkey: string,
  adminPubkeyHex: string,
): Promise<OutboundJoinRequestConsent[]>;
export async function loadUnexpiredOutboundJoinRequestsForAdmin(
  accountPubkey: string,
  adminPubkeyHex?: string,
): Promise<OutboundJoinRequestRecord[]> {
  const all = await entries<IDBValidKey, OutboundJoinRequestRecord & { claimToken?: string }>(outboundJoinRequestStore);
  const now = Date.now();
  return all.flatMap(([key, { claimToken: _token, ...record }]) => {
    if (record.adminPubkeyHex !== (adminPubkeyHex ?? accountPubkey) || isOutboundJoinRequestExpired(record, now)) return [];
    const matches = adminPubkeyHex === undefined
      ? key === record.nonce && record.accountPubkey === undefined
      : accountPubkey.length > 0 && record.accountPubkey === accountPubkey &&
        Array.isArray(key) && key.length === 2 && key[0] === accountPubkey && key[1] === record.nonce;
    return matches ? [record] : [];
  });
}

/** Compare the send observed by correlation with the current row, then commit the change atomically. */
function changeOutboundJoinRequest<Result>(
  accountPubkey: string,
  expected: Readonly<OutboundJoinRequestConsent>,
  unmatched: Result,
  change: (store: IDBObjectStore, current: StoredOutboundJoinRequestConsent, key: [string, string]) => Result,
): Promise<Result> {
  if (!accountPubkey || expected.accountPubkey !== accountPubkey) return Promise.resolve(unmatched);
  const key = ownedKey(accountPubkey, expected.nonce);
  return outboundJoinRequestStore('readwrite', (store) => {
    const read = store.get(key);
    let result = unmatched;
    read.onsuccess = () => {
      const current = read.result as StoredOutboundJoinRequestConsent | undefined;
      if (
        current?.accountPubkey !== accountPubkey ||
        current.nonce !== expected.nonce ||
        current.adminPubkeyHex !== expected.adminPubkeyHex ||
        current.groupName !== expected.groupName ||
        current.sentAt !== expected.sentAt
      ) return;
      result = change(store, current, key);
    };
    return promisifyRequest(store.transaction).then(() => result);
  });
}

/** Bind an unexpired send to one invitation, or confirm that invitation's existing claim. */
export function claimOutboundJoinRequest(
  accountPubkey: string,
  expected: Readonly<OutboundJoinRequestConsent>,
  invitationId: string,
): Promise<OutboundJoinRequestClaimResult> {
  const unavailable = { kind: 'unavailable' } as const;
  const token = crypto.randomUUID();
  return changeOutboundJoinRequest<OutboundJoinRequestClaimResult>(accountPubkey, expected, unavailable, (store, current, key) => {
    if (isOutboundJoinRequestExpired(current, Date.now())) return unavailable;
    if (current.claimedInvitationId !== undefined) {
      return current.claimedInvitationId === invitationId ? { kind: 'existing' } : unavailable;
    }
    store.put({ ...current, claimedInvitationId: invitationId, claimToken: token }, key);
    return { kind: 'acquired', token };
  });
}

/** Release the exact acquisition. An earlier or replacement claim is left intact. */
export function releaseOutboundJoinRequestClaim(
  accountPubkey: string,
  expected: Readonly<OutboundJoinRequestConsent>,
  invitationId: string,
  token: string,
): Promise<boolean> {
  return changeOutboundJoinRequest<boolean>(accountPubkey, expected, false, (store, current, key) => {
    if (!current.claimToken || current.claimToken !== token || current.claimedInvitationId !== invitationId) return false;
    const { claimedInvitationId: _invitationId, claimToken: _token, ...unclaimed } = current;
    store.put(unclaimed, key);
    return true;
  });
}

/** Remove only the claimed send. A failed delete leaves the binding in place. */
export async function consumeOutboundJoinRequestClaim(
  accountPubkey: string,
  expected: Readonly<OutboundJoinRequestConsent>,
  invitationId: string,
): Promise<void> {
  const deleted = await changeOutboundJoinRequest<boolean>(accountPubkey, expected, false, (store, current, key) => {
    if (current.claimedInvitationId !== invitationId) return false;
    store.delete(key);
    return true;
  });
  if (deleted) await refreshSnapshotAfterMutation();
}

/**
 * Removes a single outbound record by nonce on cancellation. Idempotent.
 */
export async function deleteOutboundJoinRequest(nonce: string, accountPubkey?: string): Promise<void> {
  try {
    await del(accountPubkey === undefined ? nonce : ownedKey(accountPubkey, nonce), outboundJoinRequestStore);
  } catch {
    // Never throw
  }

  await refreshSnapshotAfterMutation();
}

/**
 * The ONLY sanctioned UI-facing delete entry point (AC-STORE-5). Delegates
 * entirely to `deleteOutboundJoinRequest` — no reimplementation — so the
 * reactive-store funnel point above stays the single source of truth for
 * this mutation's recompute+emit.
 */
export async function cancelOutboundJoinRequest(nonce: string, accountPubkey?: string): Promise<void> {
  return deleteOutboundJoinRequest(nonce, accountPubkey);
}

/**
 * Clear one account's rows and optionally legacy rows. No argument clears the entire store.
 */
export async function clearAllOutboundJoinRequests(accountPubkey?: string, includeLegacy = false): Promise<void> {
  if (accountPubkey === undefined) {
    await clear(outboundJoinRequestStore);
  } else {
    await outboundJoinRequestStore('readwrite', (store) => {
      const read = store.openKeyCursor();
      read.onsuccess = () => {
        const cursor = read.result;
        if (!cursor) return;
        const key = cursor.primaryKey;
        if ((Array.isArray(key) && key[0] === accountPubkey) || (includeLegacy && typeof key === 'string')) {
          store.delete(key);
        }
        cursor.continue();
      };
      return promisifyRequest(store.transaction);
    });
  }
  await refreshSnapshotAfterMutation();
}
