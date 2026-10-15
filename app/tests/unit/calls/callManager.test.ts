/**
 * Unit tests for callManager.ts — Story S5.
 *
 * Tests:
 *   T1.  Incoming offer → callStore.incoming is set with correct fields
 *   T2.  declineCall() sends 25054 Reject and clears callStore
 *   T3.  Ring timeout (45s) → auto-decline fires (vi.useFakeTimers)
 *   T4.  5-cap: startCall with 5 remote peers throws (total 6 including self)
 *   T5.  Busy auto-reject: incoming offer while active → sends 25054 with 'busy'
 *   T6.  Multi-device echo: acceptCall() wraps 25051 also to own pubkey
 *   T7.  Join mid-call: existing peer initiates offer to newly discovered peer
 *   T8.  Hangup: sends 25053 to all peers and clears callStore
 *   T9.  ICE restart: on connectionState === 'failed', sends 25055 renegotiate
 *   T10. Multi-device echo receive: 25054 Reject from own pubkey stops ringing
 *   T11. Multi-device echo receive: 25051 Answer from own pubkey stops ringing
 *
 * Mocking strategy:
 *   - callSignaling, mediaManager, turnConfig are vi.mock'd.
 *   - PeerSession mock collects instances via a module-level array that the
 *     mock factory registers into through globalThis.__peerSessionRegistry__.
 *   - callStore is the real implementation, reset between tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { callStore } from '@/src/lib/calls/callStore';
import type { IncomingCallEvent } from '@/src/types';

// ── Peer-session instance registry ───────────────────────────────────────────
// The mock factory is hoisted by vitest so it cannot close over module-level
// let-bindings at the call site. We bridge via globalThis instead.

interface MockPeerSession {
  callbacks: {
    onIceCandidate: (c: RTCIceCandidateInit) => void;
    onTrack: (s: readonly MediaStream[]) => void;
    onConnectionStateChange: (s: RTCPeerConnectionState) => void;
    onIceConnectionStateChange: (s: RTCIceConnectionState) => void;
  };
  addLocalStream: Mock;
  createOffer: Mock;
  createAnswer: Mock;
  applyRemoteOffer: Mock;
  createLocalAnswer: Mock;
  applyAnswer: Mock;
  applyRenegotiateOffer: Mock;
  createIceRestartOffer: Mock;
  addIceCandidate: Mock;
  close: Mock;
  connectionState: RTCPeerConnectionState;
}

// Each test resets this array.
const peerSessionRegistry: MockPeerSession[] = [];
(globalThis as Record<string, unknown>).__peerSessionRegistry__ = peerSessionRegistry;

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/src/lib/calls/callSignaling', () => ({
  wrapAndPublish: vi.fn().mockResolvedValue(undefined),
  encodeOffer: vi.fn().mockReturnValue({ kind: 25050, content: '', tags: [], pubkey: '', created_at: 0 }),
  encodeAnswer: vi.fn().mockReturnValue({ kind: 25051, content: '', tags: [], pubkey: '', created_at: 0 }),
  encodeIceCandidate: vi.fn().mockReturnValue({ kind: 25052, content: '', tags: [], pubkey: '', created_at: 0 }),
  encodeHangup: vi.fn().mockReturnValue({ kind: 25053, content: '', tags: [], pubkey: '', created_at: 0 }),
  encodeReject: vi.fn().mockReturnValue({ kind: 25054, content: '', tags: [], pubkey: '', created_at: 0 }),
  encodeRenegotiate: vi.fn().mockReturnValue({ kind: 25055, content: '', tags: [], pubkey: '', created_at: 0 }),
}));

vi.mock('@/src/lib/calls/mediaManager', () => {
  const stream = {
    getTracks: vi.fn().mockReturnValue([]),
    getAudioTracks: vi.fn().mockReturnValue([{ enabled: true }]),
    getVideoTracks: vi.fn().mockReturnValue([]),
  };
  // Expose the stream via globalThis so test bodies can reference it.
  (globalThis as Record<string, unknown>).__mockStream__ = stream;
  return {
    acquireMedia: vi.fn().mockResolvedValue({ stream, audioTrack: {}, videoTrack: null }),
    muteAudio: vi.fn(),
    disableVideo: vi.fn(),
    releaseMedia: vi.fn(),
  };
});

vi.mock('@/src/lib/calls/turnConfig', () => ({
  getIceConfig: vi.fn().mockReturnValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));

vi.mock('@/src/lib/calls/peerSession', () => {
  class PeerSession {
    callbacks: unknown;
    addLocalStream = vi.fn();
    createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-offer-sdp' });
    createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-answer-sdp' });
    applyRemoteOffer = vi.fn().mockResolvedValue(undefined);
    createLocalAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-answer-sdp' });
    applyAnswer = vi.fn().mockResolvedValue(undefined);
    applyRenegotiateOffer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-reneg-answer' });
    createIceRestartOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-restart-offer' });
    addIceCandidate = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    connectionState: RTCPeerConnectionState = 'new';

    constructor(_iceConfig: unknown, cbs: unknown) {
      this.callbacks = cbs;
      const reg = (globalThis as Record<string, unknown>).__peerSessionRegistry__;
      if (Array.isArray(reg)) reg.push(this);
    }
  }
  return { PeerSession };
});

// ── Lazy imports (after mocks are declared) ───────────────────────────────────

import { CallManager } from '@/src/lib/calls/callManager';
import {
  wrapAndPublish,
  encodeAnswer,
  encodeReject,
  encodeHangup,
  encodeRenegotiate,
  encodeOffer,
} from '@/src/lib/calls/callSignaling';
import { releaseMedia } from '@/src/lib/calls/mediaManager';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWN_PUBKEY = 'a'.repeat(64);
const PEER_A = 'b'.repeat(64);
const PEER_B = 'c'.repeat(64);
const PEER_C = 'd'.repeat(64);
const CALL_ID = '11111111-1111-1111-1111-111111111111';

function makeDeps(overrides: Partial<Parameters<typeof CallManager['prototype']['handleEvent']>> = {}): ConstructorParameters<typeof CallManager>[0] {
  return {
    pubkeyHex: OWN_PUBKEY,
    privateKeyHex: '0'.repeat(64),
    signer: {
      signEvent: vi.fn(),
      getPublicKey: vi.fn().mockResolvedValue(OWN_PUBKEY),
      nip44: { encrypt: vi.fn(), decrypt: vi.fn() },
    } as unknown as import('applesauce-core').EventSigner,
    ndk: {} as import('@nostr-dev-kit/ndk').default,
    getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_A, PEER_B, PEER_C]),
    getGroupIds: vi.fn().mockReturnValue(['test-group']),
    ...(overrides as object),
  };
}

function makeOfferEvent(overrides: Partial<IncomingCallEvent> = {}): IncomingCallEvent {
  return {
    kind: 25050,
    callId: CALL_ID,
    senderPubkey: PEER_A,
    callType: 'voice',
    sdp: 'offer-sdp-content',
    recipientPubkeys: [OWN_PUBKEY, PEER_B],
    innerEventId: 'inner-id-1',
    ...overrides,
  };
}

/** Convenience accessor for the mock stream created in the mediaManager vi.mock factory. */
function getMockStream(): MediaStream {
  return (globalThis as Record<string, unknown>).__mockStream__ as MediaStream;
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  callStore.clearAll();
  peerSessionRegistry.length = 0;
  vi.clearAllMocks();
  // Restore default resolved values after clearAllMocks
  (wrapAndPublish as Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  callStore.clearAll();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CallManager', () => {

  // ── T1 ────────────────────────────────────────────────────────────────────

  describe('T1: Incoming offer → callStore.incoming is set', () => {
    it('sets incoming with callId, callerPubkey, callType', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent());

      const state = callStore.getSnapshot();
      expect(state.incoming).not.toBeNull();
      expect(state.incoming!.callId).toBe(CALL_ID);
      expect(state.incoming!.callerPubkey).toBe(PEER_A);
      expect(state.incoming!.callType).toBe('voice');
      expect(state.active).toBeNull();

      manager.destroy();
    });
  });

  // ── T2 ────────────────────────────────────────────────────────────────────

  describe('T2: declineCall() sends 25054 Reject and clears callStore', () => {
    it('sends reject to peers and own pubkey (multi-device echo), then clears store', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent());
      expect(callStore.getSnapshot().incoming).not.toBeNull();

      await manager.declineCall(CALL_ID);

      expect(encodeReject).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID, senderPubkeyHex: OWN_PUBKEY }),
      );
      const destinations = (wrapAndPublish as Mock).mock.calls.map((c) => c[1] as string);
      expect(destinations).toContain(OWN_PUBKEY);

      const state = callStore.getSnapshot();
      expect(state.incoming).toBeNull();
      expect(state.active).toBeNull();

      manager.destroy();
    });
  });

  // ── T3 ────────────────────────────────────────────────────────────────────

  describe('T3: Ring timeout (45s) → auto-decline', () => {
    it('auto-declines after 45 seconds', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent());
      expect(callStore.getSnapshot().incoming).not.toBeNull();

      vi.advanceTimersByTime(45_001);
      await vi.runAllTimersAsync();

      expect(encodeReject).toHaveBeenCalled();
      expect(callStore.getSnapshot().incoming).toBeNull();

      manager.destroy();
    });
  });

  // ── T4 ────────────────────────────────────────────────────────────────────

  describe('T4: 5-cap enforcement', () => {
    it('throws when target peers + self exceeds 5', async () => {
      const manager = new CallManager(makeDeps());
      const peers = Array.from({ length: 5 }, (_, i) => String(i).padEnd(64, '0'));

      await expect(
        manager.startCall({ callType: 'voice', groupId: null, targetPubkeys: peers }),
      ).rejects.toThrow(/participant cap exceeded/i);

      manager.destroy();
    });

    it('allows exactly 4 peers + self (5 total)', async () => {
      const manager = new CallManager(makeDeps());
      const peers = Array.from({ length: 4 }, (_, i) => String(i).padEnd(64, '0'));

      await expect(
        manager.startCall({ callType: 'voice', groupId: null, targetPubkeys: peers }),
      ).resolves.toBeUndefined();

      manager.destroy();
    });
  });

  // ── T5 ────────────────────────────────────────────────────────────────────

  describe('T5: Busy auto-reject when already in an active call', () => {
    it('sends 25054 with "busy" and does not enter ringing state', async () => {
      const manager = new CallManager(makeDeps());

      callStore.setActive({
        callId: 'existing-call',
        participants: [],
        localStream: null,
        callType: 'voice',
      });

      await manager.handleEvent(makeOfferEvent({ callId: 'new-call-id' }));

      expect(encodeReject).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'busy', callId: 'new-call-id' }),
      );
      // The existing active call is untouched
      expect(callStore.getSnapshot().active?.callId).toBe('existing-call');

      manager.destroy();
    });
  });

  // ── T6 ────────────────────────────────────────────────────────────────────

  describe('T6: Multi-device echo — acceptCall wraps 25051 to own pubkey', () => {
    it('includes own pubkey in the wrapAndPublish destinations', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY, PEER_B] }));
      await manager.acceptCall(CALL_ID);

      const destinations = (wrapAndPublish as Mock).mock.calls.map((c) => c[1] as string);
      expect(destinations).toContain(OWN_PUBKEY);
      expect(destinations).toContain(PEER_A);

      manager.destroy();
    });
  });

  // ── T7 ────────────────────────────────────────────────────────────────────

  describe('T7: Mesh — a new callee\'s own broadcast answer triggers a lower-pubkey offer', () => {
    it('initiates an offer to the joining callee when we out-rank them', async () => {
      // Realistic wire shape: the new callee (PEER_B) broadcasts ITS OWN 25051
      // answer; the answer lists the other participants, NOT the answerer. The
      // earlier code skipped evt.senderPubkey and so never connected to the new
      // callee — this guards the corrected lower-pubkey-initiates path.
      const manager = new CallManager(makeDeps());
      // Accept a 1:1-shaped offer from PEER_A (only OWN is p-tagged so far).
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));
      await manager.acceptCall(CALL_ID);
      getMockStream(); // ensure mock stream was initialized

      vi.clearAllMocks();
      (wrapAndPublish as Mock).mockResolvedValue(undefined);

      // PEER_B (in the group roster, pubkey > OWN) announces it has joined.
      await manager.handleEvent({
        kind: 25051,
        callId: CALL_ID,
        senderPubkey: PEER_B,
        sdp: 'peer-b-join-answer',
        recipientPubkeys: [OWN_PUBKEY, PEER_A],
        innerEventId: 'peer-b-join',
      });

      // OWN ('a'…) < PEER_B ('c'…) → OWN initiates the pairwise offer to PEER_B.
      expect(encodeOffer).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID }),
      );
      const destinations = (wrapAndPublish as Mock).mock.calls.map((c) => c[1] as string);
      expect(destinations).toContain(PEER_B);

      manager.destroy();
    });
  });

  // ── T8 ────────────────────────────────────────────────────────────────────

  describe('T8: Hangup — sends 25053 to all peers and tears down', () => {
    it('sends hangup and clears callStore', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY, PEER_B] }));
      await manager.acceptCall(CALL_ID);

      vi.clearAllMocks();
      (wrapAndPublish as Mock).mockResolvedValue(undefined);

      await manager.hangup();

      expect(encodeHangup).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID }),
      );
      expect(wrapAndPublish).toHaveBeenCalled();

      const state = callStore.getSnapshot();
      expect(state.active).toBeNull();
      expect(state.incoming).toBeNull();

      manager.destroy();
    });
  });

  // ── T9 ────────────────────────────────────────────────────────────────────

  describe('T9: ICE restart on PeerSession connectionState === "failed"', () => {
    it('creates an ICE restart offer and sends 25055 renegotiate on first failure', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));
      await manager.acceptCall(CALL_ID);

      vi.clearAllMocks();
      (wrapAndPublish as Mock).mockResolvedValue(undefined);

      // Retrieve the PeerSession created for PEER_A and simulate connection failure
      const session = peerSessionRegistry[0] as MockPeerSession;
      expect(session).toBeDefined();
      (session.createIceRestartOffer as Mock).mockResolvedValue({ type: 'offer', sdp: 'restart-offer' });

      (session.callbacks as { onConnectionStateChange: (s: RTCPeerConnectionState) => void })
        .onConnectionStateChange('failed');

      // Allow async work to flush
      await Promise.resolve();
      await Promise.resolve();

      expect(encodeRenegotiate).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID }),
      );
      expect(wrapAndPublish).toHaveBeenCalled();

      manager.destroy();
    });
  });

  // ── T10 ───────────────────────────────────────────────────────────────────

  describe('T10: Multi-device echo receive — 25054 from self stops ringing', () => {
    it('clears incoming state when own pubkey sends a Reject', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent());
      expect(callStore.getSnapshot().incoming).not.toBeNull();

      await manager.handleEvent({
        kind: 25054,
        callId: CALL_ID,
        senderPubkey: OWN_PUBKEY,
        recipientPubkeys: [PEER_A],
        reason: '',
        innerEventId: 'self-reject',
      });

      expect(callStore.getSnapshot().incoming).toBeNull();

      manager.destroy();
    });
  });

  // ── T11 ───────────────────────────────────────────────────────────────────

  describe('T11: Multi-device echo receive — 25051 from self stops ringing', () => {
    it('clears incoming state when own pubkey sends an Answer', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent());
      expect(callStore.getSnapshot().incoming).not.toBeNull();

      await manager.handleEvent({
        kind: 25051,
        callId: CALL_ID,
        senderPubkey: OWN_PUBKEY,
        sdp: 'self-device-answered',
        recipientPubkeys: [PEER_A],
        innerEventId: 'self-answer',
      });

      expect(callStore.getSnapshot().incoming).toBeNull();

      manager.destroy();
    });
  });

  // ── T12 ───────────────────────────────────────────────────────────────────

  describe('T12: Strict group-roster binding — off-roster p-tags are not authorized', () => {
    it('ignores a hangup from a participant the offer named but who is not in the group', async () => {
      // The group only contains OWN and PEER_A. The offer p-tags PEER_C (not a
      // member). The old code trusted the p-tags as the roster, which would have
      // authorized PEER_C. With strict binding, PEER_C cannot drive signaling.
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_A]),
      });
      await manager.handleEvent(
        makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY, PEER_C] }),
      );
      await manager.acceptCall(CALL_ID);
      expect(callStore.getSnapshot().active).not.toBeNull();

      // A hangup from the off-roster PEER_C must be ignored — the call survives.
      await manager.handleEvent({
        kind: 25053,
        callId: CALL_ID,
        senderPubkey: PEER_C,
        recipientPubkeys: [OWN_PUBKEY],
        reason: '',
        innerEventId: 'offroster-hangup',
      });
      expect(callStore.getSnapshot().active).not.toBeNull();

      manager.destroy();
    });
  });

  // ── T13 ───────────────────────────────────────────────────────────────────

  describe('T13: 1:1 fallback — caller in no shared group rings as a direct call', () => {
    it('rings with groupId null when the caller shares no MLS group (spec §5.3)', async () => {
      // PEER_A is in none of the user's groups. Per spec §5.3 the call is not
      // dropped: it falls back to a direct 1:1 authorized on the caller pubkey
      // alone (the outer IncomingCallWatcher gate has already confirmed PEER_A is
      // a known contact before this event reaches the manager).
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_B]), // PEER_A absent
      });
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));

      const incoming = callStore.getSnapshot().incoming;
      expect(incoming).not.toBeNull();
      expect(incoming!.callerPubkey).toBe(PEER_A);
      expect(incoming!.groupId).toBeNull();

      manager.destroy();
    });
  });

  // ── T13-block ─────────────────────────────────────────────────────────────

  describe('T13-block: a blocked caller cannot ring a direct 1:1 call (BACKLOG gate-incoming-calls-with-block-deny)', () => {
    it('drops a direct (no shared group) offer from a blocked caller — no ring, no busy/reject reply', async () => {
      const isBlockedCaller = vi.fn((pk: string) => pk === PEER_A);
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_B]), // PEER_A shares no group
        isBlockedCaller,
      });
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));

      expect(isBlockedCaller).toHaveBeenCalledWith(PEER_A);
      expect(callStore.getSnapshot().incoming).toBeNull();
      expect(wrapAndPublish).not.toHaveBeenCalled();
      manager.destroy();
    });

    it('drops a blocked direct caller even while busy (no busy reply that would reveal presence)', async () => {
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_B]),
        isBlockedCaller: (pk: string) => pk === PEER_A,
      });
      callStore.setActive({
        callId: 'other-call',
        participants: [],
        localStream: null,
        callType: 'voice',
      });
      await manager.handleEvent(
        makeOfferEvent({ callId: 'new-call-id', senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }),
      );
      expect(encodeReject).not.toHaveBeenCalled();
      expect(wrapAndPublish).not.toHaveBeenCalled();
      manager.destroy();
    });

    it('still rings a direct call from a caller that is NOT blocked', async () => {
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_B]),
        isBlockedCaller: (pk: string) => pk === PEER_C,
      });
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));
      expect(callStore.getSnapshot().incoming?.callerPubkey).toBe(PEER_A);
      manager.destroy();
    });

    it('does NOT apply the block deny to a group call (group calls are out of scope, owner question Q8)', async () => {
      const manager = new CallManager({
        ...makeDeps(), // default roster contains PEER_A → binds to test-group
        isBlockedCaller: (pk: string) => pk === PEER_A,
      });
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A }));
      const incoming = callStore.getSnapshot().incoming;
      expect(incoming?.callerPubkey).toBe(PEER_A);
      expect(incoming?.groupId).toBe('test-group');
      manager.destroy();
    });
  });

  // ── T13b ──────────────────────────────────────────────────────────────────

  describe('T13b: answerer applies the remote offer BEFORE adding local media', () => {
    it('orders applyRemoteOffer → addLocalStream → createLocalAnswer on accept', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));
      await manager.acceptCall(CALL_ID);

      const session = peerSessionRegistry[0] as MockPeerSession;
      expect(session.applyRemoteOffer).toHaveBeenCalledTimes(1);
      expect(session.addLocalStream).toHaveBeenCalledTimes(1);
      expect(session.createLocalAnswer).toHaveBeenCalledTimes(1);

      // Adding local tracks before the remote offer is applied can leave the
      // answerer not negotiating to RECEIVE one of the caller's tracks (the
      // "callee can't see the caller's video" bug). Enforce the correct order.
      const offerOrder = session.applyRemoteOffer.mock.invocationCallOrder[0];
      const addStreamOrder = session.addLocalStream.mock.invocationCallOrder[0];
      const answerOrder = session.createLocalAnswer.mock.invocationCallOrder[0];
      expect(offerOrder).toBeLessThan(addStreamOrder);
      expect(addStreamOrder).toBeLessThan(answerOrder);

      manager.destroy();
    });
  });

  // ── T14 ───────────────────────────────────────────────────────────────────

  describe('T14: 5-party cap — exactly 4 remote peers + self is accepted', () => {
    it('accepts a call with 4 remote peers (5 total)', async () => {
      const PEER_D = 'e'.repeat(64);
      const manager = new CallManager({
        ...makeDeps(),
        getGroupRoster: vi.fn().mockResolvedValue([OWN_PUBKEY, PEER_A, PEER_B, PEER_C, PEER_D]),
      });
      await manager.handleEvent(
        makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY, PEER_B, PEER_C, PEER_D] }),
      );
      await manager.acceptCall(CALL_ID);

      expect(callStore.getSnapshot().active).not.toBeNull();
      expect(callStore.getSnapshot().incoming).toBeNull();

      manager.destroy();
    });
  });

  // ── T15 ───────────────────────────────────────────────────────────────────

  describe('T15: Renegotiation is answered with a 25051 Answer (not another 25055)', () => {
    it('applies the renegotiate offer and replies with encodeAnswer', async () => {
      const manager = new CallManager(makeDeps());
      await manager.handleEvent(makeOfferEvent({ senderPubkey: PEER_A, recipientPubkeys: [OWN_PUBKEY] }));
      await manager.acceptCall(CALL_ID);

      vi.clearAllMocks();
      (wrapAndPublish as Mock).mockResolvedValue(undefined);

      await manager.handleEvent({
        kind: 25055,
        callId: CALL_ID,
        senderPubkey: PEER_A,
        sdp: 'renegotiate-offer-sdp',
        recipientPubkeys: [OWN_PUBKEY],
        innerEventId: 'reneg-1',
      });

      expect(encodeAnswer).toHaveBeenCalledWith(expect.objectContaining({ callId: CALL_ID }));
      expect(encodeRenegotiate).not.toHaveBeenCalled();
      const destinations = (wrapAndPublish as Mock).mock.calls.map((c) => c[1] as string);
      expect(destinations).toContain(PEER_A);

      manager.destroy();
    });

    it('answers a renegotiation from a LOWER-pubkey peer (no longer silently ignored)', async () => {
      // Own pubkey is high ('f'…), peer is low ('b'…). The old glare rule dropped
      // any renegotiate whose sender was not greater than us — breaking ICE restart
      // from the lower side. It must now be answered.
      const HIGH_OWN = 'f'.repeat(64);
      const LOW_PEER = 'b'.repeat(64);
      const deps = {
        ...makeDeps(),
        pubkeyHex: HIGH_OWN,
        getGroupRoster: vi.fn().mockResolvedValue([HIGH_OWN, LOW_PEER]),
      };
      const manager = new CallManager(deps);
      await manager.handleEvent(
        makeOfferEvent({ senderPubkey: LOW_PEER, recipientPubkeys: [HIGH_OWN] }),
      );
      await manager.acceptCall(CALL_ID);

      vi.clearAllMocks();
      (wrapAndPublish as Mock).mockResolvedValue(undefined);

      await manager.handleEvent({
        kind: 25055,
        callId: CALL_ID,
        senderPubkey: LOW_PEER,
        sdp: 'low-peer-renegotiate',
        recipientPubkeys: [HIGH_OWN],
        innerEventId: 'reneg-low',
      });

      expect(encodeAnswer).toHaveBeenCalledWith(expect.objectContaining({ callId: CALL_ID }));

      manager.destroy();
    });
  });

  // ── T16 ───────────────────────────────────────────────────────────────────

  describe('T16: startCall tears down on publish failure (no leaked media/state)', () => {
    it('clears the active call and releases media when wrapAndPublish rejects', async () => {
      (wrapAndPublish as Mock).mockRejectedValue(new Error('relay unavailable'));
      const manager = new CallManager(makeDeps());

      await expect(
        manager.startCall({ callType: 'voice', groupId: null, targetPubkeys: [PEER_A] }),
      ).rejects.toThrow(/relay unavailable/);

      expect(callStore.getSnapshot().active).toBeNull();
      expect(releaseMedia).toHaveBeenCalled();

      manager.destroy();
    });
  });

  // ── T17 ───────────────────────────────────────────────────────────────────

  describe('T17: Caller-side ring timeout ends an unanswered call', () => {
    it('tears down after the ring timeout when no peer connected', async () => {
      const manager = new CallManager(makeDeps());
      await manager.startCall({ callType: 'voice', groupId: null, targetPubkeys: [PEER_A] });
      expect(callStore.getSnapshot().active).not.toBeNull();

      vi.advanceTimersByTime(45_001);
      await vi.runAllTimersAsync();

      expect(callStore.getSnapshot().active).toBeNull();

      manager.destroy();
    });

    it('does NOT tear down if a peer has connected before the timeout', async () => {
      const manager = new CallManager(makeDeps());
      await manager.startCall({ callType: 'voice', groupId: null, targetPubkeys: [PEER_A] });

      // Simulate the peer leg reaching 'connected'.
      const session = peerSessionRegistry[0] as MockPeerSession;
      session.connectionState = 'connected';
      (session.callbacks as { onConnectionStateChange: (s: RTCPeerConnectionState) => void })
        .onConnectionStateChange('connected');

      vi.advanceTimersByTime(45_001);
      await vi.runAllTimersAsync();

      expect(callStore.getSnapshot().active).not.toBeNull();

      manager.destroy();
    });
  });

});
