/**
 * Invite-context holding store (D3, AC-CTX-2 / AC-CTX-3).
 *
 * Holds the contexts the inbox handler accepted, per account, until the invitation card needs them. A context is
 * keyed by `groupId + sender` (the rumor's seal-bound pubkey): a later rumor of the same key replaces the earlier
 * one; a redelivery (same rumor id) changes nothing.
 *
 * Retention (all numbers are constants of this module, asserted by tests):
 *   - contexts with NO matching pending invitation are HELD: at most `HELD_PER_SENDER_CAP` (8) per sender and
 *     `HELD_TOTAL_CAP` (64) in total, for `CONTEXT_TTL_MS`. The total cap is trust-ranked like the pending caps:
 *     contexts of strangers are evicted before those of trusted senders (`isTrustedSponsor`, the predicate the
 *     pending view uses), the oldest first (age = insertion order) within each class;
 *     (7 days; expired when strictly older, measured by the injected clock at arrival, never by the sender's
 *     claimed `created_at`);
 *   - a context whose group has a pending invitation is validated against it: the sender must be the
 *     invitation's `sponsorAccount` or one of its `sponsors`, else the context is dropped; a valid one is marked
 *     `matched` and is no longer counted against the held caps (the invitation caps bound it);
 *   - a matched context is deleted when its invitation leaves the pending list (accept, decline, cap expiry, block):
 *     `reconcile(pending)` applies the full rule set. `reconcile` must only run with a pending list that is
 *     current (after the pending view's first load); the arrival path (`add`) therefore only ever uses the
 *     positive evidence of `getPending()` and never deletes a matched context because it is absent.
 *
 * Replaced, discarded, expired and evicted contexts leave ID-only tombstones (at most `TOMBSTONE_CAP` (256), each for
 * `CONTEXT_TTL_MS` after removal). These are saved alongside the records so redelivery cannot restore a retired
 * name within that window, even after a restart.
 *
 * Persistence is a whole-snapshot port (`load` / `save`; the IndexedDB adapter is `lib/marmot/inviteContextIdbPort.ts`, kept out of this pure module), written after every change and serialised, so a reload
 * restores exactly what was held (insertion order is the persisted `seq`, independent of the storage's key order).
 * The store never calls the library client: it is safe to use from an inbox handler (AC-CTX-4). Subscribers fire
 * synchronously after a change, which is how the card shows a context live in either arrival order.
 */
import { sanitizeContextName } from './inviteContext';

export const HELD_PER_SENDER_CAP = 8;
export const HELD_TOTAL_CAP = 64;
export const CONTEXT_TTL_MS = 7 * 86_400_000;
export const TOMBSTONE_CAP = 256;
const SAVE_RETRY_INITIAL_MS = 1_000;
const SAVE_RETRY_MAX_MS = 60_000;

export interface InviteContextRecord {
  /** The rumor id: redelivery dedupe. */
  rumorId: string;
  groupId: string;
  /** The rumor's seal-bound author (lowercase hex). */
  sender: string;
  /** Sanitised, capped. */
  name: string;
  /** Injected clock (ms) at arrival. */
  receivedAt: number;
  /** Insertion order, monotonic per store; the age ranking for eviction. */
  seq: number;
  /** An invitation of this group with this sender as sponsor was seen. */
  matched: boolean;
}

/** The invitation fields the store reads (a `PendingInvitation` slice). */
export interface InvitationRef {
  readonly groupId: string;
  readonly sponsorAccount: string;
  readonly sponsors: readonly string[];
}

export interface InviteContextStorePort {
  /** Legacy snapshots contain only the records array. */
  load: () => Promise<readonly InviteContextRecord[] | InviteContextDiskSnapshot | undefined>;
  /** Replaces both parts of the snapshot atomically. */
  save: (records: readonly InviteContextRecord[], tombstones?: readonly InviteContextTombstone[]) => Promise<void>;
}

interface InviteContextDiskSnapshot {
  records: readonly InviteContextRecord[];
  tombstones: readonly InviteContextTombstone[];
}

interface InviteContextTombstone {
  rumorId: string;
  removedAt: number;
}

interface InviteContextStoreDeps {
  port: InviteContextStorePort;
  /** Clock, ms. */
  now: () => number;
  /** The current shown pending invitations (sync snapshot, e.g. `PendingInvitationView.pending`). */
  getPending: () => readonly InvitationRef[];
  /**
   * Whether a sender (lowercase hex) is trusted: the SAME predicate the pending view uses for sponsors
   * (`isTrustedSponsor`). Ranks held contexts at eviction (strangers first). Default: nobody is trusted.
   */
  isTrustedSponsor?: (sender: string) => boolean;
  /** Schedule a one-shot expiry callback outside the inbox frame and return its cancellation function. */
  scheduleExpiry?: (delayMs: number, expire: () => Promise<void>) => () => void;
  /** A failed persist (default `console.error`). */
  onError?: (error: unknown) => void;
}

type AddResult = 'stored' | 'replaced' | 'duplicate' | 'dropped';
type PersistenceMode = 'soft' | 'timer' | 'inbox';

export interface InviteContextStore {
  /** Loads the persisted snapshot (idempotent once it succeeded; a failed load is retried by the next call). */
  load: () => Promise<void>;
  /** Inbox delivery requires persistence before acknowledgment, including on retries of dirty duplicates. */
  add: (input: { rumorId: string; sender: string; groupId: string; name: string }, options?: { requirePersistence: boolean }) => Promise<AddResult>;
  /** Full rule set against a CURRENT pending list (expiry, sponsor mismatch, invitation left). */
  reconcile: (pending: readonly InvitationRef[]) => Promise<void>;
  /** Deletes every context of the invitation's group (accept / decline). */
  discard: (invitation: Pick<InvitationRef, 'groupId'>) => Promise<void>;
  /** The held contexts as of now (unexpired), oldest first. A copy. */
  snapshot: () => InviteContextRecord[];
  /** Fires after every change of `snapshot()`. */
  subscribe: (cb: () => void) => () => void;
  /** Cancels automatic expiry for a session that is being disposed. */
  stopExpiry: () => void;
}

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createInviteContextStore: required dependency "${name}" is missing`);
}

const isSponsor = (inv: InvitationRef, sender: string) => inv.sponsorAccount === sender || inv.sponsors.includes(sender);

export function createInviteContextStore(deps: InviteContextStoreDeps): InviteContextStore {
  if (!deps) throw new TypeError('createInviteContextStore: dependencies are required');
  requireFn(deps.port?.load, 'port.load');
  requireFn(deps.port?.save, 'port.save');
  requireFn(deps.now, 'now');
  requireFn(deps.getPending, 'getPending');
  const { port, now, getPending } = deps;
  const trustedPredicate = deps.isTrustedSponsor;
  const isTrusted = (sender: string): boolean => {
    try {
      return trustedPredicate ? trustedPredicate(sender) === true : false;
    } catch {
      return false; // fail closed: an unknown sender is a stranger
    }
  };
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] invite context store', e));

  let records: InviteContextRecord[] = [];
  let nextSeq = 1;
  /** True once a load succeeded; until then nothing is persisted (never overwrite stored data with a blank snapshot). */
  let loadOk = false;
  let loading: Promise<void> | undefined;
  /** Rumor id to removal time (insertion order = age). */
  const tombstones = new Map<string, number>();
  let dirty = false;
  let retryAt: number | undefined;
  let retryDelay = SAVE_RETRY_INITIAL_MS;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  let cancelExpiry: (() => void) | undefined;
  let expiryStopped = false;

  const withinTtl = (at: number) => now() - at <= CONTEXT_TTL_MS;
  const live = (r: InviteContextRecord) => withinTtl(r.receivedAt);

  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        onError(e);
      }
    }
  };

  /** Applies the retention rules to `records` in place. `full` also deletes matched contexts whose invitation is absent. */
  function enforce(pending: readonly InvitationRef[], full: boolean) {
    const kept: InviteContextRecord[] = [];
    const retired: string[] = [];
    for (const r of records) {
      const forGroup = pending.filter((inv) => inv.groupId === r.groupId);
      if (forGroup.length > 0) {
        if (forGroup.some((inv) => isSponsor(inv, r.sender))) kept.push({ ...r, matched: true });
        else retired.push(r.rumorId);
      } else if (r.matched && full) {
        retired.push(r.rumorId);
      } else {
        kept.push(r);
      }
    }
    // held caps over the unmatched, oldest (lowest seq) evicted first
    const held = kept.filter((r) => !r.matched).sort((a, b) => a.seq - b.seq);
    const trusted = new Map<string, boolean>();
    const trustOf = (sender: string) => {
      let t = trusted.get(sender);
      if (t === undefined) trusted.set(sender, (t = isTrusted(sender)));
      return t;
    };
    const evict = new Set<InviteContextRecord>();
    const perSender = new Map<string, InviteContextRecord[]>();
    for (const r of held) perSender.set(r.sender, [...(perSender.get(r.sender) ?? []), r]);
    for (const list of perSender.values()) for (const r of list.slice(0, Math.max(0, list.length - HELD_PER_SENDER_CAP))) evict.add(r);
    // total cap: strangers are evicted before trusted senders, the oldest first within each class
    const remaining = held.filter((r) => !evict.has(r));
    const evictionOrder = [...remaining.filter((r) => !trustOf(r.sender)), ...remaining.filter((r) => trustOf(r.sender))];
    for (const r of evictionOrder.slice(0, Math.max(0, remaining.length - HELD_TOTAL_CAP))) evict.add(r);
    for (const r of evict) retired.push(r.rumorId);
    tombstone(retired);
    records = kept.filter((r) => !evict.has(r)).sort((a, b) => a.seq - b.seq);
  }

  const same = (a: readonly InviteContextRecord[], b: readonly InviteContextRecord[]) =>
    a.length === b.length && a.every((r, i) => r === b[i] || (r.rumorId === b[i].rumorId && r.matched === b[i].matched && r.seq === b[i].seq));

  async function loadOnce(): Promise<void> {
    let stored: Awaited<ReturnType<InviteContextStorePort['load']>>;
    try {
      stored = await port.load();
    } catch (e) {
      onError(e);
      throw e;
    }
    const disk = stored && 'records' in stored ? stored : { records: stored ?? [], tombstones: [] };
    const retired = disk.tombstones.filter((r) => r && typeof r.rumorId === 'string' && Number.isFinite(r.removedAt));
    const inMemoryTombstones = tombstones.size > 0;
    const combined = [...retired.map(({ rumorId, removedAt }) => [rumorId, removedAt] as const), ...tombstones]
      .sort((a, b) => a[1] - b[1]);
    tombstones.clear();
    for (const [id, at] of combined) {
      if (!withinTtl(at)) continue;
      tombstones.delete(id);
      tombstones.set(id, at);
    }
    pruneTombstones();

    const valid = disk.records.filter(
      (r) => r && typeof r.rumorId === 'string' && typeof r.groupId === 'string' && typeof r.sender === 'string' && typeof r.name === 'string' && Number.isFinite(r.receivedAt) && Number.isFinite(r.seq),
    );
    const fromStorage = valid.map((r) => ({ ...r, name: sanitizeContextName(r.name), matched: r.matched === true })).sort((a, b) => a.seq - b.seq);
    // Keep changes made during a load failure, while honoring IDs already retired on disk.
    const inMemory = records.filter((m) => !tombstones.has(m.rumorId) && !fromStorage.some((r) => r.rumorId === m.rumorId));
    nextSeq = fromStorage.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    const candidates = [...fromStorage, ...inMemory.map((r) => ({ ...r, seq: nextSeq++ }))];
    const merged = retireExpired(candidates.filter((r) => !tombstones.has(r.rumorId)));
    const byKey = new Map<string, InviteContextRecord>();
    for (const r of merged) {
      if (tombstones.has(r.rumorId)) continue;
      const key = JSON.stringify([r.groupId, r.sender]);
      const previous = byKey.get(key);
      if (previous && previous.rumorId !== r.rumorId) tombstone([previous.rumorId]);
      byKey.set(key, r);
    }
    const before = records;
    records = [...byKey.values()];
    loadOk = true;
    enforce([], false); // caps only (no pending evidence yet)
    await persist(valid.length !== disk.records.length || !same(valid, records) || disk.tombstones.length !== tombstones.size || inMemoryTombstones);
    if (!same(before, records)) notify();
    armExpiry();
  }

  const ensureLoaded = (): Promise<void> => {
    if (loading) return loading;
    if (loadOk) return Promise.resolve();
    loading = loadOnce().finally(() => {
      loading = undefined;
    });
    return loading;
  };

  async function persist(changed: boolean, mode: PersistenceMode = 'soft') {
    if (!loadOk) return; // never overwrite the stored snapshot with data that was not merged with it
    dirty ||= changed;
    if (!dirty || (mode !== 'inbox' && retryAt !== undefined && now() < retryAt && (mode === 'timer' || !changed))) return;
    try {
      await port.save(records.map((r) => ({ ...r })), [...tombstones].map(([rumorId, removedAt]) => ({ rumorId, removedAt })));
      dirty = false;
      retryAt = undefined;
      retryDelay = SAVE_RETRY_INITIAL_MS;
    } catch (e) {
      retryAt = now() + retryDelay;
      retryDelay = Math.min(retryDelay * 2, SAVE_RETRY_MAX_MS);
      if (mode === 'inbox') throw e;
      onError(e);
    }
  }

  function pruneTombstones() {
    const before = tombstones.size;
    for (const [id, at] of tombstones) if (!withinTtl(at)) tombstones.delete(id);
    while (tombstones.size > TOMBSTONE_CAP) tombstones.delete(tombstones.keys().next().value as string);
    return tombstones.size !== before;
  }

  const tombstone = (rumorIds: readonly string[]) => {
    if (rumorIds.length === 0) return;
    dirty = true;
    const t = now();
    for (const id of rumorIds) {
      tombstones.delete(id);
      tombstones.set(id, t);
    }
    pruneTombstones();
  };

  function retireExpired(candidates: readonly InviteContextRecord[]): InviteContextRecord[] {
    const cutoff = now() - CONTEXT_TTL_MS;
    const expiredIds: string[] = [];
    const remaining = candidates.filter((r) => {
      if (r.receivedAt >= cutoff) return true;
      expiredIds.push(r.rumorId);
      return false;
    });
    if (expiredIds.length > 0) tombstone(expiredIds);
    return remaining;
  }

  function armExpiry() {
    cancelExpiry?.();
    cancelExpiry = undefined;
    if (expiryStopped || !deps.scheduleExpiry) return;
    let oldest = Infinity;
    for (const r of records) oldest = Math.min(oldest, r.receivedAt);
    for (const at of tombstones.values()) oldest = Math.min(oldest, at);
    const deadline = Math.min(oldest + CONTEXT_TTL_MS + 1, retryAt ?? Infinity);
    if (deadline === Infinity) return;
    cancelExpiry = deps.scheduleExpiry(Math.max(0, deadline - now()), async () => {
      await mutate(() => undefined, 'timer', () => !expiryStopped);
    });
  }

  /** Expiry and inbox/disposition mutations share the same persistence order. */
  function mutate<T>(fn: () => T, mode?: 'soft' | 'inbox'): Promise<T>;
  function mutate(fn: () => void, mode: 'timer', active: () => boolean): Promise<void>;
  function mutate<T>(fn: () => T, mode: PersistenceMode = 'soft', active?: () => boolean): Promise<T | undefined> {
    const next = chain.then(async () => {
      if (active && !active()) return;
      const loaded = ensureLoaded();
      await (mode === 'inbox' ? loaded : loaded.catch(() => undefined));
      if (active && !active()) return;
      const before = records;
      const expiredIds = pruneTombstones();
      records = retireExpired(records);
      const value = fn();
      const changed = !same(before, records);
      try {
        await persist(changed || expiredIds, mode);
      } finally {
        if (changed) notify();
        armExpiry();
      }
      return value;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    load: () => ensureLoaded().catch(() => undefined),
    add: (input, options) =>
      mutate<AddResult>(() => {
        if (tombstones.has(input.rumorId) || records.some((r) => r.rumorId === input.rumorId)) return 'duplicate';
        const name = sanitizeContextName(input.name);
        if (name.length === 0) return 'dropped';
        const existing = records.find((r) => r.groupId === input.groupId && r.sender === input.sender);
        const record: InviteContextRecord = { rumorId: input.rumorId, groupId: input.groupId, sender: input.sender, name, receivedAt: now(), seq: nextSeq++, matched: existing?.matched ?? false };
        records = [...records.filter((r) => r !== existing), record];
        enforce(getPending(), false);
        if (existing) tombstone([existing.rumorId]);
        const retained = records.some((r) => r.rumorId === input.rumorId);
        return !retained ? 'dropped' : existing ? 'replaced' : 'stored';
      }, options?.requirePersistence ? 'inbox' : 'soft'),
    reconcile: (pending) => mutate(() => enforce(pending, true)),
    discard: (invitation) =>
      mutate<void>(() => {
        tombstone(records.filter((r) => r.groupId === invitation.groupId).map((r) => r.rumorId));
        records = records.filter((r) => r.groupId !== invitation.groupId);
      }),
    snapshot: () => records.filter(live).map((r) => ({ ...r })),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    stopExpiry: () => {
      expiryStopped = true;
      cancelExpiry?.();
      cancelExpiry = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring to the pending view (AC-CTX-3: deleted on accept, decline and expiry)
// ---------------------------------------------------------------------------

/** The slice of `PendingInvitationView` the wiring uses. */
interface PendingListSource {
  pending: () => readonly (InvitationRef & { id: string })[];
  onChange: (cb: () => void) => () => void;
}

/**
 * Keeps the store in step with the shown pending list: every change of the list reconciles the store (sponsor
 * validation, invitation-left deletion, expiry). `reconcileNow()` is for startup, right after the view's seed
 * (the list is current from then on). Runs outside library frames only (the view's `onChange` fires after a
 * refresh the owned job queue ran). Returns the unsubscribe.
 */
export function bindInviteContextToPendingView(
  deps: { view: PendingListSource; store: Pick<InviteContextStore, 'reconcile'>; onError?: (error: unknown) => void },
): { reconcileNow: () => Promise<void>; dispose: () => void } {
  if (typeof deps?.view?.pending !== 'function') throw new TypeError('bindInviteContextToPendingView: required dependency "view.pending" is missing');
  if (typeof deps.view.onChange !== 'function') throw new TypeError('bindInviteContextToPendingView: required dependency "view.onChange" is missing');
  if (typeof deps.store?.reconcile !== 'function') throw new TypeError('bindInviteContextToPendingView: required dependency "store.reconcile" is missing');
  const { view, store } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] invite context reconcile', e));
  const reconcileNow = () => store.reconcile(view.pending());
  const off = view.onChange(() => void reconcileNow().catch(onError));
  return { reconcileNow, dispose: off };
}

/**
 * Accept/decline decorated with the context deletion: after a SUCCESSFUL `accept(id)` / `decline(id)` the
 * contexts of that invitation's group are discarded at once (the pending-list reconcile would also catch it; this
 * makes the deletion independent of refresh timing). A failed action deletes nothing.
 */
export function withInviteContextCleanup<A extends { accept: (id: string, verify?: () => boolean | Promise<boolean>) => Promise<unknown>; decline: (id: string) => Promise<void> }>(
  deps: { actions: A; view: Pick<PendingListSource, 'pending'>; store: Pick<InviteContextStore, 'discard'> },
): A {
  if (typeof deps?.actions?.accept !== 'function' || typeof deps.actions.decline !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "actions" is missing');
  if (typeof deps.view?.pending !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "view.pending" is missing');
  if (typeof deps.store?.discard !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "store.discard" is missing');
  const { actions, view, store } = deps;
  const groupOf = (id: string) => view.pending().find((i) => i.id === id)?.groupId;
  return {
    ...actions,
    accept: async (id, verify) => {
      const groupId = groupOf(id);
      const result = await actions.accept(id, verify);
      if (groupId !== undefined) await store.discard({ groupId });
      return result;
    },
    decline: async (id: string) => {
      const groupId = groupOf(id);
      await actions.decline(id);
      if (groupId !== undefined) await store.discard({ groupId });
    },
  };
}
