/**
 * crossTab.ts (transport) + crossTabReceiver.ts (dispatch) — cross-tab change
 * notifications, multi-tab design S0.
 *
 * The channel is injected via setCrossTabChannelFactory (house style: no
 * jsdom; Node has no `window`, so the default factory is the no-op shim).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_TAB_CHANNEL_NAME,
  CROSS_TAB_STORES,
  parseStoreChanged,
  postStoreChanged,
  setCrossTabChannelFactory,
  subscribeStoreChanged,
  subscribeStoreChangedFor,
  type CrossTabChannel,
  type CrossTabStore,
  type StoreChangedMessage,
} from '@/src/lib/crossTab';
import { applyStoreChanged, isLatestReload, type CrossTabReceiverActions } from '@/src/lib/crossTabReceiver';

type Listener = (event: { data: unknown }) => void;

class FakeChannel implements CrossTabChannel {
  posted: unknown[] = [];
  listeners = new Set<Listener>();
  closed = false;
  throwOnPost = false;
  constructor(public name: string) {}
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error('DataCloneError');
    this.posted.push(message);
  }
  // Only 'message' listeners exist on a real BroadcastChannel we care about.
  addEventListener(type: 'message', listener: Listener): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(type: 'message', listener: Listener): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  /** Simulates a message arriving from ANOTHER tab. */
  deliver(data: unknown): void {
    for (const l of Array.from(this.listeners)) l({ data });
  }
}

let channels: FakeChannel[];

function installFake(): void {
  channels = [];
  setCrossTabChannelFactory((name) => {
    const c = new FakeChannel(name);
    channels.push(c);
    return c;
  });
}

beforeEach(() => installFake());
afterEach(() => setCrossTabChannelFactory());

describe('parseStoreChanged', () => {
  it.each(CROSS_TAB_STORES.map((s) => [s]))('accepts store %s', (store) => {
    expect(parseStoreChanged({ type: 'store-changed', store })).toEqual({ type: 'store-changed', store });
  });

  it('keeps a string id', () => {
    expect(parseStoreChanged({ type: 'store-changed', store: 'chat', id: 'g1' })).toEqual({
      type: 'store-changed',
      store: 'chat',
      id: 'g1',
    });
  });

  it('drops a non-string id but keeps the message', () => {
    expect(parseStoreChanged({ type: 'store-changed', store: 'chat', id: 7 })).toEqual({
      type: 'store-changed',
      store: 'chat',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'store-changed'],
    ['a number', 1],
    ['wrong type', { type: 'leader-claim', store: 'chat' }],
    ['missing type', { store: 'chat' }],
    ['unknown store', { type: 'store-changed', store: 'journal' }],
    ['missing store', { type: 'store-changed' }],
  ])('rejects %s', (_label, data) => {
    expect(parseStoreChanged(data)).toBeNull();
  });
});

describe('postStoreChanged', () => {
  it('posts a typed store-changed message on the few-tabs channel', () => {
    postStoreChanged('blocked');
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe(CROSS_TAB_CHANNEL_NAME);
    expect(CROSS_TAB_CHANNEL_NAME).toBe('few-tabs');
    expect(channels[0].posted).toEqual([{ type: 'store-changed', store: 'blocked' }]);
  });

  it('carries the id when given and omits the key otherwise', () => {
    postStoreChanged('chat', 'g1');
    postStoreChanged('groups');
    expect(channels[0].posted[0]).toEqual({ type: 'store-changed', store: 'chat', id: 'g1' });
    expect(Object.keys(channels[0].posted[1] as object)).toEqual(['type', 'store']);
  });

  it('reuses one channel across posts', () => {
    postStoreChanged('known');
    postStoreChanged('contacts');
    expect(channels).toHaveLength(1);
    expect(channels[0].posted).toHaveLength(2);
  });

  it('never throws when postMessage throws', () => {
    postStoreChanged('known');
    channels[0].throwOnPost = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => postStoreChanged('known')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws when the channel cannot be created', () => {
    setCrossTabChannelFactory(() => {
      throw new Error('SecurityError');
    });
    expect(() => postStoreChanged('known')).not.toThrow();
  });

  it('is a silent no-op without a channel (SSR / Node shim)', () => {
    setCrossTabChannelFactory(() => null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => postStoreChanged('groups', 'g')).not.toThrow();
    expect(() => subscribeStoreChanged(() => {})()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('default factory is a no-op in Node (no window)', () => {
    setCrossTabChannelFactory();
    expect(typeof window).toBe('undefined');
    expect(() => postStoreChanged('groups')).not.toThrow();
    const unsubscribe = subscribeStoreChanged(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('default channel factory', () => {
  const created: FakeChannel[] = [];
  class FakeBroadcastChannel extends FakeChannel {
    constructor(name: string) {
      super(name);
      created.push(this);
    }
  }
  const hadWindow = 'window' in globalThis;
  const originalBC = (globalThis as Record<string, unknown>).BroadcastChannel;

  function define(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  beforeEach(() => {
    created.length = 0;
    setCrossTabChannelFactory();
  });
  afterEach(() => {
    if (!hadWindow) delete (globalThis as Record<string, unknown>).window;
    define('BroadcastChannel', originalBC);
    setCrossTabChannelFactory();
  });

  it('in a browser, opens a BroadcastChannel named few-tabs and posts on it', () => {
    define('window', {});
    define('BroadcastChannel', FakeBroadcastChannel);
    postStoreChanged('blocked');
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('few-tabs');
    expect(created[0].posted).toEqual([{ type: 'store-changed', store: 'blocked' }]);
  });

  it('without window (SSR / Node), never constructs a channel even if BroadcastChannel exists', () => {
    if (hadWindow) delete (globalThis as Record<string, unknown>).window;
    define('BroadcastChannel', FakeBroadcastChannel);
    postStoreChanged('blocked');
    subscribeStoreChanged(() => {})();
    expect(created).toHaveLength(0);
  });

  it('with window but no BroadcastChannel, is a silent no-op', () => {
    define('window', {});
    define('BroadcastChannel', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => postStoreChanged('blocked')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('subscribeStoreChanged', () => {
  it('listens on the SAME channel it posts on, so a tab never hears itself', () => {
    const unsubscribe = subscribeStoreChanged(() => {});
    postStoreChanged('blocked');
    expect(channels).toHaveLength(1);
    expect(channels[0].listeners.size).toBe(1);
    expect(channels[0].posted).toHaveLength(1);
    unsubscribe();
  });

  it('delivers valid messages from other tabs to every listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeStoreChanged(a);
    const ub = subscribeStoreChanged(b);
    channels[0].deliver({ type: 'store-changed', store: 'groups', id: 'g' });
    expect(a).toHaveBeenCalledWith({ type: 'store-changed', store: 'groups', id: 'g' });
    expect(b).toHaveBeenCalledTimes(1);
    ua();
    ub();
  });

  it('ignores malformed messages', () => {
    const l = vi.fn();
    const u = subscribeStoreChanged(l);
    channels[0].deliver({ type: 'store-changed', store: 'nope' });
    channels[0].deliver('garbage');
    expect(l).not.toHaveBeenCalled();
    u();
  });

  it('a throwing listener does not stop the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const u1 = subscribeStoreChanged(bad);
    const u2 = subscribeStoreChanged(good);
    expect(() => channels[0].deliver({ type: 'store-changed', store: 'chat' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    u1();
    u2();
    warn.mockRestore();
  });

  it('unsubscribe stops delivery; the channel closes with the last listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeStoreChanged(a);
    const ub = subscribeStoreChanged(b);
    const ch = channels[0];
    ua();
    expect(ch.closed).toBe(false);
    ch.deliver({ type: 'store-changed', store: 'chat' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    ub();
    expect(ch.closed).toBe(true);
    expect(ch.listeners.size).toBe(0);
  });

  it('reopens a fresh channel after the last listener closed it', () => {
    subscribeStoreChanged(() => {})();
    const l = vi.fn();
    const u = subscribeStoreChanged(l);
    expect(channels).toHaveLength(2);
    expect(channels[1].closed).toBe(false);
    channels[1].deliver({ type: 'store-changed', store: 'polls' });
    expect(l).toHaveBeenCalledTimes(1);
    postStoreChanged('polls');
    expect(channels[1].posted).toHaveLength(1);
    u();
  });

  it('closing twice is harmless and a throwing close is swallowed', () => {
    const u = subscribeStoreChanged(() => {});
    channels[0].close = () => {
      throw new Error('InvalidStateError');
    };
    expect(() => u()).not.toThrow();
    expect(() => u()).not.toThrow();
  });
});

describe('subscribeStoreChangedFor', () => {
  it('fires only for the given store AND id', () => {
    const l = vi.fn();
    const u = subscribeStoreChangedFor('chat', 'dm:abc', l);
    channels[0].deliver({ type: 'store-changed', store: 'chat', id: 'dm:abc' });
    channels[0].deliver({ type: 'store-changed', store: 'chat', id: 'dm:other' });
    channels[0].deliver({ type: 'store-changed', store: 'chat' });
    channels[0].deliver({ type: 'store-changed', store: 'polls', id: 'dm:abc' });
    expect(l).toHaveBeenCalledTimes(1);
    channels[0].deliver({ type: 'store-changed', store: 'chat', id: 'dm:abc' });
    expect(l).toHaveBeenCalledTimes(2);
    u();
    channels[0].deliver({ type: 'store-changed', store: 'chat', id: 'dm:abc' });
    expect(l).toHaveBeenCalledTimes(2);
    expect(channels[0].closed).toBe(true);
  });
});

describe('applyStoreChanged', () => {
  function actions(): CrossTabReceiverActions & Record<string, ReturnType<typeof vi.fn>> {
    return {
      bumpBlockedPeers: vi.fn(),
      bumpKnownPeers: vi.fn(),
      bumpContacts: vi.fn(),
      reloadGroups: vi.fn(),
      bumpGroupData: vi.fn(),
      bumpChat: vi.fn(),
      bumpPolls: vi.fn(),
      refreshReactions: vi.fn(),
    };
  }

  const expected: Record<CrossTabStore, (keyof CrossTabReceiverActions)[]> = {
    blocked: ['bumpBlockedPeers'],
    known: ['bumpKnownPeers'],
    contacts: ['bumpContacts'],
    groups: ['reloadGroups', 'bumpGroupData'],
    chat: ['bumpChat'],
    polls: ['bumpPolls'],
    reactions: ['refreshReactions'],
  };

  it.each(CROSS_TAB_STORES.map((s) => [s]))('%s calls exactly its actions, once each', (store) => {
    const a = actions();
    const message: StoreChangedMessage = { type: 'store-changed', store, id: 'x' };
    applyStoreChanged(message, a);
    for (const [name, fn] of Object.entries(a)) {
      const want = expected[store].includes(name as keyof CrossTabReceiverActions) ? 1 : 0;
      expect(fn, `${store} → ${name}`).toHaveBeenCalledTimes(want);
    }
  });

  it('reactions refreshes exactly the announced thread key', () => {
    const a = actions();
    applyStoreChanged({ type: 'store-changed', store: 'reactions', id: 'few:reactions:group:g1' }, a);
    expect(a.refreshReactions).toHaveBeenCalledWith('few:reactions:group:g1');
  });

  it('an unscoped reactions notice refreshes nothing (no blanket cache drop)', () => {
    const a = actions();
    applyStoreChanged({ type: 'store-changed', store: 'reactions' }, a);
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
  });
});

// MarmotContext's receiver wiring cannot be rendered here (no jsdom), so its
// action → state-setter table is pinned by a source scan (skipped under
// Stryker, whose instrumented copy breaks text matches — contacts.test.ts
// precedent).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const itSourceScan = REPO_ROOT.includes('.stryker-tmp') ? it.skip : it;

describe('isLatestReload', () => {
  it.each([
    [1, 1, true],
    [3, 3, true],
    [1, 2, false],
    [2, 5, false],
  ])('reload %i with latest %i applies: %s', (seq, latest, want) => {
    expect(isLatestReload(seq, latest)).toBe(want);
  });
});

describe('MarmotContext receiver wiring', () => {
  itSourceScan('reloadGroups numbers each reload and drops a superseded result before setGroups', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/context/MarmotContext.tsx'), 'utf-8');
    const start = src.indexOf('const reloadGroups = useCallback(');
    const body = src.slice(start, src.indexOf('}, []);', start));
    const seq = body.indexOf('++reloadGroupsSeqRef.current');
    const load = body.indexOf('await loadAllGroups()');
    const guard = body.indexOf('if (!isLatestReload(seq, reloadGroupsSeqRef.current)) return;');
    const apply = body.indexOf('setGroups(loaded)');
    expect(seq).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(seq);
    expect(guard).toBeGreaterThan(load);
    expect(apply).toBeGreaterThan(guard);
  });

  itSourceScan('subscribes once and maps each action to its existing counter / reload', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/context/MarmotContext.tsx'), 'utf-8');
    expect(src.match(/subscribeStoreChanged\(/g)).toHaveLength(1);
    // The effect returns the unsubscribe (arrow body is the subscribe call).
    expect(src).toMatch(/useEffect\(\s*\(\)\s*=>\s*subscribeStoreChanged\(/);
    const start = src.indexOf('applyStoreChanged(message, {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('[reloadGroups]', start));
    for (const [action, target] of [
      ['bumpBlockedPeers', 'setBlockedPeersRevision'],
      ['bumpKnownPeers', 'setKnownPeersRevision'],
      ['bumpContacts', 'setContactsRevision'],
      ['reloadGroups', 'reloadGroups()'],
      ['bumpGroupData', 'setGroupDataVersion'],
      ['bumpChat', 'setChatVersion'],
      ['bumpPolls', 'setPollVersion'],
      ['refreshReactions', 'refreshReactionsFromStorage(key)'],
    ]) {
      const at = body.indexOf(`${action}: `);
      expect(at, action).toBeGreaterThan(-1);
      expect(body.slice(at).split('\n').slice(0, 2).join('\n'), action).toContain(target);
    }
  });
});
