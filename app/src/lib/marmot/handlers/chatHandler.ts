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
import { loadVotesWithPending } from '@/src/lib/marmot/pollReplay';
import type { Poll, PollVote, PendingPollVote, PendingCloseAnnouncement } from '@/src/lib/marmot/pollPersistence';

export interface ChatHandlerDeps {
  /**
   * Insert-if-absent by message id. Resolves true iff a row was inserted (or
   * a materialized-from-edit placeholder superseded) — the "new message"
   * side effects (version bump, unread / mark-read) run only then, so a
   * re-delivered or re-replayed message is never counted twice.
   */
  appendMessage: (groupId: string, message: ChatMessage) => Promise<boolean>;
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
  loadVotes: (groupId: string, pollId: string) => Promise<PollVote[]>;
  // AC-9: the poll_close gate replays stranded early votes before its tally
  // (same as pollHandler.handleClose) so the announced counts match the
  // persisted close.
  saveVoteIfNewer: (vote: PollVote) => Promise<boolean>;
  loadPendingVotes: (groupId: string, pollId: string) => Promise<PendingPollVote[]>;
  removePendingVotes: (groupId: string, applied: PendingPollVote[]) => Promise<void>;
  // AC-9: a poll_close announcement for a poll not yet known is queued and
  // re-run through this same gate once the poll-open arrives
  // (createPollCloseAnnouncementReplayer, wired to pollHandler's replayHeldCloseAnnouncements).
  queuePendingCloseAnnouncement: (announcement: Omit<PendingCloseAnnouncement, 'receivedAt'>) => Promise<void>;
  loadPendingCloseAnnouncements: (groupId: string, pollId: string) => Promise<PendingCloseAnnouncement[]>;
  removePendingCloseAnnouncements: (groupId: string, applied: PendingCloseAnnouncement[]) => Promise<void>;
  /**
   * pollHandler createHeldCloseSettler: applies a held close of the poll
   * before its summary is judged (a summary is one more message of its poll —
   * bug: poll-residual-ordering-and-close-retry). Returns the stored poll, or
   * 'unknown' when it could not be confirmed. Optional for tests.
   */
  settleHeldCloses?: (poll: Poll, ctx: DispatcherContext) => Promise<Poll | 'unknown'>;
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
  rumor: ApplicationRumor,
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
      // An indeterminate read THROWS; null means only "definitively rejected"
      // (a non-creator actor). Never swallow a failed read into an accept —
      // e.g. loadVotes into `[]` would persist a fabricated "0 votes, 0
      // voters" tally under this rumor id (F2, Stage-2 review).
      //
      // A throw keeps the rumor journaled (the dispatcher acks only a
      // completed rumor) and it is handled again at the next subscription.
      // Before throwing, it is also HELD — the same queue as an announcement
      // for a not-yet-known poll — so the next message of the poll re-runs it
      // through this gate within the session (pollHandler settleHeldCloses →
      // createPollCloseAnnouncementReplayer; bug:
      // poll-residual-ordering-and-close-retry). In that replay a throw keeps
      // the entry held, a null discards it. Both retries converge: the row is
      // insert-if-absent by rumor id, unread is counted only for an inserted
      // row, and a hold is kept once per (poll, sender).
      const hold = () =>
        deps.queuePendingCloseAnnouncement({
          groupId: ctx.groupId,
          pollId: structured.pollId,
          senderPubkey: sender.pubkey,
          rumorId: rumor.id,
          createdAt: rumor.created_at,
        });
      const holdAfterFailure = async (err: unknown): Promise<never> => {
        await hold().catch((holdErr: unknown) => {
          console.warn('[dispatcher.9] holding poll_close announcement for retry failed:', holdErr);
        });
        throw err;
      };

      let poll: Poll | null;
      try {
        poll = await deps.getPoll(ctx.groupId, structured.pollId);
      } catch (err) {
        return holdAfterFailure(err);
      }
      if (!poll) {
        // AC-9: the announcement arrived before its poll-open (out-of-order
        // MLS delivery). Not shown now — the creator cannot be checked — but
        // held, bound to the authenticated sender, and re-run through this
        // gate when the open arrives. A failed hold throws (not a rejection):
        // in the replay the entry then stays held.
        await hold();
        return null;
      }
      // Apply a close of this poll held after an earlier failure — on the
      // dispatcher FIFO, before this summary is judged — so the summary of a
      // close that hit a storage failure finishes that close. Unconfirmed
      // state holds the summary for the next poll message.
      if (deps.settleHeldCloses) {
        const settled = await deps.settleHeldCloses(poll, ctx);
        if (settled === 'unknown') return holdAfterFailure(new Error('poll state unknown after a failed held-close recovery'));
        poll = settled;
      }
      // Fail closed: a non-creator actor rejects — F1 (S5 Stage-2 review).
      // Case-insensitive, matching every other identity comparison in this gate.
      if (poll.creatorPubkey.toLowerCase() !== sender.pubkey.toLowerCase()) return null;
      // title comes from the stored poll, not the closer's payload — we
      // deliberately distrust structured.title the same way we distrust its
      // results/totalVoters (F1).
      const announce = (results: unknown, totalVoters: unknown) =>
        JSON.stringify({ type: 'poll_close', pollId: structured.pollId, title: poll.title, results, totalVoters });
      // An already-closed poll announces the tally it was stored with, so the
      // chat row always matches the poll card — votes that arrived after a
      // held close are kept as rows but are not in its tally.
      if (poll.closed && Array.isArray(poll.results)) {
        return announce(poll.results, poll.totalVoters ?? 0);
      }
      let votes: PollVote[];
      try {
        votes = await loadVotesWithPending(poll, deps);
      } catch (err) {
        return holdAfterFailure(err);
      }
      const { results, totalVoters } = computeTally(poll.options, votes);
      return announce(results, totalVoters);
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
    // A storage failure propagates so the rumor stays journaled and is
    // handled again at the next subscription (replay-safe — see
    // deleteEditHandler.ts; bug: reaction-storage-failures).
    try {
      await deps.applyDeleteEditSignal(thread, rumor as InboundDeleteEditRumor, sender);
    } finally {
      // S5 gate-remediation (finding 5): bump unconditionally — mirrors
      // deleteEditHandler.ts's identical fix. The sweep inside
      // applyDeleteEditSignal can self-heal/materialize OTHER slots' storage
      // regardless of THIS rumor's own outcome (also when it failed part
      // way); a spurious bump is a cheap, idempotent re-read.
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
    const gated = await gateAnnouncement(structured, content, rumor, ctx, sender, deps);
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

  const inserted = await deps.appendMessage(ctx.groupId, msg);

  // S5: resolve-after-append (see ChatHandlerDeps.resolvePendingSignalsForSlot
  // doc comment above). appendMessage is insert-if-absent with no signal for
  // "actually inserted" vs "dedup no-op" — resolvePendingSignalsForSlot is
  // itself idempotent, so calling it unconditionally on every kind-9 original
  // (including a re-delivered one) is always safe.
  await deps.resolvePendingSignalsForSlot(thread, msg.id, msg.senderPubkey).catch((err: unknown) => {
    console.warn('[dispatcher.9] resolvePendingSignalsForSlot failed:', err);
  });

  // Nothing new landed (a duplicate id): no version bump, no unread.
  if (!inserted) return;

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

/**
 * AC-9: re-evaluate poll_close announcements that arrived before `poll`'s
 * poll-open, through the SAME handle() path as a live announcement — same
 * creator gate, same tally recompute from stored votes, same append / unread /
 * notification side effects. The queued entry keeps only the rumor's
 * identity; its content is rebuilt as a bare poll_close for `poll` because
 * the gate derives title and results from the stored poll and votes, never
 * from the sender's payload. A non-creator announcement is rejected by the
 * gate and discarded.
 *
 * Per entry: an entry is removed only if its handle() run COMPLETED — the row
 * was appended, was already present (duplicate), or the gate definitively
 * rejected it. An entry whose run threw (an indeterminate read, a failed
 * append) is never removed and is retried at the next poll message; after the
 * loop the first such error is rethrown. Removal itself is cleanup: a failure
 * there throws too, and the re-run is harmless (insert-if-absent rows, unread
 * counted only for an inserted row).
 */
export function createPollCloseAnnouncementReplayer(deps: ChatHandlerDeps) {
  return async (poll: Poll, ctx: DispatcherContext): Promise<void> => {
    const pending = await deps.loadPendingCloseAnnouncements(ctx.groupId, poll.id);
    if (pending.length === 0) return;
    const completed: PendingCloseAnnouncement[] = [];
    let failure: unknown = null;
    for (const entry of pending) {
      const rumor: ApplicationRumor = {
        id: entry.rumorId,
        pubkey: entry.senderPubkey,
        created_at: entry.createdAt,
        kind: CHAT_MESSAGE_KIND,
        tags: [],
        content: JSON.stringify({ type: 'poll_close', pollId: poll.id, title: poll.title, results: [], totalVoters: 0 }),
      };
      try {
        // The sender was authenticated when the announcement was received.
        await handle(rumor, ctx, { pubkey: entry.senderPubkey, authenticity: 'mls' }, deps);
        completed.push(entry);
      } catch (err) {
        failure ??= err;
      }
    }
    if (completed.length > 0) await deps.removePendingCloseAnnouncements(ctx.groupId, completed);
    if (failure !== null) throw failure;
  };
}
