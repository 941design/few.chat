/**
 * Unit/integration tests for pairingAck.ts (epic: contact-pairing-code,
 * story S3). SECURITY-CRITICAL — covers AC-ACK-1..3, AC-ADMIT-1..5,
 * AC-SEC-1..4, AC-PRIV-1.
 *
 * Conventions mirrored from precedent in this repo:
 *   - crypto.subtle polyfill + real nostr-tools crypto (sealAndWrap.test.ts,
 *     dmReactions.test.ts) — no mocking of gift-wrap crypto primitives.
 *   - fake-indexeddb/auto for the real nonceStore.ts (nonceStore.integration.test.ts).
 *   - `vi.spyOn(NDKEvent.prototype, 'publish')` for the outbound relay call
 *     (dmReactions.test.ts).
 *   - `vi.mock` factories with shared, inspectable JS state for knownPeers.ts /
 *     contacts.ts (welcomeSubscription.test.ts's mockEnqueuePendingInvitation
 *     pattern) — this lets tests assert exact call ORDER (AC-ADMIT-1) without
 *     depending on jsdom/localStorage plumbing. walledGarden.ts's
 *     `isAllowedDmSender` is exercised for REAL (not mocked) against the
 *     tracked knownPeers state for AC-ADMIT-5 (VQ-S3-016).
 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { encodeCard, decodeCard } from '@/src/lib/contactCard';
import { isAllowedDmSender } from '@/src/lib/walledGarden';
// §10.1 fix (epic: direct-contact-profile-exchange, story 07, AC-CARD-1) —
// contactCache.ts is NOT mocked in this file (unlike knownPeers.ts/contacts.ts
// above), so these regression tests exercise the real read/write seam.
import { readContactEntry, writeContactEntryNeutralized } from '@/src/lib/contactCache';
import { STORAGE_KEYS } from '@/src/types';
import { DM_PROFILE_ANNOUNCE_KIND, parseProfileAnnounce } from '@/src/lib/dmProfile/kinds';
import {
  getOrMintActiveNonce,
  clearAllNonces,
  _resetActiveNonceForTests,
  getStoredNonce,
  NONCE_GRACE_SEC,
} from '@/src/lib/pairing/nonceStore';
// Namespace import: enables vi.spyOn on individual nonceStore exports without
// mocking the whole module (mutation-gate: forces a downstream throw so the
// outer catch fallback in handlePairingAck is observably exercised).
import * as nonceStoreModule from '@/src/lib/pairing/nonceStore';

// ── localStorage mock (story 06 push-trigger tests only) ───────────────────
// Hand-rolled, no jsdom — mirrors contacts-property.test.ts's precedent.
// `readUserProfile()` (storage.ts) reads through this; contacts.ts/
// knownPeers.ts are separately vi.mock'd above/below and never touch this
// store, so this mock is scoped in effect to the new push-trigger behavior
// (readUserProfile()) only — every pre-existing test leaves the store empty
// and gets storage.ts's own DEFAULT_USER_PROFILE ({nickname:'', avatar:null}),
// which makes sendProfileAnnounce's nameless gate a zero-I/O no-op (S03
// contract) — so pre-existing publish-count assertions are unaffected.
const localProfileStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localProfileStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localProfileStore[key] = value;
  },
  removeItem: (key: string) => {
    delete localProfileStore[key];
  },
  clear: () => {
    Object.keys(localProfileStore).forEach((k) => delete localProfileStore[k]);
  },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

function setLocalUserProfile(profile: { nickname: string; avatar: { imageUrl: string } | null }): void {
  localProfileStore[STORAGE_KEYS.userProfile] = JSON.stringify(profile);
}

function clearLocalUserProfile(): void {
  delete localProfileStore[STORAGE_KEYS.userProfile];
}

// ── Tracked mocks for knownPeers.ts / contacts.ts ───────────────────────────
// Shared, inspectable JS state standing in for the real (localStorage-backed)
// stores — lets tests assert exact call order (AC-ADMIT-1) and exact
// dedup/idempotency behavior (AC-ACK-3) without jsdom.

const { knownPeersState, rememberKnownPeersCalls, rememberPendingContactCalls, callOrder, contactsState } = vi.hoisted(() => ({
  knownPeersState: new Set<string>(),
  rememberKnownPeersCalls: [] as string[][],
  rememberPendingContactCalls: [] as string[],
  callOrder: [] as Array<'knownPeers' | 'contact'>,
  // Gate-remediation finding 1: `@/src/lib/contacts` is mocked wholesale
  // below, which would otherwise leave `readStoredContacts` undefined —
  // `blockedPeers.ts#loadBlockedPeers()` (now called from handlePairingAck)
  // imports exactly that export. Tracked state here stands in for
  // `lp_contacts_v1`, mirroring `rememberPendingContact`'s real
  // archivedAt/pendingConfirmationSince-preserving upsert semantics closely
  // enough for these tests, and lets a test seed a sender as already-blocked
  // (archivedAt set) or already-pending BEFORE a pairing-ack arrives.
  contactsState: {} as Record<string, { pubkeyHex: string; firstSeenAt: string; lastSeenAt: string; archivedAt: string | null; pendingConfirmationSince?: string | null }>,
}));

vi.mock('@/src/lib/knownPeers', () => ({
  rememberKnownPeers: (hexes: string[]) => {
    rememberKnownPeersCalls.push(hexes);
    callOrder.push('knownPeers');
    for (const h of hexes) knownPeersState.add(h.toLowerCase());
  },
}));

vi.mock('@/src/lib/contacts', () => ({
  // Retained as a no-op stand-in — contactCache.ts imports this name (used
  // only by its non-neutralized `writeContactEntry`, which none of
  // handlePairingAck's exercised code paths ever call), but production
  // admission at Step 9 now uses `rememberPendingContact` instead (epic:
  // pending-contact-confirmation, S1).
  rememberContact: () => {},
  isPendingConfirmation: (hex: string) => !!contactsState[hex.toLowerCase()]?.pendingConfirmationSince,
  // Epic: pending-contact-confirmation, S1 — the pending-admission
  // primitive that REPLACES `rememberContact` at handlePairingAck's Step 9.
  // Mirrors contacts.ts#rememberPendingContact's real
  // archivedAt/pendingConfirmationSince-preserving upsert: a brand-new
  // sender gets `pendingConfirmationSince` set to `seenAt` (AC-ADMIT-1); a
  // re-pairing sender's existing `archivedAt` AND `pendingConfirmationSince`
  // are both left exactly as they were (AC-ADMIT-2, Step 9's comment:
  // "correctly PRESERVES their archivedAt").
  rememberPendingContact: (hex: string, seenAt: string = new Date().toISOString()) => {
    rememberPendingContactCalls.push(hex);
    callOrder.push('contact');
    // Case-insensitive gather-all-matches lookup, mirroring the real
    // rememberPendingContact's `matchingKeys` pattern (contacts.ts lines
    // 149-180, AC-STRUCT-4) — a differently-cased stored key must still be
    // found and updated, not shadowed by a fresh entry under `hex`.
    const target = hex.toLowerCase();
    const matchingKeys = Object.keys(contactsState).filter((key) => key.toLowerCase() === target);
    if (matchingKeys.length > 0) {
      for (const matchingKey of matchingKeys) {
        const existing = contactsState[matchingKey];
        contactsState[matchingKey] = { ...existing, lastSeenAt: seenAt };
      }
    } else {
      contactsState[hex] = { pubkeyHex: hex, firstSeenAt: seenAt, lastSeenAt: seenAt, archivedAt: null, pendingConfirmationSince: seenAt };
    }
  },
  readStoredContacts: () => contactsState,
}));

import * as directMessagesModule from '@/src/lib/directMessages';
import { subscribeDirectMessageNotifications } from '@/src/lib/directMessageNotifications';
import * as unreadStore from '@/src/lib/unreadStore';
import { subscribeStoreChanged } from '@/src/lib/crossTab';
import { applyStoreChanged } from '@/src/lib/crossTabReceiver';
const { sealAndWrap, unwrapAndOpen, CHAT_MESSAGE_KIND } = directMessagesModule;

import { NDKEvent } from '@nostr-dev-kit/ndk';

import {
  PAIRING_ACK_KIND,
  sendPairingAck,
  handlePairingAck,
  getPairingAckAdmissions,
  _resetPairingAckAdmissionsForTests,
  type PairingAckContent,
} from '@/src/lib/pairing/pairingAck';

// ── Key helpers ──────────────────────────────────────────────────────────

function makeIdentity() {
  const priv = generateSecretKey();
  const privHex = bytesToHex(priv);
  const pubHex = getPublicKey(priv);
  return { priv, privHex, pubHex, signer: createPrivateKeySigner(privHex) };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const T0 = 1_700_000_000; // unix seconds, matches nonceStore.integration.test.ts's anchor

/** Build a genuine identity-only card (no pairing field) for `identity`. */
async function buildIdentityCard(identity: ReturnType<typeof makeIdentity>, nickname: string): Promise<string> {
  return encodeCard(identity.pubHex, { nickname, createdAt: T0 }, identity.signer.signEvent);
}

/**
 * Build a genuine gift-wrapped rumor of the given kind/content, sealed with
 * `senderIdentity`'s real private key and addressed to `recipientPubHex` —
 * i.e. an authentic NIP-59 envelope indistinguishable (at the transport
 * layer) from a real client's output. Uses the real `sealAndWrap`.
 */
async function buildGiftWrap(params: {
  senderIdentity: ReturnType<typeof makeIdentity>;
  recipientPubHex: string;
  kind: number;
  content: string;
}) {
  return sealAndWrap(
    {
      kind: params.kind,
      content: params.content,
      tags: [['p', params.recipientPubHex]],
      pubkey: params.senderIdentity.pubHex,
      created_at: T0,
      id: 'a'.repeat(64), // placeholder — sealAndWrap/wrapEvent re-derives id+pubkey from the private key
    },
    params.recipientPubHex,
    params.senderIdentity.privHex,
  );
}

function ackContent(nonce: string, card: string): string {
  return JSON.stringify({ type: 'pairing-ack', nonce, card } satisfies PairingAckContent);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  knownPeersState.clear();
  rememberKnownPeersCalls.length = 0;
  rememberPendingContactCalls.length = 0;
  callOrder.length = 0;
  for (const key of Object.keys(contactsState)) delete contactsState[key];
  await clearAllNonces();
  _resetActiveNonceForTests();
  _resetPairingAckAdmissionsForTests();
  clearLocalUserProfile();
});

// ── AC-SEC-3 — kind sentinel isolation ──────────────────────────────────

describe('PAIRING_ACK_KIND (AC-SEC-3)', () => {
  it('does not collide with any reserved sentinel kind', () => {
    expect(PAIRING_ACK_KIND).toBe(21060);
    for (const sentinel of [444, 21059, 5, 7, 14]) {
      expect(PAIRING_ACK_KIND).not.toBe(sentinel);
    }
  });
});

// ── AC-ACK-1 — sendPairingAck rumor shape ───────────────────────────────

describe('sendPairingAck (AC-ACK-1, AC-PRIV-1)', () => {
  it('sends exactly one gift-wrapped kind=PAIRING_ACK_KIND rumor addressed to the issuer, whose decoded card is identity-only and pubkey-matches the sender', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const echoedNonceHex = 'ab'.repeat(16);

    let published: NDKEvent | undefined;
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published = this;
      return new Set() as never;
    });

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex,
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(result).toEqual({
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex,
      result: 'sent',
    });
    expect(NDKEvent.prototype.publish).toHaveBeenCalledTimes(1);
    expect(published).toBeDefined();

    // AC-PRIV-1: the ONLY published event is the kind-1059 gift wrap — never a kind-0.
    const rawWrap = (published as unknown as { rawEvent: () => { kind: number; pubkey: string; tags: string[][] } }).rawEvent();
    expect(rawWrap.kind).toBe(1059);
    expect(rawWrap.kind).not.toBe(0);
    const pTag = rawWrap.tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe(issuer.pubHex);

    // Decode the wrap the way the issuer would, through the REAL codec — the
    // built card is never hand-constructed independently (VQ-S3-009).
    const recoveredRumor = await unwrapAndOpen(rawWrap as never, issuer.privHex);
    expect(recoveredRumor.kind).toBe(PAIRING_ACK_KIND);
    expect(recoveredRumor.pubkey).toBe(scanner.pubHex);

    const content = JSON.parse(recoveredRumor.content) as PairingAckContent;
    expect(content.type).toBe('pairing-ack');
    expect(content.nonce).toBe(echoedNonceHex);

    const decoded = decodeCard(content.card);
    if ('error' in decoded) throw new Error(`card failed to decode: ${decoded.error}`);
    expect(decoded.pubkeyHex).toBe(scanner.pubHex);
    expect(decoded.pairing).toBeUndefined(); // identity-only — no nonce field
    expect(decoded.profile?.nickname).toBe('Bob');
  });

  it('returns "queued-for-retry" (never throws) when the relay publish fails — e.g. offline (AC-SCAN-3 mechanics)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    vi.spyOn(NDKEvent.prototype, 'publish').mockRejectedValue(new Error('offline'));

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex: 'cd'.repeat(16),
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(result.result).toBe('queued-for-retry');
  });

  it('the result.result field is exhaustively "sent" | "queued-for-retry" — no third silent value', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex: 'ef'.repeat(16),
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(['sent', 'queued-for-retry']).toContain(result.result);
  });

  it('throws (does not return "queued-for-retry") on a malformed issuerPubkeyHex — a caller bug, not a transient condition', async () => {
    const scanner = makeIdentity();
    await expect(
      sendPairingAck({
        ndk: {} as never,
        issuerPubkeyHex: 'not-hex',
        echoedNonceHex: 'ab'.repeat(16),
        ownPubkeyHex: scanner.pubHex,
        ownPrivateKeyHex: scanner.privHex,
        ownProfile: { nickname: 'Bob', createdAt: T0 },
        signEvent: scanner.signer.signEvent,
      }),
    ).rejects.toThrow();
  });

  // Mutation-gap closure (Step 5.7): the hex guards are ANCHORED (/^…$/). A
  // 64-hex prefix followed by a trailing character must still be rejected —
  // this kills the "regex anchor removal" mutant that an over-length input
  // would otherwise slip past.
  it('throws on an over-length issuerPubkeyHex (valid 64-hex prefix + trailing char) — anchor is load-bearing', async () => {
    const scanner = makeIdentity();
    await expect(
      sendPairingAck({
        ndk: {} as never,
        issuerPubkeyHex: 'a'.repeat(64) + '0', // 65 chars: valid hex prefix, over length
        echoedNonceHex: 'ab'.repeat(16),
        ownPubkeyHex: scanner.pubHex,
        ownPrivateKeyHex: scanner.privHex,
        ownProfile: { nickname: 'Bob', createdAt: T0 },
        signEvent: scanner.signer.signEvent,
      }),
    ).rejects.toThrow();
  });

  it('throws on an over-length echoedNonceHex (valid 32-hex prefix + trailing char) — anchor is load-bearing', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    await expect(
      sendPairingAck({
        ndk: {} as never,
        issuerPubkeyHex: issuer.pubHex,
        echoedNonceHex: 'ab'.repeat(16) + '0', // 33 chars: valid hex prefix, over length
        ownPubkeyHex: scanner.pubHex,
        ownPrivateKeyHex: scanner.privHex,
        ownProfile: { nickname: 'Bob', createdAt: T0 },
        signEvent: scanner.signer.signEvent,
      }),
    ).rejects.toThrow();
  });

  it('throws (never silently emits an unsigned/nameless echo) when the owner has no shareable name — RD-7 name-set gate, before any publish', async () => {
    // The guard is symmetric to the S4 echo gate: without a shareable name the
    // enclosed card would be nameless and the issuer's handlePairingAck would
    // reject it at the signature step, turning the echo into a silent no-op
    // that still reports 'sent'. Fail loudly at the send source instead.
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    await expect(
      sendPairingAck({
        ndk: {} as never,
        issuerPubkeyHex: issuer.pubHex,
        echoedNonceHex: 'ab'.repeat(16),
        ownPubkeyHex: scanner.pubHex,
        ownPrivateKeyHex: scanner.privHex,
        ownProfile: { nickname: '', createdAt: T0 }, // nameless (DEFAULT_USER_PROFILE)
        signEvent: scanner.signer.signEvent,
      }),
    ).rejects.toThrow();

    // The throw happens before the try/send — nothing is ever published.
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// ── AC-ADMIT-1/2/3 + AC-SEC-1/2 — handlePairingAck core ─────────────────

describe('handlePairingAck', () => {
  it('AC-INBOX-1: the production NDK receiver admits an ack and keeps DM notifications separate', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce();
    const card = await buildIdentityCard(scanner, 'Bob');
    const ack = await buildGiftWrap({
      senderIdentity: scanner, recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND, content: ackContent(minted.nonce, card),
    });
    const invalidAck = await buildGiftWrap({
      senderIdentity: scanner, recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND, content: ackContent('ff'.repeat(16), card),
    });
    const handlers = new Map<number, (event: unknown) => Promise<void>>();
    const stops = [vi.fn(), vi.fn()];
    let subscriptionIndex = 0;
    const ndk = {
      subscribe: (filter: { kinds: number[]; '#p': string[] }) => {
        expect(filter['#p']).toEqual([issuer.pubHex]);
        const stop = stops[subscriptionIndex++];
        return { on: (_name: string, handler: (event: unknown) => Promise<void>) => handlers.set(filter.kinds[0], handler), stop };
      },
    };
    const pendingBell = vi.spyOn(unreadStore, 'incrementPendingContact');
    const dmBell = vi.spyOn(unreadStore, 'incrementDirectMessage');
    const contactChanged = vi.fn();
    const refreshKnownPeers = vi.fn();
    const unsubscribeChanges = subscribeStoreChanged((message) => applyStoreChanged(message, {
      bumpKnownPeers: refreshKnownPeers, bumpBlockedPeers: vi.fn(), bumpContacts: vi.fn(), refreshReactions: vi.fn(),
    }));
    let allowDm = false;
    const stop = subscribeDirectMessageNotifications({
      ndk: ndk as never, ownPubkeyHex: issuer.pubHex, privateKeyHex: issuer.privHex,
      isAllowedSender: () => allowDm, onContactChanged: contactChanged,
    });
    const receive = handlers.get(1059)!;
    expect(receive).toBeDefined();
    await receive(invalidAck);
    expect(knownPeersState.size).toBe(0);
    expect(pendingBell).not.toHaveBeenCalled();
    expect(refreshKnownPeers).not.toHaveBeenCalled();
    await receive(ack);
    expect(callOrder).toEqual(['knownPeers', 'contact']);
    expect(knownPeersState.has(scanner.pubHex)).toBe(true);
    expect(contactsState[scanner.pubHex].pendingConfirmationSince).toBeTruthy();
    expect(pendingBell).toHaveBeenCalledExactlyOnceWith(scanner.pubHex);
    expect(dmBell).not.toHaveBeenCalled();
    expect(contactChanged).toHaveBeenCalledTimes(1);
    expect(refreshKnownPeers).toHaveBeenCalledTimes(1);

    await receive(ack);
    expect(rememberPendingContactCalls).toEqual([scanner.pubHex]);
    expect(pendingBell).toHaveBeenCalledTimes(1);
    expect(dmBell).not.toHaveBeenCalled();

    const dmSender = makeIdentity();
    const dm = await buildGiftWrap({
      senderIdentity: dmSender, recipientPubHex: issuer.pubHex,
      kind: CHAT_MESSAGE_KIND, content: 'hello',
    });
    allowDm = true;
    await receive(dm);
    expect(dmBell).toHaveBeenCalledExactlyOnceWith(dmSender.pubHex);

    stop();
    unsubscribeChanges();
    expect(stops.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  it('AC-ADMIT-1/AC-ADMIT-2: admissible nonce + valid card → admits, calling rememberKnownPeers strictly BEFORE rememberPendingContact (ADR-005)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 60 });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(rememberKnownPeersCalls).toEqual([[scanner.pubHex]]);
    expect(rememberPendingContactCalls).toEqual([scanner.pubHex]);
    // ADR-005: rememberKnownPeers must appear BEFORE rememberPendingContact in the recorded order.
    expect(callOrder).toEqual(['knownPeers', 'contact']);
  });

  it('AC-ADMIT-2: unknown nonce → no admission, no error thrown, real isNonceAdmissible consulted', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const card = await buildIdentityCard(scanner, 'Bob');
    const neverIssuedNonce = 'ff'.repeat(16);
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(neverIssuedNonce, card),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result).toEqual({ status: 'nonce-inadmissible' });
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });

  it('AC-ADMIT-2: nonce past its grace window → no admission, no error thrown, real isNonceAdmissible consulted', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const pastGrace = minted.expiresAt + NONCE_GRACE_SEC + 1;
    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: pastGrace });

    expect(result).toEqual({ status: 'nonce-inadmissible' });
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });

  it('AC-ADMIT-3: two distinct senders echoing the SAME still-admissible nonce are BOTH independently admitted; the nonce is not consumed by the first admission', async () => {
    const issuer = makeIdentity();
    const bob = makeIdentity();
    const carol = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);

    const bobCard = await buildIdentityCard(bob, 'Bob');
    const bobWrap = await buildGiftWrap({
      senderIdentity: bob,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, bobCard),
    });
    const bobResult = await handlePairingAck(bobWrap as never, issuer.privHex, { nowSec: T0 + 10 });
    expect(bobResult).toEqual({ status: 'admitted', senderPubkeyHex: bob.pubHex });

    // The nonce must still be admissible for a second, distinct sender.
    const carolCard = await buildIdentityCard(carol, 'Carol');
    const carolWrap = await buildGiftWrap({
      senderIdentity: carol,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, carolCard),
    });
    const carolResult = await handlePairingAck(carolWrap as never, issuer.privHex, { nowSec: T0 + 20 });
    expect(carolResult).toEqual({ status: 'admitted', senderPubkeyHex: carol.pubHex });

    expect(knownPeersState.has(bob.pubHex)).toBe(true);
    expect(knownPeersState.has(carol.pubHex)).toBe(true);
    expect(rememberPendingContactCalls).toEqual([bob.pubHex, carol.pubHex]);
  });

  it('AC-ACK-3: a second ack from an already-admitted sender is idempotent — no duplicate remember calls, digest count unchanged', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const first = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(first).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(getPairingAckAdmissions().size).toBe(1);

    // Replay — possibly redelivered by a relay, or a genuine second scan.
    const second = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 6 });
    expect(second).toEqual({ status: 'already-admitted', senderPubkeyHex: scanner.pubHex });

    // No duplicate side effects, and the digest source (the SAME map backing
    // the idempotency check, VQ-S3-011) did not grow.
    expect(rememberKnownPeersCalls).toHaveLength(1);
    expect(rememberPendingContactCalls).toHaveLength(1);
    expect(getPairingAckAdmissions().size).toBe(1);
  });

  it('AC-ACK-2: handlePairingAck never constructs or sends a further ack — sealAndWrap is never called as a side effect', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const sealAndWrapSpy = vi.spyOn(directMessagesModule, 'sealAndWrap');
    sealAndWrapSpy.mockClear();

    await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });

    expect(sealAndWrapSpy).not.toHaveBeenCalled();
  });

  it('a rumor of a different kind (e.g. CHAT_MESSAGE_KIND) → "wrong-kind", no admission, falls through for the caller to handle', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: CHAT_MESSAGE_KIND,
      content: JSON.stringify({ type: 'text', text: 'hello' }),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result).toEqual({ status: 'wrong-kind' });
    expect(rememberKnownPeersCalls).toEqual([]);
  });

  it('a gift wrap addressed to a different recipient → "unwrap-failed", falls through, never throws', async () => {
    const issuer = makeIdentity();
    const wrongRecipient = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: wrongRecipient.pubHex, // NOT the issuer
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    await expect(handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 })).resolves.toEqual({
      status: 'unwrap-failed',
    });
    expect(rememberKnownPeersCalls).toEqual([]);
  });

  it('malformed content (not the PairingAckContent shape) → "malformed-content", no admission', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: 'not json at all',
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result).toEqual({ status: 'malformed-content' });
    expect(rememberKnownPeersCalls).toEqual([]);
  });

  it('AC-NONCE-6: processing an ack (any outcome) sweeps a DIFFERENT, unrelated nonce that is already past its grace window (the ack-processing-pass prune trigger)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();

    // A long-dead, unrelated nonce minted far in the past — already past grace.
    _resetActiveNonceForTests();
    const staleNonce = await getOrMintActiveNonce(T0 - 100_000);
    expect(await getStoredNonce(staleNonce.nonce)).toBeDefined();

    // Mint the CURRENT active nonce fresh (simulating a reload) and use it
    // for a genuine, unrelated ack — the prune sweep is a side effect of
    // processing this ack, not of the stale nonce itself.
    _resetActiveNonceForTests();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // T0 is already well past staleNonce.expiresAt + NONCE_GRACE_SEC (the
    // stale nonce was minted 100,000s in the past) — and still comfortably
    // within the freshly-minted nonce's own admissible window, so the ack
    // itself succeeds normally too.
    expect(T0).toBeGreaterThan(staleNonce.expiresAt + NONCE_GRACE_SEC);
    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(result.status).toBe('admitted');

    expect(await getStoredNonce(staleNonce.nonce)).toBeUndefined();
  });

  it('an invalid/tampered enclosed card → "card-invalid", no admission', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const goodCard = await buildIdentityCard(scanner, 'Bob');
    const tamperedCard = goodCard.slice(0, -4) + 'AAAA'; // corrupt the trailing signature bytes
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, tamperedCard),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result).toEqual({ status: 'card-invalid' });
    expect(rememberKnownPeersCalls).toEqual([]);
  });
});

// ── AC-SEC-1/AC-SEC-2 — sender binding (the security-critical negative case) ──

describe('handlePairingAck — sender binding (AC-SEC-1, AC-SEC-2)', () => {
  it('a gift wrap whose enclosed card names pubkey X but is authenticated as sender Y admits NEITHER X nor Y', async () => {
    const issuer = makeIdentity();
    const victim = makeIdentity(); // "X" — a real person whose card got harvested
    const attacker = makeIdentity(); // "Y" — genuinely, independently generated; wraps under their OWN gift-wrap identity
    const minted = await getOrMintActiveNonce(T0);

    // The attacker has somehow obtained (e.g. copied/harvested) the victim's
    // signed identity card — but can only gift-wrap it under their OWN key,
    // because sealAndWrap requires the victim's private key to forge a
    // wrap that would authenticate as the victim, which the attacker does
    // not possess. This is exactly the attack unwrapAndOpen's step 4 closes.
    const victimCard = await buildIdentityCard(victim, 'Victim');
    const forgedWrap = await buildGiftWrap({
      senderIdentity: attacker, // gift-wrap sender is the ATTACKER's real key
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, victimCard), // but the enclosed card claims the VICTIM's identity
    });

    const result = await handlePairingAck(forgedWrap as never, issuer.privHex, { nowSec: T0 + 5 });

    expect(result).toEqual({ status: 'sender-mismatch' });
    // Neither the victim (named in the card) nor the attacker (the
    // authenticated sender) is ever admitted.
    expect(knownPeersState.has(victim.pubHex)).toBe(false);
    expect(knownPeersState.has(attacker.pubHex)).toBe(false);
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });

  it('AC-SEC-2: sender binding is authenticated (unwrapAndOpen), not tautological — swapping ONLY the enclosed card pubkey (self-consistent forged wrap) still fails to admit the forged identity', async () => {
    // A tautological check (e.g. comparing the card's pubkey to a value
    // derived from the SAME untrusted gift wrap rather than the
    // cryptographically authenticated unwrap result) would trivially pass
    // here. The real check must bind to unwrapAndOpen's authenticated
    // rumor.pubkey, which — for THIS wrap — equals the attacker, not the
    // card's claimed identity.
    const issuer = makeIdentity();
    const attacker = makeIdentity();
    const claimedIdentity = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);

    const claimedCard = await buildIdentityCard(claimedIdentity, 'NotTheAttacker');
    const wrap = await buildGiftWrap({
      senderIdentity: attacker,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, claimedCard),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(result.status).toBe('sender-mismatch');
    expect(knownPeersState.size).toBe(0);
  });
});

// ── AC-ADMIT-4/AC-ADMIT-5 — walled-garden bypass + flip ──────────────────

describe('handlePairingAck — walled garden (AC-ADMIT-4, AC-ADMIT-5)', () => {
  it('AC-ADMIT-5: isAllowedDmSender flips false -> true for the admitted sender (real walledGarden.ts, no re-implementation)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Before admission: scanner is a stranger, rejected.
    expect(isAllowedDmSender(scanner.pubHex, [], knownPeersState, issuer.pubHex)).toBe(false);

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(result.status).toBe('admitted');

    // After admission: same real isAllowedDmSender, now true.
    expect(isAllowedDmSender(scanner.pubHex, [], knownPeersState, issuer.pubHex)).toBe(true);
  });
});

// ── AC-PRIV-1 — no unaddressed kind-0, epic-wide invariant ──────────────

describe('AC-PRIV-1 — no public kind-0 anywhere in the pairing-ack send/handle path', () => {
  it('sendPairingAck never publishes a kind-0 event', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const publishedKinds: number[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      publishedKinds.push((this as unknown as { rawEvent: () => { kind: number } }).rawEvent().kind);
      return new Set() as never;
    });

    await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex: 'ab'.repeat(16),
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(publishedKinds).not.toContain(0);
    expect(publishedKinds).toEqual([1059]);
  });

  it('handlePairingAck never publishes anything when the caller omits opts.ndk (the pre-story-06 default)', async () => {
    // Story 06 (AC-PROF-11b) adds an OPTIONAL opts.ndk purely for the
    // issuer-side push-trigger announce (see the dedicated "push trigger"
    // describe block below) — with it omitted (every pre-story-06 call
    // site, and any call that doesn't pass it), this function still cannot
    // reach a relay-publish primitive of any kind, kind-0 or otherwise.
    // A publish spy across the whole run stays untouched regardless of outcome.
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish');
    await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// ── AC-SEC-4 content-shape validation + card-invalid gate (mutation gate) ───
// The wire content of a pairing-ack is attacker-controlled: a peer can send a
// kind-1059 wrap enclosing any JSON. handlePairingAck must reject anything that
// is not a well-formed {type:'pairing-ack', nonce:string, card:string} rumor as
// 'malformed-content' BEFORE it consults the nonce or the card — otherwise a
// hostile sender could reach the admission path with a half-formed payload. The
// existing suite covers the happy path and the security gates but never feeds a
// structurally-broken content object, leaving every clause of the shape guard
// alive under mutation.
describe('handlePairingAck — content-shape rejection (mutation gate)', () => {
  it.each([
    ['a non-object JSON value (number)', '42'],
    ['a JSON null', 'null'],
    ['wrong type discriminator', JSON.stringify({ type: 'not-an-ack', nonce: 'ab'.repeat(16), card: 'x' })],
    ['missing nonce field', JSON.stringify({ type: 'pairing-ack', card: 'x' })],
    ['nonce is not a string', JSON.stringify({ type: 'pairing-ack', nonce: 123, card: 'x' })],
    ['missing card field', JSON.stringify({ type: 'pairing-ack', nonce: 'ab'.repeat(16) })],
    ['card is not a string', JSON.stringify({ type: 'pairing-ack', nonce: 'ab'.repeat(16), card: 999 })],
    ['content is not valid JSON at all', 'this-is-not-json'],
  ])('returns "malformed-content" for %s', async (_label, content) => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content,
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result.status).toBe('malformed-content');
    // A structurally-broken ack never reaches admission.
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });

  it('AC-ADMIT-2: a well-shaped ack echoing an admissible nonce but carrying an undecodable card → "card-invalid" (never admitted)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      // Shape is valid and the nonce is admissible, so the only remaining gate
      // is the enclosed card decoding — which must fail closed here.
      content: ackContent(minted.nonce, 'not-a-real-card'),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 60 });
    expect(result.status).toBe('card-invalid');
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });

  it('AC-ADMIT-2: a well-shaped ack whose card DECODES but carries no profile (an unsigned/nameless bare-pubkey card) → "card-invalid" (never admitted)', async () => {
    // The card-invalid gate must reject on BOTH "failed to decode" AND "decoded
    // but identity-less". An identity-less (unsigned) card decodes successfully
    // yet has no profile — admitting it would pair with a nameless peer. This
    // is the case that distinguishes the two-clause guard from a decode-only
    // check.
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    // Empty nickname → encodeCard emits an UNSIGNED, pubkey-only card (decodes
    // to a profile-less DecodedCard).
    const namelessCard = await buildIdentityCard(scanner, '');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, namelessCard),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 60 });
    expect(result.status).toBe('card-invalid');
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });
});

// ── Mutation-gate: opts default handling + outer catch fallback ────────────
// Two Stryker-surfaced gaps in handlePairingAck's boundary behavior that the
// existing suite never exercised: (1) EVERY prior test passed a non-null `opts`,
// leaving the `opts?.nowSec` / `opts?.ndk` optional-chaining guards alive under
// mutation — a caller that omits `opts` entirely (documented as supported: "so
// existing call sites that have not yet been updated to pass their own ndk keep
// working unchanged") must still admit normally without publishing; (2) no test
// forced an unexpected throw past the inner try/catches into the function's
// outer catch, leaving the whole `catch (err) { … return { status: 'malformed-
// content' } }` fallback (block, returned object, and status string) alive.
// Together these two tests kill mutants 89 / 123 / 139 / 141 / 142.
describe('handlePairingAck — opts omission + outer-catch fallback (mutation gate)', () => {
  it('admits normally when opts is omitted entirely — opts?.nowSec falls through to Date.now(), opts?.ndk falls through to no-push', async () => {
    // Both `opts?.nowSec` (Step 4) and `opts?.ndk` (Step 10) are guarded with
    // optional chaining precisely because the whole `opts` object is optional
    // (per the function signature and its doc comment). Under Stryker, replacing
    // either chain with a plain member access (`opts.nowSec` / `opts.ndk`)
    // throws when `opts` is undefined, which the outer catch would then convert
    // to 'malformed-content'. An admissible ack called WITHOUT opts must
    // therefore still return 'admitted', with no publish attempted (no ndk).
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    // Mint the nonce relative to REAL time (Date.now()) — the omitted opts.nowSec
    // means handlePairingAck uses Date.now() itself, so the nonce must be
    // admissible in that timeframe, not at T0.
    const nowSec = Math.floor(Date.now() / 1000);
    const minted = await getOrMintActiveNonce(nowSec);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    // No third argument at all — this is the "opts omitted" call shape.
    const result = await handlePairingAck(wrap as never, issuer.privHex);

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    // No ndk supplied → the Step 10 push-announce block is skipped, so no
    // publish ever happens on this path.
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("returns 'malformed-content' (never rejects, never admits) when a downstream primitive throws unexpectedly — the outer catch fallback", async () => {
    // Steps 1-3 have their own inner try/catches, but Steps 4-11 rely on the
    // function's outer `try { … } catch (err) { … return { status: 'malformed-
    // content' } }` as the last line of defense. Under Stryker, emptying that
    // catch (BlockStatement mutation) makes the function resolve to `undefined`
    // instead of the documented `HandlePairingAckResult`; mutating the returned
    // object or its `'malformed-content'` string yields other observable
    // divergences. Force an unexpected throw at Step 4 (pruneExpiredNonces) —
    // the earliest reachable Step-4+ primitive — so the outer catch is the ONLY
    // thing between the caller and an uncaught rejection / a shape-broken result.
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    vi.spyOn(nonceStoreModule, 'pruneExpiredNonces').mockRejectedValueOnce(
      new Error('nonce-store IO failure (simulated)'),
    );

    // Never rejects, never admits — exact shape must be `{ status: 'malformed-content' }`.
    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(result).toEqual({ status: 'malformed-content' });
    // The throw happens at Step 4, BEFORE Step 9's admission side effects, so
    // neither remember-primitive is called.
    expect(rememberKnownPeersCalls).toEqual([]);
    expect(rememberPendingContactCalls).toEqual([]);
  });
});

// ── Push triggers (epic: direct-contact-profile-exchange, story 06, AC-PROF-11b) ──
// "Announce-on-pair": both admission points additionally fire an immediate
// `dmProfile/send.ts#sendProfileAnnounce` gift wrap to the freshly-paired
// contact. Real send.ts is exercised (not mocked) so a privacy regression —
// e.g. a signed kind-0, or a wrap addressed to the wrong recipient — would
// fail these tests, mirroring this file's existing AC-PRIV-1 discipline.

describe('sendPairingAck — push trigger, scanner side (AC-PROF-11b)', () => {
  it('also fires an immediate profile-announce to the issuer when the scanner has a shareable local profile cached', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const echoedNonceHex = 'ab'.repeat(16);
    setLocalUserProfile({ nickname: 'Bob', avatar: { imageUrl: 'https://example.test/a.png' } });

    const published: NDKEvent[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published.push(this);
      return new Set() as never;
    });

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex,
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(result.result).toBe('sent');
    // Exactly two gift wraps: the pairing-ack itself, then the push-trigger announce.
    expect(published).toHaveLength(2);

    const announceWrap = (published[1] as unknown as { rawEvent: () => { kind: number; pubkey: string; tags: string[][] } }).rawEvent();
    expect(announceWrap.kind).toBe(1059);
    expect(announceWrap.kind).not.toBe(0); // AC-PRIV-1: never an unaddressed kind-0
    const pTag = announceWrap.tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe(issuer.pubHex);

    const recoveredRumor = await unwrapAndOpen(announceWrap as never, issuer.privHex);
    expect(recoveredRumor.kind).toBe(DM_PROFILE_ANNOUNCE_KIND);
    expect(recoveredRumor.pubkey).toBe(scanner.pubHex);

    const parsed = parseProfileAnnounce(recoveredRumor.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.nickname).toBe('Bob');
    }
  });

  it('does not attempt a second publish when the scanner has no shareable local profile cached (readUserProfile default → sendProfileAnnounce\'s zero-I/O nameless gate)', async () => {
    clearLocalUserProfile();
    const published: unknown[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function () {
      published.push(1);
      return new Set() as never;
    });
    const issuer = makeIdentity();
    const scanner = makeIdentity();

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex: 'ef'.repeat(16),
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(result.result).toBe('sent');
    expect(published).toHaveLength(1); // only the ack itself
  });

  it('a failed announce publish never turns a successfully-sent ack into "queued-for-retry"', async () => {
    setLocalUserProfile({ nickname: 'Bob', avatar: null });
    let callCount = 0;
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function () {
      callCount += 1;
      if (callCount === 2) throw new Error('announce publish failed (e.g. offline)');
      return new Set() as never;
    });
    const issuer = makeIdentity();
    const scanner = makeIdentity();

    const result = await sendPairingAck({
      ndk: {} as never,
      issuerPubkeyHex: issuer.pubHex,
      echoedNonceHex: 'cd'.repeat(16),
      ownPubkeyHex: scanner.pubHex,
      ownPrivateKeyHex: scanner.privHex,
      ownProfile: { nickname: 'Bob', createdAt: T0 },
      signEvent: scanner.signer.signEvent,
    });

    expect(result.result).toBe('sent');
    expect(callCount).toBe(2); // the announce WAS attempted, and it did fail
  });
});

describe('handlePairingAck — push trigger, issuer side (AC-PROF-11b)', () => {
  it('fires an immediate profile-announce to the freshly-admitted sender when opts.ndk + a shareable local profile are both available', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const published: NDKEvent[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published.push(this);
      return new Set() as never;
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });
    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(published).toHaveLength(1);

    const announceWrap = (published[0] as unknown as { rawEvent: () => { kind: number; pubkey: string; tags: string[][] } }).rawEvent();
    expect(announceWrap.kind).toBe(1059);
    expect(announceWrap.kind).not.toBe(0); // AC-PRIV-1
    const pTag = announceWrap.tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe(scanner.pubHex);

    // Decoded by the SCANNER (the announce's addressed recipient), authored
    // by the ISSUER (rumor.pubkey === issuer, derived from ownPrivateKeyHex).
    const recoveredRumor = await unwrapAndOpen(announceWrap as never, scanner.privHex);
    expect(recoveredRumor.kind).toBe(DM_PROFILE_ANNOUNCE_KIND);
    expect(recoveredRumor.pubkey).toBe(issuer.pubHex);

    const parsed = parseProfileAnnounce(recoveredRumor.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.nickname).toBe('Alice');
    }
  });

  it('does not re-fire an announce on an already-admitted replay, even with opts.ndk provided', async () => {
    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const published: unknown[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function () {
      published.push(1);
      return new Set() as never;
    });
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const first = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });
    expect(first.status).toBe('admitted');
    expect(published).toHaveLength(1);

    const second = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 6, ndk: {} as never });
    expect(second).toEqual({ status: 'already-admitted', senderPubkeyHex: scanner.pubHex });
    expect(published).toHaveLength(1); // unchanged — no re-fire on replay
  });

  it('a failed announce publish never affects the returned "admitted" result', async () => {
    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    vi.spyOn(NDKEvent.prototype, 'publish').mockRejectedValue(new Error('offline'));
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });
    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
  });

  it('still does not publish anything when opts.ndk is omitted, even with a shareable local profile cached (opts.ndk is the sole gate)', async () => {
    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish');
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(result.status).toBe('admitted');
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// ── §10.1 name-drop fix (epic: direct-contact-profile-exchange, story 07, ──
// AC-CARD-1). Before this fix, handlePairingAck's admission path called
// rememberKnownPeers/rememberContact but silently discarded decoded.profile,
// so the issuer never persisted the scanner's submitted name. contactCache.ts
// is NOT mocked in this file — these tests exercise the real
// writeContactEntryNeutralized/readContactEntry seam (story 04) through the
// real decodeCard round trip, so a fix that never threads the real decoded
// name through (or a silent revert) would fail here.

describe('handlePairingAck — §10.1 name-drop fix (AC-CARD-1)', () => {
  it('persists the scanner\'s submitted name into contactCache after admission, using a real decoded value distinct from any placeholder default', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const scannerName = 'Zzyxw-Distinctive-Name-42';
    const card = await buildIdentityCard(scanner, scannerName);
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Before admission: no cache entry at all for the scanner.
    expect(readContactEntry(scanner.pubHex)).toBeUndefined();

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 60 });
    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });

    const cached = readContactEntry(scanner.pubHex);
    expect(cached).toBeDefined();
    expect(cached?.nickname).toBe(scannerName);
    // updatedAt derives from the card's own created_at (T0), never a
    // wall-clock answer-time stamp — spec §10.1's §B2-safety clause.
    expect(cached?.updatedAt).toBe(new Date(T0 * 1000).toISOString());
  });

  it('preserves a pre-existing contactCache avatar (a name-only import must never null it out)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Carol');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Seed a pre-existing cache entry with an avatar and an OLDER updatedAt,
    // so this ack's card (timestamped T0) still wins LWW.
    writeContactEntryNeutralized(scanner.pubHex, {
      nickname: 'stale-name',
      avatar: { imageUrl: 'https://example.test/existing.png' },
      updatedAt: new Date((T0 - 1000) * 1000).toISOString(),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 60 });
    expect(result.status).toBe('admitted');

    const cached = readContactEntry(scanner.pubHex);
    expect(cached?.nickname).toBe('Carol');
    expect(cached?.avatar).toEqual({ imageUrl: 'https://example.test/existing.png' });
  });

  it("still fires story 06's announce-on-pair AND persists the name in the SAME admission (additive fix, not a revert of story 06)", async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const scannerName = 'Dave';
    const card = await buildIdentityCard(scanner, scannerName);
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const published: NDKEvent[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published.push(this);
      return new Set() as never;
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });
    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });

    // Story 06's announce still fires (not reordered/removed by this story).
    expect(published).toHaveLength(1);
    const announceWrap = (published[0] as unknown as { rawEvent: () => { kind: number } }).rawEvent();
    expect(announceWrap.kind).toBe(1059);

    // Story 07's name persistence also happened, in the SAME admission.
    const cached = readContactEntry(scanner.pubHex);
    expect(cached?.nickname).toBe(scannerName);
  });

  it('does not persist (or corrupt) the cached name a second time on an already-admitted replay', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Eve');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    const first = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });
    expect(first.status).toBe('admitted');
    const cachedAfterFirst = readContactEntry(scanner.pubHex);
    expect(cachedAfterFirst?.nickname).toBe('Eve');

    const second = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 6 });
    expect(second).toEqual({ status: 'already-admitted', senderPubkeyHex: scanner.pubHex });

    const cachedAfterSecond = readContactEntry(scanner.pubHex);
    expect(cachedAfterSecond).toEqual(cachedAfterFirst); // unchanged by the replay
  });

  it('does not persist any name on a non-admitted outcome (nonce-inadmissible)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const card = await buildIdentityCard(scanner, 'Frank');
    const neverIssuedNonce = 'aa'.repeat(16);
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(neverIssuedNonce, card),
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 });
    expect(result.status).toBe('nonce-inadmissible');
    expect(readContactEntry(scanner.pubHex)).toBeUndefined();
  });
});

// ── Gate-remediation finding 1 (2026-07-14): blocked-sender privacy gate ────
// Outbound signals (profile-announce, name-cache write) fired from Steps
// 10/11 of a fresh admission must never reach a sender who is already a
// blocked peer (StoredContact.archivedAt set) — spec §7 "blocked peer
// receives no signal", DD-2 "full cut-off, both directions". Admission
// itself (Step 9, ADR-005 ordering) is unaffected either way — nonce
// possession alone is the pre-existing re-admission decision, and Step 9
// deliberately preserves archivedAt rather than clearing it.

describe('handlePairingAck — privacy gate for a blocked re-pairing sender (gate-remediation finding 1)', () => {
  it('admits a re-pairing sender who is already blocked (keeps archivedAt), but sends NO profile-announce and caches NO name', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Blocked-Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Seed the sender as an already-blocked contact (as if the issuer had
    // previously added, then blocked, this peer).
    const blockedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    contactsState[scanner.pubHex] = {
      pubkeyHex: scanner.pubHex,
      firstSeenAt: blockedAt,
      lastSeenAt: blockedAt,
      archivedAt: blockedAt,
    };

    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const publishSpy = vi.spyOn(NDKEvent.prototype, 'publish').mockResolvedValue(new Set() as never);

    // opts.ndk provided so, absent the fix, Step 10 WOULD attempt a publish.
    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });

    // Admission (Step 9) is unaffected — the re-pairing sender is still
    // admitted, and rememberKnownPeers/rememberPendingContact both still ran.
    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(rememberKnownPeersCalls).toEqual([[scanner.pubHex]]);
    expect(rememberPendingContactCalls).toEqual([scanner.pubHex]);
    // archivedAt is PRESERVED, never cleared by admission.
    expect(contactsState[scanner.pubHex].archivedAt).toBe(blockedAt);

    // Step 10: no outbound gift-wrapped profile-announce to the blocked sender.
    expect(publishSpy).not.toHaveBeenCalled();

    // Step 11: no name/avatar persisted into contactCache from this sender.
    expect(readContactEntry(scanner.pubHex)).toBeUndefined();
  });

  it('control: an UNBLOCKED re-pairing sender is unaffected by the new gate — announce fires and the name is cached, exactly as before', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Unblocked-Carol');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const published: NDKEvent[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published.push(this);
      return new Set() as never;
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(published).toHaveLength(1);
    expect(readContactEntry(scanner.pubHex)?.nickname).toBe('Unblocked-Carol');
  });
});

// ── Epic: pending-contact-confirmation, S1 — issuer-side admission gains a
// pending-confirmation state (AC-ADMIT-1, AC-ADMIT-2, AC-SEC-1). Direct
// template: the "privacy gate for a blocked re-pairing sender" block above.
// Step 9 now calls `rememberPendingContact` (mocked above) instead of
// `rememberContact` — these tests assert the resulting `pendingConfirmationSince`
// state on the admitted entry, both for a brand-new sender and a re-pairing one.

describe('handlePairingAck — pending-confirmation admission (epic: pending-contact-confirmation, AC-ADMIT-1)', () => {
  it('AC-ADMIT-1: admitting a brand-new sender (no prior StoredContact entry) sets pendingConfirmationSince to a non-null timestamp', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Fresh-Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // No prior entry for this sender.
    expect(contactsState[scanner.pubHex]).toBeUndefined();

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(rememberPendingContactCalls).toEqual([scanner.pubHex]);
    expect(contactsState[scanner.pubHex].pendingConfirmationSince).toBeTruthy();
    expect(typeof contactsState[scanner.pubHex].pendingConfirmationSince).toBe('string');
  });
});

describe('handlePairingAck — pending-confirmation re-pairing preservation (epic: pending-contact-confirmation, AC-ADMIT-2)', () => {
  it('AC-ADMIT-2: re-pairing a sender whose pendingConfirmationSince was previously null leaves it null (never sets it non-null)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Already-Confirmed-Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Seed the sender as an already-CONFIRMED contact (as if a prior
    // handlePairingAck admission had already been confirmed by the user).
    const seededAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    contactsState[scanner.pubHex] = {
      pubkeyHex: scanner.pubHex,
      firstSeenAt: seededAt,
      lastSeenAt: seededAt,
      archivedAt: null,
      pendingConfirmationSince: null,
    };

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    expect(rememberPendingContactCalls).toEqual([scanner.pubHex]);
    // Still null — a re-pairing MUST NOT flip a confirmed contact back to pending.
    expect(contactsState[scanner.pubHex].pendingConfirmationSince).toBeNull();
    // lastSeenAt IS bumped, exactly like an ordinary re-pairing.
    expect(contactsState[scanner.pubHex].lastSeenAt).not.toBe(seededAt);
  });

  it('AC-ADMIT-2: re-pairing a sender who is already pending leaves pendingConfirmationSince exactly as it was (never clears it)', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Still-Pending-Bob');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    // Seed the sender as already PENDING from an earlier admission.
    const firstAdmittedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    contactsState[scanner.pubHex] = {
      pubkeyHex: scanner.pubHex,
      firstSeenAt: firstAdmittedAt,
      lastSeenAt: firstAdmittedAt,
      archivedAt: null,
      pendingConfirmationSince: firstAdmittedAt,
    };

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5 });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    // pendingConfirmationSince is exactly the ORIGINAL admission timestamp,
    // not bumped/replaced by this second pairing-ack.
    expect(contactsState[scanner.pubHex].pendingConfirmationSince).toBe(firstAdmittedAt);
  });
});

describe('handlePairingAck — AC-SEC-1: pending state never gates Steps 10-11 (epic: pending-contact-confirmation)', () => {
  it('a brand-new (freshly-pending) sender still gets the profile-announce publish AND the name-drop cache write, identically to a normal admission', async () => {
    const issuer = makeIdentity();
    const scanner = makeIdentity();
    const minted = await getOrMintActiveNonce(T0);
    const card = await buildIdentityCard(scanner, 'Pending-But-Unblocked-Dana');
    const wrap = await buildGiftWrap({
      senderIdentity: scanner,
      recipientPubHex: issuer.pubHex,
      kind: PAIRING_ACK_KIND,
      content: ackContent(minted.nonce, card),
    });

    setLocalUserProfile({ nickname: 'Alice', avatar: null });
    const published: NDKEvent[] = [];
    vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
      published.push(this);
      return new Set() as never;
    });

    const result = await handlePairingAck(wrap as never, issuer.privHex, { nowSec: T0 + 5, ndk: {} as never });

    expect(result).toEqual({ status: 'admitted', senderPubkeyHex: scanner.pubHex });
    // The admitted entry IS pending...
    expect(contactsState[scanner.pubHex].pendingConfirmationSince).toBeTruthy();
    // ...but Step 10 (profile-announce) and Step 11 (name-drop cache write)
    // fired exactly as they would for any other fresh, unblocked admission —
    // no new gate on pending state was introduced at these call sites, and
    // no kind-0 was published (AC-SEC-1's "no public metadata" half).
    expect(published).toHaveLength(1);
    const announceWrap = (published[0] as unknown as { rawEvent: () => { kind: number } }).rawEvent();
    expect(announceWrap.kind).not.toBe(0);
    expect(readContactEntry(scanner.pubHex)?.nickname).toBe('Pending-But-Unblocked-Dana');
  });

  it('confirmContact is never imported/called by pairingAck.ts — admission and confirmation are separate primitives, so nothing here can trigger a kind-0 publish on confirm either', () => {
    // Structural guard (AC-SEC-1's second half — confirmContact never
    // publishes kind-0). pairingAck.ts's own admission path never imports
    // confirmContact at all; confirmContact's own kind-0-freedom is covered
    // directly by contacts.ts's implementation (it never imports any
    // Nostr-publish-capable module) and by contacts.test.ts's unit coverage.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/lib/pairing/pairingAck.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/confirmContact/);
  });
});
