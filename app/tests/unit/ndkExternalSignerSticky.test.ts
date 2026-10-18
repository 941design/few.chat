/**
 * An external signer (NIP-07 / NIP-46) applied to the NDK singleton must survive
 * connectNdk/getNdk(localKey) calls (bug connectndk-rebinds-external-signer).
 *
 * DM send, reactions, history fetch and several watchers call
 * connectNdk(privateKeyHex) with the stored local key. Before the fix every such
 * call put a private-key signer for that key back on the singleton, so publishes
 * were signed by the local key instead of the connected external signer.
 *
 * Drives the real ndkClient singleton and real NDK signers; only `connect` is
 * stubbed (no relays in unit tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { DEFAULT_RELAYS } from '@/src/types';

type NdkClient = typeof import('@/src/lib/ndkClient');

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function newKey(): { sk: string; pk: string } {
  const raw = generateSecretKey();
  return { sk: bytesToHex(raw), pk: getPublicKey(raw) };
}

async function signerPubkey(ndk: NDK): Promise<string> {
  const ev = new NDKEvent(ndk, { kind: 1, content: 'x', tags: [], created_at: 1 } as never);
  await ev.sign();
  return ev.pubkey;
}

let client: NdkClient;

beforeEach(async () => {
  vi.stubGlobal('window', {});
  vi.resetModules();
  client = await import('@/src/lib/ndkClient');
  vi.spyOn(NDK.prototype, 'connect').mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('external signer stays bound', () => {
  it('connectNdk(localKey) does not replace an applied external signer', async () => {
    const local = newKey();
    const external = newKey();
    const ndk = await client.connectNdk(local.sk);
    const ext = new NDKPrivateKeySigner(external.sk);
    client.applyNdkSigner(ext);

    const again = await client.connectNdk(local.sk);

    expect(again).toBe(ndk);
    expect(again.signer).toBe(ext);
    expect(await signerPubkey(again)).toBe(external.pk);
  });

  it('getNdk(otherKey) does not replace it either', async () => {
    const ext = new NDKPrivateKeySigner(newKey().sk);
    client.getNdk(newKey().sk);
    client.applyNdkSigner(ext);

    expect(client.getNdk(newKey().sk)!.signer).toBe(ext);
    expect(client.getNdk()!.signer).toBe(ext);
  });

  it('an external signer applied before the singleton exists is used on creation', async () => {
    const external = newKey();
    const ext = new NDKPrivateKeySigner(external.sk);
    client.applyNdkSigner(ext);

    const ndk = await client.connectNdk(newKey().sk);

    expect(ndk.signer).toBe(ext);
    expect(await signerPubkey(ndk)).toBe(external.pk);
  });
});

describe('release returns to a local key', () => {
  it('releaseNdkExternalSigner(key) binds that key immediately', async () => {
    const local = newKey();
    const ndk = await client.connectNdk(local.sk);
    client.applyNdkSigner(new NDKPrivateKeySigner(newKey().sk));

    client.releaseNdkExternalSigner(local.sk);

    expect(ndk.signer).toBeInstanceOf(NDKPrivateKeySigner);
    expect(await signerPubkey(ndk)).toBe(local.pk);
  });

  it('releaseNdkExternalSigner(null) lets the next connectNdk(key) bind the key', async () => {
    const local = newKey();
    const ext = new NDKPrivateKeySigner(newKey().sk);
    const ndk = await client.connectNdk(local.sk);
    client.applyNdkSigner(ext);

    client.releaseNdkExternalSigner(null);
    expect(ndk.signer).toBe(ext);

    await client.connectNdk(local.sk);
    expect(await signerPubkey(ndk)).toBe(local.pk);
  });

  it('release before the singleton exists: the next creation binds the local key', async () => {
    const local = newKey();
    client.applyNdkSigner(new NDKPrivateKeySigner(newKey().sk));
    client.releaseNdkExternalSigner(local.sk);

    const ndk = await client.connectNdk(local.sk);
    expect(await signerPubkey(ndk)).toBe(local.pk);
  });
});

describe('local mode is unchanged', () => {
  it('binds the key and rebinds when it changes', async () => {
    const a = newKey();
    const b = newKey();
    const ndk = await client.connectNdk(a.sk);
    const first = ndk.signer;
    expect(await signerPubkey(ndk)).toBe(a.pk);

    await client.connectNdk(a.sk);
    expect(ndk.signer).toBe(first);

    await client.connectNdk(b.sk);
    expect(await signerPubkey(ndk)).toBe(b.pk);
  });
});

describe('singleton basics', () => {
  it('getNdk() without a key keeps the bound signer', async () => {
    const a = newKey();
    const ndk = await client.connectNdk(a.sk);
    const bound = ndk.signer;

    expect(client.getNdk()).toBe(ndk);
    expect(ndk.signer).toBe(bound);
    expect(await signerPubkey(ndk)).toBe(a.pk);
  });

  it('is created with the default relays', () => {
    expect(client.getNdk()!.explicitRelayUrls).toEqual([...DEFAULT_RELAYS]);
  });

  it('returns null without a window (SSR)', async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const ssr = await import('@/src/lib/ndkClient');
    expect(ssr.getNdk(newKey().sk)).toBeNull();
  });
});
