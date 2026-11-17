// @vitest-environment node
/**
 * S6 hardening of the own-send lifecycle: own-intent matching (intentFailed fails only the row whose intent failed),
 * the unconfirmed timer starting only once the group is synced, a still-queued rumor staying `sending`, the retry
 * rule (the identical stored rumor, same id), same-second identical sends, signal-only pendingSignals, and memory
 * bounds (failed cap, unknown withdraw, forgetGroup).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupRumorSender, createOwnRowTracker, isSignalRumor, OWN_SEND_CONFIRM_TIMEOUT_MS, type OwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';

const OWN = 'a1'.repeat(32);
const G = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

let tracker: OwnRowTracker;
let reports: Array<[string, string, string]>;
let forgotten: Array<[string, string]>;
beforeEach(() => {
  vi.useFakeTimers();
  reports = [];
  forgotten = [];
  tracker = createOwnRowTracker({
    ports: { setStatus: (g, id, s) => void reports.push([g, id, s]), forget: (g, id) => void forgotten.push([g, id]) },
  });
});
afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

const sender = (now = () => 1_700_000_000) => createGroupRumorSender({ ownPubkey: OWN, tracker, nowSeconds: now });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const err = (code: string) => Object.assign(new Error(code), { code });

type Intent = { intentId: string; state: string; kind: string };
/** A group modelling the library: send records an intent (application or queued), pendingIntents lists them. */
function libGroup(opts: { id?: string; syncedGate?: Promise<void>; sendBehavior?: (n: number, intents: Intent[]) => Promise<void> } = {}) {
  const intents: Intent[] = [];
  let n = 0;
  const sent: Array<{ rumor: { id: string; created_at: number } }> = [];
  const group: SendableGroup = {
    id: opts.id ?? G,
    send: vi.fn(async (intent) => {
      sent.push(intent as never);
      n += 1;
      if (opts.sendBehavior) return opts.sendBehavior(n, intents);
      intents.push({ intentId: `app-${n}`, state: 'pending-confirm', kind: 'application' });
    }) as unknown as SendableGroup['send'],
    pendingIntents: async () => [...intents],
    ...(opts.syncedGate ? { synced: () => opts.syncedGate! } : {}),
  };
  return { group, intents, sent };
}

describe('3a: intentFailed fails only the row whose own intent failed', () => {
  it('two sends in one group: the failure of the second intent fails the second row only; a non-application intent fails nothing', async () => {
    const { group, intents } = libGroup();
    intents.push({ intentId: 'commit-1', state: 'pending-publish', kind: 'commit' });
    const s = sender();
    const a = s.prepare(group, 9, 'a', []);
    await a.send();
    const b = s.prepare(group, 9, 'b', []);
    await b.send();
    tracker.onIntentFailed({ groupId: G, intentId: 'commit-1' });
    expect(tracker.statusOf(G, a.id)).toBe('sending');
    expect(tracker.statusOf(G, b.id)).toBe('sending');
    tracker.onIntentFailed({ groupId: G, intentId: 'app-2' });
    expect(tracker.statusOf(G, a.id)).toBe('sending');
    expect(tracker.statusOf(G, b.id)).toBe('failed');
  });

  it('an intent id no row is bound to (another session, a resumed intent) fails nothing', async () => {
    const { group } = libGroup();
    const p = sender().prepare(group, 9, 'a', []);
    await p.send();
    tracker.onIntentFailed({ groupId: G, intentId: 'never-seen' });
    expect(tracker.statusOf(G, p.id)).toBe('sending');
  });

  it('concurrent sends (ambiguous diff) bind nothing rather than guess; the row is then failed by its own triggers only', async () => {
    const gates: Array<() => void> = [];
    const { group } = libGroup({
      sendBehavior: (n, intents) =>
        new Promise<void>((resolve) => {
          // both sends are in flight (both `before` snapshots taken) when the intents appear
          gates.push(() => {
            intents.push({ intentId: `app-${n}`, state: 'pending-confirm', kind: 'application' });
            resolve();
          });
        }),
    });
    const s = sender();
    const a = s.prepare(group, 9, 'a', []);
    const b = s.prepare(group, 9, 'b', []);
    const pa = a.send();
    const pb = b.send();
    await flush();
    gates.forEach((g) => g());
    await Promise.all([pa, pb]);
    tracker.onIntentFailed({ groupId: G, intentId: 'app-1' });
    tracker.onIntentFailed({ groupId: G, intentId: 'app-2' });
    expect(tracker.statusOf(G, a.id)).toBe('sending');
    expect(tracker.statusOf(G, b.id)).toBe('sending');
  });

  it('the failure of an intent in another group fails nothing here', async () => {
    const { group } = libGroup();
    const p = sender().prepare(group, 9, 'a', []);
    await p.send();
    tracker.onIntentFailed({ groupId: OTHER, intentId: 'app-1' });
    expect(tracker.statusOf(G, p.id)).toBe('sending');
  });
});

describe('3b: the unconfirmed timer starts once the group is synced', () => {
  it('an awaiting-sync send does not fail while the first sync takes longer than 60 s; the clock starts at synced()', async () => {
    let syncDone!: () => void;
    const { group } = libGroup({ syncedGate: new Promise<void>((r) => (syncDone = r)) });
    const p = sender().prepare(group, 9, 'a', []);
    await p.send();
    await vi.advanceTimersByTimeAsync(5 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    syncDone();
    await vi.advanceTimersByTimeAsync(OWN_SEND_CONFIRM_TIMEOUT_MS - 1);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it('synced() rejecting (fenced, disposed, not a member) fails the row', async () => {
    const gate = Promise.reject(err('fenced'));
    gate.catch(() => undefined);
    const { group } = libGroup({ syncedGate: gate });
    const p = sender().prepare(group, 9, 'a', []);
    await p.send();
    await flush();
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it('an echo before the sync completes confirms the row; the later synced() starts no clock', async () => {
    let syncDone!: () => void;
    const { group } = libGroup({ syncedGate: new Promise<void>((r) => (syncDone = r)) });
    const p = sender().prepare(group, 9, 'a', []);
    await p.send();
    tracker.onOwnEcho(G, p.id, 'e1');
    syncDone();
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
  });
});

describe('3c: a send-rejected whose rumor the library still holds queued stays sending', () => {
  const queuedGroup = () =>
    libGroup({
      sendBehavior: async (_n, intents) => {
        intents.push({ intentId: 'queue-1', state: 'queued', kind: 'application' });
        throw err('send-rejected');
      },
    });

  it('stays sending (no failed report), the caller still sees the rejection, a later echo confirms it', async () => {
    const { group } = queuedGroup();
    const p = sender().prepare(group, 9, 'a', []);
    await expect(p.send()).rejects.toMatchObject({ code: 'send-rejected' });
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    expect(reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * OWN_SEND_CONFIRM_TIMEOUT_MS); // no clock: nothing resolved
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    tracker.onOwnEcho(G, p.id, 'e1');
    expect(tracker.statusOf(G, p.id)).toBe('confirmed');
  });

  it('the failure of the queued rumor itself (fenced) fails the row', async () => {
    const { group } = queuedGroup();
    const p = sender().prepare(group, 9, 'a', []);
    await p.send().catch(() => undefined);
    tracker.onIntentFailed({ groupId: G, intentId: 'queue-1' });
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it('a send-rejected with nothing queued fails the row, and so does any other rejection', async () => {
    for (const code of ['send-rejected', 'publish-failed']) {
      const { group } = libGroup({
        sendBehavior: async () => {
          throw err(code);
        },
      });
      const p = sender().prepare(group, 9, code, []);
      await p.send().catch(() => undefined);
      expect(tracker.statusOf(G, p.id), code).toBe('failed');
    }
  });

  it('a queued intent that belongs to ANOTHER send (already in the before snapshot) does not keep this row alive', async () => {
    const { group, intents } = libGroup({
      sendBehavior: async () => {
        throw err('send-rejected');
      },
    });
    intents.push({ intentId: 'queue-0', state: 'queued', kind: 'application' });
    const p = sender().prepare(group, 9, 'a', []);
    await p.send().catch(() => undefined);
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });
});

describe('3d: retry re-sends the identical stored rumor', () => {
  it('failed -> retry: group.send gets the same rumor (same id and created_at), the row returns to sending, then a late echo confirms', async () => {
    let now = 1_700_000_000;
    let failFirst = true;
    const { group, sent } = libGroup({
      sendBehavior: async (_n, intents) => {
        if (failFirst) {
          failFirst = false;
          throw err('publish-failed');
        }
        intents.push({ intentId: 'app-retry', state: 'pending-confirm', kind: 'application' });
      },
    });
    const s = sender(() => now);
    const p = s.prepare(group, 9, 'hello', [['t', 'x']]);
    await p.send().catch(() => undefined);
    expect(tracker.statusOf(G, p.id)).toBe('failed');
    now += 3600; // a rebuilt rumor would get a new created_at, hence a new id
    const retried = await s.retry(group, p.id);
    expect(retried.id).toBe(p.id);
    expect(sent).toHaveLength(2);
    expect(sent[1].rumor).toEqual(sent[0].rumor);
    expect(sent[1].rumor.id).toBe(p.id);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    expect(reports.map((r) => r[2])).toEqual(['failed', 'sending']);
    tracker.onOwnEcho(G, p.id, 'e1');
    expect(reports.map((r) => r[2])).toEqual(['failed', 'sending', 'confirmed']);
  });

  it('a retry that fails again returns the row to failed; the retry binds its own new intent', async () => {
    let n = 0;
    const { group, intents } = libGroup({
      sendBehavior: async () => {
        n += 1;
        if (n === 1) throw err('publish-failed');
        intents.push({ intentId: 'app-r', state: 'pending-confirm', kind: 'application' });
      },
    });
    const s = sender();
    const p = s.prepare(group, 9, 'x', []);
    await p.send().catch(() => undefined);
    await s.retry(group, p.id);
    expect(tracker.statusOf(G, p.id)).toBe('sending');
    tracker.onIntentFailed({ groupId: G, intentId: 'app-r' });
    expect(tracker.statusOf(G, p.id)).toBe('failed');
  });

  it.each(['sending', 'confirmed', 'unknown'])('retry of a %s row rejects without sending', async (state) => {
    const { group } = libGroup();
    const s = sender();
    const p = s.prepare(group, 9, 'x', []);
    if (state === 'confirmed') tracker.onOwnEcho(G, p.id);
    const id = state === 'unknown' ? 'f'.repeat(64) : p.id;
    await expect(s.retry(group, id)).rejects.toThrow(/not failed/);
    expect(group.send).not.toHaveBeenCalled();
  });

  it('the tracker hands back the stored rumor only for a failed row', () => {
    const rumor = { id: 'r1', pubkey: OWN, created_at: 1, kind: 9, tags: [], content: 'c' };
    tracker.register(G, 'r1', { rumor, signal: false });
    expect(tracker.retry(G, 'r1')).toBeUndefined();
    tracker.sendRejected(G, 'r1');
    expect(tracker.retry(G, 'r1')).toBe(rumor);
    expect(tracker.retry(G, 'r1')).toBeUndefined(); // now sending
  });
});

describe('4: same-second identical sends get distinct ids', () => {
  it('three identical sends under a fixed clock: created_at bumped by one second until the id is unique; one row each', async () => {
    const { group, sent } = libGroup();
    const s = sender(() => 1_700_000_000);
    const prepared = [s.prepare(group, 9, 'same', []), s.prepare(group, 9, 'same', []), s.prepare(group, 9, 'same', [])];
    expect(new Set(prepared.map((p) => p.id)).size).toBe(3);
    expect(prepared.map((p) => p.rumor.created_at)).toEqual([1_700_000_000, 1_700_000_001, 1_700_000_002]);
    for (const p of prepared) await p.send();
    expect(sent.map((x) => x.rumor.id)).toEqual(prepared.map((p) => p.id));
    expect(prepared.every((p) => tracker.statusOf(G, p.id) === 'sending')).toBe(true);
  });

  it('the same content in ANOTHER group keeps the unbumped second (ids are tracked per group)', () => {
    const s = sender(() => 5);
    expect(s.prepare(libGroup({ id: G }).group, 9, 'same', []).rumor.created_at).toBe(5);
    expect(s.prepare(libGroup({ id: OTHER }).group, 9, 'same', []).rumor.created_at).toBe(5);
  });
});

describe('5: pendingSignals returns signals only', () => {
  const rumors: Array<[string, number, string[][], boolean]> = [
    ['plain chat message', 9, [], false],
    ['image message (imeta)', 9, [['imeta', 'url https://x/y.png', 'm image/png']], false],
    ['reply with a q tag', 9, [['e', 'target', '', 'reply']], false],
    ['edit-marked replacement', 9, [['e', 'target', '', 'edit']], true],
    ['reaction', 7, [['e', 'target']], true],
    ['delete', 5, [['e', 'target']], true],
    ['poll create', 10, [], true],
    ['poll vote', 11, [], true],
    ['poll close', 12, [], true],
  ];
  it.each(rumors)('%s (kind %i) is %s', (_name, kind, tags, signal) => {
    const { group } = libGroup();
    const p = sender().prepare(group, kind, `c-${kind}`, tags);
    expect(isSignalRumor(p.rumor)).toBe(signal);
    expect(tracker.pendingSignals(G).map((r) => r.id)).toEqual(signal ? [p.id] : []);
  });
});

describe('6: memory bounds', () => {
  it('failed rows are capped like confirmed ones (oldest forgotten, the port told); unconfirmed rows are never pruned', () => {
    const t = createOwnRowTracker({ ports: { setStatus: () => undefined, forget: (g, id) => void forgotten.push([g, id]) }, maxFailedRetained: 2 });
    for (const id of ['r1', 'r2', 'r3']) {
      t.register(G, id);
      t.sendRejected(G, id);
    }
    t.register(G, 'live');
    expect(t.statusOf(G, 'r1')).toBeUndefined();
    expect(t.statusOf(G, 'r2')).toBe('failed');
    expect(t.statusOf(G, 'r3')).toBe('failed');
    expect(t.statusOf(G, 'live')).toBe('sending');
    expect(forgotten).toEqual([[G, 'r1']]);
    t.dispose();
  });

  it('a withdraw of an unknown id reports failed but never tracks a row (a flood of them cannot grow the tracker)', () => {
    for (let i = 0; i < 100; i++) tracker.onOwnWithdrawn(G, `ghost-${i}`);
    expect(reports).toHaveLength(100);
    expect(tracker.statusOf(G, 'ghost-0')).toBeUndefined();
    expect(tracker.pendingSignals(G)).toEqual([]);
    tracker.onOwnEcho(G, 'ghost-0'); // tolerated, still nothing
    expect(tracker.statusOf(G, 'ghost-0')).toBeUndefined();
  });

  it('forgetGroup drops every row of that group (clock included), tells the port, and leaves other groups alone', async () => {
    const mine = libGroup({ id: G });
    const other = libGroup({ id: OTHER });
    const s = sender();
    const a = s.prepare(mine.group, 9, 'a', []);
    const b = s.prepare(mine.group, 9, 'b', []);
    const c = s.prepare(other.group, 9, 'c', []);
    await a.send();
    await c.send();
    tracker.onOwnEcho(G, b.id);
    s.forgetGroup(G);
    expect([a.id, b.id].map((id) => tracker.statusOf(G, id))).toEqual([undefined, undefined]);
    expect(tracker.statusOf(OTHER, c.id)).toBe('sending');
    expect(forgotten.filter(([g]) => g === G).map(([, id]) => id).sort()).toEqual([a.id, b.id].sort());
    await vi.advanceTimersByTimeAsync(2 * OWN_SEND_CONFIRM_TIMEOUT_MS);
    expect(reports.filter(([g]) => g === G)).toEqual([[G, b.id, 'confirmed']]); // a's clock was cleared, nothing failed
    expect(tracker.statusOf(OTHER, c.id)).toBe('failed'); // the other group's clock still runs
  });
});
