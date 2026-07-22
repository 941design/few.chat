/**
 * profile-can-add-to-group.test.ts — unit tests for `canAddContactToGroup`,
 * exported from `app/pages/profile.tsx` (epic: pending-contact-profile-gate,
 * AC-PEND-6).
 *
 * This is the code-level enforcement behind the profile page's disabled
 * "Add to group" button for an unconfirmed contact: `handleAddToGroup`
 * early-returns when this guard is `false`, so even a bypassed click can never
 * invite a pending (or blocked, or absent) contact to a group.
 *
 * `profile.tsx` is a page component (Chakra/Next imports) — this repo has no
 * jsdom/@testing-library/renderHook precedent, so only the exported pure
 * function is exercised here (mirrors profile-add-to-group-marker.test.ts's
 * import style — `@/pages/profile` imports cleanly without mounting React).
 */
import { describe, expect, it } from 'vitest';

import { canAddContactToGroup } from '@/pages/profile';

/** Minimal contact shape the guard reads — only the two boolean axes matter. */
function contact(overrides: { isArchived?: boolean; isPendingConfirmation?: boolean } = {}) {
  return {
    isArchived: overrides.isArchived ?? false,
    isPendingConfirmation: overrides.isPendingConfirmation ?? false,
  };
}

describe('canAddContactToGroup', () => {
  it('allows a normal (confirmed, non-archived) contact', () => {
    expect(canAddContactToGroup(contact())).toBe(true);
  });

  it('refuses a pending (unconfirmed) contact — the AC-PEND-6 guarantee', () => {
    expect(canAddContactToGroup(contact({ isPendingConfirmation: true }))).toBe(false);
  });

  it('refuses an archived (blocked) contact', () => {
    expect(canAddContactToGroup(contact({ isArchived: true }))).toBe(false);
  });

  it('refuses a contact that is both pending and blocked', () => {
    expect(
      canAddContactToGroup(contact({ isArchived: true, isPendingConfirmation: true })),
    ).toBe(false);
  });

  it('refuses a null contact (no record)', () => {
    expect(canAddContactToGroup(null)).toBe(false);
  });
});
