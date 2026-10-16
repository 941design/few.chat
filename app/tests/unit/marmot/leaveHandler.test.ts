/**
 * Unit tests for handlers/leaveHandler.ts
 *
 * Covers AC-HANDLER-3, AC-HANDLER-4, AC-HANDLER-6.
 *
 * Design: tests call createLeaveIntentHandler with vi.fn() spies injected as
 * deps, then call handler.handle() directly. Mirrors pollHandler.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── idb-keyval mock (Map-backed, required by transitive imports) ─────────────
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

// ─── @internet-privacy/marmot-ts mock ────────────────────────────────────────
let mockRumor: ReturnType<typeof makeLeaveRumor> | null = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createLeaveIntentHandler } = await import('@/src/lib/marmot/handlers/leaveHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { LEAVE_INTENT_KIND } = await import('@/src/lib/marmot/leaveSync');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MEMBER_PUBKEY = 'aa'.repeat(32);
const SELF_PUBKEY = 'cc'.repeat(32);
const GROUP_ID = 'group-leave-test';

function makeLeaveRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({ pubkey: MEMBER_PUBKEY });
  return {
    id: 'leave-intent-' + 'ff'.repeat(26),
    pubkey: MEMBER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: LEAVE_INTENT_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx() {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex: SELF_PUBKEY,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
// From S3 onward this is load-bearing: leaveHandler's forced-removal gate
// (AC-FORCE-3) compares payload.pubkey against sender.pubkey.
function makeSender(pubkey: string = MEMBER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

function makeDeps() {
  return {
    enqueueLeave: vi.fn(),
  };
}

// S3 (marmot-ts 0.7.0 authenticated-sender migration): the dispatcher now
// registers TWO listeners — 'authenticatedApplicationMessage' (message-
// carrying) and 'unauthenticatedMessage' (diagnostic-only, AC-OBS-1). A
// single shared `listener` variable would be silently overwritten by the
// second .on() call; listeners are tracked per event name instead. emit()
// passes the payload shape the dispatcher now expects
// ({message, senderPubkey, senderLeafIndex}), with senderPubkey sourced from
// the currently-configured mockRumor so the dispatcher's sender-vs-rumor
// choke-point trivially matches (mirroring the old fallback sender).
function makeFakeGroup() {
  const listeners = new Map<string, (payload: never) => void | Promise<void>>();
  return {
    on: vi.fn((event: string, fn: (payload: never) => void | Promise<void>) => { listeners.set(event, fn); }),
    off: vi.fn((event: string, _fn: (payload: never) => void | Promise<void>) => { listeners.delete(event); }),
    async emit() {
      const fn = listeners.get('authenticatedApplicationMessage');
      if (fn) await fn({ message: new Uint8Array(), senderPubkey: mockRumor?.pubkey ?? '', senderLeafIndex: 0 } as never);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
  mockRumor = null;
});

// ---- LEAVE_INTENT ------------------------------------------------------------

describe('leaveHandler / LEAVE_INTENT', () => {
  it('happy-path: well-formed kind-13 rumor calls enqueueLeave once with (groupId, pubkey, rumorId)', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.enqueueLeave).toHaveBeenCalledOnce();
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY, rumor.id, { replayed: false });
  });

  it('returns enqueueLeave\'s promise so the dispatcher acks the journal entry only after the durable write settled (bug: pending-member-removals-not-persisted)', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((r) => { release = r; });
    const deps = { enqueueLeave: vi.fn(() => persisted) };
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor();
    const result = handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey));
    expect(result).toBe(persisted);
    release();
    await result;
  });

  it('passes the dispatcher\'s replayed flag through to enqueueLeave (only an explicit true counts)', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor();
    await handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey), { replayed: true });
    await handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey), { replayed: false });
    await handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey));
    expect(deps.enqueueLeave.mock.calls.map((c) => c[3])).toEqual([{ replayed: true }, { replayed: false }, { replayed: false }]);
  });

  it('propagates a rejected durable write, so the dispatcher keeps the journal entry (bug: journal-ack-before-durable-side-effects)', async () => {
    const deps = { enqueueLeave: vi.fn(() => Promise.reject(new Error('QuotaExceeded'))) };
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor();
    await expect(handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey))).rejects.toThrow('QuotaExceeded');
  });

  it('malformed payload (missing pubkey): does NOT call enqueueLeave', () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor({ content: '{ "wrongField": "value" }' });
    const ctx = makeCtx();

    expect(() => handler.handle(rumor, ctx, makeSender(rumor.pubkey))).not.toThrow();
    expect(deps.enqueueLeave).not.toHaveBeenCalled();
  });

  it('malformed payload (invalid JSON): does NOT call enqueueLeave', () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor({ content: '{ bad json }' });
    const ctx = makeCtx();

    expect(() => handler.handle(rumor, ctx, makeSender(rumor.pubkey))).not.toThrow();
    expect(deps.enqueueLeave).not.toHaveBeenCalled();
  });

  // ---- AC-FORCE-3: forced-removal rule (subject === sender) --------------

  it('AC-FORCE-3 negative: payload.pubkey (victim) !== sender.pubkey (attacker) does NOT enqueue a removal', async () => {
    const VICTIM_PUBKEY = 'bb'.repeat(32);
    const ATTACKER_PUBKEY = 'dd'.repeat(32);
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    // The rumor is authored (outer envelope) by the attacker, naming the
    // victim as the leave subject in the message BODY — the forced-removal
    // shape described in spec.md's Problem section.
    const rumor = makeLeaveRumor({
      pubkey: ATTACKER_PUBKEY,
      content: JSON.stringify({ pubkey: VICTIM_PUBKEY }),
    });
    const ctx = makeCtx();
    // Divergent sender: simulates having already passed the dispatcher's
    // choke-point drop (sender.pubkey === rumor.pubkey there), landing at
    // the handler with an authenticated sender that is NOT the named subject.
    const sender = makeSender(ATTACKER_PUBKEY);

    await handler.handle(rumor, ctx, sender);

    expect(deps.enqueueLeave).not.toHaveBeenCalled();
  });

  it('AC-FORCE-3 positive: payload.pubkey === sender.pubkey (self-departure) enqueues the removal', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor({
      pubkey: MEMBER_PUBKEY,
      content: JSON.stringify({ pubkey: MEMBER_PUBKEY }),
    });
    const ctx = makeCtx();
    const sender = makeSender(MEMBER_PUBKEY);

    await handler.handle(rumor, ctx, sender);

    expect(deps.enqueueLeave).toHaveBeenCalledOnce();
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY, rumor.id, { replayed: false });
  });

  it('AC-FORCE-3 edge: payload.pubkey and sender.pubkey match only after case normalization still enqueues', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    // Body pubkey normalized to lowercase by parseLeaveIntent; sender.pubkey
    // supplied in mixed case (e.g. a differently-cased but equal identity
    // from an upstream source) must still compare equal.
    const rumor = makeLeaveRumor({
      pubkey: MEMBER_PUBKEY,
      content: JSON.stringify({ pubkey: MEMBER_PUBKEY.toUpperCase() }),
    });
    const ctx = makeCtx();
    const sender = makeSender(MEMBER_PUBKEY.toUpperCase());

    await handler.handle(rumor, ctx, sender);

    expect(deps.enqueueLeave).toHaveBeenCalledOnce();
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY, rumor.id, { replayed: false });
  });

  it('duplicate-id: dispatcher LRU prevents second enqueueLeave call', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makeLeaveRumor({ id: 'dup-leave-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    expect(deps.enqueueLeave).toHaveBeenCalledOnce();
  });

  // ---- AC-XCUT-3: interleaving-order independence (property test) --------

  it('AC-XCUT-3 (property test over concurrent leave-intent interleavings): a removal is enqueued for a subject iff that subject\'s own leave-intent was sender-matched — never a function of interleaving order', async () => {
    const VICTIM_PUBKEY = 'bb'.repeat(32);
    const ATTACKER_PUBKEY = 'dd'.repeat(32);
    const OTHER_SUBJECT_PUBKEY = 'ee'.repeat(32);
    const ctx = makeCtx();

    // Self-departure: subject === sender, MUST enqueue (GROUP_ID, MEMBER_PUBKEY).
    const matched1 = {
      rumor: makeLeaveRumor({
        id: 'xcut-matched1',
        pubkey: MEMBER_PUBKEY,
        content: JSON.stringify({ pubkey: MEMBER_PUBKEY }),
      }),
      sender: makeSender(MEMBER_PUBKEY),
    };
    // Forced-removal shape (attacker naming a victim): subject !== sender,
    // MUST NOT enqueue anything for the victim.
    const mismatched = {
      rumor: makeLeaveRumor({
        id: 'xcut-mismatched',
        pubkey: ATTACKER_PUBKEY,
        content: JSON.stringify({ pubkey: VICTIM_PUBKEY }),
      }),
      sender: makeSender(ATTACKER_PUBKEY),
    };
    // A second, distinct sender-matched self-departure arriving mid-debounce.
    const matched2 = {
      rumor: makeLeaveRumor({
        id: 'xcut-matched2',
        pubkey: OTHER_SUBJECT_PUBKEY,
        content: JSON.stringify({ pubkey: OTHER_SUBJECT_PUBKEY }),
      }),
      sender: makeSender(OTHER_SUBJECT_PUBKEY),
    };
    // A resend (distinct rumor id, same subject/sender) of matched1 — the
    // handler itself has no idempotency, so this MUST enqueue again.
    const duplicateMatched1 = {
      rumor: makeLeaveRumor({
        id: 'xcut-duplicate-matched1',
        pubkey: MEMBER_PUBKEY,
        content: JSON.stringify({ pubkey: MEMBER_PUBKEY }),
      }),
      sender: makeSender(MEMBER_PUBKEY),
    };

    const interleavings = [
      [matched1, mismatched, matched2, duplicateMatched1],
      [mismatched, matched2, matched1, duplicateMatched1],
      [matched2, duplicateMatched1, mismatched, matched1],
    ];

    for (const order of interleavings) {
      const deps = makeDeps();
      const handler = createLeaveIntentHandler(deps);

      for (const { rumor, sender } of order) {
        await handler.handle(rumor, ctx, sender);
      }

      const calls = deps.enqueueLeave.mock.calls;
      expect(calls.filter(([groupId, pk]) => groupId === GROUP_ID && pk === MEMBER_PUBKEY)).toHaveLength(2);
      expect(calls.filter(([groupId, pk]) => groupId === GROUP_ID && pk === OTHER_SUBJECT_PUBKEY)).toHaveLength(1);
      expect(calls.every(([, pk]) => pk !== VICTIM_PUBKEY)).toBe(true);
      expect(deps.enqueueLeave).toHaveBeenCalledTimes(3);
    }
  });
});
