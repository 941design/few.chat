// @vitest-environment node
import 'fake-indexeddb/auto';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { startAccountLifecycle } from '@/src/lib/marmot/client/lease';
import { createGroupSessionMembership } from '@/src/lib/marmot/groupSessionMembership';
import { createJobQueue } from '@/src/lib/marmot/client/fifo';
import { createStoreWipeGuard } from '@/src/lib/marmot/client/wipe';
import { createTeardown } from '@/src/lib/marmot/client/lifecycle';

it('AC-OBS-5: lifecycle gates membership work across lease transitions', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('acquire', 'other-tab', 'release', 'incompatible', 'sign-out', 'signer-change', 'relay-save', 'lose-during-create', 'lose-during-list'), { minLength: 1, maxLength: 20 }), async ops => {
      let available = false, held = false, marker: any, intent: any, wipes = 0;
      let session: ReturnType<typeof createGroupSessionMembership> | undefined;
      let currentInput: any;
      const trace: string[] = [], errors: unknown[] = [];
      const guard = createStoreWipeGuard();
      const stores = { lease: { get held() { return held; } }, account: { account: 'account', wipeMarker: async () => marker, wipe: async () => { expect(held).toBe(true); wipes++; marker = { at: Date.now(), reason: 'incompatible', engine: 'e', tsMls: 't' }; return marker; } } };
      const checkpoint = { read: async () => intent, write: async (_pk: string, previousMarker: any) => { intent = { previousMarker }; }, clear: async () => { intent = undefined; } };
      const own = 'ab'.repeat(32);
      const group = { id: 'lease-property', name: 'Test', members: () => { expect(held).toBe(true); return [own]; }, activeAdmins: () => [own], relays: [], leaves: () => [] };
      let writes = 0;
      let createGate: Promise<void> | undefined;
      const start = async (input: any) => {
        currentInput = input;
        if (!available) return { status: 'lease-held' as const };
        held = true;
        const jobs = createJobQueue();
        const handle = { pubkey: own, leaseHeld: () => held, enqueue: jobs.enqueue, client: { groups: { get: async () => group, create: async () => { expect(held).toBe(true); writes++; await createGate; return group; } }, invitations: { pending: async () => [], accept: async () => group, decline: async () => {} }, extensions: { sendInboxRumor: async () => ({ status: 'delivered' }) } } };
        const membership = createGroupSessionMembership({ handle, transport: { requestWithDeadline: async () => {} }, defaultRelays: ['wss://relay.example'], history: { purge: async () => {} }, sender: { forgetGroup: () => {}, sendGroupRumor: async () => ({}) }, attachGroup: () => {}, onJoined: () => {}, onGroupsChanged: () => {}, onInvitationsChanged: () => {}, onJoinRequestsChanged: () => {}, onLeaveFailed: () => {}, onLastAdminBlocked: () => {}, onError: (e: unknown) => errors.push(e) } as never);
        session = membership;
        const teardown = createTeardown({ client: { dispose: () => { trace.push('dispose'); } }, stores: { close: async () => { await input.beforeStoresClose(stores); trace.push('close'); held = false; } }, closePool: () => {}, queue: { dispose: () => jobs.dispose() }, history: { dispose: () => {} }, unsubscribers: [() => { void membership.dispose(); }] });
        return { status: 'ready' as const, account: { handle, ensure: { keyPackage: 'present' }, teardown } as never };
      };
      const make = () => startAccountLifecycle({ makeInput: signal => ({ signal, clientEvents: { storeIncompatible: () => {} } }) as never, start, wipeGuard: guard, wipeCheckpoint: checkpoint, clearAllGroupData: async () => { expect(held).toBe(true); }, onState: () => {}, onError: e => errors.push(e), pollMs: 10 });
      let lifecycle = make();
      await lifecycle.whenReady();
      try {
        for (const op of ops) {
          if (op === 'acquire') available = true;
          if (op === 'other-tab' || op === 'release') { available = false; held = false; }
          if ((op === 'other-tab' || op === 'release') && session) {
            const before = writes;
            await expect(session.create('Test')).rejects.toThrow('not writable');
            await expect(session.syncListed([group as never])).rejects.toThrow('not writable');
            expect(writes).toBe(before);
          }
          if (op === 'lose-during-create' && session && held) {
            let finishCreate!: () => void;
            createGate = new Promise<void>((resolve) => { finishCreate = resolve; });
            const rejected = expect(session.create('Test')).rejects.toThrow('not writable');
            available = false;
            held = false;
            finishCreate();
            await rejected;
            createGate = undefined;
          }
          if (op === 'lose-during-list' && session && held) {
            const listing = session.syncListed([group as never]);
            available = false;
            held = false;
            await listing;
          }
          if (op === 'incompatible' && held) currentInput.clientEvents.storeIncompatible({});
          if (op === 'sign-out' || op === 'signer-change' || op === 'relay-save') { await lifecycle.stop(); session = undefined; lifecycle = make(); }
          await vi.advanceTimersByTimeAsync(25);
          if (session) {
            const before = writes;
            if (held) { await session.create('Test'); await session.syncListed([group as never]); expect(writes).toBe(before + 1); }
            else { await expect(session.create('Test')).rejects.toThrow('not writable'); await expect(session.syncListed([group as never])).rejects.toThrow('not writable'); expect(writes).toBe(before); }
          }
          expect(wipes).toBeLessThanOrEqual(1);
        }
      } finally { await lifecycle.stop(); }
      if (errors.length) throw errors[0];
      expect(trace.length % 2).toBe(0);
      for (let i = 0; i < trace.length; i += 2) expect(trace.slice(i, i + 2)).toEqual(['dispose', 'close']);
    }), { seed: 190606, numRuns: 200 });
  } finally { vi.useRealTimers(); }
}, 30000);

it('AC-OBS-5: teardown disposes before closing across repeated stops', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('sign-out', 'signer-change', 'relay-save'), {minLength: 1, maxLength: 30}), async ops => {
    const trace: string[] = [];
    const teardown = createTeardown({ client: { dispose: () => { trace.push('dispose'); } }, stores: { close: async () => { trace.push('close'); } }, closePool: () => {}, queue: { dispose: () => {} }, history: { dispose: () => {} }, unsubscribers: [] });
    for (const op of ops) if (op !== 'relay-save') await teardown();
    await teardown();
    expect(trace).toEqual(['dispose', 'close']);
  }), {seed: 190607, numRuns: 200});
});
