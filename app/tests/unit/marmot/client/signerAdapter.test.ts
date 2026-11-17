/**
 * AC-SIGN-1 (budget per signer mode, fromForeignSigner/APPLESAUCE_SHAPE wrap),
 * AC-SIGN-2 (nip44 gate + i18n strings). Uses the REAL adapter and the REAL
 * old app signer (createPrivateKeySigner) as the foreign target.
 */
import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
  budgetPolicyFor,
  createAccountSigner,
  signerSupportsNip44,
  type AppEventSigner,
} from '@/src/lib/marmot/client/signerAdapter';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { getCopy } from '@/src/lib/i18n';

const SECRET = '33'.repeat(32);
const secretBytes = Uint8Array.from(Buffer.from(SECRET, 'hex'));

describe('createAccountSigner budget policy (AC-SIGN-1)', () => {
  it('local nsec -> {policy:"none"}', () => {
    const r = createAccountSigner({ eventSigner: createPrivateKeySigner(SECRET), kind: 'local' });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.budget).toEqual({ policy: 'none' });
  });

  it.each(['nip07', 'nip46'] as const)('%s -> a timeout budget, not "none"', (kind) => {
    const r = createAccountSigner({ eventSigner: createPrivateKeySigner(SECRET), kind });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.budget.policy).toBeUndefined();
    expect(r.budget.timeoutMs).toBeGreaterThan(0);
    expect(r.budget.leaseMs ?? Infinity).toBeGreaterThanOrEqual(r.budget.timeoutMs!);
    expect(budgetPolicyFor(kind)).toBe(r.budget);
  });

  it('returns a library Signer that really signs and does nip44 through the app signer', async () => {
    const r = createAccountSigner({ eventSigner: createPrivateKeySigner(SECRET), kind: 'local' });
    if (r.status !== 'ready') throw new Error('unexpected');
    const pub = await r.signer.getPublicKey();
    expect(pub).toBe(getPublicKey(secretBytes));
    const signed = await r.signer.signEvent({ kind: 1, created_at: 1700000000, tags: [], content: 'x' });
    expect(signed.pubkey).toBe(pub);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    const other = getPublicKey(Uint8Array.from(Buffer.from('44'.repeat(32), 'hex')));
    const ct = await r.signer.nip44.encrypt(other, 'secret');
    expect(ct).not.toContain('secret');
    expect(await r.signer.nip44.decrypt(other, ct)).toBe('secret');
  });
});

describe('nip44 gate (AC-SIGN-2)', () => {
  const noNip44: AppEventSigner = {
    getPublicKey: async () => 'aa'.repeat(32),
    signEvent: async (d) => d,
  };

  it('a signer without nip44 is unsupported/nip44 for every signer kind', () => {
    for (const kind of ['local', 'nip07', 'nip46'] as const) {
      expect(createAccountSigner({ eventSigner: noNip44, kind })).toEqual({ status: 'unsupported', reason: 'nip44' });
    }
  });

  it('half a nip44 (encrypt only) is also unsupported', () => {
    const half = { ...noNip44, nip44: { encrypt: async () => 'x' } } as unknown as AppEventSigner;
    expect(signerSupportsNip44(half)).toBe(false);
    expect(createAccountSigner({ eventSigner: half, kind: 'nip07' })).toEqual({ status: 'unsupported', reason: 'nip44' });
  });

  it('en and de carry a non-empty, different unsupported-nip44 string', () => {
    const en = getCopy('en').groups.unsupportedNip44;
    const de = getCopy('de').groups.unsupportedNip44;
    expect(en.trim().length).toBeGreaterThan(10);
    expect(de.trim().length).toBeGreaterThan(10);
    expect(en).not.toBe(de);
  });
});
