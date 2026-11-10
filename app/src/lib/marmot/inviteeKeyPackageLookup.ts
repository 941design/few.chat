/**
 * Invitee KeyPackage lookup (bug invite-lookup-ignores-invitee-s-keypackage).
 *
 * The inviter used to look for the invitee's KeyPackage on its own relay pool
 * only. The invitee may have published it on relays it advertises (kind 30051
 * d=marmot — what Few publishes — or kind 10051 — what other Marmot clients
 * publish) that the inviter does not use. This module resolves that relay list
 * from the pool and also asks those relays for the KeyPackage.
 *
 * Dependency-injected (no NDK import) so it is unit-testable without jsdom.
 * Scope: lookup only. It publishes nothing, never writes the saved relay
 * setting, and has NO side effect on the NDK pool: advertised relays are asked
 * over their own one-shot socket (deps.fetchListed), never added to the pool,
 * so they cannot be shared with, or disconnected under, other code. Only the
 * KeyPackage REQ is read from a listed relay; nothing but that REQ (and, in
 * the Welcome step elsewhere, the Welcome itself) is sent to it — no profile data.
 *
 * Every event it uses is signature-verified (deps.verifyEvent): the pool's
 * relays are only sampled by NDK and listed relays bypass NDK entirely.
 */
import { isValidRelayUrl } from '@/src/lib/relay';

export const KEY_PACKAGE_KINDS = [443, 30443];
/** Marmot relay-list kinds: Few's addressable list (d=marmot) and the generic list. */
export const RELAY_LIST_KIND_MARMOT = 30051;
export const RELAY_LIST_KIND_INBOX = 10051;
export const MARMOT_RELAY_LIST_D = 'marmot';
export const MAX_LISTED_RELAYS = 3;
/** Bound for a request to a relay the invitee merely advertises. */
export const LISTED_RELAY_TIMEOUT_MS = 5_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type LookupEvent = {
  id?: string;
  pubkey?: string;
  kind?: number;
  created_at?: number;
  tags?: unknown;
  content?: string;
  sig?: string;
};

export type LookupFetchResult<E extends LookupEvent> = {
  events: Iterable<E>;
  timedOut: boolean;
};

export type LookupFilter = { kinds: number[]; authors: string[]; limit?: number };

export type InviteeKeyPackageLookupDeps<E extends LookupEvent> = {
  /** Request to the NDK pool. */
  fetchPool(filter: LookupFilter, timeoutMs?: number): Promise<LookupFetchResult<E>>;
  /** One-shot request to a single advertised relay over its own socket (no pool). */
  fetchListed(url: string, filter: LookupFilter, timeoutMs: number): Promise<LookupFetchResult<E>>;
  /** Signature + id check. Must not throw; false = ignore the event. */
  verifyEvent(event: E): boolean;
  /** Relays the pool request already covers (read-only), e.g. pool urls + effective relays. */
  coveredRelayUrls(): string[];
};

export type InviteeKeyPackageLookupResult<E extends LookupEvent> =
  | { ok: true; events: E[] }
  | { ok: false; error: 'no_key_package' | 'timeout' };

/**
 * Normalise a listed relay URL: valid, wss:// (ws:// only on localhost), no
 * credentials, scheme+host lowercased, fragment and trailing slash dropped, query kept.
 * Returns null for anything else.
 */
export function normaliseListedRelayUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^wss?:\/\//i, (m) => m.toLowerCase());
  if (!isValidRelayUrl(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'ws:' && !LOCAL_HOSTS.has(u.hostname)) return null;
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  const path = u.pathname.replace(/\/+$/, '');
  // The query can select a distinct endpoint (e.g. an access token); the fragment never reaches the relay.
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

const tagsOf = (e: LookupEvent): string[][] =>
  Array.isArray(e.tags) ? (e.tags.filter((t) => Array.isArray(t)) as string[][]) : [];

/**
 * The invitee's advertised relays: kind 30051 d=marmot when the invitee
 * published one, else kind 10051. Only events authored by the invitee AND
 * passing `verify` count; the newest of the chosen kind wins. At most
 * MAX_LISTED_RELAYS valid URLs, in list order. Total: malformed events, tags
 * and values are skipped, never thrown.
 */
export function parseInviteeRelayList(
  events: Iterable<LookupEvent>,
  invitee: string,
  verify: (e: LookupEvent) => boolean,
): string[] {
  const mine = Array.from(events).filter((e) => {
    if (!e || e.pubkey !== invitee) return false;
    try {
      return verify(e) === true;
    } catch {
      return false;
    }
  });
  const newest = (xs: LookupEvent[]) =>
    xs.reduce<LookupEvent | undefined>(
      (best, e) => (!best || (e.created_at ?? 0) > (best.created_at ?? 0) ? e : best),
      undefined,
    );
  const marmot = newest(
    mine.filter(
      (e) =>
        e.kind === RELAY_LIST_KIND_MARMOT &&
        tagsOf(e).some((t) => t[0] === 'd' && t[1] === MARMOT_RELAY_LIST_D),
    ),
  );
  const chosen = marmot ?? newest(mine.filter((e) => e.kind === RELAY_LIST_KIND_INBOX));
  if (!chosen) return [];

  const out: string[] = [];
  for (const t of tagsOf(chosen)) {
    if (t[0] !== 'relay') continue;
    const url = normaliseListedRelayUrl(t[1]);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_LISTED_RELAYS) break;
  }
  return out;
}

/** Filter for the invitee's relay-list events (both kinds, pool-wide). */
export function relayListFilter(invitee: string) {
  return {
    kinds: [RELAY_LIST_KIND_MARMOT, RELAY_LIST_KIND_INBOX],
    authors: [invitee],
    limit: 10,
  };
}

const key = (url: string) => normaliseListedRelayUrl(url) ?? url.replace(/\/+$/, '');
/**
 * Pool keys come from NDK's normalizeRelayUrl, which appends '/' even after a
 * query (wss://r.x/?t=a -> wss://r.x/?t=a/). Strip that one slash before
 * normalising so a pooled relay matches its listed form.
 */
const poolKey = (url: string) => key(url.replace(/\/$/, ''));

/** Resolve the invitee's listed relays from the pool. Never throws; [] on failure. */
async function fetchListedRelays<E extends LookupEvent>(
  deps: InviteeKeyPackageLookupDeps<E>,
  invitee: string,
): Promise<{ relays: string[]; timedOut: boolean }> {
  try {
    const { events, timedOut } = await deps.fetchPool(relayListFilter(invitee));
    return { relays: parseInviteeRelayList(events, invitee, deps.verifyEvent as never), timedOut };
  } catch {
    return { relays: [], timedOut: false };
  }
}

export async function lookupInviteeKeyPackages<E extends LookupEvent>(
  deps: InviteeKeyPackageLookupDeps<E>,
  invitee: string,
): Promise<InviteeKeyPackageLookupResult<E>> {
  const filter: LookupFilter = { kinds: KEY_PACKAGE_KINDS, authors: [invitee], limit: 5 };
  // A usable KeyPackage: right kind, right author, valid signature. (Listed
  // relays bypass NDK's own filter matching and verification.)
  const usable = (e: E) => {
    if (!e || e.pubkey !== invitee || !KEY_PACKAGE_KINDS.includes(e.kind as number)) return false;
    try {
      return deps.verifyEvent(e) === true;
    } catch {
      return false;
    }
  };

  // Snapshot what the pool request will reach, synchronously, right before issuing it:
  // a relay that connects later never received this REQ and must not count as covered.
  let coveredAtRequest: Set<string>;
  try {
    coveredAtRequest = new Set(deps.coveredRelayUrls().map(poolKey));
  } catch {
    coveredAtRequest = new Set();
  }

  // The pool KeyPackage fetch starts at once; only the listed-relay requests wait
  // for the relay list, so a slow pool still reports `timeout` after one timeout.
  const poolP = deps.fetchPool(filter).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  // Relay list, then one raw request per listed relay the pool request does not
  // cover. Never rejects (so abandoning it below leaves nothing unhandled).
  const listedFlow = (async () => {
    const list = await fetchListedRelays(deps, invitee);
    const extra = list.relays.filter((u) => !coveredAtRequest.has(key(u)));
    const results = await Promise.all(
      extra.map((url) =>
        Promise.resolve()
          .then(() => deps.fetchListed(url, filter, LISTED_RELAY_TIMEOUT_MS))
          .catch(() => null),
      ),
    );
    return { list, results };
  })().catch(() => ({ list: { relays: [] as string[], timedOut: false }, results: [] as null[] }));

  const poolSettled = await poolP;
  // The pool fetch keeps its original failure semantics (a throw is the caller's `generic`).
  if ('error' in poolSettled) throw poolSettled.error;

  const dedupe = (events: Iterable<E>) => {
    const byId = new Map<string, E>();
    const anon: E[] = [];
    for (const e of events) {
      if (!usable(e)) continue;
      if (e.id) byId.set(e.id, e);
      else anon.push(e);
    }
    return [...byId.values(), ...anon];
  };

  // A usable KeyPackage from the pool is enough: do not make the invite wait for
  // an advertised relay that is slow or silent (those requests end by their own bound).
  const fromPool = dedupe(poolSettled.value.events);
  if (fromPool.length > 0) return { ok: true, events: fromPool };

  const { list, results } = await listedFlow;
  const found = dedupe(results.flatMap((r) => (r ? Array.from(r.events) : [])));
  if (found.length > 0) return { ok: true, events: found };
  const timedOut = list.timedOut || poolSettled.value.timedOut || results.some((r) => r?.timedOut);
  return { ok: false, error: timedOut ? 'timeout' : 'no_key_package' };
}
