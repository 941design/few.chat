/**
 * The pre-publish guard against the REAL publishBackup (bug:
 * backup-empty-snapshot-publish-after-wipe). Relay discovery inside
 * publishBackup can take seconds; a wipe or identity replace landing while it
 * is pending must still stop the network publish, and leave the dirty mark
 * for the identity that owns it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'few-backup-dirty';
const netPublish = vi.fn();
const fetchEvents = vi.fn();
const connectNdk = vi.fn();

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKEvent: class {
    publish = (...a: unknown[]) => netPublish(...a);
  },
  NDKRelaySet: { fromRelayUrls: () => 'relay-set' },
}));
vi.mock('@/src/lib/ndkClient', () => ({
  fetchEventsWithTimeout: (...a: unknown[]) => fetchEvents(...a),
  connectNdk: (...a: unknown[]) => connectNdk(...a),
}));
vi.mock('@/src/lib/marmot/signerAdapter', () => ({
  createPrivateKeySigner: () => ({
    nip44: { encrypt: async (_p: string, t: string) => `enc:${t}` },
    signEvent: async (d: Record<string, unknown>) => ({ ...d, id: 'i', pubkey: 'p', sig: 's' }),
  }),
}));
vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));
vi.mock('idb-keyval', () => ({
  createStore: () => 'store',
  get: async () => undefined,
  set: async () => {},
  del: async () => {},
  delMany: async () => {},
  keys: async () => [],
  clear: async () => {},
  entries: async () => [],
}));

type Backup = typeof import('@/src/context/BackupContext');
type Suspension = typeof import('@/src/lib/backup/suspension');

let store: Map<string, string>;
let releaseDiscovery: () => void;

async function load(): Promise<{ backup: Backup; suspension: Suspension }> {
  vi.resetModules();
  return {
    backup: await import('@/src/context/BackupContext'),
    suspension: await import('@/src/lib/backup/suspension'),
  };
}

beforeEach(() => {
  store = new Map([[KEY, 'debounced:tok']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: () => null,
    length: 0,
  });
  netPublish.mockReset().mockResolvedValue(undefined);
  connectNdk.mockReset().mockResolvedValue({ ndk: true });
  // Relay discovery stays pending until the test releases it.
  fetchEvents.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseDiscovery = () => resolve({ events: new Set(), timedOut: false });
      }),
  );
});

/** Starts an attempt and returns once it is waiting on relay discovery. */
async function startAttempt(backup: Backup, pubkey: string): Promise<{ done: Promise<boolean> }> {
  const attempt = backup.publishScheduledBackup('aa', pubkey);
  await vi.waitFor(() => expect(fetchEvents).toHaveBeenCalled());
  return { done: attempt };
}

describe('an attempt whose relay discovery is still pending', () => {
  it('publishes when nothing changed meanwhile (control)', async () => {
    const { backup } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'bb');
    const { done: attempt } = await startAttempt(backup, 'bb');
    releaseDiscovery();
    expect(await attempt).toBe(true);
    expect(netPublish).toHaveBeenCalledTimes(1);
    expect(store.has(KEY)).toBe(false);
  });

  it('does not reach the network after a suspension, and keeps the dirty mark', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'bb');
    const { done: attempt } = await startAttempt(backup, 'bb');
    suspension.suspendBackups();
    releaseDiscovery();
    expect(await attempt).toBe(true);
    expect(netPublish).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe('debounced:tok');
  });

  it('does not reach the network after the identity was replaced, and keeps the dirty mark', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'old');
    const { done: attempt } = await startAttempt(backup, 'old');
    suspension.bindBackupIdentity(null);
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'new');
    releaseDiscovery();
    expect(await attempt).toBe(true);
    expect(netPublish).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe('debounced:tok');
  });
});

describe('a stale attempt before relay discovery', () => {
  it('never connects the shared client under the old key after an identity replace', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'old');
    suspension.bindBackupIdentity(null);
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'new');

    expect(await backup.publishScheduledBackup('oldkey', 'old')).toBe(true);
    expect(connectNdk).not.toHaveBeenCalled();
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it('is dropped when the identity is replaced while the restore lookup or connect is pending', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'old');
    let release!: () => void;
    connectNdk.mockImplementation(() => new Promise((r) => { release = () => r({ ndk: true }); }));
    const attempt = backup.publishScheduledBackup('oldkey', 'old');
    await vi.waitFor(() => expect(connectNdk).toHaveBeenCalled());
    suspension.bindBackupIdentity(null);
    release();
    expect(await attempt).toBe(true);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(netPublish).not.toHaveBeenCalled();
  });
});

describe('replacing the identity (NostrIdentityContext.replaceIdentity seam)', () => {
  it('detaching the binding first stops the old attempt; the new scheduler still backs up', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'old');
    const { done: attempt } = await startAttempt(backup, 'old');
    suspension.bindBackupIdentity(null); // what replaceIdentity does before saving
    releaseDiscovery();
    expect(await attempt).toBe(true);
    expect(netPublish).not.toHaveBeenCalled();

    fetchEvents.mockReset().mockResolvedValue({ events: new Set(), timedOut: false });
    backup.activateBackupScheduler({ markDirty: vi.fn(), dispose: vi.fn() } as never, 'new');
    expect(await backup.publishScheduledBackup('newkey', 'new')).toBe(true);
    expect(netPublish).toHaveBeenCalledTimes(1);
  });
});
