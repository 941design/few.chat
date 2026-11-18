import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInboxRelayOwnership,
  createLegacyInboxDiscovery,
  FOREIGN_INBOX_RELAY_LIST_PREFIX,
} from '@/src/lib/marmot/client/inboxRelayOwnership';

const secret = new Uint8Array(32).fill(1);
const otherSecret = new Uint8Array(32).fill(2);
const pubkey = getPublicKey(secret);
const key = FOREIGN_INBOX_RELAY_LIST_PREFIX + pubkey;

function list(created_at: number, client: string, signer = secret, kind = 10050) {
  return finalizeEvent({ kind, created_at, content: '', tags: [['relay', 'wss://inbox.example'], ['client', client]] }, signer);
}

describe('cached inbox relay ownership', () => {
  const data = new Map<string, string>();

  beforeEach(() => {
    data.clear();
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => { data.set(name, value); },
      removeItem: (name: string) => { data.delete(name); },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['invalid JSON', '{'],
    ['wrong account', JSON.stringify(list(1, 'foreign', otherSecret))],
    ['wrong kind', JSON.stringify(list(1, 'foreign', secret, 10002))],
    ['bad signature', JSON.stringify({ ...list(1, 'foreign'), sig: '00'.repeat(64) })],
    ['tampered tags', JSON.stringify({ ...list(1, 'foreign'), tags: [['relay', 'wss://tampered.example']] })],
    ['Few-owned cache entry', JSON.stringify(list(1, 'few'))],
  ])('disregards %s on reload', (_name, raw) => {
    data.set(key, raw);
    expect(createInboxRelayOwnership(pubkey)([])).toBeUndefined();
  });

  it('replaces the cached list with the latest verified foreign event', () => {
    const earlier = list(12, 'earlier');
    const newer = list(13, 'newer');
    const forged = { ...list(14, 'foreign'), sig: '00'.repeat(64) };
    data.set(key, JSON.stringify(earlier));
    const observe = createInboxRelayOwnership(pubkey);
    expect(observe([forged, newer, earlier])?.id).toBe(newer.id);
    expect(createInboxRelayOwnership(pubkey)([])?.id).toBe(newer.id);
  });

  it('retains a newer Few-owned network observation through partial results and evicts the foreign cache', () => {
    const foreign = list(12, 'foreign');
    const newer = list(13, 'few');
    data.set(key, JSON.stringify(foreign));
    const observe = createInboxRelayOwnership(pubkey);
    expect(observe([list(11, 'few')])?.id).toBe(foreign.id);
    expect(observe([newer])?.id).toBe(newer.id);
    expect(observe([foreign])?.id).toBe(newer.id);
    expect(data.has(key)).toBe(false);
    expect(createInboxRelayOwnership(pubkey)([])?.id).toBeUndefined();
  });

  it('breaks timestamp ties by lower event ID across cache and network', () => {
    const foreign = list(12, 'foreign');
    const few = list(12, 'few');
    data.set(key, JSON.stringify(foreign));
    const winner = foreign.id < few.id ? foreign : few;
    expect(createInboxRelayOwnership(pubkey)([few])?.id).toBe(winner.id);
    expect(data.has(key)).toBe(winner === foreign);
  });

  it('keeps a truncated automatic probe pending until the complete explicit probe', async () => {
    const legacyKey = `lp_marmotInboxDiscovery:${pubkey}`;
    const sources = Array.from({ length: 20 }, (_, i) => `wss://old-${i}.example`);
    data.set(legacyKey, JSON.stringify(sources));
    const legacy = createLegacyInboxDiscovery(pubkey, ['wss://current.example']);
    const requestWithDeadline = vi.fn(async (relays: string[]) => ({
      events: [], timedOut: false, eosedRelays: relays, silentRelays: [],
    }));
    const transport = { requestWithDeadline, publish: vi.fn(), subscription: vi.fn() };
    const observe = createInboxRelayOwnership(pubkey);
    const isActive = () => true;
    await legacy.discover(transport, observe, isActive, false);
    expect(requestWithDeadline.mock.calls).toEqual([[sources.slice(0, 16), {
      kinds: [10050], authors: [pubkey], limit: 1,
    }, { timeoutMs: 5_000, signal: undefined }]]);
    expect(legacy.pending).toBe(true);
    await legacy.discover(transport, observe, isActive, false);
    expect(requestWithDeadline).toHaveBeenCalledTimes(1);
    await legacy.discover(transport, observe, isActive, true);
    expect(requestWithDeadline.mock.calls[1][0]).toEqual(sources);
    expect(legacy.pending).toBe(false);
    expect(data.has(legacyKey)).toBe(false);
  });
});
