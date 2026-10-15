/**
 * Unit tests for countAdmissionsForActiveNonce (epic: contact-pairing-code,
 * story S5, AC-UI-2), exported from MarmotContext.tsx so the digest-count
 * math can be unit-tested without rendering MarmotProvider or touching
 * jsdom — the same exported-pure-function precedent already established for
 * fireAutoCommit (see autoCommitLeave.test.ts's mocking approach, reused
 * here verbatim: mock React + every module-scope dependency MarmotContext.tsx
 * imports so the module can be loaded in a plain node test).
 */
import { describe, it, expect, vi } from 'vitest';

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
  useCopy: vi.fn(() => ({ contacts: { pairingAdmissionDigest: (n: number) => `${n} people paired with your code` } })),
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

vi.mock('@/src/lib/marmot/profileSync', () => ({
  serialiseProfileUpdate: vi.fn(),
  PROFILE_RUMOR_KIND: 8901,
  parseProfilePayload: vi.fn(),
}));

vi.mock('@/src/lib/marmot/leaveSync', () => ({
  LEAVE_INTENT_KIND: 13,
  serialiseLeaveIntent: vi.fn(),
}));

vi.mock('@/src/lib/marmot/profileRequestSync', () => ({
  PROFILE_REQUEST_KIND: 8903,
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
}));

vi.mock('@/src/lib/marmot/chatPersistence', () => ({
  appendMessage: vi.fn(),
  loadMessages: vi.fn(),
}));

vi.mock('@/src/lib/marmot/registerHandlers', () => ({
  buildDispatcher: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
}));

vi.mock('@/src/lib/reactions/api', () => ({
  applyInboundRumor: vi.fn(),
}));

vi.mock('@/src/lib/marmot/pollPersistence', () => ({
  savePoll: vi.fn(),
  saveVoteIfNewer: vi.fn(),
  getPoll: vi.fn(),
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

const { countAdmissionsForActiveNonce, applyPairingAdmissionDigest, resolveAndApplyPairingAdmissionDigest } =
  await import('@/src/context/MarmotContext');

const NONCE_A = 'a'.repeat(32);
const NONCE_B = 'b'.repeat(32);

/** A fake `PairingDigestDispatch` that records calls and simulates Chakra's toast lifecycle (a toast is "active" once shown, until closed). */
function makeFakeDispatch() {
  const shown: Array<{ id: string; title: string }> = [];
  const updated: Array<{ id: string; title: string }> = [];
  const activeIds = new Set<string>();
  return {
    calls: { shown, updated },
    dispatch: {
      isActive: (id: string) => activeIds.has(id),
      show: vi.fn((opts: { id: string; title: string; status: 'success'; duration: number; isClosable: boolean }) => {
        shown.push({ id: opts.id, title: opts.title });
        activeIds.add(opts.id);
      }),
      update: vi.fn((id: string, opts: { title: string; status: 'success'; duration: number; isClosable: boolean }) => {
        updated.push({ id, title: opts.title });
      }),
    },
  };
}

describe('countAdmissionsForActiveNonce (AC-UI-2)', () => {
  it('returns 0 for an empty admissions map', () => {
    expect(countAdmissionsForActiveNonce(new Map(), NONCE_A)).toBe(0);
  });

  it('counts only entries whose echoed nonce matches the active nonce', () => {
    const admissions = new Map([
      ['sender1', NONCE_A],
      ['sender2', NONCE_A],
      ['sender3', NONCE_B], // a stale/rotated nonce — must not be counted
    ]);
    expect(countAdmissionsForActiveNonce(admissions, NONCE_A)).toBe(2);
    expect(countAdmissionsForActiveNonce(admissions, NONCE_B)).toBe(1);
  });

  it('a single admission for the active nonce counts as 1 (caller applies the >=2 digest threshold)', () => {
    const admissions = new Map([['sender1', NONCE_A]]);
    expect(countAdmissionsForActiveNonce(admissions, NONCE_A)).toBe(1);
  });

  it('does not count admissions for a nonce that is not currently active', () => {
    const admissions = new Map([
      ['sender1', NONCE_B],
      ['sender2', NONCE_B],
    ]);
    expect(countAdmissionsForActiveNonce(admissions, NONCE_A)).toBe(0);
  });

  it('never mutates the map it is given', () => {
    const admissions = new Map([['sender1', NONCE_A]]);
    const snapshot = new Map(admissions);
    countAdmissionsForActiveNonce(admissions, NONCE_A);
    expect(admissions).toEqual(snapshot);
  });
});

// VQ-S5-008 — admits 2 then 3 distinct senders for the active nonce and
// asserts exactly one digest notification is shown (count reflecting 3, not
// a stale 2) with no per-admission toast fired for admission 1 or 2/3 beyond
// the single show+update pair.
describe('applyPairingAdmissionDigest (AC-UI-2)', () => {
  const toastId = 'pairing-admission-digest';
  const formatTitle = (count: number) => `${count} people paired with your code`;

  it('shows no notification at all for a single admission (below the >=2 threshold)', () => {
    const { calls, dispatch } = makeFakeDispatch();
    const admissions = new Map([['sender1', NONCE_A]]);
    applyPairingAdmissionDigest(admissions, NONCE_A, toastId, formatTitle, dispatch);
    expect(calls.shown).toEqual([]);
    expect(calls.updated).toEqual([]);
  });

  it('shows exactly ONE digest notification once a 2nd distinct sender is admitted, with count=2', () => {
    const { calls, dispatch } = makeFakeDispatch();
    // Admission 1 — below threshold, no-op.
    applyPairingAdmissionDigest(new Map([['sender1', NONCE_A]]), NONCE_A, toastId, formatTitle, dispatch);
    // Admission 2 — crosses the threshold.
    applyPairingAdmissionDigest(
      new Map([['sender1', NONCE_A], ['sender2', NONCE_A]]),
      NONCE_A,
      toastId,
      formatTitle,
      dispatch,
    );
    expect(calls.shown).toEqual([{ id: toastId, title: '2 people paired with your code' }]);
    expect(calls.updated).toEqual([]);
  });

  it('updates the SAME toast (never creates a second) when a 3rd sender is admitted, with count=3 — no stacked per-admission toasts', () => {
    const { calls, dispatch } = makeFakeDispatch();
    applyPairingAdmissionDigest(new Map([['sender1', NONCE_A]]), NONCE_A, toastId, formatTitle, dispatch); // 1 — no-op
    applyPairingAdmissionDigest(
      new Map([['sender1', NONCE_A], ['sender2', NONCE_A]]),
      NONCE_A, toastId, formatTitle, dispatch,
    ); // 2 — shown
    applyPairingAdmissionDigest(
      new Map([['sender1', NONCE_A], ['sender2', NONCE_A], ['sender3', NONCE_A]]),
      NONCE_A, toastId, formatTitle, dispatch,
    ); // 3 — updated in place, not a second toast

    // Exactly one `show` call across all three admissions — never one toast per admission.
    expect(calls.shown).toHaveLength(1);
    expect(calls.updated).toEqual([{ id: toastId, title: '3 people paired with your code' }]);
  });

  it('does not fire for admissions echoing a different (non-active) nonce', () => {
    const { calls, dispatch } = makeFakeDispatch();
    const admissions = new Map([['sender1', NONCE_B], ['sender2', NONCE_B]]);
    applyPairingAdmissionDigest(admissions, NONCE_A, toastId, formatTitle, dispatch);
    expect(calls.shown).toEqual([]);
    expect(calls.updated).toEqual([]);
  });
});

// Review-remediation (epic: contact-pairing-code, story S5, sev 3
// correctness finding): the digest wiring MUST resolve the active nonce via
// a genuinely read-only peek, never a minting primitive, so that receiving
// an ack never rotates the issuer's nonce as a side effect. These tests
// exercise the extracted wiring wrapper directly with a fake `peek` that has
// no mint/persist capability at all in its type — proving the "does this
// call something with mint side effects" question is answered structurally,
// not just by convention.
describe('resolveAndApplyPairingAdmissionDigest — peek-only wiring (review-remediation, AC-UI-2)', () => {
  const toastId = 'pairing-admission-digest';
  const formatTitle = (count: number) => `${count} people paired with your code`;

  it('peek returning null (no code shared this session) → no-op: no crash, no dispatch call', () => {
    const { calls, dispatch } = makeFakeDispatch();
    const peek = vi.fn(() => null);
    const admissions = new Map([['sender1', NONCE_A], ['sender2', NONCE_A]]);

    expect(() =>
      resolveAndApplyPairingAdmissionDigest(admissions, peek, toastId, formatTitle, dispatch),
    ).not.toThrow();
    expect(peek).toHaveBeenCalledTimes(1);
    expect(calls.shown).toEqual([]);
    expect(calls.updated).toEqual([]);
  });

  it('peek returning a stale-but-real active nonce (past its own expiry) is still used as-is — the wiring never substitutes a freshly-minted one', () => {
    const { calls, dispatch } = makeFakeDispatch();
    // A fake that always returns the SAME nonce value regardless of how much
    // "time" has passed — simulating peekActiveNonce's real contract: it
    // never re-derives or rotates based on expiry, unlike getOrMintActiveNonce.
    const peek = vi.fn(() => ({ nonce: NONCE_A }));
    const admissions = new Map([['sender1', NONCE_A], ['sender2', NONCE_A]]);

    resolveAndApplyPairingAdmissionDigest(admissions, peek, toastId, formatTitle, dispatch);

    expect(calls.shown).toEqual([{ id: toastId, title: '2 people paired with your code' }]);
  });

  it('receiving an ack for a nonce that does not match peek() never rotates anything — peek is called but its return value alone determines the count, with no mutation path available to this function', () => {
    const { calls, dispatch } = makeFakeDispatch();
    const peek = vi.fn(() => ({ nonce: NONCE_A }));
    // Admissions reference NONCE_B only — e.g. a stale/rotated nonce from a
    // prior session's admissions map that outlived a reload.
    const admissions = new Map([['sender1', NONCE_B], ['sender2', NONCE_B]]);

    resolveAndApplyPairingAdmissionDigest(admissions, peek, toastId, formatTitle, dispatch);

    // peek() was consulted exactly once and its value (NONCE_A) is what was
    // counted against — zero matches, so no notification, and critically no
    // second call to peek (which would suggest a retry-after-mint pattern).
    expect(peek).toHaveBeenCalledTimes(1);
    expect(calls.shown).toEqual([]);
    expect(calls.updated).toEqual([]);
  });

  it('the peek function signature offers no way to mint: calling it never receives arguments (a real mint primitive would need a nowSec parameter)', () => {
    const peek = vi.fn(() => null);
    resolveAndApplyPairingAdmissionDigest(new Map(), peek, toastId, formatTitle, makeFakeDispatch().dispatch);
    expect(peek).toHaveBeenCalledWith();
  });
});
