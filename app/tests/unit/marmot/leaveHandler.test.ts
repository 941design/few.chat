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

function makeFakeGroup() {
  let listener: ((data: Uint8Array) => void) | null = null;
  return {
    on: vi.fn((_event: string, fn: (data: Uint8Array) => void) => { listener = fn; }),
    off: vi.fn(),
    async emit() { if (listener) await listener(new Uint8Array()); },
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
  it('happy-path: well-formed kind-13 rumor calls enqueueLeave once with (groupId, pubkey)', async () => {
    const deps = makeDeps();
    const handler = createLeaveIntentHandler(deps);
    const rumor = makeLeaveRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.enqueueLeave).toHaveBeenCalledOnce();
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY);
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
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY);
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
    expect(deps.enqueueLeave).toHaveBeenCalledWith(GROUP_ID, MEMBER_PUBKEY);
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
});
