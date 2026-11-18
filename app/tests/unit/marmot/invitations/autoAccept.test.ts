// @vitest-environment node
/**
 * Unit tests for the auto-accept correlation (S12): AC-AUTO-1 (match on sponsor + group, accept exactly once outside the
 * listener frame, consume the request; no match stays pending with zero accepts) and the carried-over AC-AUTO rules
 * (name disambiguation, one record per invitation).
 *
 * The pending view is the REAL `createPendingInvitationView` over a fake library list, and the accept goes through the REAL
 * `createInvitationActions`, so "only an invitation the view shows can be accepted" (a blocked sponsor) is exercised, not
 * stubbed.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { PendingInvitation } from '@941design/marmot';
import {
  createAutoAccept,
  type OutboundRequestRef,
} from '@/src/lib/marmot/invitations/autoAccept';
import { createDenyLayer, createInvitationActions, createPendingInvitationView } from '@/src/lib/marmot/invitations';
import {
  cancelOutboundJoinRequest,
  claimOutboundJoinRequest,
  clearAllOutboundJoinRequests,
  consumeOutboundJoinRequestClaim,
  getSnapshot,
  loadUnexpiredOutboundJoinRequestsForAdmin,
  OUTBOUND_JOIN_REQUEST_TTL_MS,
  releaseOutboundJoinRequestClaim,
  saveOutboundJoinRequest,
} from '@/src/lib/marmot/outboundJoinRequests';
import { noPurge } from './noPurge';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const ADMIN = hex(1);
const OTHER = hex(2);
const ACCOUNT = hex(3);
const SENT_AT = Date.now();

const inv = (id: string, sponsor: string, groupId = `g-${id}`): PendingInvitation => ({
  id, groupId, sponsorAccount: sponsor, sponsors: [sponsor], keyPackageRef: `kp-${id}`, receivedAt: SENT_AT,
});
const rec = (nonce: string, admin: string, groupName: string): OutboundRequestRef => ({
  accountPubkey: ACCOUNT, nonce, adminPubkeyHex: admin, groupName, sentAt: SENT_AT,
});

type OutboundPort = Parameters<typeof createAutoAccept>[0]['outbound'];

function setup(opts: {
  list?: PendingInvitation[];
  records?: OutboundRequestRef[];
  names?: Record<string, string>;
  blocked?: string[];
  acceptFails?: boolean;
  consumeFails?: boolean;
  purge?: Partial<typeof noPurge>;
  outbound?: OutboundPort;
  assertLease?: () => void;
  now?: () => number;
} = {}) {
  let list = [...(opts.list ?? [])];
  let records = [...(opts.records ?? [])];
  const jobs: Array<() => Promise<void>> = [];
  const accepts: string[] = [];
  const consumed: string[] = [];
  const errors: unknown[] = [];
  const invitations = {
    pending: async () => [...list],
    decline: async () => undefined,
    accept: vi.fn(async (id: string) => {
      accepts.push(id);
      if (opts.acceptFails) throw new Error('accept failed');
      list = list.filter((i) => i.id !== id);
      return { id } as never;
    }),
  };
  const blocked = new Set(opts.blocked ?? []);
  const enqueue = (job: () => Promise<void>) => void jobs.push(job);
  const view = createPendingInvitationView({
    invitations,
    denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }),
    enqueue,
    isTrustedSponsor: () => false,
    now: Date.now,
    onError: (e) => void errors.push(e),
  });
  const purge = { ...noPurge, ...opts.purge };
  const actions = createInvitationActions({ invitations, view, attachGroup: () => undefined, purge, onError: (e) => void errors.push(e) });
  const loadUnexpiredForAdmin = vi.fn(async (account: string, admin: string) =>
    records.filter((r) => r.accountPubkey === account && r.adminPubkeyHex === admin));
  const auto = createAutoAccept({
    accountPubkey: ACCOUNT,
    assertLease: opts.assertLease ?? (() => undefined),
    now: opts.now,
    view,
    actions,
    enqueue,
    outbound: opts.outbound ?? {
      loadUnexpiredForAdmin,
      claim: async (_account, record, id) => {
        const index = records.indexOf(record);
        if (index < 0) return { kind: 'unavailable' };
        if (record.claimedInvitationId !== undefined) {
          return { kind: record.claimedInvitationId === id ? 'existing' : 'unavailable' };
        }
        records[index] = { ...record, claimedInvitationId: id };
        return { kind: 'acquired', token: 'test-acquisition' };
      },
      releaseClaim: async () => false,
      consume: async (_account, { nonce }, id) => {
        if (opts.consumeFails) throw new Error('idb down');
        consumed.push(nonce);
        records = records.filter((r) => r.nonce !== nonce || r.claimedInvitationId !== id);
      },
    },
    groupNameOf: (i) => opts.names?.[i.groupId],
    purge,
    onError: (e) => void errors.push(e),
  });
  const runJobs = async () => {
    while (jobs.length) await jobs.shift()!();
  };
  const addInvitation = (i: PendingInvitation) => { list = [...list, i]; };
  return { auto, view, actions, jobs, runJobs, accepts, consumed, errors, invitations, loadUnexpiredForAdmin, addInvitation, getRecords: () => records };
}

describe('AC-AUTO-1: correlation on inboxDisposition pending', () => {
  it('a matching invitation is accepted exactly once, outside the listener frame, and the request is consumed', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    // frame-safe: nothing ran in the listener's frame, only a job was enqueued
    expect(t.accepts).toEqual([]);
    expect(t.loadUnexpiredForAdmin).not.toHaveBeenCalled();
    expect(t.jobs).toHaveLength(1);
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n1']);
    expect(t.errors).toEqual([]);
  });

  it('a second matching event does not call accept again (the invitation id is remembered even when the record and the list entry are still there)', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' }, consumeFails: true });
    // the library list keeps showing the invitation after accept (a lagging read)
    t.invitations.accept.mockImplementation(async (id: string) => { t.accepts.push(id); return { id } as never; });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.getRecords()).toHaveLength(1); // the record was never consumed, yet no second accept
  });

  it('after a successful accept the second matching event finds no record and no invitation: zero further accepts', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n1']);
  });

  it('a request of another admin never matches: the invitation stays pending with zero accept calls', async () => {
    const t = setup({ list: [inv('i1', OTHER)], records: [rec('n1', ADMIN, 'Club')] });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.consumed).toEqual([]);
    expect((await t.invitations.pending()).map((i) => i.id)).toEqual(['i1']);
  });

  it('no outbound request at all (expired ones are not returned by the store): stays pending', async () => {
    const t = setup({ list: [inv('i1', ADMIN)], records: [] });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
  });

  it('a different group of the same sponsor stays pending when its name is known and differs (the record is kept)', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'other-group')], records: [rec('n1', ADMIN, 'Club')], names: { 'other-group': 'Chess' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.getRecords().map((r) => r.nonce)).toEqual(['n1']);
  });

  it('the name is compared after the invite-context normalisation (case and spacing of the link name do not matter beyond it)', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Book​  Club')], names: { gx: 'Book Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
  });

  it('a known name picks the one matching record among several of the same admin', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Chess'), rec('n2', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n2']);
    expect(t.getRecords().map((r) => r.nonce)).toEqual(['n1']);
  });

  it('a known name matching several records is ambiguous: never guesses', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club'), rec('n2', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
  });

  it('consent: an invitation whose claimed name is unknown is NEVER auto-accepted (even with a single record); it stays a manual card', async () => {
    const t = setup({ list: [inv('i1', ADMIN)], records: [rec('n1', ADMIN, 'Club')] });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.consumed).toEqual([]);
    expect(t.getRecords().map((r) => r.nonce)).toEqual(['n1']);
    expect((await t.view.refresh()).map((i) => i.id)).toEqual(['i1']);
  });

  it('invitation first, context later: a matching name accepts exactly once and consumes the record', async () => {
    const names: Record<string, string> = {};
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    names.gx = 'Club';
    t.auto.evaluate();
    await t.runJobs();
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n1']);
  });

  it('invitation first, context later: a DIFFERENT name never accepts and keeps the outbound record', async () => {
    const names: Record<string, string> = {};
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    names.gx = 'Totally Different';
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.getRecords().map((r) => r.nonce)).toEqual(['n1']);
  });

  it('an unknown name with several records stays pending until the name is known, then the matching one accepts', async () => {
    const names: Record<string, string> = {};
    const many = setup({ list: [inv('i2', ADMIN, 'gy')], records: [rec('n1', ADMIN, 'Chess'), rec('n2', ADMIN, 'Club')], names });
    many.auto.onInboxDisposition({ kind: 'pending' });
    await many.runJobs();
    expect(many.accepts).toEqual([]);
    // the context arrives later: evaluate() re-runs the correlation without a new event
    names.gy = 'Club';
    many.auto.evaluate();
    await many.runJobs();
    expect(many.accepts).toEqual(['i2']);
    expect(many.consumed).toEqual(['n2']);
  });

  it('one record answers one invitation: two invitations of the same admin and name consume the record once', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'ga'), inv('i2', ADMIN, 'gb')], records: [rec('n1', ADMIN, 'Club')], names: { ga: 'Club', gb: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n1']);
  });

  it('a blocked sponsor\'s invitation is never auto-accepted: a block beats a correlation', async () => {
    const t = setup({ list: [inv('i1', ADMIN)], records: [rec('n1', ADMIN, 'Club')], blocked: [ADMIN] });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.consumed).toEqual([]);
  });

  it('a failed accept keeps the record, is reported, is not remembered (a later event may retry) and the invitation stays pending', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' }, acceptFails: true });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual([]);
    expect(t.getRecords()).toHaveLength(1);
    expect(t.errors.length).toBeGreaterThan(0);
    t.errors.length = 0;
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1', 'i1']);
  });

  it('dispose resets the queued flag: idle() settles even though the queued job never ran, and that job later does nothing', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.evaluate();
    expect(t.jobs).toHaveLength(1);
    t.auto.dispose();
    const settled = await Promise.race([t.auto.idle().then(() => 'idle'), new Promise((r) => setTimeout(() => r('hung'), 200))]);
    expect(settled).toBe('idle');
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(t.jobs).toHaveLength(0); // no refresh scheduled after dispose
  });

  it('only the pending disposition triggers it', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    for (const kind of ['joined', 'already-member', 'rejected', 'deferred', 'no-matching-keypackage']) t.auto.onInboxDisposition({ kind });
    expect(t.jobs).toHaveLength(0);
  });

  it('collapses events while a job is queued (one job, one accept)', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    t.auto.onInboxDisposition({ kind: 'pending' });
    t.auto.evaluate();
    expect(t.jobs).toHaveLength(1);
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
  });

  it('the job\'s last action refreshes the pending view (scheduleRefresh enqueues one more job)', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club' } });
    t.auto.onInboxDisposition({ kind: 'pending' });
    const first = t.jobs.shift()!;
    await first();
    expect(t.jobs).toHaveLength(1); // the view's refresh job
    const before = t.accepts.length;
    await t.runJobs();
    expect(t.accepts.length).toBe(before);
  });

  it('a non-accepting queue (disposed) neither wedges nor throws; a later event can enqueue again', () => {
    let accept = false;
    const calls: number[] = [];
    const auto = createAutoAccept({
      accountPubkey: ACCOUNT,
      assertLease: () => undefined,
      view: { refresh: async () => [], scheduleRefresh: () => undefined },
      actions: { accept: async () => ({}) as never },
      enqueue: () => { calls.push(1); return accept; },
      outbound: {
        loadUnexpiredForAdmin: async () => [],
        claim: async () => ({ kind: 'unavailable' }),
        releaseClaim: async () => false,
        consume: async () => undefined,
      },
      groupNameOf: () => undefined,
      purge: noPurge,
    });
    auto.onInboxDisposition({ kind: 'pending' });
    auto.onInboxDisposition({ kind: 'pending' });
    expect(calls).toHaveLength(2); // the first rejection reset the collapse flag
    accept = true;
  });

  it('a throwing outbound store is reported and never blocks the pending fallback', async () => {
    const errors: unknown[] = [];
    const t = setup({ list: [inv('i1', ADMIN)] });
    const auto = createAutoAccept({
      accountPubkey: ACCOUNT,
      assertLease: () => undefined,
      view: t.view,
      actions: createInvitationActions({ invitations: t.invitations, view: t.view, attachGroup: () => undefined, purge: noPurge }),
      enqueue: (job) => void t.jobs.push(job),
      outbound: {
        loadUnexpiredForAdmin: async () => { throw new Error('idb down'); },
        claim: async () => ({ kind: 'unavailable' }),
        releaseClaim: async () => false,
        consume: async () => undefined,
      },
      groupNameOf: () => undefined,
      purge: noPurge,
      onError: (e) => void errors.push(e),
    });
    auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['idb down']);
  });
});

describe('durable outbound consent over IndexedDB', () => {
  const original = inv('i1', ADMIN, 'gx');
  const other = inv('i2', ADMIN, 'gy');
  const outbound = {
    loadUnexpiredForAdmin: loadUnexpiredOutboundJoinRequestsForAdmin,
    claim: claimOutboundJoinRequest,
    releaseClaim: releaseOutboundJoinRequestClaim,
    consume: consumeOutboundJoinRequestClaim,
  };
  const options = { names: { gx: 'Club', gy: 'Club' }, outbound };

  it('isolates same-nonce consent, legacy cancellation, and targeted reset by account', async () => {
    await clearAllOutboundJoinRequests();
    const { accountPubkey: _, ...legacy } = rec('same-nonce', ADMIN, 'Club');
    const first = { ...legacy, accountPubkey: ACCOUNT };
    const second = { ...legacy, accountPubkey: OTHER };
    await saveOutboundJoinRequest(legacy);
    await saveOutboundJoinRequest(second);
    expect(getSnapshot()).toEqual([legacy, second]);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
    const t = setup({ ...options, list: [original] });
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual([]);

    await saveOutboundJoinRequest(first);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([first]);
    expect(await outbound.loadUnexpiredForAdmin(OTHER, ADMIN)).toEqual([second]);
    expect(await outbound.claim(OTHER, first, original.id)).toEqual({ kind: 'unavailable' });
    expect(await outbound.claim(ACCOUNT, first, original.id)).toMatchObject({ kind: 'acquired' });
    expect(await outbound.claim(OTHER, second, other.id)).toMatchObject({ kind: 'acquired' });
    await outbound.consume(OTHER, first, original.id);

    await cancelOutboundJoinRequest(legacy.nonce);
    expect(await loadUnexpiredOutboundJoinRequestsForAdmin(ADMIN)).toEqual([]);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([{ ...first, claimedInvitationId: original.id }]);
    await saveOutboundJoinRequest(legacy);
    await clearAllOutboundJoinRequests(ACCOUNT);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
    expect(await loadUnexpiredOutboundJoinRequestsForAdmin(ADMIN)).toEqual([legacy]);

    await saveOutboundJoinRequest(first);
    await cancelOutboundJoinRequest(first.nonce, ACCOUNT);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
    await clearAllOutboundJoinRequests(ACCOUNT, true);
    expect(await loadUnexpiredOutboundJoinRequestsForAdmin(ADMIN)).toEqual([]);
    expect(getSnapshot()).toMatchObject([{ ...second }]);
    expect(await outbound.loadUnexpiredForAdmin(OTHER, ADMIN)).toEqual([{ ...second, claimedInvitationId: other.id }]);
  });

  it('leaves a Welcome received before the request pending and accepts a later one', async () => {
    await clearAllOutboundJoinRequests();
    const record = rec('newer-send', ADMIN, 'Club');
    await saveOutboundJoinRequest(record);
    const old = { ...original, receivedAt: record.sentAt - 1 };
    const t = setup({ ...options, list: [old, other] });
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual([other.id]);
    expect(await t.view.refresh()).toEqual([old]);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
  });

  it.each(['canceled', 'replaced', 'ambiguous', 'lease lost'] as const)(
    'rechecks eligibility inside the group lock when consent is %s',
    async (change) => {
      await clearAllOutboundJoinRequests();
      const record = rec('waiting-for-lock', ADMIN, 'Club');
      await saveOutboundJoinRequest(record);
      let leaseHeld = true;
      const t = setup({
        ...options,
        list: [original],
        assertLease: () => { if (!leaseHeld) throw new Error('lease lost'); },
        purge: {
          withGroupLock: async (_groupId, join) => {
            switch (change) {
              case 'canceled': await cancelOutboundJoinRequest(record.nonce, ACCOUNT); break;
              case 'replaced': await saveOutboundJoinRequest({ ...record, sentAt: record.sentAt - 1 }); break;
              case 'ambiguous': await saveOutboundJoinRequest({ ...record, nonce: 'second-request' }); break;
              case 'lease lost': leaseHeld = false; break;
            }
            return join();
          },
        },
      });
      t.auto.evaluate();
      await t.runJobs();
      expect(t.accepts).toEqual([]);
      expect(await t.view.refresh()).toEqual([original]);
      const unclaimed = await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN);
      expect(unclaimed.some((candidate) => candidate.claimedInvitationId !== undefined)).toBe(false);
    },
  );

  it('rejects consent that reaches the exact TTL boundary while its claim commits', async () => {
    await clearAllOutboundJoinRequests();
    const record = rec('expires-during-claim', ADMIN, 'Club');
    await saveOutboundJoinRequest(record);
    let now = record.sentAt + OUTBOUND_JOIN_REQUEST_TTL_MS - 1;
    const t = setup({
      ...options,
      list: [original],
      now: () => now,
      outbound: {
        ...outbound,
        claim: async (...args) => {
          const claimed = await outbound.claim(...args);
          now += 1;
          return claimed;
        },
      },
    });
    t.auto.evaluate();
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(await t.view.refresh()).toEqual([original]);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([record]);
  });

  it.each(['name changed', 'disposed', 'lease lost', 'existing claim'] as const)(
    'uses the acquisition and the lease to decide whether to release after a final veto (%s)',
    async (change) => {
      await clearAllOutboundJoinRequests();
      const record = rec('vetoed-after-claim', ADMIN, 'Club');
      await saveOutboundJoinRequest(record);
      if (change === 'existing claim') {
        expect(await outbound.claim(ACCOUNT, record, original.id)).toMatchObject({ kind: 'acquired' });
      }
      const names = { ...options.names };
      let leaseHeld = true;
      const releaseClaim = vi.fn(outbound.releaseClaim);
      const t = setup({
        ...options,
        names,
        list: [original],
        assertLease: () => { if (!leaseHeld) throw new Error('lease lost'); },
        outbound: {
          ...outbound,
          claim: async (...args) => {
            const result = await outbound.claim(...args);
            if (change === 'lease lost') leaseHeld = false;
            else if (change === 'disposed') t.auto.dispose();
            else names.gx = 'Chess';
            return result;
          },
          releaseClaim,
        },
      });
      t.auto.evaluate();
      await t.runJobs();
      expect(t.accepts).toEqual([]);
      const preserved = change === 'lease lost' || change === 'existing claim';
      expect(releaseClaim).toHaveBeenCalledTimes(preserved ? 0 : 1);
      expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([
        preserved ? { ...record, claimedInvitationId: original.id } : record,
      ]);
      if (change === 'lease lost') {
        expect(t.errors).toContainEqual(expect.objectContaining({
          message: expect.stringContaining('Could not release'),
          cause: expect.objectContaining({ message: 'lease lost' }),
        }));
      }
    },
  );

  it.each([
    { failure: 'accept', deleteAttempts: 0, errors: 1 },
    { failure: 'transient delete', deleteAttempts: 2, errors: 1 },
    { failure: 'persistent delete', deleteAttempts: 2, errors: 2 },
    { failure: 'lease loss after failed delete', deleteAttempts: 1, errors: 2 },
  ])('handles $failure without reusing consent', async ({ failure, deleteAttempts, errors }) => {
    await clearAllOutboundJoinRequests();
    const record = rec('durable', ADMIN, 'Club');
    await saveOutboundJoinRequest(record);
    const snapshot = getSnapshot();
    let leaseHeld = true;
    const first = setup({
      ...options,
      list: [original],
      acceptFails: failure === 'accept',
      assertLease: () => { if (!leaseHeld) throw new Error('lease lost'); },
    });
    const accept = first.invitations.accept.getMockImplementation()!;
    first.invitations.accept.mockImplementation(async (id) => {
      expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([{ ...record, claimedInvitationId: id }]);
      expect(getSnapshot()).toBe(snapshot);
      return accept(id);
    });
    const deleteRow = IDBObjectStore.prototype.delete;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete');
    function abortDelete(this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = deleteRow.call(this, key);
      this.transaction.abort();
      if (failure === 'lease loss after failed delete') leaseHeld = false;
      return request;
    }
    if (failure === 'persistent delete') {
      deleteSpy.mockImplementation(abortDelete);
    } else if (failure !== 'accept') {
      deleteSpy.mockImplementationOnce(abortDelete);
    }
    try {
      first.auto.evaluate();
      await first.runJobs();
      expect(first.accepts).toEqual(['i1']);
      expect(deleteSpy).toHaveBeenCalledTimes(deleteAttempts);
      expect(first.errors).toHaveLength(errors);
    } finally {
      deleteSpy.mockRestore();
      first.auto.dispose();
    }

    if (failure === 'transient delete') {
      expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
      expect(getSnapshot()).toEqual([]);
      return;
    }
    expect(getSnapshot()).toBe(snapshot);
    const restarted = setup({ ...options, list: [other] });
    restarted.auto.evaluate();
    await restarted.runJobs();
    expect(restarted.accepts).toEqual([]);
    expect(await restarted.view.refresh()).toEqual([other]);
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([{ ...record, claimedInvitationId: 'i1' }]);

    if (failure === 'accept') {
      restarted.addInvitation(original);
      restarted.auto.evaluate();
      await restarted.runJobs();
      expect(restarted.accepts).toEqual(['i1']);
      expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([]);
      expect(getSnapshot()).toEqual([]);
    }
  });

  it('leaves the invitation available for manual acceptance if the claim transaction aborts', async () => {
    await clearAllOutboundJoinRequests();
    const record = rec('aborted', ADMIN, 'Club');
    await saveOutboundJoinRequest(record);
    const t = setup({ ...options, list: [original] });
    const put = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    try {
      t.auto.evaluate();
      await t.runJobs();
      expect(t.accepts).toEqual([]);
      expect(t.errors).toHaveLength(1);
      expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([record]);
      await t.actions.accept(original.id);
      expect(t.accepts).toEqual(['i1']);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('serializes conflicting claims and protects a replacement send from stale cleanup', async () => {
    await clearAllOutboundJoinRequests();
    const record = rec('concurrent', ADMIN, 'Club');
    await saveOutboundJoinRequest(record);
    const claims = await Promise.all([outbound.claim(ACCOUNT, record, 'i1'), outbound.claim(ACCOUNT, record, 'i2')]);
    expect(claims).toEqual([{ kind: 'acquired', token: expect.any(String) }, { kind: 'unavailable' }]);
    const [first] = claims;
    if (first.kind !== 'acquired') throw new Error('expected a new claim');
    expect(await outbound.claim(ACCOUNT, record, 'i1')).toEqual({ kind: 'existing' });
    expect(await outbound.releaseClaim(OTHER, record, 'i1', first.token)).toBe(false);
    expect(await outbound.releaseClaim(ACCOUNT, record, 'i2', first.token)).toBe(false);
    expect(await outbound.releaseClaim(ACCOUNT, record, 'i1', first.token)).toBe(true);
    expect(await outbound.claim(ACCOUNT, record, 'i1')).toMatchObject({ kind: 'acquired' });
    expect(await outbound.releaseClaim(ACCOUNT, record, 'i1', first.token)).toBe(false);
    await outbound.consume(ACCOUNT, record, 'i2');
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([{ ...record, claimedInvitationId: 'i1' }]);

    const replacement = { ...record, sentAt: record.sentAt + 1 };
    await saveOutboundJoinRequest(replacement);
    expect(await outbound.claim(ACCOUNT, record, 'i2')).toEqual({ kind: 'unavailable' });
    expect(await outbound.claim(ACCOUNT, replacement, 'i1')).toMatchObject({ kind: 'acquired' });
    await outbound.consume(ACCOUNT, record, 'i1');
    expect(await outbound.loadUnexpiredForAdmin(ACCOUNT, ADMIN)).toEqual([{ ...replacement, claimedInvitationId: 'i1' }]);
  });
});

describe('construction validates every required port (no silent degradation)', () => {
  const full = () => ({
    accountPubkey: ACCOUNT,
    assertLease: () => undefined,
    view: { refresh: async () => [], scheduleRefresh: () => undefined },
    actions: { accept: async () => ({}) as never },
    enqueue: () => undefined,
    outbound: {
      loadUnexpiredForAdmin: async () => [],
      claim: async () => ({ kind: 'unavailable' }),
      releaseClaim: async () => false,
      consume: async () => undefined,
    },
    groupNameOf: () => undefined,
    purge: noPurge,
  });
  it.each([
    ['accountPubkey'],
    ['assertLease'],
    ['view'],
    ['actions'],
    ['enqueue'],
    ['outbound'],
    ['groupNameOf'],
    ['purge'],
  ])('throws when %s is missing', (key) => {
    const deps = full() as Record<string, unknown>;
    delete deps[key];
    expect(() => createAutoAccept(deps as never)).toThrow(TypeError);
  });
  it('throws without dependencies', () => {
    expect(() => createAutoAccept(undefined as never)).toThrow(TypeError);
  });
  it.each(['claim', 'releaseClaim'])('throws without the %s port', (port) => {
    const deps = full();
    expect(() => createAutoAccept({ ...deps, outbound: { ...deps.outbound, [port]: undefined } } as never))
      .toThrow(`outbound.${port}`);
  });
});

describe('accept and a purge of the same group id are mutually exclusive', () => {
  it('a matching invitation is NOT accepted while a purge of its group runs; it is accepted once the purge settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    const t = setup({
      list: [inv('i1', ADMIN, 'gx')],
      records: [rec('n1', ADMIN, 'Club')],
      names: { gx: 'Club' },
      purge: { whenPurged: async (g) => (asked.push(g), gate) },
    });
    t.auto.onInboxDisposition({ kind: 'pending' });
    const run = t.runJobs();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(asked).toContain('gx');
    expect(t.accepts).toEqual([]); // deferred behind the purge
    release();
    await run;
    expect(t.accepts).toEqual(['i1']);
    expect(t.consumed).toEqual(['n1']);
  });
});
