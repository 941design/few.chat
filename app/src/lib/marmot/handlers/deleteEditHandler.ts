/**
 * Applies kind-5 delete and edit signals through shared reconciliation.
 * Reconciliation retains signals for targets that have yet to arrive and
 * authorizes against the authenticated MLS sender provided by the history sink.
 */

import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RecomputeSignal } from '@/src/lib/marmot/handlers/types';
import { deleteEditSlotIds, type ApplyDeleteEditOptions, type ChangeResult, type InboundDeleteEditRumor, type MessageEditsThreadKey } from '@/src/lib/messageEdits/api';
import { DELETE_EDIT_RUMOR_KIND } from '@/src/lib/messageEdits/rumor';
import { assertPorts, remainingSignals, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import type { GroupRumorInput, RetractInput } from '@/src/lib/marmot/history';

/** Kind-5 rumor kind, narrowed to its literal type for `RumorHandler<5>`. */
const KIND: 5 = DELETE_EDIT_RUMOR_KIND as 5;

interface DeleteEditHandlerDeps {
  /** `options.receivedAt` (sink path only): the row's clock, the same one a recompute folds it with. */
  applyDeleteEditSignal: (
    thread: MessageEditsThreadKey,
    rumor: InboundDeleteEditRumor,
    sender: AuthenticatedSender,
    options?: ApplyDeleteEditOptions,
  ) => Promise<ChangeResult>;
  /**
   * Reused, not duplicated: the SAME setter chatHandler.ts already receives
   * via HandlerDeps (architecture.md seam #3's explicit 'reuse setChatVersion'
   * allowance). Bumping it triggers ChatStoreContext's existing chatVersion
   * re-read effect, which now also re-filters/reconciles storage truth
   * (`reconcileMessagesWithStorage`, ChatStoreContext.tsx).
   */
  setChatVersion: (updater: (v: number) => number) => void;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: DeleteEditHandlerDeps, receivedAt?: number): Promise<void> {
  const thread: MessageEditsThreadKey = { kind: 'group', groupId: ctx.groupId };

  // Storage failures propagate (bug: reaction-storage-failures): the
  // dispatcher then keeps the rumor journaled and handles it again at the
  // next subscription. applyDeleteEditSignal is replay-safe — a re-buffered
  // signal dedups by rumor id, a re-applied one no-ops on the slot's
  // recorded rumor id or re-writes the same tombstone/content at the same
  // rev. Invalid input never throws: it resolves 'discarded' / 'pending'.
  try {
    await (receivedAt === undefined
      ? deps.applyDeleteEditSignal(thread, rumor as InboundDeleteEditRumor, sender)
      : deps.applyDeleteEditSignal(thread, rumor as InboundDeleteEditRumor, sender, { receivedAt }));
  } finally {
    // S5 gate-remediation (finding 5): bump unconditionally for ANY
    // outcome, not only 'delete'/'edit'. applyDeleteEditSignal's sweep
    // (sweepExpiredForThreadKeyLocked, run at the top of every call) can
    // self-heal/materialize OTHER slots' storage as a side effect of
    // processing THIS rumor — mutations that are otherwise invisible to
    // ChatStoreContext until some later, unrelated chatVersion bump happens to
    // trigger its reconcile re-read. That includes a call that failed part
    // way, after some of those writes landed. A spurious bump is a cheap,
    // idempotent re-read (reconcileMessagesWithStorage is a no-op when
    // nothing actually changed).
    deps.setChatVersion((v) => v + 1);
  }
}

/** Deps of the history-sink path; the recompute port is REQUIRED (an unwired port must fail at construction). */
export interface DeleteEditGroupHandlerDeps extends DeleteEditHandlerDeps {
  /**
   * Recomputes the slots `slotIds` from the remaining signals (messageEdits/api `recomputeSlot`): reset to base,
   * fold in seq order through the dispatch core. `withdrawnRumorIds` names the withdrawn rumors (their pins go).
   */
  recomputeSlot: (
    thread: MessageEditsThreadKey,
    slotIds: readonly string[],
    signals: readonly RecomputeSignal[],
    options?: { withdrawnRumorIds?: readonly string[]; cancelled?: () => boolean },
  ) => Promise<void>;
}

/**
 * Recomputes the slots the withdrawn rumor names (every bare e-tag id of a kind-5, the marked e-tag id of an
 * edit-marked kind-9) from the remaining history rows. Exported for chatHandler's edit-marked branch. A rumor
 * naming no slot (a discarded signal, an edit-marked kind-5 companion) recomputes nothing and never reads history.
 */
export async function recomputeNamedSlots(
  recompute: DeleteEditGroupHandlerDeps['recomputeSlot'],
  thread: MessageEditsThreadKey,
  input: RetractInput,
): Promise<void> {
  const slotIds = deleteEditSlotIds(input.rumor as InboundDeleteEditRumor);
  if (slotIds.length === 0) return;
  const named = new Set(slotIds);
  const signals = await remainingSignals(input, (r) => deleteEditSlotIds(r as InboundDeleteEditRumor).some((id) => named.has(id)));
  if (input.cancelled?.()) return;
  // ONE recompute serves every withdrawn row of the batch that names these slots (the dispatch layer runs a single
  // retract per `slotRetractKey`), so the pins of all of them go with it, not only this row's.
  const withdrawn = (input.batch ?? [input]).filter((w) => deleteEditSlotIds(w.rumor as InboundDeleteEditRumor).some((id) => named.has(id)));
  await recompute(thread, slotIds, signals, {
    withdrawnRumorIds: [...new Set([input.rumor.id, ...withdrawn.map((w) => w.rumor.id)])],
    ...(input.cancelled && { cancelled: input.cancelled }),
  });
}

/**
 * The retract key of a rumor that recomputes delete/edit slots: the sorted slot ids it names (a kind-5 and an
 * edit-marked kind-9 naming the same slots share it), or undefined for a rumor naming none and for a purged retract.
 */
export function slotRetractKey(input: RetractInput): string | undefined {
  if (input.reason === 'purged') return undefined;
  const slotIds = deleteEditSlotIds(input.rumor as InboundDeleteEditRumor);
  return slotIds.length === 0 ? undefined : `slot:${JSON.stringify([...new Set(slotIds)].sort())}`;
}

/**
 * Kind-5 handler on the history-sink path (sender = the MLS-authenticated
 * account). dispatch routes every rumor to `applyDeleteEditSignal`
 * unconditionally: a signal whose target has not arrived (or is gone) is
 * buffered or discarded there, never an error — the tolerance a dependent kind
 * needs when a later entry overlaps an earlier still-running dispatch. Both
 * directions bump the chat version unconditionally (see `handle`).
 */
export function createDeleteEditGroupHandler(deps: DeleteEditGroupHandlerDeps): GroupKindHandler {
  assertPorts('createDeleteEditGroupHandler', deps, ['applyDeleteEditSignal', 'setChatVersion', 'recomputeSlot']);
  return {
    kind: KIND,
    async dispatch(input: GroupRumorInput, env) {
      const { ctx, sender } = toHandlerArgs(input, env);
      await handle(input.rumor as ApplicationRumor, ctx, sender, deps, input.receivedAt);
    },
    retractKey: slotRetractKey,
    async retract(input: RetractInput, env) {
      const { ctx } = toHandlerArgs(input, env);
      try {
        // A purged retract (the group was left) does no fold: its data is going away.
        if (input.reason !== 'purged') {
          await recomputeNamedSlots(deps.recomputeSlot, { kind: 'group', groupId: ctx.groupId }, input);
        }
      } finally {
        if (!input.cancelled?.()) deps.setChatVersion((v) => v + 1);
      }
    },
  };
}
