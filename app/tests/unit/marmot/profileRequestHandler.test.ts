/**
 * Unit tests for handlers/profileRequestHandler.ts
 *
 * Covers AC-AR-14, AC-AR-20.
 *
 * Design: tests call createProfileRequestHandler with vi.fn() spies injected
 * as deps, then call handler.handle() directly. Duplicate-id test uses the
 * dispatcher LRU layer.
 *
 * AC-SEND-10 (epic: group-message-author-auth-app-layer, S8) — the
 * "handler-unit (background/relay path)" describe block below tests the
 * REAL implementation MarmotContext.tsx wires as `deps.sendSelfProfile`
 * (`signAndSendProfileBackground`, exported from MarmotContext.tsx),
 * imported directly per the fireAutoCommit/applyPairingAdmissionDigest
 * exported-pure-function precedent (see autoCommitLeave.test.ts /
 * admissionDigest.test.ts). Importing MarmotContext.tsx in a jsdom-free
 * vitest run requires mocking React + every module-scope dependency it
 * imports — that boilerplate is reused verbatim from those two files, MINUS
 * the `@/src/lib/marmot/profileRequestSync` mock: this file's OWN
 * pre-existing tests need the REAL `parseProfileRequestPayload` /
 * `PROFILE_REQUEST_KIND` (mocking that module would silently break them —
 * `parseProfileRequestPayload` has no fake replacement in the other files'
 * boilerplate). profileRequestSync.ts is documented as having ZERO side
 * effects, so importing it for real here is safe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── idb-keyval mock (Map-backed) ───────────────────────────────────────────
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => { idbStore.set(key, value); }),
  del: vi.fn(async (key: string) => { idbStore.delete(key); }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  delMany: vi.fn(async (ks: string[]) => { ks.forEach((k) => idbStore.delete(k)); }),
}));

// ─── @internet-privacy/marmot-ts mock ────────────────────────────────────────
let mockRumor: ReturnType<typeof makeProfileRequestRumor> | null = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── MarmotContext.tsx module-load boilerplate (AC-SEND-10 handler-unit block) ──
// Mirrors autoCommitLeave.test.ts / admissionDigest.test.ts verbatim, minus the
// profileRequestSync mock (see file header comment for why).
vi.mock('react', () => ({
  createContext: vi.fn(() => ({})),
  useCallback: vi.fn((fn: unknown) => fn),
  useContext: vi.fn(),
  useEffect: vi.fn(),
  useMemo: vi.fn((fn: unknown) => (fn as () => unknown)()),
  useRef: vi.fn((initial: unknown) => ({ current: initial })),
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
}));

vi.mock('@chakra-ui/react', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('@/src/context/LanguageContext', () => ({
  useCopy: vi.fn(() => ({ groups: { profileSendFailed: 'PROFILE_SEND_FAILED_COPY' } })),
}));

vi.mock('@/src/lib/marmot/groupStorage', () => ({
  loadAllGroups: vi.fn().mockResolvedValue([]),
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  loadMemberProfiles: vi.fn().mockResolvedValue([]),
  mergeMemberProfile: vi.fn(),
  clearMemberProfiles: vi.fn(),
  IdbGroupStateBackend: vi.fn(),
  IdbKeyPackageBackend: vi.fn(),
  clearAllGroupData: vi.fn(),
}));

vi.mock('@/src/lib/marmot/welcomeSubscription', () => ({
  subscribeToWelcomes: vi.fn(),
}));

// Controllable per-test: the whole point of this describe block is exercising
// signAndSendProfileBackground / signProfileForInteractiveSend's handling of
// serialiseProfileUpdate throwing (locked/absent signer) vs resolving.
const serialiseProfileUpdateMock = vi.fn();
vi.mock('@/src/lib/marmot/profileSync', () => ({
  serialiseProfileUpdate: (...args: unknown[]) => serialiseProfileUpdateMock(...args),
  PROFILE_RUMOR_KIND: 0,
  parseProfilePayload: vi.fn(),
}));

vi.mock('@/src/lib/marmot/leaveSync', () => ({
  LEAVE_INTENT_KIND: 13,
  serialiseLeaveIntent: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileRequestStorage', () => ({
  recordRequestEmitted: vi.fn(),
  recordRequestAnswered: vi.fn(),
  loadProfileRequestMemo: vi.fn(),
  clearProfileRequestMemos: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileRequestRunner', () => ({
  handleIncomingProfileRequest: vi.fn(),
  notifyProfileObserved: vi.fn(),
  sweepStaleProfiles: vi.fn(),
}));

vi.mock('@/src/lib/unreadStore', () => ({
  incrementUnread: vi.fn(),
  initUnreadCounts: vi.fn(),
  initJoinRequestCounts: vi.fn(),
  clearUnreadGroup: vi.fn(),
  incrementJoinRequest: vi.fn(),
  decrementJoinRequest: vi.fn(),
  purgeStrangerDmCounters: vi.fn(),
  clearInviteExpiries: vi.fn(),
  markAsRead: vi.fn(),
}));

vi.mock('@/src/lib/marmot/chatPersistence', () => ({
  appendMessage: vi.fn(),
  loadMessages: vi.fn(),
  purgeStrangerDmThreads: vi.fn(),
  CHAT_MESSAGE_KIND: 9,
}));

vi.mock('@/src/lib/contacts', () => ({
  purgeStrangerContacts: vi.fn(),
}));

vi.mock('@/src/lib/knownPeers', () => ({
  loadKnownPeers: vi.fn().mockResolvedValue([]),
  rememberKnownPeers: vi.fn(),
  knownPeersMigrationComplete: vi.fn().mockResolvedValue(true),
  markKnownPeersMigrationComplete: vi.fn(),
}));

vi.mock('@/src/lib/marmot/registerHandlers', () => ({
  buildDispatcher: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
}));

vi.mock('@/src/lib/marmot/pendingDirectInviteStorage', () => ({
  clearPendingDirectInvite: vi.fn(),
}));

vi.mock('@/src/lib/reactions/api', () => ({
  applyInboundRumor: vi.fn(),
  purgeStrangerDmReactions: vi.fn(),
}));

vi.mock('@/src/lib/messageEdits/api', () => ({
  applyDeleteEditSignal: vi.fn(),
  resolvePendingSignalsForSlot: vi.fn(),
  registerGroupAdminsProvider: vi.fn(),
  isRegisteredGroupAdmin: vi.fn(),
}));

vi.mock('@/src/lib/marmot/pollPersistence', () => ({
  savePoll: vi.fn(),
  saveVoteIfNewer: vi.fn(),
  getPoll: vi.fn(),
  loadVotes: vi.fn(),
  clearPollData: vi.fn(),
}));

vi.mock('@/src/lib/marmot/mediaPersistence', () => ({
  clearGroupMedia: vi.fn(),
}));

vi.mock('@/src/context/NostrIdentityContext', () => ({
  useNostrIdentity: vi.fn(() => ({ privateKeyHex: null, pubkeyHex: null, hydrated: false })),
}));

vi.mock('@/src/context/ProfileContext', () => ({
  useProfile: vi.fn(() => ({ profile: { nickname: '', avatar: null } })),
}));

vi.mock('@/src/context/BackupContext', () => ({
  useBackup: vi.fn(() => ({ markDirty: vi.fn() })),
}));

vi.mock('applesauce-core/helpers/event', () => ({
  getEventHash: vi.fn(() => 'fakehash'),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createProfileRequestHandler } = await import('@/src/lib/marmot/handlers/profileRequestHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { PROFILE_REQUEST_KIND } = await import('@/src/lib/marmot/profileRequestSync');
const { signAndSendProfileBackground, signProfileForInteractiveSend, resolvePublishProfileUpdateShortCircuit } = await import('@/src/context/MarmotContext');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PEER_PUBKEY = 'bb'.repeat(32);
const SELF_PUBKEY = 'aa'.repeat(32);
const THIRD_PUBKEY = 'cc'.repeat(32);
const GROUP_ID = 'group-request-test';

function makeProfileRequestRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({
    type: 'profile_request',
    targetPubkey: THIRD_PUBKEY,
    nonce: 'abc123',
  });
  return {
    id: 'req-rumor-' + 'ee'.repeat(28),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: PROFILE_REQUEST_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx(selfPubkeyHex = SELF_PUBKEY) {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
// Unused in profileRequestHandler's body this story — only needed to satisfy
// the widened 3-arg handle() signature.
function makeSender(pubkey: string = PEER_PUBKEY): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

const OTHER_FOR_RELAY = '9f'.repeat(32);

function makeDeps() {
  return {
    recordRequestEmitted: vi.fn(async () => {}),
    sendSelfProfile: vi.fn(async () => {}),
    handleIncomingProfileRequest: vi.fn(async () => {}),
  };
}

// S3 (marmot-ts 0.7.0 authenticated-sender migration): the dispatcher now
// registers TWO listeners — 'authenticatedApplicationMessage' (message-
// carrying) and 'unauthenticatedMessage' (diagnostic-only, AC-OBS-1). A
// single shared `listener` variable would be silently overwritten by the
// second .on() call; listeners are tracked per event name instead. emit()
// passes the payload shape the dispatcher now expects
// ({message, senderPubkey, senderLeafIndex}), with senderPubkey sourced from
// the currently-configured mockRumor so the dispatcher's sender-vs-rumor
// choke-point trivially matches (mirroring the old fallback sender).
function makeFakeGroup() {
  const listeners = new Map<string, (payload: never) => void | Promise<void>>();
  return {
    on: vi.fn((event: string, fn: (payload: never) => void | Promise<void>) => { listeners.set(event, fn); }),
    off: vi.fn((event: string, _fn: (payload: never) => void | Promise<void>) => { listeners.delete(event); }),
    async emit() {
      const fn = listeners.get('authenticatedApplicationMessage');
      if (fn) await fn({ message: new Uint8Array(), senderPubkey: mockRumor?.pubkey ?? '', senderLeafIndex: 0 } as never);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  idbStore.clear();
  vi.clearAllMocks();
  mockRumor = null;
});

describe('profileRequestHandler', () => {
  it('peer-request path: handleIncomingProfileRequest called, sendSelfProfile NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // targetPubkey is THIRD_PUBKEY (not self)
    const rumor = makeProfileRequestRumor();
    const ctx = makeCtx(SELF_PUBKEY); // self is SELF_PUBKEY, target is THIRD_PUBKEY

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.recordRequestEmitted.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.recordRequestEmitted.mock.calls[0][1]).toBe(THIRD_PUBKEY);

    expect(deps.handleIncomingProfileRequest).toHaveBeenCalledOnce();
    const { groupId, payload } = deps.handleIncomingProfileRequest.mock.calls[0][0];
    expect(groupId).toBe(GROUP_ID);
    expect(payload.targetPubkey).toBe(THIRD_PUBKEY);
    expect(payload.type).toBe('profile_request');

    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
  });

  it('self-target reply path: sendSelfProfile called, handleIncomingProfileRequest NOT called', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    // Request targets SELF_PUBKEY
    const content = JSON.stringify({
      type: 'profile_request',
      targetPubkey: SELF_PUBKEY,
      nonce: 'xyz789',
    });
    const rumor = makeProfileRequestRumor({ content });
    const ctx = makeCtx(SELF_PUBKEY);

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile).toHaveBeenCalledOnce();
    expect(deps.sendSelfProfile.mock.calls[0][0]).toBe(GROUP_ID);
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

  it('a failed self-profile reply is warned and swallowed (not a durable failure: the requester re-asks), so the rumor is acked rather than replayed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    deps.sendSelfProfile.mockRejectedValueOnce(new Error('no relay acked'));
    const handler = createProfileRequestHandler(deps);
    const content = JSON.stringify({ type: 'profile_request', targetPubkey: SELF_PUBKEY, nonce: 'n1' });
    const rumor = makeProfileRequestRumor({ content });
    await expect(handler.handle(rumor, makeCtx(SELF_PUBKEY), makeSender(rumor.pubkey))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answering the request failed'), expect.any(Error));
    warn.mockRestore();
  });

  it.each([
    ['recordRequestEmitted', SELF_PUBKEY],
    ['recordRequestEmitted', OTHER_FOR_RELAY],
    ['handleIncomingProfileRequest', OTHER_FOR_RELAY],
  ] as const)('a failing %s is warned and swallowed (target %s): the requester retries, so the rumor is never kept for replay', async (step, target) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    deps[step].mockRejectedValueOnce(new Error('idb'));
    const handler = createProfileRequestHandler(deps);
    const rumor = makeProfileRequestRumor({ content: JSON.stringify({ type: 'profile_request', targetPubkey: target, nonce: 'n2' }) });
    await expect(handler.handle(rumor, makeCtx(SELF_PUBKEY), makeSender(rumor.pubkey))).resolves.toBeUndefined();
    // A failed record never skips the answer.
    if (step === 'recordRequestEmitted') {
      expect(target === SELF_PUBKEY ? deps.sendSelfProfile : deps.handleIncomingProfileRequest).toHaveBeenCalledOnce();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dispatcher.profileRequest]'), expect.any(Error));
    warn.mockRestore();
  });

  it('malformed payload: returns before any step (nothing recorded, nothing warned)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    const rumor = makeProfileRequestRumor({ content: '{ not valid request }' });
    await createProfileRequestHandler(deps).handle(rumor, makeCtx(), makeSender(rumor.pubkey));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('malformed payload: does not throw, no side effects fired', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    const rumor = makeProfileRequestRumor({ content: '{ not valid request }' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.recordRequestEmitted).not.toHaveBeenCalled();
    expect(deps.sendSelfProfile).not.toHaveBeenCalled();
    expect(deps.handleIncomingProfileRequest).not.toHaveBeenCalled();
  });

  it('duplicate-id: dispatcher LRU prevents second recordRequestEmitted call', async () => {
    const deps = makeDeps();
    const handler = createProfileRequestHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makeProfileRequestRumor({ id: 'dup-req-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    // LRU dedup: second emission of same id is skipped
    expect(deps.recordRequestEmitted).toHaveBeenCalledOnce();
  });
});

// ─── AC-SEND-10: meta-event send fails closed ──────────────────────────────
//
// spec.md Solution §9 / acceptance-criteria.md AC-SEND-10: if a forwardable
// inner signature cannot be produced (locked/absent NIP-07 signer), the
// meta-event is not emitted and not actioned locally. Surfacing is per path:
// interactive (visible i18n error, integrated-e2e — see
// app/tests/e2e/groups-profile-send-fails-closed.spec.ts) vs background/relay
// (dev-log only, relies on the EXISTING profile-request retry machinery —
// tested here, handler-unit).

describe('AC-SEND-10: background/relay send fails closed (signAndSendProfileBackground)', () => {
  const FAKE_PROFILE = { nickname: 'Alice', avatar: null } as any;

  it('locked/absent signer (null): sendRumor is NEVER called, failure is dev-logged, returns { sent: false }', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendRumor = vi.fn(async () => {});

    const result = await signAndSendProfileBackground({
      signer: null,
      profile: FAKE_PROFILE,
      sendRumor,
      logLabel: 'test-site',
    });

    expect(result).toEqual({ sent: false });
    // No meta-event emitted: the relay-publish call is never even attempted.
    expect(sendRumor).not.toHaveBeenCalled();
    expect(serialiseProfileUpdateMock).not.toHaveBeenCalled();
    // Dev-log only — this is the background/relay surfacing path.
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('test-site');
    warnSpy.mockRestore();
  });

  it('signer present but signing throws (e.g. locked NIP-07 rejects): sendRumor is NEVER called, dev-logged, returns { sent: false }', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendRumor = vi.fn(async () => {});
    serialiseProfileUpdateMock.mockRejectedValueOnce(new Error('signer locked'));

    const result = await signAndSendProfileBackground({
      signer: { signEvent: vi.fn() } as any,
      profile: FAKE_PROFILE,
      sendRumor,
      logLabel: 'test-site-2',
    });

    expect(result).toEqual({ sent: false });
    // Absence of the meta-event: no relay-publish call recorded.
    expect(sendRumor).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('test-site-2');
    warnSpy.mockRestore();
  });

  it('signing succeeds: sendRumor is called exactly once with the signed payload, returns { sent: true }', async () => {
    const sendRumor = vi.fn(async () => {});
    serialiseProfileUpdateMock.mockResolvedValueOnce('{"id":"signed-envelope"}');

    const result = await signAndSendProfileBackground({
      signer: { signEvent: vi.fn() } as any,
      profile: FAKE_PROFILE,
      sendRumor,
      logLabel: 'test-site-3',
    });

    expect(result).toEqual({ sent: true });
    expect(sendRumor).toHaveBeenCalledOnce();
    expect(sendRumor).toHaveBeenCalledWith('{"id":"signed-envelope"}');
  });

  it('wired as the REAL deps.sendSelfProfile (AC-030 self-reply): a locked signer means the incoming profile_request produces no outbound send, only a dev-log', async () => {
    // This verifies the handler→helper COMPOSITION SHAPE: a deps.sendSelfProfile
    // that funnels through signAndSendProfileBackground behaves correctly end
    // to end through createProfileRequestHandler. It does NOT verify that
    // MarmotContext.tsx's REAL sendSelfProfile is actually wired that way —
    // this test's deps.sendSelfProfile is a test-authored closure, not an
    // import of the production wiring. That production-wiring guarantee
    // (VQ-S8-002 — one centralized fail-closed implementation, not duplicated
    // ad hoc per call site) is covered separately by the source-scan test
    // below ("MarmotContext.tsx wiring (VQ-S8-002)").
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendRumor = vi.fn(async () => {});

    const deps = makeDeps();
    deps.sendSelfProfile = vi.fn(async (groupId: string) => {
      await signAndSendProfileBackground({
        signer: null, // locked/absent signer
        profile: FAKE_PROFILE,
        sendRumor,
        logLabel: `sendSelfProfile (${groupId})`,
      });
    });
    const handler = createProfileRequestHandler(deps);

    const content = JSON.stringify({ type: 'profile_request', targetPubkey: SELF_PUBKEY, nonce: 'n1' });
    const rumor = makeProfileRequestRumor({ content });
    const ctx = makeCtx(SELF_PUBKEY);

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.sendSelfProfile).toHaveBeenCalledOnce();
    // Absence of the meta-event, end to end through the handler.
    expect(sendRumor).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── MarmotContext.tsx wiring (VQ-S8-002 / Fable-S8-2) ──────────────────────
//
// The "wired as the REAL deps.sendSelfProfile" test above only proves that
// A closure shaped like MarmotContext's sendSelfProfile composes correctly
// with createProfileRequestHandler — its deps.sendSelfProfile is a
// test-authored closure, not an import of the production wiring, so it
// cannot detect a de-centralization regression (e.g. MarmotContext's real
// sendSelfProfile silently stops funneling through
// signAndSendProfileBackground and re-implements signing/sending inline).
// The strongest proof that the production wiring genuinely funnels through
// the centralized helper is structural: read the real source and assert the
// `sendSelfProfile` field's body references `signAndSendProfileBackground`.
// Mirrors profileHandler.test.ts's roster-exemption source-scan precedent
// (real file contents, not mocked deps — a mocked-deps test can pass even
// when the real wiring silently drifts) and zodBoundary.test.ts's
// readFileSync-based scan.
describe('MarmotContext.tsx wiring (VQ-S8-002): sendSelfProfile funnels through signAndSendProfileBackground', () => {
  it('sendSelfProfile field body references signAndSendProfileBackground', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const filePath = path.resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../src/context/MarmotContext.tsx',
    );
    const source = readFileSync(filePath, 'utf8');

    const startMarker = 'sendSelfProfile: async';
    const startIdx = source.indexOf(startMarker);
    expect(startIdx, 'MarmotContext.tsx must define a sendSelfProfile field').toBeGreaterThanOrEqual(0);

    // Bound the scan to the sendSelfProfile field body — the next sibling
    // dep-object field (handleIncomingProfileRequest) marks its end — so a
    // signAndSendProfileBackground reference elsewhere in the file (e.g.
    // onHistorySynced's or createGroup's own call sites) can't produce a
    // false pass.
    const endMarker = 'handleIncomingProfileRequest:';
    const endIdx = source.indexOf(endMarker, startIdx);
    expect(endIdx, 'MarmotContext.tsx must define handleIncomingProfileRequest after sendSelfProfile').toBeGreaterThan(startIdx);

    const sendSelfProfileBody = source.slice(startIdx, endIdx);
    expect(
      sendSelfProfileBody.includes('signAndSendProfileBackground'),
      'MarmotContext.tsx sendSelfProfile must funnel through signAndSendProfileBackground (VQ-S8-002 centralized fail-closed helper), not re-implement signing/sending inline',
    ).toBe(true);
  });
});

describe('AC-SEND-10: interactive send fails closed (signProfileForInteractiveSend)', () => {
  const FAKE_PROFILE = { nickname: 'Alice', avatar: null } as any;

  it('locked/absent signer (null): onSignFailed is called with the i18n error message, returns null', async () => {
    const onSignFailed = vi.fn();

    const result = await signProfileForInteractiveSend(FAKE_PROFILE, null, 'PROFILE_SEND_FAILED_COPY', onSignFailed);

    expect(result).toBeNull();
    expect(onSignFailed).toHaveBeenCalledOnce();
    expect(onSignFailed).toHaveBeenCalledWith('PROFILE_SEND_FAILED_COPY');
    expect(serialiseProfileUpdateMock).not.toHaveBeenCalled();
  });

  it('signer present but signing throws: onSignFailed is called (visible error), failure is also dev-logged, returns null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSignFailed = vi.fn();
    serialiseProfileUpdateMock.mockRejectedValueOnce(new Error('signer locked'));

    const result = await signProfileForInteractiveSend(
      FAKE_PROFILE,
      { signEvent: vi.fn() } as any,
      'PROFILE_SEND_FAILED_COPY',
      onSignFailed,
    );

    expect(result).toBeNull();
    expect(onSignFailed).toHaveBeenCalledOnce();
    expect(onSignFailed).toHaveBeenCalledWith('PROFILE_SEND_FAILED_COPY');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('signing succeeds: returns the signed payload, onSignFailed is NEVER called', async () => {
    const onSignFailed = vi.fn();
    serialiseProfileUpdateMock.mockResolvedValueOnce('{"id":"signed-envelope"}');

    const result = await signProfileForInteractiveSend(
      FAKE_PROFILE,
      { signEvent: vi.fn() } as any,
      'PROFILE_SEND_FAILED_COPY',
      onSignFailed,
    );

    expect(result).toBe('{"id":"signed-envelope"}');
    expect(onSignFailed).not.toHaveBeenCalled();
  });
});

describe('S8R-1: publishProfileUpdate short-circuit distinguishes VACUOUS (0 groups, ready) from NOT-READY', () => {
  // Regression coverage for the S8 retry-suppression remediation-delta review
  // (S8R-1): `publishProfileUpdate` used to collapse `!client || groups.length
  // === 0 || !pubkeyHex` into a single guard that always resolved `false`.
  // That lumped "no groups to send to" (not a failure — dedup should
  // proceed) in with genuine not-ready states (client/identity not yet
  // available — the send genuinely didn't happen). A user with 0 groups but
  // >=1 contact could then never advance `broadcastProfile`'s
  // `lastBroadcastNickname` marker, so every focus+blur with unchanged text
  // re-fired a redundant gift-wrap fan-out to all contacts.

  it('VACUOUS: client ready, pubkeyHex present, zero groups — short-circuits to CONFIRMED (true), not a failure', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: true,
      pubkeyHex: 'abc123',
      groupCount: 0,
    });
    expect(decision).toEqual({ shortCircuit: true, result: true });
  });

  it('NOT-READY: client not yet initialized — short-circuits to NOT confirmed (false), even with zero groups', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: false,
      pubkeyHex: 'abc123',
      groupCount: 0,
    });
    expect(decision).toEqual({ shortCircuit: true, result: false });
  });

  it('NOT-READY: pubkeyHex not yet available — short-circuits to NOT confirmed (false)', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: true,
      pubkeyHex: null,
      groupCount: 0,
    });
    expect(decision).toEqual({ shortCircuit: true, result: false });
  });

  it('NOT-READY takes precedence over VACUOUS when both client and pubkeyHex are unavailable', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: false,
      pubkeyHex: null,
      groupCount: 0,
    });
    expect(decision).toEqual({ shortCircuit: true, result: false });
  });

  it('READY with >=1 group: does NOT short-circuit — caller proceeds to sign+send', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: true,
      pubkeyHex: 'abc123',
      groupCount: 1,
    });
    expect(decision).toEqual({ shortCircuit: false });
  });

  // `pages/profile.tsx` cannot be imported from this file: it pulls in
  // nonceStore.ts's `createStore('few-pairing-nonces', ...)` at module scope,
  // which collides with THIS file's own `idb-keyval` mock (defined above for
  // the profileRequestHandler/MarmotContext boilerplate, lacking `createStore`
  // by design — see profile-broadcast-marker.test.ts, which owns the full,
  // separately-mocked import of pages/profile). `nextBroadcastMarkerMirror`
  // is a literal one-line copy of `nextBroadcastMarker`'s ternary body (see
  // pages/profile.tsx) — the same "reproduced locally, not re-implemented"
  // pattern profile-broadcast-marker.test.ts already uses for
  // `shouldReAttemptBroadcast` — so the composition below can be exercised
  // end to end without a cross-boilerplate import collision. The full
  // real `nextBroadcastMarker` (true/false -> advances/holds) is already
  // covered directly in profile-broadcast-marker.test.ts.
  function nextBroadcastMarkerMirror(previousMarker: string | null, attemptedNickname: string, sendConfirmed: boolean): string | null {
    return sendConfirmed ? attemptedNickname : previousMarker;
  }

  it('end-to-end: the VACUOUS short-circuit result feeds the marker decision and DOES advance the marker', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: true,
      pubkeyHex: 'abc123',
      groupCount: 0,
    });
    expect(decision.shortCircuit).toBe(true);
    const sendConfirmed = decision.shortCircuit ? decision.result : false;
    const marker = nextBroadcastMarkerMirror('Alice', 'Alice Renamed', sendConfirmed);
    expect(marker).toBe('Alice Renamed');
  });

  it('end-to-end: the NOT-READY short-circuit result feeds the marker decision and does NOT advance the marker', () => {
    const decision = resolvePublishProfileUpdateShortCircuit({
      clientReady: false,
      pubkeyHex: null,
      groupCount: 0,
    });
    expect(decision.shortCircuit).toBe(true);
    const sendConfirmed = decision.shortCircuit ? decision.result : false;
    const marker = nextBroadcastMarkerMirror('Alice', 'Alice Renamed', sendConfirmed);
    expect(marker).toBe('Alice');
  });
});
