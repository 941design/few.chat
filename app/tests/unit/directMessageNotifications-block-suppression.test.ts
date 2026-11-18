/**
 * Unit tests for the block-contact epic's inbound-suppression story (S2).
 * Covers AC-INBOUND-1, AC-INBOUND-2, AC-INBOUND-3, AC-UNBLOCK-3.
 *
 * `subscribeDirectMessageNotifications` (directMessageNotifications.ts) was NOT
 * modified by this story — it already gates both the kind-4 and kind-1059
 * handlers on the injected `isAllowedSender` callback strictly before
 * `rememberContact`/`incrementDirectMessage` (a pre-existing seam from an
 * earlier epic, exercised generically by directMessageNotifications.test.ts).
 * This story's actual change is `isAllowedDmSenderComposite`, the shared pure
 * export from `@/src/lib/blockedPeers` (rehomed there so `ContactChat`'s S4
 * ingestion sites and this watcher consume the SAME single definition, rather
 * than each composing `isAllowedDmSender(...) && !isBlockedPeer(...)` inline)
 * that composes `isAllowedDmSender(...) && !isBlockedPeer(...)` (DD-8) —
 * imported here directly (not re-implemented) so these tests exercise the
 * REAL production wiring, not a hand-rolled stand-in.
 *
 * Conventions:
 *   - Real `contacts.ts` (unmocked) + a hand-rolled localStorage mock
 *     (mirrors blockedPeers.test.ts / receive.test.ts) so `lastSeenAt` and
 *     `archivedAt` are genuinely observable, not hidden behind a stub.
 *   - `unreadStore` and `directMessages#unwrapAndOpen` are mocked (mirrors
 *     directMessageNotifications.test.ts) — these are cross-cutting concerns
 *     unrelated to the block predicate.
 *   - No jsdom/@testing-library/renderHook (project convention) — the React
 *     component's wiring is proven via (a) the real pure
 *     `isAllowedDmSenderComposite` export and (b) source-string assertions on
 *     the watcher file, mirroring ProfileHealWatcher.test.ts's AC-WATCH-2
 *     pattern for the parts that are genuinely React-effect-shaped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '@/src/types';

// ── localStorage mock (contacts.ts's real persistence path) ────────────────

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Fake NDK subscription infrastructure (mirrors directMessageNotifications.test.ts) ─

type FakeSub = {
  id: string;
  filter: object;
  handlers: Array<(ev: object) => void>;
  stop: () => void;
  on: (event: string, handler: (ev: object) => void) => void;
};
type FakeNdk = { subscribe: (filter: object) => FakeSub };

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
        on(event: string, handler: (ev: object) => void) { this.handlers.push(handler); },
      };
      subs.push(sub);
      return sub;
    },
  } as FakeNdk & { subs: FakeSub[] };
  return ndk;
}

async function emitEvent(sub: FakeSub, event: object) {
  await Promise.all(sub.handlers.map(async (handler) => {
    const result = handler(event);
    if (result instanceof Promise) await result;
  }));
}

function kind4Sub(ndk: { subs: FakeSub[] }) {
  return ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[4]'))!;
}
function kind1059Sub(ndk: { subs: FakeSub[] }) {
  return ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[1059]'))!;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const OWN_PRIV = 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d';
const OWN_PUB = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

// ── Mocks (unreadStore + directMessages unwrap only — contacts.ts stays real) ─

vi.mock('@/src/lib/directMessages', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/directMessages')>('@/src/lib/directMessages');
  return {
    ...mod,
    unwrapAndOpen: vi.fn<() => Promise<import('@/src/lib/directMessages').UnsignedRumor>>(),
  };
});

// Partial mock (spread the real module) rather than a total replace: this file
// also imports DirectMessageNotificationsWatcher, which imports
// `initDirectMessageCounts` from here. A total mock leaves that export
// undefined and only survives because nothing touches it — it would start
// throwing the moment the watcher referenced it at module scope. Mirrors the
// directMessages mock above.
vi.mock('@/src/lib/unreadStore', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/unreadStore')>('@/src/lib/unreadStore');
  return {
    ...mod,
    getDirectMessageLastReadAt: vi.fn(() => 0),
    incrementDirectMessage: vi.fn(),
  };
});

const { unwrapAndOpen } = await import('@/src/lib/directMessages');
const { incrementDirectMessage } = await import('@/src/lib/unreadStore');
const { subscribeDirectMessageNotifications } = await import('@/src/lib/directMessageNotifications');
const { rememberContact, readStoredContacts, archiveContact, unarchiveContact, rememberPendingContact, confirmContact } = await import('@/src/lib/contacts');
const { buildInitDirectMessagePeerList } = await import('@/src/components/DirectMessageNotificationsWatcher');
const { isAllowedDmSenderComposite, loadBlockedPeers } = await import('@/src/lib/blockedPeers');
const { rememberKnownPeers } = await import('@/src/lib/knownPeers');

const EMPTY_GROUPS: ReadonlyArray<Group> = [];

beforeEach(() => {
  localStorageMock.clear();
  vi.mocked(unwrapAndOpen).mockReset();
  vi.mocked(incrementDirectMessage).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isAllowedDmSenderComposite — pure, deny-overrides-allow (DD-8) ─────────

describe('isAllowedDmSenderComposite — deny overrides allow (DD-8)', () => {
  it('a known peer who is also blocked evaluates to false', () => {
    const knownPeers = new Set([PEER]);
    const blockedPeers = new Set([PEER]);
    expect(isAllowedDmSenderComposite(PEER, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB)).toBe(false);
  });

  it('an allowed, non-blocked peer passes', () => {
    const knownPeers = new Set([PEER]);
    const blockedPeers = new Set<string>();
    expect(isAllowedDmSenderComposite(PEER, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB)).toBe(true);
  });

  it('a stranger who happens to be in blockedPeers (already denied by isAllowedDmSender alone) still evaluates to false', () => {
    const blockedPeers = new Set([PEER]);
    expect(isAllowedDmSenderComposite(PEER, EMPTY_GROUPS, new Set(), blockedPeers, OWN_PUB)).toBe(false);
  });
});

// ── AC-INBOUND-1 — kind-4 suppression before rememberContact/incrementDirectMessage ─

describe('AC-INBOUND-1 — kind-4 handler suppresses a blocked sender', () => {
  it('a blocked peer\'s kind-4 event does not call rememberContact/incrementDirectMessage, and lastSeenAt is unchanged', async () => {
    rememberKnownPeers([PEER]);
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    archiveContact(PEER);
    const preEventLastSeenAt = readStoredContacts()[PEER].lastSeenAt;

    const rememberSpy = vi.spyOn(await import('@/src/lib/contacts'), 'rememberContact');

    const ndk = makeFakeNdk();
    const blockedPeers = loadBlockedPeers();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => isAllowedDmSenderComposite(peer, EMPTY_GROUPS, loadKnownPeersSnapshot(), blockedPeers, OWN_PUB),
    });

    await emitEvent(kind4Sub(ndk), { id: 'blocked-kind4', pubkey: PEER, created_at: 1_800_000_000 });

    expect(rememberSpy).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
    expect(readStoredContacts()[PEER].lastSeenAt).toBe(preEventLastSeenAt);
  });
});

// ── AC-INBOUND-2 — kind-1059 suppression, symmetric ─────────────────────────

describe('AC-INBOUND-2 — kind-1059 handler suppresses a blocked sender', () => {
  it('a blocked peer\'s unwrapped rumor does not call rememberContact/incrementDirectMessage, and lastSeenAt is unchanged', async () => {
    rememberKnownPeers([PEER]);
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    archiveContact(PEER);
    const preEventLastSeenAt = readStoredContacts()[PEER].lastSeenAt;

    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'blocked-rumor-id',
      pubkey: PEER,
      kind: 14,
      content: 'hello from a blocked peer',
      tags: [['p', OWN_PUB]],
      created_at: 1_800_000_000,
    });

    const rememberSpy = vi.spyOn(await import('@/src/lib/contacts'), 'rememberContact');

    const ndk = makeFakeNdk();
    const blockedPeers = loadBlockedPeers();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => isAllowedDmSenderComposite(peer, EMPTY_GROUPS, loadKnownPeersSnapshot(), blockedPeers, OWN_PUB),
    });

    await emitEvent(kind1059Sub(ndk), { id: 'wrap-blocked', kind: 1059, pubkey: 'ephemeral' });

    expect(rememberSpy).not.toHaveBeenCalled();
    expect(incrementDirectMessage).not.toHaveBeenCalled();
    expect(readStoredContacts()[PEER].lastSeenAt).toBe(preEventLastSeenAt);
  });
});

// ── AC-INBOUND-3 / VQ-S2-006 — live ref, no unmount/remount ────────────────

describe('AC-INBOUND-3 — a peer blocked mid-session is suppressed on the very next event, without unmount/remount', () => {
  it('kind-4: accepted before block, suppressed on the next event after block — same subscription throughout', async () => {
    rememberKnownPeers([PEER]);
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');

    // Simulates the watcher's blockedPeersRef: a single mutable binding that
    // the injected isAllowedSender closure re-reads on every call, exactly
    // like DirectMessageNotificationsWatcher.tsx's `blockedPeersRef.current`.
    let blockedPeersRefCurrent = loadBlockedPeers();

    const ndk = makeFakeNdk();
    // ONE subscribeDirectMessageNotifications call for the whole test — proves
    // no unmount/remount is needed to pick up the block.
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => isAllowedDmSenderComposite(peer, EMPTY_GROUPS, loadKnownPeersSnapshot(), blockedPeersRefCurrent, OWN_PUB),
    });

    // Before block: event is accepted.
    await emitEvent(kind4Sub(ndk), { id: 'pre-block', pubkey: PEER, created_at: 1_800_000_000 });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);

    // Block the peer WHILE the watcher stays mounted, then refresh the ref
    // (mirrors the watcher's useEffect refresh on blockedPeersRevision bump).
    archiveContact(PEER);
    blockedPeersRefCurrent = loadBlockedPeers();

    // Same subscription, next event from the same peer: must now be suppressed.
    await emitEvent(kind4Sub(ndk), { id: 'post-block', pubkey: PEER, created_at: 1_800_000_100 });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1); // unchanged — still 1
  });
});

// ── AC-UNBLOCK-3 — post-unblock resume ──────────────────────────────────────

describe('AC-UNBLOCK-3 — after unblock, the next inbound DM is persisted and increments the bell', () => {
  it('kind-4: blocked → suppressed, unblocked → next event from the same peer rings the bell and updates lastSeenAt', async () => {
    rememberKnownPeers([PEER]);
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    archiveContact(PEER);

    let blockedPeersRefCurrent = loadBlockedPeers();
    const ndk = makeFakeNdk();
    subscribeDirectMessageNotifications({
      ndk: ndk as unknown as any,
      ownPubkeyHex: OWN_PUB,
      privateKeyHex: OWN_PRIV,
      isAllowedSender: (peer) => isAllowedDmSenderComposite(peer, EMPTY_GROUPS, loadKnownPeersSnapshot(), blockedPeersRefCurrent, OWN_PUB),
    });

    // Still blocked: suppressed.
    await emitEvent(kind4Sub(ndk), { id: 'still-blocked', pubkey: PEER, created_at: 1_800_000_000 });
    expect(incrementDirectMessage).not.toHaveBeenCalled();

    // Unblock, refresh the ref.
    unarchiveContact(PEER);
    blockedPeersRefCurrent = loadBlockedPeers();

    const beforeEventMs = Date.now();
    await emitEvent(kind4Sub(ndk), { id: 'after-unblock', pubkey: PEER, created_at: 1_800_000_200 });
    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    const contact = readStoredContacts()[PEER];
    expect(contact.archivedAt).toBeNull();
    // rememberContact stamps lastSeenAt with real wall-clock time (it does not
    // take the event's created_at) — assert it advanced past the pre-2021
    // seed value to the current call, proving rememberContact actually ran.
    expect(new Date(contact.lastSeenAt).getTime()).toBeGreaterThanOrEqual(beforeEventMs);
  });
});

/** Mirrors the watcher's knownPeersRef pattern within these tests (no MarmotContext dependency needed). */
function loadKnownPeersSnapshot(): ReadonlySet<string> {
  // knownPeers isn't the axis under test here — an always-allow-via-knownPeers
  // set keeps isAllowedDmSender's own half of the composite passing so the
  // tests isolate the block predicate's effect (deny overrides allow, per
  // AC-CORE-3), matching the composite's real deny-overrides-allow contract.
  return new Set([PEER]);
}

// ── Source-wiring assertions (mirrors ProfileHealWatcher.test.ts's AC-WATCH-2) ─
// Proves the React-effect-shaped wiring this repo's no-renderHook convention
// can't otherwise exercise: the block-set ref exists, refreshes on the right
// dependency array, and the main subscription effect is NOT rebuilt on a
// block-revision bump.

describe('DirectMessageNotificationsWatcher.tsx — block-set ref wiring (source assertions)', () => {
  const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..'); // app/tests/unit -> app/
  const WATCHER_SOURCE = fs.readFileSync(
    path.join(APP_ROOT, 'src', 'components', 'DirectMessageNotificationsWatcher.tsx'),
    'utf8',
  );

  it('imports isBlockedPeer/loadBlockedPeers from blockedPeers.ts and reads blockedPeersRevision from useMarmot()', () => {
    expect(WATCHER_SOURCE).toMatch(/from ['"]@\/src\/lib\/blockedPeers['"]/);
    expect(WATCHER_SOURCE).toMatch(/blockedPeersRevision/);
  });

  it('declares a blockedPeersRef initialized from loadBlockedPeers()', () => {
    expect(WATCHER_SOURCE).toMatch(/blockedPeersRef\s*=\s*useRef\(loadBlockedPeers\(\)\)/);
  });

  it('refreshes blockedPeersRef in a useEffect keyed on [groups, knownPeersRevision, blockedPeersRevision]', () => {
    expect(WATCHER_SOURCE).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*blockedPeersRef\.current\s*=\s*loadBlockedPeers\(\);\s*\},\s*\[groups,\s*knownPeersRevision,\s*blockedPeersRevision\]\)/,
    );
  });

  it('the injected isAllowedSender closure passed to subscribeDirectMessageNotifications reads blockedPeersRef.current', () => {
    expect(WATCHER_SOURCE).toMatch(/isAllowedDmSenderComposite\(\s*peer,\s*getDmGroups\(\),\s*knownPeersRef\.current,\s*blockedPeersRef\.current,/);
  });

  it('the subscription-owning effect\'s dependency array does NOT include blockedPeersRevision (no teardown/rebuild on block change)', () => {
    const dependencies = WATCHER_SOURCE.match(/\},\s*\[hydrated,\s*pubkeyHex,\s*privateKeyHex,([^\]]*)\]\);/)?.[1];
    expect(dependencies).toContain('getDmGroups');
    expect(dependencies).toContain('whenDmGroupsReady');
    expect(dependencies).not.toMatch(/blockedPeersRevision|blockedPeersRef/);
  });
});

// ── buildInitDirectMessagePeerList — startup batch-scan peer list. The
// pending-contact exclusion deliberately does NOT live here: it lives inside
// `initDirectMessageCounts`, the entrypoint that owns the `directMessages`
// slice, so the bell cannot light for an unconfirmed pairing no matter what a
// caller passes in (see unreadStore.test.ts for that coverage).

describe('buildInitDirectMessagePeerList', () => {
  const OWN = 'e1'.repeat(32);
  const CONFIRMED_PEER = 'e2'.repeat(32);
  const PENDING_PEER = 'e3'.repeat(32);

  beforeEach(() => {
    localStorageMock.clear();
  });

  it('excludes the local user\'s own pubkey', () => {
    rememberContact(OWN, '2026-06-01T00:00:00.000Z');
    rememberContact(CONFIRMED_PEER, '2026-06-01T00:00:00.000Z');

    const peers = buildInitDirectMessagePeerList(readStoredContacts(), OWN);

    expect(peers).not.toContain(OWN);
    expect(peers).toContain(CONFIRMED_PEER);
  });
});
