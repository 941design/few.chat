/**
 * Call signaling codec and gift-wrap transport (Story S1).
 *
 * Implements the Amethyst AC-WebRTC wire format (kinds 25050–25055) wrapped in
 * kind-21059 ephemeral NIP-44 gift wraps. This is pure library code — no React,
 * no context imports.
 *
 * Architecture:
 *   - encode* functions: build draft inner events (unsigned) ready for signing.
 *   - wrapAndPublish: signs the inner event, NIP-44-encrypts it, wraps in kind-21059
 *     signed by a fresh ephemeral key, and publishes via NDK.
 *   - subscribeCallSignaling: subscribes to kind-21059 wraps addressed to the local
 *     pubkey; decrypts, verifies, freshness-checks, dedupes, roster-gates, then calls
 *     params.onEvent with a parsed IncomingCallEvent.
 *
 * Transport spec: §8 of specs/voice-video-calls-spec.md
 * Wire format: §7 of specs/voice-video-calls-spec.md
 */

import type NDK from '@nostr-dev-kit/ndk';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import type { EventSigner } from 'applesauce-core';
import type { CallSignalingParams, IncomingCallEvent, CallKind } from '@/src/types';

// ── Kind constants ──────────────────────────────────────────────────────────────

import {
  CALL_OFFER_KIND,
  CALL_ANSWER_KIND,
  CALL_ICE_KIND,
  CALL_HANGUP_KIND,
  CALL_REJECT_KIND,
  CALL_RENEGOTIATE_KIND,
} from './callKinds';

export { CALL_OFFER_KIND, CALL_ANSWER_KIND, CALL_ICE_KIND, CALL_HANGUP_KIND, CALL_REJECT_KIND, CALL_RENEGOTIATE_KIND };

/** Kind used for the outer gift-wrap envelope (ephemeral variant of NIP-59's 1059). */
export const CALL_GIFT_WRAP_KIND = 21059 as const;

// ── Inner event draft shapes ─────────────────────────────────────────────────────

/**
 * A draft inner event ready for signing.
 * Matches the nostr-tools VerifiedEvent shape minus id/sig (those are added by signEvent).
 */
export interface InnerEventDraft {
  kind: CallKind;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

// ── Encoder helpers ──────────────────────────────────────────────────────────────

function baseTags(recipientPubkeys: string[], callId: string): string[][] {
  return [
    ...recipientPubkeys.map((p) => ['p', p]),
    ['call-id', callId],
  ];
}

/**
 * Build a kind-25050 Call Offer draft.
 * The inner event carries one `p` tag per recipient (full roster), plus `call-id` and `call-type`.
 * Content is the raw SDP offer string.
 */
export function encodeOffer(params: {
  senderPubkeyHex: string;
  recipientPubkeys: string[];
  callId: string;
  callType: 'voice' | 'video';
  sdp: string;
}): InnerEventDraft {
  return {
    kind: CALL_OFFER_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ...baseTags(params.recipientPubkeys, params.callId),
      ['call-type', params.callType],
    ],
    content: params.sdp,
  };
}

/**
 * Build a kind-25051 Call Answer draft.
 * Content is the raw SDP answer string.
 */
export function encodeAnswer(params: {
  senderPubkeyHex: string;
  recipientPubkeys: string[];
  callId: string;
  sdp: string;
}): InnerEventDraft {
  return {
    kind: CALL_ANSWER_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(params.recipientPubkeys, params.callId),
    content: params.sdp,
  };
}

/**
 * Build a kind-25052 Call ICE Candidate draft.
 * ICE carries exactly one `p` tag (the single target peer, not the full roster).
 * Content is JSON: `{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}`.
 */
export function encodeIceCandidate(params: {
  senderPubkeyHex: string;
  recipientPubkeyHex: string;
  callId: string;
  candidate: RTCIceCandidateInit;
}): InnerEventDraft {
  const { candidate, sdpMid, sdpMLineIndex } = params.candidate;
  const payload = {
    candidate: candidate ?? '',
    sdpMid: sdpMid ?? '0',
    sdpMLineIndex: sdpMLineIndex ?? 0,
  };
  return {
    kind: CALL_ICE_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', params.recipientPubkeyHex],
      ['call-id', params.callId],
    ],
    content: JSON.stringify(payload),
  };
}

/**
 * Build a kind-25053 Call Hangup draft.
 * Content is a plaintext reason string (may be empty).
 */
export function encodeHangup(params: {
  senderPubkeyHex: string;
  recipientPubkeys: string[];
  callId: string;
  reason?: string;
}): InnerEventDraft {
  return {
    kind: CALL_HANGUP_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(params.recipientPubkeys, params.callId),
    content: params.reason ?? '',
  };
}

/**
 * Build a kind-25054 Call Reject draft.
 * Content is "" for an explicit decline or "busy" for an auto-decline.
 */
export function encodeReject(params: {
  senderPubkeyHex: string;
  recipientPubkeys: string[];
  callId: string;
  reason?: '' | 'busy';
}): InnerEventDraft {
  return {
    kind: CALL_REJECT_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(params.recipientPubkeys, params.callId),
    content: params.reason ?? '',
  };
}

/**
 * Build a kind-25055 Call Renegotiate draft.
 * Used for mid-call SDP renegotiation (e.g. voice→video upgrade). Content is the raw SDP string.
 */
export function encodeRenegotiate(params: {
  senderPubkeyHex: string;
  recipientPubkeys: string[];
  callId: string;
  sdp: string;
}): InnerEventDraft {
  return {
    kind: CALL_RENEGOTIATE_KIND,
    pubkey: params.senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(params.recipientPubkeys, params.callId),
    content: params.sdp,
  };
}

// ── Gift-wrap send ────────────────────────────────────────────────────────────────

/**
 * Sign the inner event, NIP-44-encrypt it to the recipient, wrap in a kind-21059
 * signed by a fresh ephemeral key, and publish via NDK.
 *
 * Two layers only (no seal / no kind-13), per §8 of the spec:
 *   1. Inner call event — signed by sender's real key.
 *   2. Outer kind-21059 — signed by a fresh random ephemeral key.
 *
 * @param innerDraft  Unsigned inner event (from encode* functions above).
 * @param recipientPubkeyHex  Recipient's hex pubkey (used for NIP-44 + outer `p` tag).
 * @param signer  EventSigner from applesauce-core (sender's real key).
 * @param ndk  Connected NDK instance.
 */
export async function wrapAndPublish(
  innerDraft: InnerEventDraft,
  recipientPubkeyHex: string,
  signer: EventSigner,
  ndk: NDK,
): Promise<void> {
  const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure');
  const nip44 = await import('nostr-tools/nip44');

  // Step 1: Sign the inner event with the sender's real key.
  // signer.signEvent() takes a draft and returns a full signed event (id + sig).
  const signedInner = await signer.signEvent(innerDraft);

  // Step 2: NIP-44-encrypt the signed inner event JSON to the recipient's pubkey.
  // We use the signer's nip44.encrypt which handles ECDH key derivation internally.
  const innerJson = JSON.stringify(signedInner);
  const encryptedContent = await signer.nip44!.encrypt(recipientPubkeyHex, innerJson);

  // Step 3: Build the outer kind-21059 wrap signed by a fresh ephemeral key.
  const ephemeralPrivBytes = new Uint8Array(32);
  crypto.getRandomValues(ephemeralPrivBytes);

  // The ephemeral key signs the outer wrap; NIP-44 encryption above used the real signer.
  // The outer content is already the signer-encrypted blob — we do NOT re-encrypt with
  // the ephemeral key. The ephemeral key only provides the outer event signature (hides
  // the real sender from relays via the wrap's pubkey field).
  //
  // Note: Amethyst's transport uses signer.nip44.encrypt(recipient, innerJson) for the
  // outer content, meaning decryption by the recipient uses:
  //   nip44.decrypt(wrap.content, getConversationKey(recipientPrivKey, wrap.pubkey))
  // But wrap.pubkey is the ephemeral key — the recipient cannot derive the conversation
  // key between the ephemeral key and themselves using their own private key unless the
  // content was encrypted BY the ephemeral key TO them.
  //
  // Correction: We must encrypt with the ephemeral key to the recipient. The signer's
  // real identity is carried in the signed inner event, not in the outer encryption.
  // This matches the decryption path in subscribeCallSignaling below.
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralPrivBytes, recipientPubkeyHex);
  const outerContent = nip44.v2.encrypt(innerJson, conversationKey);

  const giftWrapEvent = finalizeEvent(
    {
      kind: CALL_GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkeyHex]],
      content: outerContent,
    },
    ephemeralPrivBytes,
  );

  await new NDKEvent(ndk, giftWrapEvent).publish();
}

// ── Receipt subscription ──────────────────────────────────────────────────────────

/**
 * Maximum age (in seconds) of a signaling event before it is discarded.
 * Per §8.1 of the spec.
 */
export const SIGNALING_FRESHNESS_WINDOW_S = 20;

/**
 * Maximum size of the deduplication seen-id set. When exceeded the set is
 * cleared (LRU-approximate: full eviction keeps the implementation simple and
 * the bound tight at the cost of brief post-clear dedup misses).
 */
export const DEDUP_SET_MAX = 500;

/**
 * Parse a signed inner event into an IncomingCallEvent.
 * Returns null if the event shape is unrecognised or mandatory fields are absent.
 */
function parseInnerEvent(
  inner: {
    kind: number;
    id: string;
    pubkey: string;
    tags: string[][];
    content: string;
    created_at: number;
  },
): IncomingCallEvent | null {
  const VALID_KINDS: CallKind[] = [25050, 25051, 25052, 25053, 25054, 25055];
  if (!VALID_KINDS.includes(inner.kind as CallKind)) return null;

  const kind = inner.kind as CallKind;

  const callIdTag = inner.tags.find((t) => t[0] === 'call-id');
  if (!callIdTag || !callIdTag[1]) return null;
  const callId = callIdTag[1];

  const recipientPubkeys = inner.tags
    .filter((t) => t[0] === 'p' && t[1])
    .map((t) => t[1]);

  const evt: IncomingCallEvent = {
    kind,
    callId,
    senderPubkey: inner.pubkey,
    recipientPubkeys,
    innerEventId: inner.id,
  };

  // Kind-specific payload parsing
  if (kind === 25050 || kind === 25051 || kind === 25055) {
    // Offer / Answer / Renegotiate: raw SDP string
    evt.sdp = inner.content;
  }

  if (kind === 25050) {
    const callTypeTag = inner.tags.find((t) => t[0] === 'call-type');
    if (callTypeTag && (callTypeTag[1] === 'voice' || callTypeTag[1] === 'video')) {
      evt.callType = callTypeTag[1];
    }
  }

  if (kind === 25052) {
    // ICE Candidate: JSON content with defaults for missing fields
    try {
      const raw = JSON.parse(inner.content) as Record<string, unknown>;
      evt.iceCandidate = {
        candidate: typeof raw.candidate === 'string' ? raw.candidate : '',
        sdpMid: typeof raw.sdpMid === 'string' ? raw.sdpMid : '0',
        sdpMLineIndex: typeof raw.sdpMLineIndex === 'number' ? raw.sdpMLineIndex : 0,
      };
    } catch {
      return null;
    }
  }

  if (kind === 25053 || kind === 25054) {
    // Hangup / Reject: plaintext reason (may be empty or "busy")
    evt.reason = inner.content;
  }

  return evt;
}

/**
 * Subscribe to incoming call signaling events (kind-21059 wraps `p`-tagged to ownPubkeyHex).
 *
 * For each received wrap:
 *   1. NIP-44 decrypt using the local private key and the wrap's ephemeral pubkey.
 *   2. Parse and verify the inner event signature (nostr-tools verifyEvent).
 *   3. Discard if older than SIGNALING_FRESHNESS_WINDOW_S seconds.
 *   4. Deduplicate by inner event id (bounded set, LRU-approximate clear at 500).
 *   5. Roster-gate via params.isAuthorized (async callback).
 *   6. Parse into IncomingCallEvent and call params.onEvent.
 *
 * @returns An unsubscribe function.
 */
export function subscribeCallSignaling(
  params: CallSignalingParams & { ndk: NDK },
): () => void {
  const { ndk, pubkeyHex, privateKeyHex, isAuthorized, onEvent } = params;

  const seenIds = new Set<string>();

  // NDKFilter.kinds expects NDKKind[]; 21059 is the ephemeral gift-wrap variant not yet
  // in NDK's enum, so we cast to silence the type error while keeping the runtime value correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = ndk.subscribe({
    kinds: [CALL_GIFT_WRAP_KIND as any],
    '#p': [pubkeyHex],
  });

  const handler = async (event: { pubkey: string; content: string; created_at: number }) => {
    try {
      // Step 1: NIP-44 decrypt the outer gift wrap.
      // The wrap was encrypted by the ephemeral key to our pubkey.
      // We derive the conversation key from our private key and the ephemeral wrap.pubkey.
      const { hexToBytes } = await import('nostr-tools/utils');
      const nip44 = await import('nostr-tools/nip44');
      const { verifyEvent } = await import('nostr-tools/pure');

      const privKeyBytes = hexToBytes(privateKeyHex);
      const convKey = nip44.v2.utils.getConversationKey(privKeyBytes, event.pubkey);
      const innerJson = nip44.v2.decrypt(event.content, convKey);

      // Step 2: Parse and verify signature of the inner event.
      const inner = JSON.parse(innerJson) as {
        kind: number;
        id: string;
        pubkey: string;
        tags: string[][];
        content: string;
        created_at: number;
        sig: string;
      };

      if (!verifyEvent(inner)) return;

      // Step 3: Freshness check — discard events older than 20 seconds.
      const ageSeconds = Math.abs(Date.now() / 1000 - inner.created_at);
      if (ageSeconds > SIGNALING_FRESHNESS_WINDOW_S) return;

      // Step 4: Deduplicate by inner event id.
      if (seenIds.has(inner.id)) return;
      if (seenIds.size >= DEDUP_SET_MAX) {
        // LRU-approximate: clear when the set overflows to maintain the size bound.
        seenIds.clear();
      }
      seenIds.add(inner.id);

      // Step 5: Parse call-id for the roster gate.
      const callIdTag = inner.tags.find((t) => t[0] === 'call-id');
      if (!callIdTag || !callIdTag[1]) return;
      const callId = callIdTag[1];

      // Step 6: Roster gate (async — injected by the caller).
      const authorized = await isAuthorized(inner.pubkey, callId);
      if (!authorized) return;

      // Step 7: Parse and dispatch.
      const evt = parseInnerEvent(inner);
      if (!evt) return;

      onEvent(evt);
    } catch {
      // Silently discard any event that fails decryption or verification.
      // Never surface decrypted content in error messages.
    }
  };

  sub.on('event', handler);

  return () => {
    sub.stop();
  };
}
