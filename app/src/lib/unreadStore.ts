/**
 * Unread message count store — lightweight module-level store.
 *
 * Uses useSyncExternalStore for React integration without needing a Context.
 * Persists lastReadTimestamp per group in localStorage; tracks unread counts
 * in memory and syncs them on mount from IndexedDB.
 */

import { useSyncExternalStore } from 'react';
import { isPendingConfirmation, readStoredContacts } from '@/src/lib/contacts';
import { isAllowedDmSender } from '@/src/lib/walledGarden';
import type { WhitelistArgs } from '@/src/lib/walledGarden';

const STORAGE_KEY = 'lp_unreadLastRead_v1';
const DM_STORAGE_KEY = 'lp_unreadLastReadDM_v1';

type UnreadState = {
  /** Unread message count per groupId */
  counts: Record<string, number>;
  /** Pending join request count per groupId */
  joinRequests: Record<string, number>;
  /** Unread direct-message count per peer pubkey (lowercase hex) */
  directMessages: Record<string, number>;
  /**
   * Unread invite-link expiry-notification count per groupId (epic:
   * invite-link-lifecycle, story S4). Unlike the other three slices, this
   * one is never mutated directly by a live "increment" caller reacting to
   * a real-time event alone — it is always re-derivable from persisted
   * `InviteLink.expiryNotified`/`expiryAcknowledged` flags via
   * `initInviteExpiries` (Design Decision 8, AC-NOTIFY-1/AC-INV-2). The
   * sweep's `incrementInviteExpiry` bump is a live-count optimisation on
   * top of that derivation, not a replacement for it — see
   * `inviteExpirySweep.ts`.
   */
  inviteExpiries: Record<string, number>;
  /**
   * Pending-contact bell count per peer pubkey (lowercase hex), value 1 per
   * pending contact (epic: pending-contact-notification, S1). Re-derivable
   * from persisted contact state (`pendingConfirmationSince` set AND not
   * archived) via `initPendingContactCounts`, mirroring the `inviteExpiries`
   * "derive from persisted flags, live-increment on top" pattern (DD-2). A
   * fresh pairing-ack admission live-increments it (AC-LIFE-1); Confirm and
   * Reject/block clear it (AC-LIFE-3/4).
   */
  pendingContacts: Record<string, number>;
};

let state: UnreadState = { counts: {}, joinRequests: {}, directMessages: {}, inviteExpiries: {}, pendingContacts: {} };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): UnreadState {
  return state;
}

function getServerSnapshot(): UnreadState {
  return { counts: {}, joinRequests: {}, directMessages: {}, inviteExpiries: {}, pendingContacts: {} };
}

// --- Init / live-increment reconciliation ---
// Each init*Counts reads IDB asynchronously, then replaces a state slice. A live
// increment (incrementUnread / incrementJoinRequest / incrementDirectMessage)
// arriving DURING that async scan must not be clobbered by the stale computed
// snapshot — the bug where a freshly-arrived message lowered the badge right
// after startup. Every increment source persists to IDB *before* calling its
// increment (chatHandler awaits appendMessage first; the join-request and DM
// paths likewise store before counting), so a key "touched" by a live increment
// during init can be authoritatively RE-READ from IDB — capturing the new
// message without double-counting the live bump.
type CountSlice = 'counts' | 'joinRequests' | 'directMessages' | 'pendingContacts';
const initInProgress: Record<CountSlice, boolean> = {
  counts: false,
  joinRequests: false,
  directMessages: false,
  pendingContacts: false,
};
const initTouched: Record<CountSlice, Set<string>> = {
  counts: new Set(),
  joinRequests: new Set(),
  directMessages: new Set(),
  pendingContacts: new Set(),
};

function noteLiveIncrement(slice: CountSlice, key: string) {
  if (initInProgress[slice]) initTouched[slice].add(key);
}

// --- Confirm-time single-peer reconcile floor ---
// `reconcileInit`'s "authoritative IDB count supersedes both the stale next
// and the live bump" comment above is correct for slices where persistence
// keeps pace with live events — the batch/startup DM scan and the non-DM
// slices all persist BEFORE incrementing. But `incrementDirectMessage` (the
// live bell bump fired by directMessageNotifications.ts) does NOT persist
// message content — only `ContactChat` mounting does, via a historical relay
// fetch. So for `reconcileConfirmedContactDirectMessageCount`'s single-peer
// confirm-time call specifically, a DM that lands while its raw idb-keyval
// read is in flight can never be "seen" by the recompute, and the recompute
// must not be allowed to overwrite that live bump back down.
//
// Contract (corrected 2026-07-15 — the previous wording here claimed this
// "tracks the highest live count observed... while that one call is in
// flight", which does not match the code below): `reconcileFloor[key]` is
// seeded with the PRE-CALL count (`state.directMessages[key] ?? 0`) at the
// moment the reconcile starts — not with a live-observed increment — so the
// actual rule is "the reconcile never lowers a peer's count below its
// pre-call value". `noteLiveIncrementFloor` then raises that floor via
// `Math.max` for any live bump that fires while this key is tracked, so a DM
// landing mid-call is ALSO protected. Net effect: the `finally` block below
// floors the post-recompute count at whichever is higher — the value the
// peer already had when the reconcile started, or any live bump that
// happened during it. Scoped to this one key/call, never touching
// `reconcileInit` or its other callers.
const reconcileFloor: Record<string, number> = {};

function noteLiveIncrementFloor(key: string, value: number) {
  if (key in reconcileFloor) {
    reconcileFloor[key] = Math.max(reconcileFloor[key], value);
  }
}

// --- Serialize concurrent reconciles for the same slice ---
// `reconcileInit` mutates the per-slice `initInProgress`/`initTouched` state
// declared above, which was only ever safe with ONE call in flight per slice
// at a time. The `directMessages` slice gained a SECOND caller in the
// pending-contact-confirmation epic — `reconcileConfirmedContactDirectMessageCount`,
// fired on every pending-contact confirm — alongside the pre-existing
// startup batch scan (`initDirectMessageCounts`, invoked once by
// `DirectMessageNotificationsWatcher` at load). If a confirm overlaps the
// startup scan (a real window: the scan `await`s one idb `get()` per known
// peer), the confirm's `reconcileInit` call would clear
// `initTouched['directMessages']` mid-scan — discarding the batch scan's
// accumulated live-increment keys — and then set
// `initInProgress['directMessages'] = false` while the batch scan is still
// awaiting its own reads, so a later live bump the batch scan should have
// re-read goes unnoted. That reintroduces exactly the startup-clobber bug
// this module's very first comment block (above `initInProgress`/
// `initTouched`) exists to prevent. Fixed by serializing same-slice calls
// behind a promise chain: a second call for a slice already in flight simply
// awaits the first call's completion before it starts its own
// `initInProgress`/`initTouched` bookkeeping. This keeps the existing
// single-call invariants intact rather than reworking them into per-call
// state (this module never needs more than one reconcile per slice actually
// RUNNING at a time — queuing is sufficient and much smaller a change).
const reconcileChain: Record<CountSlice, Promise<void>> = {
  counts: Promise.resolve(),
  joinRequests: Promise.resolve(),
  directMessages: Promise.resolve(),
  pendingContacts: Promise.resolve(),
};

async function reconcileInit(
  slice: CountSlice,
  keys: string[],
  computeForKey: (key: string) => Promise<number>,
): Promise<void> {
  const run = reconcileChain[slice].then(() => reconcileInitExclusive(slice, keys, computeForKey));
  // Keep the queue alive even if this call rejects — one caller's failure
  // must not wedge every later same-slice reconcile behind a rejected
  // promise forever. The caller of `reconcileInit` still observes the real
  // rejection via `run`, returned below.
  reconcileChain[slice] = run.catch(() => undefined);
  return run;
}

async function reconcileInitExclusive(
  slice: CountSlice,
  keys: string[],
  computeForKey: (key: string) => Promise<number>,
): Promise<void> {
  initInProgress[slice] = true;
  initTouched[slice].clear();

  try {
    const next: Record<string, number> = {};
    for (const key of keys) {
      const n = await computeForKey(key);
      if (n > 0) next[key] = n;
    }

    // Re-read keys a live increment touched during the scan; the authoritative IDB
    // count supersedes both the stale `next` and the live bump. Bounded so a
    // steady message stream cannot loop forever (residual staleness ≤ a handful of
    // messages arriving in the final window — vs. the old bug losing them all).
    let passes = 0;
    while (initTouched[slice].size > 0 && passes < 3) {
      passes++;
      const toReread = Array.from(initTouched[slice]);
      initTouched[slice].clear();
      for (const key of toReread) {
        const n = await computeForKey(key);
        if (n > 0) next[key] = n;
        else delete next[key];
      }
    }

    // `next` (authoritative) wins for every recomputed key; any live-only key not
    // in `keys` is preserved. No await between the last compute and the write, so
    // no increment can interleave and be lost.
    state = { ...state, [slice]: { ...state[slice], ...next } };
    emit();
  } finally {
    // Reset even if computeForKey rejects. Counts stay correct either way — the
    // flag's only reader is noteLiveIncrement, and every scan clears initTouched
    // at entry — so a stranded `true` leaks memory (live increments keep
    // inserting into a set nothing drains) rather than corrupting a badge.
    initInProgress[slice] = false;
  }
}

// --- Persistence helpers ---

function loadLastReadTimestamps(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLastReadTimestamps(timestamps: Record<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    // Non-fatal
  }
}

function loadDirectMessageLastRead(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDirectMessageLastRead(timestamps: Record<string, number>) {
  try {
    localStorage.setItem(DM_STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    // Non-fatal
  }
}

function dmKey(peerPubkeyHex: string): string {
  return peerPubkeyHex.toLowerCase();
}

// --- Public API ---

/** Increment unread count for a group (called when a chat message arrives). */
export function incrementUnread(groupId: string) {
  noteLiveIncrement('counts', groupId);
  const next = { ...state.counts };
  next[groupId] = (next[groupId] ?? 0) + 1;
  state = { ...state, counts: next };
  emit();
}

/** Mark a group as read — resets its unread count and persists the timestamp. */
export function markAsRead(groupId: string) {
  const timestamps = loadLastReadTimestamps();
  timestamps[groupId] = Date.now();
  saveLastReadTimestamps(timestamps);

  if (state.counts[groupId]) {
    const next = { ...state.counts };
    delete next[groupId];
    state = { ...state, counts: next };
    emit();
  }
}

/** Remove tracking for a group (called on group leave). */
export function clearUnreadGroup(groupId: string) {
  const timestamps = loadLastReadTimestamps();
  delete timestamps[groupId];
  saveLastReadTimestamps(timestamps);

  if (state.counts[groupId]) {
    const next = { ...state.counts };
    delete next[groupId];
    state = { ...state, counts: next };
    emit();
  }
}

/**
 * Initialise unread counts from persisted messages.
 * Called once after MarmotContext loads groups.
 */
export async function initUnreadCounts(groupIds: string[], ownPubkey: string) {
  const timestamps = loadLastReadTimestamps();
  const { get } = await import('idb-keyval');
  await reconcileInit('counts', groupIds, async (groupId) => {
    const lastRead = timestamps[groupId] ?? 0;
    try {
      const messages: Array<{ createdAt: number; senderPubkey: string }> | undefined = await get(
        `few:messages:${groupId}`,
      );
      if (messages && messages.length > 0) {
        return messages.filter((m) => m.createdAt > lastRead && m.senderPubkey !== ownPubkey).length;
      }
    } catch {
      // Non-fatal — group messages may not exist yet
    }
    return 0;
  });
}

/**
 * Initialise join request counts from persisted pending requests in IDB.
 * Called once after MarmotContext loads groups.
 */
export async function initJoinRequestCounts(groupIds: string[]) {
  const { entries } = await import('idb-keyval');
  const { createJoinRequestStore } = await import('@/src/lib/marmot/joinRequestStorage');
  const store = createJoinRequestStore();
  await reconcileInit('joinRequests', groupIds, async (groupId) => {
    try {
      const all = await entries<string, { groupId: string }>(store);
      return all.filter(([, req]) => req.groupId === groupId).length;
    } catch {
      // Non-fatal — join request store may not exist yet
      return 0;
    }
  });
}

// --- Join request counter API ---

/** Increment join request counter for a group. */
export function incrementJoinRequest(groupId: string) {
  noteLiveIncrement('joinRequests', groupId);
  const next = { ...state.joinRequests };
  next[groupId] = (next[groupId] ?? 0) + 1;
  state = { ...state, joinRequests: next };
  emit();
}

/** Reset join request counter for a group to 0. */
export function markJoinRequestsRead(groupId: string) {
  if (state.joinRequests[groupId]) {
    const next = { ...state.joinRequests };
    delete next[groupId];
    state = { ...state, joinRequests: next };
    emit();
  }
}

/** Decrement join request counter for a group by 1. */
export function decrementJoinRequest(groupId: string) {
  const current = state.joinRequests[groupId] ?? 0;
  if (current <= 1) {
    // Drop to zero — remove the entry entirely
    if (state.joinRequests[groupId]) {
      const next = { ...state.joinRequests };
      delete next[groupId];
      state = { ...state, joinRequests: next };
      emit();
    }
  } else {
    const next = { ...state.joinRequests, [groupId]: current - 1 };
    state = { ...state, joinRequests: next };
    emit();
  }
}

/** Remove join request tracking for a group (called on group leave). */
export function clearJoinRequestGroup(groupId: string) {
  if (state.joinRequests[groupId]) {
    const next = { ...state.joinRequests };
    delete next[groupId];
    state = { ...state, joinRequests: next };
    emit();
  }
}

// --- Pending-contact bell API (epic: pending-contact-notification, S1) ---
// Mirrors the joinRequests slice's init/increment/mark-read/clear/hook shape
// (DD-2). Structural difference, like `initInviteExpiries`: the init takes no
// id argument — the authoritative source is `readStoredContacts()`. The count
// is a per-peer boolean (0 or 1): a contact is either pending-and-unactioned
// or not, so `incrementPendingContact` SETS to 1 (idempotent) rather than
// accumulating, and mark-read / clear delete the entry (AC-BELL-3).

/**
 * Initialise the pending-contact bell slice from persisted contact state
 * (AC-BELL-2, AC-LIFE-2). One entry per stored contact whose
 * `pendingConfirmationSince` is set AND which is NOT archived — block wins
 * over pending, so an archived pending contact contributes nothing.
 * `isPendingConfirmation` alone ignores `archivedAt`, so the not-archived
 * condition is combined explicitly here. Routes through `reconcileInit` so a
 * live `incrementPendingContact` arriving during the recompute is not lost.
 */
export async function initPendingContactCounts(): Promise<void> {
  const isPendingNonArchived = (c: { pendingConfirmationSince?: string | null; archivedAt?: string | null }) =>
    Boolean(c.pendingConfirmationSince) && !c.archivedAt;
  const pendingKeys = Object.values(readStoredContacts())
    .filter(isPendingNonArchived)
    .map((c) => c.pubkeyHex.toLowerCase());
  await reconcileInit('pendingContacts', pendingKeys, async (key) => {
    const stillPending = Object.values(readStoredContacts()).some(
      (c) => c.pubkeyHex.toLowerCase() === key && isPendingNonArchived(c),
    );
    return stillPending ? 1 : 0;
  });
}

/**
 * Set the pending-contact bell entry for a peer (idempotent; count is 0 or 1).
 *
 * Rings ONLY for a genuinely pending, non-archived contact (block wins,
 * AC-BELL-2). A fresh pairing-ack `admitted` result can re-fire for a sender
 * who is ALREADY a confirmed or archived contact — `rememberPendingContact`
 * preserves their existing `pendingConfirmationSince`/`archivedAt` rather than
 * re-pending them — so gating purely on the `admitted` status at the call site
 * would create a misleading, non-actionable bell row (no Confirm/Reject to
 * resolve it) for a contact that is not pending. Enforcing the invariant here
 * protects every caller and keeps live-increment consistent with the
 * init-from-stored derivation.
 */
export function incrementPendingContact(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  const stored = Object.values(readStoredContacts()).find((c) => c.pubkeyHex.toLowerCase() === key);
  if (!stored || !stored.pendingConfirmationSince || stored.archivedAt) return;
  noteLiveIncrement('pendingContacts', key);
  if (state.pendingContacts[key] === 1) return;
  state = { ...state, pendingContacts: { ...state.pendingContacts, [key]: 1 } };
  emit();
}

/** Mark a pending-contact bell entry read (removes it). */
export function markPendingContactRead(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  if (state.pendingContacts[key]) {
    const next = { ...state.pendingContacts };
    delete next[key];
    state = { ...state, pendingContacts: next };
    emit();
  }
}

/** Clear a pending-contact bell entry (called on Confirm and on Reject/block). */
export function clearPendingContact(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  if (state.pendingContacts[key]) {
    const next = { ...state.pendingContacts };
    delete next[key];
    state = { ...state, pendingContacts: next };
    emit();
  }
}

// --- Invite-link expiry counter API (epic: invite-link-lifecycle, S4) ---
// Mirrors the joinRequests slice's init/increment/mark-read/clear/hook shape
// (Design Decision 9), with one structural difference: `initInviteExpiries`
// takes no `groupIds` argument. Per architecture.md's Implementation
// Constraints, invite-link records carry no "created by this user" filter —
// the sweep and this derivation process every locally-stored link
// regardless of the admin's current group list — so the per-group buckets
// are derived directly from each link's own `groupId` field rather than
// from an externally-supplied group-id list.

/**
 * Derives, per groupId, the count of that group's stored invite links
 * satisfying `isExpired(link, now) && link.expiryNotified && !link.expiryAcknowledged`
 * (AC-NOTIFY-1). Fully recomputed from persisted flags on every call — never
 * a cached in-memory value — so a reload reproduces the identical count
 * (AC-INV-2, Design Decision 8): the badge is not an in-memory-only counter
 * that a reload between "stamp notified" and "user opens bell" could lose.
 */
export async function initInviteExpiries(now: number = Date.now()): Promise<void> {
  const { loadAllInviteLinks, isExpired } = await import('@/src/lib/marmot/inviteLinkStorage');
  let links: Awaited<ReturnType<typeof loadAllInviteLinks>>;
  try {
    links = await loadAllInviteLinks();
  } catch {
    // Non-fatal — invite-link store may not exist yet (fresh install).
    return;
  }
  const next: Record<string, number> = {};
  for (const link of links) {
    if (link.expiryNotified && !link.expiryAcknowledged && isExpired(link, now)) {
      next[link.groupId] = (next[link.groupId] ?? 0) + 1;
    }
  }
  state = { ...state, inviteExpiries: next };
  emit();
}

/**
 * Bumps the live invite-expiry counter for a group by 1. Called only by
 * `inviteExpirySweep.ts`, AFTER it has already persisted
 * `expiryNotified: true` for the link that triggered the bump (AC-INV-4) —
 * this function itself does no persistence; it is a live-count optimisation
 * layered on top of the persisted-flag derivation `initInviteExpiries`
 * performs, not a replacement for it.
 */
export function incrementInviteExpiry(groupId: string) {
  const next = { ...state.inviteExpiries };
  next[groupId] = (next[groupId] ?? 0) + 1;
  state = { ...state, inviteExpiries: next };
  emit();
}

/**
 * Marks a group's expired-and-notified invite links as acknowledged
 * (persists `expiryAcknowledged: true` on each) and zeroes that group's
 * live `inviteExpiries` count (AC-NOTIFY-4). The persistence step is
 * required, not optional: since the count is re-derived from persisted
 * flags on every `initInviteExpiries` call, acknowledging only in memory
 * would be undone the next time the app reloads and recomputes the slice.
 */
export async function markInviteExpiriesRead(groupId: string): Promise<void> {
  const { loadInviteLinks, isExpired, markInviteLinkExpiryAcknowledged } = await import(
    '@/src/lib/marmot/inviteLinkStorage'
  );
  let links: Awaited<ReturnType<typeof loadInviteLinks>>;
  try {
    links = await loadInviteLinks(groupId);
  } catch {
    links = [];
  }
  const now = Date.now();
  const toAck = links.filter(
    (link) => link.expiryNotified && !link.expiryAcknowledged && isExpired(link, now),
  );
  await Promise.all(toAck.map((link) => markInviteLinkExpiryAcknowledged(link.nonce)));

  if (state.inviteExpiries[groupId]) {
    const next = { ...state.inviteExpiries };
    delete next[groupId];
    state = { ...state, inviteExpiries: next };
    emit();
  }
}

/**
 * Remove invite-expiry tracking for a group (called on group leave/abandon,
 * alongside `clearInviteLinksForGroup` — Design Decision 12, AC-DEEPLINK-4).
 * In-memory only, mirroring `clearJoinRequestGroup`: the underlying link
 * records are removed by `clearInviteLinksForGroup` itself, so there is
 * nothing left to re-derive a stale count from on the next init.
 */
export function clearInviteExpiries(groupId: string) {
  if (state.inviteExpiries[groupId]) {
    const next = { ...state.inviteExpiries };
    delete next[groupId];
    state = { ...state, inviteExpiries: next };
    emit();
  }
}

// --- Direct message counter API ---

/** Increment unread direct-message count for a peer (called when a DM arrives). */
export function incrementDirectMessage(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  noteLiveIncrement('directMessages', key);
  const next = { ...state.directMessages };
  next[key] = (next[key] ?? 0) + 1;
  state = { ...state, directMessages: next };
  noteLiveIncrementFloor(key, next[key]);
  emit();
}

/** Mark a peer's DM thread as read — resets count and persists the timestamp. */
export function markDirectMessagesRead(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  const timestamps = loadDirectMessageLastRead();
  timestamps[key] = Date.now();
  saveDirectMessageLastRead(timestamps);

  if (state.directMessages[key]) {
    const next = { ...state.directMessages };
    delete next[key];
    state = { ...state, directMessages: next };
    emit();
  }
}

/** Last-read timestamp (ms) for a peer's DM thread; 0 if never opened. */
export function getDirectMessageLastReadAt(peerPubkeyHex: string): number {
  const timestamps = loadDirectMessageLastRead();
  return timestamps[dmKey(peerPubkeyHex)] ?? 0;
}

/** Remove DM tracking for a peer (called on contact removal). */
export function clearDirectMessageContact(peerPubkeyHex: string) {
  const key = dmKey(peerPubkeyHex);
  const timestamps = loadDirectMessageLastRead();
  delete timestamps[key];
  saveDirectMessageLastRead(timestamps);

  if (state.directMessages[key]) {
    const next = { ...state.directMessages };
    delete next[key];
    state = { ...state, directMessages: next };
    emit();
  }
}

/**
 * Initialise direct-message unread counts from persisted DM threads.
 * Reads `few:messages:dm:<peer>` keys (the same store ContactChat uses).
 *
 * This is the BATCH/STARTUP path — called by `DirectMessageNotificationsWatcher`
 * for every known peer on app load. It deliberately reads the raw idb-keyval
 * entry directly rather than going through `chatPersistence.ts#loadMessages`:
 * `loadMessages` runs a DM-thread self-heal pass on first access (rewrites
 * malformed rows, returns non-canonical-id rows as `refetchIds` for the
 * caller to enqueue a relay repair-refetch) and marks the thread healed as a
 * side effect. Marking a thread healed here — before the user has ever
 * opened it and before anyone consumes the `refetchIds` this function
 * discards — would silently rob `ContactChat`'s own `loadMessages` call of
 * the self-heal/refetch signal when the user finally does open that thread,
 * since `loadMessages` short-circuits to an empty `refetchIds` for
 * already-healed threads. That was a real regression: reviewed and reverted
 * (epic: pending-contact-confirmation, S2 gate-remediation) after a canonical-
 * read-path change briefly routed this batch scan through `loadMessages`.
 *
 * The confirm-action bell reconciliation for a single peer
 * (`reconcileConfirmedContactDirectMessageCount`) uses this exact same raw
 * read pattern, for the identical reason: no caller whose job is only to
 * *count* held messages may be the one to trigger or consume
 * `loadMessages`' one-time-per-thread self-heal side effect. There is no
 * "safe" case for a reconciliation-only caller to route through
 * `loadMessages` — that was tried once for this function (see the revert
 * noted above) and once more for `reconcileConfirmedContactDirectMessageCount`
 * (see that function's doc comment) before both converged on the raw read.
 */
export async function initDirectMessageCounts(peerPubkeysHex: string[], ownPubkeyHex: string) {
  const own = ownPubkeyHex.toLowerCase();
  const timestamps = loadDirectMessageLastRead();
  const { get } = await import('idb-keyval');
  // Key the slice by dmKey (lowercased peer) — matches incrementDirectMessage and
  // state.directMessages. reconcileInit re-reads any peer touched by a live DM
  // during the scan, so a stale computed value can no longer overwrite a newer
  // live count (the bug this finding flagged at the merge site).
  // A pending contact's bell stays dark until the user confirms them, so this
  // recompute drops them here — at the entrypoint that owns the slice — rather
  // than trusting each caller to pre-filter. The live-increment path gates the
  // same way (directMessageNotifications.ts); this is the batch-scan half of
  // that pair, and it is the reason a leaked contact card cannot light the bell
  // before its pairing has been confirmed. See spec AC-OBS-1 / Design Decision 9.
  const storedList = Object.values(readStoredContacts());
  const keys = peerPubkeysHex.map(dmKey).filter((key) => !isPendingConfirmation(key, storedList));
  await reconcileInit('directMessages', keys, async (key) => {
    const lastRead = timestamps[key] ?? 0;
    try {
      const messages: Array<{ createdAt: number; senderPubkey: string }> | undefined = await get(
        `few:messages:dm:${key}`,
      );
      if (messages && messages.length > 0) {
        return messages.filter((m) => m.createdAt > lastRead && m.senderPubkey.toLowerCase() !== own).length;
      }
    } catch {
      // Non-fatal — DM thread may not exist yet
    }
    return 0;
  });
}

/**
 * Reconciles a single peer's direct-message unread count via a raw,
 * side-effect-free `idb-keyval` read — the SAME pattern `initDirectMessageCounts`
 * uses, not `chatPersistence.ts#loadMessages`.
 *
 * Used ONLY by the pending-confirmation confirm action (`contacts.tsx` /
 * `PendingConfirmationPrompt.tsx#confirmPendingContact`) to reconcile the
 * bell for messages held while the contact was pending (AC-OBS-2).
 *
 * Gate-remediation (2026-07-15, second round): this function was originally
 * routed through `chatPersistence.ts#loadMessages` on the theory that doing
 * so was safe here because the user is "about to view this thread anyway."
 * That reasoning was wrong. `loadMessages` runs a DM-thread self-heal pass
 * exactly ONCE per thread per session — the first call for a given thread
 * marks it "healed" and returns real `refetchIds` for malformed/non-canonical
 * rows; every later call to that same thread short-circuits to `refetchIds:
 * []`. This function is called on EVERY confirm, including the still-live
 * detail-view confirm path (`PendingConfirmationPrompt.tsx`), so it can
 * easily be the FIRST caller to touch `loadMessages` for that thread —
 * permanently consuming the one-time repair opportunity before
 * `ContactChat`'s own later `loadMessages` call (the one that actually acts
 * on `refetchIds` to trigger a relay repair-refetch) ever gets a chance to
 * see them. This function discards `refetchIds` entirely, so that
 * consumption was pure loss: a genuine repair opportunity silently and
 * permanently dropped for a reconciliation-only read. Switching to the raw
 * idb-keyval read below removes the self-heal side effect from this call
 * site altogether — mirrors `initDirectMessageCounts`'s own identical fix
 * earlier in this same remediation session (see that function's doc comment
 * above), and for the identical reason: a reconciliation-only caller must
 * never be the first to trigger a one-time repair signal it cannot consume.
 *
 * AC-OBS-2 was amended 2026-07-15 (spec.md `## Amendments`): for a contact
 * whose conversation was never opened while pending, this read finds
 * nothing persisted yet (message content is only written once `ContactChat`
 * has mounted at least once) and resolves to 0 — a no-op in that common
 * case. The bell still ends up correct because AC-OBS-1 guarantees it was
 * never incorrectly bumped for those messages in the first place; the real
 * catch-up happens the next time the user opens the conversation, when
 * `ContactChat` loads the now-fetchable history and marks it read via its
 * own `markDirectMessagesRead` mount effect (not via this function).
 *
 * Gate-remediation (Codex P2, 2026-07-15, first round): `reconcileInit`'s
 * shared re-read loop assumes an authoritative recompute always supersedes a
 * live bump — true when persistence keeps pace with live events (the
 * batch/startup scan and the non-DM slices), false here, since
 * `incrementDirectMessage` never persists content. If the just-confirmed
 * peer's next DM lands while the raw read below is in flight, the live bell
 * bump fires but the recompute (reading only already-persisted history)
 * can't see it — so this floors the final count at the highest live value
 * observed during the call, ensuring that live bump is never silently
 * dropped. See `reconcileFloor`'s comment near `noteLiveIncrement` for why
 * this is scoped to this one key/call rather than changed in the shared
 * helper.
 */
export async function reconcileConfirmedContactDirectMessageCount(
  peerPubkeyHex: string,
  ownPubkeyHex: string,
): Promise<void> {
  const own = ownPubkeyHex.toLowerCase();
  const timestamps = loadDirectMessageLastRead();
  const { get } = await import('idb-keyval');
  const key = dmKey(peerPubkeyHex);

  reconcileFloor[key] = state.directMessages[key] ?? 0;
  try {
    await reconcileInit('directMessages', [key], async (k) => {
      const lastRead = timestamps[k] ?? 0;
      try {
        const messages: Array<{ createdAt: number; senderPubkey: string }> | undefined = await get(
          `few:messages:dm:${k}`,
        );
        if (messages && messages.length > 0) {
          return messages.filter((m) => m.createdAt > lastRead && m.senderPubkey.toLowerCase() !== own).length;
        }
      } catch {
        // Non-fatal — DM thread may not exist yet
      }
      return 0;
    });
  } finally {
    const floor = reconcileFloor[key];
    delete reconcileFloor[key];
    if (floor > (state.directMessages[key] ?? 0)) {
      const next = { ...state.directMessages, [key]: floor };
      state = { ...state, directMessages: next };
      emit();
    }
  }
}

/**
 * Purges unread-counter entries for stranger peers (AC-PURGE-4).
 *
 * Checks both the in-memory `state.directMessages` map and the persisted
 * `lp_unreadLastReadDM_v1` localStorage store.  For every peer that fails
 * the whitelist check, `clearDirectMessageContact` is called, which removes
 * both the in-memory count and the persisted timestamp.
 *
 * After the sweep, `getDirectMessageLastReadAt(strangerHex)` returns 0 (the
 * module's unset sentinel).
 */
export function purgeStrangerDmCounters(
  getWhitelist: () => WhitelistArgs,
): void {
  const { groups, knownPeers, ownPubkeyHex } = getWhitelist();

  // Collect all peers tracked anywhere: in-memory counts + persisted timestamps.
  const peers = new Set<string>();
  for (const peer of Object.keys(state.directMessages)) {
    peers.add(peer);
  }
  const persisted = loadDirectMessageLastRead();
  for (const peer of Object.keys(persisted)) {
    peers.add(peer);
  }

  for (const peer of peers) {
    if (!isAllowedDmSender(peer, groups, knownPeers, ownPubkeyHex)) {
      clearDirectMessageContact(peer);
    }
  }
}

// --- Test bridge ---
// Expose store functions on window so e2e tests can inject unread state.
if (typeof window !== 'undefined') {
  (window as any).__fewUnread = {
    incrementUnread, markAsRead, clearUnreadGroup,
    incrementJoinRequest, markJoinRequestsRead, decrementJoinRequest, clearJoinRequestGroup,
    incrementDirectMessage, markDirectMessagesRead, clearDirectMessageContact,
    incrementInviteExpiry, markInviteExpiriesRead, clearInviteExpiries,
    incrementPendingContact, markPendingContactRead, clearPendingContact,
  };
}

// --- DM publish test bridge (dev only) ---
// Exposes publishDirectMessage via the page's own identity so e2e tests can
// send DMs without dynamic-importing webpack-aliased modules from page.evaluate.
// The bridge reads the private key from localStorage at call time.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as any).__fewPublishDm = async (peerPubkeyHex: string, content: string): Promise<void> => {
    try {
      const identityRaw = localStorage.getItem('lp_nostrIdentity_v1');
      if (!identityRaw) throw new Error('No identity in localStorage');
      const identity = JSON.parse(identityRaw) as { privateKeyHex: string };
      const { connectNdk } = await import('@/src/lib/ndkClient');
      const { publishDirectMessage } = await import('@/src/lib/directMessages');
      const ndk = await connectNdk(identity.privateKeyHex);
      await publishDirectMessage({ ndk, privateKeyHex: identity.privateKeyHex, peerPubkeyHex, content });
    } catch (err) {
      console.error('[__fewPublishDm] failed:', err);
      throw err;
    }
  };
}

// --- React hook ---

/** Returns the current unread state (counts per group + total). */
export function useUnreadCounts() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const totalUnread =
    Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0) +
    Object.values(snapshot.joinRequests).reduce((sum, n) => sum + n, 0) +
    Object.values(snapshot.directMessages).reduce((sum, n) => sum + n, 0) +
    Object.values(snapshot.inviteExpiries).reduce((sum, n) => sum + n, 0) +
    Object.values(snapshot.pendingContacts).reduce((sum, n) => sum + n, 0);

  return {
    counts: snapshot.counts,
    joinRequests: snapshot.joinRequests,
    directMessages: snapshot.directMessages,
    inviteExpiries: snapshot.inviteExpiries,
    pendingContacts: snapshot.pendingContacts,
    totalUnread,
  };
}
