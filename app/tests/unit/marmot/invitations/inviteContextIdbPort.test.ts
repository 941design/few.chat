// @vitest-environment node
/** The production port: one whole-snapshot record per account over idb-keyval get/set (fake-indexeddb). */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createInviteContextStore } from '@/src/lib/marmot/invitations';
import { createIdbInviteContextPort } from '@/src/lib/marmot/inviteContextIdbPort';
import { hex } from './inviteContext.fixtures';

describe('createIdbInviteContextPort', () => {
  it('round-trips a store snapshot and keeps accounts apart', async () => {
    const mk = (acct: string) => createInviteContextStore({ port: createIdbInviteContextPort(acct), now: () => 42, getPending: () => [] });
    const a = mk(hex(1));
    await a.add({ rumorId: 'r1', sender: hex(9), groupId: 'aa', name: 'alpha' });
    const reopened = mk(hex(1));
    await reopened.load();
    expect(reopened.snapshot().map((r) => r.name)).toEqual(['alpha']);
    const other = mk(hex(2));
    await other.load();
    expect(other.snapshot()).toEqual([]);
  });
  it('requires an account pubkey', () => {
    expect(() => createIdbInviteContextPort('')).toThrow(/accountPubkey/);
  });
});
