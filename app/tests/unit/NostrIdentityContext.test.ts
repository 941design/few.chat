import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { NostrIdentityProvider } from '@/src/context/NostrIdentityContext';
import { buildNip46PermsParam, loadVerifiedNip46Account } from '@/src/lib/nip46Perms';
import { STORAGE_KEYS } from '@/src/types';

const localAccount = 'aa'.repeat(32);
const bunkerAccount = 'bb'.repeat(32);
const bunkerKey = new Uint8Array(32).fill(3);
const bunkerEndpoint = getPublicKey(bunkerKey);
const extensionAccount = 'dd'.repeat(32);
const otherExtensionAccount = 'ee'.repeat(32);
const payload = JSON.stringify({
  type: 'nip46',
  payload: { userPubkey: localAccount, bunkerPubkey: bunkerEndpoint },
});

const signers = vi.hoisted(() => ({
  restoreBunker: vi.fn(),
  connectBunker: vi.fn(),
  bunkerReady: vi.fn(),
  extensionReady: vi.fn(),
  apply: vi.fn(),
  release: vi.fn(),
  loadIdentity: vi.fn(),
  generateIdentity: vi.fn(),
  derivePubkey: vi.fn(),
  saveIdentity: vi.fn(),
  resetGeneration: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKKind: { NostrConnect: 24133 },
  NDKNip46Signer: { fromPayload: signers.restoreBunker, bunker: signers.connectBunker },
  NDKNip07Signer: class {
    pubkey = '';
    async blockUntilReady() { this.pubkey = await signers.extensionReady(); }
  },
}));

vi.mock('@/src/lib/ndkClient', () => ({
  connectNdk: async () => ({}),
  getNdkInstance: () => ({}),
  applyNdkSigner: signers.apply,
  releaseNdkExternalSigner: signers.release,
}));

vi.mock('@/src/lib/marmot/signerAdapter', () => ({
  createNip07EventSigner: vi.fn(),
  createNip46EventSigner: vi.fn(),
  activeEventSignerOverride: { current: null },
}));

vi.mock('@/src/lib/nostrKeys', () => ({
  loadStoredIdentity: signers.loadIdentity,
  generateIdentityFromSeed: signers.generateIdentity,
  derivePublicKeyHex: signers.derivePubkey,
  saveStoredIdentity: signers.saveIdentity,
  pubkeyToNpub: (key: string) => key,
}));

vi.mock('@/src/lib/backup/suspension', () => ({ detachBackupForReplace: vi.fn() }));
vi.mock('@/src/lib/storage', () => ({ getDeviceResetGeneration: signers.resetGeneration }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn() };
});

// Run the provider's mount effect and preserve its state/ref slots across reads.
function mountIdentity() {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effect: () => void | (() => void) = () => {};
  vi.mocked(useState).mockImplementation(((initial: unknown) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], (next: unknown) => { states[index] = next; }];
  }) as typeof useState);
  vi.mocked(useRef).mockImplementation((initial) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }));
  vi.mocked(useEffect).mockImplementation((fn) => { effect = fn; });

  function read() {
    stateIndex = 0;
    refIndex = 0;
    return NostrIdentityProvider({ children: null }).props.value as ReturnType<typeof import('@/src/context/NostrIdentityContext').useNostrIdentity>;
  }

  read();
  return { read, unmount: effect() };
}

describe('verified signer account binding', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signers.loadIdentity.mockReturnValue({ pubkeyHex: localAccount, privateKeyHex: 'local-private-key' });
    signers.resetGeneration.mockReturnValue(null);
    const values = new Map<string, string>([[STORAGE_KEYS.nostrIdentity, 'stored-local-key']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('window', {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    signers.request.mockImplementation(async (_recipient, _method, _params, kind, reply) => {
      const event = finalizeEvent({ kind, created_at: 1, tags: [], content: 'encrypted RPC reply' }, bunkerKey);
      reply({ result: bunkerAccount, event: { rawEvent: () => ({ ...event }) } });
    });
    const bunker = {
      userPubkey: bunkerAccount,
      bunkerPubkey: bunkerEndpoint,
      rpc: { sendRequest: signers.request },
      blockUntilReady: signers.bunkerReady,
      toPayload() {
        return JSON.stringify({ type: 'nip46', payload: { userPubkey: this.userPubkey, bunkerPubkey: this.bunkerPubkey } });
      },
      on: vi.fn(),
    };
    signers.restoreBunker.mockImplementation(async (session: string) => ({
      ...bunker,
      userPubkey: JSON.parse(session).payload.userPubkey,
    }));
    signers.connectBunker.mockReturnValue(bunker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ignores a legacy session hint and bare account binding while offline', async () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip46');
    localStorage.setItem(STORAGE_KEYS.nip46Session, payload);
    localStorage.setItem(STORAGE_KEYS.nip46Permissions, buildNip46PermsParam());
    localStorage.setItem(STORAGE_KEYS.nip46Account, localAccount);
    signers.bunkerReady.mockRejectedValue(new Error('offline'));

    const { read, unmount } = mountIdentity();
    expect(read()).toMatchObject({ hydrated: true, pubkeyHex: localAccount, signerAccountPubkey: null, signerAvailable: false });
    await vi.waitFor(() => expect(read().signerError).toBe('bunker_unreachable'));
    expect(read().signerAccountPubkey).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.nostrIdentity)).toBe('stored-local-key');
    expect(signers.apply).not.toHaveBeenCalled();
    unmount?.();
  });

  it('exposes the bunker account across reloads after its permissions invalidate the session', () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip46');
    localStorage.setItem(STORAGE_KEYS.nip46Session, payload);
    localStorage.setItem(STORAGE_KEYS.nip46Account, JSON.stringify({ source: 'get_public_key', pubkey: bunkerAccount }));
    const first = mountIdentity();
    expect(first.read()).toMatchObject({ signerAccountPubkey: bunkerAccount, signerError: 'connection_failed' });
    expect(localStorage.getItem(STORAGE_KEYS.nip46Session)).toBeNull();
    first.unmount?.();

    const second = mountIdentity();
    expect(second.read().signerAccountPubkey).toBe(bunkerAccount);
    expect(signers.restoreBunker).not.toHaveBeenCalled();
    second.read().disconnectBunker();
    expect(second.read()).toMatchObject({ signerMode: 'local', signerAccountPubkey: null });
    expect(localStorage.getItem(STORAGE_KEYS.nip46Account)).toBeNull();
    second.unmount?.();
  });

  it('rejects a restored account hint that differs from the authenticated bunker reply', async () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip46');
    localStorage.setItem(STORAGE_KEYS.nip46Session, payload);
    localStorage.setItem(STORAGE_KEYS.nip46Permissions, buildNip46PermsParam());
    const user = { pubkey: localAccount };
    signers.bunkerReady.mockResolvedValue(user);

    const { read, unmount } = mountIdentity();
    expect(read().signerAccountPubkey).toBeNull();
    await vi.waitFor(() => expect(read().signerError).toBe('connection_failed'));
    expect(read()).toMatchObject({ pubkeyHex: localAccount, signerAccountPubkey: null, signerAvailable: false });
    expect(localStorage.getItem(STORAGE_KEYS.nostrIdentity)).toBe('stored-local-key');
    expect(loadVerifiedNip46Account(localStorage)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.nip46Session)).toBeNull();
    expect(user.pubkey).toBe(localAccount);
    expect(signers.request).toHaveBeenCalledExactlyOnceWith(bunkerEndpoint, 'get_public_key', [], 24133, expect.any(Function));
    expect(signers.apply).not.toHaveBeenCalled();
    unmount?.();
  });

  it('persists a matching verified account and keeps the separate local profile key', async () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip46');
    localStorage.setItem(STORAGE_KEYS.nip46Session, JSON.stringify({
      type: 'nip46', payload: { userPubkey: bunkerAccount, bunkerPubkey: bunkerEndpoint },
    }));
    localStorage.setItem(STORAGE_KEYS.nip46Permissions, buildNip46PermsParam());
    const user = { pubkey: bunkerAccount };
    signers.bunkerReady.mockResolvedValue(user);

    const { read, unmount } = mountIdentity();
    await vi.waitFor(() => expect(read().signerAvailable).toBe(true));
    expect(read()).toMatchObject({ pubkeyHex: localAccount, signerAccountPubkey: bunkerAccount });
    expect(localStorage.getItem(STORAGE_KEYS.nostrIdentity)).toBe('stored-local-key');
    expect(loadVerifiedNip46Account(localStorage)).toBe(bunkerAccount);
    expect(user.pubkey).toBe(bunkerAccount);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.nip46Session)!).payload.userPubkey).toBe(bunkerAccount);
    expect(signers.request).toHaveBeenCalledExactlyOnceWith(bunkerEndpoint, 'get_public_key', [], 24133, expect.any(Function));
    expect(signers.apply).toHaveBeenCalledOnce();
    unmount?.();
  });

  it('leaves legacy offline NIP-07 unbound, then persists and updates the verified extension account', async () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip07');
    const first = mountIdentity();
    expect(first.read()).toMatchObject({ pubkeyHex: localAccount, signerAccountPubkey: null, signerError: 'nip07_unavailable' });
    vi.stubGlobal('window', { nostr: { nip44: {} } });
    signers.extensionReady.mockResolvedValue(extensionAccount);
    await first.read().connectNip07();
    expect(first.read()).toMatchObject({ pubkeyHex: localAccount, signerAccountPubkey: extensionAccount });
    expect(localStorage.getItem(STORAGE_KEYS.nip07Account)).toBe(extensionAccount);
    first.unmount?.();

    vi.stubGlobal('window', {});
    const second = mountIdentity();
    expect(second.read()).toMatchObject({ signerAccountPubkey: extensionAccount, signerAvailable: false });
    vi.stubGlobal('window', { nostr: { nip44: {} } });
    signers.extensionReady.mockResolvedValue(otherExtensionAccount);
    await second.read().connectNip07();
    expect(second.read().signerAccountPubkey).toBe(otherExtensionAccount);
    expect(localStorage.getItem(STORAGE_KEYS.nip07Account)).toBe(otherExtensionAccount);

    signers.bunkerReady.mockResolvedValue({ pubkey: bunkerAccount });
    await second.read().connectBunkerUri('bunker://test');
    expect(second.read()).toMatchObject({ signerMode: 'nip46', signerAccountPubkey: bunkerAccount });
    expect(localStorage.getItem(STORAGE_KEYS.nip07Account)).toBeNull();
    second.unmount?.();
  });

  it('does not restore an extension binding when activation completes after disconnect', async () => {
    localStorage.setItem(STORAGE_KEYS.signerMode, 'nip07');
    localStorage.setItem(STORAGE_KEYS.nip07Account, extensionAccount);
    vi.stubGlobal('window', { nostr: { nip44: {} } });
    let finish!: (key: string) => void;
    signers.extensionReady.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));

    const { read, unmount } = mountIdentity();
    await vi.waitFor(() => expect(signers.extensionReady).toHaveBeenCalledOnce());
    read().disconnectNip07();
    finish(otherExtensionAccount);
    await vi.waitFor(() => expect(signers.release).toHaveBeenCalledOnce());
    expect(read()).toMatchObject({ signerMode: 'local', signerAccountPubkey: null, signerReconnecting: false });
    expect(localStorage.getItem(STORAGE_KEYS.nip07Account)).toBeNull();
    expect(signers.apply).not.toHaveBeenCalled();
    unmount?.();
  });

  it('does not persist an authenticated bunker session when a device reset overtakes verification', async () => {
    const respond = signers.request.getMockImplementation()!;
    signers.request.mockResolvedValue(undefined);
    signers.bunkerReady.mockResolvedValue({ pubkey: bunkerAccount });
    const { read, unmount } = mountIdentity();
    const connect = read().connectBunkerUri('bunker://test');
    await vi.waitFor(() => expect(signers.request).toHaveBeenCalledOnce());

    signers.resetGeneration.mockReturnValue('new-generation');
    await respond(...signers.request.mock.calls[0]);
    await connect;

    expect(localStorage.getItem(STORAGE_KEYS.nip46Account)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.nip46Session)).toBeNull();
    expect(signers.apply).not.toHaveBeenCalled();
    unmount?.();
  });

  it('does not persist an identity when a device reset overtakes first-launch key generation', async () => {
    signers.loadIdentity.mockReturnValue(null);
    let finish!: (pubkey: string) => void;
    signers.generateIdentity.mockResolvedValue({ seedHex: 'seed', privateKeyHex: 'private-key' });
    signers.derivePubkey.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { read, unmount } = mountIdentity();
    await vi.waitFor(() => expect(signers.derivePubkey).toHaveBeenCalledOnce());

    signers.resetGeneration.mockReturnValue('new-generation');
    finish(localAccount);
    await Promise.resolve();

    expect(signers.saveIdentity).not.toHaveBeenCalled();
    expect(read().hydrated).toBe(false);
    unmount?.();
  });
});
