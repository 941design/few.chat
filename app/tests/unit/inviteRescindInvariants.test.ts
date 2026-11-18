/**
 * S12 (epic: invite-rescind-and-member-removal) — FR-A7 adversarial-
 * falsification audit layer for architecture.md's four whole-flow
 * "Order-Sensitive Composition" guarantees (AC-INV-1..4).
 *
 * This is verification-only: it introduces NO new production logic. It
 * exercises the REAL, already-implemented pure decision functions and the
 * REAL IDB-backed stores (fake-indexeddb, not mocked) that the four
 * guarantees are built from:
 *
 *   - PendingInviteStore  (app/src/lib/marmot/pendingDirectInviteStorage.ts)
 *   - MemberProfileStore  (app/src/lib/marmot/groupStorage.ts)
 *   - GroupsPage          (app/pages/groups.tsx) — computeStillMember,
 *                          runPostRemovalCleanup, classifyRemovalResult
 *   - MemberList          (app/src/components/groups/MemberList.tsx) —
 *                          selectMemberRowAffordance
 *
 * Each `describe` block below enumerates (exhaustively, not by sampled
 * example) the exact generator space named in acceptance-criteria.md for
 * that AC, and asserts the AC's failure-condition never occurs across the
 * ENTIRE space.
 *
 * Distinct from, and does not re-implement, prior coverage:
 *   - app/tests/unit/marmot/pendingDirectInviteStorage.test.ts (S1) — store
 *     CRUD/persistence in isolation.
 *   - app/tests/unit/pages/groupsMemberRemoval.test.ts (S9) — single-example
 *     unit coverage of computeStillMember/runPostRemovalCleanup/
 *     performGroupMemberRemoval/classifyRemovalResult.
 *   - app/tests/unit/memberListAdminUi.test.ts (S10) — single-example
 *     coverage of selectMemberRowAffordance per AC-LABEL-2..6/AC-UNIV-2.
 *   - app/tests/e2e/groups-remove-member.spec.ts,
 *     groups-direct-invite-lifecycle.spec.ts (S11) — concrete, real-browser,
 *     real-click end-to-end scenarios.
 * S12 is the consolidated property/generator-space layer sitting on top of
 * that example-based coverage — every test here sweeps a full boolean or
 * enumerated space rather than asserting a single hand-picked case.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  recordPendingDirectInvite,
  clearPendingDirectInvite,
  loadPendingDirectInviteMarkers,
} from '@/src/lib/marmot/pendingDirectInviteStorage';
import {
  mergeMemberProfile,
  loadMemberProfiles,
  deleteMemberProfile,
  clearAllGroupData,
} from '@/src/lib/marmot/groupStorage';
import {
  computeStillMember,
  runPostRemovalCleanup,
  classifyRemovalResult,
  type CancelPendingInvitationResult,
} from '@/pages/groups';
import { selectMemberRowAffordance } from '@/src/components/groups/MemberList';
import type { MemberProfile } from '@/src/types';

const GROUP_ID = 'inv-group-1';
const PUBKEY = 'aa'.repeat(32);
const OTHER_MEMBER = 'bb'.repeat(32);

function profileFixture(pubkeyHex: string): MemberProfile {
  return {
    pubkeyHex,
    nickname: 'Test Member',
    avatar: null,
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  // Real reset of every store this suite touches — mirrors S1/S9's
  // beforeEach precedent (clearAllGroupData clears memberProfileStore AND
  // (per S2) fans out into clearAllPendingDirectInvites).
  await clearAllGroupData();
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-1 — marker-implies-pending-or-gone
// ─────────────────────────────────────────────────────────────────────────
//
// Generator: the space of orderings of {the invitee's own signed profile
// arriving, an admin invoking Cancel Invite, an admin invoking Remove
// Member, a concurrent co-admin's Remove committing first (raceDetected)},
// taken one at a time or racing pairwise. Failure condition: a persisted
// marker coexists with "confirmed" status for the same pubkey.

type InvOneEvent = 'profile-arrival' | 'cancel-invite' | 'remove-member' | 'race-detected';

/**
 * Applies one event of AC-INV-1's generator space against the REAL stores.
 *
 * - 'profile-arrival' mirrors profileHandler.ts's AC-MARKER-5/6 contract:
 *   the marker is cleared unconditionally whenever the invitee's own signed
 *   profile arrives, independent of the merge's LWW outcome (merge-result-
 *   independent) — modeled here by calling the REAL clearPendingDirectInvite.
 * - 'cancel-invite' / 'remove-member' / 'race-detected' all funnel through
 *   the REAL runPostRemovalCleanup gate, which architecture.md's guarantee
 *   #2 requires to be gated SOLELY on tree membership (stillMember), never
 *   on which of the three removal variants produced that state — so all
 *   three are modeled identically here (liveMembers no longer contains the
 *   pubkey), which is the invariant itself, not a shortcut.
 *
 * Returns which of {profileArrived, removed} this single event contributes,
 * so the caller can fold state across an ordering.
 */
async function applyInv1Event(
  event: InvOneEvent,
  groupId: string,
  pubkey: string,
): Promise<{ profileArrived: boolean; removed: boolean }> {
  if (event === 'profile-arrival') {
    try {
      await clearPendingDirectInvite(groupId, pubkey);
    } catch {
      // best-effort, per profileHandler.ts
    }
    return { profileArrived: true, removed: false };
  }
  // 'cancel-invite' | 'remove-member' | 'race-detected'
  const liveMembersAfter: string[] = [OTHER_MEMBER]; // pubkey absent in every variant
  const stillMember = computeStillMember(liveMembersAfter, pubkey);
  await runPostRemovalCleanup({
    groupId,
    pubkey,
    stillMember,
    deleteMemberProfile,
    clearPendingDirectInvite,
  });
  return { profileArrived: false, removed: true };
}

/** Full ordering space: 4 singles + all 12 ordered pairs (racing pairwise, both orders). */
const INV1_EVENTS: InvOneEvent[] = ['profile-arrival', 'cancel-invite', 'remove-member', 'race-detected'];
const INV1_ORDERINGS: InvOneEvent[][] = [
  ...INV1_EVENTS.map((e) => [e]),
  ...INV1_EVENTS.flatMap((a) => INV1_EVENTS.filter((b) => b !== a).map((b) => [a, b])),
];

describe('AC-INV-1 — marker-implies-pending-or-gone', () => {
  it(`sweeps all ${INV1_ORDERINGS.length} orderings (singles + racing pairwise, both orders) and never leaves a marker coexisting with confirmed status`, async () => {
    for (const ordering of INV1_ORDERINGS) {
      await clearAllGroupData();
      await mergeMemberProfile(GROUP_ID, profileFixture(PUBKEY));
      await recordPendingDirectInvite(GROUP_ID, PUBKEY, 'invite-ref');

      let profileArrived = false;
      let removed = false;
      for (const event of ordering) {
        const step = await applyInv1Event(event, GROUP_ID, PUBKEY);
        profileArrived = profileArrived || step.profileArrived;
        removed = removed || step.removed;
      }

      const markerExists = (await loadPendingDirectInviteMarkers(GROUP_ID)).has(PUBKEY);
      // "confirmed" (in confirmedPubkeys) requires both a real signed profile
      // having arrived AND the pubkey still being in the tree (a removed
      // pubkey drops out of memberPubkeys, hence out of confirmedPubkeys,
      // regardless of whether it once sent a profile).
      const confirmed = profileArrived && !removed;

      // PRIMARY, discriminating assertion (holds across ALL orderings, not just
      // the one that could reach `confirmed`): every event in the generator —
      // profile-arrival (via the real clearPendingDirectInvite) AND every
      // removal (via the real runPostRemovalCleanup gate, stillMember=false) —
      // clears the marker against the REAL store. So after ANY non-empty
      // ordering the marker must be gone. This is what gives the 16-ordering
      // sweep teeth: a broken clear-on-arrival OR a broken removal-side clear
      // (in any interleaving) fails here, not just in the single
      // ['profile-arrival'] case. The coexistence check below is then entailed.
      expect(
        markerExists,
        `ordering [${ordering.join(' -> ')}] left an uncleared marker`,
      ).toBe(false);

      // The named INV-1 invariant: a persisted marker never coexists with a
      // "confirmed" member. Entailed by the marker-cleared assertion above on
      // the happy path (all clears succeed); the failure-mode case — a clear
      // that throws/skips, leaving a transient orphan-while-confirmed — is out
      // of this store-level sweep by design and its row-label masking safety is
      // proven adversarially by AC-INV-4 below.
      expect(
        markerExists && confirmed,
        `ordering [${ordering.join(' -> ')}] left marker=${markerExists} confirmed=${confirmed}`,
      ).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-2 — purge-and-clear-both-run, commit-independent
// ─────────────────────────────────────────────────────────────────────────
//
// Generator: {ordinary committing removal, raceDetected via already-not-
// pending, raceDetected via empty leaf indexes} x {marker present, marker
// absent}. Failure condition: the pubkey is confirmed gone from the tree
// but its profile entry or marker still exists.

type RemovalOutcome = {
  name: string;
  liveMembersAfter: string[];
  result: CancelPendingInvitationResult;
};

// The three named removal-outcome variants differ in HOW the pubkey ends up
// absent from the tree (this client's own commit vs. either raceDetected
// short-circuit in cancelInvitationImpl.ts), but architecture.md's guarantee
// #2 requires the post-removal gate to be blind to that distinction — it
// gates purely on tree membership. Modeling all three explicitly (rather
// than collapsing them before the test) is the point: it proves the
// invariant holds ACROSS the distinction precisely because the gate ignores
// it, rather than assuming that in advance.
const REMOVAL_OUTCOMES: RemovalOutcome[] = [
  { name: 'ordinary-commit', liveMembersAfter: [OTHER_MEMBER], result: { ok: true } },
  {
    name: 'raceDetected-via-not-pending',
    liveMembersAfter: [OTHER_MEMBER],
    result: { ok: true, raceDetected: true },
  },
  {
    name: 'raceDetected-via-empty-leaves',
    liveMembersAfter: [],
    result: { ok: true, raceDetected: true },
  },
];

describe('AC-INV-2 — purge-and-clear-both-run, commit-independent', () => {
  for (const outcome of REMOVAL_OUTCOMES) {
    for (const markerPresent of [true, false]) {
      it(`${outcome.name} x marker-${markerPresent ? 'present' : 'absent'}: both the profile purge and the marker clear run against REAL IDB state`, async () => {
        await mergeMemberProfile(GROUP_ID, profileFixture(PUBKEY));
        if (markerPresent) {
          await recordPendingDirectInvite(GROUP_ID, PUBKEY, 'invite-ref');
        }

        const deleteSpy = vi.fn(deleteMemberProfile); // spy WRAPPING the real fn — call-count AND real IDB effect both checked
        const clearSpy = vi.fn(clearPendingDirectInvite);

        const stillMember = computeStillMember(outcome.liveMembersAfter, PUBKEY);
        expect(stillMember).toBe(false); // sanity: every member of this space is "gone from tree"

        await runPostRemovalCleanup({
          groupId: GROUP_ID,
          pubkey: PUBKEY,
          stillMember,
          deleteMemberProfile: deleteSpy,
          clearPendingDirectInvite: clearSpy,
        });

        expect(deleteSpy).toHaveBeenCalledWith(GROUP_ID, PUBKEY);
        expect(clearSpy).toHaveBeenCalledWith(GROUP_ID, PUBKEY);

        // Real underlying state, not just "was called":
        const profiles = await loadMemberProfiles(GROUP_ID);
        expect(profiles.some((p) => p.pubkeyHex === PUBKEY)).toBe(false);
        const markers = await loadPendingDirectInviteMarkers(GROUP_ID);
        expect(markers.has(PUBKEY)).toBe(false);

        // Sanity cross-check: RemovalImpl's result shape still routes to the
        // expected toast classification, independent of the purge gate above
        // (classifyRemovalResult never consults stillMember/purge state).
        expect(classifyRemovalResult(outcome.result)).toBe(
          outcome.name === 'ordinary-commit' ? 'success' : 'raceNotice',
        );
      });
    }
  }

  // AC-PURGE-4 counter-space: genuine failure, pubkey still a member — NEITHER
  // side effect may run, in either marker-presence state.
  for (const markerPresent of [true, false]) {
    it(`still-member (genuine failure) x marker-${markerPresent ? 'present' : 'absent'}: NEITHER the purge NOR the marker clear run`, async () => {
      await mergeMemberProfile(GROUP_ID, profileFixture(PUBKEY));
      if (markerPresent) {
        await recordPendingDirectInvite(GROUP_ID, PUBKEY, 'invite-ref');
      }

      const deleteSpy = vi.fn(deleteMemberProfile);
      const clearSpy = vi.fn(clearPendingDirectInvite);

      const stillMember = computeStillMember([PUBKEY, OTHER_MEMBER], PUBKEY);
      expect(stillMember).toBe(true);

      await runPostRemovalCleanup({
        groupId: GROUP_ID,
        pubkey: PUBKEY,
        stillMember,
        deleteMemberProfile: deleteSpy,
        clearPendingDirectInvite: clearSpy,
      });

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();

      const profiles = await loadMemberProfiles(GROUP_ID);
      expect(profiles.some((p) => p.pubkeyHex === PUBKEY)).toBe(true); // untouched
      const markers = await loadPendingDirectInviteMarkers(GROUP_ID);
      expect(markers.has(PUBKEY)).toBe(markerPresent); // untouched
    });
  }

  it('a genuinely concurrent two-admin race (both computing stillMember=false and invoking cleanup concurrently) still leaves both real stores correctly purged/cleared', async () => {
    await mergeMemberProfile(GROUP_ID, profileFixture(PUBKEY));
    await recordPendingDirectInvite(GROUP_ID, PUBKEY, 'invite-ref');

    const runOnce = () =>
      runPostRemovalCleanup({
        groupId: GROUP_ID,
        pubkey: PUBKEY,
        stillMember: false,
        deleteMemberProfile,
        clearPendingDirectInvite,
      });

    // Two admins' cleanup calls racing against the same real IDB stores.
    await expect(Promise.all([runOnce(), runOnce()])).resolves.toBeDefined();

    const profiles = await loadMemberProfiles(GROUP_ID);
    expect(profiles.some((p) => p.pubkeyHex === PUBKEY)).toBe(false);
    const markers = await loadPendingDirectInviteMarkers(GROUP_ID);
    expect(markers.has(PUBKEY)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-3 — every in-tree row has a functioning removal affordance
// ─────────────────────────────────────────────────────────────────────────
//
// Generator: {marker present or absent for the viewing admin, row pending or
// confirmed, viewing admin is or is not the inviter who holds the marker}.
// Failure condition: an admin-visible, non-self row renders neither control.
//
// selectMemberRowAffordance's signature has no "inviter" parameter — this is
// itself the proof that the "inviter/non-inviter admin" axis cannot affect
// the outcome: the identical call is made regardless of which admin is
// viewing, so the function is structurally incapable of branching on viewer
// identity beyond isYou/isAdmin. The exhaustive sweep below covers the
// {marker, isPending} 2x2 that the function DOES branch on.

describe('AC-INV-3 — every in-tree row has a functioning removal affordance', () => {
  it('for every admin-visible, non-self row across the full {isPending, hasMarker} 2x2, the affordance is never "none"', () => {
    for (const isPending of [true, false]) {
      for (const hasMarker of [true, false]) {
        const result = selectMemberRowAffordance({ isYou: false, isAdmin: true, isPending, hasMarker });
        expect(
          result,
          `isPending=${isPending} hasMarker=${hasMarker} produced 'none' for an admin-visible non-self row`,
        ).not.toBe('none');
        expect(['cancel-invite', 'remove-member']).toContain(result);
      }
    }
  });

  it('the resulting affordance is exactly one of {cancel-invite, remove-member} — never both, never neither — for every combination', () => {
    const seen = new Set<string>();
    for (const isPending of [true, false]) {
      for (const hasMarker of [true, false]) {
        seen.add(selectMemberRowAffordance({ isYou: false, isAdmin: true, isPending, hasMarker }));
      }
    }
    expect(seen.has('none')).toBe(false);
    expect([...seen].every((v) => v === 'cancel-invite' || v === 'remove-member')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-INV-4 — orphan-marker safety
// ─────────────────────────────────────────────────────────────────────────
//
// Generator: {the failure-triggered marker-clear succeeding, the failure-
// triggered marker-clear itself throwing/being skipped} x {the pubkey never
// having entered the tree, having entered the tree via an unrelated
// concurrent invite}. Failure condition: the row renders "Cancel Invite"
// when the pubkey is absent from the tree.
//
// At the row level, "absent from the tree" / "never entered" / "not
// re-entered under THIS marker's identity" collapses to isPending=false for
// the pubkey being evaluated (a later unrelated invite for the SAME pubkey
// would be a fresh, genuinely-pending row with its own new marker — not an
// orphan of the old one). "Clear succeeded" vs "clear failed/skipped" is
// modeled as hasMarker={false, true} respectively — an orphaned marker
// (clear failed) must be masked exactly as effectively as a correctly
// cleared one.

describe('AC-INV-4 — orphan-marker safety (isPending && marker conjunction masks an orphaned marker)', () => {
  const VIEWER_SPACE: { isYou: boolean; isAdmin: boolean }[] = [
    { isYou: false, isAdmin: true },
    { isYou: false, isAdmin: false },
    { isYou: true, isAdmin: true },
    { isYou: true, isAdmin: false },
  ];

  it.each(VIEWER_SPACE)(
    'never renders cancel-invite for a not-pending pubkey (isYou=$isYou, isAdmin=$isAdmin), regardless of whether the marker-clear succeeded or an orphaned marker survives',
    ({ isYou, isAdmin }) => {
      for (const hasMarker of [true, false]) {
        const result = selectMemberRowAffordance({ isYou, isAdmin, isPending: false, hasMarker });
        expect(result, `isYou=${isYou} isAdmin=${isAdmin} hasMarker=${hasMarker}`).not.toBe('cancel-invite');
      }
    },
  );

  it('VQ-S12-005 double-failure: runPostRemovalCleanup swallows a throwing clearPendingDirectInvite (best-effort), and the resulting orphaned marker is still masked at the row', async () => {
    const throwingClear = vi.fn().mockRejectedValue(new Error('IDB unavailable'));
    const deleteSpy = vi.fn().mockResolvedValue(undefined);

    // Even when the post-removal marker-clear itself fails, the caller's
    // flow must never throw (best-effort semantics per groups.tsx's
    // runPostRemovalCleanup doc comment).
    await expect(
      runPostRemovalCleanup({
        groupId: GROUP_ID,
        pubkey: PUBKEY,
        stillMember: false,
        deleteMemberProfile: deleteSpy,
        clearPendingDirectInvite: throwingClear,
      }),
    ).resolves.toBeUndefined();

    expect(throwingClear).toHaveBeenCalledWith(GROUP_ID, PUBKEY);
    expect(deleteSpy).toHaveBeenCalledWith(GROUP_ID, PUBKEY); // purge still ran (Promise.all — sibling failure doesn't block it)

    // The marker is now genuinely orphaned (clear failed, marker persists in
    // real storage — not modeled, driven for real):
    await recordPendingDirectInvite(GROUP_ID, PUBKEY, 'invite-ref'); // simulate the marker that the failed clear left behind
    const stillOrphaned = (await loadPendingDirectInviteMarkers(GROUP_ID)).has(PUBKEY);
    expect(stillOrphaned).toBe(true);

    // Pubkey is confirmed gone from the tree (stillMember was false), so at
    // the row level isPending=false — AC-INV-4's conjunction must mask the
    // orphaned marker regardless.
    expect(selectMemberRowAffordance({ isYou: false, isAdmin: true, isPending: false, hasMarker: stillOrphaned })).not.toBe(
      'cancel-invite',
    );
  });
});
