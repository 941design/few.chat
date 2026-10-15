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
 *     succeeded. Posting never throws, so a failed post can never fail the
 *     write it reports.
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
 * Tests inject a fake channel via {@link setCrossTabChannelFactory}.
 */

export const CROSS_TAB_CHANNEL_NAME = 'few-tabs';

/** The stores whose writes are announced to other tabs. */
export const CROSS_TAB_STORES = ['blocked', 'known', 'contacts', 'groups', 'chat', 'polls'] as const;

export type CrossTabStore = (typeof CROSS_TAB_STORES)[number];

export type StoreChangedMessage = {
  type: 'store-changed';
  store: CrossTabStore;
  /** Optional scope, e.g. the group id of a chat or poll write. */
  id?: string;
};

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

function onChannelMessage(event: { data: unknown }): void {
  const message = parseStoreChanged(event.data);
  if (!message) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(message);
    } catch (err) {
      console.warn('[crossTab] listener failed', err);
    }
  }
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
    if (listeners.size === 0) closeChannel();
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
  factory = next ?? defaultFactory;
}
