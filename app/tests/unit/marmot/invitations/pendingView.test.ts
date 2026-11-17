/**
 * AC-INV-2 / AC-INV-4 (unit): the pending view's contract with the job queue, ports validated at construction,
 * change/arrival events, dispose; plus the structural proof that new invitations code never touches
 * lp_pendingInvitations_v1 or the old pending API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PendingInvitation } from '@941design/marmot';
import { createDenyLayer, createInvitationActions, createPendingInvitationView } from '@/src/lib/marmot/invitations';
import { noPurge } from './noPurge';

const hex = (n: number) => n.toString(16).padStart(64, 'e');
const inv = (id: string, sponsor = 1, receivedAt = 1): PendingInvitation => ({
  id, groupId: `g-${id}`, sponsorAccount: hex(sponsor), sponsors: [hex(sponsor)], keyPackageRef: `kp-${id}`, receivedAt,
});
const noDeny = createDenyLayer({ loadBlockedPeers: () => new Set() });
/** Retention ports for tests that do not exercise retention (all strangers, clock at the receivedAt scale). */
const ret = { isTrustedSponsor: () => false, now: () => 100 };

describe('ports are validated at construction', () => {
  const ok = { invitations: { pending: async () => [], decline: async () => undefined }, denyLayer: noDeny, enqueue: () => undefined, ...ret };
  it.each(['invitations', 'denyLayer', 'enqueue'] as const)('missing %s throws', (k) => {
    expect(() => createPendingInvitationView({ ...ok, [k]: undefined } as never)).toThrow(TypeError);
  });
  it('missing invitations.decline / denyLayer.isBlocked throw', () => {
    expect(() => createPendingInvitationView({ ...ok, invitations: { pending: async () => [] } } as never)).toThrow(/decline/);
    expect(() => createPendingInvitationView({ ...ok, denyLayer: {} } as never)).toThrow(/isBlocked/);
    expect(() => createPendingInvitationView(undefined as never)).toThrow();
  });
  it('actions: missing accept / attachGroup / view throw', () => {
    const view = { refresh: async () => [], isVisible: () => true };
    const base = { invitations: { pending: async () => [], decline: async () => undefined, accept: async () => ({}) as never }, view, attachGroup: () => undefined };
    expect(() => createInvitationActions({ ...base, attachGroup: undefined } as never)).toThrow(/attachGroup/);
    expect(() => createInvitationActions({ ...base, invitations: { ...base.invitations, accept: undefined } } as never)).toThrow(/accept/);
    expect(() => createInvitationActions({ ...base, view: undefined } as never)).toThrow(/view/);
  });
});

describe('re-entrancy: the listener entry only enqueues', () => {
  it('onInboxDisposition makes no client call synchronously; the job runs the refresh; triggers collapse', async () => {
    let pendingCalls = 0;
    const jobs: Array<() => Promise<void>> = [];
    const view = createPendingInvitationView({
      invitations: { pending: async () => { pendingCalls++; return [inv('a')]; }, decline: async () => undefined },
      denyLayer: noDeny,
      ...ret,
      enqueue: (j) => void jobs.push(j),
    });
    view.onInboxDisposition({ kind: 'pending' });
    view.onInboxDisposition({ kind: 'pending' });
    view.onInboxDisposition({ kind: 'rejected' }); // irrelevant kind: nothing
    expect(pendingCalls).toBe(0);
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(pendingCalls).toBe(1);
    expect(view.pending().map((i) => i.id)).toEqual(['a']);
    view.onInboxDisposition({ kind: 'joined' });
    expect(jobs).toHaveLength(2); // a new trigger after the job started enqueues again
  });

  it('a failing refresh job is reported, never thrown into the queue', async () => {
    const errors: unknown[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const view = createPendingInvitationView({
      invitations: { pending: async () => { throw new Error('store'); }, decline: async () => undefined },
      denyLayer: noDeny,
      ...ret,
      enqueue: (j) => void jobs.push(j),
      onError: (e) => errors.push(e),
    });
    view.scheduleRefresh();
    await expect(jobs[0]()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('snapshot, events, dispose', () => {
  it('pending() is a copy, ordered oldest first (list seeded out of order); onChange only on a real change; first load is not an arrival', async () => {
    let list = [inv('c', 1, 30), inv('a', 2, 10), inv('b', 3, 20)];
    const view = createPendingInvitationView({ invitations: { pending: async () => list, decline: async () => undefined }, denyLayer: noDeny, ...ret, enqueue: (j) => void j() });
    const arrivals: string[] = [];
    let changes = 0;
    view.onArrival((i) => arrivals.push(i.id));
    view.onChange(() => changes++);
    await view.refresh();
    expect(view.pending().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(arrivals).toEqual([]);
    expect(changes).toBe(1);
    view.pending().pop();
    expect(view.pending()).toHaveLength(3);
    await view.refresh();
    expect(changes).toBe(1);
    list = [...list, inv('d', 4, 40)];
    await view.refresh();
    expect(arrivals).toEqual(['d']);
    expect(changes).toBe(2);
    list = list.filter((i) => i.id !== 'a');
    await view.refresh();
    expect(view.pending().map((i) => i.id)).toEqual(['b', 'c', 'd']);
    expect(changes).toBe(3);
  });

  it('a throwing listener does not stop the others; dispose silences events and enqueueing', async () => {
    const errors: unknown[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const view = createPendingInvitationView({ invitations: { pending: async () => [inv('a')], decline: async () => undefined }, denyLayer: noDeny, ...ret, enqueue: (j) => void jobs.push(j), onError: (e) => errors.push(e) });
    let second = 0;
    view.onChange(() => { throw new Error('x'); });
    view.onChange(() => second++);
    await view.refresh();
    expect(second).toBe(1);
    expect(errors).toHaveLength(1);
    view.dispose();
    view.scheduleRefresh();
    expect(jobs).toHaveLength(0);
  });
});

describe('accept / decline actions (stubbed library)', () => {
  it('accept re-reads the list, calls the library once, attaches the group and refreshes; unknown id is rejected before the library', async () => {
    let list = [inv('a')];
    let accepted: string[] = [];
    const attached: unknown[] = [];
    const group = { id: 'g-a' } as never;
    const invitations = {
      pending: async () => list,
      decline: async () => undefined,
      accept: async (id: string) => { accepted.push(id); list = []; return group; },
    };
    const view = createPendingInvitationView({ invitations, denyLayer: noDeny, ...ret, enqueue: (j) => void j() });
    const actions = createInvitationActions({ invitations, view, attachGroup: (g) => attached.push(g), purge: noPurge });
    await expect(actions.accept('nope')).rejects.toMatchObject({ code: 'unknown-invitation', invitationId: 'nope' });
    expect(accepted).toEqual([]);
    expect(await actions.accept('a')).toBe(group);
    expect(accepted).toEqual(['a']);
    expect(attached).toEqual([group]);
    expect(view.pending()).toEqual([]);
  });

  it('decline calls the library decline asking for the native rumor and refreshes; a refresh failure after a success is reported, not thrown', async () => {
    let list = [inv('a')];
    const declines: unknown[][] = [];
    let failList = false;
    const errors: unknown[] = [];
    const invitations = {
      pending: async () => { if (failList) throw new Error('late'); return list; },
      decline: async (...args: unknown[]) => { declines.push(args); list = []; failList = true; },
      accept: async () => ({}) as never,
    };
    const view = createPendingInvitationView({ invitations: invitations as never, denyLayer: noDeny, ...ret, enqueue: (j) => void j() });
    await view.refresh();
    const actions = createInvitationActions({ invitations: invitations as never, view, attachGroup: () => undefined, purge: noPurge, onError: (e) => errors.push(e) });
    await expect(actions.decline('a')).resolves.toBeUndefined();
    expect(declines).toEqual([['a', { declineRumor: true }]]);
    expect(errors).toHaveLength(1);
  });
});

describe('AC-INV-4 (structural): lp_pendingInvitations_v1 and the old pending API are not used by new code', () => {
  const dir = join(__dirname, '../../../../src/lib/marmot/invitations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('scans a non-empty set of module files', () => {
    expect(files).toEqual(expect.arrayContaining(['pendingView.ts', 'denyLayer.ts', 'caps.ts', 'acceptDecline.ts']));
  });
  it.each(files)('%s never mentions the old key, never calls the old pending store, never uses idb update()', (f) => {
    const code = strip(readFileSync(join(dir, f), 'utf8'));
    expect(code).not.toMatch(/lp_pendingInvitations/);
    expect(code).not.toMatch(/\b(listPendingInvitations|enqueuePendingInvitation|removePendingInvitation|countPendingInvitations|pendingInvitationsForInviter)\b/);
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/from 'idb-keyval'/);
    expect(code).not.toMatch(/@\/src\/context|from 'react'/);
  });
  it('the only import from lib/pendingInvitations is the cap constants (caps.ts)', () => {
    for (const f of files) {
      const code = strip(readFileSync(join(dir, f), 'utf8'));
      const m = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/src\/lib\/pendingInvitations'/g)];
      for (const x of m) expect(x[1].split(',').map((s) => s.trim()).filter(Boolean).sort()).toEqual(['GLOBAL_CAP', 'PER_INVITER_CAP']);
    }
  });
});

describe('decline mirrors accept (the pending list is re-read first)', () => {
  const setup = (blocked: Set<string>) => {
    const live = [inv('a', 1, 1)];
    const calls: Array<{ id: string; options?: { declineRumor?: boolean } }> = [];
    const invitations = {
      pending: async () => live.filter((i) => !calls.some((c) => c.id === i.id)),
      decline: async (id: string, options?: { readonly declineRumor?: boolean }) => void calls.push({ id, options }),
      accept: async () => ({}) as never,
    };
    const view = createPendingInvitationView({ invitations, denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }), ...ret, enqueue: (j) => void j(), onError: (e) => { throw e; } });
    const actions = createInvitationActions({ invitations, view, attachGroup: () => undefined, purge: noPurge });
    return { view, actions, calls, live, invitations };
  };

  it('shown, then blocked, then user decline: the only library call is the silent {declineRumor:false}', async () => {
    const blocked = new Set<string>();
    const { view, actions, calls } = setup(blocked);
    await view.refresh();
    expect(view.isVisible('a')).toBe(true);
    blocked.add(hex(1));
    await expect(actions.decline('a')).resolves.toBeUndefined();
    expect(calls).toEqual([{ id: 'a', options: { declineRumor: false } }]);
  });

  it('declining an id that is already gone resolves without a library call', async () => {
    const { actions, calls } = setup(new Set());
    await expect(actions.decline('missing')).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('a library failure for an id that vanished meanwhile counts as done; for a still-pending id it is rethrown', async () => {
    let list = [inv('a')];
    let vanish = true;
    const invitations = {
      pending: async () => list,
      decline: async () => { if (vanish) list = []; throw new Error('not found'); },
      accept: async () => ({}) as never,
    };
    const view = createPendingInvitationView({ invitations, denyLayer: noDeny, ...ret, enqueue: (j) => void j() });
    const actions = createInvitationActions({ invitations, view, attachGroup: () => undefined, purge: noPurge, onError: () => undefined });
    await expect(actions.decline('a')).resolves.toBeUndefined();
    list = [inv('a')];
    vanish = false;
    await expect(actions.decline('a')).rejects.toThrow('not found');
  });
});

describe('seeding is explicit', () => {
  it('a first recompute triggered by onInboxDisposition announces its new entries; seed() and a first refresh() do not', async () => {
    const jobs: Array<() => Promise<void>> = [];
    const mk = (enqueue: (j: () => Promise<void>) => void) =>
      createPendingInvitationView({ invitations: { pending: async () => [inv('a'), inv('b', 2, 2)], decline: async () => undefined }, denyLayer: noDeny, ...ret, enqueue });
    const viaListener = mk((j) => void jobs.push(j));
    const got: string[] = [];
    viaListener.onArrival((i) => got.push(i.id));
    viaListener.onInboxDisposition({ kind: 'pending' });
    await jobs[0]();
    expect(got).toEqual(['a', 'b']);

    const seeded = mk((j) => void j());
    const none: string[] = [];
    seeded.onArrival((i) => none.push(i.id));
    await seeded.seed();
    await seeded.seed();
    expect(none).toEqual([]);

    const firstRefresh = mk((j) => void j());
    firstRefresh.onArrival((i) => none.push(i.id));
    await firstRefresh.refresh();
    expect(none).toEqual([]);
  });

  it('seed() after earlier recomputes still announces nothing', async () => {
    let list = [inv('a')];
    const view = createPendingInvitationView({ invitations: { pending: async () => list, decline: async () => undefined }, denyLayer: noDeny, ...ret, enqueue: (j) => void j() });
    await view.refresh();
    const got: string[] = [];
    view.onArrival((i) => got.push(i.id));
    list = [inv('a'), inv('b', 2, 2)];
    await view.seed();
    expect(got).toEqual([]);
    expect(view.pending()).toHaveLength(2);
  });
});

describe('the queued flag does not wedge when the queue rejects the job', () => {
  it.each([
    ['returns false (disposed queue)', () => false],
    ['throws', () => { throw new Error('queue gone'); }],
  ])('enqueue %s: the next trigger enqueues again', (_n, behave) => {
    let calls = 0;
    const errors: unknown[] = [];
    const view = createPendingInvitationView({
      invitations: { pending: async () => [], decline: async () => undefined },
      denyLayer: noDeny, ...ret,
      enqueue: () => { calls++; return behave(); },
      onError: (e) => errors.push(e),
    });
    view.scheduleRefresh();
    view.scheduleRefresh();
    expect(calls).toBe(2);
  });

  it('an accepted job still collapses further triggers', () => {
    let calls = 0;
    const view = createPendingInvitationView({ invitations: { pending: async () => [], decline: async () => undefined }, denyLayer: noDeny, ...ret, enqueue: () => { calls++; return true; } });
    view.scheduleRefresh();
    view.scheduleRefresh();
    expect(calls).toBe(1);
  });
});
