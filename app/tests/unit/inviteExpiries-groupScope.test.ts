/**
 * Invite-expiry counters are scoped to the loaded groups list (BACKLOG
 * stale-foreign-group-invite-expiry-count).
 *
 * An invite-expiry count for a group that is not in the user's groups list
 * (e.g. expired links restored from a backup of a group the user is no longer
 * in) has no card to clear it from, yet it fed the Groups nav total forever.
 * `scopeInviteExpiriesToGroups` — called by MarmotContext's `reloadGroups`
 * once a groups list has actually loaded — drops such counters and keeps the
 * periodic re-derive / live bump from re-adding them. Counters only: the
 * invite-link records themselves are never modified. Before the first scope
 * call (groups still loading) nothing is pruned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  entries: vi.fn(async () => [...idbStore.entries()]),
  clear: vi.fn(async () => {
    idbStore.clear();
  }),
}));

vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

async function freshModules() {
  vi.resetModules();
  const storage = await import('@/src/lib/marmot/inviteLinkStorage');
  const unread = await import('@/src/lib/unreadStore');
  return { ...storage, ...unread };
}

function expiredNotified(nonce: string, groupId: string): InviteLink {
  return {
    nonce,
    groupId,
    createdAt: 1_000,
    expiresAt: 5_000,
    usageCount: 0,
    expiryNotified: true,
    expiryAcknowledged: false,
    label: undefined,
    muted: false,
  };
}

const NOW = 10_000;

describe('scopeInviteExpiriesToGroups', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  it('never prunes before a groups list has loaded (no scope yet): every group counts', async () => {
    const m = await freshModules();
    await m.saveInviteLink(expiredNotified('a', 'mine'));
    await m.saveInviteLink(expiredNotified('b', 'foreign'));
    await m.initInviteExpiries(NOW);
    expect(m.useUnreadCounts().inviteExpiries).toEqual({ mine: 1, foreign: 1 });
    m.incrementInviteExpiry('other');
    expect(m.useUnreadCounts().inviteExpiries.other).toBe(1);
  });

  it('drops counters for groups absent from the loaded list, keeping present ones', async () => {
    const m = await freshModules();
    await m.saveInviteLink(expiredNotified('a', 'mine'));
    await m.saveInviteLink(expiredNotified('b', 'foreign'));
    await m.initInviteExpiries(NOW);

    m.scopeInviteExpiriesToGroups(['mine']);

    expect(m.useUnreadCounts().inviteExpiries).toEqual({ mine: 1 });
  });

  it('keeps the periodic re-derive and the live bump from re-adding an absent group', async () => {
    const m = await freshModules();
    await m.saveInviteLink(expiredNotified('a', 'mine'));
    await m.saveInviteLink(expiredNotified('b', 'foreign'));
    m.scopeInviteExpiriesToGroups(['mine']);

    await m.initInviteExpiries(NOW);
    m.incrementInviteExpiry('foreign');
    m.incrementInviteExpiry('mine');

    expect(m.useUnreadCounts().inviteExpiries).toEqual({ mine: 2 });
  });

  it('counts a group again once it is in the loaded list (scope follows the latest load)', async () => {
    const m = await freshModules();
    await m.saveInviteLink(expiredNotified('b', 'later'));
    m.scopeInviteExpiriesToGroups([]);
    await m.initInviteExpiries(NOW);
    expect(m.useUnreadCounts().inviteExpiries).toEqual({});

    m.scopeInviteExpiriesToGroups(['later']);
    await m.initInviteExpiries(NOW);
    expect(m.useUnreadCounts().inviteExpiries).toEqual({ later: 1 });
  });

  it('touches only counters — the invite-link records are left exactly as stored', async () => {
    const m = await freshModules();
    const link = expiredNotified('b', 'foreign');
    await m.saveInviteLink(link);
    await m.initInviteExpiries(NOW);

    m.scopeInviteExpiriesToGroups(['mine']);
    await m.initInviteExpiries(NOW);

    expect(await m.getInviteLink('b')).toEqual(link);
  });

  it('is idempotent', async () => {
    const m = await freshModules();
    await m.saveInviteLink(expiredNotified('a', 'mine'));
    await m.saveInviteLink(expiredNotified('b', 'foreign'));
    await m.initInviteExpiries(NOW);
    m.scopeInviteExpiriesToGroups(['mine']);
    const first = m.useUnreadCounts().inviteExpiries;
    m.scopeInviteExpiriesToGroups(['mine']);
    expect(m.useUnreadCounts().inviteExpiries).toEqual(first);
  });
});

describe('MarmotContext wiring (source assertion — no jsdom in this repo)', () => {
  const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const SOURCE = fs.readFileSync(path.join(APP_ROOT, 'src', 'context', 'MarmotContext.tsx'), 'utf8');

  it('reloadGroups scopes invite-expiry counters only after the groups list has loaded', () => {
    expect(SOURCE).toMatch(
      /const reloadGroups = useCallback\(async \(\) => \{\s*const loaded = await loadAllGroups\(\);\s*setGroups\(loaded\);[\s\S]*?scopeInviteExpiriesToGroups\(loaded\.map\(\(g\) => g\.id\)\);/,
    );
  });
});
