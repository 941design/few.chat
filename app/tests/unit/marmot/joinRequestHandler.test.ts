import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import type { PendingJoinRequest } from '@/src/lib/marmot/joinRequestStorage';

// In-memory stores for mocking
const inviteLinkStore = new Map<string, InviteLink>();
const joinRequestStore = new Map<string, PendingJoinRequest>();

const { createJoinRequestInboxHandler, parseJoinRequestContent, JOIN_REQUEST_KIND } = await import(
  '@/src/lib/marmot/joinRequestHandler'
);

const requester = 'a1'.repeat(32);

async function deliverJoinRequest(
  rumor: { pubkey: string; content: string },
  eventId: string,
  memberPubkeys: (groupId: string) => string[],
): Promise<PendingJoinRequest | null> {
  let accepted: PendingJoinRequest | null = null;
  const receive = createJoinRequestInboxHandler({
    denyLayer: { isBlocked: () => false },
    inviteLinks: { get: async (nonce) => inviteLinkStore.get(nonce) },
    memberPubkeys,
    requests: {
      loadAll: async () => [...joinRequestStore.values()],
      save: async (request) => { joinRequestStore.set(request.eventId, request); },
      remove: async (id) => { joinRequestStore.delete(id); },
    },
    seen: { has: async () => false, add: async () => {} },
    now: Date.now,
    onReceived: (request) => { accepted = request; },
  });
  await receive({ ...rumor, id: eventId, kind: JOIN_REQUEST_KIND, created_at: 0, tags: [] }, {} as never);
  return accepted;
}

// `expiresAt` defaults to one day past whatever `now` is active at call time
// (real wall-clock for every pre-existing, non-expiry-focused test in this
// file; the fake-timer `NOW` for the "expiry enforcement" tests below, which
// always override createdAt/expiresAt explicitly anyway) — so every test
// that doesn't care about expiry keeps exercising a non-expired link exactly
// as before, regardless of which clock is active.
function makeInviteLink(overrides: Partial<InviteLink> = {}): InviteLink {
  return {
    nonce: 'valid-nonce',
    groupId: 'group-1',
    createdAt: 1000,
    expiresAt: Date.now() + 86_400_000,
    usageCount: 0,
    expiryNotified: false,
    expiryAcknowledged: false,
    label: undefined,
    muted: false,
    ...overrides,
  };
}

function makeRumor(overrides: Partial<{ pubkey: string; content: string }> = {}) {
  return {
    pubkey: requester,
    content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group' }),
    ...overrides,
  };
}

describe('joinRequestHandler', () => {
  beforeEach(() => {
    inviteLinkStore.clear();
    joinRequestStore.clear();
  });

  describe('parseJoinRequestContent', () => {
    it('parses valid join request content', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A' })
      );
      expect(result).toEqual({ type: 'join_request', nonce: 'n1', name: 'Group A' });
    });

    it('returns null for invalid JSON', () => {
      expect(parseJoinRequestContent('not-json')).toBeNull();
    });

    it('returns null for missing type field', () => {
      expect(parseJoinRequestContent(JSON.stringify({ nonce: 'n', name: 'G' }))).toBeNull();
    });

    it('returns null for wrong type value', () => {
      expect(parseJoinRequestContent(JSON.stringify({ type: 'other', nonce: 'n', name: 'G' }))).toBeNull();
    });

    it('returns null for missing nonce', () => {
      expect(parseJoinRequestContent(JSON.stringify({ type: 'join_request', name: 'G' }))).toBeNull();
    });

    it('returns null for missing name', () => {
      expect(parseJoinRequestContent(JSON.stringify({ type: 'join_request', nonce: 'n' }))).toBeNull();
    });

    // ── S2: tolerant requesterName parsing (AC-NAME-2) ─────────────────────

    it('parses a present, non-empty requesterName', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: 'Alice' })
      );
      expect(result?.requesterName).toBe('Alice');
    });

    it('treats an absent requesterName as undefined without rejecting the rumor (older client)', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A' })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('treats an empty-string requesterName as undefined without rejecting the rumor', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: '' })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('treats a non-string requesterName (number) as undefined without rejecting the rumor', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: 42 })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('treats a non-string requesterName (object) as undefined without rejecting the rumor', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: { evil: true } })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('treats a null requesterName as undefined without rejecting the rumor', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: null })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('treats a whitespace-only requesterName as undefined without rejecting the rumor', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: '   ' })
      );
      expect(result).not.toBeNull();
      expect(result?.requesterName).toBeUndefined();
    });

    it('trims a requesterName with surrounding whitespace and stores the trimmed value', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({ type: 'join_request', nonce: 'n1', name: 'Group A', requesterName: '  Alice  ' })
      );
      expect(result?.requesterName).toBe('Alice');
    });

    it('drops unexpected extra keys from the decoded JSON, returning only the declared payload fields', () => {
      const result = parseJoinRequestContent(
        JSON.stringify({
          type: 'join_request',
          nonce: 'n1',
          name: 'Group A',
          requesterName: 'Alice',
          __proto__: { polluted: true },
          maliciousExtra: 'attacker-controlled',
          adminOverride: true,
        })
      );
      expect(result).not.toBeNull();
      expect(Object.keys(result!).sort()).toEqual(['name', 'nonce', 'requesterName', 'type']);
      expect(result).toEqual({
        type: 'join_request',
        nonce: 'n1',
        name: 'Group A',
        requesterName: 'Alice',
      });
    });
  });

  describe('deliverJoinRequest', () => {
    const noMembers = () => [] as string[];

    it('persists a valid join request and returns it', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());

      const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);

      expect(result).not.toBeNull();
      expect(result!.pubkeyHex).toBe(requester);
      expect(result!.groupId).toBe('group-1');
      expect(result!.nonce).toBe('valid-nonce');
      expect(result!.eventId).toBe('evt-1');
      expect(joinRequestStore.has('evt-1')).toBe(true);
    });

    it('discards when content is not a valid join request', async () => {
      const result = await deliverJoinRequest(
        { pubkey: requester, content: 'not-json' },
        'evt-1',
        noMembers,
      );
      expect(result).toBeNull();
    });

    it('discards when nonce is not found in invite link storage', async () => {
      // Do not add nonce to store
      const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);
      expect(result).toBeNull();
    });

    it('discards when invite link is muted', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink({ muted: true }));

      const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);
      expect(result).toBeNull();
    });

    // ── S2: expiry enforcement at the gate (AC-ENFORCE-1, AC-ENFORCE-2) ─────
    // Fake timers control Date.now() (the handler's gate calls
    // isExpired(inviteLink, Date.now()) directly, per spec.md's Technical
    // Approach — Date.now() is not an injectable parameter of
    // deliverJoinRequest itself), keeping these tests wall-clock-independent
    // per architecture.md's "unit-testable without wall-clock" constraint.

    describe('expiry enforcement', () => {
      const NOW = 10_000_000; // arbitrary fixed instant

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('AC-ENFORCE-1: discards when the invite link is expired (isExpired true), even though muted is explicitly false', async () => {
        inviteLinkStore.set(
          'valid-nonce',
          makeInviteLink({ muted: false, createdAt: NOW - 86_400_000 - 1, expiresAt: NOW - 1 }),
        );

        const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);

        expect(result).toBeNull();
        expect(joinRequestStore.has('evt-1')).toBe(false);
      });

      it('AC-ENFORCE-2: persists when the invite link is NOT expired (isExpired false) and NOT muted, same fixture shape as the AC-ENFORCE-1 case with `now` moved to the other side of the boundary', async () => {
        inviteLinkStore.set(
          'valid-nonce',
          makeInviteLink({ muted: false, createdAt: NOW - 1000, expiresAt: NOW + 1 }),
        );

        const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);

        expect(result).not.toBeNull();
        expect(joinRequestStore.has('evt-1')).toBe(true);
      });

      it('AC-ENFORCE-1: discards a legacy link with no expiresAt whose createdAt + DAY_MS fallback has already passed', async () => {
        // Legacy record: expiresAt omitted entirely, exercising isExpired's
        // `expiresAt ?? createdAt + DAY_MS` fallback (Design Decision 2) —
        // proves the gate's retroactive-expiry behavior, not just the
        // explicit-expiresAt case above.
        const legacyLink = makeInviteLink({ muted: false, createdAt: NOW - 86_400_000 - 1 });
        delete (legacyLink as { expiresAt?: number }).expiresAt;
        inviteLinkStore.set('valid-nonce', legacyLink);

        const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);

        expect(result).toBeNull();
      });

      it('exactly at the expiry boundary (now === expiresAt) is treated as expired and discarded (isExpired is >=, not >)', async () => {
        inviteLinkStore.set(
          'valid-nonce',
          makeInviteLink({ muted: false, createdAt: NOW - 1000, expiresAt: NOW }),
        );

        const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);

        expect(result).toBeNull();
      });
    });

    it('discards when requester is already a group member', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const memberCheck = (groupId: string) =>
        groupId === 'group-1' ? [requester, 'other-pk'] : [];

      const result = await deliverJoinRequest(makeRumor(), 'evt-1', memberCheck);
      expect(result).toBeNull();
    });

    it('discards duplicate request (same pubkey + groupId already pending)', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());

      // First request succeeds
      const first = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);
      expect(first).not.toBeNull();

      // Second request from same pubkey for same group is discarded
      const second = await deliverJoinRequest(makeRumor(), 'evt-2', noMembers);
      expect(second).toBeNull();
    });

    it('allows same pubkey for different groups', async () => {
      inviteLinkStore.set('nonce-g1', makeInviteLink({ nonce: 'nonce-g1', groupId: 'group-1' }));
      inviteLinkStore.set('nonce-g2', makeInviteLink({ nonce: 'nonce-g2', groupId: 'group-2' }));

      const rumor1 = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'nonce-g1', name: 'G1' }),
      });
      const rumor2 = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'nonce-g2', name: 'G2' }),
      });

      const first = await deliverJoinRequest(rumor1, 'evt-1', noMembers);
      const second = await deliverJoinRequest(rumor2, 'evt-2', noMembers);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
    });

    it('resolves groupId from the invite link record, not from the rumor', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink({ groupId: 'actual-group-id' }));

      const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);
      expect(result!.groupId).toBe('actual-group-id');
    });

    // ── S2: nickname population (AC-NAME-3) ─────────────────────────────────

    it('populates PendingJoinRequest.nickname from a valid requesterName (replacing the former hardcoded undefined)', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: 'Alice' }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      expect(result!.nickname).toBe('Alice');
    });

    it('leaves PendingJoinRequest.nickname undefined when requesterName is absent (older client)', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());

      const result = await deliverJoinRequest(makeRumor(), 'evt-1', noMembers);
      expect(result!.nickname).toBeUndefined();
    });

    it('leaves PendingJoinRequest.nickname undefined when requesterName is whitespace-only', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: '   ' }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      expect(result!.nickname).toBeUndefined();
    });

    // ── S2/SEC: receive-side 32-UTF-8-byte cap (AC-SEC-1, AC-NAME-3) ────────
    // The cap must be enforced by deliverJoinRequest itself, independent of any
    // send-side cap — these fixtures simulate a hostile sender that bypassed
    // saveProfile's cap entirely by hand-crafting oversized rumor content.

    it('truncates an over-long hostile ASCII nickname to exactly 32 UTF-8 bytes on receive', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const hostileName = 'A'.repeat(50); // no send-side cap applied
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: hostileName }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      expect(result!.nickname).toBe('A'.repeat(32));
      expect(new TextEncoder().encode(result!.nickname!).length).toBe(32);
    });

    it('truncates a multi-byte-heavy (emoji) nickname on a codepoint boundary, not a UTF-16 code-unit boundary', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const emojiName = '\u{1F600}'.repeat(10); // 10 * 4 bytes = 40 bytes, uncapped
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: emojiName }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      // 32 bytes / 4 bytes-per-emoji = exactly 8 whole emoji, never a split surrogate pair.
      expect(result!.nickname).toBe('\u{1F600}'.repeat(8));
      expect(new TextEncoder().encode(result!.nickname!).length).toBe(32);
    });

    it('leaves a nickname within the 32-byte cap untouched', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: 'Bob' }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      expect(result!.nickname).toBe('Bob');
    });

    // ── SEC: nickname stored as literal text, never markup (AC-SEC-2) ───────
    // No jsdom/render capability in this repo (see exploration.json); the
    // guarantee this test can prove is that deliverJoinRequest stores the
    // string verbatim (no sanitization/stripping), which combined with the
    // member list's inline join-request rows (MemberList.tsx) never using
    // dangerouslySetInnerHTML (verified by source inspection, not rewritten) is
    // what makes React's default JSX escaping the actual XSS control at render time.

    it('stores an HTML/script nickname literally, unmodified aside from the byte cap', async () => {
      inviteLinkStore.set('valid-nonce', makeInviteLink());
      const hostileMarkup = '<script>alert(1)</script>';
      const rumor = makeRumor({
        content: JSON.stringify({ type: 'join_request', nonce: 'valid-nonce', name: 'Test Group', requesterName: hostileMarkup }),
      });

      const result = await deliverJoinRequest(rumor, 'evt-1', noMembers);
      expect(result!.nickname).toBe(hostileMarkup);
    });

    // ── Round-trip: sender's rumor content -> handler's PendingJoinRequest ──

    it('round-trips a nickname from buildJoinRequestRumor through parseJoinRequestContent/deliverJoinRequest', async () => {
      const { createJoinRequestSender } = await import('@/src/lib/marmot/joinRequestSender');
      inviteLinkStore.set('rt-nonce', makeInviteLink({ nonce: 'rt-nonce', groupId: 'rt-group' }));

      const params = {
        requesterPubkeyHex: 'a1'.repeat(32),
        adminPubkeyHex: 'b2'.repeat(32),
        nonce: 'rt-nonce',
        groupName: 'Test Group',
        requesterName: 'Carol',
      };
      const inbox = vi.fn(async (_input: { rumor: { content: string; pubkey: string } }) => ({ status: 'delivered' as const }));
      await createJoinRequestSender({
        inbox: { sendInboxRumor: inbox }, ownPubkey: params.requesterPubkeyHex,
        now: Date.now, saveOutbound: async () => {},
      }).send(params);
      const rumor = inbox.mock.calls[0][0].rumor;

      const result = await deliverJoinRequest(
        { pubkey: rumor.pubkey, content: rumor.content },
        'evt-rt',
        noMembers,
      );
      expect(result!.nickname).toBe('Carol');
    });

    it('round-trips a request with no requesterName (older client) to an undefined nickname, never rejecting the rumor', async () => {
      const { createJoinRequestSender } = await import('@/src/lib/marmot/joinRequestSender');
      inviteLinkStore.set('rt-nonce-2', makeInviteLink({ nonce: 'rt-nonce-2', groupId: 'rt-group-2' }));

      const params = {
        requesterPubkeyHex: 'a1'.repeat(32),
        adminPubkeyHex: 'b2'.repeat(32),
        nonce: 'rt-nonce-2',
        groupName: 'Test Group',
      };
      const inbox = vi.fn(async (_input: { rumor: { content: string; pubkey: string } }) => ({ status: 'delivered' as const }));
      await createJoinRequestSender({
        inbox: { sendInboxRumor: inbox }, ownPubkey: params.requesterPubkeyHex,
        now: Date.now, saveOutbound: async () => {},
      }).send(params);
      const rumor = inbox.mock.calls[0][0].rumor;

      const result = await deliverJoinRequest(
        { pubkey: rumor.pubkey, content: rumor.content },
        'evt-rt-2',
        noMembers,
      );
      expect(result).not.toBeNull();
      expect(result!.nickname).toBeUndefined();
    });
  });

  // ── AC-NAME-5 / AC-SEC-4: no kind-0 lookup anywhere in this module ────────

  describe('no kind-0 fallback (AC-NAME-5, AC-SEC-4)', () => {
    it('the handler module source contains no kind-0 fetch/lookup for the nickname', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const testFileDir = path.dirname(fileURLToPath(import.meta.url));
      const appRoot = path.resolve(testFileDir, '..', '..', '..'); // app/tests/unit/marmot -> app/
      const source = fs.readFileSync(
        path.join(appRoot, 'src', 'lib', 'marmot', 'joinRequestHandler.ts'),
        'utf8',
      );
      expect(source).not.toMatch(/kind0|fetchProfile|kind:\s*0\b/i);
    });
  });

  describe('JOIN_REQUEST_KIND constant', () => {
    it('is 21059', () => {
      expect(JOIN_REQUEST_KIND).toBe(21059);
    });
  });
});
