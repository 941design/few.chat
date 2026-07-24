/**
 * Unit tests for `startInviteExpirySweep` — the injectable scheduler that
 * rehomes the invite-link expiry cycle out of the deleted NotificationBell
 * (epic: obsolete-notification-bell, AC-SWEEP-1/2, INV-B / TRAP 1).
 *
 * The bell used to run `runInviteExpiryCycle` on mount + every 60s. Deleting
 * the bell without rehoming would silently stop expiry detection — there is no
 * UI symptom. These tests are the regression guard: they assert the cycle fires
 * once immediately AND repeats on the interval, and are state-discriminating —
 * they fail if the interval is removed (repeats stop) or the immediate run is
 * dropped.
 *
 * The schedule is exercised through a fake clock/scheduler rather than a mounted
 * component (this repo has no jsdom/renderHook precedent).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startInviteExpirySweep,
  INVITE_EXPIRY_SWEEP_INTERVAL_MS,
} from '@/src/lib/marmot/inviteExpirySweep';

function makeFakeScheduler() {
  let intervalCb: (() => void) | null = null;
  let intervalMs: number | null = null;
  let cleared = false;
  const handle = 4242 as unknown as ReturnType<typeof setInterval>;
  return {
    setInterval: (cb: () => void, ms: number) => {
      intervalCb = cb;
      intervalMs = ms;
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

describe('startInviteExpirySweep', () => {
  it('AC-SWEEP-1: runs one cycle immediately on start, with the current clock', () => {
    const run = vi.fn();
    const sched = makeFakeScheduler();
    startInviteExpirySweep({
      now: () => 1000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(1000);
  });

  it('AC-SWEEP-2: schedules the repeat at the 60s interval and each tick runs another cycle', () => {
    const run = vi.fn();
    const sched = makeFakeScheduler();
    let clock = 1000;
    startInviteExpirySweep({
      now: () => clock,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
      run,
    });
    expect(sched.intervalMs).toBe(INVITE_EXPIRY_SWEEP_INTERVAL_MS);
    expect(sched.intervalMs).toBe(60_000);

    clock = 61_000;
    sched.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(61_000);

    clock = 121_000;
    sched.tick();
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith(121_000);
  });

  it('AC-SWEEP-2 (state-discriminating): without the interval firing, no repeat occurs — repeats depend on the interval', () => {
    const run = vi.fn();
    const sched = makeFakeScheduler();
    startInviteExpirySweep({
      now: () => 0,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
      run,
    });
    // No tick — the only run is the immediate one. If the immediate run were
    // dropped this is 0; if repeats did not require the interval this test could
    // not distinguish them from AC-SWEEP-2's ticked case.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the interval and prevents any further cycles', () => {
    const run = vi.fn();
    const sched = makeFakeScheduler();
    const stop = startInviteExpirySweep({
      now: () => 0,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    stop();
    expect(sched.cleared).toBe(true);
    sched.tick(); // guarded by `cleared` — must not invoke run again
    expect(run).toHaveBeenCalledTimes(1);
  });
});
