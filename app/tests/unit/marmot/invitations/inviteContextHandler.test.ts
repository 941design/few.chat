/**
 * AC-CTX-4 (unit): the inbox handler dedupes by rumor id and persists-and-returns without any account-scope
 * client call; AC-BLK-1 invite-context leg: a blocked sender's rumor is dropped before anything is stored.
 * Plus the hostile-input matrix (VQ security): malformed, wrong kind, forged sender shapes.
 */
import { describe, expect, it } from 'vitest';
import { createDenyLayer, createInviteContextHandler, createInviteContextStore, type InviteContextStore } from '@/src/lib/marmot/invitations';
import { hex, inv, memoryPort, rumor } from './inviteContext.fixtures';

const wrap = {} as never;

function setup(blocked: string[] = [], pending: () => ReturnType<typeof inv>[] = () => []) {
  const mem = memoryPort();
  const store = createInviteContextStore({ port: mem.port, now: () => 1_000, getPending: pending });
  const errors: unknown[] = [];
  const handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set(blocked) }), onError: (e) => void errors.push(e) });
  return { store, handler, errors, mem };
}

describe('AC-CTX-4: dedupe by rumor id', () => {
  it('redelivery of the same rumor stores one entry', async () => {
    const s = setup();
    const r = rumor({ id: 'same', pubkey: hex(1), groupId: 'ab', name: 'Club' });
    await s.handler(r, wrap);
    await s.handler(r, wrap);
    await s.handler({ ...r }, wrap);
    expect(s.store.snapshot().map((x) => [x.rumorId, x.name, x.sender, x.groupId])).toEqual([['same', 'Club', hex(1), 'ab']]);
    expect(s.mem.saves).toHaveLength(1); // the duplicates did not even write
  });
});

describe('AC-CTX-4: persist-and-return, no account-scope client call', () => {
  it('the handler is built from the store and the deny layer only: it has no client handle to call, and resolves after the store write', async () => {
    const calls: string[] = [];
    const store: Pick<InviteContextStore, 'add'> = { add: async (i) => { calls.push(`add:${i.groupId}`); return 'stored'; } };
    const handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }) });
    await handler(rumor({ pubkey: hex(1), groupId: 'ab' }), wrap);
    expect(calls).toEqual(['add:ab']);
  });
  it('a store failure is reported, never thrown into the library frame', async () => {
    const errors: unknown[] = [];
    const handler = createInviteContextHandler({
      store: { add: async () => { throw new Error('idb down'); } },
      denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }),
      onError: (e) => void errors.push(e),
    });
    await expect(handler(rumor({ pubkey: hex(1) }), wrap)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
  it('source scan: the handler module imports no client, context or React code and awaits no client call', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../../src/lib/marmot/invitations/inviteContextHandler.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/from ['"]([^'"]*\/client(\/[^'"]*)?|@\/src\/context[^'"]*|react)['"]/);
    expect(code).not.toMatch(/\bclient\./);
  });
});

describe('AC-BLK-1 (invite-context leg): a blocked sender is dropped before anything is stored', () => {
  it('nothing is stored or persisted for a blocked sender; a non-blocked one in the same run is stored', async () => {
    const s = setup([hex(1)]);
    await s.handler(rumor({ id: 'b', pubkey: hex(1).toUpperCase() }), wrap); // case-insensitive
    expect(s.store.snapshot()).toEqual([]);
    expect(s.mem.saves).toEqual([]);
    await s.handler(rumor({ id: 'ok', pubkey: hex(2) }), wrap);
    expect(s.store.snapshot().map((r) => r.rumorId)).toEqual(['ok']);
  });
  it('the block set is read on every arrival: a block placed after construction applies to the next rumor', async () => {
    const blocked = new Set<string>();
    const mem = memoryPort();
    const store = createInviteContextStore({ port: mem.port, now: () => 1, getPending: () => [] });
    const handler = createInviteContextHandler({ store, denyLayer: createDenyLayer({ loadBlockedPeers: () => blocked }) });
    await handler(rumor({ id: 'one', pubkey: hex(1) }), wrap);
    blocked.add(hex(1));
    await handler(rumor({ id: 'two', pubkey: hex(1), groupId: 'cd' }), wrap);
    expect(store.snapshot().map((r) => r.rumorId)).toEqual(['one']);
  });
});

describe('hostile input', () => {
  it.each([
    ['wrong kind', rumor({ kind: 21059 })],
    ['not json', rumor({ content: 'oops' })],
    ['no name', rumor({ content: JSON.stringify({ groupId: 'ab' }) })],
    ['forged sender shape (not 64 hex)', rumor({ pubkey: 'not-a-key' })],
    ['empty sender', rumor({ pubkey: '' })],
    ['empty rumor id', rumor({ id: '' })],
  ])('%s: dropped, nothing stored', async (_l, r) => {
    const s = setup();
    await s.handler(r, wrap);
    expect(s.store.snapshot()).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('a sender that is not the invitation\'s sponsor cannot attach a name to a pending invitation of that group', async () => {
    const s = setup([], () => [inv('1', 1, 'ab')]);
    await s.handler(rumor({ id: 'evil', pubkey: hex(7), groupId: 'ab', name: 'phish' }), wrap);
    expect(s.store.snapshot()).toEqual([]);
  });

  it('the sender comes from rumor.pubkey, never from a field of the content', async () => {
    const s = setup();
    await s.handler(rumor({ id: 'x', pubkey: hex(3), content: JSON.stringify({ groupId: 'ab', name: 'n', pubkey: hex(1), sender: hex(1) }) }), wrap);
    expect(s.store.snapshot().map((r) => r.sender)).toEqual([hex(3)]);
  });

  it('ports are validated at construction', () => {
    const deny = createDenyLayer({ loadBlockedPeers: () => new Set() });
    expect(() => createInviteContextHandler({ denyLayer: deny } as never)).toThrow(/store\.add/);
    expect(() => createInviteContextHandler({ store: { add: async () => 'stored' } } as never)).toThrow(/isBlocked/);
    expect(() => createInviteContextHandler(undefined as never)).toThrow(TypeError);
  });
});
