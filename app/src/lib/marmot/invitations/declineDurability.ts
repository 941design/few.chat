/**
 * Replays a declined Welcome after the sponsor has synced, including after
 * restart. The marker binds the decline to the KeyPackage leaf and records
 * progress before the removal and before the announcement. Unknown
 * references are held briefly so a decline can arrive during the original
 * invite. Retries reuse the announcement identity for receiver deduplication.
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
type DeclineOutcome =
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
function isTerminalRemovalError(error: unknown): boolean {
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
  /** Schedules replay of declined markers and owed notices on the job queue (call once after bootstrap). */
  startupRetry: () => void;
  /** Replays declined markers and owed notices now and resolves with each outcome. Never from inside a library frame. */
  retryDeclined: () => Promise<DeclineOutcome[]>;
  /** Queues replay of a recorded decline. If no reference is supplied, reads the current account marker. */
  replayMarker: (groupId: string, pubkey: string, inviteeRef?: string) => void;
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
type Verdict = 'no-marker' | 'already-removed' | 'superseded' | 'announce';

export function createDeclineDurability(deps: DeclineDurabilityDeps): DeclineDurability {
  const who = 'createDeclineDurability';
  if (!deps || typeof deps !== 'object') throw new TypeError(`${who}: dependencies are required`);
  const { store, queue } = deps;
  if (!store || typeof store !== 'object') throw new TypeError(`${who}: required dependency "store" is missing`);
  for (const method of ['get', 'getDeclined', 'markDeclined', 'listDeclined', 'setPhase', 'clearIfRef', 'clearAnnouncement'] as const) {
    requireFn(store[method], `store.${method}`, who);
  }
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
  /** Replays in flight, by invite reference: a duplicate request joins it. */
  const inFlight = new Map<string, Promise<DeclineOutcome>>();
  const active = new Set<Promise<unknown>>();
  /** In-session backoff: replays already scheduled per reference, and the pending timer. */
  const retryCount = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    active.add(p);
    const forget = () => void active.delete(p);
    p.then(forget, forget);
    return p;
  };

  /** Persist the start of a removal. A failed completion write can recover from that checkpoint. */
  async function setPhase(groupId: string, pubkey: string, ref: string, phase: 'removing' | 'announce-pending'): Promise<boolean> {
    try {
      return await store.setPhase(groupId, pubkey, ref, phase);
    } catch (error) {
      if (phase === 'removing') throw error;
      report(error);
      return true;
    }
  }

  async function processMarker(groupId: string, pubkey: string, ref: string): Promise<DeclineOutcome> {
    const initial = await store.getDeclined(groupId, pubkey, ref);
    if (!initial || abort.signal.aborted) return 'no-marker';
    const { marker } = initial;
    const getDeclined = async () => {
      const current = await store.getDeclined(groupId, pubkey, ref);
      if (!current || current.marker.sponsorPubkey !== marker.sponsorPubkey || current.marker.invitedAt !== marker.invitedAt) return undefined;
      if (marker.declinedAt !== undefined && current.marker.declinedAt !== marker.declinedAt) return undefined;
      if (initial.archived && !current.archived) return undefined;
      return current;
    };
    const clearAnnouncement = async (replay: typeof initial) => {
      try {
        await store.clearAnnouncement(groupId, replay);
      } catch (error) {
        report(error);
      }
    };
    if (marker.declinedAt !== undefined && now() - marker.declinedAt > maxAgeMs) {
      report(new Error(`decline of ${marker.pubkey} in ${groupId} dropped: older than the maximum age; nothing removed`));
      await clearAnnouncement(initial);
      return 'expired';
    }
    const group = await getGroup(groupId);
    if (!group) return 'group-missing';
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
          // Re-read after sync. A re-invite can move an owed notice while this waits.
          const cur = (await getDeclined())?.marker;
          if (!cur || abort.signal.aborted) return 'no-marker';
          const phase = cur.phase ?? 'declined';
          if (phase === 'announce-pending') return 'announce';
          const held = group.leaves(cur.pubkey);
          if (!cur.leafKey && held.length > 0) return 'superseded';
          const leafGone = !held.some((leaf) => leaf.leafKey === cur.leafKey);
          if (leafGone && phase !== 'removing') return 'already-removed';
          if (!leafGone) {
            // Another leaf of the account exists (re-added, second device): only the declined leaf may go.
            const hasOtherLeaf = held.some((leaf) => leaf.leafKey !== cur.leafKey);
            if (hasOtherLeaf) {
              if (!cur.leafKey || typeof group.removeLeaf !== 'function') return 'superseded';
              if (!(await setPhase(groupId, pubkey, ref, 'removing')) || abort.signal.aborted) return 'no-marker';
              await group.removeLeaf(cur.leafKey);
            } else {
              if (!(await setPhase(groupId, pubkey, ref, 'removing')) || abort.signal.aborted) return 'no-marker';
              await group.removeMember(cur.pubkey);
            }
          }
          await setPhase(groupId, pubkey, ref, 'announce-pending');
          return 'announce';
        },
        { signal: abort.signal, syncTimeoutMs: deps.syncTimeoutMs },
      );
    } catch (error) {
      report(error);
      if (marker.phase !== 'announce-pending' && isTerminalRemovalError(error)) {
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
    // A purge or another replay may have cleared the notice while this job was queued.
    if (abort.signal.aborted) return 'no-marker';
    const owed = await getDeclined();
    if (!owed || abort.signal.aborted) return 'no-marker';
    try {
      await announce(group, buildDeclinedAnnouncementContent(marker.pubkey, declinedDedupId(groupId, ref)));
    } catch (error) {
      report(error);
      return 'retry-later';
    }
    if (!abort.signal.aborted) await clearAnnouncement(owed);
    return 'removed';
  }

  const reportInvalid = (key: string, phase: unknown) =>
    report(new Error(`marker ${key} ignored: invalid phase ${JSON.stringify(phase) ?? String(phase)}`));

  function cancelRetry(key: string): void {
    const t = retryTimers.get(key);
    if (t !== undefined) clearTimeout(t);
    retryTimers.delete(key);
  }

  /** After a replay settled: a retryable outcome schedules the next bounded backoff replay. */
  function settle(groupId: string, pubkey: string, ref: string, outcome: DeclineOutcome): void {
    const key = declinedDedupId(groupId, ref);
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
          if (!abort.signal.aborted) void start(groupId, pubkey, ref, true);
        });
      }, retryDelays[n]),
    );
  }

  /** A timer replay keeps the backoff count for its reference. Other starts reset it. */
  function start(groupId: string, pubkey: string, ref: string, fromTimer = false): Promise<DeclineOutcome> {
    if (abort.signal.aborted) return Promise.resolve('no-marker');
    const key = declinedDedupId(groupId, ref);
    if (!fromTimer) {
      retryCount.delete(key);
      cancelRetry(key);
    }
    const running = inFlight.get(key);
    if (running) return running;
    const p = track(
      processMarker(groupId, pubkey, ref)
        .catch((error: unknown): DeclineOutcome => {
          report(error);
          return 'retry-later';
        })
        .then((outcome) => {
          settle(groupId, pubkey, ref, outcome);
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
        void start(entry.groupId, entry.marker.pubkey, entry.marker.inviteeRef);
      });
    },

    startupRetry() {
      if (abort.signal.aborted) return;
      enqueue(async () => {
        const declined = await store.listDeclined(reportInvalid);
        for (const { groupId, marker } of declined) {
          if (abort.signal.aborted) return;
          void start(groupId, marker.pubkey, marker.inviteeRef);
        }
      });
    },

    async retryDeclined() {
      if (abort.signal.aborted) return [];
      const declined = await store.listDeclined(reportInvalid);
      if (abort.signal.aborted) return [];
      return Promise.all(declined.map(({ groupId, marker }) => start(groupId, marker.pubkey, marker.inviteeRef)));
    },

    replayMarker(groupId, pubkey, inviteeRef) {
      if (abort.signal.aborted || !nonEmpty(groupId) || !nonEmpty(pubkey)) return;
      enqueue(async () => {
        if (abort.signal.aborted) return;
        if (nonEmpty(inviteeRef)) {
          void start(groupId, pubkey.toLowerCase(), inviteeRef);
          return;
        }
        const marker = await store.get(groupId, pubkey);
        if (marker?.declined) void start(groupId, marker.pubkey, marker.inviteeRef);
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

interface MarkerRecordingInviterDeps {
  inviter: Pick<KeyPackageInviter, 'inviteByPubkey'>;
  store: Pick<DeclineMarkerStore, 'record'> & Partial<Pick<DeclineMarkerStore, 'get'>>;
  /**
   * REQUIRED. Called (never throws out) when the record consumed an orphan decline and started `declined`: wire it to
   * `DeclineDurability.replayMarker` so the removal is enqueued. Without a handler an adopted decline would never be removed.
   */
  onRecordedDeclined: (groupId: string, pubkey: string, inviteeRef: string) => void;
  onError?: (error: unknown) => void;
  /** Clock (epoch ms; default `Date.now`): `invitedAt` is read from it before the invite runs. */
  now?: () => number;
}

/**
 * Persist the Welcome reference and its KeyPackage leaf after an invite commits.
 * A storage failure is reported and the invite outcome is returned.
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
      // Before the invite: a decline of an EARLIER invite of the same ref that is older than this is stale, never adopted.
      const invitedAt = clock();
      // Bind the Add's roster evidence to the removing marker that predates it.
      // The marker is compared again inside the replacement transaction.
      let previous: Awaited<ReturnType<DeclineMarkerStore['get']>>;
      try {
        previous = await store.get?.(group.id, pubkey);
      } catch (error) {
        report(error);
      }
      const result = await inviter.inviteByPubkey(group, pubkey, opts);
      if ('outcome' in result) {
        try {
          const removingBeforeInvite = result.inviteeAbsentBeforeAdd === true && previous?.phase === 'removing' ? previous : undefined;
          const marker = await store.record(group.id, pubkey, result.outcome.inviteeRef,
            result.invitedLeafKey, invitedAt, opts?.viaJoinRequest, { removingBeforeInvite });
          if (marker?.declined) {
            try {
              deps.onRecordedDeclined(group.id, marker.pubkey, marker.inviteeRef);
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
