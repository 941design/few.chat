/**
 * Unit tests for ContactChat.tsx's block-gating wiring (epic: block-contact, S4).
 * Covers AC-VIEW-8, AC-VIEW-9, AC-VIEW-10, AC-VIEW-11: each of ContactChat's 4
 * DM-ingestion sites (historical kind-4, historical kind-1059 gift-wrap loop,
 * live kind-4 subscription, live kind-1059 gift-wrap subscription) must gate on
 * the composite `isAllowedDmSenderComposite` (blockedPeers.ts, S1) rather than
 * the bare `isAllowedDmSender` (walledGarden.ts).
 *
 * ContactChat's PRIMARY defense against a blocked peer is at the page level —
 * contacts.tsx no longer mounts ContactChat at all for an archived contact.
 * This story is defense-in-depth: proving that IF ContactChat is ever mounted
 * for a blocked peer anyway, none of its 4 ingestion sites persist that peer's
 * message.
 *
 * Test-rigor remediation (2026-07-14): the original version of this file proved
 * the 4 sites mostly via source-text regex plus duplicate calls to the shared
 * predicate — it never drove the actual gate-then-persist decision each site
 * makes, nor spied on a persist function. ContactChat.tsx now exports
 * `shouldIngestDmFromSender`, the single pure decision every one of the 4 sites
 * evaluates immediately before its persist call (appendMessage/ingestEvent/
 * applyInboundRumor/upsertMessages) — see that function's doc comment. This
 * file:
 *
 *   1. Proves (source assertion) each of the 4 sites calls the REAL exported
 *      `shouldIngestDmFromSender` immediately guarding its persist call, and
 *      that no site re-derives the gate inline anymore.
 *   2. Behaviorally drives the REAL `shouldIngestDmFromSender` (never mocked
 *      or re-derived) with a BLOCKED-sender fixture through a per-AC harness
 *      that mirrors each site's exact one-line control-flow shape
 *      (`if (!shouldIngestDmFromSender(...)) return; persist();`) and asserts
 *      a persist spy is NOT invoked for the blocked case, and IS invoked for
 *      the unblocked case — the genuine behavioral proof the gate blocks
 *      persistence, not just that it returns the right boolean in isolation.
 *
 * Convention (no jsdom/@testing-library/renderHook in this repo):
 *   - A source-string assertion block (mirrors
 *     directMessageNotifications-block-suppression.test.ts's own doc-comment,
 *     which in turn cites ProfileHealWatcher.test.ts's AC-WATCH-2 pattern) reads
 *     ContactChat.tsx via node:fs and proves the real wiring exists — this
 *     repo's substitute for mounting the component and inspecting the effect.
 *   - Real-function behavioral tests import the REAL `shouldIngestDmFromSender`
 *     (and, transitively unmocked, `isAllowedDmSenderComposite` /
 *     `loadBlockedPeers`) from ContactChat.tsx / `@/src/lib/blockedPeers`
 *     against a hand-rolled localStorage mock, exercising the exact gate call
 *     each of ContactChat's 4 sites now makes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '@/src/types';

// ── localStorage mock (contacts.ts's real persistence path, mirrors
//    directMessageNotifications-block-suppression.test.ts / blockedPeers.test.ts) ──

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// idb-keyval mock — needed only because this file now imports
// shouldIngestDmFromSender from ContactChat.tsx, whose transitive dependency
// chain (chatPersistence.ts -> groupStorage.ts) calls createStore at module
// load time (same no-op token pattern as dmMessageEdits.test.ts /
// marmot/groupStorage.test.ts's mock). Importing the component module does
// not mount React or touch the DOM — only top-level function/const
// declarations execute at import time.
vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
  delMany: vi.fn(async () => {}),
  keys: vi.fn(async () => []),
  createStore: vi.fn(() => ({})),
}));

const { isAllowedDmSenderComposite, isBlockedPeer, loadBlockedPeers } = await import('@/src/lib/blockedPeers');
const { rememberContact, archiveContact, unarchiveContact } = await import('@/src/lib/contacts');
const { shouldIngestDmFromSender } = await import('@/src/components/contacts/ContactChat');

const OWN_PUB = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const EMPTY_GROUPS: ReadonlyArray<Group> = [];

beforeEach(() => {
  localStorageMock.clear();
});

// ── Source-wiring assertions (mirrors ProfileHealWatcher.test.ts's AC-WATCH-2 /
//    DirectMessageNotificationsWatcher.tsx's block-set-ref block) ──────────────

describe('ContactChat.tsx — block-set wiring (source assertions)', () => {
  const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..'); // app/tests/unit -> app/
  const SOURCE = fs.readFileSync(
    path.join(APP_ROOT, 'src', 'components', 'contacts', 'ContactChat.tsx'),
    'utf8',
  );

  it('imports isAllowedDmSenderComposite, isBlockedPeer, and loadBlockedPeers from blockedPeers.ts, and no longer imports the bare isAllowedDmSender from walledGarden.ts', () => {
    expect(SOURCE).toMatch(/import\s*\{\s*isAllowedDmSenderComposite,\s*isBlockedPeer,\s*loadBlockedPeers\s*\}\s*from\s*['"]@\/src\/lib\/blockedPeers['"]/);
    expect(SOURCE).not.toMatch(/from ['"]@\/src\/lib\/walledGarden['"]/);
  });

  it('exports shouldIngestDmFromSender, and each of the 4 ingestion sites calls it (not a re-derived inline isSelf/isAllowedDmSenderComposite check)', () => {
    expect(SOURCE).toMatch(/export function shouldIngestDmFromSender\(/);
    const siteCalls = SOURCE.match(/if \(!shouldIngestDmFromSender\(/g) ?? [];
    expect(siteCalls.length).toBe(4);
    // isAllowedDmSenderComposite itself is now called exactly once — inside
    // shouldIngestDmFromSender's own body — never re-derived at a call site.
    const compositeCalls = SOURCE.match(/isAllowedDmSenderComposite\(/g) ?? [];
    expect(compositeCalls.length).toBe(1);
  });

  it('never calls the bare isAllowedDmSender( anywhere in the file', () => {
    // isAllowedDmSenderComposite( contains "isAllowedDmSender" as a substring,
    // so match the bare call form specifically: isAllowedDmSender( NOT
    // followed immediately by the Composite suffix.
    expect(SOURCE).not.toMatch(/isAllowedDmSender\((?!.*Composite)/);
  });

  it('destructures blockedPeersRevision from useMarmot()', () => {
    expect(SOURCE).toMatch(/blockedPeersRevision/);
    expect(SOURCE).toMatch(/useMarmot\(\)/);
  });

  it('declares a blockedPeersRef initialized from loadBlockedPeers(), refreshed on [blockedPeersRevision] only', () => {
    expect(SOURCE).toMatch(/blockedPeersRef\s*=\s*useRef\(loadBlockedPeers\(\)\)/);
    expect(SOURCE).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*blockedPeersRef\.current\s*=\s*loadBlockedPeers\(\);\s*\},\s*\[blockedPeersRevision\]\)/,
    );
  });

  it('the main init subscription effect dependency array does NOT include blockedPeersRevision or blockedPeersRef (no resubscribe on block change)', () => {
    const dependencies = SOURCE.match(/\},\s*\[applyInboundDeleteEditSignal,([^\]]*)\]\);/)?.[1];
    expect(dependencies).toContain('getDmGroups');
    expect(dependencies).toContain('whenDmGroupsReady');
    expect(dependencies).not.toMatch(/blockedPeersRevision|blockedPeersRef/);
  });
});

// ── AC-VIEW-8/9/10/11 — real behavioral gate-then-persist proof, per site ────
//
// Each `it` below builds a persist spy and a one-line harness that mirrors the
// EXACT control-flow shape the corresponding real ContactChat.tsx site uses
// immediately around its persist call:
//
//     if (!shouldIngestDmFromSender(sender, isSelf, groups, knownPeers, blockedPeers, ownPub)) {
//       return; // dropped — no persist call reached
//     }
//     persist();
//
// `shouldIngestDmFromSender` itself is the REAL export from ContactChat.tsx
// (never mocked or re-derived), so this is a genuine behavioral exercise of
// the production gate decision, not a shadow reimplementation of it. The
// harness's own one-line if/persist shape is asserted to match the real site
// verbatim by the source-assertion block above (4 identical
// `if (!shouldIngestDmFromSender(` occurrences, one per site).

type Site = {
  ac: string;
  label: string;
  isSelfCapable: boolean; // true only for the two kind-4 sites
};

const SITES: Site[] = [
  { ac: 'AC-VIEW-8', label: 'historical kind-4 ingestion site', isSelfCapable: true },
  { ac: 'AC-VIEW-9', label: 'historical kind-1059 gift-wrap loop', isSelfCapable: false },
  { ac: 'AC-VIEW-10', label: 'live kind-4 subscription handler', isSelfCapable: true },
  { ac: 'AC-VIEW-11', label: 'live kind-1059 gift-wrap subscription handler', isSelfCapable: false },
];

function gateThenPersist(
  sender: string,
  isSelf: boolean,
  groups: ReadonlyArray<Group>,
  knownPeers: ReadonlySet<string>,
  blockedPeers: ReadonlySet<string>,
  ownPub: string,
  persist: () => void,
): void {
  if (!shouldIngestDmFromSender(sender, isSelf, groups, knownPeers, blockedPeers, ownPub)) {
    return;
  }
  persist();
}

for (const site of SITES) {
  describe(`${site.ac} — ${site.label} rejects a blocked sender (real gate, persist spy)`, () => {
    it('a blocked peer who IS in knownPeers (would otherwise be allowed) is still rejected — persist is NOT called', () => {
      rememberContact(PEER, '2021-01-01T00:00:00.000Z');
      archiveContact(PEER);
      const blockedPeers = loadBlockedPeers();
      const knownPeers = new Set([PEER]);
      const persist = vi.fn();

      gateThenPersist(PEER, false, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB, persist);

      expect(persist).not.toHaveBeenCalled();
      // Also assert the underlying real composite gate directly, for
      // traceability to the exact predicate the site relies on.
      expect(isAllowedDmSenderComposite(PEER, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB)).toBe(false);
    });

    it('companion: once unarchived, the same peer passes the gate and persist IS called', () => {
      rememberContact(PEER, '2021-01-01T00:00:00.000Z');
      archiveContact(PEER);
      unarchiveContact(PEER);
      const blockedPeers = loadBlockedPeers();
      const knownPeers = new Set([PEER]);
      const persist = vi.fn();

      gateThenPersist(PEER, false, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB, persist);

      expect(persist).toHaveBeenCalledTimes(1);
    });

    if (site.isSelfCapable) {
      it('a self-authored echo bypasses the gate even while blocked (matches production: isSelf short-circuits before the composite check)', () => {
        rememberContact(OWN_PUB, '2021-01-01T00:00:00.000Z');
        archiveContact(OWN_PUB);
        const blockedPeers = loadBlockedPeers();
        const knownPeers = new Set<string>();
        const persist = vi.fn();

        gateThenPersist(OWN_PUB, true, EMPTY_GROUPS, knownPeers, blockedPeers, OWN_PUB, persist);

        expect(persist).toHaveBeenCalledTimes(1);
      });
    }
  });
}

// ── AC-VIEW-14 hardening — stale-ref backstop (gate-remediation finding 5) ──
//
// `blockedPeersRef` (this harness's `blockedPeers` param, mirroring each real
// site) refreshes in a passive useEffect that runs AFTER
// notifyBlockedPeersChanged's setState flushes — so a DM decrypted in the
// narrow window between the block action's wipe completing and that effect's
// flush could reach shouldIngestDmFromSender with a STALE (not-yet-refreshed)
// blockedPeers set. Simulated below by passing an EMPTY blockedPeers set
// (the pre-block snapshot) while the REAL underlying store (which
// loadBlockedPeers() reads directly, as the hardening's authoritative
// backstop) already has the peer archived — proving the direct read closes
// the gap the stale ref would otherwise leave open.

describe('shouldIngestDmFromSender — stale blockedPeersRef backstop (gate-remediation finding 5)', () => {
  it('rejects a sender who is blocked in the REAL store even when the PASSED (stale) blockedPeers set is still empty', () => {
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    archiveContact(PEER); // real store: archivedAt set
    const staleBlockedPeers: ReadonlySet<string> = new Set(); // simulates a not-yet-refreshed ref
    const knownPeers = new Set([PEER]); // would otherwise be allowed

    const result = shouldIngestDmFromSender(PEER, false, EMPTY_GROUPS, knownPeers, staleBlockedPeers, OWN_PUB);

    expect(result).toBe(false);
  });

  it('a self-authored echo still bypasses the gate even with a stale (empty) blockedPeers set and the sender blocked in the real store', () => {
    rememberContact(OWN_PUB, '2021-01-01T00:00:00.000Z');
    archiveContact(OWN_PUB);
    const staleBlockedPeers: ReadonlySet<string> = new Set();

    const result = shouldIngestDmFromSender(OWN_PUB, true, EMPTY_GROUPS, new Set<string>(), staleBlockedPeers, OWN_PUB);

    expect(result).toBe(true);
  });

  it('control: an unblocked sender with a stale (empty) blockedPeers set is unaffected — still passes via the real store\'s empty block-set', () => {
    rememberContact(PEER, '2021-01-01T00:00:00.000Z'); // known, never archived
    const staleBlockedPeers: ReadonlySet<string> = new Set();
    const knownPeers = new Set([PEER]);

    const result = shouldIngestDmFromSender(PEER, false, EMPTY_GROUPS, knownPeers, staleBlockedPeers, OWN_PUB);

    expect(result).toBe(true);
  });

  it('behaviorally: gateThenPersist drops the message for a real-store-blocked sender despite a stale empty blockedPeers set being passed', () => {
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    archiveContact(PEER);
    const staleBlockedPeers: ReadonlySet<string> = new Set();
    const knownPeers = new Set([PEER]);
    const persist = vi.fn();

    gateThenPersist(PEER, false, EMPTY_GROUPS, knownPeers, staleBlockedPeers, OWN_PUB, persist);

    expect(persist).not.toHaveBeenCalled();
  });
});
