/**
 * ChatStoreContext — manages chat messages and reactions for the active group.
 *
 * Provides optimistic send and persists messages to IndexedDB via chatPersistence.
 * Inbound MLS application rumors (chat, reactions, edits) are NOT subscribed here:
 * the single applicationRumorDispatcher wired in MarmotContext routes them.
 *
 * Story-06 additions:
 * - sendReaction(emoji, targetMessage, isRemoval?): optimistic write + MLS send + rollback (D7)
 * - reactionsByMessageId: Map<string, ReactionAggregate[]> derived from subscribeReactions
 * - Kind-7 rumors are ingested by the dispatcher; this context only aggregates them
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import {
  CHAT_MESSAGE_KIND,
  appendMessage,
  loadMessages,
  filterVisibleMessages,
} from '@/src/lib/marmot/chatPersistence';
import type { ReactionAggregate } from '@/src/lib/reactions/api';
import {
  applyOptimistic,
  applyOptimisticRemoval,
  rollbackOptimistic,
  subscribeReactions,
  loadReactions,
  aggregateForMessage,
} from '@/src/lib/reactions/api';
import { buildReactionRumor } from '@/src/lib/reactions/rumor';
import type { Reaction } from '@/src/lib/reactions/types';
import {
  applyDeleteEditSignal,
  resolvePendingSignalsForSlot,
  type MessageEditsThreadKey,
} from '@/src/lib/messageEdits/api';
import { isInformativeAnnouncementContent } from '@/src/lib/marmot/announcementFamily';
import {
  buildDeleteRumor,
  buildEditReplacementRumor,
  buildEditMarkedCompanionKind5,
  clampRev,
} from '@/src/lib/messageEdits/rumor';

type MarmotGroupType = import('@internet-privacy/marmot-ts').MarmotGroup;

/**
 * WORKAROUND: ts-mls forbids application messages when unappliedProposals
 * is non-empty. This catches the error, commits pending proposals, and
 * retries. Requires the sender to be an admin (commit() has an admin check).
 *
 * Root cause: admin promotion during invite can silently fail, leaving
 * members unable to commit. The real fix is to guarantee admin promotion
 * succeeds (retry / block invite until confirmed).
 */
const MAX_RETRIES = 3;
async function sendRumorSafe(
  group: MarmotGroupType,
  rumor: Parameters<MarmotGroupType['sendApplicationRumor']>[0],
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await group.sendApplicationRumor(rumor);
      return;
    } catch (err) {
      const isUnapplied = err instanceof Error && err.message.includes('unapplied proposals');
      if (!isUnapplied || attempt === MAX_RETRIES) throw err;
      console.warn(`[sendRumorSafe] unapplied proposals (attempt ${attempt + 1}/${MAX_RETRIES + 1}), committing…`);
      await group.commit();
    }
  }
}

/**
 * Build a kind-9 chat rumor with a precomputed canonical id so the optimistic
 * row stored locally uses the same id the receiver will store. Mirrors
 * marmot-ts's internal `sendChatMessage` rumor shape, but exposes the id to
 * the caller. (Without this alignment, sender-side IDB and receiver-side IDB
 * end up with different ids for the same logical message — see
 * AC-AR-21 dispatch-isolation peer test.)
 */
async function buildChatRumor(
  pubkey: string,
  content: string,
  tags: string[][] = [],
): Promise<{ id: string; kind: number; pubkey: string; created_at: number; content: string; tags: string[][] }> {
  const { getEventHash } = await import('applesauce-core/helpers/event');
  const rumor = {
    id: '',
    kind: CHAT_MESSAGE_KIND,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * S5 (epic-feature-request-message-edit-and-delete): group render-substitution
 * fix, foreseen in the S4 review (ownership-ledger.json S4 obligation).
 *
 * Before this story, both message-load effects below only ever ADDED ids from
 * `stored` that were not already present in `prev` — an id already rendered
 * was NEVER updated or removed, so a delete/edit of an ALREADY-RENDERED group
 * message would never visibly change at all. This function is the single fix
 * for both effects: for every id `prev` already renders, substitute storage's
 * row (so a since-tombstoned/edited row's storage truth overrides the stale
 * rendered copy); append any id storage knows about that isn't rendered yet;
 * then filter the result through `filterVisibleMessages` (tombstoned rows
 * never render, AC-DEL-3/AC-DEL-5's render half) and re-sort.
 *
 * Group inbound ingestion re-reads the WHOLE per-thread storage array on every
 * chatVersion bump (unlike DM's incremental gift-wrap-event unwrap, which
 * needed ContactChat.tsx's per-message `resolveFreshOriginalFromStorage`) —
 * a single bulk reconcile is sufficient and correct here.
 *
 * Exported and pure so it is testable directly, without mounting React (this
 * repo's hooks-via-pure-function-extraction convention).
 */
export function reconcileMessagesWithStorage(prev: ChatMessage[], stored: ChatMessage[]): ChatMessage[] {
  const storedById = new Map(stored.map((m) => [m.id, m] as const));
  const merged = prev.map((m) => storedById.get(m.id) ?? m);
  const mergedIds = new Set(merged.map((m) => m.id));
  const newFromStore = stored.filter((m) => !mergedIds.has(m.id));
  return filterVisibleMessages([...merged, ...newFromStore]).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * S5 gate-remediation-precedent pure view transforms — mirrors
 * ContactChat.tsx's identically-named DM functions (same `ChatMessage` type,
 * same shape) so tests exercise the real transforms without mounting React.
 */
export function applyOptimisticDeleteView(view: ChatMessage[], messageId: string): ChatMessage[] {
  return view.filter((m) => m.id !== messageId);
}

export function rollbackOptimisticDeleteView(view: ChatMessage[], snapshot: ChatMessage): ChatMessage[] {
  return [...view, snapshot].sort((a, b) => a.createdAt - b.createdAt);
}

export function applyOptimisticEditView(view: ChatMessage[], messageId: string, newContent: string): ChatMessage[] {
  return view.map((m) => (m.id === messageId ? { ...m, content: newContent, edited: true } : m));
}

export function rollbackOptimisticEditView(view: ChatMessage[], messageId: string, snapshot: ChatMessage): ChatMessage[] {
  return view.map((m) => (m.id === messageId ? snapshot : m));
}

/**
 * S5 gate-remediation (finding 3): deps bag for the group send-orchestration
 * pure functions below (`performGroupDeleteMessage` / `performGroupEditMessage`).
 * Carries every side-effecting dependency the ChatStoreProvider closures
 * would otherwise capture directly, so a unit test can inject a mocked
 * `group` (fake `sendApplicationRumor`) and a plain-array-backed
 * `setMessages` and exercise the REAL orchestration body — closing the
 * shadow-init blind spot where a test re-implements a handler instead of
 * calling it (flagged on S4, unmirrored on S5's original landing).
 */
export interface GroupSendDeps {
  group: Pick<MarmotGroupType, 'sendApplicationRumor'>;
  groupId: string;
  privateKeyHex: string;
  pubkey: string;
  resolveAuthoritativeGroupRev: (targetMessageId: string, fallbackRev: number | undefined) => Promise<number>;
  getSnapshot: () => ChatMessage | undefined;
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /**
   * S8 (epic-group-invite-lifecycle): whether the CURRENT user is a group
   * admin — the send-side half of the AC-IMMUT-3/AC-IMMUT-5 moderation-
   * delete loop. Consulted ONLY by `performGroupDeleteMessage`, and only
   * when the target is an informative announcement authored by a PEER
   * (S7's admin "Delete" button click). Defaults to `false` (non-admin) so
   * every existing call site that doesn't thread this through keeps its
   * pre-S8 own-message-only behavior unchanged.
   */
  isCurrentUserAdmin?: boolean;
}

/**
 * S5: group delete — the group half of the MessageActionHandlers seam.
 * Mirrors sendMessage/sendReaction's optimistic-view + sendRumorSafe (MLS
 * application rumor — group.sendApplicationRumor; ChatStoreContext.tsx has
 * zero NDK/relay imports, so a relay-facing kind-5 is structurally
 * impossible from this path, AC-DEL-4) + rollback pattern. Built via S2's
 * buildDeleteRumor/clampRev; priorReplacementIds is always [] (2026-07-07
 * product decision: non-Few interop is best-effort; a Few sender retains no
 * prior replacement ids — do not track a chain, mirrors S4's identical
 * decision for publishDirectDelete).
 *
 * Durable apply (S3's applyDeleteEditSignal) is deferred until AFTER
 * publish success, and a persist-only failure there is swallowed rather
 * than rolling back the view (mirrors S4's publishDirectDelete deviation:
 * applyToKnownSlotCore's edit-shaped patch is the only way to un-tombstone,
 * and unconditionally sets edited:true — a synthetic "undo" signal on a
 * post-publish persist failure would permanently mislabel a never-edited
 * message as edited on the common failure path). Only a genuine PUBLISH
 * failure rolls back the optimistic view and rethrows.
 *
 * Failure-UX: throws, does not toast (see architecture.json's documented
 * cross-cutting decision — matches the EXISTING group reaction precedent,
 * sendReaction, which also only throws).
 *
 * Extracted (S5 gate-remediation, finding 3) from the ChatStoreProvider
 * closure so it is directly testable — see `GroupSendDeps` above.
 *
 * S8 (epic-group-invite-lifecycle) admin carve-out: own-message authorship
 * is no longer the ONLY way past the guard below. A group admin
 * (`deps.isCurrentUserAdmin`) may also construct+send a delete targeting a
 * PEER's message when — and only when — that message is an informative
 * announcement (the shared `isInformativeAnnouncementContent` predicate,
 * the SAME family definition S7's UI gate and S8's receive-side gate both
 * consume). This is the send-side half of S7's admin "Delete" button
 * (AC-IMMUT-3): the rumor below is always signed with the ADMIN's OWN
 * `privateKeyHex`, so its published `pubkey` is the admin's, never the
 * original author's — the receive side (`messageEdits/api.ts`'s
 * `authorizeDeleteAgainstTarget`) authorizes it by checking that pubkey
 * against the group's CURRENT admin set, per ADR-006's self-asserted
 * `senderPubkey` convention (AC-IMMUT-5). A non-admin, or a peer message
 * that is NOT an announcement, still falls through to the own-message-only
 * rule — the carve-out grants nothing beyond moderation of the
 * announcement family.
 */
export async function performGroupDeleteMessage(messageId: string, deps: GroupSendDeps): Promise<void> {
  const { group, groupId, privateKeyHex, pubkey, resolveAuthoritativeGroupRev, getSnapshot, setMessages } = deps;
  const snapshot = getSnapshot();
  if (!snapshot) return;

  const isOwnMessage = snapshot.senderPubkey.toLowerCase() === pubkey.toLowerCase();
  const isAdminModerationDelete =
    !isOwnMessage && (deps.isCurrentUserAdmin ?? false) && isInformativeAnnouncementContent(snapshot.content);

  // Own-message auth guard — fail-closed (mirrors S4's identical
  // handler-seam backstop; AC-AUTH-1 affordance-hiding is S6's) — UNLESS
  // this is an authorized admin moderation-delete of a peer's announcement
  // (S8, AC-IMMUT-3/5).
  if (!isOwnMessage && !isAdminModerationDelete) return;

  setMessages((prev) => applyOptimisticDeleteView(prev, messageId));

  try {
    const lastKnownRev = await resolveAuthoritativeGroupRev(messageId, snapshot.rev);
    const rev = clampRev(Math.floor(Date.now() / 1000), lastKnownRev);
    const rumor = buildDeleteRumor(snapshot.id, [], CHAT_MESSAGE_KIND, rev, privateKeyHex);

    await sendRumorSafe(
      group as MarmotGroupType,
      rumor as Parameters<MarmotGroupType['sendApplicationRumor']>[0],
    );

    const thread: MessageEditsThreadKey = { kind: 'group', groupId };
    try {
      await applyDeleteEditSignal(thread, rumor);
    } catch (err) {
      console.warn('[chat-store] delete durable apply failed (published ok):', err);
    }

    // S5 gate-remediation (finding 2): re-apply the optimistic delete view
    // once more after the durable apply settles. Without this, a chatVersion
    // bump landing during the publish window (triggered by unrelated thread
    // activity) re-reads storage via reconcileMessagesWithStorage — whose
    // "new-from-store" branch re-adds this row from its not-yet-tombstoned
    // storage state — and the durable tombstone write above (which lands
    // AFTER that race) triggers no re-render of its own, leaving the
    // "deleted" message resurrected and visible indefinitely.
    setMessages((prev) => applyOptimisticDeleteView(prev, messageId));
  } catch (err) {
    // AC-DEL-2: restore the prior visible state on publish failure.
    setMessages((prev) => rollbackOptimisticDeleteView(prev, snapshot));
    throw err;
  }
}

/**
 * S5: group edit — the group half of MessageActionHandlers. Same auth guard
 * and authoritative-rev re-read as `performGroupDeleteMessage`. Builds the
 * replacement via S2's buildEditReplacementRumor (originalCreatedAt =
 * Math.floor(snapshot.createdAt / 1000) — ms-to-seconds; snapshot.id doubles
 * as the stable slot anchor across a repeated-edit chain, AC-EDIT-6, since
 * storage mutates content in place and the row's id/createdAt are never
 * touched by an edit patch).
 *
 * AC-EDIT-8 ordering: replacement published BEFORE the companion kind-5.
 * Durable apply on replacement-publish success (swallowed on failure, same
 * reasoning as the delete path); companion kind-5 attempted afterward in its
 * own swallowing try/catch (a failed/absent companion never deletes the slot
 * or rolls back the already-successful edit — the replacement alone is a
 * complete edit for a Few client, D13). A failed REPLACEMENT publish throws
 * before any durable write and before the companion is attempted, so
 * rollback is a pure view revert.
 *
 * Extracted (S5 gate-remediation, finding 3) from the ChatStoreProvider
 * closure so it is directly testable — see `GroupSendDeps` above.
 */
export async function performGroupEditMessage(
  messageId: string,
  newContent: string,
  deps: GroupSendDeps,
): Promise<void> {
  const { group, groupId, privateKeyHex, pubkey, resolveAuthoritativeGroupRev, getSnapshot, setMessages } = deps;
  const snapshot = getSnapshot();
  if (!snapshot) return;

  if (snapshot.senderPubkey.toLowerCase() !== pubkey.toLowerCase()) return;

  setMessages((prev) => applyOptimisticEditView(prev, messageId, newContent));

  try {
    const lastKnownRev = await resolveAuthoritativeGroupRev(messageId, snapshot.rev);
    const rev = clampRev(Math.floor(Date.now() / 1000), lastKnownRev);
    const originalCreatedAtSeconds = Math.floor(snapshot.createdAt / 1000);

    const replacement = buildEditReplacementRumor(
      snapshot.id,
      originalCreatedAtSeconds,
      newContent,
      CHAT_MESSAGE_KIND,
      rev,
      privateKeyHex,
    );

    // AC-EDIT-8: replacement MUST publish before the companion. A failure
    // here throws — no durable write has happened yet, so rollback below is
    // a pure view revert.
    await sendRumorSafe(
      group as MarmotGroupType,
      replacement as Parameters<MarmotGroupType['sendApplicationRumor']>[0],
    );

    const thread: MessageEditsThreadKey = { kind: 'group', groupId };
    try {
      await applyDeleteEditSignal(thread, replacement);
    } catch (err) {
      console.warn('[chat-store] edit durable apply failed (published ok):', err);
    }

    // Best-effort companion kind-5 (non-Few degradation only, spec §2.4).
    // AC-EDIT-8: a failed/absent companion MUST NOT delete the slot and MUST
    // NOT roll back the edit that already succeeded above.
    try {
      const companion = buildEditMarkedCompanionKind5(snapshot.id, [], CHAT_MESSAGE_KIND, rev, privateKeyHex);
      await sendRumorSafe(
        group as MarmotGroupType,
        companion as Parameters<MarmotGroupType['sendApplicationRumor']>[0],
      );
    } catch (err) {
      console.warn('[chat-store] edit companion publish failed:', err);
    }

    // Re-read the authoritative row so the NEXT action on this slot starts
    // fresh (mirrors S4's ContactChat.handleEditMessage).
    //
    // S5 gate-remediation (finding 6): guard the substitution against a
    // delete that lands between the publish above and this re-read (e.g.
    // another device's kind-5 for the same slot). Substituting a tombstoned
    // row verbatim would render a message its author just deleted — drop it
    // from view instead of substituting.
    const { messages: after } = await loadMessages(groupId);
    const updated = after.find((m) => m.id === messageId);
    if (updated) {
      if (updated.tombstoned) {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      } else {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? updated : m)));
      }
    }
  } catch (err) {
    // AC-EDIT-8: roll back to the prior content on publish failure.
    setMessages((prev) => rollbackOptimisticEditView(prev, messageId, snapshot));
    throw err;
  }
}

interface ChatStoreContextValue {
  messages: ChatMessage[];
  sendMessage: (content: string) => Promise<void>;
  sendImageMessage: (file: File, caption: string) => Promise<void>;
  /** Story-06: send a kind-7 group reaction (add or remove). AC-34. */
  sendReaction: (emoji: string, targetMessage: ChatMessage, isRemoval?: boolean) => Promise<void>;
  /** Story-06: aggregated reactions per message id. Consumed by ChatBox → story-08. AC-34. */
  reactionsByMessageId: Map<string, ReactionAggregate[]>;
  loading: boolean;
  /**
   * S5 (epic-feature-request-message-edit-and-delete): group half of the
   * MessageActionHandlers seam consumed by S6's ChatBox action menu. Matches
   * S4's DM-half signatures exactly — no group-specific parameter leaks into
   * the shared call site (groupId/privateKeyHex are closed over here).
   */
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleEditMessage: (messageId: string, newContent: string) => Promise<void>;
}

const NOOP_ASYNC_MSG = async () => {};

const ChatStoreContext = createContext<ChatStoreContextValue>({
  messages: [],
  sendMessage: NOOP_ASYNC_MSG,
  sendImageMessage: NOOP_ASYNC_MSG,
  sendReaction: NOOP_ASYNC_MSG,
  reactionsByMessageId: new Map(),
  loading: false,
  handleDeleteMessage: NOOP_ASYNC_MSG,
  handleEditMessage: NOOP_ASYNC_MSG,
});

interface ChatStoreProviderProps {
  groupId: string | null;
  group: MarmotGroupType | null;
  pubkey: string;
  /** Private key hex used to build kind-7 reaction rumors (story-06, S3). */
  privateKeyHex?: string | null;
  signer?: import('applesauce-core').EventSigner | null;
  /** Bumped by MarmotContext when a chat message is persisted to IDB */
  chatVersion?: number;
  /** Bumped by MarmotContext when a kind-7 reaction is persisted to IDB (story-06, AC-38) */
  reactionsVersion?: number;
  /**
   * S8 (epic-group-invite-lifecycle): whether the current user is a group
   * admin, threaded into `performGroupDeleteMessage`'s admin
   * moderation-delete carve-out (see `GroupSendDeps.isCurrentUserAdmin`).
   * Mirrors `GroupChat`/`MemberList`'s existing `isCurrentUserAdmin` prop
   * naming (S7). Defaults to `false` — the pre-S8 own-message-only
   * behavior is unchanged for a caller that omits this prop.
   */
  isCurrentUserAdmin?: boolean;
  children: React.ReactNode;
}

export function ChatStoreProvider({
  groupId,
  group,
  pubkey,
  privateKeyHex,
  signer,
  chatVersion,
  reactionsVersion,
  isCurrentUserAdmin,
  children,
}: ChatStoreProviderProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // Story-06: aggregated reactions per message id. Updated by the subscribeReactions listener.
  const [reactionsByMessageId, setReactionsByMessageId] = useState<Map<string, ReactionAggregate[]>>(new Map());
  // Ref to the current messages so the reactions subscription can read them
  const messagesRef = useRef<ChatMessage[]>([]);

  // Keep messagesRef in sync for use in stable callbacks
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ─── Reactions subscription ───────────────────────────────────────────────
  // When the reactions store changes (via applyOptimistic, applyInboundRumor, rollback),
  // re-compute reactionsByMessageId from the current rows in IDB.
  // Also re-runs when reactionsVersion bumps (inbound from MarmotContext's kind-7 dispatch).
  useEffect(() => {
    if (!groupId) {
      setReactionsByMessageId(new Map());
      return;
    }
    const thread = { kind: 'group' as const, groupId };

    let cancelled = false;

    function recompute() {
      if (cancelled) return;
      loadReactions(thread).then((rows) => {
        if (cancelled) return;
        const msgs = messagesRef.current;
        const map = new Map<string, ReactionAggregate[]>();
        for (const msg of msgs) {
          const agg = aggregateForMessage(rows, msg.id, pubkey);
          if (agg.length > 0) {
            map.set(msg.id, agg);
          }
        }
        setReactionsByMessageId(map);
      }).catch(() => {});
    }

    // Initial load
    recompute();

    // Subscribe to changes driven by applyOptimistic / applyInboundRumor / rollback
    const unsub = subscribeReactions(thread, recompute);

    return () => {
      cancelled = true;
      unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, pubkey, reactionsVersion]);

  // ─── Message load ─────────────────────────────────────────────────────────
  // Inbound message ingestion is now handled exclusively by the unified
  // applicationRumorDispatcher wired in MarmotContext (Story 02). This effect
  // only loads the initial message set from IDB; chatVersion bumps trigger
  // re-reads via the effect below.
  useEffect(() => {
    if (!groupId || !group) {
      setMessages([]);
      setLoading(false);
      return;
    }

    let active = true;
    setMessages([]);
    setLoading(true);

    loadMessages(groupId)
      .then(({ messages: stored }) => {
        if (!active) return;
        // S5: reconcileMessagesWithStorage's filterVisibleMessages pass
        // strips any already-tombstoned row on initial load (mirrors S4's
        // init-seed fix for the DM surface).
        setMessages((prev) => reconcileMessagesWithStorage(prev, stored));
      })
      .catch(() => {
        if (active) setMessages([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    // S5: thread-open sweep — the pending-signal/delete-marker TTL sweep
    // (messageEdits/api.ts) is lazy (runs on next access for a thread), so a
    // group open must proactively trigger it (mirrors S4's ContactChat.tsx
    // mount-time sweep). The sentinel slotId '' can never collide with a real
    // rumor id (always 64-char hex) — resolvePendingSignalsForSlot's own
    // "no row found" branch still runs the general per-thread sweep.
    //
    // S5 gate-remediation (finding 1, sev5): the sweep's phase-1 self-heal
    // can tombstone/edit a row that is ALREADY rendered (e.g. a buffered
    // delete/edit for a slot whose original arrived without the standard
    // resolve hook ever firing for it — see messageEdits/api.ts's
    // sweepExpiredForThreadKeyLocked doc comment). The prior fire-and-forget
    // call left that mutation invisible until the next UNRELATED chatVersion
    // bump. Mirrors S4's ContactChat.tsx mount-sweep fix (finding 3b):
    // await the sweep, then re-read storage once, then reconcile it into the
    // rendered view — guarded by `active` so a fast unmount/thread-switch
    // never applies a stale reconcile.
    if (group) {
      const thread: MessageEditsThreadKey = { kind: 'group', groupId };
      void (async () => {
        try {
          await resolvePendingSignalsForSlot(thread, '', '');
        } catch {
          // Sweep bookkeeping failure — non-fatal, nothing to reconcile.
          return;
        }
        if (!active) return;
        try {
          const { messages: freshAfterSweep } = await loadMessages(groupId);
          if (!active) return;
          setMessages((prev) => reconcileMessagesWithStorage(prev, freshAfterSweep));
        } catch {
          // Best-effort reconciliation — a read failure here leaves state as-is.
        }
      })();
    }

    return () => {
      active = false;
    };
  }, [groupId, group]);

  // Re-read from IDB when MarmotContext persists a new chat message, or when
  // the S5 kind-5 handler / chatHandler's edit-marked-kind-9 branch reuses
  // setChatVersion after applying a group delete/edit signal. This handles
  // messages (and delete/edit signals) that arrive via the Nostr subscription
  // while ChatStoreContext may or may not have received the MarmotGroup event.
  useEffect(() => {
    if (!groupId || chatVersion === undefined || chatVersion === 0) return;
    loadMessages(groupId).then(({ messages: stored }) => {
      // S5: reconcileMessagesWithStorage substitutes storage's row for any id
      // already rendered (so a since-tombstoned/edited row's storage truth
      // wins over a stale rendered copy) and filters tombstoned rows out —
      // see that function's doc comment for why the PRE-S5 "only ever add
      // new ids" behavior meant a group edit/delete never visibly updated.
      setMessages((prev) => reconcileMessagesWithStorage(prev, stored));
    }).catch(() => {});
  }, [groupId, chatVersion]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!groupId || !group || !content.trim()) return;

      // Build the rumor with its canonical id BEFORE the optimistic write so
      // the local row uses the same id peers will store on receive (the
      // chatHandler keys by rumor.id). Otherwise sender and receiver carry
      // different ids for the same message and reactions / bubble lookups
      // diverge across pages — see AC-AR-21.
      const rumor = await buildChatRumor(pubkey, content);
      const optimistic: ChatMessage = {
        id: rumor.id,
        content,
        senderPubkey: pubkey,
        groupId,
        createdAt: rumor.created_at * 1000,
      };

      setMessages((prev) => [...prev, optimistic]);

      try {
        await sendRumorSafe(group, rumor as Parameters<MarmotGroupType['sendApplicationRumor']>[0]);
        // S5 gate-remediation (finding 4): resolve-after-append calling
        // convention (messageEdits/api.ts module doc comment) — a same-
        // account other-device delete/edit for this SAME rumor id arriving
        // between publish and this IDB commit would otherwise buffer as
        // pending with no resolve hook ever firing on THIS device. Swallowed
        // independently of the appendMessage failure log below.
        appendMessage(groupId, optimistic)
          .then(() => resolvePendingSignalsForSlot({ kind: 'group', groupId }, rumor.id, pubkey).catch(() => {}))
          .catch((err) => {
            console.error('[chat-store] Failed to persist sent message:', err);
          });
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== rumor.id));
        throw err;
      }
    },
    [groupId, group, pubkey],
  );

  const sendImageMessage = useCallback(
    async (file: File, caption: string) => {
      if (!groupId || !group || !signer) return;

      // Optimistic display uses a placeholder id only until publish completes;
      // once useImageSend returns the canonical rumor.id we re-key the local
      // row + IDB persistence to match the id peers will see (AC-AR-21).
      const tempId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const { buildImageMessageContent } = await import('@/src/lib/media/imageMessage');
      const optimistic: ChatMessage = {
        id: tempId,
        content: buildImageMessageContent(caption),
        senderPubkey: pubkey,
        groupId,
        createdAt: now * 1000,
        attachments: { full: null, thumb: null },
        localMediaRefs: [],
      };
      setMessages((prev) => [...prev, optimistic]);

      const { sendImageMessage: doSend } = await import('@/src/hooks/useImageSend');
      try {
        const { fullAttachment, thumbAttachment, rumorId, createdAt } = await doSend(file, caption, {
          groupId,
          group: group as any,
          pubkey,
          signer,
          onProgress: () => {},
        });

        const finalMsg: ChatMessage = {
          ...optimistic,
          id: rumorId,
          createdAt: createdAt * 1000,
          attachments: { full: fullAttachment, thumb: thumbAttachment },
          localMediaRefs: [fullAttachment.sha256, thumbAttachment.sha256],
        };
        // S5 gate-remediation (finding 4): resolve-after-append calling
        // convention — see sendMessage's identical comment above.
        appendMessage(groupId, finalMsg)
          .then(() => resolvePendingSignalsForSlot({ kind: 'group', groupId }, finalMsg.id, pubkey).catch(() => {}))
          .catch((err) => {
            console.error('[chat-store] Failed to persist image message:', err);
          });
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? finalMsg : m)),
        );
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        throw err;
      }
    },
    [groupId, group, pubkey, signer],
  );

  /**
   * Send a kind-7 group reaction.
   *
   * Mirrors ContactChat.tsx handleReact — build rumor first so its id is
   * available before the optimistic write (guarantees optimistic row id ==
   * published event id, matching AC-43's rationale for the DM path).
   *
   * 1. Build kind-7 rumor via buildReactionRumor — no p tag for groups (spec §3.3, AC-36).
   * 2. Branch on isRemoval for the optimistic write (AC-35, AC-59):
   *    - remove path → applyOptimisticRemoval flips the existing add row in place.
   *    - add path → applyOptimistic inserts a new row keyed on rumor.id.
   * 3. Send via sendRumorSafe (group.sendApplicationRumor with retry) (AC-36).
   * 4. On failure: branch on isRemoval for the rollback (D7, AC-37, AC-59):
   *    - remove path → re-insert a fresh removed:false row (restores badge).
   *    - add path → rollbackOptimistic removes the in-flight insert by rumor.id.
   *
   * Inbound reactions from peers are handled by reactionHandler.ts via the unified
   * applicationRumorDispatcher wired in MarmotContext (Story 02). The dispatcher's
   * LRU deduplication ensures the optimistic row is not double-applied.
   */
  const sendReaction = useCallback(
    async (emoji: string, targetMessage: ChatMessage, isRemoval?: boolean) => {
      if (!groupId || !group || !privateKeyHex) return;

      const thread = { kind: 'group' as const, groupId };

      // AC-36: build rumor exactly once so the optimistic row id == published event id.
      // No p tag for groups (spec §3.3).
      const rumor = buildReactionRumor({
        emoji,
        targetMessageId: targetMessage.id,
        targetMessageKind: CHAT_MESSAGE_KIND, // kind 9 for group messages
        targetAuthorPubkey: undefined, // groups omit p tag
        selfPrivKeyHex: privateKeyHex,
        isRemoval,
      });

      // AC-35 / AC-59: optimistic state update.
      //   remove path → tombstone the existing non-removed row in-place.
      //     Cannot insert a fresh removed:true row (applyOptimistic is idempotent on
      //     row id; a new UUID would leave the original add row untouched, keeping
      //     the badge visible).
      //   add path → insert new row keyed on rumor.id (the published id).
      if (isRemoval) {
        await applyOptimisticRemoval(thread, targetMessage.id, pubkey, emoji);
      } else {
        const optimisticRow: Reaction = {
          id: rumor.id,
          messageId: targetMessage.id,
          reactorPubkey: pubkey,
          emoji,
          eventId: '',
          createdAt: Date.now(),
          removed: false,
        };
        await applyOptimistic(thread, optimisticRow);
      }

      try {
        // AC-36: send via MLS (kind-445 on wire — no plaintext kind-7 published, AC-61)
        await sendRumorSafe(group, rumor as any);
      } catch (err) {
        // D7, AC-37, AC-59: rollback optimistic state on failure.
        // remove path → re-insert a fresh non-removed row so the badge returns.
        //   The original row id is unknown here; aggregateForMessage groups by
        //   (messageId, emoji) and counts non-removed rows, so re-inserting under
        //   rumor.id is observationally correct. No echo is expected on failure.
        // add path → rollbackOptimistic removes the in-flight insert by rumor.id.
        if (isRemoval) {
          const restoreRow: Reaction = {
            id: rumor.id,
            messageId: targetMessage.id,
            reactorPubkey: pubkey,
            emoji,
            eventId: '',
            createdAt: Date.now(),
            removed: false,
          };
          await applyOptimistic(thread, restoreRow);
        } else {
          await rollbackOptimistic(thread, rumor.id);
        }

        // Optimistic state was rolled back above. We re-throw with a
        // `couldntReact` sentinel that callers can detect; today every caller
        // swallows it (silent revert — no user-facing notice), matching the DM
        // path. The sentinel is retained so a caller could reintroduce failure
        // UX (e.g. an inline marker) without re-plumbing the throw.
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          couldntReact: true,
        });
      }
    },
    [groupId, group, pubkey, privateKeyHex],
  );

  /**
   * S5 (epic-feature-request-message-edit-and-delete): re-reads chatPersistence
   * for the slot's AUTHORITATIVE rev before clamping (mirrors S4's
   * resolveAuthoritativeRev fix — React state's `rev` field is never patched
   * by the optimistic view change these handlers apply before publish, so a
   * second own edit/delete of the same slot within the same wall-clock second
   * would otherwise compute rev from a stale/undefined snapshot and lose the
   * D16/AC-ORDER-5 clamp roughly half the time).
   */
  const resolveAuthoritativeGroupRev = useCallback(
    async (targetMessageId: string, fallbackRev: number | undefined): Promise<number> => {
      const { messages: fresh } = await loadMessages(groupId!);
      const row = fresh.find((m) => m.id === targetMessageId);
      return row?.rev ?? fallbackRev ?? 0;
    },
    [groupId],
  );

  /**
   * S5 gate-remediation (finding 3): thin wrapper delegating to the exported,
   * directly-testable `performGroupDeleteMessage`. See that function's doc
   * comment for the full behavior contract.
   */
  const handleDeleteMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (!groupId || !group || !privateKeyHex) return;
      await performGroupDeleteMessage(messageId, {
        group,
        groupId,
        privateKeyHex,
        pubkey,
        resolveAuthoritativeGroupRev,
        getSnapshot: () => messagesRef.current.find((m) => m.id === messageId),
        setMessages,
        isCurrentUserAdmin,
      });
    },
    [groupId, group, privateKeyHex, pubkey, resolveAuthoritativeGroupRev, isCurrentUserAdmin],
  );

  /**
   * S5 gate-remediation (finding 3): thin wrapper delegating to the exported,
   * directly-testable `performGroupEditMessage`. See that function's doc
   * comment for the full behavior contract.
   */
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string): Promise<void> => {
      if (!groupId || !group || !privateKeyHex) return;
      await performGroupEditMessage(messageId, newContent, {
        group,
        groupId,
        privateKeyHex,
        pubkey,
        resolveAuthoritativeGroupRev,
        getSnapshot: () => messagesRef.current.find((m) => m.id === messageId),
        setMessages,
      });
    },
    [groupId, group, privateKeyHex, pubkey, resolveAuthoritativeGroupRev],
  );

  // S5: __fewGroupMessageEdits dev bridge, mirroring DM's __fewDmMessageEdits
  // (ContactChat.tsx) and group's own __fewReactions (GroupChat.tsx) — gives
  // S7 (e2e) a ready hook without S5 needing to touch ChatBox.tsx/GroupChat.tsx
  // (both S6-owned). Guarded by NODE_ENV so it is tree-shaken in production.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!groupId) return;
    const bridge = {
      deleteMessage: (targetGroupId: string, messageId: string) => {
        if (targetGroupId !== groupId) return;
        void handleDeleteMessage(messageId).catch((e) => console.warn('[__fewGroupMessageEdits]', e));
      },
      editMessage: (targetGroupId: string, messageId: string, newContent: string) => {
        if (targetGroupId !== groupId) return;
        void handleEditMessage(messageId, newContent).catch((e) => console.warn('[__fewGroupMessageEdits]', e));
      },
    };
    (window as any).__fewGroupMessageEdits = bridge;
    return () => {
      if ((window as any).__fewGroupMessageEdits === bridge) {
        delete (window as any).__fewGroupMessageEdits;
      }
    };
  }, [handleDeleteMessage, handleEditMessage, groupId]);

  return (
    <ChatStoreContext.Provider
      value={{
        messages,
        sendMessage,
        sendImageMessage,
        sendReaction,
        reactionsByMessageId,
        loading,
        handleDeleteMessage,
        handleEditMessage,
      }}
    >
      {children}
    </ChatStoreContext.Provider>
  );
}

export function useChatStore(): ChatStoreContextValue {
  return useContext(ChatStoreContext);
}
