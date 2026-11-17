// @vitest-environment node
/**
 * AC-BOOT-7: the library is constructed only inside browser effects, so merely
 * importing the client module with no `window` (SSR / static export prerender)
 * must not throw and must not touch any browser API. (`make build` is the
 * other half of this AC.)
 */
import { describe, expect, it } from 'vitest';

describe('client module import safety', () => {
  it('has no window/navigator/indexedDB in this environment', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof indexedDB).toBe('undefined');
  });

  it('importing the barrel and every client file does not throw', async () => {
    const loaders = [
      () => import('@/src/lib/marmot/client/index'),
      () => import('@/src/lib/marmot/client/createClient'),
      () => import('@/src/lib/marmot/client/signerAdapter'),
      () => import('@/src/lib/marmot/client/transport'),
      () => import('@/src/lib/marmot/client/storage'),
      () => import('@/src/lib/marmot/client/lifecycle'),
      () => import('@/src/lib/marmot/client/fifo'),
      () => import('@/src/lib/marmot/client/keyPackageEnsure'),
    ];
    for (const load of loaders) {
      await expect(load()).resolves.toBeDefined();
    }
    const barrel = await import('@/src/lib/marmot/client');
    expect(typeof barrel.bootstrapAccountClient).toBe('function');
    expect(typeof barrel.createJobQueue).toBe('function');
  });

  it('constructing nothing at import: the bootstrap refuses a secure-context-less host by returning, not throwing', async () => {
    const { bootstrapAccountClient } = await import('@/src/lib/marmot/client');
    const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
    const r = await bootstrapAccountClient({
      eventSigner: createPrivateKeySigner('66'.repeat(32)),
      signerKind: 'local',
      relays: ['wss://r.example'],
      history: { append: () => undefined, withdraw: () => undefined, list: () => [], purge: () => undefined, sweep: async () => undefined, dispose: () => undefined },
      clientEvents: {
        groupRemoved: () => undefined, inboxDisposition: () => undefined, welcomeDeclined: () => undefined,
        intentFailed: () => undefined, storeIncompatible: () => undefined, groupBranchSwitched: () => undefined,
      },
      inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
      onGroupNotification: () => undefined,
      inboxRelayList: { ensure: async () => undefined },
    });
    // Node's globalThis.isSecureContext is undefined -> the real default gate says unsupported.
    expect(r).toEqual({ status: 'unsupported', reason: 'insecure-context' });
  });
});
