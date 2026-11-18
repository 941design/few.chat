import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { ensureInboxRelayList } from '@/src/lib/marmot/client';
import type { InboxRelayListEnsure } from '@/src/lib/marmot/client';

const secret = new Uint8Array(32).fill(1);
const pubkey = getPublicKey(secret);
const relays = ['wss://new.example', 'wss://other.example'];
const foreignRelays = ['wss://foreign.example'];
const oldRelays = ['wss://old.example'];

function list(client?: string) {
  return finalizeEvent({
    kind: 10050,
    content: '',
    created_at: 42,
    tags: [
      ['relay', foreignRelays[0]],
      ...(client ? [['client', client]] : []),
    ],
  }, secret);
}

type Event = ReturnType<typeof list>;
function setup(events: Event[], timedOut = false) {
  const requestWithDeadline = vi.fn(async () => ({ events, timedOut, eosedRelays: relays, silentRelays: [] }));
  const publish = vi.fn(async (_relays: string[], _event: Event) => ({ [relays[0]]: { ok: true, from: relays[0] } }));
  const signEvent = vi.fn(async (draft: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(draft, secret));
  const context: Parameters<InboxRelayListEnsure['ensure']>[0] = {
    pubkey,
    relays,
    transport: { requestWithDeadline, publish, subscription: vi.fn() },
    signer: { signEvent },
  };
  return { context, requestWithDeadline, publish, signEvent };
}

describe('Few inbox relay list', () => {
  it.each([undefined, 'few'])('publishes only configured relays for a writable list (%s)', async (client) => {
    const events = client ? [list(client)] : [];
    const { context, requestWithDeadline, publish } = setup(events);
    await expect(ensureInboxRelayList({ ...context, previousRelays: oldRelays })).resolves.toEqual(relays);
    expect(requestWithDeadline.mock.calls[0]).toEqual([
      [...oldRelays, ...relays], { kinds: [10050], authors: [pubkey] },
      { timeoutMs: expect.any(Number), signal: undefined },
    ]);
    expect(publish).toHaveBeenCalledExactlyOnceWith(relays, expect.objectContaining({
      pubkey, kind: 10050, content: '',
      tags: [['relay', relays[0]], ['relay', relays[1]], ['client', 'few']],
    }), { signal: undefined });
  });

  it('respects a foreign list even when it has no client tag', async () => {
    const { context, publish, signEvent } = setup([list()]);
    await expect(ensureInboxRelayList(context)).resolves.toEqual(foreignRelays);
    expect(publish).not.toHaveBeenCalled();
    expect(signEvent).not.toHaveBeenCalled();
  });

  it('leaves the account untouched when the lookup is partial', async () => {
    const { context, publish, signEvent } = setup([list('few')], true);
    await expect(ensureInboxRelayList(context)).rejects.toThrow('lookup did not complete');
    expect(publish).not.toHaveBeenCalled();
    expect(signEvent).not.toHaveBeenCalled();
  });
});
