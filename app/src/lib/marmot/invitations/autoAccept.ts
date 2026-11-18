/**
 * Auto-accept of an invitation that answers an outbound join request (D8, AC-AUTO-1 / AC-AUTO-2).
 *
 * ONE mechanism: on `clientEvents.inboxDisposition` of kind `pending` the correlation runs against the outbound
 * join requests this device sent, and a match is accepted through `invitations.accept(id)` (the S9 actions). There is no
 * Welcome manifest and no `keyPackages.offer` / `expectWelcome`: everything that does not correlate simply stays pending
 * (ADR-002, pull-only).
 *
 * The existing AC-AUTO correlation rules are kept unchanged. A request is matched on the SPONSOR (the admin this device
 * asked: `sponsorAccount === record.adminPubkeyHex`) and only for the authenticated requester, while the request
 * is unexpired and the invitation was received at or after the request's send time. The
 * requester never learns the group id (an invite link carries admin, nonce and name), so "the same group" is the group
 * NAME, compared after the same normalisation the invite context uses (`sanitizeContextName`):
 *   - the invitation's name is known (a context from that sponsor for that group is held): retry its matching claim
 *     if present, otherwise require exactly one unclaimed record of that name;
 *   - the name is NOT known (no context yet, or none ever): NEVER auto-accepted, even with a single record. The sponsor
 *     alone is not enough consent (a sponsor we asked about one group could invite us into another); the invitation stays
 *     a manual card, and `evaluate()` re-runs the correlation when the context arrives.
 * A record of another admin never matches, so an invitation from anyone else (stranger, other group or other sponsor)
 * stays pending with zero accept calls.
 *
 * The owned queue runs one job at a time. Inside the group lock, the accept action calls back into auto-accept
 * to recheck eligibility and commit a claim binding the request to the invitation id. A failed accept leaves
 * the invitation available for manual acceptance or retry.
 * A successful accept is remembered in the session, then the claimed record is deleted. If deletion fails or the
 * process stops before cleanup, the persisted claim prevents another invitation from using the record.
 * Only invitations returned by `view.refresh()` are considered, so a blocked sponsor's invitation is never auto-accepted.
 * The job's last action is `view.scheduleRefresh()`.
 *
 * Purge exclusion: the accept goes through `actions.accept`, which runs the library accept inside the purger's per-group
 * lock, so it waits for a running purge of the invitation's group and a purge started meanwhile waits for it. The
 * `purge` port is required (validated at construction); the correlation also waits out a running purge first, so
 * nothing is consumed behind a purge. (S13 edited this S12 path.)
 *
 * `evaluate()` re-runs the same job without a new event: for startup (after `view.seed()`) and for a context arriving
 * after the invitation (the name just became known).
 *
 * Re-entrancy: `onInboxDisposition` is a client listener: synchronous, no client call, enqueue last. `view.refresh`,
 * `actions.accept` and the store ports run inside the job only. Ports are injected and validated at construction.
 */
import type { PendingInvitation } from '@941design/marmot';
import { sanitizeContextName } from './inviteContext';
import type { InvitationActions, VerifyInvitationAccept } from './acceptDecline';
import type { LocalGroupPurger } from '../membership/purgeLocalGroup';
import {
  isOutboundJoinRequestExpired,
  type OutboundJoinRequestClaimResult,
  type OutboundJoinRequestConsent,
} from '../outboundJoinRequests';
import type { PendingInvitationView } from './pendingView';

export type OutboundRequestRef = Readonly<OutboundJoinRequestConsent>;

interface AutoAcceptDeps {
  accountPubkey: string;
  /** Throws if the session no longer owns the lease. */
  assertLease: () => void;
  now?: () => number;
  view: Pick<PendingInvitationView, 'refresh' | 'scheduleRefresh'>;
  actions: {
    /** Runs beforeJoin inside the group lock. False or rejection aborts before calling the SDK. */
    accept: (id: string, beforeJoin: VerifyInvitationAccept) => ReturnType<InvitationActions['accept']>;
  };
  /** `AccountClientHandle.enqueue`; `false` = not accepted (queue disposed). */
  enqueue: (job: () => Promise<void>) => boolean | void;
  outbound: {
    /** The UNEXPIRED outbound records of one admin (production: `loadUnexpiredOutboundJoinRequestsForAdmin`). */
    loadUnexpiredForAdmin: (accountPubkey: string, adminPubkeyHex: string) => Promise<readonly OutboundRequestRef[]>;
    /** Returns an acquisition token only when this call created the claim. */
    claim: (accountPubkey: string, record: OutboundRequestRef, invitationId: string) => Promise<OutboundJoinRequestClaimResult>;
    /** Clears the exact acquisition and returns false if it has already changed or disappeared. */
    releaseClaim: (accountPubkey: string, record: OutboundRequestRef, invitationId: string, token: string) => Promise<boolean>;
    /** Deletes this send only if it is still claimed by this invitation id. */
    consume: (accountPubkey: string, record: OutboundRequestRef, invitationId: string) => Promise<void>;
  };
  /**
   * The local purger (`LocalGroupPurger`), REQUIRED. The exclusion itself is the per-group lock inside
   * `actions.accept` (every auto-accept goes through it, so it cannot be bypassed here); this port lets the
   * correlation wait out a running purge BEFORE it accepts and consumes anything (`whenPurged`).
   */
  purge: Pick<LocalGroupPurger, 'whenPurged'>;
  /** The sponsor-claimed name of an invitation's group (a validated invite context), or `undefined` when none is held yet. Sync, no client call. */
  groupNameOf: (invitation: Pick<PendingInvitation, 'id' | 'groupId' | 'sponsorAccount'>) => string | undefined;
  onError?: (error: unknown) => void;
}

interface AutoAccept {
  /** Client-listener entry (`clientEvents.inboxDisposition`): frame-safe, only enqueues the correlation job. */
  onInboxDisposition: (disposition: { readonly kind: string }) => void;
  /** Enqueues the correlation job (startup, a late invite context). Frame-safe. */
  evaluate: () => void;
  /** Resolves once the queued/running correlation job has settled (test / teardown aid). */
  idle: () => Promise<void>;
  dispose: () => void;
}

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new TypeError(`createAutoAccept: required dependency "${name}" is missing`);
}

const lower = (s: string) => s.toLowerCase();

export function createAutoAccept(deps: AutoAcceptDeps): AutoAccept {
  if (!deps) throw new TypeError('createAutoAccept: dependencies are required');
  if (typeof deps.accountPubkey !== 'string' || !deps.accountPubkey) {
    throw new TypeError('createAutoAccept: accountPubkey is required');
  }
  requireFn(deps.assertLease, 'assertLease');
  requireFn(deps.view?.refresh, 'view.refresh');
  requireFn(deps.view?.scheduleRefresh, 'view.scheduleRefresh');
  requireFn(deps.actions?.accept, 'actions.accept');
  requireFn(deps.enqueue, 'enqueue');
  requireFn(deps.outbound?.loadUnexpiredForAdmin, 'outbound.loadUnexpiredForAdmin');
  requireFn(deps.outbound?.claim, 'outbound.claim');
  requireFn(deps.outbound?.releaseClaim, 'outbound.releaseClaim');
  requireFn(deps.outbound?.consume, 'outbound.consume');
  requireFn(deps.groupNameOf, 'groupNameOf');
  requireFn(deps.purge?.whenPurged, 'purge.whenPurged');
  const { accountPubkey, assertLease, view, actions, enqueue, outbound, groupNameOf } = deps;
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] auto-accept', e));

  let disposed = false;
  let queued = false;
  let running: Promise<void> = Promise.resolve();
  /** Invitation ids whose accept succeeded: never accepted twice. */
  const accepted = new Set<string>();

  /** The single outbound record this invitation answers, or `undefined` (never guesses). */
  async function resolveRecord(invitation: PendingInvitation): Promise<OutboundRequestRef | undefined> {
    const sponsor = lower(invitation.sponsorAccount);
    const candidates = await outbound.loadUnexpiredForAdmin(accountPubkey, sponsor);
    const claimed = groupNameOf(invitation);
    if (claimed === undefined) return undefined; // consent needs the sponsor-claimed name
    const name = sanitizeContextName(claimed);
    if (name.length === 0) return undefined;
    const checkedAt = now();
    const byName = candidates.filter((record) =>
      record.accountPubkey === accountPubkey &&
      lower(record.adminPubkeyHex) === sponsor &&
      invitation.receivedAt >= record.sentAt &&
      !isOutboundJoinRequestExpired(record, checkedAt) &&
      sanitizeContextName(record.groupName) === name,
    );
    const existing = byName.filter((c) => c.claimedInvitationId === invitation.id);
    const eligible = existing.length > 0 ? existing : byName.filter((c) => c.claimedInvitationId === undefined);
    return eligible.length === 1 ? eligible[0] : undefined;
  }

  async function authorizeJoin(invitation: PendingInvitation, record: OutboundRequestRef): Promise<boolean> {
    if (disposed) return false;
    assertLease();
    const current = (await view.refresh()).find((item) => item.id === invitation.id);
    if (!current || current.groupId !== invitation.groupId ||
      lower(current.sponsorAccount) !== lower(invitation.sponsorAccount)) return false;

    const fresh = await resolveRecord(current);
    if (disposed || !fresh || fresh.nonce !== record.nonce || fresh.sentAt !== record.sentAt ||
      fresh.adminPubkeyHex !== record.adminPubkeyHex || fresh.groupName !== record.groupName) return false;
    assertLease();
    const claim = await outbound.claim(accountPubkey, fresh, invitation.id);
    if (claim?.kind !== 'acquired' && claim?.kind !== 'existing') return false;

    let authorized = false;
    try {
      if (disposed) return false;
      const name = groupNameOf(current);
      if (name === undefined || sanitizeContextName(name) !== sanitizeContextName(fresh.groupName)) return false;
      assertLease();
      authorized = !isOutboundJoinRequestExpired(fresh, now());
      return authorized;
    } finally {
      // A veto here precedes SDK accept. An earlier claim may already have reached the SDK.
      if (!authorized && claim.kind === 'acquired') {
        try {
          assertLease();
          await outbound.releaseClaim(accountPubkey, fresh, invitation.id, claim.token);
        } catch (error) {
          onError(new Error('Could not release the new outbound join request claim after the accept veto', { cause: error }));
        }
      }
    }
  }

  async function correlate(): Promise<void> {
    try {
      assertLease();
      const shown = await view.refresh();
      for (const invitation of shown) {
        if (disposed) return;
        if (accepted.has(invitation.id)) continue;
        let record: OutboundRequestRef | undefined;
        try {
          record = await resolveRecord(invitation);
        } catch (e) {
          onError(e);
          continue; // correlation never blocks the pending fallback
        }
        if (!record) continue;
        let authorized: boolean | undefined;
        try {
          await deps.purge.whenPurged(invitation.groupId);
          if (disposed) return;
          await actions.accept(invitation.id, async () => {
            authorized = await authorizeJoin(invitation, record);
            return authorized;
          });
        } catch (e) {
          if (authorized !== false) onError(e);
          continue;
        }
        if (!authorized) continue;
        accepted.add(invitation.id);
        for (let attempt = 0; attempt < 2 && !disposed; attempt += 1) {
          assertLease();
          try {
            await outbound.consume(accountPubkey, record, invitation.id);
            break;
          } catch (e) {
            onError(e);
          }
        }
      }
    } catch (e) {
      onError(e);
    } finally {
      // Last action: the pending list changed (an invitation was accepted, or the refresh itself failed).
      if (!disposed) {
        try {
          view.scheduleRefresh();
        } catch (e) {
          onError(e);
        }
      }
    }
  }

  const schedule = () => {
    if (disposed || queued) return;
    queued = true;
    let rejected = false;
    try {
      rejected =
        enqueue(async () => {
          queued = false;
          if (disposed) return;
          const run = correlate();
          running = run.catch(() => undefined);
          await run;
        }) === false;
    } catch (e) {
      onError(e);
      rejected = true;
    }
    if (rejected) queued = false;
  };

  return {
    onInboxDisposition: (disposition) => {
      if (disposition.kind === 'pending') schedule();
    },
    evaluate: schedule,
    idle: async () => {
      // A job that is queued but has not started yet is awaited by polling the macrotask queue once per turn.
      while (queued && !disposed) await new Promise((r) => setTimeout(r, 0));
      await running;
    },
    dispose: () => {
      disposed = true;
      queued = false;
    },
  };
}
