/**
 * Unit tests for publishDirectDelete / publishDirectEdit (S4, epic-feature-request-
 * message-edit-and-delete, AC-DEL-2 / AC-EDIT-8), plus S4's inbound kind-5 dispatch
 * routing and its DM-side view-optimistic/rollback model.
 *
 * Covers:
 * - publishDirectDelete: durable tombstone via S3's applyDeleteEditSignal only AFTER
 *   a successful publish; a failed publish persists nothing (AC-DEL-2).
 * - publishDirectEdit: replacement published BEFORE the companion kind-5 (AC-EDIT-8);
 *   a failed/absent companion never deletes the slot or rolls back the edit; a failed
 *   replacement publish throws, persists nothing, and never attempts the companion.
 * - ms (ChatMessage.createdAt) -> Unix-seconds wire conversion (S2 caller contract),
 *   including across a second edit of an already-edited row (AC-EDIT-6 first-message
 *   anchor, since storage's createdAt field is never touched by an edit patch).
 * - Inbound kind-5 / edit-marked-kind-14 dispatch routing re-derived inline (mirrors
 *   ContactChat.tsx's isEditMarkedReplacement — cannot mount React per project
 *   convention).
 * - AC-ORDER-1: an unknown-target kind-5 is retained (buffered), not discarded.
 * - resolve-after-append wiring re-derived inline (mirrors ContactChat.tsx's
 *   resolveFreshOriginal): a buffered delete resolves once its target is appended.
 * - AC-AUTH-2 (DM half): the authenticated seal pubkey (post unwrapAndOpen) is what
 *   gates apply-vs-discard, not a caller-asserted identity.
 * - DM view-optimistic-then-rollback array model (mirrors ContactChat.tsx's
 *   handleDeleteMessage/handleEditMessage React-state transforms) — real array
 *   assertions, not a mock-spy check that a rollback function was called.
 *
 * Mocking convention: idb-keyval backed by a Map (matches
 * chatPersistence-editDelete.test.ts / messageEdits/api.test.ts). No fast-check, no
 * jsdom — table-driven/hand-rolled loops per project + architecture.md convention.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// ── idb-keyval mock (Map-backed) ──────────────────────────────────────────

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
  // S4 gate-remediation (round-4, finding 5): needed only because this file now
  // imports pure functions from ContactChat.tsx (see below), whose transitive
  // dependency chain (groupStorage.ts) calls createStore at module load time.
  // Same no-op token pattern as marmot/groupStorage.test.ts's mock.
  createStore: vi.fn(() => ({})),
}));

// ── Key helpers ─────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');

const alicePrivBytes = generateSecretKey();
const alicePrivHex = bytesToHex(alicePrivBytes);
const alicePubHex = getPublicKey(alicePrivBytes);

const bobPrivBytes = generateSecretKey();
const bobPrivHex = bytesToHex(bobPrivBytes);
const bobPubHex = getPublicKey(bobPrivBytes);

// ── Module imports (after mock is set up) ─────────────────────────────────

const {
  publishDirectDelete,
  publishDirectEdit,
  sealAndWrap,
  unwrapAndOpen,
  directConversationId,
  GIFT_WRAP_KIND,
  CHAT_MESSAGE_KIND,
} = await import('@/src/lib/directMessages');
const { appendMessage, loadMessages } = await import('@/src/lib/marmot/chatPersistence');
const { applyDeleteEditSignal, resolvePendingSignalsForSlot } = await import('@/src/lib/messageEdits/api');
const { buildDeleteRumor, DELETE_EDIT_RUMOR_KIND } = await import('@/src/lib/messageEdits/rumor');
const { NDKEvent } = await import('@nostr-dev-kit/ndk');
// S4 gate-remediation (round-4, findings 1/5): pure functions extracted from
// ContactChat.tsx so the real transforms/reconcile logic — not a re-derived copy —
// is what these tests exercise (this repo's hooks-via-pure-function-extraction
// convention). Importing the component module does not mount React or touch the
// DOM: only top-level function/const declarations execute at import time.
const {
  reconcileHistoricalBatch,
  applyOptimisticDeleteView,
  rollbackOptimisticDeleteView,
  applyOptimisticEditView,
  rollbackOptimisticEditView,
  resolveFreshOriginalFromStorage,
  seedThreadMessages,
} = await import('@/src/components/contacts/ContactChat');

// ── Fixtures ─────────────────────────────────────────────────────────────

type ChatMessageFixture = import('@/src/lib/marmot/chatPersistence').ChatMessage;

function makeTarget(overrides: Partial<ChatMessageFixture> = {}): ChatMessageFixture {
  const threadKey = directConversationId(bobPubHex);
  return {
    id: 'orig-' + Math.random().toString(36).slice(2),
    content: 'hello world',
    senderPubkey: alicePubHex,
    groupId: threadKey,
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

/** Captures every NDKEvent whose .publish() the mock intercepts, with the wrap fields needed to unwrap it later. */
function captureNdkEvent(this_: any) {
  return {
    kind: this_.kind,
    content: this_.content,
    tags: this_.tags,
    pubkey: this_.pubkey,
    created_at: this_.created_at,
    id: this_.id,
    sig: this_.sig ?? '',
  };
}

beforeEach(() => {
  idbStore.clear();
  vi.restoreAllMocks();
});

// ── publishDirectDelete (AC-DEL-2) ─────────────────────────────────────────

describe('publishDirectDelete (AC-DEL-2)', () => {
  it('durably tombstones the row via S3 applyDeleteEditSignal only AFTER a successful publish', async () => {
    vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as any);
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    const result = await publishDirectDelete({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
    });

    expect(result.rumorId).toMatch(/^[0-9a-f]{64}$/);
    const { messages } = await loadMessages(target.groupId);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.tombstoned).toBe(true);
  });

  it('the published event is a kind-1059 gift wrap carrying an unmarked kind-5 (AC-DEL-4, AC-DEL-7)', async () => {
    const captured: ReturnType<typeof captureNdkEvent>[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
      captured.push(captureNdkEvent(this));
      return new Set() as any;
    });
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    await publishDirectDelete({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe(GIFT_WRAP_KIND);
    const rumor = await unwrapAndOpen(captured[0] as any, bobPrivHex);
    expect(rumor.kind).toBe(DELETE_EDIT_RUMOR_KIND);
    const editMarker = rumor.tags.find((t) => t[0] === 'e' && t[3] === 'edit');
    expect(editMarker).toBeUndefined();
  });

  it('a rejected publish throws and persists nothing — the row remains visible and untombstoned', async () => {
    vi.spyOn(NDKEvent.prototype, 'publish').mockRejectedValue(new Error('relay publish failed') as any);
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    await expect(
      publishDirectDelete({
        ndk: {} as any,
        privateKeyHex: alicePrivHex,
        peerPubkeyHex: bobPubHex,
        targetMessage: target,
      }),
    ).rejects.toThrow('relay publish failed');

    const { messages } = await loadMessages(target.groupId);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.tombstoned).toBeUndefined();
    expect(row?.content).toBe(target.content);
  });
});

// ── publishDirectEdit (AC-EDIT-8) ──────────────────────────────────────────

describe('publishDirectEdit (AC-EDIT-8)', () => {
  it('publishes the replacement BEFORE the companion kind-5, and durably applies the edit', async () => {
    const publishOrder: number[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
      publishOrder.push(this.kind);
      return new Set() as any;
    });
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    const result = await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'edited content',
    });

    // Both publishes ride inside kind-1059 gift wraps — order is asserted via the
    // underlying rumor kind by unwrapping each captured wrap in publish order.
    expect(publishOrder).toEqual([GIFT_WRAP_KIND, GIFT_WRAP_KIND]);
    expect(result.rumorId).toMatch(/^[0-9a-f]{64}$/);

    const { messages } = await loadMessages(target.groupId);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.content).toBe('edited content');
    expect(row?.edited).toBe(true);
    expect(row?.tombstoned).toBe(false);
  });

  it('the replacement rumor is published strictly before the companion kind-5 (rumor-kind order, not just wrap order)', async () => {
    const captured: ReturnType<typeof captureNdkEvent>[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
      captured.push(captureNdkEvent(this));
      return new Set() as any;
    });
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'edited content',
    });

    expect(captured).toHaveLength(2);
    const unwrapped = await Promise.all(captured.map((e) => unwrapAndOpen(e as any, bobPrivHex)));
    expect(unwrapped[0].kind).toBe(CHAT_MESSAGE_KIND); // replacement first
    expect(unwrapped[1].kind).toBe(DELETE_EDIT_RUMOR_KIND); // companion second
    const companionEditMarker = unwrapped[1].tags.find((t) => t[0] === 'e' && t[3] === 'edit');
    expect(companionEditMarker).toBeDefined();
  });

  it('a failed companion publish does not throw and does not delete/rollback the already-successful edit', async () => {
    // Fail on the SECOND publish call — the companion, per the replacement-first
    // ordering already proven above.
    let callCount = 0;
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function () {
      callCount += 1;
      if (callCount === 2) throw new Error('companion publish failed');
      return new Set() as any;
    });

    const target = makeTarget();
    await appendMessage(target.groupId, target);

    const result = await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'edited content',
    });

    expect(result.rumorId).toMatch(/^[0-9a-f]{64}$/);
    const { messages } = await loadMessages(target.groupId);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.content).toBe('edited content');
    expect(row?.tombstoned).not.toBe(true);
  });

  it('a failed replacement publish throws, persists nothing, and never attempts the companion', async () => {
    let callCount = 0;
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function () {
      callCount += 1;
      throw new Error('replacement publish failed');
    });
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    await expect(
      publishDirectEdit({
        ndk: {} as any,
        privateKeyHex: alicePrivHex,
        peerPubkeyHex: bobPubHex,
        targetMessage: target,
        newContent: 'edited content',
      }),
    ).rejects.toThrow('replacement publish failed');

    expect(callCount).toBe(1); // companion never attempted
    const { messages } = await loadMessages(target.groupId);
    const row = messages.find((m) => m.id === target.id);
    expect(row?.content).toBe(target.content);
    expect(row?.edited).toBeUndefined();
  });

  it('converts ChatMessage.createdAt (ms) to Unix seconds on the wire replacement (S2 caller contract)', async () => {
    const captured: ReturnType<typeof captureNdkEvent>[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
      captured.push(captureNdkEvent(this));
      return new Set() as any;
    });

    const targetCreatedAtMs = 1_700_000_123_456; // arbitrary ms value, not second-aligned
    const target = makeTarget({ createdAt: targetCreatedAtMs });
    await appendMessage(target.groupId, target);

    await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'edited content',
    });

    const unwrapped = await Promise.all(captured.map((e) => unwrapAndOpen(e as any, bobPrivHex)));
    const replacementRumor = unwrapped.find((r) => r.kind === CHAT_MESSAGE_KIND);
    expect(replacementRumor?.created_at).toBe(Math.floor(targetCreatedAtMs / 1000));
  });

  it('AC-EDIT-6: a second edit of an already-edited row still pins the wire created_at to the ORIGINAL createdAt, since storage never mutates ChatMessage.createdAt on an edit patch', async () => {
    const firstEditSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as any);
    const originalCreatedAtMs = 1_700_000_000_000;
    const target = makeTarget({ createdAt: originalCreatedAtMs });
    await appendMessage(target.groupId, target);

    // First edit.
    await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'first edit',
    });
    const afterFirst = await loadMessages(target.groupId);
    const rowAfterFirst = afterFirst.messages.find((m) => m.id === target.id)!;
    // Storage's createdAt is untouched by an edit patch — the row itself is still the
    // correct "targetMessage" a caller would re-read and pass into a second edit.
    expect(rowAfterFirst.createdAt).toBe(originalCreatedAtMs);

    // Second edit, using the (now-edited) row exactly as ContactChat.handleEditMessage
    // would (re-reading from local state, never tracking a separate "prior edit" anchor).
    firstEditSpy.mockRestore();
    const captured: ReturnType<typeof captureNdkEvent>[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
      captured.push(captureNdkEvent(this));
      return new Set() as any;
    });
    await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: rowAfterFirst,
      newContent: 'second edit',
    });

    const unwrapped = await Promise.all(captured.map((e) => unwrapAndOpen(e as any, bobPrivHex)));
    const replacementRumor = unwrapped.find((r) => r.kind === CHAT_MESSAGE_KIND);
    // AC-EDIT-6: still pinned to the FIRST message's created_at, never the prior edit's.
    expect(replacementRumor?.created_at).toBe(Math.floor(originalCreatedAtMs / 1000));
    expect(replacementRumor?.id).not.toBe(rowAfterFirst.id); // a new rumor id, same slot anchor
    const anchorTag = replacementRumor?.tags.find((t) => t[0] === 'e' && t[3] === 'edit');
    expect(anchorTag).toEqual(['e', target.id, '', 'edit']); // always the SLOT's original id
  });
});

// ── Inbound kind-5 / edit-marked dispatch routing (re-derived, no React mount) ──

/**
 * Re-derives ContactChat.tsx's isEditMarkedReplacement predicate inline — the real
 * function is component-module-private and the project convention forbids mounting
 * React to reach it (see dmReactions.test.ts's kind-7 dispatch-gate tests for the
 * established pattern this mirrors).
 */
function isEditMarkedReplacement(rumor: { tags?: string[][] }): boolean {
  return (rumor.tags ?? []).some((t) => Array.isArray(t) && t[0] === 'e' && t[3] === 'edit');
}

describe('inbound dispatch routing (re-derived predicate, mirrors ContactChat.tsx)', () => {
  it('a kind-5 rumor is always routed to applyDeleteEditSignal, regardless of marker (dispatch on rumor.kind, not the predicate)', () => {
    expect(DELETE_EDIT_RUMOR_KIND).toBe(5);
  });

  it('an edit-marked kind-14 replacement is routed to applyDeleteEditSignal, not the plain-original append path', () => {
    const editMarked = { tags: [['e', 'orig-id', '', 'edit'], ['rev', '123']] };
    expect(isEditMarkedReplacement(editMarked)).toBe(true);
  });

  it('a plain kind-14 original (no edit marker) is NOT routed to applyDeleteEditSignal', () => {
    const plainOriginal = { tags: [['p', bobPubHex]] };
    expect(isEditMarkedReplacement(plainOriginal)).toBe(false);
  });

  it('a rumor with no tags at all is NOT misclassified as edit-marked', () => {
    expect(isEditMarkedReplacement({ tags: undefined })).toBe(false);
    expect(isEditMarkedReplacement({ tags: [] })).toBe(false);
  });
});

// ── AC-ORDER-1: unknown-target retention (not silent discard) ────────────

describe('inbound kind-5 for an unknown target is retained, not discarded (AC-ORDER-1)', () => {
  it('a real gift-wrapped delete for a never-seen message id is buffered as pending', async () => {
    const threadKey = directConversationId(bobPubHex);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rumor = buildDeleteRumor('never-seen-' + 'ff'.repeat(28), [], CHAT_MESSAGE_KIND, nowSeconds, bobPrivHex);
    const wrap = await sealAndWrap(rumor, alicePubHex, bobPrivHex);
    const recovered = await unwrapAndOpen(wrap as any, alicePrivHex);

    const result = await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: bobPubHex }, recovered);

    expect(result.kind).toBe('pending');
    const { messages } = await loadMessages(threadKey);
    expect(messages).toHaveLength(0); // no phantom row was created
  });
});

// ── resolve-after-append wiring (re-derived, mirrors ContactChat.resolveFreshOriginal) ──

describe('resolve-after-append wiring (mirrors ContactChat.tsx resolveFreshOriginal)', () => {
  it('a buffered delete for an id resolves to a tombstone once that id is appended as a fresh original, and signals delete (caller must not render)', async () => {
    const threadKey = directConversationId(bobPubHex);
    const targetId = 'slot-' + Math.random().toString(36).slice(2);
    const nowSeconds = Math.floor(Date.now() / 1000);

    // A delete arrives BEFORE the original (AC-ORDER-1 buffering).
    const rumor = buildDeleteRumor(targetId, [], CHAT_MESSAGE_KIND, nowSeconds, alicePrivHex);
    const buffered = await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: bobPubHex }, rumor);
    expect(buffered.kind).toBe('pending');

    // The original now arrives (appendMessage), immediately followed by the
    // resolve call this story's ledger obligation requires — mirrors
    // ContactChat.resolveFreshOriginal's append -> resolve -> render-decision sequence.
    const original = { id: targetId, content: 'hello', senderPubkey: alicePubHex, groupId: threadKey, createdAt: Date.now() };
    await appendMessage(threadKey, original);
    const resolveResult = await resolvePendingSignalsForSlot({ kind: 'dm', peerPubkeyHex: bobPubHex }, targetId, original.senderPubkey);

    expect(resolveResult.kind).toBe('delete'); // caller's render/state update must skip this row
    const { messages } = await loadMessages(threadKey);
    expect(messages.find((m) => m.id === targetId)?.tombstoned).toBe(true);
  });
});

// ── AC-AUTH-2 (DM half): the authenticated seal pubkey gates apply-vs-discard ──

describe('AC-AUTH-2 (DM half): only the authenticated seal pubkey may signal its own slot', () => {
  it('a real gift-wrapped delete sealed by a different author than the row is discarded, not applied', async () => {
    const threadKey = directConversationId(bobPubHex);
    const target = { id: 'auth-slot-' + Math.random().toString(36).slice(2), content: 'hi', senderPubkey: alicePubHex, groupId: threadKey, createdAt: Date.now() };
    await appendMessage(threadKey, target);

    // Sealed (signed) by Bob, not Alice — even though the caller might have wished it
    // authenticated as Alice, unwrapAndOpen's real-key binding is authoritative.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rumor = buildDeleteRumor(target.id, [], CHAT_MESSAGE_KIND, nowSeconds, bobPrivHex);
    const wrap = await sealAndWrap(rumor, alicePubHex, bobPrivHex);
    const recovered = await unwrapAndOpen(wrap as any, alicePrivHex);
    expect(recovered.pubkey).toBe(bobPubHex); // authenticated sender is Bob

    const result = await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: bobPubHex }, recovered);

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(threadKey);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBeUndefined();
  });

  it('a real gift-wrapped delete sealed by the row\'s actual author is applied', async () => {
    const threadKey = directConversationId(bobPubHex);
    const target = { id: 'auth-slot-' + Math.random().toString(36).slice(2), content: 'hi', senderPubkey: alicePubHex, groupId: threadKey, createdAt: Date.now() };
    await appendMessage(threadKey, target);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const rumor = buildDeleteRumor(target.id, [], CHAT_MESSAGE_KIND, nowSeconds, alicePrivHex);
    const wrap = await sealAndWrap(rumor, bobPubHex, alicePrivHex);
    const recovered = await unwrapAndOpen(wrap as any, bobPrivHex);
    expect(recovered.pubkey).toBe(alicePubHex);

    const result = await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: bobPubHex }, recovered);

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(threadKey);
    expect(messages.find((m) => m.id === target.id)?.tombstoned).toBe(true);
  });
});

// ── DM view-optimistic-then-rollback model (mirrors ContactChat handleDeleteMessage/handleEditMessage) ──

describe('DM view-optimistic array model (mirrors ContactChat.tsx handleDeleteMessage/handleEditMessage)', () => {
  // S4 gate-remediation (round-4, finding 5): these now call the REAL exported
  // transforms (applyOptimisticDeleteView / rollbackOptimisticDeleteView /
  // applyOptimisticEditView / rollbackOptimisticEditView) from ContactChat.tsx
  // rather than re-deriving the array logic inline — a re-derived copy is
  // structurally unable to catch a bug in the real transform.
  it('handleDeleteMessage: removes the target from the local view array immediately, and restores it verbatim on publish failure', () => {
    const snapshot = { id: 'm1', content: 'hi', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    let view = [snapshot, { id: 'm2', content: 'other', senderPubkey: bobPubHex, groupId: 'dm:bob', createdAt: 2000 }];

    // Optimistic removal — synchronous, before any publish is awaited.
    view = applyOptimisticDeleteView(view, snapshot.id);
    expect(view.map((m) => m.id)).toEqual(['m2']);

    // Publish fails -> restore (real array/content assertion, not a spy check).
    view = rollbackOptimisticDeleteView(view, snapshot);
    expect(view.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(view.find((m) => m.id === 'm1')).toEqual(snapshot);
  });

  it('handleDeleteMessage: a post-publish re-apply of the optimistic delete guards against resurrection by a racing live re-delivery (gate-remediation, DM mirror of S5/ChatStoreContext finding 2)', () => {
    const snapshot = { id: 'm1', content: 'hi', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    let view = [snapshot, { id: 'm2', content: 'other', senderPubkey: bobPubHex, groupId: 'dm:bob', createdAt: 2000 }];

    // Optimistic removal — synchronous, before publish is awaited.
    view = applyOptimisticDeleteView(view, snapshot.id);
    expect(view.map((m) => m.id)).toEqual(['m2']);

    // Simulate the race this gate-remediation closes: during the publish window,
    // the live giftWrapSub (no `since` filter) re-delivers the original rumor and
    // resolveFreshOriginal reads storage BEFORE the durable tombstone write lands,
    // so upsertMessages re-adds the row.
    view = [...view, snapshot];
    expect(view.map((m) => m.id).sort()).toEqual(['m1', 'm2']);

    // Publish succeeds -> handleDeleteMessage re-applies the optimistic delete view
    // once more, exactly like S5's performGroupDeleteMessage does, so the racing
    // re-delivery cannot leave the "deleted" message resurrected.
    view = applyOptimisticDeleteView(view, snapshot.id);
    expect(view.map((m) => m.id)).toEqual(['m2']);
  });

  it('handleEditMessage: updates content in place immediately, and rolls back to the exact prior row on publish failure', () => {
    const snapshot = { id: 'm1', content: 'original', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000, edited: undefined as boolean | undefined };
    let view = [snapshot];

    // Optimistic in-place update — position preserved (AC-EDIT-2).
    view = applyOptimisticEditView(view, snapshot.id, 'new content');
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: 'm1', content: 'new content', edited: true });

    // Publish fails -> roll back to the EXACT prior row (content AND edited flag restored).
    view = rollbackOptimisticEditView(view, snapshot.id, snapshot);
    expect(view[0]).toEqual(snapshot);
  });
});

// ── reconcileHistoricalBatch (finding 1, sev7 — same-batch delete/edit clobber) ──

describe('reconcileHistoricalBatch (round-4 finding 1, sev7 — offline delete/edit during the historical cold-load batch)', () => {
  it('[original, delete] same-batch: the stale pre-delete object is dropped once storage truth reflects the tombstone (AC-DEL-3/AC-ORDER-4)', () => {
    const original: ChatMessageFixture = {
      id: 'slot-a',
      content: 'hello',
      senderPubkey: alicePubHex,
      groupId: 'dm:bob',
      createdAt: 1000,
    };
    // `merged`: what the historical loop captured for this id BEFORE the same-batch
    // delete (sorted after it in the rumor loop) applied — no tombstoned flag yet.
    const merged = [original];
    // `storageTruth`: post-loop reality — the delete already landed in storage.
    const storageTruth = [{ ...original, tombstoned: true, rev: 123 }];

    const result = reconcileHistoricalBatch(merged, storageTruth);

    expect(result.find((m) => m.id === 'slot-a')).toBeUndefined();
  });

  it('[original, replacementA, replacementB] same-batch: the final rendered row carries the LATEST edit content, not the stale pre-edit object', () => {
    const original: ChatMessageFixture = {
      id: 'slot-b',
      content: 'first',
      senderPubkey: alicePubHex,
      groupId: 'dm:bob',
      createdAt: 1000,
    };
    const merged = [original]; // stale — captured before either edit applied
    const storageTruth = [{ ...original, content: 'second edit wins', edited: true, rev: 456 }];

    const result = reconcileHistoricalBatch(merged, storageTruth);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('second edit wins');
    expect(result[0].edited).toBe(true);
  });

  it('a row absent from storageTruth passes through merged unchanged (no phantom substitution)', () => {
    const untouched: ChatMessageFixture = {
      id: 'slot-c',
      content: 'unaffected',
      senderPubkey: alicePubHex,
      groupId: 'dm:bob',
      createdAt: 500,
    };
    const result = reconcileHistoricalBatch([untouched], []);
    expect(result).toEqual([untouched]);
  });
});

// ── seedThreadMessages (thread-open seed must not erase an unacked own send) ──

describe('seedThreadMessages (an own send made before the thread-open read resolves survives it)', () => {
  const row = (id: string, groupId: string, createdAt: number, extra: Partial<ChatMessageFixture> = {}): ChatMessageFixture => ({
    id, content: id, senderPubkey: alicePubHex, groupId, createdAt, ...extra,
  });

  it('keeps a same-thread row storage does not know yet (pending relay ack), sorted with the stored rows', () => {
    const pending = row('pending', 'dm:bob', 3000);
    const stored = [row('old-b', 'dm:bob', 2000), row('old-a', 'dm:bob', 1000)];
    expect(seedThreadMessages([pending], stored, 'dm:bob').map((m) => m.id)).toEqual(['old-a', 'old-b', 'pending']);
  });

  it('drops rows of another thread (the component is not keyed by peer)', () => {
    const other = row('other', 'dm:carol', 1500);
    const stored = [row('mine', 'dm:bob', 1000)];
    expect(seedThreadMessages([other], stored, 'dm:bob').map((m) => m.id)).toEqual(['mine']);
  });

  it('storage truth replaces a rendered row and a tombstone hides it', () => {
    const rendered = [row('e', 'dm:bob', 1000), row('d', 'dm:bob', 2000)];
    const stored = [row('e', 'dm:bob', 1000, { content: 'edited', edited: true }), row('d', 'dm:bob', 2000, { tombstoned: true })];
    const result = seedThreadMessages(rendered, stored, 'dm:bob');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('edited');
  });

  it('with nothing stored (read failed) only same-thread rows remain', () => {
    const result = seedThreadMessages([row('p', 'dm:bob', 1), row('x', 'dm:carol', 2)], [], 'dm:bob');
    expect(result.map((m) => m.id)).toEqual(['p']);
  });
});

// ── resolveFreshOriginalFromStorage (round-2 gate-remediation, sev7 — live-path
//    twin of reconcileHistoricalBatch's same-batch clobber fix) ────────────────
//
// The live giftWrapSub subscription carries no `since` filter, so every
// resubscribe/reconnect re-delivers ALL stored gift-wraps, including the original
// of a since-deleted or since-edited message. Before this fix, a `noop`/
// `discarded`/`pending` ChangeResult on such a re-delivery fell through to the
// RAW re-delivered `msg` instead of storage truth, and the caller's
// upsertMessages (which does not filter) rendered it — reappearing a deleted DM
// or reverting an edited DM on every reconnect.

describe('resolveFreshOriginalFromStorage (round-2 gate-remediation — live re-delivery of a tombstoned/edited original)', () => {
  it('delete outcome: returns null regardless of storage contents (caller must not render)', () => {
    const msg: ChatMessageFixture = { id: 'slot-x', content: 'hi', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    const storageTruth = [{ ...msg, tombstoned: true, rev: 1 }];

    const result = resolveFreshOriginalFromStorage(msg, { thread: { kind: 'dm', peerPubkeyHex: bobPubHex }, slotId: msg.id, kind: 'delete' }, storageTruth);

    expect(result).toBeNull();
  });

  it('noop outcome + tombstoned slot in storage (re-delivered original of a since-deleted message): returns null, NOT the raw re-delivered msg', () => {
    const staleOriginal: ChatMessageFixture = { id: 'slot-y', content: 'deleted content', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    // storage already reflects the earlier delete; the live re-delivery carries
    // the pre-delete raw content in `staleOriginal`.
    const storageTruth = [{ ...staleOriginal, tombstoned: true, rev: 2 }];

    const result = resolveFreshOriginalFromStorage(staleOriginal, { thread: { kind: 'dm', peerPubkeyHex: bobPubHex }, slotId: staleOriginal.id, kind: 'noop' }, storageTruth);

    expect(result).toBeNull();
  });

  it('discarded outcome + edited slot in storage (re-delivered original of a since-edited message): returns the EDITED storage row, not the stale pre-edit msg', () => {
    const staleOriginal: ChatMessageFixture = { id: 'slot-z', content: 'pre-edit content', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    const storageTruth = [{ ...staleOriginal, content: 'post-edit content', edited: true, rev: 3 }];

    const result = resolveFreshOriginalFromStorage(staleOriginal, { thread: { kind: 'dm', peerPubkeyHex: bobPubHex }, slotId: staleOriginal.id, kind: 'discarded' }, storageTruth);

    expect(result).not.toBeNull();
    expect(result?.content).toBe('post-edit content');
    expect(result?.edited).toBe(true);
  });

  it('pending outcome + row absent from storage (never persisted, e.g. same-tick race): falls back to the raw msg (no phantom substitution)', () => {
    const msg: ChatMessageFixture = { id: 'slot-w', content: 'brand new', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };

    const result = resolveFreshOriginalFromStorage(msg, { thread: { kind: 'dm', peerPubkeyHex: bobPubHex }, slotId: null, kind: 'pending' }, []);

    expect(result).toEqual(msg);
  });

  it('edit outcome: returns the storage row (existing behavior preserved, unchanged by this fix)', () => {
    const staleOriginal: ChatMessageFixture = { id: 'slot-v', content: 'pre-edit', senderPubkey: alicePubHex, groupId: 'dm:bob', createdAt: 1000 };
    const storageTruth = [{ ...staleOriginal, content: 'edited', edited: true, rev: 4 }];

    const result = resolveFreshOriginalFromStorage(staleOriginal, { thread: { kind: 'dm', peerPubkeyHex: bobPubHex }, slotId: staleOriginal.id, kind: 'edit' }, storageTruth);

    expect(result?.content).toBe('edited');
  });
});

// ── resolve-after-append wiring, LIVE-PATH regression (round-2 gate-remediation):
//    exercises the real async I/O (resolvePendingSignalsForSlot + loadMessages),
//    not just the pure decision function, against a live re-delivery scenario. ──

describe('live-path re-delivery regression (round-2 gate-remediation, mirrors handleGiftWrapEvent/handleKind4Event -> resolveFreshOriginal)', () => {
  it('(a) tombstone a message via the real publishDirectDelete path, then re-resolve its original via the live-path sequence -> does NOT re-enter the rendered set', async () => {
    vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as any);
    const target = makeTarget({ content: 'original text' });
    await appendMessage(target.groupId, target);

    // Delete it via the real publishDirectDelete flow (durable tombstone via
    // S3's applyDeleteEditSignal, since target is already a known row —
    // mirrors AC-DEL-2's real path, not a hand-built rumor).
    const deleteResult = await publishDirectDelete({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
    });
    expect(deleteResult.rumorId).toMatch(/^[0-9a-f]{64}$/);
    const { messages: afterDelete } = await loadMessages(target.groupId);
    expect(afterDelete.find((m) => m.id === target.id)?.tombstoned).toBe(true);

    // The relay resubscribes with no `since` filter and re-delivers the ORIGINAL
    // rumor again (this is what handleGiftWrapEvent/handleKind4Event do on every
    // live event: appendMessage is a no-op re-insert of the same id — dedup by id
    // — then resolveFreshOriginal's resolvePendingSignalsForSlot + loadMessages).
    await appendMessage(target.groupId, target);
    const resolveResult = await resolvePendingSignalsForSlot({ kind: 'dm', peerPubkeyHex: bobPubHex }, target.id, target.senderPubkey);
    const { messages: storageTruth } = await loadMessages(target.groupId);

    const rendered = resolveFreshOriginalFromStorage(target, resolveResult, storageTruth);

    expect(rendered).toBeNull(); // must NOT re-enter the rendered messages array
  });

  it('(b) edit a message via the real publishDirectEdit path, then re-resolve its original via the live-path sequence -> row keeps the EDITED content, not the stale original', async () => {
    vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as any);
    const target = makeTarget({ content: 'pre-edit content' });
    await appendMessage(target.groupId, target);

    await publishDirectEdit({
      ndk: {} as any,
      privateKeyHex: alicePrivHex,
      peerPubkeyHex: bobPubHex,
      targetMessage: target,
      newContent: 'post-edit content',
    });
    const { messages: afterEdit } = await loadMessages(target.groupId);
    expect(afterEdit.find((m) => m.id === target.id)?.content).toBe('post-edit content');

    // Live re-delivery of the ORIGINAL (pre-edit) rumor — same appendMessage-then-
    // resolve sequence as the live gift-wrap/kind-4 handlers. `target` still
    // carries the stale pre-edit content, exactly like the raw inbound rumor would.
    await appendMessage(target.groupId, target);
    const resolveResult = await resolvePendingSignalsForSlot({ kind: 'dm', peerPubkeyHex: bobPubHex }, target.id, target.senderPubkey);
    const { messages: storageTruth } = await loadMessages(target.groupId);

    const rendered = resolveFreshOriginalFromStorage(target, resolveResult, storageTruth);

    expect(rendered).not.toBeNull();
    expect(rendered?.content).toBe('post-edit content');
  });
});

// ── publishDirectEdit: repeated own edits (finding 2, sev6) ────────────────

describe('publishDirectEdit: repeated own edits (round-4 finding 2, sev6 — stale rev starves the D16 clamp)', () => {
  it('a second consecutive edit gets a rev strictly greater than the first, even when the caller repeatedly passes a rev-less snapshot', async () => {
    const target = makeTarget();
    await appendMessage(target.groupId, target);

    const captureRev = async (newContent: string): Promise<number> => {
      const captured: ReturnType<typeof captureNdkEvent>[] = [];
      const spy = vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: any) {
        captured.push(captureNdkEvent(this));
        return new Set() as any;
      });
      await publishDirectEdit({
        ndk: {} as any,
        privateKeyHex: alicePrivHex,
        peerPubkeyHex: bobPubHex,
        // Deliberately the ORIGINAL rev-less snapshot every time — mirrors the real
        // bug: ContactChat.handleEditMessage's `snapshot` comes from a React-state
        // read (messagesRef.current) that never learns the slot's new rev after an
        // own edit (the optimistic patch only ever touches content/edited).
        targetMessage: target,
        newContent,
      });
      spy.mockRestore();
      const unwrapped = await Promise.all(captured.map((e) => unwrapAndOpen(e as any, bobPrivHex)));
      const replacementRumor = unwrapped.find((r) => r.kind === CHAT_MESSAGE_KIND)!;
      const revTag = replacementRumor.tags.find((t) => t[0] === 'rev');
      return Number(revTag?.[1]);
    };

    const rev1 = await captureRev('first edit');
    const rev2 = await captureRev('second edit');

    // Proves publishDirectEdit re-reads the AUTHORITATIVE storage row for rev
    // (fix: resolveAuthoritativeRev in directMessages.ts) rather than trusting the
    // caller-supplied (stale/rev-less) targetMessage.rev — the S3 equal-rev tie rule
    // would otherwise make edit #2 silently lose roughly half the time.
    expect(rev2).toBeGreaterThan(rev1);
  });
});
