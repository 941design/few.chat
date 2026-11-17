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
 * A context that was discarded (accept / decline / invitation left) leaves a TOMBSTONE of its rumor id (at most
 * `TOMBSTONE_CAP` (256), each for `CONTEXT_TTL_MS`): a redelivery of that rumor is `duplicate`, so a deleted context
 * does not come back. Tombstones are in memory only.
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
  /** The persisted snapshot, or `undefined` when none. */
  load: () => Promise<readonly InviteContextRecord[] | undefined>;
  /** Replaces the persisted snapshot. */
  save: (records: readonly InviteContextRecord[]) => Promise<void>;
}

export interface InviteContextStoreDeps {
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
  /** A failed persist (default `console.error`). */
  onError?: (error: unknown) => void;
}

export type AddResult = 'stored' | 'replaced' | 'duplicate' | 'dropped';

export interface InviteContextStore {
  /** Loads the persisted snapshot (idempotent once it succeeded; a failed load is retried by the next call). */
  load: () => Promise<void>;
  /** Stores a validated context. `dropped` = not retained (sender not a sponsor of a pending invitation of the group, or evicted at once). */
  add: (input: { rumorId: string; sender: string; groupId: string; name: string }) => Promise<AddResult>;
  /** Full rule set against a CURRENT pending list (expiry, sponsor mismatch, invitation left). */
  reconcile: (pending: readonly InvitationRef[]) => Promise<void>;
  /** Deletes every context of the invitation's group (accept / decline). */
  discard: (invitation: Pick<InvitationRef, 'groupId'>) => Promise<void>;
  /** The held contexts as of now (unexpired), oldest first. A copy. */
  snapshot: () => InviteContextRecord[];
  /** Fires after every change of `snapshot()`. */
  subscribe: (cb: () => void) => () => void;
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
  /** rumor id -> time the context was discarded (insertion order = age). */
  const tombstones = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const live = (r: InviteContextRecord) => now() - r.receivedAt <= CONTEXT_TTL_MS;

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
    for (const r of records) {
      if (!live(r)) continue;
      const forGroup = pending.filter((inv) => inv.groupId === r.groupId);
      if (forGroup.length > 0) {
        if (!forGroup.some((inv) => isSponsor(inv, r.sender))) continue; // sponsor mismatch
        kept.push({ ...r, matched: true });
      } else if (r.matched && full) {
        continue; // its invitation left pending()
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
    records = kept.filter((r) => !evict.has(r)).sort((a, b) => a.seq - b.seq);
  }

  const same = (a: readonly InviteContextRecord[], b: readonly InviteContextRecord[]) =>
    a.length === b.length && a.every((r, i) => r === b[i] || (r.rumorId === b[i].rumorId && r.matched === b[i].matched && r.seq === b[i].seq));

  /** One load attempt. `true` = the persisted snapshot (or its absence) was read; `false` = the port failed. */
  async function loadOnce(): Promise<boolean> {
    let stored: readonly InviteContextRecord[] | undefined;
    try {
      stored = await port.load();
    } catch (e) {
      onError(e);
      return false;
    }
    const valid = (stored ?? []).filter(
      (r) => r && typeof r.rumorId === 'string' && typeof r.groupId === 'string' && typeof r.sender === 'string' && typeof r.name === 'string' && Number.isFinite(r.receivedAt) && Number.isFinite(r.seq),
    );
    const fromStorage = valid.map((r) => ({ ...r, name: sanitizeContextName(r.name), matched: r.matched === true })).sort((a, b) => a.seq - b.seq);
    // Contexts accepted in memory while the load was failing are kept, after the stored ones (newest), under fresh seqs.
    const inMemory = records.filter((m) => !fromStorage.some((r) => r.rumorId === m.rumorId));
    nextSeq = fromStorage.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    records = [...fromStorage, ...inMemory.map((r) => ({ ...r, seq: nextSeq++ }))];
    loadOk = true;
    const before = records;
    enforce([], false); // expiry and caps only (no pending evidence yet)
    if (!same(before, records) || inMemory.length > 0) void persist();
    if (records.length > 0) notify();
    return true;
  }

  const ensureLoaded = (): Promise<void> => {
    if (loadOk) return Promise.resolve();
    if (!loading) {
      const attempt: Promise<void> = loadOnce().then((ok) => {
        if (!ok && loading === attempt) loading = undefined; // the next call retries
      });
      loading = attempt;
    }
    return loading;
  };

  async function persist() {
    if (!loadOk) return; // never overwrite the stored snapshot with data that was not merged with it
    try {
      await port.save(records.map((r) => ({ ...r })));
    } catch (e) {
      onError(e);
    }
  }

  const tombstone = (rumorIds: Iterable<string>) => {
    const t = now();
    for (const id of rumorIds) {
      tombstones.delete(id);
      tombstones.set(id, t);
    }
    while (tombstones.size > TOMBSTONE_CAP) tombstones.delete(tombstones.keys().next().value as string);
  };
  const tombstoned = (rumorId: string): boolean => {
    const at = tombstones.get(rumorId);
    if (at === undefined) return false;
    if (now() - at > CONTEXT_TTL_MS) {
      tombstones.delete(rumorId);
      return false;
    }
    return true;
  };

  /** Serialised mutation: waits for the load, runs `fn`, persists and notifies when `fn` changed the set. */
  function mutate<T>(fn: () => { changed: boolean; value: T }): Promise<T> {
    const next = chain.then(async () => {
      await ensureLoaded();
      const { changed, value } = fn();
      if (changed) {
        await persist();
        notify();
      }
      return value;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    load: () => ensureLoaded(),
    add: (input) =>
      mutate<AddResult>(() => {
        if (tombstoned(input.rumorId)) return { changed: false, value: 'duplicate' }; // discarded earlier: a redelivery stays gone
        const name = sanitizeContextName(input.name);
        if (name.length === 0) return { changed: false, value: 'dropped' };
        const before = records;
        const existing = records.find((r) => r.groupId === input.groupId && r.sender === input.sender);
        if (existing && existing.rumorId === input.rumorId) return { changed: false, value: 'duplicate' };
        if (records.some((r) => r.rumorId === input.rumorId)) return { changed: false, value: 'duplicate' };
        const record: InviteContextRecord = { rumorId: input.rumorId, groupId: input.groupId, sender: input.sender, name, receivedAt: now(), seq: nextSeq++, matched: false };
        records = [...records.filter((r) => r !== existing), record];
        enforce(getPending(), false);
        const retained = records.some((r) => r.rumorId === input.rumorId);
        const value: AddResult = !retained ? 'dropped' : existing ? 'replaced' : 'stored';
        return { changed: !same(before, records), value };
      }),
    reconcile: (pending) =>
      mutate<void>(() => {
        const before = records;
        enforce(pending, true);
        // A matched context that left with its invitation is "discarded" too: its redelivery must stay gone.
        tombstone(before.filter((r) => r.matched && !records.some((k) => k.rumorId === r.rumorId) && live(r)).map((r) => r.rumorId));
        return { changed: !same(before, records), value: undefined };
      }),
    discard: (invitation) =>
      mutate<void>(() => {
        const before = records;
        tombstone(records.filter((r) => r.groupId === invitation.groupId).map((r) => r.rumorId));
        records = records.filter((r) => r.groupId !== invitation.groupId);
        return { changed: records.length !== before.length, value: undefined };
      }),
    snapshot: () => records.filter(live).map((r) => ({ ...r })),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring to the pending view (AC-CTX-3: deleted on accept, decline and expiry)
// ---------------------------------------------------------------------------

/** The slice of `PendingInvitationView` the wiring uses. */
export interface PendingListSource {
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
export function withInviteContextCleanup<A extends { accept: (id: string) => Promise<unknown>; decline: (id: string) => Promise<void> }>(
  deps: { actions: A; view: Pick<PendingListSource, 'pending'>; store: Pick<InviteContextStore, 'discard'> },
): A {
  if (typeof deps?.actions?.accept !== 'function' || typeof deps.actions.decline !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "actions" is missing');
  if (typeof deps.view?.pending !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "view.pending" is missing');
  if (typeof deps.store?.discard !== 'function') throw new TypeError('withInviteContextCleanup: required dependency "store.discard" is missing');
  const { actions, view, store } = deps;
  const groupOf = (id: string) => view.pending().find((i) => i.id === id)?.groupId;
  return {
    ...actions,
    accept: async (id: string) => {
      const groupId = groupOf(id);
      const result = await actions.accept(id);
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
