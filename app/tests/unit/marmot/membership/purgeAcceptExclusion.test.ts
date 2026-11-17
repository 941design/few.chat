// @vitest-environment node
/**
 * S13 / purge and accept of one group id are MUTUALLY EXCLUSIVE (a per-group async lock owned by the purger):
 *  - a purge that starts after the accept began WAITS for the accept (nothing is deleted under the new membership);
 *  - an accept that starts during a purge WAITS for the purge (auto-accept goes through the same lock);
 *  - the exclusion port is REQUIRED by both accept paths (it cannot be silently disabled).
 */
import { describe, expect, it, vi } from 'vitest';
import { createLocalGroupPurger, type PurgeLocalGroupDeps } from '@/src/lib/marmot/membership';
import { createAutoAccept } from '@/src/lib/marmot/invitations/autoAccept';
import { createInvitationActions } from '@/src/lib/marmot/invitations/acceptDecline';
import { noPurge } from '../invitations/noPurge';

const OWN = 'a1'.repeat(32);
const SPONSOR = 'b2'.repeat(32);
const G = 'ab'.repeat(32);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const settleMicrotasks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

function purgerFixture(overrides: Partial<PurgeLocalGroupDeps> = {}) {
  const trace: string[] = [];
  const noop = async () => undefined;
  const purger = createLocalGroupPurger({
    ownPubkey: OWN,
    getGroup: async () => {
      trace.push('purge:getGroup');
      return undefined;
    },
    history: { purge: noop },
    tracker: { forgetGroup: () => undefined },
    clearMessages: noop,
    clearMessageEdits: noop,
    clearReactions: noop,
    purgeHeldReactions: noop,
    clearPollData: noop,
    clearGroupMedia: noop,
    clearMemberProfiles: noop,
    clearProfileRequestMemos: noop,
    clearUnread: () => undefined,
    clearPendingJoinRequests: noop,
    clearInviteLinks: noop,
    clearInviteExpiries: () => undefined,
    clearPendingDirectInvites: noop,
    clearInviteContexts: noop,
    removeOverlay: async () => void trace.push('purge:removeOverlay'),
    onPurged: () => void trace.push('purge:done'),
    onError: () => undefined,
    ...overrides,
  });
  return { purger, trace };
}

const invitation = { id: 'inv-1', groupId: G, sponsorAccount: SPONSOR, sponsors: [SPONSOR], keyPackageRef: 'kp', receivedAt: 1 };

function actionsFixture(purger: { withGroupLock: never } | object, accept: () => Promise<unknown>) {
  return createInvitationActions({
    invitations: { pending: async () => [invitation] as never, decline: async () => undefined, accept: accept as never },
    view: { refresh: async () => [invitation] as never, isVisible: () => true },
    attachGroup: () => undefined,
    purge: purger as never,
  });
}

describe('purge started AFTER the accept began waits for the accept', () => {
  it('the purge does not touch the group until accept() settled; a rejected accept releases the lock too', async () => {
    const { purger, trace } = purgerFixture();
    const gate = deferred();
    let acceptStarted = false;
    const actions = actionsFixture(purger, async () => {
      acceptStarted = true;
      trace.push('accept:start');
      await gate.promise;
      trace.push('accept:end');
      return { id: G };
    });
    const accepted = actions.accept('inv-1');
    while (!acceptStarted) await settleMicrotasks(); // the accept's own check has passed and it is inside the library call
    const purge = purger.purgeLocalGroup(G);
    await settleMicrotasks();
    expect(trace).toEqual(['accept:start']); // the purge has not looked at the group
    expect(purger.isPurging(G)).toBe(true);
    gate.resolve();
    await accepted;
    await purge;
    expect(trace.slice(0, 3)).toEqual(['accept:start', 'accept:end', 'purge:getGroup']);
  });

  it('a REJECTING accept releases the lock: the queued purge runs', async () => {
    const { purger, trace } = purgerFixture();
    const gate = deferred();
    let started = false;
    const actions = actionsFixture(purger, async () => {
      started = true;
      await gate.promise;
      throw new Error('accept failed');
    });
    const accepted = actions.accept('inv-1').catch((e: unknown) => e);
    while (!started) await settleMicrotasks();
    const purge = purger.purgeLocalGroup(G);
    await settleMicrotasks();
    expect(trace).toEqual([]);
    gate.resolve();
    expect(await accepted).toBeInstanceOf(Error);
    await purge;
    expect(trace).toContain('purge:removeOverlay');
  });

  it('a purge of ANOTHER group is not held by the accept', async () => {
    const { purger, trace } = purgerFixture();
    const gate = deferred();
    let started = false;
    const actions = actionsFixture(purger, async () => {
      started = true;
      await gate.promise;
      return { id: G };
    });
    const accepted = actions.accept('inv-1');
    while (!started) await settleMicrotasks();
    await purger.purgeLocalGroup('cd'.repeat(32));
    expect(trace).toContain('purge:removeOverlay');
    gate.resolve();
    await accepted;
  });
});

describe('accept started DURING a purge waits for the purge', () => {
  it('actions.accept: the library accept() is not called until the purge finished', async () => {
    const gate = deferred();
    const { purger, trace } = purgerFixture({ clearMessages: async () => gate.promise });
    const accept = vi.fn(async () => {
      trace.push('accept');
      return { id: G };
    });
    const purge = purger.purgeLocalGroup(G);
    const accepted = actionsFixture(purger, accept).accept('inv-1');
    await settleMicrotasks();
    expect(accept).not.toHaveBeenCalled();
    gate.resolve();
    await purge;
    await accepted;
    expect(trace.indexOf('purge:done')).toBeLessThan(trace.indexOf('accept'));
  });

  it('auto-accept (through the actions it was given) is deferred behind the purge as well', async () => {
    const gate = deferred();
    const { purger } = purgerFixture({ clearMessages: async () => gate.promise });
    const accept = vi.fn(async () => ({ id: G }));
    const actions = actionsFixture(purger, accept);
    const jobs: Array<() => Promise<void>> = [];
    const auto = createAutoAccept({
      view: { refresh: async () => [invitation] as never, scheduleRefresh: () => undefined },
      actions,
      enqueue: (job) => void jobs.push(job),
      outbound: {
        loadUnexpiredForAdmin: async () => [{ nonce: 'n1', adminPubkeyHex: SPONSOR, groupName: 'Club' }],
        consume: async () => undefined,
      },
      purge: purger,
      groupNameOf: () => 'Club',
      onError: () => undefined,
    });
    const purge = purger.purgeLocalGroup(G);
    auto.evaluate();
    const job = jobs.shift()!();
    await settleMicrotasks();
    expect(accept).not.toHaveBeenCalled();
    gate.resolve();
    await purge;
    await job;
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

describe('withGroupLock', () => {
  it('serialises per group id in FIFO order and survives a rejecting holder', async () => {
    const { purger } = purgerFixture();
    const order: string[] = [];
    const gate = deferred();
    const first = purger.withGroupLock(G, async () => {
      order.push('first:start');
      await gate.promise;
      throw new Error('boom');
    });
    const second = purger.withGroupLock(G, async () => void order.push('second'));
    const other = purger.withGroupLock('other', async () => void order.push('other'));
    await other;
    await settleMicrotasks();
    expect(order).toEqual(['first:start', 'other']);
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(order).toEqual(['first:start', 'other', 'second']);
  });
});

describe('the exclusion port is REQUIRED (it cannot be silently disabled)', () => {
  const base = {
    invitations: { pending: async () => [], decline: async () => undefined, accept: async () => ({}) as never },
    view: { refresh: async () => [], isVisible: () => true },
    attachGroup: () => undefined,
  };
  it('createInvitationActions without `purge` (or without purge.withGroupLock) throws', () => {
    expect(() => createInvitationActions(base as never)).toThrow(/purge/);
    expect(() => createInvitationActions({ ...base, purge: {} } as never)).toThrow(/withGroupLock/);
    expect(() => createInvitationActions({ ...base, purge: noPurge })).not.toThrow();
  });
  it('createAutoAccept without `purge` (or without purge.whenPurged) throws', () => {
    const deps = {
      view: { refresh: async () => [], scheduleRefresh: () => undefined },
      actions: { accept: async () => ({}) as never },
      enqueue: () => undefined,
      outbound: { loadUnexpiredForAdmin: async () => [], consume: async () => undefined },
      groupNameOf: () => undefined,
    };
    expect(() => createAutoAccept(deps as never)).toThrow(/purge/);
    expect(() => createAutoAccept({ ...deps, purge: {} } as never)).toThrow(/whenPurged/);
    expect(() => createAutoAccept({ ...deps, purge: noPurge })).not.toThrow();
  });
});
