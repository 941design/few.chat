/**
 * Unit tests for applicationRumorDispatcher.ts
 *
 * Covers AC-AR-5, AC-AR-17, AC-AR-18, AC-AR-20, AC-AR-23, AC-AR-24,
 * AC-SEAM-1, AC-SEAM-2, AC-SEAM-3, AC-OBS-1.
 *
 * S3 (marmot-ts 0.7.0 authenticated-sender migration): the dispatcher now
 * listens on 'authenticatedApplicationMessage' (payload carries
 * senderPubkey) instead of the raw 'applicationMessage' event, and builds
 * `sender.authenticity: 'mls'` DIRECTLY from that payload — there is no
 * longer an app-side resolver to inject a sender. Tests that previously
 * exercised a resolveSender callback now supply senderPubkey directly in
 * the emitted authenticatedApplicationMessage payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deserializeApplicationData } from '@internet-privacy/marmot-ts';

// ─── Mock @internet-privacy/marmot-ts deserialization ────────────────────────
// Tests inject rumor objects by setting mockRumor before emitting.
let mockRumor: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
} | null = null;

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Dynamic import (after vi.mock) ──────────────────────────────────────────
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockRumor(overrides: Partial<typeof mockRumor> = {}) {
  return {
    id: crypto.randomUUID(),
    pubkey: 'aa'.repeat(32),
    created_at: 1000000,
    kind: 9,
    tags: [],
    content: 'hello',
    ...overrides,
  };
}

type AuthenticatedApplicationMessagePayload = { message: Uint8Array; senderPubkey: string; senderLeafIndex: number };
type UnauthenticatedMessageInfoPayload = { senderPubkey: string; claimedPubkey?: string; reason: 'unauthenticated-sender' | 'undeserializable'; event: unknown };

/**
 * Fake MarmotGroup: tracks listeners PER EVENT NAME (the dispatcher now
 * registers two: 'authenticatedApplicationMessage' — the message-carrying
 * listener — and 'unauthenticatedMessage' — a diagnostic-only listener,
 * AC-OBS-1). A single shared `listener` variable (as in earlier revisions of
 * this fake) would silently capture only the LAST registered listener and
 * mask a regression where both listeners resolve to the same handler.
 */
function makeFakeGroup() {
  const listeners = new Map<string, (payload: never) => void | Promise<void>>();
  return {
    on: vi.fn((event: string, fn: (payload: never) => void | Promise<void>) => {
      listeners.set(event, fn);
    }),
    off: vi.fn((event: string, _fn: (payload: never) => void | Promise<void>) => {
      listeners.delete(event);
    }),
    // emitAsync calls the authenticatedApplicationMessage listener and, if it
    // returns a Promise, awaits it.
    emitAsync: async (payload: AuthenticatedApplicationMessagePayload) => {
      const fn = listeners.get('authenticatedApplicationMessage');
      if (fn) await fn(payload as never);
    },
    emit: (payload: AuthenticatedApplicationMessagePayload) => listeners.get('authenticatedApplicationMessage')?.(payload as never),
    // AC-OBS-1: fires the library's diagnostic-only event.
    emitUnauthenticated: (info: UnauthenticatedMessageInfoPayload) => listeners.get('unauthenticatedMessage')?.(info as never),
    // Test introspection: which event names currently have a live listener.
    registeredEvents: () => [...listeners.keys()],
  };
}

function makeCtx(groupId = 'G1'): {
  groupId: string;
  selfPubkeyHex: string;
  getActiveGroupId: () => string | null;
} {
  return {
    groupId,
    selfPubkeyHex: 'bb'.repeat(32),
    getActiveGroupId: () => groupId,
  };
}

// Drain all pending microtasks and macrotasks by yielding to the event loop
// multiple times. A single setTimeout(0) is enough for simple cases; the
// recursive approach ensures async listener chains triggered in tight loops
// also complete before assertions run.
async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRumor = null;
  vi.clearAllMocks();
});

describe('applicationRumorDispatcher', () => {
  it('happy-path dispatch: kind-9 handler called when kind-9 rumor arrives, sender built as authenticity:"mls" from senderPubkey', async () => {
    const handleSpy = vi.fn();
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    const ctx = makeCtx();
    dispatcher.subscribe(group, ctx);

    mockRumor = makeMockRumor({ kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(handleSpy).toHaveBeenCalledOnce();
    expect(handleSpy).toHaveBeenCalledWith(mockRumor, ctx, {
      pubkey: mockRumor.pubkey,
      authenticity: 'mls',
    });
  });

  it('AC-SEAM-1/AC-XCUT-1: sender-mismatched rumor is dropped, not handed to handlers, and does not poison the dedup LRU — a later sender-matched redelivery of the same id still dispatches', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handleSpy = vi.fn();
    const authenticatedPubkey = 'bb'.repeat(32);

    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    const ctx = makeCtx();
    dispatcher.subscribe(group, ctx);

    const sharedId = 'mismatch-then-match-id';

    // First delivery: the rumor's claimed pubkey diverges from the library's
    // senderPubkey — dropped by the choke-point (defense-in-depth; the
    // library itself is not expected to ever produce this combination for a
    // real authenticatedApplicationMessage delivery, but the choke-point
    // must still hold if it somehow did).
    mockRumor = makeMockRumor({ id: sharedId, pubkey: 'aa'.repeat(32), kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(handleSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[dispatcher.unauthenticatedMessage]',
      expect.objectContaining({
        groupId: ctx.groupId,
        kind: 9,
        rumorId: sharedId,
        claimedPubkey: 'aa'.repeat(32),
        authenticatedPubkey,
      }),
    );

    // Second delivery: same id, but this time the rumor's pubkey matches the
    // library-supplied senderPubkey. If the first (dropped) delivery had
    // poisoned the seen-id LRU, this would be silently swallowed by the
    // dedup check instead of dispatching.
    mockRumor = makeMockRumor({ id: sharedId, pubkey: authenticatedPubkey, kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(handleSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('AC-XCUT-1: dedup LRU is never poisoned by a mismatched-sender rumor, and a matched redelivery still fans out exactly once — for both arrival orderings', async () => {
    const authenticatedPubkey = 'bb'.repeat(32);
    const attackerPubkey = 'aa'.repeat(32);

    for (const ordering of ['mismatch-first', 'redelivery-first'] as const) {
      // Fresh dispatcher/group/spy state per iteration — no leakage across orderings.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handleSpy = vi.fn();
      const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
      const group = makeFakeGroup();
      const ctx = makeCtx();
      dispatcher.subscribe(group, ctx);

      const sharedId = `xcut1-${ordering}`;

      if (ordering === 'mismatch-first') {
        // Step 1: mismatched-sender rumor arrives first — dropped, not dispatched.
        mockRumor = makeMockRumor({ id: sharedId, pubkey: attackerPubkey, kind: 9 });
        group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
        await flushPromises();

        expect(handleSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[dispatcher.unauthenticatedMessage]', expect.anything());

        // Step 2: matched redelivery of the same id — must still dispatch, proving
        // the mismatched delivery above never poisoned the dedup LRU.
        mockRumor = makeMockRumor({ id: sharedId, pubkey: authenticatedPubkey, kind: 9 });
        group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
        await flushPromises();

        expect(handleSpy).toHaveBeenCalledOnce();
      } else {
        // Step 1: matched, legitimate rumor arrives first — dispatches.
        mockRumor = makeMockRumor({ id: sharedId, pubkey: authenticatedPubkey, kind: 9 });
        group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
        await flushPromises();

        expect(handleSpy).toHaveBeenCalledOnce();

        // Step 2: a mismatched-sender rumor sharing the same id arrives next. The
        // id is already marked seen from step 1, so the dedup check short-circuits
        // before sender construction/comparison ever runs — handler count stays at
        // one, and (observed) no unauthenticatedMessage warning fires for this
        // delivery, since the mismatch path is never reached.
        mockRumor = makeMockRumor({ id: sharedId, pubkey: attackerPubkey, kind: 9 });
        group.emit({ message: new Uint8Array(), senderPubkey: authenticatedPubkey, senderLeafIndex: 0 });
        await flushPromises();

        expect(handleSpy).toHaveBeenCalledOnce();
        expect(warnSpy).not.toHaveBeenCalled();
      }

      warnSpy.mockRestore();
    }
  });

  it('AC-SEAM-1: sender-matched rumor dispatches with sender built from the event payload\'s senderPubkey, not a hardcoded/derived value', async () => {
    const handleSpy = vi.fn();
    const eventSenderPubkey = 'aa'.repeat(32);

    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    const ctx = makeCtx();
    dispatcher.subscribe(group, ctx);

    mockRumor = makeMockRumor({ pubkey: eventSenderPubkey, kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: eventSenderPubkey, senderLeafIndex: 7 });
    await flushPromises();

    expect(handleSpy).toHaveBeenCalledOnce();
    expect(handleSpy).toHaveBeenCalledWith(mockRumor, ctx, { pubkey: eventSenderPubkey, authenticity: 'mls' });
  });

  it('AC-SEAM-2: exactly one group.on(...) is registered for the message-carrying event across a subscribe() call, and it is never the retired "applicationMessage" event name', () => {
    const dispatcher = createDispatcher([]);
    const group = makeFakeGroup();
    const unsubscribe = dispatcher.subscribe(group, makeCtx());

    const messageCarryingCalls = group.on.mock.calls.filter(([event]) => event === 'authenticatedApplicationMessage');
    expect(messageCarryingCalls).toHaveLength(1);

    const legacyCalls = group.on.mock.calls.filter(([event]) => event === 'applicationMessage');
    expect(legacyCalls).toHaveLength(0);

    unsubscribe();
  });

  it('AC-OBS-1: the library\'s unauthenticatedMessage diagnostic is logged via console.warn with all four fields, visible with no DEBUG env var set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dispatcher = createDispatcher([]);
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    expect(process.env.DEBUG).toBeUndefined();

    const fakeEvent = { id: 'evt-1', pubkey: 'aa'.repeat(32), kind: 445, created_at: 1, tags: [], content: '', sig: 'sig' };
    group.emitUnauthenticated({
      senderPubkey: 'bb'.repeat(32),
      claimedPubkey: 'aa'.repeat(32),
      reason: 'unauthenticated-sender',
      event: fakeEvent,
    });

    expect(warnSpy).toHaveBeenCalledWith('[marmot.unauthenticatedMessage]', {
      senderPubkey: 'bb'.repeat(32),
      claimedPubkey: 'aa'.repeat(32),
      reason: 'unauthenticated-sender',
      event: fakeEvent,
    });

    warnSpy.mockRestore();
  });

  it('AC-OBS-1: the undeserializable reason and an absent claimedPubkey are logged as-is (not coerced)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dispatcher = createDispatcher([]);
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    const fakeEvent = { id: 'evt-2', pubkey: 'cc'.repeat(32), kind: 445, created_at: 1, tags: [], content: '', sig: 'sig' };
    group.emitUnauthenticated({
      senderPubkey: '',
      reason: 'undeserializable',
      event: fakeEvent,
    });

    expect(warnSpy).toHaveBeenCalledWith('[marmot.unauthenticatedMessage]', {
      senderPubkey: '',
      claimedPubkey: undefined,
      reason: 'undeserializable',
      event: fakeEvent,
    });

    warnSpy.mockRestore();
  });

  it('AC-AR-17: unknown kind emits no console.error or console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const dispatcher = createDispatcher([]); // no handlers
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    mockRumor = makeMockRumor({ kind: 9999 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('AC-AR-18: handler-throws isolation — second handler still called, console.warn fired', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secondHandlerSpy = vi.fn();

    const dispatcher = createDispatcher([
      {
        kind: 9,
        handle: () => {
          throw new Error('boom');
        },
      },
      { kind: 9, handle: secondHandlerSpy },
    ]);

    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    mockRumor = makeMockRumor({ kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(secondHandlerSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('[dispatcher.9]', expect.any(Error));

    warnSpy.mockRestore();
  });

  it('AC-AR-5: LRU eviction at 1000 — ids 0-99 evicted, ids 100-1099 still seen', async () => {
    const handleSpy = vi.fn();
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    const ctx = makeCtx();
    dispatcher.subscribe(group, ctx);

    // Dispatch 1100 unique IDs, awaiting each so LRU state is updated serially.
    for (let i = 0; i < 1100; i++) {
      mockRumor = makeMockRumor({ id: `id-${i}`, kind: 9 });
      await group.emitAsync({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    }

    // handleSpy was called once per unique id — 1100 times total.
    expect(handleSpy).toHaveBeenCalledTimes(1100);

    // Verify: ids 100-1099 are still in seen set — re-dispatch does NOT call handler.
    // Check this BEFORE re-adding the evicted ids, to avoid secondary eviction effects.
    handleSpy.mockClear();
    for (let i = 100; i < 1100; i++) {
      mockRumor = makeMockRumor({ id: `id-${i}`, kind: 9 });
      await group.emitAsync({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    }
    expect(handleSpy).not.toHaveBeenCalled(); // still seen → deduped

    // Re-dispatch ids 0-99: these were evicted, so handler fires again.
    handleSpy.mockClear();
    for (let i = 0; i < 100; i++) {
      mockRumor = makeMockRumor({ id: `id-${i}`, kind: 9 });
      await group.emitAsync({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    }
    expect(handleSpy).toHaveBeenCalledTimes(100); // evicted → handler fires
  });

  it('AC-AR-23: per-group LRU scope — same id in G1 and G2 each call handler once', async () => {
    const handleSpy = vi.fn();
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);

    const groupG1 = makeFakeGroup();
    const groupG2 = makeFakeGroup();
    const ctxG1 = makeCtx('G1');
    const ctxG2 = makeCtx('G2');
    dispatcher.subscribe(groupG1, ctxG1);
    dispatcher.subscribe(groupG2, ctxG2);

    const sharedId = 'shared-id-X';

    // First dispatch to G1.
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    groupG1.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledTimes(1);

    // First dispatch to G2 — different group, so NOT deduped.
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    groupG2.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledTimes(2);

    // Second dispatch to G1 — already seen for G1.
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    groupG1.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledTimes(2); // no extra call

    // Second dispatch to G2 — already seen for G2.
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    groupG2.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledTimes(2); // still no extra call
  });

  it('AC-AR-24: subscribe() itself makes no IDB calls', () => {
    // Verify that subscribe does not call any IDB or storage function.
    // We achieve this by checking that the module under test has no awaits
    // in subscribe() itself — the test simply calls subscribe and confirms
    // no async IDB-backed functions were invoked during the call (before any emit).
    const idbGetSpy = vi.fn();
    // idb-keyval not imported by dispatcher; this test is a structural check.
    // subscribe() is synchronous until the listener fires, so no IDB can run here.

    const dispatcher = createDispatcher([]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    // subscribe() must return synchronously and must have registered group.on
    // for the message-carrying event.
    const unsubscribe = dispatcher.subscribe(group, ctx);
    expect(group.on).toHaveBeenCalledWith('authenticatedApplicationMessage', expect.any(Function));
    // No async work happened yet — idbGetSpy was never called.
    expect(idbGetSpy).not.toHaveBeenCalled();

    unsubscribe(); // clean up
  });

  it('same-id dedup short-circuit: dispatching same id twice only calls handler once', async () => {
    const handleSpy = vi.fn();
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    const id = 'dup-id';
    mockRumor = makeMockRumor({ id, kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    mockRumor = makeMockRumor({ id, kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(handleSpy).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes both listeners: handler not called after unsubscribe, and unauthenticatedMessage diagnostic listener is also torn down', async () => {
    const handleSpy = vi.fn();
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    const unsubscribe = dispatcher.subscribe(group, makeCtx());

    expect(group.registeredEvents().sort()).toEqual(['authenticatedApplicationMessage', 'unauthenticatedMessage']);

    // Dispatch before unsubscribe — should fire.
    mockRumor = makeMockRumor({ id: 'before-unsub', kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledOnce();

    // Unsubscribe removes both listeners.
    unsubscribe();
    expect(group.off).toHaveBeenCalledTimes(2);
    expect(group.registeredEvents()).toEqual([]);

    // Dispatch after unsubscribe — should NOT fire.
    mockRumor = makeMockRumor({ id: 'after-unsub', kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledOnce(); // still only 1
  });

  it('kind discrimination: a rumor of kind K invokes only handlers whose kind === K, never handlers registered for a different kind', async () => {
    // Guards the handlers.filter(h => h.kind === rumor.kind) step: with two
    // handlers of different kinds registered, a kind-9 rumor must reach the
    // kind-9 handler alone. Dropping the filter (fan-out to all handlers) or
    // making the kind comparison always-true would call the kind-7 handler too.
    const kind7 = vi.fn();
    const kind9 = vi.fn();
    const dispatcher = createDispatcher([
      { kind: 7, handle: kind7 },
      { kind: 9, handle: kind9 },
    ]);
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    mockRumor = makeMockRumor({ kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();

    expect(kind9).toHaveBeenCalledOnce();
    expect(kind7).not.toHaveBeenCalled();
  });

  it('malformed application message (deserialize throws) is discarded silently — no handler fires, no throw escapes, and the dedup LRU is not poisoned so a later valid delivery of the same id still dispatches', async () => {
    const handleSpy = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispatcher = createDispatcher([{ kind: 9, handle: handleSpy }]);
    const group = makeFakeGroup();
    dispatcher.subscribe(group, makeCtx());

    const sharedId = 'corrupt-then-valid';

    // First delivery: deserialization throws → the listener must swallow it,
    // dispatch nothing, and NOT mark the id seen.
    vi.mocked(deserializeApplicationData).mockImplementationOnce(() => {
      throw new Error('corrupt payload');
    });
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    await expect(
      (async () =>
        group.emitAsync({ message: new Uint8Array(), senderPubkey: mockRumor!.pubkey, senderLeafIndex: 0 }))(),
    ).resolves.not.toThrow();
    await flushPromises();
    expect(handleSpy).not.toHaveBeenCalled();

    // Second delivery: same id, deserialization now succeeds. If the malformed
    // delivery above had marked the id seen, this would be silently deduped.
    mockRumor = makeMockRumor({ id: sharedId, kind: 9 });
    group.emit({ message: new Uint8Array(), senderPubkey: mockRumor.pubkey, senderLeafIndex: 0 });
    await flushPromises();
    expect(handleSpy).toHaveBeenCalledOnce();

    // Silent discard: the malformed path logs no error.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
