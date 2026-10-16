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
    appendMessage: vi.fn(async () => true),
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
    // S6 (epic: group-message-author-auth-app-layer) — announcement ingest
    // gate deps. Default to fail-closed (false/null/[]) so every accept-path
    // test below must explicitly opt in — a test that forgets to override
    // these fails LOUD (reject) rather than silently passing an unintended
    // accept.
    isGroupAdmin: vi.fn(async () => false),
    isGroupMember: vi.fn(async () => false),
    getPoll: vi.fn(async () => null as import('@/src/lib/marmot/pollPersistence').Poll | null),
    loadVotes: vi.fn(async () => [] as import('@/src/lib/marmot/pollPersistence').PollVote[]),
    saveVoteIfNewer: vi.fn(async () => {}),
    loadPendingVotes: vi.fn(async () => [] as import('@/src/lib/marmot/pollPersistence').PendingPollVote[]),
    removePendingVotes: vi.fn(async () => {}),
    queuePendingCloseAnnouncement: vi.fn(async () => {}),
    loadPendingCloseAnnouncements: vi.fn(async () => [] as import('@/src/lib/marmot/pollPersistence').PendingCloseAnnouncement[]),
    removePendingCloseAnnouncements: vi.fn(async () => {}),
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
    deps.appendMessage.mockImplementation(async () => { callOrder.push('appendMessage'); return true; });
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

  it('bug reaction-storage-failures: applyDeleteEditSignal failing (storage) propagates so the rumor stays journaled; setChatVersion still bumps (the sweep may have landed writes before the failure)', async () => {
    const deps = makeDeps();
    deps.applyDeleteEditSignal.mockRejectedValueOnce(new Error('boom'));
    const handler = createChatHandler(deps);
    const replacement = makeRumor({
      id: 'replacement-3',
      tags: [['e', 'orig-1', '', 'edit'], ['rev', '1']],
    });

    await expect(handler.handle(replacement, makeCtx(), makeSender(replacement.pubkey))).rejects.toThrow('boom');

    expect(deps.setChatVersion).toHaveBeenCalledOnce();
    expect(deps.setChatVersion.mock.calls[0][0](4)).toBe(5); // an increment
    expect(deps.appendMessage).not.toHaveBeenCalled();
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

  // ─── S6 (epic: group-message-author-auth-app-layer): enum announcement
  // per-type actor rules + ingest-time enforcement gate ────────────────────
  //
  // AC-ANNOUNCE-1: a rejected announcement produces NO chat row, NO
  // setChatVersion bump, NO unread increment, NO notification — asserted by
  // checking ALL FOUR side-effect deps are untouched, not merely
  // appendMessage.
  describe('S6: announcement actor rules + ingest gate', () => {
    const SUBJECT_PUBKEY = 'dd'.repeat(32);
    const OTHER_PUBKEY = 'ee'.repeat(32);

    function assertFullyRejected(deps: ReturnType<typeof makeDeps>) {
      expect(deps.appendMessage).not.toHaveBeenCalled();
      expect(deps.setChatVersion).not.toHaveBeenCalled();
      expect(deps.incrementUnread).not.toHaveBeenCalled();
      expect(deps.markAsRead).not.toHaveBeenCalled();
      expect(deps.resolvePendingSignalsForSlot).not.toHaveBeenCalled();
    }

    // ── group_renamed (AC-ANNOUNCE-5) ──────────────────────────────────────

    it('AC-ANNOUNCE-5: group_renamed from an admin actor is accepted (row appended)', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({ content: JSON.stringify({ type: 'group_renamed', name: 'New Name' }) });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.isGroupAdmin).toHaveBeenCalledWith(GROUP_ID, PEER_PUBKEY);
      expect(deps.appendMessage).toHaveBeenCalledOnce();
      expect(deps.setChatVersion).toHaveBeenCalledOnce();
    });

    it('AC-ANNOUNCE-5: group_renamed from a NON-admin actor is rejected — no row, no version bump, no unread, no notification', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(false);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({ content: JSON.stringify({ type: 'group_renamed', name: 'Forged Name' }) });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    // ── invite_lifecycle('accepted') / member_admitted (AC-ANNOUNCE-1, AC-ANNOUNCE-3 ingest half) ──

    it("AC-ANNOUNCE-1/3: invite_lifecycle('accepted') from an admin actor whose subject IS in the roster is accepted", async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockResolvedValue(true);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: SUBJECT_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.isGroupMember).toHaveBeenCalledWith(GROUP_ID, SUBJECT_PUBKEY);
      expect(deps.appendMessage).toHaveBeenCalledOnce();
    });

    it("AC-ANNOUNCE-1: invite_lifecycle('accepted') from a NON-admin actor is rejected regardless of roster membership", async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(false);
      deps.isGroupMember.mockResolvedValue(true);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: SUBJECT_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    it("AC-ANNOUNCE-1: invite_lifecycle('accepted') from an admin actor whose subject is NOT in the roster is rejected (ingest-time roster gate)", async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockResolvedValue(false);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: SUBJECT_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    it('AC-ANNOUNCE-1: member_admitted (defensive — no live producer) applies the same admin+roster gate as accepted', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockResolvedValue(false);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'member_admitted', pubkey: SUBJECT_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    it('member_admitted from an admin actor with subject IN the roster is accepted', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockResolvedValue(true);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'member_admitted', pubkey: SUBJECT_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
    });

    // ── invite_lifecycle('invited'/'declined'), invite_cancelled (AC-ANNOUNCE-2: admin-gated, NEVER roster-gated) ──

    it.each(['invited', 'declined'] as const)(
      "AC-ANNOUNCE-2: invite_lifecycle('%s') from an admin actor renders even when the subject is absent from the roster (isGroupMember not consulted)",
      async (event) => {
        const deps = makeDeps();
        deps.isGroupAdmin.mockResolvedValue(true);
        deps.isGroupMember.mockResolvedValue(false); // subject absent from roster — must NOT matter
        const handler = createChatHandler(deps);
        const rumor = makeRumor({
          content: JSON.stringify({ type: 'invite_lifecycle', event, pubkey: SUBJECT_PUBKEY }),
        });

        await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

        expect(deps.appendMessage).toHaveBeenCalledOnce();
        // AC-ANNOUNCE-2 is explicit: these types are NEVER roster-gated —
        // the roster accessor must not even be consulted for them.
        expect(deps.isGroupMember).not.toHaveBeenCalled();
      },
    );

    it.each(['invited', 'declined'] as const)(
      "invite_lifecycle('%s') from a NON-admin actor is rejected",
      async (event) => {
        const deps = makeDeps();
        deps.isGroupAdmin.mockResolvedValue(false);
        const handler = createChatHandler(deps);
        const rumor = makeRumor({
          content: JSON.stringify({ type: 'invite_lifecycle', event, pubkey: SUBJECT_PUBKEY }),
        });

        await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

        assertFullyRejected(deps);
      },
    );

    it('AC-ANNOUNCE-2: invite_cancelled from an admin actor renders even when the subject is absent from the roster', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockResolvedValue(false);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_cancelled', pubkey: SUBJECT_PUBKEY, by: PEER_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
      expect(deps.isGroupMember).not.toHaveBeenCalled();
    });

    it('invite_cancelled from a NON-admin actor is rejected', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(false);
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_cancelled', pubkey: SUBJECT_PUBKEY, by: PEER_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    // ── call_notice (AC-ANNOUNCE-4): actor is ALWAYS sender.pubkey, never gated, never reads `initiator` for attribution ──

    it('AC-ANNOUNCE-4: call_notice is never actor-gated (no admin/roster check) — renders from any sender', async () => {
      const deps = makeDeps(); // isGroupAdmin/isGroupMember default to false — must not matter
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'call_notice', event: 'started', callId: 'call-1', initiator: OTHER_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
      expect(deps.isGroupAdmin).not.toHaveBeenCalled();
      expect(deps.isGroupMember).not.toHaveBeenCalled();
    });

    it("AC-ANNOUNCE-4: the persisted ChatMessage.senderPubkey is sender.pubkey even when the payload's initiator diverges", async () => {
      const deps = makeDeps();
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'call_notice', event: 'started', callId: 'call-2', initiator: OTHER_PUBKEY }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      const [, msg] = deps.appendMessage.mock.calls[0];
      expect(msg.senderPubkey).toBe(PEER_PUBKEY);
      expect(msg.senderPubkey).not.toBe(OTHER_PUBKEY);
    });

    // ── leave_intent DEPARTURE ANNOUNCEMENT (kind-9) — S3 Fable Stage-2 review fold-in: subject === sender ──

    it('leave_intent departure announcement: subject === sender is accepted', async () => {
      const deps = makeDeps();
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'leave_intent', pubkey: PEER_PUBKEY, name: 'Leaver' }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
    });

    it('leave_intent departure announcement: subject !== sender (forged self-departure claim) is rejected', async () => {
      const deps = makeDeps();
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        // The rumor CLAIMS a different member (SUBJECT_PUBKEY) left, but the
        // authenticated sender is PEER_PUBKEY — a member announcing someone
        // ELSE's departure must not render as a departure at all.
        content: JSON.stringify({ type: 'leave_intent', pubkey: SUBJECT_PUBKEY, name: 'Victim' }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    // ── poll_close CHAT ANNOUNCEMENT (F1, S5 Stage-2 review fold-in): creator-gate + tally recompute ──

    it('poll_close announcement from the stored poll CREATOR is accepted and the persisted content carries the RECOMPUTED tally, never the closer\'s claimed counts', async () => {
      const deps = makeDeps();
      const poll = {
        id: 'poll-1',
        groupId: GROUP_ID,
        title: 'Lunch?',
        options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Sushi' }],
        pollType: 'singlechoice' as const,
        creatorPubkey: PEER_PUBKEY,
        createdAt: Date.now(),
        closed: false,
      };
      deps.getPoll.mockResolvedValue(poll);
      deps.loadVotes.mockResolvedValue([
        { id: 'poll-1:v1', pollId: 'poll-1', voterPubkey: 'v1'.padEnd(64, '1'), responses: ['A'], votedAt: Date.now() },
        { id: 'poll-1:v2', pollId: 'poll-1', voterPubkey: 'v2'.padEnd(64, '2'), responses: ['A'], votedAt: Date.now() },
        { id: 'poll-1:v3', pollId: 'poll-1', voterPubkey: 'v3'.padEnd(64, '3'), responses: ['B'], votedAt: Date.now() },
      ]);
      const handler = createChatHandler(deps);
      // The closer's SELF-REPORTED payload forges a landslide for B — the
      // real stored votes (above) say A:2 B:1.
      const forgedContent = JSON.stringify({
        type: 'poll_close',
        pollId: 'poll-1',
        title: 'Lunch?',
        results: [{ optionId: 'A', label: 'Pizza', count: 0 }, { optionId: 'B', label: 'Sushi', count: 99 }],
        totalVoters: 99,
      });
      const rumor = makeRumor({ pubkey: PEER_PUBKEY, content: forgedContent });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      // Votes are read group-scoped (bug: polls-integrity-cluster) — a same-id
      // poll's votes from another group can never feed this tally.
      expect(deps.loadVotes).toHaveBeenCalledWith(GROUP_ID, 'poll-1');
      expect(deps.appendMessage).toHaveBeenCalledOnce();
      const [, msg] = deps.appendMessage.mock.calls[0];
      const persisted = JSON.parse(msg.content);
      expect(persisted.type).toBe('poll_close');
      expect(persisted.totalVoters).toBe(3);
      const byId = Object.fromEntries(persisted.results.map((r: { optionId: string; count: number }) => [r.optionId, r.count]));
      expect(byId.A).toBe(2);
      expect(byId.B).toBe(1);
    });

    it('poll_close announcement: the persisted title derives from the STORED poll, never the closer\'s payload title', async () => {
      const deps = makeDeps();
      const poll = {
        id: 'poll-1',
        groupId: GROUP_ID,
        title: 'Lunch?',
        options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Sushi' }],
        pollType: 'singlechoice' as const,
        creatorPubkey: PEER_PUBKEY,
        createdAt: Date.now(),
        closed: false,
      };
      deps.getPoll.mockResolvedValue(poll);
      deps.loadVotes.mockResolvedValue([]);
      const handler = createChatHandler(deps);
      // The closer's SELF-REPORTED payload diverges from the stored poll's
      // title — same distrust as the forged counts above (F1/S6-F3).
      const forgedContent = JSON.stringify({
        type: 'poll_close',
        pollId: 'poll-1',
        title: 'FORGED TITLE',
        results: [],
        totalVoters: 0,
      });
      const rumor = makeRumor({ pubkey: PEER_PUBKEY, content: forgedContent });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
      const [, msg] = deps.appendMessage.mock.calls[0];
      const persisted = JSON.parse(msg.content);
      expect(persisted.title).toBe('Lunch?');
    });

    it('poll_close announcement from a NON-creator actor is rejected (F1: any member could otherwise post a fake closed-poll bubble)', async () => {
      const deps = makeDeps();
      deps.getPoll.mockResolvedValue({
        id: 'poll-1',
        groupId: GROUP_ID,
        title: 'Lunch?',
        options: [{ id: 'A', label: 'Pizza' }],
        pollType: 'singlechoice' as const,
        creatorPubkey: OTHER_PUBKEY, // NOT the sender below
        createdAt: Date.now(),
        closed: false,
      });
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'poll_close', pollId: 'poll-1', title: 'Lunch?', results: [], totalVoters: 0 }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
    });

    it('poll_close announcement for an UNKNOWN poll (not yet observed by this client) is not shown now but queued for the poll-open (AC-9)', async () => {
      const deps = makeDeps(); // getPoll defaults to null
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'poll_close', pollId: 'unknown-poll', title: 'X', results: [], totalVoters: 0 }),
      });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      assertFullyRejected(deps);
      expect(deps.queuePendingCloseAnnouncement).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        pollId: 'unknown-poll',
        senderPubkey: PEER_PUBKEY,
        rumorId: rumor.id,
        createdAt: rumor.created_at,
      });
    });

    it('a failing early-announcement queue write THROWS (not a silent reject) and has no side effect', async () => {
      // bug: poll-residual-ordering-and-close-retry — a swallowed hold failure
      // made the held-announcement replay treat the entry as completed.
      const deps = makeDeps();
      deps.queuePendingCloseAnnouncement.mockRejectedValueOnce(new Error('quota'));
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'poll_close', pollId: 'unknown-poll', title: 'X', results: [], totalVoters: 0 }),
      });
      await expect(createChatHandler(deps).handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).rejects.toThrow('quota');
      assertFullyRejected(deps);
    });

    // ── VQ-S6-006: fail-closed on an indeterminate/throwing admin or roster lookup ──

    it('VQ-S6-006: a throwing isGroupAdmin lookup fails CLOSED (rejects) rather than defaulting to accept', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockRejectedValue(new Error('provider not populated'));
      const handler = createChatHandler(deps);
      const rumor = makeRumor({ content: JSON.stringify({ type: 'group_renamed', name: 'X' }) });

      await expect(handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).resolves.not.toThrow();
      assertFullyRejected(deps);
    });

    it('VQ-S6-006: a throwing isGroupMember lookup fails CLOSED for an admission-type announcement', async () => {
      const deps = makeDeps();
      deps.isGroupAdmin.mockResolvedValue(true);
      deps.isGroupMember.mockRejectedValue(new Error('roster lookup pending'));
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: SUBJECT_PUBKEY }),
      });

      await expect(handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).resolves.not.toThrow();
      assertFullyRejected(deps);
    });

    it('VQ-S6-014/F2 (Stage-2 review): a throwing getPoll lookup fails CLOSED for poll_close (unlike isGroupAdmin/isGroupMember, this dep was previously untested)', async () => {
      const deps = makeDeps();
      deps.getPoll.mockRejectedValue(new Error('poll store unavailable'));
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'poll_close', pollId: 'poll-1', title: 'X', results: [], totalVoters: 0 }),
      });

      // Indeterminate ≠ rejected: the read failure THROWS and no row is written now…
      await expect(handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).rejects.toThrow('poll store unavailable');
      assertFullyRejected(deps);
      // …but the announcement is HELD for the next poll message (the dispatcher
      // acks a live rumor even when its handler throws — bug:
      // poll-residual-ordering-and-close-retry).
      expect(deps.queuePendingCloseAnnouncement).toHaveBeenCalledWith({
        groupId: makeCtx().groupId,
        pollId: 'poll-1',
        senderPubkey: PEER_PUBKEY,
        rumorId: rumor.id,
        createdAt: rumor.created_at,
      });
    });

    it('a throwing getPoll whose hold ALSO fails still throws the read error (no row)', async () => {
      const deps = makeDeps();
      deps.getPoll.mockRejectedValue(new Error('poll store unavailable'));
      deps.queuePendingCloseAnnouncement.mockRejectedValueOnce(new Error('quota'));
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'poll_close', pollId: 'poll-1', title: 'X', results: [], totalVoters: 0 }),
      });
      await expect(createChatHandler(deps).handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).rejects.toThrow('poll store unavailable');
      assertFullyRejected(deps);
    });

    it('VQ-S6-014/F2 (Stage-2 review): a throwing loadVotes lookup fails CLOSED — MUST NOT swallow into an empty-votes accept with a fabricated "0 votes, 0 voters" tally', async () => {
      const deps = makeDeps();
      const poll = {
        id: 'poll-1',
        groupId: GROUP_ID,
        title: 'Lunch?',
        options: [{ id: 'A', label: 'Pizza' }],
        pollType: 'singlechoice' as const,
        creatorPubkey: PEER_PUBKEY,
        createdAt: Date.now(),
        closed: false,
      };
      deps.getPoll.mockResolvedValue(poll);
      deps.loadVotes.mockRejectedValue(new Error('vote store unavailable'));
      const handler = createChatHandler(deps);
      const rumor = makeRumor({
        pubkey: PEER_PUBKEY,
        content: JSON.stringify({ type: 'poll_close', pollId: 'poll-1', title: 'Lunch?', results: [], totalVoters: 0 }),
      });

      await expect(handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY))).rejects.toThrow('vote store unavailable');
      // F2: fail-closed means NO appendMessage at all — never a persisted
      // row with a fabricated zero tally. assertFullyRejected covers
      // appendMessage/setChatVersion/unread/markAsRead/resolvePendingSignals.
      assertFullyRejected(deps);
    });

    // ── Regression guard: an ordinary (non-announcement) chat message is never gated ──

    it('regression: a plain text message never consults isGroupAdmin/isGroupMember/getPoll', async () => {
      const deps = makeDeps();
      const handler = createChatHandler(deps);
      const rumor = makeRumor({ content: 'just chatting' });

      await handler.handle(rumor, makeCtx(), makeSender(PEER_PUBKEY));

      expect(deps.appendMessage).toHaveBeenCalledOnce();
      expect(deps.isGroupAdmin).not.toHaveBeenCalled();
      expect(deps.isGroupMember).not.toHaveBeenCalled();
      expect(deps.getPoll).not.toHaveBeenCalled();
    });
  });
});

describe('appendMessage result gates the new-message side effects (remediation 2, M1)', () => {
  it('a duplicate id (append returned false): no version bump, no unread, no mark-read — signals still resolved', async () => {
    const deps = makeDeps();
    deps.appendMessage.mockResolvedValue(false);
    await createChatHandler(deps).handle(makeRumor({ content: 'again' }), makeCtx(), makeSender());
    expect(deps.resolvePendingSignalsForSlot).toHaveBeenCalledOnce();
    expect(deps.setChatVersion).not.toHaveBeenCalled();
    expect(deps.incrementUnread).not.toHaveBeenCalled();
    expect(deps.markAsRead).not.toHaveBeenCalled();
  });

  it('a duplicate id in the active group does not mark-read either', async () => {
    const deps = makeDeps();
    deps.appendMessage.mockResolvedValue(false);
    await createChatHandler(deps).handle(makeRumor({ content: 'again' }), makeCtx({ getActiveGroupId: () => GROUP_ID }), makeSender());
    expect(deps.markAsRead).not.toHaveBeenCalled();
  });

  it('an inserted row (append returned true) bumps and rings exactly once', async () => {
    const deps = makeDeps();
    await createChatHandler(deps).handle(makeRumor({ content: 'new' }), makeCtx(), makeSender());
    expect(deps.setChatVersion).toHaveBeenCalledOnce();
    expect(deps.incrementUnread).toHaveBeenCalledOnce();
  });
});
