/**
 * Pending-invitation view (D14, seam `PendingInvitationView`, AC-INV-2 / AC-INV-4 / AC-BLK-1 / AC-CAP-1).
 *
 * `invitations.pending()` of the library is the ONLY pending store: this module reads nothing else
 * (the library is the sole source of pending invitations). ADR-002 (pull-only) is the library's
 * behaviour with no `expectWelcome` manifest: an unexpected Welcome lands in `pending()` and nothing joins
 * until `accept`. The view adds what the app owns on top of that list, evaluated on every refresh in this order:
 *
 *   1. deny layer: an entry whose sponsor is blocked is never shown, never announced (no `onArrival`, so no
 *      bell) and is declined with `decline(id, {declineRumor:false})`; a block beats trust;
 *   2. retention (`applyPendingCaps`, AC-CAP-1): stranger invitations older than 14 days expire, then 8 per
 *      inviter, then 256 in total ranked trusted-first, so a stranger flood cannot lock out people the user knows.
 *      Trust is `isTrustedSponsor(sponsorAccount)`, re-evaluated on every refresh (no cache): a sponsor who became
 *      a known peer since the last refresh is trusted from then on. Already shown entries keep their place within
 *      their trust class regardless of a later arrival's `receivedAt`.
 *
 * Every decline made here is silent: `{declineRumor:false}` sends no rumor and no gift wrap to the sponsor, and
 * there is no UI signal. RESIDUAL SIGNAL: the library still rotates the consumed key package in the background
 * (welcome-processor `rotateInBackground`), which publishes a replacement key package; that public publish is
 * observable (timing only) and is not suppressed by `declineRumor:false`.
 *
 * The library list is async, the seam `pending()` is synchronous: the view keeps a snapshot that a refresh
 * recomputes. A refresh makes ACCOUNT-SCOPE client calls (`pending`, `decline`), so it must never run inside a
 * library frame: `onInboxDisposition` (a client listener) therefore only ENQUEUES the refresh on the owned
 * job queue, as its last action; `refresh()` / `seed()` are for callers outside a frame (startup, UI handlers,
 * tests). Refreshes are serialised and collapse: a trigger while one is already queued adds nothing. The view
 * is disposed and recreated together with the account handle (its job queue): a job the queue does not accept
 * (queue disposed) resets the collapse flag instead of wedging it.
 *
 * Seeding: only an explicit `seed()` (startup, after bootstrap) or a `refresh()` called before anything was
 * recomputed loads the list WITHOUT `onArrival` (the card list shows what is already pending; a bell for those is
 * the consumer's call). A first recompute caused by `onInboxDisposition` is a real arrival and announces.
 *
 * A failed decline is reported and retried by the next refresh (the entry is still in the library list); the
 * entry stays hidden meanwhile, so the shown set always satisfies the deny layer and the retention rules.
 * `onArrival` fires once per newly visible invitation (including a trusted one that displaced a stranger).
 *
 * Pure module: ports are injected and validated at construction; no React, no storage.
 */
import type { PendingInvitation } from '@941design/marmot';
import { applyPendingCaps } from './caps';
import type { DenyLayer } from './denyLayer';

/** The slice of `MarmotClient['invitations']` the view uses. */
export interface PendingInvitationsApi {
  pending: () => Promise<readonly PendingInvitation[]>;
  decline: (id: string, options?: { readonly declineRumor?: boolean }) => Promise<void>;
}

interface PendingInvitationViewDeps {
  invitations: PendingInvitationsApi;
  denyLayer: DenyLayer;
  /** `AccountClientHandle.enqueue`: follow-up client work, started after the enqueuing frame returned. `false` = not accepted (queue disposed). */
  enqueue: (job: () => Promise<void>) => boolean | void;
  /** True iff the sponsor is the own account or a known peer. Called on every refresh (production: `createTrustedSponsorPredicate`). */
  isTrustedSponsor: (sponsorAccount: string) => boolean;
  /** Clock, ms (injected for the stranger TTL). */
  now: () => number;
  /** Failed refresh/decline (default `console.error`). */
  onError?: (error: unknown) => void;
}

/** The inbox dispositions that can change the pending list: a new Welcome, or one that was consumed/replaced. */
const REFRESHING_DISPOSITIONS: ReadonlySet<string> = new Set(['pending', 'joined', 'already-member', 'branch-switched']);

export interface PendingInvitationView {
  /** The shown invitations, oldest first. A copy: callers may keep it. */
  pending: () => PendingInvitation[];
  /** Fires after a refresh changed the shown set. */
  onChange: (cb: () => void) => () => void;
  /** Fires once per invitation that newly becomes visible (never blocked, expired or over a cap; never for a `seed()`). */
  onArrival: (cb: (invitation: PendingInvitation) => void) => () => void;
  /** Client-listener entry (`clientEvents.inboxDisposition`): frame-safe, only enqueues a refresh. */
  onInboxDisposition: (disposition: { readonly kind: string }) => void;
  /** Recomputes the shown set from `invitations.pending()` now. NOT for library frames. The first recompute of a view seeds (no arrivals). */
  refresh: () => Promise<PendingInvitation[]>;
  /** Startup: loads the pending list as the baseline, announcing nothing. NOT for library frames. */
  seed: () => Promise<PendingInvitation[]>;
  /** Enqueues a refresh on the job queue (frame-safe). */
  scheduleRefresh: () => void;
  /** Whether `id` is in the shown set as of the last refresh. */
  isVisible: (id: string) => boolean;
  dispose: () => void;
}

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createPendingInvitationView: required dependency "${name}" is missing`);
}

export function createPendingInvitationView(deps: PendingInvitationViewDeps): PendingInvitationView {
  if (!deps) throw new TypeError('createPendingInvitationView: dependencies are required');
  requireFn(deps.invitations?.pending, 'invitations.pending');
  requireFn(deps.invitations?.decline, 'invitations.decline');
  requireFn(deps.denyLayer?.isBlocked, 'denyLayer.isBlocked');
  requireFn(deps.enqueue, 'enqueue');
  requireFn(deps.isTrustedSponsor, 'isTrustedSponsor');
  requireFn(deps.now, 'now');
  const { invitations, denyLayer, enqueue, isTrustedSponsor, now } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] pending view', e));

  let snapshot: PendingInvitation[] = [];
  let seeded = false;
  let disposed = false;
  let queued = false;
  let chain: Promise<unknown> = Promise.resolve();
  const changeListeners = new Set<() => void>();
  const arrivalListeners = new Set<(i: PendingInvitation) => void>();

  const fire = <A extends unknown[]>(listeners: Set<(...a: A) => void>, ...args: A) => {
    for (const l of [...listeners]) {
      try {
        l(...args);
      } catch (e) {
        onError(e);
      }
    }
  };

  const decline = async (id: string, options?: { declineRumor?: boolean }) => {
    try {
      await invitations.decline(id, options);
    } catch (e) {
      onError(e);
    }
  };

  async function recompute(mode: 'seed' | 'refresh' | 'announce'): Promise<PendingInvitation[]> {
    const list = await invitations.pending();
    const blocked: PendingInvitation[] = [];
    const candidates: PendingInvitation[] = [];
    for (const inv of list) {
      const hostile = denyLayer.isBlocked(inv.sponsorAccount) || inv.sponsors.some((s) => denyLayer.isBlocked(s));
      (hostile ? blocked : candidates).push(inv);
    }
    const { retained, excess } = applyPendingCaps(candidates, {
      isTrusted: isTrustedSponsor,
      now: now(),
      keepFirst: new Set(snapshot.map((i) => i.id)),
    });
    for (const inv of blocked) await decline(inv.id, { declineRumor: false });
    for (const inv of excess) await decline(inv.id, { declineRumor: false });
    if (disposed) return snapshot;

    const before = new Set(snapshot.map((i) => i.id));
    const changed = retained.length !== snapshot.length || retained.some((i, n) => snapshot[n]?.id !== i.id);
    const arrivals = mode === 'announce' || (mode === 'refresh' && seeded) ? retained.filter((i) => !before.has(i.id)) : [];
    snapshot = retained;
    seeded = true;
    if (changed) fire(changeListeners);
    for (const inv of arrivals) fire(arrivalListeners, inv);
    return [...snapshot];
  }

  const run = (mode: 'seed' | 'refresh' | 'announce'): Promise<PendingInvitation[]> => {
    const next = chain.then(() => recompute(mode));
    chain = next.catch(() => undefined);
    return next;
  };
  /** UI / startup entry: seeds when nothing was recomputed yet, announces arrivals afterwards. */
  const refresh = () => run('refresh');
  /** Explicit baseline load: never announces, even after earlier recomputes. */
  const seed = () => run('seed');

  const scheduleRefresh = () => {
    if (disposed || queued) return;
    queued = true;
    let rejected = false;
    try {
      rejected = enqueue(async () => {
        queued = false;
        try {
          await run('announce');
        } catch (e) {
          onError(e);
        }
      }) === false;
    } catch (e) {
      onError(e);
      rejected = true;
    }
    if (rejected) queued = false;
  };

  return {
    pending: () => [...snapshot],
    onChange: (cb) => {
      changeListeners.add(cb);
      return () => void changeListeners.delete(cb);
    },
    onArrival: (cb) => {
      arrivalListeners.add(cb);
      return () => void arrivalListeners.delete(cb);
    },
    onInboxDisposition: (disposition) => {
      if (REFRESHING_DISPOSITIONS.has(disposition.kind)) scheduleRefresh();
    },
    refresh,
    seed,
    scheduleRefresh,
    isVisible: (id) => snapshot.some((i) => i.id === id),
    dispose: () => {
      disposed = true;
      changeListeners.clear();
      arrivalListeners.clear();
    },
  };
}
