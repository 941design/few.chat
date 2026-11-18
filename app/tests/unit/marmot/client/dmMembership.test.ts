import { expect, it, vi } from 'vitest';
import { isAllowedDmSender, selectDmMembership } from '@/src/lib/walledGarden';

it('uses the overlay in a waiting tab and the real roster while holding the lease', () => {
  const members = vi.fn(() => ['peer']);
  const overlay = [{ memberPubkeys: ['peer'] }];
  const live = [{ members }];
  const allowed = (leaseHeld: boolean) => isAllowedDmSender(
    'PEER', selectDmMembership(overlay, live, leaseHeld), new Set(), 'own',
  );
  expect(allowed(false)).toBe(true);
  expect(members).not.toHaveBeenCalled();
  expect(allowed(true)).toBe(true);
  members.mockReturnValue([]);
  expect(allowed(true)).toBe(false);
});
