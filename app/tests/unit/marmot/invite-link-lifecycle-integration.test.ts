/**
 * Cross-module order-sensitive invariant verification (epic:
 * invite-link-lifecycle, story S5 — AC-INV-1..6, architecture.md's
 * "## Order-Sensitive Composition" section).
 *
 * This is an INTEGRATION story: every producer under test here is the REAL,
 * already-landed implementation from S1 (`inviteLinkStorage.ts`), S2
 * (`approveJoinRequestImpl` in `MarmotContext.tsx`), and S4
 * (`inviteExpirySweep.ts` + the `inviteExpiries` slice of `unreadStore.ts`).
 * Per the Mock Strategy integration-story exception (story-planner.md
 * principle 5's exemption; VQ-S5-001), NOTHING in that seam is mocked or
 * reimplemented here — the only mock boundary anywhere in this file is
 * `inviteByNpub`, an external-I/O dependency injected into
 * `approveJoinRequestImpl` (VQ-S5-011's "the ONLY permitted mock boundary").
 * `idb-keyval` is faked with a flat in-memory Map (mirrors
 * `inviteLinkLifecycle.test.ts` / `inviteExpirySweep.test.ts` /
 * `inviteExpiries.test.ts`'s established convention) so the real storage
 * helpers run against it end to end.
 *
 * `react` is partially mocked: every real export is preserved via
 * `importOriginal` EXCEPT `useSyncExternalStore`, which is stubbed to call
 * `getSnapshot` directly (mirrors `unreadStore.test.ts`'s convention) so
 * `useUnreadCounts()` can be read synchronously outside a component render —
 * this repo has no jsdom/@testing-library/renderHook precedent. The
 * `importOriginal` form (rather than a full replacement) is required here
 * specifically because this file, unlike the single-module S1/S4 test
 * files, also imports `MarmotContext.tsx` (for the real
 * `approveJoinRequestImpl`), which needs the rest of `react`'s real hooks
 * (`useState`, `useCallback`, `useRef`, `createContext`, …) to import
 * cleanly, even though none of them execute at plain import time (verified
 * precedent: `approveJoinRequestImpl.test.ts` imports the same file under
 * vitest's default node environment with no react mock at all).
 *
 * Scope: this file is the story's ONLY artifact (stories.json's
 * `scope.includes`) — no production file under `app/src/` is touched
 * (VQ-S5-002). If any invariant below turned out not to hold against the
 * real implementations, the fix belongs to the owning module (S1/S2/S4),
 * not to this file — see result.json for whether that happened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

// ── idb-keyval mock — single flat Map-backed store ──────────────────────────
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  entries: vi.fn(async () => [...idbStore.entries()]),
  clear: vi.fn(async () => {
    idbStore.clear();
  }),
}));

// ── react partial mock — see file doc comment above ─────────────────────────
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

const {
  DAY_MS,
  saveInviteLink,
  getInviteLink,
  loadAllInviteLinks,
  migrateInviteLinks,
  incrementInviteLinkUsage,
} = await import('@/src/lib/marmot/inviteLinkStorage');
const { runInviteExpirySweep } = await import('@/src/lib/marmot/inviteExpirySweep');
const unreadStoreModule = await import('@/src/lib/unreadStore');
const { initInviteExpiries, markInviteExpiriesRead, useUnreadCounts } = unreadStoreModule;
const { createJoinRequestApproval } = await import('@/src/lib/marmot/joinRequestApproval');

// ── shared fixtures (mirrors the sibling S1/S4 test files' convention) ─────

function makeLink(overrides: Partial<InviteLink> = {}): InviteLink {
  return {
    nonce: 'nonce-1',
    groupId: 'group-1',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + DAY_MS,
    usageCount: 0,
    expiryNotified: false,
    expiryAcknowledged: false,
    label: undefined,
    muted: false,
    ...overrides,
  };
}

/**
 * A legacy pre-migration record — literally missing the four new fields (not
 * merely holding `undefined` for them), matching how a record saved before
 * this feature existed is actually shaped on disk.
 */
function makeLegacyLink(
  overrides: Partial<Pick<InviteLink, 'nonce' | 'groupId' | 'createdAt' | 'label' | 'muted'>> = {},
) {
  return {
    nonce: 'legacy-1',
    groupId: 'group-1',
    createdAt: 1_700_000_000_000,
    muted: false,
    ...overrides,
  };
}

async function seed(nonce: string, link: unknown): Promise<void> {
  idbStore.set(nonce, link);
}

/**
 * `unreadStore`'s `inviteExpiries` slice is a module-level singleton that
 * persists across every test in this file (there is no reset hook — mirrors
 * `unreadStore.test.ts`'s own convention of clearing only the specific keys
 * a test touches). Rather than track every touched groupId for an explicit
 * clear, every test that reads `useUnreadCounts().inviteExpiries[groupId]`
 * uses a freshly-minted groupId, so no test can observe another test's
 * leftover state regardless of execution order (VQ-S5-006).
 */
let groupSeq = 0;
function freshGroupId(prefix: string): string {
  groupSeq += 1;
  return `${prefix}-g${groupSeq}`;
}

beforeEach(() => {
  idbStore.clear();
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-1 — sweep exactly-once under concurrency
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires `n` sweep invocations across two interleaving shapes:
 *  - 'immediate': all `n` calls issued synchronously in the same tick
 *    (mirrors two `NotificationBell` instances both mounting at once).
 *  - 'staggeredMicrotask': every other call is deferred one microtask tick
 *    (mirrors a StrictMode remount arriving slightly after the first mount,
 *    or an overlapping interval tick landing mid-pass) — the in-flight
 *    latch must dedupe callers that arrive at different points in the
 *    event loop, not merely ones invoked perfectly synchronously.
 */
async function fireSweeps(now: number, n: number, mode: 'immediate' | 'staggeredMicrotask'): Promise<void> {
  const calls: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    if (mode === 'immediate' || i % 2 === 0) {
      calls.push(runInviteExpirySweep(now));
    } else {
      calls.push(Promise.resolve().then(() => runInviteExpirySweep(now)));
    }
  }
  await Promise.all(calls);
}

describe('AC-INV-1 — sweep notifies an expired, not-yet-notified link exactly once under concurrency', () => {
  it.each([
    { n: 2, mode: 'immediate' as const },
    { n: 3, mode: 'immediate' as const },
    { n: 5, mode: 'immediate' as const },
    { n: 2, mode: 'staggeredMicrotask' as const },
    { n: 4, mode: 'staggeredMicrotask' as const },
  ])('$n concurrent sweep invocations ($mode) notify exactly once — never 0, never >1', async ({ n, mode }) => {
    const groupId = freshGroupId('inv1');
    const nonce = `inv1-nonce-${groupId}`;
    await saveInviteLink(makeLink({ nonce, groupId, expiresAt: 5_000 }));

    await fireSweeps(5_000, n, mode);

    const persisted = await getInviteLink(nonce);
    expect(persisted?.expiryNotified).toBe(true);
    expect(useUnreadCounts().inviteExpiries[groupId]).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-2 — reload-safety: badge is derived from persisted flags
// ─────────────────────────────────────────────────────────────────────────

describe('AC-INV-2 — a reload reproduces the identical unread count, derived solely from persisted flags', () => {
  it.each([
    { reloadDelay: 0, extraSameGroup: 0 },
    { reloadDelay: 0, extraSameGroup: 2 },
    { reloadDelay: 100_000, extraSameGroup: 0 },
    { reloadDelay: 100_000, extraSameGroup: 1 },
  ])(
    'reload $reloadDelay ms after the sweep write, with $extraSameGroup other already-notified links present, reproduces the identical count',
    async ({ reloadDelay, extraSameGroup }) => {
      const groupId = freshGroupId('inv2');
      const nonce = `L-${groupId}`;
      await saveInviteLink(makeLink({ nonce, groupId, expiresAt: 5_000 }));
      for (let i = 0; i < extraSameGroup; i++) {
        // Already expired AND already notified well before L's own
        // expiresAt — simulates a prior, unrelated sweep pass, so
        // `initInviteExpiries`'s own `isExpired` clause counts it at the
        // baseline-derivation timestamp below (4_999), not just its
        // `expiryNotified` flag.
        await saveInviteLink(
          makeLink({
            nonce: `extra-${groupId}-${i}`,
            groupId,
            expiresAt: 4_000,
            expiryNotified: true,
            expiryAcknowledged: false,
          }),
        );
      }

      // Baseline derivation BEFORE L expires: only the already-notified
      // extras (if any) contribute — mirrors app startup deriving the badge
      // from whatever was already persisted.
      await initInviteExpiries(4_999);
      expect(useUnreadCounts().inviteExpiries[groupId]).toBe(extraSameGroup === 0 ? undefined : extraSameGroup);

      // L expires now; the live sweep bump layers ON TOP of that derived
      // baseline (Design Decision 8: the sweep's bump is a live-count
      // optimisation over the derivation, not a replacement for it).
      await runInviteExpirySweep(5_000);
      const liveCount = useUnreadCounts().inviteExpiries[groupId];
      expect(liveCount).toBe(1 + extraSameGroup);

      // Simulate "the app reloads": discard nothing explicitly (there is no
      // reset hook on the module-level slice — a real reload starts a fresh
      // process), and instead prove the DISCRIMINATING property: re-running
      // the derivation from the SAME persisted store reproduces the exact
      // same count a fresh process would compute, rather than assuming the
      // live counter (which a real reload would NOT carry over) is what's
      // being read. A test that never re-derives would not distinguish
      // "derived from persisted flags" from "an in-memory counter that
      // happens to also be correct" (VQ-S5-008).
      await initInviteExpiries(5_000 + reloadDelay);
      const reloadedCount = useUnreadCounts().inviteExpiries[groupId];

      expect(reloadedCount).toBe(liveCount);
      expect(reloadedCount).toBe(1 + extraSameGroup);
    },
  );

  it('acknowledging then re-deriving after a simulated reload yields 0 — the ack persists, not just the in-memory zero', async () => {
    const groupId = freshGroupId('inv2-ack');
    const nonce = `L-${groupId}`;
    await saveInviteLink(makeLink({ nonce, groupId, expiresAt: 5_000 }));

    await runInviteExpirySweep(5_000);
    expect(useUnreadCounts().inviteExpiries[groupId]).toBe(1);

    await markInviteExpiriesRead(groupId);
    expect(useUnreadCounts().inviteExpiries[groupId]).toBeUndefined();

    // Simulated reload: re-derive fresh from persisted flags.
    await initInviteExpiries(6_000);
    expect(useUnreadCounts().inviteExpiries[groupId]).toBeUndefined();

    const persisted = await getInviteLink(nonce);
    expect(persisted?.expiryAcknowledged).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-3 — migration suppression across arbitrary link mixes
// ─────────────────────────────────────────────────────────────────────────

describe('AC-INV-3 — migrateInviteLinks stamps exactly the already-expired-at-migration and muted records', () => {
  // now chosen large enough that createdAt=0 is comfortably expired and
  // createdAt near `now - DAY_MS` sits right at/around the boundary.
  const now = 10 * 86_400_000; // 10 * DAY_MS

  it('mix A (order: expired, not-yet-expired, muted) — per-record correctness', async () => {
    await seed('mixA-expired', makeLegacyLink({ nonce: 'mixA-expired', groupId: 'gA', createdAt: 0 }));
    await seed(
      'mixA-fresh',
      makeLegacyLink({ nonce: 'mixA-fresh', groupId: 'gA', createdAt: now - 100 }), // effectiveExpiry = now - 100 + DAY_MS > now
    );
    await seed('mixA-muted', makeLegacyLink({ nonce: 'mixA-muted', groupId: 'gA', createdAt: 0, muted: true }));

    await migrateInviteLinks(now);

    expect((await getInviteLink('mixA-expired'))?.expiryNotified).toBe(true);
    expect((await getInviteLink('mixA-fresh'))?.expiryNotified).toBe(false);
    const muted = await getInviteLink('mixA-muted');
    expect(muted?.expiryNotified).toBe(true);
    // createdAt=0 → effectiveExpiry = DAY_MS, which is already BEFORE `now`
    // (10 * DAY_MS) — the clamp `min(effectiveExpiry, now)` picks
    // effectiveExpiry itself here, not `now` (that branch is covered by mix
    // B's still-future un-clamped expiry below).
    expect(muted?.expiresAt).toBe(DAY_MS);
  });

  it('mix B (order: muted-with-full-fields-future-expiry, expired, expired, not-yet-expired) — duplicate categories, non-sorted order', async () => {
    // A non-legacy, already fully-fielded muted record with a still-future
    // un-clamped expiresAt — Design Decision 4: muted records are ALWAYS
    // reprocessed (never fast-pathed), regardless of legacy status.
    await saveInviteLink(
      makeLink({ nonce: 'mixB-muted-full', groupId: 'gB', createdAt: 0, expiresAt: now + 50_000, muted: true, expiryNotified: false }),
    );
    await seed('mixB-expired-1', makeLegacyLink({ nonce: 'mixB-expired-1', groupId: 'gB', createdAt: 0 }));
    await seed('mixB-expired-2', makeLegacyLink({ nonce: 'mixB-expired-2', groupId: 'gB', createdAt: 1 }));
    await seed('mixB-fresh-1', makeLegacyLink({ nonce: 'mixB-fresh-1', groupId: 'gB', createdAt: now - 50 }));

    await migrateInviteLinks(now);

    const mutedFull = await getInviteLink('mixB-muted-full');
    expect(mutedFull?.expiryNotified).toBe(true);
    expect(mutedFull?.expiresAt).toBe(now);
    expect((await getInviteLink('mixB-expired-1'))?.expiryNotified).toBe(true);
    expect((await getInviteLink('mixB-expired-2'))?.expiryNotified).toBe(true);
    expect((await getInviteLink('mixB-fresh-1'))?.expiryNotified).toBe(false);
  });

  it('mix C (boundary-exact expired vs boundary-exact fresh, plus an already-past muted record) — and the not-yet-expired record DOES notify on a later sweep, never silently skipped', async () => {
    const boundaryGroupId = freshGroupId('inv3-mixC');
    await seed(
      'mixC-boundary-expired',
      makeLegacyLink({ nonce: 'mixC-boundary-expired', groupId: 'gC', createdAt: now - DAY_MS }), // effectiveExpiry === now exactly
    );
    await seed(
      'mixC-boundary-fresh',
      makeLegacyLink({ nonce: 'mixC-boundary-fresh', groupId: boundaryGroupId, createdAt: now - DAY_MS + 1 }), // effectiveExpiry === now + 1
    );
    // Already past its own (non-legacy) expiresAt, and muted: the clamp is a
    // no-op on the timestamp (already <= now) but expiryNotified still flips.
    await saveInviteLink(
      makeLink({ nonce: 'mixC-muted-already-past', groupId: 'gC', createdAt: 0, expiresAt: now - 1_000, muted: true, expiryNotified: false }),
    );

    await migrateInviteLinks(now);

    expect((await getInviteLink('mixC-boundary-expired'))?.expiryNotified).toBe(true);
    expect((await getInviteLink('mixC-boundary-fresh'))?.expiryNotified).toBe(false);
    const mutedPast = await getInviteLink('mixC-muted-already-past');
    expect(mutedPast?.expiryNotified).toBe(true);
    expect(mutedPast?.expiresAt).toBe(now - 1_000); // clamp(min) is a no-op here — already before `now`

    // The not-yet-expired-at-migration record must NOT be silently skipped
    // forever: once it actually expires, the sweep (not migration) notifies
    // it — Design Decision 3's "the sweep otherwise notifies regardless of
    // when expiry occurred" half of the suppression contract.
    await runInviteExpirySweep(now + 2); // now past mixC-boundary-fresh's effectiveExpiry (now + 1)

    const boundaryFreshAfterSweep = await getInviteLink('mixC-boundary-fresh');
    expect(boundaryFreshAfterSweep?.expiryNotified).toBe(true);
    expect(useUnreadCounts().inviteExpiries[boundaryGroupId]).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gate-remediation (Finding 1) — migration suppression must actually
// suppress the derived badge, not merely the flag it half-stamped
// ─────────────────────────────────────────────────────────────────────────

// Prior to the fix, `migrateRecord` stamped `expiryNotified: true` for a
// legacy-already-expired or muted link (Design Decision 3/4's flood
// suppression) but left `expiryAcknowledged: false`. Since
// `initInviteExpiries` derives the badge as
// `isExpired && expiryNotified && !expiryAcknowledged`, that half-stamp
// still counted as unread — the exact retroactive-expiry flood the
// suppression exists to prevent, reproduced here by driving migration
// followed by the REAL derive path (`initInviteExpiries`) rather than
// asserting on the raw flags alone (which the per-story S1 tests already
// covered and which this integration story's job is to go beyond — VQ-S5
// gap this finding named).
describe('Gate-remediation (Finding 1) — migrateInviteLinks + initInviteExpiries yields a truly-suppressed (zero) badge', () => {
  it('a store of legacy already-expired links and muted links produces a zero derived unread count per group after migration', async () => {
    const now = 10 * DAY_MS;
    const groupA = freshGroupId('flood-legacy');
    const groupB = freshGroupId('flood-muted');
    const groupC = freshGroupId('flood-mixed');

    // groupA: purely legacy, already expired at migration time.
    await seed('flood-a-1', makeLegacyLink({ nonce: 'flood-a-1', groupId: groupA, createdAt: 0 }));
    await seed('flood-a-2', makeLegacyLink({ nonce: 'flood-a-2', groupId: groupA, createdAt: 1 }));

    // groupB: fully-fielded but muted, with a still-future un-clamped expiry
    // (Design Decision 4 — muted links are always reprocessed).
    await saveInviteLink(
      makeLink({ nonce: 'flood-b-1', groupId: groupB, createdAt: 0, expiresAt: now + 50_000, muted: true }),
    );

    // groupC: a mix of both suppression categories in the same group, plus
    // a not-yet-expired legacy link that must NOT be suppressed (it still
    // needs to notify once the sweep later catches it — AC-INV-3).
    await seed('flood-c-expired', makeLegacyLink({ nonce: 'flood-c-expired', groupId: groupC, createdAt: 0 }));
    await saveInviteLink(
      makeLink({ nonce: 'flood-c-muted', groupId: groupC, createdAt: 0, expiresAt: now - 1_000, muted: true }),
    );
    await seed(
      'flood-c-fresh',
      makeLegacyLink({ nonce: 'flood-c-fresh', groupId: groupC, createdAt: now - 100 }), // not yet expired
    );

    await migrateInviteLinks(now);
    await initInviteExpiries(now);

    // The flood is truly suppressed: zero derived unread count for every
    // group touched only by suppressed (already-expired-at-migration or
    // muted) links.
    expect(useUnreadCounts().inviteExpiries[groupA]).toBeUndefined();
    expect(useUnreadCounts().inviteExpiries[groupB]).toBeUndefined();
    expect(useUnreadCounts().inviteExpiries[groupC]).toBeUndefined();

    // Every suppressed record is acknowledged, not merely notified.
    for (const nonce of ['flood-a-1', 'flood-a-2', 'flood-b-1', 'flood-c-expired', 'flood-c-muted']) {
      const link = await getInviteLink(nonce);
      expect(link?.expiryNotified).toBe(true);
      expect(link?.expiryAcknowledged).toBe(true);
    }

    // The not-yet-expired legacy link in groupC is untouched by suppression
    // — it still owes a notification once it actually expires.
    const freshLink = await getInviteLink('flood-c-fresh');
    expect(freshLink?.expiryNotified).toBe(false);
    expect(freshLink?.expiryAcknowledged).toBe(false);

    // And the sweep still notifies it later, producing a real (non-flood)
    // badge for groupC once it expires — suppression must not have
    // permanently silenced this group.
    await runInviteExpirySweep(now + DAY_MS + 200);
    expect(useUnreadCounts().inviteExpiries[groupC]).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-4 — crash ordering: IDB stamp precedes the in-memory bump
// ─────────────────────────────────────────────────────────────────────────

describe('AC-INV-4 — an interruption between "compute expired" and "bump in-memory counter" never yields shown-but-not-stamped', () => {
  it('the in-memory bump throwing AFTER a successful persist leaves the link recoverable ("stamped-not-yet-shown"), never "shown-but-not-stamped"', async () => {
    const groupId = freshGroupId('inv4');
    const nonce = `inv4-${groupId}`;
    await saveInviteLink(makeLink({ nonce, groupId, expiresAt: 5_000 }));

    const bumpSpy = vi.spyOn(unreadStoreModule, 'incrementInviteExpiry').mockImplementationOnce(() => {
      throw new Error('simulated crash between the IDB stamp and the in-memory bump');
    });

    // The sweep's own try/catch swallows the per-link failure — must not throw.
    await expect(runInviteExpirySweep(5_000)).resolves.toBeUndefined();

    // The IDB stamp landed — it was awaited and resolved BEFORE the throwing
    // in-memory bump call (source-level ordering in inviteExpirySweep.ts).
    const persisted = await getInviteLink(nonce);
    expect(persisted?.expiryNotified).toBe(true);

    // The live in-memory bump never happened (the mock threw before it could
    // mutate state) — this is "stamped-not-yet-shown", the state this AC
    // requires; "shown-but-not-stamped" (persisted flag still false but the
    // counter already bumped) must never be reachable, and isn't here.
    expect(useUnreadCounts().inviteExpiries[groupId]).toBeUndefined();

    bumpSpy.mockRestore();

    // Recovery: initInviteExpiries derives strictly from persisted flags, so
    // the "crashed" notification is recovered on the very next init — never
    // permanently lost, never double-shown.
    await initInviteExpiries(5_000);
    expect(useUnreadCounts().inviteExpiries[groupId]).toBe(1);
  });

  it('a multi-link pass: a bump crash on the FIRST link does not abort the SECOND link, and both recover on re-init', async () => {
    const groupId1 = freshGroupId('inv4-multi-a');
    const groupId2 = freshGroupId('inv4-multi-b');
    const nonce1 = `inv4-multi-1-${groupId1}`;
    const nonce2 = `inv4-multi-2-${groupId2}`;
    await saveInviteLink(makeLink({ nonce: nonce1, groupId: groupId1, expiresAt: 5_000 }));
    await saveInviteLink(makeLink({ nonce: nonce2, groupId: groupId2, expiresAt: 5_000 }));

    const bumpSpy = vi.spyOn(unreadStoreModule, 'incrementInviteExpiry').mockImplementationOnce(() => {
      throw new Error('simulated crash on the first link only');
    });

    await runInviteExpirySweep(5_000);

    expect((await getInviteLink(nonce1))?.expiryNotified).toBe(true); // stamp landed despite the crash
    expect((await getInviteLink(nonce2))?.expiryNotified).toBe(true); // second link's own pass unaffected
    expect(useUnreadCounts().inviteExpiries[groupId1]).toBeUndefined(); // first link's live bump never ran
    expect(useUnreadCounts().inviteExpiries[groupId2]).toBe(1); // second link's live bump DID run (real fn)

    bumpSpy.mockRestore();

    await initInviteExpiries(5_000);
    expect(useUnreadCounts().inviteExpiries[groupId1]).toBe(1); // recovered
    expect(useUnreadCounts().inviteExpiries[groupId2]).toBe(1); // still correct
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-5 — usageCount has no lost updates under concurrent approvals
// ─────────────────────────────────────────────────────────────────────────

// D8: approvals use the queued key-package inviter and an onApproved follow-up.
describe('AC-INV-5 — concurrent approvals preserve invite-link usage', () => {
  it.each([2, 3, 4])('%i approvals increment the same link', async (count) => {
    const nonce = `concurrent-${count}`;
    const groupId = `group-${count}`;
    await saveInviteLink(makeLink({ nonce, groupId, usageCount: 5 }));
    const approval = createJoinRequestApproval({
      inviter: { inviteByPubkey: vi.fn(async () => ({ outcome: { status: 'delivered' } })) } as never,
      getGroup: async () => ({ id: groupId }) as never,
      enqueue: (job) => { void job(); },
      consumeRequest: async () => {},
      onApproved: async (request) => incrementInviteLinkUsage(request.nonce),
    });
    const results = await Promise.all(Array.from({ length: count }, (_, i) => approval.approve({
      nonce, groupId, pubkeyHex: `requester-${i}`, eventId: `event-${i}`, receivedAt: Date.now(),
    })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await getInviteLink(nonce))?.usageCount).toBe(5 + count);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-6 — migrateInviteLinks idempotency/no-race under repeated or
// concurrent invocation, with a racing reader
// ─────────────────────────────────────────────────────────────────────────

/** Seeds a structurally-identical fixture under a caller-chosen nonce suffix, keyed by role via groupId so two differently-nonced fixture copies can be compared structurally. */
async function seedInv6Fixture(suffix: string): Promise<string[]> {
  const legacyExpired = `legacy-expired-${suffix}`;
  const legacyFresh = `legacy-fresh-${suffix}`;
  const muted = `muted-${suffix}`;
  await seed(legacyExpired, makeLegacyLink({ nonce: legacyExpired, groupId: 'role-legacy-expired', createdAt: 1000 }));
  await seed(legacyFresh, makeLegacyLink({ nonce: legacyFresh, groupId: 'role-legacy-fresh', createdAt: 9_000_000 }));
  await saveInviteLink(
    makeLink({ nonce: muted, groupId: 'role-muted', createdAt: 1000, expiresAt: 1000 + DAY_MS, muted: true }),
  );
  return [legacyExpired, legacyFresh, muted];
}

async function readInv6Normalized(nonces: string[]) {
  const links = await Promise.all(nonces.map((n) => getInviteLink(n)));
  return links
    .map((l) => l!)
    .sort((a, b) => a.groupId.localeCompare(b.groupId))
    .map(({ nonce: _nonce, ...rest }) => rest);
}

describe('AC-INV-6 — migrateInviteLinks is idempotent and non-racing under repeated/concurrent invocation', () => {
  const now = 1000 + DAY_MS + 1;

  it.each([1, 2, 3, 4])(
    '%i same-tick concurrent invocations produce a record set identical to a single-invocation baseline',
    async (n) => {
      // Baseline: exactly ONE migrateInviteLinks call against its own fixture copy.
      const baselineNonces = await seedInv6Fixture(`baseline-${n}`);
      await migrateInviteLinks(now);
      const baseline = await readInv6Normalized(baselineNonces);

      // n concurrent (same-tick) invocations against a freshly-seeded,
      // structurally-identical fixture — the in-flight latch must dedupe
      // these onto a single actual pass regardless of n.
      const concurrentNonces = await seedInv6Fixture(`concurrent-${n}`);
      await Promise.all(Array.from({ length: n }, () => migrateInviteLinks(now)));
      const concurrentResult = await readInv6Normalized(concurrentNonces);

      expect(concurrentResult).toEqual(baseline);
    },
  );

  it.each([2, 3, 4])(
    '%i sequential (fully-awaited) re-invocations change nothing after the first',
    async (n) => {
      const nonces = await seedInv6Fixture(`sequential-${n}`);
      await migrateInviteLinks(now);
      const afterFirst = await readInv6Normalized(nonces);

      for (let i = 1; i < n; i++) {
        await migrateInviteLinks(now);
      }
      const afterRepeated = await readInv6Normalized(nonces);

      expect(afterRepeated).toEqual(afterFirst);
    },
  );

  it('a concurrent loadAllInviteLinks read never observes a partially-migrated record (some but not all of the four fields backfilled)', async () => {
    await seedInv6Fixture('reader-race');

    const migrationPromise = Promise.all([migrateInviteLinks(now), migrateInviteLinks(now)]);
    const snapshots = await Promise.all([loadAllInviteLinks(), loadAllInviteLinks(), loadAllInviteLinks()]);
    await migrationPromise;

    for (const snapshot of snapshots) {
      for (const link of snapshot as Partial<InviteLink>[]) {
        const fieldsPresent = [
          link.expiresAt !== undefined,
          link.usageCount !== undefined,
          link.expiryNotified !== undefined,
          link.expiryAcknowledged !== undefined,
        ].filter(Boolean).length;
        // Every record is either fully untouched (0) or fully backfilled (4)
        // — migrateRecord() always writes all four fields together or not
        // at all, so no intermediate 1/2/3 count may ever be observed.
        expect([0, 4]).toContain(fieldsPresent);
      }
    }

    const finalState = await loadAllInviteLinks();
    for (const link of finalState) {
      expect(link.expiresAt).toBeDefined();
      expect(link.usageCount).toBeDefined();
      expect(link.expiryNotified).toBeDefined();
      expect(link.expiryAcknowledged).toBeDefined();
    }
  });
});
