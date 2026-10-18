/**
 * NdkNetworkAdapter — implements NostrNetworkInterface using NDK.
 *
 * This adapter bridges the marmot-ts network interface with the NDK relay pool.
 * It handles event publishing, single requests (fetch), and subscriptions.
 */

import type NDK from '@nostr-dev-kit/ndk';
import { NDKEvent, NDKFilter, NDKRelaySet, NDKSubscription } from '@nostr-dev-kit/ndk';
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
  Observer,
  Unsubscribable,
} from '@internet-privacy/marmot-ts';
import type { NostrEvent } from 'applesauce-core/helpers/event';
import type { Filter } from 'applesauce-core/helpers/filter';
import { getEffectiveRelays } from '@/src/lib/relay';
import { PUBLISH_TIMEOUT_MS } from '@/src/lib/ndkClient';

// applesauce Filter -> NDK Filter shape is compatible, cast directly
function toNdkFilter(filter: Filter | Filter[]): NDKFilter {
  // NDK accepts a single filter object; merge array into one if needed
  if (Array.isArray(filter)) {
    return Object.assign({}, ...filter) as NDKFilter;
  }
  return filter as unknown as NDKFilter;
}

function toNostrEvent(ndkEvent: NDKEvent): NostrEvent {
  return {
    id: ndkEvent.id ?? '',
    pubkey: ndkEvent.pubkey ?? '',
    created_at: ndkEvent.created_at ?? 0,
    kind: ndkEvent.kind ?? 0,
    tags: ndkEvent.tags ?? [],
    content: ndkEvent.content ?? '',
    sig: ndkEvent.sig ?? '',
  };
}

/**
 * Publish a pre-signed Nostr event to a relay via raw WebSocket.
 *
 * WHY NOT NDK? marmot-ts signs all events itself (commits, gift wraps, key
 * packages). NDK's publish() and publishReplaceable() silently re-sign events,
 * overwriting the original pubkey/sig. For gift wraps (kind 1059) this is fatal:
 * the ephemeral sender key is replaced by the user's real key, and the relay
 * accepts the event but it becomes undecryptable. Both methods return `{}`
 * (not a Set) giving no indication of failure.
 */
function rawPublish(
  relayUrl: string,
  event: NostrEvent,
  timeoutMs = PUBLISH_TIMEOUT_MS,
): Promise<PublishResponse> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      const timer = setTimeout(() => {
        ws.close();
        resolve({ from: relayUrl, ok: false, message: 'timeout' });
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify(['EVENT', event]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'OK' && data[1] === event.id) {
            clearTimeout(timer);
            ws.close();
            resolve({ from: relayUrl, ok: data[2] === true, message: data[3] });
          }
        } catch {
          // ignore parse errors, keep waiting for OK
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        resolve({ from: relayUrl, ok: false, message: 'websocket error' });
      };
    } catch (err) {
      resolve({
        from: relayUrl,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export class NdkNetworkAdapter implements NostrNetworkInterface {
  constructor(private readonly ndk: NDK) {}

  async publish(
    relays: string[],
    event: NostrEvent
  ): Promise<Record<string, PublishResponse>> {
    // Events from marmot-ts come pre-signed (id + pubkey + sig set).
    // NDK's publishReplaceable re-signs events which breaks pre-signed ones.
    // Use raw WebSocket publishing to send events as-is.
    const results = await Promise.all(
      relays.map((relay) => rawPublish(relay, event))
    );

    const result: Record<string, PublishResponse> = {};
    for (const r of results) {
      result[r.from] = r;
    }
    return result;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[]
  ): Promise<NostrEvent[]> {
    const ndkFilter = toNdkFilter(filters);
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk);
    const { fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
    const { events, timedOut } = await fetchEventsWithTimeout(this.ndk, ndkFilter, {}, relaySet);
    if (timedOut) {
      console.warn('[NdkNetworkAdapter] request() timed out — returning empty to avoid partial results');
      return [];
    }
    return Array.from(events).map(toNostrEvent);
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[]
  ): Subscribable<NostrEvent> {
    const ndkFilter = toNdkFilter(filters);
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk);

    return {
      subscribe: (observer: Partial<Observer<NostrEvent>>): Unsubscribable => {
        const sub: NDKSubscription = this.ndk.subscribe(ndkFilter, {
          closeOnEose: false,
        }, relaySet);

        sub.on('event', (ndkEvent: NDKEvent) => {
          observer.next?.(toNostrEvent(ndkEvent));
        });

        sub.on('eose', () => {
          // Don't complete — we want to keep listening
        });

        return {
          unsubscribe: () => {
            sub.stop();
          },
        };
      },
    };
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    // Fetch kind 10051 (relay list for KeyPackage discovery)
    try {
      const { fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
      const { events, timedOut } = await fetchEventsWithTimeout(
        this.ndk,
        // 10051 is the KeyPackage relay list kind — cast to NDKKind
        { kinds: [10051 as import('@nostr-dev-kit/ndk').NDKKind], authors: [pubkey], limit: 1 },
      );
      // On timeout, fall back to DEFAULT_RELAYS rather than trusting an
      // incomplete relay list that may be missing entries.
      if (timedOut) return getEffectiveRelays();
      const event = Array.from(events)[0];
      // Fallback to effective relays: most users never publish kind 10051.
      // Returning [] would cause marmot-ts to throw "No relays available
      // to send Welcome" — the invite succeeds but the new member never
      // receives the Welcome gift wrap and can't join.
      if (!event) return getEffectiveRelays();

      const relays = event.tags
        .filter((t) => t[0] === 'relay' && typeof t[1] === 'string')
        .map((t) => t[1]);
      return relays.length > 0 ? relays : getEffectiveRelays();
    } catch {
      return getEffectiveRelays();
    }
  }
}
