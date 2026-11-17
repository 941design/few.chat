/**
 * S11 — the extended pending-direct-invite marker (AC-DEL-2, AC-DECL-1 marker half), against the real idb-keyval
 * store over fake-indexeddb (no mock of get/set/del/entries): record shape, legacy markers ignored without
 * throwing, mark-declined by inviteeRef, declined listing, clear.
 */
import 'fake-indexeddb/auto';
import { createStore, entries, set } from 'idb-keyval';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllPendingDirectInvites,
  clearPendingDirectInvite,
  clearPendingDirectInviteIfRef,
  setPendingDirectInvitePhase,
  getPendingDirectInviteMarker,
  loadDeclinedPendingDirectInvites,
  loadPendingDirectInviteMarkers,
  markPendingDirectInvite,
  markPendingDirectInviteDeclined,
  markerKey,
  pendingDirectInviteMarkerStore,
  PHASES,
  recordPendingDirectInvite,
} from '@/src/lib/marmot/pendingDirectInviteStorage';

const G1 = 'aa'.repeat(32);
const G2 = 'bb'.repeat(32);
const BOB = 'cd'.repeat(32);
// sorts BEFORE BOB in key order: a marker selected by position instead of by inviteeRef would be Carol's
const CAROL = '01'.repeat(32);
const DAVE = '12'.repeat(32);
/** The module's own idb store, opened a second time to seed raw (legacy / hostile) values. */
const raw = createStore('few-pending-invite-markers', 'markers');

beforeEach(async () => {
  await clearAllPendingDirectInvites();
});

describe('AC-DEL-2: marker shape carries inviteeRef and declined', () => {
  it('recordPendingDirectInvite stores exactly {inviteeRef, pubkey (lowercase), declined:false}', async () => {
    await recordPendingDirectInvite(G1, BOB.toUpperCase(), 'ref-bob');
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual({ inviteeRef: 'ref-bob', pubkey: BOB, declined: false });
    expect(await entries(raw)).toEqual([[markerKey(G1, BOB), { inviteeRef: 'ref-bob', pubkey: BOB, declined: false }]]);
  });

  it('a record is visible to the presence readers (the key shape is unchanged)', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-bob');
    expect([...(await loadPendingDirectInviteMarkers(G1))]).toEqual([BOB]);
  });

  it('rejects an empty groupId, pubkey or inviteeRef instead of writing a marker that can never match', async () => {
    await expect(recordPendingDirectInvite('', BOB, 'r')).rejects.toThrow(TypeError);
    await expect(recordPendingDirectInvite(G1, '', 'r')).rejects.toThrow(TypeError);
    await expect(recordPendingDirectInvite(G1, BOB, '')).rejects.toThrow(TypeError);
    expect(await entries(raw)).toEqual([]);
  });

  it('legacy markers (bare true, record without inviteeRef, junk) are ignored without throwing', async () => {
    await markPendingDirectInvite(G1, BOB); // legacy writer: a bare `true`
    await set(markerKey(G1, CAROL), { pubkey: CAROL, declined: true }, raw); // no inviteeRef
    await set(markerKey(G1, DAVE), { inviteeRef: 'ref-dave', pubkey: DAVE, declined: 'yes' }, raw); // wrong type
    await set(markerKey(G2, DAVE), 'junk', raw);
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await getPendingDirectInviteMarker(G1, CAROL)).toBeUndefined();
    expect(await getPendingDirectInviteMarker(G1, DAVE)).toBeUndefined();
    expect(await loadDeclinedPendingDirectInvites()).toEqual([]);
    expect(await markPendingDirectInviteDeclined(G1, 'ref-dave')).toBeUndefined();
    // nothing was written by any of those calls
    expect((await entries(raw)).length).toBe(4);
    expect((await entries(raw)).find(([k]) => k === markerKey(G1, DAVE))?.[1]).toEqual({ inviteeRef: 'ref-dave', pubkey: DAVE, declined: 'yes' });
  });
});

describe('markPendingDirectInviteDeclined', () => {
  it('sets declined:true on the marker with that inviteeRef of that group and returns its entry', async () => {
    // seeded out of key order on purpose
    await recordPendingDirectInvite(G1, CAROL, 'ref-carol');
    await recordPendingDirectInvite(G1, BOB, 'ref-bob');
    const entry = await markPendingDirectInviteDeclined(G1, 'ref-bob');
    expect(entry).toEqual({ groupId: G1, marker: { inviteeRef: 'ref-bob', pubkey: BOB, declined: true, declinedAt: expect.any(Number) } });
    expect(await getPendingDirectInviteMarker(G1, BOB)).toEqual({ inviteeRef: 'ref-bob', pubkey: BOB, declined: true, declinedAt: expect.any(Number) });
    expect(await getPendingDirectInviteMarker(G1, CAROL)).toEqual({ inviteeRef: 'ref-carol', pubkey: CAROL, declined: false });
  });

  it('is scoped to the group: the same inviteeRef in another group is untouched, an unknown ref writes nothing', async () => {
    await recordPendingDirectInvite(G1, BOB, 'same-ref');
    await recordPendingDirectInvite(G2, BOB, 'same-ref');
    expect(await markPendingDirectInviteDeclined(G2, 'same-ref')).toMatchObject({ groupId: G2 });
    expect((await getPendingDirectInviteMarker(G1, BOB))?.declined).toBe(false);
    const before = await entries(raw);
    expect(await markPendingDirectInviteDeclined(G1, 'unknown-ref')).toBeUndefined();
    expect(await markPendingDirectInviteDeclined('no-such-group', 'same-ref')).toBeUndefined();
    expect(await markPendingDirectInviteDeclined(G1, '')).toBeUndefined();
    expect(await entries(raw)).toEqual(before);
  });

  it('is idempotent: a repeated decline returns the same entry and keeps the marker', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-bob');
    const first = await markPendingDirectInviteDeclined(G1, 'ref-bob');
    const second = await markPendingDirectInviteDeclined(G1, 'ref-bob');
    expect(second).toEqual(first);
    expect(await entries(raw)).toHaveLength(1);
  });

  it('never resurrects a marker cleared meanwhile (clear and mark-declined are serialised per key)', async () => {
    await recordPendingDirectInvite(G1, BOB, 'ref-bob');
    // the mark-declined scan has seen the marker, but the clear takes the key chain first: the serialised re-read finds it gone
    const [declined] = await Promise.all([markPendingDirectInviteDeclined(G1, 'ref-bob'), clearPendingDirectInvite(G1, BOB)]);
    expect(declined).toBeUndefined();
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await entries(raw)).toEqual([]);
  });
});

describe('loadDeclinedPendingDirectInvites', () => {
  it('lists only declined record markers of every group, with their group id; clear removes one', async () => {
    await recordPendingDirectInvite(G2, DAVE, 'ref-dave');
    await recordPendingDirectInvite(G1, CAROL, 'ref-carol');
    await recordPendingDirectInvite(G1, BOB, 'ref-bob');
    await markPendingDirectInviteDeclined(G2, 'ref-dave');
    await markPendingDirectInviteDeclined(G1, 'ref-bob');
    const listed = await loadDeclinedPendingDirectInvites();
    expect(listed.map((e) => `${e.groupId}:${e.marker.pubkey}`).sort()).toEqual([`${G1}:${BOB}`, `${G2}:${DAVE}`].sort());
    await clearPendingDirectInvite(G1, BOB);
    expect((await loadDeclinedPendingDirectInvites()).map((e) => e.marker.pubkey)).toEqual([DAVE]);
  });

  it('the injectable store object exposes the real functions', () => {
    expect(pendingDirectInviteMarkerStore.markDeclined).toBe(markPendingDirectInviteDeclined);
    expect(pendingDirectInviteMarkerStore.listDeclined).toBe(loadDeclinedPendingDirectInvites);
    expect(pendingDirectInviteMarkerStore.record).toBe(recordPendingDirectInvite);
    expect(pendingDirectInviteMarkerStore.clearIfRef).toBe(clearPendingDirectInviteIfRef);
    expect(pendingDirectInviteMarkerStore.setPhase).toBe(setPendingDirectInvitePhase);
    expect(pendingDirectInviteMarkerStore.get).toBe(getPendingDirectInviteMarker);
  });
});

describe('phase membership: an unknown phase makes the marker invalid (never coerced to declined)', () => {
  it('PHASES is exactly the three phases and each round-trips through the store', async () => {
    expect([...PHASES].sort()).toEqual(['announce-pending', 'declined', 'removing']);
    for (const phase of ['declined', 'removing', 'announce-pending'] as const) {
      await recordPendingDirectInvite(G1, BOB, 'ref-bob');
      await markPendingDirectInviteDeclined(G1, 'ref-bob');
      expect(await setPendingDirectInvitePhase(G1, BOB, 'ref-bob', phase)).toBe(true);
      expect((await getPendingDirectInviteMarker(G1, BOB))?.phase).toBe(phase);
    }
  });

  it.each(['removed', '', 'DECLINED', 7, null, {}])('stored phase %j: marker ignored, never listed, reported to onInvalid, not touched by writes', async (phase) => {
    const bad = { inviteeRef: 'ref-bob', pubkey: BOB, declined: true, phase };
    await set(markerKey(G1, BOB), bad, raw);
    const invalid: Array<[string, unknown]> = [];
    expect(await getPendingDirectInviteMarker(G1, BOB)).toBeUndefined();
    expect(await loadDeclinedPendingDirectInvites((k, p) => void invalid.push([k, p]))).toEqual([]);
    expect(invalid).toEqual([[markerKey(G1, BOB), phase]]);
    expect(await markPendingDirectInviteDeclined(G1, 'ref-bob')).toBeUndefined();
    expect(await setPendingDirectInvitePhase(G1, BOB, 'ref-bob', 'removing')).toBe(false);
    expect(await clearPendingDirectInviteIfRef(G1, BOB, 'ref-bob')).toBe(false);
    expect((await entries(raw)).find(([k]) => k === markerKey(G1, BOB))?.[1]).toEqual(bad);
  });
});
