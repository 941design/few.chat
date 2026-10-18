/**
 * Backup suspension (bug: backup-empty-snapshot-publish-after-wipe).
 *
 * Once this tab begins wiping the local account (Danger Zone) or reloads on
 * another tab's account-changed notice, nothing more may be published as the
 * old account's backup in this page lifetime — the unload flush would
 * otherwise snapshot the wiped storage under the old key and replace the only
 * recovery copy. An in-flight attempt bound to a replaced identity must not
 * publish either, while the new identity in the same tab still backs up.
 * A reload = module registry reset while the fake localStorage survives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'few-backup-dirty';

const connectNdk = vi.fn();
const publishBackup = vi.fn();

vi.mock('@/src/lib/ndkClient', () => ({ connectNdk: () => connectNdk() }));
vi.mock('@/src/lib/marmot/signerAdapter', () => ({ createPrivateKeySigner: () => ({ signer: true }) }));
vi.mock('@/src/lib/backup/relayBackup', () => ({
  BackupScheduler: class {},
  publishBackup: (...args: unknown[]) => publishBackup(...args),
  lookupBackup: vi.fn(),
  isRestorePending: () => false,
  settleRestoreGuard: vi.fn(),
}));
vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));

type Backup = typeof import('@/src/context/BackupContext');
type Suspension = typeof import('@/src/lib/backup/suspension');
type SchedulerArg = Parameters<Backup['activateBackupScheduler']>[0];

let store: Map<string, string>;

function fakeScheduler() {
  const markDirty = vi.fn();
  const dispose = vi.fn();
  return { markDirty, dispose, scheduler: { markDirty, dispose } as unknown as SchedulerArg };
}

async function load(): Promise<{ backup: Backup; suspension: Suspension }> {
  vi.resetModules();
  const backup = await import('@/src/context/BackupContext');
  const suspension = await import('@/src/lib/backup/suspension');
  return { backup, suspension };
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  connectNdk.mockReset().mockResolvedValue({ ndk: true });
  publishBackup.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('after suspendBackups', () => {
  it('forwards no mark to the active scheduler and writes no persisted mark', async () => {
    const { backup, suspension } = await load();
    const { scheduler, markDirty } = fakeScheduler();
    backup.activateBackupScheduler(scheduler, 'bb');

    suspension.suspendBackups();
    backup.markBackupDirty(true);
    backup.markBackupDirty();

    expect(markDirty).not.toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
  });

  it('disposes the active scheduler', async () => {
    const { backup, suspension } = await load();
    const { scheduler, dispose } = fakeScheduler();
    backup.activateBackupScheduler(scheduler, 'bb');

    suspension.suspendBackups();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not replay a previously persisted mark into a scheduler activated later', async () => {
    const { backup, suspension } = await load();
    store.set(KEY, 'immediate:tok');
    suspension.suspendBackups();
    const { scheduler, markDirty } = fakeScheduler();

    backup.activateBackupScheduler(scheduler, 'bb');

    expect(markDirty).not.toHaveBeenCalled();
  });

  it('publishes nothing from a scheduled attempt and reports nothing to retry', async () => {
    const { backup, suspension } = await load();
    suspension.suspendBackups();

    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(connectNdk).not.toHaveBeenCalled();
    expect(publishBackup).not.toHaveBeenCalled();
  });

  it('is not persisted: the next page load starts normally', async () => {
    const first = await load();
    first.suspension.suspendBackups();

    const { backup } = await load();
    const { scheduler, markDirty } = fakeScheduler();
    backup.activateBackupScheduler(scheduler, 'bb');
    backup.markBackupDirty(true);

    expect(markDirty).toHaveBeenCalledWith(true);
  });
});

describe('an attempt already in flight', () => {
  /** Runs the guard the way publishBackup does, right before the network publish. */
  async function guardOf(backup: Backup, pubkey: string): Promise<() => boolean> {
    let guard: (() => boolean) | undefined;
    publishBackup.mockImplementation(async (_s: unknown, _p: unknown, _n: unknown, g?: () => boolean) => {
      guard = g;
      return { ok: true };
    });
    await backup.publishScheduledBackup('aa', pubkey);
    if (!guard) throw new Error('publishScheduledBackup passed no pre-publish guard');
    return guard;
  }

  it('may publish while its identity is the active one', async () => {
    const { backup } = await load();
    backup.activateBackupScheduler(fakeScheduler().scheduler, 'bb');
    expect((await guardOf(backup, 'bb'))()).toBe(true);
  });

  it('must not publish once backups are suspended', async () => {
    const { backup, suspension } = await load();
    backup.activateBackupScheduler(fakeScheduler().scheduler, 'bb');
    const guard = await guardOf(backup, 'bb');
    suspension.suspendBackups();
    expect(guard()).toBe(false);
  });

  it('must not publish once another identity replaced it in this tab', async () => {
    const { backup } = await load();
    const deactivate = backup.activateBackupScheduler(fakeScheduler().scheduler, 'old');
    const guard = await guardOf(backup, 'old');
    deactivate();
    backup.activateBackupScheduler(fakeScheduler().scheduler, 'new');
    expect(guard()).toBe(false);
  });

  it('must not publish once its scheduler was deactivated with no replacement', async () => {
    const { backup } = await load();
    const deactivate = backup.activateBackupScheduler(fakeScheduler().scheduler, 'old');
    const guard = await guardOf(backup, 'old');
    deactivate();
    expect(guard()).toBe(false);
  });

  it('leaves the persisted mark alone when its publish was dropped', async () => {
    const { backup } = await load();
    store.set(KEY, 'debounced:tok');
    publishBackup.mockResolvedValue({ ok: false, skipped: true });
    expect(await backup.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.get(KEY)).toBe('debounced:tok');
  });
});

describe('an identity replace in the same tab (no suspension)', () => {
  it('still backs up the new identity', async () => {
    const { backup } = await load();
    const deactivateOld = backup.activateBackupScheduler(fakeScheduler().scheduler, 'old');
    deactivateOld();
    const next = fakeScheduler();
    backup.activateBackupScheduler(next.scheduler, 'new');
    backup.markBackupDirty(true);
    expect(next.markDirty).toHaveBeenCalledWith(true);

    let guard: (() => boolean) | undefined;
    publishBackup.mockImplementation(async (_s: unknown, _p: unknown, _n: unknown, g?: () => boolean) => {
      guard = g;
      return { ok: true };
    });
    expect(await backup.publishScheduledBackup('aa', 'new')).toBe(true);
    expect(guard?.()).toBe(true);
  });
});

describe('test seam', () => {
  it('resetBackupSuspensionForTests keeps the listeners other modules registered', async () => {
    const { backup, suspension } = await load();
    const { scheduler, dispose } = fakeScheduler();
    backup.activateBackupScheduler(scheduler, 'bb');
    suspension.resetBackupSuspensionForTests();
    suspension.suspendBackups();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('detachBackupForReplace', () => {
  it('keeps the binding when the replacement is the same account', async () => {
    const { suspension } = await load();
    suspension.bindBackupIdentity('aa');
    suspension.detachBackupForReplace('aa');
    expect(suspension.isBackupIdentityCurrent('aa')).toBe(true);
  });

  it('unbinds when the replacement is a different account', async () => {
    const { suspension } = await load();
    suspension.bindBackupIdentity('aa');
    suspension.detachBackupForReplace('bb');
    expect(suspension.isBackupIdentityCurrent('aa')).toBe(false);
    expect(suspension.isBackupIdentityCurrent('bb')).toBe(false);
  });
});
