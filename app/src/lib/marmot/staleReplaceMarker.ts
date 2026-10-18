/**
 * Persistent replace-recovery marker (localStorage, survives a reload; bug
 * stale-welcome-reinvite). Set before a stale-group replace starts tearing
 * anything down; cleared only after the fresh join succeeded AND the purge was
 * clean. While set, every accept failure for the group keeps the invitation
 * (InvitationRetryableError), and the plain / orphan join paths purge residue
 * first. Account-scoped: resetAllData wipes every marker by prefix.
 */
export const RECOVERY_MARKER_PREFIX = 'few-stale-replace-recovery:';

export function hasRecoveryMarker(groupId: string): boolean {
  try {
    return localStorage.getItem(RECOVERY_MARKER_PREFIX + groupId) !== null;
  } catch {
    return false;
  }
}

export function setRecoveryMarker(groupId: string): void {
  try {
    localStorage.setItem(RECOVERY_MARKER_PREFIX + groupId, String(Date.now()));
  } catch { /* best-effort: without storage only the in-run retry guarantee holds */ }
}

export function clearRecoveryMarker(groupId: string): void {
  try {
    localStorage.removeItem(RECOVERY_MARKER_PREFIX + groupId);
  } catch { /* ignore */ }
}

/** Removes every marker (account wipe). */
export function clearAllRecoveryMarkers(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(RECOVERY_MARKER_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
