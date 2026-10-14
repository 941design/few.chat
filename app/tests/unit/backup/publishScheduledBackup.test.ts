/**
 * publishScheduledBackup — the BackupProvider's scheduled publish attempt
 * (epic: backup-restore-reliability, AC-BRR-8 and AC-BRR-12). It must report a
 * backup that was not published as a failure so BackupScheduler retries it, and
 * must never overwrite a relay backup the user has not yet restored or skipped.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const connectNdk = vi.fn();
const publishBackup = vi.fn();
const lookupBackup = vi.fn();
let pendingFor: string | null = null;

vi.mock('@/src/lib/ndkClient', () => ({ connectNdk: () => connectNdk() }));
vi.mock('@/src/lib/marmot/signerAdapter', () => ({ createPrivateKeySigner: () => ({ signer: true }) }));
vi.mock('@/src/lib/backup/relayBackup', () => ({
  BackupScheduler: class {},
  publishBackup: (...args: unknown[]) => publishBackup(...args),
  lookupBackup: (...args: unknown[]) => lookupBackup(...args),
  isRestorePending: (pk: string) => pendingFor === pk,
  settleRestoreGuard: (lookup: { status: string }) => {
    if (lookup.status === 'none') pendingFor = null;
  },
}));
vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));

import {
  publishScheduledBackup,
  markBackupDirty,
  activateBackupScheduler,
} from '@/src/context/BackupContext';
import type { BackupScheduler } from '@/src/lib/backup/relayBackup';

beforeEach(() => {
  connectNdk.mockReset();
  publishBackup.mockReset();
  lookupBackup.mockReset();
  pendingFor = null;
  connectNdk.mockResolvedValue({ ndk: true });
  publishBackup.mockResolvedValue({ ok: true });
});

describe('publishScheduledBackup', () => {
  it('reports success when the backup was published', async () => {
    expect(await publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(lookupBackup).not.toHaveBeenCalled();
  });

  it('reports failure when every relay refused the backup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishBackup.mockResolvedValue({ ok: false, error: 'Not enough relays received the event' });
    expect(await publishScheduledBackup('aa', 'bb')).toBe(false);
    warn.mockRestore();
  });

  it('reports failure when the relays cannot be connected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectNdk.mockRejectedValue(new Error('connect timeout'));
    expect(await publishScheduledBackup('aa', 'bb')).toBe(false);
    expect(publishBackup).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('publishScheduledBackup — restore decision pending (AC-BRR-12)', () => {
  it('never overwrites a backup that may still be restored', async () => {
    pendingFor = 'bb';
    lookupBackup.mockResolvedValue({ status: 'found', payload: {} });

    expect(await publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(publishBackup).not.toHaveBeenCalled();
  });

  it('retries later when relays cannot confirm whether a backup exists', async () => {
    pendingFor = 'bb';
    lookupBackup.mockResolvedValue({ status: 'unreachable' });

    expect(await publishScheduledBackup('aa', 'bb')).toBe(false);
    expect(publishBackup).not.toHaveBeenCalled();
  });

  it('publishes once the lookup shows there is no backup to protect', async () => {
    pendingFor = 'bb';
    lookupBackup.mockResolvedValue({ status: 'none' });

    expect(await publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(publishBackup).toHaveBeenCalledTimes(1);
    expect(pendingFor).toBeNull();
  });

  it('does not consult the guard of another identity', async () => {
    pendingFor = 'someone-else';
    expect(await publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(lookupBackup).not.toHaveBeenCalled();
    expect(publishBackup).toHaveBeenCalledTimes(1);
  });
});

describe('markBackupDirty — changes are never dropped for want of a scheduler', () => {
  const fakeScheduler = () => ({ markDirty: vi.fn() });

  it('replays a change marked before any scheduler exists', () => {
    markBackupDirty();
    markBackupDirty(true);
    const scheduler = fakeScheduler();
    const deactivate = activateBackupScheduler(scheduler as unknown as BackupScheduler);

    expect(scheduler.markDirty).toHaveBeenCalledTimes(1);
    expect(scheduler.markDirty).toHaveBeenCalledWith(true);
    deactivate();
  });

  it('forwards directly to the active scheduler and queues again once it is gone', () => {
    const first = fakeScheduler();
    const deactivate = activateBackupScheduler(first as unknown as BackupScheduler);
    markBackupDirty(false);
    expect(first.markDirty).toHaveBeenCalledWith(false);

    deactivate();
    markBackupDirty();
    const second = fakeScheduler();
    activateBackupScheduler(second as unknown as BackupScheduler)();
    expect(second.markDirty).toHaveBeenCalledWith(false);
    expect(first.markDirty).toHaveBeenCalledTimes(1);
  });

  it('does not replay a change twice', () => {
    markBackupDirty(true);
    const a = fakeScheduler();
    activateBackupScheduler(a as unknown as BackupScheduler)();
    const b = fakeScheduler();
    activateBackupScheduler(b as unknown as BackupScheduler)();
    expect(a.markDirty).toHaveBeenCalledTimes(1);
    expect(b.markDirty).not.toHaveBeenCalled();
  });
});
