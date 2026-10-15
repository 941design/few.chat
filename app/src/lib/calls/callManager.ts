/**
 * callManager.ts — Orchestration hub for WebRTC call state machine (Story S5).
 *
 * Wires together callSignaling (S1), callStore (S2), mediaManager (S3),
 * peerSession (S4), and turnConfig (S4) into the full call lifecycle.
 *
 * Pure library code — no React imports.
 *
 * State machine per call-id:
 *   idle → receive 25050 Offer → callStore.setIncoming → ringing
 *   ringing → acceptCall() → acquire media → create PeerSession → send 25051 Answer → active
 *   ringing → declineCall() → send 25054 Reject → idle
 *   ringing → ring timeout (45s) → declineCall('', 'missed') → idle
 *   active → receive 25053 Hangup from peer → remove participant → if 0 remaining → idle
 *   active → hangup() → send 25053 to all peers → close PeerSessions → idle
 *
 * Mesh rules (§9):
 *   - startCall(): generate UUID, send one 25050 to each target peer; p tags list ALL participants.
 *   - lower pubkey initiates pairwise offer when a new callee joins.
 *   - glare: higher pubkey wins; loser rolls back and accepts winner's offer.
 *   - 5-cap: refuse start/accept when activeParticipantCount >= 5.
 *   - multi-device echo: wrap 25051/25054 to own pubkey too.
 *   - join mid-call: existing connected participants initiate offers to the new peer.
 *
 * ICE restart (§15):
 *   On connectionState === 'failed', attempt one ICE restart (createIceRestartOffer + send 25055).
 *   On second failure, mark leg failed in callStore.
 *
 * Authorization (§5.2):
 *   For kind 25050: find group with most p-tag overlap → that is the call's group.
 *   For subsequent events: check against roster snapshot taken at call start.
 */

import type NDK from '@nostr-dev-kit/ndk';
import type { EventSigner } from 'applesauce-core';
import type { IncomingCallEvent } from '@/src/types';
import { callStore } from './callStore';
import { PeerSession } from './peerSession';
import { getIceConfig } from './turnConfig';
import { acquireMedia, muteAudio, disableVideo, releaseMedia } from './mediaManager';
import {
  wrapAndPublish,
  encodeAnswer,
  encodeReject,
  encodeHangup,
  encodeIceCandidate,
  encodeRenegotiate,
  encodeOffer,
} from './callSignaling';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum participants in a single call (inclusive of self). */
const MAX_PARTICIPANTS = 5;

/** Seconds before an unanswered incoming ring is treated as missed. */
const RING_TIMEOUT_MS = 45_000;

// ── Public interface ──────────────────────────────────────────────────────────

export interface CallManagerDeps {
  pubkeyHex: string;
  privateKeyHex: string;
  signer: EventSigner;
  ndk: NDK;
  /** Async roster lookup for a group — returns hex pubkeys of all members. */
  getGroupRoster: (groupId: string) => Promise<string[]>;
  /**
   * Synchronous list of the local user's group ids. Used to resolve which MLS
   * group an incoming offer belongs to (§5.2): the call roster is bound to that
   * group's membership, not to the offer's self-asserted `p` tags.
   */
  getGroupIds?: () => string[];
  /** Optional debug hook, called for every routed IncomingCallEvent. */
  onEvent?: (evt: IncomingCallEvent) => void;
  /**
   * Optional: publish a kind-9 application rumor to the given group so the
   * call notice appears in the group timeline.
   * Called after startCall() sends its first offer (event='started') and after
   * hangup() completes (event='ended'). Errors are swallowed — notice delivery
   * is best-effort and must never abort the call flow.
   */
  publishGroupNotice?: (groupId: string, content: string) => Promise<void>;
  /**
   * Optional block deny-list check (BACKLOG gate-incoming-calls-with-block-deny).
   * A DIRECT 1:1 offer (caller shares none of the user's groups, spec §5.3) from
   * a caller for whom this returns true is silently dropped — no ring, no
   * busy/reject reply. Group calls are deliberately not gated here (owner
   * product question Q8).
   */
  isBlockedCaller?: (pubkeyHex: string) => boolean;
}

// ── Internal state shapes ─────────────────────────────────────────────────────

type CallPhase = 'ringing' | 'active';

/**
 * Per-call context — created when a call offer arrives or when we start a call.
 */
interface CallContext {
  callId: string;
  phase: CallPhase;
  callType: 'voice' | 'video';
  /** The group roster snapshotted at call start. Only members on this list may send signaling. */
  rosterSnapshot: Set<string>;
  /** groupId resolved from roster overlap; null for direct (non-group) calls. */
  groupId: string | null;
  /** Hex pubkeys of all remote participants (excluding self). */
  peerPubkeys: Set<string>;
  /** Active PeerSession per peer pubkey. */
  sessions: Map<string, PeerSession>;
  /** ICE restart attempt count per peer. */
  iceRestartAttempts: Map<string, number>;
  /** Peers we have an in-flight renegotiation offer to (for glare resolution, §9.3). */
  renegotiating: Set<string>;
  /** Local media stream (acquired on accept/startCall). */
  localStream: MediaStream | null;
  /** Ring timeout handle — cleared once accepted/declined. */
  ringTimeoutHandle: ReturnType<typeof setTimeout> | null;
}

// ── CallManager ───────────────────────────────────────────────────────────────

export class CallManager {
  private readonly deps: CallManagerDeps;
  /** Current call context, null when idle. */
  private ctx: CallContext | null = null;
  /** Whether destroy() has been called. */
  private destroyed = false;

  constructor(deps: CallManagerDeps) {
    this.deps = deps;
  }

  // ── Public: start an outgoing call ─────────────────────────────────────────

  /**
   * Initiate an outgoing call.
   * Generates a UUID callId, acquires media, creates one PeerSession per target
   * peer, and sends a 25050 Offer to each.
   *
   * Throws if there is already an active call (5-cap enforced against targetPubkeys).
   */
  async startCall(params: {
    callType: 'voice' | 'video';
    groupId: string | null;
    targetPubkeys: string[];
  }): Promise<void> {
    if (this.destroyed) return;

    const { callType, groupId, targetPubkeys } = params;

    // 5-cap: self counts as one participant
    if (targetPubkeys.length + 1 > MAX_PARTICIPANTS) {
      throw new Error(
        `[callManager] startCall: participant cap exceeded (max ${MAX_PARTICIPANTS} including self)`,
      );
    }

    // Refuse to start if already in a call
    const existing = callStore.getSnapshot();
    if (existing.active !== null) {
      throw new Error('[callManager] startCall: already in an active call');
    }

    // Acquire media first — fail fast before touching the call store
    const media = await acquireMedia(callType);

    const callId = crypto.randomUUID();

    // Snapshot roster — for outgoing calls use targetPubkeys as the roster
    const rosterSnapshot = new Set([...targetPubkeys, this.deps.pubkeyHex]);

    this.ctx = {
      callId,
      phase: 'active',
      callType,
      rosterSnapshot,
      groupId,
      peerPubkeys: new Set(targetPubkeys),
      sessions: new Map(),
      iceRestartAttempts: new Map(),
      renegotiating: new Set(),
      localStream: media.stream,
      ringTimeoutHandle: null,
    };

    // Update store immediately with an active call (no incoming phase for outgoing)
    callStore.setActive({
      callId,
      participants: targetPubkeys.map((pk) => ({
        pubkey: pk,
        stream: null,
        muted: false,
        videoOff: false,
      })),
      localStream: media.stream,
      callType,
    });

    // Caller-side ring timeout: if no peer answers/connects within the window, end
    // the call and release the mic/camera. Cleared on the first peer 'connected'
    // (see _createPeerSession). Without this the caller holds media open forever
    // when the callee is offline or never picks up.
    this.ctx.ringTimeoutHandle = setTimeout(() => {
      void this._onRingTimeout(callId);
    }, RING_TIMEOUT_MS);

    // Create a PeerSession for each target and send an offer
    const allParticipants = [this.deps.pubkeyHex, ...targetPubkeys];

    try {
      await Promise.all(
        targetPubkeys.map(async (remotePk) => {
          const session = this._createPeerSession(callId, remotePk);
          session.addLocalStream(media.stream);
          const offerSdp = await session.createOffer();

          const draft = encodeOffer({
            senderPubkeyHex: this.deps.pubkeyHex,
            recipientPubkeys: allParticipants.filter((p) => p !== this.deps.pubkeyHex),
            callId,
            callType,
            sdp: offerSdp.sdp ?? '',
          });

          await wrapAndPublish(draft, remotePk, this.deps.signer, this.deps.ndk);
        }),
      );
    } catch (err) {
      // A signing/relay failure must not leave the call store active with the
      // mic/camera still capturing. Tear down and surface the failure to the UI.
      console.warn('[callManager] startCall: offer publish failed, tearing down', err);
      if (this.ctx && this.ctx.callId === callId) {
        this._teardownCall(this.ctx);
      }
      throw err;
    }

    // Group call notice: started (fire-and-forget)
    if (groupId && this.deps.publishGroupNotice) {
      this.deps.publishGroupNotice(
        groupId,
        JSON.stringify({ type: 'call_notice', event: 'started', callId, initiator: this.deps.pubkeyHex }),
      ).catch((err) => console.warn('[callManager] call notice (started) failed', err));
    }
  }

  // ── Public: accept an incoming call ────────────────────────────────────────

  /**
   * Accept a ringing incoming call.
   * Acquires media, creates a PeerSession for the caller, sends 25051 Answer,
   * and updates callStore to active.
   *
   * Also wraps 25051 to own pubkey (multi-device echo §9.8).
   */
  async acceptCall(callId: string): Promise<void> {
    if (this.destroyed) return;
    if (!this.ctx || this.ctx.callId !== callId || this.ctx.phase !== 'ringing') {
      console.warn('[callManager] acceptCall: no ringing call with id', callId);
      return;
    }

    const ctx = this.ctx;
    this._clearRingTimeout(ctx);

    // 5-cap check: self + remote peers must not exceed MAX_PARTICIPANTS.
    // 4 remote peers + self == 5 is the allowed maximum (use > not >=).
    if (ctx.peerPubkeys.size + 1 > MAX_PARTICIPANTS) {
      console.warn('[callManager] acceptCall: participant cap exceeded, declining');
      await this.declineCall(callId, 'busy');
      return;
    }

    let media: Awaited<ReturnType<typeof acquireMedia>>;
    try {
      media = await acquireMedia(ctx.callType);
    } catch (err) {
      console.warn('[callManager] acceptCall: media acquisition failed:', err);
      await this.declineCall(callId);
      return;
    }

    ctx.localStream = media.stream;
    ctx.phase = 'active';

    // The incoming offer from the store has the SDP from the caller.
    // We need to store the offer SDP somewhere to create an answer.
    // The SDP was provided in the IncomingCallEvent we processed earlier.
    // We store it temporarily in _pendingOfferSdp per callId.
    const pendingSdp = this._pendingOfferSdps.get(callId);
    const callerPubkey = callStore.getSnapshot().incoming?.callerPubkey;

    if (!pendingSdp || !callerPubkey) {
      console.warn('[callManager] acceptCall: missing pending SDP or caller pubkey');
      releaseMedia(media.stream);
      ctx.localStream = null;
      await this.declineCall(callId);
      return;
    }
    this._pendingOfferSdps.delete(callId);

    // Create PeerSession for caller
    const session = this._createPeerSession(callId, callerPubkey);

    // Build full participant list from the roster: all peers except self
    const peerPubkeys = [...ctx.peerPubkeys];
    const answerRecipients = peerPubkeys; // p tags list all other participants

    // Publish the active call to the store BEFORE applying the remote offer.
    // applyRemoteOffer() sets the remote description, which fires the caller's
    // onTrack synchronously; if no active call exists at that instant,
    // _updateParticipantStream has nowhere to attach the remote stream and the
    // callee never renders the caller's tile (the caller side is unaffected
    // because its active call is already set from startCall). Initialising
    // participants with stream:null here guarantees onTrack lands on a real
    // participant.
    callStore.setActive({
      callId,
      participants: peerPubkeys.map((pk) => ({
        pubkey: pk,
        stream: null,
        muted: false,
        videoOff: false,
      })),
      localStream: media.stream,
      callType: ctx.callType,
    });

    // Answerer order (§9.2): apply the caller's offer FIRST so its transceivers
    // exist, THEN attach our local media (it binds to those transceivers as
    // sendrecv), THEN produce the answer. Adding local tracks before the offer
    // is applied can leave us not negotiating to RECEIVE one of the caller's
    // tracks in stricter / cross-browser setups — "callee can't see the caller's
    // video". See the ordering contract on PeerSession.applyRemoteOffer.
    await session.applyRemoteOffer({ type: 'offer', sdp: pendingSdp });
    session.addLocalStream(media.stream);
    const answerSdp = await session.createLocalAnswer();

    const draft = encodeAnswer({
      senderPubkeyHex: this.deps.pubkeyHex,
      recipientPubkeys: answerRecipients,
      callId,
      sdp: answerSdp.sdp ?? '',
    });

    try {
      // Broadcast the answer to every peer (and our own other devices). For the
      // caller it carries the real SDP answer; for the other callees it is the
      // "I've joined" presence signal (§9.2).
      await Promise.all(
        [...peerPubkeys, this.deps.pubkeyHex].map((pk) =>
          wrapAndPublish(draft, pk, this.deps.signer, this.deps.ndk),
        ),
      );
    } catch (err) {
      // Publishing the answer failed — the remote will never connect. End the
      // call locally rather than leaving the store active and media capturing.
      console.warn('[callManager] acceptCall: answer publish failed, tearing down', err);
      this._teardownCall(ctx);
      throw err;
    }

    // Mesh (§9.2/§9.3): connect to the other callees. By the lower-pubkey-
    // initiates rule we open the pairwise offer to every callee we out-rank;
    // higher-pubkey callees will offer to us instead. The caller leg is already
    // established by the caller's own offer, so it is skipped here.
    for (const peer of peerPubkeys) {
      if (peer === callerPubkey || peer === this.deps.pubkeyHex) continue;
      if (ctx.sessions.has(peer)) continue;
      if (this.deps.pubkeyHex < peer) {
        await this._initiateOfferTo(ctx, peer);
      }
    }

    // Drain any mesh offers that arrived from lower-pubkey callees while we were
    // still ringing (stashed in _pendingMeshOffers). Answering them now forms the
    // remaining legs regardless of the order in which callees accepted.
    const stashed = this._pendingMeshOffers.get(callId);
    if (stashed) {
      this._pendingMeshOffers.delete(callId);
      for (const [peer, sdp] of stashed) {
        if (peer === this.deps.pubkeyHex || ctx.sessions.has(peer)) continue;
        await this._handleMeshOffer(ctx, peer, sdp);
      }
    }
  }

  // ── Public: decline an incoming call ───────────────────────────────────────

  /**
   * Decline (or miss) a ringing incoming call.
   * Sends 25054 Reject to all peers and wraps to own pubkey for multi-device echo.
   */
  async declineCall(callId: string, reason?: string): Promise<void> {
    if (this.destroyed) return;
    if (!this.ctx || this.ctx.callId !== callId) {
      // Already cleared — no-op
      return;
    }

    const ctx = this.ctx;
    this._clearRingTimeout(ctx);

    const peerPubkeys = [...ctx.peerPubkeys];

    if (peerPubkeys.length > 0) {
      const draft = encodeReject({
        senderPubkeyHex: this.deps.pubkeyHex,
        recipientPubkeys: peerPubkeys,
        callId,
        reason: reason === 'busy' ? 'busy' : '',
      });

      await Promise.all(
        // Multi-device echo: also wrap to self
        [...peerPubkeys, this.deps.pubkeyHex].map((pk) =>
          wrapAndPublish(draft, pk, this.deps.signer, this.deps.ndk).catch((err) =>
            console.warn('[callManager] declineCall: send failed to', pk, err),
          ),
        ),
      );
    }

    this._pendingOfferSdps.delete(callId);
    this._pendingMeshOffers.delete(callId);
    this._pendingIceCandidates.delete(callId);
    this.ctx = null;
    callStore.clearAll();
  }

  // ── Public: hang up active call ─────────────────────────────────────────────

  /**
   * Hang up the current active call.
   * Sends 25053 Hangup to all peers, closes all PeerSessions, releases media.
   */
  async hangup(): Promise<void> {
    if (this.destroyed) return;
    if (!this.ctx || this.ctx.phase !== 'active') {
      console.warn('[callManager] hangup: no active call');
      return;
    }

    const ctx = this.ctx;
    const peerPubkeys = [...ctx.peerPubkeys];

    if (peerPubkeys.length > 0) {
      const draft = encodeHangup({
        senderPubkeyHex: this.deps.pubkeyHex,
        recipientPubkeys: peerPubkeys,
        callId: ctx.callId,
      });

      await Promise.all(
        peerPubkeys.map((pk) =>
          wrapAndPublish(draft, pk, this.deps.signer, this.deps.ndk).catch((err) =>
            console.warn('[callManager] hangup: send failed to', pk, err),
          ),
        ),
      );
    }

    // Group call notice: ended (fire-and-forget)
    if (ctx.groupId && this.deps.publishGroupNotice) {
      this.deps.publishGroupNotice(
        ctx.groupId,
        JSON.stringify({ type: 'call_notice', event: 'ended', callId: ctx.callId, initiator: this.deps.pubkeyHex }),
      ).catch((err) => console.warn('[callManager] call notice (ended) failed', err));
    }

    this._teardownCall(ctx);
  }

  // ── Public: media controls ──────────────────────────────────────────────────

  setMuted(muted: boolean): void {
    if (!this.ctx?.localStream) return;
    muteAudio(this.ctx.localStream, muted);
  }

  setVideoEnabled(enabled: boolean): void {
    if (!this.ctx?.localStream) return;
    disableVideo(this.ctx.localStream, !enabled);
  }

  // ── Public: ICE restart ─────────────────────────────────────────────────────

  /**
   * Manually trigger an ICE restart for a specific peer.
   * Sends 25055 Renegotiate with the restart offer.
   */
  async iceRestart(remotePubkey: string): Promise<void> {
    if (!this.ctx || this.ctx.phase !== 'active') return;
    await this._doIceRestart(this.ctx, remotePubkey);
  }

  // ── Public: route incoming signaling event ──────────────────────────────────

  /**
   * Route an incoming signaling event from IncomingCallWatcher.
   * All kinds (25050–25055) flow through here.
   */
  async handleEvent(evt: IncomingCallEvent): Promise<void> {
    if (this.destroyed) return;
    this.deps.onEvent?.(evt);

    switch (evt.kind) {
      case 25050:
        await this._handleOffer(evt);
        break;
      case 25051:
        await this._handleAnswer(evt);
        break;
      case 25052:
        await this._handleIceCandidate(evt);
        break;
      case 25053:
        await this._handleHangup(evt);
        break;
      case 25054:
        await this._handleReject(evt);
        break;
      case 25055:
        await this._handleRenegotiate(evt);
        break;
    }
  }

  // ── Public: destroy ─────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    if (this.ctx) {
      this._teardownCall(this.ctx);
    }
    this._pendingOfferSdps.clear();
    this._pendingMeshOffers.clear();
    this._pendingIceCandidates.clear();
  }

  // ── Private: pending offer SDP storage ─────────────────────────────────────

  /**
   * Stores the SDP from incoming offers (kind 25050) so acceptCall() can use it
   * to create the answer. Keyed by callId.
   */
  private readonly _pendingOfferSdps = new Map<string, string>();

  /**
   * Mesh offers (kind 25050 carrying the current call-id) that arrived from
   * other callees while we were still ringing on the primary offer. Keyed
   * callId → (senderPubkey → offer SDP). Drained in acceptCall() so the mesh
   * forms regardless of the order callees pick up. Cleared on decline/teardown.
   */
  private readonly _pendingMeshOffers = new Map<string, Map<string, string>>();

  /**
   * ICE candidates that arrived for an authorized call before a PeerSession for
   * their sender existed. The caller starts trickling ICE the instant it sends
   * its offer, but the callee has no session until acceptCall() (and mesh legs
   * have none until the pairwise offer/answer forms). Without this queue those
   * early candidates are dropped — the strongest root cause of "rings/answers
   * but never connects". Keyed callId → (senderPubkey → candidates[]). Drained
   * into the session the moment it is created (_createPeerSession); PeerSession
   * itself then buffers them until its remote description is set. Cleared on
   * decline/teardown/destroy.
   */
  private readonly _pendingIceCandidates = new Map<string, Map<string, RTCIceCandidateInit[]>>();

  /**
   * Auto-accept a mesh offer for the current active call: create the peer leg,
   * answer with a 25051 to the offerer only (the broadcast "I've joined" answer
   * already happened on accept). Authorization is the caller's responsibility —
   * call sites verify roster membership before invoking this.
   */
  private async _handleMeshOffer(ctx: CallContext, senderPubkey: string, sdp: string): Promise<void> {
    if (!ctx.localStream) return;
    if (ctx.sessions.has(senderPubkey)) return; // leg already forming/established

    ctx.peerPubkeys.add(senderPubkey);
    const session = this._createPeerSession(ctx.callId, senderPubkey);

    // Add the new participant to the store BEFORE applying the offer so the
    // onTrack it fires (on setRemoteDescription) lands on a real participant
    // rather than being dropped — same requirement as acceptCall().
    this._syncStoreParticipants(ctx);

    // Answerer order: apply the remote offer first, then attach local media, then
    // answer (see the ordering contract on PeerSession.applyRemoteOffer).
    await session.applyRemoteOffer({ type: 'offer', sdp });
    session.addLocalStream(ctx.localStream);
    const answerSdp = await session.createLocalAnswer();

    const draft = encodeAnswer({
      senderPubkeyHex: this.deps.pubkeyHex,
      recipientPubkeys: [senderPubkey],
      callId: ctx.callId,
      sdp: answerSdp.sdp ?? '',
    });
    await wrapAndPublish(draft, senderPubkey, this.deps.signer, this.deps.ndk).catch((err) =>
      console.warn('[callManager] mesh answer send failed to', senderPubkey, err),
    );
  }

  /**
   * Caller-side ring-timeout handler: if no peer has connected by the deadline,
   * the callee never picked up — end the call and release media.
   */
  private async _onRingTimeout(callId: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.callId !== callId) return;
    const anyConnected = [...ctx.sessions.values()].some(
      (s) => s.connectionState === 'connected',
    );
    if (anyConnected) return;
    console.warn('[callManager] caller ring timeout — no answer, ending call', callId);
    await this.hangup();
  }

  // ── Private: event handlers ─────────────────────────────────────────────────

  private async _handleOffer(evt: IncomingCallEvent): Promise<void> {
    if (!evt.sdp) {
      console.warn('[callManager] _handleOffer: offer has no SDP, dropping');
      return;
    }

    // An offer carrying the call-id we are already in is a mesh leg (§9.2), not a
    // new incoming call — never busy-reject it.
    if (this.ctx && this.ctx.callId === evt.callId) {
      if (!this.ctx.rosterSnapshot.has(evt.senderPubkey)) {
        console.warn('[callManager] _handleOffer: mesh offer sender not in roster, dropping', evt.senderPubkey);
        return;
      }
      if (this.ctx.phase === 'active') {
        // Auto-accept the new pairwise leg.
        await this._handleMeshOffer(this.ctx, evt.senderPubkey, evt.sdp);
      } else {
        // Still ringing on the primary offer: stash this extra leg and answer it
        // once the user accepts (drained in acceptCall). Keeps mesh formation
        // independent of the order in which callees pick up.
        let stash = this._pendingMeshOffers.get(evt.callId);
        if (!stash) {
          stash = new Map();
          this._pendingMeshOffers.set(evt.callId, stash);
        }
        stash.set(evt.senderPubkey, evt.sdp);
      }
      return;
    }

    // Block deny for direct 1:1 calls — checked BEFORE the busy auto-reject so a
    // blocked caller never gets a reply that reveals presence. A call binds to a
    // group whenever the caller is in one of ours (_resolveGroupAndRoster); only
    // the groupless (direct) case is denied.
    if (this.deps.isBlockedCaller?.(evt.senderPubkey)) {
      const { groupId: boundGroupId } = await this._resolveGroupAndRoster(evt);
      if (boundGroupId === null) return;
    }

    // Busy auto-reject: already in a different active call
    const existing = callStore.getSnapshot();
    if (existing.active !== null) {
      const busyDraft = encodeReject({
        senderPubkeyHex: this.deps.pubkeyHex,
        recipientPubkeys: [evt.senderPubkey],
        callId: evt.callId,
        reason: 'busy',
      });
      await wrapAndPublish(busyDraft, evt.senderPubkey, this.deps.signer, this.deps.ndk).catch(
        (err) => console.warn('[callManager] busy reject send failed:', err),
      );
      return;
    }

    // Resolve group and roster for this offer
    const { groupId, rosterSnapshot } = await this._resolveGroupAndRoster(evt);

    // Authorization: sender must be in the resolved group's roster
    if (!rosterSnapshot.has(evt.senderPubkey)) {
      console.warn('[callManager] _handleOffer: sender not in roster, dropping', evt.senderPubkey);
      return;
    }

    // Peers are the offer's p-tagged participants that are also members of the
    // resolved group (strict roster binding — never trust off-roster p-tags),
    // plus the caller.
    const peerPubkeys = new Set(
      evt.recipientPubkeys.filter(
        (pk) => pk !== this.deps.pubkeyHex && rosterSnapshot.has(pk),
      ),
    );
    peerPubkeys.add(evt.senderPubkey);

    // Store the SDP for use by acceptCall()
    this._pendingOfferSdps.set(evt.callId, evt.sdp);

    // Ring timeout
    const ringHandle = setTimeout(() => {
      void this.declineCall(evt.callId, 'missed');
    }, RING_TIMEOUT_MS);

    this.ctx = {
      callId: evt.callId,
      phase: 'ringing',
      callType: evt.callType ?? 'voice',
      rosterSnapshot,
      groupId,
      peerPubkeys,
      sessions: new Map(),
      iceRestartAttempts: new Map(),
      renegotiating: new Set(),
      localStream: null,
      ringTimeoutHandle: ringHandle,
    };

    callStore.setIncoming({
      callId: evt.callId,
      callerPubkey: evt.senderPubkey,
      callType: evt.callType ?? 'voice',
      groupId,
      recipientPubkeys: evt.recipientPubkeys,
    });
  }

  private async _handleAnswer(evt: IncomingCallEvent): Promise<void> {
    // Multi-device echo: if from self, stop ringing on this device
    if (evt.senderPubkey === this.deps.pubkeyHex) {
      if (this.ctx?.callId === evt.callId && this.ctx.phase === 'ringing') {
        this._clearRingTimeout(this.ctx);
        this._pendingOfferSdps.delete(evt.callId);
        this.ctx = null;
        callStore.clearAll();
      }
      return;
    }

    if (!this.ctx || this.ctx.callId !== evt.callId) return;
    if (!this._isAuthorized(evt.senderPubkey)) return;
    if (this.ctx.phase !== 'active') return;
    if (!evt.sdp) return;

    const ctx = this.ctx;
    const session = ctx.sessions.get(evt.senderPubkey);

    if (session) {
      // We sent this peer an offer (initial leg or a renegotiation/ICE restart)
      // — apply their answer and clear any in-flight renegotiation marker.
      await session.applyAnswer({ type: 'answer', sdp: evt.sdp });
      ctx.renegotiating.delete(evt.senderPubkey);
      return;
    }

    // No session with the sender: this is a callee-to-callee "I've joined"
    // broadcast answer (§9.2). The answerer IS evt.senderPubkey; their answer
    // lists the other participants, not themselves. By lower-pubkey-initiates
    // (§9.3) we open the pairwise offer to them when we out-rank them; otherwise
    // we stay passive and they will offer to us.
    ctx.peerPubkeys.add(evt.senderPubkey);
    if (this.deps.pubkeyHex < evt.senderPubkey) {
      await this._initiateOfferTo(ctx, evt.senderPubkey);
    }
    this._syncStoreParticipants(ctx);
  }

  private async _handleIceCandidate(evt: IncomingCallEvent): Promise<void> {
    if (!this.ctx || this.ctx.callId !== evt.callId) return;
    if (!this._isAuthorized(evt.senderPubkey)) return;
    if (!evt.iceCandidate) return;

    const session = this.ctx.sessions.get(evt.senderPubkey);
    if (session) {
      await session.addIceCandidate(evt.iceCandidate).catch((err) =>
        console.warn('[callManager] addIceCandidate failed:', err),
      );
      return;
    }

    // No session yet: the sender is authorized for this call but their leg has
    // not formed (callee still ringing, or a mesh leg not yet offered/answered).
    // Stash the candidate so it survives until _createPeerSession drains it.
    this._stashPendingIce(evt.callId, evt.senderPubkey, evt.iceCandidate);
  }

  /** Queue an ICE candidate that arrived before its PeerSession existed (§ICE-queue). */
  private _stashPendingIce(
    callId: string,
    senderPubkey: string,
    candidate: RTCIceCandidateInit,
  ): void {
    let byCall = this._pendingIceCandidates.get(callId);
    if (!byCall) {
      byCall = new Map();
      this._pendingIceCandidates.set(callId, byCall);
    }
    const list = byCall.get(senderPubkey);
    if (list) list.push(candidate);
    else byCall.set(senderPubkey, [candidate]);
  }

  /**
   * Drain any ICE candidates stashed for (callId, remotePubkey) into a freshly
   * created session. PeerSession.addIceCandidate buffers them internally until
   * the remote description is set, so it is safe to call before offer/answer.
   */
  private _drainPendingIce(callId: string, remotePubkey: string, session: PeerSession): void {
    const byCall = this._pendingIceCandidates.get(callId);
    const list = byCall?.get(remotePubkey);
    if (!byCall || !list || list.length === 0) return;
    byCall.delete(remotePubkey);
    if (byCall.size === 0) this._pendingIceCandidates.delete(callId);
    for (const candidate of list) {
      void session.addIceCandidate(candidate).catch((err) =>
        console.warn('[callManager] drain pending ICE failed:', err),
      );
    }
  }

  private async _handleHangup(evt: IncomingCallEvent): Promise<void> {
    if (!this.ctx || this.ctx.callId !== evt.callId) return;
    if (!this._isAuthorized(evt.senderPubkey)) return;

    const ctx = this.ctx;
    const session = ctx.sessions.get(evt.senderPubkey);
    if (session) {
      session.close();
      ctx.sessions.delete(evt.senderPubkey);
    }
    ctx.peerPubkeys.delete(evt.senderPubkey);

    if (ctx.sessions.size === 0) {
      // Last participant hung up
      this._teardownCall(ctx);
    } else {
      this._syncStoreParticipants(ctx);
    }
  }

  private async _handleReject(evt: IncomingCallEvent): Promise<void> {
    // Multi-device echo: if from self, stop ringing
    if (evt.senderPubkey === this.deps.pubkeyHex) {
      if (this.ctx?.callId === evt.callId && this.ctx.phase === 'ringing') {
        this._clearRingTimeout(this.ctx);
        this._pendingOfferSdps.delete(evt.callId);
        this.ctx = null;
        callStore.clearAll();
      }
      return;
    }

    // In active calls: treat a reject from a specific peer as hangup from that peer
    if (this.ctx?.callId === evt.callId && this.ctx.phase === 'active') {
      await this._handleHangup(evt);
    }
  }

  private async _handleRenegotiate(evt: IncomingCallEvent): Promise<void> {
    if (!this.ctx || this.ctx.callId !== evt.callId || this.ctx.phase !== 'active') return;
    if (!this._isAuthorized(evt.senderPubkey)) return;
    if (!evt.sdp) return;

    const ctx = this.ctx;
    const session = ctx.sessions.get(evt.senderPubkey);
    if (!session) return;

    // Glare (§9.3): a renegotiation collision only exists when WE also have an
    // in-flight renegotiation offer to this same peer. In that case the higher
    // pubkey wins: if we out-rank the sender we ignore their offer (ours stands);
    // otherwise we yield and answer theirs.
    if (ctx.renegotiating.has(evt.senderPubkey) && this.deps.pubkeyHex > evt.senderPubkey) {
      return; // we win the glare — ignore their offer
    }
    // Yielding to (or simply receiving) their offer: drop our own in-flight marker.
    ctx.renegotiating.delete(evt.senderPubkey);

    // A 25055 renegotiation offer is answered with a 25051 Answer (§9.4), NOT
    // another 25055. The answer routes back through the peer's _handleAnswer.
    const answerSdp = await session.applyRenegotiateOffer({ type: 'offer', sdp: evt.sdp });

    const draft = encodeAnswer({
      senderPubkeyHex: this.deps.pubkeyHex,
      recipientPubkeys: [evt.senderPubkey],
      callId: ctx.callId,
      sdp: answerSdp.sdp ?? '',
    });
    await wrapAndPublish(draft, evt.senderPubkey, this.deps.signer, this.deps.ndk).catch(
      (err) => console.warn('[callManager] renegotiate answer send failed:', err),
    );
  }

  // ── Private: roster / group resolution ─────────────────────────────────────

  /**
   * Determine which group an offer belongs to by finding the group with the
   * most overlap between the offer's p-tags and each group's roster.
   * Returns the groupId (or null) and the roster snapshot.
   */
  private async _resolveGroupAndRoster(
    evt: IncomingCallEvent,
  ): Promise<{ groupId: string | null; rosterSnapshot: Set<string> }> {
    // Bind the call to a concrete MLS group (§5.2). Among the local user's groups,
    // pick the one that (a) contains the caller and (b) has the most overlap with
    // the offer's p-tagged participants. The snapshot is that group's membership —
    // NOT the offer's self-asserted p-tags — so a caller cannot authorize
    // participants who are not actually in the shared group.
    const offerParticipants = new Set([...evt.recipientPubkeys, evt.senderPubkey]);
    const groupIds = this.deps.getGroupIds?.() ?? [];

    let bestGroupId: string | null = null;
    let bestRoster: Set<string> = new Set();
    let bestOverlap = -1;

    for (const groupId of groupIds) {
      let members: string[];
      try {
        members = await this.deps.getGroupRoster(groupId);
      } catch {
        continue;
      }
      const memberSet = new Set(members);
      // The caller must be a member of the group for it to be a candidate.
      if (!memberSet.has(evt.senderPubkey)) continue;

      let overlap = 0;
      for (const p of offerParticipants) {
        if (memberSet.has(p)) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestGroupId = groupId;
        bestRoster = memberSet;
      }
    }

    // No group contains the caller: fall back to a direct 1:1 call (spec §5.3).
    // Authorization rests solely on the caller's pubkey — the subscription's
    // outer gate (isAuthorized in IncomingCallWatcher) has already confirmed the
    // caller is a known contact, so this is not an open door. The roster is just
    // the two of us; the offer's other p-tags are never trusted off-roster.
    if (bestGroupId === null) {
      return {
        groupId: null,
        rosterSnapshot: new Set([evt.senderPubkey, this.deps.pubkeyHex]),
      };
    }

    return { groupId: bestGroupId, rosterSnapshot: bestRoster };
  }

  private _isAuthorized(senderPubkey: string): boolean {
    return this.ctx?.rosterSnapshot.has(senderPubkey) ?? false;
  }

  // ── Private: PeerSession management ────────────────────────────────────────

  private _createPeerSession(callId: string, remotePubkey: string): PeerSession {
    const ctx = this.ctx!;
    const iceConfig = getIceConfig();

    const session = new PeerSession(iceConfig, {
      onIceCandidate: (candidate) => {
        const draft = encodeIceCandidate({
          senderPubkeyHex: this.deps.pubkeyHex,
          recipientPubkeyHex: remotePubkey,
          callId,
          candidate,
        });
        wrapAndPublish(draft, remotePubkey, this.deps.signer, this.deps.ndk).catch((err) =>
          console.warn('[callManager] ICE candidate send failed:', err),
        );
      },
      onTrack: (streams) => {
        const stream = streams[0] ?? null;
        this._updateParticipantStream(remotePubkey, stream);
      },
      onConnectionStateChange: (state) => {
        if (state === 'connected') {
          // First successful peer connection cancels the caller-side ring timeout.
          if (this.ctx?.callId === callId) this._clearRingTimeout(this.ctx);
        } else if (state === 'failed') {
          void this._onConnectionFailed(ctx, remotePubkey);
        }
      },
      onIceConnectionStateChange: (_state) => {
        // Reserved for future diagnostics
      },
    });

    ctx.sessions.set(remotePubkey, session);
    // Apply any ICE candidates that arrived before this session existed.
    this._drainPendingIce(callId, remotePubkey, session);
    return session;
  }

  private async _initiateOfferTo(ctx: CallContext, remotePubkey: string): Promise<void> {
    if (!ctx.localStream) return;
    if (ctx.sessions.has(remotePubkey)) return; // leg already forming/established
    const session = this._createPeerSession(ctx.callId, remotePubkey);
    session.addLocalStream(ctx.localStream);
    const offerSdp = await session.createOffer();

    const allPeers = [...ctx.peerPubkeys].filter((pk) => pk !== this.deps.pubkeyHex);

    const draft = encodeOffer({
      senderPubkeyHex: this.deps.pubkeyHex,
      recipientPubkeys: allPeers,
      callId: ctx.callId,
      callType: ctx.callType,
      sdp: offerSdp.sdp ?? '',
    });

    await wrapAndPublish(draft, remotePubkey, this.deps.signer, this.deps.ndk).catch((err) =>
      console.warn('[callManager] offer send failed to', remotePubkey, err),
    );
  }

  // ── Private: ICE restart ────────────────────────────────────────────────────

  private async _onConnectionFailed(ctx: CallContext, remotePubkey: string): Promise<void> {
    if (!this.ctx || this.ctx.callId !== ctx.callId) return;

    const attempts = ctx.iceRestartAttempts.get(remotePubkey) ?? 0;
    if (attempts >= 1) {
      // Second failure — mark leg as failed
      console.warn('[callManager] ICE restart failed, marking leg failed for', remotePubkey);
      ctx.sessions.get(remotePubkey)?.close();
      ctx.sessions.delete(remotePubkey);
      ctx.peerPubkeys.delete(remotePubkey);
      ctx.iceRestartAttempts.delete(remotePubkey);

      if (ctx.sessions.size === 0) {
        this._teardownCall(ctx);
      } else {
        this._syncStoreParticipants(ctx);
      }
      return;
    }

    ctx.iceRestartAttempts.set(remotePubkey, attempts + 1);
    await this._doIceRestart(ctx, remotePubkey);
  }

  private async _doIceRestart(ctx: CallContext, remotePubkey: string): Promise<void> {
    const session = ctx.sessions.get(remotePubkey);
    if (!session) return;

    const offerSdp = await session.createIceRestartOffer().catch((err) => {
      console.warn('[callManager] createIceRestartOffer failed:', err);
      return null;
    });
    if (!offerSdp) return;

    // Mark an in-flight renegotiation so a colliding incoming 25055 from this
    // peer is resolved by the glare rule rather than blindly answered.
    ctx.renegotiating.add(remotePubkey);

    const draft = encodeRenegotiate({
      senderPubkeyHex: this.deps.pubkeyHex,
      recipientPubkeys: [remotePubkey],
      callId: ctx.callId,
      sdp: offerSdp.sdp ?? '',
    });

    await wrapAndPublish(draft, remotePubkey, this.deps.signer, this.deps.ndk).catch((err) =>
      console.warn('[callManager] ICE restart renegotiate send failed:', err),
    );
  }

  // ── Private: callStore sync ─────────────────────────────────────────────────

  private _updateParticipantStream(pubkey: string, stream: MediaStream | null): void {
    const snapshot = callStore.getSnapshot();
    if (!snapshot.active) return;
    const updated = snapshot.active.participants.map((p) =>
      p.pubkey === pubkey ? { ...p, stream } : p,
    );
    callStore.setActive({ ...snapshot.active, participants: updated });
  }

  private _syncStoreParticipants(ctx: CallContext): void {
    const snapshot = callStore.getSnapshot();
    if (!snapshot.active) return;

    // Retain streams of remaining participants
    const streamsByPubkey = new Map(
      snapshot.active.participants.map((p) => [p.pubkey, p.stream]),
    );

    callStore.setActive({
      ...snapshot.active,
      participants: [...ctx.peerPubkeys].map((pk) => ({
        pubkey: pk,
        stream: streamsByPubkey.get(pk) ?? null,
        muted: false,
        videoOff: false,
      })),
    });
  }

  // ── Private: teardown ───────────────────────────────────────────────────────

  private _teardownCall(ctx: CallContext): void {
    this._clearRingTimeout(ctx);
    for (const session of ctx.sessions.values()) {
      session.close();
    }
    ctx.sessions.clear();
    if (ctx.localStream) {
      releaseMedia(ctx.localStream);
      ctx.localStream = null;
    }
    this._pendingOfferSdps.delete(ctx.callId);
    this._pendingMeshOffers.delete(ctx.callId);
    this._pendingIceCandidates.delete(ctx.callId);
    if (this.ctx?.callId === ctx.callId) {
      this.ctx = null;
    }
    callStore.clearAll();
  }

  private _clearRingTimeout(ctx: CallContext): void {
    if (ctx.ringTimeoutHandle !== null) {
      clearTimeout(ctx.ringTimeoutHandle);
      ctx.ringTimeoutHandle = null;
    }
  }
}
