// @vitest-environment node
/**
 * Withdrawn delete / edit signals (AC-WDR-2, own or another member's), at the store level: the slot is RECOMPUTED
 * from the remaining signals (messageEdits `recomputeSlot`), so the thread ends exactly as if the withdrawn signal had
 * never arrived. The sink-level oracle matrix (appends, withdraws in any order, forged copies, ...) is
 * slotRecompute.test.ts; this file pins the store contract with concrete cases.
 *
 * Real collaborators: chatPersistence, the edit reconciliation core and the app HistoryBackend over fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import { createGroupRumorDispatch } from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createDeleteEditGroupHandler } from '@/src/lib/marmot/handlers/deleteEditHandler';
import { appendMessage, loadMessages, type ChatMessage } from '@/src/lib/marmot/chatPersistence';
import {
  applyDeleteEditSignal,
  clearAllMessageEditsState,
  PENDING_SIGNAL_TTL_MS,
  recomputeSlot,
  resolvePendingSignalsForSlot,
  snapshotMessageEditsState,
  type InboundDeleteEditRumor,
  type MessageEditsThreadKey,
} from '@/src/lib/messageEdits/api';
import type { AuthenticatedSender, RecomputeSignal } from '@/src/lib/marmot/handlers/types';

const SELF = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const sender = (pubkey: string): AuthenticatedSender => ({ pubkey, authenticity: 'mls' });

let counter = 0;
let G: string;
let thread: MessageEditsThreadKey;
// Revs are real unix seconds in the past: a future one would be capped (pinned) by the core.
const T0 = Math.floor(Date.now() / 1000) - 10_000;

beforeEach(async () => {
  await clearAllMessageEditsState();
  G = (++counter + 0x40).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
  thread = { kind: 'group', groupId: G };
});
afterEach(() => vi.useRealTimers());

const original = (id: string, author = BOB, content = 'original'): ChatMessage => ({
  id,
  content,
  senderPubkey: author,
  groupId: G,
  createdAt: 1_700_000_000_000,
});
const del = (id: string, target: string | string[], rev: number): InboundDeleteEditRumor => ({
  id,
  pubkey: 'ee'.repeat(32), // never read: attribution is the sender
  created_at: rev,
  kind: 5,
  tags: (Array.isArray(target) ? target : [target]).map((t) => ['e', t]),
  content: '',
});
const edit = (id: string, target: string, rev: number, content: string): InboundDeleteEditRumor => ({
  id,
  pubkey: 'ee'.repeat(32),
  created_at: rev,
  kind: 9,
  tags: [['e', target, '', 'edit'], ['rev', String(rev)]],
  content,
});
const row = async (id: string) => (await loadMessages(G)).messages.find((m) => m.id === id)!;
const apply = (r: InboundDeleteEditRumor, who = BOB) => applyDeleteEditSignal(thread, r, sender(who));

/** The signals still in history, as the sink hands them to a recompute (seq = position, the row's own receipt clock = now). */
const remaining = (...signals: [InboundDeleteEditRumor, string?][]): RecomputeSignal[] =>
  signals.map(([rumor, who], i) => ({ rumor, sender: who ?? BOB, eventId: `ev-${rumor.id}`, seq: i + 1, receivedAt: Date.now() }));
/** The retract of `withdrawn` while `rest` remain. */
const retract = (slots: string[], withdrawn: InboundDeleteEditRumor, ...rest: [InboundDeleteEditRumor, string?][]) =>
  recomputeSlot(thread, slots, remaining(...rest), { withdrawnRumorIds: [withdrawn.id] });
const markers = async () =>
  ((await idbGet<{ targetId: string; threadKey: string }[]>('few:messageEditsDeleteMarkers:v1')) ?? []).filter((m) => m.threadKey === G);

describe('a withdrawn delete', () => {
  it('makes the row visible again with the rev it had before', async () => {
    await appendMessage(G, original('m1'));
    await apply(del('d1', 'm1', T0));
    expect((await row('m1')).tombstoned).toBe(true);
    await retract(['m1'], del('d1', 'm1', T0));
    const r = await row('m1');
    expect(r.tombstoned).toBeUndefined();
    expect(r.rev).toBeUndefined();
    expect(r.original).toBeUndefined();
    expect(r.content).toBe('original');
  });

  it('the row can then be deleted again by a later signal (the slot meta no longer blocks it)', async () => {
    await appendMessage(G, original('m1'));
    await apply(del('d1', 'm1', T0));
    await retract(['m1'], del('d1', 'm1', T0));
    await apply(del('d2', 'm1', T0 + 5));
    expect((await row('m1')).tombstoned).toBe(true);
  });

  it('AC-WDR-2: the own delete withdrawn restores the own message', async () => {
    await appendMessage(G, original('m1', SELF));
    await apply(del('d1', 'm1', T0), SELF);
    await retract(['m1'], del('d1', 'm1', T0));
    expect((await row('m1')).tombstoned).toBeUndefined();
  });

  it('is idempotent; an unseen signal or one naming no slot changes nothing', async () => {
    await appendMessage(G, original('m1'));
    await apply(del('d1', 'm1', T0));
    await retract(['m1'], del('d1', 'm1', T0));
    const once = { row: await row('m1'), aux: await snapshotMessageEditsState(G) };
    await retract(['m1'], del('d1', 'm1', T0));
    await retract(['m1'], del('never-seen', 'm1', T0 + 1));
    await recomputeSlot(thread, [], remaining([del('d9', 'm1', T0)]));
    await recomputeSlot(thread, ['elsewhere'], remaining([del('d9', 'm1', T0)]));
    expect({ row: await row('m1'), aux: await snapshotMessageEditsState(G) }).toEqual(once);
  });

  it('a delete that survives in history is re-applied by the recompute (only the withdrawn one goes)', async () => {
    await appendMessage(G, original('m1'));
    await apply(del('d1', 'm1', T0));
    await apply(del('d2', 'm1', T0 + 5));
    await retract(['m1'], del('d2', 'm1', T0 + 5), [del('d1', 'm1', T0)]);
    expect(await row('m1')).toMatchObject({ tombstoned: true, rev: T0 });
  });
});

describe('a withdrawn edit', () => {
  it('restores the original content', async () => {
    await appendMessage(G, original('m1'));
    await apply(edit('e1', 'm1', T0, 'changed'));
    expect(await row('m1')).toMatchObject({ content: 'changed', edited: true });
    await retract(['m1'], edit('e1', 'm1', T0, 'changed'));
    const r = await row('m1');
    expect(r.content).toBe('original');
    expect(r.edited).toBeUndefined();
    expect(r.rev).toBeUndefined();
  });

  it('withdrawn after an earlier edit: back to the earlier edit, which the slot recorded as its winner again', async () => {
    await appendMessage(G, original('m1'));
    await apply(edit('e1', 'm1', T0, 'first'));
    await apply(edit('e2', 'm1', T0 + 10, 'second'));
    await retract(['m1'], edit('e2', 'm1', T0 + 10, 'second'), [edit('e1', 'm1', T0, 'first')]);
    expect(await row('m1')).toMatchObject({ content: 'first', edited: true, rev: T0 });
    expect((await apply(edit('e1', 'm1', T0, 'first'))).kind).toBe('noop');
  });

  it('an edit over a delete: withdrawing the edit brings the delete back', async () => {
    await appendMessage(G, original('m1'));
    await apply(del('d1', 'm1', T0));
    await apply(edit('e1', 'm1', T0 + 10, 'revived'));
    expect(await row('m1')).toMatchObject({ content: 'revived', tombstoned: false });
    await retract(['m1'], edit('e1', 'm1', T0 + 10, 'revived'), [del('d1', 'm1', T0)]);
    expect(await row('m1')).toMatchObject({ content: 'original', tombstoned: true, rev: T0 });
  });

  it('a superseded signal withdrawn leaves the winner untouched', async () => {
    await appendMessage(G, original('m1'));
    await apply(edit('e1', 'm1', T0, 'first'));
    await apply(edit('e2', 'm1', T0 + 10, 'second'));
    await retract(['m1'], edit('e1', 'm1', T0, 'first'), [edit('e2', 'm1', T0 + 10, 'second')]);
    expect(await row('m1')).toMatchObject({ content: 'second', edited: true, rev: T0 + 10 });
  });

  it('the base survives recomputes: edited once, recomputed twice, the original content is still the base', async () => {
    await appendMessage(G, original('m1'));
    await apply(edit('e1', 'm1', T0, 'first'));
    await apply(edit('e2', 'm1', T0 + 10, 'second'));
    await retract(['m1'], edit('e2', 'm1', T0 + 10, 'second'), [edit('e1', 'm1', T0, 'first')]);
    await retract(['m1'], edit('e1', 'm1', T0, 'first'));
    expect(await row('m1')).toMatchObject({ content: 'original' });
  });

  it('a row edited before the write-once base existed (no `original`) keeps its state: it has nothing to reset to', async () => {
    await appendMessage(G, original('m1'));
    await apply(edit('e1', 'm1', T0, 'changed'));
    const rows = (await idbGet<Record<string, unknown>[]>(`few:messages:${G}`))!;
    await idbSet(`few:messages:${G}`, rows.map(({ original: _o, ...rest }) => rest));
    await retract(['m1'], edit('e1', 'm1', T0, 'changed'));
    expect(await row('m1')).toMatchObject({ content: 'changed', edited: true });
  });
});

describe('signals that never reached a row', () => {
  it('a buffered signal withdrawn is not applied when its target lands', async () => {
    expect((await apply(del('d1', 'm1', T0))).kind).toBe('pending');
    await retract(['m1'], del('d1', 'm1', T0));
    await appendMessage(G, original('m1'));
    await resolvePendingSignalsForSlot(thread, 'm1', BOB);
    expect((await row('m1')).tombstoned).toBeUndefined();
  });

  it('a buffered edit withdrawn is not applied when its target lands; a surviving one is', async () => {
    await apply(edit('e1', 'm1', T0, 'changed'));
    await apply(edit('e2', 'm1', T0 + 10, 'newer'));
    await retract(['m1'], edit('e2', 'm1', T0 + 10, 'newer'), [edit('e1', 'm1', T0, 'changed')]);
    await appendMessage(G, original('m1'));
    await resolvePendingSignalsForSlot(thread, 'm1', BOB);
    expect((await row('m1')).content).toBe('changed'); // the older edit the newer one had shadowed in the buffer is held again
  });

  it("drops the delete marker of a recomputed slot and keeps every other slot's", async () => {
    await idbSet('few:messageEditsDeleteMarkers:v1', [
      { threadKey: G, targetId: 'm1', rev: T0, authorPubkeyHex: BOB.toUpperCase(), receivedAt: 1 },
      { threadKey: G, targetId: 'm2', rev: T0, authorPubkeyHex: SELF, receivedAt: 2 },
      { threadKey: G, targetId: 'm3', rev: T0, authorPubkeyHex: BOB, receivedAt: 3 },
    ]);
    await retract(['m1', 'm2'], del('d1', ['m1', 'm2'], T0));
    expect((await markers()).map((m) => m.targetId)).toEqual(['m3']);
    await appendMessage(G, original('m1'));
    await resolvePendingSignalsForSlot(thread, 'm1', BOB);
    expect((await row('m1')).tombstoned).toBeUndefined();
  });

  it('a placeholder fabricated from an expired edit is removed, and the surviving edit is held again (not shown)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await apply(edit('e1', 'm1', T0, 'orphan edit'));
    vi.setSystemTime(Date.now() + PENDING_SIGNAL_TTL_MS + 1000);
    await apply(del('unrelated', 'other', T0)); // any thread activity runs the TTL sweep
    expect(await row('m1')).toMatchObject({ content: 'orphan edit', materializedFromEdit: true });

    await retract(['m1'], edit('gone', 'm1', T0 + 1, 'x'), [edit('e1', 'm1', T0, 'orphan edit')]);

    expect(await row('m1')).toBeUndefined();
    expect(((await snapshotMessageEditsState(G)) as { pending: { targetId: string }[] }).pending.map((p) => p.targetId)).toContain('m1');
    await retract(['m1'], edit('e1', 'm1', T0, 'orphan edit'));
    expect(((await snapshotMessageEditsState(G)) as { pending: { targetId: string }[] }).pending.map((p) => p.targetId)).not.toContain('m1');
  });
});

describe('through the history backend', () => {
  let sink: AppHistoryBackend | undefined;
  afterEach(async () => {
    await sink?.dispose();
    sink = undefined;
  });

  it('a withdrawn kind-5 delete shows the message again and bumps the chat version', async () => {
    let chatVersion = 0;
    const handler = createDeleteEditGroupHandler({
      applyDeleteEditSignal,
      setChatVersion: (u) => void (chatVersion = u(chatVersion)),
      recomputeSlot,
    });
    const dispatcher = createGroupRumorDispatch({ handlers: [handler], env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } });
    sink = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`de-${G}`) });
    await appendMessage(G, original('m1'));
    const entry: HistoryEntry = {
      groupId: G,
      eventId: 'e1',
      rumor: { ...del('d1', 'm1', T0), pubkey: BOB },
      orderingKey: { account: BOB, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
    };
    await sink.append(entry);
    expect((await row('m1')).tombstoned).toBe(true);
    const bumped = chatVersion;
    await sink.withdraw(G, ['e1']);
    expect((await row('m1')).tombstoned).toBeUndefined();
    expect(chatVersion).toBeGreaterThan(bumped);
  });

  it('a purged retract bumps the version but folds nothing', async () => {
    let chatVersion = 0;
    const recompute = vi.fn(recomputeSlot);
    const handler = createDeleteEditGroupHandler({ applyDeleteEditSignal, setChatVersion: (u) => void (chatVersion = u(chatVersion)), recomputeSlot: recompute });
    await handler.retract(
      { groupId: G, eventId: 'e1', rumor: del('d1', 'm1', T0), sender: BOB, reason: 'purged', remaining: () => Promise.reject(new Error('must not read history')) } as never,
      { selfPubkeyHex: SELF, getActiveGroupId: () => null },
    );
    expect(recompute).not.toHaveBeenCalled();
    expect(chatVersion).toBe(1);
  });
});
