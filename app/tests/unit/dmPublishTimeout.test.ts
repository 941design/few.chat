/**
 * DM publishes must tolerate a slow relay ack (bug
 * dm-own-send-bubble-vanishes-on-publish-reject).
 *
 * NDK 3.0.3 rejects a relay that has not acked within 2500 ms by default, which
 * rolled back DMs the relay actually stored. These tests drive REAL NDK code
 * (NDKEvent.publish -> NDKRelaySet -> NDKRelayPublisher) against a relay whose
 * connectivity layer is stubbed to ack after a configurable delay, under fake
 * timers. Only the websocket write is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NDK, { NDKEvent, NDKPrivateKeySigner, NDKRelayStatus } from '@nostr-dev-kit/ndk';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { PUBLISH_TIMEOUT_MS, publishWithTimeout } from '@/src/lib/ndkClient';
import {
  buildChatRumor,
  publishDirectDelete,
  publishDirectEdit,
  publishDirectMessage,
  publishDirectReaction,
  publishPrebuiltRumor,
  removeDirectReaction,
} from '@/src/lib/directMessages';

// publishDirectDelete/Edit read and write persisted chat state (idb-keyval).
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
}));

const DEFAULT_NDK_ACK_TIMEOUT_MS = 2500;
const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function makeNdk(ackDelayMs: number | null): { ndk: NDK; acks: () => number } {
  const ndk = new NDK({ explicitRelayUrls: ['wss://relay.test'] });
  const relay = Array.from(ndk.pool.relays.values())[0];
  Object.defineProperty(relay, 'status', { get: () => NDKRelayStatus.CONNECTED, configurable: true });
  let acked = 0;
  vi.spyOn(relay.connectivity, 'publish').mockImplementation(
    () =>
      new Promise((resolve) => {
        if (ackDelayMs === null) return; // relay never acks
        setTimeout(() => {
          acked++;
          resolve(true as never);
        }, ackDelayMs);
      }) as never,
  );
  return { ndk, acks: () => acked };
}

async function signedEvent(ndk: NDK): Promise<NDKEvent> {
  ndk.signer = new NDKPrivateKeySigner(bytesToHex(generateSecretKey()));
  const ev = new NDKEvent(ndk, { kind: 1059, content: 'x', tags: [], created_at: 1 } as never);
  await ev.sign();
  return ev;
}

const realSetTimeout = globalThis.setTimeout;
const realYield = () => new Promise<void>((r) => realSetTimeout(r, 5));

/**
 * Settle a publish promise while advancing fake time in small steps. Real
 * yields between steps let async setup (signing, dynamic imports) reach the
 * point where NDK arms its timers before the clock moves past them.
 */
async function settle<T>(p: Promise<T>, advanceMs: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  void p.then(
    (value) => { result = { ok: true, value }; },
    (error) => { result = { ok: false, error }; },
  );
  const step = 100;
  // Advance fake time only up to advanceMs, but keep yielding real time (up to ~10 s)
  // so slow first-time dynamic imports of the code under test can finish.
  for (let i = 0, t = 0; i < 2000 && !result; i++) {
    await realYield();
    if (t < advanceMs) {
      await vi.advanceTimersByTimeAsync(step);
      t += step;
    }
  }
  await realYield();
  if (!result) throw new Error('publish did not settle within the simulated window');
  return result;
}

describe('DM publish ack timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shared timeout is at least the group path timeout (10 s)', () => {
    expect(PUBLISH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('baseline: NDK default publish rejects an ack later than 2.5 s (the bug)', async () => {
    const { ndk } = makeNdk(DEFAULT_NDK_ACK_TIMEOUT_MS + 2000);
    const ev = await signedEvent(ndk);
    const res = await settle(ev.publish(), 10_000);
    expect(res.ok).toBe(false);
  });

  it('publishWithTimeout accepts an ack arriving after 2.5 s but before the timeout', async () => {
    const { ndk, acks } = makeNdk(DEFAULT_NDK_ACK_TIMEOUT_MS + 2000);
    const ev = await signedEvent(ndk);
    const res = await settle(publishWithTimeout(ev), 10_000);
    expect(res.ok).toBe(true);
    expect(acks()).toBe(1);
  });

  it('publishWithTimeout still fails when no relay acks within the timeout', async () => {
    const { ndk } = makeNdk(null);
    const ev = await signedEvent(ndk);
    const res = await settle(publishWithTimeout(ev), PUBLISH_TIMEOUT_MS * 2);
    expect(res.ok).toBe(false);
  });

  it('publishDirectMessage keeps a send acked after 2.5 s', async () => {
    const { ndk, acks } = makeNdk(DEFAULT_NDK_ACK_TIMEOUT_MS + 2000);
    const sk = bytesToHex(generateSecretKey());
    const peer = getPublicKey(generateSecretKey());
    ndk.signer = new NDKPrivateKeySigner(sk);
    const res = await settle(publishDirectMessage({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, content: 'hi' }), 10_000);
    expect(res.ok).toBe(true);
    expect(acks()).toBe(1);
  });

  it('publishDirectReaction keeps a reaction acked after 2.5 s', async () => {
    const { ndk, acks } = makeNdk(DEFAULT_NDK_ACK_TIMEOUT_MS + 2000);
    const sk = bytesToHex(generateSecretKey());
    const peer = getPublicKey(generateSecretKey());
    ndk.signer = new NDKPrivateKeySigner(sk);
    const targetMessage = { id: 'a'.repeat(64), pubkey: peer, content: 'm', created_at: 1 } as never;
    const res = await settle(
      publishDirectReaction({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, emoji: '👍', targetMessage }),
      10_000,
    );
    expect(res.ok).toBe(true);
    expect(acks()).toBe(1);
  });

  describe('every DM publish path keeps an ack later than 2.5 s', () => {
    const target = (peer: string) =>
      ({ id: 'a'.repeat(64), pubkey: peer, content: 'm', createdAt: 1_000_000, rev: 0 }) as never;

    const setup = (ackDelay: number) => {
      const made = makeNdk(ackDelay);
      const sk = bytesToHex(generateSecretKey());
      const peer = getPublicKey(generateSecretKey());
      made.ndk.signer = new NDKPrivateKeySigner(sk);
      return { ...made, sk, peer };
    };

    it('publishPrebuiltRumor (ContactChat text send + reaction)', async () => {
      const { ndk, acks, sk, peer } = setup(4500);
      const rumor = buildChatRumor({ privateKeyHex: sk, peerPubkeyHex: peer, content: 'hi' });
      const res = await settle(publishPrebuiltRumor({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, rumor }), 10_000);
      expect(res.ok).toBe(true);
      expect(acks()).toBe(1);
    });

    it('removeDirectReaction', async () => {
      const { ndk, acks, sk, peer } = setup(4500);
      const res = await settle(
        removeDirectReaction({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, emoji: '👍', targetMessage: target(peer) }),
        10_000,
      );
      expect(res.ok).toBe(true);
      expect(acks()).toBe(1);
    });

    it('publishDirectDelete', async () => {
      const { ndk, acks, sk, peer } = setup(4500);
      const res = await settle(
        publishDirectDelete({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, targetMessage: target(peer) }),
        20_000,
      );
      expect(res.ok).toBe(true);
      expect(acks()).toBe(1);
    });

    it('publishDirectEdit publishes both the replacement and the companion with the long timeout', async () => {
      const { ndk, acks, sk, peer } = setup(4500);
      const res = await settle(
        publishDirectEdit({ ndk, privateKeyHex: sk, peerPubkeyHex: peer, targetMessage: target(peer), newContent: 'edited' }),
        20_000,
      );
      expect(res.ok).toBe(true);
      expect(acks()).toBe(2);
    });
  });
});
