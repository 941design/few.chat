/**
 * Unit tests for handlers/profileRequestHandler.ts
 *
 * Covers AC-AR-14, AC-AR-20.
 *
 * Design: tests call createProfileRequestHandler with vi.fn() spies injected
 * as deps, then call handler.handle() directly. Duplicate-id test uses the
 * dispatcher LRU layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── idb-keyval mock (Map-backed) ───────────────────────────────────────────
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

// ─── @internet-privacy/marmot-ts mock ────────────────────────────────────────
let mockRumor: ReturnType<typeof makeProfileRequestRumor> | null = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createProfileRequestHandler } = await import('@/src/lib/marmot/handlers/profileRequestHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { PROFILE_REQUEST_KIND } = await import('@/src/lib/marmot/profileRequestSync');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PEER_PUBKEY = 'bb'.repeat(32);
const SELF_PUBKEY = 'aa'.repeat(32);
const THIRD_PUBKEY = 'cc'.repeat(32);
const GROUP_ID = 'group-request-test';

function makeProfileRequestRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({
    type: 'profile_request',
    targetPubkey: THIRD_PUBKEY,
    nonce: 'abc123',
  });
  return {
    id: 'req-rumor-' + 'ee'.repeat(28),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: PROFILE_REQUEST_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx(selfPubkeyHex = SELF_PUBKEY) {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
// Unused in profileRequestHandler's body this story — only needed to satisfy
// the widened 3-arg handle() signature.
function makeSender(pubkey: string = PEER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

function makeDeps() {
  return {
    recordRequestEmitted: vi.fn(async () => {}),
    sendSelfProfile: vi.fn(async () => {}),
    handleIncomingProfileRequest: vi.fn(async () => {}),
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

describe('profileRequestHandler', () => {
  it('peer-request path: handleIncomingProfileRequest called, sendSelfProfile NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // targetPubkey is THIRD_PUBKEY (not self)
    const rumor = makeProfileRequestRumor();
    const ctx = makeCtx(SELF_PUBKEY); // self is SELF_PUBKEY, target is THIRD_PUBKEY

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.recordRequestEmitted.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.recordRequestEmitted.mock.calls[0][1]).toBe(THIRD_PUBKEY);

    expect(deps.handleIncomingProfileRequest).toHaveBeenCalledOnce();
    const { groupId, payload } = deps.handleIncomingProfileRequest.mock.calls[0][0];
    expect(groupId).toBe(GROUP_ID);
    expect(payload.targetPubkey).toBe(THIRD_PUBKEY);
    expect(payload.type).toBe('profile_request');

    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
  });

  it('self-target reply path: sendSelfProfile called, handleIncomingProfileRequest NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // Request targets SELF_PUBKEY
    const content = JSON.stringify({
      type: 'profile_request',
      targetPubkey: SELF_PUBKEY,
      nonce: 'xyz789',
    });
    const rumor = makeProfileRequestRumor({ content });
    const ctx = makeCtx(SELF_PUBKEY);

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

  it('malformed payload: does not throw, no side effects fired', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    const rumor = makeProfileRequestRumor({ content: '{ not valid request }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.recordRequestEmitted).not.toHaveBeenCalled();
    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

  it('duplicate-id: dispatcher LRU prevents second recordRequestEmitted call', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makeProfileRequestRumor({ id: 'dup-req-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    // LRU dedup: second emission of same id is skipped
    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
  });
});
