// @vitest-environment node
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { buildInvitationCardViewModels, CONTEXT_TTL_MS, createDenyLayer, createInviteContextHandler, createInviteContextStore, HELD_PER_SENDER_CAP, HELD_TOTAL_CAP, createInvitationActions, createPendingInvitationView, withInviteContextCleanup } from '@/src/lib/marmot/invitations';
import { hex, inv, memoryPort, rumor } from '../invitations/inviteContext.fixtures';
import { noPurge } from '../invitations/noPurge';

it('AC-OBS-3: invitation context follows an independent event history', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('pending', 'sponsor', 'replacement', 'other', 'redelivery', 'accept', 'decline', 'expiry', 'restart'), { minLength: 1, maxLength: 30 }), async (ops) => {
    let now = 1_000;
    let inbox: ReturnType<typeof inv>[] = [];
    const invitation = inv('1', 1, 'ab');
    const mem = memoryPort();
    const invitations = {
      pending: async () => [...inbox],
      accept: async () => { inbox = []; return {} as never; },
      decline: async () => { inbox = []; },
    };
    const view = createPendingInvitationView({ invitations, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }), enqueue: () => {}, isTrustedSponsor: () => true, now: () => now });
    const make = () => createInviteContextStore({ port: mem.port, now: () => now, getPending: () => view.pending() });
    let store = make();
    let handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }) });
    const actions = () => withInviteContextCleanup({ actions: createInvitationActions({ invitations, view, attachGroup: () => {}, purge: noPurge }), view, store });
    const events = {
      sponsor: rumor({ id: 'sponsor', pubkey: hex(1), groupId: 'ab', name: 'Club' }),
      replacement: rumor({ id: 'replacement', pubkey: hex(1), groupId: 'ab', name: 'Renamed Club' }),
      other: rumor({ id: 'other', pubkey: hex(2), groupId: 'ab', name: 'Phish' }),
    };
    // This oracle tracks accepted arrivals and departures, without reading the store.
    let pending = false;
    const held = new Map<string, boolean>();
    const deleted = new Set<string>();
    for (const op of ops) {
      if (op === 'pending') {
        inbox = [invitation]; pending = true;
        await view.refresh(); await store.reconcile(view.pending());
        if (held.delete('other')) deleted.add('other');
        for (const id of held.keys()) held.set(id, true);
      } else if (op === 'sponsor' || op === 'replacement' || op === 'other' || op === 'redelivery') {
        const id = op === 'redelivery' ? 'sponsor' : op;
        await handler(events[id], {} as never);
        if (!held.has(id) && !deleted.has(id)) {
          if (pending && id === 'other') {
            deleted.add(id);
          } else {
            const previous = id === 'sponsor' ? 'replacement' : 'sponsor';
            if (id !== 'other' && held.delete(previous)) deleted.add(previous);
            held.set(id, pending);
          }
        }
      } else if ((op === 'accept' || op === 'decline') && pending) {
        await actions()[op]('1'); pending = false;
        for (const id of held.keys()) deleted.add(id);
        held.clear();
      } else if (op === 'expiry') {
        now += CONTEXT_TTL_MS + 1;
        await store.reconcile(view.pending());
        deleted.clear();
        for (const id of held.keys()) deleted.add(id);
        held.clear();
      } else if (op === 'restart') {
        store = make(); await store.load();
        handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }) });
      }
      expect(store.snapshot().map(r => [r.rumorId, r.matched]).sort()).toEqual([...held].sort());
      const cards = buildInvitationCardViewModels(view.pending(), store.snapshot(), 'Invitation', now);
      const sponsorName = held.has('replacement') ? 'Renamed Club' : held.has('sponsor') ? 'Club' : 'Invitation';
      expect(cards.map(c => c.displayName)).toEqual(pending ? [sponsorName] : []);
    }
  }), { seed: 190603, numRuns: 200 });
});

it('AC-OBS-3: held contexts respect both caps under pressure', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.integer({min: 1, max: 16}), fc.integer({min: 0, max: 1000})), {minLength: 70, maxLength: 100}), async (entries) => {
    const store = createInviteContextStore({ port: memoryPort().port, now: () => 1, getPending: () => [] });
    for (let i = 0; i < entries.length; i++) await store.add({ rumorId: String(i), sender: hex(entries[i][0]), groupId: `g${entries[i][1]}`, name: 'Club' });
    const rows = store.snapshot();
    expect(rows.length).toBeLessThanOrEqual(64);
    for (const sender of new Set(rows.map(r => r.sender))) expect(rows.filter(r => r.sender === sender).length).toBeLessThanOrEqual(8);
  }), { seed: 190604, numRuns: 200 });
});

it('AC-OBS-3: repeated pending and context notifications accept a matching outbound request at most once', async () => {
  const { createAutoAccept, createPendingInvitationView, createInvitationActions } = await import('@/src/lib/marmot/invitations');
  const { noPurge } = await import('../invitations/noPurge');
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('pending', 'context', 'restart'), {minLength: 1, maxLength: 20}), async ops => {
    let list = [inv('1', 1, 'ab')];
    const accountPubkey = hex(9);
    let record: { accountPubkey: string; nonce: string; adminPubkeyHex: string; groupName: string; sentAt: number; claimedInvitationId?: string } | undefined =
      { accountPubkey, nonce: 'n', adminPubkeyHex: hex(1), groupName: 'Club', sentAt: 1 };
    let known = false, accepts = 0;
    const jobs: Array<() => Promise<void>> = [];
    const enqueue = (job: () => Promise<void>) => { jobs.push(job); };
    const invitations = { pending: async () => [...list], decline: async () => {}, accept: async () => { accepts++; list = []; return {} as never; } };
    const view = createPendingInvitationView({ invitations, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }), enqueue, isTrustedSponsor: () => false, now: () => 1000 });
    const actions = createInvitationActions({ invitations, view, attachGroup: () => {}, purge: noPurge });
    const make = () => createAutoAccept({
      accountPubkey, assertLease: () => {}, now: () => 1000, view, actions, enqueue, purge: noPurge,
      outbound: {
        loadUnexpiredForAdmin: async (owner) => record?.accountPubkey === owner ? [record] : [],
        claim: async (owner, candidate, id) => {
          if (record !== candidate || record.accountPubkey !== owner || (record.claimedInvitationId && record.claimedInvitationId !== id)) return { kind: 'unavailable' };
          if (record.claimedInvitationId === id) return { kind: 'existing' };
          record = { ...record, claimedInvitationId: id };
          return { kind: 'acquired', token: id };
        },
        releaseClaim: async () => false,
        consume: async (owner, _candidate, id) => { if (record?.accountPubkey === owner && record.claimedInvitationId === id) record = undefined; },
      },
      groupNameOf: () => known ? 'Club' : undefined,
    });
    let auto = make();
    for (const op of ops) {
      if (op === 'restart') { auto.dispose(); auto = make(); }
      else if (op === 'pending') auto.onInboxDisposition({ kind: 'pending' });
      else { known = true; auto.evaluate(); }
      while (jobs.length) await jobs.shift()!();
      expect(accepts).toBeLessThanOrEqual(1);
    }
    auto.dispose();
  }), { seed: 190608, numRuns: 200 });
});
