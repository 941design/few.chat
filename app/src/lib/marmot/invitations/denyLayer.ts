/**
 * Deny layer for the library inbox (D14, seam `DenyLayer`, AC-BLK-1): ADR-008 re-applied on the new path.
 *
 * One predicate, `isBlocked(pubkey)`, over the block set derived from `lib/blockedPeers.ts` (read-only: the
 * contacts store stays the single source of truth for "blocked"; this module owns no data and no key).
 * Consumers: the pending view (S9) declines an invitation from a blocked sponsor with
 * `decline(id, {declineRumor:false})`; the invite-context handler (S10) and the join-request handler (S12)
 * drop a blocked sender's rumor before storing anything and before any bell.
 *
 * The block set is read through an injected loader on EVERY call (no cache): a block placed after
 * construction applies to the next arrival. Pure and synchronous, so it is safe inside a library frame.
 * Ports are validated at construction: a missing loader throws instead of degrading to "nobody blocked".
 */
import { isBlockedPeer } from '@/src/lib/blockedPeers';

export interface DenyLayer {
  /** True iff `pubkey` (any case) is a blocked peer. An empty pubkey is never blocked. */
  isBlocked: (pubkey: string) => boolean;
}

interface DenyLayerDeps {
  /** The current block set, lowercase hex pubkeys (production: `loadBlockedPeers` from `lib/blockedPeers.ts`). */
  loadBlockedPeers: () => ReadonlySet<string>;
}

export function createDenyLayer(deps: DenyLayerDeps): DenyLayer {
  if (!deps || typeof deps.loadBlockedPeers !== 'function') {
    throw new TypeError('createDenyLayer: required dependency "loadBlockedPeers" is missing');
  }
  const { loadBlockedPeers } = deps;
  return {
    isBlocked: (pubkey) => isBlockedPeer(pubkey, loadBlockedPeers()),
  };
}
