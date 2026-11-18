// @vitest-environment node
/**
 * Gift-wrap dispatch helper coverage. Pairing acknowledgements stay on the DM
 * plane and library inbox kinds are skipped without a handler call or log.
 *
 * Real NIP-59 wraps (sealAndWrap, real crypto) are dispatched; only the logger is observed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
}

const logged: unknown[][] = [];
vi.mock('@/src/lib/logger', () => ({
  createLogger: () => {
    const record = (level: string) => (...args: unknown[]) => void logged.push([level, ...args]);
    return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  },
}));

const { generateSecretKey, getPublicKey, getEventHash } = await import('nostr-tools/pure');
const { RUMOR_KINDS } = await import('@941design/marmot');
const { APP_INBOX_KINDS, RETIRED_KINDS } = await import('@/src/lib/marmot/kinds');
const { sealAndWrap, dispatchDmGiftWrap, DM_PLANE_SKIPPED_KINDS, CHAT_MESSAGE_KIND } = await import('@/src/lib/directMessages');

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const senderPriv = generateSecretKey();
const recipientPriv = generateSecretKey();
const senderPub = getPublicKey(senderPriv);
const recipientPub = getPublicKey(recipientPriv);

async function wrapOfKind(kind: number, content = 'x') {
  const base = { kind, content, tags: [['p', recipientPub]], created_at: Math.floor(Date.now() / 1000), pubkey: senderPub };
  const rumor = { ...base, id: getEventHash(base) };
  return sealAndWrap(rumor, recipientPub, hex(senderPriv));
}

beforeEach(() => {
  logged.length = 0;
});

describe('the skip set', () => {
  it('uses the reserved library kinds, join request and invitation context', () => {
    expect([...DM_PLANE_SKIPPED_KINDS].sort((a, b) => a - b)).toEqual(
      [...Object.values(RUMOR_KINDS), APP_INBOX_KINDS.joinRequest, APP_INBOX_KINDS.inviteContext].sort((a, b) => a - b),
    );
  });
  it('does not skip the DM-plane kinds (chat, pairing ack, DM profile) nor the retired ones', () => {
    for (const k of [CHAT_MESSAGE_KIND, APP_INBOX_KINDS.pairingAck, ...APP_INBOX_KINDS.dmProfile, ...RETIRED_KINDS]) expect(DM_PLANE_SKIPPED_KINDS.has(k)).toBe(false);
  });
});

describe('AC-INBOX-1: silent skip of the library-inbox kinds', () => {
  it.each([...Object.values(RUMOR_KINDS), APP_INBOX_KINDS.joinRequest, APP_INBOX_KINDS.inviteContext])('kind %i: skipped, no pairing handler call, nothing logged', async (kind) => {
    const pairingAck = vi.fn(async () => ({ status: 'admitted' }));
    const wrap = await wrapOfKind(kind);
    const result = await dispatchDmGiftWrap(wrap, hex(recipientPriv), { pairingAck });
    expect(result).toEqual({ status: 'skipped', kind });
    expect(pairingAck).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });
});

describe('pairing-ack on the DM plane', () => {
  it('a 21060 wrap is handed to the pairing handler (the wrap, not the rumor) and its result is returned', async () => {
    const wrap = await wrapOfKind(APP_INBOX_KINDS.pairingAck, JSON.stringify({ nonce: 'n' }));
    const pairingAck = vi.fn(async (_wrap: unknown) => ({ status: 'admitted', senderPubkeyHex: senderPub }));
    const result = await dispatchDmGiftWrap(wrap, hex(recipientPriv), { pairingAck });
    expect(result).toEqual({ status: 'pairing-ack', result: { status: 'admitted', senderPubkeyHex: senderPub } });
    expect(pairingAck).toHaveBeenCalledTimes(1);
    expect(pairingAck.mock.calls[0][0]).toBe(wrap);
  });

  it('a throwing pairing handler propagates (the listener decides how to report it)', async () => {
    const wrap = await wrapOfKind(APP_INBOX_KINDS.pairingAck);
    await expect(dispatchDmGiftWrap(wrap, hex(recipientPriv), { pairingAck: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});

describe('everything else', () => {
  it('a chat rumor is returned to the listener untouched (no skip, no pairing call)', async () => {
    const pairingAck = vi.fn();
    const wrap = await wrapOfKind(CHAT_MESSAGE_KIND, 'hello');
    const result = await dispatchDmGiftWrap(wrap, hex(recipientPriv), { pairingAck });
    expect(result.status).toBe('rumor');
    if (result.status === 'rumor') {
      expect(result.rumor.kind).toBe(CHAT_MESSAGE_KIND);
      expect(result.rumor.content).toBe('hello');
      expect(result.rumor.pubkey).toBe(senderPub);
    }
    expect(pairingAck).not.toHaveBeenCalled();
  });

  it('a wrap that cannot be opened (foreign key) is unwrap-failed: no handler call', async () => {
    const wrap = await wrapOfKind(CHAT_MESSAGE_KIND);
    const pairingAck = vi.fn();
    const result = await dispatchDmGiftWrap(wrap, hex(generateSecretKey()), { pairingAck });
    expect(result).toEqual({ status: 'unwrap-failed' });
    expect(pairingAck).not.toHaveBeenCalled();
  });

  it('a non-gift-wrap event is unwrap-failed', async () => {
    const result = await dispatchDmGiftWrap({ id: 'x', kind: 1, pubkey: senderPub, content: '', tags: [], created_at: 1, sig: '' } as never, hex(recipientPriv), { pairingAck: vi.fn() });
    expect(result).toEqual({ status: 'unwrap-failed' });
  });
});
