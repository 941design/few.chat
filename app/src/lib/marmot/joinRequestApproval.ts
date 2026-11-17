/**
 * Join-request approval (D8, AC-JOIN-2 / AC-JOIN-3), the consumer of the `KeyPackageInvite` seam.
 *
 * `approve(request)` resolves the request's group, calls `inviteByPubkey(group, requester)` (S8: key-package lookup, ONE
 * `group.invite` event, per-candidate fall-through) and then marks the request approved and consumed:
 *
 *   - invited          the commit was made: the request is consumed (never re-approvable) and `onApproved` runs;
 *   - already-member   the requester already holds a leaf of the group (`{error:'already-member'}`): NO `group.invite`
 *                      was issued, the request is consumed all the same and the result is a plain success (no error is
 *                      surfaced; AC-JOIN-3);
 *   - no usable key package / any thrown error: the request STAYS pending (nothing was committed) and the result is
 *                      `{ok:false}` so the UI can show its error and the admin can retry.
 *
 * An expired request (older than `PENDING_JOIN_REQUEST_TTL_MS`) is refused with `request-expired`: nothing is invited,
 * the request is consumed.
 *
 * Re-entrancy: `inviteByPubkey` is an account-scope client call. It runs ONLY inside a `handle.enqueue` job (the owned
 * FIFO), never in the caller's frame, so it is safe whatever frame the caller is in. The returned promise settles when
 * the job has run; a queue that no longer accepts jobs settles it with `queue-unavailable` instead of hanging.
 *
 * Concurrent `approve` calls for the same request share one run (a double click cannot double-invite). A consume or
 * `onApproved` failure after the invite is committed is reported and never turns the approval into a failure: the
 * invitee has already been invited, and a re-approval of a request left behind resolves as `already-member`.
 *
 * Pure module: ports are injected and validated at construction; no React, no storage, no client import.
 */
import type { PendingJoinRequest } from './joinRequestStorage';
import { isPendingJoinRequestExpired } from './joinRequestTtl';
import type { InviteGroup, KeyPackageInviter } from './invitations';

export type ApprovalKind = 'invited' | 'already-member';

export type ApprovalResult =
  | { ok: true; kind: 'invited'; welcomeStatus: string }
  | { ok: true; kind: 'already-member' }
  | { ok: false; error: 'no-usable-key-package'; reason: string }
  | { ok: false; error: 'group-missing' }
  | { ok: false; error: 'request-expired' }
  | { ok: false; error: 'queue-unavailable' }
  | { ok: false; error: 'invite-failed'; detail: string };

export interface JoinRequestApprovalDeps {
  inviter: Pick<KeyPackageInviter, 'inviteByPubkey'>;
  /** `client.groups.get`: account-scope, only ever called inside the queued job. `undefined` = the group is gone. */
  getGroup: (groupId: string) => Promise<InviteGroup | undefined>;
  /** `AccountClientHandle.enqueue`; `false` = not accepted (queue disposed). */
  enqueue: (job: () => Promise<void>) => boolean | void;
  /** Marks the request approved and consumed (production: delete it from storage and prune the local request state). */
  consumeRequest: (request: PendingJoinRequest) => Promise<void>;
  /** Best-effort follow-ups of an approval (production: provisional name seed, invite-link usage count). Never fails an approval. */
  onApproved: (request: PendingJoinRequest, kind: ApprovalKind) => Promise<void> | void;
  /** Clock, ms (default `Date.now`): a request older than `PENDING_JOIN_REQUEST_TTL_MS` is refused and consumed. */
  now?: () => number;
  /** A failed consume / follow-up (default `console.error`). */
  onError?: (error: unknown) => void;
}

export interface JoinRequestApproval {
  approve: (request: PendingJoinRequest) => Promise<ApprovalResult>;
}

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createJoinRequestApproval: required dependency "${name}" is missing`);
}

export function createJoinRequestApproval(deps: JoinRequestApprovalDeps): JoinRequestApproval {
  if (!deps) throw new TypeError('createJoinRequestApproval: dependencies are required');
  requireFn(deps.inviter?.inviteByPubkey, 'inviter.inviteByPubkey');
  requireFn(deps.getGroup, 'getGroup');
  requireFn(deps.enqueue, 'enqueue');
  requireFn(deps.consumeRequest, 'consumeRequest');
  requireFn(deps.onApproved, 'onApproved');
  const { inviter, getGroup, enqueue, consumeRequest, onApproved } = deps;
  const now = deps.now ?? (() => Date.now());
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/joinRequests] approval', e));
  const inFlight = new Map<string, Promise<ApprovalResult>>();

  const settle = async (request: PendingJoinRequest, kind: ApprovalKind): Promise<void> => {
    // Consume FIRST: the invitee is already invited, so the cleanup must complete even when the follow-up below fails.
    try {
      await consumeRequest(request);
    } catch (e) {
      onError(e);
    }
    try {
      await onApproved(request, kind);
    } catch (e) {
      onError(e);
    }
  };

  async function run(request: PendingJoinRequest): Promise<ApprovalResult> {
    if (isPendingJoinRequestExpired(request, now())) {
      // Past its TTL: never invited. Consumed so it cannot be shown or retried again; no onApproved follow-up.
      try {
        await consumeRequest(request);
      } catch (e) {
        onError(e);
      }
      return { ok: false, error: 'request-expired' };
    }
    let group: InviteGroup | undefined;
    try {
      group = await getGroup(request.groupId);
    } catch (e) {
      return { ok: false, error: 'invite-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    if (!group) return { ok: false, error: 'group-missing' };
    let result: Awaited<ReturnType<KeyPackageInviter['inviteByPubkey']>>;
    try {
      result = await inviter.inviteByPubkey(group, request.pubkeyHex.toLowerCase());
    } catch (e) {
      return { ok: false, error: 'invite-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    if ('error' in result) {
      if (result.error === 'already-member') {
        await settle(request, 'already-member');
        return { ok: true, kind: 'already-member' };
      }
      return { ok: false, error: 'no-usable-key-package', reason: result.reason };
    }
    await settle(request, 'invited');
    return { ok: true, kind: 'invited', welcomeStatus: result.outcome.status };
  }

  const approve = (request: PendingJoinRequest): Promise<ApprovalResult> => {
    if (!request || typeof request.eventId !== 'string' || typeof request.groupId !== 'string' || typeof request.pubkeyHex !== 'string') {
      throw new TypeError('approve: request must be a PendingJoinRequest');
    }
    const existing = inFlight.get(request.eventId);
    if (existing) return existing;
    const promise = new Promise<ApprovalResult>((resolve) => {
      let rejected = false;
      try {
        rejected =
          enqueue(async () => {
            try {
              resolve(await run(request));
            } catch (e) {
              resolve({ ok: false, error: 'invite-failed', detail: e instanceof Error ? e.message : String(e) });
            }
          }) === false;
      } catch (e) {
        onError(e);
        rejected = true;
      }
      if (rejected) resolve({ ok: false, error: 'queue-unavailable' });
    }).finally(() => {
      inFlight.delete(request.eventId);
    });
    inFlight.set(request.eventId, promise);
    return promise;
  };

  return { approve };
}
