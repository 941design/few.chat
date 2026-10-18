/**
 * Persisted backup dirty mark (bug: decided-small-fixes #2).
 *
 * A change marked before the backup scheduler exists (identity still loading)
 * used to live only in module memory, so a reload in that window lost it. The
 * unsent mark is now kept in localStorage (`few-backup-dirty`), cleared only
 * after a publish that actually succeeded, and replayed when a scheduler
 * activates. "Reload" = reset the module registry while the fake localStorage
 * survives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'few-backup-dirty';

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

type Backup = typeof import('@/src/context/BackupContext');
type SchedulerArg = Parameters<Backup['activateBackupScheduler']>[0];

let store: Map<string, string>;
let throwing: boolean;

function fakeScheduler() {
  const markDirty = vi.fn();
  return { markDirty, scheduler: { markDirty } as unknown as SchedulerArg };
}

/** A fresh page load: module state is gone, localStorage is kept. */
async function reload(): Promise<Backup> {
  vi.resetModules();
  const mod = await import('@/src/context/BackupContext');
  // As BackupProvider does: the attempt's identity is the active scheduler's.
  (await import('@/src/lib/backup/suspension')).bindBackupIdentity('bb');
  return mod;
}

beforeEach(() => {
  store = new Map();
  throwing = false;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (throwing) throw new Error('SecurityError');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error('QuotaExceededError');
      store.set(k, v);
    },
    removeItem: (k: string) => {
      if (throwing) throw new Error('SecurityError');
      store.delete(k);
    },
  });
  connectNdk.mockReset().mockResolvedValue({ ndk: true });
  publishBackup.mockReset().mockResolvedValue({ ok: true });
  lookupBackup.mockReset();
  pendingFor = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a mark raised before any scheduler exists', () => {
  it('is persisted and replayed by the scheduler of the next page load', async () => {
    const first = await reload();
    first.markBackupDirty();
    expect(store.has(KEY)).toBe(true);

    const second = await reload(); // early reload: in-memory mark is gone
    const { markDirty, scheduler } = fakeScheduler();
    second.activateBackupScheduler(scheduler, 'bb');
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('keeps the immediate flag across the reload', async () => {
    const first = await reload();
    first.markBackupDirty(false);
    first.markBackupDirty(true);
    first.markBackupDirty(false);

    const second = await reload();
    const { markDirty, scheduler } = fakeScheduler();
    second.activateBackupScheduler(scheduler, 'bb');
    expect(markDirty).toHaveBeenCalledWith(true);
  });

  it('an unhurried mark is replayed as non-immediate (immediacy is not invented)', async () => {
    const first = await reload();
    first.markBackupDirty();
    first.markBackupDirty(false);

    const second = await reload();
    const { markDirty, scheduler } = fakeScheduler();
    second.activateBackupScheduler(scheduler, 'bb');
    expect(markDirty).toHaveBeenCalledWith(false);
  });

  it('replays nothing when nothing was marked', async () => {
    const mod = await reload();
    const { markDirty, scheduler } = fakeScheduler();
    mod.activateBackupScheduler(scheduler, 'bb');
    expect(markDirty).not.toHaveBeenCalled();
  });
});

describe('a mark raised while a scheduler is active', () => {
  it('is forwarded to the scheduler AND persisted until a publish succeeds', async () => {
    const mod = await reload();
    const { markDirty, scheduler } = fakeScheduler();
    mod.activateBackupScheduler(scheduler, 'bb');
    mod.markBackupDirty(true);
    expect(markDirty).toHaveBeenCalledWith(true);
    expect(store.has(KEY)).toBe(true);
  });
});

describe('clearing the persisted mark', () => {
  async function marked(): Promise<Backup> {
    const mod = await reload();
    mod.markBackupDirty();
    expect(store.has(KEY)).toBe(true);
    return mod;
  }

  it('happens after a successful publish', async () => {
    const mod = await marked();
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  it('does not happen when every relay refused the backup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishBackup.mockResolvedValue({ ok: false, error: 'refused' });
    const mod = await marked();
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(false);
    expect(store.has(KEY)).toBe(true);
    warn.mockRestore();
  });

  it('does not happen when the relays cannot be connected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectNdk.mockRejectedValue(new Error('timeout'));
    const mod = await marked();
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(false);
    expect(store.has(KEY)).toBe(true);
    warn.mockRestore();
  });

  it('does not happen when the publish was paused for a pending restore decision', async () => {
    pendingFor = 'bb';
    lookupBackup.mockResolvedValue({ status: 'found', payload: {} });
    const mod = await marked();
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(true); // paused, not failed
    expect(publishBackup).not.toHaveBeenCalled();
    expect(store.has(KEY)).toBe(true);
  });

  it('does not happen when a new change was marked while the publish was in flight', async () => {
    const mod = await marked();
    publishBackup.mockImplementation(async () => {
      mod.markBackupDirty(); // change raised mid-publish, not part of this snapshot
      return { ok: true };
    });
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.has(KEY)).toBe(true);
  });

  it('a later successful publish clears a mark kept by an earlier failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishBackup.mockResolvedValueOnce({ ok: false, error: 'refused' });
    const mod = await marked();
    await mod.publishScheduledBackup('aa', 'bb');
    expect(store.has(KEY)).toBe(true);
    await mod.publishScheduledBackup('aa', 'bb');
    expect(store.has(KEY)).toBe(false);
    warn.mockRestore();
  });
});

describe('unavailable localStorage', () => {
  it('never throws and still hands the mark to a scheduler of the same page load', async () => {
    throwing = true;
    const mod = await reload();
    expect(() => mod.markBackupDirty(true)).not.toThrow();
    const { markDirty, scheduler } = fakeScheduler();
    expect(() => mod.activateBackupScheduler(scheduler, 'bb')).not.toThrow();
    expect(markDirty).toHaveBeenCalledWith(true);
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(true);
  });

  it('a throwing read on activation does not break the scheduler', async () => {
    const mod = await reload();
    throwing = true;
    const { markDirty, scheduler } = fakeScheduler();
    expect(() => mod.activateBackupScheduler(scheduler, 'bb')).not.toThrow();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('a missing localStorage global (SSR / Node) is tolerated', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', undefined);
    const mod = await reload();
    expect(() => mod.markBackupDirty()).not.toThrow();
    expect(await mod.publishScheduledBackup('aa', 'bb')).toBe(true);
  });
});

describe('dirtyMark storage helpers', () => {
  it('store a non-empty, distinct word per kind and read it back', async () => {
    const { readDirtyMark, writeDirtyMark, clearDirtyMark } = await import('@/src/lib/backup/dirtyMark');
    expect(readDirtyMark()).toBeNull();
    writeDirtyMark(false);
    const debounced = store.get(KEY);
    expect(debounced).toMatch(/^debounced:.+/);
    expect(readDirtyMark()).toEqual({ immediate: false });
    writeDirtyMark(true);
    const immediate = store.get(KEY);
    expect(immediate).toMatch(/^immediate:.+/);
    expect(immediate).not.toBe(debounced);
    expect(readDirtyMark()).toEqual({ immediate: true });
    writeDirtyMark(false); // never downgrades
    expect(readDirtyMark()).toEqual({ immediate: true });
    clearDirtyMark();
    expect(readDirtyMark()).toBeNull();
  });

  it('read reports no mark (null) when storage throws', async () => {
    const { readDirtyMark } = await import('@/src/lib/backup/dirtyMark');
    throwing = true;
    expect(readDirtyMark()).toBeNull();
  });
});

describe('the mark is shared by every tab: compare-and-clear', () => {
  it('a publish in tab A does not erase a mark tab B wrote while it ran', async () => {
    const tabA = await reload();
    tabA.markBackupDirty();
    const tabB = await reload(); // a second module instance over the SAME localStorage
    publishBackup.mockImplementation(async () => {
      tabB.markBackupDirty(); // tab B marks mid-publish
      return { ok: true };
    });
    expect(await tabA.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.has(KEY)).toBe(true);
  });

  it('a mark written by another tab before the publish began is covered by it and cleared', async () => {
    const tabA = await reload();
    const tabB = await reload();
    tabB.markBackupDirty();
    expect(await tabA.publishScheduledBackup('aa', 'bb')).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  it('every mark gets a fresh token, and the token carries no identity data', async () => {
    const mod = await reload();
    mod.markBackupDirty();
    const first = store.get(KEY);
    mod.markBackupDirty();
    const second = store.get(KEY);
    expect(second).not.toBe(first);
    expect(first).toMatch(/^(immediate|debounced):[0-9a-z]+$/);
  });

  it('a publish that started with no mark leaves a mark written during it', async () => {
    const mod = await reload();
    publishBackup.mockImplementation(async () => {
      mod.markBackupDirty();
      return { ok: true };
    });
    await mod.publishScheduledBackup('aa', 'bb');
    expect(store.has(KEY)).toBe(true);
  });
});
