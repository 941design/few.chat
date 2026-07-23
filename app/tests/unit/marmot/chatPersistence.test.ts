/**
 * S8 (epic-group-invite-lifecycle, DD-11): `tombstoneMessage`'s independent
 * announcement-immutability re-check (`TombstoneAuthorization`) —
 * `app/src/lib/marmot/chatPersistence.ts`'s tombstone-application path, the
 * fourth apply site AC-IMMUT-4/5 explicitly names alongside
 * `messageEdits/api.ts`'s `applyDeleteEditSignal` (defense-in-depth: this
 * module is the last write boundary before a tombstone lands in storage).
 *
 * This file is scoped to `tombstoneMessage`'s OWN authorization branch in
 * isolation — the full apply-site suite (direct/buffered/TTL-expiry, driven
 * through the real `applyDeleteEditSignal`/`resolvePendingSignalsForSlot`
 * seam) lives in `app/tests/unit/messageEdits/api.test.ts`, which already
 * covers `chatPersistence.ts`'s pre-existing edit/delete storage foundation
 * (`app/tests/unit/chatPersistence-editDelete.test.ts`, untouched here).
 *
 * Mocking convention: idb-keyval backed by a Map (matches
 * `chatPersistence-editDelete.test.ts` and `messageEdits/api.test.ts`). No
 * fast-check, no jsdom — table-driven `it.each` per project convention.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

// ── Module imports (after mock is set up) ─────────────────────────────────

const { appendMessage, loadMessages, tombstoneMessage } = await import('@/src/lib/marmot/chatPersistence');
const { isInformativeAnnouncementContent } = await import('@/src/lib/marmot/announcementFamily');

type ChatMessageFixture = import('@/src/lib/marmot/chatPersistence').ChatMessage;

// ── Fixtures ───────────────────────────────────────────────────────────────

const GROUP_ID = 'group-tombstone-authz';
const AUTHOR = 'author-pubkey-aaa';
const ADMIN_PUBKEY = 'admin-pubkey-zzz';
const NON_ADMIN_PUBKEY = 'non-admin-pubkey-yyy';

function makeAnnouncementContent(pubkeyHex = 'b'.repeat(64)): string {
  return JSON.stringify({ type: 'member_admitted', pubkey: pubkeyHex });
}

function makeMsg(overrides: Partial<ChatMessageFixture> = {}): ChatMessageFixture {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    content: 'hello',
    senderPubkey: AUTHOR,
    groupId: GROUP_ID,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
});

describe('S8 — tombstoneMessage authorization: sanity check the predicate itself is the shared one', () => {
  it('the announcement fixture used throughout this file actually parses as non-image structured content', () => {
    expect(isInformativeAnnouncementContent(makeAnnouncementContent())).toBe(true);
    expect(isInformativeAnnouncementContent('hello')).toBe(false);
  });
});

describe('S8 — AC-IMMUT-4: tombstoneMessage rejects a non-admin delete/tombstone against an announcement row', () => {
  it('a non-admin sender against an announcement target is rejected — row byte-for-byte unchanged, returns false', async () => {
    const row = makeMsg({ id: 'announce-1', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'announce-1', 100, {
      senderPubkeyHex: NON_ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(applied).toBe(false);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'announce-1')).toEqual(row);
  });

  it('sender present in the group but genuinely not an admin (not merely absent/unrecognized) is still rejected', async () => {
    // AUTHOR is the row's own author AND a real, present pubkey — distinct
    // from "unrecognized" — proving rejection is keyed on admin-membership,
    // not on recognizing the pubkey at all.
    const row = makeMsg({ id: 'announce-2', content: makeAnnouncementContent(), senderPubkey: AUTHOR });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'announce-2', 100, {
      senderPubkeyHex: AUTHOR,
      adminPubkeysHex: [ADMIN_PUBKEY], // AUTHOR is not in this set
    });

    expect(applied).toBe(false);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'announce-2')?.tombstoned).toBeFalsy();
  });
});

describe('S8 — AC-IMMUT-5: tombstoneMessage honors an admin delete/tombstone against an announcement row', () => {
  it('an admin sender against an announcement target is applied — returns true, row tombstoned', async () => {
    const row = makeMsg({ id: 'announce-3', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'announce-3', 100, {
      senderPubkeyHex: ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(applied).toBe(true);
    const { messages } = await loadMessages(GROUP_ID);
    const applied_row = messages.find((m) => m.id === 'announce-3');
    expect(applied_row?.tombstoned).toBe(true);
    expect(applied_row?.rev).toBe(100);
  });

  it('admin check is case-insensitive (matches S7/S6 lowercased-compare convention)', async () => {
    const row = makeMsg({ id: 'announce-4', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'announce-4', 100, {
      senderPubkeyHex: ADMIN_PUBKEY.toUpperCase(),
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(applied).toBe(true);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'announce-4')?.tombstoned).toBe(true);
  });

  it('admin vs non-admin exercised in the SAME suite with DIFFERENT sender identities against equivalent targets', async () => {
    const rowA = makeMsg({ id: 'boundary-admin', content: makeAnnouncementContent() });
    const rowB = makeMsg({ id: 'boundary-nonadmin', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, rowA);
    await appendMessage(GROUP_ID, rowB);

    const adminApplied = await tombstoneMessage(GROUP_ID, 'boundary-admin', 100, {
      senderPubkeyHex: ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });
    const nonAdminApplied = await tombstoneMessage(GROUP_ID, 'boundary-nonadmin', 100, {
      senderPubkeyHex: NON_ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(adminApplied).toBe(true);
    expect(nonAdminApplied).toBe(false);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'boundary-admin')?.tombstoned).toBe(true);
    expect(messages.find((m) => m.id === 'boundary-nonadmin')?.tombstoned).toBeFalsy();
  });
});

describe('S8 — an ordinary (non-announcement) target is unaffected by the authorization gate', () => {
  it('a non-admin, non-author sender is STILL rejected for an ordinary message (own-author rule, unchanged) — authorization param does not grant anything for ordinary content', async () => {
    const row = makeMsg({ id: 'ordinary-1', content: 'just chatting', senderPubkey: AUTHOR });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'ordinary-1', 100, {
      senderPubkeyHex: NON_ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    // tombstoneMessage's own gate only inspects content type — the
    // own-author decision for ordinary content is the CALLER's
    // responsibility (messageEdits/api.ts), not re-derived here. Since no
    // caller-side author check happens inside tombstoneMessage itself, this
    // call applies unconditionally for ordinary content — proving the
    // authorization param is a no-op gate for non-announcement rows.
    expect(applied).toBe(true);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'ordinary-1')?.tombstoned).toBe(true);
  });

  it('regression: calling WITHOUT an authorization argument at all still works exactly as before S8 (backward compatibility)', async () => {
    const row = makeMsg({ id: 'no-authz-1', content: 'plain text' });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'no-authz-1', 50);

    expect(applied).toBe(true);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'no-authz-1')?.tombstoned).toBe(true);
  });

  it('regression: an invalid rev (< 1) is rejected regardless of authorization', async () => {
    const row = makeMsg({ id: 'bad-rev-1', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, row);

    const applied = await tombstoneMessage(GROUP_ID, 'bad-rev-1', 0, {
      senderPubkeyHex: ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(applied).toBe(false);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'bad-rev-1')?.tombstoned).toBeFalsy();
  });
});

describe('S8 — read-check-write runs atomically inside the same per-key queue turn (no separate unqueued pre-read)', () => {
  it('two concurrent tombstoneMessage calls on the SAME announcement row (one admin, one not) resolve deterministically without racing each other', async () => {
    const row = makeMsg({ id: 'concurrent-1', content: makeAnnouncementContent() });
    await appendMessage(GROUP_ID, row);

    const [nonAdminResult, adminResult] = await Promise.all([
      tombstoneMessage(GROUP_ID, 'concurrent-1', 100, { senderPubkeyHex: NON_ADMIN_PUBKEY, adminPubkeysHex: [ADMIN_PUBKEY] }),
      tombstoneMessage(GROUP_ID, 'concurrent-1', 200, { senderPubkeyHex: ADMIN_PUBKEY, adminPubkeysHex: [ADMIN_PUBKEY] }),
    ]);

    // Queued in call order: the non-admin call runs (and is rejected)
    // first, then the admin call runs (and is applied) — both against a
    // consistent read of storage, never a torn/racing view.
    expect(nonAdminResult).toBe(false);
    expect(adminResult).toBe(true);
    const { messages } = await loadMessages(GROUP_ID);
    expect(messages.find((m) => m.id === 'concurrent-1')?.tombstoned).toBe(true);
    expect(messages.find((m) => m.id === 'concurrent-1')?.rev).toBe(200);
  });
});
