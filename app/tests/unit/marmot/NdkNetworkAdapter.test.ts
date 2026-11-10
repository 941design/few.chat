import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NDK and DEFAULT_RELAYS before importing the adapter
// ---------------------------------------------------------------------------

const mockFetchEvents = vi.fn();
const mockFetchEventsWithTimeout = vi.fn();

vi.mock('@nostr-dev-kit/ndk', () => {
  return {
    NDKEvent: class {},
    NDKFilter: class {},
    NDKSubscription: class {},
    NDKRelaySet: {
      fromRelayUrls: vi.fn((_relays: string[], _ndk: unknown) => 'mock-relay-set'),
    },
  };
});

vi.mock('@/src/types', () => ({
  DEFAULT_RELAYS: ['wss://relay.damus.io', 'wss://nos.lol'],
}));

vi.mock('@/src/lib/ndkClient', () => ({
  PUBLISH_TIMEOUT_MS: 10_000,
  publishWithTimeout: vi.fn().mockResolvedValue(new Set()),
  fetchEventsWithTimeout: (...args: unknown[]) => mockFetchEventsWithTimeout(...args),
}));

vi.mock('@/src/lib/marmot/relayRequest', () => ({
  verifyRelayEvent: (e: { sig?: string }) => e.sig !== 'bad',
}));

import { NdkNetworkAdapter } from '@/src/lib/marmot/NdkNetworkAdapter';
import { NDKRelaySet } from '@nostr-dev-kit/ndk';

// ---------------------------------------------------------------------------
// rawPublish tests (WebSocket-based)
// ---------------------------------------------------------------------------

describe('NdkNetworkAdapter — rawPublish (via publish)', () => {
  let adapter: NdkNetworkAdapter;
  let mockNdk: { fetchEvents: typeof mockFetchEvents };
  let mockWebSocketInstances: Array<{
    onopen: (() => void) | null;
    onmessage: ((msg: { data: string }) => void) | null;
    onerror: (() => void) | null;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>;
  let origWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    mockFetchEvents.mockReset();
    mockWebSocketInstances = [];

    mockNdk = { fetchEvents: mockFetchEvents } as unknown as typeof mockNdk;
    adapter = new NdkNetworkAdapter(mockNdk as never);

    origWebSocket = globalThis.WebSocket;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((msg: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor(_url: string) {
        mockWebSocketInstances.push(this);
        // fire onopen on next tick
        setTimeout(() => this.onopen?.(), 0);
      }
    };
  });

  afterEach(() => {
    globalThis.WebSocket = origWebSocket;
  });

  const sampleEvent = {
    id: 'event123',
    pubkey: 'pub1',
    created_at: 1000,
    kind: 1059,
    tags: [],
    content: 'encrypted',
    sig: 'sig1',
  };

  it('resolves ok: true on successful relay acknowledgment', async () => {
    const resultPromise = adapter.publish(['wss://relay.test'], sampleEvent);

    // Wait for WebSocket to be created and onopen to fire
    await new Promise((r) => setTimeout(r, 10));

    const ws = mockWebSocketInstances[0];
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(['EVENT', sampleEvent]));

    // Simulate relay OK response
    ws.onmessage?.({ data: JSON.stringify(['OK', 'event123', true, '']) });

    const result = await resultPromise;
    expect(result['wss://relay.test'].ok).toBe(true);
  });

  it('resolves ok: false on WebSocket error', async () => {
    const resultPromise = adapter.publish(['wss://relay.test'], sampleEvent);

    await new Promise((r) => setTimeout(r, 10));

    const ws = mockWebSocketInstances[0];
    ws.onerror?.();

    const result = await resultPromise;
    expect(result['wss://relay.test'].ok).toBe(false);
    expect(result['wss://relay.test'].message).toBe('websocket error');
  });

  it('resolves ok: false with timeout message when relay does not respond', async () => {
    vi.useFakeTimers();

    const resultPromise = adapter.publish(['wss://relay.test'], sampleEvent);

    // Advance past onopen tick
    await vi.advanceTimersByTimeAsync(1);
    // Advance past the 10s timeout
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await resultPromise;
    expect(result['wss://relay.test'].ok).toBe(false);
    expect(result['wss://relay.test'].message).toBe('timeout');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// request / subscription relay scoping
// ---------------------------------------------------------------------------

describe('NdkNetworkAdapter — request relay scoping', () => {
  let adapter: NdkNetworkAdapter;

  beforeEach(() => {
    mockFetchEventsWithTimeout.mockReset();
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(), timedOut: false });
    const mockNdk = { fetchEvents: mockFetchEvents };
    adapter = new NdkNetworkAdapter(mockNdk as never);
    vi.mocked(NDKRelaySet.fromRelayUrls).mockClear();
  });

  it('passes NDKRelaySet built from relays to fetchEventsWithTimeout', async () => {
    await adapter.request(['wss://relay.a', 'wss://relay.b'], { kinds: [1] });

    expect(NDKRelaySet.fromRelayUrls).toHaveBeenCalledWith(
      ['wss://relay.a', 'wss://relay.b'],
      expect.anything(),
    );
    expect(mockFetchEventsWithTimeout).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'mock-relay-set',
    );
  });

  it('returns empty array on timeout to avoid partial results', async () => {
    mockFetchEventsWithTimeout.mockResolvedValue({
      events: new Set([{ id: 'partial' }]),
      timedOut: true,
    });

    const result = await adapter.request(['wss://relay.a'], { kinds: [1] });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getUserInboxRelays tests
// ---------------------------------------------------------------------------

describe('NdkNetworkAdapter — getUserInboxRelays', () => {
  let adapter: NdkNetworkAdapter;
  const PEER = 'c'.repeat(64);
  const EFFECTIVE = ['wss://relay.damus.io', 'wss://nos.lol'];
  const list = (urls: string[], o: { kind?: number; d?: string | null; pubkey?: string; created_at?: number; sig?: string } = {}) => ({
    sig: o.sig ?? 'ok',
    pubkey: o.pubkey ?? PEER,
    kind: o.kind ?? 30051,
    created_at: o.created_at ?? 1,
    tags: [...(o.d === null ? [] : [['d', o.d ?? 'marmot']]), ...urls.map((u) => ['relay', u]), ['other', 'ignored']],
  });
  const found = (...events: object[]) =>
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(events), timedOut: false });

  beforeEach(() => {
    mockFetchEventsWithTimeout.mockReset();
    const mockNdk = { fetchEvents: mockFetchEvents };
    adapter = new NdkNetworkAdapter(mockNdk as never);
  });

  it('returns the effective relays when the peer lists none', async () => {
    found();
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
  });

  it('returns the effective relays when the list has no relay tags', async () => {
    found({ pubkey: PEER, kind: 30051, sig: 'ok', created_at: 1, tags: [['d', 'marmot'], ['other', 'value']] });
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
  });

  it('returns the effective relays on fetch error', async () => {
    mockFetchEventsWithTimeout.mockRejectedValue(new Error('network error'));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
  });

  it('still uses a verified list that arrived before the timeout: listed first, then effective', async () => {
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set([list(['wss://inbox.one'])]), timedOut: true });
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://inbox.one', ...EFFECTIVE]);
  });

  it('returns the effective relays alone on timeout when no valid list arrived', async () => {
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(), timedOut: true });
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set([list(['wss://f.example'], { sig: 'bad' })]), timedOut: true });
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
  });

  it('keeps relays that differ only in their query distinct', async () => {
    found(list(['wss://r.example/?token=a', 'wss://r.example/?token=b']));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://r.example?token=a', 'wss://r.example?token=b', ...EFFECTIVE]);
  });

  it('returns the peer\'s listed relays first, then our effective relays (Welcome is not sent to the listed relays alone)', async () => {
    found(list(['wss://inbox.one', 'wss://inbox.two']));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://inbox.one', 'wss://inbox.two', ...EFFECTIVE]);
  });

  it('reads kind 10051 when the peer has no 30051 d=marmot, and prefers 30051 when both exist', async () => {
    found(list(['wss://inbox.one'], { kind: 10051, d: null }));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://inbox.one', ...EFFECTIVE]);
    found(list(['wss://inbox.one'], { kind: 10051, d: null, created_at: 9 }), list(['wss://marmot.one']));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://marmot.one', ...EFFECTIVE]);
  });

  it('dedupes a listed relay that is also one of ours, keeping it in the listed position', async () => {
    found(list(['wss://NOS.lol/', 'wss://inbox.one']));
    const relays = await adapter.getUserInboxRelays(PEER);
    expect(relays).toEqual(['wss://nos.lol', 'wss://inbox.one', 'wss://relay.damus.io']);
  });

  it('ignores a list authored by someone else and filters unsafe URLs', async () => {
    found(list(['wss://evil.example'], { pubkey: 'd'.repeat(64) }));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
    found(list(['ws://remote.example', 'https://x.example', 'wss://ok.example']));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(['wss://ok.example', ...EFFECTIVE]);
  });

  it('ignores a relay list whose signature does not verify', async () => {
    found(list(['wss://forged.example'], { sig: 'bad' }));
    expect(await adapter.getUserInboxRelays(PEER)).toEqual(EFFECTIVE);
  });

  it('never returns an empty array', async () => {
    for (const setup of [() => found(), () => mockFetchEventsWithTimeout.mockRejectedValue(new Error('x'))]) {
      setup();
      expect((await adapter.getUserInboxRelays(PEER)).length).toBeGreaterThan(0);
    }
  });
});
