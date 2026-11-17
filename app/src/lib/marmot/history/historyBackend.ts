/**
 * historyBackend.ts — the app's `HistoryBackend` (seam `GroupHistoryHandlers`).
 *
 * The library retains accepted group application messages through this sink
 * and calls it AT LEAST ONCE, in per-group order, retrying a call that throws
 * or does not settle within 10 s (5 attempts, then it gives the entry up).
 * This module turns that into: persist the row, run the app's handlers, mark
 * the row dispatched. The sink is itself at-least-once: a crash between the
 * handler completing and the `dispatched:true` write re-runs the handler on
 * recovery, so idempotency per `(groupId, eventId)` is the HANDLER's obligation.
 *
 * The rows live in one database per account (`few-group-history:<pubkey>`), the
 * same scope as the library store and its lease: a device-wide store would let one
 * account's dispatched rows suppress another account's dispatch of the same ids.
 *
 *  append(entry)    row `{entry, seq, dispatched:false}` is written first (a
 *                   no-op if it exists), then `handlers.dispatch`, then the row
 *                   is rewritten `dispatched:true`. A repeat for a dispatched
 *                   row returns; for an undispatched row it re-runs the handlers
 *                   (the row keeps its `seq`). A handler failure or timeout makes
 *                   the call reject (the library retries) and leaves the row
 *                   `dispatched:false` for recovery. This includes a row ABANDONED by
 *                   the recovery poison bound: a LIVE library append of that id is a
 *                   legitimate retry, so it re-runs the handlers; success marks the
 *                   row dispatched (clearing `abandoned`), failure rejects and leaves
 *                   it abandoned (recovery still skips it).
 *  withdraw(...)    (1) durably MARKS every existing row of the batch `withdrawing` (such a row is
 *                   already gone for `remaining()` and `list()`); (2) first-touch recovery (below);
 *                   (3) waits (one settle bound) for a still-running dispatch of a withdrawn id (one
 *                   that outlives the bound retracts itself on completion); (4) finishes the marked
 *                   rows in `seq` order with INCREMENTAL progress: each row is retracted and then
 *                   deleted at once, each step under its own settle bound (the call as a whole may
 *                   therefore outlast one bound when many aggregates need a recompute). A timeout or
 *                   a failing retract leaves the earlier rows deleted and the rest marked; the next
 *                   `append` / `withdraw` of the group in this instance finishes them first, and a
 *                   restart finds them by first-touch recovery. An id with no row is a no-op (also
 *                   when the withdraw came BEFORE the append: no tombstone is kept). Retract is an
 *                   idempotent recompute, so repeating one is safe. `RetractInput.batch` names every
 *                   row of the finish, so a dispatch layer can run ONE recompute per aggregate.
 *                   Retract receives `remaining()`: the group's rows that are `dispatched` and not
 *                   `withdrawing`, in `seq` order, each with its persisted `receivedAt`. It is
 *                   read once per batch and memoised, so every retract of a batch (and a late
 *                   retract, which reads it at its own start) sees one snapshot that includes
 *                   none of the batch's rows. Rows that were never dispatched (or were abandoned)
 *                   are never in it. Handlers of dependent kinds (5, edit-marked 9, 7, 10-12)
 *                   recompute their aggregate from it (recompute-on-retract); a `purged` retract
 *                   removes outright and never reads it. A row that is still `dispatched:false` is
 *                   not in it: a recompute before its (re-)dispatch resets that row's effects and the
 *                   re-dispatch applies them again (accepted).
 *                   `receivedAt` is the first-append wall clock (set once, persisted): the
 *                   deterministic clock of a recompute AND of the row's own dispatch
 *                   (`GroupRumorInput.receivedAt`), so a late dispatch and a later fold of the row
 *                   decide the same way. A row without one (written before it existed) reads as
 *                   `rumor.created_at * 1000`.
 *  list(groupId)    entries in `seq` order.
 *  purge(groupId)   every row of that group, nothing of any other group. First waits (one settle
 *                   bound) for dispatches still running for the group; one that outlives the bound
 *                   retracts itself once on completion, and no in-flight entry of the group survives
 *                   the purge (a later re-join dispatches fresh).
 *  dispose()        stops recovery between rows, rejects every later call, clears the in-memory
 *                   state, and returns a promise that resolves once the per-group serialised jobs
 *                   have settled (bounded by one settle bound). The bootstrap teardown awaits it
 *                   BEFORE `client.dispose()`. Late retracts still pending at dispose are dropped:
 *                   a withdrawn message whose dispatch completes after dispose keeps its effects;
 *                   accepted: the account's stores are closing.
 *  sweep()          startup recovery of the groups no live call touched yet (sweep.ts).
 *
 * Undispatched-row recovery (AC-HIST-7). Per backend instance, before the first
 * `append` or `withdraw` of a group runs, that group's `dispatched:false` rows
 * are re-dispatched in `seq` order inside the SAME per-group serialised job, so
 * no newer entry of the group is dispatched ahead of them; this happens once
 * per group per instance (in-memory touched set). `sweep()` runs the same
 * recovery for every group with an undispatched row that no live call touched
 * yet (the bootstrap calls it after `groups.list()`, before `inbox.start()`:
 * the library starts each group's history drain during `groups.list()`, so
 * the first-touch recovery is what keeps recovered rows ahead of live ones).
 * Recovery FIRST finishes every `withdrawing` row of the group (retract, then delete), so a
 * crash anywhere inside a withdraw converges before any re-dispatch (a withdrawing row is
 * never re-dispatched, and a live append of its id finishes the withdrawal first, then
 * stores a fresh row).
 * A recovery failure leaves the row `dispatched:false`, does not stop the
 * group's later rows or other groups, and never rejects the triggering call.
 * Each recovery attempt is bounded by the settle timeout on its own, so a
 * triggering call can take longer than one bound when several rows hang.
 * Poison bound: a failed recovery is counted on the row (persisted); at
 * `MAX_RECOVERY_FAILURES` (5, the library's own attempt cap) the row is marked
 * `abandoned`, never recovered again, and reported once through `onError`. A transient client state
 * (MarmotError `disposed` / `no-lease`, e.g. teardown during a background sweep) is
 * reported but NOT counted.
 *
 * Rules this module owns:
 *   - `sender` handed to the handlers is `entry.orderingKey.account` (the MLS
 *     authenticated sender), never the rumor's own `pubkey` field (ADR-012 as
 *     superseded, D16). A structural test scans this directory for that.
 *   - Every call settles within `settleTimeoutMs` (10 s): the library waits for
 *     a timed-out call to actually settle before it issues the next one for the
 *     group, so a never-settling handler would otherwise stall the group for
 *     good. A call that times out is abandoned: it starts no further step
 *     (no handler run, no row rewrite or delete) after the step that was in
 *     progress at the bound. Precisely: an idb write already issued when the
 *     bound hits may still land (an undispatched row, which recovery handles);
 *     a handler already running may still finish (see the in-flight map).
 *   - Operations are serialised per group (the library does so per client, the
 *     sweep and a second tab do not).
 *   - A per-(groupId, eventId) in-flight map keeps a dispatch that outlived its
 *     timeout from being started a second time: a re-append, recovery or sweep of
 *     an id still in flight awaits the running promise (bounded again). The
 *     residual overlap: after a timeout a LATER entry's dispatch may run
 *     concurrently with the still-running earlier one, so handlers of kinds that
 *     depend on an earlier entry (5/7/10-12) must tolerate a missing target.
 *   - Handlers must not await account-scope client calls; follow-up client work
 *     goes onto the owned FIFO as the LAST action of the handler, after its own
 *     awaits (architecture Boundary Rules, ClientJobQueue).
 *   - Only rumor kinds in the app registry (`APP_RUMOR_KINDS`) reach the
 *     handlers; any other kind is stored as already dispatched and never
 *     dispatched or retracted. This is permanent: history received under a kind
 *     that is unregistered at the time is not replayed if the kind is
 *     registered later.
 *
 * Pure module: no React, no context, no client construction.
 */
import { isMarmotError, type HistoryBackend, type HistoryEntry } from '@941design/marmot';
import type { Rumor } from '@941design/nostr-events/event';
import { APP_RUMOR_KINDS } from '../kinds';
import { assertAccountPubkey, createAccountHistoryStore, rowKey, type HistoryRow, type HistoryStore } from './historyStore';
import { sweepUndispatched, type SweepResult } from './sweep';

/** What the app handlers receive per accepted (or withdrawn) group rumor. */
export interface GroupRumorInput {
  groupId: string;
  /** kind-445 event id that carried the rumor (not `rumor.id`). */
  eventId: string;
  rumor: Rumor;
  /** `HistoryEntry.orderingKey.account`: the authenticated sender. */
  sender: string;
  /**
   * The row's persisted first-append time (ms): THE clock of a dispatch, identical to the clock a recompute folds
   * the same row with (`RemainingRow.receivedAt`), so a late dispatch (a recovered row) and a later fold of that row
   * decide the same way. Absent only on inputs built by tests / the late retract of a vanished row; handlers then
   * fall back to the wall clock.
   */
  receivedAt?: number;
  /**
   * Retract only. Absent means `'withdrawn'`: the library withdrew the entry (a fork rewind). `'purged'` is a late
   * retract of a dispatch that outlived a group purge (the group was left): the group's data is going away, so a
   * handler must REMOVE what the dispatch wrote — in particular an own message must not be parked as failed/retry
   * in a group that is no longer held.
   */
  reason?: 'withdrawn' | 'purged';
}

/** Why a retract runs; see `GroupRumorInput.reason`. */
type RetractReason = 'withdrawn' | 'purged';

/** A history row that survives a withdraw: what a recompute folds (dispatched, not withdrawing). */
export interface RemainingRow {
  entry: HistoryEntry;
  /** Per-group delivery counter (the fold order). */
  seq: number;
  /** Wall-clock ms the row was first appended (persisted); the deterministic clock of a recompute. */
  receivedAt: number;
}

/**
 * What a retract receives: the withdrawn rumor plus `remaining()`, the group's dispatched, non-withdrawing rows in
 * `seq` order. Read ONCE per withdraw batch and memoised, so every retract of a batch sees the same snapshot (no
 * intermediate state of the batch is ever folded). Handlers of dependent kinds (5, edit-marked 9, 7, 10, 11, 12)
 * recompute their aggregate from it; `reason: 'purged'` retracts remove outright and never read it.
 */
export interface RetractInput extends GroupRumorInput {
  remaining: () => Promise<readonly RemainingRow[]>;
  /**
   * Every row withdrawn together with this one (the whole finish batch, this row included, in `seq` order). All of
   * them are absent from `remaining()`, so ONE recompute of an aggregate accounts for every withdrawn row naming
   * it; a handler uses this to drop the state keyed to ALL of them (e.g. pinned revs). Absent on a late retract.
   */
  batch?: readonly GroupRumorInput[];
}

/**
 * Seam `GroupHistoryHandlers`. Invariants:
 *  - `dispatch` is idempotent per `(groupId, eventId)` and throws on a durable
 *    failure so the library retries;
 *  - `retract` of an unseen event id is a no-op and undoes the stored effects
 *    of a withdrawn message (effects already emitted, e.g. a bell, stay);
 *  - neither awaits an account-scope client call;
 *  - rows still `dispatched:false` (undispatched, recovering or abandoned) are NOT in `remaining()`: a recompute
 *    that runs before they are (re-)dispatched resets their effects, and the re-dispatch applies them again
 *    (accepted: no row is folded before its own dispatch completed, so a recompute never applies an effect the
 *    sink has not committed to).
 */
export interface GroupHistoryHandlers {
  dispatch: (input: GroupRumorInput) => Promise<void>;
  retract: (input: RetractInput) => Promise<void>;
}

/** Matches the library's `HISTORY_BACKEND_TIMEOUT_MS`. */
export const HISTORY_SETTLE_TIMEOUT_MS = 10_000;

/** Failed recoveries after which a row is abandoned (the library's own attempt cap). */
export const MAX_RECOVERY_FAILURES = 5;

export interface HistoryBackendOptions {
  /** Required: a sink without handlers would store messages and silently do nothing. */
  handlers: GroupHistoryHandlers;
  /**
   * The account the sink belongs to (64-char lowercase hex): names the `few-group-history:<pubkey>` database.
   * Required unless an explicit `store` is injected (tests); there is no device-global default store.
   */
  accountPubkey?: string;
  /** Overrides the account's idb store (tests). */
  store?: HistoryStore;
  /** Per-call settle bound; defaults to 10 s. */
  settleTimeoutMs?: number;
  /** Receives recovery failures (and the one-time abandonment report). Defaults to `console.warn`. */
  onError?: (error: unknown, ctx: { groupId: string; eventId: string }) => void;
}

export interface AppHistoryBackend extends HistoryBackend {
  // The app backend always returns promises (narrowing the library's `void | Promise<void>`).
  append(entry: HistoryEntry): Promise<void>;
  withdraw(groupId: string, eventIds: readonly string[]): Promise<void>;
  list(groupId: string): Promise<readonly HistoryEntry[]>;
  purge(groupId: string): Promise<void>;
  /** Startup recovery of groups no live call touched yet (call after `groups.list()`, before `inbox.start()`). */
  sweep(): Promise<SweepResult>;
  /**
   * Stops recovery between rows, makes every later store write a no-op, rejects later calls, clears in-memory
   * state, then resolves when the per-group serialised jobs have settled (at most one settle bound; never
   * rejects). Idempotent: later calls return the same promise. One backend instance per bootstrap; a disposed
   * backend rejects every call.
   *
   * Pending late retracts are dropped: a withdrawn message whose dispatch completes after dispose keeps its
   * effects; accepted: the account's stores are closing.
   */
  dispose(): Promise<void>;
}

/**
 * MarmotError codes that describe the client's state (teardown / lease), not a poisoned row. `reentrant` is NOT
 * transient: a deterministic reentrant is a handler bug and must count towards abandonment.
 */
const TRANSIENT_CLIENT_CODES = ['disposed', 'no-lease'] as const;
const isTransientClientError = (error: unknown): boolean =>
  TRANSIENT_CLIENT_CODES.some((code) => isMarmotError(error, code));

/** Attempts (including the first) of a late retract before it is reported. */
const LATE_RETRACT_ATTEMPTS = 3;

class SettleTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`history sink: ${what} did not settle within ${ms} ms`);
    this.name = 'HistorySettleTimeoutError';
  }
}

/** Set once a call timed out: whatever it still has in flight must not write. */
interface CallState {
  abandoned: boolean;
}

function bounded<T>(what: string, ms: number, run: (state: CallState) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const state: CallState = { abandoned: false };
    const timer = setTimeout(() => {
      state.abandoned = true;
      reject(new SettleTimeoutError(what, ms));
    }, ms);
    let inner: Promise<T>;
    try {
      inner = run(state);
    } catch (error) {
      inner = Promise.reject(error);
    }
    inner.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createGroupSerializer() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(groupId: string, job: () => Promise<T>): Promise<T> {
      const previous = tails.get(groupId) ?? Promise.resolve();
      const result = previous.then(job, job);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(groupId, tail);
      void tail.then(() => {
        if (tails.get(groupId) === tail) tails.delete(groupId);
      });
      return result;
    },
    /** Resolves when every group's current job chain has settled (jobs queued later are not awaited). */
    settled(): Promise<void> {
      return Promise.all([...tails.values()]).then(() => undefined);
    },
  };
}

function requireHandlers(handlers: GroupHistoryHandlers | undefined): GroupHistoryHandlers {
  if (!handlers || typeof handlers.dispatch !== 'function' || typeof handlers.retract !== 'function') {
    throw new TypeError('createHistoryBackend: required dependency "handlers" (dispatch + retract) is missing');
  }
  return handlers;
}

const HEX = /^[0-9a-f]+$/i;

/**
 * groupId (MLS group id hex) and eventId (kind-445 nostr event id) are hex in the library. A non-hex id is rejected
 * (the library retries, then gives the entry up) and nothing is written: ids are joined as `groupId:eventId` in row
 * keys and the in-flight map, so a `:` inside either could make two distinct entries collide.
 */
function assertEntry(entry: HistoryEntry): void {
  if (
    !entry ||
    typeof entry.groupId !== 'string' ||
    entry.groupId === '' ||
    typeof entry.eventId !== 'string' ||
    entry.eventId === '' ||
    !entry.rumor ||
    typeof entry.orderingKey?.account !== 'string' ||
    entry.orderingKey.account === ''
  ) {
    throw new TypeError('history sink: entry needs groupId, eventId, rumor and orderingKey.account');
  }
  if (!HEX.test(entry.groupId) || !HEX.test(entry.eventId)) {
    throw new TypeError('history sink: groupId and eventId must be hex');
  }
}

const REGISTERED_KINDS: readonly number[] = APP_RUMOR_KINDS;
const isRegisteredKind = (entry: HistoryEntry): boolean => REGISTERED_KINDS.includes(entry.rumor.kind);

/** The row's clock: its persisted first-append time; a row written before it existed reads as `rumor.created_at * 1000`. */
const receivedAtOf = (row: HistoryRow): number => row.receivedAt ?? row.entry.rumor.created_at * 1000;

const toRemaining = (row: HistoryRow): RemainingRow => ({ entry: row.entry, seq: row.seq, receivedAt: receivedAtOf(row) });

function inputOf(entry: HistoryEntry, reason?: RetractReason, receivedAt?: number): GroupRumorInput {
  const input: GroupRumorInput = {
    groupId: entry.groupId,
    eventId: entry.eventId,
    rumor: entry.rumor,
    sender: entry.orderingKey.account,
    ...(receivedAt !== undefined ? { receivedAt } : {}),
  };
  // Only the non-default reason is carried, so a plain withdraw keeps the original input shape.
  return reason === 'purged' ? { ...input, reason } : input;
}

export function createHistoryBackend(options: HistoryBackendOptions): AppHistoryBackend {
  const handlers = requireHandlers(options?.handlers);
  if (options.accountPubkey !== undefined || !options.store) assertAccountPubkey(options.accountPubkey);
  const rawStore = options.store ?? createAccountHistoryStore(options.accountPubkey as string);
  const settleMs = options.settleTimeoutMs ?? HISTORY_SETTLE_TIMEOUT_MS;
  const onError =
    options.onError ??
    ((error: unknown, ctx: { groupId: string; eventId: string }) => {
      console.warn(`[marmot/history] recovery failed for ${ctx.groupId}:${ctx.eventId}`, error);
    });
  const serial = createGroupSerializer();
  /** Groups whose first-touch recovery this instance has run. */
  const touched = new Set<string>();
  /** Dispatches still running (possibly past their timeout), keyed `groupId:eventId`. */
  const inFlight = new Map<string, Promise<void>>();
  /**
   * Ids withdrawn while their dispatch was still running past the bound: the row is gone, so the late dispatch's
   * effects would never be retracted. The dispatch's completion retracts them instead (and marks nothing).
   */
  const retractOnSettle = new Map<Promise<void>, RetractReason>();
  /**
   * Groups whose withdrawal finish did not complete in this instance (a timeout, a failing retract): marked rows are
   * left behind. The next `append` / `withdraw` of the group finishes them first; a restart finds them by first-touch
   * recovery. In-memory only, so the common path never re-reads the group's rows.
   */
  const leftover = new Set<string>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const disposedError = () => new Error('history sink: backend is disposed');
  /**
   * The backend's only view of the store: every write is a no-op once `disposed` is set, so a handler (or recovery /
   * late retract) that was in flight at dispose time can never land a write afterwards. This is what makes the
   * post-teardown `clearAllGroupHistory()` safe. (`nextSeq` reserves a counter, so it rejects instead.)
   */
  const store: HistoryStore = {
    getRow: (g, e) => rawStore.getRow(g, e),
    listRows: (g) => rawStore.listRows(g),
    listAllRows: () => rawStore.listAllRows(),
    putRow: async (row) => {
      if (!disposed) await rawStore.putRow(row);
    },
    deleteRow: async (g, e) => {
      if (!disposed) await rawStore.deleteRow(g, e);
    },
    purgeGroup: async (g) => {
      if (!disposed) await rawStore.purgeGroup(g);
    },
    nextSeq: async (g) => {
      if (disposed) throw disposedError();
      return rawStore.nextSeq(g);
    },
    clearAll: async () => {
      if (!disposed) await rawStore.clearAll();
    },
  };

  /** Starts the handlers for a row, or joins the dispatch of the same id that is still running. */
  const runDispatch = (entry: HistoryEntry, receivedAt: number): Promise<void> => {
    const key = `${entry.groupId}:${entry.eventId}`;
    let running = inFlight.get(key);
    if (running) {
      // The id is wanted again (a re-append / recovery joined it): a pending late retract no longer applies.
      retractOnSettle.delete(running);
    } else {
      const started = Promise.resolve().then(() => handlers.dispatch(inputOf(entry, undefined, receivedAt)));
      running = started;
      inFlight.set(key, started);
      const settle = () => {
        if (inFlight.get(key) === started) inFlight.delete(key);
        const reason = retractOnSettle.get(started);
        if (reason === undefined || !retractOnSettle.delete(started)) return;
        scheduleLateRetract(entry, reason);
      };
      started.then(settle, settle);
    }
    return running;
  };

  /**
   * Waits (at most one settle bound, errors ignored) for the dispatches still running under these `groupId:eventId`
   * keys. Dispatches still running at the bound are registered for a retract once they finish; their keys are returned.
   */
  const awaitInFlight = async (keys: readonly string[], reason: RetractReason): Promise<Set<string>> => {
    const pending = keys
      .map((key) => ({ key, running: inFlight.get(key) }))
      .filter((p): p is { key: string; running: Promise<void> } => p.running !== undefined);
    const stillRunning = new Set(pending.map((p) => p.key));
    if (pending.length === 0) return stillRunning;
    const done = Promise.all(
      pending.map((p) => {
        const gone = () => void stillRunning.delete(p.key);
        return p.running.then(gone, gone);
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, settleMs);
      }),
    ]);
    clearTimeout(timer);
    for (const p of pending) if (stillRunning.has(p.key)) retractOnSettle.set(p.running, reason);
    return stillRunning;
  };

  /** `remaining()` of a retract: dispatched, non-withdrawing rows of the group in `seq` order; read once (memoised). */
  const remainingReader = (groupId: string): (() => Promise<readonly RemainingRow[]>) => {
    let cached: Promise<readonly RemainingRow[]> | undefined;
    return () => (cached ??= store.listRows(groupId).then((rows) => rows.filter((r) => r.dispatched && !r.withdrawing).map(toRemaining)));
  };

  /**
   * Finishes every `withdrawing` row of the group, in `seq` order, with INCREMENTAL progress: each row is retracted
   * (registered kinds, except ids whose still-running dispatch retracts itself on completion) and then deleted
   * right away, each step under its own settle bound. Safe because `remaining()` already excludes every still-marked
   * row and a retract is an idempotent recompute: a failure or timeout at row k leaves rows before k deleted and the
   * rest marked, and the next append / withdraw / restart of the group continues from there. All retracts of the call
   * share one memoised `remaining()` read (taken after every mark of the batch was written) and see the whole batch
   * through `RetractInput.batch`, so a handler can recompute an aggregate ONCE for every withdrawn row naming it.
   * MUST run inside the group's serialised job. `parent` (an enclosing bounded call) stops the loop when it timed out.
   */
  const finishWithdrawing = async (
    groupId: string,
    parent?: CallState,
    lateRetract: ReadonlySet<string> = new Set(),
    skipEventIds: ReadonlySet<string> = new Set(),
  ): Promise<void> => {
    // `skipEventIds`: rows another step of the same call finishes itself (they stay marked, so `remaining()` omits them).
    const marked = (await store.listRows(groupId))
      .filter((row) => row.withdrawing && !skipEventIds.has(row.entry.eventId))
      .sort((a, b) => a.seq - b.seq);
    if (marked.length === 0) {
      if (skipEventIds.size === 0) leftover.delete(groupId);
      return;
    }
    const remaining = remainingReader(groupId);
    const batch = marked.map((row) => inputOf(row.entry, undefined, receivedAtOf(row)));
    try {
      for (const [i, row] of marked.entries()) {
        if (parent?.abandoned || disposed) {
          leftover.add(groupId);
          return;
        }
        await bounded(`withdraw ${row.entry.eventId}`, settleMs, async (state) => {
          // A still-running dispatch retracts itself when it finishes (retractOnSettle); retracting now would be a no-op.
          if (isRegisteredKind(row.entry) && !lateRetract.has(rowKey(groupId, row.entry.eventId))) {
            await handlers.retract({ ...batch[i], remaining, batch });
          }
          if (state.abandoned || parent?.abandoned) return; // the row stays marked; a retried withdraw retracts again
          await store.deleteRow(groupId, row.entry.eventId);
        });
      }
    } catch (error) {
      leftover.add(groupId);
      throw error;
    }
    if (skipEventIds.size === 0) leftover.delete(groupId);
  };

  /**
   * The retract of a dispatch that finished after its row was withdrawn / purged. Runs inside the group's serialised
   * job. Skipped when a row for the id exists again (the branch became canonical: the row's owner handles it).
   * Retried a bounded number of times, each attempt bounded by the settle timeout, then reported.
   */
  const scheduleLateRetract = (entry: HistoryEntry, reason: RetractReason): void => {
    const ctx = { groupId: entry.groupId, eventId: entry.eventId };
    serial
      .run(entry.groupId, async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < LATE_RETRACT_ATTEMPTS; attempt++) {
          if (disposed) return;
          try {
            await bounded(`late retract ${entry.eventId}`, settleMs, async (state) => {
              if (await store.getRow(entry.groupId, entry.eventId)) return;
              if (state.abandoned) return;
              await handlers.retract({ ...inputOf(entry, reason), remaining: remainingReader(entry.groupId) });
            });
            return;
          } catch (error) {
            lastError = error;
          }
        }
        report(lastError, ctx);
      })
      .catch((error: unknown) => report(error, ctx));
  };

  const report = (error: unknown, ctx: { groupId: string; eventId: string }) => {
    try {
      onError(error, ctx);
    } catch {
      /* an error reporter must never break the sink */
    }
  };

  /** Runs the handlers for a persisted, undispatched row and marks it dispatched. */
  const dispatchRow = async (row: HistoryRow, state: CallState): Promise<void> => {
    if (isRegisteredKind(row.entry)) await runDispatch(row.entry, receivedAtOf(row));
    if (state.abandoned) return;
    await store.putRow({ entry: row.entry, seq: row.seq, dispatched: true, ...(row.receivedAt !== undefined ? { receivedAt: row.receivedAt } : {}) });
  };

  /** Counts a failed recovery on the row; at the cap the row is abandoned and reported once. */
  const noteRecoveryFailure = async (row: HistoryRow, error: unknown): Promise<void> => {
    const ctx = { groupId: row.entry.groupId, eventId: row.entry.eventId };
    if (isTransientClientError(error)) {
      // The client is going away (or not ready), not the row's fault: leave the counter alone.
      report(error, ctx);
      return;
    }
    const failures = (row.recoveryFailures ?? 0) + 1;
    const abandoned = failures >= MAX_RECOVERY_FAILURES;
    try {
      await store.putRow({ ...row, recoveryFailures: failures, ...(abandoned ? { abandoned: true } : {}) });
    } catch (storeError) {
      report(storeError, ctx);
    }
    if (abandoned) {
      const gaveUp = new Error(`history sink: row abandoned after ${failures} failed recoveries`);
      (gaveUp as Error & { cause?: unknown }).cause = error;
      report(gaveUp, ctx);
    } else {
      report(error, ctx);
    }
  };

  /**
   * First-touch recovery of one group. MUST run inside the group's serialised job. Marks the group touched only
   * once its rows were read, so an unreadable store leaves it for the next call.
   */
  const recoverGroup = async (groupId: string, ownBatch?: ReadonlySet<string>): Promise<SweepResult> => {
    const result: SweepResult = { redispatched: 0, failed: 0 };
    if (touched.has(groupId)) return result;
    const all = await store.listRows(groupId);
    touched.add(groupId);
    // Withdrawals first: a row marked `withdrawing` (a crash inside a withdraw, or this very call's own batch) is
    // retracted and deleted BEFORE anything is re-dispatched, and is never re-dispatched itself (its irreversible
    // effects must not fire). A failure leaves the rows marked for the next withdraw / sweep and does not abort recovery.
    if (all.some((row) => row.withdrawing && !ownBatch?.has(row.entry.eventId))) {
      try {
        await finishWithdrawing(groupId, undefined, undefined, ownBatch);
      } catch (error) {
        result.failed += 1;
        if (disposed) return result;
        report(error, { groupId, eventId: '' });
      }
    }
    const rows = all.filter((row) => !row.dispatched && !row.abandoned && !row.withdrawing);
    for (const row of rows) {
      if (disposed) break;
      try {
        await bounded(`recover ${row.entry.eventId}`, settleMs, (state) => dispatchRow(row, state));
        result.redispatched += 1;
      } catch (error) {
        result.failed += 1;
        if (disposed) break;
        await noteRecoveryFailure(row, error);
      }
    }
    return result;
  };

  const appendInner = async (entry: HistoryEntry, state: CallState): Promise<void> => {
    let existing = await store.getRow(entry.groupId, entry.eventId);
    if (state.abandoned) return;
    if (existing?.withdrawing) {
      // The library re-appends an id whose branch became canonical again while its withdrawal never finished: finish
      // it (the old effects are retracted) and treat this as a fresh row.
      await finishWithdrawing(entry.groupId, state);
      if (state.abandoned) return;
      existing = await store.getRow(entry.groupId, entry.eventId);
      if (existing?.withdrawing) throw new Error('history sink: a withdrawing row could not be finished');
    }
    if (existing) {
      if (existing.dispatched) return;
      await dispatchRow(existing, state);
      return;
    }
    const seq = await store.nextSeq(entry.groupId);
    if (state.abandoned) return;
    if (!isRegisteredKind(entry)) {
      await store.putRow({ entry, seq, dispatched: true, receivedAt: Date.now() });
      return;
    }
    const row: HistoryRow = { entry, seq, dispatched: false, receivedAt: Date.now() };
    await store.putRow(row);
    if (state.abandoned) return; // the undispatched row stays; recovery runs it
    await dispatchRow(row, state);
  };

  /** Step 1 of a withdraw: durably marks every existing row of the batch `withdrawing`. */
  const markWithdrawing = async (groupId: string, ids: readonly string[], state: CallState): Promise<void> => {
    for (const eventId of ids) {
      if (state.abandoned) return;
      const row = await store.getRow(groupId, eventId);
      if (!row || state.abandoned) continue;
      if (!row.withdrawing) await store.putRow({ ...row, withdrawing: true });
    }
  };

  return {
    append(entry) {
      if (disposed) return Promise.reject(disposedError());
      try {
        assertEntry(entry);
      } catch (error) {
        return Promise.reject(error);
      }
      return serial.run(entry.groupId, async () => {
        if (disposed) throw disposedError();
        const wasTouched = touched.has(entry.groupId);
        await recoverGroup(entry.groupId);
        // A withdrawal this instance left unfinished (timeout / failing retract) finishes before anything newer is
        // dispatched; a failure is reported and never fails the append.
        if (wasTouched && leftover.has(entry.groupId)) {
          try {
            await finishWithdrawing(entry.groupId);
          } catch (error) {
            if (disposed) throw disposedError();
            report(error, { groupId: entry.groupId, eventId: entry.eventId });
          }
        }
        return bounded(`append ${entry.eventId}`, settleMs, (state) => appendInner(entry, state));
      });
    },

    withdraw(groupId, eventIds) {
      if (disposed) return Promise.reject(disposedError());
      return serial.run(groupId, async () => {
        if (disposed) throw disposedError();
        const ids = [...new Set(eventIds)];
        // Recorded before marking: a mark step that fails part-way leaves some rows marked (hidden from list() and
        // remaining()); the leftover entry makes the group's next append finish them, not only a later withdraw.
        leftover.add(groupId);
        await bounded(`mark withdrawing in ${groupId}`, settleMs, (state) => markWithdrawing(groupId, ids, state));
        // First-touch recovery finishes OTHER marked rows (an earlier interrupted withdraw) before it re-dispatches
        // anything; this batch's rows stay marked (never re-dispatched) and are finished below.
        await recoverGroup(groupId, new Set(ids));
        const lateRetract = await awaitInFlight(ids.map((id) => rowKey(groupId, id)), 'withdrawn');
        // Every marked row of the group (this batch and any leftover), one bounded step per row.
        return finishWithdrawing(groupId, undefined, lateRetract);
      });
    },

    async list(groupId) {
      if (disposed) throw disposedError();
      const rows = await serial.run(groupId, () => store.listRows(groupId));
      return rows.filter((row) => !row.withdrawing).map((row) => row.entry);
    },

    purge(groupId) {
      if (disposed) return Promise.reject(disposedError());
      return serial.run(groupId, async () => {
        if (disposed) throw disposedError();
        const prefix = `${groupId}:`;
        const keys = [...inFlight.keys()].filter((key) => key.startsWith(prefix));
        if (keys.length > 0) {
          // Dispatches still running would otherwise write effects for rows that no longer exist: wait one bound,
          // let the rest retract themselves on completion, and drop every in-flight entry so a re-join never joins one.
          await awaitInFlight(keys, 'purged');
          for (const key of keys) inFlight.delete(key);
        }
        return bounded(`purge ${groupId}`, settleMs, () => store.purgeGroup(groupId));
      });
    },

    sweep() {
      if (disposed) return Promise.reject(disposedError());
      return sweepUndispatched({
        store,
        onError: report,
        isTouched: (groupId) => touched.has(groupId),
        recoverGroup: (groupId) => serial.run(groupId, () => (disposed ? Promise.reject(disposedError()) : recoverGroup(groupId))),
      });
    },

    dispose() {
      if (disposal) return disposal;
      disposed = true;
      touched.clear();
      inFlight.clear();
      retractOnSettle.clear();
      // Jobs already running see `disposed` at their next step; wait for them, but never longer than one bound.
      let timer: ReturnType<typeof setTimeout> | undefined;
      disposal = Promise.race([
        serial.settled(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, settleMs);
        }),
      ]).then(() => clearTimeout(timer));
      return disposal;
    },
  };
}
