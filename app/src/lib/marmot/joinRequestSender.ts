/**
 * Join request sender (invitee side) — builds a kind 21059 rumor and delivers it gift-wrapped to the admin.
 *
 * Two senders live here:
 *  - `createJoinRequestSender` (D7/D8, S12): the library path. The rumor goes out through
 *    `extensions.sendInboxRumor` (NIP-59 gift wrap to the admin's inbox relays, done by the library). This is the
 *    sender the cut-over wires.
 *  - `sendJoinRequest`, `buildGiftWrap`, `buildJoinRequestRumor`: the legacy hand-rolled path (own wrap + raw WebSocket
 *    publish) that the current UI callers still use. It is removed with its callers at the cut-over (S18) and the old
 *    Welcome subscription (S22).
 */

import { wrapEvent } from 'nostr-tools/nip59';
import { getPublicKey, getEventHash } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import type { Rumor } from '@941design/nostr-events/event';
import { DEFAULT_RELAYS } from '@/src/types';
import { saveOutboundJoinRequest } from './outboundJoinRequests';
import type { OutboundJoinRequestRecord } from './outboundJoinRequests';
import { APP_INBOX_KINDS } from './kinds';

export const JOIN_REQUEST_RUMOR_KIND: number = APP_INBOX_KINDS.joinRequest;

export interface JoinRequestRumor {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

// ---------------------------------------------------------------------------
// Library inbox sender (D7 / D8, AC-JOIN-1 / AC-JOIN-4)
// ---------------------------------------------------------------------------

/** The slice of `MarmotClient['extensions']` the sender uses. */
export interface JoinRequestInbox {
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

export interface JoinRequestSenderDeps {
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

/**
 * Build the inner join-request rumor (kind 21059).
 * This rumor is never published in cleartext — it's always wrapped in NIP-59.
 */
export function buildJoinRequestRumor(params: {
  requesterPubkeyHex: string;
  adminPubkeyHex: string;
  nonce: string;
  groupName: string;
  requesterName?: string;
}): Omit<JoinRequestRumor, 'id'> {
  return {
    kind: JOIN_REQUEST_RUMOR_KIND,
    pubkey: params.requesterPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', params.adminPubkeyHex]],
    content: JSON.stringify({
      type: 'join_request',
      nonce: params.nonce,
      name: params.groupName,
      requesterName: params.requesterName,
    }),
  };
}

/**
 * Construct a NIP-59 gift wrap (kind 1059) around the join request rumor.
 *
 * Two-layer encryption via the audited nostr-tools/nip59 `wrapEvent` helper —
 * the same one directMessages.ts's `sealAndWrap` uses for the DM path
 * (AC-AUTH-0). `wrapEvent` internally:
 *   Layer 1 (Seal, kind 13): builds the rumor (recomputing its id and pubkey
 *     from the REAL requester key below), then signs the seal with a genuine
 *     schnorr signature over it (finalizeEvent) — the seal previously carried
 *     only an `id`, never a `sig`; this is the fix.
 *   Layer 2 (Gift Wrap, kind 1059): encrypts the seal with a fresh ephemeral
 *     key so the sender's identity is hidden from relay operators — only the
 *     admin can decrypt and learn who sent it.
 *
 * This MUST land together with welcomeSubscription.ts's enforcement of seal
 * verification — enforcing verification while this seal was still unsigned
 * would drop every join request (architecture.md's S3 internal coupling).
 */
export async function buildGiftWrap(
  rumor: Omit<JoinRequestRumor, 'id'>,
  requesterPrivateKeyHex: string,
  adminPubkeyHex: string,
): Promise<{ id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }> {
  const privKeyBytes = hexToBytes(requesterPrivateKeyHex);

  const wrap = wrapEvent(
    {
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
    },
    privKeyBytes,
    adminPubkeyHex,
  );

  return {
    id: wrap.id,
    pubkey: wrap.pubkey,
    created_at: wrap.created_at,
    kind: wrap.kind,
    tags: wrap.tags,
    content: wrap.content,
    sig: wrap.sig,
  };
}

/**
 * Build and publish a join request gift wrap to default relays.
 *
 * `requesterPubkeyHex` is used only to populate the (self-claimed, unsigned)
 * inner rumor's `pubkey` field via `buildJoinRequestRumor` — the seal and
 * gift-wrap layers `buildGiftWrap` produces derive their pubkey solely from
 * `requesterPrivateKeyHex` (see `buildGiftWrap`'s doc comment). If the two
 * ever disagreed, the rumor's self-claim would silently diverge from the
 * authenticated seal identity on this security-critical send path. Enforce
 * agreement up front rather than assume it: a caller passing a mismatched
 * pair is a bug, and this throws loudly instead of silently ignoring the
 * declared pubkey.
 */
export async function sendJoinRequest(params: {
  requesterPubkeyHex: string;
  adminPubkeyHex: string;
  nonce: string;
  groupName: string;
  requesterPrivateKeyHex: string;
  requesterName?: string;
}): Promise<void> {
  const derivedPubkeyHex = getPublicKey(hexToBytes(params.requesterPrivateKeyHex));
  if (derivedPubkeyHex !== params.requesterPubkeyHex) {
    throw new Error(
      'sendJoinRequest: requesterPubkeyHex does not match the pubkey derived from requesterPrivateKeyHex',
    );
  }

  const rumor = buildJoinRequestRumor({
    requesterPubkeyHex: params.requesterPubkeyHex,
    adminPubkeyHex: params.adminPubkeyHex,
    nonce: params.nonce,
    groupName: params.groupName,
    requesterName: params.requesterName,
  });

  const giftWrap = await buildGiftWrap(rumor, params.requesterPrivateKeyHex, params.adminPubkeyHex);

  // Publish to default relays via raw WebSocket (same pattern as NdkNetworkAdapter)
  const relays = [...DEFAULT_RELAYS];
  const results = await Promise.all(relays.map((relay) => rawPublish(relay, giftWrap)));
  const accepted = results.filter((r) => r.ok);
  if (accepted.length === 0) {
    const reasons = results.map((r) => `${r.from}: ${r.message ?? 'rejected'}`).join('; ');
    throw new Error(`All relays rejected the join request: ${reasons}`);
  }

  // AC-AUTO-1: persist an outbound record ONLY on a successful send (at least
  // one relay accepted, per the throw above). A failed send (thrown above)
  // never reaches this line, so no record is written for it. Correlated by
  // the auto-accept (invitations/autoAccept.ts) against adminPubkeyHex and the group name — see
  // outboundJoinRequests.ts.
  await saveOutboundJoinRequest({
    nonce: params.nonce,
    adminPubkeyHex: params.adminPubkeyHex,
    groupName: params.groupName,
    sentAt: Date.now(),
  });
}

function rawPublish(
  relayUrl: string,
  event: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string },
  timeoutMs = 10_000,
): Promise<{ from: string; ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      const timer = setTimeout(() => {
        ws.close();
        resolve({ from: relayUrl, ok: false, message: 'timeout' });
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify(['EVENT', event]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'OK' && data[1] === event.id) {
            clearTimeout(timer);
            ws.close();
            resolve({ from: relayUrl, ok: data[2] === true, message: data[3] });
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        resolve({ from: relayUrl, ok: false, message: 'websocket error' });
      };
    } catch (err) {
      resolve({
        from: relayUrl,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
