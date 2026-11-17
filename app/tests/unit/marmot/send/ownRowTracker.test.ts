// @vitest-environment node
/**
 * Own-send lifecycle (D6, D13): AC-WDR-3 (one test per failure trigger, never downgrading a confirmed row, a later
 * sink arrival flips a failed row to confirmed), AC-OWN-2 (either arrival order, one row, confirmed), AC-WDR-2 (an
 * own withdraw ends failed, never deleted, never resent) and the S4/S5 ledger notes (missing row tolerated, other
 * carrier ignored, unconfirmed own signals carried over a recompute). Fake timers for the 60 s trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupRumorSender, createOwnRowTracker, OWN_SEND_CONFIRM_TIMEOUT_MS, type OwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';

const OWN = 'a1'.repeat(32);
const G = 'ab'.repeat(32);
const OTHER_G = 'cd'.repeat(32);

let tracker: OwnRowTracker;
let statuses: Array<[string, string, string]>;
beforeEach(() => {
  vi.useFakeTimers();
  statuses = [];
  tracker = createOwnRowTracker({ ports: { setStatus: (g, id, s) => void statuses.push([g, id, s]) } });
});
afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

type Deferred = { promise: Promise<unknown>; resolve: () => void; reject: (e: unknown) => void };
/** A group whose send() is held until the test settles it; counts calls (the no-auto-resend spy). */
function heldGroup(groupId = G) {
  const held: Deferred[] = [];
  const send = vi.fn(() => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = () => res(undefined);
      reject = rej;
    });
    const d = { promise, resolve, reject };
    held.push(d);
    return promise;
  });
  const group: SendableGroup = { id: groupId, send: send as unknown as SendableGroup['send'], pendingIntents: async () => [] };
  return { group, send, held };
}
const sender = () => createGroupRumorSender({ ownPubkey: OWN, tracker, nowSeconds: () => 1_700_000_000 });
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('AC-WDR-3: failure detection, one test per trigger', () => {
  it('(a) send() rejects -> failed/retry, and no resend', async () => {
    const { group, send, held } = heldGroup();
    const p = sender().prepare(group, 9, 'a', []);
    const sent = p.send().catch(() => undefined);
    held[0].reject(new Error('send-rejected'));
    await sent;
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    expect(statuses).toEqual([[G, p.id, 'failed']]);
    await vi.advanceTimersByTimeAsync(10 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(b) intentFailed naming the row group while unconfirmed -> failed/retry; another group is untouched', async () => {
    const mine = heldGroup(G);
    const other = heldGroup(OTHER_G);
    const s = sender();
    const p = s.prepare(mine.group, 9, 'b', []);
    const q = s.prepare(other.group, 9, 'b', []);
    void p.send();
    void q.send();
    mine.held[0].resolve();
    other.held[0].resolve();
    await flush();
    tracker.bindIntent(G, p.id, 'ip');
    tracker.bindIntent(OTHER_G, q.id, 'iq');
    tracker.onIntentFailed({ groupId: G, intentId: 'ip' });
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    expect(tracker.statusOf(OTHER_G, q.id)).toBe('sending');
  });

  it('(b) also fails a row whose send() has not resolved yet (awaiting-sync intent)', () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'b2', []);
    void p.send();
    expect(held).toHaveLength(1);
    tracker.bindIntent(G, p.id, 'awaiting');
    tracker.onIntentFailed({ groupId: G, intentId: 'awaiting' });
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it('(c) groupBranchSwitched for the group while unconfirmed -> failed/retry', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'c', []);
    void p.send();
    held[0].resolve();
    await flush();
    tracker.onGroupBranchSwitched({ groupId: G });
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    expect(statuses).toEqual([[G, p.id, 'failed']]);
  });

  it('(d) still unconfirmed 60 s after send() resolved -> failed/retry (59.999 s is not enough)', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'd', []);
    void p.send();
    held[0].resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(OWN_SEND_CONFIRM_TIMEOUT_MS - 1);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it('(d) the clock starts at send() resolution, not at registration: a slow send does not use up the 60 s', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'd2', []);
    void p.send();
    await vi.advanceTimersByTimeAsync(5 * OWN_SEND_CONFIRM_TIMEOUT_MS); // send() still pending
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    held[0].resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(OWN_SEND_CONFIRM_TIMEOUT_MS - 1);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
  });

  it('a configured timeout applies', async () => {
    const t = createOwnRowTracker({ ports: { setStatus: () => undefined }, timeoutMs: 1000 });
    t.register(G, 'r');
    t.sendResolved(G, 'r');
    await vi.advanceTimersByTimeAsync(999);
    expect(t.statusOf(G, 'r')).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(t.statusOf(G, 'r')).toBe('failed');
    t.dispose();
  });

  it.each([
    ['(a) send() rejecting after the echo', (held: Deferred[]) => held[0].reject(new Error('late'))],
    ['(b) intentFailed', () => tracker.onIntentFailed({ groupId: G, intentId: 'i1' })],
    ['(c) groupBranchSwitched', () => tracker.onGroupBranchSwitched({ groupId: G })],
    ['(d) the 60 s timer', () => undefined],
  ])('a row already confirmed through the sink is not changed by %s', async (name, trigger) => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'confirmed', []);
    const sent = p.send().catch(() => undefined);
    tracker.bindIntent(G, p.id, 'i1');
    tracker.onOwnEcho(G, p.id, 'ev1');
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    trigger(held);
    if (!name.startsWith('(a)')) held[0].resolve(); // (d): send() resolves AFTER the echo, which starts no clock
    await sent;
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    expect(statuses).toEqual([[G, p.id, 'confirmed']]); // never reported failed
  });

  it('(d) a clock already running is cancelled by the echo (confirmed after send() resolved, then 2 x 60 s)', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'clock', []);
    const sent = p.send();
    held[0].resolve();
    await sent;
    tracker.onOwnEcho(G, p.id, 'ev1');
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(statuses).toEqual([[G, p.id, 'confirmed']]);
  });

  it('a later sink arrival with the same rumor id flips a failed row to confirmed (and a later trigger cannot undo it)', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'flip', []);
    void p.send().catch(() => undefined);
    tracker.bindIntent(G, p.id, 'i1');
    held[0].reject(new Error('x'));
    await flush();
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    tracker.onOwnEcho(G, p.id, 'ev-late');
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    tracker.onIntentFailed({ groupId: G, intentId: 'i1' });
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    expect(statuses.map((s) => s[2])).toEqual(['failed', 'confirmed']);
  });
});

describe('AC-OWN-2: either arrival order converges to one confirmed row', () => {
  it('echo BEFORE send() resolves', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'early', []);
    const sent = p.send();
    tracker.onOwnEcho(G, p.id);
    held[0].resolve();
    await sent;
    await vi.advanceTimersByTimeAsync(3 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    expect(statuses).toEqual([[G, p.id, 'confirmed']]);
  });

  it('echo AFTER send() resolves (the 60 s clock is cancelled)', async () => {
    const { group, held } = heldGroup();
    const p = sender().prepare(group, 9, 'late', []);
    const sent = p.send();
    held[0].resolve();
    await sent;
    tracker.onOwnEcho(G, p.id);
    await vi.advanceTimersByTimeAsync(3 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
    expect(statuses).toEqual([[G, p.id, 'confirmed']]);
  });

  it('a re-echo is idempotent: one transition, no further status calls', () => {
    tracker.register(G, 'r');
    tracker.onOwnEcho(G, 'r', 'e1');
    tracker.onOwnEcho(G, 'r', 'e1');
    tracker.onOwnEcho(G, 'r', 'e2');
    expect(statuses).toEqual([[G, 'r', 'confirmed']]);
  });
});

describe('AC-WDR-2: an own withdrawn row ends failed/retry, never deleted, never resent', () => {
  it('a confirmed row that the sink withdraws becomes failed (the only downgrade); the row stays tracked; no send', async () => {
    const { group, send, held } = heldGroup();
    const p = sender().prepare(group, 9, 'wd', []);
    const sent = p.send();
    held[0].resolve();
    await sent;
    tracker.onOwnEcho(G, p.id, 'ev1');
    tracker.onOwnWithdrawn(G, p.id, 'ev1');
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    expect(statuses.map((s) => s[2])).toEqual(['confirmed', 'failed']);
    await vi.advanceTimersByTimeAsync(5 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a re-appended withdrawn id (re-canonicalised branch) confirms the row again', () => {
    tracker.register(G, 'r');
    tracker.onOwnEcho(G, 'r', 'e1');
    tracker.onOwnWithdrawn(G, 'r', 'e1');
    tracker.onOwnEcho(G, 'r', 'e2');
    expect(tracker.statusOf(G, 'r')).toBe('confirmed');
  });

  it('a withdraw of a row the tracker does not know (earlier session) reports failed WITHOUT tracking a row', () => {
    tracker.onOwnWithdrawn(G, 'ghost');
    expect(statuses).toEqual([[G, 'ghost', 'failed']]);
    expect(tracker.statusOf(G, 'ghost')).toBeUndefined();
  });
});

describe('ledger notes (S4 / S5 -> S6)', () => {
  it('onOwnEcho tolerates a missing row: no throw, no entry, no status call', () => {
    expect(() => tracker.onOwnEcho(G, 'never-registered', 'e')).not.toThrow();
    expect(tracker.statusOf(G, 'never-registered')).toBeUndefined();
    expect(statuses).toEqual([]);
  });

  it('onOwnWithdrawn ignores a row confirmed by a DIFFERENT eventId, and fails it once its last carrier is withdrawn', () => {
    tracker.register(G, 'r');
    tracker.onOwnEcho(G, 'r', 'carrier-1');
    tracker.onOwnWithdrawn(G, 'r', 'carrier-2'); // not a carrier of this row
    expect(tracker.statusOf(G, 'r')).toBe('confirmed');
    tracker.onOwnEcho(G, 'r', 'carrier-2');
    tracker.onOwnWithdrawn(G, 'r', 'carrier-1'); // carrier-2 still holds it
    expect(tracker.statusOf(G, 'r')).toBe('confirmed');
    tracker.onOwnWithdrawn(G, 'r', 'carrier-2');
    expect(tracker.statusOf(G, 'r')).toBe('failed');
  });

  it('a withdraw with no eventId applies (the handler port does not pass one)', () => {
    tracker.register(G, 'r');
    tracker.onOwnEcho(G, 'r', 'carrier-1');
    tracker.onOwnWithdrawn(G, 'r');
    expect(tracker.statusOf(G, 'r')).toBe('failed');
  });

  it('own optimistic signals still sending are handed back for re-application after a recompute; confirmed or failed ones are not', () => {
    const vote = { id: 'v1', pubkey: OWN, created_at: 1, kind: 11, tags: [], content: '{}' };
    const edit = { id: 'e1', pubkey: OWN, created_at: 2, kind: 9, tags: [['edit', 'x']], content: 'x' };
    const gone = { id: 'f1', pubkey: OWN, created_at: 3, kind: 7, tags: [], content: '+' };
    tracker.register(G, 'v1', { rumor: vote, signal: true });
    tracker.register(G, 'e1', { rumor: edit, signal: true });
    tracker.register(G, 'f1', { rumor: gone, signal: true });
    tracker.register(OTHER_G, 'x', { rumor: { ...vote, id: 'x' }, signal: true });
    tracker.register(G, 'plain'); // a chat row: no signal rumor
    tracker.register(G, 'unmarked', { rumor: { ...vote, id: 'unmarked' } }); // a rumor without `signal` is not carried (default false)
    expect(tracker.pendingSignals(G)).toEqual([vote, edit, gone]);
    tracker.onOwnEcho(G, 'v1');
    tracker.sendRejected(G, 'f1');
    expect(tracker.pendingSignals(G)).toEqual([edit]);
  });

  it('forget drops a row and its clock', async () => {
    tracker.register(G, 'r');
    tracker.sendResolved(G, 'r');
    tracker.forget(G, 'r');
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, 'r')).toBeUndefined();
    expect(statuses).toEqual([]);
  });

  it('retains at most maxConfirmedRetained confirmed rows (oldest forgotten); unconfirmed rows are never pruned', () => {
    const t = createOwnRowTracker({ ports: { setStatus: () => undefined }, maxConfirmedRetained: 2 });
    t.register(G, 'pending');
    for (const id of ['a', 'b', 'c']) {
      t.register(G, id);
      t.onOwnEcho(G, id);
    }
    expect(t.statusOf(G, 'a')).toBeUndefined();
    expect(t.statusOf(G, 'b')).toBe('confirmed');
    expect(t.statusOf(G, 'c')).toBe('confirmed');
    expect(t.statusOf(G, 'pending')).toBe('sending');
    t.dispose();
  });

  it('a throwing status port never breaks the lifecycle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = createOwnRowTracker({ ports: { setStatus: () => { throw new Error('ui down'); } } });
    t.register(G, 'r');
    expect(() => t.onOwnEcho(G, 'r')).not.toThrow();
    expect(t.statusOf(G, 'r')).toBe('confirmed');
    warn.mockRestore();
    t.dispose();
  });

  it('dispose clears every clock and ignores later calls', async () => {
    tracker.register(G, 'r');
    tracker.sendResolved(G, 'r');
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    tracker.onIntentFailed({ groupId: G, intentId: 'i1' });
    tracker.onOwnWithdrawn(G, 'r');
    expect(statuses).toEqual([]);
  });
});

describe('construction is loud (required port, valid options)', () => {
  it('requires ports.setStatus', () => {
    expect(() => createOwnRowTracker(undefined as never)).toThrow(TypeError);
    expect(() => createOwnRowTracker({} as never)).toThrow(/setStatus/);
    expect(() => createOwnRowTracker({ ports: {} } as never)).toThrow(/setStatus/);
  });
  it('validates the numeric options', () => {
    const ports = { setStatus: () => undefined };
    expect(() => createOwnRowTracker({ ports, timeoutMs: 0 })).toThrow(TypeError);
    expect(() => createOwnRowTracker({ ports, timeoutMs: Number.NaN })).toThrow(TypeError);
    expect(() => createOwnRowTracker({ ports, maxConfirmedRetained: 0 })).toThrow(TypeError);
  });
  it('the tracker exposes no way to resend: there is no send port', () => {
    expect(Object.keys(tracker).sort()).toEqual(
      ['attemptOf', 'bindIntent', 'dispose', 'forget', 'forgetGroup', 'onGroupBranchSwitched', 'onIntentFailed', 'onOwnEcho', 'onOwnWithdrawn', 'pendingSignals', 'register', 'retry', 'sendRejected', 'sendResolved', 'statusOf'].sort(),
    );
  });
});
