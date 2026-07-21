/**
 * Unit tests for directMessageNotifications.ts — story-02, AC-15 through AC-19, AC-21.
 *
 * Tests the bell watcher's two-subscription model (kind-4 + kind-1059) and the
 * kind-1059 handler's silent-skip, dedup, and attribution logic.
 *
 * AC-15: subscribeDirectMessageNotifications opens two subscriptions.
 * AC-16: kind-1059 event whose rumor has kind===14, pubkey!==own, created_at>lastRead
 *        → rememberContact + incrementDirectMessage exactly once.
 * AC-17: kind-1059 event whose unwrap throws → no side effects, no unhandled rejection.
 * AC-18: kind-1059 event whose rumor has kind!==14 → no side effects.
 * AC-19: kind-1059 event re-delivered with different outer id but same inner rumor id
 *        → incrementDirectMessage called exactly once (seenRumorIds dedup).
 * AC-21: unit test file exists and covers AC-15 through AC-19.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake NDK subscription infrastructure ──────────────────────────────────────

type FakeSub = {
  id: string;
  filter: object;
  handlers: Array<(ev: object) => void>;
  stop: () => void;
  /** Mirrors NDKSubscription.on() — registers an event handler. */
  on: (event: string, handler: (ev: object) => void) => void;
};

type FakeNdk = {
  subscribe: (filter: object) => FakeSub;
};

function makeFakeNdk(): FakeNdk & { subs: FakeSub[] } {
  const subs: FakeSub[] = [];
  const ndk = {
    subs,
    subscribe: (filter: object) => {
      const sub: FakeSub = {
        id: `sub-${subs.length}`,
        filter,
        handlers: [],
        stop: vi.fn(),
        // Mirrors NDKSubscription.on — handlers are stored in `handlers` array
        // and emitted by emitEvent(). The `on` method also registers handlers.
        on(event: string, handler: (ev: object) => void) {
          this.handlers.push(handler);
        },
      };
      subs.push(sub);
      return sub;
    },
  } as FakeNdk & { subs: FakeSub[] };
  return ndk;
}

/**
 * Emit an event through a fake subscription's handlers.
 * Awaits async handlers so callers can assert on post-handler state synchronously.
 */
async function emitEvent(sub: FakeSub, event: object) {
  await Promise.all(sub.handlers.map(async (handler) => {
    const result = handler(event);
    if (result instanceof Promise) await result;
  }));
}

// ── Shared test keypair (from architecture.md) ────────────────────────────────

const OWN_PRIV = 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d';
const OWN_PUB = 'a'.repeat(64); // not a real pubkey — used as-is for filtering
const PEER_PUB = 'b'.repeat(64);

/** Whitelist accessor that allows PEER_PUB and rejects everything else. */
const allowPeerOnly = (peer: string) => peer === PEER_PUB.toLowerCase();
/** Whitelist accessor that allows any non-empty peer (used for tests that don't exercise the gate). */
const allowAll = (_peer: string) => true;

// ── Mock targets ───────────────────────────────────────────────────────────────

// Capture the logger returned by createLogger('dm') in the SUT module scope
let capturedLoggerInfo: ReturnType<typeof vi.fn>;

vi.mock('@/src/lib/directMessages', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/directMessages')>('@/src/lib/directMessages');
  return {
    ...mod,
    unwrapAndOpen: vi.fn<() => Promise<import('@/src/lib/directMessages').UnsignedRumor>>(),
    // shouldIngestRumor is intentionally NOT mocked — the bell watcher must accept
    // DMs from any peer (it has no peer-pubkey to filter against). A previous version
    // mocked it to true by default, hiding a bug where shouldIngestRumor(rumor, '')
    // was being called and rejecting every rumor in production.
  };
});

vi.mock('@/src/lib/unreadStore', () => ({
  getDirectMessageLastReadAt: vi.fn(() => 0),  // 0 = never read, so any event bumps bell
  incrementDirectMessage: vi.fn(),
}));

// isPendingConfirmation defaults to false so every pre-existing test in this
// file (authored before the pending-contact-confirmation epic) keeps ringing
// the bell exactly as before; individual AC-OBS-1 tests below override it.
vi.mock('@/src/lib/contacts', () => ({
  rememberContact: vi.fn(),
  isPendingConfirmation: vi.fn(() => false),
}));

vi.mock('@/src/lib/logger', () => {
  const infoSpy = vi.fn();
  capturedLoggerInfo = infoSpy;
  return {
    createLogger: () => ({ info: infoSpy, debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

const { unwrapAndOpen } = await import('@/src/lib/directMessages');
const { incrementDirectMessage } = await import('@/src/lib/unreadStore');
const { rememberContact, isPendingConfirmation } = await import('@/src/lib/contacts');

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { subscribeDirectMessageNotifications } = await import('@/src/lib/directMessageNotifications');
const { PAIRING_ACK_KIND } = await import('@/src/lib/pairing/pairingAck');
const {
  DM_PROFILE_REQUEST_KIND,
  DM_PROFILE_ANNOUNCE_KIND,
  encodeProfileRequest,
  encodeProfileAnnounce,
} = await import('@/src/lib/dmProfile/kinds');

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('subscribeDirectMessageNotifications', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(unwrapAndOpen).mockReset();
    vi.mocked(incrementDirectMessage).mockReset();
    vi.mocked(rememberContact).mockReset();
    vi.mocked(isPendingConfirmation).mockReset();
    vi.mocked(isPendingConfirmation).mockReturnValue(false);
    if (capturedLoggerInfo) capturedLoggerInfo.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── AC-15 ────────────────────────────────────────────────────────────────────

  it('AC-15: opens two subscriptions with different filter objects', () => {
    const ndk = makeFakeNdk();

    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    // Two subscriptions must have been created
    expect(ndk.subs).toHaveLength(2);

    // Subscription 1 must filter for kind-4 + '#p': [ownPubkey]
    const kind4Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[4]'),
    );
    expect(kind4Sub).toBeDefined();
    expect(kind4Sub!.filter).toMatchObject({ kinds: [4], '#p': [OWN_PUB] });

    // Subscription 2 must filter for kind-1059 + '#p': [ownPubkey]
    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    );
    expect(kind1059Sub).toBeDefined();
    expect(kind1059Sub!.filter).toMatchObject({ kinds: [1059], '#p': [OWN_PUB] });
  });

  // ── AC-16 ────────────────────────────────────────────────────────────────────

  it('AC-16: kind-1059 event with kind===14, pubkey!==own, created_at>lastRead calls rememberContact and incrementDirectMessage exactly once', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-id-abc',
      pubkey: PEER_PUB,          // not own
      kind: 14,                   // NIP-17 chat message
      content: 'hello',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,  // far in the future vs lastRead=0
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, {
      id: 'wrap-id-outer',
      kind: 1059,
      pubkey: 'ephemeral-key',
      created_at: { getTime: () => 1_700_000_000 * 1000 },
    });

    expect(rememberContact).toHaveBeenCalledTimes(1);
    expect(rememberContact).toHaveBeenCalledWith(PEER_PUB);
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(incrementDirectMessage).toHaveBeenCalledWith(PEER_PUB);
  });

  // ── contacts-live-updates: onContactChanged fires the live signal ──────────

  it('calls onContactChanged after an allowed inbound DM writes the contact (epic: contacts-live-updates)', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-id-live',
      pubkey: PEER_PUB,
      kind: 14,
      content: 'hi',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });
    const onContactChanged = vi.fn();
    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: allowPeerOnly,
      onContactChanged,
    });
    const kind1059Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[1059]'))!;
    await emitEvent(kind1059Sub, {
      id: 'wrap-live',
      kind: 1059,
      pubkey: 'ephemeral-key',
      created_at: { getTime: () => 1_700_000_000 * 1000 },
    });
    expect(rememberContact).toHaveBeenCalledTimes(1);
    expect(onContactChanged).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onContactChanged when the sender is dropped at the walled garden', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-id-stranger',
      pubkey: PEER_PUB,
      kind: 14,
      content: 'hi',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });
    const onContactChanged = vi.fn();
    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: () => false,
      onContactChanged,
    });
    const kind1059Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[1059]'))!;
    await emitEvent(kind1059Sub, {
      id: 'wrap-stranger',
      kind: 1059,
      pubkey: 'ephemeral-key',
      created_at: { getTime: () => 1_700_000_000 * 1000 },
    });
    expect(rememberContact).not.toHaveBeenCalled();
    expect(onContactChanged).not.toHaveBeenCalled();
  });

  // ── AC-17 ────────────────────────────────────────────────────────────────────

  it('AC-17: kind-1059 event whose unwrap throws does not call rememberContact/incrementDirectMessage; no unhandled rejection', async () => {
    vi.mocked(unwrapAndOpen).mockRejectedValue(new Error('decrypt failed'));

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    // Must not throw — the handler must catch all errors internally
    await expect(
      emitEvent(kind1059Sub, {
        id: 'malformed-wrap',
        kind: 1059,
        pubkey: 'attacker-key',
      }),
    ).resolves.not.toThrow();

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  // ── AC-18 ────────────────────────────────────────────────────────────────────

  it('AC-18: kind-1059 event whose rumor has kind!==14 does not call rememberContact or incrementDirectMessage', async () => {
    // Simulate a kind-7 reaction rumor (from emoji epic story-07)
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'reaction-rumor-id',
      pubkey: PEER_PUB,
      kind: 7,      // not kind-14
      content: '+',
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, {
      id: 'reaction-wrap',
      kind: 1059,
      pubkey: 'any-key',
    });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-18 variant: kind-444 welcome rumor is silently skipped', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'welcome-rumor-id',
      pubkey: PEER_PUB,
      kind: 444,
      content: '',
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'welcome-wrap', kind: 1059, pubkey: 'any-key' });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-SEC-4 (pairing-ack epic): a PAIRING_ACK_KIND rumor is silently skipped — no bell, no rememberContact, via the EXISTING kind!==CHAT_MESSAGE_KIND guard (proof test; directMessageNotifications.ts is not modified for this)', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'pairing-ack-rumor-id',
      pubkey: PEER_PUB,
      kind: PAIRING_ACK_KIND, // 21060 — not CHAT_MESSAGE_KIND (14)
      content: JSON.stringify({ type: 'pairing-ack', nonce: 'ab'.repeat(16), card: 'irrelevant' }),
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'pairing-ack-wrap', kind: 1059, pubkey: 'any-key' });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  // ── AC-PROF-9 (epic: direct-contact-profile-exchange, story S08) ────────
  //
  // A delivered profile-request/profile-announce MUST raise no bell
  // notification, for both new kinds and both inbound directions. Per
  // architecture.md this is satisfied by the EXISTING kind!==CHAT_MESSAGE_KIND
  // (14) guard already exercised above for other foreign kinds — these two
  // cases close the specific gap (both DM_PROFILE_REQUEST_KIND and
  // DM_PROFILE_ANNOUNCE_KIND, both inbound directions) without any source
  // change to directMessageNotifications.ts.

  it('AC-PROF-9: a DM_PROFILE_REQUEST_KIND rumor is silently skipped — no bell, no rememberContact (proof test; directMessageNotifications.ts is not modified for this)', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'profile-request-rumor-id',
      pubkey: PEER_PUB,
      kind: DM_PROFILE_REQUEST_KIND, // 21061 — not CHAT_MESSAGE_KIND (14)
      content: encodeProfileRequest(),
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'profile-request-wrap', kind: 1059, pubkey: 'any-key' });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-PROF-9: a DM_PROFILE_ANNOUNCE_KIND rumor is silently skipped — no bell, no rememberContact (proof test; directMessageNotifications.ts is not modified for this)', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'profile-announce-rumor-id',
      pubkey: PEER_PUB,
      kind: DM_PROFILE_ANNOUNCE_KIND, // 21062 — not CHAT_MESSAGE_KIND (14)
      content: encodeProfileAnnounce({ nickname: 'Peer', avatar: { imageUrl: 'https://example.com/a.png' } }),
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'profile-announce-wrap', kind: 1059, pubkey: 'any-key' });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-18 variant: kind-21059 join-request rumor is silently skipped', async () => {
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'join-request-rumor-id',
      pubkey: PEER_PUB,
      kind: 21059,
      content: '',
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'join-wrap', kind: 1059, pubkey: 'any-key' });

    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  // ── AC-19 ────────────────────────────────────────────────────────────────────

  it('AC-19: kind-1059 event re-delivered with different outer id but same inner rumor id increments bell exactly once (seenRumorIds dedup)', async () => {
    // isAllowedSender: PEER_PUB is the sender — allow it so we can test dedup behaviour
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'stable-rumor-id',   // same inner id
      pubkey: PEER_PUB,
      kind: 14,
      content: 'hello again',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    // First delivery — outer id "wrap-v1"
    await emitEvent(kind1059Sub, { id: 'wrap-v1', kind: 1059, pubkey: 'ephemeral-1' });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);

    // Second delivery — same rumor id, different outer id (relay redelivery)
    await emitEvent(kind1059Sub, { id: 'wrap-v2', kind: 1059, pubkey: 'ephemeral-2' });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1); // still 1 — deduped by rumor id
  });

  // ── AC-30 / AC-31 logging ────────────────────────────────────────────────────

  it('AC-30: info-level logger is called when unwrap throws', async () => {
    vi.mocked(unwrapAndOpen).mockRejectedValue(new Error('decrypt failed'));

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'wrap-malformed', kind: 1059, pubkey: 'attacker-key' });

    expect(capturedLoggerInfo).toHaveBeenCalledWith(
      'dm:unwrap-failed',
      expect.objectContaining({ eventId: 'wrap-malformed' }),
    );
  });

  it('AC-31: no console.warn or console.error from any silent-skip path', async () => {
    // unwrap throws
    vi.mocked(unwrapAndOpen).mockRejectedValue(new Error('bad'));
    const ndk1 = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk1 as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });
    const sub1 = ndk1.subs.find((s) => JSON.stringify(s.filter).includes('1059'))!;
    await emitEvent(sub1, { id: 'wrap-1', kind: 1059, pubkey: 'x' });

    // rumor kind!==14
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'r2', pubkey: PEER_PUB, kind: 7, content: '+', tags: [], created_at: 1,
    });
    const ndk2 = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk2 as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });
    const sub2 = ndk2.subs.find((s) => JSON.stringify(s.filter).includes('1059'))!;
    await emitEvent(sub2, { id: 'wrap-2', kind: 1059, pubkey: 'x' });

    // self-authored rumor (own pubkey)
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'r3', pubkey: OWN_PUB, kind: 14, content: 'self', tags: [], created_at: 1,
    });
    const ndk3 = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk3 as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });
    const sub3 = ndk3.subs.find((s) => JSON.stringify(s.filter).includes('1059'))!;
    await emitEvent(sub3, { id: 'wrap-3', kind: 1059, pubkey: 'x' });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ── Walled-garden gate tests ──────────────────────────────────────────────────
  // S2 (AC-SEC-3/4/5): isAllowedSender gates the bell. Stranger events must NOT
  // ring the bell and must NOT be added to the dedup sets.

  it('AC-SEC-5 (kind-1059): stranger rumor does NOT ring the bell and does NOT populate seenRumorIds', async () => {
    const STRANGER = 'c'.repeat(64);
    const MEMBER = PEER_PUB;
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'shared-rumor-id',  // same rumor id for both stranger and member delivery
      pubkey: STRANGER,
      kind: 14,
      content: 'stranger message',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    // Only MEMBER is in the whitelist; STRANGER is not.
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => peer === MEMBER.toLowerCase(),
    });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    // Stranger delivery — must be dropped, seenRumorIds must NOT be populated.
    await emitEvent(kind1059Sub, { id: 'wrap-stranger', kind: 1059, pubkey: 'ephemeral' });
    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();

    // Now the same rumor id arrives from a MEMBER — it must be processed because
    // the stranger delivery did NOT occupy the seenRumorIds slot.
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'shared-rumor-id',  // same rumor id
      pubkey: MEMBER,
      kind: 14,
      content: 'member message',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });
    await emitEvent(kind1059Sub, { id: 'wrap-member', kind: 1059, pubkey: 'ephemeral2' });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(incrementDirectMessage).toHaveBeenCalledWith(MEMBER.toLowerCase());
  });

  it('AC-SEC-3/4 (kind-4): stranger kind-4 does NOT ring the bell and does NOT populate seenMessageIds', async () => {
    const STRANGER = 'c'.repeat(64);
    const MEMBER = PEER_PUB;

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => peer === MEMBER.toLowerCase(),
    });

    const kind4Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[4]'),
    )!;

    // Stranger delivery — must be dropped, seenMessageIds must NOT be populated.
    await emitEvent(kind4Sub, { id: 'shared-event-id', pubkey: STRANGER, created_at: 1_700_000_000 });
    expect(rememberContact).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();

    // Same event id from a MEMBER — must be accepted because the stranger delivery
    // did NOT occupy the seenMessageIds slot.
    await emitEvent(kind4Sub, { id: 'shared-event-id', pubkey: MEMBER, created_at: 1_700_000_000 });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(incrementDirectMessage).toHaveBeenCalledWith(MEMBER.toLowerCase());
  });

  it('AC-OBS-1 (kind-1059): stranger drop emits INFO log with pubkey prefix and kind, no message content', async () => {
    const STRANGER = 'd'.repeat(64);
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'stranger-rumor',
      pubkey: STRANGER,
      kind: 14,
      content: 'SECRET CONTENT — must not appear in logs',
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: () => false,  // all strangers
    });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;
    await emitEvent(kind1059Sub, { id: 'wrap-s', kind: 1059, pubkey: 'eph' });

    // Logger must have been called with the drop tag.
    expect(capturedLoggerInfo).toHaveBeenCalledWith(
      'dm:walled-garden-drop',
      expect.objectContaining({ pubkey: STRANGER.slice(0, 8), kind: 1059 }),
    );
    // Log must NOT include message content.
    const logArg = capturedLoggerInfo.mock.calls[0][1];
    expect(JSON.stringify(logArg)).not.toContain('SECRET CONTENT');
  });

  it('AC-OBS-1 (kind-4): stranger drop emits INFO log, no message content', async () => {
    const STRANGER = 'e'.repeat(64);

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: () => false,
    });

    const kind4Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[4]'),
    )!;
    // The content field of kind-4 is encrypted ciphertext — the handler never
    // decrypts it for bell purposes, so there is nothing to leak. We confirm
    // the log does not include it.
    await emitEvent(kind4Sub, { id: 'event-s', pubkey: STRANGER, content: 'ENCRYPTED', created_at: 1_700_000_000 });

    expect(capturedLoggerInfo).toHaveBeenCalledWith(
      'dm:walled-garden-drop',
      expect.objectContaining({ pubkey: STRANGER.slice(0, 8), kind: 4 }),
    );
  });

  it('bug-1 regression: rumor pubkey casing differences do not break self-detection', async () => {
    // Self-authored rumor whose pubkey casing differs from ownPubkeyHex.
    // The bell handler must lowercase before comparing, otherwise self-DMs would
    // ring the bell.
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'self-rumor',
      pubkey: OWN_PUB.toUpperCase(),
      kind: 14,
      content: 'self note',
      tags: [],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowAll });

    const kind1059Sub = ndk.subs.find(
      (s) => JSON.stringify(s.filter).includes('"kinds":[1059]'),
    )!;

    await emitEvent(kind1059Sub, { id: 'wrap-self', kind: 1059, pubkey: 'ephemeral' });

    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  // ── AC-OBS-1 (epic: pending-contact-confirmation, story S2) ────────────────
  // A message from a pending contact must not bump the bell; rememberContact
  // still fires unconditionally (spec.md §"Technical Approach" —
  // directMessageNotifications.ts).

  it('AC-OBS-1 (kind-4): a message from a pending contact calls rememberContact but not incrementDirectMessage', async () => {
    vi.mocked(isPendingConfirmation).mockImplementation((peer: string) => peer === PEER_PUB.toLowerCase());

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind4Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[4]'))!;
    await emitEvent(kind4Sub, { id: 'pending-e1', pubkey: PEER_PUB, created_at: 1_700_000_000 });

    expect(rememberContact).toHaveBeenCalledTimes(1);
    expect(rememberContact).toHaveBeenCalledWith(PEER_PUB);
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-OBS-1 (kind-1059): a rumor from a pending contact calls rememberContact but not incrementDirectMessage', async () => {
    vi.mocked(isPendingConfirmation).mockImplementation((peer: string) => peer === PEER_PUB.toLowerCase());
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'pending-rumor-id',
      pubkey: PEER_PUB,
      kind: 14,
      content: 'held while pending',
      tags: [['p', OWN_PUB]],
      created_at: 1_700_000_000,
    });

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind1059Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[1059]'))!;
    await emitEvent(kind1059Sub, { id: 'pending-wrap', kind: 1059, pubkey: 'ephemeral' });

    expect(rememberContact).toHaveBeenCalledTimes(1);
    expect(rememberContact).toHaveBeenCalledWith(PEER_PUB);
    expect(incrementDirectMessage).not.toHaveBeenCalled();
  });

  it('AC-OBS-1: once a contact is no longer pending, the same peer rings the bell normally (kind-4)', async () => {
    vi.mocked(isPendingConfirmation).mockReturnValue(false);

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind4Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[4]'))!;
    await emitEvent(kind4Sub, { id: 'confirmed-e1', pubkey: PEER_PUB, created_at: 1_700_000_000 });

    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(incrementDirectMessage).toHaveBeenCalledWith(PEER_PUB.toLowerCase());
  });

  it('AC-STRUCT-3: isPendingConfirmation is called with the lowercased peer, not a hand-derived value', async () => {
    vi.mocked(isPendingConfirmation).mockReturnValue(false);

    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({ ndk: ndk as unknown as any, ownPubkeyHex: OWN_PUB, privateKeyHex: OWN_PRIV, isAllowedSender: allowPeerOnly });

    const kind4Sub = ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[4]'))!;
    await emitEvent(kind4Sub, { id: 'gate-check', pubkey: PEER_PUB.toUpperCase(), created_at: 1_700_000_000 });

    expect(isPendingConfirmation).toHaveBeenCalledWith(PEER_PUB.toLowerCase());
  });
});