/**
 * walledGarden.ts — Whitelist computation for the DM walled-garden feature.
 *
 * Pure functions over the current MLS group
 * snapshot and the ever-known peers set — no IDB, no NDK, no React, no side effects.
 *
 * Whitelist definition (S1 — ever-known peers): a peer pubkey is allowed if it
 * appears in `group.memberPubkeys` of at least one currently joined MLS group OR
 * in the `knownPeers` set (AC-SEC-12), excluding the user's own pubkey (DD-10,
 * AC-SEC-1).
 *
 * Comparisons are case-insensitive (AC-SEC-2) because Nostr pubkeys arrive in
 * various capitalisations from different relay and client implementations.
 *
 * AC-SEC-13: `isAllowedDmSender` is and must remain synchronous and free of any
 * IDB, NDK, React, or localStorage access inside its body.
 */

import type { Group } from '@/src/types';

/**
 * Parameter bag for the purge helpers' `getWhitelist` accessor.
 * Carries the current group snapshot, ever-known peers, and own pubkey at the
 * time of the sweep.
 */
type GroupRoster = Pick<Group, 'memberPubkeys'>;

/** Use the live roster while this tab owns the lease, and the persisted roster while it waits. */
export function selectDmMembership(
  overlay: readonly GroupRoster[],
  live: ReadonlyArray<{ members: () => readonly string[] }>,
  leaseHeld: boolean,
): readonly GroupRoster[] {
  if (!leaseHeld) return overlay;
  return live.flatMap((group) => {
    try {
      return [{ memberPubkeys: [...group.members()] }];
    } catch {
      return [];
    }
  });
}

export type WhitelistArgs = {
  groups: readonly GroupRoster[];
  knownPeers: ReadonlySet<string>;
  ownPubkeyHex: string | null | undefined;
};

/**
 * Determines whether `peerHex` is a permitted DM sender for the local user.
 *
 * @param peerHex      - Hex pubkey of the candidate sender. May be any case.
 * @param groups       - Snapshot of the user's currently joined MLS groups.
 * @param knownPeers   - Set of ever-known peer pubkeys (lowercase hex).
 * @param ownPubkeyHex - The local user's hex pubkey (any case, or null/undefined).
 *
 * @returns `true` if and only if:
 *   - `peerHex` is non-empty, AND
 *   - `peerHex` (case-insensitive) does NOT equal `ownPubkeyHex`, AND
 *   - `groups` is non-empty OR `knownPeers` is non-empty, AND
 *   - `peerHex` (case-insensitive) appears in `group.memberPubkeys` of at
 *     least one element of `groups`, OR in `knownPeers`.
 *
 * Returns `false` for any other case, including empty `peerHex`, self-addressing,
 * or a peer absent from both groups and knownPeers.
 *
 * AC-SEC-13: this function reads exclusively from its four declared parameters.
 * No IDB, NDK, React, or localStorage access occurs inside this body.
 */
export function isAllowedDmSender(
  peerHex: string,
  groups: readonly GroupRoster[],
  knownPeers: ReadonlySet<string>,
  ownPubkeyHex: string | null | undefined,
): boolean {
  // AC-SEC-1: empty peerHex
  if (!peerHex) return false;

  const peerLower = peerHex.toLowerCase();

  // AC-SEC-1: self-addressing (case-insensitive)
  if (ownPubkeyHex && peerLower === ownPubkeyHex.toLowerCase()) return false;

  // AC-SEC-12: if both groups and knownPeers are empty, no peer can be allowed
  if (groups.length === 0 && knownPeers.size === 0) return false;

  // AC-SEC-2: peer must appear in memberPubkeys of at least one group (case-insensitive)
  for (const group of groups) {
    for (const memberPubkey of group.memberPubkeys) {
      if (memberPubkey.toLowerCase() === peerLower) return true;
    }
  }

  // AC-SEC-12: peer is in ever-known set
  if (knownPeers.has(peerLower)) return true;

  return false;
}
