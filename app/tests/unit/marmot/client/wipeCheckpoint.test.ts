import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPersistence, createMemoryStorage } from '@941design/marmot/storage/memory';
import { createStoreWipeGuard, resumeWipeCleanup } from '@/src/lib/marmot/client/wipe';
import { groupSessionWipeCheckpoint as checkpoint, wipeApplicationGroups, resumeApplicationWipe } from '@/src/lib/marmot/groupSessionWipeCheckpoint';

const account = 'ab'.repeat(32);

describe('durable app wipe checkpoint', () => {
  it('resumes committed cleanup after reopening, but never cleans for an uncommitted intent', async () => {
    const persistence = createMemoryPersistence();
    const stores = await createMemoryStorage({ persistence }).openForWrite(account);
    const cleanup = vi.fn(async () => {});
    await checkpoint.write(account, null);
    await resumeWipeCleanup(stores, checkpoint, cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await checkpoint.read(account)).toEqual({ previousMarker: null });
    await checkpoint.clear(account);
    const failure = new Error('app storage failed');
    await expect(createStoreWipeGuard().wipe(stores, async () => { throw failure; }, checkpoint)).rejects.toBe(failure);
    expect(await checkpoint.read(account)).toEqual({ previousMarker: null });
    await stores.close();
    const reopened = await createMemoryStorage({ persistence }).openForWrite(account);
    await resumeWipeCleanup(reopened, checkpoint, cleanup);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(account);
    expect(await checkpoint.read(account)).toBeUndefined();
    await reopened.close();
  });
  it('retries an explicit wipe after app cleanup fails', async () => {
    const persistence = createMemoryPersistence();
    const stores = await createMemoryStorage({ persistence }).openForWrite(account);
    const failure = new Error('cleanup failed');
    await expect(wipeApplicationGroups(stores, async () => { throw failure; })).rejects.toBe(failure);
    await stores.close();
    const reopened = await createMemoryStorage({ persistence }).openForWrite(account);
    const cleanup = vi.fn(async () => {});
    await resumeApplicationWipe(reopened, cleanup);
    await resumeApplicationWipe(reopened, cleanup);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(account);
    await reopened.close();
  });

});
