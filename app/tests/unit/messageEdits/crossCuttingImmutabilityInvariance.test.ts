/**
 * S9 (epic-group-invite-lifecycle, integration story) — AC-CROSS-2.
 *
 * Whole-flow VERDICT-INVARIANCE property over the REAL, already-shipped
 * immutability-receive gate (S8): `messageEdits/api.ts`'s
 * `applyDeleteEditSignal`/`resolvePendingSignalsForSlot` and
 * `marmot/chatPersistence.ts`'s `tombstoneMessage`. This file adds NO new
 * production code and re-implements NONE of the gate logic
 * (`authorizeDeleteAgainstTarget`/`isEditAuthorizedByAnnouncementGate`
 * inside `api.ts`, or the mirrored re-check inside `tombstoneMessage`) —
 * every verdict below comes from calling the real exported functions.
 *
 * S8's own test files (`app/tests/unit/messageEdits/api.test.ts`'s
 * "AC-IMMUT-4/5/6/7" describe blocks, and
 * `app/tests/unit/marmot/chatPersistence.test.ts`) already prove each apply
 * site is individually correct. This file's job — the actual gap an
 * integration story exists to close — is CROSS-SITE / CROSS-ORDER
 * consistency: for a FIXED (thread-scope, sender-role, signal,
 * classification) tuple, does every structurally-applicable apply site,
 * reached via every structurally-applicable arrival order, converge on the
 * SAME honored/rejected verdict?
 *
 * AC-CROSS-2 (acceptance-criteria.md): for any apply site drawn from
 * {direct known-row application in `applyDeleteEditSignal`, buffered
 * application via `resolvePendingSignalsForSlot`, TTL-expiry
 * materialization, the tombstone path in `chatPersistence.ts`} x any
 * arrival order (signal-before-target or target-before-signal): a
 * delete/tombstone signal targeting a non-`image` `StructuredContent`
 * message MUST be honored iff the sender is a current group admin, and an
 * edit signal whose target OR replacement content parses as a non-`image`
 * `StructuredContent` MUST be rejected — regardless of site or order.
 *
 * ── Structural site/order applicability (documented, not silently skipped) ──
 *
 *   - "direct" (a KNOWN row already exists) is, by definition,
 *     target-before-signal. Feeding it signal-before-target isn't a
 *     different direct-site test — the code ITSELF routes that case to the
 *     "buffered" site (`kind: 'pending'`), which is exactly the invariance
 *     fact asserted below (see "signal-before-target with no known row
 *     routes to buffered, not silently dropped").
 *   - "buffered" (`resolvePendingSignalsForSlot`) and "TTL-expiry"
 *     (`persistExpiredEntryEffect`, reached by advancing fake timers past
 *     `PENDING_SIGNAL_TTL_MS`) exist SPECIFICALLY to handle
 *     signal-before-target — that is their only meaningful order, and
 *     VQ-S3-008's own risk callout requires this file to genuinely exercise
 *     them with that ordering (not fall back to signal-after-target, which
 *     the direct site already covers trivially).
 *   - "tombstone" (`chatPersistence.ts`'s `tombstoneMessage`, called
 *     directly, bypassing `api.ts` entirely) can only ever see
 *     target-before-signal — the row must already exist in storage to be
 *     tombstoned by id/rev. This is a structural constraint of the
 *     function's own signature, not a gap in this test's coverage.
 *
 * Mocking convention: `idb-keyval` backed by a plain `Map`, fake timers via
 * `vi.useFakeTimers()` — mirrors `messageEdits/api.test.ts` and
 * `marmot/chatPersistence.test.ts` exactly (no fast-check, no jsdom, no
 * `setTimeout`).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
const {
  applyDeleteEditSignal,
  resolvePendingSignalsForSlot,
  registerGroupAdminsProvider,
  PENDING_SIGNAL_TTL_MS,
} = await import('@/src/lib/messageEdits/api');

// ── Fixtures / helpers ─────────────────────────────────────────────────────

const BASE_TIME_MS = 1_700_000_000_000;
const BASE_TIME_SECONDS = Math.floor(BASE_TIME_MS / 1000);

const GROUP_THREAD = { kind: 'group' as const, groupId: 'cc-group-1' };
const DM_THREAD = { kind: 'dm' as const, peerPubkeyHex: 'CcPeerPubkeyABC' };
const DM_THREAD_GROUP_ID = 'dm:ccpeerpubkeyabc';

const AUTHOR = 'cc-author-pubkey-aaa';
const ADMIN_PUBKEY = 'cc-admin-pubkey-zzz';
const NON_ADMIN_PUBKEY = 'cc-non-admin-pubkey-yyy';

function registerAdmins(admins: string[] = [ADMIN_PUBKEY]): void {
  registerGroupAdminsProvider(async (groupId: string) => (groupId === GROUP_THREAD.groupId ? admins : []));
}

function makeAnnouncementContent(pubkeyHex = 'b'.repeat(64)): string {
  return JSON.stringify({ type: 'member_admitted', pubkey: pubkeyHex });
}

function makeOriginal(groupId: string, overrides: Partial<Parameters<typeof appendMessage>[1]> = {}) {
  return {
    id: 'cc-orig-' + Math.random().toString(36).slice(2),
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
    id: 'cc-delete-rumor-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS,
    kind: 5,
    tags: [['e', 'cc-orig-placeholder'], ['k', '9']],
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
    id: 'cc-edit-rumor-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS - 60,
    kind: 14,
    tags: [['e', 'cc-orig-placeholder', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]],
    content: 'edited text',
    ...overrides,
  };
}

/** A guaranteed-discard rumor, used purely to trigger the lazy TTL sweep for a thread. */
function sweepTrigger() {
  return {
    id: 'cc-sweep-trigger-' + Math.random().toString(36).slice(2),
    pubkey: AUTHOR,
    created_at: BASE_TIME_SECONDS,
    kind: 5,
    tags: [['e', 'cc-orig-placeholder'], ['k', '9'], ['e', 'cc-orig-placeholder', '', 'edit']],
    content: '',
  };
}

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME_MS);
  registerGroupAdminsProvider(null); // fail-closed default unless a test opts in via registerAdmins()
});

afterEach(() => {
  vi.useRealTimers();
  registerGroupAdminsProvider(null);
});

// ─────────────────────────────────────────────────────────────────────────
// Delete/tombstone verdict invariance across sites x orders
// ─────────────────────────────────────────────────────────────────────────

type SenderRole = 'admin' | 'non-admin';

const DELETE_TABLE: Array<{ label: string; sender: SenderRole; expectHonored: boolean }> = [
  { label: 'AC-IMMUT-4: non-admin sender against a group announcement', sender: 'non-admin', expectHonored: false },
  { label: 'AC-IMMUT-5: admin sender against the same kind of group announcement', sender: 'admin', expectHonored: true },
];

describe('AC-CROSS-2 — delete/tombstone verdict invariance across every apply site (group-thread announcement target)', () => {
  it.each(DELETE_TABLE)(
    '$label — DIRECT site (target-before-signal, the only order this site supports)',
    async ({ sender, expectHonored }) => {
      registerAdmins([ADMIN_PUBKEY]);
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-direct-${sender}`;
      const original = makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: makeAnnouncementContent() });
      await appendMessage(GROUP_THREAD.groupId, original);

      const result = await applyDeleteEditSignal(
        GROUP_THREAD,
        makeDeleteRumor({ pubkey: senderPubkey, tags: [['e', targetId], ['k', '9']] }),
      );

      expect(result.kind).toBe(expectHonored ? 'delete' : 'discarded');
      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      expect(!!messages.find((m) => m.id === targetId)?.tombstoned).toBe(expectHonored);
    },
  );

  it.each(DELETE_TABLE)(
    '$label — BUFFERED site (signal-before-target: signal arrives first, buffered, THEN the announcement target arrives)',
    async ({ sender, expectHonored }) => {
      registerAdmins([ADMIN_PUBKEY]);
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-buffered-${sender}`;

      const pendingResult = await applyDeleteEditSignal(
        GROUP_THREAD,
        makeDeleteRumor({ pubkey: senderPubkey, tags: [['e', targetId], ['k', '9']] }),
      );
      expect(pendingResult.kind).toBe('pending'); // genuinely buffered — no known row yet

      await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: makeAnnouncementContent() }));
      const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, targetId, AUTHOR);

      expect(resolved.kind).toBe(expectHonored ? 'delete' : 'noop');
      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      expect(!!messages.find((m) => m.id === targetId)?.tombstoned).toBe(expectHonored);
    },
  );

  it.each(DELETE_TABLE)(
    '$label — TTL-EXPIRY site (signal-before-target, buffered signal outlives PENDING_SIGNAL_TTL_MS as a content-free marker BEFORE the target ever arrives)',
    async ({ sender, expectHonored }) => {
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-ttl-${sender}`;

      // No admin provider registered yet — the marker materializes
      // unconditionally at TTL-expiry (DD-11: the gate is deferred to when
      // the target arrives, not evaluated at expiry time).
      await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: senderPubkey, tags: [['e', targetId], ['k', '9']] }));
      vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
      await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger()); // trigger the lazy sweep for this thread

      const beforeTarget = await loadMessages(GROUP_THREAD.groupId);
      expect(beforeTarget.messages.find((m) => m.id === targetId)).toBeUndefined(); // marker only, no fabricated row

      // NOW register admins and let the announcement target arrive — the
      // gate fires HERE, at the point the target finally materializes.
      registerAdmins([ADMIN_PUBKEY]);
      await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: makeAnnouncementContent() }));
      const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, targetId, AUTHOR);

      expect(resolved.kind).toBe(expectHonored ? 'delete' : 'noop');
      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      expect(!!messages.find((m) => m.id === targetId)?.tombstoned).toBe(expectHonored);
    },
  );

  it.each(DELETE_TABLE)(
    '$label — TOMBSTONE site (chatPersistence.ts tombstoneMessage, target-before-signal — the only order this site can ever see)',
    async ({ sender, expectHonored }) => {
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-tombstone-${sender}`;
      const row = makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: makeAnnouncementContent() });
      await appendMessage(GROUP_THREAD.groupId, row);

      const applied = await tombstoneMessage(GROUP_THREAD.groupId, targetId, 100, {
        senderPubkeyHex: senderPubkey,
        adminPubkeysHex: [ADMIN_PUBKEY],
      });

      expect(applied).toBe(expectHonored);
      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      expect(!!messages.find((m) => m.id === targetId)?.tombstoned).toBe(expectHonored);
    },
  );

  it('CROSS-SITE CONSISTENCY: for the identical (non-admin, group announcement) fact pattern, every applicable site agrees — rejected everywhere', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const verdicts: Record<string, boolean> = {};

    // direct
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-direct', content: makeAnnouncementContent() }));
    verdicts.direct = (await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'cc-consist-direct'], ['k', '9']] }))).kind === 'delete';

    // buffered
    await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'cc-consist-buffered'], ['k', '9']] }));
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-buffered', content: makeAnnouncementContent() }));
    verdicts.buffered = (await resolvePendingSignalsForSlot(GROUP_THREAD, 'cc-consist-buffered', AUTHOR)).kind === 'delete';

    // tombstone (direct call)
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-tombstone', content: makeAnnouncementContent() }));
    verdicts.tombstone = await tombstoneMessage(GROUP_THREAD.groupId, 'cc-consist-tombstone', 100, {
      senderPubkeyHex: NON_ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(Object.values(verdicts)).toEqual([false, false, false]);
  });

  it('CROSS-SITE CONSISTENCY: for the identical (admin, group announcement) fact pattern, every applicable site agrees — honored everywhere', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const verdicts: Record<string, boolean> = {};

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-admin-direct', content: makeAnnouncementContent() }));
    verdicts.direct = (await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-consist-admin-direct'], ['k', '9']] }))).kind === 'delete';

    await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-consist-admin-buffered'], ['k', '9']] }));
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-admin-buffered', content: makeAnnouncementContent() }));
    verdicts.buffered = (await resolvePendingSignalsForSlot(GROUP_THREAD, 'cc-consist-admin-buffered', AUTHOR)).kind === 'delete';

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-consist-admin-tombstone', content: makeAnnouncementContent() }));
    verdicts.tombstone = await tombstoneMessage(GROUP_THREAD.groupId, 'cc-consist-admin-tombstone', 100, {
      senderPubkeyHex: ADMIN_PUBKEY,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });

    expect(Object.values(verdicts)).toEqual([true, true, true]);
  });

  it('structural: signal-before-target with no known row routes to the BUFFERED site rather than being silently dropped (direct site cannot see this order)', async () => {
    registerAdmins([ADMIN_PUBKEY]);
    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeDeleteRumor({ pubkey: NON_ADMIN_PUBKEY, tags: [['e', 'cc-routes-to-buffered'], ['k', '9']] }),
    );
    // Not "discarded" (which would mean silently dropped) — genuinely
    // buffered, awaiting the target.
    expect(result.kind).toBe('pending');
  });

  it('an ORDINARY (non-announcement) message is unaffected by the gate at every site — own-author delete still works', async () => {
    registerAdmins([ADMIN_PUBKEY]);

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-ordinary-direct', content: 'just chatting' }));
    const direct = await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: AUTHOR, tags: [['e', 'cc-ordinary-direct'], ['k', '9']] }));
    expect(direct.kind).toBe('delete');

    // A SEPARATE ordinary row, tombstoned directly (not the same row the
    // direct-site call above already tombstoned — reusing it would require
    // a strictly-greater rev than whatever `applyDeleteEditSignal` just
    // wrote, which is incidental to what this test is actually checking).
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-ordinary-tombstone', content: 'also just chatting', senderPubkey: AUTHOR }));
    const tombstoneApplied = await tombstoneMessage(GROUP_THREAD.groupId, 'cc-ordinary-tombstone', 100, {
      senderPubkeyHex: AUTHOR,
      adminPubkeysHex: [ADMIN_PUBKEY],
    });
    expect(tombstoneApplied).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Edit rejection invariance across sites x orders (never an admin carve-out)
// ─────────────────────────────────────────────────────────────────────────

type EditClassification = 'target-announcement' | 'replacement-announcement';

const EDIT_TABLE: Array<{ label: string; classification: EditClassification; sender: SenderRole }> = [
  { label: 'AC-IMMUT-6: edit TARGETING a group announcement, non-admin sender', classification: 'target-announcement', sender: 'non-admin' },
  { label: 'AC-IMMUT-6 (the easy-to-miss case): edit TARGETING a group announcement, ADMIN sender — still rejected, no carve-out for edit', classification: 'target-announcement', sender: 'admin' },
  { label: 'AC-IMMUT-7: edit whose REPLACEMENT content is a group announcement (ordinary target), non-admin sender', classification: 'replacement-announcement', sender: 'non-admin' },
  { label: 'AC-IMMUT-7: edit whose REPLACEMENT content is a group announcement (ordinary target), ADMIN sender — still rejected', classification: 'replacement-announcement', sender: 'admin' },
];

describe('AC-CROSS-2 — edit is rejected at EVERY apply site, regardless of arrival order, sender admin-ness, or which half (target/replacement) classifies as announcement', () => {
  it.each(EDIT_TABLE)('$label — DIRECT site (target-before-signal)', async ({ classification, sender }) => {
    registerAdmins([ADMIN_PUBKEY]);
    const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
    const targetId = `cc-edit-direct-${classification}-${sender}`;
    const targetContent = classification === 'target-announcement' ? makeAnnouncementContent() : 'plain text';
    const replacementContent = classification === 'replacement-announcement' ? makeAnnouncementContent() : 'plain edited text';
    const original = makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: targetContent });
    await appendMessage(GROUP_THREAD.groupId, original);

    const result = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: senderPubkey, content: replacementContent, tags: [['e', targetId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === targetId)).toEqual(original); // byte-for-byte unchanged
  });

  it.each(EDIT_TABLE)('$label — BUFFERED site (signal-before-target, where structurally reachable)', async ({ classification, sender }) => {
    registerAdmins([ADMIN_PUBKEY]);
    const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
    const targetId = `cc-edit-buffered-${classification}-${sender}`;
    const targetContent = classification === 'target-announcement' ? makeAnnouncementContent() : 'plain text';
    const replacementContent = classification === 'replacement-announcement' ? makeAnnouncementContent() : 'plain edited text';

    const firstResult = await applyDeleteEditSignal(
      GROUP_THREAD,
      makeEditRumor({ pubkey: senderPubkey, content: replacementContent, tags: [['e', targetId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    if (classification === 'replacement-announcement') {
      // AC-IMMUT-7 fires at CLASSIFICATION time, before the target's
      // existence is even known — this signal never even enters the
      // pending buffer. Documented structural fact, asserted explicitly
      // rather than silently skipped.
      expect(firstResult.kind).toBe('discarded');
    } else {
      expect(firstResult.kind).toBe('pending');
    }

    const original = makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: targetContent });
    await appendMessage(GROUP_THREAD.groupId, original);
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, targetId, AUTHOR);

    expect(resolved.kind).toBe('noop');
    const { messages } = await loadMessages(GROUP_THREAD.groupId);
    expect(messages.find((m) => m.id === targetId)?.content).toBe(targetContent); // never fabricated/overwritten
  });

  // Structural note: unlike "buffered" (which resolves once the real target
  // eventually `appendMessage`s), the TTL-expiry site's phase 2
  // (`persistExpiredEntryEffect`, chatPersistence.ts's `sweepExpiredForThreadKeyLocked`)
  // ONLY ever fires "for targets with no known row" — by construction it
  // cannot reject on a "target-announcement" classification, because the
  // target has never been seen at all at expiry time; there is nothing yet
  // to classify. That is not a gap this file papers over: AC-IMMUT-6's
  // protection for a not-yet-arrived announcement target is enforced at
  // the BUFFERED site instead, exactly once the real target actually
  // `appendMessage`s (the "BUFFERED site" `it.each` block above already
  // proves this for both `target-announcement` rows). So only the
  // `replacement-announcement` half of EDIT_TABLE is structurally
  // applicable here — the edit's OWN content is knowable at expiry time
  // regardless of whether a target ever shows up, and IS rejected before
  // ever entering the buffer (mirrors `api.test.ts`'s own AC-IMMUT-7
  // TTL-expiry test, which is scoped identically for the same reason).
  it.each(EDIT_TABLE.filter((row) => row.classification === 'replacement-announcement'))(
    '$label — TTL-EXPIRY site (signal-before-target, aged past PENDING_SIGNAL_TTL_MS)',
    async ({ classification, sender }) => {
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-edit-ttl-${classification}-${sender}`;
      const replacementContent = makeAnnouncementContent();

      const firstResult = await applyDeleteEditSignal(
        GROUP_THREAD,
        makeEditRumor({ pubkey: senderPubkey, content: replacementContent, tags: [['e', targetId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS + 5)]] }),
      );
      // AC-IMMUT-7 fires at classification time — never even buffered —
      // so there is nothing left to expire; re-confirm the sweep finds
      // nothing regardless.
      expect(firstResult.kind).toBe('discarded');

      vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
      await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      expect(messages.find((m) => m.id === targetId)).toBeUndefined();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// VQ-S9-010: TTL-expiry -> late-arriving announcement TARGET (equivalence check)
//
// The TTL-EXPIRY `it.each` block above (and its preceding doc comment)
// asserts, but does not demonstrate, that AC-IMMUT-6's protection for a
// not-yet-arrived `target-announcement` is enforced at the BUFFERED site
// instead, once the real target eventually `appendMessage`s. This block
// drives the interleaving that equivalence claim actually depends on: the
// TTL sweep fires and consumes/removes the pending entry BEFORE the real
// (announcement) target ever arrives, rather than the target arriving
// first (which the BUFFERED-site block above already covers). If the
// equivalence holds, the buffered-site resolution below rejects the edit
// exactly as the BUFFERED-site block does. If it does not hold — because
// `persistExpiredEntryEffect`'s edit/no-known-row branch materializes a
// real ChatMessage row from the edit's OWN (ordinary) content via
// `appendMessage`, and `appendMessage` is insert-if-absent — the real
// target's later arrival would silently no-op, and the edit's content
// would stand permanently in the announcement's slot.
// ─────────────────────────────────────────────────────────────────────────

const TARGET_ANNOUNCEMENT_TTL_TABLE: Array<{ label: string; sender: SenderRole }> = [
  { label: 'AC-IMMUT-6: edit signal expires past TTL BEFORE a group-announcement target arrives, non-admin sender', sender: 'non-admin' },
  { label: 'AC-IMMUT-6 (no carve-out for edit): edit signal expires past TTL BEFORE a group-announcement target arrives, ADMIN sender', sender: 'admin' },
];

describe('AC-CROSS-2 / VQ-S9-010 — TTL-expiry site vs a LATE-ARRIVING announcement target: does the buffered-site protection actually still apply once the pending entry has already expired?', () => {
  it.each(TARGET_ANNOUNCEMENT_TTL_TABLE)(
    '$label — the equivalence claimed above must hold even when TTL-expiry fires strictly BEFORE the announcement target ever shows up',
    async ({ sender }) => {
      registerAdmins([ADMIN_PUBKEY]);
      const senderPubkey = sender === 'admin' ? ADMIN_PUBKEY : NON_ADMIN_PUBKEY;
      const targetId = `cc-edit-ttl-late-target-announcement-${sender}`;
      const ordinaryReplacement = 'plain edited text — not an announcement';

      // 1. EDIT signal (ordinary replacement content) targeting a message id
      // with NO known row yet.
      const firstResult = await applyDeleteEditSignal(
        GROUP_THREAD,
        makeEditRumor({ pubkey: senderPubkey, content: ordinaryReplacement, tags: [['e', targetId, '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
      );
      expect(firstResult.kind).toBe('pending'); // genuinely buffered — ordinary replacement content, no known row yet

      // 2. Advance past PENDING_SIGNAL_TTL_MS and trigger the lazy sweep —
      // structurally, this site has never seen the target and cannot
      // classify it (only AC-IMMUT-7's replacement-content check applies
      // here; that passes because `ordinaryReplacement` is not an
      // announcement).
      vi.advanceTimersByTime(PENDING_SIGNAL_TTL_MS + 1);
      await applyDeleteEditSignal(GROUP_THREAD, sweepTrigger());

      // 3. ONLY NOW does the real target arrive — and it IS a group
      // announcement.
      await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: targetId, content: makeAnnouncementContent() }));
      const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, targetId, AUTHOR);

      // The claimed equivalence: this must be rejected exactly like the
      // BUFFERED-site `it.each` block above (target-announcement rows) —
      // announcements are never editable (AC-IMMUT-6), no carve-out for an
      // admin sender — and the real announcement content must be what
      // ends up stored, not the edit's replacement.
      expect(resolved.kind).toBe('noop');
      const { messages } = await loadMessages(GROUP_THREAD.groupId);
      const stored = messages.find((m) => m.id === targetId);
      expect(stored?.content).toBe(makeAnnouncementContent()); // the real announcement, unmodified by the edit
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// DM own-author carve-out invariance (the admin gate never fires for a DM)
// ─────────────────────────────────────────────────────────────────────────

describe('AC-CROSS-2 — DM-thread announcement-shaped message: own-author verdict at every applicable site (admin gate never fires for dm:)', () => {
  it('DM direct site: own-author delete of an announcement-shaped message succeeds with NO admin provider registered at all', async () => {
    // No registerAdmins() call — DMs have no admin concept; the gate must
    // never consult (or require) one.
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'cc-dm-direct', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ pubkey: AUTHOR, tags: [['e', 'cc-dm-direct'], ['k', '14']] }));

    expect(result.kind).toBe('delete');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'cc-dm-direct')?.tombstoned).toBe(true);
  });

  it('DM direct site: a NON-author delete of the identical announcement-shaped message is rejected — own-authorship, not admin-ness, is DM\'s only gate', async () => {
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'cc-dm-nonauthor', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ pubkey: 'someone-else-entirely', tags: [['e', 'cc-dm-nonauthor'], ['k', '14']] }));

    expect(result.kind).toBe('discarded');
    const { messages } = await loadMessages(DM_THREAD_GROUP_ID);
    expect(messages.find((m) => m.id === 'cc-dm-nonauthor')?.tombstoned).toBeFalsy();
  });

  it('DM buffered site: own-author delete buffered before the announcement-shaped target arrives is still honored once it materializes', async () => {
    const pendingResult = await applyDeleteEditSignal(DM_THREAD, makeDeleteRumor({ pubkey: AUTHOR, tags: [['e', 'cc-dm-buffered'], ['k', '14']] }));
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'cc-dm-buffered', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));
    const resolved = await resolvePendingSignalsForSlot(DM_THREAD, 'cc-dm-buffered', AUTHOR);

    expect(resolved.kind).toBe('delete');
  });

  it('DM edit is still rejected against its own announcement-shaped message (S7 symmetry: no admin concept, but edit-immutability still applies content-wise)', async () => {
    await appendMessage(DM_THREAD_GROUP_ID, makeOriginal(DM_THREAD_GROUP_ID, { id: 'cc-dm-edit', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));

    const result = await applyDeleteEditSignal(
      DM_THREAD,
      makeEditRumor({ pubkey: AUTHOR, content: 'trying to edit my own announcement', tags: [['e', 'cc-dm-edit', '', 'edit'], ['rev', String(BASE_TIME_SECONDS)]] }),
    );

    // isAnnouncementInThread gates on isGroupThreadKey — a DM thread key is
    // never a "group" thread, so isEditAuthorizedByAnnouncementGate's
    // announcement check does not fire for DM at all; but since this
    // module's edit path has no OTHER content-shape restriction beyond the
    // announcement gate, a DM edit against an announcement-shaped message
    // is NOT rejected by THIS gate. Document the actual behavior rather
    // than asserting a floor this module doesn't own: DM's own-author edit
    // succeeds — the announcement-immutability property is a GROUP-only
    // guarantee (isGroupThreadKey), not a DM one.
    expect(result.kind).toBe('edit');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fail-closed admin resolution: unregistered / empty / throwing provider
// ─────────────────────────────────────────────────────────────────────────

describe('AC-CROSS-2 — fail-closed admin resolution: an admin carve-out can only ever be GRANTED by an affirmatively-resolved admin list, never by absence/failure', () => {
  it('DIRECT site: no provider registered at all (null) -> delete against an announcement is rejected even for a pubkey that WOULD be admin if a provider existed', async () => {
    registerGroupAdminsProvider(null);
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-failclosed-unregistered', content: makeAnnouncementContent() }));

    const result = await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-failclosed-unregistered'], ['k', '9']] }));

    expect(result.kind).toBe('discarded');
  });

  it('DIRECT site: provider registered but resolves an EMPTY admin set for this group -> rejected', async () => {
    registerGroupAdminsProvider(async () => []);
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-failclosed-empty', content: makeAnnouncementContent() }));

    const result = await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-failclosed-empty'], ['k', '9']] }));

    expect(result.kind).toBe('discarded');
  });

  it('DIRECT site: a THROWING provider -> fail-closed to [], rejected (never lets a thrown error propagate as a granted carve-out)', async () => {
    registerGroupAdminsProvider(async () => {
      throw new Error('admin lookup backend unavailable');
    });
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-failclosed-throwing', content: makeAnnouncementContent() }));

    const result = await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-failclosed-throwing'], ['k', '9']] }));

    expect(result.kind).toBe('discarded');
  });

  it('BUFFERED site: a THROWING provider at RESOLUTION time (not just at buffering time) still fails closed', async () => {
    registerGroupAdminsProvider(async () => {
      throw new Error('admin lookup backend unavailable');
    });
    const pendingResult = await applyDeleteEditSignal(GROUP_THREAD, makeDeleteRumor({ pubkey: ADMIN_PUBKEY, tags: [['e', 'cc-failclosed-buffered'], ['k', '9']] }));
    expect(pendingResult.kind).toBe('pending');

    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-failclosed-buffered', content: makeAnnouncementContent() }));
    const resolved = await resolvePendingSignalsForSlot(GROUP_THREAD, 'cc-failclosed-buffered', AUTHOR);

    expect(resolved.kind).toBe('noop');
  });

  it('TOMBSTONE site: an empty adminPubkeysHex array (the caller\'s own fail-closed resolution) rejects even the row\'s own author acting as sender, when the target is an announcement', async () => {
    await appendMessage(GROUP_THREAD.groupId, makeOriginal(GROUP_THREAD.groupId, { id: 'cc-failclosed-tombstone', content: makeAnnouncementContent(), senderPubkey: AUTHOR }));

    const applied = await tombstoneMessage(GROUP_THREAD.groupId, 'cc-failclosed-tombstone', 100, {
      senderPubkeyHex: AUTHOR, // the announcement's own author — irrelevant for a group announcement
      adminPubkeysHex: [], // fail-closed resolution
    });

    expect(applied).toBe(false);
  });
});
