/**
 * crossTab.ts — cross-tab change notifications (multi-tab design S0).
 *
 * Every open tab of the app holds its own React state (revision counters,
 * the group list, the mounted chat thread) over the SAME origin storage
 * (localStorage + IndexedDB). Without a signal, a write in one tab — a block,
 * a new group, an appended chat message — is invisible to the other tabs
 * until they reload. This module is that signal: one `BroadcastChannel`
 * ('few-tabs') carrying typed `store-changed` messages.
 *
 * Contract:
 *   - Writers call {@link postStoreChanged} only AFTER their write has
 *     succeeded (the reaction store also posts after a rejected write, which
 *     IndexedDB leaves indeterminate — see reactions/api.ts#announce).
 *     Posting never throws, so a failed post can never fail the write it
 *     reports.
 *   - Receivers subscribe via {@link subscribeStoreChanged} and react by
 *     re-reading storage (bumping a revision counter / calling an existing
 *     reload). Messages are notifications only — they carry no data and
 *     coordinate nothing (no MLS coordination; that is design S1).
 *   - The posting and the listening channel are the same object, and a
 *     `BroadcastChannel` never delivers a message to the object that posted
 *     it, so a tab never receives its own changes (no echo filtering needed).
 *   - On the server / in Node (no `window` or no `BroadcastChannel`) every
 *     call is a no-op.
 *
 * A second message type, `account-changed`, announces that this tab wiped
 * the local account data (resetAllData, the account-switch path). It carries
 * no data at all — receivers reload and come up on whatever account is now
 * stored (see crossTabReceiver.ts#installAccountChangedReload).
 *
 * Tests inject a fake channel via {@link setCrossTabChannelFactory}.
 */

export const CROSS_TAB_CHANNEL_NAME = 'few-tabs';

/** The stores whose writes are announced to other tabs. */
export const CROSS_TAB_STORES = ['blocked', 'known', 'contacts', 'groups', 'chat', 'polls', 'reactions'] as const;

export type CrossTabStore = (typeof CROSS_TAB_STORES)[number];

export type StoreChangedMessage = {
  type: 'store-changed';
  store: CrossTabStore;
  /**
   * Optional scope, e.g. the group id of a chat or poll write, or the
   * reaction-thread namespace key of a reaction write.
   */
  id?: string;
};

/** This tab wiped the local account data; every other tab must drop its cached state. */
export type AccountChangedMessage = { type: 'account-changed' };

/** The subset of `BroadcastChannel` this module uses (fakeable in tests). */
export type CrossTabChannel = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
};

export type CrossTabChannelFactory = (name: string) => CrossTabChannel | null;

const defaultFactory: CrossTabChannelFactory = (name) => {
  if (typeof window === 'undefined' || typeof BroadcastChannel !== 'function') return null;
  return new BroadcastChannel(name) as unknown as CrossTabChannel;
};

let factory: CrossTabChannelFactory = defaultFactory;
let channel: CrossTabChannel | null = null;
const listeners = new Set<(message: StoreChangedMessage) => void>();
const accountListeners = new Set<(message: AccountChangedMessage) => void>();

function notify<M>(set: Set<(message: M) => void>, message: M): void {
  for (const listener of Array.from(set)) {
    try {
      listener(message);
    } catch (err) {
      console.warn('[crossTab] listener failed', err);
    }
  }
}

function onChannelMessage(event: { data: unknown }): void {
  const message = parseStoreChanged(event.data);
  if (message) {
    notify(listeners, message);
    return;
  }
  const account = parseAccountChanged(event.data);
  if (account) notify(accountListeners, account);
}

function openChannel(): CrossTabChannel | null {
  if (channel) return channel;
  try {
    channel = factory(CROSS_TAB_CHANNEL_NAME);
  } catch {
    channel = null;
  }
  channel?.addEventListener('message', onChannelMessage);
  return channel;
}

function closeChannel(): void {
  if (!channel) return;
  const closing = channel;
  channel = null;
  try {
    closing.removeEventListener('message', onChannelMessage);
    closing.close();
  } catch {
    // Already closed — nothing to release.
  }
}

/**
 * Validates an incoming message. Anything that is not a well-formed
 * `store-changed` message for a known store is dropped (returns null).
 */
export function parseStoreChanged(data: unknown): StoreChangedMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'store-changed') return null;
  if (!(CROSS_TAB_STORES as readonly unknown[]).includes(d.store)) return null;
  const message: StoreChangedMessage = { type: 'store-changed', store: d.store as CrossTabStore };
  if (typeof d.id === 'string') message.id = d.id;
  return message;
}

/** Validates an incoming `account-changed` message (it carries nothing else). */
export function parseAccountChanged(data: unknown): AccountChangedMessage | null {
  if (!data || typeof data !== 'object') return null;
  if ((data as Record<string, unknown>).type !== 'account-changed') return null;
  return { type: 'account-changed' };
}

/**
 * Tells the other open tabs that this tab wiped the local account data, so
 * their cached state belongs to an account that is gone. Call after the local
 * data was removed. Never throws.
 */
export function postAccountChanged(): void {
  try {
    const target = openChannel();
    if (!target) return;
    const message: AccountChangedMessage = { type: 'account-changed' };
    target.postMessage(message);
  } catch (err) {
    console.warn('[crossTab] post failed', err);
  }
}

/**
 * Announces an account change when the identity was swapped in place (mnemonic
 * restore) and the pubkey really differs. Call after the new identity was
 * persisted so a reloading peer comes up as the new account. Returns whether
 * a notice was posted.
 */
export function postAccountChangedIfSwitched(previousPubkey: string | null | undefined, nextPubkey: string): boolean {
  if (previousPubkey && previousPubkey.toLowerCase() === nextPubkey.toLowerCase()) return false;
  postAccountChanged();
  return true;
}

/**
 * Listens for another tab's account change. Returns the unsubscribe function;
 * the channel is closed when the last listener (of either kind) unsubscribes.
 */
export function subscribeAccountChanged(listener: (message: AccountChangedMessage) => void): () => void {
  accountListeners.add(listener);
  openChannel();
  return () => {
    accountListeners.delete(listener);
    if (listeners.size === 0 && accountListeners.size === 0) closeChannel();
  };
}

/**
 * Tells the other open tabs that `store` changed. Call only after the write
 * succeeded. Never throws.
 */
export function postStoreChanged(store: CrossTabStore, id?: string): void {
  try {
    const target = openChannel();
    if (!target) return;
    const message: StoreChangedMessage = id === undefined
      ? { type: 'store-changed', store }
      : { type: 'store-changed', store, id };
    target.postMessage(message);
  } catch (err) {
    console.warn('[crossTab] post failed', err);
  }
}

/**
 * Listens for other tabs' changes. Returns the unsubscribe function; the
 * channel is closed when the last listener unsubscribes.
 */
export function subscribeStoreChanged(listener: (message: StoreChangedMessage) => void): () => void {
  listeners.add(listener);
  openChannel();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && accountListeners.size === 0) closeChannel();
  };
}

/**
 * Like {@link subscribeStoreChanged}, but fires only for changes to one
 * store entry (e.g. the chat thread a view has open).
 */
export function subscribeStoreChangedFor(store: CrossTabStore, id: string, onChange: () => void): () => void {
  return subscribeStoreChanged((message) => {
    if (message.store === store && message.id === id) onChange();
  });
}

/**
 * Test seam: replaces the channel factory (pass nothing to restore the
 * default) and drops any open channel and listeners.
 */
export function setCrossTabChannelFactory(next?: CrossTabChannelFactory): void {
  closeChannel();
  listeners.clear();
  accountListeners.clear();
  factory = next ?? defaultFactory;
}
