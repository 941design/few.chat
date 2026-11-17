// @vitest-environment node
/**
 * AC-OBS-2 clause (i) against the REAL chat store: for EVERY sequence (exhaustive up to length 3) of
 * {echo via carrier 1, echo via carrier 2, withdraw carrier 1, withdraw carrier 2, send() resolve, send() reject}
 * applied to one optimistic own row over the production sink path (real HistoryBackend, dispatcher, chat handler,
 * chat store), the store holds EXACTLY ONE row with that rumor.id, and the tracker's status follows the carrier
 * model: once an echo happened, confirmed while some carrier stands, failed when the last carrier was withdrawn
 * (the row is never deleted); before any echo it is failed only after a rejected send.
 * Real timers (fake-indexeddb needs them); the timer / intentFailed / branch events do not touch the store and are
 * covered by ownRowLifecycle.property.test.ts.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import { createGroupRumorSender, createOwnRowTracker, type OwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';
import { buildRealApp, ev, installLocalStorage, SELF, type RealApp } from '../handlers/realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

type Op = 'echo1' | 'echo2' | 'withdraw1' | 'withdraw2' | 'resolve' | 'reject';
const ALPHABET: Op[] = ['echo1', 'echo2', 'withdraw1', 'withdraw2', 'resolve', 'reject'];

function* sequences(maxLen: number): Generator<Op[]> {
  function* rec(prefix: Op[]): Generator<Op[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === maxLen) return;
    for (const e of ALPHABET) yield* rec([...prefix, e]);
  }
  yield* rec([]);
}

let app: RealApp;
let tracker: OwnRowTracker;
beforeEach(() => {
  installLocalStorage();
});
afterEach(async () => {
  tracker?.dispose();
  await app?.sink.dispose();
});

async function run(seq: Op[]) {
  app = buildRealApp();
  tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  // the handler ports carry the kind-445 event id of the sink call in flight (what S18's input.eventId is)
  let carrier: string | undefined;
  app.spies.onOwnEcho.mockImplementation((g: string, id: string) => tracker.onOwnEcho(g, id, carrier));
  app.spies.onOwnWithdrawn.mockImplementation((g: string, id: string) => tracker.onOwnWithdrawn(g, id, carrier));

  let settle!: { resolve: () => void; reject: (e: unknown) => void };
  const group: SendableGroup = {
    id: app.groupId,
    send: (() => new Promise<unknown>((resolve, reject) => void (settle = { resolve: () => resolve(undefined), reject }))) as unknown as SendableGroup['send'],
    pendingIntents: async () => [],
  };
  const prepared = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1_700_000_100 }).prepare(group, 9, 'p', []);
  await chat.appendMessage(app.groupId, { id: prepared.id, content: 'p', senderPubkey: SELF, groupId: app.groupId, createdAt: 1_700_000_100_000 });
  const sent = prepared.send().catch(() => undefined);

  const carriers = new Set<string>();
  let echoed = false;
  let rejected = false;
  let settled = false;
  for (const op of seq) {
    if (op === 'resolve' || op === 'reject') {
      if (settled) continue;
      settled = true;
      if (op === 'resolve') settle.resolve();
      else {
        settle.reject(new Error('rejected'));
        rejected = true;
      }
      await sent;
      continue;
    }
    const label = op.endsWith('1') ? 'own1' : 'own2';
    carrier = ev(label)[0];
    if (op.startsWith('echo')) {
      await app.sink.append(app.entry({ eventId: label, account: SELF, rumorId: prepared.id, pubkey: SELF, content: 'p', at: 1_700_000_100 }));
      carriers.add(label);
      echoed = true;
    } else {
      await app.sink.withdraw(app.groupId, ev(label));
      carriers.delete(label);
    }
  }
  const rows = (await app.messages()).filter((m) => m.id === prepared.id);
  const expectedStatus = echoed ? (carriers.size > 0 ? 'confirmed' : 'failed') : rejected ? 'failed' : 'sending';
  return { rows: rows.length, status: tracker.statusOf(app.groupId, prepared.id), expectedStatus };
}

describe('AC-OBS-2 (i): exactly one row with that rumor.id in the real chat store', () => {
  it('exhaustive over every sequence of length 1..3', async () => {
    let n = 0;
    const tally = { confirmed: 0, failed: 0, sending: 0 };
    for (const seq of sequences(3)) {
      const out = await run(seq);
      const label = seq.join(',');
      expect(out.rows, `(i) one row: ${label}`).toBe(1);
      expect(out.status, `status follows the carrier model: ${label}`).toBe(out.expectedStatus);
      n += 1;
      tally[out.expectedStatus as keyof typeof tally] += 1;
      tracker.dispose();
      await app.sink.dispose();
    }
    expect(n).toBe(6 + 36 + 216);
    // not vacuous: every final status is reached many times
    expect(Math.min(tally.confirmed, tally.failed, tally.sending)).toBeGreaterThan(10);
  }, 300_000);
});
