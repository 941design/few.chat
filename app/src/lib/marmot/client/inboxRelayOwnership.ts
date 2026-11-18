import { isNostrEvent, safeVerifyEvent, type NostrEvent } from '@941design/nostr-events/event';
import type { TransportContract } from '@941design/nostr-events/transport/contract';

export const INBOX_RELAY_LIST_KIND = 10050;
export const INBOX_RELAY_LIST_CLIENT = 'few';
export const FOREIGN_INBOX_RELAY_LIST_PREFIX = 'lp_marmotForeignInboxRelayList:';
const LEGACY_DISCOVERY_PREFIX = 'lp_marmotInboxDiscovery:';
const LEGACY_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_LEGACY_SOURCES = 16;

export function isForeignInboxRelayList(event: NostrEvent): boolean {
  return !event.tags.some(([name, value]) => name === 'client' && value === INBOX_RELAY_LIST_CLIENT);
}

function verifiedRelayList(event: unknown, accountPubkey: string, expectedKind: number): NostrEvent | undefined {
  if (!isNostrEvent(event) || event.kind !== expectedKind || event.pubkey !== accountPubkey) return undefined;
  // Recompute verification on the signed fields even if the source memoized an earlier result.
  const { id, pubkey, kind, created_at, tags, content, sig } = event;
  const signed = { id, pubkey, kind, created_at, tags, content, sig };
  return safeVerifyEvent(signed) ? signed : undefined;
}

export function latestVerifiedRelayList(pubkey: string, kind: number, events: readonly NostrEvent[], latest?: NostrEvent): NostrEvent | undefined {
  for (const event of events) {
    const verified = verifiedRelayList(event, pubkey, kind);
    if (verified && (!latest || verified.created_at > latest.created_at ||
        (verified.created_at === latest.created_at && verified.id < latest.id))) {
      latest = verified;
    }
  }
  return latest;
}

function readForeignList(key: string, pubkey: string): NostrEvent | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return undefined;
    const event = verifiedRelayList(JSON.parse(raw), pubkey, INBOX_RELAY_LIST_KIND);
    if (event && isForeignInboxRelayList(event)) return event;
  } catch {
    // Storage can be unavailable or contain malformed JSON.
  }
}

/** Keep the newest observed owner for this session and retain foreign ownership across reloads. */
export function createInboxRelayOwnership(pubkey: string, isActive: () => boolean = () => true) {
  const key = FOREIGN_INBOX_RELAY_LIST_PREFIX + pubkey;
  let latest = readForeignList(key, pubkey);
  return (events: readonly NostrEvent[]): NostrEvent | undefined => {
    const winner = latestVerifiedRelayList(pubkey, INBOX_RELAY_LIST_KIND, events, latest);
    if (!winner || winner === latest || !isActive()) return latest;
    latest = winner;
    try {
      if (isForeignInboxRelayList(winner)) {
        globalThis.localStorage?.setItem(key, JSON.stringify(winner));
      } else {
        globalThis.localStorage?.removeItem(key);
      }
    } catch {
      // Keep using the verified winner in memory if storage is unavailable.
    }
    return winner;
  };
}

function relayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^wss?:\/\//.test(value.trim())) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.hash) {
      return url.href;
    }
  } catch {
    // Ignore malformed entries without losing other valid legacy relays.
  }
}

/** A persisted attempt marker suppresses automatic probing even across reloads. */
export function createLegacyInboxDiscovery(
  pubkey: string, currentRelays: readonly string[], previousRelays: readonly string[] = [],
) {
  const key = LEGACY_DISCOVERY_PREFIX + pubkey;
  const current = new Set(currentRelays.map(relayUrl));
  let attempted = false;
  let storedSources: unknown;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    storedSources = value;
    if (value && typeof value === 'object' && 'attempted' in value && value.attempted === true && 'relays' in value) {
      attempted = true;
      storedSources = value.relays;
    }
  } catch {
    // Malformed or inaccessible legacy state must not prevent startup.
  }
  const sourceUrls = new Map<string, string>();
  const stored = Array.isArray(storedSources) ? storedSources : [];
  for (const source of [...stored, ...previousRelays]) {
    const url = relayUrl(source);
    if (url && typeof source === 'string') sourceUrls.set(url, source.trim());
  }
  let sources = [...sourceUrls.values()];
  let relays = [...sourceUrls].filter(([url]) => !current.has(url)).map(([, source]) => source);
  return {
    get pending() { return relays.length > 0; },
    async discover(
      transport: TransportContract,
      observe: (events: readonly NostrEvent[]) => NostrEvent | undefined,
      isActive: () => boolean,
      explicit: boolean,
      signal?: AbortSignal,
    ) {
      if (!sources.length || !isActive() || signal?.aborted) return;
      const clear = () => {
        if (!isActive() || signal?.aborted) return;
        try {
          globalThis.localStorage?.removeItem(key);
          sources = relays = [];
        } catch {
          // Keep the pending state if the proof could not be committed.
        }
      };
      if (!relays.length) return clear();
      if (attempted && !explicit) return;
      if (!attempted || previousRelays.length) {
        attempted = true;
        try {
          globalThis.localStorage.setItem(key, JSON.stringify({ attempted: true, relays: sources }));
        } catch {
          if (!explicit) return;
        }
      }
      // An empty historical result is conclusive only after every source returns EOSE.
      const targets = explicit ? relays : relays.slice(0, MAX_LEGACY_SOURCES);
      const result = await transport.requestWithDeadline(targets,
        { kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey], limit: 1 },
        { timeoutMs: LEGACY_LOOKUP_TIMEOUT_MS, signal });
      if (!isActive() || signal?.aborted) return;
      const winner = observe(result.events);
      if (result.timedOut || targets.length < relays.length) return;
      // Keep the original sources if a foreign owner could not be saved for the next startup.
      if (winner && isForeignInboxRelayList(winner) &&
          readForeignList(FOREIGN_INBOX_RELAY_LIST_PREFIX + pubkey, pubkey)?.id !== winner.id) return;
      clear();
    },
  };
}
