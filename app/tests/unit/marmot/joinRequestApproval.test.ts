// @vitest-environment node
/**
 * Unit tests for the join-request approval (S12): AC-JOIN-2 (invite through the key-package seam, request consumed),
 * AC-JOIN-3 (a requester that already holds a leaf: no invite, consumed, no error), the re-entrancy rule (the invite
 * runs only inside a queued job) and the failure paths (the request stays pending).
 *
 * The inviter here is the REAL `createKeyPackageInviter` over a fake group + lookup, so the "exactly one `group.invite`
 * event" and "no `group.invite` when a leaf exists" assertions are made on the group, not on a stub of the seam.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@941design/nostr-events/event';
import { createJoinRequestApproval, type ApprovalKind } from '@/src/lib/marmot/joinRequestApproval';
import { PENDING_JOIN_REQUEST_TTL_MS } from '@/src/lib/marmot/joinRequestTtl';
import { createKeyPackageInviter, type InviteGroup } from '@/src/lib/marmot/invitations';
import { createGroupOpQueue } from '@/src/lib/marmot/send';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

const REQUESTER = 'ab'.repeat(32);
const NOW = 1_700_000_000_000;

const request = (over: Partial<PendingJoinRequest> = {}): PendingJoinRequest => ({
  pubkeyHex: REQUESTER,
  nonce: 'nonce-1',
  groupId: 'cd'.repeat(32),
  receivedAt: NOW - 1000,
  nickname: 'Alice',
  eventId: 'rumor-1',
  ...over,
});

const keyPackage = (id: string, createdAt: number): NostrEvent => ({ id, pubkey: REQUESTER, created_at: createdAt, kind: 443, tags: [], content: 'x', sig: 's' }) as NostrEvent;

function fakeGroup(opts: { leaves?: () => string[]; invite?: (events: NostrEvent[]) => Promise<unknown> } = {}) {
  const invite = vi.fn(opts.invite ?? (async (events: NostrEvent[]) => events.map((e) => ({ inviteeRef: `ref-${e.id}`, pubkey: REQUESTER, status: 'delivered', relays: [] }))));
  const group = {
    id: 'cd'.repeat(32),
    synced: async () => undefined,
    leaves: vi.fn((pubkey: string) => (opts.leaves ? opts.leaves() : []).filter((l) => l === pubkey)),
    invite,
  } as unknown as InviteGroup;
  return { group, invite };
}

function setup(groupFactory: () => ReturnType<typeof fakeGroup> | undefined, lookupResult: { ok: true; candidates: NostrEvent[] } | { ok: false; reason: 'none-found' } = { ok: true, candidates: [keyPackage('kp1', 10)] }) {
  const lookup = vi.fn(async (_pubkey: string, _opts?: unknown) => lookupResult);
  const inviter = createKeyPackageInviter({ lookup: { lookup } as never, queue: createGroupOpQueue({ syncTimeoutMs: 1000 }) });
  const jobs: Array<() => Promise<void>> = [];
  const consumed: PendingJoinRequest[] = [];
  const approved: Array<[PendingJoinRequest, ApprovalKind]> = [];
  const errors: unknown[] = [];
  const made = groupFactory();
  const getGroup = vi.fn(async () => made?.group);
  const approval = createJoinRequestApproval({
    inviter,
    getGroup,
    enqueue: (job) => void jobs.push(job),
    consumeRequest: async (r) => void consumed.push(r),
    onApproved: (r, k) => void approved.push([r, k]),
    now: () => NOW,
    onError: (e) => void errors.push(e),
  });
  const runJobs = async () => {
    while (jobs.length) await jobs.shift()!();
  };
  return { approval, jobs, runJobs, consumed, approved, errors, lookup, getGroup, made };
}

describe('AC-JOIN-2: approval invites through the key-package seam and consumes the request', () => {
  it('calls group.invite with exactly one key-package event (the newest), then consumes the request and reports invited', async () => {
    const t = setup(() => fakeGroup(), { ok: true, candidates: [keyPackage('kp-new', 20), keyPackage('kp-old', 10)] });
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: true, kind: 'invited', welcomeStatus: 'delivered' });
    expect(t.made!.invite).toHaveBeenCalledTimes(1);
    expect((t.made!.invite.mock.calls[0] as unknown as [NostrEvent[]])[0].map((e) => e.id)).toEqual(['kp-new']);
    expect(t.lookup).toHaveBeenCalledWith(REQUESTER, expect.anything());
    expect(t.consumed.map((r) => r.eventId)).toEqual(['rumor-1']);
    expect(t.approved.map(([r, k]) => [r.eventId, k])).toEqual([['rumor-1', 'invited']]);
  });

  it('lowercases the requester pubkey before the lookup', async () => {
    const t = setup(() => fakeGroup(), { ok: true, candidates: [keyPackage('kp1', 1)] });
    const pending = t.approval.approve(request({ pubkeyHex: REQUESTER.toUpperCase() }));
    await t.runJobs();
    await pending;
    expect(t.lookup.mock.calls[0][0]).toBe(REQUESTER);
  });

  it('keeps the request pending (nothing consumed, no onApproved) when no key package is usable', async () => {
    const t = setup(() => fakeGroup(), { ok: false, reason: 'none-found' });
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: false, error: 'no-usable-key-package', reason: 'none-found' });
    expect(t.made!.invite).not.toHaveBeenCalled();
    expect(t.consumed).toEqual([]);
    expect(t.approved).toEqual([]);
  });

  it('keeps the request pending and reports invite-failed when group.invite throws (e.g. not admin)', async () => {
    const t = setup(() => fakeGroup({ invite: async () => { throw new Error('not-admin'); } }));
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: false, error: 'invite-failed', detail: 'not-admin' });
    expect(t.consumed).toEqual([]);
  });

  it('reports group-missing (nothing invited, request kept) when the group is gone', async () => {
    const t = setup(() => undefined);
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: false, error: 'group-missing' });
    expect(t.consumed).toEqual([]);
  });

  it('a consume failure after a committed invite is reported, never turns the approval into a failure, and onApproved still runs', async () => {
    const lookup = vi.fn(async () => ({ ok: true as const, candidates: [keyPackage('kp1', 1)] }));
    const { group } = fakeGroup();
    const errors: unknown[] = [];
    const approved: ApprovalKind[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const approval = createJoinRequestApproval({
      inviter: createKeyPackageInviter({ lookup: { lookup } as never, queue: createGroupOpQueue({ syncTimeoutMs: 1000 }) }),
      getGroup: async () => group,
      enqueue: (job) => void jobs.push(job),
      consumeRequest: async () => { throw new Error('idb full'); },
      onApproved: (_r, k) => void approved.push(k),
      now: () => NOW,
      onError: (e) => void errors.push(e),
    });
    const pending = approval.approve(request());
    await jobs.shift()!();
    await expect(pending).resolves.toMatchObject({ ok: true, kind: 'invited' });
    expect(approved).toEqual(['invited']);
    expect(errors.map((e) => (e as Error).message)).toEqual(['idb full']);
  });
});

describe('AC-JOIN-3: a requester that already holds a leaf', () => {
  it('issues no group.invite, consumes the request, surfaces no error and no lookup is made', async () => {
    const t = setup(() => fakeGroup({ leaves: () => [REQUESTER] }));
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: true, kind: 'already-member' });
    expect(t.made!.invite).not.toHaveBeenCalled();
    expect(t.lookup).not.toHaveBeenCalled(); // the pre-check on the member list costs no relay request
    expect(t.consumed.map((r) => r.eventId)).toEqual(['rumor-1']);
    expect(t.approved.map(([, k]) => k)).toEqual(['already-member']);
    expect(t.errors).toEqual([]);
  });

  it('a leaf that appears while the request waits for synced() is caught inside the queued op: still no invite', async () => {
    let leafAppears = false;
    const { group, invite } = fakeGroup({ leaves: () => (leafAppears ? [REQUESTER] : []) });
    // the member list becomes current only after synced()
    (group as unknown as { synced: () => Promise<void> }).synced = async () => { leafAppears = true; };
    const t = setup(() => ({ group, invite }));
    const pending = t.approval.approve(request());
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: true, kind: 'already-member' });
    expect(invite).not.toHaveBeenCalled();
    expect(t.consumed).toHaveLength(1);
  });
});

describe('an expired request is not approvable (TTL enforced at approval)', () => {
  it('refuses with request-expired, issues no lookup / invite, consumes the request and runs no follow-up', async () => {
    const t = setup(() => fakeGroup());
    const pending = t.approval.approve(request({ receivedAt: NOW - PENDING_JOIN_REQUEST_TTL_MS }));
    await t.runJobs();
    await expect(pending).resolves.toEqual({ ok: false, error: 'request-expired' });
    expect(t.lookup).not.toHaveBeenCalled();
    expect(t.made!.invite).not.toHaveBeenCalled();
    expect(t.consumed.map((r) => r.eventId)).toEqual(['rumor-1']);
    expect(t.approved).toEqual([]);
  });

  it('a request one ms inside the TTL is still approved', async () => {
    const t = setup(() => fakeGroup());
    const pending = t.approval.approve(request({ receivedAt: NOW - PENDING_JOIN_REQUEST_TTL_MS + 1 }));
    await t.runJobs();
    await expect(pending).resolves.toMatchObject({ ok: true, kind: 'invited' });
  });
});

describe('re-entrancy: the invite runs only inside a queued job', () => {
  it('approve() makes no client call (getGroup / lookup / invite) in the calling frame, only enqueues', async () => {
    const t = setup(() => fakeGroup());
    const pending = t.approval.approve(request());
    expect(t.jobs).toHaveLength(1);
    expect(t.getGroup).not.toHaveBeenCalled();
    expect(t.lookup).not.toHaveBeenCalled();
    expect(t.made!.invite).not.toHaveBeenCalled();
    await t.runJobs();
    await pending;
    expect(t.getGroup).toHaveBeenCalledTimes(1);
  });

  it('a queue that does not accept the job settles with queue-unavailable instead of hanging', async () => {
    const approval = createJoinRequestApproval({
      inviter: { inviteByPubkey: async () => { throw new Error('must not run'); } },
      getGroup: async () => undefined,
      enqueue: () => false,
      consumeRequest: async () => undefined,
      onApproved: () => undefined,
    });
    await expect(approval.approve(request())).resolves.toEqual({ ok: false, error: 'queue-unavailable' });
  });

  it('concurrent approvals of the same request share one run (no double invite)', async () => {
    const t = setup(() => fakeGroup());
    const a = t.approval.approve(request());
    const b = t.approval.approve(request());
    expect(t.jobs).toHaveLength(1);
    await t.runJobs();
    expect(await a).toEqual(await b);
    expect(t.made!.invite).toHaveBeenCalledTimes(1);
  });
});

describe('construction validates every required port (no silent degradation)', () => {
  const full = () => ({
    inviter: { inviteByPubkey: async () => ({ error: 'already-member' as const }) },
    getGroup: async () => undefined,
    enqueue: () => undefined,
    consumeRequest: async () => undefined,
    onApproved: () => undefined,
  });
  it.each(['inviter', 'getGroup', 'enqueue', 'consumeRequest', 'onApproved'] as const)('throws when %s is missing', (key) => {
    const deps = full() as Record<string, unknown>;
    delete deps[key];
    expect(() => createJoinRequestApproval(deps as never)).toThrow(TypeError);
  });
  it('throws without dependencies', () => {
    expect(() => createJoinRequestApproval(undefined as never)).toThrow(TypeError);
  });
  it('rejects a malformed request synchronously', () => {
    expect(() => createJoinRequestApproval(full()).approve({} as never)).toThrow(TypeError);
  });
});
