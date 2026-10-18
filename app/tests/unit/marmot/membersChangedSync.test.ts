/**
 * syncOnMembersChanged — the body MarmotContext runs after every processed group
 * event (bug replace-does-not-await-onmemberschanged): it never commits once the
 * group's subscription is no longer current, and it resolves only after its
 * auto-commit settled, so a replace that tracks it waits for the commit too.
 */
import { describe, it, expect, vi } from 'vitest';
import { syncOnMembersChanged, type MembersChangedDeps } from '@/src/lib/marmot/membersChangedSync';

type G = { id: string; name: string; memberPubkeys: string[] };

function deps(over: Partial<MembersChangedDeps<G>> = {}): MembersChangedDeps<G> {
  return {
    isCurrent: () => true,
    bumpVersion: vi.fn(),
    stored: () => ({ id: 'g', name: 'Old', memberPubkeys: ['a'] }),
    mlsName: () => 'Old',
    persist: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    mayCommit: () => true,
    hasUnappliedProposals: () => false,
    commit: vi.fn(async () => {}),
    ...over,
  };
}

describe('syncOnMembersChanged', () => {
  it('not current at the start => does nothing', async () => {
    const d = deps({ isCurrent: () => false, hasUnappliedProposals: () => true });
    await syncOnMembersChanged(['a', 'b'], d);
    expect(d.bumpVersion).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('a member change persists the new members, then reloads', async () => {
    const order: string[] = [];
    const d = deps({
      persist: vi.fn(async () => { order.push('persist'); }),
      reload: vi.fn(async () => { order.push('reload'); }),
    });
    await syncOnMembersChanged(['a', 'b'], d);
    expect(d.bumpVersion).toHaveBeenCalledTimes(1);
    expect(d.persist).toHaveBeenCalledWith({ id: 'g', name: 'Old', memberPubkeys: ['a', 'b'] });
    expect(order).toEqual(['persist', 'reload']);
  });

  it('a rename alone persists the name and keeps the members', async () => {
    const d = deps({ mlsName: () => 'New' });
    await syncOnMembersChanged(['a'], d);
    expect(d.persist).toHaveBeenCalledWith({ id: 'g', name: 'New', memberPubkeys: ['a'] });
  });

  it('an empty or missing MLS name is not a rename', async () => {
    for (const name of ['', undefined]) {
      const d = deps({ mlsName: () => name });
      await syncOnMembersChanged(['a'], d);
      expect(d.persist).not.toHaveBeenCalled();
    }
  });

  it('nothing changed or no stored group => no persist, still bumps the version', async () => {
    const same = deps();
    await syncOnMembersChanged(['a'], same);
    expect(same.persist).not.toHaveBeenCalled();
    expect(same.bumpVersion).toHaveBeenCalledTimes(1);
    const none = deps({ stored: () => undefined });
    await syncOnMembersChanged(['a', 'b'], none);
    expect(none.persist).not.toHaveBeenCalled();
  });

  it('unapplied proposals while current => commits', async () => {
    const d = deps({ hasUnappliedProposals: () => true });
    await syncOnMembersChanged(['a'], d);
    expect(d.commit).toHaveBeenCalledTimes(1);
  });

  it('no unapplied proposals => no commit', async () => {
    const d = deps();
    await syncOnMembersChanged(['a'], d);
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('the group is being replaced once persist/reload finished => no commit on the old group', async () => {
    let replacing = false;
    const d = deps({
      mayCommit: () => !replacing,
      hasUnappliedProposals: () => true,
      reload: vi.fn(async () => { replacing = true; }),
    });
    await syncOnMembersChanged(['a', 'b'], d);
    expect(d.persist).toHaveBeenCalledTimes(1);
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('only the subscription restarted meanwhile (not a replace) => still commits', async () => {
    let current = true;
    const d = deps({
      isCurrent: () => current,
      hasUnappliedProposals: () => true,
      reload: vi.fn(async () => { current = false; }),
    });
    await syncOnMembersChanged(['a', 'b'], d);
    expect(d.commit).toHaveBeenCalledTimes(1);
  });

  it('may not commit, nothing to persist => no commit', async () => {
    const d = deps({ mayCommit: () => false, hasUnappliedProposals: () => true });
    await syncOnMembersChanged(['a'], d);
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('resolves only after the auto-commit settled', async () => {
    let finishCommit!: () => void;
    const d = deps({
      hasUnappliedProposals: () => true,
      commit: vi.fn(() => new Promise<void>((r) => { finishCommit = r; })),
    });
    let done = false;
    const run = syncOnMembersChanged(['a'], d).then(() => { done = true; });
    await vi.waitFor(() => expect(d.commit).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    finishCommit();
    await run;
    expect(done).toBe(true);
  });

  it('a failed auto-commit is swallowed (logged), as before', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const d = deps({ hasUnappliedProposals: () => true, commit: vi.fn(async () => { throw new Error('not admin'); }) });
    await expect(syncOnMembersChanged(['a'], d)).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith('[Marmot] auto-commit unapplied proposals failed:', expect.any(Error));
    debug.mockRestore();
  });

  it('a failed persist rejects and skips the commit', async () => {
    const d = deps({ hasUnappliedProposals: () => true, persist: vi.fn(async () => { throw new Error('idb'); }) });
    await expect(syncOnMembersChanged(['a', 'b'], d)).rejects.toThrow('idb');
    expect(d.commit).not.toHaveBeenCalled();
  });
});
