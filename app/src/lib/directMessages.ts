import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';
import { nip04, nip44 } from 'nostr-tools';
import { wrapEvent, createRumor } from 'nostr-tools/nip59';
import { getPublicKey, verifyEvent, getEventHash } from 'nostr-tools/pure';
import { createLogger } from '@/src/lib/logger';
import { publishWithTimeout } from '@/src/lib/ndkClient';
import { put, get as blossomGet } from '@/src/lib/media/blossomClient';
import { MAX_OUTPUT_BYTES } from '@/src/config/blossom';
import { buildImageMessageContent, DIRECT_MEDIA_VERSION, type DirectMediaAttachment, type RoledAttachments } from '@/src/lib/media/imageMessage';

const logger = createLogger('dm');

/** Legacy kind-4 NIP-04 constant — kept for inbound subscription filter only (D9a). */
export const DIRECT_MESSAGE_KIND = 4;

/** NIP-17 / NIP-59 gift-wrap kind. */
export const GIFT_WRAP_KIND = 1059;

/** Inner NIP-17 chat message kind (rumor). */
export const CHAT_MESSAGE_KIND = 14;

/**
 * Unsigned rumor shape — matches nostr-tools nip59 Rumor (UnsignedEvent + id, no sig).
 * Seam S5 public type used by story-07-dm-reactions and beyond.
 */
export type UnsignedRumor = {
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  id: string;
};

type TextPayload = {
  type: 'text';
  text: string;
};

type ImagePayload = {
  type: 'image';
  version: 1;
  caption: string;
  attachments: RoledAttachments;
};

export type DirectMessagePayload = TextPayload | ImagePayload;

export function directConversationId(peerPubkeyHex: string): string {
  return `dm:${peerPubkeyHex.toLowerCase()}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

function buildPayload(content: string, attachments?: RoledAttachments): DirectMessagePayload {
  if (attachments && (attachments.full || attachments.thumb)) {
    return {
      type: 'image',
      version: 1,
      caption: content,
      attachments,
    };
  }
  return {
    type: 'text',
    text: content,
  };
}

export function normalizeDirectPayload(payload: DirectMessagePayload): {
  content: string;
  attachments?: RoledAttachments;
} {
  if (payload.type === 'image') {
    return {
      content: buildImageMessageContent(payload.caption),
      attachments: payload.attachments,
    };
  }
  return { content: payload.text };
}

export function parseDirectPayload(raw: string): {
  content: string;
  attachments?: RoledAttachments;
} | null {
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as DirectMessagePayload;
    if (parsed.type === 'text' && typeof parsed.text === 'string') {
      return { content: parsed.text };
    }
    if (
      parsed.type === 'image' &&
      parsed.version === 1 &&
      typeof parsed.caption === 'string' &&
      parsed.attachments &&
      typeof parsed.attachments === 'object'
    ) {
      return {
        content: buildImageMessageContent(parsed.caption),
        attachments: parsed.attachments,
      };
    }
    // D1 decision: unknown JSON shape — treat the raw JSON string as text.
    logger.info('dm:parse-lenient-fallback', { raw: raw.slice(0, 200) });
    return { content: raw };
  } catch {
    // Non-JSON plaintext — treat the raw string as plaintext.
    logger.info('dm:parse-lenient-fallback', { raw: raw.slice(0, 200) });
    return { content: raw };
  }
}

export async function encryptDirectPayload(
  payload: DirectMessagePayload,
  privateKeyHex: string,
  peerPubkeyHex: string,
): Promise<string> {
  return nip04.encrypt(privateKeyHex, peerPubkeyHex, JSON.stringify(payload));
}

export async function decryptDirectPayload(
  encrypted: string,
  privateKeyHex: string,
  peerPubkeyHex: string,
): Promise<{ content: string; attachments?: RoledAttachments } | null> {
  let decrypted: string;
  try {
    decrypted = nip04.decrypt(privateKeyHex, peerPubkeyHex, encrypted);
  } catch {
    logger.info('dm:decrypt-empty', { reason: 'nip04-failed' });
    return null;
  }
  if (decrypted === '') {
    logger.info('dm:decrypt-empty', { reason: 'decrypted-empty' });
    return null;
  }
  return parseDirectPayload(decrypted);
}

/**
 * Seal a rumor in a kind-13 seal and wrap it in a NIP-59 gift wrap (kind 1059).
 * Uses nostr-tools/nip59 wrapEvent which:
 *   - computes the rumor id via getEventHash
 *   - encrypts the rumor into a kind-13 seal (sender priv → recipient pub, nip44)
 *   - encrypts the seal into a kind-1059 wrap with a fresh ephemeral key per wrap
 *   - randomises the outer created_at within [now-2days, now] per NIP-59
 *   - places ["p", recipientPublicKey] on the outer wrap
 *
 * The returned event is fully signed and ready for relay publish.
 */
export async function sealAndWrap(
  rumor: UnsignedRumor,
  recipientPubkey: string,
  selfPrivKeyHex: string,
): Promise<import('nostr-tools').NostrEvent> {
  const privKeyBytes = hexToBytes(selfPrivKeyHex);
  // wrapEvent accepts a Partial<UnsignedEvent>; it overwrites pubkey from privKeyBytes
  // and recomputes id. We pass the full rumor so content/kind/tags/created_at are preserved.
  const wrap = wrapEvent(
    {
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
    },
    privKeyBytes,
    recipientPubkey,
  );
  return wrap as import('nostr-tools').NostrEvent;
}

/**
 * Thread-isolation guard for the gift-wrap inbound path.
 *
 * NIP-59 mandates an ephemeral outer key per gift wrap, so the kind-1059
 * subscription cannot filter by authors. Any kind-1059 event addressed to
 * selfPubkey is delivered. Post-unwrap validation of the inner rumor's pubkey
 * is therefore the only thread-isolation barrier.
 *
 * Returns true when the rumor belongs to the current conversation thread and
 * should be ingested. Returns false when it arrived from a different sender
 * (must be silently dropped).
 */
export function shouldIngestRumor(rumor: UnsignedRumor, peerPubkeyHex: string): boolean {
  if (rumor.pubkey === peerPubkeyHex) return true;
  logger.info('dm:rumor-rejected', { rumorId: rumor.id, expectedPubkey: peerPubkeyHex, actualPubkey: rumor.pubkey });
  return false;
}

/** NIP-59 seal kind — authenticated inner envelope. */
const SEAL_KIND = 13;

/**
 * Unwrap a NIP-59 kind-1059 gift wrap and return the inner unsigned rumor.
 *
 * Unlike the nostr-tools unwrapEvent helper, this implementation performs the
 * missing authentication steps that the library omits:
 *   1. Decrypts the outer gift wrap using the ephemeral wrap pubkey as ECDH counterparty.
 *   2. Verifies the seal's schnorr signature via verifyEvent before trusting its pubkey.
 *   3. Decrypts the seal using the authenticated seal.pubkey as ECDH counterparty.
 *   4. Asserts rumor.pubkey === seal.pubkey — binding the rumor's claimed sender to the
 *      authenticated seal sender (closes the Mallory forgery vector).
 *
 * Without step 4, an attacker could wrap a rumor with pubkey:alice using their own key
 * and the shouldIngestRumor guard would incorrectly accept it as an Alice message.
 *
 * Throws on mismatched recipient key, invalid seal signature, or sender mismatch.
 * Never leaks decrypted content in error messages.
 */
export async function unwrapAndOpen(
  giftWrap: import('nostr-tools').NostrEvent,
  selfPrivKeyHex: string,
): Promise<UnsignedRumor> {
  const privKeyBytes = hexToBytes(selfPrivKeyHex);
  try {
    if (giftWrap.kind !== GIFT_WRAP_KIND) {
      throw new Error('not a gift wrap');
    }
    // Step 1: Decrypt outer wrap. The wrap was encrypted with an ephemeral key;
    // giftWrap.pubkey is that ephemeral key — use it as the ECDH counterparty.
    const sealJson = nip44.v2.decrypt(
      giftWrap.content,
      nip44.v2.utils.getConversationKey(privKeyBytes, giftWrap.pubkey),
    );
    const seal = JSON.parse(sealJson) as import('nostr-tools').NostrEvent;
    // Step 2: Authenticate the seal — verify kind and schnorr signature.
    if (seal.kind !== SEAL_KIND) {
      throw new Error('not a seal');
    }
    if (!verifyEvent(seal)) {
      throw new Error('seal signature invalid');
    }
    // Step 3: Decrypt the seal. Use the authenticated seal.pubkey as ECDH counterparty.
    const rumorJson = nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(privKeyBytes, seal.pubkey),
    );
    const rumor = JSON.parse(rumorJson) as UnsignedRumor;
    // Step 4: Bind — the rumor's claimed sender must match the authenticated seal sender.
    // This closes the forgery vector: Mallory cannot claim to be Alice by putting
    // Alice's pubkey in the rumor, because the seal is signed with Mallory's key.
    if (rumor.pubkey !== seal.pubkey) {
      throw new Error('rumor sender mismatch');
    }
    // Step 5: Validate the rumor id against the canonical NIP-01 hash.
    // rumor.id must be the canonical hash of (pubkey, created_at, kind, tags, content).
    // Without this, a peer could embed an arbitrary id and confuse the
    // id-keyed dedup in chatPersistence.appendMessage. Practical impact is
    // limited (the round-2 sender binding already restricts the attacker to
    // the actual peer), but defense-in-depth.
    const canonicalId = getEventHash(rumor);
    if (rumor.id !== canonicalId) {
      throw new Error('rumor id invalid');
    }
    return rumor;
  } catch {
    // Re-throw a generic error to avoid leaking plaintext fragments, seal pubkeys,
    // or mismatch details that could assist an attacker.
    logger.info('dm:unwrap-failed', { wrapId: giftWrap.id ?? 'unknown' });
    throw new Error('gift wrap decryption failed');
  }
}

/**
 * Build a kind-14 (NIP-17 chat message) rumor without a sig.
 * The returned rumor has a valid id computed via NIP-01 hash.
 * Used by callers who need the rumor id before publishing (optimistic UI).
 *
 * @param extraTags Optional additional tags appended after the mandatory ["p", peerPubkeyHex] tag.
 *   Used by publishFeedbackMessage to add client/label markers without touching ordinary DMs.
 */
export function buildChatRumor(params: {
  privateKeyHex: string;
  peerPubkeyHex: string;
  content: string;
  attachments?: RoledAttachments;
  extraTags?: string[][];
}): UnsignedRumor {
  const privKeyBytes = hexToBytes(params.privateKeyHex);
  const senderPubkey = getPublicKey(privKeyBytes);
  const payload = buildPayload(params.content, params.attachments);
  const baseTags: string[][] = [['p', params.peerPubkeyHex]];
  const tags = params.extraTags && params.extraTags.length > 0
    ? [...baseTags, ...params.extraTags]
    : baseTags;
  const rumor = createRumor(
    {
      kind: CHAT_MESSAGE_KIND,
      content: JSON.stringify(payload),
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: senderPubkey,
    },
    privKeyBytes,
  );
  return rumor as UnsignedRumor;
}

/**
 * Publish a feedback DM from the user to the maintainer.
 *
 * Identical to publishDirectMessage in wire format (NIP-17 gift-wrap) but
 * adds two marker tags to the inner rumor so the maintainer can identify
 * feedback messages on receipt:
 *   ["client", "few", <build-version>]  — which app version sent this
 *   ["l", "feedback"]                          — label tag per NIP-32
 *
 * The build-version element is included only when NEXT_PUBLIC_BUILD_VERSION
 * is available; otherwise the tag is ["client", "few"] (two elements).
 *
 * Ordinary DMs sent via publishDirectMessage carry NO marker tags — this
 * function must not be confused with it.
 */
/**
 * The sealed marker tags that identify a kind-14 rumor as Few feedback.
 *
 * Two tags ride inside the sealed rumor (never on the relay-visible outer wrap):
 *   ["client", "few", <build-version>]  — NIP-89-style client identification
 *   ["l", "feedback"]                          — NIP-32 label discriminator
 *
 * The build-version slot is omitted when NEXT_PUBLIC_BUILD_VERSION is unavailable.
 * Consumed by the feedback send surface (ContactChat in feedback mode), which
 * passes these as buildChatRumor's extraTags so the markers ride on the inner
 * kind-14 rumor (AC-MARKER-1).
 */
export function feedbackMarkerTags(): string[][] {
  const buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION;
  const clientTag: string[] = buildVersion
    ? ['client', 'few', buildVersion]
    : ['client', 'few'];
  return [clientTag, ['l', 'feedback']];
}

/**
 * Publish a NIP-17 direct message as a kind-1059 NIP-59 gift wrap.
 *
 * Replaces the old NIP-04 kind-4 outbound path (D9b). Callers keep the same
 * function signature; only the wire format changes. Returns the inner rumor id
 * (the id that will appear in appendMessage / dedup), not the outer wrap id.
 *
 * The old signDirectMessage NIP-04 outbound function has been removed. The
 * NIP-04 inbound helpers (decryptDirectPayload, decryptDirectMedia) are kept
 * for the D9a legacy-inbound path.
 */
export async function publishDirectMessage(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  content: string;
  attachments?: RoledAttachments;
}): Promise<string> {
  const rumor = buildChatRumor(params);
  const wrap = await sealAndWrap(rumor, params.peerPubkeyHex, params.privateKeyHex);
  const ndkEvent = new NDKEvent(params.ndk, wrap as any);
  await publishWithTimeout(ndkEvent);
  return rumor.id;
}

/**
 * Seals, wraps and publishes an already-built rumor (the caller needs the rumor id
 * before the network round-trip, e.g. for the optimistic bubble). Throws if no relay
 * acks within PUBLISH_TIMEOUT_MS.
 */
export async function publishPrebuiltRumor(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  rumor: UnsignedRumor;
}): Promise<void> {
  const wrap = await sealAndWrap(params.rumor, params.peerPubkeyHex, params.privateKeyHex);
  await publishWithTimeout(new NDKEvent(params.ndk, wrap as any));
}

/**
 * Publish a kind-7 NIP-25 reaction rumor for a DM conversation via NIP-59 gift wrap.
 *
 * Seam S3 DM producer (story-07, AC-41).
 *
 * Builds a kind-7 rumor via buildReactionRumor (with ["p", peerPubkeyHex] per D10),
 * seals it with sealAndWrap (kind-1059, AC-60), and publishes via NDK.
 * Returns the inner rumor id — the id used by callers for optimistic row reconciliation
 * (no temp UUID needed for DMs because the rumor id is known pre-publish, AC-43).
 *
 * Does NOT call applyOptimistic — that is the caller's responsibility (ContactChat).
 */
export async function publishDirectReaction(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  emoji: string;
  targetMessage: import('@/src/lib/marmot/chatPersistence').ChatMessage;
}): Promise<{ rumorId: string }> {
  const { buildReactionRumor } = await import('@/src/lib/reactions/rumor');
  const rumor = buildReactionRumor({
    emoji: params.emoji,
    targetMessageId: params.targetMessage.id,
    targetMessageKind: CHAT_MESSAGE_KIND, // kind-14 DM chat messages
    targetAuthorPubkey: params.peerPubkeyHex, // p tag required for DMs per D10
    selfPrivKeyHex: params.privateKeyHex,
  });
  const wrap = await sealAndWrap(rumor, params.peerPubkeyHex, params.privateKeyHex);
  const ndkEvent = new NDKEvent(params.ndk, wrap as any);
  await publishWithTimeout(ndkEvent);
  return { rumorId: rumor.id };
}

/**
 * Remove a kind-7 NIP-25 reaction via a removal rumor (content: "-") in a DM conversation.
 *
 * Seam S3 DM producer (story-07, AC-42).
 *
 * Identical to publishDirectReaction but calls buildReactionRumor with isRemoval: true.
 * The resulting rumor has content "-" and an ["emoji", glyph] tag for unambiguous
 * multi-emoji removal (D2). Wrapped in kind-1059 gift wrap (AC-60).
 */
export async function removeDirectReaction(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  emoji: string;
  targetMessage: import('@/src/lib/marmot/chatPersistence').ChatMessage;
}): Promise<{ rumorId: string }> {
  const { buildReactionRumor } = await import('@/src/lib/reactions/rumor');
  const rumor = buildReactionRumor({
    emoji: params.emoji,
    targetMessageId: params.targetMessage.id,
    targetMessageKind: CHAT_MESSAGE_KIND,
    targetAuthorPubkey: params.peerPubkeyHex,
    selfPrivKeyHex: params.privateKeyHex,
    isRemoval: true,
  });
  const wrap = await sealAndWrap(rumor, params.peerPubkeyHex, params.privateKeyHex);
  const ndkEvent = new NDKEvent(params.ndk, wrap as any);
  await publishWithTimeout(ndkEvent);
  return { rumorId: rumor.id };
}

/**
 * Publish a NIP-09-shaped kind-5 delete signal for a DM conversation via NIP-59 gift wrap.
 *
 * Seam S4 DM producer (epic-feature-request-message-edit-and-delete, AC-DEL-2).
 *
 * Builds an unmarked kind-5 rumor via S2's buildDeleteRumor (never reimplements tag
 * building locally), seals it with sealAndWrap, and publishes via NDK. `priorReplacementIds`
 * is always empty for a Few client: this app's storage mutates an edited slot's single
 * row in place rather than persisting a chain of past replacement rumor ids, so there is
 * no local history to e-tag beyond the original (AC-DEL-8's extra e-tags are a best-effort
 * non-Few-interop enhancement, not required for a Few client's own reconciliation, which
 * resolves a slot by its stable original id alone).
 *
 * On a successful publish, durably persists the tombstone via S3's applyDeleteEditSignal —
 * deliberately AFTER publish confirms, not before. See this story's result.json for why:
 * an eager pre-publish durable apply followed by a synthetic "undo" signal on failure
 * cannot restore a never-before-edited row's `edited` flag (S3's applyToKnownSlotCore
 * unconditionally sets `edited:true` on any edit-shaped patch, and un-tombstoning is only
 * expressible through an edit-shaped patch) — deferring the durable write until publish
 * succeeds means a failed publish never durably wrote anything, so the caller's rollback
 * (ContactChat.handleDeleteMessage) is a pure, always-correct React-state revert.
 *
 * Does NOT touch React state — that is the caller's responsibility (ContactChat), exactly
 * like publishDirectReaction leaves applyOptimistic/rollbackOptimistic to its caller.
 */
/**
 * S4 gate-remediation (round-4, finding 2, sev6): re-reads the slot's authoritative
 * rev from storage rather than trusting a caller-supplied `ChatMessage` snapshot.
 *
 * `targetMessage` in publishDirectDelete/publishDirectEdit is a React-state read
 * (ContactChat's `messagesRef.current.find(...)`). React state only ever learns a
 * slot's NEW rev via an explicit re-read-and-patch after a successful action; the
 * optimistic patch applied before publish touches only content/edited, never rev.
 * So a second own edit/delete of the same slot within the same wall-clock second
 * would otherwise pass `targetMessage.rev ?? 0` (still 0/undefined) into clampRev,
 * which degenerates to a bare wall-clock value — colliding with (or losing to,
 * per the equal-rev tie rule) the first action's already-published rev roughly
 * half the time. Re-reading storage here means the rev computation is correct
 * regardless of whether any caller ever patches its own React state.
 */
async function resolveAuthoritativeRev(
  peerPubkeyHex: string,
  targetMessageId: string,
  fallbackRev: number | undefined,
): Promise<number> {
  const { loadMessages } = await import('@/src/lib/marmot/chatPersistence');
  const { messages } = await loadMessages(directConversationId(peerPubkeyHex));
  const row = messages.find((m) => m.id === targetMessageId);
  return row?.rev ?? fallbackRev ?? 0;
}

export async function publishDirectDelete(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  targetMessage: import('@/src/lib/marmot/chatPersistence').ChatMessage;
}): Promise<{ rumorId: string }> {
  const { buildDeleteRumor, clampRev } = await import('@/src/lib/messageEdits/rumor');
  const lastKnownRev = await resolveAuthoritativeRev(params.peerPubkeyHex, params.targetMessage.id, params.targetMessage.rev);
  const rev = clampRev(Math.floor(Date.now() / 1000), lastKnownRev);
  const rumor = buildDeleteRumor(
    params.targetMessage.id,
    [],
    CHAT_MESSAGE_KIND,
    rev,
    params.privateKeyHex,
  );
  const wrap = await sealAndWrap(rumor, params.peerPubkeyHex, params.privateKeyHex);
  const ndkEvent = new NDKEvent(params.ndk, wrap as any);
  await publishWithTimeout(ndkEvent);

  const { applyDeleteEditSignal } = await import('@/src/lib/messageEdits/api');
  // S4 gate-remediation (finding 4, sev4): a durable-write failure AFTER a
  // successful publish must not look like a publish failure to the caller — the
  // DM signal is already gift-wrapped and sent to the peer at this point, so
  // ContactChat.handleDeleteMessage's catch-and-rollback (which visually restores
  // the message) would otherwise permanently diverge this device's view from the
  // peer's. Swallow (log, never rethrow); only a genuine PUBLISH failure (above)
  // should trigger rollback (AC-DEL-2).
  try {
    await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: params.peerPubkeyHex }, rumor);
  } catch {
    logger.info('dm:delete-durable-apply-failed', { rumorId: rumor.id });
  }

  return { rumorId: rumor.id };
}

/**
 * Publish an edit-marked replacement (+ best-effort companion kind-5) for a DM message
 * via NIP-59 gift wrap.
 *
 * Seam S4 DM producer (AC-EDIT-8).
 *
 * Builds the replacement via S2's buildEditReplacementRumor, pinning `created_at` to
 * `targetMessage.createdAt` converted from storage MILLISECONDS to wire Unix SECONDS
 * (`Math.floor(createdAt / 1000)` — S2's caller contract; the builder throws if handed a
 * ms-scale value). `targetMessage.id` doubles as the slot's stable original id across a
 * repeated-edit chain (AC-EDIT-6): this app's storage mutates an edited row's content in
 * place rather than inserting a new row per edit, so the row's own id never changes and
 * is always the original — callers never need to track a separate "first message" id.
 *
 * AC-EDIT-8 ordering: the replacement is published FIRST and durably applied via S3's
 * applyDeleteEditSignal on success (deferred-until-success for the same reason documented
 * on publishDirectDelete above). Only then is the companion kind-5 attempted; a failed or
 * thrown companion publish is swallowed (logged, not re-thrown) so an absent/failed
 * companion can never delete the slot or roll back an already-successful edit — the
 * replacement alone is a complete edit for a Few client. A failed REPLACEMENT publish
 * throws before any durable write and before the companion is attempted, so the caller's
 * rollback (ContactChat.handleEditMessage) is a pure React-state revert.
 */
export async function publishDirectEdit(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  targetMessage: import('@/src/lib/marmot/chatPersistence').ChatMessage;
  newContent: string;
}): Promise<{ rumorId: string }> {
  const { buildEditReplacementRumor, buildEditMarkedCompanionKind5, clampRev } = await import('@/src/lib/messageEdits/rumor');
  // S4 gate-remediation (finding 2, sev6): see resolveAuthoritativeRev's doc comment
  // above (publishDirectDelete) — same stale-React-snapshot hazard applies here.
  const lastKnownRev = await resolveAuthoritativeRev(params.peerPubkeyHex, params.targetMessage.id, params.targetMessage.rev);
  const rev = clampRev(Math.floor(Date.now() / 1000), lastKnownRev);
  const originalCreatedAtSeconds = Math.floor(params.targetMessage.createdAt / 1000);

  const replacement = buildEditReplacementRumor(
    params.targetMessage.id,
    originalCreatedAtSeconds,
    params.newContent,
    CHAT_MESSAGE_KIND,
    rev,
    params.privateKeyHex,
  );

  // AC-EDIT-8: replacement MUST publish before the companion. A failure here throws —
  // no durable write has happened yet, so the caller's rollback is a pure state revert.
  const replacementWrap = await sealAndWrap(replacement, params.peerPubkeyHex, params.privateKeyHex);
  const replacementEvent = new NDKEvent(params.ndk, replacementWrap as any);
  await publishWithTimeout(replacementEvent);

  const { applyDeleteEditSignal } = await import('@/src/lib/messageEdits/api');
  // S4 gate-remediation (finding 4, sev4): swallow a post-publish durable-write
  // failure — see publishDirectDelete's matching comment above.
  try {
    await applyDeleteEditSignal({ kind: 'dm', peerPubkeyHex: params.peerPubkeyHex }, replacement);
  } catch {
    logger.info('dm:edit-durable-apply-failed', { rumorId: replacement.id });
  }

  // Best-effort companion kind-5 (non-Few degradation only, spec §2.4). AC-EDIT-8: a
  // failed/absent companion MUST NOT delete the slot and MUST NOT roll back the edit
  // that already succeeded above — swallow, never throw.
  try {
    const companion = buildEditMarkedCompanionKind5(
      params.targetMessage.id,
      [],
      CHAT_MESSAGE_KIND,
      rev,
      params.privateKeyHex,
    );
    const companionWrap = await sealAndWrap(companion, params.peerPubkeyHex, params.privateKeyHex);
    const companionEvent = new NDKEvent(params.ndk, companionWrap as any);
    await publishWithTimeout(companionEvent);
  } catch {
    logger.info('dm:edit-companion-publish-failed', { rumorId: replacement.id });
  }

  return { rumorId: replacement.id };
}

function getDmConversationKey(privateKeyHex: string, peerPubkeyHex: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(hexToBytes(privateKeyHex), peerPubkeyHex);
}

async function importAesKey(privateKeyHex: string, peerPubkeyHex: string): Promise<CryptoKey> {
  const keyBytes = getDmConversationKey(privateKeyHex, peerPubkeyHex);
  return crypto.subtle.importKey('raw', toArrayBuffer(new Uint8Array(keyBytes)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function randomNonceHex(): string {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return bytesToHex(nonce);
}

export async function encryptDirectMedia(blob: Blob, metadata: {
  filename: string;
  type: string;
  size?: number;
  dimensions?: string;
  blurhash?: string;
}, privateKeyHex: string, peerPubkeyHex: string): Promise<{ encrypted: Uint8Array; attachment: DirectMediaAttachment }> {
  const key = await importAesKey(privateKeyHex, peerPubkeyHex);
  const nonce = randomNonceHex();
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(hexToBytes(nonce)) },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    encrypted: new Uint8Array(ciphertext),
    attachment: {
      sha256: await sha256Hex(plaintext),
      type: metadata.type,
      filename: metadata.filename,
      nonce,
      version: DIRECT_MEDIA_VERSION,
      size: metadata.size,
      dimensions: metadata.dimensions,
      blurhash: metadata.blurhash,
    },
  };
}

export async function decryptDirectMedia(
  attachment: DirectMediaAttachment,
  privateKeyHex: string,
  peerPubkeyHex: string,
): Promise<{ bytes: Uint8Array; type: string }> {
  const key = await importAesKey(privateKeyHex, peerPubkeyHex);
  const encrypted = await blossomGet(attachment.url!);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(hexToBytes(attachment.nonce)) },
    key,
    toArrayBuffer(new Uint8Array(encrypted)),
  );
  const bytes = new Uint8Array(plaintext);
  const digest = await sha256Hex(bytes);
  if (digest !== attachment.sha256) {
    throw new Error('direct media integrity check failed');
  }
  return { bytes, type: attachment.type };
}

export async function sendDirectImageMessage(params: {
  ndk: NDK;
  privateKeyHex: string;
  peerPubkeyHex: string;
  signer: import('applesauce-core').EventSigner;
  caption: string;
  file: File;
  onProgress: (status: 'processing' | 'sent' | 'failed' | { status: 'uploading'; pct: number }) => void;
}): Promise<{ eventId: string; attachments: RoledAttachments }> {
  const { processImage, ImageTooLargeError } = await import('@/src/lib/media/imageProcessing');
  params.onProgress('processing');

  let processed;
  try {
    processed = await processImage(params.file);
  } catch (err) {
    if (err instanceof ImageTooLargeError) throw err;
    params.onProgress('failed');
    throw err;
  }

  if (processed.full.blob.size > MAX_OUTPUT_BYTES) {
    params.onProgress('failed');
    throw new ImageTooLargeError();
  }

  const baseName = params.file.name.replace(/\.[^.]+$/, '') || 'image';
  const fullFilename = `${baseName}.webp`;
  const thumbFilename = `${baseName}.thumb.webp`;

  const [fullEnc, thumbEnc] = await Promise.all([
    encryptDirectMedia(
      processed.full.blob,
      {
        filename: fullFilename,
        type: 'image/webp',
        dimensions: processed.full.dimensions,
        blurhash: processed.blurhash,
        size: processed.full.blob.size,
      },
      params.privateKeyHex,
      params.peerPubkeyHex,
    ),
    encryptDirectMedia(
      processed.thumb.blob,
      {
        filename: thumbFilename,
        type: 'image/webp',
        dimensions: processed.thumb.dimensions,
        size: processed.thumb.blob.size,
      },
      params.privateKeyHex,
      params.peerPubkeyHex,
    ),
  ]);

  let uploadedCount = 0;
  const handleProgress = (pct: number) => {
    params.onProgress({ status: 'uploading', pct: Math.round((uploadedCount * 100 + pct) / 2) });
  };

  params.onProgress({ status: 'uploading', pct: 0 });

  try {
    const fullUrl = await put(fullEnc.encrypted, params.signer, (pct) => handleProgress(pct));
    uploadedCount = 1;
    const thumbUrl = await put(thumbEnc.encrypted, params.signer, (pct) => handleProgress(pct));

    const attachments: RoledAttachments = {
      full: { ...fullEnc.attachment, url: fullUrl },
      thumb: { ...thumbEnc.attachment, url: thumbUrl },
    };

    const eventId = await publishDirectMessage({
      ndk: params.ndk,
      privateKeyHex: params.privateKeyHex,
      peerPubkeyHex: params.peerPubkeyHex,
      content: params.caption,
      attachments,
    });

    params.onProgress('sent');
    return { eventId, attachments };
  } catch (err) {
    params.onProgress('failed');
    throw err;
  }
}
