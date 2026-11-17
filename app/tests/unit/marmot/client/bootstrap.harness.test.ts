// @vitest-environment node
/**
 * Library harness for the client bootstrap: REAL @941design/marmot clients over
 * createMemoryStorage() and a FakeRelay (real WebSocket server), real SimplePool
 * transport. Covers AC-BOOT-1 (order, against the real client), AC-BOOT-2
 * (key-package ensure on the relay), AC-BOOT-3 (two-account isolation) and
 * AC-TRANS-1: the library client's publish/subscribe go through the app-owned
 * pool (a spy over a real SimplePool) and teardown destroys it exactly once,
 * after client.dispose().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMarmotClient as libCreateMarmotClient, createMemoryHistoryBackend } from '@941design/marmot';
import { SimplePool } from 'nostr-tools/pool';
import { createPrivateKeySigner as createAppSigner } from '@/src/lib/marmot/signerAdapter';
import {
  bootstrapAccountClient,
  type AccountClient,
  type BootstrapInput,
} from '@/src/lib/marmot/client';
import { openAccountStores } from '@/src/lib/marmot/client/storage';
import { createClientTransport, type ClientPool } from '@/src/lib/marmot/client/transport';

const SECRET_A = '11'.repeat(32);
const SECRET_B = '22'.repeat(32);

let relay: FakeRelay;
let relayUrl: string;
const opened: AccountClient[] = [];

beforeEach(async () => {
  relay = new FakeRelay();
  relayUrl = await relay.start();
});

afterEach(async () => {
  for (const a of opened.splice(0)) await a.teardown().catch(() => undefined);
  await relay.stop();
});

function baseInput(secret: string, persistence = createMemoryPersistence(), calls: string[] = []): BootstrapInput {
  const backend = createMemoryStorage({ persistence, leaseTimeoutMs: 200 });
  return {
    eventSigner: createAppSigner(secret),
    signerKind: 'local',
    relays: [relayUrl],
    history: createMemoryHistoryBackend(),
    clientEvents: {
      groupRemoved: () => calls.push('groupRemoved'),
      inboxDisposition: () => calls.push('inboxDisposition'),
      welcomeDeclined: () => calls.push('welcomeDeclined'),
      intentFailed: () => calls.push('intentFailed'),
      storeIncompatible: () => calls.push('storeIncompatible'),
      groupBranchSwitched: () => calls.push('groupBranchSwitched'),
    },
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: () => undefined,
    inboxRelayList: { ensure: async () => { calls.push('10050'); } },
    clientOptions: { historyTimeoutMs: 500, historySilenceThreshold: 1 },
    seams: {
      isSecureContext: () => true,
      openStores: (pk) => openAccountStores(pk, backend, { leaseTimeoutMs: 200 }),
    },
  };
}

async function boot(input: BootstrapInput): Promise<AccountClient> {
  const result = await bootstrapAccountClient(input);
  if (result.status !== 'ready') throw new Error(`bootstrap not ready: ${JSON.stringify(result)}`);
  opened.push(result.account);
  return result.account;
}

describe('bootstrap against real library clients (AC-BOOT-2, AC-TRANS-1)', () => {
  it('creates exactly one kind-30443 key package (no kind 443) and calls the 10050 port once', async () => {
    const calls: string[] = [];
    const account = await boot(baseInput(SECRET_A, undefined, calls));
    expect(account.ensure).toEqual({ keyPackage: 'created', inboxRelayList: 'ok' });
    expect(calls.filter((c) => c === '10050')).toHaveLength(1);

    const kps = relay.storedEvents.filter((e) => e.kind === 30443);
    expect(kps).toHaveLength(1);
    expect(kps[0].pubkey).toBe(account.handle.pubkey);
    expect(relay.storedEvents.filter((e) => e.kind === 443)).toHaveLength(0);
  });

  it('does not create a second key package when one exists (restart over the same stores)', async () => {
    const persistence = createMemoryPersistence();
    const first = await boot(baseInput(SECRET_A, persistence));
    await first.teardown();
    opened.length = 0;
    const second = await boot(baseInput(SECRET_A, persistence));
    expect(second.ensure.keyPackage).toBe('present');
    expect(relay.storedEvents.filter((e) => e.kind === 30443)).toHaveLength(1);
  });

  it('exposes a live handle: leaseHeld flips to false after teardown and the client throws disposed', async () => {
    const account = await boot(baseInput(SECRET_A));
    expect(account.handle.leaseHeld()).toBe(true);
    await account.teardown();
    expect(account.handle.leaseHeld()).toBe(false);
    expect(() => account.handle.client.groups.list()).toThrow(/dispos/i);
  });
});

describe('the app-owned pool carries the library client (AC-TRANS-1)', () => {
  /** A real SimplePool whose members are recorded into `log`. */
  function spyPool(log: string[]): ClientPool {
    const real = new SimplePool();
    return {
      publish: (...a) => { log.push('pool.publish'); return real.publish(...a); },
      subscribeMany: (...a) => { log.push('pool.subscribeMany'); return real.subscribeMany(...a); },
      subscribeManyEose: (...a) => { log.push('pool.subscribeManyEose'); return real.subscribeManyEose(...a); },
      ensureRelay: (...a) => { log.push('pool.ensureRelay'); return real.ensureRelay(...a); },
      get maxWaitForConnection() { return real.maxWaitForConnection; },
      set maxWaitForConnection(v: number) { real.maxWaitForConnection = v; },
      close: (...a) => { log.push('pool.close'); return real.close(...a); },
      destroy: () => { log.push('pool.destroy'); return real.destroy(); },
    } as ClientPool;
  }

  it('publish and subscribe go through the injected pool; teardown destroys it once, after client.dispose()', async () => {
    const log: string[] = [];
    const input = baseInput(SECRET_A);
    input.seams = {
      ...input.seams,
      createTransport: (relays) => createClientTransport({ relays, createPool: () => spyPool(log) }),
      createMarmotClient: ((o: Parameters<typeof libCreateMarmotClient>[0]) => {
        const client = libCreateMarmotClient(o);
        const dispose = client.dispose.bind(client);
        client.dispose = () => { log.push('client.dispose'); return dispose(); };
        return client;
      }) as typeof libCreateMarmotClient,
    };
    const account = await boot(input);
    // Bootstrap created a key package (publish) and started the inbox (subscription): both over our pool.
    expect(relay.storedEvents.some((e) => e.kind === 30443)).toBe(true);
    expect(log).toContain('pool.publish');
    expect(log.some((l) => l === 'pool.subscribeMany' || l === 'pool.subscribeManyEose')).toBe(true);
    expect(log).not.toContain('pool.destroy');

    await account.teardown();
    await account.teardown(); // idempotent
    expect(log.filter((l) => l === 'pool.destroy')).toHaveLength(1);
    expect(log.filter((l) => l === 'client.dispose')).toHaveLength(1);
    expect(log.indexOf('client.dispose')).toBeLessThan(log.indexOf('pool.destroy'));
  });
});

describe('two accounts over one persistence (AC-BOOT-3)', () => {
  it('account B sees none of account A\'s groups', async () => {
    const persistence = createMemoryPersistence();
    const a = await boot(baseInput(SECRET_A, persistence));
    const group = await a.handle.client.groups.create('Only A');
    const groupId = group.id;
    expect((await a.handle.client.groups.list()).map((g) => g.id)).toContain(groupId);
    await a.teardown();
    opened.length = 0;

    const b = await boot(baseInput(SECRET_B, persistence));
    expect(b.handle.pubkey).not.toBe(a.handle.pubkey);
    expect((await b.handle.client.groups.list()).map((g) => g.id)).not.toContain(groupId);
    expect(b.groups).toHaveLength(0);

    // and A, on reopening, still has its group
    await b.teardown();
    opened.length = 0;
    const a2 = await boot(baseInput(SECRET_A, persistence));
    expect(a2.groups.map((g) => g.id)).toContain(groupId);
  });
});

describe('group notifications attach (AC-BOOT-1 step 7)', () => {
  it('attachGroup wires a listener that receives the own confirmed message', async () => {
    const seen: string[] = [];
    const input = baseInput(SECRET_A);
    input.onGroupNotification = (_g, n) => { seen.push(n.type); };
    const account = await boot(input);
    const group = await account.handle.client.groups.create('Chat');
    account.attachGroup(group);
    account.attachGroup(group); // idempotent
    const { getEventHash } = await import('nostr-tools/pure');
    const rumor = { pubkey: account.handle.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 9, tags: [] as string[][], content: 'hello' };
    const id = getEventHash(rumor);
    await group.send({ type: 'application', rumor: { ...rumor, id } });
    await expect.poll(() => seen.filter((t) => t === 'message').length, { timeout: 10_000 }).toBe(1);
  });
});

describe('structural attach against the real library (groupCreated / groupJoined, rejoin)', () => {
  async function keyPackageOf(from: AccountClient, pubkey: string) {
    return new Promise<import('@941design/nostr-events/event').NostrEvent>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('no key package observed')); }, 15_000);
      const stop = from.handle.client.keyPackages.observe(pubkey, (event) => {
        clearTimeout(timer);
        queueMicrotask(stop);
        resolve(event);
      });
    });
  }
  async function sendKind9(account: AccountClient, group: Awaited<ReturnType<AccountClient['handle']['client']['groups']['create']>>, content: string) {
    const { getEventHash } = await import('nostr-tools/pure');
    const rumor = { pubkey: account.handle.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 9, tags: [] as string[][], content };
    await group.send({ type: 'application', rumor: { ...rumor, id: getEventHash(rumor) } });
  }

  it('create -> join -> abandon -> rejoin the same group id: the notification listener is attached to every handle without any attachGroup call', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const inputA = baseInput(SECRET_A);
    inputA.onGroupNotification = (g, n) => { seenA.push(`${g.id}:${n.type}`); };
    const inputB = baseInput(SECRET_B);
    inputB.onGroupNotification = (g, n) => { seenB.push(`${g.id}:${n.type}`); };
    const a = await boot(inputA);
    const b = await boot(inputB);

    // created group: attached structurally (the app never calls attachGroup here)
    const groupA = await a.handle.client.groups.create('Rejoin', { admins: [b.handle.pubkey] });
    const gid = groupA.id;
    const kp = await keyPackageOf(a, b.handle.pubkey);
    await groupA.synced();
    expect((await groupA.invite([kp]))[0].status).toBe('delivered');
    await expect.poll(async () => (await b.handle.client.invitations.pending()).length, { timeout: 15_000 }).toBe(1);
    const joined1 = await b.handle.client.invitations.accept((await b.handle.client.invitations.pending())[0].id);
    expect(joined1.id).toBe(gid);

    await sendKind9(a, groupA, 'one');
    await expect.poll(() => seenB.filter((s) => s === `${gid}:message`).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(seenA.some((s) => s === `${gid}:message`)).toBe(true);

    // B abandons; A removes B and invites again; B rejoins the SAME group id with a NEW handle
    await joined1.abandon();
    await groupA.removeMember(b.handle.pubkey);
    await groupA.synced();
    expect((await groupA.invite([await keyPackageOf(a, b.handle.pubkey)]))[0].status).toBe('delivered');
    await expect.poll(async () => (await b.handle.client.invitations.pending()).length, { timeout: 15_000 }).toBe(1);
    const joined2 = await b.handle.client.invitations.accept((await b.handle.client.invitations.pending())[0].id);
    expect(joined2.id).toBe(gid);
    expect(joined2 === joined1).toBe(false);

    const before = seenB.filter((s) => s === `${gid}:message`).length;
    await sendKind9(a, groupA, 'two');
    await expect.poll(() => seenB.filter((s) => s === `${gid}:message`).length, { timeout: 15_000 }).toBeGreaterThan(before);
  });
});
