/**
 * ProfileHealWatcher.tsx — always-mounted integration component driving the
 * direct-contact profile-heal loop (epic: direct-contact-profile-exchange,
 * story 05; AC-WATCH-1, AC-WATCH-2).
 *
 * 5th sibling of `DirectMessageNotificationsWatcher` / `PendingPairingIntentWatcher`
 * / `IncomingCallWatcher` in `Layout.tsx`. Owns exactly two responsibilities,
 * neither involving any backoff math or disclosure-gate logic of its own
 * (architecture.md: "Integration wiring only" — all math lives in
 * `dmProfile/scheduler.ts` (story 02), all outbound construction in
 * `dmProfile/send.ts` (story 03), both dispatch arms in `dmProfile/receive.ts`
 * (story 04)):
 *
 *   1. **Due-sweep lifecycle (AC-WATCH-1).** On mount, on window `'online'`,
 *      and on a `DUE_SWEEP_INTERVAL_MS` interval: recompute which contacts
 *      need a brand-new schedule (via `computeContactsNeedingNewSchedule` —
 *      the ONLY sanctioned source, per the S02 ownership-ledger contract, so
 *      a terminal/`given-up`/`answered-incomplete` contact is never
 *      resurrected) and which existing schedules are due (`computeDue`), then
 *      fires each due request (`send.ts#sendProfileRequest`) and advances +
 *      persists its schedule (`scheduler.ts#advance` + `saveSchedule`). When
 *      MORE than `BULK_SWEEP_STAGGER_THRESHOLD` contacts are due in one
 *      sweep, the sends are spread across `BULK_SWEEP_STAGGER_WINDOW_MS`
 *      (`planDueSweep`'s `delayMs`) IN ADDITION to each fire's own +/-20%
 *      jitter already baked into `nextAttemptAt` by the scheduler — this is
 *      the dispatch-time stampede guard spec.md §5 requires; the scheduler's
 *      jitter alone only spreads WHEN a schedule next becomes due, not how a
 *      big batch of already-due schedules is drained in one tick.
 *   2. **Dedicated inbound subscription (AC-WATCH-2).** Opens its OWN
 *      `ndk.subscribe({kinds:[GIFT_WRAP_KIND],'#p':[ownPubkeyHex]})` — a
 *      fourth kind-1059 consumer alongside `welcomeSubscription.ts`,
 *      `DirectMessageNotificationsWatcher`, and `IncomingCallWatcher`'s call
 *      signaling sub, per `exploration.json`'s `DISPATCH_SEAM_DECISION`. Every
 *      inbound wrap is strictly unwrapped via
 *      `directMessages.ts#unwrapAndOpen` ONLY — never
 *      `welcomeSubscription.ts#unwrapGiftWrap` — and routed by inner kind
 *      (`decideDispatch`) to `receive.ts`'s `handleProfileRequest` /
 *      `handleProfileAnnounce`. Cannot filter the subscription by author:
 *      gift-wrap outer `pubkey` is an ephemeral per-wrap key (project
 *      learning `kind-445-events-have-ephemeral-authors`), so `'#p'` is the
 *      only filter term, exactly like the three pre-existing consumers.
 *
 * ## D4 reset-on-activity (spec.md §3.2, Resolved Decisions)
 *
 * A `profile-request` receipt from a contact is itself a D4 "this contact is
 * reachable" signal — independent of whether the disclosure gate ends up
 * answering it (that gate governs OUR disclosure, not whether the sender is
 * observably online). This watcher applies `scheduler.ts#applyReachabilitySignal`
 * to that sender's OWN existing schedule (if any — a stranger with no tracked
 * schedule is an inert no-op) before invoking `handleProfileRequest`. A
 * `profile-announce` receipt is EXCLUDED from D4 by construction
 * (`decideDispatch` never sets `applyReachability` for it) — the S02
 * ownership-ledger's `announce-schedule-routing` contract already covers an
 * announce's schedule effect (clear-on-completing / mark-incomplete / none,
 * `receive.ts#decideScheduleAction`) and D4 re-arming an announce would
 * reopen the answer->reset->re-request loop REVIEW G2 closed.
 *
 * **Scope note (documented, not fixed here):** spec.md §3.2's D4 is phrased
 * as "any inbound gift-wrapped event…other than a profile-announce receipt" —
 * broader than just this watcher's own two kinds. This component only owns
 * its OWN dedicated subscription; a chat DM, reaction, or call-signaling
 * event observed by one of the OTHER three kind-1059 consumers is NOT wired
 * as a D4 signal here (doing so would require reaching into those
 * subscriptions, explicitly out of this story's AC-WATCH-2 isolation
 * requirement — "no changes to their subscription filters"). Broader D4
 * wiring across all inbound channels is a future enhancement, not this
 * story's job.
 *
 * ## Archive-suppression (AC-PROF-4b's outbound half)
 *
 * `scheduler.ts` is deliberately contact/archive-blind (architecture.json's
 * `dependencies_forbidden` bars it from importing `contacts.ts`), so
 * "the scheduler must send an archived contact no further requests" can only
 * be enforced where both the due-set and archive state are in scope: here.
 * `planDueSweep` filters the due set against the same `contacts` snapshot
 * already read for `computeIncompleteSet`, before staggering — see that
 * function's doc.
 */

import { useEffect, useRef } from 'react';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useProfile } from '@/src/context/ProfileContext';
import { loadKnownPeers } from '@/src/lib/knownPeers';
import { listContacts, readStoredContacts } from '@/src/lib/contacts';
import { readContactEntry } from '@/src/lib/contactCache';
import { GIFT_WRAP_KIND, unwrapAndOpen } from '@/src/lib/directMessages';
import {
  DM_PROFILE_REQUEST_KIND,
  DM_PROFILE_ANNOUNCE_KIND,
} from '@/src/lib/dmProfile/kinds';
import {
  computeIncompleteSet,
  computeContactsNeedingNewSchedule,
  computeDue,
  advance,
  applyReachabilitySignal,
  createInitialSchedule,
  loadAllSchedules,
  loadSchedule,
  saveSchedule,
  type ProfileSchedule,
  type ContactSnapshot,
  type ProfileCacheSnapshot,
} from '@/src/lib/dmProfile/scheduler';
import { sendProfileRequest } from '@/src/lib/dmProfile/send';
import {
  handleProfileRequest,
  handleProfileAnnounce,
  type DisclosureGateContext,
} from '@/src/lib/dmProfile/receive';
import type { Group, UserProfile } from '@/src/types';

// ── Pure planning + routing ─────────────────────────────────────────────────
//
// Exported so tests can exercise them directly, with no React/NDK/idb import
// surface reachable from these functions (this repo has no jsdom/
// @testing-library/renderHook precedent — see testing.md conventions in
// exploration.json). Mirrors src/components/ThemeIcon.tsx's exported
// `getThemeIconId` pattern: a component file may export pure helpers
// alongside its default component without requiring a DOM to test them.

/**
 * AC-WATCH-1: when a sweep tick finds MORE than this many due schedules, the
 * sends are staggered across `BULK_SWEEP_STAGGER_WINDOW_MS` instead of firing
 * in the same tick. A handful (<= this) of simultaneous small gift wraps is
 * indistinguishable from ordinary background traffic; exceeding it — e.g. a
 * mount/online/resume sweep after a long sleep with many contacts due at
 * once — is exactly the relay-stampede scenario spec.md §5 warns about.
 */
export const BULK_SWEEP_STAGGER_THRESHOLD = 5;

/**
 * The window a bulk sweep's due sends are spread evenly across (AC-WATCH-1),
 * IN ADDITION to each fire's own +/-20% scheduler-level jitter (which affects
 * `nextAttemptAt` — when a schedule next becomes due — not how a batch of
 * already-due schedules is drained in one tick). 30s is short enough that a
 * user who reloads right after a long sleep still sees convergence promptly,
 * long enough that a relay never sees more than a trickle at once.
 */
export const BULK_SWEEP_STAGGER_WINDOW_MS = 30_000;

/**
 * Periodic due-check interval (AC-WATCH-1's "on an interval" trigger).
 * Deliberately coarse relative to the >=1h backoff floor — polling every few
 * minutes cannot itself cause a fire storm. Mount and `'online'` triggers
 * cover the low-latency cases (app opened, reconnect) a 5-minute poll alone
 * would miss between ticks. Test-time immediacy (AC-E2E-1) comes from the
 * MOUNT-triggered sweep after `seedDueProfileSchedule` + a reload, never from
 * shortening this interval or a `NEXT_PUBLIC_*` override (spec.md explicitly
 * forbids the latter as a test-only timing constant that could leak into the
 * production bundle).
 */
export const DUE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** One due schedule plus its dispatch-time stagger delay. */
export type DueSendPlanEntry = {
  schedule: ProfileSchedule;
  /** Milliseconds to wait before firing. 0 when the sweep found <= BULK_SWEEP_STAGGER_THRESHOLD due schedules. */
  delayMs: number;
};

/** The full result of planning one sweep tick. */
export type DueSweepPlan = {
  /** Pubkeys to createInitialSchedule for — sourced EXCLUSIVELY from computeContactsNeedingNewSchedule. */
  toCreate: string[];
  /** Due schedules to send, each with its stagger delay. */
  toSend: DueSendPlanEntry[];
};

/**
 * PURE. Plans one due-sweep tick: which pubkeys need a brand-new schedule,
 * and which existing schedules should fire now (with what stagger delay).
 *
 * Composes scheduler.ts's exported functions in the exact order the S02
 * ownership-ledger's `carry_forward_for_story_05` note requires —
 * `computeContactsNeedingNewSchedule(computeIncompleteSet(...), schedules)`
 * for `toCreate`, `computeDue(schedules, nowSec)` for the send candidates —
 * and re-implements none of that math itself.
 *
 * **Archive-suppression (AC-PROF-4b's outbound half).** Before staggering,
 * excludes any due schedule whose `pubkeyHex` matches a currently-archived
 * entry in `contacts`. `scheduler.ts` cannot know about archive state (it may
 * not import `contacts.ts`), so this is the one place able to enforce
 * "an archived contact receives no further profile-requests" — a filter, not
 * a schedule mutation: an unarchived contact's still-persisted schedule
 * simply resumes being eligible on the next sweep once the exclusion no
 * longer applies.
 *
 * Excluded (archived) schedules are removed BEFORE the
 * `BULK_SWEEP_STAGGER_THRESHOLD` comparison, so an archived contact never
 * inflates the count that decides whether the batch is staggered.
 */
export function planDueSweep(params: {
  contacts: ContactSnapshot[];
  cache: ProfileCacheSnapshot[];
  ownPubkeyHex: string;
  schedules: ProfileSchedule[];
  nowSec: number;
}): DueSweepPlan {
  const { contacts, cache, ownPubkeyHex, schedules, nowSec } = params;

  const incompleteSet = computeIncompleteSet(contacts, cache, ownPubkeyHex);
  const toCreate = computeContactsNeedingNewSchedule(incompleteSet, schedules);

  const archivedPubkeys = new Set(
    contacts.filter((c) => c.archived).map((c) => c.pubkeyHex.toLowerCase()),
  );
  const due = computeDue(schedules, nowSec).filter(
    (schedule) => !archivedPubkeys.has(schedule.pubkeyHex.toLowerCase()),
  );

  const toSend: DueSendPlanEntry[] =
    due.length > BULK_SWEEP_STAGGER_THRESHOLD
      ? due.map((schedule, index) => ({
          schedule,
          delayMs: Math.round((index / due.length) * BULK_SWEEP_STAGGER_WINDOW_MS),
        }))
      : due.map((schedule) => ({ schedule, delayMs: 0 }));

  return { toCreate, toSend };
}

/** The routing outcome for one inbound rumor's inner kind. */
export type DispatchDecision =
  | { action: 'ignore' }
  | { action: 'route-request'; applyReachability: true }
  | { action: 'route-announce' };

/**
 * PURE. Routes an inbound rumor's inner `kind` to the right dispatch arm, or
 * `'ignore'` for anything else (chat messages, reactions, and any other
 * kind-1059 payload this dedicated subscription also happens to receive,
 * since a gift-wrap subscription cannot be filtered any narrower than
 * `'#p'`).
 *
 * `route-request` always carries `applyReachability: true` — a profile-request
 * receipt IS a D4 reachability signal (spec.md §3.2/D4). `route-announce`
 * never does — the S02 ownership-ledger's `announce-schedule-routing`
 * contract already routes an announce's schedule effect via
 * `receive.ts#decideScheduleAction`; D4-resetting on top of that would reopen
 * the answer->reset->re-request loop REVIEW G2 closed.
 */
export function decideDispatch(innerKind: number): DispatchDecision {
  if (innerKind === DM_PROFILE_REQUEST_KIND) {
    return { action: 'route-request', applyReachability: true };
  }
  if (innerKind === DM_PROFILE_ANNOUNCE_KIND) {
    return { action: 'route-announce' };
  }
  return { action: 'ignore' };
}

// ── Fire-time + inbound-D4 async seams (Stage-1 review remediation) ───────
//
// These two functions are the async counterparts of planDueSweep/
// decideDispatch above: the subtlest correctness properties in this
// component (stale-schedule races, archive-window races, D4 wiring) live
// here instead of in the untested effect body, so a regression that
// reintroduces advancing a stale plan-time snapshot, or mis-wires D4 onto
// the announce path, fails a test rather than passing silently. Both are
// exercised directly against fake-indexeddb/auto in
// ProfileHealWatcher.test.ts, mirroring scheduler.integration.test.ts's
// convention for testing idb-keyval-backed async functions with no
// jsdom/component-render involved.

/**
 * Live archive check (AC-PROF-4b outbound half, fire-time re-check). Reads
 * `contacts.ts`'s store directly — never a cached snapshot — so a contact
 * archived AFTER `planDueSweep` ran (but before a staggered send actually
 * fires, up to `BULK_SWEEP_STAGGER_WINDOW_MS` later) is still caught.
 * Case-folds the lookup, mirroring `receive.ts`'s
 * `isActiveNonArchivedContact`. A pubkey with no stored contact entry at all
 * is treated as not-archived (same as `archivedAt == null`).
 */
function isContactArchived(pubkeyHex: string): boolean {
  const lower = pubkeyHex.toLowerCase();
  const stored = readStoredContacts();
  const match = Object.entries(stored).find(([key]) => key.toLowerCase() === lower);
  if (!match) return false;
  const [, contact] = match;
  return Boolean(contact.archivedAt);
}

/** The three possible outcomes of {@link advanceAfterFire}. */
export type AdvanceAfterFireOutcome = 'advanced' | 'skipped-archived' | 'skipped-deleted';

/**
 * Fire-time bookkeeping for one due send. Called from the `fire` closure
 * AFTER `sendProfileRequest` (the closure itself does its own pre-send
 * archive check — see below — so an archived contact receives no send at
 * all; this function's own archive check is the defense-in-depth layer for
 * the rare case a contact is archived during the `sendProfileRequest` await
 * itself).
 *
 * Re-loads the CURRENT persisted schedule rather than advancing the
 * plan-time snapshot `planDueSweep` produced: up to
 * `BULK_SWEEP_STAGGER_WINDOW_MS` (30s) can elapse between planning and this
 * call, and in that window a D4 reachability signal
 * ({@link applyInboundReachabilitySignal}) or a completing announce
 * (`receive.ts`'s `deleteSchedule`) may already have mutated or removed this
 * contact's schedule. Advancing the stale snapshot would silently clobber a
 * legitimate D4 reset with pre-reset attempt/jitter state, or worse,
 * resurrect a schedule that was just correctly deleted on completion.
 *
 *   - `'skipped-archived'` — the contact is archived as of THIS call
 *     (AC-PROF-4b's outbound half). No schedule mutation — an unarchive
 *     later simply lets the still-persisted (or since-created) schedule
 *     resume being eligible on a future sweep.
 *   - `'skipped-deleted'` — no persisted schedule exists any more. No
 *     resurrection.
 *   - `'advanced'` — the CURRENT schedule (not the stale snapshot) was
 *     advanced and persisted.
 */
export async function advanceAfterFire(pubkeyHex: string, nowSec: number): Promise<AdvanceAfterFireOutcome> {
  if (isContactArchived(pubkeyHex)) {
    return 'skipped-archived';
  }
  const current = await loadSchedule(pubkeyHex, nowSec);
  if (!current) {
    return 'skipped-deleted';
  }
  const advanced = advance(current, nowSec);
  await saveSchedule(advanced);
  return 'advanced';
}

/** The three possible outcomes of {@link applyInboundReachabilitySignal}. */
export type ReachabilitySignalOutcome = 'reset' | 'no-schedule' | 'rate-limited';

/**
 * The D4 (spec.md §3.2) bookkeeping for an inbound profile-request receipt:
 * loads the SENDER's own tracked schedule (if any — a stranger or a contact
 * we don't track a schedule for is an inert no-op), applies
 * `scheduler.ts#applyReachabilitySignal`, and persists only when it actually
 * changed (`applyReachabilitySignal` returns the identical object reference,
 * unchanged, when its own <=1/24h rate limit suppresses the reset — see that
 * function's doc).
 *
 * Called ONLY from the `route-request` dispatch arm. `decideDispatch` never
 * sets `applyReachability` for `route-announce`, so this function is never
 * invoked on an announce receipt — the S02 ownership-ledger's "announce
 * receipt never re-arms" contract holds structurally, not just by
 * convention.
 */
export async function applyInboundReachabilitySignal(
  senderHex: string,
  nowSec: number,
): Promise<ReachabilitySignalOutcome> {
  const existing = await loadSchedule(senderHex, nowSec);
  if (!existing) {
    return 'no-schedule';
  }
  const updated = applyReachabilitySignal(existing, nowSec);
  if (updated === existing) {
    return 'rate-limited';
  }
  await saveSchedule(updated);
  return 'reset';
}

// ── Component (thin wrapper: refs/effects + plan execution only) ──────────

export default function ProfileHealWatcher() {
  const { hydrated, pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { groups, knownPeersRevision, notifyContactsChanged } = useMarmot();
  const { profile } = useProfile();

  // Live ref to the contacts change-signal so the long-lived subscription
  // callback can bump it after a profile-announce updates a contact's
  // nickname/avatar, driving the live contacts list / DM header / bell row
  // lookups to re-derive without a reload (epic: contacts-live-updates).
  const notifyContactsChangedRef = useRef(notifyContactsChanged);
  useEffect(() => { notifyContactsChangedRef.current = notifyContactsChanged; }, [notifyContactsChanged]);

  // Live refs so the subscription/sweep never churns on every context change
  // (mirrors DirectMessageNotificationsWatcher's groupsRef/knownPeersRef
  // pattern exactly). Each dispatch reads these fresh — never a cached
  // snapshot — so an archive/unarchive flip or a group-membership change
  // takes effect on the very next inbound event or sweep tick.
  const groupsRef = useRef<Group[]>(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const knownPeersRef = useRef(loadKnownPeers());
  useEffect(() => {
    knownPeersRef.current = loadKnownPeers();
  }, [groups, knownPeersRevision]);

  const profileRef = useRef<UserProfile>(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    if (!hydrated || !pubkeyHex || !privateKeyHex) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let onOnline: (() => void) | undefined;
    const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

    const ownPubkeyHex = pubkeyHex;
    const ownPrivateKeyHex = privateKeyHex;

    function gateCtx(): DisclosureGateContext {
      return {
        groups: groupsRef.current,
        knownPeers: knownPeersRef.current,
        ownPubkeyHex,
      };
    }

    async function runDueSweep(ndk: import('@nostr-dev-kit/ndk').default) {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const contactItems = listContacts(ownPubkeyHex, { includeArchived: true });
        const contacts: ContactSnapshot[] = contactItems.map((c) => ({
          pubkeyHex: c.pubkeyHex,
          archived: c.isArchived,
        }));
        const cache: ProfileCacheSnapshot[] = contactItems.map((c) => ({
          pubkeyHex: c.pubkeyHex,
          avatarNonNull: readContactEntry(c.pubkeyHex)?.avatar != null,
        }));
        const schedules = await loadAllSchedules(nowSec);
        if (cancelled) return;

        const plan = planDueSweep({ contacts, cache, ownPubkeyHex, schedules, nowSec });

        for (const pk of plan.toCreate) {
          if (cancelled) return;
          await saveSchedule(createInitialSchedule(pk, nowSec));
        }

        for (const entry of plan.toSend) {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const fire = async () => {
            if (timeoutHandle !== undefined) pendingTimeouts.delete(timeoutHandle);
            if (cancelled) return;
            const pk = entry.schedule.pubkeyHex;
            // AC-PROF-4b outbound half, fire-time re-check: planDueSweep
            // already excluded archived contacts at PLAN time, but a
            // staggered send can fire up to BULK_SWEEP_STAGGER_WINDOW_MS
            // later — re-check live so a contact archived DURING that window
            // still receives no further request (and no schedule mutation).
            if (isContactArchived(pk)) return;
            await sendProfileRequest({
              ndk,
              recipientPubkeyHex: pk,
              keys: { ownPubkeyHex, ownPrivateKeyHex },
            });
            if (cancelled) return;
            await advanceAfterFire(pk, Math.floor(Date.now() / 1000));
          };
          if (entry.delayMs > 0) {
            timeoutHandle = setTimeout(() => {
              void fire();
            }, entry.delayMs);
            pendingTimeouts.add(timeoutHandle);
          } else {
            void fire();
          }
        }
      } catch (err) {
        console.warn('[ProfileHealWatcher] due-sweep failed:', err);
      }
    }

    void (async () => {
      try {
        const { connectNdk } = await import('@/src/lib/ndkClient');
        const ndk = await connectNdk(ownPrivateKeyHex);
        if (cancelled) return;

        // AC-WATCH-2: a NEW, dedicated kind-1059 subscription — never touches
        // welcomeSubscription.ts or the other two consumers' subscriptions.
        // '#p' only: gift-wrap outer authors are ephemeral per-wrap keys, so
        // filtering by author is impossible here (project learning
        // kind-445-events-have-ephemeral-authors), exactly like the other
        // three kind-1059 consumers.
        const sub = ndk.subscribe({ kinds: [GIFT_WRAP_KIND], '#p': [ownPubkeyHex] });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = async (event: any) => {
          try {
            // AC-PROF-5/AC-WATCH-2: strict unwrap ONLY — never
            // welcomeSubscription.ts#unwrapGiftWrap.
            const rumor = await unwrapAndOpen(
              { ...event, created_at: event.created_at ?? Math.floor(Date.now() / 1000) },
              ownPrivateKeyHex,
            );
            const senderHex = rumor.pubkey.toLowerCase();
            const decision = decideDispatch(rumor.kind);
            if (decision.action === 'ignore') return;

            if (decision.action === 'route-request') {
              if (decision.applyReachability) {
                // D4 (spec.md §3.2): a profile-request receipt is a
                // reachability signal for the SENDER's own schedule,
                // independent of whether the disclosure gate ends up
                // answering. A no-op when we track no schedule for them.
                await applyInboundReachabilitySignal(senderHex, Math.floor(Date.now() / 1000));
              }
              await handleProfileRequest(rumor, senderHex, {
                ...gateCtx(),
                ndk,
                keys: { ownPubkeyHex, ownPrivateKeyHex },
                localProfile: profileRef.current,
              });
            } else if (decision.action === 'route-announce') {
              const wrote = await handleProfileAnnounce(rumor, senderHex, gateCtx());
              // Only re-derive the contacts surfaces when the announce actually
              // updated a displayed value (won LWW) — a stale/gate-dropped
              // announce changes nothing to show (epic: contacts-live-updates).
              if (wrote) notifyContactsChangedRef.current();
            }
          } catch {
            // Foreign key, not addressed to us, malformed, or a non-profile
            // kind-1059 payload — silently skip (mirrors
            // DirectMessageNotificationsWatcher's kind1059Handler).
          }
        };

        sub.on?.('event', handler);
        unsubscribe = () => {
          try {
            sub.stop?.();
          } catch {
            // non-fatal
          }
        };

        if (cancelled) return;

        // Mount trigger (AC-WATCH-1).
        void runDueSweep(ndk);

        // 'online' trigger (AC-WATCH-1).
        onOnline = () => {
          void runDueSweep(ndk);
        };
        window.addEventListener('online', onOnline);

        // Interval trigger (AC-WATCH-1).
        intervalId = setInterval(() => {
          void runDueSweep(ndk);
        }, DUE_SWEEP_INTERVAL_MS);
      } catch (err) {
        console.warn('[ProfileHealWatcher] setup failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (onOnline) window.removeEventListener('online', onOnline);
      if (intervalId) clearInterval(intervalId);
      for (const handle of pendingTimeouts) clearTimeout(handle);
      pendingTimeouts.clear();
      unsubscribe?.();
    };
  }, [hydrated, pubkeyHex, privateKeyHex]);

  return null;
}
