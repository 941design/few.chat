// @vitest-environment node
/**
 * S5: the domain handlers (poll, profile, profile-request, announcement) and the retract coverage
 * of every kind on the history-sink path, over the REAL stores (see realApp.ts).
 *
 *  AC-HIST-9   every registered kind is reachable from `append` and its store receives the row; an
 *              unregistered kind is stored dispatched:true with no handler call.
 *  AC-HIST-11  roster/admin gates read the LIVE group handle through groupOf: undefined fails closed
 *              (effect absent, row dispatched:true), a rejection rejects (row stays undispatched).
 *  AC-WDR-1    withdraw of another member's content removes it everywhere; unread equals the
 *              recomputed value (concrete before/after).
 *  AC-WDR-2    own chat -> failed/retry (never deleted, never resent); own reaction/vote/edit/delete dropped.
 *  Follow-up client writes (profile-request replies, the 'accepted' announcement) are enqueued on the
 *  FIFO as the handler's LAST action and never awaited inside the handler.
 *  Purge-after-leave: a late retract caused by purge removes an own row instead of parking it failed/retry.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as chat from '@/src/lib/marmot/chatPersistence';
import * as edits from '@/src/lib/messageEdits/api';
import { createGroupAdminsProvider } from '@/src/lib/marmot/handlers/groupGates';
import { createProfileGroupHandler } from '@/src/lib/marmot/handlers/profileHandler';
import { createProfileRequestGroupHandler } from '@/src/lib/marmot/handlers/profileRequestHandler';
import { isKnownPeer } from '@/src/lib/knownPeers';
import { initUnreadCounts } from '@/src/lib/unreadStore';
import { ALICE, BOB, buildRealApp, ev, installLocalStorage, MALLORY, SELF, unreadOf, type RealApp } from './realApp';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

let apps: RealApp[] = [];
const make = (o?: Parameters<typeof buildRealApp>[0]) => {
  const app = buildRealApp(o);
  apps.push(app);
  return app;
};
beforeEach(() => {
  installLocalStorage();
  apps = [];
});
afterEach(async () => {
  edits.registerGroupAdminsProvider(null);
  for (const app of apps) await app.sink.dispose();
});

const POLL = 'poll-1';
const openContent = (id = POLL) =>
  JSON.stringify({ id, title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: ALICE });
const voteContent = (responses: string[], seq = 1) => JSON.stringify({ pollId: POLL, responses, seq });
const closeContent = () => JSON.stringify({ pollId: POLL, results: [], totalVoters: 0 });
const profileContent = (nickname = 'Bob') => JSON.stringify({ nickname, avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' });
const requestContent = (targetPubkey: string) => JSON.stringify({ type: 'profile_request', targetPubkey, nonce: 'n1' });
const renamed = JSON.stringify({ type: 'group_renamed', name: 'New name' });

describe('AC-HIST-9: every registered kind reaches its store through append', () => {
  it('chat (9): the message row is stored under the sink sender', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: 'hi' }));
    expect((await app.messages()).map((m) => [m.id, m.senderPubkey, m.content])).toEqual([['rumor-e1', BOB, 'hi']]);
  });

  it('announcement (9, structured): an admin-sourced group_renamed is stored; a non-admin one is not', async () => {
    const app = make();
    app.live.admins = [BOB];
    await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: renamed }));
    await app.sink.append(app.entry({ eventId: 'e2', account: MALLORY, content: renamed }));
    expect((await app.messages()).map((m) => [m.id, m.senderPubkey])).toEqual([['rumor-e1', BOB]]);
    expect((await app.row('e2'))?.dispatched).toBe(true); // rejected, not retried
  });

  it('reaction (7): the reaction row is stored for a known target', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', account: ALICE, content: 'target' }));
    await app.sink.append(app.entry({ eventId: 'e2', kind: 7, account: BOB, content: '+', tags: [['e', 'rumor-e1']] }));
    expect((await app.reactionRows()).map((r) => [r.messageId, r.reactorPubkey, r.emoji, r.removed])).toEqual([['rumor-e1', BOB, '+', false]]);
    expect(app.versions.reactions).toBe(1);
  });

  it('delete (5): the target row is tombstoned by its author', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: 'oops' }));
    await app.sink.append(app.entry({ eventId: 'e2', kind: 5, account: BOB, content: '', tags: [['e', 'rumor-e1']] }));
    expect((await app.messages()).map((m) => [m.id, m.tombstoned])).toEqual([['rumor-e1', true]]);
  });

  it('edit (kind 9 carrying the edit marker): the target content is replaced', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: 'typo' }));
    await app.sink.append(app.entry({ eventId: 'e2', account: BOB, content: 'fixed', at: 1_700_000_100, tags: [['e', 'rumor-e1', '', 'edit'], ['rev', '1700000100']] }));
    expect((await app.messages()).map((m) => [m.id, m.content, m.edited])).toEqual([['rumor-e1', 'fixed', true]]);
  });

  it('poll open / vote / close (10 / 11 / 12): the poll, the vote and the closed tally are stored', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', kind: 10, account: ALICE, content: openContent() }));
    expect((await app.polls()).map((p) => [p.id, p.creatorPubkey, p.closed])).toEqual([[POLL, ALICE, false]]);
    await app.sink.append(app.entry({ eventId: 'e2', kind: 11, account: BOB, content: voteContent(['A']) }));
    expect((await app.votes(POLL)).map((v) => [v.voterPubkey, v.responses])).toEqual([[BOB, ['A']]]);
    await app.sink.append(app.entry({ eventId: 'e3', kind: 12, account: ALICE, content: closeContent() }));
    const [closed] = await app.polls();
    expect([closed.closed, closed.totalVoters, closed.results?.find((r) => r.optionId === 'A')?.count]).toEqual([true, 1, 1]);
    expect(app.versions.polls).toBe(3);
  });

  it('profile (0): the member profile is stored under the sink sender', async () => {
    const { loadMemberProfiles } = await import('@/src/lib/marmot/groupStorage');
    const app = make();
    await app.sink.append(app.entry({ eventId: 'e1', kind: 0, account: BOB, content: profileContent('Bob') }));
    expect((await loadMemberProfiles(app.groupId)).map((p) => [p.pubkeyHex, p.nickname])).toEqual([[BOB, 'Bob']]);
    expect(app.versions.profile).toBe(1);
    expect(app.spies.writeContactEntry).toHaveBeenCalledWith(BOB, expect.objectContaining({ nickname: 'Bob' }));
  });

  it('profile-request (30): a member request about us is recorded and answered through the FIFO', async () => {
    const app = make();
    app.live.members = [BOB, SELF];
    await app.sink.append(app.entry({ eventId: 'e1', kind: 30, account: BOB, content: requestContent(SELF) }));
    expect(app.spies.recordRequestEmitted).toHaveBeenCalledWith(app.groupId, SELF, expect.any(Number));
    expect(app.spies.sendSelfProfile).not.toHaveBeenCalled(); // queued, not run inside the call
    await app.runJobs();
    expect(app.spies.sendSelfProfile).toHaveBeenCalledWith(app.groupId);
  });

  it.each([1, 13, 21059])('an unregistered kind (%i) is stored dispatched:true and touches no store and no handler', async (kind) => {
    const app = make();
    app.live.members = [BOB];
    app.live.admins = [BOB];
    await app.sink.append(app.entry({ eventId: 'e1', kind, account: BOB, content: requestContent(SELF) }));
    expect((await app.row('e1'))?.dispatched).toBe(true);
    expect(await app.messages()).toEqual([]);
    expect(await app.polls()).toEqual([]);
    expect(app.spies.recordRequestEmitted).not.toHaveBeenCalled();
    expect(app.groupOf).not.toHaveBeenCalled();
    expect(app.jobs).toEqual([]);
  });
});

describe('AC-HIST-11: gates read the live group handle', () => {
  it('the announcement admin gate follows the live admins, not an overlay that disagrees', async () => {
    const app = make();
    const overlay = { admins: [BOB, MALLORY] }; // stale app overlay: says BOB and MALLORY are admins
    app.live.admins = [BOB];
    await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: renamed }));
    app.live.admins = [ALICE]; // BOB was demoted: the live accessor changes, the overlay does not
    await app.sink.append(app.entry({ eventId: 'e2', account: BOB, content: renamed }));
    await app.sink.append(app.entry({ eventId: 'e3', account: MALLORY, content: renamed }));
    expect(overlay.admins).toContain(BOB);
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-e1']);
  });

  it('the accepted/member_admitted roster gate reads the live members()', async () => {
    const app = make();
    app.live.admins = [ALICE];
    const accepted = (pk: string) => JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: pk });
    app.live.members = [ALICE, BOB];
    await app.sink.append(app.entry({ eventId: 'e1', account: ALICE, content: accepted(BOB) }));
    await app.sink.append(app.entry({ eventId: 'e2', account: ALICE, content: accepted(MALLORY) })); // not in the live roster
    app.live.members = [ALICE, BOB, MALLORY]; // joined since: a later delivery of the same shape now passes
    await app.sink.append(app.entry({ eventId: 'e3', account: ALICE, content: accepted(MALLORY) }));
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-e1', 'rumor-e3']);
  });

  it('groupOf resolving undefined fails closed: gated effect absent, nothing thrown, row marked dispatched', async () => {
    const app = make();
    app.live.held = false;
    await expect(app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: renamed }))).resolves.toBeUndefined();
    expect(await app.messages()).toEqual([]);
    expect((await app.row('e1'))?.dispatched).toBe(true);

    app.live.members = [BOB];
    await app.sink.append(app.entry({ eventId: 'e2', kind: 30, account: BOB, content: requestContent(SELF) }));
    expect(app.spies.recordRequestEmitted).not.toHaveBeenCalled();
    expect(app.jobs).toEqual([]);
    expect((await app.row('e2'))?.dispatched).toBe(true);
  });

  it('a groupOf rejection rejects the handler: the row stays dispatched:false and the retry applies the effect', async () => {
    const app = make();
    app.live.admins = [BOB];
    app.live.failure = true;
    const e = app.entry({ eventId: 'e1', account: BOB, content: renamed });
    await expect(app.sink.append(e)).rejects.toThrow('groups.get failed');
    expect(await app.messages()).toEqual([]);
    expect((await app.row('e1'))?.dispatched).toBe(false);
    app.live.failure = false;
    await app.sink.append(e);
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-e1']);
    expect((await app.row('e1'))?.dispatched).toBe(true);
  });

  describe('profile-request gate (the requester must be a current member)', () => {
    it('a non-member requester is ignored: nothing recorded, nothing queued, row dispatched', async () => {
      const app = make();
      app.live.members = [ALICE];
      await app.sink.append(app.entry({ eventId: 'e1', kind: 30, account: BOB, content: requestContent(SELF) }));
      expect(app.spies.recordRequestEmitted).not.toHaveBeenCalled();
      expect(app.jobs).toEqual([]);
      expect((await app.row('e1'))?.dispatched).toBe(true);
    });

    it('a member removed since is gated by the live roster, a rejection rejects the row', async () => {
      const app = make();
      app.live.members = [BOB];
      await app.sink.append(app.entry({ eventId: 'e1', kind: 30, account: BOB, content: requestContent(SELF) }));
      expect(app.jobs).toHaveLength(1);
      app.live.members = []; // removed
      await app.sink.append(app.entry({ eventId: 'e2', kind: 30, account: BOB, content: requestContent(SELF) }));
      expect(app.jobs).toHaveLength(1);
      app.live.failure = true;
      await expect(app.sink.append(app.entry({ eventId: 'e3', kind: 30, account: BOB, content: requestContent(SELF) }))).rejects.toThrow('groups.get failed');
      expect((await app.row('e3'))?.dispatched).toBe(false);
    });

    it('our own request echo is not answered; a request about someone else takes the relay path through the FIFO', async () => {
      const app = make();
      app.live.members = [BOB, SELF];
      await app.sink.append(app.entry({ eventId: 'e1', kind: 30, account: SELF, content: requestContent(ALICE) }));
      expect(app.jobs).toEqual([]);
      await app.sink.append(app.entry({ eventId: 'e2', kind: 30, account: BOB, content: requestContent(ALICE) }));
      await app.runJobs();
      expect(app.spies.sendSelfProfile).not.toHaveBeenCalled();
      expect(app.spies.handleIncomingProfileRequest).toHaveBeenCalledWith({ groupId: app.groupId, payload: expect.objectContaining({ targetPubkey: ALICE }) });
    });
  });

  describe('admin-only delete of an announcement (provider backed by the live group.admins)', () => {
    it('only a live admin can delete an announcement row; the provider follows the live accessor', async () => {
      const app = make();
      edits.registerGroupAdminsProvider(createGroupAdminsProvider(app.groupOf));
      app.live.admins = [BOB];
      await app.sink.append(app.entry({ eventId: 'e1', account: BOB, content: renamed }));
      const del = (eventId: string, account: string) =>
        app.entry({ eventId, kind: 5, account, content: '', tags: [['e', 'rumor-e1']], at: 1_700_000_000 + Number(eventId.slice(1)) });
      await app.sink.append(del('e2', MALLORY)); // not an admin
      expect((await app.messages())[0].tombstoned).toBeFalsy();
      app.live.held = false; // group gone: fail closed, still not deletable
      await app.sink.append(del('e3', BOB));
      expect((await app.messages())[0].tombstoned).toBeFalsy();
      app.live.held = true;
      await app.sink.append(del('e4', BOB)); // a live admin
      expect((await app.messages())[0].tombstoned).toBe(true);
    });
  });
});

describe('AC-WDR-1: withdraw of another member\'s content, with concrete counts', () => {
  it('chat row, reaction and poll event are absent afterwards and unread equals the recomputed value (3 -> 2 -> 0)', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: BOB, content: 'bob 1', at: 1_700_000_001 }));
    await app.sink.append(app.entry({ eventId: 'm2', account: BOB, content: 'bob 2', at: 1_700_000_002 }));
    await app.sink.append(app.entry({ eventId: 'm3', account: ALICE, content: 'alice 1', at: 1_700_000_003 }));
    await app.sink.append(app.entry({ eventId: 'm4', account: SELF, content: 'mine', at: 1_700_000_004 })); // own: never unread
    await app.sink.append(app.entry({ eventId: 'r1', kind: 7, account: BOB, content: '+', tags: [['e', 'rumor-m3']] }));
    await app.sink.append(app.entry({ eventId: 'p1', kind: 10, account: BOB, content: openContent('bobs-poll') }));
    await app.sink.append(app.entry({ eventId: 'v1', kind: 11, account: BOB, content: JSON.stringify({ pollId: 'bobs-poll', responses: ['A'], seq: 1 }) }));

    expect(unreadOf(app.groupId)).toBe(3);
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-m1', 'rumor-m2', 'rumor-m3', 'rumor-m4']);
    expect((await app.reactionRows()).filter((r) => !r.removed)).toHaveLength(1);
    expect((await app.polls()).map((p) => p.id)).toEqual(['bobs-poll']);
    expect(await app.votes('bobs-poll')).toHaveLength(1);

    await app.sink.withdraw(app.groupId, ev('m2', 'r1', 'v1', 'p1'));

    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-m1', 'rumor-m3', 'rumor-m4']);
    expect((await app.reactionRows()).filter((r) => !r.removed)).toEqual([]);
    expect(await app.polls()).toEqual([]);
    expect(await app.votes('bobs-poll')).toEqual([]);
    expect(unreadOf(app.groupId)).toBe(2); // recomputed over the remaining rows: m1 and m3

    await initUnreadCounts([app.groupId], SELF); // a restart shows the same number
    expect(unreadOf(app.groupId)).toBe(2);

    await app.sink.withdraw(app.groupId, ev('m1', 'm3'));
    expect(unreadOf(app.groupId)).toBe(0);
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-m4']);
  });
});

describe('AC-WDR-2: own content', () => {
  it('an own chat row is handed to failed/retry (kept, never deleted) and nothing is resent', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: SELF, content: 'mine' }));
    await app.sink.withdraw(app.groupId, ev('m1'));
    expect(app.spies.onOwnWithdrawn).toHaveBeenCalledWith(app.groupId, 'rumor-m1');
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-m1']);
    expect(app.jobs).toEqual([]); // no follow-up send queued
    expect(app.spies.sendAnnouncement).not.toHaveBeenCalled();
    expect(app.spies.sendSelfProfile).not.toHaveBeenCalled();
  });

  it('own reaction and own vote are dropped from the stores', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: ALICE, content: 'target' }));
    await app.sink.append(app.entry({ eventId: 'p1', kind: 10, account: ALICE, content: openContent() }));
    await app.sink.append(app.entry({ eventId: 'r1', kind: 7, account: SELF, content: '+', tags: [['e', 'rumor-m1']] }));
    await app.sink.append(app.entry({ eventId: 'v1', kind: 11, account: SELF, content: voteContent(['B']) }));
    expect((await app.reactionRows()).filter((r) => !r.removed)).toHaveLength(1);
    expect(await app.votes(POLL)).toHaveLength(1);

    await app.sink.withdraw(app.groupId, ev('r1', 'v1'));

    expect((await app.reactionRows()).filter((r) => !r.removed)).toEqual([]);
    expect(await app.votes(POLL)).toEqual([]);
    expect((await app.polls()).map((p) => p.id)).toEqual([POLL]); // the other member's poll stays
  });

  it('own edit and own delete signals are undone: the original content is back and the row is visible again', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: SELF, content: 'original', at: 1_700_000_001 }));
    await app.sink.append(app.entry({ eventId: 'm2', account: SELF, content: 'edited', at: 1_700_000_100, tags: [['e', 'rumor-m1', '', 'edit'], ['rev', '1700000100']] }));
    expect((await app.messages())[0]).toMatchObject({ content: 'edited', edited: true });
    await app.sink.withdraw(app.groupId, ev('m2'));
    expect((await app.messages())[0]).toMatchObject({ content: 'original' });
    expect((await app.messages())[0].edited).toBeFalsy();

    await app.sink.append(app.entry({ eventId: 'm3', kind: 5, account: SELF, content: '', tags: [['e', 'rumor-m1']], at: 1_700_000_200 }));
    expect((await app.messages())[0].tombstoned).toBe(true);
    await app.sink.withdraw(app.groupId, ev('m3'));
    expect((await app.messages())[0].tombstoned).toBeFalsy();
  });

  it('a withdrawn edit or delete of ANOTHER member is undone the same way', async () => {
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: BOB, content: 'bob original', at: 1_700_000_001 }));
    await app.sink.append(app.entry({ eventId: 'm2', kind: 5, account: BOB, content: '', tags: [['e', 'rumor-m1']], at: 1_700_000_200 }));
    expect((await app.messages())[0].tombstoned).toBe(true);
    await app.sink.withdraw(app.groupId, ev('m2'));
    expect((await app.messages())[0].tombstoned).toBeFalsy();
  });
});

describe('AC-WDR-6 across kinds: effects already emitted are not undone', () => {
  it('a withdrawn peer message keeps the peer known; a withdrawn profile keeps the stored profile and the contact entry', async () => {
    const { loadMemberProfiles } = await import('@/src/lib/marmot/groupStorage');
    const app = make();
    await app.sink.append(app.entry({ eventId: 'm1', account: BOB }));
    await app.sink.append(app.entry({ eventId: 'p1', kind: 0, account: BOB, content: profileContent('Bob') }));
    await app.sink.withdraw(app.groupId, ev('m1', 'p1'));
    expect(isKnownPeer(BOB)).toBe(true);
    expect((await loadMemberProfiles(app.groupId)).map((p) => p.nickname)).toEqual(['Bob']);
    expect(app.spies.writeContactEntry).toHaveBeenCalledTimes(1);
  });

  it('a withdrawn profile-request does not undo the queued reply', async () => {
    const app = make();
    app.live.members = [BOB];
    await app.sink.append(app.entry({ eventId: 'q1', kind: 30, account: BOB, content: requestContent(SELF) }));
    await app.sink.withdraw(app.groupId, ev('q1'));
    await app.runJobs();
    expect(app.spies.sendSelfProfile).toHaveBeenCalledTimes(1);
  });
});

describe('follow-up client writes are enqueued on the FIFO, never awaited in the handler', () => {
  const sk = new Uint8Array(32).fill(7);
  const bobKey = getPublicKey(sk);
  const signedProfile = (nickname = 'Bob') =>
    JSON.stringify(finalizeEvent({ kind: 0, created_at: 1_700_000_000, tags: [], content: JSON.stringify({ nickname, avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' }) }, sk));
  const acceptedContent = JSON.stringify({ type: 'invite_lifecycle', event: 'accepted', pubkey: bobKey });

  it('the accepted announcement is queued once (never awaited in the handler) and runs only when the FIFO runs it', async () => {
    const app = make();
    app.markers.add(`${app.groupId}:${bobKey}`);
    await app.sink.append(app.entry({ eventId: 'e1', kind: 0, account: bobKey, content: signedProfile() }));
    expect(app.calls.filter((c) => c === 'enqueue')).toHaveLength(1);
    expect(app.calls[app.calls.length - 1]).toBe('enqueue'); // the last action of the handler call
    expect(app.spies.sendAnnouncement).not.toHaveBeenCalled(); // never awaited inside the handler
    await app.runJobs();
    expect(app.spies.sendAnnouncement).toHaveBeenCalledWith(acceptedContent);
  });

  it('a redelivery of the same signed profile under another event id queues no second announcement', async () => {
    const app = make();
    app.markers.add(`${app.groupId}:${bobKey}`);
    const content = signedProfile();
    await app.sink.append(app.entry({ eventId: 'e1', kind: 0, account: bobKey, content }));
    await app.sink.append(app.entry({ eventId: 'e2', kind: 0, account: bobKey, content }));
    expect(app.jobs).toHaveLength(1);
  });

  it('a failed apply rejects the row and the retry applies it (the one-shot gate does not swallow the retry)', async () => {
    const { loadMemberProfiles } = await import('@/src/lib/marmot/groupStorage');
    const app = make();
    app.markers.add(`${app.groupId}:${bobKey}`);
    const e = app.entry({ eventId: 'e1', kind: 0, account: bobKey, content: signedProfile() });
    app.hooks.failMerge = true;
    await expect(app.sink.append(e)).rejects.toThrow('profile store down');
    expect(await loadMemberProfiles(app.groupId)).toEqual([]);
    expect(app.jobs).toEqual([]);
    app.hooks.failMerge = false;
    await app.sink.append(e);
    expect((await loadMemberProfiles(app.groupId)).map((p) => p.pubkeyHex)).toEqual([bobKey]);
    expect(app.jobs).toHaveLength(1);
  });

  it('a marker consume that throws rejects the row (undispatched, nothing announced); the retry still finds the marker and announces exactly once', async () => {
    const app = make();
    app.markers.add(`${app.groupId}:${bobKey}`);
    const e = app.entry({ eventId: 'e1', kind: 0, account: bobKey, content: signedProfile() });
    app.hooks.failConsume = 1;
    await expect(app.sink.append(e)).rejects.toThrow('marker store down');
    expect((await app.row('e1'))?.dispatched).toBe(false);
    expect(app.jobs).toEqual([]); // no announcement was queued by the failed attempt
    expect(app.markers.has(`${app.groupId}:${bobKey}`)).toBe(true); // the marker survived: the replay can find it
    await app.sink.append(e); // the sink retries the undispatched row
    expect((await app.row('e1'))?.dispatched).toBe(true);
    expect(app.jobs).toHaveLength(1);
    expect(app.calls[app.calls.length - 1]).toBe('enqueue'); // still the handler's very last action
    await app.runJobs();
    expect(app.spies.sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(app.spies.sendAnnouncement).toHaveBeenCalledWith(acceptedContent);
    // a further redelivery finds no marker: silent
    await app.sink.append(app.entry({ eventId: 'e2', kind: 0, account: bobKey, content: signedProfile() }));
    expect(app.jobs).toEqual([]);
  });

  it('a failing queued send is warned and never fails the sink call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = make();
    app.markers.add(`${app.groupId}:${bobKey}`);
    app.spies.sendAnnouncement.mockRejectedValueOnce(new Error('relay down'));
    await app.sink.append(app.entry({ eventId: 'e1', kind: 0, account: bobKey, content: signedProfile() }));
    await expect(app.runJobs()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a profile-request reply is queued after the awaited recording, never awaited in the handler', async () => {
    const app = make();
    app.live.members = [BOB];
    await app.sink.append(app.entry({ eventId: 'q1', kind: 30, account: BOB, content: requestContent(SELF) }));
    expect(app.calls).toEqual(['recordRequestEmitted', 'enqueue']);
    expect(app.spies.sendSelfProfile).not.toHaveBeenCalled();
  });
});

describe('purge after leave: a late retract removes an own row instead of parking it failed/retry', () => {
  /** An own message whose dispatch hangs before its row is written, a leave that purges, then the release. */
  async function hungOwnMessageThenLeave(app: RealApp, leave: boolean) {
    let release!: () => void;
    app.hooks.beforeAppend = new Promise<void>((resolve) => void (release = resolve));
    const appended = app.sink.append(app.entry({ eventId: 'm1', account: SELF, content: 'mine' })).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5)); // the dispatch is running and hung
    if (leave) {
      await app.sink.purge(app.groupId); // waits one (short) settle bound for the hung dispatch
      await chat.clearMessages(app.groupId); // the leave's own cleanup
    } else {
      await app.sink.withdraw(app.groupId, ev('m1')); // the library withdrew it while it hung
    }
    release();
    await appended;
  }

  it('leave: own message, hung dispatch, purge, release -> no chat row for the left group and no failed/retry hand-back', async () => {
    const app = make({ settleTimeoutMs: 40 });
    await hungOwnMessageThenLeave(app, true);
    // the released dispatch writes the row (and ends with the own echo), THEN the late retract runs
    await vi.waitFor(() => expect(app.spies.onOwnEcho).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await app.messages()).toEqual([]);
    expect(app.spies.onOwnWithdrawn).not.toHaveBeenCalled();
  });

  it('control: a plain withdraw of the same hung own message leaves the row for the failed/retry hand-back', async () => {
    const app = make({ settleTimeoutMs: 40 });
    await hungOwnMessageThenLeave(app, false);
    await vi.waitFor(() => expect(app.spies.onOwnWithdrawn).toHaveBeenCalledWith(app.groupId, 'rumor-m1'), { timeout: 2000 });
    expect((await app.messages()).map((m) => m.id)).toEqual(['rumor-m1']);
  });
});

describe('required ports are enforced at construction (no silent degrade)', () => {
  const fn = () => vi.fn(async () => undefined);
  const profileDeps = () => ({
    mergeMemberProfile: vi.fn(async () => true), clearPendingDirectInvite: fn(), notifyProfileObserved: vi.fn(), recordRequestAnswered: fn(),
    writeContactEntry: vi.fn(), setProfileVersion: vi.fn(), consumePendingDirectInviteMarker: vi.fn(async () => false), sendAnnouncement: fn(), enqueue: vi.fn(),
  });
  const requestDeps = () => ({ recordRequestEmitted: fn(), sendSelfProfile: fn(), handleIncomingProfileRequest: fn(), groupOf: fn(), enqueue: vi.fn() });

  it.each(Object.keys(profileDeps()))('createProfileGroupHandler without %s throws a TypeError naming it', (port) => {
    const deps = { ...profileDeps(), [port]: undefined };
    expect(() => createProfileGroupHandler(deps as never)).toThrow(TypeError);
    expect(() => createProfileGroupHandler(deps as never)).toThrow(new RegExp(`"${port}"`));
  });

  it.each(Object.keys(requestDeps()))('createProfileRequestGroupHandler without %s throws a TypeError naming it', (port) => {
    const deps = { ...requestDeps(), [port]: undefined };
    expect(() => createProfileRequestGroupHandler(deps as never)).toThrow(TypeError);
    expect(() => createProfileRequestGroupHandler(deps as never)).toThrow(new RegExp(`"${port}"`));
  });
});

describe('profile sink gate keyed per group; accepted announcement unlosable', () => {
  const sk = new Uint8Array(32).fill(9);
  const authorKey = getPublicKey(sk);
  const signed = (n: number) =>
    JSON.stringify(finalizeEvent({ kind: 0, created_at: 1_700_000_000 + n, tags: [], content: JSON.stringify({ nickname: `N${n}`, avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' }) }, sk));
  const mk = (over: Record<string, unknown> = {}) => {
    const deps = {
      mergeMemberProfile: vi.fn(async () => true), clearPendingDirectInvite: vi.fn(async () => undefined), notifyProfileObserved: vi.fn(),
      recordRequestAnswered: vi.fn(async () => undefined), writeContactEntry: vi.fn(), setProfileVersion: vi.fn(),
      consumePendingDirectInviteMarker: vi.fn(async () => false), sendAnnouncement: vi.fn(async () => undefined), enqueue: vi.fn(),
      ...over,
    };
    const handler = createProfileGroupHandler(deps as never);
    const env = { selfPubkeyHex: SELF, getActiveGroupId: () => null } as never;
    const send = (groupId: string, content: string, eventId = `${groupId}-${Math.random()}`) =>
      handler.dispatch({ groupId, eventId, rumor: { id: eventId, kind: 0, content, tags: [], created_at: 1 } as never, sender: authorKey }, env);
    return { deps, send };
  };

  it('the same signed profile delivered to two groups merges in both; a redelivery to the same group is deduped', async () => {
    const { deps, send } = mk();
    const content = signed(1);
    await send('g1', content);
    await send('g2', content);
    expect((deps.mergeMemberProfile.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual(['g1', 'g2']);
    await send('g1', content);
    await send('g2', content);
    expect(deps.mergeMemberProfile).toHaveBeenCalledTimes(2);
  });

  it('the gate is bounded: the oldest entry is evicted after 1024 newer ones', async () => {
    const { deps, send } = mk();
    const first = signed(0);
    await send('g1', first);
    for (let i = 1; i <= 1024; i++) await send('g1', signed(i));
    const before = deps.mergeMemberProfile.mock.calls.length;
    await send('g1', first); // evicted -> applied again
    expect(deps.mergeMemberProfile.mock.calls.length).toBe(before + 1);
    await send('g1', signed(1024)); // newest still held -> deduped
    expect(deps.mergeMemberProfile.mock.calls.length).toBe(before + 1);
  }, 30_000); // signs 1025 events: exceeds the 5 s default under full-suite load

  it.each(['notifyProfileObserved', 'writeContactEntry'] as const)(
    'a throw in %s leaves the marker for the retry, which announces exactly once; a further replay adds none',
    async (port) => {
      // The marker is consumed as the handler's LAST step: a throw in an earlier step cannot lose the announcement
      // (the marker is still there), and nothing can fail between consuming it and enqueueing the announcement.
      let marker = true;
      let healthy = false;
      const failing = { [port]: vi.fn(() => { if (!healthy) throw new Error('late step down'); }) };
      const { deps, send } = mk({
        ...failing,
        consumePendingDirectInviteMarker: vi.fn(async () => { const had = marker; marker = false; return had; }),
      });
      const content = signed(5);
      await expect(send('g1', content, 'e1')).rejects.toThrow('late step down');
      expect(marker).toBe(true); // not consumed yet
      expect(deps.enqueue).not.toHaveBeenCalled();
      healthy = true;
      await send('g1', content, 'e1'); // the sink's retry of the same row
      expect(deps.enqueue).toHaveBeenCalledTimes(1);
      await send('g1', content, 'e1'); // a further replay: marker gone, one-shot gate holds
      expect(deps.enqueue).toHaveBeenCalledTimes(1);
      const job = (deps.enqueue.mock.calls as unknown as Array<[() => Promise<void>]>)[0][0];
      await job();
      expect(deps.sendAnnouncement).toHaveBeenCalledTimes(1);
    },
  );

  it('the announcement is enqueued after every await of the handler (the last action), never earlier', async () => {
    const order: string[] = [];
    const { deps, send } = mk({
      consumePendingDirectInviteMarker: vi.fn(async () => { order.push('consume'); return true; }),
      recordRequestAnswered: vi.fn(async () => { order.push('recordRequestAnswered'); }),
      writeContactEntry: vi.fn(() => { order.push('writeContactEntry'); }),
      enqueue: vi.fn(() => { order.push('enqueue'); }),
    });
    await send('g1', signed(7));
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(order[order.length - 1]).toBe('enqueue');
    expect(order.indexOf('consume')).toBeGreaterThan(order.indexOf('writeContactEntry'));
  });
});
