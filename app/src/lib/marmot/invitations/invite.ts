/**
 * Invite by pubkey (D10, seam `KeyPackageInvite`, AC-KP-1).
 *
 * `inviteByPubkey(group, pubkey)` looks the invitee's key packages up (no group lock held: the lookup waits
 * on the network), then offers them to `group.invite` ONE AT A TIME, newest first (created_at desc, tie lower
 * event id): the library adds one leaf per event and rejects the whole call when any single event is invalid,
 * so passing several would let one stale key package block the invite. A rejection of THAT candidate
 * (`invalid-options` with `details.reason` verifier / invalid-keypackage / ineligible) falls through to the
 * next candidate; the first accepted call stops the walk; exhaustion (or no key package at all) is the value
 * `{ error: 'no usable key package' }`, never a throw.
 *
 * No double add: a key package carries a fresh leaf, so a rotated key package of someone who is already a
 * member would add a SECOND leaf for the same account. Inside the queued op (after the bounded `synced()`,
 * when the member list is current) the pubkey is checked against `group.leaves(pubkey)`; a holder yields the
 * value `{ error: 'already-member' }` and `group.invite` is not called. The same check also runs BEFORE the
 * lookup on the (possibly stale) current member list, so a known member costs no relay request.
 *
 * Every attempt goes through the S6 `GroupOpQueue` (`runCommit`): one in-flight commit per group, `synced()`
 * awaited first (bounded and abortable), self-clearing `commit-pending` retried. Errors that are not a
 * candidate rejection (`GroupOpError` not-synced / aborted, surfaced `commit-pending`, `not-admin`, a
 * reason-less `invalid-options` such as "group has no relays", ...) are thrown unchanged and end the walk:
 * they say nothing about the candidates. An abort is normalised to `GroupOpError('aborted')` wherever it
 * happens (during the lookup too).
 *
 * Re-entrancy: never call this from a library frame (history sink, inbox handler, client listener): schedule
 * it with the client job queue (`handle.enqueue`); an account-scope client call there rejects `reentrant`.
 * Join-request approval (S12) therefore calls it from its own queued job.
 *
 * A fall-through happens before anything is recorded (the library validates the events first), so a skipped
 * candidate leaves no commit behind. Pure module: ports are injected and validated at construction.
 */
import { isMarmotError } from '@941design/marmot';
import type { MarmotGroup, WelcomeOutcome } from '@941design/marmot';
import type { NostrEvent } from '@941design/nostr-events/event';
import { GroupOpError, type GroupOpOptions, type GroupOpQueue } from '../send';
import type { KeyPackageLookup } from './keyPackageLookup';

/** The slice of `MarmotGroup` an invite uses. */
export type InviteGroup = Pick<MarmotGroup, 'id' | 'synced' | 'invite' | 'leaves'> & { ingest?: MarmotGroup['ingest'] };

/** An accepted invite: the Welcome outcome of the one invitee and the key package that carried it. */
export interface InviteOutcome {
  outcome: WelcomeOutcome;
  keyPackageEventId: string;
  /** Candidates offered to `group.invite` (1 = the newest was accepted). */
  attempts: number;
}

export interface NoUsableKeyPackage {
  error: 'no usable key package';
  /** Why: nothing was found, the lookup hit its deadline with nothing, or every candidate was rejected. */
  reason: 'none-found' | 'timed-out' | 'all-rejected';
  attempts: number;
}

/** The invitee already holds a leaf of the group: nothing was looked up for a commit and no commit was made. */
export interface AlreadyMember {
  error: 'already-member';
}

export interface InviteOptions {
  signal?: AbortSignal;
  /** Bound of the `synced()` wait of each attempt (queue default 30 s). */
  syncTimeoutMs?: number;
}

export interface KeyPackageInviter {
  inviteByPubkey: (group: InviteGroup, pubkey: string, opts?: InviteOptions) => Promise<InviteOutcome | NoUsableKeyPackage | AlreadyMember>;
}

export interface KeyPackageInviterDeps {
  lookup: KeyPackageLookup;
  queue: Pick<GroupOpQueue, 'runCommit'>;
}

/** `invalid-options` reasons that are the verdict on ONE key package event (library `validateInvitees`). */
const CANDIDATE_REJECTION_REASONS: ReadonlySet<unknown> = new Set(['verifier', 'invalid-keypackage', 'ineligible']);

/**
 * A rejection of THIS candidate: `invalid-options` whose `details.reason` is on the allowlist (and, when the
 * library names an event, names this one). Everything else is about the group or the caller and is true for
 * every candidate, so it is surfaced, not walked: `not-admin`, `no-invitees`, a group-level `duplicate`, the
 * reason-less "group has no relays" ...
 */
function isCandidateRejection(error: unknown, candidateId: string): boolean {
  if (!isMarmotError(error, 'invalid-options')) return false;
  const details = error.details as { reason?: unknown; eventId?: unknown } | undefined;
  if (!CANDIDATE_REJECTION_REASONS.has(details?.reason)) return false;
  return details?.eventId === undefined || details.eventId === candidateId;
}

/** The abort of `signal`, in the one shape the caller handles. */
const abortedError = () => new GroupOpError('aborted', 'inviteByPubkey: aborted');

const ALREADY_MEMBER = Symbol('already-member');

export function createKeyPackageInviter(deps: KeyPackageInviterDeps): KeyPackageInviter {
  if (!deps || typeof deps !== 'object') throw new TypeError('createKeyPackageInviter: deps are required');
  if (!deps.lookup || typeof deps.lookup.lookup !== 'function') throw new TypeError('createKeyPackageInviter: required dependency "lookup.lookup" is missing');
  if (!deps.queue || typeof deps.queue.runCommit !== 'function') throw new TypeError('createKeyPackageInviter: required dependency "queue.runCommit" is missing');
  const { lookup, queue } = deps;

  return {
    async inviteByPubkey(group, pubkey, opts = {}) {
      if (!group || typeof group.invite !== 'function' || typeof group.synced !== 'function' || typeof group.leaves !== 'function') {
        throw new TypeError('inviteByPubkey: group must be a MarmotGroup');
      }
      if (opts.signal?.aborted) throw abortedError();
      // Cheap pre-check on the current member list: no network lookup for someone who already holds a leaf.
      // Authoritative check stays inside the queued op (after synced()).
      if (group.leaves(pubkey).length > 0) return { error: 'already-member' };
      let found: Awaited<ReturnType<KeyPackageLookup['lookup']>>;
      try {
        found = await lookup.lookup(pubkey, { signal: opts.signal });
      } catch (error) {
        if (opts.signal?.aborted && !(error instanceof TypeError)) throw abortedError();
        throw error;
      }
      if (!found.ok) return { error: 'no usable key package', reason: found.reason, attempts: 0 };

      const queueOptions: GroupOpOptions = { signal: opts.signal, syncTimeoutMs: opts.syncTimeoutMs };
      let attempts = 0;
      for (const candidate of found.candidates as readonly NostrEvent[]) {
        attempts++;
        try {
          const outcomes = await queue.runCommit(
            group,
            async () => (group.leaves(pubkey).length > 0 ? ALREADY_MEMBER : group.invite([candidate])),
            queueOptions,
          );
          if (outcomes === ALREADY_MEMBER) return { error: 'already-member' };
          const outcome = outcomes[0];
          if (!outcome) throw new Error('inviteByPubkey: group.invite returned no outcome for the one invitee');
          return { outcome, keyPackageEventId: candidate.id, attempts };
        } catch (error) {
          if (!isCandidateRejection(error, candidate.id)) throw error;
        }
      }
      return { error: 'no usable key package', reason: 'all-rejected', attempts };
    },
  };
}
