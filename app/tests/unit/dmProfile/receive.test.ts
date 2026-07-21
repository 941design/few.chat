/**
 * receive.test.ts — unit tests for app/src/lib/dmProfile/receive.ts (epic:
 * direct-contact-profile-exchange, story 04, the security core). Covers
 * AC-PROF-3, AC-PROF-4, AC-PROF-4b, AC-PROF-5, AC-PROF-6, AC-PROF-10,
 * AC-PROF-13.
 *
 * Conventions mirrored from precedent in this repo:
 *   - crypto.subtle polyfill + REAL nostr-tools crypto (send.test.ts,
 *     sealAndWrap.test.ts) for the forged-binding test that goes through
 *     real unwrapAndOpen.
 *   - localStorage mock (contacts-property.test.ts) for the contacts/cache
 *     stores; fake-indexeddb/auto (scheduler.integration.test.ts) for the
 *     real schedule store — both exercised for real, never mocked, since
 *     mocking the codec parser or the gate predicate would hide a real
 *     security bug (project memory: feedback_test_mocking_blind_spots).
 *   - Only the NDK publish boundary is mocked (send.test.ts's pattern),
 *     never sealAndWrap/encodeProfileAnnounce/parseProfileAnnounce/
 *     isAllowedDmSender/ensureAvatar/hasShareableName.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

import 'fake-indexeddb/auto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createSeal, createWrap } from 'nostr-tools/nip59';
import { NDKEvent } from '@nostr-dev-kit/ndk';

const { unwrapAndOpen } = await import('@/src/lib/directMessages');
import type { UnsignedRumor } from '@/src/lib/directMessages';

import {
  DM_PROFILE_REQUEST_KIND,
  DM_PROFILE_ANNOUNCE_KIND,
  encodeProfileRequest,
  encodeProfileAnnounce,
} from '@/src/lib/dmProfile/kinds';

import {
  handleProfileRequest,
  handleProfileAnnounce,
  passesDisclosureGate,
  decideScheduleAction,
  _resetProfileRequestRateLimitForTests,
  RATE_LIMIT_COOLDOWN_SECONDS,
  type DisclosureGateContext,
  type ProfileRequestHandlerContext,
} from '@/src/lib/dmProfile/receive';

import {
  saveSchedule,
  loadSchedule,
  createInitialSchedule,
  clearAllSchedulesForTests,
} from '@/src/lib/dmProfile/scheduler';

import { readContactEntry, writeContactEntryNeutralized } from '@/src/lib/contactCache';
import { rememberContact, archiveContact, unarchiveContact } from '@/src/lib/contacts';
import { rememberKnownPeers } from '@/src/lib/knownPeers';
import type { Group } from '@/src/types';

// ── localStorage mock (contacts.ts + contactCache.ts share this key space) ─

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Identity + rumor helpers ─────────────────────────────────────────────

function makeIdentity() {
  const priv = generateSecretKey();
  const privHex = bytesToHex(priv);
  const pubHex = getPublicKey(priv);
  return { privHex, pubHex };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function makeRumor(overrides: Partial<UnsignedRumor> & { pubkey: string }): UnsignedRumor {
  return {
    kind: DM_PROFILE_REQUEST_KIND,
    content: encodeProfileRequest(),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    id: 'a'.repeat(64),
    ...overrides,
  };
}

/** Registers `pubkeyHex` as an active, non-archived contact AND an ever-known peer. */
function seedActiveContact(pubkeyHex: string): void {
  rememberKnownPeers([pubkeyHex]);
  rememberContact(pubkeyHex);
}

function gateCtx(ownPubkeyHex: string, extra?: Partial<DisclosureGateContext>): DisclosureGateContext {
  return {
    groups: [] as ReadonlyArray<Group>,
    knownPeers: new Set<string>(),
    ownPubkeyHex,
    ...extra,
  };
}

function requestCtx(
  owner: { privHex: string; pubHex: string },
  gate: DisclosureGateContext,
  overrides?: Partial<ProfileRequestHandlerContext>,
): ProfileRequestHandlerContext {
  return {
    ...gate,
    ndk: {} as never,
    keys: { ownPubkeyHex: owner.pubHex, ownPrivateKeyHex: owner.privHex },
    localProfile: { nickname: 'Owner', avatar: null },
    ...overrides,
  };
}

/** knownPeers-gated context: the given senderHex passes isAllowedDmSender. */
function allowingGateCtx(ownPubkeyHex: string, allowedSenderHex: string): DisclosureGateContext {
  return gateCtx(ownPubkeyHex, { knownPeers: new Set([allowedSenderHex.toLowerCase()]) });
}

beforeEach(async () => {
  localStorageMock.clear();
  localStorageMock.setItem.mockClear();
  vi.restoreAllMocks();
  _resetProfileRequestRateLimitForTests();
  await clearAllSchedulesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── AC-PROF-5: strict unwrap only / forged binding (SECURITY, hard) ────────

describe('AC-PROF-5 — strict unwrap only / forged binding', () => {
  it('a real NIP-59 wrap whose sealed rumor claims a different pubkey than the authenticated seal signer is rejected by unwrapAndOpen itself, before any receive.ts gate/cache/schedule code runs', async () => {
    const victim = makeIdentity(); // the identity the forged rumor claims to be
    const attacker = makeIdentity(); // the identity that actually signs the seal
    const recipient = makeIdentity(); // us — the one unwrapping

    // Pre-seed the victim as an existing, healthy contact so a successful
    // poisoning attempt would be observable.
    seedActiveContact(victim.pubHex);
    writeContactEntryNeutralized(victim.pubHex, {
      nickname: 'RealVictimName',
      avatar: { imageUrl: '//few.chat/assets/victim.png' },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const schedule = createInitialSchedule(victim.pubHex, 1_700_000_000);
    await saveSchedule(schedule);

    // Build a rumor whose `pubkey` field claims the VICTIM, but seal/sign it
    // with the ATTACKER's key — createSeal/createWrap (unlike createRumor)
    // do not overwrite `pubkey` from the signing key, so this genuinely
    // produces rumor.pubkey !== seal.pubkey (mirrors
    // directMessages/sealAndWrap.test.ts's forgery-rejection precedent).
    const forgedRumor: UnsignedRumor = {
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'ForgedName', avatar: { imageUrl: '//few.chat/assets/forged.png' } }),
      tags: [['p', recipient.pubHex]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: victim.pubHex, // forged claim
      id: 'a'.repeat(64),
    };
    const seal = createSeal(forgedRumor as any, hexToBytes(attacker.privHex), recipient.pubHex);
    const wrap = createWrap(seal, recipient.pubHex);

    await expect(unwrapAndOpen(wrap as any, recipient.privHex)).rejects.toThrow('gift wrap decryption failed');

    // Since unwrapAndOpen threw, the sanctioned caller (story 05's watcher)
    // never constructs a rumor to hand to either dispatch arm at all — the
    // victim's cache entry and schedule are untouched.
    expect(readContactEntry(victim.pubHex)).toEqual({
      nickname: 'RealVictimName',
      avatar: { imageUrl: '//few.chat/assets/victim.png' },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const loaded = await loadSchedule(victim.pubHex, 1_700_000_000);
    expect(loaded).toEqual(schedule);
  });

  it('receive.ts arms drop silently (no cache write, no schedule mutation) when the caller-supplied senderHex disagrees with rumor.pubkey — defense in depth beyond unwrapAndOpen', async () => {
    const attacker = makeIdentity(); // the AUTHENTICATED sender (rumor.pubkey really is this)
    const victim = makeIdentity(); // a caller bug supplies this as senderHex instead
    const owner = makeIdentity();

    seedActiveContact(victim.pubHex);
    seedActiveContact(attacker.pubHex);

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Mallory', avatar: { imageUrl: '//few.chat/assets/x.png' } }),
      pubkey: attacker.pubHex,
    });

    await handleProfileAnnounce(rumor, victim.pubHex /* mismatched */, gateCtx(owner.pubHex));

    expect(readContactEntry(victim.pubHex)).toBeUndefined();
    expect(readContactEntry(attacker.pubHex)).toBeUndefined();
    expect(await loadSchedule(victim.pubHex)).toBeUndefined();
    expect(await loadSchedule(attacker.pubHex)).toBeUndefined();
  });

  it('receive.ts source never imports welcomeSubscription.ts / unwrapGiftWrap and never hand-rolls JSON.parse on rumor.content', () => {
    const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
    const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/dmProfile -> app/
    const RECEIVE_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'src', 'lib', 'dmProfile', 'receive.ts'), 'utf8');

    // Checked as actual usage (import/call sites), not prose — this file's
    // own header doc legitimately MENTIONS both names to explain why they
    // must never be used.
    expect(RECEIVE_SOURCE).not.toMatch(/from ['"][^'"]*welcomeSubscription['"]/);
    expect(RECEIVE_SOURCE).not.toMatch(/unwrapGiftWrap\s*\(/);
    expect(RECEIVE_SOURCE).not.toMatch(/JSON\.parse\(\s*rumor\.content/);
  });
});

// ── AC-PROF-3 — stranger request gate (both failing halves) ────────────────

describe('AC-PROF-3 — stranger request gate', () => {
  it('sender fails isAllowedDmSender (never allowed): no answer, sendProfileAnnounce path never publishes', async () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: stranger.pubHex, kind: DM_PROFILE_REQUEST_KIND });
    await handleProfileRequest(rumor, stranger.pubHex, requestCtx(owner, gateCtx(owner.pubHex)));

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('sender passes isAllowedDmSender but is archived: no answer (VQ-S04-001/006)', async () => {
    const owner = makeIdentity();
    const archived = makeIdentity();
    seedActiveContact(archived.pubHex);
    archiveContact(archived.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: archived.pubHex, kind: DM_PROFILE_REQUEST_KIND });
    await handleProfileRequest(rumor, archived.pubHex, requestCtx(owner, allowingGateCtx(owner.pubHex, archived.pubHex)));

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('sender is allowed AND active/non-archived: answers with exactly one profile-announce publish (AC-PROF-2/3 happy path)', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity();
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_REQUEST_KIND });
    await handleProfileRequest(
      rumor,
      requester.pubHex,
      requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
        localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/owner.png' } },
      }),
    );

    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('a nameless owner defers (AC-PROF-12): gate passes, but no publish, and the cooldown is NOT consumed', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity();
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_REQUEST_KIND });
    const ctx = requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
      localProfile: { nickname: '', avatar: null }, // nameless
    });
    await handleProfileRequest(rumor, requester.pubHex, ctx, 1_000);
    expect(publishSpy).not.toHaveBeenCalled();

    // Once named, the very next request must still be answerable — proving
    // the nameless no-op did not consume the rate-limit slot.
    ctx.localProfile = { nickname: 'NowNamed', avatar: { imageUrl: '//few.chat/assets/x.png' } };
    await handleProfileRequest(rumor, requester.pubHex, ctx, 1_001);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});

// ── AC-PROF-13 — rate-limit ─────────────────────────────────────────────────

describe('AC-PROF-13 — rate-limit', () => {
  it('two requests from the same sender within the cooldown produce at most one answer; a third after cooldown elapses produces a second', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity();
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);
    const ctx = requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
      localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/owner.png' } },
    });
    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_REQUEST_KIND });

    await handleProfileRequest(rumor, requester.pubHex, ctx, 1_000);
    await handleProfileRequest(rumor, requester.pubHex, ctx, 1_000 + RATE_LIMIT_COOLDOWN_SECONDS - 1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    await handleProfileRequest(rumor, requester.pubHex, ctx, 1_000 + RATE_LIMIT_COOLDOWN_SECONDS);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('the cooldown is scoped per authenticated sender — a different sender is answered immediately', async () => {
    const owner = makeIdentity();
    const requesterA = makeIdentity();
    const requesterB = makeIdentity();
    seedActiveContact(requesterA.pubHex);
    seedActiveContact(requesterB.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);
    const localProfile = { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/owner.png' } };

    await handleProfileRequest(
      makeRumor({ pubkey: requesterA.pubHex, kind: DM_PROFILE_REQUEST_KIND }),
      requesterA.pubHex,
      requestCtx(owner, allowingGateCtx(owner.pubHex, requesterA.pubHex), { localProfile }),
      1_000,
    );
    await handleProfileRequest(
      makeRumor({ pubkey: requesterB.pubHex, kind: DM_PROFILE_REQUEST_KIND }),
      requesterB.pubHex,
      requestCtx(owner, allowingGateCtx(owner.pubHex, requesterB.pubHex), { localProfile }),
      1_000,
    );

    expect(publishSpy).toHaveBeenCalledTimes(2);
  });
});

// ── AC-PROF-4 — stranger announce gate ──────────────────────────────────────

describe('AC-PROF-4 — stranger announce gate', () => {
  it('sender fails isAllowedDmSender: stores nothing, adds no contact-list entry, starts no schedule', async () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    const rememberSpy = vi.spyOn(await import('@/src/lib/contacts'), 'rememberContact');

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Stranger', avatar: { imageUrl: '//few.chat/assets/s.png' } }),
      pubkey: stranger.pubHex,
    });
    await handleProfileAnnounce(rumor, stranger.pubHex, gateCtx(owner.pubHex));

    expect(readContactEntry(stranger.pubHex)).toBeUndefined();
    expect(rememberSpy).not.toHaveBeenCalled();
    expect(await loadSchedule(stranger.pubHex)).toBeUndefined();
  });

  it('sender is allowed (knownPeers) but has no pre-existing contact-list entry: still dropped (AC-PROF-4\'s "already in lp_contacts_v1")', async () => {
    const owner = makeIdentity();
    const notYetContact = makeIdentity();
    rememberKnownPeers([notYetContact.pubHex]); // allowed, but never rememberContact'd

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'NotYet', avatar: { imageUrl: '//few.chat/assets/n.png' } }),
      pubkey: notYetContact.pubHex,
    });
    await handleProfileAnnounce(rumor, notYetContact.pubHex, allowingGateCtx(owner.pubHex, notYetContact.pubHex));

    expect(readContactEntry(notYetContact.pubHex)).toBeUndefined();
    expect(await loadSchedule(notYetContact.pubHex)).toBeUndefined();
  });
});

// ── AC-PROF-4b — archive revokes both directions, unarchive restores ───────

describe('AC-PROF-4b — archive revokes both directions', () => {
  it('an archived contact\'s announce is dropped; unarchiving restores acceptance', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const ctx = allowingGateCtx(owner.pubHex, contact.pubHex);

    archiveContact(contact.pubHex);
    const rumor1 = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'ArchivedPeer', avatar: { imageUrl: '//few.chat/assets/a.png' } }),
      pubkey: contact.pubHex,
      created_at: 1000,
    });
    await handleProfileAnnounce(rumor1, contact.pubHex, ctx);
    expect(readContactEntry(contact.pubHex)).toBeUndefined();

    unarchiveContact(contact.pubHex);
    const rumor2 = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'RestoredPeer', avatar: { imageUrl: '//few.chat/assets/r.png' } }),
      pubkey: contact.pubHex,
      created_at: 2000,
    });
    await handleProfileAnnounce(rumor2, contact.pubHex, ctx);
    expect(readContactEntry(contact.pubHex)?.nickname).toBe('RestoredPeer');
  });

  it('an archived contact\'s request receives no answer; unarchiving restores answering', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    archiveContact(contact.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);
    const ctx = requestCtx(owner, allowingGateCtx(owner.pubHex, contact.pubHex), {
      localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/owner.png' } },
    });
    const rumor = makeRumor({ pubkey: contact.pubHex, kind: DM_PROFILE_REQUEST_KIND });

    await handleProfileRequest(rumor, contact.pubHex, ctx, 1_000);
    expect(publishSpy).not.toHaveBeenCalled();

    unarchiveContact(contact.pubHex);
    await handleProfileRequest(rumor, contact.pubHex, ctx, 1_001);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});

// ── AC-PROF-6 / AC-PROF-10 — store + clear on completing write, LWW ────────

describe('AC-PROF-6 / AC-PROF-10 — completing write clears schedule; LWW governs store', () => {
  it('a completing announce (gate-passing, non-malformed, LWW-won, avatar non-null) is stored under the authenticated sender and clears the schedule', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const schedule = createInitialSchedule(contact.pubHex, 1_700_000_000);
    await saveSchedule(schedule);

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Bob', avatar: { imageUrl: '//few.chat/assets/bob.png' } }),
      pubkey: contact.pubHex,
    });
    await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));

    const stored = readContactEntry(contact.pubHex);
    expect(stored?.nickname).toBe('Bob');
    expect(stored?.avatar).toEqual({ imageUrl: '//few.chat/assets/bob.png' });
    expect(await loadSchedule(contact.pubHex, 1_700_000_000)).toBeUndefined();
  });

  it('a non-completing write (LWW lost) leaves the schedule untouched', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    // Seed a NEWER entry directly so the incoming announce's updatedAt loses LWW.
    writeContactEntryNeutralized(contact.pubHex, {
      nickname: 'Newer',
      avatar: { imageUrl: '//few.chat/assets/newer.png' },
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    const schedule = createInitialSchedule(contact.pubHex, 1_700_000_000);
    await saveSchedule(schedule);

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Stale', avatar: { imageUrl: '//few.chat/assets/stale.png' } }),
      pubkey: contact.pubHex,
    });
    await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));

    expect(readContactEntry(contact.pubHex)?.nickname).toBe('Newer'); // untouched
    expect(await loadSchedule(contact.pubHex, 1_700_000_000)).toEqual(schedule); // untouched
  });

  it('a malformed announce (avatar null/absent) is dropped: not stored, schedule NOT cleared (AC-PROF-6a)', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const schedule = createInitialSchedule(contact.pubHex, 1_700_000_000);
    await saveSchedule(schedule);

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: JSON.stringify({ type: 'profile-announce', nickname: 'NoAvatar', updatedAt: '2026-01-01T00:00:00.000Z' }),
      pubkey: contact.pubHex,
    });
    await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));

    expect(readContactEntry(contact.pubHex)).toBeUndefined();
    expect(await loadSchedule(contact.pubHex, 1_700_000_000)).toEqual(schedule); // NOT cleared
  });

  it('LWW: newer updates, older-or-equal does not, repeated identical announce is idempotent (real ISO-8601 lexicographic values)', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const ctx = allowingGateCtx(owner.pubHex, contact.pubHex);

    const older = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Old', avatar: { imageUrl: '//few.chat/assets/old.png' } }),
      pubkey: contact.pubHex,
    });
    // Force a specific updatedAt by encoding at a fixed fake time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const olderContent = encodeProfileAnnounce({ nickname: 'Old', avatar: { imageUrl: '//few.chat/assets/old.png' } });
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    const newerContent = encodeProfileAnnounce({ nickname: 'New', avatar: { imageUrl: '//few.chat/assets/new.png' } });
    vi.useRealTimers();

    // Newer first, then older — older must NOT overwrite.
    await handleProfileAnnounce(makeRumor({ ...older, content: newerContent, pubkey: contact.pubHex }), contact.pubHex, ctx);
    expect(readContactEntry(contact.pubHex)?.nickname).toBe('New');

    await handleProfileAnnounce(makeRumor({ ...older, content: olderContent, pubkey: contact.pubHex }), contact.pubHex, ctx);
    expect(readContactEntry(contact.pubHex)?.nickname).toBe('New'); // unchanged

    // Applying the identical (newer) announce twice is idempotent.
    const before = JSON.stringify(readContactEntry(contact.pubHex));
    await handleProfileAnnounce(makeRumor({ ...older, content: newerContent, pubkey: contact.pubHex }), contact.pubHex, ctx);
    const after = JSON.stringify(readContactEntry(contact.pubHex));
    expect(after).toBe(before);
  });
});

// ── contacts-live-updates: return value drives the live change-signal ──────
//
// handleProfileAnnounce returns true iff the contact cache was actually
// updated (won LWW). ProfileHealWatcher bumps MarmotContext#contactsRevision
// only on a true return, so the contacts list / DM header / bell rows
// re-derive their name/avatar exactly when a displayed value changed and never
// on a dropped or stale announce (epic: contacts-live-updates, AC-SIGNAL-2 /
// AC-PROFILE-1/2).
describe('handleProfileAnnounce — return signals whether a displayed value changed', () => {
  it('returns true when a gate-passing, LWW-won announce lands a new nickname/avatar', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Bob', avatar: { imageUrl: '//few.chat/assets/bob.png' } }),
      pubkey: contact.pubHex,
    });
    const wrote = await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));
    expect(wrote).toBe(true);
  });

  it('returns false when the announce loses LWW (nothing displayed changed)', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    writeContactEntryNeutralized(contact.pubHex, {
      nickname: 'Newer',
      avatar: { imageUrl: '//few.chat/assets/newer.png' },
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Stale', avatar: { imageUrl: '//few.chat/assets/stale.png' } }),
      pubkey: contact.pubHex,
    });
    const wrote = await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));
    expect(wrote).toBe(false);
  });

  it('returns false when the disclosure gate drops a stranger announce', async () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Mallory', avatar: { imageUrl: '//few.chat/assets/m.png' } }),
      pubkey: stranger.pubHex,
    });
    const wrote = await handleProfileAnnounce(rumor, stranger.pubHex, gateCtx(owner.pubHex));
    expect(wrote).toBe(false);
  });

  it('returns false for a malformed (avatar null/absent) announce', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: JSON.stringify({ type: 'profile-announce', nickname: 'NoAvatar', updatedAt: '2026-01-01T00:00:00.000Z' }),
      pubkey: contact.pubHex,
    });
    const wrote = await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));
    expect(wrote).toBe(false);
  });
});

// ── passesDisclosureGate / decideScheduleAction — direct unit coverage ─────

describe('passesDisclosureGate — both failing halves independently (VQ-S04-001)', () => {
  it('false when isAllowedDmSender fails (no groups, no knownPeers membership), even if an active contact record exists', () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex); // active contact record exists...
    // ...but NOT in knownPeers/groups per the gate context below:
    expect(passesDisclosureGate(contact.pubHex, gateCtx(owner.pubHex))).toBe(false);
  });

  it('false when allowed but archived; true once unarchived', () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);
    const ctx = allowingGateCtx(owner.pubHex, contact.pubHex);
    archiveContact(contact.pubHex);
    expect(passesDisclosureGate(contact.pubHex, ctx)).toBe(false);
    unarchiveContact(contact.pubHex);
    expect(passesDisclosureGate(contact.pubHex, ctx)).toBe(true);
  });

  it('false when allowed but no contact record exists at all', () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    expect(passesDisclosureGate(stranger.pubHex, allowingGateCtx(owner.pubHex, stranger.pubHex))).toBe(false);
  });
});

describe('decideScheduleAction — pure routing (AC-PROF-6/10/11a)', () => {
  it('clear when lwwWon and avatarNonNull', () => {
    expect(decideScheduleAction({ lwwWon: true, avatarNonNull: true })).toBe('clear');
  });
  it('mark-incomplete when lwwWon but avatar is empty (AC-PROF-11a hook)', () => {
    expect(decideScheduleAction({ lwwWon: true, avatarNonNull: false })).toBe('mark-incomplete');
  });
  it('none when LWW lost, regardless of avatarNonNull', () => {
    expect(decideScheduleAction({ lwwWon: false, avatarNonNull: true })).toBe('none');
    expect(decideScheduleAction({ lwwWon: false, avatarNonNull: false })).toBe('none');
  });
});

// ── Per-arm guard discrimination (mutation-audit gap closure, receive.ts) ──
//
// Added by a pre-ship mutation audit of receive.ts: the six defensive drops
// below survived mutation because no test discriminated them. Each guard is a
// security-core branch (AC-PROF-5 defense-in-depth, AC-PROF-6a malformed drop,
// kind routing) whose removal must be observable. See the audit note.

describe('receive.ts guard discrimination (mutation-audit gap closure)', () => {
  // Gap: request-arm senderHex-vs-rumor.pubkey mismatch drop was entirely
  // untested (only the announce arm had a test). The authenticated sender is
  // deliberately gate-passing so removing the mismatch guard WOULD answer.
  it('request arm drops (no publish) when caller-supplied senderHex disagrees with an otherwise gate-passing rumor.pubkey', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity(); // authenticated + gate-passing
    const other = makeIdentity(); // mismatched caller-supplied senderHex
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_REQUEST_KIND });
    await handleProfileRequest(
      rumor,
      other.pubHex, // mismatched
      requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
        localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/o.png' } },
      }),
      1_000,
    );

    expect(publishSpy).not.toHaveBeenCalled();
  });

  // Gap: the announce-arm mismatch test (AC-PROF-5) used an attacker that also
  // FAILED the gate, so the gate masked the mismatch guard. Here the
  // authenticated sender IS gate-passing, so only the mismatch guard can drop.
  it('announce arm drops (no write) when senderHex disagrees with an otherwise gate-passing rumor.pubkey — guard not masked by the gate', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity(); // authenticated + gate-passing
    const other = makeIdentity(); // mismatched caller-supplied senderHex
    seedActiveContact(contact.pubHex);

    const rumor = makeRumor({
      kind: DM_PROFILE_ANNOUNCE_KIND,
      content: encodeProfileAnnounce({ nickname: 'Legit', avatar: { imageUrl: '//few.chat/assets/l.png' } }),
      pubkey: contact.pubHex,
    });
    await handleProfileAnnounce(rumor, other.pubHex /* mismatched */, allowingGateCtx(owner.pubHex, contact.pubHex));

    expect(readContactEntry(contact.pubHex)).toBeUndefined();
  });

  // Gap: request arm never tested with a wrong rumor.kind.
  it('request arm drops (no publish) on a wrong-kind rumor even when the sender would otherwise pass the gate', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity();
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_ANNOUNCE_KIND /* wrong */ });
    await handleProfileRequest(
      rumor,
      requester.pubHex,
      requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
        localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/o.png' } },
      }),
      1_000,
    );

    expect(publishSpy).not.toHaveBeenCalled();
  });

  // Gap: announce arm never tested with a wrong rumor.kind.
  it('announce arm drops (no write) on a wrong-kind rumor even when the sender would otherwise pass the gate', async () => {
    const owner = makeIdentity();
    const contact = makeIdentity();
    seedActiveContact(contact.pubHex);

    const rumor = makeRumor({
      kind: DM_PROFILE_REQUEST_KIND /* wrong */,
      content: encodeProfileAnnounce({ nickname: 'Legit', avatar: { imageUrl: '//few.chat/assets/l.png' } }),
      pubkey: contact.pubHex,
    });
    await handleProfileAnnounce(rumor, contact.pubHex, allowingGateCtx(owner.pubHex, contact.pubHex));

    expect(readContactEntry(contact.pubHex)).toBeUndefined();
  });

  // Gap: request arm never tested with malformed (unparseable) content.
  it('request arm drops (no publish) on malformed profile-request content', async () => {
    const owner = makeIdentity();
    const requester = makeIdentity();
    seedActiveContact(requester.pubHex);
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const rumor = makeRumor({ pubkey: requester.pubHex, kind: DM_PROFILE_REQUEST_KIND, content: 'not-valid-json' });
    await handleProfileRequest(
      rumor,
      requester.pubHex,
      requestCtx(owner, allowingGateCtx(owner.pubHex, requester.pubHex), {
        localProfile: { nickname: 'Owner', avatar: { imageUrl: '//few.chat/assets/o.png' } },
      }),
      1_000,
    );

    expect(publishSpy).not.toHaveBeenCalled();
  });

  // Gap: isActiveNonArchivedContact's key-match predicate was never
  // discriminated against MULTIPLE stored contacts — a `.find` that ignores
  // the key would return the wrong (here: archived) contact's state.
  it('passesDisclosureGate reads the queried contact, not merely the first stored one, when several contacts exist', () => {
    const owner = makeIdentity();
    const first = makeIdentity(); // stored first, then archived
    const queried = makeIdentity(); // stored second, active — the one we ask about
    seedActiveContact(first.pubHex);
    archiveContact(first.pubHex);
    seedActiveContact(queried.pubHex);

    expect(passesDisclosureGate(queried.pubHex, allowingGateCtx(owner.pubHex, queried.pubHex))).toBe(true);
  });
});
