/**
 * deleteEditHandler.ts
 *
 * RumorHandler for kind-5 delete/edit signal rumors (group transport) — Seam
 * S5 consumer of S3's reconciliation core (applyDeleteEditSignal) and S2's
 * wire-builder constant (DELETE_EDIT_RUMOR_KIND).
 *
 * Receives all side-effect dependencies via the deps bag injected at
 * buildDispatcher(deps) time — no React context imports (architecture.md
 * boundary rule, ownership-ledger.json concept id 'handler-no-context-import').
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 *
 * ─── Deliberately NO pre-gate (unlike reactionHandler.ts's known-target gate) ─
 *
 * reactionHandler.ts silently discards a kind-7 reaction whose target message
 * is not yet known locally (a known-target gate BEFORE calling into the
 * reactions core). This handler does the OPPOSITE for kind-5: every inbound
 * rumor is routed to `applyDeleteEditSignal` UNCONDITIONALLY, with no
 * known-target check here at all. S3's `applyDeleteEditSignal` already
 * implements retain-and-apply for an unknown target (AC-ORDER-1: it buffers
 * the signal in its own pending store and applies it once the target
 * arrives) — architecture.md is explicit that this retain logic belongs
 * inside the shared reconciliation module, not reimplemented per-caller, so
 * adding a gate here would silently discard a signal S3 was built to retain.
 *
 * ─── The forwarded pubkey is the INNER rumor pubkey (NOT the kind-445 author) ─
 * ─── and it is now MLS-identity-bound: the authenticated sender (see below) ───
 *
 * This handler forwards the authenticated `sender` (AuthenticatedSender) to
 * `applyDeleteEditSignal`, which authorizes on `sender.pubkey`. That
 * `sender.pubkey` is the MLS-authenticated transport sender: marmot-ts 0.7.0
 * resolves it from the group's ratchet-tree credential and drops any
 * claimed-vs-authenticated mismatch before fan-out. That inner
 * pubkey is never the kind-445 wrapper's ephemeral author
 * (learning `kind-445-events-have-ephemeral-authors`).
 * `applicationRumorDispatcher.ts`'s listener calls `deserializeApplicationData`
 * on the MLS-decrypted application-message bytes and hands EVERY registered
 * handler that decoded rumor object directly — the kind-445 wrapper event
 * (with its ephemeral author) is never exposed past that point. `chatHandler.ts`
 * and `reactionHandler.ts` already rely on this identically.
 *
 * Trust model (marmot-ts 0.7.0 authenticated-sender forks — see the `ts-mls`
 * and `@internet-privacy/marmot-ts` git pins in app/package.json): this inner
 * `pubkey` IS cryptographically bound to the MLS sender. The library resolves
 * the authenticated sender leaf credential during unprotect and enforces that
 * the rumor's claimed `pubkey` matches it, dropping any mismatch (and
 * undeserializable bytes) before the message is delivered. So AC-AUTH-2's
 * group clause here is genuinely MLS-authenticated: a malicious current member
 * can no longer forge `pubkey` to impersonate another member — the
 * sender-leaf-drop gap (formerly `BACKLOG.json#marmot-ts-0-5-1-drops`) is
 * closed by the marmot-ts-authenticated-sender-migration epic (ADR-012).
 * DMs remain independently seal-signature bound.
 */

import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RecomputeSignal, RumorHandler } from '@/src/lib/marmot/handlers/types';
import { deleteEditSlotIds, type ApplyDeleteEditOptions, type ChangeResult, type InboundDeleteEditRumor, type MessageEditsThreadKey } from '@/src/lib/messageEdits/api';
import { DELETE_EDIT_RUMOR_KIND } from '@/src/lib/messageEdits/rumor';
import { assertPorts, remainingSignals, toHandlerArgs, type GroupKindHandler } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import type { GroupRumorInput, RetractInput } from '@/src/lib/marmot/history';

/** Kind-5 rumor kind, narrowed to its literal type for `RumorHandler<5>`. */
const KIND: 5 = DELETE_EDIT_RUMOR_KIND as 5;

export interface DeleteEditHandlerDeps {
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

/**
 * Old-dispatcher-path handler. TEMPORARY: kept so the existing suites and the
 * old `buildDispatcher` stay green until the context cut-over (S18); removed by
 * S22. New code uses `createDeleteEditGroupHandler`.
 */
export function createDeleteEditHandler(deps: DeleteEditHandlerDeps): RumorHandler<5> {
  return {
    kind: KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
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
    options?: { withdrawnRumorIds?: readonly string[] },
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
  // ONE recompute serves every withdrawn row of the batch that names these slots (the dispatch layer runs a single
  // retract per `slotRetractKey`), so the pins of all of them go with it, not only this row's.
  const withdrawn = (input.batch ?? [input]).filter((w) => deleteEditSlotIds(w.rumor as InboundDeleteEditRumor).some((id) => named.has(id)));
  await recompute(thread, slotIds, signals, { withdrawnRumorIds: [...new Set([input.rumor.id, ...withdrawn.map((w) => w.rumor.id)])] });
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
export function createDeleteEditGroupHandler(deps: DeleteEditGroupHandlerDeps): GroupKindHandler & RumorHandler<5> {
  assertPorts('createDeleteEditGroupHandler', deps, ['applyDeleteEditSignal', 'setChatVersion', 'recomputeSlot']);
  return {
    ...createDeleteEditHandler(deps),
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
        deps.setChatVersion((v) => v + 1);
      }
    },
  };
}
