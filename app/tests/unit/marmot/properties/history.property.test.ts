// @vitest-environment node
import 'fake-indexeddb/auto';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createHistoryBackend, createIdbHistoryStore } from '@/src/lib/marmot/history';
import * as chat from '@/src/lib/marmot/chatPersistence';
import { createGroupRumorSender, createOwnRowTracker, type SendableGroup } from '@/src/lib/marmot/send';
import { BOB, SELF, buildRealApp, ev, installLocalStorage } from '../handlers/realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_s: unknown, get: () => unknown) => get() }));

const seed = 19012026;
const id = fc.integer({ min: 0, max: 3 });
const inboundOp = fc.oneof(
  fc.record({ type: fc.constant('append' as const), id, copies: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ type: fc.constant('fail' as const), id, attempts: fc.integer({ min: 1, max: 3 }), restart: fc.boolean() }),
  fc.record({ type: fc.constant('withdraw' as const), id }),
  fc.record({ type: fc.constant('restart' as const) }),
);

describe('S19 history properties', () => {
  it('AC-OBS-1: delivery, replay, handler failure, restart and withdrawal converge', async () => {
    await fc.assert(fc.asyncProperty(fc.array(inboundOp, { minLength: 1, maxLength: 20 }), async (ops) => {
      installLocalStorage();
      const app = buildRealApp();
      let sink = app.sink;
      const expected = new Map<number, string>();
      const entry = (n: number) => app.entry({ eventId: `event${n}`, account: BOB, rumorId: `rumor${n}`, content: `message${n}` });
      try {
        for (const op of ops) {
          if (op.type === 'restart') {
            await sink.dispose();
            sink = createHistoryBackend({ handlers: app.dispatcher, store: createIdbHistoryStore(`s5-${app.groupId}`) });
            await sink.sweep();
          } else if (op.type === 'withdraw') {
            await sink.withdraw(app.groupId, ev(`event${op.id}`));
            expected.delete(op.id);
          } else {
            const e = entry(op.id);
            if (op.type === 'fail' && !expected.has(op.id)) {
              for (let i = 0; i < op.attempts; i++) {
                const fault = Promise.reject(new Error('injected handler failure'));
                void fault.catch(() => undefined);
                app.hooks.beforeAppend = fault;
                await expect(sink.append(e)).rejects.toThrow('injected handler failure');
                app.hooks.beforeAppend = undefined;
              }
              if (op.restart) {
                await sink.dispose();
                sink = createHistoryBackend({ handlers: app.dispatcher, store: createIdbHistoryStore(`s5-${app.groupId}`) });
                await sink.sweep();
              }
            }
            await sink.append(e);
            if (!expected.has(op.id)) expected.set(op.id, e.eventId);
            if (op.type === 'append') for (let i = 0; i < op.copies; i++) await sink.append(e);
          }
          expect((await sink.list(app.groupId)).map((e) => e.eventId)).toEqual([...expected.values()]);
          const rows = await app.messages();
          expect(rows.map((r) => r.id).sort()).toEqual([...expected.keys()].map((n) => `rumor${n}`).sort());
        }
      } finally {
        app.hooks.beforeAppend = undefined;
        await sink.dispose();
      }
    }), { seed, numRuns: 200 });
  }, 180_000);

  it('AC-OBS-2: own row survives all send and echo interleavings', async () => {
    const operation = fc.constantFrom('echo', 'reecho', 'resolve', 'reject', 'intent', 'branch', 'timer');
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 20 }), async (ops) => {
      installLocalStorage();
      const app = buildRealApp();
      const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
      app.spies.onOwnEcho.mockImplementation(tracker.onOwnEcho);
      app.spies.onOwnWithdrawn.mockImplementation(tracker.onOwnWithdrawn);
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const send = vi.fn(() => new Promise<void>((res, rej) => { resolve = res; reject = rej; }));
      const group: SendableGroup = { id: app.groupId, send: send as SendableGroup['send'], pendingIntents: async () => [] };
      const prepared = createGroupRumorSender({ ownPubkey: SELF, tracker, nowSeconds: () => 1700000100 }).prepare(group, 9, 'own', []);
      await chat.appendMessage(app.groupId, { id: prepared.id, content: 'own', senderPubkey: SELF, groupId: app.groupId, createdAt: 1700000100000 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const sent = prepared.send().catch(() => undefined);
      tracker.bindIntent(app.groupId, prepared.id, 'intent');
      let settled = false;
      let resolved = false;
      let echoed = false;
      let failed = false;
      try {
        for (const op of ops) {
          if (op === 'echo' || op === 'reecho') {
            await app.sink.append(app.entry({ eventId: op, account: SELF, rumorId: prepared.id, content: 'own', at: 1700000100 }));
            echoed = true;
          } else if ((op === 'resolve' || op === 'reject') && !settled) {
            settled = true;
            if (op === 'resolve') { resolved = true; resolve(); } else { reject(new Error('send rejected')); failed = true; }
            await sent;
          } else if (op === 'intent') {
            tracker.onIntentFailed({ groupId: app.groupId, intentId: 'intent' });
            failed = true;
          } else if (op === 'branch') {
            tracker.onGroupBranchSwitched({ groupId: app.groupId });
            failed = true;
          } else if (op === 'timer') {
            await vi.advanceTimersByTimeAsync(60_000);
            if (resolved) failed = true;
          }
          expect((await app.messages()).filter((r) => r.id === prepared.id)).toHaveLength(1);
          if (echoed) expect(tracker.statusOf(app.groupId, prepared.id)).toBe('confirmed');
          else if (failed) expect(tracker.statusOf(app.groupId, prepared.id)).toBe('failed');
          expect(send).toHaveBeenCalledTimes(1);
        }
      } finally {
        if (!settled) { resolve(); await sent; }
        tracker.dispose();
        await app.sink.dispose();
        vi.useRealTimers();
      }
    }), { seed: seed + 1, numRuns: 200 });
  }, 180_000);
});
