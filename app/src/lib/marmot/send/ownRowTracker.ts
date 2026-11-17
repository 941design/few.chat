/**
 * ownRowTracker — the lifecycle of an OWN optimistic send (D6, D13; epic
 * marmot-library-adoption, Order-Sensitive Composition #2).
 *
 * An own message is shown at once (optimistic row), sent with `group.send`, and
 * later confirmed by the history sink delivering it back (`onOwnEcho`), whatever
 * the order versus the resolution of `send()`. This tracker owns the per-row
 * status and applies one rule set to every arrival order:
 *
 *   status      sending | confirmed | failed   (reported to the app through `setStatus`)
 *
 *   echo        sink delivery of the row's rumor id            -> confirmed (also flips failed)
 *   withdraw    explicit sink withdraw of an own entry         -> failed (the ONLY downgrade of a
 *                                                                 confirmed row), never deleted
 *   triggers    (a) `send()` rejected                          -> failed
 *               (b) `intentFailed` naming the row's OWN intent -> failed (matched by intent id, see bindIntent)
 *               (c) `groupBranchSwitched` for the row's group  -> failed
 *               (d) still unconfirmed `timeoutMs` after `send()` resolved -> failed
 *               each acts ONLY on an unconfirmed row: a row confirmed through the sink is never
 *               downgraded by a trigger.
 *
 * There is NO automatic resend (AC-WDR-2/AC-WDR-3). A failed row ends in the failed/retry state and the user
 * retries: `retry(groupId, rumorId)` hands back the STORED rumor (same id) and returns the row to `sending`;
 * the sender re-sends exactly that rumor (never rebuilds it): peers dedupe by rumor id, so a retry whose
 * first attempt did reach the group is harmless, while a rebuilt rumor (new `created_at` -> new id) would be
 * a duplicate message.
 *
 * Wiring (S18): `onOwnEcho` / `onOwnWithdrawn` are the chat handler's required ports
 * (`createGroupChatHandler` deps); `onIntentFailed` / `onGroupBranchSwitched` are the client
 * lifecycle listeners (`clientEvents.intentFailed` / `groupBranchSwitched`).
 * None of them calls an account-scope client method, so they are safe inside a library frame.
 *
 * Own optimistic signals (poll votes, edits, deletes, reactions) not yet echoed: a recompute of
 * their poll / slot folds only the sink's remaining rows and would reset them. Decision (S6):
 * the tracker keeps the signal's rumor while the row is `sending` and hands it back through
 * `pendingSignals(groupId)`, so the recompute caller re-applies it from the own-send state after
 * the fold. A signal that failed or was withdrawn is NOT carried: it is dropped (AC-WDR-2).
 *
 * Pure module: no React, no browser API; timers are the global ones, looked up at call time.
 */
import type { Rumor } from '@941design/nostr-events/event';

export type OwnRowStatus = 'sending' | 'confirmed' | 'failed';

/** The app side of the row state: where `confirmed` / `failed` are shown / persisted. REQUIRED. */
export interface OwnRowStatusPort {
  /**
   * Called on every status transition after the row exists: into `confirmed` or `failed`, and back into
   * `sending` on a `retry` (never for the initial `sending` of `register`, never when the status does not
   * change). The status is MULTI-transition: failed -> confirmed (late echo), confirmed -> failed (own withdraw),
   * failed -> sending (retry). `failed` means failed/retry (keep the row); only the app decides to drop one. Must tolerate a row it does not know (a row of an earlier session, a
   * signal that has no row) and must not throw.
   */
  setStatus: (groupId: string, rumorId: string, status: OwnRowStatus) => void;
  /**
   * The tracker dropped the row (`forget`, `forgetGroup`, `maxFailedRetained` / `maxConfirmedRetained` eviction): the
   * tracker will never report on it again and `retry` is gone, so the app MUST drop everything it keeps for the row
   * (status record, pending send) and tell its views: a dropped row left behind would show `sending` forever with no
   * way to retry. "failed keeps the row" holds for LIVE rows only; a forgotten row is gone.
   */
  forget?: (groupId: string, rumorId: string) => void;
}

export interface OwnRowTrackerOptions {
  ports: OwnRowStatusPort;
  /** D6 trigger (d): ms a row may stay unconfirmed after `send()` resolved. Default 60 000. */
  timeoutMs?: number;
  /** Confirmed rows kept (for carrier bookkeeping); the oldest beyond this are forgotten. Default 500. */
  maxConfirmedRetained?: number;
  /** Failed rows kept (for retry / a late echo); the oldest beyond this are forgotten. Default 500. */
  maxFailedRetained?: number;
}

export const OWN_SEND_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONFIRMED = 500;

export interface RegisterOptions {
  /** The stored rumor of the row: what `retry` hands back. Also carried over a recompute while `sending` when `signal`. */
  rumor?: Rumor;
  /** The rumor is an optimistic own SIGNAL (vote, edit, delete, reaction): `pendingSignals` returns it while `sending`. Default FALSE: a plain row is never carried over a recompute unless the caller says so. */
  signal?: boolean;
}

export interface OwnRowTracker {
  /** An optimistic own row exists now (status `sending`). Call BEFORE `group.send`. Re-registering a known row is a no-op. */
  register: (groupId: string, rumorId: string, options?: RegisterOptions) => void;
  /**
   * The send generation of a row: 0 at `register`, +1 on every `retry`; undefined for an unknown row. The sender
   * captures it when it dispatches and passes it to `sendResolved` / `sendRejected` / `bindIntent`, so the results of
   * an OLDER attempt (a first send that settles after a retry began) never touch the retried row.
   */
  attemptOf: (groupId: string, rumorId: string) => number | undefined;
  /** `group.send` resolved: the 60 s confirmation clock starts (unless the row is already confirmed or failed). */
  sendResolved: (groupId: string, rumorId: string, attempt?: number) => void;
  /**
   * (`attempt`, here and in `sendResolved` / `sendRejected`: ignored unless it is the row's current generation, see `attemptOf`; omitted = current.)
   * Records the library intent that carries the row's send (an application intent id, or the queue id of a queued
   * rumor). `intentFailed` fails only rows bound to the failed intent's id: the library never reports which
   * rumor an intent carries, the sender infers the id from `pendingIntents()`.
   */
  bindIntent: (groupId: string, rumorId: string, intentId: string, attempt?: number) => void;
  /**
   * Retry of a `failed` row: returns the STORED rumor (same id) and returns the row to `sending` (reported to the
   * port); undefined for a row that is not `failed` or has no stored rumor. Never rebuilds the rumor.
   */
  retry: (groupId: string, rumorId: string) => Rumor | undefined;
  /** `group.send` rejected (trigger a). */
  sendRejected: (groupId: string, rumorId: string, attempt?: number) => void;
  /**
   * Sink delivered an own message (handler port `onOwnEcho`). Called for EVERY own delivery, including
   * rejected / edit-signal outcomes and rows of earlier sessions: a missing row is tolerated (no entry, no
   * status call). `eventId` (the kind-445 carrier) is optional bookkeeping for `onOwnWithdrawn`.
   */
  onOwnEcho: (groupId: string, rumorId: string, eventId?: string) => void;
  /**
   * Sink withdrew an own message (handler port `onOwnWithdrawn`): the row ends failed/retry, never deleted.
   * Ignored when the row is confirmed by a DIFFERENT carrier than `eventId` (both known). A row the tracker
   * does not know is still reported failed (its stored row exists: the handler checked) but NOT tracked: no
   * row is created, so a stream of withdraws of unknown ids cannot grow the tracker.
   */
  onOwnWithdrawn: (groupId: string, rumorId: string, eventId?: string) => void;
  /** `intentFailed` listener (trigger b): the unconfirmed rows bound to `intentId` fail; an intent no row is bound to (not an own send, another session) is ignored. */
  onIntentFailed: (event: { groupId: string; intentId: string }) => void;
  /** `groupBranchSwitched` listener (trigger c): every unconfirmed row of the group fails. */
  onGroupBranchSwitched: (event: { groupId: string }) => void;
  statusOf: (groupId: string, rumorId: string) => OwnRowStatus | undefined;
  /** The rumors of own optimistic signals still `sending` in the group (to re-apply after a recompute). */
  pendingSignals: (groupId: string) => Rumor[];
  /** Forgets a row (the app dropped it, e.g. the user discarded a failed row). Clears its timer. */
  forget: (groupId: string, rumorId: string) => void;
  /** Forgets every row of a group (the group was left / purged). Clears their timers. */
  forgetGroup: (groupId: string) => void;
  /** Clears every timer; later calls are ignored. */
  dispose: () => void;
}

interface Row {
  groupId: string;
  rumorId: string;
  status: OwnRowStatus;
  /** The stored rumor (retry); `signal` says whether `pendingSignals` carries it while sending. */
  rumor: Rumor | undefined;
  signal: boolean;
  /** Send generation: bumped by `retry` (see `OwnRowTracker.attemptOf`). */
  attempt: number;
  /** Library intents carrying the current send of the row. */
  intentIds: Set<string>;
  /** Kind-445 event ids that confirmed this row (only the ones the caller reported). */
  carriers: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const keyOf = (groupId: string, rumorId: string) => `${groupId}\u0000${rumorId}`;

export function createOwnRowTracker(options: OwnRowTrackerOptions): OwnRowTracker {
  if (!options || typeof options !== 'object' || !options.ports || typeof options.ports.setStatus !== 'function') {
    throw new TypeError('createOwnRowTracker: ports.setStatus is required');
  }
  const timeoutMs = options.timeoutMs ?? OWN_SEND_CONFIRM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('createOwnRowTracker: timeoutMs must be a positive number');
  const maxConfirmed = options.maxConfirmedRetained ?? DEFAULT_MAX_CONFIRMED;
  if (!Number.isInteger(maxConfirmed) || maxConfirmed < 1) throw new TypeError('createOwnRowTracker: maxConfirmedRetained must be a positive integer');
  const maxFailed = options.maxFailedRetained ?? DEFAULT_MAX_CONFIRMED;
  if (!Number.isInteger(maxFailed) || maxFailed < 1) throw new TypeError('createOwnRowTracker: maxFailedRetained must be a positive integer');
  const { setStatus } = options.ports;

  const rows = new Map<string, Row>();
  let disposed = false;

  const report = (groupId: string, rumorId: string, status: OwnRowStatus) => {
    try {
      setStatus(groupId, rumorId, status);
    } catch (err) {
      console.warn('[ownRowTracker] setStatus failed', err);
    }
  };
  const drop = (key: string, row: Row) => {
    clearTimer(row);
    rows.delete(key);
    try {
      options.ports.forget?.(row.groupId, row.rumorId);
    } catch (err) {
      console.warn('[ownRowTracker] forget failed', err);
    }
  };
  const clearTimer = (row: Row) => {
    if (row.timer !== undefined) {
      globalThis.clearTimeout(row.timer);
      row.timer = undefined;
    }
  };
  const set = (row: Row, status: 'confirmed' | 'failed') => {
    clearTimer(row);
    if (row.status === status) return;
    row.status = status;
    // A failed signal is not carried over a recompute (pendingSignals returns `sending` rows only); the
    // stored rumor stays for `retry`.
    if (status === 'failed') row.carriers.clear();
    report(row.groupId, row.rumorId, status);
    if (status === 'failed') prune('failed', maxFailed, row);
  };
  const failIfUnconfirmed = (row: Row) => {
    if (row.status === 'sending') set(row, 'failed');
  };
  const prune = (status: 'confirmed' | 'failed', cap: number, keep?: Row) => {
    let count = 0;
    for (const row of rows.values()) if (row.status === status) count += 1;
    if (count <= cap) return;
    for (const [key, row] of [...rows]) {
      if (count <= cap) break;
      if (row.status === status && row !== keep) {
        drop(key, row);
        count -= 1;
      }
    }
  };
  const failGroup = (groupId: string, intentId?: string) => {
    if (disposed) return;
    for (const row of [...rows.values()]) {
      if (row.groupId === groupId && (intentId === undefined || row.intentIds.has(intentId))) failIfUnconfirmed(row);
    }
  };

  return {
    register(groupId, rumorId, opts) {
      if (disposed) return;
      const key = keyOf(groupId, rumorId);
      if (rows.has(key)) return;
      rows.set(key, {
        groupId, rumorId, status: 'sending', rumor: opts?.rumor, signal: opts?.signal ?? false, attempt: 0, intentIds: new Set(), carriers: new Set(), timer: undefined,
      });
    },

    attemptOf: (groupId, rumorId) => rows.get(keyOf(groupId, rumorId))?.attempt,

    bindIntent(groupId, rumorId, intentId, attempt) {
      if (disposed) return;
      const row = rows.get(keyOf(groupId, rumorId));
      if (row && (attempt === undefined || attempt === row.attempt)) row.intentIds.add(intentId);
    },

    retry(groupId, rumorId) {
      if (disposed) return undefined;
      const row = rows.get(keyOf(groupId, rumorId));
      if (!row || row.status !== 'failed' || !row.rumor) return undefined;
      clearTimer(row);
      row.intentIds.clear();
      row.attempt += 1;
      row.status = 'sending';
      report(groupId, rumorId, 'sending');
      return row.rumor;
    },

    sendResolved(groupId, rumorId, attempt) {
      if (disposed) return;
      const row = rows.get(keyOf(groupId, rumorId));
      if (!row || (attempt !== undefined && attempt !== row.attempt) || row.status !== 'sending' || row.timer !== undefined) return;
      row.timer = globalThis.setTimeout(() => {
        row.timer = undefined;
        if (!disposed) failIfUnconfirmed(row);
      }, timeoutMs);
    },

    sendRejected(groupId, rumorId, attempt) {
      if (disposed) return;
      const row = rows.get(keyOf(groupId, rumorId));
      if (row && (attempt === undefined || attempt === row.attempt)) failIfUnconfirmed(row);
    },

    onOwnEcho(groupId, rumorId, eventId) {
      if (disposed) return;
      const row = rows.get(keyOf(groupId, rumorId));
      if (!row) return;
      if (eventId) row.carriers.add(eventId);
      set(row, 'confirmed');
      prune('confirmed', maxConfirmed, row);
    },

    onOwnWithdrawn(groupId, rumorId, eventId) {
      if (disposed) return;
      const key = keyOf(groupId, rumorId);
      const row = rows.get(key);
      if (!row) {
        // Unknown row: the app's stored row exists (the handler checked). Report, do not track.
        report(groupId, rumorId, 'failed');
        return;
      }
      if (row.status === 'confirmed' && eventId !== undefined && row.carriers.size > 0) {
        // Withdrawing one carrier keeps a row another carrier confirmed.
        if (!row.carriers.has(eventId)) return;
        row.carriers.delete(eventId);
        if (row.carriers.size > 0) return;
      }
      set(row, 'failed');
    },

    onIntentFailed: (event) => failGroup(event.groupId, event.intentId),
    onGroupBranchSwitched: (event) => failGroup(event.groupId),

    statusOf: (groupId, rumorId) => rows.get(keyOf(groupId, rumorId))?.status,

    pendingSignals(groupId) {
      const out: Rumor[] = [];
      for (const row of rows.values()) if (row.groupId === groupId && row.status === 'sending' && row.signal && row.rumor) out.push(row.rumor);
      return out;
    },

    forget(groupId, rumorId) {
      const key = keyOf(groupId, rumorId);
      const row = rows.get(key);
      if (row) drop(key, row);
    },

    forgetGroup(groupId) {
      for (const [key, row] of [...rows]) if (row.groupId === groupId) drop(key, row);
    },

    dispose() {
      disposed = true;
      for (const row of rows.values()) clearTimer(row);
      rows.clear();
    },
  };
}
