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
import { describe, expect, it, vi } from 'vitest';
import type { PendingInvitation } from '@941design/marmot';
import {
  createAutoAccept,
  type OutboundRequestRef,
} from '@/src/lib/marmot/invitations/autoAccept';
import { createDenyLayer, createInvitationActions, createPendingInvitationView } from '@/src/lib/marmot/invitations';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const ADMIN = hex(1);
const OTHER = hex(2);

const inv = (id: string, sponsor: string, groupId = `g-${id}`): PendingInvitation => ({
  id, groupId, sponsorAccount: sponsor, sponsors: [sponsor], keyPackageRef: `kp-${id}`, receivedAt: 1,
});
const rec = (nonce: string, admin: string, groupName: string): OutboundRequestRef => ({ nonce, adminPubkeyHex: admin, groupName });

function setup(opts: { list?: PendingInvitation[]; records?: OutboundRequestRef[]; names?: Record<string, string>; blocked?: string[]; acceptFails?: boolean; consumeFails?: boolean } = {}) {
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
    now: () => 1_000,
    onError: (e) => void errors.push(e),
  });
  const actions = createInvitationActions({ invitations, view, attachGroup: () => undefined, onError: (e) => void errors.push(e) });
  const loadUnexpiredForAdmin = vi.fn(async (admin: string) => records.filter((r) => r.adminPubkeyHex === admin));
  const auto = createAutoAccept({
    view,
    actions,
    enqueue,
    outbound: { loadUnexpiredForAdmin, consume: async (nonce) => { if (opts.consumeFails) throw new Error('idb down'); consumed.push(nonce); records = records.filter((r) => r.nonce !== nonce); } },
    groupNameOf: (i) => opts.names?.[i.groupId],
    onError: (e) => void errors.push(e),
  });
  const runJobs = async () => {
    while (jobs.length) await jobs.shift()!();
  };
  const addInvitation = (i: PendingInvitation) => { list = [...list, i]; };
  return { auto, view, jobs, runJobs, accepts, consumed, errors, invitations, loadUnexpiredForAdmin, addInvitation, getRecords: () => records };
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

  it('a failed consume is remembered in memory: a second invitation of the same sponsor never reuses the stale record', async () => {
    const t = setup({ list: [inv('i1', ADMIN, 'gx')], records: [rec('n1', ADMIN, 'Club')], names: { gx: 'Club', gz: 'Club' }, consumeFails: true });
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']);
    expect(t.errors.length).toBeGreaterThan(0); // the failed delete is reported
    expect(t.getRecords()).toHaveLength(1); // the record could not be deleted
    t.addInvitation(inv('i2', ADMIN, 'gz'));
    t.auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual(['i1']); // i2 is NOT auto-accepted on the already-used record
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
      view: { refresh: async () => [], scheduleRefresh: () => undefined },
      actions: { accept: async () => ({}) as never },
      enqueue: () => { calls.push(1); return accept; },
      outbound: { loadUnexpiredForAdmin: async () => [], consume: async () => undefined },
      groupNameOf: () => undefined,
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
      view: t.view,
      actions: createInvitationActions({ invitations: t.invitations, view: t.view, attachGroup: () => undefined }),
      enqueue: (job) => void t.jobs.push(job),
      outbound: { loadUnexpiredForAdmin: async () => { throw new Error('idb down'); }, consume: async () => undefined },
      groupNameOf: () => undefined,
      onError: (e) => void errors.push(e),
    });
    auto.onInboxDisposition({ kind: 'pending' });
    await t.runJobs();
    expect(t.accepts).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['idb down']);
  });
});

describe('construction validates every required port (no silent degradation)', () => {
  const full = () => ({
    view: { refresh: async () => [], scheduleRefresh: () => undefined },
    actions: { accept: async () => ({}) as never },
    enqueue: () => undefined,
    outbound: { loadUnexpiredForAdmin: async () => [], consume: async () => undefined },
    groupNameOf: () => undefined,
  });
  it.each([
    ['view'],
    ['actions'],
    ['enqueue'],
    ['outbound'],
    ['groupNameOf'],
  ])('throws when %s is missing', (key) => {
    const deps = full() as Record<string, unknown>;
    delete deps[key];
    expect(() => createAutoAccept(deps as never)).toThrow(TypeError);
  });
  it('throws without dependencies', () => {
    expect(() => createAutoAccept(undefined as never)).toThrow(TypeError);
  });
});
