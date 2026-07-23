/**
 * Storage foundation for message edit/delete
 * (epic-feature-request-message-edit-and-delete, S1).
 *
 * Covers the new `chatPersistence.ts` primitives:
 *   - updateMessageInPlace(groupId, id, patch)   — AC-EDIT-2
 *   - tombstoneMessage(groupId, id, rev)         — AC-DEL-5, AC-IMG-1
 *   - AC-STORE-3 clobber-guard (rev=0/absent must not clobber edited/tombstoned)
 *   - filterVisibleMessages(messages)            — read-side tombstone filter
 *
 * Mocking convention: idb-keyval backed by a Map, matching
 * app/tests/unit/reactions/api.test.ts and
 * app/tests/unit/chatPersistence-property.test.ts. No fast-check, no jsdom —
 * table-driven `it.each` / hand-rolled parametric loops per project
 * convention (architecture.md "Testing: NO fast-check, NO jsdom").
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

// ── idb-keyval mock (Map-backed) ──────────────────────────────────────────────

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

// ── Module import (after mock is set up) ──────────────────────────────────────

const {
  appendMessage,
  loadMessages,
  updateMessageInPlace,
  tombstoneMessage,
  filterVisibleMessages,
} = await import('@/src/lib/marmot/chatPersistence');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '0'.repeat(64),
    content: 'hello',
    senderPubkey: 'aabb'.repeat(16),
    groupId: 'dm:test',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeImageMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return makeMsg({
    attachments: {
      full: {
        url: 'https://example.com/img.webp',
        sha256: 'a'.repeat(64),
        width: 100,
        height: 100,
      } as any,
    },
    ...overrides,
  });
}

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
});

// ── updateMessageInPlace: preserves position (AC-EDIT-2) ─────────────────────

describe('updateMessageInPlace — updates content/edited/rev in place without reordering (AC-EDIT-2)', () => {
  it('preserves the row\'s index/position in the stored array', async () => {
    await appendMessage('group-pos', makeMsg({ id: 'a'.repeat(64), content: 'A' }));
    await appendMessage('group-pos', makeMsg({ id: 'b'.repeat(64), content: 'B' }));
    await appendMessage('group-pos', makeMsg({ id: 'c'.repeat(64), content: 'C' }));

    await updateMessageInPlace('group-pos', 'b'.repeat(64), {
      content: 'B-edited',
      edited: true,
      rev: 1_700_000_500,
    });

    const { messages } = await loadMessages('group-pos');
    // Same length, same order — no re-insertion, no reordering.
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    // Index 1 (the same position B occupied before) now carries the edit.
    expect(messages[1].id).toBe('b'.repeat(64));
    expect(messages[1].content).toBe('B-edited');
    expect(messages[1].edited).toBe(true);
    expect(messages[1].rev).toBe(1_700_000_500);
  });

  it('leaves sibling rows completely unchanged', async () => {
    await appendMessage('group-siblings', makeMsg({ id: 'a'.repeat(64), content: 'A' }));
    await appendMessage('group-siblings', makeMsg({ id: 'b'.repeat(64), content: 'B' }));

    await updateMessageInPlace('group-siblings', 'a'.repeat(64), { content: 'A-edited', rev: 5 });

    const { messages } = await loadMessages('group-siblings');
    const rowB = messages.find((m) => m.id === 'b'.repeat(64));
    expect(rowB?.content).toBe('B');
    expect(rowB?.edited).toBeUndefined();
  });

  it('no-ops when the id is not present (does not write or throw)', async () => {
    await appendMessage('group-missing', makeMsg({ id: 'a'.repeat(64) }));

    const idbSet = vi.mocked((await import('idb-keyval')).set);
    idbSet.mockClear();

    await expect(
      updateMessageInPlace('group-missing', 'z'.repeat(64), { content: 'nope', rev: 1 }),
    ).resolves.toBeUndefined();
    expect(idbSet).not.toHaveBeenCalled();

    const { messages } = await loadMessages('group-missing');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello'); // unchanged (makeMsg default content)
  });

  it('only patches the fields provided — omitted fields are left unchanged', async () => {
    await appendMessage('group-partial', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    await updateMessageInPlace('group-partial', 'a'.repeat(64), { edited: true, rev: 7 });

    const { messages } = await loadMessages('group-partial');
    expect(messages[0].content).toBe('orig'); // untouched
    expect(messages[0].edited).toBe(true);
    expect(messages[0].rev).toBe(7);
  });

  it('is idempotent — re-applying an identical patch produces the same end state', async () => {
    await appendMessage('group-idem', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    const patch = { content: 'v2', edited: true, rev: 42 };
    await updateMessageInPlace('group-idem', 'a'.repeat(64), patch);
    await updateMessageInPlace('group-idem', 'a'.repeat(64), patch);

    const { messages } = await loadMessages('group-idem');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject(patch);
  });
});

// ── tombstoneMessage: retains the row, hides from render (AC-DEL-5) ──────────

describe('tombstoneMessage — retains the row physically, never calls removeMessages (AC-DEL-5)', () => {
  it('flips tombstoned:true and stores rev while the row remains in raw storage', async () => {
    await appendMessage('group-tomb', makeMsg({ id: 'a'.repeat(64) }));

    await tombstoneMessage('group-tomb', 'a'.repeat(64), 99);

    const { messages } = await loadMessages('group-tomb');
    // Row count unchanged — physically retained, not purged.
    expect(messages).toHaveLength(1);
    expect(messages[0].tombstoned).toBe(true);
    expect(messages[0].rev).toBe(99);
  });

  it('a re-delivered original for that id cannot resurrect it (AC-DEL-5)', async () => {
    await appendMessage('group-resurrect', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-resurrect', 'a'.repeat(64), 10);

    // Simulate re-delivery of the exact same original rumor (same id, appendMessage
    // dedup-by-id path).
    await appendMessage('group-resurrect', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    const { messages } = await loadMessages('group-resurrect');
    expect(messages).toHaveLength(1);
    expect(messages[0].tombstoned).toBe(true);
  });

  it('the tombstoned row is filtered out of filterVisibleMessages (hidden from render)', async () => {
    await appendMessage('group-hide', makeMsg({ id: 'a'.repeat(64) }));
    await appendMessage('group-hide', makeMsg({ id: 'b'.repeat(64) }));
    await tombstoneMessage('group-hide', 'a'.repeat(64), 5);

    const { messages } = await loadMessages('group-hide');
    // Raw read still includes the tombstoned row (needed by backup / reconciliation).
    expect(messages).toHaveLength(2);

    const visible = filterVisibleMessages(messages);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('b'.repeat(64));
  });

  it('never invokes removeMessages internally — the row count never drops to 0', async () => {
    await appendMessage('group-no-hard-delete', makeMsg({ id: 'a'.repeat(64) }));
    await tombstoneMessage('group-no-hard-delete', 'a'.repeat(64), 1);
    await tombstoneMessage('group-no-hard-delete', 'a'.repeat(64), 2); // idempotent re-application

    const { messages } = await loadMessages('group-no-hard-delete');
    expect(messages).toHaveLength(1);
  });

  it('is idempotent — tombstoning twice leaves a single tombstoned row', async () => {
    await appendMessage('group-tomb-idem', makeMsg({ id: 'a'.repeat(64) }));
    await tombstoneMessage('group-tomb-idem', 'a'.repeat(64), 3);
    await tombstoneMessage('group-tomb-idem', 'a'.repeat(64), 3);

    const { messages } = await loadMessages('group-tomb-idem');
    expect(messages).toHaveLength(1);
    expect(messages[0].tombstoned).toBe(true);
  });
});

// ── AC-IMG-1: image rows tombstone identically to text rows ──────────────────

describe('tombstoneMessage — image-shaped rows tombstone identically to text rows (AC-IMG-1)', () => {
  it('an image-shaped row (attachments present) is tombstoned via the same path, no image-specific branch', async () => {
    await appendMessage('group-img', makeImageMsg({ id: 'a'.repeat(64) }));

    await tombstoneMessage('group-img', 'a'.repeat(64), 11);

    const { messages } = await loadMessages('group-img');
    expect(messages).toHaveLength(1);
    expect(messages[0].tombstoned).toBe(true);
    // Attachment data survives the tombstone flip (row retained, not stripped).
    expect(messages[0].attachments).toBeDefined();

    const visible = filterVisibleMessages(messages);
    expect(visible).toHaveLength(0);
  });

  it.each([
    { label: 'text row', factory: () => makeMsg({ id: 'a'.repeat(64) }) },
    { label: 'image row', factory: () => makeImageMsg({ id: 'b'.repeat(64) }) },
  ])('$label: tombstoneMessage produces identical tombstoned:true + hidden-from-render outcome', async ({ factory }) => {
    const msg = factory();
    await appendMessage('group-img-parity', msg);
    await tombstoneMessage('group-img-parity', msg.id, 20);

    const { messages } = await loadMessages('group-img-parity');
    const row = messages.find((m) => m.id === msg.id)!;
    expect(row.tombstoned).toBe(true);
    expect(filterVisibleMessages([row])).toHaveLength(0);
  });
});

// ── AC-STORE-3: clobber-guard ─────────────────────────────────────────────────

describe('AC-STORE-3 clobber-guard — rev=0/absent MUST NOT overwrite an edited/tombstoned slot', () => {
  it.each([
    { label: 'rev omitted entirely', patch: { content: 'resurrected' } as const },
    { label: 'rev explicitly 0', patch: { content: 'resurrected', rev: 0 } as const },
  ])('$label: rejected when the existing row is tombstoned — row stays tombstoned, content unchanged', async ({ patch }) => {
    await appendMessage('group-guard-tomb', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-guard-tomb', 'a'.repeat(64), 10);

    const before = await loadMessages('group-guard-tomb');
    expect(before.messages[0].tombstoned).toBe(true);

    await updateMessageInPlace('group-guard-tomb', 'a'.repeat(64), patch);

    const after = await loadMessages('group-guard-tomb');
    expect(after.messages[0].tombstoned).toBe(true);
    expect(after.messages[0].content).toBe('orig'); // NOT clobbered to 'resurrected'
    expect(after.messages[0].rev).toBe(10); // rev unchanged by the rejected write
  });

  it.each([
    { label: 'rev omitted entirely', patch: { content: 'reverted' } as const },
    { label: 'rev explicitly 0', patch: { content: 'reverted', rev: 0 } as const },
  ])('$label: rejected when the existing row is edited — row keeps its edited content', async ({ patch }) => {
    await appendMessage('group-guard-edit', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await updateMessageInPlace('group-guard-edit', 'a'.repeat(64), { content: 'edited-content', edited: true, rev: 15 });

    await updateMessageInPlace('group-guard-edit', 'a'.repeat(64), patch);

    const { messages } = await loadMessages('group-guard-edit');
    expect(messages[0].content).toBe('edited-content'); // NOT clobbered to 'reverted'
    expect(messages[0].edited).toBe(true);
    expect(messages[0].rev).toBe(15);
  });

  it('a real edit/delete signal (rev >= 1) is NOT blocked by the guard on a fresh (non-edited/non-tombstoned) row', async () => {
    await appendMessage('group-guard-fresh', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    // rev=0/absent write on a row that is NOT yet edited/tombstoned must still succeed
    // (the guard only fires when the existing row already carries edited/tombstoned).
    await updateMessageInPlace('group-guard-fresh', 'a'.repeat(64), { content: 'first-touch', rev: 0 });

    const { messages } = await loadMessages('group-guard-fresh');
    expect(messages[0].content).toBe('first-touch');
  });

  it('a subsequent real edit (rev >= 1) after a tombstone is NOT blocked by the guard (guard is rev=0-specific)', async () => {
    // The guard only targets rev=0/absent original re-delivery — a genuine higher-rev
    // edit/delete signal is S3's ordering concern (AC-ORDER-3), not this guard's.
    await appendMessage('group-guard-realedit', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-guard-realedit', 'a'.repeat(64), 10);

    await updateMessageInPlace('group-guard-realedit', 'a'.repeat(64), { content: 'later-edit', edited: true, rev: 20 });

    const { messages } = await loadMessages('group-guard-realedit');
    // Full resulting flag set: under merge semantics (MessagePatch doc), flags are
    // never cleared implicitly — the patch didn't carry `tombstoned:false`, so the
    // row stays tombstoned:true even though it was also just "edited".
    expect(messages[0]).toMatchObject({
      content: 'later-edit',
      edited: true,
      rev: 20,
      tombstoned: true,
    });
  });

  it('appendMessage (insert-if-absent) cannot clobber an edited/tombstoned row on re-delivery of the original', async () => {
    // Simulates the append-path re-delivery scenario directly: appendMessage's existing
    // dedup-by-id no-op is the AC-STORE-3 substrate for this write path.
    await appendMessage('group-guard-append', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await updateMessageInPlace('group-guard-append', 'a'.repeat(64), { content: 'edited', edited: true, rev: 5 });

    // Re-delivered original — same id, same (or differing) content.
    await appendMessage('group-guard-append', makeMsg({ id: 'a'.repeat(64), content: 'orig-redelivered' }));

    const { messages } = await loadMessages('group-guard-append');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('edited');
    expect(messages[0].edited).toBe(true);
  });
});

// ── S9 gate-remediation: a real ANNOUNCEMENT arrival supersedes a
//    materialize-on-expiry placeholder (AC-IMMUT-6 defeated at this ordering
//    — see messageEdits/api.ts's ChatMessage.materializedFromEdit doc
//    comment). Severity-4 gate-remediation round (this file) narrowed the
//    supersession to announcement arrivals only — an ordinary arrival must
//    NOT clobber the placeholder (see the second describe block below) ────

const ANNOUNCEMENT_CONTENT = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });

describe('appendMessage — a row flagged materializedFromEdit is a placeholder, not a real message: a genuine ANNOUNCEMENT arrival at the same id OVERWRITES it (S9 gate-remediation, narrowed to announcements)', () => {
  it('a fresh, unflagged appendMessage carrying announcement content REPLACES a materializedFromEdit row outright, in place', async () => {
    // Simulates messageEdits/api.ts's TTL-expiry materialize-on-expiry
    // fabricating a placeholder row for an edit whose real target never
    // arrived in time (persistExpiredEntryEffect's no-known-row edit branch).
    await appendMessage('group-materialize-super', makeMsg({
      id: 'b'.repeat(64),
      content: 'fabricated edit content',
      rev: 42,
      materializedFromEdit: true,
    }));

    // The real message is a group announcement — the ordinary ingest path
    // never sets materializedFromEdit.
    await appendMessage('group-materialize-super', makeMsg({
      id: 'b'.repeat(64),
      content: ANNOUNCEMENT_CONTENT,
      senderPubkey: 'real-author-pubkey',
    }));

    const { messages } = await loadMessages('group-materialize-super');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(ANNOUNCEMENT_CONTENT);
    expect(messages[0].senderPubkey).toBe('real-author-pubkey');
    // The placeholder's rev/flag do not survive — the real row fully
    // replaces it (a fresh, unedited/untombstoned original).
    expect(messages[0].materializedFromEdit).toBeFalsy();
    expect(messages[0].rev).toBeUndefined();
  });

  it('preserves array position/ordering when the placeholder is superseded by an announcement (mirrors AC-EDIT-2 for update-in-place)', async () => {
    await appendMessage('group-materialize-order', makeMsg({ id: 'a'.repeat(64), content: 'A' }));
    await appendMessage('group-materialize-order', makeMsg({ id: 'b'.repeat(64), content: 'fabricated', materializedFromEdit: true }));
    await appendMessage('group-materialize-order', makeMsg({ id: 'c'.repeat(64), content: 'C' }));

    await appendMessage('group-materialize-order', makeMsg({ id: 'b'.repeat(64), content: ANNOUNCEMENT_CONTENT }));

    const { messages } = await loadMessages('group-materialize-order');
    expect(messages.map((m) => m.content)).toEqual(['A', ANNOUNCEMENT_CONTENT, 'C']);
  });

  it('a REAL row (materializedFromEdit absent) is never overwritten by a later appendMessage — the S8 dedup floor is unchanged', async () => {
    await appendMessage('group-materialize-noop', makeMsg({ id: 'a'.repeat(64), content: 'orig, never fabricated' }));

    await appendMessage('group-materialize-noop', makeMsg({ id: 'a'.repeat(64), content: 'attempted clobber' }));

    const { messages } = await loadMessages('group-materialize-noop');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('orig, never fabricated');
  });
});

// ── Severity-4 gate-remediation regression: an ORDINARY (non-announcement)
//    real-original arrival must NOT supersede a materializedFromEdit
//    placeholder. Pre-fix, an unconditional overwrite here reverted an
//    already-applied edit / resurrected an already-tombstoned message
//    permanently (the pending-signal entry is consumed at TTL expiry and
//    slot dedupe prevents re-application) — restoring the pre-S9
//    insert-if-absent behavior for the ordinary case. ─────────────────────

describe('appendMessage — an ORDINARY real-original arrival must NOT supersede a materializedFromEdit placeholder (severity-4 gate-remediation)', () => {
  it('ordinary edit materializes a placeholder, then a real ordinary original arrives later — the materialized/edited row is PRESERVED, not overwritten', async () => {
    // 1. TTL-expiry materializes an ordinary (non-announcement) placeholder
    // for an edit whose real target never arrived in time.
    await appendMessage('group-ordinary-preserve', makeMsg({
      id: 'd'.repeat(64),
      content: 'edited placeholder content',
      rev: 7,
      edited: true,
      materializedFromEdit: true,
    }));

    // 2. The REAL original (ordinary content, not an announcement) finally
    // arrives — e.g. a delayed/re-delivered rumor.
    await appendMessage('group-ordinary-preserve', makeMsg({
      id: 'd'.repeat(64),
      content: 'the real ordinary original',
      senderPubkey: 'late-original-author',
    }));

    const { messages } = await loadMessages('group-ordinary-preserve');
    expect(messages).toHaveLength(1);
    // The placeholder/edit stands — the late ordinary arrival is a no-op.
    expect(messages[0].content).toBe('edited placeholder content');
    expect(messages[0].edited).toBe(true);
    expect(messages[0].materializedFromEdit).toBe(true);
  });

  it('ordinary edit materializes a placeholder, it is then tombstoned, and a real ordinary original arriving later does NOT resurrect it', async () => {
    await appendMessage('group-ordinary-preserve-ts', makeMsg({
      id: 'e'.repeat(64),
      content: 'edited placeholder content',
      rev: 7,
      edited: true,
      materializedFromEdit: true,
    }));
    await tombstoneMessage('group-ordinary-preserve-ts', 'e'.repeat(64), 8);

    await appendMessage('group-ordinary-preserve-ts', makeMsg({
      id: 'e'.repeat(64),
      content: 'the real ordinary original',
      senderPubkey: 'late-original-author',
    }));

    const { messages } = await loadMessages('group-ordinary-preserve-ts');
    expect(messages).toHaveLength(1);
    expect(messages[0].tombstoned).toBe(true);
    expect(messages[0].content).not.toBe('the real ordinary original');
  });
});

// ── Gate-remediation round: hardened clobber-guard, monotonic-rev floor, merge
//    semantics, tombstoneMessage rev validation, and queue serialization ────────

describe('AC-STORE-3 clobber-guard — hardened against the whole non-real-signal input class', () => {
  it.each([
    { label: 'rev: NaN', rev: NaN },
    { label: 'rev: negative', rev: -5 },
    { label: 'rev: non-number (string, via runtime cast)', rev: '17' as unknown as number },
  ])('$label: rejected against a tombstoned row, exactly like rev=0/absent', async ({ rev }) => {
    await appendMessage('group-guard-malformed-tomb', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-guard-malformed-tomb', 'a'.repeat(64), 10);

    await updateMessageInPlace('group-guard-malformed-tomb', 'a'.repeat(64), { content: 'resurrected', rev });

    const { messages } = await loadMessages('group-guard-malformed-tomb');
    expect(messages[0].tombstoned).toBe(true);
    expect(messages[0].content).toBe('orig');
    // The malformed rev itself must never be persisted onto the row.
    expect(messages[0].rev).toBe(10);
  });

  it.each([
    { label: 'rev: NaN', rev: NaN },
    { label: 'rev: negative', rev: -5 },
  ])('$label: rejected against an edited row', async ({ rev }) => {
    await appendMessage('group-guard-malformed-edit', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await updateMessageInPlace('group-guard-malformed-edit', 'a'.repeat(64), { content: 'edited-content', edited: true, rev: 15 });

    await updateMessageInPlace('group-guard-malformed-edit', 'a'.repeat(64), { content: 'reverted', rev });

    const { messages } = await loadMessages('group-guard-malformed-edit');
    expect(messages[0].content).toBe('edited-content');
    expect(messages[0].rev).toBe(15);
  });

  it('a malformed rev (NaN) on a fresh row is stripped, not persisted — the rest of the patch still applies', async () => {
    await appendMessage('group-guard-malformed-fresh', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    await updateMessageInPlace('group-guard-malformed-fresh', 'a'.repeat(64), { content: 'touched', rev: NaN });

    const { messages } = await loadMessages('group-guard-malformed-fresh');
    expect(messages[0].content).toBe('touched');
    expect(messages[0].rev).toBeUndefined();
  });
});

describe('Monotonic-rev floor — storage rejects a strictly-older rev, but equal revs always pass (S3 owns tie resolution)', () => {
  it('rejects a write whose rev is strictly less than the stored rev, even though the row is not tombstoned/edited by that write', async () => {
    await appendMessage('group-floor-reject', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-floor-reject', 'a'.repeat(64), 20);

    // A stale, lower-rev "edit" arriving late (e.g. reordered delivery) must not
    // move the slot's rev clock backwards, closing the TOCTOU a read-modify-write
    // caller would otherwise have to defend against across two queue turns.
    await updateMessageInPlace('group-floor-reject', 'a'.repeat(64), { content: 'stale-edit', edited: true, rev: 15 });

    const { messages } = await loadMessages('group-floor-reject');
    expect(messages[0].tombstoned).toBe(true);
    expect(messages[0].content).toBe('orig');
    expect(messages[0].rev).toBe(20);
  });

  it('passes a write whose rev exactly equals the stored rev — storage does not resolve the tie, S3 does', async () => {
    await appendMessage('group-floor-equal', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-floor-equal', 'a'.repeat(64), 20);

    // S3 constructed this patch as its equal-rev tie resolution (e.g. delete-wins);
    // storage's floor must let it through rather than blocking on rev equality.
    await updateMessageInPlace('group-floor-equal', 'a'.repeat(64), { content: 'tie-winner', edited: true, rev: 20 });

    const { messages } = await loadMessages('group-floor-equal');
    expect(messages[0].content).toBe('tie-winner');
    expect(messages[0].rev).toBe(20);
  });

  it('passes a write whose rev is strictly greater than the stored rev', async () => {
    await appendMessage('group-floor-greater', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await updateMessageInPlace('group-floor-greater', 'a'.repeat(64), { content: 'v1', edited: true, rev: 10 });

    await updateMessageInPlace('group-floor-greater', 'a'.repeat(64), { content: 'v2', edited: true, rev: 11 });

    const { messages } = await loadMessages('group-floor-greater');
    expect(messages[0].content).toBe('v2');
    expect(messages[0].rev).toBe(11);
  });
});

describe('Merge semantics — undefined-valued patch keys never null out a field', () => {
  it('a patch with content: undefined does not clear the row\'s existing content', async () => {
    await appendMessage('group-merge-undefined', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    await updateMessageInPlace('group-merge-undefined', 'a'.repeat(64), {
      content: undefined,
      edited: true,
      rev: 5,
    });

    const { messages } = await loadMessages('group-merge-undefined');
    expect(messages[0].content).toBe('orig');
    expect(messages[0].edited).toBe(true);
    expect(messages[0].rev).toBe(5);
  });

  it('un-tombstoning a slot requires the patch to carry tombstoned:false explicitly', async () => {
    await appendMessage('group-untomb', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));
    await tombstoneMessage('group-untomb', 'a'.repeat(64), 10);

    // An edit that doesn't mention `tombstoned` at all must NOT implicitly un-tombstone.
    await updateMessageInPlace('group-untomb', 'a'.repeat(64), { content: 'edited', edited: true, rev: 20 });
    let { messages } = await loadMessages('group-untomb');
    expect(messages[0].tombstoned).toBe(true);

    // Only an explicit tombstoned:false clears the flag.
    await updateMessageInPlace('group-untomb', 'a'.repeat(64), { tombstoned: false, rev: 21 });
    ({ messages } = await loadMessages('group-untomb'));
    expect(messages[0].tombstoned).toBe(false);
  });
});

describe('tombstoneMessage — rejects a non-real-signal rev instead of persisting a trivially-overridable tombstone', () => {
  it.each([
    { label: 'rev: 0', rev: 0 },
    { label: 'rev: negative', rev: -1 },
    { label: 'rev: NaN', rev: NaN },
  ])('$label: no-ops — row is not tombstoned at all', async ({ rev }) => {
    await appendMessage('group-tomb-invalid', makeMsg({ id: 'a'.repeat(64), content: 'orig' }));

    await tombstoneMessage('group-tomb-invalid', 'a'.repeat(64), rev);

    const { messages } = await loadMessages('group-tomb-invalid');
    expect(messages[0].tombstoned).toBeUndefined();
    expect(messages[0].content).toBe('orig');
  });
});

describe('Queue serialization — concurrent writes to the same thread key never race (AC-STORE-3 headline guarantee)', () => {
  it('append/update/append/tombstone fired without awaiting between them settle into the exact expected final state', async () => {
    const groupId = 'group-concurrent';
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);

    // Fire all writes back-to-back, without awaiting in between, to exercise the
    // shared appendQueues serialization rather than an artificially-serial test.
    const p1 = appendMessage(groupId, makeMsg({ id: idA, content: 'A' }));
    const p2 = updateMessageInPlace(groupId, idA, { content: 'A-edited', edited: true, rev: 1 });
    const p3 = appendMessage(groupId, makeMsg({ id: idB, content: 'B' }));
    const p4 = tombstoneMessage(groupId, idA, 2);

    await Promise.all([p1, p2, p3, p4]);

    const { messages } = await loadMessages(groupId);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual([idA, idB]);
    expect(messages[0]).toMatchObject({ content: 'A-edited', edited: true, tombstoned: true, rev: 2 });
    expect(messages[1]).toMatchObject({ content: 'B' });
  });
});

// ── filterVisibleMessages: pure helper ────────────────────────────────────────

describe('filterVisibleMessages — pure tombstone filter (mirrors reactions !removed pattern)', () => {
  it('returns an empty array for an empty input', () => {
    expect(filterVisibleMessages([])).toEqual([]);
  });

  it('keeps rows with tombstoned undefined or false; drops tombstoned:true', () => {
    const rows = [
      makeMsg({ id: 'a'.repeat(64) }), // tombstoned undefined
      makeMsg({ id: 'b'.repeat(64), tombstoned: false }),
      makeMsg({ id: 'c'.repeat(64), tombstoned: true }),
    ];
    const visible = filterVisibleMessages(rows);
    expect(visible.map((m) => m.id)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('does not mutate the input array', () => {
    const rows = [makeMsg({ id: 'a'.repeat(64), tombstoned: true })];
    const copy = [...rows];
    filterVisibleMessages(rows);
    expect(rows).toEqual(copy);
  });
});
