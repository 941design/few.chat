// @vitest-environment node
/**
 * S13 / AC-MEM-4 over the REAL stores (fake-indexeddb, the production sink-path handlers behind a real history sink,
 * see ../handlers/realApp.ts): `purgeLocalGroup` removes EVERYTHING the group left behind, nothing of another group,
 * and the S3/S5/S6/S11 ledger obligations hold:
 *
 *  - history rows (sink), chat rows, message-edit pending signals + slot meta, reaction rows, the held-reaction queue
 *    (few:reactions:held:group:<id>), poll + vote rows and their pending queues, member profiles, invite links,
 *    pending join requests, pending-direct-invite markers (+ orphan declines), media, unread, the overlay row;
 *  - the own-send tracker forgets the group (S6);
 *  - a second call is a no-op (AC-MEM-4c);
 *  - ledger case (S3): own message, hung dispatch, leave, release -> no chat row for the left group (the sink's late
 *    retract carries reason `purged`, which the chat handler removes outright; the sink-side `remaining()` rule is S3/S5's own test).
 */
import 'fake-indexeddb/auto';
import { createStore, get as idbGet, keys as idbKeys } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chat from '@/src/lib/marmot/chatPersistence';
import * as reactions from '@/src/lib/reactions/api';
import * as edits from '@/src/lib/messageEdits/api';
import * as polls from '@/src/lib/marmot/pollPersistence';
import * as media from '@/src/lib/marmot/mediaPersistence';
import { clearMemberProfiles, deleteGroup, loadGroup, loadMemberProfiles, mergeMemberProfile, saveGroup } from '@/src/lib/marmot/groupStorage';
import { clearProfileRequestMemos } from '@/src/lib/marmot/profileRequestStorage';
import { clearInviteLinksForGroup, loadInviteLinks, saveInviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import { clearPendingJoinRequestsForGroup, loadAllPendingJoinRequests, savePendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';
import {
  clearPendingDirectInvitesForGroup,
  loadOrphanDeclines,
  loadPendingDirectInviteMarkers,
  recordOrphanDecline,
  recordPendingDirectInvite,
} from '@/src/lib/marmot/pendingDirectInviteStorage';
import { clearInviteExpiries, clearJoinRequestGroup, clearUnreadGroup, incrementUnread } from '@/src/lib/unreadStore';
import { createInvitationActions } from '@/src/lib/marmot/invitations';
import { createLocalGroupPurger, type AbandonableGroup, type PurgeLocalGroupDeps } from '@/src/lib/marmot/membership';
import { createOwnRowTracker } from '@/src/lib/marmot/send';
import { ALICE, BOB, buildRealApp, installLocalStorage, SELF, unreadOf, type RealApp } from '../handlers/realApp';
import { snapshot } from '../handlers/oracle';

vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));

const T = 1_700_000_000;
let apps: RealApp[] = [];
const make = (o?: Parameters<typeof buildRealApp>[0]) => {
  const app = buildRealApp(o);
  apps.push(app);
  return app;
};
beforeEach(async () => {
  installLocalStorage();
  apps = [];
  await edits.clearAllMessageEditsState();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps) await app.sink.dispose();
});

const pollOpen = (id: string) =>
  JSON.stringify({ id, title: 'Lunch?', options: [{ id: 'A', label: 'Pizza' }, { id: 'B', label: 'Soup' }], pollType: 'singlechoice', creatorPubkey: ALICE });

/** Seeds every store a group writes to, through the production sink path where one exists. */
async function seed(app: RealApp): Promise<void> {
  const g = app.groupId;
  const e = (o: Parameters<RealApp['entry']>[0]) => app.sink.append(app.entry(o));
  await e({ eventId: 'm1', account: ALICE, rumorId: 'msg-1', content: 'hello', at: T });
  await e({ eventId: 'own1', account: SELF, rumorId: 'own-1', content: 'mine', at: T + 1 });
  // an edit -> slot meta; a delete of an unknown message -> pending signal
  await e({ eventId: 'ed1', account: ALICE, rumorId: 'edit-1', content: 'hello (edited)', tags: [['e', 'msg-1', '', 'edit'], ['rev', String(T + 10)]], at: T + 10 });
  await e({ eventId: 'del1', account: ALICE, kind: 5, rumorId: 'del-1', content: '', tags: [['e', 'ghost']], at: T + 11 });
  // reactions: one applied, one whose target never arrived (held)
  await e({ eventId: 'rx1', account: BOB, kind: 7, rumorId: 'rx-1', content: '+', tags: [['e', 'msg-1']], at: T + 12 });
  await e({ eventId: 'rx2', account: BOB, kind: 7, rumorId: 'rx-2', content: '+', tags: [['e', 'never-arrives']], at: T + 13 });
  // a poll with a vote
  await e({ eventId: 'p1', account: ALICE, kind: 10, rumorId: `poll-${g.slice(0, 8)}`, content: pollOpen(`poll-${g.slice(0, 8)}`), at: T + 14 });
  await e({ eventId: 'v1', account: BOB, kind: 11, rumorId: 'vote-1', content: JSON.stringify({ pollId: `poll-${g.slice(0, 8)}`, responses: ['A'], seq: 1 }), at: T + 15 });
  await mergeMemberProfile(g, { pubkeyHex: BOB, nickname: 'Bob', avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  await saveInviteLink({ nonce: `n-${g.slice(0, 8)}`, groupId: g, createdAt: T, expiresAt: T + 1e9, usageCount: 0, expiryNotified: false, expiryAcknowledged: false, muted: false });
  await savePendingJoinRequest({ pubkeyHex: 'cc'.repeat(32), nonce: 'nn', groupId: g, receivedAt: Date.now(), eventId: `jr-${g.slice(0, 8)}` });
  await recordPendingDirectInvite(g, BOB, 'ref-1');
  await recordOrphanDecline(g, 'ref-orphan');
  await media.setBlob(g, 'fp1', { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' });
  await media.addMessageRef(g, 'fp1', 'msg-1');
  await saveGroup({ id: g, name: 'Seeded', createdAt: T, memberPubkeys: [SELF, BOB], relays: [] });
  incrementUnread(g);
}

/** Everything observable about one group, from every store the purge is meant to empty. */
async function residue(app: RealApp) {
  const g = app.groupId;
  const defaultKeys = (await idbKeys()).map(String).filter((k) => k.includes(g));
  const mediaKeys = [
    ...(await idbKeys(createStore('few-media-blobs', 'blobs'))),
    ...(await idbKeys(createStore('few-media-meta', 'meta'))),
  ]
    .map(String)
    .filter((k) => k.startsWith(`${g}:`));
  return {
    snapshot: await snapshot(app),
    defaultKeys,
    sinkRows: await app.row('m1'),
    ownRow: await app.row('own1'),
    members: await loadMemberProfiles(g),
    links: await loadInviteLinks(g),
    joinRequests: (await loadAllPendingJoinRequests()).filter((r) => r.groupId === g),
    markers: [...(await loadPendingDirectInviteMarkers(g))],
    orphans: (await loadOrphanDeclines()).filter((o) => o.groupId === g),
    mediaKeys,
    overlay: await loadGroup(g),
    unread: unreadOf(g),
  };
}

/** The group handle as the library presents it: `abandon()` drops it and calls the history sink's purge, like the library. */
function libraryGroup(app: RealApp, state: { group: AbandonableGroup | undefined; abandons: number }): AbandonableGroup {
  const group: AbandonableGroup = {
    abandon: async () => {
      state.abandons++;
      state.group = undefined;
      await app.sink.purge(app.groupId);
    },
  };
  return group;
}

function purgerFor(app: RealApp, state: { group: AbandonableGroup | undefined; abandons: number }, extra: Partial<PurgeLocalGroupDeps> = {}) {
  const forgotten: string[] = [];
  const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
  const realForget = tracker.forgetGroup.bind(tracker);
  const deps: PurgeLocalGroupDeps = {
    ownPubkey: SELF,
    getGroup: async () => state.group,
    history: app.sink,
    tracker: { forgetGroup: (g) => (forgotten.push(g), realForget(g)) },
    clearMessages: chat.clearMessages,
    clearMessageEdits: edits.clearMessageEditsStateForThread,
    clearReactions: reactions.clearReactionsForGroup,
    purgeHeldReactions: reactions.purgeHeldReactionsForGroup,
    clearPollData: polls.clearPollData,
    clearGroupMedia: media.clearGroupMedia,
    clearMemberProfiles,
    clearProfileRequestMemos,
    clearUnread: clearUnreadGroup,
    // the stored rows AND the in-memory badge, as the production wiring composes them
    clearPendingJoinRequests: async (g) => {
      await clearPendingJoinRequestsForGroup(g);
      clearJoinRequestGroup(g);
    },
    clearInviteLinks: clearInviteLinksForGroup,
    clearInviteExpiries,
    clearPendingDirectInvites: clearPendingDirectInvitesForGroup,
    clearInviteContexts: async () => undefined,
    removeOverlay: deleteGroup,
    onPurged: () => undefined,
    onError: () => undefined,
    ...extra,
  };
  return { purger: createLocalGroupPurger(deps), forgotten };
}

describe('purgeLocalGroup over the real stores (AC-MEM-4)', () => {
  it('removes every trace of the group, leaves another group byte-identical, forgets the tracker, abandons once', async () => {
    const a = make();
    const b = make();
    await seed(a);
    await seed(b);
    const before = await residue(a);
    // the seed really wrote into each store (a purge of an empty fixture would pass vacuously)
    expect(before.defaultKeys.length).toBeGreaterThanOrEqual(3);
    expect(before.sinkRows).toBeDefined();
    expect(before.members).toHaveLength(1);
    expect(before.links).toHaveLength(1);
    expect(before.joinRequests).toHaveLength(1);
    expect(before.markers).toHaveLength(1);
    expect(before.orphans).toHaveLength(1);
    expect(before.mediaKeys.length).toBeGreaterThanOrEqual(2);
    expect(before.overlay).toBeDefined();
    expect(before.unread).toBeGreaterThan(0);
    const snap = before.snapshot as { messages: unknown[]; reactions: unknown[]; polls: unknown[]; edits: { pending: unknown[]; slotMeta: unknown[] }; held: unknown[] };
    expect(snap.messages.length).toBeGreaterThan(1);
    expect(snap.reactions.length).toBeGreaterThan(0);
    expect(snap.polls.length).toBeGreaterThan(0);
    expect(snap.edits.pending.length + snap.edits.slotMeta.length).toBeGreaterThan(0);
    expect(snap.held.length).toBeGreaterThan(0);
    const bBefore = await residue(b);

    const state = { group: undefined as AbandonableGroup | undefined, abandons: 0 };
    state.group = libraryGroup(a, state);
    const { purger, forgotten } = purgerFor(a, state);
    await purger.purgeLocalGroup(a.groupId);

    expect(state.abandons).toBe(1);
    expect(forgotten).toEqual([a.groupId]);
    const after = await residue(a);
    expect(after.defaultKeys).toEqual([]);
    expect(after.sinkRows).toBeUndefined();
    expect(after.ownRow).toBeUndefined();
    expect(after.members).toEqual([]);
    expect(after.links).toEqual([]);
    expect(after.joinRequests).toEqual([]);
    expect(after.markers).toEqual([]);
    expect(after.orphans).toEqual([]);
    expect(after.mediaKeys).toEqual([]);
    expect(after.overlay).toBeUndefined();
    expect(after.unread).toBe(0);
    // reactions, held queue, polls, votes, slot meta, pending signals: the group's snapshot equals an EMPTY group's
    const empty = make();
    expect(after.snapshot).toEqual(await snapshot(empty));
    // the held queue and the reaction row are gone at the KEY level, not merely emptied
    expect(await idbGet(`few:reactions:group:${a.groupId}`)).toBeUndefined();
    expect(await idbGet(`few:reactions:held:group:${a.groupId}`)).toBeUndefined();

    // isolation: the other group's every store is exactly as it was
    expect(await residue(b)).toEqual(bBefore);
  });

  it('a second call is idempotent: no abandon, no error, nothing re-created (AC-MEM-4c)', async () => {
    const a = make();
    await seed(a);
    const state = { group: undefined as AbandonableGroup | undefined, abandons: 0 };
    state.group = libraryGroup(a, state);
    const { purger } = purgerFor(a, state);
    await purger.purgeLocalGroup(a.groupId);
    const once = await residue(a);
    await expect(purger.purgeLocalGroup(a.groupId)).resolves.toBeUndefined();
    expect(state.abandons).toBe(1);
    expect(await residue(a)).toEqual(once);
  });

  it('a group the library does NOT hold (startup reconciliation of an overlay-only group): the explicit sink purge removes its history rows', async () => {
    const a = make();
    await seed(a);
    expect(await a.row('m1')).toBeDefined();
    const { purger } = purgerFor(a, { group: undefined, abandons: 0 }); // no library group: no abandon, no library-side sink purge
    await purger.purgeLocalGroup(a.groupId);
    expect(await a.row('m1')).toBeUndefined();
    expect(await a.row('own1')).toBeUndefined();
    expect((await residue(a)).overlay).toBeUndefined();
  });

  it('a failing store keeps the overlay row (the retry key) and the retry completes the purge', async () => {
    const a = make();
    await seed(a);
    const state = { group: undefined as AbandonableGroup | undefined, abandons: 0 };
    state.group = libraryGroup(a, state);
    let failOnce = true;
    const { purger } = purgerFor(a, state, {
      clearGroupMedia: async (g) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('quota');
        }
        return media.clearGroupMedia(g);
      },
    });
    await expect(purger.purgeLocalGroup(a.groupId)).rejects.toThrow(/media/);
    expect((await residue(a)).overlay).toBeDefined();
    expect((await residue(a)).members).toEqual([]); // the other steps still ran
    await purger.purgeLocalGroup(a.groupId); // the startup reconciliation's retry
    const after = await residue(a);
    expect(after.overlay).toBeUndefined();
    expect(after.mediaKeys).toEqual([]);
  });
});

describe('ledger case (S3/S6): own message, hung dispatch, leave, release -> no chat row for the left group', () => {
  it('the late retract carries reason `purged`: the row the released dispatch writes is removed outright, no failed/retry hand-back', async () => {
    const app = make({ settleTimeoutMs: 60 });
    const g = app.groupId;
    // a peer message is stored first so the group is visibly non-empty
    await app.sink.append(app.entry({ eventId: 'm1', account: ALICE, rumorId: 'msg-1', content: 'hello', at: T }));

    // the OWN message's dispatch hangs inside the chat store write
    let release!: () => void;
    app.hooks.beforeAppend = new Promise<void>((resolve) => (release = resolve));
    const own = app.entry({ eventId: 'own1', account: SELF, rumorId: 'own-1', content: 'mine', at: T + 1 });
    const appended = app.sink.append(own).then(
      () => 'resolved',
      () => 'timed-out',
    );
    expect(await appended).toBe('timed-out'); // the sink's settle bound (60 ms) gave up on it

    // the user leaves: the library abandons the group (-> sink.purge) and the app purge runs
    const state = { group: undefined as AbandonableGroup | undefined, abandons: 0 };
    state.group = libraryGroup(app, state);
    const { purger } = purgerFor(app, state);
    await purger.purgeLocalGroup(g);
    expect(await app.row('own1')).toBeUndefined();
    expect((await app.messages()).map((m) => m.id)).toEqual([]);

    // release: the dispatch finishes AFTER the purge and writes its row; the armed late retract must remove it
    release();
    await vi.waitFor(async () => {
      expect(await app.messages()).toEqual([]);
    }, { timeout: 3000 });
    // and it stays gone (no second write, no own-withdrawn hand-back that would park a failed/retry row)
    await new Promise((r) => setTimeout(r, 150));
    expect(await app.messages()).toEqual([]);
    expect(app.spies.onOwnWithdrawn).not.toHaveBeenCalled();
    expect(await app.row('own1')).toBeUndefined();
  });
});

describe('the seed itself (guards the real-store assertions against a vacuous fixture)', () => {
  it('seed() writes the group into the sink and the held queue under keys that contain the group id', async () => {
    const a = make();
    await seed(a);
    expect(await a.row('m1')).toBeDefined();
    expect(await idbGet(`few:reactions:held:group:${a.groupId}`)).toBeDefined();
    expect(await idbGet(`few:reactions:group:${a.groupId}`)).toBeDefined();
  });
});

describe('accept and purge are mutually exclusive per group id (real sink + chat store)', () => {
  it('an accept of an invitation to a group whose purge is running WAITS: the re-joined group\'s first messages are not wiped by the purge', async () => {
    const app = make();
    await seed(app);
    const state = { group: undefined as AbandonableGroup | undefined, abandons: 0 };
    state.group = libraryGroup(app, state);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedClear!: () => void;
    const atClear = new Promise<void>((resolve) => (reachedClear = resolve));
    const { purger } = purgerFor(app, state, {
      clearMessages: async (g) => {
        reachedClear();
        await gate; // the purge is mid-flight, about to delete the group's chat rows
        await chat.clearMessages(g);
      },
    });
    const purge = purger.purgeLocalGroup(app.groupId);
    await atClear;
    expect(purger.isPurging(app.groupId)).toBe(true);

    let accepts = 0;
    const invitation = { id: 'inv-1', groupId: app.groupId, sponsorAccount: ALICE, sponsors: [ALICE], keyPackageRef: 'kp', receivedAt: 1 };
    const actions = createInvitationActions({
      invitations: {
        pending: async () => [invitation] as never,
        decline: async () => undefined,
        accept: async () => {
          accepts++;
          // the new membership: its first message lands through the sink right after the join
          await app.sink.append(app.entry({ eventId: 'new1', account: ALICE, rumorId: 'new-msg-1', content: 'welcome back', at: T + 100 }));
          return { id: app.groupId } as never;
        },
      },
      view: { refresh: async () => [invitation] as never, isVisible: () => true },
      attachGroup: () => undefined,
      purge: purger,
    });
    const accepted = actions.accept('inv-1');
    await new Promise((r) => setTimeout(r, 30));
    expect(accepts).toBe(0); // deferred behind the purge

    release();
    await purge;
    await accepted;
    expect(accepts).toBe(1);
    expect(await app.row('new1')).toBeDefined(); // the purge did not run after the accept's first message
    expect((await app.messages()).map((m) => m.content)).toContain('welcome back');
  });
});
