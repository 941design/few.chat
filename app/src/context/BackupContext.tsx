/**
 * BackupContext — provides BackupScheduler lifecycle and markDirty to the app.
 *
 * Wraps a BackupScheduler that calls publishBackup when state changes.
 * Other contexts (MarmotContext, ProfileContext) call markDirty to trigger
 * a debounced backup publish.
 *
 * markDirty is routed through module-level state rather than React context:
 * ProfileProvider sits above NostrIdentityProvider (and so above this
 * provider), and providers' mount effects run child-first, so a context-only
 * hand-off silently dropped changes marked before the scheduler existed.
 */

import React, { createContext, useContext, useEffect } from 'react';
import {
  BackupScheduler,
  isRestorePending,
  lookupBackup,
  publishBackup,
  settleRestoreGuard,
} from '@/src/lib/backup/relayBackup';
import { clearDirtyMarkIfUnchanged, readDirtyMark, readDirtyToken, writeDirtyMark } from '@/src/lib/backup/dirtyMark';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';

type BackupContextValue = {
  markDirty: (immediate?: boolean) => void;
};

const BackupContext = createContext<BackupContextValue | null>(null);

/**
 * One scheduled backup attempt. Resolves `false` when the backup was not
 * published (no NDK instance yet, or every relay refused it) so the scheduler
 * retries instead of treating a skipped backup as done.
 *
 * While a restore decision is pending for this identity, the relay backup is
 * looked up first and never overwritten while it may still be restored; the
 * attempt then resolves `true` (paused, not failed — nothing to retry).
 */
export async function publishScheduledBackup(
  privateKeyHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  // A change marked after this point (by this tab or another: the key is
  // shared) is not guaranteed to be in the snapshot this attempt publishes, so
  // only the mark that existed now may be cleared by a success.
  const dirtyTokenAtStart = readDirtyToken();
  if (isRestorePending(pubkeyHex)) {
    const lookup = await lookupBackup(privateKeyHex, pubkeyHex);
    if (lookup.status === 'unreachable') return false;
    settleRestoreGuard(lookup);
    if (isRestorePending(pubkeyHex)) return true;
  }
  const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
  const signer = createPrivateKeySigner(privateKeyHex);
  // Connect first: right after start-up the shared client may not be connected
  // yet, and an unconnected publish reaches no relay.
  const { connectNdk } = await import('@/src/lib/ndkClient');
  let ndk;
  try {
    ndk = await connectNdk(privateKeyHex);
  } catch (err) {
    console.warn('[Backup] relay connection failed:', err);
    return false;
  }
  const result = await publishBackup(signer, pubkeyHex, ndk);
  if (!result.ok) console.warn('[Backup] publish failed:', result.error);
  // The persisted mark is cleared only by a publish that really happened (not
  // by a failure, nor by the restore-pending pause above) and only if nothing
  // was marked (re-tokened) since the attempt began.
  if (result.ok) clearDirtyMarkIfUnchanged(dirtyTokenAtStart);
  return result.ok;
}

let activeScheduler: BackupScheduler | null = null;
let pendingDirty: { immediate: boolean } | null = null;

/**
 * Mark backup state dirty. The mark is persisted (localStorage) until a
 * publish succeeds, so an early reload cannot lose it; it is forwarded to the
 * active scheduler, or remembered until one starts (identity not yet
 * hydrated, or being switched).
 */
export function markBackupDirty(immediate?: boolean): void {
  writeDirtyMark(!!immediate);
  if (activeScheduler) {
    activeScheduler.markDirty(immediate);
  } else {
    pendingDirty = { immediate: !!immediate || !!pendingDirty?.immediate };
  }
}

/**
 * Install a scheduler as the active one, replaying any mark made before it
 * existed — in this page load, or persisted by an earlier one that ended
 * before its backup was published.
 */
export function activateBackupScheduler(scheduler: BackupScheduler): () => void {
  activeScheduler = scheduler;
  const persisted = readDirtyMark();
  const pending = pendingDirty || persisted
    ? { immediate: !!pendingDirty?.immediate || !!persisted?.immediate }
    : null;
  pendingDirty = null;
  if (pending) scheduler.markDirty(pending.immediate);
  return () => {
    if (activeScheduler === scheduler) activeScheduler = null;
  };
}

export function BackupProvider({ children }: { children: React.ReactNode }) {
  const { privateKeyHex, pubkeyHex } = useNostrIdentity();

  useEffect(() => {
    if (!privateKeyHex || !pubkeyHex) return;

    const currentPubkey = pubkeyHex;
    const currentPrivKey = privateKeyHex;

    const scheduler = new BackupScheduler(() =>
      publishScheduledBackup(currentPrivKey, currentPubkey),
    );

    const deactivate = activateBackupScheduler(scheduler);

    // Visibility change listener — backup on page hide
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        markBackupDirty(true);
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      deactivate();
      scheduler.dispose();
    };
  }, [privateKeyHex, pubkeyHex]);

  return (
    <BackupContext.Provider value={BACKUP_CONTEXT_VALUE}>
      {children}
    </BackupContext.Provider>
  );
}

const BACKUP_CONTEXT_VALUE: BackupContextValue = { markDirty: markBackupDirty };

export function useBackup(): BackupContextValue {
  // Outside the provider (ProfileProvider, tests) the module-level hand-off
  // still reaches the scheduler once one is running.
  return useContext(BackupContext) ?? BACKUP_CONTEXT_VALUE;
}
