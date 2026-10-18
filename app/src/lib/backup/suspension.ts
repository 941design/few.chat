/**
 * suspension.ts — page-lifetime stop for relay-backup publishes, plus the
 * identity the active scheduler is bound to.
 *
 * Once this tab begins wiping the local account (Danger Zone) or reloads on
 * another tab's account-changed notice, whatever is in storage no longer
 * belongs to the key the running scheduler publishes under; a publish then
 * (e.g. the unload flush) would replace that account's only recovery copy with
 * a wiped snapshot. Suspension is in-memory only: the next page load starts
 * normally for whatever identity it hydrates. A same-tab identity replace does
 * NOT suspend — the binding below lets an attempt of the replaced identity
 * drop itself while the new identity's scheduler keeps working.
 *
 * Lives in lib/ with no imports so storage.ts and crossTabReceiver.ts can call
 * it; BackupContext registers the scheduler teardown via onBackupsSuspended.
 */

let suspended = false;
let boundPubkey: string | null = null;
const listeners = new Set<() => void>();

/** Stop all backup publishing for the rest of this page lifetime. */
export function suspendBackups(): void {
  if (suspended) return;
  suspended = true;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A failing teardown must not keep the wipe or reload from proceeding.
    }
  }
}

export function isBackupsSuspended(): boolean {
  return suspended;
}

/** Run `listener` when backups get suspended. Returns the unsubscribe function. */
export function onBackupsSuspended(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record the identity of the active scheduler (null when none is active). */
export function bindBackupIdentity(pubkeyHex: string | null): void {
  boundPubkey = pubkeyHex;
}

/** True while `pubkeyHex` is the active scheduler's identity. */
export function isBackupIdentityCurrent(pubkeyHex: string): boolean {
  return boundPubkey === pubkeyHex;
}

/**
 * An identity replace is about to happen: detach the bound scheduler unless it
 * is already bound to `nextPubkeyHex` (a same-account restore keeps it, since
 * its effect would not re-run to bind again). Decided from the binding itself,
 * not from storage, so unreadable storage cannot leave backups off.
 */
export function detachBackupForReplace(nextPubkeyHex: string): void {
  if (boundPubkey !== nextPubkeyHex) boundPubkey = null;
}

/** Test seam: clear the flag and the binding (listeners other modules registered stay). */
export function resetBackupSuspensionForTests(): void {
  suspended = false;
  boundPubkey = null;
}
