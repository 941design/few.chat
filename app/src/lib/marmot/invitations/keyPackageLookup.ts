/**
 * Invitee key-package lookup (D10, AC-KP-2 / AC-KP-3). Read-only: it publishes nothing.
 *
 * The inviter must find a key package the invitee published on a relay the inviter does not use
 * (commit aa39de3). The library has no public fetch, so the app asks itself through
 * `transport.requestWithDeadline`:
 *
 *   1. relay discovery on the app defaults: the invitee's newest kind-10050 (`relay` tags) and kind-10002
 *      (write set); a discovery that times out or fails simply contributes no relays (the defaults still
 *      cover the common case) and never fails the lookup;
 *   2. the key-package request `{kinds:[30443], authors:[pk]}` over the de-duplicated UNION of the 10050
 *      relays, the 10002 write relays and the app defaults.
 *
 * Relay URL policy (relayUrlPolicy.ts): the app's own defaults are used as given (the user configured them,
 * `ws://umbrel.local:4848` included); the invitee controls both lists, so every ADVERTISED URL must be wss://,
 * credential-free and name a public DNS host (no loopback / private / link-local / `.local` / bare IP), and at
 * most `MAX_ADVERTISED_RELAYS` per list are used: a hostile list cannot make the inviter open sockets onto
 * its LAN or an unbounded number of them. `allowLocalAdvertised` (tests only) lifts the host rule. Nothing but
 * these REQs reaches an advertised relay; no profile data is sent (privacy invariant). Sockets the shared pool opens to
 * advertised relays may stay open after the lookup (no close hook: closing by URL could end the inviter's own
 * live subscriptions on a shared relay URL).
 *
 * Every relay-supplied event is re-checked before it is a candidate: relays may send anything under a
 * subscription id and the transport does not re-apply the filter. Cheap checks (kind, author, id format,
 * duplicate id) run first; the signature is verified newest-first and only until `MAX_KEY_PACKAGE_CANDIDATES`
 * events verified, so a flood of junk costs neither a verification each nor an unbounded candidate list.
 * `group.invite` re-validates the key package itself.
 *
 * `keyPackages.observe` is deliberately not used (a live subscription cannot report "none found").
 *
 * Pure module: no React, no client construction; the transport and defaults are injected and validated at
 * construction.
 */
import type { NostrEvent } from '@941design/nostr-events/event';
import type { TransportContract } from '@941design/nostr-events/transport/contract';
import { parseDmRelayList10050, parseRelayList10002 } from '@941design/nostr-events/parsers';
import { verifyEvent as verifyNostrEvent } from 'nostr-tools/pure';
import { normaliseAdvertisedRelayUrl, normaliseRelayUrl } from './relayUrlPolicy';

export { normaliseAdvertisedRelayUrl, normaliseRelayUrl };

/** Addressable key-package kind published by the library client. */
export const KEY_PACKAGE_KIND = 30443;
export const INBOX_RELAY_LIST_KIND = 10050;
export const NIP65_RELAY_LIST_KIND = 10002;
/** Per list (10050 and 10002 write set): how many invitee-advertised relays are used. */
export const MAX_ADVERTISED_RELAYS = 3;
/** Deadline of each of the two requests (relay discovery, key packages). */
export const KEY_PACKAGE_LOOKUP_TIMEOUT_MS = 8_000;

/** Candidates kept (newest first) and the `limit` of the key-package filter: a hostile relay cannot make the invite walk an unbounded list. */
export const MAX_KEY_PACKAGE_CANDIDATES = 6;
/** Largest delay `setTimeout` honours; a longer `timeoutMs` would fire at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const HEX64 = /^[0-9a-f]{64}$/;

export type KeyPackageLookupResult =
  /** `candidates` are verified kind-30443 events of the invitee, in invite order, at most `MAX_KEY_PACKAGE_CANDIDATES` (never empty). */
  | { ok: true; candidates: NostrEvent[]; relays: string[] }
  /** No usable event: `reason` tells EOSE-with-nothing ('none-found') from the deadline ('timed-out'). */
  | { ok: false; reason: 'none-found' | 'timed-out'; relays: string[] };

export interface KeyPackageLookup {
  lookup: (pubkey: string, opts?: { signal?: AbortSignal }) => Promise<KeyPackageLookupResult>;
}

export interface KeyPackageLookupDeps {
  /** Only `requestWithDeadline` is used. */
  transport: Pick<TransportContract, 'requestWithDeadline'>;
  /** The app's configured relays (the library defaults), used as given; at least one valid ws/wss URL. */
  defaultRelays: readonly string[];
  /** Deadline of each request, 1 .. 2^31-1 ms; default `KEY_PACKAGE_LOOKUP_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** TESTS ONLY: accept invitee-advertised ws:// / loopback / private hosts (credentials stay refused). Default false. */
  allowLocalAdvertised?: boolean;
  /** Signature + id check; default: nostr-tools `verifyEvent`. Must not be a no-op. */
  verifyEvent?: (event: NostrEvent) => boolean;
}

/** created_at descending; equal created_at: lexicographically lower event id first (AC-KP-3). Pure; input untouched. */
export function orderKeyPackageCandidates(events: readonly NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function newest(events: readonly NostrEvent[]): NostrEvent | undefined {
  return orderKeyPackageCandidates(events)[0];
}

export function createKeyPackageLookup(deps: KeyPackageLookupDeps): KeyPackageLookup {
  if (!deps || typeof deps !== 'object') throw new TypeError('createKeyPackageLookup: deps are required');
  if (!deps.transport || typeof deps.transport.requestWithDeadline !== 'function') {
    throw new TypeError('createKeyPackageLookup: required dependency "transport.requestWithDeadline" is missing');
  }
  const defaults = [...new Set((Array.isArray(deps.defaultRelays) ? deps.defaultRelays : []).map(normaliseRelayUrl).filter((u): u is string => u !== null))];
  if (defaults.length === 0) throw new TypeError('createKeyPackageLookup: "defaultRelays" must list at least one valid relay');
  const timeoutMs = deps.timeoutMs ?? KEY_PACKAGE_LOOKUP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`createKeyPackageLookup: timeoutMs must be a positive number of at most ${String(MAX_TIMEOUT_MS)}`);
  }
  const verify = deps.verifyEvent ?? verifyNostrEvent;
  const allowLocal = deps.allowLocalAdvertised === true;
  const { transport } = deps;

  /** Cheap, signature-free checks: right kind, right author, well-formed id and timestamp. */
  const plausible = (e: NostrEvent, kind: number, pubkey: string): boolean =>
    !!e &&
    typeof e === 'object' &&
    e.kind === kind &&
    e.pubkey === pubkey &&
    typeof e.id === 'string' &&
    HEX64.test(e.id) &&
    typeof e.created_at === 'number' &&
    Number.isFinite(e.created_at);

  const signatureOk = (e: NostrEvent): boolean => {
    try {
      return verify(e) === true;
    } catch {
      return false;
    }
  };

  /**
   * Up to `max` verified events of the invitee, newest first (AC-KP-3 order): plausibility and de-duplication
   * before any signature check, then verification in order until `max` passed.
   */
  const verifiedNewest = (events: readonly NostrEvent[], kind: number, pubkey: string, max: number): NostrEvent[] => {
    const byId = new Map<string, NostrEvent>();
    for (const e of events) if (plausible(e, kind, pubkey) && !byId.has(e.id)) byId.set(e.id, e);
    const out: NostrEvent[] = [];
    for (const e of orderKeyPackageCandidates([...byId.values()])) {
      if (signatureOk(e)) out.push(e);
      if (out.length >= max) break;
    }
    return out;
  };

  /** The invitee's advertised relays (10050 relays, then 10002 write relays), policy-checked and capped. Never throws except on abort. */
  async function advertisedRelays(pubkey: string, signal?: AbortSignal): Promise<string[]> {
    let events: NostrEvent[];
    try {
      const res = await transport.requestWithDeadline(
        defaults,
        [
          { kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey] },
          { kinds: [NIP65_RELAY_LIST_KIND], authors: [pubkey] },
        ],
        { timeoutMs, signal },
      );
      events = Array.isArray(res?.events) ? res.events : [];
    } catch (error) {
      if (signal?.aborted) throw error;
      return []; // discovery is best-effort: the defaults still cover the common case
    }
    const take = (urls: readonly string[]): string[] => {
      const out: string[] = [];
      for (const raw of urls) {
        const url = normaliseAdvertisedRelayUrl(raw, { allowLocal });
        if (url && !out.includes(url)) out.push(url);
        if (out.length >= MAX_ADVERTISED_RELAYS) break;
      }
      return out;
    };
    const inbox = verifiedNewest(events, INBOX_RELAY_LIST_KIND, pubkey, 1)[0];
    const nip65 = verifiedNewest(events, NIP65_RELAY_LIST_KIND, pubkey, 1)[0];
    // Parsers throw on a wrong kind only; kind was checked above, malformed tags are skipped by them.
    return [...take(inbox ? parseDmRelayList10050(inbox).relay : []), ...take(nip65 ? parseRelayList10002(nip65).write : [])];
  }

  return {
    async lookup(pubkey, opts = {}) {
      if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) throw new TypeError('keyPackageLookup.lookup: pubkey must be a 64-char lower-case hex string');
      const advertised = await advertisedRelays(pubkey, opts.signal);
      const relays = [...new Set([...advertised, ...defaults])];
      const res = await transport.requestWithDeadline(
        relays,
        { kinds: [KEY_PACKAGE_KIND], authors: [pubkey], limit: MAX_KEY_PACKAGE_CANDIDATES },
        { timeoutMs, signal: opts.signal },
      );
      const candidates = verifiedNewest(Array.isArray(res?.events) ? res.events : [], KEY_PACKAGE_KIND, pubkey, MAX_KEY_PACKAGE_CANDIDATES);
      if (candidates.length === 0) return { ok: false, reason: res?.timedOut ? 'timed-out' : 'none-found', relays };
      return { ok: true, candidates, relays };
    },
  };
}
