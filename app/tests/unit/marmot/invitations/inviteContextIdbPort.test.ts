// @vitest-environment node
/** The production port: one whole-snapshot record per account over idb-keyval get/set (fake-indexeddb). */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CONTEXT_TTL_MS, createInviteContextStore } from '@/src/lib/marmot/invitations';
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

  it('reopens a legacy snapshot and durably retires replaced and discarded IDs without their contents', async () => {
    const account = hex(3);
    const port = createIdbInviteContextPort(account);
    const older = { rumorId: 'old', sender: hex(9), groupId: 'aa', name: 'Old name' };
    const newer = { ...older, rumorId: 'new', name: 'New name' };
    let now = 42;
    await port.save([{ ...older, receivedAt: now, seq: 1, matched: false }]);
    const open = () => createInviteContextStore({ port: createIdbInviteContextPort(account), now: () => now, getPending: () => [] });
    expect(await open().add(newer)).toBe('replaced');

    const reopened = open();
    expect(await reopened.add(older)).toBe('duplicate');
    expect(reopened.snapshot().map((r) => r.name)).toEqual(['New name']);
    await reopened.discard({ groupId: newer.groupId });
    expect(await port.load()).toEqual({
      records: [],
      tombstones: [{ rumorId: 'old', removedAt: now }, { rumorId: 'new', removedAt: now }],
    });
    now += CONTEXT_TTL_MS;
    expect(await open().add(newer)).toBe('duplicate');
    now += 1;
    const afterExpiry = open();
    await afterExpiry.load();
    expect(await port.load()).toEqual([]);
    expect(await afterExpiry.add(newer)).toBe('stored');
  });
});
