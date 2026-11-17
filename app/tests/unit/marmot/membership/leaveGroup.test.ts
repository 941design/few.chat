// @vitest-environment node
/**
 * S13 / AC-LEAVE-1/2/3 for the leave orchestration, over the REAL GroupOpQueue (the `skipSync` and abort semantics are
 * the queue's, not a stub's) and recording fakes for the library group, the purger and the UI ports:
 *
 *  AC-LEAVE-1  sole admin -> blocked, no leave(), nothing sent, nothing hidden; sole member -> local purge only;
 *              a throwing members() accessor never skips the purge on the leave path.
 *  AC-LEAVE-2  the group is hidden BEFORE leave() settles (and before anything async runs); leave() runs in the
 *              background through the queue with skipSync (an unsynced / offline group cannot block it); the kind-9
 *              announcement goes first with a bounded wait and soft-fails (rejecting or hanging).
 *  AC-LEAVE-3  leave() rejecting or timing out -> the group is restored and the leave-failed toast raised (not for
 *              `last-admin`); NO durable "leaving" marker (idb / localStorage scan).
 */
import 'fake-indexeddb/auto';
import { keys as idbKeys } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import { PurgeError } from '@/src/lib/marmot/membership';
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import {
  buildLeftAnnouncementContent,
  createGroupLeaver,
  LeaveTimeoutError,
  type GroupLeaverDeps,
  type LeavableGroup,
} from '@/src/lib/marmot/membership';

const OWN = 'a1'.repeat(32);
const P2 = 'b2'.repeat(32);
const P3 = 'c3'.repeat(32);
const G = 'ab'.repeat(32);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

interface Fx {
  trace: string[];
  group: LeavableGroup & { synced: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };
  deps: GroupLeaverDeps;
  toasts: Array<{ kind: 'leave-failed' | 'last-admin'; error?: unknown }>;
  purges: string[];
  announcements: Array<{ kind: number; content: string; tags: string[][] }>;
  leaveCall: { promise: Promise<void>; resolve: () => void };
  live: { group: LeavableGroup | undefined };
}

function fixture(
  o: {
    members?: () => readonly string[];
    admins?: () => readonly string[];
    leave?: () => Promise<void>;
    announce?: GroupLeaverDeps['sendAnnouncement'];
    purge?: (groupId: string) => Promise<void>;
    noGroup?: boolean;
    leaveDeadlineMs?: number;
    announceTimeoutMs?: number;
    ownName?: () => string | undefined;
  } = {},
): Fx {
  const trace: string[] = [];
  const toasts: Fx['toasts'] = [];
  const purges: string[] = [];
  const announcements: Fx['announcements'] = [];
  const leaveCall = deferred();
  const group = {
    id: G,
    members: o.members ?? (() => [OWN, P2, P3]),
    activeAdmins: o.admins ?? (() => [OWN, P2]),
    // an offline group: synced() never settles. The leave must not wait for it.
    synced: vi.fn(() => new Promise<void>(() => undefined)),
    leave: vi.fn(async () => {
      trace.push('leave');
      leaveCall.resolve();
      return o.leave ? o.leave() : undefined;
    }),
  } as unknown as Fx['group'];
  const live = { group: (o.noGroup ? undefined : group) as LeavableGroup | undefined };
  const deps: GroupLeaverDeps = {
    ownPubkey: OWN,
    getGroup: async () => live.group,
    queue: createGroupOpQueue({ syncTimeoutMs: 60_000 }),
    purger: {
      purgeLocalGroup: async (id) => {
        trace.push('purge');
        purges.push(id);
        await o.purge?.(id);
      },
    },
    sendAnnouncement:
      o.announce ??
      (async (_g, kind, content, tags) => {
        trace.push('announce');
        announcements.push({ kind, content, tags });
      }),
    hideGroup: () => void trace.push('hide'),
    restoreGroup: () => void trace.push('restore'),
    notifyLeaveFailed: (_g, error) => void toasts.push({ kind: 'leave-failed', error }),
    notifyLastAdminBlocked: () => void toasts.push({ kind: 'last-admin' }),
    pendingView: { scheduleRefresh: () => void trace.push('refresh') },
    ...(o.ownName ? { ownName: o.ownName } : {}),
    ...(o.leaveDeadlineMs ? { leaveDeadlineMs: o.leaveDeadlineMs } : {}),
    ...(o.announceTimeoutMs ? { announceTimeoutMs: o.announceTimeoutMs } : {}),
    onError: () => undefined,
  };
  return { trace, group, deps, toasts, purges, announcements, leaveCall, live };
}

let leavers: Array<{ dispose: () => void }> = [];
const make = (fx: Fx) => {
  const leaver = createGroupLeaver(fx.deps);
  leavers.push(leaver);
  return leaver;
};
beforeEach(() => {
  leavers = [];
});
afterEach(() => {
  vi.useRealTimers();
  for (const l of leavers) l.dispose();
});

describe('AC-LEAVE-2: immediate UI removal, background leave, announcement first', () => {
  it('hides the group before leave() is even called, returns while leave() is still pending, and settles `left` after the purge', async () => {
    const hold = deferred();
    const fx = fixture({ leave: () => hold.promise });
    const result = await make(fx).leave(G);

    expect(result.status).toBe('started');
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('leave');
    expect(fx.trace[0]).toBe('hide'); // hidden before the announcement, before leave()
    await fx.leaveCall.promise;
    expect(fx.trace).toEqual(['hide', 'announce', 'leave']);
    // leave() has not settled: nothing restored, nothing purged, the caller already got its result
    expect(fx.purges).toEqual([]);

    hold.resolve();
    const settled = await result.settled;
    expect(settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.trace).toEqual(['hide', 'announce', 'leave', 'purge', 'refresh']);
    expect(fx.purges).toEqual([G]);
    expect(fx.toasts).toEqual([]);
  });

  it('the kind-9 announcement is a `leave_intent` chat announcement parseStructured renders, with the own name when known', async () => {
    const fx = fixture({ ownName: () => '  Ada  ' });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await result.settled;
    expect(fx.announcements).toHaveLength(1);
    const [{ kind, content, tags }] = fx.announcements;
    expect(kind).toBe(9);
    expect(tags).toEqual([]);
    expect(parseStructured(content)).toEqual({ type: 'leave_intent', pubkey: OWN, name: 'Ada' });
    expect(buildLeftAnnouncementContent(OWN)).toBe(JSON.stringify({ type: 'leave_intent', pubkey: OWN }));
    expect(parseStructured(buildLeftAnnouncementContent(OWN))).toEqual({ type: 'leave_intent', pubkey: OWN });
  });

  it('leave() is queued through the GroupOpQueue with skipSync: an offline group whose synced() never settles does not block it', async () => {
    const fx = fixture();
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    expect(fx.group.synced).not.toHaveBeenCalled();
  });

  it('SOFT FAIL: a rejecting announcement never blocks leave()', async () => {
    const fx = fixture({ announce: async () => Promise.reject(new Error('send-rejected')) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    expect(fx.toasts).toEqual([]);
  });

  it('SOFT FAIL: a synchronously throwing announcement never blocks leave()', async () => {
    const fx = fixture({
      announce: () => {
        throw new Error('boom');
      },
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect((await result.settled).status).toBe('left');
  });

  it('BOUNDED: a hanging announcement is waited for at most announceTimeoutMs, then leave() runs', async () => {
    vi.useFakeTimers();
    const fx = fixture({ announce: () => new Promise(() => undefined), announceTimeoutMs: 5_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fx.group.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    expect((await result.settled).status).toBe('left');
  });

  it('a late-rejecting announcement (after the bound and after the leave) is not an unhandled rejection', async () => {
    vi.useFakeTimers();
    const late = deferred();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const fx = fixture({ announce: () => late.promise, announceTimeoutMs: 100 });
      const result = await make(fx).leave(G);
      if (result.status !== 'started') throw new Error('unreachable');
      await vi.advanceTimersByTimeAsync(200);
      await result.settled;
      late.reject(new Error('relay closed'));
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the pending-invitation view is refreshed after the group is gone', async () => {
    const fx = fixture();
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await result.settled;
    expect(fx.trace.at(-1)).toBe('refresh');
    expect(fx.trace.indexOf('refresh')).toBeGreaterThan(fx.trace.indexOf('purge'));
  });

  it('two leave() calls for one group share one run: leave() is called once', async () => {
    const hold = deferred();
    const fx = fixture({ leave: () => hold.promise });
    const leaver = make(fx);
    const [a, b] = await Promise.all([leaver.leave(G), leaver.leave(G)]);
    hold.resolve();
    if (a.status !== 'started' || b.status !== 'started') throw new Error('unreachable');
    await Promise.all([a.settled, b.settled]);
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    expect(fx.trace.filter((t) => t === 'hide')).toHaveLength(1);
  });
});

describe('AC-LEAVE-1: eligibility on the leave path', () => {
  it('sole admin of a group with other members: blocked at once, no leave(), no announcement, nothing hidden or purged', async () => {
    const fx = fixture({ admins: () => [OWN] });
    const result = await make(fx).leave(G);
    expect(result).toEqual({ status: 'blocked', reason: 'last-admin' });
    expect(fx.trace).toEqual([]);
    expect(fx.group.leave).not.toHaveBeenCalled();
  });

  it('sole member: abandon mode, hidden first, local purge only: no leave(), no announcement', async () => {
    const fx = fixture({ members: () => [OWN], admins: () => [OWN] });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('abandon');
    expect(await result.settled).toEqual({ status: 'left', mode: 'abandon' });
    expect(fx.trace).toEqual(['hide', 'purge', 'refresh']);
    expect(fx.group.leave).not.toHaveBeenCalled();
    expect(fx.announcements).toEqual([]);
  });

  it('a group the library no longer holds: abandon mode (purge only)', async () => {
    const fx = fixture({ noGroup: true });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('abandon');
    expect((await result.settled).status).toBe('left');
    expect(fx.trace).toEqual(['hide', 'purge', 'refresh']);
  });

  it('a getGroup rejection does not throw out of leave(): the purge (which looks the group up again) decides', async () => {
    const fx = fixture({ purge: async () => Promise.reject(new Error('client disposed')) });
    fx.deps.getGroup = async () => Promise.reject(new Error('client disposed'));
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect((await result.settled).status).toBe('failed');
    expect(fx.trace).toEqual(['hide', 'purge', 'restore']);
  });

  it('TWIN READ: a throwing members() on the leave path is `leave` (never abandon, never blocked); a successful leave() still purges', async () => {
    const fx = fixture({
      members: () => {
        throw new Error('corrupt group state');
      },
      admins: () => [OWN], // a KNOWN sole-admin fact must not block while the roster is unknown
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('leave');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    expect(fx.purges).toEqual([G]);
  });

  it('TWIN READ: a throwing activeAdmins() is "unknown", not "sole admin": the leave proceeds', async () => {
    const fx = fixture({
      admins: () => {
        throw new Error('corrupt group state');
      },
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
  });
});

describe('AC-LEAVE-3: failure restores the group and raises the toast; no durable marker', () => {
  it('leave() rejecting: restored, leave-failed toast with the error, no purge, settled `failed`', async () => {
    const boom = Object.assign(new Error('publish failed'), { code: 'publish-failed' });
    const fx = fixture({ leave: async () => Promise.reject(boom) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'failed', error: boom });
    expect(fx.trace).toEqual(['hide', 'announce', 'leave', 'restore']);
    expect(fx.toasts).toEqual([{ kind: 'leave-failed', error: boom }]);
    expect(fx.purges).toEqual([]);
  });

  it('leave() that never settles: after leaveDeadlineMs the group is restored with the toast (a timeout is a failure)', async () => {
    vi.useFakeTimers();
    const fx = fixture({ leave: () => new Promise<void>(() => undefined), leaveDeadlineMs: 20_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fx.toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    const settled = await result.settled;
    expect(settled.status).toBe('failed');
    expect((settled as { error: unknown }).error).toBeInstanceOf(LeaveTimeoutError);
    expect(fx.trace.at(-1)).toBe('restore');
    expect(fx.toasts).toHaveLength(1);
    expect(fx.toasts[0].kind).toBe('leave-failed');
  });

  it('a `last-admin` rejection the pre-check could not see: restored with the BLOCKED notice, not the failure toast', async () => {
    const fx = fixture({
      admins: () => {
        throw new Error('unreadable');
      },
      leave: async () => Promise.reject(Object.assign(new Error('last admin'), { code: 'last-admin' })),
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'blocked', reason: 'last-admin' });
    expect(fx.toasts).toEqual([{ kind: 'last-admin' }]);
    expect(fx.trace).toContain('restore');
    expect(fx.purges).toEqual([]);
  });

  it('a purge failure in abandon mode restores the group with the toast (the group is intact: abandon aborted first)', async () => {
    const boom = new Error('abandon failed');
    const fx = fixture({ members: () => [OWN], admins: () => [OWN], purge: async () => Promise.reject(boom) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'failed', error: boom });
    expect(fx.trace).toEqual(['hide', 'purge', 'restore']);
    expect(fx.toasts).toEqual([{ kind: 'leave-failed', error: boom }]);
  });

  it('a purge failure AFTER a successful leave() does not restore a ghost of the left group (the overlay row keeps the retry key)', async () => {
    const fx = fixture({ purge: async () => Promise.reject(new Error('quota')) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.trace).not.toContain('restore');
    expect(fx.toasts).toEqual([]);
  });

  it('a throwing UI port never breaks the outcome', async () => {
    const fx = fixture({ leave: async () => Promise.reject(new Error('x')) });
    fx.deps.restoreGroup = () => {
      throw new Error('ui exploded');
    };
    fx.deps.notifyLeaveFailed = () => {
      throw new Error('toast exploded');
    };
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect((await result.settled).status).toBe('failed');
  });

  it('NO durable "leaving" marker: neither idb nor localStorage changes while leave() is in flight or after it failed', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    });
    try {
      const idbBefore = (await idbKeys()).map(String);
      const hold = deferred();
      const fx = fixture({ leave: () => hold.promise });
      const result = await make(fx).leave(G);
      if (result.status !== 'started') throw new Error('unreachable');
      await fx.leaveCall.promise;
      // MID-LEAVE: the app's only record is in-memory UI state
      expect((await idbKeys()).map(String)).toEqual(idbBefore);
      expect([...store.entries()]).toEqual([]);
      hold.reject(new Error('timeout'));
      await result.settled;
      // after the failure the group is listed again and nothing durable was written
      expect((await idbKeys()).map(String)).toEqual(idbBefore);
      expect([...store.entries()]).toEqual([]);
      expect(fx.trace.at(-1)).toBe('restore');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dispose (account teardown)', () => {
  it('a leave() that fails after dispose neither restores nor toasts', async () => {
    const hold = deferred();
    const fx = fixture({ leave: () => hold.promise });
    const leaver = make(fx);
    const result = await leaver.leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await fx.leaveCall.promise;
    leaver.dispose();
    hold.reject(new Error('client disposed'));
    expect(await result.settled).toEqual({ status: 'aborted' });
    expect(fx.toasts).toEqual([]);
    expect(fx.trace).not.toContain('restore');
  });
});

describe('construction validates every port (a missing one fails loudly, never degrades to non-behavior)', () => {
  const base = fixture().deps;
  const fnPorts = ['getGroup', 'sendAnnouncement', 'hideGroup', 'restoreGroup', 'notifyLeaveFailed', 'notifyLastAdminBlocked'] as const;
  it.each(fnPorts)('missing %s throws a TypeError naming it', (name) => {
    const deps = { ...base } as Record<string, unknown>;
    delete deps[name];
    expect(() => createGroupLeaver(deps as unknown as GroupLeaverDeps)).toThrowError(new RegExp(`'${name}'`));
  });
  it.each([
    ['queue', 'runCommit'],
    ['purger', 'purgeLocalGroup'],
    ['pendingView', 'scheduleRefresh'],
  ] as const)('missing %s.%s throws', (owner, member) => {
    expect(() => createGroupLeaver({ ...base, [owner]: {} } as unknown as GroupLeaverDeps)).toThrowError(new RegExp(`${owner}\\.${member}`));
  });
  it('ownPubkey and the bounds are validated', () => {
    expect(() => createGroupLeaver({ ...base, ownPubkey: '' })).toThrowError(/ownPubkey/);
    expect(() => createGroupLeaver({ ...base, announceTimeoutMs: 0 })).toThrowError(/announceTimeoutMs/);
    expect(() => createGroupLeaver({ ...base, leaveDeadlineMs: -1 })).toThrowError(/leaveDeadlineMs/);
  });
  it('rejects an empty group id', async () => {
    await expect(createGroupLeaver(base).leave('')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('a leave() that succeeds after the app gave up (late success)', () => {
  it('the deadline fires (restore + toast), leave() resolves LATER: hidden again, purged, refreshed, no second toast', async () => {
    vi.useFakeTimers();
    const late = deferred();
    const fx = fixture({ leave: () => late.promise, leaveDeadlineMs: 20_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await result.settled).status).toBe('failed');
    expect(fx.trace.filter((t) => t === 'restore')).toHaveLength(1);
    expect(fx.toasts).toHaveLength(1);
    expect(fx.purges).toEqual([]);

    late.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.trace.filter((t) => t === 'hide')).toHaveLength(2); // hidden again after the restore
    expect(fx.trace.lastIndexOf('hide')).toBeGreaterThan(fx.trace.indexOf('restore'));
    expect(fx.purges).toEqual([G]);
    expect(fx.trace.at(-1)).toBe('refresh');
    expect(fx.toasts).toHaveLength(1); // no second toast
  });

  it('a leave() that rejects and a group the library no longer holds: the leave is DONE (hidden, purged app-side, no restore, no toast)', async () => {
    const fx = fixture();
    fx.group.leave.mockImplementation(async () => {
      fx.trace.push('leave');
      fx.live.group = undefined; // the library purged its own state before the rejection surfaced
      throw new Error('publish failed');
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.trace).not.toContain('restore');
    expect(fx.toasts).toEqual([]);
    expect(fx.purges).toEqual([G]);
    expect(fx.trace.filter((t) => t === 'hide')).toHaveLength(2);
  });

  it('a timeout with a group the library already purged is also done, not failed', async () => {
    vi.useFakeTimers();
    const fx = fixture({ leave: () => new Promise<void>(() => undefined), leaveDeadlineMs: 1_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    fx.live.group = undefined;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.toasts).toEqual([]);
    expect(fx.purges).toEqual([G]);
  });
});

describe('AC-LEAVE-3 with an UNREADABLE roster: a rejected or timed-out leave restores the group and raises the toast', () => {
  const corrupt = () => {
    throw new Error('corrupt group state');
  };
  const failedLeave = () => Promise.reject(new Error('state unreadable'));

  it('leave() rejecting: restored, leave-failed toast, no purge, settled `failed` (the same as the readable case)', async () => {
    const fx = fixture({ members: corrupt, leave: failedLeave });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect((await result.settled).status).toBe('failed');
    expect(fx.trace).toContain('restore');
    expect(fx.toasts).toHaveLength(1);
    expect(fx.toasts[0].kind).toBe('leave-failed');
    expect(fx.purges).toEqual([]);
  });

  it('leave() that never settles: after the deadline the group is restored with the toast, nothing purged', async () => {
    vi.useFakeTimers();
    const fx = fixture({ members: corrupt, leave: () => new Promise<void>(() => undefined), leaveDeadlineMs: 20_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(20_001);
    const settled = await result.settled;
    expect(settled.status).toBe('failed');
    expect((settled as { error: unknown }).error).toBeInstanceOf(LeaveTimeoutError);
    expect(fx.trace).toContain('restore');
    expect(fx.toasts.map((t) => t.kind)).toEqual(['leave-failed']);
    expect(fx.purges).toEqual([]);
  });

  it('EXCEPT when the library no longer holds the group: the leave did commit, so it is done (hidden, purged), not failed', async () => {
    const fx = fixture({ members: corrupt, leave: failedLeave });
    fx.group.leave = vi.fn(async () => {
      fx.live.group = undefined; // the library purged its own state, then the call rejected
      throw new Error('late failure');
    });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.trace).not.toContain('restore');
    expect(fx.toasts).toEqual([]);
    expect(fx.purges).toEqual([G]);
  });

  it('an APP-SIDE purge failure after a successful leave() keeps the no-restore behaviour (the overlay row is the retry key)', async () => {
    const boom = new PurgeError(G, [{ step: 'messages', error: new Error('quota') }]);
    const fx = fixture({ members: corrupt, purge: async () => Promise.reject(boom) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.trace).not.toContain('restore');
    expect(fx.toasts).toEqual([]);
  });
});

describe('a failed group lookup is never "not a member"', () => {
  const sharedGroupFixture = () => {
    const fx = fixture();
    const seen: Array<[string, unknown]> = [];
    fx.deps.purger = {
      purgeLocalGroup: async (id, options) => {
        seen.push([id, options]);
      },
    };
    return { fx, seen };
  };

  it('getGroup rejects once, then succeeds on a shared group: the leave path runs (real leave()), no abandon, no ownAccountIsMember bypass', async () => {
    const { fx, seen } = sharedGroupFixture();
    let calls = 0;
    fx.deps.getGroup = async () => {
      if (calls++ === 0) throw new Error('transient store error');
      return fx.group;
    };
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('leave');
    expect(await result.settled).toEqual({ status: 'left', mode: 'leave' });
    expect(fx.group.leave).toHaveBeenCalledTimes(1);
    for (const [, options] of seen) expect((options as { ownAccountIsMember?: boolean } | undefined)?.ownAccountIsMember).not.toBe(true);
  });

  it('getGroup keeps rejecting (undeletable group): mode `leave`, the purger is asked WITHOUT ownAccountIsMember (its re-join guard protects a shared group)', async () => {
    const { fx, seen } = sharedGroupFixture();
    fx.deps.getGroup = async () => Promise.reject(new Error('state unloadable'));
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    expect(result.mode).toBe('leave');
    await result.settled;
    expect(seen.length).toBeGreaterThan(0);
    for (const [, options] of seen) expect((options as { ownAccountIsMember?: boolean } | undefined)?.ownAccountIsMember).not.toBe(true);
  });

  it('a group the library does not hold (lookup resolved undefined) is abandoned WITHOUT the ownAccountIsMember bypass; only the readable sole-member roster passes it', async () => {
    const { fx, seen } = sharedGroupFixture();
    fx.live.group = undefined;
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await result.settled;
    expect(seen).toEqual([[G, undefined]]);
  });
});

describe('AC-LEAVE-2: the 15 s bound includes the announcement wait', () => {
  it('announcement hanging AND leave() hanging: click-to-settle never exceeds leaveDeadlineMs (default 20 s); the leave starts after at most the announcement bound', async () => {
    vi.useFakeTimers();
    const fx = fixture({ announce: () => new Promise(() => undefined), leave: () => new Promise<void>(() => undefined) });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    let settledAt: number | undefined;
    const t0 = Date.now();
    void result.settled.then(() => (settledAt = Date.now() - t0));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(fx.group.leave).toHaveBeenCalledTimes(1); // the hanging announcement held it for at most 2 s
    await vi.advanceTimersByTimeAsync(17_998);
    expect(settledAt).toBeUndefined(); // 19_999 ms: still within the overall deadline
    await vi.advanceTimersByTimeAsync(2);
    expect(settledAt).toBeLessThanOrEqual(20_001);
    expect((await result.settled).status).toBe('failed');
    expect(fx.toasts.map((t) => t.kind)).toEqual(['leave-failed']);
  });

  it('a deadline that fires while the announcement is still pending never starts leave() afterwards', async () => {
    vi.useFakeTimers();
    const fx = fixture({ announce: () => new Promise(() => undefined), announceTimeoutMs: 60_000, leaveDeadlineMs: 3_000 });
    const result = await make(fx).leave(G);
    if (result.status !== 'started') throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await result.settled).status).toBe('failed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fx.group.leave).not.toHaveBeenCalled();
    expect(fx.toasts.map((t) => t.kind)).toEqual(['leave-failed']);
  });
});

describe('purge options', () => {
  it('the sole-member abandon tells the purger its roster legitimately holds the own account; the leave path does not', async () => {
    const seen: Array<[string, unknown]> = [];
    const mk = (o: Parameters<typeof fixture>[0]) => {
      const fx = fixture(o);
      fx.deps.purger = {
        purgeLocalGroup: async (id, options) => {
          seen.push([id, options]);
        },
      };
      return fx;
    };
    const solo = mk({ members: () => [OWN], admins: () => [OWN] });
    const a = await make(solo).leave(G);
    if (a.status !== 'started') throw new Error('unreachable');
    await a.settled;
    const normal = mk({});
    const b = await make(normal).leave(G);
    if (b.status !== 'started') throw new Error('unreachable');
    await b.settled;
    expect(seen[0]).toEqual([G, { ownAccountIsMember: true }]);
    expect(seen[1][1]).toBeUndefined();
  });
});
