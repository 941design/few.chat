/**
 * Own direct messages shown optimistically but not yet persisted: an own DM is stored
 * only after the relay acknowledges it, so until then storage cannot restore it when
 * its conversation is opened again (bug dm-thread-switch-stale-rows-and-pending-send).
 *
 * Module scope on purpose: switching conversations through the contact list unmounts
 * the conversation view, and the send keeps running in the unmounted instance. The
 * newly mounted view reads the thread's pending sends from here and is told when one
 * settles. Entries are per account, so another account in this tab never sees them.
 */
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import type { OwnRowStatusPort } from '@/src/lib/marmot/send';

/**
 * `replacedIds` are earlier ids of the same send (an image send's temp id): a view
 * that restored the send under such an id drops that row.
 */
export type PendingSendSettled = { owner: string; threadId: string; id: string; replacedIds: string[]; persisted: boolean };

/**
 * A pending send was edited or hidden (being deleted), or that was rolled back:
 * `message` is what a view should now show for `id`, or null to show nothing.
 */
export type PendingSendChanged = { owner: string; threadId: string; id: string; message: ChatMessage | null };

/**
 * What a view shows for a pending send: its row, or null while it is being deleted.
 * `replacedIds` are earlier ids of the send (an image's temp id) whose rows it replaces.
 */
export type PendingSendView = { id: string; threadId: string; message: ChatMessage | null; replacedIds: string[] };

/**
 * `actions` counts edits/deletes of the send still publishing; `settledAs` holds a
 * settle that arrived meanwhile, applied once the last action ends (see
 * settlePendingOwnSend).
 */
type Entry = {
  owner: string;
  message: ChatMessage;
  hidden: boolean;
  replacedIds: string[];
  actions: number;
  settledAs: boolean | null;
};

const entries = new Map<string, Entry>();
const listeners = new Set<(event: PendingSendSettled) => void>();
const changeListeners = new Set<(event: PendingSendChanged) => void>();

function notify<E>(set: Set<(event: E) => void>, event: E): void {
  for (const listener of Array.from(set)) {
    try {
      listener(event);
    } catch (err) {
      console.warn('[pendingOwnSends] listener failed', err);
    }
  }
}

function notifyChanged(entry: Entry): void {
  notify(changeListeners, {
    owner: entry.owner,
    threadId: entry.message.groupId,
    id: entry.message.id,
    message: entry.hidden ? null : entry.message,
  });
}

const keyOf = (owner: string, id: string) => `${owner.toLowerCase()}:${id}`;
// Earlier key → current key of a replaced send, so an action begun under the temp id
// still finds the entry after the image id swap.
const aliases = new Map<string, string>();

function entryKey(owner: string, id: string): string {
  const key = keyOf(owner, id);
  return aliases.get(key) ?? key;
}

/** Registers an own send the moment its optimistic row is shown. */
export function registerPendingOwnSend(owner: string, message: ChatMessage): void {
  entries.set(keyOf(owner, message.id), {
    owner: owner.toLowerCase(), message, hidden: false, replacedIds: [], actions: 0, settledAs: null,
  });
}

/** Moves a pending send to its final row (an image send's temp id → event id). */
export function replacePendingOwnSend(owner: string, previousId: string, message: ChatMessage): void {
  const previousKey = entryKey(owner, previousId);
  const previous = entries.get(previousKey);
  entries.delete(previousKey);
  const key = keyOf(owner, message.id);
  for (const [from, to] of aliases) if (to === previousKey) aliases.set(from, key);
  aliases.set(keyOf(owner, previousId), key);
  const entry: Entry = {
    owner: owner.toLowerCase(),
    message,
    // Not carried over: an uploading row offers no delete (ChatMessage.uploading), so
    // nothing hidden can carry over; reset defensively, like the sending view does.
    hidden: false,
    replacedIds: [...(previous?.replacedIds ?? []), previousId],
    actions: previous?.actions ?? 0,
    settledAs: previous?.settledAs ?? null,
  };
  entries.set(key, entry);
  // A view that restored the send under its temp id swaps the row now, not at settle.
  notify(changeListeners, { owner: entry.owner, threadId: message.groupId, id: previousId, message: null });
  notifyChanged(entry);
}

/**
 * Keeps an optimistic edit of a pending send (or its rollback), so a restore shows
 * the content the user sees. No-op for an id that is not pending.
 */
export function updatePendingOwnSend(owner: string, message: ChatMessage): void {
  // Exact id only, no alias: a row edited under an image's temp id after the swap
  // would otherwise overwrite the final row with the temp id.
  const entry = entries.get(keyOf(owner, message.id));
  if (!entry) return;
  entry.message = message;
  notifyChanged(entry);
}

/**
 * Hides (or shows again) a pending send without forgetting it: an optimistic delete
 * of an unacked send must not be undone by the next thread open, and a failed
 * delete must make it restorable again. No-op for an id that is not pending.
 */
export function setPendingOwnSendHidden(owner: string, id: string, hidden: boolean): void {
  const entry = entries.get(entryKey(owner, id));
  if (!entry) return;
  entry.hidden = hidden;
  notifyChanged(entry);
}

/**
 * Forgets a pending send once it is persisted (`persisted`) or has failed, and tells
 * the listeners so a view mounted after the send started can catch up. While an edit
 * or delete of it is still publishing the settle waits for that action to end: until
 * then storage holds the plain original, and a view re-reading it would undo the
 * action.
 */
export function settlePendingOwnSend(owner: string, id: string, persisted: boolean): void {
  const key = entryKey(owner, id);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.actions > 0) {
    entry.settledAs = persisted;
    return;
  }
  removeEntry(key, entry, persisted);
}

/** Removes a pending entry (and its aliases) and tells the settle listeners. A `confirmed` status record held back by a deferred settle ends with it. */
function removeEntry(key: string, entry: Entry, persisted: boolean): void {
  entries.delete(key);
  for (const [from, to] of aliases) if (to === key) aliases.delete(from);
  if (statuses.get(keyOf(entry.owner, entry.message.id))?.status === 'confirmed') statuses.delete(keyOf(entry.owner, entry.message.id));
  notify(listeners, {
    owner: entry.owner,
    threadId: entry.message.groupId,
    id: entry.message.id,
    replacedIds: entry.replacedIds,
    persisted,
  });
}

/**
 * Marks an edit/delete of `id` as publishing. Returns whether `id` is a pending send;
 * only then must the caller call endPendingOwnSendAction when the action ends.
 */
export function beginPendingOwnSendAction(owner: string, id: string): boolean {
  const entry = entries.get(entryKey(owner, id));
  if (!entry) return false;
  entry.actions += 1;
  return true;
}

/** Ends an action begun with beginPendingOwnSendAction; applies a settle it held back. */
export function endPendingOwnSendAction(owner: string, id: string): void {
  const entry = entries.get(entryKey(owner, id));
  if (!entry || entry.actions === 0) return;
  entry.actions -= 1;
  // settlePendingOwnSend holds it again while other actions are still running.
  if (entry.settledAs !== null) settlePendingOwnSend(owner, entry.message.id, entry.settledAs);
}

/**
 * The pending sends of one account's thread as a view should show them, overriding
 * storage: the row (with any edit made meanwhile), or null while it is being deleted.
 */
export function pendingOwnSendsFor(owner: string, threadId: string): PendingSendView[] {
  const who = owner.toLowerCase();
  const out: PendingSendView[] = [];
  for (const entry of entries.values()) {
    if (entry.owner === who && entry.message.groupId === threadId) {
      out.push({
        id: entry.message.id,
        threadId: entry.message.groupId,
        message: entry.hidden ? null : entry.message,
        replacedIds: entry.replacedIds,
      });
    }
  }
  return out;
}

/** Listens for settled sends of one account's thread. Returns the unsubscribe function. */
export function subscribePendingOwnSendSettled(
  owner: string,
  threadId: string,
  onSettled: (event: PendingSendSettled) => void,
): () => void {
  const who = owner.toLowerCase();
  const listener = (event: PendingSendSettled) => {
    if (event.owner === who && event.threadId === threadId) onSettled(event);
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Listens for edits and hides of one account's pending sends in one thread, so a view
 * mounted after such an action started follows its outcome. Returns the unsubscribe
 * function.
 */
export function subscribePendingOwnSendChanged(
  owner: string,
  threadId: string,
  onChanged: (event: PendingSendChanged) => void,
): () => void {
  const who = owner.toLowerCase();
  const listener = (event: PendingSendChanged) => {
    if (event.owner === who && event.threadId === threadId) onChanged(event);
  };
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * The status of an own send's row, from the own-send lifecycle tracker (`send/ownRowTracker`):
 * `sending` (in flight, or retried), `failed` (kept: the failed/retry state, NOT a drop),
 * `confirmed` (the sink delivered it back; transient, see below) or `forgotten` (the tracker dropped the row: evicted
 * beyond `maxFailedRetained`, discarded, its group left; the last event of such a row, nothing is kept for it).
 */
export type OwnRowViewStatus = 'sending' | 'confirmed' | 'failed' | 'forgotten';

/** A row changed status. `confirmed` is the last event of a row: it is persisted by then. */
export type OwnRowStatusChanged = { owner: string; threadId: string; id: string; status: OwnRowViewStatus };

type StatusEntry = { owner: string; threadId: string; id: string; status: 'sending' | 'failed' | 'confirmed' };

// Per-row status kept until the row is confirmed-and-persisted (the sink persisted it before it echoed
// it) or explicitly forgotten. Unlike `entries` this survives a failure: `settlePendingOwnSend(…, false)`
// means "drop the row" (ContactChat), a failed own-lifecycle row must stay as failed/retry.
const statuses = new Map<string, StatusEntry>();
const statusListeners = new Set<(event: OwnRowStatusChanged) => void>();

/**
 * Records a status of an own row and tells the subscribers. `confirmed` settles the module-scope pending send
 * as persisted (a late echo thus also reaches a row that had failed) and ends the row's status record;
 * `failed` keeps both the pending send and the status; `sending` (a retry) turns a failed row back.
 */
export function setOwnRowStatus(owner: string, threadId: string, id: string, status: OwnRowViewStatus): void {
  const who = owner.toLowerCase();
  const key = keyOf(owner, id);
  if (status === 'forgotten') {
    forgetOwnRowStatus(owner, id, threadId);
    return;
  }
  const entry = entries.get(entryKey(owner, id));
  // `confirmed` ends the status record, unless the pending entry's settle is held back by an own edit/delete in
  // flight: the record stays as `confirmed` until that settle applies, so the confirmation stays visible.
  if (status === 'confirmed' && !(entry && entry.actions > 0)) statuses.delete(key);
  else statuses.set(key, { owner: who, threadId, id, status });
  notify(statusListeners, { owner: who, threadId, id, status });
  if (status === 'confirmed') settlePendingOwnSend(owner, id, true);
}

/**
 * The tracker dropped a row (the user discarded a failed row, the group was left, a failed row was evicted beyond
 * `maxFailedRetained`): "failed keeps the row" holds for LIVE rows only, a forgotten row is gone. Drops the status
 * record AND the pending send (settled as not persisted, so the views drop the row: without a status the pending send
 * would read `sending` forever with no retry left) and announces `forgotten` so mounted views update. A row this
 * module knows nothing about is a no-op.
 */
export function forgetOwnRowStatus(owner: string, id: string, threadId?: string): void {
  const key = keyOf(owner, id);
  const record = statuses.get(key);
  statuses.delete(key);
  const entryKeyed = entryKey(owner, id);
  const entry = entries.get(entryKeyed);
  if (entry) removeEntry(entryKeyed, entry, false);
  const thread = record?.threadId ?? entry?.message.groupId ?? threadId;
  if (thread !== undefined && (record || entry)) notify(statusListeners, { owner: owner.toLowerCase(), threadId: thread, id, status: 'forgotten' });
}

/** The status of an own row: the last reported one, `sending` for a pending send with none, undefined when unknown. */
export function ownRowStatusOf(owner: string, id: string): 'sending' | 'failed' | 'confirmed' | undefined {
  const known = statuses.get(keyOf(owner, id));
  if (known) return known.status;
  return entries.has(entryKey(owner, id)) ? 'sending' : undefined;
}

/** The rows of one account's thread that are not persisted yet, with their status (a view mounted later reads this). */
export function ownRowStatusesFor(owner: string, threadId: string): Array<{ id: string; status: 'sending' | 'failed' | 'confirmed' }> {
  const who = owner.toLowerCase();
  const out = new Map<string, 'sending' | 'failed' | 'confirmed'>();
  for (const entry of entries.values()) if (entry.owner === who && entry.message.groupId === threadId) out.set(entry.message.id, 'sending');
  for (const s of statuses.values()) if (s.owner === who && s.threadId === threadId) out.set(s.id, s.status);
  return [...out].map(([id, status]) => ({ id, status }));
}

/** Listens for status changes of one account's rows in one thread. Returns the unsubscribe function. */
export function subscribeOwnRowStatus(owner: string, threadId: string, onStatus: (event: OwnRowStatusChanged) => void): () => void {
  const who = owner.toLowerCase();
  const listener = (event: OwnRowStatusChanged) => {
    if (event.owner === who && event.threadId === threadId) onStatus(event);
  };
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * The own-send lifecycle's status port (`send/ownRowTracker`) pointed at this module: every transition
 * (`sending` on a retry, `failed`, `confirmed`) is a per-row status, kept and announced through
 * `subscribeOwnRowStatus`, so a view mounted (or remounted) after the send started catches up through the
 * same module-scope state as every other pending own send. `failed` KEEPS the row (failed/retry); only
 * `confirmed` settles the pending send as persisted. `forget` (the tracker dropped the row: discarded, group left,
 * evicted beyond `maxFailedRetained`) removes the status AND the pending send and announces `forgotten`. A row with no pending entry (earlier session, a signal)
 * still gets its status recorded.
 */
export function pendingOwnSendsStatusPort(owner: string): OwnRowStatusPort {
  return {
    setStatus: (groupId, rumorId, status) => setOwnRowStatus(owner, groupId, rumorId, status),
    forget: (groupId, rumorId) => forgetOwnRowStatus(owner, rumorId, groupId),
  };
}

/** Test seam: drops every entry and listener. */
export function _resetPendingOwnSends(): void {
  entries.clear();
  aliases.clear();
  listeners.clear();
  changeListeners.clear();
  statuses.clear();
  statusListeners.clear();
}
