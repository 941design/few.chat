import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Bug: invite-accept-not-atomic-across-page-unload.
//
// The shared join core (manual accept + auto-accept) must be idempotent
// against MLS state that already exists locally for the Welcome's group:
//   - MLS state + overlay record  -> already joined: no second join, the
//     existing Group is returned (interrupted after saveGroup).
//   - MLS state, no overlay       -> orphan (interrupted before saveGroup, or
//     leave residue — leave purges only the overlay): groups.destroy(id)
//     (local only) then a normal join.
// The group id is resolved PRE-JOIN (pending entry's groupId, else the
// Welcome's groupContext), never from the rumor's self-claimed pubkey.
//
// The marmot client below models marmot-ts faithfully where it matters:
// joinGroupFromWelcome -> adoptClientState throws "Group <hex> already
// exists" when state for that id is already persisted.
// ---------------------------------------------------------------------------

const {
  mockGetGroupMembers,
  mockGetWelcome,
  mockGetWelcomeKeyPackageRefs,
  mockReadWelcomeMarmotGroupData,
  mockReadWelcomeGroupInfo,
} = vi.hoisted(() => ({
  mockGetGroupMembers: vi.fn(() => [] as string[]),
  mockGetWelcome: vi.fn((rumor: unknown) => rumor),
  mockGetWelcomeKeyPackageRefs: vi.fn(() => [] as Uint8Array[]),
  mockReadWelcomeMarmotGroupData: vi.fn(async (): Promise<{ name: string; description?: string; adminPubkeys?: string[] } | null> => null),
  mockReadWelcomeGroupInfo: vi.fn(async (): Promise<{ groupContext: { groupId: Uint8Array } }> => {
    throw new Error('no group info');
  }),
}));

vi.mock('@internet-privacy/marmot-ts', () => ({
  getGroupMembers: (...args: unknown[]) => mockGetGroupMembers(...(args as [])),
  getWelcome: (...args: unknown[]) => mockGetWelcome(...(args as [unknown])),
  getWelcomeKeyPackageRefs: (...args: unknown[]) => mockGetWelcomeKeyPackageRefs(...(args as [])),
  readWelcomeMarmotGroupData: (...args: unknown[]) => mockReadWelcomeMarmotGroupData(...(args as [])),
  readWelcomeGroupInfo: (...args: unknown[]) => mockReadWelcomeGroupInfo(...(args as [])),
}));

const { loadGroupOverride, loadAllGroupsOverride } = vi.hoisted(() => ({
  loadGroupOverride: { fn: null as null | ((id: string) => Promise<unknown>) },
  loadAllGroupsOverride: { fn: null as null | (() => Promise<unknown>) },
}));
vi.mock('@/src/lib/marmot/groupStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/marmot/groupStorage')>();
  return {
    ...actual,
    loadGroup: (id: string) => (loadGroupOverride.fn ? loadGroupOverride.fn(id) : actual.loadGroup(id)),
    loadAllGroups: () => (loadAllGroupsOverride.fn ? loadAllGroupsOverride.fn() : actual.loadAllGroups()),
  };
});

import {
  acceptPendingInvitation,
  loadGroupsAndReconcileInvitations,
  subscribeToWelcomes,
  dropInvitationsForJoinedGroups,
} from '@/src/lib/marmot/welcomeSubscription';
import {
  enqueuePendingInvitation,
  listPendingInvitations,
  type PendingInvitation,
} from '@/src/lib/pendingInvitations';
import { saveGroup, loadGroup, loadAllGroups, clearAllGroupMeta } from '@/src/lib/marmot/groupStorage';
import {
  saveOutboundJoinRequest,
  clearAllOutboundJoinRequests,
  loadUnexpiredOutboundJoinRequestsForAdmin,
} from '@/src/lib/marmot/outboundJoinRequests';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import type { Group } from '@/src/types';
import { DEFAULT_RELAYS } from '@/src/types';

const GROUP_HEX = 'ab'.repeat(32);
const OTHER_HEX = 'cd'.repeat(32);

/** A marmot client whose MLS state store is the `mls` set (group hex ids). */
function makeClient(mls: Set<string>, joinedId = GROUP_HEX, name = 'Joined Name') {
  const order: string[] = [];
  const client = {
    order,
    groups: {
      has: vi.fn(async (id: string) => {
        order.push(`has:${id}`);
        return mls.has(id);
      }),
      destroy: vi.fn(async (id: string) => {
        order.push(`destroy:${id}`);
        mls.delete(id);
      }),
    },
    joinGroupFromWelcome: vi.fn(async () => {
      order.push('join');
      if (mls.has(joinedId)) throw new Error(`Group ${joinedId} already exists`);
      mls.add(joinedId);
      return {
        group: { idStr: joinedId, groupData: { name }, relays: ['wss://r.example'], state: {} },
      };
    }),
    keyPackages: { get: vi.fn(async () => undefined as unknown) },
    cryptoProvider: { getCiphersuiteImpl: vi.fn(async () => 'cs') },
  };
  return client;
}

function makeEntry(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: 'inv-1',
    inviterPubkeyHex: 'ee'.repeat(32),
    receivedAt: Date.now(),
    welcomeEventJson: JSON.stringify({ kind: 444, pubkey: OTHER_HEX, content: 'w', tags: [] }),
    groupId: GROUP_HEX,
    authenticated: true,
    ...overrides,
  };
}

function overlay(id = GROUP_HEX, name = 'Existing Name'): Group {
  return { id, name, createdAt: 1, memberPubkeys: ['aa'], relays: ['wss://old.example'] };
}

/** Make the pre-join Welcome read resolve groupContext.groupId to `hex`. */
function preJoinResolvesTo(client: ReturnType<typeof makeClient>, hex: string, name = 'Joined Name') {
  mockGetWelcomeKeyPackageRefs.mockReturnValue([new Uint8Array([1])]);
  client.keyPackages.get.mockResolvedValue({ publicPackage: { cipherSuite: 1 }, privatePackage: {} });
  mockReadWelcomeMarmotGroupData.mockResolvedValue({ name, description: '', adminPubkeys: [] });
  mockReadWelcomeGroupInfo.mockResolvedValue({ groupContext: { groupId: hexToBytes(hex) } });
}

let store: Record<string, string> = {};

beforeEach(async () => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  mockGetGroupMembers.mockReset().mockReturnValue(['bb']);
  mockGetWelcome.mockReset().mockImplementation((r: unknown) => r);
  mockGetWelcomeKeyPackageRefs.mockReset().mockReturnValue([]);
  mockReadWelcomeMarmotGroupData.mockReset().mockResolvedValue(null);
  mockReadWelcomeGroupInfo.mockReset().mockRejectedValue(new Error('no group info'));
  loadGroupOverride.fn = null;
  loadAllGroupsOverride.fn = null;
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  await clearAllGroupMeta();
  await clearAllOutboundJoinRequests();
});

// ---------------------------------------------------------------------------
// Manual accept
// ---------------------------------------------------------------------------

describe('acceptPendingInvitation — idempotent shared join core', () => {
  it('fresh join: no local MLS state -> joins, persists the overlay, removes the invitation, fires onGroupJoined', async () => {
    const mls = new Set<string>();
    const client = makeClient(mls);
    enqueuePendingInvitation(makeEntry());
    const onJoined = vi.fn();

    await acceptPendingInvitation('inv-1', client as never, onJoined);

    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
    expect(listPendingInvitations()).toEqual([]);
    expect(onJoined).toHaveBeenCalledTimes(1);
    expect((onJoined.mock.calls[0][0] as Group).id).toBe(GROUP_HEX);
  });

  it('already joined (MLS state + overlay — unload after saveGroup): no second join, no destroy, existing Group returned, invitation removed', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    await saveGroup(overlay());
    enqueuePendingInvitation(makeEntry());
    const onJoined = vi.fn();

    await expect(acceptPendingInvitation('inv-1', client as never, onJoined)).resolves.toBeUndefined();

    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.groups.has).toHaveBeenCalledWith(GROUP_HEX);
    expect(listPendingInvitations()).toEqual([]);
    expect(onJoined).toHaveBeenCalledTimes(1);
    expect(onJoined.mock.calls[0][0]).toEqual(overlay());
    // The existing overlay is left untouched (not rewritten by a re-join).
    expect(await loadGroup(GROUP_HEX)).toEqual(overlay());
    expect(await loadAllGroups()).toHaveLength(1);
  });

  it('orphan (MLS state, no overlay — unload before saveGroup, or leave residue): destroy(id) THEN join; accept succeeds', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    enqueuePendingInvitation(makeEntry());
    const onJoined = vi.fn();

    await expect(acceptPendingInvitation('inv-1', client as never, onJoined)).resolves.toBeUndefined();

    expect(client.groups.destroy).toHaveBeenCalledTimes(1);
    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(client.order.indexOf(`destroy:${GROUP_HEX}`)).toBeLessThan(client.order.indexOf('join'));
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
    expect(listPendingInvitations()).toEqual([]);
    expect(onJoined).toHaveBeenCalledTimes(1);
  });

  it('only the Welcome\'s own group is checked: MLS state for a DIFFERENT group is neither destroyed nor treated as joined', async () => {
    const mls = new Set([OTHER_HEX]);
    const client = makeClient(mls);
    await saveGroup(overlay(OTHER_HEX));
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect(mls.has(OTHER_HEX)).toBe(true);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });

  it('legacy entry (empty groupId): the id is resolved pre-join from the Welcome group context, and an orphan is still recovered', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls);
    preJoinResolvesTo(client, GROUP_HEX);
    enqueuePendingInvitation(makeEntry({ groupId: '' }));

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect(listPendingInvitations()).toEqual([]);
  });

  it('never resolves the group id from the Welcome rumor\'s self-claimed pubkey', async () => {
    // The rumor pubkey (OTHER_HEX) names an orphan MLS group; the pre-join read
    // fails, so the id is unresolvable and that orphan must NOT be touched.
    const mls = new Set([OTHER_HEX]);
    const client = makeClient(mls);
    enqueuePendingInvitation(makeEntry({ groupId: '' }));

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(client.groups.has).not.toHaveBeenCalledWith(OTHER_HEX);
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(mls.has(OTHER_HEX)).toBe(true);
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
  });

  it('last resort kept: any other MLS join failure removes the invitation and throws "no longer valid"', async () => {
    const client = makeClient(new Set());
    client.joinGroupFromWelcome.mockRejectedValueOnce(new Error('key package not found'));
    enqueuePendingInvitation(makeEntry());
    const onJoined = vi.fn();

    await expect(acceptPendingInvitation('inv-1', client as never, onJoined)).rejects.toThrow(
      'This invitation is no longer valid',
    );
    expect(listPendingInvitations()).toEqual([]);
    expect(onJoined).not.toHaveBeenCalled();
    expect(await loadGroup(GROUP_HEX)).toBeUndefined();
  });

  it('a failing orphan destroy falls into the last-resort catch (no join attempted on top of foreign state)', async () => {
    const client = makeClient(new Set([GROUP_HEX]));
    client.groups.destroy.mockRejectedValueOnce(new Error('idb blocked'));
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).rejects.toThrow(
      'This invitation is no longer valid',
    );
    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
  });
});

describe('acceptPendingInvitation — accept contract around the core', () => {
  it('joins with exactly the stored Welcome of the chosen entry; other entries stay queued', async () => {
    const client = makeClient(new Set());
    const otherRumor = { kind: 444, pubkey: OTHER_HEX, content: 'first', tags: [] };
    const chosenRumor = { kind: 444, pubkey: OTHER_HEX, content: 'second', tags: [] };
    enqueuePendingInvitation(makeEntry({ id: 'inv-a', groupId: OTHER_HEX, welcomeEventJson: JSON.stringify(otherRumor) }));
    enqueuePendingInvitation(makeEntry({ id: 'inv-b', welcomeEventJson: JSON.stringify(chosenRumor) }));

    await acceptPendingInvitation('inv-b', client as never, vi.fn());

    expect(client.joinGroupFromWelcome).toHaveBeenCalledWith({ welcomeRumor: chosenRumor });
    expect(client.groups.has).toHaveBeenCalledWith(GROUP_HEX);
    expect(client.groups.has).not.toHaveBeenCalledWith(OTHER_HEX);
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['inv-a']);
  });

  it('unknown id (double click / already handled) is a silent no-op', async () => {
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry());
    const onJoined = vi.fn();

    await expect(acceptPendingInvitation('nope', client as never, onJoined)).resolves.toBeUndefined();

    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(client.groups.has).not.toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
    expect(listPendingInvitations()).toHaveLength(1);
  });

  it('a malformed stored Welcome is dropped with "no longer valid" and nothing is joined', async () => {
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry({ welcomeEventJson: '{not json' }));
    const onJoined = vi.fn();

    await expect(acceptPendingInvitation('inv-1', client as never, onJoined)).rejects.toThrow(
      'This invitation is no longer valid',
    );
    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
    expect(listPendingInvitations()).toEqual([]);
  });

  it('falls back to "Unnamed Group" and the default relays when the joined group carries neither', async () => {
    const client = makeClient(new Set());
    client.joinGroupFromWelcome.mockResolvedValueOnce({
      group: { idStr: GROUP_HEX, groupData: undefined, relays: undefined, state: {} },
    } as never);
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    const saved = await loadGroup(GROUP_HEX);
    expect(saved?.name).toBe('Unnamed Group');
    expect(saved?.relays).toEqual([...DEFAULT_RELAYS]);
    expect(saved?.memberPubkeys).toEqual(['bb']);
  });

  it('awaits an async onGroupJoined before resolving, and a failing callback does not fail the accept', async () => {
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry());
    let callbackDone = false;
    const onJoined = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      callbackDone = true;
    });

    await acceptPendingInvitation('inv-1', client as never, onJoined);
    expect(callbackDone).toBe(true);

    const client2 = makeClient(new Set(), OTHER_HEX);
    enqueuePendingInvitation(makeEntry({ id: 'inv-2', groupId: OTHER_HEX }));
    await expect(
      acceptPendingInvitation('inv-2', client2 as never, vi.fn(async () => { throw new Error('reload failed'); })),
    ).resolves.toBeUndefined();
    expect(listPendingInvitations()).toEqual([]);
    expect((await loadGroup(OTHER_HEX))?.id).toBe(OTHER_HEX);
  });
});

// ---------------------------------------------------------------------------
// Auto-accept shares the core
// ---------------------------------------------------------------------------

function keypair() {
  const priv = generateSecretKey();
  return { priv, privHex: bytesToHex(priv), pubHex: getPublicKey(priv) };
}

async function fireAutoAccept(client: ReturnType<typeof makeClient>, groupName: string) {
  const admin = keypair();
  const invitee = keypair();
  await saveOutboundJoinRequest({ nonce: 'n-1', adminPubkeyHex: admin.pubHex, groupName, sentAt: Date.now() });
  const rumor = createRumor({ kind: 444, content: 'welcome', tags: [] }, admin.priv);
  const wrap = createWrap(createSeal(rumor, admin.priv, invitee.pubHex), invitee.pubHex);

  let handler: ((e: unknown) => Promise<void>) | null = null;
  const ndk = {
    subscribe: vi.fn(() => ({
      on: (ev: string, h: (e: unknown) => Promise<void>) => { if (ev === 'event') handler = h; },
      stop: vi.fn(),
    })),
  };
  const onJoined = vi.fn();
  const unsub = await subscribeToWelcomes(
    invitee.pubHex, client as never, ndk as never, createPrivateKeySigner(invitee.privHex), onJoined,
  );
  await handler!({ id: 'gw-1', pubkey: wrap.pubkey, content: wrap.content });
  unsub();
  return { onJoined, admin };
}

describe('auto-accept — same idempotent core', () => {
  it('orphan MLS state for the Welcome\'s group: destroy then join, outbound record consumed', async () => {
    const mls = new Set([GROUP_HEX]);
    const client = makeClient(mls, GROUP_HEX, 'Auto Group');
    preJoinResolvesTo(client, GROUP_HEX, 'Auto Group');

    const { onJoined, admin } = await fireAutoAccept(client, 'Auto Group');

    expect(client.groups.destroy).toHaveBeenCalledWith(GROUP_HEX);
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect(onJoined).toHaveBeenCalledTimes(1);
    expect(await loadUnexpiredOutboundJoinRequestsForAdmin(admin.pubHex)).toEqual([]);
    expect(listPendingInvitations()).toEqual([]);
  });

  it('already joined: no second join, existing Group handed to onGroupJoined', async () => {
    const client = makeClient(new Set([GROUP_HEX]), GROUP_HEX, 'Auto Group');
    preJoinResolvesTo(client, GROUP_HEX, 'Auto Group');
    await saveGroup(overlay(GROUP_HEX, 'Auto Group'));

    const { onJoined } = await fireAutoAccept(client, 'Auto Group');

    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(onJoined).toHaveBeenCalledWith(overlay(GROUP_HEX, 'Auto Group'));
    expect(listPendingInvitations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

describe('startup reconciliation', () => {
  it('drops only invitations whose non-empty groupId has an overlay record AND local MLS state; legacy empty-groupId and not-yet-joined entries stay', async () => {
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'joined', groupId: GROUP_HEX }));
    enqueuePendingInvitation(makeEntry({ id: 'other', groupId: OTHER_HEX }));
    enqueuePendingInvitation(makeEntry({ id: 'legacy', groupId: '' }));
    const client = makeClient(new Set([GROUP_HEX, OTHER_HEX]));

    const dropped = await dropInvitationsForJoinedGroups(client as never);

    expect(dropped).toBe(1);
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['other', 'legacy']);
  });

  it('keeps the invitation for an overlay-only group (no MLS state, e.g. an interrupted backup restore) — it is the way back in', async () => {
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'rejoin', groupId: GROUP_HEX }));
    const client = makeClient(new Set());

    expect(await dropInvitationsForJoinedGroups(client as never)).toBe(0);
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['rejoin']);
  });

  it('keeps the invitation when the MLS-state check fails (fail-safe)', async () => {
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'keep', groupId: GROUP_HEX }));
    const client = makeClient(new Set([GROUP_HEX]));
    client.groups.has.mockRejectedValue(new Error('idb'));

    expect(await dropInvitationsForJoinedGroups(client as never)).toBe(0);
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['keep']);
  });

  it('is a no-op without overlay records (and with an overlay whose id is empty-string, legacy entries are still kept)', async () => {
    await saveGroup(overlay(''));
    enqueuePendingInvitation(makeEntry({ id: 'legacy', groupId: '' }));
    enqueuePendingInvitation(makeEntry({ id: 'other', groupId: OTHER_HEX }));
    const client = makeClient(new Set(['', OTHER_HEX]));

    expect(await dropInvitationsForJoinedGroups(client as never)).toBe(0);
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['legacy', 'other']);
  });

  it('loadGroupsAndReconcileInvitations: loads the MLS groups, then reconciles', async () => {
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'joined', groupId: GROUP_HEX }));
    const client = Object.assign(makeClient(new Set([GROUP_HEX])), {});
    const loadAll = vi.fn(async () => []);
    (client.groups as Record<string, unknown>).loadAll = loadAll;

    await loadGroupsAndReconcileInvitations(client as never);

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(listPendingInvitations()).toEqual([]);
  });

  it('loadGroupsAndReconcileInvitations: skips reconciliation entirely when groups.loadAll() fails, and does not throw', async () => {
    await saveGroup(overlay(GROUP_HEX));
    enqueuePendingInvitation(makeEntry({ id: 'joined', groupId: GROUP_HEX }));
    const client = makeClient(new Set([GROUP_HEX]));
    (client.groups as Record<string, unknown>).loadAll = vi.fn(async () => { throw new Error('corrupt state'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadGroupsAndReconcileInvitations(client as never)).resolves.toBeUndefined();

    expect(client.groups.has).not.toHaveBeenCalled();
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['joined']);
    warn.mockRestore();
  });

  it('loadGroupsAndReconcileInvitations: a reconciliation failure is swallowed (startup continues), invitations kept', async () => {
    // The overlay read rejecting makes dropInvitationsForJoinedGroups itself
    // reject (a throwing localStorage would not: pendingInvitations swallows it).
    enqueuePendingInvitation(makeEntry({ id: 'x', groupId: GROUP_HEX }));
    const client = makeClient(new Set([GROUP_HEX]));
    const loadAll = vi.fn(async () => []);
    (client.groups as Record<string, unknown>).loadAll = loadAll;
    loadAllGroupsOverride.fn = async () => { throw new Error('idb read failed'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadGroupsAndReconcileInvitations(client as never)).resolves.toBeUndefined();

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(listPendingInvitations().map((i) => i.id)).toEqual(['x']);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: per-group serialization (remediation R1)
// ---------------------------------------------------------------------------

/** A client whose join persists MLS state, then pauses until `release()`. */
function makePausingClient(mls: Set<string>) {
  const client = makeClient(mls);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let joinedSignal!: () => void;
  const joinStarted = new Promise<void>((r) => { joinedSignal = r; });
  client.joinGroupFromWelcome.mockImplementation(async () => {
    client.order.push('join');
    if (mls.has(GROUP_HEX)) throw new Error(`Group ${GROUP_HEX} already exists`);
    mls.add(GROUP_HEX); // MLS state saved ...
    joinedSignal();
    await gate; // ... page still between MLS save and saveGroup
    return { group: { idStr: GROUP_HEX, groupData: { name: 'Joined Name' }, relays: ['wss://r.example'], state: {} } };
  });
  return { client, release, joinStarted };
}

describe('concurrent accepts of the same group are serialized', () => {
  it('a second accept arriving between MLS save and saveGroup does not destroy the live join: one join, no destroy, both resolve to the same Group', async () => {
    const mls = new Set<string>();
    const { client, release, joinStarted } = makePausingClient(mls);
    enqueuePendingInvitation(makeEntry({ id: 'tab-1' }));
    enqueuePendingInvitation(makeEntry({ id: 'tab-2' }));
    const onJoined1 = vi.fn();
    const onJoined2 = vi.fn();

    const first = acceptPendingInvitation('tab-1', client as never, onJoined1);
    await joinStarted;
    const second = acceptPendingInvitation('tab-2', client as never, onJoined2);
    // Give the second accept every chance to run ahead while the first is paused.
    await new Promise((r) => setTimeout(r, 20));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    const g1 = onJoined1.mock.calls[0][0] as Group;
    const g2 = onJoined2.mock.calls[0][0] as Group;
    expect(g2).toEqual(g1);
    expect(listPendingInvitations()).toEqual([]);
    expect(await loadAllGroups()).toHaveLength(1);
  });

  it('a failed first accept does not wedge the group: the next accept still runs', async () => {
    const client = makeClient(new Set());
    client.joinGroupFromWelcome.mockRejectedValueOnce(new Error('transient'));
    enqueuePendingInvitation(makeEntry({ id: 'a' }));
    enqueuePendingInvitation(makeEntry({ id: 'b' }));

    const first = acceptPendingInvitation('a', client as never, vi.fn());
    const second = acceptPendingInvitation('b', client as never, vi.fn());
    await expect(first).rejects.toThrow('This invitation is no longer valid');
    await expect(second).resolves.toBeUndefined();
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });

  it('accepts for DIFFERENT groups are not serialized against each other', async () => {
    const mls = new Set<string>();
    const { client, release, joinStarted } = makePausingClient(mls);
    const otherClient = makeClient(mls, OTHER_HEX, 'Other');
    client.joinGroupFromWelcome.mockName('paused');
    enqueuePendingInvitation(makeEntry({ id: 'g1' }));
    enqueuePendingInvitation(makeEntry({ id: 'g2', groupId: OTHER_HEX }));

    const first = acceptPendingInvitation('g1', client as never, vi.fn());
    await joinStarted;
    // While group 1 is paused mid-join, group 2's accept completes.
    await expect(acceptPendingInvitation('g2', otherClient as never, vi.fn())).resolves.toBeUndefined();
    expect((await loadGroup(OTHER_HEX))?.name).toBe('Other');
    release();
    await first;
  });

  it('serialization survives a failed accept: a third accept arriving while the second is mid-join still waits for it (no destroy of the live join)', async () => {
    // A fails; B (queued behind A) then joins and pauses between MLS save and
    // saveGroup; C arrives only now. C must still be queued behind B — if A's
    // settling had dropped B from the group's chain, C would see "MLS state,
    // no overlay" and destroy B's live join.
    const mls = new Set<string>();
    const client = makeClient(mls);
    let failA!: () => void;
    const gateA = new Promise<void>((r) => { failA = r; });
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => { releaseB = r; });
    let bStarted!: () => void;
    const bJoinStarted = new Promise<void>((r) => { bStarted = r; });
    let call = 0;
    client.joinGroupFromWelcome.mockImplementation(async () => {
      call += 1;
      client.order.push('join');
      if (call === 1) {
        await gateA;
        throw new Error('transient');
      }
      if (mls.has(GROUP_HEX)) throw new Error(`Group ${GROUP_HEX} already exists`);
      mls.add(GROUP_HEX);
      bStarted();
      await gateB;
      return { group: { idStr: GROUP_HEX, groupData: { name: 'Joined Name' }, relays: ['wss://r.example'], state: {} } };
    });
    enqueuePendingInvitation(makeEntry({ id: 'a' }));
    enqueuePendingInvitation(makeEntry({ id: 'b' }));
    enqueuePendingInvitation(makeEntry({ id: 'c' }));

    const first = acceptPendingInvitation('a', client as never, vi.fn());
    const second = acceptPendingInvitation('b', client as never, vi.fn());
    failA();
    await expect(first).rejects.toThrow('This invitation is no longer valid');
    await bJoinStarted;
    const onJoinedC = vi.fn();
    const third = acceptPendingInvitation('c', client as never, onJoinedC);
    await new Promise((r) => setTimeout(r, 20));
    releaseB();
    await expect(Promise.all([second, third])).resolves.toEqual([undefined, undefined]);

    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(2);
    expect((onJoinedC.mock.calls[0][0] as Group).name).toBe('Joined Name');
    expect(await loadAllGroups()).toHaveLength(1);
  });

  it('falls back to in-tab serialization when navigator.locks lacks a request() function', async () => {
    vi.stubGlobal('navigator', { locks: {} });
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).resolves.toBeUndefined();

    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });

  it('without any navigator (SSR / older runtimes) the in-tab fallback still joins', async () => {
    vi.stubGlobal('navigator', undefined);
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).resolves.toBeUndefined();

    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
    expect((await loadGroup(GROUP_HEX))?.name).toBe('Joined Name');
  });

  it('uses a Web Lock named few-join-<groupId> when navigator.locks is available (cross-tab safety)', async () => {
    const request = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { locks: { request } });
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry());

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(`few-join-${GROUP_HEX}`);
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
  });

  it('an unresolvable group id takes no lock (nothing to key it by) and joins directly', async () => {
    const request = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { locks: { request } });
    const client = makeClient(new Set());
    enqueuePendingInvitation(makeEntry({ groupId: '' }));

    await acceptPendingInvitation('inv-1', client as never, vi.fn());

    expect(request).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).toHaveBeenCalledTimes(1);
  });
});

describe('check failures never lead to a destroy', () => {
  it('groups.has rejecting -> no destroy, no join, last-resort error', async () => {
    const client = makeClient(new Set([GROUP_HEX]));
    client.groups.has.mockRejectedValue(new Error('idb'));
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).rejects.toThrow(
      'This invitation is no longer valid',
    );
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
  });

  it('loadGroup (overlay read) rejecting -> no destroy, no join, last-resort error', async () => {
    const client = makeClient(new Set([GROUP_HEX]));
    loadGroupOverride.fn = async () => { throw new Error('idb read failed'); };
    enqueuePendingInvitation(makeEntry());

    await expect(acceptPendingInvitation('inv-1', client as never, vi.fn())).rejects.toThrow(
      'This invitation is no longer valid',
    );
    expect(client.groups.destroy).not.toHaveBeenCalled();
    expect(client.joinGroupFromWelcome).not.toHaveBeenCalled();
    expect(mlsHas(client, GROUP_HEX)).toBe(true);
  });
});

function mlsHas(client: ReturnType<typeof makeClient>, id: string) {
  return client.groups.has.mock.calls.some((c) => c[0] === id);
}
