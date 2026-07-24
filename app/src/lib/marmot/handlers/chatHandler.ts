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
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import type { StructuredContent } from '@/src/lib/marmot/parseStructured';
import { computeTally } from '@/src/lib/marmot/pollTally';
import type { Poll, PollVote } from '@/src/lib/marmot/pollPersistence';

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
  /**
   * S6 (epic: group-message-author-auth-app-layer, AC-ANNOUNCE-1..5) —
   * announcement ingest-gate deps. isGroupAdmin/isGroupMember answer
   * "is this pubkey a current admin/member of this group" for the actor
   * rules below; getPoll/loadVotes back the poll_close creator-gate + tally
   * recompute (F1, S5 Stage-2 review).
   */
  isGroupAdmin: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  isGroupMember: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  getPoll: (groupId: string, pollId: string) => Promise<Poll | null>;
  loadVotes: (pollId: string) => Promise<PollVote[]>;
}

/**
 * S6 (epic: group-message-author-auth-app-layer) — per-type actor rules for
 * enum announcements, enforced BEFORE deps.appendMessage (AC-ANNOUNCE-1: a
 * rejected announcement produces no row, no setChatVersion bump, no unread
 * increment, no notification). Returns `null` to reject; returns the
 * content string to persist otherwise (identical to the input for every
 * type except poll_close, whose tally is recomputed here from stored votes
 * — never trusted from the closer's payload, F1).
 *
 * Fail-closed (VQ-S6-006): every admin/roster/poll lookup below is wrapped
 * so a throw/rejection resolves to a rejecting outcome, never a silent
 * accept.
 */
async function gateAnnouncement(
  structured: StructuredContent,
  content: string,
  ctx: DispatcherContext,
  sender: AuthenticatedSender,
  deps: ChatHandlerDeps,
): Promise<string | null> {
  switch (structured?.type) {
    case 'group_renamed':
    case 'invite_cancelled': {
      const isAdmin = await deps.isGroupAdmin(ctx.groupId, sender.pubkey).catch(() => false);
      return isAdmin ? content : null;
    }
    case 'invite_lifecycle': {
      const isAdmin = await deps.isGroupAdmin(ctx.groupId, sender.pubkey).catch(() => false);
      if (!isAdmin) return null;
      // AC-ANNOUNCE-2: invited/declined are NEVER roster-gated — the
      // subject is shown as an unverified claim even absent from the roster.
      if (structured.event !== 'accepted') return content;
      // AC-ANNOUNCE-3: accepted IS roster-gated, once, at ingest. A reject
      // here is permanent for THIS SESSION (in-memory LRU): the dispatcher's
      // LRU dedups the rumor id for the life of this session, so it is never
      // re-evaluated locally. It is NOT durably recorded — cross-session
      // redelivery (a fresh page load) or LRU eviction (past 1000 entries)
      // re-gates the same rumor against the then-current roster (F5, Stage-2
      // review). Do NOT "fix" a missed admission by re-gating at render
      // time; that reintroduces retroactivity and breaks AC-ANNOUNCE-3's
      // non-retroactive guarantee.
      // sender.pubkey is trusted as a current admin here only because MLS
      // lets only admins commit Adds today; a future non-admin invite path
      // would need this gate revisited or it will silently drop legitimate
      // 'accepted' announcements.
      const isMember = await deps.isGroupMember(ctx.groupId, structured.pubkey).catch(() => false);
      return isMember ? content : null;
    }
    case 'member_admitted': {
      const isAdmin = await deps.isGroupAdmin(ctx.groupId, sender.pubkey).catch(() => false);
      if (!isAdmin) return null;
      // AC-ANNOUNCE-3: same ingest-time, non-retroactive roster gate as
      // invite_lifecycle('accepted') above — a reject is permanent for THIS
      // SESSION only (in-memory LRU dedup means the rumor id is never
      // re-evaluated locally); it is not durably recorded, so cross-session
      // redelivery re-gates against the then-current roster (F5, Stage-2
      // review). Never re-gate at render time. sender.pubkey is trusted as a
      // current admin only because MLS currently restricts Adds to admins.
      const isMember = await deps.isGroupMember(ctx.groupId, structured.pubkey).catch(() => false);
      return isMember ? content : null;
    }
    case 'leave_intent': {
      // S3 Fable Stage-2 review fold-in: the kind-9 DEPARTURE ANNOUNCEMENT
      // ("X left the group" chat row) must also gate subject === sender,
      // mirroring leaveHandler.ts's kind-13 forced-removal rule.
      return structured.pubkey.toLowerCase() === sender.pubkey.toLowerCase() ? content : null;
    }
    case 'poll_close': {
      const poll = await deps.getPoll(ctx.groupId, structured.pollId).catch(() => null);
      // Fail closed: unknown poll (not yet observed / lookup failure) or a
      // non-creator actor both reject — F1 (S5 Stage-2 review). Case-
      // insensitive, matching every other identity comparison in this gate.
      if (!poll || poll.creatorPubkey.toLowerCase() !== sender.pubkey.toLowerCase()) return null;
      // F2 (Stage-2 review): an indeterminate loadVotes lookup must fail the
      // gate CLOSED (reject) — same no-persist outcome as
      // pollHandler.handleClose's un-caught loadVotes throw (neither writes a
      // fabricated tally). Retry semantics are identical for both: the
      // dispatcher calls markSeen BEFORE fan-out and catches handler throws
      // per-handler (applicationRumorDispatcher.ts), so whether we return null
      // here or handleClose throws, the rumor id is already in the LRU — retry
      // is cross-session only (once the in-memory LRU is gone), never
      // in-session. Swallowing the rejection into `[]` would instead ACCEPT the
      // close with a fabricated "0 votes, 0 voters" tally — and because the row
      // persists under rumor.id and the dispatcher LRU blocks in-session
      // re-ingest, that wrong tally would be permanent for the session.
      let votes: PollVote[];
      try {
        votes = await deps.loadVotes(structured.pollId);
      } catch {
        return null;
      }
      const { results, totalVoters } = computeTally(poll.options, votes);
      // title comes from the stored poll, not the closer's payload — we
      // deliberately distrust structured.title the same way we distrust its
      // results/totalVoters (F1).
      return JSON.stringify({ type: 'poll_close', pollId: structured.pollId, title: poll.title, results, totalVoters });
    }
    default:
      return content;
  }
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

  // S6 (epic: group-message-author-auth-app-layer, AC-ANNOUNCE-1..5) —
  // per-type actor-rule ingest gate for enum announcements. Runs BEFORE any
  // attachment parsing/appendMessage: a rejected announcement must produce
  // NO side effect at all (no row, no version bump, no unread, no
  // notification), so we bail out here, before anything below executes.
  let content = typeof rumor.content === 'string' ? rumor.content : '';
  const structured = parseStructured(content);
  if (structured) {
    const gated = await gateAnnouncement(structured, content, ctx, sender, deps);
    if (gated === null) return;
    content = gated;
  }

  const { parseImageMessageContent, extractAttachmentsByRole } = await import('@/src/lib/media/imageMessage');
  const parsed = parseImageMessageContent(content);
  const attachments = (parsed?.type === 'image' && rumor.tags?.length)
    ? extractAttachmentsByRole(rumor.tags)
    : null;
  const hasAttachment = attachments && (attachments.full || attachments.thumb);

  const msg: ChatMessage = {
    id: rumor.id,
    content,
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
