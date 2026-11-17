/**
 * Call-signaling kind constants (Amethyst AC-WebRTC wire format, kinds 25050–25055), kept dependency-free so
 * light modules (e.g. the NIP-46 permission builder) can import them without pulling in NDK via callSignaling.
 */
export const CALL_OFFER_KIND = 25050 as const;
export const CALL_ANSWER_KIND = 25051 as const;
export const CALL_ICE_KIND = 25052 as const;
export const CALL_HANGUP_KIND = 25053 as const;
export const CALL_REJECT_KIND = 25054 as const;
export const CALL_RENEGOTIATE_KIND = 25055 as const;
