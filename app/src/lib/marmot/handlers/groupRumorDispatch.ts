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
import type { GroupHistoryHandlers, GroupRumorInput, RetractInput } from '@/src/lib/marmot/history';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RecomputeSignal } from '@/src/lib/marmot/handlers/types';

/** Account-level facts a handler needs besides the rumor itself. */
interface GroupHandlerEnv {
  /** The local account's pubkey (lowercase hex). */
  selfPubkeyHex: string;
  /** The group whose detail view is open, or null. */
  getActiveGroupId: () => string | null;
}

/** One kind of retained group rumor. */
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
  retract(input: RetractInput, env: GroupHandlerEnv): Promise<void>;
  /**
   * The aggregate this retract RECOMPUTES (kind family + aggregate key, e.g. `reactions:<target>`), or undefined
   * when the retract is per row (carrier accounting, purge, malformed rumor). A recompute reads the batch's one
   * `remaining()` snapshot, which already omits every withdrawn row, so within one withdraw batch the second and
   * later retracts of a key would repeat the first one's work: the dispatch layer runs ONE retract per key and
   * batch (the handler sees the whole batch in `RetractInput.batch`) and lets the other rows of the key pass.
   */
  retractKey?(input: RetractInput): string | undefined;
}

/**
 * The remaining history rows of the group (`input.remaining()`) that `accept` selects, as recompute signals in
 * `seq` order. `sender` is the row's `orderingKey.account`; the rumor's own pubkey is never read.
 */
export async function remainingSignals(
  input: RetractInput,
  accept: (rumor: ApplicationRumor) => boolean,
): Promise<RecomputeSignal[]> {
  const rows = await input.remaining();
  return rows
    .filter((row) => accept(row.entry.rumor as ApplicationRumor))
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      rumor: row.entry.rumor as ApplicationRumor,
      sender: row.entry.orderingKey.account,
      eventId: row.entry.eventId,
      seq: row.seq,
      receivedAt: row.receivedAt,
    }));
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

interface GroupRumorDispatchOptions {
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
  // One retract per aggregate key (family + key) per withdraw batch. A batch shares ONE `remaining` function, so it
  // identifies the batch; the entry is a settled-or-pending promise and a failed retract is dropped again (the
  // withdraw rejects and the retry starts a new batch).
  const retracted = new WeakMap<object, Map<string, Promise<void>>>();
  return {
    async dispatch(input) {
      for (const handler of matching(input)) await handler.dispatch(input, env);
    },
    async retract(input) {
      for (const handler of matching(input)) {
        if (input.cancelled?.()) return;
        const key = handler.retractKey?.(input);
        if (key === undefined || typeof input.remaining !== 'function') {
          await handler.retract(input, env);
          continue;
        }
        let done = retracted.get(input.remaining);
        if (!done) retracted.set(input.remaining, (done = new Map()));
        const scoped = key; // keys name their own family (`slot:`, `reactions:`, `poll:`), so kinds of one family share it
        const earlier = done.get(scoped);
        if (earlier) {
          await earlier;
          continue;
        }
        const running = handler.retract(input, env);
        done.set(scoped, running);
        try {
          await running;
        } catch (error) {
          done.delete(scoped);
          throw error;
        }
      }
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
 * message store. An own change lost to a fork refreshes the current views.
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
      case 'own-change-lost':
        console.warn('[membership] own-change-lost', groupId, notification.change.type, notification.reason);
        targets.members(groupId);
        targets.admins(groupId);
        targets.name(groupId);
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
