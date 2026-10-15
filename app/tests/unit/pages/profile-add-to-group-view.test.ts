/**
 * profile-add-to-group-view.test.ts — `addToGroupView`, exported from
 * `app/pages/profile.tsx` (BACKLOG profile-page-add-group-success-confirmation).
 *
 * The invite makes the contact a pending member, which empties the addable
 * list in the same render that sets the success state. The confirmation must
 * therefore not depend on the picker still having groups to offer — in the
 * common single-group case it was structurally unreachable. Pure function per
 * the repo's no-jsdom convention.
 */
import { describe, expect, it } from 'vitest';

import { addToGroupView, statusForViewedContact } from '@/pages/profile';

const base = { isBlocked: false, hasContact: true, addableCount: 1, status: 'idle' as const };

describe('addToGroupView', () => {
  it('shows the success confirmation after the only addable group was used up', () => {
    expect(addToGroupView({ ...base, addableCount: 0, status: 'success' })).toEqual({
      showPicker: false,
      showStatus: true,
    });
  });

  it('shows an error after an attempt even when nothing is addable any more', () => {
    expect(addToGroupView({ ...base, addableCount: 0, status: 'error' }).showStatus).toBe(true);
  });

  it('shows the picker while groups are addable, with no status before an attempt', () => {
    expect(addToGroupView(base)).toEqual({ showPicker: true, showStatus: false });
    expect(addToGroupView({ ...base, status: 'loading' }).showStatus).toBe(false);
  });

  it('shows nothing with no addable group and no attempt', () => {
    expect(addToGroupView({ ...base, addableCount: 0 })).toEqual({ showPicker: false, showStatus: false });
  });

  it.each([
    ['blocked', { isBlocked: true }],
    ['no contact record', { hasContact: false }],
  ])('shows neither picker nor status for a %s', (_label, override) => {
    expect(addToGroupView({ ...base, status: 'success', ...override })).toEqual({
      showPicker: false,
      showStatus: false,
    });
  });
});

describe('statusForViewedContact — no stale confirmation on another contact', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it.each(['success', 'error', 'loading'] as const)(
    'shows the %s status only on the contact the attempt was made for',
    (status) => {
      expect(statusForViewedContact({ pubkey: A, status }, A)).toBe(status);
      expect(statusForViewedContact({ pubkey: A, status }, B)).toBe('idle');
    },
  );

  it('is idle before any attempt and when no contact is viewed', () => {
    expect(statusForViewedContact({ pubkey: null, status: 'idle' }, A)).toBe('idle');
    expect(statusForViewedContact({ pubkey: A, status: 'success' }, null)).toBe('idle');
  });

  it('a stale success for A never makes the confirmation visible on B', () => {
    const status = statusForViewedContact({ pubkey: A, status: 'success' }, B);
    expect(addToGroupView({ isBlocked: false, hasContact: true, addableCount: 0, status }).showStatus).toBe(false);
  });
});
