import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';

const records = new Map<string, InviteLink>();
vi.mock('idb-keyval', () => ({
  createStore: () => 'links', get: async (key: string) => records.get(key),
  set: async (key: string, value: InviteLink) => { records.set(key, value); },
  del: async (key: string) => { records.delete(key); }, entries: async () => [...records.entries()],
  keys: async () => [...records.keys()], clear: async () => { records.clear(); },
}));
vi.mock('react', () => ({ useSyncExternalStore: (_s: unknown, get: () => unknown) => get() }));
const link = (nonce: string, ownerPubkey?: string, overrides: Partial<InviteLink> = {}): InviteLink => ({
  nonce, groupId: 'shared', ownerPubkey, createdAt: 1, expiresAt: 2, usageCount: 0,
  expiryNotified: false, expiryAcknowledged: false, muted: false, ...overrides,
});
beforeEach(() => { records.clear(); vi.resetModules(); });

describe('account-scoped invite expiry', () => {
  it('sweeps only the committed owner in a shared group, leaving ownerless records untouched', async () => {
    const s = await import('@/src/lib/marmot/inviteLinkStorage');
    const u = await import('@/src/lib/unreadStore');
    const { startInviteExpirySweep } = await import('@/src/lib/marmot/inviteExpirySweep');
    for (const row of [link('a', 'alice'), link('b', 'bob'), link('old')]) await s.saveInviteLink(row);
    u.scopeInviteExpiriesToOwner('alice', ['shared']);
    await startInviteExpirySweep({ now: () => 10, belongsToSession: () => true })();
    expect((await s.getInviteLink('a'))?.expiryNotified).toBe(true);
    expect((await s.getInviteLink('b'))?.expiryNotified).toBe(false);
    expect((await s.getInviteLink('old'))?.expiryNotified).toBe(false);
    expect(u.useUnreadCounts().inviteExpiries).toEqual({ shared: 1 });
    u.scopeInviteExpiriesToOwner('bob', ['shared']);
    await startInviteExpirySweep({ now: () => 10, belongsToSession: () => true })();
    expect((await s.getInviteLink('b'))?.expiryNotified).toBe(true);
    expect(u.useUnreadCounts().inviteExpiries).toEqual({ shared: 1 });
  });
  it('derives and acknowledges only the active owner and clears on reset', async () => {
    const s = await import('@/src/lib/marmot/inviteLinkStorage');
    const u = await import('@/src/lib/unreadStore');
    for (const row of [link('a', 'alice', { expiryNotified: true }), link('b', 'bob', { expiryNotified: true }), link('old', undefined, { expiryNotified: true })]) await s.saveInviteLink(row);
    u.scopeInviteExpiriesToOwner('alice', ['shared']);
    await u.initInviteExpiries(10);
    expect(u.useUnreadCounts().inviteExpiries).toEqual({ shared: 1 });
    await u.markInviteExpiriesRead('shared');
    expect((await s.getInviteLink('a'))?.expiryAcknowledged).toBe(true);
    expect((await s.getInviteLink('b'))?.expiryAcknowledged).toBe(false);
    expect((await s.getInviteLink('old'))?.expiryAcknowledged).toBe(false);
    u.scopeInviteExpiriesToOwner(null, []);
    await u.initInviteExpiries(10);
    expect(u.useUnreadCounts().inviteExpiries).toEqual({});
  });
  it('does not migrate without a scope or migrate records of another owner', async () => {
    const s = await import('@/src/lib/marmot/inviteLinkStorage');
    const u = await import('@/src/lib/unreadStore');
    const { startInviteExpirySweep } = await import('@/src/lib/marmot/inviteExpirySweep');
    const legacy = { ...link('b', 'bob'), expiresAt: undefined } as unknown as InviteLink;
    await s.saveInviteLink(legacy);
    await startInviteExpirySweep({ now: () => 100_000_000, belongsToSession: () => true })();
    expect(await s.getInviteLink('b')).toEqual(legacy);
    u.scopeInviteExpiriesToOwner('alice', ['shared']);
    await startInviteExpirySweep({ now: () => 100_000_000, belongsToSession: () => true })();
    expect(await s.getInviteLink('b')).toEqual(legacy);
  });
  it('invalidates old snapshots even when the same account reopens', async () => {
    const u = await import('@/src/lib/unreadStore');
    u.scopeInviteExpiriesToOwner('alice', ['shared']);
    const old = u.captureInviteExpiryScope()!;
    expect(old.accepts(link('a', 'alice'))).toBe(true);
    u.scopeInviteExpiriesToOwner(null, []);
    u.scopeInviteExpiriesToOwner('alice', ['shared']);
    expect(old.accepts(link('a', 'alice'))).toBe(false);
  });
});

it('persists an optional owner when building a new invitation record', async () => {
  const { buildNewInviteLink } = await import('@/src/lib/marmot/inviteLinkStorage');
  const input = { nonce: 'n', groupId: 'shared', createdAt: 1 };
  expect(buildNewInviteLink({ ...input, ownerPubkey: 'alice' }).ownerPubkey).toBe('alice');
  expect(buildNewInviteLink(input).ownerPubkey).toBeUndefined();
});
