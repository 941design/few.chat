// @vitest-environment node
/**
 * Retention of a slot's pre-edit state (`ChatMessage.original`).
 *
 * The write-once base exists so a withdrawn history row can be recomputed away. It is therefore captured ONLY where
 * a recompute can use it: every GROUP-thread signal write (sink-delivered and own optimistic: the optimistic write
 * mutates the row before its echo). A DM thread keeps no copy of the pre-edit / pre-delete content.
 *
 * Real collaborators: chatPersistence, messageEdits/api, the sink and dispatcher (realApp.ts) over fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import * as edits from '@/src/lib/messageEdits/api';
import { ALICE, BOB, buildRealApp, ev, installLocalStorage, nextGroupId, SELF, type RealApp } from './realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  await edits.clearAllMessageEditsState();
});
afterEach(async () => {
  for (const app of apps) await app.sink.dispose();
});

const T = 1_700_000_000;
const sender = { pubkey: ALICE, authenticity: 'mls' as const };
const baseRow = (groupId: string): chat.ChatMessage => ({ id: 'm1', content: 'secret original', senderPubkey: ALICE, groupId, createdAt: T * 1000 });
const editRumor = (kind: number) => ({
  id: 'edit1',
  pubkey: ALICE,
  created_at: T + 10,
  kind,
  tags: [['e', 'm1', '', 'edit'], ['rev', String(T + 10)]],
  content: 'replacement',
});
const deleteRumor = () => ({ id: 'del1', pubkey: ALICE, created_at: T + 10, kind: 5, tags: [['e', 'm1']], content: '' });
const rowOf = async (threadKey: string) => (await chat.loadMessages(threadKey)).messages.find((m) => m.id === 'm1');

describe('group thread, signal from the history sink (sender present)', () => {
  it('an edit keeps the base so a recompute can reset the slot', async () => {
    const g = nextGroupId();
    await chat.appendMessage(g, baseRow(g));
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: g }, editRumor(9), sender);
    expect(await rowOf(g)).toMatchObject({ content: 'replacement', edited: true, original: { content: 'secret original' } });
  });

  it('a delete keeps the base too', async () => {
    const g = nextGroupId();
    await chat.appendMessage(g, baseRow(g));
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: g }, deleteRumor(), sender);
    expect(await rowOf(g)).toMatchObject({ tombstoned: true, original: { content: 'secret original' } });
  });

  it('through the real sink, an edit row delivered by a member is recomputable (original kept)', async () => {
    const app = buildRealApp();
    apps.push(app);
    await app.sink.append(app.entry({ eventId: 'eb', account: ALICE, rumorId: 'm1', content: 'secret original', at: T }));
    await app.sink.append(
      app.entry({ eventId: 'e1', kind: 9, account: ALICE, rumorId: 'edit1', content: 'replacement', tags: editRumor(9).tags, at: T + 10 }),
    );
    expect((await app.messages()).find((m) => m.id === 'm1')?.original?.content).toBe('secret original');
  });
});

describe('own optimistic write in a group thread (the local account as sender)', () => {
  it('captures the base too (the optimistic write precedes its echo)', async () => {
    const g = nextGroupId();
    await chat.appendMessage(g, baseRow(g));
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: g }, editRumor(9), { pubkey: ALICE, authenticity: 'claimed' });
    expect((await rowOf(g))?.original).toEqual({ content: 'secret original' });
  });

  it('AC-WDR-2: own optimistic edit, echo through the sink, withdraw of the echo -> the true original', async () => {
    const app = buildRealApp();
    apps.push(app);
    await app.sink.append(app.entry({ eventId: 'eb', account: SELF, rumorId: 'm1', content: 'secret original', at: T }));
    const echo = app.entry({ eventId: 'e1', kind: 9, account: SELF, rumorId: 'edit1', content: 'replacement', tags: editRumor(9).tags, at: T + 10 });
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: app.groupId }, { ...editRumor(9), pubkey: SELF }, { pubkey: SELF, authenticity: 'claimed' });
    expect((await app.messages()).find((m) => m.id === 'm1')?.content).toBe('replacement');
    await app.sink.append(echo);
    await app.sink.withdraw(app.groupId, ev('e1'));
    const row = (await app.messages()).find((m) => m.id === 'm1');
    expect(row?.content).toBe('secret original');
    expect(row?.edited).toBeUndefined();
  });

  it('AC-WDR-2: own optimistic delete, echo, withdraw -> message restored', async () => {
    const app = buildRealApp();
    apps.push(app);
    await app.sink.append(app.entry({ eventId: 'eb', account: SELF, rumorId: 'm1', content: 'secret original', at: T }));
    const echo = app.entry({ eventId: 'd1', kind: 5, account: SELF, rumorId: 'del1', content: '', tags: [['e', 'm1']], at: T + 10 });
    await edits.applyDeleteEditSignal({ kind: 'group', groupId: app.groupId }, { ...deleteRumor(), pubkey: SELF }, { pubkey: SELF, authenticity: 'claimed' });
    expect((await app.messages()).find((m) => m.id === 'm1')?.tombstoned).toBe(true);
    await app.sink.append(echo);
    await app.sink.withdraw(app.groupId, ev('d1'));
    const row = (await app.messages()).find((m) => m.id === 'm1');
    expect(row?.tombstoned).toBeFalsy();
    expect(row?.content).toBe('secret original');
  });
});

describe('DM thread', () => {
  const peer = BOB;
  const dm = `dm:${peer}`;
  const thread = { kind: 'dm' as const, peerPubkeyHex: peer };

  it('an edit applies but retains no pre-edit copy', async () => {
    await chat.appendMessage(dm, baseRow(dm));
    await edits.applyDeleteEditSignal(thread, editRumor(14));
    const row = await rowOf(dm);
    expect(row).toMatchObject({ content: 'replacement', edited: true });
    expect(row?.original).toBeUndefined();
  });

  it('a delete applies but retains no pre-delete copy', async () => {
    await chat.appendMessage(dm, baseRow(dm));
    await edits.applyDeleteEditSignal(thread, deleteRumor());
    const row = await rowOf(dm);
    expect(row?.tombstoned).toBe(true);
    expect(row?.original).toBeUndefined();
  });
});

describe('store primitives', () => {
  const rows = [{ id: 'm1', content: 'a', senderPubkey: ALICE, groupId: 'g', createdAt: 1 }] satisfies chat.ChatMessage[];

  it('mergePatchCore / mergeTombstone capture by default and skip the capture on request', () => {
    const patch = { content: 'b', edited: true, rev: 5 };
    expect(chat.mergePatchCore(rows, 'm1', patch)?.[0].original).toEqual({ content: 'a' });
    expect(chat.mergePatchCore(rows, 'm1', patch, { captureOriginal: false })?.[0].original).toBeUndefined();
    expect(chat.mergeTombstone(rows, 'm1', 5, true)?.[0].original).toEqual({ content: 'a' });
    expect(chat.mergeTombstone(rows, 'm1', 5, true, false)?.[0].original).toBeUndefined();
  });
});
