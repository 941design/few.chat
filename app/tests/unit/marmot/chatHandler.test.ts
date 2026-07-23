/**
 * Unit tests for handlers/chatHandler.ts
 *
 * Covers AC-AR-7, AC-AR-8, AC-AR-20.
 *
 * Design: tests call createChatHandler with vi.fn() spies injected as deps,
 * then call handler.handle() directly. The dispatcher LRU dedup layer is
 * tested separately in applicationRumorDispatcher.test.ts.
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
  parseMediaImetaTag: vi.fn(() => null),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createChatHandler } = await import('@/src/lib/marmot/handlers/chatHandler');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SELF_PUBKEY = 'aa'.repeat(32);
const PEER_PUBKEY = 'bb'.repeat(32);
const GROUP_ID = 'group-test-1';

function makeRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  return {
    id: 'rumor-id-' + 'cc'.repeat(28),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    content: 'hello world',
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<{
  groupId: string;
  selfPubkeyHex: string;
  getActiveGroupId: () => string | null;
}> = {}) {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex: SELF_PUBKEY,
    // Default: no group is the active view, so a peer message rings the bell
    // (INV-1). Individual tests override this to exercise the on-domain path.
    getActiveGroupId: () => null,
    ...overrides,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
// Defaults to PEER_PUBKEY, mirroring rumor.pubkey for every pre-existing test
// below (sender.pubkey === rumor.pubkey, authenticity: 'claimed').
function makeSender(pubkey: string = PEER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

function makeDeps() {
  return {
    appendMessage: vi.fn(async () => {}),
    incrementUnread: vi.fn(),
    // notification-domain-invariants (INV-2): called instead of incrementUnread
    // when the message's group is the active view.
    markAsRead: vi.fn(),
    setChatVersion: vi.fn(),
    // S5: resolve-after-append + edit-marked-kind-9 dispatch-routing deps.
    // Default resolvePendingSignalsForSlot to a 'noop' ChangeResult (nothing
    // buffered for the freshly-appended slot) — matches the no-signal-pending
    // case every pre-S5 test in this file exercises.
    applyDeleteEditSignal: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP_ID }, slotId: null, kind: 'discarded' as const })),
    resolvePendingSignalsForSlot: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: GROUP_ID }, slotId: null, kind: 'noop' as const })),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
});

describe('chatHandler', () => {
  it('happy-path text message: calls appendMessage with correct shape', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ content: 'hello from peer', tags: [] });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.appendMessage).toHaveBeenCalledOnce();
    const [groupId, msg] = deps.appendMessage.mock.calls[0];
    expect(groupId).toBe(GROUP_ID);
    expect(msg.id).toBe(rumor.id);
    expect(msg.content).toBe('hello from peer');
    expect(msg.senderPubkey).toBe(PEER_PUBKEY);
    expect(msg.groupId).toBe(GROUP_ID);
    expect(msg.createdAt).toBe(rumor.created_at * 1000);
  });

  it('AC-AR-7: imeta tag parse — attachments populated from tags', async () => {
    // Mock parseMediaImetaTag to return a proper attachment
    const { parseMediaImetaTag } = await import('@internet-privacy/marmot-ts');
    vi.mocked(parseMediaImetaTag).mockImplementation((tag: string[]) => {
      // Parse the url and m fields from the imeta tag entries
      const fields: Record<string, string> = {};
      for (let i = 1; i < tag.length; i++) {
        const [key, ...rest] = tag[i].split(' ');
        if (key && rest.length > 0) fields[key] = rest.join(' ');
      }
      if (!fields['url']) return null;
      return { url: fields['url'], type: fields['m'] ?? 'application/octet-stream' } as any;
    });

    const deps = makeDeps();
    const handler = createChatHandler(deps);
    // Image message with imeta tag
    const imageContent = JSON.stringify({ type: 'image', version: 1, caption: 'test' });
    const rumor = makeRumor({
      content: imageContent,
      tags: [['imeta', 'url https://img.example/a.jpg', 'm image/jpeg']],
    });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.appendMessage).toHaveBeenCalledOnce();
    const [, msg] = deps.appendMessage.mock.calls[0];
    expect(msg.attachments).toBeDefined();
    // The attachment was parsed — should have full set to the parsed attachment
    expect(msg.attachments?.full).toBeDefined();
    expect(msg.attachments?.full?.url).toBe('https://img.example/a.jpg');
    expect((msg.attachments?.full as any)?.type).toBe('image/jpeg');
  });

  it('malformed payload: non-string content does not throw', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    // Force non-string content through type cast
    const rumor = makeRumor({ content: 42 as unknown as string });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    // appendMessage still called with empty string content
    expect(deps.appendMessage).toHaveBeenCalledOnce();
    const [, msg] = deps.appendMessage.mock.calls[0];
    expect(msg.content).toBe('');
  });

  it('duplicate-id: appendMessage called twice (dedup is dispatcher responsibility)', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ id: 'dup-id-1' });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));
    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    // Handler itself does not dedup — dispatcher LRU does
    expect(deps.appendMessage).toHaveBeenCalledTimes(2);
  });

  it('AC-AR-8: own-send skip — incrementUnread NOT called when pubkey === selfPubkeyHex', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ pubkey: SELF_PUBKEY }); // own-send
    const ctx = makeCtx({ selfPubkeyHex: SELF_PUBKEY });

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.incrementUnread).not.toHaveBeenCalled();
    // appendMessage and setChatVersion still called for the IDB write
    expect(deps.appendMessage).toHaveBeenCalledOnce();
    expect(deps.setChatVersion).toHaveBeenCalledOnce();
  });

  it('AC-AR-8: peer in background group — incrementUnread called with groupId', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ pubkey: PEER_PUBKEY }); // different pubkey
    // Active group is G2, rumor is for G1
    const ctx = makeCtx({
      groupId: 'G1',
      selfPubkeyHex: SELF_PUBKEY,
      getActiveGroupId: () => 'G2',
    });

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.incrementUnread).toHaveBeenCalledOnce();
    expect(deps.incrementUnread).toHaveBeenCalledWith('G1');
    expect(deps.incrementUnread).not.toHaveBeenCalledWith('G2');
  });

  it('INV-2 (notification-domain-invariants): peer message in the ACTIVE group does NOT ring the bell; markAsRead is called instead', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ pubkey: PEER_PUBKEY });
    // The rumor's group IS the active view.
    const ctx = makeCtx({
      groupId: 'G1',
      selfPubkeyHex: SELF_PUBKEY,
      getActiveGroupId: () => 'G1',
    });

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.incrementUnread).not.toHaveBeenCalled();
    expect(deps.markAsRead).toHaveBeenCalledOnce();
    expect(deps.markAsRead).toHaveBeenCalledWith('G1');
  });

  it('setChatVersion called on every successful handle', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const ctx = makeCtx();

    await handler.handle(makeRumor({ id: 'r1' }), ctx, makeSender());
    await handler.handle(makeRumor({ id: 'r2' }), ctx, makeSender());

    expect(deps.setChatVersion).toHaveBeenCalledTimes(2);
  });

  // ─── S5: resolve-after-append wiring ────────────────────────────────────

  it('S5: resolvePendingSignalsForSlot is called after appendMessage, before setChatVersion, for a plain original', async () => {
    const deps = makeDeps();
    const callOrder: string[] = [];
    deps.appendMessage.mockImplementation(async () => { callOrder.push('appendMessage'); });
    deps.resolvePendingSignalsForSlot.mockImplementation(async () => {
      callOrder.push('resolvePendingSignalsForSlot');
      return { thread: { kind: 'group' as const, groupId: GROUP_ID }, slotId: null, kind: 'noop' as const };
    });
    deps.setChatVersion.mockImplementation(() => { callOrder.push('setChatVersion'); });

    const handler = createChatHandler(deps);
    const rumor = makeRumor({ id: 'orig-1' });
    await handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey));

    expect(deps.resolvePendingSignalsForSlot).toHaveBeenCalledOnce();
    expect(deps.resolvePendingSignalsForSlot).toHaveBeenCalledWith(
      { kind: 'group', groupId: GROUP_ID },
      'orig-1',
      PEER_PUBKEY,
    );
    expect(callOrder).toEqual(['appendMessage', 'resolvePendingSignalsForSlot', 'setChatVersion']);
  });

  it('S5: a resolvePendingSignalsForSlot failure is swallowed — setChatVersion still fires', async () => {
    const deps = makeDeps();
    deps.resolvePendingSignalsForSlot.mockRejectedValueOnce(new Error('boom'));
    const handler = createChatHandler(deps);

    await expect(handler.handle(makeRumor({ id: 'orig-2' }), makeCtx(), makeSender())).resolves.not.toThrow();
    expect(deps.setChatVersion).toHaveBeenCalledOnce();
  });

  // ─── S5: edit-marked kind-9 dispatch-routing (mirrors ContactChat.tsx's DM check) ──

  it('S5: an edit-marked kind-9 replacement is routed to applyDeleteEditSignal, NOT appendMessage', async () => {
    const deps = makeDeps();
    deps.applyDeleteEditSignal.mockResolvedValueOnce({
      thread: { kind: 'group' as const, groupId: GROUP_ID },
      slotId: 'orig-1',
      kind: 'edit' as const,
    });
    const handler = createChatHandler(deps);
    const replacement = makeRumor({
      id: 'replacement-1',
      content: 'edited text',
      tags: [['e', 'orig-1', '', 'edit'], ['rev', '1000']],
    });

    await handler.handle(replacement, makeCtx(), makeSender(replacement.pubkey));

    expect(deps.applyDeleteEditSignal).toHaveBeenCalledOnce();
    expect(deps.applyDeleteEditSignal).toHaveBeenCalledWith(
      { kind: 'group', groupId: GROUP_ID },
      replacement,
      makeSender(replacement.pubkey),
    );
    expect(deps.appendMessage).not.toHaveBeenCalled();
    expect(deps.resolvePendingSignalsForSlot).not.toHaveBeenCalled();
    expect(deps.setChatVersion).toHaveBeenCalledOnce();
  });

  it('S5 gate-remediation (finding 5): an edit-marked kind-9 that loses the tie (noop) STILL bumps setChatVersion — the sweep inside applyDeleteEditSignal can self-heal OTHER slots regardless of this rumor\'s own outcome', async () => {
    const deps = makeDeps();
    deps.applyDeleteEditSignal.mockResolvedValueOnce({
      thread: { kind: 'group' as const, groupId: GROUP_ID },
      slotId: 'orig-1',
      kind: 'noop' as const,
    });
    const handler = createChatHandler(deps);
    const replacement = makeRumor({
      id: 'replacement-2',
      tags: [['e', 'orig-1', '', 'edit'], ['rev', '1']],
    });

    await handler.handle(replacement, makeCtx(), makeSender(replacement.pubkey));

    expect(deps.setChatVersion).toHaveBeenCalledOnce();
  });

  it('S5 gate-remediation (finding 5): applyDeleteEditSignal throwing (null result) still does NOT bump setChatVersion — only a genuinely non-null ChangeResult bumps', async () => {
    const deps = makeDeps();
    deps.applyDeleteEditSignal.mockRejectedValueOnce(new Error('boom'));
    const handler = createChatHandler(deps);
    const replacement = makeRumor({
      id: 'replacement-3',
      tags: [['e', 'orig-1', '', 'edit'], ['rev', '1']],
    });

    await expect(handler.handle(replacement, makeCtx(), makeSender(replacement.pubkey))).resolves.not.toThrow();

    expect(deps.setChatVersion).not.toHaveBeenCalled();
  });

  it('S5: a PLAIN kind-9 (no edit marker) still takes the normal append path, not applyDeleteEditSignal', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ id: 'plain-1', tags: [['e', 'unrelated']] });

    await handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey));

    expect(deps.applyDeleteEditSignal).not.toHaveBeenCalled();
    expect(deps.appendMessage).toHaveBeenCalledOnce();
  });

  // ─── AC-ATTR-6 (epic: group-message-author-auth-app-layer S2): attribution
  // sources from sender.pubkey, not the forgeable rumor.pubkey ──────────────

  it('AC-ATTR-6: a chat message where sender.pubkey differs from rumor.pubkey is appended with senderPubkey === sender.pubkey (not rumor.pubkey)', async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const rumor = makeRumor({ pubkey: PEER_PUBKEY }); // claimed author
    const forgedSender = makeSender(SELF_PUBKEY); // dispatcher-authenticated sender, deliberately different

    await handler.handle(rumor, makeCtx(), forgedSender);

    expect(deps.appendMessage).toHaveBeenCalledOnce();
    const [, msg] = deps.appendMessage.mock.calls[0];
    expect(msg.senderPubkey).toBe(SELF_PUBKEY);
    expect(msg.senderPubkey).not.toBe(rumor.pubkey);
  });
});
