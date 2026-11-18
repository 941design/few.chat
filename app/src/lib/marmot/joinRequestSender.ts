import { getEventHash } from 'nostr-tools/pure';
import type { Rumor } from '@941design/nostr-events/event';
import type { OutboundJoinRequestRecord } from './outboundJoinRequests';
import { APP_INBOX_KINDS } from './kinds';

export const JOIN_REQUEST_RUMOR_KIND: number = APP_INBOX_KINDS.joinRequest;

/** The slice of `MarmotClient['extensions']` the sender uses. */
interface JoinRequestInbox {
  sendInboxRumor: (input: { readonly to: string; readonly rumor: Rumor }) => Promise<{ readonly status: 'delivered' | 'retryable' | 'failed'; readonly reason?: string }>;
}

/**
 * A join request that was not delivered: the existing send-failure state of the UI (its catch shows the join-request
 * error). `outcome` is the library delivery status (`retryable` / `failed`), or `failed` when the send rejected (the
 * rejection is the `cause`). The message holds only the machine reason, never the rumor, the name or the nonce.
 * `sendInboxRumor` persists and retries nothing and the app creates no retry timer for it: the user sends again.
 */
export class JoinRequestSendError extends Error {
  constructor(
    readonly outcome: 'retryable' | 'failed',
    readonly reason: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`join request not delivered: ${outcome}${reason ? ` (${reason})` : ''}`, options);
    this.name = 'JoinRequestSendError';
  }
}

interface JoinRequestSenderDeps {
  inbox: JoinRequestInbox;
  /** The own account pubkey (hex): the rumor's author. */
  ownPubkey: string;
  /** Clock, ms (rumor `created_at` and the record's `sentAt`). */
  now: () => number;
  /** Persists the outbound record (production: `saveOutboundJoinRequest`). Called ONLY for a delivered request. */
  saveOutbound: (record: OutboundJoinRequestRecord) => Promise<void>;
  /** A record write that failed after a delivered send (default `console.error`). */
  onError?: (error: unknown) => void;
}

export interface JoinRequestSender {
  /** Resolves when the request was delivered; rejects with `JoinRequestSendError` for `retryable` / `failed`. Never calls the client from a library frame: call it from a UI handler or a queued job. */
  send: (params: { adminPubkeyHex: string; nonce: string; groupName: string; requesterName?: string }) => Promise<void>;
}

const HEX_PUBKEY = /^[0-9a-fA-F]{64}$/;

export function createJoinRequestSender(deps: JoinRequestSenderDeps): JoinRequestSender {
  if (!deps) throw new TypeError('createJoinRequestSender: dependencies are required');
  if (typeof deps.inbox?.sendInboxRumor !== 'function') throw new TypeError('createJoinRequestSender: required dependency "inbox.sendInboxRumor" is missing');
  if (typeof deps.now !== 'function') throw new TypeError('createJoinRequestSender: required dependency "now" is missing');
  if (typeof deps.saveOutbound !== 'function') throw new TypeError('createJoinRequestSender: required dependency "saveOutbound" is missing');
  if (typeof deps.ownPubkey !== 'string' || !HEX_PUBKEY.test(deps.ownPubkey)) throw new TypeError('createJoinRequestSender: required dependency "ownPubkey" must be a 64-char hex pubkey');
  const { inbox, now, saveOutbound } = deps;
  const ownPubkey = deps.ownPubkey.toLowerCase();
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/joinRequests] sender', e));

  return {
    async send(params) {
      if (!params || typeof params.adminPubkeyHex !== 'string' || !HEX_PUBKEY.test(params.adminPubkeyHex)) {
        throw new TypeError('sendJoinRequest: adminPubkeyHex must be a 64-char hex pubkey');
      }
      if (typeof params.nonce !== 'string' || params.nonce.length === 0) throw new TypeError('sendJoinRequest: nonce is required');
      const admin = params.adminPubkeyHex.toLowerCase();
      const at = now();
      const unsigned = {
        pubkey: ownPubkey,
        created_at: Math.floor(at / 1000),
        kind: JOIN_REQUEST_RUMOR_KIND,
        tags: [['p', admin]],
        content: JSON.stringify({
          type: 'join_request',
          nonce: params.nonce,
          name: params.groupName,
          requesterName: params.requesterName,
        }),
      };
      const rumor: Rumor = { ...unsigned, id: getEventHash(unsigned) };
      let delivery: Awaited<ReturnType<JoinRequestInbox['sendInboxRumor']>>;
      try {
        delivery = await inbox.sendInboxRumor({ to: admin, rumor });
      } catch (cause) {
        throw new JoinRequestSendError('failed', undefined, { cause });
      }
      if (delivery.status !== 'delivered') {
        throw new JoinRequestSendError(delivery.status === 'retryable' ? 'retryable' : 'failed', typeof delivery.reason === 'string' ? delivery.reason : undefined);
      }
      // AC-AUTO-1: the outbound record exists ONLY for a delivered request. A write failure must not fail a send that
      // already reached the relays.
      try {
        await saveOutbound({ nonce: params.nonce, adminPubkeyHex: admin, groupName: params.groupName, sentAt: at });
      } catch (e) {
        onError(e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy hand-rolled path (removed with its callers at the cut-over)
// ---------------------------------------------------------------------------
