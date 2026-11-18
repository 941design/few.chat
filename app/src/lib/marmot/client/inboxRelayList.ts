import { verifyEvent } from '@941design/nostr-events/event';
import { parseDmRelayList10050 } from '@941design/nostr-events/parsers';
import type { InboxRelayListEnsure } from './createClient';
import {
  INBOX_RELAY_LIST_CLIENT as CLIENT,
  INBOX_RELAY_LIST_KIND as KIND,
  isForeignInboxRelayList,
  latestVerifiedRelayList,
} from './inboxRelayOwnership';

const LOOKUP_TIMEOUT_MS = 8_000;

type EnsureContext = Parameters<InboxRelayListEnsure['ensure']>[0];

export async function ensureInboxRelayList({
  pubkey, relays, transport, signer, signal, previousRelays = [], observeInboxRelayList, assertCanPublish, republish = false,
}: EnsureContext & { republish?: boolean }): Promise<string[]> {
  signal?.throwIfAborted();
  const sourceRelays = [...new Set([...previousRelays, ...relays])];
  const { events, timedOut } = await transport.requestWithDeadline(
    sourceRelays, { kinds: [KIND], authors: [pubkey] }, { timeoutMs: LOOKUP_TIMEOUT_MS, signal },
  );
  signal?.throwIfAborted();

  const latest = observeInboxRelayList ? observeInboxRelayList(events) : latestVerifiedRelayList(pubkey, KIND, events);
  if (latest) {
    const advertised = parseDmRelayList10050(latest).relay;
    if (isForeignInboxRelayList(latest)) return advertised;
    const configured = new Set(relays);
    if (!republish && advertised.length === configured.size && advertised.every((relay) => configured.has(relay))) {
      return relays;
    }
  }
  // A partial lookup cannot rule out a newer list owned by another client.
  if (timedOut) throw new Error('Inbox relay list lookup did not complete');
  assertCanPublish?.();
  const tags = [...relays.map((relay) => ['relay', relay]), ['client', CLIENT]];
  const created_at = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? -1) + 1);
  const event = await signer.signEvent({ kind: KIND, content: '', tags, created_at }, { signal });
  signal?.throwIfAborted();
  if (observeInboxRelayList && observeInboxRelayList([])?.id !== latest?.id) {
    throw new Error('Inbox relay ownership changed while signing');
  }
  if (event.pubkey !== pubkey || event.kind !== KIND || event.content !== '' ||
      JSON.stringify(event.tags) !== JSON.stringify(tags) || event.created_at !== created_at || !verifyEvent(event)) {
    throw new Error('Signer changed the inbox relay list event');
  }
  const result = await transport.publish(relays, event, { signal });
  if (!Object.values(result).some(({ ok }) => ok)) throw new Error('No relay accepted the inbox relay list');
  signal?.throwIfAborted();
  observeInboxRelayList?.([event]);
  return relays;
}

export const inboxRelayList: InboxRelayListEnsure = {
  async ensure(context) {
    await ensureInboxRelayList(context);
  },
};
