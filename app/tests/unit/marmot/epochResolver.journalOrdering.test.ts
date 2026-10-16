/**
 * Write-ahead rumor journal — EpochResolver ordering guarantee
 * (bug: mls-message-lost-on-unload-after-ingest, VQ-1).
 *
 * marmot-ts's ingest generator yields `{kind:'processed'}` for an application
 * message BEFORE it emits `authenticatedApplicationMessage` and BEFORE it
 * persists the advanced MLS state (`save()` → store.setItem). The generator is
 * suspended at that yield until the consumer's `for await` body finishes. The
 * resolver therefore AWAITS `onApplicationMessage` (the journal put) inside the
 * loop body: the post-yield code (emit + state save) must not run until the put
 * has resolved. These tests drive all three ingest loops (processEvent,
 * flushFutureBuffer, rollbackAndReplay) with a stub group that logs its
 * post-yield code, and a put that resolves on a later macrotask.
 *
 * A put failure must never abort the generator — an exception escaping the loop
 * body would call the generator's return() and skip the state save, losing the
 * advanced ratchet as well.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EpochResolver } from '@/src/lib/marmot/epochResolver';
import type { NostrEvent } from '@/src/lib/marmot/epochResolver';

vi.mock('@internet-privacy/marmot-ts', () => ({
  serializeClientState: vi.fn((state: { _epoch: number }) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, state._epoch ?? 0);
    return bytes;
  }),
  deserializeClientState: vi.fn((bytes: Uint8Array) => {
    const epoch = new DataView(bytes.buffer).getUint32(0);
    return { groupContext: { epoch: BigInt(epoch) }, _epoch: epoch };
  }),
  getEpoch: vi.fn((state: { _epoch?: number }) => state._epoch ?? 0),
  getGroupMembers: vi.fn(() => ['member-a']),
  deserializeApplicationData: vi.fn((msg: Uint8Array) => JSON.parse(new TextDecoder().decode(msg))),
  getPubkeyLeafNodes: vi.fn((state: { ratchetTree: Array<{ pk: string; sig: number }> }, pk: string) =>
    state.ratchetTree.filter((n) => n.pk === pk).map((n) => ({ signaturePublicKey: new Uint8Array([n.sig]), hpkePublicKey: new Uint8Array([n.sig]) }))),
}));

const SENDER = 'ab'.repeat(32);

function ev(id: string, created_at = 1000): NostrEvent {
  return { id, pubkey: 'pk', created_at, kind: 445, tags: [], content: '', sig: 's' };
}

function appMsg(id: string) {
  const rumor = { id, kind: 9, pubkey: SENDER, created_at: 1000, content: `msg-${id}`, tags: [] };
  return {
    kind: 'processed',
    result: { kind: 'applicationMessage', message: new TextEncoder().encode(JSON.stringify(rumor)) },
    event: ev(`evt-${id}`),
    senderPubkey: SENDER,
  };
}

type PlanItem = Record<string, unknown> & { kind: string };

/**
 * Stub MarmotGroup whose async-generator ingest mirrors marmot-group.js:
 * `yield processed` → (post-yield) emit → … → `await save()` at the end.
 * Each post-yield step and the save are appended to `log`.
 */
function makeStubGroup(plan: PlanItem[][], log: string[]) {
  let call = 0;
  const group = {
    _state: { _epoch: 1 },
    get state() { return this._state as never; },
    set state(s: never) { this._state = s; },
    save: vi.fn(async () => { log.push('state-save'); }),
    ingest: vi.fn(async function* () {
      const items = plan[call++] ?? [];
      for (const item of items) {
        yield item as never;
        const rid = (item as { result?: { kind: string; message?: Uint8Array } }).result?.kind === 'applicationMessage'
          ? JSON.parse(new TextDecoder().decode((item as { result: { message: Uint8Array } }).result.message)).id
          : (item as { event?: NostrEvent }).event?.id;
        log.push(`post-yield:${rid}`);
      }
      log.push('state-save');
    }),
  };
  return group;
}

/** A put that resolves on a later macrotask, logging start and completion. */
function slowPut(log: string[], opts: { fail?: boolean } = {}) {
  return vi.fn((msg: unknown) => {
    const m = msg as { rumor?: { id: string }; id?: string };
    const id = m.rumor?.id ?? m.id;
    log.push(`put-start:${id}`);
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        log.push(`put-done:${id}`);
        if (opts.fail) reject(new Error('idb quota'));
        else resolve();
      }, 5);
    });
  });
}

function before(log: string[], a: string, b: string) {
  const ia = log.indexOf(a);
  const ib = log.indexOf(b);
  expect(ia, `${a} missing in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
  expect(ib, `${b} missing in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} must precede ${b}: ${JSON.stringify(log)}`).toBeLessThan(ib);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EpochResolver awaits onApplicationMessage before resuming the ingest generator', () => {
  it('loop 1 (processEvent): post-yield emit/save run only after the put resolves', async () => {
    const log: string[] = [];
    const group = makeStubGroup([[appMsg('r1')]], log);
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });

    await resolver.ingestEvent(ev('evt-r1'));

    before(log, 'put-done:r1', 'post-yield:r1');
    before(log, 'put-done:r1', 'state-save');
    resolver.dispose();
  });

  it('passes the exact delivered bytes and the authenticated sender to the callback', async () => {
    const log: string[] = [];
    const item = appMsg('r-bytes');
    const group = makeStubGroup([[item]], log);
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });

    await resolver.ingestEvent(ev('evt-r-bytes'));

    expect(put).toHaveBeenCalledTimes(1);
    const arg = put.mock.calls[0][0] as { rumor: { id: string }; data: Uint8Array; senderPubkey: string };
    expect(arg.rumor.id).toBe('r-bytes');
    expect(arg.data).toBe((item.result as { message: Uint8Array }).message);
    expect(arg.senderPubkey).toBe(SENDER);
    resolver.dispose();
  });

  it('passes the sender\'s leaf identity at the message epoch (bug: journal-replayed-leave-evicts-rejoined-member)', async () => {
    const log: string[] = [];
    const item = {
      ...appMsg('r-leaf'),
      message: { privateMessage: { epoch: 3n } },
      result: {
        ...appMsg('r-leaf').result,
        newState: { groupContext: { epoch: 3n }, ratchetTree: [{ pk: SENDER, sig: 0x2a }], historicalReceiverData: new Map() },
      },
    };
    const group = makeStubGroup([[item]], log);
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });
    await resolver.ingestEvent(ev('evt-r-leaf'));
    expect((put.mock.calls[0][0] as { senderLeafIdentity?: string }).senderLeafIdentity).toBe('2a:2a');
    resolver.dispose();
  });

  it('failure injection: an identity lookup that throws is warned; the rumor is still journaled (without it) before the generator resumes', async () => {
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marmot = await import('@internet-privacy/marmot-ts');
    vi.mocked(marmot.getPubkeyLeafNodes).mockImplementationOnce(() => { throw new Error('tree'); });
    const item = {
      ...appMsg('r-noleaf'),
      message: { privateMessage: { epoch: 3n } },
      result: { ...appMsg('r-noleaf').result, newState: { groupContext: { epoch: 3n }, ratchetTree: [], historicalReceiverData: new Map() } },
    };
    const group = makeStubGroup([[item]], log);
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });
    await resolver.ingestEvent(ev('evt-r-noleaf'));
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0][0] as { senderLeafIdentity?: string }).senderLeafIdentity).toBeUndefined();
    before(log, 'put-done:r-noleaf', 'state-save');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sender leaf identity unavailable'), expect.any(Error));
    resolver.dispose();
  });

  it('loop 2 (flushFutureBuffer): a flushed rumor is journaled before its generator resumes', async () => {
    const log: string[] = [];
    const group = makeStubGroup(
      [
        [{ kind: 'unreadable', event: ev('evt-late'), errors: [] }],
        [appMsg('r-trigger')],
        [appMsg('r-late')], // flushFutureBuffer's retry ingest
      ],
      log,
    );
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });

    await resolver.ingestEvent(ev('evt-late'));
    await resolver.ingestEvent(ev('evt-r-trigger'));

    expect(group.ingest).toHaveBeenCalledTimes(3);
    before(log, 'put-done:r-late', 'post-yield:r-late');
    before(log, 'put-done:r-trigger', 'post-yield:r-trigger');
    resolver.dispose();
  });

  it('loop 3 (rollbackAndReplay): a replayed rumor is journaled before its generator resumes', async () => {
    const log: string[] = [];
    const group = makeStubGroup(
      [
        [{ kind: 'processed', result: { kind: 'newState' }, event: ev('commit-bbb') }],
        [{ kind: 'skipped', reason: 'past-epoch', event: ev('commit-aaa') }],
        [appMsg('r-replayed')], // rollbackAndReplay's replay ingest
      ],
      log,
    );
    const put = slowPut(log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put }, { graceWindowMs: 60_000 });

    await resolver.ingestEvent(ev('commit-bbb'));
    await resolver.ingestEvent(ev('commit-aaa'));

    expect(group.ingest).toHaveBeenCalledTimes(3);
    before(log, 'put-done:r-replayed', 'post-yield:r-replayed');
    resolver.dispose();
  });
});

describe('EpochResolver: a failing journal put never aborts the generator', () => {
  it.each([
    ['rejecting put', (log: string[]) => slowPut(log, { fail: true })],
    ['synchronously throwing put', () => vi.fn(() => { throw new Error('sync boom'); })],
  ])('%s: the generator still runs its post-yield code and state save', async (_label, makePut) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    const group = makeStubGroup([[appMsg('r1'), appMsg('r2')]], log);
    const resolver = new EpochResolver(group as never, { onApplicationMessage: makePut(log) });

    await expect(resolver.ingestEvent(ev('evt-r1'))).resolves.toEqual({ buffered: false });

    expect(log).toContain('post-yield:r1');
    expect(log).toContain('post-yield:r2');
    expect(log[log.length - 1]).toBe('state-save');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[epochResolver]'), expect.any(Error));
    resolver.dispose();
  });

  it('an undeserializable application payload is skipped with a warning, the state still saves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    const bad = {
      kind: 'processed',
      result: { kind: 'applicationMessage', message: new TextEncoder().encode('not json') },
      event: ev('evt-bad'),
      senderPubkey: SENDER,
    };
    const group = {
      _state: { _epoch: 1 },
      get state() { return this._state as never; },
      set state(s: never) { this._state = s; },
      save: vi.fn(),
      ingest: vi.fn(async function* () {
        yield bad as never;
        log.push('post-yield:bad');
        log.push('state-save');
      }),
    };
    const put = vi.fn();
    const resolver = new EpochResolver(group as never, { onApplicationMessage: put });

    await expect(resolver.ingestEvent(ev('evt-bad'))).resolves.toEqual({ buffered: false });
    expect(put).not.toHaveBeenCalled();
    expect(log).toEqual(['post-yield:bad', 'state-save']);
    expect(warn).toHaveBeenCalled();
    resolver.dispose();
  });

  it('no callback configured: ingest proceeds and nothing is deserialized needlessly', async () => {
    const log: string[] = [];
    const group = makeStubGroup([[appMsg('r1')]], log);
    const resolver = new EpochResolver(group as never, {});
    await resolver.ingestEvent(ev('evt-r1'));
    expect(log).toEqual(['post-yield:r1', 'state-save']);
    const { deserializeApplicationData } = await import('@internet-privacy/marmot-ts');
    expect(deserializeApplicationData).not.toHaveBeenCalled();
    resolver.dispose();
  });
});
