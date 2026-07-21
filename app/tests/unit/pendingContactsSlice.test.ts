/**
 * Unit tests for the `pendingContacts` unread-counter slice (epic:
 * pending-contact-notification, story S1 — `app/src/lib/unreadStore.ts`'s
 * `initPendingContactCounts` / `incrementPendingContact` /
 * `markPendingContactRead` / `clearPendingContact`, plus its fold-in to
 * `useUnreadCounts()`).
 *
 * Mocks `@/src/lib/contacts` so the slice's `readStoredContacts()`-derived
 * init runs against a controllable in-memory contact map (no localStorage /
 * jsdom needed). `react` is mocked so `useUnreadCounts()` (built on
 * `useSyncExternalStore`) can be read synchronously outside a component,
 * mirroring `inviteExpiries.test.ts` / `unreadStore.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type MockContact = {
  pubkeyHex: string;
  pendingConfirmationSince?: string | null;
  archivedAt?: string | null;
};

let mockStored: Record<string, MockContact> = {};

vi.mock('@/src/lib/contacts', () => ({
  readStoredContacts: () => mockStored,
  // Single-source predicate the module imports; deliberately ignores archivedAt
  // (matching the real one) so the slice's own not-archived combination is what
  // is under test.
  isPendingConfirmation: (pubkeyHex: string) =>
    Object.values(mockStored).some(
      (c) => c.pubkeyHex.toLowerCase() === pubkeyHex.toLowerCase() && Boolean(c.pendingConfirmationSince),
    ),
}));

vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
}));

const {
  initPendingContactCounts,
  incrementPendingContact,
  markPendingContactRead,
  clearPendingContact,
  useUnreadCounts,
} = await import('@/src/lib/unreadStore');

const A = 'AABBCC00'.toLowerCase();
const B = 'ddeeff11';
const C = '99887766';

function setStored(...contacts: MockContact[]) {
  mockStored = Object.fromEntries(contacts.map((c) => [c.pubkeyHex, c]));
}

describe('unreadStore — pendingContacts slice (S1)', () => {
  beforeEach(() => {
    mockStored = {};
    clearPendingContact(A);
    clearPendingContact(B);
    clearPendingContact(C);
    clearPendingContact('AABBCC00');
  });

  // AC-BELL-2: one entry per pending non-archived contact; an archived
  // (blocked) pending contact contributes nothing — block wins.
  describe('initPendingContactCounts — AC-BELL-2', () => {
    it('derives one entry per pending, non-archived contact and excludes archived pending (block wins)', async () => {
      setStored(
        { pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z', archivedAt: null },
        { pubkeyHex: B, pendingConfirmationSince: '2026-07-21T00:00:00Z', archivedAt: '2026-07-21T01:00:00Z' }, // pending AND blocked
        { pubkeyHex: C, pendingConfirmationSince: null, archivedAt: null }, // confirmed/normal
      );

      await initPendingContactCounts();

      const slice = useUnreadCounts().pendingContacts;
      expect(slice[A]).toBe(1);
      expect(slice[B]).toBeUndefined(); // archived pending excluded
      expect(slice[C]).toBeUndefined(); // not pending
    });

    it('keys by lowercase hex regardless of stored casing', async () => {
      setStored({ pubkeyHex: 'AABBCC00', pendingConfirmationSince: '2026-07-21T00:00:00Z', archivedAt: null });

      await initPendingContactCounts();

      expect(useUnreadCounts().pendingContacts['aabbcc00']).toBe(1);
    });

    it('produces an empty slice when there are no pending contacts', async () => {
      setStored({ pubkeyHex: C, pendingConfirmationSince: null });
      await initPendingContactCounts();
      expect(useUnreadCounts().pendingContacts).toEqual({});
    });

    // AC-LIFE-2 shape: re-deriving after a simulated reload reproduces the count.
    it('re-deriving after a simulated reload yields the same count', async () => {
      setStored({ pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z' });
      await initPendingContactCounts();
      const first = useUnreadCounts().pendingContacts[A];
      await initPendingContactCounts();
      const second = useUnreadCounts().pendingContacts[A];
      expect(first).toBe(1);
      expect(second).toBe(1);
    });
  });

  // AC-BELL-3: increment/mark/clear behave like join-request counterparts —
  // idempotent set/clear, no negative counts.
  describe('incrementPendingContact — AC-BELL-3', () => {
    it('sets the entry to 1 and is idempotent (never accumulates beyond 1)', () => {
      setStored({ pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z' });
      incrementPendingContact(A);
      expect(useUnreadCounts().pendingContacts[A]).toBe(1);
      incrementPendingContact(A);
      incrementPendingContact('AABBCC00'); // same peer, different casing
      expect(useUnreadCounts().pendingContacts[A]).toBe(1);
    });

    // Codex review fix / AC-BELL-2: a fresh pairing-ack `admitted` can re-fire
    // for an already-confirmed or archived contact; the increment must NOT ring
    // a non-actionable bell row for a contact that is not genuinely pending.
    it('is a no-op for a confirmed (non-pending) or archived contact (block wins)', () => {
      setStored(
        { pubkeyHex: A, pendingConfirmationSince: null }, // confirmed
        { pubkeyHex: B, pendingConfirmationSince: '2026-07-21T00:00:00Z', archivedAt: '2026-07-21T01:00:00Z' }, // pending+blocked
        { pubkeyHex: C }, // not even pending-tracked
      );
      incrementPendingContact(A);
      incrementPendingContact(B);
      incrementPendingContact(C);
      incrementPendingContact('deadbeef'); // no stored contact at all
      const slice = useUnreadCounts().pendingContacts;
      expect(slice[A]).toBeUndefined();
      expect(slice[B]).toBeUndefined();
      expect(slice[C]).toBeUndefined();
      expect(slice['deadbeef']).toBeUndefined();
    });
  });

  describe('markPendingContactRead / clearPendingContact — AC-BELL-3', () => {
    it('mark-read removes exactly the target entry, leaving others untouched', () => {
      setStored(
        { pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z' },
        { pubkeyHex: B, pendingConfirmationSince: '2026-07-21T00:00:00Z' },
      );
      incrementPendingContact(A);
      incrementPendingContact(B);

      markPendingContactRead(A);

      expect(useUnreadCounts().pendingContacts[A]).toBeUndefined();
      expect(useUnreadCounts().pendingContacts[B]).toBe(1);
    });

    it('clear removes the entry and is a no-op (no throw, no negative) when absent', () => {
      setStored({ pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z' });
      incrementPendingContact(A);
      clearPendingContact(A);
      expect(useUnreadCounts().pendingContacts[A]).toBeUndefined();
      expect(() => clearPendingContact('never-tracked')).not.toThrow();
      expect(useUnreadCounts().pendingContacts['never-tracked']).toBeUndefined();
    });
  });

  // AC-BELL-1: the slice sum is included in totalUnread.
  describe('useUnreadCounts — fold-in (AC-BELL-1)', () => {
    it('includes pendingContacts in totalUnread', () => {
      setStored(
        { pubkeyHex: A, pendingConfirmationSince: '2026-07-21T00:00:00Z' },
        { pubkeyHex: B, pendingConfirmationSince: '2026-07-21T00:00:00Z' },
      );
      const before = useUnreadCounts().totalUnread;
      incrementPendingContact(A);
      incrementPendingContact(B);
      const snapshot = useUnreadCounts();
      expect(snapshot.pendingContacts[A]).toBe(1);
      expect(snapshot.pendingContacts[B]).toBe(1);
      expect(snapshot.totalUnread).toBe(before + 2);
    });
  });
});
