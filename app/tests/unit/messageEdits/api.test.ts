/**
 * Reconciliation core — Seam S3 producer (applyDeleteEditSignal,
 * resolvePendingSignalsForSlot).
 *
 * Mocking convention: idb-keyval backed by a Map (matches
 * chatPersistence-editDelete.test.ts and reactions/api-property.test.ts). No
 * fast-check, no jsdom — table-driven `it.each` / hand-rolled parametric
 * loops per project + architecture.md convention.
 *
 * Fake timers are enabled globally so `Date.now()`-derived `receivedAt` /
 * TTL-expiry values are deterministic across the whole file.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
const { callableMapStore } = await import('../helpers/callableMapStore');

// createStore/promisifyRequest: the pinned-rev store's readwrite transaction
// (messageEdits/api.ts modifyPinsAtomically) runs over the SAME Map.
vi.mock('idb-keyval', async () => ({
  createStore: vi.fn(() => (callableMapStore as typeof import('../helpers/callableMapStore').callableMapStore)(idbStore)),
  promisifyRequest: (await vi.importActual<typeof import('idb-keyval')>('idb-keyval')).promisifyRequest,
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

const { appendMessage, loadMessages, filterVisibleMessages, clearMessages, purgeStrangerDmThreads } = await import(
  '@/src/lib/marmot/chatPersistence'
);
const {
  applyDeleteEditSignal,
  resolvePendingSignalsForSlot,
  clearAllMessageEditsState,
  registerGroupAdminsProvider,
  PENDING_SIGNAL_CAP,
  PENDING_SIGNAL_TTL_MS,
  MAX_REV_SKEW_SECONDS,
} = await import('@/src/lib/messageEdits/api');
const { getPublicKey, generateSecretKey } = await import('nostr-tools/pure');
const { buildDeleteRumor, buildEditReplacementRumor, buildEditMarkedCompanionKind5, hasEditMarkerTag } = await import(
  '@/src/lib/messageEdits/rumor'
);
const { isInformativeAnnouncementContent } = await import('@/src/lib/marmot/announcementFamily');
const { isInformativeAnnouncement } = await import('@/src/lib/messageEdits/messageActionUi');

// ── Fixtures / helpers ─────────────────────────────────────────────────────

const BASE_TIME_MS = 1_700_000_000_000; // fixed fake "now"
const BASE_TIME_SECONDS = Math.floor(BASE_TIME_MS / 1000);

const DM_THREAD = { kind: 'dm' as const, peerPubkeyHex: 'PeerPubkeyABC' };
const DM_THREAD_GROUP_ID = 'dm:peerpubkeyabc'; // lower-cased dm: prefix

const GROUP_THREAD = { kind: 'group' as const, groupId: 'group-1' };

const AUTHOR = 'author-pubkey-aaa';
const OTHER_AUTHOR = 'other-pubkey-bbb';

// ── S8 (epic-group-invite-lifecycle): announcement gate + admin carve-out ──

const ADMIN_PUBKEY = 'admin-pubkey-zzz';
const NON_ADMIN_PUBKEY = 'non-admin-pubkey-yyy';

/** A GROUP_THREAD.groupId-scoped admin-set: only ADMIN_PUBKEY is admin. */
function registerAdmins(admins: string[] = [ADMIN_PUBKEY]): void {
  registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_THREAD.groupId ? admins : []));
}

/** A non-`image` StructuredContent payload (member_admitted-shaped) — an "informative announcement". */
function makeAnnouncementContent(pubkeyHex = 'b'.repeat(64)): string {
  return JSON.stringify({ type: 'member_admitted', pubkey: pubkeyHex });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeOriginal(groupId: string, overrides: Partial<Parameters<typeof appendMessage>[1]> = {}) {
  return {
    id: 'orig-' + Math.random().toString(36).slice(2),
    content: 'hello world',
    senderPubkey: AUTHOR,
    groupId,
    createdAt: BASE_TIME_MS - 60_000,
    ...overrides,
  };
}

function makeDeleteRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}> = {}) {
  return {
    id: 'delete-rumor-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS,
    kind: 5,
    tags: [['e', 'orig-placeholder'], ['k', '14']],
    content: '',
    ...overrides,
  };
}

function makeEditRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}> = {}) {
  return {
    id: 'edit-rumor-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS - 60,
    kind: 14,
    tags: [['e', 'orig-placeholder', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]],
    content: 'edited text',
    ...overrides,
  };
}

function makeEditMarkedKind5(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
}> = {}) {
  return {
    id: 'companion-rumor-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS,
    kind: 5,
    tags: [['e', 'orig-placeholder'], ['k', '14'], ['e', 'orig-placeholder', '', 'edit']],
    content: '',
    ...overrides,
  };
}

/** A guaranteed-discard rumor, used purely to trigger the lazy TTL sweep for a thread. */
function sweepTrigger() {
  return makeEditMarkedKind5({ id: 'sweep-trigger-' + Math.random().toString(36).slice(2) });
}

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
  // Only Date is faked: the pinned-rev transaction (callableMapStore) runs on
  // real macrotasks. advanceTimersByTime still moves the fake clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME_MS);
  registerGroupAdminsProvider(null); // fail-closed default unless a test opts in via registerAdmins()
});

afterEach(() => {
  vi.useRealTimers();
  registerGroupAdminsProvider(null);
});

// ── Classification: marker-first (AC-DEL-7) ───────────────────────────────

describe('classification — marker-first (AC-DEL-7)', () => {
  it('a lone unmarked kind-5 is classified and applied as a delete', async () => {
    const original = makeOriginal(DM_THREAD_GROUP_ID, { id: 'slot-1' });
    await appendMessage(DM_THREAD_GROUP_ID, original);

    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ tags: [['e', 'slot-1'], ['k', '14']] }),
    );

    expect(result).toEqual({ thread: DM_THREAD, slotId: 'slot-1', kind: 'delete' });
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'slot-1')?.tombstoned).toBe(true);
  });

  it('an edit-marked kind-5 is discarded — never a delete, never an edit, storage byte-identical before/after', async () => {
    const original = makeOriginal(DM_THREAD_GROUP_ID, { id: 'slot-2' });
    await appendMessage(DM_THREAD_GROUP_ID, original);

    const before = await loadMessages(DM_THREAD_GROUP_ID);

    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeEditMarkedKind5({ tags: [['e', 'slot-2'], ['k', '14'], ['e', 'slot-2', '', 'edit']] }),
    );

    expect(result).toEqual({ thread: DM_THREAD, slotId: null, kind: 'discarded' });
    const after = await loadMessages(DM_THREAD_GROUP_ID);
    expect(after.messages).toEqual(before.messages);
  });

  it('two rumors differing ONLY in the presence of the edit-marker tag classify differently', async () => {
    const original = makeOriginal(DM_THREAD_GROUP_ID, { id: 'slot-3' });
    await appendMessage(DM_THREAD_GROUP_ID, original);

    // Unmarked: same e-tag, same rev, no marker => delete.
    const deleteResult = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'unmarked-1', tags: [['e', 'slot-3'], ['k', '14']] }),
    );
    expect(deleteResult.kind).toBe('delete');

    const original2 = makeOriginal(DM_THREAD_GROUP_ID, { id: 'slot-3b' });
    await appendMessage(DM_THREAD_GROUP_ID, original2);

    // Marked: identical shape plus the marker tag => discarded.
    const discardResult = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({
        id: 'marked-1',
        tags: [['e', 'slot-3b'], ['k', '14'], ['e', 'slot-3b', '', 'edit']],
      }),
    );
    expect(discardResult.kind).toBe('discarded');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'slot-3b')?.tombstoned).toBeUndefined();
  });

  it('a plain kind-9/14 rumor with no edit marker is not a signal — discarded, untouched', async () => {
    const original = makeOriginal(GROUP_THREAD.groupId, { id: 'slot-plain' });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(GROUP_THREAD, {
      id: 'plain-msg',
      pubkey: AUTHOR,
      created_at: BASE_TIME_SECONDS,
      kind: 9,
      tags: [],
      content: 'just a normal message',
    });

    expect(result.kind).toBe('discarded');
  });

  it('an edit-marked kind-9/14 replacement is classified and applied as an edit', async () => {
    const original = makeOriginal(GROUP_THREAD.groupId, { id: 'slot-4' });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ tags: [['e', 'slot-4', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    expect(result).toEqual({ thread: GROUP_THREAD, slotId: 'slot-4', kind: 'edit' });
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    const row = messages.find((m) => m.id === 'slot-4')!;
    expect(row.content).toBe('edited text');
    expect(row.edited).toBe(true);
  });

  it('integration: S2 real builders — buildEditMarkedCompanionKind5 output is discarded, buildDeleteRumor output deletes', async () => {
    const priv = generateSecretKey();
    const privHex = bytesToHex(priv);
    const pub = getPublicKey(priv);

    const original = makeOriginal(DM_THREAD_GROUP_ID, { id: 'a'.repeat(64), senderPubkey: pub });
    await appendMessage(DM_THREAD_GROUP_ID, original);

    const companion = buildEditMarkedCompanionKind5('a'.repeat(64), [], 14, BASE_TIME_SECONDS, privHex);
    const companionResult = await applyDeleteEditSignal(DM_THREAD, {
      id: companion.id,
      pubkey: companion.pubkey,
      created_at: companion.created_at,
      kind: companion.kind,
      tags: companion.tags,
      content: companion.content,
    });
    expect(companionResult.kind).toBe('discarded');

    const original2 = makeOriginal(DM_THREAD_GROUP_ID, { id: 'b'.repeat(64), senderPubkey: pub });
    await appendMessage(DM_THREAD_GROUP_ID, original2);
    const del = buildDeleteRumor('b'.repeat(64), [], 14, BASE_TIME_SECONDS, privHex);
    const delResult = await applyDeleteEditSignal(DM_THREAD, {
      id: del.id,
      pubkey: del.pubkey,
      created_at: del.created_at,
      kind: del.kind,
      tags: del.tags,
      content: del.content,
    });
    expect(delResult).toEqual({ thread: DM_THREAD, slotId: 'b'.repeat(64), kind: 'delete' });
  });

  // Gate-remediation (sev3): classifySignal's inline marker-presence check now
  // calls the canonical `hasEditMarkerTag` (rumor.ts) instead of re-deriving an
  // equivalent predicate locally. classifySignal itself is not exported, so
  // this table drives the parity check through applyDeleteEditSignal's
  // observable kind-5 outcome (marker present -> discarded per AC-DEL-7;
  // otherwise -> a real delete, since every row below carries a resolvable
  // target id) and asserts it always agrees with hasEditMarkerTag's own
  // verdict on the identical tag shape — covering the exact edges the shared
  // predicate encodes (t[1] non-empty AND t[3]==='edit').
  describe('parity: hasEditMarkerTag vs. classifySignal marker-presence gating (sev3 gate-remediation)', () => {
    const table: Array<{ name: string; tags: string[][]; expectMarked: boolean }> = [
      { name: 'bare e-tag, no marker', tags: [['e', 'slot-x'], ['k', '14']], expectMarked: false },
      {
        name: 'well-formed marker tag',
        tags: [['e', 'slot-x'], ['k', '14'], ['e', 'slot-x', '', 'edit']],
        expectMarked: true,
      },
      {
        name: 'marker-shaped tag but EMPTY target id (t[1]="") does not count',
        tags: [['e', 'slot-x'], ['k', '14'], ['e', '', '', 'edit']],
        expectMarked: false,
      },
      {
        name: 'multiple bare e-tags, still no marker',
        tags: [['e', 'slot-x'], ['e', 'slot-y'], ['k', '14']],
        expectMarked: false,
      },
    ];

    it.each(table)('$name', async ({ tags, expectMarked }) => {
      expect(hasEditMarkerTag(tags)).toBe(expectMarked);

      await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'slot-x' }));

      const result = await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ tags }));

      expect(result.kind).toBe(expectMarked ? 'discarded' : 'delete');
    });
  });
});

// ── AC-DEL-3: known-target delete stops rendering ──────────────────────────

describe('AC-DEL-3 — a processed delete removes the target from every render-facing read path', () => {
  it('the row disappears from filterVisibleMessages but the raw row is retained', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'del-target' }));
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'bystander' }));

    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ tags: [['e', 'del-target'], ['k', '9']] }),
    );

    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages).toHaveLength(2); // retained physically (AC-DEL-5 substrate)
    const visible = filterVisibleMessages(messages);
    expect(visible.map((m) => m.id)).toEqual(['bystander']);
  });
});

// ── AC-EDIT-7: reactions survive edit (slot id stability) ─────────────────

describe('AC-EDIT-7 — the slot id never changes across an edit, so reaction associations stay valid', () => {
  it('row.id is unchanged before/after an edit is applied', async () => {
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'stable-id' }));

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ tags: [['e', 'stable-id', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    // A reaction store keyed on messageId === 'stable-id' still resolves to
    // this exact row after the edit — the id used for reaction lookup never
    // moved to a fresh replacement-rumor id.
    expect(messages.map((m) => m.id)).toEqual(['stable-id']);
    expect(messages[0].content).toBe('edited text');
  });
});

// ── AC-STORE-1: identical shape/behavior from either transport ────────────

describe('AC-STORE-1 — DM and group call sites invoke the identical function with the identical shape', () => {
  it('same rumor content produces structurally identical ChangeResult from a DM vs a group thread', async () => {
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'conv-slot' }));
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'conv-slot' }));

    const dmResult = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'sig-dm', tags: [['e', 'conv-slot'], ['k', '14']] }),
    );
    const groupResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ id: 'sig-group', tags: [['e', 'conv-slot'], ['k', '9']] }),
    );

    expect(Object.keys(dmResult).sort()).toEqual(Object.keys(groupResult).sort());
    expect(dmResult.kind).toBe(groupResult.kind);
    expect(dmResult.slotId).toBe(groupResult.slotId);
    expect(dmResult.thread).toEqual(DM_THREAD);
    expect(groupResult.thread).toEqual(GROUP_THREAD);
  });
});

// ── AC-STORE-2: idempotent reprocessing ────────────────────────────────────

describe('AC-STORE-2 — reprocessing an identical signal is idempotent', () => {
  it('reprocessing the exact same edit rumor twice produces no additional storage mutation', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'idem-slot' }));

    const rumor = makeEditRumor({
      id: 'idem-rumor',
      tags: [['e', 'idem-slot', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]],
    });

    const first = await applyDeleteEditSignal(GROUP_THREAD, rumor);
    expect(first.kind).toBe('edit');

    const idbSet = vi.mocked((await import('idb-keyval')).set);
    idbSet.mockClear();

    const second = await applyDeleteEditSignal(GROUP_THREAD, rumor);
    expect(second).toEqual({ thread: GROUP_THREAD, slotId: 'idem-slot', kind: 'noop' });
    expect(idbSet).not.toHaveBeenCalled();
  });

  it('reprocessing the exact same delete rumor twice produces no additional storage mutation', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'idem-del-slot' }));

    const rumor = makeDeleteRumor({ id: 'idem-del-rumor', tags: [['e', 'idem-del-slot'], ['k', '9']] });

    await applyDeleteEditSignal(GROUP_THREAD, rumor);

    const idbSet = vi.mocked((await import('idb-keyval')).set);
    idbSet.mockClear();

    const second = await applyDeleteEditSignal(GROUP_THREAD, rumor);
    expect(second.kind).toBe('noop');
    expect(idbSet).not.toHaveBeenCalled();
  });
});

// ── AC-ORDER-1: retain-and-apply for unknown targets ───────────────────────

describe('AC-ORDER-1 — a signal for an unknown target is retained (not discarded) and applied once the target arrives', () => {
  it('a delete for an unknown id is pending, then applies once the original arrives via resolvePendingSignalsForSlot', async () => {
    const pendingResult = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ tags: [['e', 'late-slot'], ['k', '14']] }),
    );
    expect(pendingResult).toEqual({ thread: DM_THREAD, slotId: null, kind: 'pending' });

    // Row does not exist yet.
    const before = await loadMessages(DM_THREAD_GROUP_ID);
    expect(before.messages).toHaveLength(0);

    // Original now arrives.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'late-slot' }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'late-slot', AUTHOR);

    expect(resolved).toEqual({ thread: DM_THREAD, slotId: 'late-slot', kind: 'delete' });
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages[0].tombstoned).toBe(true);
  });

  it('an edit for an unknown id is pending, then applies once the original arrives', async () => {
    const pendingResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ tags: [['e', 'late-edit-slot', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'late-edit-slot', content: 'orig' }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'late-edit-slot', AUTHOR);

    expect(resolved.kind).toBe('edit');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages[0].content).toBe('edited text');
  });

  it('AC-AUTH-2 hook: a pending signal from a non-matching author is dropped (fail-closed), not applied', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ pubkey: OTHER_AUTHOR, tags: [['e', 'guarded-slot'], ['k', '14']] }),
    );

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'guarded-slot', senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'guarded-slot', AUTHOR);

    expect(resolved).toEqual({ thread: DM_THREAD, slotId: 'guarded-slot', kind: 'noop' });
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages[0].tombstoned).toBeUndefined();
  });

  it('a KNOWN target with a mismatched author is discarded immediately (no pending buffer involved)', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'known-guard', senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: OTHER_AUTHOR, tags: [['e', 'known-guard'], ['k', '9']] }),
    );

    expect(result).toEqual({ thread: GROUP_THREAD, slotId: 'known-guard', kind: 'discarded' });
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages[0].tombstoned).toBeUndefined();
  });
});

// ── AC-ORDER-2: bounded pending buffer, per-target collapse, evict-oldest ──

describe('AC-ORDER-2 — pending buffer is capped, keyed per target id, collapses to max-rev', () => {
  it('exposes named PENDING_SIGNAL_CAP and PENDING_SIGNAL_TTL_MS constants', () => {
    expect(typeof PENDING_SIGNAL_CAP).toBe('number');
    expect(PENDING_SIGNAL_CAP).toBeGreaterThan(0);
    expect(typeof PENDING_SIGNAL_TTL_MS).toBe('number');
    expect(PENDING_SIGNAL_TTL_MS).toBeGreaterThan(0);
  });

  it('a second, lower-rev signal for the same unresolved target id is collapsed away (max-rev retained)', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'higher', created_at: BASE_TIME_SECONDS + 100, tags: [['e', 'collapse-slot'], ['k', '14']] }),
    );
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'lower', created_at: BASE_TIME_SECONDS + 10, tags: [['e', 'collapse-slot'], ['k', '14']] }),
    );

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'collapse-slot' }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'collapse-slot', AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    // The higher rev (100s offset) is what won, not the later-inserted lower one.
    expect(messages[0].rev).toBe(BASE_TIME_SECONDS + 100);
  });

  it('a HIGHER-rev signal arriving after a lower one for the same target replaces it in the buffer', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'lower-2', created_at: BASE_TIME_SECONDS + 10, tags: [['e', 'collapse-slot-2'], ['k', '14']] }),
    );
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'higher-2', created_at: BASE_TIME_SECONDS + 100, tags: [['e', 'collapse-slot-2'], ['k', '14']] }),
    );

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'collapse-slot-2' }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'collapse-slot-2', AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages[0].rev).toBe(BASE_TIME_SECONDS + 100);
  });

  it('eviction under the cap removes the OLDEST target, not an arbitrary raw signal', async () => {
    // Fill the buffer to exactly PENDING_SIGNAL_CAP distinct targets, each at
    // a distinct receivedAt (advance fake time by 1ms per insert).
    for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
      await applyDeleteEditSignal(
        DM_THREAD,
        makeDeleteRumor({ id: `fill-${i}`, tags: [['e', `evict-slot-${i}`], ['k', '14']] }),
      );
      vi.advanceTimersByTime(1);
    }

    // One more distinct target pushes the buffer over the cap — the OLDEST
    // target (evict-slot-0) must be evicted, not some arbitrary entry.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'fill-overflow', tags: [['e', 'evict-slot-overflow'], ['k', '14']] }),
    );

    // The oldest target (evict-slot-0) should now resolve as a no-op pending
    // resolution — its entry was evicted, so applying its original produces
    // no delete.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'evict-slot-0' }));
    const oldestResolved = await resolvePendingSignalsForSlot(DM_THREAD, 'evict-slot-0', AUTHOR);
    expect(oldestResolved.kind).toBe('noop');

    // The newest target (evict-slot-overflow) must still be present.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'evict-slot-overflow' }));
    const newestResolved = await resolvePendingSignalsForSlot(DM_THREAD, 'evict-slot-overflow', AUTHOR);
    expect(newestResolved.kind).toBe('delete');
  });
});

// ── AC-ORDER-3: order-independent reconciliation + tie-breaks ─────────────

describe('AC-ORDER-3 — reconciliation is order-independent across every arrival order', () => {
  const REV_DELETE = BASE_TIME_SECONDS + 200; // delete has the highest rev in this fixture
  const REV_EDIT = BASE_TIME_SECONDS + 100;

  type Step = 'original' | 'delete' | 'edit';
  const permutations: { order: Step[] }[] = [
    { order: ['original', 'delete', 'edit'] },
    { order: ['original', 'edit', 'delete'] },
    { order: ['delete', 'original', 'edit'] },
    { order: ['delete', 'edit', 'original'] },
    { order: ['edit', 'original', 'delete'] },
    { order: ['edit', 'delete', 'original'] },
  ];

  it.each(permutations)('order $order converges to delete-wins (highest rev) final state', async ({ order }) => {
    idbStore.clear();
    const slotId = 'order-slot';
    const deleteRumor = makeDeleteRumor({ id: 'order-delete', created_at: REV_DELETE, tags: [['e', slotId], ['k', '14']] });
    const editRumor = makeEditRumor({
      id: 'order-edit',
      tags: [['e', slotId, '', 'edit'], ['rev', String(REV_EDIT)]],
    });

    for (const step of order) {
      if (step === 'original') {
        await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
        // Resolve any earlier-buffered pending signals now that the slot is known.
        await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);
      } else if (step === 'delete') {
        await applyDeleteEditSignal(DM_THREAD, deleteRumor);
      } else {
        await applyDeleteEditSignal(DM_THREAD, editRumor);
      }
    }

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId);
    expect(row).toBeDefined();
    // Highest rev is the delete (REV_DELETE > REV_EDIT) — final state is tombstoned.
    expect(row!.tombstoned).toBe(true);
    expect(row!.rev).toBe(REV_DELETE);
  });

  const permutationsEditWins: { order: Step[] }[] = [
    { order: ['original', 'delete', 'edit'] },
    { order: ['original', 'edit', 'delete'] },
    { order: ['delete', 'original', 'edit'] },
    { order: ['delete', 'edit', 'original'] },
    { order: ['edit', 'original', 'delete'] },
    { order: ['edit', 'delete', 'original'] },
  ];

  it.each(permutationsEditWins)('order $order converges to edit-wins when the edit has the higher rev', async ({ order }) => {
    idbStore.clear();
    const slotId = 'order-slot-editwins';
    const REV_LOW_DELETE = BASE_TIME_SECONDS + 50;
    const REV_HIGH_EDIT = BASE_TIME_SECONDS + 999;
    const deleteRumor = makeDeleteRumor({ id: 'ew-delete', created_at: REV_LOW_DELETE, tags: [['e', slotId], ['k', '14']] });
    const editRumor = makeEditRumor({
      id: 'ew-edit',
      tags: [['e', slotId, '', 'edit'], ['rev', String(REV_HIGH_EDIT)]],
    });

    for (const step of order) {
      if (step === 'original') {
        await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
        await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);
      } else if (step === 'delete') {
        await applyDeleteEditSignal(DM_THREAD, deleteRumor);
      } else {
        await applyDeleteEditSignal(DM_THREAD, editRumor);
      }
    }

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId);
    expect(row).toBeDefined();
    expect(row!.tombstoned).toBe(false);
    expect(row!.content).toBe('edited text');
    expect(row!.rev).toBe(REV_HIGH_EDIT);
  });

  it('delete-vs-edit at EQUAL rev: delete wins', async () => {
    const slotId = 'tie-del-edit';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));

    const tieRev = BASE_TIME_SECONDS + 500;
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ id: 'tie-edit', tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]] }),
    );
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'tie-delete', created_at: tieRev, tags: [['e', slotId], ['k', '14']] }),
    );

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);
  });

  it('edit-vs-edit at EQUAL rev: the lexicographically higher replacement rumor id wins (D15)', async () => {
    const slotId = 'tie-edit-edit';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));

    const tieRev = BASE_TIME_SECONDS + 500;
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'aaa-lower-id',
        content: 'from-aaa',
        tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]],
      }),
    );
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'zzz-higher-id',
        content: 'from-zzz',
        tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]],
      }),
    );

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === slotId)!.content).toBe('from-zzz');

    // Reversed arrival order must converge to the SAME winner (order-independence).
    idbStore.clear();
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'zzz-higher-id',
        content: 'from-zzz',
        tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]],
      }),
    );
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'aaa-lower-id',
        content: 'from-aaa',
        tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]],
      }),
    );
    const { messages: reversed } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(reversed.find((m) => m.id === slotId)!.content).toBe('from-zzz');
  });

  it('an out-of-order LOWER-rev signal arriving LAST is correctly ignored (rev comparison is load-bearing, not decorative)', async () => {
    const slotId = 'stale-last';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'fresh-edit',
        content: 'fresh content',
        tags: [['e', slotId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 1000)]],
      }),
    );
    // A stale, much-lower-rev delete arrives AFTER the fresh edit.
    const staleResult = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'stale-delete', created_at: BASE_TIME_SECONDS + 1, tags: [['e', slotId], ['k', '14']] }),
    );

    expect(staleResult.kind).toBe('noop');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBeFalsy();
    expect(row.content).toBe('fresh content');
  });
});

// ── Un-tombstone requires strictly-greater rev (S1 carry-forward obligation) ──

describe('un-tombstone requires a strictly-greater rev; equal rev leaves delete standing', () => {
  it('an edit at the SAME rev as the tombstone does NOT un-tombstone', async () => {
    const slotId = 'untomb-equal';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId, content: 'orig' }));
    const rev = BASE_TIME_SECONDS + 10;
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ created_at: rev, tags: [['e', slotId], ['k', '14']] }));

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ tags: [['e', slotId, '', 'edit'], ['rev', String(rev)]] }),
    );

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);
    expect(row.content).toBe('orig');
  });

  it('an edit at a STRICTLY GREATER rev DOES un-tombstone (explicit tombstoned:false)', async () => {
    const slotId = 'untomb-greater';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId, content: 'orig' }));
    const delRev = BASE_TIME_SECONDS + 10;
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ created_at: delRev, tags: [['e', slotId], ['k', '14']] }));

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ tags: [['e', slotId, '', 'edit'], ['rev', String(delRev + 1)]] }),
    );

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(false);
    expect(row.content).toBe('edited text');
    const visible = filterVisibleMessages(messages);
    expect(visible.map((m) => m.id)).toContain(slotId);
  });
});

// ── AC-ORDER-4: materialize-on-expiry ──────────────────────────────────────

describe('AC-ORDER-4 — materialize-on-expiry', () => {
  it('a pending delete whose target never arrives persists a marker that suppresses the later-arriving original', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ tags: [['e', 'expiring-delete-slot'], ['k', '14']] }),
    );

    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    // Trigger the lazy sweep for this thread.
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    // No ChatMessage row was created for the marker (id-only, no row, no content).
    const beforeOriginal = await loadMessages(DM_THREAD_GROUP_ID);
    expect(beforeOriginal.messages.find((m) => m.id === 'expiring-delete-slot')).toBeUndefined();

    // The original now arrives.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'expiring-delete-slot' }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'expiring-delete-slot', AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'expiring-delete-slot')?.tombstoned).toBe(true);
  });

  it('a pending edit-marked replacement whose original never arrives materializes under its slot id, WITHOUT the edited marker', async () => {
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        content: 'materialized content',
        tags: [['e', 'expiring-edit-slot', '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 5)]],
      }),
    );

    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    const row = messages.find((m) => m.id === 'expiring-edit-slot');
    expect(row).toBeDefined();
    expect(row!.content).toBe('materialized content');
    expect(row!.edited).toBe(false); // no "(edited)" marker — prior version was never seen
    expect(row!.rev).toBe(BASE_TIME_SECONDS + 5);
  });

  it('a later real original for an already-materialized-marker id is suppressed even without a further resolve call racing appendMessage', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ tags: [['e', 'race-slot'], ['k', '14']] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    // Per the documented calling convention, appendMessage is immediately
    // followed by resolvePendingSignalsForSlot.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'race-slot' }));
    await resolvePendingSignalsForSlot(DM_THREAD, 'race-slot', AUTHOR);

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(filterVisibleMessages(messages).find((m) => m.id === 'race-slot')).toBeUndefined();
  });

  it('marker vs. later-expiring higher-rev pending edit for the same id: the higher-rev edit wins and removes the marker', async () => {
    const slotId = 'marker-vs-edit-slot';
    // Lower-rev delete expires first, becomes a marker.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ created_at: BASE_TIME_SECONDS + 1, tags: [['e', slotId], ['k', '14']] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    // A higher-rev pending edit for the SAME id is inserted after the marker exists...
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        content: 'wins over marker',
        tags: [['e', slotId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 999)]],
      }),
    );
    // ...and itself expires.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId);
    expect(row).toBeDefined();
    expect(row!.content).toBe('wins over marker');
    expect(row!.rev).toBe(BASE_TIME_SECONDS + 999);
  });
});

// ── AC-ORDER-5 substrate: slot resolvable via any e-tagged id ─────────────

describe('AC-ORDER-5 substrate — slot resolution checks every e-tagged id, not just the first', () => {
  it('resolves via a non-first e-tag id when that id matches a known row', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'second-tag-id' }));

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({
        tags: [['e', 'unknown-first-id'], ['e', 'second-tag-id'], ['k', '9']],
      }),
    );

    expect(result).toEqual({ thread: GROUP_THREAD, slotId: 'second-tag-id', kind: 'delete' });
  });
});

// ── Rev-cap-at-ingest (S2 review carry-forward obligation) ────────────────

describe('rev-cap-at-ingest — an incoming rev is capped to nowSeconds + MAX_REV_SKEW_SECONDS', () => {
  it('a poisoned huge rev is clamped down, not rejected nor persisted as-is', async () => {
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'skew-slot' }));

    const hugeRev = BASE_TIME_SECONDS + 10_000_000; // far beyond any plausible clock skew
    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ created_at: hugeRev, tags: [['e', 'skew-slot'], ['k', '14']] }),
    );

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === 'skew-slot')!;
    expect(row.rev).toBe(BASE_TIME_SECONDS + MAX_REV_SKEW_SECONDS);
    expect(row.rev).toBeLessThan(hugeRev);
  });

  it('a poisoned huge rev cannot make a later legitimate edit lose an equal-rev tie it should win', async () => {
    // Without the cap, this hostile rev would exceed anything a real device
    // could ever produce, permanently blocking future edits at equal rev.
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'skew-slot-2' }));
    const hugeRev = BASE_TIME_SECONDS + 999_999_999;
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ created_at: hugeRev, tags: [['e', 'skew-slot-2'], ['k', '9']] }),
    );

    const cappedRev = BASE_TIME_SECONDS + MAX_REV_SKEW_SECONDS;
    const editResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        content: 'recovered',
        tags: [['e', 'skew-slot-2', '', 'edit'], ['rev', String(cappedRev)]],
      }),
    );
    // Equal-rev delete-vs-edit tie: delete still wins (correct per AC-ORDER-3),
    // proving the cap did its job (rev is now comparable, not an unreachable
    // giant number) rather than proving anything about who wins this specific
    // tie.
    expect(editResult.kind).toBe('noop');

    // A device with a genuinely later rev (wall clock has since advanced,
    // raising the ingest ceiling too) CAN win — proving the cap tracks
    // "now", it does not permanently pin the slot at its first-seen ceiling.
    vi.advanceTimersByTime(5000);
    const laterCeiling = Math.floor(Date.now() / 1000) + MAX_REV_SKEW_SECONDS;
    const higherResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        id: 'higher-recovery',
        content: 'recovered-higher',
        tags: [['e', 'skew-slot-2', '', 'edit'], ['rev', String(laterCeiling)]],
      }),
    );
    expect(higherResult.kind).toBe('edit');
  });
});

// ── Remediation round 1 — crash-safe choreography + self-healing ──────────

describe('finding 1 — opportunistic self-healing when a pending entry\'s target already has a known row', () => {
  it('a pending DELETE whose target already exists is tombstoned directly on the next sweep, not marker-ized', async () => {
    const slotId = 'opportunistic-delete-slot';
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ tags: [['e', slotId], ['k', '14']] }));
    // The original arrives WITHOUT the S4/S5 resolvePendingSignalsForSlot
    // hook ever firing (simulating a crash between append and resolve).
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));

    // Any subsequent activity on the thread triggers the general sweep —
    // no TTL wait required for this self-heal branch.
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);

    // No orphan marker was ALSO left behind for this id.
    const secondSweep = await applyDeleteEditSignal(DM_THREAD, sweepTrigger());
    expect(secondSweep.kind).toBe('discarded'); // just the trigger itself
  });

  it('a pending EDIT whose target already exists is applied against the row directly, not silently skipped', async () => {
    const slotId = 'opportunistic-edit-slot';
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        content: 'should apply once row exists',
        tags: [['e', slotId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 5)]],
      }),
    );
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: slotId, content: 'orig' }));

    await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.content).toBe('should apply once row exists');
    expect(row.edited).toBe(true); // applied as a real edit against the known row, not a bare materialize
    expect(row.rev).toBe(BASE_TIME_SECONDS + 5);
  });

  it('self-heal respects AC-AUTH-2: a pending entry whose author does not match the now-known row is dropped, not applied', async () => {
    const slotId = 'opportunistic-mismatch-slot';
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ pubkey: OTHER_AUTHOR, tags: [['e', slotId], ['k', '14']] }),
    );
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId, senderPubkey: AUTHOR }));

    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBeUndefined();
  });
});

describe('finding 3 — un-tombstone tie-break derives from storage truth (row.tombstoned), not slot-meta', () => {
  it('an edit at the SAME rev as a delete does not un-tombstone even when read immediately after (storage truth agrees with meta in the non-crash case)', async () => {
    const slotId = 'storage-truth-slot';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId, content: 'orig' }));
    const rev = BASE_TIME_SECONDS + 77;
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ created_at: rev, tags: [['e', slotId], ['k', '14']] }));

    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ tags: [['e', slotId, '', 'edit'], ['rev', String(rev)]] }),
    );
    expect(result.kind).toBe('noop');

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);
    expect(row.content).toBe('orig');
  });
});

describe('finding 4 — pending-buffer dedup by rumorId alone, regardless of capped-rev drift', () => {
  it('re-delivery of the exact same rumor id while pending is a pure no-op even if the classified rev differs across attempts', async () => {
    const targetId = 'dedup-slot';
    const rumorId = 'same-rumor-id-redelivered';
    const farFutureCreatedAt = BASE_TIME_SECONDS + 999_999; // capped at classification time

    const first = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: rumorId, created_at: farFutureCreatedAt, tags: [['e', targetId], ['k', '14']] }),
    );
    expect(first.kind).toBe('pending');

    const idbSet = vi.mocked((await import('idb-keyval')).set);
    const pendingWritesAfterFirst = idbSet.mock.calls.filter(([key]) => key === 'few:messageEditsPendingSignals:v1').length;
    expect(pendingWritesAfterFirst).toBeGreaterThan(0);
    idbSet.mockClear();

    // The wall clock advances before the SAME rumor is reprocessed (e.g. a
    // relay re-delivery) — sanitizeIncomingRev would cap it to a DIFFERENT
    // ceiling this time were rev part of the dedup key.
    vi.advanceTimersByTime(5000);
    const second = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: rumorId, created_at: farFutureCreatedAt, tags: [['e', targetId], ['k', '14']] }),
    );
    expect(second.kind).toBe('pending');

    const pendingWritesAfterSecond = idbSet.mock.calls.filter((c) => c[0] === 'few:messageEditsPendingSignals:v1').length;
    expect(pendingWritesAfterSecond).toBe(0); // pure no-op — no second write, no rev creep

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: targetId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, targetId, AUTHOR);
    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    // The rev is whatever was capped at the FIRST classification, not crept
    // upward by the re-delivery.
    expect(messages.find((m) => m.id === targetId)!.rev).toBe(BASE_TIME_SECONDS + MAX_REV_SKEW_SECONDS);
  });
});

describe('finding 5 — cap-evicted past-TTL entries are materialized before being dropped', () => {
  it('a past-TTL pending delete evicted purely by cap pressure from other threads still leaves a suppressing marker', async () => {
    const targetId = 'cap-pressure-delete-slot';
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ tags: [['e', targetId], ['k', '14']] }));

    // Age this single entry well past TTL.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);

    // Now fill the buffer with PENDING_SIGNAL_CAP fresh (unexpired) entries
    // for OTHER targets, forcing our aged entry to be the eviction victim
    // without ever going through its own thread's lazy TTL sweep pass
    // (each insert below is for a DIFFERENT thread/rumor so it never
    // re-sweeps DM_THREAD's own 'cap-pressure-delete-slot' entry).
    for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
      await applyDeleteEditSignal(
        GROUP_THREAD,
        makeDeleteRumor({ id: `cap-fill-${i}`, tags: [['e', `cap-fill-target-${i}`], ['k', '9']] }),
      );
    }

    // The aged entry has now been evicted by cap pressure. Because it was
    // already past TTL when evicted, it must have left a marker behind.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: targetId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, targetId, AUTHOR);
    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === targetId)?.tombstoned).toBe(true);
  });
});

describe('finding 6 — sibling pending entries sharing a rumorId are cleared once any of them resolves', () => {
  it('resolving the original id of a multi-e-tag delete also clears the sibling replacement-id pending entries', async () => {
    const originalId = 'sibling-original-id';
    const priorReplacementId = 'sibling-prior-replacement-id';
    const rumorId = 'multi-etag-delete';

    // A single delete rumor e-tags BOTH the original and a prior
    // replacement id (D14) — classification buffers one pending entry per
    // e-tagged id, all sharing this rumorId.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: rumorId, tags: [['e', originalId], ['e', priorReplacementId], ['k', '14']] }),
    );

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: originalId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, originalId, AUTHOR);
    expect(resolved.kind).toBe('delete');

    // The sibling entry (keyed by priorReplacementId, which will never
    // correspond to a real row) must be gone too — not lingering to
    // TTL-expire into an orphan marker later.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());
    const { messages: markersCheck } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(markersCheck.find((m) => m.id === priorReplacementId)).toBeUndefined();
    // If a marker had been created for priorReplacementId, a later-arriving
    // "original" under that id would be suppressed. Prove it is NOT
    // suppressed — i.e. no marker exists.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: priorReplacementId }));
    const siblingResolved = await resolvePendingSignalsForSlot(DM_THREAD, priorReplacementId, AUTHOR);
    expect(siblingResolved.kind).toBe('noop');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === priorReplacementId)?.tombstoned).toBeUndefined();
  });
});

describe('finding 7(c) — marker.rev EXACTLY EQUAL to an expiring edit rev: the >= boundary', () => {
  it('a marker at the SAME rev as an expiring edit stands; the edit is discarded, never materialized', async () => {
    const slotId = 'equal-rev-marker-boundary';
    const tieRev = BASE_TIME_SECONDS + 1;

    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ created_at: tieRev, tags: [['e', slotId], ['k', '14']] }));
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger()); // marker now persisted at tieRev

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ content: 'should be discarded', tags: [['e', slotId, '', 'edit'], ['rev', String(tieRev)]] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === slotId)).toBeUndefined(); // never materialized — marker still stands

    // The original later arrives — still suppressed by the surviving marker.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);
    expect(resolved.kind).toBe('delete');
  });
});

describe('finding 7(d) — delete-vs-delete at EQUAL rev', () => {
  it('a second delete at the same rev as the first is accepted (freshest correct "tombstoned" outcome, not a no-op)', async () => {
    const slotId = 'tie-delete-delete';
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    const tieRev = BASE_TIME_SECONDS + 42;

    const first = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'del-a', created_at: tieRev, tags: [['e', slotId], ['k', '14']] }),
    );
    expect(first.kind).toBe('delete');

    const second = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'del-b', created_at: tieRev, tags: [['e', slotId], ['k', '14']] }),
    );
    expect(second.kind).toBe('delete');

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);
    expect(row.rev).toBe(tieRev);
  });
});

describe('finding 7(a/b) — table-driven convergence over the 4-signal set {original, delete, editA, editB}', () => {
  const REV_EDIT_A = BASE_TIME_SECONDS + 100;
  const REV_DELETE = BASE_TIME_SECONDS + 150;
  const REV_EDIT_B = BASE_TIME_SECONDS + 200; // highest — canonical winner

  type Step = 'original' | 'delete' | 'editA' | 'editB';

  function permutationsOf<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    items.forEach((item, i) => {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const perm of permutationsOf(rest)) out.push([item, ...perm]);
    });
    return out;
  }

  const allOrders = permutationsOf<Step>(['original', 'delete', 'editA', 'editB']);

  it.each(allOrders.map((order) => ({ order })))(
    'order $order converges to editB (highest rev) as the canonical final state',
    async ({ order }) => {
      idbStore.clear();
      const slotId = 'four-signal-slot';
      const deleteRumor = makeDeleteRumor({ id: '4sig-delete', created_at: REV_DELETE, tags: [['e', slotId], ['k', '14']] });
      const editARumor = makeEditRumor({
        id: '4sig-edit-a',
        content: 'content-A',
        tags: [['e', slotId, '', 'edit'], ['rev', String(REV_EDIT_A)]],
      });
      const editBRumor = makeEditRumor({
        id: '4sig-edit-b',
        content: 'content-B',
        tags: [['e', slotId, '', 'edit'], ['rev', String(REV_EDIT_B)]],
      });

      for (const step of order) {
        if (step === 'original') {
          await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
          await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);
        } else if (step === 'delete') {
          await applyDeleteEditSignal(DM_THREAD, deleteRumor);
        } else if (step === 'editA') {
          await applyDeleteEditSignal(DM_THREAD, editARumor);
        } else {
          await applyDeleteEditSignal(DM_THREAD, editBRumor);
        }
      }

      const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
      const row = messages.find((m) => m.id === slotId);
      expect(row).toBeDefined();
      expect(row!.tombstoned).toBe(false);
      expect(row!.content).toBe('content-B');
      expect(row!.rev).toBe(REV_EDIT_B);
    },
  );

  it('a subset of signals routed through the pending buffer before the original arrives, plus a duplicate re-delivery, still converges to the canonical state', async () => {
    idbStore.clear();
    const slotId = 'four-signal-pending-subset-slot';
    const deleteRumor = makeDeleteRumor({ id: '4sig-delete-p', created_at: REV_DELETE, tags: [['e', slotId], ['k', '14']] });
    const editARumor = makeEditRumor({
      id: '4sig-edit-a-p',
      content: 'content-A',
      tags: [['e', slotId, '', 'edit'], ['rev', String(REV_EDIT_A)]],
    });
    const editBRumor = makeEditRumor({
      id: '4sig-edit-b-p',
      content: 'content-B',
      tags: [['e', slotId, '', 'edit'], ['rev', String(REV_EDIT_B)]],
    });

    // delete and editA arrive and buffer (target unknown); editA is a
    // no-op collapse since delete's rev (150) beats editA's rev (100).
    await applyDeleteEditSignal(DM_THREAD, deleteRumor);
    await applyDeleteEditSignal(DM_THREAD, editARumor);

    // A duplicate re-delivery of the buffered delete rumor — must not
    // disturb the buffer or the eventual outcome.
    const dup = await applyDeleteEditSignal(DM_THREAD, deleteRumor);
    expect(dup.kind).toBe('pending');

    // The original now arrives, resolving the buffered delete.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);

    // editB arrives directly (target now known) with the highest rev.
    await applyDeleteEditSignal(DM_THREAD, editBRumor);

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId);
    expect(row).toBeDefined();
    expect(row!.tombstoned).toBe(false);
    expect(row!.content).toBe('content-B');
    expect(row!.rev).toBe(REV_EDIT_B);
  });
});

describe('finding 8 — groupIdFor stays byte-identical to directConversationId (VQ-S3 sev2 hardening)', () => {
  it('groupIdFor for a dm thread agrees with directConversationId for the same pubkey across several inputs', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { groupIdFor } = await import('@/src/lib/messageEdits/api');

    const pubkeys = ['AbCdEf0123456789', 'peer-pubkey-abc', 'a'.repeat(64), 'F'.repeat(64), 'MiXeDcAsE123'];
    for (const pk of pubkeys) {
      expect(groupIdFor({ kind: 'dm', peerPubkeyHex: pk })).toBe(directConversationId(pk));
    }
  });
});

// ── Remediation round 2 — marker-aware unification + crash/teardown hygiene ──

describe('round-2 finding 1 — marker-aware self-heal (both manifestations)', () => {
  it('marker-only: a delete that TTL-expired to a marker self-heals onto its original once ambient thread activity sweeps it, with no explicit resolve call for that slot', async () => {
    const slotId = 'marker-only-self-heal-slot';

    // Delete for an unknown target buffers, then TTL-expires into a
    // content-free marker (no pending entry survives — it was converted).
    await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ tags: [['e', slotId], ['k', '14']] }));
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    // The original now arrives WITHOUT the standard resolvePendingSignalsForSlot
    // hook ever firing for it (simulating a crash between append and
    // resolve, or a restart where the hook was skipped) — only ambient
    // thread activity (another inbound signal) triggers the general sweep.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    expect(row.tombstoned).toBe(true);
  });

  it('marker-vs-pending: a higher-rev marker beats a lower-rev pending edit for the SAME id regardless of which apply path resolves it (self-heal sweep vs. explicit resolve)', async () => {
    const slotId = 'marker-vs-pending-slot';
    const markerRev = BASE_TIME_SECONDS + 100;
    const editRev = BASE_TIME_SECONDS + 50; // lower than the marker

    // Delete for an unknown target TTL-expires into a marker at markerRev.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ created_at: markerRev, tags: [['e', slotId], ['k', '14']] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    // A SEPARATE, lower-rev edit signal for the SAME id now buffers as
    // pending (the marker and this pending entry now coexist for one id).
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        content: 'must not win over the higher-rev marker',
        tags: [['e', slotId, '', 'edit'], ['rev', String(editRev)]],
      }),
    );

    // The original arrives; ambient thread activity (no explicit resolve
    // call for this slot) triggers the self-heal sweep.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    const row = messages.find((m) => m.id === slotId)!;
    // The higher-rev marker (delete) wins — the ambient self-heal sweep must
    // reach the identical outcome an explicit resolvePendingSignalsForSlot
    // call would (AC-ORDER-3): never diverge by which apply path resolves it.
    expect(row.tombstoned).toBe(true);
    expect(row.rev).toBe(markerRev);
  });

  it('marker-vs-pending via the explicit resolve hook converges to the SAME winner as the ambient sweep above (path-independence)', async () => {
    const slotId = 'marker-vs-pending-slot-explicit';
    const markerRev = BASE_TIME_SECONDS + 100;
    const editRev = BASE_TIME_SECONDS + 50;

    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ created_at: markerRev, tags: [['e', slotId], ['k', '14']] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());

    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        content: 'must not win over the higher-rev marker',
        tags: [['e', slotId, '', 'edit'], ['rev', String(editRev)]],
      }),
    );

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: slotId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, slotId, AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === slotId)!.rev).toBe(markerRev);
  });
});

describe('round-2 finding 2 — a multi-e-tag delete of an EDITED message resolves after TTL, not lost across skipTargetId', () => {
  it('delete e-tags original id O and prior replacement id P sharing one rumorId; after TTL, appending O and resolving O tombstones O', async () => {
    const originalId = 'multi-etag-o';
    const priorReplacementId = 'multi-etag-p';
    const rumorId = 'multi-etag-delete-rumor';

    // A single delete rumor e-tags BOTH ids (D14) — buffers two pending
    // entries sharing rumorId, targets unknown at this point.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: rumorId, tags: [['e', originalId], ['e', priorReplacementId], ['k', '14']] }),
    );

    // Advance past TTL BEFORE the original ever arrives — P's entry (no
    // known row) is now eligible for materialize-on-expiry, while O's is
    // not (it has no row either, yet, but is about to).
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);

    // O's original now arrives, and resolvePendingSignalsForSlot(O) is
    // called exactly per the documented S4/S5 calling convention. Before
    // round-2's fix, the sweep this triggers would reach P's now-expired
    // entry, marker-ize/remove it via removePendingByRumorId(rumorId) —
    // which is NOT scoped to skipTargetId — silently deleting O's own
    // sibling entry before O's own resolution ever consumed it, leaving the
    // delete permanently unapplied to O.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: originalId }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, originalId, AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === originalId)?.tombstoned).toBe(true);
  });
});

describe('round-2 finding 5 — per-thread teardown prunes this module\'s own aux state', () => {
  it('clearMessages (group leave) prevents a previously-buffered pending signal for that group from later resolving', async () => {
    const groupId = 'teardown-group-1';
    await applyDeleteEditSignal(
      { kind: 'group', groupId },
      makeDeleteRumor({ tags: [['e', 'teardown-slot'], ['k', '9']] }),
    );

    await clearMessages(groupId);

    await appendMessage(groupId, makeOriginal(groupId, { id: 'teardown-slot' }));
    const resolved = await resolvePendingSignalsForSlot({ kind: 'group', groupId }, 'teardown-slot', AUTHOR);
    expect(resolved.kind).toBe('noop');
  });

  it('clearMessages (group leave) does not disturb another group\'s buffered pending signal', async () => {
    const clearedGroupId = 'teardown-group-2';
    const otherGroupId = 'teardown-group-untouched';

    await applyDeleteEditSignal(
      { kind: 'group', groupId: clearedGroupId },
      makeDeleteRumor({ id: 'clear-me', tags: [['e', 'cleared-slot'], ['k', '9']] }),
    );
    await applyDeleteEditSignal(
      { kind: 'group', groupId: otherGroupId },
      makeDeleteRumor({ id: 'keep-me', tags: [['e', 'kept-slot'], ['k', '9']] }),
    );

    await clearMessages(clearedGroupId);

    await appendMessage(otherGroupId, makeOriginal(otherGroupId, { id: 'kept-slot' }));
    const resolved = await resolvePendingSignalsForSlot({ kind: 'group', groupId: otherGroupId }, 'kept-slot', AUTHOR);
    expect(resolved.kind).toBe('delete');
  });

  it('purgeStrangerDmThreads prevents a purged stranger DM thread\'s previously-buffered delete from later resolving (privacy)', async () => {
    const strangerPeer = 'stranger-peer-hex';
    const strangerThread = { kind: 'dm' as const, peerPubkeyHex: strangerPeer };

    await applyDeleteEditSignal(
      strangerThread,
      makeDeleteRumor({ tags: [['e', 'stranger-buffered-slot'], ['k', '14']] }),
    );

    // Seed a real message row for the stranger thread so the DM key exists
    // in idb-keyval and purgeStrangerDmThreads finds it.
    await appendMessage(`dm:${strangerPeer.toLowerCase()}`, makeOriginal(`dm:${strangerPeer.toLowerCase()}`, { id: 'unrelated' }));

    // Empty groups/knownPeers => every peer is classified a stranger.
    const getWhitelist = () => ({ groups: [], knownPeers: new Set<string>(), ownPubkeyHex: OTHER_AUTHOR });
    await purgeStrangerDmThreads(getWhitelist);

    await appendMessage(`dm:${strangerPeer.toLowerCase()}`, makeOriginal(`dm:${strangerPeer.toLowerCase()}`, { id: 'stranger-buffered-slot' }));
    const resolved = await resolvePendingSignalsForSlot(strangerThread, 'stranger-buffered-slot', AUTHOR);
    expect(resolved.kind).toBe('noop');
  });
});

describe('round-2 finding 4 — slot-meta is bounded by the same cap as its sibling stores', () => {
  it('writing more than PENDING_SIGNAL_CAP distinct slot-meta entries evicts the oldest, not an arbitrary one', async () => {
    const SLOT_META_KEY = 'few:messageEditsSlotMeta:v1';

    for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
      const slotId = `slot-meta-fill-${i}`;
      await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: slotId }));
      await applyDeleteEditSignal(
        GROUP_THREAD,
        makeEditRumor({ id: `slot-meta-fill-edit-${i}`, tags: [['e', slotId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + i)]] }),
      );
      vi.advanceTimersByTime(1);
    }

    const beforeOverflow = idbStore.get(SLOT_META_KEY) as Array<{ slotId: string }>;
    expect(beforeOverflow.length).toBe(PENDING_SIGNAL_CAP);
    expect(beforeOverflow.some((m) => m.slotId === 'slot-meta-fill-0')).toBe(true);

    // One more distinct slot's edit pushes slot-meta over the cap.
    const overflowSlotId = 'slot-meta-fill-overflow';
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: overflowSlotId }));
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ id: 'slot-meta-fill-edit-overflow', tags: [['e', overflowSlotId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 999)]] }),
    );

    const afterOverflow = idbStore.get(SLOT_META_KEY) as Array<{ slotId: string }>;
    expect(afterOverflow.length).toBe(PENDING_SIGNAL_CAP);
    // The oldest entry (fill-0) was evicted.
    expect(afterOverflow.some((m) => m.slotId === 'slot-meta-fill-0')).toBe(false);
    // The newest entry is present.
    expect(afterOverflow.some((m) => m.slotId === overflowSlotId)).toBe(true);
  });
});

// ── Round-3 gate-remediation ────────────────────────────────────────────────

describe('round-3 finding 1 — the shared resolver persists BEFORE removing (crash safety)', () => {
  it('a failure during the removal step leaves the row already tombstoned; re-invocation is a clean idempotent no-op', async () => {
    const targetId = 'persist-before-remove-slot';
    const rumor = makeDeleteRumor({ id: 'persist-before-remove-rumor', tags: [['e', targetId], ['k', '14']] });

    // Buffer the delete for an unknown target.
    const buffered = await applyDeleteEditSignal(DM_THREAD, rumor);
    expect(buffered.kind).toBe('pending');

    // The original now arrives.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: targetId }));

    const idbSet = vi.mocked((await import('idb-keyval')).set);
    // Simulate a crash exactly at the removal step. The persist commit
    // (tombstoneMessage's messages-key write, then writeSlotMeta's
    // slot-meta-key write) must already have gone through the mock's
    // normal implementation before this throws — it only intercepts the
    // FIRST write to the pending-signal-buffer key, which is
    // removePendingByRumorId's write (the removal step), never a persist
    // write (each persist write targets a different key).
    let armed = true;
    idbSet.mockImplementation(async (key: string, value: unknown) => {
      if (armed && key === 'few:messageEditsPendingSignals:v1') {
        armed = false;
        throw new Error('simulated crash between persist and remove');
      }
      idbStore.set(key, value);
    });

    await expect(resolvePendingSignalsForSlot(DM_THREAD, targetId, AUTHOR)).rejects.toThrow(
      'simulated crash between persist and remove',
    );

    // Persist-before-remove: even though the removal write failed, the
    // winner was already applied — the row is tombstoned. (Under the OLD
    // remove-before-persist order this assertion would fail: the pending
    // entry would already be gone with the row never tombstoned.)
    const { messages: afterCrash } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(afterCrash.find((m) => m.id === targetId)?.tombstoned).toBe(true);

    // Restore normal set() behavior and redo the resolve (simulating a
    // restart/redo). The persisted winner must not be mis-applied a second
    // time, and the stale pending entry (never removed due to the crash)
    // must now be cleaned up cleanly.
    idbSet.mockImplementation(async (key: string, value: unknown) => {
      idbStore.set(key, value);
    });

    const redo = await resolvePendingSignalsForSlot(DM_THREAD, targetId, AUTHOR);
    expect(redo.kind).toBe('noop'); // idempotent — same rumorId already won, via slot-meta

    const { messages: afterRedo } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(afterRedo.find((m) => m.id === targetId)?.tombstoned).toBe(true);

    // The stale pending entry is now actually gone — it does not linger to
    // be reprocessed or resurrect anything on a later sweep.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger());
    const { messages: finalMessages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(finalMessages.find((m) => m.id === targetId)?.tombstoned).toBe(true);
    expect(finalMessages.find((m) => m.id === targetId)?.content).not.toBe('edited text');
  });
});

describe('round-3 finding 2 — cap-eviction known-row branch respects a same/higher-rev marker (read-only check)', () => {
  it('a pending edit whose target row already exists, evicted under cap pressure while a tied-rev marker also exists, is discarded (not applied) — a later resolve correctly tombstones via the marker', async () => {
    const targetId = 'cap-eviction-marker-guard-slot';
    const tieRev = BASE_TIME_SECONDS + 50;

    // 1. A delete for X (still unknown) TTL-expires into a marker at tieRev.
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ id: 'guard-delete-rumor', created_at: tieRev, tags: [['e', targetId], ['k', '14']] }),
    );
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(DM_THREAD, sweepTrigger()); // sweeps DM_THREAD, materializes the marker for X

    // 2. A pending edit for the SAME X arrives at the tied rev, X still
    //    unknown, so it buffers fresh (the marker-materialize step above
    //    already removed the delete's own pending entry).
    await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({
        id: 'guard-edit-rumor',
        tags: [['e', targetId, '', 'edit'], ['rev', String(tieRev)]],
      }),
    );

    // 3. X's row appears WITHOUT the resolve hook firing (appendMessage
    //    directly — same "crash between append and resolve" convention as
    //    the round-2 finding 1 self-heal tests), so this entry is only ever
    //    reachable via cap eviction's OWN knownRow branch, never the
    //    general self-heal sweep.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: targetId }));

    // 4. Age the pending edit entry past TTL, then force cap eviction from
    //    a DIFFERENT thread's pressure (same technique as finding 5's test)
    //    so our entry is evicted via evictOldestPendingIfOverCap's knownRow
    //    branch specifically, never DM_THREAD's own lazy sweep.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
      await applyDeleteEditSignal(
        GROUP_THREAD,
        makeDeleteRumor({ id: `guard-cap-fill-${i}`, tags: [['e', `guard-cap-fill-target-${i}`], ['k', '9']] }),
      );
    }

    // The pending edit was evicted. Had it been applied blindly (the
    // pre-round-3 marker-blind behavior), the row would now show the
    // edit's content. It must NOT have been applied — the guard skipped it,
    // leaving the marker to win on the next sweep instead.
    const { messages: afterEviction } = await loadMessages(DM_THREAD_GROUP_ID);
    const rowAfterEviction = afterEviction.find((m) => m.id === targetId);
    expect(rowAfterEviction?.edited).toBeFalsy();
    expect(rowAfterEviction?.tombstoned).toBeFalsy();
    expect(rowAfterEviction?.content).toBe('hello world'); // makeOriginal's untouched default content

    // The marker was left standing (read-only check, no write) — a later
    // resolve correctly applies IT instead, tombstoning the row.
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, targetId, AUTHOR);
    expect(resolved.kind).toBe('delete');
    const { messages: afterResolve } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(afterResolve.find((m) => m.id === targetId)?.tombstoned).toBe(true);
  });
});

// ── clearAllMessageEditsState ──────────────────────────────────────────────

describe('clearAllMessageEditsState — account-switch hygiene', () => {
  it('clears the pending buffer so a previously-buffered signal no longer resolves', async () => {
    await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ tags: [['e', 'clear-slot'], ['k', '14']] }),
    );

    await clearAllMessageEditsState();

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'clear-slot' }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'clear-slot', AUTHOR);
    expect(resolved.kind).toBe('noop');
  });
});

// ─── S8 (epic-group-invite-lifecycle, DD-11): announcement-immutability gate ──

describe('S8 — CRITICAL: the receive-side gate imports/reuses S7\'s SAME family predicate (no parallel definition)', () => {
  const table: Array<{ name: string; content: string; expectAnnouncement: boolean }> = [
    { name: 'invite_lifecycle', content: JSON.stringify({ type: 'invite_lifecycle', event: 'invited', pubkey: 'a'.repeat(64) }), expectAnnouncement: true },
    { name: 'member_admitted', content: makeAnnouncementContent(), expectAnnouncement: true },
    { name: 'image', content: JSON.stringify({ type: 'image', version: 1, caption: '' }), expectAnnouncement: false },
    { name: 'plain text', content: 'just chatting', expectAnnouncement: false },
    { name: 'not JSON at all', content: 'not { json', expectAnnouncement: false },
  ];

  it.each(table)(
    'isInformativeAnnouncementContent (S8) and isInformativeAnnouncement (S7) agree for $name content',
    ({ content, expectAnnouncement }) => {
      // S7's predicate (messageActionUi.ts) and S8's receive-side gate
      // (messageEdits/api.ts, marmot/chatPersistence.ts) both consume the
      // SAME `isInformativeAnnouncementContent` from
      // `lib/marmot/announcementFamily.ts` — this table proves they can
      // never silently diverge into two parallel family definitions.
      expect(isInformativeAnnouncementContent(content)).toBe(expectAnnouncement);
      expect(isInformativeAnnouncement({
        id: 'x', content, senderPubkey: AUTHOR, groupId: 'g', createdAt: 0,
      })).toBe(expectAnnouncement);
    },
  );
});

describe('S8 — AC-IMMUT-4/5 direct site (applyDeleteEditSignal, known row): admin carve-out for a delete/tombstone against an announcement', () => {
  it('AC-IMMUT-4: a non-admin delete targeting a KNOWN announcement is dropped — stored content/state byte-for-byte unchanged', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const original = makeOriginal(GROUP_THREAD.groupId, {
      id: 'immut-direct-1',
      content: makeAnnouncementContent(),
      senderPubkey: AUTHOR, // present in the group, just not an admin
    });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'immut-direct-1'], ['k', '9']] }),
    );

    expect(result).toEqual({ thread: GROUP_THREAD, slotId: 'immut-direct-1', kind: 'discarded' });
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-direct-1')).toEqual(original);
  });

  it('AC-IMMUT-5: an ADMIN delete targeting the SAME kind of known announcement is honored', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, {
      id: 'immut-direct-2',
      content: makeAnnouncementContent(),
      senderPubkey: AUTHOR,
    }));

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'immut-direct-2'], ['k', '9']] }),
    );

    expect(result).toEqual({ thread: GROUP_THREAD, slotId: 'immut-direct-2', kind: 'delete' });
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-direct-2')?.tombstoned).toBe(true);
  });

  it('regression: an ORDINARY (non-announcement) message delete/edit by its own author still works unaffected by the announcement gate', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'ordinary-1', content: 'just chatting', senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: AUTHOR, tags: [['e', 'ordinary-1'], ['k', '9']] }),
    );

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'ordinary-1')?.tombstoned).toBe(true);
  });

  it('DM-thread carve-out (S7 symmetry): a DM\'s own announcement-shaped message stays own-author-deletable — the admin gate never fires for a dm: threadKey', async () => {
    // No admin provider registered at all for this thread (DMs have no
    // admin concept) — own-authorship alone must still authorize the delete.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, {
      id: 'dm-announcement-1',
      content: makeAnnouncementContent(),
      senderPubkey: AUTHOR,
    }));

    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeDeleteRumor({ pubkey: AUTHOR, tags: [['e', 'dm-announcement-1'], ['k', '14']] }),
    );

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'dm-announcement-1')?.tombstoned).toBe(true);
  });
});

describe('S8 — AC-IMMUT-6/7 direct site (applyDeleteEditSignal, edit): edit is NEVER honored against an announcement, admin or not', () => {
  it('AC-IMMUT-6: an edit targeting a known announcement from a NON-admin is rejected', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const original = makeOriginal(GROUP_THREAD.groupId, { id: 'immut-edit-1', content: makeAnnouncementContent(), senderPubkey: AUTHOR });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'immut-edit-1', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-edit-1')).toEqual(original);
  });

  it('AC-IMMUT-6 (the case most likely to be missed): an edit targeting a known announcement from an ADMIN sender is STILL rejected — no admin carve-out for edit', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const original = makeOriginal(GROUP_THREAD.groupId, { id: 'immut-edit-2', content: makeAnnouncementContent(), senderPubkey: AUTHOR });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'immut-edit-2', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-edit-2')).toEqual(original);
  });

  it('AC-IMMUT-7: an edit whose REPLACEMENT content parses as an announcement is rejected even though the TARGET is an ordinary mutable message', async () => {
    const original = makeOriginal(GROUP_THREAD.groupId, { id: 'immut-edit-3', content: 'plain text', senderPubkey: AUTHOR });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        pubkey: AUTHOR, // even the message's own author cannot fabricate an announcement via edit
        content: makeAnnouncementContent(),
        tags: [['e', 'immut-edit-3', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]],
      }),
    );

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-edit-3')).toEqual(original);
  });

  it('AC-IMMUT-7 vs AC-IMMUT-6 are distinguishable attack shapes: a plain edit (ordinary target, ordinary replacement) still applies', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'immut-edit-4', content: 'plain text', senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: AUTHOR, content: 'plain edited text', tags: [['e', 'immut-edit-4', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    expect(result.kind).toBe('edit');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'immut-edit-4')?.content).toBe('plain edited text');
  });
});

describe('S8 — AC-IMMUT-4/5/6/7 at the BUFFERED apply site (resolvePendingSignalsForSlot / resolveKnownRowAgainstStores): signal arrives BEFORE its target', () => {
  it('AC-IMMUT-4 buffered: a non-admin delete buffered before an announcement target arrives resolves to noop, target stays visible', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const pendingResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'buf-immut-1'], ['k', '9']] }),
    );
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'buf-immut-1', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'buf-immut-1', AUTHOR);

    expect(resolved.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'buf-immut-1')?.tombstoned).toBeFalsy();
  });

  it('AC-IMMUT-5 buffered: an ADMIN delete buffered before an announcement target arrives IS honored once the target materializes', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const pendingResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'buf-immut-2'], ['k', '9']] }),
    );
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'buf-immut-2', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'buf-immut-2', AUTHOR);

    expect(resolved.kind).toBe('delete');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'buf-immut-2')?.tombstoned).toBe(true);
  });

  it('AC-IMMUT-6 buffered: an edit buffered before an announcement target arrives (ADMIN sender) resolves to noop — no admin carve-out for edit at the buffered site either', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const pendingResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: ADMIN_PUBKEY, content: 'buffered edit attempt', tags: [['e', 'buf-immut-3', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'buf-immut-3', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'buf-immut-3', AUTHOR);

    expect(resolved.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'buf-immut-3')?.content).toBe(makeAnnouncementContent());
  });

  it('AC-IMMUT-7 buffered: an edit whose replacement is an announcement is rejected BEFORE it even enters the pending buffer (unknown target)', async () => {
    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: AUTHOR, content: makeAnnouncementContent(), tags: [['e', 'buf-immut-4', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    // Never even buffered as 'pending' — AC-IMMUT-7 fires at classification
    // time, before the target's existence is even known.
    expect(result.kind).toBe('discarded');

    // Confirm no pending entry exists: the later-arriving original is
    // untouched by any buffered signal once it appears.
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'buf-immut-4', content: 'plain text', senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'buf-immut-4', AUTHOR);
    expect(resolved.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'buf-immut-4')?.content).toBe('plain text');
  });
});

describe('S8 — AC-IMMUT-4/5/6/7 at the TTL-expiry / cap-eviction apply site (persistExpiredEntryEffect)', () => {
  it('AC-IMMUT-4/5 TTL-expiry (no known row): a delete materializes as a content-free marker regardless of admin sourcing — the admin/announcement gate is deferred to when the target arrives, per DD-11', async () => {
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'ttl-immut-1'], ['k', '9']] }),
    );

    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

    // No row materialized for the marker itself (id-only).
    const beforeOriginal = await loadMessages(GROUP_THREAD.groupId);
    expect(beforeOriginal.messages.find((m) => m.id === 'ttl-immut-1')).toBeUndefined();

    // DD-11: the gate applies HERE, when the target (an announcement)
    // finally arrives — a non-admin's expired-to-marker delete must still
    // be rejected at that point.
    registerAdmins([ADMIN_PUBKEY]);
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'ttl-immut-1', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'ttl-immut-1', AUTHOR);

    expect(resolved.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'ttl-immut-1')?.tombstoned).toBeFalsy();
  });

  it('AC-IMMUT-7 TTL-expiry materialize-on-expiry (edit, no known row): a replacement that parses as an announcement is never materialized as a fabricated row', async () => {
    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        pubkey: AUTHOR,
        content: makeAnnouncementContent(),
        tags: [['e', 'ttl-immut-2', '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 5)]],
      }),
    );

    // AC-IMMUT-7 already rejected this at classification time (never even
    // buffered) — re-confirm the TTL-sweep path finds nothing to expire.
    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
    await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === 'ttl-immut-2')).toBeUndefined();
  });

  // The fill entries below MUST live on a thread DIFFERENT from the target
  // (mirrors the pre-existing "a past-TTL pending delete evicted purely by
  // cap pressure from other threads" test's pattern, finding 5): every
  // `applyDeleteEditSignal` call sweeps its OWN thread first
  // (`sweepExpiredForThreadKeyLocked`), and that sweep's phase 1 would
  // resolve an already-known, past-TTL target via `resolveKnownRowAgainstStores`
  // BEFORE cap eviction ever got a chance to run — silently testing the
  // WRONG apply site. Filling on a separate thread guarantees the target
  // entry is only ever reached by `evictOldestPendingIfOverCap` ->
  // `persistExpiredEntryEffect(entry, knownRow)`, the actual site this test
  // targets. A mutation check (temporarily forcing this branch's `authorized`
  // to `true`) confirmed this pattern is load-bearing: without aging the
  // target past `PENDING_SIGNAL_TTL_MS` (which `evictOldestPendingIfOverCap`
  // requires before persisting an evicted entry's effect at all — an
  // unexpired eviction victim is dropped bare, no gate ever consulted) the
  // test passed VACUOUSLY, never actually exercising the gate.
  const CAP_FILL_THREAD = { kind: 'group' as const, groupId: 'group-cap-fill-thread' };

  it.each([
    { label: 'AC-IMMUT-4: non-admin sender', sender: NON_ADMIN_PUBKEY, expectTombstoned: false },
    { label: 'AC-IMMUT-5: admin sender', sender: ADMIN_PUBKEY, expectTombstoned: true },
  ])(
    'cap-eviction known-row branch (persistExpiredEntryEffect\'s knownRow path) — $label',
    async ({ sender, expectTombstoned }) => {
      registerAdmins([ADMIN_PUBKEY]);
      const targetId = `cap-known-announcement-${sender}`;

      // Buffer a delete for a target whose ORIGINAL then arrives via a path
      // that bypasses the standard resolve hook (simulating the documented
      // race persistExpiredEntryEffect's knownRow branch exists to self-heal).
      await applyDeleteEditSignal(
        GROUP_THREAD,
        makeDeleteRumor({ id: `cap-oldest-${sender}`, pubkey: sender, tags: [['e', targetId], ['k', '9']] }),
      );
      await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, {
        id: targetId,
        content: makeAnnouncementContent(),
        senderPubkey: AUTHOR,
      }));

      // Age the buffered entry well past TTL — required for
      // evictOldestPendingIfOverCap to persist its effect at all (an
      // unexpired eviction victim is dropped bare with no gate check).
      vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);

      // Fill a DIFFERENT thread's buffer to PENDING_SIGNAL_CAP so global cap
      // pressure evicts our aged, oldest entry — without ever sweeping
      // GROUP_THREAD.groupId itself (which would resolve it the ordinary
      // buffered way instead of via cap eviction).
      for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
        await applyDeleteEditSignal(
          CAP_FILL_THREAD,
          makeDeleteRumor({ id: `cap-fill-${sender}-${i}`, tags: [['e', `cap-fill-slot-${sender}-${i}`], ['k', '9']] }),
        );
      }

      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      const tombstoned = messages.find((m) => m.id === targetId)?.tombstoned;
      if (expectTombstoned) {
        expect(tombstoned).toBe(true);
      } else {
        expect(tombstoned).toBeFalsy();
      }
    },
  );

  it('AC-IMMUT-6 cap-eviction known-row branch: an EDIT resolved via cap eviction against a known announcement row is rejected even from an ADMIN sender — unlike delete, this branch has no downstream defense-in-depth (updateMessageInPlace has no independent gate re-check the way tombstoneMessage does), so this specific line is the ONLY thing protecting it', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const targetId = 'cap-known-announcement-edit';

    await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({
        pubkey: ADMIN_PUBKEY, // admin sender — proves there is still no edit carve-out
        content: 'buffered admin edit attempt',
        tags: [['e', targetId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]],
      }),
    );
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, {
      id: targetId,
      content: makeAnnouncementContent(),
      senderPubkey: AUTHOR,
    }));

    vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);

    for (let i = 0; i < PENDING_SIGNAL_CAP; i++) {
      await applyDeleteEditSignal(
        CAP_FILL_THREAD,
        makeDeleteRumor({ id: `cap-fill-edit-${i}`, tags: [['e', `cap-fill-edit-slot-${i}`], ['k', '9']] }),
      );
    }

    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    const row = messages.find((m) => m.id === targetId);
    expect(row?.content).toBe(makeAnnouncementContent());
    expect(row?.edited).toBeFalsy();
  });
});
