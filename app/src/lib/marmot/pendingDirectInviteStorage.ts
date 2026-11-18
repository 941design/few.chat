/**
 * Stores pending direct invite markers keyed by group and invitee account.
 * The invite reference matches the library's decline event. Per-key
 * serialization protects updates and compare-and-clear writes.
 */

import { createStore, get, getMany, set, del, delMany, entries, clear, promisifyRequest } from 'idb-keyval';

// ---------------------------------------------------------------------------
// IDB store
// ---------------------------------------------------------------------------

const pendingInviteMarkerStore = createStore(
  'few-pending-invite-markers',
  'markers',
);

// Array keys keep owed notices separate from the roster's string-keyed markers
// while allowing an atomic handoff within the same IDB object store.
type InviteRefKey = [groupId: string, inviteeRef: string] | [groupId: string, inviteeRef: string, sponsorPubkey: string];
const announcementKey = (groupId: string, inviteeRef: string, sponsorPubkey?: string): InviteRefKey =>
  sponsorPubkey === undefined ? [groupId, inviteeRef] : [groupId, inviteeRef, sponsorPubkey];
type InviteStoreKey = string | InviteRefKey;

/** Read and change rows in one transaction, including across sessions with different account leases. */
function changeInviteRows(
  keys: [InviteStoreKey, ...InviteStoreKey[]],
  change: (store: IDBObjectStore, rows: unknown[]) => boolean,
): Promise<boolean> {
  return pendingInviteMarkerStore('readwrite', (store) => {
    const reads = keys.map((key) => store.get(key));
    let changed = false;
    // The requests complete in order, and the transaction is active in this callback.
    reads[reads.length - 1].onsuccess = () => { changed = change(store, reads.map((read) => read.result)); };
    return promisifyRequest(store.transaction).then(() => changed);
  });
}

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

/** Clears a marker following explicit removal or a reset. */
export async function clearPendingDirectInvite(groupId: string, pubkey: string): Promise<void> {
  const key = markerKey(groupId, pubkey);
  await serialisedOnKey(key, async () => {
    await del(key, pendingInviteMarkerStore);
    return true;
  });
}

/** A forwarded profile affects the roster display but does not prove the invitee joined. */
export async function noteForwardedInviteProfile(groupId: string, pubkey: string, sponsorPubkey?: string): Promise<void> {
  const key = markerKey(groupId, pubkey);
  await serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
    const marker = parseMarker(value);
    if (!matchesSponsor(marker, sponsorPubkey) || marker.profileForwarded) return false;
    store.put({ ...marker, profileForwarded: true }, key);
    return true;
  }));
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
  const all = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  const prefix = `${groupId}:`;
  const pubkeys = all
    .flatMap(([key]) => typeof key === 'string' && key.startsWith(prefix) ? [key.slice(prefix.length)] : []);
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
 * A step awaits the previous one on the same key. This also orders work spanning multiple transactions,
 * such as recording a marker and consuming an orphan. IDB transactions protect the individual marker
 * changes across tabs. A rejected step leaves the next step free to run.
 *
 * SERIALISED on this chain: consumePendingDirectInviteMarker, clearPendingDirectInvite,
 * recordPendingDirectInvite, markPendingDirectInviteDeclined,
 * setPendingDirectInvitePhase, clearPendingDirectInviteIfRef, clearDeclineAnnouncement,
 * clearPendingDirectInvitesForGroup (per marker key).
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

/** Clears a valid invite marker and reports whether a direct invite was accepted. */
export async function consumePendingDirectInviteMarker(
  groupId: string,
  pubkey: string,
  sponsorPubkey?: string,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
    const marker = parseMarker(value);
    if (!matchesSponsor(marker, sponsorPubkey) || marker.declined) return false;
    store.delete(key);
    return !marker.viaJoinRequest && !marker.profileForwarded;
  }));
}

// ---------------------------------------------------------------------------
// Decline durability (S11, D7): the marker record
// ---------------------------------------------------------------------------

/** Seam `PendingDirectInviteMarker`: what is stored per (group, invitee) from invite time on. */
interface PendingDirectInviteMarker {
  /** The library's invite reference (`WelcomeOutcome.inviteeRef`): what `welcomeDeclined` carries. */
  inviteeRef: string;
  /** The invitee account, lowercase hex. */
  pubkey: string;
  /** The sponsor that owns the reference and any resulting decline notice. */
  sponsorPubkey?: string;
  /** True once the invitee's decline arrived: the sponsor still owes the Remove commit. */
  declined: boolean;
  /** Join approvals record declines without offering cancellation or posting a direct-invite acceptance. */
  viaJoinRequest?: true;
  profileForwarded?: true;
  /**
   * The signature key (hex) of the leaf the invite added, derived at invite time from the accepted KeyPackage. Replay requires a matching leaf before it can remove a member.
   */
  leafKey?: string;
  invitedAt?: number;
  /**
   * Progress of an owed removal (only meaningful when `declined`); absent = `'declined'`:
   * `'declined'` nothing done yet; `'removing'` the Remove commit was started (it may or may not have landed);
   * `'announce-pending'` the Remove resolved, the `declined` announcement is still owed.
   */
  phase?: DeclinePhase;
  /** Epoch ms the decline was recorded (the orphan's arrival time when the decline preceded the record). Bounds the owed removal's age (`DECLINED_MARKER_MAX_AGE_MS`). */
  declinedAt?: number;
}

type DeclinePhase = 'declined' | 'removing' | 'announce-pending';

export const PHASES: ReadonlySet<unknown> = new Set<DeclinePhase>(['declined', 'removing', 'announce-pending']);

/** A marker together with the group it belongs to (derived from the key, never stored twice). */
interface PendingDirectInviteMarkerEntry {
  groupId: string;
  marker: PendingDirectInviteMarker;
}

interface DeclineReplay {
  marker: PendingDirectInviteMarker;
  archived: boolean;
}

/**
 * The record, or `undefined` for anything else (a legacy bare `true`, a record without `inviteeRef`, junk, a `phase`
 * outside `PHASES`: an unknown phase is an invalid marker, never silently coerced to `'declined'`).
 */
function parseMarker(value: unknown): PendingDirectInviteMarker | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { inviteeRef, pubkey, declined, leafKey, phase, declinedAt, viaJoinRequest, invitedAt, profileForwarded } = value as Record<string, unknown>;
  if (typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  if (typeof pubkey !== 'string' || pubkey === '') return undefined;
  if (typeof declined !== 'boolean') return undefined;
  const marker: PendingDirectInviteMarker = { inviteeRef, pubkey, declined };
  const sponsorPubkey = storedSponsor(value);
  if (sponsorPubkey !== undefined) marker.sponsorPubkey = sponsorPubkey;
  if (viaJoinRequest === true) marker.viaJoinRequest = true;
  if (profileForwarded === true) marker.profileForwarded = true;
  if (typeof invitedAt === 'number' && Number.isFinite(invitedAt)) marker.invitedAt = invitedAt;
  if (typeof leafKey === 'string' && leafKey !== '') marker.leafKey = leafKey;
  if (phase !== undefined) {
    if (!PHASES.has(phase)) return undefined;
    marker.phase = phase as DeclinePhase;
  }
  if (typeof declinedAt === 'number' && Number.isFinite(declinedAt)) marker.declinedAt = declinedAt;
  return marker;
}

function storedSponsor(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const sponsor = (value as Record<string, unknown>).sponsorPubkey;
  return typeof sponsor === 'string' && sponsor !== '' ? sponsor.toLowerCase() : undefined;
}

function parseAnnouncement(value: unknown, sponsorPubkey?: string): PendingDirectInviteMarker | undefined {
  const marker = parseMarker(value);
  return marker?.declined && marker.phase === 'announce-pending' && marker.sponsorPubkey === sponsorPubkey ? marker : undefined;
}

function matchesSponsor(marker: PendingDirectInviteMarker | undefined, sponsorPubkey?: string): marker is PendingDirectInviteMarker {
  return marker !== undefined && (sponsorPubkey === undefined || marker.sponsorPubkey === sponsorPubkey);
}

function sameDecline(current: PendingDirectInviteMarker, expected: PendingDirectInviteMarker, archived = false): boolean {
  return current.pubkey === expected.pubkey && current.sponsorPubkey === expected.sponsorPubkey &&
    current.inviteeRef === expected.inviteeRef && current.invitedAt === expected.invitedAt &&
    current.leafKey === expected.leafKey && (current.declinedAt === expected.declinedAt || (archived && expected.declinedAt === undefined));
}

/** The group part of a `${groupId}:${pubkey}` key (the pubkey is hex, so the LAST colon splits). */
function groupIdOfKey(key: string): string | undefined {
  const at = key.lastIndexOf(':');
  return at > 0 ? key.slice(0, at) : undefined;
}

/**
 * Records, at invite time, which `inviteeRef` the sponsor holds for (groupId, pubkey): marker
 * `{ inviteeRef, pubkey (lowercase), declined: false, leafKey? }`. Lets IDB errors propagate (the call site decides
 * best-effort). A re-invite replaces the current marker and atomically saves any owed announcement by reference.
 * `removingBeforeInvite` carries the earlier marker when a successful queued Add verified account leaf absence.
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
  viaJoinRequest = false,
  options: { sponsorPubkey?: string; removingBeforeInvite?: PendingDirectInviteMarker } = {},
): Promise<PendingDirectInviteMarker> {
  if (typeof groupId !== 'string' || groupId === '') throw new TypeError('recordPendingDirectInvite: groupId is required');
  if (typeof pubkey !== 'string' || pubkey === '') throw new TypeError('recordPendingDirectInvite: pubkey is required');
  if (typeof inviteeRef !== 'string' || inviteeRef === '') throw new TypeError('recordPendingDirectInvite: inviteeRef is required');
  const key = markerKey(groupId, pubkey);
  const sponsorPubkey = options.sponsorPubkey?.toLowerCase();
  const marker: PendingDirectInviteMarker = { inviteeRef, pubkey: pubkey.toLowerCase(), declined: false };
  if (sponsorPubkey !== undefined) marker.sponsorPubkey = sponsorPubkey;
  if (viaJoinRequest) marker.viaJoinRequest = true;
  if (invitedAt !== undefined) marker.invitedAt = invitedAt;
  if (typeof leafKey === 'string' && leafKey !== '') marker.leafKey = leafKey;
  await serialisedOnKey(key, async () => {
    const orphanId = orphanKey(groupId, inviteeRef, sponsorPubkey);
    const orphan = parseOrphan(await get(orphanId, orphanStore));
    const adopted =
      orphan !== undefined &&
      Date.now() - orphan.receivedAt <= ORPHAN_TTL_MS &&
      (invitedAt === undefined || orphan.receivedAt >= invitedAt);
    if (adopted && orphan) {
      marker.declined = true;
      marker.declinedAt = orphan.receivedAt;
    }
    await changeInviteRows([key], (store, [value]) => {
      const previous = parseMarker(value);
      const before = options.removingBeforeInvite;
      // An already owed notice keeps its original sponsor. Only the sponsor of a
      // matching removing marker may turn its own successful Add into recovery evidence.
      const recovered = previous?.phase === 'removing' && before?.phase === 'removing' &&
        previous.sponsorPubkey === sponsorPubkey && sameDecline(previous, before);
      store.put(marker, key);
      if (previous?.declined && (previous.sponsorPubkey !== undefined || sponsorPubkey === undefined) &&
        (previous.phase === 'announce-pending' || recovered)) {
        store.put({ ...previous, phase: 'announce-pending', declinedAt: previous.declinedAt ?? previous.invitedAt ?? Date.now() },
          announcementKey(groupId, previous.inviteeRef, previous.sponsorPubkey));
      }
      return true;
    });
    if (orphan !== undefined) await del(orphanId, orphanStore);
    return true;
  });
  return { ...marker };
}

// ---------------------------------------------------------------------------
// Orphan declines: a `welcomeDeclined` whose inviteeRef no marker carries (yet)
// ---------------------------------------------------------------------------

/** A decline that arrived before (or without) its invite-time record. */
interface DeclineOrphan {
  groupId: string;
  inviteeRef: string;
  /** Epoch ms. */
  receivedAt: number;
}

/** Orphans older than this are dropped. */
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many orphans are kept per sponsor (oldest dropped first). */
export const ORPHAN_MAX = 50;

const orphanStore = createStore('few-pending-invite-orphans', 'orphans');

/** Scoped orphans use the sponsor and reference. Unscoped callers keep the original string key. */
const orphanKey = (groupId: string, inviteeRef: string, sponsorPubkey?: string): InviteStoreKey =>
  sponsorPubkey === undefined ? `${groupId}:${inviteeRef}` : announcementKey(groupId, inviteeRef, sponsorPubkey);

function parseOrphan(value: unknown): DeclineOrphan | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { groupId, inviteeRef, receivedAt } = value as Record<string, unknown>;
  if (typeof groupId !== 'string' || groupId === '' || typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return undefined;
  return { groupId, inviteeRef, receivedAt };
}

/** Persists an orphan decline (bounded: expired ones dropped, then the oldest beyond `ORPHAN_MAX`). */
export async function recordOrphanDecline(groupId: string, inviteeRef: string, receivedAt = Date.now(), sponsorPubkey?: string): Promise<void> {
  const now = Date.now();
  await set(orphanKey(groupId, inviteeRef, sponsorPubkey), { groupId, inviteeRef, receivedAt } satisfies DeclineOrphan, orphanStore);
  const kept: Array<[InviteStoreKey, DeclineOrphan]> = [];
  for (const [key, value] of await entries<InviteStoreKey, unknown>(orphanStore)) {
    if ((Array.isArray(key) ? key[2] : undefined) !== sponsorPubkey) continue;
    const orphan = parseOrphan(value);
    if (!orphan || now - orphan.receivedAt > ORPHAN_TTL_MS) await del(key, orphanStore);
    else kept.push([key, orphan]);
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
  sponsorPubkey?: string,
): Promise<PendingDirectInviteMarker | undefined> {
  const marker = parseMarker(await get(markerKey(groupId, pubkey), pendingInviteMarkerStore));
  return matchesSponsor(marker, sponsorPubkey) ? marker : undefined;
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
  sponsorPubkey?: string,
): Promise<PendingDirectInviteMarkerEntry | undefined> {
  if (typeof inviteeRef !== 'string' || inviteeRef === '') return undefined;
  const receivedAt = Date.now();
  const hit = await markMatchingDeclined(groupId, inviteeRef, receivedAt, sponsorPubkey);
  if (hit) return hit;
  const owed = parseAnnouncement(await get(announcementKey(groupId, inviteeRef, sponsorPubkey), pendingInviteMarkerStore), sponsorPubkey);
  if (owed?.inviteeRef === inviteeRef) return { groupId, marker: owed };
  await recordOrphanDecline(groupId, inviteeRef, receivedAt, sponsorPubkey);
  // A record may have landed after the first scan and before the orphan write.
  const late = await markMatchingDeclined(groupId, inviteeRef, receivedAt, sponsorPubkey);
  if (late) await del(orphanKey(groupId, inviteeRef, sponsorPubkey), orphanStore);
  return late;
}

async function markMatchingDeclined(groupId: string, inviteeRef: string, receivedAt: number, sponsorPubkey?: string): Promise<PendingDirectInviteMarkerEntry | undefined> {
  const prefix = `${groupId}:`;
  const all = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  for (const [key, value] of all) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    const found = parseMarker(value);
    if (!matchesSponsor(found, sponsorPubkey) || found.inviteeRef !== inviteeRef) continue;
    let result: PendingDirectInviteMarkerEntry | undefined;
    await serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
      const current = parseMarker(value);
      if (!matchesSponsor(current, sponsorPubkey) || current.inviteeRef !== inviteeRef || (current.invitedAt !== undefined && current.invitedAt > receivedAt)) return false;
      const next: PendingDirectInviteMarker = current.declined ? current : { ...current, declined: true, declinedAt: receivedAt };
      if (!current.declined) store.put(next, key);
      result = { groupId, marker: next };
      return true;
    }));
    return result;
  }
  return undefined;
}

/** Read both locations in one snapshot so a concurrent re-invite cannot hide the handoff. */
async function getDeclinedInvite(groupId: string, pubkey: string, inviteeRef: string, sponsorPubkey?: string): Promise<DeclineReplay | undefined> {
  const [owed, live] = await getMany<unknown>([announcementKey(groupId, inviteeRef, sponsorPubkey), markerKey(groupId, pubkey)], pendingInviteMarkerStore);
  const announcement = parseAnnouncement(owed, sponsorPubkey);
  if (announcement?.pubkey === pubkey && announcement.inviteeRef === inviteeRef) return { marker: announcement, archived: true };
  const marker = parseMarker(live);
  return matchesSponsor(marker, sponsorPubkey) && marker.declined && marker.inviteeRef === inviteeRef ? { marker, archived: false } : undefined;
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
  sponsorPubkey?: string,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
    const current = parseMarker(value);
    if (!matchesSponsor(current, sponsorPubkey) || !current.declined || current.inviteeRef !== inviteeRef) return false;
    store.put({ ...current, phase }, key);
    return true;
  }));
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
  sponsorPubkey?: string,
): Promise<boolean> {
  const key = markerKey(groupId, pubkey);
  return serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
    const current = parseMarker(value);
    if (!matchesSponsor(current, sponsorPubkey) || current.inviteeRef !== inviteeRef) return false;
    store.delete(key);
    return true;
  }));
}

/** Acknowledge or expire the owed notice wherever it lives, serialised with re-invites of this account. */
async function clearDeclineAnnouncement(groupId: string, replay: DeclineReplay, sponsorPubkey?: string): Promise<boolean> {
  const { pubkey, inviteeRef } = replay.marker;
  if (!matchesSponsor(replay.marker, sponsorPubkey)) return false;
  const key = markerKey(groupId, pubkey);
  const owedKey = announcementKey(groupId, inviteeRef, replay.marker.sponsorPubkey);
  return serialisedOnKey(key, () => changeInviteRows([owedKey, key], (store, [owed, live]) => {
    const announcement = parseAnnouncement(owed, replay.marker.sponsorPubkey);
    if (announcement && sameDecline(announcement, replay.marker, true)) {
      store.delete(owedKey);
      return true;
    }
    if (replay.archived) return false;
    const marker = parseMarker(live);
    if (!marker?.declined || !sameDecline(marker, replay.marker)) return false;
    store.delete(key);
    return true;
  }));
}

/**
 * Every declined marker and owed notice, across groups (startup retry). Legacy-shaped values are skipped
 * silently; a record-shaped value whose `phase` is outside `PHASES` is invalid: skipped too, and handed to
 * `onInvalid` (key, phase) so the caller can report it.
 */
export async function loadDeclinedPendingDirectInvites(
  onInvalid?: (key: string, phase: unknown) => void,
  sponsorPubkey?: string,
): Promise<PendingDirectInviteMarkerEntry[]> {
  const all = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  const out = new Map<string, PendingDirectInviteMarkerEntry>();
  for (const [key, value] of all) {
    const marker = typeof key === 'string' ? parseMarker(value) : parseAnnouncement(value, key[2]);
    if (!marker && typeof value === 'object' && value !== null) {
      const { phase } = value as Record<string, unknown>;
      if (phase !== undefined && !PHASES.has(phase)) onInvalid?.(String(key), phase);
    }
    const groupId = typeof key === 'string' ? groupIdOfKey(key) : key[0];
    if (matchesSponsor(marker, sponsorPubkey) && marker.declined && groupId) {
      out.set(JSON.stringify(announcementKey(groupId, marker.inviteeRef, marker.sponsorPubkey)), { groupId, marker });
    }
  }
  return [...out.values()];
}

/** The marker store as the decline-durability module consumes it (injected there, validated at construction). */
export interface DeclineMarkerStore {
  record: typeof recordPendingDirectInvite;
  get: typeof getPendingDirectInviteMarker;
  getDeclined: typeof getDeclinedInvite;
  markDeclined: typeof markPendingDirectInviteDeclined;
  listDeclined: typeof loadDeclinedPendingDirectInvites;
  setPhase: typeof setPendingDirectInvitePhase;
  clearIfRef: typeof clearPendingDirectInviteIfRef;
  clearAnnouncement: typeof clearDeclineAnnouncement;
}

/** The real, idb-backed `DeclineMarkerStore`. */
export const pendingDirectInviteMarkerStore: DeclineMarkerStore = {
  record: recordPendingDirectInvite,
  get: getPendingDirectInviteMarker,
  getDeclined: getDeclinedInvite,
  markDeclined: markPendingDirectInviteDeclined,
  listDeclined: loadDeclinedPendingDirectInvites,
  setPhase: setPendingDirectInvitePhase,
  clearIfRef: clearPendingDirectInviteIfRef,
  clearAnnouncement: clearDeclineAnnouncement,
};

/** Production sessions handle only their own references. Origin-less rows are never adopted. */
export function createSponsorDeclineMarkerStore(pubkey: string): DeclineMarkerStore {
  const sponsor = pubkey.toLowerCase();
  return {
    record: (groupId, invitee, ref, leaf, at, via, options) =>
      recordPendingDirectInvite(groupId, invitee, ref, leaf, at, via, { ...options, sponsorPubkey: sponsor }),
    get: (groupId, invitee) => getPendingDirectInviteMarker(groupId, invitee, sponsor),
    getDeclined: (groupId, invitee, ref) => getDeclinedInvite(groupId, invitee, ref, sponsor),
    markDeclined: (groupId, ref) => markPendingDirectInviteDeclined(groupId, ref, sponsor),
    listDeclined: (onInvalid) => loadDeclinedPendingDirectInvites(onInvalid, sponsor),
    setPhase: (groupId, invitee, ref, phase) => setPendingDirectInvitePhase(groupId, invitee, ref, phase, sponsor),
    clearIfRef: (groupId, invitee, ref) => clearPendingDirectInviteIfRef(groupId, invitee, ref, sponsor),
    clearAnnouncement: (groupId, replay) => clearDeclineAnnouncement(groupId, replay, sponsor),
  };
}

// ---------------------------------------------------------------------------
// Bulk clear entrypoints (AC-MARKER-9) — two distinct exports, not one
// function overloaded on an optional/sentinel groupId argument.
// ---------------------------------------------------------------------------

/**
 * Clear every pending direct invite marker and owed notice for the specified group.
 */
export async function clearPendingDirectInvitesForGroup(
  groupId: string,
  sponsorPubkey?: string,
): Promise<void> {
  const sponsor = sponsorPubkey?.toLowerCase();
  await clearInviteData(groupId, (owner) => sponsor === undefined || owner === undefined || owner === sponsor);
}

/** Clear owned state even for a shared group or a group with no remaining overlay. */
export async function clearSponsorPendingDirectInvites(pubkey: string, groupId?: string): Promise<void> {
  const sponsor = pubkey.toLowerCase();
  await clearInviteData(groupId, (owner) => owner === sponsor);
}

async function clearInviteData(groupId: string | undefined, includesOwner: (owner?: string) => boolean): Promise<void> {
  const includesGroup = (id?: string) => groupId === undefined || id === groupId;
  const all = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  await Promise.all(all.flatMap(([key, value]) => typeof key === 'string' && includesGroup(groupIdOfKey(key)) && includesOwner(storedSponsor(value))
    ? [serialisedOnKey(key, () => changeInviteRows([key], (store, [value]) => {
      if (!includesOwner(storedSponsor(value))) return false;
      store.delete(key);
      return true;
    }))] : []));
  // A re-invite ahead of a marker delete on its chain can have moved a notice.
  const remaining = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  const owed = remaining.flatMap(([key]) => Array.isArray(key) && includesGroup(key[0]) && includesOwner(key[2]) ? [key] : []);
  if (owed.length > 0) await delMany(owed, pendingInviteMarkerStore);
  const orphans = await entries<InviteStoreKey, unknown>(orphanStore);
  const stale = orphans.flatMap<InviteStoreKey>(([key]) => {
    if (typeof key === 'string') return includesOwner(undefined) && (groupId === undefined || key.startsWith(`${groupId}:`)) ? [key] : [];
    return includesGroup(key[0]) && includesOwner(key[2]) ? [key] : [];
  });
  if (stale.length > 0) await delMany(stale, orphanStore);
}

/** A device reset clears both stores. An account reset clears that sponsor's records and legacy rows. */
export async function clearAllPendingDirectInvites(sponsorPubkey?: string): Promise<void> {
  if (sponsorPubkey !== undefined) {
    const sponsor = sponsorPubkey.toLowerCase();
    await clearInviteData(undefined, (owner) => owner === undefined || owner === sponsor);
    return;
  }
  const all = await entries<InviteStoreKey, unknown>(pendingInviteMarkerStore);
  await Promise.all(
    all.flatMap(([key]) => typeof key === 'string' ? [serialisedOnKey(key, async () => {
      await del(key, pendingInviteMarkerStore);
      return true;
    })] : []),
  );
  await clear(pendingInviteMarkerStore);
  await clear(orphanStore);
}
