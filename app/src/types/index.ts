// ============================
// Language / Theme Types
// ============================

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number];
// AppThemeName is derived from the theme registry (app/src/themes/registry.generated.ts),
// not hardcoded here, so the folder-name set stays the single source of truth
// (architecture.md Boundary Rules: "types -> registry.generated (AppThemeName type)").
// Imported (not just re-exported) so it can also be used below in this file.
import type { AppThemeName } from '@/src/themes/registry.generated';
export type { AppThemeName };

// ============================
// User Data / localStorage Types
// ============================

export type Settings = {
  theme: AppThemeName;
  mood?: AppThemeName;
  language: LanguageCode;
};

export type ProfileAvatar = {
  imageUrl: string;
};

export type UserProfile = {
  nickname: string;
  avatar: ProfileAvatar | null;
};

// ============================
// Storage Keys
// ============================

export const STORAGE_KEYS = {
  settings: 'lp_settings_v1',
  userProfile: 'lp_userProfile_v1',
  nostrIdentity: 'lp_nostrIdentity_v1',
  nostrBackedUp: 'lp_nostrIdentityBackedUp_v1',
  processedGiftWraps: 'lp_processedGiftWraps',
  contactCache: 'lp_contactCache_v1',
  contacts: 'lp_contacts_v1',
  knownPeers: 'lp_knownPeers_v1',
  knownPeersMigrated: 'lp_knownPeersMigrated_v2',
  pendingInvitations: 'lp_pendingInvitations_v1',
  relays: 'lp_relays_v1',
  signerMode: 'lp_signerMode_v1',
  nip46Session: 'lp_nip46Session_v1',
  // MIP-00 KeyPackage addressable slot (`d` tag) identifier, minted once via
  // generateKeyPackageSlot() and reused across launches/rotations. See
  // storage.ts's readOrCreateKeyPackageSlot().
  keyPackageSlot: 'lp_keyPackageSlot_v1',
  // Pubkey of a recovered identity whose relay backup the user has not yet
  // restored or skipped; scheduled backups must not overwrite it meanwhile.
  backupRestorePending: 'lp_backupRestorePending_v1',
} as const;

// ============================
// Nostr / Groups Types
// ============================

/** Default public relay URLs for Nostr connections */
const ENV_RELAYS = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_RELAYS
  ? process.env.NEXT_PUBLIC_RELAYS.split(',').map(r => r.trim()).filter(Boolean)
  : null;

export const DEFAULT_RELAYS: readonly string[] = ENV_RELAYS ?? [
  'wss://relay.damus.io',
  'wss://nos.lol',
];

export type NostrIdentity = {
  pubkeyHex: string;
  npub: string;
  /** Whether the identity has been backed up via seed phrase */
  backedUp: boolean;
};

export type Group = {
  /** hex-encoded MLS group ID */
  id: string;
  name: string;
  /** Unix timestamp of creation/join */
  createdAt: number;
  /** hex pubkeys of members known to the local client */
  memberPubkeys: string[];
  /** Relay URLs this group uses */
  relays: string[];
};

export type GroupMember = {
  pubkeyHex: string;
  npub: string;
  nickname: string;
};

/**
 * Signed Nostr kind:0 envelope embedded inside a profile rumor's content.
 * Authenticates the original profile author independently of the MLS relayer,
 * enabling relay-on-behalf for offline members.
 */
export type SignedProfileEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 0;
  tags: string[][];
  content: string;
  sig: string;
};

export type MemberProfile = {
  pubkeyHex: string;
  nickname: string;
  avatar: ProfileAvatar | null;
  /** ISO timestamp for LWW resolution */
  updatedAt: string;
  /** Verified signed envelope when the profile arrived via a sig-bearing rumor. Absent for legacy peers. */
  signedEvent?: SignedProfileEvent;
  /**
   * Provisional name seeded locally from a self-asserted source (e.g. the
   * name carried in a join request, persisted when the admin approves it) —
   * NOT a signed in-group profile the member has actually sent. Provisional
   * entries fill the member-list name so it isn't a raw npub, but do NOT count
   * as "confirmed membership": the "Pending" badge stays until the member's
   * real signed profile arrives and supersedes this entry via LWW. Seeded with
   * an epoch-0 `updatedAt` so any real profile always wins the merge and the
   * member is still treated as stale by the profile-request sweep.
   */
  provisional?: boolean;
};

// ============================
// Voice / Video Call Types (AC-WebRTC, kinds 25050–25055)
// ============================

/**
 * Nostr event kinds used for call signaling (Amethyst AC-WebRTC wire format).
 * Events are ephemeral (kind range 20000–29999); they travel inside kind-21059
 * gift wraps and are never published in cleartext.
 */
export type CallKind = 25050 | 25051 | 25052 | 25053 | 25054 | 25055;

/**
 * Parsed representation of a received (decrypted, verified) call signaling event.
 * Callers receive this from `subscribeCallSignaling` and never see the raw wire bytes.
 */
export interface IncomingCallEvent {
  /** Which type of signaling message this is. */
  kind: CallKind;
  /** Stable call-session UUID shared by all events of one call. */
  callId: string;
  /** Hex pubkey of the real (inner-event-signed) sender. */
  senderPubkey: string;
  /** Present on kind 25050 (Offer) only. */
  callType?: 'voice' | 'video';
  /** Raw SDP string; present on kinds 25050, 25051, 25055. */
  sdp?: string;
  /** Parsed ICE candidate; present on kind 25052. Defaults: sdpMid→"0", sdpMLineIndex→0. */
  iceCandidate?: RTCIceCandidateInit;
  /** Plaintext reason; present on kinds 25053 and 25054. May be "busy" or "". */
  reason?: string;
  /** All `p`-tagged pubkeys from the inner event (full roster for offers/answers). */
  recipientPubkeys: string[];
  /** The inner event's `id` — used for deduplication. */
  innerEventId: string;
}

/**
 * Parameters for `subscribeCallSignaling`.
 * `groupsRef` is intentionally absent from this pure-lib type — the roster gate is
 * implemented via the injected `isAuthorized` callback, which the caller (e.g.
 * IncomingCallWatcher) closes over its own group state.
 */
export interface CallSignalingParams {
  /** Local user's hex pubkey — used as the `#p` subscription filter value. */
  pubkeyHex: string;
  /** Local user's hex private key — used to NIP-44 decrypt incoming gift wraps. */
  privateKeyHex: string;
  /**
   * Authorization gate called after signature verification.
   * Returns true when the sender is authorised to signal this call (e.g. is a
   * current MLS group member or the expected 1:1 peer).
   */
  isAuthorized: (senderPubkey: string, callId: string) => Promise<boolean>;
  /** Called for each valid, authorized, non-duplicate, fresh signaling event. */
  onEvent: (evt: IncomingCallEvent) => void;
}
