// @vitest-environment node
/**
 * Crash replay of a withdraw that drops delete / edit signals (ruling matrix item 11, AC-WDR-7): wherever the
 * withdraw is interrupted - after the rows were marked `withdrawing`, in the middle of the slot recompute (after the
 * reset, before / after the fold wrote), or after the retract but before the rows were deleted - a NEW sink instance
 * finishes it (startup recovery) and the stores converge to the oracle (dispatching only the survivors into empty
 * stores), and a later unrelated recompute does not resurrect what the interrupted withdraw dropped.
 *
 * Real collaborators: chatPersistence, messageEdits, the sink and dispatcher (realApp.ts) over fake-indexeddb. The
 * crash is injected at the seams: a handler wrapper (crash before / after the real retract) and a failing idb write
 * (crash inside the recompute).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One-shot failure injection of an idb write: the (skip+1)th write of `key` after arming rejects.
const fault = vi.hoisted(() => ({ key: null as string | null, skip: 0 }));
vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    set: (key: IDBValidKey, value: unknown, store?: Parameters<typeof real.set>[2]) => {
      if (fault.key !== null && key === fault.key) {
        if (fault.skip > 0) fault.skip -= 1;
        else {
          fault.key = null;
          return Promise.reject(new Error('disk full'));
        }
      }
      return real.set(key, value, store);
    },
  };
});
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend, type GroupHistoryHandlers } from '@/src/lib/marmot/history';
import { clearAllMessageEditsState } from '@/src/lib/messageEdits/api';
import { ALICE, BOB, buildRealApp, ev, installLocalStorage, type RealApp } from './realApp';
import { append, expectOracle, runSteps, withdraw, type Step } from './oracle';

const T = 1_700_000_000;
const SLOT_META = 'few:messageEditsSlotMeta:v1';

let apps: RealApp[] = [];
let sinks: AppHistoryBackend[] = [];
const make = () => {
  const app = buildRealApp();
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  sinks = [];
  fault.key = null;
  fault.skip = 0;
  await clearAllMessageEditsState();
});
afterEach(async () => {
  for (const sink of sinks) await sink.dispose();
  for (const app of apps) await app.sink.dispose();
});

const message = (app: RealApp) => app.entry({ eventId: 'eb', account: ALICE, rumorId: 'm1', content: 'orig m1', at: T - 100 });
const edit = (app: RealApp, label: string, rev: number, content: string) =>
  app.entry({ eventId: label, kind: 9, account: ALICE, rumorId: `r-${label}`, content, tags: [['e', 'm1', '', 'edit'], ['rev', String(rev)]], at: rev });
const del = (app: RealApp, label: string, rev: number) =>
  app.entry({ eventId: label, kind: 5, account: ALICE, rumorId: `r-${label}`, content: '', tags: [['e', 'm1']], at: rev });
const row = async (app: RealApp) => (await app.messages()).find((m) => m.id === 'm1');

/** The app's group store opened by ANOTHER sink instance (a "second session" over the same rows). */
const openSink = (app: RealApp, handlers: GroupHistoryHandlers): AppHistoryBackend => {
  const sink = createHistoryBackend({ handlers, store: createIdbHistoryStore(`s5-${app.groupId}`), onError: () => undefined });
  sinks.push(sink);
  return sink;
};

type Crash = 'after-mark' | 'after-retract' | 'after-reset' | 'after-fold-row-write';
const CRASHES: Crash[] = ['after-mark', 'after-reset', 'after-fold-row-write', 'after-retract'];

/**
 * Appends `build(app)` through the app's sink, then withdraws `labels` through a sink whose withdraw is interrupted
 * at `crash`; returns the app after a second sink instance recovered the group.
 */
async function interrupted(
  build: (app: RealApp) => Step[],
  labels: string[],
  crash: Crash,
  /** Chat-row writes that complete before `after-reset` fails the next one (the reset itself, unless the retract only removes a row). */
  rowWritesBeforeCrash = 1,
): Promise<{ app: RealApp; steps: Step[] }> {
  const app = make();
  const steps = build(app);
  await runSteps(app, steps);

  let crashed = false;
  const faulty: GroupHistoryHandlers = {
    dispatch: (input) => app.dispatcher.dispatch(input),
    retract: async (input) => {
      if (crash === 'after-mark') throw new Error('crash after the mark');
      if (crash === 'after-reset') {
        // the 1st write of the chat rows during the recompute is the reset, the 2nd is the fold's
        fault.key = `few:messages:${app.groupId}`;
        fault.skip = rowWritesBeforeCrash;
      }
      if (crash === 'after-fold-row-write') fault.key = SLOT_META; // the fold's row write landed, its meta write fails
      try {
        await app.dispatcher.retract(input);
      } finally {
        fault.key = null;
      }
      if (crash === 'after-retract' && !crashed) {
        crashed = true;
        throw new Error('crash after the retract, before the rows were deleted');
      }
    },
  };
  const first = openSink(app, faulty);
  await expect(first.withdraw(app.groupId, ev(...labels))).rejects.toThrow();
  // the interrupted withdraw left the rows marked: they are no longer part of the visible history
  expect((await first.list(app.groupId)).map((e) => Buffer.from(e.eventId, 'hex').toString())).not.toContain(labels[0]);

  // a second session: startup recovery finishes the withdraw
  const second = openSink(app, app.dispatcher);
  await second.sweep();
  return { app, steps: [...steps, withdraw(...labels)] };
}

describe('(11) a withdraw interrupted at any step converges to the oracle in a new instance', () => {
  const stacked = (app: RealApp): Step[] => [
    append(message(app)),
    append(edit(app, 'e1', T, 'first')),
    append(edit(app, 'e2', T + 10, 'second')),
  ];

  for (const crash of CRASHES) {
    it(`edit withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['e2'], crash);
      await expectOracle(app, steps, make);
      expect(await row(app)).toMatchObject({ content: 'first', edited: true, rev: T });
    });

    it(`delete withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted((a) => [append(message(a)), append(edit(a, 'e1', T, 'first')), append(del(a, 'd1', T + 10))], ['d1'], crash);
      await expectOracle(app, steps, make);
      expect(await row(app)).toMatchObject({ content: 'first', edited: true });
      expect((await row(app))?.tombstoned).toBeFalsy();
    });

    it(`base message withdrawn, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['eb'], crash, 0);
      await expectOracle(app, steps, make);
      expect(await row(app)).toBeUndefined();
    });

    it(`the whole stack withdrawn in one batch, crash ${crash}`, async () => {
      const { app, steps } = await interrupted(stacked, ['e1', 'e2'], crash, 0);
      await expectOracle(app, steps, make);
      expect(await row(app)).toMatchObject({ content: 'orig m1' });
      expect((await row(app))?.original).toBeUndefined();
    });

    it(`a later unrelated recompute does not resurrect the dropped signal (crash ${crash})`, async () => {
      const { app, steps } = await interrupted(stacked, ['e2'], crash);
      // an unrelated signal and its withdrawal recompute the same slot again
      await app.sink.append(edit(app, 'e3', T + 5, 'third'));
      await app.sink.withdraw(app.groupId, ev('e3'));
      await expectOracle(app, [...steps, append(edit(app, 'e3', T + 5, 'third')), withdraw('e3')], make);
      expect(await row(app)).toMatchObject({ content: 'first', edited: true, rev: T });
    });
  }

  it('the withdraw is retried by the next withdraw call too (not only by the startup sweep)', async () => {
    const app = make();
    const steps = stacked(app);
    await runSteps(app, steps);
    const first = openSink(app, {
      dispatch: (input) => app.dispatcher.dispatch(input),
      retract: async () => {
        throw new Error('crash after the mark');
      },
    });
    await expect(first.withdraw(app.groupId, ev('e2'))).rejects.toThrow();
    // The SDK retries the original withdrawal IDs in the new instance.
    const second = openSink(app, app.dispatcher);
    await second.withdraw(app.groupId, ev('e2'));
    await expectOracle(app, [...steps, withdraw('e2')], make);
  });
});
