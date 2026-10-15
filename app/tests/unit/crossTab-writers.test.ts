/**
 * Cross-tab change notifications (multi-tab design S0): every wired writer
 * tells the other tabs which store changed — only AFTER its write landed —
 * and a failing post never fails the write.
 *
 * Failure injection at every storage step touched: a localStorage.setItem
 * that throws and an idb-keyval set/del/clear that rejects must post nothing
 * (other tabs would otherwise re-read stale state and believe it current).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── localStorage mock with failure injection ────────────────────────────────
const lsStore: Record<string, string> = {};
let failSetItemFor: string | null = null;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => {
      if (failSetItemFor !== null && k === failSetItemFor) throw new Error('QuotaExceededError');
      lsStore[k] = v;
    },
    removeItem: (k: string) => {
      delete lsStore[k];
    },
    clear: () => Object.keys(lsStore).forEach((k) => delete lsStore[k]),
  },
  writable: true,
  configurable: true,
});

// ── idb-keyval mock (Map-backed) with failure injection ─────────────────────
const idb = new Map<string, unknown>();
let idbFail = false;
function maybeFail(): void {
  if (idbFail) throw new Error('IDB write failed');
}
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => ({})),
  get: vi.fn(async (k: string) => idb.get(k)),
  set: vi.fn(async (k: string, v: unknown) => {
    maybeFail();
    idb.set(k, v);
  }),
  del: vi.fn(async (k: string) => {
    maybeFail();
    idb.delete(k);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    maybeFail();
    ks.forEach((k) => idb.delete(k));
  }),
  clear: vi.fn(async () => {
    maybeFail();
    idb.clear();
  }),
  keys: vi.fn(async () => [...idb.keys()]),
}));

const { setCrossTabChannelFactory } = await import('@/src/lib/crossTab');
const contacts = await import('@/src/lib/contacts');
const knownPeers = await import('@/src/lib/knownPeers');
const contactCache = await import('@/src/lib/contactCache');
const groupStorage = await import('@/src/lib/marmot/groupStorage');
const chat = await import('@/src/lib/marmot/chatPersistence');
const polls = await import('@/src/lib/marmot/pollPersistence');
const { STORAGE_KEYS } = await import('@/src/types');

// ── fake channel ─────────────────────────────────────────────────────────────
let posted: unknown[];
let throwOnPost: boolean;

beforeEach(() => {
  posted = [];
  throwOnPost = false;
  failSetItemFor = null;
  idbFail = false;
  idb.clear();
  Object.keys(lsStore).forEach((k) => delete lsStore[k]);
  setCrossTabChannelFactory(() => ({
    postMessage: (m: unknown) => {
      if (throwOnPost) throw new Error('DataCloneError');
      posted.push(m);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
  }));
});
afterEach(() => setCrossTabChannelFactory());

const PEER = 'ab'.repeat(32);
const PEER2 = 'cd'.repeat(32);
const sc = (store: string, id?: string) =>
  id === undefined ? { type: 'store-changed', store } : { type: 'store-changed', store, id };

function seedContact(pubkeyHex = PEER): void {
  contacts.rememberContact(pubkeyHex, '2026-01-01T00:00:00.000Z');
  posted.length = 0;
}

describe('contacts.ts', () => {
  it('rememberContact posts contacts', () => {
    contacts.rememberContact(PEER);
    expect(posted).toEqual([sc('contacts')]);
  });

  it('rememberContact posts nothing when the sighting changes nothing', () => {
    contacts.rememberContact(PEER, '2026-01-02T00:00:00.000Z');
    posted.length = 0;
    contacts.rememberContact(PEER, '2026-01-01T00:00:00.000Z');
    contacts.rememberContact(PEER, '2026-01-02T00:00:00.000Z');
    expect(posted).toEqual([]);
    contacts.rememberContact(PEER, '2026-01-03T00:00:00.000Z');
    expect(posted).toEqual([sc('contacts')]);
    expect(contacts.readStoredContacts()[PEER].lastSeenAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('rememberContactsFromGroups writes all members in one write (one post), skipping self', () => {
    const OWN = 'ef'.repeat(32);
    const groups = [
      { id: 'g1', name: 'a', createdAt: 1, memberPubkeys: [OWN, PEER, PEER2], relays: [] },
      { id: 'g2', name: 'b', createdAt: 1, memberPubkeys: [PEER, ''], relays: [] },
    ];
    contacts.rememberContactsFromGroups(groups, OWN);
    expect(posted).toEqual([sc('contacts')]);
    const stored = contacts.readStoredContacts();
    expect(Object.keys(stored).sort()).toEqual([PEER, PEER2].sort());
    expect(stored[PEER].archivedAt).toBeNull();
  });

  it('rememberContactsFromGroups keeps existing fields and posts nothing for no members', () => {
    seedContact();
    contacts.archiveContact(PEER);
    posted.length = 0;
    contacts.rememberContactsFromGroups([{ id: 'g', name: 'g', createdAt: 1, memberPubkeys: [PEER], relays: [] }], null);
    expect(contacts.readStoredContacts()[PEER].archivedAt).toBeTruthy();
    expect(contacts.readStoredContacts()[PEER].firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    posted.length = 0;
    contacts.rememberContactsFromGroups([], null);
    expect(posted).toEqual([]);
  });

  it('archiveContact posts contacts then blocked, after archivedAt is stored', () => {
    seedContact();
    contacts.archiveContact(PEER);
    expect(posted).toEqual([sc('contacts'), sc('blocked')]);
    expect(contacts.readStoredContacts()[PEER].archivedAt).toBeTruthy();
  });

  it('unarchiveContact posts contacts then blocked', () => {
    seedContact();
    contacts.archiveContact(PEER);
    posted.length = 0;
    contacts.unarchiveContact(PEER);
    expect(posted).toEqual([sc('contacts'), sc('blocked')]);
    expect(contacts.readStoredContacts()[PEER].archivedAt).toBeNull();
  });

  it.each([
    ['archiveContact', (p: string) => contacts.archiveContact(p)],
    ['unarchiveContact', (p: string) => contacts.unarchiveContact(p)],
  ])('%s of an unknown or empty contact posts nothing', (_n, fn) => {
    fn(PEER2);
    fn('');
    expect(posted).toEqual([]);
  });

  it.each([
    ['archiveContact', (p: string) => contacts.archiveContact(p)],
    ['unarchiveContact', (p: string) => contacts.unarchiveContact(p)],
    ['rememberContact', (p: string) => contacts.rememberContact(p)],
  ])('%s: a failed write posts nothing and does not throw', (_n, fn) => {
    seedContact();
    failSetItemFor = STORAGE_KEYS.contacts;
    expect(() => fn(PEER)).not.toThrow();
    expect(posted).toEqual([]);
  });

  it('a failed post does not fail the block write', () => {
    seedContact();
    throwOnPost = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => contacts.archiveContact(PEER)).not.toThrow();
    expect(contacts.readStoredContacts()[PEER].archivedAt).toBeTruthy();
    warn.mockRestore();
  });

  it('purgeStrangerContacts posts contacts per changed key, nothing when nothing changed', () => {
    lsStore[STORAGE_KEYS.contacts] = JSON.stringify({ [PEER]: { pubkeyHex: PEER } });
    lsStore[STORAGE_KEYS.contactCache] = JSON.stringify({ [PEER]: { nickname: 'x' } });
    const whitelist = () => ({ groups: [], knownPeers: new Set<string>(), ownPubkeyHex: PEER2 });
    expect(contacts.purgeStrangerContacts(whitelist).deleted).toBe(2);
    expect(posted).toEqual([sc('contacts'), sc('contacts')]);
    posted.length = 0;
    contacts.purgeStrangerContacts(whitelist);
    expect(posted).toEqual([]);
  });

  it('purgeStrangerContacts posts nothing for a failed write', () => {
    lsStore[STORAGE_KEYS.contacts] = JSON.stringify({ [PEER]: { pubkeyHex: PEER } });
    failSetItemFor = STORAGE_KEYS.contacts;
    contacts.purgeStrangerContacts(() => ({ groups: [], knownPeers: new Set<string>(), ownPubkeyHex: PEER2 }));
    expect(posted).toEqual([]);
  });
});

describe('knownPeers.ts', () => {
  it('rememberKnownPeer posts known once; an idempotent re-add posts nothing', () => {
    knownPeers.rememberKnownPeer(PEER);
    knownPeers.rememberKnownPeer(PEER);
    expect(posted).toEqual([sc('known')]);
  });

  it('rememberKnownPeers posts known once for a changed batch, nothing for a no-op batch', () => {
    knownPeers.rememberKnownPeers([PEER, PEER2]);
    knownPeers.rememberKnownPeers([PEER]);
    expect(posted).toEqual([sc('known')]);
  });

  it('a failed write posts nothing', () => {
    failSetItemFor = 'lp_knownPeers_v1';
    knownPeers.rememberKnownPeer(PEER);
    expect(posted).toEqual([]);
  });

  it('a failed post does not fail the write', () => {
    throwOnPost = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    knownPeers.rememberKnownPeer(PEER);
    expect(knownPeers.isKnownPeer(PEER)).toBe(true);
    warn.mockRestore();
  });
});

describe('contactCache.ts', () => {
  const entry = (updatedAt: string) => ({ nickname: 'n', avatar: null, updatedAt });

  it('writeContactEntry posts contacts (the cache write, then the contact upsert)', () => {
    contactCache.writeContactEntry(PEER, entry('2026-01-02T00:00:00.000Z'));
    expect(posted).toEqual([sc('contacts'), sc('contacts')]);
  });

  it('writeContactEntry posts nothing when LWW rejects the write', () => {
    contactCache.writeContactEntry(PEER, entry('2026-01-02T00:00:00.000Z'));
    posted.length = 0;
    contactCache.writeContactEntry(PEER, entry('2026-01-01T00:00:00.000Z'));
    expect(posted).toEqual([]);
  });

  it('writeContactEntry posts nothing for a failed write', () => {
    failSetItemFor = STORAGE_KEYS.contactCache;
    contactCache.writeContactEntry(PEER, entry('2026-01-02T00:00:00.000Z'));
    expect(posted).toEqual([]);
  });

  it('writeContactEntryNeutralized posts contacts only when it wrote', () => {
    contactCache.writeContactEntryNeutralized(PEER, entry('2026-01-02T00:00:00.000Z'));
    expect(posted).toEqual([sc('contacts')]);
    posted.length = 0;
    contactCache.writeContactEntryNeutralized(PEER, entry('2026-01-02T00:00:00.000Z'));
    expect(posted).toEqual([]);
    failSetItemFor = STORAGE_KEYS.contactCache;
    contactCache.writeContactEntryNeutralized(PEER, entry('2026-01-03T00:00:00.000Z'));
    expect(posted).toEqual([]);
  });
});

describe('groupStorage.ts', () => {
  const group = { id: 'g1', name: 'G', createdAt: 1, memberPubkeys: [], relays: [] };

  it('saveGroup posts groups with the group id', async () => {
    await groupStorage.saveGroup(group);
    expect(posted).toEqual([sc('groups', 'g1')]);
  });

  it('deleteGroup posts groups with the group id', async () => {
    await groupStorage.deleteGroup('g1');
    expect(posted).toEqual([sc('groups', 'g1')]);
  });

  it('clearAllGroupMeta posts groups', async () => {
    await groupStorage.clearAllGroupMeta();
    expect(posted).toEqual([sc('groups')]);
  });

  it.each([
    ['saveGroup', () => groupStorage.saveGroup(group)],
    ['deleteGroup', () => groupStorage.deleteGroup('g1')],
    ['clearAllGroupMeta', () => groupStorage.clearAllGroupMeta()],
  ])('%s: a failed write still rejects and posts nothing', async (_n, fn) => {
    idbFail = true;
    await expect(fn()).rejects.toThrow('IDB write failed');
    expect(posted).toEqual([]);
  });

  it('a failed post does not fail saveGroup', async () => {
    throwOnPost = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(groupStorage.saveGroup(group)).resolves.toBeUndefined();
    expect(await groupStorage.loadGroup('g1')).toEqual(group);
    warn.mockRestore();
  });
});

describe('chatPersistence.ts', () => {
  const msg = (id: string) => ({
    id,
    content: 'hi',
    senderPubkey: PEER,
    groupId: 'g1',
    createdAt: 1_700_000_000_000,
  });
  const ID = '1'.repeat(64);

  it('appendMessage posts chat for the group; an insert-if-absent no-op posts nothing', async () => {
    expect(await chat.appendMessage('g1', msg(ID))).toBe(true);
    expect(await chat.appendMessage('g1', msg(ID))).toBe(false);
    expect(posted).toEqual([sc('chat', 'g1')]);
  });

  it('appendMessage posts chat when an announcement supersedes a materialized placeholder', async () => {
    await chat.appendMessage('g1', { ...msg(ID), materializedFromEdit: true } as never);
    posted.length = 0;
    const announcement = JSON.stringify({ type: 'member_admitted', pubkey: 'b'.repeat(64) });
    expect(await chat.appendMessage('g1', { ...msg(ID), content: announcement })).toBe(true);
    expect(posted).toEqual([sc('chat', 'g1')]);
  });

  it('appendMessage: a failed write rejects and posts nothing', async () => {
    idbFail = true;
    await expect(chat.appendMessage('g1', msg(ID))).rejects.toThrow();
    expect(posted).toEqual([]);
  });

  it('a failed post does not fail appendMessage', async () => {
    throwOnPost = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(chat.appendMessage('g1', msg(ID))).resolves.toBe(true);
    warn.mockRestore();
  });

  it('updateMessageInPlace posts chat when it wrote, nothing for a rejected patch', async () => {
    await chat.appendMessage('g1', msg(ID));
    posted.length = 0;
    await chat.updateMessageInPlace('g1', ID, { content: 'edited', edited: true, rev: 5 });
    expect(posted).toEqual([sc('chat', 'g1')]);
    posted.length = 0;
    await chat.updateMessageInPlace('g1', ID, { content: 'older', edited: true, rev: 1 });
    await chat.updateMessageInPlace('g1', 'missing', { content: 'x', rev: 9 });
    expect(posted).toEqual([]);
  });

  it('tombstoneMessage posts chat when it wrote, nothing otherwise', async () => {
    await chat.appendMessage('g1', msg(ID));
    posted.length = 0;
    expect(await chat.tombstoneMessage('g1', ID, 3)).toBe(true);
    expect(posted).toEqual([sc('chat', 'g1')]);
    posted.length = 0;
    expect(await chat.tombstoneMessage('g1', 'missing', 3)).toBe(false);
    expect(posted).toEqual([]);
  });

  it('removeMessages posts chat when rows were removed, nothing otherwise', async () => {
    await chat.appendMessage('g1', msg(ID));
    posted.length = 0;
    await chat.removeMessages('g1', ['missing']);
    expect(posted).toEqual([]);
    await chat.removeMessages('g1', [ID]);
    expect(posted).toEqual([sc('chat', 'g1')]);
  });

  it('clearMessages posts chat only when the thread existed', async () => {
    await chat.clearMessages('g1');
    expect(posted).toEqual([]);
    await chat.appendMessage('g1', msg(ID));
    posted.length = 0;
    await chat.clearMessages('g1');
    expect(posted).toEqual([sc('chat', 'g1')]);
  });

  it.each([
    ['updateMessageInPlace', () => chat.updateMessageInPlace('g1', ID, { content: 'e', edited: true, rev: 5 })],
    ['tombstoneMessage', () => chat.tombstoneMessage('g1', ID, 3)],
    ['removeMessages', () => chat.removeMessages('g1', [ID])],
    ['clearMessages', () => chat.clearMessages('g1')],
  ])('%s: a failed write rejects and posts nothing', async (_n, fn) => {
    await chat.appendMessage('g1', msg(ID));
    posted.length = 0;
    idbFail = true;
    await expect(fn()).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});

describe('pollPersistence.ts', () => {
  const poll = {
    id: 'p1',
    groupId: 'g1',
    title: 't',
    options: [],
    pollType: 'singlechoice' as const,
    creatorPubkey: PEER,
    createdAt: 1,
    closed: false,
  };
  const vote = (votedAt: number) => ({
    id: `p1:${PEER}`,
    groupId: 'g1',
    pollId: 'p1',
    voterPubkey: PEER,
    responses: ['a'],
    votedAt,
  });

  it('savePoll posts polls for the group', async () => {
    await polls.savePoll(poll);
    expect(posted).toEqual([sc('polls', 'g1')]);
  });

  it('saveVoteIfNewer posts polls only when it wrote', async () => {
    expect(await polls.saveVoteIfNewer(vote(10))).toBe(true);
    expect(await polls.saveVoteIfNewer(vote(5))).toBe(false);
    expect(posted).toEqual([sc('polls', 'g1')]);
  });

  it.each([
    ['savePoll', () => polls.savePoll(poll)],
    ['saveVoteIfNewer', () => polls.saveVoteIfNewer(vote(10))],
  ])('%s: a failed write rejects and posts nothing', async (_n, fn) => {
    idbFail = true;
    await expect(fn()).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});
