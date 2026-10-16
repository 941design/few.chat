/**
 * A leave intent whose durable removal write fails is NOT acked from the rumor
 * journal, and the removal lands after a reload (bugs:
 * journal-ack-before-durable-side-effects, journal-replayed-leave-evicts-rejoined-member).
 *
 * Real pieces end to end: rumorJournal and pendingRemovalStorage over
 * fake-indexeddb, the dispatcher, the leave handler, and MarmotContext's
 * enqueue shape (identity from the journal, else the current leaf; record +
 * durable mirror). Only the MLS payload decoding is stubbed (JSON bytes).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
}));

const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { createLeaveIntentHandler } = await import('@/src/lib/marmot/handlers/leaveHandler');
const journal = await import('@/src/lib/marmot/rumorJournal');
const storage = await import('@/src/lib/marmot/pendingRemovalStorage');
type Rec = import('@/src/lib/marmot/pendingRemovalStorage').PendingRemovalRecord;

const GROUP = 'G1';
const MEMBER = 'dd'.repeat(32);
const SELF = 'ee'.repeat(32);
const ctx = { groupId: GROUP, selfPubkeyHex: SELF, getActiveGroupId: () => null };
const DAY = 24 * 60 * 60 * 1000;
const JOURNALED_ID = '01:02'; // the member's leaf when the leave was sent
const CURRENT_ID = '07:08'; // the member's leaf now (re-joined)

const leaveBytes = (id: string) =>
  new TextEncoder().encode(JSON.stringify({ id, pubkey: MEMBER, kind: 13, created_at: 1, tags: [], content: JSON.stringify({ pubkey: MEMBER }) }));

/** One page session: a fresh dispatcher (+ by default a fresh in-memory queue), wired like MarmotContext. */
function session(
  put?: (r: Rec) => Promise<void>,
  opts: { queue?: Map<string, Rec[]>; lookup?: typeof journal.getJournaledSenderLeafIdentity; captureCurrent?: () => Promise<string | undefined> } = {},
) {
  const queue = opts.queue ?? new Map<string, Rec[]>();
  const lookup = opts.lookup ?? journal.getJournaledSenderLeafIdentity;
  const captureCurrent = opts.captureCurrent ?? (async () => CURRENT_ID);
  // MarmotContext.enqueueLeave.
  const enqueueLeave = (groupId: string, pubkey: string, rumorId: string, meta: { replayed: boolean }) =>
    storage.recordLeaveIntent({
      queue, groupId, pubkey, replayed: meta.replayed, now: Date.now(),
      readJournal: () => lookup(groupId, rumorId), captureCurrent, arm: () => {}, put,
    });
  const dispatcher = createDispatcher([createLeaveIntentHandler({ enqueueLeave })], {
    journal: { ack: journal.ackRumor, recordFailure: journal.recordRumorFailure },
    maxFailedAttempts: journal.RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS,
  });
  const listeners = new Map<string, (p: unknown) => unknown>();
  const group = {
    on: (e: string, fn: (p: unknown) => unknown) => { listeners.set(e, fn); },
    off: (e: string) => { listeners.delete(e); },
    /** A LIVE delivery through the library event. */
    deliver: (id: string) => listeners.get('authenticatedApplicationMessage')?.({ message: leaveBytes(id), senderPubkey: MEMBER, senderLeafIndex: 0 }),
  };
  const sub = dispatcher.subscribe(group as never, ctx);
  const replayPending = async () => sub.replay(await journal.listPendingRumors(GROUP));
  return { queue, sub, replayPending, group };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await journal.clearAllRumorJournal();
  await storage.clearAllPendingRemovals();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('leave intent: durable removal write fails → journal keeps it → applied after reload', () => {
  it('a failing pending-removal write leaves the journal entry; the next session stores the removal with the journaled identity and acks it', async () => {
    // Ingest journaled the leave with the sender's leaf identity at its epoch.
    await journal.putRumor({ groupId: GROUP, rumorId: 'L1', senderPubkey: MEMBER, data: leaveBytes('L1'), senderLeafIdentity: JOURNALED_ID });

    const s1 = session(async () => { throw new Error('QuotaExceeded'); });
    await s1.replayPending();
    // In memory the removal is queued (this session still commits it) …
    expect(s1.queue.get(GROUP)?.map((e) => e.pubkey)).toEqual([MEMBER]);
    // … but nothing durable landed, so the leave stays journaled.
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    expect((await journal.listPendingRumors(GROUP)).map((e) => e.rumorId)).toEqual(['L1']);
    s1.sub();

    // Reload: the journal replays the leave; this time the write lands.
    const s2 = session();
    await s2.replayPending();
    expect(await storage.listPendingRemovals(GROUP)).toEqual([
      expect.objectContaining({ groupId: GROUP, pubkey: MEMBER, leafIdentity: JOURNALED_ID }),
    ]);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);

    // Next subscription start on an admin device re-arms it for the auto-commit.
    const queue = new Map<string, Rec[]>();
    const arm = vi.fn();
    const resumed = await storage.resumePendingRemovals({ groupId: GROUP, isAdmin: true, now: Date.now(), maxAgeMs: 30 * DAY, queue, arm });
    expect(resumed.map((r) => [r.pubkey, r.leafIdentity])).toEqual([[MEMBER, JOURNALED_ID]]);
    expect(arm).toHaveBeenCalledWith(GROUP);
  });

  it('a successful write acks the leave at once (the replay finds nothing)', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'L2', senderPubkey: MEMBER, data: leaveBytes('L2'), senderLeafIdentity: JOURNALED_ID });
    const s1 = session();
    await s1.replayPending();
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
    expect((await storage.listPendingRemovals(GROUP)).map((r) => r.leafIdentity)).toEqual([JOURNALED_ID]);
  });

  it('a REPLAYED leave journaled without an identity (incl. an older version\'s row) is skipped and acked, never checked against the current leaf', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'L3', senderPubkey: MEMBER, data: leaveBytes('L3') });
    const s1 = session();
    await s1.replayPending();
    expect(s1.queue.size).toBe(0);
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
  });
});

describe('remediation round 1', () => {
  const failingPut = async () => { throw new Error('QuotaExceeded'); };

  it('a failed put, then a re-subscribe replay on the SAME in-memory queue: the entry survives until the row actually lands', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'L1', senderPubkey: MEMBER, data: leaveBytes('L1'), senderLeafIdentity: JOURNALED_ID });
    const queue = new Map<string, Rec[]>();
    const s1 = session(failingPut, { queue });
    await s1.replayPending();
    s1.sub();
    // Same page, re-subscribe: the queue already holds the member (a duplicate).
    const s2 = session(failingPut, { queue });
    await s2.replayPending();
    s2.sub();
    expect((await journal.listPendingRumors(GROUP)).map((e) => e.rumorId)).toEqual(['L1']);
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    // The write finally lands: the duplicate's re-put stores the queued entry, then the ack.
    const s3 = session(undefined, { queue });
    await s3.replayPending();
    expect(await storage.listPendingRemovals(GROUP)).toEqual([expect.objectContaining({ pubkey: MEMBER, leafIdentity: JOURNALED_ID })]);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
  });

  it('failure injection: an unreadable journal identity on replay keeps the entry and queues NOTHING with the current leaf; the next replay uses the journaled identity', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'L4', senderPubkey: MEMBER, data: leaveBytes('L4'), senderLeafIdentity: JOURNALED_ID });
    const s1 = session(undefined, { lookup: async () => { throw new Error('idb read'); } });
    await s1.replayPending();
    s1.sub();
    expect(s1.queue.size).toBe(0);
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    expect((await journal.listPendingRumors(GROUP)).map((e) => e.rumorId)).toEqual(['L4']);
    await session().replayPending();
    expect((await storage.listPendingRemovals(GROUP)).map((r) => r.leafIdentity)).toEqual([JOURNALED_ID]);
  });

  it('poison: a rumor that fails on every attempt is dropped after RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS subscriptions, warned with kind and id', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'P1', senderPubkey: MEMBER, data: leaveBytes('P1'), senderLeafIdentity: JOURNALED_ID });
    for (let i = 1; i < journal.RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS; i++) {
      const s = session(failingPut);
      await s.replayPending();
      s.sub();
      expect((await journal.listPendingRumors(GROUP)).map((e) => [e.rumorId, e.attempts])).toEqual([['P1', i]]);
    }
    const last = session(failingPut);
    await last.replayPending();
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('poisonRumor'), expect.objectContaining({ kind: 13, rumorId: 'P1', attempts: 5 }));
  });

  it('recordRumorFailure: counts on the row in one transaction; 0 (and nothing written) without a row', async () => {
    expect(await journal.recordRumorFailure(GROUP, 'none')).toBe(0);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
    await journal.putRumor({ groupId: GROUP, rumorId: 'C1', senderPubkey: MEMBER, data: leaveBytes('C1') });
    expect(await journal.recordRumorFailure(GROUP, 'C1')).toBe(1);
    expect(await journal.recordRumorFailure(GROUP, 'C1')).toBe(2);
    // A re-journal keeps the count (read-merge-put).
    await journal.putRumor({ groupId: GROUP, rumorId: 'C1', senderPubkey: MEMBER, data: leaveBytes('C1') });
    expect(await journal.recordRumorFailure(GROUP, 'C1')).toBe(3);
  });
});

describe('remediation round 2: replay-aware leave identity', () => {
  it('journaled leave WITHOUT an identity → the member re-joins → replay: NOT removed (nothing queued) and the row is acked', async () => {
    // Ingest could not determine the identity (e.g. the epoch tree was gone).
    await journal.putRumor({ groupId: GROUP, rumorId: 'R1', senderPubkey: MEMBER, data: leaveBytes('R1') });
    // Next session; the member has re-joined, so the current leaf is the new one.
    const s = session(undefined, { captureCurrent: async () => CURRENT_ID });
    await s.replayPending();
    expect(s.queue.size).toBe(0);
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`replayed leave of ${MEMBER} in group ${GROUP}`));
  });

  it('live counterpart: no journaled identity and the current capture FAILS → a pubkey-only removal is queued (the in-session commit removes the member) and the leave is acked', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'R2', senderPubkey: MEMBER, data: leaveBytes('R2') });
    const s = session(undefined, { captureCurrent: async () => { throw new Error('group not loaded'); } });
    s.group.deliver('R2');
    await s.sub.drain();
    expect(s.queue.get(GROUP)).toEqual([expect.objectContaining({ pubkey: MEMBER })]);
    expect(s.queue.get(GROUP)![0].leafIdentity).toBeUndefined();
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
  });

  it('a live delivery with a journaled identity uses it, the same as its replay', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'R3', senderPubkey: MEMBER, data: leaveBytes('R3'), senderLeafIdentity: JOURNALED_ID });
    const s = session();
    s.group.deliver('R3');
    await s.sub.drain();
    expect((await storage.listPendingRemovals(GROUP)).map((r) => r.leafIdentity)).toEqual([JOURNALED_ID]);
  });
});

describe('leave without a journaled identity: a replay never evicts (finding leave-fallback-identity-writeback, rejected)', () => {
  it('identity-less row, LIVE leave captures an identity, the removal persist fails → the replay does NOT remove (skipped and acked)', async () => {
    await journal.putRumor({ groupId: GROUP, rumorId: 'W1', senderPubkey: MEMBER, data: leaveBytes('W1') });
    const s1 = session(async () => { throw new Error('QuotaExceeded'); }, { captureCurrent: async () => CURRENT_ID });
    s1.group.deliver('W1');
    await s1.sub.drain();
    s1.sub();
    // The live capture is never written onto the journal row: it may be a
    // re-joined membership's leaf, not the one that sent the leave.
    expect(await journal.getJournaledSenderLeafIdentity(GROUP, 'W1')).toEqual({ journaled: true });
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);

    const captureAgain = vi.fn(async () => CURRENT_ID);
    const s2 = session(undefined, { captureCurrent: captureAgain });
    await s2.replayPending();
    expect(captureAgain).not.toHaveBeenCalled();
    expect(s2.queue.size).toBe(0);
    expect(await storage.listPendingRemovals(GROUP)).toEqual([]);
    expect(await journal.listPendingRumors(GROUP)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`replayed leave of ${MEMBER} in group ${GROUP}`));
  });
});
