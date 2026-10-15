import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// Mock idb-keyval — Map-backed so chatPersistence.ts's `appendMessage` (used by
// several tests below to seed persisted DM history the way a real received DM
// would) and unreadStore.ts's own raw `idb-keyval` reads (both
// `initDirectMessageCounts` and `reconcileConfirmedContactDirectMessageCount`,
// epic: pending-contact-confirmation, S2 gate-remediation) share the same fake
// store as the bottom-of-file reconciliation tests, which grab `idb.get`
// directly and temporarily override its implementation.
const idbStore = new Map<string, unknown>();
// Pending join requests live in their OWN IDB database (joinRequestStorage.ts's
// `createStore('few-join-requests', 'requests')`), not in the flat key space
// above — so they get their own backing map here. `initJoinRequestCounts` reads
// them via `entries(store)`; the store handle itself is opaque to this mock.
const joinRequestIdbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({ __store: 'few-join-requests' })),
  entries: vi.fn(async () => [...joinRequestIdbStore.entries()]),
  clear: vi.fn(async () => { joinRequestIdbStore.clear(); }),
}));

// Mock react — useSyncExternalStore just calls getSnapshot
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: any, getSnapshot: any) => getSnapshot(),
}));

beforeEach(() => {
  localStorageMock.clear();
  idbStore.clear();
  joinRequestIdbStore.clear();
});

describe('unreadStore join request counters', () => {
  // We import once — module state persists across tests in same describe,
  // but that's fine since we test incremental behavior.
  // For isolation we test sequences within individual tests.

  it('incrementJoinRequest increases counter for a group', async () => {
    const {
      incrementJoinRequest,
      markJoinRequestsRead,
      clearJoinRequestGroup,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    // Reset any prior state by clearing
    clearJoinRequestGroup('group-a');
    clearJoinRequestGroup('group-b');

    incrementJoinRequest('group-a');
    const s1 = useUnreadCounts();
    expect(s1.joinRequests['group-a']).toBe(1);

    incrementJoinRequest('group-a');
    const s2 = useUnreadCounts();
    expect(s2.joinRequests['group-a']).toBe(2);

    incrementJoinRequest('group-b');
    const s3 = useUnreadCounts();
    expect(s3.joinRequests['group-b']).toBe(1);
    expect(s3.joinRequests['group-a']).toBe(2);
  });

  it('markJoinRequestsRead resets counter to 0', async () => {
    const {
      incrementJoinRequest,
      markJoinRequestsRead,
      clearJoinRequestGroup,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    clearJoinRequestGroup('group-c');
    incrementJoinRequest('group-c');
    incrementJoinRequest('group-c');
    incrementJoinRequest('group-c');

    markJoinRequestsRead('group-c');
    const s = useUnreadCounts();
    expect(s.joinRequests['group-c']).toBeUndefined();
  });

  it('clearJoinRequestGroup removes tracking', async () => {
    const {
      incrementJoinRequest,
      clearJoinRequestGroup,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    clearJoinRequestGroup('group-d');
    incrementJoinRequest('group-d');
    incrementJoinRequest('group-d');

    clearJoinRequestGroup('group-d');
    const s = useUnreadCounts();
    expect(s.joinRequests['group-d']).toBeUndefined();
  });

  it('markJoinRequestsRead is a no-op for unknown group', async () => {
    const { markJoinRequestsRead, useUnreadCounts } = await import('@/src/lib/unreadStore');
    // Should not throw
    markJoinRequestsRead('nonexistent');
    const s = useUnreadCounts();
    expect(s.joinRequests['nonexistent']).toBeUndefined();
  });

  it('totalUnread sums both counts and joinRequests', async () => {
    const {
      incrementUnread,
      incrementJoinRequest,
      markAsRead,
      clearJoinRequestGroup,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    // Clear prior state
    markAsRead('group-e');
    markAsRead('group-f');
    clearJoinRequestGroup('group-e');
    clearJoinRequestGroup('group-f');

    incrementUnread('group-e');
    incrementUnread('group-e');
    incrementJoinRequest('group-f');

    const s = useUnreadCounts();
    // 2 unread messages + 1 join request = 3
    expect(s.totalUnread).toBeGreaterThanOrEqual(3);
    expect(s.counts['group-e']).toBe(2);
    expect(s.joinRequests['group-f']).toBe(1);
  });

  it('useUnreadCounts returns joinRequests field', async () => {
    const { useUnreadCounts } = await import('@/src/lib/unreadStore');
    const s = useUnreadCounts();
    expect(s).toHaveProperty('joinRequests');
    expect(typeof s.joinRequests).toBe('object');
  });

  it('exports all join request functions for test bridge', async () => {
    // The window.__fewUnread bridge is set at module load time only when
    // typeof window !== 'undefined'. In Vitest (no jsdom), window is undefined.
    // Instead we verify the functions are exported — the bridge just
    // re-exports these same references.
    const mod = await import('@/src/lib/unreadStore');
    expect(typeof mod.incrementJoinRequest).toBe('function');
    expect(typeof mod.markJoinRequestsRead).toBe('function');
    expect(typeof mod.clearJoinRequestGroup).toBe('function');
  });

  it('join request operations do not affect message counts', async () => {
    const {
      incrementUnread,
      incrementJoinRequest,
      clearJoinRequestGroup,
      markAsRead,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    // Set up known state
    markAsRead('group-g');
    clearJoinRequestGroup('group-g');

    incrementUnread('group-g');
    incrementUnread('group-g');
    incrementJoinRequest('group-g');

    const s1 = useUnreadCounts();
    expect(s1.counts['group-g']).toBe(2);
    expect(s1.joinRequests['group-g']).toBe(1);

    // Clear join requests — counts should remain
    clearJoinRequestGroup('group-g');
    const s2 = useUnreadCounts();
    expect(s2.counts['group-g']).toBe(2);
    expect(s2.joinRequests['group-g']).toBeUndefined();
  });
});

describe('unreadStore direct-message counters', () => {
  const PEER_A = 'aa'.repeat(32);
  const PEER_B = 'bb'.repeat(32);

  it('incrementDirectMessage tracks per-peer counts and feeds totalUnread', async () => {
    const {
      incrementDirectMessage,
      clearDirectMessageContact,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    clearDirectMessageContact(PEER_A);
    clearDirectMessageContact(PEER_B);

    incrementDirectMessage(PEER_A);
    incrementDirectMessage(PEER_A);
    incrementDirectMessage(PEER_B);

    const s = useUnreadCounts();
    expect(s.directMessages[PEER_A]).toBe(2);
    expect(s.directMessages[PEER_B]).toBe(1);
    // 3 DMs counted in totalUnread
    expect(s.totalUnread).toBeGreaterThanOrEqual(3);
  });

  it('peer pubkey is normalised to lowercase', async () => {
    const {
      incrementDirectMessage,
      clearDirectMessageContact,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    const mixed = 'AbCdEf' + '00'.repeat(29);
    clearDirectMessageContact(mixed);

    incrementDirectMessage(mixed);
    incrementDirectMessage(mixed.toLowerCase());

    const s = useUnreadCounts();
    expect(s.directMessages[mixed.toLowerCase()]).toBe(2);
    // The mixed-case key should not also exist
    expect(s.directMessages[mixed]).toBeUndefined();
  });

  it('markDirectMessagesRead resets the counter and persists timestamp', async () => {
    const {
      incrementDirectMessage,
      markDirectMessagesRead,
      getDirectMessageLastReadAt,
      clearDirectMessageContact,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    const PEER = 'cc'.repeat(32);
    clearDirectMessageContact(PEER);

    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    expect(useUnreadCounts().directMessages[PEER]).toBe(2);

    markDirectMessagesRead(PEER);
    const after = useUnreadCounts();
    expect(after.directMessages[PEER]).toBeUndefined();
    expect(getDirectMessageLastReadAt(PEER)).toBeGreaterThan(0);
  });

  it('clearDirectMessageContact removes both count and last-read timestamp', async () => {
    const {
      incrementDirectMessage,
      markDirectMessagesRead,
      clearDirectMessageContact,
      getDirectMessageLastReadAt,
      useUnreadCounts,
    } = await import('@/src/lib/unreadStore');

    const PEER = 'dd'.repeat(32);
    incrementDirectMessage(PEER);
    markDirectMessagesRead(PEER);
    expect(getDirectMessageLastReadAt(PEER)).toBeGreaterThan(0);

    clearDirectMessageContact(PEER);
    expect(useUnreadCounts().directMessages[PEER]).toBeUndefined();
    expect(getDirectMessageLastReadAt(PEER)).toBe(0);
  });

  it('exports DM functions for the test bridge', async () => {
    const mod = await import('@/src/lib/unreadStore');
    expect(typeof mod.incrementDirectMessage).toBe('function');
    expect(typeof mod.markDirectMessagesRead).toBe('function');
    expect(typeof mod.clearDirectMessageContact).toBe('function');
    expect(typeof mod.getDirectMessageLastReadAt).toBe('function');
    expect(typeof mod.initDirectMessageCounts).toBe('function');
  });
});

describe('unreadStore init reconciliation (live increment during init)', () => {
  it('preserves a live increment that arrives during initUnreadCounts (no startup clobber)', async () => {
    const unread = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const getMock = idb.get as unknown as ReturnType<typeof vi.fn>;
    const prev = getMock.getMockImplementation();

    // Scan sees 1 message and, mid-scan, a live message arrives for the same
    // group (chatHandler persists BEFORE incrementUnread, so by re-read time IDB
    // holds 2). The old wholesale-replace would clobber the count back to the
    // stale scan value (1); reconciliation re-reads and reports the true 2.
    let reads = 0;
    getMock.mockImplementation(async (key: string) => {
      if (key === 'few:messages:race-g1') {
        reads += 1;
        if (reads === 1) {
          unread.incrementUnread('race-g1');
          return [{ id: 'a', createdAt: 10, senderPubkey: 'peer' }];
        }
        return [
          { id: 'a', createdAt: 10, senderPubkey: 'peer' },
          { id: 'b', createdAt: 20, senderPubkey: 'peer' },
        ];
      }
      return undefined;
    });

    await unread.initUnreadCounts(['race-g1'], 'own');
    expect(unread.useUnreadCounts().counts['race-g1']).toBe(2);

    getMock.mockImplementation(prev ?? (async () => undefined));
  });

  it('does not double-count when the live message was already in the scan snapshot', async () => {
    const unread = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const getMock = idb.get as unknown as ReturnType<typeof vi.fn>;
    const prev = getMock.getMockImplementation();

    // Here the scan already sees both messages (the live one was persisted before
    // the scan read the key). The re-read returns the same 2 — authoritative IDB
    // count, NOT scan(2) + live-bump(1) = 3.
    getMock.mockImplementation(async (key: string) => {
      if (key === 'few:messages:race-g2') {
        unread.incrementUnread('race-g2');
        return [
          { id: 'a', createdAt: 10, senderPubkey: 'peer' },
          { id: 'b', createdAt: 20, senderPubkey: 'peer' },
        ];
      }
      return undefined;
    });

    await unread.initUnreadCounts(['race-g2'], 'own');
    expect(unread.useUnreadCounts().counts['race-g2']).toBe(2);

    getMock.mockImplementation(prev ?? (async () => undefined));
  });
});

describe('reconcileConfirmedContactDirectMessageCount — raw idb-keyval read path (epic: pending-contact-confirmation, AC-OBS-2)', () => {
  // Gate-remediation (2026-07-15, second round): reconcileConfirmedContactDirectMessageCount
  // was originally routed through chatPersistence.ts#loadMessages on the theory
  // that triggering its self-heal pass early was safe here, since the user is
  // about to open that exact thread anyway. That was wrong: loadMessages
  // self-heals a thread only ONCE per session, and this function runs on
  // EVERY confirm (including the still-live detail-view confirm path via
  // PendingConfirmationPrompt.tsx) — so it could easily be the FIRST caller
  // to touch loadMessages for a thread, permanently consuming the one-time
  // repair opportunity (and discarding its refetchIds) before ContactChat's
  // own later loadMessages call ever got to see them. Fixed to use the same
  // raw, side-effect-free idb-keyval read that initDirectMessageCounts uses.
  //
  // These tests seed persisted messages through chatPersistence's own
  // `appendMessage` (the real write path a received DM goes through), not by
  // poking the fake idb-keyval store directly — appendMessage writes to the
  // exact same `few:messages:dm:<peer>` key the raw read consumes, so this
  // still exercises the real on-disk shape without depending on
  // loadMessages. See the describe block below (mirroring
  // initDirectMessageCounts's own coverage) for the proof that this function
  // never touches loadMessages / never triggers self-heal.

  it('counts DM messages persisted via chatPersistence#appendMessage, excluding own messages', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const { reconcileConfirmedContactDirectMessageCount, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    const OWN = 'ff'.repeat(32);
    const PEER = 'ee'.repeat(32);
    clearDirectMessageContact(PEER);

    const threadId = directConversationId(PEER);
    await appendMessage(threadId, { id: 'm1', content: 'hi', senderPubkey: PEER, groupId: threadId, createdAt: 1000 });
    await appendMessage(threadId, { id: 'm2', content: 'hi again', senderPubkey: PEER, groupId: threadId, createdAt: 2000 });
    await appendMessage(threadId, { id: 'm3', content: 'reply', senderPubkey: OWN, groupId: threadId, createdAt: 3000 });

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);
    expect(useUnreadCounts().directMessages[PEER]).toBe(2);
  });

  it('counts N already-persisted messages the way the confirm-action reconciliation call would (AC-OBS-2)', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const { reconcileConfirmedContactDirectMessageCount, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    const OWN = 'aa'.repeat(32);
    const PEER = 'bb'.repeat(32);
    clearDirectMessageContact(PEER);

    const threadId = directConversationId(PEER);
    // This seeds persisted messages directly, which exercises
    // reconcileConfirmedContactDirectMessageCount's counting mechanics in
    // isolation — `confirmPendingContact` (PendingConfirmationPrompt.tsx)
    // calls this exact function. It is NOT a simulation of the real
    // pending-contact timeline: per AC-OBS-2 (amended 2026-07-15, spec.md
    // `## Amendments`), a contact's messages are only persisted once their
    // `ContactChat` has mounted at least once, which never happens while
    // still pending — so at real confirm time this read typically finds
    // nothing yet and resolves to 0. The real catch-up for a genuinely-
    // never-opened conversation happens on first open instead, via
    // `ContactChat`'s own history load + `markDirectMessagesRead` (see the
    // e2e coverage in dm-pairing-pending-confirmation.spec.ts).
    for (let i = 0; i < 3; i++) {
      await appendMessage(threadId, { id: `held-${i}`, content: `msg ${i}`, senderPubkey: PEER, groupId: threadId, createdAt: 1000 + i * 100 });
    }

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);
    expect(useUnreadCounts().directMessages[PEER]).toBe(3);
  });

  it('a mixed-case peer input resolves to the same lowercase thread key chatPersistence itself writes under', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const { reconcileConfirmedContactDirectMessageCount, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    const OWN = 'cc'.repeat(32);
    const PEER_MIXED = 'Dd'.repeat(32);
    const PEER_LOWER = PEER_MIXED.toLowerCase();
    clearDirectMessageContact(PEER_LOWER);

    const threadId = directConversationId(PEER_MIXED); // directConversationId lowercases internally
    await appendMessage(threadId, { id: 'mix-1', content: 'hi', senderPubkey: PEER_LOWER, groupId: threadId, createdAt: 1000 });

    await reconcileConfirmedContactDirectMessageCount(PEER_MIXED, OWN);
    expect(useUnreadCounts().directMessages[PEER_LOWER]).toBe(1);
  });

  it('does not lose a live incrementDirectMessage bump that lands while the reconcile read is in flight (Codex P2, gate-remediation 2026-07-15)', async () => {
    // Unlike incrementUnread's group-chat counterpart, incrementDirectMessage
    // never persists message content — only ContactChat mounting does. So a
    // DM that arrives WHILE this reconcile's raw idb-keyval read is in flight
    // can never be seen by the recompute; the recompute must not be allowed
    // to overwrite that live bump back down (reconcileInit's own "authoritative
    // recompute supersedes the live bump" behavior is correct for its other
    // callers, but wrong for this one — see reconcileFloor's comment in
    // unreadStore.ts).
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const {
      reconcileConfirmedContactDirectMessageCount,
      useUnreadCounts,
      clearDirectMessageContact,
      incrementDirectMessage,
    } = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const getMock = idb.get as unknown as ReturnType<typeof vi.fn>;
    const prev = getMock.getMockImplementation();

    const OWN = '11'.repeat(32);
    const PEER = '22'.repeat(32);
    clearDirectMessageContact(PEER);

    const threadId = directConversationId(PEER);
    const storageKey = `few:messages:${threadId}`;

    // Two messages already persisted AND already live-counted — a baseline
    // unread count the reconcile is expected to reproduce.
    await appendMessage(threadId, { id: 'p1', content: 'held-1', senderPubkey: PEER, groupId: threadId, createdAt: 1000 });
    await appendMessage(threadId, { id: 'p2', content: 'held-2', senderPubkey: PEER, groupId: threadId, createdAt: 2000 });
    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    expect(useUnreadCounts().directMessages[PEER]).toBe(2);

    // Simulate a THIRD DM landing on the wire while the raw idb-keyval read
    // is still in flight: the live bell bump fires (directMessageNotifications.ts),
    // bumping the visible count to 3, but its content is never persisted by
    // the bump itself — so the reconcile's persisted-history recompute keeps
    // finding only the 2 already-persisted messages.
    let fired = false;
    getMock.mockImplementation(async (key: string) => {
      if (key === storageKey && !fired) {
        fired = true;
        incrementDirectMessage(PEER);
      }
      return prev ? prev(key) : undefined;
    });

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);

    // Without the fix, the recompute (2, matching only the persisted
    // messages) would overwrite the live bump (3) back down. The final count
    // must never be lower than what the live increment alone produced.
    expect(useUnreadCounts().directMessages[PEER]).toBeGreaterThanOrEqual(3);

    getMock.mockImplementation(prev ?? (async () => undefined));
  });

  it('never calls chatPersistence#loadMessages, so it can never consume that thread\'s one-time self-heal/refetch opportunity (gate-remediation, second round, 2026-07-15)', async () => {
    // The structural bug this test guards against: loadMessages self-heals a
    // thread only on its FIRST call in a session and returns real refetchIds
    // only that once; every later call to the same thread short-circuits to
    // refetchIds: []. reconcileConfirmedContactDirectMessageCount runs on
    // EVERY confirm (including the still-live detail-view confirm path), so
    // if it called loadMessages it could easily be the first caller for a
    // thread — permanently and silently discarding a genuine repair
    // opportunity before ContactChat's own mount-time loadMessages call ever
    // got a chance to see it.
    const { directConversationId } = await import('@/src/lib/directMessages');
    const chatPersistence = await import('@/src/lib/marmot/chatPersistence');
    const { reconcileConfirmedContactDirectMessageCount, clearDirectMessageContact } = await import('@/src/lib/unreadStore');
    const loadMessagesSpy = vi.spyOn(chatPersistence, 'loadMessages');

    const OWN = '55'.repeat(32);
    const PEER = '66'.repeat(32);
    clearDirectMessageContact(PEER);

    // Seed a malformed row (non-canonical id) directly via the raw idb-keyval
    // key reconcileConfirmedContactDirectMessageCount itself reads —
    // simulating a thread that genuinely needs a self-heal/refetch repair
    // and hasn't been opened yet.
    const idb = await import('idb-keyval');
    await idb.set(`few:messages:dm:${PEER}`, [
      { id: 'not-a-canonical-hex-id', content: 'hi', senderPubkey: PEER, groupId: directConversationId(PEER), createdAt: 1000 },
    ]);

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);

    expect(loadMessagesSpy).not.toHaveBeenCalled();

    // The reconcile must not have marked the thread healed either — loadMessages,
    // called later (as ContactChat would on mount), must still see the
    // malformed row and report it via refetchIds.
    const { refetchIds } = await chatPersistence.loadMessages(directConversationId(PEER));
    expect(refetchIds).toContain('not-a-canonical-hex-id');

    loadMessagesSpy.mockRestore();
  });
});

describe('initDirectMessageCounts — batch/startup path never touches self-heal (epic: pending-contact-confirmation, S2 gate-remediation)', () => {
  // Codex P2 finding (2026-07-15): initDirectMessageCounts (called by
  // DirectMessageNotificationsWatcher at startup for every known peer) must
  // NOT route through chatPersistence.ts#loadMessages — doing so runs the DM
  // self-heal pass and marks the thread "healed" before ContactChat ever
  // mounts for that peer, discarding loadMessages' refetchIds and starving
  // ContactChat's own later call of the self-heal/refetch signal for a
  // thread that genuinely needed repair. These tests prove the batch path
  // never invokes loadMessages at all, so it can never trigger or discard
  // that side effect.

  it('does not call chatPersistence#loadMessages (raw idb-keyval read only)', async () => {
    const chatPersistence = await import('@/src/lib/marmot/chatPersistence');
    const { initDirectMessageCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');
    const loadMessagesSpy = vi.spyOn(chatPersistence, 'loadMessages');

    const OWN = '11'.repeat(32);
    const PEER = '22'.repeat(32);
    clearDirectMessageContact(PEER);

    await initDirectMessageCounts([PEER], OWN);

    expect(loadMessagesSpy).not.toHaveBeenCalled();
    loadMessagesSpy.mockRestore();
  });

  it('does not mark a never-opened DM thread as self-healed, preserving refetchIds for ContactChat', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const chatPersistence = await import('@/src/lib/marmot/chatPersistence');
    const { initDirectMessageCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    const OWN = '33'.repeat(32);
    const PEER = '44'.repeat(32);
    clearDirectMessageContact(PEER);

    // Seed a malformed row (non-canonical id) directly via the raw idb-keyval
    // key initDirectMessageCounts itself reads — simulating a thread that
    // genuinely needs a self-heal/refetch repair and hasn't been opened yet.
    const idb = await import('idb-keyval');
    await idb.set(`few:messages:dm:${PEER}`, [
      { id: 'not-a-canonical-hex-id', content: 'hi', senderPubkey: PEER, groupId: directConversationId(PEER), createdAt: 1000 },
    ]);

    await initDirectMessageCounts([PEER], OWN);

    // The startup scan must not have run self-heal / marked the thread
    // healed — loadMessages, called later (as ContactChat would on mount),
    // must still see the malformed row and report it via refetchIds.
    const { refetchIds } = await chatPersistence.loadMessages(directConversationId(PEER));
    expect(refetchIds).toContain('not-a-canonical-hex-id');
  });
});

describe('initDirectMessageCounts — pending contacts never light the bell (AC-OBS-1, gate-remediation finding C)', () => {
  // The live-increment path (directMessageNotifications.ts) already gates on
  // isPendingConfirmation. This is the batch-scan half of that pair: it
  // recomputes unread counts from persisted history, so without its own gate a
  // pending contact's stored messages would light the bell before the user ever
  // confirmed the pairing — leaking "someone paired with you" past the
  // confirmation gate, which is exactly what a leaked contact card would do.
  //
  // The filter is asserted HERE, inside the entrypoint, rather than at the
  // caller: these tests pass the pending peer in explicitly, so they fail if
  // anyone relocates the gate back out to a call site.

  const OWN = '55'.repeat(32);
  const PENDING_PEER = '66'.repeat(32);
  const CONFIRMED_PEER = '77'.repeat(32);

  async function seedUnreadHistory(peer: string) {
    const idb = await import('idb-keyval');
    await idb.set(`few:messages:dm:${peer}`, [
      { id: 'a'.repeat(64), content: 'held', senderPubkey: peer, createdAt: 9_999_999_999 },
    ]);
  }

  beforeEach(() => {
    localStorageMock.clear();
    idbStore.clear();
  });

  it('does not count a pending contact even when the caller passes it in and unread history exists', async () => {
    const { rememberPendingContact } = await import('@/src/lib/contacts');
    const { initDirectMessageCounts, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    clearDirectMessageContact(PENDING_PEER);
    rememberPendingContact(PENDING_PEER, '2026-06-01T00:00:00.000Z');
    await seedUnreadHistory(PENDING_PEER);

    await initDirectMessageCounts([PENDING_PEER], OWN);

    expect(useUnreadCounts().directMessages[PENDING_PEER] ?? 0).toBe(0);
  });

  it('counts the same history once the contact is confirmed', async () => {
    const { rememberPendingContact, confirmContact } = await import('@/src/lib/contacts');
    const { initDirectMessageCounts, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');

    clearDirectMessageContact(CONFIRMED_PEER);
    rememberPendingContact(CONFIRMED_PEER, '2026-06-01T00:00:00.000Z');
    await seedUnreadHistory(CONFIRMED_PEER);

    await initDirectMessageCounts([CONFIRMED_PEER], OWN);
    expect(useUnreadCounts().directMessages[CONFIRMED_PEER] ?? 0).toBe(0);

    confirmContact(CONFIRMED_PEER);
    await initDirectMessageCounts([CONFIRMED_PEER], OWN);

    expect(useUnreadCounts().directMessages[CONFIRMED_PEER]).toBe(1);
  });
});

describe('initDirectMessageCounts — blocked (archived) contacts never count (BACKLOG one-time-migration-clear-stale-unread)', () => {
  // Contacts hidden before the block-contact epic became "blocked" with their
  // history kept (product decision 2026-07-14). Their chat cannot be opened to
  // mark read, so the startup scan must not count them — and must clear any
  // counter they already hold. Counters only: history and last-read
  // timestamps are left untouched (an unblock restores the real unread state).

  const OWN = '58'.repeat(32);
  const BLOCKED_PEER = '68'.repeat(32);
  const NORMAL_PEER = '78'.repeat(32);

  async function seedUnreadHistory(peer: string) {
    const idb = await import('idb-keyval');
    await idb.set(`few:messages:dm:${peer}`, [
      { id: 'b'.repeat(64), content: 'old', senderPubkey: peer, createdAt: 9_999_999_999 },
    ]);
  }

  beforeEach(() => {
    localStorageMock.clear();
    idbStore.clear();
  });

  it('does not count a blocked contact with unread history, but still counts a normal one', async () => {
    const { rememberContact, archiveContact } = await import('@/src/lib/contacts');
    const { initDirectMessageCounts, useUnreadCounts, clearDirectMessageContact } = await import('@/src/lib/unreadStore');
    clearDirectMessageContact(BLOCKED_PEER);
    clearDirectMessageContact(NORMAL_PEER);
    rememberContact(BLOCKED_PEER, '2026-06-01T00:00:00.000Z');
    rememberContact(NORMAL_PEER, '2026-06-01T00:00:00.000Z');
    archiveContact(BLOCKED_PEER);
    await seedUnreadHistory(BLOCKED_PEER);
    await seedUnreadHistory(NORMAL_PEER);

    await initDirectMessageCounts([BLOCKED_PEER, NORMAL_PEER], OWN);

    expect(useUnreadCounts().directMessages[BLOCKED_PEER] ?? 0).toBe(0);
    expect(useUnreadCounts().directMessages[NORMAL_PEER]).toBe(1);
  });

  it('clears a counter a blocked contact already holds, touching neither history nor last-read, idempotently', async () => {
    const { rememberContact, archiveContact } = await import('@/src/lib/contacts');
    const {
      initDirectMessageCounts, useUnreadCounts, clearDirectMessageContact, incrementDirectMessage,
      markDirectMessagesRead, getDirectMessageLastReadAt,
    } = await import('@/src/lib/unreadStore');
    clearDirectMessageContact(BLOCKED_PEER);
    rememberContact(BLOCKED_PEER, '2026-06-01T00:00:00.000Z');
    markDirectMessagesRead(BLOCKED_PEER);
    const lastRead = getDirectMessageLastReadAt(BLOCKED_PEER);
    incrementDirectMessage(BLOCKED_PEER);
    incrementDirectMessage(BLOCKED_PEER);
    expect(useUnreadCounts().directMessages[BLOCKED_PEER]).toBe(2);
    archiveContact(BLOCKED_PEER);
    await seedUnreadHistory(BLOCKED_PEER);

    clearDirectMessageContact(NORMAL_PEER);
    incrementDirectMessage(NORMAL_PEER); // a sibling counter the drop must not touch

    // Not even passed in by the caller: the prune covers every archived contact.
    await initDirectMessageCounts([], OWN);
    expect(BLOCKED_PEER in useUnreadCounts().directMessages).toBe(false);
    expect(useUnreadCounts().directMessages[NORMAL_PEER]).toBe(1);
    await initDirectMessageCounts([BLOCKED_PEER], OWN);
    expect(BLOCKED_PEER in useUnreadCounts().directMessages).toBe(false);

    const idb = await import('idb-keyval');
    expect(await idb.get(`few:messages:dm:${BLOCKED_PEER}`)).toHaveLength(1);
    expect(getDirectMessageLastReadAt(BLOCKED_PEER)).toBe(lastRead);
  });
});

describe('unreadStore mutation-gate: single-key mutations must not leak into sibling keys', () => {
  // Mutation-gate finding (Stryker id 70, line 189): `const next = { ...state.counts }`
  // is required — replacing it with `{}` produces a store where marking one
  // group as read wipes every other group's count as well. That mutant
  // survives the existing tests because they only ever hold one group's
  // count when they call markAsRead. Same-shape guards for the two other
  // single-key mutations that follow the same pattern (clearUnreadGroup /
  // clearDirectMessageContact) — cheap symmetry, and it prevents the
  // sibling-wipe regression from creeping back in via any of the three paths.

  it('markAsRead removes only the target group and leaves other groups\' counts intact', async () => {
    const { incrementUnread, markAsRead, useUnreadCounts } = await import('@/src/lib/unreadStore');

    markAsRead('mg-a');
    markAsRead('mg-b');

    incrementUnread('mg-a');
    incrementUnread('mg-a');
    incrementUnread('mg-b');
    expect(useUnreadCounts().counts['mg-a']).toBe(2);
    expect(useUnreadCounts().counts['mg-b']).toBe(1);

    markAsRead('mg-a');
    const after = useUnreadCounts();
    expect(after.counts['mg-a']).toBeUndefined();
    expect(after.counts['mg-b']).toBe(1);
  });

  it('clearUnreadGroup removes only the target group and leaves other groups\' counts intact', async () => {
    const { incrementUnread, clearUnreadGroup, markAsRead, useUnreadCounts } = await import('@/src/lib/unreadStore');

    markAsRead('cu-a');
    markAsRead('cu-b');

    incrementUnread('cu-a');
    incrementUnread('cu-b');
    incrementUnread('cu-b');
    expect(useUnreadCounts().counts['cu-a']).toBe(1);
    expect(useUnreadCounts().counts['cu-b']).toBe(2);

    clearUnreadGroup('cu-a');
    const after = useUnreadCounts();
    expect(after.counts['cu-a']).toBeUndefined();
    expect(after.counts['cu-b']).toBe(2);
  });

  it('clearDirectMessageContact removes only the target peer and leaves other peers\' counts intact', async () => {
    const { incrementDirectMessage, clearDirectMessageContact, useUnreadCounts } = await import('@/src/lib/unreadStore');

    const PEER_X = '77'.repeat(32);
    const PEER_Y = '99'.repeat(32);
    clearDirectMessageContact(PEER_X);
    clearDirectMessageContact(PEER_Y);

    incrementDirectMessage(PEER_X);
    incrementDirectMessage(PEER_X);
    incrementDirectMessage(PEER_Y);
    expect(useUnreadCounts().directMessages[PEER_X]).toBe(2);
    expect(useUnreadCounts().directMessages[PEER_Y]).toBe(1);

    clearDirectMessageContact(PEER_X);
    const after = useUnreadCounts();
    expect(after.directMessages[PEER_X]).toBeUndefined();
    expect(after.directMessages[PEER_Y]).toBe(1);
  });
});

describe('unreadStore mutation-gate: reconcileInit re-read must not clobber a live-bumped state with a stale zero', () => {
  // Mutation-gate finding (Stryker ids 41 & 43, line 118): the re-read loop's
  // `if (n > 0) next[key] = n; else delete next[key]` is required — if the
  // guard is relaxed (`if (true)` / `n >= 0`), a re-read that observes zero
  // messages will assign next[key] = 0 and the subsequent state merge
  // (`{ ...state.counts, ...next }`) overwrites the live-bumped count back
  // down to 0. The existing race tests only exercise re-reads that observe
  // MORE messages than the initial scan, so the zero-arm of the guard was
  // untested. Scenario here: the initial scan sees N > 0 messages and fires
  // a live increment mid-scan, but by re-read time the persisted history is
  // empty (e.g. concurrent thread clear) — the live-bumped count must
  // survive.

  it('a re-read that observes zero persisted messages must not overwrite the live-bumped count with 0', async () => {
    const unread = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const getMock = idb.get as unknown as ReturnType<typeof vi.fn>;
    const prev = getMock.getMockImplementation();

    let reads = 0;
    getMock.mockImplementation(async (key: string) => {
      if (key === 'few:messages:reread-zero') {
        reads += 1;
        if (reads === 1) {
          // Initial scan: sees 2 persisted, and mid-scan a live message arrives.
          unread.incrementUnread('reread-zero');
          return [
            { id: 'a', createdAt: 10, senderPubkey: 'peer' },
            { id: 'b', createdAt: 20, senderPubkey: 'peer' },
          ];
        }
        // Re-read: thread was cleared between scan and re-read — 0 messages.
        return [];
      }
      return undefined;
    });

    await unread.initUnreadCounts(['reread-zero'], 'own');
    // Original: the else-branch `delete next[key]` prevents `next` from
    // carrying a 0 into the state merge, so the live-bumped count survives.
    // Mutants 41/43 assign next[key] = 0, and the merge overwrites the live
    // count to 0.
    expect(unread.useUnreadCounts().counts['reread-zero']).toBeGreaterThan(0);

    getMock.mockImplementation(prev ?? (async () => undefined));
  });
});

describe('reconcileInit re-entrancy: overlapping directMessages reconciles must not clobber each other (gate-remediation, 2026-07-15)', () => {
  // Finding A: `reconcileConfirmedContactDirectMessageCount` (fired on every
  // pending-contact confirm) and `initDirectMessageCounts` (the startup
  // batch scan, called once) both reconcile the SAME 'directMessages' slice,
  // sharing the module-level `initInProgress`/`initTouched` state. Before the
  // fix, an overlapping confirm mid-scan would reset `initTouched` and clear
  // `initInProgress` while the batch scan was still awaiting its own reads —
  // silently dropping any live increment the batch scan should have re-read.
  // Fixed by serializing same-slice `reconcileInit` calls behind a promise
  // chain. This test proves both overlap-safety (a live bump during the
  // batch scan survives) AND actual serialization (the confirm-time read for
  // its own peer does not start until the batch scan's reconcileInit fully
  // completes).

  it('a confirm-time reconcile that overlaps the startup batch scan does not lose the scan\'s live-increment re-read, and runs strictly after the scan completes', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const {
      initDirectMessageCounts,
      reconcileConfirmedContactDirectMessageCount,
      useUnreadCounts,
      clearDirectMessageContact,
      incrementDirectMessage,
    } = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const getMock = idb.get as unknown as ReturnType<typeof vi.fn>;
    const prev = getMock.getMockImplementation();

    const OWN = 'a1'.repeat(32);
    const SCAN_PEER = 'b2'.repeat(32);
    const CONFIRM_PEER = 'c3'.repeat(32);
    clearDirectMessageContact(SCAN_PEER);
    clearDirectMessageContact(CONFIRM_PEER);

    const confirmThreadId = directConversationId(CONFIRM_PEER);
    const scanKey = `few:messages:dm:${SCAN_PEER}`;
    const confirmKey = `few:messages:dm:${CONFIRM_PEER}`;

    // The confirm-peer's history is already persisted (as it would be for a
    // conversation opened before the contact went pending).
    await appendMessage(confirmThreadId, { id: 'c1', content: 'hi', senderPubkey: CONFIRM_PEER, groupId: confirmThreadId, createdAt: 1000 });

    // Deferred gate: the startup scan's read of SCAN_PEER blocks until we
    // manually release it, simulating "the scan is still awaiting an idb
    // read when a confirm fires".
    let releaseScanRead: (() => void) | null = null;
    const scanReadGate = new Promise<void>((resolve) => { releaseScanRead = resolve; });
    const callOrder: string[] = [];
    let scanReads = 0;
    let liveBumpFired = false;

    getMock.mockImplementation(async (key: string) => {
      if (key === scanKey) {
        scanReads += 1;
        callOrder.push('scan-read-start');
        if (scanReads === 1) {
          await scanReadGate;
        }
        callOrder.push('scan-read-end');
        // A live message arrives for SCAN_PEER while the scan's FIRST read
        // for it is in flight — persisted (as a real DM would be once
        // ContactChat has mounted) and live-bumped, exactly once, exactly as
        // `reconcileInit`'s header comment describes. Only fired once (not
        // on every re-read pass) so the re-read loop's bounded convergence
        // is not itself what this test is exercising.
        if (!liveBumpFired) {
          liveBumpFired = true;
          incrementDirectMessage(SCAN_PEER);
        }
        return [{ id: 's1', createdAt: 5000, senderPubkey: SCAN_PEER }];
      }
      if (key === confirmKey) {
        callOrder.push('confirm-read');
      }
      return prev ? prev(key) : undefined;
    });

    // Start the batch scan but do not await it yet — it will block inside
    // its read of SCAN_PEER until `releaseScanRead` is called below.
    const scanPromise = initDirectMessageCounts([SCAN_PEER], OWN);

    // Give the scan a tick to actually start and hit its blocked read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callOrder).toEqual(['scan-read-start']);

    // Fire the confirm-time reconcile for a DIFFERENT peer while the scan is
    // still blocked. Before the fix this would run concurrently and corrupt
    // the scan's initTouched/initInProgress bookkeeping; after the fix it
    // must queue behind the scan.
    const confirmPromise = reconcileConfirmedContactDirectMessageCount(CONFIRM_PEER, OWN);

    // Give the confirm call a chance to run if (incorrectly) unserialized —
    // it must NOT have reached its own read yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callOrder).toEqual(['scan-read-start']);

    // Release the scan's blocked read, letting the batch scan finish.
    releaseScanRead!();
    await scanPromise;
    await confirmPromise;

    // Serialization proof: the confirm-time read only ran AFTER the scan's
    // reconcileInit fully resolved — including its bounded re-read pass for
    // the key the live increment touched (the scan reads scanKey twice: the
    // initial pass, then once more because the live bump above marked it
    // touched; the second read observes no NEW touch, so the re-read loop
    // exits and the scan completes).
    expect(callOrder).toEqual(['scan-read-start', 'scan-read-end', 'scan-read-start', 'scan-read-end', 'confirm-read']);

    // Overlap-safety proof: the scan's own live increment for SCAN_PEER (the
    // exact scenario this module's re-entrancy fix protects) survived intact.
    expect(useUnreadCounts().directMessages[SCAN_PEER]).toBe(1);
    // The confirm-time reconcile for its own (unrelated) peer completed
    // correctly too — neither call corrupted the other's result.
    expect(useUnreadCounts().directMessages[CONFIRM_PEER]).toBe(1);

    getMock.mockImplementation(prev ?? (async () => undefined));
  });
});

describe('unreadStore mutation-gate: reconcileConfirmedContactDirectMessageCount preserves pre-reconcile live count', () => {
  // Mutation-gate finding (Stryker id 192, line 467): `reconcileFloor[key] =
  // state.directMessages[key] ?? 0` is required — replacing `??` with `&&`
  // seeds the floor with 0 instead of the pre-reconcile live count. The
  // existing race test (line 429) happens to still pass under that mutant
  // because the mid-reconcile injected increment re-raises the floor via
  // Math.max. The gap: when a pre-existing live count is already on the
  // store (peer had DMs bumped by directMessageNotifications.ts before
  // confirm) AND the recompute yields a LOWER count (persisted history is
  // sparser than the live bell — the exact case the floor exists to guard
  // against), the mutant fails to floor the final value at the pre-reconcile
  // live count.

  it('when the recompute yields a lower count than the pre-reconcile live state, the floor preserves the live count', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const {
      reconcileConfirmedContactDirectMessageCount,
      useUnreadCounts,
      clearDirectMessageContact,
      incrementDirectMessage,
    } = await import('@/src/lib/unreadStore');

    const OWN = '77'.repeat(32);
    const PEER = '88'.repeat(32);
    clearDirectMessageContact(PEER);

    const threadId = directConversationId(PEER);
    // Only 2 messages ever made it to persisted history…
    await appendMessage(threadId, { id: 'a', content: 'hi', senderPubkey: PEER, groupId: threadId, createdAt: 1000 });
    await appendMessage(threadId, { id: 'b', content: 'hi2', senderPubkey: PEER, groupId: threadId, createdAt: 2000 });
    // …but the bell was live-bumped 4 times (a real-world case: DMs kept
    // arriving after the last time ContactChat mounted, so history persistence
    // never caught up).
    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    expect(useUnreadCounts().directMessages[PEER]).toBe(4);

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);

    // The recompute (2 persisted) alone would lower the count to 2; the floor
    // must preserve the pre-reconcile live value (4). Mutant 192 seeds the
    // floor with 0, so the reconcile silently drops the count to 2.
    expect(useUnreadCounts().directMessages[PEER]).toBeGreaterThanOrEqual(4);
  });
});

describe('unreadStore mutation-gate: confirming a contact never re-lights the bell for a conversation already read (epic-pending-contact-confirmation:AC-OBS-2)', () => {
  // Mutation-gate finding (Stryker ids 220 + 221, line 544): the confirm-time
  // reconcile's `m.createdAt > lastRead` filter survives both `>=` (id 221) and
  // `true` (id 220). The equal-boundary and already-read cases ARE asserted for
  // the two sibling scans — initUnreadCounts (line 285) and
  // initDirectMessageCounts (line 463), whose identical mutants both die — but
  // nothing pinned them for the confirm path, which the pending-contact epic
  // added. The gap: no test in this path ever put a message at or before the
  // peer's last-read mark, so a reconcile that counted already-read history as
  // unread would pass unnoticed.
  //
  // User story: AC-OBS-2 requires the bell to *correctly* reflect a confirmed
  // contact's messages. A conversation the user has already read must stay dark
  // when they confirm the contact — confirming is not a re-read event. The
  // boundary itself is read back through the store's own public getter rather
  // than reconstructed from a storage key or a clock, so this stays a statement
  // about "already read" and not about how the mark is persisted.

  it('counts only messages newer than the last time the user read the thread — a message exactly at the last-read mark is already read', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const {
      reconcileConfirmedContactDirectMessageCount,
      useUnreadCounts,
      clearDirectMessageContact,
      markDirectMessagesRead,
      getDirectMessageLastReadAt,
    } = await import('@/src/lib/unreadStore');

    const OWN = '11'.repeat(32);
    const PEER = '22'.repeat(32);
    clearDirectMessageContact(PEER);

    // Opening the thread is what makes "already read" true for this peer.
    markDirectMessagesRead(PEER);
    const lastRead = getDirectMessageLastReadAt(PEER);
    expect(lastRead).toBeGreaterThan(0);

    const threadId = directConversationId(PEER);
    await appendMessage(threadId, { id: 'older', content: 'read before', senderPubkey: PEER, groupId: threadId, createdAt: lastRead - 1000 });
    await appendMessage(threadId, { id: 'at-mark', content: 'read at the mark', senderPubkey: PEER, groupId: threadId, createdAt: lastRead });
    await appendMessage(threadId, { id: 'newer', content: 'arrived after', senderPubkey: PEER, groupId: threadId, createdAt: lastRead + 1000 });

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);

    // Only the message that arrived after the read is unread. Mutant 221 (`>=`)
    // also counts 'at-mark' (2); mutant 220 (`true`) counts all three (3).
    expect(useUnreadCounts().directMessages[PEER]).toBe(1);
  });
});

describe('unreadStore mutation-gate: the confirm-time floor is a floor, never a ceiling (epic-pending-contact-confirmation:AC-OBS-2)', () => {
  // Mutation-gate finding (Stryker id 231, line 554): `floor >
  // (state.directMessages[key] ?? 0)` survives `??` -> `&&`. The existing test
  // above (line 891) only covers floor(4) > recomputed(2): under the mutant
  // `2 && 0` is 0, so `4 > 0` still writes 4 and the result is identical. The
  // untested direction is the mirror image — the recompute finding MORE unread
  // than the bell currently shows. There, the real code correctly stands down
  // (`2 > 5` is false, the higher authoritative count survives) while the
  // mutant's `2 > 0` fires and drags the bell back down to 2.
  //
  // User story: AC-OBS-2 requires that confirming a contact loses no message.
  // The floor exists to stop a reconcile from *lowering* a count — so it must
  // never itself become the thing that lowers one. Whichever source knows about
  // more unread messages wins.

  it('keeps the higher recomputed count when persisted history holds more unread than the bell was showing', async () => {
    const { directConversationId } = await import('@/src/lib/directMessages');
    const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
    const {
      reconcileConfirmedContactDirectMessageCount,
      useUnreadCounts,
      clearDirectMessageContact,
      incrementDirectMessage,
    } = await import('@/src/lib/unreadStore');

    const OWN = '33'.repeat(32);
    const PEER = '44'.repeat(32);
    clearDirectMessageContact(PEER);

    // Five of this peer's messages are on disk (their conversation was opened
    // at some point, so history persistence caught up)…
    const threadId = directConversationId(PEER);
    for (let i = 0; i < 5; i++) {
      await appendMessage(threadId, { id: `held-${i}`, content: `msg ${i}`, senderPubkey: PEER, groupId: threadId, createdAt: 1000 + i * 100 });
    }
    // …but the bell only ever got two live bumps for them.
    incrementDirectMessage(PEER);
    incrementDirectMessage(PEER);
    expect(useUnreadCounts().directMessages[PEER]).toBe(2);

    await reconcileConfirmedContactDirectMessageCount(PEER, OWN);

    // The reconcile knows about more unread than the bell did, so the bell rises
    // to 5. Mutant 231 compares the floor against 0 instead of against the
    // recomputed count, so it fires and pulls the bell back down to 2 — losing
    // three messages the user was told about.
    expect(useUnreadCounts().directMessages[PEER]).toBe(5);
  });
});

describe('unreadStore mutation-gate: a join request arriving during the startup scan still reaches the badge', () => {
  // Mutation-gate finding (Stryker id 117, line 317): the slice name in
  // `noteLiveIncrement('joinRequests', groupId)` survives being blanked to `''`.
  // The same literal in incrementUnread ('counts') and incrementDirectMessage
  // ('directMessages') both die — only the join-request slice had no test, so
  // its startup-clobber protection was silently unasserted. Under the mutant the
  // arriving request is never queued for re-read and the stale scan snapshot
  // overwrites it.
  //
  // User story (no AC; see BACKLOG finding
  // initjoinrequestcounts-startup-scan-reconciliation — epic-group-invite-links
  // AC-6 specs the join-request counter API but says nothing about the startup
  // scan): a join request that lands while the app is still loading its badge
  // counts must still show up in the badge. This mirrors the invariant already
  // asserted for the chat-message slice at line 283.

  it('a join request that lands mid-scan is still counted once the scan finishes', async () => {
    const unread = await import('@/src/lib/unreadStore');
    const idb = await import('idb-keyval');
    const entriesMock = idb.entries as unknown as ReturnType<typeof vi.fn>;
    const prev = entriesMock.getMockImplementation();

    joinRequestIdbStore.set('evt-1', { groupId: 'race-jr1' });

    // welcomeSubscription persists a join request (savePendingJoinRequest) BEFORE
    // calling incrementJoinRequest, so by re-read time the store holds both — the
    // same persist-then-increment ordering the chat-message slice relies on.
    let reads = 0;
    entriesMock.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        joinRequestIdbStore.set('evt-2', { groupId: 'race-jr1' });
        unread.incrementJoinRequest('race-jr1');
        return [['evt-1', { groupId: 'race-jr1' }]];
      }
      return [...joinRequestIdbStore.entries()];
    });

    await unread.initJoinRequestCounts(['race-jr1']);

    // Both requests are pending, so the badge shows 2. Mutant 117 never queues
    // the mid-scan request for re-read, so the stale snapshot leaves it at 1.
    expect(unread.useUnreadCounts().joinRequests['race-jr1']).toBe(2);

    entriesMock.mockImplementation(prev ?? (async () => []));
  });
});
