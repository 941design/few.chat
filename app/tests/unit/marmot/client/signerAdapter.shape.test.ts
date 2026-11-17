/**
 * AC-SIGN-1: the adapter wraps the app signer with `fromForeignSigner` and the
 * APPLESAUCE_SHAPE method map (not another shape such as NIP-07's), passing the
 * app signer itself as the target.
 */
import { describe, expect, it, vi } from 'vitest';
import * as adapters from '@941design/nostr-events/signer/adapters';
import { createAccountSigner } from '@/src/lib/marmot/client/signerAdapter';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';

vi.mock('@941design/nostr-events/signer/adapters', async (importOriginal) => {
  const original = await importOriginal<typeof import('@941design/nostr-events/signer/adapters')>();
  return { ...original, fromForeignSigner: vi.fn(original.fromForeignSigner) };
});

describe('createAccountSigner wraps with fromForeignSigner(APPLESAUCE_SHAPE) (AC-SIGN-1)', () => {
  it('calls fromForeignSigner once with the app signer as target and the APPLESAUCE_SHAPE map by identity', () => {
    const eventSigner = createPrivateKeySigner('66'.repeat(32));
    vi.mocked(adapters.fromForeignSigner).mockClear();
    const r = createAccountSigner({ eventSigner, kind: 'local' });
    expect(r.status).toBe('ready');
    expect(adapters.fromForeignSigner).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(adapters.fromForeignSigner).mock.calls[0][0] as { target: unknown; methods: unknown };
    expect(arg.target).toBe(eventSigner);
    expect(arg.methods).toBe(adapters.APPLESAUCE_SHAPE);
    for (const other of Object.keys(adapters)) {
      if (other.endsWith('_SHAPE') && other !== 'APPLESAUCE_SHAPE') {
        expect(arg.methods).not.toBe((adapters as Record<string, unknown>)[other]);
      }
    }
  });

  it('does not wrap when the signer lacks nip44 (gate runs first)', () => {
    vi.mocked(adapters.fromForeignSigner).mockClear();
    const noNip44 = { getPublicKey: async () => 'aa'.repeat(32), signEvent: async (d: unknown) => d };
    expect(createAccountSigner({ eventSigner: noNip44 as never, kind: 'local' }).status).toBe('unsupported');
    expect(adapters.fromForeignSigner).not.toHaveBeenCalled();
  });
});
