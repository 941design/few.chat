import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createGroupProfileActions } from '@/src/lib/marmot/groupSessionProfile';
import { loadProfileRequestMemo } from '@/src/lib/marmot/profileRequestStorage';

describe('group profile session', () => {
  it('fences startup profile recovery when the account loses its lease during signing', async () => {
    let started!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const signing = new Promise<void>((resolve) => { release = resolve; });
    let writable = true;
    const pubkey = 'ab'.repeat(32);
    const send = vi.fn();
    const actions = createGroupProfileActions({
      pubkey,
      signer: { signEvent: async (draft: object) => {
        started();
        await signing;
        return { ...draft, id: 'id', pubkey, sig: 'sig' };
      } } as never,
      sender: { sendGroupRumor: send } as never,
      groupOf: async () => ({ id: 'pending-startup-profile' }) as never,
      profile: () => ({ nickname: 'Name', avatar: null }) as never,
      writable: () => writable,
    });
    const recovery = actions.recoverMissingOwnProfiles(['pending-startup-profile']);
    await begun;
    writable = false;
    release();
    await recovery;
    expect(send).not.toHaveBeenCalled();
    await actions.dispose();
  });

  it('fences a startup request that reaches memo storage after disposal', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const peer = 'cd'.repeat(32);
    const actions = createGroupProfileActions({
      pubkey: 'ab'.repeat(32), signer: {} as never,
      sender: { sendGroupRumor: vi.fn() } as never,
      groupOf: async () => { started(); await pending; return { members: () => [peer] } as never; },
      profile: () => ({} as never), writable: () => true,
    });
    const request = actions.requestProfiles(['profile-fence']);
    await begun;
    await actions.dispose();
    release();
    await expect(request).rejects.toThrow('not writable');
    expect(await loadProfileRequestMemo('profile-fence', peer)).toBeNull();
  });
  it('reports interactive profile sends only after the send succeeds', async () => {
    const hook = vi.fn();
    vi.stubGlobal('window', { __fewTest: { onRumorSent: hook } });
    const send = vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValueOnce({});
    const actions = createGroupProfileActions({
      pubkey: 'ab'.repeat(32),
      signer: { signEvent: async (draft: object) => ({ ...draft, id: 'id', pubkey: 'pk', sig: 'sig' }) } as never,
      sender: { sendGroupRumor: send } as never,
      groupOf: async () => ({} as never), profile: () => ({} as never), writable: () => true,
    });
    const profile = { nickname: 'Name', avatar: null } as never;
    try {
      expect(await actions.publishProfile(profile, ['g'], vi.fn())).toBe(false);
      expect(hook).not.toHaveBeenCalled();
      expect(await actions.publishProfile(profile, ['g'], vi.fn())).toBe(true);
      expect(hook).toHaveBeenCalledExactlyOnceWith(0);
    } finally { vi.unstubAllGlobals(); }
  });

});
