import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_RELAYS, STORAGE_KEYS } from '@/src/types';

// ---------------------------------------------------------------------------
// Mock NDK and ndkClient before other imports
// ---------------------------------------------------------------------------

const mockFetchEventsWithTimeout = vi.fn();
const mockPublish = vi.fn();

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
    publish(relays: unknown) { return mockPublish(this, relays); }
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
  delMany: vi.fn(async (ks: string[], store?: string) => {
    const s = store ?? 'default';
    ks.forEach((k) => delete getOrCreateStore(s)[k]);
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
import { loadAllGroups, saveGroup, loadMemberProfiles } from '@/src/lib/marmot/groupStorage';
import type { Group } from '@/src/types';
import { get, set } from 'idb-keyval';
import { loadAllInviteLinks } from '@/src/lib/marmot/inviteLinkStorage';

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


// ---------------------------------------------------------------------------
// collectBackupPayload — empty state
// ---------------------------------------------------------------------------

describe('collectBackupPayload', () => {
  it('collects only settings and the own profile, even with persisted group data', async () => {
    const settings = { theme: 'spring', language: 'de' };
    const userProfile = { nickname: 'Owner', avatar: { imageUrl: '/avatar.png' } };
    localStore[STORAGE_KEYS.settings] = JSON.stringify(settings);
    localStore[STORAGE_KEYS.userProfile] = JSON.stringify(userProfile);
    await saveGroup({ id: 'g1', name: 'Local group', createdAt: 1, memberPubkeys: [], relays: [] } as Group);
    await set('few:messages:g1', [{ id: 'm1', content: 'group chat' }]);

    const payload = await collectBackupPayload();
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      version: 1, createdAt: expect.any(Number), settings, userProfile,
    });
    expect(payload.createdAt).toBeCloseTo(Date.now() / 1000, -1);
    expect(parseBackupPayload(payload)).toEqual(payload);
  });

  it('defaults invalid stored JSON and absent profile to null', async () => {
    localStore[STORAGE_KEYS.settings] = '{';
    expect(await collectBackupPayload()).toEqual(makeEmptyPayload({
      createdAt: expect.any(Number),
    }));
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

describe('publishBackup', () => {
  it('publishes a signed backup encrypted to the owner without cleartext metadata', async () => {
    const { createPrivateKeySigner } = await vi.importActual<typeof import('@/src/lib/marmot/signerAdapter')>(
      '@/src/lib/marmot/signerAdapter',
    );
    const signer = createPrivateKeySigner('11'.repeat(32));
    const owner = await signer.getPublicKey();
    const otherSigner = createPrivateKeySigner('22'.repeat(32));
    const settings = { theme: 'spring', language: 'en' };
    const userProfile = { nickname: 'Example nickname', avatar: { imageUrl: 'https://example.com/avatar.png' } };
    localStore[STORAGE_KEYS.settings] = JSON.stringify(settings);
    localStore[STORAGE_KEYS.userProfile] = JSON.stringify(userProfile);
    localStore[STORAGE_KEYS.relays] = JSON.stringify(['wss://backup.example']);
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');

    expect(await publishBackup(signer, owner, mockNdk as never)).toEqual({ ok: true });

    expect(NDKRelaySet.fromRelayUrls).toHaveBeenCalledWith(['wss://backup.example'], mockNdk);
    expect(mockFetchEventsWithTimeout).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event] = mockPublish.mock.calls[0];
    expect(event).toMatchObject({ kind: 30078, pubkey: owner, tags: [['d', 'few']], sig: expect.any(String) });
    expect(JSON.stringify(event)).not.toContain(userProfile.nickname);
    expect(JSON.stringify(event)).not.toContain(userProfile.avatar.imageUrl);
    expect(JSON.parse(await signer.nip44!.decrypt(owner, event.content))).toEqual({
      version: 1, createdAt: expect.any(Number), settings, userProfile,
    });
    await expect(otherSigner.nip44!.decrypt(owner, event.content)).rejects.toThrow();
  });

  it('returns failure indicator when publish throws', async () => {
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
  it('uses relay configuration when present and defaults otherwise', () => {
    expect(getBackupRelays()).toEqual(DEFAULT_RELAYS);
    localStorage.setItem(STORAGE_KEYS.relays, JSON.stringify(['wss://mine.example']));
    expect(getBackupRelays()).toEqual(['wss://mine.example']);
    expect(mockFetchEventsWithTimeout).not.toHaveBeenCalled();
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

    await restoreFromBackup(makeEmptyPayload({ settings: { theme: 'spring', language: 'en' } }));

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

  it('sets nostrBackedUp flag to true', async () => {
    await restoreFromBackup(makeEmptyPayload());

    expect(localStore[STORAGE_KEYS.nostrBackedUp]).toBe('true');
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
    for (const content of ['encrypted:not json', `encrypted:${JSON.stringify({ version: 1, createdAt: 1, settings: 'x' })}`]) {
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

describe('lookupBackup — configured relays for a local-key identity', () => {
  it('connects and returns the found backup', async () => {
    mockConnectNdk.mockResolvedValueOnce(mockNdk);
    localStorage.setItem(STORAGE_KEYS.relays, JSON.stringify(['wss://mine']));
    mockFetchEventsWithTimeout
      .mockResolvedValueOnce({ events: new Set([backupEvent({ settings: { theme: 'spring', language: 'en' } }, 5, 'b')]), timedOut: false });

    const result = await lookupBackup('11'.repeat(32), 'deadbeef');

    expect(payloadOf(result).settings).toEqual({ theme: 'spring', language: 'en' });
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    expect(vi.mocked(NDKRelaySet.fromRelayUrls).mock.calls[0][0]).toEqual(['wss://mine']);
    expect(mockFetchEventsWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockFetchEventsWithTimeout.mock.calls[0][1].kinds).toEqual([30078]);
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
    mockFetchEventsWithTimeout.mockResolvedValueOnce({
        events: new Set([{ content: 'encrypted:{"version":2}', created_at: 1, id: 'b' }]),
        timedOut: false,
      });
    expect(await lookupBackup('11'.repeat(32), 'deadbeef')).toEqual({ status: 'unusable', reason: 'newer-version' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseBackupPayload', () => {
  it('defaults absent settings and profile to null', () => {
    expect(parseBackupPayload({ version: 1, createdAt: 1 })).toEqual(makeEmptyPayload({ createdAt: 1 }));
  });

  it.each([
    [],
    'backup',
    { version: 0, createdAt: 1 },
    { version: 1 },
    { version: 1, createdAt: 1, settings: [] },
    { version: 1, createdAt: 1, settings: 'dark' },
    { version: 1, createdAt: 1, userProfile: 'N' },
    { version: 1, createdAt: 1, userProfile: { avatar: null } },
  ])('refuses malformed settings/profile backup %j', (payload) => {
    expect(parseBackupPayload(payload)).toBeNull();
  });
});

it('recovers a legacy encrypted payload without restoring any group data', async () => {
  const settings = { theme: 'spring', language: 'de' };
  const userProfile = { nickname: 'Recovered', avatar: null };
  const legacy = {
    ...makeEmptyPayload({ settings, userProfile }),
    groups: [{ id: 'g1', name: 'Group', createdAt: 1, memberPubkeys: [], relays: [] }],
    groupStates: { g1: 'AQID' },
    memberProfiles: { g1: [{ pubkey: 'member', nickname: 'Member' }] },
    chatMessages: { g1: [{ id: 'message', content: 'History', createdAt: 1 }] },
    inviteLinks: [{ groupId: 'g1', id: 'invite' }],
  };
  mockFetchEventsWithTimeout.mockResolvedValueOnce({
    events: new Set([{ content: `encrypted:${JSON.stringify(legacy)}`, created_at: 10 }]),
    timedOut: false,
  });
  const result = await fetchBackup(makeMockSigner(), 'deadbeef', mockNdk as never);
  await restoreFromBackup(payloadOf(result));

  expect(JSON.parse(localStore[STORAGE_KEYS.settings])).toEqual(settings);
  expect(JSON.parse(localStore[STORAGE_KEYS.userProfile])).toEqual(userProfile);
  expect(await loadAllGroups()).toEqual([]);
  expect(await loadMemberProfiles('g1')).toEqual([]);
  expect(await get('few:messages:g1')).toBeUndefined();
  expect(await loadAllInviteLinks()).toEqual([]);
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
    // First failure before any success: the early cold-start retry (5 s).
    await vi.advanceTimersByTimeAsync(5 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('retries after 5 s (cold start), then 30 s, 2 min, then every 10 min, five more times (AC-BRR-10)', async () => {
    const publishFn = vi.fn().mockResolvedValue(false);
    const scheduler = new BackupScheduler(publishFn);

    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFn).toHaveBeenCalledTimes(1);

    const expectedDelays = [5 * SEC, 30 * SEC, 2 * MIN, 10 * MIN, 10 * MIN, 10 * MIN];
    for (const [i, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(publishFn).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(publishFn).toHaveBeenCalledTimes(i + 2);
    }

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(publishFn).toHaveBeenCalledTimes(7);
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
    expect(publishFn).toHaveBeenCalledTimes(7);

    // The cold-start retry is spent: the fresh round starts at 30 s.
    scheduler.markDirty(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFn).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(publishFn).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFn).toHaveBeenCalledTimes(9);
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
    await vi.advanceTimersByTimeAsync(5 * SEC - 1);
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
