/**
 * Bug: poll-savepoll-not-purge-marked. After a leave's clearPollData(g), an
 * in-flight poll open (savePoll of an OPEN poll) or vote cast (allocateVoteSeq)
 * must not re-create the group's rows (few:polls:<g>, few:poll-vote-seq:<g>);
 * releasePollPurgeMark (re-join) is the only way to allow them again.
 *
 * Real idb-keyval over fake-indexeddb; assertions read stored state.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'idb-keyval';

vi.mock('@/src/lib/crossTab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/crossTab')>()),
  postStoreChanged: vi.fn(),
}));

import {
  savePoll,
  loadPolls,
  allocateVoteSeq,
  clearPollData,
  clearAllPollData,
  releasePollPurgeMark,
  type Poll,
} from '@/src/lib/marmot/pollPersistence';
import { postStoreChanged } from '@/src/lib/crossTab';

const G = 'g'.repeat(64);
const OTHER_G = 'h'.repeat(64);
const ME = 'a'.repeat(64);

const poll = (groupId: string, id = 'p1'): Poll => ({
  id,
  groupId,
  title: 't',
  options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }],
  pollType: 'singlechoice',
  creatorPubkey: ME,
  createdAt: 1,
  closed: false,
});

const pollsRow = (g: string) => get(`few:polls:${g}`);
const seqRow = (g: string) => get(`few:poll-vote-seq:${g}`);

beforeEach(async () => {
  await clearAllPollData();
  vi.mocked(postStoreChanged).mockClear();
});

describe('open-poll save on a purged group', () => {
  it('writes nothing, resolves null and posts no store-changed notice', async () => {
    await clearPollData(G);
    expect(await savePoll(poll(G))).toBeNull();
    expect(await pollsRow(G)).toBeUndefined();
    expect(postStoreChanged).not.toHaveBeenCalled();
  });

  it('a save already queued when the purge runs does not bring the row back', async () => {
    const saving = savePoll(poll(G));
    const purging = clearPollData(G);
    expect(await saving).toBeNull();
    await purging;
    expect(await pollsRow(G)).toBeUndefined();
  });

  it('an update of an already stored open poll is blocked too, and other groups are unaffected', async () => {
    await savePoll(poll(G));
    await clearPollData(G);
    expect(await savePoll({ ...poll(G), title: 'edited' })).toBeNull();
    expect(await pollsRow(G)).toBeUndefined();
    expect(await savePoll(poll(OTHER_G))).not.toBeNull();
    expect(await loadPolls(OTHER_G)).toHaveLength(1);
  });

  it('works normally again after the re-join releases the mark', async () => {
    await clearPollData(G);
    releasePollPurgeMark(G);
    const p = poll(G);
    expect(await savePoll(p)).toEqual(p);
    expect(await loadPolls(G)).toEqual([p]);
    expect(postStoreChanged).toHaveBeenCalledWith('polls', G);
  });

  it('a normal save (no purge) stores and notifies once', async () => {
    await savePoll(poll(G, 'a'));
    await savePoll(poll(G, 'b'));
    await savePoll({ ...poll(G, 'a'), title: 'x' });
    expect((await loadPolls(G)).map((p) => [p.id, p.title]).sort()).toEqual([['a', 'x'], ['b', 't']]);
    expect(postStoreChanged).toHaveBeenCalledTimes(3);
  });
});

describe('vote-seq allocation on a purged group', () => {
  it('rejects (the caller must not send) and creates no reservation row', async () => {
    await clearPollData(G);
    await expect(allocateVoteSeq(G, 'p1', ME, 1)).rejects.toThrow(/purged/);
    expect(await seqRow(G)).toBeUndefined();
  });

  it('an allocation already queued when the purge runs rejects and leaves no row', async () => {
    const allocating = allocateVoteSeq(G, 'p1', ME, 1);
    const settled = allocating.then(() => 'ok', () => 'rejected');
    await clearPollData(G);
    expect(await settled).toBe('rejected');
    expect(await seqRow(G)).toBeUndefined();
  });

  it('allocates strictly increasing seqs normally, and again after the re-join releases the mark', async () => {
    expect(await allocateVoteSeq(G, 'p1', ME, 1)).toBe(1);
    expect(await allocateVoteSeq(G, 'p1', ME, 1)).toBe(2);
    expect(await allocateVoteSeq(G, 'p1', ME, 10)).toBe(10);
    await clearPollData(G);
    await expect(allocateVoteSeq(G, 'p1', ME, 1)).rejects.toThrow();
    releasePollPurgeMark(G);
    expect(await allocateVoteSeq(G, 'p1', ME, 1)).toBe(1); // purge dropped the old reservation
  });

  it('keeps separate reservations per poll and per voter', async () => {
    expect(await allocateVoteSeq(G, 'p1', ME, 1)).toBe(1);
    expect(await allocateVoteSeq(G, 'p2', ME, 1)).toBe(1);
    expect(await allocateVoteSeq(G, 'p1', 'B'.repeat(64), 1)).toBe(1);
    expect(await allocateVoteSeq(G, 'p1', ME, 1)).toBe(2);
  });

  it('other groups are unaffected by a purge', async () => {
    await clearPollData(G);
    expect(await allocateVoteSeq(OTHER_G, 'p1', ME, 1)).toBe(1);
  });
});
