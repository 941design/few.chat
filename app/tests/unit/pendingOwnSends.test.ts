/**
 * Registry of own DMs shown before their relay ack (bug
 * dm-thread-switch-stale-rows-and-pending-send): a remounted or re-seeded conversation
 * view restores them from here and learns when they settle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import {
  _resetPendingOwnSends,
  beginPendingOwnSendAction,
  endPendingOwnSendAction,
  pendingOwnSendsFor,
  registerPendingOwnSend,
  replacePendingOwnSend,
  setPendingOwnSendHidden,
  settlePendingOwnSend,
  subscribePendingOwnSendChanged,
  subscribePendingOwnSendSettled,
  updatePendingOwnSend,
} from '@/src/lib/pendingOwnSends';

const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

const row = (id: string, groupId = 'dm:bob', createdAt = 1): ChatMessage => ({
  id, content: id, senderPubkey: ME, groupId, createdAt,
});

const ids = (views: Array<{ id: string }>) => views.map((v) => v.id);

beforeEach(() => {
  _resetPendingOwnSends();
});

describe('registry', () => {
  it('lists a registered send for its thread only', () => {
    registerPendingOwnSend(ME, row('a'));
    registerPendingOwnSend(ME, row('c', 'dm:carol'));
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['a']);
    expect(ids(pendingOwnSendsFor(ME, 'dm:carol'))).toEqual(['c']);
  });

  it('keeps accounts apart, whatever the pubkey case', () => {
    registerPendingOwnSend(ME.toUpperCase(), row('a'));
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['a']);
    expect(pendingOwnSendsFor(OTHER, 'dm:bob')).toEqual([]);
  });

  it('forgets a send once settled, persisted or not', () => {
    registerPendingOwnSend(ME, row('ok'));
    registerPendingOwnSend(ME, row('fail'));
    settlePendingOwnSend(ME, 'ok', true);
    settlePendingOwnSend(ME, 'fail', false);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
  });

  it('settling under another account leaves the send pending', () => {
    registerPendingOwnSend(ME, row('a'));
    settlePendingOwnSend(OTHER, 'a', true);
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['a']);
  });

  it('replace moves the send to its final row', () => {
    registerPendingOwnSend(ME, row('temp'));
    replacePendingOwnSend(ME, 'temp', row('event'));
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['event']);
    settlePendingOwnSend(ME, 'event', true);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
  });

  it('a hidden send (being deleted) is listed as null, and with its row again when un-hidden', () => {
    registerPendingOwnSend(ME, row('a'));
    setPendingOwnSendHidden(ME, 'a', true);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'a', threadId: 'dm:bob', message: null, replacedIds: [] }]);
    setPendingOwnSendHidden(ME, 'a', false);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'a', threadId: 'dm:bob', message: row('a'), replacedIds: [] }]);
  });

  it('replace shows a hidden send again (a temp-id delete cannot reach the event-id row)', () => {
    registerPendingOwnSend(ME, row('temp'));
    setPendingOwnSendHidden(ME, 'temp', true);
    replacePendingOwnSend(ME, 'temp', row('event'));
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'event', threadId: 'dm:bob', message: row('event'), replacedIds: ['temp'] }]);
  });

  it('update keeps an edit of a pending send, and is a no-op otherwise', () => {
    registerPendingOwnSend(ME, row('a'));
    updatePendingOwnSend(ME, { ...row('a'), content: 'edited', edited: true });
    updatePendingOwnSend(ME, row('ghost'));
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([
      { id: 'a', threadId: 'dm:bob', message: { ...row('a'), content: 'edited', edited: true }, replacedIds: [] },
    ]);
  });

  it('hiding an id that is not pending changes nothing', () => {
    setPendingOwnSendHidden(ME, 'ghost', true);
    registerPendingOwnSend(ME, row('ghost'));
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['ghost']);
  });
});

describe('settled notifications', () => {
  it('tells the listeners of the send\'s thread, with the outcome', () => {
    const bob = vi.fn();
    const carol = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    subscribePendingOwnSendSettled(ME, 'dm:carol', carol);
    registerPendingOwnSend(ME, row('a'));
    registerPendingOwnSend(ME, row('b'));

    settlePendingOwnSend(ME, 'a', true);
    settlePendingOwnSend(ME, 'b', false);

    expect(bob.mock.calls).toEqual([
      [{ owner: ME, threadId: 'dm:bob', id: 'a', replacedIds: [], persisted: true }],
      [{ owner: ME, threadId: 'dm:bob', id: 'b', replacedIds: [], persisted: false }],
    ]);
    expect(carol).not.toHaveBeenCalled();
  });

  it('carries the earlier ids of a replaced send', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('temp'));
    replacePendingOwnSend(ME, 'temp', row('event'));
    settlePendingOwnSend(ME, 'event', false);
    expect(bob).toHaveBeenCalledWith({ owner: ME, threadId: 'dm:bob', id: 'event', replacedIds: ['temp'], persisted: false });
  });

  it('does not reach another account\'s view of the same thread', () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    subscribePendingOwnSendSettled(ME.toUpperCase(), 'dm:bob', mine);
    subscribePendingOwnSendSettled(OTHER, 'dm:bob', theirs);
    registerPendingOwnSend(ME, row('a'));
    settlePendingOwnSend(ME, 'a', true);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it('a send that is not pending notifies nobody', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    settlePendingOwnSend(ME, 'never-registered', true);
    expect(bob).not.toHaveBeenCalled();
  });

  it('stops after unsubscribe', () => {
    const bob = vi.fn();
    const off = subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    off();
    registerPendingOwnSend(ME, row('a'));
    settlePendingOwnSend(ME, 'a', true);
    expect(bob).not.toHaveBeenCalled();
  });

  it('a throwing listener neither blocks the others nor keeps the send pending', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', () => { throw new Error('boom'); });
    subscribePendingOwnSendSettled(ME, 'dm:bob', after);
    registerPendingOwnSend(ME, row('a'));

    expect(() => settlePendingOwnSend(ME, 'a', true)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
    warn.mockRestore();
  });
});

describe('change notifications', () => {
  it('reports an edit and its rollback with the message to show', () => {
    const bob = vi.fn();
    subscribePendingOwnSendChanged(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));
    const edited = { ...row('a'), content: 'edited', edited: true };

    updatePendingOwnSend(ME, edited);
    updatePendingOwnSend(ME, row('a'));

    expect(bob.mock.calls).toEqual([
      [{ owner: ME, threadId: 'dm:bob', id: 'a', message: edited }],
      [{ owner: ME, threadId: 'dm:bob', id: 'a', message: row('a') }],
    ]);
  });

  it('reports a hide as null and an un-hide with the message', () => {
    const bob = vi.fn();
    subscribePendingOwnSendChanged(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));

    setPendingOwnSendHidden(ME, 'a', true);
    setPendingOwnSendHidden(ME, 'a', false);

    expect(bob.mock.calls).toEqual([
      [{ owner: ME, threadId: 'dm:bob', id: 'a', message: null }],
      [{ owner: ME, threadId: 'dm:bob', id: 'a', message: row('a') }],
    ]);
  });

  it('is scoped to the account and thread, silent for ids that are not pending, and stops after unsubscribe', () => {
    const bob = vi.fn();
    const carol = vi.fn();
    const other = vi.fn();
    const off = subscribePendingOwnSendChanged(ME, 'dm:bob', bob);
    subscribePendingOwnSendChanged(ME, 'dm:carol', carol);
    subscribePendingOwnSendChanged(OTHER, 'dm:bob', other);

    setPendingOwnSendHidden(ME, 'ghost', true);
    updatePendingOwnSend(ME, row('ghost'));
    registerPendingOwnSend(ME, row('a'));
    setPendingOwnSendHidden(ME, 'a', true);
    off();
    setPendingOwnSendHidden(ME, 'a', false);

    expect(bob).toHaveBeenCalledTimes(1);
    expect(carol).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('a throwing change listener does not block the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    subscribePendingOwnSendChanged(ME, 'dm:bob', () => { throw new Error('boom'); });
    subscribePendingOwnSendChanged(ME, 'dm:bob', after);
    registerPendingOwnSend(ME, row('a'));
    expect(() => setPendingOwnSendHidden(ME, 'a', true)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reset drops change listeners too', () => {
    const bob = vi.fn();
    subscribePendingOwnSendChanged(ME, 'dm:bob', bob);
    _resetPendingOwnSends();
    registerPendingOwnSend(ME, row('a'));
    setPendingOwnSendHidden(ME, 'a', true);
    expect(bob).not.toHaveBeenCalled();
  });
});

describe('settle while an edit/delete of the send is publishing', () => {
  it('is held until the action ends, then applied with its outcome', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));
    expect(beginPendingOwnSendAction(ME, 'a')).toBe(true);

    settlePendingOwnSend(ME, 'a', true);
    expect(bob).not.toHaveBeenCalled();
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['a']);

    endPendingOwnSendAction(ME, 'a');
    expect(bob).toHaveBeenCalledWith({ owner: ME, threadId: 'dm:bob', id: 'a', replacedIds: [], persisted: true });
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
  });

  it('waits for the last of overlapping actions and keeps a failed outcome', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));
    beginPendingOwnSendAction(ME, 'a');
    beginPendingOwnSendAction(ME, 'a');
    settlePendingOwnSend(ME, 'a', false);

    endPendingOwnSendAction(ME, 'a');
    expect(bob).not.toHaveBeenCalled();
    endPendingOwnSendAction(ME, 'a');
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', persisted: false }));
  });

  it('an action that ends before any settle leaves the send pending, and a later settle applies at once', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));
    beginPendingOwnSendAction(ME, 'a');
    endPendingOwnSendAction(ME, 'a');
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['a']);

    settlePendingOwnSend(ME, 'a', true);
    expect(bob).toHaveBeenCalledTimes(1);
  });

  it('a held action survives the image id swap', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('temp'));
    beginPendingOwnSendAction(ME, 'temp');
    replacePendingOwnSend(ME, 'temp', row('event'));
    settlePendingOwnSend(ME, 'event', true);
    expect(bob).not.toHaveBeenCalled();
    // The action ends under the id it began with (the temp id): that releases the settle.
    endPendingOwnSendAction(ME, 'temp');
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ id: 'event', replacedIds: ['temp'] }));
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
  });

  it('hide and update under the temp id reach the entry after the swap; the alias goes with the settle', () => {
    registerPendingOwnSend(ME, row('temp'));
    replacePendingOwnSend(ME, 'temp', row('event'));
    setPendingOwnSendHidden(ME, 'temp', true);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'event', threadId: 'dm:bob', message: null, replacedIds: ['temp'] }]);
    settlePendingOwnSend(ME, 'temp', true);
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([]);
    registerPendingOwnSend(ME, row('temp'));
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['temp']);
  });

  it('begin is false for an id that is not pending; end is then a no-op', () => {
    expect(beginPendingOwnSendAction(ME, 'ghost')).toBe(false);
    expect(() => endPendingOwnSendAction(ME, 'ghost')).not.toThrow();
    registerPendingOwnSend(ME, row('a'));
    endPendingOwnSendAction(ME, 'a');
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    settlePendingOwnSend(ME, 'a', true);
    expect(bob).toHaveBeenCalledTimes(1);
  });
});

describe('image id swap', () => {
  it('tells views at once: the temp row goes, the final row comes', () => {
    const bob = vi.fn();
    subscribePendingOwnSendChanged(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('temp'));
    replacePendingOwnSend(ME, 'temp', row('event'));
    expect(bob.mock.calls).toEqual([
      [{ owner: ME, threadId: 'dm:bob', id: 'temp', message: null }],
      [{ owner: ME, threadId: 'dm:bob', id: 'event', message: row('event') }],
    ]);
  });

  it('chained swaps keep every earlier id', () => {
    registerPendingOwnSend(ME, row('t1'));
    replacePendingOwnSend(ME, 't1', row('t2'));
    replacePendingOwnSend(ME, 't2', row('event'));
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'event', threadId: 'dm:bob', message: row('event'), replacedIds: ['t1', 't2'] }]);
    expect(beginPendingOwnSendAction(ME, 't1')).toBe(true);
  });
});

describe('aliases and replace edge cases', () => {
  it('a swap of one image does not redirect another image\'s alias, and settling one keeps the other\'s', () => {
    registerPendingOwnSend(ME, row('tA'));
    registerPendingOwnSend(ME, row('tB'));
    replacePendingOwnSend(ME, 'tA', row('eA'));
    replacePendingOwnSend(ME, 'tB', row('eB'));
    settlePendingOwnSend(ME, 'eA', true);

    expect(beginPendingOwnSendAction(ME, 'tB')).toBe(true);
    expect(ids(pendingOwnSendsFor(ME, 'dm:bob'))).toEqual(['eB']);
  });

  it('each temp id keeps pointing at its own image after another image swaps', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('tA'));
    registerPendingOwnSend(ME, row('tB'));
    replacePendingOwnSend(ME, 'tA', row('eA'));
    replacePendingOwnSend(ME, 'tB', row('eB'));

    beginPendingOwnSendAction(ME, 'tA');
    settlePendingOwnSend(ME, 'eA', true);
    expect(bob).not.toHaveBeenCalled();
    settlePendingOwnSend(ME, 'eB', true);
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ id: 'eB' }));
  });

  it('after a settle the old temp id is free again', () => {
    registerPendingOwnSend(ME, row('temp'));
    replacePendingOwnSend(ME, 'temp', row('event'));
    settlePendingOwnSend(ME, 'event', true);
    registerPendingOwnSend(ME, row('temp'));
    expect(beginPendingOwnSendAction(ME, 'temp')).toBe(true);
  });

  it('replacing an id that is not pending registers the final row with the earlier id', () => {
    replacePendingOwnSend(ME, 'unknown', row('event'));
    expect(pendingOwnSendsFor(ME, 'dm:bob')).toEqual([{ id: 'event', threadId: 'dm:bob', message: row('event'), replacedIds: ['unknown'] }]);
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    settlePendingOwnSend(ME, 'event', true);
    expect(bob).toHaveBeenCalledTimes(1);
  });

  it('a settle held before the swap is applied after it, when the action ends', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('temp'));
    beginPendingOwnSendAction(ME, 'temp');
    settlePendingOwnSend(ME, 'temp', false);
    replacePendingOwnSend(ME, 'temp', row('event'));
    expect(bob).not.toHaveBeenCalled();
    endPendingOwnSendAction(ME, 'temp');
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ id: 'event', persisted: false }));
  });

  it('a held persisted settle also survives the swap', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('temp'));
    beginPendingOwnSendAction(ME, 'temp');
    settlePendingOwnSend(ME, 'temp', true);
    replacePendingOwnSend(ME, 'temp', row('event'));
    endPendingOwnSendAction(ME, 'event');
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ id: 'event', persisted: true }));
  });

  it('an end without a begin does not unbalance a later action', () => {
    const bob = vi.fn();
    subscribePendingOwnSendSettled(ME, 'dm:bob', bob);
    registerPendingOwnSend(ME, row('a'));
    endPendingOwnSendAction(ME, 'a');
    beginPendingOwnSendAction(ME, 'a');
    settlePendingOwnSend(ME, 'a', true);
    expect(bob).not.toHaveBeenCalled();
    endPendingOwnSendAction(ME, 'a');
    expect(bob).toHaveBeenCalledTimes(1);
  });
});
