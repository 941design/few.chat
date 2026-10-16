/**
 * Bug first-relay-backup-cold-start-retry — the first relay backup after load
 * can fail while the relays are still connecting (NDK: connect 2.5 s, kind
 * 30051 relay-list fetch 8 s, publish 2.5 s). It used to wait 30 s / 2 min for
 * the next try. Now:
 *  - BackupScheduler: the first failure before any success gets one extra
 *    retry after 5 s (not counted against the budget), then the regular
 *    30 s / 2 min / 10 min schedule.
 *  - getBackupRelays (publish path only): within 60 s of a timed-out relay-list
 *    fetch it skips the fetch and uses the currently configured relays (read at
 *    call time — never a remembered list, which could name relays the user has
 *    since removed).
 *
 * The composed tests drive the real BackupScheduler + publishScheduledBackup +
 * publishBackup with NDK, the signer and IndexedDB mocked, and inject failures
 * at each step (connect, relay-list fetch, publish). A publish that times out
 * (indeterminate: a relay may still have stored it) is treated exactly like a
 * refused one — retried — as before this fix; the backup is a replaceable
 * event, so a duplicate only replaces itself.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const connectNdk = vi.fn();
const fetchEventsWithTimeout = vi.fn();
const ndkPublish = vi.fn();
const fromRelayUrls = vi.fn((_relays: string[], _ndk: unknown) => 'relay-set');
const published: Array<{ kind?: number; content?: string; tags?: string[][]; relaySet: unknown }> = [];

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKEvent: class {
    kind?: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
    pubkey?: string;
    id?: string;
    sig?: string;
    constructor(_ndk: unknown) {}
    async publish(relaySet: unknown) {
      await ndkPublish(relaySet);
      published.push({ kind: this.kind, content: this.content, tags: this.tags, relaySet });
    }
  },
  NDKRelaySet: { fromRelayUrls: (relays: string[], ndk: unknown) => fromRelayUrls(relays, ndk) },
}));

vi.mock('@/src/lib/ndkClient', () => ({
  connectNdk: (...args: unknown[]) => connectNdk(...args),
  fetchEventsWithTimeout: (...args: unknown[]) => fetchEventsWithTimeout(...args),
}));

vi.mock('@/src/lib/marmot/signerAdapter', () => ({
  createPrivateKeySigner: () => ({
    nip44: { encrypt: async (_pk: string, plaintext: string) => `encrypted:${plaintext}` },
    signEvent: async (draft: Record<string, unknown>) => ({ ...draft, id: 'id', pubkey: PUB, sig: 'sig' }),
  }),
}));

vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));

const idb: Record<string, Map<string, unknown>> = {};
const storeOf = (s?: string) => (idb[s ?? 'default'] ??= new Map());
vi.mock('idb-keyval', () => ({
  createStore: (db: string, store: string) => `${db}:${store}`,
  get: async (k: string, s?: string) => storeOf(s).get(k),
  set: async (k: string, v: unknown, s?: string) => void storeOf(s).set(k, v),
  del: async (k: string, s?: string) => void storeOf(s).delete(k),
  delMany: async (ks: string[], s?: string) => ks.forEach((k) => storeOf(s).delete(k)),
  keys: async (s?: string) => [...storeOf(s).keys()],
  values: async (s?: string) => [...storeOf(s).values()],
  entries: async (s?: string) => [...storeOf(s).entries()],
  clear: async (s?: string) => storeOf(s).clear(),
}));

const local = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
  },
  writable: true,
});

import {
  BackupScheduler,
  getBackupRelays,
  publishBackup,
  resetBackupRelayListMemo,
} from '@/src/lib/backup/relayBackup';
import { publishScheduledBackup } from '@/src/context/BackupContext';
import { DEFAULT_RELAYS, STORAGE_KEYS } from '@/src/types';

const PRIV = '11'.repeat(32);
const PUB = 'aa'.repeat(32);
const SEC = 1000;
const MIN = 60 * SEC;
const NDK = { ndk: true };

const listEvent = (relays: string[], createdAt = 10) => ({
  created_at: createdAt,
  tags: relays.map((r) => ['relay', r]),
  id: `list-${createdAt}`,
});
const fetched = (events: unknown[] = [], timedOut = false) => ({ events: new Set(events), timedOut });
const configureRelays = (relays: string[]) => local.set(STORAGE_KEYS.relays, JSON.stringify(relays));

/** Resolve (or reject) after `ms` of fake time — models an NDK timeout. */
function after<T>(ms: number, value: T, reject = false): Promise<T> {
  return new Promise((res, rej) => setTimeout(() => (reject ? rej(value) : res(value)), ms));
}

let warn: ReturnType<typeof vi.spyOn>;

// The SUT's first dynamic imports resolve on real I/O, which fake timers do not
// advance; load them once up front so timing assertions see only fake time.
beforeAll(async () => {
  await import('@nostr-dev-kit/ndk');
  await import('@/src/lib/ndkClient');
  await import('@/src/lib/marmot/signerAdapter');
});

beforeEach(() => {
  vi.useFakeTimers();
  resetBackupRelayListMemo();
  connectNdk.mockReset().mockResolvedValue(NDK);
  fetchEventsWithTimeout.mockReset().mockResolvedValue(fetched());
  ndkPublish.mockReset().mockResolvedValue(undefined);
  fromRelayUrls.mockClear();
  published.length = 0;
  local.clear();
  Object.keys(idb).forEach((k) => delete idb[k]);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// BackupScheduler — cold-start retry timing
// ---------------------------------------------------------------------------

describe('BackupScheduler — early retry after a failure before the first success', () => {
  it('retries 5 s after the first attempt fails, not earlier', async () => {
    const publishFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(5 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('after the early retry also fails, the regular 30 s / 2 min / 10 min schedule follows in full', async () => {
    const publishFn = vi.fn().mockResolvedValue(false);
    const scheduler = new BackupScheduler(publishFn);
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(publishFn).toHaveBeenCalledTimes(2);

    for (const [i, delay] of [30 * SEC, 2 * MIN, 10 * MIN, 10 * MIN, 10 * MIN].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(publishFn).toHaveBeenCalledTimes(i + 2);
      await vi.advanceTimersByTimeAsync(1);
      expect(publishFn).toHaveBeenCalledTimes(i + 3);
    }
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(7);
    scheduler.dispose();
  });

  it('a rejected first attempt gets the early retry too', async () => {
    const publishFn = vi.fn().mockRejectedValueOnce(new Error('relay down')).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('success path unchanged: a first success schedules nothing, and a later failure waits the regular 30 s', async () => {
    const publishFn = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(1);

    // Next change: published when the 5-minute window opens, and it fails.
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('is granted once: a failure after the early retry succeeded waits the regular 30 s', async () => {
    const publishFn = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(publishFn).toHaveBeenCalledTimes(2);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(4);
    scheduler.dispose();
  });

  it('a change during the early-retry wait rides along with it (no extra publish)', async () => {
    const publishFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(1 * SEC);
    scheduler.markDirty(true);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(4 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('nothing fires after dispose while the early retry is pending', async () => {
    const publishFn = vi.fn().mockResolvedValue(false);
    const scheduler = new BackupScheduler(publishFn);
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getBackupRelays — relay-list timeout memo
// ---------------------------------------------------------------------------

describe('getBackupRelays — a recently timed-out relay-list fetch is not repeated on the publish path', () => {
  const reuse = { reuseAfterRecentTimeout: true };

  it('within 60 s of a timeout: no fetch, effective relays (what the timed-out fetch resolved to)', async () => {
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([], true));
    const first = await getBackupRelays(NDK as never, PUB, reuse);
    expect(first).toEqual([...DEFAULT_RELAYS]);

    await vi.advanceTimersByTimeAsync(60 * SEC - 1);
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(first);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await getBackupRelays(NDK as never, PUB, reuse);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('inside the window never uses an earlier fetched list, only the configured relays', async () => {
    fetchEventsWithTimeout
      .mockResolvedValueOnce(fetched([listEvent(['wss://fetched.example'])]))
      .mockResolvedValueOnce(fetched([], true));
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://fetched.example']);
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual([...DEFAULT_RELAYS]);

    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual([...DEFAULT_RELAYS]);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('reads the configured relays live: an edit inside the window applies to the next call', async () => {
    configureRelays(['wss://a.example']);
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([], true));
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://a.example']);
    configureRelays(['wss://b.example']);
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://b.example']);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('a complete fetch clears the timeout, so the next call fetches again', async () => {
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([], true));
    await getBackupRelays(NDK as never, PUB); // lookup path records the timeout too
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([listEvent(['wss://a.example'])]));
    await getBackupRelays(NDK as never, PUB); // without the option it always fetches
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(2);

    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([listEvent(['wss://b.example'], 20)]));
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://b.example']);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(3);
  });

  it('a timed-out fetch that still returned a list uses it for that call only', async () => {
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([listEvent(['wss://partial.example'])], true));
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://partial.example']);
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual([...DEFAULT_RELAYS]);
  });

  it('is per identity: another identity\'s timeout never skips this one\'s fetch', async () => {
    const OTHER = 'bb'.repeat(32);
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([], true));
    await getBackupRelays(NDK as never, OTHER, reuse);

    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([listEvent(['wss://mine.example'])]));
    expect(await getBackupRelays(NDK as never, PUB, reuse)).toEqual(['wss://mine.example']);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('publishBackup uses the memo: no second fetch within 60 s of a timeout', async () => {
    const signer = {
      nip44: { encrypt: async (_pk: string, p: string) => `encrypted:${p}` },
      signEvent: async (d: Record<string, unknown>) => ({ ...d, id: 'i', pubkey: PUB, sig: 's' }),
    };
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([], true));
    await publishBackup(signer as never, PUB, NDK as never);
    await publishBackup(signer as never, PUB, NDK as never);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);
    expect(fromRelayUrls.mock.calls.map((c) => c[0])).toEqual([[...DEFAULT_RELAYS], [...DEFAULT_RELAYS]]);
  });
});

// ---------------------------------------------------------------------------
// Composed: scheduler + publishScheduledBackup, failure injected per step
// ---------------------------------------------------------------------------

function startScheduler(): BackupScheduler {
  const scheduler = new BackupScheduler(() => publishScheduledBackup(PRIV, PUB));
  scheduler.markDirty(true);
  return scheduler;
}

function expectOneEncryptedBackupTo(relays: string[]) {
  expect(published).toHaveLength(1);
  expect(published[0].kind).toBe(30078);
  expect(published[0].tags).toEqual([['d', 'few']]);
  expect(published[0].content).toMatch(/^encrypted:/);
  expect(fromRelayUrls).toHaveBeenLastCalledWith(relays, NDK);
}

describe('cold start, composed — the first backup lands soon after a failed first attempt', () => {
  it('connect fails at start-up: the backup lands 5 s after the failure', async () => {
    connectNdk.mockImplementationOnce(() => after(2.5 * SEC, new Error('connect timeout'), true));
    const scheduler = startScheduler();

    await vi.advanceTimersByTimeAsync(2.5 * SEC + 5 * SEC - 1);
    expect(published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expectOneEncryptedBackupTo([...DEFAULT_RELAYS]);
    expect(connectNdk).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('relay list times out and publish times out: the retry skips the list fetch and lands at ~18 s, not ~43 s', async () => {
    connectNdk.mockImplementationOnce(() => after(2.5 * SEC, NDK));
    fetchEventsWithTimeout.mockImplementationOnce(() => after(8 * SEC, fetched([], true)));
    ndkPublish.mockImplementationOnce(() =>
      after(2.5 * SEC, new Error('Not enough relays received the event'), true),
    );
    const scheduler = startScheduler();

    // Attempt 1 settles at 13 s; the early retry runs at 18 s without a fetch.
    await vi.advanceTimersByTimeAsync(13 * SEC + 5 * SEC - 1);
    expect(published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expectOneEncryptedBackupTo([...DEFAULT_RELAYS]);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('complete fetch A, user saves B, fetch times out, publish fails: the retry goes to B, never to A', async () => {
    configureRelays(['wss://a.example']);
    fetchEventsWithTimeout.mockResolvedValueOnce(fetched([listEvent(['wss://a.example'])]));
    expect(await getBackupRelays(NDK as never, PUB, { reuseAfterRecentTimeout: true })).toEqual(['wss://a.example']);

    configureRelays(['wss://b.example']);
    fetchEventsWithTimeout.mockImplementationOnce(() => after(8 * SEC, fetched([], true)));
    ndkPublish.mockRejectedValueOnce(new Error('Not enough relays received the event'));
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(8 * SEC + 5 * SEC);

    expectOneEncryptedBackupTo(['wss://b.example']);
    expect(fromRelayUrls.mock.calls.map((c) => c[0])).toEqual([['wss://b.example'], ['wss://b.example']]);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('configured relays edited inside the window: the next publish and the 5 s retry both use the new set', async () => {
    configureRelays(['wss://a.example']);
    fetchEventsWithTimeout.mockImplementationOnce(() => after(8 * SEC, fetched([], true)));
    ndkPublish.mockRejectedValueOnce(new Error('Not enough relays received the event'));
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(8 * SEC);
    expect(fromRelayUrls.mock.calls.map((c) => c[0])).toEqual([['wss://a.example']]);

    // User edits relays during the 5 s wait; the retry (fetch skipped) uses them.
    configureRelays(['wss://b.example']);
    ndkPublish.mockRejectedValueOnce(new Error('Not enough relays received the event'));
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(fromRelayUrls.mock.calls.map((c) => c[0])).toEqual([['wss://a.example'], ['wss://b.example']]);

    // Next publish (the 30 s retry), still inside the window: the newest set again.
    configureRelays(['wss://c.example']);
    await vi.advanceTimersByTimeAsync(30 * SEC);
    expectOneEncryptedBackupTo(['wss://c.example']);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('publish timeout (indeterminate) is retried like a refusal — current semantics kept', async () => {
    ndkPublish.mockImplementationOnce(() => after(2.5 * SEC, new Error('Timeout'), true));
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(2.5 * SEC + 5 * SEC);
    expect(ndkPublish).toHaveBeenCalledTimes(2);
    expectOneEncryptedBackupTo([...DEFAULT_RELAYS]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(ndkPublish).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('publish refused outright is retried the same way', async () => {
    ndkPublish.mockRejectedValueOnce(new Error('blocked: rate-limited'));
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(ndkPublish).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
    scheduler.dispose();
  });

  it('success path: a healthy start publishes once, immediately, with one relay-list fetch', async () => {
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expectOneEncryptedBackupTo([...DEFAULT_RELAYS]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(published).toHaveLength(1);
    expect(fetchEventsWithTimeout).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('relays down for longer: early retry, then the regular schedule (30 s after the early retry)', async () => {
    connectNdk.mockRejectedValue(new Error('offline'));
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(connectNdk).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(connectNdk).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectNdk).toHaveBeenCalledTimes(3);
    expect(published).toHaveLength(0);
    scheduler.dispose();
  });
});
