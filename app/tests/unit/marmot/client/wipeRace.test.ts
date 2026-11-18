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
function harness() {
  const resolvedAccount = { current: 'a' as string | null };
  const lifecycle = { stop: vi.fn(async () => {}) };
  const activeLifecycle = { current: lifecycle as typeof lifecycle | null };
  const explicitWipe = { current: null as string | null };
  const explicitWipeCompleted = { current: false };
  const explicitWipeError = { current: undefined as unknown };
  const account = { current: { handle: { leaseHeld: () => true } } as { handle: { leaseHeld: () => boolean } } | null };
  const current = { current: {} as object | null };
  const close = vi.fn(async () => {});
  const stores = { close, lease: { held: true }, account: { account: 'a' } };
  const openAccountStores = vi.fn(async () => ({ status: 'opened', stores }));
  const wipeApplicationGroups = vi.fn(async () => {});
  const refs = { pubkeyHex: 'a', resolvedAccount, activeLifecycle, explicitWipe, explicitWipeCompleted, explicitWipeError, account, current, openAccountStores, wipeApplicationGroups, clearAllGroupData: vi.fn(), setSession: vi.fn(), useCallback: (f: unknown) => f };
  const body = provider.slice(provider.indexOf('  const wipeLocalGroups = useCallback'), provider.indexOf('  const sendGroupNotice'));
  const wipe = compile(`${body}\nreturn wipeLocalGroups;`, Object.keys(refs), Object.values(refs)) as () => Promise<void>;
  const closeBody = provider.slice(provider.indexOf('          async beforeStoresClose(stores) {'), provider.indexOf('          clientEvents:', provider.indexOf('          async beforeStoresClose(stores) {')));
  const hookRefs = { ...refs, lifecycle, live: true };
  const beforeClose = compile(`return ({ ${closeBody} }).beforeStoresClose;`, Object.keys(hookRefs), Object.values(hookRefs)) as (value: typeof stores) => Promise<void>;
  return { wipe, beforeClose, resolvedAccount, lifecycle, activeLifecycle, explicitWipe, explicitWipeCompleted, account, openAccountStores, wipeApplicationGroups, stores, close };
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
  });
  it('closes fallback stores when the lifecycle changes during acquisition', async () => {
    const h = harness(); const wait = deferred<any>(); h.openAccountStores.mockReturnValueOnce(wait.promise);
    const result = h.wipe(); await Promise.resolve(); h.activeLifecycle.current = null; wait.resolve({ status: 'opened', stores: h.stores });
    await expect(result).rejects.toThrow('account changed'); expect(h.close).toHaveBeenCalledOnce(); expect(h.wipeApplicationGroups).not.toHaveBeenCalled();
  });
  it('rejects stale teardown and never applies the wipe', async () => {
    const h = harness(); h.explicitWipe.current = 'a'; h.activeLifecycle.current = null;
    await expect(h.beforeClose(h.stores)).rejects.toThrow('account changed');
    expect(h.wipeApplicationGroups).not.toHaveBeenCalled(); expect(h.explicitWipeCompleted.current).toBe(false);
  });
  it('rejects if the account changes during teardown wipe', async () => {
    const h = harness(); h.explicitWipe.current = 'a'; const wait = deferred<void>(); h.wipeApplicationGroups.mockReturnValueOnce(wait.promise);
    const result = h.beforeClose(h.stores); h.resolvedAccount.current = 'b'; wait.resolve();
    await expect(result).rejects.toThrow('account changed'); expect(h.explicitWipeCompleted.current).toBe(false);
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
    const refs = { wipeIdentity: identity, wipePageMounted: mounted, wipeLocalGroups: () => wait.promise, resetAllData: reset, window: { location: { reload } }, toast, copy: { advanced: { dangerZone: { wipeError: 'error' } } }, console: { warn: vi.fn() } };
    const run = compile(`return async () => { ${body} };`, Object.keys(refs), Object.values(refs)) as () => Promise<void>;
    const result = run(); identity.current = {}; wait.resolve(); await result;
    expect(reset).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(toast).toHaveBeenCalledOnce();
  });
});
