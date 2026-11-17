import type { Page } from '@playwright/test';

type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  limit?: number;
  '#t'?: string[];
  '#p'?: string[];
  '#e'?: string[];
  '#h'?: string[];
  ids?: string[];
  since?: number;
};

type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

const RELAY_URL = process.env.E2E_RELAY_URL ?? 'ws://localhost:7777';

/**
 * Query the strfry relay for events matching the given filter.
 * Runs inside page.evaluate to use the browser's WebSocket.
 */
export async function queryRelayForEvents(
  page: Page,
  filter: NostrFilter,
): Promise<NostrEvent[]> {
  return page.evaluate(
    ({ relayUrl, f }) => {
      return new Promise<NostrEvent[]>((resolve, reject) => {
        const events: NostrEvent[] = [];
        const ws = new WebSocket(relayUrl);
        const subId = 'e2e-query-' + Math.random().toString(36).slice(2, 10);
        const timeout = setTimeout(() => {
          ws.close();
          resolve(events); // resolve with whatever we got
        }, 10_000);

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, f]));
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              events.push(data[2]);
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(events);
            }
          } catch {
            // ignore parse errors
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error connecting to ${relayUrl}`));
        };
      });
    },
    { relayUrl: RELAY_URL, f: filter },
  );
}
