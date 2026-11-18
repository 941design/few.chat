/** Shared rumor and authenticated sender types for group history handlers. */

export interface ApplicationRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface DispatcherContext {
  groupId: string;
  selfPubkeyHex: string;
  getActiveGroupId: () => string | null;
}

export interface AuthenticatedSender {
  pubkey: string;
  // Group history supplies an MLS-authenticated account. Reducer fixtures can
  // also exercise validation with claimed identity.
  authenticity: 'claimed' | 'mls';
}

/**
 * One surviving history row as a recompute folds it. `sender` is ALWAYS the row's
 * `orderingKey.account` (the MLS-authenticated sender), never `rumor.pubkey`;
 * `receivedAt` (ms) is the row's persisted first-append time, the deterministic clock of the fold.
 */
export interface RecomputeSignal {
  rumor: ApplicationRumor;
  sender: string;
  /** kind-445 event id of the carrier row. */
  eventId: string;
  seq: number;
  receivedAt: number;
}
