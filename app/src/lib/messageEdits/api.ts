/**
 * Reconciliation core — Seam S3 producer (ChangeResult).
 *
 * React-free and context-free: imports chatPersistence, S2's
 * DELETE_EDIT_RUMOR_KIND constant, idb-keyval, and (as of S8,
 * epic-group-invite-lifecycle) the shared `isInformativeAnnouncementContent`
 * predicate (`lib/marmot/announcementFamily.ts`, itself only a thin
 * `parseStructured` consumer — no React, no context). Never imports
 * app/src/context/, react, or app/src/components/. Both a React component
 * (ContactChat.tsx, DM) and a non-React dispatcher handler
 * (deleteEditHandler.ts, group) call this module directly (architecture.md
 * boundary rule).
 *
 * ─── S8 (DD-11): the announcement-immutability gate + admin carve-out ─────
 *
 * Every apply site — the direct known-row branch below, the buffered
 * `resolveKnownRowAgainstStores` path, and the TTL-expiry
 * `persistExpiredEntryEffect` path (both its known-row and no-known-row
 * branches) — consults the SAME two decision functions:
 * `authorizeDeleteAgainstTarget` (AC-IMMUT-4/5: a delete/tombstone against a
 * GROUP-thread announcement is honored iff the signal's sender is a current
 * admin; against an ordinary message, the pre-existing own-author rule is
 * unchanged) and `isEditAuthorizedByAnnouncementGate` (AC-IMMUT-6/7: an edit
 * is rejected outright when EITHER the target's current content OR the
 * edit's own replacement content is a GROUP-thread announcement, admin or
 * not — edit never gets the delete's admin carve-out). "GROUP-thread" scoping
 * mirrors S7's `isGroupContext` UI carve-out (`messageActionUi.ts`): a DM
 * thread has no admin concept and no shared announcement history, so a DM's
 * own informative-announcement-shaped message (e.g. `call_notice`) keeps its
 * pre-S8 own-author-deletable/editable behavior unchanged — this gate never
 * fires for a `dm:`-prefixed threadKey (`isGroupThreadKey`).
 *
 * Admin lookup is a REGISTERED PROVIDER (`registerGroupAdminsProvider`), not
 * a threaded function parameter, because `applyDeleteEditSignal` /
 * `resolvePendingSignalsForSlot` are this module's frozen public seam,
 * called from many existing call sites (DM + group, React + non-React —
 * ContactChat.tsx, directMessages.ts, chatHandler.ts, deleteEditHandler.ts)
 * that architecture.md's declared boundary keeps decoupled from group/admin
 * state. Adding a required parameter would ripple across every one of those
 * call sites, far outside this story's declared scope
 * (messageEdits/api.ts, marmot/chatPersistence.ts, context/ChatStoreContext.tsx).
 * A settable module-level singleton, registered ONCE by the composition root
 * (MarmotContext.tsx — an authorized external port, mirroring S3's
 * send-capability-injection precedent), lets every existing call site keep
 * calling the unchanged public signature while the gate still resolves live
 * admin state at apply time. Fail-closed (VQ-S8-006): no registered
 * provider, a DM thread, or a provider that throws/rejects all resolve to an
 * EMPTY admin set — never "everyone is admin". An empty result denies the
 * admin carve-out (AC-IMMUT-5) but still correctly rejects a non-admin
 * delete (AC-IMMUT-4), the safe default.
 *
 * Public surface:
 *   - applyDeleteEditSignal(thread, rumor)              — the frozen seam entrypoint
 *   - resolvePendingSignalsForSlot(thread, slotId, pk)  — deferred-authorization hook
 *   - PENDING_SIGNAL_CAP / PENDING_SIGNAL_TTL_MS / MAX_REV_SKEW_SECONDS
 *   - clearAllMessageEditsState()                        — account-switch hygiene
 *   - clearMessageEditsStateForThread(threadKey)         — per-thread teardown hygiene
 *     (round-2 remediation finding 5), wired into chatPersistence.ts's clearMessages
 *     and purgeStrangerDmThreads so this module's aux state never outlives the
 *     ChatMessage rows it refers to
 *   - groupIdFor(thread)                                 — test-only export (parity check
 *     against directMessages.ts's directConversationId), not a seam
 *
 * ─── One apply path, marker-aware (round-2 gate-remediation) ───────────────
 *
 * `resolveKnownRowAgainstStores` is the ONLY place that combines a pending
 * signal with a coexisting delete-marker for the same (thread, slotId)
 * before applying to a known row. `resolvePendingSignalsForSlot` and the
 * general self-heal sweep (`sweepExpiredForThreadKeyLocked`'s phase 1) both
 * call it — there is exactly one marker-aware apply path for a known row,
 * never a marker-aware one alongside a marker-blind one (round-1's eager
 * self-heal sweep was marker-blind, a sev7 regression fixed here).
 *
 * Round-3 gate-remediation (finding 1, sev6): that shared resolver persists
 * the winner via `applyToKnownSlotCore` BEFORE removing the consumed
 * pending entry / marker — never the reverse. See its own doc comment for
 * why removing first was a permanent-delete-loss bug.
 *
 * ─── The reconciliation invariant (spec §2.4/§2.5, AC-ORDER-3) ──────────────
 *
 * A slot's rendered state is the outcome of its highest-`rev` signal, for any
 * arrival order of {original, delete, edit-replacement}. Ties resolve
 * deterministically: delete-vs-edit at equal rev -> delete wins; edit-vs-edit
 * at equal rev -> the lexicographically higher replacement rumor id wins
 * (D15). This module is the ONLY place that decides winners — S1's storage
 * primitives provide an atomic strictly-older-rev floor and nothing more
 * (see chatPersistence.ts's MessagePatch doc comment); a write whose rev
 * equals the stored rev always passes that floor, so every equal-rev
 * decision must already be made by the time this module calls
 * updateMessageInPlace/tombstoneMessage.
 *
 * ─── Classification is marker-first (S2 review carry-forward obligation) ───
 *
 * The edit-marked companion kind-5 (buildEditMarkedCompanionKind5) carries
 * the original id BOTH bare (["e", orig]) and marked
 * (["e", orig, "", "edit"]). Classification checks for the presence of ANY
 * edit-marked e-tag FIRST, before anything else: if present on a kind-5, the
 * rumor is discarded outright (AC-DEL-7) — never on the presence of a bare
 * e-tag, which every edit-marked companion also carries.
 *
 * ─── Storage-write calling convention (required of S4/S5) ──────────────────
 *
 * Only this module ever calls chatPersistence.updateMessageInPlace /
 * tombstoneMessage for the edit/delete feature — S4 and S5 must never call
 * those primitives directly, or the per-slot tie-break bookkeeping this
 * module keeps (see SlotMeta below) silently desynchronizes from storage.
 * Symmetrically: whenever S4/S5 append a BRAND-NEW original chat-message row
 * (chatPersistence.appendMessage actually inserted, not a dedup no-op), they
 * MUST immediately call resolvePendingSignalsForSlot(thread, row.id,
 * row.senderPubkey) so any buffered signal or delete-marker for that id is
 * resolved. A plain, unmarked kind-9/14 rumor (no edit e-tag) is NOT a
 * signal and must never be routed to applyDeleteEditSignal — it is a normal
 * message and goes through the existing ingest path, followed by the
 * resolve call above.
 */

import { createStore, get, promisifyRequest, set, type UseStore } from 'idb-keyval';
import {
  appendMessage,
  loadMessages,
  tombstoneMessage,
  updateMessageInPlace,
  type ChatMessage,
} from '@/src/lib/marmot/chatPersistence';
import { DELETE_EDIT_RUMOR_KIND, hasEditMarkerTag } from '@/src/lib/messageEdits/rumor';
import { isInformativeAnnouncementContent } from '@/src/lib/marmot/announcementFamily';
import type { AuthenticatedSender } from '@/src/lib/marmot/applicationRumorDispatcher';

// ─── Public types ─────────────────────────────────────────────────────────

/** Discriminated thread key — structurally identical to reactions' ReactionThreadKey. */
export type MessageEditsThreadKey =
  | { kind: 'group'; groupId: string }
  | { kind: 'dm'; peerPubkeyHex: string };

/**
 * Structural inbound rumor shape this module classifies. `kind` is a plain
 * `number` (not `5 | 9 | 14`) so a malformed/unexpected wire value cannot be
 * coerced through TypeScript narrowing at the call site — classifySignal()
 * defensively discards anything outside {5, 9, 14} at runtime.
 *
 * `pubkey` MUST already be the AUTHENTICATED author pubkey by the time it
 * reaches this module: for DM, the seal's real-key signer; for group, the
 * MLS-authenticated INNER rumor pubkey — never the kind-445 wrapper's
 * ephemeral author (see the kind-445-events-have-ephemeral-authors
 * learning). Extracting that value correctly is S4/S5's job; this module
 * only compares it. (Epic: group-message-author-auth-app-layer S2 — this
 * pre-substitute-into-`pubkey` convention is now superseded for group
 * callers, which instead pass the authenticated value via
 * `applyDeleteEditSignal`'s optional `sender` parameter; `rumor.pubkey`
 * remains the fallback for callers, e.g. DM, that don't supply one.)
 */
export interface InboundDeleteEditRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export type ChangeResultKind = 'delete' | 'edit' | 'pending' | 'discarded' | 'noop';

/**
 * Return shape shared by applyDeleteEditSignal and resolvePendingSignalsForSlot.
 * `thread` echoes the caller's input byte-for-byte — this is what makes
 * AC-STORE-1's "identical shape from either transport" claim checkable.
 */
export interface ChangeResult {
  thread: MessageEditsThreadKey;
  /** The resolved/known slot id, or null when no slot could be identified at all. */
  slotId: string | null;
  kind: ChangeResultKind;
}

// ─── Tunable constants ────────────────────────────────────────────────────

/**
 * Global cap (across every thread) on the number of distinct pending-signal
 * target-id entries. Modeled directly on pendingInvitations.ts's
 * GLOBAL_CAP=256 (drop-oldest-on-overflow). Also reused, unmodified, as the
 * cap for the persisted delete-marker set (AC-ORDER-4: same cap as the
 * pending buffer; markers are never TTL'd).
 */
export const PENDING_SIGNAL_CAP = 256;

/**
 * Net-new TTL constant — pendingInvitations.ts has a cap but no TTL, so
 * there is no existing "buffered-state bound" to literally reuse for the
 * time half; this names a fresh one instead. 24 hours is long enough to
 * cover a typical app-closed / offline gap between a signal's arrival and
 * the recipient's next sync, short enough to bound unresolved-buffer
 * growth. Swept lazily on next access for the same thread (mirrors
 * chatPersistence's own on-first-access self-heal pass); there is no
 * setInterval/background-timer precedent in this codebase to mirror
 * instead.
 */
export const PENDING_SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ingest-time rev ceiling (S2 review carry-forward obligation). An accepted
 * signal's rev is capped to `Math.min(rawRev, nowSeconds +
 * MAX_REV_SKEW_SECONDS)` before it can ever be persisted or win a
 * comparison — closing the gap where clampRev's own saturation ceiling
 * (2^53, float precision) would otherwise let a hostile/broken author
 * device poison a slot's rev to an enormous-but-finite value, making every
 * future legitimate edit/delete from that author's own well-behaved
 * devices lose on equal-rev ties forever. 6 hours is a generous clock-skew
 * allowance while still rejecting an implausible far-future rev.
 */
export const MAX_REV_SKEW_SECONDS = 6 * 60 * 60;

// ─── IDB namespaces owned by this module ─────────────────────────────────

const PENDING_SIGNALS_KEY = 'few:messageEditsPendingSignals:v1';
const DELETE_MARKERS_KEY = 'few:messageEditsDeleteMarkers:v1';
const SLOT_META_KEY = 'few:messageEditsSlotMeta:v1';
const PINNED_REVS_KEY = 'few:messageEditsPinnedRevs:v1';

/**
 * A rev the ingest cap (MAX_REV_SKEW_SECONDS) lowered, pinned per rumor id at
 * first processing (bug: reaction-storage-failures, remediation round 1).
 *
 * The cap depends on the wall clock at processing time, so the SAME rumor
 * processed again later (a journal replay after a failed write, or after a
 * failed ack) would otherwise get a HIGHER rev — and could then overwrite an
 * edit that legitimately beat its first application. Pinning makes the rev a
 * function of the rumor alone: every later processing reads the pinned value.
 * An uncapped rev needs no pin — it is the signal's own rev, and stays
 * uncapped as the clock moves forward.
 *
 * Written BEFORE any effect of the rumor is persisted, so no effect can exist
 * without its pin. Cap-bounded like its sibling stores (PENDING_SIGNAL_CAP,
 * oldest evicted): only far-future (broken or hostile clock) signals are ever
 * pinned, so eviction needs more than PENDING_SIGNAL_CAP of them — the
 * accepted poisoned-clock residual (spec AC-ORDER-3).
 */
interface PinnedRev {
  threadKey: string;
  rumorId: string;
  rev: number;
  receivedAt: number;
}

interface PendingSignalBase {
  threadKey: string;
  targetId: string;
  rev: number;
  rumorId: string;
  authorPubkeyHex: string;
  receivedAt: number;
}
interface PendingDeleteSignal extends PendingSignalBase {
  kind: 'delete';
}
interface PendingEditSignal extends PendingSignalBase {
  kind: 'edit';
  content: string;
  /** Unix SECONDS — the pinned wire created_at of the buffered replacement. */
  createdAtSeconds: number;
}
type PendingSignal = PendingDeleteSignal | PendingEditSignal;

/**
 * A marker is intentionally cap-bounded (`PENDING_SIGNAL_CAP`, shared with
 * the pending buffer, AC-ORDER-2) but NEVER TTL'd. A marker's entire
 * purpose is DURABLE suppression of a message its author retracted before
 * this client ever saw the original (AC-ORDER-4) — expiring it on a timer
 * would un-suppress that message the moment the TTL elapses, silently
 * un-retracting it. `receivedAt` is retained only because the shared
 * eviction helper needs it to pick the oldest entry under cap pressure; it
 * is never read against `PENDING_SIGNAL_TTL_MS` for a marker the way it is
 * for a pending signal.
 */
interface DeleteMarker {
  threadKey: string;
  targetId: string;
  rev: number;
  /** The delete signal's author, stashed so a later-arriving original can retroactively authenticate it (see MARKER-AUTH note below). */
  authorPubkeyHex: string;
  receivedAt: number;
}

/**
 * Private per-slot bookkeeping: which rumor id / rev / signal kind most
 * recently WON at this slot. Not part of any seam and never read by another
 * module. Exists solely because MessagePatch/ChatMessage (S1's frozen
 * contract) carries no "winning rumor id" field, and the edit-vs-edit
 * equal-rev tie-break (AC-ORDER-3, D15) requires comparing the INCOMING
 * rumor id against whichever rumor id most recently won at this slot.
 *
 * Accepted residual (documented per round-2 remediation, not fixed): unlike
 * the delete-vs-edit equal-rev guard in `applyToKnownSlotCore` (which derives
 * `priorWasDelete` from storage truth, `row.tombstoned`, written atomically
 * with `row.rev`), the edit-vs-edit D15 tie-break has no storage-row field to
 * fall back on — `lastRumorId` here is the only place it lives, and this is a
 * SEPARATE idb write performed AFTER `updateMessageInPlace`. A crash between
 * the two writes leaves `row.rev` updated but `meta.lastRumorId` stale, so a
 * later equal-rev edit can incorrectly win (or lose) the D15 tie against the
 * one that crashed mid-write. The same holds when the slot-meta write fails
 * and the rumor journal replays the signal: the replay recomputes the SAME
 * rev (an uncapped rev is the signal's own; a capped one is pinned, see
 * PinnedRev), so it re-applies identical content at an identical rev, or
 * no-ops against a later winner — it never raises the rev. This is a
 * content-only divergence limited to
 * an exact same-second two-device edit collision landing on a crash window —
 * milder than the delete/tombstone case, which storage truth already
 * protects, and accepted as-is rather than extending S1's frozen
 * ChatMessage/MessagePatch contract with a new field to close it.
 */
interface SlotMeta {
  threadKey: string;
  slotId: string;
  lastRumorId: string;
  lastRev: number;
  lastKind: 'delete' | 'edit';
  /**
   * Round-2 remediation (finding 4): last-write timestamp, used ONLY to
   * order eviction under cap pressure (`evictOldestSlotMetaIfOverCap`) —
   * never consulted for any tie-break decision. Without this, slot-meta was
   * the one aux store with no cap/TTL discipline at all (unlike the pending
   * buffer and marker set), growing unboundedly for a long-lived account,
   * and read in full on every self-heal sweep pass.
   */
  lastTouchedAt: number;
}

async function readArray<T>(key: string): Promise<T[]> {
  const stored = await get<T[]>(key);
  return stored ?? [];
}

function evictOldestIfOverCap<T extends { receivedAt: number }>(entries: T[]): T[] {
  if (entries.length <= PENDING_SIGNAL_CAP) return entries;
  // Keep the newest PENDING_SIGNAL_CAP entries by receivedAt — evicts oldest
  // TARGETS (one entry == one target id), per AC-ORDER-2.
  return [...entries].sort((a, b) => a.receivedAt - b.receivedAt).slice(entries.length - PENDING_SIGNAL_CAP);
}

/**
 * Pending-signal-buffer-specific cap eviction. Identical "keep newest
 * PENDING_SIGNAL_CAP" policy to `evictOldestIfOverCap`, EXCEPT: an entry
 * about to be evicted that is ALSO already past its TTL is given the same
 * persist-its-effect-first treatment as the lazy TTL sweep
 * (`persistExpiredEntryEffect`) before being dropped from the buffer. Cap
 * pressure from OTHER threads must not silently drop a delete/edit signal
 * that has already earned materialization by outliving its TTL — only a
 * still-unexpired entry is dropped bare (that is the cap doing its
 * intended job).
 *
 * Not used for the delete-marker set (`upsertMarker` still uses the plain
 * `evictOldestIfOverCap`): a marker's "effect" IS its own persistence, so
 * there is no further effect to persist before evicting one.
 */
async function evictOldestPendingIfOverCap(entries: PendingSignal[]): Promise<PendingSignal[]> {
  if (entries.length <= PENDING_SIGNAL_CAP) return entries;
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  const overflowCount = sorted.length - PENDING_SIGNAL_CAP;
  const toEvict = sorted.slice(0, overflowCount);
  const now = Date.now();

  for (const entry of toEvict) {
    if (now - entry.receivedAt < PENDING_SIGNAL_TTL_MS) continue; // unexpired — dropped bare, cap doing its job
    const { messages } = await loadMessages(entry.threadKey);
    const knownRow = messages.find((m) => m.id === entry.targetId);
    await persistExpiredEntryEffect(entry, knownRow);
  }

  return sorted.slice(overflowCount);
}

// ── Pending-signal buffer helpers ─────────────────────────────────────────

async function readPendingAll(): Promise<PendingSignal[]> {
  return readArray<PendingSignal>(PENDING_SIGNALS_KEY);
}

async function writePendingAll(all: PendingSignal[]): Promise<void> {
  await set(PENDING_SIGNALS_KEY, all);
}

async function findPending(threadKey: string, targetId: string): Promise<PendingSignal | undefined> {
  const all = await readPendingAll();
  return all.find((e) => e.threadKey === threadKey && e.targetId === targetId);
}

/**
 * Insert a pending signal, collapsing per-target-id to the max-rev entry
 * (AC-ORDER-2). A re-delivery of the SAME rumor (matched by `rumorId`
 * alone, regardless of its classified `rev`) is a pure no-op — no idb write
 * — for AC-STORE-2 idempotency.
 *
 * Deliberately dedupes by `rumorId` alone rather than `rumorId AND rev`:
 * `sanitizeIncomingRev` caps a far-future rev to `nowSeconds +
 * MAX_REV_SKEW_SECONDS` at classification time, so two classifications of
 * the exact same rumor performed at different wall-clock moments (e.g. a
 * re-delivery reprocessed later) can produce two DIFFERENT capped revs for
 * an identical rumor id. Matching on rev too would miss that duplicate and
 * let the buffered entry's rev creep upward on every reprocess. Matching on
 * rumorId alone closes that gap.
 *
 * Documented residual: AC-ORDER-3 convergence under a poisoned/adversarial
 * clock is best-effort, not guaranteed, in this one regime. Two DISTINCT
 * far-future rumors (different rumorIds) from a hostile or broken author
 * device can still cap to different revs depending on each recipient's own
 * wall clock at classification time, and can therefore diverge across
 * recipients. A fully deterministic cap is not achievable against a
 * self-reported clock; well-behaved devices never trigger this because
 * their revs never approach the skew ceiling.
 */
async function insertOrCollapsePending(candidate: PendingSignal): Promise<void> {
  const all = await readPendingAll();
  const idx = all.findIndex((e) => e.threadKey === candidate.threadKey && e.targetId === candidate.targetId);
  if (idx === -1) {
    const next = await evictOldestPendingIfOverCap([...all, candidate]);
    await writePendingAll(next);
    return;
  }
  const existing = all[idx];
  if (existing.rumorId === candidate.rumorId) {
    return; // re-delivery of the same rumor — no-op regardless of rev drift
  }
  if (signalBeats(candidate, existing)) {
    const next = all.slice();
    next[idx] = candidate;
    await writePendingAll(next);
  }
}

/**
 * Remove every pending entry (across all threads/targets) whose `rumorId`
 * matches. A single delete rumor `e`-tags the original id PLUS every prior
 * replacement id (D14), so when the target is unknown,
 * `insertOrCollapsePending` is called once per e-tagged id — all sharing
 * the same `rumorId`. Once any one of those sibling entries is successfully
 * applied (via `resolvePendingSignalsForSlot` or the TTL sweep/eviction
 * paths), the remaining siblings are orphans: they are keyed by ids
 * (superseded replacement rumor ids) that will never correspond to a real
 * `ChatMessage` row, so they would otherwise sit until TTL, materializing
 * as orphan delete-markers that occupy the cap for ids nobody looks up.
 * Called on every successful apply to clear them proactively.
 */
async function removePendingByRumorId(rumorId: string): Promise<void> {
  const all = await readPendingAll();
  const next = all.filter((e) => e.rumorId !== rumorId);
  if (next.length !== all.length) await writePendingAll(next);
}

// ── Delete-marker store helpers ───────────────────────────────────────────

async function readMarkersAll(): Promise<DeleteMarker[]> {
  return readArray<DeleteMarker>(DELETE_MARKERS_KEY);
}

async function writeMarkersAll(all: DeleteMarker[]): Promise<void> {
  await set(DELETE_MARKERS_KEY, all);
}

async function findMarker(threadKey: string, targetId: string): Promise<DeleteMarker | undefined> {
  const all = await readMarkersAll();
  return all.find((m) => m.threadKey === threadKey && m.targetId === targetId);
}

async function removeMarker(threadKey: string, targetId: string): Promise<void> {
  const all = await readMarkersAll();
  const next = all.filter((m) => !(m.threadKey === threadKey && m.targetId === targetId));
  if (next.length !== all.length) await writeMarkersAll(next);
}

/** Upsert a marker, keeping whichever rev is higher (a marker never regresses). */
async function upsertMarker(candidate: DeleteMarker): Promise<void> {
  const all = await readMarkersAll();
  const idx = all.findIndex((m) => m.threadKey === candidate.threadKey && m.targetId === candidate.targetId);
  if (idx === -1) {
    const next = evictOldestIfOverCap([...all, candidate]);
    await writeMarkersAll(next);
    return;
  }
  if (candidate.rev > all[idx].rev) {
    const next = all.slice();
    next[idx] = candidate;
    await writeMarkersAll(next);
  }
}

// ── Slot-meta helpers ─────────────────────────────────────────────────────

async function readSlotMetaAll(): Promise<SlotMeta[]> {
  return readArray<SlotMeta>(SLOT_META_KEY);
}

async function readSlotMeta(threadKey: string, slotId: string): Promise<SlotMeta | undefined> {
  const all = await readSlotMetaAll();
  return all.find((m) => m.threadKey === threadKey && m.slotId === slotId);
}

/**
 * Round-2 remediation (finding 4): keeps slot-meta bounded the same way the
 * pending buffer and marker set are bounded — evict-oldest under cap
 * pressure, ordered by `lastTouchedAt` rather than `receivedAt` (slot-meta
 * has no "received" concept; it is a per-slot LAST-WRITE record, not a
 * per-signal arrival record), sharing the same `PENDING_SIGNAL_CAP` bound as
 * its sibling stores.
 */
function evictOldestSlotMetaIfOverCap(entries: SlotMeta[]): SlotMeta[] {
  if (entries.length <= PENDING_SIGNAL_CAP) return entries;
  return [...entries].sort((a, b) => a.lastTouchedAt - b.lastTouchedAt).slice(entries.length - PENDING_SIGNAL_CAP);
}

async function writeSlotMeta(
  threadKey: string,
  slotId: string,
  data: { lastRumorId: string; lastRev: number; lastKind: 'delete' | 'edit' },
): Promise<void> {
  const all = await readSlotMetaAll();
  const idx = all.findIndex((m) => m.threadKey === threadKey && m.slotId === slotId);
  const entry: SlotMeta = { threadKey, slotId, ...data, lastTouchedAt: Date.now() };
  if (idx === -1) {
    await set(SLOT_META_KEY, evictOldestSlotMetaIfOverCap([...all, entry]));
  } else {
    const next = all.slice();
    next[idx] = entry;
    await set(SLOT_META_KEY, evictOldestSlotMetaIfOverCap(next));
  }
}

// ── Pinned-rev helpers ────────────────────────────────────────────────────

/**
 * The pin store is ONE array under one key shared by every tab of the origin,
 * so a read-modify-write of it must be atomic ACROSS tabs: two tabs pinning at
 * once would otherwise both read the same array and the later write would drop
 * the other's pin (and that rumor's replay would recompute a higher rev). This
 * module's in-tab `serialize` queue does not cover other tabs, so every pin
 * read-modify-write runs as ONE readwrite IndexedDB transaction on idb-keyval's
 * default database/object store (the same key `get`/`set` use) — IndexedDB
 * serializes overlapping readwrite transactions, in every tab, with no lock
 * fallback needed. Never idb-keyval `update()` (not transaction-bound; see
 * rumorJournal.ts). Created lazily: nothing touches IndexedDB at module init.
 */
let pinStore: UseStore | null = null;
function pinTxnStore(): UseStore {
  if (!pinStore) pinStore = createStore('keyval-store', 'keyval');
  return pinStore;
}

/**
 * Read-modify-write of the pin array in one readwrite transaction. `modify`
 * returns the next array, or null to write nothing. Resolves with `modify`'s
 * second result once the transaction COMPLETED; rejects when it aborted or
 * failed (a throw in `modify` aborts it, so nothing is written).
 */
function modifyPinsAtomically<R>(modify: (all: PinnedRev[]) => { next: PinnedRev[] | null; result: R }): Promise<R> {
  let result: R;
  return pinTxnStore()('readwrite', (os) => {
    const read = os.get(PINNED_REVS_KEY);
    read.onsuccess = () => {
      try {
        const stored = read.result as PinnedRev[] | undefined;
        const out = modify(Array.isArray(stored) ? stored : []);
        result = out.result;
        if (out.next !== null) os.put(out.next, PINNED_REVS_KEY);
      } catch {
        os.transaction.abort();
      }
    };
    // Settles on complete, abort or error (a failed get aborts the txn too).
    return promisifyRequest(os.transaction);
  }).then(() => result);
}

/**
 * The rev this rumor is processed at: the pinned one when an earlier
 * processing pinned it, else `rev` — pinned now when the cap lowered it
 * (`capped`). The common case (no pin, not capped) is one plain read; the
 * insert re-reads and writes inside one transaction, so a pin another tab
 * added meanwhile is kept, and one it added for THIS rumor wins. A failed
 * read or write rejects (nothing applied yet; the caller's journal replays
 * the rumor).
 */
async function resolvePinnedRev(threadKey: string, rumorId: string, rev: number, capped: boolean): Promise<number> {
  const find = (all: PinnedRev[]) => all.find((p) => p.threadKey === threadKey && p.rumorId === rumorId);
  const pinned = find(await readArray<PinnedRev>(PINNED_REVS_KEY));
  if (pinned) return pinned.rev;
  if (!capped) return rev;
  return modifyPinsAtomically((all) => {
    const existing = find(all);
    if (existing) return { next: null, result: existing.rev };
    return { next: evictOldestIfOverCap([...all, { threadKey, rumorId, rev, receivedAt: Date.now() }]), result: rev };
  });
}

/** Drops every pin of one thread, atomically against concurrent pin inserts (any tab). */
async function removePinsForThread(threadKey: string): Promise<void> {
  const all = await readArray<PinnedRev>(PINNED_REVS_KEY);
  if (!all.some((p) => p.threadKey === threadKey)) return; // nothing to drop: no transaction
  await modifyPinsAtomically((current) => {
    const next = current.filter((p) => p.threadKey !== threadKey);
    return { next: next.length !== current.length ? next : null, result: undefined };
  });
}

// ─── Comparison / tie-break (AC-ORDER-3, D15) ────────────────────────────

/**
 * Returns true iff signal `a` beats signal `b` under the reconciliation
 * ordering: higher rev always wins; at equal rev, delete beats edit
 * (safety — never leave visible a message the author tried to retract);
 * edit-vs-edit at equal rev is broken by the lexicographically higher
 * replacement rumor id (D15, content-independent so all recipients
 * converge); delete-vs-delete at equal rev has no real ordering need
 * (either is a correct "tombstoned" outcome) so the candidate simply wins,
 * keeping the freshest arrival.
 */
function signalBeats(
  a: { kind: 'delete' | 'edit'; rev: number; rumorId: string },
  b: { kind: 'delete' | 'edit'; rev: number; rumorId: string },
): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.kind === b.kind) {
    if (a.kind === 'delete') return true;
    return a.rumorId > b.rumorId;
  }
  return a.kind === 'delete';
}

function pubkeysMatch(a: string, b: string): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

// ─── S8 (DD-11): announcement-immutability gate + admin carve-out ───────────

/**
 * A DM thread's flattened `threadKey` is always `dm:<peerHexLower>`
 * (`groupIdFor`); a group thread's is the raw MLS groupId, which never
 * legitimately collides with that prefix — the same assumption
 * `chatPersistence.ts` (`loadMessages`) and `purgeStrangerDmThreads` already
 * rely on. Used to scope the whole announcement-immutability gate to group
 * threads only, mirroring S7's `isGroupContext` UI carve-out: a DM has no
 * admin concept and no shared announcement history, so a DM's own
 * announcement-shaped message keeps its pre-S8 own-author rule untouched.
 */
function isGroupThreadKey(threadKey: string): boolean {
  return !threadKey.startsWith('dm:');
}

/** True iff `content` is a GROUP-thread informative announcement (see `isGroupThreadKey`). */
function isAnnouncementInThread(threadKey: string, content: string): boolean {
  return isGroupThreadKey(threadKey) && isInformativeAnnouncementContent(content);
}

/**
 * Resolves a groupId's current admin pubkeys via the registered provider.
 * See the module doc comment's "S8 (DD-11)" section for why this is a
 * settable singleton rather than a threaded parameter. Fail-closed to `[]`
 * on a DM thread, an unregistered provider, or a throwing/rejecting
 * provider — an empty set can only ever DENY the admin carve-out
 * (AC-IMMUT-5), never wrongly grant it.
 */
export type GroupAdminsProvider = (groupId: string) => Promise<string[]> | string[];

let groupAdminsProvider: GroupAdminsProvider | null = null;

/**
 * Composition-root registration hook. Exactly one provider is registered
 * app-wide (MarmotContext.tsx, backed by the live MLS client's
 * `groups.get(groupId).groupData.adminPubkeys`). Pass `null` to clear it
 * (e.g. on account switch / provider teardown).
 */
export function registerGroupAdminsProvider(provider: GroupAdminsProvider | null): void {
  groupAdminsProvider = provider;
}

async function groupAdminsFor(threadKey: string): Promise<string[]> {
  if (!isGroupThreadKey(threadKey)) return [];
  if (!groupAdminsProvider) return [];
  try {
    const admins = await groupAdminsProvider(threadKey);
    return Array.isArray(admins) ? admins : [];
  } catch {
    return [];
  }
}

function isAdminPubkey(admins: string[], pubkeyHex: string): boolean {
  return admins.some((a) => typeof a === 'string' && pubkeysMatch(a, pubkeyHex));
}

/**
 * S6 (epic: group-message-author-auth-app-layer) exposes the ALREADY-
 * REGISTERED GroupAdminsProvider (see registerGroupAdminsProvider above) for
 * chatHandler's enum-announcement admin-actor gate, so the announcement
 * ingest gate consults the exact same admin set as the announcement-
 * immutability delete/edit gate — not a second, independently-instantiated
 * lookup. Fail-closed inherited from groupAdminsFor/isAdminPubkey: an
 * unregistered provider, a non-group threadKey, or a throwing/rejecting
 * provider all resolve to `false` (deny), never `true`.
 */
export async function isRegisteredGroupAdmin(groupId: string, pubkeyHex: string): Promise<boolean> {
  const admins = await groupAdminsFor(groupId);
  return isAdminPubkey(admins, pubkeyHex);
}

/**
 * AC-IMMUT-4/5: authorizes a delete/tombstone signal against its target's
 * CURRENT content. For a GROUP-thread informative announcement, ordinary
 * authorship is irrelevant — only current-admin sourcing authorizes it. For
 * anything else (ordinary message, or any DM-thread message regardless of
 * shape), the pre-existing own-author rule applies unchanged.
 */
async function authorizeDeleteAgainstTarget(
  threadKey: string,
  targetContent: string,
  senderPubkeyHex: string,
  targetAuthorPubkeyHex: string,
): Promise<{ authorized: boolean; adminPubkeysHex: string[] }> {
  if (!isAnnouncementInThread(threadKey, targetContent)) {
    return { authorized: pubkeysMatch(senderPubkeyHex, targetAuthorPubkeyHex), adminPubkeysHex: [] };
  }
  const adminPubkeysHex = await groupAdminsFor(threadKey);
  return { authorized: isAdminPubkey(adminPubkeysHex, senderPubkeyHex), adminPubkeysHex };
}

/**
 * AC-IMMUT-6/7: an edit is rejected outright — no admin carve-out exists for
 * edit, ever — when EITHER the target's current content (AC-IMMUT-6) OR the
 * edit's own replacement content (AC-IMMUT-7) is a GROUP-thread informative
 * announcement. `targetContent` may be `undefined` when the target is not
 * yet known (the replacement-content check still applies regardless).
 */
function isEditAuthorizedByAnnouncementGate(
  threadKey: string,
  targetContent: string | undefined,
  replacementContent: string,
): boolean {
  if (targetContent !== undefined && isAnnouncementInThread(threadKey, targetContent)) return false;
  if (isAnnouncementInThread(threadKey, replacementContent)) return false;
  return true;
}

// ─── Rev sanitization (AC-ORDER-5 substrate + ingest cap) ────────────────

/**
 * A well-formed real signal's rev is a finite integer >= 1 (mirrors S1's
 * `isRealSignal` predicate and S2's `assertRealRev`). Malformed revs are
 * rejected outright (classification discards the whole signal) rather than
 * substituting a default — a delete/edit builder never emits one, so a
 * malformed rev signals a broken or hostile sender. Well-formed revs are
 * then capped to `nowSeconds + MAX_REV_SKEW_SECONDS` (ingest cap, S2 review
 * carry-forward obligation).
 */
function sanitizeIncomingRev(rawRev: number, nowSeconds: number): number | null {
  if (typeof rawRev !== 'number' || !Number.isFinite(rawRev) || !Number.isInteger(rawRev) || rawRev < 1) {
    return null;
  }
  const ceiling = nowSeconds + MAX_REV_SKEW_SECONDS;
  return Math.min(rawRev, ceiling);
}

function dedupePreserveOrder(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

// ─── Classification (marker-first, AC-DEL-7) ─────────────────────────────

type Classification =
  | { type: 'discard' }
  | { type: 'delete'; targetIds: string[]; rev: number; capped: boolean }
  | { type: 'edit'; targetId: string; rev: number; capped: boolean; content: string; createdAtSeconds: number };

/**
 * Classifies an inbound rumor. MARKER-FIRST: the presence of ANY e-tag
 * carrying the edit marker (`t[0] === 'e' && t[3] === 'edit'`) is checked
 * BEFORE anything else. On a kind-5, that marker means "edit-marked
 * companion" -> discard unconditionally, regardless of the bare e-tags the
 * same rumor also carries (AC-DEL-7). Never classify a kind-5 as a delete
 * merely because a bare `["e", orig]` tag is present — the edit-marked
 * companion carries one too.
 */
function classifySignal(rumor: InboundDeleteEditRumor, nowSeconds: number): Classification {
  if (!rumor || !Array.isArray(rumor.tags)) return { type: 'discard' };

  const eTags = rumor.tags.filter(
    (t): t is string[] => Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0,
  );
  const editMarkerTag = eTags.find((t) => t[3] === 'edit');
  // Marker-PRESENCE gating routes through the canonical `hasEditMarkerTag`
  // predicate (rumor.ts) rather than through `editMarkerTag`'s own truthiness,
  // so this classifier and the dispatch-routing check (ContactChat.tsx) can
  // never drift apart. `eTags`/`editMarkerTag` above are still computed
  // locally for target-id extraction (delete: all bare e-tag ids; edit: the
  // marker tag's own id) — `hasEditMarkerTag` only replaces the boolean.
  const isEditMarked = hasEditMarkerTag(rumor.tags);

  if (rumor.kind === DELETE_EDIT_RUMOR_KIND) {
    if (isEditMarked) return { type: 'discard' };
    const targetIds = dedupePreserveOrder(eTags.map((t) => t[1]));
    if (targetIds.length === 0) return { type: 'discard' };
    const rev = sanitizeIncomingRev(rumor.created_at, nowSeconds);
    if (rev === null) return { type: 'discard' };
    return { type: 'delete', targetIds, rev, capped: rev < rumor.created_at };
  }

  if (rumor.kind === 9 || rumor.kind === 14) {
    if (!isEditMarked || !editMarkerTag) return { type: 'discard' }; // a plain original is not a signal
    const targetId = editMarkerTag[1];
    const revTag = rumor.tags.find((t) => Array.isArray(t) && t[0] === 'rev');
    const rawRev = revTag && typeof revTag[1] === 'string' ? Number(revTag[1]) : NaN;
    const rev = sanitizeIncomingRev(rawRev, nowSeconds);
    if (rev === null) return { type: 'discard' };
    if (typeof rumor.content !== 'string' || rumor.content.length === 0) return { type: 'discard' };
    const createdAtSeconds =
      Number.isInteger(rumor.created_at) && rumor.created_at >= 0 ? rumor.created_at : 0;
    return { type: 'edit', targetId, rev, capped: rev < rawRev, content: rumor.content, createdAtSeconds };
  }

  return { type: 'discard' };
}

// ─── Thread key derivation ────────────────────────────────────────────────

/**
 * Duplicates directMessages.ts's directConversationId one-liner rather than
 * importing it at runtime, to keep this module's dependency graph free of
 * directMessages.ts's NDK/blossom/nostr-tools imports (see architecture.json
 * dependencies_forbidden). Must stay byte-identical to directConversationId.
 *
 * Exported (finding 8) SOLELY so a unit test can import both this and
 * `directConversationId` and assert byte-identical output across pubkeys —
 * turning the comment above into a checked invariant instead of a
 * hand-verified promise that could silently drift. Not a seam: nothing
 * outside this module's own test should call it as a producer/consumer
 * contract.
 */
export function groupIdFor(thread: MessageEditsThreadKey): string {
  return thread.kind === 'dm' ? `dm:${thread.peerPubkeyHex.toLowerCase()}` : thread.groupId;
}

// ─── Applying a signal against a known row ───────────────────────────────

/**
 * The actual apply-against-a-known-row logic, factored out from
 * `applyToKnownSlot` so it can be called from contexts that have no
 * `MessageEditsThreadKey` to echo back (the TTL sweep and cap-eviction
 * paths operate on the internal `threadKey` string only — see
 * `persistExpiredEntryEffect`). `applyToKnownSlot` below is a thin wrapper
 * that re-attaches `thread` for the public `ChangeResult` shape.
 */
interface KnownSlotIncoming {
  kind: 'delete' | 'edit';
  rev: number;
  rumorId: string;
  content?: string;
  /**
   * S8: the signal's own sender pubkey (ADR-006 self-asserted). Threaded
   * through to `tombstoneMessage`'s independent authorization re-check for
   * a delete/tombstone; unused for an edit (edit never gets an admin
   * carve-out — see `isEditAuthorizedByAnnouncementGate`).
   */
  senderPubkeyHex: string;
  /**
   * S8: the group's current admin pubkeys, already resolved by the CALLER
   * (fail-closed empty when the target isn't an announcement, or on a DM
   * thread — see `authorizeDeleteAgainstTarget`/`groupAdminsFor`). Passed
   * through unchanged so `tombstoneMessage`'s own re-derivation of "is this
   * an announcement" uses the SAME admin snapshot the caller already
   * authorized against, rather than a second, possibly-inconsistent lookup.
   */
  adminPubkeysHex: string[];
}

async function applyToKnownSlotCore(
  threadKey: string,
  row: ChatMessage,
  incoming: KnownSlotIncoming,
): Promise<{ slotId: string; kind: ChangeResultKind }> {
  const meta = await readSlotMeta(threadKey, row.id);

  // AC-STORE-2 idempotency shortcut: the exact same signal, reprocessed.
  if (meta && meta.lastRumorId === incoming.rumorId) {
    return { slotId: row.id, kind: 'noop' };
  }

  const storedRev = row.rev ?? 0;
  let wins: boolean;
  if (incoming.rev > storedRev) {
    wins = true;
  } else if (incoming.rev < storedRev) {
    wins = false;
  } else if (incoming.kind === 'delete') {
    // delete-vs-anything at equal rev: delete always wins.
    wins = true;
  } else {
    // incoming is an edit at equal rev. If the slot's current state was set
    // by a delete, the edit MUST NOT un-tombstone (spec §2.5: strictly
    // exceed to un-tombstone; equal rev = delete wins). Derived from
    // storage TRUTH (`row.tombstoned`), not slot-meta: `writeSlotMeta` is a
    // SEPARATE idb write performed AFTER `tombstoneMessage`/
    // `updateMessageInPlace` — a crash between the two writes would leave
    // `row.tombstoned = true` but a stale `meta.lastKind === 'edit'`, which
    // would incorrectly let an equal-rev edit un-tombstone. `row.tombstoned`
    // is written atomically with `row.rev` by `tombstoneMessage`, so it
    // always agrees with the rev this branch is comparing against. Slot
    // meta is used ONLY for the edit-vs-edit `lastRumorId` tie-break below,
    // which has no storage-truth equivalent.
    const priorWasDelete = row.tombstoned === true;
    if (priorWasDelete) {
      wins = false;
    } else {
      wins = incoming.rumorId > (meta?.lastRumorId ?? '');
    }
  }

  if (!wins) return { slotId: row.id, kind: 'noop' };

  if (incoming.kind === 'delete') {
    // S8: tombstoneMessage independently re-verifies the announcement/admin
    // gate (defense-in-depth, AC-IMMUT-4/5) — a rejection there means this
    // slot was NOT actually mutated, so ChangeResult must report 'noop', not
    // 'delete'. In the normal call graph this authorization was already
    // decided by this function's caller before `incoming` was built, so this
    // should always agree; the boolean return closes the gap for any future
    // caller that got that decision wrong.
    // S8 DM carve-out: `tombstoneMessage`'s own re-check has no notion of
    // "group vs DM" — it only sees raw content + an admin list — so
    // `authorization` is supplied ONLY for a group thread. A DM message
    // that happens to be announcement-SHAPED content (e.g. a DM
    // `call_notice`) must keep its pre-S8 own-author-only behavior
    // (S7's `isGroupContext` precedent); passing an authorization object
    // for a DM thread would incorrectly re-apply the group-only
    // announcement gate inside `tombstoneMessage`.
    const applied = isGroupThreadKey(threadKey)
      ? await tombstoneMessage(threadKey, row.id, incoming.rev, {
          senderPubkeyHex: incoming.senderPubkeyHex,
          adminPubkeysHex: incoming.adminPubkeysHex,
        })
      : await tombstoneMessage(threadKey, row.id, incoming.rev);
    if (!applied) return { slotId: row.id, kind: 'noop' };
  } else {
    // Always pass tombstoned:false explicitly — MessagePatch is merge-only
    // (S1 carry-forward obligation): omitting the field would leave an
    // already-tombstoned row hidden even though this edit just won.
    await updateMessageInPlace(threadKey, row.id, {
      content: incoming.content,
      edited: true,
      tombstoned: false,
      rev: incoming.rev,
    });
  }

  await writeSlotMeta(threadKey, row.id, {
    lastRumorId: incoming.rumorId,
    lastRev: incoming.rev,
    lastKind: incoming.kind,
  });

  return { slotId: row.id, kind: incoming.kind };
}

async function applyToKnownSlot(
  thread: MessageEditsThreadKey,
  threadKey: string,
  row: ChatMessage,
  incoming: KnownSlotIncoming,
): Promise<ChangeResult> {
  const result = await applyToKnownSlotCore(threadKey, row, incoming);
  return { thread, ...result };
}

/**
 * The single marker-aware resolver for a KNOWN row (round-2 gate-
 * remediation, findings 1+2). Consults BOTH the pending-signal buffer and
 * the delete-marker store for `(threadKey, row.id)`, builds a candidate from
 * each (author-checked against `authorPubkeyHex`), picks the winner via the
 * exact same `signalBeats` ordering `applyToKnownSlotCore` itself uses,
 * applies it, and consumes (removes) whichever of the pending entry / marker
 * existed — regardless of whether it won (a mismatched-author entry is
 * dropped fail-closed but still removed, so it cannot linger and be
 * reprocessed).
 *
 * Callers: `resolvePendingSignalsForSlot` (for its own `slotId`, using the
 * caller-supplied authenticated pubkey) and `sweepExpiredForThreadKeyLocked`'s
 * self-heal phase (for every OTHER known-row target in the thread, using
 * `row.senderPubkey` — there is no separate authenticated-pubkey parameter
 * at sweep time, mirroring what the pre-round-2 `persistExpiredEntryEffect`
 * knownRow branch already used). This is now the ONLY apply path for a known
 * row against these two stores — see the module doc comment's "One apply
 * path, marker-aware" section for why a second, marker-blind path was a bug,
 * not a feature.
 *
 * Persist-BEFORE-remove ordering (round-3 gate-remediation, finding 1,
 * sev6). `applyToKnownSlotCore`'s tombstone/update write and this function's
 * own `removePendingByRumorId`/`removeMarker` writes are DISTINCT IndexedDB
 * commits. The winner is computed and applied FIRST, and only after that
 * write settles are the consumed pending entry / marker removed — never the
 * reverse. Removing first (the pre-round-3 order) meant a crash between the
 * removal commit and the tombstone commit left the pending entry AND marker
 * gone but the row NOT yet tombstoned/updated: on restart the original
 * re-delivers, `appendMessage` dedup-no-ops so the resolve hook never
 * re-fires, and the self-heal sweep finds nothing in either aux store —
 * permanently losing the delete/edit. Persist-then-remove makes crash-redo
 * idempotent instead: `applyToKnownSlotCore` no-ops on re-resolve via the
 * slot-meta `lastRumorId` match, and the still-present entries are then
 * removed cleanly. The fail-closed case (neither entry authenticates against
 * `authorPubkeyHex`, so `winner` is null) has nothing to persist — both
 * mismatched entries are still removed below, so a stale/forged entry
 * cannot linger and be reprocessed.
 *
 * S8 (DD-11) addition: the bare `pubkeysMatch(entry.authorPubkeyHex,
 * authorPubkeyHex)` gate this function used pre-S8 is now
 * `isDeleteEntryAuthorized`/`isEditEntryAuthorized` below — for a
 * GROUP-thread informative-announcement row, a DELETE/marker entry is
 * authorized by CURRENT-ADMIN sourcing instead of own-authorship
 * (AC-IMMUT-4/5), while an EDIT entry is never authorized against such a
 * row, admin or not (AC-IMMUT-6), nor when its own replacement content is
 * itself an announcement (AC-IMMUT-7). This is the buffered/deferred apply
 * site DD-11 requires the gate to hold at — a signal arriving before its
 * target must not bypass the gate once the target materializes.
 */
async function resolveKnownRowAgainstStores(
  threadKey: string,
  row: ChatMessage,
  authorPubkeyHex: string,
): Promise<{ slotId: string; kind: ChangeResultKind }> {
  const pendingEntry = await findPending(threadKey, row.id);
  const marker = await findMarker(threadKey, row.id);

  const targetIsAnnouncement = isAnnouncementInThread(threadKey, row.content);
  const adminPubkeysHex = targetIsAnnouncement ? await groupAdminsFor(threadKey) : [];

  function isDeleteEntryAuthorized(entryAuthorPubkeyHex: string): boolean {
    if (targetIsAnnouncement) return isAdminPubkey(adminPubkeysHex, entryAuthorPubkeyHex);
    return pubkeysMatch(entryAuthorPubkeyHex, authorPubkeyHex);
  }

  function isEditEntryAuthorized(entryAuthorPubkeyHex: string, replacementContent: string): boolean {
    if (!isEditAuthorizedByAnnouncementGate(threadKey, row.content, replacementContent)) return false;
    return pubkeysMatch(entryAuthorPubkeyHex, authorPubkeyHex);
  }

  type WinnerCandidate = { kind: 'delete' | 'edit'; rev: number; rumorId: string; content?: string; authorPubkeyHex: string };

  let candidate: WinnerCandidate | null = null;
  if (pendingEntry) {
    const authorized =
      pendingEntry.kind === 'delete'
        ? isDeleteEntryAuthorized(pendingEntry.authorPubkeyHex)
        : isEditEntryAuthorized(pendingEntry.authorPubkeyHex, pendingEntry.content);
    if (authorized) {
      candidate =
        pendingEntry.kind === 'delete'
          ? { kind: 'delete', rev: pendingEntry.rev, rumorId: pendingEntry.rumorId, authorPubkeyHex: pendingEntry.authorPubkeyHex }
          : {
              kind: 'edit',
              rev: pendingEntry.rev,
              rumorId: pendingEntry.rumorId,
              content: pendingEntry.content,
              authorPubkeyHex: pendingEntry.authorPubkeyHex,
            };
    }
  }

  let markerSignal: WinnerCandidate | null = null;
  if (marker && isDeleteEntryAuthorized(marker.authorPubkeyHex)) {
    markerSignal = { kind: 'delete', rev: marker.rev, rumorId: '', authorPubkeyHex: marker.authorPubkeyHex };
  }

  let winner: WinnerCandidate | null = null;
  if (markerSignal && candidate) {
    winner = signalBeats(markerSignal, candidate) ? markerSignal : candidate;
  } else {
    winner = markerSignal ?? candidate;
  }

  // Persist FIRST (see doc comment above) — only after this settles do we
  // remove the consumed entries below.
  const result: { slotId: string; kind: ChangeResultKind } = winner
    ? await applyToKnownSlotCore(threadKey, row, {
        kind: winner.kind,
        rev: winner.rev,
        rumorId: winner.rumorId,
        content: winner.kind === 'edit' ? winner.content : undefined,
        senderPubkeyHex: winner.authorPubkeyHex,
        adminPubkeysHex,
      })
    : { slotId: row.id, kind: 'noop' };

  // THEN remove, consumed either way (finding 6, carried forward): clears
  // sibling pending entries sharing this rumor's id (a delete e-tags the
  // original PLUS every prior replacement id, D14 — each got its own
  // pending entry when the target was unknown), and drops the marker
  // regardless of whether it won — a mismatched-author entry is a
  // stale/invalid signal that must not keep suppressing or being
  // reprocessed once the real author is known.
  if (pendingEntry) {
    await removePendingByRumorId(pendingEntry.rumorId);
  }
  if (marker) {
    await removeMarker(threadKey, row.id);
  }

  return result;
}

// ─── TTL sweep / materialize-on-expiry (AC-ORDER-4) ──────────────────────

/**
 * Persists a single expired (past-TTL, or cap-evicted-while-past-TTL)
 * pending entry's effect for a target with NO known row. Shared by
 * `sweepExpiredForThreadKeyLocked`'s phase 2 and `evictOldestPendingIfOverCap`.
 *
 * Two cases, checked in order:
 *
 * 1. **Entry is a DELETE.** Persists a content-free marker keyed by the
 *    target id (id-only — no row, no content, AC-ORDER-4).
 * 2. **Entry is an EDIT.** Materializes a real ChatMessage row under its
 *    original slot id, WITHOUT the edited flag, UNLESS an existing marker
 *    for the same id has an equal-or-higher rev (the marker represents a
 *    delete that is, by rev, at least as authoritative — in which case the
 *    edit's effect is discarded and the marker is left standing). If the
 *    expiring edit's rev is strictly higher than an existing marker's, the
 *    edit wins instead and the now-superseded marker is removed.
 *
 * `knownRow`, when provided (only ever by `evictOldestPendingIfOverCap`),
 * routes through a DIRECT `applyToKnownSlotCore` call rather than the
 * marker-aware `resolveKnownRowAgainstStores` (round-2 remediation findings
 * 1+2 scoped the marker-aware unification to `sweepExpiredForThreadKeyLocked`
 * specifically — see that function's doc comment). Routing this cap-eviction
 * branch through the shared resolver would race `evictOldestPendingIfOverCap`'s
 * own bulk `writePendingAll` (computed from an in-memory snapshot) against the
 * resolver's own `removePendingByRumorId` write, silently reintroducing an
 * already-removed entry. This is a narrow, documented residual: cap eviction
 * only reaches this branch for a target whose OWN thread has neither been
 * swept (lazily, on next access) nor yet resolved, and is simultaneously the
 * eviction victim of a DIFFERENT thread's cap pressure — rarer and narrower
 * than the general self-heal gap findings 1/2 close.
 *
 * Round-3 gate-remediation (finding 2, sev4, cheap hardening only — both
 * reviewers judged the underlying gap an ACCEPTABLE self-healing transient,
 * not worth routing through the shared resolver's write-race risk above).
 * This branch is otherwise marker-BLIND: it can apply a pending edit while
 * ignoring a coexisting higher/equal-rev delete-marker for the same target.
 * Before applying a pending EDIT here, a READ-ONLY check looks for a
 * delete-marker with `rev >=` the edit's rev; if one exists, the edit-apply
 * is skipped and the marker is left standing (untouched — no write), to be
 * re-tombstoned normally on the next sweep. This tightens the transient
 * window without introducing any new write race: the check never removes or
 * writes the marker, so it cannot race `evictOldestPendingIfOverCap`'s own
 * write the way routing through the shared resolver would. A pending DELETE
 * entry is unaffected — it is unconditionally applied as before.
 */
async function persistExpiredEntryEffect(entry: PendingSignal, knownRow: ChatMessage | undefined): Promise<void> {
  if (knownRow) {
    // S8 (DD-11, AC-IMMUT-4/5/6): the pre-S8 bare `pubkeysMatch` gate is
    // replaced with the same announcement-aware authorization every other
    // apply site uses — a delete/marker entry against a GROUP-thread
    // announcement is authorized by current-admin sourcing, never by
    // ordinary own-authorship; an edit entry is NEVER authorized against
    // such a row, admin or not.
    const targetIsAnnouncement = isAnnouncementInThread(entry.threadKey, knownRow.content);
    let authorized: boolean;
    let adminPubkeysHex: string[] = [];
    if (targetIsAnnouncement) {
      if (entry.kind === 'edit') {
        authorized = false; // AC-IMMUT-6 — no admin carve-out for edit
      } else {
        adminPubkeysHex = await groupAdminsFor(entry.threadKey);
        authorized = isAdminPubkey(adminPubkeysHex, entry.authorPubkeyHex);
      }
    } else {
      authorized = pubkeysMatch(entry.authorPubkeyHex, knownRow.senderPubkey);
    }

    if (authorized) {
      if (entry.kind === 'edit') {
        // AC-IMMUT-7: reject when the REPLACEMENT content itself is an
        // announcement, regardless of the (here, non-announcement) target.
        if (isAnnouncementInThread(entry.threadKey, entry.content)) {
          return;
        }
        const existingMarker = await findMarker(entry.threadKey, entry.targetId);
        if (existingMarker && existingMarker.rev >= entry.rev) {
          // A same/higher-rev marker already outranks this edit — leave it
          // standing untouched (read-only check, no write) and let the next
          // sweep re-tombstone normally.
          return;
        }
      }
      await applyToKnownSlotCore(entry.threadKey, knownRow, {
        kind: entry.kind,
        rev: entry.rev,
        rumorId: entry.rumorId,
        content: entry.kind === 'edit' ? entry.content : undefined,
        senderPubkeyHex: entry.authorPubkeyHex,
        adminPubkeysHex,
      });
    }
    // Unauthorized (mismatched author, or announcement-gate rejection):
    // fail-closed, drop silently — mirrors resolvePendingSignalsForSlot's
    // AC-AUTH-2 gate.
    return;
  }

  if (entry.kind === 'delete') {
    // Target unknown — its content can't be checked yet, so the marker is
    // recorded unconditionally, exactly as before S8. The announcement +
    // admin gate is deferred to whenever the row DOES arrive, applied by
    // the knownRow branch above (via a later sweep) or by
    // `resolveKnownRowAgainstStores` — DD-11's whole point.
    await upsertMarker({
      threadKey: entry.threadKey,
      targetId: entry.targetId,
      rev: entry.rev,
      authorPubkeyHex: entry.authorPubkeyHex,
      receivedAt: Date.now(),
    });
    return;
  }

  // entry.kind === 'edit', no known row: this branch MATERIALIZES a brand
  // new ChatMessage row directly from the edit's own replacement content
  // (there is no real target to check). AC-IMMUT-7: reject outright when
  // that replacement content itself is an announcement — otherwise this is
  // exactly the fabrication DD-11/AC-IMMUT-7 exists to prevent (an
  // attacker using an edit-with-unknown-target to plant a forged,
  // now-"immutable" announcement row).
  if (isAnnouncementInThread(entry.threadKey, entry.content)) {
    return;
  }

  // S9 gate-remediation: the row created below is a PLACEHOLDER, not a
  // confirmed real message — its own target was never actually seen. It is
  // flagged `materializedFromEdit` so that IF a genuine message later
  // arrives at this exact id (chatPersistence.appendMessage, called from the
  // normal ingest path once the real rumor shows up), that real arrival
  // overwrites this placeholder INSTEAD OF silently no-op'ing against it —
  // but ONLY when the arriving content is itself a group informative
  // announcement (`isInformativeAnnouncementContent`, gated in
  // `appendMessage`; see `ChatMessage.materializedFromEdit` and
  // `appendMessage`'s doc comments in chatPersistence.ts). Without this, a
  // group announcement arriving after this placeholder had already claimed
  // the slot would be permanently suppressed — defeating AC-IMMUT-6
  // announcement immutability at exactly this ordering.
  //
  // The ordinary-message case this branch exists for — a real target that
  // never showed up before the edit signal expired — is NOT "completely
  // unaffected" by a later arrival: the real original CAN still show up
  // after materialization (e.g. a delayed/re-delivered rumor). Gate-
  // remediated (severity 4): that arrival used to unconditionally overwrite
  // this placeholder, reverting an already-applied edit or resurrecting an
  // already-tombstoned message. `appendMessage` now only supersedes the
  // placeholder for an announcement arrival; an ordinary real-original
  // arrival is a no-op against it, so the materialized/edited/tombstoned
  // row stands exactly as flagged.

  const existingMarker = await findMarker(entry.threadKey, entry.targetId);
  if (existingMarker && existingMarker.rev >= entry.rev) {
    // The delete-marker is at least as authoritative — the edit's effect
    // is discarded, matching the standard delete-vs-edit tie/precedence
    // rule extended to the materialize-on-expiry case. (`>=`: an EQUAL-rev
    // marker also stands, per delete-wins-ties.)
    return;
  }

  await appendMessage(entry.threadKey, {
    id: entry.targetId,
    content: entry.content,
    senderPubkey: entry.authorPubkeyHex,
    groupId: entry.threadKey,
    createdAt: entry.createdAtSeconds * 1000,
    edited: false,
    rev: entry.rev,
    materializedFromEdit: true,
  });
  await writeSlotMeta(entry.threadKey, entry.targetId, {
    lastRumorId: entry.rumorId,
    lastRev: entry.rev,
    lastKind: 'edit',
  });
  if (existingMarker) {
    await removeMarker(entry.threadKey, entry.targetId);
  }
}

/**
 * Reconciles every pending entry AND marker buffered for a single thread.
 * Must run inside the module's serialization queue (called only from
 * applyDeleteEditSignal / resolvePendingSignalsForSlot, both of which
 * already hold it, on every invocation for that thread).
 *
 * Two phases:
 *
 * **Phase 1 — marker-aware self-heal for known rows (round-2 remediation
 * findings 1+2+3).** Not TTL-gated: EVERY pending entry AND every persisted
 * delete-marker for the thread is checked against the currently-loaded
 * messages, not just past-TTL ones. If a candidate target already has a
 * known row — meaning a late original was appended without the standard
 * `resolvePendingSignalsForSlot` hook ever re-firing for it (crash between
 * append and resolve; restart where the append dedup'd as a no-op) — it is
 * resolved immediately via `resolveKnownRowAgainstStores`, the SAME
 * marker-aware winner logic `resolvePendingSignalsForSlot` itself uses. This
 * covers BOTH self-heal manifestations: a pending entry with no marker, AND
 * a marker with NO pending entry (finding 1's "marker-only" case — a delete
 * that already materialized to a marker before its original ever arrived;
 * the round-1 implementation only ever scanned pending entries, never
 * markers, so this case previously self-healed only via an explicit
 * `resolvePendingSignalsForSlot` call, never via ambient thread activity).
 *
 * Candidate target ids are computed once up front, but existence is
 * RE-CHECKED against live storage immediately before each resolve call
 * (finding 3): `resolveKnownRowAgainstStores` can remove several pending
 * entries in one call (rumor-id sibling group, finding 6), so a later
 * candidate in this same set may already be consumed by the time its turn
 * comes — reprocessing it would be at best a wasted no-op read, and for the
 * OLD marker-blind persist path could have re-created an inert orphan
 * marker for an id already cleared as a sibling.
 *
 * **Phase 2 — materialize-on-expiry for targets with NO known row.**
 * Unchanged in spirit from round 1: an unexpired entry stays buffered
 * untouched; a past-TTL one gets the standard materialize-on-expiry
 * treatment (marker for delete, materialized row for edit, per
 * `persistExpiredEntryEffect`). The candidate list is RE-READ fresh from
 * storage (not phase 1's snapshot) since phase 1 may have removed rumor-id
 * siblings of entries still pending here (finding 3), and each entry is
 * re-checked for continued presence (by rumorId) immediately before its
 * effect is persisted, for the same reason — this is the fix for finding 3's
 * "inert orphan marker for an already-removed sibling" bug.
 *
 * Crash-safe ordering (finding 2, unchanged from round 1): each entry's
 * effect is persisted via `persistExpiredEntryEffect`/`resolveKnownRowAgainstStores`
 * FIRST, and only THEN is the entry (and any sibling pending entries sharing
 * its `rumorId` — finding 6) removed from the buffer. A crash between
 * persisting and removing simply leaves the entry to be re-processed on the
 * next sweep; every persisted effect is idempotent (`upsertMarker` keeps the
 * max rev; `appendMessage` is insert-if-absent; `applyToKnownSlotCore`
 * no-ops on a re-seen rumorId via slot-meta), so a crash-redo is harmless.
 *
 * `skipTargetId` — `resolvePendingSignalsForSlot` passes its own `slotId`
 * here (round-2 remediation finding 2: it now resolves `slotId`'s OWN
 * candidate-vs-marker winner via `resolveKnownRowAgainstStores` BEFORE
 * calling this sweep at all — see that function's doc comment for why that
 * ordering, not this exclusion, is what actually protects `slotId` from a
 * sibling's rumor-id-group cleanup crossing over and deleting its entry
 * out from under it). This parameter still excludes `slotId` from both
 * phases here as a belt-and-suspenders guard against reprocessing an
 * already-resolved slot. `applyDeleteEditSignal` passes no `skipTargetId` —
 * it has no specific slot of its own to protect at sweep time.
 */
async function sweepExpiredForThreadKeyLocked(threadKey: string, skipTargetId?: string): Promise<void> {
  const now = Date.now();
  const { messages } = await loadMessages(threadKey);

  // ── Phase 1: marker-aware self-heal for known rows ────────────────────
  const pendingForThread = (await readPendingAll()).filter(
    (e) => e.threadKey === threadKey && e.targetId !== skipTargetId,
  );
  const markersForThread = (await readMarkersAll()).filter(
    (m) => m.threadKey === threadKey && m.targetId !== skipTargetId,
  );
  const candidateTargetIds = dedupePreserveOrder([
    ...pendingForThread.map((e) => e.targetId),
    ...markersForThread.map((m) => m.targetId),
  ]);

  for (const targetId of candidateTargetIds) {
    const knownRow = messages.find((m) => m.id === targetId);
    if (!knownRow) continue; // no row yet — handled by phase 2 below, if it's a pending entry
    const [stillPending, stillMarked] = await Promise.all([
      findPending(threadKey, targetId),
      findMarker(threadKey, targetId),
    ]);
    if (!stillPending && !stillMarked) continue; // already consumed as a rumor-id sibling earlier in this loop
    await resolveKnownRowAgainstStores(threadKey, knownRow, knownRow.senderPubkey);
  }

  // ── Phase 2: materialize-on-expiry for targets with no known row ──────
  const remainingPending = (await readPendingAll()).filter(
    (e) => e.threadKey === threadKey && e.targetId !== skipTargetId,
  );
  for (const entry of remainingPending) {
    if (messages.some((m) => m.id === entry.targetId)) continue; // phase 1 already handled every known-row case
    if (now - entry.receivedAt < PENDING_SIGNAL_TTL_MS) continue; // not expired — remains buffered
    // Re-check presence right before persisting (finding 3): an earlier
    // entry in THIS loop, or phase 1 above, may already have removed this
    // one as a rumor-id sibling (e.g. a multi-e-tag delete's
    // replacement-id entry).
    const stillThere = await findPending(threadKey, entry.targetId);
    if (!stillThere || stillThere.rumorId !== entry.rumorId) continue;
    await persistExpiredEntryEffect(entry, undefined);
    await removePendingByRumorId(entry.rumorId);
  }
}

// ─── Single global serialization queue ───────────────────────────────────
//
// All auxiliary IDB state this module owns (pending buffer, delete markers,
// slot meta) lives under a small, fixed set of GLOBAL idb-keyval keys
// shared across every thread — unlike chatPersistence's per-thread
// appendQueues. A single module-wide queue is the simplest way to guarantee
// read-modify-write correctness across concurrent calls without a second
// queue tier; this feature's call volume does not need cross-thread
// parallelism.

let globalQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const prev = globalQueue.catch(() => {});
  const run = prev.then(task);
  globalQueue = run.catch(() => {});
  return run;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * The frozen reconciliation seam entrypoint. See the module doc comment for
 * the full classification / ordering / pending-buffer contract.
 *
 * `sender` (optional, epic: group-message-author-auth-app-layer S2): the
 * dispatcher-resolved authenticated sender for the group path. When
 * supplied, every authorization/attribution decision below sources the
 * signal's author pubkey from `sender.pubkey` instead of the forgeable
 * `rumor.pubkey`. Callers that don't supply one (the DM path, seal-
 * signature-authenticated independently) keep reading `rumor.pubkey`
 * unchanged.
 */
export function applyDeleteEditSignal(
  thread: MessageEditsThreadKey,
  rumor: InboundDeleteEditRumor,
  sender?: AuthenticatedSender,
): Promise<ChangeResult> {
  return serialize(async () => {
    const senderPubkey = sender?.pubkey ?? rumor.pubkey;
    const threadKey = groupIdFor(thread);

    // Classification is pure and runs FIRST (bug: reaction-storage-failures,
    // remediation round 1): a malformed signal, an edit-marked kind-5
    // companion, a malformed rev, … is decided without storage. For such a
    // signal the self-heal sweep (any thread activity runs it) is
    // best-effort: its failure is warned, never thrown, so a storage outage
    // cannot make a permanently-invalid signal fail and be retried instead
    // of being dropped. The sweep is crash-safe (persist-then-remove) and
    // runs again on the thread's next activity.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const classification = classifySignal(rumor, nowSeconds);

    if (classification.type === 'discard') {
      await sweepExpiredForThreadKeyLocked(threadKey).catch((err: unknown) => {
        console.warn('[messageEdits] self-heal sweep failed (discarded signal)', err);
      });
      return { thread, slotId: null, kind: 'discarded' as const };
    }

    // A valid signal: a failed sweep rejects, so the signal is retried.
    await sweepExpiredForThreadKeyLocked(threadKey);

    // Replay-deterministic rev (see PinnedRev): a capped rev is pinned at
    // first processing and reused by every later one.
    classification.rev = await resolvePinnedRev(threadKey, rumor.id, classification.rev, classification.capped);

    // Authorization needs the target row, i.e. storage: a failed read here
    // rejects (the signal is retried, never applied unauthorized) — the one
    // validity check that cannot be made without storage.
    const { messages } = await loadMessages(threadKey);

    if (classification.type === 'delete') {
      const knownRow = classification.targetIds
        .map((id) => messages.find((m) => m.id === id))
        .find((m): m is ChatMessage => m !== undefined);

      if (!knownRow) {
        for (const targetId of classification.targetIds) {
          await insertOrCollapsePending({
            kind: 'delete',
            threadKey,
            targetId,
            rev: classification.rev,
            rumorId: rumor.id,
            authorPubkeyHex: senderPubkey,
            receivedAt: Date.now(),
          });
        }
        return { thread, slotId: null, kind: 'pending' as const };
      }

      // S8 (AC-IMMUT-4/5): for a GROUP-thread announcement, own-authorship
      // is irrelevant — only current-admin sourcing authorizes the
      // delete/tombstone; an ordinary message keeps the pre-S8 own-author
      // rule (`authorizeDeleteAgainstTarget` folds both branches together).
      const { authorized, adminPubkeysHex } = await authorizeDeleteAgainstTarget(
        threadKey,
        knownRow.content,
        senderPubkey,
        knownRow.senderPubkey,
      );
      if (!authorized) {
        return { thread, slotId: knownRow.id, kind: 'discarded' as const };
      }

      return applyToKnownSlot(thread, threadKey, knownRow, {
        kind: 'delete',
        rev: classification.rev,
        rumorId: rumor.id,
        senderPubkeyHex: senderPubkey,
        adminPubkeysHex,
      });
    }

    // classification.type === 'edit'
    const targetId = classification.targetId;
    const knownRow = messages.find((m) => m.id === targetId);

    // S8 (AC-IMMUT-6/7): reject outright when EITHER the (possibly still
    // unknown) target's current content OR the edit's own replacement
    // content is a GROUP-thread announcement — never an admin carve-out for
    // edit. Checked BEFORE buffering so a forged replacement never even
    // enters the pending buffer.
    if (!isEditAuthorizedByAnnouncementGate(threadKey, knownRow?.content, classification.content)) {
      return { thread, slotId: knownRow?.id ?? null, kind: 'discarded' as const };
    }

    if (!knownRow) {
      await insertOrCollapsePending({
        kind: 'edit',
        threadKey,
        targetId,
        rev: classification.rev,
        rumorId: rumor.id,
        authorPubkeyHex: senderPubkey,
        content: classification.content,
        createdAtSeconds: classification.createdAtSeconds,
        receivedAt: Date.now(),
      });
      return { thread, slotId: null, kind: 'pending' as const };
    }

    if (!pubkeysMatch(senderPubkey, knownRow.senderPubkey)) {
      return { thread, slotId: knownRow.id, kind: 'discarded' as const };
    }

    return applyToKnownSlot(thread, threadKey, knownRow, {
      kind: 'edit',
      rev: classification.rev,
      rumorId: rumor.id,
      content: classification.content,
      senderPubkeyHex: senderPubkey,
      adminPubkeysHex: [],
    });
  });
}

/**
 * The deferred-authorization hook. See the module doc comment's "Storage-
 * write calling convention" section for the required S4/S5 calling
 * protocol. No-ops (kind: 'noop') when the slot has neither a marker nor a
 * pending entry.
 *
 * MARKER-AUTH note: a delete-marker was committed at TTL-expiry time
 * WITHOUT ever being able to authenticate its signal (the target was, by
 * definition, unknown — there was no original message's author to compare
 * against). This function closes that gap retroactively, the one place it
 * still can: the marker's own stashed authorPubkeyHex is compared against
 * originalAuthorPubkeyHex here; on mismatch the marker is dropped rather
 * than applied, self-healing the tombstone away. This is a strictly better
 * outcome than never checking at all, but it is NOT symmetric with the
 * edit-materialize branch, for a structural reason rather than a residual
 * gap: a marker suppresses/tombstones the real original once it arrives
 * (there IS a real row at that point to authenticate against, which is
 * exactly what this function does), whereas an edit-materialize FABRICATES
 * a row from the edit's own replacement content before any real original is
 * ever seen — there is no "real original" here to retroactively compare
 * an author against, because by the time this function could run, either
 * the row is still the fabricated placeholder (nothing to authenticate) or
 * the real original has already arrived and overwritten it outright (S9
 * gate-remediation: `chatPersistence.appendMessage` now supersedes a row
 * flagged `materializedFromEdit` rather than dedup-no-op'ing against it —
 * see that flag's doc comment — so a genuine arrival, including a group
 * announcement, always wins over a pre-emptive edit-materialize; this
 * closed the prior residual where the fabricated content could stand
 * forever). Either way, this function's own read of `row` here already
 * reflects whichever of those two states is current — there is nothing
 * further for MARKER-AUTH-style retroactive checking to do on this branch.
 *
 * Ordering (round-2 remediation finding 2): `slotId`'s OWN candidate-vs-
 * marker winner is resolved FIRST, via the shared `resolveKnownRowAgainstStores`,
 * BEFORE the general thread sweep runs. This matters for a multi-e-tag
 * delete of an already-edited message (D14): such a delete e-tags BOTH the
 * original id O and the prior replacement id P, buffering two pending
 * entries sharing one rumorId. If the general sweep ran FIRST (as round 1
 * did) and reached P's now-TTL-expired, no-known-row entry before O's own
 * resolution got a chance to run, P's expiry would call
 * `removePendingByRumorId` — which filters by rumorId ALONE, with no
 * awareness of `skipTargetId` — and silently delete O's own sibling entry
 * out from under this very call, before O ever got to consume it. Resolving
 * O first means its rumor-id-group cleanup (finding 6) removes P's sibling
 * entry itself, as part of a successful resolution, before the general
 * sweep ever gets a chance to reach P through the no-longer-existing entry.
 */
export function resolvePendingSignalsForSlot(
  thread: MessageEditsThreadKey,
  slotId: string,
  originalAuthorPubkeyHex: string,
): Promise<ChangeResult> {
  return serialize(async () => {
    const threadKey = groupIdFor(thread);

    const { messages } = await loadMessages(threadKey);
    const row = messages.find((m) => m.id === slotId);
    if (!row) {
      // No row for this slot yet — nothing of its own to resolve. Still run
      // the general sweep so other thread activity (self-heal / TTL expiry)
      // is not starved just because this particular slot has no row.
      await sweepExpiredForThreadKeyLocked(threadKey);
      return { thread, slotId, kind: 'noop' as const };
    }

    const result = await resolveKnownRowAgainstStores(threadKey, row, originalAuthorPubkeyHex);

    // THEN sweep the rest of the thread (self-heal / TTL-expiry) — slotId
    // itself is already fully resolved above (and excluded here as a
    // belt-and-suspenders guard), so nothing in this sweep can revisit it.
    await sweepExpiredForThreadKeyLocked(threadKey, slotId);

    return { thread, ...result };
  });
}

/**
 * Clears all four IDB namespaces this module owns (pending, markers,
 * slot meta, pinned revs). Wired into
 * storage.ts's clearAccountScopedIdbData so a pending signal, delete
 * marker, or slot-meta entry from a previous identity never leaks into a
 * newly-switched-to identity's session (mirrors clearAllReactions /
 * clearAllMessages's existing account-switch hygiene).
 */
export async function clearAllMessageEditsState(): Promise<void> {
  await Promise.allSettled([
    set(PENDING_SIGNALS_KEY, []),
    set(DELETE_MARKERS_KEY, []),
    set(SLOT_META_KEY, []),
    set(PINNED_REVS_KEY, []),
  ]);
}

/**
 * Clears this module's IDB namespaces (all four) for a SINGLE thread (round-2
 * remediation finding 5), as opposed to `clearAllMessageEditsState`'s
 * cross-thread account-switch sweep. Wired into chatPersistence.ts's
 * `clearMessages` (group leave) and `purgeStrangerDmThreads` (stranger
 * purge) so a pending signal, delete marker, or slot-meta entry never
 * outlives the ChatMessage rows it refers to for that thread — privacy-
 * relevant for `purgeStrangerDmThreads` specifically (a stranger's buffered
 * delete must not survive the purge) and also closes an unbounded-growth
 * path finding 4's cap/TTL alone does not fully address for a thread that is
 * torn down long before its entries would otherwise be evicted or expire.
 *
 * `threadKey` is the SAME string `groupIdFor(thread)` produces (raw groupId
 * for a group thread; `dm:<peerHexLower>` for a DM thread) — callers outside
 * this module reconstruct it the same way chatPersistence's own storage key
 * is derived (`few:messages:${threadKey}`), since this module has no
 * `MessageEditsThreadKey` to reconstruct from inside chatPersistence.ts.
 */
export async function clearMessageEditsStateForThread(threadKey: string): Promise<void> {
  await serialize(async () => {
    const [pending, markers, slotMeta] = await Promise.all([
      readPendingAll(),
      readMarkersAll(),
      readSlotMetaAll(),
    ]);
    const nextPending = pending.filter((e) => e.threadKey !== threadKey);
    const nextMarkers = markers.filter((m) => m.threadKey !== threadKey);
    const nextSlotMeta = slotMeta.filter((m) => m.threadKey !== threadKey);

    const writes: Promise<unknown>[] = [];
    if (nextPending.length !== pending.length) writes.push(writePendingAll(nextPending));
    if (nextMarkers.length !== markers.length) writes.push(writeMarkersAll(nextMarkers));
    if (nextSlotMeta.length !== slotMeta.length) writes.push(set(SLOT_META_KEY, nextSlotMeta));
    writes.push(removePinsForThread(threadKey));
    await Promise.all(writes);
  });
}
