// @vitest-environment node
/**
 * A carrier is registered only for the stored row's own sender.
 *
 * The sink may deliver a byte-identical copy of a rumor under another event id AND another sender (a forgery by a
 * member who re-sends a message they saw). That copy is not a carrier of the real sender's row: it must neither keep
 * the row alive after the real delivery is withdrawn nor leave a stale carrier no retract can remove (the retract
 * refuses to act for a sender other than the stored one).
 *
 * Real collaborators: chatPersistence, reactions, the history sink and dispatcher (realApp.ts) over fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import { ALICE, BOB, buildRealApp, installLocalStorage, MALLORY, nextGroupId, type RealApp } from './realApp';
import { append, expectOracle, runSteps, withdraw } from './oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(() => {
  installLocalStorage();
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.sink.dispose();
});

const message = (app: RealApp, label: string, account: string, pubkey = BOB) =>
  app.entry({ eventId: label, account, pubkey, rumorId: 'R', content: 'hello' });
const reaction = (app: RealApp) =>
  app.entry({ eventId: 'rx', kind: 7, account: ALICE, rumorId: 'rx-id', content: '👍', tags: [['e', 'R']] });
const carriers = async (app: RealApp) => (await app.messages()).find((m) => m.id === 'R')?.carrierEventIds;
const hexOf = (label: string) => Buffer.from(label).toString('hex');

describe('appendOrAddCarrier (store contract)', () => {
  const msg = (id: string, sender: string, eventId: string): chat.ChatMessage => ({
    id,
    content: 'x',
    senderPubkey: sender,
    groupId: 'ab'.repeat(32),
    createdAt: 1,
    carrierEventIds: [eventId],
  });

  it('registers a second event id of the SAME sender as another carrier (case-insensitive sender)', async () => {
    const g = nextGroupId();
    expect(await chat.appendOrAddCarrier(g, msg('R', BOB, 'e1'), 'e1')).toBe('inserted');
    expect(await chat.appendOrAddCarrier(g, msg('R', BOB.toUpperCase(), 'e2'), 'e2')).toBe('duplicate');
    expect((await chat.loadMessages(g)).messages[0].carrierEventIds).toEqual(['e1', 'e2']);
  });

  it('reports a copy delivered by ANOTHER sender as a duplicate WITHOUT registering a carrier', async () => {
    const g = nextGroupId();
    await chat.appendOrAddCarrier(g, msg('R', BOB, 'e1'), 'e1');
    expect(await chat.appendOrAddCarrier(g, msg('R', MALLORY, 'e2'), 'e2')).toBe('duplicate');
    expect((await chat.loadMessages(g)).messages[0].carrierEventIds).toEqual(['e1']);
  });
});

describe('a forged byte-identical copy of another member\'s message', () => {
  it('does not keep the row alive once the real delivery is withdrawn; the dependents recompute', async () => {
    const app = make();
    // (no oracle here: plain kind-9 rows keep carrier accounting, AC-WDR-7 - the forged copy's own history row is
    // not re-applied as MALLORY's message when the sender's one is withdrawn)
    await runSteps(app, [append(message(app, 'v1', BOB)), append(message(app, 'm1', MALLORY)), append(reaction(app))]);
    expect(await carriers(app)).toEqual([hexOf('v1')]); // the forged copy is not a carrier
    expect(await app.reactionRows()).toHaveLength(1);

    await runSteps(app, [withdraw('v1')]);
    expect((await app.messages()).find((m) => m.id === 'R')).toBeUndefined(); // the sender's delivery is gone, so is the row
    expect((await app.reactionRows()).filter((r) => !r.removed)).toEqual([]); // its reaction recomputed away with the target
  });

  it('withdrawing the forged copy leaves no stale carrier and changes nothing about the real row', async () => {
    const app = make();
    const steps = [append(message(app, 'v1', BOB)), append(message(app, 'm1', MALLORY)), withdraw('m1')];
    await runSteps(app, steps);
    expect(await carriers(app)).toEqual([hexOf('v1')]);
    expect((await app.messages()).find((m) => m.id === 'R')?.senderPubkey).toBe(BOB);
    await expectOracle(app, steps, make);

    // ... and the real sender's withdrawal then removes the row for good (no stale carrier kept it)
    await app.sink.withdraw(app.groupId, [hexOf('v1')]);
    expect((await app.messages()).find((m) => m.id === 'R')).toBeUndefined();
  });

  it('a second real carrier of the same sender still keeps the row after one carrier is withdrawn', async () => {
    const app = make();
    await runSteps(app, [append(message(app, 'v1', BOB)), append(message(app, 'v2', BOB))]);
    expect(await carriers(app)).toEqual([hexOf('v1'), hexOf('v2')]);
    await app.sink.withdraw(app.groupId, [hexOf('v1')]);
    expect((await app.messages()).find((m) => m.id === 'R')?.carrierEventIds).toEqual([hexOf('v2')]);
  });
});
