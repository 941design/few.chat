import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const provider = readFileSync('src/context/MarmotContext.tsx', 'utf8');
const settings = readFileSync('pages/settings.tsx', 'utf8');
function compile(source: string, names: string[], values: unknown[]) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...names, js)(...values);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function harness({ signerMode = 'local', signerAccountPubkey = null as string | null, owner = 'a' } = {}) {
  const resolvedAccount = { current: owner as string | null };
  const wipeIdentityKey = `${signerMode}:a:${signerAccountPubkey ?? ''}`;
  const wipeIdentity = { current: wipeIdentityKey };
  const lifecycle = { stop: vi.fn(async () => {}) };
  const activeLifecycle = { current: lifecycle as typeof lifecycle | null };
  const explicitWipe = { current: null };
  const account = { current: { handle: { leaseHeld: () => true } } as { handle: { leaseHeld: () => boolean } } | null };
  const current = { current: {} as object | null };
  const deviceResetGeneration = 'original';
  const deviceGeneration = { current: deviceResetGeneration };
  const getDeviceResetGeneration = () => deviceGeneration.current;
  const persistedSigner = { mode: signerMode, owner };
  const isStoredWipeAccount = (mode: string, requestedOwner: string) => persistedSigner.mode === mode && persistedSigner.owner === requestedOwner;
  const close = vi.fn(async () => {});
  const stores = { close, lease: { held: true }, account: { account: owner } };
  const openAccountStores = vi.fn(async () => ({ status: 'opened', stores }));
  const wipeApplicationGroups = vi.fn(async () => {});
  const restartLifecycle = vi.fn();
  const resetAppData = vi.fn(async () => {});
  const refs = { pubkeyHex: 'a', signerMode, signerAccountPubkey, resolvedAccount, wipeIdentity, wipeIdentityKey, activeLifecycle, explicitWipe, account, current, openAccountStores, wipeApplicationGroups, restartLifecycle, deviceResetGeneration, getDeviceResetGeneration, isStoredWipeAccount, clearAllGroupData: vi.fn(), setSession: vi.fn(), setStatus: vi.fn(), setUnavailableReason: vi.fn(), useCallback: (f: unknown) => f };
  const body = provider.slice(provider.indexOf('  const wipeLocalGroups = useCallback'), provider.indexOf('  const sendGroupNotice'));
  const wipeLocalGroups = compile(`${body}\nreturn wipeLocalGroups;`, Object.keys(refs), Object.values(refs)) as (reset: () => Promise<void>) => Promise<void>;
  const wipe = () => wipeLocalGroups(resetAppData);
  const closeBody = provider.slice(provider.indexOf('          async beforeStoresClose(stores) {'), provider.indexOf('          clientEvents:', provider.indexOf('          async beforeStoresClose(stores) {')));
  const hookRefs = { ...refs, lifecycle, live: true };
  const beforeClose = compile(`return ({ ${closeBody} }).beforeStoresClose;`, Object.keys(hookRefs), Object.values(hookRefs)) as (value: typeof stores) => Promise<void>;
  return { wipe, beforeClose, resolvedAccount, wipeIdentity, lifecycle, activeLifecycle, explicitWipe, account, openAccountStores, wipeApplicationGroups, restartLifecycle, resetAppData, deviceGeneration, persistedSigner, stores, close };
}

describe('wipe handoffs', () => {
  it('closes preopened stores and refuses a changed account', async () => {
    const h = harness(); h.account.current = null;
    const wait = deferred<any>(); h.openAccountStores.mockReturnValueOnce(wait.promise);
    const result = h.wipe(); h.resolvedAccount.current = 'b'; wait.resolve({ status: 'opened', stores: h.stores });
    await expect(result).rejects.toThrow('account changed');
    expect(h.close).toHaveBeenCalledOnce(); expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
  });
  it('refuses a replaced lifecycle after stop', async () => {
    const h = harness(); const wait = deferred<void>(); h.lifecycle.stop.mockReturnValueOnce(wait.promise);
    const result = h.wipe(); h.activeLifecycle.current = null; wait.resolve();
    await expect(result).rejects.toThrow('account changed'); expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
    expect(h.restartLifecycle).not.toHaveBeenCalled();
  });
  it('wipes the stored identity without requiring the signer to resolve', async () => {
    const h = harness();
    h.account.current = null;
    h.activeLifecycle.current = null;
    h.resolvedAccount.current = null;

    await h.wipe();

    expect(h.openAccountStores).toHaveBeenCalledExactlyOnceWith('a');
    expect(h.wipeApplicationGroups).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.restartLifecycle).not.toHaveBeenCalled();
  });
  it('restarts the stopped lifecycle after a failed clear and lease release', async () => {
    const h = harness();
    h.wipeApplicationGroups.mockRejectedValueOnce(new Error('IDB clear failed'));
    h.restartLifecycle.mockImplementation(() => {
      expect(h.close).toHaveBeenCalledOnce();
      expect(h.explicitWipe.current).toBeNull();
    });

    await expect(h.wipe()).rejects.toThrow('IDB clear failed');

    expect(h.lifecycle.stop).toHaveBeenCalledOnce();
    expect(h.restartLifecycle).toHaveBeenCalledOnce();
  });
  it('wipes the verified offline remote account and keeps its lease through app reset', async () => {
    const h = harness({ signerMode: 'nip46', signerAccountPubkey: 'remote', owner: 'remote' });
    h.account.current = null;
    h.activeLifecycle.current = null;
    h.resolvedAccount.current = null;
    h.resetAppData.mockImplementationOnce(async () => {
      expect(h.wipeApplicationGroups).toHaveBeenCalledWith(h.stores, expect.any(Function));
      expect(h.close).not.toHaveBeenCalled();
    });
    await h.wipe();
    expect(h.openAccountStores).toHaveBeenCalledExactlyOnceWith('remote');
    expect(h.resetAppData).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('rejects an offline unbound remote account without wiping the local profile identity', async () => {
    const h = harness({ signerMode: 'nip07' });
    h.resolvedAccount.current = null;
    await expect(h.wipe()).rejects.toThrow('Reconnect the signer');
    expect(h.openAccountStores).not.toHaveBeenCalled();
    expect(h.resetAppData).not.toHaveBeenCalled();
  });
  it('refuses a second wipe if another tab completed a reset while the lease was pending', async () => {
    const h = harness();
    h.account.current = null;
    const lease = deferred<any>();
    h.openAccountStores.mockReturnValueOnce(lease.promise);
    const queuedWipe = h.wipe();
    h.deviceGeneration.current = 'reset-in-another-tab';
    lease.resolve({ status: 'opened', stores: h.stores });
    await expect(queuedWipe).rejects.toThrow('already reset');
    expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
    expect(h.resetAppData).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('refuses an old offline signer binding if another tab saved a different account while the lease was pending', async () => {
    const h = harness({ signerMode: 'nip46', signerAccountPubkey: 'remote', owner: 'remote' });
    h.account.current = null;
    h.resolvedAccount.current = null;
    const lease = deferred<any>();
    h.openAccountStores.mockReturnValueOnce(lease.promise);
    const queuedWipe = h.wipe();
    h.persistedSigner.owner = 'replacement';
    lease.resolve({ status: 'opened', stores: h.stores });
    await expect(queuedWipe).rejects.toThrow('stored signer account changed');
    expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
    expect(h.resetAppData).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('accepts the generation update made by its own completed device reset', async () => {
    const h = harness();
    h.resetAppData.mockImplementationOnce(async () => { h.deviceGeneration.current = 'current-reset'; });
    await expect(h.wipe()).resolves.toBeUndefined();
    expect(h.restartLifecycle).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('closes fallback stores when the lifecycle changes during acquisition', async () => {
    const h = harness(); const wait = deferred<any>(); h.openAccountStores.mockReturnValueOnce(wait.promise);
    const result = h.wipe(); await Promise.resolve(); h.activeLifecycle.current = null; wait.resolve({ status: 'opened', stores: h.stores });
    await expect(result).rejects.toThrow('account changed'); expect(h.close).toHaveBeenCalledOnce(); expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
  });
  it('rejects stale teardown and never applies the wipe', async () => {
    const h = harness();
    h.lifecycle.stop.mockImplementationOnce(async () => {
      h.activeLifecycle.current = null;
      await h.beforeClose(h.stores);
    });
    await expect(h.wipe()).rejects.toThrow('account changed');
    expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
    expect(h.resetAppData).not.toHaveBeenCalled();
  });
  it('rejects if the account changes during teardown wipe', async () => {
    const h = harness();
    h.lifecycle.stop.mockImplementationOnce(() => h.beforeClose(h.stores));
    const wait = deferred<void>();
    h.wipeApplicationGroups.mockReturnValueOnce(wait.promise);
    const result = h.wipe();
    h.resolvedAccount.current = 'b';
    wait.resolve();
    await expect(result).rejects.toThrow('account changed');
    expect(h.resetAppData).not.toHaveBeenCalled();
  });
  it('resets app data inside the held client teardown, with no new lease acquisition', async () => {
    const h = harness();
    h.lifecycle.stop.mockImplementationOnce(async () => {
      await h.beforeClose(h.stores);
      expect(h.resetAppData).toHaveBeenCalledOnce();
      await h.close();
    });
    await h.wipe();
    expect(h.openAccountStores).not.toHaveBeenCalled();
    expect(h.resetAppData).toHaveBeenCalledOnce();
  });
  it('rejects if the lifecycle changes while the fallback wipe is in progress', async () => {
    const h = harness(); const wait = deferred<void>(); h.wipeApplicationGroups.mockReturnValueOnce(wait.promise);
    const result = h.wipe(); await Promise.resolve(); await Promise.resolve();
    h.activeLifecycle.current = null; wait.resolve();
    await expect(result).rejects.toThrow('account changed'); expect(h.close).toHaveBeenCalledOnce();
  });
  it('rejects if the lifecycle changes while stores close', async () => {
    const h = harness(); const wait = deferred<void>(); h.close.mockReturnValueOnce(wait.promise);
    const result = h.wipe();
    while (!h.close.mock.calls.length) await Promise.resolve();
    h.activeLifecycle.current = null; wait.resolve();
    await expect(result).rejects.toThrow('account changed');
  });
  it('completes a current wipe and rejects a concurrent one', async () => {
    const h = harness(); const wait = deferred<void>(); h.lifecycle.stop.mockReturnValueOnce(wait.promise);
    const first = h.wipe(); await expect(h.wipe()).rejects.toThrow('already in progress'); wait.resolve();
    await expect(first).resolves.toBeUndefined(); expect(h.wipeApplicationGroups).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('settings reset handoff', () => {
  it('does not reset when the identity changes during the group wipe', async () => {
    const start = settings.indexOf('                            const identity = wipeIdentity.current;', settings.indexOf('data-testid="danger-zone-wipe-btn"'));
    const end = settings.indexOf('\n                          }}', start);
    const body = settings.slice(start, end);
    const identity = { current: {} as object }; const mounted = { current: true };
    const wait = deferred<void>(); const reset = vi.fn(async () => {}); const reload = vi.fn(); const toast = vi.fn();
    const refs = { wipeIdentity: identity, wipePageMounted: mounted, wipeLocalGroups: async (finish: () => Promise<void>) => { await wait.promise; await finish(); }, resetAllData: reset, window: { location: { reload } }, toast, copy: { advanced: { dangerZone: { wipeError: 'error' } } }, console: { warn: vi.fn() } };
    const run = compile(`return async () => { ${body} };`, Object.keys(refs), Object.values(refs)) as () => Promise<void>;
    const result = run(); identity.current = {}; wait.resolve(); await result;
    expect(reset).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(toast).toHaveBeenCalledOnce();
  });
});

describe('relay settings handoff', () => {
  it.each([true, false])('uses an unchanged save to retry discovery on the leased client (historical pending %s)', async (pending) => {
    const relays = ['wss://configured.example'];
    const retryLegacyInboxDiscovery = vi.fn(async () => {});
    const setRelays = vi.fn();
    const refs = {
      resolvedAccount: { current: 'a' },
      relayChange: { current: null },
      retryRelayChange: { current: null },
      effectiveRelays: { current: relays },
      account: { current: {
        handle: { leaseHeld: () => true },
        legacyInboxDiscoveryPending: pending,
        ensure: { inboxRelayList: 'failed' },
        retryLegacyInboxDiscovery,
      } },
      setRelays,
      useCallback: (f: unknown) => f,
    };
    const body = provider.slice(provider.indexOf('  const rebuildForRelays = useCallback'), provider.indexOf('  const wipeLocalGroups = useCallback'));
    const save = compile(`${body}\nreturn rebuildForRelays;`, Object.keys(refs), Object.values(refs)) as (next: string[]) => Promise<void>;
    await save(relays);
    expect(retryLegacyInboxDiscovery).toHaveBeenCalledOnce();
    expect(setRelays).not.toHaveBeenCalled();
  });

  it.each(['rotation', 'inbox'] as const)('handles unchanged saves after a partial %s failure', async (failedStep) => {
    const former = ['wss://old.example'];
    const next = ['wss://new.example'];
    const resolvedAccount = { current: 'a' };
    const relayChange = { current: null as { previousRelays: string[] } | null };
    const retryRelayChange = { current: null };
    const effectiveRelays = { current: former };
    const account = { current: null as { handle: { leaseHeld(): boolean }; ensure: { inboxRelayList: string } } | null };
    const setRelays = vi.fn();
    const saveBody = provider.slice(provider.indexOf('  const rebuildForRelays = useCallback'), provider.indexOf('  const wipeLocalGroups = useCallback'));
    const refs = { resolvedAccount, relayChange, retryRelayChange, effectiveRelays, account, setRelays, useCallback: (f: unknown) => f };
    const save = compile(`${saveBody}\nreturn rebuildForRelays;`, Object.keys(refs), Object.values(refs)) as (relays: string[]) => Promise<void>;
    const rebuild = vi.fn(async () => ({
      bootstrap: { status: 'ready', account: { ensure: { keyPackage: 'present' } } },
      rotationErrors: failedStep === 'rotation' ? [new Error('rotation failed')] : [],
      inboxRelayListFailure: failedStep === 'inbox' ? { error: new Error('lookup incomplete') } : undefined,
    }));
    const bootstrap = vi.fn(async () => ({ status: 'ready' }));
    const startBegin = provider.indexOf('      async start(input) {', provider.indexOf('const lifecycle = startAccountLifecycle'));
    const startBody = provider.slice(startBegin, provider.indexOf('      makeInput(signal)', startBegin));

    await save(former);
    expect(setRelays).not.toHaveBeenCalled();
    const result = save(next);
    const failure = expect(result).rejects.toThrow('Group relay update was incomplete');
    expect(save(next)).toBe(result);
    expect(setRelays).toHaveBeenCalledOnce();

    const ports = { relayChange, retryRelayChange, changes: relayChange.current, prior: Promise.resolve(), rebuildAccountForRelays: rebuild, bootstrapAccountClient: bootstrap };
    const start = compile(`return ({ ${startBody} }).start;`, Object.keys(ports), Object.values(ports)) as (input: object) => Promise<unknown>;
    await start({});
    await failure;
    await start({});
    expect(rebuild).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();

    effectiveRelays.current = next;
    account.current = { handle: { leaseHeld: () => true }, ensure: { inboxRelayList: 'ok' } };
    const unchanged = save(next);
    if (failedStep === 'inbox') {
      await unchanged;
      expect(setRelays).toHaveBeenCalledOnce();
      expect(relayChange.current).toBeNull();
    } else {
      expect(setRelays).toHaveBeenCalledTimes(2);
      expect(relayChange.current?.previousRelays).toEqual([...next, ...former]);
    }
  });
});
