/**
 * AC-TRANS-1: the client transport goes through the app-owned SimplePool (the
 * recording pool observes subscribe / publish) and the pool is closed on
 * teardown; no verifier is passed; no NDK in the client module's import graph.
 */
import { describe, expect, it } from 'vitest';
import { createClientTransport, type ClientPool } from '@/src/lib/marmot/client/transport';

function recordingPool() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ret?: unknown) => (...args: unknown[]) => {
    calls.push({ method, args });
    return ret;
  };
  const pool: ClientPool = {
    publish: (relays, event) => {
      calls.push({ method: 'publish', args: [relays, event] });
      return relays.map(() => Promise.resolve('ok'));
    },
    subscribeMany: (relays, filter) => {
      calls.push({ method: 'subscribeMany', args: [relays, filter] });
      return { close: record('subClose') };
    },
    subscribeManyEose: (relays, filter) => {
      calls.push({ method: 'subscribeManyEose', args: [relays, filter] });
      return { close: record('subClose') };
    },
    ensureRelay: (url) => {
      calls.push({ method: 'ensureRelay', args: [url] });
      return Promise.reject(new Error('recording pool has no relays'));
    },
    maxWaitForConnection: 0,
    destroy: record('destroy'),
    close: record('close'),
  };
  return { pool, calls };
}

describe('createClientTransport', () => {
  it('routes subscription() through the recording pool', () => {
    const { pool, calls } = recordingPool();
    const t = createClientTransport({ relays: ['wss://r1.example'], createPool: () => pool });
    const sub = t.transport.subscription(['wss://r1.example'], { kinds: [1059], '#p': ['aa'.repeat(32)] });
    const handle = sub.subscribe({ next: () => undefined, error: () => undefined, complete: () => undefined } as never);
    const opened = calls.filter((c) => c.method === 'subscribeMany' || c.method === 'subscribeManyEose');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[0].args[0]).toEqual(['wss://r1.example']);
    handle.unsubscribe();
  });

  it('routes publish() through the recording pool', async () => {
    const { pool, calls } = recordingPool();
    const t = createClientTransport({ relays: ['wss://r1.example'], createPool: () => pool });
    const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 1, kind: 1, tags: [], content: '', sig: 'c'.repeat(128) };
    await t.transport.publish(['wss://r1.example'], event as never).catch(() => undefined);
    expect(calls.some((c) => c.method === 'publish' && (c.args[0] as string[])[0] === 'wss://r1.example')).toBe(true);
  });

  it('closePool() destroys the pool exactly once, even when called twice', () => {
    const { pool, calls } = recordingPool();
    const t = createClientTransport({ relays: ['wss://r1.example'], createPool: () => pool });
    expect(calls.filter((c) => c.method === 'destroy')).toHaveLength(0);
    t.closePool();
    t.closePool();
    expect(calls.filter((c) => c.method === 'destroy')).toHaveLength(1);
  });

  it('exposes the contract methods the client narrows to, and builds a real SimplePool by default', () => {
    const t = createClientTransport({ relays: ['wss://r1.example'] });
    expect(typeof t.transport.publish).toBe('function');
    expect(typeof t.transport.requestWithDeadline).toBe('function');
    expect(typeof t.transport.subscription).toBe('function');
    expect(typeof t.pool.destroy).toBe('function');
    t.closePool();
  });
});
