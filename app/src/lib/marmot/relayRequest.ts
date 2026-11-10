/**
 * One-shot raw-WebSocket REQ to a single relay, outside the NDK pool
 * (bug invite-lookup-ignores-invitee-s-keypackage). Same style as rawPublish in
 * NdkNetworkAdapter: it exists so a relay the invitee merely advertises is never
 * added to the pool, where other code could share it or disconnect it.
 *
 * Collects EVENTs until EOSE (or CLOSED) or the bound, sends CLOSE and closes
 * the socket. The events are NOT verified or filtered here — the caller must.
 * A connection error or constructor failure contributes nothing and never
 * throws. timedOut is true only when the bound was hit with nothing received.
 */
import { verifyEvent } from 'nostr-tools/pure';

export type RelayRequestFilter = Record<string, unknown>;

export type RelayRequestResult<E> = { events: E[]; timedOut: boolean };

/** Upper bound on events kept from one relay (a hostile relay can stream forever). */
export const MAX_EVENTS_PER_RELAY = 50;

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
};

export function requestRelayOnce<E = unknown>(
  url: string,
  filter: RelayRequestFilter,
  timeoutMs: number,
  WebSocketCtor: (new (url: string) => WebSocketLike) | undefined = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket,
): Promise<RelayRequestResult<E>> {
  return new Promise((resolve) => {
    const events: E[] = [];
    let done = false;
    let ws: WebSocketLike | undefined;
    const subId = `kp-${Math.random().toString(36).slice(2, 10)}`;

    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* ignore */
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve({ events, timedOut: timedOut && events.length === 0 });
    };

    const timer = setTimeout(() => finish(true), timeoutMs);

    try {
      if (!WebSocketCtor) {
        finish(false);
        return;
      }
      ws = new WebSocketCtor(url);
      ws.onopen = () => {
        try {
          ws!.send(JSON.stringify(['REQ', subId, filter]));
        } catch {
          finish(false);
        }
      };
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(String(msg.data));
          if (!Array.isArray(data) || data[1] !== subId) return;
          if (data[0] === 'EVENT' && data[2] && typeof data[2] === 'object') {
            if (events.length < MAX_EVENTS_PER_RELAY) events.push(data[2] as E);
          } else if (data[0] === 'EOSE' || data[0] === 'CLOSED') {
            finish(false);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

/** Signature + id check for a relay event; false on any malformed input, never throws. */
export function verifyRelayEvent(event: unknown): boolean {
  try {
    const e = event as Record<string, unknown>;
    return verifyEvent({
      id: e.id,
      pubkey: e.pubkey,
      created_at: e.created_at,
      kind: e.kind,
      tags: e.tags,
      content: e.content,
      sig: e.sig,
    } as never);
  } catch {
    return false;
  }
}
