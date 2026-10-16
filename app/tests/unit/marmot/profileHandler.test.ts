/**
 * Unit tests for handlers/profileHandler.ts
 *
 * Covers AC-AR-14, AC-AR-20.
 *
 * Design: tests call createProfileHandler with vi.fn() spies injected as deps,
 * then call handler.handle() directly. Duplicate-id test uses the dispatcher
 * LRU layer.
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
  // AC-XCUT-5: groupStorage.ts calls createStore(...) at module scope (for
  // memberProfileStore) — needed once that module is imported for real
  // below. get/set above already ignore their second "store" arg and key
  // purely by the string key, so a stub object is a drop-in addition.
  createStore: vi.fn(() => ({})),
}));

// ─── nostr-tools/pure mock ───────────────────────────────────────────────────
vi.mock('nostr-tools/pure', () => ({
  verifyEvent: vi.fn((_event: unknown) => true),
}));

// ─── @internet-privacy/marmot-ts mock ────────────────────────────────────────
let mockRumor: ReturnType<typeof makeProfileRumor> | null = null;
vi.mock('@internet-privacy/marmot-ts', () => ({
  deserializeApplicationData: vi.fn((_data: Uint8Array) => mockRumor),
}));

// ─── Dynamic imports (after vi.mock) ─────────────────────────────────────────
const { createProfileHandler } = await import('@/src/lib/marmot/handlers/profileHandler');
const { createDispatcher } = await import('@/src/lib/marmot/applicationRumorDispatcher');
const { PROFILE_RUMOR_KIND } = await import('@/src/lib/marmot/profileSync');
// AC-XCUT-5: the REAL producer, wired into deps.mergeMemberProfile for the
// merge-order property test below — not mocked, since the property under
// test IS the real last-writer-wins merge behavior.
const { mergeMemberProfile: realMergeMemberProfile, loadMemberProfiles } = await import('@/src/lib/marmot/groupStorage');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PEER_PUBKEY = 'bb'.repeat(32);
const SELF_PUBKEY = 'aa'.repeat(32);
const AUTHOR_PUBKEY = 'cc'.repeat(32); // distinct from PEER_PUBKEY — used for relay-on-behalf tests
const GROUP_ID = 'group-profile-test';

/**
 * Build a profile rumor whose content carries an embedded SignedProfileEvent
 * signed by `authorPubkey` (which may differ from `rumorSenderPubkey`).
 * This is the relay-on-behalf wire shape: relayer sends under their own pubkey,
 * but the inner event is signed by the original author.
 * verifyEvent is mocked to return true so no real key material is needed.
 */
// Monotonic counter backing makeSignedProfileRumor's default inner-event id
// (epic: group-message-author-auth-app-layer S7). Each call gets a UNIQUE
// inner signedEvent.id by default — mirroring reality, where two distinct
// signed publishes (even by the same author) have distinct ids — so tests
// that call handle() more than once with fresh rumors don't accidentally
// collide on profileHandler.ts's new one-shot consumption gate (which is
// keyed on signedEvent.id, not the outer rumor id). Tests that DELIBERATELY
// want to exercise the one-shot gate (a genuine redelivery / relayed copy of
// the SAME signed content) pass an explicit `innerEventId` override so both
// calls share one id.
let profileEventIdCounter = 0;

function makeSignedProfileRumor({
  rumorSenderPubkey = PEER_PUBKEY,
  authorPubkey = AUTHOR_PUBKEY,
  updatedAt = new Date().toISOString(),
  innerEventId,
}: {
  rumorSenderPubkey?: string;
  authorPubkey?: string;
  updatedAt?: string;
  innerEventId?: string;
} = {}) {
  const signedEvent = {
    id: innerEventId ?? `event-id-${authorPubkey.slice(0, 8)}-${++profileEventIdCounter}`,
    pubkey: authorPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 0 as const,
    tags: [] as string[][],
    content: JSON.stringify({ nickname: 'Bob', avatar: null, updatedAt }),
    sig: 'fake-sig-' + authorPubkey.slice(0, 8),
  };
  return {
    id: 'relay-rumor-' + rumorSenderPubkey.slice(0, 8),
    pubkey: rumorSenderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 0 as const,
    content: JSON.stringify(signedEvent),
    tags: [] as string[][],
  };
}

/** Build a legacy flat-profile rumor (no SignedProfileEvent envelope). */
function makeProfileRumor(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}> = {}) {
  const validContent = JSON.stringify({
    nickname: 'Alice',
    avatar: null,
    updatedAt: new Date().toISOString(),
  });
  return {
    id: 'profile-rumor-' + 'dd'.repeat(25),
    pubkey: PEER_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: PROFILE_RUMOR_KIND,
    content: validContent,
    tags: [] as string[][],
    ...overrides,
  };
}

function makeCtx() {
  return {
    groupId: GROUP_ID,
    selfPubkeyHex: SELF_PUBKEY,
    getActiveGroupId: () => GROUP_ID,
  };
}

// AuthenticatedSender fixture (epic: group-message-author-auth-app-layer S2).
function makeSender(pubkey: string): { pubkey: string; authenticity: 'claimed' | 'mls' } {
  return { pubkey, authenticity: 'claimed' };
}

function makeDeps(mergeResult = true) {
  return {
    mergeMemberProfile: vi.fn(async () => mergeResult),
    clearPendingDirectInvite: vi.fn(async () => {}),
    notifyProfileObserved: vi.fn(),
    recordRequestAnswered: vi.fn(async () => {}),
    writeContactEntry: vi.fn(),
    setProfileVersion: vi.fn(),
    // epic: group-invite-lifecycle S3 gate-remediation — default to "no
    // pending marker", so every pre-existing test above (none of which
    // concern the accept-producer) sees no accepted-post side effect.
    consumePendingDirectInviteMarker: vi.fn(async () => false),
    sendAnnouncement: vi.fn(async () => {}),
  };
}

/**
 * Marker-aware deps for the accept-producer (S3) test group below: a real
 * Map-backed pending-marker store shared between consumePendingDirectInviteMarker
 * (the atomic own-join get+clear) and clearPendingDirectInvite (the
 * pre-existing relay-on-behalf clear), so the at-most-once guarantee
 * (AC-PROD-5) is exercised through actual state transitions the SUT drives
 * itself — not a mock whose boolean return is hardcoded per call.
 *
 * consumePendingDirectInviteMarker mirrors the real storage module's
 * compare-and-clear contract: reading and deleting the SAME Map entry inside
 * one synchronous (no-`await`-in-between) step, so two concurrently-invoked
 * calls for the same key can never both observe `true` — exactly the
 * TOCTOU-safety property the real IDB-backed implementation provides via its
 * per-key promise chain (pendingDirectInviteStorage.ts).
 */
function makeMarkerAwareDeps(mergeResult = true) {
  const pendingMarkers = new Map<string, boolean>();
  const key = (groupId: string, pubkey: string) => `${groupId}:${pubkey}`;
  return {
    ...makeDeps(mergeResult),
    pendingMarkers,
    consumePendingDirectInviteMarker: vi.fn(async (groupId: string, pubkey: string) => {
      const k = key(groupId, pubkey);
      const existed = pendingMarkers.get(k) ?? false;
      if (existed) {
        pendingMarkers.delete(k);
      }
      return existed;
    }),
    clearPendingDirectInvite: vi.fn(async (groupId: string, pubkey: string) => {
      pendingMarkers.delete(key(groupId, pubkey));
    }),
    sendAnnouncement: vi.fn(async () => {}),
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

describe('profileHandler', () => {
  it('happy-path (merged=true): all side effects fire', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    const rumor = makeProfileRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    expect(deps.setProfileVersion).toHaveBeenCalledOnce();
    // merged=true → recordRequestAnswered fires
    expect(deps.recordRequestAnswered).toHaveBeenCalledOnce();
    expect(deps.recordRequestAnswered.mock.calls[0][0]).toBe(GROUP_ID);
    // writeContactEntry fires
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
    const [pubkey, entry] = deps.writeContactEntry.mock.calls[0];
    expect(pubkey).toBe(PEER_PUBKEY);
    expect(entry.nickname).toBe('Alice');
  });

  it('failure injection: a failing recordRequestAnswered is best-effort — warned, the rest still runs, the handler resolves (no replay)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps(true);
    deps.recordRequestAnswered.mockRejectedValueOnce(new Error('idb'));
    const handler = createProfileHandler(deps);
    const rumor = makeProfileRumor();
    await expect(handler.handle(rumor, makeCtx(), makeSender(rumor.pubkey))).resolves.toBeUndefined();
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recordRequestAnswered failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('not-newer (merged=false): setProfileVersion still called, recordRequestAnswered NOT called', async () => {
    const deps = makeDeps(false);
    const handler = createProfileHandler(deps);
    const rumor = makeProfileRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    // setProfileVersion always bumps
    expect(deps.setProfileVersion).toHaveBeenCalledOnce();
    // recordRequestAnswered only when merged
    expect(deps.recordRequestAnswered).not.toHaveBeenCalled();
  });

  it('malformed payload: does not throw, no deps called', async () => {
    const deps = makeDeps();
    const handler = createProfileHandler(deps);
    const rumor = makeProfileRumor({ content: 'not valid json at all' });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.mergeMemberProfile).not.toHaveBeenCalled();
    expect(deps.setProfileVersion).not.toHaveBeenCalled();
  });

  // ─── AC-ATTR-6 (epic: group-message-author-auth-app-layer S2): attribution
  // sources from sender.pubkey, not the forgeable rumor.pubkey ──────────────

  it('AC-ATTR-6: an unsigned/legacy profile rumor (no signedEvent) where sender.pubkey differs from rumor.pubkey is merged and cached under sender.pubkey, not rumor.pubkey', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    // Legacy flat profile (no signedEvent) — authorPubkey falls back to sender.pubkey.
    const rumor = makeProfileRumor(); // rumor.pubkey === PEER_PUBKEY
    const ctx = makeCtx();
    const forgedSender = makeSender(SELF_PUBKEY); // deliberately different from rumor.pubkey

    await handler.handle(rumor, ctx, forgedSender);

    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    const [, mergedProfile] = deps.mergeMemberProfile.mock.calls[0];
    expect(mergedProfile.pubkeyHex).toBe(SELF_PUBKEY);
    expect(mergedProfile.pubkeyHex).not.toBe(rumor.pubkey);

    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
    const [contactPubkey] = deps.writeContactEntry.mock.calls[0];
    expect(contactPubkey).toBe(SELF_PUBKEY);
  });

  it('duplicate-id: dispatcher LRU prevents second mergeMemberProfile call', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    const dispatcher = createDispatcher([handler]);
    const group = makeFakeGroup();
    const ctx = makeCtx();

    dispatcher.subscribe(group as any, ctx);

    const rumor = makeProfileRumor({ id: 'dup-profile-id-1' });
    mockRumor = rumor;

    await group.emit();
    await group.emit();

    // LRU dedup: second emission of same id is skipped
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
  });

  it('notifyProfileObserved NOT called for legacy profile (no signedEvent)', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    // Legacy flat profile — no signedEvent envelope
    const rumor = makeProfileRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    // signedEvent is absent in legacy profiles → notifyProfileObserved not called
    expect(deps.notifyProfileObserved).not.toHaveBeenCalled();
  });

  it('relay-on-behalf (signedEvent.pubkey !== rumor.pubkey) is accepted, NOT dropped (AC-047 amended)', async () => {
    // AC-047 amended interpretation: the embedded sig is the trust anchor.
    // Cross-pubkey relay is legitimate — receivers key the MemberProfile under
    // the signed author (signedEvent.pubkey), not the relayer (rumor.pubkey).
    // verifyEvent is mocked to return true above, so sig verification passes.
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    // rumorSenderPubkey = PEER_PUBKEY (the relayer), authorPubkey = AUTHOR_PUBKEY (the original author)
    const rumor = makeSignedProfileRumor({
      rumorSenderPubkey: PEER_PUBKEY,
      authorPubkey: AUTHOR_PUBKEY,
    });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    // Must NOT be dropped — merge fires
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    // The resulting MemberProfile should be keyed under the AUTHOR, not the relayer
    const mergedProfile = deps.mergeMemberProfile.mock.calls[0][1];
    expect(mergedProfile.pubkeyHex).toBe(AUTHOR_PUBKEY);
    // notifyProfileObserved fires because signedEvent is present
    expect(deps.notifyProfileObserved).toHaveBeenCalledOnce();
    expect(deps.notifyProfileObserved.mock.calls[0][0].targetPubkey).toBe(AUTHOR_PUBKEY);
    // Contact cache entry is keyed under the author
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
    const [contactPubkey] = deps.writeContactEntry.mock.calls[0];
    expect(contactPubkey).toBe(AUTHOR_PUBKEY);
  });

  // ─── AC-FWD-5 (epic: group-message-author-auth-app-layer S7): one-shot
  // consumption at the application boundary — a self-authored copy and a
  // forwarded copy of the SAME signed inner event both parse/verify
  // successfully, but the second application is a silent no-op. ───────────

  it('AC-FWD-5: a self-authored delivery followed by a relayed copy of the SAME signed profile (same inner event id, different outer rumor) applies once — second delivery is a no-op', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();
    const sharedInnerEventId = 'shared-inner-event-id-for-dedup-test';

    // First delivery: the author's own direct publish.
    const ownDelivery = makeSignedProfileRumor({
      rumorSenderPubkey: AUTHOR_PUBKEY,
      authorPubkey: AUTHOR_PUBKEY,
      innerEventId: sharedInnerEventId,
    });
    // Second delivery: a DIFFERENT outer rumor (relayed by PEER_PUBKEY) that
    // happens to carry the byte-identical signed inner event (same id) — the
    // dispatcher's own outer-rumor-id LRU would not catch this since the two
    // outer rumor ids differ; only the shared verifier's one-shot gate does.
    const relayedCopy = makeSignedProfileRumor({
      rumorSenderPubkey: PEER_PUBKEY,
      authorPubkey: AUTHOR_PUBKEY,
      innerEventId: sharedInnerEventId,
    });
    expect(ownDelivery.id).not.toBe(relayedCopy.id);

    await handler.handle(ownDelivery, ctx, makeSender(ownDelivery.pubkey));
    await handler.handle(relayedCopy, ctx, makeSender(relayedCopy.pubkey));

    // Both deliveries "verify" (both are validly signed) but only the FIRST
    // applies a side effect — the second is a no-op, not double-applied.
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
    expect(deps.setProfileVersion).toHaveBeenCalledOnce();
  });

  it('AC-FWD-5: two DIFFERENT signed profile deliveries (distinct inner event ids) both apply — one-shot gate does not over-collapse unrelated updates', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();

    // Two genuinely distinct signed publishes (default innerEventId is
    // unique per call) — must NOT be treated as duplicates of each other.
    const first = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const second = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });

    await handler.handle(first, ctx, makeSender(first.pubkey));
    await handler.handle(second, ctx, makeSender(second.pubkey));

    expect(deps.mergeMemberProfile).toHaveBeenCalledTimes(2);
  });

  // ─── AC-MARKER-5/6: clearPendingDirectInvite wiring ─────────────────────────

  it('AC-MARKER-5: own-signed profile (merged=true) clears the pending-direct-invite marker', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.clearPendingDirectInvite).toHaveBeenCalledOnce();
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, AUTHOR_PUBKEY);
  });

  it('AC-MARKER-5: own-signed profile that LOSES the LWW merge (merged=false) still clears the marker', async () => {
    const deps = makeDeps(false);
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    // Crux of AC-MARKER-5: must NOT regress to `if (merged) clear()` — arrival
    // of the invitee's own signed profile is proof of liveness regardless of
    // whether the LWW merge won.
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledOnce();
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, AUTHOR_PUBKEY);
  });

  it('AC-MARKER-6: rumor-only payload (no signedEvent) never clears any marker, even though rumor.pubkey looks marked', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    // makeProfileRumor() has pubkey: PEER_PUBKEY and no embedded signed envelope.
    const rumor = makeProfileRumor();
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.clearPendingDirectInvite).not.toHaveBeenCalled();
  });

  it('AC-MARKER-6: relay-on-behalf clears the AUTHOR pubkey, never the relayer pubkey', async () => {
    const deps = makeDeps(true);
    const handler = createProfileHandler(deps);
    // rumor sender (relayer) is PEER_PUBKEY; the embedded signed event's author is AUTHOR_PUBKEY.
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: PEER_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.clearPendingDirectInvite).toHaveBeenCalledOnce();
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, AUTHOR_PUBKEY);
    expect(deps.clearPendingDirectInvite).not.toHaveBeenCalledWith(GROUP_ID, PEER_PUBKEY);
  });

  it('clearPendingDirectInvite failure is best-effort and does not abort the rest of handle()', async () => {
    const deps = {
      ...makeDeps(true),
      clearPendingDirectInvite: vi.fn(async () => {
        throw new Error('idb quota');
      }),
    };
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
  });

  // ─── AC-XCUT-5 (epic: group-message-author-auth-app-layer S9): the
  // profile merge and the shared one-shot verifier are each order-
  // independent under redelivery — a self-authored copy and a forwarded
  // copy of the identical signed inner event, and envelopes whose
  // updatedAt values arrive out of chronological order, must not produce
  // delivery-order-dependent state. ────────────────────────────────────

  describe('AC-XCUT-5 (property tests over delivery order)', () => {
    const SUBJECT_PUBKEY = 'ee'.repeat(32);
    const RELAYER_PUBKEY = 'ff'.repeat(32);

    it('AC-XCUT-5(a) (property test over delivery order): merged MemberProfile after two envelopes for the same subject is order-independent and equals the greatest-updatedAt profile — through the REAL groupStorage.mergeMemberProfile', async () => {
      const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z';
      const NEW_UPDATED_AT = '2026-06-01T00:00:00.000Z';

      const orderings: Array<'old-then-new' | 'new-then-old'> = ['old-then-new', 'new-then-old'];

      for (const ordering of orderings) {
        const groupId = `xcut5-merge-${ordering}`;
        const ctx = { groupId, selfPubkeyHex: SELF_PUBKEY, getActiveGroupId: () => groupId };

        // envelopeOld: self-authored, chronologically earlier updatedAt.
        const envelopeOld = makeSignedProfileRumor({
          rumorSenderPubkey: SUBJECT_PUBKEY,
          authorPubkey: SUBJECT_PUBKEY,
          updatedAt: OLD_UPDATED_AT,
        });
        // envelopeNew: forwarded/relay-on-behalf copy (different outer
        // transport sender), chronologically later updatedAt.
        const envelopeNew = makeSignedProfileRumor({
          rumorSenderPubkey: RELAYER_PUBKEY,
          authorPubkey: SUBJECT_PUBKEY,
          updatedAt: NEW_UPDATED_AT,
        });
        expect(envelopeOld.id).not.toBe(envelopeNew.id);

        const deps = { ...makeDeps(true), mergeMemberProfile: realMergeMemberProfile };
        const handler = createProfileHandler(deps);

        const ordered = ordering === 'old-then-new' ? [envelopeOld, envelopeNew] : [envelopeNew, envelopeOld];
        for (const envelope of ordered) {
          await handler.handle(envelope, ctx, makeSender(envelope.pubkey));
        }

        const stored = await loadMemberProfiles(groupId);
        const subjectProfile = stored.find((p) => p.pubkeyHex === SUBJECT_PUBKEY);

        expect(subjectProfile, `ordering=${ordering}`).toBeDefined();
        expect(subjectProfile!.updatedAt, `ordering=${ordering}`).toBe(NEW_UPDATED_AT);
        expect(subjectProfile!.pubkeyHex, `ordering=${ordering}`).toBe(SUBJECT_PUBKEY);
      }
    });

    it('AC-XCUT-5(b) (property test over delivery order): a self-authored copy and a forwarded copy of the SAME signed inner event apply at most once, regardless of which arrives first', async () => {
      const SHARED_INNER_ID = 'xcut5-oneshot-inner-id';

      const orderings: Array<'self-then-forwarded' | 'forwarded-then-self'> = ['self-then-forwarded', 'forwarded-then-self'];

      for (const ordering of orderings) {
        const ctx = makeCtx();

        // Self-authored copy: rumor sent under the author's own pubkey.
        const selfCopy = makeSignedProfileRumor({
          innerEventId: SHARED_INNER_ID,
          rumorSenderPubkey: SUBJECT_PUBKEY,
          authorPubkey: SUBJECT_PUBKEY,
        });
        // Forwarded copy: same signed inner event, different outer transport sender.
        const forwardedCopy = makeSignedProfileRumor({
          innerEventId: SHARED_INNER_ID,
          rumorSenderPubkey: RELAYER_PUBKEY,
          authorPubkey: SUBJECT_PUBKEY,
        });

        const deps = makeDeps(true);
        // Fresh handler per ordering — a fresh OneShotGate instance, so the
        // gate under test isn't carrying state across iterations.
        const handler = createProfileHandler(deps);

        const ordered = ordering === 'self-then-forwarded' ? [selfCopy, forwardedCopy] : [forwardedCopy, selfCopy];
        for (const envelope of ordered) {
          await handler.handle(envelope, ctx, makeSender(envelope.pubkey));
        }

        expect(deps.mergeMemberProfile, `ordering=${ordering}`).toHaveBeenCalledOnce();

        // Self-containment check (Fable-S9-1): the assertion above alone
        // would ALSO pass under a hypothetical future gate that rejects
        // every forwarded copy outright (sender !== author), since that
        // too would leave mergeMemberProfile called exactly once. Prove
        // the single application above is genuinely the one-shot GATE's
        // doing — not a blanket forwarded-copy rejection — by delivering
        // a further forwarded envelope for the SAME subject but with a
        // DISTINCT inner event id, and asserting the call count actually
        // increments. If forwarded copies were blanket-rejected, this
        // would still read as 1, not 2.
        const distinctForwardedCopy = makeSignedProfileRumor({
          rumorSenderPubkey: RELAYER_PUBKEY,
          authorPubkey: SUBJECT_PUBKEY,
        });
        // Assert against the INNER signed-event id (what the one-shot gate
        // keys on) — the outer rumor id is derived only from
        // rumorSenderPubkey and is shared with `forwardedCopy` above.
        const distinctInnerId = (JSON.parse(distinctForwardedCopy.content) as { id: string }).id;
        expect(distinctInnerId, `ordering=${ordering}`).not.toBe(SHARED_INNER_ID);

        await handler.handle(distinctForwardedCopy, ctx, makeSender(distinctForwardedCopy.pubkey));

        expect(deps.mergeMemberProfile, `ordering=${ordering}`).toHaveBeenCalledTimes(2);
      }
    });
  });
});

// ─── accept-producer (epic: group-invite-lifecycle S3, DD-9) ────────────────
// AC-PROD-3/4/5: `accepted` fires exactly once per invitee/group, gated on
// the profile rumor's transport senderPubkey being B itself (a genuine
// own-join) AND a pending-direct-invite marker having existed at arrival.

describe('accept-producer (AC-PROD-3/4/5, DD-9)', () => {
  it('AC-PROD-3: own-join (senderPubkey === author) with a pending marker posts the accepted announcement exactly once, with the exact content', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    // B's OWN transport publish: rumorSenderPubkey === authorPubkey.
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.sendAnnouncement).toHaveBeenCalledOnce();
    const content = deps.sendAnnouncement.mock.calls[0][0];
    expect(JSON.parse(content)).toEqual({ type: 'invite_lifecycle', event: 'accepted', pubkey: AUTHOR_PUBKEY });
  });

  it('AC-PROD-4: third-member relay (senderPubkey !== author) never posts accepted, even with a pending marker set', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    // A naive implementation that only checks the payload's claimed identity
    // (signedEvent.pubkey === AUTHOR_PUBKEY) would wrongly fire here — this
    // is exactly the payload-vs-transport confusion AC-PROD-4 guards against.
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: PEER_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    // The pre-existing marker-clear mechanism is unchanged: a relay still
    // clears the marker (DD-9), it just must not be mistaken for a join.
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, AUTHOR_PUBKEY);
  });

  it('AC-PROD-5: duplicate/reconnect redelivery of B\'s own profile posts accepted exactly once, not zero and not two', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();
    const firstDelivery = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const secondDelivery = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });

    // First delivery: marker existed → posts, and consumePendingDirectInviteMarker's
    // atomic clear removes the marker from the shared backing store.
    await handler.handle(firstDelivery, ctx, makeSender(firstDelivery.pubkey));
    // Second delivery (e.g. after a reconnect/resubscribe): the marker the
    // first delivery consumed is gone, so consumePendingDirectInviteMarker now
    // reports false — driven by real state, not a hardcoded per-call return value.
    await handler.handle(secondDelivery, ctx, makeSender(secondDelivery.pubkey));

    expect(deps.sendAnnouncement).toHaveBeenCalledOnce();
  });

  it('S3 gate-remediation (severity-4, at-most-once TOCTOU): two DISTINCT-id own-join profile rumors for the same B, dispatched CONCURRENTLY (both interleaved before either resolves), post accepted EXACTLY ONCE', async () => {
    // Reproduces the finding: a naive hasPendingDirectInvite()-then-
    // clearPendingDirectInvite() pair lets two interleaved own-join deliveries
    // both observe the marker present before either clears it. This test
    // exercises the REAL Map-backed marker fixture (makeMarkerAwareDeps) and
    // fires both handle() calls WITHOUT awaiting between them, so they
    // genuinely interleave at the event-loop level exactly like two
    // back-to-back `applicationMessage` bus deliveries would (the dispatcher's
    // listener is `async` and is not awaited by the emitter — see
    // applicationRumorDispatcher.ts).
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();
    // Two DISTINCT rumor ids for the same B — the dispatcher's LRU dedup (keyed
    // on rumor.id) must not be what prevents the double-post; only the atomic
    // consume op may.
    const rumorA = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const rumorB = { ...makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY }), id: 'distinct-rumor-id-2' };
    expect(rumorA.id).not.toBe(rumorB.id);

    // Fire both concurrently — no await between them — so both handle() calls
    // are in flight together, exactly the interleaving the finding describes.
    await Promise.all([
      handler.handle(rumorA, ctx, makeSender(rumorA.pubkey)),
      handler.handle(rumorB, ctx, makeSender(rumorB.pubkey)),
    ]);

    expect(deps.sendAnnouncement).toHaveBeenCalledOnce();
    expect(deps.pendingMarkers.has(`${GROUP_ID}:${AUTHOR_PUBKEY}`)).toBe(false);
  });

  it('never posts accepted on a generic marker removal where no marker existed in the first place (e.g. after a prior cancel/leave fan-out)', async () => {
    const deps = makeMarkerAwareDeps(true);
    // No pendingMarkers entry set — simulates a pubkey with no pending
    // direct-invite marker at all (cancel/leave already cleared it, or it
    // was never invited via the direct-invite flow).
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await handler.handle(rumor, ctx, makeSender(rumor.pubkey));

    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
  });

  it('a sendAnnouncement failure is best-effort and does not abort the rest of handle()', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    deps.sendAnnouncement = vi.fn(async () => {
      throw new Error('publish failed');
    });
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
    expect(deps.writeContactEntry).toHaveBeenCalledOnce();
  });

  it('a consumePendingDirectInviteMarker failure is best-effort, fails closed (no accepted post), and does not abort the rest of handle()', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    deps.consumePendingDirectInviteMarker = vi.fn(async () => {
      throw new Error('idb read failed');
    });
    const handler = createProfileHandler(deps);
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const ctx = makeCtx();

    await expect(handler.handle(rumor, ctx, makeSender(rumor.pubkey))).resolves.not.toThrow();
    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    expect(deps.mergeMemberProfile).toHaveBeenCalledOnce();
  });

  // ─── Round-trip seam binding (S2-review-established requirement): every
  // producer's payload must bind to the REAL parseStructured guard, not just
  // an assumed shape. ────────────────────────────────────────────────────────
  // ─── VQ-S2-008 (post-impl closure, epic: group-message-author-auth-app-layer
  // S2 remediation round 1): the SIGNED-path own-join gate
  // (`sender.pubkey === authorPubkey`) is proven to read sender.pubkey, not
  // rumor.pubkey — the pre-S2 behavior it replaced. Both combinations below
  // are unreachable in real deliveries today (S1's dispatcher drops any
  // rumor where rumor.pubkey !== sender.pubkey before a handler runs), so
  // they exercise the dev-only sender-override hook. They lock the contract
  // as defense-in-depth against a future dispatcher change that might relax
  // that guarantee. ──────────────────────────────────────────────────────

  it('VQ-S2-008: own-join fires when sender.pubkey === authorPubkey even though rumor.pubkey (transport) is a different pubkey', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();
    // signedEvent.pubkey = AUTHOR_PUBKEY; rumor.pubkey (transport) =
    // PEER_PUBKEY, which differs from AUTHOR_PUBKEY. Under the OLD
    // rumor.pubkey===authorPubkey gate this would NOT have been treated as
    // an own-join. The authenticated sender is AUTHOR_PUBKEY itself, so the
    // NEW sender.pubkey===authorPubkey gate correctly fires.
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: PEER_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const divergentSender = makeSender(AUTHOR_PUBKEY); // sender.pubkey === authorPubkey, !== rumor.pubkey

    await handler.handle(rumor, ctx, divergentSender);

    expect(deps.sendAnnouncement).toHaveBeenCalledOnce();
    const content = deps.sendAnnouncement.mock.calls[0][0];
    expect(JSON.parse(content)).toEqual({ type: 'invite_lifecycle', event: 'accepted', pubkey: AUTHOR_PUBKEY });
  });

  it('VQ-S2-008: own-join stays false (AC-PROD-4 preserved) when sender.pubkey does not match authorPubkey, even though rumor.pubkey (transport) coincides with the author', async () => {
    const deps = makeMarkerAwareDeps(true);
    deps.pendingMarkers.set(`${GROUP_ID}:${AUTHOR_PUBKEY}`, true);
    const handler = createProfileHandler(deps);
    const ctx = makeCtx();
    // signedEvent.pubkey = AUTHOR_PUBKEY; rumor.pubkey (transport) is ALSO
    // AUTHOR_PUBKEY — the exact shape an OLD rumor.pubkey===authorPubkey
    // gate would have accepted as an own-join. The authenticated sender is
    // PEER_PUBKEY (a relayer), which diverges from authorPubkey, so the NEW
    // sender.pubkey===authorPubkey gate must NOT fire.
    const rumor = makeSignedProfileRumor({ rumorSenderPubkey: AUTHOR_PUBKEY, authorPubkey: AUTHOR_PUBKEY });
    const relayerSender = makeSender(PEER_PUBKEY); // sender.pubkey !== authorPubkey

    await handler.handle(rumor, ctx, relayerSender);

    expect(deps.sendAnnouncement).not.toHaveBeenCalled();
    // Relay-on-behalf marker-clear is unaffected: still clears via
    // clearPendingDirectInvite, just never mistaken for a join.
    expect(deps.clearPendingDirectInvite).toHaveBeenCalledWith(GROUP_ID, AUTHOR_PUBKEY);
  });

  it('round-trip: buildAcceptedAnnouncementContent output parses back through the real parseStructured guard to the exact InviteLifecycleContent shape', async () => {
    const { parseStructured } = await import('@/src/lib/marmot/parseStructured');
    const { buildAcceptedAnnouncementContent } = await import('@/src/lib/marmot/handlers/profileHandler');

    const content = buildAcceptedAnnouncementContent(AUTHOR_PUBKEY);
    const parsed = parseStructured(content);

    expect(parsed).toEqual({ type: 'invite_lifecycle', event: 'accepted', pubkey: AUTHOR_PUBKEY });
  });
});

// ─── VQ-S7-005 (epic: group-message-author-auth-app-layer S7): roster
// exemption static guard. Profiles are roster-EXEMPT (spec.md Solution §6,
// architecture.md's profile(0) actor-rule row) — a departed member's late or
// forwarded profile must never be rejected on roster grounds. The strongest
// proof of an EXEMPTION is structural absence: none of profileHandler.ts,
// the shared verifier (envelopeVerifier.ts), or profileSync.ts (where
// parseProfilePayload lives, also in the profile verification path) may
// reference ANY roster/admin accessor at all. Mirrors
// handlersRumorPubkeyBoundary.test.ts's source-scan precedent (real files,
// not mocked deps — a mocked-deps test could pass even if a real roster call
// were wired in and simply never invoked). ──────
describe('roster exemption (VQ-S7-005): profileHandler.ts, envelopeVerifier.ts, and profileSync.ts never reference a roster/admin accessor', () => {
  it('profileHandler.ts source contains no roster/admin identifier', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const filePath = path.resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../src/lib/marmot/handlers/profileHandler.ts',
    );
    const source = readFileSync(filePath, 'utf8');
    const ROSTER_IDENTIFIERS = ['isGroupAdmin', 'isGroupMember', 'GroupAdminsProvider', 'groupAdminsFor', 'isAdminPubkey', 'getGroupMembers', 'getLiveMemberPubkeys'];
    const found = ROSTER_IDENTIFIERS.filter((id) => source.includes(id));
    expect(found, `profileHandler.ts must never reference roster/admin accessors — found: ${found.join(', ')}`).toEqual([]);
  });

  it('envelopeVerifier.ts source contains no roster/admin identifier', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const filePath = path.resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../src/lib/marmot/envelopeVerifier.ts',
    );
    const source = readFileSync(filePath, 'utf8');
    const ROSTER_IDENTIFIERS = ['isGroupAdmin', 'isGroupMember', 'GroupAdminsProvider', 'groupAdminsFor', 'isAdminPubkey', 'getGroupMembers', 'getLiveMemberPubkeys'];
    const found = ROSTER_IDENTIFIERS.filter((id) => source.includes(id));
    expect(found, `envelopeVerifier.ts must never reference roster/admin accessors — found: ${found.join(', ')}`).toEqual([]);
  });

  it('profileSync.ts source contains no roster/admin identifier', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const filePath = path.resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../src/lib/marmot/profileSync.ts',
    );
    const source = readFileSync(filePath, 'utf8');
    const ROSTER_IDENTIFIERS = ['isGroupAdmin', 'isGroupMember', 'GroupAdminsProvider', 'groupAdminsFor', 'isAdminPubkey', 'getGroupMembers', 'getLiveMemberPubkeys'];
    const found = ROSTER_IDENTIFIERS.filter((id) => source.includes(id));
    expect(found, `profileSync.ts must never reference roster/admin accessors — found: ${found.join(', ')}`).toEqual([]);
  });

  it('profileRequestSync.ts source contains no roster/admin identifier', async () => {
    // architecture.md's Profiles row also names profileRequestSync.ts —
    // completing the negative-guarantee scan alongside profileSync.ts,
    // profileHandler.ts, and envelopeVerifier.ts above. Note:
    // profileRequestRunner.ts is deliberately OUT of this ban scan — its
    // getGroupMembers use is a legitimate roster-scoped outbound request
    // sweep, not a verification-path roster dependency.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const filePath = path.resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../src/lib/marmot/profileRequestSync.ts',
    );
    const source = readFileSync(filePath, 'utf8');
    const ROSTER_IDENTIFIERS = ['isGroupAdmin', 'isGroupMember', 'GroupAdminsProvider', 'groupAdminsFor', 'isAdminPubkey', 'getGroupMembers', 'getLiveMemberPubkeys'];
    const found = ROSTER_IDENTIFIERS.filter((id) => source.includes(id));
    expect(found, `profileRequestSync.ts must never reference roster/admin accessors — found: ${found.join(', ')}`).toEqual([]);
  });

  it('ProfileHandlerDeps has no roster/admin field (registerHandlers.ts never wires one in)', () => {
    // Structural evidence, not a runtime-defeatable claim: makeDeps() builds
    // the FULL ProfileHandlerDeps shape used everywhere else in this file —
    // if a roster field existed on the type, TypeScript would already force
    // it to be present here. Its absence from every deps fixture below is
    // therefore load-bearing, not incidental.
    const deps = makeDeps();
    const depsKeys = Object.keys(deps);
    const ROSTER_KEYS = ['isGroupAdmin', 'isGroupMember', 'isAdminPubkey'];
    expect(depsKeys.filter((k) => ROSTER_KEYS.includes(k))).toEqual([]);
  });
});
