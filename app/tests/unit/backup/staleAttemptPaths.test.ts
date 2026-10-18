/**
 * Where a stale scheduled attempt (backups suspended, or its identity no longer
 * the scheduler's) stops: at entry, and after each await before it could touch
 * the relays or the shared NDK client. Also the scheduler hand-over and the
 * suspension listener bookkeeping (bug: backup-empty-snapshot-publish-after-wipe).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'few-backup-dirty';
const connectNdk = vi.fn();
const publishBackup = vi.fn();
const lookupBackup = vi.fn();
const settleRestoreGuard = vi.fn();
const ndkClientLoaded = vi.fn();
let onSignerAdapterLoaded: () => void = () => {};
let restorePending = false;

vi.mock('@/src/lib/ndkClient', () => {
  ndkClientLoaded();
  return { connectNdk: (...a: unknown[]) => connectNdk(...a) };
});
vi.mock('@/src/lib/marmot/signerAdapter', () => {
  onSignerAdapterLoaded();
  return { createPrivateKeySigner: () => ({ signer: true }) };
});
vi.mock('@/src/lib/backup/relayBackup', () => ({
  BackupScheduler: class {},
  publishBackup: (...a: unknown[]) => publishBackup(...a),
  lookupBackup: (...a: unknown[]) => lookupBackup(...a),
  isRestorePending: () => restorePending,
  settleRestoreGuard: (...a: unknown[]) => settleRestoreGuard(...a),
}));
vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));

type Backup = typeof import('@/src/context/BackupContext');
type Suspension = typeof import('@/src/lib/backup/suspension');

let store: Map<string, string>;
let storageReads: string[];

async function load(): Promise<{ backup: Backup; suspension: Suspension }> {
  vi.resetModules();
  return {
    backup: await import('@/src/context/BackupContext'),
    suspension: await import('@/src/lib/backup/suspension'),
  };
}

const sched = () => {
  const markDirty = vi.fn();
  const dispose = vi.fn();
  return { markDirty, dispose, scheduler: { markDirty, dispose } as never };
};

beforeEach(() => {
  store = new Map([[KEY, 'debounced:tok']]);
  storageReads = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      storageReads.push(k);
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  connectNdk.mockReset().mockResolvedValue({ ndk: true });
  publishBackup.mockReset().mockResolvedValue({ ok: true });
  lookupBackup.mockReset();
  settleRestoreGuard.mockReset();
  ndkClientLoaded.mockReset();
  onSignerAdapterLoaded = () => {};
  restorePending = false;
});

describe('a stale attempt', () => {
  it('stops at entry: reads no mark, does no lookup, never loads or calls the NDK client', async () => {
    const { backup } = await load();
    restorePending = true;
    // No scheduler is bound, so the attempt's identity is not current.
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(storageReads).not.toContain(KEY);
    expect(lookupBackup).not.toHaveBeenCalled();
    expect(ndkClientLoaded).not.toHaveBeenCalled();
    expect(connectNdk).not.toHaveBeenCalled();
  });

  it('after an unreachable lookup that went stale meanwhile: nothing to retry, guard not settled', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler(sched().scheduler, 'bb');
    restorePending = true;
    lookupBackup.mockImplementation(async () => {
      suspension.bindBackupIdentity(null);
      return { status: 'unreachable' };
    });
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(settleRestoreGuard).not.toHaveBeenCalled();
    expect(connectNdk).not.toHaveBeenCalled();
  });

  it('after the signer import: never calls connectNdk', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler(sched().scheduler, 'bb');
    onSignerAdapterLoaded = () => suspension.bindBackupIdentity(null);
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(connectNdk).not.toHaveBeenCalled();
    expect(publishBackup).not.toHaveBeenCalled();
  });

  it('after connecting: never reaches publishBackup', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler(sched().scheduler, 'bb');
    connectNdk.mockImplementation(async () => {
      suspension.suspendBackups();
      return { ndk: true };
    });
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(publishBackup).not.toHaveBeenCalled();
  });
});

describe('a publish dropped by the pre-publish guard', () => {
  it('is reported as nothing to retry and leaves the dirty mark', async () => {
    const { backup } = await load();
    backup.activateBackupScheduler(sched().scheduler, 'bb');
    publishBackup.mockResolvedValue({ ok: false, skipped: true });
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.get(KEY)).toBe('debounced:tok');
  });
});

describe('scheduler hand-over', () => {
  it("an old scheduler's deactivate after a new activation keeps the new scheduler and binding", async () => {
    const { backup, suspension } = await load();
    const deactivateOld = backup.activateBackupScheduler(sched().scheduler, 'old');
    const next = sched();
    backup.activateBackupScheduler(next.scheduler, 'new');

    deactivateOld();

    expect(suspension.isBackupIdentityCurrent('new')).toBe(true);
    backup.markBackupDirty(true);
    expect(next.markDirty).toHaveBeenCalledWith(true);
  });

  it('suspension disposes the active scheduler', async () => {
    const { backup, suspension } = await load();
    const { scheduler, dispose } = sched();
    backup.activateBackupScheduler(scheduler, 'bb');
    suspension.suspendBackups();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('onBackupsSuspended', () => {
  it('runs a listener once even if suspendBackups is called again', async () => {
    const { suspension } = await load();
    const listener = vi.fn();
    suspension.onBackupsSuspended(listener);
    suspension.suspendBackups();
    suspension.suspendBackups();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops calling a listener once it unsubscribed', async () => {
    const { suspension } = await load();
    const listener = vi.fn();
    const unsubscribe = suspension.onBackupsSuspended(listener);
    unsubscribe();
    suspension.suspendBackups();
    expect(listener).not.toHaveBeenCalled();
  });
});
