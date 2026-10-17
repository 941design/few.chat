/**
 * Account-changed cross-tab notice (bug: decided-small-fixes #3).
 *
 * Wiping local data (the account-switch path, storage.resetAllData) used to
 * post nothing, so another open tab kept serving the old account's cached
 * reactions and other state. The wipe now posts one `account-changed` message
 * on the existing 'few-tabs' channel; receiving tabs reload; the posting tab
 * never reacts to its own message.
 *
 * The channel is a bus of fakes that mimics BroadcastChannel delivery: a
 * message reaches every OTHER channel object of the same name, never the one
 * that posted it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_TAB_CHANNEL_NAME,
  parseAccountChanged,
  parseStoreChanged,
  postAccountChanged,
  postStoreChanged,
  setCrossTabChannelFactory,
  subscribeAccountChanged,
  subscribeStoreChanged,
  type CrossTabChannel,
} from '@/src/lib/crossTab';
import { installAccountChangedReload } from '@/src/lib/crossTabReceiver';
import { resetAllData } from '@/src/lib/storage';
import { postAccountChangedIfSwitched } from '@/src/lib/crossTab';

type Listener = (event: { data: unknown }) => void;

const bus = new Set<BusChannel>();

class BusChannel implements CrossTabChannel {
  listeners = new Set<Listener>();
  closed = false;
  posted: unknown[] = [];
  constructor(public name: string) {
    bus.add(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    for (const other of bus) {
      if (other !== this && !other.closed && other.name === this.name) {
        for (const l of Array.from(other.listeners)) l({ data: message });
      }
    }
  }
  addEventListener(_t: 'message', l: Listener): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: Listener): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.closed = true;
    bus.delete(this);
  }
}

/** Another tab of the app: a raw channel object on the same bus. */
function otherTab(): BusChannel {
  return new BusChannel(CROSS_TAB_CHANNEL_NAME);
}

// Node localStorage stand-in (resetAllData touches it).
const lsStore: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v; },
    removeItem: (k: string) => { delete lsStore[k]; },
  },
  writable: true,
});

beforeEach(() => {
  bus.clear();
  setCrossTabChannelFactory((name) => new BusChannel(name));
});
afterEach(() => setCrossTabChannelFactory());

describe('parseAccountChanged', () => {
  it('accepts the account-changed message', () => {
    expect(parseAccountChanged({ type: 'account-changed' })).toEqual({ type: 'account-changed' });
  });

  it.each([
    ['null', null],
    ['a string', 'account-changed'],
    ['a store-changed message', { type: 'store-changed', store: 'chat' }],
    ['unknown type', { type: 'account-switched' }],
    ['missing type', {}],
  ])('rejects %s', (_l, data) => {
    expect(parseAccountChanged(data)).toBeNull();
  });

  it('carries no data beyond the type, whatever extras arrive', () => {
    expect(parseAccountChanged({ type: 'account-changed', pubkey: 'ab'.repeat(32), nsec: 'x' })).toEqual({
      type: 'account-changed',
    });
  });

  it('is not mistaken for a store-changed message (and vice versa)', () => {
    expect(parseStoreChanged({ type: 'account-changed' })).toBeNull();
  });
});

describe('postAccountChanged / subscribeAccountChanged', () => {
  it('posts a bare account-changed message on the few-tabs channel', () => {
    const peer = otherTab();
    const got: unknown[] = [];
    peer.addEventListener('message', (e) => got.push(e.data));
    postAccountChanged();
    expect(got).toEqual([{ type: 'account-changed' }]);
  });

  it('notifies subscribers of another tab', () => {
    const listener = vi.fn();
    subscribeAccountChanged(listener);
    otherTab().postMessage({ type: 'account-changed' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never delivers the tab its own message', () => {
    const listener = vi.fn();
    subscribeAccountChanged(listener);
    postAccountChanged();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not notify account subscribers of store-changed messages, nor store subscribers of account-changed', () => {
    const account = vi.fn();
    const store = vi.fn();
    subscribeAccountChanged(account);
    subscribeStoreChanged(store);
    const peer = otherTab();
    peer.postMessage({ type: 'store-changed', store: 'chat' });
    expect(account).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledTimes(1);
    peer.postMessage({ type: 'account-changed' });
    expect(account).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not stop the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = vi.fn();
    subscribeAccountChanged(() => { throw new Error('boom'); });
    subscribeAccountChanged(second);
    otherTab().postMessage({ type: 'account-changed' });
    expect(second).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('unsubscribing stops delivery; the channel closes with the last listener of either kind', () => {
    const a = vi.fn();
    const offAccount = subscribeAccountChanged(a);
    const offStore = subscribeStoreChanged(() => {});
    const own = Array.from(bus).find((c) => c.listeners.size > 0)!;
    offAccount();
    expect(own.closed).toBe(false); // a store subscriber is still listening
    otherTab().postMessage({ type: 'account-changed' });
    expect(a).not.toHaveBeenCalled();
    offStore();
    expect(own.closed).toBe(true);
  });

  it('the channel stays open while another account listener remains', () => {
    const remaining = vi.fn();
    const offFirst = subscribeAccountChanged(() => {});
    subscribeAccountChanged(remaining);
    offFirst();
    otherTab().postMessage({ type: 'account-changed' });
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('the channel closes when the last listener is an account listener that unsubscribes', () => {
    const off = subscribeAccountChanged(() => {});
    const own = Array.from(bus)[0];
    expect(own.closed).toBe(false);
    off();
    expect(own.closed).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an unrelated object', { type: 'leader-claim' }],
    ['a malformed store-changed', { type: 'store-changed', store: 'nope' }],
  ])('ignores garbage on the channel (%s) without calling account listeners', (_l, data) => {
    const account = vi.fn();
    subscribeAccountChanged(account);
    otherTab().postMessage(data);
    expect(account).not.toHaveBeenCalled();
  });

  it('never throws, and does not warn, without a channel (server / Node)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCrossTabChannelFactory(() => null);
    expect(() => postAccountChanged()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(() => subscribeAccountChanged(() => {})()).not.toThrow();
  });

  it('swallows a failing post', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCrossTabChannelFactory(() => ({
      postMessage: () => { throw new Error('DataCloneError'); },
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    }));
    expect(() => postAccountChanged()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[crossTab] post failed', expect.anything());
    warn.mockRestore();
  });
});

describe('installAccountChangedReload', () => {
  it('reloads when ANOTHER tab announces an account change', () => {
    const reload = vi.fn();
    installAccountChangedReload(reload);
    otherTab().postMessage({ type: 'account-changed' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload for ordinary store changes', () => {
    const reload = vi.fn();
    installAccountChangedReload(reload);
    otherTab().postMessage({ type: 'store-changed', store: 'groups' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload the tab that posted the notice itself', () => {
    const reload = vi.fn();
    installAccountChangedReload(reload);
    postAccountChanged();
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops reloading once uninstalled', () => {
    const reload = vi.fn();
    installAccountChangedReload(reload)();
    otherTab().postMessage({ type: 'account-changed' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once for a burst of notices', () => {
    const reload = vi.fn();
    installAccountChangedReload(reload);
    const peer = otherTab();
    peer.postMessage({ type: 'account-changed' });
    peer.postMessage({ type: 'account-changed' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('resetAllData (the local-data wipe)', () => {
  it('announces the account change to other tabs, once', async () => {
    const peer = otherTab();
    const got: unknown[] = [];
    peer.addEventListener('message', (e) => got.push(e.data));
    await resetAllData();
    expect(got).toEqual([{ type: 'account-changed' }]);
  });

  it('removes the local data before announcing it (a reloading peer must not read the old account)', async () => {
    lsStore['lp_userProfile_v1'] = '{"nickname":"x"}';
    const seen: Array<string | undefined> = [];
    const peer = otherTab();
    peer.addEventListener('message', () => seen.push(lsStore['lp_userProfile_v1']));
    await resetAllData();
    expect(seen).toEqual([undefined]);
  });

  it('a receiving tab that has reloaded on the notice does not itself re-announce', async () => {
    const peer = otherTab();
    const echoes: unknown[] = [];
    peer.addEventListener('message', (e) => echoes.push(e.data));
    installAccountChangedReload(() => {});
    await resetAllData();
    // Only the wipe's own single post is observable on the bus.
    expect(echoes).toHaveLength(1);
    expect(peer.posted).toEqual([]);
  });

  it('the notice carries no profile, identity or account data', async () => {
    lsStore['lp_nostrIdentity_v1'] = JSON.stringify({ privateKeyHex: 'secret', pubkeyHex: 'pub' });
    const peer = otherTab();
    const got: unknown[] = [];
    peer.addEventListener('message', (e) => got.push(e.data));
    await resetAllData();
    expect(JSON.stringify(got)).not.toMatch(/secret|pub/);
  });

  it('still wipes when posting the notice fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCrossTabChannelFactory(() => ({
      postMessage: () => { throw new Error('closed'); },
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    }));
    lsStore['lp_userProfile_v1'] = 'x';
    await expect(resetAllData()).resolves.toBeUndefined();
    expect(lsStore['lp_userProfile_v1']).toBeUndefined();
    warn.mockRestore();
  });

  it('postStoreChanged still works alongside (existing contract unchanged)', async () => {
    const peer = otherTab();
    const got: unknown[] = [];
    peer.addEventListener('message', (e) => got.push(e.data));
    postStoreChanged('blocked');
    expect(got).toEqual([{ type: 'store-changed', store: 'blocked' }]);
  });
});

describe('resetAllData waits for the IndexedDB clears before announcing', () => {
  function recordingPeer(log: string[]) {
    const peer = otherTab();
    peer.addEventListener('message', () => log.push('notice'));
  }

  it('posts only after the clears finished', async () => {
    const log: string[] = [];
    recordingPeer(log);
    let release!: () => void;
    const clearIdb = () =>
      new Promise<void>((resolve) => {
        release = () => { log.push('cleared'); resolve(); };
      });
    const done = resetAllData({ clearIdb });
    await Promise.resolve();
    expect(log).toEqual([]); // still waiting on the clears: nothing announced yet
    release();
    await done;
    expect(log).toEqual(['cleared', 'notice']);
  });

  it('still posts, after the attempt, when a clear rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    recordingPeer(log);
    const clearIdb = async () => { log.push('clear-attempted'); throw new Error('IDB blocked'); };
    await expect(resetAllData({ clearIdb })).resolves.toBeUndefined();
    expect(log).toEqual(['clear-attempted', 'notice']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('without a browser (no window) there are no clears to run and nothing is warned about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    recordingPeer(log);
    await resetAllData();
    expect(log).toEqual(['notice']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes localStorage before the clears begin', async () => {
    lsStore['lp_userProfile_v1'] = 'x';
    let atClear: string | undefined = 'unset';
    await resetAllData({ clearIdb: async () => { atClear = lsStore['lp_userProfile_v1']; } });
    expect(atClear).toBeUndefined();
  });
});

describe('postAccountChangedIfSwitched (identity replaced in place, e.g. mnemonic restore)', () => {
  const A = 'ab'.repeat(32);
  const B = 'cd'.repeat(32);

  function peerLog() {
    const got: unknown[] = [];
    otherTab().addEventListener('message', (e) => got.push(e.data));
    return got;
  }

  it('announces when the pubkey changed', () => {
    const got = peerLog();
    expect(postAccountChangedIfSwitched(A, B)).toBe(true);
    expect(got).toEqual([{ type: 'account-changed' }]);
  });

  it('announces when there was no previous identity', () => {
    const got = peerLog();
    expect(postAccountChangedIfSwitched(null, B)).toBe(true);
    expect(postAccountChangedIfSwitched(undefined, B)).toBe(true);
    expect(got).toHaveLength(2);
  });

  it('stays silent when the same identity is restored (case-insensitive)', () => {
    const got = peerLog();
    expect(postAccountChangedIfSwitched(A, A)).toBe(false);
    expect(postAccountChangedIfSwitched(A, A.toUpperCase())).toBe(false);
    expect(got).toEqual([]);
  });
});
