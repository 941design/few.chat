/**
 * Pending-invitation retention (D14, AC-CAP-1): 256 in total, 8 per inviter, trust-ordered, with a 14-day TTL for
 * strangers. The numbers 256 / 8 are the constants of `lib/pendingInvitations.ts` (re-exported, never re-typed), so
 * the old and the new limit cannot drift.
 *
 * `applyPendingCaps` is a pure split of a pending list into the RETAINED set and the EXCESS to decline. A sponsor is
 * TRUSTED iff the injected predicate says so (production: own account or an ever-known peer, which includes
 * contacts, see `createTrustedSponsorPredicate`); otherwise it is a STRANGER. Rules, in order:
 *
 *  1. TTL: a stranger invitation older than `STRANGER_INVITATION_TTL_MS` (strictly more than 14 days before `now`)
 *     is excess; a trusted invitation never expires.
 *  2. Per inviter: the 8 oldest are kept (already shown ones first, see `keepFirst`), the 9th and later are excess.
 *     Only entries that survive rule 1 count.
 *  3. Total: of the remainder at most 256 are kept, ranked trusted before stranger, then already shown before new,
 *     then oldest first (`receivedAt`, ties by id). So a stranger flood can never lock out a trusted invitation: a
 *     trusted arrival into a full list displaces the newest retained stranger.
 *
 * `keepFirst` (the ids currently shown) gives retention stability: within its trust class an already shown
 * invitation is never displaced by a later arrival, whatever that arrival's `receivedAt` (clock steps).
 * The result does not depend on the input order, and applying it to its own retained set (same `now`) yields no
 * excess (idempotent). `retained` is sorted oldest first.
 */
const GLOBAL_CAP = 256;
const PER_INVITER_CAP = 8;
import { isKnownPeer } from '@/src/lib/knownPeers';

/** Most pending invitations kept in total. */
export const PENDING_TOTAL_CAP: number = GLOBAL_CAP;
/** Most pending invitations kept per inviter (sponsor account). */
export const PENDING_PER_INVITER_CAP: number = PER_INVITER_CAP;
/** A stranger's invitation expires when it is strictly older than this (14 days). Trusted ones never expire. */
export const STRANGER_INVITATION_TTL_MS = 14 * 86_400_000;

/** The fields the cap needs of an invitation. */
interface CappedInvitation {
  id: string;
  sponsorAccount: string;
  receivedAt: number;
}

interface CapLimits {
  total: number;
  perInviter: number;
}

const DEFAULT_CAP_LIMITS: CapLimits = { total: PENDING_TOTAL_CAP, perInviter: PENDING_PER_INVITER_CAP };

export interface CapContext {
  /** True iff the sponsor (lowercase hex) is trusted. Evaluated once per invitation per call. */
  isTrusted: (sponsorAccount: string) => boolean;
  /** Current time, ms. */
  now: number;
  /** Ids currently shown: ranked ahead of new entries of the same trust class. */
  keepFirst?: ReadonlySet<string>;
  limits?: CapLimits;
  ttlMs?: number;
}

interface CapSplit<T> {
  /** Kept, oldest first. */
  retained: T[];
  /** To be declined (expired strangers, per-inviter and total excess). */
  excess: T[];
}

/**
 * The production trust predicate: the own account or an ever-known peer (`isKnownPeer`, which includes manually
 * added contacts). Reads the known-peer set on every call (no cache), case-insensitive.
 */
export function createTrustedSponsorPredicate(
  ownPubkey: string,
  known: (pubkey: string) => boolean = isKnownPeer,
): (sponsorAccount: string) => boolean {
  if (typeof ownPubkey !== 'string' || ownPubkey === '') {
    throw new TypeError('createTrustedSponsorPredicate: "ownPubkey" is required');
  }
  const own = ownPubkey.toLowerCase();
  return (sponsor) => {
    const lower = sponsor.toLowerCase();
    return lower === own || known(lower);
  };
}

const byAge = (a: CappedInvitation, b: CappedInvitation) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function applyPendingCaps<T extends CappedInvitation>(list: readonly T[], ctx: CapContext): CapSplit<T> {
  const limits = ctx.limits ?? DEFAULT_CAP_LIMITS;
  const ttl = ctx.ttlMs ?? STRANGER_INVITATION_TTL_MS;
  const shown = ctx.keepFirst ?? new Set<string>();
  const excess: T[] = [];

  const entries: Array<{ inv: T; trusted: boolean; kept: boolean }> = [];
  for (const inv of list) {
    const trusted = ctx.isTrusted(inv.sponsorAccount.toLowerCase());
    if (!trusted && ctx.now - inv.receivedAt > ttl) {
      excess.push(inv);
      continue;
    }
    entries.push({ inv, trusted, kept: shown.has(inv.id) });
  }
  const byRetention = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    Number(b.kept) - Number(a.kept) || byAge(a.inv, b.inv);

  const perInviter = new Map<string, number>();
  const withinInviter: typeof entries = [];
  for (const e of [...entries].sort(byRetention)) {
    const key = e.inv.sponsorAccount.toLowerCase();
    const used = perInviter.get(key) ?? 0;
    if (used >= limits.perInviter) {
      excess.push(e.inv);
      continue;
    }
    perInviter.set(key, used + 1);
    withinInviter.push(e);
  }

  const ranked = withinInviter.sort((a, b) => Number(b.trusted) - Number(a.trusted) || byRetention(a, b));
  const retained = ranked.slice(0, limits.total).map((e) => e.inv);
  for (const e of ranked.slice(limits.total)) excess.push(e.inv);
  return { retained: retained.sort(byAge), excess };
}
