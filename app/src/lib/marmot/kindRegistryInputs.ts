/** App kinds carried as MLS application rumors inside groups. */
export const APP_RUMOR_KINDS = [0, 5, 7, 9, 10, 11, 12, 30] as const;

/** App kinds carried in gift wraps on the library inbox or the NDK DM plane. */
export const APP_INBOX_KINDS = {
  joinRequest: 21059,
  pairingAck: 21060,
  dmProfile: [21061, 21062],
  inviteContext: 21064,
} as const;
