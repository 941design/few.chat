/**
 * profileSync.ts — Utilities for building and processing profile messages.
 *
 * Wire format (epic: member-profile-discovery-and-relay-on-behalf, story 01):
 * the kind-0 application rumor's `content` carries a stringified, fully signed
 * Nostr kind:0 event (SignedProfileEvent). The outer MLS rumor stays unsigned
 * per MIP-03; authentication of the original author lives inside the embedded
 * envelope. The inner event's `content` is the same flat ProfilePayload JSON
 * (nickname/avatar/updatedAt) we have always shipped.
 *
 * Backward compatibility: legacy peers may still emit a flat ProfilePayload
 * with no envelope. parseProfilePayload accepts both shapes; legacy parses
 * yield `signedEvent === undefined` and are non-relayable until the peer
 * upgrades.
 *
 * Epic: group-message-author-auth-app-layer | Story S7 — the envelope's
 * crypto/shape verification (signature, inner kind, group-binding policy) is
 * generalized into the shared verifier (envelopeVerifier.ts); this module
 * declares profile's OWN per-kind spec (PROFILE_KIND_SPEC, group-binding
 * EXEMPT) and stays responsible only for the profile-specific wire shape
 * (nickname/avatar/updatedAt) and the legacy-unsigned fallback.
 */

import type { EventSigner } from 'applesauce-core';
import type { UserProfile, ProfileAvatar, MemberProfile, SignedProfileEvent } from '@/src/types';
import { AVATAR_BROWSER_CONFIG } from '@/src/config/profile';
import { verifyForwardedEnvelope, type ForwardedKindSpec } from '@/src/lib/marmot/envelopeVerifier';
import { isAllowedAvatarImageUrl } from '@/src/lib/dmProfile/kinds';

/** MLS application-message rumor kind for profile updates (kind 0 = metadata). */
export const PROFILE_RUMOR_KIND = 0;

/** Wire format for the profile data section (carried inside SignedProfileEvent.content). */
export type ProfilePayload = {
  nickname: string;
  /**
   * Canonical shape carries only `imageUrl`. `id` is accepted on read for
   * backward compatibility with peers who synced before the imageUrl-only
   * change; the imageUrl is reconstructed from it.
   */
  avatar: { imageUrl?: string; id?: string } | null;
  updatedAt: string;
  /** Present when the rumor carried a verified SignedProfileEvent envelope. */
  signedEvent?: SignedProfileEvent;
};

function buildPayloadJson(profile: UserProfile): string {
  const payload = {
    nickname: profile.nickname,
    avatar: profile.avatar ? { imageUrl: profile.avatar.imageUrl } : null,
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

/**
 * Sign a UserProfile and return the JSON-stringified SignedProfileEvent
 * suitable for an MLS rumor's `content`. The outer rumor stays unsigned.
 */
export async function serialiseProfileUpdate(
  profile: UserProfile,
  signer: EventSigner,
): Promise<string> {
  const draft = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [] as string[][],
    content: buildPayloadJson(profile),
  };
  const signed = await signer.signEvent(draft);
  if (signed.kind !== 0) {
    throw new Error(`profileSync: signer returned kind ${signed.kind}, expected 0`);
  }
  const envelope: SignedProfileEvent = {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: 0,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
  return JSON.stringify(envelope);
}

/**
 * Profile's own per-kind spec for the shared envelope verifier
 * (architecture.md "Shared verifier" module / per-kind binding policy).
 * groupScoped: false — profile is context-free and identity-scoped, so it is
 * EXEMPT from the group-tag check (and, separately, from the roster/actor-
 * in-roster check — neither this module nor handlers/profileHandler.ts ever
 * consults a roster/admin provider for profile envelopes). Rejecting a
 * departed member's late or forwarded profile on roster grounds would
 * degrade their name in history to a raw key (spec.md Solution §6).
 */
export const PROFILE_KIND_SPEC: ForwardedKindSpec = {
  innerKind: PROFILE_RUMOR_KIND,
  binding: { groupScoped: false },
};

function parseInnerProfile(content: string): {
  nickname: string;
  avatar: ProfilePayload['avatar'];
  updatedAt: string;
} | null {
  try {
    const d = JSON.parse(content) as Partial<ProfilePayload>;
    if (
      typeof d.nickname !== 'string' ||
      typeof d.updatedAt !== 'string'
    ) {
      return null;
    }
    return {
      nickname: d.nickname,
      avatar: d.avatar ?? null,
      updatedAt: d.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Parse rumor content as a ProfilePayload.
 *
 * - Envelope shape (signed Nostr kind:0): verified via the shared envelope
 *   verifier (envelopeVerifier.ts) against PROFILE_KIND_SPEC — signature,
 *   inner kind, and (vacuously, since profile is group-binding EXEMPT) no
 *   group-tag check. On success, parse the inner content and return the
 *   payload with signedEvent populated. On a structurally-envelope-shaped
 *   but failed verification (bad sig / wrong kind), reject outright — do NOT
 *   fall back to legacy parsing (that would let an attacker strip/forge the
 *   envelope and resubmit the same bytes as "legacy").
 * - Not envelope-shaped at all (verifier reason 'malformed'): try the legacy
 *   flat ProfilePayload shape. Legacy parses yield signedEvent undefined.
 * - Anything else: null.
 *
 * One-shot consumption (AC-FWD-5) is NOT performed here — this function only
 * verifies; the caller (handlers/profileHandler.ts) gates application of a
 * side effect on the shared verifier's createOneShotGate(), keyed on
 * signedEvent.id, at the point it actually applies the profile.
 */
export function parseProfilePayload(content: string): ProfilePayload | null {
  const verifyResult = verifyForwardedEnvelope(content, PROFILE_KIND_SPEC);

  if (verifyResult.ok) {
    const inner = parseInnerProfile(verifyResult.event.content);
    if (!inner) return null;
    return { ...inner, signedEvent: verifyResult.event as SignedProfileEvent };
  }

  if (verifyResult.reason !== 'malformed') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (parsed && typeof parsed === 'object') {
    const inner = parseInnerProfile(content);
    if (!inner) return null;
    return inner;
  }

  return null;
}

/**
 * Reconstruct a full MemberProfile from a parsed payload.
 *
 * Identity binding: when the payload carries a verified SignedProfileEvent,
 * the keying pubkey is the AUTHOR (signedEvent.pubkey), not the caller-supplied
 * `fallbackPubkeyHex`. The fallback is used only for legacy unsigned payloads
 * (signedEvent absent), where the MLS rumor sender is the only available
 * identity. This protects the relay-on-behalf path (story 06): when peer A
 * relays B's signed profile, the result is keyed under B, not A.
 */
export function payloadToMemberProfile(fallbackPubkeyHex: string, payload: ProfilePayload): MemberProfile {
  const authorPubkey = payload.signedEvent?.pubkey ?? fallbackPubkeyHex;
  let avatar: ProfileAvatar | null = null;
  if (payload.avatar) {
    // Prefer the imageUrl sent directly; fall back to reconstructing it from a
    // legacy `id` for peers who synced before the imageUrl-only change.
    const imageUrl = payload.avatar.imageUrl
      ?? (payload.avatar.id
        ? `${AVATAR_BROWSER_CONFIG.endpointBaseUrl}/${payload.avatar.id}.png`
        : undefined);
    // Untrusted wire value: apply the same URL rules as the 1:1 profile
    // codec (https:// or // only, <= 512 chars). A rejected avatar is dropped
    // — the rest of the profile (nickname, updatedAt, signedEvent) is kept.
    if (isAllowedAvatarImageUrl(imageUrl)) {
      avatar = { imageUrl };
    }
  }
  return {
    pubkeyHex: authorPubkey,
    nickname: payload.nickname,
    avatar,
    updatedAt: payload.updatedAt,
    ...(payload.signedEvent ? { signedEvent: payload.signedEvent } : {}),
  };
}
