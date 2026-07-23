/**
 * Unit tests for handlers/reactionHandler.ts
 *
 * Covers AC-AR-10, AC-AR-11, AC-AR-20.
 *
 * Design: tests call createReactionHandler with vi.fn() spies injected as deps,
 * then call handler.handle() directly. Dispatcher-level LRU dedup is tested via
 * a createDispatcher wrapper for the duplicate-id tests (AC-AR-10 / AC-AR-11).
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
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => null),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createReactionHandler, REACTION_RUMOR_KIND } = await import('@/src/lib/marmot/handlers/reactionHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GROUP_ID = 'group-reaction-test';
const PEER_PUBKEY = 'cc'.repeat(32);
const TARGET_MESSAGE_ID = 'target-msg-id-' + 'aa'.repeat(25);

function makeReactionRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  return {
    id: 'reaction-rumor-id-' + 'dd'.repeat(23),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: REACTION_RUMOR_KIND,
    content: '👍',
    tags: [['e', TARGET_MESSAGE_ID], ['k', '9']],
    ...overrides,
  };
}

function makeCtx() {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex: 'ee'.repeat(32),
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
function makeSender(pubkey: string = PEER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

type Deps = {
  loadMessages: ReturnType<typeof vi.fn>;
  applyInboundRumor: ReturnType<typeof vi.fn>;
  setReactionsVersion: ReturnType<typeof vi.fn>;
};

function makeDeps(targetExists = true): Deps {
  const messages: { id: string; content: string; senderPubkey: string; groupId: string; createdAt: number }[] = targetExists
    ? [{ id: TARGET_MESSAGE_ID, content: 'hi', senderPubkey: 'ff'.repeat(32), groupId: GROUP_ID, createdAt: 1000 }]
    : [];
  return {
    loadMessages: vi.fn(async () => ({ messages, refetchIds: [] as string[] })),
    applyInboundRumor: vi.fn(async () => ({ applied: true })),
    setReactionsVersion: vi.fn(),
  };
}

function makeFakeGroup() {
  let listener: ((data: Uint8Array) => void) | null = null;
  return {
    on: vi.fn((_event: string, fn: (data: Uint8Array) => void) => {
      listener = fn;
    }),
    off: vi.fn((_event: string, _fn: (data: Uint8Array) => void) => {
      listener = null;
    }),
    emitAsync: async (data: Uint8Array) => {
      if (listener) await listener(data);
    },
  };
}

async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
});

describe('reactionHandler', () => {
  it('REACTION_RUMOR_KIND is 7', () => {
    expect(REACTION_RUMOR_KIND).toBe(7);
  });

  it('AC-AR-10 happy-path: target message exists — applyInboundRumor called once, setReactionsVersion called once', async () => {
    const deps = makeDeps(true); // target exists
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.applyInboundRumor).toHaveBeenCalledOnce();
    expect(deps.applyInboundRumor).toHaveBeenCalledWith(
      { kind: 'group', groupId: GROUP_ID },
      rumor,
      makeSender(rumor.pubkey),
    );
    expect(deps.setReactionsVersion).toHaveBeenCalledOnce();
  });

  it('AC-ATTR-6: applyInboundRumor is called with sender as its third argument (forwarding assertion — attribution logic itself lives in reactions/api.ts)', async () => {
    const deps = makeDeps(true);
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor();
    const ctx = makeCtx();
    const forgedSender = makeSender('aa'.repeat(32)); // deliberately distinct from rumor.pubkey

    await handler.handle(rumor, ctx, forgedSender);

    expect(deps.applyInboundRumor).toHaveBeenCalledWith(
      { kind: 'group', groupId: GROUP_ID },
      rumor,
      forgedSender,
    );
  });

  it('AC-AR-10 target-message-not-found: IDB returns empty array — applyInboundRumor NOT called', async () => {
    const deps = makeDeps(false); // no messages in IDB
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.applyInboundRumor).not.toHaveBeenCalled();
    expect(deps.setReactionsVersion).not.toHaveBeenCalled();
  });

  it('malformed rumor: no e-tag — handler returns without calling applyInboundRumor', async () => {
    const deps = makeDeps(true);
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor({ tags: [] }); // no e-tag
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.applyInboundRumor).not.toHaveBeenCalled();
  });

  it('applyInboundRumor returns null — setReactionsVersion NOT called', async () => {
    const deps = makeDeps(true);
    deps.applyInboundRumor = vi.fn(async () => null); // null = dedup/discard
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.applyInboundRumor).toHaveBeenCalledOnce();
    expect(deps.setReactionsVersion).not.toHaveBeenCalled();
  });

  it('AC-AR-11 duplicate-id via dispatcher LRU: second dispatch with same id — applyInboundRumor called only once', async () => {
    // Wire through the real dispatcher to test LRU dedup at dispatcher level.
    const { deserializeApplicationData } = await import('@internet-privacy/marmot-ts');
    const deps = makeDeps(true);
    const handler = createReactionHandler(deps);

    const rumor = makeReactionRumor({ id: 'dup-reaction-id' });
    let mockReturn: typeof rumor | null = null;
    vi.mocked(deserializeApplicationData).mockImplementation(() => mockReturn as any);

    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();
    dispatcher.subscribe(group, ctx);

    // First dispatch
    mockReturn = rumor;
    await group.emitAsync(new Uint8Array());
    await flushPromises();

    // Second dispatch with same id — dispatcher LRU should block it
    mockReturn = rumor;
    await group.emitAsync(new Uint8Array());
    await flushPromises();

    expect(deps.applyInboundRumor).toHaveBeenCalledOnce(); // only once, not twice
  });

  it('AC-AR-10 duplicate-id called directly: handler is idempotent — reaction store dedup handles it', async () => {
    // When called directly twice (without dispatcher), handler calls applyInboundRumor twice.
    // The reaction store's own dedup prevents double-storage.
    const deps = makeDeps(true);
    const handler = createReactionHandler(deps);
    const rumor = makeReactionRumor({ id: 'direct-dup-id' });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));
    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    // Handler itself does not dedup — that's dispatcher's job
    expect(deps.applyInboundRumor).toHaveBeenCalledTimes(2);
  });
});
