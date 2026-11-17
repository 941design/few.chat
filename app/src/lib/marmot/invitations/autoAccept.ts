/**
 * Auto-accept of an invitation that answers an outbound join request (D8, AC-AUTO-1 / AC-AUTO-2).
 *
 * ONE mechanism: on `clientEvents.inboxDisposition` of kind `pending` the correlation runs against the outbound
 * join requests this device sent, and a match is accepted through `invitations.accept(id)` (the S9 actions). There is no
 * Welcome manifest and no `keyPackages.offer` / `expectWelcome`: everything that does not correlate simply stays pending
 * (ADR-002, pull-only).
 *
 * The existing AC-AUTO correlation rules are kept unchanged. A request is matched on the SPONSOR (the admin this device
 * asked: `sponsorAccount === record.adminPubkeyHex`) and only while it is unexpired (the store's TTL filter). The
 * requester never learns the group id (an invite link carries admin, nonce and name), so "the same group" is the group
 * NAME, compared after the same normalisation the invite context uses (`sanitizeContextName`):
 *   - the invitation's name is known (a context from that sponsor for that group is held): the candidates are narrowed
 *     to the records of that name and EXACTLY ONE must remain; zero or several never guess;
 *   - the name is NOT known (no context yet, or none ever): NEVER auto-accepted, even with a single record. The sponsor
 *     alone is not enough consent (a sponsor we asked about one group could invite us into another); the invitation stays
 *     a manual card, and `evaluate()` re-runs the correlation when the context arrives.
 * A record of another admin never matches, so an invitation from anyone else (stranger, other group or other sponsor)
 * stays pending with zero accept calls.
 *
 * Exactly once: the accept runs on the owned job queue (the listener only enqueues, as its last action, and enqueue
 * calls collapse while one is queued), jobs run one at a time, an invitation id that was accepted is remembered and never
 * accepted again, and the record is consumed after a SUCCESSFUL accept (a failed accept leaves it, so the user can accept
 * by hand and a later event may retry; ids whose accept failed are not remembered). Only invitations the pending view SHOWS
 * are considered (`view.refresh()` returns the shown set, so a blocked sponsor's invitation is never auto-accepted: a block
 * beats a correlation). The job's LAST action is `view.scheduleRefresh()` (the pending list changed).
 *
 * `evaluate()` re-runs the same job without a new event: for startup (after `view.seed()`) and for a context arriving
 * after the invitation (the name just became known).
 *
 * Re-entrancy: `onInboxDisposition` is a client listener: synchronous, no client call, enqueue last. `view.refresh`,
 * `actions.accept` and the stores run inside the job only. Pure module: ports are injected and validated at
 * construction; no React, no storage (the outbound store is a port, its production adapter lives in
 * `outboundJoinRequests.ts`).
 */
import type { PendingInvitation } from '@941design/marmot';
import { sanitizeContextName } from './inviteContext';
import type { InvitationActions } from './acceptDecline';
import type { PendingInvitationView } from './pendingView';

/** The slice of an outbound join-request record the correlation reads. */
export interface OutboundRequestRef {
  readonly nonce: string;
  /** Hex pubkey of the admin the request was sent to. */
  readonly adminPubkeyHex: string;
  /** The group name from the invite link. */
  readonly groupName: string;
}

export interface AutoAcceptDeps {
  view: Pick<PendingInvitationView, 'refresh' | 'scheduleRefresh'>;
  actions: Pick<InvitationActions, 'accept'>;
  /** `AccountClientHandle.enqueue`; `false` = not accepted (queue disposed). */
  enqueue: (job: () => Promise<void>) => boolean | void;
  outbound: {
    /** The UNEXPIRED outbound records of one admin (production: `loadUnexpiredOutboundJoinRequestsForAdmin`). */
    loadUnexpiredForAdmin: (adminPubkeyHex: string) => Promise<readonly OutboundRequestRef[]>;
    /** Consumes one record by nonce (production: `deleteOutboundJoinRequest`). */
    consume: (nonce: string) => Promise<void>;
  };
  /** The sponsor-claimed name of an invitation's group (a validated invite context), or `undefined` when none is held yet. Sync, no client call. */
  groupNameOf: (invitation: Pick<PendingInvitation, 'id' | 'groupId' | 'sponsorAccount'>) => string | undefined;
  onError?: (error: unknown) => void;
}

export interface AutoAccept {
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
  requireFn(deps.view?.refresh, 'view.refresh');
  requireFn(deps.view?.scheduleRefresh, 'view.scheduleRefresh');
  requireFn(deps.actions?.accept, 'actions.accept');
  requireFn(deps.enqueue, 'enqueue');
  requireFn(deps.outbound?.loadUnexpiredForAdmin, 'outbound.loadUnexpiredForAdmin');
  requireFn(deps.outbound?.consume, 'outbound.consume');
  requireFn(deps.groupNameOf, 'groupNameOf');
  const { view, actions, enqueue, outbound, groupNameOf } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] auto-accept', e));

  let disposed = false;
  let queued = false;
  let running: Promise<void> = Promise.resolve();
  /** Invitation ids whose accept succeeded: never accepted twice. */
  const accepted = new Set<string>();
  /** Nonces whose record was used by a successful accept, even when deleting it failed: never matched again. */
  const consumedNonces = new Set<string>();

  /** The single outbound record this invitation answers, or `undefined` (never guesses). */
  async function resolveRecord(invitation: PendingInvitation): Promise<OutboundRequestRef | undefined> {
    const candidates = await outbound.loadUnexpiredForAdmin(lower(invitation.sponsorAccount));
    const forSponsor = candidates.filter(
      (c) => lower(c.adminPubkeyHex) === lower(invitation.sponsorAccount) && !consumedNonces.has(c.nonce),
    );
    if (forSponsor.length === 0) return undefined;
    const claimed = groupNameOf(invitation);
    if (claimed === undefined) return undefined; // consent needs the sponsor-claimed name
    const name = sanitizeContextName(claimed);
    if (name.length === 0) return undefined;
    const byName = forSponsor.filter((c) => sanitizeContextName(c.groupName) === name);
    return byName.length === 1 ? byName[0] : undefined;
  }

  async function correlate(): Promise<void> {
    let shown: readonly PendingInvitation[] = [];
    try {
      shown = await view.refresh();
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
        try {
          await actions.accept(invitation.id);
        } catch (e) {
          onError(e); // stays pending: the user can accept by hand; the record is kept
          continue;
        }
        accepted.add(invitation.id);
        consumedNonces.add(record.nonce);
        try {
          await outbound.consume(record.nonce);
        } catch (e) {
          onError(e);
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
