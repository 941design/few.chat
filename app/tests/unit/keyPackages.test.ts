/**
 * Unit tests for keyPackages.ts — MLS KeyPackage publication / replenishment.
 *
 * Protocol-critical (kind-443 KeyPackages gate every group invite) but pure
 * dependency-injection: every function takes a KeyPackageManager, so the real
 * behaviour is exercised with a stub manager — no IDB, no network, no marmot-ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  publishKeyPackages,
  countAvailableKeyPackages,
  replenishKeyPackagesIfNeeded,
  ensureKeyPackagesOnRelays,
  countBackedKeyPackageEvents,
  KEY_PACKAGE_COUNT,
  KEY_PACKAGE_REPLENISH_THRESHOLD,
} from '@/src/lib/keyPackages';
import { DEFAULT_RELAYS } from '@/src/types';

type Pkg = { used: boolean };

function makeManager(opts: { listResult?: Pkg[]; listRejects?: boolean; createRejectAt?: number[] } = {}) {
  let createCall = -1;
  return {
    create: vi.fn(async () => {
      createCall += 1;
      if (opts.createRejectAt?.includes(createCall)) throw new Error('relay down');
    }),
    list: vi.fn(async () => {
      if (opts.listRejects) throw new Error('idb error');
      return opts.listResult ?? [];
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('publishKeyPackages', () => {
  it('publishes `count` packages and returns the success count', async () => {
    const mgr = makeManager();
    const published = await publishKeyPackages(mgr, 3, ['wss://r']);
    expect(published).toBe(3);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(3);
  });

  it('defaults to KEY_PACKAGE_COUNT packages when count is omitted', async () => {
    const mgr = makeManager();
    const published = await publishKeyPackages(mgr);
    expect(published).toBe(KEY_PACKAGE_COUNT);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(KEY_PACKAGE_COUNT);
  });

  it('marks ONLY the last package as last-resort', async () => {
    const mgr = makeManager();
    await publishKeyPackages(mgr, 3, ['wss://r']);
    const create = (mgr as unknown as { create: ReturnType<typeof vi.fn> }).create;
    expect(create.mock.calls[0][0].isLastResort).toBe(false);
    expect(create.mock.calls[1][0].isLastResort).toBe(false);
    expect(create.mock.calls[2][0].isLastResort).toBe(true);
  });

  it('passes the provided relays and the few client tag through', async () => {
    const mgr = makeManager();
    await publishKeyPackages(mgr, 1, ['wss://a', 'wss://b']);
    const arg = (mgr as unknown as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0];
    expect(arg.relays).toEqual(['wss://a', 'wss://b']);
    expect(arg.client).toBe('few');
  });

  it('defaults to DEFAULT_RELAYS when relays are omitted', async () => {
    const mgr = makeManager();
    await publishKeyPackages(mgr, 1);
    const arg = (mgr as unknown as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0];
    expect(arg.relays).toEqual([...DEFAULT_RELAYS]);
  });

  it('tolerates partial failure: a rejected create is skipped, the rest still count', async () => {
    // Reject the 2nd of 3 creates (index 1). Expect 2 successes, all 3 attempted.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = makeManager({ createRejectAt: [1] });
    const published = await publishKeyPackages(mgr, 3, ['wss://r']);
    expect(published).toBe(2);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith('[keyPackages] Failed to publish key package 2:', expect.any(Error));
    warn.mockRestore();
  });

  it('returns 0 and never calls create when count is 0', async () => {
    const mgr = makeManager();
    const published = await publishKeyPackages(mgr, 0, ['wss://r']);
    expect(published).toBe(0);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });
});

describe('countAvailableKeyPackages', () => {
  it('counts only unused packages', async () => {
    const mgr = makeManager({ listResult: [{ used: false }, { used: true }, { used: false }] });
    expect(await countAvailableKeyPackages(mgr)).toBe(2);
  });

  it('returns 0 for an empty list', async () => {
    const mgr = makeManager({ listResult: [] });
    expect(await countAvailableKeyPackages(mgr)).toBe(0);
  });

  it('returns 0 (not a throw) when list() rejects', async () => {
    const mgr = makeManager({ listRejects: true });
    await expect(countAvailableKeyPackages(mgr)).resolves.toBe(0);
  });
});

describe('replenishKeyPackagesIfNeeded', () => {
  it('does nothing when availability is AT the threshold (boundary: not < threshold)', async () => {
    const at = Array.from({ length: KEY_PACKAGE_REPLENISH_THRESHOLD }, () => ({ used: false }));
    const mgr = makeManager({ listResult: at });
    await replenishKeyPackagesIfNeeded(mgr, ['wss://r']);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('does nothing when availability is above the threshold', async () => {
    const above = Array.from({ length: KEY_PACKAGE_COUNT }, () => ({ used: false }));
    const mgr = makeManager({ listResult: above });
    await replenishKeyPackagesIfNeeded(mgr, ['wss://r']);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('publishes COUNT-available packages when below threshold (1 available -> 4 published)', async () => {
    const mgr = makeManager({ listResult: [{ used: false }] });
    await replenishKeyPackagesIfNeeded(mgr, ['wss://r']);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(
      KEY_PACKAGE_COUNT - 1,
    );
  });

  it('publishes a full batch when none are available (0 available -> COUNT published)', async () => {
    const mgr = makeManager({ listResult: [] });
    await replenishKeyPackagesIfNeeded(mgr, ['wss://r']);
    expect((mgr as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(KEY_PACKAGE_COUNT);
  });

  it('forwards relays to the publish call', async () => {
    const mgr = makeManager({ listResult: [] });
    await replenishKeyPackagesIfNeeded(mgr, ['wss://custom']);
    const arg = (mgr as unknown as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0];
    expect(arg.relays).toEqual(['wss://custom']);
  });
});

// Bug invite-fresh-peer-fails-with-has: local KeyPackages whose publish no relay
// accepted must be published again, or the account cannot be invited.
describe('ensureKeyPackagesOnRelays', () => {
  it('relays hold one of ours => no publish', async () => {
    const publish = vi.fn(async () => 5);
    await expect(ensureKeyPackagesOnRelays({ fetchOwn: async () => ({ count: 1, timedOut: false }), publish })).resolves.toBe('present');
    expect(publish).not.toHaveBeenCalled();
  });

  it('a complete fetch finds none => publishes again', async () => {
    const publish = vi.fn(async () => 5);
    await expect(ensureKeyPackagesOnRelays({ fetchOwn: async () => ({ count: 0, timedOut: false }), publish })).resolves.toBe('republished');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('a timed-out fetch proves nothing => no publish', async () => {
    const publish = vi.fn(async () => 5);
    await expect(ensureKeyPackagesOnRelays({ fetchOwn: async () => ({ count: 0, timedOut: true }), publish })).resolves.toBe('unknown');
    expect(publish).not.toHaveBeenCalled();
  });

  it('a fetch that timed out but found one of ours => present, no publish', async () => {
    const publish = vi.fn(async () => 5);
    await expect(ensureKeyPackagesOnRelays({ fetchOwn: async () => ({ count: 2, timedOut: true }), publish })).resolves.toBe('present');
    expect(publish).not.toHaveBeenCalled();
  });

  it('a failing fetch => no publish, no throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publish = vi.fn(async () => 5);
    await expect(ensureKeyPackagesOnRelays({ fetchOwn: async () => { throw new Error('offline'); }, publish })).resolves.toBe('unknown');
    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[keyPackages] relay check failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('a failing republish does not throw => failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ensureKeyPackagesOnRelays({
      fetchOwn: async () => ({ count: 0, timedOut: false }),
      publish: async () => { throw new Error('signer locked'); },
    })).resolves.toBe('failed');
    expect(warn).toHaveBeenCalledWith('[keyPackages] republish failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('a republish that published nothing => failed', async () => {
    await expect(ensureKeyPackagesOnRelays({
      fetchOwn: async () => ({ count: 0, timedOut: false }),
      publish: async () => 0,
    })).resolves.toBe('failed');
  });
});

describe('countBackedKeyPackageEvents', () => {
  const local = [{ published: [{ id: 'a' }, { id: 'b' }] }, { published: undefined }, { published: [{ id: 'c' }] }];

  it('an event no local KeyPackage backs does not count', () => {
    expect(countBackedKeyPackageEvents([{ id: 'x' }], local)).toBe(0);
  });

  it('counts each backed event, across packages', () => {
    expect(countBackedKeyPackageEvents([{ id: 'a' }, { id: 'x' }, { id: 'c' }], local)).toBe(2);
  });

  it('no local packages or an event without id => 0', () => {
    expect(countBackedKeyPackageEvents([{ id: 'a' }], [])).toBe(0);
    expect(countBackedKeyPackageEvents([{}], local)).toBe(0);
  });
});

describe('publishKeyPackages with count 1', () => {
  it('publishes one reusable last-resort KeyPackage (the startup republish relies on it)', async () => {
    const m = makeManager();
    await expect(publishKeyPackages(m as never, 1, ['wss://r'])).resolves.toBe(1);
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ isLastResort: true, relays: ['wss://r'] }));
  });
});
