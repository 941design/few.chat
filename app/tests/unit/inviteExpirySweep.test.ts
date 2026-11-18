/**
 * Unit tests for the client-side expiry sweep (epic: invite-link-lifecycle,
 * story S4 — `app/src/lib/marmot/inviteExpirySweep.ts`).
 *
 * Mocks `idb-keyval` with a single flat in-memory map, mirroring
 * `inviteLinkLifecycle.test.ts`'s convention (the invite-link store is
 * nonce-keyed, so a single Map is sufficient for entries/get/set/del) so
 * the REAL `inviteLinkStorage.ts` helpers run against it — this file never
 * duplicates inviteLinkStorage's own logic. `react`'s `useSyncExternalStore`
 * is mocked to just call `getSnapshot` (mirrors `unreadStore.test.ts`) so
 * `useUnreadCounts()` can be read synchronously outside a component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';

const idbStore = new Map<string, unknown>();
let failNextSet = false;

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-store'),
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    if (failNextSet) {
      failNextSet = false;
      throw new Error('simulated IDB write failure');
    }
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
  useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
}));

const inviteLinkStorage = await import('@/src/lib/marmot/inviteLinkStorage');
const { DAY_MS, saveInviteLink, getInviteLink } = inviteLinkStorage;
const { runInviteExpirySweep } = await import('@/src/lib/marmot/inviteExpirySweep');
const { useUnreadCounts, clearInviteExpiries } = await import('@/src/lib/unreadStore');

function makeLink(overrides: Partial<InviteLink> = {}): InviteLink {
  return {
    nonce: 'nonce-1',
    groupId: 'group-1',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + DAY_MS,
    usageCount: 0,
    expiryNotified: false,
    expiryAcknowledged: false,
    label: undefined,
    muted: false,
    ...overrides,
  };
}

describe('inviteExpirySweep — runInviteExpirySweep', () => {
  beforeEach(() => {
    idbStore.clear();
    failNextSet = false;
    clearInviteExpiries('group-1');
    clearInviteExpiries('group-2');
  });

  // AC-NOTIFY-2 (single-invocation half; the concurrent/StrictMode half is
  // AC-INV-1, tested separately below).
  it('notifies a freshly-expired, not-yet-notified link exactly once: stamps expiryNotified and bumps the group count', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);

    await runInviteExpirySweep(5_000);

    const persisted = await getInviteLink('n1');
    expect(persisted?.expiryNotified).toBe(true);
    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(1);
  });

  it('does not touch a link that is not yet expired at the given now', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);

    await runInviteExpirySweep(4_999);

    const persisted = await getInviteLink('n1');
    expect(persisted?.expiryNotified).toBe(false);
    expect(useUnreadCounts().inviteExpiries['group-1']).toBeUndefined();
  });

  // Migration-suppressed skip: a link migrateInviteLinks already stamped
  // expiryNotified=true (AC-MIGRATE-3/5) must never be re-processed by the
  // sweep — the sweep's job is "not-yet-notified expired links" only.
  it('skips a migration-suppressed link (expiryNotified already true)', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000, expiryNotified: true });
    await saveInviteLink(link);

    await runInviteExpirySweep(5_000);

    expect(useUnreadCounts().inviteExpiries['group-1']).toBeUndefined();
  });

  // VQ-S4-008's paired second half: a SECOND, sequential (non-overlapping)
  // sweep call against the same now-notified link must not double-count it.
  it('a second sequential sweep call against an already-notified link does not increment the count again', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);

    await runInviteExpirySweep(5_000);
    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(1);

    await runInviteExpirySweep(6_000); // later tick, same link, already notified
    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(1);
  });

  // AC-INV-1: concurrent/overlapping invocations (StrictMode double-effect,
  // overlapping interval ticks) must notify exactly once — enforced by the
  // module-level in-flight latch, not mere idempotence of the persisted flag.
  it('concurrent sweep invocations against the same expired, unnotified link notify exactly once', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);

    await Promise.all([
      runInviteExpirySweep(5_000),
      runInviteExpirySweep(5_000),
      runInviteExpirySweep(5_000),
      runInviteExpirySweep(5_000),
      runInviteExpirySweep(5_000),
    ]);

    const persisted = await getInviteLink('n1');
    expect(persisted?.expiryNotified).toBe(true);
    // Exactly one increment fired across all five overlapping calls — a
    // count of 0 or >1 fails the property (AC-INV-1's literal wording).
    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(1);
  });

  it('processes multiple expired links across multiple groups independently in a single pass', async () => {
    await saveInviteLink(makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 }));
    await saveInviteLink(makeLink({ nonce: 'n2', groupId: 'group-1', expiresAt: 5_000 }));
    await saveInviteLink(makeLink({ nonce: 'n3', groupId: 'group-2', expiresAt: 5_000 }));
    await saveInviteLink(makeLink({ nonce: 'n4', groupId: 'group-2', expiresAt: 9_000 })); // not yet expired

    await runInviteExpirySweep(5_000);

    expect(useUnreadCounts().inviteExpiries['group-1']).toBe(2);
    expect(useUnreadCounts().inviteExpiries['group-2']).toBe(1);
    expect((await getInviteLink('n4'))?.expiryNotified).toBe(false);
  });

  // AC-INV-4: the IDB stamp must be written no later than the in-memory
  // bump. Proven here by forcing the persist step to fail — if the
  // in-memory bump had already fired (wrong order), the count would be
  // non-zero even though the write never landed, which is exactly the
  // "shown-but-not-stamped" state the ordering exists to prevent.
  it('a failed persist write never leaves a phantom in-memory bump (stamp-before-increment ordering)', async () => {
    const link = makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 });
    await saveInviteLink(link);
    failNextSet = true;

    await runInviteExpirySweep(5_000);

    const persisted = await getInviteLink('n1');
    expect(persisted?.expiryNotified).toBe(false); // write failed, never landed
    expect(useUnreadCounts().inviteExpiries['group-1']).toBeUndefined(); // never bumped
  });

  it('a persist failure on one link does not abort the rest of the sweep pass', async () => {
    await saveInviteLink(makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 }));
    await saveInviteLink(makeLink({ nonce: 'n2', groupId: 'group-2', expiresAt: 5_000 }));
    // The failure is keyed to whichever `set` call happens first — n1's,
    // since loadAllInviteLinks preserves insertion order for a Map.
    failNextSet = true;

    await runInviteExpirySweep(5_000);

    expect((await getInviteLink('n1'))?.expiryNotified).toBe(false);
    expect((await getInviteLink('n2'))?.expiryNotified).toBe(true);
    expect(useUnreadCounts().inviteExpiries['group-2']).toBe(1);
  });

  // Gate-remediation (Codex round 6, Finding 1): if an expired link is deleted
  // between loadAllInviteLinks() and its stamp, markInviteLinkExpiryNotified
  // no-ops and returns false; the sweep must NOT bump the badge, or a phantom
  // unread expiry would linger for a link that no longer exists.
  it('does not bump the badge when the stamp no-ops (link deleted mid-sweep)', async () => {
    await saveInviteLink(makeLink({ nonce: 'n1', groupId: 'group-1', expiresAt: 5_000 }));
    // Simulate the link vanishing between the bulk read and the per-link stamp:
    // force markInviteLinkExpiryNotified to report "nothing persisted".
    const spy = vi
      .spyOn(inviteLinkStorage, 'markInviteLinkExpiryNotified')
      .mockResolvedValue(false);

    await runInviteExpirySweep(6_000);

    expect(spy).toHaveBeenCalledWith('n1', expect.any(Function));
    expect(useUnreadCounts().inviteExpiries['group-1']).toBeUndefined();
    spy.mockRestore();
  });
});
