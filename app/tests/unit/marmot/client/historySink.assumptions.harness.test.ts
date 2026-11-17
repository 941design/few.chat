// @vitest-environment node
/**
 * Library harness for the HistoryBackend assumptions the epic builds on
 * (spec Assumptions A1-A3), run against REAL @941design/marmot clients over
 * createMemoryStorage() and a FakeRelay, through the same dev smoke hook the
 * browser spec uses. The e2e smoke spec (groups-library-smoke) is the
 * in-browser/bundling proof; this is the fast, deterministic twin.
 *
 *  A1  an `append` that throws is retried and eventually applied;
 *  A3  an own message is delivered through the sink after confirmation, with
 *      orderingKey.account === own pubkey;
 *  A2  after a rewind (same-epoch fork), `withdraw` is called with the kind-445
 *      event id of the abandoned branch's message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { getPublicKey } from 'nostr-tools/pure';
import { createGroupLibraryHook, type GroupLibraryHook } from '@/src/lib/testHooks/groupLibrary';
import { openAccountStores } from '@/src/lib/marmot/client/storage';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const pub = (hex: string) => getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));

let relay: FakeRelay;
let relayUrl: string;
const hooks: GroupLibraryHook[] = [];

function makeHook(): GroupLibraryHook {
  const backend = createMemoryStorage({ persistence: createMemoryPersistence(), leaseTimeoutMs: 200 });
  const hook = createGroupLibraryHook({
    secureContext: () => true,
    openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
  });
  hooks.push(hook);
  return hook;
}

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
});
afterEach(async () => {
  for (const h of hooks.splice(0)) await h.stop().catch(() => undefined);
  await relay.stop();
});

async function pairedGroup() {
  const a = makeHook();
  const b = makeHook();
  await a.start({ privateKeyHex: SECRET_A, relays: [relayUrl], historyTimeoutMs: 1000 });
  await b.start({ privateKeyHex: SECRET_B, relays: [relayUrl], historyTimeoutMs: 1000 });
  const { groupId } = await a.createGroup('Smoke', { admins: [pub(SECRET_B)] });
  const outcomes = await a.inviteByPubkey(groupId, pub(SECRET_B));
  expect(outcomes[0].status).toBe('delivered');
  await expect.poll(() => b.pendingCount(), { timeout: 15_000 }).toBe(1);
  const joined = await b.acceptFirstPending();
  expect(joined).toBe(groupId);
  await a.waitSynced(groupId);
  await b.waitSynced(groupId);
  return { a, b, groupId };
}

describe('A3: own message delivered through the sink after confirmation', () => {
  it('the sender and the member both get the entry, authored by the sender', async () => {
    const { a, b, groupId } = await pairedGroup();
    const { rumorId } = await a.send(groupId, 'hello from A');
    await expect.poll(() => a.retained(groupId).map((e) => e.rumorId), { timeout: 15_000 }).toContain(rumorId);
    await expect.poll(() => b.retained(groupId).map((e) => e.rumorId), { timeout: 15_000 }).toContain(rumorId);
    const own = a.retained(groupId).find((e) => e.rumorId === rumorId)!;
    expect(own.account).toBe(pub(SECRET_A));
    expect(own.content).toBe('hello from A');
    expect(b.retained(groupId).find((e) => e.rumorId === rumorId)!.account).toBe(pub(SECRET_A));
    // the sink entry is keyed by the kind-445 event id, not the rumor id
    expect(own.eventId).not.toBe(rumorId);
    expect(relay.storedEvents.some((e) => e.kind === 445 && e.id === own.eventId)).toBe(true);
  });
});

describe('A1: a thrown append is retried and eventually applied', () => {
  it('append throws once for an entry, is called again for the same eventId, and then retained', async () => {
    const { a, groupId } = await pairedGroup();
    a.failNextAppends(1);
    const { rumorId } = await a.send(groupId, 'retry me');
    await expect.poll(() => a.retained(groupId).map((e) => e.rumorId), { timeout: 30_000 }).toContain(rumorId);
    const calls = a.sink().appendCalls.filter((c) => c.rumorId === rumorId);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].threw).toBe(true);
    expect(calls[calls.length - 1].threw).toBe(false);
    expect(new Set(calls.map((c) => c.eventId)).size).toBe(1);
  });
});

describe('A2: withdraw is called with kind-445 ids after a rewind', () => {
  it('a same-epoch fork abandons one branch: its message was appended, is then withdrawn by event id, and leaves the sink', async () => {
    const { a, b, groupId } = await pairedGroup();
    expect(b.groupInfo(groupId).epoch).toBe(a.groupInfo(groupId).epoch);

    // Stage the fork: both admins commit from the same epoch while neither can hear the other.
    a.setPartition(true);
    b.setPartition(true);
    a.renameNoWait(groupId, 'A-branch');
    b.renameNoWait(groupId, 'B-branch');
    await expect.poll(() => relay.storedEvents.filter((e) => e.kind === 445).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const sentA = await a.send(groupId, 'on branch A');
    const sentB = await b.send(groupId, 'on branch B');
    await expect.poll(() => [a, b].every((h) => h.retained(groupId).length >= 1), { timeout: 15_000 }).toBe(true);
    const idBeforeHeal = {
      a: a.retained(groupId).find((e) => e.rumorId === sentA.rumorId)?.eventId,
      b: b.retained(groupId).find((e) => e.rumorId === sentB.rumorId)?.eventId,
    };
    expect(idBeforeHeal.a).toBeTruthy();
    expect(idBeforeHeal.b).toBeTruthy();

    a.setPartition(false);
    b.setPartition(false);

    // Exactly one branch loses; the loser's sink is told to withdraw that branch's kind-445 event id.
    await expect.poll(() => a.sink().withdrawCalls.length + b.sink().withdrawCalls.length, { timeout: 30_000 }).toBe(1);
    const loser = a.sink().withdrawCalls.length === 1 ? { hook: a, own: idBeforeHeal.a!, sent: sentA, winnerSent: sentB } : { hook: b, own: idBeforeHeal.b!, sent: sentB, winnerSent: sentA };
    const winner = loser.hook === a ? b : a;
    const call = loser.hook.sink().withdrawCalls[0];
    expect(call.groupId).toBe(groupId);
    expect(call.eventIds).toEqual([loser.own]);
    expect(relay.storedEvents.some((e) => e.kind === 445 && e.id === loser.own)).toBe(true);
    expect(winner.sink().withdrawCalls).toEqual([]);

    // The withdrawn message is gone from the loser's sink; the winner's message reaches both sinks.
    await expect.poll(() => loser.hook.retained(groupId).map((e) => e.rumorId), { timeout: 30_000 }).not.toContain(loser.sent.rumorId);
    await expect.poll(() => loser.hook.retained(groupId).map((e) => e.rumorId), { timeout: 30_000 }).toContain(loser.winnerSent.rumorId);
    expect(winner.retained(groupId).map((e) => e.rumorId)).toContain(loser.winnerSent.rumorId);
    expect(winner.retained(groupId).map((e) => e.rumorId)).not.toContain(loser.sent.rumorId);
    expect(loser.hook.groupInfo(groupId).epoch).toBe(winner.groupInfo(groupId).epoch);
  }, 90_000);
});
