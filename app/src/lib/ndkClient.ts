/**
 * Singleton NDK instance for Nostr relay connections.
 * Initialized lazily — safe to import in SSR but only connects on client.
 */

import NDK, { NDKPrivateKeySigner, type NDKEvent, type NDKRelay, type NDKSigner } from '@nostr-dev-kit/ndk';
import { DEFAULT_RELAYS } from '@/src/types';

let ndkInstance: NDK | null = null;

/** Track the private key currently bound to ndkInstance.signer. */
let signerPrivateKeyHex: string | null = null;

/**
 * The NIP-07/NIP-46 signer applied via applyNdkSigner, until released.
 * While set, a privateKeyHex passed to getNdk/connectNdk does NOT rebind: those
 * callers pass the stored local key out of habit, and rebinding would sign the
 * user's publishes with a different identity than the connected signer.
 */
let externalSigner: NDKSigner | null = null;

function applySigner(ndk: NDK, privateKeyHex: string): void {
  if (externalSigner) return;
  if (signerPrivateKeyHex === privateKeyHex && ndk.signer) return;
  ndk.signer = new NDKPrivateKeySigner(privateKeyHex);
  signerPrivateKeyHex = privateKeyHex;
}

/**
 * Get or create the global NDK singleton.
 * Pass a privateKeyHex to bind/rebind the signer to that key (ignored while an
 * external signer is applied).
 * Returns null on server (SSR safety).
 */
export function getNdk(privateKeyHex?: string): NDK | null {
  if (typeof window === 'undefined') return null;

  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: [...DEFAULT_RELAYS],
    });
    if (externalSigner) ndkInstance.signer = externalSigner;
  }

  if (privateKeyHex) {
    applySigner(ndkInstance, privateKeyHex);
  }

  return ndkInstance;
}

/**
 * Connect the NDK singleton to relays. Safe to call multiple times.
 * Rebinds the signer to the supplied key — callers that pass a new
 * privateKeyHex (e.g. after identity restore) get traffic signed with that key —
 * unless an external signer is applied, which stays bound.
 */
export async function connectNdk(privateKeyHex: string): Promise<NDK> {
  const ndk = getNdk(privateKeyHex)!;
  await ndk.connect(2500);
  return ndk;
}

/**
 * Per-relay publish-ack timeout for user-initiated DM publishes.
 *
 * WHY: NDK 3.0.3's `NDKRelayPublisher.publish(event, timeoutMs = 2500)` rejects
 * a relay that has not acked within 2.5 s. Under load a relay that DID store the
 * event acks later, the relay-set publish throws "Not enough relays received the
 * event", and the sender rolls back a message the peer actually receives (resend
 * then duplicates). Groups already use 10 s (NdkNetworkAdapter.rawPublish); DMs
 * share this single value.
 */
export const PUBLISH_TIMEOUT_MS = 10_000;

/** Publish a signed event with the shared ack timeout (instead of NDK's 2.5 s default). */
export function publishWithTimeout(event: NDKEvent): Promise<Set<NDKRelay>> {
  return event.publish(undefined, PUBLISH_TIMEOUT_MS);
}

const FETCH_TIMEOUT_MS = 8_000;

export type FetchResult = {
  events: Set<import('@nostr-dev-kit/ndk').NDKEvent>;
  timedOut: boolean;
};

/**
 * Fetch events with a hard timeout that actually cancels the underlying
 * NDK subscription (via sub.stop()) so no dangling background work remains.
 * Deduplicates events by ID (matching NDK.fetchEvents behaviour) so callers
 * that pick "newest" or assume one event per ID get consistent results.
 * Returns { events, timedOut } so callers can distinguish a clean empty
 * result from an incomplete fetch.
 */
export function fetchEventsWithTimeout(
  ndk: NDK,
  filter: Parameters<NDK['fetchEvents']>[0],
  opts?: Parameters<NDK['fetchEvents']>[1],
  relaySet?: Parameters<NDK['fetchEvents']>[2],
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<FetchResult> {
  // Deduplicate by event ID — same logical event may arrive from multiple
  // relays. NDK.fetchEvents() uses deduplicationKey() internally; for
  // standard events that key is the event ID.
  const byId = new Map<string, import('@nostr-dev-kit/ndk').NDKEvent>();
  const sub = ndk.subscribe(filter, { closeOnEose: true, ...opts }, relaySet);

  return new Promise<FetchResult>((resolve) => {
    let settled = false;

    function settle(timedOut: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.stop();
      resolve({ events: new Set(byId.values()), timedOut });
    }

    const timer = setTimeout(() => settle(true), timeoutMs);

    sub.on('event', (event: import('@nostr-dev-kit/ndk').NDKEvent) => {
      const id = event.id;
      if (id && !byId.has(id)) {
        byId.set(id, event);
      }
    });

    sub.on('eose', () => settle(false));
  });
}

/**
 * Apply relay list changes to the live NDK pool.
 * Adds relays in nextUrls not in previousUrls, removes relays in previousUrls
 * not in nextUrls, and updates ndk.explicitRelayUrls.
 * Safe to call before sign-in — if NDK is not initialized, the relay list
 * is read from localStorage at init time anyway.
 */
export function applyRelayChangesToPool(
  previousUrls: string[],
  nextUrls: string[],
): void {
  const ndk = ndkInstance;
  if (!ndk) return;

  const prevSet = new Set(previousUrls);
  const nextSet = new Set(nextUrls);

  for (const url of nextUrls) {
    if (!prevSet.has(url)) {
      const relay = ndk.pool.getRelay(url, true);
      ndk.pool.addRelay(relay, true);
    }
  }

  for (const url of previousUrls) {
    if (!nextSet.has(url)) {
      ndk.pool.removeRelay(url);
    }
  }

  ndk.explicitRelayUrls = nextUrls;
}

/**
 * Bind an external NDK signer (NIP-46 or NIP-07) to the NDK singleton.
 * Used by Stories 04/05 after the bunker/extension connection is established.
 * The signer stays bound across getNdk/connectNdk(privateKeyHex) calls until
 * releaseNdkExternalSigner; if NDK is not initialised yet, it is applied on creation.
 */
export function applyNdkSigner(signer: NDKSigner): void {
  externalSigner = signer;
  signerPrivateKeyHex = null;
  if (ndkInstance) ndkInstance.signer = signer;
}

/**
 * Return NDK to local-key signing after the external signer is disconnected.
 * With a key, binds it immediately; with null, the next getNdk/connectNdk(key) binds.
 */
export function releaseNdkExternalSigner(privateKeyHex: string | null): void {
  externalSigner = null;
  signerPrivateKeyHex = null;
  if (privateKeyHex && ndkInstance) applySigner(ndkInstance, privateKeyHex);
}

/**
 * Return the current NDK singleton without creating or configuring one.
 * Returns null on server (SSR safety) or before first init.
 * Used by NIP-46 / NIP-07 adapters that need the NDK instance but must not
 * trigger a key rebind (unlike getNdk(privateKeyHex)).
 */
export function getNdkInstance(): NDK | null {
  if (typeof window === 'undefined') return null;
  return ndkInstance;
}

/** Reset the NDK singleton (for testing). */
export function _resetNdkSingleton(): void {
  ndkInstance = null;
  signerPrivateKeyHex = null;
  externalSigner = null;
}
