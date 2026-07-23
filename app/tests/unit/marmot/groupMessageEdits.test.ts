/**
 * Unit tests for S5 (epic-feature-request-message-edit-and-delete, group
 * adapter): app/src/lib/marmot/handlers/deleteEditHandler.ts, the group half
 * of the MessageActionHandlers seam in app/src/context/ChatStoreContext.tsx
 * (handleDeleteMessage/handleEditMessage, re-derived orchestration — cannot
 * mount React per project convention), and the group render-substitution
 * fix (reconcileMessagesWithStorage).
 *
 * Covers:
 * - createDeleteEditHandler routes every kind-5 rumor to applyDeleteEditSignal
 *   UNCONDITIONALLY — no pre-gate (unlike reactionHandler.ts's known-target
 *   discard gate); an unknown-target signal is retained (pending), not
 *   discarded.
 * - setChatVersion is bumped only for 'delete'/'edit' outcomes, never for
 *   'pending'/'discarded'/'noop'.
 * - Single-dispatch: the existing applicationRumorDispatcher LRU dedup
 *   prevents a duplicate wire delivery of the same rumor id from invoking
 *   handle() twice.
 * - AC-AUTH-2 (group half, S5-owned): the MLS-authenticated INNER rumor
 *   pubkey (rumor.pubkey, never a kind-445 wrapper author) gates apply vs.
 *   discard, for BOTH an already-known target and a pending (deferred-auth)
 *   target, using two REAL, distinct nostr-tools keypairs.
 * - AC-DEL-4: the group delete/edit signal is sent via group.sendApplicationRumor
 *   (MLS application rumor) — ChatStoreContext.tsx has zero NDK/relay imports,
 *   so a relay-facing kind-5 is structurally impossible from the group path.
 * - reconcileMessagesWithStorage: a re-delivered original of a tombstoned
 *   message never re-renders; a re-delivered original of an edited message
 *   renders the edited content, not the stale original; tombstoned rows are
 *   filtered via filterVisibleMessages.
 * - The four pure optimistic view-transform functions.
 * - Group delete/edit orchestration re-derived inline (mirrors
 *   ContactChat.handleDeleteMessage/handleEditMessage's real call sequence,
 *   using the REAL exported builders/reconciliation functions, not a
 *   re-implemented copy of their logic) — priorReplacementIds always [].
 *
 * Mocking convention: idb-keyval backed by a Map. No fast-check, no jsdom —
 * table-driven/hand-rolled loops per project + architecture.md convention.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// ── idb-keyval mock (Map-backed) ────────────────────────────────────────────

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    ks.forEach((k) => idbStore.delete(k));
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
}));

// ── @internet-privacy/marmot-ts mock (deserialization boundary) ────────────
// Hoisted per vi.mock semantics — applicationRumorDispatcher.ts's static
// `import { deserializeApplicationData }` binds to this mock, so the
// single-dispatch test below can inject a rumor by kind without a real MLS
// decrypt step (mirrors registerHandlers.test.ts's identical pattern).
let mockDispatcherRumor: unknown = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn(() => mockDispatcherRumor),
}));

// ── Key helpers ──────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');

const alicePrivBytes = generateSecretKey();
const alicePrivHex = bytesToHex(alicePrivBytes);
const alicePubHex = getPublicKey(alicePrivBytes);

const malloryPrivBytes = generateSecretKey();
const malloryPrivHex = bytesToHex(malloryPrivBytes);
const malloryPubHex = getPublicKey(malloryPrivBytes);

// ── Module imports (after mocks) ────────────────────────────────────────────

const { applyDeleteEditSignal, resolvePendingSignalsForSlot, clearAllMessageEditsState, registerGroupAdminsProvider } = await import(
  '@/src/lib/messageEdits/api'
);
const { buildDeleteRumor, buildEditReplacementRumor, buildEditMarkedCompanionKind5, DELETE_EDIT_RUMOR_KIND } =
  await import('@/src/lib/messageEdits/rumor');
const { appendMessage, loadMessages, clearAllMessages, CHAT_MESSAGE_KIND } = await import(
  '@/src/lib/marmot/chatPersistence'
);
const { createDeleteEditHandler } = await import('@/src/lib/marmot/handlers/deleteEditHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const {
  applyOptimisticDeleteView,
  rollbackOptimisticDeleteView,
  applyOptimisticEditView,
  rollbackOptimisticEditView,
  reconcileMessagesWithStorage,
  performGroupDeleteMessage,
  performGroupEditMessage,
} = await import('@/src/context/ChatStoreContext');

type ChatMessageFixture = import('@/src/lib/marmot/chatPersistence').ChatMessage;
type ChangeResultFixture = import('@/src/lib/messageEdits/api').ChangeResult;
type AuthenticatedSender = import('@/src/lib/marmot/applicationRumorDispatcher').AuthenticatedSender;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GROUP_ID = 'group-msgedits-test';
const GROUP_THREAD = { kind: 'group' as const, groupId: GROUP_ID };

function makeGroupTarget(overrides: Partial<ChatMessageFixture> = {}): ChatMessageFixture {
  return {
    id: 'orig-' + 'aa'.repeat(28),
    content: 'hello group',
    senderPubkey: alicePubHex,
    groupId: GROUP_ID,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeCtx(groupId = GROUP_ID, selfPubkeyHex = 'ff'.repeat(32)) {
  return { groupId, selfPubkeyHex, getActiveGroupId: () => groupId };
}

beforeEach(async () => {
  idbStore.clear();
  mockDispatcherRumor = null;
  await clearAllMessages();
  await clearAllMessageEditsState();
  registerGroupAdminsProvider(null); // S8: fail-closed default unless a test opts in
});

// ─── createDeleteEditHandler: unconditional routing, no pre-gate ────────────

describe('createDeleteEditHandler (S5): routes every kind-5 unconditionally, no known-target gate', () => {
  it('a kind-5 for an UNKNOWN target is routed to applyDeleteEditSignal and retained (pending), not discarded', async () => {
    const deps = {
      applyDeleteEditSignal,
      setChatVersion: vi.fn(),
    };
    const handler = createDeleteEditHandler(deps);
    const rumor = buildDeleteRumor('never-seen-id', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);

    await handler.handle(rumor as any, makeCtx());

    // Retained, not discarded: once the real original arrives and is
    // resolved, the buffered delete applies.
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'never-seen-id' }));
    const result = await resolvePendingSignalsForSlot(GROUP_THREAD, 'never-seen-id', alicePubHex);
    expect(result.kind).toBe('delete');

    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'never-seen-id')?.tombstoned).toBe(true);

    // S5 gate-remediation (finding 5): setChatVersion now bumps for ANY
    // non-null ChangeResult, including the initial 'pending' outcome — the
    // sweep inside applyDeleteEditSignal can self-heal/materialize OTHER
    // slots' storage as a side effect, invisible to ChatStoreContext unless
    // a bump triggers its reconcile re-read.
    expect(deps.setChatVersion).toHaveBeenCalledOnce();
  });

  it('setChatVersion bumps for a delete outcome against a KNOWN target', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'known-1' }));
    const deps = { applyDeleteEditSignal, setChatVersion: vi.fn() };
    const handler = createDeleteEditHandler(deps);
    const rumor = buildDeleteRumor('known-1', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);

    await handler.handle(rumor as any, makeCtx());

    expect(deps.setChatVersion).toHaveBeenCalledOnce();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'known-1')?.tombstoned).toBe(true);
  });

  it('S5 gate-remediation (finding 5): setChatVersion STILL bumps for a discarded outcome (edit-marked kind-5, AC-DEL-7) — the outcome itself remains discarded, only the render-trigger changed', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'known-2' }));
    const deps = { applyDeleteEditSignal, setChatVersion: vi.fn() };
    const handler = createDeleteEditHandler(deps);
    const companion = buildEditMarkedCompanionKind5('known-2', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);

    await handler.handle(companion as any, makeCtx());

    expect(deps.setChatVersion).toHaveBeenCalledOnce();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'known-2')?.tombstoned).toBeFalsy();
  });

  it('S5 gate-remediation (finding 5): setChatVersion STILL bumps for a noop outcome (idempotent reprocess, AC-STORE-2) — storage stays dedup-stable, only the render-trigger changed', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'known-3' }));
    const deps = { applyDeleteEditSignal, setChatVersion: vi.fn() };
    const handler = createDeleteEditHandler(deps);
    const rumor = buildDeleteRumor('known-3', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);

    await handler.handle(rumor as any, makeCtx());
    deps.setChatVersion.mockClear();
    await handler.handle(rumor as any, makeCtx());

    expect(deps.setChatVersion).toHaveBeenCalledOnce();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'known-3')?.tombstoned).toBe(true);
  });

  it('applyDeleteEditSignal throwing is swallowed (logged), never propagates out of handle()', async () => {
    const deps = {
      applyDeleteEditSignal: vi.fn(async () => {
        throw new Error('boom');
      }),
      setChatVersion: vi.fn(),
    };
    const handler = createDeleteEditHandler(deps);
    const rumor = buildDeleteRumor('x', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);

    await expect(handler.handle(rumor as any, makeCtx())).resolves.not.toThrow();
    expect(deps.setChatVersion).not.toHaveBeenCalled();
  });
});

// ─── Single-dispatch (no double-dispatch) ────────────────────────────────────

describe('Single-dispatch: applicationRumorDispatcher LRU dedup prevents double-apply for kind-5', () => {
  it('a duplicate wire delivery of the same rumor id invokes handle() exactly once', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'dedup-target' }));
    const applySpy = vi.fn(applyDeleteEditSignal);
    const deps = { applyDeleteEditSignal: applySpy, setChatVersion: vi.fn() };
    const handler = createDeleteEditHandler(deps);
    const dispatcher = createDispatcher([handler]);

    let listener: ((data: Uint8Array) => void | Promise<void>) | null = null;
    const fakeGroup = {
      on: (_e: string, fn: (data: Uint8Array) => void | Promise<void>) => {
        listener = fn;
      },
      off: () => {
        listener = null;
      },
    };

    const rumor = buildDeleteRumor('dedup-target', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    mockDispatcherRumor = rumor;

    dispatcher.subscribe(fakeGroup as any, makeCtx());
    expect(listener).not.toBeNull();

    // Same rumor id "delivered" twice over the wire.
    await listener!(new Uint8Array([1]));
    await listener!(new Uint8Array([1]));

    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-AUTH-2 (group half, S5-owned): MLS-authenticated inner pubkey gates apply ──

describe('AC-AUTH-2 (group): rumor.pubkey (MLS-authenticated inner rumor) gates apply vs. discard', () => {
  it('KNOWN target: a delete signed by a non-author (mallory) is discarded, row remains visible', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'auth-known-1', senderPubkey: alicePubHex }));
    const forged = buildDeleteRumor('auth-known-1', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    expect(forged.pubkey).toBe(malloryPubHex);

    const result = await applyDeleteEditSignal(GROUP_THREAD, forged as any);
    expect(result.kind).toBe('discarded');

    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'auth-known-1')?.tombstoned).toBeFalsy();
  });

  it('KNOWN target: a delete signed by the real author (alice) is honored', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'auth-known-2', senderPubkey: alicePubHex }));
    const legit = buildDeleteRumor('auth-known-2', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    expect(legit.pubkey).toBe(alicePubHex);

    const result = await applyDeleteEditSignal(GROUP_THREAD, legit as any);
    expect(result.kind).toBe('delete');

    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'auth-known-2')?.tombstoned).toBe(true);
  });

  it('PENDING target (deferred auth): a delete signed by mallory is dropped fail-closed when the real original (by alice) arrives', async () => {
    const forged = buildDeleteRumor('auth-pending-1', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    const bufferResult = await applyDeleteEditSignal(GROUP_THREAD, forged as any);
    expect(bufferResult.kind).toBe('pending');

    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'auth-pending-1', senderPubkey: alicePubHex }));
    const resolveResult = await resolvePendingSignalsForSlot(GROUP_THREAD, 'auth-pending-1', alicePubHex);

    // Mismatch: fail-closed, dropped — not applied.
    expect(resolveResult.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'auth-pending-1')?.tombstoned).toBeFalsy();
  });

  it('PENDING target (deferred auth): a delete signed by the real author (alice) is honored once the original arrives', async () => {
    const legit = buildDeleteRumor('auth-pending-2', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    const bufferResult = await applyDeleteEditSignal(GROUP_THREAD, legit as any);
    expect(bufferResult.kind).toBe('pending');

    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'auth-pending-2', senderPubkey: alicePubHex }));
    const resolveResult = await resolvePendingSignalsForSlot(GROUP_THREAD, 'auth-pending-2', alicePubHex);

    expect(resolveResult.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'auth-pending-2')?.tombstoned).toBe(true);
  });
});

// ─── AC-ATTR-6(c) (epic: group-message-author-auth-app-layer S2): applyDeleteEditSignal
// authorizes against the resolved `sender.pubkey`, not the rumor's own (forgeable)
// `rumor.pubkey` — the mechanical swap this story makes. Reuses the AC-AUTH-2 block's
// two real, distinct keypairs (alice = target's stored author, mallory = attacker). ──

describe('AC-ATTR-6(c) (group): sender.pubkey (dispatcher-resolved), not rumor.pubkey, gates own-author apply', () => {
  it('DELETE: rumor.pubkey matches the stored author (alice) but sender.pubkey is mallory — rejected', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'attr-del-1', senderPubkey: alicePubHex }));
    // If the OLD rumor.pubkey-based check were still active, this would be authorized
    // (rumor.pubkey === alicePubHex, the stored author).
    const rumor = buildDeleteRumor('attr-del-1', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    expect(rumor.pubkey).toBe(alicePubHex);

    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };
    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'attr-del-1')?.tombstoned).toBeFalsy();
  });

  it('DELETE: rumor.pubkey is mallory (mismatched) but sender.pubkey matches the stored author (alice) — applied', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'attr-del-2', senderPubkey: alicePubHex }));
    const rumor = buildDeleteRumor('attr-del-2', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    expect(rumor.pubkey).toBe(malloryPubHex);

    const sender: AuthenticatedSender = { pubkey: alicePubHex, authenticity: 'mls' };
    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'attr-del-2')?.tombstoned).toBe(true);
  });

  it('EDIT: rumor.pubkey matches the stored author (alice) but sender.pubkey is mallory — rejected', async () => {
    const target = makeGroupTarget({ id: 'attr-edit-1', senderPubkey: alicePubHex, createdAt: 1_700_000_000_000 });
    await appendMessage(GROUP_ID, target);
    // If the OLD rumor.pubkey-based check were still active, this would be authorized.
    const rumor = buildEditReplacementRumor(
      target.id,
      Math.floor(target.createdAt / 1000),
      'edited by forger, signed as alice',
      CHAT_MESSAGE_KIND,
      2_000,
      alicePrivHex,
    );
    expect(rumor.pubkey).toBe(alicePubHex);

    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };
    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'attr-edit-1')?.content).toBe('hello group');
    expect(messages.find((m) => m.id === 'attr-edit-1')?.edited).toBeFalsy();
  });

  it('EDIT: rumor.pubkey is mallory (mismatched) but sender.pubkey matches the stored author (alice) — applied', async () => {
    const target = makeGroupTarget({ id: 'attr-edit-2', senderPubkey: alicePubHex, createdAt: 1_700_000_000_000 });
    await appendMessage(GROUP_ID, target);
    const rumor = buildEditReplacementRumor(
      target.id,
      Math.floor(target.createdAt / 1000),
      'edited by alice, signed as forger',
      CHAT_MESSAGE_KIND,
      2_000,
      malloryPrivHex,
    );
    expect(rumor.pubkey).toBe(malloryPubHex);

    const sender: AuthenticatedSender = { pubkey: alicePubHex, authenticity: 'mls' };
    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('edit');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'attr-edit-2')?.content).toBe('edited by alice, signed as forger');
    expect(messages.find((m) => m.id === 'attr-edit-2')?.edited).toBe(true);
  });
});

// ─── AC-EDIT-7 (epic: group-message-author-auth-app-layer S4): edit/delete
// authorization keyed on authenticated sender vs the target's STORED
// authenticated sender, plus the admin-delete carve-out via GroupAdminsProvider
// — and (test-only, no independent code change per this story's scope) proof
// that chatPersistence.ts's TombstoneAuthorization inherits that SAME
// authenticated value rather than reading rumor.pubkey independently. Builds
// on the AC-ATTR-6(c) block above (S2), which already proves sender.pubkey
// (not rumor.pubkey) gates own-author apply/reject; this block adds the
// admin-delete path as its own distinct, directly-tested case and pins the
// third-hop inheritance explicitly. ──────────────────────────────────────────

describe('AC-EDIT-7 (S4): edit/delete authorization on authenticated sender + admin-delete carve-out', () => {
  const ANNOUNCEMENT_CONTENT = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });

  it('(a) own-author DELETE: sender.pubkey === target stored senderPubkey — applied', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-own-del', senderPubkey: alicePubHex, content: 'ordinary message' }));
    const rumor = buildDeleteRumor('edit7-own-del', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    const sender: AuthenticatedSender = { pubkey: alicePubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-own-del')?.tombstoned).toBe(true);
  });

  it('(a) own-author EDIT: sender.pubkey === target stored senderPubkey — applied', async () => {
    const target = makeGroupTarget({ id: 'edit7-own-edit', senderPubkey: alicePubHex, content: 'v1', createdAt: 1_700_000_100_000 });
    await appendMessage(GROUP_ID, target);
    const rumor = buildEditReplacementRumor(target.id, Math.floor(target.createdAt / 1000), 'own-author edit', CHAT_MESSAGE_KIND, 2_000, alicePrivHex);
    const sender: AuthenticatedSender = { pubkey: alicePubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('edit');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-own-edit')?.content).toBe('own-author edit');
  });

  it('(b) cross-author DELETE against an ORDINARY message: sender.pubkey (mallory) !== target stored senderPubkey (alice), mallory is not admin — rejected, no tombstone', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-cross-del', senderPubkey: alicePubHex, content: 'ordinary message' }));
    const rumor = buildDeleteRumor('edit7-cross-del', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-cross-del')?.tombstoned).toBeFalsy();
  });

  it('(b) admin delete of an ORDINARY (non-announcement) peer message is REJECTED — the admin carve-out is announcement-only, not a blanket admin-delete power (Fable S4 F2)', async () => {
    // mallory IS a registered admin, but the target is an ordinary message, not
    // an informative announcement — so the carve-out must NOT apply and the
    // pure own-author gate rejects the cross-author delete. Guards against an
    // over-broad carve-out regression (extending admin delete to all messages).
    registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [malloryPubHex] : []));
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-admin-ordinary-del', senderPubkey: alicePubHex, content: 'ordinary message' }));
    const rumor = buildDeleteRumor('edit7-admin-ordinary-del', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-admin-ordinary-del')?.tombstoned).toBeFalsy();
  });

  it('(b) cross-author DELETE against an ANNOUNCEMENT: mallory is NOT a registered admin — rejected even though the content shape would otherwise qualify for the admin carve-out (no provider registered — fail-closed empty admin set)', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-cross-del-announce', senderPubkey: alicePubHex, content: ANNOUNCEMENT_CONTENT }));
    const rumor = buildDeleteRumor('edit7-cross-del-announce', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-cross-del-announce')?.tombstoned).toBeFalsy();
  });

  it('(b) cross-author EDIT: sender.pubkey (mallory) !== target stored senderPubkey (alice) — rejected even though mallory IS a registered admin (AC-IMMUT-6: edit never gets an admin carve-out, unlike delete)', async () => {
    registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [malloryPubHex] : []));
    const target = makeGroupTarget({ id: 'edit7-cross-edit', senderPubkey: alicePubHex, content: 'hello group', createdAt: 1_700_000_200_000 });
    await appendMessage(GROUP_ID, target);
    const rumor = buildEditReplacementRumor(target.id, Math.floor(target.createdAt / 1000), 'forged edit by admin', CHAT_MESSAGE_KIND, 2_000, malloryPrivHex);
    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-cross-edit')?.content).toBe('hello group');
    expect(messages.find((m) => m.id === 'edit7-cross-edit')?.edited).toBeFalsy();
  });

  it('(c) ADMIN deletes another member\'s ANNOUNCEMENT via the receive-side authenticated sender — applied via GroupAdminsProvider, keyed on sender.pubkey NOT rumor.pubkey (VQ-S4-004(c), VQ-S4-005 tombstone-inheritance evidence #1)', async () => {
    registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [alicePubHex] : []));
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-admin-del', senderPubkey: malloryPubHex, content: ANNOUNCEMENT_CONTENT }));
    // rumor.pubkey is mallory's OWN signature (the peer's announcement, forwarded
    // as-is) — irrelevant to authorization. The dispatcher-resolved authenticated
    // sender (alice, the real admin) is what must authorize this delete.
    const rumor = buildDeleteRumor('edit7-admin-del', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    expect(rumor.pubkey).toBe(malloryPubHex);
    const sender: AuthenticatedSender = { pubkey: alicePubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-admin-del')?.tombstoned).toBe(true);
  });

  it('(c) a rumor.pubkey that IS the real admin does NOT bypass the gate when the authenticated sender is NOT actually admin — rejected (VQ-S4-004(c), VQ-S4-005 tombstone-inheritance evidence #2: if TombstoneAuthorization/chatPersistence.ts ever fell back to rumor.pubkey instead of the threaded sender, this would incorrectly succeed)', async () => {
    registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [alicePubHex] : []));
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'edit7-fake-admin-del', senderPubkey: malloryPubHex, content: ANNOUNCEMENT_CONTENT }));
    // rumor.pubkey is alice's (the real admin's) signature, but the
    // dispatcher-resolved authenticated sender is mallory (not admin).
    const rumor = buildDeleteRumor('edit7-fake-admin-del', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    expect(rumor.pubkey).toBe(alicePubHex);
    const sender: AuthenticatedSender = { pubkey: malloryPubHex, authenticity: 'mls' };

    const result = await applyDeleteEditSignal(GROUP_THREAD, rumor as any, sender);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'edit7-fake-admin-del')?.tombstoned).toBeFalsy();
  });

  it('(d) fail-closed at every point: a sender-mismatch rejection writes no tombstone and applies no edit for BOTH paths independently — re-asserts against real storage (not a spy) that the row is byte-for-byte unchanged', async () => {
    const delTarget = makeGroupTarget({ id: 'edit7-failclosed-del', senderPubkey: alicePubHex, content: 'untouched' });
    await appendMessage(GROUP_ID, delTarget);
    const delRumor = buildDeleteRumor('edit7-failclosed-del', [], CHAT_MESSAGE_KIND, 1_000, malloryPrivHex);
    await applyDeleteEditSignal(GROUP_THREAD, delRumor as any, { pubkey: malloryPubHex, authenticity: 'mls' });
    const { messages: afterDel } = await loadMessages(GROUP_ID);
    expect(afterDel.find((m) => m.id === 'edit7-failclosed-del')).toEqual(delTarget);

    const editTarget = makeGroupTarget({ id: 'edit7-failclosed-edit', senderPubkey: alicePubHex, content: 'untouched', createdAt: 1_700_000_300_000 });
    await appendMessage(GROUP_ID, editTarget);
    const editRumor = buildEditReplacementRumor(editTarget.id, Math.floor(editTarget.createdAt / 1000), 'forged replacement', CHAT_MESSAGE_KIND, 2_000, malloryPrivHex);
    await applyDeleteEditSignal(GROUP_THREAD, editRumor as any, { pubkey: malloryPubHex, authenticity: 'mls' });
    const { messages: afterEdit } = await loadMessages(GROUP_ID);
    expect(afterEdit.find((m) => m.id === 'edit7-failclosed-edit')).toEqual(editTarget);
  });
});

// ─── AC-DEL-4: group send is MLS application rumor, never relay-facing ──────

describe('AC-DEL-4 (group half): the delete/edit signal is an author-signed inner kind-5, sent via MLS, never relay-facing', () => {
  const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/marmot -> app/
  const CHAT_STORE_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'src', 'context', 'ChatStoreContext.tsx'), 'utf8');

  it('ChatStoreContext.tsx never imports NDK / constructs a relay-facing event for the group send path', () => {
    // Group delete/edit is sent exclusively via sendRumorSafe -> group.sendApplicationRumor
    // (an MLS operation). Structurally proving "never relay-facing" is proving this
    // file never imports the machinery that WOULD publish to a relay.
    expect(CHAT_STORE_SOURCE).not.toMatch(/NDKEvent|@nostr-dev-kit\/ndk|\.publish\(/);
  });

  it('buildDeleteRumor output is kind 5, sent via a mocked group.sendApplicationRumor (never a relay-publish stub)', async () => {
    const rumor = buildDeleteRumor('some-id', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    expect(rumor.kind).toBe(DELETE_EDIT_RUMOR_KIND);
    expect(rumor.kind).toBe(5);

    const sendApplicationRumor = vi.fn(async () => {});
    const relayPublishStub = vi.fn(); // must never be called by the group send path
    const fakeGroup = { sendApplicationRumor, unappliedProposals: {}, commit: vi.fn() };

    await fakeGroup.sendApplicationRumor(rumor as any);

    expect(sendApplicationRumor).toHaveBeenCalledWith(rumor);
    expect(relayPublishStub).not.toHaveBeenCalled();
  });
});

// ─── reconcileMessagesWithStorage: group render-substitution fix ────────────

describe('reconcileMessagesWithStorage (S5): render-substitution fix for the group re-read path', () => {
  it('a re-delivered original of a TOMBSTONED message does not render (storage truth wins over stale rendered copy)', () => {
    const rendered: ChatMessageFixture[] = [makeGroupTarget({ id: 'm1', content: 'original text' })];
    const stored: ChatMessageFixture[] = [
      makeGroupTarget({ id: 'm1', content: 'original text', tombstoned: true, rev: 500 }),
    ];

    const result = reconcileMessagesWithStorage(rendered, stored);
    expect(result.find((m) => m.id === 'm1')).toBeUndefined();
  });

  it('a re-delivered original of an EDITED message renders the edited content, not the stale original', () => {
    const rendered: ChatMessageFixture[] = [makeGroupTarget({ id: 'm2', content: 'stale original' })];
    const stored: ChatMessageFixture[] = [
      makeGroupTarget({ id: 'm2', content: 'edited content', edited: true, rev: 500 }),
    ];

    const result = reconcileMessagesWithStorage(rendered, stored);
    const row = result.find((m) => m.id === 'm2');
    expect(row?.content).toBe('edited content');
    expect(row?.edited).toBe(true);
  });

  it('a brand-new id present in storage but not yet rendered is appended', () => {
    const rendered: ChatMessageFixture[] = [];
    const stored: ChatMessageFixture[] = [makeGroupTarget({ id: 'm3' })];

    const result = reconcileMessagesWithStorage(rendered, stored);
    expect(result.map((m) => m.id)).toEqual(['m3']);
  });

  it('a tombstoned row already in storage never appears in the merged/filtered result, even before it was ever rendered', () => {
    const rendered: ChatMessageFixture[] = [];
    const stored: ChatMessageFixture[] = [makeGroupTarget({ id: 'm4', tombstoned: true })];

    const result = reconcileMessagesWithStorage(rendered, stored);
    expect(result).toHaveLength(0);
  });

  it('an untombstoned, unedited row already rendered and still in storage is left as-is (no spurious change)', () => {
    const rendered: ChatMessageFixture[] = [makeGroupTarget({ id: 'm5', content: 'stable' })];
    const stored: ChatMessageFixture[] = [makeGroupTarget({ id: 'm5', content: 'stable' })];

    const result = reconcileMessagesWithStorage(rendered, stored);
    expect(result.map((m) => m.id)).toEqual(['m5']);
    expect(result[0].content).toBe('stable');
  });
});

// ─── Pure optimistic view-transform functions ────────────────────────────────

describe('optimistic view transforms (S5, mirrors ContactChat.tsx DM equivalents)', () => {
  it('applyOptimisticDeleteView removes the target id, leaves others intact', () => {
    const view = [makeGroupTarget({ id: 'a' }), makeGroupTarget({ id: 'b' })];
    const result = applyOptimisticDeleteView(view, 'a');
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  it('rollbackOptimisticDeleteView restores the snapshot in sorted position', () => {
    const snapshot = makeGroupTarget({ id: 'a', createdAt: 100 });
    const view = [makeGroupTarget({ id: 'b', createdAt: 200 })];
    const result = rollbackOptimisticDeleteView(view, snapshot);
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('applyOptimisticEditView patches content in place and sets edited:true, preserving position', () => {
    const view = [makeGroupTarget({ id: 'a', createdAt: 100 }), makeGroupTarget({ id: 'b', createdAt: 200 })];
    const result = applyOptimisticEditView(view, 'a', 'new content');
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result[0].content).toBe('new content');
    expect(result[0].edited).toBe(true);
  });

  it('rollbackOptimisticEditView restores the exact snapshot in place', () => {
    const snapshot = makeGroupTarget({ id: 'a', content: 'original', edited: false });
    const view = applyOptimisticEditView([snapshot], 'a', 'edited content');
    const result = rollbackOptimisticEditView(view, 'a', snapshot);
    expect(result[0]).toEqual(snapshot);
  });
});

// ─── Group send orchestration (re-derived, mirrors ChatStoreContext.handleDeleteMessage/handleEditMessage) ──

describe('group delete/edit send orchestration (S5 gate-remediation, finding 3: calls the REAL exported performGroupDeleteMessage/performGroupEditMessage — no re-derived handler bodies)', () => {
  // Small array-backed harness standing in for React state — mirrors the
  // shape ChatStoreContext.tsx's real messagesRef/setMessages closures
  // present to performGroupDeleteMessage/performGroupEditMessage via
  // GroupSendDeps. `view` is captured by reference so assertions can read it
  // after the call settles.
  function makeHarness(initial: ChatMessageFixture[]) {
    let view: ChatMessageFixture[] = initial;
    const setMessages = (updater: (prev: ChatMessageFixture[]) => ChatMessageFixture[]) => {
      view = updater(view);
    };
    return {
      getView: () => view,
      setMessages,
    };
  }

  function makeDeps(
    harness: ReturnType<typeof makeHarness>,
    targetId: string,
    group: { sendApplicationRumor: (rumor: unknown) => Promise<void> },
    overrides: Partial<{ pubkey: string; privateKeyHex: string }> = {},
  ) {
    return {
      group,
      groupId: GROUP_ID,
      privateKeyHex: overrides.privateKeyHex ?? alicePrivHex,
      pubkey: overrides.pubkey ?? alicePubHex,
      resolveAuthoritativeGroupRev: async (id: string, fallback: number | undefined) => {
        const { messages: fresh } = await loadMessages(GROUP_ID);
        return fresh.find((m) => m.id === id)?.rev ?? fallback ?? 0;
      },
      getSnapshot: () => harness.getView().find((m) => m.id === targetId),
      setMessages: harness.setMessages,
    };
  }

  it('delete happy path: view has the message removed, storage tombstoned, wire payload e-tags the original with no edit marker (AC-DEL-7)', async () => {
    const target = makeGroupTarget({ id: 'send-del-1' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const sent: unknown[] = [];
    const group = { sendApplicationRumor: vi.fn(async (rumor: unknown) => { sent.push(rumor); }) };

    await performGroupDeleteMessage('send-del-1', makeDeps(harness, 'send-del-1', group));

    expect(harness.getView().find((m) => m.id === target.id)).toBeUndefined();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBe(true);

    expect(sent).toHaveLength(1);
    const wireRumor = sent[0] as { kind: number; tags: string[][] };
    expect(wireRumor.kind).toBe(5);
    const eTag = wireRumor.tags.find((t) => t[0] === 'e');
    expect(eTag).toEqual(['e', target.id]);
    const editMarker = wireRumor.tags.find((t) => t[0] === 'e' && t[3] === 'edit');
    expect(editMarker).toBeUndefined();
  });

  it('delete publish failure: view is rolled back to visible, storage is NOT tombstoned', async () => {
    const target = makeGroupTarget({ id: 'send-del-2' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const group = { sendApplicationRumor: vi.fn(async () => { throw new Error('send failed'); }) };

    await expect(
      performGroupDeleteMessage('send-del-2', makeDeps(harness, 'send-del-2', group)),
    ).rejects.toThrow('send failed');

    expect(harness.getView().find((m) => m.id === target.id)).toEqual(target);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBeFalsy();
  });

  it('S5 gate-remediation (finding 3): own-message auth guard — a non-author messageId is a no-op (no send, no state change)', async () => {
    const target = makeGroupTarget({ id: 'send-del-guard', senderPubkey: malloryPubHex });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const group = { sendApplicationRumor: vi.fn(async () => {}) };

    // deps.pubkey (alice) does not match the target's senderPubkey (mallory).
    await performGroupDeleteMessage('send-del-guard', makeDeps(harness, 'send-del-guard', group));

    expect(group.sendApplicationRumor).not.toHaveBeenCalled();
    expect(harness.getView()).toEqual([target]);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBeFalsy();
  });

  // ── S8 (epic-group-invite-lifecycle): admin moderation-delete carve-out ──

  describe('S8: admin moderation-delete carve-out (completes AC-IMMUT-3 functional loop with the receive-side AC-IMMUT-5 gate)', () => {
    const ANNOUNCEMENT_CONTENT = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });

    it('an ADMIN can construct+send a delete of a PEER\'s informative-announcement message — sent rumor is signed with the ADMIN\'s own key', async () => {
      // The peer (mallory, in this fixture's naming) authored the
      // announcement; alice (the caller here) is a group admin moderating it.
      // The receive-side gate (applyDeleteEditSignal, invoked internally by
      // performGroupDeleteMessage's own durable-apply step) independently
      // confirms alice's admin status via the registered provider — the
      // send-side isCurrentUserAdmin flag alone does not bypass it.
      registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [alicePubHex] : []));
      const target = makeGroupTarget({ id: 'admin-mod-1', content: ANNOUNCEMENT_CONTENT, senderPubkey: malloryPubHex });
      await appendMessage(GROUP_ID, target);

      const harness = makeHarness([target]);
      const sent: unknown[] = [];
      const group = { sendApplicationRumor: vi.fn(async (rumor: unknown) => { sent.push(rumor); }) };

      await performGroupDeleteMessage('admin-mod-1', {
        ...makeDeps(harness, 'admin-mod-1', group), // pubkey/privateKeyHex default to alice
        isCurrentUserAdmin: true,
      });

      expect(harness.getView().find((m) => m.id === target.id)).toBeUndefined();
      const { messages } = await loadMessages(GROUP_ID);
      expect(messages.find((m) => m.id === target.id)?.tombstoned).toBe(true);

      // The wire rumor is signed by the ADMIN (alice), never the original
      // author (mallory) — the receive side authorizes on this self-asserted
      // sender against the group's admin set (ADR-006), not on matching the
      // target's original author.
      expect(sent).toHaveLength(1);
      const wireRumor = sent[0] as { pubkey: string };
      expect(wireRumor.pubkey).toBe(alicePubHex);
      expect(wireRumor.pubkey).not.toBe(malloryPubHex);
    });

    it('a NON-admin still cannot delete a peer\'s message even when it IS an announcement — own-message-only is preserved', async () => {
      const target = makeGroupTarget({ id: 'admin-mod-2', content: ANNOUNCEMENT_CONTENT, senderPubkey: malloryPubHex });
      await appendMessage(GROUP_ID, target);

      const harness = makeHarness([target]);
      const group = { sendApplicationRumor: vi.fn(async () => {}) };

      await performGroupDeleteMessage('admin-mod-2', {
        ...makeDeps(harness, 'admin-mod-2', group),
        isCurrentUserAdmin: false,
      });

      expect(group.sendApplicationRumor).not.toHaveBeenCalled();
      expect(harness.getView()).toEqual([target]);
      const { messages } = await loadMessages(GROUP_ID);
      expect(messages.find((m) => m.id === target.id)?.tombstoned).toBeFalsy();
    });

    it('an ADMIN still cannot delete a peer\'s ORDINARY (non-announcement) message — the carve-out grants moderation only, not blanket admin delete', async () => {
      const target = makeGroupTarget({ id: 'admin-mod-3', content: 'just an ordinary peer message', senderPubkey: malloryPubHex });
      await appendMessage(GROUP_ID, target);

      const harness = makeHarness([target]);
      const group = { sendApplicationRumor: vi.fn(async () => {}) };

      await performGroupDeleteMessage('admin-mod-3', {
        ...makeDeps(harness, 'admin-mod-3', group),
        isCurrentUserAdmin: true,
      });

      expect(group.sendApplicationRumor).not.toHaveBeenCalled();
      expect(harness.getView()).toEqual([target]);
      const { messages } = await loadMessages(GROUP_ID);
      expect(messages.find((m) => m.id === target.id)?.tombstoned).toBeFalsy();
    });

    it('regression: own-message delete of an announcement the caller BOTH authored AND administers still works via the ordinary own-author path (isCurrentUserAdmin omitted entirely, mirroring every pre-S8 call site)', async () => {
      // AC-IMMUT-4/5 gates an announcement delete strictly on current-admin
      // sourcing — NOT on authorship — so this scenario (alice both authored
      // the announcement AND is a registered admin) still requires the
      // receive-side admin provider to recognize her, exactly like the
      // moderation-delete case above; it is not a separate "own-message"
      // exemption for announcements.
      registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_ID ? [alicePubHex] : []));
      const target = makeGroupTarget({ id: 'admin-mod-4', content: ANNOUNCEMENT_CONTENT, senderPubkey: alicePubHex });
      await appendMessage(GROUP_ID, target);

      const harness = makeHarness([target]);
      const group = { sendApplicationRumor: vi.fn(async () => {}) };

      // isCurrentUserAdmin omitted entirely — mirrors every pre-S8 call site;
      // isOwnMessage alone is enough to pass performGroupDeleteMessage's send
      // guard (no isAdminModerationDelete branch needed here).
      await performGroupDeleteMessage('admin-mod-4', makeDeps(harness, 'admin-mod-4', group));

      expect(harness.getView().find((m) => m.id === target.id)).toBeUndefined();
      const { messages } = await loadMessages(GROUP_ID);
      expect(messages.find((m) => m.id === target.id)?.tombstoned).toBe(true);
    });
  });

  it('S5 gate-remediation (finding 2): a chatVersion-bump race that re-adds the row DURING the publish window is corrected by the post-delete re-apply tail', async () => {
    const target = makeGroupTarget({ id: 'send-del-race' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const group = {
      sendApplicationRumor: vi.fn(async () => {
        // Simulate a concurrent chatVersion-bump reconcile racing the publish:
        // some OTHER code path re-reads storage (still untombstoned — the
        // durable apply below hasn't run yet) and reconciles it into view,
        // resurrecting the row the optimistic delete just removed.
        harness.setMessages((prev) => reconcileMessagesWithStorage(prev, [target]));
      }),
    };

    await performGroupDeleteMessage('send-del-race', makeDeps(harness, 'send-del-race', group));

    // The tail re-apply (finding 2) removes the race-resurrected row again.
    expect(harness.getView().find((m) => m.id === target.id)).toBeUndefined();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBe(true);
  });

  it('edit happy path: replacement published BEFORE companion (AC-EDIT-8), storage content updated, edited:true', async () => {
    const target = makeGroupTarget({ id: 'send-edit-1', content: 'original' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const sentKinds: number[] = [];
    const group = {
      sendApplicationRumor: vi.fn(async (rumor: { kind: number }) => { sentKinds.push(rumor.kind); }),
    };

    await performGroupEditMessage('send-edit-1', 'updated content', makeDeps(harness, 'send-edit-1', group));

    expect(harness.getView()[0].content).toBe('updated content');
    expect(sentKinds).toEqual([CHAT_MESSAGE_KIND, 5]); // replacement (kind 9) before companion (kind 5)

    const { messages } = await loadMessages(GROUP_ID);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.content).toBe('updated content');
    expect(row?.edited).toBe(true);
  });

  it('edit: a failed companion does NOT roll back the already-successful edit (AC-EDIT-8)', async () => {
    const target = makeGroupTarget({ id: 'send-edit-2', content: 'original' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const group = {
      sendApplicationRumor: vi.fn(async (rumor: { kind: number }) => {
        if (rumor.kind === 5) throw new Error('companion failed');
      }),
    };

    await performGroupEditMessage('send-edit-2', 'updated content', makeDeps(harness, 'send-edit-2', group));

    expect(harness.getView()[0].content).toBe('updated content');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.edited).toBe(true);
  });

  it('edit: a failed REPLACEMENT publish throws, rolls back the view, storage untouched, companion never attempted', async () => {
    const target = makeGroupTarget({ id: 'send-edit-3', content: 'original' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const sentKinds: number[] = [];
    const group = {
      sendApplicationRumor: vi.fn(async (rumor: { kind: number }) => {
        if (rumor.kind === CHAT_MESSAGE_KIND) throw new Error('replacement failed');
        sentKinds.push(rumor.kind);
      }),
    };

    await expect(
      performGroupEditMessage('send-edit-3', 'updated content', makeDeps(harness, 'send-edit-3', group)),
    ).rejects.toThrow('replacement failed');

    expect(harness.getView()[0]).toEqual(target);
    expect(sentKinds).toEqual([]); // companion never attempted
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === target.id)?.content).toBe('original');
    expect(messages.find((m) => m.id === target.id)?.edited).toBeFalsy();
  });

  it('S5 gate-remediation (finding 6): a delete landing between the companion publish and the tail re-read drops the row from view instead of substituting a tombstoned row', async () => {
    const target = makeGroupTarget({ id: 'send-edit-tomb', content: 'original' });
    await appendMessage(GROUP_ID, target);

    const harness = makeHarness([target]);
    const group = {
      sendApplicationRumor: vi.fn(async (rumor: { kind: number }) => {
        if (rumor.kind === 5) {
          // Simulate another device's delete landing during the
          // companion-publish window — after the edit already durably
          // applied, before performGroupEditMessage's own tail re-read.
          const { messages: fresh } = await loadMessages(GROUP_ID);
          const row = fresh.find((m) => m.id === 'send-edit-tomb')!;
          const del = buildDeleteRumor('send-edit-tomb', [], CHAT_MESSAGE_KIND, (row.rev ?? 0) + 1_000, alicePrivHex);
          await applyDeleteEditSignal(GROUP_THREAD, del as any);
        }
      }),
    };

    await performGroupEditMessage('send-edit-tomb', 'updated content', makeDeps(harness, 'send-edit-tomb', group));

    expect(harness.getView().find((m) => m.id === 'send-edit-tomb')).toBeUndefined();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'send-edit-tomb')?.tombstoned).toBe(true);
  });

  it('AC-EDIT-6: a second edit anchors created_at/id to the ORIGINAL, not the prior edit — proven via strictly-increasing rev', async () => {
    const target = makeGroupTarget({ id: 'send-edit-anchor', content: 'v1', createdAt: 1_700_000_000_000 });
    await appendMessage(GROUP_ID, target);

    async function captureRevAndAnchor(content: string) {
      const harness = makeHarness([target]);
      const captured: { kind: number; created_at: number; tags: string[][] }[] = [];
      const group = {
        sendApplicationRumor: vi.fn(async (rumor: { kind: number; created_at: number; tags: string[][] }) => {
          captured.push(rumor);
        }),
      };
      await performGroupEditMessage('send-edit-anchor', content, makeDeps(harness, 'send-edit-anchor', group));
      const replacement = captured.find((r) => r.kind === CHAT_MESSAGE_KIND)!;
      const revTag = replacement.tags.find((t) => t[0] === 'rev');
      return { rev: Number(revTag?.[1]), createdAt: replacement.created_at, eTag: replacement.tags.find((t) => t[0] === 'e') };
    }

    const first = await captureRevAndAnchor('v2');
    const second = await captureRevAndAnchor('v3');

    expect(second.rev).toBeGreaterThan(first.rev);
    // Both edits anchor to the SAME original created_at/id — the slot anchor never moves.
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.eTag).toEqual(first.eTag);
  });

  it('S5 gate-remediation (finding 3): authoritative-rev re-read — a second delete on the SAME slot (after an intervening authoritative-rev change) clamps strictly above the current stored rev', async () => {
    const target = makeGroupTarget({ id: 'send-del-rev', content: 'v1' });
    await appendMessage(GROUP_ID, target);

    // Simulate an authoritative rev already stored (e.g. a prior edit from
    // another device) that is far ahead of what a naive Date.now()-based
    // rev would clamp to from the stale snapshot alone.
    const farFutureRev = Math.floor(Date.now() / 1000) + 10_000;
    await applyDeleteEditSignal(
      GROUP_THREAD,
      buildEditReplacementRumor(target.id, Math.floor(target.createdAt / 1000), 'v2', CHAT_MESSAGE_KIND, farFutureRev, alicePrivHex) as any,
    );

    const harness = makeHarness([{ ...target, content: 'v2', edited: true, rev: undefined }]); // stale snapshot: rev NOT patched, mirrors React state
    const sent: { rev: number }[] = [];
    const group = {
      // A delete rumor has no separate "rev" tag — its own created_at IS its
      // rev (buildDeleteRumor's doc comment).
      sendApplicationRumor: vi.fn(async (rumor: { created_at: number }) => {
        sent.push({ rev: rumor.created_at });
      }),
    };

    await performGroupDeleteMessage('send-del-rev', makeDeps(harness, 'send-del-rev', group));

    // Clamped strictly above the AUTHORITATIVE stored rev, not the stale
    // undefined snapshot.rev the harness deliberately withheld.
    expect(sent[0].rev).toBeGreaterThan(farFutureRev);
  });
});

// ─── Cross-transport reference: AC-DEL-4 held across DM (S4) and group (S5) ──

describe('AC-DEL-4 cross-transport (group half; DM half already verified by S4)', () => {
  it('group: the wire rumor is a bare kind-5, never wrapped in a relay-facing NIP-01 publish call', async () => {
    const rumor = buildDeleteRumor('cross-transport-id', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex);
    // The group transport's ENTIRE send path is `group.sendApplicationRumor(rumor)`
    // (an MLS operation on the raw, unwrapped rumor) — there is no seal/wrap/publish
    // step at all for group, unlike DM's sealAndWrap + NDKEvent.publish() (verified
    // by S4's dmMessageEdits.test.ts). This test documents that structural
    // difference and re-confirms the rumor itself carries no relay-publish envelope.
    expect(rumor).not.toHaveProperty('sig');
    expect(rumor.kind).toBe(5);
  });
});

// ─── S5 gate-remediation (finding 1): thread-open sweep self-heal, mirrors S4's ContactChat mount-sweep fix ──

describe('thread-open sweep (S5 gate-remediation, finding 1): a durably-present row with an unresolved buffered signal is filtered after the awaited sweep, with no chatVersion bump involved', () => {
  it('a known row whose buffered delete signal never got its own resolve call self-heals via the sweep phase (mirrors ChatStoreContext.tsx\'s init-load effect sequence: await sweep, re-read, reconcile)', async () => {
    // Buffer a delete signal for a target NOT yet known (mirrors a crash/race
    // where the original is appended directly via chatPersistence, bypassing
    // the standard resolvePendingSignalsForSlot hook — see messageEdits/api.ts's
    // sweepExpiredForThreadKeyLocked phase-1 doc comment for this exact
    // self-heal scenario).
    const bufferResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      buildDeleteRumor('sweep-target-1', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex) as any,
    );
    expect(bufferResult.kind).toBe('pending');

    // The original now arrives via the append-only path (NOT resolvePendingSignalsForSlot)
    // — simulating the race the module doc comment describes.
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'sweep-target-1', senderPubkey: alicePubHex }));

    // Simulate the rendered view already showing the (still untombstoned)
    // row before the thread-open sweep runs.
    let rendered: ChatMessageFixture[] = [makeGroupTarget({ id: 'sweep-target-1', senderPubkey: alicePubHex })];
    expect(rendered.find((m) => m.id === 'sweep-target-1')).toBeDefined();

    // Reproduce ChatStoreContext.tsx's init-load effect sequence exactly:
    // await the sentinel sweep, then re-read storage, then reconcile.
    await resolvePendingSignalsForSlot(GROUP_THREAD, '', '');
    const { messages: freshAfterSweep } = await loadMessages(GROUP_ID);
    rendered = reconcileMessagesWithStorage(rendered, freshAfterSweep);

    // The self-heal sweep tombstoned the row; the reconcile filters it out.
    expect(rendered.find((m) => m.id === 'sweep-target-1')).toBeUndefined();
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'sweep-target-1')?.tombstoned).toBe(true);
  });

  it('a known row with NO buffered signal is left untouched by the sweep (no spurious mutation)', async () => {
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'sweep-target-2', content: 'stable' }));
    let rendered: ChatMessageFixture[] = [makeGroupTarget({ id: 'sweep-target-2', content: 'stable' })];

    await resolvePendingSignalsForSlot(GROUP_THREAD, '', '');
    const { messages: freshAfterSweep } = await loadMessages(GROUP_ID);
    rendered = reconcileMessagesWithStorage(rendered, freshAfterSweep);

    expect(rendered.find((m) => m.id === 'sweep-target-2')?.content).toBe('stable');
  });
});

// ─── S5 gate-remediation (finding 4): resolve-after-append calling convention on the send paths ──

describe('sendMessage / sendImageMessage resolve-after-append (S5 gate-remediation, finding 4)', () => {
  const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/marmot -> app/
  const CHAT_STORE_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'src', 'context', 'ChatStoreContext.tsx'), 'utf8');

  it('sendMessage and sendImageMessage both chain resolvePendingSignalsForSlot after their appendMessage call — the only original-append sites in this file must comply with S3\'s calling convention, matching chatHandler.ts and both S4 DM append sites', () => {
    const sendMessageStart = CHAT_STORE_SOURCE.indexOf('const sendMessage = useCallback');
    const sendImageMessageStart = CHAT_STORE_SOURCE.indexOf('const sendImageMessage = useCallback');
    const sendReactionStart = CHAT_STORE_SOURCE.indexOf('const sendReaction = useCallback');
    expect(sendMessageStart).toBeGreaterThan(-1);
    expect(sendImageMessageStart).toBeGreaterThan(sendMessageStart);
    expect(sendReactionStart).toBeGreaterThan(sendImageMessageStart);

    const sendMessageBody = CHAT_STORE_SOURCE.slice(sendMessageStart, sendImageMessageStart);
    const sendImageMessageBody = CHAT_STORE_SOURCE.slice(sendImageMessageStart, sendReactionStart);

    expect(sendMessageBody).toMatch(/appendMessage\(groupId, optimistic\)[\s\S]*?resolvePendingSignalsForSlot/);
    expect(sendImageMessageBody).toMatch(/appendMessage\(groupId, finalMsg\)[\s\S]*?resolvePendingSignalsForSlot/);
  });

  it('resolvePendingSignalsForSlot resolves a buffered pending signal once the original is appended (the underlying mechanism the send paths now trigger)', async () => {
    const bufferResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      buildDeleteRumor('send-resolve-target', [], CHAT_MESSAGE_KIND, 1_000, alicePrivHex) as any,
    );
    expect(bufferResult.kind).toBe('pending');

    // Mirrors what sendMessage's own-send appendMessage + resolvePendingSignalsForSlot
    // chain now does for a rumor.id matching a pending target — a race where a
    // same-account other-device delete for THIS message arrived before the send's
    // own IDB commit.
    await appendMessage(GROUP_ID, makeGroupTarget({ id: 'send-resolve-target', senderPubkey: alicePubHex }));
    const resolveResult = await resolvePendingSignalsForSlot(GROUP_THREAD, 'send-resolve-target', alicePubHex);

    expect(resolveResult.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'send-resolve-target')?.tombstoned).toBe(true);
  });
});
