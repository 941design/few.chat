/**
 * Unit tests for pendingDirectInviteStorage.ts — AC-MARKER-9, AC-MARKER-10.
 *
 * Runs against a real IDB-API surface (fake-indexeddb/auto), mirroring
 * profileRequestStorage.integration.test.ts's precedent for this template:
 * the storage module is exercised end-to-end (its own createStore call, its
 * own get/set/del/entries) — not mocked. A test that mocked idb-keyval's
 * get/set/del would only prove the mock was called, not that persistence
 * works (VQ-S1-004), and AC-MARKER-10 specifically requires a fresh-load
 * assertion that a module-level in-memory cache could falsely satisfy.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  markerKey,
  markPendingDirectInvite,
  clearPendingDirectInvite,
  loadPendingDirectInviteMarkers,
  clearPendingDirectInvitesForGroup,
  clearAllPendingDirectInvites,
  consumePendingDirectInviteMarker,
} from '@/src/lib/marmot/pendingDirectInviteStorage';

const GROUP_A = 'group-a';
const GROUP_B = 'group-b';
const ALICE = 'ab'.repeat(32);
const BOB = 'cd'.repeat(32);
const CAROL = 'ef'.repeat(32);

beforeEach(async () => {
  await clearAllPendingDirectInvites();
});

describe('pendingDirectInviteStorage — key shape', () => {
  it('markerKey formats as ${groupId}:${pubkey}', () => {
    expect(markerKey(GROUP_A, ALICE)).toBe(`${GROUP_A}:${ALICE}`);
  });

  it('markerKey canonicalizes the pubkey to lowercase (store-level casing invariant)', () => {
    // A write site handing a mixed/upper-case pubkey must produce the same key
    // as the canonical lowercase form, so a marker written at invite time (S7/S8)
    // always matches the clear keyed on the invitee's own signedEvent.pubkey
    // (lowercase) at profile arrival (S4). Without this, an un-lowercased write
    // site would orphan the marker (order-sensitive invariant #1).
    const upper = ALICE.toUpperCase();
    expect(markerKey(GROUP_A, upper)).toBe(`${GROUP_A}:${ALICE}`);
  });

  it('mark/load/clear are case-insensitive on the pubkey end-to-end', async () => {
    // Write under upper-case, read/clear under lower-case: they must agree.
    await markPendingDirectInvite(GROUP_A, ALICE.toUpperCase());
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set([ALICE]));

    await clearPendingDirectInvite(GROUP_A, ALICE); // lowercase clear
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
  });
});

describe('pendingDirectInviteStorage — mark then load (AC-MARKER-10 baseline)', () => {
  it('mark then load returns the pubkey for that group', async () => {
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());

    await markPendingDirectInvite(GROUP_A, ALICE);

    const markers = await loadPendingDirectInviteMarkers(GROUP_A);
    expect(markers).toEqual(new Set([ALICE]));
  });

  it('loadPendingDirectInviteMarkers returns a real Set<string>, not an array', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    const markers = await loadPendingDirectInviteMarkers(GROUP_A);
    expect(markers).toBeInstanceOf(Set);
  });

  it('persistence survives a fresh load call in a new async invocation (AC-MARKER-10)', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);

    // Simulate "member list reloaded" — a brand-new async call, not a
    // retained in-memory reference from the write above. If the store had a
    // module-level cache shadowing IDB, this would still pass without real
    // persistence; it does not, so this genuinely proves real IDB round-trip.
    const firstLoad = await loadPendingDirectInviteMarkers(GROUP_A);
    const secondLoad = await loadPendingDirectInviteMarkers(GROUP_A);

    expect(firstLoad).toEqual(new Set([ALICE]));
    expect(secondLoad).toEqual(new Set([ALICE]));
  });
});

describe('pendingDirectInviteStorage — per-key clear', () => {
  it('clears only the targeted key, leaving a sibling pubkey marker in the same group intact', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_A, BOB);

    await clearPendingDirectInvite(GROUP_A, ALICE);

    const markers = await loadPendingDirectInviteMarkers(GROUP_A);
    expect(markers).toEqual(new Set([BOB]));
  });

  it('is idempotent — clearing an absent or already-cleared key does not throw (VQ-S1-010)', async () => {
    await expect(clearPendingDirectInvite(GROUP_A, ALICE)).resolves.toBeUndefined();

    await markPendingDirectInvite(GROUP_A, ALICE);
    await clearPendingDirectInvite(GROUP_A, ALICE);

    // second clear on the now-cleared key
    await expect(clearPendingDirectInvite(GROUP_A, ALICE)).resolves.toBeUndefined();
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
  });
});

describe('pendingDirectInviteStorage — per-group clear (AC-MARKER-9 leave-fan-out half)', () => {
  it('removes every marker for one group across multiple pubkeys, leaving another group intact', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_A, BOB);
    await markPendingDirectInvite(GROUP_B, CAROL);

    await clearPendingDirectInvitesForGroup(GROUP_A);

    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
    expect(await loadPendingDirectInviteMarkers(GROUP_B)).toEqual(new Set([CAROL]));
  });

  it('never touches a different group even when pubkeys collide across groups', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_B, ALICE);

    await clearPendingDirectInvitesForGroup(GROUP_A);

    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
    expect(await loadPendingDirectInviteMarkers(GROUP_B)).toEqual(new Set([ALICE]));
  });

  it('does not over-match when one groupId is a string prefix of another (delimiter guarantee)', async () => {
    // The trailing ':' in the `${groupId}:` prefix is what keeps a group whose
    // id is a string prefix of another group's id ('g' vs 'g2') isolated. This
    // locks that guarantee so a future refactor that drops the delimiter fails
    // here rather than silently cross-clearing the S2/S3 fan-out seams.
    const gShort = 'g';
    const gLong = 'g2';
    await markPendingDirectInvite(gShort, ALICE);
    await markPendingDirectInvite(gLong, BOB);

    await clearPendingDirectInvitesForGroup(gShort);

    expect(await loadPendingDirectInviteMarkers(gShort)).toEqual(new Set());
    expect(await loadPendingDirectInviteMarkers(gLong)).toEqual(new Set([BOB]));
  });
});

describe('pendingDirectInviteStorage — consumePendingDirectInviteMarker (epic: group-invite-lifecycle S3 gate-remediation, severity-4)', () => {
  it('reports true and removes the marker when one existed', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);

    await expect(consumePendingDirectInviteMarker(GROUP_A, ALICE)).resolves.toBe(true);
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
  });

  it('reports false and is a no-op when no marker existed', async () => {
    await expect(consumePendingDirectInviteMarker(GROUP_A, ALICE)).resolves.toBe(false);
  });

  it('leaves a sibling pubkey marker in the same group untouched', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_A, BOB);

    await consumePendingDirectInviteMarker(GROUP_A, ALICE);

    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set([BOB]));
  });

  it('is case-insensitive on the pubkey end (mirrors mark/clear casing invariant)', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE.toUpperCase());

    await expect(consumePendingDirectInviteMarker(GROUP_A, ALICE)).resolves.toBe(true);
  });

  it('two concurrent consume calls for the SAME key resolve to exactly one true (TOCTOU-safety, against the real fake-indexeddb fixture)', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);

    // No await between the two calls — both are in flight together, exactly
    // the interleaved-dispatch scenario the severity-4 finding described.
    const [first, second] = await Promise.all([
      consumePendingDirectInviteMarker(GROUP_A, ALICE),
      consumePendingDirectInviteMarker(GROUP_A, ALICE),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
  });

  it('concurrent consume calls for DIFFERENT keys do not block each other — each still reports its own existence correctly', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    // BOB has no marker in GROUP_A.

    const [aliceResult, bobResult] = await Promise.all([
      consumePendingDirectInviteMarker(GROUP_A, ALICE),
      consumePendingDirectInviteMarker(GROUP_A, BOB),
    ]);

    expect(aliceResult).toBe(true);
    expect(bobResult).toBe(false);
  });
});

describe('pendingDirectInviteStorage — full clear (AC-MARKER-9 account-reset half)', () => {
  it('clearAllPendingDirectInvites removes every marker across every group', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_B, CAROL);

    await clearAllPendingDirectInvites();

    expect(await loadPendingDirectInviteMarkers(GROUP_A)).toEqual(new Set());
    expect(await loadPendingDirectInviteMarkers(GROUP_B)).toEqual(new Set());
  });

  it('is a distinct zero-arg export from the per-group clear (VQ-S1-007) — a group-scoped clear alone never wipes other groups', async () => {
    await markPendingDirectInvite(GROUP_A, ALICE);
    await markPendingDirectInvite(GROUP_B, CAROL);

    await clearPendingDirectInvitesForGroup(GROUP_A);

    // GROUP_B survives a per-group clear of GROUP_A — only the dedicated
    // full-clear export reaches every group.
    expect(await loadPendingDirectInviteMarkers(GROUP_B)).toEqual(new Set([CAROL]));
  });
});
