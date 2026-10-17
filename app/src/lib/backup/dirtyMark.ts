/**
 * dirtyMark.ts — the persisted "a backup is owed" flag.
 *
 * BackupContext keeps an unsent dirty mark here (localStorage
 * `few-backup-dirty`) so a reload between "state changed" and "backup
 * published" does not silently drop the change. The value is
 * `<immediate|debounced>:<random token>` — no profile, identity or group
 * data. The token is fresh on every write so that a publish can clear the mark
 * by compare-and-clear: the key is shared by every open tab, and a tab whose
 * publish succeeded must not erase a mark another tab wrote meanwhile. The
 * only thing the flag influences is WHEN the already-allowed, self-encrypted
 * relay backup is published.
 *
 * Every access is wrapped: localStorage can be missing (SSR / Node) or throw
 * (private mode, blocked site data), and the flag is a best-effort safety net,
 * never a reason to fail a mark or a publish.
 */

import { STORAGE_KEYS } from '@/src/types';

export type DirtyMark = { immediate: boolean };

const IMMEDIATE = 'immediate';
const DEBOUNCED = 'debounced';

let tokenCounter = 0;

function freshToken(): string {
  tokenCounter += 1;
  return `${Date.now().toString(36)}${tokenCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** The raw stored value (the compare-and-clear token), or null. */
export function readDirtyToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.backupDirty);
  } catch {
    return null;
  }
}

/** The persisted mark, or null when none is stored (or storage is unreadable). */
export function readDirtyMark(): DirtyMark | null {
  const raw = readDirtyToken();
  if (raw === null) return null;
  return { immediate: raw.startsWith(IMMEDIATE) };
}

/** Persist a mark with a fresh token. An already stored 'immediate' is never downgraded. */
export function writeDirtyMark(immediate: boolean): void {
  try {
    const already = (localStorage.getItem(STORAGE_KEYS.backupDirty) ?? '').startsWith(IMMEDIATE);
    localStorage.setItem(
      STORAGE_KEYS.backupDirty,
      `${immediate || already ? IMMEDIATE : DEBOUNCED}:${freshToken()}`,
    );
  } catch {
    // Best effort only.
  }
}

/** Unconditionally remove the mark (account wipe). */
export function clearDirtyMark(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.backupDirty);
  } catch {
    // Best effort only.
  }
}

/**
 * Remove the mark only if it is still exactly `token` (the value read when the
 * publish began). A mark written since — by this tab or another — survives.
 */
export function clearDirtyMarkIfUnchanged(token: string | null): void {
  if (token === null) return;
  try {
    if (localStorage.getItem(STORAGE_KEYS.backupDirty) === token) {
      localStorage.removeItem(STORAGE_KEYS.backupDirty);
    }
  } catch {
    // Best effort only.
  }
}
