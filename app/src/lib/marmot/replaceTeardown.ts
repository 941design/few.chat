/**
 * Stops a group's old subscription work before a stale-Welcome replace destroys
 * its MLS state (bug stale-welcome-reinvite). Fails CLOSED: when any bounded
 * wait times out, it throws so the caller never destroys or purges under still
 * running work. The outstanding wait is remembered per group (`pending`), so
 * the next attempt awaits it first and cannot bypass unfinished work.
 */
export const REPLACE_WAIT_MS = 3000;

export interface ReplaceTeardownHandles {
  /** Aborts the group's lifecycle (stops further setup work). */
  abort?: () => void;
  /** The in-flight asynchronous subscription setup, if any. */
  setup?: Promise<unknown>;
  /** Unsubscribes the live subscription. */
  unsub?: () => void;
  /** Resolves once an ingest already running (incl. its state save) is done. */
  idle?: () => Promise<unknown>;
  /** Resolves once the application-rumor dispatcher has drained. */
  drain?: () => Promise<unknown>;
  /** Cancels timers (debounce etc.). */
  cancelTimers?: () => void;
}

type Pending = Map<string, Set<Promise<unknown>>>;

/** Races `p` against a timer; true when the timer won. */
async function timesOut(p: Promise<unknown>, waitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs);
  });
  const winner = await Promise.race([p.then(() => 'done' as const), expired]);
  clearTimeout(timer);
  return winner === 'timeout';
}

/**
 * Remembers an unfinished piece of old work for `groupId` (e.g. the in-flight
 * ingest of a retired subscription) until it settles, so a later replace
 * awaits it. Settled entries, and empty per-group sets, are removed.
 */
export function trackPending(pending: Pending, groupId: string, work: Promise<unknown>): void {
  const tracked: Promise<unknown> = Promise.resolve(work).then(() => undefined, () => undefined);
  let set = pending.get(groupId);
  if (!set) {
    set = new Set();
    pending.set(groupId, set);
  }
  set.add(tracked);
  void tracked.then(() => {
    const current = pending.get(groupId);
    if (!current) return;
    current.delete(tracked);
    if (current.size === 0) pending.delete(groupId);
  });
}

/**
 * Remembers a subscription setup retired by an effect restart while it still
 * runs (bug stale-replace-retired-setup-untracked). The new run overwrites the
 * group's lifecycle entry, and the retired setup hands over its ingest-idle and
 * dispatcher-drain work only when it finishes — possibly after a replace has
 * snapshotted `pending`. One entry therefore covers both: it settles once the
 * setup has settled and then everything `handedOver()` returns has settled.
 */
export function trackRetiredSetup(
  pending: Pending,
  groupId: string,
  setup: Promise<unknown>,
  handedOver: () => Iterable<Promise<unknown>>,
): void {
  const settled = (p: Promise<unknown>) => Promise.resolve(p).then(() => undefined, () => undefined);
  trackPending(
    pending,
    groupId,
    settled(setup).then(() => Promise.all(Array.from(handedOver(), settled))),
  );
}

export async function teardownForReplace(
  groupId: string,
  handles: ReplaceTeardownHandles,
  pending: Pending,
  waitMs: number = REPLACE_WAIT_MS,
): Promise<void> {
  let timedOut = false;

  /** Waits for fresh work at most waitMs; remembers it while unsettled. */
  const bounded = async (p: Promise<unknown> | undefined): Promise<void> => {
    if (!p) return;
    trackPending(pending, groupId, p);
    if (await timesOut(p.then(() => undefined, () => undefined), waitMs)) timedOut = true;
  };

  // Work left over from earlier attempts / retired subscriptions comes first.
  // Raced as a whole against ONE timer and NOT re-registered (they are
  // already tracked), so retries neither multiply entries nor waits.
  const leftover = Array.from(pending.get(groupId) ?? []);
  if (leftover.length > 0 && (await timesOut(Promise.all(leftover), waitMs))) timedOut = true;

  handles.abort?.();
  await bounded(handles.setup);
  handles.unsub?.();
  await bounded(handles.idle?.());
  handles.cancelTimers?.();
  await bounded(handles.drain?.());

  if (timedOut) {
    throw new Error('old subscription work still running; replace postponed');
  }
}
