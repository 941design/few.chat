// @vitest-environment node
/**
 * AC-OBS-2 (own-send lifecycle property): for EVERY interleaving of {echo, send() resolve, send() reject,
 * intentFailed, groupBranchSwitched, 60 s timer expiry, withdraw, re-echo} applied to one optimistic own row, the
 * final state satisfies:
 *   (i)   exactly one row for the rumor id;
 *   (ii)  an echo occurred and no withdraw followed -> confirmed, and a failure trigger never downgraded a confirmed
 *         row (every `failed` report that follows a `confirmed` report has a withdraw between);
 *   (iii) no echo ever and a failure trigger (or a withdraw) occurred -> failed;
 *   (iv)  no auto-resend: group.send called at most once;
 *   (v)   the last status the app was told (port report) equals the final status.
 * Clause (i) against the REAL chat store: see ownRowLifecycle.store.property.test.ts.
 * `fast-check` is not a dependency of this app, so the generator is EXHAUSTIVE for every sequence up to length 5
 * (8^5 + ... ~ 37k) plus seeded pseudo-random longer ones: a complete cover of the small interleaving space instead
 * of a sample. Fake timers drive the 60 s expiry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupRumorSender, createOwnRowTracker, OWN_SEND_CONFIRM_TIMEOUT_MS, type SendableGroup } from '@/src/lib/marmot/send';

const OWN = 'a1'.repeat(32);
const G = 'ab'.repeat(32);

type Ev = 'echo' | 'reecho' | 'resolve' | 'reject' | 'intentFailed' | 'branchSwitched' | 'timer' | 'withdraw';
const ALPHABET: Ev[] = ['echo', 'reecho', 'resolve', 'reject', 'intentFailed', 'branchSwitched', 'timer', 'withdraw'];

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

async function run(seq: Ev[]) {
  const reports: Array<'sending' | 'confirmed' | 'failed' | { w: number }> = [];
  const tracker = createOwnRowTracker({ ports: { setStatus: (_g, _id, s) => void reports.push(s) } });
  let settle: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  const send = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
        settle = { resolve: () => resolve(undefined), reject };
      }),
  );
  const group: SendableGroup = { id: G, send: send as unknown as SendableGroup['send'], pendingIntents: async () => [] };
  const prepared = createGroupRumorSender({ ownPubkey: OWN, tracker, nowSeconds: () => 1 }).prepare(group, 9, 'p', []);
  tracker.bindIntent(G, prepared.id, 'i1');
  const sent = prepared.send().catch(() => undefined);
  let settled = false;
  let resolvedBeforeIdx = -1;
  const trace: Array<{ ev: Ev; effective: boolean }> = [];
  for (const [i, ev] of seq.entries()) {
    let effective = true;
    switch (ev) {
      case 'echo':
      case 'reecho':
        tracker.onOwnEcho(G, prepared.id, ev === 'echo' ? 'e1' : 'e2');
        break;
      case 'resolve':
        if (settled) effective = false;
        else {
          settled = true;
          resolvedBeforeIdx = i;
          settle!.resolve();
          await sent;
        }
        break;
      case 'reject':
        if (settled) effective = false;
        else {
          settled = true;
          settle!.reject(new Error('rejected'));
          await sent;
        }
        break;
      case 'intentFailed':
        tracker.onIntentFailed({ groupId: G, intentId: 'i1' });
        break;
      case 'branchSwitched':
        tracker.onGroupBranchSwitched({ groupId: G });
        break;
      case 'timer':
        // only a send() that RESOLVED starts the clock
        effective = resolvedBeforeIdx >= 0 && resolvedBeforeIdx < i;
        await vi.advanceTimersByTimeAsync(OWN_SEND_CONFIRM_TIMEOUT_MS);
        break;
      case 'withdraw':
        reports.push({ w: i }); // the marker precedes the failure it causes
        tracker.onOwnWithdrawn(G, prepared.id);
        break;
    }
    trace.push({ ev, effective });
  }
  if (!settled) {
    settle!.resolve(); // let the dangling send settle; the clock then starts, but no timer event is applied
    await sent;
  }
  const status = tracker.statusOf(G, prepared.id);
  tracker.dispose();
  return { status, reports, trace, sendCalls: send.mock.calls.length };
}

function assertClauses(seq: Ev[], out: Awaited<ReturnType<typeof run>>) {
  const label = seq.join(',');
  // (i) exactly one row: the tracker keeps one entry for the id (status defined, reports reference one id by construction)
  expect(out.status, `(i) ${label}`).toBeDefined();
  const lastEcho = Math.max(seq.lastIndexOf('echo'), seq.lastIndexOf('reecho'));
  const lastWithdraw = seq.lastIndexOf('withdraw');
  // (ii)
  if (lastEcho >= 0 && lastWithdraw < lastEcho) expect(out.status, `(ii) ${label}`).toBe('confirmed');
  // downgrade rule: a `failed` report after a `confirmed` report needs a withdraw in between
  let sawConfirmed = false;
  let withdrawSince = false;
  for (const r of out.reports) {
    if (typeof r === 'object') {
      withdrawSince = true;
      continue;
    }
    if (r === 'confirmed') {
      sawConfirmed = true;
      withdrawSince = false;
    } else if (r === 'failed' && sawConfirmed) expect(withdrawSince, `(ii) downgrade without withdraw: ${label}`).toBe(true);
  }
  // (iii)
  const effectiveTrigger = out.trace.some((t, i) => t.effective && (t.ev === 'reject' || t.ev === 'intentFailed' || t.ev === 'branchSwitched' || t.ev === 'timer' || t.ev === 'withdraw') && i >= 0);
  if (lastEcho < 0 && effectiveTrigger) expect(out.status, `(iii) ${label}`).toBe('failed');
  if (lastEcho < 0 && !effectiveTrigger) expect(out.status, `(iii') ${label}`).toBe('sending');
  // (v) the app's last port report IS the final status (a row with no report is still `sending`)
  const lastReport = [...out.reports].reverse().find((r) => typeof r === 'string');
  expect(lastReport ?? 'sending', `(v) last port report vs final status: ${label}`).toBe(out.status);
  // (iv)
  expect(out.sendCalls, `(iv) ${label}`).toBeLessThanOrEqual(1);
}

function* sequences(maxLen: number): Generator<Ev[]> {
  function* rec(prefix: Ev[]): Generator<Ev[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === maxLen) return;
    for (const e of ALPHABET) yield* rec([...prefix, e]);
  }
  yield* rec([]);
}

describe('AC-OBS-2: every interleaving of the lifecycle events satisfies the clauses', () => {
  it('exhaustive over all sequences of length 1..5', async () => {
    let n = 0;
    for (const seq of sequences(5)) {
      assertClauses(seq, await run(seq));
      n += 1;
    }
    expect(n).toBe(8 + 64 + 512 + 4096 + 32768);
  }, 120_000);

  it('seeded pseudo-random sequences of length 6..10', async () => {
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 1500; i++) {
      const len = 6 + Math.floor(rnd() * 5);
      const seq = Array.from({ length: len }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]);
      assertClauses(seq, await run(seq));
    }
  }, 120_000);

  it('the clauses are not vacuous: a tracker that never confirms or never fails violates them', async () => {
    // sanity of the checker itself: a hand-written wrong outcome is caught
    expect(() => assertClauses(['echo'], { status: 'failed', reports: [], trace: [{ ev: 'echo', effective: true }], sendCalls: 1 })).toThrow();
    expect(() => assertClauses(['intentFailed'], { status: 'sending', reports: [], trace: [{ ev: 'intentFailed', effective: true }], sendCalls: 1 })).toThrow();
    expect(() => assertClauses(['echo', 'timer'], { status: 'confirmed', reports: ['confirmed', 'failed'], trace: [], sendCalls: 1 })).toThrow();
    expect(() => assertClauses(['echo'], { status: 'confirmed', reports: ['confirmed'], trace: [{ ev: 'echo', effective: true }], sendCalls: 2 })).toThrow();
    // (v): the app was last told `failed` while the tracker says confirmed
    expect(() => assertClauses(['echo'], { status: 'confirmed', reports: ['confirmed', 'failed'], trace: [{ ev: 'echo', effective: true }], sendCalls: 1 })).toThrow();
  });
});
