/**
 * settings-backup-notice.test.ts — `backupNoticeFor`, exported from
 * `app/pages/settings.tsx` (epic: backup-restore-reliability, AC-BRR-4).
 *
 * After an identity recovery, every backup lookup that finds nothing to apply
 * must surface its own notice instead of a bare success; only a found backup
 * (which opens the confirmation dialog) yields no notice. Page components are
 * not mounted in unit tests (no jsdom precedent), so the pure mapping is
 * exercised directly.
 */
import { describe, expect, it } from 'vitest';

import { backupNoticeFor } from '@/pages/settings';
import type { BackupPayload } from '@/src/lib/backup/relayBackup';

describe('backupNoticeFor', () => {
  it('maps each non-found lookup to its own notice', () => {
    expect(backupNoticeFor({ status: 'none' })).toBe('none');
    expect(backupNoticeFor({ status: 'unreachable' })).toBe('unreachable');
    expect(backupNoticeFor({ status: 'unusable', reason: 'newer-version' })).toBe('unusable');
    expect(backupNoticeFor({ status: 'unusable', reason: 'unreadable' })).toBe('unusable');
  });

  it('shows no notice when a backup was found', () => {
    expect(backupNoticeFor({ status: 'found', payload: {} as BackupPayload })).toBeNull();
  });
});
