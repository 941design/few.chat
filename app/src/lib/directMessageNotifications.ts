/**
 * Global incoming-DM watcher that drives the notification bell.
 *
 * Subscribes to all kind-4 events (NIP-04 legacy DMs) AND kind-1059 events
 * (NIP-17 gift-wrapped DMs) targeting the local pubkey. For each new event
 * from a non-self sender that postdates the peer's last-read timestamp, it
 * increments the unread direct-message count and remembers the contact.
 *
 * The subscription runs even when no contact chat is open — that's the whole
 * point: a DM should ring the bell whether or not the user has the thread
 * mounted. ContactChat keeps its own subscription for live message rendering;
 * the unread store dedups via lastRead timestamp + in-memory seen-id sets.
 *
 * Dedup keys per path (D7):
 *   kind-4   → event id  (outer event = the DM itself)
 *   kind-1059 → inner rumor id (outer id changes per relay redelivery;
 *              rumor id is stable across redeliveries)
 */

import type NDK from '@nostr-dev-kit/ndk';
import {
  CHAT_MESSAGE_KIND,
  DIRECT_MESSAGE_KIND,
  GIFT_WRAP_KIND,
  decryptDirectPayload,
  directConversationId,
  parseDirectPayload,
  unwrapAndOpen,
} from '@/src/lib/directMessages';
import { appendMessage } from '@/src/lib/marmot/chatPersistence';
import { createLogger } from '@/src/lib/logger';
import {
  getDirectMessageLastReadAt,
  incrementDirectMessage,
} from '@/src/lib/unreadStore';
import { isPendingConfirmation, rememberContact } from '@/src/lib/contacts';
import { isActiveView } from '@/src/lib/activeViewStore';

const logger = createLogger('dm');

export type IncomingDmEvent = {
  id?: string;
  pubkey?: string;
  created_at?: number;
  /** Encrypted NIP-04 payload — needed to retain a pending peer's DM. */
  content?: string;
};

/**
 * Persist an inbound DM received while its sender is a still-pending contact
 * (epic: pending-contact-notification, AC-DM-2). The message is retained (still
 * suppressed from the unread pill/DM bell — AC-DM-1) so that on Confirm,
 * `reconcileConfirmedContactDirectMessageCount` finds it and the pill appears
 * immediately (AC-DM-3). `appendMessage` is insert-if-absent by message id, so
 * a later `ContactChat` mount re-appending the same id is a safe no-op — no
 * double-count (AC-DM-4). Best-effort: any failure is swallowed so retention
 * never breaks the bell watcher.
 */
async function retainPendingInboundDm(
  peer: string,
  meta: { id: string; senderPubkey: string; createdAtMs: number },
  parsed: ReturnType<typeof parseDirectPayload>,
): Promise<void> {
  if (!parsed) return;
  const threadId = directConversationId(peer);
  await appendMessage(threadId, {
    id: meta.id,
    content: parsed.content,
    senderPubkey: meta.senderPubkey,
    groupId: threadId,
    createdAt: meta.createdAtMs,
    ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
  });
}

/**
 * Subscribe to inbound DMs (kind-4 NIP-04 and kind-1059 NIP-17 gift wraps)
 * and bump the notification bell for each new message from a non-self sender.
 *
 * @param params.ndk              NDK instance for relay subscriptions.
 * @param params.ownPubkeyHex     The local user's hex pubkey.
 * @param params.privateKeyHex    The local user's hex private key. Required to
 *                                unwrap NIP-17 gift wraps. Obtained from
 *                                `useNostrIdentity()` in the watcher component.
 * @param params.isAllowedSender  Whitelist accessor injected by the caller
 *                                (AC-SEC-3, AC-SEC-5). Returns `true` only for
 *                                peers that share at least one MLS group with
 *                                the local user. Stranger events are dropped
 *                                before any side-effect (rememberContact,
 *                                incrementDirectMessage, dedup-set population).
 */
export function subscribeDirectMessageNotifications(params: {
  ndk: NDK;
  ownPubkeyHex: string;
  privateKeyHex: string;
  isAllowedSender: (peer: string) => boolean;
}): () => void {
  const { ndk, ownPubkeyHex, privateKeyHex, isAllowedSender } = params;
  const ownLower = ownPubkeyHex.toLowerCase();

  // kind-4 dedup key: event id (the outer event is the DM itself)
  const seenMessageIds = new Set<string>();

  // kind-1059 dedup key: inner rumor id (outer id changes per relay redelivery)
  const seenRumorIds = new Set<string>();

  // ── kind-4 handler ──────────────────────────────────────────────────────────
  const kind4Sub = ndk.subscribe({
    kinds: [DIRECT_MESSAGE_KIND],
    '#p': [ownPubkeyHex],
  });

  const kind4Handler = async (event: IncomingDmEvent) => {
    const peer = (event.pubkey ?? '').toLowerCase();
    if (!peer || peer === ownLower) return;
    // AC-SEC-3/4: gate before dedup-set population and all side-effects.
    // Stranger events must NOT occupy a seenMessageIds slot — a later member
    // re-delivery of the same event id must not be falsely deduped.
    if (!isAllowedSender(peer)) {
      logger.info('dm:walled-garden-drop', { pubkey: peer.slice(0, 8), kind: 4 });
      return;
    }
    if (event.id && seenMessageIds.has(event.id)) return;
    if (event.id) seenMessageIds.add(event.id);
    const createdMs = (event.created_at ?? 0) * 1000;
    if (createdMs <= getDirectMessageLastReadAt(peer)) return;
    rememberContact(peer);
    // Epic: pending-contact-confirmation (AC-OBS-1) / pending-contact-
    // notification (AC-DM-1/2). rememberContact still fires unconditionally
    // above. While the sender is a still-pending contact the bell bump stays
    // held back, but the message is now RETAINED (persisted) so the unread
    // pill can be revealed on Confirm (AC-DM-2/3). Imports the single exported
    // predicate (AC-STRUCT-3) rather than re-deriving pendingConfirmationSince.
    // notification-domain-invariants (INV-2): if this peer's DM thread is the
    // active view, ContactChat renders + marks it read live, so the bell must
    // not also ring. Any other view rings it (INV-1).
    if (isPendingConfirmation(peer)) {
      if (event.id && event.content) {
        try {
          const parsed = await decryptDirectPayload(event.content, privateKeyHex, peer);
          await retainPendingInboundDm(peer, { id: event.id, senderPubkey: peer, createdAtMs: createdMs }, parsed);
        } catch (err) {
          logger.info('dm:retain-pending-failed', { pubkey: peer.slice(0, 8), kind: 4 });
        }
      }
    } else if (!isActiveView('dm', peer)) {
      incrementDirectMessage(peer);
    }
  };

  kind4Sub.on?.('event', kind4Handler);

  // ── kind-1059 handler ────────────────────────────────────────────────────────
  const kind1059Sub = ndk.subscribe({
    kinds: [GIFT_WRAP_KIND],
    '#p': [ownPubkeyHex],
  });

  // NDKEvent is the actual event type emitted by ndk.subscribe()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kind1059Handler = async (event: any) => {
    try {
      // unwrapAndOpen wants a NostrEvent shape (created_at: number).
      // NDKEvent has created_at?: number; supply a fallback rather than narrow upstream.
      const rumor = await unwrapAndOpen(
        { ...event, created_at: event.created_at ?? Math.floor(Date.now() / 1000) },
        privateKeyHex,
      );

      // Only kind-14 (NIP-17 chat messages) bump the bell.
      // kind-7 reactions, kind-444 welcomes, kind-21059 join requests — silently skip.
      if (rumor.kind !== CHAT_MESSAGE_KIND) return;

      const peer = rumor.pubkey.toLowerCase();
      if (peer === ownLower) return;

      // AC-SEC-5: gate before dedup-set population and all side-effects.
      // Stranger events must NOT occupy a seenRumorIds slot — a later member
      // re-delivery of the same rumor id must not be falsely deduped.
      if (!isAllowedSender(peer)) {
        logger.info('dm:walled-garden-drop', { pubkey: peer.slice(0, 8), kind: 1059 });
        return;
      }

      const createdMs = rumor.created_at * 1000;
      if (createdMs <= getDirectMessageLastReadAt(peer)) return;

      if (seenRumorIds.has(rumor.id)) return;
      seenRumorIds.add(rumor.id);

      rememberContact(peer);
      // Epic: pending-contact-confirmation (AC-OBS-1) / pending-contact-
      // notification (AC-DM-1/2) — see kind4Handler's matching comment above.
      // notification-domain-invariants (INV-2): suppress the bell when this
      // peer's DM thread is the active view — see the kind-4 branch above.
      if (isPendingConfirmation(peer)) {
        // Retain the pending peer's DM (still no pill/bell) so Confirm can
        // reveal the unread pill immediately (AC-DM-2/3). The rumor is already
        // the decrypted kind-14 content here.
        try {
          const parsed = parseDirectPayload(rumor.content);
          await retainPendingInboundDm(
            peer,
            { id: rumor.id, senderPubkey: peer, createdAtMs: createdMs },
            parsed,
          );
        } catch {
          logger.info('dm:retain-pending-failed', { pubkey: peer.slice(0, 8), kind: 1059 });
        }
      } else if (!isActiveView('dm', peer)) {
        incrementDirectMessage(peer);
      }
    } catch {
      // Foreign key, not addressed to us, malformed — silently skip per D3.
      logger.info('dm:unwrap-failed', { eventId: (event as any).id ?? 'unknown', reason: 'unwrap-threw' });
    }
  };

  kind1059Sub.on?.('event', kind1059Handler);

  // ── cleanup ──────────────────────────────────────────────────────────────────
  return () => {
    try {
      kind4Sub.stop?.();
    } catch {
      // non-fatal
    }
    try {
      kind1059Sub.stop?.();
    } catch {
      // non-fatal
    }
  };
}
