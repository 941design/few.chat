/**
 * knownPeers.ts — Ever-known peer registry (Walled Garden v2, S1).
 *
 * Persists the set of hex pubkeys the local user has ever shared an MLS group
 * with. Once a peer appears in this set they remain allowed as DM senders even
 * after they leave all shared groups, until an explicit account reset.
 *
 * Design constraints (AC-STRUCT-1):
 *   - MUST be pure localStorage — no IDB, no NDK, no React, no context.
 *   - MUST be synchronous.
 *   - MUST NOT import from idb-keyval, any NDK package, React,
 *     app/src/context/, or app/src/components/.
 *
 * Storage keys:
 *   lp_knownPeers_v1             — JSON array of lowercase hex pubkeys
 *   lp_knownPeersMigrated_v2     — presence flag: migration S3 has run
 */

import { postStoreChanged } from '@/src/lib/crossTab';

const KNOWN_PEERS_KEY = 'lp_knownPeers_v1';
const KNOWN_PEERS_MIGRATED_KEY = 'lp_knownPeersMigrated_v2';

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isLocalStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readRaw(): string[] {
  if (!isLocalStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(KNOWN_PEERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function writeRaw(peers: string[]): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(KNOWN_PEERS_KEY, JSON.stringify(peers));
  } catch {
    // Non-fatal — storage may be full or unavailable
    return;
  }
  // Other open tabs re-read the set (cross-tab change notifications).
  postStoreChanged('known');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Loads all ever-known peer pubkeys from localStorage.
 *
 * @returns A ReadonlySet of lowercase hex pubkeys. Empty set when nothing is
 *   stored or localStorage is unavailable.
 */
export function loadKnownPeers(): ReadonlySet<string> {
  return new Set(readRaw());
}

/**
 * Adds a single peer pubkey to the ever-known set.
 *
 * - Lowercases the input before storing (AC-EVER-1).
 * - Idempotent: re-adding an existing peer does not grow the set (AC-EVER-1).
 * - Silent no-op on empty string, null, or undefined input (AC-EVER-3).
 * - Never throws.
 *
 * Callers MUST filter out their own pubkey before calling this function
 * (AC-EVER-2). The module itself does not know the caller's own pubkey.
 */
export function rememberKnownPeer(peerHex: string): void {
  // AC-EVER-3: silent no-op on falsy / empty input
  if (!peerHex) return;
  try {
    const lower = peerHex.toLowerCase();
    const existing = readRaw();
    if (existing.includes(lower)) return; // idempotent
    writeRaw([...existing, lower]);
  } catch {
    // Never throw — AC-EVER-3
  }
}

/**
 * Bulk-adds multiple peer pubkeys to the ever-known set in a single write.
 *
 * - Lowercases each input before storing.
 * - Idempotent: entries already present are not duplicated.
 * - Silent no-op on empty array or empty/falsy individual entries.
 * - Never throws.
 *
 * Callers MUST filter out their own pubkey from `peerHexes` before calling.
 */
export function rememberKnownPeers(peerHexes: ReadonlyArray<string>): void {
  if (!peerHexes || peerHexes.length === 0) return;
  try {
    const existing = new Set(readRaw());
    let changed = false;
    for (const hex of peerHexes) {
      if (!hex) continue;
      const lower = hex.toLowerCase();
      if (!existing.has(lower)) {
        existing.add(lower);
        changed = true;
      }
    }
    if (changed) {
      writeRaw(Array.from(existing));
    }
  } catch {
    // Never throw
  }
}

/**
 * Returns true when the given peer pubkey (case-insensitive) is in the
 * ever-known set.
 */
export function isKnownPeer(peerHex: string): boolean {
  if (!peerHex) return false;
  try {
    const lower = peerHex.toLowerCase();
    return readRaw().includes(lower);
  } catch {
    return false;
  }
}

/**
 * Returns true when the S3 migration backfill has completed for this device.
 */
export function knownPeersMigrationComplete(): boolean {
  if (!isLocalStorageAvailable()) return false;
  try {
    return localStorage.getItem(KNOWN_PEERS_MIGRATED_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Marks the S3 migration backfill as complete on this device.
 */
export function markKnownPeersMigrationComplete(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(KNOWN_PEERS_MIGRATED_KEY, '1');
  } catch {
    // Non-fatal
  }
}

