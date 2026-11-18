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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRelay } from '@941design/nostr-events/transport/contract/conformance';
import { createMemoryStorage, createMemoryPersistence } from '@941design/marmot/storage/memory';
import { createMarmotClient as libCreateMarmotClient, createMemoryHistoryBackend } from '@941design/marmot';
import { SimplePool } from 'nostr-tools/pool';
import { getEventHash } from 'nostr-tools/pure';
import { createPrivateKeySigner as createAppSigner } from '@/src/lib/marmot/signerAdapter';
import {
  bootstrapAccountClient,
  inboxRelayList,
  rebuildAccountForRelays,
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
    history: Object.assign(createMemoryHistoryBackend(), { sweep: async () => undefined, dispose: () => undefined }),
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


it('disposes the old client and rotates each key-package slot onto new relays on relay-settings save', async () => {
  const other = new FakeRelay();
  const otherUrl = await other.start();
  try {
    const persistence = createMemoryPersistence();
    const old = await boot({ ...baseInput(SECRET_A, persistence), inboxRelayList });
    await old.handle.client.keyPackages.create();
    const original = await old.handle.client.keyPackages.list();
    expect(original).toHaveLength(2);

    const transitions: string[] = [];
    const input = baseInput(SECRET_A, persistence);
    const next = await rebuildAccountForRelays({
      async teardown() {
        await old.teardown();
        expect(old.handle.leaseHeld()).toBe(false);
        transitions.push('disposed');
      },
    }, {
      ...input,
      relays: [otherUrl],
      seams: {
        ...input.seams,
        createMarmotClient(params) {
          expect(transitions).toEqual(['disposed']);
          expect(params.relays.defaults).toEqual([otherUrl]);
          transitions.push('created');
          return libCreateMarmotClient(params);
        },
      },
    }, [relayUrl]);
    expect(next.bootstrap.status).toBe('ready');
    if (next.bootstrap.status !== 'ready') throw new Error('Replacement bootstrap failed');
    opened.push(next.bootstrap.account);
    expect(next.rotationErrors).toEqual([]);
    expect(next.bootstrap.account.ensure.inboxRelayList).toBe('ok');
    expect(transitions).toEqual(['disposed', 'created']);

    const replacements = await next.bootstrap.account.handle.client.keyPackages.list();
    expect(replacements).toHaveLength(2);
    expect(replacements.every(({ id }) => !original.some((oldEvent) => oldEvent.id === id))).toBe(true);
    expect([...new Set(other.storedEvents.filter((event) => event.kind === 30443).map(({ id }) => id))].sort())
      .toEqual(replacements.map(({ id }) => id).sort());
    expect(other.storedEvents.find((event) => event.kind === 10050)).toMatchObject({
      content: '', tags: [['relay', otherUrl], ['client', 'few']],
    });
  } finally {
    await other.stop();
  }
}, 20_000);

it('receives a B-only inbox rumor after replacing the tagged A list on rebuild', async () => {
  const b = new FakeRelay();
  const bUrl = await b.start();
  try {
    const persistence = createMemoryPersistence();
    const old = await boot({ ...baseInput(SECRET_A, persistence), inboxRelayList });
    expect(relay.storedEvents.find((event) => event.kind === 10050)?.tags)
      .toEqual([['relay', relayUrl], ['client', 'few']]);
    const seen: string[] = [];
    const input = baseInput(SECRET_A, persistence);
    input.relays = [bUrl];
    input.inboxHandlers.inviteContext = (rumor) => { seen.push(rumor.content); };
    const result = await rebuildAccountForRelays(old, input, [relayUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    opened.push(result.bootstrap.account);
    expect(result.bootstrap.account.ensure.inboxRelayList).toBe('ok');
    const sender = await boot({ ...baseInput(SECRET_B), relays: [bUrl] });
    const draft = { pubkey: sender.handle.pubkey, kind: 21064, created_at: Math.floor(Date.now() / 1000), content: 'B-only delivery', tags: [] as string[][] };
    expect(await sender.handle.client.extensions.sendInboxRumor({
      to: old.handle.pubkey, rumor: { ...draft, id: getEventHash(draft) },
    })).toMatchObject({ status: 'delivered', relays: [bUrl] });
    await expect.poll(() => seen, { timeout: 5_000 }).toEqual(['B-only delivery']);
    expect(b.storedEvents.filter((event) => event.kind === 1059)).toHaveLength(1);
    expect(relay.storedEvents.filter((event) => event.kind === 1059)).toEqual([]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
  }
}, 20_000);

it('receives on foreign inbox C after rebuilding A to B without copying the foreign list', async () => {
  const b = new FakeRelay();
  const c = new FakeRelay();
  const bUrl = await b.start();
  const cUrl = await c.start();
  try {
    const persistence = createMemoryPersistence();
    const signer = createAppSigner(SECRET_A);
    const foreignList = await signer.signEvent({
      kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', cUrl]],
    });
    relay.publish(foreignList);
    const old = await boot({ ...baseInput(SECRET_A, persistence), inboxRelayList });
    const seen: string[] = [];
    const input = baseInput(SECRET_A, persistence);
    input.relays = [bUrl];
    input.inboxHandlers.inviteContext = (rumor) => { seen.push(rumor.content); };
    input.seams!.createMarmotClient = (params) => {
      expect(params.relays.defaults).toEqual([bUrl]);
      return libCreateMarmotClient(params);
    };
    const result = await rebuildAccountForRelays(old, input, [relayUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    opened.push(result.bootstrap.account);
    expect(result.bootstrap.account.ensure.inboxRelayList).toBe('ok');

    const sender = await boot(baseInput(SECRET_B));
    const draft = {
      pubkey: sender.handle.pubkey, kind: 21064, created_at: Math.floor(Date.now() / 1000),
      content: 'C-only delivery', tags: [] as string[][],
    };
    expect(await sender.handle.client.extensions.sendInboxRumor({
      to: old.handle.pubkey, rumor: { ...draft, id: getEventHash(draft) },
    })).toMatchObject({ status: 'delivered', relays: [cUrl] });
    await expect.poll(() => seen, { timeout: 10_000 }).toEqual(['C-only delivery']);
    expect(c.storedEvents.filter((event) => event.kind === 1059)).toHaveLength(1);
    expect([relay, b].flatMap((r) => r.storedEvents).filter((event) => event.kind === 1059)).toEqual([]);
    expect(b.storedEvents.filter((event) => event.kind === 10050 && event.pubkey === old.handle.pubkey)).toEqual([]);
    expect(relay.storedEvents.filter((event) => event.kind === 10050 && event.pubkey === old.handle.pubkey))
      .toEqual([foreignList]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
    await c.stop();
  }
}, 20_000);

it.each([true, false])('rotation uses the new relay acknowledgments when old NIP-65 writes reject (new accepts: %s)', async (acceptNew) => {
  const rejecting = new FakeRelay({ publishOk: () => ({ ok: false, message: 'blocked: old writes disabled' }) });
  const b = new FakeRelay({ publishOk: (event) => ({
    ok: event.kind !== 30443 || acceptNew, message: 'blocked: new writes disabled',
  }) });
  const oldWriteUrl = await rejecting.start();
  const bUrl = await b.start();
  try {
    const persistence = createMemoryPersistence();
    const old = await boot({ ...baseInput(SECRET_A, persistence), inboxRelayList });
    const originals = await old.handle.client.keyPackages.list();
    const nip65 = await createAppSigner(SECRET_A).signEvent({
      kind: 10002, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['r', oldWriteUrl, 'write']],
    });
    b.publish(nip65);
    const result = await rebuildAccountForRelays(old, {
      ...baseInput(SECRET_A, persistence), relays: [bUrl],
    }, [relayUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    const account = result.bootstrap.account;
    opened.push(account);
    const replacements = b.storedEvents.filter((event) => event.kind === 30443);
    if (acceptNew) {
      expect(result.rotationErrors).toEqual([]);
      expect(replacements).toHaveLength(originals.length);
      expect(replacements.every((event) => !originals.some((oldEvent) => oldEvent.id === event.id))).toBe(true);
      expect((await account.handle.client.keyPackages.list()).map(({ id }) => id).sort())
        .toEqual(replacements.map(({ id }) => id).sort());
    } else {
      expect(result.rotationErrors).toHaveLength(originals.length);
      expect(replacements).toEqual([]);
      expect((await account.handle.client.keyPackages.list()).map(({ id }) => id))
        .toEqual(originals.map(({ id }) => id));
    }
    // The override ends with the rebuild; normal own NIP-65 discovery survives.
    const lookup = await account.transport.requestWithDeadline([bUrl], {
      kinds: [10002], authors: [account.handle.pubkey],
    }, { timeoutMs: 500 });
    expect(lookup.events.map(({ id }) => id)).toContain(nip65.id);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await rejecting.stop();
    await b.stop();
  }
}, 20_000);

it.each(['first boot', 'rebuild'] as const)('receives on a foreign C inbox during %s when a configured relay times out', async (mode) => {
  const b = new FakeRelay();
  const c = new FakeRelay();
  const bUrl = await b.start();
  const cUrl = await c.start();
  const silentUrl = 'wss://silent-current.example';
  try {
    const foreignList = await createAppSigner(SECRET_A).signEvent({
      kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', cUrl]],
    });
    b.publish(foreignList);
    const seen: string[] = [];
    const input = baseInput(SECRET_A);
    input.relays = [bUrl, silentUrl];
    input.inboxRelayList = inboxRelayList;
    input.inboxHandlers.inviteContext = (rumor) => { seen.push(rumor.content); };
    input.seams!.createTransport = (relays) => {
      const network = createClientTransport({ relays });
      const real = network.transport;
      return { ...network, transport: { ...real, async requestWithDeadline(targets, filters, opts) {
        const available = targets.filter((target) => target !== silentUrl);
        const result = available.length ? await real.requestWithDeadline(available, filters, opts)
          : { events: [], timedOut: false, eosedRelays: [], silentRelays: [] };
        return targets.includes(silentUrl)
          ? { ...result, timedOut: true, silentRelays: [...result.silentRelays, silentUrl] }
          : result;
      } } };
    };
    let account: AccountClient;
    if (mode === 'first boot') {
      account = await boot(input);
    } else {
      const result = await rebuildAccountForRelays(null, input, [relayUrl]);
      if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
      expect(result.inboxRelayListFailure).toBeUndefined();
      account = result.bootstrap.account;
      opened.push(account);
    }
    expect(account.ensure.inboxRelayList).toBe('ok');
    const sender = await boot({ ...baseInput(SECRET_B), relays: [bUrl] });
    const draft = { pubkey: sender.handle.pubkey, kind: 21064, created_at: Math.floor(Date.now() / 1000), content: 'partial C delivery', tags: [] as string[][] };
    expect(await sender.handle.client.extensions.sendInboxRumor({
      to: account.handle.pubkey, rumor: { ...draft, id: getEventHash(draft) },
    })).toMatchObject({ status: 'delivered', relays: [cUrl] });
    await expect.poll(() => seen, { timeout: 5_000 }).toEqual(['partial C delivery']);
    expect(c.storedEvents.filter((event) => event.kind === 1059)).toHaveLength(1);
    expect(b.storedEvents.filter((event) => event.kind === 10050)).toEqual([foreignList]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
    await c.stop();
  }
}, 20_000);

it('receives on the verified B inbox when the previous relay times out', async () => {
  const b = new FakeRelay();
  const c = new FakeRelay();
  const bUrl = await b.start();
  const cUrl = await c.start();
  const oldUrl = 'wss://old-timeout.example';
  try {
    const foreignList = await createAppSigner(SECRET_A).signEvent({
      kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', cUrl]],
    });
    b.publish(foreignList);
    relay.publish(foreignList);
    const seen: string[] = [];
    const input = baseInput(SECRET_A);
    input.relays = [bUrl];
    input.inboxHandlers.inviteContext = (rumor) => { seen.push(rumor.content); };
    input.seams!.createTransport = (relays) => {
      const network = createClientTransport({ relays });
      const real = network.transport;
      return { ...network, transport: { ...real, async requestWithDeadline(targets, filters, opts) {
        const current = targets.filter((target) => target !== oldUrl);
        const result = current.length ? await real.requestWithDeadline(current, filters, opts)
          : { events: [], timedOut: false, eosedRelays: [], silentRelays: [] };
        return targets.includes(oldUrl)
          ? { ...result, timedOut: true, silentRelays: [...result.silentRelays, oldUrl] }
          : result;
      } } };
    };
    const result = await rebuildAccountForRelays({ teardown: async () => {} }, input, [oldUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    opened.push(result.bootstrap.account);
    const sender = await boot(baseInput(SECRET_B));
    const draft = { pubkey: sender.handle.pubkey, kind: 21064, created_at: Math.floor(Date.now() / 1000), content: 'delivery on C', tags: [] as string[][] };
    expect(await sender.handle.client.extensions.sendInboxRumor({
      to: result.bootstrap.account.handle.pubkey, rumor: { ...draft, id: getEventHash(draft) },
    })).toMatchObject({ status: 'delivered', relays: [cUrl] });
    await expect.poll(() => seen, { timeout: 10_000 }).toContain('delivery on C');
    expect(b.storedEvents.filter((event) => event.kind === 10050)).toEqual([foreignList]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
    await c.stop();
  }
}, 20_000);

it('bootstraps an empty key-package store on B despite an obsolete NIP-65 write list', async () => {
  const b = new FakeRelay();
  const oldWrite = new FakeRelay({ publishOk: () => ({ ok: false, message: 'blocked' }) });
  const bUrl = await b.start();
  const oldWriteUrl = await oldWrite.start();
  try {
    b.publish(await createAppSigner(SECRET_A).signEvent({
      kind: 10002, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['r', oldWriteUrl, 'write']],
    }));
    const result = await rebuildAccountForRelays({ teardown: async () => {} }, {
      ...baseInput(SECRET_A), relays: [bUrl],
    }, [relayUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    opened.push(result.bootstrap.account);
    expect(result.bootstrap.account.ensure.keyPackage).toBe('created');
    expect(result.rotationErrors).toEqual([]);
    expect(b.storedEvents.some((event) => event.kind === 30443)).toBe(true);
    expect(await result.bootstrap.account.handle.client.keyPackages.list()).toHaveLength(1);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
    await oldWrite.stop();
  }
}, 20_000);

it.each(['previous', 'configured'] as const)('does not overwrite a B list when the %s relay lookup is incomplete', async (silentSet) => {
  const b = new FakeRelay();
  const bUrl = await b.start();
  const oldUrl = 'wss://old-timeout.example';
  try {
    const existing = await createAppSigner(SECRET_A).signEvent({
      kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['relay', bUrl], ['client', 'few']],
    });
    b.publish(existing);
    const input = baseInput(SECRET_A);
    input.relays = silentSet === 'configured' ? [bUrl, oldUrl] : [bUrl];
    input.onError = () => {};
    let inboxStart: ReturnType<typeof vi.spyOn>;
    let inboxStop: ReturnType<typeof vi.spyOn>;
    input.seams!.createMarmotClient = (params) => {
      const client = libCreateMarmotClient(params);
      inboxStart = vi.spyOn(client.inbox, 'start');
      inboxStop = vi.spyOn(client.inbox, 'stop');
      return client;
    };
    input.seams!.createTransport = (relays) => {
      const network = createClientTransport({ relays });
      const real = network.transport;
      return { ...network, transport: { ...real, async requestWithDeadline(targets, filters, opts) {
        const current = targets.filter((target) => target !== oldUrl);
        const result = current.length ? await real.requestWithDeadline(current, filters, opts)
          : { events: [], timedOut: false, eosedRelays: [], silentRelays: [] };
        return targets.includes(oldUrl)
          ? { ...result, timedOut: true, silentRelays: [...result.silentRelays, oldUrl] }
          : result;
      } } };
    };
    const result = await rebuildAccountForRelays({ teardown: async () => {} }, input, silentSet === 'configured' ? [relayUrl] : [oldUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    opened.push(result.bootstrap.account);
    expect(result.bootstrap.account.ensure.inboxRelayList).toBe('failed');
    expect(result.inboxRelayListFailure?.error).toEqual(expect.objectContaining({ message: 'Inbox relay list lookup did not complete' }));
    expect(inboxStart!).toHaveBeenCalledTimes(1);
    expect(inboxStop!).not.toHaveBeenCalled();
    const lookup = await result.bootstrap.account.transport.requestWithDeadline([...input.relays], {
      kinds: [10050], authors: [result.bootstrap.account.handle.pubkey],
    }, { timeoutMs: 500 });
    expect(lookup.timedOut).toBe(true);
    expect(b.storedEvents.filter((event) => event.kind === 10050)).toEqual([existing]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
  }
}, 20_000);

it('retains account-scoped discovery across A-to-B rebuild and a cold boot, receiving on foreign C', async () => {
  const b = new FakeRelay();
  const c = new FakeRelay();
  const bUrl = await b.start();
  const cUrl = await c.start();
  const records = new Map<string, string[]>();
  const discoverySourcesStore = {
    load: (pubkey: string) => records.get(pubkey) ?? [],
    save: (pubkey: string, relays: readonly string[]) => { records.set(pubkey, [...relays]); },
  };
  const persistence = createMemoryPersistence();
  try {
    const foreign = await createAppSigner(SECRET_A).signEvent({
      kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', cUrl]],
    });
    relay.publish(foreign);
    const old = await boot({ ...baseInput(SECRET_A, persistence), discoverySourcesStore, inboxRelayList });
    const result = await rebuildAccountForRelays(old, {
      ...baseInput(SECRET_A, persistence), relays: [bUrl], discoverySourcesStore, inboxRelayList,
    }, [relayUrl]);
    if (result.bootstrap.status !== 'ready') throw new Error('Rebuild failed');
    expect(result.bootstrap.account.ensure.inboxRelayList).toBe('ok');
    await result.bootstrap.account.teardown();

    const seen: string[] = [];
    const resolved: string[] = [];
    const coldInput: BootstrapInput = { ...baseInput(SECRET_A, persistence), relays: [bUrl], discoverySourcesStore, inboxRelayList };
    coldInput.inboxHandlers.inviteContext = (rumor) => { seen.push(rumor.content); };
    const openStores = coldInput.seams!.openStores!;
    coldInput.onAccountResolved = async (pubkey) => { resolved.push(pubkey); };
    coldInput.seams!.openStores = (pubkey) => {
      expect(resolved).toEqual([pubkey]);
      return openStores(pubkey);
    };
    const cold = await boot(coldInput);
    expect(cold.ensure.inboxRelayList).toBe('ok');
    expect(records.get(cold.handle.pubkey)).toEqual([relayUrl, bUrl]);
    const sender = await boot({ ...baseInput(SECRET_B), discoverySourcesStore });
    expect(records.get(sender.handle.pubkey)).toEqual([relayUrl]);
    const draft = { pubkey: sender.handle.pubkey, kind: 21064, created_at: Math.floor(Date.now() / 1000), content: 'cold C delivery', tags: [] as string[][] };
    expect(await sender.handle.client.extensions.sendInboxRumor({
      to: cold.handle.pubkey, rumor: { ...draft, id: getEventHash(draft) },
    })).toMatchObject({ status: 'delivered', relays: [cUrl] });
    await expect.poll(() => seen, { timeout: 10_000 }).toEqual(['cold C delivery']);
    expect(c.storedEvents.filter((event) => event.kind === 1059)).toHaveLength(1);
    expect([relay, b].flatMap((r) => r.storedEvents).filter((event) => event.kind === 1059)).toEqual([]);
    expect(relay.storedEvents.filter((event) => event.kind === 10050 && event.pubkey === cold.handle.pubkey)).toEqual([foreign]);
    expect(b.storedEvents.filter((event) => event.kind === 10050 && event.pubkey === cold.handle.pubkey)).toEqual([]);
  } finally {
    for (const account of opened.splice(0)) await account.teardown();
    await b.stop();
    await c.stop();
  }
}, 25_000);

it('does not publish on cold boot when a saved discovery source gives only a partial lookup', async () => {
  const silent = 'wss://silent-discovery.example';
  const persistence = createMemoryPersistence();
  const records = new Map<string, string[]>();
  const discoverySourcesStore = {
    load: (pubkey: string) => records.get(pubkey) ?? [],
    save: (pubkey: string, relays: readonly string[]) => { records.set(pubkey, [...relays]); },
  };
  const pubkey = await createAppSigner(SECRET_A).getPublicKey();
  records.set(pubkey, [silent]);
  const input: BootstrapInput = { ...baseInput(SECRET_A, persistence), discoverySourcesStore, inboxRelayList, onError: () => {} };
  input.seams!.createTransport = (relays) => {
    const network = createClientTransport({ relays });
    const real = network.transport;
    return { ...network, transport: { ...real, async requestWithDeadline(targets, filters, opts) {
      const available = targets.filter((target) => target !== silent);
      const result = available.length ? await real.requestWithDeadline(available, filters, opts)
        : { events: [], timedOut: false, eosedRelays: [], silentRelays: [] };
      return targets.includes(silent) ? { ...result, timedOut: true, silentRelays: [...result.silentRelays, silent] } : result;
    } } };
  };
  const account = await boot(input);
  expect(account.ensure.inboxRelayList).toBe('failed');
  expect(relay.storedEvents.filter((event) => event.kind === 10050 && event.pubkey === pubkey)).toEqual([]);
}, 20_000);
