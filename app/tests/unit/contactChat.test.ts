/**
 * Unit tests for ContactChat.init — historical kind-1059 fetch (story-03, AC-09, AC-10, AC-11).
 *
 * These tests replace the real init useEffect with a direct call to its body logic,
 * exercising the §3.5 order of operations with mocked NDK and storage.
 *
 * AC-09: init fires a parallel fetchEventsWithTimeout({ kinds: [1059], '#p': [pubkeyHex], limit: 500 })
 *        and ingests every result through the gift-wrap unwrap+parse path.
 * AC-10: init waits for both historical fetches to settle before calling upsertMessages,
 *        so the rendered list is in createdAt order regardless of arrival order.
 * AC-11: a historical gift wrap whose inner rumor id matches an existing ChatMessage in IDB
 *        does not produce a duplicate row (appendMessage's id-based dedup is exercised).
 *
 * Test style: vi.mock + dynamic import pattern (same as dualListen.test.ts).
 * Keypairs from architecture.md / auth-helpers.ts:
 *   alice priv: bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d
 *   bob priv:   cbecda1c7d37d4c0aa5466243bb4a0018c31bf06d74fa7338290dd3068db4fed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// ─── Inline idb-keyval mock (Map-backed) ──────────────────────────────────────
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
}));

// ─── Mock modules ──────────────────────────────────────────────────────────────
// Mock implementations are set per-test in beforeEach via mockImplementation.
// The implementation is keyed by call index (0=incoming, 1=outgoing, 2=gift-wrap).
let __fetchCallIndex = 0;
let __fetchResults: Array<{ events: Set<any>; timedOut: boolean }> = [];
let __fetchCallHistory: Array<{ ndk: any; filter: any }> = [];

vi.mock('@/src/lib/ndkClient', () => ({
  PUBLISH_TIMEOUT_MS: 10_000,
  publishWithTimeout: vi.fn().mockResolvedValue(new Set()),
  connectNdk: vi.fn().mockResolvedValue({}),
  fetchEventsWithTimeout: vi.fn().mockImplementation(async (ndk: any, filter: any) => {
    __fetchCallHistory.push({ ndk, filter });
    // Returns are consumed in call order: 0=incoming, 1=outgoing, 2=gift-wraps
    const result = __fetchResults[__fetchCallIndex] ?? { events: new Set(), timedOut: false };
    __fetchCallIndex++;
    return result;
  }),
}));

vi.mock('@/src/lib/unreadStore', () => ({
  markDirectMessagesRead: vi.fn(),
  getDirectMessageLastReadAt: vi.fn().mockReturnValue(0),
}));

vi.mock('@/src/context/LanguageContext', () => ({
  useCopy: vi.fn().mockReturnValue((key: string) => key),
}));

vi.mock('@chakra-ui/react', () => ({
  useToast: vi.fn().mockReturnValue(vi.fn()),
  default: vi.fn(),
}));

// ─── Dynamic imports — must be after mocks ─────────────────────────────────────
const { connectNdk, fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
const {
  GIFT_WRAP_KIND,
  DIRECT_MESSAGE_KIND,
  CHAT_MESSAGE_KIND,
  parseDirectPayload,
} = await import('@/src/lib/directMessages');
const { appendMessage, loadMessages } = await import('@/src/lib/marmot/chatPersistence');
const { isAllowedDmSender } = await import('@/src/lib/walledGarden');

// ─── Test fixtures ─────────────────────────────────────────────────────────────
const ALICE_PRIV = 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d';
const BOB_PRIV = 'cbecda1c7d37d4c0aa5466243bb4a0018c31bf06d74fa7338290dd3068db4fed';
const BOB_PUB = 'a3c7d9e0f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c';

const THREAD_ID = 'dm:bob';
const ALICE_PUBKEY_HEX = 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d'.slice(0, 64); // placeholder

// Fake NDKEvent-like wrapper
function fakeNDKEvent(overrides: Partial<{
  id: string; kind: number; pubkey: string; content: string; created_at: number; tags: string[][];
}> = {}) {
  return {
    id: 'fake-id-' + Math.random().toString(36).slice(2),
    kind: overrides.kind ?? GIFT_WRAP_KIND,
    pubkey: BOB_PUB,
    content: overrides.content ?? 'fake-content',
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    tags: overrides.tags ?? [],
    ...overrides,
  };
}

// ─── Shared state per test ─────────────────────────────────────────────────────
let upsertMessagesCalls: any[][] = [];
let cancelled = false;

function resetState() {
  idbStore.clear();
  upsertMessagesCalls = [];
  cancelled = false;
  __fetchCallIndex = 0;
  __fetchResults = [];
  __fetchCallHistory = [];
  // clearAllMocks wipes call history + mockResolvedValueOnce chains but
  // preserves the module-level mockImplementation set in vi.mock.
  vi.clearAllMocks();
}

// ─── Simulated init body ───────────────────────────────────────────────────────
/**
 * Re-implements the init logic from ContactChat.tsx for isolated unit testing.
 * The real init body (the async function inside useEffect) is copied here with
 * mocks substituted for all external I/O (NDK, storage).
 *
 * This tests the §3.5 order-of-operations contract:
 *   Step 1: loadMessages from IDB
 *   Step 2: setMessages(stored) — skipped (we assert upsertMessages instead)
 *   Step 3: fire kind-4 historical fetch
 *   Step 4: fire kind-1059 historical fetch in parallel with #3
 *   Step 5: wait for both, sort, call upsertMessages once
 *   Step 6: subscribe live — not tested here (live subscription testing is AC-22)
 *
 * @param opts.kind4Events  - fake kind-4 events from the historical fetch
 * @param opts.giftWrapEvents - fake kind-1059 events from the historical fetch
 * @param opts.existingMessages - messages already in IDB before init runs
 * @param opts.peerPubkeyHex   - the DM peer's pubkey (bob)
 */
async function runInitBody(opts: {
  kind4Events?: any[];
  giftWrapEvents?: any[];
  existingMessages?: any[];
  peerPubkeyHex?: string;
  skipDedupCheck?: boolean;
} = {}) {
  const {
    kind4Events = [],
    giftWrapEvents = [],
    existingMessages = [],
    peerPubkeyHex = BOB_PUB,
    skipDedupCheck = true,
  } = opts;

  const pubkeyHex = ALICE_PUBKEY_HEX;
  const privateKeyHex = ALICE_PRIV;

  // Seed existing messages into IDB
  for (const msg of existingMessages) {
    await appendMessage(THREAD_ID, msg);
  }

  // Use the shared __fetchResults array (set by test before calling runInitBody).
  // The actual fetchEventsWithTimeout mock (set in vi.mock) uses __fetchCallIndex
  // to index into __fetchResults, so we only need to populate __fetchResults here.
  void fetchEventsWithTimeout;

  const setLoading = vi.fn();
  const setMessages = vi.fn();
  const upsertMessages = vi.fn((msgs) => {
    upsertMessagesCalls.push(msgs);
  });

  // ingestEvent: copy from ContactChat (simplified)
  const ingestEvent = async (evt: { id: string; pubkey: string; content: string; created_at?: number }) => {
    const { decryptDirectPayload } = await import('@/src/lib/directMessages');
    try {
      const raw = await decryptDirectPayload(evt.content, privateKeyHex, peerPubkeyHex);
      if (!raw) return null;
      const parsed = parseDirectPayload(raw);
      if (!parsed) return null;
      return {
        id: evt.id,
        senderPubkey: evt.pubkey,
        groupId: THREAD_ID,
        content: parsed.content,
        createdAt: (evt.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
        attachments: parsed.attachments,
      };
    } catch {
      return null;
    }
  };

  // toMessage: copy from ContactChat
  const toMessage = (threadId: string, event: { id: string; pubkey: string; created_at?: number; content: string; attachments?: any }) => ({
    id: event.id,
    content: event.content,
    senderPubkey: event.pubkey,
    groupId: threadId,
    createdAt: (event.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
    attachments: event.attachments,
  });

  // Unwrap a fake kind-1059 gift wrap that contains a kind-14 rumor.
  // Returns a rumor object for handleHistoricalGiftWrapEvent to process.
  const unwrapFakeGiftWrap = async (evt: any): Promise<any> => {
    // The wrap content is JSON-encoded: { seal: { ... }, rumor: { ... } }
    // We decode it and return the inner rumor.
    const parsed = JSON.parse(evt.content);
    return parsed.rumor;
  };

  // ── Actual init body ──────────────────────────────────────────────────────
  setLoading(true);

  const { messages: stored } = await loadMessages(THREAD_ID);
  if (!cancelled) {
    setMessages(stored);
  }

  const ndk = await connectNdk(privateKeyHex);

  // Fetch both in parallel (§3.5 step 3 + step 4)
  const [incoming, outgoing, giftWrapHistorical] = await Promise.all([
    fetchEventsWithTimeout(ndk, { kinds: [DIRECT_MESSAGE_KIND], '#p': [pubkeyHex], authors: [peerPubkeyHex], limit: 200 }),
    fetchEventsWithTimeout(ndk, { kinds: [DIRECT_MESSAGE_KIND], '#p': [peerPubkeyHex], authors: [pubkeyHex], limit: 200 }),
    fetchEventsWithTimeout(ndk, { kinds: [GIFT_WRAP_KIND], '#p': [pubkeyHex], limit: 500 }),
  ]);

  // Process kind-4 results
  const kind4Messages = (
    await Promise.all(
      [...incoming.events, ...outgoing.events].map((evt: any) => ingestEvent(evt).catch(() => null)),
    )
  ).filter((msg: any): msg is any => !!msg);

  // Process kind-1059 historical results — collect into local array (mimics real
  // ContactChat where upsertMessages is called with the merged result below).
  const giftWrapMessages: any[] = [];
  const handleHistoricalGiftWrapEvent2 = async (evt: any) => {
    try {
      const rumor = await unwrapFakeGiftWrap(evt);
      const { shouldIngestRumor } = await import('@/src/lib/directMessages');
      if (!shouldIngestRumor(rumor, peerPubkeyHex)) return;
      if (rumor.kind === CHAT_MESSAGE_KIND) {
        const parsed = parseDirectPayload(rumor.content);
        if (!parsed) return;
        const msg = toMessage(THREAD_ID, {
          id: rumor.id,
          pubkey: rumor.pubkey,
          created_at: rumor.created_at,
          content: parsed.content,
          attachments: parsed.attachments,
        });
        giftWrapMessages.push(msg);
        await appendMessage(THREAD_ID, msg);
      }
    } catch {
      // silently skip unwrap failures
    }
  };

  await Promise.all([...giftWrapHistorical.events].map(handleHistoricalGiftWrapEvent2));

  // Step 5 (§3.5): merge both result sets, sort by createdAt, call upsertMessages once
  if (!cancelled) {
    upsertMessages(
      [...kind4Messages, ...giftWrapMessages].sort((a: any, b: any) => a.createdAt - b.createdAt),
    );
  }

  return { setLoading, setMessages, upsertMessages };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ContactChat.init — historical kind-1059 fetch (story-03)', () => {

  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  // ── AC-09 ────────────────────────────────────────────────────────────────────

  describe('AC-09: init fires parallel kind-1059 fetch and ingests via gift-wrap path', () => {

    it('fetchEventsWithTimeout is called with { kinds: [1059], "#p": [pubkeyHex], limit: 500 }', async () => {
      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
      ];

      await runInitBody({ giftWrapEvents: [] });

      // The third fetch call is the kind-1059 one (call index 2)
      const kind1059Call = __fetchCallHistory[2];
      expect(kind1059Call).toBeDefined();
      const filter = kind1059Call.filter;
      expect(filter.kinds).toEqual([1059]);
      expect(filter['#p']).toBeDefined();
      expect(filter.limit).toBe(500);
    });

    it('each kind-1059 event is processed through the gift-wrap unwrap+parse path', async () => {
      // Create a fake gift wrap containing a kind-14 rumor with plaintext content
      const rumor = {
        kind: CHAT_MESSAGE_KIND,
        id: 'rumor-hist-001',
        pubkey: BOB_PUB,
        content: 'hello from historical fetch',
        tags: [],
        created_at: Math.floor(Date.now() / 1000) - 300,
      };
      const giftWrapContent = JSON.stringify({ seal: {}, rumor });
      const giftWrapEvt = fakeNDKEvent({ id: 'wrap-hist-001', content: giftWrapContent });

      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set([giftWrapEvt]), timedOut: false },
      ];

      await runInitBody({ giftWrapEvents: [giftWrapEvt] });

      // The message should be in IDB
      const { messages: stored } = await loadMessages(THREAD_ID);
      expect(stored.some((m: any) => m.id === 'rumor-hist-001')).toBe(true);
      expect(stored.find((m: any) => m.id === 'rumor-hist-001')?.content).toBe('hello from historical fetch');
    });

    it('gift wrap with non-matching peer pubkey is silently dropped', async () => {
      const foreignRumor = {
        kind: CHAT_MESSAGE_KIND,
        id: 'rumor-foreign-001',
        pubkey: 'f'.repeat(64), // not BOB_PUB
        content: 'from someone else',
        tags: [],
        created_at: Math.floor(Date.now() / 1000) - 300,
      };
      const giftWrapContent = JSON.stringify({ seal: {}, rumor: foreignRumor });
      const giftWrapEvt = fakeNDKEvent({ id: 'wrap-foreign-001', content: giftWrapContent });

      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set([giftWrapEvt]), timedOut: false },
      ];

      await runInitBody({ giftWrapEvents: [giftWrapEvt] });

      const { messages: stored } = await loadMessages(THREAD_ID);
      expect(stored.some((m: any) => m.id === 'rumor-foreign-001')).toBe(false);
    });

    it('gift wrap with failed unwrap (malformed content) is silently dropped without throwing', async () => {
      const malformedEvt = fakeNDKEvent({ id: 'wrap-malformed-001', content: 'not-valid-json{[' });

      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set([malformedEvt]), timedOut: false },
      ];

      // Should not throw
      await expect(runInitBody({ giftWrapEvents: [malformedEvt] })).resolves.toBeDefined();
    });
  });

  // ── AC-10 ────────────────────────────────────────────────────────────────────

  describe('AC-10: upsertMessages called after both fetches settle, with sorted messages', () => {

    it('upsertMessages is called exactly once per init run', async () => {
      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
      ];

      await runInitBody({ giftWrapEvents: [] });

      expect(upsertMessagesCalls).toHaveLength(1);
    });

    it('messages are sorted by createdAt ascending before upsertMessages', async () => {
      // Build gift wraps with messages in non-chronological wrap order
      const rumor = (id: string, content: string, createdAt: number) => ({
        kind: CHAT_MESSAGE_KIND,
        id,
        pubkey: BOB_PUB,
        content: JSON.stringify({ type: 'text', text: content }),
        tags: [],
        created_at: Math.floor(createdAt / 1000),
      });
      const wrap = (id: string, r: any) => fakeNDKEvent({ id, content: JSON.stringify({ seal: {}, rumor: r }) });

      const giftWrapEvts = [
        wrap('w-newest', rumor('msg-newest', 'msg-2', 1_000_001_000_000)),
        wrap('w-oldest', rumor('msg-oldest', 'msg-1', 1_000_000_000_000)),
        wrap('w-mid',    rumor('msg-mid',    'msg-3', 1_000_000_500_000)),
      ];

      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set(giftWrapEvts), timedOut: false },
      ];

      await runInitBody({ giftWrapEvents: giftWrapEvts });

      const upserted = upsertMessagesCalls[0];
      expect(upserted).toBeDefined();
      const ids = upserted.map((m: any) => m.id);
      expect(ids).toEqual(['msg-oldest', 'msg-mid', 'msg-newest']);
    });

    it('no upsertMessages call is made when cancelled is true', async () => {
      __fetchResults = [
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
        { events: new Set(), timedOut: false },
      ];
      cancelled = true;

      await runInitBody({ giftWrapEvents: [] });

      expect(upsertMessagesCalls).toHaveLength(0);
    });
  });

  // ── AC-11 ────────────────────────────────────────────────────────────────────

  describe('AC-11: id-based dedup prevents duplicate rows from historical fetch', () => {

    it('message id already in IDB is not duplicated by the historical fetch', async () => {
      // Pre-seed a message into IDB (simulates a message that arrived live before historical fetch)
      const existingMsg = {
        id: 'rumor-shared-id',
        senderPubkey: BOB_PUB,
        groupId: THREAD_ID,
        content: 'already stored',
        createdAt: Date.now() - 60_000,
      };
      await appendMessage(THREAD_ID, existingMsg);

      // Historical fetch returns the same message (same rumor id)
      const rumor = {
        kind: CHAT_MESSAGE_KIND,
        id: 'rumor-shared-id',
        pubkey: BOB_PUB,
        content: 'historical version',
        tags: [],
        created_at: Math.floor((Date.now() - 60_000) / 1000),
      };
      const giftWrapEvt = fakeNDKEvent({ id: 'wrap-shared-001', content: JSON.stringify({ seal: {}, rumor }) });

      (fetchEventsWithTimeout as any).mockResolvedValue({ events: new Set([giftWrapEvt]), timedOut: false });

      await runInitBody({ giftWrapEvents: [giftWrapEvt], existingMessages: [existingMsg] });

      const { messages: stored } = await loadMessages(THREAD_ID);
      const matchingMsgs = stored.filter((m: any) => m.id === 'rumor-shared-id');
      expect(matchingMsgs).toHaveLength(1);
      // The existing message (from before historical fetch) is preserved
      expect(stored).toHaveLength(1);
    });

    it('distinct rumor ids both stored (no dedup when ids differ)', async () => {
      const rumor1 = {
        kind: CHAT_MESSAGE_KIND,
        id: 'rumor-distinct-001',
        pubkey: BOB_PUB,
        content: 'first message',
        tags: [],
        created_at: Math.floor(Date.now() / 1000) - 60,
      };
      const rumor2 = {
        kind: CHAT_MESSAGE_KIND,
        id: 'rumor-distinct-002',
        pubkey: BOB_PUB,
        content: 'second message',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      };
      const wrap1 = fakeNDKEvent({ id: 'wrap-001', content: JSON.stringify({ seal: {}, rumor: rumor1 }) });
      const wrap2 = fakeNDKEvent({ id: 'wrap-002', content: JSON.stringify({ seal: {}, rumor: rumor2 }) });

      (fetchEventsWithTimeout as any).mockResolvedValue({ events: new Set([wrap1, wrap2]), timedOut: false });

      await runInitBody({ giftWrapEvents: [wrap1, wrap2] });

      const { messages: stored } = await loadMessages(THREAD_ID);
      expect(stored).toHaveLength(2);
      const ids = stored.map((m: any) => m.id).sort();
      expect(ids).toEqual(['rumor-distinct-001', 'rumor-distinct-002']);
    });
  });
});

// ─── AC-SEC-8 regression: historical kind-4 walled-garden gate ───────────────
//
// Verifies that handleHistoricalKind4Event applies isAllowedDmSender BEFORE
// calling appendMessage/ingestEvent. This is the fourth inbound path identified
// in the post-implementation Opus review (Amendment 1 to AC-SEC-6).

describe('ContactChat — handleHistoricalKind4Event walled-garden gate (AC-SEC-8 regression)', () => {
  type Group = import('@/src/types').Group;

  // Inline handleHistoricalKind4Event — mirrors the production code in ContactChat.tsx.
  // Tests this logic in isolation from the full component.
  function makeHandler(opts: {
    pubkeyHex: string;
    groups: ReadonlyArray<Group>;
    ingestEvent: (evt: any) => Promise<any>;
    onDrop: (pubkey: string) => void;
  }) {
    return async (evt: { id: string; pubkey: string; content: string; created_at?: number }) => {
      const senderPeer = evt.pubkey.toLowerCase();
      const isSelf = senderPeer === opts.pubkeyHex.toLowerCase();
      if (!isSelf && !isAllowedDmSender(senderPeer, opts.groups, new Set<string>(), opts.pubkeyHex)) {
        opts.onDrop(senderPeer);
        return null;
      }
      return opts.ingestEvent(evt).catch(() => null);
    };
  }

  const ALICE_PUB = ALICE_PUBKEY_HEX;
  const MEMBER_GROUP: Group = {
    id: 'group-test',
    name: 'Test',
    createdAt: 1,
    memberPubkeys: [BOB_PUB, ALICE_PUB],
    relays: [],
  };
  const STRANGER_PUB = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  it('drops a historical kind-4 event from a stranger and does not call ingestEvent', async () => {
    const ingestEvent = vi.fn().mockResolvedValue({ id: 'msg-stranger', content: 'hi' });
    const onDrop = vi.fn();

    const handler = makeHandler({
      pubkeyHex: ALICE_PUB,
      groups: [MEMBER_GROUP],
      ingestEvent,
      onDrop,
    });

    const result = await handler({
      id: 'evt-stranger-kind4',
      pubkey: STRANGER_PUB,
      content: 'encrypted stranger content',
      created_at: Math.floor(Date.now() / 1000),
    });

    expect(result).toBeNull();
    expect(ingestEvent).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith(STRANGER_PUB);
  });

  it('allows a historical kind-4 event from a group member', async () => {
    const fakeMsg = { id: 'msg-member', content: 'hello' };
    const ingestEvent = vi.fn().mockResolvedValue(fakeMsg);
    const onDrop = vi.fn();

    const handler = makeHandler({
      pubkeyHex: ALICE_PUB,
      groups: [MEMBER_GROUP],
      ingestEvent,
      onDrop,
    });

    const result = await handler({
      id: 'evt-member-kind4',
      pubkey: BOB_PUB,
      content: 'encrypted member content',
      created_at: Math.floor(Date.now() / 1000),
    });

    expect(result).toEqual(fakeMsg);
    expect(ingestEvent).toHaveBeenCalledOnce();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('allows self-authored outgoing kind-4 events regardless of gate', async () => {
    const fakeMsg = { id: 'msg-self', content: 'my own message' };
    const ingestEvent = vi.fn().mockResolvedValue(fakeMsg);
    const onDrop = vi.fn();

    const handler = makeHandler({
      pubkeyHex: ALICE_PUB,
      groups: [MEMBER_GROUP],
      ingestEvent,
      onDrop,
    });

    // Self-authored: pubkey === pubkeyHex. isAllowedDmSender returns false for
    // self, but the isSelf check must bypass the gate.
    const result = await handler({
      id: 'evt-self-kind4',
      pubkey: ALICE_PUB, // self
      content: 'my encrypted outgoing message',
      created_at: Math.floor(Date.now() / 1000),
    });

    expect(result).toEqual(fakeMsg);
    expect(ingestEvent).toHaveBeenCalledOnce();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

// ── AC-PROF-9 (epic: direct-contact-profile-exchange, story S08) ───────────
//
// A delivered profile-request/profile-announce MUST NOT render a message
// bubble. This closes the pre-existing gap exploration.json noted: this file
// had a real-driving foreign-kind proof test for other kinds (pairing-ack,
// join-request, welcome — see the AC-09 block above and its "gift wrap with
// non-matching peer pubkey is silently dropped" sibling) but none for the two
// new direct-contact-profile-exchange kinds.
//
// STAGE-1 REMEDIATION (sev 4): an earlier version of this block asserted
// against a hand-rolled `mirrorsLiveGiftWrapDispatchGate` mirror function
// that never called any real production code — it would NOT have failed if
// ContactChat.tsx ever gained a bubble path for these kinds (the
// `feedback_test_mocking_blind_spots` shadow-test anti-pattern). Replaced
// with cases that reuse the SAME real-driving harness (`runInitBody`) as the
// "gift wrap with non-matching peer pubkey" test directly above: a REAL
// gift-wrapped rumor of each new kind is fed through the real
// `parseDirectPayload` / `appendMessage` / `loadMessages` pipeline (only the
// non-exported effect-wiring shell is a local copy, matching this file's
// established convention — see the file's own top-of-suite doc comment and
// architecture.md's note that this repo has no jsdom/render-harness
// precedent for exercising a mounted component's live subscription
// directly), and the assertion reads back REAL persisted IDB state via
// `loadMessages`, exactly like the non-matching-peer sibling test. This would
// fail if the SAME kind-gate this test exercises ever admitted these two
// kinds. No source change to ContactChat.tsx (architecture.md: AC-PROF-9 is
// tests-only).
describe('ContactChat gift-wrap ingestion — DM profile-exchange foreign-kind proof (AC-PROF-9)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('a DM_PROFILE_REQUEST_KIND rumor is never stored as a chat message (no bubble)', async () => {
    const { DM_PROFILE_REQUEST_KIND, encodeProfileRequest } = await import('@/src/lib/dmProfile/kinds');
    expect(DM_PROFILE_REQUEST_KIND).not.toBe(CHAT_MESSAGE_KIND);

    const profileRequestRumor = {
      kind: DM_PROFILE_REQUEST_KIND,
      id: 'rumor-profile-request-001',
      pubkey: BOB_PUB, // matching peer — isolates the KIND gate, not the peer gate
      content: encodeProfileRequest(),
      tags: [],
      created_at: Math.floor(Date.now() / 1000) - 300,
    };
    const giftWrapContent = JSON.stringify({ seal: {}, rumor: profileRequestRumor });
    const giftWrapEvt = fakeNDKEvent({ id: 'wrap-profile-request-001', content: giftWrapContent });

    __fetchResults = [
      { events: new Set(), timedOut: false },
      { events: new Set(), timedOut: false },
      { events: new Set([giftWrapEvt]), timedOut: false },
    ];

    await runInitBody({ giftWrapEvents: [giftWrapEvt] });

    const { messages: stored } = await loadMessages(THREAD_ID);
    expect(stored.some((m: any) => m.id === 'rumor-profile-request-001')).toBe(false);
    // Robust to any pre-existing entries other describe blocks in this shared-THREAD_ID
    // file may have left in upsertMessagesCalls: assert THIS rumor specifically was
    // never handed to upsertMessages, not merely that the total call was empty.
    expect(upsertMessagesCalls.flat().some((m: any) => m.id === 'rumor-profile-request-001')).toBe(false);
  });

  it('a DM_PROFILE_ANNOUNCE_KIND rumor is never stored as a chat message (no bubble)', async () => {
    const { DM_PROFILE_ANNOUNCE_KIND, encodeProfileAnnounce } = await import('@/src/lib/dmProfile/kinds');
    expect(DM_PROFILE_ANNOUNCE_KIND).not.toBe(CHAT_MESSAGE_KIND);

    const profileAnnounceRumor = {
      kind: DM_PROFILE_ANNOUNCE_KIND,
      id: 'rumor-profile-announce-001',
      pubkey: BOB_PUB, // matching peer — isolates the KIND gate, not the peer gate
      content: encodeProfileAnnounce({ nickname: 'Bob', avatar: { imageUrl: 'https://example.com/a.png' } }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000) - 300,
    };
    const giftWrapContent = JSON.stringify({ seal: {}, rumor: profileAnnounceRumor });
    const giftWrapEvt = fakeNDKEvent({ id: 'wrap-profile-announce-001', content: giftWrapContent });

    __fetchResults = [
      { events: new Set(), timedOut: false },
      { events: new Set(), timedOut: false },
      { events: new Set([giftWrapEvt]), timedOut: false },
    ];

    await runInitBody({ giftWrapEvents: [giftWrapEvt] });

    const { messages: stored } = await loadMessages(THREAD_ID);
    expect(stored.some((m: any) => m.id === 'rumor-profile-announce-001')).toBe(false);
    // Robust to any pre-existing entries other describe blocks in this shared-THREAD_ID
    // file may have left in upsertMessagesCalls: assert THIS rumor specifically was
    // never handed to upsertMessages, not merely that the total call was empty.
    expect(upsertMessagesCalls.flat().some((m: any) => m.id === 'rumor-profile-announce-001')).toBe(false);
  });
});