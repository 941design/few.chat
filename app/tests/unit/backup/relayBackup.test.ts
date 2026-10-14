import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { STORAGE_KEYS } from '@/src/types';

// ---------------------------------------------------------------------------
// Mock NDK and ndkClient before other imports
// ---------------------------------------------------------------------------

const mockFetchEventsWithTimeout = vi.fn();

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKEvent: class {
    ndk: unknown;
    kind?: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
    pubkey?: string;
    id?: string;
    sig?: string;
    constructor(ndk: unknown) { this.ndk = ndk; }
    publish = vi.fn().mockResolvedValue(undefined);
  },
  NDKRelaySet: {
    fromRelayUrls: vi.fn((_relays: string[], _ndk: unknown) => 'mock-relay-set'),
  },
}));

const mockConnectNdk = vi.fn();

vi.mock('@/src/lib/ndkClient', () => ({
  fetchEventsWithTimeout: (...args: unknown[]) => mockFetchEventsWithTimeout(...args),
  connectNdk: (...args: unknown[]) => mockConnectNdk(...args),
}));

vi.mock('@/src/lib/marmot/signerAdapter', () => ({
  createPrivateKeySigner: () => ({
    nip44: {
      decrypt: async (_pk: string, ciphertext: string) => ciphertext.replace('encrypted:', ''),
    },
  }),
}));

// ---------------------------------------------------------------------------
// Mock idb-keyval (same pattern as marmotAdapter.test.ts)
// ---------------------------------------------------------------------------

const stores: Record<string, Record<string, unknown>> = {};

function getOrCreateStore(name: string): Record<string, unknown> {
  if (!stores[name]) stores[name] = {};
  return stores[name];
}

vi.mock('idb-keyval', () => ({
  createStore: (dbName: string, storeName: string) => `${dbName}:${storeName}`,
  get: vi.fn(async (key: string, store?: string) => {
    // When called without a store (default store), use 'default'
    const s = store ?? 'default';
    return getOrCreateStore(s)[key] ?? undefined;
  }),
  set: vi.fn(async (key: string, value: unknown, store?: string) => {
    const s = store ?? 'default';
    getOrCreateStore(s)[key] = value;
  }),
  del: vi.fn(async (key: string, store?: string) => {
    const s = store ?? 'default';
    delete getOrCreateStore(s)[key];
  }),
  keys: vi.fn(async (store?: string) => {
    const s = store ?? 'default';
    return Object.keys(getOrCreateStore(s));
  }),
  clear: vi.fn(async (store?: string) => {
    const s = store ?? 'default';
    const obj = getOrCreateStore(s);
    Object.keys(obj).forEach((k) => delete obj[k]);
  }),
  entries: vi.fn(async (store?: string) => {
    const s = store ?? 'default';
    return Object.entries(getOrCreateStore(s));
  }),
}));

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const localStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStore[key] = value;
  },
  removeItem: (key: string) => {
    delete localStore[key];
  },
  clear: () => {
    Object.keys(localStore).forEach((k) => delete localStore[k]);
  },
  get length() {
    return Object.keys(localStore).length;
  },
  key: (i: number) => Object.keys(localStore)[i] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import {
  collectBackupPayload,
  uint8ArrayToBase64,
  base64ToUint8Array,
  createBackupEvent,
  publishBackup,
  fetchBackup,
  getBackupRelays,
  restoreFromBackup,
  BackupScheduler,
  parseBackupPayload,
  markRestorePending,
  clearRestorePending,
  isRestorePending,
  settleRestoreGuard,
  lookupBackup,
  type BackupPayload,
  type BackupLookup,
} from '@/src/lib/backup/relayBackup';
import {
  saveGroup,
  saveMemberProfiles,
  loadAllGroups,
  loadMemberProfiles,
  IdbGroupStateBackend,
} from '@/src/lib/marmot/groupStorage';
import type { Group, MemberProfile } from '@/src/types';
import { loadMessages } from '@/src/lib/marmot/chatPersistence';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { get, set } from 'idb-keyval';
import {
  saveInviteLink,
  loadAllInviteLinks,
} from '@/src/lib/marmot/inviteLinkStorage';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorageMock.clear();
  Object.keys(stores).forEach((k) => delete stores[k]);
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

describe('Base64 helpers', () => {
  it('round-trips a Uint8Array', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(b64);
    expect(decoded).toEqual(original);
  });

  it('encodes empty array', () => {
    const b64 = uint8ArrayToBase64(new Uint8Array([]));
    expect(b64).toBe('');
    expect(base64ToUint8Array(b64)).toEqual(new Uint8Array([]));
  });

  it('encodes known value', () => {
    // "Hello" in ASCII
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(uint8ArrayToBase64(bytes)).toBe('SGVsbG8=');
  });
});

// ---------------------------------------------------------------------------
// collectBackupPayload — empty state
// ---------------------------------------------------------------------------

describe('collectBackupPayload', () => {
  it('returns defaults when no data is stored', async () => {
    const payload = await collectBackupPayload();

    expect(payload.version).toBe(1);
    expect(typeof payload.createdAt).toBe('number');
    expect(payload.settings).toBeNull();
    expect(payload.userProfile).toBeNull();
    expect(payload.groups).toEqual([]);
    expect(payload.groupStates).toEqual({});
    expect(payload.memberProfiles).toEqual({});
    expect(payload.chatMessages).toEqual({});
    expect(payload.inviteLinks).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // localStorage data
  // -----------------------------------------------------------------------

  it('reads settings from localStorage', async () => {
    localStore[STORAGE_KEYS.settings] = JSON.stringify({
      theme: 'spring',
      language: 'de',
    });

    const payload = await collectBackupPayload();
    expect(payload.settings).toEqual({ theme: 'spring', language: 'de' });
  });

  it('reads userProfile from localStorage', async () => {
    const profile = {
      nickname: 'Alice',
      avatar: { imageUrl: '//few.chat/assets/a1.png' },
    };
    localStore[STORAGE_KEYS.userProfile] = JSON.stringify(profile);

    const payload = await collectBackupPayload();
    expect(payload.userProfile).toEqual(profile);
  });

  // -----------------------------------------------------------------------
  // IDB: groups, profiles, chat
  // -----------------------------------------------------------------------

  it('includes groups from IDB', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Study Group',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1', 'pk2'],
      relays: ['wss://relay.example.com'],
    };
    await saveGroup(group);

    const payload = await collectBackupPayload();
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toEqual({
      id: 'g1',
      name: 'Study Group',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1', 'pk2'],
      relays: ['wss://relay.example.com'],
    });
  });

  it('includes member profiles per group', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Test',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1'],
      relays: [],
    };
    await saveGroup(group);

    const profiles: MemberProfile[] = [
      {
        pubkeyHex: 'pk1',
        nickname: 'Alice',
        avatar: null,
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];
    await saveMemberProfiles('g1', profiles);

    const payload = await collectBackupPayload();
    expect(payload.memberProfiles['g1']).toEqual(profiles);
  });

  it('includes chat messages per group (via default idb-keyval store)', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Test',
      createdAt: 1700000000000,
      memberPubkeys: [],
      relays: [],
    };
    await saveGroup(group);

    const messages: ChatMessage[] = [
      {
        id: 'm1',
        content: 'Hello',
        senderPubkey: 'pk1',
        groupId: 'g1',
        createdAt: 1700000000000,
      },
    ];
    // chatPersistence stores in default idb-keyval store with key few:messages:{groupId}
    // We need to set it directly since loadMessages uses the default store
    const { set: idbSet } = await import('idb-keyval');
    await idbSet(`few:messages:g1`, messages);

    const payload = await collectBackupPayload();
    expect(payload.chatMessages['g1']).toEqual(messages);
  });

  // -----------------------------------------------------------------------
  // Chat message truncation
  // -----------------------------------------------------------------------

  it('truncates chat messages to last 10', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Test',
      createdAt: 1700000000000,
      memberPubkeys: [],
      relays: [],
    };
    await saveGroup(group);

    const messages: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`,
      content: `Message ${i}`,
      senderPubkey: 'pk1',
      groupId: 'g1',
      createdAt: 1700000000000 + i,
    }));

    const { set: idbSet } = await import('idb-keyval');
    await idbSet(`few:messages:g1`, messages);

    const payload = await collectBackupPayload();
    expect(payload.chatMessages['g1']).toHaveLength(10);
    // Should keep messages 5-14 (last 10)
    expect(payload.chatMessages['g1'][0].id).toBe('m5');
    expect(payload.chatMessages['g1'][9].id).toBe('m14');
  });

  // -----------------------------------------------------------------------
  // MLS state base64 encoding
  // -----------------------------------------------------------------------

  it('base64-encodes MLS group state', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Test',
      createdAt: 1700000000000,
      memberPubkeys: [],
      relays: [],
    };
    await saveGroup(group);

    // Simulate MLS state as Uint8Array stored in the state backend
    const stateBackend = new IdbGroupStateBackend();
    const mlsState = new Uint8Array([1, 2, 3, 4, 5]);
    await stateBackend.setItem('g1', mlsState as never);

    const payload = await collectBackupPayload();
    expect(payload.groupStates['g1']).toBe(uint8ArrayToBase64(mlsState));

    // Verify round-trip
    const decoded = base64ToUint8Array(payload.groupStates['g1']);
    expect(decoded).toEqual(mlsState);
  });

  // -----------------------------------------------------------------------
  // Multiple groups
  // -----------------------------------------------------------------------

  it('handles multiple groups with all data', async () => {
    const g1: Group = {
      id: 'g1',
      name: 'Group 1',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1'],
      relays: ['wss://r1.example.com'],
    };
    const g2: Group = {
      id: 'g2',
      name: 'Group 2',
      createdAt: 1700000001000,
      memberPubkeys: ['pk2'],
      relays: ['wss://r2.example.com'],
    };
    await saveGroup(g1);
    await saveGroup(g2);

    const payload = await collectBackupPayload();
    expect(payload.groups).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Malformed localStorage data
  // -----------------------------------------------------------------------

  it('handles malformed JSON in localStorage gracefully', async () => {
    localStore[STORAGE_KEYS.settings] = 'not-json{{{';

    const payload = await collectBackupPayload();
    expect(payload.settings).toBeNull();
  });

  it('sets createdAt to a recent Unix-seconds timestamp', async () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = await collectBackupPayload();
    const after = Math.floor(Date.now() / 1000);

    expect(payload.createdAt).toBeGreaterThanOrEqual(before);
    expect(payload.createdAt).toBeLessThanOrEqual(after);
  });

  // -----------------------------------------------------------------------
  // Invite links
  // -----------------------------------------------------------------------

  it('collects invite links from IDB', async () => {
    const link: InviteLink = {
      nonce: 'n1',
      groupId: 'g1',
      createdAt: 1700000000000,
      label: 'Class chat',
      muted: false,
    };
    await saveInviteLink(link);

    const payload = await collectBackupPayload();
    expect(payload.inviteLinks).toHaveLength(1);
    expect(payload.inviteLinks[0]).toEqual(link);
  });

  it('collects invite links across multiple groups', async () => {
    await saveInviteLink({ nonce: 'n1', groupId: 'g1', createdAt: 1000, muted: false });
    await saveInviteLink({ nonce: 'n2', groupId: 'g2', createdAt: 2000, label: 'Email', muted: true });

    const payload = await collectBackupPayload();
    expect(payload.inviteLinks).toHaveLength(2);
  });

  it('returns empty inviteLinks when none exist', async () => {
    const payload = await collectBackupPayload();
    expect(payload.inviteLinks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S2: createBackupEvent, fetchBackup, getBackupRelays
// ---------------------------------------------------------------------------

function makeMockSigner() {
  return {
    getPublicKey: vi.fn().mockResolvedValue('deadbeef'),
    signEvent: vi.fn().mockImplementation(async (draft: Record<string, unknown>) => ({
      ...draft,
      id: 'signed-event-id',
      pubkey: 'deadbeef',
      sig: 'fakesig',
    })),
    nip44: {
      encrypt: vi.fn().mockImplementation(async (_pk: string, plaintext: string) =>
        `encrypted:${plaintext}`
      ),
      decrypt: vi.fn().mockImplementation(async (_pk: string, ciphertext: string) =>
        ciphertext.replace('encrypted:', '')
      ),
    },
  };
}

const mockNdk = { fake: true } as unknown;

describe('createBackupEvent', () => {
  it('encrypts payload and returns kind 30078 event with d:few tag', async () => {
    const signer = makeMockSigner();
    const payload: BackupPayload = {
      version: 1,
      createdAt: 1700000000000,
      settings: null,
      userProfile: null,
      groups: [],
      groupStates: {},
      memberProfiles: {},
      chatMessages: {},
    };

    const event = await createBackupEvent(payload, signer, 'deadbeef');

    expect(event.kind).toBe(30078);
    expect(event.tags).toEqual([['d', 'few']]);
    expect(event.content).toBe(`encrypted:${JSON.stringify(payload)}`);
    expect(signer.nip44.encrypt).toHaveBeenCalledWith('deadbeef', JSON.stringify(payload));
    expect(typeof event.created_at).toBe('number');
  });
});

describe('publishBackup', () => {
  it('collects payload, encrypts, signs, and publishes to relay set', async () => {
    // getBackupRelays will be called internally — mock fetchEventsWithTimeout for relay list
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set(),
      timedOut: false,
    });

    const mockPublish = vi.fn().mockResolvedValue(undefined);
    // The NDKEvent mock's publish is set per-instance via the vi.mock above
    // We need to capture the instance to verify publish was called
    const { NDKEvent } = await import('@nostr-dev-kit/ndk');
    const origConstructor = NDKEvent;
    let capturedEvent: { publish: ReturnType<typeof vi.fn> } | null = null;

    const signer = makeMockSigner();
    const result = await publishBackup(signer, 'deadbeef', mockNdk as never);

    expect(result.ok).toBe(true);
    expect(signer.nip44.encrypt).toHaveBeenCalled();
    expect(signer.signEvent).toHaveBeenCalled();
  });

  it('returns failure indicator when publish throws', async () => {
    // Mock getBackupRelays (no relay list found)
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set(),
      timedOut: false,
    });

    const signer = makeMockSigner();
    signer.signEvent.mockRejectedValueOnce(new Error('signing failed'));

    const result = await publishBackup(signer, 'deadbeef', mockNdk as never);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('signing failed');
  });
});

function payloadOf(result: BackupLookup): BackupPayload {
  if (result.status !== 'found') throw new Error(`expected a found backup, got ${result.status}`);
  return result.payload;
}

describe('fetchBackup', () => {
  it('returns null when no events found', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set(),
      timedOut: false,
    });

    const signer = makeMockSigner();
    const result = await fetchBackup(signer, 'deadbeef', mockNdk as never);

    expect(result).toEqual({ status: 'none' });
  });

  it('decrypts and returns the newest backup event', async () => {
    const payload: BackupPayload = {
      version: 1,
      createdAt: 1700000000000,
      settings: { theme: 'spring', language: 'en' },
      userProfile: null,
      groups: [],
      groupStates: {},
      memberProfiles: {},
      chatMessages: {},
    };

    const encryptedContent = `encrypted:${JSON.stringify(payload)}`;

    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        { content: encryptedContent, created_at: 1700000100, id: 'ev1' },
      ]),
      timedOut: false,
    });

    const signer = makeMockSigner();
    const result = await fetchBackup(signer, 'deadbeef', mockNdk as never, [
      'wss://relay.example.com',
    ]);

    expect(result.status).toBe('found');
    expect(payloadOf(result).version).toBe(1);
    expect(payloadOf(result).settings).toEqual({ theme: 'spring', language: 'en' });
    expect(signer.nip44.decrypt).toHaveBeenCalledWith('deadbeef', encryptedContent);
  });

  it('picks the newest event when multiple are returned', async () => {
    const oldPayload: BackupPayload = {
      version: 1,
      createdAt: 1700000000000,
      settings: { theme: 'spring', language: 'de' },
      userProfile: null,
      groups: [],
      groupStates: {},
      memberProfiles: {},
      chatMessages: {},
    };
    const newPayload: BackupPayload = {
      ...oldPayload,
      settings: { theme: 'spring', language: 'en' },
      createdAt: 1700000001000,
    };

    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        { content: `encrypted:${JSON.stringify(oldPayload)}`, created_at: 100, id: 'old' },
        { content: `encrypted:${JSON.stringify(newPayload)}`, created_at: 200, id: 'new' },
      ]),
      timedOut: false,
    });

    const signer = makeMockSigner();
    const result = await fetchBackup(signer, 'deadbeef', mockNdk as never);

    expect(payloadOf(result).settings).toEqual({ theme: 'spring', language: 'en' });
  });

  it('reports a backup from a newer app version as unusable', async () => {
    const badPayload = { version: 99 };
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        { content: `encrypted:${JSON.stringify(badPayload)}`, created_at: 100, id: 'ev' },
      ]),
      timedOut: false,
    });

    const signer = makeMockSigner();
    expect(await fetchBackup(signer, 'deadbeef', mockNdk as never)).toEqual({
      status: 'unusable',
      reason: 'newer-version',
    });
  });
});

describe('getBackupRelays', () => {
  it('returns DEFAULT_RELAYS when no relay list event exists', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set(),
      timedOut: false,
    });

    const relays = await getBackupRelays(mockNdk as never, 'deadbeef');
    expect(relays).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
    ]);
  });

  it('extracts relay URLs from relay/r tags', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        {
          created_at: 100,
          tags: [
            ['r', 'wss://custom1.example.com'],
            ['relay', 'wss://custom2.example.com'],
          ],
          id: 'rl',
        },
      ]),
      timedOut: false,
    });

    const relays = await getBackupRelays(mockNdk as never, 'deadbeef');
    expect(relays).toEqual([
      'wss://custom1.example.com',
      'wss://custom2.example.com',
    ]);
  });

  it('falls back to DEFAULT_RELAYS when relay event has no relay tags', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        { created_at: 100, tags: [['d', 'other']], id: 'rl' },
      ]),
      timedOut: false,
    });

    const relays = await getBackupRelays(mockNdk as never, 'deadbeef');
    expect(relays).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
    ]);
  });
});

// ---------------------------------------------------------------------------
// S3: restoreFromBackup
// ---------------------------------------------------------------------------

function makeEmptyPayload(overrides?: Partial<BackupPayload>): BackupPayload {
  return {
    version: 1,
    createdAt: 1700000000000,
    settings: null,
    userProfile: null,
    groups: [],
    groupStates: {},
    memberProfiles: {},
    chatMessages: {},
    inviteLinks: [],
    ...overrides,
  };
}

describe('restoreFromBackup', () => {
  it('preserves un-backed-up localStorage keys (contacts, relays, signer, identity)', async () => {
    // A backup carries only settings + userProfile from localStorage. Restore
    // must NOT wipe the keys it does not rehydrate — doing so was the data-loss bug.
    localStore[STORAGE_KEYS.contacts] = JSON.stringify({ pk1: { nickname: 'Bob' } });
    localStore[STORAGE_KEYS.relays] = JSON.stringify(['wss://my.relay']);
    localStore[STORAGE_KEYS.signerMode] = 'nip07';
    localStore[STORAGE_KEYS.nostrIdentity] = JSON.stringify({ pubkeyHex: 'abc' });

    await restoreFromBackup(makeEmptyPayload({ settings: { theme: 'spring' } }));

    expect(localStore[STORAGE_KEYS.contacts]).toBe(JSON.stringify({ pk1: { nickname: 'Bob' } }));
    expect(localStore[STORAGE_KEYS.relays]).toBe(JSON.stringify(['wss://my.relay']));
    expect(localStore[STORAGE_KEYS.signerMode]).toBe('nip07');
    expect(localStore[STORAGE_KEYS.nostrIdentity]).toBe(JSON.stringify({ pubkeyHex: 'abc' }));
  });

  it('preserves DM thread messages (does not wipe few:messages:dm:*)', async () => {
    const dmMessages = [
      { id: 'd1', content: 'hi', senderPubkey: 'peer', groupId: 'dm:peer', createdAt: 1 },
    ];
    await set('few:messages:dm:peer', dmMessages);

    // The payload carries no DM threads; restore must leave them intact.
    await restoreFromBackup(makeEmptyPayload());

    expect(await get('few:messages:dm:peer')).toEqual(dmMessages);
  });

  it('merges group chat by id, preserving local history beyond the backup cap', async () => {
    // Local has 3 messages; the (truncated) backup carries the most recent 1 plus
    // a message not present locally. The merge must keep every distinct id.
    const local = [
      { id: 'm1', content: 'one', senderPubkey: 'pk', groupId: 'g1', createdAt: 1 },
      { id: 'm2', content: 'two', senderPubkey: 'pk', groupId: 'g1', createdAt: 2 },
      { id: 'm3', content: 'three', senderPubkey: 'pk', groupId: 'g1', createdAt: 3 },
    ];
    await set('few:messages:g1', local);

    const backup = [
      { id: 'm3', content: 'three', senderPubkey: 'pk', groupId: 'g1', createdAt: 3 },
      { id: 'm4', content: 'four', senderPubkey: 'pk', groupId: 'g1', createdAt: 4 },
    ];
    await restoreFromBackup(
      makeEmptyPayload({
        groups: [{ id: 'g1', name: 'T', createdAt: 0, memberPubkeys: [], relays: [] }],
        chatMessages: { g1: backup },
      }),
    );

    const { messages: loaded } = await loadMessages('g1');
    expect(loaded.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('rehydrates settings from payload', async () => {
    await restoreFromBackup(
      makeEmptyPayload({ settings: { theme: 'spring', language: 'de' } }),
    );

    expect(JSON.parse(localStore[STORAGE_KEYS.settings])).toEqual({
      theme: 'spring',
      language: 'de',
    });
  });

  it('rehydrates userProfile from payload', async () => {
    const profile = {
      nickname: 'Alice',
      avatar: { imageUrl: '//few.chat/assets/a1.png' },
    };

    await restoreFromBackup(makeEmptyPayload({ userProfile: profile }));

    expect(JSON.parse(localStore[STORAGE_KEYS.userProfile])).toEqual(profile);
  });

  it('rehydrates groups into IDB', async () => {
    const group = {
      id: 'g1',
      name: 'Study Group',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1'],
      relays: ['wss://relay.example.com'],
    };

    await restoreFromBackup(makeEmptyPayload({ groups: [group] }));

    const groups = await loadAllGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(group);
  });

  it('rehydrates member profiles into IDB', async () => {
    const profiles = [
      { pubkeyHex: 'pk1', nickname: 'Alice', avatar: null, updatedAt: '2024-01-01T00:00:00Z' },
    ];
    await restoreFromBackup(
      makeEmptyPayload({
        groups: [{ id: 'g1', name: 'T', createdAt: 0, memberPubkeys: [], relays: [] }],
        memberProfiles: { g1: profiles },
      }),
    );

    const loaded = await loadMemberProfiles('g1');
    expect(loaded).toEqual(profiles);
  });

  it('rehydrates chat messages into IDB', async () => {
    const messages = [
      { id: 'm1', content: 'Hello', senderPubkey: 'pk1', groupId: 'g1', createdAt: 1700000000000 },
    ];
    await restoreFromBackup(
      makeEmptyPayload({
        groups: [{ id: 'g1', name: 'T', createdAt: 0, memberPubkeys: [], relays: [] }],
        chatMessages: { g1: messages },
      }),
    );

    const { messages: loaded } = await loadMessages('g1');
    expect(loaded).toEqual(messages);
  });

  it('rehydrates MLS group state (base64-decoded) into IDB', async () => {
    const mlsBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const b64 = uint8ArrayToBase64(mlsBytes);

    await restoreFromBackup(
      makeEmptyPayload({
        groups: [{ id: 'g1', name: 'T', createdAt: 0, memberPubkeys: [], relays: [] }],
        groupStates: { g1: b64 },
      }),
    );

    const stateBackend = new IdbGroupStateBackend();
    const restored = await stateBackend.getItem('g1');
    expect(new Uint8Array(restored as never)).toEqual(mlsBytes);
  });

  it('sets nostrBackedUp flag to true', async () => {
    await restoreFromBackup(makeEmptyPayload());

    expect(localStore[STORAGE_KEYS.nostrBackedUp]).toBe('true');
  });

  it('round-trips: collect then restore produces equivalent state', async () => {
    // Set up state
    localStore[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'spring', language: 'de' });
    await saveGroup({
      id: 'g1',
      name: 'Bio',
      createdAt: 1700000000000,
      memberPubkeys: ['pk1'],
      relays: ['wss://relay.example.com'],
    });

    // Collect
    const payload = await collectBackupPayload();

    // Clear everything
    localStorageMock.clear();
    Object.keys(stores).forEach((k) => delete stores[k]);

    // Restore
    await restoreFromBackup(payload);

    // Verify
    expect(JSON.parse(localStore[STORAGE_KEYS.settings])).toEqual({
      theme: 'spring',
      language: 'de',
    });
    const groups = await loadAllGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Bio');
  });

  it('rehydrates invite links from payload', async () => {
    const links: InviteLink[] = [
      { nonce: 'n1', groupId: 'g1', createdAt: 1000, label: 'Class chat', muted: false },
      { nonce: 'n2', groupId: 'g2', createdAt: 2000, muted: true },
    ];

    await restoreFromBackup(makeEmptyPayload({ inviteLinks: links }));

    const restored = await loadAllInviteLinks();
    expect(restored).toHaveLength(2);
    expect(restored.find((l) => l.nonce === 'n1')?.label).toBe('Class chat');
    expect(restored.find((l) => l.nonce === 'n2')?.muted).toBe(true);
  });

  it('handles payload without inviteLinks field (backwards compat)', async () => {
    const payload = makeEmptyPayload();
    delete (payload as Record<string, unknown>).inviteLinks;

    await restoreFromBackup(payload);

    const restored = await loadAllInviteLinks();
    expect(restored).toEqual([]);
  });

  it('round-trips invite links through collect and restore', async () => {
    const link: InviteLink = {
      nonce: 'n-rt',
      groupId: 'g-rt',
      createdAt: 5000,
      label: 'Round trip',
      muted: true,
    };
    await saveInviteLink(link);

    const payload = await collectBackupPayload();

    // Clear everything
    localStorageMock.clear();
    Object.keys(stores).forEach((k) => delete stores[k]);

    await restoreFromBackup(payload);

    const restored = await loadAllInviteLinks();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(link);
  });
});

// ---------------------------------------------------------------------------
// S4: BackupScheduler
// ---------------------------------------------------------------------------

describe('BackupScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes immediately when markDirty(true) is called with no prior publish', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);

    expect(publishFn).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('debounces: does not publish again within 5 minutes', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true); // First publish
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.markDirty(true); // Within debounce window
    // Should schedule, not publish immediately
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('publishes after debounce window expires', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true); // First publish
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // let it settle

    scheduler.markDirty(true); // Schedules for later

    // Advance past 5-minute debounce
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('does not publish after dispose()', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.markDirty(true); // Schedules
    scheduler.dispose();

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(publishFn).toHaveBeenCalledTimes(1); // No extra publish
  });

  it('schedules without immediate flag', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(); // No immediate flag
    expect(publishFn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('coalesces multiple markDirty calls into one publish', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty();
    scheduler.markDirty();
    scheduler.markDirty();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });
});

// ---------------------------------------------------------------------------
// Behaviour contracts surfaced by the 2026-10-14 mutation audit of
// relayBackup.ts — each block asserts a user-facing guarantee the suite above
// only touched without pinning down.
// ---------------------------------------------------------------------------

function backupEvent(payload: Partial<BackupPayload>, createdAt: number | undefined, id: string) {
  return {
    content: `encrypted:${JSON.stringify({ ...makeEmptyPayload(), ...payload })}`,
    created_at: createdAt,
    id,
  };
}

describe('fetchBackup — only the user\'s own, newest backup is restored', () => {
  it('queries exactly the backup address: kind 30078, own pubkey, d:few', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(), timedOut: false });

    await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never, ['wss://r.example']);

    expect(mockFetchEventsWithTimeout.mock.calls[0][1]).toEqual({
      kinds: [30078],
      authors: ['deadbeef'],
      '#d': ['few'],
    });
  });

  it('reads from the given relays, falling back to the effective relays when none are given', async () => {
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    mockFetchEventsWithTimeout.mockResolvedValue({ events: new Set(), timedOut: false });

    await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never, ['wss://given.example']);
    expect(vi.mocked(NDKRelaySet.fromRelayUrls).mock.calls[0][0]).toEqual(['wss://given.example']);

    await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never);
    expect(vi.mocked(NDKRelaySet.fromRelayUrls).mock.calls[1][0]).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
    ]);
  });

  it('picks the newest backup regardless of the order relays return events in', async () => {
    const newest = backupEvent({ settings: { theme: 'spring', language: 'en' } }, 300, 'new');
    const older = backupEvent({ settings: { theme: 'spring', language: 'de' } }, 200, 'mid');
    const oldest = backupEvent({ settings: { theme: 'spring', language: 'fr' } }, 100, 'old');
    const orders = [
      [newest, older, oldest],
      [older, newest, oldest],
      [oldest, older, newest],
      [older, oldest, newest],
    ];
    for (const order of orders) {
      mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(order), timedOut: false });
      const result = await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never);
      expect(payloadOf(result).settings).toEqual({ theme: 'spring', language: 'en' });
    }
  });

  it('keeps the first-seen event on an equal timestamp and prefers a dated event over an undated one', async () => {
    const first = backupEvent({ settings: { theme: 'spring', language: 'en' } }, 100, 'a');
    const tie = backupEvent({ settings: { theme: 'spring', language: 'de' } }, 100, 'b');
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set([first, tie]), timedOut: false });
    expect(payloadOf(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).settings!.language).toBe('en');

    const dated = backupEvent({ settings: { theme: 'spring', language: 'en' } }, 5, 'dated');
    const undated = backupEvent({ settings: { theme: 'spring', language: 'de' } }, undefined, 'undated');
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set([dated, undated]), timedOut: false });
    expect(payloadOf(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).settings!.language).toBe('en');
  });

  it('does not attempt decryption when no backup exists', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(), timedOut: false });
    const signer = makeMockSigner();

    expect(await fetchBackup(signer, 'deadbeef', mockNdk as never)).toEqual({ status: 'none' });
    expect(signer.nip44.decrypt).not.toHaveBeenCalled();
  });
});

describe('getBackupRelays — backups go to the user\'s own newest relay list', () => {
  it('queries kind 30051 relay lists authored by the user', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(), timedOut: false });

    await getBackupRelays(mockNdk as never, 'deadbeef');

    expect(mockFetchEventsWithTimeout.mock.calls[0][1]).toEqual({
      kinds: [30051],
      authors: ['deadbeef'],
    });
  });

  it('uses the newest relay list regardless of event order', async () => {
    const newest = { created_at: 300, tags: [['relay', 'wss://newest.example']], id: 'n' };
    const older = { created_at: 200, tags: [['relay', 'wss://older.example']], id: 'o' };
    for (const order of [[newest, older], [older, newest]]) {
      mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(order), timedOut: false });
      expect(await getBackupRelays(mockNdk as never, 'deadbeef')).toEqual(['wss://newest.example']);
    }
  });

  it('keeps the first-seen list on an equal timestamp', async () => {
    const first = { created_at: 100, tags: [['relay', 'wss://first.example']], id: 'a' };
    const tie = { created_at: 100, tags: [['relay', 'wss://tie.example']], id: 'b' };
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set([first, tie]), timedOut: false });

    expect(await getBackupRelays(mockNdk as never, 'deadbeef')).toEqual(['wss://first.example']);
  });

  it('falls back to the effective relays when no list carries a timestamp', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([{ tags: [['relay', 'wss://undated.example']], id: 'u' }]),
      timedOut: false,
    });

    expect(await getBackupRelays(mockNdk as never, 'deadbeef')).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
    ]);
  });

  it('ignores non-relay tags and empty relay values', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([
        {
          created_at: 1,
          tags: [['d', 'marmot'], ['relay', ''], ['r', 'wss://kept.example'], ['p', 'wss://not-a-relay']],
          id: 'x',
        },
      ]),
      timedOut: false,
    });

    expect(await getBackupRelays(mockNdk as never, 'deadbeef')).toEqual(['wss://kept.example']);
  });
});

describe('createBackupEvent — relay-acceptable timestamp', () => {
  it('stamps created_at in Unix seconds, not milliseconds', async () => {
    const before = Math.floor(Date.now() / 1000);
    const event = await createBackupEvent(makeEmptyPayload(), makeMockSigner(), 'deadbeef');
    const after = Math.floor(Date.now() / 1000);

    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });
});

describe('restoreFromBackup — never clobbers local data the backup lacks', () => {
  it('leaves local settings and profile untouched when the backup carries none', async () => {
    localStore[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'local', language: 'de' });
    localStore[STORAGE_KEYS.userProfile] = JSON.stringify({ nickname: 'Local', avatar: null });

    await restoreFromBackup(makeEmptyPayload({ settings: null, userProfile: null }));

    expect(JSON.parse(localStore[STORAGE_KEYS.settings])).toEqual({ theme: 'local', language: 'de' });
    expect(JSON.parse(localStore[STORAGE_KEYS.userProfile])).toEqual({ nickname: 'Local', avatar: null });
  });

  it('keeps the local copy of a message on id collision', async () => {
    const msg = (content: string) => ({ id: 'm1', content, senderPubkey: 'pk', groupId: 'g1', createdAt: 1 });
    await set('few:messages:g1', [msg('local (edited)')]);

    await restoreFromBackup(makeEmptyPayload({ chatMessages: { g1: [msg('backup')] } }));

    const stored = (await get('few:messages:g1')) as ChatMessage[];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('local (edited)');
  });

  it('stores the merged history in chronological order whatever the input order', async () => {
    const m = (id: string, createdAt: number) => ({ id, content: id, senderPubkey: 'pk', groupId: 'g1', createdAt });
    await set('few:messages:g1', [m('l5', 5), m('l1', 1), m('l9', 9)]);

    await restoreFromBackup(
      makeEmptyPayload({ chatMessages: { g1: [m('b7', 7), m('b3', 3), m('b11', 11)] } }),
    );

    const stored = (await get('few:messages:g1')) as ChatMessage[];
    expect(stored.map((x) => x.createdAt)).toEqual([1, 3, 5, 7, 9, 11]);
  });
});

describe('BackupScheduler — 5-minute debounce contract', () => {
  const FIVE_MIN = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a deferred markDirty publishes at exactly five minutes, not before', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty();
    vi.advanceTimersByTime(FIVE_MIN - 1);
    expect(publishFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publishFn).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('a change inside the window publishes when the window ends, not a full interval later', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // let it settle

    vi.advanceTimersByTime(2 * 60 * 1000);
    scheduler.markDirty();
    vi.advanceTimersByTime(3 * 60 * 1000 - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(publishFn).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('an immediate request publishes at once when the window has exactly elapsed', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0); // let it settle
    vi.advanceTimersByTime(FIVE_MIN);
    scheduler.markDirty(true);
    expect(publishFn).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('an immediate request inside the window waits for the window to end', async () => {
    const publishFn = vi.fn().mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    scheduler.markDirty(true);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(publishFn).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('dispose() cancels an already scheduled publish', async () => {
    const publishFn = vi.fn().mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty();
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);

    expect(publishFn).not.toHaveBeenCalled();
  });

  it('ignores changes after dispose()', () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.dispose();
    scheduler.markDirty(true);
    scheduler.markDirty();
    vi.advanceTimersByTime(2 * FIVE_MIN);

    expect(publishFn).not.toHaveBeenCalled();
  });

  it('survives a rejected publish and keeps scheduling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publishFn = vi.fn().mockRejectedValueOnce(new Error('relay down')).mockResolvedValue(undefined);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    scheduler.markDirty();
    vi.advanceTimersByTime(FIVE_MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// epic-backup-restore-reliability, story 1 — honest lookup outcomes
// ---------------------------------------------------------------------------

describe('fetchBackup — lookup outcomes (AC-BRR-1)', () => {
  it('reports relays unreachable when the query times out with nothing', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({ events: new Set(), timedOut: true });
    expect(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).toEqual({ status: 'unreachable' });
  });

  it('reports relays unreachable when the query itself fails', async () => {
    mockFetchEventsWithTimeout.mockRejectedValueOnce(new Error('socket closed'));
    expect(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).toEqual({ status: 'unreachable' });
  });

  it('uses a backup that arrived even if some relay timed out', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([backupEvent({ settings: { theme: 'spring', language: 'en' } }, 10, 'e')]),
      timedOut: true,
    });
    expect((await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).status).toBe('found');
  });

  it('reports an undecryptable backup as unusable', async () => {
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
      events: new Set([backupEvent({}, 10, 'e')]),
      timedOut: false,
    });
    const signer = makeMockSigner();
    signer.nip44.decrypt.mockRejectedValueOnce(new Error('bad mac'));
    expect(await fetchBackup(signer, 'deadbeef', mockNdk as never)).toEqual({
      status: 'unusable',
      reason: 'unreadable',
    });
  });

  it('reports non-JSON and malformed backups as unusable', async () => {
    for (const content of ['encrypted:not json', `encrypted:${JSON.stringify({ version: 1, createdAt: 1, groups: 'x' })}`]) {
      mockFetchEventsWithTimeout.mockResolvedValueOnce({
        events: new Set([{ content, created_at: 10, id: 'e' }]),
        timedOut: false,
      });
      expect(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).toEqual({
        status: 'unusable',
        reason: 'unreadable',
      });
    }
  });
});

describe('fetchBackup — never throws on odd decrypted content', () => {
  it('reports a backup whose plaintext is not an object as unusable', async () => {
    for (const plaintext of ['null', '42', '"v1"']) {
      mockFetchEventsWithTimeout.mockResolvedValueOnce({
        events: new Set([{ content: `encrypted:${plaintext}`, created_at: 10, id: 'e' }]),
        timedOut: false,
      });
      expect(await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never)).toEqual({
        status: 'unusable',
        reason: 'unreadable',
      });
    }
  });
});

describe('lookupBackup — relay list + fetch for a local-key identity', () => {
  it('connects, reads the relay list, and returns the found backup', async () => {
    mockConnectNdk.mockResolvedValueOnce(mockNdk);
    mockFetchEventsWithTimeout
      .mockResolvedValueOnce({ events: new Set([{ created_at: 1, tags: [['relay', 'wss://mine']], id: 'r' }]), timedOut: false })
      .mockResolvedValueOnce({ events: new Set([backupEvent({ settings: { theme: 'spring', language: 'en' } }, 5, 'b')]), timedOut: false });

    const result = await lookupBackup('11'.repeat(32), 'deadbeef');

    expect(payloadOf(result).settings).toEqual({ theme: 'spring', language: 'en' });
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    expect(vi.mocked(NDKRelaySet.fromRelayUrls).mock.calls[0][0]).toEqual(['wss://mine']);
  });

  it('reports relays unreachable when connecting fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConnectNdk.mockRejectedValueOnce(new Error('offline'));
    expect(await lookupBackup('11'.repeat(32), 'deadbeef')).toEqual({ status: 'unreachable' });
    warn.mockRestore();
  });

  it('passes an unusable outcome through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConnectNdk.mockResolvedValueOnce(mockNdk);
    mockFetchEventsWithTimeout
      .mockResolvedValueOnce({ events: new Set(), timedOut: false })
      .mockResolvedValueOnce({
        events: new Set([{ content: 'encrypted:{"version":2}', created_at: 1, id: 'b' }]),
        timedOut: false,
      });
    expect(await lookupBackup('11'.repeat(32), 'deadbeef')).toEqual({ status: 'unusable', reason: 'newer-version' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseBackupPayload — full v1 validation before any write (AC-BRR-2)', () => {
  const group = { id: 'g1', name: 'G', createdAt: 1, memberPubkeys: ['pk'], relays: ['wss://r'] };
  const valid = () => ({
    ...makeEmptyPayload(),
    settings: { theme: 'spring', language: 'en' },
    userProfile: { nickname: 'N', avatar: null },
    groups: [group],
    groupStates: { g1: uint8ArrayToBase64(new Uint8Array([1, 2, 3])) },
    memberProfiles: { g1: [] },
    chatMessages: { g1: [{ id: 'm', content: 'c', senderPubkey: 'pk', groupId: 'g1', createdAt: 1 }] },
  });

  it('accepts a payload produced by collectBackupPayload', async () => {
    await saveGroup({ ...group, adminPubkeys: [] } as unknown as Group);
    await new IdbGroupStateBackend().setItem('g1', new Uint8Array([9, 8]) as never);
    localStore[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'spring', language: 'de' });

    const collected = JSON.parse(JSON.stringify(await collectBackupPayload()));
    expect(parseBackupPayload(collected)).toEqual(collected);
  });

  it('treats a v1 payload without invite links as having none', () => {
    const { inviteLinks: _omit, ...legacy } = valid();
    expect(parseBackupPayload(legacy)!.inviteLinks).toEqual([]);
  });

  it('accepts absent settings and profile, normalising them to none', () => {
    for (const absent of [null, undefined]) {
      const parsed = parseBackupPayload({ ...valid(), settings: absent, userProfile: absent });
      expect(parsed).not.toBeNull();
      expect(parsed!.settings).toBeNull();
      expect(parsed!.userProfile).toBeNull();
    }
  });

  const malformed: Array<[string, (p: Record<string, unknown>) => unknown]> = [
    ['an array at top level', () => [valid()]],
    ['settings as an array', (p) => ({ ...p, settings: ['dark'] })],
    ['profile not an object', (p) => ({ ...p, userProfile: 'N' })],
    ['group without a name', (p) => ({ ...p, groups: [{ ...group, name: 3 }] })],
    ['group with a non-numeric createdAt', (p) => ({ ...p, groups: [{ ...group, createdAt: '1' }] })],
    ['group relays partly non-strings', (p) => ({ ...p, groups: [{ ...group, relays: ['wss://r', 7] }] })],
    ['group state not a string', (p) => ({ ...p, groupStates: { g1: 12 } })],
    ['chat message with a non-numeric createdAt', (p) => ({ ...p, chatMessages: { g1: [{ id: 'm', createdAt: '1' }] } })],
    ['chat message that is not an object', (p) => ({ ...p, chatMessages: { g1: ['m'] } })],
    ['not an object', () => 'backup'],
    ['wrong version', (p) => ({ ...p, version: 0 })],
    ['missing createdAt', (p) => ({ ...p, createdAt: undefined })],
    ['settings not an object', (p) => ({ ...p, settings: 'dark' })],
    ['profile without nickname', (p) => ({ ...p, userProfile: { avatar: null } })],
    ['groups not an array', (p) => ({ ...p, groups: {} })],
    ['group without id', (p) => ({ ...p, groups: [{ ...group, id: 7 }] })],
    ['group members not strings', (p) => ({ ...p, groups: [{ ...group, memberPubkeys: [1] }] })],
    ['group state not base64', (p) => ({ ...p, groupStates: { g1: '%%%' } })],
    ['member profiles not a list', (p) => ({ ...p, memberProfiles: { g1: {} } })],
    ['chat not a list', (p) => ({ ...p, chatMessages: { g1: 'x' } })],
    ['chat message without id', (p) => ({ ...p, chatMessages: { g1: [{ createdAt: 1 }] } })],
    ['invite links not a list', (p) => ({ ...p, inviteLinks: {} })],
  ];
  for (const [label, corrupt] of malformed) {
    it(`refuses a payload with ${label}`, () => {
      expect(parseBackupPayload(corrupt(valid() as unknown as Record<string, unknown>))).toBeNull();
    });
  }
});

describe('restoreFromBackup — settings and profile are written last (AC-BRR-3)', () => {
  it('leaves settings, profile and the backed-up flag unchanged when an IDB write fails', async () => {
    localStore[STORAGE_KEYS.settings] = JSON.stringify({ theme: 'local', language: 'de' });
    localStore[STORAGE_KEYS.userProfile] = JSON.stringify({ nickname: 'Local', avatar: null });
    vi.mocked(set).mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(
      restoreFromBackup(
        makeEmptyPayload({
          settings: { theme: 'backup', language: 'en' },
          userProfile: { nickname: 'Backup', avatar: null },
          groups: [{ id: 'g1', name: 'G', createdAt: 1, memberPubkeys: [], relays: [] }],
        }),
      ),
    ).rejects.toThrow('QuotaExceededError');

    expect(JSON.parse(localStore[STORAGE_KEYS.settings])).toEqual({ theme: 'local', language: 'de' });
    expect(JSON.parse(localStore[STORAGE_KEYS.userProfile])).toEqual({ nickname: 'Local', avatar: null });
    expect(localStore[STORAGE_KEYS.nostrBackedUp]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// epic-backup-restore-reliability, story 2 — scheduled backup retries
// ---------------------------------------------------------------------------

describe('BackupScheduler — failed publishes are retried (AC-BRR-9..11)', () => {
  const SEC = 1000;
  const MIN = 60 * SEC;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a failure does not start the 5-minute window; changes during backoff wait for the retry (AC-BRR-9)', async () => {
    const publishFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.markDirty(true);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('retries after 30 s, 2 min, then every 10 min, five times in total (AC-BRR-10)', async () => {
    const publishFn = vi.fn().mockResolvedValue(false);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFn).toHaveBeenCalledTimes(1);

    const expectedDelays = [30 * SEC, 2 * MIN, 10 * MIN, 10 * MIN, 10 * MIN];
    for (const [i, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(publishFn).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(publishFn).toHaveBeenCalledTimes(i + 2);
    }

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(6);
    scheduler.dispose();
  });

  it('treats a rejected publish as a failure and retries it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publishFn = vi.fn().mockRejectedValueOnce(new Error('relay down')).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(30 * SEC);

    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    warn.mockRestore();
  });

  it('stops retrying once a publish succeeds', async () => {
    const publishFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(30 * SEC);
    expect(publishFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('a new change after the budget is exhausted publishes and retries again', async () => {
    const publishFn = vi.fn().mockResolvedValue(false);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(6);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFn).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(30 * SEC);
    expect(publishFn).toHaveBeenCalledTimes(8);
    scheduler.dispose();
  });

  it('a change made while a publish is in flight is published afterwards (AC-BRR-11)', async () => {
    let finish!: (ok: boolean) => void;
    const publishFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)))
      .mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(1);

    finish(true);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('a change made during a failed publish waits for the retry instead of bypassing backoff', async () => {
    let finish!: (ok: boolean) => void;
    const publishFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)))
      .mockResolvedValue(true);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    scheduler.markDirty(true);
    finish(false);
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('schedules nothing once disposed while a publish is in flight', async () => {
    let finish!: (ok: boolean) => void;
    const publishFn = vi.fn().mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    scheduler.markDirty(true);
    scheduler.dispose();
    finish(false);
    await vi.advanceTimersByTimeAsync(60 * MIN);

    expect(publishFn).toHaveBeenCalledTimes(1);
  });
});

describe('restore-decision guard', () => {
  it('is scoped to the recovered identity and survives until cleared', () => {
    markRestorePending('aa');
    expect(isRestorePending('aa')).toBe(true);
    expect(isRestorePending('bb')).toBe(false);
    clearRestorePending();
    expect(isRestorePending('aa')).toBe(false);
  });

  const cases: Array<[BackupLookup, boolean]> = [
    [{ status: 'none' }, false],
    [{ status: 'unusable', reason: 'unreadable' }, false],
    [{ status: 'unusable', reason: 'newer-version' }, true],
    [{ status: 'unreachable' }, true],
    [{ status: 'found', payload: makeEmptyPayload() }, true],
  ];
  for (const [lookup, stillPending] of cases) {
    const label = lookup.status === 'unusable' ? `unusable/${lookup.reason}` : lookup.status;
    it(`${stillPending ? 'keeps' : 'lifts'} the pause after a "${label}" lookup`, () => {
      markRestorePending('aa');
      settleRestoreGuard(lookup);
      expect(isRestorePending('aa')).toBe(stillPending);
    });
  }
});
