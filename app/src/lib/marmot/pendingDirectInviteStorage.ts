/**
 * pendingDirectInviteStorage.ts — IndexedDB-backed pending-direct-invite marker store.
 *
 * Epic: invite-rescind-and-member-removal | Story S1
 *
 * Mirrors profileRequestStorage.ts's createStore/get/set/del/entries/clear
 * pattern. Uses idb-keyval. Key format: `${groupId}:${pubkey}`.
 *
 * This module owns the marker's on-disk shape exclusively. It exposes two
 * distinct bulk-clear entrypoints — clearPendingDirectInvitesForGroup (one
 * group) and clearAllPendingDirectInvites (every group) — rather than a
 * single function overloaded on an optional/sentinel groupId argument, so
 * neither S2's clearAllGroupData (account reset) nor S3's leaveGroupImpl
 * (per-group leave fan-out) can accidentally invoke the wrong scope
 * (AC-MARKER-9).
 *
 * Per architecture.md's Boundary rules, this store is consumed only via a
 * context method (S5's MarmotContext.getPendingDirectInvites) or an
 * injected Deps function (S3's leaveGroupImpl, S4's profileHandler) —
 * never imported directly into a *Impl.ts pure-impl file.
 *
 * Decline durability (epic marmot-library-adoption, S11 / D7): the marker value is now a
 * `PendingDirectInviteMarker` record `{ inviteeRef, pubkey, declined }` written by
 * `recordPendingDirectInvite` at invite time (the library's `inviteeRef` is what a later
 * `welcomeDeclined` carries). Pre-record markers (the bare `true` written by
 * `markPendingDirectInvite`) are LEGACY: every record-aware reader ignores them without throwing
 * (pre-alpha, no migration); the legacy writer and the presence-only readers stay until the cut-over.
 * Read-modify-write on one key never uses idb-keyval `update()`: it is serialised per key instead.
 *
 * markPendingDirectInvite deliberately lets IDB errors (quota exceeded, IDB
 * unavailable) propagate uncaught — best-effort write semantics (log and
 * proceed on failure) are the call sites' responsibility (S7/S8's
 * AC-MARKER-2), not this store's.
 */

import { createStore, get, set, del, entries, clear } from 'idb-keyval';

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const pendingInviteMarkerStore = createStore(
  'few-pending-invite-markers',
  'markers',
);

/**
 * Key-formatting helper (${groupId}:${pubkey}), mirroring profileRequestStorage.ts's
 * memoKey. Exported only so the test file can assert on key shape directly —
 * every other module must call this store's exported clear/load/mark functions,
 * never reconstruct this format independently (VQ-S1-005).
 *
 * The pubkey is normalized to canonical lowercase here so the marker key is
 * casing-invariant at the STORE level, not by write-site convention: a marker
 * written by an invite site (S7/S8) always matches the clear keyed on the
 * invitee's own `signedEvent.pubkey` (canonical lowercase hex) at profile
 * arrival (S4) and the member-list Set membership check (S9/S10). Without this,
 * an un-lowercased write site would orphan the marker (order-sensitive
 * invariant #1). groupIds are already canonical (hex/uuid), so only the pubkey
 * needs normalizing.
 */
export function markerKey(groupId: string, pubkey: string): string {
  return `${groupId}:${pubkey.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Marker CRUD
// ---------------------------------------------------------------------------

/**
 * Mark (groupId, pubkey) as having a pending direct invite. Real IDB write —
 * lets a throw (quota/transient) propagate to the caller.
 */
export async function markPendingDirectInvite(
  groupId: string,
  pubkey: string,
): Promise<void> {
  const key = markerKey(groupId, pubkey);
  await serialisedOnKey(key, async () => {
    await set(key, true, pendingInviteMarkerStore);
    return true;
  });
}

/**
 * Clear the marker for (groupId, pubkey), if any. Idempotent — clearing an
 * absent or already-cleared key does not throw (VQ-S1-010). This is the
 * PendingDirectInviteClearFn seam S4's profileHandler consumes.
 */
export async function clearPendingDirectInvite(
  groupId: string,
  pubkey: string,
): Promise<void> {
  const key = markerKey(groupId, pubkey);
  // Serialised with the read-modify-write of markPendingDirectInviteDeclined: a clear is never overtaken by it.
  await serialisedOnKey(key, async () => {
    await del(key, pendingInviteMarkerStore);
    return true;
  });
}

/**
 * Load every pubkey currently marked pending for groupId as a Set<string> —
 * the exact shape the PendingDirectInviteMarkerSet seam contract requires
 * (VQ-S1-009). Performs a real entries() scan against the live store; no
 * in-memory cache shadows it, so a fresh call always reflects real IDB state
 * (AC-MARKER-10).
 */
export async function loadPendingDirectInviteMarkers(
  groupId: string,
): Promise<Set<string>> {
  const all = await entries<string, unknown>(pendingInviteMarkerStore);
  const prefix = `${groupId}:`;
  const pubkeys = all
    .filter(([key]) => key.startsWith(prefix))
    .map(([key]) => key.slice(prefix.length));
  return new Set(pubkeys);
}

// ---------------------------------------------------------------------------
// Atomic compare-and-clear (epic: group-invite-lifecycle S3 gate-remediation,
// severity-4 finding) — additive to the get/clear pair above, never a
// replacement for it. hasPendingDirectInvite()-then-clearPendingDirectInvite()
// is two independent async calls with an await gap between them: two
// interleaved own-join deliveries for the same (groupId, pubkey) can both
// observe the marker present before either clears it. This export collapses
// the check and the clear into one logical step per key.
// ---------------------------------------------------------------------------

/**
 * Per-key promise chains of `serialisedOnKey`: the tail of the in-flight serialised steps of each marker key.
 * A step awaits the previous one on the SAME key before it runs, so a read-modify-write never interleaves with
 * another serialised step on that key — without requiring the underlying store to expose real cross-call
 * transactions (the idb-keyval Map-backed test fixture used by profileHandler.test.ts doesn't). A prior
 * step's rejection is swallowed before chaining so one failed step never wedges the next.
 *
 * SERIALISED on this chain: consumePendingDirectInviteMarker, clearPendingDirectInvite,
 * markPendingDirectInvite (legacy writer), recordPendingDirectInvite, markPendingDirectInviteDeclined,
 * setPendingDirectInvitePhase, clearPendingDirectInviteIfRef, clearPendingDirectInvitesForGroup (per key).
 * NOT serialised (documented): the pure readers (get / load* / entries scans: a scan is a snapshot, each
 * decision based on it re-reads inside the chain) and clearAllPendingDirectInvites (the account wipe runs the
 * per-key deletes on the chain and then drops the whole store; a marker recorded in between is wiped too,
 * which is what a reset means).
 */
const keyChains = new Map<string, Promise<boolean>>();

/**
 * Runs `step` after every earlier serialised step on the SAME key settled (a prior rejection is swallowed so
 * one failed step never wedges the next). Shared by the consume and the mark-declined read-modify-write.
 */
async function serialisedOnKey(key: string, step: () => Promise<boolean>): Promise<boolean> {
  const prior = keyChains.get(key) ?? Promise.resolve(false);
  const run: Promise<boolean> = prior.catch(() => false).then(step);
  keyChains.set(key, run);
  try {
    return await run;
  } finally {
    // Only clear the chain slot if nothing newer has replaced it while we
    // were awaiting — otherwise we'd tear down a subsequent call's link.
    if (keyChains.get(key) === run) {
      keyChains.delete(key);
    }
  }
}

/**
 * Atomically consumes the pending-direct-invite marker for (groupId, pubkey):
 * reports whether it existed AND removes it, as a single step no other
 * consumePendingDirectInviteMarker call for the same key can observe
 * mid-way through. Consumed ONLY by the accept-producer's own-join path
 * (profileHandler.ts) — clearPendingDirectInvite above is untouched and
 * remains the sole clearing mechanism for the relay-on-behalf path, which
 * must keep clearing the marker without ever gating a post on its existence.
 */
export async function consumePendingDirectInviteMarker(
  groupId: string,
  pubkey: string,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, async () => {
    const existed = (await get(key, pendingInviteMarkerStore)) !== undefined;
    if (existed) {
      await del(key, pendingInviteMarkerStore);
    }
    return existed;
  });
}

// ---------------------------------------------------------------------------
// Decline durability (S11, D7): the marker record
// ---------------------------------------------------------------------------

/** Seam `PendingDirectInviteMarker`: what is stored per (group, invitee) from invite time on. */
export interface PendingDirectInviteMarker {
  /** The library's invite reference (`WelcomeOutcome.inviteeRef`): what `welcomeDeclined` carries. */
  inviteeRef: string;
  /** The invitee account, lowercase hex. */
  pubkey: string;
  /** True once the invitee's decline arrived: the sponsor still owes the Remove commit. */
  declined: boolean;
  /**
   * The signature key (hex) of the leaf the invite added, when it could be derived unambiguously at invite time
   * (exactly one leaf of the account that was not there before). The decline is bound to THIS leaf, not to the
   * account. Absent: the removal falls back to the account, and only when it holds a single leaf.
   */
  leafKey?: string;
  /**
   * Progress of an owed removal (only meaningful when `declined`); absent = `'declined'`:
   * `'declined'` nothing done yet; `'removing'` the Remove commit was started (it may or may not have landed);
   * `'announce-pending'` the Remove resolved, the `declined` announcement is still owed.
   */
  phase?: DeclinePhase;
  /** Epoch ms the decline was recorded (the orphan's arrival time when the decline preceded the record). Bounds the owed removal's age (`DECLINED_MARKER_MAX_AGE_MS`). */
  declinedAt?: number;
}

export type DeclinePhase = 'declined' | 'removing' | 'announce-pending';

export const PHASES: ReadonlySet<unknown> = new Set<DeclinePhase>(['declined', 'removing', 'announce-pending']);

/** A marker together with the group it belongs to (derived from the key, never stored twice). */
export interface PendingDirectInviteMarkerEntry {
  groupId: string;
  marker: PendingDirectInviteMarker;
}

/**
 * The record, or `undefined` for anything else (a legacy bare `true`, a record without `inviteeRef`, junk, a `phase`
 * outside `PHASES`: an unknown phase is an invalid marker, never silently coerced to `'declined'`).
 */
function parseMarker(value: unknown): PendingDirectInviteMarker | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { inviteeRef, pubkey, declined, leafKey, phase, declinedAt } = value as Record<string, unknown>;
  if (typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  if (typeof pubkey !== 'string' || pubkey === '') return undefined;
  if (typeof declined !== 'boolean') return undefined;
  const marker: PendingDirectInviteMarker = { inviteeRef, pubkey, declined };
  if (typeof leafKey === 'string' && leafKey !== '') marker.leafKey = leafKey;
  if (phase !== undefined) {
    if (!PHASES.has(phase)) return undefined;
    marker.phase = phase as DeclinePhase;
  }
  if (typeof declinedAt === 'number' && Number.isFinite(declinedAt)) marker.declinedAt = declinedAt;
  return marker;
}

/** The group part of a `${groupId}:${pubkey}` key (the pubkey is hex, so the LAST colon splits). */
function groupIdOfKey(key: string): string | undefined {
  const at = key.lastIndexOf(':');
  return at > 0 ? key.slice(0, at) : undefined;
}

/**
 * Records, at invite time, which `inviteeRef` the sponsor holds for (groupId, pubkey): marker
 * `{ inviteeRef, pubkey (lowercase), declined: false, leafKey? }`. Lets IDB errors propagate (the call site decides
 * best-effort). A second record for the same key replaces the first (a re-invite after a removal).
 *
 * An unconsumed ORPHAN decline of this very `(groupId, inviteeRef)` (the decline arrived before this record
 * landed) is consumed here: the marker starts `declined: true` and the returned marker says so, so the caller
 * can enqueue the removal. Resolves with the marker written.
 *
 * `invitedAt` (epoch ms, taken by the caller BEFORE the invite ran): an orphan is adopted only when it arrived at or
 * after it (`orphan.receivedAt >= invitedAt`); an older orphan of the same ref is a stale decline of an earlier
 * invite and is deleted unadopted. Absent: any live orphan is adopted.
 */
export async function recordPendingDirectInvite(
  groupId: string,
  pubkey: string,
  inviteeRef: string,
  leafKey?: string,
  invitedAt?: number,
): Promise<PendingDirectInviteMarker> {
  if (typeof groupId !== 'string' || groupId === '') throw new TypeError('recordPendingDirectInvite: groupId is required');
  if (typeof pubkey !== 'string' || pubkey === '') throw new TypeError('recordPendingDirectInvite: pubkey is required');
  if (typeof inviteeRef !== 'string' || inviteeRef === '') throw new TypeError('recordPendingDirectInvite: inviteeRef is required');
  const key = markerKey(groupId, pubkey);
  const marker: PendingDirectInviteMarker = { inviteeRef, pubkey: pubkey.toLowerCase(), declined: false };
  if (typeof leafKey === 'string' && leafKey !== '') marker.leafKey = leafKey;
  await serialisedOnKey(key, async () => {
    const orphanId = orphanKey(groupId, inviteeRef);
    const orphan = parseOrphan(await get(orphanId, orphanStore));
    const adopted =
      orphan !== undefined &&
      Date.now() - orphan.receivedAt <= ORPHAN_TTL_MS &&
      (invitedAt === undefined || orphan.receivedAt >= invitedAt);
    if (adopted && orphan) {
      marker.declined = true;
      marker.declinedAt = orphan.receivedAt;
    }
    await set(key, marker, pendingInviteMarkerStore);
    if (orphan !== undefined) await del(orphanId, orphanStore);
    return true;
  });
  return { ...marker };
}

// ---------------------------------------------------------------------------
// Orphan declines: a `welcomeDeclined` whose inviteeRef no marker carries (yet)
// ---------------------------------------------------------------------------

/** A decline that arrived before (or without) its invite-time record. */
export interface DeclineOrphan {
  groupId: string;
  inviteeRef: string;
  /** Epoch ms. */
  receivedAt: number;
}

/** Orphans older than this are dropped. */
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many orphans are kept (oldest dropped first). */
export const ORPHAN_MAX = 50;

const orphanStore = createStore('few-pending-invite-orphans', 'orphans');

/** `${groupId}:${inviteeRef}`: the groupId is hex, so the FIRST colon splits. */
const orphanKey = (groupId: string, inviteeRef: string): string => `${groupId}:${inviteeRef}`;

function parseOrphan(value: unknown): DeclineOrphan | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { groupId, inviteeRef, receivedAt } = value as Record<string, unknown>;
  if (typeof groupId !== 'string' || groupId === '' || typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return undefined;
  return { groupId, inviteeRef, receivedAt };
}

/** Persists an orphan decline (bounded: expired ones dropped, then the oldest beyond `ORPHAN_MAX`). */
export async function recordOrphanDecline(groupId: string, inviteeRef: string): Promise<void> {
  const now = Date.now();
  await set(orphanKey(groupId, inviteeRef), { groupId, inviteeRef, receivedAt: now } satisfies DeclineOrphan, orphanStore);
  const kept: Array<[string, DeclineOrphan]> = [];
  for (const [key, value] of await entries<string, unknown>(orphanStore)) {
    const orphan = parseOrphan(value);
    if (!orphan || now - orphan.receivedAt > ORPHAN_TTL_MS) await del(key, orphanStore);
    else kept.push([String(key), orphan]);
  }
  kept.sort((a, b) => a[1].receivedAt - b[1].receivedAt);
  for (const [key] of kept.slice(0, Math.max(0, kept.length - ORPHAN_MAX))) await del(key, orphanStore);
}

/** The live (unexpired) orphan declines, oldest first. */
export async function loadOrphanDeclines(): Promise<DeclineOrphan[]> {
  const now = Date.now();
  const out: DeclineOrphan[] = [];
  for (const [, value] of await entries<string, unknown>(orphanStore)) {
    const orphan = parseOrphan(value);
    if (orphan && now - orphan.receivedAt <= ORPHAN_TTL_MS) out.push(orphan);
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt);
}

/** The marker record of (groupId, pubkey), or `undefined` when absent or legacy-shaped. */
export async function getPendingDirectInviteMarker(
  groupId: string,
  pubkey: string,
): Promise<PendingDirectInviteMarker | undefined> {
  return parseMarker(await get(markerKey(groupId, pubkey), pendingInviteMarkerStore));
}

/**
 * Durably marks the invite of `inviteeRef` in `groupId` as declined and returns its entry. When no record-shaped
 * marker of that group carries this ref (an unknown ref, or only legacy markers) nothing is marked: the decline
 * is persisted as an ORPHAN (`recordOrphanDecline`; a later `recordPendingDirectInvite` of that ref consumes it
 * and starts declined) and `undefined` is returned. Idempotent: an already-declined marker is returned unchanged.
 * The read-modify-write runs serialised on the key (never idb-keyval `update()`), and re-reads the key right
 * before writing so a marker cleared meanwhile is never resurrected.
 */
export async function markPendingDirectInviteDeclined(
  groupId: string,
  inviteeRef: string,
): Promise<PendingDirectInviteMarkerEntry | undefined> {
  if (typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  const hit = await markMatchingDeclined(groupId, inviteeRef);
  if (hit) return hit;
  await recordOrphanDecline(groupId, inviteeRef);
  // A record may have landed between the scan and the orphan write (it then saw no orphan): look once more.
  const late = await markMatchingDeclined(groupId, inviteeRef);
  if (late) await del(orphanKey(groupId, inviteeRef), orphanStore);
  return late;
}

async function markMatchingDeclined(groupId: string, inviteeRef: string): Promise<PendingDirectInviteMarkerEntry | undefined> {
  const prefix = `${groupId}:`;
  const all = await entries<string, unknown>(pendingInviteMarkerStore);
  for (const [key, value] of all) {
    if (!key.startsWith(prefix)) continue;
    const found = parseMarker(value);
    if (!found || found.inviteeRef !== inviteeRef) continue;
    let result: PendingDirectInviteMarkerEntry | undefined;
    await serialisedOnKey(key, async () => {
      const current = parseMarker(await get(key, pendingInviteMarkerStore));
      if (!current || current.inviteeRef !== inviteeRef) return false;
      const next: PendingDirectInviteMarker = current.declined ? current : { ...current, declined: true, declinedAt: Date.now() };
      if (!current.declined) await set(key, next, pendingInviteMarkerStore);
      result = { groupId, marker: next };
      return true;
    });
    return result;
  }
  return undefined;
}

/**
 * Compare-and-set of the removal phase: only while the marker of (groupId, pubkey) is still declined AND carries
 * `inviteeRef` (a re-invite replaced it, or it was cleared: nothing written). Serialised on the key.
 */
export async function setPendingDirectInvitePhase(
  groupId: string,
  pubkey: string,
  inviteeRef: string,
  phase: DeclinePhase,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, async () => {
    const current = parseMarker(await get(key, pendingInviteMarkerStore));
    if (!current || !current.declined || current.inviteeRef !== inviteeRef) return false;
    await set(key, { ...current, phase }, pendingInviteMarkerStore);
    return true;
  });
}

/**
 * Compare-and-clear: removes the marker of (groupId, pubkey) only while it is a record carrying `inviteeRef`
 * (a newer invite's marker, a legacy marker, or an absent one are left alone). Serialised on the key.
 * Resolves whether a marker was removed.
 */
export async function clearPendingDirectInviteIfRef(
  groupId: string,
  pubkey: string,
  inviteeRef: string,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, async () => {
    const current = parseMarker(await get(key, pendingInviteMarkerStore));
    if (!current || current.inviteeRef !== inviteeRef) return false;
    await del(key, pendingInviteMarkerStore);
    return true;
  });
}

/**
 * Every marker record with `declined: true`, across groups (startup retry). Legacy-shaped values are skipped
 * silently; a record-shaped value whose `phase` is outside `PHASES` is invalid: skipped too, and handed to
 * `onInvalid` (key, phase) so the caller can report it.
 */
export async function loadDeclinedPendingDirectInvites(
  onInvalid?: (key: string, phase: unknown) => void,
): Promise<PendingDirectInviteMarkerEntry[]> {
  const all = await entries<string, unknown>(pendingInviteMarkerStore);
  const out: PendingDirectInviteMarkerEntry[] = [];
  for (const [key, value] of all) {
    const marker = parseMarker(value);
    if (!marker && typeof value === 'object' && value !== null) {
      const { phase } = value as Record<string, unknown>;
      if (phase !== undefined && !PHASES.has(phase)) onInvalid?.(String(key), phase);
    }
    const groupId = groupIdOfKey(String(key));
    if (marker?.declined && groupId) out.push({ groupId, marker });
  }
  return out;
}

/** The marker store as the decline-durability module consumes it (injected there, validated at construction). */
export interface DeclineMarkerStore {
  record: typeof recordPendingDirectInvite;
  get: typeof getPendingDirectInviteMarker;
  markDeclined: typeof markPendingDirectInviteDeclined;
  listDeclined: typeof loadDeclinedPendingDirectInvites;
  setPhase: typeof setPendingDirectInvitePhase;
  clearIfRef: typeof clearPendingDirectInviteIfRef;
}

/** The real, idb-backed `DeclineMarkerStore`. */
export const pendingDirectInviteMarkerStore: DeclineMarkerStore = {
  record: recordPendingDirectInvite,
  get: getPendingDirectInviteMarker,
  markDeclined: markPendingDirectInviteDeclined,
  listDeclined: loadDeclinedPendingDirectInvites,
  setPhase: setPendingDirectInvitePhase,
  clearIfRef: clearPendingDirectInviteIfRef,
};

// ---------------------------------------------------------------------------
// Bulk clear entrypoints (AC-MARKER-9) — two distinct exports, not one
// function overloaded on an optional/sentinel groupId argument.
// ---------------------------------------------------------------------------

/**
 * Clear every marker scoped to exactly one group, leaving markers for every
 * other group untouched. Consumed by S3's leaveGroupImpl per-group leave
 * fan-out (AC-MARKER-9's leave-fan-out half).
 */
export async function clearPendingDirectInvitesForGroup(
  groupId: string,
): Promise<void> {
  const all = await entries<string, unknown>(pendingInviteMarkerStore);
  const prefix = `${groupId}:`;
  await Promise.all(
    all
      .filter(([key]) => key.startsWith(prefix))
      .map(([key]) => serialisedOnKey(String(key), async () => {
        await del(key, pendingInviteMarkerStore);
        return true;
      })),
  );
  const orphans = await entries<string, unknown>(orphanStore);
  await Promise.all(orphans.filter(([key]) => String(key).startsWith(prefix)).map(([key]) => del(key, orphanStore)));
}

/**
 * Clear every marker across every group (and every orphan decline). Consumed by S2's clearAllGroupData
 * account-reset composition root (AC-MARKER-9's account-reset half). Per-key deletes run on the key chain
 * (an in-flight serialised step finishes first), then the stores are dropped whole.
 */
export async function clearAllPendingDirectInvites(): Promise<void> {
  const all = await entries<string, unknown>(pendingInviteMarkerStore);
  await Promise.all(
    all.map(([key]) => serialisedOnKey(String(key), async () => {
      await del(key, pendingInviteMarkerStore);
      return true;
    })),
  );
  await clear(pendingInviteMarkerStore);
  await clear(orphanStore);
}
