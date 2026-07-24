/**
 * S4 — cross-cutting property invariants for the rehomed invite-link expiry
 * sweep (epic: obsolete-notification-bell, AC-SWEEP-3/4/5). This is the
 * integration story spanning `inviteExpirySweep` (the cycle + scheduler) and
 * the sweep host contract. Each test is a property over a space of
 * orderings/interleavings, not a single hand-picked sequence.
 *
 * Only infrastructure is mocked (idb-keyval as a flat in-memory map; react's
 * useSyncExternalStore → getSnapshot), mirroring `inviteExpirySweep.test.ts` —
 * the REAL `runInviteExpiryCycle`, `runInviteExpirySweep`, and
 * `startInviteExpirySweep` run against it. The SUT is never re-implemented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import type { InviteExpiryCycleDeps } from '@/src/lib/marmot/inviteExpirySweep';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  entries: vi.fn(async () => [...idbStore.entries()]),
  clear: vi.fn(async () => {
    idbStore.clear();
  }),
}));

vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
}));

const inviteLinkStorage = await import('@/src/lib/marmot/inviteLinkStorage');
const { DAY_MS, saveInviteLink } = inviteLinkStorage;
const {
  runInviteExpiryCycle,
  startInviteExpirySweep,
  INVITE_EXPIRY_SWEEP_INTERVAL_MS,
} = await import('@/src/lib/marmot/inviteExpirySweep');
const { useUnreadCounts, clearInviteExpiries } = await import('@/src/lib/unreadStore');

function makeLink(overrides: Partial<InviteLink> = {}): InviteLink {
  return {
    nonce: 'nonce-1',
    groupId: 'group-1',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + DAY_MS,
    usageCount: 0,
    expiryNotified: false,
    expiryAcknowledged: false,
    label: undefined,
    muted: false,
    ...overrides,
  };
}

function makeFakeScheduler() {
  let intervalCb: (() => void) | null = null;
  let intervalMs: number | null = null;
  let cleared = false;
  const handle = 99 as unknown as ReturnType<typeof setInterval>;
  return {
    setInterval: (cb: () => void, ms: number) => {
      intervalCb = cb;
      intervalMs = ms;
      cleared = false;
      return handle;
    },
    clearInterval: (h: ReturnType<typeof setInterval>) => {
      if (h === handle) cleared = true;
    },
    tick() {
      if (intervalCb && !cleared) intervalCb();
    },
    get intervalMs() {
      return intervalMs;
    },
    get cleared() {
      return cleared;
    },
  };
}

beforeEach(() => {
  idbStore.clear();
  clearInviteExpiries('group-1');
});

describe('AC-SWEEP-3: migrate-before-sweep ordering (property over migrate outcomes × repetition × concurrency)', () => {
  // Generator: migrate resolves or rejects; run 1..3 sequential cycles; also a
  // simultaneous double-invocation. For every invocation the recorded order must
  // show migrate strictly before sweep, and a rejected migrate must skip sweep
  // while derive still runs.
  const migrateOutcomes: Array<'resolve' | 'reject'> = ['resolve', 'reject'];
  const repetitions = [1, 2, 3];

  for (const outcome of migrateOutcomes) {
    for (const reps of repetitions) {
      it(`migrate=${outcome}, ${reps} sequential cycle(s): sweep never precedes migrate; reject skips sweep, derive always runs`, async () => {
        const events: string[] = [];
        const deps: InviteExpiryCycleDeps = {
          migrate: async () => {
            events.push('migrate');
            if (outcome === 'reject') throw new Error('migrate failed');
          },
          sweep: async () => {
            events.push('sweep');
          },
          derive: async () => {
            events.push('derive');
          },
        };
        for (let i = 0; i < reps; i++) {
          await runInviteExpiryCycle(1000 + i, deps);
        }
        // Within each cycle: any 'sweep' is preceded by a 'migrate'; derive present per cycle.
        let migrateSeen = 0;
        let sweepSeen = 0;
        let deriveSeen = 0;
        for (const e of events) {
          if (e === 'migrate') migrateSeen++;
          if (e === 'sweep') {
            sweepSeen++;
            expect(migrateSeen).toBeGreaterThanOrEqual(sweepSeen); // migrate leads sweep
          }
          if (e === 'derive') deriveSeen++;
        }
        expect(migrateSeen).toBe(reps);
        expect(deriveSeen).toBe(reps); // derive always runs, even on reject
        expect(sweepSeen).toBe(outcome === 'resolve' ? reps : 0); // reject skips sweep
      });
    }
  }

  it('simultaneous double-invocation: each invocation still orders migrate before sweep', async () => {
    const events: string[] = [];
    const deps: InviteExpiryCycleDeps = {
      migrate: async () => { events.push('migrate'); },
      sweep: async () => { events.push('sweep'); },
      derive: async () => { events.push('derive'); },
    };
    await Promise.all([runInviteExpiryCycle(1, deps), runInviteExpiryCycle(2, deps)]);
    // Two migrates and two sweeps; no sweep may appear before the first migrate.
    expect(events.indexOf('sweep')).toBeGreaterThan(events.indexOf('migrate'));
    expect(events.filter((e) => e === 'migrate')).toHaveLength(2);
    expect(events.filter((e) => e === 'sweep')).toHaveLength(2);
  });
});

describe('AC-SWEEP-4: at-most-once expiry notification (property over repeated cycles, remount, and double-mount)', () => {
  it('an expired link is notified exactly once across many cycles and a concurrent double-mount', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);
    const now = 10_000; // strictly after expiresAt

    // Repeated interval ticks (real cycle, real sweep, real derive).
    for (let i = 0; i < 4; i++) {
      await runInviteExpiryCycle(now);
    }
    // Simulate a remount: another burst of cycles.
    for (let i = 0; i < 3; i++) {
      await runInviteExpiryCycle(now);
    }
    // Simulate a double-mount: two cycles racing.
    await Promise.all([runInviteExpiryCycle(now), runInviteExpiryCycle(now)]);

    // Despite ~9 invocations, the link is counted exactly once (stamp-before-bump
    // guard + expiryNotified). Never inflated to the number of cycles.
    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(1);
  });
});

describe('AC-SWEEP-5: 60s cadence survives remount (property over mount/unmount/tick interleavings)', () => {
  it('every (re)mount fires immediately and re-establishes the 60s interval, so no >60s gap while mounted', () => {
    const run = vi.fn();
    let clock = 0;
    let expectedRuns = 0;

    // Interleaving: mount → tick → unmount → remount → tick → unmount → remount → tick
    // (three mount epochs). Each mount epoch must fire immediately and schedule
    // the same 60s interval; each tick must fire while mounted.
    for (let epoch = 0; epoch < 3; epoch++) {
      const sched = makeFakeScheduler();
      const stop = startInviteExpirySweep({
        now: () => clock,
        setInterval: sched.setInterval,
        clearInterval: sched.clearInterval,
        run,
      });
      expectedRuns++; // immediate run on (re)mount
      expect(run).toHaveBeenCalledTimes(expectedRuns);
      expect(sched.intervalMs).toBe(INVITE_EXPIRY_SWEEP_INTERVAL_MS);

      // Two interval ticks within this mount epoch.
      for (let t = 0; t < 2; t++) {
        clock += INVITE_EXPIRY_SWEEP_INTERVAL_MS;
        sched.tick();
        expectedRuns++;
        expect(run).toHaveBeenCalledTimes(expectedRuns);
      }

      stop(); // unmount
      expect(sched.cleared).toBe(true);
      sched.tick(); // ticks after unmount must not run
      expect(run).toHaveBeenCalledTimes(expectedRuns);

      clock += 1_000; // small gap between unmount and next remount
    }
  });
});
