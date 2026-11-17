// @vitest-environment node
/**
 * Security: relay-supplied events are verified by the library default (no
 * custom verifier, AC-TRANS-1). A FakeRelay injects (relay-side, bypassing any
 * client-publish check) a VALID signed event and forged copies, and the
 * transport built by the app's factory must deliver the valid one only.
 * The valid control event proves the path is live (a test that only asserts
 * "nothing arrived" would pass against a dead subscription).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from '@941design/nostr-events/event';
import { createClientTransport, type ClientTransport } from '@/src/lib/marmot/client/transport';

let relay: FakeRelay;
let relayUrl: string;
let transport: ClientTransport | undefined;

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
});
afterEach(async () => {
  transport?.closePool();
  transport = undefined;
  await relay.stop();
});

const sk = generateSecretKey();
const sign = (kind: number, content: string, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at: 1_700_000_000, tags, content }, sk) as unknown as NostrEvent;

/**
 * Forgeries of OTHER events (each has its own id, so none can shadow the genuine
 * event through id-based de-duplication): a tampered body (id/sig no longer
 * match the content), a garbage signature, and another event's signature.
 */
function forgeries(kind: number, tags: string[][]): Record<string, NostrEvent> {
  const a = sign(kind, 'victim-a', tags);
  const b = sign(kind, 'victim-b', tags);
  const c = sign(kind, 'victim-c', tags);
  const other = sign(kind, 'donor', tags);
  return {
    'tampered content': { ...a, content: 'forged' },
    'garbage signature': { ...b, sig: '0'.repeat(128) },
    'signature of another event': { ...c, sig: other.sig },
  };
}

const KINDS: Array<[string, number, string[][]]> = [
  ['kind-30443 key package', 30443, [['d', 'kp-1']]],
  ['kind-445 group message', 445, [['h', 'ab'.repeat(32)]]],
];

describe.each(KINDS)('%s from a relay', (_label, kind, tags) => {
  it('subscription(): the genuine event is delivered, every forgery is dropped', async () => {
    transport = createClientTransport({ relays: [relayUrl] });
    const genuine = sign(kind, 'genuine', tags);
    const seen: NostrEvent[] = [];
    const sub = transport.transport.subscription([relayUrl], { kinds: [kind] }).subscribe({ next: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 200)); // REQ is on the relay before injecting
    for (const forged of Object.values(forgeries(kind, tags))) relay.publish(forged);
    relay.publish(genuine);
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    sub.unsubscribe();
    expect(seen.map((e) => e.id)).toEqual([genuine.id]);
    expect(seen.every((e) => e.sig === genuine.sig)).toBe(true);
  });

  it('requestWithDeadline(): stored forgeries are not returned, the stored genuine event is', async () => {
    transport = createClientTransport({ relays: [relayUrl] });
    const genuine = sign(kind, 'genuine', tags);
    for (const forged of Object.values(forgeries(kind, tags))) relay.publish(forged);
    relay.publish(genuine);
    const res = await transport.transport.requestWithDeadline([relayUrl], { kinds: [kind] }, { timeoutMs: 3_000 });
    expect(res.events.map((e) => e.id)).toEqual([genuine.id]);
    expect(res.events[0].content).toBe('genuine');
  });
});
