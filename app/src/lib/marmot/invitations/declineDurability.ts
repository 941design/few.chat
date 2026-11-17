/**
 * Decline durability (D7, seam `PendingDirectInviteMarker`, AC-DECL-1/2, AC-DEL-2).
 *
 * The library emits `welcomeDeclined {groupId, inviteeRef}` ONCE per decline and the sponsor must then remove the
 * invitee's LEAF. A decline must survive an unsynced group, an offline sponsor and a restart:
 *
 *  1. invite time: `createMarkerRecordingInviter` writes the marker `{inviteeRef, pubkey, declined:false, leafKey?}`
 *     for the invited account (best-effort: a failing write is reported, never turns a committed invite into a
 *     rejection). `leafKey` is the signature key of the leaf the invite ADDED: the account's leaves after the invite
 *     minus the ones it held before, recorded only when that is exactly one leaf (otherwise none is recorded and the
 *     removal falls back to the account, see 3). The decline is bound to that leaf, not to the account;
 *  2. `onWelcomeDeclined` (the client-event listener, synchronous, no client call, no await): starts the durable
 *     write of `declined:true` for the marker carrying that `inviteeRef` IMMEDIATELY, then enqueues the removal
 *     on the client job queue as its last action. An unknown `inviteeRef` (or only legacy markers) is persisted as
 *     an ORPHAN decline (bounded, 7-day TTL) and reported: when `record()` later writes that ref the marker starts
 *     `declined` and `onRecordedDeclined` fires (wire it to `replayMarker`), so the removal still happens once. The
 *     removal never starts before the marker write has settled; a failing write means no removal (only reported);
 *  3. the removal (outside the listener frame, from a queued job) goes through the S6 `GroupOpQueue` (`runCommit`:
 *     bounded `await group.synced()`, abortable, `commit-pending` retried). INSIDE the queued op, after the sync, the
 *     marker is re-read and the op aborts as `no-marker` unless it is still declined with the SAME `inviteeRef` (a
 *     re-invite replaced it, or it was cleared meanwhile). Then, on the current member list:
 *       - the recorded leaf is gone -> `already-removed` (clear, no announcement) unless the phase says the Remove
 *         was started (`removing`), then the announcement is owed (see 4);
 *       - the account holds OTHER leaves besides the declined one -> only the declined leaf may go: `group.removeLeaf`
 *         when the handle exposes it (the library 0.x `MarmotGroup` does not), else NOTHING is removed and the
 *         marker is cleared as `superseded` and reported (a re-add or a second device must not be evicted);
 *       - the declined leaf is the account's sole leaf -> `removeMember`;
 *       - no leaf was recorded: the account is removed only when it holds exactly one leaf, else `superseded`;
 *  4. phased marker: `declined` -> `removing` (written BEFORE `removeMember`) -> `announce-pending` (written after it
 *     resolved) -> announcement -> marker cleared (compare-and-clear on `inviteeRef`). A replay that finds `removing`
 *     with the leaf gone, or `announce-pending`, announces without a second Remove. The announcement is at-LEAST-once
 *     (a failing send keeps `announce-pending` and is retried; a crash after the send and before the clear
 *     re-sends) and carries a stable dedup `id` (`groupId:inviteeRef`) so a receiver can de-duplicate (receiver-side
 *     dedupe is an S18/S19 follow-up: `parseStructured` currently drops the extra field);
 *  5. a rejected removal (not-synced timeout, abort, publish failure, ...) leaves the marker as it is and sends nothing.
 *     A TERMINAL rejection (`isTerminalRemovalError`: not-admin, not-a-member, group disbanded / abandoned) can never
 *     succeed: the marker is compare-and-cleared, the error reported once and the outcome is `terminal` (no backoff).
 *     A declined marker older than `DECLINED_MARKER_MAX_AGE_MS` (30 days, the library's invite retention) is dropped
 *     by the replay (`expired`: cleared, reported). A marker with an unknown `phase` is invalid: ignored and reported.
 *     Replays: `startupRetry`, `retryDeclined` (call it on reconnect / sync, S18) and an in-session bounded backoff
 *     (30 s, 2 min, 10 min, abortable by `dispose`) after `retry-later` / `group-missing`. Replays are idempotent
 *     (marker re-read, per-key in-flight de-duplication, the leaf checks), so a duplicate event or a retry racing a
 *     live decline removes and announces once.
 *
 * The removal job only STARTS the work: the bounded `synced()` wait (30 s by default) of one group must not
 * stall the serial client job queue behind it, so the job returns while the removal runs on. `idle()` awaits it.
 *
 * Privacy: the announcement is an MLS group message to the members (never public); its content is the invitee's
 * pubkey (as the legacy announcement), the dedup id and no profile data.
 *
 * Re-entrancy: `onWelcomeDeclined` is the only member to call from a library frame (it makes no client call).
 * `retryDeclined` calls the client and must run outside one (from a job).
 *
 * Pure module: no React, no browser API; every port is injected and validated at construction.
 */
import type { MarmotGroup } from '@941design/marmot';
import type { ClientJobQueue } from '../client';
import type { DeclineMarkerStore } from '../pendingDirectInviteStorage';
import type { GroupOpQueue } from '../send';
import type { InviteGroup, KeyPackageInviter } from './invite';

/**
 * The slice of `MarmotGroup` the removal uses. `removeLeaf` is optional: the library's group handle does not expose
 * it today (only the device service does), so a declined leaf next to other leaves of the account is not removed.
 */
export type DeclineGroup = Pick<MarmotGroup, 'id' | 'synced' | 'removeMember' | 'leaves'> & {
  ingest?: MarmotGroup['ingest'];
  removeLeaf?: (leafKey: string) => Promise<unknown>;
};

/** What happened to one declined marker. */
export type DeclineOutcome =
  /** The Remove resolved (or had landed) and the announcement was sent: marker cleared. */
  | 'removed'
  /** The declined leaf no longer exists: marker cleared, no Remove, no announcement. */
  | 'already-removed'
  /** The account holds other leaves and the declined one cannot be removed alone: nothing removed, marker cleared, reported. */
  | 'superseded'
  /** The marker is gone, replaced by a newer invite or not declined: nothing done. */
  | 'no-marker'
  /** The removal was refused for good (not admin, not a member, group disbanded / abandoned): marker cleared, reported once, no retry. */
  | 'terminal'
  /** The declined marker outlived `DECLINED_MARKER_MAX_AGE_MS`: dropped (cleared, reported) without a removal. */
  | 'expired'
  /** The group is not loaded: marker kept for the next attempt. */
  | 'group-missing'
  /** The removal (or the announcement) failed or was aborted: marker kept for the next attempt. */
  | 'retry-later';

/** In-session backoff between replays of a `retry-later` / `group-missing` marker; the bound is the list length. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** A declined marker older than this is dropped by the replay (the library's default invite retention, `DEFAULT_INVITE_RETENTION_MS`: 30 days). */
export const DECLINED_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const TERMINAL_CODES: ReadonlySet<string> = new Set(['not-admin', 'not-a-member', 'member-not-found', 'group-disbanded', 'disbanded', 'abandoned']);

/**
 * Whether a rejection of the removal can never succeed on a retry: the library's `MarmotError` code `not-a-member`
 * (group abandoned / disbanded / torn down), `invalid-options` with `details.reason` `not-admin` (the sponsor is not
 * an admin), or any of those names as a plain `code` / `details.reason`. Everything else (timeouts, aborts, publish
 * failures, `commit-pending`, unknown errors) is retryable.
 */
export function isTerminalRemovalError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (typeof code === 'string' && TERMINAL_CODES.has(code)) return true;
  const reason = typeof details === 'object' && details !== null ? (details as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' && TERMINAL_CODES.has(reason);
}

export interface DeclineDurabilityDeps {
  store: DeclineMarkerStore;
  /** The sponsor's group by id (production: `client.groups.get`); `undefined` when it is not loaded. */
  getGroup: (groupId: string) => Promise<DeclineGroup | undefined>;
  queue: Pick<GroupOpQueue, 'runCommit'>;
  /** Sends the `declined` announcement as a group message (production: the S6 sender, kind 9). */
  announce: (group: DeclineGroup, content: string) => Promise<unknown>;
  /** `handle.enqueue` of the account client. */
  enqueue: ClientJobQueue['enqueue'];
  /** Reported problems (default `console.error`); never throws out of this module. */
  onError?: (error: unknown) => void;
  /** Bound of the `synced()` wait of the removal (queue default 30 s). */
  syncTimeoutMs?: number;
  /** Delays of the in-session replays after `retry-later` / `group-missing` (default 30 s, 2 min, 10 min; `[]` disables). */
  retryDelaysMs?: readonly number[];
  /** Maximum age of a declined marker (default `DECLINED_MARKER_MAX_AGE_MS`); older ones are dropped by the replay. */
  maxAgeMs?: number;
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number;
}

export interface DeclineDurability {
  /** `client.on('welcomeDeclined')` listener: synchronous, makes no client call, enqueues as its last action. */
  onWelcomeDeclined: (payload: { readonly groupId: string; readonly inviteeRef: string }) => void;
  /** Schedules the replay of every `declined` marker on the job queue (call once after bootstrap). */
  startupRetry: () => void;
  /** Replays every `declined` marker now and resolves with each outcome (S18: call on reconnect / sync). Never from inside a library frame. */
  retryDeclined: () => Promise<DeclineOutcome[]>;
  /** Replays the one marker of (groupId, pubkey) from a queued job (wire to `onRecordedDeclined` of the inviter). */
  replayMarker: (groupId: string, pubkey: string) => void;
  /** Resolves once every removal started so far settled (test / teardown aid). */
  idle: () => Promise<void>;
  /** Aborts removals still waiting for `synced()` and pending backoff replays; later events and retries are ignored. The markers stay. */
  dispose: () => void;
}

/** Stable id of one decline: what a receiver can de-duplicate the at-least-once announcement on. */
export function declinedDedupId(groupId: string, inviteeRef: string): string {
  return `${groupId}:${inviteeRef}`;
}

/** The `declined` invite-lifecycle announcement content (the `parseStructured` shape, no `by`, plus the dedup `id`). */
export function buildDeclinedAnnouncementContent(pubkey: string, dedupId: string): string {
  return JSON.stringify({ type: 'invite_lifecycle', event: 'declined', pubkey, id: dedupId });
}

const requireFn = (value: unknown, name: string, who: string): void => {
  if (typeof value !== 'function') throw new TypeError(`${who}: required dependency "${name}" is missing`);
};

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

function reporter(onError: ((e: unknown) => void) | undefined) {
  const sink = onError ?? ((e: unknown) => console.error('[marmot/invitations] decline durability', e));
  return (e: unknown) => {
    try {
      sink(e);
    } catch {
      /* a failing error sink must not surface either */
    }
  };
}

/** What the queued op decided. */
type Verdict = 'no-marker' | 'already-removed' | 'superseded' | 'removed' | 'announce-only';

export function createDeclineDurability(deps: DeclineDurabilityDeps): DeclineDurability {
  const who = 'createDeclineDurability';
  if (!deps || typeof deps !== 'object') throw new TypeError(`${who}: dependencies are required`);
  const { store, queue } = deps;
  if (!store || typeof store !== 'object') throw new TypeError(`${who}: required dependency "store" is missing`);
  for (const method of ['get', 'markDeclined', 'listDeclined', 'setPhase', 'clearIfRef'] as const) requireFn(store[method], `store.${method}`, who);
  requireFn(queue?.runCommit, 'queue.runCommit', who);
  requireFn(deps.getGroup, 'getGroup', who);
  requireFn(deps.announce, 'announce', who);
  requireFn(deps.enqueue, 'enqueue', who);
  if (deps.syncTimeoutMs !== undefined && !(Number.isFinite(deps.syncTimeoutMs) && deps.syncTimeoutMs > 0)) {
    throw new TypeError(`${who}: syncTimeoutMs must be a positive number`);
  }
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  if (!Array.isArray(retryDelays) || retryDelays.some((d) => !(Number.isFinite(d) && d >= 0))) {
    throw new TypeError(`${who}: retryDelaysMs must be a list of non-negative numbers`);
  }
  const maxAgeMs = deps.maxAgeMs ?? DECLINED_MARKER_MAX_AGE_MS;
  if (!(Number.isFinite(maxAgeMs) && maxAgeMs > 0)) throw new TypeError(`${who}: maxAgeMs must be a positive number`);
  if (deps.now !== undefined) requireFn(deps.now, 'now', who);
  const now = deps.now ?? Date.now;
  const { getGroup, announce, enqueue } = deps;
  const report = reporter(deps.onError);
  const abort = new AbortController();
  /** Removals in flight, by marker key: a duplicate request joins it. */
  const inFlight = new Map<string, Promise<DeclineOutcome>>();
  const active = new Set<Promise<unknown>>();
  /** In-session backoff: replays already scheduled per marker key, and the pending timer. */
  const retryCount = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    active.add(p);
    const forget = () => void active.delete(p);
    p.then(forget, forget);
    return p;
  };

  /** Best-effort phase write: a failing write is reported and the removal goes on (a replay recovers from the older phase). */
  async function setPhase(groupId: string, pubkey: string, ref: string, phase: 'removing' | 'announce-pending'): Promise<boolean> {
    try {
      return await store.setPhase(groupId, pubkey, ref, phase);
    } catch (error) {
      report(error);
      return true;
    }
  }

  async function processMarker(groupId: string, pubkey: string): Promise<DeclineOutcome> {
    const marker = await store.get(groupId, pubkey);
    if (!marker || !marker.declined) return 'no-marker';
    if (marker.declinedAt !== undefined && now() - marker.declinedAt > maxAgeMs) {
      report(new Error(`decline of ${marker.pubkey} in ${groupId} dropped: older than the maximum age; nothing removed`));
      try {
        await store.clearIfRef(groupId, marker.pubkey, marker.inviteeRef);
      } catch (error) {
        report(error);
      }
      return 'expired';
    }
    const group = await getGroup(groupId);
    if (!group) return 'group-missing';
    const ref = marker.inviteeRef;
    const clear = async () => {
      try {
        await store.clearIfRef(groupId, marker.pubkey, ref);
      } catch (error) {
        report(error);
      }
    };
    let verdict: Verdict;
    try {
      verdict = await queue.runCommit(
        group,
        async (): Promise<Verdict> => {
          // Authoritative: after the bounded synced(), re-read the marker (it may have been replaced or cleared
          // while this waited) and decide on the CURRENT member list.
          const cur = await store.get(groupId, pubkey);
          if (!cur || !cur.declined || cur.inviteeRef !== ref) return 'no-marker';
          const phase = cur.phase ?? 'declined';
          if (phase === 'announce-pending') return 'announce-only';
          const held = group.leaves(cur.pubkey);
          const leafGone = cur.leafKey ? !held.some((l) => l.leafKey === cur.leafKey) : held.length === 0;
          if (leafGone) return phase === 'removing' ? 'announce-only' : 'already-removed';
          const others = cur.leafKey ? held.filter((l) => l.leafKey !== cur.leafKey).length : held.length - 1;
          if (others > 0) {
            // Another leaf of the account exists (re-added, second device): only the declined leaf may go.
            if (!cur.leafKey || typeof group.removeLeaf !== 'function') return 'superseded';
            if (!(await setPhase(groupId, pubkey, ref, 'removing'))) return 'no-marker';
            await group.removeLeaf(cur.leafKey);
          } else {
            if (!(await setPhase(groupId, pubkey, ref, 'removing'))) return 'no-marker';
            await group.removeMember(cur.pubkey);
          }
          await setPhase(groupId, pubkey, ref, 'announce-pending');
          return 'removed';
        },
        { signal: abort.signal, syncTimeoutMs: deps.syncTimeoutMs },
      );
    } catch (error) {
      report(error);
      if (isTerminalRemovalError(error)) {
        await clear();
        return 'terminal';
      }
      return 'retry-later';
    }
    if (verdict === 'no-marker') return 'no-marker';
    if (verdict === 'already-removed' || verdict === 'superseded') {
      if (verdict === 'superseded') {
        report(new Error(`decline of ${marker.pubkey} in ${groupId} superseded: the account holds other leaves; nothing removed`));
      }
      await clear();
      return verdict;
    }
    // The Remove resolved (now or earlier): announce, at least once; the marker goes only after the send.
    if (verdict === 'announce-only') await setPhase(groupId, marker.pubkey, ref, 'announce-pending');
    try {
      await announce(group, buildDeclinedAnnouncementContent(marker.pubkey, declinedDedupId(groupId, ref)));
    } catch (error) {
      report(error);
      return 'retry-later'; // marker stays announce-pending: the replay announces without a second Remove
    }
    await clear();
    return 'removed';
  }

  const reportInvalid = (key: string, phase: unknown) =>
    report(new Error(`marker ${key} ignored: invalid phase ${JSON.stringify(phase) ?? String(phase)}`));
  const keyOf = (groupId: string, pubkey: string) => `${groupId}:${pubkey}`;

  function cancelRetry(key: string): void {
    const t = retryTimers.get(key);
    if (t !== undefined) clearTimeout(t);
    retryTimers.delete(key);
  }

  /** After a replay settled: a retryable outcome schedules the next bounded backoff replay. */
  function settle(groupId: string, pubkey: string, outcome: DeclineOutcome): void {
    const key = keyOf(groupId, pubkey);
    if (outcome !== 'retry-later' && outcome !== 'group-missing') {
      retryCount.delete(key);
      cancelRetry(key);
      return;
    }
    if (abort.signal.aborted || retryTimers.has(key)) return;
    const n = retryCount.get(key) ?? 0;
    if (n >= retryDelays.length) return; // bound reached: startupRetry / retryDeclined take over
    retryCount.set(key, n + 1);
    retryTimers.set(
      key,
      setTimeout(() => {
        retryTimers.delete(key);
        if (abort.signal.aborted) return;
        enqueue(async () => {
          if (!abort.signal.aborted) void start(groupId, pubkey, true);
        });
      }, retryDelays[n]),
    );
  }

  /** `processMarker` joined per marker key: one removal in flight per (group, invitee). A timer replay keeps the backoff count; any other start resets it. */
  function start(groupId: string, pubkey: string, fromTimer = false): Promise<DeclineOutcome> {
    const key = keyOf(groupId, pubkey);
    if (!fromTimer) {
      retryCount.delete(key);
      cancelRetry(key);
    }
    const running = inFlight.get(key);
    if (running) return running;
    const p = track(
      processMarker(groupId, pubkey)
        .catch((error: unknown): DeclineOutcome => {
          report(error);
          return 'retry-later';
        })
        .then((outcome) => {
          settle(groupId, pubkey, outcome);
          return outcome;
        })
        .finally(() => void inFlight.delete(key)),
    );
    inFlight.set(key, p);
    return p;
  }

  return {
    onWelcomeDeclined(payload) {
      if (abort.signal.aborted) return;
      if (!payload || !nonEmpty(payload.groupId) || !nonEmpty(payload.inviteeRef)) {
        report(new TypeError('welcomeDeclined: payload without groupId / inviteeRef ignored'));
        return;
      }
      // The durable write starts NOW (a crash before the queued job must not lose a once-fired event) and is
      // an idb write, not a client call. A failing write yields `undefined`: no marker, so no removal.
      const marked = Promise.resolve()
        .then(async () => {
          const entry = await store.markDeclined(payload.groupId, payload.inviteeRef);
          if (!entry) {
            report(new Error(`welcomeDeclined: no marker for inviteeRef ${payload.inviteeRef} in ${payload.groupId}; kept as an orphan decline`));
          }
          return entry;
        })
        .catch((error: unknown) => {
          report(error);
          return undefined;
        });
      // Last action of the listener: the removal runs from a later macrotask, after the frame returned.
      enqueue(async () => {
        const entry = await marked;
        if (!entry || abort.signal.aborted) return; // unknown inviteeRef (orphan stored) / legacy marker
        void start(entry.groupId, entry.marker.pubkey);
      });
    },

    startupRetry() {
      if (abort.signal.aborted) return;
      enqueue(async () => {
        const declined = await store.listDeclined(reportInvalid);
        for (const { groupId, marker } of declined) {
          if (abort.signal.aborted) return;
          void start(groupId, marker.pubkey);
        }
      });
    },

    async retryDeclined() {
      if (abort.signal.aborted) return [];
      const declined = await store.listDeclined(reportInvalid);
      return Promise.all(declined.map(({ groupId, marker }) => start(groupId, marker.pubkey)));
    },

    replayMarker(groupId, pubkey) {
      if (abort.signal.aborted || !nonEmpty(groupId) || !nonEmpty(pubkey)) return;
      enqueue(async () => {
        if (!abort.signal.aborted) void start(groupId, pubkey.toLowerCase());
      });
    },

    async idle() {
      while (active.size > 0) await Promise.allSettled([...active]);
    },

    dispose() {
      abort.abort();
      for (const key of [...retryTimers.keys()]) cancelRetry(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Invite time
// ---------------------------------------------------------------------------

export interface MarkerRecordingInviterDeps {
  inviter: Pick<KeyPackageInviter, 'inviteByPubkey'>;
  store: Pick<DeclineMarkerStore, 'record'>;
  /**
   * REQUIRED. Called (never throws out) when the record consumed an orphan decline and started `declined`: wire it to
   * `DeclineDurability.replayMarker` so the removal is enqueued. Without a handler an adopted decline would never be removed.
   */
  onRecordedDeclined: (groupId: string, pubkey: string) => void;
  onError?: (error: unknown) => void;
  /** Clock (epoch ms; default `Date.now`): `invitedAt` is read from it before the invite runs. */
  now?: () => number;
}

/** The leaf signature keys `account` holds in `group` now; `undefined` when the handle cannot say. */
function leafKeysOf(group: InviteGroup, account: string): string[] | undefined {
  if (typeof group.leaves !== 'function') return undefined;
  try {
    return group.leaves(account).map((l) => l.leafKey).filter((k): k is string => typeof k === 'string' && k !== '');
  } catch {
    return undefined;
  }
}

/**
 * Wraps the invite: after an accepted invite (`outcome`), persists `inviteeRef -> pubkey` (and the added leaf's
 * `leafKey`) in the pending-direct-invite marker (`declined:false`) before the result is returned, so a later
 * `welcomeDeclined` can be matched and bound to that leaf. `leafKey` = the account's leaves after the invite minus
 * the ones before it; recorded only when that is exactly one leaf, otherwise none (the removal then falls back to
 * the account and only when it holds a single leaf). The marker write is best-effort: a failure is reported and
 * the committed invite is returned unchanged. A result that is an `error` value records nothing. Same
 * re-entrancy rule as `inviteByPubkey`.
 */
export function createMarkerRecordingInviter(deps: MarkerRecordingInviterDeps): Pick<KeyPackageInviter, 'inviteByPubkey'> {
  const who = 'createMarkerRecordingInviter';
  if (!deps || typeof deps !== 'object') throw new TypeError(`${who}: dependencies are required`);
  requireFn(deps.inviter?.inviteByPubkey, 'inviter.inviteByPubkey', who);
  requireFn(deps.store?.record, 'store.record', who);
  requireFn(deps.onRecordedDeclined, 'onRecordedDeclined', who);
  if (deps.now !== undefined) requireFn(deps.now, 'now', who);
  const { inviter, store } = deps;
  const clock = deps.now ?? Date.now;
  const report = reporter(deps.onError);
  return {
    async inviteByPubkey(group: InviteGroup, pubkey: string, opts) {
      const account = typeof pubkey === 'string' ? pubkey.toLowerCase() : pubkey;
      const before = leafKeysOf(group, account);
      // Before the invite: a decline of an EARLIER invite of the same ref that is older than this is stale, never adopted.
      const invitedAt = clock();
      const result = await inviter.inviteByPubkey(group, pubkey, opts);
      if ('outcome' in result) {
        try {
          let leafKey: string | undefined;
          const after = before === undefined ? undefined : leafKeysOf(group, account);
          if (before && after) {
            const added = after.filter((k) => !before.includes(k));
            if (added.length === 1) leafKey = added[0];
          }
          const marker = await store.record(group.id, pubkey, result.outcome.inviteeRef, leafKey, invitedAt);
          if (marker?.declined) {
            try {
              deps.onRecordedDeclined(group.id, marker.pubkey);
            } catch (error) {
              report(error);
            }
          }
        } catch (error) {
          report(error);
        }
      }
      return result;
    },
  };
}
