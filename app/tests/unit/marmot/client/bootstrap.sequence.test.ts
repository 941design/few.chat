/**
 * Bootstrap with a recording fake client (AC-BOOT-1 order, AC-BOOT-2 key-package
 * decision, AC-BOOT-3 teardown order, AC-BOOT-4 listeners, AC-BOOT-6 options,
 * AC-SIGN-5 secure-context gate, AC-SIGN-2 "no client constructed", plus the
 * loud-failure contract for missing collaborators).
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { MarmotError } from '@941design/marmot';
import {
  bootstrapAccountClient,
  CLIENT_EVENT_NAMES,
  HISTORY_SWEEP_WAIT_MS,
  type AccountClientHandle,
  type BootstrapInput,
  type ClientCallbackScope,
} from '@/src/lib/marmot/client';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { APP_INBOX_KINDS } from '@/src/lib/marmot/kinds';

const PUBKEY_SECRET = '55'.repeat(32);

function makeRig(opts: { keyPackageCount?: number; groups?: Array<{ id: string }>; failStep?: string; sweep?: () => Promise<unknown> } = {}) {
  const log: string[] = [];
  const listeners = new Map<string, (p: unknown) => void>();
  const groupListeners = new Map<string, (n: unknown) => void>();
  let capturedOptions: Record<string, unknown> | undefined;
  let capturedAll: Record<string, unknown> | undefined;
  let capturedSigner: unknown;
  let capturedBudget: unknown;
  let createCalls = 0;

  const makeGroup = (g: { id: string }) => ({
    id: g.id,
    onNotification: (l: (n: unknown) => void) => {
      log.push(`group.onNotification:${g.id}`);
      groupListeners.set(g.id, l);
      return () => log.push(`group.unsub:${g.id}`);
    },
  });
  const groups = (opts.groups ?? []).map(makeGroup);
  /** Handles `groups.get` returns (tests register late groups here). */
  const lateGroups = new Map<string, ReturnType<typeof makeGroup>>();

  const fakeClient = {
    on: (name: string, l: (p: unknown) => void) => {
      log.push(`client.on:${name}`);
      listeners.set(name, l);
      return () => log.push(`client.off:${name}`);
    },
    extensions: {
      registerInboxHandler: (kind: number) => {
        log.push(`registerInboxHandler:${kind}`);
        return () => log.push(`unregister:${kind}`);
      },
    },
    groups: {
      get: async (id: string) => { log.push(`groups.get:${id}`); return lateGroups.get(id); },
      list: async () => { log.push('groups.list'); await Promise.resolve(); log.push('groups.list.resolved'); return groups; },
    },
    inbox: { start: async () => { log.push('inbox.start'); if (opts.failStep === 'inbox.start') throw new Error('inbox boom'); } },
    keyPackages: {
      count: async () => { log.push('keyPackages.count'); return opts.keyPackageCount ?? 0; },
      create: async (o: unknown) => { log.push(`keyPackages.create:${JSON.stringify(o)}`); return {}; },
    },
    dispose: () => log.push('client.dispose'),
  };
  const stores = {
    lease: { held: true },
    close: async () => { log.push('stores.close'); },
    account: {},
    groupFactory: () => ({}),
  };

  const input: BootstrapInput = {
    eventSigner: createPrivateKeySigner(PUBKEY_SECRET),
    signerKind: 'local',
    relays: ['wss://relay.example'],
    history: {
      append: () => undefined,
      withdraw: () => undefined,
      list: () => [],
      purge: () => undefined,
      dispose: () => { log.push('history.dispose'); },
      sweep: async () => {
        log.push('history.sweep');
        await (opts.sweep ?? (() => Promise.resolve()))();
        log.push('history.sweep.settled');
      },
    },
    clientEvents: Object.fromEntries(
      CLIENT_EVENT_NAMES.map((n) => [n, (p: unknown) => log.push(`handler:${n}:${JSON.stringify(p)}`)]),
    ) as unknown as BootstrapInput['clientEvents'],
    inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
    onGroupNotification: (g, n) => log.push(`appGroupNotification:${g.id}:${(n as { type: string }).type}`),
    inboxRelayList: { ensure: async (ctx) => { log.push(`inboxRelayList.ensure:${ctx.relays.join(',')}`); if (opts.failStep === '10050') throw new Error('10050 boom'); } },
    onError: (step, error) => log.push(`onError:${step}:${(error as Error).message}`),
    seams: {
      isSecureContext: () => true,
      openStores: async () => { log.push('openForWrite'); return { status: 'opened', stores: stores as never }; },
      createTransport: () => ({ transport: {} as never, pool: {} as never, closePool: () => log.push('pool.close') }),
      createMarmotClient: ((o: { options?: Record<string, unknown>; signer: unknown; budget: unknown }) => {
        capturedAll = o as unknown as Record<string, unknown>;
        createCalls += 1;
        log.push('createMarmotClient');
        capturedOptions = o.options;
        capturedSigner = o.signer;
        capturedBudget = o.budget;
        return fakeClient;
      }) as never,
    },
  };
  return { input, log, listeners, groupListeners, stores, lateGroups, makeGroup, fakeClient, get captured() { return { capturedOptions, capturedSigner, capturedBudget, capturedAll, createCalls }; } };
}

describe('startup order (AC-BOOT-1)', () => {
  it('runs openForWrite -> createMarmotClient -> listeners -> inbox handlers -> groups.list -> group listeners -> history sweep -> inbox.start -> key package -> 10050', async () => {
    const rig = makeRig({ groups: [{ id: 'g1' }, { id: 'g2' }] });
    const result = await bootstrapAccountClient(rig.input);
    expect(result.status).toBe('ready');
    const steps = rig.log.filter((l) => !l.startsWith('handler:'));
    expect(steps).toEqual([
      'openForWrite',
      'createMarmotClient',
      ...CLIENT_EVENT_NAMES.map((n) => `client.on:${n}`),
      'client.on:groupCreated',
      'client.on:groupJoined',
      `registerInboxHandler:${APP_INBOX_KINDS.joinRequest}`,
      `registerInboxHandler:${APP_INBOX_KINDS.inviteContext}`,
      'groups.list',
      'groups.list.resolved',
      'group.onNotification:g1',
      'group.onNotification:g2',
      'history.sweep',
      'history.sweep.settled',
      'inbox.start',
      'keyPackages.count',
      'keyPackages.create:{"lastResort":true}',
      'inboxRelayList.ensure:wss://relay.example',
    ]);
    expect([APP_INBOX_KINDS.joinRequest, APP_INBOX_KINDS.inviteContext]).toEqual([21059, 21064]);
  });

  it('inbox.start is never called before groups.list has resolved', async () => {
    const rig = makeRig();
    await bootstrapAccountClient(rig.input);
    expect(rig.log.indexOf('inbox.start')).toBeGreaterThan(rig.log.indexOf('groups.list.resolved'));
  });

  it('the sweep runs after groups.list has resolved and inbox.start waits for it to settle', async () => {
    let release!: () => void;
    const rig = makeRig({ sweep: () => new Promise<void>((r) => (release = r)) });
    const run = bootstrapAccountClient(rig.input);
    await vi.waitFor(() => expect(rig.log).toContain('history.sweep'));
    expect(rig.log.indexOf('history.sweep')).toBeGreaterThan(rig.log.indexOf('groups.list.resolved'));
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.log).not.toContain('inbox.start');
    release();
    expect((await run).status).toBe('ready');
    expect(rig.log.indexOf('inbox.start')).toBeGreaterThan(rig.log.indexOf('history.sweep.settled'));
  });

  it('a rejected sweep is reported (step historySweep) and does not abort the bootstrap', async () => {
    const rig = makeRig({ sweep: async () => { throw new Error('sweep boom'); } });
    const result = await bootstrapAccountClient(rig.input);
    expect(result.status).toBe('ready');
    expect(rig.log).toContain('onError:historySweep:sweep boom');
    expect(rig.log.indexOf('inbox.start')).toBeGreaterThan(rig.log.indexOf('onError:historySweep:sweep boom'));
    expect(rig.log).toContain('inboxRelayList.ensure:wss://relay.example');
  });

  it('a sweep() that throws synchronously is a non-fatal historySweep report, not a bootstrap failure', async () => {
    const rig = makeRig();
    rig.input.history.sweep = (() => { throw new Error('sync sweep boom'); }) as never;
    const result = await bootstrapAccountClient(rig.input);
    expect(result.status).toBe('ready');
    expect(rig.log).toContain('onError:historySweep:sync sweep boom');
    expect(rig.log).toContain('inbox.start');
  });

  it('an abort that happens while the sweep runs tears down and never starts the inbox', async () => {
    const ac = new AbortController();
    const rig = makeRig({ sweep: async () => { ac.abort(); } });
    rig.input.signal = ac.signal;
    const result = await bootstrapAccountClient(rig.input);
    expect(result.status).toBe('aborted');
    expect(rig.log).not.toContain('inbox.start');
    expect(rig.log).toContain('client.dispose');
  });

  it('a never-settling sweep is waited for at most HISTORY_SWEEP_WAIT_MS: reported as historySweep, then the inbox starts while the sweep keeps running', async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig({ sweep: () => new Promise<void>(() => undefined) });
      const run = bootstrapAccountClient(rig.input);
      await vi.advanceTimersByTimeAsync(HISTORY_SWEEP_WAIT_MS - 1);
      expect(rig.log).toContain('history.sweep');
      expect(rig.log).not.toContain('inbox.start');
      await vi.advanceTimersByTimeAsync(1);
      const result = await run;
      expect(result.status).toBe('ready');
      expect(rig.log.some((l) => l.startsWith('onError:historySweep:'))).toBe(true);
      expect(rig.log.indexOf('inbox.start')).toBeGreaterThan(rig.log.findIndex((l) => l.startsWith('onError:historySweep:')));
      expect(rig.log).not.toContain('history.sweep.settled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abort while the sweep never settles ends the wait: aborted, torn down, no inbox.start', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const rig = makeRig({ sweep: () => new Promise<void>(() => undefined) });
      rig.input.signal = ac.signal;
      const run = bootstrapAccountClient(rig.input);
      await vi.advanceTimersByTimeAsync(10);
      expect(rig.log).toContain('history.sweep');
      ac.abort();
      const result = await run;
      expect(result.status).toBe('aborted');
      expect(rig.log).toContain('client.dispose');
      await vi.advanceTimersByTimeAsync(HISTORY_SWEEP_WAIT_MS * 2);
      expect(rig.log).not.toContain('inbox.start');
      expect(rig.log.some((l) => l.startsWith('onError:historySweep:'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a history sink without sweep() fails loudly', async () => {
    const rig = makeRig();
    delete (rig.input.history as { sweep?: unknown }).sweep;
    await expect(bootstrapAccountClient(rig.input)).rejects.toThrow(/history\.sweep/);
  });

  it('the 10050 ensure is called exactly once, after the key-package ensure', async () => {
    const rig = makeRig({ keyPackageCount: 2 });
    await bootstrapAccountClient(rig.input);
    expect(rig.log.filter((l) => l.startsWith('inboxRelayList.ensure'))).toHaveLength(1);
    expect(rig.log.indexOf('inboxRelayList.ensure:wss://relay.example')).toBeGreaterThan(rig.log.indexOf('keyPackages.count'));
  });
});

describe('key-package ensure (AC-BOOT-2)', () => {
  it('count 0 -> create({lastResort:true}) exactly once', async () => {
    const rig = makeRig({ keyPackageCount: 0 });
    const r = await bootstrapAccountClient(rig.input);
    expect(rig.log.filter((l) => l.startsWith('keyPackages.create'))).toEqual(['keyPackages.create:{"lastResort":true}']);
    expect(r.status === 'ready' && r.account.ensure.keyPackage).toBe('created');
  });
  it('count > 0 -> never creates', async () => {
    const rig = makeRig({ keyPackageCount: 1 });
    const r = await bootstrapAccountClient(rig.input);
    expect(rig.log.some((l) => l.startsWith('keyPackages.create'))).toBe(false);
    expect(r.status === 'ready' && r.account.ensure.keyPackage).toBe('present');
  });
  it('an ensure failure is reported, non-fatal, and the 10050 step still runs once', async () => {
    const rig = makeRig({ failStep: '10050' });
    const r = await bootstrapAccountClient(rig.input);
    expect(r.status === 'ready' && r.account.ensure).toEqual({ keyPackage: 'created', inboxRelayList: 'failed' });
    expect(rig.log).toContain('onError:inboxRelayListEnsure:10050 boom');
  });

  it.each(['bootstrap abort', 'teardown'] as const)('cancels an in-flight 10050 retry on %s', async (mode) => {
    const rig = makeRig();
    const abort = new AbortController();
    rig.input.signal = abort.signal;
    const ensure = vi.fn<BootstrapInput['inboxRelayList']['ensure']>()
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      }));
    rig.input.inboxRelayList = { ensure };
    const result = await bootstrapAccountClient(rig.input);
    if (result.status !== 'ready') throw new Error('Bootstrap failed');

    const pending = result.account.retryInboxRelayList!();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ensure).toHaveBeenCalledTimes(2);
    if (mode === 'bootstrap abort') abort.abort();
    else await result.account.teardown();
    await rejected;
    expect(rig.log.filter((entry) => entry === 'inbox.start')).toHaveLength(1);
    await result.account.teardown();
  });
});

describe('AccountClientHandle seam shape', () => {
  it('type: the key set is exactly {client, pubkey, leaseHeld, enqueue}', () => {
    expectTypeOf<keyof AccountClientHandle>().toEqualTypeOf<'client' | 'pubkey' | 'leaseHeld' | 'enqueue'>();
    expectTypeOf<AccountClientHandle['pubkey']>().toEqualTypeOf<string>();
    expectTypeOf<AccountClientHandle['leaseHeld']>().toEqualTypeOf<() => boolean>();
    expectTypeOf<AccountClientHandle['enqueue']>().toEqualTypeOf<(job: () => Promise<void>, scope?: ClientCallbackScope) => void>();
  });
  it('runtime: the handle the bootstrap returns carries exactly those keys', async () => {
    const rig = makeRig();
    const r = await bootstrapAccountClient(rig.input);
    expect(r.status === 'ready' && Object.keys(r.account.handle).sort()).toEqual(['client', 'enqueue', 'leaseHeld', 'pubkey']);
  });
});

describe('key-package ensure failure (InboxRelayListEnsure)', () => {
  it('a FAILING key-package ensure is reported, non-fatal, and the 10050 ensure still runs exactly once, after it', async () => {
    const rig = makeRig();
    rig.input.seams!.ensureKeyPackage = async () => { rig.log.push('kp.ensure'); throw new Error('kp boom'); };
    const r = await bootstrapAccountClient(rig.input);
    expect(r.status === 'ready' && r.account.ensure).toEqual({ keyPackage: 'failed', inboxRelayList: 'ok' });
    expect(rig.log).toContain('onError:keyPackageEnsure:kp boom');
    expect(rig.log.filter((l) => l.startsWith('inboxRelayList.ensure'))).toHaveLength(1);
    expect(rig.log.indexOf('inboxRelayList.ensure:wss://relay.example')).toBeGreaterThan(rig.log.indexOf('kp.ensure'));
    expect(rig.log).not.toContain('client.dispose'); // client stays usable
  });
});

describe('listeners (AC-BOOT-4)', () => {
  it('each of the six events invokes exactly its own app handler once', async () => {
    const rig = makeRig();
    await bootstrapAccountClient(rig.input);
    expect([...rig.listeners.keys()].sort()).toEqual([...CLIENT_EVENT_NAMES, 'groupCreated', 'groupJoined'].sort());
    for (const name of CLIENT_EVENT_NAMES) {
      rig.listeners.get(name)!({ marker: name });
      const hits = rig.log.filter((l) => l.startsWith('handler:'));
      expect(hits.filter((h) => h.startsWith(`handler:${name}:`))).toEqual([`handler:${name}:{"marker":"${name}"}`]);
    }
    expect(rig.log.filter((l) => l.startsWith('handler:'))).toHaveLength(CLIENT_EVENT_NAMES.length);
  });

  it('a throwing app handler is reported and does not escape into the library frame', async () => {
    const rig = makeRig();
    rig.input.clientEvents.groupRemoved = () => { throw new Error('handler exploded'); };
    await bootstrapAccountClient(rig.input);
    expect(() => rig.listeners.get('groupRemoved')!({ groupId: 'g' })).not.toThrow();
    expect(rig.log).toContain('onError:listener:handler exploded');
  });

  it('group notifications reach the app callback with the group', async () => {
    const rig = makeRig({ groups: [{ id: 'g1' }] });
    await bootstrapAccountClient(rig.input);
    rig.groupListeners.get('g1')!({ type: 'message' });
    expect(rig.log).toContain('appGroupNotification:g1:message');
  });

  it('attachGroup is idempotent per group id', async () => {
    const rig = makeRig();
    const r = await bootstrapAccountClient(rig.input);
    if (r.status !== 'ready') throw new Error('unexpected');
    const g = { id: 'late', onNotification: () => { rig.log.push('late.attach'); return () => undefined; } } as never;
    r.account.attachGroup(g);
    r.account.attachGroup(g);
    expect(rig.log.filter((l) => l === 'late.attach')).toHaveLength(1);
  });
});

describe('client construction (AC-BOOT-6, AC-TRANS-1)', () => {
  it('passes leaveTimeoutMs 10000 and removalSettleMs 5000, no verifier, discover mode', async () => {
    const rig = makeRig();
    await bootstrapAccountClient(rig.input);
    expect(rig.captured.capturedOptions).toMatchObject({ leaveTimeoutMs: 10000, removalSettleMs: 5000 });
  });

  it('constructs the client with the seam-provided collaborators and delegates transport calls', async () => {
    const rig = makeRig();
    const subscription = vi.fn(() => 'seam subscription');
    const transport = { transport: { subscription } as never, pool: {} as never, closePool: () => undefined };
    rig.input.seams!.createTransport = () => transport;
    const stores = rig.stores;
    const append = vi.spyOn(rig.input.history, 'append');
    rig.input.seams!.openStores = async () => ({ status: 'opened', stores: stores as never });
    await bootstrapAccountClient(rig.input);
    const all = rig.captured.capturedAll as Record<string, unknown>;
    expect(all.verifier).toBeUndefined();
    expect(all.relays).toEqual({ defaults: rig.input.relays, mode: 'discover' });
    expect(all.relays).not.toHaveProperty('verifier');
    const entry = { groupId: 'fixture-group' } as Parameters<BootstrapInput['history']['append']>[0];
    await (all.history as BootstrapInput['history']).append(entry);
    expect(append).toHaveBeenCalledExactlyOnceWith(entry);
    expect(all.stores).toBe(stores);
    const wired = all.transport as { subscription: (relays: string[], filters: object) => string };
    expect(wired.subscription(rig.input.relays as string[], {})).toBe('seam subscription');
    expect(subscription).toHaveBeenCalledWith(rig.input.relays, {});
    expect(all.signer).toBe(rig.captured.capturedSigner);
    expect(all.budget).toBe(rig.captured.capturedBudget);
    // the signer is the adapter's (not the raw app signer)
    expect(all.signer).not.toBe(rig.input.eventSigner);
  });

  it('lets a caller override history timeouts without losing the pinned timing', async () => {
    const rig = makeRig();
    rig.input.clientOptions = { historyTimeoutMs: 123, historySilenceThreshold: 1 };
    await bootstrapAccountClient(rig.input);
    expect(rig.captured.capturedOptions).toMatchObject({ leaveTimeoutMs: 10000, removalSettleMs: 5000, historyTimeoutMs: 123, historySilenceThreshold: 1 });
  });

  it('hands the library the budget chosen for the signer kind', async () => {
    const rig = makeRig();
    rig.input.signerKind = 'nip07';
    await bootstrapAccountClient(rig.input);
    expect((rig.captured.capturedBudget as { policy?: string }).policy).toBeUndefined();
    expect((rig.captured.capturedBudget as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
  });
});

describe('gates (AC-SIGN-2, AC-SIGN-5)', () => {
  it('insecure context -> unsupported, no store opened, no createMarmotClient call', async () => {
    const rig = makeRig();
    rig.input.seams!.isSecureContext = () => false;
    const r = await bootstrapAccountClient(rig.input);
    expect(r).toEqual({ status: 'unsupported', reason: 'insecure-context' });
    expect(rig.log).toEqual([]);
    expect(rig.captured.createCalls).toBe(0);
  });

  it('storage unsupported (no IndexedDB / Web Locks) -> unsupported/storage, nothing acquired', async () => {
    const rig = makeRig();
    rig.input.seams!.openStores = async () => { rig.log.push('openStores'); return { status: 'unsupported', reason: 'storage' }; };
    const r = await bootstrapAccountClient(rig.input);
    expect(r).toEqual({ status: 'unsupported', reason: 'storage' });
    expect(rig.captured.createCalls).toBe(0);
    expect(rig.log).not.toContain('stores.close');
  });

  it('a signer without nip44 -> unsupported/nip44, no store opened, no client constructed', async () => {
    const rig = makeRig();
    rig.input.eventSigner = { getPublicKey: async () => 'aa'.repeat(32), signEvent: async (d: unknown) => d };
    const r = await bootstrapAccountClient(rig.input);
    expect(r).toEqual({ status: 'unsupported', reason: 'nip44' });
    expect(rig.log).toEqual([]);
    expect(rig.captured.createCalls).toBe(0);
  });

  it('lease-held is returned as a value and no client is constructed', async () => {
    const rig = makeRig();
    rig.input.seams!.openStores = async () => ({ status: 'lease-held' });
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'lease-held' });
    expect(rig.captured.createCalls).toBe(0);
  });
});

describe('teardown (AC-BOOT-3)', () => {
  it('dispose precedes stores.close; a failed bootstrap releases what it acquired', async () => {
    const rig = makeRig();
    const r = await bootstrapAccountClient(rig.input);
    if (r.status !== 'ready') throw new Error('unexpected');
    rig.log.length = 0;
    await r.account.teardown();
    expect(rig.log.indexOf('client.dispose')).toBeGreaterThanOrEqual(0);
    expect(rig.log.indexOf('client.dispose')).toBeLessThan(rig.log.indexOf('stores.close'));
    // the history sink is disposed before the client (recovery must not call handlers into a disposed client)
    expect(rig.log.indexOf('history.dispose')).toBeGreaterThanOrEqual(0);
    expect(rig.log.indexOf('history.dispose')).toBeLessThan(rig.log.indexOf('client.dispose'));

    const failing = makeRig({ failStep: 'inbox.start' });
    await expect(bootstrapAccountClient(failing.input)).rejects.toThrow('inbox boom');
    expect(failing.log).toContain('client.dispose');
    expect(failing.log).toContain('stores.close');
    expect(failing.log).toContain('pool.close');
    expect(failing.log.indexOf('client.dispose')).toBeLessThan(failing.log.indexOf('stores.close'));
    expect(failing.log.indexOf('history.dispose')).toBeLessThan(failing.log.indexOf('client.dispose'));
  });
});

describe('required collaborators fail loudly (no silent degrade)', () => {
  const cases: Array<[string, (i: BootstrapInput) => void]> = [
    ['history', (i) => { (i as { history?: unknown }).history = undefined; }],
    ['inboxRelayList.ensure', (i) => { (i as { inboxRelayList?: unknown }).inboxRelayList = undefined; }],
    ['onGroupNotification', (i) => { (i as { onGroupNotification?: unknown }).onGroupNotification = undefined; }],
    ['inboxHandlers.joinRequest', (i) => { (i.inboxHandlers as { joinRequest?: unknown }).joinRequest = undefined; }],
    ['inboxHandlers.inviteContext', (i) => { (i.inboxHandlers as { inviteContext?: unknown }).inviteContext = undefined; }],
    ['clientEvents.storeIncompatible', (i) => { (i.clientEvents as { storeIncompatible?: unknown }).storeIncompatible = undefined; }],
    ['eventSigner', (i) => { (i as { eventSigner?: unknown }).eventSigner = undefined; }],
    ['eventSigner.getPublicKey', (i) => { (i as { eventSigner: unknown }).eventSigner = { signEvent: () => undefined }; }],
    ['eventSigner.signEvent', (i) => { (i as { eventSigner: unknown }).eventSigner = { getPublicKey: () => 'aa' }; }],
  ];
  it.each(cases)('omitting %s rejects with a TypeError naming it, before anything is opened', async (name, mutate) => {
    const rig = makeRig();
    mutate(rig.input);
    await expect(bootstrapAccountClient(rig.input)).rejects.toThrow(new RegExp(name.replace('.', '\\.')));
    expect(rig.log).toEqual([]);
  });
});

type Rig = ReturnType<typeof makeRig>;
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
async function ready(rig: Rig) {
  const r = await bootstrapAccountClient(rig.input);
  if (r.status !== 'ready') throw new Error(`not ready: ${r.status}`);
  return r.account;
}

describe('abort mid-flight (signal)', () => {
  const expectReleased = (rig: Rig) => {
    expect(rig.log).toContain('client.dispose');
    expect(rig.log).toContain('stores.close');
    expect(rig.log).toContain('pool.close');
    expect(rig.log.indexOf('client.dispose')).toBeLessThan(rig.log.indexOf('stores.close'));
    expect(rig.log.indexOf('stores.close')).toBeLessThan(rig.log.indexOf('pool.close'));
  };

  it('an already-aborted signal returns aborted before anything happens', async () => {
    const rig = makeRig();
    const ac = new AbortController();
    ac.abort();
    rig.input.signal = ac.signal;
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'aborted' });
    expect(rig.log).toEqual([]);
  });

  it('abort during getPublicKey: aborted, no store was opened', async () => {
    const rig = makeRig();
    const ac = new AbortController();
    rig.input.signal = ac.signal;
    const base = createPrivateKeySigner(PUBKEY_SECRET);
    rig.input.eventSigner = {
      getPublicKey: async () => { ac.abort(); return base.getPublicKey(); },
      signEvent: base.signEvent,
      nip44: base.nip44,
    };
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'aborted' });
    expect(rig.log).toEqual([]);
  });

  it('abort during openForWrite: the just-acquired stores (lease) are closed, no client is built', async () => {
    const rig = makeRig();
    const ac = new AbortController();
    rig.input.signal = ac.signal;
    rig.input.seams!.openStores = async () => { ac.abort(); rig.log.push('openForWrite'); return { status: 'opened', stores: rig.stores as never }; };
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'aborted' });
    expect(rig.log).toContain('stores.close');
    expect(rig.log).not.toContain('createMarmotClient');
    expect(rig.captured.createCalls).toBe(0);
  });

  const stepCases: Array<[string, (rig: Rig, abort: () => void) => void, string[]]> = [
    ['groups.list', (rig, abort) => { rig.fakeClient.groups.list = async () => { abort(); return [rig.makeGroup({ id: 'g1' })] as never; }; }, ['group.onNotification:g1', 'inbox.start', 'keyPackages.count', 'inboxRelayList.ensure:wss://relay.example']],
    ['inbox.start', (rig, abort) => { rig.fakeClient.inbox.start = async () => { abort(); }; }, ['keyPackages.count', 'inboxRelayList.ensure:wss://relay.example']],
    ['keyPackageEnsure', (rig, abort) => { rig.input.seams!.ensureKeyPackage = async () => { abort(); return 'present'; }; }, ['inboxRelayList.ensure:wss://relay.example']],
    ['inboxRelayListEnsure', (rig, abort) => { rig.input.inboxRelayList = { ensure: async () => { abort(); } }; }, []],
  ];
  it.each(stepCases)('abort during %s releases the lease in contract order and attaches nothing afterwards', async (_name, arm, notAfter) => {
    const rig = makeRig();
    const ac = new AbortController();
    rig.input.signal = ac.signal;
    arm(rig, () => ac.abort());
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'aborted' });
    expectReleased(rig);
    for (const later of notAfter) expect(rig.log).not.toContain(later);
    expect(rig.log.some((l) => l.startsWith('group.unsub') || l.startsWith('client.off'))).toBe(true);
  });

  it('a non-aborted signal does not change the result', async () => {
    const rig = makeRig();
    rig.input.signal = new AbortController().signal;
    expect((await bootstrapAccountClient(rig.input)).status).toBe('ready');
  });
});

describe('structural attach (groupCreated / groupJoined)', () => {
  it.each(['groupCreated', 'groupJoined'] as const)('%s enqueues a job that fetches the handle and attaches its notification listener', async (event) => {
    const rig = makeRig();
    const account = await ready(rig);
    rig.lateGroups.set('new', rig.makeGroup({ id: 'new' }));
    rig.log.length = 0;
    rig.listeners.get(event)!({ groupId: 'new', invitationId: 'inv' });
    // never inside the listener frame
    expect(rig.log).toEqual([]);
    await account.queue.idle();
    expect(rig.log).toEqual(['groups.get:new', 'group.onNotification:new']);
    rig.groupListeners.get('new')!({ type: 'message' });
    expect(rig.log).toContain('appGroupNotification:new:message');
  });

  it('the same handle is attached once; a rebuilt handle for a rejoined group id is attached again', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    const first = rig.makeGroup({ id: 'again' });
    rig.lateGroups.set('again', first);
    rig.listeners.get('groupCreated')!({ groupId: 'again' });
    rig.listeners.get('groupJoined')!({ groupId: 'again', invitationId: 'i' });
    await account.queue.idle();
    account.attachGroup(first as never);
    expect(rig.log.filter((l) => l === 'group.onNotification:again')).toHaveLength(1);

    // abandon + rejoin: the library builds a new handle for the same id
    rig.lateGroups.set('again', rig.makeGroup({ id: 'again' }));
    rig.listeners.get('groupJoined')!({ groupId: 'again', invitationId: 'i2' });
    await account.queue.idle();
    expect(rig.log.filter((l) => l === 'group.onNotification:again')).toHaveLength(2);
  });

  it('a group the library no longer holds is skipped without error', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    rig.listeners.get('groupJoined')!({ groupId: 'gone', invitationId: 'i' });
    await account.queue.idle();
    expect(rig.log.some((l) => l.startsWith('onError'))).toBe(false);
    expect(rig.log).not.toContain('group.onNotification:gone');
  });

  it('a failing job is reported as step "queuedJob" (not "listener") and the queue keeps going', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    let calls = 0;
    rig.fakeClient.groups.get = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error('get exploded');
      return rig.lateGroups.get(id);
    };
    rig.lateGroups.set('ok', rig.makeGroup({ id: 'ok' }));
    rig.listeners.get('groupCreated')!({ groupId: 'bad' });
    rig.listeners.get('groupCreated')!({ groupId: 'ok' });
    await account.queue.idle();
    expect(rig.log).toContain('onError:queuedJob:get exploded');
    expect(rig.log).not.toContain('onError:listener:get exploded');
    expect(rig.log).toContain('group.onNotification:ok');
  });
});

describe('after teardown', () => {
  it('attachGroup is a no-op', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    await account.teardown();
    rig.log.length = 0;
    account.attachGroup(rig.makeGroup({ id: 'late' }) as never);
    expect(rig.log).toEqual([]);
  });

  it('a groupCreated job already running when teardown happens does not attach', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    const gate = deferred<ReturnType<Rig['makeGroup']>>();
    rig.fakeClient.groups.get = async (id: string) => { rig.log.push(`groups.get:${id}`); return gate.promise as never; };
    rig.listeners.get('groupCreated')!({ groupId: 'slow' });
    await expect.poll(() => rig.log.includes('groups.get:slow')).toBe(true);
    const td = account.teardown();
    gate.resolve(rig.makeGroup({ id: 'slow' }));
    await td;
    await account.queue.idle();
    expect(rig.log).not.toContain('group.onNotification:slow');
  });

  it('a groups.get that rejects (disposed) after teardown is swallowed: no onError', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    const gate = deferred<never>();
    rig.fakeClient.groups.get = async (id: string) => { rig.log.push(`groups.get:${id}`); return gate.promise; };
    rig.listeners.get('groupCreated')!({ groupId: 'slow' });
    await expect.poll(() => rig.log.includes('groups.get:slow')).toBe(true);
    const td = account.teardown();
    gate.reject(new MarmotError('disposed', 'client disposed'));
    await td;
    await account.queue.idle();
    expect(rig.log.filter((l) => l.startsWith('onError:'))).toEqual([]);
  });

  it('a groups.get that rejects while the client is live still reports queuedJob', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    rig.fakeClient.groups.get = async () => { throw new Error('live boom'); };
    rig.listeners.get('groupCreated')!({ groupId: 'bad' });
    await account.queue.idle();
    expect(rig.log).toContain('onError:queuedJob:live boom');
  });

  it('a groupCreated event fired after teardown does nothing', async () => {
    const rig = makeRig();
    const account = await ready(rig);
    await account.teardown();
    rig.log.length = 0;
    rig.lateGroups.set('x', rig.makeGroup({ id: 'x' }));
    rig.listeners.get('groupCreated')!({ groupId: 'x' });
    await account.queue.idle();
    expect(rig.log).toEqual([]);
  });
});

describe('remote signer getPublicKey budget', () => {
  it('a never-resolving getPublicKey on a remote signer reports step getPublicKey and opens nothing', async () => {
    const rig = makeRig();
    const base = createPrivateKeySigner(PUBKEY_SECRET);
    rig.input.signerKind = 'nip46';
    rig.input.eventSigner = { getPublicKey: () => new Promise<string>(() => undefined), signEvent: base.signEvent, nip44: base.nip44 };
    rig.input.seams!.signerTimeoutMs = 20;
    expect(await bootstrapAccountClient(rig.input)).toEqual({ status: 'signer-timeout' });
    expect(rig.log).toHaveLength(1);
    expect(rig.log[0]).toMatch(/^onError:getPublicKey:.*within 20 ms/);
    expect(rig.captured.createCalls).toBe(0);
  });

  it('a remote signer that answers in time bootstraps normally', async () => {
    const rig = makeRig();
    rig.input.signerKind = 'nip07';
    rig.input.seams!.signerTimeoutMs = 5_000;
    expect((await bootstrapAccountClient(rig.input)).status).toBe('ready');
  });
});

it('attempts teardown once when abort cleanup fails', async () => {
  const rig = makeRig();
  const controller = new AbortController();
  rig.input.signal = controller.signal;
  rig.input.beforeClientConstruction = async () => { controller.abort(); };
  const failure = new Error('close failed');
  rig.stores.close = async () => { rig.log.push('stores.close'); throw failure; };
  await expect(bootstrapAccountClient(rig.input)).rejects.toBe(failure);
  expect(rig.log.filter((entry) => entry === 'stores.close')).toHaveLength(1);
  expect(rig.log.filter((entry) => entry === 'history.dispose')).toHaveLength(1);
  expect(rig.captured.createCalls).toBe(0);
});
