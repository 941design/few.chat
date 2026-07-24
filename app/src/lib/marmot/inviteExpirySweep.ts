/**
 * Client-side invite-link expiry sweep (epic: invite-link-lifecycle, S4).
 *
 * Scans every locally-stored invite link — all groups, with no "created by
 * this user" filter (architecture.md's Implementation Constraints: invite
 * link state is already confined to the creating device by construction,
 * so there is nothing to filter by). For each link that is expired
 * (`isExpired(link, now)`) and not yet `expiryNotified`, it:
 *
 *   1. Persists `expiryNotified: true` via `markInviteLinkExpiryNotified`
 *      (the IDB write) — BEFORE
 *   2. Bumping the in-memory `inviteExpiries` badge slice via
 *      `incrementInviteExpiry(link.groupId)`.
 *
 * That ordering is load-bearing (AC-INV-4, Design Decision 8): an
 * interruption between the two steps leaves the link "stamped but not
 * shown", which the next `initInviteExpiries()` call recovers correctly by
 * re-deriving the count straight from the (now-persisted) flags — never
 * "shown twice" and never silently lost.
 *
 * Concurrent invocations — React StrictMode's mount/unmount/remount double
 * effect firing this sweep on load, two `NotificationBell` instances
 * mounted at once for the desktop/mobile breakpoints (Layout.tsx renders
 * both; only one is visible per viewport, but both are mounted), each on
 * their own 60s interval, or a plain overlapping interval tick — are
 * deduplicated onto a single in-flight promise, mirroring
 * `migrateInviteLinks`'s latch in `inviteLinkStorage.ts`. A second call
 * that arrives while a sweep pass is running returns the SAME promise
 * rather than re-scanning the store, so a link can never be notified twice
 * from two overlapping passes (AC-INV-1, AC-NOTIFY-2). Once a pass
 * completes and its stamps are persisted, a later, non-overlapping call
 * naturally skips already-`expiryNotified` links via the guard below — the
 * latch only needs to cover genuine overlap, not every later tick.
 *
 * Migration-suppressed links (`expiryNotified` already `true` — either from
 * a genuine prior sweep pass, or from `migrateInviteLinks`'s AC-MIGRATE-3/5
 * back-stamp for links that were already expired, or muted, before this
 * feature existed) are simply skipped by the `!link.expiryNotified` guard
 * below. This module never re-derives or overrides that decision —
 * AC-INV-3's suppression guarantee belongs to `migrateInviteLinks` itself;
 * this module's only obligation is to never clobber it.
 */

import { loadAllInviteLinks, isExpired, markInviteLinkExpiryNotified, markInviteLinkExpiryAcknowledged, migrateInviteLinks } from './inviteLinkStorage';
import { incrementInviteExpiry, initInviteExpiries } from '@/src/lib/unreadStore';
import { isActiveView } from '@/src/lib/activeViewStore';

let sweepInFlight: Promise<void> | null = null;

async function runSweep(now: number): Promise<void> {
  let links: Awaited<ReturnType<typeof loadAllInviteLinks>>;
  try {
    links = await loadAllInviteLinks();
  } catch {
    // Non-fatal — invite-link store may not exist yet (fresh install).
    return;
  }

  for (const link of links) {
    if (link.expiryNotified || !isExpired(link, now)) continue;
    try {
      // IDB stamp BEFORE the in-memory bump (AC-INV-4) — see module doc comment.
      // Only bump the badge if the stamp actually persisted: the link may have
      // been deleted/cleared between loadAllInviteLinks() above and this write,
      // in which case markInviteLinkExpiryNotified no-ops and returns false —
      // bumping then would leave a phantom unread expiry for a link that is gone.
      const stamped = await markInviteLinkExpiryNotified(link.nonce);
      if (stamped) {
        // notification-domain-invariants (INV-2): if this link's group has its
        // detail open, the expiry surfaces in that view (manage-links) — so it
        // must not ring the bell. Acknowledge it (in addition to the notified
        // stamp above) so initInviteExpiries' reload derivation stays clear.
        // Any other view rings the bell as before (INV-1).
        if (isActiveView('group', link.groupId)) {
          await markInviteLinkExpiryAcknowledged(link.nonce);
        } else {
          incrementInviteExpiry(link.groupId);
        }
      }
    } catch (err) {
      // Non-fatal — one bad record must not abort the rest of the sweep pass.
      console.warn('[inviteExpirySweep] failed to notify link', link.nonce, err);
    }
  }
}

/**
 * Runs one expiry-sweep pass. Takes an injectable `now` for testability
 * (no wall-clock dependency, matching `isExpired`/`migrateInviteLinks`).
 *
 * Safe to call redundantly — on load, on every 60s interval tick, from
 * multiple mounted callers — see the module doc comment above for the
 * latch and stamp-before-bump ordering guarantees that make repeated or
 * concurrent calls notify each link at most once.
 */
export function runInviteExpirySweep(now: number = Date.now()): Promise<void> {
  if (sweepInFlight) return sweepInFlight;
  const run = runSweep(now).finally(() => {
    sweepInFlight = null;
  });
  sweepInFlight = run;
  return run;
}

/** Injectable collaborators for `runInviteExpiryCycle` (defaults to the real ones). */
export interface InviteExpiryCycleDeps {
  migrate: (now: number) => Promise<void>;
  sweep: (now: number) => Promise<void>;
  // `initInviteExpiries` reads IndexedDB and returns a promise — the cycle must
  // AWAIT it, or `await runInviteExpiryCycle()` resolves while the badge is
  // still stale. Typed as returning a promise so the await is not accidentally
  // dropped again (a `() => void` type silently accepts a promise-returning fn).
  derive: (now: number) => Promise<void>;
}

const defaultCycleDeps: InviteExpiryCycleDeps = {
  migrate: migrateInviteLinks,
  sweep: runInviteExpirySweep,
  derive: initInviteExpiries,
};

/**
 * One full expiry-notification cycle: migrate legacy records, then — ONLY if
 * migration succeeded — sweep for newly-expired links, then re-derive the
 * badge from persisted flags.
 *
 * Migration MUST precede the sweep on EVERY cycle, not just the first:
 *  - If migration REJECTS, the sweep is skipped this cycle. An un-migrated
 *    legacy expired record has no `expiryNotified` flag, so sweeping it would
 *    fire a retroactive-expiry notification — exactly the flood
 *    `migrateInviteLinks` suppresses (AC-INV-3, Design Decision 3). The next
 *    cycle retries migration.
 *  - Running migration before EACH interval tick (not only on mount) covers
 *    legacy records introduced after startup — e.g. an older backup restored
 *    while the app is open — so an interval sweep never treats a freshly
 *    restored legacy expired link as newly expired.
 * `migrateInviteLinks` is idempotent and cheap (in-flight-latched, fills only
 * missing fields), so re-running it every tick is safe.
 *
 * `derive` always runs (even when migration failed): re-deriving from the
 * already-persisted flags never floods, because an un-migrated legacy link has
 * no `expiryNotified` and is excluded by the derive predicate.
 */
export async function runInviteExpiryCycle(
  now: number = Date.now(),
  deps: InviteExpiryCycleDeps = defaultCycleDeps,
): Promise<void> {
  let migrated = false;
  try {
    await deps.migrate(now);
    migrated = true;
  } catch {
    // Migration failed — skip the sweep this cycle (see doc comment). Retry next tick.
  }
  if (migrated) {
    try {
      await deps.sweep(now);
    } catch {
      // Non-fatal — per-link error handling lives inside the sweep.
    }
  }
  try {
    // AWAIT the derive: it reads IDB and re-emits the badge; resolving the
    // cycle before it settles would leave a caller that awaits the cycle
    // observing stale `inviteExpiries`. Swallow a derive rejection so the
    // cycle never rejects (the component fires it as `void runInviteExpiryCycle`).
    await deps.derive(now);
  } catch {
    // Non-fatal — the badge simply keeps its previous derived value.
  }
}

/**
 * How often the sweep re-checks for newly-expired invite links while the app is
 * open. Rehomed here from `NotificationBell` (epic: obsolete-notification-bell,
 * TRAP 1) — it belongs with the sweep, not with whatever component happens to
 * host the interval.
 */
export const INVITE_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/** Injectable collaborators for `startInviteExpirySweep` (defaults to the real ones). */
export interface InviteExpirySweepScheduleDeps {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  run: (now: number) => void;
}

/**
 * Start the periodic expiry-notification cycle: run one cycle immediately, then
 * once every {@link INVITE_EXPIRY_SWEEP_INTERVAL_MS}. Returns a stop function
 * that cancels the interval.
 *
 * Rehomed out of `NotificationBell` when the bell was deleted (epic:
 * obsolete-notification-bell, INV-B / TRAP 1). The bell mounted twice
 * (desktop + mobile), so the sweep ran on a double mount; `runInviteExpirySweep`
 * latches concurrent callers onto one in-flight promise and stamps
 * before bumping, so the cycle is idempotent and double-mount-safe. Its new
 * host (`DirectMessageNotificationsWatcher`) mounts exactly once, which is
 * strictly simpler; the safety guarantees hold either way.
 *
 * Collaborators are injectable so the schedule (fire-once-then-every-60s, and
 * stop-cancels-further-runs) is unit-testable with a fake clock/scheduler — this
 * repo has no jsdom/renderHook precedent, so the schedulable behaviour is
 * extracted here rather than asserted through a mounted component.
 */
export function startInviteExpirySweep(
  deps: Partial<InviteExpirySweepScheduleDeps> = {},
): () => void {
  const now = deps.now ?? Date.now;
  const setIntervalFn =
    deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearInterval ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
  const run = deps.run ?? ((n: number) => { void runInviteExpiryCycle(n); });

  run(now());
  const handle = setIntervalFn(() => run(now()), INVITE_EXPIRY_SWEEP_INTERVAL_MS);
  return () => clearIntervalFn(handle);
}
