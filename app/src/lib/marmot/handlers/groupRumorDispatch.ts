/**
 * groupRumorDispatch.ts — turns the per-kind app handlers into the history
 * sink's `GroupHistoryHandlers` (seam `GroupHistoryHandlers`, consumer side).
 *
 *   history sink `append`   -> `dispatch({groupId, eventId, rumor, sender})`
 *   history sink `withdraw` -> `retract({groupId, eventId, rumor, sender})`
 *
 * Rules this module owns:
 *   - Attribution is `input.sender` (the sink sets it from
 *     `HistoryEntry.orderingKey.account`, the MLS-authenticated sender), never
 *     the rumor's own `pubkey` field. The handlers receive it as the
 *     `AuthenticatedSender`; nothing here (or in `handlers/`) reads the rumor's
 *     pubkey (guarded by handlersRumorPubkeyBoundary.test.ts).
 *   - Only kinds in the app registry (`APP_RUMOR_KINDS`) may be registered: a
 *     handler for any other kind makes `createGroupRumorDispatch` throw at
 *     construction (the sink never delivers other kinds anyway).
 *   - A rumor whose kind has no registered handler is a no-op (completes).
 *   - A handler failure propagates: the sink then keeps the row undispatched
 *     and the library retries, so every handler must be idempotent per
 *     `(groupId, eventId)`. Handlers of one rumor run sequentially in
 *     registration order; a later one does not run after an earlier one threw.
 *   - Message-store bumps (chat / reaction / delete-edit versions) are driven by
 *     handler completion, i.e. from inside this dispatch. `group.onNotification`
 *     is NOT a message source (D13): see `createGroupNotificationRouter`.
 *   - Dispatch/retract never await account-scope client calls; follow-up client
 *     writes are enqueued on the owned FIFO as the handler's LAST action.
 *
 * Pure module: no React, no context, no client construction.
 */
import type { GroupNotification } from '@941design/marmot';
import { APP_RUMOR_KINDS } from '@/src/lib/marmot/kinds';
import type { GroupHistoryHandlers, GroupRumorInput } from '@/src/lib/marmot/history';
import type { AuthenticatedSender, DispatcherContext } from '@/src/lib/marmot/handlers/types';

/** Account-level facts a handler needs besides the rumor itself. */
export interface GroupHandlerEnv {
  /** The local account's pubkey (lowercase hex). */
  selfPubkeyHex: string;
  /** The group whose detail view is open, or null. */
  getActiveGroupId: () => string | null;
}

/**
 * One app kind's handler on the new sink path. `RumorHandler` (the old
 * dispatcher path) is kept on the same object until the old path is removed
 * (S22); the factories return `GroupKindHandler & RumorHandler`.
 */
export interface GroupKindHandler {
  kind: number;
  /** Idempotent per `(groupId, eventId)`; throws on a durable failure. */
  dispatch(input: GroupRumorInput, env: GroupHandlerEnv): Promise<void>;
  /**
   * Undoes the STORED effects of a withdrawn rumor. Effects already emitted
   * (bell, known-peers, follow-up sends) stay (AC-WDR-6). Removes nothing for
   * a rumor the handler never applied, but always runs the idempotent
   * recompute-and-bump tail (a retry after a partial failure converges); a
   * stored row goes only when its last carrier is withdrawn and the stored
   * sender matches the withdrawing sender.
   */
  retract(input: GroupRumorInput, env: GroupHandlerEnv): Promise<void>;
}

/** The old-path handler arguments for a sink input: `ctx` from the env, `sender` bound to `input.sender`. */
export function toHandlerArgs(
  input: GroupRumorInput,
  env: GroupHandlerEnv,
): { ctx: DispatcherContext; sender: AuthenticatedSender } {
  return {
    ctx: { groupId: input.groupId, selfPubkeyHex: env.selfPubkeyHex, getActiveGroupId: env.getActiveGroupId },
    // The sink only ever delivers MLS-authenticated senders.
    sender: { pubkey: input.sender, authenticity: 'mls' },
  };
}

/**
 * Fails at construction, naming the port, when a required dependency is not a
 * function (a type cast or an untyped caller must not turn an unwired port into
 * silence at the first dispatch/retract).
 */
export function assertPorts(factory: string, deps: object, ports: readonly string[]): void {
  if (!deps || typeof deps !== 'object') throw new TypeError(`${factory}: deps are required`);
  for (const port of ports) {
    if (typeof (deps as Record<string, unknown>)[port] !== 'function') {
      throw new TypeError(`${factory}: required port "${port}" is missing or not a function`);
    }
  }
}

export interface GroupRumorDispatchOptions {
  handlers: readonly GroupKindHandler[];
  env: GroupHandlerEnv;
}

const REGISTERED_KINDS: ReadonlySet<number> = new Set(APP_RUMOR_KINDS);

export function createGroupRumorDispatch(options: GroupRumorDispatchOptions): GroupHistoryHandlers {
  if (!options?.env) throw new TypeError('createGroupRumorDispatch: env is required');
  const { handlers, env } = options;
  if (typeof env.selfPubkeyHex !== 'string') throw new TypeError('createGroupRumorDispatch: required env field "selfPubkeyHex" is missing or not a string');
  assertPorts('createGroupRumorDispatch', env, ['getActiveGroupId']);
  if (!Array.isArray(handlers)) throw new TypeError('createGroupRumorDispatch: required port "handlers" is missing or not an array');
  for (const handler of handlers) {
    assertPorts(`createGroupRumorDispatch handler for kind ${handler?.kind}`, handler, ['dispatch', 'retract']);
    if (!REGISTERED_KINDS.has(handler.kind)) {
      throw new Error(`createGroupRumorDispatch: kind ${handler.kind} is not an app rumor kind`);
    }
  }
  const matching = (input: GroupRumorInput) => handlers.filter((h) => h.kind === input.rumor.kind);
  return {
    async dispatch(input) {
      for (const handler of matching(input)) await handler.dispatch(input, env);
    },
    async retract(input) {
      for (const handler of matching(input)) await handler.retract(input, env);
    },
  };
}

/** What the app resyncs on a group notification (member, admin, name, disband only). */
export interface GroupResyncTargets {
  members: (groupId: string) => void;
  admins: (groupId: string) => void;
  name: (groupId: string) => void;
  disband: (groupId: string) => void;
}

/**
 * The `onGroupNotification` routing (D13): drives ONLY member, admin, name and
 * disband resync. `message` / `message-withdrawn` notifications are ignored —
 * message stores move from handler completion inside the history sink, and the
 * two paths are independent and may race, so a notification must never bump a
 * message store. Every other notification type is ignored here.
 *
 * `applied` kinds (library state-notification names): a member added/removed or
 * the local account removed -> members; a component change (group data: name
 * and admin list share it) -> admins and name.
 */
export function createGroupNotificationRouter(
  targets: GroupResyncTargets,
): (groupId: string, notification: GroupNotification) => void {
  return (groupId, notification) => {
    switch (notification.type) {
      case 'applied':
      case 'withdrawn':
        switch (notification.kind) {
          case 'memberAdded':
          case 'memberRemoved':
          case 'selfRemoved':
            targets.members(groupId);
            return;
          case 'componentChanged':
            targets.admins(groupId);
            targets.name(groupId);
            return;
          default:
            return;
        }
      case 'leaf-removed':
      case 'leaf-removal-withdrawn':
        targets.members(groupId);
        return;
      case 'group-disbanded':
        targets.disband(groupId);
        return;
      default:
        // 'message', 'message-withdrawn' and the rest: not a resync source.
        return;
    }
  };
}
