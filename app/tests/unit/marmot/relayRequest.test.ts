/**
 * One-shot raw REQ to a single relay, with an injected WebSocket constructor,
 * plus the real signature verifier.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { requestRelayOnce, verifyRelayEvent, MAX_EVENTS_PER_RELAY } from '@/src/lib/marmot/relayRequest';

class FakeWS {
  static last: FakeWS;
  static throwOnConstruct = false;
  static sendThrows = false;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  constructor(public url: string) {
    if (FakeWS.throwOnConstruct) throw new Error('bad url');
    FakeWS.last = this;
  }
  send(d: string) {
    if (FakeWS.sendThrows) throw new Error('send failed');
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  subId() {
    return JSON.parse(this.sent[0])[1] as string;
  }
}

const FILTER = { kinds: [443, 30443], authors: ['a'.repeat(64)], limit: 5 };
afterEach(() => {
  vi.useRealTimers();
  FakeWS.throwOnConstruct = false;
  FakeWS.sendThrows = false;
  vi.unstubAllGlobals();
});

describe('requestRelayOnce', () => {
  it('sends a REQ with the filter, collects EVENTs until EOSE, then sends CLOSE and closes', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual(['REQ', ws.subId(), FILTER]);
    ws.say(['EVENT', ws.subId(), { id: '1' }]);
    ws.say(['EVENT', 'other-sub', { id: 'x' }]);
    ws.say(['EVENT', ws.subId(), { id: '2' }]);
    ws.say(['EOSE', ws.subId()]);
    expect(await p).toEqual({ events: [{ id: '1' }, { id: '2' }], timedOut: false });
    expect(JSON.parse(ws.sent[1])).toEqual(['CLOSE', ws.subId()]);
    expect(ws.closed).toBe(true);
  });

  it('reports timedOut when the bound is hit with nothing received, and still closes', async () => {
    vi.useFakeTimers();
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    FakeWS.last.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ events: [], timedOut: true });
    expect(FakeWS.last.closed).toBe(true);
    expect(JSON.parse(FakeWS.last.sent[1])[0]).toBe('CLOSE');
  });

  it('keeps events received before the bound and does not call that a timeout', async () => {
    vi.useFakeTimers();
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.say(['EVENT', ws.subId(), { id: '1' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ events: [{ id: '1' }], timedOut: false });
  });

  it('a socket error contributes nothing and does not throw', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    FakeWS.last.onerror?.();
    expect(await p).toEqual({ events: [], timedOut: false });
    expect(FakeWS.last.closed).toBe(true);
  });

  it('a constructor that throws, or no WebSocket at all, contributes nothing', async () => {
    FakeWS.throwOnConstruct = true;
    expect(await requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS)).toEqual({ events: [], timedOut: false });
    expect(await requestRelayOnce('wss://r.example', FILTER, 5000, undefined as never)).toEqual({ events: [], timedOut: false });
  });

  it('ignores malformed frames and caps the events kept from one relay', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.onmessage?.({ data: 'not json' });
    ws.say('nope');
    for (let i = 0; i < MAX_EVENTS_PER_RELAY + 10; i++) ws.say(['EVENT', ws.subId(), { id: String(i) }]);
    ws.say(['EOSE', ws.subId()]);
    expect((await p).events).toHaveLength(MAX_EVENTS_PER_RELAY);
  });

  it('a CLOSED frame ends the request', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    FakeWS.last.open();
    FakeWS.last.say(['CLOSED', FakeWS.last.subId(), 'auth-required']);
    expect(await p).toEqual({ events: [], timedOut: false });
  });
});

describe('requestRelayOnce — protocol details', () => {
  it('does not collect an EVENT whose payload is not an object', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.say(['EVENT', ws.subId(), 'not-an-object']);
    ws.say(['EVENT', ws.subId(), null]);
    ws.say(['EVENT', ws.subId(), 42]);
    ws.say(['EOSE', ws.subId()]);
    expect((await p).events).toEqual([]);
  });

  it('a frame for our subscription that is neither EOSE nor CLOSED does not end the request', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.say(['OK', ws.subId(), true]);
    ws.say(['NOTICE', ws.subId(), 'hello']);
    ws.say(['EVENT', ws.subId(), { id: 'after' }]);
    ws.say(['EOSE', ws.subId()]);
    expect(await p).toEqual({ events: [{ id: 'after' }], timedOut: false });
  });

  it('sends no CLOSE when the bound hits before the socket opened, but still closes it', async () => {
    vi.useFakeTimers();
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ events: [], timedOut: true });
    expect(FakeWS.last.sent).toEqual([]);
    expect(FakeWS.last.closed).toBe(true);
  });

  it('sends exactly one CLOSE, with the REQ subscription id, when open', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.say(['EOSE', ws.subId()]);
    await p;
    ws.onclose?.(); // a late close must not send or resolve anything again
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0])[0]).toBe('REQ');
    expect(JSON.parse(ws.sent[1])).toEqual(['CLOSE', ws.subId()]);
  });

  it('resolves empty immediately when there is no WebSocket constructor at all', async () => {
    vi.stubGlobal('WebSocket', undefined);
    vi.useFakeTimers();
    const p = requestRelayOnce('wss://r.example', FILTER, 5000);
    expect(await p).toEqual({ events: [], timedOut: false }); // no timer advance needed
  });

  it('a send that throws when the socket opens resolves, not timed out', async () => {
    vi.useFakeTimers();
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    FakeWS.sendThrows = true;
    FakeWS.last.open();
    expect(await p).toEqual({ events: [], timedOut: false });
    expect(FakeWS.last.closed).toBe(true);
  });

  it('a close without EOSE resolves with the events received so far, not timed out', async () => {
    const p = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const ws = FakeWS.last;
    ws.open();
    ws.say(['EVENT', ws.subId(), { id: '1' }]);
    ws.onclose?.();
    expect(await p).toEqual({ events: [{ id: '1' }], timedOut: false });
  });

  it('uses a non-empty subscription id that differs between requests', async () => {
    const a = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const wsA = FakeWS.last;
    wsA.open();
    const b = requestRelayOnce('wss://r.example', FILTER, 5000, FakeWS);
    const wsB = FakeWS.last;
    wsB.open();
    expect(wsA.subId().length).toBeGreaterThan(0);
    expect(wsA.subId()).not.toBe(wsB.subId());
    wsA.say(['EOSE', wsA.subId()]);
    wsB.say(['EOSE', wsB.subId()]);
    await Promise.all([a, b]);
  });
});

describe('verifyRelayEvent', () => {
  const sk = generateSecretKey();
  it('accepts a genuinely signed event, rejects a tampered one and malformed input', () => {
    const ev = finalizeEvent({ kind: 30443, created_at: 1, tags: [], content: 'x' }, sk);
    expect(verifyRelayEvent(ev)).toBe(true);
    expect(verifyRelayEvent({ ...ev, content: 'tampered' })).toBe(false);
    expect(verifyRelayEvent({ ...ev, pubkey: 'b'.repeat(64) })).toBe(false);
    expect(verifyRelayEvent(null)).toBe(false);
    expect(verifyRelayEvent({})).toBe(false);
  });

  it('verifies a real NDKEvent built from a signed event, and rejects it once tampered (guards NDK field/getter changes)', () => {
    const ev = finalizeEvent({ kind: 30443, created_at: 1, tags: [['d', 'x']], content: 'hello' }, sk);
    const ndkEv = new NDKEvent(undefined, ev);
    expect(verifyRelayEvent(ndkEv)).toBe(true);
    ndkEv.content = 'tampered';
    expect(verifyRelayEvent(ndkEv)).toBe(false);
  });
});
