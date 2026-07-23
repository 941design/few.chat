/**
 * Unit tests for S2 (epic: group-invite-lifecycle) — the `invited` producer
 * (DD-8, AC-PROD-1, AC-PROD-2).
 *
 * Testing convention (this repo has no jsdom / @testing-library / renderHook
 * precedent — see exploration.json findings.testing): the producer decision
 * and payload construction are extracted as pure/async functions
 * (buildInvitedAnnouncementContent, submitInviteWithMarker's extended
 * sendAnnouncement param) and exercised directly, mirroring
 * app/tests/unit/cards/inviteByCard.test.ts's existing pattern for this same
 * file's submitInvite/submitInviteWithMarker exports. `.test.ts`, not
 * `.test.tsx` — no component render is needed or attempted (see result.json
 * for the documented deviation from the story's file-list name).
 *
 * Mocking: idb-keyval is Map-backed (not spied) and ndkClient is stubbed for
 * the same transitive-import reason as inviteByCard.test.ts —
 * InviteMemberModal.tsx imports useMarmot from MarmotContext, whose
 * transitive dependency groupStorage.ts calls idb-keyval's createStore() at
 * module load time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key) ?? undefined),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
  delMany: vi.fn(async (ks: string[]) => {
    ks.forEach((k) => idbStore.delete(k));
  }),
  keys: vi.fn(async () => [...idbStore.keys()]),
  createStore: vi.fn(() => ({})),
}));

vi.mock('@/src/lib/ndkClient', () => ({
  getNdk: vi.fn(),
  connectNdk: vi.fn(),
}));

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Module imports (after mocks are set up) ────────────────────────────────

const { submitInviteWithMarker, buildInvitedAnnouncementContent } = await import(
  '@/src/components/groups/InviteMemberModal'
);
const { approveJoinRequestImpl } = await import('@/src/context/MarmotContext');
import { parseStructured } from '@/src/lib/marmot/parseStructured';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

function makePubkeyHex(): string {
  const sk = generateSecretKey();
  return getPublicKey(sk);
}

beforeEach(() => {
  localStorageMock.clear();
  idbStore.clear();
});

const GROUP_ID = 'group-under-test';

function noopMarkerDeps() {
  return {
    markPendingDirectInvite: vi.fn(async () => {}),
    clearPendingDirectInvite: vi.fn(async () => {}),
  };
}

// ── buildInvitedAnnouncementContent — pure payload builder ─────────────────

describe('buildInvitedAnnouncementContent — pure invite_lifecycle payload builder', () => {
  it('returns exactly the three named fields (type, event, pubkey) — no extra properties', () => {
    const pubkeyHex = makePubkeyHex();
    const content = buildInvitedAnnouncementContent(pubkeyHex);
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ type: 'invite_lifecycle', event: 'invited', pubkey: pubkeyHex });
    expect(Object.keys(parsed).sort()).toEqual(['event', 'pubkey', 'type']);
  });

  it('canonicalizes an uppercase-hex pubkey to lowercase (AC-STRUCT-1 hex-guard contract)', () => {
    const pubkeyHex = makePubkeyHex();
    const content = buildInvitedAnnouncementContent(pubkeyHex.toUpperCase());
    expect(JSON.parse(content).pubkey).toBe(pubkeyHex.toLowerCase());
  });

  it('carries no nickname/avatar/profile metadata — privacy invariant (CLAUDE.md)', () => {
    const content = buildInvitedAnnouncementContent(makePubkeyHex());
    expect(content).not.toMatch(/nickname|avatar|name/i);
  });

  // Structural producer↔parser bind (epic reviewer finding, severity 5): the
  // two prior tests above only assert the builder's output against a JSON.parse
  // of itself, so a producer/parser drift (e.g. S1's parseStructured guard
  // tightening a field name or enum) would silently degrade this announcement
  // to raw-JSON plaintext with no failing test. Round-tripping through the
  // REAL parseStructured converts that convention into an enforced structure —
  // if S1's guard ever rejects this producer's shape, THIS test fails.
  it('round-trips through the real parseStructured — binds the producer to S1\'s parser structurally, not by convention', () => {
    const pubkeyHex = makePubkeyHex();

    expect(parseStructured(buildInvitedAnnouncementContent(pubkeyHex))).toEqual({
      type: 'invite_lifecycle',
      event: 'invited',
      pubkey: pubkeyHex.toLowerCase(),
    });

    // Uppercase input must still canonicalize to lowercase hex through the
    // full producer -> parser round trip.
    expect(parseStructured(buildInvitedAnnouncementContent(pubkeyHex.toUpperCase()))).toEqual({
      type: 'invite_lifecycle',
      event: 'invited',
      pubkey: pubkeyHex.toLowerCase(),
    });
  });
});

// ── submitInviteWithMarker + sendAnnouncement — AC-PROD-1 ──────────────────

describe('submitInviteWithMarker — invited producer fires only on a successful direct invite (AC-PROD-1, DD-8)', () => {
  it('posts the invited announcement with the exact payload AFTER inviteByNpub resolves {ok:true}', async () => {
    const pubkeyHex = makePubkeyHex();
    const callOrder: string[] = [];

    const inviteByNpub = vi.fn(async () => {
      callOrder.push('inviteByNpub');
      return { ok: true };
    });
    const sendAnnouncement = vi.fn(async (content: string) => {
      callOrder.push('sendAnnouncement');
      // Assert ordering INSIDE the spy so the assertion is tied to the real
      // call, not just checked afterwards.
      expect(callOrder).toEqual(['inviteByNpub', 'sendAnnouncement']);
      expect(JSON.parse(content)).toEqual({
        type: 'invite_lifecycle',
        event: 'invited',
        pubkey: pubkeyHex.toLowerCase(),
      });
    });

    const result = await submitInviteWithMarker(
      pubkeyHex,
      GROUP_ID,
      inviteByNpub,
      noopMarkerDeps(),
      sendAnnouncement,
    );

    expect(result).toEqual({ ok: true });
    expect(sendAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes the pubkey to lowercase in the fired payload even when the selected contact pubkeyHex is uppercase', async () => {
    const pubkeyHex = makePubkeyHex();
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    const sendAnnouncement = vi.fn(async () => {});

    await submitInviteWithMarker(
      pubkeyHex.toUpperCase(),
      GROUP_ID,
      inviteByNpub,
      noopMarkerDeps(),
      sendAnnouncement,
    );

    expect(JSON.parse(sendAnnouncement.mock.calls[0][0]).pubkey).toBe(pubkeyHex.toLowerCase());
  });

  it('does NOT fire the invited announcement when inviteByNpub resolves {ok:false} (partial-failure safety)', async () => {
    const pubkeyHex = makePubkeyHex();
    const inviteByNpub = vi.fn(async () => ({ ok: false, error: 'no_key_package' }));
    const sendAnnouncement = vi.fn(async () => {});

    const result = await submitInviteWithMarker(
      pubkeyHex,
      GROUP_ID,
      inviteByNpub,
      noopMarkerDeps(),
      sendAnnouncement,
    );

    expect(result).toEqual({ ok: false, error: 'no_key_package' });
    expect(sendAnnouncement).not.toHaveBeenCalled();
  });

  it('does NOT fire the invited announcement when the pubkeyHex is invalid (resolveInviteTarget rejects before inviteByNpub ever runs)', async () => {
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    const sendAnnouncement = vi.fn(async () => {});

    const result = await submitInviteWithMarker(
      'not-a-pubkey',
      GROUP_ID,
      inviteByNpub,
      noopMarkerDeps(),
      sendAnnouncement,
    );

    expect(result).toEqual({ ok: false, error: 'invalid_npub' });
    expect(inviteByNpub).not.toHaveBeenCalled();
    expect(sendAnnouncement).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: a rejecting sendAnnouncement does not reject submitInviteWithMarker or flip a successful result to failure', async () => {
    const pubkeyHex = makePubkeyHex();
    const inviteByNpub = vi.fn(async () => ({ ok: true }));
    const sendAnnouncement = vi.fn(async () => {
      throw new Error('relay publish failed');
    });

    const result = await submitInviteWithMarker(
      pubkeyHex,
      GROUP_ID,
      inviteByNpub,
      noopMarkerDeps(),
      sendAnnouncement,
    );

    expect(result).toEqual({ ok: true });
    expect(sendAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('omitting sendAnnouncement entirely preserves prior behavior (backward compatible — no announcement, no throw)', async () => {
    const pubkeyHex = makePubkeyHex();
    const inviteByNpub = vi.fn(async () => ({ ok: true }));

    const result = await submitInviteWithMarker(pubkeyHex, GROUP_ID, inviteByNpub, noopMarkerDeps());

    expect(result).toEqual({ ok: true });
  });
});

// ── AC-PROD-2 — join-request/invite-link approval never emits invite_lifecycle ─
//
// approveJoinRequestImpl (MarmotContext.tsx) reuses inviteByNpub directly —
// it never calls submitInvite/submitInviteWithMarker, which is where this
// story's producer lives. This is exercised two ways: (a) behaviorally,
// confirming the REAL approveJoinRequestImpl's deps/outputs carry no
// invite_lifecycle content, and (b) via a source-scan regression guard
// (mirrors app/tests/unit/components/noGreyedOutPeople.test.ts's established
// precedent for asserting an architectural absence that render/hook tests
// cannot reach in this repo) proving neither inviteByNpub's nor
// approveJoinRequestImpl's function body was modified to add the producer —
// this is the check that would fail had the producer mistakenly been wired
// inside the shared inviteByNpub instead of the direct-invite call site.

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // tests/unit/groups -> app/

function extractFunctionBody(source: string, startMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`extractFunctionBody: marker not found: ${startMarker}`);
  }
  const braceStart = source.indexOf('{', startIdx);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`extractFunctionBody: unbalanced braces from marker: ${startMarker}`);
  }
  return source.slice(startIdx, i + 1);
}

function makeRequest(overrides: Partial<PendingJoinRequest> = {}): PendingJoinRequest {
  return {
    pubkeyHex: 'requester-pk',
    nonce: 'link-nonce',
    groupId: 'group-1',
    receivedAt: 1000,
    nickname: 'Alice',
    eventId: 'evt-1',
    ...overrides,
  };
}

describe('AC-PROD-2: approving a join-request (approveJoinRequestImpl / inviteByNpub) never emits invite_lifecycle', () => {
  it('behavioral: approveJoinRequestImpl completes successfully with no invite_lifecycle content anywhere in its dependency calls', async () => {
    const inviteByNpub = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string });
    const deps = {
      inviteByNpub,
      pubkeyToNpub: vi.fn((pubkeyHex: string) => `npub-${pubkeyHex}`),
      deletePendingJoinRequest: vi.fn(async () => {}),
      incrementInviteLinkUsage: vi.fn(async () => {}),
      decrementJoinRequest: vi.fn(),
      filterPendingRequest: vi.fn(),
      mergeMemberProfile: vi.fn(async () => true),
      bumpProfileVersion: vi.fn(),
    };
    const request = makeRequest();

    const result = await approveJoinRequestImpl(deps, request);

    expect(result).toEqual({ ok: true });
    // inviteByNpub — the only network-facing call in this flow — receives
    // exactly (groupId, npub); there is no side channel through which an
    // invite_lifecycle payload could ride along.
    expect(inviteByNpub).toHaveBeenCalledTimes(1);
    expect(inviteByNpub).toHaveBeenCalledWith(request.groupId, `npub-${request.pubkeyHex}`);
    for (const call of inviteByNpub.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toMatch(/invite_lifecycle/);
      }
    }
  });

  it('source-scan: inviteByNpub (MarmotContext.tsx, shared with the direct-invite flow) never constructs an invite_lifecycle payload (DD-8)', () => {
    const source = fs.readFileSync(path.join(APP_ROOT, 'src', 'context', 'MarmotContext.tsx'), 'utf8');
    const body = extractFunctionBody(source, 'const inviteByNpub = useCallback(');
    expect(body).not.toMatch(/invite_lifecycle/);
  });

  it('source-scan: approveJoinRequestImpl never constructs an invite_lifecycle payload (DD-8) — only the pre-existing member_admitted announcement, fired by its caller, survives for this flow', () => {
    const source = fs.readFileSync(path.join(APP_ROOT, 'src', 'context', 'MarmotContext.tsx'), 'utf8');
    const body = extractFunctionBody(source, 'export async function approveJoinRequestImpl(');
    expect(body).not.toMatch(/invite_lifecycle/);
  });

  it("source-scan: pages/groups.tsx's handleApproveRequest still fires member_admitted on success, and does not also fire invite_lifecycle", () => {
    const source = fs.readFileSync(path.join(APP_ROOT, 'pages', 'groups.tsx'), 'utf8');
    const body = extractFunctionBody(source, 'const handleApproveRequest = useCallback(');
    expect(body).toMatch(/member_admitted/);
    expect(body).not.toMatch(/invite_lifecycle/);
  });

  it('sanity (non-vacuous guard): InviteMemberModal.tsx DOES reference invite_lifecycle somewhere — proves the absence assertions above are meaningful, not true merely because the feature does not exist', () => {
    const source = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'components', 'groups', 'InviteMemberModal.tsx'),
      'utf8',
    );
    expect(source).toMatch(/invite_lifecycle/);
  });
});
