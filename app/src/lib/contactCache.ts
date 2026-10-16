/**
 * contactCache.ts — Global localStorage cache of known contact profiles.
 *
 * Stores nickname + avatar for contacts seen via MLS profile messages,
 * so group member lists can show names immediately even before the
 * per-group profile sync has completed.
 */

import type { ProfileAvatar } from '@/src/types';
import { STORAGE_KEYS } from '@/src/types';
import { isStorageAvailable } from '@/src/lib/storage';
import { rememberContact } from '@/src/lib/contacts';
import { postStoreChanged } from '@/src/lib/crossTab';
import { sanitizeStoredAvatar } from '@/src/lib/dmProfile/kinds';

export type CachedContact = {
  nickname: string;
  avatar: ProfileAvatar | null;
  updatedAt: string;
};

type ContactCacheMap = Record<string, CachedContact>;

export function readContactCache(): ContactCacheMap {
  if (!isStorageAvailable()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contactCache);
    return sanitizeContactCacheAvatars(raw ? JSON.parse(raw) : null) as ContactCacheMap;
  } catch {
    return {};
  }
}

/**
 * Bug stored-group-avatars-not-resanitized: entries cached before the
 * avatar-URL check are re-validated on every read with the shared validator —
 * an unsafe avatar becomes `null`, nickname/updatedAt are kept. A non-object
 * cache reads as empty. contacts.ts#readContactCacheSnapshot applies the same
 * rule (it cannot import this module: contactCache imports contacts).
 */
function sanitizeContactCacheAvatars(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => [
      key,
      entry && typeof entry === 'object'
        ? { ...(entry as CachedContact), avatar: sanitizeStoredAvatar((entry as CachedContact).avatar) }
        : entry,
    ]),
  );
}

/** Upsert a contact using LWW by updatedAt. */
export function writeContactEntry(pubkeyHex: string, contact: CachedContact): void {
  if (!isStorageAvailable()) return;
  try {
    const cache = readContactCache();
    const existing = cache[pubkeyHex];
    if (existing && existing.updatedAt >= contact.updatedAt) return;
    cache[pubkeyHex] = contact;
    localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify(cache));
    postStoreChanged('contacts');
    rememberContact(pubkeyHex, contact.updatedAt);
  } catch {
    // silent — storage may be full
  }
}

/**
 * Reads back a cache entry, case-folding `pubkeyHex` before the lookup
 * (Stage-1 review, sev 3, epic: direct-contact-profile-exchange story 04):
 * `writeContactEntryNeutralized` already lowercases the key it writes under,
 * so a caller reading with a mixed-case string previously MISSED a real
 * entry — a live hazard for story 07's `importCard` reuse of the neutralized
 * write. Folding here makes the read/write pair symmetric and removes the
 * reliance on every caller already passing lowercase (architecture.md's
 * defensive-folding rule). Safe for existing callers, which already pass
 * lowercase per the transitive guarantee this just stops relying on.
 */
export function readContactEntry(pubkeyHex: string): CachedContact | undefined {
  return readContactCache()[pubkeyHex.toLowerCase()];
}

// ── Neutralized write primitive (epic: direct-contact-profile-exchange, story 04) ──

/**
 * Result of {@link writeContactEntryNeutralized}. See that function's doc for
 * the exact semantics of each field — `landed` is a COMBINED predicate
 * (LWW-won AND non-null resulting avatar), not merely "a write happened";
 * `lwwWon` and `avatarNonNull` are the two raw components a caller needs to
 * distinguish "LWW lost / idempotent repeat" from "LWW won but the avatar is
 * still empty" (dmProfile/scheduler.ts#isCompletingAnnounce takes exactly
 * these two booleans separately).
 */
export type WriteContactEntryResult = {
  /**
   * True iff THIS call's write passed LWW (`existing.updatedAt <
   * contact.updatedAt`, lexicographic ISO-8601 compare, or no existing entry
   * at all) AND the entry now on file for `pubkeyHex` has a non-null avatar.
   * This is the exact "completing write" definition (spec.md §3.2/AC-PROF-6)
   * — NOT merely "a write happened" (VQ-S04-013).
   */
  landed: boolean;
  /** True iff this call's LWW comparison won and the write was actually persisted. False when a stale/equal-or-older payload was rejected — any existing entry is left completely untouched. */
  lwwWon: boolean;
  /** True iff the entry now on file for `pubkeyHex` (whichever value that is — just-written or pre-existing) has a non-null avatar. */
  avatarNonNull: boolean;
};

/**
 * Upsert a contact using the SAME LWW predicate as {@link writeContactEntry}
 * (`existing.updatedAt >= contact.updatedAt` rejects the incoming write),
 * but WITHOUT that function's `rememberContact` side effect, and reporting
 * whether the write actually landed instead of returning `void`.
 *
 * This is the neutralized cache-write primitive spec.md §3.5 requires for
 * the profile-announce receive path (epic: direct-contact-profile-exchange,
 * story 04, AC-PROF-4): `writeContactEntry`'s unconditional `rememberContact`
 * call silently creates a new `lp_contacts_v1` entry for ANY sender, which is
 * exactly the contact-injection vector the announce-accept gate must close.
 * This function never creates a contact — a caller that wants "accept only
 * from an already-existing contact" enforces that gate itself (as
 * `dmProfile/receive.ts` does) before ever calling this.
 *
 * Deliberately does NOT change `writeContactEntry` itself, nor any of its
 * existing callers (group profile sync via `MarmotContext.tsx`, card import
 * via `contactCardImport.ts`) — this is a new, additive function living
 * alongside it. Shared with story 07's `pairingAck.ts` §10.1 fix, which
 * reuses this primitive rather than re-implementing LWW or contact-injection
 * neutralization.
 *
 * Defensively lowercases `pubkeyHex` before both the read and the write
 * (architecture.md: "pubkey map-keys are case-folded defensively at every
 * read/write site") rather than relying on the caller to have already
 * folded it.
 *
 * Idempotent (AC-PROF-10): calling this twice with the identical `contact`
 * payload leaves the cache in the same state as calling it once — the
 * second call's `existing.updatedAt` equals `contact.updatedAt`, which is
 * not `<` it, so `lwwWon` is `false` and no write occurs.
 *
 * Silently reports an all-`false` result (never throws) when localStorage
 * is unavailable or a write attempt throws (e.g. quota exceeded) — matching
 * `writeContactEntry`'s existing silent-failure posture. A thrown write
 * attempt means the entry was NOT durably persisted, so `landed`/`lwwWon`
 * must not claim it was.
 */
export function writeContactEntryNeutralized(pubkeyHex: string, contact: CachedContact): WriteContactEntryResult {
  const key = pubkeyHex.toLowerCase();
  if (!isStorageAvailable()) {
    return { landed: false, lwwWon: false, avatarNonNull: false };
  }
  try {
    const cache = readContactCache();
    const existing = cache[key];
    const lwwWon = !existing || existing.updatedAt < contact.updatedAt;
    if (lwwWon) {
      cache[key] = contact;
      localStorage.setItem(STORAGE_KEYS.contactCache, JSON.stringify(cache));
      postStoreChanged('contacts');
      // Deliberately NO rememberContact call here — the neutralized primitive.
    }
    const finalEntry = lwwWon ? contact : existing;
    const avatarNonNull = Boolean(finalEntry?.avatar);
    return { landed: lwwWon && avatarNonNull, lwwWon, avatarNonNull };
  } catch {
    // silent — storage may be full; the write did not land, report accordingly
    return { landed: false, lwwWon: false, avatarNonNull: false };
  }
}
