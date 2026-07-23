/**
 * chatHandler.ts
 *
 * RumorHandler for CHAT_MESSAGE_KIND (kind 9).
 *
 * Receives all side-effect dependencies via the deps bag injected at
 * buildDispatcher(deps) time — no React context imports, no direct IDB imports.
 *
 * Boundary rules (architecture.md):
 *   - Zero imports from app/src/context/
 *   - All IDB and state-setter deps received via injection
 */

import { CHAT_MESSAGE_KIND } from '@/src/lib/marmot/chatPersistence';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext, RumorHandler } from '@/src/lib/marmot/applicationRumorDispatcher';
import type { ChangeResult, InboundDeleteEditRumor, MessageEditsThreadKey } from '@/src/lib/messageEdits/api';
import { hasEditMarkerTag } from '@/src/lib/messageEdits/rumor';

export interface ChatHandlerDeps {
  appendMessage: (groupId: string, message: ChatMessage) => Promise<void>;
  incrementUnread: (groupId: string) => void;
  /**
   * Epic: notification-domain-invariants (INV-2). Called instead of
   * incrementUnread when the message's group IS the active view (the user has
   * that group's detail open): advances the persisted last-read so the badge
   * stays clear across a reload while the open chat renders the message live.
   */
  markAsRead: (groupId: string) => void;
  setChatVersion: (updater: (v: number) => number) => void;
  /**
   * S5 (epic-feature-request-message-edit-and-delete): a kind-9 rumor carrying
   * the edit e-tag marker is a REPLACEMENT, not a plain original — it must be
   * routed to S3's reconciliation core instead of being appended here as a
   * bogus new "original" row (which would corrupt the store: a duplicate row
   * under the replacement's own id, while the real target slot never updates).
   */
  applyDeleteEditSignal: (thread: MessageEditsThreadKey, rumor: InboundDeleteEditRumor, sender: AuthenticatedSender) => Promise<ChangeResult>;
  /**
   * S5: required calling convention from S3 (messageEdits/api.ts module doc
   * comment, carried into S4/S5 via ownership-ledger.json) — after every
   * append of a brand-new original chat-message row, the caller MUST
   * immediately call this so any buffered delete/edit signal or delete-marker
   * for that id is resolved against the just-arrived original. Sequenced
   * BEFORE the chatVersion bump, so ChatStoreContext's re-read reflects the
   * resolved (possibly tombstoned/edited) state, not the raw just-appended row.
   */
  resolvePendingSignalsForSlot: (thread: MessageEditsThreadKey, slotId: string, originalAuthorPubkeyHex: string) => Promise<ChangeResult>;
}

async function handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, deps: ChatHandlerDeps): Promise<void> {
  const thread: MessageEditsThreadKey = { kind: 'group', groupId: ctx.groupId };

  // S5 dispatch-routing check (mirrors ContactChat.tsx's isEditMarkedReplacement
  // check for the DM kind-14 path, using S4's canonical hasEditMarkerTag so the
  // two predicates can never drift apart — see messageEdits/rumor.ts). MUST run
  // before any content/attachment parsing below: an edit-marked replacement's
  // `content` is the NEW message text, not something chatHandler should ever
  // append as an independent row.
  if (hasEditMarkerTag(rumor.tags)) {
    const result = await deps.applyDeleteEditSignal(thread, rumor as InboundDeleteEditRumor, sender).catch((err: unknown) => {
      console.warn('[dispatcher.9] applyDeleteEditSignal (edit-marked replacement) failed:', err);
      return null;
    });
    // S5 gate-remediation (finding 5): bump unconditionally for ANY non-null
    // ChangeResult — mirrors deleteEditHandler.ts's identical fix. The sweep
    // inside applyDeleteEditSignal can self-heal/materialize OTHER slots'
    // storage regardless of THIS rumor's own outcome; a spurious bump for a
    // 'pending'/'discarded'/'noop' result is a cheap, idempotent re-read.
    if (result) {
      deps.setChatVersion((v) => v + 1);
    }
    return;
  }

  const { parseImageMessageContent, extractAttachmentsByRole } = await import('@/src/lib/media/imageMessage');
  const parsed = parseImageMessageContent(typeof rumor.content === 'string' ? rumor.content : '');
  const attachments = (parsed?.type === 'image' && rumor.tags?.length)
    ? extractAttachmentsByRole(rumor.tags)
    : null;
  const hasAttachment = attachments && (attachments.full || attachments.thumb);

  const msg: ChatMessage = {
    id: rumor.id,
    content: typeof rumor.content === 'string' ? rumor.content : '',
    senderPubkey: sender.pubkey,
    groupId: ctx.groupId,
    createdAt: rumor.created_at * 1000,
    ...(hasAttachment ? { attachments } : {}),
  };

  await deps.appendMessage(ctx.groupId, msg);

  // S5: resolve-after-append (see ChatHandlerDeps.resolvePendingSignalsForSlot
  // doc comment above). appendMessage is insert-if-absent with no signal for
  // "actually inserted" vs "dedup no-op" — resolvePendingSignalsForSlot is
  // itself idempotent, so calling it unconditionally on every kind-9 original
  // (including a re-delivered one) is always safe.
  await deps.resolvePendingSignalsForSlot(thread, msg.id, msg.senderPubkey).catch((err: unknown) => {
    console.warn('[dispatcher.9] resolvePendingSignalsForSlot failed:', err);
  });

  deps.setChatVersion((v) => v + 1);

  // Own-send guard: skip incrementUnread for messages authored by the local user.
  // marmot-ts #sentEventIds prevents own-send from reaching the bus at all,
  // but this guard provides defense-in-depth. Keyed on the authenticated
  // `sender.pubkey` (not the forgeable rumor.pubkey) so "is this mine" is an
  // authenticated-author comparison like every other identity check in this
  // epic — which lets the handlers/ rumor.pubkey static-scan ban be absolute
  // (empty allow-list). Under the stub sender.pubkey === rumor.pubkey, so this
  // is behavior-preserving today; under the backbone it prevents an attacker
  // from suppressing the victim's notification by forging rumor.pubkey.
  if (sender.pubkey !== ctx.selfPubkeyHex) {
    // Epic: notification-domain-invariants. If THIS group is the one currently
    // open in the detail view (getActiveGroupId — the DispatcherContext seam
    // wired to activeViewStore), the open chat already renders the message via
    // the setChatVersion bump above, so the bell must NOT ring (INV-2); instead
    // advance last-read so the badge stays clear on reload. Any other group
    // rings the bell (INV-1).
    if (ctx.getActiveGroupId() === ctx.groupId) {
      deps.markAsRead(ctx.groupId);
    } else {
      deps.incrementUnread(ctx.groupId);
    }
  }
}

export function createChatHandler(deps: ChatHandlerDeps): RumorHandler {
  return {
    kind: CHAT_MESSAGE_KIND,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) => handle(rumor, ctx, sender, deps),
  };
}
