/**
 * blockedPeers.ts — Block-set derivation and pure block predicate.
 *
 * Epic: block-contact, story S1 ("block core: predicate, composite gate,
 * block-set derivation, re-add guard").
 *
 * Block is a cross-cutting DENY layer over the EXISTING contacts store, not a
 * new module owning a new data store (DD-1): `StoredContact.archivedAt` in
 * `lp_contacts_v1` remains the sole source of truth for "blocked". This
 * module introduces no new persistence key — it derives a read-only
 * `blockedPeers` set from `readStoredContacts()` (`contacts.ts`) and exposes
 * a pure predicate over that set.
 *
 * `isBlockedPeer` mirrors `isAllowedDmSender`'s purity discipline
 * (`walledGarden.ts`, AC-SEC-13): synchronous, no localStorage/IDB/React
 * access in its own body, reads exclusively from its two parameters.
 *
 * DD-8: the composite gate is
 *
 *     isAllowedDmSender(peerHex, groups, knownPeers, ownPubkeyHex)
 *       && !isBlockedPeer(peerHex, blockedPeers)
 *
 * exported below as `isAllowedDmSenderComposite`, the single shared
 * definition consumed by every enforcement call site (S2's notification
 * watcher, S4's ContactChat/contacts page). Only this composite function
 * imports `walledGarden.ts` — `isBlockedPeer` itself is never called from
 * inside `isAllowedDmSender`'s body, and `isAllowedDmSender` never imports
 * this module. Deny wins over allow, but the two predicates stay
 * independently defined and independently testable; the composition is a
 * lib→lib dependency owned in exactly one place so it cannot fork across
 * call sites.
 */

import type { Group } from '@/src/types';
import { readStoredContacts } from '@/src/lib/contacts';
import { isAllowedDmSender } from '@/src/lib/walledGarden';

/**
 * Derives the current block-set: the lowercase-hex pubkeys of every
 * `StoredContact` in `readStoredContacts()` whose `archivedAt` is non-null
 * (AC-CORE-2).
 *
 * Defensively lowercase-normalizes every candidate (AC-CORE-6) rather than
 * assuming `StoredContact.pubkeyHex` (or the underlying `lp_contacts_v1` key)
 * is already lowercase. Stored contacts are lowercase only via a transitive
 * guarantee upstream (pubkeys are minted lowercase by the code paths that
 * write them), not an explicit contract this reader can rely on — a contact
 * seeded under a mixed-case key must still be represented here in lowercase
 * form.
 *
 * Pure derivation, re-read from localStorage on every call — no caching.
 * Callers on a live/reactive surface re-derive on MarmotContext's
 * `blockedPeersRevision` bump (mirroring the existing `loadKnownPeers()` +
 * `knownPeersRevision` pattern), rather than this module holding any
 * subscription state itself.
 *
 * @returns A `ReadonlySet<string>` of lowercase-hex pubkeys. Empty when no
 *   contact is archived, or when `readStoredContacts()` itself returns
 *   nothing (e.g. SSR / storage unavailable — see `contacts.ts`'s own guard).
 */
export function loadBlockedPeers(): ReadonlySet<string> {
  const contacts = readStoredContacts();
  const blocked = new Set<string>();
  for (const contact of Object.values(contacts)) {
    if (contact.archivedAt != null) {
      blocked.add(contact.pubkeyHex.toLowerCase());
    }
  }
  return blocked;
}

/**
 * Determines whether `peerHex` is a blocked peer.
 *
 * @param peerHex      - Hex pubkey of the candidate peer. May be any case.
 * @param blockedPeers - The current block-set, as produced by
 *                       {@link loadBlockedPeers}. Its members are expected to
 *                       already be lowercase-hex, but this function does not
 *                       depend on that — it lowercases `peerHex` itself
 *                       before comparing (AC-CORE-6).
 *
 * @returns `true` iff `peerHex` is non-empty and its lowercased form is a
 *   member of `blockedPeers`; `false` for an empty `peerHex` or for a peer
 *   absent from the set (AC-CORE-1).
 *
 * AC-CORE-1 / AC-CORE-4: this function reads exclusively from its two
 * parameters — no `localStorage`, IDB, or React access occurs inside this
 * body. It is exported as a function fully separate from
 * `isAllowedDmSender`; neither predicate calls the other (DD-8). The
 * composite `isAllowedDmSender(...) && !isBlockedPeer(...)` is assembled only
 * at call sites, never inside either predicate's body.
 */
export function isBlockedPeer(peerHex: string, blockedPeers: ReadonlySet<string>): boolean {
  if (!peerHex) return false;
  return blockedPeers.has(peerHex.toLowerCase());
}

/**
 * The composite DM-sender gate (epic: block-contact, DD-8): `isAllowedDmSender`
 * stays pure and untouched (AC-SEC-13) — the block predicate is composed here,
 * in exactly one shared place, never inside `isAllowedDmSender`'s own body.
 * Deny (blocked) overrides allow (shares a group / is a known peer).
 *
 * This is the SINGLE definition of the composite gate. Every enforcement call
 * site (the notification watcher, `ContactChat`, the contacts page) imports
 * this function rather than re-deriving `isAllowedDmSender(...) &&
 * !isBlockedPeer(...)` inline — re-implementing the composition at a second
 * call site would let the invariant fork silently across call sites.
 *
 * Exported as a plain pure function (no React) so it is independently unit-
 * testable without jsdom/renderHook, per this repo's testing convention.
 */
export function isAllowedDmSenderComposite(
  peer: string,
  groups: ReadonlyArray<Pick<Group, 'memberPubkeys'>>,
  knownPeers: ReadonlySet<string>,
  blockedPeers: ReadonlySet<string>,
  ownPubkeyHex: string,
): boolean {
  return isAllowedDmSender(peer, groups, knownPeers, ownPubkeyHex) && !isBlockedPeer(peer, blockedPeers);
}
