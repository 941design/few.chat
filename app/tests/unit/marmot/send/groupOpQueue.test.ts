// @vitest-environment node
/**
 * AC-SEND-5: at most one commit op in flight per group (two concurrent invites on one group serialise: the
 * second starts after the first settles), `group.synced()` awaited before invite / removeMember / setAdmins /
 * rename / leave, and a `commit-pending` rejection retried after `synced()`.
 */
import { describe, expect, it } from 'vitest';
import { createGroupOpQueue } from '@/src/lib/marmot/send';

type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const commitPending = () => Object.assign(new Error('commit-pending'), { code: 'commit-pending', details: { reason: 'awaiting-sync' } });

/** A stub group recording the order of synced / op calls; every op is controllable. */
function stubGroup(id = 'g1') {
  const log: string[] = [];
  const gates = new Map<string, Deferred<unknown>[]>();
  const op = (name: string) =>
    (...args: unknown[]) => {
      log.push(`${name}:start:${JSON.stringify(args)}`);
      const d = deferred<unknown>();
      (gates.get(name) ?? gates.set(name, []).get(name)!).push(d);
      return d.promise.finally(() => void log.push(`${name}:end`));
    };
  const syncedGate: Deferred[] = [];
  return {
    log,
    gates,
    syncedGate,
    group: {
      id,
      synced: () => {
        log.push('synced');
        const d = deferred();
        syncedGate.push(d);
        return d.promise;
      },
      invite: op('invite'),
      removeMember: op('removeMember'),
      setAdmins: op('setAdmins'),
      rename: op('rename'),
      leave: op('leave'),
    },
  };
}

describe('serialisation: one commit op in flight per group', () => {
  it('two concurrent invites on one group: the second starts only after the first settled', async () => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    const first = q.invite(s.group, ['kp1'] as never);
    const second = q.invite(s.group, ['kp2'] as never);
    await tick();
    s.syncedGate[0].resolve(); // first synced
    await tick();
    expect(s.log.filter((l) => l.startsWith('invite:start'))).toEqual(['invite:start:[["kp1"]]']);
    expect(s.log).not.toContain('invite:start:[["kp2"]]');
    s.gates.get('invite')![0].resolve([{ status: 'delivered' }]);
    await expect(first).resolves.toEqual([{ status: 'delivered' }]);
    await tick();
    s.syncedGate[1].resolve();
    await tick();
    expect(s.log.indexOf('invite:end')).toBeLessThan(s.log.indexOf('invite:start:[["kp2"]]'));
    s.gates.get('invite')![1].resolve([]);
    await expect(second).resolves.toEqual([]);
  });

  it('a failed first op does not stall or poison the second', async () => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    const first = q.rename(s.group, 'A' as never);
    const second = q.rename(s.group, 'B' as never);
    const firstSettled = first.then(() => 'ok', (e) => (e as Error).message);
    await tick();
    s.syncedGate[0].resolve();
    await tick();
    s.gates.get('rename')![0].reject(new Error('boom'));
    expect(await firstSettled).toBe('boom');
    await tick();
    s.syncedGate[1].resolve();
    await tick();
    s.gates.get('rename')![1].resolve('renamed');
    await expect(second).resolves.toBe('renamed');
  });

  it('different groups do not wait for each other', async () => {
    const q = createGroupOpQueue();
    const a = stubGroup('ga');
    const b = stubGroup('gb');
    void q.invite(a.group, ['x'] as never);
    void q.invite(b.group, ['y'] as never);
    await tick();
    a.syncedGate[0].resolve();
    b.syncedGate[0].resolve();
    await tick();
    expect(a.log).toContain('invite:start:[["x"]]');
    expect(b.log).toContain('invite:start:[["y"]]');
  });

  it('different op kinds on one group serialise too (rename waits for an in-flight invite)', async () => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    void q.invite(s.group, ['kp'] as never);
    void q.rename(s.group, 'N' as never);
    await tick();
    s.syncedGate[0].resolve();
    await tick();
    expect(s.log.some((l) => l.startsWith('rename:start'))).toBe(false);
    s.gates.get('invite')![0].resolve([]);
    await tick();
    s.syncedGate[1].resolve();
    await tick();
    expect(s.log.some((l) => l.startsWith('rename:start'))).toBe(true);
  });
});

describe('synced() is awaited before the commit ops', () => {
  it.each(['invite', 'removeMember', 'setAdmins', 'rename', 'leave'] as const)('%s does not start before synced() resolves', async (name) => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    const call = (q[name] as (g: unknown, ...a: unknown[]) => Promise<unknown>)(s.group, 'arg');
    await tick();
    expect(s.log).toEqual(['synced']); // the op has NOT started
    s.syncedGate[0].resolve();
    await tick();
    expect(s.log[1]).toBe(`${name}:start:["arg"]`);
    s.gates.get(name)![0].resolve(name);
    await expect(call).resolves.toBe(name);
  });

  it('a rejecting synced() (fenced / not-a-member) rejects the op without running it', async () => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    const call = q.leave(s.group);
    await tick();
    s.syncedGate[0].reject(Object.assign(new Error('fenced'), { code: 'fenced' }));
    await expect(call).rejects.toThrow('fenced');
    expect(s.log.some((l) => l.startsWith('leave:start'))).toBe(false);
  });
});

describe('commit-pending is retried after synced()', () => {
  it('a commit-pending rejection from the stub is retried once synced() settles again, and the retry result is returned', async () => {
    const q = createGroupOpQueue();
    const s = stubGroup();
    const call = q.invite(s.group, ['kp'] as never);
    await tick();
    s.syncedGate[0].resolve();
    await tick();
    s.gates.get('invite')![0].reject(commitPending());
    await tick();
    expect(s.log.filter((l) => l === 'synced')).toHaveLength(2); // synced() awaited again before the retry
    expect(s.gates.get('invite')).toHaveLength(1); // not retried yet
    s.syncedGate[1].resolve();
    await tick();
    expect(s.gates.get('invite')).toHaveLength(2);
    s.gates.get('invite')![1].resolve([{ status: 'delivered' }]);
    await expect(call).resolves.toEqual([{ status: 'delivered' }]);
  });

  it('the retry is bounded: the commit-pending error surfaces after maxCommitPendingRetries', async () => {
    const q = createGroupOpQueue({ maxCommitPendingRetries: 2 });
    let calls = 0;
    const group = { id: 'g', synced: async () => undefined, invite: async () => { calls += 1; throw commitPending(); } };
    await expect(q.invite(group)).rejects.toMatchObject({ code: 'commit-pending' });
    expect(calls).toBe(3); // first try + 2 retries
  });

  it('any other error is thrown unchanged and NOT retried', async () => {
    const q = createGroupOpQueue();
    let calls = 0;
    const failure = Object.assign(new Error('nope'), { code: 'not-a-member' });
    const group = { id: 'g', synced: async () => undefined, removeMember: async () => { calls += 1; throw failure; } };
    await expect(q.removeMember(group)).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('serialisation holds across the retry: a queued op waits for the retried op', async () => {
    const q = createGroupOpQueue();
    const order: string[] = [];
    let attempt = 0;
    const group = {
      id: 'g',
      synced: async () => undefined,
      invite: async () => {
        order.push(`invite${++attempt}`);
        if (attempt === 1) throw commitPending();
        return 'done';
      },
      rename: async () => {
        order.push('rename');
        return 'renamed';
      },
    };
    await Promise.all([q.invite(group), q.rename(group)]);
    expect(order).toEqual(['invite1', 'invite2', 'rename']);
  });
});

describe('run (the seam shape) and validation', () => {
  it('run serialises per groupId and returns the op result', async () => {
    const q = createGroupOpQueue();
    const order: string[] = [];
    const gate = deferred();
    const a = q.run('g', async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
      return 1;
    });
    const b = q.run('g', async () => {
      order.push('b');
      return 2;
    });
    await tick();
    expect(order).toEqual(['a:start']);
    gate.resolve();
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('is loud on bad input', () => {
    const q = createGroupOpQueue();
    expect(() => q.run('', async () => 1)).toThrow(TypeError);
    expect(() => q.run('g', undefined as never)).toThrow(TypeError);
    expect(() => q.runCommit({ id: 'g' } as never, async () => 1)).toThrow(TypeError);
    expect(() => createGroupOpQueue({ maxCommitPendingRetries: -1 })).toThrow(TypeError);
    expect(() => createGroupOpQueue({ maxCommitPendingRetries: 1.5 })).toThrow(TypeError);
  });
});
