// @vitest-environment node
/** openAccountStores maps a host without IndexedDB / Web Locks to a typed result, never a raw throw. */
import { describe, expect, it } from 'vitest';
import { MarmotError } from '@941design/marmot';
import { openAccountStores } from '@/src/lib/marmot/client/storage';

describe('openAccountStores', () => {
  it('default backend in a host without IndexedDB / Web Locks -> unsupported/storage', async () => {
    expect(typeof indexedDB).toBe('undefined');
    await expect(openAccountStores('a'.repeat(64))).resolves.toEqual({ status: 'unsupported', reason: 'storage' });
  });

  it('lease-held stays a value', async () => {
    const backend = { openForWrite: async () => { throw new MarmotError('lease-held', 'held'); } };
    await expect(openAccountStores('p', backend as never)).resolves.toEqual({ status: 'lease-held' });
  });

  it('invalid-options from openForWrite is a caller error and rejects, not unsupported', async () => {
    const backend = { openForWrite: async () => { throw new MarmotError('invalid-options', 'bad pubkey'); } };
    await expect(openAccountStores('NPUB1X', backend as never)).rejects.toMatchObject({ code: 'invalid-options' });
  });

  it('other errors still propagate', async () => {
    const backend = { openForWrite: async () => { throw new Error('boom'); } };
    await expect(openAccountStores('p', backend as never)).rejects.toThrow('boom');
  });
});
