// @vitest-environment node
import 'fake-indexeddb/auto';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createDeclineDurability } from '@/src/lib/marmot/invitations';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import { clearAllPendingDirectInvites, getPendingDirectInviteMarker, pendingDirectInviteMarkerStore, recordPendingDirectInvite } from '@/src/lib/marmot/pendingDirectInviteStorage';

it('AC-OBS-4: persisted declines survive offline startups and failed removals', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 0, max: 5}), fc.integer({min: 0, max: 5}), async (offline, failures) => {
    await clearAllPendingDirectInvites();
    const groupId = 'aa'.repeat(32), pubkey = 'bb'.repeat(32), ref = 'ref';
    let online = false, remaining = failures, member = true, removed = false;
    const announcements: string[] = [];
    const group = { id: groupId, synced: async () => {}, leaves: () => member ? [{leafIndex: 0, leafKey: 'leaf'}] : [], removeMember: async () => { if (remaining-- > 0) throw new Error('offline'); member = false; removed = true; } };
    const jobs: Array<() => Promise<void>> = [];
    const make = () => createDeclineDurability({ store: pendingDirectInviteMarkerStore, getGroup: async () => online ? group as never : undefined, queue: createGroupOpQueue(), enqueue: (job) => { jobs.push(job); }, announce: async (_g, content) => { expect(removed).toBe(true); announcements.push(content); }, retryDelaysMs: [], onError: () => {} });
    await recordPendingDirectInvite(groupId, pubkey, ref, 'leaf');
    const first = make();
    first.onWelcomeDeclined({ groupId, inviteeRef: ref });
    expect(jobs).toHaveLength(1);
    await jobs.shift()!();
    await first.idle();
    first.dispose();
    expect((await getPendingDirectInviteMarker(groupId, pubkey))?.declined).toBe(true);
    for (let i = 0; i < offline; i++) { const d = make(); await d.retryDeclined(); d.dispose(); expect((await getPendingDirectInviteMarker(groupId, pubkey))?.declined).toBe(true); expect(announcements).toEqual([]); }
    online = true;
    for (let i = 0; i < failures; i++) { const d = make(); await d.retryDeclined(); d.dispose(); expect((await getPendingDirectInviteMarker(groupId, pubkey))?.declined).toBe(true); expect(announcements).toEqual([]); }
    const d = make(); await d.retryDeclined(); expect(member).toBe(false); expect(announcements).toHaveLength(1); expect(await getPendingDirectInviteMarker(groupId, pubkey)).toBeUndefined(); await d.retryDeclined(); expect(announcements).toHaveLength(1); d.dispose();
  }), {seed: 190605, numRuns: 200 });
}, 30000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

it('AC-OBS-4: overlapping replays join a decline while sync or removal is pending', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 5 }), async (blockSync, replays) => {
    await clearAllPendingDirectInvites();
    const groupId = 'aa'.repeat(32), pubkey = 'bb'.repeat(32), ref = 'overlap';
    const entered = gate(), release = gate();
    let member = true, removes = 0, resolved = false;
    const sent: string[] = [], jobs: Array<() => Promise<void>> = [];
    const group = {
      id: groupId,
      synced: async () => { if (blockSync) { entered.resolve(); await release.promise; } },
      leaves: () => member ? [{ leafIndex: 0, leafKey: 'leaf' }] : [],
      removeMember: async (account: string) => {
        expect(account).toBe(pubkey);
        removes++;
        if (!blockSync) { entered.resolve(); await release.promise; }
        member = false;
        resolved = true;
      },
    };
    const d = createDeclineDurability({
      store: pendingDirectInviteMarkerStore, getGroup: async () => group as never,
      queue: createGroupOpQueue(), enqueue: (job) => { jobs.push(job); }, retryDelaysMs: [],
      announce: async (_group, content) => {
        expect(resolved).toBe(true);
        expect((await getPendingDirectInviteMarker(groupId, pubkey))?.phase).toBe('announce-pending');
        sent.push(content);
      },
    });
    try {
      await recordPendingDirectInvite(groupId, pubkey, ref, 'leaf');
      d.onWelcomeDeclined({ groupId, inviteeRef: ref });
      await jobs.shift()!();
      await entered.promise;
      for (let i = 0; i < replays; i++) {
        d.replayMarker(groupId, pubkey);
        await jobs.shift()!();
      }
      expect((await getPendingDirectInviteMarker(groupId, pubkey))?.declined).toBe(true);
      expect(removes).toBe(blockSync ? 0 : 1);
      expect(sent).toEqual([]);
      release.resolve();
      await d.idle();
      expect(member).toBe(false);
      expect(removes).toBe(1);
      expect(sent.map((content) => JSON.parse(content))).toEqual([
        { type: 'invite_lifecycle', event: 'declined', pubkey, id: `${groupId}:${ref}` },
      ]);
      expect(await getPendingDirectInviteMarker(groupId, pubkey)).toBeUndefined();
      expect(await d.retryDeclined()).toEqual([]);
    } finally {
      release.resolve();
      d.dispose();
      await d.idle();
    }
  }), { seed: 190606, numRuns: 200 });
}, 30000);

it('AC-OBS-4: interruption during sync or after send recovers from the persisted marker', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (interruptSync) => {
    await clearAllPendingDirectInvites();
    const groupId = 'aa'.repeat(32), pubkey = 'bb'.repeat(32), ref = 'restart';
    const entered = gate(), release = gate();
    let member = true, removes = 0, removed = false;
    const sent: string[] = [], jobs: Array<() => Promise<void>> = [];
    const group = {
      id: groupId,
      synced: async () => { if (interruptSync) { entered.resolve(); await release.promise; } },
      leaves: () => member ? [{ leafIndex: 0, leafKey: 'leaf' }] : [],
      removeMember: async () => { removes++; member = false; removed = true; },
    };
    const make = (failClear: boolean) => createDeclineDurability({
      store: failClear ? { ...pendingDirectInviteMarkerStore, clearAnnouncement: async () => { throw new Error('interrupted before clear'); } } : pendingDirectInviteMarkerStore,
      getGroup: async () => group as never, queue: createGroupOpQueue(),
      enqueue: (job) => { jobs.push(job); }, retryDelaysMs: [], onError: () => {},
      announce: async (_group, content) => {
        expect(removed).toBe(true);
        expect((await getPendingDirectInviteMarker(groupId, pubkey))?.phase).toBe('announce-pending');
        sent.push(content);
      },
    });
    const first = make(!interruptSync);
    try {
      await recordPendingDirectInvite(groupId, pubkey, ref, 'leaf');
      first.onWelcomeDeclined({ groupId, inviteeRef: ref });
      await jobs.shift()!();
      if (interruptSync) {
        await entered.promise;
        first.dispose();
      }
      await first.idle();
      expect((await getPendingDirectInviteMarker(groupId, pubkey))?.declined).toBe(true);
      expect(removes).toBe(interruptSync ? 0 : 1);
      expect(sent).toHaveLength(interruptSync ? 0 : 1);
      first.dispose();
      release.resolve();
      const restarted = make(false);
      try {
        expect(await restarted.retryDeclined()).toEqual(['removed']);
        expect(removes).toBe(1);
        expect(member).toBe(false);
        expect(sent).toHaveLength(interruptSync ? 1 : 2);
        expect(new Set(sent).size).toBe(1);
        expect(JSON.parse(sent[0]).id).toBe(`${groupId}:${ref}`);
        expect(await getPendingDirectInviteMarker(groupId, pubkey)).toBeUndefined();
        expect(await restarted.retryDeclined()).toEqual([]);
      } finally {
        restarted.dispose();
      }
    } finally {
      release.resolve();
      first.dispose();
      await first.idle();
    }
  }), { seed: 190607, numRuns: 20 });
}, 30000);
