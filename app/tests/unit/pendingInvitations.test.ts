/**
 * Unit tests for pendingInvitations.ts — covers all exported functions (AC-STRUCT-3).
 * Tests: caps, idempotency, persistence, empty-state, and observer notifications.
 * Runs without a browser or IDB — uses a synchronous localStorage mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPendingInvitations,
  enqueuePendingInvitation,
  removePendingInvitation,
  countPendingInvitations,
  pendingInvitationsForInviter,
  subscribe,
  getSnapshot,
} from '@/src/lib/pendingInvitations';
import type { PendingInvitation } from '@/src/lib/pendingInvitations';

// ─── localStorage mock ────────────────────────────────────────────────────────

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PENDING_KEY = 'lp_pendingInvitations_v1';

function makeInvite(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    inviterPubkeyHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    receivedAt: Date.now(),
    welcomeEventJson: '{"kind":444}',
    ...overrides,
  };
}

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB =   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  localStorageMock.clear();
});

afterEach(() => {
  localStorageMock.clear();
});

// ─── listPendingInvitations ───────────────────────────────────────────────────

describe('listPendingInvitations', () => {
  it('returns an empty array when localStorage is empty', () => {
    expect(listPendingInvitations()).toHaveLength(0);
  });

  it('returns stored invitations', () => {
    const inv = makeInvite();
    store[PENDING_KEY] = JSON.stringify([inv]);
    const result = listPendingInvitations();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(inv.id);
  });

  it('returns empty array on corrupt JSON', () => {
    store[PENDING_KEY] = 'not-json';
    expect(listPendingInvitations()).toHaveLength(0);
  });

  it('returns empty array on invalid array elements', () => {
    store[PENDING_KEY] = JSON.stringify([{ nope: true }]);
    expect(listPendingInvitations()).toHaveLength(0);
  });
});

// ─── enqueuePendingInvitation ─────────────────────────────────────────────────

describe('enqueuePendingInvitation', () => {
  it('adds a new invitation', () => {
    const inv = makeInvite();
    enqueuePendingInvitation(inv);
    expect(countPendingInvitations()).toBe(1);
  });

  it('is idempotent — re-adding the same id does not duplicate', () => {
    const inv = makeInvite({ id: 'fixed-id' });
    enqueuePendingInvitation(inv);
    enqueuePendingInvitation(inv);
    expect(countPendingInvitations()).toBe(1);
  });

  it('persists to localStorage (AC-INVITE-9)', () => {
    const inv = makeInvite({ id: 'persist-id' });
    enqueuePendingInvitation(inv);
    const raw = store[PENDING_KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('persist-id');
    expect(typeof parsed[0].inviterPubkeyHex).toBe('string');
    expect(typeof parsed[0].receivedAt).toBe('number');
    expect(typeof parsed[0].welcomeEventJson).toBe('string');
  });

  it('enforces per-inviter cap of 8 (AC-INVITE-3)', () => {
    // Add 9 invitations from the same inviter
    for (let i = 0; i < 9; i++) {
      enqueuePendingInvitation(makeInvite({ id: `per-inv-${i}`, inviterPubkeyHex: ALICE, receivedAt: i }));
    }
    // Should have dropped the oldest one, leaving 8
    expect(pendingInvitationsForInviter(ALICE)).toBe(8);
    expect(countPendingInvitations()).toBe(8);
  });

  it('enforces global cap of 256 (AC-INVITE-3)', () => {
    // Fill from different inviters to avoid per-inviter cap
    const inviters = Array.from({ length: 32 }, (_, i) => `${'a'.repeat(63)}${i.toString(16).padStart(1, '0')}`);
    for (let i = 0; i < 257; i++) {
      enqueuePendingInvitation(makeInvite({
        id: `global-${i}`,
        inviterPubkeyHex: inviters[Math.floor(i / 8)] ?? ALICE,
        receivedAt: i,
      }));
    }
    expect(countPendingInvitations()).toBeLessThanOrEqual(256);
  });

  it('drops oldest per-inviter entry on per-inviter overflow', () => {
    for (let i = 0; i < 8; i++) {
      enqueuePendingInvitation(makeInvite({ id: `alice-${i}`, inviterPubkeyHex: ALICE, receivedAt: i + 1 }));
    }
    // Now add a 9th — oldest (receivedAt=1, id=alice-0) should be dropped
    enqueuePendingInvitation(makeInvite({ id: 'alice-8', inviterPubkeyHex: ALICE, receivedAt: 9 }));
    const result = listPendingInvitations();
    expect(result.find((inv) => inv.id === 'alice-0')).toBeUndefined();
    expect(result.find((inv) => inv.id === 'alice-8')).toBeDefined();
    expect(pendingInvitationsForInviter(ALICE)).toBe(8);
  });

  it('emits to listeners (subscribe/getSnapshot reactivity)', () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    const inv = makeInvite({ id: 'notify-test' });
    enqueuePendingInvitation(inv);
    expect(listener).toHaveBeenCalledTimes(1);
    // getSnapshot should reflect the update
    const snapshot = getSnapshot();
    expect(snapshot.find((i) => i.id === 'notify-test')).toBeDefined();
    unsub();
  });
});

// ─── removePendingInvitation ──────────────────────────────────────────────────

describe('removePendingInvitation', () => {
  it('removes an existing invitation', () => {
    const inv = makeInvite({ id: 'remove-me' });
    enqueuePendingInvitation(inv);
    removePendingInvitation('remove-me');
    expect(countPendingInvitations()).toBe(0);
  });

  it('is idempotent when id does not exist', () => {
    expect(() => removePendingInvitation('nonexistent')).not.toThrow();
  });

  it('does not remove other invitations', () => {
    const inv1 = makeInvite({ id: 'keep' });
    const inv2 = makeInvite({ id: 'remove' });
    enqueuePendingInvitation(inv1);
    enqueuePendingInvitation(inv2);
    removePendingInvitation('remove');
    expect(countPendingInvitations()).toBe(1);
    expect(listPendingInvitations()[0].id).toBe('keep');
  });

  it('emits to listeners after removal', () => {
    const inv = makeInvite({ id: 'rm-notify' });
    enqueuePendingInvitation(inv);
    const listener = vi.fn();
    const unsub = subscribe(listener);
    removePendingInvitation('rm-notify');
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});

// ─── countPendingInvitations ──────────────────────────────────────────────────

describe('countPendingInvitations', () => {
  it('returns 0 when empty', () => {
    expect(countPendingInvitations()).toBe(0);
  });

  it('returns the correct count after multiple enqueues', () => {
    enqueuePendingInvitation(makeInvite({ id: 'c1' }));
    enqueuePendingInvitation(makeInvite({ id: 'c2' }));
    expect(countPendingInvitations()).toBe(2);
  });
});

// ─── pendingInvitationsForInviter ─────────────────────────────────────────────

describe('pendingInvitationsForInviter', () => {
  it('returns 0 when no invitations from that inviter', () => {
    expect(pendingInvitationsForInviter(ALICE)).toBe(0);
  });

  it('counts only invitations from the specified inviter', () => {
    enqueuePendingInvitation(makeInvite({ id: 'a1', inviterPubkeyHex: ALICE }));
    enqueuePendingInvitation(makeInvite({ id: 'a2', inviterPubkeyHex: ALICE }));
    enqueuePendingInvitation(makeInvite({ id: 'b1', inviterPubkeyHex: BOB }));
    expect(pendingInvitationsForInviter(ALICE)).toBe(2);
    expect(pendingInvitationsForInviter(BOB)).toBe(1);
  });
});

// ─── localStorage persistence (AC-INVITE-9) ──────────────────────────────────

describe('localStorage persistence (AC-INVITE-9)', () => {
  it('survives a simulated page reload — data present in localStorage after write', () => {
    const inv = makeInvite({ id: 'reload-persist' });
    enqueuePendingInvitation(inv);

    // Simulate page reload: the raw localStorage still holds the data,
    // and listPendingInvitations() reads fresh from it each call.
    const raw = store[PENDING_KEY];
    const parsed: PendingInvitation[] = JSON.parse(raw);
    expect(parsed.find((i) => i.id === 'reload-persist')).toBeDefined();
    expect(typeof parsed[0].inviterPubkeyHex).toBe('string');
    expect(typeof parsed[0].receivedAt).toBe('number');
    expect(typeof parsed[0].welcomeEventJson).toBe('string');
  });
});

// ─── AC-INVITE-3: global cap is enforced when all inviters are distinct ───────
//
// The existing global-cap test uses a distribution where per-inviter drops
// prevent the queue from ever reaching 256, so the global-cap drop path
// (find-oldest-globally + remove) is never exercised. This block uses
// strictly distinct inviters (one invite each) to bypass per-inviter caps
// and force the global-cap branch to fire.

describe('enqueuePendingInvitation — global cap (AC-INVITE-3, distinct-inviter path)', () => {
  it('enforces global cap when each invite comes from a unique inviter (cap branch is exercised)', () => {
    // Build 256 distinct inviter pubkeys (each contributes exactly 1 invite).
    // At invite 257 the queue is already at 256, so the global-cap branch fires.
    const distinctInviters = Array.from(
      { length: 257 },
      (_, i) => i.toString(16).padStart(64, '0'),
    );

    for (let i = 0; i < 257; i++) {
      enqueuePendingInvitation(
        makeInvite({ id: `distinct-${i}`, inviterPubkeyHex: distinctInviters[i], receivedAt: i }),
      );
    }

    // The hard cap MUST hold: at most 256 entries remain.
    expect(countPendingInvitations()).toBeLessThanOrEqual(256);
  });

  it('drops the globally oldest entry (lowest receivedAt) when global cap fires', () => {
    // Fill 256 slots from unique inviters, oldest has receivedAt=0 (id 'gc-0').
    const distinctInviters = Array.from(
      { length: 257 },
      (_, i) => i.toString(16).padStart(64, '0'),
    );
    for (let i = 0; i < 256; i++) {
      enqueuePendingInvitation(
        makeInvite({ id: `gc-${i}`, inviterPubkeyHex: distinctInviters[i], receivedAt: i }),
      );
    }
    // Adding the 257th triggers the global drop: the oldest (receivedAt=0) must go.
    enqueuePendingInvitation(
      makeInvite({ id: 'gc-256', inviterPubkeyHex: distinctInviters[256], receivedAt: 256 }),
    );

    const result = listPendingInvitations();
    expect(result.find((inv) => inv.id === 'gc-0')).toBeUndefined();  // oldest dropped
    expect(result.find((inv) => inv.id === 'gc-256')).toBeDefined();  // newest kept
    // Exactly 256: one was dropped, one was added. All others must be preserved.
    expect(result.length).toBe(256);
  });
});

// ─── AC-REACT-6: subscribe unsubscribe contract ───────────────────────────────
//
// Verifies that unsubscribing actually removes the listener — i.e. that
// emits after unsub do not call the detached listener. The existing tests
// only check that a listener IS called; they do not re-emit after unsub.

describe('subscribe — unsubscribe stops future notifications (AC-REACT-6)', () => {
  it('unsubscribed listener is not called on subsequent mutations', () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);

    // First mutation should call the listener.
    enqueuePendingInvitation(makeInvite({ id: 'pre-unsub' }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe.
    unsub();

    // Second mutation must NOT call the detached listener.
    enqueuePendingInvitation(makeInvite({ id: 'post-unsub' }));
    expect(listener).toHaveBeenCalledTimes(1);  // still 1, not 2
  });
});

// ─── S5: groupId / authenticated fields (epic-group-invite-lifecycle) ─────
//
// AC-DECLINE-1: groupId persists and round-trips. AC-DECLINE-2: authenticated
// persists and round-trips for BOTH true and false. Plus backward-compat
// normalization for entries stored before these two fields existed.

describe('groupId / authenticated fields — persistence (AC-DECLINE-1, AC-DECLINE-2)', () => {
  it('AC-DECLINE-1: enqueuePendingInvitation with groupId set persists it and round-trips via listPendingInvitations()', () => {
    const inv = makeInvite({ id: 'groupid-1', groupId: 'hex-group-abc123', authenticated: true });
    enqueuePendingInvitation(inv);
    const result = listPendingInvitations();
    expect(result.find((i) => i.id === 'groupid-1')?.groupId).toBe('hex-group-abc123');
  });

  it('AC-DECLINE-2: authenticated:true round-trips as true (not coerced to false)', () => {
    const inv = makeInvite({ id: 'auth-true-1', groupId: 'g1', authenticated: true });
    enqueuePendingInvitation(inv);
    const result = listPendingInvitations();
    expect(result.find((i) => i.id === 'auth-true-1')?.authenticated).toBe(true);
  });

  it('AC-DECLINE-2: authenticated:false round-trips as false (not coerced to true)', () => {
    const inv = makeInvite({ id: 'auth-false-1', groupId: 'g2', authenticated: false });
    enqueuePendingInvitation(inv);
    const result = listPendingInvitations();
    expect(result.find((i) => i.id === 'auth-false-1')?.authenticated).toBe(false);
  });
});

describe('groupId / authenticated fields — backward compatibility', () => {
  it('a raw stored entry missing groupId/authenticated entirely reads back with groupId:\'\' and authenticated:false (not undefined, not thrown)', () => {
    // Written directly to the mocked localStorage store, bypassing
    // enqueuePendingInvitation, to simulate a pre-migration record.
    store[PENDING_KEY] = JSON.stringify([
      {
        id: 'legacy-no-fields',
        inviterPubkeyHex: ALICE,
        receivedAt: 100,
        welcomeEventJson: '{"kind":444}',
        // groupId and authenticated are entirely absent
      },
    ]);

    expect(() => listPendingInvitations()).not.toThrow();
    const result = listPendingInvitations();
    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('');
    expect(result[0].authenticated).toBe(false);
  });

  it('a raw stored entry with authenticated as a non-boolean (string) normalizes to false', () => {
    store[PENDING_KEY] = JSON.stringify([
      {
        id: 'legacy-string-authenticated',
        inviterPubkeyHex: ALICE,
        receivedAt: 100,
        welcomeEventJson: '{"kind":444}',
        groupId: 'some-group',
        authenticated: 'true', // wrong type — must not be treated as truthy
      },
    ]);

    const result = listPendingInvitations();
    expect(result).toHaveLength(1);
    expect(result[0].authenticated).toBe(false);
    // groupId itself is a correctly-typed string and is preserved as-is.
    expect(result[0].groupId).toBe('some-group');
  });
});
