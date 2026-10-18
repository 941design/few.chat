/**
 * Automatic relay backups run only in local signer mode (external-signer settings
 * notice). With a NIP-07/NIP-46 signer the stored local key is still loaded, so
 * gating on the key alone kept backing up with it — and connectNdk(localKey)
 * rebound NDK's signer away from the external one.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/ndkClient', () => ({ connectNdk: vi.fn() }));
vi.mock('@/src/lib/backup/relayBackup', () => ({ BackupScheduler: class {} }));
vi.mock('@/src/context/NostrIdentityContext', () => ({ useNostrIdentity: () => ({}) }));

const { shouldScheduleBackups } = await import('@/src/context/BackupContext');

describe('shouldScheduleBackups', () => {
  const key = { privateKeyHex: 'a'.repeat(64), pubkeyHex: 'b'.repeat(64) };

  it('schedules in local mode with a loaded identity', () => {
    expect(shouldScheduleBackups({ ...key, isLocalMode: true })).toBe(true);
  });

  it('does not schedule with an external signer even though the local key is loaded', () => {
    expect(shouldScheduleBackups({ ...key, isLocalMode: false })).toBe(false);
  });

  it('does not schedule before the identity is loaded', () => {
    expect(shouldScheduleBackups({ privateKeyHex: null, pubkeyHex: key.pubkeyHex, isLocalMode: true })).toBe(false);
    expect(shouldScheduleBackups({ privateKeyHex: key.privateKeyHex, pubkeyHex: null, isLocalMode: true })).toBe(false);
  });
});
