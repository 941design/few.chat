// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { cancelInvitation } from '@/src/lib/marmot/membership';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import {
  clearAllPendingDirectInvites,
  pendingDirectInviteMarkerStore,
  recordPendingDirectInvite,
} from '@/src/lib/marmot/pendingDirectInviteStorage';

afterEach(() => clearAllPendingDirectInvites());

it.each([
  { phase: 'success', calls: 1, ref: undefined, refreshes: 1 },
  { phase: 'replaced while syncing', calls: 0, ref: 'new', refreshes: 1 },
  { phase: 'replaced while removing', calls: 1, ref: 'new', refreshes: 1 },
  { phase: 'remove failed', calls: 1, ref: 'old', refreshes: 0 },
  { phase: 'clear failed', calls: 1, ref: 'old', refreshes: 1 },
])('cancels a specific invitation when $phase', async ({ phase, calls, ref, refreshes }) => {
  const id = 'admin-ops';
  const account = 'ab'.repeat(32);
  const markers = { ...pendingDirectInviteMarkerStore };
  const readMarker = () => markers.get(id, account);
  await recordPendingDirectInvite(id, account, 'old');

  const failure = new Error(phase);
  const synced = vi.fn(async () => {
    if (phase === 'replaced while syncing') await recordPendingDirectInvite(id, account, 'new');
  });
  const removeMember = vi.fn(async () => {
    expect(synced).toHaveBeenCalledTimes(1);
    expect((await readMarker())?.inviteeRef).toBe('old');
    if (phase === 'replaced while removing') await recordPendingDirectInvite(id, account, 'new');
    if (phase === 'remove failed') throw failure;
  });
  if (phase === 'clear failed') markers.clearIfRef = vi.fn().mockRejectedValue(failure);
  const refresh = vi.fn();
  const action = cancelInvitation(createGroupOpQueue(), { id, synced, removeMember }, { account, inviteeRef: 'old' }, markers, refresh);
  if (phase.endsWith('failed')) await expect(action).rejects.toBe(failure);
  else await action;

  expect(removeMember.mock.calls).toEqual(calls ? [[account]] : []);
  expect((await readMarker())?.inviteeRef).toBe(ref);
  expect(refresh.mock.calls).toEqual(refreshes ? [[id]] : []);
});
