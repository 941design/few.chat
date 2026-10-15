import type { PollResult } from './pollPersistence';

/**
 * Resolve the display name for an invite_cancelled canceller.
 * ALWAYS uses the protocol-enforced MLS senderPubkey — never the
 * attacker-controlled `structured.by` field — to prevent identity spoofing.
 */
export function resolveCancellerDisplay(
  senderPubkey: string,
  profileMap: Record<string, { nickname?: string }>,
  truncate: (pubkey: string) => string,
): string {
  return profileMap[senderPubkey]?.nickname ?? truncate(senderPubkey);
}

export type StructuredContent =
  | { type: 'poll_open'; pollId: string; title: string; creatorPubkey: string }
  | { type: 'poll_close'; pollId: string; title: string; results: PollResult[]; totalVoters: number }
  | { type: 'image'; version: 1; caption: string }
  | { type: 'invite_cancelled'; pubkey: string; by: string }
  | { type: 'leave_intent'; pubkey: string; name?: string }
  | { type: 'group_renamed'; name: string }
  | { type: 'call_notice'; event: 'started' | 'ended'; callId: string; initiator: string }
  | { type: 'member_admitted'; pubkey: string }
  // AC-STRUCT-5: `pubkey` here is the subject/invitee (canonical 64-char
  // lowercase hex), NOT the author of the message. Any renderer of this
  // variant MUST resolve the displayed *author* from the message's
  // protocol-level `senderPubkey` — NEVER from this payload's `pubkey`
  // field — to prevent identity spoofing.
  | { type: 'invite_lifecycle'; event: 'invited' | 'accepted' | 'declined'; pubkey: string }
  | null;

/**
 * Canonical subject-pubkey guard for every announcement whose payload names a
 * subject member that the renderer resolves via pubkeyToNpub →
 * nip19.npubEncode. That encoder THROWS on malformed hex, so a crafted group
 * message like {"type":"leave_intent","pubkey":"x"} would otherwise break the
 * chat timeline for every receiver. Rejecting non-canonical pubkeys here makes
 * such content fall through to harmless plain-text rendering. Every producer
 * emits a canonical 64-char lowercase-hex pubkey (leaveGroupImpl's
 * selfPubkeyHex, cancelInvitationImpl's roster pubkey, the admission paths'
 * request.pubkeyHex), so this never rejects a legitimate announcement.
 * The `typeof` check matters: RegExp#test coerces its argument, so a
 * one-element array `["<64 hex>"]` would otherwise pass.
 */
function isCanonicalPubkey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function parseStructured(content: string): StructuredContent {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === 'poll_open' && parsed.pollId && parsed.title) return parsed as StructuredContent;
    if (parsed?.type === 'poll_close' && parsed.pollId && parsed.title && Array.isArray(parsed.results)) return parsed as StructuredContent;
    if (parsed?.type === 'image' && parsed.version !== undefined) {
      return { type: 'image', version: 1, caption: typeof parsed.caption === 'string' ? parsed.caption : '' };
    }
    if (parsed?.type === 'invite_cancelled' && isCanonicalPubkey(parsed.pubkey) && typeof parsed.by === 'string') {
      return { type: 'invite_cancelled', pubkey: parsed.pubkey, by: parsed.by };
    }
    if (parsed?.type === 'leave_intent' && isCanonicalPubkey(parsed.pubkey)) {
      // The leaver embeds their own display name so the announcement shows a
      // name (not an npub) even when the viewer never received the leaver's
      // MemberProfile. Self-reported, but it is the sender's OWN name over the
      // encrypted group channel — no cross-identity spoofing beyond a display
      // name the sender could set on their profile anyway.
      const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : undefined;
      return { type: 'leave_intent', pubkey: parsed.pubkey, name };
    }
    if (parsed?.type === 'group_renamed' && typeof parsed.name === 'string' && parsed.name.length > 0) {
      return { type: 'group_renamed', name: parsed.name };
    }
    if (
      parsed?.type === 'call_notice' &&
      (parsed.event === 'started' || parsed.event === 'ended') &&
      typeof parsed.callId === 'string' &&
      typeof parsed.initiator === 'string'
    ) {
      return { type: 'call_notice', event: parsed.event, callId: parsed.callId, initiator: parsed.initiator };
    }
    if (parsed?.type === 'member_admitted' && isCanonicalPubkey(parsed.pubkey)) {
      return { type: 'member_admitted', pubkey: parsed.pubkey };
    }
    if (
      parsed?.type === 'invite_lifecycle' &&
      (parsed.event === 'invited' || parsed.event === 'accepted' || parsed.event === 'declined') &&
      isCanonicalPubkey(parsed.pubkey)
    ) {
      return { type: 'invite_lifecycle', event: parsed.event, pubkey: parsed.pubkey };
    }
  } catch {
    // Not JSON — plain text message
  }
  return null;
}
