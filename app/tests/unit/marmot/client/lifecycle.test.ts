/** AC-BOOT-3: teardown is client.dispose() then stores.close(); runs every step; idempotent. */
import { describe, expect, it } from 'vitest';
import { createTeardown } from '@/src/lib/marmot/client/lifecycle';

function parts(log: string[], opts: { disposeThrows?: boolean } = {}) {
  return {
    client: { dispose: () => { log.push('client.dispose'); if (opts.disposeThrows) throw new Error('dispose failed'); } },
    stores: { close: async () => { log.push('stores.close'); } },
    closePool: () => { log.push('pool.close'); },
    queue: { dispose: () => { log.push('queue.dispose'); } },
    history: { dispose: () => { log.push('history.dispose'); } },
    unsubscribers: [() => log.push('unsub1'), () => log.push('unsub2')],
  };
}

describe('createTeardown', () => {
  it('awaits an async history.dispose (drain) before client.dispose, keeping the contract order', async () => {
    const log: string[] = [];
    const p = parts(log);
    p.history = {
      dispose: async () => {
        log.push('history.dispose:start');
        await new Promise((r) => setTimeout(r, 20));
        log.push('history.dispose:end');
      },
    } as never;
    await createTeardown(p)();
    expect(log).toEqual(['queue.dispose', 'unsub1', 'unsub2', 'history.dispose:start', 'history.dispose:end', 'client.dispose', 'stores.close', 'pool.close']);
  });

  it('still runs client.dispose, stores.close and pool when history.dispose rejects, and rethrows', async () => {
    const log: string[] = [];
    const p = parts(log);
    p.history = { dispose: async () => { throw new Error('drain failed'); } } as never;
    await expect(createTeardown(p)()).rejects.toThrow('drain failed');
    expect(log).toEqual(['queue.dispose', 'unsub1', 'unsub2', 'client.dispose', 'stores.close', 'pool.close']);
  });

  it('disposes the client strictly before closing the stores, then the pool', async () => {
    const log: string[] = [];
    await createTeardown(parts(log))();
    expect(log).toEqual(['queue.dispose', 'unsub1', 'unsub2', 'history.dispose', 'client.dispose', 'stores.close', 'pool.close']);
    expect(log.indexOf('client.dispose')).toBeLessThan(log.indexOf('stores.close'));
  });

  it('still closes the stores and pool when dispose throws, then rethrows the first error', async () => {
    const log: string[] = [];
    await expect(createTeardown(parts(log, { disposeThrows: true }))()).rejects.toThrow('dispose failed');
    expect(log).toContain('stores.close');
    expect(log).toContain('pool.close');
  });

  it('is idempotent: a second call does not repeat any step', async () => {
    const log: string[] = [];
    const teardown = createTeardown(parts(log));
    await teardown();
    await teardown();
    expect(log.filter((l) => l === 'client.dispose')).toHaveLength(1);
    expect(log.filter((l) => l === 'stores.close')).toHaveLength(1);
  });
});
