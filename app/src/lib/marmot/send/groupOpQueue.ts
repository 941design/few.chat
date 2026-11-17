/**
 * groupOpQueue — per-group serialisation of the group operations that make a commit
 * (seam `GroupOpQueue`, AC-SEND-5; prior learnings: await `group.synced()` before commits,
 * one in-flight `invite` per group, `invite` makes one commit per batch).
 *
 *  - ops on the SAME group run one at a time, in call order (a second invite starts after the
 *    first settled, however it settled); ops on different groups run independently;
 *  - `invite`, `removeMember`, `setAdmins`, `rename`, `leave` await `group.synced()` first, BOUNDED:
 *    `synced()` never settles offline, so the wait is raced against `syncTimeoutMs` (default 30 s) and
 *    an `AbortSignal`. A wait lost BEFORE `op()` starts rejects `GroupOpError` (`not-synced` /
 *    `aborted`), never runs `op`, and releases the chain (later ops proceed). Once `op()` started it
 *    runs to completion (the library bounds it: `leaveTimeoutMs`, publish attempts);
 *  - a `commit-pending` rejection is branched on `error.details.reason`:
 *      own commit pending publish (no reason, `details.pendingIntentId`), `selfremove-election-wait`,
 *      `staged-adds-commit-unconfirmed`  -> the library clears these itself: wait on a real barrier
 *          (`await group.ingest([])`: once it resolves every confirmation is applied; BOUNDED by `syncTimeoutMs`
 *          and abortable, on timeout or a throwing ingest it falls through, a throw logged) plus a bounded
 *          backoff (250 ms, 1 s, 3 s; the timer is cleared on abort), then retry, at most
 *          `maxCommitPendingRetries` times;
 *      `awaiting-sync`                   -> wait `synced()` (bounded as above), then retry;
 *      `proposal-deferred` (onProposal-deferred), `restore-in-flight`, anything else -> surfaced at once,
 *          unchanged: nothing the queue waits for will change it (the app must decide the proposals).
 *    Any other error is the caller's and is thrown unchanged.
 *
 * S13 (leave): recommended `queue.runCommit(group, () => group.leave(), { skipSync: true, signal })`
 * (or `queue.leave` with the default). `leave` must not hang behind a `synced()` that never settles
 * offline: the user asked to leave, and the library bounds `leave()` itself with `leaveTimeoutMs`
 * (default 60 s) and drives the removal when it can. With `skipSync` an `awaiting-sync` refusal is surfaced
 * at once (retryable by the caller after the group syncs) instead of waited for; the commit-pending barrier
 * stays bounded by `syncTimeoutMs` there too. `queue.leave` keeps the
 * safe default (sync first, bounded) for callers that cannot pass options; the abort signal is the user's
 * cancel.
 *
 * Never call an op from inside a library frame (listener, inbox handler, history sink): schedule it
 * with the client's job queue (`handle.enqueue`) — an account-scope call there rejects `reentrant`.
 * The queue itself never touches the client, so it is safe to build anywhere.
 *
 * Pure module: no React, no browser API.
 */

/** The slice of `MarmotGroup` a commit op `K` uses. */
export type CommitOpGroup<K extends string> = CommitGroup & Record<K, (...args: never[]) => Promise<unknown>>;

/** What `runCommit` needs of a group. `ingest([])` is the barrier before a retry (optional: absent, only the backoff waits). */
export interface CommitGroup {
  readonly id: string;
  synced: () => Promise<void>;
  ingest?: (events: readonly never[]) => Promise<unknown>;
}

export type GroupOpErrorCode = 'not-synced' | 'aborted';

/**
 * A wait was lost and no attempt is in flight: the sync wait timed out (`not-synced`), or the caller aborted
 * (`aborted`) while the op was queued, waiting for `synced()`, or between two retry attempts. The op (the
 * current attempt) never started, or had already settled with a retryable `commit-pending`; once an attempt
 * is running it is never interrupted.
 */
export class GroupOpError extends Error {
  readonly code: GroupOpErrorCode;
  constructor(code: GroupOpErrorCode, message: string) {
    super(message);
    this.name = 'GroupOpError';
    this.code = code;
  }
}

export interface GroupOpOptions {
  /** Abort while no attempt is in flight (queued, waiting for `synced()`, the barrier or backoff before a retry): rejects `aborted`. */
  signal?: AbortSignal;
  /** Bound of the `synced()` wait in ms (default 30 000): rejects `not-synced`, the op never runs. */
  syncTimeoutMs?: number;
  /** Do not await `synced()` before the op (S13 leave). Default false. */
  skipSync?: boolean;
}

export interface GroupOpQueueOptions {
  /** Retries of one op after a retryable `commit-pending` rejection. Default 3. */
  maxCommitPendingRetries?: number;
  /** Backoff before retry n (the last entry repeats). Default [250, 1000, 3000]. */
  commitPendingBackoffMs?: readonly number[];
  /** Default of `GroupOpOptions.syncTimeoutMs`. Default 30 000. */
  syncTimeoutMs?: number;
}

export interface GroupOpQueue {
  /**
   * Runs `op` after every earlier op of the group settled (seam shape). Does NOT wait for `synced()`;
   * `options.signal` aborts it while it is still queued.
   */
  run: <T>(groupId: string, op: () => Promise<T>, options?: Pick<GroupOpOptions, 'signal'>) => Promise<T>;
  /**
   * `run` for a commit op: awaits `group.synced()` (bounded) before `op`, and retries `op` on a retryable
   * `commit-pending` (see module doc).
   */
  runCommit: <T>(group: CommitGroup, op: () => Promise<T>, options?: GroupOpOptions) => Promise<T>;
  /** The five commit ops through `runCommit` (default options), with the group's own signatures. */
  invite: <G extends CommitOpGroup<'invite'>>(group: G, ...args: Parameters<G['invite']>) => ReturnType<G['invite']>;
  removeMember: <G extends CommitOpGroup<'removeMember'>>(group: G, ...args: Parameters<G['removeMember']>) => ReturnType<G['removeMember']>;
  setAdmins: <G extends CommitOpGroup<'setAdmins'>>(group: G, ...args: Parameters<G['setAdmins']>) => ReturnType<G['setAdmins']>;
  rename: <G extends CommitOpGroup<'rename'>>(group: G, ...args: Parameters<G['rename']>) => ReturnType<G['rename']>;
  leave: <G extends CommitOpGroup<'leave'>>(group: G, ...args: Parameters<G['leave']>) => ReturnType<G['leave']>;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [250, 1000, 3000] as const;
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

/** `commit-pending` reasons the library clears by itself (a retry after a barrier + backoff can succeed). */
const SELF_CLEARING_REASONS = new Set(['selfremove-election-wait', 'staged-adds-commit-unconfirmed']);

type Retry = 'barrier' | 'sync' | 'surface';

/** How a rejected op is handled: `surface` = throw unchanged. */
function classify(err: unknown): Retry {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'commit-pending') return 'surface';
  const details = (err as { details?: { reason?: unknown; pendingIntentId?: unknown } }).details;
  const reason = details?.reason;
  if (reason === 'awaiting-sync') return 'sync';
  if (typeof reason === 'string') return SELF_CLEARING_REASONS.has(reason) ? 'barrier' : 'surface';
  // No reason: "an own commit pending publish" (details.pendingIntentId), which publishes or goes terminal by itself.
  return typeof details?.pendingIntentId === 'string' ? 'barrier' : 'surface';
}

const aborted = () => new GroupOpError('aborted', 'groupOpQueue: aborted, no attempt is in flight');

/** Resolves with `p`, or rejects as soon as `signal` aborts / the timer fires (`timeout` undefined: no timer). */
function bound<T>(p: Promise<T>, signal: AbortSignal | undefined, timeout?: { ms: number; error: () => Error }): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => done(() => reject(aborted()));
    const done = (finish: () => void) => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    if (timeout) timer = globalThis.setTimeout(() => done(() => reject(timeout.error())), timeout.ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => done(() => resolve(v)),
      (e) => done(() => reject(e)),
    );
  });
}

export function createGroupOpQueue(options: GroupOpQueueOptions = {}): GroupOpQueue {
  const retries = options.maxCommitPendingRetries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) throw new TypeError('createGroupOpQueue: maxCommitPendingRetries must be a non-negative integer');
  const backoff = options.commitPendingBackoffMs ?? DEFAULT_BACKOFF_MS;
  if (backoff.length === 0 || backoff.some((ms) => !Number.isFinite(ms) || ms < 0)) throw new TypeError('createGroupOpQueue: commitPendingBackoffMs must be non-negative numbers');
  const defaultSyncTimeout = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  if (!Number.isFinite(defaultSyncTimeout) || defaultSyncTimeout <= 0) throw new TypeError('createGroupOpQueue: syncTimeoutMs must be a positive number');

  /** Tail of each group's chain: settles (never rejects) when the last queued op settled. */
  const tails = new Map<string, Promise<void>>();

  const run: GroupOpQueue['run'] = (groupId, op, opts) => {
    if (typeof groupId !== 'string' || groupId === '') throw new TypeError('groupOpQueue.run: groupId is required');
    if (typeof op !== 'function') throw new TypeError('groupOpQueue.run: op must be a function');
    const previous = tails.get(groupId) ?? Promise.resolve();
    const result = (async () => {
      // An aborted op leaves the queue at once, but the chain keeps its order (see `tail`).
      await bound(previous, opts?.signal);
      if (opts?.signal?.aborted) throw aborted();
      return op();
    })();
    // The next op starts after BOTH the previous op and this one settled, however: an aborted op that
    // returned early must not let its successor overtake the still-running predecessor.
    const tail = Promise.allSettled([previous, result]).then(() => undefined);
    tails.set(groupId, tail);
    void tail.then(() => {
      if (tails.get(groupId) === tail) tails.delete(groupId);
    });
    return result;
  };

  const runCommit: GroupOpQueue['runCommit'] = (group, op, opts = {}) => {
    if (!group || typeof group.synced !== 'function') throw new TypeError('groupOpQueue.runCommit: group.synced is required');
    const timeoutMs = opts.syncTimeoutMs ?? defaultSyncTimeout;
    const awaitSynced = () =>
      bound(group.synced(), opts.signal, {
        ms: timeoutMs,
        error: () => new GroupOpError('not-synced', `groupOpQueue: group ${group.id} did not sync within ${String(timeoutMs)} ms`),
      });
    // The timer is cleared when the wait ends first (abort), so no handle outlives the op.
    const sleep = (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return bound(new Promise<void>((resolve) => { timer = globalThis.setTimeout(resolve, ms); }), opts.signal).finally(() => {
        if (timer !== undefined) globalThis.clearTimeout(timer);
      });
    };
    // The barrier: bounded like every wait. A timeout or a failing ingest falls through to the backoff (the
    // retry itself then shows whether the commit cleared); an abort ends the op.
    const barrier = async () => {
      if (typeof group.ingest !== 'function') return;
      try {
        await bound(group.ingest([]), opts.signal, {
          ms: timeoutMs,
          error: () => new GroupOpError('not-synced', `groupOpQueue: ingest barrier of group ${group.id} did not settle within ${String(timeoutMs)} ms`),
        });
      } catch (e) {
        if (e instanceof GroupOpError && e.code === 'aborted') throw e;
        if (!(e instanceof GroupOpError)) console.warn(`[groupOpQueue] ingest([]) barrier of group ${group.id} failed; retrying after the backoff`, e);
      }
    };
    return run(
      group.id,
      async () => {
        if (!opts.skipSync) await awaitSynced();
        for (let attempt = 0; ; attempt++) {
          try {
            return await op();
          } catch (err) {
            const how = classify(err);
            if (how === 'surface' || attempt >= retries) throw err;
            if (how === 'sync') {
              if (opts.skipSync) throw err;
              await awaitSynced();
            } else {
              // A real barrier first (every confirmation applied), then the bounded backoff.
              await barrier();
              await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
            }
          }
        }
      },
      { signal: opts.signal },
    );
  };

  const bind =
    <K extends 'invite' | 'removeMember' | 'setAdmins' | 'rename' | 'leave'>(name: K) =>
    (group: never, ...args: never[]) =>
      runCommit(group as CommitGroup, () => (group as Record<string, (...a: never[]) => Promise<unknown>>)[name](...args));

  return {
    run,
    runCommit,
    invite: bind('invite') as unknown as GroupOpQueue['invite'],
    removeMember: bind('removeMember') as unknown as GroupOpQueue['removeMember'],
    setAdmins: bind('setAdmins') as unknown as GroupOpQueue['setAdmins'],
    rename: bind('rename') as unknown as GroupOpQueue['rename'],
    leave: bind('leave') as unknown as GroupOpQueue['leave'],
  };
}
