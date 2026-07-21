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
  | null;

export function parseStructured(content: string): StructuredContent {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === 'poll_open' && parsed.pollId && parsed.title) return parsed as StructuredContent;
    if (parsed?.type === 'poll_close' && parsed.pollId && parsed.title && Array.isArray(parsed.results)) return parsed as StructuredContent;
    if (parsed?.type === 'image' && parsed.version !== undefined) {
      return { type: 'image', version: 1, caption: typeof parsed.caption === 'string' ? parsed.caption : '' };
    }
    if (parsed?.type === 'invite_cancelled' && typeof parsed.pubkey === 'string' && typeof parsed.by === 'string') {
      return { type: 'invite_cancelled', pubkey: parsed.pubkey, by: parsed.by };
    }
    if (parsed?.type === 'leave_intent' && typeof parsed.pubkey === 'string') {
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
    // Require a canonical 64-char lowercase-hex pubkey, not merely a string.
    // The render branch feeds `pubkey` to pubkeyToNpub → nip19.npubEncode,
    // which THROWS on malformed hex — so a crafted group message like
    // {"type":"member_admitted","pubkey":"x"} would otherwise break the chat
    // timeline for every receiver. Rejecting non-canonical pubkeys here makes
    // such content fall through to harmless plain-text rendering. The app only
    // ever emits `request.pubkeyHex` (always canonical), so this never rejects
    // a legitimate announcement. NOTE: the leave_intent / invite_cancelled
    // siblings share the looser `typeof === 'string'` guard and the same
    // latent throw — a pre-existing gap left untouched here to keep this epic
    // scoped; hardening them uniformly is a separate follow-up.
    if (parsed?.type === 'member_admitted' && /^[0-9a-f]{64}$/.test(parsed.pubkey)) {
      return { type: 'member_admitted', pubkey: parsed.pubkey };
    }
  } catch {
    // Not JSON — plain text message
  }
  return null;
}
