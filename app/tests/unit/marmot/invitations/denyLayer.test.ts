/**
 * AC-BLK-1 (unit): the DenyLayer predicate over the real lib/blockedPeers.ts block set (contacts store), and the
 * pending view's behaviour for a blocked sponsor: not shown, no arrival (no bell), decline(id,{declineRumor:false}).
 * A non-blocked sender is processed normally.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PendingInvitation } from '@941design/marmot';
import { archiveContact, rememberContact } from '@/src/lib/contacts';
import { loadBlockedPeers } from '@/src/lib/blockedPeers';
import { createDenyLayer, createPendingInvitationView, createInvitationActions } from '@/src/lib/marmot/invitations';

const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  },
  writable: true,
});

const BLOCKED = 'ab'.repeat(32);
const FRIEND = 'cd'.repeat(32);
const inv = (id: string, sponsor: string, receivedAt = 1): PendingInvitation => ({
  id, groupId: `g-${id}`, sponsorAccount: sponsor, sponsors: [sponsor], keyPackageRef: `kp-${id}`, receivedAt,
});

beforeEach(() => {
  localStorage.clear();
  rememberContact(BLOCKED, '2021-01-01T00:00:00.000Z');
  rememberContact(FRIEND, '2021-01-01T00:00:00.000Z');
  archiveContact(BLOCKED);
});

describe('DenyLayer predicate', () => {
  it('blocks exactly the archived contacts, any case; empty and unknown pubkeys are not blocked', () => {
    const deny = createDenyLayer({ loadBlockedPeers });
    expect(deny.isBlocked(BLOCKED)).toBe(true);
    expect(deny.isBlocked(BLOCKED.toUpperCase())).toBe(true);
    expect(deny.isBlocked(FRIEND)).toBe(false);
    expect(deny.isBlocked('')).toBe(false);
    expect(deny.isBlocked('ef'.repeat(32))).toBe(false);
  });

  it('reads the block set on every call: a block placed after construction applies at once', () => {
    const deny = createDenyLayer({ loadBlockedPeers });
    expect(deny.isBlocked(FRIEND)).toBe(false);
    archiveContact(FRIEND);
    expect(deny.isBlocked(FRIEND)).toBe(true);
  });

  it('a missing loader fails loudly at construction', () => {
    expect(() => createDenyLayer({} as never)).toThrow(/loadBlockedPeers/);
    expect(() => createDenyLayer(undefined as never)).toThrow();
  });
});

describe('AC-BLK-1: pending view with a blocked sponsor', () => {
  function setup(list: PendingInvitation[]) {
    const calls: Array<{ id: string; options?: { declineRumor?: boolean } }> = [];
    const live = [...list];
    const api = {
      pending: async () => live.filter((i) => !calls.some((c) => c.id === i.id)),
      decline: async (id: string, options?: { readonly declineRumor?: boolean }) => void calls.push({ id, options }),
    };
    const view = createPendingInvitationView({
      invitations: api,
      denyLayer: createDenyLayer({ loadBlockedPeers }),
      isTrustedSponsor: () => false,
      now: () => 100,
      enqueue: (j) => void j(),
      onError: (e) => { throw e; },
    });
    return { view, calls, live };
  }

  it('the blocked invitation is not shown, never announced, and declined with declineRumor:false; the friend is processed normally', async () => {
    const { view, calls, live } = setup([inv('seed', FRIEND, 1)]);
    await view.refresh();
    const arrivals: string[] = [];
    view.onArrival((i) => arrivals.push(i.id));
    live.push(inv('from-blocked', BLOCKED, 2), inv('from-friend', FRIEND, 3));
    await view.refresh();
    expect(view.pending().map((i) => i.id)).toEqual(['seed', 'from-friend']);
    expect(arrivals).toEqual(['from-friend']);
    expect(calls).toEqual([{ id: 'from-blocked', options: { declineRumor: false } }]);
    expect(view.isVisible('from-blocked')).toBe(false);
  });

  it('a sponsor listed only in `sponsors` is checked too', async () => {
    const odd: PendingInvitation = { ...inv('x', FRIEND), sponsors: [FRIEND, BLOCKED] };
    const { view, calls } = setup([odd]);
    expect(await view.refresh()).toEqual([]);
    expect(calls[0].options).toEqual({ declineRumor: false });
  });

  it('a failed decline keeps the entry hidden and is retried on the next refresh', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const attempts: string[] = [];
    const view = createPendingInvitationView({
      invitations: {
        pending: async () => [inv('b', BLOCKED)],
        decline: async (id) => { attempts.push(id); if (fail) throw new Error('boom'); },
      },
      denyLayer: createDenyLayer({ loadBlockedPeers }),
      isTrustedSponsor: () => false,
      now: () => 100,
      enqueue: (j) => void j(),
      onError: (e) => errors.push(e),
    });
    expect(await view.refresh()).toEqual([]);
    expect(errors).toHaveLength(1);
    fail = false;
    expect(await view.refresh()).toEqual([]);
    expect(attempts).toEqual(['b', 'b']);
  });

  it('accept refuses an invitation the view hides (blocked) without reaching the library', async () => {
    const { view } = setup([inv('b', BLOCKED)]);
    let accepted = 0;
    const actions = createInvitationActions({
      invitations: { pending: async () => [], decline: async () => undefined, accept: async () => { accepted++; return {} as never; } },
      view,
      attachGroup: () => undefined,
    });
    await expect(actions.accept('b')).rejects.toMatchObject({ code: 'unknown-invitation' });
    expect(accepted).toBe(0);
  });
});
