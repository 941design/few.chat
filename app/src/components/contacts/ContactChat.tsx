import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import type { EventSigner } from 'applesauce-core';
import type { MemberProfile } from '@/src/types';
import ChatBox from '@/src/components/chat/ChatBox';
import { useMarmot } from '@/src/context/MarmotContext';
import { reconcileMessagesWithStorage } from '@/src/context/ChatStoreContext';
import { subscribeStoreChangedFor } from '@/src/lib/crossTab';
import { isAllowedDmSenderComposite, isBlockedPeer, loadBlockedPeers } from '@/src/lib/blockedPeers';
import { loadKnownPeers } from '@/src/lib/knownPeers';
import { createLogger } from '@/src/lib/logger';
import { appendMessage, filterVisibleMessages, loadMessages, removeMessages, type ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { connectNdk, fetchEventsWithTimeout } from '@/src/lib/ndkClient';
import {
  buildChatRumor,
  decryptDirectMedia,
  decryptDirectPayload,
  directConversationId,
  feedbackMarkerTags,
  DIRECT_MESSAGE_KIND,
  GIFT_WRAP_KIND,
  parseDirectPayload,
  publishDirectDelete,
  publishDirectEdit,
  publishDirectReaction,
  removeDirectReaction,
  sealAndWrap,
  sendDirectImageMessage,
  shouldIngestRumor,
  unwrapAndOpen,
  CHAT_MESSAGE_KIND,
} from '@/src/lib/directMessages';
import type { ChatMediaAttachment } from '@/src/lib/media/imageMessage';
import { markDirectMessagesRead } from '@/src/lib/unreadStore';
import { setActiveView, clearActiveView } from '@/src/lib/activeViewStore';
import { applyOptimistic, applyOptimisticRemoval, rollbackOptimistic, applyInboundRumor } from '@/src/lib/reactions/api';
import type { Reaction } from '@/src/lib/reactions/types';
import { useDirectReactions } from '@/src/hooks/useDirectReactions';
import {
  applyDeleteEditSignal,
  resolvePendingSignalsForSlot,
  type ChangeResult,
  type InboundDeleteEditRumor,
} from '@/src/lib/messageEdits/api';
import { DELETE_EDIT_RUMOR_KIND, hasEditMarkerTag } from '@/src/lib/messageEdits/rumor';
import { useCopy } from '@/src/context/LanguageContext';

type ContactChatProps = {
  peerPubkeyHex: string;
  pubkeyHex: string;
  privateKeyHex: string;
  signer: EventSigner;
  profileMap: Record<string, MemberProfile>;
  /**
   * When 'feedback', outgoing text messages carry the sealed Few feedback
   * marker tags (client + l=feedback) on the inner rumor (AC-MARKER-1/2/3).
   * Omitted (ordinary DM) leaves the rumor with only the ["p", peer] tag.
   */
  source?: 'feedback';
  /** Optional composer placeholder override (feedback surface supplies its own). */
  composerPlaceholder?: string;
};

function toMessage(
  threadId: string,
  event: { id: string; pubkey: string; created_at?: number | null; createdAt?: number | null; content: string; attachments?: ChatMessage['attachments'] },
): ChatMessage {
  const createdAtSeconds = event.created_at ?? event.createdAt ?? Math.floor(Date.now() / 1000);
  return {
    id: event.id,
    content: event.content,
    senderPubkey: event.pubkey,
    groupId: threadId,
    createdAt: createdAtSeconds * 1000,
    ...(event.attachments ? { attachments: event.attachments } : {}),
  };
}

const dmLogger = createLogger('dm');

/**
 * S4 gate-remediation (round-4, finding 1/5): pure post-loop reconcile step for the
 * historical cold-load batch. `merged` is the batch of ChatMessage rows produced by
 * the historical rumor loop (kind-4 + kind-1059, sorted by createdAt) BEFORE this
 * reconcile; `storageTruth` is a fresh loadMessages() read taken AFTER the loop has
 * finished writing every signal for this batch. A same-batch kind-5 delete/edit that
 * sorts and applies AFTER its target inside the loop updates storage but not the row
 * OBJECT already captured in `merged` — this is the single place that repairs that,
 * by substituting storage's row for any id storage knows about and then dropping
 * tombstoned rows. Exported and pure so it is testable directly, without mounting
 * React (this repo's hooks-via-pure-function-extraction convention).
 */
export function reconcileHistoricalBatch(
  merged: ChatMessage[],
  storageTruth: ChatMessage[],
): ChatMessage[] {
  const storageById = new Map(storageTruth.map((m) => [m.id, m] as const));
  const substituted = merged.map((m) => storageById.get(m.id) ?? m);
  return filterVisibleMessages(substituted).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * S4 gate-remediation (finding 5): pure optimistic-delete view transform — the exact
 * transform handleDeleteMessage applies before publish. Exported so tests exercise
 * the real transform, not a re-derived copy.
 */
export function applyOptimisticDeleteView(view: ChatMessage[], messageId: string): ChatMessage[] {
  return view.filter((m) => m.id !== messageId);
}

/**
 * S4 gate-remediation (finding 5): pure delete-rollback view transform — restores
 * `snapshot` into `view` at its sorted position, used on a failed publish.
 */
export function rollbackOptimisticDeleteView(view: ChatMessage[], snapshot: ChatMessage): ChatMessage[] {
  return [...view, snapshot].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * S4 gate-remediation (finding 5): pure optimistic-edit view transform — patches
 * `messageId`'s content/edited flag in place, position preserved (AC-EDIT-2).
 */
export function applyOptimisticEditView(view: ChatMessage[], messageId: string, newContent: string): ChatMessage[] {
  return view.map((m) => (m.id === messageId ? { ...m, content: newContent, edited: true } : m));
}

/**
 * S4 gate-remediation (finding 5): pure edit-rollback view transform — restores
 * `snapshot` verbatim in place of `messageId`'s row, used on a failed publish.
 */
export function rollbackOptimisticEditView(view: ChatMessage[], messageId: string, snapshot: ChatMessage): ChatMessage[] {
  return view.map((m) => (m.id === messageId ? snapshot : m));
}

/**
 * S4 gate-remediation (round-2, live-path twin of the round-1 historical fix,
 * `reconcileHistoricalBatch`'s sibling for the single-message live append path):
 * pure post-append render decision for a freshly-appended original chat-message row.
 *
 * `result` is the outcome of S3's `resolvePendingSignalsForSlot` for `msg`'s slot;
 * `storageTruth` is a `loadMessages()` read taken AFTER that resolve has settled
 * (so it reflects any tombstone/edit the resolve just applied). Both live inbound
 * paths (kind-1059 gift-wrap and legacy kind-4) route through this single decision
 * point via `resolveFreshOriginal`.
 *
 * - `delete`: caller must not render the message at all → null.
 * - anything else (`edit`, `noop`, `discarded`, `pending`): substitute storage's
 *   row for `msg`'s id when storage knows it, falling further to null if that row
 *   is tombstoned. This matters beyond the `edit` case because the live
 *   giftWrapSub subscribes with no `since` filter — every resubscribe/reconnect
 *   re-delivers ALL stored gift-wraps, including the original of a since-deleted
 *   or since-edited message, which resolves as `noop`/`discarded`/`pending` (the
 *   slot already carries its terminal state) yet must still not re-render the raw
 *   stale `msg` object over storage truth.
 * - a row absent from storage (never persisted, e.g. a same-tick race) falls back
 *   to the raw `msg`, matching `reconcileHistoricalBatch`'s "no phantom
 *   substitution" behavior.
 *
 * Exported and pure so it is testable directly, without mounting React or mocking
 * IDB/S3 async plumbing (this repo's hooks-via-pure-function-extraction convention).
 */
export function resolveFreshOriginalFromStorage(
  msg: ChatMessage,
  result: ChangeResult,
  storageTruth: ChatMessage[],
): ChatMessage | null {
  if (result.kind === 'delete') return null;
  const stored = storageTruth.find((m) => m.id === msg.id);
  if (stored?.tombstoned) return null;
  return stored ?? msg;
}

/**
 * S4 test-rigor remediation (AC-VIEW-8..11): the single shared gate decision
 * every one of ContactChat's 4 DM-ingestion sites (historical kind-4,
 * historical kind-1059 gift-wrap loop, live kind-4 subscription, live
 * kind-1059 gift-wrap subscription) evaluates immediately before its persist
 * call (appendMessage/ingestEvent/applyInboundRumor/upsertMessages). Prior to
 * this extraction each site duplicated the isSelf-short-circuit-or-composite-gate
 * check inline — identical logic re-derived 4 times, provable only via source-text
 * regex. Exporting it as one pure function means every site now calls the
 * exact same tested decision, and that decision is directly unit-testable
 * (no jsdom/component mount needed) against the real fixture data each site
 * would pass it.
 *
 * `isSelf` is true only at the two kind-4 sites (a self-authored echo always
 * bypasses the gate); the two gift-wrap sites have no self-authored inbound
 * case and always pass `isSelf: false` (unchanged behavior — see the two
 * call sites below).
 *
 * `freshBlockedPeersSnapshot` (gate-remediation perf hoist): the AC-VIEW-14
 * staleness backstop below needs an authoritative, just-read `loadBlockedPeers()`
 * result, but reading+parsing localStorage fresh on EVERY call is only cheap
 * at live-DM cadence. The two LIVE subscription call sites omit this param
 * (default `undefined`) so they keep reading fresh per-event — that is where
 * the staleness window this backstop closes actually exists. The two
 * HISTORICAL batch call sites (which loop over up to hundreds of stored
 * events at thread-open, all decided within one synchronous pass — no
 * intervening block/unblock action can occur mid-batch) pass a single
 * snapshot taken once before the batch, avoiding hundreds of redundant
 * localStorage reads for a value that cannot change mid-batch.
 */
export function shouldIngestDmFromSender(
  senderPubkeyHex: string,
  isSelf: boolean,
  groups: ReadonlyArray<import('@/src/types').Group>,
  knownPeers: ReadonlySet<string>,
  blockedPeers: ReadonlySet<string>,
  ownPubkeyHex: string,
  freshBlockedPeersSnapshot?: ReadonlySet<string>,
): boolean {
  if (isSelf) return true;
  // AC-VIEW-14 hardening (gate-remediation finding 5): `blockedPeersRef`
  // (this function's `blockedPeers` param at every call site below) refreshes
  // in a passive `useEffect` that runs AFTER `notifyBlockedPeersChanged`'s
  // setState flushes — so a DM decrypted in the narrow window between the
  // block action's wipe completing and that effect's flush could otherwise
  // ingest through a stale ref (thread resurrection while blocked). Closed
  // deterministically here: `archiveContact` has already written
  // `archivedAt` synchronously, BEFORE the wipe even starts (see
  // `blockContactAction.ts#performBlockContact`'s statement order), so a
  // direct `loadBlockedPeers()` read is always current by the time any DM
  // could possibly be decrypted post-block. This authoritative direct read
  // is checked in addition to (not instead of) the faster ref-cached
  // `blockedPeers` set below, which remains the primary/common-case gate.
  // `freshBlockedPeersSnapshot`, when provided, stands in for that direct
  // read — see this function's doc comment for why only the historical
  // batch call sites provide it.
  const freshBlocked = freshBlockedPeersSnapshot ?? loadBlockedPeers();
  if (isBlockedPeer(senderPubkeyHex, freshBlocked)) return false;
  return isAllowedDmSenderComposite(senderPubkeyHex, groups, knownPeers, blockedPeers, ownPubkeyHex);
}

export default function ContactChat({
  peerPubkeyHex,
  pubkeyHex,
  privateKeyHex,
  signer,
  profileMap,
  source,
  composerPlaceholder,
}: ContactChatProps) {
  const copy = useCopy();
  // The sealed feedback channel. Each send path below gates on this
  // INDEPENDENTLY (text markers, onReact, allowImageAttachments — which also
  // drives ChatBox's paste/drop guards — and allowMessageActions); keep them
  // as separate explicit checks so every path stays individually auditable.
  const isFeedback = source === 'feedback';
  const { groups, ready: marmotReady, whenReady, knownPeersRevision, blockedPeersRevision } = useMarmot();
  // Ref for groups so subscription handlers always see the latest whitelist
  // without the effect needing to re-subscribe on every membership change.
  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  // Ref for ever-known peers — refreshed whenever groups change (which is also
  // when knownPeers may have been updated by MarmotContext's maintenance effect)
  // OR when knownPeersRevision bumps (an out-of-band write, e.g. manual
  // add-contact-by-npub, that doesn't correlate with a groups change).
  const knownPeersRef = useRef(loadKnownPeers());
  useEffect(() => { knownPeersRef.current = loadKnownPeers(); }, [groups, knownPeersRevision]);
  // Ref for the block set (epic: block-contact, S4 defense-in-depth) — refreshed
  // only on blockedPeersRevision (a dedicated counter bumped by archiveContact/
  // unarchiveContact via notifyBlockedPeersChanged), mirroring knownPeersRef's
  // ref-refresh pattern above but intentionally NOT tied to [groups,
  // knownPeersRevision] since a block/unblock is its own independent event.
  const blockedPeersRef = useRef(loadBlockedPeers());
  useEffect(() => { blockedPeersRef.current = loadBlockedPeers(); }, [blockedPeersRevision]);
  // Track MarmotContext readiness so the historical fetch can wait for the
  // group whitelist to be fully loaded before running the walled-garden gate.
  // Without this, a fast relay (< 100 ms) resolves the historical fetch before
  // MarmotContext.init() calls setGroups(), causing groupsRef.current === [] and
  // dropping all historical events from allowed senders.
  const marmotReadyRef = useRef(marmotReady);
  useEffect(() => { marmotReadyRef.current = marmotReady; }, [marmotReady]);
  const threadId = useMemo(() => directConversationId(peerPubkeyHex), [peerPubkeyHex]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // Story-07: DM reactions read side (S2). Map<messageId, ReactionAggregate[]>.
  const dmThread = useMemo(() => ({ kind: 'dm' as const, peerPubkeyHex }), [peerPubkeyHex]);
  const reactionsByMessageId = useDirectReactions(peerPubkeyHex, pubkeyHex, messages);
  // Ref to messages for use inside stable callbacks (avoids stale closure)
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Bug-fix (round-2, DM gate): synchronously-updated Set of known message ids.
  // messagesRef.current is synced via useEffect (after render), so there is a window
  // between setMessages and the next render where messagesRef.current is stale. A
  // kind-7 gift wrap arriving in that window would be silently discarded by a gate
  // reading messagesRef.current. knownMessageIdsRef is mutated in the same event-loop
  // tick as every message append, so it is always at least as fresh as React state.
  const knownMessageIdsRef = useRef<Set<string>>(new Set());

  const upsertMessages = useCallback((next: ChatMessage[]) => {
    for (const msg of next) knownMessageIdsRef.current.add(msg.id);
    setMessages((prev) => {
      const byId = new Map(prev.map((msg) => [msg.id, msg] as const));
      for (const msg of next) byId.set(msg.id, msg);
      return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
    });
  }, []);

  /**
   * Story-04 (epic-feature-request-message-edit-and-delete, S4): required S3 calling
   * convention — after appending a BRAND-NEW original chat-message row, immediately
   * resolve any buffered delete/edit for that slot (resolvePendingSignalsForSlot),
   * and sequence the render/state update AFTER that resolve completes, never between
   * the append and the resolve (AC-ORDER-4 "MUST NOT render" a to-be-deleted original).
   *
   * appendMessage does not report whether it performed a fresh insert or a dedup
   * no-op, so this is called unconditionally on every append; resolvePendingSignalsForSlot
   * is itself idempotent (no-ops when nothing is pending/already resolved), so a
   * redundant call on a re-delivered original is a safe, cheap no-op.
   *
   * Returns null when the resolved outcome is a delete (caller must not render the
   * message at all), the up-to-date ChatMessage when an edit won (re-read from storage
   * so the rendered content reflects the edit, not the stale just-appended original),
   * or storage's row for that id otherwise (noop/discarded/pending outcome — see
   * `resolveFreshOriginalFromStorage`'s docstring for why the live re-delivery case
   * needs storage truth here too, not just for `edit`).
   *
   * Thin async wrapper around the exported pure decision function
   * `resolveFreshOriginalFromStorage` — this function owns only the I/O
   * (resolvePendingSignalsForSlot + loadMessages); the render decision itself is
   * tested directly against the pure function.
   */
  const resolveFreshOriginal = useCallback(async (msg: ChatMessage): Promise<ChatMessage | null> => {
    const result: ChangeResult = await resolvePendingSignalsForSlot(dmThread, msg.id, msg.senderPubkey);
    const { messages: fresh } = await loadMessages(threadId);
    return resolveFreshOriginalFromStorage(msg, result, fresh);
  }, [dmThread, threadId]);

  /**
   * S4: inbound kind-5 (delete / edit-marked-companion) and edit-marked kind-14
   * dispatch — routed through S3's applyDeleteEditSignal unconditionally (no
   * knownMessageIdsRef gate: unlike the kind-7 reaction gate, S3 itself buffers an
   * unknown-target signal — retain-and-apply, AC-ORDER-1). Mirrors the storage write
   * with a local React-state update so the DM's own view reflects the outcome
   * immediately (AC-DEL-3-adjacent: the row this component renders must not lag the
   * row S3 just persisted) — re-reads the row from storage for an 'edit' outcome to
   * pick up the new content, and drops the row from state outright for a 'delete'
   * outcome (AC-ORDER-4 "MUST NOT render").
   */
  const applyInboundDeleteEditSignal = useCallback(async (rumor: InboundDeleteEditRumor): Promise<ChangeResult> => {
    const result = await applyDeleteEditSignal(dmThread, rumor);
    if (result.kind === 'delete' && result.slotId) {
      const deletedId = result.slotId;
      setMessages((prev) => prev.filter((m) => m.id !== deletedId));
    } else if (result.kind === 'edit' && result.slotId) {
      const editedId = result.slotId;
      const { messages: fresh } = await loadMessages(threadId);
      const updated = fresh.find((m) => m.id === editedId);
      if (updated) setMessages((prev) => prev.map((m) => (m.id === editedId ? updated : m)));
    }
    return result;
  }, [dmThread, threadId]);

  const ingestEvent = useCallback(async (
    event: { id: string; pubkey: string; content: string; created_at?: number },
  ): Promise<ChatMessage | null> => {
    const peerForDecrypt = event.pubkey.toLowerCase() === pubkeyHex.toLowerCase()
      ? peerPubkeyHex
      : event.pubkey;
    const decrypted = await decryptDirectPayload(event.content, privateKeyHex, peerForDecrypt);
    if (!decrypted) return null;
    const msg = toMessage(threadId, {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      content: decrypted.content,
      attachments: decrypted.attachments,
    });
    await appendMessage(threadId, msg);
    knownMessageIdsRef.current.add(msg.id);
    return resolveFreshOriginal(msg);
  }, [peerPubkeyHex, privateKeyHex, pubkeyHex, threadId, resolveFreshOriginal]);

  // Cross-tab change notifications (multi-tab design S0): another open tab
  // wrote to THIS thread (a message sent or received there, an edit, a
  // delete). Re-read storage and reconcile through the same merge the group
  // chat uses — storage truth replaces rendered rows, new rows are added,
  // tombstoned rows drop out, and a pending optimistic send (not yet in
  // storage) survives.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeStoreChangedFor('chat', threadId, () => {
      loadMessages(threadId)
        .then(({ messages: stored }) => {
          if (cancelled) return;
          for (const msg of stored) knownMessageIdsRef.current.add(msg.id);
          setMessages((prev) => reconcileMessagesWithStorage(prev, stored));
        })
        .catch(() => {
          // Best-effort refresh — a read failure leaves the view as it is.
        });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    // Legacy NIP-04 kind-4 subscriptions (inbound forever — D9a)
    let incomingSub: any = null;
    let outgoingSub: any = null;
    // NIP-17/59 kind-1059 gift-wrap subscription (new inbound path)
    let giftWrapSub: any = null;

    async function init() {
      setLoading(true);
      try {
        const { messages: stored, refetchIds } = await loadMessages(threadId);
        if (!cancelled) {
          for (const msg of stored) knownMessageIdsRef.current.add(msg.id);
          // S4 gate-remediation (finding 3a): filter tombstoned rows out of the very
          // first render — an unfiltered raw loadMessages() seed rendered a deleted
          // message for the whole session until some later signal happened to touch
          // this thread.
          setMessages(filterVisibleMessages(stored));
        }

        // S4 ledger obligation: the pending-buffer/delete-marker TTL sweep
        // (messageEdits/api.ts) is lazy — it only runs when applyDeleteEditSignal or
        // resolvePendingSignalsForSlot is next called for this thread. Without an
        // explicit trigger, a pending delete whose target never arrives could sit
        // past its TTL without materializing into a durable marker until some
        // unrelated future signal happens to touch this thread. Trigger a sweep on
        // thread-open by calling resolvePendingSignalsForSlot with a sentinel id that
        // can never match a real row (a real row id is always a 64-char hex rumor id,
        // never empty) — it resolves to a no-op for that id but still runs the
        // general thread sweep as a side effect. Fire-and-forget relative to init():
        // this is bookkeeping hygiene, not on the critical path for first render.
        //
        // S4 gate-remediation (finding 3b): the sweep can itself tombstone a durably
        // present row (self-heal materializing an expired pending/marker), but the
        // stale un-tombstoned React copy would otherwise stay visible for the rest of
        // the session since nothing else re-reads storage afterward. Await the sweep,
        // then re-read storage once and merge it into state (never a blind replace —
        // an in-flight optimistic send not yet persisted must survive), filtering
        // tombstoned rows on the way out.
        void (async () => {
          try {
            await resolvePendingSignalsForSlot(dmThread, '', '');
          } catch {
            // Sweep bookkeeping failure — non-fatal, nothing to reconcile.
            return;
          }
          if (cancelled) return;
          try {
            const { messages: freshAfterSweep } = await loadMessages(threadId);
            if (cancelled) return;
            for (const msg of freshAfterSweep) knownMessageIdsRef.current.add(msg.id);
            setMessages((prev) => {
              const byId = new Map(prev.map((m) => [m.id, m] as const));
              for (const m of freshAfterSweep) byId.set(m.id, m);
              return filterVisibleMessages(Array.from(byId.values())).sort((a, b) => a.createdAt - b.createdAt);
            });
          } catch {
            // Best-effort reconciliation — a read failure here leaves state as-is.
          }
        })();

        // Story-04 (§3.4): coordinate refetch for non-canonical message ids.
        // loadMessages returns the malformed ids; we attempt a relay refetch
        // async so it does not block the first render. On success, the malformed
        // row is removed (state + IDB) and the canonical replacement is upserted.
        // Malformed ids whose refetch yields no replacement are left in place so
        // the message stays visible (per spec §3.4).
        if (refetchIds.length > 0) {
          // Log at info level per §3.6 — the message is still visible (left in
          // place) so this is not an error.
          console.info('[dm:self-heal] non-canonical ids enqueued for refetch:', refetchIds);
          void (async () => {
            try {
              const ndk = await connectNdk(privateKeyHex);
              const results = await fetchEventsWithTimeout(ndk, {
                kinds: [DIRECT_MESSAGE_KIND, GIFT_WRAP_KIND],
                ids: refetchIds,
              });
              // Track malformed-id → canonical-message pairs so we can drop the
              // malformed row when the canonical id differs (always true for
              // gift-wrap refetches: outer wrap id ≠ inner rumor id).
              const replacements: Array<{ malformedId: string; canonical: ChatMessage }> = [];
              for (const evt of results.events) {
                const rawEvt = {
                  kind: evt.kind ?? DIRECT_MESSAGE_KIND,
                  content: evt.content,
                  tags: evt.tags as string[][],
                  pubkey: evt.pubkey,
                  created_at: evt.created_at ?? Math.floor(Date.now() / 1000),
                  id: evt.id,
                  sig: (evt as any).sig ?? '',
                };
                if (evt.kind === GIFT_WRAP_KIND) {
                  try {
                    const rumor = await unwrapAndOpen(rawEvt as any, privateKeyHex);
                    if (!shouldIngestRumor(rumor, peerPubkeyHex)) continue;
                    if (rumor.kind !== CHAT_MESSAGE_KIND) continue;
                    const parsed = parseDirectPayload(rumor.content);
                    if (!parsed) continue;
                    const canonical = toMessage(threadId, {
                      id: rumor.id,
                      pubkey: rumor.pubkey,
                      created_at: rumor.created_at,
                      content: parsed.content,
                      attachments: parsed.attachments,
                    });
                    // S4 gate-remediation (finding 7): route through appendMessage +
                    // resolveFreshOriginal like every other append site — pushing the
                    // canonical row straight into `replacements` bypassed storage
                    // entirely, so a buffered delete/edit for this id could neither
                    // suppress the render nor ever be applied by the self-heal sweep
                    // (a row that never entered storage can never be its target).
                    await appendMessage(threadId, canonical);
                    knownMessageIdsRef.current.add(canonical.id);
                    const resolved = await resolveFreshOriginal(canonical);
                    if (resolved) replacements.push({ malformedId: evt.id, canonical: resolved });
                  } catch {
                    // Refetch failed for this wrap — leave the malformed row in place.
                    continue;
                  }
                } else {
                  const canonical = await ingestEvent({
                    id: evt.id,
                    pubkey: evt.pubkey,
                    content: evt.content,
                    created_at: evt.created_at,
                  });
                  if (canonical) replacements.push({ malformedId: evt.id, canonical });
                }
              }
              if (replacements.length > 0 && !cancelled) {
                // For ids that genuinely changed (gift-wrap path), drop the
                // malformed row from IDB and React state before upserting the
                // canonical replacement. The kind-4 path keeps the same id so
                // there's nothing to drop — upsertMessages replaces in place.
                const malformedIdsToDrop = replacements
                  .filter((r) => r.malformedId !== r.canonical.id)
                  .map((r) => r.malformedId);
                if (malformedIdsToDrop.length > 0) {
                  await removeMessages(threadId, malformedIdsToDrop);
                  const dropSet = new Set(malformedIdsToDrop);
                  setMessages((prev) => prev.filter((m) => !dropSet.has(m.id)));
                }
                upsertMessages(replacements.map((r) => r.canonical));
              }
            } catch {
              // Refetch failed — malformed rows remain in place (per spec §3.4).
            }
          })();
        }

        const ndk = await connectNdk(privateKeyHex);

        // Fetch historical kind-4 messages (legacy inbound path — D9a)
        // and kind-1059 gift wraps (new inbound path — G3 fix).
        // Both fire in parallel; step 5 waits for both to settle.
        const [incoming, outgoing, giftWrapHistorical] = await Promise.all([
          fetchEventsWithTimeout(ndk, { kinds: [DIRECT_MESSAGE_KIND], '#p': [pubkeyHex], authors: [peerPubkeyHex], limit: 200 }),
          fetchEventsWithTimeout(ndk, { kinds: [DIRECT_MESSAGE_KIND], '#p': [peerPubkeyHex], authors: [pubkeyHex], limit: 200 }),
          fetchEventsWithTimeout(ndk, { kinds: [GIFT_WRAP_KIND], '#p': [pubkeyHex], limit: 500 }),
        ]);

        // AC-SEC-6 race guard: wait for MarmotContext to finish loading groups
        // before running the walled-garden gate on ALL historical events (both kind-4
        // and kind-1059). On a fast relay (localhost strfry) the historical fetch
        // resolves in < 100 ms, well before MarmotContext.init() calls setGroups().
        // Without this wait, groupsRef.current is [] when we call isAllowedDmSender,
        // which drops every historical event from an allowed sender (false-positive
        // walled-garden drop).
        // Await MarmotContext readiness via its whenReady() promise, with a
        // 5-second ceiling so the chat still renders on slow networks / degraded
        // state rather than hanging indefinitely. Replaces a 50 ms setInterval poll.
        if (!marmotReadyRef.current) {
          const MAX_WAIT_MS = 5_000;
          await Promise.race([
            whenReady(),
            new Promise<void>((resolve) => setTimeout(resolve, MAX_WAIT_MS)),
          ]);
        }

        // Perf hoist (gate-remediation finding 2): a single fresh
        // loadBlockedPeers() snapshot for the WHOLE historical batch below
        // (both the kind-4 loop immediately following and the kind-1059
        // gift-wrap loop further down) instead of one fresh read per
        // historical event. Safe because the entire batch below runs as one
        // synchronous decision pass at thread-open — no block/unblock action
        // can land mid-batch to make a per-event re-read necessary — unlike
        // the two LIVE subscription handlers further down, which intentionally
        // keep reading fresh per event (see shouldIngestDmFromSender's doc
        // comment).
        const historicalBlockedPeersSnapshot = loadBlockedPeers();

        // Process kind-4 results (existing path — D9a).
        // AC-SEC-6/AC-SEC-8: apply the walled-garden gate to peer-authored historical
        // kind-4 events (the fourth inbound path).  Self-authored outgoing events
        // bypass the gate — isAllowedDmSender returns false for own pubkey by design,
        // but the user's own messages must always be allowed.
        const handleHistoricalKind4Event = async (
          evt: { id: string; pubkey: string; content: string; created_at?: number },
        ): Promise<ChatMessage | null> => {
          const senderPeer = evt.pubkey.toLowerCase();
          const isSelf = senderPeer === pubkeyHex.toLowerCase();
          if (!shouldIngestDmFromSender(senderPeer, isSelf, groupsRef.current, knownPeersRef.current, blockedPeersRef.current, pubkeyHex, historicalBlockedPeersSnapshot)) {
            dmLogger.info('dm:walled-garden-drop', { pubkey: senderPeer.slice(0, 8), kind: 4 });
            return null;
          }
          return ingestEvent(evt).catch(() => null);
        };

        const remoteMessages = (
          await Promise.all(
            [...incoming.events, ...outgoing.events].map((evt) => handleHistoricalKind4Event({
              id: evt.id,
              pubkey: evt.pubkey,
              content: evt.content,
              created_at: evt.created_at,
            })),
          )
        ).filter((msg): msg is ChatMessage => !!msg);

        // Process kind-1059 historical results through the gift-wrap handler.
        // Each successfully unwrapped chat-message rumor is collected so it can be
        // merged into upsertMessages alongside the kind-4 results — without this,
        // historical NIP-17 DMs land in IDB but stay invisible until the user
        // closes and reopens the chat (the §3.5 merge requirement).
        //
        // Implementation note: kind-7 (reaction) rumors are processed here too so
        // that the reactions IDB is in the correct terminal state before the live
        // subscription opens. Without this, the live sub re-delivers all stored
        // events (reaction + removal) in arbitrary order, which can result in the
        // removal event arriving before the reaction and being silently discarded,
        // leaving the reaction in IDB as non-removed. Processing historically
        // (with sort by created_at) eliminates the ordering race.
        //
        // Approach: unwrap all events in parallel (expensive crypto), then sort
        // the successfully-unwrapped rumors by created_at and apply sequentially
        // so that reactions are always processed before their removals.
        const giftWrapMessages: ChatMessage[] = [];

        type UnwrappedRumor = Awaited<ReturnType<typeof unwrapAndOpen>>;
        const unwrapHistoricalEvent = async (evt: NDKEvent): Promise<{ rumor: UnwrappedRumor; evt: NDKEvent } | null> => {
          try {
            const rawEvt = {
              kind: evt.kind ?? GIFT_WRAP_KIND,
              content: evt.content,
              tags: evt.tags as string[][],
              pubkey: evt.pubkey,
              created_at: evt.created_at ?? Math.floor(Date.now() / 1000),
              id: evt.id,
              sig: (evt as any).sig ?? '',
            };
            const rumor = await unwrapAndOpen(rawEvt as any, privateKeyHex);
            return { rumor, evt };
          } catch {
            // Silently ignore gift wraps we can't decrypt (other-conversation traffic).
            return null;
          }
        };

        const unwrappedHistorical = (
          await Promise.all([...giftWrapHistorical.events].map(unwrapHistoricalEvent))
        )
          .filter((r): r is { rumor: UnwrappedRumor; evt: NDKEvent } => r !== null)
          .sort((a, b) => (a.rumor.created_at ?? 0) - (b.rumor.created_at ?? 0));

        for (const { rumor } of unwrappedHistorical) {
          if (!shouldIngestRumor(rumor, peerPubkeyHex)) continue;
          // AC-SEC-6: walled-garden gate — in addition to thread isolation.
          // historicalBlockedPeersSnapshot (perf hoist, see its declaration
          // above): this loop is part of the same historical batch pass.
          const senderPeer = rumor.pubkey.toLowerCase();
          if (!shouldIngestDmFromSender(senderPeer, false, groupsRef.current, knownPeersRef.current, blockedPeersRef.current, pubkeyHex, historicalBlockedPeersSnapshot)) {
            dmLogger.info('dm:walled-garden-drop', { pubkey: senderPeer.slice(0, 8), kind: rumor.kind });
            continue;
          }
          if (rumor.kind === DELETE_EDIT_RUMOR_KIND) {
            // S4: kind-5 delete/edit-companion signal. Unlike kind-7's
            // discard-on-unknown-target gate below, S3's applyDeleteEditSignal itself
            // buffers an unknown-target signal (retain-and-apply, AC-ORDER-1) — no
            // knownMessageIdsRef gate, called unconditionally.
            await applyInboundDeleteEditSignal(rumor);
            continue;
          }
          if (rumor.kind === 7) {
            // Kind-7 reaction/removal: apply in created_at order so that reactions
            // always land before their removals, giving applyInboundRumor the correct
            // row state to work with. The knownMessageIdsRef guard mirrors the live
            // subscription dispatcher: silently discard reactions for unknown messages.
            const targetETag = rumor.tags?.find((t: string[]) => t[0] === 'e');
            const targetMessageId = targetETag?.[1];
            if (targetMessageId && knownMessageIdsRef.current.has(targetMessageId)) {
              await applyInboundRumor({ kind: 'dm', peerPubkeyHex }, rumor);
            }
            continue;
          }
          if (rumor.kind === CHAT_MESSAGE_KIND && hasEditMarkerTag(rumor.tags)) {
            // S4: edit-marked replacement — route through S3's reconciliation, not
            // the plain-original ingest path below.
            await applyInboundDeleteEditSignal(rumor);
            continue;
          }
          if (rumor.kind === CHAT_MESSAGE_KIND) {
            const parsed = parseDirectPayload(rumor.content);
            if (!parsed) continue;
            const msg = toMessage(threadId, {
              id: rumor.id,
              pubkey: rumor.pubkey,
              created_at: rumor.created_at,
              content: parsed.content,
              attachments: parsed.attachments,
            });
            await appendMessage(threadId, msg);
            // Update knownMessageIdsRef immediately so that a kind-7 reaction
            // processed later in this same loop can find the message.
            knownMessageIdsRef.current.add(msg.id);
            // S4 (AC-ORDER-4): resolve any buffered signal for this fresh original
            // BEFORE it is queued for render below.
            const resolved = await resolveFreshOriginal(msg);
            if (resolved) giftWrapMessages.push(resolved);
          }
        }

        // Step 5 (§3.5): merge both result sets, sort by createdAt, reconcile against
        // storage truth once, then set state.
        //
        // S4 gate-remediation (finding 1, sev7 — the primary offline-delete path): the
        // historical loop above accumulates fresh ORIGINAL row objects into
        // remoteMessages/giftWrapMessages as it walks the sorted rumor batch — but a
        // same-batch kind-5 delete (which sorts AFTER its target) tombstones storage
        // via applyInboundDeleteEditSignal without ever touching the original row
        // OBJECT already pushed earlier in the loop. Upserting that stale object
        // straight into state re-rendered a message the peer sent-then-deleted while
        // this device was offline, for the rest of the session (same issue for a
        // same-batch edit — stale pre-edit content rendered). reconcileHistoricalBatch
        // is the single repair point: it re-substitutes storage's row for every id
        // storage knows about, then filters tombstoned rows (finding 3, defense in
        // depth alongside S6's shared ChatBox filter).
        if (!cancelled) {
          const merged = [...remoteMessages, ...giftWrapMessages].sort((a, b) => a.createdAt - b.createdAt);
          const { messages: storageTruth } = await loadMessages(threadId);
          const reconciled = reconcileHistoricalBatch(merged, storageTruth);
          for (const msg of reconciled) knownMessageIdsRef.current.add(msg.id);
          if (!cancelled) {
            setMessages((prev) => {
              const byId = new Map(prev.map((m) => [m.id, m] as const));
              for (const m of reconciled) byId.set(m.id, m);
              return filterVisibleMessages(Array.from(byId.values())).sort((a, b) => a.createdAt - b.createdAt);
            });
          }
        }

        // --- Legacy kind-4 live subscriptions (inbound only, forever per D9a) ---
        incomingSub = ndk.subscribe({ kinds: [DIRECT_MESSAGE_KIND], '#p': [pubkeyHex], authors: [peerPubkeyHex] });
        outgoingSub = ndk.subscribe({ kinds: [DIRECT_MESSAGE_KIND], '#p': [peerPubkeyHex], authors: [pubkeyHex] });

        const handleKind4Event = (evt: { id: string; pubkey: string; content: string; created_at?: number }) => {
          // AC-SEC-6: walled-garden gate before appendMessage (via ingestEvent).
          // Self-authored echoes (outgoingSub) bypass the gate — isAllowedDmSender
          // returns false for own pubkey by design, but own messages are legitimate.
          const senderPeer = evt.pubkey.toLowerCase();
          const isSelf = senderPeer === pubkeyHex.toLowerCase();
          if (!shouldIngestDmFromSender(senderPeer, isSelf, groupsRef.current, knownPeersRef.current, blockedPeersRef.current, pubkeyHex)) {
            dmLogger.info('dm:walled-garden-drop', { pubkey: senderPeer.slice(0, 8), kind: 4 });
            return;
          }
          void ingestEvent(evt).then((msg) => {
            if (!msg || cancelled) return;
            upsertMessages([msg]);
          }).catch(() => {});
        };

        if (incomingSub) incomingSub.on?.('event', handleKind4Event);
        if (outgoingSub) outgoingSub.on?.('event', handleKind4Event);

        // --- NIP-17/59 kind-1059 gift-wrap subscription (new inbound path) ---
        // Filter: kind 1059 addressed to selfPubkey (pubkeyHex). No author filter —
        // the outer wrap uses an ephemeral key, so author filtering would miss all messages.
        giftWrapSub = ndk.subscribe({ kinds: [GIFT_WRAP_KIND], '#p': [pubkeyHex] });

        const handleGiftWrapEvent = (evt: NDKEvent) => {
          void (async () => {
            try {
              const rawEvt = {
                kind: evt.kind ?? GIFT_WRAP_KIND,
                content: evt.content,
                tags: evt.tags as string[][],
                pubkey: evt.pubkey,
                created_at: evt.created_at ?? Math.floor(Date.now() / 1000),
                id: evt.id,
                sig: (evt as any).sig ?? '',
              };
              const rumor = await unwrapAndOpen(rawEvt as any, privateKeyHex);

              // Thread isolation: gift wraps for selfPubkey arrive from any sender.
              // The legacy kind-4 path is filtered by authors: [peerPubkeyHex], but
              // kind-1059's outer key is ephemeral per NIP-59, so we must validate the
              // inner rumor pubkey here.
              if (!shouldIngestRumor(rumor, peerPubkeyHex)) return;

              // AC-SEC-6/7: walled-garden gate — runs after thread isolation, before
              // any write path (appendMessage, upsertMessages, applyInboundRumor).
              const rumorSender = rumor.pubkey.toLowerCase();
              if (!shouldIngestDmFromSender(rumorSender, false, groupsRef.current, knownPeersRef.current, blockedPeersRef.current, pubkeyHex)) {
                dmLogger.info('dm:walled-garden-drop', { pubkey: rumorSender.slice(0, 8), kind: rumor.kind });
                return;
              }

              // S4: kind-5 delete/edit-companion signal (epic-feature-request-message-
              // edit-and-delete). Unlike kind-7's discard-on-unknown-target gate below,
              // S3's applyDeleteEditSignal itself buffers an unknown-target signal
              // (retain-and-apply, AC-ORDER-1) — no knownMessageIdsRef gate, called
              // unconditionally.
              if (rumor.kind === DELETE_EDIT_RUMOR_KIND) {
                await applyInboundDeleteEditSignal(rumor);
                return;
              }

              // Story-07: kind-7 (reaction) inbound dispatch (AC-45, S4).
              if (rumor.kind === 7) {
                // Dispatcher gate: only call applyInboundRumor if the target message is
                // known to this thread (spec §2.4 silent discard for unknown messages).
                // Bug-fix (round-2): use knownMessageIdsRef instead of messagesRef.current.
                // messagesRef.current is synced via useEffect (runs after render), so it can
                // be stale for a kind-7 that arrives between a setMessages call and the next
                // render. knownMessageIdsRef is mutated synchronously alongside every message
                // append and is therefore never stale.
                const targetETag = rumor.tags?.find((t: string[]) => t[0] === 'e');
                const targetMessageId = targetETag?.[1];
                if (!targetMessageId) return; // malformed rumor
                if (!knownMessageIdsRef.current.has(targetMessageId)) return; // silent discard per spec §2.4
                await applyInboundRumor({ kind: 'dm', peerPubkeyHex }, rumor);
                // subscribeReactions listeners fire automatically after the idb write,
                // driving reactionsByMessageId recompute in useDirectReactions.
                return;
              }

              // Only process kind-14 (chat message) inner rumors below.
              if (rumor.kind !== CHAT_MESSAGE_KIND) return;

              // S4: edit-marked replacement — route through S3's reconciliation, not
              // the plain-original ingest path below.
              if (hasEditMarkerTag(rumor.tags)) {
                await applyInboundDeleteEditSignal(rumor);
                return;
              }

              // Parse the kind-14 payload (same JSON envelope as NIP-04 path)
              const parsed = parseDirectPayload(rumor.content);
              if (!parsed) return;

              const msg = toMessage(threadId, {
                id: rumor.id,
                pubkey: rumor.pubkey,
                created_at: rumor.created_at,
                content: parsed.content,
                attachments: parsed.attachments,
              });
              await appendMessage(threadId, msg);
              knownMessageIdsRef.current.add(msg.id);
              // S4 (AC-ORDER-4): resolve any buffered signal for this fresh original —
              // sequenced BEFORE the render/state update below, never between the
              // append above and this resolve.
              const resolved = await resolveFreshOriginal(msg);
              // Re-check cancelled after the async work to avoid stale state updates
              if (!cancelled && resolved) upsertMessages([resolved]);
            } catch {
              // Silently ignore gift wraps we can't decrypt (e.g. from other conversations)
            }
          })();
        };

        if (giftWrapSub) giftWrapSub.on?.('event', handleGiftWrapEvent);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
      incomingSub?.stop?.();
      outgoingSub?.stop?.();
      giftWrapSub?.stop?.();
    };
  }, [applyInboundDeleteEditSignal, dmThread, ingestEvent, peerPubkeyHex, privateKeyHex, pubkeyHex, resolveFreshOriginal, threadId, upsertMessages]);

  // Mark the thread read whenever it is open and new messages land — the user
  // is actively viewing this chat, so any incoming DM is "seen" by definition.
  useEffect(() => {
    markDirectMessagesRead(peerPubkeyHex);
  }, [peerPubkeyHex, messages.length]);

  // Register this DM thread as the active view (epic: notification-domain-
  // invariants, INV-2): while it is open, a DM from this peer must NOT ring the
  // bell — directMessageNotifications consults isActiveView('dm', peer) and
  // skips the increment; the effect above still advances last-read. Cleared on
  // unmount / peer change so a DM from this peer rings the bell once the thread
  // is closed (INV-1).
  useEffect(() => {
    setActiveView({ domain: 'dm', id: peerPubkeyHex });
    return () => clearActiveView();
  }, [peerPubkeyHex]);

  const sendMessage = useCallback(async (content: string) => {
    // Build the NIP-17 kind-14 rumor first so we know its id before any network
    // round-trip. The rumor id is the stable message id used by appendMessage and
    // dedup — the outer kind-1059 wrap id is irrelevant to the UI layer.
    // AC-MARKER-1/3: feedback sends carry the sealed marker tags; ordinary DMs
    // pass no extraTags, so their rumor keeps only the ["p", peer] tag.
    const extraTags = isFeedback ? feedbackMarkerTags() : undefined;
    const rumor = buildChatRumor({ privateKeyHex, peerPubkeyHex, content, extraTags });
    const optimistic = toMessage(threadId, {
      id: rumor.id,
      pubkey: pubkeyHex,
      created_at: rumor.created_at,
      content,
    });
    upsertMessages([optimistic]);

    try {
      const ndk = await connectNdk(privateKeyHex);
      const wrap = await sealAndWrap(rumor, peerPubkeyHex, privateKeyHex);
      const ndkEvent = new NDKEvent(ndk, wrap as any);
      await ndkEvent.publish();
      await appendMessage(threadId, optimistic);
    } catch (err) {
      setMessages((prev) => prev.filter((msg) => msg.id !== rumor.id));
      throw err;
    }
  }, [peerPubkeyHex, privateKeyHex, pubkeyHex, threadId, upsertMessages, isFeedback]);

  const sendImageMessage = useCallback(async (file: File, caption: string) => {
    const now = Math.floor(Date.now() / 1000);
    const tempId = crypto.randomUUID();
    const optimistic = toMessage(threadId, {
      id: tempId,
      pubkey: pubkeyHex,
      created_at: now,
      content: JSON.stringify({ type: 'image', version: 1, caption }),
      attachments: { full: null, thumb: null },
    });
    upsertMessages([optimistic]);

    try {
      const ndk = await connectNdk(privateKeyHex);
      const result = await sendDirectImageMessage({
        ndk,
        privateKeyHex,
        peerPubkeyHex,
        signer,
        caption,
        file,
        onProgress: () => {},
      });
      const finalMsg = {
        ...optimistic,
        id: result.eventId,
        attachments: result.attachments,
      };
      // See sendMessage above: NDK's optimistic dispatch can race the swap and
      // leave a duplicate echo entry under the real event id.
      // Also register the real event id synchronously so the kind-7 gate is up-to-date.
      knownMessageIdsRef.current.add(result.eventId);
      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.id !== tempId && msg.id !== result.eventId);
        return [...filtered, finalMsg].sort((a, b) => a.createdAt - b.createdAt);
      });
      await appendMessage(threadId, finalMsg);
    } catch (err) {
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      throw err;
    }
  }, [peerPubkeyHex, privateKeyHex, pubkeyHex, signer, threadId, upsertMessages]);

  const decryptMedia = useCallback((attachment: ChatMediaAttachment) => {
    return decryptDirectMedia(attachment as any, privateKeyHex, peerPubkeyHex);
  }, [peerPubkeyHex, privateKeyHex]);

  /**
   * Story-07: DM reaction send handler (AC-43, AC-44, AC-54, AC-55).
   *
   * Builds the rumor ONCE (single call to buildReactionRumor), writes the optimistic
   * row with the real rumor id (AC-43 — no temp UUID), seals+wraps, publishes,
   * and silently rolls back the optimistic state on failure (D7). The optimistic
   * reaction simply disappears — no user-facing notice.
   *
   * The single-build design avoids the created_at second-boundary race that would
   * arise if we built the rumor twice (once for the id, once for publish). By
   * reusing the same rumor object we guarantee the optimistic row id and the
   * published event id are always identical.
   */
  const handleReact = useCallback(async (emoji: string, message: ChatMessage, op: 'add' | 'remove') => {
    const ndk = await connectNdk(privateKeyHex);

    // Build the rumor exactly once so the optimistic row id == published event id (AC-43).
    const { buildReactionRumor } = await import('@/src/lib/reactions/rumor');
    const rumor = buildReactionRumor({
      emoji,
      targetMessageId: message.id,
      targetMessageKind: CHAT_MESSAGE_KIND,
      targetAuthorPubkey: peerPubkeyHex,
      selfPrivKeyHex: privateKeyHex,
      isRemoval: op === 'remove',
    });
    const rumorId = rumor.id;

    // AC-43 / AC-59: optimistic state update.
    //   add path → insert new row keyed on rumorId (the published id).
    //   remove path → tombstone the existing non-removed row in-place. We
    //   cannot insert a fresh row with `removed: true` keyed on the new
    //   rumorId, because applyOptimistic is idempotent on row id and would
    //   leave the original add row untouched, keeping the badge visible.
    if (op === 'remove') {
      await applyOptimisticRemoval(dmThread, message.id, pubkeyHex, emoji);
    } else {
      const optimisticRow: Reaction = {
        id: rumorId,
        messageId: message.id,
        reactorPubkey: pubkeyHex,
        emoji,
        eventId: '',
        createdAt: Date.now(),
        removed: false,
      };
      await applyOptimistic(dmThread, optimisticRow);
    }

    try {
      // Seal and publish the pre-built rumor directly (avoids rebuilding and any id mismatch).
      const wrap = await sealAndWrap(rumor, peerPubkeyHex, privateKeyHex);
      const ndkEvent = new NDKEvent(ndk, wrap as any);
      await ndkEvent.publish();
      // Success: the echo will reconcile via inbound dispatch (applyInboundRumor).
    } catch (err) {
      // AC-44, D7: silently roll back the optimistic state (no toast).
      // For the add path, rollbackOptimistic deletes the in-flight insert by id.
      // For the remove path, we re-insert a fresh non-removed row so the badge
      // returns. The original row id is unknown here; aggregateForMessage groups
      // by (messageId, emoji) and counts non-removed rows, so re-inserting under
      // a new id is observationally correct. The inbound echo would later dedup
      // on (messageId, reactorPubkey, emoji) but this branch only fires on
      // publish failure, so no echo is expected.
      if (op === 'remove') {
        const restoreRow: Reaction = {
          id: rumorId,
          messageId: message.id,
          reactorPubkey: pubkeyHex,
          emoji,
          eventId: '',
          createdAt: Date.now(),
          removed: false,
        };
        await applyOptimistic(dmThread, restoreRow);
      } else {
        await rollbackOptimistic(dmThread, rumorId);
      }
      throw err;
    }
  }, [dmThread, peerPubkeyHex, privateKeyHex, pubkeyHex]);

  /**
   * S4 (epic-feature-request-message-edit-and-delete): DM delete handler — the DM
   * half of the MessageActionHandlers seam consumed by S6 (ChatBox action menu).
   * Signature intentionally exact: (messageId) => Promise<void>, no DM-specific
   * parameter leaking into the shared call site (peerPubkeyHex/privateKeyHex are
   * closed over here).
   *
   * AC-DEL-2: removes the target from local view IMMEDIATELY (before publish
   * resolves) and restores it if publish fails. The durable IDB tombstone write
   * happens inside publishDirectDelete only after publish succeeds (see that
   * function's doc comment for why a pre-publish durable write + synthetic-undo
   * rollback would corrupt the `edited` flag) — so a failed publish never leaves a
   * durable side effect to undo; this handler's rollback is a pure, always-correct
   * React-state revert.
   *
   * Failure-UX: throws, does not toast (see result.json's documented cross-cutting
   * decision — matches the group transport's throw-only behavior; toasting would
   * require new i18n copy, which is S6's scoped responsibility, not S4's).
   */
  const handleDeleteMessage = useCallback(async (messageId: string): Promise<void> => {
    const snapshot = messagesRef.current.find((m) => m.id === messageId);
    if (!snapshot) return;

    // S4 gate-remediation (finding 6): own-message auth guard at the handler seam —
    // handleDeleteMessage acts on any messageId found in local state, so a bypass at
    // a future call site (dev bridge, S6 wiring bug) could otherwise forge a delete
    // of a PEER's message. Fail-closed, matching AC-AUTH-2's posture. AC-AUTH-1
    // affordance-hiding is S6's; this is the seam-level backstop.
    if (snapshot.senderPubkey.toLowerCase() !== pubkeyHex.toLowerCase()) return;

    setMessages((prev) => applyOptimisticDeleteView(prev, messageId));

    try {
      const ndk = await connectNdk(privateKeyHex);
      await publishDirectDelete({ ndk, privateKeyHex, peerPubkeyHex, targetMessage: snapshot });
      // A tombstoned slot is never the target of a further edit/delete action, so
      // unlike handleEditMessage there is no "next action" rev to keep fresh here.
      //
      // Gate-remediation (mirrors S5's ChatStoreContext.performGroupDeleteMessage,
      // finding 2): re-apply the optimistic delete view once more after publish
      // settles. Without this, the live giftWrapSub (no `since` filter) can
      // re-deliver the original rumor during the publish window; resolveFreshOriginal
      // reads storage BEFORE publishDirectDelete's durable tombstone write lands,
      // so upsertMessages re-adds the row — and the durable write landing after
      // that race triggers no state fixup, leaving the "deleted" message
      // resurrected and visible for the rest of the session.
      setMessages((prev) => applyOptimisticDeleteView(prev, messageId));
    } catch (err) {
      // AC-DEL-2: restore the prior visible state on publish failure.
      setMessages((prev) => rollbackOptimisticDeleteView(prev, snapshot));
      throw err;
    }
  }, [peerPubkeyHex, privateKeyHex, pubkeyHex]);

  /**
   * S4: DM edit handler — the DM half of the MessageActionHandlers seam. Signature
   * intentionally exact: (messageId, newContent) => Promise<void>.
   *
   * AC-EDIT-8: updates the target's content in place in local view IMMEDIATELY
   * (before publish resolves) and rolls back to the prior content if the
   * REPLACEMENT publish fails. A failed/absent companion kind-5 never reaches this
   * catch block (publishDirectEdit swallows that failure internally) — see that
   * function's doc comment.
   */
  const handleEditMessage = useCallback(async (messageId: string, newContent: string): Promise<void> => {
    const snapshot = messagesRef.current.find((m) => m.id === messageId);
    if (!snapshot) return;

    // S4 gate-remediation (finding 6): own-message auth guard — see
    // handleDeleteMessage's matching comment.
    if (snapshot.senderPubkey.toLowerCase() !== pubkeyHex.toLowerCase()) return;

    setMessages((prev) => applyOptimisticEditView(prev, messageId, newContent));

    try {
      const ndk = await connectNdk(privateKeyHex);
      await publishDirectEdit({ ndk, privateKeyHex, peerPubkeyHex, targetMessage: snapshot, newContent });
      // S4 gate-remediation (finding 2): re-read the authoritative row from storage
      // and patch it into state — mirrors the inbound edit dispatch branch
      // (applyInboundDeleteEditSignal) — so the state row carries the new rev/edited
      // for the NEXT action on this slot. publishDirectEdit's own storage re-read
      // (directMessages.ts) is the primary fix for rev CORRECTNESS regardless of
      // React state; this keeps the visible row's other fields consistent too.
      const { messages: fresh } = await loadMessages(threadId);
      const updated = fresh.find((m) => m.id === messageId);
      if (updated) setMessages((prev) => prev.map((m) => (m.id === messageId ? updated : m)));
    } catch (err) {
      // AC-EDIT-8: roll back to the prior content on publish failure.
      setMessages((prev) => rollbackOptimisticEditView(prev, messageId, snapshot));
      throw err;
    }
  }, [peerPubkeyHex, privateKeyHex, pubkeyHex, threadId]);

  // S4: __fewDmMessageEdits dev bridge, mirroring __fewDmReactions below — gives S7
  // (e2e) a ready hook onto handleDeleteMessage/handleEditMessage without S4 needing
  // to touch ChatBox.tsx's prop interface (S6-owned). Guarded by NODE_ENV so it is
  // tree-shaken in production builds.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const bridge = {
      deleteMessage: (targetPeerPubkeyHex: string, messageId: string) => {
        if (targetPeerPubkeyHex !== peerPubkeyHex) return;
        // S4 gate-remediation (finding 9): both handlers rethrow on failure — an
        // un-caught `.catch` here would surface as an unhandled promise rejection.
        void handleDeleteMessage(messageId).catch((e) => console.warn('[__fewDmMessageEdits]', e));
      },
      editMessage: (targetPeerPubkeyHex: string, messageId: string, newContent: string) => {
        if (targetPeerPubkeyHex !== peerPubkeyHex) return;
        void handleEditMessage(messageId, newContent).catch((e) => console.warn('[__fewDmMessageEdits]', e));
      },
    };
    (window as any).__fewDmMessageEdits = bridge;
    return () => {
      if ((window as any).__fewDmMessageEdits === bridge) {
        delete (window as any).__fewDmMessageEdits;
      }
    };
  }, [handleDeleteMessage, handleEditMessage, peerPubkeyHex]);

  // Story-07: __fewDmReactions dev bridge for E2E tests (AC-46, e2e-policy.md).
  // Guarded by NODE_ENV !== 'production' so it is tree-shaken in production builds.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const bridge = {
      send: (targetPeerPubkeyHex: string, messageId: string, emoji: string, isRemoval: boolean) => {
        if (targetPeerPubkeyHex !== peerPubkeyHex) return;
        const msg = messagesRef.current.find((m) => m.id === messageId);
        if (!msg) {
          console.warn('[__fewDmReactions] message not found:', messageId);
          return;
        }
        void handleReact(emoji, msg, isRemoval ? 'remove' : 'add');
      },
    };
    (window as any).__fewDmReactions = bridge;
    return () => {
      if ((window as any).__fewDmReactions === bridge) {
        delete (window as any).__fewDmReactions;
      }
    };
  }, [handleReact, peerPubkeyHex]);

  return (
    <ChatBox
      threadId={threadId}
      pubkey={pubkeyHex}
      profileMap={profileMap}
      messages={messages}
      loading={loading}
      sendMessage={sendMessage}
      sendImageMessage={sendImageMessage}
      decryptMedia={decryptMedia}
      allowPollMessages={false}
      // v1 feedback is a text-only marked channel (spec §7): omit the reaction
      // callback so kind-7 reaction DMs (which carry no feedback marker tags)
      // cannot be sent from the feedback thread.
      onReact={isFeedback ? undefined : handleReact}
      // Story-08: pass DM reactions map so ChatBox doesn't read from ChatStoreContext
      // (which is group-only — arch §3 rule 3). AC-55.
      reactionsByMessageId={reactionsByMessageId}
      composerPlaceholder={composerPlaceholder}
      allowImageAttachments={!isFeedback}
      // S6: DM half of the MessageActionHandlers seam (built by S4 above).
      handleDeleteMessage={handleDeleteMessage}
      handleEditMessage={handleEditMessage}
      // Gate-remediation (S6, finding 1): the sealed feedback surface's send
      // paths carry no feedback marker tags, so edit/delete must be gated
      // off entirely there (mirrors allowImageAttachments/onReact above) —
      // an edit/delete kind-14/kind-5 published from that surface would
      // land in the maintainer's sealed channel unmarked.
      allowMessageActions={!isFeedback}
    />
  );
}
