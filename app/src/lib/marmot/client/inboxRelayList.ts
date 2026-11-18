import { verifyEvent } from '@941design/nostr-events/event';
import { parseDmRelayList10050 } from '@941design/nostr-events/parsers';
import type { InboxRelayListEnsure } from './createClient';

const KIND = 10050;
const CLIENT = 'few';
const LOOKUP_TIMEOUT_MS = 8_000;

type EnsureContext = Parameters<InboxRelayListEnsure['ensure']>[0];

export async function ensureInboxRelayList({
  pubkey, relays, transport, signer, signal, previousRelays = [],
}: EnsureContext & { previousRelays?: readonly string[] }): Promise<string[]> {
  const sourceRelays = [...new Set([...previousRelays, ...relays])];
  const { events, timedOut } = await transport.requestWithDeadline(
    sourceRelays, { kinds: [KIND], authors: [pubkey] }, { timeoutMs: LOOKUP_TIMEOUT_MS, signal },
  );

  const latest = events
    .filter((event) => event.kind === KIND && event.pubkey === pubkey && verifyEvent(event))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : Number(a.id > b.id)))[0];
  if (latest && !latest.tags.some((tag) => tag[0] === 'client' && tag[1] === CLIENT)) {
    return parseDmRelayList10050(latest).relay;
  }
  // A partial lookup cannot rule out a newer list owned by another client.
  if (timedOut) throw new Error('Inbox relay list lookup did not complete');
  signal?.throwIfAborted();
  const tags = [...relays.map((relay) => ['relay', relay]), ['client', CLIENT]];
  const created_at = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? -1) + 1);
  const event = await signer.signEvent({ kind: KIND, content: '', tags, created_at }, { signal });
  signal?.throwIfAborted();
  if (event.pubkey !== pubkey || event.kind !== KIND || event.content !== '' ||
      JSON.stringify(event.tags) !== JSON.stringify(tags) || event.created_at !== created_at || !verifyEvent(event)) {
    throw new Error('Signer changed the inbox relay list event');
  }
  const result = await transport.publish(relays, event, { signal });
  if (!Object.values(result).some(({ ok }) => ok)) throw new Error('No relay accepted the inbox relay list');
  return relays;
}

export const inboxRelayList: InboxRelayListEnsure = {
  async ensure(context) {
    await ensureInboxRelayList(context);
  },
};
