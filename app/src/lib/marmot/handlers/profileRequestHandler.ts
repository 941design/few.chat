/**
 * profileRequestHandler.ts
 *
 * RumorHandler for PROFILE_REQUEST_KIND (kind 30).
 *
 * Mirrors the PROFILE_REQUEST_KIND branch of MarmotContext.onApplicationMessage.
 * All side-effect dependencies are injected — zero imports from
 * app/src/context/.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { PROFILE_REQUEST_KIND, parseProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import type { ProfileRequestPayload } from '@/src/lib/marmot/profileRequestSync';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/handlers/types';
import { assertPorts, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createGroupGates, type GroupOf } from '@/src/lib/marmot/handlers/groupGates';
import type { GroupRumorInput } from '@/src/lib/marmot/history';

export interface ProfileRequestHandlerDeps {
  /** AC-032: record every observed request regardless of target. */
  recordRequestEmitted: (groupId: string, targetPubkey: string, timestamp: number) => Promise<void>;
  /**
   * AC-030: self-target reply — called when request.targetPubkey === ctx.selfPubkeyHex.
   * MarmotContext provides this as a closure that signs our current profile and
   * calls sendRumorSafe on the mlsGroup.
   */
  sendSelfProfile: (groupId: string) => Promise<void>;
  /**
   * AC-031: relay path — called when request.targetPubkey !== ctx.selfPubkeyHex.
   * MarmotContext provides this as a pre-bound closure (loadProfile + sendRumor
   * already captured from context scope).
   */
  handleIncomingProfileRequest: (args: {
    groupId: string;
    payload: ProfileRequestPayload;
  }) => Promise<void>;
}

/**
 * Every step here is best-effort and never throws (remediation round 1): a
 * profile request is retried by its sender (profileRequestRunner's sweep keeps
 * re-asking until an answer lands — AC-SEND-10), so a failure is not worth
 * keeping the rumor journaled. A replay would also only answer a stale
 * request or skew the observed-request timestamp.
 */
async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ProfileRequestHandlerDeps): Promise<void> {
  const reqPayload = parseProfileRequestPayload(rumor.content);
  if (!reqPayload) return;

  // AC-032: record every observed request for deduplication across the group.
  try {
    await deps.recordRequestEmitted(ctx.groupId, reqPayload.targetPubkey, Date.now());
  } catch (err) {
    console.warn('[dispatcher.profileRequest] recording the observed request failed:', err);
  }

  try {
    if (reqPayload.targetPubkey === ctx.selfPubkeyHex) {
      // AC-030: we are the target — reply immediately with our current profile.
      await deps.sendSelfProfile(ctx.groupId);
    } else {
      // AC-031: not our target — delegate to relay handler (AC-033/034).
      await deps.handleIncomingProfileRequest({
        groupId: ctx.groupId,
        payload: reqPayload,
      });
    }
  } catch (err) {
    console.warn('[dispatcher.profileRequest] answering the request failed; the requester retries:', err);
  }
}

export function createProfileRequestHandler(deps: ProfileRequestHandlerDeps): RumorHandler {
  return {
    kind: PROFILE_REQUEST_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}

/** Deps of the history-sink path: the legacy ports plus the live group handle and the client FIFO. */
export interface ProfileRequestGroupHandlerDeps extends ProfileRequestHandlerDeps {
  /** The live group handle (`client.groups.get`); the roster gate reads `group.members()` from it. */
  groupOf: GroupOf;
  /** The owned client FIFO (`ClientJobQueue['enqueue']`): the reply (a group write) is queued on it. */
  enqueue: (job: () => Promise<void>) => void;
}

const PROFILE_REQUEST_GROUP_PORTS = ['recordRequestEmitted', 'sendSelfProfile', 'handleIncomingProfileRequest', 'groupOf', 'enqueue'] as const;

const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Kind-30 handler on the history-sink path (sender = the MLS-authenticated
 * account).
 *
 * Gate (AC-HIST-11): the requester must be a CURRENT member of the group per
 * the live `group.members()` (via `groupOf`): a request from anyone else
 * (a member removed since, a group no longer held — fail closed) is ignored
 * without recording or answering, so our profile is never sent on behalf of a
 * non-member. A `groupOf` rejection rejects the row (it stays undispatched
 * and is retried). Our own request echo (the sink also delivers own messages)
 * is not answered.
 *
 * The reply — our own profile when we are the target, else the relay-on-behalf
 * handling — is a client write, so it is enqueued on the FIFO as the LAST
 * action after the awaited recording and never awaited here; it is best-effort
 * (the requester keeps asking until an answer lands).
 *
 * retract is a deliberate no-op: the request only recorded an observation
 * timestamp and queued a reply, and effects already emitted (follow-up sends)
 * are never undone (AC-WDR-6).
 */
export function createProfileRequestGroupHandler(deps: ProfileRequestGroupHandlerDeps): GroupKindHandler & RumorHandler {
  assertPorts('createProfileRequestGroupHandler', deps, PROFILE_REQUEST_GROUP_PORTS);
  const gates = createGroupGates(deps.groupOf);
  return {
    ...createProfileRequestHandler(deps),
    async dispatch(input: GroupRumorInput, env) {
      const { ctx, sender } = toHandlerArgs(input, env);
      const reqPayload = parseProfileRequestPayload((input.rumor as ApplicationRumor).content);
      if (!reqPayload) return;
      if (sameKey(sender.pubkey, env.selfPubkeyHex)) return;
      if (!(await gates.isGroupMember(ctx.groupId, sender.pubkey))) return;

      try {
        await deps.recordRequestEmitted(ctx.groupId, reqPayload.targetPubkey, Date.now());
      } catch (err) {
        console.warn('[dispatcher.profileRequest] recording the observed request failed:', err);
      }

      deps.enqueue(async () => {
        try {
          if (sameKey(reqPayload.targetPubkey, env.selfPubkeyHex)) {
            await deps.sendSelfProfile(ctx.groupId);
          } else {
            await deps.handleIncomingProfileRequest({ groupId: ctx.groupId, payload: reqPayload });
          }
        } catch (err) {
          console.warn('[dispatcher.profileRequest] answering the request failed; the requester retries:', err);
        }
      });
    },
    async retract() {
      // See the doc comment: nothing stored to undo.
    },
  };
}
